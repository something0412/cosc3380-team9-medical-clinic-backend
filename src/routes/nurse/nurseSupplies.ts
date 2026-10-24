import { Router } from "express";
import type { Request } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CLINIC_TODAY } from "../../lib/clinicTime.js";
import { pool } from "../../lib/db.js";
import { withTransaction } from "../../lib/transaction.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { lockActiveEmployee } from "../../services/clinical.js";

export const nurseSuppliesRouter = Router();

const idParam = (label: string) => z.coerce.number(`Choose ${label}`).int(`Choose ${label}`).positive(`Choose ${label}`);
// quantities are integer columns, so they have to be whole numbers that fit
const quantity = z.coerce
  .number("Quantity must be a whole number more than 0")
  .int("Quantity must be a whole number more than 0")
  .positive("Quantity must be a whole number more than 0")
  .max(2147483647, "Quantity is too large");

// the nurse and office come from the database on every request, never from the client
function me(req: Request) {
  if (!req.user || req.user.role === "patient") throw new HttpError(401, "Login required");
  return { nurseId: req.user.employeeId, officeId: req.user.officeId };
}

const STOCK_COLUMNS = `
  os.office_supply_id AS "officeSupplyId",
  os.supply_id AS "supplyId",
  s.name,
  st.type_name AS "supplyType",
  os.office_id AS "officeId",
  os.quantity_on_hand AS "quantityOnHand",
  os.reorder_threshold AS "reorderThreshold",
  to_char(os.expiration_date, 'YYYY-MM-DD') AS "expirationDate",
  os.quantity_on_hand <= os.reorder_threshold AS "lowStock",
  COALESCE(os.expiration_date <= ${CLINIC_TODAY} + 30, false) AS "expiringSoon",
  (SELECT COALESCE(sum(so.quantity_ordered), 0)::int FROM supply_order so
   WHERE so.supply_id = os.supply_id AND so.office_id = os.office_id AND so.status IN ('Pending', 'Ordered')) AS "onOrder"
`;

const STOCK_JOINS = `
  JOIN supply s ON s.supply_id = os.supply_id
  JOIN supply_type st ON st.supply_type_id = s.supply_type_id
`;

const ORDER_COLUMNS = `
  so.supply_order_id AS "supplyOrderId",
  so.supply_id AS "supplyId",
  s.name AS "supplyName",
  so.office_id AS "officeId",
  so.quantity_ordered AS "quantityOrdered",
  to_char(so.order_date, 'YYYY-MM-DD') AS "orderDate",
  so.status,
  so.employee_id AS "orderedById",
  e.first_name || ' ' || e.last_name AS "orderedBy"
`;

const ORDER_JOINS = `
  JOIN supply s ON s.supply_id = so.supply_id
  JOIN employee e ON e.employee_id = so.employee_id
`;

const getStock = async (db: Pool | PoolClient, officeSupplyId: number) =>
  (await db.query(`SELECT ${STOCK_COLUMNS} FROM office_supply os ${STOCK_JOINS} WHERE os.office_supply_id = $1`, [officeSupplyId])).rows[0];

const getOrder = async (db: Pool | PoolClient, supplyOrderId: number) =>
  (await db.query(`SELECT ${ORDER_COLUMNS} FROM supply_order so ${ORDER_JOINS} WHERE so.supply_order_id = $1`, [supplyOrderId])).rows[0];

// says why an open order didn't match, from the order as it is now
async function refuseOrder(client: PoolClient, supplyOrderId: number, officeId: number, action: string): Promise<never> {
  const current = await client.query(`SELECT office_id AS "officeId", status FROM supply_order WHERE supply_order_id = $1`, [supplyOrderId]);
  const row = current.rows[0];
  if (!row || row.officeId !== officeId) throw new HttpError(404, "Supply order not found at your office");
  throw new HttpError(409, `Only open orders for your office can be ${action}. This one is ${row.status}.`);
}

// get my office's stock with low and expiring warnings
nurseSuppliesRouter.get("/api/nurse/supplies", async (req, res) => {
  const { officeId } = me(req);

  // get my office's active supplies with type, low stock, expiring in 30 days, and amount on order (low first)
  const result = await pool.query(
    `
    SELECT ${STOCK_COLUMNS}
    FROM office_supply os
    ${STOCK_JOINS}
    WHERE os.office_id = $1 AND os.is_active AND s.is_active
    ORDER BY os.quantity_on_hand <= os.reorder_threshold DESC, s.name, os.office_supply_id
    `,
    [officeId]
  );

  res.json(result.rows);
});

// use supplies (take them out of stock)
nurseSuppliesRouter.patch("/api/nurse/supplies/:id/use", async (req, res) => {
  const { nurseId } = me(req);
  const officeSupplyId = idParam("a supply").parse(req.params.id);
  const amount = z.object({ quantity }).parse(req.body).quantity;

  const stock = await withTransaction(async (client) => {
    // locking my employee row waits for a deactivation or office move in progress, then uses my current office
    const officeId = await lockActiveEmployee(client, nurseId);
    // take the quantity out of my office's stock, only if there is enough
    // one conditional update, so two nurses using the last few at once can't both succeed
    const used = await client.query(
      `
      UPDATE office_supply SET quantity_on_hand = quantity_on_hand - $1
      WHERE office_supply_id = $2 AND office_id = $3 AND is_active AND quantity_on_hand >= $1
      `,
      [amount, officeSupplyId, officeId]
    );
    if (!used.rowCount) {
      const current = await client.query(`SELECT office_id AS "officeId", is_active AS "isActive", quantity_on_hand AS "quantityOnHand" FROM office_supply WHERE office_supply_id = $1`, [
        officeSupplyId,
      ]);
      const row = current.rows[0];
      if (!row || row.officeId !== officeId || !row.isActive) throw new HttpError(404, "Supply not found at your office");
      throw new HttpError(409, `Not enough in stock at your office. Only ${row.quantityOnHand} left.`);
    }
    return getStock(client, officeSupplyId);
  });

  res.json(stock);
});

// get supplies for the new order dropdown
nurseSuppliesRouter.get("/api/nurse/supply-list", async (_req, res) => {
  // get all active supplies with their type, sorted by name
  const result = await pool.query(`
    SELECT s.supply_id AS "supplyId", s.name, s.supply_type_id AS "supplyTypeId", st.type_name AS "supplyType"
    FROM supply s
    JOIN supply_type st ON st.supply_type_id = s.supply_type_id
    WHERE s.is_active
    ORDER BY s.name
  `);

  res.json(result.rows);
});

// get my office's supply orders
nurseSuppliesRouter.get("/api/nurse/supply-orders", async (req, res) => {
  const { officeId } = me(req);

  // get my office's supply orders with supply and who ordered, open ones first, then newest
  const result = await pool.query(
    `
    SELECT ${ORDER_COLUMNS}
    FROM supply_order so
    ${ORDER_JOINS}
    WHERE so.office_id = $1
    ORDER BY so.status IN ('Pending', 'Ordered') DESC, so.order_date DESC, so.supply_order_id DESC
    `,
    [officeId]
  );

  res.json(result.rows);
});

// order more of a supply
nurseSuppliesRouter.post("/api/nurse/supply-orders", async (req, res) => {
  const { nurseId } = me(req);
  const body = z.object({ supplyId: idParam("a supply"), quantity }).parse(req.body);

  const order = await withTransaction(async (client) => {
    const officeId = await lockActiveEmployee(client, nurseId);
    // save a pending order for my office, ordered by me, only if the supply is active
    const created = await client.query(
      `
      INSERT INTO supply_order (supply_id, office_id, employee_id, quantity_ordered, order_date, status)
      SELECT supply_id, $2, $3, $4, ${CLINIC_TODAY}, 'Pending' FROM supply WHERE supply_id = $1 AND is_active
      RETURNING supply_order_id
      `,
      [body.supplyId, officeId, nurseId, body.quantity]
    );
    if (!created.rowCount) throw new HttpError(400, "Choose an active supply");
    return getOrder(client, created.rows[0].supply_order_id);
  });

  res.status(201).json(order);
});

// receive an order and add it to stock
nurseSuppliesRouter.patch("/api/nurse/supply-orders/:id/receive", async (req, res) => {
  const { nurseId } = me(req);
  const supplyOrderId = idParam("a supply order").parse(req.params.id);

  const result = await withTransaction(async (client) => {
    const officeId = await lockActiveEmployee(client, nurseId);

    // mark my office's open order as received and get its supply, office and quantity
    // only an open order matches, so receiving it twice can't add the stock twice
    const order = await client.query(
      `
      UPDATE supply_order SET status = 'Received'
      WHERE supply_order_id = $1 AND office_id = $2 AND status IN ('Pending', 'Ordered')
      RETURNING supply_id, office_id, quantity_ordered
      `,
      [supplyOrderId, officeId]
    );
    if (!order.rowCount) await refuseOrder(client, supplyOrderId, officeId, "received");
    const { supply_id, office_id, quantity_ordered } = order.rows[0];

    // add the quantity to my office's stock of that supply (create the stock row if missing)
    // a stock row that was turned off is used again, since the office has the supply now
    const stock = await client.query(
      `
      INSERT INTO office_supply (supply_id, office_id, quantity_on_hand)
      VALUES ($1, $2, $3)
      ON CONFLICT (supply_id, office_id) DO UPDATE SET quantity_on_hand = office_supply.quantity_on_hand + EXCLUDED.quantity_on_hand, is_active = true
      RETURNING office_supply_id
      `,
      [supply_id, office_id, quantity_ordered]
    );

    return { ...(await getOrder(client, supplyOrderId)), stock: await getStock(client, stock.rows[0].office_supply_id) };
  });

  res.json(result);
});

// cancel an order that hasn't arrived
nurseSuppliesRouter.patch("/api/nurse/supply-orders/:id/cancel", async (req, res) => {
  const { nurseId } = me(req);
  const supplyOrderId = idParam("a supply order").parse(req.params.id);

  const order = await withTransaction(async (client) => {
    const officeId = await lockActiveEmployee(client, nurseId);
    // mark my office's open order as cancelled
    const cancelled = await client.query(`UPDATE supply_order SET status = 'Cancelled' WHERE supply_order_id = $1 AND office_id = $2 AND status IN ('Pending', 'Ordered')`, [
      supplyOrderId,
      officeId,
    ]);
    if (!cancelled.rowCount) await refuseOrder(client, supplyOrderId, officeId, "cancelled");
    return getOrder(client, supplyOrderId);
  });

  res.json(order);
});

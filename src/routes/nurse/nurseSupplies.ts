import { Router } from "express";
import { pool } from "../../lib/db.js";

export const nurseSuppliesRouter = Router();

// get my office's stock with low and expiring warnings
nurseSuppliesRouter.get("/api/nurse/supplies", async (req, res) => {
  const nurseId = req.session.employeeId;

  // get my office's active supplies with type, low stock, expiring in 30 days, and amount on order (low first)
  const result = await pool.query(
    ``,
    [nurseId]
  );

  res.json(result.rows);
});

// use supplies (take them out of stock)
nurseSuppliesRouter.patch("/api/nurse/supplies/:id/use", async (req, res) => {
  const nurseId = req.session.employeeId;
  const officeSupplyId = Number(req.params.id);
  const quantity = Number(req.body.quantity);

  if (!Number.isInteger(quantity) || quantity <= 0) {
    res.status(400).json({ error: "Quantity must be a whole number more than 0" });
    return;
  }

  // take the quantity out of my office's stock, only if there is enough
  const result = await pool.query(
    ``,
    [quantity, officeSupplyId, nurseId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Not enough in stock at your office" });
    return;
  }

  res.json(result.rows[0]);
});

// get supplies for the new order dropdown
nurseSuppliesRouter.get("/api/nurse/supply-list", async (_req, res) => {
  // get all active supplies with their type, sorted by name
  const result = await pool.query(``);

  res.json(result.rows);
});

// get my office's supply orders
nurseSuppliesRouter.get("/api/nurse/supply-orders", async (req, res) => {
  const nurseId = req.session.employeeId;

  // get my office's supply orders with supply and who ordered, open ones first, then newest
  const result = await pool.query(
    ``,
    [nurseId]
  );

  res.json(result.rows);
});

// order more of a supply
nurseSuppliesRouter.post("/api/nurse/supply-orders", async (req, res) => {
  const nurseId = req.session.employeeId;
  const supplyId = Number(req.body.supplyId);
  const quantity = Number(req.body.quantity);

  if (!supplyId || !Number.isInteger(quantity) || quantity <= 0) {
    res.status(400).json({ error: "Supply and a whole-number quantity are required" });
    return;
  }

  // save a pending order for my office, ordered by me, only if the supply is active
  const result = await pool.query(
    ``,
    [supplyId, nurseId, quantity]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Supply not found" });
    return;
  }

  res.status(201).json(result.rows[0]);
});

// receive an order and add it to stock
nurseSuppliesRouter.patch("/api/nurse/supply-orders/:id/receive", async (req, res) => {
  const nurseId = req.session.employeeId;
  const supplyOrderId = Number(req.params.id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // mark my office's open order as received and get its supply, office and quantity
    const order = await client.query(
      ``,
      [supplyOrderId, nurseId]
    );
    if (order.rowCount === 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Only open orders for your office can be received" });
      return;
    }

    // add the quantity to my office's stock of that supply (create the stock row if missing)
    await client.query(
      ``,
      [order.rows[0].supply_id, order.rows[0].office_id, order.rows[0].quantity_ordered]
    );

    await client.query("COMMIT");
    res.json({ supplyOrderId, status: "Received" });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// cancel an order that hasn't arrived
nurseSuppliesRouter.patch("/api/nurse/supply-orders/:id/cancel", async (req, res) => {
  const nurseId = req.session.employeeId;
  const supplyOrderId = Number(req.params.id);

  // mark my office's open order as cancelled
  const result = await pool.query(
    ``,
    [supplyOrderId, nurseId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Only open orders for your office can be cancelled" });
    return;
  }

  res.json(result.rows[0]);
});

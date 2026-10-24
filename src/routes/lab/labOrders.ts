import { Router } from "express";
import type { Request } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CLINIC_NOW } from "../../lib/clinicTime.js";
import { pool } from "../../lib/db.js";
import { withTransaction } from "../../lib/transaction.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { LAB_ORDER_COLUMNS, LAB_ORDER_JOINS, lockActiveEmployee } from "../../services/clinical.js";

export const labOrdersRouter = Router();

const id = z.coerce.number("Choose a lab order").int("Choose a lab order").positive("Choose a lab order");
const listQuery = z.object({
  status: z.enum(["all", "open", "Ordered", "InProgress", "Completed", "Cancelled"], "Status must be all, open, Ordered, InProgress, Completed or Cancelled").default("Ordered"),
  search: z.string().trim().max(100).default(""),
});
const resultBody = z.object({
  resultNotes: z.string("Enter the result").trim().min(1, "Enter the result").max(10000, "Keep the result under 10000 characters"),
});

// the lab technician is whoever is signed in, never an ID from the request
function me(req: Request) {
  if (req.user?.role !== "lab") throw new HttpError(401, "Login required");
  return req.user.employeeId;
}

// the lab sees the order and the patient's name and birth date to match the sample, not the chart
const LAB_COLUMNS = `${LAB_ORDER_COLUMNS}, to_char(p.dob, 'YYYY-MM-DD') AS dob`;

const getLabOrder = async (db: Pool | PoolClient, labOrderId: number) =>
  (await db.query(`SELECT ${LAB_COLUMNS} FROM lab_order l ${LAB_ORDER_JOINS} WHERE l.lab_order_id = $1`, [labOrderId])).rows[0] ?? null;

// says why a status change didn't match, from the order as it is now
async function refuse(db: PoolClient, labOrderId: number, rule: string): Promise<never> {
  const current = await db.query(`SELECT status FROM lab_order WHERE lab_order_id = $1`, [labOrderId]);
  if (!current.rowCount) throw new HttpError(404, "Lab order not found");
  throw new HttpError(409, `${rule} This one is ${current.rows[0].status}.`);
}

// get lab orders from every doctor (status tab and patient search)
// the clinic has one lab for every office, so orders aren't split by office
labOrdersRouter.get("/api/lab/orders", async (req, res) => {
  me(req);
  const { status, search } = listQuery.parse(req.query);

  // waiting ones oldest first, finished ones newest result first
  const result = await pool.query(
    `
    SELECT ${LAB_COLUMNS}
    FROM lab_order l
    ${LAB_ORDER_JOINS}
    WHERE ($1 = 'all' OR ($1 = 'open' AND l.status IN ('Ordered', 'InProgress')) OR l.status = $1)
      AND ($2 = '' OR p.first_name || ' ' || p.last_name ILIKE '%' || $2 || '%' ESCAPE '\\')
    ORDER BY
      CASE WHEN l.status IN ('Ordered', 'InProgress') THEN l.order_date END,
      l.result_date DESC NULLS LAST,
      l.lab_order_id DESC
    `,
    [status, search.replace(/[\\%_]/g, (character) => `\\${character}`)]
  );

  res.json(result.rows);
});

// get one lab order
labOrdersRouter.get("/api/lab/orders/:id", async (req, res) => {
  me(req);
  const order = await getLabOrder(pool, id.parse(req.params.id));
  if (!order) throw new HttpError(404, "Lab order not found");
  res.json(order);
});

// start an order (sample collected)
labOrdersRouter.patch("/api/lab/orders/:id/start", async (req, res) => {
  const labTechId = me(req);
  const labOrderId = id.parse(req.params.id);

  const order = await withTransaction(async (client) => {
    await lockActiveEmployee(client, labTechId);
    // one conditional update, so a doctor cancelling or another technician starting it can't both win
    const started = await client.query(`UPDATE lab_order SET status = 'InProgress' WHERE lab_order_id = $1 AND status = 'Ordered'`, [labOrderId]);
    if (!started.rowCount) await refuse(client, labOrderId, "Only waiting orders can be started.");
    return getLabOrder(client, labOrderId);
  });
  res.json(order);
});

// enter the result (the order is then completed and can't be changed)
labOrdersRouter.patch("/api/lab/orders/:id/result", async (req, res) => {
  const labTechId = me(req);
  const labOrderId = id.parse(req.params.id);
  const { resultNotes } = resultBody.parse(req.body);

  const order = await withTransaction(async (client) => {
    await lockActiveEmployee(client, labTechId);
    // only an order in progress matches, so a second result can't overwrite the first
    const completed = await client.query(
      `
      UPDATE lab_order
      SET status = 'Completed', result_notes = $2, performed_by_employee_id = $3, result_date = ${CLINIC_NOW}
      WHERE lab_order_id = $1 AND status = 'InProgress'
      `,
      [labOrderId, resultNotes, labTechId]
    );
    if (!completed.rowCount) await refuse(client, labOrderId, "Only started orders can get a result.");
    return getLabOrder(client, labOrderId);
  });
  res.json(order);
});

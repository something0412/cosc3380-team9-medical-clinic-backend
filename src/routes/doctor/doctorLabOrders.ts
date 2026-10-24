import { Router } from "express";
import type { Request } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CLINIC_TODAY } from "../../lib/clinicTime.js";
import { pool } from "../../lib/db.js";
import { withTransaction } from "../../lib/transaction.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { LAB_ORDER_COLUMNS, LAB_ORDER_JOINS, asClinician, doctorCaresFor, lockPatientInCare } from "../../services/clinical.js";

export const doctorLabOrdersRouter = Router();

const id = (label: string) => z.coerce.number(`Choose ${label}`).int(`Choose ${label}`).positive(`Choose ${label}`);
const listQuery = z.object({
  status: z.enum(["all", "open", "Ordered", "InProgress", "Completed", "Cancelled"], "Status must be all, open, Ordered, InProgress, Completed or Cancelled").default("all"),
  search: z.string().trim().max(100).default(""),
});
const orderBody = z.object({
  patientId: id("a patient"),
  labTestTypeId: id("a lab test"),
  appointmentId: id("an appointment").nullish(),
});

function me(req: Request) {
  if (req.user?.role !== "doctor") throw new HttpError(401, "Login required");
  return req.user.employeeId;
}

const getLabOrder = async (labOrderId: number, db: Pool | PoolClient = pool) =>
  (await db.query(`SELECT ${LAB_ORDER_COLUMNS} FROM lab_order l ${LAB_ORDER_JOINS} WHERE l.lab_order_id = $1`, [labOrderId])).rows[0] ?? null;

// get lab orders I made (open means still waiting for a result)
doctorLabOrdersRouter.get("/api/doctor/lab-orders", async (req, res) => {
  const { status, search } = listQuery.parse(req.query);
  const result = await pool.query(
    `
    SELECT ${LAB_ORDER_COLUMNS}
    FROM lab_order l
    ${LAB_ORDER_JOINS}
    WHERE l.ordered_by_employee_id = $1
      AND ($2 = 'all' OR ($2 = 'open' AND l.status IN ('Ordered', 'InProgress')) OR l.status = $2)
      AND ($3 = '' OR p.first_name || ' ' || p.last_name ILIKE '%' || $3 || '%' ESCAPE '\\')
    ORDER BY l.order_date DESC, l.lab_order_id DESC
    `,
    [me(req), status, search.replace(/[\\%_]/g, (character) => `\\${character}`)]
  );
  res.json(result.rows);
});

// get lab tests for the order form
doctorLabOrdersRouter.get("/api/doctor/lab-tests", async (_req, res) => {
  const result = await pool.query(`SELECT lab_test_type_id AS "labTestTypeId", name, cost FROM lab_test_type WHERE is_active ORDER BY name`);
  res.json(result.rows);
});

// get one lab order for a patient I care for
doctorLabOrdersRouter.get("/api/doctor/lab-orders/:id", async (req, res) => {
  const doctorId = me(req);
  const result = await pool.query(
    `SELECT ${LAB_ORDER_COLUMNS} FROM lab_order l ${LAB_ORDER_JOINS} WHERE l.lab_order_id = $2 AND (l.ordered_by_employee_id = $1 OR ${doctorCaresFor("$1", "l.patient_id")})`,
    [doctorId, id("a lab order").parse(req.params.id)]
  );
  if (!result.rowCount) throw new HttpError(404, "Lab order not found");
  res.json(result.rows[0]);
});

// create a lab order
doctorLabOrdersRouter.post("/api/doctor/lab-orders", async (req, res) => {
  const doctorId = me(req);
  const { patientId, labTestTypeId, appointmentId } = orderBody.parse(req.body);

  const order = await withTransaction(async (client) => {
    // orders for one patient go one at a time, so the same test can't be ordered twice by accident
    await lockPatientInCare(client, asClinician(req.user, "doctor"), patientId);

    if (appointmentId) {
      const visit = await client.query(`SELECT patient_id AS "patientId", doctor_id AS "doctorId", status FROM appointment WHERE appointment_id = $1 FOR SHARE`, [
        appointmentId,
      ]);
      const row = visit.rows[0];
      if (!row || row.doctorId !== doctorId || row.patientId !== patientId) throw new HttpError(404, "Appointment not found");
      if (row.status === "Cancelled" || row.status === "No Show") throw new HttpError(409, `Lab orders can't be added to a visit that is ${row.status}`);
    }

    const test = await client.query(`SELECT 1 FROM lab_test_type WHERE lab_test_type_id = $1 AND is_active`, [labTestTypeId]);
    if (!test.rowCount) throw new HttpError(400, "Choose an active lab test");

    const open = await client.query(
      `SELECT 1 FROM lab_order WHERE patient_id = $1 AND lab_test_type_id = $2 AND status IN ('Ordered', 'InProgress') AND appointment_id IS NOT DISTINCT FROM $3::int`,
      [patientId, labTestTypeId, appointmentId ?? null]
    );
    if (open.rowCount) throw new HttpError(409, "This test is already ordered for the patient and doesn't have a result yet");

    const created = await client.query(
      `
      INSERT INTO lab_order (patient_id, ordered_by_employee_id, lab_test_type_id, appointment_id, status, order_date)
      VALUES ($1, $2, $3, $4, 'Ordered', ${CLINIC_TODAY})
      RETURNING lab_order_id
      `,
      [patientId, doctorId, labTestTypeId, appointmentId ?? null]
    );
    return getLabOrder(created.rows[0].lab_order_id, client);
  });
  res.status(201).json(order);
});

// cancel a lab order that has no result yet
doctorLabOrdersRouter.patch("/api/doctor/lab-orders/:id/cancel", async (req, res) => {
  const doctorId = me(req);
  const labOrderId = id("a lab order").parse(req.params.id);

  // one conditional update, so it can't cancel an order the lab already started
  const result = await pool.query(`UPDATE lab_order SET status = 'Cancelled' WHERE lab_order_id = $1 AND ordered_by_employee_id = $2 AND status = 'Ordered'`, [
    labOrderId,
    doctorId,
  ]);
  if (!result.rowCount) {
    const current = await getLabOrder(labOrderId);
    if (!current || current.orderedById !== doctorId) throw new HttpError(404, "Lab order not found");
    throw new HttpError(409, `Only orders the lab hasn't started can be cancelled. This one is ${current.status}.`);
  }
  res.json(await getLabOrder(labOrderId));
});

import { Router } from "express";
import { z } from "zod";
import { pool, withTransaction } from "../lib/db.js";
import { requireStaffType } from "../lib/staff.js";
import { HttpError } from "../middleware/errorHandler.js";

// Nurse workflows: allergies, home medications, visit notes, lab orders
// and office supplies. Every write is nurses only. Nurses never write
// prescriptions (that's the doctors' prescription tables) — they only
// record what the patient already takes at home.
export const nursingRouter = Router();

const id = z.coerce.number().int().positive();
const employeeOnly = z.object({ employeeId: z.number().int().positive() });

// Empty optional text fields from the form arrive as "" — store them as NULL.
const optionalText = z
  .string()
  .trim()
  .transform((s) => s || null)
  .nullable()
  .default(null);

// Throws 400 unless the appointment exists, belongs to this patient and is
// at the nurse's office.
async function checkVisit(appointmentId: number, patientId: number, officeId: number) {
  const visit = await pool.query(`SELECT patient_id, office_id FROM appointment WHERE appointment_id = $1`, [
    appointmentId,
  ]);
  const row = visit.rows[0];
  if (!row || row.patient_id !== patientId) throw new HttpError(400, "That appointment isn't this patient's");
  if (row.office_id !== officeId) throw new HttpError(403, "That appointment is at another office");
}

// ---------------------------------------------------------------------------
// Allergies
// ---------------------------------------------------------------------------

nursingRouter.get("/api/allergy-types", async (_req, res) => {
  const result = await pool.query(`
    SELECT allergy_type_id AS "allergyTypeId", name, category
    FROM allergy_type
    WHERE is_active
    ORDER BY name
  `);
  res.json(result.rows);
});

const allergySchema = z.object({
  employeeId: z.number().int().positive(),
  reaction: optionalText,
  severity: z.enum(["Mild", "Moderate", "Severe"]),
});

// Add an allergy. A patient has at most one row per allergy type (the
// schema's UNIQUE (patient_id, allergy_type_id)), so if one exists — even
// a deactivated one — update and reactivate it instead of inserting.
nursingRouter.post("/api/patients/:patientId/allergies", async (req, res) => {
  const patientId = id.parse(req.params.patientId);
  const body = allergySchema.extend({ allergyTypeId: z.number().int().positive() }).parse(req.body);
  await requireStaffType(body.employeeId, "nurse", "record allergies");

  const allergyId = await withTransaction(async (client) => {
    const updated = await client.query(
      `
      UPDATE allergy SET reaction = $3, severity = $4, is_active = true
      WHERE patient_id = $1 AND allergy_type_id = $2
      RETURNING allergy_id
      `,
      [patientId, body.allergyTypeId, body.reaction, body.severity]
    );
    if (updated.rowCount) return updated.rows[0].allergy_id as number;

    const inserted = await client.query(
      `
      INSERT INTO allergy (patient_id, allergy_type_id, reaction, severity)
      VALUES ($1, $2, $3, $4)
      RETURNING allergy_id
      `,
      [patientId, body.allergyTypeId, body.reaction, body.severity]
    );
    return inserted.rows[0].allergy_id as number;
  });

  res.status(201).json({ allergyId });
});

// Change an allergy's reaction or severity.
nursingRouter.patch("/api/allergies/:allergyId", async (req, res) => {
  const allergyId = id.parse(req.params.allergyId);
  const body = allergySchema.parse(req.body);
  await requireStaffType(body.employeeId, "nurse", "update allergies");

  const result = await pool.query(
    `UPDATE allergy SET reaction = $2, severity = $3 WHERE allergy_id = $1 AND is_active`,
    [allergyId, body.reaction, body.severity]
  );
  if (!result.rowCount) throw new HttpError(404, "Allergy not found");
  res.json({ allergyId });
});

// Soft delete: the row stays, marked inactive.
nursingRouter.patch("/api/allergies/:allergyId/deactivate", async (req, res) => {
  const allergyId = id.parse(req.params.allergyId);
  const { employeeId } = employeeOnly.parse(req.body);
  await requireStaffType(employeeId, "nurse", "remove allergies");

  const result = await pool.query(`UPDATE allergy SET is_active = false WHERE allergy_id = $1 AND is_active`, [
    allergyId,
  ]);
  if (!result.rowCount) throw new HttpError(404, "Allergy not found");
  res.json({ allergyId });
});

// ---------------------------------------------------------------------------
// Home medications (what the patient already takes — not prescriptions)
// ---------------------------------------------------------------------------

// The medication list for the picker, optionally filtered by name.
nursingRouter.get("/api/medications", async (req, res) => {
  const search = z.string().trim().optional().parse(req.query.search);

  const result = await pool.query(
    `
    SELECT medication_id AS "medicationId", name
    FROM medication
    WHERE is_active AND ($1::text IS NULL OR name ILIKE '%' || $1 || '%')
    ORDER BY name
    `,
    [search || null]
  );
  res.json(result.rows);
});

const homeMedDetails = {
  category: z.enum(["Prescription", "OTC", "Supplement"]).nullable().default(null),
  dosage: optionalText,
  frequency: optionalText,
};

const addHomeMedSchema = z
  .object({
    employeeId: z.number().int().positive(),
    // Either pick from the medication list or type a name.
    medicationId: z.number().int().positive().nullable().default(null),
    medicationName: optionalText,
    startDate: z.iso.date().nullable().default(null),
    ...homeMedDetails,
  })
  .refine((m) => m.medicationId || m.medicationName, {
    message: "Pick a medication or type its name",
    path: ["medicationName"],
  });

// Record a home medication. When picked from the list, the name is copied
// from `medication` (home_medication.medication_name is required either
// way). COALESCE($6, CURRENT_DATE): no start date given -> today.
nursingRouter.post("/api/patients/:patientId/home-medications", async (req, res) => {
  const patientId = id.parse(req.params.patientId);
  const body = addHomeMedSchema.parse(req.body);
  await requireStaffType(body.employeeId, "nurse", "record home medications");

  let name = body.medicationName;
  if (body.medicationId) {
    const med = await pool.query(`SELECT name FROM medication WHERE medication_id = $1 AND is_active`, [
      body.medicationId,
    ]);
    if (!med.rowCount) throw new HttpError(400, "Medication not found");
    name = med.rows[0].name;
  }

  const result = await pool.query(
    `
    INSERT INTO home_medication (patient_id, medication_id, medication_name, category, dosage, frequency, start_date)
    VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, CURRENT_DATE))
    RETURNING home_medication_id AS "homeMedicationId"
    `,
    [patientId, body.medicationId, name, body.category, body.dosage, body.frequency, body.startDate]
  );
  res.status(201).json(result.rows[0]);
});

nursingRouter.patch("/api/home-medications/:homeMedicationId", async (req, res) => {
  const homeMedicationId = id.parse(req.params.homeMedicationId);
  const body = z.object({ employeeId: z.number().int().positive(), ...homeMedDetails }).parse(req.body);
  await requireStaffType(body.employeeId, "nurse", "update home medications");

  const result = await pool.query(
    `
    UPDATE home_medication SET category = $2, dosage = $3, frequency = $4
    WHERE home_medication_id = $1 AND is_active
    `,
    [homeMedicationId, body.category, body.dosage, body.frequency]
  );
  if (!result.rowCount) throw new HttpError(404, "Home medication not found");
  res.json({ homeMedicationId });
});

// The patient stopped taking it: soft delete.
nursingRouter.patch("/api/home-medications/:homeMedicationId/deactivate", async (req, res) => {
  const homeMedicationId = id.parse(req.params.homeMedicationId);
  const { employeeId } = employeeOnly.parse(req.body);
  await requireStaffType(employeeId, "nurse", "update home medications");

  const result = await pool.query(
    `UPDATE home_medication SET is_active = false WHERE home_medication_id = $1 AND is_active`,
    [homeMedicationId]
  );
  if (!result.rowCount) throw new HttpError(404, "Home medication not found");
  res.json({ homeMedicationId });
});

// ---------------------------------------------------------------------------
// Visit notes (appointment_summary)
// ---------------------------------------------------------------------------

// The visit's summary, or null if nobody has written one yet.
nursingRouter.get("/api/appointments/:appointmentId/summary", async (req, res) => {
  const appointmentId = id.parse(req.params.appointmentId);

  const result = await pool.query(
    `
    SELECT
      s.notes,
      s.diagnosis,
      e.first_name || ' ' || e.last_name AS "recordedBy",
      s.recorded_date AS "recordedDate"
    FROM appointment_summary s
    JOIN employee e ON e.employee_id = s.recorded_by_employee_id
    WHERE s.appointment_id = $1
    `,
    [appointmentId]
  );
  res.json(result.rows[0] ?? null);
});

const noteSchema = z.object({
  employeeId: z.number().int().positive(),
  text: z.string().trim().min(1),
});

// Add a triage note to the visit. appointment_summary has one row per
// appointment (UNIQUE appointment_id) and one `notes` column shared with
// the doctor, so notes are *appended*, each stamped with the nurse's name
// and time — nothing anyone wrote before is overwritten.
//
// The upsert: INSERT the row if this is the first note; otherwise
// (ON CONFLICT) append to the existing notes. The diagnosis and the
// original recorded_by_employee_id are never touched. The first note also
// moves the visit to "With nurse" on the front desk.
nursingRouter.post("/api/appointments/:appointmentId/notes", async (req, res) => {
  const appointmentId = id.parse(req.params.appointmentId);
  const body = noteSchema.parse(req.body);
  const { officeId } = await requireStaffType(body.employeeId, "nurse", "write visit notes");

  const visit = await pool.query(`SELECT office_id FROM appointment WHERE appointment_id = $1`, [appointmentId]);
  if (!visit.rowCount) throw new HttpError(404, "Appointment not found");
  if (visit.rows[0].office_id !== officeId) throw new HttpError(403, "That appointment is at another office");

  const nurse = await pool.query(`SELECT first_name || ' ' || last_name AS name FROM employee WHERE employee_id = $1`, [
    body.employeeId,
  ]);
  const stamp = new Date().toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });
  const entry = `[${nurse.rows[0].name}, ${stamp}] ${body.text}`;

  await pool.query(
    `
    INSERT INTO appointment_summary (appointment_id, notes, recorded_by_employee_id)
    VALUES ($1, $2, $3)
    ON CONFLICT (appointment_id) DO UPDATE
    SET notes = COALESCE(appointment_summary.notes || E'\\n', '') || EXCLUDED.notes
    `,
    [appointmentId, entry, body.employeeId]
  );
  res.status(201).json({ appointmentId });
});

// ---------------------------------------------------------------------------
// Lab orders
// ---------------------------------------------------------------------------

nursingRouter.get("/api/lab-test-types", async (_req, res) => {
  const result = await pool.query(`
    SELECT lab_test_type_id AS "labTestTypeId", name, cost
    FROM lab_test_type
    WHERE is_active
    ORDER BY name
  `);
  res.json(result.rows);
});

// A patient's lab orders, newest first.
nursingRouter.get("/api/patients/:patientId/lab-orders", async (req, res) => {
  const patientId = id.parse(req.params.patientId);

  const result = await pool.query(
    `
    SELECT
      lo.lab_order_id AS "labOrderId",
      lo.appointment_id AS "appointmentId",
      ltt.name AS "testName",
      lo.status,
      lo.order_date AS "orderDate",
      lo.result_notes AS "resultNotes",
      e.first_name || ' ' || e.last_name AS "orderedBy"
    FROM lab_order lo
    JOIN lab_test_type ltt ON ltt.lab_test_type_id = lo.lab_test_type_id
    JOIN employee e ON e.employee_id = lo.ordered_by_employee_id
    WHERE lo.patient_id = $1
    ORDER BY lo.lab_order_id DESC
    `,
    [patientId]
  );
  res.json(result.rows);
});

const labOrderSchema = z.object({
  employeeId: z.number().int().positive(),
  patientId: z.number().int().positive(),
  labTestTypeId: z.number().int().positive(),
  // Labs ordered for a visit are added to that visit's invoice minimum.
  appointmentId: z.number().int().positive().nullable().default(null),
});

nursingRouter.post("/api/lab-orders", async (req, res) => {
  const body = labOrderSchema.parse(req.body);
  const { officeId } = await requireStaffType(body.employeeId, "nurse", "order lab tests");
  if (body.appointmentId) await checkVisit(body.appointmentId, body.patientId, officeId);

  const result = await pool.query(
    `
    INSERT INTO lab_order (patient_id, ordered_by_employee_id, lab_test_type_id, appointment_id)
    VALUES ($1, $2, $3, $4)
    RETURNING lab_order_id AS "labOrderId", status
    `,
    [body.patientId, body.employeeId, body.labTestTypeId, body.appointmentId]
  );
  res.status(201).json(result.rows[0]);
});

// Which status a lab order may come from, for each status it moves to:
// Ordered -> InProgress -> Completed, and either open state -> Cancelled.
const ALLOWED_FROM: Record<string, string[]> = {
  InProgress: ["Ordered"],
  Completed: ["InProgress"],
  Cancelled: ["Ordered", "InProgress"],
};

const updateLabSchema = z.object({
  employeeId: z.number().int().positive(),
  status: z.enum(["InProgress", "Completed", "Cancelled"]).nullable().default(null),
  resultNotes: optionalText,
});

// Move a lab order along and/or record results. The allowed "from"
// statuses go in the WHERE clause, so a skipped or backwards step changes
// 0 rows. Leaving `status` out only updates the result notes.
nursingRouter.patch("/api/lab-orders/:labOrderId", async (req, res) => {
  const labOrderId = id.parse(req.params.labOrderId);
  const body = updateLabSchema.parse(req.body);
  await requireStaffType(body.employeeId, "nurse", "update lab orders");

  const from = body.status ? ALLOWED_FROM[body.status] : ["Ordered", "InProgress", "Completed"];
  const result = await pool.query(
    `
    UPDATE lab_order
    SET status = COALESCE($2, status), result_notes = COALESCE($3, result_notes)
    WHERE lab_order_id = $1 AND status = ANY($4::text[])
    RETURNING lab_order_id AS "labOrderId", status
    `,
    [labOrderId, body.status, body.resultNotes, from]
  );
  if (!result.rowCount) {
    const exists = await pool.query(`SELECT status FROM lab_order WHERE lab_order_id = $1`, [labOrderId]);
    throw exists.rowCount
      ? new HttpError(
          409,
          body.status
            ? `This lab order is ${exists.rows[0].status}, so it can't be changed to ${body.status}`
            : `This lab order is ${exists.rows[0].status}, so it can't be changed`
        )
      : new HttpError(404, "Lab order not found");
  }
  res.json(result.rows[0]);
});

// ---------------------------------------------------------------------------
// Office supplies
// ---------------------------------------------------------------------------

// The office's stock. lowStock: at or below its reorder threshold;
// expiringSoon: expires within 30 days (or already expired).
nursingRouter.get("/api/office-supplies", async (req, res) => {
  const officeId = id.parse(req.query.officeId);

  const result = await pool.query(
    `
    SELECT
      os.office_supply_id AS "officeSupplyId",
      s.supply_id AS "supplyId",
      s.name,
      st.type_name AS type,
      os.quantity_on_hand AS "quantityOnHand",
      os.reorder_threshold AS "reorderThreshold",
      os.expiration_date AS "expirationDate",
      os.quantity_on_hand <= os.reorder_threshold AS "lowStock",
      COALESCE(os.expiration_date <= CURRENT_DATE + 30, false) AS "expiringSoon"
    FROM office_supply os
    JOIN supply s ON s.supply_id = os.supply_id
    JOIN supply_type st ON st.supply_type_id = s.supply_type_id
    WHERE os.office_id = $1 AND os.is_active
    ORDER BY s.name
    `,
    [officeId]
  );
  res.json(result.rows);
});

const useSupplySchema = z.object({
  employeeId: z.number().int().positive(),
  quantity: z.number().int().positive(),
});

// Take supplies out of stock. One UPDATE both checks and subtracts
// (WHERE quantity_on_hand >= $2), so two nurses using the last items at
// the same time can't push the count below zero.
nursingRouter.post("/api/office-supplies/:officeSupplyId/use", async (req, res) => {
  const officeSupplyId = id.parse(req.params.officeSupplyId);
  const body = useSupplySchema.parse(req.body);
  const { officeId } = await requireStaffType(body.employeeId, "nurse", "use supplies");

  const result = await pool.query(
    `
    UPDATE office_supply
    SET quantity_on_hand = quantity_on_hand - $2
    WHERE office_supply_id = $1 AND office_id = $3 AND is_active AND quantity_on_hand >= $2
    RETURNING quantity_on_hand AS "quantityOnHand"
    `,
    [officeSupplyId, body.quantity, officeId]
  );
  if (!result.rowCount) {
    const row = await pool.query(`SELECT office_id, quantity_on_hand FROM office_supply WHERE office_supply_id = $1`, [
      officeSupplyId,
    ]);
    if (!row.rowCount) throw new HttpError(404, "Supply not found");
    if (row.rows[0].office_id !== officeId) throw new HttpError(403, "That supply is at another office");
    throw new HttpError(409, `Only ${row.rows[0].quantity_on_hand} left`);
  }
  res.json(result.rows[0]);
});

// The office's recent restock requests, newest first.
nursingRouter.get("/api/supply-orders", async (req, res) => {
  const officeId = id.parse(req.query.officeId);

  const result = await pool.query(
    `
    SELECT
      so.supply_order_id AS "supplyOrderId",
      s.name AS "supplyName",
      so.quantity_ordered AS "quantityOrdered",
      so.order_date AS "orderDate",
      so.status,
      e.first_name || ' ' || e.last_name AS "requestedBy"
    FROM supply_order so
    JOIN supply s ON s.supply_id = so.supply_id
    JOIN employee e ON e.employee_id = so.employee_id
    WHERE so.office_id = $1
    ORDER BY so.supply_order_id DESC
    LIMIT 20
    `,
    [officeId]
  );
  res.json(result.rows);
});

const supplyOrderSchema = z.object({
  employeeId: z.number().int().positive(),
  supplyId: z.number().int().positive(),
  quantity: z.number().int().positive(),
});

// Request a restock for the nurse's office (status starts as 'Pending').
nursingRouter.post("/api/supply-orders", async (req, res) => {
  const body = supplyOrderSchema.parse(req.body);
  const { officeId } = await requireStaffType(body.employeeId, "nurse", "request supplies");

  const result = await pool.query(
    `
    INSERT INTO supply_order (supply_id, office_id, employee_id, quantity_ordered)
    VALUES ($1, $2, $3, $4)
    RETURNING supply_order_id AS "supplyOrderId", status
    `,
    [body.supplyId, officeId, body.employeeId, body.quantity]
  );
  res.status(201).json(result.rows[0]);
});

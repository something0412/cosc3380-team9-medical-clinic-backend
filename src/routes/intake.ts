import { Router } from "express";
import { z } from "zod";
import { pool, withTransaction } from "../lib/db.js";
import { requireStaffType } from "../lib/staff.js";
import { HttpError } from "../middleware/errorHandler.js";

// Front-desk intake for an existing patient: emergency contacts,
// insurance and intake forms. Every write is receptionists only.
export const intakeRouter = Router();

const id = z.coerce.number().int().positive();
const employeeOnly = z.object({ employeeId: z.number().int().positive() });

// ---------------------------------------------------------------------------
// Emergency contacts
//
// Rule: if a patient has contacts, exactly one active contact is primary.
// So the first contact is made primary automatically, making one primary
// un-sets the rest (in the same transaction), and the primary can't be
// removed until another contact is made primary.
// ---------------------------------------------------------------------------

const contactSchema = z.object({
  employeeId: z.number().int().positive(),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  relationship: z.string().trim().min(1),
  phone: z.string().trim().min(1),
  isPrimary: z.boolean().default(false),
});

intakeRouter.post("/api/patients/:patientId/emergency-contacts", async (req, res) => {
  const patientId = id.parse(req.params.patientId);
  const body = contactSchema.parse(req.body);
  await requireStaffType(body.employeeId, "receptionist", "manage emergency contacts");

  const contact = await withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT 1 FROM emergency_contact WHERE patient_id = $1 AND is_active`,
      [patientId]
    );
    const isPrimary = body.isPrimary || existing.rowCount === 0;

    if (isPrimary) {
      await client.query(`UPDATE emergency_contact SET is_primary = false WHERE patient_id = $1`, [patientId]);
    }

    const result = await client.query(
      `
      INSERT INTO emergency_contact (patient_id, first_name, last_name, relationship, phone_number, is_primary)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING emergency_contact_id AS "emergencyContactId"
      `,
      [patientId, body.firstName, body.lastName, body.relationship, body.phone, isPrimary]
    );
    return result.rows[0];
  });

  res.status(201).json(contact);
});

// Edit a contact. isPrimary: true makes it the primary; false is ignored
// (a primary is only replaced by promoting a different contact).
intakeRouter.put("/api/emergency-contacts/:contactId", async (req, res) => {
  const contactId = id.parse(req.params.contactId);
  const body = contactSchema.parse(req.body);
  await requireStaffType(body.employeeId, "receptionist", "manage emergency contacts");

  await withTransaction(async (client) => {
    const result = await client.query(
      `
      UPDATE emergency_contact
      SET first_name = $2, last_name = $3, relationship = $4, phone_number = $5
      WHERE emergency_contact_id = $1 AND is_active
      RETURNING patient_id AS "patientId"
      `,
      [contactId, body.firstName, body.lastName, body.relationship, body.phone]
    );
    if (!result.rowCount) {
      throw new HttpError(404, "Emergency contact not found");
    }

    if (body.isPrimary) {
      // One statement flips every contact: true for this one, false for the rest.
      await client.query(
        `UPDATE emergency_contact SET is_primary = (emergency_contact_id = $2) WHERE patient_id = $1`,
        [result.rows[0].patientId, contactId]
      );
    }
  });

  res.json({ emergencyContactId: contactId });
});

// Soft delete: contacts are never DELETEd, just marked inactive.
intakeRouter.patch("/api/emergency-contacts/:contactId/deactivate", async (req, res) => {
  const contactId = id.parse(req.params.contactId);
  const { employeeId } = employeeOnly.parse(req.body);
  await requireStaffType(employeeId, "receptionist", "manage emergency contacts");

  const result = await pool.query(
    `
    UPDATE emergency_contact
    SET is_active = false
    WHERE emergency_contact_id = $1 AND is_active AND NOT is_primary
    RETURNING emergency_contact_id
    `,
    [contactId]
  );
  if (!result.rowCount) {
    const contact = await pool.query(
      `SELECT is_primary FROM emergency_contact WHERE emergency_contact_id = $1 AND is_active`,
      [contactId]
    );
    throw contact.rowCount
      ? new HttpError(409, "This is the primary contact. Make another contact primary before removing it.")
      : new HttpError(404, "Emergency contact not found");
  }

  res.json({ emergencyContactId: contactId });
});

// ---------------------------------------------------------------------------
// Insurance (one policy per patient: insurance.patient_id is UNIQUE)
// ---------------------------------------------------------------------------

const insuranceSchema = z.object({
  employeeId: z.number().int().positive(),
  provider: z.string().trim().min(1),
  policyNumber: z.string().trim().min(1),
});

// Add or replace the patient's policy in one statement (an "upsert"):
// INSERT, or if the patient already has a row (the UNIQUE patient_id
// conflicts), UPDATE that row instead. EXCLUDED is the row we tried to
// insert. A changed policy has to be verified again, so its status goes
// back to Pending; re-saving the same policy keeps its status.
intakeRouter.put("/api/patients/:patientId/insurance", async (req, res) => {
  const patientId = id.parse(req.params.patientId);
  const body = insuranceSchema.parse(req.body);
  await requireStaffType(body.employeeId, "receptionist", "manage insurance");

  const result = await pool.query(
    `
    INSERT INTO insurance (patient_id, provider, policy_number)
    VALUES ($1, $2, $3)
    ON CONFLICT (patient_id) DO UPDATE
    SET provider = EXCLUDED.provider,
        policy_number = EXCLUDED.policy_number,
        status = CASE
          WHEN insurance.provider = EXCLUDED.provider AND insurance.policy_number = EXCLUDED.policy_number
          THEN insurance.status
          ELSE 'Pending'
        END
    RETURNING provider, policy_number AS "policyNumber", status
    `,
    [patientId, body.provider, body.policyNumber]
  );

  res.json(result.rows[0]);
});

const insuranceStatusSchema = z.object({
  employeeId: z.number().int().positive(),
  status: z.enum(["Pending", "Verified", "Denied"]),
});

intakeRouter.patch("/api/patients/:patientId/insurance/status", async (req, res) => {
  const patientId = id.parse(req.params.patientId);
  const body = insuranceStatusSchema.parse(req.body);
  await requireStaffType(body.employeeId, "receptionist", "verify insurance");

  const result = await pool.query(
    `
    UPDATE insurance SET status = $2 WHERE patient_id = $1
    RETURNING provider, policy_number AS "policyNumber", status
    `,
    [patientId, body.status]
  );
  if (!result.rowCount) {
    throw new HttpError(404, "This patient has no insurance on file");
  }

  res.json(result.rows[0]);
});

// ---------------------------------------------------------------------------
// Intake forms
// ---------------------------------------------------------------------------

intakeRouter.get("/api/form-types", async (_req, res) => {
  const result = await pool.query(`
    SELECT form_type_id AS "formTypeId", name, is_required AS "isRequired"
    FROM form_type
    WHERE is_active
    ORDER BY is_required DESC, name
  `);

  res.json(result.rows);
});

// Every active form type with this patient's status for it, so missing
// required forms show up even if the patient never started them.
//
// A patient can have several submissions of one form type, so LEFT JOIN
// LATERAL picks just one per form type: a Completed one if it exists,
// otherwise the newest. LEFT keeps form types with no submission at all
// (status NULL -> "Not started").
intakeRouter.get("/api/patients/:patientId/forms", async (req, res) => {
  const patientId = id.parse(req.params.patientId);

  const result = await pool.query(
    `
    SELECT
      ft.form_type_id AS "formTypeId",
      ft.name,
      ft.is_required AS "isRequired",
      COALESCE(fs.status, 'Not started') AS status,
      fs.submitted_date AS "submittedDate"
    FROM form_type ft
    LEFT JOIN LATERAL (
      SELECT status, submitted_date
      FROM form_submission
      WHERE patient_id = $1 AND form_type_id = ft.form_type_id
      ORDER BY (status = 'Completed') DESC, form_submission_id DESC
      LIMIT 1
    ) fs ON true
    WHERE ft.is_active
    ORDER BY ft.is_required DESC, ft.name
    `,
    [patientId]
  );

  res.json(result.rows);
});

// Mark a form as received/completed: finish the patient's pending
// submission if there is one, otherwise record a completed one. The
// schema's CHECK requires submitted_date once a form is Completed.
intakeRouter.patch("/api/patients/:patientId/forms/:formTypeId/complete", async (req, res) => {
  const patientId = id.parse(req.params.patientId);
  const formTypeId = id.parse(req.params.formTypeId);
  const { employeeId } = employeeOnly.parse(req.body);
  await requireStaffType(employeeId, "receptionist", "update forms");

  await withTransaction(async (client) => {
    const done = await client.query(
      `SELECT 1 FROM form_submission WHERE patient_id = $1 AND form_type_id = $2 AND status = 'Completed'`,
      [patientId, formTypeId]
    );
    if (done.rowCount) return;

    const updated = await client.query(
      `
      UPDATE form_submission
      SET status = 'Completed', submitted_date = CURRENT_DATE
      WHERE patient_id = $1 AND form_type_id = $2 AND status = 'Pending'
      `,
      [patientId, formTypeId]
    );
    if (!updated.rowCount) {
      await client.query(
        `
        INSERT INTO form_submission (patient_id, form_type_id, status, submitted_date)
        VALUES ($1, $2, 'Completed', CURRENT_DATE)
        `,
        [patientId, formTypeId]
      );
    }
  });

  res.json({ patientId, formTypeId, status: "Completed" });
});

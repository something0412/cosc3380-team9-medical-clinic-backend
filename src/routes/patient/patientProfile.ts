import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { HttpError } from "../../middleware/errorHandler.js";

export const patientProfileRouter = Router();

const idParam = z.coerce.number().int().positive();

const contactInfoSchema = z.object({
  phone: z.string().trim().min(1),
  email: z.email().trim().toLowerCase(),
  address: z.string().trim().nullable(),
  gender: z.string().trim().nullable(),
});

const emergencyContactSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  relationship: z.string().trim().min(1),
  phoneNumber: z.string().trim().min(1),
  isPrimary: z.boolean(),
});

const insuranceSchema = z.object({
  provider: z.string().trim().min(1),
  policyNumber: z.string().trim().min(1),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

// get profile
patientProfileRouter.get("/api/patient/:id/profile", async (req, res) => {
  const patientId = idParam.parse(req.params.id);

  const patient = await pool.query(
    `
    SELECT
      patient_id AS "patientId",
      first_name AS "firstName",
      last_name AS "lastName",
      to_char(dob, 'YYYY-MM-DD') AS dob,
      gender,
      phone,
      email,
      address,
      is_active AS "isActive"
    FROM patient
    WHERE patient_id = $1
    `,
    [patientId]
  );
  if (!patient.rowCount) throw new HttpError(404, "Patient not found");

  const contacts = await pool.query(
    `
    SELECT
      emergency_contact_id AS "emergencyContactId",
      first_name AS "firstName",
      last_name AS "lastName",
      relationship,
      phone_number AS "phoneNumber",
      is_primary AS "isPrimary"
    FROM emergency_contact
    WHERE patient_id = $1 AND is_active
    ORDER BY is_primary DESC, emergency_contact_id
    `,
    [patientId]
  );

  const insurance = await pool.query(
    `SELECT provider, policy_number AS "policyNumber", status FROM insurance WHERE patient_id = $1`,
    [patientId]
  );

  res.json({ ...patient.rows[0], emergencyContacts: contacts.rows, insurance: insurance.rows[0] ?? null });
});

// update contact info
patientProfileRouter.put("/api/patient/:id/profile", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  const body = contactInfoSchema.parse(req.body);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const taken = await client.query(
      `SELECT 1 FROM patient_creds WHERE LOWER(username) = $1 AND patient_id <> $2`,
      [body.email, patientId]
    );
    if (taken.rowCount) throw new HttpError(409, "This email is already used by another account");

    const updated = await client.query(
      `UPDATE patient SET phone = $1, email = $2, address = $3, gender = $4 WHERE patient_id = $5`,
      [body.phone, body.email, body.address || null, body.gender || null, patientId]
    );
    if (!updated.rowCount) throw new HttpError(404, "Patient not found");

    await client.query(`UPDATE patient_creds SET username = $1 WHERE patient_id = $2`, [body.email, patientId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  res.status(204).end();
});

// add emergency contact
patientProfileRouter.post("/api/patient/:id/emergency-contacts", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  const body = emergencyContactSchema.parse(req.body);

  if (body.isPrimary) {
    await pool.query(`UPDATE emergency_contact SET is_primary = false WHERE patient_id = $1`, [patientId]);
  }
  await pool.query(
    `
    INSERT INTO emergency_contact (patient_id, first_name, last_name, relationship, phone_number, is_primary)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [patientId, body.firstName, body.lastName, body.relationship, body.phoneNumber, body.isPrimary]
  );

  res.status(201).end();
});

// update emergency contact
patientProfileRouter.put("/api/patient/:id/emergency-contacts/:contactId", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  const contactId = idParam.parse(req.params.contactId);
  const body = emergencyContactSchema.parse(req.body);

  if (body.isPrimary) {
    await pool.query(`UPDATE emergency_contact SET is_primary = false WHERE patient_id = $1`, [patientId]);
  }
  const updated = await pool.query(
    `
    UPDATE emergency_contact
    SET first_name = $1, last_name = $2, relationship = $3, phone_number = $4, is_primary = $5
    WHERE emergency_contact_id = $6 AND patient_id = $7 AND is_active
    `,
    [body.firstName, body.lastName, body.relationship, body.phoneNumber, body.isPrimary, contactId, patientId]
  );
  if (!updated.rowCount) throw new HttpError(404, "Emergency contact not found");

  res.status(204).end();
});

// remove emergency contact
patientProfileRouter.delete("/api/patient/:id/emergency-contacts/:contactId", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  const contactId = idParam.parse(req.params.contactId);

  const updated = await pool.query(
    `UPDATE emergency_contact SET is_active = false, is_primary = false WHERE emergency_contact_id = $1 AND patient_id = $2`,
    [contactId, patientId]
  );
  if (!updated.rowCount) throw new HttpError(404, "Emergency contact not found");

  res.status(204).end();
});

// update insurance
patientProfileRouter.put("/api/patient/:id/insurance", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  const body = insuranceSchema.parse(req.body);

  const taken = await pool.query(
    `SELECT 1 FROM insurance WHERE policy_number = $1 AND patient_id <> $2`,
    [body.policyNumber, patientId]
  );
  if (taken.rowCount) throw new HttpError(409, "This policy number is already registered to another patient");

  await pool.query(
    `
    INSERT INTO insurance (patient_id, provider, policy_number, status)
    VALUES ($1, $2, $3, 'Pending')
    ON CONFLICT (patient_id) DO UPDATE
    SET provider = EXCLUDED.provider, policy_number = EXCLUDED.policy_number, status = 'Pending'
    `,
    [patientId, body.provider, body.policyNumber]
  );

  res.status(204).end();
});

// change password
patientProfileRouter.put("/api/patient/:id/password", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  const { currentPassword, newPassword } = passwordChangeSchema.parse(req.body);

  const creds = await pool.query(`SELECT password_hash FROM patient_creds WHERE patient_id = $1`, [patientId]);
  if (!creds.rowCount || !(await verifyPassword(currentPassword, creds.rows[0].password_hash))) {
    throw new HttpError(400, "Current password is incorrect");
  }

  await pool.query(`UPDATE patient_creds SET password_hash = $1 WHERE patient_id = $2`, [
    await hashPassword(newPassword),
    patientId,
  ]);
  res.status(204).end();
});

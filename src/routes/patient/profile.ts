import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { hashPassword, passwordChangeSchema, verifyPassword } from "../../lib/password.js";
import { HttpError } from "../../middleware/errorHandler.js";
import {
  addEmergencyContact,
  emergencyContactSchema,
  getPatientProfile,
  insuranceSchema,
  patientContactSchema,
  removeEmergencyContact,
  saveInsurance,
  updateContactInfo,
  updateEmergencyContact,
} from "../../services/patients.js";

export const patientProfileRouter = Router();

const idParam = z.coerce.number().int().positive();

patientProfileRouter.get("/api/patient/:id/profile", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  const profile = await getPatientProfile(patientId);
  if (!profile) throw new HttpError(404, "Patient not found");

  // my primary doctor, or null
  const primary = await pool.query(
    `
    SELECT pd.doctor_id AS "doctorId", e.first_name || ' ' || e.last_name AS name
    FROM patient_doctor pd
    JOIN employee e ON e.employee_id = pd.doctor_id
    WHERE pd.patient_id = $1 AND pd.is_primary AND pd.is_active
    `,
    [patientId]
  );
  res.json({ ...profile, primaryDoctor: primary.rows[0] ?? null });
});

// update contact info
patientProfileRouter.put("/api/patient/:id/profile", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  await updateContactInfo(patientId, patientContactSchema.parse(req.body));
  res.status(204).end();
});

patientProfileRouter.post("/api/patient/:id/emergency-contacts", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  await addEmergencyContact(patientId, emergencyContactSchema.parse(req.body));
  res.status(201).end();
});

patientProfileRouter.put("/api/patient/:id/emergency-contacts/:contactId", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  const contactId = idParam.parse(req.params.contactId);
  await updateEmergencyContact(patientId, contactId, emergencyContactSchema.parse(req.body));
  res.status(204).end();
});

patientProfileRouter.delete("/api/patient/:id/emergency-contacts/:contactId", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  const contactId = idParam.parse(req.params.contactId);
  await removeEmergencyContact(patientId, contactId);
  res.status(204).end();
});

// patients can't set the status, so their insurance is always saved as Pending
patientProfileRouter.put("/api/patient/:id/insurance", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  await saveInsurance(patientId, insuranceSchema.parse(req.body));
  res.status(204).end();
});

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

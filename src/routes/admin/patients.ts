import { Router } from "express";
import { z } from "zod";
import { CLINIC_TODAY } from "../../lib/clinicTime.js";
import { pool } from "../../lib/db.js";
import { hashPassword } from "../../lib/password.js";
import { withTransaction } from "../../lib/transaction.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { setPatientActive } from "../../services/patients.js";

export const adminPatientsRouter = Router();

const idParam = z.coerce.number().int().positive();
const listQuery = z.object({ status: z.enum(["active", "inactive", "all"]).default("active") });
const statusSchema = z.object({ isActive: z.boolean() });
const patientEditSchema = z.object({
  doctorId: z.number("Choose a doctor").int().positive().nullable(),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be 128 characters or less")
    .nullish(),
});

adminPatientsRouter.get("/", async (req, res) => {
  const { status } = listQuery.parse(req.query);

  const result = await pool.query(
    `
    SELECT
      p.patient_id AS "patientId",
      p.first_name AS "firstName",
      p.last_name AS "lastName",
      to_char(c.created_date, 'YYYY-MM-DD') AS "joinedDate",
      p.phone,
      d.first_name || ' ' || d.last_name AS "primaryDoctor",
      p.is_active AS "isActive"
    FROM patient p
    LEFT JOIN patient_creds c ON c.patient_id = p.patient_id
    LEFT JOIN patient_doctor pd ON pd.patient_id = p.patient_id AND pd.is_primary AND pd.is_active
    LEFT JOIN employee d ON d.employee_id = pd.doctor_id
    WHERE ($1 = 'all' OR p.is_active = ($1 = 'active'))
    ORDER BY p.last_name, p.first_name
    `,
    [status]
  );

  res.json(result.rows);
});

// get one patient for the edit page
adminPatientsRouter.get("/:id", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  const result = await pool.query(
    `
    SELECT
      p.patient_id AS "patientId",
      p.first_name AS "firstName",
      p.last_name AS "lastName",
      pd.doctor_id AS "primaryDoctorId",
      c.username,
      c.patient_id IS NOT NULL AS "hasLogin"
    FROM patient p
    LEFT JOIN patient_doctor pd ON pd.patient_id = p.patient_id AND pd.is_primary AND pd.is_active
    LEFT JOIN patient_creds c ON c.patient_id = p.patient_id
    WHERE p.patient_id = $1
    `,
    [patientId]
  );
  if (!result.rowCount) throw new HttpError(404, "Patient not found");
  res.json(result.rows[0]);
});

// save a patient's primary doctor (null removes it) and a new password if one is given
adminPatientsRouter.put("/:id", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  const { doctorId, newPassword } = patientEditSchema.parse(req.body);

  if (doctorId !== null) {
    const doctor = await pool.query(
      `SELECT 1 FROM doctor d JOIN employee e ON e.employee_id = d.employee_id WHERE d.employee_id = $1 AND e.is_active`,
      [doctorId]
    );
    if (!doctor.rowCount) throw new HttpError(400, "Choose an active doctor");
  }
  const login = await pool.query(`SELECT 1 FROM patient_creds WHERE patient_id = $1`, [patientId]);
  if (newPassword && !login.rowCount) throw new HttpError(400, "This patient doesn't have a portal login yet");
  const passwordHash = newPassword ? await hashPassword(newPassword) : null;

  await withTransaction(async (client) => {
    // only swap the primary doctor when it changed
    const current = await client.query(`SELECT doctor_id FROM patient_doctor WHERE patient_id = $1 AND is_primary AND is_active`, [patientId]);
    const currentId = current.rows[0]?.doctor_id ?? null;
    if (currentId !== doctorId) {
      // the old primary doctor stays assigned, just not primary
      await client.query(`UPDATE patient_doctor SET is_primary = false WHERE patient_id = $1 AND is_primary`, [patientId]);
      if (doctorId !== null) {
        await client.query(
          `
          INSERT INTO patient_doctor (patient_id, doctor_id, is_primary, assigned_date, is_active)
          VALUES ($1, $2, true, ${CLINIC_TODAY}, true)
          ON CONFLICT (patient_id, doctor_id) DO UPDATE SET is_primary = true, is_active = true, assigned_date = EXCLUDED.assigned_date
          `,
          [patientId, doctorId]
        );
      }
    }

    // a new password replaces the old one, no current password needed
    if (passwordHash) {
      await client.query(`UPDATE patient_creds SET password_hash = $1 WHERE patient_id = $2`, [passwordHash, patientId]);
    }
  });
  res.status(204).end();
});

// activate or deactivate a patient and their login
adminPatientsRouter.patch("/:id/status", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  const { isActive } = statusSchema.parse(req.body);
  res.json(await setPatientActive(patientId, isActive));
});

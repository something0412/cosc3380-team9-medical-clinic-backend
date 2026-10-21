import { Router } from "express";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { STAFF_TYPE_SQL } from "../lib/staff.js";
import { HttpError } from "../middleware/errorHandler.js";

export const authRouter = Router();

const signupSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  dob: z.iso.date(),
  phone: z.string().trim().min(1),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(8),
});

const patientLoginSchema = z.object({
  patientId: z.coerce.number().int().positive(),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1),
});

const staffLoginSchema = z.object({
  employeeId: z.coerce.number().int().positive(),
  password: z.string().min(1),
});

// Create account
authRouter.post("/api/auth/patient/signup", async (req, res) => {
  const body = signupSchema.parse(req.body);
  const passwordHash = await hashPassword(body.password);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(`SELECT 1 FROM patient_creds WHERE username = $1`, [body.email]);
    if (existing.rowCount) {
      throw new HttpError(409, "An account with this email already exists");
    }

    const patient = await client.query(
      `
      INSERT INTO patient (first_name, last_name, dob, phone, email)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING patient_id AS "patientId", first_name AS "firstName", last_name AS "lastName", email
      `,
      [body.firstName, body.lastName, body.dob, body.phone, body.email]
    );

    await client.query(
      `INSERT INTO patient_creds (patient_id, username, password_hash) VALUES ($1, $2, $3)`,
      [patient.rows[0].patientId, body.email, passwordHash]
    );

    await client.query("COMMIT");
    res.status(201).json(patient.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// Patient login
authRouter.post("/api/auth/patient/login", async (req, res) => {
  const { patientId, email, password } = patientLoginSchema.parse(req.body);

  const result = await pool.query(
    `
    SELECT
      p.patient_id AS "patientId",
      p.first_name AS "firstName",
      p.last_name AS "lastName",
      p.email,
      c.password_hash AS "passwordHash"
    FROM patient p
    JOIN patient_creds c ON c.patient_id = p.patient_id
    WHERE p.patient_id = $1
      AND LOWER(c.username) = $2
      AND p.is_active
      AND c.is_active
    `,
    [patientId, email]
  );

  const row = result.rows[0];
  if (!row || !(await verifyPassword(password, row.passwordHash))) {
    throw new HttpError(401, "Invalid patient number, email, or password");
  }

  const { passwordHash: _, ...patient } = row;
  res.json(patient);
});

// Staff login
authRouter.post("/api/auth/staff/login", async (req, res) => {
  const { employeeId, password } = staffLoginSchema.parse(req.body);

  const result = await pool.query(
    `
    SELECT
      e.employee_id AS "employeeId",
      e.first_name AS "firstName",
      e.last_name AS "lastName",
      t.type_name AS "employeeType",
      CASE
        WHEN d.employee_id IS NOT NULL THEN 'doctor'
        WHEN t.type_name ILIKE 'admin%' THEN 'admin'
        ELSE 'staff'
      END AS role,
      ${STAFF_TYPE_SQL} AS "staffType",
      e.office_id AS "officeId",
      c.password_hash AS "passwordHash"
    FROM employee e
    JOIN employee_creds c ON c.employee_id = e.employee_id
    JOIN employee_types t ON t.employee_type_id = e.employee_type_id
    LEFT JOIN doctor d ON d.employee_id = e.employee_id
    WHERE e.employee_id = $1
      AND e.is_active
      AND c.is_active
    `,
    [employeeId]
  );

  const row = result.rows[0];
  if (!row || !(await verifyPassword(password, row.passwordHash))) {
    throw new HttpError(401, "Invalid staff ID or password");
  }

  const { passwordHash: _, ...employee } = row;
  res.json(employee);
});

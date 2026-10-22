import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { STAFF_TYPE_SQL } from "../lib/staff.js";
import { HttpError } from "../middleware/errorHandler.js";

export const authRouter = Router();

declare module "express-session" {
  interface SessionData {
    role?: "patient" | "doctor" | "admin" | "staff";
    patientId?: number;
    employeeId?: number;
    firstName?: string;
    lastName?: string;
  }
}

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

// start session
async function startSession(
  req: Request,
  role: "patient" | "doctor" | "admin" | "staff",
  id: number,
  firstName: string,
  lastName: string
) {
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);

      req.session.role = role;
      req.session.firstName = firstName;
      req.session.lastName = lastName;
      if (role === "patient") {
        req.session.patientId = id;
      } else {
        req.session.employeeId = id;
      }

      req.session.save((saveError) => {
        if (saveError) return reject(saveError);
        resolve();
      });
    });
  });
}

// create account
authRouter.post("/api/auth/patient/signup", async (req, res) => {
  const body = signupSchema.parse(req.body);
  const passwordHash = await hashPassword(body.password);
  const client = await pool.connect();
  let createdPatient: {
    patientId: number;
    firstName: string;
    lastName: string;
    email: string;
  };

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

    createdPatient = patient.rows[0];
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await startSession(req, "patient", createdPatient.patientId, createdPatient.firstName, createdPatient.lastName);
  res.status(201).json(createdPatient);
});

// patient login
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

  await startSession(req, "patient", row.patientId, row.firstName, row.lastName);

  const { passwordHash: _, ...patient } = row;
  res.json(patient);
});

// staff login
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

  await startSession(req, row.role, row.employeeId, row.firstName, row.lastName);

  const { passwordHash: _, ...employee } = row;
  res.json(employee);
});

// current user
authRouter.get("/api/auth/me", (req, res) => {
  const { role, patientId, employeeId, firstName, lastName } = req.session;
  if (!role) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }
  res.json({ role, id: role === "patient" ? patientId : employeeId, firstName, lastName });
});

// log out
authRouter.post("/api/auth/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie("connect.sid", { path: "/" });
    res.status(204).end();
  });
});
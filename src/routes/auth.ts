import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { verifyPassword } from "../lib/password.js";
import { HttpError } from "../middleware/errorHandler.js";
import { EMPLOYEE_ROLE_SQL } from "../middleware/sessionUser.js";
import type { Role } from "../middleware/sessionUser.js";
import { signUpPatient, signupSchema } from "../services/patients.js";

export const authRouter = Router();

declare module "express-session" {
  interface SessionData {
    role?: Role;
    patientId?: number;
    employeeId?: number;
    firstName?: string;
    lastName?: string;
  }
}

const patientLoginSchema = z.object({
  patientId: z.coerce.number().int().positive(),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1),
});

const staffLoginSchema = z.object({
  employeeId: z.coerce.number().int().positive(),
  password: z.string().min(1),
});

async function startSession(req: Request, role: Role, id: number, firstName: string, lastName: string) {
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

authRouter.post("/api/auth/patient/signup", async (req, res) => {
  const body = signupSchema.parse(req.body);
  const { patientId, firstName, lastName, email } = await signUpPatient(body);

  await startSession(req, "patient", patientId, firstName, lastName);
  res.status(201).json({ patientId, firstName, lastName, email });
});

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

authRouter.post("/api/auth/staff/login", async (req, res) => {
  const { employeeId, password } = staffLoginSchema.parse(req.body);

  const result = await pool.query(
    `
    SELECT
      e.employee_id AS "employeeId",
      e.first_name AS "firstName",
      e.last_name AS "lastName",
      t.type_name AS "employeeType",
      ${EMPLOYEE_ROLE_SQL} AS role,
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
  const { user } = req;
  if (!user) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }
  if (user.role === "patient") {
    res.json({ role: user.role, id: user.patientId, firstName: user.firstName, lastName: user.lastName });
    return;
  }
  // employee details come from the database on this request, never from the session
  const { role, employeeId, firstName, lastName, employeeType, staffType, officeId } = user;
  res.json({ role, id: employeeId, firstName, lastName, employeeType, staffType, officeId });
});

authRouter.post("/api/auth/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie("connect.sid", { path: "/" });
    res.status(204).end();
  });
});
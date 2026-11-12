import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { verifyPassword } from "../lib/password.js";
import { HttpError } from "../middleware/errorHandler.js";
import { EMPLOYEE_ROLE_SQL, findEmployee, findPatient } from "../middleware/sessionUser.js";
import type { Role, SessionUser } from "../middleware/sessionUser.js";
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

// patients sign in with their patient number or their email, plus their password
const patientLoginSchema = z
  .object({
    patientId: z.coerce.number().int().positive().optional(),
    email: z.email().trim().toLowerCase().optional(),
    password: z.string().min(1),
  })
  .refine((body) => body.patientId || body.email, "Enter your patient number or email");

const staffLoginSchema = z.object({
  employeeId: z.coerce.number().int().positive(),
  password: z.string().min(1),
});

// the login page sends only an email and a password, and the email is trimmed before the check
const loginSchema = z.object({
  email: z.string("Enter your email").trim().toLowerCase().pipe(z.email("Enter a valid email address")),
  password: z.string("Enter your password").min(1, "Enter your password"),
});

const INVALID_LOGIN = "Invalid email or password";

interface LoginMatch {
  role: Role;
  id: number;
  passwordHash: string;
  isActive: boolean;
}

// what the app keeps about the signed in user, the same right after login and after a refresh
function currentUser(user: SessionUser) {
  if (user.role === "patient") {
    return { role: user.role, id: user.patientId, firstName: user.firstName, lastName: user.lastName };
  }
  const { role, employeeId, firstName, lastName, employeeType, staffType, officeId } = user;
  return { role, id: employeeId, firstName, lastName, employeeType, staffType, officeId };
}

// every login with this email, a patient's login email or an employee's email, active or not
async function findLogins(email: string): Promise<LoginMatch[]> {
  const result = await pool.query(
    `
    SELECT 'patient' AS role, p.patient_id AS id, c.password_hash AS "passwordHash", p.is_active AND c.is_active AS "isActive"
    FROM patient_creds c
    JOIN patient p ON p.patient_id = c.patient_id
    WHERE lower(btrim(c.username)) = $1
    UNION ALL
    SELECT ${EMPLOYEE_ROLE_SQL}, e.employee_id, c.password_hash, e.is_active AND c.is_active
    FROM employee e
    JOIN employee_creds c ON c.employee_id = e.employee_id
    JOIN employee_types t ON t.employee_type_id = e.employee_type_id
    LEFT JOIN doctor d ON d.employee_id = e.employee_id
    WHERE lower(btrim(e.email)) = $1
    `,
    [email]
  );
  return result.rows;
}

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

// one login for patients and staff, and the email decides which account it is
authRouter.post("/api/auth/login", async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const logins = await findLogins(email);

  // an email on more than one login is refused instead of guessing between them
  // only someone who knows one of the passwords is told why
  if (logins.length > 1) {
    const matches = await Promise.all(logins.map((login) => verifyPassword(password, login.passwordHash)));
    if (matches.some(Boolean)) throw new HttpError(409, "This email belongs to more than one account. Please call your clinic office.");
    throw new HttpError(401, INVALID_LOGIN);
  }

  const [login] = logins;
  if (!login?.isActive || !(await verifyPassword(password, login.passwordHash))) throw new HttpError(401, INVALID_LOGIN);

  // the same lookup the session check uses, so the role and details match every later request
  const user = login.role === "patient" ? await findPatient(login.id) : await findEmployee(login.id);
  if (!user) throw new HttpError(401, INVALID_LOGIN);

  await startSession(req, user.role, login.id, user.firstName, user.lastName);
  res.json(currentUser(user));
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
    WHERE ($1::int IS NULL OR p.patient_id = $1)
      AND ($2::text IS NULL OR LOWER(c.username) = $2)
      AND p.is_active
      AND c.is_active
    `,
    [patientId ?? null, email ?? null]
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
  // employee details come from the database on this request, never from the session
  res.json(currentUser(user));
});

authRouter.post("/api/auth/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie("connect.sid", { path: "/" });
    res.status(204).end();
  });
});
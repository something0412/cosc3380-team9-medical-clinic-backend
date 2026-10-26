import type { Request, RequestHandler } from "express";
import { pool } from "../lib/db.js";

export type Role = "patient" | "doctor" | "admin" | "staff" | "lab";

export type StaffType = "doctor" | "admin" | "nurse" | "receptionist" | "lab" | "other";

export interface PatientUser {
  role: "patient";
  patientId: number;
  firstName: string;
  lastName: string;
}

export interface EmployeeUser {
  role: Exclude<Role, "patient">;
  employeeId: number;
  firstName: string;
  lastName: string;
  employeeType: string;
  staffType: StaffType;
  officeId: number;
}

export type SessionUser = PatientUser | EmployeeUser;

declare global {
  namespace Express {
    interface Request {
      // the signed in user as the database sees them right now
      user?: SessionUser;
    }
  }
}

// app role for an employee, shared with staff login so both always agree
// lab technicians are checked first so a leftover doctor or nurse row can't give them more access
export const EMPLOYEE_ROLE_SQL = `
  CASE
    WHEN t.type_name = 'Lab Technician' THEN 'lab'
    WHEN d.employee_id IS NOT NULL THEN 'doctor'
    WHEN t.type_name ILIKE 'admin%' THEN 'admin'
    ELSE 'staff'
  END
`;

// nurses and receptionists share the staff role, so the nurse table and employee type tell them apart
const STAFF_TYPE_SQL = `
  CASE
    WHEN t.type_name = 'Lab Technician' THEN 'lab'
    WHEN d.employee_id IS NOT NULL THEN 'doctor'
    WHEN t.type_name ILIKE 'admin%' THEN 'admin'
    WHEN n.employee_id IS NOT NULL THEN 'nurse'
    WHEN t.type_name ILIKE 'reception%' THEN 'receptionist'
    ELSE 'other'
  END
`;

// these never use the signed in user, so they skip the lookup
const NO_USER_PATHS = [
  "/api/public",
  "/api/auth/patient/login",
  "/api/auth/patient/signup",
  "/api/auth/staff/login",
  "/api/auth/logout",
];

async function findPatient(patientId: number | undefined): Promise<PatientUser | null> {
  if (!patientId) return null;
  const result = await pool.query(
    `
    SELECT 'patient' AS role, p.patient_id AS "patientId", p.first_name AS "firstName", p.last_name AS "lastName"
    FROM patient p
    JOIN patient_creds c ON c.patient_id = p.patient_id
    WHERE p.patient_id = $1 AND p.is_active AND c.is_active
    `,
    [patientId]
  );
  return result.rows[0] ?? null;
}

async function findEmployee(employeeId: number | undefined): Promise<EmployeeUser | null> {
  if (!employeeId) return null;
  const result = await pool.query(
    `
    SELECT
      ${EMPLOYEE_ROLE_SQL} AS role,
      e.employee_id AS "employeeId",
      e.first_name AS "firstName",
      e.last_name AS "lastName",
      t.type_name AS "employeeType",
      ${STAFF_TYPE_SQL} AS "staffType",
      e.office_id AS "officeId"
    FROM employee e
    JOIN employee_creds c ON c.employee_id = e.employee_id
    JOIN employee_types t ON t.employee_type_id = e.employee_type_id
    LEFT JOIN doctor d ON d.employee_id = e.employee_id
    LEFT JOIN nurse n ON n.employee_id = e.employee_id
    WHERE e.employee_id = $1 AND e.is_active AND c.is_active
    `,
    [employeeId]
  );
  return result.rows[0] ?? null;
}

// drop a session whose account is gone or deactivated, so the request carries on signed out
function endSession(req: Request) {
  return new Promise<void>((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

// checks the signed in account on every request that needs it
export const loadSessionUser: RequestHandler = async (req, res, next) => {
  const { role, patientId, employeeId } = req.session;
  if (!role || NO_USER_PATHS.some((path) => req.path === path || req.path.startsWith(`${path}/`))) return next();

  const user = role === "patient" ? await findPatient(patientId) : await findEmployee(employeeId);
  if (!user) {
    await endSession(req);
    res.clearCookie("connect.sid", { path: "/" });
    return next();
  }

  // the database decides the role, so a changed employee type takes effect on the next request
  if (req.session.role !== user.role) req.session.role = user.role;
  req.user = user;
  next();
};

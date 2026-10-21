import { pool } from "./db.js";
import { HttpError } from "../middleware/errorHandler.js";

// What kind of staff member an employee is. Nurses are anyone with a row
// in the `nurse` table; receptionists are identified by their employee
// type name (same idea as the "admin%" check in routes/auth.ts).
//
// Used by the staff login (so the frontend can show the right sidebar)
// and by routes that only one kind of staff may call.
export const STAFF_TYPE_SQL = `
  CASE
    WHEN EXISTS (SELECT 1 FROM nurse n WHERE n.employee_id = e.employee_id) THEN 'nurse'
    WHEN t.type_name ILIKE 'reception%' THEN 'receptionist'
    ELSE 'other'
  END
`;

export type StaffType = "nurse" | "receptionist" | "other";

// Throws 403 unless `employeeId` is an active employee of the given type.
// Returns the employee's office, since staff actions are scoped to it.
export async function requireStaffType(employeeId: number, staffType: StaffType, action: string) {
  const result = await pool.query(
    `
    SELECT ${STAFF_TYPE_SQL} AS "staffType", e.office_id AS "officeId"
    FROM employee e
    JOIN employee_types t ON t.employee_type_id = e.employee_type_id
    WHERE e.employee_id = $1 AND e.is_active
    `,
    [employeeId]
  );

  const staff = result.rows[0];
  if (staff?.staffType !== staffType) {
    throw new HttpError(403, `Only ${staffType}s can ${action}`);
  }
  return { officeId: staff.officeId as number };
}

import { pool } from "../lib/db.js";
import { hashPassword } from "../lib/password.js";

// Usage: npm run set-staff-password -- <employeeId> <password>
const [employeeIdArg, password] = process.argv.slice(2);
const employeeId = Number(employeeIdArg);

if (!Number.isInteger(employeeId) || !password) {
  console.error("Usage: npm run set-staff-password -- <employeeId> <password>");
  process.exit(1);
}

const employee = await pool.query(`SELECT email FROM employee WHERE employee_id = $1`, [employeeId]);
if (!employee.rowCount) {
  console.error(`No employee with ID ${employeeId}`);
  process.exit(1);
}

const passwordHash = await hashPassword(password);

await pool.query(
  `
  INSERT INTO employee_creds (employee_id, username, password_hash)
  VALUES ($1, $2, $3)
  ON CONFLICT (employee_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true
  `,
  [employeeId, employee.rows[0].email, passwordHash]
);

console.log(`Password set for employee ${employeeId}`);
await pool.end();

import type { PoolClient } from "pg";

// patient logins and employees save their email under one lock, so two accounts can't take the same email at once
export async function lockLoginEmail(client: PoolClient, email: string) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('login email'), hashtext($1))`, [email]);
}

// any employee counts, active or not, since they can be reactivated or given a login later
// a patient who already has this email keeps it, so an old clash never blocks an unchanged save
export async function employeeUsesEmail(client: PoolClient, email: string, patientId = 0) {
  const result = await client.query(
    `
    SELECT 1 FROM employee
    WHERE lower(btrim(email)) = $1
      AND NOT EXISTS (SELECT 1 FROM patient_creds WHERE patient_id = $2 AND lower(btrim(username)) = $1)
    `,
    [email, patientId]
  );
  return !!result.rowCount;
}

// the same check from the employee side, against every patient login
export async function patientLoginUsesEmail(client: PoolClient, email: string, employeeId = 0) {
  const result = await client.query(
    `
    SELECT 1 FROM patient_creds
    WHERE lower(btrim(username)) = $1
      AND NOT EXISTS (SELECT 1 FROM employee WHERE employee_id = $2 AND lower(btrim(email)) = $1)
    `,
    [email, employeeId]
  );
  return !!result.rowCount;
}

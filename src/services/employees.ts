import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CLINIC_TODAY } from "../lib/clinicTime.js";
import { pool } from "../lib/db.js";
import { hashPassword } from "../lib/password.js";
import { withTransaction } from "../lib/transaction.js";
import { HttpError } from "../middleware/errorHandler.js";

// required text with readable error messages
const text = (label: string, max: number) =>
  z.string().trim().min(1, `${label} is required`).max(max, `${label} must be ${max} characters or less`);

const date = (label: string) => z.iso.date(`${label} must be a valid date`);

const licenseFields = {
  licenseNumber: text("License number", 50),
  licenseState: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "License state must be a 2-letter code"),
  licenseExpiration: date("License expiration"),
};

export const doctorLicenseSchema = z.object({
  ...licenseFields,
  npiNumber: z.string().trim().regex(/^\d{10}$/, "NPI number must be 10 digits"),
  deaNumber: z.string().trim().max(20, "DEA number must be 20 characters or less").nullish(),
});

const doctorSchema = doctorLicenseSchema
  .extend({
    specialtyIds: z.array(z.number().int().positive()).min(1, "Select at least one specialty"),
    primarySpecialtyId: z.number().int().positive("Select a primary specialty"),
  })
  .refine((d) => d.specialtyIds.includes(d.primarySpecialtyId), { message: "Primary specialty must be one of the selected specialties" });

// allowed values match chk_nurse_level
export const nurseSchema = z.object({ ...licenseFields, nursingLevel: z.enum(["RN", "LPN", "NP", "CNA"], "Select a nursing level") });

export const employeeSchema = z.object({
  firstName: text("First name", 50),
  lastName: text("Last name", 50),
  dob: date("Date of birth").refine((d) => d < new Date().toISOString().slice(0, 10), "Date of birth must be in the past"),
  email: z.email("Enter a valid email").trim().toLowerCase().max(100, "Email must be 100 characters or less"),
  phone: z.string("Phone is required").trim().regex(/^\d{10}$/, "Phone must be exactly 10 digits"),
  employeeTypeId: z.number("Select a role").int().positive(),
  officeId: z.number("Select an office").int().positive(),
  doctor: doctorSchema.nullish(),
  nurse: nurseSchema.nullish(),
});

export const passwordSchema = z.string().min(8, "Password must be at least 8 characters").max(128, "Password must be 128 characters or less");

export const loginSchema = z.object({ username: text("Username", 50), password: passwordSchema });

export const newEmployeeSchema = employeeSchema.extend({ login: loginSchema.nullish() });

export type EmployeeInput = z.infer<typeof employeeSchema>;
export type NewEmployee = z.infer<typeof newEmployeeSchema>;
type RoleKind = "doctor" | "nurse" | "other";

export async function listEmployees(filter: { status?: "active" | "inactive" | "all"; employeeType?: string } = {}) {
  const result = await pool.query(
    `
    SELECT
      e.employee_id AS "employeeId",
      e.first_name AS "firstName",
      e.last_name AS "lastName",
      e.employee_type_id AS "employeeTypeId",
      t.type_name AS "employeeType",
      COALESCE(
        (SELECT s.name FROM doctor_specialty ds JOIN specialty s ON s.specialty_id = ds.specialty_id
         WHERE ds.doctor_id = e.employee_id AND ds.is_primary AND ds.is_active LIMIT 1),
        n.nursing_level
      ) AS "roleDetail",
      e.email,
      e.phone,
      e.office_id AS "officeId",
      o.name AS "officeName",
      e.is_active AS "isActive",
      c.employee_id IS NOT NULL AS "hasLogin",
      c.is_active AS "loginActive"
    FROM employee e
    JOIN employee_types t ON t.employee_type_id = e.employee_type_id
    JOIN office o ON o.office_id = e.office_id
    LEFT JOIN nurse n ON n.employee_id = e.employee_id
    LEFT JOIN employee_creds c ON c.employee_id = e.employee_id
    WHERE ($1 = 'all' OR e.is_active = ($1 = 'active'))
      AND ($2 = 'all' OR t.type_name = $2)
    ORDER BY e.employee_id
    `,
    [filter.status ?? "all", filter.employeeType ?? "all"]
  );
  return result.rows;
}

// one employee with doctor or nurse details, or null if not found
export async function getEmployee(employeeId: number, db: Pool | PoolClient = pool) {
  const employee = await db.query(
    `
    SELECT
      e.employee_id AS "employeeId",
      e.first_name AS "firstName",
      e.last_name AS "lastName",
      to_char(e.dob, 'YYYY-MM-DD') AS dob,
      e.email,
      e.phone,
      e.employee_type_id AS "employeeTypeId",
      t.type_name AS "employeeType",
      e.office_id AS "officeId",
      o.name AS "officeName",
      e.is_active AS "isActive",
      c.employee_id IS NOT NULL AS "hasLogin",
      c.is_active AS "loginActive",
      to_char(c.created_date, 'YYYY-MM-DD') AS "loginCreatedDate"
    FROM employee e
    JOIN employee_types t ON t.employee_type_id = e.employee_type_id
    JOIN office o ON o.office_id = e.office_id
    LEFT JOIN employee_creds c ON c.employee_id = e.employee_id
    WHERE e.employee_id = $1
    `,
    [employeeId]
  );
  if (!employee.rowCount) return null;

  const doctor = await db.query(
    `
    SELECT
      license_number AS "licenseNumber",
      license_issuing_state AS "licenseState",
      to_char(license_expiration_date, 'YYYY-MM-DD') AS "licenseExpiration",
      npi_number AS "npiNumber",
      dea_number AS "deaNumber"
    FROM doctor
    WHERE employee_id = $1
    `,
    [employeeId]
  );

  const specialties = await db.query(
    `
    SELECT s.specialty_id AS "specialtyId", s.name, ds.is_primary AS "isPrimary"
    FROM doctor_specialty ds
    JOIN specialty s ON s.specialty_id = ds.specialty_id
    WHERE ds.doctor_id = $1 AND ds.is_active
    ORDER BY ds.is_primary DESC, s.name
    `,
    [employeeId]
  );

  const nurse = await db.query(
    `
    SELECT
      nursing_license_number AS "licenseNumber",
      license_issuing_state AS "licenseState",
      to_char(license_expiration_date, 'YYYY-MM-DD') AS "licenseExpiration",
      nursing_level AS "nursingLevel"
    FROM nurse
    WHERE employee_id = $1
    `,
    [employeeId]
  );

  return {
    ...employee.rows[0],
    doctor: doctor.rows[0] ? { ...doctor.rows[0], specialties: specialties.rows } : null,
    nurse: nurse.rows[0] ?? null,
  };
}

const UNIQUE_MESSAGES: Record<string, string> = {
  employee_creds_username_key: "That username is already taken",
  employee_creds_employee_id_key: "This employee already has a login account",
  doctor_license_number_key: "Another doctor already has that license number",
  doctor_npi_number_key: "Another doctor already has that NPI number",
  doctor_dea_number_key: "Another doctor already has that DEA number",
  nurse_nursing_license_number_key: "Another nurse already has that license number",
};

// readable messages for database errors, without exposing raw details
function saveError(err: unknown) {
  if (err instanceof HttpError) return err;
  const { code, constraint } = err as { code?: string; constraint?: string };
  if (!code) return err;
  if (constraint && UNIQUE_MESSAGES[constraint]) return new HttpError(409, UNIQUE_MESSAGES[constraint]);
  if (code === "23505") return new HttpError(409, "This conflicts with an existing record");
  if (code === "23503" || code === "23514" || code === "22001") return new HttpError(400, "Some of the submitted values are not valid");
  console.error(err);
  return new HttpError(500, "Could not save the employee");
}

const inTransaction = <T>(work: (client: PoolClient) => Promise<T>) =>
  withTransaction(work).catch((err) => {
    throw saveError(err);
  });

// doctor and nurse types need their own license records
async function getRoleKind(client: PoolClient, employeeTypeId: number, currentTypeId: number | null): Promise<RoleKind> {
  const result = await client.query(
    `SELECT LOWER(type_name) AS name FROM employee_types WHERE employee_type_id = $1 AND (is_active OR employee_type_id = $2)`,
    [employeeTypeId, currentTypeId]
  );
  if (!result.rowCount) throw new HttpError(400, "Selected role does not exist");
  const { name } = result.rows[0];
  return name === "doctor" || name === "nurse" ? name : "other";
}

// the email column isn't unique, so two saves of the same email wait for each other here
async function lockEmail(client: PoolClient, email: string) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('employee email'), hashtext($1))`, [email]);
}

// checks for the fields that were sent, so a partial update only checks what it changes
async function validateEmployee(client: PoolClient, employeeId: number | null, input: Partial<EmployeeInput>, kind: RoleKind, currentOfficeId: number | null) {
  const creating = employeeId === null;
  if (kind === "doctor" && (input.doctor === null || (creating && !input.doctor))) throw new HttpError(400, "Doctor license details are required");
  if (kind === "nurse" && (input.nurse === null || (creating && !input.nurse))) throw new HttpError(400, "Nurse license details are required");
  if (kind !== "doctor" && input.doctor) throw new HttpError(400, "Only doctors can have doctor details");
  if (kind !== "nurse" && input.nurse) throw new HttpError(400, "Only nurses can have nurse details");

  if (input.officeId !== undefined) {
    const office = await client.query(`SELECT 1 FROM office WHERE office_id = $1 AND (is_active OR office_id = $2)`, [input.officeId, currentOfficeId]);
    if (!office.rowCount) throw new HttpError(400, "Selected office does not exist");
  }

  const otherId = employeeId ?? 0;
  if (input.email !== undefined) {
    const email = await client.query(`SELECT 1 FROM employee WHERE LOWER(email) = $1 AND employee_id <> $2`, [input.email, otherId]);
    if (email.rowCount) throw new HttpError(409, "Another employee already uses that email");
  }

  if (input.doctor) {
    const { licenseNumber, npiNumber, specialtyIds } = input.doctor;
    const license = await client.query(`SELECT 1 FROM doctor WHERE LOWER(license_number) = LOWER($1) AND employee_id <> $2`, [licenseNumber, otherId]);
    if (license.rowCount) throw new HttpError(409, "Another doctor already has that license number");

    const npi = await client.query(`SELECT 1 FROM doctor WHERE npi_number = $1 AND employee_id <> $2`, [npiNumber, otherId]);
    if (npi.rowCount) throw new HttpError(409, "Another doctor already has that NPI number");

    // active specialties, or ones this doctor already has
    const specialties = await client.query(
      `
      SELECT COUNT(*)::int AS count
      FROM specialty s
      WHERE s.specialty_id = ANY($1::int[])
        AND (s.is_active OR EXISTS (
          SELECT 1 FROM doctor_specialty ds
          WHERE ds.doctor_id = $2 AND ds.specialty_id = s.specialty_id AND ds.is_active
        ))
      `,
      [specialtyIds, otherId]
    );
    if (specialties.rows[0].count !== new Set(specialtyIds).size) throw new HttpError(400, "Selected specialty does not exist");
  }

  if (input.nurse) {
    const license = await client.query(`SELECT 1 FROM nurse WHERE LOWER(nursing_license_number) = LOWER($1) AND employee_id <> $2`, [
      input.nurse.licenseNumber,
      otherId,
    ]);
    if (license.rowCount) throw new HttpError(409, "Another nurse already has that license number");
  }
}

async function checkUsername(client: PoolClient, username: string) {
  const result = await client.query(`SELECT 1 FROM employee_creds WHERE LOWER(username) = LOWER($1)`, [username]);
  if (result.rowCount) throw new HttpError(409, "That username is already taken");
}

// insert or update the doctor row and its specialties
async function saveDoctor(client: PoolClient, employeeId: number, doctor: NonNullable<EmployeeInput["doctor"]>) {
  await client.query(
    `
    INSERT INTO doctor (employee_id, license_number, license_issuing_state, license_expiration_date, npi_number, dea_number)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (employee_id) DO UPDATE SET
      license_number = EXCLUDED.license_number,
      license_issuing_state = EXCLUDED.license_issuing_state,
      license_expiration_date = EXCLUDED.license_expiration_date,
      npi_number = EXCLUDED.npi_number,
      dea_number = EXCLUDED.dea_number
    `,
    [employeeId, doctor.licenseNumber, doctor.licenseState, doctor.licenseExpiration, doctor.npiNumber, doctor.deaNumber || null]
  );

  // removed specialties are deactivated, not deleted, since appointments and schedules reference them
  await client.query(`UPDATE doctor_specialty SET is_active = false, is_primary = false WHERE doctor_id = $1 AND NOT (specialty_id = ANY($2::int[]))`, [
    employeeId,
    doctor.specialtyIds,
  ]);
  await client.query(
    `
    INSERT INTO doctor_specialty (doctor_id, specialty_id, is_primary)
    SELECT $1, id, id = $3 FROM unnest($2::int[]) AS id
    ON CONFLICT (doctor_id, specialty_id) DO UPDATE SET is_active = true, is_primary = EXCLUDED.is_primary
    `,
    [employeeId, [...new Set(doctor.specialtyIds)], doctor.primarySpecialtyId]
  );
}

// insert or update the nurse row
async function saveNurse(client: PoolClient, employeeId: number, nurse: NonNullable<EmployeeInput["nurse"]>) {
  await client.query(
    `
    INSERT INTO nurse (employee_id, nursing_license_number, license_issuing_state, license_expiration_date, nursing_level)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (employee_id) DO UPDATE SET
      nursing_license_number = EXCLUDED.nursing_license_number,
      license_issuing_state = EXCLUDED.license_issuing_state,
      license_expiration_date = EXCLUDED.license_expiration_date,
      nursing_level = EXCLUDED.nursing_level
    `,
    [employeeId, nurse.licenseNumber, nurse.licenseState, nurse.licenseExpiration, nurse.nursingLevel]
  );
}

// the employee, their login, and their doctor or nurse record are saved together or not at all
export async function createEmployee(input: NewEmployee) {
  const passwordHash = input.login ? await hashPassword(input.login.password) : null;

  const employeeId = await inTransaction(async (client) => {
    await lockEmail(client, input.email);
    const kind = await getRoleKind(client, input.employeeTypeId, null);
    await validateEmployee(client, null, input, kind, null);
    if (input.login) await checkUsername(client, input.login.username);

    const created = await client.query(
      `
      INSERT INTO employee (first_name, last_name, dob, employee_type_id, phone, email, office_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING employee_id AS "employeeId"
      `,
      [input.firstName, input.lastName, input.dob, input.employeeTypeId, input.phone, input.email, input.officeId]
    );
    const newId: number = created.rows[0].employeeId;

    if (input.login) {
      await client.query(`INSERT INTO employee_creds (employee_id, username, password_hash) VALUES ($1, $2, $3)`, [newId, input.login.username, passwordHash]);
    }
    if (input.doctor) await saveDoctor(client, newId, input.doctor);
    if (input.nurse) await saveNurse(client, newId, input.nurse);
    return newId;
  });

  return getEmployee(employeeId);
}

// only the fields that were sent change, and login and active status are managed separately
export async function updateEmployee(employeeId: number, changes: Partial<EmployeeInput>) {
  await inTransaction(async (client) => {
    if (changes.email !== undefined) await lockEmail(client, changes.email);
    // booking locks this row too, so a booking in progress finishes before a specialty is removed
    const current = await client.query(
      `
      SELECT
        e.employee_type_id AS "employeeTypeId",
        e.office_id AS "officeId",
        EXISTS (SELECT 1 FROM doctor d WHERE d.employee_id = e.employee_id) AS "isDoctor",
        EXISTS (SELECT 1 FROM nurse n WHERE n.employee_id = e.employee_id) AS "isNurse"
      FROM employee e
      WHERE e.employee_id = $1
      FOR NO KEY UPDATE
      `,
      [employeeId]
    );
    if (!current.rowCount) throw new HttpError(404, "Employee not found");
    const { employeeTypeId, officeId, isDoctor, isNurse } = current.rows[0];

    const newTypeId = changes.employeeTypeId ?? employeeTypeId;
    const kind = await getRoleKind(client, newTypeId, employeeTypeId);

    // doctor and nurse records are linked to appointments, schedules, and licenses
    if (newTypeId !== employeeTypeId) {
      const currentKind = await getRoleKind(client, employeeTypeId, employeeTypeId);
      if (isDoctor || isNurse || currentKind !== "other" || kind !== "other") {
        throw new HttpError(409, "Changing a role to or from Doctor or Nurse is not supported yet");
      }
    }

    await validateEmployee(client, employeeId, changes, kind, officeId);

    if (changes.doctor) {
      const scheduled = await client.query(
        `
        SELECT s.name
        FROM doctor_schedule ds
        JOIN specialty s ON s.specialty_id = ds.specialty_id
        WHERE ds.doctor_id = $1 AND ds.is_active AND NOT (ds.specialty_id = ANY($2::int[]))
        LIMIT 1
        `,
        [employeeId, changes.doctor.specialtyIds]
      );
      if (scheduled.rowCount) throw new HttpError(409, `${scheduled.rows[0].name} is used in this doctor's active schedule and can't be removed`);

      const booked = await client.query(
        `
        SELECT s.name
        FROM appointment a
        JOIN specialty s ON s.specialty_id = a.specialty_id
        WHERE a.doctor_id = $1 AND a.status = 'Scheduled' AND a.appointment_date >= ${CLINIC_TODAY} AND NOT (a.specialty_id = ANY($2::int[]))
        LIMIT 1
        `,
        [employeeId, changes.doctor.specialtyIds]
      );
      if (booked.rowCount) {
        throw new HttpError(409, `${booked.rows[0].name} has upcoming appointments with this doctor and can't be removed. Reschedule or cancel them first.`);
      }
    }

    await client.query(
      `
      UPDATE employee SET
        first_name = COALESCE($2, first_name),
        last_name = COALESCE($3, last_name),
        dob = COALESCE($4, dob),
        employee_type_id = $5,
        phone = COALESCE($6, phone),
        email = COALESCE($7, email),
        office_id = COALESCE($8, office_id)
      WHERE employee_id = $1
      `,
      [employeeId, changes.firstName ?? null, changes.lastName ?? null, changes.dob ?? null, newTypeId, changes.phone ?? null, changes.email ?? null, changes.officeId ?? null]
    );

    if (changes.doctor) await saveDoctor(client, employeeId, changes.doctor);
    if (changes.nurse) await saveNurse(client, employeeId, changes.nurse);
  });

  return getEmployee(employeeId);
}

// the login is left as it is, and the session check refuses an inactive employee on their next request
export async function setEmployeeStatus(employeeId: number, isActive: boolean, adminId: number) {
  if (!isActive && employeeId === adminId) throw new HttpError(409, "You can't deactivate your own account");

  await inTransaction(async (client) => {
    // booking locks this row too, so a booking in progress finishes before this decides
    const current = await client.query(
      `
      SELECT e.is_active AS "isActive", o.is_active AS "officeActive", EXISTS (SELECT 1 FROM doctor d WHERE d.employee_id = e.employee_id) AS "isDoctor"
      FROM employee e
      JOIN office o ON o.office_id = e.office_id
      WHERE e.employee_id = $1
      FOR NO KEY UPDATE OF e
      `,
      [employeeId]
    );
    if (!current.rowCount) throw new HttpError(404, "Employee not found");
    const { isActive: wasActive, officeActive, isDoctor } = current.rows[0];
    if (wasActive === isActive) return;

    // nothing is cancelled or moved for the admin, so upcoming visits have to be handled first
    if (!isActive && isDoctor) {
      const upcoming = await client.query(
        `SELECT count(*)::int AS count FROM appointment WHERE doctor_id = $1 AND status = 'Scheduled' AND appointment_date >= ${CLINIC_TODAY}`,
        [employeeId]
      );
      const { count } = upcoming.rows[0];
      if (count) {
        throw new HttpError(409, `${count} upcoming appointment${count === 1 ? " is" : "s are"} booked with this doctor. Reschedule or cancel ${count === 1 ? "it" : "them"} first.`);
      }
    }
    if (isActive && !officeActive) throw new HttpError(409, "Move this employee to an active office before reactivating them");

    await client.query(`UPDATE employee SET is_active = $2 WHERE employee_id = $1`, [employeeId, isActive]);
  });

  return getEmployee(employeeId);
}

// employee active flag and whether a login exists
async function getAccount(db: Pool | PoolClient, employeeId: number) {
  const result = await db.query(
    `
    SELECT e.is_active AS "isActive", c.employee_id IS NOT NULL AS "hasLogin"
    FROM employee e
    LEFT JOIN employee_creds c ON c.employee_id = e.employee_id
    WHERE e.employee_id = $1
    `,
    [employeeId]
  );
  if (!result.rowCount) throw new HttpError(404, "Employee not found");
  return result.rows[0] as { isActive: boolean; hasLogin: boolean };
}

// enable or disable an existing login without changing the password
export async function setLoginStatus(employeeId: number, loginActive: boolean, adminId: number) {
  if (!loginActive && employeeId === adminId) throw new HttpError(409, "You can't disable your own login");
  const account = await getAccount(pool, employeeId);
  if (!account.hasLogin) throw new HttpError(409, "This employee doesn't have a login account");
  if (loginActive && !account.isActive) throw new HttpError(409, "Activate the employee before enabling their login");

  await pool.query(`UPDATE employee_creds SET is_active = $2 WHERE employee_id = $1`, [employeeId, loginActive]);
  return getEmployee(employeeId);
}

// set a new password for an existing login without changing its status
export async function setPassword(employeeId: number, password: string) {
  const account = await getAccount(pool, employeeId);
  if (!account.hasLogin) throw new HttpError(409, "This employee doesn't have a login account");
  await pool.query(`UPDATE employee_creds SET password_hash = $2 WHERE employee_id = $1`, [employeeId, await hashPassword(password)]);
}

// add a login for an employee who doesn't have one
export async function addLogin(employeeId: number, login: z.infer<typeof loginSchema>) {
  const passwordHash = await hashPassword(login.password);
  await inTransaction(async (client) => {
    const account = await getAccount(client, employeeId);
    if (account.hasLogin) throw new HttpError(409, "This employee already has a login account");
    await checkUsername(client, login.username);
    await client.query(`INSERT INTO employee_creds (employee_id, username, password_hash) VALUES ($1, $2, $3)`, [employeeId, login.username, passwordHash]);
  });
  return getEmployee(employeeId);
}

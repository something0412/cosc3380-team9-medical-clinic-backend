import { Router } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { hashPassword } from "../../lib/password.js";
import { HttpError } from "../../middleware/errorHandler.js";

export const adminEmployeesRouter = Router();

const idParam = z.coerce.number().int().positive();

// required text with readable error messages
const text = (label: string, max: number) =>
  z.string().trim().min(1, `${label} is required`).max(max, `${label} must be ${max} characters or less`);

const date = (label: string) => z.iso.date(`${label} must be a valid date`);

const licenseState = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "License state must be a 2-letter code");

const doctorSchema = z
  .object({
    licenseNumber: text("License number", 50),
    licenseState,
    licenseExpiration: date("License expiration"),
    npiNumber: z.string().trim().regex(/^\d{10}$/, "NPI number must be 10 digits"),
    deaNumber: z.string().trim().max(20, "DEA number must be 20 characters or less").nullish(),
    specialtyIds: z.array(z.number().int().positive()).min(1, "Select at least one specialty"),
    primarySpecialtyId: z.number().int().positive("Select a primary specialty"),
  })
  .refine((d) => d.specialtyIds.includes(d.primarySpecialtyId), {
    message: "Primary specialty must be one of the selected specialties",
  });

// allowed values match chk_nurse_level
const nurseSchema = z.object({
  licenseNumber: text("License number", 50),
  licenseState,
  licenseExpiration: date("License expiration"),
  nursingLevel: z.enum(["RN", "LPN", "NP", "CNA"], "Select a nursing level"),
});

const employeeFields = {
  firstName: text("First name", 50),
  lastName: text("Last name", 50),
  dob: date("Date of birth").refine((d) => d < new Date().toISOString().slice(0, 10), "Date of birth must be in the past"),
  email: z.email("Enter a valid email").trim().toLowerCase().max(100, "Email must be 100 characters or less"),
  phone: text("Phone", 20),
  employeeTypeId: z.number("Select a role").int().positive(),
  officeId: z.number("Select an office").int().positive(),
  doctor: doctorSchema.nullish(),
  nurse: nurseSchema.nullish(),
};

const passwordSchema = z.string().min(8, "Password must be at least 8 characters").max(128, "Password must be 128 characters or less");

const loginSchema = z.object({ username: text("Username", 50), password: passwordSchema });

const createSchema = z.object({ ...employeeFields, login: loginSchema.nullish() });

const updateSchema = z.object(employeeFields);

type EmployeeInput = z.infer<typeof updateSchema>;
type RoleKind = "doctor" | "nurse" | "other";

// one employee with doctor or nurse details, or null if not found
async function loadEmployee(employeeId: number) {
  const employee = await pool.query(
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

  const doctor = await pool.query(
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

  const specialties = await pool.query(
    `
    SELECT s.specialty_id AS "specialtyId", s.name, ds.is_primary AS "isPrimary"
    FROM doctor_specialty ds
    JOIN specialty s ON s.specialty_id = ds.specialty_id
    WHERE ds.doctor_id = $1 AND ds.is_active
    ORDER BY ds.is_primary DESC, s.name
    `,
    [employeeId]
  );

  const nurse = await pool.query(
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

// readable messages for database errors, without exposing raw details
function saveError(err: unknown) {
  if (err instanceof HttpError) return err;
  const { code, constraint } = err as { code?: string; constraint?: string };
  if (!code) return err;
  if (constraint === "employee_creds_username_key") return new HttpError(409, "That username is already taken");
  if (constraint === "employee_creds_employee_id_key") return new HttpError(409, "This employee already has a login account");
  if (code === "23505") return new HttpError(409, "This conflicts with an existing record");
  if (code === "23503" || code === "23514" || code === "22001") return new HttpError(400, "Some of the submitted values are not valid");
  console.error(err);
  return new HttpError(500, "Could not save the employee");
}

// run all steps on one client and roll back if any step fails
async function inTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw saveError(err);
  } finally {
    client.release();
  }
}

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

// checks that don't depend on whether the employee is new
async function validateEmployee(
  client: PoolClient,
  employeeId: number | null,
  body: EmployeeInput,
  kind: RoleKind,
  currentOfficeId: number | null
) {
  if (kind === "doctor" && !body.doctor) throw new HttpError(400, "Doctor license details are required");
  if (kind === "nurse" && !body.nurse) throw new HttpError(400, "Nurse license details are required");

  const office = await client.query(`SELECT 1 FROM office WHERE office_id = $1 AND (is_active OR office_id = $2)`, [
    body.officeId,
    currentOfficeId,
  ]);
  if (!office.rowCount) throw new HttpError(400, "Selected office does not exist");

  const otherId = employeeId ?? 0;

  const email = await client.query(`SELECT 1 FROM employee WHERE LOWER(email) = $1 AND employee_id <> $2`, [body.email, otherId]);
  if (email.rowCount) throw new HttpError(409, "Another employee already uses that email");

  if (kind === "doctor" && body.doctor) {
    const { licenseNumber, npiNumber, specialtyIds } = body.doctor;

    const license = await client.query(
      `SELECT 1 FROM doctor WHERE LOWER(license_number) = LOWER($1) AND employee_id <> $2`,
      [licenseNumber, otherId]
    );
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

  if (kind === "nurse" && body.nurse) {
    const license = await client.query(
      `SELECT 1 FROM nurse WHERE LOWER(nursing_license_number) = LOWER($1) AND employee_id <> $2`,
      [body.nurse.licenseNumber, otherId]
    );
    if (license.rowCount) throw new HttpError(409, "Another nurse already has that license number");
  }
}

async function checkUsername(client: PoolClient, username: string) {
  const result = await client.query(`SELECT 1 FROM employee_creds WHERE LOWER(username) = LOWER($1)`, [username]);
  if (result.rowCount) throw new HttpError(409, "That username is already taken");
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
  await client.query(
    `UPDATE doctor_specialty SET is_active = false, is_primary = false WHERE doctor_id = $1 AND NOT (specialty_id = ANY($2::int[]))`,
    [employeeId, doctor.specialtyIds]
  );
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

adminEmployeesRouter.get("/", async (_req, res) => {
  const result = await pool.query(`
    SELECT
      e.employee_id AS "employeeId",
      e.first_name AS "firstName",
      e.last_name AS "lastName",
      e.employee_type_id AS "employeeTypeId",
      t.type_name AS "employeeType",
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
    LEFT JOIN employee_creds c ON c.employee_id = e.employee_id
    ORDER BY e.employee_id
  `);

  res.json(result.rows);
});

adminEmployeesRouter.get("/:id", async (req, res) => {
  const employee = await loadEmployee(idParam.parse(req.params.id));
  if (!employee) throw new HttpError(404, "Employee not found");
  res.json(employee);
});

// create an employee with optional login and doctor/nurse details
adminEmployeesRouter.post("/", async (req, res) => {
  const body = createSchema.parse(req.body);
  const passwordHash = body.login ? await hashPassword(body.login.password) : null;

  const employeeId = await inTransaction(async (client) => {
    const kind = await getRoleKind(client, body.employeeTypeId, null);
    await validateEmployee(client, null, body, kind, null);

    if (body.login) await checkUsername(client, body.login.username);

    const created = await client.query(
      `
      INSERT INTO employee (first_name, last_name, dob, employee_type_id, phone, email, office_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING employee_id AS "employeeId"
      `,
      [body.firstName, body.lastName, body.dob, body.employeeTypeId, body.phone, body.email, body.officeId]
    );
    const newId: number = created.rows[0].employeeId;

    if (body.login) {
      await client.query(`INSERT INTO employee_creds (employee_id, username, password_hash) VALUES ($1, $2, $3)`, [
        newId,
        body.login.username,
        passwordHash,
      ]);
    }
    if (kind === "doctor" && body.doctor) await saveDoctor(client, newId, body.doctor);
    if (kind === "nurse" && body.nurse) await saveNurse(client, newId, body.nurse);

    return newId;
  });

  res.status(201).json(await loadEmployee(employeeId));
});

// update employee info. Login and active status are managed separately
adminEmployeesRouter.put("/:id", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const body = updateSchema.parse(req.body);

  await inTransaction(async (client) => {
    const current = await client.query(
      `
      SELECT
        e.employee_type_id AS "employeeTypeId",
        e.office_id AS "officeId",
        EXISTS (SELECT 1 FROM doctor d WHERE d.employee_id = e.employee_id) AS "isDoctor",
        EXISTS (SELECT 1 FROM nurse n WHERE n.employee_id = e.employee_id) AS "isNurse"
      FROM employee e
      WHERE e.employee_id = $1
      FOR UPDATE
      `,
      [employeeId]
    );
    if (!current.rowCount) throw new HttpError(404, "Employee not found");
    const { employeeTypeId, officeId, isDoctor, isNurse } = current.rows[0];

    const kind = await getRoleKind(client, body.employeeTypeId, employeeTypeId);

    // doctor and nurse records are linked to appointments, schedules, and licenses
    if (body.employeeTypeId !== employeeTypeId) {
      const currentKind = await getRoleKind(client, employeeTypeId, employeeTypeId);
      if (isDoctor || isNurse || currentKind !== "other" || kind !== "other") {
        throw new HttpError(409, "Changing a role to or from Doctor or Nurse is not supported yet");
      }
    }

    await validateEmployee(client, employeeId, body, kind, officeId);

    if (kind === "doctor" && body.doctor) {
      const scheduled = await client.query(
        `
        SELECT s.name
        FROM doctor_schedule ds
        JOIN specialty s ON s.specialty_id = ds.specialty_id
        WHERE ds.doctor_id = $1 AND ds.is_active AND NOT (ds.specialty_id = ANY($2::int[]))
        LIMIT 1
        `,
        [employeeId, body.doctor.specialtyIds]
      );
      if (scheduled.rowCount) {
        throw new HttpError(409, `${scheduled.rows[0].name} is used in this doctor's active schedule and can't be removed`);
      }
    }

    await client.query(
      `
      UPDATE employee
      SET first_name = $2, last_name = $3, dob = $4, employee_type_id = $5, phone = $6, email = $7, office_id = $8
      WHERE employee_id = $1
      `,
      [employeeId, body.firstName, body.lastName, body.dob, body.employeeTypeId, body.phone, body.email, body.officeId]
    );

    if (kind === "doctor" && body.doctor) await saveDoctor(client, employeeId, body.doctor);
    if (kind === "nurse" && body.nurse) await saveNurse(client, employeeId, body.nurse);
  });

  res.json(await loadEmployee(employeeId));
});

// activate or deactivate an employee and leave their login record as is
adminEmployeesRouter.patch("/:id/status", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const { isActive } = z.object({ isActive: z.boolean("Status must be true or false") }).parse(req.body);
  if (!isActive && employeeId === req.session.employeeId) throw new HttpError(409, "You can't deactivate your own account");

  const result = await pool.query(`UPDATE employee SET is_active = $2 WHERE employee_id = $1`, [employeeId, isActive]);
  if (!result.rowCount) throw new HttpError(404, "Employee not found");

  res.json(await loadEmployee(employeeId));
});

// enable or disable an existing login without changing the password
adminEmployeesRouter.patch("/:id/login-status", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const { loginActive } = z.object({ loginActive: z.boolean("Login status must be true or false") }).parse(req.body);
  if (!loginActive && employeeId === req.session.employeeId) throw new HttpError(409, "You can't disable your own login");

  const account = await getAccount(pool, employeeId);
  if (!account.hasLogin) throw new HttpError(409, "This employee doesn't have a login account");
  if (loginActive && !account.isActive) throw new HttpError(409, "Activate the employee before enabling their login");

  await pool.query(`UPDATE employee_creds SET is_active = $2 WHERE employee_id = $1`, [employeeId, loginActive]);
  res.json(await loadEmployee(employeeId));
});

// set a new password for an existing login without changing its status
adminEmployeesRouter.put("/:id/password", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const { password } = z.object({ password: passwordSchema }).parse(req.body);

  const account = await getAccount(pool, employeeId);
  if (!account.hasLogin) throw new HttpError(409, "This employee doesn't have a login account");

  const passwordHash = await hashPassword(password);
  await pool.query(`UPDATE employee_creds SET password_hash = $2 WHERE employee_id = $1`, [employeeId, passwordHash]);
  res.status(204).end();
});

// add a login for an employee who doesn't have one
adminEmployeesRouter.post("/:id/login", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const login = loginSchema.parse(req.body);
  const passwordHash = await hashPassword(login.password);

  await inTransaction(async (client) => {
    const account = await getAccount(client, employeeId);
    if (account.hasLogin) throw new HttpError(409, "This employee already has a login account");
    await checkUsername(client, login.username);

    await client.query(`INSERT INTO employee_creds (employee_id, username, password_hash) VALUES ($1, $2, $3)`, [
      employeeId,
      login.username,
      passwordHash,
    ]);
  });

  res.status(201).json(await loadEmployee(employeeId));
});

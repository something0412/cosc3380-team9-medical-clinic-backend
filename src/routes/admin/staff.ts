import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { hashPassword } from "../../lib/password.js";
import { HttpError } from "../../middleware/errorHandler.js";

export const adminStaffRouter = Router();

const idParam = z.coerce.number().int().positive();

const listQuery = z.object({
  status: z.enum(["active", "inactive", "all"]).default("active"),
  role: z.string().trim().default("all"),
});

const staffSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  phone: z.string().trim().min(1),
  email: z.email().trim().toLowerCase(),
  officeId: z.coerce.number().int().positive(),
});

const licenseSchema = z.object({
  licenseNumber: z.string().trim().min(1),
  licenseState: z.string().trim().length(2).toUpperCase(),
  licenseExpiration: z.iso.date(),
});

const newStaffSchema = staffSchema.extend({
  dob: z.iso.date(),
  employeeTypeId: z.coerce.number().int().positive(),
  password: z.string().min(8),
  doctor: licenseSchema
    .extend({
      npiNumber: z.string().trim().regex(/^\d{10}$/, "NPI number must be 10 digits"),
      deaNumber: z.string().trim().toUpperCase().nullable(),
      specialtyId: z.coerce.number().int().positive(),
    })
    .nullable(),
  nurse: licenseSchema.extend({ nursingLevel: z.enum(["RN", "LPN", "NP", "CNA"]) }).nullable(),
});

const statusSchema = z.object({ isActive: z.boolean() });

const UNIQUE_MESSAGES: Record<string, string> = {
  employee_creds_username_key: "This email is already used by another staff account",
  doctor_license_number_key: "This medical license number is already registered",
  doctor_npi_number_key: "This NPI number is already registered",
  doctor_dea_number_key: "This DEA number is already registered",
  nurse_nursing_license_number_key: "This nursing license number is already registered",
};

adminStaffRouter.get("/", async (req, res) => {
  const { status, role } = listQuery.parse(req.query);

  const result = await pool.query(
    `
    SELECT
      e.employee_id AS "employeeId",
      e.first_name AS "firstName",
      e.last_name AS "lastName",
      t.type_name AS role,
      COALESCE(s.name, n.nursing_level) AS "roleDetail",
      o.office_id AS "officeId",
      o.name AS "officeName",
      e.phone,
      e.email,
      e.is_active AS "isActive"
    FROM employee e
    JOIN employee_types t ON t.employee_type_id = e.employee_type_id
    JOIN office o ON o.office_id = e.office_id
    LEFT JOIN doctor_specialty ds ON ds.doctor_id = e.employee_id AND ds.is_primary AND ds.is_active
    LEFT JOIN specialty s ON s.specialty_id = ds.specialty_id
    LEFT JOIN nurse n ON n.employee_id = e.employee_id
    WHERE ($1 = 'all' OR e.is_active = ($1 = 'active'))
      AND ($2 = 'all' OR t.type_name = $2)
    ORDER BY t.type_name, e.last_name, e.first_name
    `,
    [status, role]
  );

  res.json(result.rows);
});

// roles, offices, and specialties for the staff form
adminStaffRouter.get("/options", async (_req, res) => {
  const roles = await pool.query(`
    SELECT employee_type_id AS "employeeTypeId", type_name AS name
    FROM employee_types
    WHERE is_active
    ORDER BY type_name
  `);

  const offices = await pool.query(`
    SELECT office_id AS "officeId", name
    FROM office
    WHERE is_active
    ORDER BY name
  `);

  const specialties = await pool.query(`
    SELECT specialty_id AS "specialtyId", name
    FROM specialty
    WHERE is_active
    ORDER BY name
  `);

  res.json({ roles: roles.rows, offices: offices.rows, specialties: specialties.rows });
});

adminStaffRouter.post("/", async (req, res) => {
  const body = newStaffSchema.parse(req.body);
  const passwordHash = await hashPassword(body.password);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const role = await client.query(`SELECT type_name FROM employee_types WHERE employee_type_id = $1`, [
      body.employeeTypeId,
    ]);
    if (!role.rowCount) throw new HttpError(400, "Unknown role");
    const roleName = role.rows[0].type_name;
    if (roleName === "Doctor" && !body.doctor) throw new HttpError(400, "Doctor license details are required");
    if (roleName === "Nurse" && !body.nurse) throw new HttpError(400, "Nursing license details are required");

    const employee = await client.query(
      `
      INSERT INTO employee (first_name, last_name, dob, employee_type_id, phone, email, office_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING employee_id AS "employeeId", first_name AS "firstName", last_name AS "lastName", email
      `,
      [body.firstName, body.lastName, body.dob, body.employeeTypeId, body.phone, body.email, body.officeId]
    );
    const employeeId = employee.rows[0].employeeId;

    await client.query(`INSERT INTO employee_creds (employee_id, username, password_hash) VALUES ($1, $2, $3)`, [
      employeeId,
      body.email,
      passwordHash,
    ]);

    if (roleName === "Doctor" && body.doctor) {
      await client.query(
        `
        INSERT INTO doctor (employee_id, license_number, license_issuing_state, license_expiration_date, npi_number, dea_number)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          employeeId,
          body.doctor.licenseNumber,
          body.doctor.licenseState,
          body.doctor.licenseExpiration,
          body.doctor.npiNumber,
          body.doctor.deaNumber || null,
        ]
      );
      await client.query(`INSERT INTO doctor_specialty (doctor_id, specialty_id, is_primary) VALUES ($1, $2, true)`, [
        employeeId,
        body.doctor.specialtyId,
      ]);
    }

    if (roleName === "Nurse" && body.nurse) {
      await client.query(
        `
        INSERT INTO nurse (employee_id, nursing_license_number, license_issuing_state, license_expiration_date, nursing_level)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [employeeId, body.nurse.licenseNumber, body.nurse.licenseState, body.nurse.licenseExpiration, body.nurse.nursingLevel]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(employee.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    // duplicate email or license
    const pgError = err as { code?: string; constraint?: string };
    if (pgError.code === "23505" && pgError.constraint && UNIQUE_MESSAGES[pgError.constraint]) {
      throw new HttpError(409, UNIQUE_MESSAGES[pgError.constraint]);
    }
    throw err;
  } finally {
    client.release();
  }
});

adminStaffRouter.put("/:id", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const body = staffSchema.parse(req.body);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const taken = await client.query(
      `SELECT 1 FROM employee_creds WHERE LOWER(username) = $1 AND employee_id <> $2`,
      [body.email, employeeId]
    );
    if (taken.rowCount) throw new HttpError(409, "This email is already used by another staff account");

    const updated = await client.query(
      `
      UPDATE employee
      SET first_name = $1, last_name = $2, phone = $3, email = $4, office_id = $5
      WHERE employee_id = $6
      RETURNING employee_id AS "employeeId", first_name AS "firstName", last_name AS "lastName", phone, email
      `,
      [body.firstName, body.lastName, body.phone, body.email, body.officeId, employeeId]
    );
    if (!updated.rowCount) throw new HttpError(404, "Staff member not found");

    await client.query(`UPDATE employee_creds SET username = $1 WHERE employee_id = $2`, [body.email, employeeId]);
    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// activate or deactivate an employee and their login
adminStaffRouter.patch("/:id/status", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const { isActive } = statusSchema.parse(req.body);

  if (!isActive && req.session.employeeId === employeeId) {
    throw new HttpError(400, "You can't deactivate your own account");
  }

  const updated = await pool.query(
    `UPDATE employee SET is_active = $1 WHERE employee_id = $2 RETURNING employee_id AS "employeeId", is_active AS "isActive"`,
    [isActive, employeeId]
  );
  if (!updated.rowCount) throw new HttpError(404, "Staff member not found");

  await pool.query(`UPDATE employee_creds SET is_active = $1 WHERE employee_id = $2`, [isActive, employeeId]);
  res.json(updated.rows[0]);
});

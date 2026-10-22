import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";

export const adminEmployeesRouter = Router();

const idParam = z.coerce.number().int().positive();

// employee directory
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

// one employee with doctor or nurse details
adminEmployeesRouter.get("/:id", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);

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
  if (!employee.rowCount) throw new HttpError(404, "Employee not found");

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
    SELECT s.name, ds.is_primary AS "isPrimary"
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

  res.json({
    ...employee.rows[0],
    doctor: doctor.rows[0] ? { ...doctor.rows[0], specialties: specialties.rows } : null,
    nurse: nurse.rows[0] ?? null,
  });
});

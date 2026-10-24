import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { hashPassword, passwordChangeSchema, verifyPassword } from "../../lib/password.js";
import { HttpError } from "../../middleware/errorHandler.js";

export const staffProfileRouter = Router();

const idParam = z.coerce.number().int().positive();

const phoneSchema = z.object({
  phone: z.string().trim().min(1),
});

const certificateSchema = z
  .object({
    name: z.string().trim().min(1),
    issueDate: z.iso.date(),
    expirationDate: z.iso.date(),
  })
  .refine((c) => c.expirationDate >= c.issueDate, { message: "Expiration date must be on or after issue date" });

// get profile
staffProfileRouter.get("/api/staff/:id/profile", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);

  const employee = await pool.query(
    `
    SELECT
      e.employee_id AS "employeeId",
      e.first_name AS "firstName",
      e.last_name AS "lastName",
      to_char(e.dob, 'YYYY-MM-DD') AS dob,
      e.phone,
      e.email,
      e.is_active AS "isActive",
      t.type_name AS "employeeType",
      o.name AS "officeName"
    FROM employee e
    JOIN employee_types t ON t.employee_type_id = e.employee_type_id
    JOIN office o ON o.office_id = e.office_id
    WHERE e.employee_id = $1
    `,
    [employeeId]
  );
  if (!employee.rowCount) throw new HttpError(404, "Staff member not found");

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

  const schedule = await pool.query(
    `
    SELECT
      ds.day_of_week AS "dayOfWeek",
      o.name AS "officeName",
      s.name AS specialty,
      st.name AS shift,
      to_char(st.start_time, 'HH24:MI') AS "startTime",
      to_char(st.end_time, 'HH24:MI') AS "endTime"
    FROM doctor_schedule ds
    JOIN office o ON o.office_id = ds.office_id
    JOIN specialty s ON s.specialty_id = ds.specialty_id
    JOIN shift_type st ON st.shift_type_id = ds.shift_type_id
    WHERE ds.doctor_id = $1 AND ds.is_active
    ORDER BY array_position(ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']::varchar[], ds.day_of_week)
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

  const certificates = await pool.query(
    `
    SELECT
      certificate_id AS "certificateId",
      name,
      status,
      to_char(issue_date, 'YYYY-MM-DD') AS "issueDate",
      to_char(expiration_date, 'YYYY-MM-DD') AS "expirationDate"
    FROM certificate
    WHERE employee_id = $1
    ORDER BY expiration_date DESC
    `,
    [employeeId]
  );

  res.json({
    ...employee.rows[0],
    doctor: doctor.rows[0] ? { ...doctor.rows[0], specialties: specialties.rows, schedule: schedule.rows } : null,
    nurse: nurse.rows[0] ?? null,
    certificates: certificates.rows,
  });
});

// update phone
staffProfileRouter.put("/api/staff/:id/profile", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const { phone } = phoneSchema.parse(req.body);

  const updated = await pool.query(`UPDATE employee SET phone = $1 WHERE employee_id = $2 RETURNING phone`, [
    phone,
    employeeId,
  ]);
  if (!updated.rowCount) throw new HttpError(404, "Staff member not found");

  res.json(updated.rows[0]);
});

// add certificate
staffProfileRouter.post("/api/staff/:id/certificates", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const body = certificateSchema.parse(req.body);

  const created = await pool.query(
    `
    INSERT INTO certificate (employee_id, name, issue_date, expiration_date, status)
    VALUES ($1, $2, $3, $4, CASE WHEN $4::date < CURRENT_DATE THEN 'Expired' ELSE 'Active' END)
    RETURNING
      certificate_id AS "certificateId",
      name,
      status,
      to_char(issue_date, 'YYYY-MM-DD') AS "issueDate",
      to_char(expiration_date, 'YYYY-MM-DD') AS "expirationDate"
    `,
    [employeeId, body.name, body.issueDate, body.expirationDate]
  );

  res.status(201).json(created.rows[0]);
});

// update certificate
staffProfileRouter.put("/api/staff/:id/certificates/:certificateId", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const certificateId = idParam.parse(req.params.certificateId);
  const body = certificateSchema.parse(req.body);

  const updated = await pool.query(
    `
    UPDATE certificate
    SET name = $1, issue_date = $2, expiration_date = $3,
        status = CASE WHEN status = 'Revoked' THEN status WHEN $3::date < CURRENT_DATE THEN 'Expired' ELSE 'Active' END
    WHERE certificate_id = $4 AND employee_id = $5
    RETURNING
      certificate_id AS "certificateId",
      name,
      status,
      to_char(issue_date, 'YYYY-MM-DD') AS "issueDate",
      to_char(expiration_date, 'YYYY-MM-DD') AS "expirationDate"
    `,
    [body.name, body.issueDate, body.expirationDate, certificateId, employeeId]
  );
  if (!updated.rowCount) throw new HttpError(404, "Certificate not found");

  res.json(updated.rows[0]);
});

// remove certificate
staffProfileRouter.delete("/api/staff/:id/certificates/:certificateId", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const certificateId = idParam.parse(req.params.certificateId);

  const deleted = await pool.query(`DELETE FROM certificate WHERE certificate_id = $1 AND employee_id = $2`, [
    certificateId,
    employeeId,
  ]);
  if (!deleted.rowCount) throw new HttpError(404, "Certificate not found");

  res.status(204).end();
});

// change password
staffProfileRouter.put("/api/staff/:id/password", async (req, res) => {
  const employeeId = idParam.parse(req.params.id);
  const { currentPassword, newPassword } = passwordChangeSchema.parse(req.body);

  const creds = await pool.query(`SELECT password_hash FROM employee_creds WHERE employee_id = $1`, [employeeId]);
  if (!creds.rowCount || !(await verifyPassword(currentPassword, creds.rows[0].password_hash))) {
    throw new HttpError(400, "Current password is incorrect");
  }

  await pool.query(`UPDATE employee_creds SET password_hash = $1 WHERE employee_id = $2`, [
    await hashPassword(newPassword),
    employeeId,
  ]);
  res.status(204).end();
});

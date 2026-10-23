import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";

export const adminPatientsRouter = Router();

const idParam = z.coerce.number().int().positive();
const listQuery = z.object({ status: z.enum(["active", "inactive", "all"]).default("active") });
const statusSchema = z.object({ isActive: z.boolean() });

// get patient list
adminPatientsRouter.get("/", async (req, res) => {
  const { status } = listQuery.parse(req.query);

  const result = await pool.query(
    `
    SELECT
      p.patient_id AS "patientId",
      p.first_name AS "firstName",
      p.last_name AS "lastName",
      to_char(c.created_date, 'YYYY-MM-DD') AS "joinedDate",
      p.phone,
      d.first_name || ' ' || d.last_name AS "primaryDoctor",
      p.is_active AS "isActive"
    FROM patient p
    LEFT JOIN patient_creds c ON c.patient_id = p.patient_id
    LEFT JOIN patient_doctor pd ON pd.patient_id = p.patient_id AND pd.is_primary AND pd.is_active
    LEFT JOIN employee d ON d.employee_id = pd.doctor_id
    WHERE ($1 = 'all' OR p.is_active = ($1 = 'active'))
    ORDER BY p.last_name, p.first_name
    `,
    [status]
  );

  res.json(result.rows);
});

// activate or deactivate patient
adminPatientsRouter.patch("/:id/status", async (req, res) => {
  const patientId = idParam.parse(req.params.id);
  const { isActive } = statusSchema.parse(req.body);

  const updated = await pool.query(
    `UPDATE patient SET is_active = $1 WHERE patient_id = $2 RETURNING patient_id AS "patientId", is_active AS "isActive"`,
    [isActive, patientId]
  );
  if (!updated.rowCount) throw new HttpError(404, "Patient not found");

  await pool.query(`UPDATE patient_creds SET is_active = $1 WHERE patient_id = $2`, [isActive, patientId]);
  res.json(updated.rows[0]);
});

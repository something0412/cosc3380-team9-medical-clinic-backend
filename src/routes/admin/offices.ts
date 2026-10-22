import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";

export const adminOfficesRouter = Router();

const idParam = z.coerce.number().int().positive();

// office directory; also used by the employee form dropdown
adminOfficesRouter.get("/", async (_req, res) => {
  const result = await pool.query(`
    SELECT
      office_id AS "officeId",
      name,
      apt,
      street,
      city,
      state,
      zip,
      phone,
      is_active AS "isActive"
    FROM office
    ORDER BY name
  `);

  res.json(result.rows);
});

// one office with its employee counts
adminOfficesRouter.get("/:id", async (req, res) => {
  const officeId = idParam.parse(req.params.id);

  const result = await pool.query(
    `
    SELECT
      o.office_id AS "officeId",
      o.name,
      o.apt,
      o.street,
      o.city,
      o.state,
      o.zip,
      o.phone,
      o.is_active AS "isActive",
      COUNT(e.employee_id)::int AS "employeeCount",
      (COUNT(e.employee_id) FILTER (WHERE e.is_active))::int AS "activeEmployeeCount"
    FROM office o
    LEFT JOIN employee e ON e.office_id = o.office_id
    WHERE o.office_id = $1
    GROUP BY o.office_id
    `,
    [officeId]
  );
  if (!result.rowCount) throw new HttpError(404, "Office not found");

  res.json(result.rows[0]);
});

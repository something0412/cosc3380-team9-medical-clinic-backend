import { Router } from "express";
import { pool } from "../../lib/db.js";
import { adminEmployeesRouter } from "./employees.js";

// mounted at /api/admin behind requireRole("admin")
export const adminRouter = Router();

adminRouter.use("/employees", adminEmployeesRouter);

// employee types for role selection
adminRouter.get("/employee-types", async (_req, res) => {
  const result = await pool.query(`
    SELECT
      employee_type_id AS "employeeTypeId",
      type_name AS "typeName"
    FROM employee_types
    WHERE is_active
    ORDER BY type_name
  `);

  res.json(result.rows);
});

// offices for employee forms
adminRouter.get("/offices", async (_req, res) => {
  const result = await pool.query(`
    SELECT office_id AS "officeId", name, is_active AS "isActive"
    FROM office
    ORDER BY name
  `);

  res.json(result.rows);
});

// specialties for doctor forms
adminRouter.get("/specialties", async (_req, res) => {
  const result = await pool.query(`
    SELECT specialty_id AS "specialtyId", name, is_active AS "isActive"
    FROM specialty
    ORDER BY name
  `);

  res.json(result.rows);
});

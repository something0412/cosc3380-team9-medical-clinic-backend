import { Router } from "express";
import { pool } from "../../lib/db.js";

// mounted at /api/admin behind requireRole("admin")
export const adminRouter = Router();

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

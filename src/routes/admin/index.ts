import { Router } from "express";
import { pool } from "../../lib/db.js";
import { adminBillingRouter } from "./billing.js";
import { adminEmployeesRouter } from "./employees.js";
import { adminOfficesRouter } from "./offices.js";
import { adminPatientsRouter } from "./patients.js";
import { adminReportsRouter } from "./reports.js";
import { adminSchedulesRouter } from "./schedules.js";
import { adminShiftsRouter, adminTimeSlotsRouter } from "./shifts.js";
import { adminSpecialtiesRouter } from "./specialties.js";
import { adminStaffRouter } from "./staff.js";

// mounted at /api/admin behind requireRole("admin")
export const adminRouter = Router();

adminRouter.use("/employees", adminEmployeesRouter);
adminRouter.use("/offices", adminOfficesRouter);
adminRouter.use("/specialties", adminSpecialtiesRouter);
adminRouter.use("/schedules", adminSchedulesRouter);
adminRouter.use("/shift-types", adminShiftsRouter);
adminRouter.use("/time-slots", adminTimeSlotsRouter);
adminRouter.use("/staff", adminStaffRouter);
adminRouter.use("/patients", adminPatientsRouter);
adminRouter.use(adminReportsRouter);
adminRouter.use(adminBillingRouter);

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

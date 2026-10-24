import { Router } from "express";
import { pool } from "../../lib/db.js";

export const labDashboardRouter = Router();

// get dashboard numbers and the oldest waiting orders
labDashboardRouter.get("/api/lab/dashboard", async (req, res) => {
  const labTechId = req.session.employeeId;

  // get how many orders are waiting, in progress, done today, and done by me this week (Houston dates)
  const counts = await pool.query(
    `
    SELECT
      count(*) FILTER (WHERE status = 'Ordered')::int AS waiting,
      count(*) FILTER (WHERE status = 'InProgress')::int AS "inProgress",
      count(*) FILTER (
        WHERE status = 'Completed' AND result_date::date = (now() AT TIME ZONE 'America/Chicago')::date
      )::int AS "completedToday",
      count(*) FILTER (
        WHERE status = 'Completed' AND performed_by_employee_id = $1
          AND result_date::date > (now() AT TIME ZONE 'America/Chicago')::date - 7
      )::int AS "myWeek"
    FROM lab_order
    `,
    [labTechId]
  );

  // get the orders that have been waiting the longest
  const oldest = await pool.query(
    `
    SELECT
      l.lab_order_id AS "labOrderId",
      p.first_name || ' ' || p.last_name AS "patientName",
      t.name AS "testName",
      d.first_name || ' ' || d.last_name AS "orderedBy",
      to_char(l.order_date, 'YYYY-MM-DD') AS "orderDate",
      ((now() AT TIME ZONE 'America/Chicago')::date - l.order_date)::int AS "daysWaiting",
      l.status
    FROM lab_order l
    JOIN patient p ON p.patient_id = l.patient_id
    JOIN lab_test_type t ON t.lab_test_type_id = l.lab_test_type_id
    JOIN employee d ON d.employee_id = l.ordered_by_employee_id
    WHERE l.status IN ('Ordered', 'InProgress')
    ORDER BY l.order_date, l.lab_order_id
    LIMIT 5
    `
  );

  res.json({ ...counts.rows[0], oldestWaiting: oldest.rows });
});

import { Router } from "express";
import { pool } from "../../lib/db.js";

export const labOrdersRouter = Router();

// get lab orders from every doctor (status tab and patient search)
labOrdersRouter.get("/api/lab/orders", async (req, res) => {
  const status = String(req.query.status ?? "Ordered");
  const search = String(req.query.search ?? "").trim();

  // get the lab orders for the chosen tab, matching the searched patient name
  // waiting ones oldest first, finished ones newest result first
  const result = await pool.query(
    `
    SELECT
      l.lab_order_id AS "labOrderId",
      p.patient_id AS "patientId",
      p.first_name || ' ' || p.last_name AS "patientName",
      to_char(p.dob, 'YYYY-MM-DD') AS dob,
      t.name AS "testName",
      d.first_name || ' ' || d.last_name AS "orderedBy",
      to_char(l.order_date, 'YYYY-MM-DD') AS "orderDate",
      l.status,
      l.result_notes AS "resultNotes",
      lt.first_name || ' ' || lt.last_name AS "performedBy",
      to_char(l.result_date, 'YYYY-MM-DD HH24:MI') AS "resultDate"
    FROM lab_order l
    JOIN patient p ON p.patient_id = l.patient_id
    JOIN lab_test_type t ON t.lab_test_type_id = l.lab_test_type_id
    JOIN employee d ON d.employee_id = l.ordered_by_employee_id
    LEFT JOIN employee lt ON lt.employee_id = l.performed_by_employee_id
    WHERE ($1 = 'all' OR l.status = $1)
      AND (p.first_name || ' ' || p.last_name) ILIKE '%' || $2 || '%'
    ORDER BY
      CASE WHEN l.status IN ('Ordered', 'InProgress') THEN l.order_date END,
      l.result_date DESC NULLS LAST,
      l.lab_order_id DESC
    `,
    [status, search]
  );

  res.json(result.rows);
});

// start an order (sample collected)
labOrdersRouter.patch("/api/lab/orders/:id/start", async (req, res) => {
  const labOrderId = Number(req.params.id);

  // move a waiting order to in progress
  const result = await pool.query(
    `
    UPDATE lab_order
    SET status = 'InProgress'
    WHERE lab_order_id = $1 AND status = 'Ordered'
    RETURNING lab_order_id AS "labOrderId", status
    `,
    [labOrderId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Only waiting orders can be started" });
    return;
  }

  res.json(result.rows[0]);
});

// enter the result (the order is then completed and can't be changed)
labOrdersRouter.patch("/api/lab/orders/:id/result", async (req, res) => {
  const labTechId = req.session.employeeId;
  const labOrderId = Number(req.params.id);
  const resultNotes = String(req.body.resultNotes ?? "").trim();

  if (!resultNotes) {
    res.status(400).json({ error: "Enter the result" });
    return;
  }

  // save the result, who entered it and when (Houston time), and mark the order completed
  const result = await pool.query(
    `
    UPDATE lab_order
    SET status = 'Completed',
        result_notes = $1,
        performed_by_employee_id = $2,
        result_date = now() AT TIME ZONE 'America/Chicago'
    WHERE lab_order_id = $3 AND status IN ('Ordered', 'InProgress')
    RETURNING lab_order_id AS "labOrderId", status
    `,
    [resultNotes, labTechId, labOrderId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Only waiting or in-progress orders can get a result" });
    return;
  }

  res.json(result.rows[0]);
});

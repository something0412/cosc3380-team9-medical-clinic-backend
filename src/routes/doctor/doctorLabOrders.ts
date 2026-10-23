import { Router } from "express";
import { pool } from "../../lib/db.js";

export const doctorLabOrdersRouter = Router();

// get lab orders I made
doctorLabOrdersRouter.get("/api/doctor/lab-orders", async (req, res) => {
  const doctorId = req.session.employeeId;
  const status = String(req.query.status ?? "all");
  const search = String(req.query.search ?? "").trim();

  // get the doctor's lab orders, filtered by status and patient name
  const result = await pool.query(
    ``,
    [doctorId, status, search]
  );

  res.json(result.rows);
});

// get lab tests for the order form
doctorLabOrdersRouter.get("/api/doctor/lab-tests", async (_req, res) => {
  // get the list of lab tests
  const result = await pool.query(``);

  res.json(result.rows);
});

// create a lab order
doctorLabOrdersRouter.post("/api/doctor/lab-orders", async (req, res) => {
  const doctorId = req.session.employeeId;
  const patientId = Number(req.body.patientId);
  const labTestTypeId = Number(req.body.labTestTypeId);

  if (!patientId || !labTestTypeId) {
    res.status(400).json({ error: "Patient and lab test are required" });
    return;
  }

  // check this is one of the doctor's patients
  const access = await pool.query(
    ``,
    [doctorId, patientId]
  );
  if (access.rowCount === 0) {
    res.status(403).json({ error: "This patient isn't under your care" });
    return;
  }

  // save the new lab order
  const result = await pool.query(
    ``,
    [patientId, doctorId, labTestTypeId]
  );

  res.status(201).json(result.rows[0]);
});

// cancel a lab order that has no result yet
doctorLabOrdersRouter.patch("/api/doctor/lab-orders/:id/cancel", async (req, res) => {
  const doctorId = req.session.employeeId;
  const labOrderId = Number(req.params.id);

  // cancel a lab order that's still waiting
  const result = await pool.query(
    ``,
    [labOrderId, doctorId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Only your own lab orders that are still waiting can be cancelled" });
    return;
  }

  res.json(result.rows[0]);
});

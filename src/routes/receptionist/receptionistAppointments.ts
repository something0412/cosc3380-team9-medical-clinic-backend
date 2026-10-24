import { Router } from "express";
import { pool } from "../../lib/db.js";

export const receptionistAppointmentsRouter = Router();

// get one day's appointments at my office (date and patient name search)
receptionistAppointmentsRouter.get("/api/receptionist/appointments", async (req, res) => {
  const receptionistId = req.session.employeeId;
  const date = req.query.date ? String(req.query.date) : null;
  const search = String(req.query.search ?? "").trim();

  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Date must look like YYYY-MM-DD" });
    return;
  }

  // get my office and today's date
  const office = await pool.query(
    ``,
    [receptionistId]
  );

  // get the appointments at my office on the date (today when no date), matching the patient name
  const result = await pool.query(
    ``,
    [receptionistId, date, search]
  );

  res.json({
    officeId: office.rows[0]?.officeId ?? null,
    officeName: office.rows[0]?.officeName ?? "",
    today: office.rows[0]?.today ?? "",
    appointments: result.rows,
  });
});

// check a patient in
receptionistAppointmentsRouter.patch("/api/receptionist/appointments/:id/check-in", async (req, res) => {
  const receptionistId = req.session.employeeId;
  const appointmentId = Number(req.params.id);

  // save the check in time on today's scheduled appointment at my office (not checked in yet)
  const result = await pool.query(
    ``,
    [appointmentId, receptionistId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Only today's scheduled appointments at your office that aren't checked in can be checked in" });
    return;
  }

  res.json(result.rows[0]);
});

// check a patient out
receptionistAppointmentsRouter.patch("/api/receptionist/appointments/:id/check-out", async (req, res) => {
  const receptionistId = req.session.employeeId;
  const appointmentId = Number(req.params.id);

  // save the check out time on today's checked in appointment at my office (not checked out yet)
  const result = await pool.query(
    ``,
    [appointmentId, receptionistId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Only patients checked in today at your office can be checked out" });
    return;
  }

  res.json(result.rows[0]);
});

// mark that the patient never came
receptionistAppointmentsRouter.patch("/api/receptionist/appointments/:id/no-show", async (req, res) => {
  const receptionistId = req.session.employeeId;
  const appointmentId = Number(req.params.id);

  // set the status to No Show on a scheduled appointment at my office from today or earlier (never checked in)
  const result = await pool.query(
    ``,
    [appointmentId, receptionistId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Only scheduled appointments at your office from today or earlier that weren't checked in can be marked No Show" });
    return;
  }

  res.json(result.rows[0]);
});

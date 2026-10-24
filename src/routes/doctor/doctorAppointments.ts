import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { listAppointments } from "../../services/booking.js";
import { bookingDate } from "../booking.js";

export const doctorAppointmentsRouter = Router();

const listQuery = z.object({
  view: z.enum(["today", "upcoming", "past", "all"], "View must be today, upcoming, past or all").default("today"),
  date: bookingDate.optional(),
  search: z.string().trim().max(100).default(""),
});

// get my appointments for today, upcoming, past or all, or for one date
doctorAppointmentsRouter.get("/api/doctor/appointments", async (req, res) => {
  if (!req.user || req.user.role !== "doctor") throw new HttpError(401, "Login required");
  const { view, date, search } = listQuery.parse(req.query);

  // get the doctor's appointments for the chosen tab, matching the searched patient name
  res.json(await listAppointments({ doctorId: req.user.employeeId }, { when: view, date, search }));
});

// get one visit with everything needed to see the patient
doctorAppointmentsRouter.get("/api/doctor/appointments/:id", async (req, res) => {
  const doctorId = req.session.employeeId;
  const appointmentId = Number(req.params.id);

  // get this appointment and the patient's basic info
  const appointment = await pool.query(
    ``,
    [appointmentId, doctorId]
  );
  if (appointment.rowCount === 0) {
    res.status(404).json({ error: "Appointment not found" });
    return;
  }
  const patientId = appointment.rows[0].patientId;

  // get the reason for visit and the notes for this visit
  const summary = await pool.query(
    ``,
    [appointmentId]
  );

  // get the diagnoses added at this visit
  const diagnoses = await pool.query(
    ``,
    [appointmentId]
  );

  // get the vitals taken at this visit, marked normal, abnormal or critical
  const vitals = await pool.query(
    ``,
    [appointmentId]
  );

  // get the prescriptions written at this visit
  const prescriptions = await pool.query(
    ``,
    [appointmentId]
  );

  // get the patient's allergies
  const allergies = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's insurance and whether it's verified
  const insurance = await pool.query(
    ``,
    [patientId]
  );

  // get the required forms the patient still hasn't filled out
  const missingForms = await pool.query(
    ``,
    [patientId]
  );

  res.json({
    ...appointment.rows[0],
    summary: summary.rows[0] ?? null,
    diagnoses: diagnoses.rows,
    vitals: vitals.rows,
    prescriptions: prescriptions.rows,
    allergies: allergies.rows,
    insurance: insurance.rows[0] ?? null,
    missingForms: missingForms.rows.map((f) => f.name),
  });
});

// mark a visit completed or no show
doctorAppointmentsRouter.patch("/api/doctor/appointments/:id/status", async (req, res) => {
  const doctorId = req.session.employeeId;
  const appointmentId = Number(req.params.id);
  const status = req.body.status;

  if (status !== "Completed" && status !== "No Show") {
    res.status(400).json({ error: "Status must be Completed or No Show" });
    return;
  }

  // change the visit to completed or no show
  const result = await pool.query(
    ``,
    [status, appointmentId, doctorId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Only your scheduled appointments from today or earlier can be updated" });
    return;
  }

  res.json(result.rows[0]);
});

// save the visit summary (creates it or updates it)
doctorAppointmentsRouter.put("/api/doctor/appointments/:id/summary", async (req, res) => {
  const doctorId = req.session.employeeId;
  const appointmentId = Number(req.params.id);
  const visitReason = String(req.body.visitReason ?? "").trim();
  const notes = String(req.body.notes ?? "").trim();
  const diagnoses: { name: string; reasoning: string }[] = Array.isArray(req.body.diagnoses) ? req.body.diagnoses : [];

  if (!visitReason) {
    res.status(400).json({ error: "Reason for visit is required" });
    return;
  }
  for (const d of diagnoses) {
    if (!String(d.name ?? "").trim()) {
      res.status(400).json({ error: "Every added diagnosis needs a name" });
      return;
    }
  }

  // check this is the doctor's visit and it wasn't cancelled or missed
  const appointment = await pool.query(
    ``,
    [appointmentId, doctorId]
  );
  if (appointment.rowCount === 0) {
    res.status(400).json({ error: "Notes can only be written for your scheduled or completed visits" });
    return;
  }

  // save the summary and its diagnoses together
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // save the reason for visit and the notes
    const result = await client.query(
      ``,
      [appointmentId, visitReason, notes || null, doctorId]
    );

    // remove this visit's old diagnoses
    await client.query(``, [appointmentId]);
    for (const d of diagnoses) {
      // save one diagnosis for this visit
      await client.query(
        ``,
        [appointmentId, String(d.name).trim(), String(d.reasoning ?? "").trim() || null, doctorId]
      );
    }

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// get medications for the prescription form
doctorAppointmentsRouter.get("/api/doctor/medications", async (_req, res) => {
  // get the list of medications
  const result = await pool.query(``);

  res.json(result.rows);
});

// write a prescription at this visit
doctorAppointmentsRouter.post("/api/doctor/appointments/:id/prescriptions", async (req, res) => {
  const doctorId = req.session.employeeId;
  const appointmentId = Number(req.params.id);
  const medicationId = Number(req.body.medicationId);
  const dosage = String(req.body.dosage ?? "").trim();
  const instructions = String(req.body.instructions ?? "").trim();
  const durationDays =
    req.body.durationDays === null || req.body.durationDays === undefined || req.body.durationDays === ""
      ? null
      : Number(req.body.durationDays);

  if (!medicationId || !dosage) {
    res.status(400).json({ error: "Medication and dosage are required" });
    return;
  }
  if (durationDays !== null && durationDays <= 0) {
    res.status(400).json({ error: "Duration must be more than 0 days" });
    return;
  }

  // check this is the doctor's visit and get the patient
  const appointment = await pool.query(
    ``,
    [appointmentId, doctorId]
  );
  if (appointment.rowCount === 0) {
    res.status(400).json({ error: "Prescriptions can only be written for your scheduled or completed visits" });
    return;
  }
  const patientId = appointment.rows[0].patient_id;

  // save a new prescription for this visit
  const prescription = await pool.query(
    ``,
    [patientId, doctorId, appointmentId]
  );

  // save the medication on that prescription
  const item = await pool.query(
    ``,
    [prescription.rows[0].prescription_id, medicationId, dosage, instructions || null, durationDays]
  );

  res.status(201).json(item.rows[0]);
});

// stop a prescription I wrote
doctorAppointmentsRouter.patch("/api/doctor/prescription-items/:id/stop", async (req, res) => {
  const doctorId = req.session.employeeId;
  const itemId = Number(req.params.id);

  // stop one of the doctor's prescriptions
  const result = await pool.query(
    ``,
    [itemId, doctorId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Only your own active prescriptions can be stopped" });
    return;
  }

  res.json(result.rows[0]);
});

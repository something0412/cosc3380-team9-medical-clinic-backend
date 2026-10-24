import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { listAppointments } from "../../services/booking.js";
import { bookingDate } from "../booking.js";

export const nurseAppointmentsRouter = Router();

const listQuery = z.object({ date: bookingDate.optional() });

// get the appointments at my office on one day (no date = today)
nurseAppointmentsRouter.get("/api/nurse/appointments", async (req, res) => {
  if (!req.user || req.user.role === "patient") throw new HttpError(401, "Login required");
  const { date } = listQuery.parse(req.query);

  // nurses aren't assigned to single visits, so they see their whole office without cancelled visits
  res.json(await listAppointments({ officeId: req.user.officeId }, { date, includeCancelled: false }));
});

// get one appointment for the intake page
nurseAppointmentsRouter.get("/api/nurse/appointments/:id", async (req, res) => {
  const nurseId = req.session.employeeId;
  const appointmentId = Number(req.params.id);

  // get the appointment and its patient, only if it is at my office
  const appointment = await pool.query(
    ``,
    [appointmentId, nurseId]
  );
  if (appointment.rowCount === 0) {
    res.status(404).json({ error: "Appointment not found at your office" });
    return;
  }
  const patientId = appointment.rows[0].patientId;

  // get the patient's active allergies
  const allergies = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's active home medications
  const homeMedications = await pool.query(
    ``,
    [patientId]
  );

  // get the vitals recorded for this visit, newest first, with abnormal/critical flags
  const vitals = await pool.query(
    ``,
    [appointmentId]
  );

  res.json({
    ...appointment.rows[0],
    allergies: allergies.rows,
    homeMedications: homeMedications.rows,
    vitals: vitals.rows,
  });
});

// record vitals for a visit
nurseAppointmentsRouter.post("/api/nurse/appointments/:id/vitals", async (req, res) => {
  const nurseId = req.session.employeeId;
  const appointmentId = Number(req.params.id);
  const temperature = req.body.temperature ? Number(req.body.temperature) : null;
  const heartRate = req.body.heartRate ? Number(req.body.heartRate) : null;
  const systolic = req.body.systolic ? Number(req.body.systolic) : null;
  const diastolic = req.body.diastolic ? Number(req.body.diastolic) : null;
  const respiratoryRate = req.body.respiratoryRate ? Number(req.body.respiratoryRate) : null;
  const oxygenSaturation = req.body.oxygenSaturation ? Number(req.body.oxygenSaturation) : null;
  const weight = req.body.weight ? Number(req.body.weight) : null;
  const height = req.body.height ? Number(req.body.height) : null;

  const readings = [temperature, heartRate, systolic, diastolic, respiratoryRate, oxygenSaturation, weight, height];
  if (readings.every((v) => v === null)) {
    res.status(400).json({ error: "Enter at least one reading" });
    return;
  }
  if (readings.some((v) => v !== null && !(v > 0))) {
    res.status(400).json({ error: "Readings must be numbers more than 0" });
    return;
  }
  const wholeNumbers = [heartRate, systolic, diastolic, respiratoryRate, oxygenSaturation];
  if (wholeNumbers.some((v) => v !== null && !Number.isInteger(v))) {
    res.status(400).json({ error: "Heart rate, blood pressure, breathing rate and oxygen must be whole numbers" });
    return;
  }

  // get the patient of this appointment (my office, scheduled or completed, today or earlier)
  const appointment = await pool.query(
    ``,
    [appointmentId, nurseId]
  );
  if (appointment.rowCount === 0) {
    res.status(400).json({ error: "Vitals can only be recorded for today's or past visits at your office" });
    return;
  }

  // save the vitals for this visit, recorded by me now (Houston time)
  const result = await pool.query(
    ``,
    [appointment.rows[0].patient_id, appointmentId, nurseId, temperature, heartRate, systolic, diastolic, respiratoryRate, oxygenSaturation, weight, height]
  );

  res.status(201).json(result.rows[0]);
});

import { Router } from "express";
import { z } from "zod";
import { CLINIC_TIME_ZONE } from "../../lib/clinicTime.js";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { getAppointment } from "../../services/booking.js";
import { addNursingNote, asClinician, getPatientAlerts, getVisitRecord, recordVitals, updateNursingNote } from "../../services/clinical.js";
import { bookingDate } from "../booking.js";

export const nurseAppointmentsRouter = Router();

const listQuery = z.object({
  date: bookingDate.optional(),
  name: z.string().trim().max(100).default(""),
  officeId: z.coerce.number().int().positive().optional(),
});
const id = (label: string) => z.coerce.number(`Choose ${label}`).int(`Choose ${label}`).positive(`Choose ${label}`);

// the limits are what the columns can hold, not clinical ranges
const decimal = (label: string) =>
  z.number(`${label} must be a number`).positive(`${label} must be more than 0`).max(99999999, `${label} is too large`).nullish();
const whole = (label: string) =>
  z.number(`${label} must be a number`).int(`${label} must be a whole number`).positive(`${label} must be more than 0`).max(2147483647, `${label} is too large`).nullish();

const vitalsBody = z
  .object({
    temperature: decimal("Temperature"),
    heartRate: whole("Heart rate"),
    systolic: whole("Systolic pressure"),
    diastolic: whole("Diastolic pressure"),
    respiratoryRate: whole("Respiratory rate"),
    oxygenSaturation: whole("Oxygen saturation").refine((value) => value == null || value <= 100, "Oxygen saturation can't be over 100 percent"),
    weight: decimal("Weight"),
    height: decimal("Height"),
  })
  .refine((body) => Object.values(body).some((value) => value != null), "Enter at least one reading");

const noteBody = z.object({ note: z.string("Write the note").trim().min(1, "Write the note").max(10000, "Keep the note under 10000 characters") });

// get my office, the default office filter
nurseAppointmentsRouter.get("/api/nurse/my-office", async (req, res) => {
  const nurse = asClinician(req.user, "nurse");
  res.json({ officeId: nurse.officeId });
});

// search appointments by patient name, date and office (any mix of the three)
nurseAppointmentsRouter.get("/api/nurse/appointments", async (req, res) => {
  asClinician(req.user, "nurse");
  const { date, name, officeId } = listQuery.parse(req.query);
  if (!date && !name) throw new HttpError(400, "Choose a date or type a patient name");

  // cancelled visits are left out, newest day first
  const result = await pool.query(
    `
    SELECT
      a.appointment_id AS "appointmentId",
      a.patient_id AS "patientId",
      p.first_name || ' ' || p.last_name AS "patientName",
      to_char(a.appointment_date, 'YYYY-MM-DD') AS "date",
      to_char(ts.start_time, 'HH24:MI') AS "startTime",
      e.first_name || ' ' || e.last_name AS "doctorName",
      sp.name AS "specialty",
      o.name AS "officeName",
      a.status,
      a.checked_in_at IS NOT NULL AS "checkedIn"
    FROM appointment a
    JOIN patient p ON p.patient_id = a.patient_id
    JOIN employee e ON e.employee_id = a.doctor_id
    JOIN specialty sp ON sp.specialty_id = a.specialty_id
    JOIN office o ON o.office_id = a.office_id
    JOIN time_slot ts ON ts.time_slot_id = a.time_slot_id
    WHERE a.status <> 'Cancelled'
      AND ($1::date IS NULL OR a.appointment_date = $1)
      AND ($2 = '' OR p.first_name || ' ' || p.last_name ILIKE '%' || $2 || '%')
      AND ($3::int IS NULL OR a.office_id = $3)
    ORDER BY a.appointment_date DESC, ts.start_time, a.appointment_id
    `,
    [date ?? null, name, officeId ?? null]
  );
  res.json(result.rows);
});

// get one appointment for the intake page (any day, any office)
nurseAppointmentsRouter.get("/api/nurse/appointments/:id", async (req, res) => {
  const nurse = asClinician(req.user, "nurse");
  const appointment = await getAppointment(pool, id("an appointment").parse(req.params.id));
  if (!appointment) throw new HttpError(404, "Appointment not found");

  // intake can only be edited on the visit's day, at my office, after check in
  const today = new Date().toLocaleDateString("en-CA", { timeZone: CLINIC_TIME_ZONE });
  const checkedIn = appointment.status === "Completed" || (appointment.status === "Scheduled" && appointment.checkedIn);
  let editBlockedReason = null;
  if (appointment.date !== today) editBlockedReason = "Intake can only be edited on the day of the appointment.";
  else if (appointment.officeId !== nurse.officeId) editBlockedReason = "Intake can only be edited by nurses at this appointment's office.";
  else if (!checkedIn) editBlockedReason = "Intake can be edited once the front desk checks the patient in.";

  res.json({
    ...appointment,
    editBlockedReason,
    ...(await getVisitRecord(appointment.appointmentId)),
    ...(await getPatientAlerts(appointment.patientId, nurse)),
  });
});

// record vitals for a visit
nurseAppointmentsRouter.post("/api/nurse/appointments/:id/vitals", async (req, res) => {
  const appointmentId = id("an appointment").parse(req.params.id);
  res.status(201).json(await recordVitals(asClinician(req.user, "nurse"), appointmentId, vitalsBody.parse(req.body)));
});

// add a nursing note to a visit
nurseAppointmentsRouter.post("/api/nurse/appointments/:id/nursing-notes", async (req, res) => {
  const appointmentId = id("an appointment").parse(req.params.id);
  res.status(201).json(await addNursingNote(asClinician(req.user, "nurse"), appointmentId, noteBody.parse(req.body).note));
});

// change a nursing note I wrote
nurseAppointmentsRouter.patch("/api/nurse/nursing-notes/:id", async (req, res) => {
  const nursingNoteId = id("a note").parse(req.params.id);
  res.json(await updateNursingNote(asClinician(req.user, "nurse"), nursingNoteId, noteBody.parse(req.body).note));
});

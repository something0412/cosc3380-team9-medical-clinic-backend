import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { getAppointment, listAppointments } from "../../services/booking.js";
import { addNursingNote, asClinician, assertCanSeePatient, getPatientAlerts, getVisitRecord, recordVitals, updateNursingNote } from "../../services/clinical.js";
import { bookingDate } from "../booking.js";

export const nurseAppointmentsRouter = Router();

const listQuery = z.object({ date: bookingDate.optional() });
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

// get the appointments at my office on one day (no date = today)
nurseAppointmentsRouter.get("/api/nurse/appointments", async (req, res) => {
  if (!req.user || req.user.role === "patient") throw new HttpError(401, "Login required");
  const { date } = listQuery.parse(req.query);

  // nurses aren't assigned to single visits, so they see their whole office without cancelled visits
  res.json(await listAppointments({ officeId: req.user.officeId }, { date, includeCancelled: false }));
});

// get one appointment for the intake page
nurseAppointmentsRouter.get("/api/nurse/appointments/:id", async (req, res) => {
  const nurse = asClinician(req.user, "nurse");
  const appointment = await getAppointment(pool, id("an appointment").parse(req.params.id));
  if (!appointment || appointment.officeId !== nurse.officeId) throw new HttpError(404, "Appointment not found");
  await assertCanSeePatient(nurse, appointment.patientId);

  res.json({
    ...appointment,
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

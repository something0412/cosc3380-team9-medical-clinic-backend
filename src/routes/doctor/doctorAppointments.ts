import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { CLINIC_TODAY } from "../../lib/clinicTime.js";
import { pool } from "../../lib/db.js";
import { withTransaction } from "../../lib/transaction.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { getAppointment, listAppointments } from "../../services/booking.js";
import {
  addVisitDiagnoses,
  assertDoctorCanSeePatient,
  getPatientAlerts,
  getPrescription,
  getVisitRecord,
  lockDoctorVisit,
  saveVisitSummary,
} from "../../services/clinical.js";
import { bookingDate } from "../booking.js";

export const doctorAppointmentsRouter = Router();

const listQuery = z.object({
  view: z.enum(["today", "upcoming", "past", "all"], "View must be today, upcoming, past or all").default("today"),
  date: bookingDate.optional(),
  search: z.string().trim().max(100).default(""),
});

const id = (label: string) => z.coerce.number(`Choose ${label}`).int(`Choose ${label}`).positive(`Choose ${label}`);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .nullish()
    .transform((value) => value || null);

const summaryBody = z
  .object({
    visitReason: z.string("Reason for visit is required").trim().min(1, "Reason for visit is required").max(200, "Keep the reason under 200 characters").optional(),
    notes: optionalText(10000).optional(),
  })
  .refine((body) => body.visitReason !== undefined || body.notes !== undefined, "Send a reason for visit or notes");

const diagnosesBody = z.object({
  diagnoses: z
    .array(
      z.object({
        name: z.string("Every diagnosis needs a name").trim().min(1, "Every diagnosis needs a name").max(200, "Keep diagnosis names under 200 characters"),
        reasoning: optionalText(5000).optional(),
      })
    )
    .min(1, "Add at least one diagnosis")
    .max(20, "Add up to 20 diagnoses at a time"),
});

const prescriptionBody = z.object({
  items: z
    .array(
      z.object({
        medicationId: id("a medication"),
        dosage: z.string("Dosage is required").trim().min(1, "Dosage is required").max(50, "Keep the dosage under 50 characters"),
        instructions: optionalText(2000).optional(),
        durationDays: z.number().int("Duration must be whole days").positive("Duration must be more than 0 days").nullish(),
      })
    )
    .min(1, "Add at least one medication")
    .max(20, "Add up to 20 medications at a time")
    .refine((items) => new Set(items.map((i) => i.medicationId)).size === items.length, "Each medication can only be listed once"),
});

// the doctor is whoever is signed in, never an ID from the request
function me(req: Request) {
  if (req.user?.role !== "doctor") throw new HttpError(401, "Login required");
  return req.user.employeeId;
}

// get my appointments for today, upcoming, past or all, or for one date
doctorAppointmentsRouter.get("/api/doctor/appointments", async (req, res) => {
  if (!req.user || req.user.role !== "doctor") throw new HttpError(401, "Login required");
  const { view, date, search } = listQuery.parse(req.query);

  // get the doctor's appointments for the chosen tab, matching the searched patient name
  res.json(await listAppointments({ doctorId: req.user.employeeId }, { when: view, date, search }));
});

// get one visit with everything needed to see the patient
doctorAppointmentsRouter.get("/api/doctor/appointments/:id", async (req, res) => {
  const doctorId = me(req);
  const appointment = await getAppointment(pool, id("an appointment").parse(req.params.id));
  if (!appointment || appointment.doctorId !== doctorId) throw new HttpError(404, "Appointment not found");

  res.json({
    ...appointment,
    ...(await getVisitRecord(appointment.appointmentId)),
    ...(await getPatientAlerts(appointment.patientId)),
  });
});

// save the visit summary (creates it or updates the fields that were sent)
doctorAppointmentsRouter.put("/api/doctor/appointments/:id/summary", async (req, res) => {
  const doctorId = me(req);
  const appointmentId = id("an appointment").parse(req.params.id);
  const fields = summaryBody.parse(req.body);

  const summary = await withTransaction(async (client) => {
    await lockDoctorVisit(client, appointmentId, doctorId);
    return saveVisitSummary(client, appointmentId, doctorId, fields);
  });
  res.json(summary);
});

// add diagnoses to a visit, and get back every diagnosis on it
doctorAppointmentsRouter.post("/api/doctor/appointments/:id/diagnoses", async (req, res) => {
  const doctorId = me(req);
  const appointmentId = id("an appointment").parse(req.params.id);
  const { diagnoses } = diagnosesBody.parse(req.body);

  const all = await withTransaction(async (client) => {
    await lockDoctorVisit(client, appointmentId, doctorId);
    return addVisitDiagnoses(client, appointmentId, doctorId, diagnoses);
  });
  res.status(201).json(all);
});

// get medications for the prescription form
doctorAppointmentsRouter.get("/api/doctor/medications", async (_req, res) => {
  const result = await pool.query(`SELECT medication_id AS "medicationId", name, manufacturer FROM medication WHERE is_active ORDER BY name`);
  res.json(result.rows);
});

// write a prescription at this visit, with all of its medications or none of them
doctorAppointmentsRouter.post("/api/doctor/appointments/:id/prescriptions", async (req, res) => {
  const doctorId = me(req);
  const appointmentId = id("an appointment").parse(req.params.id);
  const { items } = prescriptionBody.parse(req.body);

  const prescription = await withTransaction(async (client) => {
    const { patientId } = await lockDoctorVisit(client, appointmentId, doctorId);
    const patient = await client.query(`SELECT is_active AS "isActive" FROM patient WHERE patient_id = $1 FOR SHARE`, [patientId]);
    if (!patient.rows[0].isActive) throw new HttpError(409, "This patient account is inactive");

    const created = await client.query(
      `INSERT INTO prescription (patient_id, prescriber_id, appointment_id, date_prescribed) VALUES ($1, $2, $3, ${CLINIC_TODAY}) RETURNING prescription_id`,
      [patientId, doctorId, appointmentId]
    );
    const prescriptionId = created.rows[0].prescription_id as number;
    for (const item of items) {
      const added = await client.query(
        `
        INSERT INTO prescription_item (prescription_id, medication_id, dosage, instructions, duration_days)
        SELECT $1, medication_id, $3, $4, $5 FROM medication WHERE medication_id = $2 AND is_active
        `,
        [prescriptionId, item.medicationId, item.dosage, item.instructions ?? null, item.durationDays ?? null]
      );
      if (!added.rowCount) throw new HttpError(400, "Choose an active medication");
    }
    return getPrescription(client, prescriptionId);
  });
  res.status(201).json(prescription);
});

// get one prescription for a patient I care for
doctorAppointmentsRouter.get("/api/doctor/prescriptions/:id", async (req, res) => {
  const doctorId = me(req);
  const prescription = await getPrescription(pool, id("a prescription").parse(req.params.id));
  if (!prescription) throw new HttpError(404, "Prescription not found");
  // a doctor who isn't caring for the patient doesn't learn it exists
  await assertDoctorCanSeePatient(doctorId, prescription.patientId).catch(() => {
    throw new HttpError(404, "Prescription not found");
  });
  res.json(prescription);
});

// stop a prescription I wrote
doctorAppointmentsRouter.patch("/api/doctor/prescription-items/:id/stop", async (req, res) => {
  const doctorId = me(req);
  const itemId = id("a prescription").parse(req.params.id);

  const prescription = await withTransaction(async (client) => {
    const stopped = await client.query(
      `
      UPDATE prescription_item pi SET is_active = false
      FROM prescription rx
      WHERE pi.prescription_item_id = $1 AND rx.prescription_id = pi.prescription_id AND rx.prescriber_id = $2 AND pi.is_active
      RETURNING pi.prescription_id
      `,
      [itemId, doctorId]
    );
    if (!stopped.rowCount) {
      const current = await client.query(
        `SELECT 1 FROM prescription_item pi JOIN prescription rx ON rx.prescription_id = pi.prescription_id WHERE pi.prescription_item_id = $1 AND rx.prescriber_id = $2`,
        [itemId, doctorId]
      );
      if (!current.rowCount) throw new HttpError(404, "Prescription not found");
      throw new HttpError(409, "This medication was already stopped");
    }
    const prescriptionId = stopped.rows[0].prescription_id as number;
    // the prescription stays active while any of its medications are
    await client.query(
      `UPDATE prescription SET is_active = false WHERE prescription_id = $1 AND NOT EXISTS (SELECT 1 FROM prescription_item WHERE prescription_id = $1 AND is_active)`,
      [prescriptionId]
    );
    return getPrescription(client, prescriptionId);
  });
  res.json(prescription);
});

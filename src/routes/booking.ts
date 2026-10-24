import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { bookAppointment, cancelAppointment, findAvailability, getAppointment } from "../services/booking.js";
import { HttpError } from "../middleware/errorHandler.js";

export const bookingRouter = Router();

const id = z.coerce.number().int().positive();
const DATE_MESSAGE = "Date must look like 2026-11-10";

// shared with the public search. PostgreSQL has no year 0, so those dates stop here instead of failing in SQL
export const bookingDate = z.iso.date(DATE_MESSAGE).refine((value) => !value.startsWith("0000"), DATE_MESSAGE);

const availabilityQuery = z.object({
  date: bookingDate,
  days: z.coerce.number().int().min(1).max(14, "Search up to 14 days at a time").default(1),
  doctorId: id.optional(),
  specialtyId: id.optional(),
  officeId: id.optional(),
  patientId: id.optional(),
});

const bookingBody = z.object({
  patientId: z.number().int().positive().optional(),
  doctorId: z.number().int().positive(),
  specialtyId: z.number().int().positive(),
  date: bookingDate,
  timeSlotId: z.number().int().positive(),
  referralId: z.number().int().positive().nullable().optional(),
});

interface BookingUser {
  patientId?: number;
  receptionist?: { employeeId: number; officeId: number };
}

// only patients and receptionists can search, book, and cancel
async function getBookingUser(req: Request): Promise<BookingUser> {
  const { role, patientId, employeeId } = req.session;
  if (!role) throw new HttpError(401, "Login required");
  if (role === "patient" && patientId) return { patientId };

  // nurses and receptionists share the staff role, so the employee type decides
  if (role === "staff" && employeeId) {
    const result = await pool.query(
      `
      SELECT e.office_id AS "officeId"
      FROM employee e
      JOIN employee_types t ON t.employee_type_id = e.employee_type_id
      WHERE e.employee_id = $1
        AND e.is_active
        AND t.type_name ILIKE 'reception%'
        AND NOT EXISTS (SELECT 1 FROM nurse n WHERE n.employee_id = e.employee_id)
      `,
      [employeeId]
    );
    if (result.rowCount) return { receptionist: { employeeId, officeId: result.rows[0].officeId } };
  }

  throw new HttpError(403, "Only patients and receptionists can book appointments");
}

// open appointment times
bookingRouter.get("/api/availability", async (req, res) => {
  const user = await getBookingUser(req);
  const query = availabilityQuery.parse(req.query);

  if (user.patientId && query.patientId && query.patientId !== user.patientId) {
    throw new HttpError(403, "Patients can only search their own availability");
  }
  if (user.receptionist && query.officeId && query.officeId !== user.receptionist.officeId) {
    throw new HttpError(403, "Receptionists can only search their own office");
  }

  const slots = await findAvailability({
    ...query,
    officeId: user.receptionist?.officeId ?? query.officeId,
    patientId: user.patientId ?? query.patientId,
  });
  res.json(slots);
});

// book for the signed in patient, or for the patient a receptionist chose
bookingRouter.post("/api/appointments", async (req, res) => {
  const user = await getBookingUser(req);
  const body = bookingBody.parse(req.body);

  let patientId: number;
  if (user.patientId) {
    if (body.patientId && body.patientId !== user.patientId) {
      throw new HttpError(403, "Patients can only book appointments for themselves");
    }
    patientId = user.patientId;
  } else {
    if (!body.patientId) throw new HttpError(400, "Choose a patient for this appointment");
    patientId = body.patientId;
  }

  const appointment = await bookAppointment({
    patientId,
    doctorId: body.doctorId,
    specialtyId: body.specialtyId,
    date: body.date,
    timeSlotId: body.timeSlotId,
    referralId: body.referralId ?? null,
    receptionist: user.receptionist ?? null,
  });
  res.status(201).json(appointment);
});

// cancel but keep the record
bookingRouter.patch("/api/appointments/:id/cancel", async (req, res) => {
  const user = await getBookingUser(req);
  const appointmentId = id.parse(req.params.id);
  const appointment = await cancelAppointment(appointmentId, { patientId: user.patientId, officeId: user.receptionist?.officeId });
  res.json(appointment);
});

// one appointment, for a confirmation or details page
bookingRouter.get("/api/appointments/:id", async (req, res) => {
  const user = await getBookingUser(req);
  const appointmentId = id.parse(req.params.id);

  const appointment = await getAppointment(pool, appointmentId);
  if (!appointment || (user.patientId && appointment.patientId !== user.patientId)) {
    throw new HttpError(404, "Appointment not found");
  }
  if (user.receptionist && appointment.officeId !== user.receptionist.officeId) {
    throw new HttpError(403, "That appointment is at another office");
  }
  res.json(appointment);
});

import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { CLINIC_TODAY } from "../../lib/clinicTime.js";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { checkInAppointment, checkOutAppointment, listAppointments, markNoShow } from "../../services/booking.js";
import { bookingDate } from "../booking.js";

export const receptionistAppointmentsRouter = Router();

const idParam = z.coerce.number().int().positive();
const listQuery = z.object({
  date: bookingDate.optional(),
  search: z.string().trim().max(100).default(""),
});

// the office comes from the database on every request, never from the client
function myOffice(req: Request) {
  if (!req.user || req.user.role === "patient") throw new HttpError(401, "Login required");
  return req.user.officeId;
}

// the signed in receptionist, recorded in the appointment history
function myId(req: Request) {
  if (!req.user || req.user.role === "patient") throw new HttpError(401, "Login required");
  return req.user.employeeId;
}

// get one day's appointments at my office (date and patient name search)
receptionistAppointmentsRouter.get("/api/receptionist/appointments", async (req, res) => {
  const officeId = myOffice(req);
  const { date, search } = listQuery.parse(req.query);

  // get my office and today's date
  const office = await pool.query(
    `SELECT office_id AS "officeId", name AS "officeName", to_char(${CLINIC_TODAY}, 'YYYY-MM-DD') AS today FROM office WHERE office_id = $1`,
    [officeId]
  );

  // get the appointments at my office on the date (today when no date), matching the patient name
  const appointments = await listAppointments({ officeId }, { date: date ?? office.rows[0].today, search });

  res.json({
    officeId: office.rows[0].officeId,
    officeName: office.rows[0].officeName,
    today: office.rows[0].today,
    appointments,
  });
});

// check a patient in
receptionistAppointmentsRouter.patch("/api/receptionist/appointments/:id/check-in", async (req, res) => {
  const officeId = myOffice(req);
  res.json(await checkInAppointment(idParam.parse(req.params.id), officeId, myId(req)));
});

// check a patient out, which completes the visit
receptionistAppointmentsRouter.patch("/api/receptionist/appointments/:id/check-out", async (req, res) => {
  const officeId = myOffice(req);
  res.json(await checkOutAppointment(idParam.parse(req.params.id), officeId, myId(req)));
});

// mark that the patient never came
receptionistAppointmentsRouter.patch("/api/receptionist/appointments/:id/no-show", async (req, res) => {
  const officeId = myOffice(req);
  res.json(await markNoShow(idParam.parse(req.params.id), officeId, myId(req)));
});

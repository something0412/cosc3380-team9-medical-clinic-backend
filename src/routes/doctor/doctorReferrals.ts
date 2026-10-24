import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { createReferral, decideReferral, listDoctorReferrals, listSpecialists } from "../../services/referrals.js";
import { bookingDate } from "../booking.js";

export const doctorReferralsRouter = Router();

const id = (label: string) => z.coerce.number(`Choose a ${label}`).int(`Choose a ${label}`).positive(`Choose a ${label}`);
const listQuery = z.object({ view: z.enum(["sent", "received", "all"], "View must be sent, received or all").default("all") });
const referralBody = z.object({
  patientId: id("patient"),
  specialistDoctorId: id("specialist"),
  specialtyId: id("specialty"),
  expirationDate: bookingDate.optional(),
});
const decisionBody = z.object({ status: z.enum(["Approved", "Denied"], "Status must be Approved or Denied") });

// the doctor is whoever is signed in, never an ID from the request
function me(req: Request) {
  if (req.user?.role !== "doctor") throw new HttpError(401, "Login required");
  return req.user.employeeId;
}

// get referrals I sent and referrals sent to me
doctorReferralsRouter.get("/api/doctor/referrals", async (req, res) => {
  const { view } = listQuery.parse(req.query);
  res.json(await listDoctorReferrals(me(req), view));
});

// get specialists for the referral form
doctorReferralsRouter.get("/api/doctor/specialists", async (req, res) => {
  res.json(await listSpecialists(me(req)));
});

// send a referral, which always starts as Pending
doctorReferralsRouter.post("/api/doctor/referrals", async (req, res) => {
  const doctorId = me(req);
  res.status(201).json(await createReferral(doctorId, referralBody.parse(req.body)));
});

// approve or deny a referral sent to me
doctorReferralsRouter.patch("/api/doctor/referrals/:id/status", async (req, res) => {
  const doctorId = me(req);
  const referralId = id("referral").parse(req.params.id);
  const { status } = decisionBody.parse(req.body);
  res.json(await decideReferral(referralId, doctorId, status));
});

// get my open time slots on a date
doctorReferralsRouter.get("/api/doctor/open-slots", async (req, res) => {
  const doctorId = req.session.employeeId;
  const date = String(req.query.date ?? "");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "Pick a date" });
    return;
  }

  // get the doctor's free appointment times on that date
  const result = await pool.query(
    ``,
    [doctorId, date]
  );

  res.json(result.rows);
});

// book an appointment for a referral I approved
doctorReferralsRouter.post("/api/doctor/referrals/:id/appointment", async (req, res) => {
  const doctorId = req.session.employeeId;
  const referralId = Number(req.params.id);
  const date = String(req.body.date ?? "");
  const timeSlotId = Number(req.body.timeSlotId);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !timeSlotId) {
    res.status(400).json({ error: "Date and time are required" });
    return;
  }

  // get the approved referral and check the date is before it expires
  const referral = await pool.query(
    ``,
    [referralId, doctorId, date]
  );
  if (referral.rowCount === 0) {
    res.status(400).json({ error: "Pick a date from today until the referral expires" });
    return;
  }

  // check the referral doesn't already have an appointment
  const existing = await pool.query(
    ``,
    [referralId]
  );
  if (existing.rowCount !== 0) {
    res.status(400).json({ error: "This referral already has an appointment" });
    return;
  }

  // check the doctor works at that time and get the office
  const workDay = await pool.query(
    ``,
    [doctorId, date, timeSlotId]
  );
  if (workDay.rowCount === 0) {
    res.status(400).json({ error: "You aren't scheduled to work at that time" });
    return;
  }

  // check nobody already has that time
  const taken = await pool.query(
    ``,
    [doctorId, date, timeSlotId]
  );
  if (taken.rowCount !== 0) {
    res.status(400).json({ error: "That time is already booked" });
    return;
  }

  // save the new appointment
  const result = await pool.query(
    ``,
    [referral.rows[0].patient_id, doctorId, workDay.rows[0].office_id, referralId, date, timeSlotId, referral.rows[0].specialty_id]
  );

  res.status(201).json(result.rows[0]);
});

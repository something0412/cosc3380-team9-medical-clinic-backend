import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
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

import { Router } from "express";
import { pool } from "../../lib/db.js";

export const doctorReferralsRouter = Router();

// get referrals I sent and referrals sent to me
doctorReferralsRouter.get("/api/doctor/referrals", async (req, res) => {
  const doctorId = req.session.employeeId;

  // get the referrals the doctor sent
  const sent = await pool.query(
    ``,
    [doctorId]
  );

  // get the referrals sent to the doctor
  const received = await pool.query(
    ``,
    [doctorId]
  );

  res.json({ sent: sent.rows, received: received.rows });
});

// get specialists for the referral form
doctorReferralsRouter.get("/api/doctor/specialists", async (req, res) => {
  const doctorId = req.session.employeeId;

  // get the list of specialists the doctor can refer to
  const result = await pool.query(
    ``,
    [doctorId]
  );

  res.json(result.rows);
});

// send a referral
doctorReferralsRouter.post("/api/doctor/referrals", async (req, res) => {
  const doctorId = req.session.employeeId;
  const patientId = Number(req.body.patientId);
  const specialistDoctorId = Number(req.body.specialistDoctorId);
  const specialtyId = Number(req.body.specialtyId);
  const expirationDate = req.body.expirationDate || null;

  if (!patientId || !specialistDoctorId || !specialtyId) {
    res.status(400).json({ error: "Patient and specialist are required" });
    return;
  }

  // check this is one of the doctor's patients
  const access = await pool.query(
    ``,
    [doctorId, patientId]
  );
  if (access.rowCount === 0) {
    res.status(403).json({ error: "This patient isn't under your care" });
    return;
  }

  // check the specialist works in that specialty
  const specialist = await pool.query(
    ``,
    [specialistDoctorId, specialtyId]
  );
  if (specialist.rowCount === 0 || specialistDoctorId === doctorId) {
    res.status(400).json({ error: "Choose a different specialist" });
    return;
  }

  // save the new referral
  const result = await pool.query(
    ``,
    [patientId, doctorId, specialistDoctorId, specialtyId, expirationDate]
  );

  res.status(201).json(result.rows[0]);
});

// approve or deny a referral sent to me
doctorReferralsRouter.patch("/api/doctor/referrals/:id/status", async (req, res) => {
  const doctorId = req.session.employeeId;
  const referralId = Number(req.params.id);
  const status = req.body.status;

  if (status !== "Approved" && status !== "Denied") {
    res.status(400).json({ error: "Status must be Approved or Denied" });
    return;
  }

  // approve or deny a referral sent to the doctor
  const result = await pool.query(
    ``,
    [status, referralId, doctorId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Only pending referrals sent to you can be answered" });
    return;
  }

  res.json(result.rows[0]);
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

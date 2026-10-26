import { Router } from "express";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { listAppointments } from "../../services/booking.js";
import { LAB_ORDER_COLUMNS, LAB_ORDER_JOINS } from "../../services/clinical.js";
import { listDoctorReferrals } from "../../services/referrals.js";

export const doctorDashboardRouter = Router();

// get dashboard numbers and lists
doctorDashboardRouter.get("/api/doctor/dashboard", async (req, res) => {
  if (req.user?.role !== "doctor") throw new HttpError(401, "Login required");
  const doctorId = req.user.employeeId;

  // get how many patients are assigned to the doctor
  const myPatients = await pool.query(`-- TODO D01: dashboard: count patients assigned to me`, [doctorId]);

  // appointments come from the booking service, so they're counted the same way as the appointment list
  const today = await listAppointments({ doctorId }, { when: "today", includeCancelled: false });
  const later = await listAppointments({ doctorId }, { when: "upcoming", includeCancelled: false });
  const stillToSee = today.filter((a) => a.status === "Scheduled");

  // get how many of the doctor's lab orders are still waiting for results
  const pendingLabs = await pool.query(
    `-- TODO D02: dashboard: count my lab orders still waiting for results`,
    [doctorId]
  );

  // get how many referrals sent to the doctor still need an answer
  const { received } = await listDoctorReferrals(doctorId, "received");

  // get the doctor's newest lab results
  const recentResults = await pool.query(
    `-- TODO D03: dashboard: my 5 newest finished lab results`,
    [doctorId]
  );

  res.json({
    myPatients: myPatients.rows[0].count,
    todayAppointments: stillToSee.length,
    pendingLabs: pendingLabs.rows[0].count,
    referralsToReview: received.filter((r) => r.status === "Pending" && !r.expired).length,
    upcomingAppointments: [...stillToSee, ...later.filter((a) => a.status === "Scheduled")].slice(0, 5),
    recentResults: recentResults.rows,
  });
});

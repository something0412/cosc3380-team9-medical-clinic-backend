import { Router } from "express";
import { pool } from "../../lib/db.js";

export const doctorDashboardRouter = Router();

// get dashboard numbers and lists
doctorDashboardRouter.get("/api/doctor/dashboard", async (req, res) => {
  const doctorId = req.session.employeeId;

  // get how many patients are assigned to the doctor
  const myPatients = await pool.query(
    ``,
    [doctorId]
  );

  // get how many appointments the doctor has left today
  const todayAppointments = await pool.query(
    ``,
    [doctorId]
  );

  // get how many of the doctor's lab orders are still waiting for results
  const pendingLabs = await pool.query(
    ``,
    [doctorId]
  );

  // get how many referrals sent to the doctor still need an answer
  const referralsToReview = await pool.query(
    ``,
    [doctorId]
  );

  // get the doctor's next few appointments
  const upcoming = await pool.query(
    ``,
    [doctorId]
  );

  // get the doctor's newest lab results
  const recentResults = await pool.query(
    ``,
    [doctorId]
  );

  res.json({
    myPatients: myPatients.rows[0].count,
    todayAppointments: todayAppointments.rows[0].count,
    pendingLabs: pendingLabs.rows[0].count,
    referralsToReview: referralsToReview.rows[0].count,
    upcomingAppointments: upcoming.rows,
    recentResults: recentResults.rows,
  });
});

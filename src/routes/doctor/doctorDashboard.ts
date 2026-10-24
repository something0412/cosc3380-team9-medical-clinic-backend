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
  const myPatients = await pool.query(`SELECT count(*)::int AS count FROM patient_doctor WHERE doctor_id = $1 AND is_active`, [doctorId]);

  // appointments come from the booking service, so they're counted the same way as the appointment list
  const today = await listAppointments({ doctorId }, { when: "today", includeCancelled: false });
  const later = await listAppointments({ doctorId }, { when: "upcoming", includeCancelled: false });
  const stillToSee = today.filter((a) => a.status === "Scheduled");

  // get how many of the doctor's lab orders are still waiting for results
  const pendingLabs = await pool.query(
    `SELECT count(*)::int AS count FROM lab_order WHERE ordered_by_employee_id = $1 AND status IN ('Ordered', 'InProgress')`,
    [doctorId]
  );

  // get how many referrals sent to the doctor still need an answer
  const { received } = await listDoctorReferrals(doctorId, "received");

  // get the doctor's newest lab results
  const recentResults = await pool.query(
    `SELECT ${LAB_ORDER_COLUMNS} FROM lab_order l ${LAB_ORDER_JOINS}
     WHERE l.ordered_by_employee_id = $1 AND l.status = 'Completed' ORDER BY l.result_date DESC NULLS LAST, l.lab_order_id DESC LIMIT 5`,
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

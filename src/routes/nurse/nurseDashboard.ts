import { Router } from "express";
import { pool } from "../../lib/db.js";
import { listAppointments } from "../../services/booking.js";
import { asClinician } from "../../services/clinical.js";

export const nurseDashboardRouter = Router();

// get dashboard numbers and the waiting list
nurseDashboardRouter.get("/api/nurse/dashboard", async (req, res) => {
  const { officeId } = asClinician(req.user, "nurse");

  // today's visits come from the booking service, so they're counted the same way as the appointment list
  const today = (await listAppointments({ officeId }, { when: "today", includeCancelled: false })).filter((a) => a.status !== "No Show");
  const withVitals = await pool.query(`SELECT DISTINCT appointment_id AS "appointmentId" FROM patient_vitals WHERE appointment_id = ANY($1::int[])`, [
    today.map((a) => a.appointmentId),
  ]);
  const hasVitals = new Set(withVitals.rows.map((v) => v.appointmentId));

  // checked in patients still in the clinic, and the ones with no vitals for this visit yet, earliest arrival first
  const inClinic = today.filter((a) => a.status === "Scheduled" && a.checkedIn);
  const waitingList = inClinic.filter((a) => !hasVitals.has(a.appointmentId)).sort((a, b) => a.checkedInAt.localeCompare(b.checkedInAt));

  res.json({
    todayAppointments: today.length,
    notArrived: today.filter((a) => a.status === "Scheduled" && !a.checkedIn).length,
    checkedIn: inClinic.length,
    completed: today.filter((a) => a.status === "Completed").length,
    waitingForVitals: waitingList.length,
    waitingList,
  });
});

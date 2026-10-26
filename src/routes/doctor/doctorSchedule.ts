import { Router } from "express";
import { CLINIC_TODAY } from "../../lib/clinicTime.js";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { getWeeklySchedule } from "../staff/profile.js";

export const doctorScheduleRouter = Router();

// get my weekly schedule
doctorScheduleRouter.get("/api/doctor/schedule", async (req, res) => {
  if (req.user?.role !== "doctor") throw new HttpError(401, "Login required");
  const doctorId = req.user.employeeId;

  // get how many appointments the doctor has each day for the next two weeks
  const appointments = await pool.query(
    `-- TODO D22: how many appointments I have each day for the next two weeks`,
    [doctorId]
  );

  res.json({ schedule: await getWeeklySchedule(doctorId), upcomingDays: appointments.rows });
});

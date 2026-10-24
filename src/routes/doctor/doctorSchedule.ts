import { Router } from "express";
import { pool } from "../../lib/db.js";

export const doctorScheduleRouter = Router();

// get my weekly schedule
doctorScheduleRouter.get("/api/doctor/schedule", async (req, res) => {
  const doctorId = req.session.employeeId;

  // get the doctor's weekly schedule
  const result = await pool.query(
    ``,
    [doctorId]
  );

  // get how many appointments the doctor has each day for the next two weeks
  const appointments = await pool.query(
    ``,
    [doctorId]
  );

  res.json({ schedule: result.rows, upcomingDays: appointments.rows });
});

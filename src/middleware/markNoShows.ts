import type { RequestHandler } from "express";
import { CLINIC_NOW } from "../lib/clinicTime.js";
import { pool } from "../lib/db.js";

let lastRun = 0;

// appointments whose time is over and the patient never checked in become No Show
// it runs before requests, at most once a minute, so every list shows up to date statuses
export const markNoShows: RequestHandler = async (_req, _res, next) => {
  if (Date.now() - lastRun < 60_000) return next();
  lastRun = Date.now();
  try {
    await pool.query(
      `
      UPDATE appointment a
      SET status = 'No Show'
      FROM time_slot ts
      WHERE ts.time_slot_id = a.time_slot_id
        AND a.status = 'Scheduled'
        AND a.checked_in_at IS NULL
        AND a.appointment_date + ts.end_time <= ${CLINIC_NOW}
      `
    );
    next();
  } catch (err) {
    next(err);
  }
};

import { Router } from "express";
import { pool } from "../../lib/db.js";

export const nurseDashboardRouter = Router();

// get dashboard numbers and the waiting list
nurseDashboardRouter.get("/api/nurse/dashboard", async (req, res) => {
  const nurseId = req.session.employeeId;

  // get how many scheduled or completed appointments my office has today (Houston date)
  const todayAppointments = await pool.query(
    ``,
    [nurseId]
  );

  // get how many of today's scheduled appointments at my office have no vitals yet
  const waitingForVitals = await pool.query(
    ``,
    [nurseId]
  );

  // get how many vitals recorded today at my office have a critical reading
  const criticalToday = await pool.query(
    ``,
    [nurseId]
  );

  // get how many active supplies at my office are at or below their reorder threshold
  const lowStock = await pool.query(
    ``,
    [nurseId]
  );

  // get today's patients at my office still waiting for vitals, earliest first
  const waitingList = await pool.query(
    ``,
    [nurseId]
  );

  res.json({
    todayAppointments: todayAppointments.rows[0].count,
    waitingForVitals: waitingForVitals.rows[0].count,
    criticalToday: criticalToday.rows[0].count,
    lowStock: lowStock.rows[0].count,
    waitingList: waitingList.rows,
  });
});

import { Router } from "express";
import { pool } from "../../lib/db.js";

export const receptionistDashboardRouter = Router();

// get dashboard numbers and today's list
receptionistDashboardRouter.get("/api/receptionist/dashboard", async (req, res) => {
  const receptionistId = req.session.employeeId;

  // get my office's name
  const office = await pool.query(
    ``,
    [receptionistId]
  );

  // get how many scheduled appointments my office has today
  const todayAppointments = await pool.query(
    ``,
    [receptionistId]
  );

  // get how many unpaid invoices my office has and how much is left on them
  const unpaid = await pool.query(
    ``,
    [receptionistId]
  );

  // get how many insurance records still need to be verified
  const pendingInsurance = await pool.query(
    ``
  );

  // get today's appointments at my office (not cancelled), earliest first
  const todayList = await pool.query(
    ``,
    [receptionistId]
  );

  res.json({
    officeName: office.rows[0]?.officeName ?? "",
    todayAppointments: todayAppointments.rows[0].count,
    unpaidInvoices: unpaid.rows[0].count,
    unpaidTotal: unpaid.rows[0].total,
    pendingInsurance: pendingInsurance.rows[0].count,
    todayList: todayList.rows,
  });
});

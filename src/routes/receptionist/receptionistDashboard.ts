import { Router } from "express";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { INVOICE_BALANCES } from "../../services/billing.js";
import { listAppointments } from "../../services/booking.js";

export const receptionistDashboardRouter = Router();

// get dashboard numbers and today's list
receptionistDashboardRouter.get("/api/receptionist/dashboard", async (req, res) => {
  if (!req.user || req.user.role === "patient") throw new HttpError(401, "Login required");
  const { officeId } = req.user;

  // get my office's name
  const office = await pool.query(`SELECT name AS "officeName" FROM office WHERE office_id = $1`, [officeId]);

  // today's visits come from the booking service, so they match the appointment list
  const todayList = await listAppointments({ officeId }, { when: "today", includeCancelled: false });

  // get how many unpaid invoices my office has and how much is left on them, using the same balance as billing
  const unpaid = await pool.query(
    `
    SELECT count(*)::int AS count, COALESCE(sum(b.balance), 0)::numeric(10, 2) AS total
    FROM (${INVOICE_BALANCES}) b
    JOIN invoice i ON i.invoice_id = b.invoice_id
    JOIN appointment a ON a.appointment_id = i.appointment_id
    WHERE a.office_id = $1 AND b.balance > 0
    `,
    [officeId]
  );

  // get how many insurance records still need to be verified
  const pendingInsurance = await pool.query(`SELECT count(*)::int AS count FROM insurance WHERE status = 'Pending'`);

  res.json({
    officeName: office.rows[0]?.officeName ?? "",
    todayAppointments: todayList.filter((a) => a.status === "Scheduled").length,
    unpaidInvoices: unpaid.rows[0].count,
    unpaidTotal: unpaid.rows[0].total,
    pendingInsurance: pendingInsurance.rows[0].count,
    todayList,
  });
});
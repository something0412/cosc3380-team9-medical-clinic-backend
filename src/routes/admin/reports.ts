import { Router } from "express";
import { z } from "zod";
import { CLINIC_NOW } from "../../lib/clinicTime.js";
import { pool } from "../../lib/db.js";

export const adminReportsRouter = Router();

const yearQuery = z.coerce.number().int().min(2000).max(2100).optional();

adminReportsRouter.get("/dashboard", async (req, res) => {
  const year = yearQuery.parse(req.query.year) ?? new Date().getFullYear();

  const patients = await pool.query(`
    SELECT count(*)::int AS "activePatients"
    FROM patient
    WHERE is_active
  `);

  const upcoming = await pool.query(`
    SELECT count(*)::int AS "upcomingVisits"
    FROM appointment a
    JOIN time_slot t ON t.time_slot_id = a.time_slot_id
    WHERE a.status = 'Scheduled'
      AND a.appointment_date + t.start_time >= ${CLINIC_NOW}
  `);

  const money = await pool.query(`
    SELECT
      (SELECT COALESCE(sum(amount_paid), 0) FROM payment)::float AS collected,
      (
        SELECT COALESCE(sum(i.amount - COALESCE(p.paid, 0)), 0)
        FROM invoice i
        LEFT JOIN (
          SELECT invoice_id, sum(amount_paid) AS paid
          FROM payment
          GROUP BY invoice_id
        ) p ON p.invoice_id = i.invoice_id
        WHERE i.status <> 'Paid'
      )::float AS pending
  `);

  const signups = await pool.query(
    `
    SELECT m.month, count(c.patient_creds_id)::int AS signups
    FROM generate_series(1, 12) AS m(month)
    LEFT JOIN patient_creds c
      ON EXTRACT(MONTH FROM c.created_date) = m.month
      AND EXTRACT(YEAR FROM c.created_date) = $1
    GROUP BY m.month
    ORDER BY m.month
    `,
    [year]
  );

  res.json({
    ...patients.rows[0],
    ...upcoming.rows[0],
    ...money.rows[0],
    year,
    signupsByMonth: signups.rows,
  });
});

// appointment activity
adminReportsRouter.get("/analytics/appointments", async (_req, res) => {
  const summary = await pool.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status <> 'Scheduled')::int AS "pastTotal",
      count(*) FILTER (WHERE status = 'Completed')::int AS completed,
      count(*) FILTER (WHERE status = 'Scheduled')::int AS scheduled,
      count(*) FILTER (WHERE status = 'Cancelled')::int AS cancelled,
      count(*) FILTER (WHERE status = 'No Show')::int AS "noShows",
      count(*) FILTER (WHERE booking_channel = 'Phone')::int AS "phoneBookings",
      count(*) FILTER (WHERE booking_channel = 'Web')::int AS "webBookings"
    FROM appointment
  `);

  const byStatus = await pool.query(`
    SELECT s.status, count(a.appointment_id)::int AS count
    FROM (VALUES (1, 'Completed'), (2, 'Scheduled'), (3, 'Cancelled'), (4, 'No Show')) AS s(sort, status)
    LEFT JOIN appointment a ON a.status = s.status
    GROUP BY s.sort, s.status
    ORDER BY s.sort
  `);

  const bySpecialty = await pool.query(`
    SELECT
      s.name AS specialty,
      count(a.appointment_id) FILTER (WHERE a.status = 'Completed')::int AS completed,
      count(a.appointment_id) FILTER (WHERE a.status = 'Scheduled')::int AS scheduled,
      count(a.appointment_id) FILTER (WHERE a.status = 'Cancelled')::int AS cancelled,
      count(a.appointment_id) FILTER (WHERE a.status = 'No Show')::int AS "noShows",
      count(a.appointment_id)::int AS total
    FROM specialty s
    LEFT JOIN appointment a ON a.specialty_id = s.specialty_id
    WHERE s.is_active
    GROUP BY s.specialty_id, s.name
    ORDER BY total DESC, s.name
  `);

  res.json({ ...summary.rows[0], byStatus: byStatus.rows, bySpecialty: bySpecialty.rows });
});

// billing and collections
adminReportsRouter.get("/analytics/billing", async (req, res) => {
  const year = yearQuery.parse(req.query.year) ?? new Date().getFullYear();

  const summary = await pool.query(`
    SELECT
      (SELECT COALESCE(sum(amount), 0) FROM invoice)::float AS billed,
      (SELECT COALESCE(sum(amount_paid), 0) FROM payment)::float AS collected,
      (SELECT count(*) FROM invoice)::int AS "invoiceCount",
      (SELECT count(*) FROM invoice WHERE status = 'Paid')::int AS "paidCount",
      (SELECT count(*) FROM invoice WHERE status = 'Pending')::int AS "pendingCount",
      (SELECT count(*) FROM invoice WHERE status = 'Overdue')::int AS "overdueCount"
  `);

  const balances = await pool.query(`
    SELECT
      COALESCE(sum(i.amount - COALESCE(p.paid, 0)) FILTER (WHERE i.status <> 'Paid'), 0)::float AS outstanding,
      COALESCE(sum(i.amount - COALESCE(p.paid, 0)) FILTER (WHERE i.status = 'Overdue'), 0)::float AS overdue
    FROM invoice i
    LEFT JOIN (
      SELECT invoice_id, sum(amount_paid) AS paid
      FROM payment
      GROUP BY invoice_id
    ) p ON p.invoice_id = i.invoice_id
  `);

  const byMonth = await pool.query(
    `
    SELECT
      m.month,
      (SELECT COALESCE(sum(amount), 0) FROM invoice
        WHERE EXTRACT(YEAR FROM issue_date) = $1 AND EXTRACT(MONTH FROM issue_date) = m.month)::float AS billed,
      (SELECT COALESCE(sum(amount_paid), 0) FROM payment
        WHERE EXTRACT(YEAR FROM payment_date) = $1 AND EXTRACT(MONTH FROM payment_date) = m.month)::float AS collected
    FROM generate_series(1, 12) AS m(month)
    ORDER BY m.month
    `,
    [year]
  );

  const byPaymentType = await pool.query(`
    SELECT t.name AS "paymentType", count(p.payment_id)::int AS payments, COALESCE(sum(p.amount_paid), 0)::float AS amount
    FROM payment_type t
    LEFT JOIN payment p ON p.payment_type_id = t.payment_type_id
    WHERE t.is_active
    GROUP BY t.payment_type_id, t.name
    ORDER BY amount DESC
  `);

  const unpaid = await pool.query(`
    SELECT
      i.invoice_id AS "invoiceId",
      pt.first_name || ' ' || pt.last_name AS "patientName",
      to_char(i.issue_date, 'YYYY-MM-DD') AS "issueDate",
      i.amount::float AS amount,
      (i.amount - COALESCE(sum(p.amount_paid), 0))::float AS balance,
      i.status
    FROM invoice i
    JOIN patient pt ON pt.patient_id = i.patient_id
    LEFT JOIN payment p ON p.invoice_id = i.invoice_id
    WHERE i.status <> 'Paid'
    GROUP BY i.invoice_id, pt.first_name, pt.last_name
    ORDER BY i.issue_date
  `);

  res.json({
    ...summary.rows[0],
    ...balances.rows[0],
    year,
    byMonth: byMonth.rows,
    byPaymentType: byPaymentType.rows,
    unpaidInvoices: unpaid.rows,
  });
});

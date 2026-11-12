import { Router } from "express";
import { z } from "zod";
import { CLINIC_TIME_ZONE, CLINIC_TODAY } from "../../lib/clinicTime.js";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { bookingDate } from "../booking.js";

// mounted at /api/admin behind requireRole("admin")
export const adminDataReportsRouter = Router();

const optionalId = z.coerce.number().int().positive().optional();
const dates = { from: bookingDate, to: bookingDate };
const inOrder = (r: { from: string; to: string }) => r.from <= r.to;
const ORDER_MESSAGE = { message: "The start date must be on or before the end date" };

const missedQuery = z
  .object({
    ...dates,
    officeId: optionalId,
    doctorId: optionalId,
    specialtyId: optionalId,
    patient: z.string().trim().max(100).default(""),
    channel: z.enum(["Web", "Phone"]).optional(),
    outcome: z.enum(["missed", "noshow", "cancelled", "late"]).default("missed"),
    groupBy: z.enum(["doctor", "office", "specialty"]).default("doctor"),
  })
  .refine(inOrder, ORDER_MESSAGE);

const unpaidQuery = z
  .object({
    ...dates,
    officeId: optionalId,
    doctorId: optionalId,
    specialtyId: optionalId,
    patient: z.string().trim().max(100).default(""),
    payer: z.string().trim().max(100).default(""),
    insuranceStatus: z.enum(["Verified", "Pending", "Denied", "None"]).optional(),
    invoiceStatus: z.enum(["Pending", "Overdue", "Partly Paid"]).optional(),
    daysUnpaid: z.enum(["0-30", "31-60", "61-90", "90+"]).optional(),
    minBalance: z.coerce.number().min(0).default(0),
  })
  .refine(inOrder, ORDER_MESSAGE);

const utilizationQuery = z
  .object({
    ...dates,
    officeId: optionalId,
    doctorId: optionalId,
    specialtyId: optionalId,
    dayOfWeek: z.enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]).optional(),
    shiftTypeId: optionalId,
    minUtilization: z.coerce.number().min(0).max(100).default(0),
    maxUtilization: z.coerce.number().min(0).max(100).default(100),
  })
  .refine(inOrder, ORDER_MESSAGE);

// a patient filter matches a name or a patient ID
const PATIENT_MATCH = (param: string) =>
  `(${param} = '' OR p.first_name || ' ' || p.last_name ILIKE '%' || ${param} || '%' OR p.patient_id::text = ltrim(${param}, '0'))`;

// get the choices for the report filters
adminDataReportsRouter.get("/data-reports/options", async (_req, res) => {
  const offices = await pool.query(`SELECT office_id AS "officeId", name FROM office ORDER BY name`);
  const doctors = await pool.query(
    `SELECT e.employee_id AS "doctorId", e.first_name || ' ' || e.last_name AS name
     FROM doctor d JOIN employee e ON e.employee_id = d.employee_id ORDER BY e.last_name, e.first_name`
  );
  const specialties = await pool.query(`SELECT specialty_id AS "specialtyId", name FROM specialty ORDER BY name`);
  const providers = await pool.query(`SELECT DISTINCT provider FROM insurance ORDER BY provider`);
  const shifts = await pool.query(`SELECT shift_type_id AS "shiftTypeId", name FROM shift_type ORDER BY start_time, end_time`);
  res.json({
    offices: offices.rows,
    doctors: doctors.rows,
    specialties: specialties.rows,
    providers: providers.rows.map((r) => r.provider),
    shifts: shifts.rows,
  });
});

// missed appointments: where no-shows and cancellations come from
adminDataReportsRouter.get("/data-reports/missed-appointments", async (req, res) => {
  const q = missedQuery.parse(req.query);
  const params = [q.from, q.to, q.officeId ?? null, q.doctorId ?? null, q.specialtyId ?? null, q.channel ?? null, q.patient];

  // every appointment in the range, with late cancellations (within 24 hours of the start) marked
  const visits = `
    WITH visits AS (
      SELECT
        a.appointment_id,
        a.patient_id,
        p.first_name || ' ' || p.last_name AS patient_name,
        p.phone,
        a.doctor_id,
        e.first_name || ' ' || e.last_name AS doctor_name,
        a.office_id,
        o.name AS office_name,
        a.specialty_id,
        sp.name AS specialty_name,
        a.appointment_date,
        ts.start_time,
        a.status,
        a.booking_channel,
        a.status = 'Cancelled' AND EXISTS (
          SELECT 1 FROM appointment_history h
          WHERE h.appointment_id = a.appointment_id
            AND h.new_status = 'Cancelled'
            AND h.old_status IS DISTINCT FROM 'Cancelled'
            AND h.changed_at > ((a.appointment_date + ts.start_time) AT TIME ZONE '${CLINIC_TIME_ZONE}') - interval '24 hours'
        ) AS late_cancel
      FROM appointment a
      JOIN patient p ON p.patient_id = a.patient_id
      JOIN employee e ON e.employee_id = a.doctor_id
      JOIN office o ON o.office_id = a.office_id
      JOIN specialty sp ON sp.specialty_id = a.specialty_id
      JOIN time_slot ts ON ts.time_slot_id = a.time_slot_id
      WHERE a.appointment_date BETWEEN $1 AND $2
        AND ($3::int IS NULL OR a.office_id = $3)
        AND ($4::int IS NULL OR a.doctor_id = $4)
        AND ($5::int IS NULL OR a.specialty_id = $5)
        AND ($6::text IS NULL OR a.booking_channel = $6)
        AND ${PATIENT_MATCH("$7")}
    )
  `;

  const summary = await pool.query(
    `${visits}
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'Completed')::int AS completed,
      count(*) FILTER (WHERE status = 'No Show')::int AS "noShows",
      count(*) FILTER (WHERE status = 'Cancelled')::int AS cancelled,
      count(*) FILTER (WHERE late_cancel)::int AS "lateCancelled",
      count(*) FILTER (WHERE status = 'Scheduled')::int AS scheduled
    FROM visits`,
    params
  );

  // the group column comes from a fixed list, never from the request text
  const group = { doctor: ["doctor_id", "doctor_name"], office: ["office_id", "office_name"], specialty: ["specialty_id", "specialty_name"] }[q.groupBy];
  const groups = await pool.query(
    `${visits}
    SELECT
      ${group[0]} AS id,
      ${group[1]} AS name,
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'Completed')::int AS completed,
      count(*) FILTER (WHERE status = 'No Show')::int AS "noShows",
      count(*) FILTER (WHERE status = 'Cancelled')::int AS cancelled,
      count(*) FILTER (WHERE late_cancel)::int AS "lateCancelled",
      round(100.0 * count(*) FILTER (WHERE status = 'No Show') / NULLIF(count(*) FILTER (WHERE status IN ('Completed', 'No Show')), 0), 1)::float AS "noShowRate",
      round(100.0 * count(*) FILTER (WHERE status = 'Cancelled') / NULLIF(count(*), 0), 1)::float AS "cancelRate"
    FROM visits
    GROUP BY ${group[0]}, ${group[1]}
    ORDER BY "noShowRate" DESC NULLS LAST, name`,
    params
  );

  const outcome = {
    missed: "status IN ('No Show', 'Cancelled')",
    noshow: "status = 'No Show'",
    cancelled: "status = 'Cancelled'",
    late: "late_cancel",
  }[q.outcome];
  const missed = await pool.query(
    `${visits}
    SELECT
      appointment_id AS "appointmentId",
      patient_id AS "patientId",
      patient_name AS "patientName",
      phone,
      to_char(appointment_date, 'YYYY-MM-DD') AS date,
      to_char(start_time, 'HH24:MI') AS time,
      doctor_name AS "doctorName",
      office_name AS "officeName",
      specialty_name AS specialty,
      booking_channel AS channel,
      CASE WHEN status = 'No Show' THEN 'No Show' WHEN late_cancel THEN 'Late Cancellation' ELSE 'Cancelled' END AS outcome
    FROM visits
    WHERE ${outcome}
    ORDER BY appointment_date DESC, start_time DESC`,
    params
  );

  // every appointment behind the counts, for the details pop-up on each group row
  const appointments = await pool.query(
    `${visits}
    SELECT
      appointment_id AS "appointmentId",
      ${group[0]} AS "groupId",
      to_char(appointment_date, 'YYYY-MM-DD') AS date,
      to_char(start_time, 'HH24:MI') AS time,
      patient_name AS "patientName",
      doctor_name AS "doctorName",
      office_name AS "officeName",
      CASE WHEN late_cancel THEN 'Late Cancellation' ELSE status END AS status
    FROM visits
    ORDER BY appointment_date DESC, start_time DESC`,
    params
  );

  res.json({ summary: summary.rows[0], groups: groups.rows, missed: missed.rows, appointments: appointments.rows });
});

// unpaid balances: who owes the clinic, for how long, and which payer is behind
adminDataReportsRouter.get("/data-reports/unpaid-balances", async (req, res) => {
  const q = unpaidQuery.parse(req.query);
  const params = [
    q.from,
    q.to,
    q.officeId ?? null,
    q.doctorId ?? null,
    q.specialtyId ?? null,
    q.patient,
    q.payer,
    q.insuranceStatus ?? null,
  ];

  // every invoice in the range with what's been paid, what's left and how long it's been open
  const bills = `
    WITH bills AS (
      SELECT
        i.invoice_id,
        i.patient_id,
        p.first_name || ' ' || p.last_name AS patient_name,
        p.phone,
        i.amount,
        i.status,
        i.issue_date,
        ${CLINIC_TODAY} - i.issue_date AS days_unpaid,
        COALESCE(pay.paid, 0) AS paid,
        i.amount - COALESCE(pay.paid, 0) AS balance,
        pay.last_payment,
        ins.provider,
        COALESCE(ins.status, 'None') AS insurance_status,
        CASE WHEN ins.status = 'Verified' THEN ins.provider ELSE 'Self-pay' END AS payer
      FROM invoice i
      JOIN patient p ON p.patient_id = i.patient_id
      JOIN appointment a ON a.appointment_id = i.appointment_id
      LEFT JOIN insurance ins ON ins.patient_id = i.patient_id
      LEFT JOIN (
        SELECT invoice_id, sum(amount_paid) AS paid, max(payment_date) AS last_payment
        FROM payment WHERE status <> 'Refunded' GROUP BY invoice_id
      ) pay ON pay.invoice_id = i.invoice_id
      WHERE i.status <> 'Void'
        AND i.issue_date BETWEEN $1 AND $2
        AND ($3::int IS NULL OR a.office_id = $3)
        AND ($4::int IS NULL OR a.doctor_id = $4)
        AND ($5::int IS NULL OR a.specialty_id = $5)
        AND ${PATIENT_MATCH("$6")}
        AND ($7 = '' OR ($7 = 'Self-pay' AND (ins.status IS NULL OR ins.status <> 'Verified')) OR (ins.provider = $7 AND ins.status = 'Verified'))
        AND ($8::text IS NULL OR COALESCE(ins.status, 'None') = $8)
    )
  `;

  // only invoices with money still owed, narrowed by status and how long they've been open
  const unpaidWhere = `
    balance > 0
    AND ($9::text IS NULL
      OR ($9 = 'Partly Paid' AND paid > 0)
      OR ($9 IN ('Pending', 'Overdue') AND status = $9))
    AND ($10::text IS NULL
      OR ($10 = '0-30' AND days_unpaid <= 30)
      OR ($10 = '31-60' AND days_unpaid BETWEEN 31 AND 60)
      OR ($10 = '61-90' AND days_unpaid BETWEEN 61 AND 90)
      OR ($10 = '90+' AND days_unpaid > 90))
  `;
  const unpaidParams = [...params, q.invoiceStatus ?? null, q.daysUnpaid ?? null];

  const summary = await pool.query(
    `${bills}
    SELECT
      count(*)::int AS invoices,
      COALESCE(sum(amount), 0)::float AS billed,
      COALESCE(sum(paid), 0)::float AS collected,
      COALESCE(sum(balance) FILTER (WHERE balance > 0), 0)::float AS outstanding,
      round(100.0 * COALESCE(sum(paid), 0) / NULLIF(sum(amount), 0), 1)::float AS "collectionRate"
    FROM bills`,
    params
  );

  const aging = await pool.query(
    `${bills}
    SELECT
      CASE WHEN days_unpaid <= 30 THEN '0-30' WHEN days_unpaid <= 60 THEN '31-60' WHEN days_unpaid <= 90 THEN '61-90' ELSE '90+' END AS bucket,
      count(*)::int AS invoices,
      sum(balance)::float AS amount
    FROM bills
    WHERE ${unpaidWhere}
    GROUP BY 1
    ORDER BY min(days_unpaid)`,
    unpaidParams
  );

  const payers = await pool.query(
    `${bills}
    SELECT payer, count(DISTINCT patient_id)::int AS patients, count(*)::int AS invoices, sum(balance)::float AS amount
    FROM bills
    WHERE ${unpaidWhere}
    GROUP BY payer
    ORDER BY amount DESC`,
    unpaidParams
  );

  const patients = await pool.query(
    `${bills}
    SELECT
      patient_id AS "patientId",
      patient_name AS "patientName",
      phone,
      max(payer) AS payer,
      max(insurance_status) AS "insuranceStatus",
      count(*)::int AS invoices,
      sum(balance)::float AS balance,
      max(days_unpaid)::int AS "oldestDays",
      to_char(max(last_payment), 'YYYY-MM-DD') AS "lastPayment"
    FROM bills
    WHERE ${unpaidWhere}
    GROUP BY patient_id, patient_name, phone
    HAVING sum(balance) >= $11
    ORDER BY balance DESC`,
    [...unpaidParams, q.minBalance]
  );

  // each unpaid invoice, for the pop-up on each patient row
  const unpaidInvoices = await pool.query(
    `${bills}
    SELECT
      invoice_id AS "invoiceId",
      patient_id AS "patientId",
      to_char(issue_date, 'YYYY-MM-DD') AS "issueDate",
      amount::float AS amount,
      paid::float AS paid,
      balance::float AS balance,
      days_unpaid::int AS "daysUnpaid",
      CASE WHEN paid > 0 THEN 'Partly Paid' ELSE status END AS status
    FROM bills
    WHERE ${unpaidWhere}
    ORDER BY issue_date, invoice_id`,
    unpaidParams
  );

  // invoices paid in full, newest payment first
  const paidInvoices = await pool.query(
    `${bills}
    SELECT
      invoice_id AS "invoiceId",
      patient_id AS "patientId",
      patient_name AS "patientName",
      payer,
      to_char(issue_date, 'YYYY-MM-DD') AS "issueDate",
      amount::float AS amount,
      to_char(last_payment, 'YYYY-MM-DD') AS "paidOn"
    FROM bills
    WHERE balance <= 0
    ORDER BY last_payment DESC NULLS LAST, invoice_id DESC`,
    params
  );

  res.json({
    summary: summary.rows[0],
    aging: aging.rows,
    payers: payers.rows,
    patients: patients.rows,
    unpaidInvoices: unpaidInvoices.rows,
    paidInvoices: paidInvoices.rows,
  });
});

// schedule utilization: how full each doctor's schedule is compared to the slots it offers
adminDataReportsRouter.get("/data-reports/schedule-utilization", async (req, res) => {
  const q = utilizationQuery.parse(req.query);
  const params = [q.from, q.to, q.officeId ?? null, q.doctorId ?? null, q.specialtyId ?? null, q.dayOfWeek ?? null, q.shiftTypeId ?? null];

  // every slot each doctor's schedule offers on each day, with the appointment booked in it if any
  const slots = `
    WITH slots AS (
      SELECT
        d.day::date AS day,
        to_char(d.day, 'FMDay') AS day_of_week,
        ds.doctor_id,
        e.first_name || ' ' || e.last_name AS doctor_name,
        o.name AS office_name,
        sp.name AS specialty_name,
        a.status
      FROM generate_series($1::date, $2::date, interval '1 day') d(day)
      JOIN doctor_schedule ds ON ds.is_active AND ds.day_of_week = to_char(d.day, 'FMDay')
      JOIN employee e ON e.employee_id = ds.doctor_id
      JOIN office o ON o.office_id = ds.office_id
      JOIN specialty sp ON sp.specialty_id = ds.specialty_id
      JOIN shift_type st ON st.shift_type_id = ds.shift_type_id
      JOIN time_slot ts ON ts.shift_type_id = st.shift_type_id AND ts.is_active
      LEFT JOIN appointment a ON a.doctor_id = ds.doctor_id AND a.appointment_date = d.day::date
        AND a.time_slot_id = ts.time_slot_id AND a.status <> 'Cancelled'
      WHERE ($3::int IS NULL OR ds.office_id = $3)
        AND ($4::int IS NULL OR ds.doctor_id = $4)
        AND ($5::int IS NULL OR ds.specialty_id = $5)
        AND ($6::text IS NULL OR ds.day_of_week = $6)
        AND ($7::int IS NULL OR ds.shift_type_id = $7)
    )
  `;
  const counts = `
    count(*)::int AS offered,
    count(status)::int AS booked,
    (count(*) - count(status))::int AS open,
    count(*) FILTER (WHERE status = 'Completed')::int AS completed,
    count(*) FILTER (WHERE status = 'No Show')::int AS "noShows",
    round(100.0 * count(status) / NULLIF(count(*), 0), 1)::float AS utilization
  `;

  const summary = await pool.query(`${slots} SELECT ${counts} FROM slots`, params);

  const doctors = await pool.query(
    `${slots}
    SELECT
      doctor_id AS "doctorId",
      doctor_name AS "doctorName",
      string_agg(DISTINCT office_name, ', ') AS offices,
      string_agg(DISTINCT specialty_name, ', ') AS specialties,
      ${counts}
    FROM slots
    GROUP BY doctor_id, doctor_name
    HAVING coalesce(100.0 * count(status) / NULLIF(count(*), 0), 0) BETWEEN $8 AND $9
    ORDER BY utilization DESC NULLS LAST, doctor_name`,
    [...params, q.minUtilization, q.maxUtilization]
  );

  const days = await pool.query(
    `${slots}
    SELECT day_of_week AS "dayOfWeek", ${counts}
    FROM slots
    GROUP BY day_of_week
    ORDER BY array_position(ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'], day_of_week)`,
    params
  );

  res.json({ summary: summary.rows[0], doctors: doctors.rows, days: days.rows });
});

// every doctor's booked appointments for the all-doctors calendar page, plus offered and booked counts per day
adminDataReportsRouter.get("/data-reports/schedule-utilization/calendar", async (req, res) => {
  const q = utilizationQuery.parse(req.query);
  const params = [q.from, q.to, q.officeId ?? null, q.doctorId ?? null, q.specialtyId ?? null, q.dayOfWeek ?? null, q.shiftTypeId ?? null];

  // the same slots as the report, with the appointment booked in each one
  const slots = `
    WITH slots AS (
      SELECT
        d.day::date AS day,
        ts.start_time,
        ts.end_time,
        e.first_name || ' ' || e.last_name AS doctor_name,
        o.name AS office_name,
        sp.name AS specialty_name,
        a.appointment_id,
        a.status,
        p.first_name || ' ' || p.last_name AS patient_name
      FROM generate_series($1::date, $2::date, interval '1 day') d(day)
      JOIN doctor_schedule ds ON ds.is_active AND ds.day_of_week = to_char(d.day, 'FMDay')
      JOIN employee e ON e.employee_id = ds.doctor_id
      JOIN office o ON o.office_id = ds.office_id
      JOIN specialty sp ON sp.specialty_id = ds.specialty_id
      JOIN time_slot ts ON ts.shift_type_id = ds.shift_type_id AND ts.is_active
      LEFT JOIN appointment a ON a.doctor_id = ds.doctor_id AND a.appointment_date = d.day::date
        AND a.time_slot_id = ts.time_slot_id AND a.status <> 'Cancelled'
      LEFT JOIN patient p ON p.patient_id = a.patient_id
      WHERE ($3::int IS NULL OR ds.office_id = $3)
        AND ($4::int IS NULL OR ds.doctor_id = $4)
        AND ($5::int IS NULL OR ds.specialty_id = $5)
        AND ($6::text IS NULL OR ds.day_of_week = $6)
        AND ($7::int IS NULL OR ds.shift_type_id = $7)
    )
  `;

  const summary = await pool.query(
    `${slots}
    SELECT
      count(*)::int AS offered,
      count(appointment_id)::int AS booked,
      count(*) FILTER (WHERE status = 'Completed')::int AS completed,
      count(*) FILTER (WHERE status = 'No Show')::int AS "noShows",
      to_char(min(start_time), 'HH24:MI') AS "firstTime",
      to_char(max(end_time), 'HH24:MI') AS "lastTime"
    FROM slots`,
    params
  );

  const days = await pool.query(
    `${slots}
    SELECT to_char(day, 'YYYY-MM-DD') AS date, count(*)::int AS offered, count(appointment_id)::int AS booked
    FROM slots
    GROUP BY day
    ORDER BY day`,
    params
  );

  const appointments = await pool.query(
    `${slots}
    SELECT
      appointment_id AS "appointmentId",
      to_char(day, 'YYYY-MM-DD') AS date,
      to_char(start_time, 'HH24:MI') AS time,
      to_char(end_time, 'HH24:MI') AS "endTime",
      doctor_name AS "doctorName",
      office_name AS "officeName",
      specialty_name AS specialty,
      patient_name AS "patientName",
      status
    FROM slots
    WHERE appointment_id IS NOT NULL
    ORDER BY day, start_time, doctor_name`,
    params
  );

  res.json({ summary: summary.rows[0], days: days.rows, appointments: appointments.rows });
});

// one doctor's slots for the calendar page, using the same filters as the report
adminDataReportsRouter.get("/data-reports/schedule-utilization/doctors/:doctorId", async (req, res) => {
  const doctorId = z.coerce.number().int().positive().parse(req.params.doctorId);
  const q = utilizationQuery.parse(req.query);

  const doctor = await pool.query(`SELECT first_name || ' ' || last_name AS name FROM employee WHERE employee_id = $1`, [doctorId]);
  if (!doctor.rowCount) throw new HttpError(404, "Doctor not found");

  // every slot the doctor's schedule offers, with the appointment in it if any
  const slots = await pool.query(
    `
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS date,
      to_char(ts.start_time, 'HH24:MI') AS time,
      to_char(ts.end_time, 'HH24:MI') AS "endTime",
      o.name AS "officeName",
      sp.name AS specialty,
      a.appointment_id AS "appointmentId",
      a.status,
      p.first_name || ' ' || p.last_name AS "patientName"
    FROM generate_series($1::date, $2::date, interval '1 day') d(day)
    JOIN doctor_schedule ds ON ds.is_active AND ds.day_of_week = to_char(d.day, 'FMDay')
    JOIN office o ON o.office_id = ds.office_id
    JOIN specialty sp ON sp.specialty_id = ds.specialty_id
    JOIN time_slot ts ON ts.shift_type_id = ds.shift_type_id AND ts.is_active
    LEFT JOIN appointment a ON a.doctor_id = ds.doctor_id AND a.appointment_date = d.day::date
      AND a.time_slot_id = ts.time_slot_id AND a.status <> 'Cancelled'
    LEFT JOIN patient p ON p.patient_id = a.patient_id
    WHERE ds.doctor_id = $3
      AND ($4::int IS NULL OR ds.office_id = $4)
      AND ($5::int IS NULL OR ds.specialty_id = $5)
      AND ($6::text IS NULL OR ds.day_of_week = $6)
      AND ($7::int IS NULL OR ds.shift_type_id = $7)
    ORDER BY d.day, ts.start_time
    `,
    [q.from, q.to, doctorId, q.officeId ?? null, q.specialtyId ?? null, q.dayOfWeek ?? null, q.shiftTypeId ?? null]
  );

  res.json({ doctorName: doctor.rows[0].name, slots: slots.rows });
});

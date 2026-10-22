import { Router } from "express";
import { z } from "zod";
import { pool, withTransaction } from "../lib/db.js";
import { requireStaffType } from "../lib/staff.js";
import { HttpError } from "../middleware/errorHandler.js";

export const billingRouter = Router();

const id = z.coerce.number().int().positive();

// Every visit costs at least this, plus its lab tests. Later the doctor or
// specialist will set the visit fee; until then receptionists can raise
// an invoice above the minimum but never below it.
const CHECK_IN_FEE = 50;

// Money columns are NUMERIC, which pg returns as strings (e.g. "125.00")
// so no precision is lost; the frontend converts them for display.

// Lab tests billed for one visit ($1 = appointment_id). Cancelled orders
// aren't charged.
const BILLABLE_LABS = `
  FROM lab_order lo
  JOIN lab_test_type ltt ON ltt.lab_test_type_id = lo.lab_test_type_id
  WHERE lo.appointment_id = $1 AND lo.status <> 'Cancelled'
`;

// The minimum a visit can be billed: check-in fee + its labs. Done in SQL
// (NUMERIC) so cents stay exact. Runs on `db`, which is either the pool
// or a transaction's client.
async function minimumAmount(db: { query: typeof pool.query }, appointmentId: number) {
  const result = await db.query(
    `SELECT ($2::numeric + COALESCE(SUM(ltt.cost), 0))::numeric(10,2) AS minimum ${BILLABLE_LABS}`,
    [appointmentId, CHECK_IN_FEE]
  );
  return result.rows[0].minimum as string;
}

// What an invoice for this visit would cost, as a breakdown for the
// "Create invoice" form.
billingRouter.get("/api/appointments/:appointmentId/invoice-estimate", async (req, res) => {
  const appointmentId = id.parse(req.params.appointmentId);

  const [labs, minimum] = await Promise.all([
    pool.query(
      `
      SELECT lo.lab_order_id AS "labOrderId", ltt.name, ltt.cost::numeric(10,2) AS cost
      ${BILLABLE_LABS}
      ORDER BY ltt.name
      `,
      [appointmentId]
    ),
    minimumAmount(pool, appointmentId),
  ]);

  res.json({
    appointmentId,
    checkInFee: CHECK_IN_FEE.toFixed(2),
    labs: labs.rows,
    minimumAmount: minimum,
  });
});

// One patient's insurance, invoices (each with what's been paid and
// what's still owed) and payments. Used by both the patient's own Billing
// page and the receptionist's Billing page.
billingRouter.get("/api/patients/:patientId/billing", async (req, res) => {
  const patientId = id.parse(req.params.patientId);

  const [insurance, invoices, payments] = await Promise.all([
    pool.query(
      `
      SELECT provider, policy_number AS "policyNumber", status
      FROM insurance
      WHERE patient_id = $1
      `,
      [patientId]
    ),
    // LEFT JOIN so invoices with no payments yet still appear (with
    // SUM = NULL, which COALESCE turns into 0). GROUP BY collapses each
    // invoice's payment rows back into one row per invoice.
    pool.query(
      `
      SELECT
        i.invoice_id AS "invoiceId",
        i.appointment_id AS "appointmentId",
        a.appointment_date AS "appointmentDate",
        i.issue_date AS "issueDate",
        i.amount,
        COALESCE(SUM(pay.amount_paid), 0)::numeric(10,2) AS "amountPaid",
        (i.amount - COALESCE(SUM(pay.amount_paid), 0))::numeric(10,2) AS balance,
        i.status
      FROM invoice i
      JOIN appointment a ON a.appointment_id = i.appointment_id
      LEFT JOIN payment pay ON pay.invoice_id = i.invoice_id
      WHERE i.patient_id = $1
      GROUP BY i.invoice_id, a.appointment_date
      ORDER BY i.issue_date DESC, i.invoice_id DESC
      `,
      [patientId]
    ),
    pool.query(
      `
      SELECT
        pay.payment_id AS "paymentId",
        pay.invoice_id AS "invoiceId",
        pay.payment_date AS "paymentDate",
        pay.amount_paid AS "amountPaid",
        pt.name AS "paymentType"
      FROM payment pay
      JOIN invoice i ON i.invoice_id = pay.invoice_id
      JOIN payment_type pt ON pt.payment_type_id = pay.payment_type_id
      WHERE i.patient_id = $1
      ORDER BY pay.payment_date DESC, pay.payment_id DESC
      `,
      [patientId]
    ),
  ]);

  res.json({
    insurance: insurance.rows[0] ?? null,
    invoices: invoices.rows,
    payments: payments.rows,
  });
});

const worklistQuerySchema = z.object({
  officeId: id,
  status: z.enum(["Pending", "Paid", "Overdue"]).default("Pending"),
});

// The office's billing worklist: invoices in one status (default
// Pending) with who owes what, oldest first.
billingRouter.get("/api/invoices", async (req, res) => {
  const q = worklistQuerySchema.parse(req.query);

  const result = await pool.query(
    `
    SELECT
      i.invoice_id AS "invoiceId",
      i.patient_id AS "patientId",
      p.first_name || ' ' || p.last_name AS "patientName",
      a.appointment_date AS "appointmentDate",
      i.issue_date AS "issueDate",
      i.amount,
      (i.amount - COALESCE(SUM(pay.amount_paid), 0))::numeric(10,2) AS balance,
      i.status
    FROM invoice i
    JOIN appointment a ON a.appointment_id = i.appointment_id
    JOIN patient p ON p.patient_id = i.patient_id
    LEFT JOIN payment pay ON pay.invoice_id = i.invoice_id
    WHERE a.office_id = $1 AND i.status = $2
    GROUP BY i.invoice_id, p.first_name, p.last_name, a.appointment_date
    ORDER BY i.issue_date, i.invoice_id
    `,
    [q.officeId, q.status]
  );

  res.json(result.rows);
});

// Completed visits that haven't been billed yet: the choices for the
// receptionist's "Create invoice" form. NOT EXISTS keeps only
// appointments with no matching invoice row.
billingRouter.get("/api/patients/:patientId/uninvoiced-appointments", async (req, res) => {
  const patientId = id.parse(req.params.patientId);

  const result = await pool.query(
    `
    SELECT
      a.appointment_id AS "appointmentId",
      a.appointment_date AS "appointmentDate",
      s.name AS specialty,
      'Dr. ' || e.last_name AS "doctorName"
    FROM appointment a
    JOIN specialty s ON s.specialty_id = a.specialty_id
    JOIN employee e ON e.employee_id = a.doctor_id
    WHERE a.patient_id = $1
      AND a.status = 'Completed'
      AND NOT EXISTS (SELECT 1 FROM invoice i WHERE i.appointment_id = a.appointment_id)
    ORDER BY a.appointment_date DESC
    `,
    [patientId]
  );

  res.json(result.rows);
});

// Choices for the "Record payment" form's method dropdown.
billingRouter.get("/api/payment-types", async (_req, res) => {
  const result = await pool.query(`
    SELECT payment_type_id AS "paymentTypeId", name
    FROM payment_type
    WHERE is_active
    ORDER BY name
  `);

  res.json(result.rows);
});

// Money must be positive with at most 2 decimal places (cents).
const money = z.number().positive().multipleOf(0.01);

const createInvoiceSchema = z.object({
  appointmentId: z.number().int().positive(),
  // Optional: leave it out to bill exactly the minimum.
  amount: money.optional(),
});

// Bill a completed visit at the receptionist's office.
//
// In one transaction:
//   1. Lock the appointment row (FOR UPDATE), so two receptionists can't
//      both bill the same visit at once. With the lock held, "no invoice
//      exists yet" stays true until we insert. This replaces a UNIQUE
//      constraint on invoice.appointment_id, which the schema doesn't have.
//   2. Work out the minimum (check-in fee + labs) and reject anything less.
//   3. INSERT. The patient comes from the appointment, never the request,
//      so an invoice can't be attached to the wrong patient.
billingRouter.post("/api/invoices", async (req, res) => {
  const body = createInvoiceSchema.parse(req.body);
  const { officeId } = await requireStaffType(req, "receptionist", "create invoices");

  const invoice = await withTransaction(async (client) => {
    const appointment = await client.query(
      `SELECT patient_id, office_id, status FROM appointment WHERE appointment_id = $1 FOR UPDATE`,
      [body.appointmentId]
    );
    const visit = appointment.rows[0];
    if (!visit) throw new HttpError(404, "Appointment not found");
    if (visit.office_id !== officeId) throw new HttpError(403, "That appointment is at another office");
    if (visit.status !== "Completed") throw new HttpError(400, "Only completed visits can be invoiced");

    const existing = await client.query(`SELECT 1 FROM invoice WHERE appointment_id = $1`, [body.appointmentId]);
    if (existing.rowCount) throw new HttpError(409, "This visit already has an invoice");

    const minimum = await minimumAmount(client, body.appointmentId);
    const amount = body.amount ?? Number(minimum);
    if (amount < Number(minimum)) {
      throw new HttpError(400, `The amount can't be less than $${minimum} (check-in fee + lab tests)`);
    }

    const result = await client.query(
      `
      INSERT INTO invoice (patient_id, appointment_id, amount)
      VALUES ($1, $2, $3)
      RETURNING invoice_id AS "invoiceId", patient_id AS "patientId", appointment_id AS "appointmentId",
                issue_date AS "issueDate", amount, status
      `,
      [visit.patient_id, body.appointmentId, amount]
    );
    return result.rows[0];
  });

  res.status(201).json(invoice);
});

const recordPaymentSchema = z.object({
  paymentTypeId: z.number().int().positive(),
  amount: money,
});

// Record a payment against an invoice (receptionists only).
//
// This runs in a transaction and locks the invoice row first
// (SELECT ... FOR UPDATE). Without the lock, two receptionists could both
// read "balance $100", both record $100, and overpay the invoice. With
// it, the second one waits until the first commits, then sees the
// updated balance.
billingRouter.post("/api/invoices/:invoiceId/payments", async (req, res) => {
  const invoiceId = id.parse(req.params.invoiceId);
  const body = recordPaymentSchema.parse(req.body);
  const { employeeId } = await requireStaffType(req, "receptionist", "record payments");

  const payment = await withTransaction(async (client) => {
    const invoice = await client.query(`SELECT status FROM invoice WHERE invoice_id = $1 FOR UPDATE`, [invoiceId]);
    if (!invoice.rowCount) {
      throw new HttpError(404, "Invoice not found");
    }
    if (invoice.rows[0].status === "Paid") {
      throw new HttpError(409, "This invoice is already paid");
    }

    // Done in SQL (NUMERIC) rather than JS floats so cents stay exact.
    const balance = await client.query(
      `
      SELECT i.amount - COALESCE(SUM(p.amount_paid), 0) AS balance
      FROM invoice i
      LEFT JOIN payment p ON p.invoice_id = i.invoice_id
      WHERE i.invoice_id = $1
      GROUP BY i.invoice_id
      `,
      [invoiceId]
    );
    const remaining = Number(balance.rows[0].balance);
    if (body.amount > remaining) {
      throw new HttpError(400, `Payment is more than the remaining balance of $${remaining.toFixed(2)}`);
    }

    const result = await client.query(
      `
      INSERT INTO payment (invoice_id, payment_type_id, handled_by, amount_paid)
      VALUES ($1, $2, $3, $4)
      RETURNING payment_id AS "paymentId", invoice_id AS "invoiceId", payment_date AS "paymentDate",
                amount_paid AS "amountPaid"
      `,
      [invoiceId, body.paymentTypeId, employeeId, body.amount]
    );

    // Paying off the full balance closes the invoice.
    await client.query(
      `
      UPDATE invoice i
      SET status = 'Paid'
      WHERE i.invoice_id = $1
        AND i.amount <= (SELECT SUM(p.amount_paid) FROM payment p WHERE p.invoice_id = i.invoice_id)
      `,
      [invoiceId]
    );

    return result.rows[0];
  });

  res.status(201).json(payment);
});

// Everything printed on a payment receipt. "Paid to date" counts this
// payment and every earlier one on the invoice (payment_id <= this one),
// so a reprinted old receipt still shows the balance as it was then.
billingRouter.get("/api/payments/:paymentId/receipt", async (req, res) => {
  const paymentId = id.parse(req.params.paymentId);

  const result = await pool.query(
    `
    SELECT
      pay.payment_id AS "paymentId",
      pay.payment_date AS "paymentDate",
      pay.amount_paid AS "amountPaid",
      pt.name AS "paymentType",
      handler.first_name || ' ' || handler.last_name AS "handledBy",
      i.invoice_id AS "invoiceId",
      i.amount AS "invoiceAmount",
      (
        SELECT SUM(p2.amount_paid) FROM payment p2
        WHERE p2.invoice_id = i.invoice_id AND p2.payment_id <= pay.payment_id
      )::numeric(10,2) AS "paidToDate",
      (i.amount - (
        SELECT SUM(p2.amount_paid) FROM payment p2
        WHERE p2.invoice_id = i.invoice_id AND p2.payment_id <= pay.payment_id
      ))::numeric(10,2) AS "balanceAfter",
      p.patient_id AS "patientId",
      p.first_name || ' ' || p.last_name AS "patientName",
      a.appointment_date AS "visitDate",
      o.name AS "officeName",
      concat_ws(', ', o.street, o.apt, o.city, o.state || ' ' || o.zip) AS "officeAddress",
      o.phone AS "officePhone"
    FROM payment pay
    JOIN payment_type pt ON pt.payment_type_id = pay.payment_type_id
    LEFT JOIN employee handler ON handler.employee_id = pay.handled_by
    JOIN invoice i ON i.invoice_id = pay.invoice_id
    JOIN patient p ON p.patient_id = i.patient_id
    JOIN appointment a ON a.appointment_id = i.appointment_id
    JOIN office o ON o.office_id = a.office_id
    WHERE pay.payment_id = $1
    `,
    [paymentId]
  );
  if (!result.rowCount) {
    throw new HttpError(404, "Payment not found");
  }

  res.json(result.rows[0]);
});

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CLINIC_TODAY } from "../lib/clinicTime.js";
import { pool } from "../lib/db.js";
import { withTransaction } from "../lib/transaction.js";
import { HttpError } from "../middleware/errorHandler.js";

// what each invoice still owes, worked out from its amount and payments instead of its stored status
// it never goes below zero, so an overpaid invoice doesn't show up as money owed
export const INVOICE_BALANCES = `
  SELECT
    i.invoice_id,
    i.patient_id,
    i.status,
    i.amount,
    COALESCE(paid.total, 0)::numeric(10, 2) AS paid,
    GREATEST(i.amount - COALESCE(paid.total, 0), 0)::numeric(10, 2) AS balance
  FROM invoice i
  LEFT JOIN (SELECT invoice_id, sum(amount_paid) AS total FROM payment GROUP BY invoice_id) paid ON paid.invoice_id = i.invoice_id
`;

// dollars and cents kept as text, so amounts reach PostgreSQL without floating point rounding
export const moneySchema = z
  .union([z.string(), z.number()], "Enter an amount")
  .transform((value) => String(value).trim())
  .pipe(z.string().regex(/^\d{1,8}(\.\d{1,2})?$/, "Amount must be in dollars and cents, like 125.50"))
  .refine((value) => Number(value) > 0, "Amount must be more than 0");

const INVOICE_COLUMNS = `
  i.invoice_id AS "invoiceId",
  i.patient_id AS "patientId",
  pt.first_name || ' ' || pt.last_name AS "patientName",
  i.appointment_id AS "appointmentId",
  to_char(a.appointment_date, 'YYYY-MM-DD') AS "appointmentDate",
  d.first_name || ' ' || d.last_name AS "doctorName",
  o.name AS "officeName",
  to_char(i.issue_date, 'YYYY-MM-DD') AS "issueDate",
  i.amount,
  b.paid,
  b.balance,
  i.status
`;

const INVOICE_JOINS = `
  JOIN (${INVOICE_BALANCES}) b ON b.invoice_id = i.invoice_id
  JOIN patient pt ON pt.patient_id = i.patient_id
  JOIN appointment a ON a.appointment_id = i.appointment_id
  JOIN employee d ON d.employee_id = a.doctor_id
  JOIN office o ON o.office_id = a.office_id
`;

const PAYMENT_COLUMNS = `
  p.payment_id AS "paymentId",
  p.invoice_id AS "invoiceId",
  to_char(p.payment_date, 'YYYY-MM-DD') AS "paymentDate",
  p.amount_paid AS "amountPaid",
  p.payment_type_id AS "paymentTypeId",
  t.name AS "paymentType"
`;

export interface InvoiceFilter {
  // unpaid means anything with a balance left, whatever its stored status says
  status?: "Pending" | "Paid" | "Overdue" | "unpaid";
  patientId?: number;
  search?: string;
}

export async function listInvoices(filter: InvoiceFilter = {}) {
  const result = await pool.query(
    `
    SELECT ${INVOICE_COLUMNS}
    FROM invoice i
    ${INVOICE_JOINS}
    WHERE ($1::text IS NULL OR ($1 = 'unpaid' AND b.balance > 0) OR i.status = $1)
      AND ($2::int IS NULL OR i.patient_id = $2)
      AND ($3 = '' OR pt.first_name || ' ' || pt.last_name ILIKE '%' || $3 || '%' ESCAPE '\\')
    ORDER BY i.issue_date DESC, i.invoice_id DESC
    `,
    [filter.status ?? null, filter.patientId ?? null, (filter.search ?? "").replace(/[\\%_]/g, (character) => `\\${character}`)]
  );
  return result.rows;
}

// newest first, for one patient or everyone
export async function listPayments(filter: { patientId?: number; invoiceId?: number } = {}, db: Pool | PoolClient = pool) {
  const result = await db.query(
    `
    SELECT ${PAYMENT_COLUMNS}
    FROM payment p
    JOIN invoice i ON i.invoice_id = p.invoice_id
    JOIN payment_type t ON t.payment_type_id = p.payment_type_id
    WHERE ($1::int IS NULL OR i.patient_id = $1) AND ($2::int IS NULL OR p.invoice_id = $2)
    ORDER BY p.payment_date DESC, p.payment_id DESC
    `,
    [filter.patientId ?? null, filter.invoiceId ?? null]
  );
  return result.rows;
}

export async function getInvoice(invoiceId: number, db: Pool | PoolClient = pool) {
  const result = await db.query(`SELECT ${INVOICE_COLUMNS} FROM invoice i ${INVOICE_JOINS} WHERE i.invoice_id = $1`, [invoiceId]);
  if (!result.rowCount) return null;
  return { ...result.rows[0], payments: await listPayments({ invoiceId }, db) };
}

// what the patient owes across every invoice
export async function getOutstandingBalance(patientId: number) {
  const result = await pool.query(`SELECT COALESCE(sum(b.balance), 0)::numeric(10, 2) AS balance FROM (${INVOICE_BALANCES}) b WHERE b.patient_id = $1`, [
    patientId,
  ]);
  return result.rows[0].balance as string;
}

// the patient portal view, the same invoices and payments the Admin sees for this patient
export async function getPatientBilling(patientId: number) {
  const invoices = await pool.query(
    `
    SELECT i.invoice_id AS "invoiceId", to_char(i.issue_date, 'YYYY-MM-DD') AS "issueDate", i.amount, i.status, b.paid, b.balance
    FROM invoice i
    JOIN (${INVOICE_BALANCES}) b ON b.invoice_id = i.invoice_id
    WHERE i.patient_id = $1
    ORDER BY i.issue_date DESC, i.invoice_id DESC
    `,
    [patientId]
  );
  const payments = (await listPayments({ patientId })).map(({ paymentTypeId: _, ...payment }) => payment);
  return { invoices: invoices.rows, payments, outstandingBalance: await getOutstandingBalance(patientId) };
}

// completed visits that haven't been billed yet, oldest first
export async function listBillableAppointments() {
  const result = await pool.query(`
    SELECT
      a.appointment_id AS "appointmentId",
      a.patient_id AS "patientId",
      pt.first_name || ' ' || pt.last_name AS "patientName",
      d.first_name || ' ' || d.last_name AS "doctorName",
      o.name AS "officeName",
      sp.name AS "specialty",
      to_char(a.appointment_date, 'YYYY-MM-DD') AS "date"
    FROM appointment a
    JOIN patient pt ON pt.patient_id = a.patient_id
    JOIN employee d ON d.employee_id = a.doctor_id
    JOIN office o ON o.office_id = a.office_id
    JOIN specialty sp ON sp.specialty_id = a.specialty_id
    WHERE a.status = 'Completed' AND NOT EXISTS (SELECT 1 FROM invoice i WHERE i.appointment_id = a.appointment_id)
    ORDER BY a.appointment_date, a.appointment_id
  `);
  return result.rows;
}

export async function listPaymentTypes() {
  const result = await pool.query(`SELECT payment_type_id AS "paymentTypeId", name FROM payment_type WHERE is_active ORDER BY name`);
  return result.rows;
}

const isDuplicateInvoice = (err: unknown) => {
  const { code, constraint } = err as { code?: string; constraint?: string };
  return code === "23505" && constraint === "invoice_appointment_id_key";
};

// the patient comes from the appointment, never from the request
export async function createInvoice(appointmentId: number, amount: string) {
  try {
    return await withTransaction(async (client) => {
      // two admins billing the same visit wait for each other here
      const visit = await client.query(`SELECT patient_id AS "patientId", status FROM appointment WHERE appointment_id = $1 FOR NO KEY UPDATE`, [
        appointmentId,
      ]);
      if (!visit.rowCount) throw new HttpError(404, "Appointment not found");
      const { patientId, status } = visit.rows[0];
      if (status !== "Completed") throw new HttpError(409, `Only completed appointments can be billed. This one is ${status}.`);

      const existing = await client.query(`SELECT 1 FROM invoice WHERE appointment_id = $1`, [appointmentId]);
      if (existing.rowCount) throw new HttpError(409, "This appointment already has an invoice");

      const inserted = await client.query(
        `INSERT INTO invoice (patient_id, appointment_id, amount, issue_date, status) VALUES ($1, $2, $3, ${CLINIC_TODAY}, 'Pending') RETURNING invoice_id`,
        [patientId, appointmentId, amount]
      );
      return getInvoice(inserted.rows[0].invoice_id, client);
    });
  } catch (err) {
    if (isDuplicateInvoice(err)) throw new HttpError(409, "This appointment already has an invoice");
    throw err;
  }
}

export async function recordPayment(invoiceId: number, payment: { paymentTypeId: number; amount: string }, employeeId: number) {
  return withTransaction(async (client) => {
    // payments on one invoice go one at a time, so together they can't pay more than it owes
    const invoice = await client.query(`SELECT 1 FROM invoice WHERE invoice_id = $1 FOR NO KEY UPDATE`, [invoiceId]);
    if (!invoice.rowCount) throw new HttpError(404, "Invoice not found");

    const type = await client.query(`SELECT is_active AS "isActive" FROM payment_type WHERE payment_type_id = $1 FOR SHARE`, [payment.paymentTypeId]);
    if (!type.rows[0]?.isActive) throw new HttpError(400, "Choose an active payment type");

    const owed = await client.query(`SELECT b.balance, $2::numeric > b.balance AS "tooMuch" FROM (${INVOICE_BALANCES}) b WHERE b.invoice_id = $1`, [
      invoiceId,
      payment.amount,
    ]);
    const { balance, tooMuch } = owed.rows[0];
    if (Number(balance) === 0) throw new HttpError(409, "This invoice is already paid");
    if (tooMuch) throw new HttpError(409, `Only $${balance} is left on this invoice`);

    const inserted = await client.query(
      `
      INSERT INTO payment (invoice_id, payment_type_id, handled_by, amount_paid, payment_date)
      VALUES ($1, $2, $3, $4, ${CLINIC_TODAY})
      RETURNING payment_id AS "paymentId"
      `,
      [invoiceId, payment.paymentTypeId, employeeId, payment.amount]
    );

    // fully paid invoices become Paid, including ones that were Overdue
    await client.query(
      `
      UPDATE invoice SET status = 'Paid'
      WHERE invoice_id = $1 AND status <> 'Paid'
        AND amount <= (SELECT sum(amount_paid) FROM payment WHERE invoice_id = $1)
      `,
      [invoiceId]
    );

    return { paymentId: inserted.rows[0].paymentId as number, invoice: await getInvoice(invoiceId, client) };
  });
}

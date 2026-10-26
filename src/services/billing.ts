import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CLINIC_TODAY } from "../lib/clinicTime.js";
import { pool } from "../lib/db.js";
import { withTransaction } from "../lib/transaction.js";
import { HttpError } from "../middleware/errorHandler.js";

// what each invoice still owes, worked out from its amount and payments instead of its stored status
// it never goes below zero, so an overpaid invoice doesn't show up as money owed
// refunded payments don't count as paid, and a void invoice owes nothing
export const INVOICE_BALANCES = `
  SELECT
    i.invoice_id,
    i.patient_id,
    i.status,
    i.amount,
    COALESCE(paid.total, 0)::numeric(10, 2) AS paid,
    CASE WHEN i.status = 'Void' THEN 0 ELSE GREATEST(i.amount - COALESCE(paid.total, 0), 0) END::numeric(10, 2) AS balance
  FROM invoice i
  LEFT JOIN (
    SELECT invoice_id, sum(amount_paid) AS total FROM payment WHERE status <> 'Refunded' GROUP BY invoice_id
  ) paid ON paid.invoice_id = i.invoice_id
`;

// card details for a card payment: checked here, never saved
// the card works until the end of its expiry month
export const cardDetailsSchema = z.object({
  nameOnCard: z.string("Enter the name on the card").trim().min(1, "Enter the name on the card").max(100),
  cardNumber: z
    .string("Enter the card number")
    .transform((value) => value.replace(/[\s-]/g, ""))
    .refine((value) => /^\d{16}$/.test(value), "The card number must be 16 digits"),
  expiry: z
    .string("Enter the expiry date")
    .regex(/^(0[1-9]|1[0-2])\/\d{2}$/, "Expiry must look like MM/YY")
    .refine((value) => new Date(2000 + Number(value.slice(3)), Number(value.slice(0, 2)), 1) > new Date(), "This card has expired"),
  cvv: z.string("Enter the security code").regex(/^\d{3,4}$/, "The security code is 3 or 4 digits"),
});

// billing triggers (migration 011) refuse any invoice or payment change that doesn't say who made it
// run this first inside the same transaction
export async function setBillingEmployee(client: PoolClient, employeeId: number, reason: string | null = null) {
  await client.query(`SELECT set_config('app.employee_id', $1, true), set_config('app.reason', $2, true)`, [String(employeeId), reason ?? ""]);
}

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
  t.name AS "paymentType",
  p.status,
  h.first_name || ' ' || h.last_name AS "handledBy"
`;

export interface InvoiceFilter {
  // unpaid means anything with a balance left, whatever its stored status says
  status?: "Pending" | "Paid" | "Overdue" | "Void" | "unpaid";
  patientId?: number;
  officeId?: number;
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
      AND ($4::int IS NULL OR a.office_id = $4)
    ORDER BY i.issue_date DESC, i.invoice_id DESC
    `,
    [
      filter.status ?? null,
      filter.patientId ?? null,
      (filter.search ?? "").replace(/[\\%_]/g, (character) => `\\${character}`),
      filter.officeId ?? null,
    ]
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
    LEFT JOIN employee h ON h.employee_id = p.handled_by
    WHERE ($1::int IS NULL OR i.patient_id = $1) AND ($2::int IS NULL OR p.invoice_id = $2)
    ORDER BY p.payment_date DESC, p.payment_id DESC
    `,
    [filter.patientId ?? null, filter.invoiceId ?? null]
  );
  return result.rows;
}

// the lines of one invoice (visit fee, lab tests, medications), oldest first
export async function listInvoiceItems(invoiceId: number, db: Pool | PoolClient = pool) {
  const result = await db.query(
    `
    SELECT invoice_item_id AS "invoiceItemId", category, description, price
    FROM invoice_item
    WHERE invoice_id = $1
    ORDER BY CASE category WHEN 'Visit' THEN 1 WHEN 'Lab Test' THEN 2 ELSE 3 END, invoice_item_id
    `,
    [invoiceId]
  );
  return result.rows;
}

export async function getInvoice(invoiceId: number, db: Pool | PoolClient = pool) {
  const result = await db.query(`SELECT ${INVOICE_COLUMNS} FROM invoice i ${INVOICE_JOINS} WHERE i.invoice_id = $1`, [invoiceId]);
  if (!result.rowCount) return null;
  return { ...result.rows[0], items: await listInvoiceItems(invoiceId, db), payments: await listPayments({ invoiceId }, db) };
}

// what the patient owes across every invoice
export async function getOutstandingBalance(patientId: number) {
  const result = await pool.query(`SELECT COALESCE(sum(b.balance), 0)::numeric(10, 2) AS balance FROM (${INVOICE_BALANCES}) b WHERE b.patient_id = $1`, [
    patientId,
  ]);
  return result.rows[0].balance as string;
}

// the patient portal view, the same invoices and payments the Admin sees for this patient
// void invoices and their payments are never shown to the patient
export async function getPatientBilling(patientId: number) {
  const invoices = await pool.query(
    `
    SELECT i.invoice_id AS "invoiceId", to_char(i.issue_date, 'YYYY-MM-DD') AS "issueDate", i.amount, i.status, b.paid, b.balance
    FROM invoice i
    JOIN (${INVOICE_BALANCES}) b ON b.invoice_id = i.invoice_id
    WHERE i.patient_id = $1 AND i.status <> 'Void'
    ORDER BY i.issue_date DESC, i.invoice_id DESC
    `,
    [patientId]
  );
  const shown = new Set(invoices.rows.map((invoice) => invoice.invoiceId));
  const payments = (await listPayments({ patientId }))
    .filter((payment) => shown.has(payment.invoiceId))
    .map(({ paymentTypeId: _, handledBy: __, ...payment }) => payment);
  for (const invoice of invoices.rows) invoice.items = await listInvoiceItems(invoice.invoiceId);
  return { invoices: invoices.rows, payments, outstandingBalance: await getOutstandingBalance(patientId) };
}

export async function listPaymentTypes() {
  const result = await pool.query(`SELECT payment_type_id AS "paymentTypeId", name FROM payment_type WHERE is_active ORDER BY name`);
  return result.rows;
}

export async function recordPayment(invoiceId: number, payment: { paymentTypeId: number; amount: string }, employeeId: number) {
  return withTransaction(async (client) => {
    await setBillingEmployee(client, employeeId);
    // payments on one invoice go one at a time, so together they can't pay more than it owes
    const invoice = await client.query(`SELECT status FROM invoice WHERE invoice_id = $1 FOR NO KEY UPDATE`, [invoiceId]);
    if (!invoice.rowCount) throw new HttpError(404, "Invoice not found");
    if (invoice.rows[0].status === "Void") throw new HttpError(409, "This invoice is void and can't take payments");

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

    // the payment trigger marks the invoice Paid once it's fully paid, including ones that were Overdue
    return { paymentId: inserted.rows[0].paymentId as number, invoice: await getInvoice(invoiceId, client) };
  });
}
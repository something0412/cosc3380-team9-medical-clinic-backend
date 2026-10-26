import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { withTransaction } from "../../lib/transaction.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { cardDetailsSchema, getInvoice, listInvoices, listPaymentTypes, moneySchema, recordPayment, setBillingEmployee } from "../../services/billing.js";

export const receptionistBillingRouter = Router();

const idParam = (label: string) => z.coerce.number(`Choose ${label}`).int(`Choose ${label}`).positive(`Choose ${label}`);
const listQuery = z.object({
  status: z.enum(["Pending", "Paid", "Overdue", "unpaid"], "Status must be Pending, Paid, Overdue or unpaid").optional(),
  search: z.string().trim().max(100).default(""),
});
const paymentBody = z.object({ paymentTypeId: idParam("a payment type"), amount: moneySchema });
const requestBody = z.object({
  reason: z.string("Write why the payment should be refunded").trim().min(1, "Write why the payment should be refunded").max(500, "Keep the reason under 500 characters"),
});

// the receptionist and office come from the database on every request, never from the client
function me(req: Request) {
  if (!req.user || req.user.role === "patient") throw new HttpError(401, "Login required");
  return { employeeId: req.user.employeeId, officeId: req.user.officeId };
}

// get the invoices for visits at my office (status filter and patient name search), void ones left out
receptionistBillingRouter.get("/api/receptionist/invoices", async (req, res) => {
  const { officeId } = me(req);
  const { status, search } = listQuery.parse(req.query);
  const invoices = await listInvoices({ officeId, status, search });
  res.json(invoices.filter((invoice) => invoice.status !== "Void"));
});

// get one invoice at my office with its payments
receptionistBillingRouter.get("/api/receptionist/invoices/:id", async (req, res) => {
  const { officeId } = me(req);
  const invoiceId = idParam("an invoice").parse(req.params.id);

  // check the invoice is for a visit at my office
  const access = await pool.query(
    `SELECT 1 FROM invoice i JOIN appointment a ON a.appointment_id = i.appointment_id WHERE i.invoice_id = $1 AND a.office_id = $2 AND i.status <> 'Void'`,
    [invoiceId, officeId]
  );
  if (!access.rowCount) throw new HttpError(404, "Invoice not found at your office");

  res.json(await getInvoice(invoiceId));
});

// get payment types for the payment form
receptionistBillingRouter.get("/api/receptionist/payment-types", async (_req, res) => {
  res.json(await listPaymentTypes());
});

// take a payment on an invoice at my office
receptionistBillingRouter.post("/api/receptionist/invoices/:id/payments", async (req, res) => {
  const { employeeId, officeId } = me(req);
  const invoiceId = idParam("an invoice").parse(req.params.id);
  const body = paymentBody.parse(req.body);

  // check the invoice is for a visit at my office, and get the payment type and the patient's insurance status
  const access = await pool.query(
    `
    SELECT
      (SELECT name FROM payment_type WHERE payment_type_id = $3) AS "paymentType",
      (SELECT status FROM insurance WHERE patient_id = i.patient_id) AS "insuranceStatus"
    FROM invoice i
    JOIN appointment a ON a.appointment_id = i.appointment_id
    WHERE i.invoice_id = $1 AND a.office_id = $2
    `,
    [invoiceId, officeId, body.paymentTypeId]
  );
  if (!access.rowCount) throw new HttpError(404, "Invoice not found at your office");
  const { paymentType, insuranceStatus } = access.rows[0];

  // card payments need the card details (checked, never saved)
  if (paymentType === "Credit Card" || paymentType === "Debit Card") cardDetailsSchema.parse(req.body.card ?? {});
  // insurance can only be billed once it's verified
  if (paymentType === "Insurance" && insuranceStatus !== "Verified") {
    throw new HttpError(409, "The patient's insurance has to be verified before it can be billed");
  }

  res.status(201).json(await recordPayment(invoiceId, body, employeeId));
});

// ask the admin to refund a payment
receptionistBillingRouter.patch("/api/receptionist/payments/:id/request-refund", async (req, res) => {
  const { employeeId, officeId } = me(req);
  const paymentId = idParam("a payment").parse(req.params.id);
  const { reason } = requestBody.parse(req.body);

  const invoice = await withTransaction(async (client) => {
    await setBillingEmployee(client, employeeId, reason);

    // mark a completed payment at my office as requested
    const requested = await client.query(
      `
      UPDATE payment p
      SET status = 'Requested'
      FROM invoice i
      JOIN appointment a ON a.appointment_id = i.appointment_id
      WHERE p.payment_id = $1 AND i.invoice_id = p.invoice_id AND a.office_id = $2 AND p.status = 'Completed'
      RETURNING p.invoice_id AS "invoiceId"
      `,
      [paymentId, officeId]
    );
    if (!requested.rowCount) throw new HttpError(409, "Only completed payments at your office can have a refund requested");
    return getInvoice(requested.rows[0].invoiceId, client);
  });

  res.json(invoice);
});

// cancel a refund request made by mistake, the payment goes back to Completed
receptionistBillingRouter.patch("/api/receptionist/payments/:id/cancel-request", async (req, res) => {
  const { employeeId, officeId } = me(req);
  const paymentId = idParam("a payment").parse(req.params.id);

  const invoice = await withTransaction(async (client) => {
    await setBillingEmployee(client, employeeId, "Request cancelled");

    // put a requested payment at my office back to Completed
    const cancelled = await client.query(
      `
      UPDATE payment p
      SET status = 'Completed'
      FROM invoice i
      JOIN appointment a ON a.appointment_id = i.appointment_id
      WHERE p.payment_id = $1 AND i.invoice_id = p.invoice_id AND a.office_id = $2 AND p.status = 'Requested'
      RETURNING p.invoice_id AS "invoiceId"
      `,
      [paymentId, officeId]
    );
    if (!cancelled.rowCount) throw new HttpError(409, "Only payments with a refund request at your office can be cancelled");
    return getInvoice(cancelled.rows[0].invoiceId, client);
  });

  res.json(invoice);
});
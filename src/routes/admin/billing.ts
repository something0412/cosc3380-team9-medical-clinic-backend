import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { withTransaction } from "../../lib/transaction.js";
import { HttpError } from "../../middleware/errorHandler.js";
import {
  getInvoice,
  listInvoices,
  listPayments,
  listPaymentTypes,
  moneySchema,
  recordPayment,
  setBillingEmployee,
} from "../../services/billing.js";

// mounted at /api/admin, so only admins reach these
export const adminBillingRouter = Router();

const id = (label: string) => z.coerce.number(`Choose ${label}`).int(`Choose ${label}`).positive(`Choose ${label}`);
const invoiceQuery = z.object({
  status: z.enum(["Pending", "Paid", "Overdue", "Void", "unpaid"], "Status must be Pending, Paid, Overdue, Void or unpaid").optional(),
  patientId: id("a patient").optional(),
  search: z.string().trim().max(100).default(""),
});
const paymentBody = z.object({ paymentTypeId: id("a payment type"), amount: moneySchema });
const reasonText = z.string().trim().max(500, "Keep the reason under 500 characters");
const approveBody = z.object({ voidInvoice: z.boolean().default(false), reason: reasonText.default("") });
const reasonBody = z.object({ reason: reasonText.default("") });
const voidBody = z.object({ reason: reasonText.min(1, "Write why the invoice is being voided") });

// the signed in admin's employee ID
function adminId(req: Request) {
  if (!req.user || req.user.role === "patient") throw new HttpError(401, "Login required");
  return req.user.employeeId;
}

adminBillingRouter.get("/invoices", async (req, res) => {
  res.json(await listInvoices(invoiceQuery.parse(req.query)));
});

adminBillingRouter.get("/invoices/:id", async (req, res) => {
  const invoice = await getInvoice(id("an invoice").parse(req.params.id));
  if (!invoice) throw new HttpError(404, "Invoice not found");
  res.json(invoice);
});

adminBillingRouter.post("/invoices/:id/payments", async (req, res) => {
  const invoiceId = id("an invoice").parse(req.params.id);
  res.status(201).json(await recordPayment(invoiceId, paymentBody.parse(req.body), adminId(req)));
});

adminBillingRouter.get("/payments", async (req, res) => {
  const { patientId } = z.object({ patientId: id("a patient").optional() }).parse(req.query);
  res.json(await listPayments({ patientId }));
});

adminBillingRouter.get("/payment-types", async (_req, res) => {
  res.json(await listPaymentTypes());
});

// get the payments waiting for a refund decision, oldest request first
adminBillingRouter.get("/refund-requests", async (_req, res) => {
  // get each requested payment with its invoice, patient, office, and who asked, when, and why
  const result = await pool.query(`
    SELECT
      p.payment_id AS "paymentId",
      p.invoice_id AS "invoiceId",
      p.amount_paid AS "amountPaid",
      to_char(p.payment_date, 'YYYY-MM-DD') AS "paymentDate",
      t.name AS "paymentType",
      i.amount AS "invoiceAmount",
      pt.first_name || ' ' || pt.last_name AS "patientName",
      o.name AS "officeName",
      r.first_name || ' ' || r.last_name AS "requestedBy",
      to_char(h.changed_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD HH24:MI') AS "requestedAt",
      h.reason
    FROM payment p
    JOIN payment_type t ON t.payment_type_id = p.payment_type_id
    JOIN invoice i ON i.invoice_id = p.invoice_id
    JOIN patient pt ON pt.patient_id = i.patient_id
    JOIN appointment a ON a.appointment_id = i.appointment_id
    JOIN office o ON o.office_id = a.office_id
    JOIN LATERAL (
      SELECT changed_by, changed_at, reason FROM billing_history
      WHERE payment_id = p.payment_id AND new_status = 'Requested'
      ORDER BY changed_at DESC, history_id DESC
      LIMIT 1
    ) h ON true
    JOIN employee r ON r.employee_id = h.changed_by
    WHERE p.status = 'Requested'
    ORDER BY h.changed_at, p.payment_id
  `);

  res.json(result.rows);
});

// approve a refund, and void the invoice too when it was billed by mistake
adminBillingRouter.patch("/payments/:id/approve-refund", async (req, res) => {
  const paymentId = id("a payment").parse(req.params.id);
  const { voidInvoice, reason } = approveBody.parse(req.body);

  const invoice = await withTransaction(async (client) => {
    await setBillingEmployee(client, adminId(req), reason || null);

    // mark the payment refunded, only while its refund is still requested
    const refunded = await client.query(
      `UPDATE payment SET status = 'Refunded' WHERE payment_id = $1 AND status = 'Requested' RETURNING invoice_id AS "invoiceId"`,
      [paymentId]
    );
    if (!refunded.rowCount) throw new HttpError(409, "Only payments with a refund request can be refunded");
    const { invoiceId } = refunded.rows[0];

    if (voidInvoice) {
      // void the invoice, only once none of its payments still count
      const left = await client.query(`SELECT 1 FROM payment WHERE invoice_id = $1 AND status IN ('Completed', 'Requested')`, [invoiceId]);
      if (left.rowCount) throw new HttpError(409, "This invoice still has other payments. Refund them before voiding it.");
      await client.query(`UPDATE invoice SET status = 'Void' WHERE invoice_id = $1`, [invoiceId]);
    }

    return getInvoice(invoiceId, client);
  });

  res.json(invoice);
});

// deny a refund, the payment goes back to Completed
adminBillingRouter.patch("/payments/:id/deny-refund", async (req, res) => {
  const paymentId = id("a payment").parse(req.params.id);
  const { reason } = reasonBody.parse(req.body);

  const invoice = await withTransaction(async (client) => {
    await setBillingEmployee(client, adminId(req), reason || null);

    // put the payment back to Completed, only while its refund is still requested
    const denied = await client.query(
      `UPDATE payment SET status = 'Completed' WHERE payment_id = $1 AND status = 'Requested' RETURNING invoice_id AS "invoiceId"`,
      [paymentId]
    );
    if (!denied.rowCount) throw new HttpError(409, "Only payments with a refund request can be denied");
    return getInvoice(denied.rows[0].invoiceId, client);
  });

  res.json(invoice);
});

// void an invoice that was made by mistake and has no payments that still count
adminBillingRouter.patch("/invoices/:id/void", async (req, res) => {
  const invoiceId = id("an invoice").parse(req.params.id);
  const { reason } = voidBody.parse(req.body);

  const invoice = await withTransaction(async (client) => {
    await setBillingEmployee(client, adminId(req), reason);

    const current = await client.query(`SELECT status FROM invoice WHERE invoice_id = $1 FOR NO KEY UPDATE`, [invoiceId]);
    if (!current.rowCount) throw new HttpError(404, "Invoice not found");
    if (current.rows[0].status === "Void") throw new HttpError(409, "This invoice is already void");

    const left = await client.query(`SELECT 1 FROM payment WHERE invoice_id = $1 AND status IN ('Completed', 'Requested')`, [invoiceId]);
    if (left.rowCount) throw new HttpError(409, "Refund every payment on this invoice before voiding it");

    // mark the invoice void
    await client.query(`UPDATE invoice SET status = 'Void' WHERE invoice_id = $1`, [invoiceId]);
    return getInvoice(invoiceId, client);
  });

  res.json(invoice);
});

// get every change to an invoice and its payments, newest first
adminBillingRouter.get("/invoices/:id/history", async (req, res) => {
  const invoiceId = id("an invoice").parse(req.params.id);

  // get the invoice's history rows with the name and type of the employee who made each change
  const result = await pool.query(
    `
    SELECT
      h.history_id AS "historyId",
      h.payment_id AS "paymentId",
      h.old_status AS "oldStatus",
      h.new_status AS "newStatus",
      COALESCE(e.first_name || ' ' || e.last_name, pt.first_name || ' ' || pt.last_name) AS "changedBy",
      COALESCE(et.type_name, CASE WHEN pt.patient_id IS NOT NULL THEN 'Patient' END) AS "changedByType",
      h.reason,
      to_char(h.changed_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD HH24:MI') AS "changedAt"
    FROM billing_history h
    LEFT JOIN employee e ON e.employee_id = h.changed_by
    LEFT JOIN employee_types et ON et.employee_type_id = e.employee_type_id
    LEFT JOIN patient pt ON pt.patient_id = h.changed_by_patient
    WHERE h.invoice_id = $1
    ORDER BY h.changed_at DESC, h.history_id DESC
    `,
    [invoiceId]
  );

  res.json(result.rows);
});

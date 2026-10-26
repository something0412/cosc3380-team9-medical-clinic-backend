import { Router } from "express";
import { z } from "zod";
import { CLINIC_TODAY } from "../../lib/clinicTime.js";
import { withTransaction } from "../../lib/transaction.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { INVOICE_BALANCES, cardDetailsSchema, getInvoice, moneySchema } from "../../services/billing.js";

export const patientPaymentsRouter = Router();

// card details are only checked, never saved
const cardPaymentBody = cardDetailsSchema.extend({
  cardType: z.enum(["Credit Card", "Debit Card"], "Choose credit or debit card"),
  amount: moneySchema,
});

// pay one of my invoices by card (the /api/patient/:id guard in app.ts already checks this is me)
patientPaymentsRouter.post("/api/patient/:id/invoices/:invoiceId/payments", async (req, res) => {
  const patientId = Number(req.params.id);
  const invoiceId = Number(req.params.invoiceId);
  const card = cardPaymentBody.parse(req.body);

  const invoice = await withTransaction(async (client) => {
    // the billing triggers record that the patient made this payment
    await client.query(`SELECT set_config('app.patient_id', $1, true), set_config('app.employee_id', '', true)`, [String(patientId)]);

    // lock my invoice so two payments at once can't pay more than it owes
    const mine = await client.query(`SELECT status FROM invoice WHERE invoice_id = $1 AND patient_id = $2 FOR NO KEY UPDATE`, [invoiceId, patientId]);
    if (!mine.rowCount || mine.rows[0].status === "Void") throw new HttpError(404, "Invoice not found");

    // get what's left on the invoice
    const owed = await client.query(`SELECT b.balance, $2::numeric > b.balance AS "tooMuch" FROM (${INVOICE_BALANCES}) b WHERE b.invoice_id = $1`, [
      invoiceId,
      card.amount,
    ]);
    if (Number(owed.rows[0].balance) === 0) throw new HttpError(409, "This invoice is already paid");
    if (owed.rows[0].tooMuch) throw new HttpError(409, `Only $${owed.rows[0].balance} is left on this invoice`);

    // save the payment (no card details), with no employee since I paid online
    await client.query(
      `
      INSERT INTO payment (invoice_id, payment_type_id, handled_by, amount_paid, payment_date, status)
      SELECT $1, payment_type_id, NULL, $2, ${CLINIC_TODAY}, 'Completed' FROM payment_type WHERE name = $3 AND is_active
      `,
      [invoiceId, card.amount, card.cardType]
    );
    return getInvoice(invoiceId, client);
  });

  res.status(201).json(invoice);
});
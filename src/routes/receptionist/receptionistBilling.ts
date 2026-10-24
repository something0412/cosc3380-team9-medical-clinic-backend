import { Router } from "express";
import { pool } from "../../lib/db.js";

export const receptionistBillingRouter = Router();

// get invoices for visits at my office (status filter and patient name search)
receptionistBillingRouter.get("/api/receptionist/invoices", async (req, res) => {
  const receptionistId = req.session.employeeId;
  const status = String(req.query.status ?? "unpaid");
  const search = String(req.query.search ?? "").trim();

  // get my office's invoices for the chosen status (unpaid = Pending or Overdue), with what was paid and what is left
  const result = await pool.query(
    ``,
    [receptionistId, status, search]
  );

  res.json(result.rows);
});

// get finished visits at my office that don't have an invoice yet
receptionistBillingRouter.get("/api/receptionist/billable-appointments", async (req, res) => {
  const receptionistId = req.session.employeeId;

  // get my office's completed appointments with no invoice, with the cost of their lab tests, oldest first
  const result = await pool.query(
    ``,
    [receptionistId]
  );

  res.json(result.rows);
});

// bill a finished visit
receptionistBillingRouter.post("/api/receptionist/invoices", async (req, res) => {
  const receptionistId = req.session.employeeId;
  const appointmentId = Number(req.body.appointmentId);
  const amount = Math.round(Number(req.body.amount) * 100) / 100;

  if (!appointmentId || !(amount >= 0)) {
    res.status(400).json({ error: "Choose a visit and enter an amount of 0 or more" });
    return;
  }

  // get the patient of a completed visit at my office that has no invoice yet
  const appointment = await pool.query(
    ``,
    [appointmentId, receptionistId]
  );
  if (appointment.rowCount === 0) {
    res.status(400).json({ error: "Only completed visits at your office without an invoice can be billed" });
    return;
  }

  // create a pending invoice dated today
  const result = await pool.query(
    ``,
    [appointment.rows[0].patientId, appointmentId, amount]
  );

  res.status(201).json(result.rows[0]);
});

// mark an unpaid invoice as overdue
receptionistBillingRouter.patch("/api/receptionist/invoices/:id/overdue", async (req, res) => {
  const receptionistId = req.session.employeeId;
  const invoiceId = Number(req.params.id);

  // set a pending invoice for a visit at my office to Overdue
  const result = await pool.query(
    ``,
    [invoiceId, receptionistId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Only pending invoices at your office can be marked overdue" });
    return;
  }

  res.json(result.rows[0]);
});

// get the payment types for the dropdown
receptionistBillingRouter.get("/api/receptionist/payment-types", async (_req, res) => {
  // get every active payment type, sorted by name
  const result = await pool.query(
    ``
  );

  res.json(result.rows);
});

// take a payment at the front desk
receptionistBillingRouter.post("/api/receptionist/invoices/:id/payments", async (req, res) => {
  const receptionistId = req.session.employeeId;
  const invoiceId = Number(req.params.id);
  const paymentTypeId = Number(req.body.paymentTypeId);
  const amount = Math.round(Number(req.body.amount) * 100) / 100;

  if (!paymentTypeId || !(amount > 0)) {
    res.status(400).json({ error: "Choose a payment type and enter an amount more than 0" });
    return;
  }

  // save the payment and the invoice status together
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // get what is left on an unpaid invoice at my office (and lock it so two payments can't overpay)
    const invoice = await client.query(
      ``,
      [invoiceId, receptionistId]
    );
    if (invoice.rowCount === 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Only unpaid invoices at your office can take a payment" });
      return;
    }
    const balance = invoice.rows[0].balance;
    if (amount > balance) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Only $${balance.toFixed(2)} is left on this invoice` });
      return;
    }

    // save the payment dated today, handled by me
    const payment = await client.query(
      ``,
      [invoiceId, paymentTypeId, receptionistId, amount]
    );

    // set the invoice to Paid when the payments now cover the whole amount
    const paid = await client.query(
      ``,
      [invoiceId]
    );

    await client.query("COMMIT");
    res.status(201).json({ paymentId: payment.rows[0].paymentId, paidOff: paid.rowCount === 1 });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../../middleware/errorHandler.js";
import {
  createInvoice,
  getInvoice,
  listBillableAppointments,
  listInvoices,
  listPayments,
  listPaymentTypes,
  moneySchema,
  recordPayment,
} from "../../services/billing.js";

// mounted at /api/admin, so only admins reach these
export const adminBillingRouter = Router();

const id = (label: string) => z.coerce.number(`Choose ${label}`).int(`Choose ${label}`).positive(`Choose ${label}`);
const invoiceQuery = z.object({
  status: z.enum(["Pending", "Paid", "Overdue", "unpaid"], "Status must be Pending, Paid, Overdue or unpaid").optional(),
  patientId: id("a patient").optional(),
  search: z.string().trim().max(100).default(""),
});
const invoiceBody = z.object({ appointmentId: id("an appointment"), amount: moneySchema });
const paymentBody = z.object({ paymentTypeId: id("a payment type"), amount: moneySchema });

adminBillingRouter.get("/invoices", async (req, res) => {
  res.json(await listInvoices(invoiceQuery.parse(req.query)));
});

adminBillingRouter.get("/invoices/:id", async (req, res) => {
  const invoice = await getInvoice(id("an invoice").parse(req.params.id));
  if (!invoice) throw new HttpError(404, "Invoice not found");
  res.json(invoice);
});

// bill a completed visit for the amount the admin enters
adminBillingRouter.post("/invoices", async (req, res) => {
  const { appointmentId, amount } = invoiceBody.parse(req.body);
  res.status(201).json(await createInvoice(appointmentId, amount));
});

adminBillingRouter.post("/invoices/:id/payments", async (req, res) => {
  if (!req.user || req.user.role === "patient") throw new HttpError(401, "Login required");
  const invoiceId = id("an invoice").parse(req.params.id);
  res.status(201).json(await recordPayment(invoiceId, paymentBody.parse(req.body), req.user.employeeId));
});

adminBillingRouter.get("/payments", async (req, res) => {
  const { patientId } = z.object({ patientId: id("a patient").optional() }).parse(req.query);
  res.json(await listPayments({ patientId }));
});

adminBillingRouter.get("/payment-types", async (_req, res) => {
  res.json(await listPaymentTypes());
});

adminBillingRouter.get("/billable-appointments", async (_req, res) => {
  res.json(await listBillableAppointments());
});

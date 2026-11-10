import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  TEST_CLOCK_OPTION,
  addAppointment,
  addEmployee,
  addLogin,
  addPatient,
  addSlots,
  asEmployee,
  dayFrom,
  freezeClockAtNoon,
  unfreezeClock,
  waitForLockWait,
} from "./helpers/appointmentData.js";
import { failWrites } from "./helpers/dbFaults.js";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient, TestResponse } from "./helpers/testApp.js";
import { ids, resetDatabase } from "./helpers/testDb.js";

const INVOICE_KEYS = [
  "invoiceId", "patientId", "patientName", "appointmentId", "appointmentDate", "doctorName", "officeName",
  "issueDate", "amount", "paid", "balance", "status", "items", "payments",
];

let app: Awaited<ReturnType<typeof startTestApp>>;
let today: string;
let slot: number;
let admin: TestClient, pat: TestClient, desk: TestClient, rita: TestClient;
let others: [string, TestClient, number][];
let oliveId: number, deskId: number, cashId: number, cardId: number, insuranceTypeId: number, retiredTypeId: number;
let daysBack = 0;
let daysAhead = 300;

const statuses = (responses: TestResponse[]) => responses.map((r) => r.status).sort();
const pay = (invoiceId: number | string, amount: unknown, paymentTypeId: number = cashId) =>
  admin.post(`/api/admin/invoices/${invoiceId}/payments`, { paymentTypeId, amount });
const checkOut = (appointmentId: number | string) => desk.patch(`/api/receptionist/appointments/${appointmentId}/check-out`);
const card = { cardType: "Credit Card", nameOnCard: "Pat Patient", cardNumber: "4111 1111 1111 1111", expiry: "12/35", cvv: "123" };

// a visit on its own past day, so visits never overlap
async function visit(status = "Completed", patientId: number = ids.patient) {
  daysBack += 1;
  return addAppointment(app.db, { patientId, doctorId: ids.doctor, officeId: ids.mainOffice, date: dayFrom(today, -daysBack), timeSlotId: slot, status });
}

// a past visit the patient checked in for, waiting to be checked out
async function arrived(patientId: number = ids.patient) {
  const appointmentId = await visit("Scheduled", patientId);
  await app.db.query(`UPDATE appointment SET checked_in_at = appointment_date + TIME '08:00' WHERE appointment_id = $1`, [appointmentId]);
  return appointmentId;
}

async function openInvoiceOf(appointmentId: number) {
  const { rows } = await app.db.query(`SELECT invoice_id FROM invoice WHERE appointment_id = $1 AND status <> 'Void'`, [appointmentId]);
  return rows[0]?.invoice_id as number | undefined;
}

// the front desk checks the visit out, and the visit fee (set to the amount here) becomes the invoice
async function invoiceFor(amount: string, patientId: number = ids.patient) {
  await app.db.query(`UPDATE service_fee SET price = $1 WHERE specialty_id = $2`, [amount, ids.familyMedicine]);
  const appointmentId = await arrived(patientId);
  const res = await checkOut(appointmentId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const invoiceId = await openInvoiceOf(appointmentId);
  assert.ok(invoiceId, "checking out made no invoice");
  return invoiceId;
}

// for historical states the API wouldn't create, like a Paid invoice that wasn't fully paid
// it's billed for enough to take the payments, then set to the old amount and status
async function oldInvoice(amount: string, status: string, payments: string[], patientId: number = ids.patient) {
  const appointmentId = await visit("Completed", patientId);
  const billed = Math.max(Number(amount), payments.reduce((total, paid) => total + Number(paid), 0)).toFixed(2);
  return asEmployee(app.db, ids.admin, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO invoice (patient_id, appointment_id, amount, issue_date, status) VALUES ($1, $2, $3, $4, 'Pending') RETURNING invoice_id`,
      [patientId, appointmentId, billed, dayFrom(today, -60)]
    );
    for (const paid of payments) {
      await client.query(`INSERT INTO payment (invoice_id, payment_type_id, amount_paid, payment_date) VALUES ($1, $2, $3, $4)`, [
        rows[0].invoice_id,
        cashId,
        paid,
        dayFrom(today, -50),
      ]);
    }
    await client.query(`UPDATE invoice SET amount = $2, status = $3 WHERE invoice_id = $1`, [rows[0].invoice_id, amount, status]);
    return rows[0].invoice_id as number;
  });
}

async function counts() {
  const { rows } = await app.db.query(
    `SELECT (SELECT count(*) FROM invoice)::int AS invoices, (SELECT count(*) FROM invoice_item)::int AS items,
       (SELECT count(*) FROM payment)::int AS payments, (SELECT count(*) FROM billing_history)::int AS history`
  );
  return rows[0] as { invoices: number; items: number; payments: number; history: number };
}

// paid leaves out refunded payments, like every balance does
async function invoiceRow(invoiceId: number) {
  const { rows } = await app.db.query(
    `SELECT status, (SELECT COALESCE(sum(amount_paid), 0)::text FROM payment WHERE invoice_id = $1 AND status <> 'Refunded') AS paid FROM invoice WHERE invoice_id = $1`,
    [invoiceId]
  );
  return rows[0] as { status: string; paid: string };
}

async function paymentStatus(paymentId: number) {
  return (await app.db.query(`SELECT status FROM payment WHERE payment_id = $1`, [paymentId])).rows[0].status as string;
}

// holds a change open in its own transaction while a request waits on it
// the held changes run as the admin, since the billing triggers need to know who made them
async function whileHeld(changes: [string, unknown[]][], send: () => Promise<TestResponse>) {
  const held = await app.db.connect();
  try {
    await held.query("BEGIN");
    await held.query(`SELECT set_config('app.employee_id', $1, true)`, [String(ids.admin)]);
    for (const [sql, params] of changes) await held.query(sql, params);
    const waiting = send();
    await waitForLockWait(app.db);
    await held.query("COMMIT");
    return await waiting;
  } catch (err) {
    await held.query("ROLLBACK");
    throw err;
  } finally {
    held.release();
  }
}

before(async () => {
  await resetDatabase();
  // at noon in Chicago it's already the next day in Kiritimati, so a record dated by the database would be a day off
  process.env.DATABASE_URL += `?options=${encodeURIComponent(`-c TimeZone=Pacific/Kiritimati ${TEST_CLOCK_OPTION}`)}`;
  app = await startTestApp();
  today = await freezeClockAtNoon(app.db);
  slot = (await addSlots(app.db)).morning;
  oliveId = await addPatient(app.db, "Olive", "Other");

  const types = await app.db.query(`INSERT INTO payment_type (name) VALUES ('Cash'), ('Credit Card'), ('Insurance') RETURNING payment_type_id`);
  [cashId, cardId, insuranceTypeId] = types.rows.map((r) => r.payment_type_id);
  retiredTypeId = (await app.db.query(`INSERT INTO payment_type (name, is_active) VALUES ('Old Check', false) RETURNING payment_type_id`)).rows[0]
    .payment_type_id;

  // Rita works at Westside, and Rhea checks out the Main Street visits
  await addLogin(app.db, ids.receptionist);
  deskId = await addEmployee(app.db, "Rhea", 4, ids.mainOffice);
  const labType = await app.db.query(`INSERT INTO employee_types (type_name) VALUES ('Lab Technician') RETURNING employee_type_id AS id`);
  const labId = await addEmployee(app.db, "Lee", labType.rows[0].id, ids.mainOffice);

  admin = await app.loginStaff(ids.admin);
  pat = await app.loginPatient(ids.patient, "pat@test.org");
  desk = await app.loginStaff(deskId);
  rita = await app.loginStaff(ids.receptionist);
  others = [
    ["visitor", app.client(), 401],
    ["patient", pat, 403],
    ["receptionist", rita, 403],
    ["nurse", await app.loginStaff(ids.nurse), 403],
    ["doctor", await app.loginStaff(ids.doctor), 403],
    ["lab", await app.loginStaff(labId), 403],
  ];
});

after(async () => {
  await unfreezeClock(app.db);
  await app.close();
});

describe("invoices made at check out", () => {
  test("checking out bills the visit fee to the visit's patient", async () => {
    const appointmentId = await arrived(oliveId);
    assert.equal((await checkOut(appointmentId)).status, 200);
    const invoiceId = await openInvoiceOf(appointmentId);
    const res = await admin.get(`/api/admin/invoices/${invoiceId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body), INVOICE_KEYS);
    assert.deepEqual(
      [res.body.patientId, res.body.appointmentId, res.body.amount, res.body.paid, res.body.balance, res.body.status, res.body.issueDate, res.body.payments],
      [oliveId, appointmentId, "150.00", "0.00", "150.00", "Pending", today, []]
    );
    assert.deepEqual(res.body.items.map((i: { category: string; description: string; price: string }) => [i.category, i.description, i.price]), [
      ["Visit", "Family Medicine visit", "150.00"],
    ]);
    const stored = await app.db.query(`SELECT patient_id, to_char(issue_date, 'YYYY-MM-DD') AS issued FROM invoice WHERE invoice_id = $1`, [invoiceId]);
    assert.deepEqual(stored.rows[0], { patient_id: oliveId, issued: today });
    const history = await admin.get(`/api/admin/invoices/${invoiceId}/history`);
    assert.deepEqual(history.body.map((h: { oldStatus: string | null; newStatus: string; changedBy: string }) => [h.oldStatus, h.newStatus, h.changedBy]), [
      [null, "Pending", "Rhea Tester"],
    ]);
  });

  test("lab tests and medications from the visit are lines on the invoice, and cancelled or stopped ones aren't", async () => {
    const appointmentId = await arrived();
    const [blood, urine] = (
      await app.db.query(`INSERT INTO lab_test_type (name, cost) VALUES ('Lipid Panel', 45.10), ('Urinalysis', 20) RETURNING lab_test_type_id AS id`)
    ).rows.map((r) => r.id);
    const [statin, retired] = (await app.db.query(`INSERT INTO medication (name) VALUES ('Atorvastatin'), ('Old Pill') RETURNING medication_id AS id`)).rows.map((r) => r.id);
    await app.db.query(
      `INSERT INTO service_fee (category, type, name, price, lab_test_type_id) VALUES ('Lab Test', 'Blood Test', 'Lipid Panel', 45.10, $1), ('Lab Test', 'Urine Test', 'Urinalysis', 20.00, $2)`,
      [blood, urine]
    );
    await app.db.query(
      `INSERT INTO service_fee (category, type, name, price, medication_id) VALUES ('Medication', 'Cholesterol', 'Atorvastatin', 20.05, $1), ('Medication', 'Other', 'Old Pill', 9.00, $2)`,
      [statin, retired]
    );
    await app.db.query(
      `INSERT INTO lab_order (patient_id, ordered_by_employee_id, lab_test_type_id, appointment_id, status) VALUES ($1, $2, $3, $5, 'Ordered'), ($1, $2, $4, $5, 'Cancelled')`,
      [ids.patient, ids.doctor, blood, urine, appointmentId]
    );
    const rx = await app.db.query(`INSERT INTO prescription (patient_id, prescriber_id, appointment_id) VALUES ($1, $2, $3) RETURNING prescription_id AS id`, [
      ids.patient,
      ids.doctor,
      appointmentId,
    ]);
    await app.db.query(`INSERT INTO prescription_item (prescription_id, medication_id, dosage, is_active) VALUES ($1, $2, '20 mg', true), ($1, $3, '5 mg', false)`, [
      rx.rows[0].id,
      statin,
      retired,
    ]);

    assert.equal((await checkOut(appointmentId)).status, 200);
    const invoice = (await admin.get(`/api/admin/invoices/${await openInvoiceOf(appointmentId)}`)).body;
    assert.deepEqual(invoice.items.map((i: { category: string; description: string; price: string }) => [i.category, i.description, i.price]), [
      ["Visit", "Family Medicine visit", "150.00"],
      ["Lab Test", "Lipid Panel", "45.10"],
      ["Medication", "Atorvastatin (20 mg)", "20.05"],
    ]);
    assert.deepEqual([invoice.amount, invoice.balance], ["215.15", "215.15"]);
  });

  test("only checking out bills a visit, and only once", async () => {
    for (const status of ["Cancelled", "No Show"]) {
      const appointmentId = await visit("Scheduled");
      await asEmployee(app.db, ids.admin, (client) => client.query(`UPDATE appointment SET status = $2 WHERE appointment_id = $1`, [appointmentId, status]));
      assert.equal(await openInvoiceOf(appointmentId), undefined, status);
      assert.equal((await checkOut(appointmentId)).status, 409, status);
    }
    daysAhead += 1;
    const notHere = await addAppointment(app.db, { patientId: ids.patient, doctorId: ids.doctor, officeId: ids.mainOffice, date: dayFrom(today, daysAhead), timeSlotId: slot });
    assert.deepEqual((await checkOut(notHere)).body, { error: "The patient hasn't been checked in" });
    assert.equal(await openInvoiceOf(notHere), undefined);

    const appointmentId = await arrived();
    assert.equal((await checkOut(appointmentId)).status, 200);
    assert.deepEqual((await checkOut(appointmentId)).body, { error: "Only scheduled appointments can be checked out. This one is Completed." });
    const { rows } = await app.db.query(`SELECT count(*)::int AS n FROM invoice WHERE appointment_id = $1`, [appointmentId]);
    assert.equal(rows[0].n, 1);
    assert.equal((await rita.patch(`/api/receptionist/appointments/${await arrived()}/check-out`)).status, 403);
    assert.equal((await checkOut(999999)).status, 404);
    assert.equal((await checkOut("abc")).status, 400);
  });

  test("two check outs of the same visit at once make one invoice", async () => {
    const appointmentId = await arrived();
    assert.deepEqual(statuses(await Promise.all([checkOut(appointmentId), checkOut(appointmentId)])), [200, 409]);
    const { rows } = await app.db.query(`SELECT count(*)::int AS n FROM invoice WHERE appointment_id = $1`, [appointmentId]);
    assert.equal(rows[0].n, 1);
  });

  test("without the unique index, the lock on the visit alone stops a second invoice", async () => {
    await app.db.query(`DROP INDEX invoice_one_per_appointment`);
    try {
      const appointmentId = await arrived();
      const res = await whileHeld(
        [[`UPDATE appointment SET checked_out_at = now(), status = 'Completed' WHERE appointment_id = $1`, [appointmentId]]],
        () => checkOut(appointmentId)
      );
      assert.deepEqual([res.status, res.body.error], [409, "Only scheduled appointments can be checked out. This one is Completed."]);
      const { rows } = await app.db.query(`SELECT count(*)::int AS n FROM invoice WHERE appointment_id = $1`, [appointmentId]);
      assert.equal(rows[0].n, 1);
    } finally {
      await app.db.query(`CREATE UNIQUE INDEX invoice_one_per_appointment ON invoice (appointment_id) WHERE status <> 'Void'`);
    }
  });

  test("a check out whose invoice can't be saved leaves the visit open and nothing behind", async () => {
    const appointmentId = await arrived();
    const visitRow = async () =>
      (await app.db.query(`SELECT status, checked_out_at FROM appointment WHERE appointment_id = $1`, [appointmentId])).rows[0];
    const historyRows = async () => (await app.db.query(`SELECT count(*)::int AS n FROM appointment_history WHERE appointment_id = $1`, [appointmentId])).rows[0].n;
    const before = [await counts(), await visitRow(), await historyRows()];
    for (const table of ["invoice", "invoice_item"]) {
      const restore = await failWrites(app.db, table, "INSERT");
      try {
        assert.equal((await checkOut(appointmentId)).status, 400, table);
      } finally {
        await restore();
      }
      assert.deepEqual([await counts(), await visitRow(), await historyRows()], before, table);
    }
    assert.equal((await checkOut(appointmentId)).status, 200);
    assert.ok(await openInvoiceOf(appointmentId));
  });
});

describe("recording payments", () => {
  test("partial payments lower the balance and the last one marks the invoice Paid", async () => {
    const invoiceId = await invoiceFor("100.00");
    const first = await pay(invoiceId, "40.25");
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual([first.body.invoice.paid, first.body.invoice.balance, first.body.invoice.status], ["40.25", "59.75", "Pending"]);
    assert.deepEqual(first.body.invoice.payments.map((p: { paymentId: number }) => p.paymentId), [first.body.paymentId]);
    const stored = await app.db.query(`SELECT handled_by, to_char(payment_date, 'YYYY-MM-DD') AS paid_on FROM payment WHERE payment_id = $1`, [first.body.paymentId]);
    assert.deepEqual(stored.rows[0], { handled_by: ids.admin, paid_on: today });

    const last = await pay(invoiceId, 59.75, cardId);
    assert.deepEqual([last.body.invoice.paid, last.body.invoice.balance, last.body.invoice.status], ["100.00", "0.00", "Paid"]);
    assert.deepEqual(last.body.invoice.payments.map((p: { paymentType: string }) => p.paymentType), ["Credit Card", "Cash"]);
    assert.deepEqual(last.body.invoice.payments.map((p: { status: string; handledBy: string }) => [p.status, p.handledBy]), [
      ["Completed", "Ada Admin"],
      ["Completed", "Ada Admin"],
    ]);
    assert.deepEqual((await pay(invoiceId, "1.00")).body, { error: "This invoice is already paid" });
  });

  test("a payment can't be more than what's left", async () => {
    const invoiceId = await invoiceFor("50.00");
    await pay(invoiceId, "20.00");
    const res = await pay(invoiceId, "30.01");
    assert.deepEqual([res.status, res.body.error], [409, "Only $30.00 is left on this invoice"]);
    assert.deepEqual(await invoiceRow(invoiceId), { status: "Pending", paid: "20.00" });
  });

  test("the database itself refuses a payment written straight to the table that's more than what's left", async () => {
    const invoiceId = await invoiceFor("50.00");
    await pay(invoiceId, "20.00");
    const insert = (amount: string) =>
      asEmployee(app.db, ids.admin, (client) =>
        client.query(`INSERT INTO payment (invoice_id, payment_type_id, amount_paid) VALUES ($1, $2, $3)`, [invoiceId, cashId, amount])
      );
    await assert.rejects(insert("30.01"), (err: { code?: string; message?: string }) => err.code === "P0001" && err.message === "Only $30.00 is left on this invoice");
    // without the employee the trigger refuses it before it's saved
    await assert.rejects(
      app.db.query(`INSERT INTO payment (invoice_id, payment_type_id, amount_paid) VALUES ($1, $2, 1)`, [invoiceId, cashId]),
      /Billing changes need the employee who made them/
    );
    assert.deepEqual(await invoiceRow(invoiceId), { status: "Pending", paid: "20.00" });
    await insert("30.00");
    assert.deepEqual(await invoiceRow(invoiceId), { status: "Paid", paid: "50.00" });
  });

  test("payment amounts have to be positive dollars and cents", async () => {
    const invoiceId = await invoiceFor("100.00");
    const before = await counts();
    for (const amount of [0, "0.00", -5, "12.345", "abc", 1e21, "", null, "1,000"]) {
      assert.equal((await pay(invoiceId, amount)).status, 400, String(amount));
    }
    assert.deepEqual(await counts(), before);
    assert.equal((await pay(invoiceId, 19.99)).body.invoice.paid, "19.99");
  });

  test("bad payment types, amounts and invoices are rejected", async () => {
    const invoiceId = await invoiceFor("75.00");
    assert.deepEqual((await pay(invoiceId, "10", retiredTypeId)).body, { error: "Choose an active payment type" });
    assert.equal((await pay(invoiceId, "10", 99999)).status, 400);
    for (const amount of [0, -1, "1.234", "ten"]) assert.equal((await pay(invoiceId, amount)).status, 400, String(amount));
    assert.equal((await pay(999999, "10")).status, 404);
    assert.deepEqual(await invoiceRow(invoiceId), { status: "Pending", paid: "0" });
  });

  test("an Overdue invoice becomes Paid once it's settled", async () => {
    const invoiceId = await oldInvoice("90.00", "Overdue", ["30.00"]);
    const res = await pay(invoiceId, "60.00");
    assert.deepEqual([res.body.invoice.status, res.body.invoice.balance], ["Paid", "0.00"]);
  });

  test("cents add up exactly", async () => {
    const invoiceId = await invoiceFor("100.00");
    for (let i = 0; i < 3; i++) await pay(invoiceId, "33.33");
    const res = await admin.get(`/api/admin/invoices/${invoiceId}`);
    assert.deepEqual([res.body.paid, res.body.balance, res.body.status], ["99.99", "0.01", "Pending"]);
    assert.equal((await pay(invoiceId, "0.01")).body.invoice.status, "Paid");
  });
});

describe("payments at the same time", () => {
  test("two payments that together would overpay leave one of them", async () => {
    const invoiceId = await invoiceFor("100.00");
    assert.deepEqual(statuses(await Promise.all([pay(invoiceId, "60.00"), pay(invoiceId, "60.00")])), [201, 409]);
    assert.deepEqual(await invoiceRow(invoiceId), { status: "Pending", paid: "60.00" });
  });

  test("two payments that fit both go through and settle the invoice", async () => {
    const invoiceId = await invoiceFor("100.00");
    assert.deepEqual(statuses(await Promise.all([pay(invoiceId, "50.00"), pay(invoiceId, "50.00")])), [201, 201]);
    assert.deepEqual(await invoiceRow(invoiceId), { status: "Paid", paid: "100.00" });
  });

  test("a payment waiting on another one sees the new balance", async () => {
    const invoiceId = await invoiceFor("100.00");
    const res = await whileHeld(
      [
        [`SELECT 1 FROM invoice WHERE invoice_id = $1 FOR NO KEY UPDATE`, [invoiceId]],
        [`INSERT INTO payment (invoice_id, payment_type_id, amount_paid) VALUES ($1, $2, 70)`, [invoiceId, cashId]],
      ],
      () => pay(invoiceId, "50.00")
    );
    assert.deepEqual([res.status, res.body.error], [409, "Only $30.00 is left on this invoice"]);
    assert.deepEqual(await invoiceRow(invoiceId), { status: "Pending", paid: "70.00" });
  });

  test("a payment type turned off while the payment waits isn't used", async () => {
    const invoiceId = await invoiceFor("40.00");
    try {
      const res = await whileHeld([[`UPDATE payment_type SET is_active = false WHERE payment_type_id = $1`, [cardId]]], () => pay(invoiceId, "40.00", cardId));
      assert.deepEqual([res.status, res.body.error], [400, "Choose an active payment type"]);
      assert.deepEqual(await invoiceRow(invoiceId), { status: "Pending", paid: "0" });
    } finally {
      await app.db.query(`UPDATE payment_type SET is_active = true WHERE payment_type_id = $1`, [cardId]);
    }
  });

  test("a payment that fails part way leaves no payment and no status change", async () => {
    const invoiceId = await invoiceFor("25.00");
    for (const [table, event] of [["payment", "INSERT"], ["invoice", "UPDATE"]] as const) {
      const restore = await failWrites(app.db, table, event);
      try {
        assert.equal((await pay(invoiceId, "25.00")).status, 400, `${table} ${event}`);
      } finally {
        await restore();
      }
      assert.deepEqual(await invoiceRow(invoiceId), { status: "Pending", paid: "0" });
    }
  });
});

describe("refunds and void invoices", () => {
  const requestRefund = (paymentId: number, reason = "Charged twice") => desk.patch(`/api/receptionist/payments/${paymentId}/request-refund`, { reason });

  test("the front desk asks for a refund, the admin decides, and a refund makes the invoice owe again", async () => {
    const invoiceId = await invoiceFor("60.00");
    const paid = await desk.post(`/api/receptionist/invoices/${invoiceId}/payments`, { paymentTypeId: cashId, amount: "60.00" });
    const paymentId = paid.body.paymentId as number;
    assert.equal(paid.body.invoice.status, "Paid");

    assert.equal((await desk.patch(`/api/receptionist/payments/${paymentId}/request-refund`, {})).status, 400);
    // Rita is at another office, so she can't ask for it
    assert.equal((await rita.patch(`/api/receptionist/payments/${paymentId}/request-refund`, { reason: "Nope" })).status, 409);
    assert.equal(await paymentStatus(paymentId), "Completed");

    // a request still counts as paid until it's decided
    const asked = await requestRefund(paymentId);
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.deepEqual([asked.body.status, asked.body.balance, asked.body.payments[0].status], ["Paid", "0.00", "Requested"]);
    const waiting = (await admin.get("/api/admin/refund-requests")).body.find((r: { paymentId: number }) => r.paymentId === paymentId);
    assert.deepEqual([waiting?.amountPaid, waiting?.requestedBy, waiting?.reason, waiting?.officeName], ["60.00", "Rhea Tester", "Charged twice", "Main Street Clinic"]);
    assert.deepEqual((await requestRefund(paymentId)).status, 409);

    const denied = await admin.patch(`/api/admin/payments/${paymentId}/deny-refund`, { reason: "Only charged once" });
    assert.deepEqual([denied.status, denied.body.status, denied.body.payments[0].status], [200, "Paid", "Completed"]);
    assert.equal((await admin.patch(`/api/admin/payments/${paymentId}/deny-refund`, {})).status, 409);

    await requestRefund(paymentId, "Asked by mistake");
    const cancelled = await desk.patch(`/api/receptionist/payments/${paymentId}/cancel-request`);
    assert.deepEqual([cancelled.status, cancelled.body.payments[0].status], [200, "Completed"]);
    assert.equal((await desk.patch(`/api/receptionist/payments/${paymentId}/cancel-request`)).status, 409);

    await requestRefund(paymentId);
    const refunded = await admin.patch(`/api/admin/payments/${paymentId}/approve-refund`, { reason: "Card charged twice" });
    assert.equal(refunded.status, 200, JSON.stringify(refunded.body));
    assert.deepEqual([refunded.body.status, refunded.body.paid, refunded.body.balance, refunded.body.payments[0].status], ["Pending", "0.00", "60.00", "Refunded"]);
    assert.equal((await admin.patch(`/api/admin/payments/${paymentId}/approve-refund`, {})).status, 409);
    assert.equal((await admin.get("/api/admin/refund-requests")).body.some((r: { paymentId: number }) => r.paymentId === paymentId), false);

    // a refunded amount can be paid again
    assert.equal((await pay(invoiceId, "60.00")).body.invoice.status, "Paid");

    const history = (await admin.get(`/api/admin/invoices/${invoiceId}/history`)).body as { paymentId: number | null; oldStatus: string | null; newStatus: string; changedBy: string; reason: string | null }[];
    assert.deepEqual(
      history.filter((h) => h.paymentId === paymentId).map((h) => [h.oldStatus, h.newStatus, h.changedBy, h.reason]).reverse(),
      [
        [null, "Completed", "Rhea Tester", null],
        ["Completed", "Requested", "Rhea Tester", "Charged twice"],
        ["Requested", "Completed", "Ada Admin", "Only charged once"],
        ["Completed", "Requested", "Rhea Tester", "Asked by mistake"],
        ["Requested", "Completed", "Rhea Tester", "Request cancelled"],
        ["Completed", "Requested", "Rhea Tester", "Charged twice"],
        ["Requested", "Refunded", "Ada Admin", "Card charged twice"],
      ]
    );
  });

  test("an invoice is voided only once its payments are refunded, and a void invoice can't change", async () => {
    const invoiceId = await invoiceFor("45.00", ids.patient);
    const paymentId = (await pay(invoiceId, "20.00")).body.paymentId as number;

    assert.equal((await admin.patch(`/api/admin/invoices/${invoiceId}/void`, {})).status, 400);
    const early = await admin.patch(`/api/admin/invoices/${invoiceId}/void`, { reason: "Wrong patient" });
    assert.deepEqual([early.status, early.body.error], [409, "Refund every payment on this invoice before voiding it"]);
    assert.equal((await admin.patch("/api/admin/invoices/999999/void", { reason: "Wrong patient" })).status, 404);

    await requestRefund(paymentId, "Wrong patient");
    const voided = await admin.patch(`/api/admin/payments/${paymentId}/approve-refund`, { voidInvoice: true, reason: "Wrong patient" });
    assert.equal(voided.status, 200, JSON.stringify(voided.body));
    assert.deepEqual([voided.body.status, voided.body.paid, voided.body.balance], ["Void", "0.00", "0.00"]);

    assert.deepEqual((await pay(invoiceId, "1.00")).body, { error: "This invoice is void and can't take payments" });
    assert.deepEqual((await admin.patch(`/api/admin/invoices/${invoiceId}/void`, { reason: "Again" })).body, { error: "This invoice is already void" });
    assert.equal((await desk.get(`/api/receptionist/invoices/${invoiceId}`)).status, 404);
    assert.equal((await desk.get("/api/receptionist/invoices")).body.some((i: { invoiceId: number }) => i.invoiceId === invoiceId), false);
    assert.equal((await pat.post(`/api/patient/${ids.patient}/invoices/${invoiceId}/payments`, { ...card, amount: "1.00" })).status, 404);

    // the triggers keep a void invoice as it is, even written straight to the table
    await assert.rejects(
      asEmployee(app.db, ids.admin, (client) => client.query(`UPDATE invoice SET status = 'Pending' WHERE invoice_id = $1`, [invoiceId])),
      /is void and can't be changed/
    );
    await assert.rejects(
      asEmployee(app.db, ids.admin, (client) => client.query(`DELETE FROM invoice WHERE invoice_id = $1`, [invoiceId])),
      /can't be deleted/
    );
    assert.equal((await invoiceRow(invoiceId)).status, "Void");
  });

  test("a refund that fails part way leaves the payment requested and the invoice as it was", async () => {
    const invoiceId = await invoiceFor("35.00");
    const paymentId = (await pay(invoiceId, "35.00")).body.paymentId as number;
    await requestRefund(paymentId);
    for (const [table, body] of [["payment", {}], ["invoice", { voidInvoice: true }]] as const) {
      const before = await counts();
      const restore = await failWrites(app.db, table, "UPDATE");
      try {
        assert.equal((await admin.patch(`/api/admin/payments/${paymentId}/approve-refund`, body)).status, 400, table);
      } finally {
        await restore();
      }
      assert.deepEqual(await counts(), before, table);
      assert.equal(await paymentStatus(paymentId), "Requested", table);
      assert.deepEqual(await invoiceRow(invoiceId), { status: "Paid", paid: "35.00" }, table);
    }
  });
});

describe("patients paying online", () => {
  test("a patient pays their own invoice by card, and it's recorded as theirs", async () => {
    const invoiceId = await invoiceFor("70.00");
    const paying = (body: object, patient = pat, patientId = ids.patient, invoice = invoiceId) =>
      patient.post(`/api/patient/${patientId}/invoices/${invoice}/payments`, { ...card, ...body });

    const before = await counts();
    for (const body of [{ amount: "0" }, { amount: "10", cardNumber: "1234" }, { amount: "10", expiry: "01/20" }, { amount: "10", cvv: "1" }, { amount: "10", cardType: "Cash" }]) {
      assert.equal((await paying(body)).status, 400, JSON.stringify(body));
    }
    const tooMuch = await paying({ amount: "70.01" });
    assert.deepEqual([tooMuch.status, tooMuch.body.error], [409, "Only $70.00 is left on this invoice"]);
    assert.equal((await paying({ amount: "10" }, pat, oliveId)).status, 403);
    assert.deepEqual(await counts(), before);

    const first = await paying({ amount: "25.50" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual([first.body.paid, first.body.balance, first.body.status], ["25.50", "44.50", "Pending"]);
    assert.deepEqual([first.body.payments[0].paymentType, first.body.payments[0].handledBy], ["Credit Card", null]);
    assert.equal((await paying({ amount: "44.50" })).body.status, "Paid");
    assert.deepEqual((await paying({ amount: "1.00" })).body, { error: "This invoice is already paid" });

    const history = (await admin.get(`/api/admin/invoices/${invoiceId}/history`)).body;
    assert.deepEqual(history[0], { ...history[0], oldStatus: "Pending", newStatus: "Paid", changedBy: "Pat Patient", changedByType: "Patient" });
  });

  test("a patient can't pay someone else's invoice", async () => {
    const invoiceId = await invoiceFor("40.00", oliveId);
    const before = await counts();
    assert.deepEqual((await pat.post(`/api/patient/${ids.patient}/invoices/${invoiceId}/payments`, { ...card, amount: "10.00" })).body, { error: "Invoice not found" });
    // the trigger also refuses it when the app is skipped
    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.patient_id', $1, true)`, [String(ids.patient)]);
      await assert.rejects(
        client.query(`INSERT INTO payment (invoice_id, payment_type_id, amount_paid) VALUES ($1, $2, 10)`, [invoiceId, cardId]),
        /Patients can only pay their own invoices by card/
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    assert.deepEqual(await counts(), before);
  });

  test("a patient and the front desk paying at once can't pay more than the invoice", async () => {
    const invoiceId = await invoiceFor("100.00");
    const results = await Promise.all([
      pat.post(`/api/patient/${ids.patient}/invoices/${invoiceId}/payments`, { ...card, amount: "60.00" }),
      desk.post(`/api/receptionist/invoices/${invoiceId}/payments`, { paymentTypeId: cashId, amount: "60.00" }),
    ]);
    assert.deepEqual(statuses(results), [201, 409]);
    assert.deepEqual(await invoiceRow(invoiceId), { status: "Pending", paid: "60.00" });
  });
});

describe("insurance pays", () => {
  test("verifying a patient's insurance pays what's left on their open invoices", async () => {
    const patientId = await addPatient(app.db, "Ivy", "Insured");
    const partly = await invoiceFor("150.00", patientId);
    await pay(partly, "50.00");
    const unpaid = await invoiceFor("80.25", patientId);
    const settled = await invoiceFor("20.00", patientId);
    await pay(settled, "20.00");

    await app.db.query(`INSERT INTO insurance (patient_id, provider, policy_number) VALUES ($1, 'Blue Cross', 'BC-IVY')`, [patientId]);
    // nothing is paid while the insurance is only Pending
    assert.deepEqual(await invoiceRow(unpaid), { status: "Pending", paid: "0" });
    const verified = await rita.patch(`/api/receptionist/patients/${patientId}/insurance/status`, { provider: "Blue Cross", policyNumber: "BC-IVY", status: "Verified" });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));

    const { rows } = await app.db.query(
      `SELECT p.invoice_id, p.amount_paid, p.handled_by FROM payment p JOIN payment_type t ON t.payment_type_id = p.payment_type_id
       WHERE t.name = 'Insurance' AND p.invoice_id = ANY($1) ORDER BY p.invoice_id`,
      [[partly, unpaid, settled]]
    );
    assert.deepEqual(rows, [
      { invoice_id: partly, amount_paid: "100.00", handled_by: null },
      { invoice_id: unpaid, amount_paid: "80.25", handled_by: null },
    ]);
    for (const invoiceId of [partly, unpaid, settled]) assert.equal((await invoiceRow(invoiceId)).status, "Paid");
    assert.equal((await rita.get(`/api/receptionist/patients/${patientId}`)).body.balance, "0.00");
    const history = (await admin.get(`/api/admin/invoices/${unpaid}/history`)).body;
    assert.deepEqual(
      history.slice(0, 2).map((h: { newStatus: string; changedBy: string; reason: string }) => [h.newStatus, h.changedBy, h.reason]),
      [
        ["Paid", "Rita Reception", "Paid by insurance: Blue Cross"],
        ["Completed", "Rita Reception", "Paid by insurance: Blue Cross"],
      ]
    );

    // a visit checked out after the insurance is verified is paid by it right away
    const later = await invoiceFor("30.00", patientId);
    assert.deepEqual(await invoiceRow(later), { status: "Paid", paid: "30.00" });
  });
});

describe("balances everywhere", () => {
  test("old invoices are read from their payments, not their stored status", async () => {
    const patientId = await addPatient(app.db, "Hilda", "History");
    const cases = {
      unpaid: await oldInvoice("80.00", "Pending", [], patientId),
      overdue: await oldInvoice("60.00", "Overdue", ["10.00"], patientId),
      paid: await oldInvoice("50.00", "Paid", ["20.00", "30.00"], patientId),
      // a stale Paid status still shows what's really owed
      stalePaid: await oldInvoice("40.00", "Paid", ["15.00"], patientId),
      // paying too much in the past doesn't become a negative balance
      overpaid: await oldInvoice("20.00", "Pending", ["25.00"], patientId),
      // a void invoice owes nothing
      voided: await oldInvoice("30.00", "Void", [], patientId),
    };
    const list = (await admin.get(`/api/admin/invoices?patientId=${patientId}`)).body;
    const byId = new Map(list.map((i: { invoiceId: number }) => [i.invoiceId, i]));
    const view = (key: keyof typeof cases) => {
      const i = byId.get(cases[key]) as { paid: string; balance: string; status: string };
      return [i.paid, i.balance, i.status];
    };
    assert.deepEqual(view("unpaid"), ["0.00", "80.00", "Pending"]);
    assert.deepEqual(view("overdue"), ["10.00", "50.00", "Overdue"]);
    assert.deepEqual(view("paid"), ["50.00", "0.00", "Paid"]);
    assert.deepEqual(view("stalePaid"), ["15.00", "25.00", "Paid"]);
    assert.deepEqual(view("overpaid"), ["25.00", "0.00", "Pending"]);
    assert.deepEqual(view("voided"), ["0.00", "0.00", "Void"]);

    const unpaid = (await admin.get(`/api/admin/invoices?patientId=${patientId}&status=unpaid`)).body.map((i: { invoiceId: number }) => i.invoiceId);
    assert.deepEqual(unpaid.sort(), [cases.unpaid, cases.overdue, cases.stalePaid].sort());
  });

  test("the patient, the front desk and the Admin all see the same amount owed", async () => {
    const owedByAdmin = (await admin.get(`/api/admin/invoices?patientId=${ids.patient}`)).body.reduce(
      (cents: number, i: { balance: string }) => cents + Math.round(Number(i.balance) * 100),
      0
    );
    const expected = (owedByAdmin / 100).toFixed(2);
    assert.notEqual(expected, "0.00", "the patient should owe something by now");

    const billing = await pat.get(`/api/patient/${ids.patient}/billing`);
    assert.equal(billing.body.outstandingBalance, expected);
    assert.equal((await pat.get(`/api/patient/${ids.patient}/dashboard`)).body.outstandingBalance, expected);
    assert.equal((await rita.get(`/api/receptionist/patients/${ids.patient}`)).body.balance, expected);

    // refunded payments don't count, and void invoices owe nothing
    const allOwed = await app.db.query(
      `SELECT COALESCE(sum(CASE WHEN i.status = 'Void' THEN 0 ELSE GREATEST(i.amount - COALESCE((SELECT sum(amount_paid) FROM payment p WHERE p.invoice_id = i.invoice_id AND p.status <> 'Refunded'), 0), 0) END), 0)::float AS owed FROM invoice i`
    );
    assert.equal((await admin.get("/api/admin/dashboard")).body.pending, allOwed.rows[0].owed);
    const analytics = (await admin.get("/api/admin/analytics/billing")).body;
    assert.equal(analytics.outstanding, allOwed.rows[0].owed);
    assert.ok(analytics.unpaidInvoices.every((i: { balance: number }) => i.balance > 0), "unpaid report has a settled invoice");
  });

  test("the patient view keeps its fields, adds the balances, and shows only their own invoices", async () => {
    const res = await pat.get(`/api/patient/${ids.patient}/billing`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ["invoices", "payments", "outstandingBalance"]);
    assert.deepEqual(Object.keys(res.body.invoices[0]), INVOICE_KEYS.filter((key) => key !== "payments"));
    assert.deepEqual(Object.keys(res.body.payments[0]), ["paymentId", "invoiceId", "paymentDate", "amountPaid", "paymentType", "status"]);
    assert.match(res.body.invoices[0].issueDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(res.body.payments[0].paymentDate, /^\d{4}-\d{2}-\d{2}$/);

    // void invoices and their payments aren't shown to the patient
    const voided = await app.db.query(`SELECT count(*)::int AS n FROM invoice WHERE patient_id = $1 AND status = 'Void'`, [ids.patient]);
    assert.ok(voided.rows[0].n > 0, "the patient should have a void invoice by now");
    const mine = await app.db.query(`SELECT invoice_id FROM invoice WHERE patient_id = $1 AND status <> 'Void' ORDER BY invoice_id`, [ids.patient]);
    assert.deepEqual(res.body.invoices.map((i: { invoiceId: number }) => i.invoiceId).sort((a: number, b: number) => a - b), mine.rows.map((r) => r.invoice_id));
    const invoiceIds = new Set(mine.rows.map((r) => r.invoice_id));
    assert.ok(res.body.payments.every((p: { invoiceId: number }) => invoiceIds.has(p.invoiceId)), "a payment from another patient");
    assert.equal((await pat.get(`/api/patient/${oliveId}/billing`)).status, 403);
  });
});

describe("admin billing lists", () => {
  test("invoices filter by status and patient name", async () => {
    const paid = (await admin.get("/api/admin/invoices?status=Paid")).body;
    assert.ok(paid.length > 0 && paid.every((i: { status: string }) => i.status === "Paid"), "status filter");
    const olive = (await admin.get("/api/admin/invoices?search=olive")).body;
    assert.ok(olive.length > 0 && olive.every((i: { patientId: number }) => i.patientId === oliveId), "name search");
    const voided = (await admin.get("/api/admin/invoices?status=Void")).body;
    assert.ok(voided.length > 0 && voided.every((i: { status: string; balance: string }) => i.status === "Void" && i.balance === "0.00"), "void filter");
    assert.equal((await admin.get("/api/admin/invoices?status=Late")).status, 400);
    assert.equal((await admin.get("/api/admin/invoices/999999")).status, 404);
  });

  test("every checked out visit was billed with at most one open invoice, and payment types and payment history are listed", async () => {
    // a visit whose only invoice was voided has none open
    const { rows } = await app.db.query(`
      SELECT a.appointment_id FROM appointment a
      WHERE a.checked_out_at IS NOT NULL
        AND (NOT EXISTS (SELECT 1 FROM invoice i WHERE i.appointment_id = a.appointment_id)
          OR (SELECT count(*) FROM invoice i WHERE i.appointment_id = a.appointment_id AND i.status <> 'Void') > 1)
    `);
    assert.deepEqual(rows, [], "a checked out visit with no invoice or more than one open one");
    const notCompleted = await app.db.query(`SELECT 1 FROM invoice i JOIN appointment a ON a.appointment_id = i.appointment_id WHERE a.status IN ('Scheduled', 'Cancelled', 'No Show')`);
    assert.equal(notCompleted.rowCount, 0, "an invoice for a visit that wasn't completed");

    assert.deepEqual((await admin.get("/api/admin/payment-types")).body, [
      { paymentTypeId: cashId, name: "Cash" },
      { paymentTypeId: cardId, name: "Credit Card" },
      { paymentTypeId: insuranceTypeId, name: "Insurance" },
    ]);
    const history = (await admin.get(`/api/admin/payments?patientId=${ids.patient}`)).body;
    assert.ok(history.length > 0, "no payment history");
    assert.deepEqual(Object.keys(history[0]), ["paymentId", "invoiceId", "paymentDate", "amountPaid", "paymentTypeId", "paymentType", "status", "handledBy"]);
  });
});

describe("billing permissions", () => {
  test("only admins can read billing, record admin payments, decide refunds and void invoices", async () => {
    const invoiceId = await invoiceFor("10.00");
    const paid = await pay(invoiceId, "4.00");
    const paymentId = paid.body.paymentId as number;
    await desk.patch(`/api/receptionist/payments/${paymentId}/request-refund`, { reason: "Charged twice" });
    const before = await counts();
    const reads = [
      "/api/admin/invoices",
      `/api/admin/invoices/${invoiceId}`,
      `/api/admin/invoices/${invoiceId}/history`,
      "/api/admin/payments",
      "/api/admin/payment-types",
      "/api/admin/refund-requests",
    ];
    for (const [name, client, status] of others) {
      for (const path of reads) assert.equal((await client.get(path)).status, status, `${name} GET ${path}`);
      assert.equal((await client.post(`/api/admin/invoices/${invoiceId}/payments`, { paymentTypeId: cashId, amount: "1" })).status, status, `${name} payment`);
      assert.equal((await client.patch(`/api/admin/payments/${paymentId}/approve-refund`, {})).status, status, `${name} approve`);
      assert.equal((await client.patch(`/api/admin/payments/${paymentId}/deny-refund`, {})).status, status, `${name} deny`);
      assert.equal((await client.patch(`/api/admin/invoices/${invoiceId}/void`, { reason: "Mistake" })).status, status, `${name} void`);
    }
    assert.deepEqual(await counts(), before);
    assert.equal(await paymentStatus(paymentId), "Requested");
  });

  test("the front desk bills only visits at its own office", async () => {
    const invoiceId = await invoiceFor("80.00");
    const before = await counts();
    // Rita works at Westside and the visit was at Main Street
    assert.equal((await rita.get("/api/receptionist/invoices")).body.some((i: { invoiceId: number }) => i.invoiceId === invoiceId), false);
    assert.equal((await rita.get(`/api/receptionist/invoices/${invoiceId}`)).status, 404);
    assert.equal((await rita.post(`/api/receptionist/invoices/${invoiceId}/payments`, { paymentTypeId: cashId, amount: "10" })).status, 404);
    assert.deepEqual(await counts(), before);

    const listed = (await desk.get("/api/receptionist/invoices?status=unpaid")).body.find((i: { invoiceId: number }) => i.invoiceId === invoiceId);
    assert.deepEqual([listed?.amount, listed?.balance, listed?.officeName], ["80.00", "80.00", "Main Street Clinic"]);
    assert.deepEqual((await desk.get("/api/receptionist/payment-types")).body, (await admin.get("/api/admin/payment-types")).body);
    const paid = await desk.post(`/api/receptionist/invoices/${invoiceId}/payments`, { paymentTypeId: cashId, amount: "30.00" });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    assert.deepEqual([paid.body.invoice.balance, paid.body.invoice.payments[0].handledBy], ["50.00", "Rhea Tester"]);
    assert.equal((await desk.get(`/api/receptionist/invoices/${invoiceId}`)).body.balance, "50.00");
  });

  test("the front desk needs card details for a card and verified insurance for insurance", async () => {
    const patientId = await addPatient(app.db, "Una", "Unverified");
    await app.db.query(`INSERT INTO insurance (patient_id, provider, policy_number) VALUES ($1, 'Aetna', 'AE-UNA')`, [patientId]);
    const invoiceId = await invoiceFor("60.00", patientId);
    const paying = (body: object) => desk.post(`/api/receptionist/invoices/${invoiceId}/payments`, { amount: "20.00", ...body });

    const insured = await paying({ paymentTypeId: insuranceTypeId });
    assert.deepEqual([insured.status, insured.body.error], [409, "The patient's insurance has to be verified before it can be billed"]);
    assert.equal((await paying({ paymentTypeId: cardId })).status, 400);
    assert.equal((await paying({ paymentTypeId: cardId, card: { ...card, cardNumber: "4111" } })).status, 400);
    assert.equal((await paying({ paymentTypeId: cardId, card: { ...card, expiry: "01/20" } })).status, 400);
    assert.deepEqual(await invoiceRow(invoiceId), { status: "Pending", paid: "0" });
    assert.equal((await paying({ paymentTypeId: cardId, card })).status, 201);
    assert.deepEqual(await invoiceRow(invoiceId), { status: "Pending", paid: "20.00" });
  });

  test("the removed billing routes stay gone, and only receptionists use the front desk ones", async () => {
    const invoiceId = await invoiceFor("10.00");
    for (const [method, path] of [
      ["GET", "/api/admin/billable-appointments"],
      ["POST", "/api/admin/invoices"],
      ["GET", "/api/receptionist/billable-appointments"],
      ["POST", "/api/receptionist/invoices"],
      ["PATCH", "/api/receptionist/invoices/1/overdue"],
    ]) {
      const client = path.startsWith("/api/admin") ? admin : desk;
      const res = method === "GET" ? await client.get(path) : method === "POST" ? await client.post(path, {}) : await client.patch(path, {});
      assert.equal(res.status, 404, `${method} ${path}`);
    }

    const before = await counts();
    for (const [name, client, status] of [["visitor", app.client(), 401], ["patient", pat, 403], ["admin", admin, 403], ...others.slice(3)] as [string, TestClient, number][]) {
      for (const path of ["/api/receptionist/invoices", `/api/receptionist/invoices/${invoiceId}`, "/api/receptionist/payment-types"]) {
        assert.equal((await client.get(path)).status, status, `${name} GET ${path}`);
      }
      assert.equal((await client.post(`/api/receptionist/invoices/${invoiceId}/payments`, { paymentTypeId: cashId, amount: "1" })).status, status, `${name} payment`);
    }
    assert.deepEqual(await counts(), before);
  });
});

describe("one open invoice per appointment", () => {
  const secondInvoice = (invoiceId: number) =>
    asEmployee(app.db, ids.admin, (client) =>
      client.query(
        `INSERT INTO invoice (patient_id, appointment_id, amount) SELECT patient_id, appointment_id, amount FROM invoice WHERE invoice_id = $1 RETURNING invoice_id`,
        [invoiceId]
      )
    );

  test("the database itself refuses a second open invoice for an appointment", async () => {
    const invoiceId = await invoiceFor("15.00");
    await assert.rejects(secondInvoice(invoiceId), (err: { code?: string; constraint?: string }) => err.code === "23505" && err.constraint === "invoice_one_per_appointment");
    // migration 011 swapped the unique constraint from migration 009 for this partial index
    assert.equal((await app.db.query(`SELECT 1 FROM pg_constraint WHERE conname = 'invoice_appointment_id_key'`)).rowCount, 0);
    const index = await app.db.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'invoice_one_per_appointment'`);
    assert.match(index.rows[0].indexdef, /UNIQUE INDEX .* \(appointment_id\) WHERE \(\(status\)::text <> 'Void'::text\)/);
  });

  test("a void invoice frees the visit for a new one, and that one is the only open one", async () => {
    const invoiceId = await invoiceFor("12.00");
    assert.equal((await admin.patch(`/api/admin/invoices/${invoiceId}/void`, { reason: "Billed the wrong fee" })).status, 200);
    const replacement = await secondInvoice(invoiceId);
    assert.equal(replacement.rowCount, 1);
    await assert.rejects(secondInvoice(invoiceId), (err: { code?: string }) => err.code === "23505");
    const { rows } = await app.db.query(
      `SELECT status FROM invoice WHERE appointment_id = (SELECT appointment_id FROM invoice WHERE invoice_id = $1) ORDER BY invoice_id`,
      [invoiceId]
    );
    assert.deepEqual(rows.map((r) => r.status), ["Void", "Pending"]);
  });
});

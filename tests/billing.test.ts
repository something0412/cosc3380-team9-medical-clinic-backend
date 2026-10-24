import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import {
  TEST_CLOCK_OPTION,
  addAppointment,
  addEmployee,
  addLogin,
  addPatient,
  addSlots,
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
  "issueDate", "amount", "paid", "balance", "status", "payments",
];

let app: Awaited<ReturnType<typeof startTestApp>>;
let today: string;
let slot: number;
let admin: TestClient, pat: TestClient;
let others: [string, TestClient, number][];
let oliveId: number, cashId: number, cardId: number, retiredTypeId: number;
let daysBack = 0;

const statuses = (responses: TestResponse[]) => responses.map((r) => r.status).sort();
const createInvoice = (body: object) => admin.post("/api/admin/invoices", body);
const pay = (invoiceId: number | string, amount: unknown, paymentTypeId: number = cashId) =>
  admin.post(`/api/admin/invoices/${invoiceId}/payments`, { paymentTypeId, amount });

// a visit on its own past day, so visits never overlap
async function visit(status = "Completed", patientId: number = ids.patient) {
  daysBack += 1;
  return addAppointment(app.db, { patientId, doctorId: ids.doctor, officeId: ids.mainOffice, date: dayFrom(today, -daysBack), timeSlotId: slot, status });
}

async function invoiceFor(amount: string, patientId: number = ids.patient) {
  const res = await createInvoice({ appointmentId: await visit("Completed", patientId), amount });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.invoiceId as number;
}

// for historical states the API wouldn't create, like a Paid invoice that wasn't fully paid
async function oldInvoice(amount: string, status: string, payments: string[], patientId: number = ids.patient) {
  const appointmentId = await visit("Completed", patientId);
  const { rows } = await app.db.query(
    `INSERT INTO invoice (patient_id, appointment_id, amount, issue_date, status) VALUES ($1, $2, $3, $4, $5) RETURNING invoice_id`,
    [patientId, appointmentId, amount, dayFrom(today, -60), status]
  );
  for (const paid of payments) {
    await app.db.query(`INSERT INTO payment (invoice_id, payment_type_id, amount_paid, payment_date) VALUES ($1, $2, $3, $4)`, [
      rows[0].invoice_id,
      cashId,
      paid,
      dayFrom(today, -50),
    ]);
  }
  return rows[0].invoice_id as number;
}

async function counts() {
  const { rows } = await app.db.query(`SELECT (SELECT count(*) FROM invoice)::int AS invoices, (SELECT count(*) FROM payment)::int AS payments`);
  return rows[0] as { invoices: number; payments: number };
}

async function invoiceRow(invoiceId: number) {
  const { rows } = await app.db.query(
    `SELECT status, (SELECT COALESCE(sum(amount_paid), 0)::text FROM payment WHERE invoice_id = $1) AS paid FROM invoice WHERE invoice_id = $1`,
    [invoiceId]
  );
  return rows[0] as { status: string; paid: string };
}

// holds a change open in its own transaction while a request waits on it
async function whileHeld(changes: [string, unknown[]][], send: () => Promise<TestResponse>) {
  const held = await app.db.connect();
  try {
    await held.query("BEGIN");
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

  const types = await app.db.query(`INSERT INTO payment_type (name) VALUES ('Cash'), ('Card') RETURNING payment_type_id`);
  [cashId, cardId] = types.rows.map((r) => r.payment_type_id);
  retiredTypeId = (await app.db.query(`INSERT INTO payment_type (name, is_active) VALUES ('Old Check', false) RETURNING payment_type_id`)).rows[0]
    .payment_type_id;

  await addLogin(app.db, ids.receptionist);
  const labType = await app.db.query(`INSERT INTO employee_types (type_name) VALUES ('Lab Technician') RETURNING employee_type_id AS id`);
  const labId = await addEmployee(app.db, "Lee", labType.rows[0].id, ids.mainOffice);

  admin = await app.loginStaff(ids.admin);
  pat = await app.loginPatient(ids.patient, "pat@test.org");
  others = [
    ["visitor", app.client(), 401],
    ["patient", pat, 403],
    ["receptionist", await app.loginStaff(ids.receptionist), 403],
    ["nurse", await app.loginStaff(ids.nurse), 403],
    ["doctor", await app.loginStaff(ids.doctor), 403],
    ["lab", await app.loginStaff(labId), 403],
  ];
});

after(async () => {
  await unfreezeClock(app.db);
  await app.close();
});

describe("creating invoices", () => {
  test("an admin bills a completed visit, and the patient comes from the appointment", async () => {
    const appointmentId = await visit("Completed", oliveId);
    const res = await createInvoice({ appointmentId, amount: "125.50", patientId: ids.patient });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body), INVOICE_KEYS);
    assert.deepEqual(
      [res.body.patientId, res.body.appointmentId, res.body.amount, res.body.paid, res.body.balance, res.body.status, res.body.issueDate, res.body.payments],
      [oliveId, appointmentId, "125.50", "0.00", "125.50", "Pending", today, []]
    );
    const stored = await app.db.query(`SELECT patient_id, to_char(issue_date, 'YYYY-MM-DD') AS issued FROM invoice WHERE invoice_id = $1`, [res.body.invoiceId]);
    assert.deepEqual(stored.rows[0], { patient_id: oliveId, issued: today });
  });

  test("only completed visits can be billed, and only once", async () => {
    for (const status of ["Scheduled", "Cancelled", "No Show"]) {
      const res = await createInvoice({ appointmentId: await visit(status), amount: "50.00" });
      assert.deepEqual([res.status, res.body.error], [409, `Only completed appointments can be billed. This one is ${status}.`]);
    }
    const appointmentId = await visit();
    assert.equal((await createInvoice({ appointmentId, amount: "80" })).status, 201);
    assert.deepEqual((await createInvoice({ appointmentId, amount: "80" })).body, { error: "This appointment already has an invoice" });
    assert.equal((await createInvoice({ appointmentId: 999999, amount: "80" })).status, 404);
    assert.equal((await createInvoice({ appointmentId: "abc", amount: "80" })).status, 400);
  });

  test("amounts have to be positive dollars and cents", async () => {
    const appointmentId = await visit();
    const before = await counts();
    for (const amount of [0, "0.00", -5, "12.345", "abc", 1e21, "", null, "1,000"]) {
      assert.equal((await createInvoice({ appointmentId, amount })).status, 400, String(amount));
    }
    assert.deepEqual(await counts(), before);
    assert.equal((await createInvoice({ appointmentId, amount: 19.99 })).body.amount, "19.99");
  });

  test("two admins billing the same visit at once make one invoice", async () => {
    const appointmentId = await visit();
    assert.deepEqual(statuses(await Promise.all([createInvoice({ appointmentId, amount: "60" }), createInvoice({ appointmentId, amount: "70" })])), [201, 409]);
    const { rows } = await app.db.query(`SELECT count(*)::int AS n FROM invoice WHERE appointment_id = $1`, [appointmentId]);
    assert.equal(rows[0].n, 1);
  });

  test("without the unique constraint, the appointment lock alone stops a second invoice", async () => {
    await app.db.query(`ALTER TABLE invoice DROP CONSTRAINT invoice_appointment_id_key`);
    try {
      const appointmentId = await visit();
      const res = await whileHeld(
        [
          [`SELECT 1 FROM appointment WHERE appointment_id = $1 FOR NO KEY UPDATE`, [appointmentId]],
          [`INSERT INTO invoice (patient_id, appointment_id, amount, status) VALUES ($1, $2, 40, 'Pending')`, [ids.patient, appointmentId]],
        ],
        () => createInvoice({ appointmentId, amount: "45" })
      );
      assert.deepEqual([res.status, res.body.error], [409, "This appointment already has an invoice"]);
      const { rows } = await app.db.query(`SELECT count(*)::int AS n FROM invoice WHERE appointment_id = $1`, [appointmentId]);
      assert.equal(rows[0].n, 1);
    } finally {
      await app.db.query(`ALTER TABLE invoice ADD CONSTRAINT invoice_appointment_id_key UNIQUE (appointment_id)`);
    }
  });

  test("an invoice that can't be saved leaves nothing behind", async () => {
    const appointmentId = await visit();
    const before = await counts();
    const restore = await failWrites(app.db, "invoice", "INSERT");
    try {
      assert.equal((await createInvoice({ appointmentId, amount: "30" })).status, 400);
    } finally {
      await restore();
    }
    assert.deepEqual(await counts(), before);
    assert.equal((await createInvoice({ appointmentId, amount: "30" })).status, 201);
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
    assert.deepEqual(last.body.invoice.payments.map((p: { paymentType: string }) => p.paymentType), ["Card", "Cash"]);
    assert.deepEqual((await pay(invoiceId, "1.00")).body, { error: "This invoice is already paid" });
  });

  test("a payment can't be more than what's left", async () => {
    const invoiceId = await invoiceFor("50.00");
    await pay(invoiceId, "20.00");
    const res = await pay(invoiceId, "30.01");
    assert.deepEqual([res.status, res.body.error], [409, "Only $30.00 is left on this invoice"]);
    assert.deepEqual(await invoiceRow(invoiceId), { status: "Pending", paid: "20.00" });
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

    const unpaid = (await admin.get(`/api/admin/invoices?patientId=${patientId}&status=unpaid`)).body.map((i: { invoiceId: number }) => i.invoiceId);
    assert.deepEqual(unpaid.sort(), [cases.unpaid, cases.overdue, cases.stalePaid].sort());
  });

  test("the patient, the front desk and the Admin all see the same amount owed", async () => {
    const owedByAdmin = (await admin.get(`/api/admin/invoices?patientId=${ids.patient}`)).body.reduce(
      (cents: number, i: { balance: string }) => cents + Math.round(Number(i.balance) * 100),
      0
    );
    const expected = (owedByAdmin / 100).toFixed(2);

    const billing = await pat.get(`/api/patient/${ids.patient}/billing`);
    assert.equal(billing.body.outstandingBalance, expected);
    assert.equal((await pat.get(`/api/patient/${ids.patient}/dashboard`)).body.outstandingBalance, expected);
    assert.equal((await others[2][1].get(`/api/receptionist/patients/${ids.patient}`)).body.balance, expected);

    const allOwed = await app.db.query(`SELECT COALESCE(sum(GREATEST(i.amount - COALESCE((SELECT sum(amount_paid) FROM payment p WHERE p.invoice_id = i.invoice_id), 0), 0)), 0)::float AS owed FROM invoice i`);
    assert.equal((await admin.get("/api/admin/dashboard")).body.pending, allOwed.rows[0].owed);
    const analytics = (await admin.get("/api/admin/analytics/billing")).body;
    assert.equal(analytics.outstanding, allOwed.rows[0].owed);
    assert.ok(analytics.unpaidInvoices.every((i: { balance: number }) => i.balance > 0), "unpaid report has a settled invoice");
  });

  test("the patient view keeps its fields, adds the balances, and shows only their own invoices", async () => {
    const res = await pat.get(`/api/patient/${ids.patient}/billing`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ["invoices", "payments", "outstandingBalance"]);
    assert.deepEqual(Object.keys(res.body.invoices[0]), ["invoiceId", "issueDate", "amount", "status", "paid", "balance"]);
    assert.deepEqual(Object.keys(res.body.payments[0]), ["paymentId", "invoiceId", "paymentDate", "amountPaid", "paymentType"]);
    assert.match(res.body.invoices[0].issueDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(res.body.payments[0].paymentDate, /^\d{4}-\d{2}-\d{2}$/);

    const mine = await app.db.query(`SELECT invoice_id FROM invoice WHERE patient_id = $1 ORDER BY invoice_id`, [ids.patient]);
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
    assert.equal((await admin.get("/api/admin/invoices?status=Late")).status, 400);
    assert.equal((await admin.get("/api/admin/invoices/999999")).status, 404);
  });

  test("billable visits, payment types and payment history", async () => {
    const waiting = await visit();
    const billable = (await admin.get("/api/admin/billable-appointments")).body.map((a: { appointmentId: number }) => a.appointmentId);
    assert.ok(billable.includes(waiting), "unbilled visit missing");
    const billed = await app.db.query(`SELECT appointment_id FROM invoice`);
    assert.ok(billed.rows.every((r) => !billable.includes(r.appointment_id)), "billed visit listed as billable");
    const scheduled = await visit("Scheduled");
    assert.equal((await admin.get("/api/admin/billable-appointments")).body.some((a: { appointmentId: number }) => a.appointmentId === scheduled), false);

    assert.deepEqual((await admin.get("/api/admin/payment-types")).body, [
      { paymentTypeId: cardId, name: "Card" },
      { paymentTypeId: cashId, name: "Cash" },
    ]);
    const history = (await admin.get(`/api/admin/payments?patientId=${ids.patient}`)).body;
    assert.ok(history.length > 0, "no payment history");
    assert.deepEqual(Object.keys(history[0]), ["paymentId", "invoiceId", "paymentDate", "amountPaid", "paymentTypeId", "paymentType"]);
  });
});

describe("billing permissions", () => {
  test("only admins can read or change billing", async () => {
    const invoiceId = await invoiceFor("10.00");
    const appointmentId = await visit();
    const before = await counts();
    const reads = ["/api/admin/invoices", `/api/admin/invoices/${invoiceId}`, "/api/admin/payments", "/api/admin/payment-types", "/api/admin/billable-appointments"];
    for (const [name, client, status] of others) {
      for (const path of reads) assert.equal((await client.get(path)).status, status, `${name} GET ${path}`);
      assert.equal((await client.post("/api/admin/invoices", { appointmentId, amount: "10" })).status, status, `${name} invoice`);
      assert.equal((await client.post(`/api/admin/invoices/${invoiceId}/payments`, { paymentTypeId: cashId, amount: "10" })).status, status, `${name} payment`);
    }
    assert.deepEqual(await counts(), before);
  });

  test("the old front desk billing routes are gone", async () => {
    const receptionist = others[2][1];
    for (const [method, path] of [
      ["GET", "/api/receptionist/invoices"],
      ["GET", "/api/receptionist/billable-appointments"],
      ["GET", "/api/receptionist/payment-types"],
      ["POST", "/api/receptionist/invoices"],
      ["POST", "/api/receptionist/invoices/1/payments"],
      ["PATCH", "/api/receptionist/invoices/1/overdue"],
    ]) {
      const res = method === "GET" ? await receptionist.get(path) : method === "POST" ? await receptionist.post(path, {}) : await receptionist.patch(path, {});
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });
});

describe("one invoice per appointment migration", () => {
  test("the database itself refuses a second invoice for an appointment", async () => {
    const invoiceId = await invoiceFor("15.00");
    const { rows } = await app.db.query(`SELECT patient_id, appointment_id FROM invoice WHERE invoice_id = $1`, [invoiceId]);
    await assert.rejects(
      app.db.query(`INSERT INTO invoice (patient_id, appointment_id, amount) VALUES ($1, $2, 15)`, [rows[0].patient_id, rows[0].appointment_id]),
      (err: { code?: string }) => err.code === "23505"
    );
  });

  test("the migration stops without changes when duplicates already exist, and runs once they're gone", async () => {
    const migration = await readFile(new URL("../database/migrations/009_one_invoice_per_appointment.sql", import.meta.url), "utf8");
    const client = await app.db.connect();
    try {
      await client.query(`ALTER TABLE invoice DROP CONSTRAINT invoice_appointment_id_key`);
      const invoiceId = await invoiceFor("12.00");
      const duplicate = await client.query(
        `INSERT INTO invoice (patient_id, appointment_id, amount) SELECT patient_id, appointment_id, amount FROM invoice WHERE invoice_id = $1 RETURNING invoice_id`,
        [invoiceId]
      );
      await assert.rejects(client.query(migration), /more than one invoice/);
      await client.query("ROLLBACK");
      const kept = await client.query(`SELECT count(*)::int AS n FROM invoice WHERE invoice_id = ANY($1)`, [[invoiceId, duplicate.rows[0].invoice_id]]);
      assert.equal(kept.rows[0].n, 2);

      await client.query(`DELETE FROM invoice WHERE invoice_id = $1`, [duplicate.rows[0].invoice_id]);
      await client.query(migration);
      const constraint = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = 'invoice_appointment_id_key'`);
      assert.equal(constraint.rowCount, 1);
    } finally {
      await client.query(`ALTER TABLE invoice ADD CONSTRAINT invoice_appointment_id_key UNIQUE (appointment_id)`).catch(() => undefined);
      client.release();
    }
  });
});

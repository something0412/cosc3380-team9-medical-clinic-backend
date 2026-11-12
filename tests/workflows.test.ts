import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { TEST_CLOCK_OPTION, addDoctor, addEmployee, addLogin, dayFrom, freezeClockAtNoon, unfreezeClock } from "./helpers/appointmentData.js";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient, TestResponse } from "./helpers/testApp.js";
import { TEST_PASSWORD, ids, resetDatabase } from "./helpers/testDb.js";

// one story across the whole clinic, so each step checks what the other roles see of the same records

let app: Awaited<ReturnType<typeof startTestApp>>;
let today: string;
let nextWeek: string;
let weekday: string;
let admin: TestClient, rita: TestClient, nina: TestClient, gina: TestClient, carl: TestClient, uma: TestClient, lee: TestClient;
let ginaId: number, carlId: number, umaId: number, cashTypeId: number;
const slot: Record<string, number> = {};
let willa: TestClient;
let willaId: number;
const visit: Record<string, number> = {};

async function ok(res: Promise<TestResponse>, status = 200) {
  const result = await res;
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
}

const find = <T extends Record<string, unknown>>(rows: T[], key: string, value: unknown) => rows.find((r) => r[key] === value);

before(async () => {
  await resetDatabase();
  // at noon in Chicago it's already the next day in Kiritimati, so a date taken from the database would be a day off
  process.env.DATABASE_URL += `?options=${encodeURIComponent(`-c TimeZone=Pacific/Kiritimati ${TEST_CLOCK_OPTION}`)}`;
  app = await startTestApp();
  today = await freezeClockAtNoon(app.db);
  nextWeek = dayFrom(today, 7);
  weekday = (await app.db.query(`SELECT to_char($1::date, 'FMDay') AS d`, [today])).rows[0].d;
  admin = await app.loginStaff(ids.admin);

  // the schedule is built through the Admin pages, the same way the clinic would set it up
  const shift = await ok(admin.post("/api/admin/shift-types", { name: "Afternoon", startTime: "13:00", endTime: "17:00" }), 201);
  // the shift settings page also sends an empty name with each slot
  slot.one = (await ok(admin.post(`/api/admin/shift-types/${shift.shiftTypeId}/time-slots`, { name: "", startTime: "13:00", endTime: "13:30" }), 201)).timeSlotId;
  slot.two = (await ok(admin.post(`/api/admin/shift-types/${shift.shiftTypeId}/time-slots`, { name: "", startTime: "14:00", endTime: "14:30" }), 201)).timeSlotId;

  ginaId = await addDoctor(app.db, "Gina", ids.westsideOffice);
  carlId = await addDoctor(app.db, "Carl", ids.westsideOffice);
  umaId = await addDoctor(app.db, "Uma", ids.westsideOffice);
  await app.db.query(`INSERT INTO doctor_specialty (doctor_id, specialty_id, is_primary) VALUES ($1, $3, false), ($2, $3, false)`, [carlId, umaId, ids.cardiology]);
  await ok(admin.post("/api/admin/schedules", { doctorId: ginaId, dayOfWeek: weekday, officeId: ids.westsideOffice, specialtyId: ids.familyMedicine, shiftTypeId: shift.shiftTypeId }), 201);
  await ok(admin.post("/api/admin/schedules", { doctorId: carlId, dayOfWeek: weekday, officeId: ids.westsideOffice, specialtyId: ids.cardiology, shiftTypeId: shift.shiftTypeId }), 201);

  await addLogin(app.db, ids.receptionist);
  const labType = (await app.db.query(`INSERT INTO employee_types (type_name) VALUES ('Lab Technician') RETURNING employee_type_id AS id`)).rows[0].id;
  const leeId = await addEmployee(app.db, "Lee", labType, ids.mainOffice);
  // patients pay online by credit card, the front desk takes cash
  await app.db.query(`INSERT INTO payment_type (name) VALUES ('Credit Card')`);
  cashTypeId = (await app.db.query(`INSERT INTO payment_type (name) VALUES ('Cash') RETURNING payment_type_id AS id`)).rows[0].id;

  rita = await app.loginStaff(ids.receptionist);
  nina = await app.loginStaff(ids.nurse);
  gina = await app.loginStaff(ginaId);
  carl = await app.loginStaff(carlId);
  uma = await app.loginStaff(umaId);
  lee = await app.loginStaff(leeId);
});

after(async () => {
  await unfreezeClock(app.db);
  await app.close();
});

describe("a patient's visit from sign up to the bill", () => {
  test("a new patient signs up, finds a time and books it, and every role sees the same appointment", async () => {
    const signup = await app.client().post("/api/auth/patient/signup", {
      firstName: "Willa",
      lastName: "Workflow",
      dob: "1988-04-04",
      phone: "7135554400",
      email: "willa@clinic.test",
      password: TEST_PASSWORD,
    });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    willaId = signup.body.patientId;
    willa = await app.loginPatient(willaId, "willa@clinic.test");
    assert.equal((await ok(willa.get(`/api/patient/${willaId}/profile`))).email, "willa@clinic.test");
    assert.ok((await ok(rita.get("/api/patients"))).some((p: { patientId: number }) => p.patientId === willaId), "front desk directory");

    const open = await ok(willa.get(`/api/availability?date=${today}&specialtyId=${ids.familyMedicine}`));
    const choice = find(open, "timeSlotId", slot.one);
    assert.deepEqual([choice?.doctorId, choice?.officeId, choice?.date], [ginaId, ids.westsideOffice, today]);

    const booked = await ok(willa.post("/api/appointments", { doctorId: ginaId, specialtyId: ids.familyMedicine, date: today, timeSlotId: slot.one }), 201);
    visit.today = booked.appointmentId;
    assert.equal((await ok(willa.get(`/api/availability?date=${today}&specialtyId=${ids.familyMedicine}`))).some((s: { timeSlotId: number }) => s.timeSlotId === slot.one), false);

    const mine = find(await ok(willa.get(`/api/patient/${willaId}/appointments`)), "appointmentId", visit.today);
    assert.deepEqual([mine?.appointmentDate, mine?.appointmentTime, mine?.status, mine?.doctorName], [today, "13:00", "Scheduled", "Gina Tester"]);
    const lists = {
      receptionist: (await ok(rita.get(`/api/receptionist/appointments?date=${today}`))).appointments,
      receptionistDashboard: (await ok(rita.get("/api/receptionist/dashboard"))).todayList,
      nurse: await ok(nina.get(`/api/nurse/appointments?date=${today}`)),
      doctor: await ok(gina.get("/api/doctor/appointments")),
    };
    for (const [who, list] of Object.entries(lists)) {
      const seen = find(list, "appointmentId", visit.today);
      assert.deepEqual([seen?.date, seen?.startTime, seen?.status, seen?.checkedIn, seen?.patientId], [today, "13:00", "Scheduled", false, willaId], who);
    }
    assert.equal((await ok(willa.get(`/api/patient/${willaId}/dashboard`))).upcomingAppointments, 1);

    const week = await ok(gina.get("/api/doctor/schedule"));
    assert.deepEqual(week.schedule, [{ dayOfWeek: weekday, officeName: "Westside Clinic", specialty: "Family Medicine", shift: "Afternoon", startTime: "13:00", endTime: "17:00" }]);
    assert.deepEqual(week.upcomingDays, [{ date: today, appointments: 1 }]);
  });

  test("check in, nursing intake and the doctor's notes all land on the one visit, and check out completes it", async () => {
    assert.equal((await ok(rita.patch(`/api/receptionist/appointments/${visit.today}/check-in`))).checkedIn, true);
    const intake = await ok(nina.get(`/api/nurse/appointments/${visit.today}`));
    assert.deepEqual([intake.patientId, intake.checkedIn, intake.vitals.length, intake.editBlockedReason], [willaId, true, 0, null]);
    assert.ok((await ok(nina.get("/api/nurse/dashboard"))).waitingList.some((a: { appointmentId: number }) => a.appointmentId === visit.today), "waiting for vitals");

    const vitals = await ok(nina.post(`/api/nurse/appointments/${visit.today}/vitals`, { temperature: 99.1, heartRate: 80, systolic: 122, diastolic: 78 }), 201);
    await ok(nina.post(`/api/nurse/appointments/${visit.today}/nursing-notes`, { note: "Reports a cough for three days" }), 201);
    await ok(gina.put(`/api/doctor/appointments/${visit.today}/summary`, { visitReason: "Cough", notes: "Likely viral" }));
    await ok(gina.post(`/api/doctor/appointments/${visit.today}/diagnoses`, { diagnoses: [{ name: "Acute bronchitis" }] }), 201);

    const doctorView = await ok(gina.get(`/api/doctor/appointments/${visit.today}`));
    assert.deepEqual(
      [doctorView.vitals[0].vitalsId, doctorView.vitals[0].recordedBy, doctorView.nursingNotes[0].note, doctorView.summary.visitReason, doctorView.diagnoses[0].name],
      [vitals.vitalsId, "Nina Nurse", "Reports a cough for three days", "Cough", "Acute bronchitis"]
    );

    const out = await ok(rita.patch(`/api/receptionist/appointments/${visit.today}/check-out`));
    assert.equal(out.status, "Completed");
    // checking out bills the visit fee, and the first primary care visit makes Gina the primary doctor
    const billed = await ok(admin.get(`/api/admin/invoices?patientId=${willaId}`));
    assert.deepEqual(billed.map((i: { appointmentId: number; amount: string; status: string }) => [i.appointmentId, i.amount, i.status]), [[visit.today, "150.00", "Pending"]]);
    const primary = await app.db.query(`SELECT doctor_id FROM patient_doctor WHERE patient_id = $1 AND is_primary AND is_active`, [willaId]);
    assert.deepEqual(primary.rows, [{ doctor_id: ginaId }]);
    assert.equal(find(await ok(willa.get(`/api/patient/${willaId}/appointments`)), "appointmentId", visit.today)?.status, "Completed");
    assert.equal(find(await ok(gina.get("/api/doctor/appointments?view=all")), "appointmentId", visit.today)?.status, "Completed");
    const records = await ok(willa.get(`/api/patient/${willaId}/records`));
    assert.deepEqual([records.visits[0].appointmentId, records.visits[0].visitDate], [visit.today, today]);
    const visitDetails = await ok(willa.get(`/api/patient/${willaId}/visits/${visit.today}`));
    assert.deepEqual([visitDetails.summary.visitReason, visitDetails.diagnoses[0].name], ["Cough", "Acute bronchitis"]);
    assert.equal((await ok(willa.get(`/api/patient/${willaId}/dashboard`))).upcomingAppointments, 0);
  });

  test("a lab order moves through the lab, goes on the visit's bill, and the same result shows for the doctor and patient", async () => {
    const order = await ok(gina.post("/api/doctor/lab-orders", { patientId: willaId, labTestTypeId: await labTest("CBC"), appointmentId: visit.today }), 201);
    const queue = await ok(lee.get("/api/lab/orders"));
    assert.equal(find(queue, "labOrderId", order.labOrderId)?.patientName, "Willa Workflow");
    const [invoice] = await ok(admin.get(`/api/admin/invoices?patientId=${willaId}`));
    const lines = (await ok(admin.get(`/api/admin/invoices/${invoice.invoiceId}`))).items;
    assert.deepEqual(lines.map((l: { category: string; description: string; price: string }) => [l.category, l.description, l.price]), [
      ["Visit", "Family Medicine visit", "150.00"],
      ["Lab Test", "CBC", "25.00"],
    ]);
    assert.equal(invoice.amount, "175.00");

    await ok(lee.patch(`/api/lab/orders/${order.labOrderId}/start`));
    const done = await ok(lee.patch(`/api/lab/orders/${order.labOrderId}/result`, { resultNotes: "WBC 11.2, slightly high" }));
    assert.deepEqual([done.status, done.performedBy], ["Completed", "Lee Tester"]);

    // the nurse's visit page has no lab orders, so only the doctor and patient views are checked
    const doctorChart = await ok(gina.get(`/api/doctor/patients/${willaId}`));
    const shown = find(doctorChart.labOrders, "labOrderId", order.labOrderId);
    assert.deepEqual([shown?.status, shown?.resultNotes], ["Completed", "WBC 11.2, slightly high"]);
    const records = await ok(willa.get(`/api/patient/${willaId}/records`));
    const result = find(records.labResults, "labOrderId", order.labOrderId);
    assert.deepEqual([result?.resultNotes, result?.orderDate], ["WBC 11.2, slightly high", today]);
    assert.equal(await count(`SELECT count(*) AS n FROM lab_order WHERE patient_id = $1`, [willaId]), 1);
  });

  test("the completed visit is billed, paid in two parts, and every balance agrees", async () => {
    const [invoice] = await ok(admin.get(`/api/admin/invoices?patientId=${willaId}`));
    assert.deepEqual([invoice.appointmentId, invoice.amount, invoice.status], [visit.today, "175.00", "Pending"]);
    // the visit is already completed, so checking out again can't make a second invoice
    assert.equal((await rita.patch(`/api/receptionist/appointments/${visit.today}/check-out`)).status, 409);
    assert.equal(await count(`SELECT count(*) AS n FROM invoice WHERE appointment_id = $1`, [visit.today]), 1);
    await balancesAre("175.00");

    const card = { cardType: "Credit Card", nameOnCard: "Willa Workflow", cardNumber: "4111 1111 1111 1111", expiry: "12/35", cvv: "123" };
    await ok(willa.post(`/api/patient/${willaId}/invoices/${invoice.invoiceId}/payments`, { ...card, amount: "80.25" }), 201);
    await balancesAre("94.75");
    const owing = await ok(rita.get("/api/receptionist/dashboard"));
    assert.deepEqual([owing.unpaidInvoices, owing.unpaidTotal], [1, "94.75"]);
    assert.equal(find(await ok(rita.get("/api/receptionist/invoices?status=unpaid")), "invoiceId", invoice.invoiceId)?.balance, "94.75");
    const tooMuch = await rita.post(`/api/receptionist/invoices/${invoice.invoiceId}/payments`, { paymentTypeId: cashTypeId, amount: "94.76" });
    assert.deepEqual([tooMuch.status, tooMuch.body.error], [409, "Only $94.75 is left on this invoice"]);
    await balancesAre("94.75");

    await ok(rita.post(`/api/receptionist/invoices/${invoice.invoiceId}/payments`, { paymentTypeId: cashTypeId, amount: "94.75" }), 201);
    await balancesAre("0.00");
    const desk = await ok(rita.get("/api/receptionist/dashboard"));
    assert.deepEqual([desk.officeName, desk.unpaidInvoices, desk.unpaidTotal], ["Westside Clinic", 0, "0.00"]);
    assert.equal((await ok(admin.get(`/api/admin/invoices/${invoice.invoiceId}`))).status, "Paid");
    assert.equal(find((await ok(willa.get(`/api/patient/${willaId}/billing`))).invoices, "invoiceId", invoice.invoiceId)?.status, "Paid");

    // the history says who made each change, oldest last
    const history = await ok(admin.get(`/api/admin/invoices/${invoice.invoiceId}/history`));
    assert.deepEqual(
      history.map((h: { oldStatus: string | null; newStatus: string; changedBy: string; changedByType: string }) => [h.oldStatus, h.newStatus, h.changedBy, h.changedByType]),
      [
        ["Pending", "Paid", "Rita Reception", "Receptionist"],
        [null, "Completed", "Rita Reception", "Receptionist"],
        [null, "Completed", "Willa Workflow", "Patient"],
        [null, "Pending", "Rita Reception", "Receptionist"],
      ]
    );
  });
});

describe("referrals and booking", () => {
  test("an approved referral lets the patient book the specialist, and only the booked specialist opens the chart", async () => {
    const early = await willa.post("/api/appointments", { doctorId: carlId, specialtyId: ids.cardiology, date: nextWeek, timeSlotId: slot.two });
    assert.equal(early.status, 409, "needs an approved referral first");

    // Gina became the primary doctor at check out, so her own referrals are approved as they're sent
    const sent = await ok(gina.post("/api/doctor/referrals", { patientId: willaId, specialistDoctorId: carlId, specialtyId: ids.cardiology, reason: "Chest pain on exertion" }), 201);
    assert.deepEqual([sent.status, sent.primaryDoctorId, sent.requestReason], ["Approved", ginaId, "Chest pain on exertion"]);
    await ok(gina.post("/api/doctor/referrals", { patientId: willaId, specialistDoctorId: umaId, specialtyId: ids.cardiology, reason: "Second opinion" }), 201);
    assert.ok((await ok(carl.get("/api/doctor/referrals"))).received.some((r: { referralId: number }) => r.referralId === sent.referralId), "specialist sees it");
    // only the primary doctor decides a referral, not the specialist
    assert.equal((await carl.patch(`/api/doctor/referrals/${sent.referralId}/status`, { status: "Denied", reason: "Not needed" })).status, 403);
    const approved = (await ok(willa.get(`/api/patient/${willaId}/referrals`))).find((r: { referralId: number }) => r.referralId === sent.referralId);
    assert.equal(approved.status, "Approved");

    const booked = await ok(willa.post("/api/appointments", { doctorId: carlId, specialtyId: ids.cardiology, date: nextWeek, timeSlotId: slot.two }), 201);
    visit.cardiology = booked.appointmentId;
    assert.deepEqual([booked.referralId, booked.date, booked.startTime], [sent.referralId, nextWeek, "14:00"]);
    assert.equal(await count(`SELECT count(*) AS n FROM appointment WHERE patient_id = $1 AND doctor_id = $2`, [willaId, carlId]), 1);

    assert.equal((await carl.get(`/api/doctor/patients/${willaId}`)).status, 200);
    // Uma's approved referral is information about the patient, not a visit
    const umaReferral = (await ok(uma.get("/api/doctor/referrals"))).received[0];
    assert.deepEqual([umaReferral.patientId, umaReferral.status], [willaId, "Approved"]);
    assert.equal((await uma.get(`/api/doctor/patients/${willaId}`)).status, 403);
  });
});

describe("records shared across roles", () => {
  test("an allergy or home medication added by one role is on the other role's chart", async () => {
    // a nurse only sees patients with a visit at their office today, which Willa still has
    const allergyType = (await app.db.query(`INSERT INTO allergy_type (name, category) VALUES ('Latex', 'Environmental') RETURNING allergy_type_id AS id`)).rows[0].id;
    const allergy = await ok(nina.post(`/api/nurse/patients/${willaId}/allergies`, { allergyTypeId: allergyType, severity: "Severe", reaction: "Hives" }), 201);
    const medication = await ok(gina.post(`/api/doctor/patients/${willaId}/home-medications`, { medicationName: "Vitamin D", dosage: "1000 IU" }), 201);

    // nurses read the patient through today's visit page, Willa's only visit with vitals and notes
    const doctorChart = await ok(gina.get(`/api/doctor/patients/${willaId}`));
    const nurseVisit = await ok(nina.get(`/api/nurse/appointments/${visit.today}`));
    for (const chart of [doctorChart, nurseVisit]) {
      assert.deepEqual(chart.allergies.map((a: { allergyId: number }) => a.allergyId), [allergy.allergyId]);
      assert.deepEqual(chart.homeMedications.map((m: { homeMedicationId: number }) => m.homeMedicationId), [medication.homeMedicationId]);
    }
    assert.deepEqual(doctorChart.vitals, nurseVisit.vitals);
    assert.deepEqual(doctorChart.nursingNotes, nurseVisit.nursingNotes);
    assert.deepEqual(find(doctorChart.visits, "appointmentId", visit.today)?.diagnoses, nurseVisit.diagnoses.map((d: { name: string }) => d.name));
  });

  test("a patient registered at the front desk can get a login and use their own portal", async () => {
    const registered = await ok(
      rita.post("/api/patients", { firstName: "Desk", lastName: "Walkin", dob: "1975-09-09", phone: "7135554500", email: "desk.walkin@clinic.test" }),
      201
    );
    await ok(rita.post(`/api/receptionist/patients/${registered.patientId}/login`, { email: "desk.walkin@clinic.test", password: TEST_PASSWORD }), 201);
    const walkIn = await app.loginPatient(registered.patientId, "desk.walkin@clinic.test");
    assert.equal((await ok(walkIn.get(`/api/patient/${registered.patientId}/profile`))).firstName, "Desk");
    assert.deepEqual(await ok(walkIn.get(`/api/patient/${registered.patientId}/appointments`)), []);
    assert.equal((await walkIn.get(`/api/patient/${willaId}/profile`)).status, 403);
  });
});

describe("staff changes across sessions", () => {
  test("an employee made on the Staff page works everywhere, moves offices, and history survives a blocked deactivation", async () => {
    const desk = await ok(
      admin.post("/api/admin/staff", {
        firstName: "Sam",
        lastName: "Frontdesk",
        dob: "1992-03-03",
        phone: "7135554600",
        email: "sam.frontdesk@clinic.test",
        employeeTypeId: 4,
        officeId: ids.westsideOffice,
        password: TEST_PASSWORD,
      }),
      201
    );
    assert.equal((await ok(admin.get(`/api/admin/employees/${desk.employeeId}`))).officeName, "Westside Clinic");
    const sam = await app.loginStaff(desk.employeeId);
    assert.ok((await ok(sam.get(`/api/receptionist/appointments?date=${today}`))).appointments.some((a: { appointmentId: number }) => a.appointmentId === visit.today), "sees Westside");

    await ok(admin.put(`/api/admin/staff/${desk.employeeId}`, { firstName: "Sam", lastName: "Frontdesk", phone: "7135554600", email: "sam.frontdesk@clinic.test", officeId: ids.mainOffice }));
    assert.equal((await ok(sam.get("/api/auth/me"))).officeId, ids.mainOffice);
    assert.equal((await ok(sam.get(`/api/receptionist/appointments?date=${today}`))).appointments.some((a: { appointmentId: number }) => a.appointmentId === visit.today), false);
    assert.equal((await sam.patch(`/api/receptionist/appointments/${visit.cardiology}/check-in`)).status, 403);

    // Carl still has Willa's cardiology visit next week
    const historyBefore = (await app.db.query(`SELECT appointment_id, status FROM appointment WHERE doctor_id = ANY($1::int[]) ORDER BY 1`, [[ginaId, carlId]])).rows;
    const blocked = await admin.patch(`/api/admin/employees/${carlId}/status`, { isActive: false });
    assert.deepEqual([blocked.status, blocked.body.error], [409, "1 upcoming appointment is booked with this doctor. Reschedule or cancel it first."]);
    assert.equal((await carl.get("/api/doctor/dashboard")).status, 200);

    await ok(admin.patch(`/api/admin/staff/${desk.employeeId}/status`, { isActive: false }));
    assert.equal((await sam.get("/api/receptionist/appointments")).status, 401);
    assert.deepEqual((await app.db.query(`SELECT appointment_id, status FROM appointment WHERE doctor_id = ANY($1::int[]) ORDER BY 1`, [[ginaId, carlId]])).rows, historyBefore);
  });
});

// a lab test with a price, so ordering it adds a line to the visit's invoice
async function labTest(name: string) {
  const id = (await app.db.query(`INSERT INTO lab_test_type (name, cost) VALUES ($1, 25) RETURNING lab_test_type_id AS id`, [name])).rows[0].id as number;
  await app.db.query(`INSERT INTO service_fee (category, type, name, price, lab_test_type_id) VALUES ('Lab Test', 'Blood Test', $1, 25.00, $2)`, [name, id]);
  return id;
}

async function count(sql: string, params: unknown[] = []) {
  return Number((await app.db.query(sql, params)).rows[0].n);
}

// the patient portal, the front desk and the Admin all report the same balance
async function balancesAre(expected: string) {
  const billing = await ok(willa.get(`/api/patient/${willaId}/billing`));
  const dashboard = await ok(willa.get(`/api/patient/${willaId}/dashboard`));
  const desk = await ok(rita.get(`/api/receptionist/patients/${willaId}`));
  const invoices = await ok(admin.get(`/api/admin/invoices?patientId=${willaId}`));
  assert.deepEqual(
    [billing.outstandingBalance, dashboard.outstandingBalance, desk.balance, invoices[0].balance],
    [expected, expected, expected, expected],
    "patient, dashboard, front desk and admin balances"
  );
}

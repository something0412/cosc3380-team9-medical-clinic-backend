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
let ginaId: number, carlId: number, umaId: number, cardTypeId: number;
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
  cardTypeId = (await app.db.query(`INSERT INTO payment_type (name) VALUES ('Card') RETURNING payment_type_id AS id`)).rows[0].id;

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
      phone: "713-555-4400",
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
      nurse: await ok(nina.get("/api/nurse/appointments")),
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
    assert.deepEqual([intake.patientId, intake.checkedIn, intake.vitals.length], [willaId, true, 0]);
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
    assert.equal(find(await ok(willa.get(`/api/patient/${willaId}/appointments`)), "appointmentId", visit.today)?.status, "Completed");
    assert.equal(find(await ok(gina.get("/api/doctor/appointments?view=all")), "appointmentId", visit.today)?.status, "Completed");
    const records = await ok(willa.get(`/api/patient/${willaId}/records`));
    assert.deepEqual(
      [records.visits[0].appointmentId, records.visits[0].visitDate, records.visits[0].visitReason, records.visits[0].diagnosis],
      [visit.today, today, "Cough", "Acute bronchitis"]
    );
    assert.equal((await ok(willa.get(`/api/patient/${willaId}/dashboard`))).upcomingAppointments, 0);
  });

  test("a lab order moves through the lab and the same result shows for the doctor, nurse and patient", async () => {
    const order = await ok(gina.post("/api/doctor/lab-orders", { patientId: willaId, labTestTypeId: await labTest("CBC"), appointmentId: visit.today }), 201);
    const queue = await ok(lee.get("/api/lab/orders"));
    assert.equal(find(queue, "labOrderId", order.labOrderId)?.patientName, "Willa Workflow");

    await ok(lee.patch(`/api/lab/orders/${order.labOrderId}/start`));
    const done = await ok(lee.patch(`/api/lab/orders/${order.labOrderId}/result`, { resultNotes: "WBC 11.2, slightly high" }));
    assert.deepEqual([done.status, done.performedBy], ["Completed", "Lee Tester"]);

    const doctorChart = await ok(gina.get(`/api/doctor/patients/${willaId}`));
    const nurseChart = await ok(nina.get(`/api/nurse/patients/${willaId}`));
    for (const [who, chart] of [["doctor", doctorChart], ["nurse", nurseChart]] as const) {
      const shown = find(chart.labOrders, "labOrderId", order.labOrderId);
      assert.deepEqual([shown?.status, shown?.resultNotes], ["Completed", "WBC 11.2, slightly high"], who);
    }
    const records = await ok(willa.get(`/api/patient/${willaId}/records`));
    const result = find(records.labResults, "labOrderId", order.labOrderId);
    assert.deepEqual([result?.resultNotes, result?.orderDate], ["WBC 11.2, slightly high", today]);
    assert.equal(await count(`SELECT count(*) AS n FROM lab_order WHERE patient_id = $1`, [willaId]), 1);
  });

  test("the completed visit is billed, paid in two parts, and every balance agrees", async () => {
    const billable = await ok(admin.get("/api/admin/billable-appointments"));
    assert.ok(find(billable, "appointmentId", visit.today), "completed visit is billable");

    const invoice = await ok(admin.post("/api/admin/invoices", { appointmentId: visit.today, amount: "180.50" }), 201);
    assert.equal((await admin.post("/api/admin/invoices", { appointmentId: visit.today, amount: "10.00" })).status, 409);
    assert.equal((await ok(admin.get("/api/admin/billable-appointments"))).some((a: { appointmentId: number }) => a.appointmentId === visit.today), false);

    await ok(admin.post(`/api/admin/invoices/${invoice.invoiceId}/payments`, { paymentTypeId: cardTypeId, amount: "80.25" }), 201);
    await balancesAre("100.25");
    assert.deepEqual([(await ok(rita.get("/api/receptionist/dashboard"))).unpaidInvoices, (await ok(rita.get("/api/receptionist/dashboard"))).unpaidTotal], [1, "100.25"]);
    assert.equal((await admin.post(`/api/admin/invoices/${invoice.invoiceId}/payments`, { paymentTypeId: cardTypeId, amount: "100.26" })).status, 409);
    await balancesAre("100.25");

    await ok(admin.post(`/api/admin/invoices/${invoice.invoiceId}/payments`, { paymentTypeId: cardTypeId, amount: "100.25" }), 201);
    await balancesAre("0.00");
    const desk = await ok(rita.get("/api/receptionist/dashboard"));
    assert.deepEqual([desk.officeName, desk.unpaidInvoices, desk.unpaidTotal], ["Westside Clinic", 0, "0.00"]);
    assert.equal((await ok(admin.get(`/api/admin/invoices/${invoice.invoiceId}`))).status, "Paid");
    assert.equal(find((await ok(willa.get(`/api/patient/${willaId}/billing`))).invoices, "invoiceId", invoice.invoiceId)?.status, "Paid");
  });
});

describe("referrals and booking", () => {
  test("an approved referral lets the patient book the specialist, and only the booked specialist opens the chart", async () => {
    const sent = await ok(gina.post("/api/doctor/referrals", { patientId: willaId, specialistDoctorId: carlId, specialtyId: ids.cardiology }), 201);
    await ok(gina.post("/api/doctor/referrals", { patientId: willaId, specialistDoctorId: umaId, specialtyId: ids.cardiology }), 201);
    assert.ok((await ok(carl.get("/api/doctor/referrals?view=received"))).received.some((r: { referralId: number }) => r.referralId === sent.referralId), "specialist sees it");

    const early = await willa.post("/api/appointments", { doctorId: carlId, specialtyId: ids.cardiology, date: nextWeek, timeSlotId: slot.two });
    assert.equal(early.status, 409, "needs the approval first");
    await ok(carl.patch(`/api/doctor/referrals/${sent.referralId}/status`, { status: "Approved" }));
    const pending = (await ok(willa.get(`/api/patient/${willaId}/referrals`))).find((r: { referralId: number }) => r.referralId === sent.referralId);
    assert.equal(pending.status, "Approved");

    const booked = await ok(willa.post("/api/appointments", { doctorId: carlId, specialtyId: ids.cardiology, date: nextWeek, timeSlotId: slot.two }), 201);
    visit.cardiology = booked.appointmentId;
    assert.deepEqual([booked.referralId, booked.date, booked.startTime], [sent.referralId, nextWeek, "14:00"]);
    assert.equal(await count(`SELECT count(*) AS n FROM appointment WHERE patient_id = $1 AND doctor_id = $2`, [willaId, carlId]), 1);

    assert.equal((await carl.get(`/api/doctor/patients/${willaId}`)).status, 200);
    // Uma's approved referral is information about the patient, not a visit
    const umaReferral = (await ok(uma.get("/api/doctor/referrals?view=received"))).received[0];
    await ok(uma.patch(`/api/doctor/referrals/${umaReferral.referralId}/status`, { status: "Approved" }));
    assert.equal((await uma.get(`/api/doctor/patients/${willaId}`)).status, 403);
  });
});

describe("records shared across roles", () => {
  test("an allergy or home medication added by one role is on the other role's chart", async () => {
    // a nurse only sees patients with a visit at their office today, which Willa still has
    const allergyType = (await app.db.query(`INSERT INTO allergy_type (name, category) VALUES ('Latex', 'Environmental') RETURNING allergy_type_id AS id`)).rows[0].id;
    const allergy = await ok(nina.post(`/api/nurse/patients/${willaId}/allergies`, { allergyTypeId: allergyType, severity: "Severe", reaction: "Hives" }), 201);
    const medication = await ok(gina.post(`/api/doctor/patients/${willaId}/home-medications`, { medicationName: "Vitamin D", dosage: "1000 IU" }), 201);

    const doctorChart = await ok(gina.get(`/api/doctor/patients/${willaId}`));
    const nurseChart = await ok(nina.get(`/api/nurse/patients/${willaId}`));
    for (const chart of [doctorChart, nurseChart]) {
      assert.deepEqual(chart.allergies.map((a: { allergyId: number }) => a.allergyId), [allergy.allergyId]);
      assert.deepEqual(chart.homeMedications.map((m: { homeMedicationId: number }) => m.homeMedicationId), [medication.homeMedicationId]);
    }
    assert.deepEqual(doctorChart.vitals, nurseChart.vitals);
    assert.deepEqual(doctorChart.nursingNotes, nurseChart.nursingNotes);
    assert.deepEqual(doctorChart.visits, nurseChart.visits);
  });

  test("a patient registered at the front desk can get a login and use their own portal", async () => {
    const registered = await ok(
      rita.post("/api/patients", { firstName: "Desk", lastName: "Walkin", dob: "1975-09-09", phone: "713-555-4500", email: "desk.walkin@clinic.test" }),
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
        phone: "713-555-4600",
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

    await ok(admin.put(`/api/admin/staff/${desk.employeeId}`, { firstName: "Sam", lastName: "Frontdesk", phone: "713-555-4600", email: "sam.frontdesk@clinic.test", officeId: ids.mainOffice }));
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

async function labTest(name: string) {
  return (await app.db.query(`INSERT INTO lab_test_type (name, cost) VALUES ($1, 25) RETURNING lab_test_type_id AS id`, [name])).rows[0].id as number;
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

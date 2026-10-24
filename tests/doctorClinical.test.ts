import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  TEST_CLOCK_OPTION,
  addAppointment,
  addDoctor,
  addEmployee,
  addLogin,
  addPatient,
  addSlots,
  dayFrom,
  freezeClockAtNoon,
  unfreezeClock,
  waitForLockWait,
} from "./helpers/appointmentData.js";
import { failWrites, slowWrites } from "./helpers/dbFaults.js";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient, TestResponse } from "./helpers/testApp.js";
import { ids, resetDatabase } from "./helpers/testDb.js";

const PATIENT_LIST_KEYS = ["patientId", "firstName", "lastName", "dob", "assignedToMe", "lastVisit", "nextVisit"];
const CHART_KEYS = [
  "patientId", "firstName", "lastName", "dob", "gender", "phone", "isActive", "assignedToMe",
  "allergies", "insurance", "missingForms", "homeMedications", "vitals", "nursingNotes", "visits", "labOrders", "prescriptions",
];

let app: Awaited<ReturnType<typeof startTestApp>>;
let today: string;
let slots: Awaited<ReturnType<typeof addSlots>>;
let dan: TestClient, dora: TestClient, ula: TestClient, pat: TestClient, rita: TestClient, lab: TestClient;
let doraId: number, ulaId: number, labTypeId: number;
let others: [string, TestClient, number][];
const people: Record<string, number> = {};
const meds: Record<string, number> = {};
const tests: Record<string, number> = {};
let daysBack = 0;

const statuses = (responses: TestResponse[]) => responses.map((r) => r.status).sort();
const ids_ = (rows: { patientId: number }[]) => rows.map((r) => r.patientId);

// a visit on its own past day, or today in a chosen slot, so visits never overlap
async function visit(patientId: number, doctorId: number, status = "Completed", opts: { date?: string; slot?: number; checkedIn?: boolean } = {}) {
  let date = opts.date;
  if (!date) {
    daysBack += 1;
    date = dayFrom(today, -daysBack);
  }
  const appointmentId = await addAppointment(app.db, { patientId, doctorId, officeId: ids.mainOffice, date, timeSlotId: opts.slot ?? slots.morning, status });
  if (opts.checkedIn) await app.db.query(`UPDATE appointment SET checked_in_at = now() WHERE appointment_id = $1`, [appointmentId]);
  return appointmentId;
}

// a checked in visit happening today, with its own patient so slots never clash
async function checkedInToday(doctorId: number, slot: number) {
  const patientId = await addPatient(app.db, "Today");
  return { patientId, appointmentId: await visit(patientId, doctorId, "Scheduled", { date: today, slot, checkedIn: true }) };
}

async function count(sql: string, params: unknown[] = []) {
  return Number((await app.db.query(sql, params)).rows[0].n);
}

// holds a change open in its own transaction while a request waits on it
async function whileHeld(change: string, rowId: number, send: () => Promise<TestResponse>) {
  const held = await app.db.connect();
  try {
    await held.query("BEGIN");
    await held.query(change, [rowId]);
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

const summary = (client: TestClient, appointmentId: number, body: object) => client.put(`/api/doctor/appointments/${appointmentId}/summary`, body);
const diagnose = (client: TestClient, appointmentId: number, diagnoses: object[]) => client.post(`/api/doctor/appointments/${appointmentId}/diagnoses`, { diagnoses });
const prescribe = (client: TestClient, appointmentId: number, items: object[]) => client.post(`/api/doctor/appointments/${appointmentId}/prescriptions`, { items });
const order = (client: TestClient, body: object) => client.post("/api/doctor/lab-orders", body);

before(async () => {
  await resetDatabase();
  // at noon in Chicago it's already the next day in Kiritimati, so a date taken from the database would be a day off
  process.env.DATABASE_URL += `?options=${encodeURIComponent(`-c TimeZone=Pacific/Kiritimati ${TEST_CLOCK_OPTION}`)}`;
  app = await startTestApp();
  today = await freezeClockAtNoon(app.db);
  slots = await addSlots(app.db);

  doraId = await addDoctor(app.db, "Dora", ids.mainOffice);
  ulaId = await addDoctor(app.db, "Ula", ids.mainOffice);
  await addLogin(app.db, ids.receptionist);
  await app.db.query(`UPDATE employee SET office_id = $1 WHERE employee_id = $2`, [ids.mainOffice, ids.receptionist]);
  labTypeId = (await app.db.query(`INSERT INTO employee_types (type_name) VALUES ('Lab Technician') RETURNING employee_type_id AS id`)).rows[0].id;
  const labId = await addEmployee(app.db, "Lee", labTypeId, ids.mainOffice);

  // how each patient is connected to Dan
  people.assigned = await addPatient(app.db, "Asa", "Assigned");
  people.booked = await addPatient(app.db, "Bea", "Booked");
  people.referred = await addPatient(app.db, "Rex", "Referred");
  people.stranger = await addPatient(app.db, "Sid", "Stranger");
  people.cancelledOnly = await addPatient(app.db, "Cal", "Cancelled");
  people.noShowOnly = await addPatient(app.db, "Nia", "Missed");
  people.pastReferral = await addPatient(app.db, "Pia", "Expired");
  people.seen = ids.patient;
  await app.db.query(`INSERT INTO patient_doctor (patient_id, doctor_id, is_primary) VALUES ($1, $2, true), ($3, $4, true)`, [people.assigned, ids.doctor, people.assigned, doraId]);
  await visit(people.booked, ids.doctor, "Scheduled", { date: dayFrom(today, 5) });
  await visit(people.cancelledOnly, ids.doctor, "Cancelled");
  await visit(people.noShowOnly, ids.doctor, "No Show");
  await app.db.query(
    `INSERT INTO referral (patient_id, referring_doctor_id, specialist_doctor_id, specialty_id, date_issued, expiration_date, status)
     VALUES ($1, $3, $4, $5, $6, $7, 'Pending'), ($2, $3, $4, $5, $8, $9, 'Pending')`,
    [people.referred, people.pastReferral, doraId, ids.doctor, ids.cardiology, today, dayFrom(today, 30), dayFrom(today, -100), dayFrom(today, -10)]
  );

  // chart data for Pat, who Dan has seen before
  people.seenVisit = await visit(people.seen, ids.doctor, "Completed");
  await app.db.query(`INSERT INTO appointment_summary (appointment_id, visit_reason, notes, recorded_by_employee_id, recorded_date) VALUES ($1, 'Cough', 'Rest and fluids', $2, $3)`, [
    people.seenVisit,
    ids.doctor,
    dayFrom(today, -1),
  ]);
  await app.db.query(`INSERT INTO visit_diagnosis (appointment_id, name, recorded_by_employee_id, created_at) VALUES ($1, 'Bronchitis', $2, $3)`, [
    people.seenVisit,
    ids.doctor,
    `${dayFrom(today, -1)} 09:00`,
  ]);
  const allergyTypes = await app.db.query(`INSERT INTO allergy_type (name, category) VALUES ('Penicillin', 'Medication'), ('Peanuts', 'Food') RETURNING allergy_type_id`);
  await app.db.query(`INSERT INTO allergy (patient_id, allergy_type_id, reaction, severity) VALUES ($1, $2, 'Hives', 'Severe'), ($1, $3, 'Itching', 'Mild')`, [
    people.seen,
    allergyTypes.rows[0].allergy_type_id,
    allergyTypes.rows[1].allergy_type_id,
  ]);
  const added = await app.db.query(`INSERT INTO medication (name) VALUES ('Amoxicillin'), ('Ibuprofen') RETURNING medication_id`);
  [meds.amox, meds.ibu] = added.rows.map((r) => r.medication_id);
  meds.retired = (await app.db.query(`INSERT INTO medication (name, is_active) VALUES ('Old Pill', false) RETURNING medication_id`)).rows[0].medication_id;
  await app.db.query(`INSERT INTO home_medication (patient_id, medication_id, medication_name, category, dosage, frequency) VALUES ($1, $2, 'Ibuprofen', 'OTC', '200 mg', 'As needed')`, [
    people.seen,
    meds.ibu,
  ]);
  for (let i = 0; i < 12; i++) {
    await app.db.query(`INSERT INTO patient_vitals (patient_id, recorded_by_employee_id, temperature, heartrate_bpm, recorded_at) VALUES ($1, $2, 98.6, $3, $4)`, [
      people.seen,
      ids.nurse,
      60 + i,
      `${dayFrom(today, -20 + i)} 08:00`,
    ]);
  }
  await app.db.query(`INSERT INTO insurance (patient_id, provider, policy_number, status) VALUES ($1, 'Aetna', 'AE-SECRET-1', 'Verified')`, [people.seen]);
  await app.db.query(`INSERT INTO form_type (name, is_required) VALUES ('Intake', true), ('Optional Survey', false)`);
  const labTests = await app.db.query(`INSERT INTO lab_test_type (name, cost) VALUES ('CBC', 25), ('Lipid Panel', 40) RETURNING lab_test_type_id`);
  [tests.cbc, tests.lipid] = labTests.rows.map((r) => r.lab_test_type_id);
  tests.retired = (await app.db.query(`INSERT INTO lab_test_type (name, cost, is_active) VALUES ('Retired Test', 10, false) RETURNING lab_test_type_id`)).rows[0].lab_test_type_id;

  dan = await app.loginStaff(ids.doctor);
  dora = await app.loginStaff(doraId);
  ula = await app.loginStaff(ulaId);
  pat = await app.loginPatient(ids.patient, "pat@test.org");
  rita = await app.loginStaff(ids.receptionist);
  lab = await app.loginStaff(labId);
  others = [
    ["visitor", app.client(), 401],
    ["patient", pat, 403],
    ["nurse", await app.loginStaff(ids.nurse), 403],
    ["receptionist", rita, 403],
    ["lab", lab, 403],
    ["admin", await app.loginStaff(ids.admin), 403],
  ];
});

after(async () => {
  await unfreezeClock(app.db);
  await app.close();
});

describe("which patients a doctor can see", () => {
  test("assigned, booked and seen patients are listed, and a referral alone isn't enough", async () => {
    const res = await dan.get("/api/doctor/patients");
    assert.equal(res.status, 200);
    const listed = ids_(res.body);
    for (const key of ["assigned", "booked", "seen"]) assert.ok(listed.includes(people[key]), `${key} missing`);
    for (const key of ["referred", "stranger", "cancelledOnly", "noShowOnly", "pastReferral"]) assert.equal(listed.includes(people[key]), false, `${key} listed`);
    assert.deepEqual(Object.keys(res.body[0]), PATIENT_LIST_KEYS);

    const assigned = res.body.find((p: { patientId: number }) => p.patientId === people.assigned);
    const booked = res.body.find((p: { patientId: number }) => p.patientId === people.booked);
    const seen = res.body.find((p: { patientId: number }) => p.patientId === people.seen);
    const seenOn = (await app.db.query(`SELECT to_char(appointment_date, 'YYYY-MM-DD') AS d FROM appointment WHERE appointment_id = $1`, [people.seenVisit])).rows[0].d;
    assert.deepEqual([assigned.assignedToMe, booked.assignedToMe, booked.nextVisit, seen.lastVisit], [true, false, dayFrom(today, 5), seenOn]);
  });

  test("search narrows the list, a doctor ID in the query changes nothing, and other doctors see their own", async () => {
    assert.deepEqual(ids_((await dan.get("/api/doctor/patients?search=booked")).body), [people.booked]);
    assert.deepEqual((await dan.get("/api/doctor/patients?search=%25")).body, []);
    assert.deepEqual(ids_((await ula.get(`/api/doctor/patients?doctorId=${ids.doctor}`)).body), []);
    assert.deepEqual(ids_((await dora.get("/api/doctor/patients")).body).sort(), [people.assigned].sort());
  });

  test("the chart shows the patient's clinical record", async () => {
    const res = await dan.get(`/api/doctor/patients/${people.seen}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body), CHART_KEYS);
    assert.deepEqual(res.body.allergies.map((a: { name: string; severity: string }) => [a.name, a.severity]), [["Penicillin", "Severe"], ["Peanuts", "Mild"]]);
    assert.deepEqual(res.body.insurance, { provider: "Aetna", status: "Verified" });
    assert.deepEqual(res.body.missingForms, ["Intake"]);
    assert.deepEqual(res.body.homeMedications.map((m: { medicationName: string }) => m.medicationName), ["Ibuprofen"]);
    assert.equal(res.body.vitals.length, 10);
    assert.deepEqual([res.body.vitals[0].heartRate, res.body.vitals[0].temperature, res.body.vitals[0].recordedAt], [71, 98.6, `${dayFrom(today, -9)} 08:00`]);
    const seenVisit = res.body.visits.find((v: { appointmentId: number }) => v.appointmentId === people.seenVisit);
    assert.deepEqual([seenVisit.visitReason, seenVisit.diagnoses, seenVisit.status], ["Cough", ["Bronchitis"], "Completed"]);
    assert.doesNotMatch(JSON.stringify(res.body), /AE-SECRET-1|password|pat@test\.org/);
  });

  test("a doctor without a care relationship can't open the chart", async () => {
    for (const key of ["referred", "stranger", "cancelledOnly", "noShowOnly", "pastReferral"]) {
      assert.deepEqual((await dan.get(`/api/doctor/patients/${people[key]}`)).body, { error: "This patient isn't under your care" }, key);
    }
    assert.equal((await ula.get(`/api/doctor/patients/${people.seen}`)).status, 403);
    assert.equal((await dan.get("/api/doctor/patients/999999")).status, 404);
    assert.equal((await dan.get("/api/doctor/patients/abc")).status, 400);
  });

  test("a referral alone shows the referral but not the chart, until a visit is booked", async () => {
    const patientId = await addPatient(app.db, "Ria", "Referral");
    const referral = await app.db.query(
      `INSERT INTO referral (patient_id, referring_doctor_id, specialist_doctor_id, specialty_id, date_issued, expiration_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Pending') RETURNING referral_id`,
      [patientId, doraId, ids.doctor, ids.cardiology, today, dayFrom(today, 30)]
    );
    const referralId = referral.rows[0].referral_id;
    // records another doctor made for this patient
    const prescription = await app.db.query(`INSERT INTO prescription (patient_id, prescriber_id) VALUES ($1, $2) RETURNING prescription_id`, [patientId, doraId]);
    const labOrder = await app.db.query(`INSERT INTO lab_order (patient_id, ordered_by_employee_id, lab_test_type_id) VALUES ($1, $2, $3) RETURNING lab_order_id`, [
      patientId,
      doraId,
      tests.cbc,
    ]);

    // the referral itself is still there to read and answer
    const received = (await dan.get("/api/doctor/referrals?view=received")).body.received;
    assert.ok(received.some((r: { referralId: number; patientName: string }) => r.referralId === referralId && r.patientName === "Ria Referral"), "referral listed");
    assert.equal((await dan.patch(`/api/doctor/referrals/${referralId}/status`, { status: "Approved" })).body.status, "Approved");

    // even an approved referral doesn't open the chart or the patient's other records
    assert.equal((await dan.get(`/api/doctor/patients/${patientId}`)).status, 403);
    assert.equal(ids_((await dan.get("/api/doctor/patients")).body).includes(patientId), false);
    assert.equal((await dan.get(`/api/doctor/prescriptions/${prescription.rows[0].prescription_id}`)).status, 404);
    assert.equal((await dan.get(`/api/doctor/lab-orders/${labOrder.rows[0].lab_order_id}`)).status, 404);
    assert.equal((await order(dan, { patientId, labTestTypeId: tests.lipid })).status, 403);

    // once the referred visit is booked, the specialist cares for the patient
    await visit(patientId, ids.doctor, "Scheduled", { date: dayFrom(today, 7), slot: slots.noon });
    assert.equal((await dan.get(`/api/doctor/patients/${patientId}`)).status, 200);
    assert.ok(ids_((await dan.get("/api/doctor/patients")).body).includes(patientId), "listed after booking");
  });

  test("only doctors reach the doctor clinical routes", async () => {
    const labOrdersBefore = await count(`SELECT count(*) AS n FROM lab_order`);
    const reads = ["/api/doctor/dashboard", "/api/doctor/patients", `/api/doctor/patients/${people.seen}`, `/api/doctor/appointments/${people.seenVisit}`, "/api/doctor/lab-orders", "/api/doctor/medications", "/api/doctor/lab-tests"];
    for (const [name, client, status] of others) {
      for (const path of reads) assert.equal((await client.get(path)).status, status, `${name} GET ${path}`);
      assert.equal((await summary(client, people.seenVisit, { notes: "x" })).status, status, `${name} summary`);
      assert.equal((await diagnose(client, people.seenVisit, [{ name: "x" }])).status, status, `${name} diagnoses`);
      assert.equal((await prescribe(client, people.seenVisit, [{ medicationId: meds.amox, dosage: "1" }])).status, status, `${name} prescription`);
      assert.equal((await order(client, { patientId: people.seen, labTestTypeId: tests.cbc })).status, status, `${name} lab order`);
    }
    assert.equal(await count(`SELECT count(*) AS n FROM lab_order`), labOrdersBefore);
  });

  test("a deactivated doctor or one who stops being a doctor loses access on the next request", async () => {
    try {
      await app.db.query(`UPDATE employee SET is_active = false WHERE employee_id = $1`, [doraId]);
      assert.equal((await dora.get("/api/doctor/patients")).status, 401);
    } finally {
      await app.db.query(`UPDATE employee SET is_active = true WHERE employee_id = $1`, [doraId]);
    }
    dora = await app.loginStaff(doraId);
    try {
      await app.db.query(`UPDATE employee SET employee_type_id = $1 WHERE employee_id = $2`, [labTypeId, doraId]);
      assert.equal((await dora.get("/api/doctor/patients")).status, 403);
    } finally {
      await app.db.query(`UPDATE employee SET employee_type_id = 2 WHERE employee_id = $1`, [doraId]);
    }
    assert.equal((await dora.get("/api/doctor/patients")).status, 200);
  });
});

describe("visit summaries", () => {
  test("a summary is created and later updated one field at a time", async () => {
    const appointmentId = await visit(people.seen, ids.doctor);
    const created = await summary(dan, appointmentId, { visitReason: "Headache", notes: "Started two days ago", recordedBy: ulaId });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.deepEqual(created.body, {
      appointmentId,
      visitReason: "Headache",
      notes: "Started two days ago",
      recordedById: ids.doctor,
      recordedBy: "Dan Doctor",
      recordedDate: today,
    });
    const notesOnly = await summary(dan, appointmentId, { notes: "Better after rest" });
    assert.deepEqual([notesOnly.body.visitReason, notesOnly.body.notes], ["Headache", "Better after rest"]);
    assert.equal(await count(`SELECT count(*) AS n FROM appointment_summary WHERE appointment_id = $1`, [appointmentId]), 1);
  });

  test("a doctor's update leaves a note someone else wrote alone and keeps its recorder", async () => {
    const appointmentId = await visit(people.seen, ids.doctor);
    await app.db.query(`INSERT INTO appointment_summary (appointment_id, notes, recorded_by_employee_id) VALUES ($1, 'Nurse triage note', $2)`, [appointmentId, ids.nurse]);
    const res = await summary(dan, appointmentId, { visitReason: "Follow up" });
    assert.deepEqual([res.body.visitReason, res.body.notes, res.body.recordedById], ["Follow up", "Nurse triage note", ids.nurse]);
  });

  test("only checked in or completed visits of the doctor's own can be documented", async () => {
    const notCheckedIn = await visit(people.seen, ids.doctor, "Scheduled", { date: dayFrom(today, 9) });
    assert.deepEqual((await summary(dan, notCheckedIn, { notes: "x" })).body, { error: "Only checked in or completed visits can be documented. This patient hasn't checked in yet." });
    for (const status of ["Cancelled", "No Show"]) {
      const res = await summary(dan, await visit(people.seen, ids.doctor, status), { notes: "x" });
      assert.deepEqual([res.status, res.body.error], [409, `Only checked in or completed visits can be documented. This one is ${status}.`]);
    }
    const { appointmentId } = await checkedInToday(ids.doctor, slots.early);
    assert.equal((await summary(dan, appointmentId, { visitReason: "Checked in now" })).status, 200);
    assert.equal((await summary(ula, appointmentId, { notes: "not mine" })).status, 404);
    assert.equal((await summary(dan, 999999, { notes: "x" })).status, 404);
    assert.equal((await summary(dan, appointmentId, {})).status, 400);
    assert.equal((await summary(dan, appointmentId, { visitReason: " " })).body.error, "Reason for visit is required");
    assert.equal(await count(`SELECT count(*) AS n FROM appointment_summary WHERE appointment_id = $1 AND notes = 'not mine'`, [appointmentId]), 0);
  });

  test("two saves at once keep both fields in one summary", async () => {
    const appointmentId = await visit(people.seen, ids.doctor);
    const results = await Promise.all([summary(dan, appointmentId, { visitReason: "Rash" }), summary(dan, appointmentId, { notes: "Spreading on arms" })]);
    assert.deepEqual(statuses(results), [200, 200]);
    const { rows } = await app.db.query(`SELECT visit_reason, notes FROM appointment_summary WHERE appointment_id = $1`, [appointmentId]);
    assert.deepEqual(rows, [{ visit_reason: "Rash", notes: "Spreading on arms" }]);
  });

  test("a summary waiting on a status change sees it, and a check out waits for a summary being saved", async () => {
    const first = await checkedInToday(ids.doctor, slots.noon);
    const res = await whileHeld(`UPDATE appointment SET status = 'Cancelled' WHERE appointment_id = $1`, first.appointmentId, () =>
      summary(dan, first.appointmentId, { notes: "too late" })
    );
    assert.deepEqual([res.status, res.body.error], [409, "Only checked in or completed visits can be documented. This one is Cancelled."]);

    const second = await checkedInToday(ids.doctor, slots.late);
    const restore = await slowWrites(app.db, "appointment_summary", "INSERT");
    try {
      const saving = summary(dan, second.appointmentId, { visitReason: "Sore throat" });
      for (let i = 0; i < 100; i++) {
        const { rows } = await app.db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep'`);
        if (rows[0].n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const checkingOut = rita.patch(`/api/receptionist/appointments/${second.appointmentId}/check-out`);
      await waitForLockWait(app.db);
      const [saved, checkedOut] = await Promise.all([saving, checkingOut]);
      assert.deepEqual([saved.status, checkedOut.status, checkedOut.body.status], [200, 200, "Completed"]);
    } finally {
      await restore();
    }
  });

  test("a doctor deactivated while saving can't finish the summary", async () => {
    const { appointmentId } = await checkedInToday(doraId, slots.allDay);
    const res = await whileHeld(`UPDATE employee SET is_active = false WHERE employee_id = $1`, doraId, () => summary(dora, appointmentId, { notes: "almost" }));
    await app.db.query(`UPDATE employee SET is_active = true WHERE employee_id = $1`, [doraId]);
    dora = await app.loginStaff(doraId);
    assert.deepEqual([res.status, res.body.error], [403, "Your account is no longer active"]);
    assert.equal(await count(`SELECT count(*) AS n FROM appointment_summary WHERE appointment_id = $1`, [appointmentId]), 0);
  });
});

describe("diagnoses", () => {
  test("diagnoses are added in order and repeats aren't saved twice", async () => {
    const appointmentId = await visit(people.seen, ids.doctor);
    const first = await diagnose(dan, appointmentId, [{ name: "Migraine", reasoning: "Light sensitivity" }, { name: "Dehydration" }, { name: "migraine" }]);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual(first.body.map((d: { name: string }) => d.name), ["Migraine", "Dehydration"]);
    assert.deepEqual([first.body[0].reasoning, first.body[0].recordedById, first.body[0].createdAt], ["Light sensitivity", ids.doctor, `${today} 12:00`]);

    const again = await diagnose(dan, appointmentId, [{ name: "DEHYDRATION" }, { name: "Anemia" }]);
    assert.deepEqual(again.body.map((d: { name: string }) => d.name), ["Migraine", "Dehydration", "Anemia"]);
    assert.equal((await diagnose(dan, appointmentId, [{ name: " " }])).status, 400);
    assert.equal((await diagnose(dan, appointmentId, [])).status, 400);
    assert.equal((await diagnose(ula, appointmentId, [{ name: "Not mine" }])).status, 404);
  });

  test("two requests adding the same diagnosis at once save it once", async () => {
    const appointmentId = await visit(people.seen, ids.doctor);
    await Promise.all([diagnose(dan, appointmentId, [{ name: "Flu" }]), diagnose(dan, appointmentId, [{ name: "Flu" }])]);
    assert.equal(await count(`SELECT count(*) AS n FROM visit_diagnosis WHERE appointment_id = $1`, [appointmentId]), 1);
  });

  test("a failed diagnosis insert saves none of them", async () => {
    const appointmentId = await visit(people.seen, ids.doctor);
    const restore = await failWrites(app.db, "visit_diagnosis", "INSERT");
    try {
      assert.equal((await diagnose(dan, appointmentId, [{ name: "One" }, { name: "Two" }])).status, 400);
    } finally {
      await restore();
    }
    assert.equal(await count(`SELECT count(*) AS n FROM visit_diagnosis WHERE appointment_id = $1`, [appointmentId]), 0);
  });

  test("the patient's records show the summary and every diagnosis for the visit", async () => {
    const appointmentId = await visit(people.seen, ids.doctor);
    await summary(dan, appointmentId, { visitReason: "Stomach ache", notes: "Mild" });
    await diagnose(dan, appointmentId, [{ name: "Gastritis" }, { name: "Reflux" }]);
    const records = await pat.get(`/api/patient/${people.seen}/records`);
    const shown = records.body.visits.find((v: { appointmentId: number }) => v.appointmentId === appointmentId);
    assert.deepEqual([shown.visitReason, shown.diagnosis, shown.notes], ["Stomach ache", "Gastritis, Reflux", "Mild"]);
    const visitView = (await dan.get(`/api/doctor/appointments/${appointmentId}`)).body;
    assert.deepEqual([visitView.summary.visitReason, visitView.diagnoses.length, visitView.missingForms], ["Stomach ache", 2, ["Intake"]]);
    assert.equal((await ula.get(`/api/doctor/appointments/${appointmentId}`)).status, 404);
  });
});

describe("prescriptions", () => {
  test("a prescription with several medications is saved for the visit's patient", async () => {
    const appointmentId = await visit(people.seen, ids.doctor);
    const res = await dan.post(`/api/doctor/appointments/${appointmentId}/prescriptions`, {
      patientId: people.stranger,
      prescriberId: ulaId,
      items: [
        { medicationId: meds.amox, dosage: "500 mg", instructions: "Twice a day with food", durationDays: 10 },
        { medicationId: meds.ibu, dosage: "200 mg" },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(
      [res.body.patientId, res.body.prescriberId, res.body.appointmentId, res.body.datePrescribed, res.body.isActive, res.body.items.length],
      [people.seen, ids.doctor, appointmentId, today, true, 2]
    );
    assert.deepEqual(res.body.items.map((i: { medicationName: string; durationDays: number | null }) => [i.medicationName, i.durationDays]), [["Amoxicillin", 10], ["Ibuprofen", null]]);

    assert.equal((await dan.get(`/api/doctor/prescriptions/${res.body.prescriptionId}`)).body.items.length, 2);
    assert.equal((await ula.get(`/api/doctor/prescriptions/${res.body.prescriptionId}`)).status, 404);
    const portal = (await pat.get(`/api/patient/${people.seen}/records`)).body.prescriptions.map((p: { prescriptionItemId: number }) => p.prescriptionItemId);
    for (const item of res.body.items) assert.ok(portal.includes(item.prescriptionItemId), "patient records missing an item");
  });

  test("bad medications and fields are rejected without leaving a partial prescription", async () => {
    const appointmentId = await visit(people.seen, ids.doctor);
    const before = await count(`SELECT count(*) AS n FROM prescription`);
    const cases: [object[], number, string][] = [
      [[{ medicationId: meds.amox, dosage: "1 tab" }, { medicationId: meds.retired, dosage: "1 tab" }], 400, "Choose an active medication"],
      [[{ medicationId: 999999, dosage: "1 tab" }], 400, "Choose an active medication"],
      [[{ medicationId: meds.amox, dosage: "1" }, { medicationId: meds.amox, dosage: "2" }], 400, "Each medication can only be listed once"],
      [[{ medicationId: meds.amox, dosage: "1", durationDays: 0 }], 400, "Duration must be more than 0 days"],
      [[{ medicationId: meds.amox, dosage: " " }], 400, "Dosage is required"],
      [[], 400, "Add at least one medication"],
    ];
    for (const [items, status, message] of cases) {
      const res = await prescribe(dan, appointmentId, items);
      assert.deepEqual([res.status, res.body.error], [status, message], JSON.stringify(items));
    }
    assert.equal(await count(`SELECT count(*) AS n FROM prescription`), before);
    assert.equal((await prescribe(dan, await visit(people.seen, ids.doctor, "No Show"), [{ medicationId: meds.amox, dosage: "1" }])).status, 409);
    assert.equal((await prescribe(ula, appointmentId, [{ medicationId: meds.amox, dosage: "1" }])).status, 404);
  });

  test("a failed item insert rolls back the whole prescription", async () => {
    const appointmentId = await visit(people.seen, ids.doctor);
    const before = await count(`SELECT count(*) AS n FROM prescription`);
    const restore = await failWrites(app.db, "prescription_item", "INSERT");
    try {
      assert.equal((await prescribe(dan, appointmentId, [{ medicationId: meds.amox, dosage: "1" }])).status, 400);
    } finally {
      await restore();
    }
    assert.equal(await count(`SELECT count(*) AS n FROM prescription`), before);
  });

  test("an inactive patient can't get a new prescription", async () => {
    const patientId = await addPatient(app.db, "Ivy", "Inactive");
    const appointmentId = await visit(patientId, ids.doctor);
    await app.db.query(`UPDATE patient SET is_active = false WHERE patient_id = $1`, [patientId]);
    assert.deepEqual((await prescribe(dan, appointmentId, [{ medicationId: meds.amox, dosage: "1" }])).body, { error: "This patient account is inactive" });
  });

  test("stopping medications ends the prescription once none are left", async () => {
    const appointmentId = await visit(people.seen, ids.doctor);
    const created = (await prescribe(dan, appointmentId, [{ medicationId: meds.amox, dosage: "1" }, { medicationId: meds.ibu, dosage: "2" }])).body;
    const [first, second] = created.items.map((i: { prescriptionItemId: number }) => i.prescriptionItemId);
    assert.equal((await ula.patch(`/api/doctor/prescription-items/${first}/stop`)).status, 404);
    const afterFirst = await dan.patch(`/api/doctor/prescription-items/${first}/stop`);
    assert.deepEqual([afterFirst.status, afterFirst.body.isActive], [200, true]);
    assert.equal((await dan.patch(`/api/doctor/prescription-items/${first}/stop`)).status, 409);
    assert.equal((await dan.patch(`/api/doctor/prescription-items/${second}/stop`)).body.isActive, false);
    const chartItems = (await dan.get(`/api/doctor/patients/${people.seen}`)).body.prescriptions.map((p: { prescriptionItemId: number }) => p.prescriptionItemId);
    assert.equal(chartItems.includes(first) || chartItems.includes(second), false);
  });
});

describe("lab orders", () => {
  test("a doctor orders a test for their patient, with or without a visit", async () => {
    const res = await order(dan, { patientId: people.assigned, labTestTypeId: tests.cbc, orderedBy: ulaId });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(
      [res.body.patientId, res.body.labTestTypeId, res.body.status, res.body.orderDate, res.body.orderedById, res.body.appointmentId, res.body.resultNotes],
      [people.assigned, tests.cbc, "Ordered", today, ids.doctor, null, null]
    );
    const appointmentId = await visit(people.seen, ids.doctor);
    const linked = await order(dan, { patientId: people.seen, labTestTypeId: tests.lipid, appointmentId });
    assert.deepEqual([linked.status, linked.body.appointmentId], [201, appointmentId]);
  });

  test("bad patients, visits and tests are rejected, and an open order isn't repeated", async () => {
    assert.equal((await order(dan, { patientId: people.stranger, labTestTypeId: tests.cbc })).status, 403);
    assert.equal((await order(dan, { patientId: 999999, labTestTypeId: tests.cbc })).status, 404);
    assert.deepEqual((await order(dan, { patientId: people.seen, labTestTypeId: tests.retired })).body, { error: "Choose an active lab test" });
    assert.equal((await order(dan, { patientId: people.seen, labTestTypeId: 999999 })).status, 400);
    const othersVisit = await visit(people.booked, ids.doctor);
    assert.equal((await order(dan, { patientId: people.seen, labTestTypeId: tests.cbc, appointmentId: othersVisit })).status, 404);
    const cancelled = await visit(people.seen, ids.doctor, "Cancelled");
    assert.equal((await order(dan, { patientId: people.seen, labTestTypeId: tests.cbc, appointmentId: cancelled })).status, 409);
    const repeat = await order(dan, { patientId: people.assigned, labTestTypeId: tests.cbc });
    assert.deepEqual([repeat.status, repeat.body.error], [409, "This test is already ordered for the patient and doesn't have a result yet"]);
  });

  test("two identical orders at once make one", async () => {
    const results = await Promise.all([order(dan, { patientId: people.booked, labTestTypeId: tests.cbc }), order(dan, { patientId: people.booked, labTestTypeId: tests.cbc })]);
    assert.deepEqual(statuses(results), [201, 409]);
    assert.equal(await count(`SELECT count(*) AS n FROM lab_order WHERE patient_id = $1 AND lab_test_type_id = $2`, [people.booked, tests.cbc]), 1);
  });

  test("doctors list their own orders and read orders for patients they care for", async () => {
    const mine = (await dan.get("/api/doctor/lab-orders?status=open")).body;
    assert.ok(mine.length >= 3 && mine.every((o: { orderedById: number; status: string }) => o.orderedById === ids.doctor && ["Ordered", "InProgress"].includes(o.status)), "open orders");
    assert.deepEqual((await dan.get("/api/doctor/lab-orders?search=booked")).body.map((o: { patientId: number }) => o.patientId), [people.booked]);
    assert.deepEqual((await ula.get("/api/doctor/lab-orders")).body, []);
    assert.equal((await dan.get("/api/doctor/lab-orders?status=done")).status, 400);

    const assignedOrder = mine.find((o: { patientId: number }) => o.patientId === people.assigned);
    assert.equal((await dora.get(`/api/doctor/lab-orders/${assignedOrder.labOrderId}`)).status, 200);
    assert.equal((await ula.get(`/api/doctor/lab-orders/${assignedOrder.labOrderId}`)).status, 404);
    assert.ok((await lab.get("/api/lab/orders")).body.some((o: { labOrderId: number }) => o.labOrderId === assignedOrder.labOrderId), "lab sees the order");
  });

  test("an order can be cancelled only before the lab starts it", async () => {
    const patientId = await addPatient(app.db, "Lia", "Labs");
    await visit(patientId, ids.doctor, "Scheduled", { date: dayFrom(today, 6), slot: slots.noon });
    const created = (await order(dan, { patientId, labTestTypeId: tests.lipid })).body;
    assert.equal((await ula.patch(`/api/doctor/lab-orders/${created.labOrderId}/cancel`)).status, 404);
    const cancelled = await dan.patch(`/api/doctor/lab-orders/${created.labOrderId}/cancel`);
    assert.deepEqual([cancelled.status, cancelled.body.status], [200, "Cancelled"]);
    assert.equal((await dan.patch(`/api/doctor/lab-orders/${created.labOrderId}/cancel`)).status, 409);
    assert.equal((await order(dan, { patientId, labTestTypeId: tests.lipid })).status, 201);

    const started = (await order(dan, { patientId: people.assigned, labTestTypeId: tests.lipid })).body;
    assert.equal((await lab.patch(`/api/lab/orders/${started.labOrderId}/start`)).status, 200);
    const late = await dan.patch(`/api/doctor/lab-orders/${started.labOrderId}/cancel`);
    assert.deepEqual([late.status, late.body.error], [409, "Only orders the lab hasn't started can be cancelled. This one is InProgress."]);
    assert.equal((await app.db.query(`SELECT status FROM lab_order WHERE lab_order_id = $1`, [started.labOrderId])).rows[0].status, "InProgress");

    const raced = (await order(dan, { patientId, labTestTypeId: tests.cbc })).body;
    const [cancel, start] = await Promise.all([dan.patch(`/api/doctor/lab-orders/${raced.labOrderId}/cancel`), lab.patch(`/api/lab/orders/${raced.labOrderId}/start`)]);
    const { rows } = await app.db.query(`SELECT status FROM lab_order WHERE lab_order_id = $1`, [raced.labOrderId]);
    assert.ok((cancel.status === 200 && rows[0].status === "Cancelled") || (start.status === 200 && rows[0].status === "InProgress"), `cancel ${cancel.status}, start ${start.status}, now ${rows[0].status}`);
  });
});

describe("doctor dashboard", () => {
  test("the numbers and lists come from the doctor's own data", async () => {
    await app.db.query(`UPDATE lab_order SET status = 'Completed', result_notes = 'Normal', result_date = $1 WHERE patient_id = $2 AND lab_test_type_id = $3`, [
      `${today} 10:00`,
      people.seen,
      tests.lipid,
    ]);
    const res = await dan.get("/api/doctor/dashboard");
    assert.equal(res.status, 200);
    const scheduledToday = await count(`SELECT count(*) AS n FROM appointment WHERE doctor_id = $1 AND appointment_date = $2 AND status = 'Scheduled'`, [ids.doctor, today]);
    const open = await count(`SELECT count(*) AS n FROM lab_order WHERE ordered_by_employee_id = $1 AND status IN ('Ordered', 'InProgress')`, [ids.doctor]);
    assert.deepEqual(
      [res.body.myPatients, res.body.todayAppointments, res.body.pendingLabs, res.body.referralsToReview],
      [1, scheduledToday, open, 1]
    );
    assert.ok(res.body.upcomingAppointments.length <= 5 && res.body.upcomingAppointments.every((a: { status: string; doctorId: number }) => a.status === "Scheduled" && a.doctorId === ids.doctor), "upcoming");
    assert.deepEqual(res.body.recentResults.map((r: { resultNotes: string }) => r.resultNotes), ["Normal"]);

    const empty = (await ula.get(`/api/doctor/dashboard?doctorId=${ids.doctor}`)).body;
    assert.deepEqual([empty.myPatients, empty.todayAppointments, empty.pendingLabs, empty.referralsToReview, empty.upcomingAppointments, empty.recentResults], [0, 0, 0, 0, [], []]);
  });

  test("the old doctor status route is gone, since visits are completed at check out", async () => {
    assert.equal((await dan.patch(`/api/doctor/appointments/${people.seenVisit}/status`, { status: "Completed" })).status, 404);
  });
});

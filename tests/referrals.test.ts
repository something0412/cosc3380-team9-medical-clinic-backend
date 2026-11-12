import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import {
  TEST_CLOCK_OPTION,
  addAppointment,
  addDoctor,
  addEmployee,
  addLogin,
  addPatient,
  addReferral,
  asEmployee,
  dayFrom,
  freezeClockAtNoon,
  unfreezeClock,
  waitForLockWait,
} from "./helpers/appointmentData.js";
import { slowWrites } from "./helpers/dbFaults.js";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient, TestResponse } from "./helpers/testApp.js";
import { ids, resetDatabase } from "./helpers/testDb.js";

const DOCTOR_KEYS = [
  "referralId", "patientId", "patientName", "referringDoctorId", "referringDoctorName", "specialistDoctorId", "specialistName",
  "specialtyId", "specialty", "dateIssued", "expirationDate", "status", "expired", "primaryDoctorId", "primaryDoctorName", "requestReason", "denialReason",
];
const PATIENT_KEYS = ["referralId", "referringDoctorName", "specialistDoctorId", "specialistName", "specialtyId", "specialty", "dateIssued", "expirationDate", "status", "expired"];

let app: Awaited<ReturnType<typeof startTestApp>>;
let today: string;
let slots: number[];
let rayId: number, paigeId: number, unaId: number, ivyId: number, halId: number, caraId: number, seenId: number, checkedId: number, cancelledId: number;
let ray: TestClient, paige: TestClient, dan: TestClient, una: TestClient, seen: TestClient, checked: TestClient, cancelled: TestClient, mia: TestClient, pat: TestClient;
let others: [string, TestClient, number][];

const REASON = "Chest pain on exertion";
const statuses = (responses: TestResponse[]) => responses.map((r) => r.status).sort();
const refer = (client: TestClient, body: object) => client.post("/api/doctor/referrals", body);
const toCardiology = (patientId: number, extra: object = {}) => ({ patientId, specialistDoctorId: ids.doctor, specialtyId: ids.cardiology, reason: REASON, ...extra });
const decide = (client: TestClient, referralId: number | string, status: string, reason?: string) =>
  client.patch(`/api/doctor/referrals/${referralId}/status`, { status, reason });
const book = (client: TestClient, body: object) => client.post("/api/appointments", { doctorId: ids.doctor, specialtyId: ids.cardiology, ...body });
const list = async (client: TestClient) => (await client.get("/api/doctor/referrals")).body;

// a new patient whose primary doctor is Paige and who Ray also cares for, so each case starts with no other referrals
async function rayPatient(name = "Rae") {
  const patientId = await addPatient(app.db, name);
  await app.db.query(`INSERT INTO patient_doctor (patient_id, doctor_id, is_primary) VALUES ($1, $2, true), ($1, $3, false)`, [patientId, paigeId, rayId]);
  return patientId;
}

// a Pending referral from Ray to Dan for Cardiology, waiting on Paige
async function referral(patientId: number) {
  const res = await refer(ray, toCardiology(patientId));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.referralId as number;
}

async function approved(patientId: number) {
  const referralId = await referral(patientId);
  assert.equal((await decide(paige, referralId, "Approved")).status, 200);
  return referralId;
}

// for dates the API wouldn't allow today, like referrals that have already expired
async function insertReferral(patientId: number, status: "Pending" | "Approved" | "Denied", issued: string, expires: string, referringDoctorId = rayId) {
  return addReferral(app.db, { patientId, referringDoctorId, primaryDoctorId: paigeId, specialistDoctorId: ids.doctor, specialtyId: ids.cardiology, issued, expires, status });
}

// a change made straight in the database as this doctor, to check the referral trigger on its own
async function changeAs(employeeId: number, referralId: number, set: string) {
  return asEmployee(app.db, employeeId, (client) => client.query(`UPDATE referral SET ${set} WHERE referral_id = $1`, [referralId]));
}

async function statusOf(referralId: number) {
  return (await app.db.query(`SELECT status FROM referral WHERE referral_id = $1`, [referralId])).rows[0].status as string;
}

// Dan sees Cardiology patients on Mondays at Main Street, one week further out for each n
function monday(n: number) {
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  return dayFrom(today, ((1 - day + 7) % 7 || 7) + 7 * n);
}

// holds a change open in its own transaction while a second request waits on it
// a referral decision has to be made as the primary doctor, so the change can run as an employee
async function whileHeld(change: string, rowId: number, send: () => Promise<TestResponse>, employeeId?: number) {
  const held = await app.db.connect();
  try {
    await held.query("BEGIN");
    if (employeeId) await held.query(`SELECT set_config('app.employee_id', $1, true)`, [String(employeeId)]);
    await held.query(change, [rowId]);
    const waiting = send();
    await waitForLockWait(app.db);
    await held.query("COMMIT");
    return await waiting;
  } catch (err) {
    // a failed case shouldn't leave its transaction open for the next one
    await held.query("ROLLBACK");
    throw err;
  } finally {
    held.release();
  }
}

before(async () => {
  await resetDatabase();
  // at noon in Chicago it's already the next day in Kiritimati, so a referral dated by the database would be a day off
  process.env.DATABASE_URL += `?options=${encodeURIComponent(`-c TimeZone=Pacific/Kiritimati ${TEST_CLOCK_OPTION}`)}`;
  app = await startTestApp();
  today = await freezeClockAtNoon(app.db);

  const added = await app.db.query(
    `INSERT INTO time_slot (shift_type_id, start_time, end_time) VALUES (1, '08:00', '08:30'), (1, '08:30', '09:00'), (1, '09:00', '09:30') RETURNING time_slot_id`
  );
  slots = added.rows.map((r) => r.time_slot_id);

  rayId = await addDoctor(app.db, "Ray", ids.mainOffice);
  paigeId = await addDoctor(app.db, "Paige", ids.mainOffice);
  unaId = await addDoctor(app.db, "Una", ids.mainOffice);
  seenId = await addDoctor(app.db, "Seen", ids.mainOffice);
  checkedId = await addDoctor(app.db, "Checked", ids.mainOffice);
  cancelledId = await addDoctor(app.db, "Cancel", ids.mainOffice);
  ivyId = await addDoctor(app.db, "Ivy", ids.mainOffice);
  halId = await addDoctor(app.db, "Hal", ids.mainOffice);
  caraId = await addDoctor(app.db, "Cara", ids.mainOffice);
  await app.db.query(`INSERT INTO doctor_specialty (doctor_id, specialty_id) VALUES ($1, $3), ($2, $3)`, [ivyId, caraId, ids.cardiology]);
  await app.db.query(`INSERT INTO doctor_specialty (doctor_id, specialty_id, is_active) VALUES ($1, $2, false)`, [halId, ids.cardiology]);
  await app.db.query(`UPDATE employee SET is_active = false WHERE employee_id = $1`, [ivyId]);
  await app.db.query(`INSERT INTO doctor_schedule (doctor_id, day_of_week, office_id, specialty_id, shift_type_id) VALUES ($1, 'Tuesday', $2, $3, 1)`, [
    caraId,
    ids.mainOffice,
    ids.cardiology,
  ]);

  const miaId = await addEmployee(app.db, "Mia", 4, ids.mainOffice);
  await addLogin(app.db, ids.receptionist);
  const labType = await app.db.query(`INSERT INTO employee_types (type_name) VALUES ('Lab Technician') RETURNING employee_type_id AS id`);
  const labId = await addEmployee(app.db, "Lee", labType.rows[0].id, ids.mainOffice);

  ray = await app.loginStaff(rayId);
  paige = await app.loginStaff(paigeId);
  dan = await app.loginStaff(ids.doctor);
  una = await app.loginStaff(unaId);
  seen = await app.loginStaff(seenId);
  checked = await app.loginStaff(checkedId);
  cancelled = await app.loginStaff(cancelledId);
  mia = await app.loginStaff(miaId);
  pat = await app.loginPatient(ids.patient, "pat@test.org");
  others = [
    ["visitor", app.client(), 401],
    ["patient", pat, 403],
    ["nurse", await app.loginStaff(ids.nurse), 403],
    ["receptionist", await app.loginStaff(ids.receptionist), 403],
    ["lab", await app.loginStaff(labId), 403],
    ["admin", await app.loginStaff(ids.admin), 403],
  ];
});

after(async () => {
  await unfreezeClock(app.db);
  await app.close();
});

describe("creating referrals", () => {
  test("a doctor refers their patient and it waits as Pending for the primary doctor, with the clinic date", async () => {
    const patientId = await rayPatient();
    // a status or referring doctor in the body is ignored
    const res = await refer(ray, toCardiology(patientId, { status: "Approved", referringDoctorId: unaId, reason: `  ${REASON}  ` }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body), DOCTOR_KEYS);
    assert.deepEqual(
      [res.body.status, res.body.referringDoctorId, res.body.specialistDoctorId, res.body.specialty, res.body.dateIssued, res.body.expirationDate, res.body.expired],
      ["Pending", rayId, ids.doctor, "Cardiology", today, dayFrom(today, 90), false]
    );
    assert.deepEqual(
      [res.body.primaryDoctorId, res.body.primaryDoctorName, res.body.requestReason, res.body.denialReason],
      [paigeId, "Paige Tester", REASON, null]
    );
    assert.equal(await statusOf(res.body.referralId), "Pending");

    const { rows } = await app.db.query(`SELECT to_char(now(), 'YYYY-MM-DD') AS db`);
    assert.notEqual(rows[0].db, today);
  });

  test("the primary doctor's own referral is approved as it's sent", async () => {
    const patientId = await rayPatient();
    const res = await refer(paige, toCardiology(patientId));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual([res.body.status, res.body.referringDoctorId, res.body.primaryDoctorId], ["Approved", paigeId, paigeId]);
    const { rows } = await app.db.query(`SELECT decided_at IS NOT NULL AS decided FROM referral WHERE referral_id = $1`, [res.body.referralId]);
    assert.equal(rows[0].decided, true);
  });

  test("a doctor who saw the patient at a completed or checked in visit can refer them", async () => {
    const patientId = await addPatient(app.db, "Seena");
    await addAppointment(app.db, { patientId, doctorId: seenId, officeId: ids.mainOffice, date: dayFrom(today, -3), timeSlotId: slots[0], status: "Completed" });
    const visit = await addAppointment(app.db, { patientId, doctorId: checkedId, officeId: ids.mainOffice, date: today, timeSlotId: slots[1] });
    await app.db.query(`UPDATE appointment SET checked_in_at = now() WHERE appointment_id = $1`, [visit]);
    const primaryOf = async () =>
      (await app.db.query(`SELECT doctor_id FROM patient_doctor WHERE patient_id = $1 AND is_primary AND is_active`, [patientId])).rows.map((r) => r.doctor_id);

    // with no primary doctor yet, an older visit isn't enough to pick one
    const early = await refer(seen, toCardiology(patientId));
    assert.deepEqual(
      [early.status, early.body.error],
      [409, "This patient doesn't have a primary doctor yet. Their first Family Medicine or Internal Medicine visit sets one."]
    );
    assert.deepEqual(await primaryOf(), []);

    // today's checked in Family Medicine visit makes that doctor the primary doctor, so their referral is approved
    const fromChecked = await refer(checked, toCardiology(patientId));
    assert.deepEqual([fromChecked.status, fromChecked.body.referringDoctorId, fromChecked.body.primaryDoctorId, fromChecked.body.status], [201, checkedId, checkedId, "Approved"]);
    assert.deepEqual(await primaryOf(), [checkedId]);

    const fromSeen = await refer(seen, toCardiology(patientId));
    assert.deepEqual([fromSeen.status, fromSeen.body.referringDoctorId, fromSeen.body.primaryDoctorId, fromSeen.body.status], [201, seenId, checkedId, "Pending"]);
  });

  test("unrelated doctors and visits that never happened don't count", async () => {
    const patientId = await rayPatient();
    const notCared = { error: "This patient isn't under your care" };
    assert.deepEqual((await refer(una, toCardiology(patientId))).body, notCared);

    // only cancelled, No Show and upcoming visits with this doctor
    for (const [status, date] of [["Cancelled", -2], ["No Show", -1], ["Scheduled", 5]] as const) {
      await addAppointment(app.db, { patientId, doctorId: cancelledId, officeId: ids.mainOffice, date: dayFrom(today, date), timeSlotId: slots[2], status });
    }
    const res = await refer(cancelled, toCardiology(patientId));
    assert.deepEqual([res.status, res.body], [403, notCared]);

    await app.db.query(`UPDATE patient_doctor SET is_active = false WHERE patient_id = $1 AND doctor_id = $2`, [patientId, rayId]);
    assert.equal((await refer(ray, toCardiology(patientId))).status, 403);
    const count = await app.db.query(`SELECT count(*)::int AS n FROM referral WHERE patient_id = $1`, [patientId]);
    assert.equal(count.rows[0].n, 0);
  });

  test("the patient has to exist and be active", async () => {
    const patientId = await rayPatient();
    await app.db.query(`UPDATE patient SET is_active = false WHERE patient_id = $1`, [patientId]);
    const res = await refer(ray, toCardiology(patientId));
    assert.deepEqual([res.status, res.body.error], [409, "This patient account is inactive"]);
    const missing = await refer(ray, toCardiology(99999));
    assert.deepEqual([missing.status, missing.body], [404, { error: "Patient not found" }]);
  });

  test("a patient with no primary doctor is checked for care and status before the primary doctor rule", async () => {
    const patientId = await addPatient(app.db, "Nora", "Noprimary");
    const referrals = async () => (await app.db.query(`SELECT count(*)::int AS n FROM referral WHERE patient_id = $1`, [patientId])).rows[0].n;

    // an unrelated doctor is not told whether the patient has a primary doctor
    const unrelated = await refer(una, toCardiology(patientId));
    assert.deepEqual([unrelated.status, unrelated.body], [403, { error: "This patient isn't under your care" }]);

    // a doctor who saw them is still refused once the account is inactive
    await addAppointment(app.db, { patientId, doctorId: seenId, officeId: ids.mainOffice, date: dayFrom(today, -4), timeSlotId: slots[0], status: "Completed" });
    await app.db.query(`UPDATE patient SET is_active = false WHERE patient_id = $1`, [patientId]);
    const inactive = await refer(seen, toCardiology(patientId));
    assert.deepEqual([inactive.status, inactive.body.error], [409, "This patient account is inactive"]);

    // once active again, the missing primary doctor is what stops it
    await app.db.query(`UPDATE patient SET is_active = true WHERE patient_id = $1`, [patientId]);
    const noPrimary = await refer(seen, toCardiology(patientId));
    assert.deepEqual(
      [noPrimary.status, noPrimary.body.error],
      [409, "This patient doesn't have a primary doctor yet. Their first Family Medicine or Internal Medicine visit sets one."]
    );

    assert.equal(await referrals(), 0);
    const primary = await app.db.query(`SELECT count(*)::int AS n FROM patient_doctor WHERE patient_id = $1`, [patientId]);
    assert.equal(primary.rows[0].n, 0);
  });

  test("the specialist has to be someone else who actively practices the specialty", async () => {
    const patientId = await rayPatient();
    const cases: [object, string][] = [
      [{ specialistDoctorId: rayId, specialtyId: ids.familyMedicine }, "You can't refer a patient to yourself"],
      [{ specialistDoctorId: unaId }, "That specialist doesn't practice this specialty"],
      [{ specialistDoctorId: ivyId }, "That specialist doesn't practice this specialty"],
      [{ specialistDoctorId: halId }, "That specialist doesn't practice this specialty"],
      [{ specialistDoctorId: 99999 }, "That specialist doesn't practice this specialty"],
      [{ specialtyId: ids.retiredSpecialty }, "That specialist doesn't practice this specialty"],
    ];
    for (const [change, message] of cases) {
      const res = await refer(ray, toCardiology(patientId, change));
      assert.deepEqual([res.status, res.body.error], [400, message], JSON.stringify(change));
    }
  });

  test("the expiration date has to be a real date after today", async () => {
    const patientId = await rayPatient();
    const later = await refer(ray, toCardiology(patientId, { expirationDate: dayFrom(today, 30) }));
    assert.deepEqual([later.status, later.body.expirationDate], [201, dayFrom(today, 30)]);

    for (const expirationDate of [today, dayFrom(today, -1)]) {
      assert.deepEqual((await refer(ray, toCardiology(patientId, { expirationDate }))).body, { error: "The expiration date has to be after today" });
    }
    for (const expirationDate of ["2026-02-30", "0000-01-01", "soon"]) {
      assert.equal((await refer(ray, toCardiology(patientId, { expirationDate }))).status, 400, expirationDate);
    }
    assert.equal((await refer(ray, { patientId })).body.error, "Choose a specialist");
  });

  test("a referral needs a reason", async () => {
    const patientId = await rayPatient();
    for (const reason of [undefined, "", "   "]) {
      const res = await refer(ray, toCardiology(patientId, { reason }));
      assert.deepEqual([res.status, res.body.error], [400, "Enter a reason"], JSON.stringify(reason));
    }
    assert.equal((await refer(ray, toCardiology(patientId, { reason: "x".repeat(2001) }))).body.error, "Keep the reason under 2000 characters");
    const count = await app.db.query(`SELECT count(*)::int AS n FROM referral WHERE patient_id = $1`, [patientId]);
    assert.equal(count.rows[0].n, 0);

    // the trigger refuses a referral without a reason or one that skips the primary doctor, even straight in the database
    const insert = (reason: string, primaryDoctorId: number, sentBy = rayId) =>
      asEmployee(app.db, sentBy, (client) =>
        client.query(
          `INSERT INTO referral (patient_id, referring_doctor_id, primary_doctor_id, specialist_doctor_id, specialty_id, expiration_date, request_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [patientId, rayId, primaryDoctorId, ids.doctor, ids.cardiology, dayFrom(today, 30), reason]
        )
      );
    await assert.rejects(insert(" ", paigeId), /A referral needs a reason/);
    await assert.rejects(insert(REASON, rayId), /The referral must go to the patient's primary doctor/);
    await assert.rejects(insert(REASON, paigeId, unaId), /Referrals must be sent by the referring doctor/);
  });
});

describe("approving and denying", () => {
  test("the primary doctor approves or denies a Pending referral, and a denial needs a reason", async () => {
    const yes = await decide(paige, await referral(await rayPatient()), "Approved", "Looks right");
    assert.equal(yes.status, 200);
    assert.deepEqual(Object.keys(yes.body), DOCTOR_KEYS);
    assert.deepEqual([yes.body.status, yes.body.expired, yes.body.denialReason], ["Approved", false, null]);

    const pending = await referral(await rayPatient());
    for (const reason of [undefined, "  "]) {
      const res = await decide(paige, pending, "Denied", reason);
      assert.deepEqual([res.status, res.body.error], [400, "Enter a reason for the denial"], JSON.stringify(reason));
    }
    assert.equal(await statusOf(pending), "Pending");
    // the trigger wants the reason too
    await assert.rejects(changeAs(paigeId, pending, `status = 'Denied'`), /A denial needs a reason/);

    const no = await decide(paige, pending, "Denied", "Try physical therapy first");
    assert.deepEqual([no.status, no.body.status, no.body.denialReason], [200, "Denied", "Try physical therapy first"]);
  });

  test("nobody but the patient's primary doctor can decide", async () => {
    const referralId = await referral(await rayPatient());
    const onlyPrimary = { error: "Only the patient's primary doctor can approve or deny it" };
    assert.deepEqual((await decide(ray, referralId, "Approved")).body, onlyPrimary);
    assert.deepEqual((await decide(dan, referralId, "Approved")).body, onlyPrimary);
    assert.deepEqual((await decide(una, referralId, "Approved")).body, { error: "Referral not found" });
    for (const [name, client, status] of others) {
      assert.equal((await decide(client, referralId, "Approved")).status, status, name);
    }
    // the trigger stops the referring doctor or the specialist straight in the database too
    for (const doctorId of [rayId, ids.doctor]) {
      await assert.rejects(changeAs(doctorId, referralId, `status = 'Approved'`), /Only the patient's primary doctor can approve or deny this referral/);
    }
    assert.equal(await statusOf(referralId), "Pending");
  });

  test("a decision is final", async () => {
    const yes = await approved(await rayPatient());
    assert.deepEqual((await decide(paige, yes, "Approved")).body, { error: "This referral was already approved" });
    assert.deepEqual((await decide(paige, yes, "Denied", "Changed my mind")).body, { error: "This referral was already approved" });
    await assert.rejects(changeAs(paigeId, yes, `status = 'Denied', denial_reason = 'Changed my mind'`), /This referral was already decided/);
    const no = await referral(await rayPatient());
    await decide(paige, no, "Denied", "Not needed yet");
    const again = await decide(paige, no, "Denied", "Still not needed");
    assert.deepEqual([again.status, again.body.error], [409, "This referral was already denied"]);
    assert.deepEqual([await statusOf(yes), await statusOf(no)], ["Approved", "Denied"]);
  });

  test("an expired referral can't be approved, but its last day still counts", async () => {
    const patientId = await rayPatient();
    const lapsed = await insertReferral(patientId, "Pending", dayFrom(today, -100), dayFrom(today, -1));
    const res = await decide(paige, lapsed, "Approved");
    assert.deepEqual([res.status, res.body.error], [409, "This referral has expired"]);
    await assert.rejects(changeAs(paigeId, lapsed, `status = 'Approved'`), /This referral has expired/);
    assert.equal(await statusOf(lapsed), "Pending");

    const lastDay = await insertReferral(patientId, "Pending", dayFrom(today, -90), today);
    assert.equal((await decide(paige, lastDay, "Approved")).status, 200);
  });

  test("bad decisions and IDs are rejected", async () => {
    const referralId = await referral(await rayPatient());
    for (const status of ["Pending", "Expired", "approved"]) {
      assert.deepEqual((await decide(paige, referralId, status)).body.error, "Status must be Approved or Denied", status);
    }
    assert.equal((await decide(paige, "abc", "Approved")).status, 400);
    assert.equal((await decide(paige, 999999, "Approved")).status, 404);
  });
});

describe("decisions at the same time", () => {
  test("approve and deny together leave one decision", async () => {
    const referralId = await referral(await rayPatient());
    const results = await Promise.all([decide(paige, referralId, "Approved"), decide(paige, referralId, "Denied", "Not needed yet")]);
    assert.deepEqual(statuses(results), [200, 409]);
    const winner = results.find((r) => r.status === 200)!;
    assert.equal(await statusOf(referralId), winner.body.status);
  });

  test("two approvals together approve once", async () => {
    const referralId = await referral(await rayPatient());
    assert.deepEqual(statuses(await Promise.all([decide(paige, referralId, "Approved"), decide(paige, referralId, "Approved")])), [200, 409]);
  });

  test("a decision waiting on another one sees it and doesn't overwrite it", async () => {
    const referralId = await referral(await rayPatient());
    const res = await whileHeld(
      `UPDATE referral SET status = 'Denied', denial_reason = 'Not needed yet' WHERE referral_id = $1`,
      referralId,
      () => decide(paige, referralId, "Approved"),
      paigeId
    );
    assert.deepEqual([res.status, res.body.error], [409, "This referral was already denied"]);
    assert.equal(await statusOf(referralId), "Denied");
  });
});

describe("referral lists", () => {
  test("doctors see what waits for them, what they sent and what was sent to them, newest first", async () => {
    type Row = { referralId: number; dateIssued: string; referringDoctorId: number; primaryDoctorId: number; specialistDoctorId: number; status: string };
    const isNewestFirst = (rows: Row[]) => {
      const order = rows.map((r) => [r.dateIssued, r.referralId] as const);
      const sorted = [...order].sort(([dateA, idA], [dateB, idB]) => (dateA === dateB ? idB - idA : dateA < dateB ? 1 : -1));
      assert.deepEqual(order, sorted);
    };

    const all = await ray.get("/api/doctor/referrals");
    assert.equal(all.status, 200);
    assert.deepEqual(Object.keys(all.body), ["toApprove", "sent", "received"]);
    assert.ok(all.body.sent.length > 0);
    assert.ok(all.body.sent.every((r: Row) => r.referringDoctorId === rayId));
    assert.deepEqual([all.body.toApprove, all.body.received], [[], []]);
    for (const r of all.body.sent) assert.deepEqual(Object.keys(r), DOCTOR_KEYS);
    isNewestFirst(all.body.sent);

    // the primary doctor gets what others sent for her patients, not her own referrals
    const primary = await list(paige);
    assert.ok(primary.toApprove.length > 0);
    assert.ok(primary.toApprove.every((r: Row) => r.primaryDoctorId === paigeId && r.referringDoctorId !== paigeId));
    isNewestFirst(primary.toApprove);

    // the specialist only gets referrals the primary doctor approved
    const specialist = await list(dan);
    assert.deepEqual([specialist.toApprove, specialist.sent], [[], []]);
    assert.ok(specialist.received.length > 0);
    assert.ok(specialist.received.every((r: Row) => r.specialistDoctorId === ids.doctor && r.status === "Approved"));
    isNewestFirst(specialist.received);

    // the old view filter is gone, so it changes nothing
    assert.deepEqual((await ray.get("/api/doctor/referrals?view=received")).body, all.body);
  });

  test("a specialist sees a referral only once the primary doctor approves it", async () => {
    const pending = await referral(await rayPatient());
    const denied = await referral(await rayPatient());
    const received = async () => (await list(dan)).received.map((r: { referralId: number }) => r.referralId);
    assert.equal((await received()).includes(pending), false);
    await decide(paige, denied, "Denied", "Not needed yet");
    await decide(paige, pending, "Approved");
    const now = await received();
    assert.deepEqual([now.includes(pending), now.includes(denied)], [true, false]);
  });

  test("a doctor can't read referrals they aren't part of", async () => {
    const empty = { toApprove: [], sent: [], received: [] };
    assert.deepEqual(await list(una), empty);
    assert.deepEqual((await una.get(`/api/doctor/referrals?doctorId=${ids.doctor}`)).body, empty);
    for (const [name, client, status] of others) {
      assert.equal((await client.get("/api/doctor/referrals")).status, status, name);
    }
  });

  test("each status shows as stored, with expired worked out from the date", async () => {
    type Row = { patientId: number; status: string; expired: boolean; dateIssued: string; expirationDate: string; requestReason: string; denialReason: string | null };
    const patientId = await rayPatient("Stella");
    // only the primary doctor's own referral can be stored already Approved and expired
    await insertReferral(patientId, "Approved", dayFrom(today, -100), dayFrom(today, -1), paigeId);
    await insertReferral(patientId, "Denied", dayFrom(today, -10), dayFrom(today, 80));
    await insertReferral(patientId, "Pending", today, today);
    const stella = (rows: Row[]) =>
      rows.filter((r) => r.patientId === patientId).map((r) => [r.status, r.expired, r.dateIssued, r.expirationDate, r.requestReason, r.denialReason]);

    assert.deepEqual(stella((await list(paige)).toApprove), [
      ["Pending", false, today, today, "Needs a specialist", null],
      ["Denied", false, dayFrom(today, -10), dayFrom(today, 80), "Needs a specialist", "Not needed yet"],
    ]);
    const expired = ["Approved", true, dayFrom(today, -100), dayFrom(today, -1), "Needs a specialist", null];
    assert.deepEqual(stella((await list(paige)).sent), [expired]);
    assert.deepEqual(stella((await list(dan)).received), [expired]);
  });

  test("patients see only their own referrals, with the status but not the reasons", async () => {
    await app.db.query(`INSERT INTO patient_doctor (patient_id, doctor_id, is_primary) VALUES ($1, $2, true), ($1, $3, false)`, [ids.patient, paigeId, rayId]);
    const own = await referral(ids.patient);
    const res = await pat.get(`/api/patient/${ids.patient}/referrals`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((r: { referralId: number }) => r.referralId), [own]);
    assert.deepEqual(Object.keys(res.body[0]), PATIENT_KEYS);
    assert.deepEqual([res.body[0].referringDoctorName, res.body[0].specialistName, res.body[0].status], ["Ray Tester", "Dan Doctor", "Pending"]);

    await decide(paige, own, "Denied", "Wait for the stress test results");
    const denied = await pat.get(`/api/patient/${ids.patient}/referrals`);
    assert.deepEqual([denied.body[0].status, Object.keys(denied.body[0])], ["Denied", PATIENT_KEYS]);
    assert.doesNotMatch(JSON.stringify(denied.body), /Chest pain|stress test/);

    const someoneElse = await rayPatient();
    assert.equal((await pat.get(`/api/patient/${someoneElse}/referrals`)).status, 403);
    assert.equal((await app.client().get(`/api/patient/${ids.patient}/referrals`)).status, 401);
    assert.equal((await dan.get(`/api/patient/${ids.patient}/referrals`)).status, 401);
    assert.equal((await pat.patch(`/api/doctor/referrals/${own}/status`, { status: "Approved" })).status, 403);
  });

  test("lists don't include contact or login details", async () => {
    const bodies = JSON.stringify([(await dan.get("/api/doctor/referrals")).body, (await pat.get(`/api/patient/${ids.patient}/referrals`)).body]);
    assert.doesNotMatch(bodies, /visit@test\.org|7135558800|1980-05-05|password|username/i);
  });

  test("the specialist list only has specialties that need a referral, and leaves out the doctor asking and anyone inactive", async () => {
    const res = await ray.get("/api/doctor/specialists");
    assert.equal(res.status, 200);
    const byId = new Map(res.body.map((d: { doctorId: number }) => [d.doctorId, d]));
    assert.equal(byId.has(rayId), false);
    assert.equal(byId.has(ivyId), false);
    assert.deepEqual((byId.get(ids.doctor) as { specialties: unknown }).specialties, [{ specialtyId: ids.cardiology, name: "Cardiology", requiresReferral: true }]);
    assert.deepEqual((byId.get(caraId) as { specialties: unknown }).specialties, [{ specialtyId: ids.cardiology, name: "Cardiology", requiresReferral: true }]);
    // Hal's Cardiology is inactive and Una and Paige only do Family Medicine
    for (const doctorId of [halId, unaId, paigeId]) assert.equal(byId.has(doctorId), false, String(doctorId));
    assert.equal((await pat.get("/api/doctor/specialists")).status, 403);
  });
});

describe("booking with referrals", () => {
  test("only an approved referral that's still valid lets the patient book", async () => {
    const [pending, denied, lapsed, good] = [await rayPatient(), await rayPatient(), await rayPatient(), await rayPatient()];
    await referral(pending);
    await decide(paige, await referral(denied), "Denied", "Not needed yet");
    await insertReferral(lapsed, "Approved", today, dayFrom(monday(0), -1));
    const goodReferral = await approved(good);

    for (const patientId of [pending, denied, lapsed]) {
      const res = await book(mia, { patientId, date: monday(0), timeSlotId: slots[0] });
      assert.deepEqual([res.status, res.body.error], [409, "This specialty needs an approved referral to this doctor"]);
    }
    const res = await book(mia, { patientId: good, date: monday(0), timeSlotId: slots[0] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.referralId, goodReferral);
  });

  test("a referral works through its last day and not after", async () => {
    const patientId = await rayPatient();
    const referralId = await insertReferral(patientId, "Approved", today, monday(1));
    assert.equal((await book(mia, { patientId, date: monday(2), timeSlotId: slots[0], referralId })).status, 409);
    assert.equal((await book(mia, { patientId, date: monday(1), timeSlotId: slots[0], referralId })).status, 201);
  });

  test("the specialist, specialty and patient still have to match", async () => {
    const patientId = await rayPatient();
    const referralId = await approved(patientId);
    const tuesday = dayFrom(monday(0), 1);
    const otherSpecialist = await book(mia, { patientId, doctorId: caraId, date: tuesday, timeSlotId: slots[0] });
    assert.equal(otherSpecialist.body.error, "This specialty needs an approved referral to this doctor");

    const otherPatient = await rayPatient();
    const borrowed = await book(mia, { patientId: otherPatient, date: monday(0), timeSlotId: slots[1], referralId });
    assert.deepEqual([borrowed.status, borrowed.body.error], [409, "That referral isn't valid for this appointment"]);
    assert.equal((await book(pat, { date: monday(0), timeSlotId: slots[2], referralId })).status, 409);
  });

  test("a booking waiting on an approval in progress uses the approved referral", async () => {
    const patientId = await rayPatient();
    const referralId = await referral(patientId);
    const res = await whileHeld(
      `UPDATE referral SET status = 'Approved' WHERE referral_id = $1`,
      referralId,
      () => book(mia, { patientId, date: monday(3), timeSlotId: slots[0], referralId }),
      paigeId
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.referralId, referralId);
  });

  // an approval is final, so ending the referral early is the change that can stop it from covering a visit
  test("a booking waiting on a referral that stops being valid for the date doesn't use it", async () => {
    const patientId = await rayPatient();
    const referralId = await approved(patientId);
    const res = await whileHeld(`UPDATE referral SET expiration_date = date_issued WHERE referral_id = $1`, referralId, () =>
      book(mia, { patientId, date: monday(4), timeSlotId: slots[0], referralId })
    );
    assert.equal(res.status, 409);
    const count = await app.db.query(`SELECT count(*)::int AS n FROM appointment WHERE referral_id = $1`, [referralId]);
    assert.equal(count.rows[0].n, 0);
  });

  test("a decision waits for a booking that is reading the patient's referrals", async () => {
    const patientId = await rayPatient();
    const inUse = await approved(patientId);
    const pending = await referral(patientId);
    const restore = await slowWrites(app.db, "appointment", "INSERT");
    try {
      const booking = book(mia, { patientId, date: monday(5), timeSlotId: slots[0], referralId: inUse });
      // wait until the booking holds its referral locks and is sleeping in the insert
      for (let i = 0; i < 100; i++) {
        const { rows } = await app.db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep'`);
        if (rows[0].n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const decision = decide(paige, pending, "Denied", "Not needed yet");
      // the decision is stuck behind the booking's lock on the patient's referrals
      await waitForLockWait(app.db);
      const [booked, decided] = await Promise.all([booking, decision]);
      assert.deepEqual([booked.status, decided.status, decided.body.status], [201, 200, "Denied"]);
    } finally {
      await restore();
    }
  });

  test("a decision and a booking sent together stay consistent", async () => {
    const patientId = await rayPatient();
    const referralId = await referral(patientId);
    const [decided, booked] = await Promise.all([
      decide(paige, referralId, "Approved"),
      book(mia, { patientId, date: monday(6), timeSlotId: slots[0], referralId }),
    ]);
    assert.equal(decided.status, 200);
    // the booking either saw the approval or still saw Pending, and it never used a referral that wasn't approved
    if (booked.status === 201) assert.equal(booked.body.referralId, referralId);
    else assert.equal(booked.status, 409);
    assert.equal(await statusOf(referralId), "Approved");
  });
});

describe("deactivation while a referral is being created", () => {
  let admin: TestClient;
  let samId: number;
  const deactivate = (employeeId: number, isActive: boolean) => admin.patch(`/api/admin/employees/${employeeId}/status`, { isActive });
  const toSam = (patientId: number) => ({ patientId, specialistDoctorId: samId, specialtyId: ids.cardiology, reason: REASON });
  const referralsTo = async (patientId: number, specialistId: number) =>
    (await app.db.query(`SELECT count(*)::int AS n FROM referral WHERE patient_id = $1 AND specialist_doctor_id = $2`, [patientId, specialistId])).rows[0].n;

  before(async () => {
    admin = await app.loginStaff(ids.admin);
    samId = await addDoctor(app.db, "Sam", ids.mainOffice);
    await app.db.query(`INSERT INTO doctor_specialty (doctor_id, specialty_id) VALUES ($1, $2)`, [samId, ids.cardiology]);
  });

  test("a specialist deactivated before the referral is refused, and works again once active", async () => {
    const patientId = await rayPatient();
    assert.equal((await deactivate(samId, false)).status, 200);
    const res = await refer(ray, toSam(patientId));
    assert.deepEqual([res.status, res.body.error], [400, "That specialist doesn't practice this specialty"]);
    assert.equal(await referralsTo(patientId, samId), 0);

    assert.equal((await deactivate(samId, true)).status, 200);
    assert.equal((await refer(ray, toSam(patientId))).status, 201);
  });

  test("a creation waits for a deactivation in progress and then sees it", async () => {
    const patientId = await rayPatient();
    try {
      const res = await whileHeld(`UPDATE employee SET is_active = false WHERE employee_id = $1`, samId, () => refer(ray, toSam(patientId)));
      assert.deepEqual([res.status, res.body.error], [400, "That specialist doesn't practice this specialty"]);
      assert.equal(await referralsTo(patientId, samId), 0);
    } finally {
      await deactivate(samId, true);
    }
  });

  test("a creation that locks first finishes, and the deactivation goes through after it", async () => {
    const patientId = await rayPatient();
    const restore = await slowWrites(app.db, "referral", "INSERT");
    try {
      const creating = refer(ray, toSam(patientId));
      // wait until the creation holds its locks and is sleeping in the insert
      for (let i = 0; i < 100; i++) {
        const { rows } = await app.db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep'`);
        if (rows[0].n > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const deactivating = deactivate(samId, false);
      await waitForLockWait(app.db);
      const [created, deactivated] = await Promise.all([creating, deactivating]);
      assert.deepEqual([created.status, created.body.status, deactivated.status, deactivated.body.isActive], [201, "Pending", 200, false]);
      assert.equal(await referralsTo(patientId, samId), 1);
    } finally {
      await restore();
      await deactivate(samId, true);
    }
  });

  test("the referring doctor or the patient being deactivated at the same time is waited for too", async () => {
    const rexId = await addDoctor(app.db, "Rex", ids.mainOffice);
    const rex = await app.loginStaff(rexId);
    const patientId = await addPatient(app.db, "Remi");
    await app.db.query(`INSERT INTO patient_doctor (patient_id, doctor_id, is_primary) VALUES ($1, $2, true), ($1, $3, false)`, [patientId, paigeId, rexId]);

    const doctorGone = await whileHeld(`UPDATE employee SET is_active = false WHERE employee_id = $1`, rexId, () => refer(rex, toCardiology(patientId)));
    assert.deepEqual([doctorGone.status, doctorGone.body.error], [403, "Your account is no longer active"]);
    await app.db.query(`UPDATE employee SET is_active = true WHERE employee_id = $1`, [rexId]);

    const rexAgain = await app.loginStaff(rexId);
    const patientGone = await whileHeld(`UPDATE patient SET is_active = false WHERE patient_id = $1`, patientId, () => refer(rexAgain, toCardiology(patientId)));
    assert.deepEqual([patientGone.status, patientGone.body.error], [409, "This patient account is inactive"]);
    assert.equal(await referralsTo(patientId, ids.doctor), 0);
  });

  test("creations, deactivations and bookings at the same time don't deadlock", async () => {
    const patientId = await rayPatient();
    const tuesday = dayFrom(monday(0), 1);
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all([
        refer(ray, toSam(patientId)),
        refer(ray, toCardiology(patientId)),
        deactivate(samId, false),
        book(mia, { patientId, doctorId: caraId, date: tuesday, timeSlotId: slots[1] }),
      ]);
      const [toSamResult, toDan, deactivated, booked] = results.map((r) => r.status);
      assert.ok([201, 400].includes(toSamResult), `round ${round} Sam ${toSamResult}`);
      assert.deepEqual([toDan, deactivated, booked], [201, 200, 409], `round ${round}`);
      assert.equal((await deactivate(samId, true)).status, 200);
    }
  });
});

describe("removed scaffolds", () => {
  test("the unused open slots and referral booking routes are gone", async () => {
    assert.equal((await dan.get(`/api/doctor/open-slots?date=${monday(0)}`)).status, 404);
    assert.equal((await dan.post("/api/doctor/referrals/1/appointment", { date: monday(0), timeSlotId: slots[0] })).status, 404);
    assert.equal((await dan.get("/api/doctor/referrals")).status, 200);
  });

  test("appointments are only created in the booking service", () => {
    const src = new URL("../src/", import.meta.url);
    const files = (readdirSync(src, { recursive: true }) as string[]).map((file) => file.replaceAll("\\", "/")).filter((file) => file.endsWith(".ts"));
    const writers = files.filter((file) => /INSERT INTO appointment\b/i.test(readFileSync(new URL(file, src), "utf8")));
    assert.deepEqual(writers, ["services/booking.ts"]);
  });
});

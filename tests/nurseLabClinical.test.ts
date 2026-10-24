import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import {
  TEST_CLOCK_OPTION,
  addAppointment,
  addDoctor,
  addEmployee,
  addLogin,
  addNurse,
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

const NURSE_CHART_KEYS = [
  "patientId", "firstName", "lastName", "dob", "gender", "phone", "isActive",
  "allergies", "missingForms", "homeMedications", "vitals", "nursingNotes", "visits", "labOrders", "prescriptions",
];
const NOT_TODAY = "This patient doesn't have a visit at your office today";

let app: Awaited<ReturnType<typeof startTestApp>>;
let today: string;
let slots: Awaited<ReturnType<typeof addSlots>>;
let nina: TestClient, nell: TestClient, omar: TestClient, dan: TestClient, ula: TestClient, rita: TestClient, pat: TestClient, lee: TestClient, lou: TestClient;
let nellId: number, louId: number, leeId: number;
const visits: Record<string, { patientId: number; appointmentId: number }> = {};
const allergyTypes: Record<string, number> = {};
const meds: Record<string, number> = {};
const labTests: Record<string, number> = {};

const statuses = (responses: TestResponse[]) => responses.map((r) => r.status).sort();
const ids_ = (rows: { patientId: number }[]) => rows.map((r) => r.patientId);

async function count(sql: string, params: unknown[] = []) {
  return Number((await app.db.query(sql, params)).rows[0].n);
}

// every visit gets its own doctor unless one is given, so visits never clash
async function visitAt(officeId: number, opts: { date?: string; status?: string; checkedIn?: boolean; doctorId?: number; patientId?: number } = {}) {
  const doctorId = opts.doctorId ?? (await addDoctor(app.db, "Doc", officeId));
  const patientId = opts.patientId ?? (await addPatient(app.db, "Pat", "Visit"));
  const appointmentId = await addAppointment(app.db, { patientId, doctorId, officeId, date: opts.date ?? today, timeSlotId: slots.allDay, status: opts.status ?? "Scheduled" });
  if (opts.checkedIn) await app.db.query(`UPDATE appointment SET checked_in_at = now() WHERE appointment_id = $1`, [appointmentId]);
  return { patientId, appointmentId };
}

const arrivedAtWestside = () => visitAt(ids.westsideOffice, { checkedIn: true });

// holds a change open in its own transaction while a request waits on it
async function whileHeld(change: string, params: unknown[], send: () => Promise<TestResponse>) {
  const held = await app.db.connect();
  try {
    await held.query("BEGIN");
    await held.query(change, params);
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

const vitals = (client: TestClient, appointmentId: number, body: object) => client.post(`/api/nurse/appointments/${appointmentId}/vitals`, body);
const note = (client: TestClient, appointmentId: number, text: string) => client.post(`/api/nurse/appointments/${appointmentId}/nursing-notes`, { note: text });
const order = (labTestTypeId: number, patientId: number) => dan.post("/api/doctor/lab-orders", { patientId, labTestTypeId });

before(async () => {
  await resetDatabase();
  // at noon in Chicago it's already the next day in Kiritimati, so a date taken from the database would be a day off
  process.env.DATABASE_URL += `?options=${encodeURIComponent(`-c TimeZone=Pacific/Kiritimati ${TEST_CLOCK_OPTION}`)}`;
  app = await startTestApp();
  today = await freezeClockAtNoon(app.db);
  slots = await addSlots(app.db);

  // Nina and Nell work at Westside, Omar at Main Street
  nellId = await addNurse(app.db, "Nell", ids.westsideOffice);
  const omarId = await addNurse(app.db, "Omar", ids.mainOffice);
  const ulaId = await addDoctor(app.db, "Ula", ids.mainOffice);
  await addLogin(app.db, ids.receptionist);
  const labTypeId = (await app.db.query(`INSERT INTO employee_types (type_name) VALUES ('Lab Technician') RETURNING employee_type_id AS id`)).rows[0].id;
  leeId = await addEmployee(app.db, "Lee", labTypeId, ids.mainOffice);
  louId = await addEmployee(app.db, "Lou", labTypeId, ids.westsideOffice);

  // Dan sees the arrived patient today at Westside, and saw Pat yesterday
  visits.arrived = await visitAt(ids.westsideOffice, { doctorId: ids.doctor, checkedIn: true });
  visits.patYesterday = await visitAt(ids.mainOffice, { doctorId: ids.doctor, patientId: ids.patient, date: dayFrom(today, -1), status: "Completed" });
  visits.notArrived = await visitAt(ids.westsideOffice);
  visits.finished = await visitAt(ids.westsideOffice, { status: "Completed" });
  visits.cancelled = await visitAt(ids.westsideOffice, { status: "Cancelled" });
  visits.noShow = await visitAt(ids.westsideOffice, { status: "No Show" });
  visits.mainStreet = await visitAt(ids.mainOffice, { checkedIn: true });
  visits.tomorrow = await visitAt(ids.westsideOffice, { date: dayFrom(today, 1) });
  visits.pastOnly = await visitAt(ids.westsideOffice, { date: dayFrom(today, -3), status: "Completed" });

  const types = await app.db.query(`INSERT INTO allergy_type (name, category) VALUES ('Penicillin', 'Medication'), ('Latex', 'Environmental') RETURNING allergy_type_id`);
  [allergyTypes.penicillin, allergyTypes.latex] = types.rows.map((r) => r.allergy_type_id);
  allergyTypes.retired = (await app.db.query(`INSERT INTO allergy_type (name, is_active) VALUES ('Retired', false) RETURNING allergy_type_id`)).rows[0].allergy_type_id;
  const added = await app.db.query(`INSERT INTO medication (name) VALUES ('Lisinopril'), ('Metformin') RETURNING medication_id`);
  [meds.lisinopril, meds.metformin] = added.rows.map((r) => r.medication_id);
  meds.retired = (await app.db.query(`INSERT INTO medication (name, is_active) VALUES ('Old Pill', false) RETURNING medication_id`)).rows[0].medication_id;
  const testTypes = await app.db.query(`INSERT INTO lab_test_type (name, cost) VALUES ('CBC', 25), ('Lipid Panel', 40), ('A1C', 30), ('TSH', 35) RETURNING lab_test_type_id`);
  [labTests.cbc, labTests.lipid, labTests.a1c, labTests.tsh] = testTypes.rows.map((r) => r.lab_test_type_id);
  await app.db.query(`INSERT INTO insurance (patient_id, provider, policy_number, status) VALUES ($1, 'Aetna', 'AE-SECRET-9', 'Verified')`, [visits.arrived.patientId]);

  nina = await app.loginStaff(ids.nurse);
  nell = await app.loginStaff(nellId);
  omar = await app.loginStaff(omarId);
  dan = await app.loginStaff(ids.doctor);
  ula = await app.loginStaff(ulaId);
  rita = await app.loginStaff(ids.receptionist);
  pat = await app.loginPatient(ids.patient, "pat@test.org");
  lee = await app.loginStaff(leeId);
  lou = await app.loginStaff(louId);
});

after(async () => {
  await unfreezeClock(app.db);
  await app.close();
});

describe("which patients a nurse can see", () => {
  test("a nurse sees patients with a visit at their office today, and nobody else", async () => {
    const res = await nina.get("/api/nurse/patients");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body[0]), ["patientId", "firstName", "lastName", "dob", "lastVisit", "nextVisit"]);
    const listed = ids_(res.body);
    for (const key of ["arrived", "notArrived", "finished"]) assert.ok(listed.includes(visits[key].patientId), `${key} missing`);
    for (const key of ["cancelled", "noShow", "mainStreet", "tomorrow", "pastOnly", "patYesterday"]) assert.equal(listed.includes(visits[key].patientId), false, `${key} listed`);
    assert.ok(ids_((await omar.get("/api/nurse/patients")).body).includes(visits.mainStreet.patientId), "Omar sees his office");
  });

  test("the nurse chart has the clinical record but no insurance", async () => {
    const res = await nina.get(`/api/nurse/patients/${visits.arrived.patientId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body), NURSE_CHART_KEYS);
    assert.equal(JSON.stringify(res.body).includes("AE-SECRET-9"), false);
    assert.equal((await dan.get(`/api/doctor/patients/${visits.arrived.patientId}`)).body.insurance.provider, "Aetna");

    for (const key of ["cancelled", "noShow", "mainStreet", "tomorrow", "pastOnly"]) {
      assert.deepEqual((await nina.get(`/api/nurse/patients/${visits[key].patientId}`)).body, { error: NOT_TODAY }, key);
    }
    assert.equal((await nina.get("/api/nurse/patients/999999")).status, 404);
  });

  test("an office in the query changes nothing, and a moved or deactivated nurse loses access on the next request", async () => {
    assert.deepEqual(ids_((await nell.get(`/api/nurse/patients?officeId=${ids.mainOffice}`)).body), ids_((await nell.get("/api/nurse/patients")).body));
    await app.db.query(`UPDATE employee SET office_id = $1 WHERE employee_id = $2`, [ids.mainOffice, nellId]);
    try {
      assert.equal((await nell.get(`/api/nurse/patients/${visits.arrived.patientId}`)).status, 403);
      assert.equal((await nell.get(`/api/nurse/patients/${visits.mainStreet.patientId}`)).status, 200);
    } finally {
      await app.db.query(`UPDATE employee SET office_id = $1 WHERE employee_id = $2`, [ids.westsideOffice, nellId]);
    }
    await app.db.query(`UPDATE employee SET is_active = false WHERE employee_id = $1`, [nellId]);
    try {
      assert.equal((await nell.get("/api/nurse/patients")).status, 401);
    } finally {
      await app.db.query(`UPDATE employee SET is_active = true WHERE employee_id = $1`, [nellId]);
      nell = await app.loginStaff(nellId);
    }
  });

  test("the visit view shows what was recorded, only for my office's patients today", async () => {
    const res = await nina.get(`/api/nurse/appointments/${visits.arrived.appointmentId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    for (const key of ["appointmentId", "checkedIn", "summary", "diagnoses", "vitals", "nursingNotes", "prescriptions", "allergies", "homeMedications", "missingForms"]) {
      assert.ok(key in res.body, `${key} missing`);
    }
    assert.equal("insurance" in res.body, false);
    assert.equal((await nina.get(`/api/nurse/appointments/${visits.mainStreet.appointmentId}`)).status, 404);
    assert.equal((await nina.get(`/api/nurse/appointments/${visits.tomorrow.appointmentId}`)).status, 403);
  });

  test("the dashboard counts today's visits and lists checked in patients without vitals", async () => {
    const extra = await arrivedAtWestside();
    const before = (await nina.get("/api/nurse/dashboard")).body;
    assert.ok(before.waitingList.some((a: { appointmentId: number }) => a.appointmentId === extra.appointmentId), "waiting for vitals");
    assert.equal(before.waitingForVitals, before.waitingList.length);

    assert.equal((await vitals(nina, extra.appointmentId, { heartRate: 70 })).status, 201);
    const after = (await nina.get("/api/nurse/dashboard")).body;
    assert.equal(after.waitingList.some((a: { appointmentId: number }) => a.appointmentId === extra.appointmentId), false);
    assert.deepEqual([after.todayAppointments, after.checkedIn, after.waitingForVitals], [before.todayAppointments, before.checkedIn, before.waitingForVitals - 1]);
    assert.equal(after.todayAppointments, after.notArrived + after.checkedIn + after.completed);
  });
});

describe("vitals", () => {
  test("a nurse records vitals for a checked in visit, and earlier readings stay as they were", async () => {
    const { patientId, appointmentId } = await arrivedAtWestside();
    const reading = { temperature: 98.6, heartRate: 72, systolic: 120, diastolic: 80, respiratoryRate: 16, oxygenSaturation: 98, weight: 150.5, height: 65 };
    const first = await vitals(nina, appointmentId, reading);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual({ ...first.body, vitalsId: 0 }, { vitalsId: 0, appointmentId, recordedAt: `${today} 12:00`, recordedBy: "Nina Nurse", ...reading });

    assert.equal((await vitals(nell, appointmentId, { heartRate: 88 })).status, 201);
    const saved = await app.db.query(`SELECT patient_id, recorded_by_employee_id, heartrate_bpm FROM patient_vitals WHERE appointment_id = $1 ORDER BY vitals_id`, [appointmentId]);
    assert.deepEqual(
      saved.rows.map((r) => [r.patient_id, r.recorded_by_employee_id, r.heartrate_bpm]),
      [
        [patientId, ids.nurse, 72],
        [patientId, nellId, 88],
      ]
    );
  });

  test("missing or invalid readings are rejected and nothing is saved", async () => {
    const { appointmentId } = await arrivedAtWestside();
    const bad: [object, string][] = [
      [{}, "Enter at least one reading"],
      [{ heartRate: null, weight: null }, "Enter at least one reading"],
      [{ heartRate: 72.5 }, "Heart rate must be a whole number"],
      [{ oxygenSaturation: 101 }, "Oxygen saturation can't be over 100 percent"],
      [{ temperature: -1 }, "Temperature must be more than 0"],
      [{ weight: "heavy" }, "Weight must be a number"],
      [{ height: 1e9 }, "Height is too large"],
    ];
    for (const [body, error] of bad) {
      const res = await vitals(nina, appointmentId, body);
      assert.deepEqual([res.status, res.body.error], [400, error], JSON.stringify(body));
    }
    assert.equal(await count(`SELECT count(*) AS n FROM patient_vitals WHERE appointment_id = $1`, [appointmentId]), 0);
  });

  test("vitals need a checked in or completed visit at my office today", async () => {
    const refused: [string, number, string][] = [
      ["notArrived", 409, "Only checked in or completed visits can be documented. This patient hasn't checked in yet."],
      ["cancelled", 409, "Only checked in or completed visits can be documented. This one is Cancelled."],
      ["noShow", 409, "Only checked in or completed visits can be documented. This one is No Show."],
      ["pastOnly", 409, "Nurses can only document a visit on the day it happens"],
      ["mainStreet", 404, "Appointment not found"],
    ];
    for (const [key, status, error] of refused) {
      const res = await vitals(nina, visits[key].appointmentId, { heartRate: 70 });
      assert.deepEqual([res.status, res.body.error], [status, error], key);
    }
    assert.equal((await vitals(nina, visits.finished.appointmentId, { weight: 140 })).status, 201);
  });

  test("a visit cancelled while vitals wait gets no vitals, and neither does a nurse deactivated or moved meanwhile", async () => {
    const cancelling = await arrivedAtWestside();
    const late = await whileHeld(`UPDATE appointment SET status = 'Cancelled', checked_in_at = NULL WHERE appointment_id = $1`, [cancelling.appointmentId], () =>
      vitals(nina, cancelling.appointmentId, { heartRate: 70 })
    );
    assert.deepEqual([late.status, late.body.error], [409, "Only checked in or completed visits can be documented. This one is Cancelled."]);

    const { appointmentId } = await arrivedAtWestside();
    const deactivated = await whileHeld(`UPDATE employee SET is_active = false WHERE employee_id = $1`, [nellId], () => vitals(nell, appointmentId, { heartRate: 70 }));
    await app.db.query(`UPDATE employee SET is_active = true WHERE employee_id = $1`, [nellId]);
    nell = await app.loginStaff(nellId);
    assert.deepEqual([deactivated.status, deactivated.body.error], [403, "Your account is no longer active"]);

    const moved = await whileHeld(`UPDATE employee SET office_id = $2 WHERE employee_id = $1`, [nellId, ids.mainOffice], () => vitals(nell, appointmentId, { heartRate: 70 }));
    await app.db.query(`UPDATE employee SET office_id = $2 WHERE employee_id = $1`, [nellId, ids.westsideOffice]);
    assert.equal(moved.status, 404);
    assert.equal(await count(`SELECT count(*) AS n FROM patient_vitals WHERE appointment_id = ANY($1::int[])`, [[cancelling.appointmentId, appointmentId]]), 0);
  });
});

describe("nursing notes", () => {
  test("nursing notes and the doctor's summary never overwrite each other", async () => {
    const { appointmentId, patientId } = visits.arrived;
    assert.equal((await dan.put(`/api/doctor/appointments/${appointmentId}/summary`, { visitReason: "Chest pain", notes: "Doctor plan" })).status, 200);
    const written = await note(nina, appointmentId, "BP taken in left arm");
    assert.equal(written.status, 201, JSON.stringify(written.body));
    assert.deepEqual(
      [written.body.note, written.body.recordedById, written.body.recordedBy, written.body.recordedAt, written.body.updatedAt],
      ["BP taken in left arm", ids.nurse, "Nina Nurse", `${today} 12:00`, null]
    );
    assert.equal((await dan.put(`/api/doctor/appointments/${appointmentId}/summary`, { notes: "Doctor plan, updated" })).status, 200);

    const doctorView = (await dan.get(`/api/doctor/appointments/${appointmentId}`)).body;
    assert.deepEqual([doctorView.summary.visitReason, doctorView.summary.notes, doctorView.summary.recordedById], ["Chest pain", "Doctor plan, updated", ids.doctor]);
    assert.deepEqual(doctorView.nursingNotes.map((n: { note: string }) => n.note), ["BP taken in left arm"]);
    const chart = (await nina.get(`/api/nurse/patients/${patientId}`)).body;
    assert.ok(chart.nursingNotes.some((n: { nursingNoteId: number }) => n.nursingNoteId === written.body.nursingNoteId), "note on the chart");
  });

  test("only the nurse who wrote a note can change it, and two nurses writing at once both keep their notes", async () => {
    const { appointmentId } = await arrivedAtWestside();
    const restore = await slowWrites(app.db, "nursing_note", "INSERT");
    let both: TestResponse[];
    try {
      both = await Promise.all([note(nina, appointmentId, "Nina's note"), note(nell, appointmentId, "Nell's note")]);
    } finally {
      await restore();
    }
    assert.deepEqual(statuses(both), [201, 201]);
    const ninas = both.find((r) => r.body.recordedById === ids.nurse)!.body;

    const edited = await nina.patch(`/api/nurse/nursing-notes/${ninas.nursingNoteId}`, { note: "Nina's note, fixed" });
    assert.deepEqual([edited.status, edited.body.note, edited.body.recordedAt, edited.body.updatedAt], [200, "Nina's note, fixed", `${today} 12:00`, `${today} 12:00`]);
    assert.deepEqual((await nell.patch(`/api/nurse/nursing-notes/${ninas.nursingNoteId}`, { note: "taken over" })).body, { error: "Only the nurse who wrote a note can change it" });
    assert.equal((await omar.patch(`/api/nurse/nursing-notes/${ninas.nursingNoteId}`, { note: "other office" })).status, 404);
    assert.equal((await nina.patch(`/api/nurse/nursing-notes/${ninas.nursingNoteId}`, { note: "  " })).status, 400);
    assert.equal((await nina.patch("/api/nurse/nursing-notes/999999", { note: "missing" })).status, 404);
    assert.deepEqual(
      (await app.db.query(`SELECT note FROM nursing_note WHERE appointment_id = $1 ORDER BY note`, [appointmentId])).rows.map((r) => r.note),
      ["Nell's note", "Nina's note, fixed"]
    );
  });

  test("Supabase's API roles can't read or add nursing notes", async () => {
    const migration = await readFile(new URL("../database/migrations/010_nursing_note.sql", import.meta.url), "utf8");
    const revoke = migration.slice(migration.indexOf("DO $$"), migration.lastIndexOf("$$;") + 3);
    const client = await app.db.connect();
    try {
      // the roles only live inside this transaction, so nothing is left behind
      await client.query("BEGIN");
      for (const role of ["anon", "authenticated", "note_probe"]) {
        await client.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
        await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
        // Supabase gives these grants on every new table
        await client.query(`GRANT ALL ON public.nursing_note, public.nursing_note_nursing_note_id_seq TO ${role}`);
      }
      await client.query(revoke);
      const notes = `SELECT count(*)::int AS n FROM public.nursing_note`;
      assert.ok((await client.query(notes)).rows[0].n > 0, "the owner sees notes");

      for (const role of ["anon", "authenticated"]) {
        await client.query("SAVEPOINT probe");
        await client.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(client.query(notes), /permission denied/, role);
        await client.query("ROLLBACK TO SAVEPOINT probe");
      }

      // a role that kept its grants still gets nothing past row level security
      await client.query(`SET LOCAL ROLE note_probe`);
      assert.equal((await client.query(notes)).rows[0].n, 0);
      await assert.rejects(
        client.query(`INSERT INTO public.nursing_note (appointment_id, recorded_by_employee_id, note, recorded_at) VALUES ($1, $2, 'probe', now())`, [
          visits.arrived.appointmentId,
          ids.nurse,
        ]),
        /row-level security/
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("nurses can't write doctor documentation, prescriptions or lab orders", async () => {
    const { appointmentId, patientId } = await arrivedAtWestside();
    const before = await count(`SELECT (SELECT count(*) FROM appointment_summary) + (SELECT count(*) FROM visit_diagnosis) + (SELECT count(*) FROM prescription) + (SELECT count(*) FROM lab_order) AS n`);
    const tries = [
      nina.put(`/api/doctor/appointments/${appointmentId}/summary`, { visitReason: "Nurse reason" }),
      nina.post(`/api/doctor/appointments/${appointmentId}/diagnoses`, { diagnoses: [{ name: "Flu" }] }),
      nina.post(`/api/doctor/appointments/${appointmentId}/prescriptions`, { items: [{ medicationId: meds.lisinopril, dosage: "10 mg" }] }),
      nina.post("/api/doctor/lab-orders", { patientId, labTestTypeId: labTests.cbc }),
      nina.patch(`/api/lab/orders/1/start`),
      nina.get("/api/admin/invoices"),
      nina.post("/api/patients", { firstName: "New" }),
      nina.get(`/api/doctor/patients/${patientId}`),
    ];
    assert.deepEqual(statuses(await Promise.all(tries)), [403, 403, 403, 403, 403, 403, 403, 403]);
    assert.equal(
      await count(`SELECT (SELECT count(*) FROM appointment_summary) + (SELECT count(*) FROM visit_diagnosis) + (SELECT count(*) FROM prescription) + (SELECT count(*) FROM lab_order) AS n`),
      before
    );
  });
});

describe("allergies and home medications", () => {
  test("doctors and nurses follow the same allergy rules", async () => {
    const { patientId } = visits.arrived;
    const added = await nina.post(`/api/nurse/patients/${patientId}/allergies`, { allergyTypeId: allergyTypes.penicillin, reaction: "Hives", severity: "Moderate" });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.deepEqual([added.body.name, added.body.reaction, added.body.severity, added.body.isActive], ["Penicillin", "Hives", "Moderate", true]);
    const { allergyId } = added.body;

    assert.deepEqual((await dan.post(`/api/doctor/patients/${patientId}/allergies`, { allergyTypeId: allergyTypes.penicillin, severity: "Mild" })).body, {
      error: "This allergy is already on the patient's chart. Edit it instead.",
    });
    const changed = await dan.patch(`/api/doctor/allergies/${allergyId}`, { severity: "Severe" });
    assert.deepEqual([changed.status, changed.body.reaction, changed.body.severity], [200, "Hives", "Severe"]);
    assert.equal((await nina.patch(`/api/nurse/allergies/${allergyId}/remove`)).body.isActive, false);
    assert.equal((await dan.patch(`/api/doctor/allergies/${allergyId}/remove`)).status, 409);
    assert.equal((await nina.patch(`/api/nurse/allergies/${allergyId}`, { severity: "Mild" })).status, 409);

    // adding it again brings back the same row
    const back = await dan.post(`/api/doctor/patients/${patientId}/allergies`, { allergyTypeId: allergyTypes.penicillin, severity: "Mild" });
    assert.deepEqual([back.status, back.body.allergyId, back.body.reaction, back.body.isActive], [201, allergyId, null, true]);
    assert.equal(await count(`SELECT count(*) AS n FROM allergy WHERE patient_id = $1`, [patientId]), 1);
    assert.deepEqual((await nina.get(`/api/nurse/patients/${patientId}`)).body.allergies.map((a: { allergyId: number }) => a.allergyId), [allergyId]);

    assert.equal((await nina.post(`/api/nurse/patients/${patientId}/allergies`, { allergyTypeId: allergyTypes.retired, severity: "Mild" })).status, 400);
    assert.equal((await nina.post(`/api/nurse/patients/${patientId}/allergies`, { allergyTypeId: allergyTypes.latex, severity: "Deadly" })).status, 400);
    assert.deepEqual((await nina.get("/api/nurse/allergy-types")).body, (await dan.get("/api/doctor/allergy-types")).body);
  });

  test("each role's patient rule decides who can change allergies and home medications", async () => {
    const outside = visits.mainStreet.patientId;
    const theirs = await app.db.query(`INSERT INTO allergy (patient_id, allergy_type_id, severity) VALUES ($1, $2, 'Mild') RETURNING allergy_id`, [outside, allergyTypes.latex]);
    const theirMed = await app.db.query(`INSERT INTO home_medication (patient_id, medication_name) VALUES ($1, 'Aspirin') RETURNING home_medication_id`, [outside]);

    assert.deepEqual((await nina.post(`/api/nurse/patients/${outside}/allergies`, { allergyTypeId: allergyTypes.penicillin, severity: "Mild" })).body, { error: NOT_TODAY });
    assert.deepEqual((await nina.patch(`/api/nurse/allergies/${theirs.rows[0].allergy_id}/remove`)).body, { error: "Allergy not found" });
    assert.deepEqual((await nina.patch(`/api/nurse/home-medications/${theirMed.rows[0].home_medication_id}/stop`)).body, { error: "Home medication not found" });
    assert.deepEqual((await ula.post(`/api/doctor/patients/${visits.arrived.patientId}/home-medications`, { medicationName: "Zinc" })).body, {
      error: "This patient isn't under your care",
    });
    assert.equal((await omar.patch(`/api/nurse/allergies/${theirs.rows[0].allergy_id}`, { reaction: "Rash" })).status, 200);

    for (const client of [rita, lee, pat, app.client()]) {
      for (const role of ["doctor", "nurse"]) {
        const res = await client.post(`/api/${role}/patients/${outside}/allergies`, { allergyTypeId: allergyTypes.penicillin, severity: "Mild" });
        assert.ok([401, 403].includes(res.status), `${role} write got ${res.status}`);
      }
    }
    assert.equal(await count(`SELECT count(*) AS n FROM allergy WHERE patient_id = $1 AND is_active`, [outside]), 1);
  });

  test("home medications stay separate from prescriptions and follow the same rules for both roles", async () => {
    const { patientId } = await arrivedAtWestside();
    await app.db.query(`INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, status, booking_channel)
      VALUES ($1, $2, $3, $4, $5, $6, 'Completed', 'Web')`, [patientId, ids.doctor, ids.mainOffice, dayFrom(today, -5), slots.allDay, ids.familyMedicine]);
    const prescriptionsBefore = await count(`SELECT count(*) AS n FROM prescription`);

    const picked = await nina.post(`/api/nurse/patients/${patientId}/home-medications`, { medicationId: meds.lisinopril, medicationName: "ignored", category: "Prescription", dosage: "10 mg", frequency: "Daily" });
    assert.equal(picked.status, 201, JSON.stringify(picked.body));
    assert.deepEqual(
      [picked.body.medicationId, picked.body.medicationName, picked.body.dosage, picked.body.startDate, picked.body.isActive],
      [meds.lisinopril, "Lisinopril", "10 mg", today, true]
    );
    const typed = await dan.post(`/api/doctor/patients/${patientId}/home-medications`, { medicationName: "Fish Oil", category: "Supplement" });
    assert.deepEqual([typed.status, typed.body.medicationId, typed.body.medicationName], [201, null, "Fish Oil"]);

    const refused: [object, number][] = [
      [{ medicationName: "lisinopril" }, 409],
      [{ medicationId: meds.lisinopril }, 409],
      [{ medicationName: "FISH OIL" }, 409],
      [{ medicationId: meds.retired }, 400],
      [{ medicationId: 999999 }, 400],
      [{ dosage: "5 mg" }, 400],
      [{ medicationName: "Vitamin D", category: "Herbal" }, 400],
    ];
    for (const [body, status] of refused) assert.equal((await nina.post(`/api/nurse/patients/${patientId}/home-medications`, body)).status, status, JSON.stringify(body));

    const changed = await dan.patch(`/api/doctor/home-medications/${picked.body.homeMedicationId}`, { dosage: "20 mg" });
    assert.deepEqual([changed.status, changed.body.dosage, changed.body.frequency, changed.body.category], [200, "20 mg", "Daily", "Prescription"]);
    assert.equal((await nina.patch(`/api/nurse/home-medications/${picked.body.homeMedicationId}`, {})).status, 400);
    assert.equal((await nina.patch(`/api/nurse/home-medications/${picked.body.homeMedicationId}/stop`)).body.isActive, false);
    assert.equal((await dan.patch(`/api/doctor/home-medications/${picked.body.homeMedicationId}/stop`)).status, 409);
    assert.equal((await nina.patch(`/api/nurse/home-medications/${picked.body.homeMedicationId}`, { dosage: "1 mg" })).status, 409);

    // once stopped it can be added again
    assert.equal((await nina.post(`/api/nurse/patients/${patientId}/home-medications`, { medicationId: meds.lisinopril })).status, 201);
    assert.deepEqual((await nina.get(`/api/nurse/patients/${patientId}`)).body.homeMedications.map((m: { medicationName: string }) => m.medicationName), ["Fish Oil", "Lisinopril"]);
    assert.equal(await count(`SELECT count(*) AS n FROM prescription`), prescriptionsBefore);
    assert.deepEqual((await nina.get("/api/nurse/medications")).body, (await dan.get("/api/doctor/medications")).body);
  });

  test("a doctor and a nurse adding the same record at once save it once", async () => {
    const { patientId } = visits.arrived;
    let restore = await slowWrites(app.db, "allergy", "INSERT");
    let allergies: TestResponse[];
    try {
      allergies = await Promise.all([
        nina.post(`/api/nurse/patients/${patientId}/allergies`, { allergyTypeId: allergyTypes.latex, severity: "Mild" }),
        dan.post(`/api/doctor/patients/${patientId}/allergies`, { allergyTypeId: allergyTypes.latex, severity: "Severe" }),
      ]);
    } finally {
      await restore();
    }
    assert.deepEqual(statuses(allergies), [201, 409]);

    restore = await slowWrites(app.db, "home_medication", "INSERT");
    let medications: TestResponse[];
    try {
      medications = await Promise.all([
        nina.post(`/api/nurse/patients/${patientId}/home-medications`, { medicationId: meds.metformin }),
        dan.post(`/api/doctor/patients/${patientId}/home-medications`, { medicationName: "metformin" }),
      ]);
    } finally {
      await restore();
    }
    assert.deepEqual(statuses(medications), [201, 409]);
    assert.equal(await count(`SELECT count(*) AS n FROM home_medication WHERE patient_id = $1 AND lower(medication_name) = 'metformin'`, [patientId]), 1);
  });

  test("a failed write leaves no partial record", async () => {
    const { patientId } = await arrivedAtWestside();
    const restore = await failWrites(app.db, "home_medication", "INSERT");
    try {
      assert.equal((await nina.post(`/api/nurse/patients/${patientId}/home-medications`, { medicationName: "Zinc" })).status, 400);
    } finally {
      await restore();
    }
    assert.equal(await count(`SELECT count(*) AS n FROM home_medication WHERE patient_id = $1`, [patientId]), 0);
  });
});

describe("lab technicians", () => {
  test("a lab technician starts an order and enters its result, which then can't change", async () => {
    assert.equal((await lee.get("/api/auth/me")).body.role, "lab");
    const created = (await order(labTests.cbc, ids.patient)).body;
    const waiting = await lee.get("/api/lab/orders");
    assert.ok(waiting.body.some((o: { labOrderId: number; dob: string }) => o.labOrderId === created.labOrderId && o.dob === "1990-01-01"), "listed with birth date");
    assert.equal((await lee.get(`/api/lab/orders/${created.labOrderId}`)).body.status, "Ordered");

    const early = await lee.patch(`/api/lab/orders/${created.labOrderId}/result`, { resultNotes: "too soon" });
    assert.deepEqual([early.status, early.body.error], [409, "Only started orders can get a result. This one is Ordered."]);
    assert.equal((await lee.patch(`/api/lab/orders/${created.labOrderId}/start`)).body.status, "InProgress");
    assert.ok((await lee.get("/api/lab/orders?status=open")).body.some((o: { labOrderId: number }) => o.labOrderId === created.labOrderId), "open includes started");
    assert.equal((await lee.patch(`/api/lab/orders/${created.labOrderId}/result`, { resultNotes: " " })).status, 400);

    const done = await lee.patch(`/api/lab/orders/${created.labOrderId}/result`, { resultNotes: "WBC 6.1" });
    assert.deepEqual([done.status, done.body.status, done.body.resultNotes, done.body.performedBy, done.body.resultDate], [200, "Completed", "WBC 6.1", "Lee Tester", `${today} 12:00`]);
    assert.equal((await lou.patch(`/api/lab/orders/${created.labOrderId}/result`, { resultNotes: "overwrite" })).status, 409);
    assert.equal((await lee.patch(`/api/lab/orders/${created.labOrderId}/start`)).status, 409);
    assert.equal((await dan.patch(`/api/doctor/lab-orders/${created.labOrderId}/cancel`)).status, 409);

    // the doctor, the patient portal and the stored row all see the same result
    assert.equal((await dan.get(`/api/doctor/lab-orders/${created.labOrderId}`)).body.resultNotes, "WBC 6.1");
    const records = (await pat.get(`/api/patient/${ids.patient}/records`)).body;
    assert.ok(records.labResults.some((l: { labOrderId: number; resultNotes: string }) => l.labOrderId === created.labOrderId && l.resultNotes === "WBC 6.1"), "portal shows it");
    const row = (await app.db.query(`SELECT performed_by_employee_id, result_notes FROM lab_order WHERE lab_order_id = $1`, [created.labOrderId])).rows[0];
    assert.deepEqual([row.performed_by_employee_id, row.result_notes], [leeId, "WBC 6.1"]);

    assert.equal((await lee.get("/api/lab/orders/999999")).status, 404);
    assert.equal((await lee.patch("/api/lab/orders/999999/start")).status, 404);
    assert.equal((await lee.get("/api/lab/orders?status=Done")).status, 400);
  });

  test("two technicians or a doctor and a technician can't both win the same order", async () => {
    const created = (await order(labTests.lipid, ids.patient)).body;
    const restore = await slowWrites(app.db, "lab_order", "UPDATE");
    try {
      assert.deepEqual(statuses(await Promise.all([lee.patch(`/api/lab/orders/${created.labOrderId}/start`), lou.patch(`/api/lab/orders/${created.labOrderId}/start`)])), [200, 409]);
      const results = await Promise.all([
        lee.patch(`/api/lab/orders/${created.labOrderId}/result`, { resultNotes: "Lee's result" }),
        lou.patch(`/api/lab/orders/${created.labOrderId}/result`, { resultNotes: "Lou's result" }),
      ]);
      assert.deepEqual(statuses(results), [200, 409]);
      const winner = results.find((r) => r.status === 200)!.body;
      const row = (await app.db.query(`SELECT result_notes, performed_by_employee_id FROM lab_order WHERE lab_order_id = $1`, [created.labOrderId])).rows[0];
      assert.deepEqual([row.result_notes, row.performed_by_employee_id], [winner.resultNotes, winner.performedBy === "Lee Tester" ? leeId : louId]);

      const raced = (await order(labTests.a1c, ids.patient)).body;
      const [cancel, start] = await Promise.all([dan.patch(`/api/doctor/lab-orders/${raced.labOrderId}/cancel`), lee.patch(`/api/lab/orders/${raced.labOrderId}/start`)]);
      assert.deepEqual(statuses([cancel, start]), [200, 409]);
    } finally {
      await restore();
    }

    const cancelled = (await order(labTests.tsh, ids.patient)).body;
    assert.equal((await dan.patch(`/api/doctor/lab-orders/${cancelled.labOrderId}/cancel`)).status, 200);
    const start = await lee.patch(`/api/lab/orders/${cancelled.labOrderId}/start`);
    assert.deepEqual([start.status, start.body.error], [409, "Only waiting orders can be started. This one is Cancelled."]);
    assert.equal((await lee.patch(`/api/lab/orders/${cancelled.labOrderId}/result`, { resultNotes: "x" })).status, 409);
  });

  test("lab technicians can't order labs, read charts or use other portals", async () => {
    const { patientId, appointmentId } = visits.arrived;
    const labOrdersBefore = await count(`SELECT count(*) AS n FROM lab_order`);
    const tries = [
      lee.post("/api/doctor/lab-orders", { patientId, labTestTypeId: labTests.cbc }),
      lee.get(`/api/doctor/patients/${patientId}`),
      lee.get(`/api/nurse/patients/${patientId}`),
      lee.post(`/api/nurse/appointments/${appointmentId}/vitals`, { heartRate: 70 }),
      lee.patch(`/api/receptionist/appointments/${appointmentId}/check-in`),
      lee.get("/api/admin/invoices"),
      lee.get("/api/patients"),
      lee.post(`/api/doctor/patients/${patientId}/home-medications`, { medicationName: "Zinc" }),
    ];
    assert.deepEqual(statuses(await Promise.all(tries)), [403, 403, 403, 403, 403, 403, 403, 403]);
    assert.equal(await count(`SELECT count(*) AS n FROM lab_order`), labOrdersBefore);
  });

  test("a deactivated lab technician loses access at once, even in the middle of a request", async () => {
    const created = (await order(labTests.cbc, visits.arrived.patientId)).body;
    const res = await whileHeld(`UPDATE employee SET is_active = false WHERE employee_id = $1`, [louId], () => lou.patch(`/api/lab/orders/${created.labOrderId}/start`));
    assert.deepEqual([res.status, res.body.error], [403, "Your account is no longer active"]);
    assert.equal((await lou.get("/api/lab/orders")).status, 401);
    assert.equal((await lee.get(`/api/lab/orders/${created.labOrderId}`)).body.status, "Ordered");
    await app.db.query(`UPDATE employee SET is_active = true WHERE employee_id = $1`, [louId]);
    lou = await app.loginStaff(louId);
  });
});

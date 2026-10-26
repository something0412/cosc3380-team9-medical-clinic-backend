import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { failWrites, slowWrites } from "./helpers/dbFaults.js";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient } from "./helpers/testApp.js";
import { TEST_PASSWORD, ids, resetDatabase } from "./helpers/testDb.js";

// patient 2 signs up in before()
const OLIVE = 2;

const DIRECTORY_KEYS = ["patientId", "firstName", "lastName", "dob", "isActive"];
const CONTACT_KEYS = ["emergencyContactId", "firstName", "lastName", "relationship", "phoneNumber", "isPrimary"];

let app: Awaited<ReturnType<typeof startTestApp>>;
let anonymous: TestClient, admin: TestClient, receptionist: TestClient, nurse: TestClient, doctor: TestClient, pat: TestClient, olive: TestClient;

const desk = (patientId: number, path = "") => `/api/receptionist/patients/${patientId}${path}`;
const contact = (overrides: object = {}) => ({ firstName: "Cal", lastName: "Contact", relationship: "Friend", phoneNumber: "713-555-8000", isPrimary: false, ...overrides });

async function primaries(patientId: number) {
  const result = await app.db.query(`SELECT first_name FROM emergency_contact WHERE patient_id = $1 AND is_primary AND is_active ORDER BY first_name`, [patientId]);
  return result.rows.map((r) => r.first_name);
}

const insuranceOf = async (patientId: number) =>
  (await app.db.query(`SELECT provider, policy_number AS "policyNumber", status FROM insurance WHERE patient_id = $1`, [patientId])).rows[0];

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  anonymous = app.client();
  admin = await app.loginStaff(ids.admin);
  assert.equal((await admin.post(`/api/admin/employees/${ids.receptionist}/login`, { username: "rita.records", password: TEST_PASSWORD })).status, 201);
  const signup = await app.client().post("/api/auth/patient/signup", {
    firstName: "Olive",
    lastName: "Other",
    dob: "1995-02-02",
    phone: "713-555-9100",
    email: "olive@test.org",
    password: TEST_PASSWORD,
  });
  assert.equal(signup.body.patientId, OLIVE);

  receptionist = await app.loginStaff(ids.receptionist);
  nurse = await app.loginStaff(ids.nurse);
  doctor = await app.loginStaff(ids.doctor);
  pat = await app.loginPatient(ids.patient, "pat@test.org");
  olive = await app.loginPatient(OLIVE, "olive@test.org");

  await app.db.query(`INSERT INTO time_slot (shift_type_id, start_time, end_time) VALUES (1, '08:00', '08:30')`);
});

after(() => app.close());

describe("patient status", () => {
  test("deactivating turns off the login and ends the session, and appointments stay as they are", async () => {
    const booked = await app.db.query(
      `INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, status, booking_channel)
       VALUES ($1, 2, 1, CURRENT_DATE + 30, 1, 1, 'Scheduled', 'Web') RETURNING appointment_id`,
      [OLIVE]
    );
    const appointmentStatus = async () =>
      (await app.db.query(`SELECT status FROM appointment WHERE appointment_id = $1`, [booked.rows[0].appointment_id])).rows[0].status;
    const flags = async () =>
      (await app.db.query(`SELECT p.is_active AS patient, c.is_active AS login FROM patient p JOIN patient_creds c USING (patient_id) WHERE patient_id = $1`, [OLIVE])).rows[0];

    const session = await app.loginPatient(OLIVE, "olive@test.org");
    const off = await admin.patch(`/api/admin/patients/${OLIVE}/status`, { isActive: false });
    assert.deepEqual([off.status, off.body], [200, { patientId: OLIVE, isActive: false }]);
    assert.deepEqual(await flags(), { patient: false, login: false });
    assert.equal((await session.get(`/api/patient/${OLIVE}/profile`)).status, 401);
    assert.equal((await app.client().post("/api/auth/patient/login", { patientId: OLIVE, email: "olive@test.org", password: TEST_PASSWORD })).status, 401);
    assert.equal(await appointmentStatus(), "Scheduled");

    const on = await admin.patch(`/api/admin/patients/${OLIVE}/status`, { isActive: true });
    assert.deepEqual([on.status, on.body], [200, { patientId: OLIVE, isActive: true }]);
    assert.deepEqual(await flags(), { patient: true, login: true });
    olive = await app.loginPatient(OLIVE, "olive@test.org");
    assert.equal(await appointmentStatus(), "Scheduled");
  });

  test("status changes check the patient, the body and who is asking", async () => {
    assert.equal((await admin.patch(`/api/admin/patients/99999/status`, { isActive: false })).status, 404);
    assert.equal((await admin.patch(`/api/admin/patients/${OLIVE}/status`, { isActive: "no" })).status, 400);
    for (const client of [receptionist, nurse, doctor, pat]) {
      assert.equal((await client.patch(`/api/admin/patients/${OLIVE}/status`, { isActive: false })).status, 403);
    }
  });

  test("a status change that fails part way changes nothing", async () => {
    const restore = await failWrites(app.db, "patient_creds", "UPDATE");
    try {
      assert.equal((await admin.patch(`/api/admin/patients/${OLIVE}/status`, { isActive: false })).status, 400);
    } finally {
      await restore();
    }
    assert.equal((await app.db.query(`SELECT is_active FROM patient WHERE patient_id = $1`, [OLIVE])).rows[0].is_active, true);
    assert.equal((await olive.get(`/api/patient/${OLIVE}/profile`)).status, 200);
  });
});

describe("contact info", () => {
  test("the front desk updates phone, address and gender but leaves the login email alone", async () => {
    const res = await receptionist.patch(desk(OLIVE), { phone: " 713-555-9999 ", address: "", gender: "Female", email: "changed@test.org" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { patientId: OLIVE, phone: "713-555-9999", email: "olive@test.org", address: null, gender: "Female" });
    assert.equal((await app.db.query(`SELECT username FROM patient_creds WHERE patient_id = $1`, [OLIVE])).rows[0].username, "olive@test.org");

    assert.deepEqual((await receptionist.patch(desk(OLIVE), { address: "1 Elm" })).body.error, "Phone is required");
    assert.equal((await receptionist.patch(desk(99999), { phone: "713-555-0000" })).status, 404);
    assert.equal((await receptionist.patch(desk(OLIVE), { phone: "x".repeat(21) })).status, 400);
  });

  test("a patient's email change that fails part way keeps the old email", async () => {
    const restore = await failWrites(app.db, "patient_creds", "UPDATE");
    try {
      const res = await olive.put(`/api/patient/${OLIVE}/profile`, { phone: "713-555-9100", email: "olive.half@test.org", address: null, gender: null });
      assert.equal(res.status, 400);
    } finally {
      await restore();
    }
    assert.equal((await app.db.query(`SELECT email FROM patient WHERE patient_id = $1`, [OLIVE])).rows[0].email, "olive@test.org");
  });
});

describe("emergency contacts", () => {
  test("the front desk adds contacts and only one stays primary", async () => {
    const first = await receptionist.post(desk(ids.patient, "/emergency-contacts"), contact({ firstName: "Ann", isPrimary: true }));
    assert.equal(first.status, 201);
    assert.deepEqual(Object.keys(first.body), CONTACT_KEYS);
    assert.equal(first.body.isPrimary, true);

    assert.equal((await receptionist.post(desk(ids.patient, "/emergency-contacts"), contact({ firstName: "Ben", isPrimary: true }))).status, 201);
    assert.deepEqual(await primaries(ids.patient), ["Ben"]);

    const unflagged = await receptionist.post(desk(ids.patient, "/emergency-contacts"), { ...contact({ firstName: "Cy" }), isPrimary: undefined });
    assert.deepEqual([unflagged.status, unflagged.body.isPrimary], [201, false]);

    assert.equal((await receptionist.post(desk(ids.patient, "/emergency-contacts"), contact({ relationship: "" }))).body.error, "Relationship is required");
    assert.equal((await receptionist.post(desk(99999, "/emergency-contacts"), contact())).status, 404);
  });

  test("a failed contact edit doesn't take primary off the current contact", async () => {
    const ben = (await pat.get(`/api/patient/${ids.patient}/profile`)).body.emergencyContacts.find((c: { firstName: string }) => c.firstName === "Ben");

    assert.equal((await pat.put(`/api/patient/${ids.patient}/emergency-contacts/99999`, contact({ isPrimary: true }))).status, 404);
    assert.deepEqual(await primaries(ids.patient), ["Ben"]);

    // Ben belongs to Pat, so Olive can't reach him from her own path
    assert.equal((await olive.put(`/api/patient/${OLIVE}/emergency-contacts/${ben.emergencyContactId}`, contact({ firstName: "Taken", isPrimary: true }))).status, 404);
    assert.equal((await olive.delete(`/api/patient/${OLIVE}/emergency-contacts/${ben.emergencyContactId}`)).status, 404);
    assert.deepEqual(await primaries(ids.patient), ["Ben"]);
  });

  test("contacts added at the same time still leave one primary", async () => {
    const restore = await slowWrites(app.db, "emergency_contact", "INSERT");
    try {
      const results = await Promise.all([
        receptionist.post(desk(OLIVE, "/emergency-contacts"), contact({ firstName: "Dee", isPrimary: true })),
        olive.post(`/api/patient/${OLIVE}/emergency-contacts`, contact({ firstName: "Eve", isPrimary: true })),
      ]);
      assert.deepEqual(results.map((r) => r.status), [201, 201]);
    } finally {
      await restore();
    }
    assert.equal((await primaries(OLIVE)).length, 1);
  });
});

describe("insurance", () => {
  test("patients can't verify their own insurance, and any change goes back to Pending", async () => {
    assert.equal((await olive.put(`/api/patient/${OLIVE}/insurance`, { provider: "Aetna", policyNumber: "AE-1", status: "Verified" })).status, 204);
    assert.deepEqual(await insuranceOf(OLIVE), { provider: "Aetna", policyNumber: "AE-1", status: "Pending" });

    const verified = await receptionist.patch(desk(OLIVE, "/insurance/status"), { provider: "Aetna", policyNumber: "AE-1", status: "Verified" });
    assert.deepEqual([verified.status, verified.body], [200, { provider: "Aetna", policyNumber: "AE-1", status: "Verified" }]);

    assert.equal((await olive.put(`/api/patient/${OLIVE}/insurance`, { provider: "Aetna", policyNumber: "AE-1" })).status, 204);
    assert.equal((await insuranceOf(OLIVE)).status, "Pending");

    assert.equal((await receptionist.patch(desk(OLIVE, "/insurance/status"), { provider: "Aetna", policyNumber: "AE-1", status: "Denied" })).body.status, "Denied");
    const changed = await receptionist.put(desk(OLIVE, "/insurance"), { provider: "Cigna", policyNumber: "CI-2" });
    assert.deepEqual([changed.status, changed.body], [200, { provider: "Cigna", policyNumber: "CI-2", status: "Pending" }]);
  });

  test("a policy number belongs to one patient, and only staff set the status", async () => {
    const taken = "This policy number is already registered to another patient";
    assert.deepEqual((await receptionist.put(desk(ids.patient, "/insurance"), { provider: "Cigna", policyNumber: "CI-2" })).body, { error: taken });
    assert.deepEqual((await pat.put(`/api/patient/${ids.patient}/insurance`, { provider: "Cigna", policyNumber: "CI-2" })).body, { error: taken });
    assert.equal(await insuranceOf(ids.patient), undefined);

    assert.deepEqual((await receptionist.patch(desk(ids.patient, "/insurance/status"), { provider: "Cigna", policyNumber: "CI-2", status: "Verified" })).body, { error: "This patient has no insurance on file" });
    assert.equal((await receptionist.patch(desk(OLIVE, "/insurance/status"), { provider: "Cigna", policyNumber: "CI-2", status: "Pending" })).body.error, "Status must be Verified or Denied");
    assert.equal((await receptionist.put(desk(OLIVE, "/insurance"), { policyNumber: "X-1" })).body.error, "Provider is required");
    assert.equal((await receptionist.put(desk(99999, "/insurance"), { provider: "Cigna", policyNumber: "CI-9" })).status, 404);

    for (const client of [pat, olive, nurse, doctor, admin]) {
      assert.equal((await client.patch(desk(OLIVE, "/insurance/status"), { provider: "Cigna", policyNumber: "CI-2", status: "Verified" })).status, 403);
    }
    assert.equal((await insuranceOf(OLIVE)).status, "Pending");
  });

  test("verifying only applies to the insurance details the receptionist reviewed", async () => {
    const { status: _, ...reviewed } = (await receptionist.get(desk(OLIVE))).body.insurance;
    assert.deepEqual(reviewed, { provider: "Cigna", policyNumber: "CI-2" });
    const changed = "This patient's insurance changed. Review it again before verifying.";

    assert.equal((await olive.put(`/api/patient/${OLIVE}/insurance`, { provider: "Humana", policyNumber: "HU-3" })).status, 204);
    const stale = await receptionist.patch(desk(OLIVE, "/insurance/status"), { ...reviewed, status: "Verified" });
    assert.deepEqual([stale.status, stale.body], [409, { error: changed }]);
    assert.deepEqual(await insuranceOf(OLIVE), { provider: "Humana", policyNumber: "HU-3", status: "Pending" });

    assert.equal((await receptionist.patch(desk(OLIVE, "/insurance/status"), { provider: "Humana", policyNumber: "HU-3", status: "Verified" })).status, 200);
    // a new provider with the same policy number is still a change
    assert.equal((await olive.put(`/api/patient/${OLIVE}/insurance`, { provider: "Humana Gold", policyNumber: "HU-3" })).status, 204);
    assert.equal((await receptionist.patch(desk(OLIVE, "/insurance/status"), { provider: "Humana", policyNumber: "HU-3", status: "Denied" })).status, 409);
    assert.equal((await insuranceOf(OLIVE)).status, "Pending");
    assert.equal((await receptionist.patch(desk(OLIVE, "/insurance/status"), { status: "Verified" })).body.error, "Provider is required");
  });

  test("a change still being saved isn't approved by a verification sent at the same time", async () => {
    const reviewed = { provider: "Humana Gold", policyNumber: "HU-3" };
    const change = await app.db.connect();
    let verify: Promise<{ status: number }> | undefined;
    try {
      // the patient's change holds the row while the receptionist's verification arrives
      await change.query("BEGIN");
      await change.query(`UPDATE insurance SET policy_number = 'HU-4', status = 'Pending' WHERE patient_id = $1`, [OLIVE]);
      let settled = false;
      verify = receptionist.patch(desk(OLIVE, "/insurance/status"), { ...reviewed, status: "Verified" });
      verify.then(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(settled, false);
      await change.query("COMMIT");
    } finally {
      change.release();
    }
    assert.equal((await verify).status, 409);
    assert.deepEqual(await insuranceOf(OLIVE), { provider: "Humana Gold", policyNumber: "HU-4", status: "Pending" });
  });

  test("a patient change and a verification sent together never approve the new policy", async () => {
    const reviewed = { provider: "Humana Gold", policyNumber: "HU-4" };
    const restore = await slowWrites(app.db, "insurance", "UPDATE");
    try {
      const [saved, verified] = await Promise.all([
        olive.put(`/api/patient/${OLIVE}/insurance`, { provider: "Humana Gold", policyNumber: "HU-5" }),
        receptionist.patch(desk(OLIVE, "/insurance/status"), { ...reviewed, status: "Verified" }),
      ]);
      assert.equal(saved.status, 204);
      assert.ok([200, 409].includes(verified.status), `verification answered ${verified.status}`);
    } finally {
      await restore();
    }
    assert.deepEqual(await insuranceOf(OLIVE), { provider: "Humana Gold", policyNumber: "HU-5", status: "Pending" });
  });
});

describe("front desk patient view", () => {
  test("shows the patient, their forms, newest appointments and what they owe", async () => {
    await app.db.query(`
      INSERT INTO form_type (name, is_required) VALUES ('Intake', true), ('HIPAA', true);
      INSERT INTO form_type (name, is_active) VALUES ('Old Form', false);
      INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, status, booking_channel)
      SELECT 1, 2, 1, DATE '2031-01-01' + n, 1, 1, 'Scheduled', 'Web' FROM generate_series(1, 12) n;
      INSERT INTO payment_type (name) VALUES ('Cash');
    `);
    const visits = await app.db.query(`SELECT appointment_id FROM appointment WHERE patient_id = 1 ORDER BY appointment_date LIMIT 3`);
    const [a, b, c] = visits.rows.map((r) => r.appointment_id);
    await app.db.query(
      `INSERT INTO invoice (patient_id, appointment_id, amount, status) VALUES (1, $1, 100.00, 'Pending'), (1, $2, 50.00, 'Paid'), (1, $3, 20.00, 'Overdue')`,
      [a, b, c]
    );
    await app.db.query(`INSERT INTO payment (invoice_id, payment_type_id, handled_by, amount_paid) SELECT invoice_id, 1, 4, 30.00 FROM invoice WHERE appointment_id = $1`, [a]);
    // the Paid invoice really was paid, since the balance comes from payments and not the status
    await app.db.query(`INSERT INTO payment (invoice_id, payment_type_id, handled_by, amount_paid) SELECT invoice_id, 1, 4, 50.00 FROM invoice WHERE appointment_id = $1`, [b]);

    const res = await receptionist.get(desk(ids.patient));
    assert.equal(res.status, 200);
    const { emergencyContacts, insurance, forms, appointments, balance, ...patient } = res.body;
    assert.deepEqual(patient, {
      patientId: ids.patient,
      firstName: "Pat",
      lastName: "Patient",
      dob: "1990-01-01",
      gender: null,
      phone: "713-555-9000",
      email: "pat@test.org",
      address: null,
      isActive: true,
      hasLogin: true,
    });
    assert.equal(emergencyContacts[0].firstName, "Ben");
    assert.equal(insurance, null);
    assert.deepEqual(forms.map((f: { name: string; completed: boolean }) => [f.name, f.completed]), [["Intake", false], ["HIPAA", false]]);
    assert.equal(appointments.length, 10);
    assert.equal(appointments[0].date, "2031-01-13");
    assert.deepEqual(Object.keys(appointments[0]), ["appointmentId", "date", "startTime", "endTime", "doctorName", "officeName", "specialty", "status"]);
    assert.equal(balance, "90.00");
    assert.doesNotMatch(JSON.stringify(res.body), /password|username/i);

    assert.equal((await receptionist.get(desk(OLIVE))).body.balance, "0.00");
    assert.equal((await receptionist.get("/api/receptionist/patients/abc")).status, 400);
    assert.equal((await receptionist.get(desk(99999))).status, 404);
  });

  test("a paper form is marked completed once, and only for an active form", async () => {
    const forms = await app.db.query(`SELECT form_type_id AS id, name FROM form_type ORDER BY form_type_id`);
    const formId = (name: string) => forms.rows.find((f) => f.name === name).id;
    const path = desk(ids.patient, `/forms/${formId("Intake")}/complete`);

    const done = await receptionist.post(path);
    assert.equal(done.status, 201);
    assert.deepEqual([done.body.formTypeId, done.body.status], [formId("Intake"), "Completed"]);
    assert.match(done.body.submittedDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual((await receptionist.post(path)).body, { error: "This form is already completed" });
    assert.deepEqual((await receptionist.post(desk(ids.patient, `/forms/${formId("Old Form")}/complete`))).body, { error: "Form not found" });
    assert.deepEqual((await receptionist.post(desk(99999, `/forms/${formId("HIPAA")}/complete`))).body, { error: "Patient not found" });

    const view = (await receptionist.get(desk(ids.patient))).body.forms;
    assert.deepEqual(view.map((f: { name: string; completed: boolean }) => [f.name, f.completed]), [["Intake", true], ["HIPAA", false]]);
    assert.equal(view[0].completedDate, done.body.submittedDate);
    assert.equal((await pat.get(`/api/patient/${ids.patient}/forms`)).body.find((f: { name: string }) => f.name === "Intake").status, "Completed");
  });
});

describe("privacy", () => {
  test("the patient directory is only for receptionists and shows only what they need", async () => {
    const list = await receptionist.get("/api/patients");
    assert.equal(list.status, 200);
    for (const row of list.body) {
      assert.deepEqual(Object.keys(row), DIRECTORY_KEYS);
      assert.match(row.dob, /^\d{4}-\d{2}-\d{2}$/);
    }

    for (const client of [nurse, doctor, admin]) {
      const res = await client.get("/api/patients");
      assert.deepEqual([res.status, res.body], [403, { error: "Access denied" }]);
    }
    assert.equal((await pat.get("/api/patients")).status, 401);
    assert.equal((await anonymous.get("/api/patients")).status, 401);
  });

  test("the front desk routes are for receptionists only", async () => {
    const routes: [string, string, object?][] = [
      ["GET", desk(OLIVE)],
      ["PATCH", desk(OLIVE), { phone: "713-555-0001" }],
      ["PUT", desk(OLIVE, "/insurance"), { provider: "Nope", policyNumber: "NO-1" }],
      ["POST", desk(OLIVE, "/emergency-contacts"), contact({ firstName: "Nope" })],
      ["POST", desk(OLIVE, "/forms/1/complete")],
      ["POST", desk(OLIVE, "/login"), { email: "nope@test.org", password: TEST_PASSWORD }],
    ];
    const send = (client: TestClient, method: string, path: string, body?: object) =>
      method === "GET" ? client.get(path) : method === "PATCH" ? client.patch(path, body) : method === "PUT" ? client.put(path, body) : client.post(path, body);

    for (const [method, path, body] of routes) {
      assert.equal((await send(anonymous, method, path, body)).status, 401, `${method} ${path}`);
      for (const client of [pat, olive, nurse, doctor, admin]) {
        assert.equal((await send(client, method, path, body)).status, 403, `${method} ${path}`);
      }
    }
    assert.equal((await app.db.query(`SELECT 1 FROM emergency_contact WHERE first_name = 'Nope'`)).rowCount, 0);
    assert.equal((await insuranceOf(OLIVE)).provider, "Humana Gold");
  });

  test("a patient's own profile still shows only their own record", async () => {
    const profile = await olive.get(`/api/patient/${OLIVE}/profile`);
    assert.equal(profile.body.patientId, OLIVE);
    assert.doesNotMatch(JSON.stringify(profile.body), /password|username/i);
    assert.equal((await olive.get(`/api/patient/${ids.patient}/profile`)).status, 403);
  });
});

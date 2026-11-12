import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { addEmployee, addLogin } from "./helpers/appointmentData.js";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient } from "./helpers/testApp.js";
import { TEST_PASSWORD, ids, resetDatabase } from "./helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let admin: TestClient;
let labId: number;

const INVALID = { error: "Invalid email or password" };
const SIGNUP_CONFLICT =
  "We couldn't create an account with these details. If you already have one, sign in instead. If you've visited the clinic before, the front desk can set up your portal login.";

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  admin = await app.loginStaff(ids.admin);
  // the receptionist starts without a login, and the lab technician type isn't in the fixtures
  await addLogin(app.db, ids.receptionist);
  const labType = await app.db.query(`INSERT INTO employee_types (type_name) VALUES ('Lab Technician') RETURNING employee_type_id AS id`);
  labId = await addEmployee(app.db, "Lena", labType.rows[0].id, ids.mainOffice);
});

after(() => app.close());

const login = (email: unknown, password: unknown = TEST_PASSWORD) => app.client().post("/api/auth/login", { email, password });

const attempt = async (email: string, password?: string) => {
  const res = await login(email, password);
  return [res.status, res.body];
};

// signs in through the login page's endpoint and returns that session
async function signIn(email: string) {
  const res = await login(email);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { body: res.body, session: app.client((res as typeof res & { cookie?: string }).cookie) };
}

const newEmployee = (email: string) => ({
  firstName: "Ella",
  lastName: "Example",
  dob: "1991-01-01",
  email,
  phone: "7135550111",
  employeeTypeId: 4,
  officeId: ids.mainOffice,
});

const newPatient = (email: string, firstName = "Sam") => ({
  firstName,
  lastName: "Signup",
  dob: "1993-03-03",
  phone: "7135550222",
  email,
  password: TEST_PASSWORD,
});

// waits until this many requests are stuck behind an advisory lock the test holds
async function waitForAdvisoryWaits(count: number) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await app.db.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`
    );
    if (rows[0].n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Fewer than ${count} requests waited for the email lock`);
}

const contactChange =(email: string) => ({ phone: "7135559000", address: null, gender: null, email });

describe("one login for patients and staff", () => {
  test("every account type signs in with its email and gets its own role, the same as after a refresh", async () => {
    const accounts = [
      ["pat@test.org", { role: "patient", id: ids.patient }],
      ["ada@test.org", { role: "admin", id: ids.admin, staffType: "admin" }],
      ["dan@test.org", { role: "doctor", id: ids.doctor, staffType: "doctor" }],
      ["nina@test.org", { role: "staff", id: ids.nurse, staffType: "nurse" }],
      ["rita@test.org", { role: "staff", id: ids.receptionist, staffType: "receptionist" }],
    ] as const;
    for (const [email, expected] of accounts) {
      const { body, session } = await signIn(email);
      assert.equal(body.role, expected.role, email);
      assert.equal(body.id, expected.id, email);
      if ("staffType" in expected) assert.equal(body.staffType, expected.staffType, email);
      assert.equal(body.passwordHash, undefined);
      assert.deepEqual((await session.get("/api/auth/me")).body, body);
    }

    const lab = await signIn((await app.db.query(`SELECT email FROM employee WHERE employee_id = $1`, [labId])).rows[0].email);
    assert.deepEqual([lab.body.role, lab.body.staffType, lab.body.id], ["lab", "lab", labId]);
  });

  test("the email ignores capital letters and spaces around it", async () => {
    assert.equal((await signIn(" PAT@Test.org ")).body.role, "patient");
    assert.equal((await signIn("DAN@TEST.ORG")).body.role, "doctor");
  });

  test("a wrong password or an unknown email gets the same answer, and bad input is rejected", async () => {
    for (const email of ["pat@test.org", "ada@test.org", "nobody@test.org"]) {
      assert.deepEqual(await attempt(email, "Wrong-Password-1"), [401, INVALID], email);
    }
    assert.equal((await login("not-an-email")).status, 400);
    assert.equal((await login("pat@test.org", "")).status, 400);
    // a patient number or staff ID on its own isn't a login anymore
    assert.equal((await app.client().post("/api/auth/login", { patientId: ids.patient, password: TEST_PASSWORD })).status, 400);
    assert.equal((await app.client().post("/api/auth/login", { employeeId: ids.doctor, password: TEST_PASSWORD })).status, 400);
  });

  test("inactive accounts, disabled logins and employees without a login can't sign in", async () => {
    const cases = [
      ["pat@test.org", `UPDATE patient SET is_active = $1 WHERE patient_id = ${ids.patient}`],
      ["pat@test.org", `UPDATE patient_creds SET is_active = $1 WHERE patient_id = ${ids.patient}`],
      ["dan@test.org", `UPDATE employee SET is_active = $1 WHERE employee_id = ${ids.doctor}`],
      ["dan@test.org", `UPDATE employee_creds SET is_active = $1 WHERE employee_id = ${ids.doctor}`],
    ];
    for (const [email, toggle] of cases) {
      await app.db.query(toggle, [false]);
      assert.deepEqual(await attempt(email), [401, INVALID], toggle);
      await app.db.query(toggle, [true]);
      assert.equal((await login(email)).status, 200, toggle);
    }

    const noLogin = await addEmployee(app.db, "Nolan", 4, ids.mainOffice);
    await app.db.query(`DELETE FROM employee_creds WHERE employee_id = $1`, [noLogin]);
    const email = (await app.db.query(`SELECT email FROM employee WHERE employee_id = $1`, [noLogin])).rows[0].email;
    assert.deepEqual(await attempt(email), [401, INVALID]);
  });

  test("an email on two logins is refused, and only a correct password says why", async () => {
    // older data could have this, since the database itself doesn't stop it
    const patient = await app.db.query(
      `INSERT INTO patient (first_name, last_name, dob, phone, email) VALUES ('Shay', 'Shared', '1985-05-05', '7135550333', 'shared@test.org') RETURNING patient_id AS id`
    );
    await app.db.query(`INSERT INTO patient_creds (patient_id, username, password_hash) SELECT $1, 'shared@test.org', password_hash FROM employee_creds WHERE employee_id = $2`, [
      patient.rows[0].id,
      ids.admin,
    ]);
    const employee = await addEmployee(app.db, "Shawn", 4, ids.mainOffice);
    await app.db.query(`UPDATE employee SET email = 'shared@test.org' WHERE employee_id = $1`, [employee]);

    assert.deepEqual(await attempt("shared@test.org", "Wrong-Password-1"), [401, INVALID]);
    const refused = await login("SHARED@test.org");
    assert.deepEqual([refused.status, refused.body.error], [409, "This email belongs to more than one account. Please call your clinic office."]);
    assert.equal((refused as typeof refused & { cookie?: string }).cookie, undefined);

    // turning one of them off doesn't make the other one the owner
    await app.db.query(`UPDATE employee SET is_active = false WHERE employee_id = $1`, [employee]);
    assert.equal((await login("shared@test.org")).status, 409);
  });

  test("logging out ends the session and the same email signs in again", async () => {
    const { session } = await signIn("nina@test.org");
    assert.equal((await session.get("/api/auth/me")).status, 200);
    assert.equal((await session.post("/api/auth/logout")).status, 204);
    assert.equal((await session.get("/api/auth/me")).status, 401);
    assert.equal((await signIn("nina@test.org")).body.role, "staff");
  });

  test("a session from the shared login keeps each role's permissions", async () => {
    const patient = (await signIn("pat@test.org")).session;
    assert.equal((await patient.get(`/api/patient/${ids.patient}/profile`)).status, 200);
    assert.equal((await patient.get(`/api/patient/${ids.patient + 1}/profile`)).status, 403);
    assert.equal((await patient.get("/api/admin/offices")).status, 403);

    const doctor = (await signIn("dan@test.org")).session;
    assert.equal((await doctor.get("/api/doctor/referrals")).status, 200);
    assert.equal((await doctor.get("/api/admin/offices")).status, 403);
    assert.equal((await doctor.get(`/api/patient/${ids.patient}/profile`)).status, 401);

    const nurse = (await signIn("nina@test.org")).session;
    assert.equal((await nurse.get("/api/receptionist/patients")).status, 403);

    assert.equal((await (await signIn("ada@test.org")).session.get("/api/admin/offices")).status, 200);
  });
});

describe("one email per account", () => {
  test("sign up refuses an email that an employee or another patient uses, ignoring case and spaces", async () => {
    const before = (await app.db.query(`SELECT count(*)::int AS n FROM patient`)).rows[0].n;
    for (const email of [" ADA@Test.org ", "PAT@test.org"]) {
      const res = await app.client().post("/api/auth/patient/signup", newPatient(email));
      assert.deepEqual([res.status, res.body.error], [409, SIGNUP_CONFLICT], email);
    }
    assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM patient`)).rows[0].n, before);
  });

  test("an employee can't get an email that a patient signs in with or another employee has", async () => {
    const created = await admin.post("/api/admin/employees", newEmployee(" Pat@Test.org "));
    assert.deepEqual([created.status, created.body.error], [409, "A patient login already uses that email"]);
    const staff = await admin.post("/api/admin/staff", { ...newEmployee("pat@test.org"), password: TEST_PASSWORD });
    assert.deepEqual([staff.status, staff.body.error], [409, "A patient login already uses that email"]);
    const duplicate = await admin.post("/api/admin/employees", newEmployee(" DAN@test.org"));
    assert.deepEqual([duplicate.status, duplicate.body.error], [409, "Another employee already uses that email"]);

    const moved = await admin.put(`/api/admin/staff/${ids.receptionist}`, { firstName: "Rita", lastName: "Reception", phone: "7135551003", email: "PAT@test.org", officeId: 2 });
    assert.deepEqual([moved.status, moved.body.error], [409, "A patient login already uses that email"]);
    assert.equal((await app.db.query(`SELECT email FROM employee WHERE employee_id = $1`, [ids.receptionist])).rows[0].email, "rita@test.org");

    const fine = await admin.post("/api/admin/employees", newEmployee(" Ella.New@Test.org "));
    assert.deepEqual([fine.status, fine.body.email], [201, "ella.new@test.org"]);
  });

  test("patients can't move their login to an email someone else uses", async () => {
    const patient = (await signIn("pat@test.org")).session;
    for (const email of ["dan@test.org", "ella.new@test.org"]) {
      const res = await patient.put(`/api/patient/${ids.patient}/profile`, contactChange(email));
      assert.deepEqual([res.status, res.body.error], [409, "This email is already used by another account"], email);
    }
    assert.equal((await app.db.query(`SELECT username FROM patient_creds WHERE patient_id = $1`, [ids.patient])).rows[0].username, "pat@test.org");
  });

  test("the front desk can't set up a portal login with an employee's email", async () => {
    const receptionist = (await signIn("rita@test.org")).session;
    const patientId = (await app.db.query(`INSERT INTO patient (first_name, last_name, dob, phone) VALUES ('Fay', 'Frontdesk', '1970-07-07', '7135550444') RETURNING patient_id AS id`)).rows[0].id;
    const res = await receptionist.post(`/api/receptionist/patients/${patientId}/login`, { email: "Nina@test.org", password: TEST_PASSWORD });
    assert.deepEqual([res.status, res.body.error], [409, "This email is already used by another account"]);
    assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM patient_creds WHERE patient_id = $1`, [patientId])).rows[0].n, 0);
  });

  test("an inactive account's email stays taken, so turning it back on can't create a clash", async () => {
    const employee = await addEmployee(app.db, "Ivy", 4, ids.mainOffice);
    await app.db.query(`UPDATE employee SET is_active = false, email = 'ivy.inactive@test.org' WHERE employee_id = $1`, [employee]);
    const signup = await app.client().post("/api/auth/patient/signup", newPatient("ivy.inactive@test.org", "Ivy"));
    assert.deepEqual([signup.status, signup.body.error], [409, SIGNUP_CONFLICT]);

    await app.db.query(`UPDATE patient SET is_active = false WHERE patient_id = $1`, [ids.patient]);
    await app.db.query(`UPDATE patient_creds SET is_active = false WHERE patient_id = $1`, [ids.patient]);
    const created = await admin.post("/api/admin/employees", newEmployee("pat@test.org"));
    assert.deepEqual([created.status, created.body.error], [409, "A patient login already uses that email"]);
    await app.db.query(`UPDATE patient SET is_active = true WHERE patient_id = $1`, [ids.patient]);
    await app.db.query(`UPDATE patient_creds SET is_active = true WHERE patient_id = $1`, [ids.patient]);
  });

  test("keeping your own email always saves, even when older data shares it", async () => {
    const patient = (await signIn("pat@test.org")).session;
    const own = await patient.put(`/api/patient/${ids.patient}/profile`, contactChange(" PAT@Test.org "));
    assert.equal(own.status, 204, JSON.stringify(own.body));

    const sameEmployee = await admin.put(`/api/admin/staff/${ids.receptionist}`, { firstName: "Rita", lastName: "Reception", phone: "7135551003", email: "RITA@test.org", officeId: 2 });
    assert.equal(sameEmployee.status, 200, JSON.stringify(sameEmployee.body));

    // shared@test.org is on both a patient login and an employee from the earlier test
    const shared = await app.db.query(`SELECT employee_id AS id FROM employee WHERE email = 'shared@test.org'`);
    const keep = await admin.put(`/api/admin/staff/${shared.rows[0].id}`, { firstName: "Shawn", lastName: "Kept", phone: "7135550555", email: "shared@test.org", officeId: ids.mainOffice });
    assert.equal(keep.status, 200, JSON.stringify(keep.body));
  });

  test("a sign up and a new employee with one email at the same time leave one owner", async () => {
    const email = "race@test.org";
    const holder = await app.db.connect();
    let requests: Promise<{ status: number }[]> | null = null;
    try {
      // the test holds the email's lock first, so both requests have to wait in line behind it
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('login email'), hashtext($1))`, [email]);
      requests = Promise.all([app.client().post("/api/auth/patient/signup", newPatient(email, "Ray")), admin.post("/api/admin/employees", newEmployee(email))]);
      await waitForAdvisoryWaits(2);
      await holder.query("COMMIT");
    } catch (err) {
      await holder.query("ROLLBACK");
      throw err;
    } finally {
      holder.release();
    }

    assert.ok(requests);
    const results = await requests;
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const owners = await app.db.query(
      `SELECT (SELECT count(*) FROM patient_creds WHERE username = $1) + (SELECT count(*) FROM employee WHERE email = $1) AS n`,
      [email]
    );
    assert.equal(Number(owners.rows[0].n), 1);
  });
});

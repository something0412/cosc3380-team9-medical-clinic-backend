import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SIGNUP_CONFLICT } from "../src/services/patients.js";
import { failWrites, slowWrites } from "./helpers/dbFaults.js";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient, TestResponse } from "./helpers/testApp.js";
import { TEST_PASSWORD, ids, resetDatabase } from "./helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let admin: TestClient, receptionist: TestClient, nurse: TestClient, doctor: TestClient;

const REGISTERED_KEYS = ["patientId", "firstName", "lastName", "dob", "gender", "phone", "email", "address", "isActive"];
const DIRECTORY_KEYS = ["patientId", "firstName", "lastName", "dob", "isActive"];

let counter = 0;

// someone new each time, with their own email
function person(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return { firstName: "Reg", lastName: `Tester${counter}`, dob: "1991-03-03", phone: "713-555-6000", email: `reg${counter}@test.org`, ...overrides };
}

const signUp = (body: object) => app.client().post("/api/auth/patient/signup", { password: TEST_PASSWORD, ...body });
const register = (body: object) => receptionist.post("/api/patients", body);
const createLogin = (client: TestClient, patientId: number, email: string, password = TEST_PASSWORD) =>
  client.post(`/api/receptionist/patients/${patientId}/login`, { email, password });

async function count(sql: string, params: unknown[] = []) {
  return Number((await app.db.query(sql, params)).rows[0].count);
}
const patientCount = () => count(`SELECT count(*) FROM patient`);
const sameIdentity = (firstName: string, lastName: string, dob: string) =>
  count(`SELECT count(*) FROM patient WHERE lower(first_name) = lower($1) AND lower(last_name) = lower($2) AND dob = $3`, [firstName, lastName, dob]);
const loginCount = (patientId: number) => count(`SELECT count(*) FROM patient_creds WHERE patient_id = $1`, [patientId]);
const statuses = (responses: TestResponse[]) => responses.map((r) => r.status).sort();

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  admin = await app.loginStaff(ids.admin);
  assert.equal((await admin.post(`/api/admin/employees/${ids.receptionist}/login`, { username: "rita.reg", password: TEST_PASSWORD })).status, 201);
  receptionist = await app.loginStaff(ids.receptionist);
  nurse = await app.loginStaff(ids.nurse);
  doctor = await app.loginStaff(ids.doctor);
});

after(() => app.close());

describe("online sign up", () => {
  test("creates the patient and their login together and signs them in", async () => {
    const res = await signUp(person({ firstName: "  Rena ", email: "Rena.Upper@Test.org" }));
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body).sort(), ["email", "firstName", "lastName", "patientId"]);
    assert.equal(res.body.firstName, "Rena");
    assert.equal(res.body.email, "rena.upper@test.org");

    const session = app.client((res as TestResponse & { cookie?: string }).cookie);
    assert.deepEqual((await session.get("/api/auth/me")).body, { role: "patient", id: res.body.patientId, firstName: "Rena", lastName: res.body.lastName });

    const creds = await app.db.query(`SELECT username, password_hash FROM patient_creds WHERE patient_id = $1`, [res.body.patientId]);
    assert.equal(creds.rows[0].username, "rena.upper@test.org");
    assert.notEqual(creds.rows[0].password_hash, TEST_PASSWORD);
    await app.loginPatient(res.body.patientId, "rena.upper@test.org");
  });

  test("uses the same validation rules as the front desk", async () => {
    const before = await patientCount();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ firstName: " " }, /First name is required/],
      [{ lastName: undefined }, /Last name is required/],
      [{ phone: "" }, /Phone is required/],
      [{ dob: "2999-01-01" }, /Date of birth can't be in the future/],
      [{ dob: "1899-12-31" }, /before 1900/],
      [{ dob: "2020-02-30" }, /Date of birth must be a valid date/],
      [{ firstName: "x".repeat(51) }, /50 characters or less/],
    ];
    for (const [change, message] of cases) {
      const online = await signUp(person(change));
      assert.equal(online.status, 400, JSON.stringify(change));
      assert.match(online.body.error, message);
      const desk = await register(person(change));
      assert.equal(desk.status, 400, JSON.stringify(change));
      assert.equal(desk.body.error, online.body.error);
    }

    assert.equal((await signUp(person({ email: "not-an-email" }))).status, 400);
    assert.equal((await signUp(person({ email: `${"x".repeat(45)}@test.org` }))).status, 400);
    assert.match((await signUp({ ...person(), password: "short" })).body.error, /at least 8 characters/);
    assert.equal(await patientCount(), before);
  });
});

describe("front desk registration", () => {
  test("saves the patient with blank optional fields as null", async () => {
    const res = await register({ ...person({ email: "", gender: " ", address: "" }), insuranceProvider: "ignored" });
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body).sort(), [...REGISTERED_KEYS].sort());
    assert.deepEqual([res.body.dob, res.body.email, res.body.gender, res.body.address, res.body.isActive], ["1991-03-03", null, null, null, true]);
    assert.equal(await loginCount(res.body.patientId), 0);
  });

  test("a likely match comes back first, and a different person can still be added", async () => {
    const walter = await register(person({ firstName: "Walter", lastName: "Walkin", dob: "1970-07-07", email: "walkin.family@test.org" }));
    assert.equal(walter.status, 201);

    const again = await register(person({ firstName: " walter ", lastName: "WALKIN", dob: "1970-07-07" }));
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already registered/);
    assert.deepEqual(again.body.matches, [
      { patientId: walter.body.patientId, firstName: "Walter", lastName: "Walkin", dob: "1970-07-07", isActive: true },
    ]);
    assert.deepEqual(Object.keys(again.body.matches[0]), DIRECTORY_KEYS);

    const confirmed = await register({ ...person({ firstName: "Walter", lastName: "Walkin", dob: "1970-07-07" }), confirmedNewPatient: true });
    assert.equal(confirmed.status, 201);
    assert.notEqual(confirmed.body.patientId, walter.body.patientId);
    assert.equal(await sameIdentity("Walter", "Walkin", "1970-07-07"), 2);
  });

  test("family members can share one email", async () => {
    const shared = "smith.family@test.org";
    const sara = await register(person({ firstName: "Sara", lastName: "Smith", dob: "2010-01-01", email: shared }));
    const sid = await register(person({ firstName: "Sid", lastName: "Smith", dob: "2012-02-02", email: shared }));
    assert.deepEqual([sara.status, sid.status], [201, 201]);

    // nobody has a login with the family email yet, so one family member can sign up with it
    assert.equal((await signUp(person({ firstName: "Sam", lastName: "Smith", dob: "1980-03-03", email: shared }))).status, 201);
    // a login email belongs to one account, so the next one needs their own
    const sue = await signUp(person({ firstName: "Sue", lastName: "Smith", dob: "1982-04-04", email: shared }));
    assert.deepEqual([sue.status, sue.body], [409, { error: SIGNUP_CONFLICT }]);
    assert.equal((await createLogin(receptionist, sara.body.patientId, "sara.smith@test.org")).status, 201);
    assert.equal((await app.db.query(`SELECT email FROM patient WHERE patient_id = $1`, [sid.body.patientId])).rows[0].email, shared);
  });
});

describe("existing records and sign up", () => {
  test("a front desk record without a login can't be taken over by signing up online", async () => {
    const wanda = await register(person({ firstName: "Wanda", lastName: "Walkin", dob: "1965-05-05", email: "wanda.home@test.org" }));
    const before = await patientCount();

    const res = await signUp(person({ firstName: "wanda", lastName: " Walkin ", dob: "1965-05-05", email: "wanda@test.org" }));
    assert.deepEqual([res.status, res.body], [409, { error: SIGNUP_CONFLICT }]);
    assert.equal(await patientCount(), before);
    assert.equal(await loginCount(wanda.body.patientId), 0);
    assert.equal((await app.db.query(`SELECT email FROM patient WHERE patient_id = $1`, [wanda.body.patientId])).rows[0].email, "wanda.home@test.org");

    // a different birthday is a different person
    assert.equal((await signUp(person({ firstName: "Wanda", lastName: "Walkin", dob: "1966-06-06" }))).status, 201);
  });

  test("a taken email and a likely existing record get the same answer", async () => {
    const before = await patientCount();
    const takenEmail = await signUp(person({ email: "pat@test.org" }));
    const samePerson = await signUp(person({ firstName: "Pat", lastName: "Patient", dob: "1990-01-01" }));
    for (const res of [takenEmail, samePerson]) {
      assert.equal(res.status, 409);
      assert.deepEqual(res.body, { error: SIGNUP_CONFLICT });
    }
    assert.equal(await patientCount(), before);
  });
});

describe("portal login for an existing patient", () => {
  test("the front desk sets up a login and the patient keeps their patient ID", async () => {
    const walkIn = await register(person({ firstName: "Wendy", email: "" }));
    const before = await patientCount();

    const res = await createLogin(receptionist, walkIn.body.patientId, "Wendy@Test.org");
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { patientId: walkIn.body.patientId, email: "wendy@test.org" });

    const wendy = await app.loginPatient(walkIn.body.patientId, "wendy@test.org");
    assert.equal((await wendy.get("/api/auth/me")).body.id, walkIn.body.patientId);
    assert.equal((await wendy.get(`/api/patient/${walkIn.body.patientId}/profile`)).body.email, "wendy@test.org");
    const creds = await app.db.query(`SELECT password_hash FROM patient_creds WHERE patient_id = $1`, [walkIn.body.patientId]);
    assert.notEqual(creds.rows[0].password_hash, TEST_PASSWORD);
    assert.equal(await patientCount(), before);

    const twice = await createLogin(receptionist, walkIn.body.patientId, "wendy.two@test.org");
    assert.deepEqual([twice.status, twice.body.error], [409, "This patient already has a portal login"]);
    assert.equal(await loginCount(walkIn.body.patientId), 1);
  });

  test("the patient has to exist, be active, and use an email no other login has", async () => {
    const walkIn = await register(person({ email: "" }));
    const id = walkIn.body.patientId;

    assert.equal((await createLogin(receptionist, 99999, "nobody@test.org")).status, 404);
    assert.deepEqual((await createLogin(receptionist, id, "pat@test.org")).body, { error: "This email is already used by another account" });
    assert.equal((await createLogin(receptionist, id, "short@test.org", "short")).status, 400);
    assert.equal((await createLogin(receptionist, id, "not-an-email")).status, 400);

    assert.equal((await admin.patch(`/api/admin/patients/${id}/status`, { isActive: false })).status, 200);
    const inactive = await createLogin(receptionist, id, "inactive@test.org");
    assert.deepEqual([inactive.status, inactive.body.error], [409, "This patient account is inactive"]);
    assert.equal(await loginCount(id), 0);

    assert.equal((await admin.patch(`/api/admin/patients/${id}/status`, { isActive: true })).status, 200);
    assert.equal((await createLogin(receptionist, id, "active.again@test.org")).status, 201);
  });

  test("only receptionists set up logins, and there's no public way to claim a record", async () => {
    const walkIn = await register(person({ email: "" }));
    const id = walkIn.body.patientId;

    assert.equal((await createLogin(app.client(), id, "claim@test.org")).status, 401);
    for (const client of [await app.loginPatient(ids.patient, "pat@test.org"), nurse, doctor, admin]) {
      assert.equal((await createLogin(client, id, "claim@test.org")).status, 403);
    }
    for (const path of ["/api/auth/patient/claim", "/api/public/patients/claim", `/api/patients/${id}/login`]) {
      const res = await app.client().post(path, { patientId: id, email: "claim@test.org", password: TEST_PASSWORD });
      assert.ok([401, 404].includes(res.status), `${path} answered ${res.status}`);
    }
    assert.equal(await loginCount(id), 0);
  });
});

describe("requests at the same time", () => {
  test("sign ups for the same person create one record", async () => {
    const restore = await slowWrites(app.db, "patient", "INSERT");
    try {
      const same = { firstName: "Tess", lastName: "Twice", dob: "1993-09-09" };
      const results = await Promise.all([1, 2, 3].map(() => signUp(person(same))));
      assert.deepEqual(statuses(results), [201, 409, 409]);
      assert.equal(await sameIdentity("Tess", "Twice", "1993-09-09"), 1);
    } finally {
      await restore();
    }
  });

  test("a front desk registration and an online sign up for the same person create one record", async () => {
    const restore = await slowWrites(app.db, "patient", "INSERT");
    try {
      const same = { firstName: "Dora", lastName: "Double", dob: "1977-07-17" };
      const results = await Promise.all([register(person(same)), signUp(person(same))]);
      assert.deepEqual(statuses(results), [201, 409]);
      assert.equal(await sameIdentity("Dora", "Double", "1977-07-17"), 1);
    } finally {
      await restore();
    }
  });

  test("two sign ups with one email leave one login and no extra record", async () => {
    const restore = await slowWrites(app.db, "patient", "INSERT");
    try {
      const before = await patientCount();
      const results = await Promise.all([signUp(person({ email: "race@test.org" })), signUp(person({ email: "race@test.org" }))]);
      assert.deepEqual(statuses(results), [201, 409]);
      assert.equal(await patientCount(), before + 1);
      assert.equal(await count(`SELECT count(*) FROM patient_creds WHERE username = 'race@test.org'`), 1);
    } finally {
      await restore();
    }
  });

  test("two logins set up for one patient at once leave one login", async () => {
    const walkIn = await register(person({ email: "" }));
    const restore = await slowWrites(app.db, "patient_creds", "INSERT");
    try {
      const results = await Promise.all([
        createLogin(receptionist, walkIn.body.patientId, "first.click@test.org"),
        createLogin(receptionist, walkIn.body.patientId, "second.click@test.org"),
      ]);
      assert.deepEqual(statuses(results), [201, 409]);
      assert.equal(await loginCount(walkIn.body.patientId), 1);
    } finally {
      await restore();
    }
  });
});

describe("failures part way through", () => {
  test("a sign up whose login can't be saved leaves no patient behind", async () => {
    const before = await patientCount();
    const body = person({ firstName: "Rollo" });
    const restore = await failWrites(app.db, "patient_creds", "INSERT");
    try {
      assert.equal((await signUp(body)).status, 400);
    } finally {
      await restore();
    }
    assert.equal(await patientCount(), before);
    assert.equal((await signUp(body)).status, 201);
  });

  test("a login setup that fails part way leaves no login behind", async () => {
    const walkIn = await register(person({ email: "" }));
    const restore = await failWrites(app.db, "patient", "UPDATE");
    try {
      assert.equal((await createLogin(receptionist, walkIn.body.patientId, "halfway@test.org")).status, 400);
    } finally {
      await restore();
    }
    assert.equal(await loginCount(walkIn.body.patientId), 0);
    assert.equal((await app.db.query(`SELECT email FROM patient WHERE patient_id = $1`, [walkIn.body.patientId])).rows[0].email, null);
    assert.equal((await createLogin(receptionist, walkIn.body.patientId, "halfway@test.org")).status, 201);
  });
});

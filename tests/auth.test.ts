import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient } from "./helpers/testApp.js";
import { ids, resetDatabase } from "./helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let admin: TestClient;

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  admin = await app.loginStaff(ids.admin);
});

after(() => app.close());

// every Admin endpoint, with a body that would succeed if authorization were missing
const ADMIN_ENDPOINTS: [string, string, unknown?][] = [
  ["GET", "/api/admin/employee-types"],
  ["GET", "/api/admin/employees"],
  ["GET", "/api/admin/employees/1"],
  ["POST", "/api/admin/employees", { firstName: "No", lastName: "Access", dob: "1990-01-01", email: "no@test.org", phone: "1", employeeTypeId: 4, officeId: 1 }],
  ["PUT", "/api/admin/employees/4", { firstName: "Changed", lastName: "Name", dob: "1990-07-07", email: "rita@test.org", phone: "1", employeeTypeId: 4, officeId: 2 }],
  ["PATCH", "/api/admin/employees/4/status", { isActive: false }],
  ["PATCH", "/api/admin/employees/2/login-status", { loginActive: false }],
  ["PUT", "/api/admin/employees/2/password", { password: "Changed-Pass-1" }],
  ["POST", "/api/admin/employees/4/login", { username: "rita.login", password: "Rita-Pass-123" }],
  ["GET", "/api/admin/offices"],
  ["GET", "/api/admin/offices/1"],
  ["POST", "/api/admin/offices", { name: "New", street: "1 St", city: "Austin", state: "TX", zip: "78701", phone: "512-555-0100" }],
  ["PUT", "/api/admin/offices/2", { name: "Changed", street: "1 St", city: "Austin", state: "TX", zip: "78701", phone: "512-555-0100" }],
  ["PATCH", "/api/admin/offices/3/status", { isActive: true }],
  ["GET", "/api/admin/specialties"],
  ["GET", "/api/admin/specialties/1"],
  ["POST", "/api/admin/specialties", { name: "Dermatology", requiresReferral: true }],
  ["PUT", "/api/admin/specialties/1", { name: "Changed", requiresReferral: true }],
  ["PATCH", "/api/admin/specialties/3/status", { isActive: true }],
  ["GET", "/api/admin/schedules"],
  ["GET", "/api/admin/schedules/doctor-options"],
  ["GET", "/api/admin/schedules/2/Monday"],
  ["POST", "/api/admin/schedules", { doctorId: 2, dayOfWeek: "Friday", officeId: 1, specialtyId: 1, shiftTypeId: 1 }],
  ["PUT", "/api/admin/schedules/2/Monday", { officeId: 2, specialtyId: 1, shiftTypeId: 1 }],
  ["PATCH", "/api/admin/schedules/2/Monday/status", { isActive: false }],
  ["GET", "/api/admin/shift-types"],
  ["POST", "/api/admin/shift-types", { name: "Night", startTime: "18:00", endTime: "22:00" }],
  ["PUT", "/api/admin/shift-types/1", { name: "Changed", startTime: "08:00", endTime: "12:00" }],
  ["PATCH", "/api/admin/shift-types/1/status", { isActive: false }],
  ["POST", "/api/admin/shift-types/1/time-slots", { startTime: "08:00", endTime: "08:30" }],
];

async function request(client: TestClient, method: string, path: string, body?: unknown) {
  if (method === "GET") return client.get(path);
  return client[method.toLowerCase() as "post" | "put" | "patch"](path, body);
}

// fingerprint of the data the Admin endpoints can change
async function dataSnapshot() {
  const tables = ["employee", "employee_creds", "office", "specialty", "doctor_schedule", "shift_type", "time_slot"];
  const rows = await Promise.all(tables.map((t) => app.db.query(`SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS hash FROM ${t} t`)));
  return rows.map((r) => r.rows[0].hash).join();
}

describe("staff login", () => {
  test("valid credentials start a session with the mapped role", async () => {
    const roles = [
      [ids.admin, "admin"],
      [ids.doctor, "doctor"],
      [ids.nurse, "staff"],
    ] as const;
    for (const [employeeId, role] of roles) {
      const client = await app.loginStaff(employeeId);
      const me = await client.get("/api/auth/me");
      assert.equal(me.status, 200);
      assert.equal(me.body.role, role);
      assert.equal(me.body.id, employeeId);
    }
  });

  test("login response never includes the password hash", async () => {
    const res = await app.client().post("/api/auth/staff/login", { employeeId: ids.admin, password: "Test-Password-123" });
    assert.equal(res.status, 200);
    assert.equal(res.body.passwordHash, undefined);
    assert.equal(res.body.role, "admin");
  });

  test("wrong password, unknown employee, and bad input are rejected", async () => {
    assert.equal(await app.staffLoginStatus(ids.admin, "wrong-password"), 401);
    assert.equal(await app.staffLoginStatus(99999), 401);
    const bad = await app.client().post("/api/auth/staff/login", { employeeId: "abc", password: "x" });
    assert.equal(bad.status, 400);
  });

  test("inactive employees can't log in", async () => {
    await app.db.query("UPDATE employee SET is_active = false WHERE employee_id = $1", [ids.nurse]);
    try {
      assert.equal(await app.staffLoginStatus(ids.nurse), 401);
    } finally {
      await app.db.query("UPDATE employee SET is_active = true WHERE employee_id = $1", [ids.nurse]);
    }
    assert.equal(await app.staffLoginStatus(ids.nurse), 200);
  });

  test("disabled credentials can't log in", async () => {
    await app.db.query("UPDATE employee_creds SET is_active = false WHERE employee_id = $1", [ids.nurse]);
    try {
      assert.equal(await app.staffLoginStatus(ids.nurse), 401);
    } finally {
      await app.db.query("UPDATE employee_creds SET is_active = true WHERE employee_id = $1", [ids.nurse]);
    }
  });

  test("logout ends the session", async () => {
    const client = await app.loginStaff(ids.admin);
    assert.equal((await client.get("/api/auth/me")).status, 200);
    assert.equal((await client.post("/api/auth/logout")).status, 204);
    assert.equal((await client.get("/api/auth/me")).status, 401);
    assert.equal((await client.get("/api/admin/employees")).status, 401);
  });

  test("patients log in with their own role", async () => {
    const patient = await app.loginPatient(ids.patient, "pat@test.org");
    const me = await patient.get("/api/auth/me");
    assert.equal(me.body.role, "patient");
  });
});

describe("Admin authorization", () => {
  test("every Admin endpoint requires a session", async () => {
    const before = await dataSnapshot();
    for (const [method, path, body] of ADMIN_ENDPOINTS) {
      const res = await request(app.client(), method, path, body);
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    assert.equal(await dataSnapshot(), before);
  });

  test("patients, doctors, nurses, and receptionists get 403 and change nothing", async () => {
    // give the receptionist a login through the Admin API so every staff type is covered
    assert.equal((await admin.post(`/api/admin/employees/${ids.receptionist}/login`, { username: "rita.auth", password: "Test-Password-123" })).status, 201);

    const others = [
      await app.loginPatient(ids.patient, "pat@test.org"),
      await app.loginStaff(ids.doctor),
      await app.loginStaff(ids.nurse),
      await app.loginStaff(ids.receptionist),
    ];
    const before = await dataSnapshot();
    for (const client of others) {
      for (const [method, path, body] of ADMIN_ENDPOINTS) {
        const res = await request(client, method, path, body);
        assert.equal(res.status, 403, `${method} ${path}`);
      }
    }
    assert.equal(await dataSnapshot(), before);
  });

  test("Administrators can read every Admin list", async () => {
    for (const [method, path] of ADMIN_ENDPOINTS.filter(([method]) => method === "GET")) {
      const res = await request(admin, method, path);
      assert.equal(res.status, 200, `${method} ${path}`);
    }
  });

  test("unknown Admin paths stay protected", async () => {
    assert.equal((await app.client().get("/api/admin/nothing-here")).status, 401);
    assert.equal((await admin.get("/api/admin/nothing-here")).status, 404);
  });
});

describe("existing role checks", () => {
  test("staff profile is limited to the logged-in employee", async () => {
    assert.equal((await admin.get(`/api/staff/${ids.admin}/profile`)).status, 200);
    assert.equal((await admin.get(`/api/staff/${ids.doctor}/profile`)).status, 403);
  });

  test("patient routes reject staff, and staff routes reject patients", async () => {
    const patient = await app.loginPatient(ids.patient, "pat@test.org");
    assert.equal((await admin.get(`/api/patient/${ids.patient}/billing`)).status, 401);
    assert.equal((await patient.get(`/api/patient/${ids.patient}/billing`)).status, 200);
    assert.equal((await patient.get("/api/patients")).status, 401);
    // the patient directory is only for receptionists
    assert.equal((await admin.get("/api/patients")).status, 403);
  });
});

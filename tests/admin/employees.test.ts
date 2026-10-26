import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { verifyPassword } from "../../src/lib/password.js";
import { startTestApp } from "../helpers/testApp.js";
import type { TestClient } from "../helpers/testApp.js";
import { ids, resetDatabase } from "../helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let admin: TestClient;
let emailCount = 0;

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  admin = await app.loginStaff(ids.admin);
});

after(() => app.close());

// a valid receptionist with a unique email
function receptionist(overrides: object = {}) {
  emailCount += 1;
  return {
    firstName: "Test",
    lastName: "Person",
    dob: "1990-02-02",
    email: `person${emailCount}@test.org`,
    phone: "713-555-2000",
    employeeTypeId: 4,
    officeId: ids.mainOffice,
    ...overrides,
  };
}

function doctorDetails(overrides: object = {}) {
  return {
    licenseNumber: `TX-${emailCount}`,
    licenseState: "TX",
    licenseExpiration: "2030-01-01",
    npiNumber: String(3000000000 + emailCount),
    specialtyIds: [ids.familyMedicine],
    primarySpecialtyId: ids.familyMedicine,
    ...overrides,
  };
}

async function createEmployee(body: object) {
  const res = await admin.post("/api/admin/employees", body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const count = async (table: string) => (await app.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

describe("reading employees", () => {
  test("directory lists employees without credential details", async () => {
    const res = await admin.get("/api/admin/employees");
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 4);
    const nurse = res.body.find((e: { employeeId: number }) => e.employeeId === ids.nurse);
    assert.equal(nurse.employeeType, "Nurse");
    assert.equal(nurse.officeName, "Westside Clinic");
    assert.equal(nurse.hasLogin, true);
    assert.doesNotMatch(JSON.stringify(res.body), /password|hash/i);
  });

  test("details include doctor and nurse information", async () => {
    const doctor = (await admin.get(`/api/admin/employees/${ids.doctor}`)).body;
    assert.equal(doctor.doctor.licenseNumber, "TX-DAN1");
    assert.deepEqual(
      doctor.doctor.specialties.map((s: { name: string }) => s.name),
      ["Family Medicine", "Cardiology"]
    );
    assert.equal(doctor.nurse, null);

    const nurse = (await admin.get(`/api/admin/employees/${ids.nurse}`)).body;
    assert.equal(nurse.nurse.nursingLevel, "RN");
    assert.equal(nurse.doctor, null);
  });

  test("invalid IDs return 400 and missing employees return 404", async () => {
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      assert.equal((await admin.get(`/api/admin/employees/${bad}`)).status, 400, bad);
    }
    assert.equal((await admin.get("/api/admin/employees/99999")).status, 404);
  });
});

describe("creating employees", () => {
  test("receptionist with a login gets a hashed password", async () => {
    const created = await createEmployee(receptionist({ login: { username: "new.receptionist", password: "Initial-Pass-1" } }));
    assert.ok(created.employeeId > ids.receptionist);
    assert.equal(created.hasLogin, true);
    assert.equal(created.loginActive, true);

    const { rows } = await app.db.query("SELECT password_hash FROM employee_creds WHERE employee_id = $1", [created.employeeId]);
    assert.match(rows[0].password_hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
    assert.ok(await verifyPassword("Initial-Pass-1", rows[0].password_hash));
    assert.equal(await app.staffLoginStatus(created.employeeId, "Initial-Pass-1"), 200);
  });

  test("doctor gets a doctor row and specialties with one primary", async () => {
    const created = await createEmployee(
      receptionist({ employeeTypeId: 2, doctor: doctorDetails({ licenseState: "tx", specialtyIds: [1, 2], primarySpecialtyId: 2 }) })
    );
    assert.equal(created.doctor.licenseState, "TX");
    assert.equal(created.doctor.deaNumber, null);
    assert.equal(created.doctor.specialties.length, 2);
    assert.equal(created.doctor.specialties[0].specialtyId, ids.cardiology);
    assert.equal(created.doctor.specialties[0].isPrimary, true);
  });

  test("nurse gets a nurse row; administrators get neither subtype", async () => {
    const nurse = await createEmployee(
      receptionist({ employeeTypeId: 3, nurse: { licenseNumber: "RN-NEW1", licenseState: "TX", licenseExpiration: "2029-06-01", nursingLevel: "NP" } })
    );
    assert.equal(nurse.nurse.nursingLevel, "NP");
    assert.equal(nurse.hasLogin, false);

    // doctor or nurse details sent for another role are refused instead of being dropped
    const employeesBefore = await count("employee");
    const mismatched = [
      await admin.post("/api/admin/employees", receptionist({ employeeTypeId: 1, doctor: doctorDetails() })),
      await admin.post("/api/admin/employees", receptionist({ employeeTypeId: 1, nurse: { licenseNumber: "RN-NEW2", licenseState: "TX", licenseExpiration: "2029-06-01", nursingLevel: "RN" } })),
    ];
    assert.deepEqual(mismatched.map((r) => [r.status, r.body.error]), [[400, "Only doctors can have doctor details"], [400, "Only nurses can have nurse details"]]);
    assert.equal(await count("employee"), employeesBefore);

    const adminUser = await createEmployee(receptionist({ employeeTypeId: 1 }));
    assert.equal(adminUser.doctor, null);
    assert.equal(adminUser.nurse, null);
  });

  test("invalid input is rejected and nothing is saved", async () => {
    const before = await count("employee");
    const cases: [string, object, number][] = [
      ["blank first name", receptionist({ firstName: " " }), 400],
      ["last name too long", receptionist({ lastName: "x".repeat(51) }), 400],
      ["future date of birth", receptionist({ dob: "2999-01-01" }), 400],
      ["unknown role", receptionist({ employeeTypeId: 999 }), 400],
      ["inactive role", receptionist({ employeeTypeId: 5 }), 400],
      ["unknown office", receptionist({ officeId: 999 }), 400],
      ["inactive office", receptionist({ officeId: ids.closedOffice }), 400],
      ["doctor without license details", receptionist({ employeeTypeId: 2 }), 400],
      ["invalid nursing level", receptionist({ employeeTypeId: 3, nurse: { licenseNumber: "RN-X", licenseState: "TX", licenseExpiration: "2029-01-01", nursingLevel: "XX" } }), 400],
      ["short password", receptionist({ login: { username: "short.pw", password: "short" } }), 400],
      ["username too long", receptionist({ login: { username: "u".repeat(51), password: "Long-Enough-1" } }), 400],
      ["invalid NPI", receptionist({ employeeTypeId: 2, doctor: doctorDetails({ npiNumber: "12345" }) }), 400],
      ["inactive specialty", receptionist({ employeeTypeId: 2, doctor: doctorDetails({ specialtyIds: [3], primarySpecialtyId: 3 }) }), 400],
      ["primary not among selected", receptionist({ employeeTypeId: 2, doctor: doctorDetails({ specialtyIds: [1], primarySpecialtyId: 2 }) }), 400],
      ["no specialties", receptionist({ employeeTypeId: 2, doctor: doctorDetails({ specialtyIds: [], primarySpecialtyId: 1 }) }), 400],
      ["duplicate username (any case)", receptionist({ login: { username: "ADA@test.org", password: "Long-Enough-1" } }), 409],
      ["duplicate email", receptionist({ email: "DAN@test.org" }), 409],
      ["duplicate doctor license", receptionist({ employeeTypeId: 2, doctor: doctorDetails({ licenseNumber: "tx-dan1" }) }), 409],
      ["duplicate NPI", receptionist({ employeeTypeId: 2, doctor: doctorDetails({ npiNumber: "1111111111" }) }), 409],
      ["duplicate nurse license", receptionist({ employeeTypeId: 3, nurse: { licenseNumber: "rn-nina1", licenseState: "TX", licenseExpiration: "2029-01-01", nursingLevel: "RN" } }), 409],
    ];
    for (const [label, body, status] of cases) {
      const res = await admin.post("/api/admin/employees", body);
      assert.equal(res.status, status, label);
    }
    assert.equal(await count("employee"), before);
  });

  test("a failure partway through rolls back the whole employee", async (t) => {
    // the app logs the forced database error, so keep the test output clean
    t.mock.method(console, "error", () => {});
    // a trigger made just for this test makes the nurse insert fail after the employee and login rows exist
    await app.db.query(`
      CREATE FUNCTION fail_nurse_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced test failure'; END $$;
      CREATE TRIGGER fail_nurse_insert BEFORE INSERT ON nurse FOR EACH ROW EXECUTE FUNCTION fail_nurse_insert();
    `);
    try {
      const counts = async () => [await count("employee"), await count("employee_creds"), await count("nurse")];
      const before = await counts();
      const res = await admin.post(
        "/api/admin/employees",
        receptionist({
          employeeTypeId: 3,
          login: { username: "rollback.user", password: "Long-Enough-1" },
          nurse: { licenseNumber: "RN-ROLLBACK", licenseState: "TX", licenseExpiration: "2029-01-01", nursingLevel: "RN" },
        })
      );
      assert.equal(res.status, 500);
      assert.equal(res.body.error, "Could not save the employee");
      assert.deepEqual(await counts(), before);
    } finally {
      await app.db.query("DROP TRIGGER fail_nurse_insert ON nurse; DROP FUNCTION fail_nurse_insert()");
    }
  });
});

describe("editing employees", () => {
  test("edit saves changes and leaves status and login alone", async () => {
    const created = await createEmployee(receptionist({ login: { username: "edit.me", password: "Long-Enough-1" } }));
    const hashBefore = (await app.db.query("SELECT password_hash FROM employee_creds WHERE employee_id = $1", [created.employeeId])).rows[0];

    const body = receptionist({ email: created.email, phone: "713-555-9999", officeId: ids.westsideOffice });
    const res = await admin.put(`/api/admin/employees/${created.employeeId}`, body);
    assert.equal(res.status, 200);
    assert.equal(res.body.phone, "713-555-9999");
    assert.equal(res.body.officeId, ids.westsideOffice);
    assert.equal(res.body.isActive, true);
    assert.equal(res.body.loginActive, true);
    assert.deepEqual((await app.db.query("SELECT password_hash FROM employee_creds WHERE employee_id = $1", [created.employeeId])).rows[0], hashBefore);
  });

  test("receptionist can become administrator, but not doctor", async () => {
    const created = await createEmployee(receptionist());
    const base = receptionist({ email: created.email });
    assert.equal((await admin.put(`/api/admin/employees/${created.employeeId}`, { ...base, employeeTypeId: 1 })).status, 200);
    const toDoctor = await admin.put(`/api/admin/employees/${created.employeeId}`, { ...base, employeeTypeId: 2, doctor: doctorDetails() });
    assert.equal(toDoctor.status, 409);
    assert.equal((await app.db.query("SELECT 1 FROM doctor WHERE employee_id = $1", [created.employeeId])).rowCount, 0);
  });

  test("doctors and nurses can't change role", async () => {
    const dan = (await admin.get(`/api/admin/employees/${ids.doctor}`)).body;
    const res = await admin.put(`/api/admin/employees/${ids.doctor}`, { ...dan, employeeTypeId: 4, doctor: null });
    assert.equal(res.status, 409);
    const nina = (await admin.get(`/api/admin/employees/${ids.nurse}`)).body;
    assert.equal((await admin.put(`/api/admin/employees/${ids.nurse}`, { ...nina, employeeTypeId: 4 })).status, 409);
    assert.equal((await app.db.query("SELECT employee_type_id FROM employee WHERE employee_id = $1", [ids.doctor])).rows[0].employee_type_id, 2);
  });

  test("removed specialties are kept as inactive, and scheduled ones can't be removed", async () => {
    const doctor = await createEmployee(receptionist({ employeeTypeId: 2, doctor: doctorDetails({ specialtyIds: [1, 2], primarySpecialtyId: 1 }) }));
    const body = (doctorOverrides: object) => ({ ...receptionist({ email: doctor.email }), employeeTypeId: 2, doctor: { ...doctor.doctor, specialtyIds: [1, 2], primarySpecialtyId: 1, ...doctorOverrides } });

    const removed = await admin.put(`/api/admin/employees/${doctor.employeeId}`, body({ specialtyIds: [2], primarySpecialtyId: 2 }));
    assert.equal(removed.status, 200);
    assert.equal(removed.body.doctor.specialties.length, 1);
    const row = (await app.db.query("SELECT is_active FROM doctor_specialty WHERE doctor_id = $1 AND specialty_id = 1", [doctor.employeeId])).rows[0];
    assert.equal(row.is_active, false);

    await app.db.query(`INSERT INTO doctor_schedule (doctor_id, day_of_week, office_id, specialty_id, shift_type_id) VALUES ($1, 'Friday', 1, 2, 1)`, [doctor.employeeId]);
    const blocked = await admin.put(`/api/admin/employees/${doctor.employeeId}`, body({ specialtyIds: [1], primarySpecialtyId: 1 }));
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /Cardiology is used in this doctor's active schedule/);
  });

  test("duplicate email, missing employee, and invalid ID are rejected", async () => {
    const created = await createEmployee(receptionist());
    assert.equal((await admin.put(`/api/admin/employees/${created.employeeId}`, receptionist({ email: "dan@test.org" }))).status, 409);
    assert.equal((await admin.put("/api/admin/employees/99999", receptionist())).status, 404);
    assert.equal((await admin.put("/api/admin/employees/abc", receptionist())).status, 400);
  });
});

describe("account management", () => {
  test("deactivating an employee blocks login but leaves the login enabled", async () => {
    const created = await createEmployee(receptionist({ login: { username: "status.check", password: "Long-Enough-1" } }));
    const off = await admin.patch(`/api/admin/employees/${created.employeeId}/status`, { isActive: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.isActive, false);
    assert.equal(off.body.loginActive, true);
    assert.equal(await app.staffLoginStatus(created.employeeId, "Long-Enough-1"), 401);

    const on = await admin.patch(`/api/admin/employees/${created.employeeId}/status`, { isActive: true });
    assert.equal(on.body.isActive, true);
    assert.equal(await app.staffLoginStatus(created.employeeId, "Long-Enough-1"), 200);
  });

  test("disabling a login blocks sign-in; enabling requires an active employee", async () => {
    const created = await createEmployee(receptionist({ login: { username: "login.check", password: "Long-Enough-1" } }));
    const path = `/api/admin/employees/${created.employeeId}`;

    const disabled = await admin.patch(`${path}/login-status`, { loginActive: false });
    assert.equal(disabled.body.loginActive, false);
    assert.equal(disabled.body.isActive, true);
    assert.equal(await app.staffLoginStatus(created.employeeId, "Long-Enough-1"), 401);

    await admin.patch(`${path}/status`, { isActive: false });
    const enableInactive = await admin.patch(`${path}/login-status`, { loginActive: true });
    assert.equal(enableInactive.status, 409);

    const activated = await admin.patch(`${path}/status`, { isActive: true });
    assert.equal(activated.body.loginActive, false, "activating the employee doesn't re-enable the login");
    await admin.patch(`${path}/login-status`, { loginActive: true });
    assert.equal(await app.staffLoginStatus(created.employeeId, "Long-Enough-1"), 200);
  });

  test("password reset stores a new hash without re-enabling a disabled login", async () => {
    const created = await createEmployee(receptionist({ login: { username: "reset.check", password: "Long-Enough-1" } }));
    const path = `/api/admin/employees/${created.employeeId}`;
    await admin.patch(`${path}/login-status`, { loginActive: false });

    const reset = await admin.put(`${path}/password`, { password: "Brand-New-Pass-2" });
    assert.equal(reset.status, 204);
    const { rows } = await app.db.query("SELECT password_hash, is_active FROM employee_creds WHERE employee_id = $1", [created.employeeId]);
    assert.ok(await verifyPassword("Brand-New-Pass-2", rows[0].password_hash));
    assert.equal(rows[0].is_active, false);

    await admin.patch(`${path}/login-status`, { loginActive: true });
    assert.equal(await app.staffLoginStatus(created.employeeId, "Long-Enough-1"), 401);
    assert.equal(await app.staffLoginStatus(created.employeeId, "Brand-New-Pass-2"), 200);
    assert.equal((await admin.put(`${path}/password`, { password: "short" })).status, 400);
  });

  test("create login only for employees without one", async () => {
    const created = await createEmployee(receptionist());
    const path = `/api/admin/employees/${created.employeeId}`;
    assert.equal(created.hasLogin, false);
    assert.equal((await admin.patch(`${path}/login-status`, { loginActive: true })).status, 409);
    assert.equal((await admin.put(`${path}/password`, { password: "Long-Enough-1" })).status, 409);

    assert.equal((await admin.post(`${path}/login`, { username: "ADA@test.org", password: "Long-Enough-1" })).status, 409);
    const login = await admin.post(`${path}/login`, { username: "added.login", password: "Long-Enough-1" });
    assert.equal(login.status, 201);
    assert.equal(login.body.hasLogin, true);
    assert.equal(await app.staffLoginStatus(created.employeeId, "Long-Enough-1"), 200);

    const hash = (await app.db.query("SELECT password_hash FROM employee_creds WHERE employee_id = $1", [created.employeeId])).rows[0];
    assert.equal((await admin.post(`${path}/login`, { username: "second.login", password: "Other-Pass-9" })).status, 409);
    assert.deepEqual((await app.db.query("SELECT password_hash FROM employee_creds WHERE employee_id = $1", [created.employeeId])).rows[0], hash);
  });

  test("creating a login doesn't reactivate an inactive employee", async () => {
    const created = await createEmployee(receptionist());
    await admin.patch(`/api/admin/employees/${created.employeeId}/status`, { isActive: false });
    const login = await admin.post(`/api/admin/employees/${created.employeeId}/login`, { username: "inactive.login", password: "Long-Enough-1" });
    assert.equal(login.body.isActive, false);
    assert.equal(await app.staffLoginStatus(created.employeeId, "Long-Enough-1"), 401);
  });

  test("admins can't deactivate themselves or disable their own login", async () => {
    assert.equal((await admin.patch(`/api/admin/employees/${ids.admin}/status`, { isActive: false })).status, 409);
    assert.equal((await admin.patch(`/api/admin/employees/${ids.admin}/login-status`, { loginActive: false })).status, 409);
    assert.equal(await app.staffLoginStatus(ids.admin), 200);
  });

  test("account endpoints validate input and IDs", async () => {
    assert.equal((await admin.patch(`/api/admin/employees/${ids.receptionist}/status`, { isActive: "no" })).status, 400);
    assert.equal((await admin.patch(`/api/admin/employees/${ids.doctor}/login-status`, {})).status, 400);
    assert.equal((await admin.patch("/api/admin/employees/abc/status", { isActive: true })).status, 400);
    assert.equal((await admin.patch("/api/admin/employees/99999/status", { isActive: true })).status, 404);
    assert.equal((await admin.patch("/api/admin/employees/99999/login-status", { loginActive: true })).status, 404);
    assert.equal((await admin.put("/api/admin/employees/99999/password", { password: "Long-Enough-1" })).status, 404);
    assert.equal((await admin.post("/api/admin/employees/99999/login", { username: "ghost", password: "Long-Enough-1" })).status, 404);
  });
});

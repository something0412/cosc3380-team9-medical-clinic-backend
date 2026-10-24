import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient } from "./helpers/testApp.js";
import { TEST_PASSWORD, ids, resetDatabase } from "./helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let receptionistTypeId: number;
let nurseTypeId: number;
let adminTypeId: number;

const availability = (client: TestClient, query = "date=2030-01-07") => client.get(`/api/availability?${query}`);

// adds an employee with a login that uses the shared test password
async function addEmployee(firstName: string, typeId: number, officeId: number) {
  const email = `${firstName.toLowerCase()}@test.org`;
  const { rows } = await app.db.query(
    `
    INSERT INTO employee (first_name, last_name, dob, employee_type_id, phone, email, office_id)
    VALUES ($1, 'Tester', '1990-01-01', $2, '713-555-7000', $3, $4)
    RETURNING employee_id
    `,
    [firstName, typeId, email, officeId]
  );
  const employeeId = rows[0].employee_id as number;
  await app.db.query(
    `INSERT INTO employee_creds (employee_id, username, password_hash) SELECT $1, $2, password_hash FROM employee_creds WHERE employee_id = $3`,
    [employeeId, email, ids.admin]
  );
  return employeeId;
}

// signs a new patient up and returns their id and a client holding their session
async function signUp(email: string) {
  const res = (await app.client().post("/api/auth/patient/signup", {
    firstName: "Sam",
    lastName: "Session",
    dob: "1992-02-02",
    phone: "713-555-7100",
    email,
    password: TEST_PASSWORD,
  })) as { status: number; body: { patientId: number }; cookie?: string };
  assert.equal(res.status, 201);
  return { patientId: res.body.patientId, client: app.client(res.cookie) };
}

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  const types = await app.db.query(`SELECT employee_type_id AS id, type_name AS name FROM employee_types`);
  const typeId = (name: string) => types.rows.find((t) => t.name === name).id as number;
  receptionistTypeId = typeId("Receptionist");
  nurseTypeId = typeId("Nurse");
  adminTypeId = typeId("Administrator");
  // the fixtures leave the receptionist without a login
  await app.db.query(
    `INSERT INTO employee_creds (employee_id, username, password_hash) SELECT $1, 'rita@test.org', password_hash FROM employee_creds WHERE employee_id = $2`,
    [ids.receptionist, ids.admin]
  );
});

after(() => app.close());

describe("patient sessions", () => {
  test("an active patient keeps working", async () => {
    const pat = await app.loginPatient(ids.patient, "pat@test.org");
    const me = await pat.get("/api/auth/me");
    assert.deepEqual(me.body, { role: "patient", id: ids.patient, firstName: "Pat", lastName: "Patient" });
    assert.equal((await pat.get(`/api/patient/${ids.patient}/profile`)).status, 200);
    assert.equal((await availability(pat)).status, 200);
  });

  test("deactivating a patient ends their session on every protected route", async () => {
    const pat = await app.loginPatient(ids.patient, "pat@test.org");
    await app.db.query(`UPDATE patient SET is_active = false WHERE patient_id = $1`, [ids.patient]);
    try {
      assert.equal((await pat.get(`/api/patient/${ids.patient}/records`)).status, 401);
      assert.equal((await pat.get("/api/auth/me")).status, 401);
      assert.equal((await availability(pat)).status, 401);
      assert.equal((await pat.post("/api/appointments", { doctorId: ids.doctor, specialtyId: ids.cardiology, date: "2030-01-07", timeSlotId: 1 })).status, 401);
    } finally {
      await app.db.query(`UPDATE patient SET is_active = true WHERE patient_id = $1`, [ids.patient]);
    }
    // reactivating the account doesn't bring the old session back
    assert.equal((await pat.get(`/api/patient/${ids.patient}/profile`)).status, 401);
    const again = await app.loginPatient(ids.patient, "pat@test.org");
    assert.equal((await again.get(`/api/patient/${ids.patient}/profile`)).status, 200);
  });

  test("disabling a patient's login ends their session", async () => {
    const pat = await app.loginPatient(ids.patient, "pat@test.org");
    await app.db.query(`UPDATE patient_creds SET is_active = false WHERE patient_id = $1`, [ids.patient]);
    try {
      assert.equal((await pat.get(`/api/patient/${ids.patient}/profile`)).status, 401);
    } finally {
      await app.db.query(`UPDATE patient_creds SET is_active = true WHERE patient_id = $1`, [ids.patient]);
    }
  });

  test("a deleted patient can't keep using their session", async () => {
    const { patientId, client } = await signUp("deleted.patient@test.org");
    assert.equal((await client.get(`/api/patient/${patientId}/profile`)).status, 200);
    await app.db.query(`DELETE FROM patient WHERE patient_id = $1`, [patientId]);
    assert.equal((await client.get(`/api/patient/${patientId}/profile`)).status, 401);
    assert.equal((await client.get("/api/auth/me")).status, 401);
  });

  test("patients still can't read another patient's records", async () => {
    const other = await signUp("other.patient@test.org");
    const pat = await app.loginPatient(ids.patient, "pat@test.org");
    assert.equal((await pat.get(`/api/patient/${other.patientId}/profile`)).status, 403);
    assert.equal((await other.client.get(`/api/patient/${ids.patient}/records`)).status, 403);
  });
});

describe("employee sessions", () => {
  test("deactivating an employee ends their session", async () => {
    const rita = await app.loginStaff(ids.receptionist);
    assert.equal((await rita.get(`/api/staff/${ids.receptionist}/profile`)).status, 200);
    await app.db.query(`UPDATE employee SET is_active = false WHERE employee_id = $1`, [ids.receptionist]);
    try {
      assert.equal((await rita.get(`/api/staff/${ids.receptionist}/profile`)).status, 401);
      assert.equal((await availability(rita)).status, 401);
      assert.equal((await rita.get("/api/patients")).status, 401);
    } finally {
      await app.db.query(`UPDATE employee SET is_active = true WHERE employee_id = $1`, [ids.receptionist]);
    }
    assert.equal((await rita.get(`/api/staff/${ids.receptionist}/profile`)).status, 401);
  });

  test("a deactivated administrator loses Admin access right away", async () => {
    const otherAdmin = await addEmployee("Alma", adminTypeId, ids.mainOffice);
    const alma = await app.loginStaff(otherAdmin);
    assert.equal((await alma.get("/api/admin/offices")).status, 200);

    await app.db.query(`UPDATE employee SET is_active = false WHERE employee_id = $1`, [otherAdmin]);
    assert.equal((await alma.get("/api/admin/offices")).status, 401);
    assert.equal((await alma.put(`/api/admin/offices/${ids.westsideOffice}`, { name: "Renamed" })).status, 401);
    await app.db.query(`UPDATE employee SET is_active = true WHERE employee_id = $1`, [otherAdmin]);

    // a disabled login counts as well, even while the employee is active
    const again = await app.loginStaff(otherAdmin);
    await app.db.query(`UPDATE employee_creds SET is_active = false WHERE employee_id = $1`, [otherAdmin]);
    assert.equal((await again.get("/api/admin/employees")).status, 401);
    const offices = await app.db.query(`SELECT name FROM office WHERE office_id = $1`, [ids.westsideOffice]);
    assert.equal(offices.rows[0].name, "Westside Clinic");
  });

  test("a deleted employee can't keep using their session", async () => {
    const tempId = await addEmployee("Toby", receptionistTypeId, ids.mainOffice);
    const toby = await app.loginStaff(tempId);
    assert.equal((await toby.get(`/api/staff/${tempId}/profile`)).status, 200);
    await app.db.query(`DELETE FROM employee WHERE employee_id = $1`, [tempId]);
    assert.equal((await toby.get(`/api/staff/${tempId}/profile`)).status, 401);
    assert.equal((await toby.get("/api/auth/me")).status, 401);
  });
});

describe("staff identity", () => {
  test("doctors, nurses, receptionists, and admins keep their own permissions", async () => {
    const roles = [
      { id: ids.doctor, role: "doctor", booking: 403, admin: 403 },
      { id: ids.nurse, role: "staff", booking: 403, admin: 403 },
      { id: ids.receptionist, role: "staff", booking: 200, admin: 403 },
      { id: ids.admin, role: "admin", booking: 403, admin: 200 },
    ];
    for (const r of roles) {
      const client = await app.loginStaff(r.id);
      assert.equal((await client.get("/api/auth/me")).body.role, r.role, `role for ${r.id}`);
      assert.equal((await availability(client)).status, r.booking, `booking for ${r.id}`);
      assert.equal((await client.get("/api/admin/offices")).status, r.admin, `admin for ${r.id}`);
      assert.equal((await client.get(`/api/staff/${r.id}/profile`)).status, 200, `profile for ${r.id}`);
      assert.equal((await client.get(`/api/patient/${ids.patient}/profile`)).status, 401, `patient routes for ${r.id}`);
    }
  });

  test("a changed employee type applies on the next request", async () => {
    const rita = await app.loginStaff(ids.receptionist);
    assert.equal((await availability(rita)).status, 200);
    try {
      await app.db.query(`UPDATE employee SET employee_type_id = $1 WHERE employee_id = $2`, [nurseTypeId, ids.receptionist]);
      assert.equal((await availability(rita)).status, 403);

      // the nurse table decides too, even when the type still says receptionist
      await app.db.query(`UPDATE employee SET employee_type_id = $1 WHERE employee_id = $2`, [receptionistTypeId, ids.receptionist]);
      await app.db.query(`INSERT INTO nurse VALUES ($1, 'RN-RITA4', 'TX', '2030-01-01', 'RN')`, [ids.receptionist]);
      assert.equal((await availability(rita)).status, 403);
      await app.db.query(`DELETE FROM nurse WHERE employee_id = $1`, [ids.receptionist]);
      assert.equal((await availability(rita)).status, 200);

      // promoted and then demoted again, all on the same session
      await app.db.query(`UPDATE employee SET employee_type_id = $1 WHERE employee_id = $2`, [adminTypeId, ids.receptionist]);
      assert.equal((await rita.get("/api/auth/me")).body.role, "admin");
      assert.equal((await rita.get("/api/admin/offices")).status, 200);
      await app.db.query(`UPDATE employee SET employee_type_id = $1 WHERE employee_id = $2`, [receptionistTypeId, ids.receptionist]);
      assert.equal((await rita.get("/api/admin/offices")).status, 403);
      assert.equal((await rita.get("/api/auth/me")).body.role, "staff");
    } finally {
      await app.db.query(`DELETE FROM nurse WHERE employee_id = $1`, [ids.receptionist]);
      await app.db.query(`UPDATE employee SET employee_type_id = $1 WHERE employee_id = $2`, [receptionistTypeId, ids.receptionist]);
    }
  });

  test("a changed office applies to the receptionist's next booking request", async () => {
    const rita = await app.loginStaff(ids.receptionist);
    assert.equal((await availability(rita, `date=2030-01-07&officeId=${ids.westsideOffice}`)).status, 200);
    assert.equal((await availability(rita, `date=2030-01-07&officeId=${ids.mainOffice}`)).status, 403);
    try {
      await app.db.query(`UPDATE employee SET office_id = $1 WHERE employee_id = $2`, [ids.mainOffice, ids.receptionist]);
      assert.equal((await availability(rita, `date=2030-01-07&officeId=${ids.mainOffice}`)).status, 200);
      assert.equal((await availability(rita, `date=2030-01-07&officeId=${ids.westsideOffice}`)).status, 403);
    } finally {
      await app.db.query(`UPDATE employee SET office_id = $1 WHERE employee_id = $2`, [ids.westsideOffice, ids.receptionist]);
    }
  });

  test("a name change shows up in the current user", async () => {
    const nina = await app.loginStaff(ids.nurse);
    await app.db.query(`UPDATE employee SET first_name = 'Nora' WHERE employee_id = $1`, [ids.nurse]);
    try {
      assert.equal((await nina.get("/api/auth/me")).body.firstName, "Nora");
    } finally {
      await app.db.query(`UPDATE employee SET first_name = 'Nina' WHERE employee_id = $1`, [ids.nurse]);
    }
  });
});

describe("sign in, sign out, and public access", () => {
  test("login, logout, and session restoration still work", async () => {
    const admin = await app.loginStaff(ids.admin);
    assert.deepEqual((await admin.get("/api/auth/me")).body, {
      role: "admin",
      id: ids.admin,
      firstName: "Ada",
      lastName: "Admin",
      employeeType: "Administrator",
      staffType: "admin",
      officeId: ids.mainOffice,
    });
    assert.equal((await admin.get("/api/admin/offices")).status, 200);
    assert.equal((await admin.post("/api/auth/logout")).status, 204);
    assert.equal((await admin.get("/api/auth/me")).status, 401);
    assert.equal((await admin.get("/api/admin/offices")).status, 401);
  });

  test("an ended session doesn't block signing in again", async () => {
    const rita = await app.loginStaff(ids.receptionist);
    await app.db.query(`UPDATE employee SET is_active = false WHERE employee_id = $1`, [ids.receptionist]);
    assert.equal((await rita.get("/api/auth/me")).status, 401);
    await app.db.query(`UPDATE employee SET is_active = true WHERE employee_id = $1`, [ids.receptionist]);
    const login = await rita.post("/api/auth/staff/login", { employeeId: ids.receptionist, password: TEST_PASSWORD });
    assert.equal(login.status, 200);
  });

  test("public endpoints work without signing in, even with a dead session", async () => {
    const anonymous = app.client();
    const deadSession = app.client("connect.sid=s%3Anot-a-real-session.signature");
    for (const client of [anonymous, deadSession]) {
      assert.equal((await client.get("/api/health")).status, 200);
      assert.equal((await client.get("/api/public/doctors")).status, 200);
      assert.equal((await client.get("/api/public/specialties")).status, 200);
      assert.equal((await client.get(`/api/public/availability?specialtyId=${ids.cardiology}&date=2030-01-07`)).status, 200);
    }
  });

  test("signed out and forged sessions can't reach protected routes", async () => {
    const forged = app.client("connect.sid=s%3Aforged.session");
    for (const client of [app.client(), forged]) {
      assert.equal((await client.get(`/api/patient/${ids.patient}/profile`)).status, 401);
      assert.equal((await client.get(`/api/staff/${ids.admin}/profile`)).status, 401);
      assert.equal((await client.get("/api/admin/offices")).status, 401);
      assert.equal((await client.get("/api/patients")).status, 401);
      assert.equal((await availability(client)).status, 401);
      assert.equal((await client.get("/api/auth/me")).status, 401);
    }
  });
});

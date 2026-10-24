import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient } from "./helpers/testApp.js";
import { TEST_PASSWORD, ids, resetDatabase } from "./helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let admin: TestClient;
let labTechId: number;
let labTypeId: number;
let receptionistTypeId: number;
let nurseTypeId: number;
let adminTypeId: number;

// paths no route answers, so a 404 means the portal guard let the request through
const PORTAL_CHECKS = {
  lab: "/api/lab/guard-check",
  nurse: "/api/nurse/guard-check",
  receptionist: "/api/receptionist/guard-check",
  doctor: "/api/doctor/guard-check",
};

const setType = (employeeId: number, typeId: number) =>
  app.db.query(`UPDATE employee SET employee_type_id = $1 WHERE employee_id = $2`, [typeId, employeeId]);

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  admin = await app.loginStaff(ids.admin);

  // migration 008 added this type to the live database, but the fixtures don't have it
  const labType = await app.db.query(`INSERT INTO employee_types (type_name) VALUES ('Lab Technician') RETURNING employee_type_id AS id`);
  labTypeId = labType.rows[0].id;
  const types = await app.db.query(`SELECT employee_type_id AS id, type_name AS name FROM employee_types`);
  const typeId = (name: string) => types.rows.find((t) => t.name === name).id as number;
  receptionistTypeId = typeId("Receptionist");
  nurseTypeId = typeId("Nurse");
  adminTypeId = typeId("Administrator");

  const created = await admin.post("/api/admin/employees", {
    firstName: "Lee",
    lastName: "Lab",
    dob: "1992-04-04",
    email: "lee@test.org",
    phone: "713-555-1004",
    employeeTypeId: labTypeId,
    officeId: ids.mainOffice,
  });
  assert.equal(created.status, 201);
  labTechId = created.body.employeeId;
  assert.equal((await admin.post(`/api/admin/employees/${labTechId}/login`, { username: "lee.lab", password: TEST_PASSWORD })).status, 201);
  assert.equal((await admin.post(`/api/admin/employees/${ids.receptionist}/login`, { username: "rita.roles", password: TEST_PASSWORD })).status, 201);
});

after(() => app.close());

describe("lab technician sign in", () => {
  test("login gives the lab role and never the password hash", async () => {
    const res = await app.client().post("/api/auth/staff/login", { employeeId: labTechId, password: TEST_PASSWORD });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { employeeId: labTechId, firstName: "Lee", lastName: "Lab", employeeType: "Lab Technician", role: "lab" });
  });

  test("the current user shows the lab role, staff type and office from the database", async () => {
    const lee = await app.loginStaff(labTechId);
    const me = await lee.get("/api/auth/me");
    assert.deepEqual(me.body, {
      role: "lab",
      id: labTechId,
      firstName: "Lee",
      lastName: "Lab",
      employeeType: "Lab Technician",
      staffType: "lab",
      officeId: ids.mainOffice,
    });
  });

  test("the session keeps working across requests and ends on logout", async () => {
    const lee = await app.loginStaff(labTechId);
    for (let i = 0; i < 3; i++) {
      assert.equal((await lee.get("/api/lab/dashboard")).status, 200);
      assert.equal((await lee.get("/api/lab/orders")).status, 200);
      assert.equal((await lee.get("/api/auth/me")).body.role, "lab");
    }
    assert.equal((await lee.get(`/api/staff/${labTechId}/profile`)).status, 200);
    assert.equal((await lee.post("/api/auth/logout")).status, 204);
    assert.equal((await lee.get("/api/lab/dashboard")).status, 401);
  });

  test("a deactivated lab technician loses the session and has to sign in again", async () => {
    const lee = await app.loginStaff(labTechId);
    await app.db.query(`UPDATE employee SET is_active = false WHERE employee_id = $1`, [labTechId]);
    try {
      assert.equal((await lee.get("/api/lab/dashboard")).status, 401);
      assert.equal(await app.staffLoginStatus(labTechId), 401);
    } finally {
      await app.db.query(`UPDATE employee SET is_active = true WHERE employee_id = $1`, [labTechId]);
    }
    assert.equal((await lee.get("/api/lab/dashboard")).status, 401);
    assert.equal((await (await app.loginStaff(labTechId)).get("/api/lab/dashboard")).status, 200);
  });
});

describe("lab technician limits", () => {
  test("no admin, doctor, nurse, receptionist, booking or patient management access", async () => {
    const lee = await app.loginStaff(labTechId);
    assert.equal((await lee.get("/api/admin/offices")).status, 403);
    assert.equal((await lee.get(PORTAL_CHECKS.doctor)).status, 403);
    assert.equal((await lee.get(PORTAL_CHECKS.nurse)).status, 403);
    assert.equal((await lee.get(PORTAL_CHECKS.receptionist)).status, 403);
    assert.equal((await lee.get(`/api/receptionist/patients/${ids.patient}`)).status, 403);
    assert.equal((await lee.post(`/api/receptionist/patients/${ids.patient}/login`, { email: "x@test.org", password: TEST_PASSWORD })).status, 403);
    assert.equal((await lee.get("/api/patients")).status, 403);
    assert.equal((await lee.post("/api/patients", { firstName: "No", lastName: "Access", dob: "1990-01-01", phone: "1" })).status, 403);
    assert.equal((await lee.get("/api/availability?date=2030-01-07")).status, 403);
    assert.equal((await lee.post("/api/appointments", { doctorId: ids.doctor, specialtyId: 1, date: "2030-01-07", timeSlotId: 1, patientId: 1 })).status, 403);
    assert.equal((await lee.get(`/api/patient/${ids.patient}/profile`)).status, 401);
    assert.equal((await lee.get(`/api/staff/${ids.doctor}/profile`)).status, 403);
  });

  test("a leftover doctor or nurse record doesn't give a lab technician more access", async () => {
    const lee = await app.loginStaff(labTechId);
    try {
      await app.db.query(`INSERT INTO doctor VALUES ($1, 'TX-LEE1', 'TX', '2030-01-01', '2222222222', NULL)`, [labTechId]);
      assert.equal((await lee.get("/api/auth/me")).body.role, "lab");
      assert.equal((await lee.get(PORTAL_CHECKS.doctor)).status, 403);
      assert.equal((await lee.get(PORTAL_CHECKS.lab)).status, 404);
      await app.db.query(`DELETE FROM doctor WHERE employee_id = $1`, [labTechId]);

      await app.db.query(`INSERT INTO nurse VALUES ($1, 'RN-LEE1', 'TX', '2030-01-01', 'RN')`, [labTechId]);
      assert.equal((await lee.get("/api/auth/me")).body.staffType, "lab");
      assert.equal((await lee.get(PORTAL_CHECKS.nurse)).status, 403);
    } finally {
      await app.db.query(`DELETE FROM doctor WHERE employee_id = $1`, [labTechId]);
      await app.db.query(`DELETE FROM nurse WHERE employee_id = $1`, [labTechId]);
    }
  });

  test("everyone else is kept out of the lab portal", async () => {
    const others = [
      [app.client(), 401],
      [await app.loginPatient(ids.patient, "pat@test.org"), 403],
      [await app.loginStaff(ids.doctor), 403],
      [await app.loginStaff(ids.nurse), 403],
      [await app.loginStaff(ids.receptionist), 403],
      [admin, 403],
    ] as const;
    for (const [client, status] of others) {
      assert.equal((await client.get("/api/lab/dashboard")).status, status);
      assert.equal((await client.get(PORTAL_CHECKS.lab)).status, status);
    }
  });
});

describe("role changes", () => {
  test("a changed employee type moves a lab technician on the next request", async () => {
    const lee = await app.loginStaff(labTechId);
    try {
      await setType(labTechId, receptionistTypeId);
      const me = (await lee.get("/api/auth/me")).body;
      assert.deepEqual([me.role, me.staffType], ["staff", "receptionist"]);
      assert.equal((await lee.get("/api/lab/dashboard")).status, 403);
      assert.equal((await lee.get("/api/availability?date=2030-01-07")).status, 200);

      await setType(labTechId, adminTypeId);
      assert.equal((await lee.get("/api/admin/offices")).status, 200);

      await setType(labTechId, labTypeId);
      assert.equal((await lee.get("/api/auth/me")).body.role, "lab");
      assert.equal((await lee.get("/api/lab/dashboard")).status, 200);
      assert.equal((await lee.get("/api/admin/offices")).status, 403);
      assert.equal((await lee.get("/api/availability?date=2030-01-07")).status, 403);
    } finally {
      await setType(labTechId, labTypeId);
    }
  });

  test("another employee who becomes a lab technician gets only lab access", async () => {
    const rita = await app.loginStaff(ids.receptionist);
    assert.equal((await rita.get(PORTAL_CHECKS.receptionist)).status, 404);
    try {
      await setType(ids.receptionist, labTypeId);
      assert.equal((await rita.get("/api/auth/me")).body.role, "lab");
      assert.equal((await rita.get(PORTAL_CHECKS.lab)).status, 404);
      assert.equal((await rita.get(PORTAL_CHECKS.receptionist)).status, 403);
      assert.equal((await rita.get("/api/patients")).status, 403);
    } finally {
      await setType(ids.receptionist, receptionistTypeId);
    }
    assert.equal((await rita.get(PORTAL_CHECKS.receptionist)).status, 404);
  });
});

describe("nurse and receptionist portals", () => {
  test("each portal admits only its own staff type", async () => {
    const clients = {
      doctor: await app.loginStaff(ids.doctor),
      nurse: await app.loginStaff(ids.nurse),
      receptionist: await app.loginStaff(ids.receptionist),
      admin,
      lab: await app.loginStaff(labTechId),
    };
    for (const [name, client] of Object.entries(clients)) {
      assert.equal((await client.get(PORTAL_CHECKS.nurse)).status, name === "nurse" ? 404 : 403, `nurse portal for ${name}`);
      assert.equal((await client.get(PORTAL_CHECKS.receptionist)).status, name === "receptionist" ? 404 : 403, `receptionist portal for ${name}`);
      assert.equal((await client.get(PORTAL_CHECKS.doctor)).status, name === "doctor" ? 404 : 403, `doctor portal for ${name}`);
    }
    const patient = await app.loginPatient(ids.patient, "pat@test.org");
    assert.equal((await patient.get(PORTAL_CHECKS.nurse)).status, 403);
    assert.equal((await patient.get(PORTAL_CHECKS.receptionist)).status, 403);
    assert.equal((await app.client().get(PORTAL_CHECKS.nurse)).status, 401);
    assert.equal((await app.client().get(PORTAL_CHECKS.receptionist)).status, 401);
  });

  test("the guards follow the database, not the employee type saved when the session started", async () => {
    const rita = await app.loginStaff(ids.receptionist);
    const nina = await app.loginStaff(ids.nurse);
    try {
      // Rita becomes a nurse and Nina a receptionist without signing in again
      await setType(ids.receptionist, nurseTypeId);
      await app.db.query(`INSERT INTO nurse VALUES ($1, 'RN-RITA9', 'TX', '2030-01-01', 'RN')`, [ids.receptionist]);
      await setType(ids.nurse, receptionistTypeId);
      await app.db.query(`DELETE FROM nurse WHERE employee_id = $1`, [ids.nurse]);

      assert.equal((await rita.get(PORTAL_CHECKS.receptionist)).status, 403);
      assert.equal((await rita.get(PORTAL_CHECKS.nurse)).status, 404);
      assert.equal((await nina.get(PORTAL_CHECKS.nurse)).status, 403);
      assert.equal((await nina.get(PORTAL_CHECKS.receptionist)).status, 404);
    } finally {
      await app.db.query(`DELETE FROM nurse WHERE employee_id = $1`, [ids.receptionist]);
      await setType(ids.receptionist, receptionistTypeId);
      await app.db.query(`INSERT INTO nurse VALUES ($1, 'RN-NINA1', 'TX', '2030-01-01', 'RN') ON CONFLICT DO NOTHING`, [ids.nurse]);
      await setType(ids.nurse, nurseTypeId);
    }
    assert.equal((await rita.get(PORTAL_CHECKS.receptionist)).status, 404);
    assert.equal((await nina.get(PORTAL_CHECKS.nurse)).status, 404);
  });

  test("patients keep the same current user details as before", async () => {
    const pat = await app.loginPatient(ids.patient, "pat@test.org");
    assert.deepEqual((await pat.get("/api/auth/me")).body, { role: "patient", id: ids.patient, firstName: "Pat", lastName: "Patient" });
  });
});

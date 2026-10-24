import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "../helpers/testApp.js";
import type { TestClient } from "../helpers/testApp.js";
import { ids, resetDatabase } from "../helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let admin: TestClient;

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  admin = await app.loginStaff(ids.admin);
});

after(() => app.close());

const validOffice = { name: "Uptown Clinic", street: "500 Post Oak Blvd", apt: "", city: "Houston", state: "tx", zip: "77056-1234", phone: "(713) 555-0500" };

async function createOffice(overrides: object = {}) {
  const res = await admin.post("/api/admin/offices", { ...validOffice, ...overrides });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

// rows that reference offices, which office changes must leave alone
async function relatedSnapshot() {
  const { rows } = await app.db.query(`
    SELECT
      (SELECT json_agg(e ORDER BY employee_id) FROM employee e) AS employees,
      (SELECT json_agg(s ORDER BY doctor_id, day_of_week) FROM doctor_schedule s) AS schedules,
      (SELECT count(*) FROM appointment) AS appointments
  `);
  return JSON.stringify(rows[0]);
}

describe("reading offices", () => {
  test("list includes active and inactive offices with the fields the employee form uses", async () => {
    const res = await admin.get("/api/admin/offices");
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((o: { name: string }) => o.name),
      ["Closed Clinic", "Main Street Clinic", "Westside Clinic"]
    );
    for (const office of res.body) {
      assert.equal(typeof office.officeId, "number");
      assert.equal(typeof office.isActive, "boolean");
      assert.ok("street" in office && "zip" in office && "phone" in office);
    }
  });

  test("details include employee and schedule counts", async () => {
    const res = await admin.get(`/api/admin/offices/${ids.mainOffice}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.employeeCount, 2);
    assert.equal(res.body.activeEmployeeCount, 2);
    assert.equal(res.body.activeScheduleCount, 1);
  });

  test("invalid IDs return 400 and missing offices return 404", async () => {
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      assert.equal((await admin.get(`/api/admin/offices/${bad}`)).status, 400, bad);
    }
    assert.equal((await admin.get("/api/admin/offices/99999")).status, 404);
  });
});

describe("creating and editing offices", () => {
  test("new offices are active and normalized", async () => {
    const before = await relatedSnapshot();
    const office = await createOffice();
    assert.equal(office.isActive, true);
    assert.equal(office.state, "TX");
    assert.equal(office.apt, null);
    assert.equal(office.zip, "77056-1234");
    assert.equal(office.employeeCount, 0);
    assert.equal(await relatedSnapshot(), before);
  });

  test("invalid addresses, states, ZIPs, and phones are rejected", async () => {
    const before = (await app.db.query("SELECT count(*)::int AS n FROM office")).rows[0].n;
    const cases: [string, object][] = [
      ["blank name", { name: "  " }],
      ["name too long", { name: "x".repeat(101) }],
      ["blank street", { street: "" }],
      ["apt too long", { apt: "x".repeat(21) }],
      ["city too long", { city: "x".repeat(51) }],
      ["unknown state", { state: "XX" }],
      ["state spelled out", { state: "Texas" }],
      ["short ZIP", { zip: "7705" }],
      ["bad ZIP+4", { zip: "77056-12" }],
      ["letters in phone", { phone: "713-555-ABCD" }],
      ["too few phone digits", { phone: "555-0100" }],
    ];
    for (const [label, overrides] of cases) {
      assert.equal((await admin.post("/api/admin/offices", { ...validOffice, ...overrides })).status, 400, label);
    }
    assert.equal((await app.db.query("SELECT count(*)::int AS n FROM office")).rows[0].n, before);
  });

  test("edit keeps the ID and status and touches nothing else", async () => {
    const office = await createOffice({ name: "Edit Me Clinic" });
    const before = await relatedSnapshot();
    const res = await admin.put(`/api/admin/offices/${office.officeId}`, { ...validOffice, name: "Edited Clinic", apt: "Suite 300", phone: "713-555-0599" });
    assert.equal(res.status, 200);
    assert.equal(res.body.officeId, office.officeId);
    assert.equal(res.body.name, "Edited Clinic");
    assert.equal(res.body.apt, "Suite 300");
    assert.equal(res.body.isActive, true);
    assert.equal(await relatedSnapshot(), before);

    const inactive = await admin.put(`/api/admin/offices/${ids.closedOffice}`, { ...validOffice, name: "Closed Clinic" });
    assert.equal(inactive.body.isActive, false);
  });

  test("edit rejects bad input, missing offices, and invalid IDs", async () => {
    assert.equal((await admin.put(`/api/admin/offices/${ids.westsideOffice}`, { ...validOffice, zip: "abcde" })).status, 400);
    assert.equal((await admin.put("/api/admin/offices/99999", validOffice)).status, 404);
    assert.equal((await admin.put("/api/admin/offices/abc", validOffice)).status, 400);
  });
});

describe("office status", () => {
  test("deactivation is blocked by active employees or active schedules", async () => {
    const main = await admin.patch(`/api/admin/offices/${ids.mainOffice}/status`, { isActive: false });
    assert.equal(main.status, 409);
    assert.match(main.body.error, /2 active employees and 1 active doctor schedule/);
    assert.equal((await admin.patch(`/api/admin/offices/${ids.westsideOffice}/status`, { isActive: false })).status, 409);

    // an office whose only assignment is a schedule
    const office = await createOffice({ name: "Schedule Only Clinic" });
    await app.db.query(
      `INSERT INTO doctor_schedule (doctor_id, day_of_week, office_id, specialty_id, shift_type_id) VALUES ($1, 'Tuesday', $2, 1, 1)`,
      [ids.doctor, office.officeId]
    );
    const blocked = await admin.patch(`/api/admin/offices/${office.officeId}/status`, { isActive: false });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /1 active doctor schedule/);
  });

  test("deactivate and reactivate leave employees and schedules unchanged", async () => {
    const office = await createOffice({ name: "Toggle Clinic" });
    const before = await relatedSnapshot();
    const off = await admin.patch(`/api/admin/offices/${office.officeId}/status`, { isActive: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.isActive, false);
    const again = await admin.patch(`/api/admin/offices/${office.officeId}/status`, { isActive: false });
    assert.equal(again.body.isActive, false);
    const on = await admin.patch(`/api/admin/offices/${office.officeId}/status`, { isActive: true });
    assert.equal(on.body.isActive, true);
    assert.equal(await relatedSnapshot(), before);
  });

  test("an office whose employees are all inactive can be deactivated", async () => {
    const office = await createOffice({ name: "Inactive Staff Clinic" });
    const employee = await admin.post("/api/admin/employees", {
      firstName: "Leaving", lastName: "Soon", dob: "1990-01-01", email: "leaving@test.org", phone: "1", employeeTypeId: 4, officeId: office.officeId,
    });
    await admin.patch(`/api/admin/employees/${employee.body.employeeId}/status`, { isActive: false });
    const res = await admin.patch(`/api/admin/offices/${office.officeId}/status`, { isActive: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.employeeCount, 1);
    assert.equal(res.body.activeEmployeeCount, 0);
  });

  test("employee forms keep their rules for inactive offices", async () => {
    // new assignments can't use an inactive office
    const res = await admin.post("/api/admin/employees", {
      firstName: "New", lastName: "Hire", dob: "1990-01-01", email: "new.hire@test.org", phone: "1", employeeTypeId: 4, officeId: ids.closedOffice,
    });
    assert.equal(res.status, 400);
  });

  test("status rejects bad input, missing offices, and invalid IDs", async () => {
    assert.equal((await admin.patch(`/api/admin/offices/${ids.mainOffice}/status`, { isActive: "no" })).status, 400);
    assert.equal((await admin.patch("/api/admin/offices/99999/status", { isActive: true })).status, 404);
    assert.equal((await admin.patch("/api/admin/offices/0/status", { isActive: true })).status, 400);
  });
});

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

async function createSpecialty(name: string, requiresReferral = false) {
  const res = await admin.post("/api/admin/specialties", { name, requiresReferral });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

// doctor assignments, schedules, appointments, and referrals, which specialty changes must leave alone
async function relatedSnapshot() {
  const { rows } = await app.db.query(`
    SELECT
      (SELECT json_agg(d ORDER BY doctor_id, specialty_id) FROM doctor_specialty d) AS assignments,
      (SELECT json_agg(s ORDER BY doctor_id, day_of_week) FROM doctor_schedule s) AS schedules,
      (SELECT count(*) FROM appointment) AS appointments,
      (SELECT count(*) FROM referral) AS referrals
  `);
  return JSON.stringify(rows[0]);
}

describe("reading specialties", () => {
  test("list includes inactive specialties and the referral rule", async () => {
    const res = await admin.get("/api/admin/specialties");
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((s: { name: string; requiresReferral: boolean; isActive: boolean }) => [s.name, s.requiresReferral, s.isActive]),
      [
        ["Cardiology", true, true],
        ["Family Medicine", false, true],
        ["Retired Specialty", false, false],
      ]
    );
  });

  test("details include doctor and schedule counts", async () => {
    const res = await admin.get(`/api/admin/specialties/${ids.cardiology}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.doctorCount, 1);
    assert.equal(res.body.activeDoctorCount, 1);
    assert.equal(res.body.activeScheduleCount, 1);
  });

  test("invalid IDs return 400 and missing specialties return 404", async () => {
    for (const bad of ["abc", "0", "-2", "1.5"]) {
      assert.equal((await admin.get(`/api/admin/specialties/${bad}`)).status, 400, bad);
    }
    assert.equal((await admin.get("/api/admin/specialties/99999")).status, 404);
  });
});

describe("creating and editing specialties", () => {
  test("new specialties are active, trimmed, and unassigned", async () => {
    const before = await relatedSnapshot();
    const created = await createSpecialty("  Neurology  ", true);
    assert.equal(created.name, "Neurology");
    assert.equal(created.isActive, true);
    assert.equal(created.requiresReferral, true);
    assert.equal(created.doctorCount, 0);
    assert.equal(await relatedSnapshot(), before);
  });

  test("blank, long, non-boolean, and duplicate names are rejected", async () => {
    const cases: [string, object, number][] = [
      ["blank name", { name: "   ", requiresReferral: false }, 400],
      ["name too long", { name: "x".repeat(101), requiresReferral: false }, 400],
      ["non-boolean referral", { name: "Dermatology", requiresReferral: "yes" }, 400],
      ["missing referral", { name: "Dermatology" }, 400],
      ["duplicate name", { name: "Cardiology", requiresReferral: true }, 409],
      ["duplicate name in another case", { name: "cardiology", requiresReferral: true }, 409],
    ];
    for (const [label, body, status] of cases) {
      assert.equal((await admin.post("/api/admin/specialties", body)).status, status, label);
    }
  });

  test("edit renames and changes the referral rule without touching assignments", async () => {
    const created = await createSpecialty("Sleep Medicine");
    const renamed = await admin.put(`/api/admin/specialties/${created.specialtyId}`, { name: "Sleep & Neurology", requiresReferral: true });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, "Sleep & Neurology");
    assert.equal(renamed.body.requiresReferral, true);
    assert.equal(renamed.body.isActive, true);

    // its own name in another case is fine, but another specialty's name is not
    assert.equal((await admin.put(`/api/admin/specialties/${created.specialtyId}`, { name: "sleep & neurology", requiresReferral: true })).status, 200);
    assert.equal((await admin.put(`/api/admin/specialties/${created.specialtyId}`, { name: "Family medicine", requiresReferral: true })).status, 409);

    const before = await relatedSnapshot();
    const cardiology = await admin.put(`/api/admin/specialties/${ids.cardiology}`, { name: "Cardiology", requiresReferral: false });
    assert.equal(cardiology.body.requiresReferral, false);
    assert.equal(await relatedSnapshot(), before);
  });

  test("editing an inactive specialty keeps it inactive", async () => {
    const res = await admin.put(`/api/admin/specialties/${ids.retiredSpecialty}`, { name: "Retired Specialty", requiresReferral: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.isActive, false);
  });

  test("edit rejects missing specialties, invalid IDs, and blank names", async () => {
    assert.equal((await admin.put("/api/admin/specialties/99999", { name: "Ghost", requiresReferral: false })).status, 404);
    assert.equal((await admin.put("/api/admin/specialties/abc", { name: "Ghost", requiresReferral: false })).status, 400);
    assert.equal((await admin.put(`/api/admin/specialties/${ids.familyMedicine}`, { name: "", requiresReferral: false })).status, 400);
  });
});

describe("specialty status", () => {
  test("deactivation is blocked by active doctors or active schedules", async () => {
    const cardiology = await admin.patch(`/api/admin/specialties/${ids.cardiology}/status`, { isActive: false });
    assert.equal(cardiology.status, 409);
    assert.match(cardiology.body.error, /1 active doctor and 1 active doctor schedule/);
    assert.equal((await admin.patch(`/api/admin/specialties/${ids.familyMedicine}/status`, { isActive: false })).status, 409);
  });

  test("an inactive doctor doesn't block deactivation, and assignments are kept", async () => {
    const specialty = await createSpecialty("Allergy");
    const doctor = await admin.post("/api/admin/employees", {
      firstName: "Allie", lastName: "Doctor", dob: "1980-01-01", email: "allie@test.org", phone: "1", employeeTypeId: 2, officeId: ids.mainOffice,
      doctor: { licenseNumber: "TX-ALLIE", licenseState: "TX", licenseExpiration: "2030-01-01", npiNumber: "4444444444", specialtyIds: [specialty.specialtyId], primarySpecialtyId: specialty.specialtyId },
    });
    assert.equal(doctor.status, 201);
    assert.equal((await admin.patch(`/api/admin/specialties/${specialty.specialtyId}/status`, { isActive: false })).status, 409);

    await admin.patch(`/api/admin/employees/${doctor.body.employeeId}/status`, { isActive: false });
    const before = await relatedSnapshot();
    const off = await admin.patch(`/api/admin/specialties/${specialty.specialtyId}/status`, { isActive: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.doctorCount, 1);
    assert.equal(off.body.activeDoctorCount, 0);
    assert.equal(await relatedSnapshot(), before);

    const on = await admin.patch(`/api/admin/specialties/${specialty.specialtyId}/status`, { isActive: true });
    assert.equal(on.body.isActive, true);
    assert.equal(on.body.doctorCount, 1);
  });

  test("setting the current status changes nothing", async () => {
    const res = await admin.patch(`/api/admin/specialties/${ids.retiredSpecialty}/status`, { isActive: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.isActive, false);
  });

  test("status rejects bad input, missing specialties, and invalid IDs", async () => {
    assert.equal((await admin.patch(`/api/admin/specialties/${ids.familyMedicine}/status`, { isActive: 1 })).status, 400);
    assert.equal((await admin.patch("/api/admin/specialties/99999/status", { isActive: true })).status, 404);
    assert.equal((await admin.patch("/api/admin/specialties/x/status", { isActive: true })).status, 400);
  });
});

describe("employee form compatibility", () => {
  test("doctors can't be given inactive specialties", async () => {
    const res = await admin.post("/api/admin/employees", {
      firstName: "Spec", lastName: "Doctor", dob: "1980-01-01", email: "spec@test.org", phone: "1", employeeTypeId: 2, officeId: ids.mainOffice,
      doctor: { licenseNumber: "TX-SPEC", licenseState: "TX", licenseExpiration: "2030-01-01", npiNumber: "8888888888", specialtyIds: [ids.retiredSpecialty], primarySpecialtyId: ids.retiredSpecialty },
    });
    assert.equal(res.status, 400);
  });

  test("existing doctor assignments stay visible", async () => {
    const dan = await admin.get(`/api/admin/employees/${ids.doctor}`);
    assert.deepEqual(
      dan.body.doctor.specialties.map((s: { name: string }) => s.name),
      ["Family Medicine", "Cardiology"]
    );
  });
});

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient } from "./helpers/testApp.js";
import { ids, resetDatabase } from "./helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let visitor: TestClient;

// IDs created by PUBLIC_DATA, in insert order
const dermatology = 4;
const eveningShift = 2;
const ella = 5;
const ivan = 6;
const sara = 7;

// extra doctors and schedules covering each active and inactive case
const PUBLIC_DATA = `
  INSERT INTO specialty (name) VALUES ('Dermatology');
  INSERT INTO shift_type (name, start_time, end_time, is_active) VALUES ('Evening', '13:00', '17:00', false);

  -- 5 Ella has no schedules, 6 Ivan is inactive, 7 Sara has a mix of valid and invalid schedules
  INSERT INTO employee (first_name, last_name, dob, employee_type_id, phone, email, office_id, is_active) VALUES
    ('Ella', 'Early', '1982-02-02', 2, '713-555-1005', 'ella@test.org', ${ids.westsideOffice}, true),
    ('Ivan', 'Inactive', '1970-06-06', 2, '713-555-1006', 'ivan@test.org', ${ids.westsideOffice}, false),
    ('Sara', 'Second', '1988-08-08', 2, '713-555-1007', 'sara@test.org', ${ids.mainOffice}, true);

  INSERT INTO doctor VALUES
    (${ella}, 'TX-ELLA5', 'TX', '2030-01-01', '5555555555', 'EE5555555'),
    (${ivan}, 'TX-IVAN6', 'TX', '2030-01-01', '6666666666', NULL),
    (${sara}, 'TX-SARA7', 'TX', '2030-01-01', '7777777777', NULL);

  INSERT INTO doctor_specialty (doctor_id, specialty_id, is_primary, is_active) VALUES
    (${ella}, ${ids.cardiology}, true, true),
    (${ivan}, ${ids.familyMedicine}, true, true),
    (${sara}, ${ids.familyMedicine}, true, true),
    (${sara}, ${ids.cardiology}, false, false),
    (${sara}, ${ids.retiredSpecialty}, false, true);

  INSERT INTO doctor_schedule (doctor_id, day_of_week, office_id, specialty_id, shift_type_id, is_active) VALUES
    (${ivan}, 'Tuesday', ${ids.westsideOffice}, ${ids.familyMedicine}, ${ids.morningShift}, true),
    (${sara}, 'Wednesday', ${ids.westsideOffice}, ${ids.familyMedicine}, ${ids.morningShift}, true),
    (${sara}, 'Monday', ${ids.westsideOffice}, ${ids.familyMedicine}, ${ids.morningShift}, true),
    (${sara}, 'Tuesday', ${ids.closedOffice}, ${ids.familyMedicine}, ${ids.morningShift}, true),
    (${sara}, 'Thursday', ${ids.mainOffice}, ${ids.cardiology}, ${ids.morningShift}, true),
    (${sara}, 'Friday', ${ids.mainOffice}, ${ids.familyMedicine}, ${ids.morningShift}, false),
    (${sara}, 'Saturday', ${ids.mainOffice}, ${ids.familyMedicine}, ${eveningShift}, true),
    (${sara}, 'Sunday', ${ids.mainOffice}, ${ids.retiredSpecialty}, ${ids.morningShift}, true);
`;

const mainStreet = { officeId: ids.mainOffice, name: "Main Street Clinic", street: "1 Main St", apt: null, city: "Houston", state: "TX", zip: "77001", phone: "713-555-0100" };
const westside = { officeId: ids.westsideOffice, name: "Westside Clinic", street: "2 West St", apt: null, city: "Houston", state: "TX", zip: "77002", phone: "713-555-0200" };

const familyMedicine = (isPrimary: boolean) => ({ specialtyId: ids.familyMedicine, name: "Family Medicine", isPrimary });
const cardiology = (isPrimary: boolean) => ({ specialtyId: ids.cardiology, name: "Cardiology", isPrimary });

const BAD_IDS = ["abc", "0", "-1", "1.5", "99999999999"];

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  await app.db.query(PUBLIC_DATA);
  visitor = app.client();
});

after(() => app.close());

describe("public doctors", () => {
  test("directory lists active doctors with active specialties, primary first", async () => {
    const res = await visitor.get("/api/public/doctors");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [
      { doctorId: ids.doctor, firstName: "Dan", lastName: "Doctor", specialties: [familyMedicine(true), cardiology(false)], offices: [{ officeId: ids.mainOffice, name: "Main Street Clinic" }] },
      { doctorId: ella, firstName: "Ella", lastName: "Early", specialties: [cardiology(true)], offices: [] },
      { doctorId: sara, firstName: "Sara", lastName: "Second", specialties: [familyMedicine(true)], offices: [{ officeId: ids.westsideOffice, name: "Westside Clinic" }] },
    ]);
  });

  test("a doctor without schedules has no practice offices, even with a home office", async () => {
    const res = await visitor.get(`/api/public/doctors/${ella}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.offices, []);
  });

  test("details show each scheduled office once with its weekdays in order", async () => {
    const res = await visitor.get(`/api/public/doctors/${sara}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      doctorId: sara,
      firstName: "Sara",
      lastName: "Second",
      specialties: [familyMedicine(true)],
      offices: [{ ...westside, days: ["Monday", "Wednesday"] }],
    });

    const dan = await visitor.get(`/api/public/doctors/${ids.doctor}`);
    assert.deepEqual(dan.body.offices, [{ ...mainStreet, days: ["Monday"] }]);
  });

  test("inactive doctors and other employees return 404", async () => {
    for (const id of [ivan, ids.admin, ids.nurse, ids.receptionist, 99999]) {
      const res = await visitor.get(`/api/public/doctors/${id}`);
      assert.equal(res.status, 404, String(id));
      assert.equal(res.body.error, "Doctor not found");
    }
  });

  test("invalid IDs return 400", async () => {
    for (const bad of BAD_IDS) {
      const res = await visitor.get(`/api/public/doctors/${bad}`);
      assert.equal(res.status, 400, bad);
      assert.equal(res.body.error, "ID must be a positive whole number");
    }
  });
});

describe("public offices", () => {
  test("directory lists only active offices", async () => {
    const res = await visitor.get("/api/public/offices");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [mainStreet, westside]);
  });

  test("details list only doctors and specialties backed by active schedules", async () => {
    const main = await visitor.get(`/api/public/offices/${ids.mainOffice}`);
    assert.equal(main.status, 200);
    assert.deepEqual(main.body, {
      ...mainStreet,
      doctors: [{ doctorId: ids.doctor, firstName: "Dan", lastName: "Doctor", days: ["Monday"] }],
      specialties: [{ specialtyId: ids.cardiology, name: "Cardiology" }],
    });

    const west = await visitor.get(`/api/public/offices/${ids.westsideOffice}`);
    assert.deepEqual(west.body.doctors, [{ doctorId: sara, firstName: "Sara", lastName: "Second", days: ["Monday", "Wednesday"] }]);
    assert.deepEqual(west.body.specialties, [{ specialtyId: ids.familyMedicine, name: "Family Medicine" }]);
  });

  test("inactive and missing offices return 404, invalid IDs return 400", async () => {
    for (const id of [ids.closedOffice, 99999]) {
      const res = await visitor.get(`/api/public/offices/${id}`);
      assert.equal(res.status, 404, String(id));
      assert.equal(res.body.error, "Office not found");
    }
    for (const bad of BAD_IDS) {
      assert.equal((await visitor.get(`/api/public/offices/${bad}`)).status, 400, bad);
    }
  });
});

describe("public specialties", () => {
  test("lists active specialties with referral rules and active doctor counts", async () => {
    const res = await visitor.get("/api/public/specialties");
    assert.equal(res.status, 200);
    // Cardiology has Dan and Ella, not Sara's inactive assignment
    // Family Medicine has Dan and Sara once each, not inactive Ivan
    assert.deepEqual(res.body, [
      { specialtyId: ids.cardiology, name: "Cardiology", requiresReferral: true, doctorCount: 2 },
      { specialtyId: dermatology, name: "Dermatology", requiresReferral: false, doctorCount: 0 },
      { specialtyId: ids.familyMedicine, name: "Family Medicine", requiresReferral: false, doctorCount: 2 },
    ]);
  });
});

describe("public API safety", () => {
  const PUBLIC_PATHS = [
    "/api/public/doctors",
    ...[ids.doctor, ella, sara].map((id) => `/api/public/doctors/${id}`),
    "/api/public/offices",
    ...[ids.mainOffice, ids.westsideOffice].map((id) => `/api/public/offices/${id}`),
    "/api/public/specialties",
  ];

  const ALLOWED_FIELDS = [
    "doctorId", "firstName", "lastName", "specialties", "specialtyId", "name", "isPrimary", "offices", "officeId",
    "street", "apt", "city", "state", "zip", "phone", "days", "doctors", "requiresReferral", "doctorCount",
  ];

  function fieldNames(value: unknown, names = new Set<string>()) {
    if (Array.isArray(value)) value.forEach((item) => fieldNames(item, names));
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        names.add(key);
        fieldNames(child, names);
      }
    }
    return names;
  }

  test("responses contain only public fields and no private values", async () => {
    const bodies = [];
    for (const path of PUBLIC_PATHS) {
      const res = await visitor.get(path);
      assert.equal(res.status, 200, path);
      bodies.push(res.body);
    }

    const unexpected = [...fieldNames(bodies)].filter((name) => !ALLOWED_FIELDS.includes(name));
    assert.deepEqual(unexpected, []);

    const text = JSON.stringify(bodies);
    const { rows } = await app.db.query(`SELECT password_hash FROM employee_creds UNION ALL SELECT password_hash FROM patient_creds`);
    const privateValues = [
      ...rows.map((r) => r.password_hash),
      "1975-05-05", "1982-02-02", "1988-08-08",
      "@test.org", "713-555-100", "TX-DAN1", "TX-ELLA5", "1111111111", "5555555555", "EE5555555",
      "Pat", "713-555-9000",
    ];
    for (const value of privateValues) assert.equal(text.includes(value), false, value);
  });

  test("public routes are read only", async () => {
    for (const send of [visitor.post, visitor.put, visitor.patch]) {
      assert.equal((await send("/api/public/offices", { name: "New Office" })).status, 404);
      assert.equal((await send(`/api/public/offices/${ids.mainOffice}`, { name: "Renamed" })).status, 404);
    }
    const res = await visitor.get("/api/public/offices");
    assert.deepEqual(res.body, [mainStreet, westside]);
  });

  test("admin directories still require an admin login", async () => {
    for (const path of ["/api/admin/offices", "/api/admin/specialties", "/api/admin/employees", "/api/admin/schedules"]) {
      assert.equal((await visitor.get(path)).status, 401, path);
    }
  });

  test("server errors don't reveal database details", async () => {
    const logError = console.error;
    console.error = () => {};
    await app.db.query("ALTER TABLE office RENAME TO office_hidden");
    try {
      const res = await visitor.get("/api/public/offices");
      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { error: "Something went wrong. Please try again later." });
    } finally {
      await app.db.query("ALTER TABLE office_hidden RENAME TO office");
      console.error = logError;
    }
  });
});

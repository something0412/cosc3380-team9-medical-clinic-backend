import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient, TestResponse } from "./helpers/testApp.js";
import { TEST_PASSWORD, ids, resetDatabase } from "./helpers/testDb.js";

// what each role got back is written here (git-ignored) so it can be looked at after a run
const outputDir = new URL("./output/role-access/", import.meta.url);

type RoleName = "anonymous" | "patient" | "doctor" | "nurse" | "receptionist" | "admin";
const ROLE_NAMES: RoleName[] = ["anonymous", "patient", "doctor", "nurse", "receptionist", "admin"];

interface Role {
  name: RoleName;
  id: number;
  client: TestClient;
}

interface Endpoint {
  label: string;
  path: (role: Role) => string;
  expect: Record<RoleName, number>;
}

// patient 2 is created by the test so cross-patient access can be checked
const OTHER_PATIENT = 2;

// extra rows so the patient and staff endpoints return something to look at
const SAMPLE_DATA = `
  INSERT INTO time_slot (shift_type_id, start_time, end_time) VALUES (1, '08:00', '08:30'), (1, '08:30', '09:00');
  INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, status, booking_channel) VALUES
    (1, 2, 1, CURRENT_DATE + 7, 1, 1, 'Scheduled', 'Web'),
    (1, 2, 1, CURRENT_DATE - 7, 2, 1, 'Completed', 'Web'),
    (2, 2, 1, CURRENT_DATE + 14, 1, 1, 'Scheduled', 'Web');
  INSERT INTO appointment_summary (appointment_id, visit_reason, notes, recorded_by_employee_id) VALUES (2, 'Seasonal allergies', 'Follow up in 6 months', 2);
  INSERT INTO payment_type (name) VALUES ('Credit Card');
  INSERT INTO invoice (patient_id, appointment_id, amount, status) VALUES (1, 2, 150.00, 'Pending'), (2, 3, 80.00, 'Pending');
  INSERT INTO payment (invoice_id, payment_type_id, handled_by, amount_paid) VALUES (1, 1, 4, 50.00);
  INSERT INTO emergency_contact (patient_id, first_name, last_name, relationship, phone_number, is_primary) VALUES (1, 'Sam', 'Patient', 'Spouse', '713-555-9001', true);
  INSERT INTO insurance (patient_id, provider, policy_number, status) VALUES (1, 'Blue Cross', 'BC-1001', 'Verified');
  INSERT INTO form_type (name, is_required) VALUES ('New Patient Intake', true), ('HIPAA Consent', true);
  INSERT INTO certificate (employee_id, name, issue_date, expiration_date) VALUES (3, 'BLS', '2025-01-01', '2027-01-01');
`;

// expected status per role
const PUBLIC = { anonymous: 200, patient: 200, doctor: 200, nurse: 200, receptionist: 200, admin: 200 };
const LOGGED_IN = { anonymous: 401, patient: 200, doctor: 200, nurse: 200, receptionist: 200, admin: 200 };
const STAFF_ONLY = { anonymous: 401, patient: 401, doctor: 200, nurse: 200, receptionist: 200, admin: 200 };
const OWN_PATIENT = { anonymous: 401, patient: 200, doctor: 401, nurse: 401, receptionist: 401, admin: 401 };
const OTHER_PATIENT_DATA = { anonymous: 401, patient: 403, doctor: 401, nurse: 401, receptionist: 401, admin: 401 };
const OWN_STAFF = { anonymous: 401, patient: 401, doctor: 200, nurse: 200, receptionist: 200, admin: 200 };
const OTHER_STAFF = { anonymous: 401, patient: 401, doctor: 403, nurse: 403, receptionist: 403, admin: 403 };
const ADMIN_ONLY = { anonymous: 401, patient: 403, doctor: 403, nurse: 403, receptionist: 403, admin: 200 };

const fixed = (path: string) => () => path;
const PATIENT_SECTIONS = ["profile", "appointments", "forms", "billing", "records", "dashboard"];

// every GET endpoint in the app
const ENDPOINTS: Endpoint[] = [
  { label: "GET /api/health", path: fixed("/api/health"), expect: PUBLIC },
  { label: "GET /api/template", path: fixed("/api/template"), expect: PUBLIC },
  { label: "GET /api/auth/me", path: fixed("/api/auth/me"), expect: LOGGED_IN },
  { label: "GET /api/patients", path: fixed("/api/patients"), expect: STAFF_ONLY },
  ...PATIENT_SECTIONS.map((section) => ({
    label: `GET /api/patient/<own>/${section}`,
    path: fixed(`/api/patient/${ids.patient}/${section}`),
    expect: OWN_PATIENT,
  })),
  ...PATIENT_SECTIONS.map((section) => ({
    label: `GET /api/patient/<other>/${section}`,
    path: fixed(`/api/patient/${OTHER_PATIENT}/${section}`),
    expect: OTHER_PATIENT_DATA,
  })),
  { label: "GET /api/staff/<own>/profile", path: (role) => `/api/staff/${role.id}/profile`, expect: OWN_STAFF },
  {
    label: "GET /api/staff/<other>/profile",
    path: (role) => `/api/staff/${role.id === ids.doctor ? ids.nurse : ids.doctor}/profile`,
    expect: OTHER_STAFF,
  },
  ...[
    "/api/admin/employee-types",
    "/api/admin/employees",
    `/api/admin/employees/${ids.doctor}`,
    "/api/admin/offices",
    `/api/admin/offices/${ids.mainOffice}`,
    "/api/admin/specialties",
    `/api/admin/specialties/${ids.cardiology}`,
    "/api/admin/schedules",
    "/api/admin/schedules/doctor-options",
    `/api/admin/schedules/${ids.doctor}/Monday`,
    "/api/admin/shift-types",
  ].map((path) => ({ label: `GET ${path}`, path: fixed(path), expect: ADMIN_ONLY })),
];

// keeps the first few items of every list so the output stays small
function sample(value: unknown): unknown {
  if (Array.isArray(value)) {
    const kept = value.slice(0, 3).map(sample);
    return value.length > 3 ? [...kept, `... ${value.length - 3} more`] : kept;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, sample(v)]));
  }
  return value;
}

const statusIcon = (status: number) => (status === 200 ? "✅ 200" : status === 401 ? "🔒 401" : status === 403 ? "⛔ 403" : `⚠️ ${status}`);

let app: Awaited<ReturnType<typeof startTestApp>>;
const roles = {} as Record<RoleName, Role>;
const results = {} as Record<RoleName, Record<string, TestResponse>>;
let passwordHashes: string[] = [];

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  const admin = await app.loginStaff(ids.admin);

  // the receptionist has no login in the fixtures
  const receptionistLogin = await admin.post(`/api/admin/employees/${ids.receptionist}/login`, { username: "rita.access", password: TEST_PASSWORD });
  assert.equal(receptionistLogin.status, 201);

  const signup = await app.client().post("/api/auth/patient/signup", {
    firstName: "Olive",
    lastName: "Other",
    dob: "1995-02-02",
    phone: "713-555-9100",
    email: "olive@test.org",
    password: TEST_PASSWORD,
  });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.patientId, OTHER_PATIENT);

  await app.db.query(SAMPLE_DATA);

  roles.anonymous = { name: "anonymous", id: ids.admin, client: app.client() };
  roles.patient = { name: "patient", id: ids.patient, client: await app.loginPatient(ids.patient, "pat@test.org") };
  roles.doctor = { name: "doctor", id: ids.doctor, client: await app.loginStaff(ids.doctor) };
  roles.nurse = { name: "nurse", id: ids.nurse, client: await app.loginStaff(ids.nurse) };
  roles.receptionist = { name: "receptionist", id: ids.receptionist, client: await app.loginStaff(ids.receptionist) };
  roles.admin = { name: "admin", id: ids.admin, client: admin };

  const hashes = await app.db.query(`SELECT password_hash FROM employee_creds UNION ALL SELECT password_hash FROM patient_creds`);
  passwordHashes = hashes.rows.map((r) => r.password_hash);

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
});

after(async () => {
  // permission matrix across every role
  const header = `| Endpoint | ${ROLE_NAMES.join(" | ")} |\n|---|${ROLE_NAMES.map(() => "---").join("|")}|`;
  const rows = ENDPOINTS.map((endpoint) => {
    const cells = ROLE_NAMES.map((name) => {
      const status = results[name]?.[endpoint.label]?.status;
      if (status === undefined) return "—";
      return status === endpoint.expect[name] ? statusIcon(status) : `❗ ${status} (expected ${endpoint.expect[name]})`;
    });
    return `| \`${endpoint.label}\` | ${cells.join(" | ")} |`;
  });
  const summary = [
    "# Role access matrix",
    "",
    `Generated by \`tests/roleAccess.test.ts\` on ${new Date().toISOString()} against the local test database.`,
    "",
    "✅ data returned · 🔒 401 not logged in as the right kind of user · ⛔ 403 logged in but not allowed · ❗ unexpected",
    "",
    header,
    ...rows,
    "",
    "The data each role got back is in the `<role>.json` files next to this one.",
    "",
  ].join("\n");
  await writeFile(new URL("summary.md", outputDir), summary);
  await app?.close();
});

describe("role access", () => {
  for (const name of ROLE_NAMES) {
    test(`${name} can reach only the data its role allows`, async () => {
      const role = roles[name];
      const responses: Record<string, TestResponse> = {};
      for (const endpoint of ENDPOINTS) {
        responses[endpoint.label] = await role.client.get(endpoint.path(role));
      }
      results[name] = responses;

      const me = responses["GET /api/auth/me"];
      const report = {
        role: name,
        loggedInAs: me.status === 200 ? me.body : null,
        canAccess: ENDPOINTS.filter((e) => responses[e.label].status === 200).map((e) => e.label),
        denied: ENDPOINTS.filter((e) => responses[e.label].status !== 200).map((e) => `${e.label} -> ${responses[e.label].status}`),
        data: Object.fromEntries(
          ENDPOINTS.filter((e) => responses[e.label].status === 200).map((e) => [e.label, sample(responses[e.label].body)])
        ),
      };
      await writeFile(new URL(`${name}.json`, outputDir), JSON.stringify(report, null, 2) + "\n");

      const mismatches = ENDPOINTS.filter((e) => responses[e.label].status !== e.expect[name]).map(
        (e) => `${e.label}: got ${responses[e.label].status}, expected ${e.expect[name]}`
      );
      assert.deepEqual(mismatches, []);
    });
  }

  test("no response leaks a password hash", () => {
    const allBodies = JSON.stringify(results);
    assert.doesNotMatch(allBodies, /password_?hash/i);
    for (const hash of passwordHashes) assert.equal(allBodies.includes(hash), false);
  });

  test("a patient's portal only shows their own rows", () => {
    const own = results.patient;
    assert.ok(own, "patient role ran");
    assert.deepEqual(own[`GET /api/patient/<own>/appointments`].body.map((a: any) => a.appointmentId).sort(), [1, 2]);
    assert.deepEqual(own[`GET /api/patient/<own>/billing`].body.invoices.map((i: any) => i.invoiceId), [1]);
    assert.equal(own[`GET /api/patient/<own>/profile`].body.patientId, ids.patient);
  });

  test("staff profiles show the logged-in employee's own details", () => {
    for (const name of ["doctor", "nurse", "receptionist", "admin"] as const) {
      const profile = results[name]?.["GET /api/staff/<own>/profile"];
      assert.equal(profile?.body.employeeId, roles[name].id, name);
    }
    assert.ok(results.doctor["GET /api/staff/<own>/profile"].body.doctor, "doctor details");
    assert.ok(results.nurse["GET /api/staff/<own>/profile"].body.nurse, "nurse details");
  });
});

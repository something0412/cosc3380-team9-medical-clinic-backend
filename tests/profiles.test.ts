import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient } from "./helpers/testApp.js";
import { TEST_PASSWORD, ids, resetDatabase } from "./helpers/testDb.js";

// patient 2 signs up in before()
const OLIVE = 2;

let app: Awaited<ReturnType<typeof startTestApp>>;
let anonymous: TestClient, pat: TestClient, olive: TestClient, nurse: TestClient, doctor: TestClient, receptionist: TestClient;

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  const admin = await app.loginStaff(ids.admin);

  // the receptionist has no login in the fixtures
  const login = await admin.post(`/api/admin/employees/${ids.receptionist}/login`, { username: "rita.profile", password: TEST_PASSWORD });
  assert.equal(login.status, 201);
  const signup = await app.client().post("/api/auth/patient/signup", {
    firstName: "Olive",
    lastName: "Other",
    dob: "1995-02-02",
    phone: "713-555-9100",
    email: "olive@test.org",
    password: TEST_PASSWORD,
  });
  assert.equal(signup.body.patientId, OLIVE);

  anonymous = app.client();
  pat = await app.loginPatient(ids.patient, "pat@test.org");
  olive = await app.loginPatient(OLIVE, "olive@test.org");
  nurse = await app.loginStaff(ids.nurse);
  doctor = await app.loginStaff(ids.doctor);
  receptionist = await app.loginStaff(ids.receptionist);
});

after(() => app.close());

function send(client: TestClient, method: string, path: string, body: unknown = {}) {
  if (method === "GET") return client.get(path);
  if (method === "POST") return client.post(path, body);
  if (method === "PUT") return client.put(path, body);
  if (method === "PATCH") return client.patch(path, body);
  return client.delete(path);
}

// every route in routes/patient and routes/staff, with the patient or employee the path belongs to
const patientRoutes = (id: number) => [
  ["GET", `/api/patient/${id}/appointments`],
  ["GET", `/api/patient/${id}/forms`],
  ["GET", `/api/patient/${id}/billing`],
  ["GET", `/api/patient/${id}/records`],
  ["GET", `/api/patient/${id}/dashboard`],
  ["GET", `/api/patient/${id}/profile`],
  ["PUT", `/api/patient/${id}/profile`],
  ["POST", `/api/patient/${id}/emergency-contacts`],
  ["PUT", `/api/patient/${id}/emergency-contacts/1`],
  ["DELETE", `/api/patient/${id}/emergency-contacts/1`],
  ["PUT", `/api/patient/${id}/insurance`],
  ["PUT", `/api/patient/${id}/password`],
];
const staffRoutes = (id: number) => [
  ["GET", `/api/staff/${id}/profile`],
  ["PUT", `/api/staff/${id}/profile`],
  ["POST", `/api/staff/${id}/certificates`],
  ["PUT", `/api/staff/${id}/certificates/1`],
  ["DELETE", `/api/staff/${id}/certificates/1`],
  ["PUT", `/api/staff/${id}/password`],
];

describe("route registration", () => {
  test("every patient and staff route still answers, with 401 when signed out", async () => {
    const routes = [...patientRoutes(ids.patient), ...staffRoutes(ids.nurse), ["GET", "/api/patients"], ["POST", "/api/patients"]];
    assert.equal(routes.length, 20);
    for (const [method, path] of routes) {
      assert.equal((await send(anonymous, method, path)).status, 401, `${method} ${path}`);
    }
  });

  test("patients and employees can't use routes that belong to someone else", async () => {
    for (const [method, path] of patientRoutes(OLIVE)) {
      assert.equal((await send(pat, method, path)).status, 403, `patient: ${method} ${path}`);
    }
    for (const [method, path] of staffRoutes(ids.doctor)) {
      assert.equal((await send(nurse, method, path)).status, 403, `nurse: ${method} ${path}`);
    }
    for (const [method, path] of [...staffRoutes(ids.nurse), ["GET", "/api/patients"], ["POST", "/api/patients"]]) {
      assert.equal((await send(pat, method, path)).status, 401, `patient on staff route: ${method} ${path}`);
    }
  });
});

describe("patient profile", () => {
  test("a patient reads and updates their contact details, and the new email signs in", async () => {
    const before = await olive.get(`/api/patient/${OLIVE}/profile`);
    assert.equal(before.status, 200);
    assert.equal(before.body.email, "olive@test.org");

    const update = { phone: "713-555-9111", email: "olive.new@test.org", address: "9 Elm St", gender: null };
    assert.equal((await olive.put(`/api/patient/${OLIVE}/profile`, update)).status, 204);
    const after = await olive.get(`/api/patient/${OLIVE}/profile`);
    assert.equal(after.body.phone, "713-555-9111");
    assert.equal(after.body.address, "9 Elm St");

    const login = await app.client().post("/api/auth/patient/login", { patientId: OLIVE, email: "olive.new@test.org", password: TEST_PASSWORD });
    assert.equal(login.status, 200);
    const taken = await olive.put(`/api/patient/${OLIVE}/profile`, { ...update, email: "pat@test.org" });
    assert.equal(taken.status, 409);
  });

  test("emergency contacts can be added, edited, and removed by their own patient only", async () => {
    const contact = { firstName: "Sam", lastName: "Other", relationship: "Brother", phoneNumber: "713-555-9200", isPrimary: true };
    assert.equal((await olive.post(`/api/patient/${OLIVE}/emergency-contacts`, contact)).status, 201);
    assert.equal((await olive.post(`/api/patient/${OLIVE}/emergency-contacts`, { ...contact, firstName: "Ann", isPrimary: true })).status, 201);

    const contacts = (await olive.get(`/api/patient/${OLIVE}/profile`)).body.emergencyContacts;
    assert.deepEqual(contacts.map((c: { firstName: string; isPrimary: boolean }) => [c.firstName, c.isPrimary]), [["Ann", true], ["Sam", false]]);
    const sam = contacts.find((c: { firstName: string }) => c.firstName === "Sam").emergencyContactId;

    assert.equal((await olive.put(`/api/patient/${OLIVE}/emergency-contacts/${sam}`, { ...contact, phoneNumber: "713-555-9201", isPrimary: false })).status, 204);
    // the contact belongs to Olive, so it isn't found under Pat's own path
    assert.equal((await pat.put(`/api/patient/${ids.patient}/emergency-contacts/${sam}`, contact)).status, 404);
    assert.equal((await olive.delete(`/api/patient/${OLIVE}/emergency-contacts/${sam}`)).status, 204);

    const left = (await olive.get(`/api/patient/${OLIVE}/profile`)).body.emergencyContacts;
    assert.deepEqual(left.map((c: { firstName: string }) => c.firstName), ["Ann"]);
    assert.equal((await olive.put(`/api/patient/${OLIVE}/emergency-contacts/999`, contact)).status, 404);
    assert.equal((await olive.post(`/api/patient/${OLIVE}/emergency-contacts`, { ...contact, phoneNumber: "" })).status, 400);
  });

  test("insurance is saved as pending, and a policy number can't belong to two patients", async () => {
    assert.equal((await olive.put(`/api/patient/${OLIVE}/insurance`, { provider: "Aetna", policyNumber: "AE-2002" })).status, 204);
    assert.deepEqual((await olive.get(`/api/patient/${OLIVE}/profile`)).body.insurance, { provider: "Aetna", policyNumber: "AE-2002", status: "Pending" });
    assert.equal((await pat.put(`/api/patient/${ids.patient}/insurance`, { provider: "Aetna", policyNumber: "AE-2002" })).status, 409);
  });

  test("a password change needs the current password and at least 8 characters", async () => {
    const path = `/api/patient/${OLIVE}/password`;
    const wrong = await olive.put(path, { currentPassword: "not-it", newPassword: "New-Password-1" });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /Current password is incorrect/);
    assert.equal((await olive.put(path, { currentPassword: TEST_PASSWORD, newPassword: "short" })).status, 400);
    assert.equal((await olive.put(path, { currentPassword: TEST_PASSWORD, newPassword: "New-Password-1" })).status, 204);

    const login = (password: string) =>
      app.client().post("/api/auth/patient/login", { patientId: OLIVE, email: "olive.new@test.org", password });
    assert.equal((await login("New-Password-1")).status, 200);
    assert.equal((await login(TEST_PASSWORD)).status, 401);
  });
});

describe("patient records", () => {
  const visit = { none: 0, one: 0, several: 0, noSummary: 0, pats: 0 };

  before(async () => {
    const { rows } = await app.db.query(`INSERT INTO time_slot (shift_type_id, start_time, end_time) VALUES (1, '08:00', '08:30') RETURNING time_slot_id`);
    const slot = rows[0].time_slot_id;
    const appointment = async (patientId: number, date: string) =>
      (
        await app.db.query(
          `INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, status, booking_channel)
           VALUES ($1, $2, 1, $3, $4, 1, 'Completed', 'Web') RETURNING appointment_id`,
          [patientId, ids.doctor, date, slot]
        )
      ).rows[0].appointment_id as number;
    const summary = (appointmentId: number, visitReason: string, notes: string) =>
      app.db.query(`INSERT INTO appointment_summary (appointment_id, visit_reason, notes, recorded_by_employee_id) VALUES ($1, $2, $3, $4)`, [
        appointmentId, visitReason, notes, ids.doctor,
      ]);
    const diagnosis = (appointmentId: number, name: string, createdAt: string) =>
      app.db.query(`INSERT INTO visit_diagnosis (appointment_id, name, recorded_by_employee_id, created_at) VALUES ($1, $2, $3, $4)`, [
        appointmentId, name, ids.doctor, createdAt,
      ]);

    visit.none = await appointment(OLIVE, "2026-01-05");
    visit.one = await appointment(OLIVE, "2026-02-05");
    visit.several = await appointment(OLIVE, "2026-03-05");
    visit.noSummary = await appointment(OLIVE, "2026-04-05");
    visit.pats = await appointment(ids.patient, "2026-01-06");

    await summary(visit.none, "Annual checkup", "All normal");
    await summary(visit.one, "Sneezing and itchy eyes", "Start antihistamine");
    await summary(visit.several, "Follow up on blood pressure", "Recheck in 3 months");
    await summary(visit.pats, "Headaches", "Keep a headache diary");
    await diagnosis(visit.one, "Seasonal allergies", "2026-02-05 09:00");
    // added second but recorded first, so it should be listed first
    await diagnosis(visit.several, "Type 2 diabetes", "2026-03-05 10:00");
    await diagnosis(visit.several, "Hypertension", "2026-03-05 09:00");
    await diagnosis(visit.pats, "Migraine", "2026-01-06 09:00");

    await app.db.query(`
      INSERT INTO medication (name) VALUES ('Loratadine');
      INSERT INTO prescription (patient_id, prescriber_id, appointment_id) VALUES (${OLIVE}, ${ids.doctor}, ${visit.one});
      INSERT INTO prescription_item (prescription_id, medication_id, dosage, instructions) VALUES (1, 1, '10 mg', 'Once a day');
      INSERT INTO lab_test_type (name, cost) VALUES ('Allergy panel', 120);
      INSERT INTO lab_order (patient_id, ordered_by_employee_id, lab_test_type_id, appointment_id, status, result_notes)
      VALUES (${OLIVE}, ${ids.doctor}, 1, ${visit.one}, 'Completed', 'Pollen allergy');
    `);
  });

  const visitsOf = async (client: TestClient, patientId: number) => {
    const res = await client.get(`/api/patient/${patientId}/records`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.visits as { appointmentId: number; visitDate: string; diagnosis: string | null; visitReason: string; notes: string }[];
  };

  test("a visit with no diagnosis returns null and still shows its visit reason", async () => {
    const none = (await visitsOf(olive, OLIVE)).find((v) => v.appointmentId === visit.none);
    assert.deepEqual(Object.keys(none ?? {}).sort(), ["appointmentId", "diagnosis", "notes", "visitDate", "visitReason"]);
    assert.equal(none?.diagnosis, null);
    assert.equal(none?.visitReason, "Annual checkup");
    assert.equal(none?.notes, "All normal");
    assert.equal(typeof none?.visitDate, "string");
  });

  test("one or several diagnoses are combined in recorded order, with one row per visit", async () => {
    const res = await olive.get(`/api/patient/${OLIVE}/records`);
    assert.ok(Array.isArray(res.body.prescriptions) && Array.isArray(res.body.labResults));
    // newest visit first, and the visit without a summary isn't listed
    assert.deepEqual(
      res.body.visits.map((v: { appointmentId: number; diagnosis: string | null; visitReason: string }) => [v.appointmentId, v.diagnosis, v.visitReason]),
      [
        [visit.several, "Hypertension, Type 2 diabetes", "Follow up on blood pressure"],
        [visit.one, "Seasonal allergies", "Sneezing and itchy eyes"],
        [visit.none, null, "Annual checkup"],
      ]
    );
  });

  test("prescriptions and lab results keep their format alongside visits", async () => {
    const res = await olive.get(`/api/patient/${OLIVE}/records`);
    assert.deepEqual(Object.keys(res.body).sort(), ["labResults", "prescriptions", "visits"]);
    assert.deepEqual(res.body.prescriptions, [
      { prescriptionItemId: 1, medicationName: "Loratadine", dosage: "10 mg", instructions: "Once a day", isActive: true },
    ]);
    assert.equal(res.body.labResults.length, 1);
    assert.deepEqual(Object.keys(res.body.labResults[0]).sort(), ["labOrderId", "orderDate", "resultNotes", "testName"]);
    assert.equal(res.body.labResults[0].testName, "Allergy panel");
    assert.equal(res.body.labResults[0].resultNotes, "Pollen allergy");
  });

  test("patients only see their own records", async () => {
    const own = await pat.get(`/api/patient/${ids.patient}/records`);
    assert.deepEqual([own.body.prescriptions, own.body.labResults], [[], []]);
    assert.deepEqual((await visitsOf(pat, ids.patient)).map((v) => [v.appointmentId, v.diagnosis]), [[visit.pats, "Migraine"]]);
    assert.equal((await pat.get(`/api/patient/${OLIVE}/records`)).status, 403);
    assert.equal((await anonymous.get(`/api/patient/${OLIVE}/records`)).status, 401);
  });
});

describe("staff profile", () => {
  test("an employee reads and updates their own profile", async () => {
    const own = await nurse.get(`/api/staff/${ids.nurse}/profile`);
    assert.equal(own.status, 200);
    assert.equal(own.body.employeeType, "Nurse");
    assert.equal(own.body.nurse.nursingLevel, "RN");
    assert.equal(own.body.doctor, null);

    const update = await nurse.put(`/api/staff/${ids.nurse}/profile`, { phone: "713-555-3333" });
    assert.deepEqual([update.status, update.body], [200, { phone: "713-555-3333" }]);
    assert.equal((await nurse.get(`/api/staff/${ids.nurse}/profile`)).body.phone, "713-555-3333");
    assert.equal((await nurse.put(`/api/staff/${ids.nurse}/profile`, { phone: " " })).status, 400);

    const doctorProfile = (await doctor.get(`/api/staff/${ids.doctor}/profile`)).body.doctor;
    assert.equal(doctorProfile.specialties.length, 2);
    assert.equal(doctorProfile.schedule[0].dayOfWeek, "Monday");
  });

  test("certificates can be added, edited, and removed by their own employee only", async () => {
    const path = `/api/staff/${ids.nurse}/certificates`;
    const created = await nurse.post(path, { name: "BLS", issueDate: "2025-01-01", expirationDate: "2030-01-01" });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "Active");
    const expired = await nurse.post(path, { name: "ACLS", issueDate: "2020-01-01", expirationDate: "2022-01-01" });
    assert.equal(expired.body.status, "Expired");
    assert.equal((await nurse.post(path, { name: "PALS", issueDate: "2025-01-01", expirationDate: "2024-01-01" })).status, 400);

    const id = created.body.certificateId;
    const edited = await nurse.put(`${path}/${id}`, { name: "BLS Renewal", issueDate: "2025-01-01", expirationDate: "2031-01-01" });
    assert.deepEqual([edited.status, edited.body.name], [200, "BLS Renewal"]);
    // the certificate belongs to the nurse, so it isn't found under the doctor's own path
    assert.equal((await doctor.delete(`/api/staff/${ids.doctor}/certificates/${id}`)).status, 404);
    assert.equal((await nurse.delete(`${path}/${id}`)).status, 204);
    assert.equal((await nurse.delete(`${path}/${id}`)).status, 404);

    const left = (await nurse.get(`/api/staff/${ids.nurse}/profile`)).body.certificates;
    assert.deepEqual(left.map((c: { name: string }) => c.name), ["ACLS"]);
  });

  test("a staff password change follows the same rules", async () => {
    const path = `/api/staff/${ids.receptionist}/password`;
    assert.equal((await receptionist.put(path, { currentPassword: "not-it", newPassword: "New-Password-1" })).status, 400);
    assert.equal((await receptionist.put(path, { currentPassword: TEST_PASSWORD, newPassword: "short" })).status, 400);
    assert.equal((await receptionist.put(path, { currentPassword: TEST_PASSWORD, newPassword: "New-Password-1" })).status, 204);
    assert.equal(await app.staffLoginStatus(ids.receptionist, "New-Password-1"), 200);
    assert.equal(await app.staffLoginStatus(ids.receptionist), 401);
  });
});

describe("employee patient management", () => {
  test("receptionists list and register patients, other staff, patients and visitors can't", async () => {
    const list = await receptionist.get("/api/patients");
    assert.equal(list.status, 200);
    assert.ok(list.body.some((p: { patientId: number }) => p.patientId === OLIVE));

    const created = await receptionist.post("/api/patients", { firstName: "Walk", lastName: "In", dob: "1988-08-08", phone: "713-555-9300" });
    assert.equal(created.status, 201);
    assert.equal(created.body.firstName, "Walk");
    assert.equal(created.body.isActive, true);
    assert.equal((await receptionist.post("/api/patients", { firstName: "No", lastName: "Phone", dob: "1988-08-08" })).status, 400);

    for (const employee of [nurse, doctor]) {
      assert.equal((await employee.get("/api/patients")).status, 403);
      assert.equal((await employee.post("/api/patients", { firstName: "A", lastName: "B", dob: "1990-01-01", phone: "1" })).status, 403);
    }
    assert.equal((await pat.get("/api/patients")).status, 401);
    assert.equal((await anonymous.post("/api/patients", { firstName: "A", lastName: "B", dob: "1990-01-01", phone: "1" })).status, 401);
  });
});

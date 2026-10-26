import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { addAppointment, addDoctor, addPatient, addSlots, waitForLockWait } from "../helpers/appointmentData.js";
import { slowWrites } from "../helpers/dbFaults.js";
import { startTestApp } from "../helpers/testApp.js";
import type { TestClient, TestResponse } from "../helpers/testApp.js";
import { TEST_PASSWORD, ids, resetDatabase } from "../helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let admin: TestClient;
let today: string;
let labTypeId: number;
let slots: Awaited<ReturnType<typeof addSlots>>;
let counter = 0;

const ADMIN_TYPE = 1;
const DOCTOR_TYPE = 2;
const NURSE_TYPE = 3;
const RECEPTIONIST_TYPE = 4;

const statuses = (responses: TestResponse[]) => responses.map((r) => r.status).sort();
const row = async (sql: string, params: unknown[] = []) => (await app.db.query(sql, params)).rows[0];
const count = async (sql: string, params: unknown[] = []) => Number((await row(sql, params)).n);

function person(overrides: object = {}) {
  counter += 1;
  return {
    firstName: "Emma",
    lastName: `Staff${counter}`,
    dob: "1990-02-02",
    email: `emma${counter}@clinic.test`,
    phone: "713-555-6000",
    employeeTypeId: RECEPTIONIST_TYPE,
    officeId: ids.mainOffice,
    ...overrides,
  };
}

const doctorLicense = () => ({ licenseNumber: `MD-EM${counter}`, licenseState: "TX", licenseExpiration: "2031-01-01", npiNumber: String(5000000000 + counter), deaNumber: null });
const nurseLicense = () => ({ licenseNumber: `RN-EM${counter}`, licenseState: "TX", licenseExpiration: "2031-01-01", nursingLevel: "RN" });

async function created(res: Promise<TestResponse>) {
  const result = await res;
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

// a doctor made through the employee page with the given specialties, the first one primary
function newDoctor(specialtyIds: number[] = [ids.familyMedicine]) {
  const body = person({ employeeTypeId: DOCTOR_TYPE });
  return created(admin.post("/api/admin/employees", { ...body, doctor: { ...doctorLicense(), specialtyIds, primarySpecialtyId: specialtyIds[0] } }));
}

async function visit(doctorId: number, opts: { days?: number; status?: string; specialtyId?: number; checkedIn?: boolean; officeId?: number } = {}) {
  const patientId = await addPatient(app.db, "Vee", `Visit${++counter}`);
  const date = (await row(`SELECT ($1::date + $2::int)::text AS d`, [today, opts.days ?? 7])).d;
  const appointmentId = await addAppointment(app.db, { patientId, doctorId, officeId: opts.officeId ?? ids.mainOffice, date, timeSlotId: slots.allDay, status: opts.status });
  if (opts.specialtyId) await app.db.query(`UPDATE appointment SET specialty_id = $2 WHERE appointment_id = $1`, [appointmentId, opts.specialtyId]);
  if (opts.checkedIn) await app.db.query(`UPDATE appointment SET checked_in_at = now() WHERE appointment_id = $1`, [appointmentId]);
  return { patientId, appointmentId };
}

// holds some changes open in their own transaction while a request waits on them
async function whileHeld(changes: [string, unknown[]][], send: () => Promise<TestResponse>) {
  const held = await app.db.connect();
  try {
    await held.query("BEGIN");
    for (const [sql, params] of changes) await held.query(sql, params);
    const waiting = send();
    await waitForLockWait(app.db);
    await held.query("COMMIT");
    return await waiting;
  } catch (err) {
    await held.query("ROLLBACK");
    throw err;
  } finally {
    held.release();
  }
}

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  admin = await app.loginStaff(ids.admin);
  today = (await row(`SELECT ((now() AT TIME ZONE 'America/Chicago')::date)::text AS d`)).d;
  slots = await addSlots(app.db);
  labTypeId = (await row(`INSERT INTO employee_types (type_name) VALUES ('Lab Technician') RETURNING employee_type_id AS id`)).id;
});

after(async () => {
  await app.close();
});

describe("one set of employee rules behind both admin pages", () => {
  test("the staff page creates employees through the same rules, with the email as the login username", async () => {
    const lab = await created(admin.post("/api/admin/staff", { ...person({ employeeTypeId: labTypeId }), password: TEST_PASSWORD, doctor: null, nurse: null }));
    assert.deepEqual([lab.employeeType, lab.hasLogin, lab.doctor, lab.nurse], ["Lab Technician", true, null, null]);
    assert.equal((await row(`SELECT username FROM employee_creds WHERE employee_id = $1`, [lab.employeeId])).username, lab.email);
    const me = (await (await app.loginStaff(lab.employeeId)).get("/api/auth/me")).body;
    assert.deepEqual([me.role, me.staffType], ["lab", "lab"]);

    const doctorBody = person({ employeeTypeId: DOCTOR_TYPE });
    const doctor = await created(
      admin.post("/api/admin/staff", { ...doctorBody, password: TEST_PASSWORD, doctor: { ...doctorLicense(), specialtyId: ids.cardiology }, nurse: null })
    );
    assert.deepEqual(doctor.doctor.specialties, [{ specialtyId: ids.cardiology, name: "Cardiology", isPrimary: true }]);

    // the same checks the employee page has, which the staff page used to skip
    const refused: [object, number, string][] = [
      [{ ...person({ employeeTypeId: NURSE_TYPE }), password: TEST_PASSWORD, doctor: null, nurse: null }, 400, "Nurse license details are required"],
      [{ ...person({ officeId: ids.closedOffice }), password: TEST_PASSWORD }, 400, "Selected office does not exist"],
      [{ ...person({ email: doctorBody.email }), password: TEST_PASSWORD }, 409, "Another employee already uses that email"],
      [{ ...person({ employeeTypeId: labTypeId }), password: TEST_PASSWORD, nurse: nurseLicense() }, 400, "Only nurses can have nurse details"],
      [{ ...person({ dob: "2999-01-01" }), password: TEST_PASSWORD }, 400, "Date of birth must be in the past"],
      [{ ...person(), password: "short" }, 400, "Password must be at least 8 characters"],
    ];
    const before = await count(`SELECT count(*) AS n FROM employee`);
    for (const [body, status, error] of refused) {
      const res = await admin.post("/api/admin/staff", body);
      assert.deepEqual([res.status, res.body.error], [status, error], JSON.stringify(body));
    }
    assert.equal(await count(`SELECT count(*) AS n FROM employee`), before);
  });

  test("a staff page edit changes only its fields and keeps the role, doctor details and login", async () => {
    const doctor = await newDoctor([ids.familyMedicine, ids.cardiology]);
    await app.db.query(`INSERT INTO employee_creds (employee_id, username, password_hash) SELECT $1, 'doc.login', password_hash FROM employee_creds WHERE employee_id = $2`, [
      doctor.employeeId,
      ids.admin,
    ]);
    const res = await admin.put(`/api/admin/staff/${doctor.employeeId}`, { firstName: "Renamed", lastName: doctor.lastName, phone: "713-555-6111", email: doctor.email, officeId: ids.westsideOffice });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      [res.body.firstName, res.body.phone, res.body.officeId, res.body.dob, res.body.employeeType, res.body.doctor.npiNumber, res.body.doctor.specialties.length],
      ["Renamed", "713-555-6111", ids.westsideOffice, doctor.dob, "Doctor", doctor.doctor.npiNumber, 2]
    );
    assert.equal((await row(`SELECT username FROM employee_creds WHERE employee_id = $1`, [doctor.employeeId])).username, "doc.login");

    const edit = (body: object) => admin.put(`/api/admin/staff/${doctor.employeeId}`, { firstName: "Renamed", lastName: doctor.lastName, phone: "713-555-6111", email: doctor.email, officeId: ids.westsideOffice, ...body });
    assert.deepEqual((await edit({ officeId: ids.closedOffice })).body, { error: "Selected office does not exist" });
    assert.deepEqual((await edit({ email: "nina@test.org" })).body, { error: "Another employee already uses that email" });
    assert.deepEqual((await admin.put("/api/admin/staff/999999", { firstName: "A", lastName: "B", phone: "1", email: "nobody@clinic.test", officeId: 1 })).body, { error: "Employee not found" });
    assert.equal((await row(`SELECT office_id FROM employee WHERE employee_id = $1`, [doctor.employeeId])).office_id, ids.westsideOffice);
  });

  test("both directories list each employee once with the same status and role filters", async () => {
    const doctor = await newDoctor([ids.familyMedicine, ids.cardiology]);
    const leaver = await created(admin.post("/api/admin/employees", person()));
    assert.equal((await admin.patch(`/api/admin/employees/${leaver.employeeId}/status`, { isActive: false })).status, 200);

    const employees = (await admin.get("/api/admin/employees")).body;
    assert.equal(employees.filter((e: { employeeId: number }) => e.employeeId === doctor.employeeId).length, 1);
    assert.equal(new Set(employees.map((e: { employeeId: number }) => e.employeeId)).size, employees.length);
    const staff = (await admin.get("/api/admin/staff?status=all")).body;
    const listed = staff.find((e: { employeeId: number }) => e.employeeId === doctor.employeeId);
    assert.deepEqual([listed.role, listed.roleDetail], ["Doctor", "Family Medicine"]);
    assert.equal(staff.length, employees.length);

    const inactive = (await admin.get("/api/admin/employees?status=inactive")).body.map((e: { employeeId: number }) => e.employeeId);
    assert.ok(inactive.includes(leaver.employeeId) && !inactive.includes(doctor.employeeId), "inactive filter");
    assert.equal((await admin.get("/api/admin/staff")).body.some((e: { employeeId: number }) => e.employeeId === leaver.employeeId), false);
    assert.ok((await admin.get("/api/admin/employees?type=Nurse")).body.every((e: { employeeType: string }) => e.employeeType === "Nurse"), "type filter");
    assert.equal((await admin.get("/api/admin/employees?status=gone")).status, 400);
  });

  test("two admins saving the same email at once end up with one employee", async () => {
    const body = person();
    const restore = await slowWrites(app.db, "employee", "INSERT");
    let both: TestResponse[];
    try {
      both = await Promise.all([admin.post("/api/admin/employees", body), admin.post("/api/admin/staff", { ...body, lastName: "Twin", password: TEST_PASSWORD })]);
    } finally {
      await restore();
    }
    assert.deepEqual(statuses(both), [201, 409]);
    assert.equal(await count(`SELECT count(*) AS n FROM employee WHERE email = $1`, [body.email]), 1);
  });
});

describe("activation and deactivation", () => {
  test("both pages deactivate the same way, the login stays enabled, and the session ends on the next request", async () => {
    const worker = await created(admin.post("/api/admin/staff", { ...person(), password: TEST_PASSWORD }));
    const session = await app.loginStaff(worker.employeeId);
    assert.equal((await session.get("/api/auth/me")).status, 200);

    const off = await admin.patch(`/api/admin/staff/${worker.employeeId}/status`, { isActive: false });
    assert.deepEqual([off.status, off.body.isActive, off.body.loginActive], [200, false, true]);
    assert.equal((await session.get("/api/auth/me")).status, 401);
    assert.equal(await app.staffLoginStatus(worker.employeeId), 401);

    assert.equal((await admin.patch(`/api/admin/employees/${worker.employeeId}/status`, { isActive: true })).body.isActive, true);
    assert.equal((await (await app.loginStaff(worker.employeeId)).get("/api/auth/me")).status, 200);

    for (const path of ["staff", "employees"]) {
      assert.deepEqual((await admin.patch(`/api/admin/${path}/${ids.admin}/status`, { isActive: false })).body, { error: "You can't deactivate your own account" });
    }
  });

  test("a doctor with upcoming visits can't be deactivated, and past visits don't count or change", async () => {
    const doctor = await newDoctor();
    const upcoming = await visit(doctor.employeeId, { days: 7 });
    const arrived = await visit(doctor.employeeId, { days: 0, checkedIn: true });
    const history = [
      await visit(doctor.employeeId, { days: -3, status: "Completed" }),
      await visit(doctor.employeeId, { days: -4, status: "No Show" }),
      await visit(doctor.employeeId, { days: 8, status: "Cancelled" }),
    ];

    const blocked = await admin.patch(`/api/admin/employees/${doctor.employeeId}/status`, { isActive: false });
    assert.deepEqual([blocked.status, blocked.body.error], [409, "2 upcoming appointments are booked with this doctor. Reschedule or cancel them first."]);
    await app.db.query(`UPDATE appointment SET status = 'Completed', checked_out_at = now() WHERE appointment_id = $1`, [arrived.appointmentId]);
    assert.deepEqual((await admin.patch(`/api/admin/staff/${doctor.employeeId}/status`, { isActive: false })).body.error, "1 upcoming appointment is booked with this doctor. Reschedule or cancel it first.");

    await app.db.query(`UPDATE appointment SET status = 'Cancelled' WHERE appointment_id = $1`, [upcoming.appointmentId]);
    assert.equal((await admin.patch(`/api/admin/employees/${doctor.employeeId}/status`, { isActive: false })).status, 200);
    const kept = await app.db.query(`SELECT status FROM appointment WHERE appointment_id = ANY($1::int[]) ORDER BY appointment_id`, [history.map((h) => h.appointmentId)]);
    assert.deepEqual(kept.rows.map((r) => r.status), ["Completed", "No Show", "Cancelled"]);
  });

  test("a booking in progress is waited for before a doctor is deactivated, and the other way around", async () => {
    const doctor = await newDoctor();
    const patientId = await addPatient(app.db, "Bo", "Booking");
    const date = (await row(`SELECT ($1::date + 10)::text AS d`, [today])).d;
    const deactivation = await whileHeld(
      [
        [`SELECT 1 FROM employee WHERE employee_id = $1 FOR SHARE`, [doctor.employeeId]],
        [
          `INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, booking_channel) VALUES ($1, $2, $3, $4, $5, $6, 'Web')`,
          [patientId, doctor.employeeId, ids.mainOffice, date, slots.allDay, ids.familyMedicine],
        ],
      ],
      () => admin.patch(`/api/admin/employees/${doctor.employeeId}/status`, { isActive: false })
    );
    assert.deepEqual([deactivation.status, deactivation.body.error], [409, "1 upcoming appointment is booked with this doctor. Reschedule or cancel it first."]);

    // the schedule waits for a deactivation that started first, and then sees it
    const other = await newDoctor();
    const schedule = await whileHeld([[`UPDATE employee SET is_active = false WHERE employee_id = $1`, [other.employeeId]]], () =>
      admin.post("/api/admin/schedules", { doctorId: other.employeeId, dayOfWeek: "Tuesday", officeId: ids.mainOffice, specialtyId: ids.familyMedicine, shiftTypeId: ids.morningShift })
    );
    assert.deepEqual([schedule.status, schedule.body.error], [409, "The doctor doesn't exist or is inactive"]);
  });

  test("reactivation needs an active office and keeps the doctor and nurse records", async () => {
    const nurse = await created(admin.post("/api/admin/employees", { ...person({ employeeTypeId: NURSE_TYPE }), nurse: nurseLicense() }));
    const before = await row(`SELECT * FROM nurse WHERE employee_id = $1`, [nurse.employeeId]);
    assert.equal((await admin.patch(`/api/admin/employees/${nurse.employeeId}/status`, { isActive: false })).status, 200);
    await app.db.query(`UPDATE employee SET office_id = $2 WHERE employee_id = $1`, [nurse.employeeId, ids.closedOffice]);

    assert.deepEqual((await admin.patch(`/api/admin/employees/${nurse.employeeId}/status`, { isActive: true })).body, {
      error: "Move this employee to an active office before reactivating them",
    });
    await app.db.query(`UPDATE employee SET office_id = $2 WHERE employee_id = $1`, [nurse.employeeId, ids.westsideOffice]);
    const back = await admin.patch(`/api/admin/staff/${nurse.employeeId}/status`, { isActive: true });
    assert.deepEqual([back.status, back.body.isActive, back.body.nurse.nursingLevel], [200, true, "RN"]);
    assert.deepEqual(await row(`SELECT * FROM nurse WHERE employee_id = $1`, [nurse.employeeId]), before);
    // asking for the status it already has changes nothing
    assert.equal((await admin.patch(`/api/admin/employees/${nurse.employeeId}/status`, { isActive: true })).status, 200);
  });
});

describe("office moves and role changes", () => {
  test("moving a nurse changes whose charts they can open on their next request", async () => {
    const nurse = await created(admin.post("/api/admin/employees", { ...person({ employeeTypeId: NURSE_TYPE, officeId: ids.westsideOffice }), nurse: nurseLicense(), login: { username: `nurse${counter}`, password: TEST_PASSWORD } }));
    const westPatient = (await visit(await addDoctor(app.db, "West", ids.westsideOffice), { days: 0, officeId: ids.westsideOffice })).patientId;
    const mainPatient = (await visit(await addDoctor(app.db, "Main", ids.mainOffice), { days: 0, officeId: ids.mainOffice })).patientId;
    const session = await app.loginStaff(nurse.employeeId);
    assert.deepEqual([(await session.get(`/api/nurse/patients/${westPatient}`)).status, (await session.get(`/api/nurse/patients/${mainPatient}`)).status], [200, 403]);

    const moved = await admin.put(`/api/admin/staff/${nurse.employeeId}`, { firstName: nurse.firstName, lastName: nurse.lastName, phone: nurse.phone, email: nurse.email, officeId: ids.mainOffice });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal((await session.get("/api/auth/me")).body.officeId, ids.mainOffice);
    assert.deepEqual([(await session.get(`/api/nurse/patients/${westPatient}`)).status, (await session.get(`/api/nurse/patients/${mainPatient}`)).status], [403, 200]);
  });

  test("a receptionist can become a lab technician and the new role applies on the next request", async () => {
    const worker = await created(admin.post("/api/admin/employees", { ...person(), login: { username: `desk${counter}`, password: TEST_PASSWORD } }));
    const session = await app.loginStaff(worker.employeeId);
    assert.equal((await session.get("/api/receptionist/appointments")).status, 200);

    const { employeeId, firstName, lastName, dob, email, phone, officeId } = worker;
    const changed = await admin.put(`/api/admin/employees/${employeeId}`, { firstName, lastName, dob, email, phone, officeId, employeeTypeId: labTypeId });
    assert.equal(changed.body.employeeType, "Lab Technician");
    assert.equal((await session.get("/api/auth/me")).body.role, "lab");
    assert.deepEqual([(await session.get("/api/receptionist/appointments")).status, (await session.get("/api/lab/orders")).status], [403, 200]);

    // doctor and nurse records can't be added or dropped by changing the role
    const nurseRole = await admin.put(`/api/admin/employees/${employeeId}`, { firstName, lastName, dob, email, phone, officeId, employeeTypeId: NURSE_TYPE, nurse: nurseLicense() });
    assert.deepEqual([nurseRole.status, nurseRole.body.error], [409, "Changing a role to or from Doctor or Nurse is not supported yet"]);
    assert.equal(await count(`SELECT count(*) AS n FROM nurse WHERE employee_id = $1`, [employeeId]), 0);
  });
});

describe("doctor specialties", () => {
  const editDoctor = (doctor: { employeeId: number; firstName: string; lastName: string; dob: string; email: string; phone: string; officeId: number; doctor: object }, specialtyIds: number[]) => {
    const { employeeId, firstName, lastName, dob, email, phone, officeId } = doctor;
    return admin.put(`/api/admin/employees/${employeeId}`, {
      firstName, lastName, dob, email, phone, officeId, employeeTypeId: DOCTOR_TYPE,
      doctor: { ...(doctor.doctor as object), specialtyIds, primarySpecialtyId: specialtyIds[0] },
    });
  };

  test("a specialty with upcoming visits can't be removed, but one with only past visits can", async () => {
    const doctor = await newDoctor([ids.familyMedicine, ids.cardiology]);
    await visit(doctor.employeeId, { days: -5, status: "Completed", specialtyId: ids.cardiology });
    const upcoming = await visit(doctor.employeeId, { days: 6, specialtyId: ids.cardiology });

    const blocked = await editDoctor(doctor, [ids.familyMedicine]);
    assert.deepEqual([blocked.status, blocked.body.error], [409, "Cardiology has upcoming appointments with this doctor and can't be removed. Reschedule or cancel them first."]);
    assert.equal(await count(`SELECT count(*) AS n FROM doctor_specialty WHERE doctor_id = $1 AND is_active`, [doctor.employeeId]), 2);

    await app.db.query(`UPDATE appointment SET status = 'Cancelled' WHERE appointment_id = $1`, [upcoming.appointmentId]);
    const removed = await editDoctor(doctor, [ids.familyMedicine]);
    assert.deepEqual(removed.body.doctor.specialties.map((s: { name: string }) => s.name), ["Family Medicine"]);
    assert.equal((await row(`SELECT is_active FROM doctor_specialty WHERE doctor_id = $1 AND specialty_id = $2`, [doctor.employeeId, ids.cardiology])).is_active, false);
    assert.equal((await editDoctor(doctor, [ids.familyMedicine, ids.retiredSpecialty])).status, 400);
  });

  test("the same specialty assigned twice, or by two requests at once, is stored once", async () => {
    const doctor = await newDoctor([ids.familyMedicine]);
    assert.equal((await editDoctor(doctor, [ids.familyMedicine, ids.cardiology, ids.cardiology])).status, 200);
    const both = await Promise.all([editDoctor(doctor, [ids.familyMedicine, ids.cardiology]), editDoctor(doctor, [ids.familyMedicine, ids.cardiology])]);
    assert.deepEqual(statuses(both), [200, 200]);
    assert.equal(await count(`SELECT count(*) AS n FROM doctor_specialty WHERE doctor_id = $1 AND specialty_id = $2`, [doctor.employeeId, ids.cardiology]), 1);
  });

  test("a specialty removal and a booking or schedule for it can't both win", async () => {
    const doctor = await newDoctor([ids.familyMedicine, ids.cardiology]);
    const patientId = await addPatient(app.db, "Cy", "Cardio");
    const date = (await row(`SELECT ($1::date + 12)::text AS d`, [today])).d;
    const removal = await whileHeld(
      [
        [`SELECT 1 FROM employee WHERE employee_id = $1 FOR SHARE`, [doctor.employeeId]],
        [
          `INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, booking_channel) VALUES ($1, $2, $3, $4, $5, $6, 'Web')`,
          [patientId, doctor.employeeId, ids.mainOffice, date, slots.allDay, ids.cardiology],
        ],
      ],
      () => editDoctor(doctor, [ids.familyMedicine])
    );
    assert.equal(removal.status, 409, JSON.stringify(removal.body));

    const other = await newDoctor([ids.familyMedicine, ids.cardiology]);
    const schedule = await whileHeld(
      [
        [`SELECT 1 FROM employee WHERE employee_id = $1 FOR NO KEY UPDATE`, [other.employeeId]],
        [`UPDATE doctor_specialty SET is_active = false WHERE doctor_id = $1 AND specialty_id = $2`, [other.employeeId, ids.cardiology]],
      ],
      () => admin.post("/api/admin/schedules", { doctorId: other.employeeId, dayOfWeek: "Monday", officeId: ids.mainOffice, specialtyId: ids.cardiology, shiftTypeId: ids.morningShift })
    );
    assert.deepEqual([schedule.status, schedule.body.error], [409, "The doctor isn't assigned to that specialty"]);
    assert.equal(await count(`SELECT count(*) AS n FROM doctor_schedule WHERE doctor_id = $1`, [other.employeeId]), 0);
  });
});

describe("who can manage employees", () => {
  test("only admins can create, edit or change the status of employees", async () => {
    const target = await created(admin.post("/api/admin/employees", person()));
    const labId = (await created(admin.post("/api/admin/employees", { ...person({ employeeTypeId: labTypeId }), login: { username: `lab${counter}`, password: TEST_PASSWORD } }))).employeeId;
    const receptionistId = (await created(admin.post("/api/admin/employees", { ...person(), login: { username: `rec${counter}`, password: TEST_PASSWORD } }))).employeeId;
    const clients: [string, TestClient, number][] = [
      ["signed out", app.client(), 401],
      ["patient", await app.loginPatient(ids.patient, "pat@test.org"), 403],
      ["doctor", await app.loginStaff(ids.doctor), 403],
      ["nurse", await app.loginStaff(ids.nurse), 403],
      ["receptionist", await app.loginStaff(receptionistId), 403],
      ["lab", await app.loginStaff(labId), 403],
    ];
    const before = await row(`SELECT * FROM employee WHERE employee_id = $1`, [target.employeeId]);
    const employeesBefore = await count(`SELECT count(*) AS n FROM employee`);
    for (const [name, client, status] of clients) {
      const tries = [
        client.post("/api/admin/employees", person()),
        client.post("/api/admin/staff", { ...person(), password: TEST_PASSWORD }),
        client.put(`/api/admin/staff/${target.employeeId}`, { firstName: "Hacked", lastName: "X", phone: "1", email: "hacked@clinic.test", officeId: ids.mainOffice }),
        client.patch(`/api/admin/employees/${target.employeeId}/status`, { isActive: false }),
        client.patch(`/api/admin/staff/${target.employeeId}/status`, { isActive: false }),
        client.get(`/api/admin/employees/${target.employeeId}`),
      ];
      for (const res of await Promise.all(tries)) assert.equal(res.status, status, `${name} got ${res.status}`);
    }
    assert.deepEqual(await row(`SELECT * FROM employee WHERE employee_id = $1`, [target.employeeId]), before);
    assert.equal(await count(`SELECT count(*) AS n FROM employee`), employeesBefore);
  });
});

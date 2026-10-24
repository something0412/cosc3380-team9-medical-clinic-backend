import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "../helpers/testApp.js";
import type { TestClient } from "../helpers/testApp.js";
import { ids, resetDatabase } from "../helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let admin: TestClient;
let counter = 0;

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  admin = await app.loginStaff(ids.admin);
});

after(() => app.close());

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// small builders that go through the real Admin API
async function created(res: Promise<{ status: number; body: any }>) {
  const { status, body } = await res;
  assert.equal(status, 201, JSON.stringify(body));
  return body;
}

function newOffice(name: string) {
  return created(admin.post("/api/admin/offices", { name, street: "10 Test St", city: "Austin", state: "TX", zip: "78701", phone: "512-555-0100" }));
}

function newSpecialty(name: string, requiresReferral = false) {
  return created(admin.post("/api/admin/specialties", { name, requiresReferral }));
}

function newShift(name: string, startTime: string, endTime: string) {
  return created(admin.post("/api/admin/shift-types", { name, startTime, endTime }));
}

function newSlot(shiftTypeId: number, startTime: string, endTime: string) {
  return created(admin.post(`/api/admin/shift-types/${shiftTypeId}/time-slots`, { startTime, endTime }));
}

function employeeBody(overrides: object = {}) {
  counter += 1;
  return {
    firstName: "Int",
    lastName: `Tester${counter}`,
    dob: "1985-04-04",
    email: `integration${counter}@test.org`,
    phone: "713-555-3000",
    employeeTypeId: 4,
    officeId: ids.mainOffice,
    ...overrides,
  };
}

function newDoctor(specialtyIds: number[], officeId: number = ids.mainOffice) {
  const body = employeeBody({ employeeTypeId: 2, officeId });
  return created(
    admin.post("/api/admin/employees", {
      ...body,
      login: { username: body.email, password: "Doctor-Pass-1" },
      doctor: {
        licenseNumber: `TX-INT${counter}`,
        licenseState: "TX",
        licenseExpiration: "2031-01-01",
        npiNumber: String(5000000000 + counter),
        specialtyIds,
        primarySpecialtyId: specialtyIds[0],
      },
    })
  );
}

function newSchedule(doctorId: number, dayOfWeek: string, officeId: number, specialtyId: number, shiftTypeId: number) {
  return created(admin.post("/api/admin/schedules", { doctorId, dayOfWeek, officeId, specialtyId, shiftTypeId }));
}

// an appointment on the next given weekday, or a past one when weeksAgo is set
async function bookAppointment(a: { doctorId: number; day: string; officeId: number; specialtyId: number; timeSlotId: number; weeksAgo?: number }) {
  const { rows } = await app.db.query(
    `
    INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, booking_channel)
    VALUES ($1, $2, $3, CURRENT_DATE + (($4 - EXTRACT(ISODOW FROM CURRENT_DATE)::int + 7) % 7) - $5::int * 7, $6, $7, 'Web')
    RETURNING appointment_id
    `,
    [ids.patient, a.doctorId, a.officeId, DAYS.indexOf(a.day) + 1, a.weeksAgo ?? 0, a.timeSlotId, a.specialtyId]
  );
  return rows[0].appointment_id as number;
}

const row = async (sql: string, params: unknown[] = []) => (await app.db.query(sql, params)).rows[0];
const rows = async (sql: string, params: unknown[] = []) => (await app.db.query(sql, params)).rows;

describe("A: from new employee to doctor schedule", () => {
  test("office, specialty, doctor, shift, slots, and schedule all line up", async () => {
    const danBefore = await row("SELECT * FROM employee WHERE employee_id = $1", [ids.doctor]);
    const danScheduleBefore = await rows("SELECT * FROM doctor_schedule WHERE doctor_id = $1", [ids.doctor]);

    const office = await newOffice("Austin Clinic");
    const specialty = await newSpecialty("Neurology", true);
    const doctor = await newDoctor([specialty.specialtyId, ids.familyMedicine], office.officeId);
    const shift = await newShift("Afternoon", "13:00", "17:00");
    await newSlot(shift.shiftTypeId, "13:00", "13:30");
    await newSlot(shift.shiftTypeId, "13:30", "14:00");
    await newSchedule(doctor.employeeId, "Wednesday", office.officeId, specialty.specialtyId, shift.shiftTypeId);

    const schedule = (await admin.get(`/api/admin/schedules/${doctor.employeeId}/Wednesday`)).body;
    assert.equal(schedule.dayOfWeek, "Wednesday");
    assert.equal(schedule.officeName, "Austin Clinic");
    assert.equal(schedule.specialtyName, "Neurology");
    assert.equal(schedule.shiftName, "Afternoon");
    assert.equal(`${schedule.startTime}-${schedule.endTime}`, "13:00-17:00");
    assert.equal(schedule.isActive, true);

    const shifts = (await admin.get("/api/admin/shift-types")).body;
    const afternoon = shifts.find((s: { shiftTypeId: number }) => s.shiftTypeId === shift.shiftTypeId);
    assert.equal(afternoon.activeScheduleCount, 1);
    assert.deepEqual(
      afternoon.timeSlots.map((t: { startTime: string; endTime: string }) => `${t.startTime}-${t.endTime}`),
      ["13:00-13:30", "13:30-14:00"]
    );

    const details = (await admin.get(`/api/admin/employees/${doctor.employeeId}`)).body;
    assert.equal(details.officeName, "Austin Clinic");
    assert.equal(details.doctor.licenseNumber, doctor.doctor.licenseNumber);
    assert.deepEqual(
      details.doctor.specialties.map((s: { name: string; isPrimary: boolean }) => [s.name, s.isPrimary]),
      [["Neurology", true], ["Family Medicine", false]]
    );

    const officeDetails = (await admin.get(`/api/admin/offices/${office.officeId}`)).body;
    assert.equal(officeDetails.activeEmployeeCount, 1);
    assert.equal(officeDetails.activeScheduleCount, 1);
    const specialtyDetails = (await admin.get(`/api/admin/specialties/${specialty.specialtyId}`)).body;
    assert.equal(specialtyDetails.activeDoctorCount, 1);
    assert.equal(specialtyDetails.activeScheduleCount, 1);

    // the new doctor can sign in with the doctor role
    const doctorSession = await app.loginStaff(doctor.employeeId, "Doctor-Pass-1");
    assert.equal((await doctorSession.get("/api/auth/me")).body.role, "doctor");

    // fixture doctor untouched
    assert.deepEqual(await row("SELECT * FROM employee WHERE employee_id = $1", [ids.doctor]), danBefore);
    assert.deepEqual(await rows("SELECT * FROM doctor_schedule WHERE doctor_id = $1", [ids.doctor]), danScheduleBefore);
  });
});

describe("B: deactivation dependencies", () => {
  test("office deactivation waits until its employees are moved", async () => {
    const office = await newOffice("Moving Clinic");
    const employee = await created(admin.post("/api/admin/employees", employeeBody({ officeId: office.officeId })));
    assert.equal((await admin.patch(`/api/admin/offices/${office.officeId}/status`, { isActive: false })).status, 409);

    const employeeId = employee.employeeId;
    const moved = await admin.put(`/api/admin/employees/${employeeId}`, { ...employee, officeId: ids.westsideOffice });
    assert.equal(moved.status, 200);
    assert.equal((await admin.patch(`/api/admin/offices/${office.officeId}/status`, { isActive: false })).status, 200);

    // reactivating the office doesn't move anyone back
    assert.equal((await admin.patch(`/api/admin/offices/${office.officeId}/status`, { isActive: true })).status, 200);
    assert.equal((await row("SELECT office_id FROM employee WHERE employee_id = $1", [employeeId])).office_id, ids.westsideOffice);
  });

  test("specialty deactivation waits until no active doctor practices it", async () => {
    const specialty = await newSpecialty("Rheumatology");
    const doctor = await newDoctor([ids.familyMedicine, specialty.specialtyId]);
    assert.equal((await admin.patch(`/api/admin/specialties/${specialty.specialtyId}/status`, { isActive: false })).status, 409);

    // remove the specialty from the doctor through the employee edit form
    const details = (await admin.get(`/api/admin/employees/${doctor.employeeId}`)).body;
    const edited = await admin.put(`/api/admin/employees/${doctor.employeeId}`, {
      ...details,
      doctor: { ...details.doctor, specialtyIds: [ids.familyMedicine], primarySpecialtyId: ids.familyMedicine },
    });
    assert.equal(edited.status, 200);
    assert.equal((await admin.patch(`/api/admin/specialties/${specialty.specialtyId}/status`, { isActive: false })).status, 200);

    // reactivating the specialty doesn't restore the doctor's assignment
    assert.equal((await admin.patch(`/api/admin/specialties/${specialty.specialtyId}/status`, { isActive: true })).status, 200);
    const assignment = await row("SELECT is_active FROM doctor_specialty WHERE doctor_id = $1 AND specialty_id = $2", [doctor.employeeId, specialty.specialtyId]);
    assert.equal(assignment.is_active, false);
    const options = (await admin.get("/api/admin/schedules/doctor-options")).body;
    const option = options.find((d: { doctorId: number }) => d.doctorId === doctor.employeeId);
    assert.deepEqual(option.specialties.map((s: { specialtyId: number }) => s.specialtyId), [ids.familyMedicine]);
  });

  test("an active schedule blocks its office, specialty, and shift until it's deactivated", async () => {
    const office = await newOffice("Schedule Clinic");
    const specialty = await newSpecialty("Urology");
    const doctor = await newDoctor([specialty.specialtyId]);
    const shift = await newShift("Late", "17:00", "21:00");
    await newSchedule(doctor.employeeId, "Friday", office.officeId, specialty.specialtyId, shift.shiftTypeId);

    const officeStatus = `/api/admin/offices/${office.officeId}/status`;
    const specialtyStatus = `/api/admin/specialties/${specialty.specialtyId}/status`;
    const shiftStatus = `/api/admin/shift-types/${shift.shiftTypeId}/status`;
    assert.equal((await admin.patch(officeStatus, { isActive: false })).status, 409);
    const specialtyBlocked = await admin.patch(specialtyStatus, { isActive: false });
    assert.match(specialtyBlocked.body.error, /1 active doctor and 1 active doctor schedule/);
    assert.equal((await admin.patch(shiftStatus, { isActive: false })).status, 409);

    assert.equal((await admin.patch(`/api/admin/schedules/${doctor.employeeId}/Friday/status`, { isActive: false })).status, 200);
    assert.equal((await admin.patch(officeStatus, { isActive: false })).status, 200);
    assert.equal((await admin.patch(shiftStatus, { isActive: false })).status, 200);
    // the doctor still practices the specialty, so only the schedule part of the block goes away
    const stillBlocked = await admin.patch(specialtyStatus, { isActive: false });
    assert.equal(stillBlocked.status, 409);
    assert.doesNotMatch(stillBlocked.body.error, /schedule/);

    // the schedule row is kept for history
    const kept = await admin.get(`/api/admin/schedules/${doctor.employeeId}/Friday`);
    assert.equal(kept.status, 200);
    assert.equal(kept.body.isActive, false);
  });

  test("schedule reactivation checks each dependency and nothing reactivates on its own", async () => {
    const office = await newOffice("Reopen Clinic");
    const doctor = await newDoctor([ids.familyMedicine]);
    const shift = await newShift("Weekend", "09:00", "13:00");
    await newSchedule(doctor.employeeId, "Saturday", office.officeId, ids.familyMedicine, shift.shiftTypeId);
    const scheduleStatus = `/api/admin/schedules/${doctor.employeeId}/Saturday/status`;

    await admin.patch(scheduleStatus, { isActive: false });
    await admin.patch(`/api/admin/offices/${office.officeId}/status`, { isActive: false });
    await admin.patch(`/api/admin/shift-types/${shift.shiftTypeId}/status`, { isActive: false });

    const officeClosed = await admin.patch(scheduleStatus, { isActive: true });
    assert.equal(officeClosed.status, 409);
    assert.match(officeClosed.body.error, /office/);

    await admin.patch(`/api/admin/offices/${office.officeId}/status`, { isActive: true });
    assert.equal((await admin.get(`/api/admin/schedules/${doctor.employeeId}/Saturday`)).body.isActive, false, "office reactivation leaves the schedule off");
    const shiftClosed = await admin.patch(scheduleStatus, { isActive: true });
    assert.equal(shiftClosed.status, 409);
    assert.match(shiftClosed.body.error, /shift/);

    await admin.patch(`/api/admin/shift-types/${shift.shiftTypeId}/status`, { isActive: true });
    await admin.patch(`/api/admin/employees/${doctor.employeeId}/status`, { isActive: false });
    assert.match((await admin.patch(scheduleStatus, { isActive: true })).body.error, /doctor/);

    await admin.patch(`/api/admin/employees/${doctor.employeeId}/status`, { isActive: true });
    const reactivated = await admin.patch(scheduleStatus, { isActive: true });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.isActive, true);
  });

  test("deactivating a doctor leaves their schedules for the admin to handle", async () => {
    const doctor = await newDoctor([ids.familyMedicine]);
    await newSchedule(doctor.employeeId, "Sunday", ids.westsideOffice, ids.familyMedicine, ids.morningShift);
    await admin.patch(`/api/admin/employees/${doctor.employeeId}/status`, { isActive: false });

    const schedule = (await admin.get(`/api/admin/schedules/${doctor.employeeId}/Sunday`)).body;
    assert.equal(schedule.isActive, true);
    assert.equal(schedule.doctorIsActive, false);
    // the schedule can still be turned off, and the doctor disappears from the options for new assignments
    assert.equal((await admin.patch(`/api/admin/schedules/${doctor.employeeId}/Sunday/status`, { isActive: false })).status, 200);
    const options = (await admin.get("/api/admin/schedules/doctor-options")).body;
    assert.equal(options.some((d: { doctorId: number }) => d.doctorId === doctor.employeeId), false);
  });
});

describe("C: employee accounts and sign-in", () => {
  test("login lifecycle keeps employee status and login status separate", async () => {
    const employee = await created(admin.post("/api/admin/employees", employeeBody()));
    const id = employee.employeeId;
    const path = `/api/admin/employees/${id}`;
    const profileBefore = await row("SELECT * FROM employee WHERE employee_id = $1", [id]);

    assert.equal(employee.hasLogin, false);
    assert.equal(await app.staffLoginStatus(id, "First-Pass-1"), 401);

    await created(admin.post(`${path}/login`, { username: `login${id}`, password: "First-Pass-1" }));
    assert.equal(await app.staffLoginStatus(id, "First-Pass-1"), 200);

    await admin.patch(`${path}/login-status`, { loginActive: false });
    assert.equal(await app.staffLoginStatus(id, "First-Pass-1"), 401);
    await admin.patch(`${path}/login-status`, { loginActive: true });
    assert.equal(await app.staffLoginStatus(id, "First-Pass-1"), 200);

    const deactivated = await admin.patch(`${path}/status`, { isActive: false });
    assert.equal(deactivated.body.loginActive, true);
    assert.equal(await app.staffLoginStatus(id, "First-Pass-1"), 401);
    await admin.patch(`${path}/status`, { isActive: true });
    assert.equal(await app.staffLoginStatus(id, "First-Pass-1"), 200);

    // a reset while disabled keeps the login disabled, and the old password stops working once it's enabled again
    await admin.patch(`${path}/login-status`, { loginActive: false });
    assert.equal((await admin.put(`${path}/password`, { password: "Second-Pass-2" })).status, 204);
    assert.equal((await admin.get(path)).body.loginActive, false);
    assert.equal(await app.staffLoginStatus(id, "Second-Pass-2"), 401);
    await admin.patch(`${path}/login-status`, { loginActive: true });
    assert.equal(await app.staffLoginStatus(id, "First-Pass-1"), 401);
    assert.equal(await app.staffLoginStatus(id, "Second-Pass-2"), 200);

    // none of this touched the employee's profile
    assert.deepEqual(await row("SELECT * FROM employee WHERE employee_id = $1", [id]), profileBefore);
  });

  test("Admin access follows the role on the server, not the client", async () => {
    const body = employeeBody();
    const employee = await created(admin.post("/api/admin/employees", { ...body, login: { username: body.email, password: "Role-Pass-1" } }));

    const asReceptionist = await app.loginStaff(employee.employeeId, "Role-Pass-1");
    assert.equal((await asReceptionist.get("/api/auth/me")).body.role, "staff");
    assert.equal((await asReceptionist.get("/api/admin/employees")).status, 403);

    // promote to Administrator, and a new login gets the admin role
    assert.equal((await admin.put(`/api/admin/employees/${employee.employeeId}`, { ...body, employeeTypeId: 1 })).status, 200);
    const asAdmin = await app.loginStaff(employee.employeeId, "Role-Pass-1");
    assert.equal((await asAdmin.get("/api/auth/me")).body.role, "admin");
    assert.equal((await asAdmin.get("/api/admin/employees")).status, 200);
  });
});

describe("D: schedules and booked appointments", () => {
  test("booked appointments block only the changes that would strand them", async () => {
    const officeB = await newOffice("Second Office");
    const specialty = await newSpecialty("Pulmonology");
    const doctor = await newDoctor([specialty.specialtyId, ids.familyMedicine]);
    const shift = await newShift("Clinic Hours", "09:00", "12:00");
    const otherShift = await newShift("Evening Hours", "18:00", "20:00");
    const bookedSlot = await newSlot(shift.shiftTypeId, "09:00", "09:30");
    const freeSlot = await newSlot(shift.shiftTypeId, "09:30", "10:00");
    await newSchedule(doctor.employeeId, "Wednesday", ids.mainOffice, specialty.specialtyId, shift.shiftTypeId);
    await newSchedule(doctor.employeeId, "Thursday", ids.mainOffice, ids.familyMedicine, shift.shiftTypeId);

    const appointmentId = await bookAppointment({ doctorId: doctor.employeeId, day: "Wednesday", officeId: ids.mainOffice, specialtyId: specialty.specialtyId, timeSlotId: bookedSlot.timeSlotId });
    const appointmentBefore = await row("SELECT * FROM appointment WHERE appointment_id = $1", [appointmentId]);
    const wednesday = `/api/admin/schedules/${doctor.employeeId}/Wednesday`;
    const keep = { officeId: ids.mainOffice, specialtyId: specialty.specialtyId, shiftTypeId: shift.shiftTypeId };

    assert.equal((await admin.put(wednesday, { ...keep, officeId: officeB.officeId })).status, 409, "office change");
    assert.equal((await admin.put(wednesday, { ...keep, specialtyId: ids.familyMedicine })).status, 409, "specialty change");
    assert.equal((await admin.put(wednesday, { ...keep, shiftTypeId: otherShift.shiftTypeId })).status, 409, "shift change");
    assert.equal((await admin.patch(`${wednesday}/status`, { isActive: false })).status, 409, "deactivation");

    assert.equal((await admin.put(`/api/admin/time-slots/${bookedSlot.timeSlotId}`, { startTime: "11:00", endTime: "11:30" })).status, 409);
    assert.equal((await admin.patch(`/api/admin/time-slots/${bookedSlot.timeSlotId}/status`, { isActive: false })).status, 409);
    assert.equal((await admin.put(`/api/admin/shift-types/${shift.shiftTypeId}`, { name: "Clinic Hours", startTime: "09:30", endTime: "12:00" })).status, 409, "shift shrink");

    // unrelated weekday and unbooked slot can still change
    assert.equal((await admin.put(`/api/admin/schedules/${doctor.employeeId}/Thursday`, { officeId: officeB.officeId, specialtyId: ids.familyMedicine, shiftTypeId: shift.shiftTypeId })).status, 200);
    assert.equal((await admin.put(`/api/admin/time-slots/${freeSlot.timeSlotId}`, { startTime: "10:00", endTime: "10:30" })).status, 200);

    assert.deepEqual(await row("SELECT * FROM appointment WHERE appointment_id = $1", [appointmentId]), appointmentBefore);
  });

  test("completed and past appointments don't block schedule changes", async () => {
    const doctor = await newDoctor([ids.familyMedicine]);
    const slot = await newSlot(ids.morningShift, "11:30", "12:00");
    await newSchedule(doctor.employeeId, "Tuesday", ids.mainOffice, ids.familyMedicine, ids.morningShift);

    const completed = await bookAppointment({ doctorId: doctor.employeeId, day: "Tuesday", officeId: ids.mainOffice, specialtyId: ids.familyMedicine, timeSlotId: slot.timeSlotId });
    await app.db.query("UPDATE appointment SET status = 'Completed' WHERE appointment_id = $1", [completed]);
    await bookAppointment({ doctorId: doctor.employeeId, day: "Tuesday", officeId: ids.mainOffice, specialtyId: ids.familyMedicine, timeSlotId: slot.timeSlotId, weeksAgo: 1 });

    const moved = await admin.put(`/api/admin/schedules/${doctor.employeeId}/Tuesday`, { officeId: ids.westsideOffice, specialtyId: ids.familyMedicine, shiftTypeId: ids.morningShift });
    assert.equal(moved.status, 200);
    assert.equal((await admin.patch(`/api/admin/schedules/${doctor.employeeId}/Tuesday/status`, { isActive: false })).status, 200);
  });
});

describe("E: data integrity", () => {
  test("editing an office or specialty leaves employees, assignments, and appointments alone", async () => {
    const employeesBefore = await rows("SELECT * FROM employee WHERE office_id = $1 ORDER BY employee_id", [ids.westsideOffice]);
    const edited = await admin.put(`/api/admin/offices/${ids.westsideOffice}`, { name: "Westside Medical Center", street: "2 West St", apt: "Bldg B", city: "Houston", state: "TX", zip: "77002", phone: "713-555-0201" });
    assert.equal(edited.status, 200);
    assert.deepEqual(await rows("SELECT * FROM employee WHERE office_id = $1 ORDER BY employee_id", [ids.westsideOffice]), employeesBefore);

    const assignmentsBefore = await rows("SELECT * FROM doctor_specialty WHERE specialty_id = $1 ORDER BY doctor_id", [ids.cardiology]);
    const appointmentsBefore = await rows("SELECT * FROM appointment ORDER BY appointment_id");
    await admin.put(`/api/admin/specialties/${ids.cardiology}`, { name: "Cardiovascular Medicine", requiresReferral: false });
    await admin.put(`/api/admin/specialties/${ids.cardiology}`, { name: "Cardiology", requiresReferral: true });
    assert.deepEqual(await rows("SELECT * FROM doctor_specialty WHERE specialty_id = $1 ORDER BY doctor_id", [ids.cardiology]), assignmentsBefore);
    assert.deepEqual(await rows("SELECT * FROM appointment ORDER BY appointment_id"), appointmentsBefore);
  });

  test("deactivating employees keeps their doctor and nurse records", async () => {
    const doctor = await newDoctor([ids.familyMedicine]);
    const nurse = await created(
      admin.post("/api/admin/employees", employeeBody({ employeeTypeId: 3, nurse: { licenseNumber: `RN-INT${counter}`, licenseState: "TX", licenseExpiration: "2031-01-01", nursingLevel: "LPN" } }))
    );
    const subtypesBefore = [
      await row("SELECT * FROM doctor WHERE employee_id = $1", [doctor.employeeId]),
      await rows("SELECT * FROM doctor_specialty WHERE doctor_id = $1", [doctor.employeeId]),
      await row("SELECT * FROM nurse WHERE employee_id = $1", [nurse.employeeId]),
    ];
    await admin.patch(`/api/admin/employees/${doctor.employeeId}/status`, { isActive: false });
    await admin.patch(`/api/admin/employees/${nurse.employeeId}/status`, { isActive: false });
    assert.deepEqual(
      [
        await row("SELECT * FROM doctor WHERE employee_id = $1", [doctor.employeeId]),
        await rows("SELECT * FROM doctor_specialty WHERE doctor_id = $1", [doctor.employeeId]),
        await row("SELECT * FROM nurse WHERE employee_id = $1", [nurse.employeeId]),
      ],
      subtypesBefore
    );

    // inactive employees still show their full details
    const details = (await admin.get(`/api/admin/employees/${doctor.employeeId}`)).body;
    assert.equal(details.isActive, false);
    assert.equal(details.doctor.specialties.length, 1);
  });

  test("time-slot changes stay inside their own shift", async () => {
    const first = await newShift("First Block", "06:00", "08:00");
    const second = await newShift("Second Block", "20:00", "22:00");
    const slot = await newSlot(first.shiftTypeId, "06:00", "06:30");
    await newSlot(second.shiftTypeId, "20:00", "20:30");
    const secondBefore = (await admin.get("/api/admin/shift-types")).body.find((s: { shiftTypeId: number }) => s.shiftTypeId === second.shiftTypeId);
    const schedulesBefore = await rows("SELECT * FROM doctor_schedule ORDER BY doctor_id, day_of_week");

    assert.equal((await admin.put(`/api/admin/time-slots/${slot.timeSlotId}`, { startTime: "07:00", endTime: "07:30" })).status, 200);
    assert.equal((await admin.patch(`/api/admin/time-slots/${slot.timeSlotId}/status`, { isActive: false })).status, 200);
    // an inactive slot can be moved anywhere, but can't come back unless it fits its own shift
    assert.equal((await admin.put(`/api/admin/time-slots/${slot.timeSlotId}`, { startTime: "20:00", endTime: "20:30" })).status, 200);
    assert.equal((await admin.patch(`/api/admin/time-slots/${slot.timeSlotId}/status`, { isActive: true })).status, 409);

    const secondAfter = (await admin.get("/api/admin/shift-types")).body.find((s: { shiftTypeId: number }) => s.shiftTypeId === second.shiftTypeId);
    assert.deepEqual(secondAfter, secondBefore);
    assert.deepEqual(await rows("SELECT * FROM doctor_schedule ORDER BY doctor_id, day_of_week"), schedulesBefore);
  });

  test("inactive records stay visible for history", async () => {
    const office = await newOffice("History Clinic");
    const specialty = await newSpecialty("Geriatrics");
    await admin.patch(`/api/admin/offices/${office.officeId}/status`, { isActive: false });
    await admin.patch(`/api/admin/specialties/${specialty.specialtyId}/status`, { isActive: false });

    const offices = (await admin.get("/api/admin/offices")).body;
    assert.equal(offices.find((o: { officeId: number }) => o.officeId === office.officeId).isActive, false);
    const specialties = (await admin.get("/api/admin/specialties")).body;
    assert.equal(specialties.find((s: { specialtyId: number }) => s.specialtyId === specialty.specialtyId).isActive, false);
    assert.equal((await admin.get(`/api/admin/offices/${office.officeId}`)).status, 200);
    assert.equal((await admin.get(`/api/admin/specialties/${specialty.specialtyId}`)).status, 200);
  });
});

describe("G: no sensitive data in Admin responses", () => {
  test("no Admin response includes password hashes", async () => {
    const paths = [
      "/api/admin/employees",
      `/api/admin/employees/${ids.admin}`,
      `/api/admin/employees/${ids.doctor}`,
      "/api/admin/offices",
      "/api/admin/specialties",
      "/api/admin/schedules",
      "/api/admin/schedules/doctor-options",
      "/api/admin/shift-types",
    ];
    const hashes = (await rows("SELECT password_hash FROM employee_creds")).map((r) => r.password_hash);
    const salts = hashes.map((h: string) => h.split(":")[0]);

    const body = employeeBody();
    const responses = [
      ...(await Promise.all(paths.map((p) => admin.get(p)))),
      await admin.post("/api/admin/employees", { ...body, login: { username: body.email, password: "Visible-Pass-1" } }),
      await admin.post(`/api/admin/employees/${ids.receptionist}/login`, { username: "rita.int", password: "Visible-Pass-1" }),
      await admin.patch(`/api/admin/employees/${ids.nurse}/login-status`, { loginActive: true }),
    ];
    for (const res of responses) {
      const text = JSON.stringify(res.body);
      assert.doesNotMatch(text, /password/i);
      assert.ok(!text.includes("Visible-Pass-1"));
      for (const salt of salts) assert.ok(!text.includes(salt));
    }
  });
});

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

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const monday = { officeId: ids.mainOffice, specialtyId: ids.cardiology, shiftTypeId: ids.morningShift };

async function createShift(name: string, startTime: string, endTime: string) {
  const res = await admin.post("/api/admin/shift-types", { name, startTime, endTime });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.shiftTypeId as number;
}

async function createSlot(shiftTypeId: number, startTime: string, endTime: string) {
  const res = await admin.post(`/api/admin/shift-types/${shiftTypeId}/time-slots`, { startTime, endTime });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.timeSlotId as number;
}

async function shiftSlots(shiftTypeId: number) {
  const shifts = (await admin.get("/api/admin/shift-types")).body;
  return shifts.find((s: { shiftTypeId: number }) => s.shiftTypeId === shiftTypeId).timeSlots;
}

// books an upcoming appointment on the doctor's next given weekday
async function bookAppointment(doctorId: number, day: string, officeId: number, specialtyId: number, timeSlotId: number) {
  const { rows } = await app.db.query(
    `
    INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, booking_channel)
    VALUES ($1, $2, $3, CURRENT_DATE + (($4 - EXTRACT(ISODOW FROM CURRENT_DATE)::int + 7) % 7), $5, $6, 'Web')
    RETURNING appointment_id
    `,
    [ids.patient, doctorId, officeId, DAYS.indexOf(day) + 1, timeSlotId, specialtyId]
  );
  return rows[0].appointment_id as number;
}

// employees, offices, specialties, assignments, and appointments; schedule changes must leave them alone
async function relatedSnapshot() {
  const { rows } = await app.db.query(`
    SELECT
      (SELECT json_agg(e ORDER BY employee_id) FROM employee e) AS employees,
      (SELECT json_agg(o ORDER BY office_id) FROM office o) AS offices,
      (SELECT json_agg(s ORDER BY specialty_id) FROM specialty s) AS specialties,
      (SELECT json_agg(d ORDER BY doctor_id, specialty_id) FROM doctor_specialty d) AS assignments,
      (SELECT json_agg(a ORDER BY appointment_id) FROM appointment a) AS appointments
  `);
  return JSON.stringify(rows[0]);
}

describe("shift types", () => {
  test("list shows hours, schedule use, and time slots", async () => {
    const res = await admin.get("/api/admin/shift-types");
    assert.equal(res.status, 200);
    const morning = res.body.find((s: { shiftTypeId: number }) => s.shiftTypeId === ids.morningShift);
    assert.equal(morning.startTime, "08:00");
    assert.equal(morning.endTime, "12:00");
    assert.equal(morning.activeScheduleCount, 1);
    assert.ok(Array.isArray(morning.timeSlots));
  });

  test("create validates names and hours", async () => {
    await createShift("Afternoon", "13:00", "17:00");
    const cases: [string, object, number][] = [
      ["duplicate name in another case", { name: "morning", startTime: "06:00", endTime: "07:00" }, 409],
      ["end before start", { name: "Backwards", startTime: "12:00", endTime: "08:00" }, 400],
      ["same start and end", { name: "Zero", startTime: "08:00", endTime: "08:00" }, 400],
      ["invalid time", { name: "Bad", startTime: "25:00", endTime: "26:00" }, 400],
      ["blank name", { name: " ", startTime: "06:00", endTime: "07:00" }, 400],
    ];
    for (const [label, body, status] of cases) {
      assert.equal((await admin.post("/api/admin/shift-types", body)).status, status, label);
    }
  });

  test("edit can't push an active time slot outside the shift", async () => {
    const shift = await createShift("Early", "06:00", "10:00");
    const slot = await createSlot(shift, "06:00", "06:30");
    const path = `/api/admin/shift-types/${shift}`;

    assert.equal((await admin.put(path, { name: "Early", startTime: "06:30", endTime: "10:00" })).status, 409);
    await admin.patch(`/api/admin/time-slots/${slot}/status`, { isActive: false });
    assert.equal((await admin.put(path, { name: "Early", startTime: "06:30", endTime: "10:00" })).status, 200);

    // the inactive slot no longer fits, so it can't be reactivated until the hours change back
    assert.equal((await admin.patch(`/api/admin/time-slots/${slot}/status`, { isActive: true })).status, 409);
    assert.equal((await admin.put(path, { name: "Early Shift", startTime: "06:00", endTime: "10:00" })).status, 200);
    assert.equal((await admin.patch(`/api/admin/time-slots/${slot}/status`, { isActive: true })).status, 200);
    assert.equal((await admin.put("/api/admin/shift-types/99999", { name: "X", startTime: "06:00", endTime: "07:00" })).status, 404);
  });

  test("deactivation is blocked while active schedules use the shift", async () => {
    const used = await admin.patch(`/api/admin/shift-types/${ids.morningShift}/status`, { isActive: false });
    assert.equal(used.status, 409);
    assert.match(used.body.error, /1 active doctor schedule still use/);

    const unused = await createShift("Evening", "17:00", "21:00");
    assert.equal((await admin.patch(`/api/admin/shift-types/${unused}/status`, { isActive: false })).status, 200);
    assert.equal((await admin.patch(`/api/admin/shift-types/${unused}/status`, { isActive: true })).status, 200);
  });
});

describe("time slots", () => {
  test("slots must fit inside the shift and not overlap", async () => {
    const shift = await createShift("Slot Shift", "09:00", "11:00");
    const first = await createSlot(shift, "09:00", "09:30");
    await createSlot(shift, "09:30", "10:00");

    const add = (startTime: string, endTime: string) => admin.post(`/api/admin/shift-types/${shift}/time-slots`, { startTime, endTime });
    assert.equal((await add("09:15", "09:45")).status, 409, "overlap");
    assert.equal((await add("08:30", "09:00")).status, 409, "before shift");
    assert.equal((await add("10:45", "11:15")).status, 409, "after shift");
    assert.equal((await add("10:30", "10:00")).status, 400, "end before start");
    assert.equal((await admin.post("/api/admin/shift-types/99999/time-slots", { startTime: "09:00", endTime: "09:30" })).status, 404);

    // an inactive slot doesn't block a new one in the same place
    await admin.patch(`/api/admin/time-slots/${first}/status`, { isActive: false });
    await createSlot(shift, "09:00", "09:30");
    assert.equal((await admin.patch(`/api/admin/time-slots/${first}/status`, { isActive: true })).status, 409);
  });

  test("slots can be moved, but not onto another slot", async () => {
    const shift = await createShift("Move Shift", "13:00", "15:00");
    await createSlot(shift, "13:00", "13:30");
    const second = await createSlot(shift, "13:30", "14:00");

    assert.equal((await admin.put(`/api/admin/time-slots/${second}`, { startTime: "14:00", endTime: "14:30" })).status, 200);
    assert.equal((await admin.put(`/api/admin/time-slots/${second}`, { startTime: "13:00", endTime: "13:30" })).status, 409);
    assert.deepEqual(
      (await shiftSlots(shift)).map((s: { startTime: string }) => s.startTime),
      ["13:00", "14:00"]
    );
    assert.equal((await admin.put("/api/admin/time-slots/99999", { startTime: "13:00", endTime: "13:30" })).status, 404);
  });
});

describe("doctor schedules", () => {
  test("list and doctor options return joined, non-sensitive data", async () => {
    const list = await admin.get("/api/admin/schedules");
    assert.equal(list.status, 200);
    const dan = list.body.find((s: { doctorId: number; dayOfWeek: string }) => s.doctorId === ids.doctor && s.dayOfWeek === "Monday");
    assert.equal(dan.officeName, "Main Street Clinic");
    assert.equal(dan.specialtyName, "Cardiology");
    assert.equal(dan.startTime, "08:00");

    const options = await admin.get("/api/admin/schedules/doctor-options");
    const danOption = options.body.find((d: { doctorId: number }) => d.doctorId === ids.doctor);
    assert.deepEqual(
      danOption.specialties.map((s: { name: string }) => s.name),
      ["Cardiology", "Family Medicine"]
    );
    assert.equal(danOption.email, undefined);
  });

  test("create assigns a doctor and changes nothing else", async () => {
    const before = await relatedSnapshot();
    const res = await admin.post("/api/admin/schedules", { doctorId: ids.doctor, dayOfWeek: "Tuesday", officeId: ids.westsideOffice, specialtyId: ids.familyMedicine, shiftTypeId: ids.morningShift });
    assert.equal(res.status, 201);
    assert.equal(res.body.officeName, "Westside Clinic");
    assert.equal(res.body.isActive, true);
    assert.equal(await relatedSnapshot(), before);
  });

  test("create rejects duplicates, bad weekdays, and unusable records", async () => {
    // a second doctor and an inactive shift for the inactive-record cases
    await app.db.query(`INSERT INTO shift_type (name, start_time, end_time, is_active) VALUES ('Closed Shift', '18:00', '20:00', false)`);
    const closedShift = (await app.db.query(`SELECT shift_type_id FROM shift_type WHERE name = 'Closed Shift'`)).rows[0].shift_type_id;
    const friday = { doctorId: ids.doctor, dayOfWeek: "Friday", officeId: ids.mainOffice, specialtyId: ids.familyMedicine, shiftTypeId: ids.morningShift };

    const cases: [string, object, number][] = [
      ["duplicate weekday", { ...friday, dayOfWeek: "Monday" }, 409],
      ["invalid weekday", { ...friday, dayOfWeek: "Funday" }, 400],
      ["lowercase weekday", { ...friday, dayOfWeek: "friday" }, 400],
      ["missing field", { doctorId: ids.doctor, dayOfWeek: "Friday", officeId: ids.mainOffice }, 400],
      ["employee who isn't a doctor", { ...friday, doctorId: ids.nurse }, 409],
      ["missing doctor", { ...friday, doctorId: 99999 }, 409],
      ["inactive office", { ...friday, officeId: ids.closedOffice }, 409],
      ["inactive specialty", { ...friday, specialtyId: ids.retiredSpecialty }, 409],
      ["inactive shift", { ...friday, shiftTypeId: closedShift }, 409],
      ["missing shift", { ...friday, shiftTypeId: 99999 }, 409],
    ];
    for (const [label, body, status] of cases) {
      assert.equal((await admin.post("/api/admin/schedules", body)).status, status, label);
    }

    // an active specialty the doctor doesn't practice
    const other = await admin.post("/api/admin/specialties", { name: "Dermatology", requiresReferral: true });
    const notPracticed = await admin.post("/api/admin/schedules", { ...friday, specialtyId: other.body.specialtyId });
    assert.equal(notPracticed.status, 409);
    assert.match(notPracticed.body.error, /isn't assigned to that specialty/);

    // an inactive doctor
    await admin.patch(`/api/admin/employees/${ids.doctor}/status`, { isActive: false });
    try {
      assert.equal((await admin.post("/api/admin/schedules", friday)).status, 409);
    } finally {
      await admin.patch(`/api/admin/employees/${ids.doctor}/status`, { isActive: true });
    }
    assert.equal((await app.db.query(`SELECT 1 FROM doctor_schedule WHERE day_of_week = 'Friday'`)).rowCount, 0);
  });

  test("get validates the doctor ID and weekday", async () => {
    assert.equal((await admin.get(`/api/admin/schedules/${ids.doctor}/Monday`)).status, 200);
    assert.equal((await admin.get(`/api/admin/schedules/${ids.doctor}/Funday`)).status, 400);
    assert.equal((await admin.get("/api/admin/schedules/abc/Monday")).status, 400);
    assert.equal((await admin.get(`/api/admin/schedules/${ids.doctor}/Sunday`)).status, 404);
  });

  test("edit changes the assignment but keeps the doctor and weekday", async () => {
    await admin.post("/api/admin/schedules", { doctorId: ids.doctor, dayOfWeek: "Wednesday", ...monday });
    const before = await relatedSnapshot();
    const res = await admin.put(`/api/admin/schedules/${ids.doctor}/Wednesday`, { officeId: ids.westsideOffice, specialtyId: ids.familyMedicine, shiftTypeId: ids.morningShift });
    assert.equal(res.status, 200);
    assert.equal(res.body.doctorId, ids.doctor);
    assert.equal(res.body.dayOfWeek, "Wednesday");
    assert.equal(res.body.officeName, "Westside Clinic");
    assert.equal(await relatedSnapshot(), before);

    assert.equal((await admin.put(`/api/admin/schedules/${ids.doctor}/Wednesday`, { ...monday, officeId: ids.closedOffice })).status, 409);
    assert.equal((await admin.put(`/api/admin/schedules/${ids.doctor}/Sunday`, monday)).status, 404);
    assert.equal((await admin.put(`/api/admin/schedules/${ids.doctor}/Wednesday`, { ...monday, officeId: "one" })).status, 400);
  });

  test("deactivate keeps the record, and reactivation rechecks the references", async () => {
    await admin.post("/api/admin/schedules", { doctorId: ids.doctor, dayOfWeek: "Thursday", officeId: ids.westsideOffice, specialtyId: ids.familyMedicine, shiftTypeId: ids.morningShift });
    const path = `/api/admin/schedules/${ids.doctor}/Thursday/status`;

    const off = await admin.patch(path, { isActive: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.isActive, false);
    assert.equal((await app.db.query(`SELECT 1 FROM doctor_schedule WHERE doctor_id = $1 AND day_of_week = 'Thursday'`, [ids.doctor])).rowCount, 1);
    assert.equal((await admin.patch(path, { isActive: false })).body.isActive, false);

    await app.db.query("UPDATE office SET is_active = false WHERE office_id = $1", [ids.westsideOffice]);
    try {
      assert.equal((await admin.patch(path, { isActive: true })).status, 409);
    } finally {
      await app.db.query("UPDATE office SET is_active = true WHERE office_id = $1", [ids.westsideOffice]);
    }
    assert.equal((await admin.patch(path, { isActive: true })).body.isActive, true);

    assert.equal((await admin.patch(path, { isActive: "no" })).status, 400);
    assert.equal((await admin.patch(`/api/admin/schedules/${ids.doctor}/Sunday/status`, { isActive: true })).status, 404);
  });

  test("offices and specialties used by an active schedule can't be deactivated", async () => {
    assert.equal((await admin.patch(`/api/admin/offices/${ids.mainOffice}/status`, { isActive: false })).status, 409);
    assert.equal((await admin.patch(`/api/admin/specialties/${ids.cardiology}/status`, { isActive: false })).status, 409);
  });
});

describe("booked appointments", () => {
  test("schedule changes that would strand a booked appointment are refused", async () => {
    const slot = await createSlot(ids.morningShift, "08:00", "08:30");
    const appointmentId = await bookAppointment(ids.doctor, "Monday", ids.mainOffice, ids.cardiology, slot);
    const path = `/api/admin/schedules/${ids.doctor}/Monday`;

    const moved = await admin.put(path, { ...monday, officeId: ids.westsideOffice });
    assert.equal(moved.status, 409);
    assert.match(moved.body.error, /1 upcoming appointment is booked with this doctor on Mondays/);
    assert.equal((await admin.put(path, monday)).status, 200, "keeping the same assignment is fine");
    assert.equal((await admin.patch(`${path}/status`, { isActive: false })).status, 409);

    assert.equal((await admin.patch(`/api/admin/time-slots/${slot}/status`, { isActive: false })).status, 409);
    assert.equal((await admin.put(`/api/admin/time-slots/${slot}`, { startTime: "10:00", endTime: "10:30" })).status, 409);

    // once the appointment is cancelled the schedule can be deactivated, and the appointment is untouched
    await app.db.query("UPDATE appointment SET status = 'Cancelled' WHERE appointment_id = $1", [appointmentId]);
    const before = await relatedSnapshot();
    assert.equal((await admin.patch(`${path}/status`, { isActive: false })).status, 200);
    assert.equal(await relatedSnapshot(), before);
    assert.equal((await admin.patch(`${path}/status`, { isActive: true })).status, 200);
  });

  test("a shift with booked appointments can't be deactivated", async () => {
    const shift = await createShift("Booked Shift", "14:00", "16:00");
    const slot = await createSlot(shift, "14:00", "14:30");
    await bookAppointment(ids.doctor, "Saturday", ids.mainOffice, ids.familyMedicine, slot);
    const res = await admin.patch(`/api/admin/shift-types/${shift}/status`, { isActive: false });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /1 upcoming appointment is booked/);
  });
});

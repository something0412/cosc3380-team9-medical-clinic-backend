import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  TEST_CLOCK_OPTION,
  addAppointment,
  addDoctor,
  addEmployee,
  addLogin,
  addNurse,
  addPatient,
  addSlots,
  dayFrom,
  freezeClockAtNoon,
  unfreezeClock,
} from "./helpers/appointmentData.js";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient } from "./helpers/testApp.js";
import { ids, resetDatabase } from "./helpers/testDb.js";

const VISIT_KEYS = [
  "appointmentId", "patientId", "patientName", "doctorId", "doctorName", "officeId", "officeName", "specialtyId", "specialty",
  "date", "timeSlotId", "startTime", "endTime", "status", "bookingChannel", "bookedByEmployeeId", "referralId",
  "checkedIn", "checkedInAt", "checkedOutAt",
];

let app: Awaited<ReturnType<typeof startTestApp>>;
let today: string;
let rita: TestClient, nina: TestClient, nora: TestClient, dan: TestClient, dora: TestClient;
let anonymous: TestClient, pat: TestClient, admin: TestClient, lab: TestClient;
let doraId: number, noraId: number;
let slots: Awaited<ReturnType<typeof addSlots>>;

// appointment IDs by name
const v: Record<string, number> = {};
const listIds = (body: { appointmentId: number }[]) => body.map((a) => a.appointmentId);

before(async () => {
  await resetDatabase();
  // a frozen clock keeps today the same even if the run crosses midnight
  process.env.DATABASE_URL += `?options=${encodeURIComponent(TEST_CLOCK_OPTION)}`;
  app = await startTestApp();
  today = await freezeClockAtNoon(app.db);
  slots = await addSlots(app.db);

  // Dan works at Main Street from the fixtures, Dora at Westside
  doraId = await addDoctor(app.db, "Dora", ids.westsideOffice);
  noraId = await addNurse(app.db, "Nora", ids.mainOffice);
  await addLogin(app.db, ids.receptionist);
  const labType = await app.db.query(`INSERT INTO employee_types (type_name) VALUES ('Lab Technician') RETURNING employee_type_id AS id`);
  const labId = await addEmployee(app.db, "Lee", labType.rows[0].id, ids.westsideOffice);

  const ann = await addPatient(app.db, "Ann", "Able");
  const bo = await addPatient(app.db, "Bo", "Baker");
  const cy = await addPatient(app.db, "Cy", "Cole");
  const west = { officeId: ids.westsideOffice, doctorId: doraId };
  const main = { officeId: ids.mainOffice, doctorId: ids.doctor };
  v.westNoon = await addAppointment(app.db, { ...west, patientId: ann, date: today, timeSlotId: slots.noon });
  v.westMorning = await addAppointment(app.db, { ...west, patientId: bo, date: today, timeSlotId: slots.morning });
  v.westCancelled = await addAppointment(app.db, { ...west, patientId: cy, date: today, timeSlotId: slots.late, status: "Cancelled" });
  v.westTomorrow = await addAppointment(app.db, { ...west, patientId: ann, date: dayFrom(today, 1), timeSlotId: slots.morning });
  v.mainToday = await addAppointment(app.db, { ...main, patientId: cy, date: today, timeSlotId: slots.morning });
  v.mainYesterday = await addAppointment(app.db, { ...main, patientId: bo, date: dayFrom(today, -1), timeSlotId: slots.morning, status: "Completed" });
  v.mainLastWeek = await addAppointment(app.db, { ...main, patientId: ann, date: dayFrom(today, -7), timeSlotId: slots.noon, status: "No Show" });
  v.mainNextWeek = await addAppointment(app.db, { ...main, patientId: bo, date: dayFrom(today, 7), timeSlotId: slots.noon });
  await app.db.query(`UPDATE appointment SET checked_in_at = now() WHERE appointment_id = $1`, [v.westMorning]);

  rita = await app.loginStaff(ids.receptionist);
  nina = await app.loginStaff(ids.nurse);
  nora = await app.loginStaff(noraId);
  dan = await app.loginStaff(ids.doctor);
  dora = await app.loginStaff(doraId);
  anonymous = app.client();
  pat = await app.loginPatient(ids.patient, "pat@test.org");
  admin = await app.loginStaff(ids.admin);
  lab = await app.loginStaff(labId);
});

after(async () => {
  await unfreezeClock(app.db);
  await app.close();
});

describe("receptionist office list", () => {
  test("shows the day at the receptionist's own office, earliest first", async () => {
    const res = await rita.get("/api/receptionist/appointments");
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.officeId, res.body.officeName, res.body.today], [ids.westsideOffice, "Westside Clinic", today]);
    assert.deepEqual(listIds(res.body.appointments), [v.westMorning, v.westNoon, v.westCancelled]);
    for (const a of res.body.appointments) assert.deepEqual(Object.keys(a), VISIT_KEYS);

    const [morning, noon, cancelled] = res.body.appointments;
    assert.deepEqual(
      [morning.status, morning.checkedIn, morning.date, morning.startTime, morning.endTime, morning.patientName, morning.doctorName],
      ["Scheduled", true, today, "08:00", "08:30", "Bo Baker", "Dora Tester"]
    );
    assert.match(morning.checkedInAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.deepEqual([noon.checkedIn, noon.checkedInAt, noon.checkedOutAt], [false, null, null]);
    assert.equal(cancelled.status, "Cancelled");
  });

  test("filters by date and patient name, and ignores an office sent by the client", async () => {
    assert.deepEqual(listIds((await rita.get(`/api/receptionist/appointments?date=${dayFrom(today, 1)}`)).body.appointments), [v.westTomorrow]);
    assert.deepEqual(listIds((await rita.get("/api/receptionist/appointments?search=ann")).body.appointments), [v.westNoon]);
    const elsewhere = await rita.get(`/api/receptionist/appointments?officeId=${ids.mainOffice}`);
    assert.equal(elsewhere.body.officeId, ids.westsideOffice);
    assert.equal(elsewhere.body.appointments.some((a: { officeId: number }) => a.officeId !== ids.westsideOffice), false);
    assert.deepEqual((await rita.get(`/api/receptionist/appointments?date=${dayFrom(today, 30)}`)).body.appointments, []);
  });

  test("a new office assignment applies on the next request", async () => {
    try {
      await app.db.query(`UPDATE employee SET office_id = $1 WHERE employee_id = $2`, [ids.mainOffice, ids.receptionist]);
      const res = await rita.get("/api/receptionist/appointments");
      assert.deepEqual([res.body.officeId, listIds(res.body.appointments)], [ids.mainOffice, [v.mainToday]]);
    } finally {
      await app.db.query(`UPDATE employee SET office_id = $1 WHERE employee_id = $2`, [ids.westsideOffice, ids.receptionist]);
    }
  });
});

describe("nurse list", () => {
  test("shows the nurse's office for the day without cancelled visits", async () => {
    const west = await nina.get("/api/nurse/appointments");
    assert.equal(west.status, 200);
    assert.deepEqual(listIds(west.body), [v.westMorning, v.westNoon]);
    assert.deepEqual(Object.keys(west.body[0]), VISIT_KEYS);
    // checked in shows up as its own flag while the stored status stays Scheduled
    assert.deepEqual([west.body[0].status, west.body[0].checkedIn], ["Scheduled", true]);

    assert.deepEqual(listIds((await nora.get("/api/nurse/appointments")).body), [v.mainToday]);
    assert.deepEqual(listIds((await nina.get(`/api/nurse/appointments?date=${dayFrom(today, 1)}`)).body), [v.westTomorrow]);
    assert.deepEqual((await nina.get(`/api/nurse/appointments?date=${dayFrom(today, -30)}`)).body, []);
  });

  test("a nurse who moves offices sees the new office next time", async () => {
    try {
      await app.db.query(`UPDATE employee SET office_id = $1 WHERE employee_id = $2`, [ids.mainOffice, ids.nurse]);
      assert.deepEqual(listIds((await nina.get("/api/nurse/appointments")).body), [v.mainToday]);
    } finally {
      await app.db.query(`UPDATE employee SET office_id = $1 WHERE employee_id = $2`, [ids.westsideOffice, ids.nurse]);
    }
  });
});

describe("doctor list", () => {
  test("shows only the doctor's own visits for each tab", async () => {
    assert.deepEqual(listIds((await dan.get("/api/doctor/appointments")).body), [v.mainToday]);
    assert.deepEqual(listIds((await dan.get("/api/doctor/appointments?view=upcoming")).body), [v.mainNextWeek]);
    assert.deepEqual(listIds((await dan.get("/api/doctor/appointments?view=past")).body), [v.mainYesterday, v.mainLastWeek]);
    assert.deepEqual(listIds((await dan.get("/api/doctor/appointments?view=all")).body), [v.mainNextWeek, v.mainToday, v.mainYesterday, v.mainLastWeek]);

    const past = (await dan.get("/api/doctor/appointments?view=past")).body;
    assert.deepEqual(past.map((a: { status: string }) => a.status), ["Completed", "No Show"]);
    assert.deepEqual(listIds((await dora.get("/api/doctor/appointments")).body), [v.westMorning, v.westNoon, v.westCancelled]);
  });

  test("filters by date and patient name, and a doctor ID in the request changes nothing", async () => {
    assert.deepEqual(listIds((await dan.get(`/api/doctor/appointments?date=${dayFrom(today, 7)}`)).body), [v.mainNextWeek]);
    assert.deepEqual(listIds((await dan.get("/api/doctor/appointments?view=all&search=cole")).body), [v.mainToday]);
    assert.deepEqual(listIds((await dan.get(`/api/doctor/appointments?doctorId=${doraId}`)).body), [v.mainToday]);
    assert.deepEqual((await dan.get(`/api/doctor/appointments?date=${dayFrom(today, 30)}`)).body, []);
  });
});

describe("patient name search", () => {
  test("% and _ match only themselves, and normal searches still work", async () => {
    const date = dayFrom(today, 3);
    const visit = async (firstName: string, lastName: string, timeSlotId: number) =>
      addAppointment(app.db, { patientId: await addPatient(app.db, firstName, lastName), doctorId: doraId, officeId: ids.westsideOffice, date, timeSlotId });
    const underscore = await visit("Jo_e", "Under", slots.early);
    const joke = await visit("Joke", "Plain", slots.morning);
    const percent = await visit("Max%", "Percent", slots.noon);
    const maxi = await visit("Maxi", "Plain", slots.late);

    const searches: [string, number[]][] = [
      ["_", [underscore]],
      ["o_e", [underscore]],
      ["%", [percent]],
      ["x%", [percent]],
      ["\\", []],
      ["joke", [joke]],
      ["PLAIN", [joke, maxi]],
    ];
    for (const [search, expected] of searches) {
      const query = `date=${date}&search=${encodeURIComponent(search)}`;
      const desk = await rita.get(`/api/receptionist/appointments?${query}`);
      assert.deepEqual([desk.status, listIds(desk.body.appointments)], [200, expected], `receptionist ${search}`);
      assert.deepEqual(listIds((await dora.get(`/api/doctor/appointments?${query}`)).body), expected, `doctor ${search}`);
    }
    // these visits are all at Westside, so the Main Street list for that day stays empty
    assert.deepEqual(listIds((await nora.get(`/api/nurse/appointments?date=${date}`)).body), []);
  });
});

describe("list checks", () => {
  test("bad dates and views are rejected", async () => {
    for (const [client, url] of [
      [rita, "/api/receptionist/appointments?date=2026-13-01"],
      [rita, "/api/receptionist/appointments?date=0000-01-01"],
      [nina, "/api/nurse/appointments?date=tomorrow"],
      [dan, "/api/doctor/appointments?date=2026-02-30"],
      [dan, "/api/doctor/appointments?view=everything"],
    ] as const) {
      assert.equal((await client.get(url)).status, 400, url);
    }
  });

  test("each list is only for its own role", async () => {
    const lists = {
      receptionist: "/api/receptionist/appointments",
      nurse: "/api/nurse/appointments",
      doctor: "/api/doctor/appointments",
    };
    const clients: [string, TestClient][] = [["receptionist", rita], ["nurse", nina], ["doctor", dan], ["patient", pat], ["admin", admin], ["lab", lab]];
    for (const [listName, url] of Object.entries(lists)) {
      assert.equal((await anonymous.get(url)).status, 401, url);
      for (const [name, client] of clients) {
        assert.equal((await client.get(url)).status, name === listName ? 200 : 403, `${name} on ${url}`);
      }
    }
  });

  test("lists don't include contact, insurance or login details", async () => {
    const bodies = JSON.stringify([
      (await rita.get("/api/receptionist/appointments")).body,
      (await nina.get("/api/nurse/appointments")).body,
      (await dan.get("/api/doctor/appointments?view=all")).body,
    ]);
    assert.doesNotMatch(bodies, /visit@test\.org|713-555-8800|1980-05-05|password|insurance|policy/i);
  });
});

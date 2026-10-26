import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient, TestResponse } from "./helpers/testApp.js";
import { ids, resetDatabase } from "./helpers/testDb.js";

// IDs created by SETUP below, after the fixtures
const DOCTOR = { dan: ids.doctor, fay: 5, fred: 6, wendy: 7, ivan: 8, olga: 9, una: 10, sam: 11, rex: 12, cal: 13, nora: 14, carl: 15 };
const PATIENT = { pat: ids.patient, olive: 2, ina: 3 };
const RECEPTIONIST = { westside: ids.receptionist, main: 16 };
const REFERRAL = { oliveApproved: 1, patPending: 2, patDenied: 3, patExpired: 4, patIssuedLater: 5 };

// Morning 1 to 5 and 14, Full Day 6 to 11, Night 12, inactive shift 13
const SLOT = {
  m0800: 1, m0830: 2, m0900: 3, m0930Inactive: 4, m1000: 5, m1100: 14,
  f0800: 6, f0830: 7, f0900: 8, f0930: 9, f1015: 10, f1300: 11,
  night0000: 12, closedShift0800: 13,
};

const SETUP = `
  INSERT INTO shift_type (name, start_time, end_time) VALUES ('Full Day', '08:00', '17:00'), ('Night', '00:00', '02:00');
  INSERT INTO shift_type (name, start_time, end_time, is_active) VALUES ('Closed Shift', '08:00', '12:00', false);

  INSERT INTO time_slot (shift_type_id, start_time, end_time, is_active) VALUES
    (1, '08:00', '08:30', true), (1, '08:30', '09:00', true), (1, '09:00', '09:30', true), (1, '09:30', '10:00', false), (1, '10:00', '10:30', true),
    (2, '08:00', '08:30', true), (2, '08:30', '09:00', true), (2, '09:00', '09:30', true), (2, '09:30', '10:00', true), (2, '10:15', '10:45', true), (2, '13:00', '13:30', true),
    (3, '00:00', '00:30', true),
    (4, '08:00', '08:30', true),
    (1, '11:00', '11:30', true);

  INSERT INTO employee (first_name, last_name, dob, employee_type_id, phone, email, office_id, is_active) VALUES
    ('Fay', 'Family', '1980-01-01', 2, '713-555-2005', 'fay@test.org', 1, true),
    ('Fred', 'Fuller', '1980-01-01', 2, '713-555-2006', 'fred@test.org', 2, true),
    ('Wendy', 'Weekday', '1980-01-01', 2, '713-555-2007', 'wendy@test.org', 1, true),
    ('Ivan', 'Inactive', '1980-01-01', 2, '713-555-2008', 'ivan@test.org', 1, false),
    ('Olga', 'Offsite', '1980-01-01', 2, '713-555-2009', 'olga@test.org', 1, true),
    ('Una', 'Unassigned', '1980-01-01', 2, '713-555-2010', 'una@test.org', 1, true),
    ('Sam', 'Sleeping', '1980-01-01', 2, '713-555-2011', 'sam@test.org', 1, true),
    ('Rex', 'Retired', '1980-01-01', 2, '713-555-2012', 'rex@test.org', 1, true),
    ('Cal', 'Closed', '1980-01-01', 2, '713-555-2013', 'cal@test.org', 1, true),
    ('Nora', 'Night', '1980-01-01', 2, '713-555-2014', 'nora@test.org', 1, true),
    ('Carl', 'Cardio', '1980-01-01', 2, '713-555-2015', 'carl@test.org', 1, true),
    ('Mia', 'Main', '1992-02-02', 4, '713-555-2016', 'mia@test.org', 1, true);

  INSERT INTO doctor (employee_id, license_number, license_issuing_state, license_expiration_date, npi_number)
  SELECT employee_id, 'TX-B' || employee_id, 'TX', '2030-01-01', '20000000' || lpad(employee_id::text, 2, '0')
  FROM employee WHERE employee_id BETWEEN 5 AND 15;

  INSERT INTO doctor_specialty (doctor_id, specialty_id, is_primary, is_active) VALUES
    (5, 1, true, true), (6, 1, true, true), (7, 1, true, true), (8, 1, true, true), (9, 1, true, true), (10, 1, true, false),
    (11, 1, true, true), (12, 3, true, true), (13, 1, true, true), (14, 1, true, true), (15, 2, true, true);

  -- every doctor but Wendy works all week
  DELETE FROM doctor_schedule;
  INSERT INTO doctor_schedule (doctor_id, day_of_week, office_id, specialty_id, shift_type_id, is_active)
  SELECT s.doctor_id, w.day, s.office_id, s.specialty_id, s.shift_type_id, s.is_active
  FROM (VALUES
    (2, 1, 2, 1, true), (5, 1, 1, 1, true), (6, 2, 1, 2, true), (8, 1, 1, 1, true), (9, 3, 1, 1, true), (10, 1, 1, 1, true),
    (11, 1, 1, 1, false), (12, 1, 3, 1, true), (13, 1, 1, 4, true), (14, 1, 1, 3, true), (15, 1, 2, 1, true)
  ) AS s(doctor_id, office_id, specialty_id, shift_type_id, is_active)
  CROSS JOIN unnest(ARRAY['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) AS w(day);
  INSERT INTO doctor_schedule (doctor_id, day_of_week, office_id, specialty_id, shift_type_id)
  VALUES (7, to_char((now() AT TIME ZONE 'America/Chicago')::date + 7, 'FMDay'), 1, 1, 1);

  INSERT INTO patient (first_name, last_name, dob, phone, email, is_active) VALUES
    ('Olive', 'Other', '1995-02-02', '713-555-9100', 'olive@test.org', true),
    ('Ina', 'Inactive', '1970-03-03', '713-555-9200', 'ina@test.org', false);
  INSERT INTO patient_creds (patient_id, username, password_hash)
  SELECT 2, 'olive@test.org', password_hash FROM patient_creds WHERE patient_id = 1;
  INSERT INTO employee_creds (employee_id, username, password_hash)
  SELECT e.id, e.username, c.password_hash
  FROM (VALUES (4, 'rita@test.org'), (16, 'mia@test.org')) AS e(id, username)
  CROSS JOIN employee_creds c WHERE c.employee_id = 1;

  -- cardiology referrals to Dan, written by Fay
  INSERT INTO referral (patient_id, referring_doctor_id, specialist_doctor_id, specialty_id, date_issued, expiration_date, status)
  SELECT r.patient_id, 5, 2, 2, t.today + r.issued, t.today + r.expires, r.status
  FROM (VALUES
    (1, 2, -1, 30, 'Approved'), (2, 1, -1, 30, 'Pending'), (3, 1, -1, 30, 'Denied'), (4, 1, -60, -1, 'Approved'), (5, 1, 20, 40, 'Approved')
  ) AS r(ord, patient_id, issued, expires, status)
  CROSS JOIN (SELECT (now() AT TIME ZONE 'America/Chicago')::date AS today) t
  ORDER BY r.ord;
`;

const WEEK = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

let app: Awaited<ReturnType<typeof startTestApp>>;
let today: string;
let anonymous: TestClient, pat: TestClient, olive: TestClient, rita: TestClient, mia: TestClient;
let nurse: TestClient, doctor: TestClient, admin: TestClient;

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  await app.db.query(SETUP);
  today = (await app.db.query(`SELECT to_char((now() AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD') AS today`)).rows[0].today;

  anonymous = app.client();
  pat = await app.loginPatient(PATIENT.pat, "pat@test.org");
  olive = await app.loginPatient(PATIENT.olive, "olive@test.org");
  rita = await app.loginStaff(RECEPTIONIST.westside);
  mia = await app.loginStaff(RECEPTIONIST.main);
  nurse = await app.loginStaff(ids.nurse);
  doctor = await app.loginStaff(ids.doctor);
  admin = await app.loginStaff(ids.admin);
});

after(() => app.close());

// a clinic date n days from today
function day(n: number) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

const weekday = (date: string) => WEEK[new Date(`${date}T00:00:00Z`).getUTCDay()];

async function availability(client: TestClient, params: Record<string, string | number>) {
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
  return client.get(`/api/availability?${query}`);
}

async function openSlots(client: TestClient, params: Record<string, string | number>) {
  const res = await availability(client, params);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.map((slot: { timeSlotId: number }) => slot.timeSlotId) as number[];
}

function book(client: TestClient, body: Record<string, unknown>) {
  return client.post("/api/appointments", body);
}

async function booked(client: TestClient, body: Record<string, unknown>) {
  const res = await book(client, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.appointmentId as number;
}

// inserts an appointment directly, skipping the booking API
async function insertAppointment(a: { patientId: number; doctorId: number; officeId: number; specialtyId: number; date: string; timeSlotId: number; status?: string }) {
  const { rows } = await app.db.query(
    `
    INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, status, booking_channel)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'Web')
    RETURNING appointment_id
    `,
    [a.patientId, a.doctorId, a.officeId, a.date, a.timeSlotId, a.specialtyId, a.status ?? "Scheduled"]
  );
  return rows[0].appointment_id as number;
}

async function activeCount(doctorId: number, date: string) {
  const { rows } = await app.db.query(
    `SELECT count(*)::int AS n FROM appointment WHERE doctor_id = $1 AND appointment_date = $2 AND status <> 'Cancelled'`,
    [doctorId, date]
  );
  return rows[0].n as number;
}

const statuses = (responses: TestResponse[]) => responses.map((r) => r.status).sort();

// waits until a request is stuck behind a lock held by the test
async function waitForLockWait() {
  for (let i = 0; i < 100; i++) {
    const { rows } = await app.db.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    if (rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("No request started waiting for the lock");
}

describe("availability", () => {
  test("a date maps to the doctor's weekday schedule", async () => {
    const week = await availability(pat, { date: day(7), days: 7, doctorId: DOCTOR.wendy });
    assert.equal(week.status, 200);
    assert.deepEqual([...new Set(week.body.map((s: { date: string }) => s.date))], [day(7)]);
    assert.equal(weekday(week.body[0].date), weekday(day(7)));
    assert.deepEqual(await openSlots(pat, { date: day(8), doctorId: DOCTOR.wendy }), []);
  });

  test("returns the active slots of the scheduled shift with office, doctor, specialty, and times", async () => {
    const res = await availability(pat, { date: day(7), doctorId: DOCTOR.fay });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body[0], {
      date: day(7),
      doctorId: DOCTOR.fay,
      doctorName: "Fay Family",
      officeId: ids.mainOffice,
      officeName: "Main Street Clinic",
      specialtyId: ids.familyMedicine,
      specialty: "Family Medicine",
      requiresReferral: false,
      referralId: null,
      timeSlotId: SLOT.m0800,
      startTime: "08:00",
      endTime: "08:30",
    });
    assert.deepEqual(
      res.body.map((s: { timeSlotId: number }) => s.timeSlotId),
      [SLOT.m0800, SLOT.m0830, SLOT.m0900, SLOT.m1000, SLOT.m1100]
    );
    assert.deepEqual(await openSlots(pat, { date: day(7), doctorId: DOCTOR.fred }), [
      SLOT.f0800, SLOT.f0830, SLOT.f0900, SLOT.f0930, SLOT.f1015, SLOT.f1300,
    ]);
  });

  test("leaves out inactive doctors, offices, specialties, assignments, schedules, and shifts", async () => {
    for (const doctorId of [DOCTOR.ivan, DOCTOR.olga, DOCTOR.una, DOCTOR.sam, DOCTOR.rex, DOCTOR.cal]) {
      assert.deepEqual(await openSlots(pat, { date: day(7), doctorId }), [], `doctor ${doctorId}`);
    }
    const all = await availability(pat, { date: day(7) });
    const doctors = [...new Set(all.body.map((s: { doctorId: number }) => s.doctorId))].sort((a, b) => Number(a) - Number(b));
    assert.deepEqual(doctors, [DOCTOR.dan, DOCTOR.fay, DOCTOR.fred, DOCTOR.wendy, DOCTOR.nora, DOCTOR.carl]);
  });

  test("leaves out past dates and slots that already started today", async () => {
    assert.deepEqual(await openSlots(pat, { date: day(-1), doctorId: DOCTOR.fay }), []);
    assert.deepEqual(await openSlots(pat, { date: today, doctorId: DOCTOR.nora }), []);
    assert.deepEqual(await openSlots(pat, { date: day(7), doctorId: DOCTOR.nora }), [SLOT.night0000]);
  });

  test("leaves out times the doctor is booked, even through another shift's slot", async () => {
    await insertAppointment({ patientId: PATIENT.olive, doctorId: DOCTOR.fred, officeId: ids.westsideOffice, specialtyId: ids.familyMedicine, date: day(9), timeSlotId: SLOT.m0800 });
    await insertAppointment({ patientId: PATIENT.olive, doctorId: DOCTOR.fred, officeId: ids.westsideOffice, specialtyId: ids.familyMedicine, date: day(9), timeSlotId: SLOT.f0830, status: "Cancelled" });
    assert.deepEqual(await openSlots(pat, { date: day(9), doctorId: DOCTOR.fred }), [
      SLOT.f0830, SLOT.f0900, SLOT.f0930, SLOT.f1015, SLOT.f1300,
    ]);
  });

  test("leaves out times that overlap the patient's other appointments", async () => {
    await booked(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(10), timeSlotId: SLOT.m0900 });
    await booked(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(10), timeSlotId: SLOT.m1000 });

    // 09:00 matches, 10:15 overlaps the 10:00 visit, and 09:30 starts as the 09:00 visit ends
    const forPat = [SLOT.f0800, SLOT.f0830, SLOT.f0930, SLOT.f1300];
    assert.deepEqual(await openSlots(pat, { date: day(10), doctorId: DOCTOR.fred }), forPat);
    assert.deepEqual(await openSlots(rita, { date: day(10), doctorId: DOCTOR.fred, patientId: PATIENT.pat }), forPat);
    assert.deepEqual(await openSlots(rita, { date: day(10), doctorId: DOCTOR.fred }), [
      SLOT.f0800, SLOT.f0830, SLOT.f0900, SLOT.f0930, SLOT.f1015, SLOT.f1300,
    ]);
  });

  test("receptionists only see their own office", async () => {
    const westside = await availability(rita, { date: day(7) });
    assert.equal(westside.status, 200);
    assert.ok(westside.body.length > 0);
    assert.ok(westside.body.every((s: { officeId: number }) => s.officeId === ids.westsideOffice));
    const main = await availability(mia, { date: day(7) });
    assert.ok(main.body.every((s: { officeId: number }) => s.officeId === ids.mainOffice));
    assert.equal((await availability(rita, { date: day(7), officeId: ids.mainOffice })).status, 403);
  });

  test("shows which referral a patient would use for a referral specialty", async () => {
    const forOlive = await availability(olive, { date: day(7), doctorId: DOCTOR.dan });
    assert.ok(forOlive.body.length > 0);
    assert.ok(forOlive.body.every((s: { requiresReferral: boolean; referralId: number }) => s.requiresReferral && s.referralId === REFERRAL.oliveApproved));
    const forPat = await availability(pat, { date: day(7), doctorId: DOCTOR.dan });
    assert.ok(forPat.body.every((s: { referralId: number | null }) => s.referralId === null));
  });

  test("checks the search and keeps patients to their own", async () => {
    assert.equal((await pat.get("/api/availability")).status, 400);
    assert.equal((await availability(pat, { date: "next tuesday" })).status, 400);
    assert.equal((await availability(pat, { date: day(7), days: 15 })).status, 400);
    assert.equal((await availability(pat, { date: day(7), patientId: PATIENT.olive })).status, 403);
    assert.equal((await availability(pat, { date: day(7), patientId: PATIENT.pat })).status, 200);
  });
});

describe("public availability", () => {
  const PUBLIC_FIELDS = [
    "date", "doctorId", "doctorName", "endTime", "officeId", "officeName", "requiresReferral", "specialty", "specialtyId", "startTime", "timeSlotId",
  ];
  const BAD_IDS = ["abc", "0", "-1", "1.5", "99999999999"];
  const family = ids.familyMedicine;

  function publicSearch(client: TestClient, params: Record<string, string | number>) {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    return client.get(`/api/public/availability?${query}`);
  }

  async function publicSlots(params: Record<string, string | number>) {
    const res = await publicSearch(anonymous, params);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.map((slot: { timeSlotId: number }) => slot.timeSlotId) as number[];
  }

  const doctorsIn = (slots: { doctorId: number }[]) => [...new Set(slots.map((s) => s.doctorId))].sort((a, b) => a - b);

  test("visitors see open times without signing in", async () => {
    const res = await publicSearch(anonymous, { specialtyId: family, date: day(7), doctorId: DOCTOR.fay });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body[0], {
      date: day(7),
      doctorId: DOCTOR.fay,
      doctorName: "Fay Family",
      officeId: ids.mainOffice,
      officeName: "Main Street Clinic",
      specialtyId: family,
      specialty: "Family Medicine",
      requiresReferral: false,
      timeSlotId: SLOT.m0800,
      startTime: "08:00",
      endTime: "08:30",
    });
    assert.deepEqual(
      res.body.map((s: { timeSlotId: number }) => s.timeSlotId),
      [SLOT.m0800, SLOT.m0830, SLOT.m0900, SLOT.m1000, SLOT.m1100]
    );
  });

  test("matches the signed in search apart from referrals", async () => {
    // a receptionist search without a patient uses the same rules, over two weeks of schedules and bookings
    for (const [client, officeId] of [[mia, ids.mainOffice], [rita, ids.westsideOffice]] as const) {
      const search = { specialtyId: family, officeId, date: day(7), days: 14 };
      const signedIn = await availability(client, search);
      assert.equal(signedIn.status, 200);
      const visitor = await publicSearch(anonymous, search);
      assert.equal(visitor.status, 200);
      assert.ok(visitor.body.length > 0);
      assert.deepEqual(visitor.body, signedIn.body.map(({ referralId, ...slot }: { referralId: number | null }) => slot));
    }
  });

  test("specialty and date are required and checked", async () => {
    const cases: [Record<string, string | number>, string][] = [
      [{ date: day(7) }, "ID must be a positive whole number"],
      [{ specialtyId: family }, "Date must look like 2026-11-10"],
      [{ specialtyId: family, date: "next tuesday" }, "Date must look like 2026-11-10"],
      [{ specialtyId: family, date: "2026-02-30" }, "Date must look like 2026-11-10"],
    ];
    for (const [params, message] of cases) {
      const res = await publicSearch(anonymous, params);
      assert.equal(res.status, 400, JSON.stringify(params));
      assert.equal(res.body.error, message);
    }
  });

  test("year 0 dates are turned away before they reach the database", async () => {
    for (const date of ["0000-01-01", "0000-02-29", "0000-12-31"]) {
      const responses = [
        await publicSearch(anonymous, { specialtyId: family, date }),
        await availability(pat, { specialtyId: family, date }),
        await book(pat, { doctorId: DOCTOR.fay, specialtyId: family, date, timeSlotId: SLOT.m0800 }),
      ];
      for (const res of responses) {
        assert.equal(res.status, 400, `${date}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.error, "Date must look like 2026-11-10");
      }
    }

    // the first and last dates zod allows still reach the scheduling rules
    for (const date of ["0001-01-01", "9999-12-31"]) {
      assert.equal((await publicSearch(anonymous, { specialtyId: family, date, days: 14 })).status, 200, date);
      assert.equal((await availability(pat, { specialtyId: family, date, days: 14 })).status, 200, date);
    }
    assert.deepEqual(await publicSlots({ specialtyId: family, date: "0001-01-01", days: 14 }), []);
    const past = await book(pat, { doctorId: DOCTOR.fay, specialtyId: family, date: "0001-01-01", timeSlotId: SLOT.m0800 });
    assert.equal(past.status, 409);
    assert.equal(past.body.error, "Appointments must be booked for a future time");
  });

  test("checks the day range and every ID", async () => {
    const dates = async (days?: number) => {
      const res = await publicSearch(anonymous, { specialtyId: family, date: day(7), doctorId: DOCTOR.fay, ...(days ? { days } : {}) });
      assert.equal(res.status, 200);
      return [...new Set(res.body.map((s: { date: string }) => s.date))];
    };
    assert.deepEqual(await dates(), [day(7)]);
    assert.deepEqual(await dates(14), Array.from({ length: 14 }, (_, i) => day(7 + i)));

    for (const days of ["0", "15", "-1", "1.5", "abc"]) {
      assert.equal((await publicSearch(anonymous, { specialtyId: family, date: day(7), days })).status, 400, days);
    }
    for (const name of ["specialtyId", "doctorId", "officeId"]) {
      for (const bad of BAD_IDS) {
        const res = await publicSearch(anonymous, { specialtyId: family, date: day(7), [name]: bad });
        assert.equal(res.status, 400, `${name}=${bad}`);
        assert.equal(res.body.error, "ID must be a positive whole number");
      }
    }
  });

  test("doctor and office filters narrow the results", async () => {
    const doctors = async (params: Record<string, number>) => {
      const res = await publicSearch(anonymous, { date: day(7), ...params });
      assert.equal(res.status, 200);
      return doctorsIn(res.body);
    };
    assert.deepEqual(await doctors({ specialtyId: family }), [DOCTOR.fay, DOCTOR.fred, DOCTOR.wendy, DOCTOR.nora]);
    assert.deepEqual(await doctors({ specialtyId: ids.cardiology }), [DOCTOR.dan, DOCTOR.carl]);
    assert.deepEqual(await doctors({ specialtyId: family, officeId: ids.westsideOffice }), [DOCTOR.fred]);
    assert.deepEqual(await doctors({ specialtyId: family, officeId: ids.mainOffice }), [DOCTOR.fay, DOCTOR.wendy, DOCTOR.nora]);
    assert.deepEqual(await doctors({ specialtyId: family, doctorId: DOCTOR.fred }), [DOCTOR.fred]);
    assert.deepEqual(await doctors({ specialtyId: family, doctorId: DOCTOR.fred, officeId: ids.mainOffice }), []);
    assert.deepEqual(await doctors({ specialtyId: family, doctorId: DOCTOR.carl }), []);
  });

  test("leaves out inactive doctors, offices, specialties, assignments, schedules, shifts, and slots", async () => {
    for (const doctorId of [DOCTOR.ivan, DOCTOR.olga, DOCTOR.una, DOCTOR.sam, DOCTOR.cal]) {
      assert.deepEqual(await publicSlots({ specialtyId: family, date: day(7), doctorId }), [], `doctor ${doctorId}`);
    }
    assert.deepEqual(await publicSlots({ specialtyId: ids.retiredSpecialty, date: day(7) }), []);
    assert.deepEqual(await publicSlots({ specialtyId: family, date: day(7), officeId: ids.closedOffice }), []);
    assert.equal((await publicSlots({ specialtyId: family, date: day(7), doctorId: DOCTOR.fay })).includes(SLOT.m0930Inactive), false);
  });

  test("leaves out past dates and times that already started", async () => {
    assert.deepEqual(await publicSlots({ specialtyId: family, date: day(-1), doctorId: DOCTOR.fay }), []);
    assert.deepEqual(await publicSlots({ specialtyId: family, date: today, doctorId: DOCTOR.nora }), []);
    assert.deepEqual(await publicSlots({ specialtyId: family, date: day(7), doctorId: DOCTOR.nora }), [SLOT.night0000]);

    const fromYesterday = await publicSearch(anonymous, { specialtyId: family, date: day(-1), days: 3 });
    assert.ok(fromYesterday.body.length > 0);
    assert.ok(fromYesterday.body.every((s: { date: string }) => s.date >= today));
  });

  test("booked times are left out and cancelled ones come back", async () => {
    const search = { specialtyId: family, date: day(29), doctorId: DOCTOR.fred };
    const appointmentId = await booked(olive, { doctorId: DOCTOR.fred, specialtyId: family, date: day(29), timeSlotId: SLOT.f0900 });
    // a Morning slot visit still blocks Fred's Full Day slot that overlaps it
    await insertAppointment({ patientId: PATIENT.olive, doctorId: DOCTOR.fred, officeId: ids.westsideOffice, specialtyId: family, date: day(29), timeSlotId: SLOT.m1000 });
    assert.deepEqual(await publicSlots(search), [SLOT.f0800, SLOT.f0830, SLOT.f0930, SLOT.f1300]);

    assert.equal((await olive.patch(`/api/appointments/${appointmentId}/cancel`)).status, 200);
    assert.deepEqual(await publicSlots(search), [SLOT.f0800, SLOT.f0830, SLOT.f0900, SLOT.f0930, SLOT.f1300]);
  });

  test("a patient in the query or the session doesn't change the results", async () => {
    await booked(pat, { doctorId: DOCTOR.fay, specialtyId: family, date: day(30), timeSlotId: SLOT.m0900 });
    const search = { specialtyId: family, date: day(30), doctorId: DOCTOR.fred };
    const everyTime = [SLOT.f0800, SLOT.f0830, SLOT.f0900, SLOT.f0930, SLOT.f1015, SLOT.f1300];

    // Pat's own search still hides the time that overlaps Pat's visit with Fay
    assert.deepEqual(await openSlots(pat, search), [SLOT.f0800, SLOT.f0830, SLOT.f0930, SLOT.f1015, SLOT.f1300]);
    assert.deepEqual(await publicSlots(search), everyTime);
    assert.deepEqual(await publicSlots({ ...search, patientId: PATIENT.pat, referralId: REFERRAL.oliveApproved }), everyTime);

    const signedIn = await publicSearch(pat, { ...search, patientId: PATIENT.pat });
    assert.equal(signedIn.status, 200);
    assert.deepEqual(signedIn.body.map((s: { timeSlotId: number }) => s.timeSlotId), everyTime);
  });

  test("responses have only public fields and nothing about patients or referrals", async () => {
    // Olive has an approved referral to Dan, which her own search shows
    const forOlive = await availability(olive, { specialtyId: ids.cardiology, date: day(7), doctorId: DOCTOR.dan });
    assert.ok(forOlive.body.every((s: { referralId: number | null }) => s.referralId === REFERRAL.oliveApproved));

    const bodies = [];
    for (const [client, params] of [
      [anonymous, { specialtyId: ids.cardiology, date: day(7), days: 14 }],
      [olive, { specialtyId: ids.cardiology, date: day(7), doctorId: DOCTOR.dan, patientId: PATIENT.olive, referralId: REFERRAL.oliveApproved }],
      [pat, { specialtyId: family, date: day(7), days: 14, patientId: PATIENT.pat }],
    ] as const) {
      const res = await publicSearch(client, params);
      assert.equal(res.status, 200);
      assert.ok(res.body.length > 0);
      for (const slot of res.body) assert.deepEqual(Object.keys(slot).sort(), PUBLIC_FIELDS);
      bodies.push(res.body);
    }
    assert.ok(bodies[1].every((s: { requiresReferral: boolean }) => s.requiresReferral));
    assert.doesNotMatch(JSON.stringify(bodies), /referral_?id|patient|busy|started|olive|pat@|713-555-|1990-01-01|1995-02-02|password/i);
  });

  test("searching public times doesn't open the signed in booking routes", async () => {
    assert.equal((await publicSearch(anonymous, { specialtyId: family, date: day(31) })).status, 200);
    assert.equal((await availability(anonymous, { date: day(31) })).status, 401);
    assert.equal((await book(anonymous, { doctorId: DOCTOR.fay, specialtyId: family, date: day(31), timeSlotId: SLOT.m0800 })).status, 401);

    // employees can look at public times too, but still can't book
    assert.equal((await publicSearch(doctor, { specialtyId: family, date: day(31) })).status, 200);
    const res = await book(doctor, { patientId: PATIENT.olive, doctorId: DOCTOR.fay, specialtyId: family, date: day(31), timeSlotId: SLOT.m0800 });
    assert.equal(res.status, 403);
    assert.equal(await activeCount(DOCTOR.fay, day(31)), 0);
  });
});

describe("booking", () => {
  test("a patient books a Web appointment for their own account", async () => {
    const res = await book(pat, {
      doctorId: DOCTOR.fay,
      specialtyId: ids.familyMedicine,
      date: day(11),
      timeSlotId: SLOT.m0800,
      // the API decides these, so they're ignored
      bookingChannel: "Phone",
      status: "Completed",
      officeId: ids.westsideOffice,
      bookedByEmployeeId: RECEPTIONIST.westside,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body, {
      appointmentId: res.body.appointmentId,
      patientId: PATIENT.pat,
      patientName: "Pat Patient",
      doctorId: DOCTOR.fay,
      doctorName: "Fay Family",
      officeId: ids.mainOffice,
      officeName: "Main Street Clinic",
      specialtyId: ids.familyMedicine,
      specialty: "Family Medicine",
      date: day(11),
      timeSlotId: SLOT.m0800,
      startTime: "08:00",
      endTime: "08:30",
      status: "Scheduled",
      bookingChannel: "Web",
      bookedByEmployeeId: null,
      referralId: null,
      checkedIn: false,
    });

    const { rows } = await app.db.query(
      `SELECT patient_id, doctor_id, office_id, specialty_id, time_slot_id, status, booking_channel, booked_by_employee_id, referral_id,
         to_char(appointment_date, 'YYYY-MM-DD') AS date
       FROM appointment WHERE appointment_id = $1`,
      [res.body.appointmentId]
    );
    assert.deepEqual(rows[0], {
      patient_id: PATIENT.pat,
      doctor_id: DOCTOR.fay,
      office_id: ids.mainOffice,
      specialty_id: ids.familyMedicine,
      time_slot_id: SLOT.m0800,
      status: "Scheduled",
      booking_channel: "Web",
      booked_by_employee_id: null,
      referral_id: null,
      date: day(11),
    });
  });

  test("patients can only book for themselves", async () => {
    const forOlive = await book(pat, { patientId: PATIENT.olive, doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(11), timeSlotId: SLOT.m0830 });
    assert.equal(forOlive.status, 403);
    const forSelf = await book(pat, { patientId: PATIENT.pat, doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(11), timeSlotId: SLOT.m0830 });
    assert.equal(forSelf.status, 201);
    assert.equal(forSelf.body.patientId, PATIENT.pat);
  });

  test("a receptionist books a Phone appointment for a patient at their office", async () => {
    const res = await book(rita, { patientId: PATIENT.olive, doctorId: DOCTOR.fred, specialtyId: ids.familyMedicine, date: day(11), timeSlotId: SLOT.f0800 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.patientId, PATIENT.olive);
    assert.equal(res.body.officeId, ids.westsideOffice);
    assert.equal(res.body.bookingChannel, "Phone");
    assert.equal(res.body.bookedByEmployeeId, RECEPTIONIST.westside);
  });

  test("receptionists must choose an existing, active patient", async () => {
    const slot = { doctorId: DOCTOR.fred, specialtyId: ids.familyMedicine, date: day(11), timeSlotId: SLOT.f0830 };
    assert.equal((await book(rita, slot)).status, 400);
    assert.equal((await book(rita, { ...slot, patientId: 999 })).status, 404);
    assert.equal((await book(rita, { ...slot, patientId: PATIENT.ina })).status, 409);
    assert.equal(await activeCount(DOCTOR.fred, day(11)), 1);
  });

  test("receptionists can't book at another office", async () => {
    const atMain = { patientId: PATIENT.olive, doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(11), timeSlotId: SLOT.m0900 };
    const res = await book(rita, atMain);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /own office/);
    assert.equal((await book(mia, atMain)).status, 201);
  });

  test("only active, scheduled doctor, specialty, shift, and slot combinations can be booked", async () => {
    const before = (await app.db.query("SELECT count(*)::int AS n FROM appointment")).rows[0].n;
    const familyMedicine = { specialtyId: ids.familyMedicine, date: day(11) };
    const cases: [string, Record<string, unknown>][] = [
      ["unknown doctor", { ...familyMedicine, doctorId: 999, timeSlotId: SLOT.m0800 }],
      ["unknown slot", { ...familyMedicine, doctorId: DOCTOR.fay, timeSlotId: 999 }],
      ["specialty the schedule isn't for", { doctorId: DOCTOR.fay, specialtyId: ids.cardiology, date: day(11), timeSlotId: SLOT.m1000 }],
      ["slot from another shift", { ...familyMedicine, doctorId: DOCTOR.fay, timeSlotId: SLOT.f1300 }],
      ["inactive slot", { ...familyMedicine, doctorId: DOCTOR.fay, timeSlotId: SLOT.m0930Inactive }],
      ["inactive doctor", { ...familyMedicine, doctorId: DOCTOR.ivan, timeSlotId: SLOT.m0800 }],
      ["inactive office", { ...familyMedicine, doctorId: DOCTOR.olga, timeSlotId: SLOT.m0800 }],
      ["inactive specialty assignment", { ...familyMedicine, doctorId: DOCTOR.una, timeSlotId: SLOT.m0800 }],
      ["inactive schedule", { ...familyMedicine, doctorId: DOCTOR.sam, timeSlotId: SLOT.m0800 }],
      ["inactive specialty", { doctorId: DOCTOR.rex, specialtyId: ids.retiredSpecialty, date: day(11), timeSlotId: SLOT.m0800 }],
      ["inactive shift", { ...familyMedicine, doctorId: DOCTOR.cal, timeSlotId: SLOT.closedShift0800 }],
      ["weekday without a schedule", { ...familyMedicine, doctorId: DOCTOR.wendy, date: day(8), timeSlotId: SLOT.m0800 }],
    ];
    for (const [label, body] of cases) {
      const res = await book(olive, body);
      assert.equal(res.status, 409, `${label}: ${JSON.stringify(res.body)}`);
    }
    assert.equal((await app.db.query("SELECT count(*)::int AS n FROM appointment")).rows[0].n, before);
  });

  test("past dates and slots that already started can't be booked", async () => {
    const past = await book(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(-1), timeSlotId: SLOT.m0800 });
    assert.equal(past.status, 409);
    assert.match(past.body.error, /future/);
    const started = await book(pat, { doctorId: DOCTOR.nora, specialtyId: ids.familyMedicine, date: today, timeSlotId: SLOT.night0000 });
    assert.equal(started.status, 409);
  });

  test("a taken time can't be booked again, even through another shift's slot", async () => {
    const same = await book(olive, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(11), timeSlotId: SLOT.m0800 });
    assert.equal(same.status, 409);
    assert.match(same.body.error, /no longer available/);
    // Fred has a Morning slot appointment at 08:00 on day 9 from the availability tests
    const overlap = await book(pat, { doctorId: DOCTOR.fred, specialtyId: ids.familyMedicine, date: day(9), timeSlotId: SLOT.f0800 });
    assert.equal(overlap.status, 409);
    assert.equal(await activeCount(DOCTOR.fay, day(11)), 3);
  });

  test("a patient can't have overlapping appointments with different doctors", async () => {
    const fred = { doctorId: DOCTOR.fred, specialtyId: ids.familyMedicine, date: day(10) };
    const exact = await book(pat, { ...fred, timeSlotId: SLOT.f0900 });
    assert.equal(exact.status, 409);
    assert.match(exact.body.error, /already has an appointment/);
    assert.equal((await book(pat, { ...fred, timeSlotId: SLOT.f1015 })).status, 409);
    assert.equal((await book(pat, { ...fred, timeSlotId: SLOT.f0930 })).status, 201);
  });

  test("referral specialties need an approved, current referral for that patient, doctor, and specialty", async () => {
    const before = (await app.db.query("SELECT count(*)::int AS n FROM appointment")).rows[0].n;
    const dan = { doctorId: DOCTOR.dan, specialtyId: ids.cardiology, date: day(7), timeSlotId: SLOT.m0800 };
    const cases: [string, number | undefined][] = [
      ["no referral", undefined],
      ["pending", REFERRAL.patPending],
      ["denied", REFERRAL.patDenied],
      ["expired", REFERRAL.patExpired],
      ["issued after the visit", REFERRAL.patIssuedLater],
      ["another patient's referral", REFERRAL.oliveApproved],
    ];
    for (const [label, referralId] of cases) {
      const res = await book(pat, { ...dan, referralId });
      assert.equal(res.status, 409, `${label}: ${JSON.stringify(res.body)}`);
    }
    // Olive's referral names Dan, so it doesn't cover another cardiologist
    const carl = { doctorId: DOCTOR.carl, specialtyId: ids.cardiology, date: day(7), timeSlotId: SLOT.m0800 };
    assert.equal((await book(olive, carl)).status, 409);
    assert.equal((await book(olive, { ...carl, referralId: REFERRAL.oliveApproved })).status, 409);
    assert.equal((await app.db.query("SELECT count(*)::int AS n FROM appointment")).rows[0].n, before);
  });

  test("a valid referral is used and saved on the appointment", async () => {
    const found = await book(olive, { doctorId: DOCTOR.dan, specialtyId: ids.cardiology, date: day(7), timeSlotId: SLOT.m0800 });
    assert.equal(found.status, 201, JSON.stringify(found.body));
    assert.equal(found.body.referralId, REFERRAL.oliveApproved);

    const named = await book(olive, { doctorId: DOCTOR.dan, specialtyId: ids.cardiology, date: day(8), timeSlotId: SLOT.m0830, referralId: REFERRAL.oliveApproved });
    assert.equal(named.status, 201);
    assert.equal(named.body.referralId, REFERRAL.oliveApproved);

    // Pat's later referral is issued on day 20, so it covers day 21
    const later = await book(pat, { doctorId: DOCTOR.dan, specialtyId: ids.cardiology, date: day(21), timeSlotId: SLOT.m0800 });
    assert.equal(later.status, 201, JSON.stringify(later.body));
    assert.equal(later.body.referralId, REFERRAL.patIssuedLater);

    const { rows } = await app.db.query(`SELECT referral_id FROM appointment WHERE appointment_id = $1`, [found.body.appointmentId]);
    assert.equal(rows[0].referral_id, REFERRAL.oliveApproved);
  });

  test("a referral sent for a specialty that doesn't need one must still be valid", async () => {
    const res = await book(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(7), timeSlotId: SLOT.m1100, referralId: REFERRAL.oliveApproved });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /referral/);
  });
});

describe("simultaneous bookings", () => {
  test("two patients booking the same doctor and time: exactly one succeeds", async () => {
    const slot = { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(12), timeSlotId: SLOT.m0830 };
    const results = await Promise.all([book(pat, slot), book(olive, slot)]);
    assert.deepEqual(statuses(results), [201, 409]);
    assert.equal(await activeCount(DOCTOR.fay, day(12)), 1);
  });

  test("a patient and a receptionist booking the same doctor at once: exactly one succeeds", async () => {
    const slot = { doctorId: DOCTOR.fred, specialtyId: ids.familyMedicine, date: day(13), timeSlotId: SLOT.f0830 };
    const results = await Promise.all([book(olive, slot), book(rita, { ...slot, patientId: PATIENT.pat })]);
    assert.deepEqual(statuses(results), [201, 409]);
    assert.equal(await activeCount(DOCTOR.fred, day(13)), 1);
  });

  test("one patient booked with two doctors at the same time through different slot ids: exactly one succeeds", async () => {
    const results = await Promise.all([
      book(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(15), timeSlotId: SLOT.m0900 }),
      book(rita, { patientId: PATIENT.pat, doctorId: DOCTOR.fred, specialtyId: ids.familyMedicine, date: day(15), timeSlotId: SLOT.f0900 }),
    ]);
    assert.deepEqual(statuses(results), [201, 409]);
    const { rows } = await app.db.query(
      `SELECT count(*)::int AS n FROM appointment WHERE patient_id = $1 AND appointment_date = $2 AND status <> 'Cancelled'`,
      [PATIENT.pat, day(15)]
    );
    assert.equal(rows[0].n, 1);
  });

  test("a burst of requests for one time creates exactly one appointment", async () => {
    const slot = { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(16), timeSlotId: SLOT.m1000 };
    const results = await Promise.all([
      book(pat, slot),
      book(olive, slot),
      book(mia, { ...slot, patientId: PATIENT.pat }),
      book(mia, { ...slot, patientId: PATIENT.olive }),
      book(pat, slot),
      book(olive, slot),
    ]);
    assert.deepEqual(statuses(results), [201, 409, 409, 409, 409, 409]);
    assert.equal(await activeCount(DOCTOR.fay, day(16)), 1);
  });

  test("a booking waits for an in progress booking of the doctor and then sees it", async () => {
    const other = await app.db.connect();
    try {
      await other.query("BEGIN");
      await other.query(`SELECT 1 FROM doctor_schedule WHERE doctor_id = $1 AND day_of_week = $2 FOR UPDATE`, [DOCTOR.fay, weekday(day(17))]);
      await other.query(
        `INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, booking_channel)
         VALUES ($1, $2, $3, $4, $5, $6, 'Web')`,
        [PATIENT.olive, DOCTOR.fay, ids.mainOffice, day(17), SLOT.m0800, ids.familyMedicine]
      );
      const waiting = book(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(17), timeSlotId: SLOT.m0800 });
      await waitForLockWait();
      await other.query("COMMIT");
      const res = await waiting;
      assert.equal(res.status, 409);
      // the booking service caught it, not the database trigger
      assert.match(res.body.error, /no longer available/);
    } finally {
      other.release();
    }
  });

  test("a booking waits for an in progress booking of the same patient and then sees it", async () => {
    const other = await app.db.connect();
    try {
      await other.query("BEGIN");
      await other.query(`SELECT 1 FROM patient WHERE patient_id = $1 FOR NO KEY UPDATE`, [PATIENT.pat]);
      await other.query(
        `INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, booking_channel)
         VALUES ($1, $2, $3, $4, $5, $6, 'Web')`,
        [PATIENT.pat, DOCTOR.fred, ids.westsideOffice, day(18), SLOT.f0800, ids.familyMedicine]
      );
      const waiting = book(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(18), timeSlotId: SLOT.m0800 });
      await waitForLockWait();
      await other.query("COMMIT");
      const res = await waiting;
      assert.equal(res.status, 409);
      assert.match(res.body.error, /already has an appointment/);
    } finally {
      other.release();
    }
  });
});

describe("admin schedule changes during booking", () => {
  test("a booking waiting on a schedule change sees the schedule turned off", async () => {
    const dayOfWeek = weekday(day(19));
    const other = await app.db.connect();
    try {
      await other.query("BEGIN");
      await other.query(`SELECT 1 FROM doctor_schedule WHERE doctor_id = $1 AND day_of_week = $2 FOR UPDATE`, [DOCTOR.fay, dayOfWeek]);
      const waiting = book(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(19), timeSlotId: SLOT.m0800 });
      await waitForLockWait();
      await other.query(`UPDATE doctor_schedule SET is_active = false WHERE doctor_id = $1 AND day_of_week = $2`, [DOCTOR.fay, dayOfWeek]);
      await other.query("COMMIT");
      const res = await waiting;
      assert.equal(res.status, 409);
      assert.match(res.body.error, /isn't scheduled/);
    } finally {
      other.release();
      await app.db.query(`UPDATE doctor_schedule SET is_active = true WHERE doctor_id = $1 AND day_of_week = $2`, [DOCTOR.fay, dayOfWeek]);
    }
  });

  test("a booking waiting on a time slot change sees the slot turned off", async () => {
    const other = await app.db.connect();
    try {
      await other.query("BEGIN");
      await other.query(`SELECT 1 FROM shift_type WHERE shift_type_id = $1 FOR UPDATE`, [ids.morningShift]);
      const waiting = book(olive, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(20), timeSlotId: SLOT.m0830 });
      await waitForLockWait();
      await other.query(`UPDATE time_slot SET is_active = false WHERE time_slot_id = $1`, [SLOT.m0830]);
      await other.query("COMMIT");
      assert.equal((await waiting).status, 409);
    } finally {
      other.release();
      await app.db.query(`UPDATE time_slot SET is_active = true WHERE time_slot_id = $1`, [SLOT.m0830]);
    }
  });

  test("once booked, the admin can't turn off the schedule or slot underneath it", async () => {
    await booked(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(19), timeSlotId: SLOT.m0830 });
    const schedule = await admin.patch(`/api/admin/schedules/${DOCTOR.fay}/${weekday(day(19))}/status`, { isActive: false });
    assert.equal(schedule.status, 409);
    const slot = await admin.patch(`/api/admin/time-slots/${SLOT.m0830}/status`, { isActive: false });
    assert.equal(slot.status, 409);
  });

  test("a booking racing a schedule deactivation: exactly one of them goes through", async () => {
    const [booking, change] = await Promise.all([
      book(pat, { doctorId: DOCTOR.wendy, specialtyId: ids.familyMedicine, date: day(14), timeSlotId: SLOT.m0800 }),
      admin.patch(`/api/admin/schedules/${DOCTOR.wendy}/${weekday(day(14))}/status`, { isActive: false }),
    ]);
    assert.equal([booking.status === 201, change.status === 200].filter(Boolean).length, 1, `${booking.status} ${change.status}`);
    await app.db.query(`UPDATE doctor_schedule SET is_active = true WHERE doctor_id = $1`, [DOCTOR.wendy]);
  });

  test("a booking racing a time slot deactivation: exactly one of them goes through", async () => {
    const [booking, change] = await Promise.all([
      book(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(21), timeSlotId: SLOT.m1100 }),
      admin.patch(`/api/admin/time-slots/${SLOT.m1100}/status`, { isActive: false }),
    ]);
    assert.equal([booking.status === 201, change.status === 200].filter(Boolean).length, 1, `${booking.status} ${change.status}`);
    await app.db.query(`UPDATE time_slot SET is_active = true WHERE time_slot_id = $1`, [SLOT.m1100]);
  });
});

describe("cancellation", () => {
  test("a patient cancels their own appointment and the record stays", async () => {
    const appointmentId = await booked(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(22), timeSlotId: SLOT.m0800 });
    const res = await pat.patch(`/api/appointments/${appointmentId}/cancel`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "Cancelled");
    const { rows } = await app.db.query(`SELECT status FROM appointment WHERE appointment_id = $1`, [appointmentId]);
    assert.deepEqual(rows, [{ status: "Cancelled" }]);
  });

  test("a cancelled time can be booked again", async () => {
    assert.ok((await openSlots(olive, { date: day(22), doctorId: DOCTOR.fay })).includes(SLOT.m0800));
    await booked(olive, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(22), timeSlotId: SLOT.m0800 });
  });

  test("receptionists cancel appointments at their own office only", async () => {
    const westside = await booked(rita, { patientId: PATIENT.olive, doctorId: DOCTOR.fred, specialtyId: ids.familyMedicine, date: day(23), timeSlotId: SLOT.f0800 });
    assert.equal((await rita.patch(`/api/appointments/${westside}/cancel`)).status, 200);

    const main = await booked(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(23), timeSlotId: SLOT.m0830 });
    const elsewhere = await rita.patch(`/api/appointments/${main}/cancel`);
    assert.equal(elsewhere.status, 403);
    assert.equal((await mia.patch(`/api/appointments/${main}/cancel`)).status, 200);
  });

  test("patients can't cancel someone else's appointment", async () => {
    const olives = await booked(olive, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(24), timeSlotId: SLOT.m0800 });
    assert.equal((await pat.patch(`/api/appointments/${olives}/cancel`)).status, 404);
    assert.equal((await pat.patch(`/api/appointments/999999/cancel`)).status, 404);
    const { rows } = await app.db.query(`SELECT status FROM appointment WHERE appointment_id = $1`, [olives]);
    assert.equal(rows[0].status, "Scheduled");
  });

  test("only upcoming scheduled appointments that haven't checked in can be cancelled", async () => {
    const fay = { patientId: PATIENT.pat, doctorId: DOCTOR.fay, officeId: ids.mainOffice, specialtyId: ids.familyMedicine };
    const past = await insertAppointment({ ...fay, date: day(-3), timeSlotId: SLOT.m0800 });
    const completed = await insertAppointment({ ...fay, date: day(26), timeSlotId: SLOT.m0830, status: "Completed" });
    const startedToday = await insertAppointment({ ...fay, doctorId: DOCTOR.nora, date: today, timeSlotId: SLOT.night0000 });
    const checkedIn = await booked(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(25), timeSlotId: SLOT.m0800 });
    await app.db.query(`UPDATE appointment SET checked_in_at = now() WHERE appointment_id = $1`, [checkedIn]);
    const cancelled = await booked(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(25), timeSlotId: SLOT.m0830 });
    assert.equal((await pat.patch(`/api/appointments/${cancelled}/cancel`)).status, 200);

    const cases: [string, number, RegExp][] = [
      ["past", past, /already started/],
      ["completed", completed, /Only scheduled/],
      ["started today", startedToday, /already started/],
      ["checked in", checkedIn, /checked in/],
      ["already cancelled", cancelled, /Only scheduled/],
    ];
    for (const [label, appointmentId, message] of cases) {
      const res = await pat.patch(`/api/appointments/${appointmentId}/cancel`);
      assert.equal(res.status, 409, label);
      assert.match(res.body.error, message, label);
    }
  });
});

describe("authorization and privacy", () => {
  let appointmentId: number;

  before(async () => {
    appointmentId = await booked(pat, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(27), timeSlotId: SLOT.m0800 });
  });

  test("every booking endpoint needs a login", async () => {
    assert.equal((await availability(anonymous, { date: day(7) })).status, 401);
    assert.equal((await book(anonymous, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(27), timeSlotId: SLOT.m0830 })).status, 401);
    assert.equal((await anonymous.patch(`/api/appointments/${appointmentId}/cancel`)).status, 401);
    assert.equal((await anonymous.get(`/api/appointments/${appointmentId}`)).status, 401);
  });

  test("doctors, nurses, and admins can't search, book, cancel, or read bookings", async () => {
    for (const [name, client] of [["doctor", doctor], ["nurse", nurse], ["admin", admin]] as const) {
      assert.equal((await availability(client, { date: day(7) })).status, 403, name);
      const res = await book(client, { patientId: PATIENT.olive, doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(27), timeSlotId: SLOT.m0830 });
      assert.equal(res.status, 403, name);
      assert.equal((await client.patch(`/api/appointments/${appointmentId}/cancel`)).status, 403, name);
      assert.equal((await client.get(`/api/appointments/${appointmentId}`)).status, 403, name);
    }
    assert.equal(await activeCount(DOCTOR.fay, day(27)), 1);
  });

  test("a deactivated receptionist loses booking access right away", async () => {
    await app.db.query(`UPDATE employee SET is_active = false WHERE employee_id = $1`, [RECEPTIONIST.main]);
    try {
      assert.equal((await availability(mia, { date: day(7) })).status, 401);
    } finally {
      await app.db.query(`UPDATE employee SET is_active = true WHERE employee_id = $1`, [RECEPTIONIST.main]);
    }
    // the old session was ended, so reactivating the account means signing in again
    assert.equal((await availability(mia, { date: day(7) })).status, 401);
    mia = await app.loginStaff(RECEPTIONIST.main);
    assert.equal((await availability(mia, { date: day(7) })).status, 200);
  });

  test("appointment details are limited to the patient and the office", async () => {
    const own = await pat.get(`/api/appointments/${appointmentId}`);
    assert.equal(own.status, 200);
    assert.deepEqual(Object.keys(own.body).sort(), [
      "appointmentId", "bookedByEmployeeId", "bookingChannel", "checkedIn", "date", "doctorId", "doctorName", "endTime",
      "officeId", "officeName", "patientId", "patientName", "referralId", "specialty", "specialtyId", "startTime", "status", "timeSlotId",
    ]);
    assert.equal((await olive.get(`/api/appointments/${appointmentId}`)).status, 404);
    assert.equal((await mia.get(`/api/appointments/${appointmentId}`)).status, 200);
    assert.equal((await rita.get(`/api/appointments/${appointmentId}`)).status, 403);
    assert.equal((await pat.get(`/api/appointments/999999`)).status, 404);

    const slots = await availability(pat, { date: day(7) });
    assert.doesNotMatch(JSON.stringify(slots.body), /patientName|dob|phone|email|password/i);
  });

  test("booking and cancelling each add one appointment history row", async () => {
    const history = async (id: number) =>
      (await app.db.query(`SELECT operation, old_status, new_status FROM appointment_history WHERE appointment_id = $1 ORDER BY history_id`, [id])).rows;
    assert.deepEqual(await history(appointmentId), [{ operation: "INSERT", old_status: null, new_status: "Scheduled" }]);

    const total = async () => (await app.db.query(`SELECT count(*)::int AS n FROM appointment_history`)).rows[0].n;
    const before = await total();
    assert.equal((await book(olive, { doctorId: DOCTOR.fay, specialtyId: ids.familyMedicine, date: day(27), timeSlotId: SLOT.m0800 })).status, 409);
    assert.equal(await total(), before);

    assert.equal((await pat.patch(`/api/appointments/${appointmentId}/cancel`)).status, 200);
    assert.deepEqual(await history(appointmentId), [
      { operation: "INSERT", old_status: null, new_status: "Scheduled" },
      { operation: "UPDATE", old_status: "Scheduled", new_status: "Cancelled" },
    ]);
  });
});

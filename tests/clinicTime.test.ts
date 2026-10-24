import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient } from "./helpers/testApp.js";
import { ids, resetDatabase } from "./helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let pat: TestClient;
let nurse: TestClient;
let yesterday: string;
let today: string;
let tomorrow: string;

before(async () => {
  await resetDatabase();

  // pick a database time zone whose date is a day off from Chicago right now, so the old date bugs show at any hour
  const chicagoHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  const zone = chicagoHour >= 5 ? "Pacific/Kiritimati" : "Pacific/Pago_Pago";
  process.env.DATABASE_URL += `?options=-c%20TimeZone%3D${encodeURIComponent(zone)}`;
  app = await startTestApp();

  const { rows } = await app.db.query(`
    SELECT
      ((now() AT TIME ZONE 'America/Chicago')::date - 1)::text AS yesterday,
      ((now() AT TIME ZONE 'America/Chicago')::date)::text AS today,
      ((now() AT TIME ZONE 'America/Chicago')::date + 1)::text AS tomorrow
  `);
  ({ yesterday, today, tomorrow } = rows[0]);

  const slots = await app.db.query(
    `INSERT INTO time_slot (shift_type_id, start_time, end_time) VALUES (1, '08:00', '08:30'), (1, '09:00', '09:30'), (1, '10:00', '10:30') RETURNING time_slot_id`
  );
  const [eight, nine, ten] = slots.rows.map((r) => r.time_slot_id as number);
  const visits: [string, number, string][] = [
    [yesterday, eight, "Scheduled"],
    [today, eight, "Scheduled"],
    [today, nine, "Cancelled"],
    [tomorrow, eight, "Scheduled"],
    [tomorrow, nine, "No Show"],
    [tomorrow, ten, "Completed"],
  ];
  for (const [date, slot, status] of visits) {
    await app.db.query(
      `INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, status, booking_channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Web')`,
      [ids.patient, ids.doctor, ids.mainOffice, date, slot, ids.familyMedicine, status]
    );
  }

  pat = await app.loginPatient(ids.patient, "pat@test.org");
  nurse = await app.loginStaff(ids.nurse);
});

after(() => app.close());

describe("clinic dates when the database date is a day off", () => {
  test("the app's database session really is on a different date than the clinic", async () => {
    const session = (await app.db.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
    assert.notEqual(session, today);
  });

  test("the patient dashboard counts upcoming visits from the clinic date", async () => {
    // today and tomorrow are scheduled, yesterday has passed, and the rest are cancelled, no show, or completed
    const res = await pat.get(`/api/patient/${ids.patient}/dashboard`);
    assert.equal(res.status, 200);
    assert.equal(res.body.upcomingAppointments, 2);
  });

  test("certificate status follows the clinic date", async () => {
    const add = (expirationDate: string) =>
      nurse.post(`/api/staff/${ids.nurse}/certificates`, { name: "BLS", issueDate: "2024-01-01", expirationDate });

    const expired = await add(yesterday);
    assert.equal(expired.status, 201);
    assert.equal(expired.body.status, "Expired");

    const current = await add(today);
    assert.equal(current.status, 201);
    assert.equal(current.body.status, "Active");

    const edited = await nurse.put(`/api/staff/${ids.nurse}/certificates/${current.body.certificateId}`, {
      name: "BLS",
      issueDate: "2024-01-01",
      expirationDate: yesterday,
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.status, "Expired");
  });
});

describe("No Show appointments", () => {
  test("a No Show visit isn't counted as upcoming", async () => {
    await app.db.query(`UPDATE appointment SET status = 'Scheduled' WHERE appointment_date = $1 AND status = 'No Show'`, [tomorrow]);
    try {
      assert.equal((await pat.get(`/api/patient/${ids.patient}/dashboard`)).body.upcomingAppointments, 3);
    } finally {
      await app.db.query(
        `UPDATE appointment SET status = 'No Show' WHERE appointment_id = (
           SELECT appointment_id FROM appointment a JOIN time_slot t USING (time_slot_id)
           WHERE a.appointment_date = $1 AND t.start_time = '09:00'
         )`,
        [tomorrow]
      );
    }
    assert.equal((await pat.get(`/api/patient/${ids.patient}/dashboard`)).body.upcomingAppointments, 2);
  });
});

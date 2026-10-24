import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestApp } from "../helpers/testApp.js";
import type { TestClient } from "../helpers/testApp.js";
import { ids, resetDatabase } from "../helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let admin: TestClient;
let today: string;
let weekday: string;
let slot: number;

before(async () => {
  await resetDatabase();
  // the app's database date runs ahead of Chicago for most of the day, the way Supabase's UTC date does in the evening
  process.env.DATABASE_URL += "?options=-c%20TimeZone%3DPacific%2FKiritimati";
  app = await startTestApp();
  admin = await app.loginStaff(ids.admin);

  const { rows } = await app.db.query(
    `SELECT ((now() AT TIME ZONE 'America/Chicago')::date)::text AS today, to_char(now() AT TIME ZONE 'America/Chicago', 'FMDay') AS weekday`
  );
  ({ today, weekday } = rows[0]);
  slot = (await app.db.query(`INSERT INTO time_slot (shift_type_id, start_time, end_time) VALUES (1, '08:00', '08:30') RETURNING time_slot_id`)).rows[0]
    .time_slot_id;
  await app.db.query(
    `INSERT INTO doctor_schedule (doctor_id, day_of_week, office_id, specialty_id, shift_type_id) VALUES ($1, $2, 1, $3, 1) ON CONFLICT (doctor_id, day_of_week) DO NOTHING`,
    [ids.doctor, weekday, ids.cardiology]
  );
  await app.db.query(
    `INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, booking_channel) VALUES ($1, $2, 1, $3, $4, $5, 'Web')`,
    [ids.patient, ids.doctor, today, slot, ids.cardiology]
  );
});

after(() => app.close());

test("an appointment today in Chicago still blocks schedule and slot changes when the database date is tomorrow", async (t) => {
  const session = (await app.db.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
  if (session === today) t.diagnostic("the database and Chicago dates match at this hour, so this run can't show the old bug");

  assert.equal((await admin.patch(`/api/admin/schedules/${ids.doctor}/${weekday}/status`, { isActive: false })).status, 409);
  assert.equal((await admin.patch(`/api/admin/time-slots/${slot}/status`, { isActive: false })).status, 409);
  assert.equal((await admin.put(`/api/admin/time-slots/${slot}`, { startTime: "08:30", endTime: "09:00" })).status, 409);
});

test("once that appointment is cancelled, the same changes go through", async () => {
  await app.db.query(`UPDATE appointment SET status = 'Cancelled' WHERE appointment_date = $1`, [today]);
  assert.equal((await admin.patch(`/api/admin/time-slots/${slot}/status`, { isActive: false })).status, 200);
  assert.equal((await admin.patch(`/api/admin/schedules/${ids.doctor}/${weekday}/status`, { isActive: false })).status, 200);
});

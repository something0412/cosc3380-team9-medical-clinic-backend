import type { Pool, PoolClient } from "pg";
import { ids } from "./testDb.js";

// sample people and visits for the appointment lifecycle and list tests
let counter = 0;

// add to DATABASE_URL before the app starts, so the app's now() is the test clock below
export const TEST_CLOCK_OPTION = "-c search_path=test_clock,public,pg_catalog";

// freezes the app's clock at noon on today's Chicago date, so tests about what's over or still ahead pass at any hour
// the triggers set their own search_path, so they still see the real now()
export async function freezeClockAtNoon(db: Pool) {
  const { rows } = await db.query(`SELECT to_char((pg_catalog.now() AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD') AS today`);
  const today = rows[0].today as string;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("Unexpected date from the database");
  await db.query(`
    CREATE SCHEMA IF NOT EXISTS test_clock;
    CREATE OR REPLACE FUNCTION test_clock.now() RETURNS timestamptz LANGUAGE sql STABLE AS
      $$ SELECT (DATE '${today}' + TIME '12:00') AT TIME ZONE 'America/Chicago' $$;
  `);
  return today;
}

export async function unfreezeClock(db: Pool) {
  await db.query(`DROP SCHEMA IF EXISTS test_clock CASCADE`);
}

// a clinic date n days from the given one
export function dayFrom(date: string, n: number) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + n);
  return next.toISOString().slice(0, 10);
}

// an employee who signs in with the shared test password
export async function addEmployee(db: Pool, firstName: string, typeId: number, officeId: number) {
  counter += 1;
  const { rows } = await db.query(
    `
    INSERT INTO employee (first_name, last_name, dob, employee_type_id, phone, email, office_id)
    VALUES ($1, 'Tester', '1990-01-01', $2, '7135557000', $3, $4)
    RETURNING employee_id
    `,
    [firstName, typeId, `${firstName.toLowerCase()}${counter}@test.org`, officeId]
  );
  const employeeId = rows[0].employee_id as number;
  await addLogin(db, employeeId);
  return employeeId;
}

// copies the admin's test password hash, so loginStaff works for this employee
export async function addLogin(db: Pool, employeeId: number) {
  await db.query(
    `INSERT INTO employee_creds (employee_id, username, password_hash) SELECT $1, $2, password_hash FROM employee_creds WHERE employee_id = $3`,
    [employeeId, `staff${employeeId}`, ids.admin]
  );
}

export async function addDoctor(db: Pool, firstName: string, officeId: number) {
  const employeeId = await addEmployee(db, firstName, 2, officeId);
  await db.query(`INSERT INTO doctor VALUES ($1, $2, 'TX', '2030-01-01', $3, NULL)`, [employeeId, `TX-DOC${employeeId}`, `90000${employeeId}`]);
  // appointments point at a doctor and specialty pair
  await db.query(`INSERT INTO doctor_specialty (doctor_id, specialty_id, is_primary) VALUES ($1, $2, true)`, [employeeId, ids.familyMedicine]);
  return employeeId;
}

export async function addNurse(db: Pool, firstName: string, officeId: number) {
  const employeeId = await addEmployee(db, firstName, 3, officeId);
  await db.query(`INSERT INTO nurse VALUES ($1, $2, 'TX', '2030-01-01', 'RN')`, [employeeId, `RN-NUR${employeeId}`]);
  return employeeId;
}

export async function addPatient(db: Pool, firstName: string, lastName = "Visitor") {
  const { rows } = await db.query(
    `INSERT INTO patient (first_name, last_name, dob, phone, email) VALUES ($1, $2, '1980-05-05', '7135558800', 'visit@test.org') RETURNING patient_id`,
    [firstName, lastName]
  );
  return rows[0].patient_id as number;
}

// time slots in one all day shift, so any clock time can be booked in tests
export async function addSlots(db: Pool) {
  const shift = await db.query(`INSERT INTO shift_type (name, start_time, end_time) VALUES ('All Day', '00:00', '23:59:59') RETURNING shift_type_id`);
  const slot = async (start: string, end: string) =>
    (await db.query(`INSERT INTO time_slot (shift_type_id, start_time, end_time) VALUES ($1, $2, $3) RETURNING time_slot_id`, [shift.rows[0].shift_type_id, start, end]))
      .rows[0].time_slot_id as number;
  return {
    // with the clock frozen at noon this one is over, late is still ahead and allDay is running
    early: await slot("00:00", "00:01"),
    morning: await slot("08:00", "08:30"),
    noon: await slot("12:00", "12:30"),
    late: await slot("23:59", "23:59:59"),
    allDay: await slot("00:00", "23:59:59"),
  };
}

export async function addAppointment(
  db: Pool,
  a: { patientId: number; doctorId: number; officeId: number; date: string; timeSlotId: number; status?: string }
) {
  const { rows } = await db.query(
    `
    INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, status, booking_channel)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'Web')
    RETURNING appointment_id
    `,
    [a.patientId, a.doctorId, a.officeId, a.date, a.timeSlotId, ids.familyMedicine, a.status ?? "Scheduled"]
  );
  return rows[0].appointment_id as number;
}

// waits until some request is stuck behind a lock the test is holding
export async function waitForLockWait(db: Pool) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    if (rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("No request started waiting for the lock");
}

// runs the work in one transaction as this employee, since the billing and referral triggers check who made each change
export async function asEmployee<T>(db: Pool, employeeId: number, work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.employee_id', $1, true)`, [String(employeeId)]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// a referral made the way the referral trigger allows, sent by the referring doctor and decided by the patient's primary doctor
// the primary doctor defaults to the referring doctor and is assigned if the patient has none yet
export async function addReferral(
  db: Pool,
  r: {
    patientId: number;
    referringDoctorId: number;
    specialistDoctorId: number;
    specialtyId: number;
    issued: string;
    expires: string;
    status?: "Pending" | "Approved" | "Denied";
    primaryDoctorId?: number;
    reason?: string;
  }
) {
  const primaryDoctorId = r.primaryDoctorId ?? r.referringDoctorId;
  const status = r.status ?? "Pending";
  const current = await db.query(`SELECT doctor_id FROM patient_doctor WHERE patient_id = $1 AND is_primary AND is_active`, [r.patientId]);
  if (!current.rowCount) {
    await db.query(
      `INSERT INTO patient_doctor (patient_id, doctor_id, is_primary, is_active) VALUES ($1, $2, true, true)
       ON CONFLICT (patient_id, doctor_id) DO UPDATE SET is_primary = true, is_active = true`,
      [r.patientId, primaryDoctorId]
    );
  } else if (current.rows[0].doctor_id !== primaryDoctorId) {
    throw new Error(`Patient ${r.patientId} already has primary doctor ${current.rows[0].doctor_id}`);
  }

  // the primary doctor's own referral is approved as it's sent, anything else starts Pending
  const approvedNow = status === "Approved" && primaryDoctorId === r.referringDoctorId;
  const referralId = await asEmployee(db, r.referringDoctorId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO referral (patient_id, referring_doctor_id, primary_doctor_id, specialist_doctor_id, specialty_id, date_issued, expiration_date, status, request_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING referral_id`,
      [r.patientId, r.referringDoctorId, primaryDoctorId, r.specialistDoctorId, r.specialtyId, r.issued, r.expires, approvedNow ? "Approved" : "Pending", r.reason ?? "Needs a specialist"]
    );
    return rows[0].referral_id as number;
  });

  // the trigger only lets the primary doctor decide, and only before it expires
  if (status !== "Pending" && !approvedNow) {
    await asEmployee(db, primaryDoctorId, (client) =>
      client.query(`UPDATE referral SET status = $1, denial_reason = $2 WHERE referral_id = $3`, [status, status === "Denied" ? "Not needed yet" : null, referralId])
    );
  }
  return referralId;
}

export async function historyCount(db: Pool, appointmentId: number) {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM appointment_history WHERE appointment_id = $1`, [appointmentId]);
  return rows[0].n as number;
}

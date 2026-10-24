import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient } from "./helpers/testApp.js";
import { ids, resetDatabase } from "./helpers/testDb.js";

// patient 2, a second doctor 5, and three slots. Morning 1 and 2, and Full Day 3 at the same time as 1
const SETUP = `
  INSERT INTO patient (first_name, last_name, dob, phone, email) VALUES ('Olive', 'Other', '1995-02-02', '713-555-9100', 'olive@test.org');
  INSERT INTO shift_type (name, start_time, end_time) VALUES ('Full Day', '08:00', '17:00');
  INSERT INTO time_slot (shift_type_id, start_time, end_time) VALUES (1, '08:00', '08:30'), (1, '08:30', '09:00'), (2, '08:00', '08:30');
  INSERT INTO employee (first_name, last_name, dob, employee_type_id, phone, email, office_id) VALUES
    ('Fay', 'Family', '1980-01-01', 2, '713-555-2005', 'fay@test.org', 1);
  INSERT INTO doctor (employee_id, license_number, license_issuing_state, license_expiration_date, npi_number) VALUES (5, 'TX-FAY5', 'TX', '2030-01-01', '2000000005');
  INSERT INTO doctor_specialty (doctor_id, specialty_id, is_primary) VALUES (5, 1, true);
`;
const OLIVE = 2;
const FAY = 5;

let app: Awaited<ReturnType<typeof startTestApp>>;
let admin: TestClient;
let nextDay = 30;

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  await app.db.query(SETUP);
  admin = await app.loginStaff(ids.admin);
});

after(() => app.close());

// a new future date per test so appointments don't collide
async function freshDate() {
  const { rows } = await app.db.query(`SELECT to_char(CURRENT_DATE + $1::int, 'YYYY-MM-DD') AS d`, [nextDay++]);
  return rows[0].d as string;
}

async function insertAppointment(a: { patientId?: number; doctorId?: number; date: string; timeSlotId: number; status?: string }) {
  const { rows } = await app.db.query(
    `
    INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, status, booking_channel)
    VALUES ($1, $2, 1, $3, $4, 1, $5, 'Web')
    RETURNING appointment_id
    `,
    [a.patientId ?? ids.patient, a.doctorId ?? ids.doctor, a.date, a.timeSlotId, a.status ?? "Scheduled"]
  );
  return rows[0].appointment_id as number;
}

async function history(appointmentId: number) {
  const { rows } = await app.db.query(
    `
    SELECT operation, old_status, new_status,
      to_char(old_appointment_date, 'YYYY-MM-DD') AS old_date, to_char(new_appointment_date, 'YYYY-MM-DD') AS new_date,
      old_time_slot_id, new_time_slot_id, old_doctor_id, new_doctor_id
    FROM appointment_history
    WHERE appointment_id = $1
    ORDER BY history_id
    `,
    [appointmentId]
  );
  return rows;
}

async function audit(employeeId: number) {
  const { rows } = await app.db.query(
    `SELECT field_name, old_value, new_value FROM employee_audit WHERE employee_id = $1 ORDER BY audit_id`,
    [employeeId]
  );
  return rows;
}

// the error code a statement fails with, or null if it works
async function errorCode(work: Promise<unknown>) {
  try {
    await work;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

describe("appointment history trigger", () => {
  test("a new appointment records an INSERT row", async () => {
    const date = await freshDate();
    const id = await insertAppointment({ date, timeSlotId: 1 });
    assert.deepEqual(await history(id), [
      {
        operation: "INSERT",
        old_status: null,
        new_status: "Scheduled",
        old_date: null,
        new_date: date,
        old_time_slot_id: null,
        new_time_slot_id: 1,
        old_doctor_id: null,
        new_doctor_id: ids.doctor,
      },
    ]);
  });

  test("a status change records the old and new status", async () => {
    const id = await insertAppointment({ date: await freshDate(), timeSlotId: 1 });
    await app.db.query(`UPDATE appointment SET status = 'Completed' WHERE appointment_id = $1`, [id]);
    const rows = await history(id);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].operation, "UPDATE");
    assert.equal(rows[1].old_status, "Scheduled");
    assert.equal(rows[1].new_status, "Completed");
  });

  test("moving an appointment records the old and new date, slot, and doctor", async () => {
    const from = await freshDate();
    const to = await freshDate();
    const id = await insertAppointment({ date: from, timeSlotId: 1 });
    await app.db.query(`UPDATE appointment SET appointment_date = $2, time_slot_id = 2, doctor_id = $3 WHERE appointment_id = $1`, [id, to, FAY]);
    const moved = (await history(id))[1];
    assert.deepEqual(
      [moved.old_date, moved.new_date, moved.old_time_slot_id, moved.new_time_slot_id, moved.old_doctor_id, moved.new_doctor_id],
      [from, to, 1, 2, ids.doctor, FAY]
    );
  });

  test("updates that leave the tracked columns alone add nothing", async () => {
    const id = await insertAppointment({ date: await freshDate(), timeSlotId: 1 });
    await app.db.query(`UPDATE appointment SET status = status WHERE appointment_id = $1`, [id]);
    await app.db.query(`UPDATE appointment SET checked_in_at = now() WHERE appointment_id = $1`, [id]);
    await app.db.query(`UPDATE appointment SET booking_channel = 'Web' WHERE appointment_id = $1`, [id]);
    assert.equal((await history(id)).length, 1);
  });

  test("a rolled back insert or update leaves no history", async () => {
    const date = await freshDate();
    const kept = await insertAppointment({ date, timeSlotId: 1 });
    const client = await app.db.connect();
    let rolledBack = 0;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, booking_channel)
         VALUES ($1, $2, 1, $3, 2, 1, 'Web') RETURNING appointment_id`,
        [ids.patient, ids.doctor, date]
      );
      rolledBack = rows[0].appointment_id;
      await client.query(`UPDATE appointment SET status = 'Cancelled' WHERE appointment_id = $1`, [kept]);
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM appointment_history WHERE appointment_id = $1`, [rolledBack])).rows[0].n, 1);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.deepEqual(await history(rolledBack), []);
    assert.equal((await history(kept)).length, 1);
  });
});

describe("employee audit trigger", () => {
  test("deactivating and reactivating an employee is recorded", async () => {
    assert.equal((await admin.patch(`/api/admin/employees/${ids.nurse}/status`, { isActive: false })).status, 200);
    assert.equal((await admin.patch(`/api/admin/employees/${ids.nurse}/status`, { isActive: true })).status, 200);
    assert.deepEqual(await audit(ids.nurse), [
      { field_name: "is_active", old_value: "true", new_value: "false" },
      { field_name: "is_active", old_value: "false", new_value: "true" },
    ]);
  });

  test("office and employee type changes get one row each", async () => {
    await app.db.query(`UPDATE employee SET office_id = 1, employee_type_id = 1 WHERE employee_id = $1`, [ids.receptionist]);
    assert.deepEqual(await audit(ids.receptionist), [
      { field_name: "employee_type_id", old_value: "4", new_value: "1" },
      { field_name: "office_id", old_value: "2", new_value: "1" },
    ]);
    await app.db.query(`UPDATE employee SET office_id = 2, employee_type_id = 4 WHERE employee_id = $1`, [ids.receptionist]);
  });

  test("edits that leave the tracked fields alone add nothing", async () => {
    const before = (await app.db.query(`SELECT count(*)::int AS n FROM employee_audit`)).rows[0].n;
    const res = await admin.put(`/api/admin/employees/${ids.receptionist}`, {
      firstName: "Rita",
      lastName: "Reception",
      dob: "1990-07-07",
      email: "rita@test.org",
      phone: "713-555-7777",
      employeeTypeId: 4,
      officeId: 2,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await app.db.query(`UPDATE employee SET is_active = is_active, office_id = office_id WHERE employee_id = $1`, [ids.doctor]);
    assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM employee_audit`)).rows[0].n, before);
  });

  test("a rolled back change leaves no audit row", async () => {
    const client = await app.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE employee SET is_active = false WHERE employee_id = $1`, [ids.doctor]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.deepEqual(await audit(ids.doctor), []);
  });

  test("the audit tables hold no personal details", async () => {
    const { rows } = await app.db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('appointment_history', 'employee_audit')`
    );
    const personal = ["first_name", "last_name", "dob", "phone", "email", "address", "password_hash", "username", "patient_id"];
    assert.deepEqual(rows.filter((r) => personal.includes(r.column_name)), []);
    const fields = await app.db.query(`SELECT DISTINCT field_name FROM employee_audit ORDER BY field_name`);
    for (const { field_name } of fields.rows) assert.ok(["employee_type_id", "is_active", "office_id"].includes(field_name));
  });

  test("the trigger functions pin an empty search_path and run with the caller's rights", async () => {
    const { rows } = await app.db.query(
      `SELECT proname, proconfig, prosecdef FROM pg_proc WHERE proname IN ('record_appointment_history', 'record_employee_changes', 'check_appointment_conflict') ORDER BY proname`
    );
    assert.deepEqual(
      rows.map((r) => [r.proname, r.proconfig, r.prosecdef]),
      [
        ["check_appointment_conflict", ['search_path=""'], false],
        ["record_appointment_history", ['search_path=""'], false],
        ["record_employee_changes", ['search_path=""'], false],
      ]
    );
  });

  test("the audit tables have row level security like every other table", async () => {
    const { rows } = await app.db.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`
    );
    assert.deepEqual(rows, []);
  });

  test("a role without bypass rights can't see or add audit rows, even with full grants", async () => {
    const client = await app.db.connect();
    try {
      // the role only lives inside this transaction, so nothing is left behind
      await client.query("BEGIN");
      await client.query(`CREATE ROLE audit_probe NOLOGIN NOBYPASSRLS`);
      await client.query(`GRANT USAGE ON SCHEMA public TO audit_probe`);
      await client.query(`GRANT ALL ON public.appointment_history, public.employee_audit TO audit_probe`);
      // give both audit tables at least one row the probe could otherwise read
      await client.query(`UPDATE employee SET office_id = 1 WHERE employee_id = $1`, [ids.receptionist]);
      await client.query(
        `INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, booking_channel) VALUES ($1, $2, 1, CURRENT_DATE + 500, 2, 1, 'Web')`,
        [OLIVE, FAY]
      );
      const counts = `SELECT (SELECT count(*) FROM public.appointment_history)::int AS history, (SELECT count(*) FROM public.employee_audit)::int AS audit`;
      const owner = (await client.query(counts)).rows[0];
      assert.ok(owner.history > 0 && owner.audit > 0, "the owner sees audit rows");

      await client.query(`SET LOCAL ROLE audit_probe`);
      assert.deepEqual((await client.query(counts)).rows[0], { history: 0, audit: 0 });
      await assert.rejects(client.query(`INSERT INTO public.employee_audit (employee_id, field_name) VALUES (1, 'is_active')`), /row-level security/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("appointment conflict trigger", () => {
  test("rejects a doctor double booking written straight to the table, even through another shift's slot", async () => {
    const date = await freshDate();
    await insertAppointment({ date, timeSlotId: 1 });
    assert.equal(await errorCode(insertAppointment({ patientId: OLIVE, date, timeSlotId: 1 })), "23P01");
    assert.equal(await errorCode(insertAppointment({ patientId: OLIVE, date, timeSlotId: 3 })), "23P01");
  });

  test("rejects overlapping appointments for one patient across doctors", async () => {
    const date = await freshDate();
    await insertAppointment({ date, timeSlotId: 1 });
    assert.equal(await errorCode(insertAppointment({ doctorId: FAY, date, timeSlotId: 3 })), "23P01");
  });

  test("cancelled appointments and back to back times don't conflict", async () => {
    const date = await freshDate();
    await insertAppointment({ date, timeSlotId: 1, status: "Cancelled" });
    await insertAppointment({ patientId: OLIVE, date, timeSlotId: 3 });
    await insertAppointment({ patientId: OLIVE, date, timeSlotId: 2 });
  });

  test("bringing back a cancelled appointment or moving one into a taken time is checked", async () => {
    const date = await freshDate();
    const cancelled = await insertAppointment({ date, timeSlotId: 1, status: "Cancelled" });
    await insertAppointment({ patientId: OLIVE, date, timeSlotId: 3 });
    assert.equal(await errorCode(app.db.query(`UPDATE appointment SET status = 'Scheduled' WHERE appointment_id = $1`, [cancelled])), "23P01");

    const movable = await insertAppointment({ date, timeSlotId: 2 });
    assert.equal(await errorCode(app.db.query(`UPDATE appointment SET time_slot_id = 1, patient_id = $2 WHERE appointment_id = $1`, [movable, OLIVE])), "23P01");
  });

  test("status changes that don't move an appointment skip the check", async () => {
    const date = await freshDate();
    const id = await insertAppointment({ date, timeSlotId: 1 });
    await app.db.query(`UPDATE appointment SET checked_in_at = now() WHERE appointment_id = $1`, [id]);
    await app.db.query(`UPDATE appointment SET status = 'Completed', checked_out_at = now() WHERE appointment_id = $1`, [id]);
  });

  test("a second transaction writing the same time waits for the first and is rejected", async () => {
    const date = await freshDate();
    const first = await app.db.connect();
    const second = await app.db.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const insert = (client: typeof first, patientId: number, slot: number) =>
        client.query(
          `INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, booking_channel)
           VALUES ($1, $2, 1, $3, $4, 1, 'Web')`,
          [patientId, ids.doctor, date, slot]
        );
      await insert(first, ids.patient, 1);
      const waiting = errorCode(insert(second, OLIVE, 3));

      // the second insert is stuck on the doctor's lock until the first commits
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const { rows } = await app.db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'advisory'`);
        blocked = rows[0].n > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(blocked, "second insert waits");

      await first.query("COMMIT");
      assert.equal(await waiting, "23P01");
      await second.query("ROLLBACK");
    } finally {
      first.release();
      second.release();
    }
  });

  test("appointments can't be written from a repeatable read transaction", async () => {
    const client = await app.db.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const code = await errorCode(
        client.query(
          `INSERT INTO appointment (patient_id, doctor_id, office_id, appointment_date, time_slot_id, specialty_id, booking_channel)
           VALUES ($1, $2, 1, $3, 1, 1, 'Web')`,
          [ids.patient, ids.doctor, await freshDate()]
        )
      );
      assert.equal(code, "P0001");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

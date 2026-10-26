import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  TEST_CLOCK_OPTION,
  addAppointment,
  addDoctor,
  addEmployee,
  addLogin,
  addPatient,
  addSlots,
  dayFrom,
  freezeClockAtNoon,
  historyCount,
  unfreezeClock,
  waitForLockWait,
} from "./helpers/appointmentData.js";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient, TestResponse } from "./helpers/testApp.js";
import { ids, resetDatabase } from "./helpers/testDb.js";

let app: Awaited<ReturnType<typeof startTestApp>>;
let today: string;
let slots: Awaited<ReturnType<typeof addSlots>>;
let rita: TestClient, remy: TestClient, mia: TestClient;
let others: [string, TestClient, number][];

const path = (appointmentId: number | string, action: string) => `/api/receptionist/appointments/${appointmentId}/${action}`;
const statuses = (responses: TestResponse[]) => responses.map((r) => r.status).sort();

// a new patient and doctor every time, so visits never overlap each other
async function visit(date: string, timeSlotId: number, officeId: number = ids.westsideOffice, status = "Scheduled") {
  const doctorId = await addDoctor(app.db, "Doc", officeId);
  const patientId = await addPatient(app.db, "Vera");
  return addAppointment(app.db, { patientId, doctorId, officeId, date, timeSlotId, status });
}

async function row(appointmentId: number) {
  const { rows } = await app.db.query(
    `SELECT status, checked_in_at AS "checkedInAt", checked_out_at AS "checkedOutAt" FROM appointment WHERE appointment_id = $1`,
    [appointmentId]
  );
  return rows[0] as { status: string; checkedInAt: Date | null; checkedOutAt: Date | null };
}

before(async () => {
  await resetDatabase();
  // at noon in Chicago it's already the next day in Kiritimati, so a check that used the database date would fail here
  process.env.DATABASE_URL += `?options=${encodeURIComponent(`-c TimeZone=Pacific/Kiritimati ${TEST_CLOCK_OPTION}`)}`;
  app = await startTestApp();
  today = await freezeClockAtNoon(app.db);
  slots = await addSlots(app.db);

  // the fixtures leave the Westside receptionist without a login
  await addLogin(app.db, ids.receptionist);
  const remyId = await addEmployee(app.db, "Remy", 4, ids.westsideOffice);
  const miaId = await addEmployee(app.db, "Mia", 4, ids.mainOffice);
  const labType = await app.db.query(`INSERT INTO employee_types (type_name) VALUES ('Lab Technician') RETURNING employee_type_id AS id`);
  const labId = await addEmployee(app.db, "Lee", labType.rows[0].id, ids.westsideOffice);

  rita = await app.loginStaff(ids.receptionist);
  remy = await app.loginStaff(remyId);
  mia = await app.loginStaff(miaId);
  others = [
    ["visitor", app.client(), 401],
    ["patient", await app.loginPatient(ids.patient, "pat@test.org"), 403],
    ["nurse", await app.loginStaff(ids.nurse), 403],
    ["doctor", await app.loginStaff(ids.doctor), 403],
    ["admin", await app.loginStaff(ids.admin), 403],
    ["lab", await app.loginStaff(labId), 403],
  ];
});

after(async () => {
  await unfreezeClock(app.db);
  await app.close();
});

describe("check in", () => {
  test("the database date really is different from the clinic date", async () => {
    const { rows } = await app.db.query(`SELECT to_char(now(), 'YYYY-MM-DD') AS db, to_char(now() AT TIME ZONE 'America/Chicago', 'HH24:MI') AS clinic`);
    assert.notEqual(rows[0].db, today);
    assert.equal(rows[0].clinic, "12:00");
  });

  test("a receptionist checks in today's visit at their office and it stays Scheduled", async () => {
    const id = await visit(today, slots.late);
    const res = await rita.patch(path(id, "check-in"));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.appointmentId, res.body.status, res.body.checkedIn, res.body.checkedOutAt], [id, "Scheduled", true, null]);
    assert.equal(res.body.checkedInAt, `${today} 12:00`);
    assert.equal((await row(id)).status, "Scheduled");
    // check in alone doesn't change anything the history tracks
    assert.equal(await historyCount(app.db, id), 1);
  });

  test("checking in again keeps the first time", async () => {
    const id = await visit(today, slots.morning);
    assert.equal((await rita.patch(path(id, "check-in"))).status, 200);
    const first = (await row(id)).checkedInAt;
    const again = await remy.patch(path(id, "check-in"));
    assert.deepEqual([again.status, again.body.error], [409, "The patient is already checked in"]);
    assert.deepEqual((await row(id)).checkedInAt, first);
  });

  test("only on the clinic date of the visit, early arrivals included", async () => {
    for (const date of [dayFrom(today, -1), dayFrom(today, 1)]) {
      const id = await visit(date, slots.morning);
      const res = await rita.patch(path(id, "check-in"));
      assert.deepEqual([res.status, res.body.error], [409, "Patients can only be checked in on the day of their appointment"], date);
      assert.equal((await row(id)).checkedInAt, null);
    }
    // checking in hours before the appointment starts is fine
    assert.equal((await rita.patch(path(await visit(today, slots.late), "check-in"))).status, 200);
  });

  test("cancelled, completed and No Show visits can't be checked in", async () => {
    for (const status of ["Cancelled", "Completed", "No Show"]) {
      const id = await visit(today, slots.noon, ids.westsideOffice, status);
      const res = await rita.patch(path(id, "check-in"));
      assert.deepEqual([res.status, res.body.error], [409, `Only scheduled appointments can be checked in. This one is ${status}.`]);
    }
  });

  test("receptionists only check in visits at their own office", async () => {
    const id = await visit(today, slots.late, ids.mainOffice);
    assert.deepEqual((await rita.patch(path(id, "check-in"))).body, { error: "That appointment is at another office" });
    assert.equal((await row(id)).checkedInAt, null);
    assert.equal((await mia.patch(path(id, "check-in"))).status, 200);
  });

  test("other roles and visitors can't check anyone in, and bad IDs are caught", async () => {
    const id = await visit(today, slots.late);
    for (const [name, client, status] of others) {
      for (const action of ["check-in", "check-out", "no-show"]) {
        assert.equal((await client.patch(path(id, action))).status, status, `${name} ${action}`);
      }
    }
    assert.deepEqual(await row(id), { status: "Scheduled", checkedInAt: null, checkedOutAt: null });
    assert.equal((await rita.patch(path(999999, "check-in"))).status, 404);
    assert.equal((await rita.patch(path("abc", "check-in"))).status, 400);
  });
});

describe("check out", () => {
  test("checking out completes the visit and keeps the check in time", async () => {
    const id = await visit(today, slots.morning);
    const checkedIn = (await rita.patch(path(id, "check-in"))).body.checkedInAt;
    const before = (await row(id)).checkedInAt;

    const res = await rita.patch(path(id, "check-out"));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.status, res.body.checkedIn, res.body.checkedInAt], ["Completed", true, checkedIn]);
    assert.equal(res.body.checkedOutAt, `${today} 12:00`);
    const after = await row(id);
    assert.deepEqual(after.checkedInAt, before);
    assert.ok(after.checkedOutAt! >= after.checkedInAt!);

    const history = await app.db.query(`SELECT old_status, new_status FROM appointment_history WHERE appointment_id = $1 AND operation = 'UPDATE'`, [id]);
    assert.deepEqual(history.rows, [{ old_status: "Scheduled", new_status: "Completed" }]);
  });

  test("a visit has to be checked in first, and checks out only once", async () => {
    const id = await visit(today, slots.noon);
    assert.deepEqual((await rita.patch(path(id, "check-out"))).body, { error: "The patient hasn't been checked in" });

    await rita.patch(path(id, "check-in"));
    assert.equal((await rita.patch(path(id, "check-out"))).status, 200);
    const done = await row(id);
    const again = await remy.patch(path(id, "check-out"));
    assert.deepEqual([again.status, again.body.error], [409, "Only scheduled appointments can be checked out. This one is Completed."]);
    assert.deepEqual(await row(id), done);
    assert.equal(await historyCount(app.db, id), 2);
  });

  test("a visit checked in the day before can still be checked out", async () => {
    const id = await visit(dayFrom(today, -1), slots.morning);
    await app.db.query(`UPDATE appointment SET checked_in_at = now() - interval '1 day' WHERE appointment_id = $1`, [id]);
    assert.equal((await rita.patch(path(id, "check-out"))).body.status, "Completed");
  });

  test("cancelled or No Show visits can't be completed by checking out, and only at your office", async () => {
    for (const status of ["Cancelled", "No Show"]) {
      const id = await visit(today, slots.noon, ids.westsideOffice, status);
      assert.equal((await rita.patch(path(id, "check-out"))).status, 409);
      assert.equal((await row(id)).status, status);
    }
    const main = await visit(today, slots.morning, ids.mainOffice);
    await mia.patch(path(main, "check-in"));
    assert.equal((await rita.patch(path(main, "check-out"))).status, 403);
    assert.equal((await row(main)).status, "Scheduled");
  });
});

describe("No Show", () => {
  test("a visit whose time is over can be marked No Show once", async () => {
    for (const [date, slot] of [[dayFrom(today, -1), slots.morning], [today, slots.early]] as const) {
      const id = await visit(date, slot);
      const res = await rita.patch(path(id, "no-show"));
      assert.deepEqual([res.status, res.body.status, res.body.checkedIn], [200, "No Show", false], date);

      const again = await rita.patch(path(id, "no-show"));
      assert.deepEqual([again.status, again.body.error], [409, "Only scheduled appointments can be marked No Show. This one is No Show."]);
      assert.equal(await historyCount(app.db, id), 2);
    }
  });

  test("not while the visit is still ahead or still running", async () => {
    for (const [date, slot] of [[dayFrom(today, 1), slots.morning], [today, slots.late], [today, slots.allDay]] as const) {
      const id = await visit(date, slot);
      const res = await rita.patch(path(id, "no-show"));
      assert.deepEqual([res.status, res.body.error], [409, "An appointment can only be marked No Show after its time is over"]);
      assert.equal((await row(id)).status, "Scheduled");
    }
  });

  test("not after the patient checked in, and not at another office", async () => {
    const id = await visit(today, slots.early);
    await rita.patch(path(id, "check-in"));
    assert.deepEqual((await rita.patch(path(id, "no-show"))).body, { error: "A patient who checked in can't be marked No Show" });

    const main = await visit(dayFrom(today, -1), slots.morning, ids.mainOffice);
    assert.equal((await rita.patch(path(main, "no-show"))).status, 403);
    assert.equal((await row(main)).status, "Scheduled");
  });

  test("cancelling and the lifecycle respect each other", async () => {
    const cancelled = await visit(dayFrom(today, -1), slots.noon, ids.westsideOffice, "Cancelled");
    assert.equal((await rita.patch(path(cancelled, "no-show"))).status, 409);

    // a patient who checked in can't be cancelled, and a No Show can't be either
    const checkedIn = await visit(today, slots.late);
    await rita.patch(path(checkedIn, "check-in"));
    assert.match((await rita.patch(`/api/appointments/${checkedIn}/cancel`)).body.error, /checked in/);
    const noShow = await visit(today, slots.early);
    await rita.patch(path(noShow, "no-show"));
    assert.equal((await rita.patch(`/api/appointments/${noShow}/cancel`)).status, 409);
    assert.equal((await row(noShow)).status, "No Show");
  });
});

describe("simultaneous changes", () => {
  test("two check ins at once keep one time", async () => {
    const id = await visit(today, slots.late);
    assert.deepEqual(statuses(await Promise.all([rita.patch(path(id, "check-in")), remy.patch(path(id, "check-in"))])), [200, 409]);
    assert.equal(await historyCount(app.db, id), 1);
  });

  test("two check outs at once complete the visit once", async () => {
    const id = await visit(today, slots.morning);
    await rita.patch(path(id, "check-in"));
    assert.deepEqual(statuses(await Promise.all([rita.patch(path(id, "check-out")), remy.patch(path(id, "check-out"))])), [200, 409]);
    assert.equal(await historyCount(app.db, id), 2);
  });

  test("a check in and a cancel at once leave one of them", async () => {
    const id = await visit(today, slots.late);
    const results = await Promise.all([rita.patch(path(id, "check-in")), remy.patch(`/api/appointments/${id}/cancel`)]);
    assert.deepEqual(statuses(results), [200, 409]);
    const after = await row(id);
    assert.ok((after.status === "Scheduled" && after.checkedInAt) || (after.status === "Cancelled" && !after.checkedInAt), JSON.stringify(after));
    assert.equal(await historyCount(app.db, id), after.status === "Cancelled" ? 2 : 1);
  });

  test("a check in and a No Show at once leave one of them", async () => {
    const id = await visit(today, slots.early);
    const results = await Promise.all([rita.patch(path(id, "check-in")), remy.patch(path(id, "no-show"))]);
    assert.deepEqual(statuses(results), [200, 409]);
    const after = await row(id);
    assert.ok((after.status === "Scheduled" && after.checkedInAt) || (after.status === "No Show" && !after.checkedInAt), JSON.stringify(after));
  });

  test("a request waiting on a change in progress sees the new state", async () => {
    // each case holds one change open in its own transaction, sends the second one, then commits the first
    const cases: [string, number, string, string, RegExp][] = [
      ["cancel then check in", await visit(today, slots.late), `UPDATE appointment SET status = 'Cancelled'`, "check-in", /This one is Cancelled/],
      ["cancel then No Show", await visit(dayFrom(today, -1), slots.morning), `UPDATE appointment SET status = 'Cancelled'`, "no-show", /This one is Cancelled/],
      ["check in then check in", await visit(today, slots.noon), `UPDATE appointment SET checked_in_at = now() - interval '5 minutes'`, "check-in", /already checked in/],
      ["check in then No Show", await visit(today, slots.early), `UPDATE appointment SET checked_in_at = now()`, "no-show", /checked in can't/],
    ];
    for (const [label, id, change, action, message] of cases) {
      const held = await app.db.connect();
      let res: TestResponse;
      try {
        await held.query("BEGIN");
        await held.query(`${change} WHERE appointment_id = $1`, [id]);
        const waiting = rita.patch(path(id, action));
        await waitForLockWait(app.db);
        await held.query("COMMIT");
        res = await waiting;
      } finally {
        held.release();
      }
      assert.equal(res.status, 409, label);
      assert.match(res.body.error, message, label);
    }

    // the held check in time wins over the request that waited
    const [, kept] = cases[2];
    const { rows } = await app.db.query(`SELECT checked_in_at < now() - interval '4 minutes' AS kept FROM appointment WHERE appointment_id = $1`, [kept]);
    assert.equal(rows[0].kept, true);
  });

  test("a check out waiting on another status change doesn't overwrite it", async () => {
    const id = await visit(today, slots.morning);
    await rita.patch(path(id, "check-in"));
    const held = await app.db.connect();
    let res: TestResponse;
    try {
      await held.query("BEGIN");
      await held.query(`UPDATE appointment SET status = 'Cancelled' WHERE appointment_id = $1`, [id]);
      const waiting = rita.patch(path(id, "check-out"));
      await waitForLockWait(app.db);
      await held.query("COMMIT");
      res = await waiting;
    } finally {
      held.release();
    }
    assert.deepEqual([res.status, res.body.error], [409, "Only scheduled appointments can be checked out. This one is Cancelled."]);
    assert.deepEqual([(await row(id)).status, (await row(id)).checkedOutAt], ["Cancelled", null]);
    assert.equal(await historyCount(app.db, id), 2);
  });
});

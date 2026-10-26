import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Request, Response } from "express";
import { z } from "zod";
import { HttpError, errorHandler } from "../src/middleware/errorHandler.js";
import { startTestApp } from "./helpers/testApp.js";
import type { TestClient } from "./helpers/testApp.js";
import { ids, resetDatabase } from "./helpers/testDb.js";

const SERVER_ERROR = { error: "Something went wrong. Please try again later." };

let app: Awaited<ReturnType<typeof startTestApp>>;
let admin: TestClient;
let pat: TestClient;

// a database error shaped the way pg throws them
function databaseError(code: string, message: string, extra: Record<string, string> = {}) {
  return Object.assign(new Error(message), { code, severity: "ERROR", ...extra });
}

// runs the shared error handler on its own and returns what the client would get
function handle(err: unknown) {
  const sent = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  } as unknown as Response;
  errorHandler(err, { method: "GET", path: "/api/test" } as Request, res, () => {});
  return sent;
}

// keeps expected error logging out of the test output
async function quietly<T>(work: () => Promise<T> | T) {
  const original = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = original;
  }
}

before(async () => {
  await resetDatabase();
  app = await startTestApp();
  admin = await app.loginStaff(ids.admin);
  pat = await app.loginPatient(ids.patient, "pat@test.org");
});

after(() => app.close());

describe("shared error handler", () => {
  test("unique and exclusion violations become a 409 without the database detail", () => {
    const unique = handle(
      databaseError("23505", 'duplicate key value violates unique constraint "patient_creds_username_key"', {
        detail: "Key (username)=(pat@test.org) already exists.",
        constraint: "patient_creds_username_key",
        table: "patient_creds",
      })
    );
    assert.equal(unique.status, 409);
    assert.deepEqual(unique.body, { error: "This conflicts with an existing record" });
    assert.doesNotMatch(JSON.stringify(unique.body), /pat@test\.org|patient_creds|Key \(/);

    assert.equal(handle(databaseError("23P01", "conflicting key value violates exclusion constraint")).status, 409);
  });

  test("foreign key errors depend on whether a row was missing or still in use", () => {
    const missing = handle(databaseError("23503", 'insert or update on table "employee" violates foreign key constraint "employee_office_id_fkey"'));
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { error: "Some of the submitted values refer to records that don't exist" });

    const inUse = handle(databaseError("23503", 'update or delete on table "office" violates foreign key constraint "employee_office_id_fkey" on table "employee"'));
    assert.equal(inUse.status, 409);
    assert.deepEqual(inUse.body, { error: "This record is still in use" });
  });

  test("bad values that reach the database become a 400", () => {
    for (const code of ["23502", "23514", "22001", "22003", "22007", "22008", "22P02"]) {
      const result = handle(databaseError(code, `some database message for ${code}`, { detail: "Failing row contains (Pat, 713-555-9000)." }));
      assert.equal(result.status, 400, code);
      assert.deepEqual(result.body, { error: "Some of the submitted values are not valid" }, code);
    }
  });

  test("anything unexpected becomes a generic 500", async () => {
    await quietly(() => {
      const undefinedTable = handle(databaseError("42P01", 'relation "patient_secret" does not exist'));
      assert.equal(undefinedTable.status, 500);
      assert.deepEqual(undefinedTable.body, SERVER_ERROR);

      const plain = handle(new Error("connect failed for postgres://admin:hunter2@db.example.com/clinic"));
      assert.equal(plain.status, 500);
      assert.deepEqual(plain.body, SERVER_ERROR);

      // a code alone doesn't make something a database error
      const lookalike = handle(Object.assign(new Error("not from pg"), { code: "23505" }));
      assert.equal(lookalike.status, 500);
    });
  });

  test("application and validation errors keep their status and message", () => {
    assert.deepEqual(handle(new HttpError(404, "Appointment not found")), { status: 404, body: { error: "Appointment not found" } });
    assert.deepEqual(handle(new HttpError(409, "That time was just taken. Choose another time.")), {
      status: 409,
      body: { error: "That time was just taken. Choose another time." },
    });
    assert.deepEqual(handle(new HttpError(403, "Access denied")), { status: 403, body: { error: "Access denied" } });

    const zod = z.object({ date: z.iso.date("Date must look like 2026-11-10") }).safeParse({ date: "soon" });
    assert.equal(zod.success, false);
    const validation = handle(zod.error) as { status: number; body: { error: string; issues: unknown[] } };
    assert.equal(validation.status, 400);
    assert.equal(validation.body.error, "Date must look like 2026-11-10");
    assert.ok(validation.body.issues.length > 0);
  });
});

describe("errors through the app", () => {
  test("an unexpected database failure on a protected route stays generic", async () => {
    await quietly(async () => {
      await app.db.query("ALTER TABLE form_type RENAME TO form_type_hidden");
      try {
        const res = await pat.get(`/api/patient/${ids.patient}/forms`);
        assert.equal(res.status, 500);
        assert.deepEqual(res.body, SERVER_ERROR);
      } finally {
        await app.db.query("ALTER TABLE form_type_hidden RENAME TO form_type");
      }
    });
  });

  test("a date PostgreSQL can't store is a 400, not a raw 500", async () => {
    const certificate = await admin.post(`/api/staff/${ids.admin}/certificates`, { name: "BLS", issueDate: "0000-01-01", expirationDate: "2030-01-01" });
    assert.equal(certificate.status, 400);
    assert.deepEqual(certificate.body, { error: "Some of the submitted values are not valid" });

    const signup = await app.client().post("/api/auth/patient/signup", {
      firstName: "Old",
      lastName: "Date",
      dob: "0000-01-01",
      phone: "713-555-7200",
      email: "old.date@test.org",
      password: "Test-Password-123",
    });
    assert.equal(signup.status, 400);
    assert.doesNotMatch(JSON.stringify(signup.body), /date\/time field|out of range/);
  });

  test("a missing office on an admin form is a 400 without the constraint name", async () => {
    const types = await app.db.query(`SELECT employee_type_id FROM employee_types WHERE type_name = 'Receptionist'`);
    const res = await admin.post("/api/admin/staff", {
      firstName: "Owen",
      lastName: "Office",
      dob: "1990-01-01",
      phone: "713-555-7300",
      email: "owen.office@test.org",
      officeId: 99999,
      employeeTypeId: types.rows[0].employee_type_id,
      password: "Test-Password-123",
      doctor: null,
      nurse: null,
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Selected office does not exist" });
    assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM employee WHERE email = 'owen.office@test.org'`)).rows[0].n, 0);
  });

  test("a body that isn't JSON is a 400", async () => {
    const res = await fetch(`${app.baseUrl}/api/auth/staff/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"employeeId": 1, "password": ',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "The request body isn't valid JSON" });
  });

  test("validation errors and missing routes keep their usual responses", async () => {
    const bad = await app.client().post("/api/auth/staff/login", { employeeId: "abc", password: "x" });
    assert.equal(bad.status, 400);
    assert.equal(typeof bad.body.error, "string");
    assert.ok(Array.isArray(bad.body.issues));

    const missing = await admin.get("/api/nothing-here");
    assert.equal(missing.status, 404);
  });
});

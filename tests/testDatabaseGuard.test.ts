import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import "./helpers/testDb.js";

// a local stand in for a database the tests must never use, which only counts connection attempts
let attempts = 0;
const standIn = createServer((socket) => {
  attempts += 1;
  socket.destroy();
});
let standInUrl: string;

before(async () => {
  standIn.listen(0, "127.0.0.1");
  await once(standIn, "listening");
  standInUrl = `postgres://postgres@127.0.0.1:${(standIn.address() as AddressInfo).port}/clinic_live`;
});

after(() => new Promise((resolve) => standIn.close(resolve)));

test("a pool pointed at any other database is refused before it connects", async () => {
  // .invalid never resolves, so nothing leaves this machine even without the guard
  for (const connectionString of [standInUrl, "postgres://user:secret@db.example.supabase.invalid:5432/postgres", "not a url"]) {
    const pool = new pg.Pool({ connectionString });
    await assert.rejects(pool.query("SELECT 1"), /Tests may only use the database in TEST_DATABASE_URL/);
    await assert.rejects(pool.connect(), /Tests may only use the database in TEST_DATABASE_URL/);
    await pool.end();
  }
  assert.equal(attempts, 0);
});

test("src code imported before testDb still can't reach another database", async () => {
  const file = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  // the app's pool is created first, like in the earlier mistake, and then a service runs a query
  const code = `
    import ${file("../src/lib/db.ts")};
    import ${file("./helpers/testDb.ts")};
    const { listPatients } = await import(${file("../src/services/patients.ts")});
    try {
      await listPatients();
      console.log("connected");
    } catch (err) {
      console.log(err.message);
    }
    process.exit(0);
  `;

  // DATABASE_URL points at the stand in, so a failed guard could only ever reach it
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: standInUrl };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  await once(child, "exit");

  assert.match(output, /Refusing to connect\. Tests may only use the database in TEST_DATABASE_URL/);
  assert.doesNotMatch(output, /connected/);
  assert.equal(attempts, 0);
});

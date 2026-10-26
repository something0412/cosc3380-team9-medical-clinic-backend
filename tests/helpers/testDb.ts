import "dotenv/config";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { hashPassword } from "../../src/lib/password.js";

// password shared by every test login
export const TEST_PASSWORD = "Test-Password-123";

// IDs created by fixtures.sql
export const ids = {
  admin: 1,
  doctor: 2,
  nurse: 3,
  receptionist: 4,
  patient: 1,
  mainOffice: 1,
  westsideOffice: 2,
  closedOffice: 3,
  familyMedicine: 1,
  cardiology: 2,
  retiredSpecialty: 3,
  morningShift: 1,
};

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

// only a local database whose name ends in _test is allowed
function testDatabaseUrl() {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    throw new Error("TEST_DATABASE_URL is not set. Tests only run against a local test database (see tests/README.md).");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid connection URL.");
  }

  const database = url.pathname.slice(1);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("TEST_DATABASE_URL must be a postgres:// URL.");
  if (!LOCAL_HOSTS.includes(url.hostname) || value.includes("supabase")) {
    throw new Error(`Refusing to test against host "${url.hostname}". TEST_DATABASE_URL must point to a local database.`);
  }
  if (!database.endsWith("_test")) {
    throw new Error(`Refusing to test against database "${database}". The test database name must end in _test.`);
  }
  return { value, database, url };
}

const target = testDatabaseUrl();

// the app reads DATABASE_URL, so point it at the test database before the app is imported
process.env.DATABASE_URL = target.value;
process.env.NODE_ENV = "test";

// throws unless the connection string is the TEST_DATABASE_URL database, ignoring options like a time zone
export function assertTestDatabase(connectionString: string | undefined) {
  let url: URL | null = null;
  try {
    url = new URL(connectionString ?? "");
  } catch {
    // handled below
  }
  if (!url || url.hostname !== target.url.hostname || url.port !== target.url.port || url.pathname !== target.url.pathname) {
    throw new Error("Refusing to connect. Tests may only use the database in TEST_DATABASE_URL.");
  }
}

// every pool checks its target before connecting, even one made by src code imported before this file
const poolConnect = pg.Pool.prototype.connect;
pg.Pool.prototype.connect = function (this: pg.Pool, callback?: (err: Error | undefined, ...rest: unknown[]) => void) {
  try {
    assertTestDatabase((this as unknown as { options: { connectionString?: string } }).options.connectionString);
  } catch (err) {
    if (callback) return callback(err as Error);
    return Promise.reject(err);
  }
  return (poolConnect as (cb?: unknown) => unknown).call(this, callback);
} as typeof poolConnect;

const schemaPath = new URL("../../database/schema.sql", import.meta.url);
const fixturesPath = new URL("./fixtures.sql", import.meta.url);

// migrations not applied to Supabase yet, so schema.sql doesn't include them
const pendingMigrations: string[] = [];

// rebuild the schema from database/schema.sql and load the fixtures
export async function resetDatabase() {
  const client = new pg.Client({ connectionString: target.value });
  await client.connect();
  try {
    // check the server again before dropping anything
    const check = await client.query(`SELECT current_database() AS name, host(inet_server_addr()) AS address`);
    const { name, address } = check.rows[0];
    if (name !== target.database || (address !== null && !["127.0.0.1", "::1"].includes(address))) {
      throw new Error(`Refusing to reset "${name}": it is not the local test database.`);
    }

    // psql commands like \restrict aren't SQL
    const schema = (await readFile(schemaPath, "utf8"))
      .split("\n")
      .filter((line) => !line.startsWith("\\"))
      .join("\n");

    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query(schema);
    // the schema dump clears search_path for its session
    await client.query("SET search_path TO public");
    for (const file of pendingMigrations) {
      await client.query(await readFile(new URL(`../../database/migrations/${file}`, import.meta.url), "utf8"));
    }
    await client.query(await readFile(fixturesPath, "utf8"));

    const hash = await hashPassword(TEST_PASSWORD);
    await client.query("UPDATE employee_creds SET password_hash = $1", [hash]);
    await client.query("UPDATE patient_creds SET password_hash = $1", [hash]);
  } finally {
    await client.end();
  }
}

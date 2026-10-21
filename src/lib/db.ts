import pg from "pg";
import { env } from "../config/env.js";

// Return DATE columns (dob, appointment_date, issue_date, ...) as plain
// "YYYY-MM-DD" strings. By default pg turns them into JS Date objects at
// local midnight, which can shift to the previous day once serialized to
// JSON in UTC.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

// A connection pool, not a single client: each query borrows a connection
// from the pool and returns it when done, instead of every request
// opening its own connection to Postgres (slow) or every request sharing
// one connection (can't run concurrent queries). Routes import `pool` and
// call `pool.query(sql, params)` directly — see routes/patients.ts.
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

// Runs `fn` inside one transaction on one connection: COMMIT if it
// finishes, ROLLBACK if it throws (then re-throws, so the error handler
// still sends the right response). Every query inside must use the
// `client` it's given, not `pool` — a pool query would run on a
// different connection, outside the transaction.
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

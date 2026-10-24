import type { Pool } from "pg";

// makes every matching write on the table fail, to check that earlier steps in the same transaction were undone
// the error code is a check violation so the app answers 400 instead of logging a server error
export async function failWrites(db: Pool, table: string, event: "INSERT" | "UPDATE") {
  await db.query(`
    CREATE OR REPLACE FUNCTION test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'test failure' USING ERRCODE = 'check_violation';
    END $$
  `);
  await db.query(`CREATE TRIGGER test_fail BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION test_fail()`);
  return async () => {
    await db.query(`DROP TRIGGER test_fail ON ${table}`);
  };
}

// keeps each write's transaction open a little longer, so requests sent together really overlap
export async function slowWrites(db: Pool, table: string, event: "INSERT" | "UPDATE") {
  await db.query(`
    CREATE OR REPLACE FUNCTION test_slow() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_sleep(0.3);
      RETURN NEW;
    END $$
  `);
  await db.query(`CREATE TRIGGER test_slow AFTER ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION test_slow()`);
  return async () => {
    await db.query(`DROP TRIGGER test_slow ON ${table}`);
  };
}

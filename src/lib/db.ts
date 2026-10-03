import { Pool } from "pg";
import { env } from "../config/env.js";

// A connection pool, not a single client: each query borrows a connection
// from the pool and returns it when done, instead of every request
// opening its own connection to Postgres (slow) or every request sharing
// one connection (can't run concurrent queries). Routes import `pool` and
// call `pool.query(sql, params)` directly — see routes/patients.ts.
export const pool = new Pool({ connectionString: env.DATABASE_URL });

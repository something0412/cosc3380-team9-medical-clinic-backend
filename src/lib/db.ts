import { Pool } from "pg";
import { env } from "../config/env.js";

// database connection pool
export const pool = new Pool({ connectionString: env.DATABASE_URL });

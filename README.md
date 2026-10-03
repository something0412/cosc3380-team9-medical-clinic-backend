# Medical Clinic — Backend

Express + TypeScript API backed by PostgreSQL (Supabase). No ORM — all database
access is raw SQL via the [`pg`](https://node-postgres.com/) driver.

## Stack

- **Express 5** — because it's v5, route handlers that `throw` or return a
  rejected promise are automatically caught and forwarded to the error
  handler. You don't need to wrap async handlers in try/catch yourself.
- **TypeScript**
- **pg** — a plain connection pool (`src/lib/db.ts`), no ORM. Every route
  writes its own SQL.
- **zod** — validates environment variables on startup (`src/config/env.ts`).
- **PostgreSQL via Supabase**

There used to be a Prisma setup here (schema file, generated client,
migrations). It's been removed in favor of raw SQL, since the point of this
project is practicing SQL directly rather than hiding it behind an ORM.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `DATABASE_URL` to your Supabase project's **pooled**
connection string (port 6543, via Supavisor/pgbouncer). `.env.example` has the
exact format and a commented-out `psql` command for the next step.

The database itself isn't managed by any migration tool — the schema lives in
`../clinic_database_dump.sql` at the repo root. Load it into your Supabase
project once (via the SQL editor, or `psql -f clinic_database_dump.sql`)
before starting the server.

```bash
npm run dev     # tsx watch src/index.ts — restarts on file changes
npm run build   # tsc -p tsconfig.json  → dist/
npm run start   # node dist/index.js    — runs the build output
```

Server listens on `PORT` from `.env` (default `4000`).

## Project layout

```text
src/
  index.ts              # starts the HTTP server
  app.ts                # builds the Express app: middleware + routers, in order
  config/env.ts          # validates process.env with zod
  lib/db.ts             # the pg Pool every route queries through
  middleware/
    errorHandler.ts     # HttpError class + notFoundHandler + errorHandler
  routes/
    health.ts           # GET /api/health
    patients.ts         # GET /api/patients
    template.ts         # GET /api/template
```

## Current routes

| Method | Path             | What it does                                                                                       |
| ------ | ---------------- | --------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`    | Returns `{ status: "ok" }`. No DB access.                                                            |
| GET    | `/api/patients`  | Queries the real `patient` table and returns the rows as JSON.                                      |
| GET    | `/api/template`  | Returns a demo JSON payload with a timestamp. No DB access. Exists only to prove the frontend can reach the backend. |

All routes are prefixed with `/api` — that prefix is set inside each route
file itself (`router.get("/api/...")`), not globally in `app.ts`.

## How to add a new route (e.g. appointments)

There's **no controllers folder** — each `routes/*.ts` file both maps the URL
and writes the SQL directly. Copy the shape of `routes/patients.ts`:

```ts
import { Router } from "express";
import { pool } from "../lib/db.js";

export const appointmentsRouter = Router();

appointmentsRouter.get("/api/appointments", async (_req, res) => {
  const result = await pool.query(`SELECT ... FROM appointment`);
  res.json(result.rows);
});
```

Then wire it into `app.ts`:

```ts
import { appointmentsRouter } from "./routes/appointments.js";
// ...
app.use(appointmentsRouter);
```

A few conventions to keep:

- **Column names**: the real tables (see `clinic_database_dump.sql`) use
  snake_case (`first_name`, `patient_id`, ...). Alias them to camelCase in the
  `SELECT` itself (`first_name AS "firstName"`) so the JSON the API returns
  matches normal JS naming — do the translation once, in the SQL, not in the
  frontend.
- **Expected errors**: `throw new HttpError(404, "Appointment not found")`
  (or whatever status/message fits) instead of hand-rolling a response.
  `errorHandler` turns it into the right JSON automatically.
- **Unexpected errors**: just let them throw. Express 5 + the error handler
  takes care of turning a thrown/rejected error into a `500` without crashing
  the process.

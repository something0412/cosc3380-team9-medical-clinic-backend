# Medical Clinic Backend

Express and TypeScript API backed by PostgreSQL on Supabase. There's no ORM. All database
access is raw SQL through the [`pg`](https://node-postgres.com/) driver.

## Stack

- **Express 5**. Route handlers that throw or return a rejected promise are passed to the
  error handler automatically, so async handlers don't need their own try/catch.
- **TypeScript**
- **pg**, a plain connection pool in `src/lib/db.ts`. Every route writes its own SQL.
- **zod** validates environment variables on startup (`src/config/env.ts`) and request bodies in the routes.
- **PostgreSQL on Supabase**

There used to be a Prisma setup here. It was removed in favor of raw SQL, since the point of
this project is practicing SQL directly instead of hiding it behind an ORM.

## Setup

Install dependencies

```bash
npm install
```

Create `.env` file

```bash
touch .env
```

Edit `.env` and set `DATABASE_URL` to your Supabase project's **pooled**
connection string (port 6543, through Supavisor). In production, also set `SESSION_SECRET`.

```bash
npm run dev     # restarts when files change
```

Server listens on `PORT` from `.env` (default `4000`). The tests are explained in `tests/README.md`
and the database files in `database/README.md`.

## Project layout

```text
src/
  index.ts              # starts the HTTP server
  app.ts                # builds the Express app with middleware and routers, in order
  config/env.ts         # validates process.env with zod
  lib/                  # database pool, transactions, and password hashing
  middleware/           # error handler and role checks
  services/booking.ts   # shared booking rules for patients and receptionists
  scripts/              # setStaffPassword.ts resets a staff password
  routes/
    auth.ts             # login, signup, logout, and the current user
    public.ts           # public doctors, offices, and specialties
    booking.ts          # availability, booking, and cancellation
    health.ts           # GET /api/health, no database access
    template.ts         # GET /api/template, proves the frontend can reach the backend
    admin/              # admin management, reports, and billing
    patient/            # patient portal and profile
    staff/              # employee profiles and the staff patient list
    doctor/             # not mounted yet
    nurse/              # not mounted yet
    receptionist/       # not mounted yet
```

## Routes

Routes are grouped by role under `src/routes`. Most route files write the full `/api/...` path
themselves and are mounted in `app.ts` without a prefix. The public routes are mounted under
`/api/public`, and the admin routes under `/api/admin` behind the admin role check.

The patient portal, staff profiles, and staff patient list are protected by guards in `app.ts`.
The booking routes check who is asking inside each route.

## How to add a new route

There's **no controllers folder**. Each route file both maps the URL and writes the SQL
directly. Put the route in the folder for the role that uses it, like `src/routes/doctor/`,
and copy the shape of an existing file such as `src/routes/staff/patients.ts`.

```ts
import { Router } from "express";
import { pool } from "../../lib/db.js";

export const doctorRouter = Router();

doctorRouter.get("/api/doctor/:id/schedule", async (req, res) => {
  const result = await pool.query(`SELECT ... FROM doctor_schedule WHERE doctor_id = $1`, [req.params.id]);
  res.json(result.rows);
});
```

Then wire it into `app.ts`. Add an access check for the role before it, like the guards
already in `app.ts`, since the folder alone doesn't protect anything.

```ts
import { doctorRouter } from "./routes/doctor/index.js";
// ...
app.use(doctorRouter);
```

A few conventions to keep.

- The tables in `database/schema.sql` use snake_case column names like `first_name`. Alias
  them to camelCase in the `SELECT` itself (`first_name AS "firstName"`) so the JSON the API
  returns matches normal JavaScript naming. Do the translation once, in the SQL, not in the frontend.
- For expected errors, throw `new HttpError(404, "Appointment not found")` with whatever
  status and message fit. `errorHandler` turns it into the right JSON automatically.
- Let unexpected errors throw. Express 5 and the error handler turn them into a `500`
  without crashing the process.
- Booking rules live in `src/services/booking.ts`. Patient and receptionist features should
  call the shared booking routes instead of writing their own scheduling checks.

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

Install dependencies

```bash
npm install
```

Create `.env` file

```bash
touch .env
```

Edit `.env` and set `DATABASE_URL` to your Supabase project's **pooled**
connection string (port 6543, via Supavisor/pgbouncer).

```bash
npm run dev     # tsx watch src/index.ts — restarts on file changes
```

Server listens on `PORT` from `.env` (default `4000`).

## Project layout

```text
src/
  index.ts              # starts the HTTP server
  app.ts                # builds the Express app: middleware + routers, in order
  config/env.ts          # validates process.env with zod
  lib/db.ts             # the pg Pool every route queries through
  lib/staff.ts          # nurse / receptionist checks (requireStaffType)
  middleware/
    errorHandler.ts     # HttpError class + notFoundHandler + errorHandler
  routes/
    appointments.ts     # appointments, doctors, availability, booking, check-in/out
    auth.ts             # patient signup/login, staff login
    billing.ts          # billing summary, invoices, payments
    health.ts           # GET /api/health
    intake.ts           # emergency contacts, insurance, forms
    patients.ts         # search, registration, profile, chart, vitals
    template.ts         # GET /api/template
migrations/             # SQL to run on top of clinic_database_dump.sql
```

## Current routes

"Receptionists only" / "nurses only" routes take the acting employee's id in
the body (`employeeId`, or `recordedByEmployeeId` for vitals) and check it
with `requireStaffType` (`lib/staff.ts`), which also returns the employee's
office. Receptionists are employees whose type name starts with "Reception";
nurses are employees with a row in `nurse`.

**General**

| Method | Path | What it does |
| ------ | ---- | ------------ |
| GET | `/api/health` | Returns `{ status: "ok" }`. No DB access. |
| GET | `/api/template` | Demo JSON payload. No DB access. Only proves the frontend can reach the backend. |

**Patients** (`routes/patients.ts`)

| Method | Path | What it does |
| ------ | ---- | ------------ |
| GET | `/api/patients?search=&dob=&phone=` | Global patient search; every filter optional. |
| POST | `/api/patients` | Registers a patient, plus optional emergency contact, insurance and portal login, in one transaction. Receptionists only. |
| GET | `/api/patients/:patientId` | Profile: demographics, emergency contacts, insurance, portal-account flag. |
| PUT | `/api/patients/:patientId` | Edits demographics (keeps the portal username in sync with the email). Receptionists only. |
| POST | `/api/patients/:patientId/credentials` | Creates a portal login (username = email). Receptionists only. |
| GET | `/api/patients/:patientId/chart` | Nurse chart: patient info, active allergies, vitals (newest first), current meds (home + prescribed). |
| POST | `/api/patients/:patientId/vitals` | Records vitals into `patient_vitals`. Body: `recordedByEmployeeId`, optional `appointmentId` (must be this patient's), `temperatureF`, `heartRateBpm`, `systolic` + `diastolic` (both or neither), `weightLbs`, `heightInches` (`null` = not taken, at least one required). Nurses only. |

**Intake** (`routes/intake.ts`, writes are receptionists only)

| Method | Path | What it does |
| ------ | ---- | ------------ |
| POST | `/api/patients/:patientId/emergency-contacts` | Adds a contact; the first one is always primary. |
| PUT | `/api/emergency-contacts/:contactId` | Edits a contact; `isPrimary: true` makes it the only primary. |
| PATCH | `/api/emergency-contacts/:contactId/deactivate` | Soft-deletes a contact (not the primary). |
| PUT | `/api/patients/:patientId/insurance` | Adds or replaces the policy (upsert); a changed policy goes back to Pending. |
| PATCH | `/api/patients/:patientId/insurance/status` | Sets Pending / Verified / Denied. |
| GET | `/api/form-types` | Active form types. |
| GET | `/api/patients/:patientId/forms` | Every form type with this patient's status for it. |
| PATCH | `/api/patients/:patientId/forms/:formTypeId/complete` | Marks a form completed. |

**Scheduling** (`routes/appointments.ts`, writes are receptionists only, own office)

| Method | Path | What it does |
| ------ | ---- | ------------ |
| GET | `/api/appointments?date=&officeId=` | A day's appointments with waiting-room state (`visitState`) and readiness flags. |
| GET | `/api/specialties` | Active specialties and whether they need a referral. |
| GET | `/api/doctors?specialtyId=` | Active doctors and their specialties. |
| GET | `/api/availability?date=&officeId=&specialtyId=&doctorId=` | Open slots from `doctor_schedule` + `time_slot`, minus booked ones. |
| GET | `/api/patients/:patientId/referrals?doctorId=&specialtyId=&date=` | Referrals valid for that booking. |
| POST | `/api/appointments` | Books by phone; locks the doctor's schedule row so a slot can't be double-booked; enforces referrals. |
| PATCH | `/api/appointments/:appointmentId/check-in` | Sets `checked_in_at` (day of the visit only). |
| PATCH | `/api/appointments/:appointmentId/check-out` | Sets `checked_out_at` and status `Completed`. |
| PATCH | `/api/appointments/:appointmentId/no-show` | Sets status `No Show`. |

**Billing** (`routes/billing.ts`, writes are receptionists only)

| Method | Path | What it does |
| ------ | ---- | ------------ |
| GET | `/api/appointments/:appointmentId/invoice-estimate` | $50 check-in fee + the visit's lab tests, itemized. |
| POST | `/api/invoices` | Bills a completed visit; amount defaults to, and can't go below, the estimate; one invoice per visit (row lock). |
| GET | `/api/invoices?officeId=&status=` | Office worklist (default: Pending) with balances. |
| GET | `/api/patients/:patientId/billing` | A patient's insurance, invoices (paid and balance) and payments. |
| GET | `/api/patients/:patientId/uninvoiced-appointments` | Completed visits with no invoice yet. |
| GET | `/api/payment-types` | Payment methods. |
| POST | `/api/invoices/:invoiceId/payments` | Records a payment (row lock, no overpaying); marks the invoice Paid when the balance hits 0. |
| GET | `/api/payments/:paymentId/receipt` | Everything printed on a receipt. |

All routes are prefixed with `/api` — that prefix is set inside each route
file itself (`router.get("/api/...")`), not globally in `app.ts`.

## Migrations

Run these once, in order, in the Supabase SQL editor after loading the dump:

1. `001_appointment_check_in.sql` adds `checked_in_at`/`checked_out_at` to
   `appointment` (the only change to the original schema).
2. `002_patient_vitals.sql` creates the `patient_vitals` table.

The check-in and vitals routes fail until these are applied. Double-booking
and one-invoice-per-visit are enforced in the routes' SQL (row locks inside
transactions), not by the schema.

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

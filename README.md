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

## Database changes

On top of `clinic_database_dump.sql`, run these once in the Supabase SQL editor:

- `migrations/001_appointment_check_in.sql` — adds `checked_in_at` / `checked_out_at` to `appointment`
- `migrations/002_patient_vitals.sql` — creates `patient_vitals`

Starter data for testing (safe to run more than once):

- `seeds/receptionist_nurse_starter_data.sql` — payment types, allergy types, forms, medications, supplies
- `seeds/demo_doctor_schedule.sql` — shifts, time slots and a Mon–Fri schedule for each doctor

## Project layout

```text
src/
  index.ts              # starts the HTTP server
  app.ts                # builds the Express app: middleware + routers, in order
  config/env.ts          # validates process.env with zod
  lib/db.ts             # the pg Pool every route queries through (+ withTransaction)
  lib/staff.ts          # requireStaffType — is this employee a nurse / receptionist?
  middleware/
    errorHandler.ts     # HttpError class + notFoundHandler + errorHandler
  routes/
    appointments.ts     # appointments, availability, booking, check-in/out
    auth.ts             # patient signup/login, staff login
    billing.ts          # invoices, payments, receipts
    health.ts           # GET /api/health
    intake.ts           # emergency contacts, insurance, forms
    nursing.ts          # allergies, home meds, visit notes, labs, supplies
    patients.ts         # patients, chart, vitals
    template.ts         # GET /api/template
migrations/             # schema changes on top of the dump
seeds/                  # starter data
```

## Current routes

| Method | Path             | What it does                                                                                       |
| ------ | ---------------- | --------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`    | Returns `{ status: "ok" }`. No DB access.                                                            |
| GET    | `/api/template`  | Returns a demo JSON payload with a timestamp. No DB access. Exists only to prove the frontend can reach the backend. |
| GET    | `/api/patients`  | All patients (optional `?search=`, `?dob=`, `?phone=`).                                              |
| POST   | `/api/patients`  | Register a patient (+ emergency contact, insurance, portal login).                                  |
| GET    | `/api/patients/:id` | Patient profile.                                                                                 |
| PUT    | `/api/patients/:id` | Edit patient details.                                                                            |
| POST   | `/api/patients/:id/credentials` | Create a portal login.                                                               |
| GET    | `/api/patients/:id/chart` | Nurse chart: allergies, vitals, medications.                                               |
| POST   | `/api/patients/:id/vitals` | Record vitals.                                                                            |
| POST   | `/api/patients/:id/emergency-contacts` | Add an emergency contact.                                                     |
| PUT    | `/api/emergency-contacts/:id` | Edit a contact / make it primary.                                                      |
| PATCH  | `/api/emergency-contacts/:id/deactivate` | Remove a contact.                                                           |
| PUT    | `/api/patients/:id/insurance` | Add or update insurance.                                                               |
| PATCH  | `/api/patients/:id/insurance/status` | Pending / Verified / Denied.                                                    |
| GET    | `/api/form-types`, `/api/patients/:id/forms` | Intake forms and a patient's form status.                               |
| PATCH  | `/api/patients/:id/forms/:formTypeId/complete` | Mark a form completed.                                                |
| GET    | `/api/appointments?date=&officeId=` | A day's appointments.                                                           |
| GET    | `/api/specialties`, `/api/doctors` | Lists for booking.                                                               |
| GET    | `/api/availability?date=&officeId=&specialtyId=` | Open time slots.                                                   |
| GET    | `/api/patients/:id/referrals` | Referrals that allow a booking.                                                        |
| POST   | `/api/appointments` | Book an appointment.                                                                             |
| PATCH  | `/api/appointments/:id/check-in`, `/check-out`, `/no-show` | Front desk status changes.                                |
| GET    | `/api/appointments/:id/invoice-estimate` | $50 check-in fee + lab tests.                                               |
| GET    | `/api/invoices?officeId=` | Unpaid invoices for an office.                                                             |
| POST   | `/api/invoices` | Create an invoice for a completed visit.                                                             |
| GET    | `/api/patients/:id/billing` | A patient's invoices and payments.                                                       |
| GET    | `/api/patients/:id/uninvoiced-appointments` | Completed visits not billed yet.                                         |
| GET    | `/api/payment-types` | Payment methods.                                                                                |
| POST   | `/api/invoices/:id/payments` | Record a payment.                                                                       |
| GET    | `/api/payments/:id/receipt` | Receipt data.                                                                            |
| GET    | `/api/allergy-types`, `/api/medications`, `/api/lab-test-types` | Lists for the nurse forms.                          |
| POST   | `/api/patients/:id/allergies` | Add an allergy.                                                                        |
| PATCH  | `/api/allergies/:id`, `/api/allergies/:id/deactivate` | Edit / remove an allergy.                                      |
| POST   | `/api/patients/:id/home-medications` | Record a home medication.                                                       |
| PATCH  | `/api/home-medications/:id`, `/deactivate` | Edit / stop a home medication.                                            |
| GET    | `/api/appointments/:id/summary` | Visit notes.                                                                         |
| POST   | `/api/appointments/:id/notes` | Add a visit note.                                                                      |
| GET    | `/api/patients/:id/lab-orders` | A patient's lab orders.                                                               |
| POST   | `/api/lab-orders` | Order a lab test.                                                                                  |
| PATCH  | `/api/lab-orders/:id` | Update lab status / results.                                                                   |
| GET    | `/api/office-supplies?officeId=`, `/api/supply-orders?officeId=` | Office stock and restock requests.                 |
| POST   | `/api/office-supplies/:id/use` | Use supplies.                                                                         |
| POST   | `/api/supply-orders` | Request a restock.                                                                              |

All routes are prefixed with `/api` — that prefix is set inside each route
file itself (`router.get("/api/...")`), not globally in `app.ts`.

Routes that change data for nurses or receptionists take the staff member's
`employeeId` in the body and check it with `requireStaffType` (`lib/staff.ts`).

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

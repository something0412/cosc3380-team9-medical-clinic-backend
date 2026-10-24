# Medical Clinic Backend

This is the API for the COSC 3380 Medical Clinic project. It uses Express and TypeScript with a PostgreSQL database hosted on Supabase. There's no ORM. Every query is handwritten SQL through the [pg](https://node-postgres.com/) driver, and request bodies are checked with [zod](https://zod.dev/).

## Getting started

You need Node.js 22. Install the dependencies first.

```bash
npm install
```

Then create a `.env` file in this folder. Git ignores it.

- `DATABASE_URL` is the Supabase connection string. Use the session pooler on port 5432. This one is required.
- `SESSION_SECRET` signs the login cookies. It's required in production.
- `PORT` is optional and defaults to 4000.
- `FRONTEND_URL` is the frontend address allowed by CORS. It defaults to `http://localhost:5173`.

Start the server with this command. It restarts when you save a file.

```bash
npm run dev
```

To run the compiled version instead, use `npm run build` and then `npm start`.

If a staff member needs a login or a new password, `npm run set-staff-password -- <employeeId> <password>` creates or resets it in the database that `DATABASE_URL` points to.

## Tests

The tests run the real app against a local PostgreSQL database and never touch Supabase. Setup steps are in [tests/README.md](tests/README.md).

```bash
npm test
npx tsc -p tests
```

## Project layout

```text
src/
  app.ts                sets up the Express app and mounts the routes
  routes/               route files, grouped by role
  services/booking.ts   shared booking rules for patients and receptionists
  services/patients.ts  shared patient rules for sign up, the front desk, profiles, and Admin
  services/referrals.ts referral rules for doctors and the patient portal
  services/billing.ts   invoices, payments, and the balance every billing view uses
  services/clinical.ts  charts, visit records, allergies, and home medications for doctors and nurses
  middleware/           signed in user check, error handler, and role checks
  lib/                  database pool, transactions, password hashing, and clinic time
database/               schema snapshot and migrations
tests/                  backend tests
```

Most route files write their full `/api/...` paths and are mounted in `app.ts`. The public website routes are under `/api/public` and the admin routes are under `/api/admin`. The doctor, nurse, and lab routes work except the doctor's weekly schedule and the nurse supply routes. Most receptionist routes are still unfinished, but the receptionist patient and appointment routes work.

## Writing routes

- Put a new route in the folder for the role that uses it and mount it in `app.ts`. The folder alone doesn't protect anything, so add an access check.
- Use `req.user` for access checks. It's loaded from the database on every signed in request and has the role, staff type, and office.
- Alias columns to camelCase in the SQL, like `first_name AS "firstName"`.
- Throw `new HttpError(404, "Appointment not found")` for expected errors. Anything unexpected becomes a generic 500 without database details.
- Use `CLINIC_TODAY` and `CLINIC_NOW` from `src/lib/clinicTime.ts` for clinic dates. The database runs on UTC, so `CURRENT_DATE` can already be tomorrow in Chicago.
- Booking, check in, check out, No Show, and the staff appointment lists go through `src/services/booking.ts`. Don't add separate scheduling checks.
- Creating, approving, denying, and listing referrals go through `src/services/referrals.ts`. Booking still decides whether a referral can be used for an appointment.
- Invoices, payments, and balances go through `src/services/billing.ts`. Only admins create invoices or record payments.
- Patient charts, visit records, allergies, and home medications go through `src/services/clinical.ts` for both doctors and nurses. A doctor only sees the charts of patients they're assigned to or have a booked or finished visit with. A nurse only sees patients with a visit at their office today.
- Patient sign up, front desk registration, portal logins, status, contact info, emergency contacts, and insurance go through `src/services/patients.ts`.

## Database

`database/schema.sql` matches the live Supabase database. Editing files in `database/` doesn't change Supabase. Read [database/README.md](database/README.md) before adding a migration.

# Lambda Medical Clinic: Backend

Lambda Medical Clinic is the COSC 3380 Team 9 database project. It's a clinic management system where patients book appointments and pay bills online, doctors and nurses keep visit records, receptionists run the front desk, lab technicians enter results, and admins manage staff, offices, billing and reports.

This repository has the API server, the database and the backend tests. **Start here.** This README explains how to run the whole project locally. The [frontend README](https://github.com/something0412/cosc3380-team9-medical-clinic-frontend/blob/main/README.md) (in the `cosc3380-team9-medical-clinic-frontend` folder) covers the website's pages and options.

## Submitted files

| File or folder | What it is |
| --- | --- |
| `cosc3380-team9-medical-clinic-backend/` | This repository: the API server, database files and tests |
| `cosc3380-team9-medical-clinic-frontend/` | The React website |
| `cosc3380-team9-medical-clinic-backend/database/lambda_medical_clinic_dump.sql` | SQL dump of the populated database (structure and data) |
| `Lambda Medical Clinic Project Document.pdf` | The project document: data operations, user roles, triggers, and queries and reports |

## Technologies

- **Node.js** and **Express 5** with **TypeScript**
- **PostgreSQL 17**. The live site uses a database hosted on Supabase, but you don't need Supabase to run the project locally.
- **pg** for queries. There's no ORM, so every query is handwritten SQL.
- **zod** to check request bodies
- **express-session** with **connect-pg-simple** for logins, which keeps sessions in the `session` table
- The website uses React, Vite and Tailwind CSS. See the frontend README.

## How the parts connect

```text
Browser (React website, port 5173)
   |  HTTP requests to /api/..., with the login cookie
   v
Express API (this repository, port 4000)
   |  SQL through the pg driver
   v
PostgreSQL database (lambda_clinic)
```

- The website never talks to the database directly. Every page calls the API.
- The API checks who is signed in and what their role allows on every request, then runs the SQL.
- Important rules also live in the database as triggers, so they hold even if the API has a bug. For example, specialist visits need an approved referral, and checking a patient out creates their invoice. The 18 triggers are listed in [database/README.md](database/README.md).

## Running the project locally

### What you need

- **Node.js 22.13 or newer.** We used 22.18.
- **PostgreSQL 17 or newer**, including the `psql` and `createdb` command line tools. The PostgreSQL installer includes them. We tested the restore with PostgreSQL 18.
- Both project folders, `cosc3380-team9-medical-clinic-backend` and `cosc3380-team9-medical-clinic-frontend`.

On Windows, if `psql` or `createdb` isn't found, use the full path, like `"C:\Program Files\PostgreSQL\18\bin\psql.exe"`, or add that `bin` folder to your PATH.

### 1. Create the database and load the dump

Open a terminal in the backend folder and run these two commands. Each one asks for your PostgreSQL password.

```bash
createdb -U postgres lambda_clinic
```

```bash
psql -U postgres -d lambda_clinic -v ON_ERROR_STOP=1 -f database/lambda_medical_clinic_dump.sql
```

This takes a few seconds and should finish without errors. It creates 46 tables with 5,511 rows, 26 functions and 18 triggers. To check it, this should print `605`, the number of appointments.

```bash
psql -U postgres -d lambda_clinic -c "SELECT count(*) FROM appointment;"
```

Use `psql` for the restore. pgAdmin's Query Tool can't run the file, because the dump has `psql` commands like `\restrict` in it.

### 2. Configure the backend

Copy `.env.example` to a new file named `.env` in the backend folder. Git ignores `.env`, so your password stays on your computer.

```bash
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead.

Open `.env` and replace `YOUR_POSTGRES_PASSWORD` with your PostgreSQL password. `DATABASE_URL` is the only required setting.

```env
DATABASE_URL=postgres://postgres:YOUR_POSTGRES_PASSWORD@localhost:5432/lambda_clinic
```

The other settings are optional.

| Variable | What it does | Default |
| --- | --- | --- |
| `DATABASE_URL` | The database the API uses (required) | none |
| `PORT` | The API's port | `4000` |
| `FRONTEND_URL` | The website address allowed to call the API | `http://localhost:5173` |
| `SESSION_SECRET` | Signs the login cookies. Without it, a random one is made each time the server starts, so you're signed out after every restart. | random |
| `NODE_ENV` | Leave it unset locally. The hosted backend uses `production`, which requires `SESSION_SECRET`. | `development` |
| `TEST_DATABASE_URL` | The separate database for the tests. See [tests/README.md](tests/README.md). | none |

### 3. Install and start the backend

```bash
npm install
```

```bash
npm run dev
```

It prints `Server listening on http://localhost:4000` and restarts whenever you save a file. Keep this terminal open.

To run the compiled version instead, use `npm run build` and then `npm start`.

### 4. Install and start the frontend

Open a second terminal in the frontend folder.

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:5173 in your browser.

### 5. Set an admin password and sign in

The dump only stores password hashes, so give the admin account (employee 1017) a password before you sign in. Run this in the backend folder with a password of your choice.

```bash
npm run set-staff-password -- 1017 YOUR_PASSWORD
```

The script writes to the database in `DATABASE_URL`, so make sure your `.env` points at your local database.

Then sign in at http://localhost:5173/login as `admin@lambda.clinic.org` with that password. From the admin pages you can set passwords for other accounts. For staff, open the employee under **Employees** and choose **Reset Password**. For patients, choose **Edit** under **Patients**. Running the same command with another employee ID also works.

## Logins and roles

- There's one login page for everyone. The email decides which account signs in and which role it has.
- The roles are patient, doctor, nurse, receptionist, lab technician and admin. Each has its own portal: `/patient`, `/doctor`, `/staff` (nurses and receptionists), `/lab` and `/admin`. The [frontend README](https://github.com/something0412/cosc3380-team9-medical-clinic-frontend/blob/main/README.md#roles-and-pages) lists each role's pages.
- Signing in starts a session that lasts 8 hours. The browser keeps a login cookie and the server keeps the session in the `session` table.
- The API loads the signed in user from the database on every request. A changed role takes effect right away, and a deactivated account is signed out.
- Passwords are stored as salted scrypt hashes (`src/lib/password.ts`).
- Access is checked on the server. `src/app.ts` limits each `/api/<role>` path to that role, and each route checks what the user may see. For example, a doctor only opens charts of their own patients.

## Things to know while it runs

- Appointments whose time has passed without the patient checking in become **No Show** automatically on the next request, at most once a minute. Each new No Show gets an invoice for the no show fee. The sample data has appointments through the end of 2026, so more of them turn into No Show as those dates pass. That's expected.
- Clinic dates and times use the `America/Chicago` time zone.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `createdb: database "lambda_clinic" already exists` | Use another name in both `createdb` and `DATABASE_URL`, or delete the old local copy with `dropdb -U postgres lambda_clinic`. Only do that if you don't need it. |
| `password authentication failed` | Check the password in `DATABASE_URL`. Characters like `@` or `#` in a password have to be URL encoded, for example `@` becomes `%40`. |
| The website says "Can't reach the server. Is the backend running?" | Start the backend (step 3). If it uses a different port, see the next row. |
| Port 4000 is already in use | Set `PORT=4001` in the backend `.env`. In the frontend, create a `.env` with `VITE_API_URL=http://localhost:4001` and restart `npm run dev`. |
| Login fails with a CORS error, or you're signed out right after signing in | The website has to run at `http://localhost:5173`. If Vite picked another port because 5173 was busy, free that port or set `FRONTEND_URL` in the backend `.env` to the address Vite shows. |
| Signed out every time the backend restarts | Set any long random `SESSION_SECRET` in the backend `.env`. |

## Tests

The tests run the real app against a separate local test database and never touch Supabase. There are 502 tests in 29 files. Setup steps are in [tests/README.md](tests/README.md).

```bash
npm test
```

```bash
npx tsc -p tests
```

## Project layout

```text
src/
  index.ts              starts the server
  app.ts                sets up Express, logins and access checks, and mounts the routes
  routes/               route files, grouped by role (patient, doctor, nurse, receptionist, lab, admin, staff)
  services/booking.ts   shared booking rules for patients and receptionists
  services/patients.ts  shared patient rules for sign up, the front desk, profiles and Admin
  services/referrals.ts referrals: sent with a reason, approved or denied by the patient's primary doctor
  services/billing.ts   invoices, payments and the balance every billing view uses
  services/clinical.ts  charts, visit records, allergies and home medications for doctors and nurses
  services/employees.ts employee records, roles, status and logins for the admin staff pages
  middleware/           signed in user check, error handler, role checks and automatic No Show
  lib/                  database pool, transactions, password hashing and clinic time
  scripts/              the set-staff-password script
database/               SQL dump, schema snapshot and migrations
tests/                  backend tests
```

Most route files write their full `/api/...` paths and are mounted in `app.ts`. The public website routes are under `/api/public` and the admin routes are under `/api/admin`.

## Database, triggers and reports

- [database/README.md](database/README.md) explains the dump, the schema snapshot, the migrations and all 18 triggers.
- The 3 admin data reports (Missed Appointments, Unpaid Balances, Schedule Utilization) are in `src/routes/admin/dataReports.ts` under `/api/admin/data-reports/...`. There's one route per report and an `options` route for the filter choices. The yearly dashboard report is in `src/routes/admin/reports.ts`. The frontend README explains what each report shows.

## Writing routes

- Put a new route in the folder for the role that uses it and mount it in `app.ts`. The folder alone doesn't protect anything, so add an access check.
- Use `req.user` for access checks. It's loaded from the database on every signed in request and has the role, staff type and office.
- Alias columns to camelCase in the SQL, like `first_name AS "firstName"`.
- Throw `new HttpError(404, "Appointment not found")` for expected errors. Anything unexpected becomes a generic 500 without database details. When a database trigger refuses a change, its message is sent to the user as a 409.
- Use `CLINIC_TODAY` and `CLINIC_NOW` from `src/lib/clinicTime.ts` for clinic dates. The database runs on UTC, so `CURRENT_DATE` can already be tomorrow in Chicago.
- Booking, check in, check out, No Show and the staff appointment lists go through `src/services/booking.ts`. Don't add separate scheduling checks.
- Creating, approving, denying and listing referrals go through `src/services/referrals.ts`. A referral needs a reason and goes to the patient's primary doctor, who approves it or denies it with a reason. If the patient has no primary doctor yet, a doctor seeing them today for Family Medicine or Internal Medicine becomes their primary doctor. Booking still decides whether a referral can be used for an appointment, and a trigger enforces it too.
- Invoices, payments and balances go through `src/services/billing.ts`. Checking a patient out creates the invoice automatically. Payments come from the front desk, admins, or the patient paying by card, and can't be more than the balance. Every invoice or payment change must say who made it in the same transaction, with `setBillingEmployee(client, employeeId)` for staff or `set_config('app.patient_id', ..., true)` for a patient.
- Patient charts, visit records, allergies and home medications go through `src/services/clinical.ts` for both doctors and nurses. A doctor only sees the charts of patients they're assigned to or have a booked or finished visit with. A nurse can view the intake of any visit, but only edits it on the visit day, at their own office, after check in.
- Creating, editing, activating and deactivating employees go through `src/services/employees.ts`, so the Employees and Staff pages follow the same rules. A doctor with Scheduled appointments can't be deactivated.
- Patient sign up, front desk registration, portal logins, status, contact info, emergency contacts and insurance go through `src/services/patients.ts`.
- Editing files in `database/` doesn't change Supabase. Read [database/README.md](database/README.md) before adding a migration.

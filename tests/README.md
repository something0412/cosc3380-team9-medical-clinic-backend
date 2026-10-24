# Tests

Backend tests that run the real Express app against a local PostgreSQL test database.

Tests must never run against the shared Supabase database. They only use `TEST_DATABASE_URL`, and they refuse to start unless it points to a local database whose name ends in `_test`.

## What's covered

- `auth.test.ts` covers staff and patient login, logout, inactive and disabled logins, and Admin only access for every Admin endpoint.
- `admin/employees.test.ts` covers the employee directory, creating and editing employees, doctor and nurse details, and account management.
- `admin/offices.test.ts` covers the office directory, creating and editing offices, validation, and activation rules.
- `admin/specialties.test.ts` covers the specialty directory, creating and editing specialties, the referral rule, and activation rules.
- `admin/schedules.test.ts` covers doctor schedules, shifts, time slots, and protection for booked appointments.
- `admin/clinicDate.test.ts` checks that schedule and time slot checks use the Chicago date, even when the database date has already rolled over.
- `admin/integration.test.ts` covers workflows across features, like setting up a doctor's schedule from scratch, deactivation dependencies, the login lifecycle, appointment protection, and data integrity.
- `public.test.ts` covers the public doctor, office, and specialty endpoints, including active record filtering, practice offices from active schedules only, doctor counts, invalid and missing IDs, and no private fields in responses.
- `appointments.test.ts` covers availability, public availability for visitors, booking, referrals, simultaneous bookings, Admin schedule changes, cancellation, and booking permissions.
- `triggers.test.ts` covers the appointment history, employee audit, and appointment conflict triggers, plus row level security on the audit tables.
- `profiles.test.ts` covers patient and staff profile updates, emergency contacts, insurance, certificates, password rules, ownership checks, and registration of every patient and staff route.
- `sessions.test.ts` covers ending sessions for deactivated, disabled, and deleted accounts, and checks that role, staff type, and office changes apply on the next request.
- `errors.test.ts` covers the shared error handler, including safe responses for database errors that would otherwise show private details.
- `clinicTime.test.ts` checks the patient dashboard and certificate status against the Chicago date while the database date is a day off, and that No Show visits aren't counted as upcoming.
- `roleAccess.test.ts` calls every GET endpoint as each role and checks the expected permissions. It saves what each role got back in `tests/output/role-access/`, which Git ignores.

## Setup

You need Node.js 22 and a local PostgreSQL server.

1. Create an empty test database.

   ```bash
   createdb cosc3380_test
   ```

2. Add `TEST_DATABASE_URL` to your backend `.env`, which Git ignores.

   ```
   TEST_DATABASE_URL=postgres://postgres:yourpassword@localhost:5432/cosc3380_test
   ```

Each test file rebuilds the database from `database/schema.sql`, applies any migrations listed in `tests/helpers/testDb.ts` (none right now), and loads sample data from `tests/helpers/fixtures.sql`, so nothing else needs to be set up.

## Running

```bash
npm test                                            # all tests
npm run test:file -- tests/admin/offices.test.ts    # one file
```

Test files run one at a time because they share the test database.

Type check the tests with `npx tsc -p tests`.

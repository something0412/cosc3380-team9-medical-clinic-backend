# Tests

Backend tests that run the real Express app against a local PostgreSQL test database.

**Tests must never run against the shared Supabase database.** They only use `TEST_DATABASE_URL`, and refuse to start unless it points to a local database whose name ends in `_test`.

## What's covered

- `auth.test.ts` — staff and patient login, logout, inactive and disabled logins, and Admin-only access for every Admin endpoint.
- `admin/employees.test.ts` — employee directory, create/edit, doctor and nurse details, and account management.
- `admin/offices.test.ts` — office directory, create/edit, validation, and activation rules.
- `admin/specialties.test.ts` — specialty directory, create/edit, referral rule, and activation rules.
- `admin/schedules.test.ts` — doctor schedules, shifts, time slots, and booked-appointment protection.
- `admin/integration.test.ts` — workflows across features: setting up a doctor's schedule from scratch, deactivation dependencies, login lifecycle, appointment protection, and data integrity.
- `roleAccess.test.ts` — calls every GET endpoint as anonymous, patient, doctor, nurse, receptionist, and admin, checks each against the expected permissions, and writes what each role got back to `tests/output/role-access/` (git-ignored): one `<role>.json` per role plus a `summary.md` matrix.

## Setup

You need Node.js 22 and a local PostgreSQL server.

1. Create an empty test database:

   ```bash
   createdb cosc3380_test
   ```

2. Add `TEST_DATABASE_URL` to your backend `.env` (it's git-ignored):

   ```
   TEST_DATABASE_URL=postgres://postgres:yourpassword@localhost:5432/cosc3380_test
   ```

Each test file rebuilds the database from `database/schema.sql` and loads sample data from `tests/helpers/fixtures.sql`, so nothing else needs to be set up.

## Running

```bash
npm test                                            # all tests
npm run test:file -- tests/admin/offices.test.ts    # one file
```

Test files run one at a time because they share the test database.

To type-check the tests: `npx tsc -p tests`.

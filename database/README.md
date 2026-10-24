# Database

This folder has the SQL for the Medical Clinic database. The live PostgreSQL database is hosted on Supabase.

- `schema.sql` is a snapshot of the live database structure. It has all 41 tables with their relationships, constraints, triggers, and trigger functions, but no patient or employee records.
- `seed.sql` is for fictional sample data. It's empty right now.
- `migrations/` has the SQL scripts for database changes.

Editing these files doesn't change Supabase. Changes have to be applied there separately.

Migrations 003 to 005 add the appointment history, employee audit, and appointment conflict triggers. They're already applied to the shared Supabase database and included in `schema.sql`, so there's no need to run them there again.

A new migration should be reviewed, applied to Supabase once with `psql` over the session mode connection (port 5432), and then `schema.sql` should be refreshed from Supabase. Until it's in `schema.sql`, add the file name to `pendingMigrations` in `tests/helpers/testDb.ts` so the tests apply it.

`schema.sql` is exported without privileges. If you build a new Supabase project from it, also run migrations 003 and 004, which are safe to run again. They remove the default API role access to the two audit tables.

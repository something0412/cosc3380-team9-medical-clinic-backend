# Database

This folder has the SQL for the Medical Clinic database. The live PostgreSQL database is hosted on Supabase.

- `schema.sql` is a snapshot of the live database structure. It has all 42 tables with their relationships, constraints, triggers, and trigger functions, but no patient or employee records.
- `seed.sql` is for fictional sample data. It's empty right now.
- `migrations/` has the SQL scripts for database changes.

Editing these files doesn't change Supabase. Changes have to be applied there separately.

Migrations 003 to 005 add the appointment history, employee audit, and appointment conflict triggers. They're already applied to the shared Supabase database and included in `schema.sql`, so don't run them there again.

Migration 009 allows only one invoice per appointment. It's already applied to Supabase and included in `schema.sql`.

Migration 010 adds the `nursing_note` table for nursing notes. It's already applied to Supabase and included in `schema.sql`.

To add a new migration, have it reviewed first. Then apply it to Supabase once with `psql` over the session pooler connection on port 5432, and refresh `schema.sql` from Supabase. Until it's in `schema.sql`, add the file name to `pendingMigrations` in `tests/helpers/testDb.ts` so the tests apply it.

`schema.sql` is exported without privileges. If you ever build a new Supabase project from it, also run migrations 003 and 004 there. They're safe to run again, and they remove the default API access to the two audit tables. Also run the revoke step at the end of migration 010, since the rest of that file fails once the table exists.

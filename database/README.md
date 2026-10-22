# Database

This folder contains the SQL files used to manage the Medical Clinic database. The live PostgreSQL database is hosted on Supabase.

## Files

- `schema.sql` — Complete database structure, including tables, relationships, and constraints.
- `seed.sql` — Sample data for development and testing.
- `migrations/` — SQL files for tracking future database changes.
- `seeds/` — starter data for the receptionist, billing and nurse pages.

Changes to these files do not automatically update Supabase. Database changes must be applied separately.

schema.sql is a snapshot of the database structure currently hosted on Supabase. It contains the SQL definitions for all 38 tables, their relationships, and constraints, but does not contain actual patient or employee records.

Keeping a copy in Git allows us to track database changes, review modifications, and recreate the database structure if needed.

# Database

This folder has the SQL for the Medical Clinic database. The live PostgreSQL database is hosted on Supabase.

- `schema.sql` is a snapshot of the live database structure (all 46 tables with their relationships, constraints, triggers and trigger functions, no patient or employee records). It includes every migration through 021.
- `seed.sql` is for fictional sample data. It's empty right now.
- `migrations/` has the SQL scripts for database changes.

Editing these files doesn't change Supabase. Changes have to be applied there separately.

## Migrations

All migrations below are applied to the shared Supabase database. Don't run them there again.

| Migration | What it does |
| --- | --- |
| 001 `visit_reason` | Renames the visit summary's diagnosis column to `visit_reason` |
| 002 `visit_diagnosis` | Adds `visit_diagnosis` for the diagnoses a doctor records at a visit |
| 003 `appointment_history` | Records every new appointment and change in `appointment_history` (trigger) |
| 004 `employee_audit` | Records changes to an employee's status, type and office in `employee_audit` (trigger) |
| 005 `appointment_conflict_check` | Blocks double-booking a doctor or a patient (trigger) |
| 006 `shift_types` | Adds the Morning, Afternoon and Full Day shifts and their 30-minute time slots |
| 007 `patient_vitals_updates` | Adds recorded time, respiratory rate and oxygen level to vitals |
| 008 `lab_technician` | Adds the Lab Technician role and who entered each lab result |
| 009 `one_invoice_per_appointment` | Allows one invoice per appointment |
| 010 `nursing_note` | Adds `nursing_note` for nursing notes |
| 011 `billing_status` | Payment status, Void invoices, `billing_history`, and the rule that every billing change says who made it (triggers) |
| 012 `service_fees` | Adds `service_fee` and `invoice_item`; checking out creates an itemized invoice (triggers) |
| 013 `patient_payments` | Patients pay by card; verified insurance pays invoices automatically (trigger) |
| 014 `diagnosis_is_active` | Removed diagnoses stay as inactive |
| 015 `session` | Adds the `session` table for logins |
| 016 `phone_digits` | Phone numbers are exactly 10 digits |
| 017 `primary_doctor` | A patient's first completed primary care visit sets their primary doctor; one primary doctor per patient (trigger) |
| 018 `referral_and_payment_checks` | Specialist visits need an approved referral; payments can't go over the balance; Internal Medicine also counts as primary care (triggers) |
| 019 `referral_primary_approval` | Referrals need a reason and are approved or denied (with a reason) by the patient's primary doctor (trigger) |
| 020 `one_vitals_per_visit` | Each visit has at most one vitals row; saving again updates it |
| 021 `follow_up_lab_billing` | A lab test ordered after a visit's invoice is paid is added to it, reopening it as Pending with the new balance (trigger) |

## Triggers

The database has 16 triggers:

| Table | Trigger | What it enforces |
| --- | --- | --- |
| `appointment` | `appointment_conflict_trigger` | No overlapping appointments for the same doctor or patient |
| `appointment` | `appointment_history_trigger` | Records every new appointment and change, and who made it |
| `appointment` | `appointment_invoice_trigger` | Checking out creates the visit's invoice |
| `appointment` | `appointment_primary_doctor_trigger` | First completed Family or Internal Medicine visit sets the primary doctor |
| `appointment` | `appointment_referral_check_trigger` | Specialist visits must use an approved referral, valid on the visit date |
| `employee` | `employee_audit_trigger` | Records changes to an employee's status, type and office |
| `invoice` | `invoice_check_trigger` | Invoices can't be deleted or changed once Void, and every change says who made it |
| `invoice` | `invoice_history_trigger` | Records invoice status changes in `billing_history` |
| `invoice_item` | `invoice_item_total_trigger` | Keeps the invoice total equal to its lines, then lets insurance pay |
| `lab_order` | `lab_order_billing_trigger` | Adds lab tests to the visit's invoice, reopening it if it was paid; removes cancelled ones from an unpaid invoice |
| `prescription_item` | `prescription_item_billing_trigger` | Adds or removes medications on the visit's unpaid invoice |
| `payment` | `payment_check_trigger` | Payments can't be deleted; refund steps happen in order; patients only pay their own invoices by card |
| `payment` | `payment_history_trigger` | Records payment changes and keeps the invoice Paid or Pending |
| `payment` | `payment_amount_check_trigger` | A payment can't be more than what's still owed |
| `insurance` | `insurance_verified_trigger` | Verifying insurance pays the patient's unpaid invoices |
| `referral` | `referral_check_trigger` | Referrals need a reason, go to the primary doctor, and only that doctor approves or denies (denials need a reason) |

Appointments whose time passes without a check-in become No Show automatically, but that's done by the backend (`src/middleware/markNoShows.ts`), not a trigger, because a trigger can't run on a timer.

## Adding a migration

1. Put it in `migrations/` with the next number, like `020_name.sql`, starting with a one or two line comment about what it does.
2. Never edit a migration that's already applied. Write a new one that changes it.
3. Have it reviewed, then run it once in the Supabase SQL editor.
4. Billing changes in SQL (seeds or fixes) must say who made them: `SELECT set_config('app.employee_id', '1017', true);` first, inside the same transaction.
5. Until `schema.sql` is refreshed from Supabase, add the file name to `pendingMigrations` in `tests/helpers/testDb.ts` so the tests apply it.

`schema.sql` is exported without privileges. If you ever build a new Supabase project from it, also run the revoke steps from the migrations that create tables (003, 004, 010, 011, 012, 015), which remove the default API access.

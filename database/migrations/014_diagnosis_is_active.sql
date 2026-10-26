-- lets a doctor remove a diagnosis added by mistake
-- removed diagnoses stay in the table as inactive, like allergies and home medications
-- waiting for review, so it hasn't been run on Supabase yet

BEGIN;

ALTER TABLE public.visit_diagnosis ADD COLUMN is_active boolean NOT NULL DEFAULT true;

COMMIT;

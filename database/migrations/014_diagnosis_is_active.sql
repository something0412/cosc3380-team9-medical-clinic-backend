-- visit_diagnosis.is_active: removed diagnoses stay in the table as inactive

BEGIN;

ALTER TABLE public.visit_diagnosis ADD COLUMN is_active boolean NOT NULL DEFAULT true;

COMMIT;

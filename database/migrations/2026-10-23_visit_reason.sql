-- appointment_summary: rename diagnosis to visit_reason
-- it holds why the patient came in (e.g. Routine checkup); diagnoses are in visit_diagnosis
-- run once in the Supabase SQL editor, then pull the code that uses visit_reason

BEGIN;

ALTER TABLE appointment_summary RENAME COLUMN diagnosis TO visit_reason;

COMMIT;

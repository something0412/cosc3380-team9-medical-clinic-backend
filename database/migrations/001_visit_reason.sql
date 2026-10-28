-- appointment_summary: rename diagnosis to visit_reason (why the patient came in)

BEGIN;

ALTER TABLE appointment_summary RENAME COLUMN diagnosis TO visit_reason;

COMMIT;

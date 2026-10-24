-- allow at most one invoice for each appointment
-- waiting for review, so it hasn't been run on Supabase yet

BEGIN;

-- stop without changing anything if some appointment already has two invoices
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM invoice GROUP BY appointment_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Some appointments already have more than one invoice';
  END IF;
END $$;

ALTER TABLE invoice ADD CONSTRAINT invoice_appointment_id_key UNIQUE (appointment_id);

COMMIT;

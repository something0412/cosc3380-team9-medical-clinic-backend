-- at most one invoice per appointment

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM invoice GROUP BY appointment_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Some appointments already have more than one invoice';
  END IF;
END $$;

ALTER TABLE invoice ADD CONSTRAINT invoice_appointment_id_key UNIQUE (appointment_id);

COMMIT;

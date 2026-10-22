-- The one schema change the app needs (agreed by the team): when a patient
-- checked in and out. Nothing is dropped or renamed; existing rows get
-- NULL in both columns. Run once, after loading the schema.
--
-- The waiting room is derived from these plus appointment_summary:
--   checked_in_at IS NULL                        -> expected
--   checked_in_at set, no appointment_summary    -> waiting
--   appointment_summary exists, not checked out  -> with nurse
--   checked_out_at set (status 'Completed')      -> done
ALTER TABLE public.appointment
    ADD COLUMN checked_in_at timestamp with time zone,
    ADD COLUMN checked_out_at timestamp with time zone,
    ADD CONSTRAINT chk_appointment_check_out CHECK (
        checked_out_at IS NULL OR (checked_in_at IS NOT NULL AND checked_out_at >= checked_in_at)
    );

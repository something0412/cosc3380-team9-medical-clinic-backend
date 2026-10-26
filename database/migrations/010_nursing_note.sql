-- nursing notes for a visit, kept apart from the doctor's visit summary so neither overwrites the other
-- waiting for review, so it hasn't been run on Supabase yet

BEGIN;

CREATE TABLE public.nursing_note (
    nursing_note_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    appointment_id integer NOT NULL REFERENCES public.appointment(appointment_id) ON DELETE RESTRICT,
    recorded_by_employee_id integer NOT NULL REFERENCES public.employee(employee_id) ON DELETE RESTRICT,
    note text NOT NULL CHECK (btrim(note) <> ''),
    recorded_at timestamp NOT NULL,
    updated_at timestamp
);

CREATE INDEX idx_nursing_note_appointment ON public.nursing_note (appointment_id);

-- like every other table, so Supabase's public API roles can't read or change it
ALTER TABLE public.nursing_note ENABLE ROW LEVEL SECURITY;

-- Supabase also grants those roles access to new tables, so take it back.
-- The loop skips roles that only exist on Supabase.
DO $$
DECLARE
    api_role text;
BEGIN
    FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
        EXECUTE format('REVOKE ALL ON public.nursing_note FROM %I', api_role);
    END LOOP;
END;
$$;

COMMIT;

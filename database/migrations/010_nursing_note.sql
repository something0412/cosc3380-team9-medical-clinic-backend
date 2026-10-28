-- nursing_note: nurses' notes for a visit, kept apart from the doctor's visit summary

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

ALTER TABLE public.nursing_note ENABLE ROW LEVEL SECURITY;

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

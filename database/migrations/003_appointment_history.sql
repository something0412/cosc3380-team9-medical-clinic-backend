-- appointment_history: a trigger records new appointments and changes to status, date, time slot or doctor

BEGIN;

CREATE TABLE IF NOT EXISTS public.appointment_history (
    history_id integer GENERATED ALWAYS AS IDENTITY,
    appointment_id integer NOT NULL,
    operation character varying(6) NOT NULL,
    old_status character varying(20),
    new_status character varying(20) NOT NULL,
    old_appointment_date date,
    new_appointment_date date NOT NULL,
    old_time_slot_id integer,
    new_time_slot_id integer NOT NULL,
    old_doctor_id integer,
    new_doctor_id integer NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT appointment_history_pkey PRIMARY KEY (history_id),
    CONSTRAINT chk_appointment_history_operation CHECK (((operation)::text = ANY ((ARRAY['INSERT'::character varying, 'UPDATE'::character varying])::text[])))
);

CREATE INDEX IF NOT EXISTS idx_appointment_history_appointment ON public.appointment_history (appointment_id, changed_at);

ALTER TABLE public.appointment_history ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role text;
BEGIN
    FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
        EXECUTE format('REVOKE ALL ON public.appointment_history FROM %I', api_role);
    END LOOP;
END;
$$;

-- skips updates that don't change a tracked column
CREATE OR REPLACE FUNCTION public.record_appointment_history() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.status IS NOT DISTINCT FROM NEW.status
       AND OLD.appointment_date IS NOT DISTINCT FROM NEW.appointment_date
       AND OLD.time_slot_id IS NOT DISTINCT FROM NEW.time_slot_id
       AND OLD.doctor_id IS NOT DISTINCT FROM NEW.doctor_id THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.appointment_history (
        appointment_id, operation,
        old_status, new_status,
        old_appointment_date, new_appointment_date,
        old_time_slot_id, new_time_slot_id,
        old_doctor_id, new_doctor_id
    )
    VALUES (
        NEW.appointment_id, TG_OP,
        OLD.status, NEW.status,
        OLD.appointment_date, NEW.appointment_date,
        OLD.time_slot_id, NEW.time_slot_id,
        OLD.doctor_id, NEW.doctor_id
    );

    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER appointment_history_trigger
    AFTER INSERT OR UPDATE ON public.appointment
    FOR EACH ROW EXECUTE FUNCTION public.record_appointment_history();

COMMIT;

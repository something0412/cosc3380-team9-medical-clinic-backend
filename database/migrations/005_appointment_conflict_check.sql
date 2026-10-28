-- trigger that rejects an appointment overlapping another active one for the same doctor or patient

BEGIN;

-- skips cancelled and status-only changes; locks per doctor and patient so two bookings can't both pass
CREATE OR REPLACE FUNCTION public.check_appointment_conflict() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    slot_start time;
    slot_end time;
BEGIN
    IF NEW.status = 'Cancelled' THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.status <> 'Cancelled'
       AND OLD.doctor_id = NEW.doctor_id
       AND OLD.patient_id = NEW.patient_id
       AND OLD.appointment_date = NEW.appointment_date
       AND OLD.time_slot_id = NEW.time_slot_id THEN
        RETURN NEW;
    END IF;

    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Appointments must be written in a read committed transaction';
    END IF;

    PERFORM pg_advisory_xact_lock(33801, NEW.doctor_id);
    PERFORM pg_advisory_xact_lock(33802, NEW.patient_id);

    SELECT start_time, end_time INTO slot_start, slot_end
    FROM public.time_slot
    WHERE time_slot_id = NEW.time_slot_id;

    IF EXISTS (
        SELECT 1
        FROM public.appointment a
        JOIN public.time_slot t ON t.time_slot_id = a.time_slot_id
        WHERE a.appointment_id <> NEW.appointment_id
          AND a.doctor_id = NEW.doctor_id
          AND a.appointment_date = NEW.appointment_date
          AND a.status <> 'Cancelled'
          AND t.start_time < slot_end
          AND t.end_time > slot_start
    ) THEN
        RAISE EXCEPTION 'The doctor already has an appointment at that time'
            USING ERRCODE = 'exclusion_violation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.appointment a
        JOIN public.time_slot t ON t.time_slot_id = a.time_slot_id
        WHERE a.appointment_id <> NEW.appointment_id
          AND a.patient_id = NEW.patient_id
          AND a.appointment_date = NEW.appointment_date
          AND a.status <> 'Cancelled'
          AND t.start_time < slot_end
          AND t.end_time > slot_start
    ) THEN
        RAISE EXCEPTION 'The patient already has an appointment at that time'
            USING ERRCODE = 'exclusion_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER appointment_conflict_trigger
    BEFORE INSERT OR UPDATE ON public.appointment
    FOR EACH ROW EXECUTE FUNCTION public.check_appointment_conflict();

COMMIT;

-- primary doctor: a patient's first completed Family Medicine visit makes that doctor their primary doctor
-- one active primary doctor per patient; the admin can change it in the app

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM patient_doctor WHERE is_primary AND is_active GROUP BY patient_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Some patients already have more than one primary doctor';
  END IF;
END $$;

CREATE UNIQUE INDEX patient_doctor_one_primary ON public.patient_doctor (patient_id) WHERE is_primary AND is_active;

-- runs at check out; skips patients who already have a primary doctor
CREATE OR REPLACE FUNCTION public.assign_primary_doctor() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NEW.status <> 'Completed' OR OLD.status = 'Completed' THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.specialty WHERE specialty_id = NEW.specialty_id AND name = 'Family Medicine') THEN
        RETURN NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM public.patient_doctor WHERE patient_id = NEW.patient_id AND is_primary AND is_active) THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.patient_doctor (patient_id, doctor_id, is_primary, assigned_date, is_active)
    VALUES (NEW.patient_id, NEW.doctor_id, true, (now() AT TIME ZONE 'America/Chicago')::date, true)
    ON CONFLICT (patient_id, doctor_id) DO UPDATE SET is_primary = true, is_active = true, assigned_date = EXCLUDED.assigned_date;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER appointment_primary_doctor_trigger
    AFTER UPDATE OF status ON public.appointment
    FOR EACH ROW EXECUTE FUNCTION public.assign_primary_doctor();

INSERT INTO public.patient_doctor (patient_id, doctor_id, is_primary, assigned_date, is_active)
SELECT DISTINCT ON (a.patient_id) a.patient_id, a.doctor_id, true, a.appointment_date, true
FROM public.appointment a
JOIN public.specialty s ON s.specialty_id = a.specialty_id
WHERE a.status = 'Completed' AND s.name = 'Family Medicine'
  AND NOT EXISTS (SELECT 1 FROM public.patient_doctor pd WHERE pd.patient_id = a.patient_id AND pd.is_primary AND pd.is_active)
ORDER BY a.patient_id, a.appointment_date, a.appointment_id
ON CONFLICT (patient_id, doctor_id) DO UPDATE SET is_primary = true, is_active = true, assigned_date = EXCLUDED.assigned_date;

COMMIT;

-- referrals are approved or denied by the patient's primary doctor instead of the specialist
-- a referral needs a request reason, and a denial needs a reason

BEGIN;

ALTER TABLE public.referral
  ADD COLUMN primary_doctor_id integer REFERENCES public.doctor(employee_id) ON DELETE RESTRICT,
  ADD COLUMN request_reason text,
  ADD COLUMN denial_reason text,
  ADD COLUMN decided_at timestamp with time zone;

UPDATE public.referral r
SET primary_doctor_id = pd.doctor_id
FROM public.patient_doctor pd
WHERE r.status = 'Pending' AND pd.patient_id = r.patient_id AND pd.is_primary AND pd.is_active;

-- new referrals go to the patient's primary doctor with a reason; only that doctor decides, once, before it expires
CREATE OR REPLACE FUNCTION public.check_referral() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    acting_doctor integer := NULLIF(current_setting('app.employee_id', true), '')::integer;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF acting_doctor IS DISTINCT FROM NEW.referring_doctor_id THEN
            RAISE EXCEPTION 'Referrals must be sent by the referring doctor';
        END IF;
        IF btrim(COALESCE(NEW.request_reason, '')) = '' THEN
            RAISE EXCEPTION 'A referral needs a reason';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.patient_doctor WHERE patient_id = NEW.patient_id AND doctor_id = NEW.primary_doctor_id AND is_primary AND is_active) THEN
            RAISE EXCEPTION 'The referral must go to the patient''s primary doctor';
        END IF;
        IF NEW.status = 'Approved' AND NEW.referring_doctor_id = NEW.primary_doctor_id THEN
            NEW.decided_at := now();
        ELSIF NEW.status <> 'Pending' THEN
            RAISE EXCEPTION 'A new referral waits for the primary doctor';
        END IF;
        RETURN NEW;
    END IF;

    IF (NEW.patient_id, NEW.referring_doctor_id, NEW.primary_doctor_id, NEW.specialist_doctor_id, NEW.specialty_id, NEW.request_reason)
       IS DISTINCT FROM
       (OLD.patient_id, OLD.referring_doctor_id, OLD.primary_doctor_id, OLD.specialist_doctor_id, OLD.specialty_id, OLD.request_reason) THEN
        RAISE EXCEPTION 'A referral can''t be changed after it''s sent';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF OLD.status <> 'Pending' THEN
            RAISE EXCEPTION 'This referral was already decided';
        END IF;
        IF OLD.primary_doctor_id IS NULL OR acting_doctor IS DISTINCT FROM OLD.primary_doctor_id THEN
            RAISE EXCEPTION 'Only the patient''s primary doctor can approve or deny this referral';
        END IF;
        IF OLD.expiration_date < (now() AT TIME ZONE 'America/Chicago')::date THEN
            RAISE EXCEPTION 'This referral has expired';
        END IF;
        IF NEW.status = 'Denied' AND btrim(COALESCE(NEW.denial_reason, '')) = '' THEN
            RAISE EXCEPTION 'A denial needs a reason';
        END IF;
        NEW.decided_at := now();
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER referral_check_trigger
    BEFORE INSERT OR UPDATE ON public.referral
    FOR EACH ROW EXECUTE FUNCTION public.check_referral();

COMMIT;

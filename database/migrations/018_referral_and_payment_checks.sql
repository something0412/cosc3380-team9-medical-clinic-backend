-- specialist visits need an approved referral, and payments can't go over what's owed
-- also counts Internal Medicine as primary care for the automatic primary doctor

BEGIN;

-- a specialist visit must use an approved referral for that patient, specialist and specialty, valid on the visit date
CREATE OR REPLACE FUNCTION public.check_appointment_referral() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NEW.status = 'Cancelled' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND OLD.status <> 'Cancelled'
       AND OLD.doctor_id = NEW.doctor_id
       AND OLD.patient_id = NEW.patient_id
       AND OLD.specialty_id = NEW.specialty_id
       AND OLD.appointment_date = NEW.appointment_date
       AND OLD.referral_id IS NOT DISTINCT FROM NEW.referral_id THEN
        RETURN NEW;
    END IF;

    IF EXISTS (SELECT 1 FROM public.specialty WHERE specialty_id = NEW.specialty_id AND requires_referral)
       AND NOT EXISTS (
           SELECT 1 FROM public.referral r
           WHERE r.referral_id = NEW.referral_id
             AND r.status = 'Approved'
             AND r.patient_id = NEW.patient_id
             AND r.specialist_doctor_id = NEW.doctor_id
             AND r.specialty_id = NEW.specialty_id
             AND NEW.appointment_date BETWEEN r.date_issued AND r.expiration_date
       ) THEN
        RAISE EXCEPTION 'This specialist visit needs an approved referral for this patient, doctor and date';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER appointment_referral_check_trigger
    BEFORE INSERT OR UPDATE ON public.appointment
    FOR EACH ROW EXECUTE FUNCTION public.check_appointment_referral();

-- a payment can't be more than what's still owed on the invoice
CREATE OR REPLACE FUNCTION public.check_payment_amount() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    total numeric;
    paid numeric;
BEGIN
    SELECT amount INTO total FROM public.invoice WHERE invoice_id = NEW.invoice_id FOR UPDATE;
    SELECT COALESCE(sum(amount_paid), 0) INTO paid FROM public.payment WHERE invoice_id = NEW.invoice_id AND status <> 'Refunded';
    IF NEW.amount_paid > total - paid THEN
        RAISE EXCEPTION 'Only $% is left on this invoice', to_char(GREATEST(total - paid, 0), 'FM999999990.00');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER payment_amount_check_trigger
    BEFORE INSERT ON public.payment
    FOR EACH ROW EXECUTE FUNCTION public.check_payment_amount();

-- runs at check out; Family Medicine and Internal Medicine both count as primary care
CREATE OR REPLACE FUNCTION public.assign_primary_doctor() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NEW.status <> 'Completed' OR OLD.status = 'Completed' THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.specialty WHERE specialty_id = NEW.specialty_id AND name IN ('Family Medicine', 'Internal Medicine')) THEN
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

INSERT INTO public.patient_doctor (patient_id, doctor_id, is_primary, assigned_date, is_active)
SELECT DISTINCT ON (a.patient_id) a.patient_id, a.doctor_id, true, a.appointment_date, true
FROM public.appointment a
JOIN public.specialty s ON s.specialty_id = a.specialty_id
WHERE a.status = 'Completed' AND s.name IN ('Family Medicine', 'Internal Medicine')
  AND NOT EXISTS (SELECT 1 FROM public.patient_doctor pd WHERE pd.patient_id = a.patient_id AND pd.is_primary AND pd.is_active)
ORDER BY a.patient_id, a.appointment_date, a.appointment_id
ON CONFLICT (patient_id, doctor_id) DO UPDATE SET is_primary = true, is_active = true, assigned_date = EXCLUDED.assigned_date;

COMMIT;

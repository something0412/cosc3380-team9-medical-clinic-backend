-- a doctor with any Scheduled appointment can't be deactivated,
-- and a missed appointment gets an invoice with a $25 no-show fee

BEGIN;

-- a doctor with any Scheduled appointment can't be deactivated
CREATE OR REPLACE FUNCTION public.check_doctor_deactivation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
    -- past Scheduled ones count too, since they're about to become No Show and be billed under this doctor
    IF OLD.is_active AND NOT NEW.is_active AND EXISTS (
        SELECT 1 FROM public.appointment
        WHERE doctor_id = NEW.employee_id
          AND status = 'Scheduled'
    ) THEN
        RAISE EXCEPTION 'This doctor still has upcoming appointments. Reschedule or cancel them first.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER employee_deactivation_check_trigger
BEFORE UPDATE OF is_active ON public.employee
FOR EACH ROW EXECUTE FUNCTION public.check_doctor_deactivation();

-- invoice lines can now be a No Show charge too
ALTER TABLE public.invoice_item DROP CONSTRAINT chk_invoice_item_category;
ALTER TABLE public.invoice_item ADD CONSTRAINT chk_invoice_item_category
    CHECK (category IN ('Visit', 'Lab Test', 'Medication', 'No Show'));

-- a missed appointment gets an invoice with a no-show fee
CREATE OR REPLACE FUNCTION public.no_show_fee() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
    new_invoice integer;
    no_employee boolean := COALESCE(current_setting('app.employee_id', true), '') = '';
    old_reason text := current_setting('app.reason', true);
BEGIN
    -- only when the appointment just became No Show
    IF NEW.status <> 'No Show' OR OLD.status = 'No Show' THEN
        RETURN NULL;
    END IF;

    -- the automatic no show job has no employee, so the fee is recorded under the doctor
    IF no_employee THEN
        PERFORM set_config('app.employee_id', NEW.doctor_id::text, true);
    END IF;
    PERFORM set_config('app.reason', 'No-show fee', true);

    INSERT INTO public.invoice (patient_id, appointment_id, amount, issue_date, status)
    VALUES (NEW.patient_id, NEW.appointment_id, 0, NEW.appointment_date, 'Pending')
    RETURNING invoice_id INTO new_invoice;

    -- the invoice total trigger turns the amount into $25
    INSERT INTO public.invoice_item (invoice_id, category, description, price)
    VALUES (new_invoice, 'No Show', 'Missed appointment fee', 25.00);

    -- put things back for the next appointment in the same update
    IF no_employee THEN
        PERFORM set_config('app.employee_id', '', true);
    END IF;
    PERFORM set_config('app.reason', COALESCE(old_reason, ''), true);
    RETURN NULL;
END;
$$;

CREATE TRIGGER appointment_no_show_fee_trigger
AFTER UPDATE OF status ON public.appointment
FOR EACH ROW EXECUTE FUNCTION public.no_show_fee();

COMMIT;

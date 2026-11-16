-- the no-show fee is a price in service_fee that admins can change or turn off,
-- and the no-show trigger bills whatever it is set to

BEGIN;

-- a No Show price isn't linked to a specialty, lab test or medication
ALTER TABLE public.service_fee DROP CONSTRAINT chk_service_fee_category;
ALTER TABLE public.service_fee ADD CONSTRAINT chk_service_fee_category
    CHECK (category IN ('Visit', 'Lab Test', 'Medication', 'No Show'));

ALTER TABLE public.service_fee DROP CONSTRAINT chk_service_fee_link;
ALTER TABLE public.service_fee ADD CONSTRAINT chk_service_fee_link CHECK (
    (category = 'Visit' AND specialty_id IS NOT NULL AND lab_test_type_id IS NULL AND medication_id IS NULL)
    OR (category = 'Lab Test' AND lab_test_type_id IS NOT NULL AND specialty_id IS NULL AND medication_id IS NULL)
    OR (category = 'Medication' AND medication_id IS NOT NULL AND specialty_id IS NULL AND lab_test_type_id IS NULL)
    OR (category = 'No Show' AND specialty_id IS NULL AND lab_test_type_id IS NULL AND medication_id IS NULL)
);

-- only one no-show price
CREATE UNIQUE INDEX service_fee_one_no_show ON public.service_fee USING btree (category) WHERE ((category)::text = 'No Show'::text);

-- starts at the $25 the trigger used to bill
INSERT INTO public.service_fee (category, name, price) VALUES ('No Show', 'No-show fee', 25.00);

-- a missed appointment gets an invoice with the no-show fee
CREATE OR REPLACE FUNCTION public.no_show_fee() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
    fee record;
    new_invoice integer;
    no_employee boolean := COALESCE(current_setting('app.employee_id', true), '') = '';
    old_reason text := current_setting('app.reason', true);
BEGIN
    -- only when the appointment just became No Show
    IF NEW.status <> 'No Show' OR OLD.status = 'No Show' THEN
        RETURN NULL;
    END IF;

    -- the price the admin set (nothing is billed while it's off or $0)
    SELECT fee_id, name, price INTO fee FROM public.service_fee WHERE category = 'No Show' AND is_active;
    IF fee IS NULL OR fee.price <= 0 THEN
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

    -- the invoice total trigger turns the amount into the fee
    INSERT INTO public.invoice_item (invoice_id, fee_id, category, description, price)
    VALUES (new_invoice, fee.fee_id, 'No Show', fee.name, fee.price);

    -- put things back for the next appointment in the same update
    IF no_employee THEN
        PERFORM set_config('app.employee_id', '', true);
    END IF;
    PERFORM set_config('app.reason', COALESCE(old_reason, ''), true);
    RETURN NULL;
END;
$$;

COMMIT;

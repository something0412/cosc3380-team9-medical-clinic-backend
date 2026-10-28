-- patients pay their own invoices by card (app.patient_id), and verified insurance pays invoices automatically
-- needs 011 and 012

BEGIN;

SELECT set_config('app.employee_id', '1017', true);

ALTER TABLE public.billing_history ALTER COLUMN changed_by DROP NOT NULL;
ALTER TABLE public.billing_history ADD COLUMN changed_by_patient integer;
ALTER TABLE public.billing_history ADD CONSTRAINT chk_billing_history_who
  CHECK (changed_by IS NOT NULL OR changed_by_patient IS NOT NULL);

-- the patient paying in the portal, or null
CREATE OR REPLACE FUNCTION public.billing_patient_id() RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    value text := current_setting('app.patient_id', true);
BEGIN
    IF value IS NULL OR value !~ '^[0-9]+$' THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.patient WHERE patient_id = value::integer AND is_active) THEN
        RAISE EXCEPTION 'Patient % is not an active patient', value;
    END IF;
    RETURN value::integer;
END;
$$;

-- the employee making the change, null when a patient is paying; refuses when it's neither
CREATE OR REPLACE FUNCTION public.billing_employee_id() RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    value text := current_setting('app.employee_id', true);
BEGIN
    IF value IS NULL OR value = '' THEN
        IF public.billing_patient_id() IS NOT NULL THEN
            RETURN NULL;
        END IF;
        RAISE EXCEPTION 'Billing changes need the employee who made them. Run SELECT set_config(''app.employee_id'', ''<employee id>'', true) first.';
    END IF;
    IF value !~ '^[0-9]+$' THEN
        RAISE EXCEPTION 'Billing changes need the employee who made them. Run SELECT set_config(''app.employee_id'', ''<employee id>'', true) first.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.employee WHERE employee_id = value::integer AND is_active) THEN
        RAISE EXCEPTION 'Employee % is not an active employee', value;
    END IF;
    RETURN value::integer;
END;
$$;

-- a patient can only pay their own invoice; staff rules stay the same
CREATE OR REPLACE FUNCTION public.check_invoice_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF public.billing_employee_id() IS NULL THEN
        IF TG_OP <> 'UPDATE' OR NEW.patient_id <> public.billing_patient_id() OR NEW.amount <> OLD.amount
           OR NEW.status NOT IN ('Pending', 'Overdue', 'Paid') OR OLD.status = 'Void' THEN
            RAISE EXCEPTION 'Patients can only pay their own invoices';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Invoices can''t be deleted. Void them instead.';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'Void' THEN
            RAISE EXCEPTION 'A new invoice can''t start as Void';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'Void' THEN
        RAISE EXCEPTION 'Invoice % is void and can''t be changed', OLD.invoice_id;
    END IF;
    IF NEW.status = 'Void' AND EXISTS (
        SELECT 1 FROM public.payment WHERE invoice_id = NEW.invoice_id AND status IN ('Completed', 'Requested')
    ) THEN
        RAISE EXCEPTION 'Refund every payment on invoice % before voiding it', NEW.invoice_id;
    END IF;
    RETURN NEW;
END;
$$;

-- records the change by the employee or the patient
CREATE OR REPLACE FUNCTION public.record_invoice_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    employee integer := public.billing_employee_id();
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.billing_history (invoice_id, payment_id, old_status, new_status, changed_by, changed_by_patient, reason)
    VALUES (
        NEW.invoice_id, NULL,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
        employee, CASE WHEN employee IS NULL THEN public.billing_patient_id() END,
        NULLIF(current_setting('app.reason', true), '')
    );
    RETURN NULL;
END;
$$;

-- a patient can only add a card payment to their own invoice; staff rules stay the same
CREATE OR REPLACE FUNCTION public.check_payment_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF public.billing_employee_id() IS NULL THEN
        IF TG_OP <> 'INSERT' OR NEW.status <> 'Completed' OR NEW.handled_by IS NOT NULL
           OR NOT EXISTS (SELECT 1 FROM public.invoice WHERE invoice_id = NEW.invoice_id AND patient_id = public.billing_patient_id() AND status <> 'Void')
           OR NOT EXISTS (SELECT 1 FROM public.payment_type WHERE payment_type_id = NEW.payment_type_id AND name IN ('Credit Card', 'Debit Card')) THEN
            RAISE EXCEPTION 'Patients can only pay their own invoices by card';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Payments can''t be deleted. Refund them instead.';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'Completed' THEN
            RAISE EXCEPTION 'A new payment must be Completed';
        END IF;
        IF EXISTS (SELECT 1 FROM public.invoice WHERE invoice_id = NEW.invoice_id AND status = 'Void') THEN
            RAISE EXCEPTION 'Invoice % is void and can''t take payments', NEW.invoice_id;
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid THEN
        RAISE EXCEPTION 'A payment''s invoice and amount can''t be changed. Refund it instead.';
    END IF;
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;
    IF NOT (
        (OLD.status = 'Completed' AND NEW.status = 'Requested')
        OR (OLD.status = 'Requested' AND NEW.status IN ('Completed', 'Refunded'))
    ) THEN
        RAISE EXCEPTION 'A payment can''t go from % to %', OLD.status, NEW.status;
    END IF;
    RETURN NEW;
END;
$$;

-- records the change, then sets the invoice Paid or Pending
CREATE OR REPLACE FUNCTION public.record_payment_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    employee integer := public.billing_employee_id();
    invoice_amount numeric;
    invoice_status text;
    still_paid numeric;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.billing_history (invoice_id, payment_id, old_status, new_status, changed_by, changed_by_patient, reason)
    VALUES (
        NEW.invoice_id, NEW.payment_id,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
        employee, CASE WHEN employee IS NULL THEN public.billing_patient_id() END,
        NULLIF(current_setting('app.reason', true), '')
    );

    SELECT amount, status INTO invoice_amount, invoice_status FROM public.invoice WHERE invoice_id = NEW.invoice_id;
    SELECT COALESCE(sum(amount_paid), 0) INTO still_paid
    FROM public.payment WHERE invoice_id = NEW.invoice_id AND status <> 'Refunded';

    IF invoice_status IN ('Pending', 'Overdue') AND still_paid >= invoice_amount THEN
        UPDATE public.invoice SET status = 'Paid' WHERE invoice_id = NEW.invoice_id;
    ELSIF invoice_status = 'Paid' AND still_paid < invoice_amount THEN
        UPDATE public.invoice SET status = 'Pending' WHERE invoice_id = NEW.invoice_id;
    END IF;
    RETURN NULL;
END;
$$;

-- pays what's left on an invoice when the patient's insurance is verified
CREATE OR REPLACE FUNCTION public.pay_with_insurance(target_invoice integer) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    bill record;
    plan record;
    owed numeric;
    insurance_type integer;
    old_reason text := current_setting('app.reason', true);
BEGIN
    SELECT invoice_id, patient_id, amount, status INTO bill FROM public.invoice WHERE invoice_id = target_invoice;
    IF bill IS NULL OR bill.status = 'Void' THEN
        RETURN;
    END IF;
    SELECT provider, status INTO plan FROM public.insurance WHERE patient_id = bill.patient_id;
    IF plan IS NULL OR plan.status <> 'Verified' THEN
        RETURN;
    END IF;
    SELECT bill.amount - COALESCE(sum(amount_paid), 0) INTO owed
    FROM public.payment WHERE invoice_id = target_invoice AND status <> 'Refunded';
    SELECT payment_type_id INTO insurance_type FROM public.payment_type WHERE name = 'Insurance' AND is_active;
    IF owed <= 0 OR insurance_type IS NULL THEN
        RETURN;
    END IF;

    PERFORM set_config('app.reason', 'Paid by insurance: ' || plan.provider, true);
    INSERT INTO public.payment (invoice_id, payment_type_id, handled_by, amount_paid, payment_date, status)
    VALUES (target_invoice, insurance_type, NULL, owed, (now() AT TIME ZONE 'America/Chicago')::date, 'Completed');
    PERFORM set_config('app.reason', COALESCE(old_reason, ''), true);
END;
$$;

-- updates the total, then lets insurance pay the rest
CREATE OR REPLACE FUNCTION public.invoice_item_changed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    target integer := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
BEGIN
    PERFORM public.refresh_invoice_total(target);
    PERFORM public.pay_with_insurance(target);
    RETURN NULL;
END;
$$;

-- the visit's invoice new charges can go on: unpaid, or paid only by insurance
CREATE OR REPLACE FUNCTION public.billable_visit_invoice(visit integer) RETURNS integer
LANGUAGE sql
SET search_path = ''
AS $$
    SELECT i.invoice_id FROM public.invoice i
    WHERE i.appointment_id = visit AND i.status <> 'Void'
      AND (i.status IN ('Pending', 'Overdue') OR NOT EXISTS (
          SELECT 1 FROM public.payment p JOIN public.payment_type t ON t.payment_type_id = p.payment_type_id
          WHERE p.invoice_id = i.invoice_id AND p.status <> 'Refunded' AND t.name <> 'Insurance'
      ))
    LIMIT 1;
$$;

-- lab tests: added to an unpaid or insurance-paid invoice, taken off only while unpaid
CREATE OR REPLACE FUNCTION public.lab_order_billing() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    open_invoice integer;
BEGIN
    IF NEW.appointment_id IS NULL THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'INSERT' AND NEW.status <> 'Cancelled' THEN
        open_invoice := public.billable_visit_invoice(NEW.appointment_id);
        IF open_invoice IS NOT NULL THEN
            PERFORM public.add_lab_order_line(open_invoice, NEW.lab_order_id);
        END IF;
    ELSIF TG_OP = 'UPDATE' AND NEW.status = 'Cancelled' AND OLD.status <> 'Cancelled' THEN
        open_invoice := public.unpaid_visit_invoice(NEW.appointment_id);
        IF open_invoice IS NOT NULL THEN
            DELETE FROM public.invoice_item WHERE invoice_id = open_invoice AND lab_order_id = NEW.lab_order_id;
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

-- medications: same rules as lab tests
CREATE OR REPLACE FUNCTION public.prescription_item_billing() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    visit integer;
    open_invoice integer;
BEGIN
    SELECT appointment_id INTO visit FROM public.prescription WHERE prescription_id = NEW.prescription_id;
    IF visit IS NULL THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'INSERT' AND NEW.is_active THEN
        open_invoice := public.billable_visit_invoice(visit);
        IF open_invoice IS NOT NULL THEN
            PERFORM public.add_prescription_line(open_invoice, NEW.prescription_item_id);
        END IF;
    ELSIF TG_OP = 'UPDATE' AND OLD.is_active AND NOT NEW.is_active THEN
        open_invoice := public.unpaid_visit_invoice(visit);
        IF open_invoice IS NOT NULL THEN
            DELETE FROM public.invoice_item WHERE invoice_id = open_invoice AND prescription_item_id = NEW.prescription_item_id;
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

-- verifying insurance pays the patient's unpaid invoices
CREATE OR REPLACE FUNCTION public.insurance_verified() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    bill record;
BEGIN
    IF NEW.status <> 'Verified' OR (TG_OP = 'UPDATE' AND OLD.status = 'Verified') THEN
        RETURN NULL;
    END IF;
    FOR bill IN SELECT invoice_id FROM public.invoice WHERE patient_id = NEW.patient_id AND status IN ('Pending', 'Overdue') ORDER BY invoice_id LOOP
        PERFORM public.pay_with_insurance(bill.invoice_id);
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER insurance_verified_trigger
    AFTER INSERT OR UPDATE OF status ON public.insurance
    FOR EACH ROW EXECUTE FUNCTION public.insurance_verified();

DO $$
DECLARE
    bill record;
BEGIN
    FOR bill IN
        SELECT i.invoice_id FROM public.invoice i JOIN public.insurance s ON s.patient_id = i.patient_id
        WHERE s.status = 'Verified' AND i.status IN ('Pending', 'Overdue')
    LOOP
        PERFORM public.pay_with_insurance(bill.invoice_id);
    END LOOP;
END;
$$;

COMMIT;

-- billing: payment status (Completed / Requested / Refunded), Void invoices, and billing_history
-- every invoice or payment change must set app.employee_id in the same transaction (SQL editor fixes use 1017)

BEGIN;

ALTER TABLE public.invoice DROP CONSTRAINT chk_invoice_status;
ALTER TABLE public.invoice ADD CONSTRAINT chk_invoice_status
  CHECK (status IN ('Pending', 'Paid', 'Overdue', 'Void'));

ALTER TABLE public.invoice DROP CONSTRAINT IF EXISTS invoice_appointment_id_key;
CREATE UNIQUE INDEX invoice_one_per_appointment ON public.invoice (appointment_id) WHERE status <> 'Void';

ALTER TABLE public.payment ADD COLUMN status character varying(20) DEFAULT 'Completed' NOT NULL;
ALTER TABLE public.payment ADD CONSTRAINT chk_payment_status
  CHECK (status IN ('Completed', 'Requested', 'Refunded'));

CREATE TABLE public.billing_history (
    history_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id integer NOT NULL,
    payment_id integer,
    old_status character varying(20),
    new_status character varying(20) NOT NULL,
    changed_by integer NOT NULL,
    reason text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX idx_billing_history_invoice ON public.billing_history (invoice_id, changed_at);
CREATE INDEX idx_billing_history_payment ON public.billing_history (payment_id, changed_at);

ALTER TABLE public.billing_history ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role text;
BEGIN
    FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
        EXECUTE format('REVOKE ALL ON public.billing_history FROM %I', api_role);
    END LOOP;
END;
$$;

-- the employee making the change; refuses the change when there isn't one
CREATE OR REPLACE FUNCTION public.billing_employee_id() RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    value text := current_setting('app.employee_id', true);
BEGIN
    IF value IS NULL OR value !~ '^[0-9]+$' THEN
        RAISE EXCEPTION 'Billing changes need the employee who made them. Run SELECT set_config(''app.employee_id'', ''<employee id>'', true) first.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.employee WHERE employee_id = value::integer AND is_active) THEN
        RAISE EXCEPTION 'Employee % is not an active employee', value;
    END IF;
    RETURN value::integer;
END;
$$;

-- invoices can't be deleted or changed once Void, and are voided only after every refund
CREATE OR REPLACE FUNCTION public.check_invoice_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    PERFORM public.billing_employee_id();

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

CREATE OR REPLACE TRIGGER invoice_check_trigger
    BEFORE INSERT OR UPDATE OR DELETE ON public.invoice
    FOR EACH ROW EXECUTE FUNCTION public.check_invoice_change();

-- records new invoices and status changes
CREATE OR REPLACE FUNCTION public.record_invoice_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.billing_history (invoice_id, payment_id, old_status, new_status, changed_by, reason)
    VALUES (
        NEW.invoice_id, NULL,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
        public.billing_employee_id(), NULLIF(current_setting('app.reason', true), '')
    );
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER invoice_history_trigger
    AFTER INSERT OR UPDATE ON public.invoice
    FOR EACH ROW EXECUTE FUNCTION public.record_invoice_change();

-- payments go Completed -> Requested -> Completed or Refunded, and can't be deleted
CREATE OR REPLACE FUNCTION public.check_payment_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    PERFORM public.billing_employee_id();

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

CREATE OR REPLACE TRIGGER payment_check_trigger
    BEFORE INSERT OR UPDATE OR DELETE ON public.payment
    FOR EACH ROW EXECUTE FUNCTION public.check_payment_change();

-- records the change, then sets the invoice Paid or Pending to match what's still paid
CREATE OR REPLACE FUNCTION public.record_payment_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    invoice_amount numeric;
    invoice_status text;
    still_paid numeric;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.billing_history (invoice_id, payment_id, old_status, new_status, changed_by, reason)
    VALUES (
        NEW.invoice_id, NEW.payment_id,
        CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
        public.billing_employee_id(), NULLIF(current_setting('app.reason', true), '')
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

CREATE OR REPLACE TRIGGER payment_history_trigger
    AFTER INSERT OR UPDATE ON public.payment
    FOR EACH ROW EXECUTE FUNCTION public.record_payment_change();

ALTER TABLE public.appointment_history ADD COLUMN changed_by integer;
ALTER TABLE public.appointment_history ADD COLUMN checked_in_at timestamp with time zone;
ALTER TABLE public.appointment_history ADD COLUMN checked_out_at timestamp with time zone;

-- also records check in, check out and the employee who made the change
CREATE OR REPLACE FUNCTION public.record_appointment_history() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.status IS NOT DISTINCT FROM NEW.status
       AND OLD.appointment_date IS NOT DISTINCT FROM NEW.appointment_date
       AND OLD.time_slot_id IS NOT DISTINCT FROM NEW.time_slot_id
       AND OLD.doctor_id IS NOT DISTINCT FROM NEW.doctor_id
       AND OLD.checked_in_at IS NOT DISTINCT FROM NEW.checked_in_at
       AND OLD.checked_out_at IS NOT DISTINCT FROM NEW.checked_out_at THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.appointment_history (
        appointment_id, operation,
        old_status, new_status,
        old_appointment_date, new_appointment_date,
        old_time_slot_id, new_time_slot_id,
        old_doctor_id, new_doctor_id,
        checked_in_at, checked_out_at, changed_by
    )
    VALUES (
        NEW.appointment_id, TG_OP,
        OLD.status, NEW.status,
        OLD.appointment_date, NEW.appointment_date,
        OLD.time_slot_id, NEW.time_slot_id,
        OLD.doctor_id, NEW.doctor_id,
        NEW.checked_in_at, NEW.checked_out_at,
        NULLIF(current_setting('app.employee_id', true), '')::integer
    );

    RETURN NULL;
END;
$$;

COMMIT;

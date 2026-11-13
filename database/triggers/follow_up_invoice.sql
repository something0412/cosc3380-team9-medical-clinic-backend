-- a lab test ordered for a visit whose invoice is already paid is added to that invoice,
-- which reopens it as Pending with the new balance (the history records why)

BEGIN;

CREATE OR REPLACE FUNCTION public.lab_order_billing() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
    visit_invoice integer;
    old_reason text := current_setting('app.reason', true);
BEGIN
    IF NEW.appointment_id IS NULL THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'INSERT' AND NEW.status <> 'Cancelled' THEN
        -- any invoice for the visit that isn't void, paid or not
        SELECT invoice_id INTO visit_invoice FROM public.invoice
        WHERE appointment_id = NEW.appointment_id AND status <> 'Void'
        LIMIT 1;
        IF visit_invoice IS NOT NULL THEN
            -- if the new line reopens a paid invoice, the history says why
            PERFORM set_config('app.reason', 'Follow-up lab test added', true);
            PERFORM public.add_lab_order_line(visit_invoice, NEW.lab_order_id);
            PERFORM set_config('app.reason', COALESCE(old_reason, ''), true);
        END IF;
    ELSIF TG_OP = 'UPDATE' AND NEW.status = 'Cancelled' AND OLD.status <> 'Cancelled' THEN
        visit_invoice := public.unpaid_visit_invoice(NEW.appointment_id);
        IF visit_invoice IS NOT NULL THEN
            DELETE FROM public.invoice_item WHERE invoice_id = visit_invoice AND lab_order_id = NEW.lab_order_id;
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

COMMIT;

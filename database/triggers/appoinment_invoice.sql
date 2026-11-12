create or replace function public.invoice_completed_visit () RETURNS trigger LANGUAGE plpgsql
set
  search_path to '' as $function$
DECLARE
    new_invoice integer;
    order_row record;
    item_row record;
BEGIN
    IF NEW.status <> 'Completed' OR OLD.status = 'Completed' THEN
        RETURN NULL;
    END IF;
    -- a visit has at most one open invoice
    IF EXISTS (SELECT 1 FROM public.invoice WHERE appointment_id = NEW.appointment_id AND status <> 'Void') THEN
        RETURN NULL;
    END IF;

    -- create new invoice
    INSERT INTO public.invoice (patient_id, appointment_id, amount, issue_date, status)
    VALUES (NEW.patient_id, NEW.appointment_id, 0, (now() AT TIME ZONE 'America/Chicago')::date, 'Pending')
    RETURNING invoice_id INTO new_invoice;

    -- adding fees into invoice
    INSERT INTO public.invoice_item (invoice_id, fee_id, category, description, price)
    SELECT new_invoice, f.fee_id, 'Visit', f.name, f.price
    FROM public.service_fee f
    WHERE f.specialty_id = NEW.specialty_id AND f.is_active;

    --add lab order changes
    FOR order_row IN SELECT lab_order_id FROM public.lab_order WHERE appointment_id = NEW.appointment_id AND status <> 'Cancelled' LOOP
        PERFORM public.add_lab_order_line(new_invoice, order_row.lab_order_id);
    END LOOP;

    FOR item_row IN
        SELECT pi.prescription_item_id
        FROM public.prescription_item pi
        JOIN public.prescription rx ON rx.prescription_id = pi.prescription_id
        WHERE rx.appointment_id = NEW.appointment_id AND pi.is_active
    LOOP
        PERFORM public.add_prescription_line(new_invoice, item_row.prescription_item_id);
    END LOOP;

    RETURN NULL;
END;
$function$
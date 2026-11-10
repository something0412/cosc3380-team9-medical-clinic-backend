--
-- PostgreSQL database dump
--

\restrict clinicschema

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: add_lab_order_line(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_lab_order_line(target_invoice integer, order_id integer) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$
    INSERT INTO public.invoice_item (invoice_id, fee_id, category, description, price, lab_order_id)
    SELECT target_invoice, f.fee_id, 'Lab Test', f.name, f.price, l.lab_order_id
    FROM public.lab_order l
    JOIN public.service_fee f ON f.lab_test_type_id = l.lab_test_type_id AND f.is_active
    WHERE l.lab_order_id = order_id
    ON CONFLICT (lab_order_id) DO NOTHING;
$$;


--
-- Name: add_prescription_line(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_prescription_line(target_invoice integer, item_id integer) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$
    INSERT INTO public.invoice_item (invoice_id, fee_id, category, description, price, prescription_item_id)
    SELECT target_invoice, f.fee_id, 'Medication', f.name || ' (' || pi.dosage || ')', f.price, pi.prescription_item_id
    FROM public.prescription_item pi
    JOIN public.service_fee f ON f.medication_id = pi.medication_id AND f.is_active
    WHERE pi.prescription_item_id = item_id
    ON CONFLICT (prescription_item_id) DO NOTHING;
$$;


--
-- Name: assign_primary_doctor(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assign_primary_doctor() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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


--
-- Name: billable_visit_invoice(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billable_visit_invoice(visit integer) RETURNS integer
    LANGUAGE sql
    SET search_path TO ''
    AS $$
    SELECT i.invoice_id FROM public.invoice i
    WHERE i.appointment_id = visit AND i.status <> 'Void'
      AND (i.status IN ('Pending', 'Overdue') OR NOT EXISTS (
          SELECT 1 FROM public.payment p JOIN public.payment_type t ON t.payment_type_id = p.payment_type_id
          WHERE p.invoice_id = i.invoice_id AND p.status <> 'Refunded' AND t.name <> 'Insurance'
      ))
    LIMIT 1;
$$;


--
-- Name: billing_employee_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_employee_id() RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $_$
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
$_$;


--
-- Name: billing_patient_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_patient_id() RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $_$
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
$_$;


--
-- Name: check_appointment_conflict(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_appointment_conflict() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
    slot_start time;
    slot_end time;
BEGIN
    IF NEW.status = 'Cancelled' THEN
        RETURN NEW;
    END IF;

    -- status changes like check out don't move the appointment, so they skip the check
    IF TG_OP = 'UPDATE'
       AND OLD.status <> 'Cancelled'
       AND OLD.doctor_id = NEW.doctor_id
       AND OLD.patient_id = NEW.patient_id
       AND OLD.appointment_date = NEW.appointment_date
       AND OLD.time_slot_id = NEW.time_slot_id THEN
        RETURN NEW;
    END IF;

    -- each query below needs a fresh snapshot to see appointments committed while it waited
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Appointments must be written in a read committed transaction';
    END IF;

    -- one writer at a time per doctor, then per patient, until the transaction ends
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


--
-- Name: check_appointment_referral(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_appointment_referral() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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


--
-- Name: check_invoice_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_invoice_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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


--
-- Name: check_payment_amount(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_payment_amount() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $_$
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
$_$;


--
-- Name: check_payment_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_payment_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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


--
-- Name: check_referral(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_referral() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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


--
-- Name: insurance_verified(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.insurance_verified() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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


--
-- Name: invoice_completed_visit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invoice_completed_visit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
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

    INSERT INTO public.invoice (patient_id, appointment_id, amount, issue_date, status)
    VALUES (NEW.patient_id, NEW.appointment_id, 0, (now() AT TIME ZONE 'America/Chicago')::date, 'Pending')
    RETURNING invoice_id INTO new_invoice;

    INSERT INTO public.invoice_item (invoice_id, fee_id, category, description, price)
    SELECT new_invoice, f.fee_id, 'Visit', f.name, f.price
    FROM public.service_fee f
    WHERE f.specialty_id = NEW.specialty_id AND f.is_active;

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
$$;


--
-- Name: invoice_item_changed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invoice_item_changed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
    target integer := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
BEGIN
    PERFORM public.refresh_invoice_total(target);
    PERFORM public.pay_with_insurance(target);
    RETURN NULL;
END;
$$;


--
-- Name: lab_order_billing(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lab_order_billing() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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


--
-- Name: pay_with_insurance(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pay_with_insurance(target_invoice integer) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
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


--
-- Name: prescription_item_billing(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prescription_item_billing() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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


--
-- Name: record_appointment_history(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_appointment_history() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
    -- updates that leave every tracked column alone aren't recorded
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


--
-- Name: record_employee_changes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_employee_changes() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
    IF OLD.is_active IS DISTINCT FROM NEW.is_active THEN
        INSERT INTO public.employee_audit (employee_id, field_name, old_value, new_value)
        VALUES (NEW.employee_id, 'is_active', OLD.is_active::text, NEW.is_active::text);
    END IF;

    IF OLD.employee_type_id IS DISTINCT FROM NEW.employee_type_id THEN
        INSERT INTO public.employee_audit (employee_id, field_name, old_value, new_value)
        VALUES (NEW.employee_id, 'employee_type_id', OLD.employee_type_id::text, NEW.employee_type_id::text);
    END IF;

    IF OLD.office_id IS DISTINCT FROM NEW.office_id THEN
        INSERT INTO public.employee_audit (employee_id, field_name, old_value, new_value)
        VALUES (NEW.employee_id, 'office_id', OLD.office_id::text, NEW.office_id::text);
    END IF;

    RETURN NULL;
END;
$$;


--
-- Name: record_invoice_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_invoice_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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


--
-- Name: record_payment_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_payment_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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

    -- refunded payments don't count, payments waiting on a refund still do
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


--
-- Name: refresh_invoice_total(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_invoice_total(target_invoice integer) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
    new_amount numeric;
    still_paid numeric;
    current_status text;
    current_amount numeric;
BEGIN
    SELECT amount, status INTO current_amount, current_status FROM public.invoice WHERE invoice_id = target_invoice;
    IF current_status IS NULL OR current_status = 'Void' THEN
        RETURN;
    END IF;

    SELECT COALESCE(sum(price), 0) INTO new_amount FROM public.invoice_item WHERE invoice_id = target_invoice;
    SELECT COALESCE(sum(amount_paid), 0) INTO still_paid FROM public.payment WHERE invoice_id = target_invoice AND status <> 'Refunded';

    IF new_amount IS DISTINCT FROM current_amount THEN
        UPDATE public.invoice SET amount = new_amount WHERE invoice_id = target_invoice;
    END IF;
    IF current_status IN ('Pending', 'Overdue') AND new_amount > 0 AND still_paid >= new_amount THEN
        UPDATE public.invoice SET status = 'Paid' WHERE invoice_id = target_invoice;
    ELSIF current_status = 'Paid' AND still_paid < new_amount THEN
        UPDATE public.invoice SET status = 'Pending' WHERE invoice_id = target_invoice;
    END IF;
END;
$$;


--
-- Name: unpaid_visit_invoice(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unpaid_visit_invoice(visit integer) RETURNS integer
    LANGUAGE sql
    SET search_path TO ''
    AS $$
    SELECT invoice_id FROM public.invoice WHERE appointment_id = visit AND status IN ('Pending', 'Overdue') LIMIT 1;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: allergy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.allergy (
    allergy_id integer NOT NULL,
    patient_id integer NOT NULL,
    allergy_type_id integer NOT NULL,
    reaction character varying(200),
    severity character varying(10) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_allergy_severity CHECK (((severity)::text = ANY ((ARRAY['Mild'::character varying, 'Moderate'::character varying, 'Severe'::character varying])::text[])))
);


--
-- Name: allergy_allergy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.allergy ALTER COLUMN allergy_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.allergy_allergy_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: allergy_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.allergy_type (
    allergy_type_id integer NOT NULL,
    name character varying(100) NOT NULL,
    category character varying(20),
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_allergy_type_category CHECK (((category IS NULL) OR ((category)::text = ANY ((ARRAY['Medication'::character varying, 'Food'::character varying, 'Environmental'::character varying, 'Other'::character varying])::text[]))))
);


--
-- Name: allergy_type_allergy_type_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.allergy_type ALTER COLUMN allergy_type_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.allergy_type_allergy_type_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: appointment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appointment (
    appointment_id integer NOT NULL,
    patient_id integer NOT NULL,
    doctor_id integer NOT NULL,
    office_id integer NOT NULL,
    referral_id integer,
    appointment_date date NOT NULL,
    time_slot_id integer NOT NULL,
    specialty_id integer NOT NULL,
    status character varying(20) DEFAULT 'Scheduled'::character varying NOT NULL,
    booking_channel character varying(10) NOT NULL,
    booked_by_employee_id integer,
    checked_in_at timestamp with time zone,
    checked_out_at timestamp with time zone,
    CONSTRAINT chk_appointment_channel CHECK (((booking_channel)::text = ANY ((ARRAY['Phone'::character varying, 'Web'::character varying])::text[]))),
    CONSTRAINT chk_appointment_check_out CHECK (((checked_out_at IS NULL) OR ((checked_in_at IS NOT NULL) AND (checked_out_at >= checked_in_at)))),
    CONSTRAINT chk_appointment_phone_staff CHECK (((((booking_channel)::text = 'Phone'::text) AND (booked_by_employee_id IS NOT NULL)) OR ((booking_channel)::text = 'Web'::text))),
    CONSTRAINT chk_appointment_status CHECK (((status)::text = ANY ((ARRAY['Scheduled'::character varying, 'Cancelled'::character varying, 'Completed'::character varying, 'No Show'::character varying])::text[])))
);


--
-- Name: appointment_appointment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.appointment ALTER COLUMN appointment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.appointment_appointment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: appointment_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appointment_history (
    history_id integer NOT NULL,
    appointment_id integer NOT NULL,
    operation character varying(6) NOT NULL,
    old_status character varying(20),
    new_status character varying(20) NOT NULL,
    old_appointment_date date,
    new_appointment_date date NOT NULL,
    old_time_slot_id integer,
    new_time_slot_id integer NOT NULL,
    old_doctor_id integer,
    new_doctor_id integer NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by integer,
    checked_in_at timestamp with time zone,
    checked_out_at timestamp with time zone,
    CONSTRAINT chk_appointment_history_operation CHECK (((operation)::text = ANY (ARRAY[('INSERT'::character varying)::text, ('UPDATE'::character varying)::text])))
);


--
-- Name: appointment_history_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.appointment_history ALTER COLUMN history_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.appointment_history_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: appointment_summary; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appointment_summary (
    appointment_summary_id integer NOT NULL,
    appointment_id integer NOT NULL,
    visit_reason character varying(200),
    notes text,
    recorded_by_employee_id integer NOT NULL,
    recorded_date date DEFAULT CURRENT_DATE NOT NULL
);


--
-- Name: appointment_summary_appointment_summary_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.appointment_summary ALTER COLUMN appointment_summary_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.appointment_summary_appointment_summary_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: billing_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_history (
    history_id integer NOT NULL,
    invoice_id integer NOT NULL,
    payment_id integer,
    old_status character varying(20),
    new_status character varying(20) NOT NULL,
    changed_by integer,
    reason text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by_patient integer,
    CONSTRAINT chk_billing_history_who CHECK (((changed_by IS NOT NULL) OR (changed_by_patient IS NOT NULL)))
);


--
-- Name: billing_history_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.billing_history ALTER COLUMN history_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.billing_history_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: certificate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.certificate (
    certificate_id integer NOT NULL,
    employee_id integer NOT NULL,
    name character varying(100) NOT NULL,
    status character varying(20) DEFAULT 'Active'::character varying NOT NULL,
    issue_date date DEFAULT CURRENT_DATE NOT NULL,
    expiration_date date NOT NULL,
    CONSTRAINT chk_certificate_dates CHECK ((expiration_date >= issue_date)),
    CONSTRAINT chk_certificate_status CHECK (((status)::text = ANY ((ARRAY['Active'::character varying, 'Expired'::character varying, 'Revoked'::character varying])::text[])))
);


--
-- Name: certificate_certificate_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.certificate ALTER COLUMN certificate_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.certificate_certificate_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: doctor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doctor (
    employee_id integer NOT NULL,
    license_number character varying(50) NOT NULL,
    license_issuing_state character varying(2) NOT NULL,
    license_expiration_date date NOT NULL,
    npi_number character varying(20) NOT NULL,
    dea_number character varying(20)
);


--
-- Name: doctor_schedule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doctor_schedule (
    doctor_id integer NOT NULL,
    day_of_week character varying(10) NOT NULL,
    office_id integer NOT NULL,
    specialty_id integer NOT NULL,
    shift_type_id integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_doctor_schedule_day CHECK (((day_of_week)::text = ANY ((ARRAY['Monday'::character varying, 'Tuesday'::character varying, 'Wednesday'::character varying, 'Thursday'::character varying, 'Friday'::character varying, 'Saturday'::character varying, 'Sunday'::character varying])::text[])))
);


--
-- Name: doctor_specialty; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doctor_specialty (
    doctor_id integer NOT NULL,
    specialty_id integer NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: emergency_contact; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emergency_contact (
    emergency_contact_id integer NOT NULL,
    patient_id integer NOT NULL,
    first_name character varying(50) NOT NULL,
    last_name character varying(50) NOT NULL,
    relationship character varying(50) NOT NULL,
    phone_number character varying(10) NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_emergency_contact_phone CHECK (((phone_number)::text ~ '^[0-9]{10}$'::text))
);


--
-- Name: emergency_contact_emergency_contact_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.emergency_contact ALTER COLUMN emergency_contact_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.emergency_contact_emergency_contact_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: employee; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee (
    employee_id integer NOT NULL,
    first_name character varying(50) NOT NULL,
    last_name character varying(50) NOT NULL,
    dob date NOT NULL,
    employee_type_id integer NOT NULL,
    phone character varying(10) NOT NULL,
    email character varying(100) NOT NULL,
    office_id integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_employee_phone CHECK (((phone)::text ~ '^[0-9]{10}$'::text))
);


--
-- Name: employee_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_audit (
    audit_id integer NOT NULL,
    employee_id integer NOT NULL,
    field_name character varying(20) NOT NULL,
    old_value character varying(20),
    new_value character varying(20),
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_employee_audit_field CHECK (((field_name)::text = ANY (ARRAY[('is_active'::character varying)::text, ('employee_type_id'::character varying)::text, ('office_id'::character varying)::text])))
);


--
-- Name: employee_audit_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.employee_audit ALTER COLUMN audit_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.employee_audit_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: employee_creds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_creds (
    employee_creds_id integer NOT NULL,
    employee_id integer NOT NULL,
    username character varying(50) NOT NULL,
    password_hash character varying(255) NOT NULL,
    created_date date DEFAULT CURRENT_DATE NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: employee_creds_employee_creds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.employee_creds ALTER COLUMN employee_creds_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.employee_creds_employee_creds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: employee_employee_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.employee ALTER COLUMN employee_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.employee_employee_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: employee_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_types (
    employee_type_id integer NOT NULL,
    type_name character varying(50) NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: employee_types_employee_type_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.employee_types ALTER COLUMN employee_type_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.employee_types_employee_type_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: form_submission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_submission (
    form_submission_id integer NOT NULL,
    patient_id integer NOT NULL,
    form_type_id integer NOT NULL,
    status character varying(20) DEFAULT 'Pending'::character varying NOT NULL,
    submitted_date date,
    CONSTRAINT chk_form_submission_date CHECK (((((status)::text = 'Completed'::text) AND (submitted_date IS NOT NULL)) OR ((status)::text = 'Pending'::text))),
    CONSTRAINT chk_form_submission_status CHECK (((status)::text = ANY ((ARRAY['Pending'::character varying, 'Completed'::character varying])::text[])))
);


--
-- Name: form_submission_form_submission_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.form_submission ALTER COLUMN form_submission_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.form_submission_form_submission_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: form_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_type (
    form_type_id integer NOT NULL,
    name character varying(100) NOT NULL,
    is_required boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: form_type_form_type_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.form_type ALTER COLUMN form_type_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.form_type_form_type_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: home_medication; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.home_medication (
    home_medication_id integer NOT NULL,
    patient_id integer NOT NULL,
    medication_id integer,
    medication_name character varying(100) NOT NULL,
    category character varying(20),
    dosage character varying(50),
    frequency character varying(50),
    start_date date DEFAULT CURRENT_DATE NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_home_medication_category CHECK (((category IS NULL) OR ((category)::text = ANY ((ARRAY['Prescription'::character varying, 'OTC'::character varying, 'Supplement'::character varying])::text[]))))
);


--
-- Name: home_medication_home_medication_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.home_medication ALTER COLUMN home_medication_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.home_medication_home_medication_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: insurance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insurance (
    insurance_id integer NOT NULL,
    patient_id integer NOT NULL,
    provider character varying(100) NOT NULL,
    policy_number character varying(50) NOT NULL,
    status character varying(20) DEFAULT 'Pending'::character varying NOT NULL,
    CONSTRAINT chk_insurance_status CHECK (((status)::text = ANY ((ARRAY['Pending'::character varying, 'Verified'::character varying, 'Denied'::character varying])::text[])))
);


--
-- Name: insurance_insurance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.insurance ALTER COLUMN insurance_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.insurance_insurance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: invoice; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice (
    invoice_id integer NOT NULL,
    patient_id integer NOT NULL,
    appointment_id integer NOT NULL,
    amount numeric(10,2) NOT NULL,
    issue_date date DEFAULT CURRENT_DATE NOT NULL,
    status character varying(20) DEFAULT 'Pending'::character varying NOT NULL,
    CONSTRAINT chk_invoice_amount CHECK ((amount >= (0)::numeric)),
    CONSTRAINT chk_invoice_status CHECK (((status)::text = ANY ((ARRAY['Pending'::character varying, 'Paid'::character varying, 'Overdue'::character varying, 'Void'::character varying])::text[])))
);


--
-- Name: invoice_invoice_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.invoice ALTER COLUMN invoice_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.invoice_invoice_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: invoice_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_item (
    invoice_item_id integer NOT NULL,
    invoice_id integer NOT NULL,
    fee_id integer,
    category character varying(20) NOT NULL,
    description character varying(150) NOT NULL,
    price numeric(10,2) NOT NULL,
    lab_order_id integer,
    prescription_item_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_invoice_item_category CHECK (((category)::text = ANY ((ARRAY['Visit'::character varying, 'Lab Test'::character varying, 'Medication'::character varying])::text[]))),
    CONSTRAINT chk_invoice_item_price CHECK ((price >= (0)::numeric))
);


--
-- Name: invoice_item_invoice_item_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.invoice_item ALTER COLUMN invoice_item_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.invoice_item_invoice_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: lab_order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lab_order (
    lab_order_id integer NOT NULL,
    patient_id integer NOT NULL,
    ordered_by_employee_id integer NOT NULL,
    lab_test_type_id integer NOT NULL,
    appointment_id integer,
    status character varying(20) DEFAULT 'Ordered'::character varying NOT NULL,
    order_date date DEFAULT CURRENT_DATE NOT NULL,
    result_notes text,
    performed_by_employee_id integer,
    result_date timestamp without time zone,
    CONSTRAINT chk_lab_order_status CHECK (((status)::text = ANY ((ARRAY['Ordered'::character varying, 'InProgress'::character varying, 'Completed'::character varying, 'Cancelled'::character varying])::text[])))
);


--
-- Name: lab_order_lab_order_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.lab_order ALTER COLUMN lab_order_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.lab_order_lab_order_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: lab_test_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lab_test_type (
    lab_test_type_id integer NOT NULL,
    name character varying(100) NOT NULL,
    cost numeric(10,2) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_lab_test_type_cost CHECK ((cost >= (0)::numeric))
);


--
-- Name: lab_test_type_lab_test_type_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.lab_test_type ALTER COLUMN lab_test_type_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.lab_test_type_lab_test_type_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: medication; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.medication (
    medication_id integer NOT NULL,
    name character varying(100) NOT NULL,
    manufacturer character varying(100),
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: medication_medication_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.medication ALTER COLUMN medication_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.medication_medication_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: nurse; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nurse (
    employee_id integer NOT NULL,
    nursing_license_number character varying(50) NOT NULL,
    license_issuing_state character varying(2) NOT NULL,
    license_expiration_date date NOT NULL,
    nursing_level character varying(10) NOT NULL,
    CONSTRAINT chk_nurse_level CHECK (((nursing_level)::text = ANY ((ARRAY['RN'::character varying, 'LPN'::character varying, 'NP'::character varying, 'CNA'::character varying])::text[])))
);


--
-- Name: nursing_note; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nursing_note (
    nursing_note_id integer NOT NULL,
    appointment_id integer NOT NULL,
    recorded_by_employee_id integer NOT NULL,
    note text NOT NULL,
    recorded_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone,
    CONSTRAINT nursing_note_note_check CHECK ((btrim(note) <> ''::text))
);


--
-- Name: nursing_note_nursing_note_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.nursing_note ALTER COLUMN nursing_note_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.nursing_note_nursing_note_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: office; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.office (
    office_id integer NOT NULL,
    name character varying(100) NOT NULL,
    apt character varying(20),
    street character varying(100) NOT NULL,
    city character varying(50) NOT NULL,
    state character varying(2) NOT NULL,
    zip character varying(10) NOT NULL,
    phone character varying(10) NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_office_phone CHECK (((phone)::text ~ '^[0-9]{10}$'::text))
);


--
-- Name: office_office_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.office ALTER COLUMN office_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.office_office_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: office_supply; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.office_supply (
    office_supply_id integer NOT NULL,
    supply_id integer NOT NULL,
    office_id integer NOT NULL,
    quantity_on_hand integer DEFAULT 0 NOT NULL,
    expiration_date date,
    reorder_threshold integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_office_supply_qty CHECK ((quantity_on_hand >= 0)),
    CONSTRAINT chk_office_supply_threshold CHECK ((reorder_threshold >= 0))
);


--
-- Name: office_supply_office_supply_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.office_supply ALTER COLUMN office_supply_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.office_supply_office_supply_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: patient; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient (
    patient_id integer NOT NULL,
    first_name character varying(50) NOT NULL,
    last_name character varying(50) NOT NULL,
    dob date NOT NULL,
    gender character varying(20),
    phone character varying(10) NOT NULL,
    email character varying(100),
    address character varying(200),
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_patient_phone CHECK (((phone)::text ~ '^[0-9]{10}$'::text))
);


--
-- Name: patient_creds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_creds (
    patient_creds_id integer NOT NULL,
    patient_id integer NOT NULL,
    username character varying(50) NOT NULL,
    password_hash character varying(255) NOT NULL,
    created_date date DEFAULT CURRENT_DATE NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: patient_creds_patient_creds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.patient_creds ALTER COLUMN patient_creds_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.patient_creds_patient_creds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: patient_doctor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_doctor (
    patient_id integer NOT NULL,
    doctor_id integer NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    assigned_date date DEFAULT CURRENT_DATE NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: patient_patient_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.patient ALTER COLUMN patient_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.patient_patient_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: patient_vitals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_vitals (
    vitals_id integer NOT NULL,
    patient_id integer NOT NULL,
    appointment_id integer,
    recorded_by_employee_id integer NOT NULL,
    temperature numeric(10,2),
    heartrate_bpm integer,
    systolic_bp integer,
    diastolic_bp integer,
    weight_lbs numeric(10,2),
    height_inches numeric(10,2),
    recorded_at timestamp without time zone DEFAULT now() NOT NULL,
    respiratory_rate integer,
    oxygen_saturation integer,
    CONSTRAINT patient_vitals_has_reading_check CHECK ((num_nonnulls(temperature, heartrate_bpm, systolic_bp, diastolic_bp, respiratory_rate, oxygen_saturation, weight_lbs, height_inches) > 0))
);


--
-- Name: patient_vitals_vitals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.patient_vitals ALTER COLUMN vitals_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.patient_vitals_vitals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: payment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment (
    payment_id integer NOT NULL,
    invoice_id integer NOT NULL,
    payment_type_id integer NOT NULL,
    handled_by integer,
    amount_paid numeric(10,2) NOT NULL,
    payment_date date DEFAULT CURRENT_DATE NOT NULL,
    status character varying(20) DEFAULT 'Completed'::character varying NOT NULL,
    CONSTRAINT chk_payment_amount CHECK ((amount_paid > (0)::numeric)),
    CONSTRAINT chk_payment_status CHECK (((status)::text = ANY ((ARRAY['Completed'::character varying, 'Requested'::character varying, 'Refunded'::character varying])::text[])))
);


--
-- Name: payment_payment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.payment ALTER COLUMN payment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.payment_payment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: payment_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_type (
    payment_type_id integer NOT NULL,
    name character varying(50) NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: payment_type_payment_type_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.payment_type ALTER COLUMN payment_type_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.payment_type_payment_type_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: prescription; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prescription (
    prescription_id integer NOT NULL,
    patient_id integer NOT NULL,
    prescriber_id integer NOT NULL,
    appointment_id integer,
    date_prescribed date DEFAULT CURRENT_DATE NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: prescription_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prescription_item (
    prescription_item_id integer NOT NULL,
    prescription_id integer NOT NULL,
    medication_id integer NOT NULL,
    dosage character varying(50) NOT NULL,
    instructions text,
    duration_days integer,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_prescription_item_duration CHECK (((duration_days IS NULL) OR (duration_days > 0)))
);


--
-- Name: prescription_item_prescription_item_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.prescription_item ALTER COLUMN prescription_item_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.prescription_item_prescription_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: prescription_prescription_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.prescription ALTER COLUMN prescription_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.prescription_prescription_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: referral; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral (
    referral_id integer NOT NULL,
    patient_id integer NOT NULL,
    referring_doctor_id integer NOT NULL,
    specialist_doctor_id integer NOT NULL,
    specialty_id integer NOT NULL,
    date_issued date DEFAULT CURRENT_DATE NOT NULL,
    expiration_date date NOT NULL,
    status character varying(20) DEFAULT 'Pending'::character varying NOT NULL,
    primary_doctor_id integer,
    request_reason text,
    denial_reason text,
    decided_at timestamp with time zone,
    CONSTRAINT chk_referral_dates CHECK ((expiration_date >= date_issued)),
    CONSTRAINT chk_referral_status CHECK (((status)::text = ANY ((ARRAY['Pending'::character varying, 'Approved'::character varying, 'Denied'::character varying])::text[])))
);


--
-- Name: referral_referral_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.referral ALTER COLUMN referral_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.referral_referral_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: service_fee; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_fee (
    fee_id integer NOT NULL,
    category character varying(20) NOT NULL,
    type character varying(50),
    name character varying(100) NOT NULL,
    price numeric(10,2) NOT NULL,
    specialty_id integer,
    lab_test_type_id integer,
    medication_id integer,
    is_active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_service_fee_category CHECK (((category)::text = ANY ((ARRAY['Visit'::character varying, 'Lab Test'::character varying, 'Medication'::character varying])::text[]))),
    CONSTRAINT chk_service_fee_link CHECK (((((category)::text = 'Visit'::text) AND (specialty_id IS NOT NULL) AND (lab_test_type_id IS NULL) AND (medication_id IS NULL)) OR (((category)::text = 'Lab Test'::text) AND (lab_test_type_id IS NOT NULL) AND (specialty_id IS NULL) AND (medication_id IS NULL)) OR (((category)::text = 'Medication'::text) AND (medication_id IS NOT NULL) AND (specialty_id IS NULL) AND (lab_test_type_id IS NULL)))),
    CONSTRAINT chk_service_fee_price CHECK ((price >= (0)::numeric))
);


--
-- Name: service_fee_fee_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.service_fee ALTER COLUMN fee_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.service_fee_fee_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    sid character varying NOT NULL,
    sess json NOT NULL,
    expire timestamp(6) without time zone NOT NULL
);


--
-- Name: shift_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shift_type (
    shift_type_id integer NOT NULL,
    name character varying(50) NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_shift_type_times CHECK ((end_time > start_time))
);


--
-- Name: shift_type_shift_type_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.shift_type ALTER COLUMN shift_type_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.shift_type_shift_type_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: specialty; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.specialty (
    specialty_id integer NOT NULL,
    name character varying(100) NOT NULL,
    requires_referral boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: specialty_specialty_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.specialty ALTER COLUMN specialty_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.specialty_specialty_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supply; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply (
    supply_id integer NOT NULL,
    name character varying(100) NOT NULL,
    supply_type_id integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: supply_order; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply_order (
    supply_order_id integer NOT NULL,
    supply_id integer NOT NULL,
    office_id integer NOT NULL,
    employee_id integer NOT NULL,
    quantity_ordered integer NOT NULL,
    order_date date DEFAULT CURRENT_DATE NOT NULL,
    status character varying(20) DEFAULT 'Pending'::character varying NOT NULL,
    CONSTRAINT chk_supply_order_qty CHECK ((quantity_ordered > 0)),
    CONSTRAINT chk_supply_order_status CHECK (((status)::text = ANY ((ARRAY['Pending'::character varying, 'Ordered'::character varying, 'Received'::character varying, 'Cancelled'::character varying])::text[])))
);


--
-- Name: supply_order_supply_order_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supply_order ALTER COLUMN supply_order_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supply_order_supply_order_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supply_supply_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supply ALTER COLUMN supply_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supply_supply_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supply_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply_type (
    supply_type_id integer NOT NULL,
    type_name character varying(50) NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: supply_type_supply_type_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supply_type ALTER COLUMN supply_type_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supply_type_supply_type_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: time_slot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.time_slot (
    time_slot_id integer NOT NULL,
    shift_type_id integer NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_time_slot_times CHECK ((end_time > start_time))
);


--
-- Name: time_slot_time_slot_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.time_slot ALTER COLUMN time_slot_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.time_slot_time_slot_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: visit_diagnosis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visit_diagnosis (
    visit_diagnosis_id integer NOT NULL,
    appointment_id integer NOT NULL,
    name character varying(200) NOT NULL,
    reasoning text,
    recorded_by_employee_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_visit_diagnosis_name CHECK ((length(TRIM(BOTH FROM name)) > 0))
);


--
-- Name: visit_diagnosis_visit_diagnosis_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.visit_diagnosis ALTER COLUMN visit_diagnosis_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.visit_diagnosis_visit_diagnosis_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: allergy allergy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allergy
    ADD CONSTRAINT allergy_pkey PRIMARY KEY (allergy_id);


--
-- Name: allergy_type allergy_type_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allergy_type
    ADD CONSTRAINT allergy_type_name_key UNIQUE (name);


--
-- Name: allergy_type allergy_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allergy_type
    ADD CONSTRAINT allergy_type_pkey PRIMARY KEY (allergy_type_id);


--
-- Name: appointment_history appointment_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_history
    ADD CONSTRAINT appointment_history_pkey PRIMARY KEY (history_id);


--
-- Name: appointment appointment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_pkey PRIMARY KEY (appointment_id);


--
-- Name: appointment_summary appointment_summary_appointment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_summary
    ADD CONSTRAINT appointment_summary_appointment_id_key UNIQUE (appointment_id);


--
-- Name: appointment_summary appointment_summary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_summary
    ADD CONSTRAINT appointment_summary_pkey PRIMARY KEY (appointment_summary_id);


--
-- Name: billing_history billing_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_history
    ADD CONSTRAINT billing_history_pkey PRIMARY KEY (history_id);


--
-- Name: certificate certificate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certificate
    ADD CONSTRAINT certificate_pkey PRIMARY KEY (certificate_id);


--
-- Name: doctor doctor_dea_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor
    ADD CONSTRAINT doctor_dea_number_key UNIQUE (dea_number);


--
-- Name: doctor doctor_license_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor
    ADD CONSTRAINT doctor_license_number_key UNIQUE (license_number);


--
-- Name: doctor doctor_npi_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor
    ADD CONSTRAINT doctor_npi_number_key UNIQUE (npi_number);


--
-- Name: doctor doctor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor
    ADD CONSTRAINT doctor_pkey PRIMARY KEY (employee_id);


--
-- Name: doctor_schedule doctor_schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_schedule
    ADD CONSTRAINT doctor_schedule_pkey PRIMARY KEY (doctor_id, day_of_week);


--
-- Name: doctor_specialty doctor_specialty_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_specialty
    ADD CONSTRAINT doctor_specialty_pkey PRIMARY KEY (doctor_id, specialty_id);


--
-- Name: emergency_contact emergency_contact_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_contact
    ADD CONSTRAINT emergency_contact_pkey PRIMARY KEY (emergency_contact_id);


--
-- Name: employee_audit employee_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_audit
    ADD CONSTRAINT employee_audit_pkey PRIMARY KEY (audit_id);


--
-- Name: employee_creds employee_creds_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_creds
    ADD CONSTRAINT employee_creds_employee_id_key UNIQUE (employee_id);


--
-- Name: employee_creds employee_creds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_creds
    ADD CONSTRAINT employee_creds_pkey PRIMARY KEY (employee_creds_id);


--
-- Name: employee_creds employee_creds_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_creds
    ADD CONSTRAINT employee_creds_username_key UNIQUE (username);


--
-- Name: employee employee_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee
    ADD CONSTRAINT employee_pkey PRIMARY KEY (employee_id);


--
-- Name: employee_types employee_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_types
    ADD CONSTRAINT employee_types_pkey PRIMARY KEY (employee_type_id);


--
-- Name: employee_types employee_types_type_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_types
    ADD CONSTRAINT employee_types_type_name_key UNIQUE (type_name);


--
-- Name: form_submission form_submission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_submission
    ADD CONSTRAINT form_submission_pkey PRIMARY KEY (form_submission_id);


--
-- Name: form_type form_type_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_type
    ADD CONSTRAINT form_type_name_key UNIQUE (name);


--
-- Name: form_type form_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_type
    ADD CONSTRAINT form_type_pkey PRIMARY KEY (form_type_id);


--
-- Name: home_medication home_medication_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.home_medication
    ADD CONSTRAINT home_medication_pkey PRIMARY KEY (home_medication_id);


--
-- Name: insurance insurance_patient_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insurance
    ADD CONSTRAINT insurance_patient_id_key UNIQUE (patient_id);


--
-- Name: insurance insurance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insurance
    ADD CONSTRAINT insurance_pkey PRIMARY KEY (insurance_id);


--
-- Name: insurance insurance_policy_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insurance
    ADD CONSTRAINT insurance_policy_number_key UNIQUE (policy_number);


--
-- Name: invoice_item invoice_item_lab_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_item
    ADD CONSTRAINT invoice_item_lab_order_id_key UNIQUE (lab_order_id);


--
-- Name: invoice_item invoice_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_item
    ADD CONSTRAINT invoice_item_pkey PRIMARY KEY (invoice_item_id);


--
-- Name: invoice_item invoice_item_prescription_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_item
    ADD CONSTRAINT invoice_item_prescription_item_id_key UNIQUE (prescription_item_id);


--
-- Name: invoice invoice_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice
    ADD CONSTRAINT invoice_pkey PRIMARY KEY (invoice_id);


--
-- Name: lab_order lab_order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_order
    ADD CONSTRAINT lab_order_pkey PRIMARY KEY (lab_order_id);


--
-- Name: lab_test_type lab_test_type_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_test_type
    ADD CONSTRAINT lab_test_type_name_key UNIQUE (name);


--
-- Name: lab_test_type lab_test_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_test_type
    ADD CONSTRAINT lab_test_type_pkey PRIMARY KEY (lab_test_type_id);


--
-- Name: medication medication_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medication
    ADD CONSTRAINT medication_name_key UNIQUE (name);


--
-- Name: medication medication_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medication
    ADD CONSTRAINT medication_pkey PRIMARY KEY (medication_id);


--
-- Name: nurse nurse_nursing_license_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nurse
    ADD CONSTRAINT nurse_nursing_license_number_key UNIQUE (nursing_license_number);


--
-- Name: nurse nurse_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nurse
    ADD CONSTRAINT nurse_pkey PRIMARY KEY (employee_id);


--
-- Name: nursing_note nursing_note_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nursing_note
    ADD CONSTRAINT nursing_note_pkey PRIMARY KEY (nursing_note_id);


--
-- Name: office office_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.office
    ADD CONSTRAINT office_pkey PRIMARY KEY (office_id);


--
-- Name: office_supply office_supply_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.office_supply
    ADD CONSTRAINT office_supply_pkey PRIMARY KEY (office_supply_id);


--
-- Name: patient_creds patient_creds_patient_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_creds
    ADD CONSTRAINT patient_creds_patient_id_key UNIQUE (patient_id);


--
-- Name: patient_creds patient_creds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_creds
    ADD CONSTRAINT patient_creds_pkey PRIMARY KEY (patient_creds_id);


--
-- Name: patient_creds patient_creds_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_creds
    ADD CONSTRAINT patient_creds_username_key UNIQUE (username);


--
-- Name: patient_doctor patient_doctor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_doctor
    ADD CONSTRAINT patient_doctor_pkey PRIMARY KEY (patient_id, doctor_id);


--
-- Name: patient patient_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient
    ADD CONSTRAINT patient_pkey PRIMARY KEY (patient_id);


--
-- Name: patient_vitals patient_vitals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_vitals
    ADD CONSTRAINT patient_vitals_pkey PRIMARY KEY (vitals_id);


--
-- Name: payment payment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment
    ADD CONSTRAINT payment_pkey PRIMARY KEY (payment_id);


--
-- Name: payment_type payment_type_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_type
    ADD CONSTRAINT payment_type_name_key UNIQUE (name);


--
-- Name: payment_type payment_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_type
    ADD CONSTRAINT payment_type_pkey PRIMARY KEY (payment_type_id);


--
-- Name: prescription_item prescription_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prescription_item
    ADD CONSTRAINT prescription_item_pkey PRIMARY KEY (prescription_item_id);


--
-- Name: prescription prescription_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prescription
    ADD CONSTRAINT prescription_pkey PRIMARY KEY (prescription_id);


--
-- Name: referral referral_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral
    ADD CONSTRAINT referral_pkey PRIMARY KEY (referral_id);


--
-- Name: service_fee service_fee_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_fee
    ADD CONSTRAINT service_fee_pkey PRIMARY KEY (fee_id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (sid);


--
-- Name: shift_type shift_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_type
    ADD CONSTRAINT shift_type_pkey PRIMARY KEY (shift_type_id);


--
-- Name: specialty specialty_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.specialty
    ADD CONSTRAINT specialty_name_key UNIQUE (name);


--
-- Name: specialty specialty_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.specialty
    ADD CONSTRAINT specialty_pkey PRIMARY KEY (specialty_id);


--
-- Name: supply supply_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply
    ADD CONSTRAINT supply_name_key UNIQUE (name);


--
-- Name: supply_order supply_order_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_order
    ADD CONSTRAINT supply_order_pkey PRIMARY KEY (supply_order_id);


--
-- Name: supply supply_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply
    ADD CONSTRAINT supply_pkey PRIMARY KEY (supply_id);


--
-- Name: supply_type supply_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_type
    ADD CONSTRAINT supply_type_pkey PRIMARY KEY (supply_type_id);


--
-- Name: supply_type supply_type_type_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_type
    ADD CONSTRAINT supply_type_type_name_key UNIQUE (type_name);


--
-- Name: time_slot time_slot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_slot
    ADD CONSTRAINT time_slot_pkey PRIMARY KEY (time_slot_id);


--
-- Name: allergy uq_allergy_patient_type; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allergy
    ADD CONSTRAINT uq_allergy_patient_type UNIQUE (patient_id, allergy_type_id);


--
-- Name: office_supply uq_office_supply_supply_office; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.office_supply
    ADD CONSTRAINT uq_office_supply_supply_office UNIQUE (supply_id, office_id);


--
-- Name: visit_diagnosis visit_diagnosis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visit_diagnosis
    ADD CONSTRAINT visit_diagnosis_pkey PRIMARY KEY (visit_diagnosis_id);


--
-- Name: idx_appointment_history_appointment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appointment_history_appointment ON public.appointment_history USING btree (appointment_id, changed_at);


--
-- Name: idx_billing_history_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_history_invoice ON public.billing_history USING btree (invoice_id, changed_at);


--
-- Name: idx_billing_history_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_history_payment ON public.billing_history USING btree (payment_id, changed_at);


--
-- Name: idx_employee_audit_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employee_audit_employee ON public.employee_audit USING btree (employee_id, changed_at);


--
-- Name: idx_invoice_item_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_item_invoice ON public.invoice_item USING btree (invoice_id);


--
-- Name: idx_nursing_note_appointment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nursing_note_appointment ON public.nursing_note USING btree (appointment_id);


--
-- Name: idx_patient_vitals_patient_recorded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patient_vitals_patient_recorded ON public.patient_vitals USING btree (patient_id, recorded_at DESC);


--
-- Name: idx_session_expire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_expire ON public.session USING btree (expire);


--
-- Name: idx_visit_diagnosis_appointment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_visit_diagnosis_appointment ON public.visit_diagnosis USING btree (appointment_id);


--
-- Name: invoice_one_per_appointment; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invoice_one_per_appointment ON public.invoice USING btree (appointment_id) WHERE ((status)::text <> 'Void'::text);


--
-- Name: patient_doctor_one_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patient_doctor_one_primary ON public.patient_doctor USING btree (patient_id) WHERE (is_primary AND is_active);


--
-- Name: service_fee_one_per_lab_test; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX service_fee_one_per_lab_test ON public.service_fee USING btree (lab_test_type_id) WHERE (lab_test_type_id IS NOT NULL);


--
-- Name: service_fee_one_per_medication; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX service_fee_one_per_medication ON public.service_fee USING btree (medication_id) WHERE (medication_id IS NOT NULL);


--
-- Name: service_fee_one_per_specialty; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX service_fee_one_per_specialty ON public.service_fee USING btree (specialty_id) WHERE (specialty_id IS NOT NULL);


--
-- Name: appointment appointment_conflict_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER appointment_conflict_trigger BEFORE INSERT OR UPDATE ON public.appointment FOR EACH ROW EXECUTE FUNCTION public.check_appointment_conflict();


--
-- Name: appointment appointment_history_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER appointment_history_trigger AFTER INSERT OR UPDATE ON public.appointment FOR EACH ROW EXECUTE FUNCTION public.record_appointment_history();


--
-- Name: appointment appointment_invoice_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER appointment_invoice_trigger AFTER UPDATE OF status ON public.appointment FOR EACH ROW EXECUTE FUNCTION public.invoice_completed_visit();


--
-- Name: appointment appointment_primary_doctor_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER appointment_primary_doctor_trigger AFTER UPDATE OF status ON public.appointment FOR EACH ROW EXECUTE FUNCTION public.assign_primary_doctor();


--
-- Name: appointment appointment_referral_check_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER appointment_referral_check_trigger BEFORE INSERT OR UPDATE ON public.appointment FOR EACH ROW EXECUTE FUNCTION public.check_appointment_referral();


--
-- Name: employee employee_audit_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER employee_audit_trigger AFTER UPDATE OF is_active, employee_type_id, office_id ON public.employee FOR EACH ROW EXECUTE FUNCTION public.record_employee_changes();


--
-- Name: insurance insurance_verified_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER insurance_verified_trigger AFTER INSERT OR UPDATE OF status ON public.insurance FOR EACH ROW EXECUTE FUNCTION public.insurance_verified();


--
-- Name: invoice invoice_check_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER invoice_check_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.invoice FOR EACH ROW EXECUTE FUNCTION public.check_invoice_change();


--
-- Name: invoice invoice_history_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER invoice_history_trigger AFTER INSERT OR UPDATE ON public.invoice FOR EACH ROW EXECUTE FUNCTION public.record_invoice_change();


--
-- Name: invoice_item invoice_item_total_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER invoice_item_total_trigger AFTER INSERT OR DELETE ON public.invoice_item FOR EACH ROW EXECUTE FUNCTION public.invoice_item_changed();


--
-- Name: lab_order lab_order_billing_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lab_order_billing_trigger AFTER INSERT OR UPDATE OF status ON public.lab_order FOR EACH ROW EXECUTE FUNCTION public.lab_order_billing();


--
-- Name: payment payment_amount_check_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payment_amount_check_trigger BEFORE INSERT ON public.payment FOR EACH ROW EXECUTE FUNCTION public.check_payment_amount();


--
-- Name: payment payment_check_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payment_check_trigger BEFORE INSERT OR DELETE OR UPDATE ON public.payment FOR EACH ROW EXECUTE FUNCTION public.check_payment_change();


--
-- Name: payment payment_history_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payment_history_trigger AFTER INSERT OR UPDATE ON public.payment FOR EACH ROW EXECUTE FUNCTION public.record_payment_change();


--
-- Name: prescription_item prescription_item_billing_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prescription_item_billing_trigger AFTER INSERT OR UPDATE OF is_active ON public.prescription_item FOR EACH ROW EXECUTE FUNCTION public.prescription_item_billing();


--
-- Name: referral referral_check_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER referral_check_trigger BEFORE INSERT OR UPDATE ON public.referral FOR EACH ROW EXECUTE FUNCTION public.check_referral();


--
-- Name: allergy allergy_allergy_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allergy
    ADD CONSTRAINT allergy_allergy_type_id_fkey FOREIGN KEY (allergy_type_id) REFERENCES public.allergy_type(allergy_type_id) ON DELETE RESTRICT;


--
-- Name: allergy allergy_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allergy
    ADD CONSTRAINT allergy_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(patient_id) ON DELETE RESTRICT;


--
-- Name: appointment appointment_booked_by_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_booked_by_employee_id_fkey FOREIGN KEY (booked_by_employee_id) REFERENCES public.employee(employee_id) ON DELETE SET NULL;


--
-- Name: appointment appointment_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctor(employee_id) ON DELETE RESTRICT;


--
-- Name: appointment appointment_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.office(office_id) ON DELETE RESTRICT;


--
-- Name: appointment appointment_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(patient_id) ON DELETE RESTRICT;


--
-- Name: appointment appointment_referral_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_referral_id_fkey FOREIGN KEY (referral_id) REFERENCES public.referral(referral_id) ON DELETE SET NULL;


--
-- Name: appointment_summary appointment_summary_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_summary
    ADD CONSTRAINT appointment_summary_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointment(appointment_id) ON DELETE RESTRICT;


--
-- Name: appointment_summary appointment_summary_recorded_by_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_summary
    ADD CONSTRAINT appointment_summary_recorded_by_employee_id_fkey FOREIGN KEY (recorded_by_employee_id) REFERENCES public.employee(employee_id) ON DELETE RESTRICT;


--
-- Name: appointment appointment_time_slot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT appointment_time_slot_id_fkey FOREIGN KEY (time_slot_id) REFERENCES public.time_slot(time_slot_id) ON DELETE RESTRICT;


--
-- Name: certificate certificate_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.certificate
    ADD CONSTRAINT certificate_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employee(employee_id) ON DELETE RESTRICT;


--
-- Name: doctor doctor_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor
    ADD CONSTRAINT doctor_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employee(employee_id) ON DELETE CASCADE;


--
-- Name: doctor_schedule doctor_schedule_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_schedule
    ADD CONSTRAINT doctor_schedule_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctor(employee_id) ON DELETE RESTRICT;


--
-- Name: doctor_schedule doctor_schedule_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_schedule
    ADD CONSTRAINT doctor_schedule_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.office(office_id) ON DELETE RESTRICT;


--
-- Name: doctor_schedule doctor_schedule_shift_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_schedule
    ADD CONSTRAINT doctor_schedule_shift_type_id_fkey FOREIGN KEY (shift_type_id) REFERENCES public.shift_type(shift_type_id) ON DELETE RESTRICT;


--
-- Name: doctor_specialty doctor_specialty_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_specialty
    ADD CONSTRAINT doctor_specialty_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctor(employee_id) ON DELETE CASCADE;


--
-- Name: doctor_specialty doctor_specialty_specialty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_specialty
    ADD CONSTRAINT doctor_specialty_specialty_id_fkey FOREIGN KEY (specialty_id) REFERENCES public.specialty(specialty_id) ON DELETE CASCADE;


--
-- Name: emergency_contact emergency_contact_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_contact
    ADD CONSTRAINT emergency_contact_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(patient_id) ON DELETE RESTRICT;


--
-- Name: employee_creds employee_creds_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_creds
    ADD CONSTRAINT employee_creds_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employee(employee_id) ON DELETE CASCADE;


--
-- Name: employee employee_employee_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee
    ADD CONSTRAINT employee_employee_type_id_fkey FOREIGN KEY (employee_type_id) REFERENCES public.employee_types(employee_type_id) ON DELETE RESTRICT;


--
-- Name: employee employee_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee
    ADD CONSTRAINT employee_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.office(office_id) ON DELETE RESTRICT;


--
-- Name: appointment fk_appointment_doctor_specialty; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment
    ADD CONSTRAINT fk_appointment_doctor_specialty FOREIGN KEY (doctor_id, specialty_id) REFERENCES public.doctor_specialty(doctor_id, specialty_id) ON DELETE RESTRICT;


--
-- Name: doctor_schedule fk_doctor_schedule_doctor_specialty; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_schedule
    ADD CONSTRAINT fk_doctor_schedule_doctor_specialty FOREIGN KEY (doctor_id, specialty_id) REFERENCES public.doctor_specialty(doctor_id, specialty_id) ON DELETE RESTRICT;


--
-- Name: referral fk_referral_specialist_specialty; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral
    ADD CONSTRAINT fk_referral_specialist_specialty FOREIGN KEY (specialist_doctor_id, specialty_id) REFERENCES public.doctor_specialty(doctor_id, specialty_id) ON DELETE RESTRICT;


--
-- Name: form_submission form_submission_form_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_submission
    ADD CONSTRAINT form_submission_form_type_id_fkey FOREIGN KEY (form_type_id) REFERENCES public.form_type(form_type_id) ON DELETE RESTRICT;


--
-- Name: form_submission form_submission_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_submission
    ADD CONSTRAINT form_submission_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(patient_id) ON DELETE RESTRICT;


--
-- Name: home_medication home_medication_medication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.home_medication
    ADD CONSTRAINT home_medication_medication_id_fkey FOREIGN KEY (medication_id) REFERENCES public.medication(medication_id) ON DELETE SET NULL;


--
-- Name: home_medication home_medication_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.home_medication
    ADD CONSTRAINT home_medication_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(patient_id) ON DELETE RESTRICT;


--
-- Name: insurance insurance_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insurance
    ADD CONSTRAINT insurance_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(patient_id) ON DELETE RESTRICT;


--
-- Name: invoice invoice_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice
    ADD CONSTRAINT invoice_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointment(appointment_id) ON DELETE RESTRICT;


--
-- Name: invoice_item invoice_item_fee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_item
    ADD CONSTRAINT invoice_item_fee_id_fkey FOREIGN KEY (fee_id) REFERENCES public.service_fee(fee_id) ON DELETE RESTRICT;


--
-- Name: invoice_item invoice_item_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_item
    ADD CONSTRAINT invoice_item_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoice(invoice_id) ON DELETE RESTRICT;


--
-- Name: invoice_item invoice_item_lab_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_item
    ADD CONSTRAINT invoice_item_lab_order_id_fkey FOREIGN KEY (lab_order_id) REFERENCES public.lab_order(lab_order_id) ON DELETE RESTRICT;


--
-- Name: invoice_item invoice_item_prescription_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_item
    ADD CONSTRAINT invoice_item_prescription_item_id_fkey FOREIGN KEY (prescription_item_id) REFERENCES public.prescription_item(prescription_item_id) ON DELETE RESTRICT;


--
-- Name: invoice invoice_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice
    ADD CONSTRAINT invoice_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(patient_id) ON DELETE RESTRICT;


--
-- Name: lab_order lab_order_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_order
    ADD CONSTRAINT lab_order_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointment(appointment_id) ON DELETE SET NULL;


--
-- Name: lab_order lab_order_lab_test_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_order
    ADD CONSTRAINT lab_order_lab_test_type_id_fkey FOREIGN KEY (lab_test_type_id) REFERENCES public.lab_test_type(lab_test_type_id) ON DELETE RESTRICT;


--
-- Name: lab_order lab_order_ordered_by_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_order
    ADD CONSTRAINT lab_order_ordered_by_employee_id_fkey FOREIGN KEY (ordered_by_employee_id) REFERENCES public.employee(employee_id) ON DELETE RESTRICT;


--
-- Name: lab_order lab_order_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_order
    ADD CONSTRAINT lab_order_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(patient_id) ON DELETE RESTRICT;


--
-- Name: lab_order lab_order_performed_by_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_order
    ADD CONSTRAINT lab_order_performed_by_employee_id_fkey FOREIGN KEY (performed_by_employee_id) REFERENCES public.employee(employee_id) ON DELETE RESTRICT;


--
-- Name: nurse nurse_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nurse
    ADD CONSTRAINT nurse_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employee(employee_id) ON DELETE CASCADE;


--
-- Name: nursing_note nursing_note_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nursing_note
    ADD CONSTRAINT nursing_note_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointment(appointment_id) ON DELETE RESTRICT;


--
-- Name: nursing_note nursing_note_recorded_by_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nursing_note
    ADD CONSTRAINT nursing_note_recorded_by_employee_id_fkey FOREIGN KEY (recorded_by_employee_id) REFERENCES public.employee(employee_id) ON DELETE RESTRICT;


--
-- Name: office_supply office_supply_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.office_supply
    ADD CONSTRAINT office_supply_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.office(office_id) ON DELETE RESTRICT;


--
-- Name: office_supply office_supply_supply_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.office_supply
    ADD CONSTRAINT office_supply_supply_id_fkey FOREIGN KEY (supply_id) REFERENCES public.supply(supply_id) ON DELETE RESTRICT;


--
-- Name: patient_creds patient_creds_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_creds
    ADD CONSTRAINT patient_creds_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(patient_id) ON DELETE CASCADE;


--
-- Name: patient_doctor patient_doctor_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_doctor
    ADD CONSTRAINT patient_doctor_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctor(employee_id) ON DELETE CASCADE;


--
-- Name: patient_doctor patient_doctor_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_doctor
    ADD CONSTRAINT patient_doctor_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(patient_id) ON DELETE CASCADE;


--
-- Name: patient_vitals patient_vitals_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_vitals
    ADD CONSTRAINT patient_vitals_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointment(appointment_id);


--
-- Name: patient_vitals patient_vitals_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_vitals
    ADD CONSTRAINT patient_vitals_employee_id_fkey FOREIGN KEY (recorded_by_employee_id) REFERENCES public.employee(employee_id);


--
-- Name: patient_vitals patient_vitals_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_vitals
    ADD CONSTRAINT patient_vitals_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(patient_id);


--
-- Name: payment payment_handled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment
    ADD CONSTRAINT payment_handled_by_fkey FOREIGN KEY (handled_by) REFERENCES public.employee(employee_id) ON DELETE SET NULL;


--
-- Name: payment payment_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment
    ADD CONSTRAINT payment_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoice(invoice_id) ON DELETE RESTRICT;


--
-- Name: payment payment_payment_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment
    ADD CONSTRAINT payment_payment_type_id_fkey FOREIGN KEY (payment_type_id) REFERENCES public.payment_type(payment_type_id) ON DELETE RESTRICT;


--
-- Name: prescription prescription_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prescription
    ADD CONSTRAINT prescription_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointment(appointment_id) ON DELETE SET NULL;


--
-- Name: prescription_item prescription_item_medication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prescription_item
    ADD CONSTRAINT prescription_item_medication_id_fkey FOREIGN KEY (medication_id) REFERENCES public.medication(medication_id) ON DELETE RESTRICT;


--
-- Name: prescription_item prescription_item_prescription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prescription_item
    ADD CONSTRAINT prescription_item_prescription_id_fkey FOREIGN KEY (prescription_id) REFERENCES public.prescription(prescription_id) ON DELETE CASCADE;


--
-- Name: prescription prescription_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prescription
    ADD CONSTRAINT prescription_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(patient_id) ON DELETE RESTRICT;


--
-- Name: prescription prescription_prescriber_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prescription
    ADD CONSTRAINT prescription_prescriber_id_fkey FOREIGN KEY (prescriber_id) REFERENCES public.doctor(employee_id) ON DELETE RESTRICT;


--
-- Name: referral referral_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral
    ADD CONSTRAINT referral_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.patient(patient_id) ON DELETE RESTRICT;


--
-- Name: referral referral_primary_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral
    ADD CONSTRAINT referral_primary_doctor_id_fkey FOREIGN KEY (primary_doctor_id) REFERENCES public.doctor(employee_id) ON DELETE RESTRICT;


--
-- Name: referral referral_referring_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral
    ADD CONSTRAINT referral_referring_doctor_id_fkey FOREIGN KEY (referring_doctor_id) REFERENCES public.doctor(employee_id) ON DELETE RESTRICT;


--
-- Name: referral referral_specialist_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral
    ADD CONSTRAINT referral_specialist_doctor_id_fkey FOREIGN KEY (specialist_doctor_id) REFERENCES public.doctor(employee_id) ON DELETE RESTRICT;


--
-- Name: service_fee service_fee_lab_test_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_fee
    ADD CONSTRAINT service_fee_lab_test_type_id_fkey FOREIGN KEY (lab_test_type_id) REFERENCES public.lab_test_type(lab_test_type_id) ON DELETE RESTRICT;


--
-- Name: service_fee service_fee_medication_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_fee
    ADD CONSTRAINT service_fee_medication_id_fkey FOREIGN KEY (medication_id) REFERENCES public.medication(medication_id) ON DELETE RESTRICT;


--
-- Name: service_fee service_fee_specialty_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_fee
    ADD CONSTRAINT service_fee_specialty_id_fkey FOREIGN KEY (specialty_id) REFERENCES public.specialty(specialty_id) ON DELETE RESTRICT;


--
-- Name: supply_order supply_order_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_order
    ADD CONSTRAINT supply_order_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employee(employee_id) ON DELETE RESTRICT;


--
-- Name: supply_order supply_order_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_order
    ADD CONSTRAINT supply_order_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.office(office_id) ON DELETE RESTRICT;


--
-- Name: supply_order supply_order_supply_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_order
    ADD CONSTRAINT supply_order_supply_id_fkey FOREIGN KEY (supply_id) REFERENCES public.supply(supply_id) ON DELETE RESTRICT;


--
-- Name: supply supply_supply_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply
    ADD CONSTRAINT supply_supply_type_id_fkey FOREIGN KEY (supply_type_id) REFERENCES public.supply_type(supply_type_id) ON DELETE RESTRICT;


--
-- Name: time_slot time_slot_shift_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_slot
    ADD CONSTRAINT time_slot_shift_type_id_fkey FOREIGN KEY (shift_type_id) REFERENCES public.shift_type(shift_type_id) ON DELETE RESTRICT;


--
-- Name: visit_diagnosis visit_diagnosis_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visit_diagnosis
    ADD CONSTRAINT visit_diagnosis_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointment(appointment_id) ON DELETE CASCADE;


--
-- Name: visit_diagnosis visit_diagnosis_recorded_by_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visit_diagnosis
    ADD CONSTRAINT visit_diagnosis_recorded_by_employee_id_fkey FOREIGN KEY (recorded_by_employee_id) REFERENCES public.employee(employee_id) ON DELETE RESTRICT;


--
-- Name: allergy; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.allergy ENABLE ROW LEVEL SECURITY;

--
-- Name: allergy_type; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.allergy_type ENABLE ROW LEVEL SECURITY;

--
-- Name: appointment; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.appointment ENABLE ROW LEVEL SECURITY;

--
-- Name: appointment_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.appointment_history ENABLE ROW LEVEL SECURITY;

--
-- Name: appointment_summary; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.appointment_summary ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_history ENABLE ROW LEVEL SECURITY;

--
-- Name: certificate; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.certificate ENABLE ROW LEVEL SECURITY;

--
-- Name: doctor; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.doctor ENABLE ROW LEVEL SECURITY;

--
-- Name: doctor_schedule; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.doctor_schedule ENABLE ROW LEVEL SECURITY;

--
-- Name: doctor_specialty; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.doctor_specialty ENABLE ROW LEVEL SECURITY;

--
-- Name: emergency_contact; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.emergency_contact ENABLE ROW LEVEL SECURITY;

--
-- Name: employee; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_creds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee_creds ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee_types ENABLE ROW LEVEL SECURITY;

--
-- Name: form_submission; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.form_submission ENABLE ROW LEVEL SECURITY;

--
-- Name: form_type; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.form_type ENABLE ROW LEVEL SECURITY;

--
-- Name: home_medication; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.home_medication ENABLE ROW LEVEL SECURITY;

--
-- Name: insurance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.insurance ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_item; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_item ENABLE ROW LEVEL SECURITY;

--
-- Name: lab_order; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lab_order ENABLE ROW LEVEL SECURITY;

--
-- Name: lab_test_type; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lab_test_type ENABLE ROW LEVEL SECURITY;

--
-- Name: medication; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.medication ENABLE ROW LEVEL SECURITY;

--
-- Name: nurse; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.nurse ENABLE ROW LEVEL SECURITY;

--
-- Name: nursing_note; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.nursing_note ENABLE ROW LEVEL SECURITY;

--
-- Name: office; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.office ENABLE ROW LEVEL SECURITY;

--
-- Name: office_supply; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.office_supply ENABLE ROW LEVEL SECURITY;

--
-- Name: patient; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patient ENABLE ROW LEVEL SECURITY;

--
-- Name: patient_creds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patient_creds ENABLE ROW LEVEL SECURITY;

--
-- Name: patient_doctor; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patient_doctor ENABLE ROW LEVEL SECURITY;

--
-- Name: patient_vitals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patient_vitals ENABLE ROW LEVEL SECURITY;

--
-- Name: payment; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_type; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_type ENABLE ROW LEVEL SECURITY;

--
-- Name: prescription; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.prescription ENABLE ROW LEVEL SECURITY;

--
-- Name: prescription_item; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.prescription_item ENABLE ROW LEVEL SECURITY;

--
-- Name: referral; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.referral ENABLE ROW LEVEL SECURITY;

--
-- Name: service_fee; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.service_fee ENABLE ROW LEVEL SECURITY;

--
-- Name: session; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.session ENABLE ROW LEVEL SECURITY;

--
-- Name: shift_type; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shift_type ENABLE ROW LEVEL SECURITY;

--
-- Name: specialty; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.specialty ENABLE ROW LEVEL SECURITY;

--
-- Name: supply; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.supply ENABLE ROW LEVEL SECURITY;

--
-- Name: supply_order; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.supply_order ENABLE ROW LEVEL SECURITY;

--
-- Name: supply_type; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.supply_type ENABLE ROW LEVEL SECURITY;

--
-- Name: time_slot; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.time_slot ENABLE ROW LEVEL SECURITY;

--
-- Name: visit_diagnosis; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.visit_diagnosis ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict clinicschema


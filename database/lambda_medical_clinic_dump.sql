--
-- PostgreSQL database dump
--

\restrict 0yodWBYQ8XNUgGyiU4PXoB0rfDMJ5IsNPasKcRTuf2azhrWwmMtXKjQ3qblNLuO

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

CREATE SCHEMA IF NOT EXISTS public;


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
-- Name: check_doctor_deactivation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_doctor_deactivation() RETURNS trigger
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


--
-- Name: no_show_fee(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.no_show_fee() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $_$
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
$_$;


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
    CONSTRAINT chk_invoice_item_category CHECK (((category)::text = ANY ((ARRAY['Visit'::character varying, 'Lab Test'::character varying, 'Medication'::character varying, 'No Show'::character varying])::text[]))),
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
    CONSTRAINT chk_service_fee_category CHECK (((category)::text = ANY ((ARRAY['Visit'::character varying, 'Lab Test'::character varying, 'Medication'::character varying, 'No Show'::character varying])::text[]))),
    CONSTRAINT chk_service_fee_link CHECK (((((category)::text = 'Visit'::text) AND (specialty_id IS NOT NULL) AND (lab_test_type_id IS NULL) AND (medication_id IS NULL)) OR (((category)::text = 'Lab Test'::text) AND (lab_test_type_id IS NOT NULL) AND (specialty_id IS NULL) AND (medication_id IS NULL)) OR (((category)::text = 'Medication'::text) AND (medication_id IS NOT NULL) AND (specialty_id IS NULL) AND (lab_test_type_id IS NULL)) OR (((category)::text = 'No Show'::text) AND (specialty_id IS NULL) AND (lab_test_type_id IS NULL) AND (medication_id IS NULL)))),
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
-- Data for Name: allergy; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.allergy (allergy_id, patient_id, allergy_type_id, reaction, severity, is_active) FROM stdin;
22	101	1	Hives and swelling	Severe	t
23	104	3	Skin rash	Moderate	t
24	107	7	Anaphylaxis	Severe	t
25	106	12	Itching	Mild	t
26	109	13	Sneezing, watery eyes	Mild	t
27	108	6	Nausea and vomiting	Moderate	t
30	114	15	jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj	Mild	t
31	119	9	Hives	Moderate	t
32	121	1	Rash	Mild	t
33	124	7	Throat swelling	Severe	t
34	127	12	Itchy skin	Mild	t
36	110	6	dies	Mild	t
35	110	15	djd	Severe	f
37	110	2	he dies	Mild	t
\.


--
-- Data for Name: allergy_type; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.allergy_type (allergy_type_id, name, category, is_active) FROM stdin;
1	Penicillin	Medication	t
2	Amoxicillin	Medication	t
3	Sulfa drugs	Medication	t
4	Aspirin	Medication	t
5	Ibuprofen	Medication	t
6	Codeine	Medication	t
7	Peanuts	Food	t
8	Tree nuts	Food	t
9	Shellfish	Food	t
10	Eggs	Food	t
11	Milk	Food	t
12	Latex	Environmental	t
13	Pollen	Environmental	t
14	Dust mites	Environmental	t
15	Bee stings	Other	t
\.


--
-- Data for Name: appointment; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.appointment (appointment_id, patient_id, doctor_id, office_id, referral_id, appointment_date, time_slot_id, specialty_id, status, booking_channel, booked_by_employee_id, checked_in_at, checked_out_at) FROM stdin;
1	101	1002	6	\N	2026-02-11	50	15	Completed	Web	\N	\N	\N
2	101	1003	5	\N	2026-04-03	70	16	No Show	Web	\N	\N	\N
3	101	1006	5	\N	2026-04-09	72	19	Completed	Phone	1016	\N	\N
4	101	1001	5	\N	2026-04-16	53	15	Completed	Phone	1014	\N	\N
5	104	1005	6	\N	2026-04-20	53	18	No Show	Phone	1015	\N	\N
6	101	1001	5	\N	2026-04-24	63	15	Completed	Web	\N	\N	\N
7	105	1008	5	\N	2026-04-27	69	21	Completed	Web	\N	\N	\N
8	105	1002	6	\N	2026-05-01	53	15	Completed	Phone	1015	\N	\N
9	101	1002	6	\N	2026-05-07	78	15	Completed	Web	\N	\N	\N
10	104	1005	6	\N	2026-05-08	64	18	Completed	Phone	1015	\N	\N
11	105	1002	6	\N	2026-05-11	57	15	Completed	Phone	1015	\N	\N
12	102	1003	5	\N	2026-05-14	76	16	No Show	Phone	1015	\N	\N
13	101	1002	6	\N	2026-05-22	70	15	Completed	Web	\N	\N	\N
14	101	1001	5	\N	2026-05-22	51	15	Completed	Phone	1015	\N	\N
15	104	1001	5	\N	2026-05-26	59	15	Completed	Web	\N	\N	\N
16	103	1003	5	\N	2026-05-29	69	16	Completed	Web	\N	\N	\N
17	101	1002	6	\N	2026-05-29	49	15	Completed	Phone	1014	\N	\N
18	102	1001	5	\N	2026-06-03	70	15	Completed	Phone	1015	\N	\N
19	105	1003	5	\N	2026-06-05	72	16	Cancelled	Phone	1014	\N	\N
20	106	1001	5	\N	2026-06-11	63	15	Completed	Web	\N	\N	\N
21	107	1001	5	\N	2026-06-12	70	15	Completed	Web	\N	\N	\N
22	101	1004	5	\N	2026-06-15	51	17	Cancelled	Phone	1016	\N	\N
23	107	1003	5	\N	2026-06-15	76	16	Completed	Web	\N	\N	\N
24	105	1003	5	\N	2026-06-17	62	16	Completed	Web	\N	\N	\N
25	105	1002	6	\N	2026-07-06	64	15	Completed	Phone	1015	\N	\N
26	105	1006	5	\N	2026-07-08	55	19	Completed	Web	\N	\N	\N
27	104	1008	5	\N	2026-07-13	63	21	Cancelled	Web	\N	\N	\N
28	103	1002	6	\N	2026-07-14	70	15	No Show	Web	\N	\N	\N
29	105	1006	5	\N	2026-07-16	55	19	Completed	Web	\N	\N	\N
30	106	1002	6	\N	2026-07-21	57	15	Completed	Web	\N	\N	\N
31	105	1007	6	\N	2026-07-22	49	20	Completed	Web	\N	\N	\N
32	102	1003	5	\N	2026-07-29	64	16	Completed	Web	\N	\N	\N
33	107	1004	5	\N	2026-08-04	49	17	Completed	Web	\N	\N	\N
34	101	1005	6	\N	2026-08-04	70	18	Completed	Phone	1014	\N	\N
35	105	1003	5	\N	2026-08-04	70	16	Completed	Phone	1014	\N	\N
36	105	1003	5	\N	2026-08-07	78	16	Cancelled	Web	\N	\N	\N
37	104	1001	5	\N	2026-08-10	50	15	Completed	Phone	1016	\N	\N
38	101	1002	6	\N	2026-08-17	49	15	Completed	Phone	1016	\N	\N
39	103	1001	5	\N	2026-08-25	55	15	Completed	Web	\N	\N	\N
40	106	1007	6	\N	2026-08-28	55	20	Completed	Web	\N	\N	\N
41	102	1006	5	\N	2026-08-28	57	19	Completed	Web	\N	\N	\N
42	107	1002	6	\N	2026-09-01	78	15	Completed	Web	\N	\N	\N
43	105	1005	6	\N	2026-09-01	78	18	Completed	Web	\N	\N	\N
44	106	1002	6	\N	2026-09-01	57	15	Completed	Phone	1015	\N	\N
45	104	1001	5	\N	2026-09-01	76	15	No Show	Web	\N	\N	\N
46	106	1005	6	\N	2026-09-03	59	18	Completed	Phone	1016	\N	\N
47	106	1005	6	\N	2026-09-03	63	18	Completed	Web	\N	\N	\N
48	109	1007	6	\N	2026-09-07	61	20	Completed	Phone	1015	\N	\N
49	102	1008	5	\N	2026-09-08	53	21	Completed	Web	\N	\N	\N
50	109	1001	5	\N	2026-09-09	59	15	No Show	Web	\N	\N	\N
51	108	1002	6	\N	2026-09-09	70	15	No Show	Phone	1014	\N	\N
52	104	1001	5	\N	2026-09-09	70	15	Cancelled	Phone	1014	\N	\N
53	107	1008	5	\N	2026-09-11	64	21	Completed	Phone	1014	\N	\N
54	103	1008	5	\N	2026-09-11	50	21	Completed	Web	\N	\N	\N
55	109	1003	5	\N	2026-09-17	70	16	Completed	Phone	1014	\N	\N
56	109	1005	6	\N	2026-09-17	62	18	Completed	Web	\N	\N	\N
57	107	1003	5	\N	2026-09-18	63	16	Completed	Phone	1016	\N	\N
58	108	1003	5	\N	2026-09-22	70	16	Completed	Web	\N	\N	\N
59	101	1005	6	\N	2026-09-22	53	18	Cancelled	Web	\N	\N	\N
60	107	1001	5	\N	2026-09-23	76	15	Cancelled	Web	\N	\N	\N
61	106	1008	5	\N	2026-09-25	69	21	Completed	Phone	1014	\N	\N
62	110	1001	5	\N	2026-09-25	63	15	Completed	Phone	1014	\N	\N
63	108	1004	5	\N	2026-09-28	63	17	Completed	Web	\N	\N	\N
64	110	1004	5	\N	2026-09-29	78	17	Cancelled	Web	\N	\N	\N
65	109	1006	5	\N	2026-09-29	76	19	No Show	Web	\N	\N	\N
66	102	1002	6	\N	2026-09-30	76	15	Completed	Phone	1014	\N	\N
67	101	1001	5	\N	2026-10-01	59	15	Completed	Web	\N	\N	\N
68	109	1005	6	\N	2026-10-01	62	18	Completed	Web	\N	\N	\N
69	106	1003	5	\N	2026-10-02	51	16	Completed	Web	\N	\N	\N
70	107	1001	5	\N	2026-10-02	76	15	Cancelled	Phone	1015	\N	\N
71	109	1001	5	\N	2026-10-05	63	15	Completed	Phone	1016	\N	\N
72	109	1006	5	\N	2026-10-06	72	19	Completed	Phone	1015	\N	\N
73	107	1007	6	\N	2026-10-07	59	20	Completed	Phone	1014	\N	\N
74	107	1004	5	\N	2026-10-08	69	17	Cancelled	Web	\N	\N	\N
75	110	1001	5	\N	2026-10-13	57	15	Completed	Phone	1014	\N	\N
76	108	1004	5	\N	2026-10-13	51	17	No Show	Web	\N	\N	\N
77	102	1002	6	\N	2026-10-14	61	15	Completed	Phone	1015	\N	\N
78	110	1001	5	\N	2026-10-16	64	15	Completed	Phone	1016	\N	\N
79	106	1002	6	\N	2026-10-19	55	15	Completed	Web	\N	\N	\N
80	109	1001	5	\N	2026-10-19	63	15	No Show	Web	\N	\N	\N
81	106	1003	5	\N	2026-10-19	51	16	Completed	Web	\N	\N	\N
82	105	1006	5	\N	2026-10-20	62	19	Completed	Web	\N	\N	\N
83	108	1001	5	\N	2026-10-21	55	15	Completed	Phone	1015	\N	\N
84	110	1001	5	\N	2026-10-21	72	15	Completed	Phone	1016	\N	\N
92	110	1005	6	\N	2026-11-03	55	18	Cancelled	Web	\N	\N	\N
95	108	1003	5	\N	2026-11-16	63	16	Scheduled	Phone	1016	\N	\N
96	103	1003	5	\N	2026-11-16	76	16	Scheduled	Phone	1014	\N	\N
97	103	1005	6	\N	2026-11-18	78	18	Scheduled	Phone	1015	\N	\N
85	101	1007	6	\N	2026-10-23	62	20	Completed	Web	\N	2026-10-23 20:15:00+00	2026-10-23 21:10:00+00
93	101	1003	5	\N	2026-11-10	55	16	Completed	Phone	1014	2026-11-10 15:23:00+00	2026-11-10 16:10:00+00
98	103	1005	6	\N	2026-11-25	70	18	Scheduled	Web	\N	\N	\N
99	107	1008	5	\N	2026-11-25	53	21	Scheduled	Phone	1016	\N	\N
100	101	1004	5	\N	2026-12-02	78	17	Scheduled	Web	\N	\N	\N
101	106	1003	5	\N	2026-12-03	49	16	Scheduled	Web	\N	\N	\N
102	104	1003	5	\N	2026-12-07	50	16	Scheduled	Web	\N	\N	\N
103	109	1004	5	\N	2026-12-08	76	17	Scheduled	Phone	1015	\N	\N
104	106	1001	5	\N	2026-12-17	51	15	Cancelled	Web	\N	\N	\N
106	103	1001	5	\N	2026-12-18	53	15	Scheduled	Phone	1016	\N	\N
107	101	1001	5	\N	2026-10-26	64	15	Cancelled	Web	\N	\N	\N
132	127	1022	6	\N	2026-10-15	79	15	Completed	Phone	1016	2026-10-15 13:50:00+00	2026-10-15 14:35:00+00
105	110	1001	5	\N	2026-12-18	64	15	Cancelled	Phone	1014	\N	\N
133	127	1022	6	\N	2026-10-15	60	15	Completed	Web	\N	2026-10-15 12:50:00+00	2026-10-15 13:35:00+00
134	127	1022	6	\N	2026-10-15	54	15	Completed	Phone	1029	2026-10-15 15:20:00+00	2026-10-15 16:05:00+00
108	107	1001	5	\N	2026-10-26	64	15	Completed	Phone	1014	2026-10-26 13:55:00+00	2026-10-26 14:47:00+00
135	104	1004	5	26	2026-10-15	72	17	Completed	Web	\N	2026-10-15 18:20:00+00	2026-10-15 19:05:00+00
114	110	1004	5	5	2026-10-29	59	17	Cancelled	Web	\N	\N	\N
120	110	1002	6	\N	2026-11-20	57	15	Cancelled	Web	\N	\N	\N
122	101	1004	5	25	2026-11-05	78	17	Cancelled	Web	\N	\N	\N
86	103	1005	6	\N	2026-10-26	53	18	No Show	Phone	1014	\N	\N
89	107	1002	6	\N	2026-10-29	69	15	No Show	Phone	1015	\N	\N
91	109	1002	6	\N	2026-11-02	76	15	No Show	Phone	1015	\N	\N
109	112	1001	5	\N	2026-10-27	76	15	No Show	Web	\N	\N	\N
116	110	1004	5	5	2026-10-30	76	17	No Show	Web	\N	\N	\N
118	118	1001	5	\N	2026-10-29	76	15	No Show	Web	\N	\N	\N
119	118	1001	5	\N	2026-10-29	64	15	No Show	Web	\N	\N	\N
123	108	1001	5	\N	2026-10-15	72	15	Completed	Phone	1028	2026-10-15 18:20:00+00	2026-10-15 19:05:00+00
87	106	1002	6	\N	2026-10-26	76	15	Completed	Phone	1016	2026-10-26 21:27:00+00	2026-10-26 22:08:00+00
124	103	1001	5	\N	2026-10-15	57	15	Completed	Web	\N	2026-10-15 14:50:00+00	2026-10-15 15:35:00+00
125	110	1001	5	\N	2026-10-15	53	15	Completed	Phone	1015	2026-10-15 18:50:00+00	2026-10-15 19:35:00+00
126	105	1002	6	\N	2026-10-15	70	15	No Show	Web	\N	\N	\N
127	106	1003	5	\N	2026-10-15	76	16	No Show	Phone	1014	\N	\N
128	108	1003	5	\N	2026-10-15	64	16	No Show	Phone	1014	\N	\N
129	108	1003	5	\N	2026-10-15	78	16	Cancelled	Web	\N	\N	\N
111	114	1002	6	\N	2026-10-28	78	15	Completed	Web	\N	2026-10-28 12:50:00+00	2026-10-28 13:40:00+00
130	125	1021	6	\N	2026-10-15	50	16	Completed	Web	\N	2026-10-15 17:50:00+00	2026-10-15 18:35:00+00
131	105	1021	6	\N	2026-10-15	76	16	Completed	Web	\N	2026-10-15 21:20:00+00	2026-10-15 22:05:00+00
112	114	1001	5	\N	2026-10-28	59	15	Completed	Web	\N	2026-10-28 13:23:00+00	2026-10-28 14:05:00+00
136	107	1005	6	27	2026-10-15	78	18	Completed	Web	\N	2026-10-15 12:50:00+00	2026-10-15 13:35:00+00
113	114	1001	5	\N	2026-10-28	64	15	Completed	Web	\N	2026-10-28 14:00:00+00	2026-10-28 14:52:00+00
137	110	1006	5	28	2026-10-15	59	19	Completed	Phone	1015	2026-10-15 13:20:00+00	2026-10-15 14:05:00+00
138	107	1023	5	29	2026-10-15	57	20	Cancelled	Web	\N	\N	\N
139	101	1001	5	\N	2026-10-16	63	15	Completed	Web	\N	2026-10-16 19:50:00+00	2026-10-16 20:35:00+00
88	106	1002	6	\N	2026-10-28	70	15	Completed	Web	\N	2026-10-28 16:17:00+00	2026-10-28 17:02:00+00
140	101	1001	5	\N	2026-10-16	59	15	Completed	Phone	1028	2026-10-16 13:20:00+00	2026-10-16 14:05:00+00
141	101	1001	5	\N	2026-10-16	61	15	Completed	Web	\N	2026-10-16 19:20:00+00	2026-10-16 20:05:00+00
110	113	1003	5	\N	2026-10-29	78	16	Completed	Web	\N	2026-10-29 12:53:00+00	2026-10-29 13:31:00+00
142	123	1002	6	\N	2026-10-16	55	15	Completed	Phone	1029	2026-10-16 14:20:00+00	2026-10-16 15:05:00+00
143	106	1003	5	\N	2026-10-16	78	16	Completed	Phone	1014	2026-10-16 12:50:00+00	2026-10-16 13:35:00+00
90	109	1001	5	\N	2026-10-29	51	15	Completed	Web	\N	2026-10-29 20:59:00+00	2026-10-29 21:58:00+00
144	119	1003	5	\N	2026-10-16	53	16	Completed	Phone	1015	2026-10-16 18:50:00+00	2026-10-16 19:35:00+00
115	110	1001	5	\N	2026-10-30	49	15	Completed	Web	\N	2026-10-30 15:52:00+00	2026-10-30 16:30:00+00
117	118	1003	5	\N	2026-10-30	76	16	Completed	Web	\N	2026-10-30 21:21:00+00	2026-10-30 21:57:00+00
145	114	1003	5	\N	2026-10-16	59	16	Completed	Phone	1015	2026-10-16 13:20:00+00	2026-10-16 14:05:00+00
146	114	1021	6	\N	2026-10-16	51	16	No Show	Web	\N	\N	\N
147	125	1021	6	\N	2026-10-16	78	16	Completed	Web	\N	2026-10-16 12:50:00+00	2026-10-16 13:35:00+00
148	125	1021	6	\N	2026-10-16	64	16	Completed	Web	\N	2026-10-16 13:50:00+00	2026-10-16 14:35:00+00
149	120	1022	6	\N	2026-10-16	50	15	Completed	Web	\N	2026-10-16 17:50:00+00	2026-10-16 18:35:00+00
150	105	1005	6	30	2026-10-16	50	18	Completed	Web	\N	2026-10-16 17:50:00+00	2026-10-16 18:35:00+00
151	102	1006	5	31	2026-10-16	53	19	Cancelled	Web	\N	\N	\N
152	120	1007	6	32	2026-10-16	78	20	Completed	Phone	1030	2026-10-16 12:50:00+00	2026-10-16 13:35:00+00
153	110	1008	5	33	2026-10-16	78	21	No Show	Web	\N	\N	\N
154	107	1001	5	\N	2026-10-19	62	15	Cancelled	Web	\N	\N	\N
155	109	1002	6	\N	2026-10-19	53	15	Completed	Web	\N	2026-10-19 18:50:00+00	2026-10-19 19:35:00+00
156	111	1002	6	\N	2026-10-19	51	15	Cancelled	Web	\N	\N	\N
157	126	1002	6	\N	2026-10-19	61	15	Completed	Web	\N	2026-10-19 19:20:00+00	2026-10-19 20:05:00+00
158	119	1003	5	\N	2026-10-19	62	16	Completed	Phone	1028	2026-10-19 20:20:00+00	2026-10-19 21:05:00+00
159	125	1021	6	\N	2026-10-19	57	16	Completed	Phone	1029	2026-10-19 14:50:00+00	2026-10-19 15:35:00+00
160	125	1021	6	\N	2026-10-19	53	16	No Show	Phone	1016	\N	\N
161	127	1022	6	\N	2026-10-19	76	15	No Show	Web	\N	\N	\N
162	120	1022	6	\N	2026-10-19	61	15	Completed	Web	\N	2026-10-19 19:20:00+00	2026-10-19 20:05:00+00
163	120	1022	6	\N	2026-10-19	51	15	Completed	Web	\N	2026-10-19 20:50:00+00	2026-10-19 21:35:00+00
164	127	1005	6	34	2026-10-19	55	18	Completed	Phone	1016	2026-10-19 14:20:00+00	2026-10-19 15:05:00+00
165	119	1006	5	35	2026-10-19	76	19	Completed	Phone	1014	2026-10-19 21:20:00+00	2026-10-19 22:05:00+00
166	119	1007	6	36	2026-10-19	49	20	Completed	Phone	1016	2026-10-19 15:50:00+00	2026-10-19 16:35:00+00
167	105	1008	5	37	2026-10-19	78	21	Completed	Phone	1014	2026-10-19 12:50:00+00	2026-10-19 13:35:00+00
168	103	1001	5	\N	2026-10-20	49	15	Completed	Phone	1014	2026-10-20 15:50:00+00	2026-10-20 16:35:00+00
169	102	1001	5	\N	2026-10-20	69	15	No Show	Phone	1028	\N	\N
170	107	1002	5	\N	2026-10-20	69	15	Completed	Phone	1015	2026-10-20 15:20:00+00	2026-10-20 16:05:00+00
171	129	1002	5	\N	2026-10-20	62	15	Completed	Phone	1014	2026-10-20 20:20:00+00	2026-10-20 21:05:00+00
172	129	1002	5	\N	2026-10-20	64	15	Completed	Phone	1028	2026-10-20 13:50:00+00	2026-10-20 14:35:00+00
173	119	1003	5	\N	2026-10-20	59	16	Completed	Web	\N	2026-10-20 13:20:00+00	2026-10-20 14:05:00+00
174	113	1021	6	\N	2026-10-20	49	16	Completed	Web	\N	2026-10-20 15:50:00+00	2026-10-20 16:35:00+00
175	104	1022	6	\N	2026-10-20	54	15	Completed	Web	\N	2026-10-20 15:20:00+00	2026-10-20 16:05:00+00
176	127	1022	6	\N	2026-10-20	74	15	Completed	Web	\N	2026-10-20 13:20:00+00	2026-10-20 14:05:00+00
177	121	1022	6	\N	2026-10-20	79	15	No Show	Phone	1030	\N	\N
178	120	1004	5	40	2026-10-20	78	17	No Show	Web	\N	\N	\N
179	102	1005	6	41	2026-10-20	59	18	No Show	Web	\N	\N	\N
180	102	1006	6	31	2026-10-20	51	19	Cancelled	Web	\N	\N	\N
181	106	1024	6	42	2026-10-20	51	17	Completed	Web	\N	2026-10-20 20:50:00+00	2026-10-20 21:35:00+00
182	107	1001	5	\N	2026-10-21	53	15	Completed	Web	\N	2026-10-21 18:50:00+00	2026-10-21 19:35:00+00
183	125	1001	5	\N	2026-10-21	64	15	Cancelled	Web	\N	\N	\N
184	113	1001	5	\N	2026-10-21	49	15	Cancelled	Web	\N	\N	\N
185	105	1002	6	\N	2026-10-21	50	15	Completed	Phone	1029	2026-10-21 17:50:00+00	2026-10-21 18:35:00+00
186	112	1002	6	\N	2026-10-21	70	15	No Show	Phone	1030	\N	\N
187	109	1002	6	\N	2026-10-21	69	15	Completed	Phone	1029	2026-10-21 15:20:00+00	2026-10-21 16:05:00+00
188	119	1003	5	\N	2026-10-21	53	16	Cancelled	Web	\N	\N	\N
189	114	1003	5	\N	2026-10-21	78	16	Completed	Phone	1014	2026-10-21 12:50:00+00	2026-10-21 13:35:00+00
190	121	1003	5	\N	2026-10-21	59	16	No Show	Phone	1014	\N	\N
191	125	1021	6	\N	2026-10-21	53	16	Completed	Web	\N	2026-10-21 18:50:00+00	2026-10-21 19:35:00+00
192	114	1021	6	\N	2026-10-21	61	16	No Show	Web	\N	\N	\N
193	113	1021	6	\N	2026-10-21	70	16	Completed	Web	\N	2026-10-21 16:20:00+00	2026-10-21 17:05:00+00
194	124	1022	6	\N	2026-10-21	57	15	Completed	Web	\N	2026-10-21 14:50:00+00	2026-10-21 15:35:00+00
195	121	1022	6	\N	2026-10-21	76	15	Completed	Web	\N	2026-10-21 21:20:00+00	2026-10-21 22:05:00+00
196	108	1006	5	43	2026-10-21	72	19	Completed	Phone	1014	2026-10-21 18:20:00+00	2026-10-21 19:05:00+00
197	119	1007	6	36	2026-10-21	63	20	Completed	Phone	1029	2026-10-21 19:50:00+00	2026-10-21 20:35:00+00
198	105	1008	5	37	2026-10-21	55	21	Completed	Web	\N	2026-10-21 14:20:00+00	2026-10-21 15:05:00+00
199	126	1023	5	44	2026-10-21	69	20	Completed	Phone	1014	2026-10-21 15:20:00+00	2026-10-21 16:05:00+00
200	115	1001	5	\N	2026-10-22	72	15	No Show	Phone	1015	\N	\N
201	109	1002	6	\N	2026-10-22	59	15	Completed	Web	\N	2026-10-22 13:20:00+00	2026-10-22 14:05:00+00
202	105	1002	6	\N	2026-10-22	49	15	Completed	Web	\N	2026-10-22 15:50:00+00	2026-10-22 16:35:00+00
203	123	1002	6	\N	2026-10-22	78	15	Completed	Web	\N	2026-10-22 12:50:00+00	2026-10-22 13:35:00+00
204	106	1003	5	\N	2026-10-22	76	16	Completed	Web	\N	2026-10-22 21:20:00+00	2026-10-22 22:05:00+00
205	115	1003	5	\N	2026-10-22	62	16	Completed	Phone	1028	2026-10-22 20:20:00+00	2026-10-22 21:05:00+00
206	119	1003	5	\N	2026-10-22	78	16	Completed	Web	\N	2026-10-22 12:50:00+00	2026-10-22 13:35:00+00
207	113	1021	6	\N	2026-10-22	69	16	Completed	Web	\N	2026-10-22 15:20:00+00	2026-10-22 16:05:00+00
208	120	1022	6	\N	2026-10-22	60	15	Completed	Phone	1016	2026-10-22 12:50:00+00	2026-10-22 13:35:00+00
209	114	1005	6	46	2026-10-22	55	18	Completed	Web	\N	2026-10-22 14:20:00+00	2026-10-22 15:05:00+00
210	129	1006	5	48	2026-10-22	63	19	Completed	Web	\N	2026-10-22 19:50:00+00	2026-10-22 20:35:00+00
211	106	1024	6	42	2026-10-22	70	17	Completed	Phone	1030	2026-10-22 16:20:00+00	2026-10-22 17:05:00+00
212	103	1001	5	\N	2026-10-23	78	15	No Show	Web	\N	\N	\N
213	109	1002	6	\N	2026-10-23	62	15	Completed	Phone	1016	2026-10-23 20:20:00+00	2026-10-23 21:05:00+00
214	106	1003	5	\N	2026-10-23	53	16	Cancelled	Phone	1015	\N	\N
215	115	1003	5	\N	2026-10-23	62	16	Completed	Phone	1028	2026-10-23 20:20:00+00	2026-10-23 21:05:00+00
216	113	1021	6	\N	2026-10-23	55	16	Completed	Web	\N	2026-10-23 14:20:00+00	2026-10-23 15:05:00+00
217	125	1021	6	\N	2026-10-23	50	16	Completed	Web	\N	2026-10-23 17:50:00+00	2026-10-23 18:35:00+00
218	127	1022	6	\N	2026-10-23	49	15	No Show	Web	\N	\N	\N
219	106	1005	6	49	2026-10-23	51	18	Completed	Web	\N	2026-10-23 20:50:00+00	2026-10-23 21:35:00+00
220	104	1006	5	50	2026-10-23	51	19	Completed	Web	\N	2026-10-23 20:50:00+00	2026-10-23 21:35:00+00
221	109	1007	6	51	2026-10-23	57	20	No Show	Web	\N	\N	\N
222	110	1001	5	\N	2026-10-26	72	15	No Show	Phone	1014	\N	\N
223	105	1002	6	\N	2026-10-26	59	15	Completed	Web	\N	2026-10-26 13:20:00+00	2026-10-26 14:05:00+00
224	119	1003	5	\N	2026-10-26	72	16	Completed	Phone	1028	2026-10-26 18:20:00+00	2026-10-26 19:05:00+00
225	129	1003	5	\N	2026-10-26	62	16	Completed	Phone	1015	2026-10-26 20:20:00+00	2026-10-26 21:05:00+00
226	102	1021	6	\N	2026-10-26	49	16	Completed	Web	\N	2026-10-26 15:50:00+00	2026-10-26 16:35:00+00
227	125	1021	6	\N	2026-10-26	64	16	Completed	Phone	1030	2026-10-26 13:50:00+00	2026-10-26 14:35:00+00
228	127	1022	6	\N	2026-10-26	63	15	Completed	Phone	1029	2026-10-26 19:50:00+00	2026-10-26 20:35:00+00
229	126	1004	5	52	2026-10-26	59	17	Completed	Web	\N	2026-10-26 13:20:00+00	2026-10-26 14:05:00+00
230	125	1005	6	53	2026-10-26	50	18	Completed	Phone	1030	2026-10-26 17:50:00+00	2026-10-26 18:35:00+00
231	103	1006	5	54	2026-10-26	50	19	Completed	Phone	1028	2026-10-26 17:50:00+00	2026-10-26 18:35:00+00
232	129	1007	6	55	2026-10-26	78	20	Completed	Phone	1029	2026-10-26 12:50:00+00	2026-10-26 13:35:00+00
233	109	1008	5	56	2026-10-26	72	21	Completed	Web	\N	2026-10-26 18:20:00+00	2026-10-26 19:05:00+00
234	105	1023	5	57	2026-10-26	76	20	Completed	Phone	1014	2026-10-26 21:20:00+00	2026-10-26 22:05:00+00
235	101	1001	5	\N	2026-10-27	57	15	Completed	Phone	1015	2026-10-27 14:50:00+00	2026-10-27 15:35:00+00
236	126	1002	5	\N	2026-10-27	76	15	Completed	Phone	1015	2026-10-27 21:20:00+00	2026-10-27 22:05:00+00
237	123	1002	5	\N	2026-10-27	63	15	No Show	Phone	1028	\N	\N
238	110	1002	5	\N	2026-10-27	57	15	Completed	Phone	1028	2026-10-27 14:50:00+00	2026-10-27 15:35:00+00
239	104	1003	5	\N	2026-10-27	78	16	Completed	Phone	1028	2026-10-27 12:50:00+00	2026-10-27 13:35:00+00
240	1	1021	6	\N	2026-10-27	57	16	Completed	Phone	1029	2026-10-27 14:50:00+00	2026-10-27 15:35:00+00
241	113	1021	6	\N	2026-10-27	70	16	Completed	Phone	1029	2026-10-27 16:20:00+00	2026-10-27 17:05:00+00
242	125	1021	6	\N	2026-10-27	53	16	Completed	Phone	1029	2026-10-27 18:50:00+00	2026-10-27 19:35:00+00
243	120	1022	6	\N	2026-10-27	74	15	Completed	Phone	1030	2026-10-27 13:20:00+00	2026-10-27 14:05:00+00
244	121	1022	6	\N	2026-10-27	54	15	Completed	Web	\N	2026-10-27 15:20:00+00	2026-10-27 16:05:00+00
245	120	1004	5	40	2026-10-27	78	17	Completed	Web	\N	2026-10-27 12:50:00+00	2026-10-27 13:35:00+00
246	101	1005	6	58	2026-10-27	51	18	Completed	Phone	1029	2026-10-27 20:50:00+00	2026-10-27 21:35:00+00
247	108	1006	6	43	2026-10-27	53	19	Completed	Phone	1016	2026-10-27 18:50:00+00	2026-10-27 19:35:00+00
248	113	1007	6	59	2026-10-27	51	20	Completed	Phone	1030	2026-10-27 20:50:00+00	2026-10-27 21:35:00+00
249	126	1024	6	60	2026-10-27	57	17	Completed	Web	\N	2026-10-27 14:50:00+00	2026-10-27 15:35:00+00
250	116	1001	5	\N	2026-10-28	61	15	Completed	Web	\N	2026-10-28 19:20:00+00	2026-10-28 20:05:00+00
251	119	1001	5	\N	2026-10-28	53	15	Completed	Web	\N	2026-10-28 18:50:00+00	2026-10-28 19:35:00+00
252	110	1001	5	\N	2026-10-28	51	15	Completed	Web	\N	2026-10-28 20:50:00+00	2026-10-28 21:35:00+00
253	109	1002	6	\N	2026-10-28	69	15	Completed	Phone	1016	2026-10-28 15:20:00+00	2026-10-28 16:05:00+00
254	118	1002	6	\N	2026-10-28	72	15	Completed	Phone	1030	2026-10-28 18:20:00+00	2026-10-28 19:05:00+00
255	104	1003	5	\N	2026-10-28	78	16	Completed	Web	\N	2026-10-28 12:50:00+00	2026-10-28 13:35:00+00
256	119	1003	5	\N	2026-10-28	50	16	Completed	Phone	1014	2026-10-28 17:50:00+00	2026-10-28 18:35:00+00
257	114	1003	5	\N	2026-10-28	57	16	Completed	Web	\N	2026-10-28 14:50:00+00	2026-10-28 15:35:00+00
258	103	1021	6	\N	2026-10-28	62	16	Completed	Web	\N	2026-10-28 20:20:00+00	2026-10-28 21:05:00+00
259	120	1022	6	\N	2026-10-28	59	15	Completed	Web	\N	2026-10-28 13:20:00+00	2026-10-28 14:05:00+00
260	124	1022	6	\N	2026-10-28	55	15	Completed	Phone	1030	2026-10-28 14:20:00+00	2026-10-28 15:05:00+00
261	116	1004	5	61	2026-10-28	63	17	Completed	Phone	1014	2026-10-28 19:50:00+00	2026-10-28 20:35:00+00
262	120	1005	6	62	2026-10-28	55	18	No Show	Phone	1030	\N	\N
263	123	1006	5	63	2026-10-28	50	19	Completed	Web	\N	2026-10-28 17:50:00+00	2026-10-28 18:35:00+00
264	102	1007	6	64	2026-10-28	59	20	Completed	Web	\N	2026-10-28 13:20:00+00	2026-10-28 14:05:00+00
265	124	1023	5	65	2026-10-28	59	20	Completed	Web	\N	2026-10-28 13:20:00+00	2026-10-28 14:05:00+00
266	109	1001	5	\N	2026-10-29	78	15	Completed	Web	\N	2026-10-29 12:50:00+00	2026-10-29 13:35:00+00
267	112	1001	5	\N	2026-10-29	69	15	Completed	Phone	1014	2026-10-29 15:20:00+00	2026-10-29 16:05:00+00
268	111	1002	6	\N	2026-10-29	61	15	No Show	Web	\N	\N	\N
269	118	1002	6	\N	2026-10-29	57	15	Completed	Web	\N	2026-10-29 14:50:00+00	2026-10-29 15:35:00+00
270	109	1002	6	\N	2026-10-29	53	15	Completed	Web	\N	2026-10-29 18:50:00+00	2026-10-29 19:35:00+00
271	114	1003	5	\N	2026-10-29	57	16	Completed	Phone	1015	2026-10-29 14:50:00+00	2026-10-29 15:35:00+00
272	106	1003	5	\N	2026-10-29	51	16	Completed	Phone	1015	2026-10-29 20:50:00+00	2026-10-29 21:35:00+00
273	115	1003	5	\N	2026-10-29	50	16	Completed	Web	\N	2026-10-29 17:50:00+00	2026-10-29 18:35:00+00
274	116	1021	6	\N	2026-10-29	49	16	Completed	Web	\N	2026-10-29 15:50:00+00	2026-10-29 16:35:00+00
275	127	1022	6	\N	2026-10-29	60	15	Completed	Web	\N	2026-10-29 12:50:00+00	2026-10-29 13:35:00+00
276	124	1022	6	\N	2026-10-29	66	15	Completed	Web	\N	2026-10-29 15:50:00+00	2026-10-29 16:35:00+00
277	121	1022	6	\N	2026-10-29	56	15	No Show	Web	\N	\N	\N
278	114	1005	6	46	2026-10-29	50	18	Completed	Phone	1029	2026-10-29 17:50:00+00	2026-10-29 18:35:00+00
279	104	1006	5	50	2026-10-29	50	19	Completed	Web	\N	2026-10-29 17:50:00+00	2026-10-29 18:35:00+00
280	108	1001	5	\N	2026-10-30	55	15	Completed	Phone	1014	2026-10-30 14:20:00+00	2026-10-30 15:05:00+00
281	123	1002	6	\N	2026-10-30	76	15	Completed	Web	\N	2026-10-30 21:20:00+00	2026-10-30 22:05:00+00
282	123	1002	6	\N	2026-10-30	63	15	Completed	Web	\N	2026-10-30 19:50:00+00	2026-10-30 20:35:00+00
283	120	1002	6	\N	2026-10-30	55	15	Completed	Web	\N	2026-10-30 14:20:00+00	2026-10-30 15:05:00+00
284	114	1003	5	\N	2026-10-30	50	16	Completed	Web	\N	2026-10-30 17:50:00+00	2026-10-30 18:35:00+00
285	1	1021	6	\N	2026-10-30	49	16	No Show	Web	\N	\N	\N
286	104	1021	6	\N	2026-10-30	57	16	Completed	Web	\N	2026-10-30 14:50:00+00	2026-10-30 15:35:00+00
287	124	1022	6	\N	2026-10-30	50	15	Cancelled	Phone	1029	\N	\N
288	125	1006	5	68	2026-10-30	70	19	Completed	Web	\N	2026-10-30 16:20:00+00	2026-10-30 17:05:00+00
289	113	1024	6	69	2026-10-30	64	17	Completed	Phone	1016	2026-10-30 13:50:00+00	2026-10-30 14:35:00+00
290	116	1001	5	\N	2026-11-02	55	15	Completed	Web	\N	2026-11-02 15:20:00+00	2026-11-02 16:05:00+00
291	116	1001	5	\N	2026-11-02	72	15	No Show	Phone	1014	\N	\N
292	101	1001	5	\N	2026-11-02	78	15	Completed	Web	\N	2026-11-02 13:50:00+00	2026-11-02 14:35:00+00
293	118	1002	6	\N	2026-11-02	72	15	Completed	Phone	1029	2026-11-02 19:20:00+00	2026-11-02 20:05:00+00
294	123	1002	6	\N	2026-11-02	53	15	No Show	Phone	1030	\N	\N
295	126	1002	6	\N	2026-11-02	49	15	Completed	Web	\N	2026-11-02 16:50:00+00	2026-11-02 17:35:00+00
296	115	1003	5	\N	2026-11-02	50	16	Completed	Web	\N	2026-11-02 18:50:00+00	2026-11-02 19:35:00+00
297	118	1021	6	\N	2026-11-02	62	16	Completed	Phone	1030	2026-11-02 21:20:00+00	2026-11-02 22:05:00+00
298	108	1021	6	\N	2026-11-02	64	16	Cancelled	Web	\N	\N	\N
299	110	1021	6	\N	2026-11-02	61	16	Completed	Web	\N	2026-11-02 20:20:00+00	2026-11-02 21:05:00+00
300	111	1022	6	\N	2026-11-02	59	15	Completed	Phone	1030	2026-11-02 14:20:00+00	2026-11-02 15:05:00+00
301	103	1005	6	70	2026-11-02	78	18	Completed	Web	\N	2026-11-02 13:50:00+00	2026-11-02 14:35:00+00
302	107	1006	5	71	2026-11-02	70	19	Completed	Phone	1028	2026-11-02 17:20:00+00	2026-11-02 18:05:00+00
303	126	1007	6	72	2026-11-02	62	20	Completed	Web	\N	2026-11-02 21:20:00+00	2026-11-02 22:05:00+00
304	103	1008	5	73	2026-11-02	63	21	Completed	Web	\N	2026-11-02 20:50:00+00	2026-11-02 21:35:00+00
305	114	1023	5	74	2026-11-02	61	20	Completed	Web	\N	2026-11-02 20:20:00+00	2026-11-02 21:05:00+00
306	103	1001	5	\N	2026-11-03	61	15	No Show	Web	\N	\N	\N
307	129	1002	5	\N	2026-11-03	57	15	Completed	Web	\N	2026-11-03 15:50:00+00	2026-11-03 16:35:00+00
308	129	1002	5	\N	2026-11-03	55	15	Completed	Web	\N	2026-11-03 15:20:00+00	2026-11-03 16:05:00+00
309	118	1002	5	\N	2026-11-03	72	15	Completed	Phone	1014	2026-11-03 19:20:00+00	2026-11-03 20:05:00+00
339	127	1024	6	84	2026-11-05	61	17	No Show	Phone	1016	\N	\N
310	104	1003	5	\N	2026-11-03	72	16	Completed	Web	\N	2026-11-03 19:20:00+00	2026-11-03 20:05:00+00
311	104	1003	5	\N	2026-11-03	57	16	Completed	Phone	1028	2026-11-03 15:50:00+00	2026-11-03 16:35:00+00
312	104	1003	5	\N	2026-11-03	50	16	Completed	Web	\N	2026-11-03 18:50:00+00	2026-11-03 19:35:00+00
313	125	1021	6	\N	2026-11-03	57	16	Completed	Web	\N	2026-11-03 15:50:00+00	2026-11-03 16:35:00+00
331	118	1002	6	\N	2026-11-05	50	15	Completed	Web	\N	2026-11-05 18:57:00+00	2026-11-05 19:47:00+00
314	111	1021	6	\N	2026-11-03	72	16	Completed	Web	\N	2026-11-03 19:20:00+00	2026-11-03 20:05:00+00
315	121	1022	6	\N	2026-11-03	56	15	Completed	Phone	1030	2026-11-03 17:20:00+00	2026-11-03 18:05:00+00
330	117	1001	5	\N	2026-11-05	72	15	Completed	Web	\N	2026-11-05 19:18:00+00	2026-11-05 20:18:00+00
316	124	1023	5	65	2026-11-03	76	20	Completed	Web	\N	2026-11-03 22:20:00+00	2026-11-03 23:05:00+00
317	112	1024	6	77	2026-11-03	61	17	Cancelled	Web	\N	\N	\N
318	103	1001	5	\N	2026-11-04	51	15	Completed	Web	\N	2026-11-04 21:50:00+00	2026-11-04 22:35:00+00
332	114	1003	5	\N	2026-11-05	61	16	Completed	Phone	1014	2026-11-05 20:19:00+00	2026-11-05 21:07:00+00
319	105	1002	6	\N	2026-11-04	59	15	Completed	Web	\N	2026-11-04 14:20:00+00	2026-11-04 15:05:00+00
320	123	1003	5	\N	2026-11-04	55	16	Completed	Phone	1028	2026-11-04 15:20:00+00	2026-11-04 16:05:00+00
329	117	1001	5	\N	2026-11-05	63	15	Completed	Web	\N	2026-11-05 20:46:00+00	2026-11-05 21:30:00+00
321	116	1021	6	\N	2026-11-04	61	16	Completed	Web	\N	2026-11-04 20:20:00+00	2026-11-04 21:05:00+00
322	113	1021	6	\N	2026-11-04	51	16	Completed	Phone	1016	2026-11-04 21:50:00+00	2026-11-04 22:35:00+00
323	114	1022	6	\N	2026-11-04	53	15	No Show	Web	\N	\N	\N
328	103	1001	5	\N	2026-11-05	51	15	Completed	Phone	1014	2026-11-05 21:49:00+00	2026-11-05 22:26:00+00
324	128	1022	6	\N	2026-11-04	57	15	Completed	Phone	1030	2026-11-04 15:50:00+00	2026-11-04 16:35:00+00
325	116	1007	6	78	2026-11-04	78	20	Completed	Phone	1029	2026-11-04 13:50:00+00	2026-11-04 14:35:00+00
337	114	1006	5	82	2026-11-05	76	19	Completed	Phone	1015	2026-11-05 22:20:00+00	2026-11-05 23:03:00+00
326	106	1008	5	79	2026-11-04	53	21	Completed	Phone	1015	2026-11-04 19:50:00+00	2026-11-04 20:35:00+00
327	119	1024	6	80	2026-11-04	57	17	Completed	Web	\N	2026-11-04 15:50:00+00	2026-11-04 16:35:00+00
333	113	1021	6	\N	2026-11-05	49	16	Completed	Phone	1016	2026-11-05 16:50:00+00	2026-11-05 17:35:00+00
334	125	1021	6	\N	2026-11-05	70	16	Completed	Phone	1030	2026-11-05 17:20:00+00	2026-11-05 18:05:00+00
335	120	1022	6	\N	2026-11-05	56	15	Completed	Web	\N	2026-11-05 17:20:00+00	2026-11-05 18:05:00+00
336	104	1005	6	81	2026-11-05	78	18	Completed	Phone	1016	2026-11-05 13:50:00+00	2026-11-05 14:35:00+00
338	112	1008	5	83	2026-11-05	78	21	Completed	Phone	1015	2026-11-05 13:50:00+00	2026-11-05 14:35:00+00
374	129	1002	6	\N	2026-11-11	55	15	Cancelled	Phone	1016	\N	\N
389	1	1021	6	\N	2026-11-12	62	16	Cancelled	Web	\N	\N	\N
412	117	1001	5	\N	2026-11-16	69	15	Scheduled	Web	\N	\N	\N
413	102	1002	6	\N	2026-11-16	72	15	Scheduled	Phone	1029	\N	\N
414	118	1002	6	\N	2026-11-16	69	15	Scheduled	Phone	1030	\N	\N
415	115	1003	5	\N	2026-11-16	53	16	Scheduled	Phone	1015	\N	\N
416	115	1003	5	\N	2026-11-16	49	16	Scheduled	Phone	1014	\N	\N
417	125	1021	6	\N	2026-11-16	49	16	Scheduled	Web	\N	\N	\N
418	127	1022	6	\N	2026-11-16	62	15	Scheduled	Web	\N	\N	\N
419	111	1022	6	\N	2026-11-16	57	15	Scheduled	Phone	1030	\N	\N
420	114	1005	6	46	2026-11-16	70	18	Scheduled	Web	\N	\N	\N
421	107	1006	5	71	2026-11-16	50	19	Scheduled	Phone	1015	\N	\N
422	116	1007	6	78	2026-11-16	62	20	Scheduled	Phone	1030	\N	\N
423	124	1008	5	98	2026-11-16	62	21	Scheduled	Phone	1014	\N	\N
424	103	1001	5	\N	2026-11-17	70	15	Scheduled	Web	\N	\N	\N
425	129	1002	5	\N	2026-11-17	76	15	Scheduled	Web	\N	\N	\N
427	114	1003	5	\N	2026-11-17	76	16	Cancelled	Web	\N	\N	\N
428	115	1003	5	\N	2026-11-17	50	16	Cancelled	Web	\N	\N	\N
429	1	1021	6	\N	2026-11-17	57	16	Scheduled	Web	\N	\N	\N
430	124	1022	6	\N	2026-11-17	56	15	Scheduled	Web	\N	\N	\N
431	105	1005	6	30	2026-11-17	63	18	Scheduled	Web	\N	\N	\N
386	114	1003	5	\N	2026-11-12	62	16	No Show	Phone	1014	\N	\N
397	110	1001	5	\N	2026-11-13	64	15	No Show	Phone	1014	\N	\N
346	110	1022	6	\N	2026-11-06	57	15	No Show	Web	\N	\N	\N
399	103	1001	5	\N	2026-11-13	78	15	No Show	Web	\N	\N	\N
400	106	1002	6	\N	2026-11-13	59	15	No Show	Web	\N	\N	\N
401	105	1002	6	\N	2026-11-13	70	15	No Show	Phone	1030	\N	\N
345	111	1022	6	\N	2026-11-06	51	15	No Show	Phone	1029	\N	\N
350	124	1002	6	\N	2026-11-09	78	15	No Show	Phone	1029	\N	\N
402	123	1002	6	\N	2026-11-13	64	15	No Show	Web	\N	\N	\N
404	119	1003	5	\N	2026-11-13	69	16	No Show	Web	\N	\N	\N
406	1	1021	6	\N	2026-11-13	70	16	No Show	Phone	1016	\N	\N
407	127	1022	6	\N	2026-11-13	69	15	No Show	Web	\N	\N	\N
408	114	1005	6	46	2026-11-13	57	18	No Show	Web	\N	\N	\N
355	128	1022	6	\N	2026-11-09	72	15	No Show	Web	\N	\N	\N
348	107	1001	5	\N	2026-11-09	61	15	No Show	Phone	1028	\N	\N
409	110	1007	6	96	2026-11-13	78	20	No Show	Web	\N	\N	\N
410	110	1008	5	33	2026-11-13	57	21	No Show	Phone	1014	\N	\N
398	129	1001	5	\N	2026-11-13	62	15	No Show	Web	\N	\N	\N
403	114	1003	5	\N	2026-11-13	50	16	No Show	Phone	1028	\N	\N
405	103	1003	5	\N	2026-11-13	63	16	No Show	Phone	1028	\N	\N
411	120	1024	6	97	2026-11-13	76	17	No Show	Web	\N	\N	\N
372	123	1001	5	\N	2026-11-11	62	15	Scheduled	Phone	1015	2026-11-11 19:23:02.155663+00	\N
382	101	1001	5	\N	2026-11-12	55	15	Cancelled	Phone	1015	\N	\N
426	101	1002	5	\N	2026-11-17	63	15	Cancelled	Web	\N	\N	\N
383	103	1001	5	\N	2026-11-12	78	15	No Show	Phone	1014	\N	\N
395	109	1008	5	56	2026-11-12	57	21	No Show	Web	\N	\N	\N
384	109	1002	6	\N	2026-11-12	50	15	No Show	Web	\N	\N	\N
385	109	1002	6	\N	2026-11-12	76	15	Completed	Web	\N	2026-11-12 20:44:43.655517+00	2026-11-12 20:46:44.481835+00
340	112	1001	5	\N	2026-11-06	78	15	Completed	Web	\N	2026-11-06 13:49:00+00	2026-11-06 14:31:00+00
342	118	1003	5	\N	2026-11-06	69	16	Completed	Phone	1015	2026-11-06 16:24:00+00	2026-11-06 17:07:00+00
432	119	1006	6	35	2026-11-17	49	19	Scheduled	Web	\N	\N	\N
433	120	1023	5	99	2026-11-17	55	20	Scheduled	Web	\N	\N	\N
434	116	1001	5	\N	2026-11-18	63	15	Cancelled	Phone	1028	\N	\N
435	116	1001	5	\N	2026-11-18	64	15	Scheduled	Web	\N	\N	\N
436	103	1001	5	\N	2026-11-18	51	15	Scheduled	Web	\N	\N	\N
437	129	1002	6	\N	2026-11-18	78	15	Scheduled	Phone	1016	\N	\N
438	109	1002	6	\N	2026-11-18	63	15	Scheduled	Phone	1029	\N	\N
439	101	1002	6	\N	2026-11-18	76	15	Scheduled	Phone	1030	\N	\N
440	121	1003	5	\N	2026-11-18	62	16	Scheduled	Web	\N	\N	\N
441	106	1003	5	\N	2026-11-18	70	16	Scheduled	Phone	1028	\N	\N
443	113	1021	6	\N	2026-11-18	55	16	Scheduled	Web	\N	\N	\N
444	113	1021	6	\N	2026-11-18	78	16	Scheduled	Web	\N	\N	\N
445	117	1022	6	\N	2026-11-18	50	15	Scheduled	Web	\N	\N	\N
446	119	1004	5	100	2026-11-18	50	17	Scheduled	Phone	1015	\N	\N
447	128	1006	5	101	2026-11-18	70	19	Scheduled	Phone	1014	\N	\N
448	121	1007	6	102	2026-11-18	64	20	Scheduled	Phone	1016	\N	\N
449	129	1023	5	91	2026-11-18	50	20	Scheduled	Phone	1015	\N	\N
450	103	1024	6	103	2026-11-18	69	17	Scheduled	Web	\N	\N	\N
451	126	1001	5	\N	2026-11-19	72	15	Scheduled	Phone	1015	\N	\N
452	102	1002	6	\N	2026-11-19	78	15	Scheduled	Web	\N	\N	\N
453	114	1003	5	\N	2026-11-19	53	16	Scheduled	Web	\N	\N	\N
454	128	1003	5	\N	2026-11-19	57	16	Cancelled	Web	\N	\N	\N
455	104	1003	5	\N	2026-11-19	64	16	Scheduled	Web	\N	\N	\N
456	1	1021	6	\N	2026-11-19	57	16	Scheduled	Phone	1030	\N	\N
457	128	1022	6	\N	2026-11-19	71	15	Scheduled	Phone	1016	\N	\N
458	120	1022	6	\N	2026-11-19	73	15	Scheduled	Phone	1016	\N	\N
459	120	1022	6	\N	2026-11-19	74	15	Scheduled	Phone	1029	\N	\N
460	112	1005	6	104	2026-11-19	55	18	Scheduled	Phone	1030	\N	\N
461	102	1006	5	31	2026-11-19	61	19	Scheduled	Phone	1014	\N	\N
462	1	1007	6	105	2026-11-19	72	20	Cancelled	Web	\N	\N	\N
463	109	1008	5	56	2026-11-19	57	21	Scheduled	Phone	1015	\N	\N
464	112	1001	5	\N	2026-11-20	50	15	Scheduled	Web	\N	\N	\N
466	116	1002	6	\N	2026-11-20	78	15	Scheduled	Phone	1016	\N	\N
467	119	1003	5	\N	2026-11-20	72	16	Scheduled	Web	\N	\N	\N
468	114	1003	5	\N	2026-11-20	51	16	Scheduled	Web	\N	\N	\N
469	1	1003	5	\N	2026-11-20	62	16	Scheduled	Web	\N	\N	\N
470	101	1021	6	\N	2026-11-20	49	16	Cancelled	Web	\N	\N	\N
471	107	1022	6	\N	2026-11-20	78	15	Scheduled	Phone	1030	\N	\N
472	123	1005	6	106	2026-11-20	51	18	Cancelled	Web	\N	\N	\N
473	114	1006	5	82	2026-11-20	78	19	Scheduled	Web	\N	\N	\N
474	115	1024	6	107	2026-11-20	78	17	Scheduled	Web	\N	\N	\N
475	111	1001	5	\N	2026-11-23	72	15	Scheduled	Phone	1014	\N	\N
476	116	1001	5	\N	2026-11-23	63	15	Cancelled	Phone	1014	\N	\N
477	125	1002	6	\N	2026-11-23	61	15	Scheduled	Phone	1030	\N	\N
478	106	1003	5	\N	2026-11-23	57	16	Cancelled	Web	\N	\N	\N
479	114	1003	5	\N	2026-11-23	78	16	Scheduled	Web	\N	\N	\N
480	125	1021	6	\N	2026-11-23	62	16	Scheduled	Web	\N	\N	\N
481	113	1021	6	\N	2026-11-23	59	16	Scheduled	Phone	1030	\N	\N
482	121	1022	6	\N	2026-11-23	61	15	Scheduled	Web	\N	\N	\N
483	105	1023	5	57	2026-11-23	72	20	Scheduled	Web	\N	\N	\N
484	112	1001	5	\N	2026-11-24	59	15	Scheduled	Web	\N	\N	\N
485	112	1001	5	\N	2026-11-24	69	15	Scheduled	Web	\N	\N	\N
486	109	1002	5	\N	2026-11-24	72	15	Scheduled	Phone	1015	\N	\N
487	109	1002	5	\N	2026-11-24	78	15	Scheduled	Web	\N	\N	\N
488	115	1003	5	\N	2026-11-24	76	16	Scheduled	Phone	1028	\N	\N
489	109	1003	5	\N	2026-11-24	53	16	Scheduled	Phone	1014	\N	\N
490	113	1021	6	\N	2026-11-24	76	16	Cancelled	Web	\N	\N	\N
491	128	1022	6	\N	2026-11-24	56	15	Scheduled	Web	\N	\N	\N
492	111	1022	6	\N	2026-11-24	60	15	Scheduled	Web	\N	\N	\N
493	105	1022	6	\N	2026-11-24	79	15	Scheduled	Web	\N	\N	\N
494	111	1006	6	95	2026-11-24	63	19	Scheduled	Web	\N	\N	\N
495	118	1023	5	108	2026-11-24	78	20	Scheduled	Phone	1014	\N	\N
496	101	1001	5	\N	2026-11-25	57	15	Scheduled	Web	\N	\N	\N
497	112	1001	5	\N	2026-11-25	55	15	Scheduled	Web	\N	\N	\N
498	112	1001	5	\N	2026-11-25	49	15	Scheduled	Web	\N	\N	\N
499	118	1002	6	\N	2026-11-25	72	15	Scheduled	Web	\N	\N	\N
500	119	1003	5	\N	2026-11-25	53	16	Scheduled	Web	\N	\N	\N
501	104	1003	5	\N	2026-11-25	63	16	Scheduled	Phone	1028	\N	\N
502	115	1003	5	\N	2026-11-25	78	16	Scheduled	Phone	1028	\N	\N
503	113	1021	6	\N	2026-11-25	78	16	Scheduled	Phone	1016	\N	\N
505	124	1022	6	\N	2026-11-25	64	15	Scheduled	Phone	1029	\N	\N
506	127	1004	5	85	2026-11-25	62	17	Scheduled	Web	\N	\N	\N
507	123	1006	5	63	2026-11-25	53	19	Scheduled	Web	\N	\N	\N
508	112	1007	6	109	2026-11-25	50	20	Scheduled	Phone	1029	\N	\N
509	106	1008	5	79	2026-11-25	70	21	Scheduled	Phone	1015	\N	\N
510	126	1024	6	60	2026-11-25	50	17	Cancelled	Web	\N	\N	\N
511	107	1001	5	\N	2026-11-26	69	15	Scheduled	Web	\N	\N	\N
512	109	1002	6	\N	2026-11-26	72	15	Scheduled	Web	\N	\N	\N
513	126	1002	6	\N	2026-11-26	53	15	Scheduled	Phone	1029	\N	\N
514	119	1003	5	\N	2026-11-26	72	16	Scheduled	Phone	1014	\N	\N
515	113	1021	6	\N	2026-11-26	53	16	Scheduled	Phone	1030	\N	\N
516	120	1022	6	\N	2026-11-26	73	15	Scheduled	Web	\N	\N	\N
517	101	1022	6	\N	2026-11-26	56	15	Scheduled	Web	\N	\N	\N
518	127	1006	5	110	2026-11-26	64	19	Scheduled	Web	\N	\N	\N
504	110	1021	6	\N	2026-11-25	59	16	Cancelled	Web	\N	\N	\N
465	110	1001	5	\N	2026-11-20	51	15	Cancelled	Web	\N	\N	\N
442	101	1003	5	\N	2026-11-18	59	16	Cancelled	Phone	1015	\N	\N
519	106	1008	5	79	2026-11-26	63	21	Scheduled	Web	\N	\N	\N
520	108	1023	5	111	2026-11-26	53	20	Cancelled	Web	\N	\N	\N
521	112	1001	5	\N	2026-11-27	63	15	Cancelled	Web	\N	\N	\N
522	103	1001	5	\N	2026-11-27	62	15	Scheduled	Web	\N	\N	\N
524	102	1002	6	\N	2026-11-27	61	15	Cancelled	Web	\N	\N	\N
525	118	1002	6	\N	2026-11-27	59	15	Scheduled	Phone	1029	\N	\N
526	109	1002	6	\N	2026-11-27	78	15	Scheduled	Web	\N	\N	\N
527	119	1003	5	\N	2026-11-27	57	16	Cancelled	Web	\N	\N	\N
528	103	1003	5	\N	2026-11-27	64	16	Scheduled	Web	\N	\N	\N
529	125	1021	6	\N	2026-11-27	62	16	Scheduled	Web	\N	\N	\N
530	112	1021	6	\N	2026-11-27	57	16	Scheduled	Web	\N	\N	\N
531	111	1022	6	\N	2026-11-27	64	15	Scheduled	Phone	1029	\N	\N
532	120	1022	6	\N	2026-11-27	55	15	Scheduled	Web	\N	\N	\N
533	120	1007	6	32	2026-11-27	57	20	Scheduled	Web	\N	\N	\N
534	126	1008	5	112	2026-11-27	63	21	Scheduled	Phone	1028	\N	\N
535	107	1001	5	\N	2026-11-30	59	15	Scheduled	Web	\N	\N	\N
536	119	1002	6	\N	2026-11-30	78	15	Scheduled	Web	\N	\N	\N
537	101	1002	6	\N	2026-11-30	70	15	Scheduled	Web	\N	\N	\N
538	105	1002	6	\N	2026-11-30	76	15	Scheduled	Web	\N	\N	\N
539	106	1003	5	\N	2026-11-30	63	16	Cancelled	Web	\N	\N	\N
540	103	1021	6	\N	2026-11-30	57	16	Scheduled	Web	\N	\N	\N
541	122	1022	6	\N	2026-11-30	57	15	Scheduled	Phone	1030	\N	\N
542	121	1022	6	\N	2026-11-30	53	15	Scheduled	Web	\N	\N	\N
543	106	1022	6	\N	2026-11-30	51	15	Scheduled	Phone	1030	\N	\N
544	128	1006	5	101	2026-11-30	70	19	Scheduled	Web	\N	\N	\N
545	113	1007	6	59	2026-11-30	49	20	Scheduled	Phone	1030	\N	\N
546	129	1023	5	91	2026-11-30	69	20	Scheduled	Phone	1015	\N	\N
590	110	1001	5	\N	2026-11-12	63	15	No Show	Web	\N	\N	\N
591	110	1001	5	\N	2026-11-12	62	15	No Show	Web	\N	\N	\N
593	110	1001	5	\N	2026-11-12	76	15	Scheduled	Web	\N	2026-11-12 22:01:57.576726+00	\N
554	110	1003	5	\N	2026-11-10	53	16	Scheduled	Web	\N	2026-11-10 17:48:02.877043+00	\N
592	110	1001	5	\N	2026-11-12	51	15	Scheduled	Web	\N	2026-11-12 22:01:58.686106+00	\N
564	110	1004	5	5	2026-11-13	59	17	No Show	Web	\N	\N	\N
565	110	1001	5	\N	2026-11-13	49	15	No Show	Web	\N	\N	\N
555	110	1021	6	\N	2026-11-10	61	16	No Show	Web	\N	\N	\N
563	110	1001	5	\N	2026-11-13	76	15	No Show	Web	\N	\N	\N
557	110	1006	5	28	2026-11-19	51	19	Scheduled	Web	\N	\N	\N
561	110	1002	6	\N	2026-11-18	53	15	Scheduled	Web	\N	\N	\N
523	110	1001	5	\N	2026-11-27	50	15	Cancelled	Phone	1015	\N	\N
547	110	1007	6	96	2026-11-27	61	20	Cancelled	Web	\N	\N	\N
560	110	1001	5	\N	2026-11-26	53	15	Cancelled	Web	\N	\N	\N
566	110	1001	5	\N	2026-11-17	53	15	Scheduled	Web	\N	\N	\N
567	110	1002	5	\N	2026-11-17	61	15	Scheduled	Web	\N	\N	\N
568	110	1022	6	\N	2026-12-30	51	15	Scheduled	Web	\N	\N	\N
569	110	1002	6	\N	2026-12-30	63	15	Scheduled	Web	\N	\N	\N
572	110	1002	6	\N	2026-12-31	72	15	Scheduled	Web	\N	\N	\N
573	119	1003	5	\N	2026-12-02	57	16	Cancelled	Web	\N	\N	\N
574	110	1001	5	\N	2026-11-11	72	15	Scheduled	Web	\N	2026-11-11 19:17:10.530837+00	\N
578	132	1002	6	\N	2026-11-26	61	15	Scheduled	Web	\N	\N	\N
579	132	1002	6	\N	2026-11-26	57	15	Scheduled	Web	\N	\N	\N
580	132	1022	6	\N	2026-11-25	53	15	Scheduled	Web	\N	\N	\N
581	132	1022	6	\N	2026-11-27	69	15	Scheduled	Web	\N	\N	\N
582	132	1003	5	\N	2026-11-26	64	16	Scheduled	Web	\N	\N	\N
583	132	1001	5	\N	2026-11-23	57	15	Scheduled	Web	\N	\N	\N
586	110	1002	6	\N	2026-11-18	55	15	Scheduled	Web	\N	\N	\N
570	110	1022	6	\N	2026-12-30	62	15	Cancelled	Web	\N	\N	\N
571	110	1022	6	\N	2026-12-24	60	15	Cancelled	Web	\N	\N	\N
587	101	1002	6	\N	2026-11-25	61	15	Scheduled	Web	\N	\N	\N
588	101	1001	5	\N	2026-11-24	61	15	Scheduled	Web	\N	\N	\N
589	101	1001	5	\N	2026-11-17	72	15	Cancelled	Web	\N	\N	\N
585	132	1002	6	\N	2026-11-12	57	15	No Show	Web	\N	\N	\N
562	110	1002	6	\N	2026-11-12	51	15	Cancelled	Web	\N	\N	\N
594	101	1001	5	\N	2026-11-19	55	15	Cancelled	Web	\N	\N	\N
595	101	1001	5	\N	2026-11-17	64	15	Cancelled	Web	\N	\N	\N
596	101	1001	5	\N	2026-11-18	55	15	Scheduled	Web	\N	\N	\N
344	123	1021	6	\N	2026-11-06	50	16	Completed	Web	\N	2026-11-06 18:48:00+00	2026-11-06 19:20:00+00
341	123	1002	6	\N	2026-11-06	72	15	Completed	Web	\N	2026-11-06 19:28:00+00	2026-11-06 20:15:00+00
347	127	1004	5	85	2026-11-06	72	17	Completed	Web	\N	2026-11-06 19:16:00+00	2026-11-06 20:01:00+00
343	108	1003	5	\N	2026-11-06	53	16	Completed	Phone	1028	2026-11-06 19:54:00+00	2026-11-06 20:37:00+00
548	110	1002	6	\N	2026-11-06	51	15	Completed	Web	\N	2026-11-06 21:47:00+00	2026-11-06 22:33:00+00
356	124	1004	5	86	2026-11-09	59	17	Completed	Web	\N	2026-11-09 14:19:00+00	2026-11-09 15:00:00+00
354	127	1022	6	\N	2026-11-09	55	15	Completed	Web	\N	2026-11-09 15:19:00+00	2026-11-09 16:10:00+00
359	101	1008	5	89	2026-11-09	55	21	Completed	Web	\N	2026-11-09 15:16:00+00	2026-11-09 16:05:00+00
351	118	1002	6	\N	2026-11-09	57	15	Completed	Phone	1030	2026-11-09 15:50:00+00	2026-11-09 16:45:00+00
358	108	1007	6	88	2026-11-09	57	20	Completed	Web	\N	2026-11-09 15:46:00+00	2026-11-09 16:25:00+00
353	119	1021	6	\N	2026-11-09	72	16	Completed	Phone	1016	2026-11-09 19:29:00+00	2026-11-09 20:08:00+00
349	101	1001	5	\N	2026-11-09	53	15	Completed	Phone	1015	2026-11-09 19:57:00+00	2026-11-09 20:43:00+00
550	110	1021	6	\N	2026-11-09	61	16	Completed	Web	\N	2026-11-09 20:30:00+00	2026-11-09 21:18:00+00
549	110	1021	6	\N	2026-11-09	63	16	Completed	Web	\N	2026-11-09 20:56:00+00	2026-11-09 21:41:00+00
352	115	1003	5	\N	2026-11-09	76	16	Completed	Web	\N	2026-11-09 22:15:00+00	2026-11-09 22:59:00+00
357	116	1006	5	87	2026-11-09	76	19	Completed	Web	\N	2026-11-09 22:27:00+00	2026-11-09 23:27:00+00
363	105	1002	5	\N	2026-11-10	59	15	Completed	Web	\N	2026-11-10 14:20:00+00	2026-11-10 15:02:00+00
364	114	1003	5	\N	2026-11-10	64	16	Completed	Phone	1015	2026-11-10 14:59:00+00	2026-11-10 15:40:00+00
368	112	1022	6	\N	2026-11-10	79	15	Completed	Web	\N	2026-11-10 14:52:00+00	2026-11-10 15:39:00+00
369	123	1004	5	90	2026-11-10	64	17	Completed	Phone	1015	2026-11-10 14:45:00+00	2026-11-10 15:44:00+00
370	104	1005	6	81	2026-11-10	55	18	Completed	Web	\N	2026-11-10 15:18:00+00	2026-11-10 16:15:00+00
367	120	1022	6	\N	2026-11-10	73	15	Completed	Phone	1016	2026-11-10 15:47:00+00	2026-11-10 16:23:00+00
366	120	1022	6	\N	2026-11-10	54	15	Completed	Web	\N	2026-11-10 16:27:00+00	2026-11-10 17:19:00+00
362	120	1002	5	\N	2026-11-10	49	15	Completed	Phone	1014	2026-11-10 16:51:00+00	2026-11-10 17:30:00+00
551	110	1021	6	\N	2026-11-10	70	16	Completed	Web	\N	2026-11-10 17:16:00+00	2026-11-10 18:03:00+00
94	103	1007	6	\N	2026-11-10	50	20	Completed	Phone	1015	2026-11-10 18:59:00+00	2026-11-10 19:45:00+00
361	123	1002	5	\N	2026-11-10	50	15	Completed	Phone	1014	2026-11-10 18:57:00+00	2026-11-10 19:54:00+00
553	110	1021	6	\N	2026-11-10	50	16	Completed	Web	\N	2026-11-10 18:53:00+00	2026-11-10 19:41:00+00
552	110	1002	5	\N	2026-11-10	72	15	Completed	Web	\N	2026-11-10 19:21:00+00	2026-11-10 20:05:00+00
556	110	1021	6	\N	2026-11-10	63	16	Completed	Web	\N	2026-11-10 20:55:00+00	2026-11-10 21:54:00+00
371	129	1023	5	91	2026-11-10	51	20	Completed	Phone	1015	2026-11-10 21:48:00+00	2026-11-10 22:30:00+00
360	103	1001	5	\N	2026-11-10	76	15	Completed	Phone	1028	2026-11-10 22:27:00+00	2026-11-10 23:16:00+00
365	122	1021	6	\N	2026-11-10	76	16	Completed	Web	\N	2026-11-10 22:20:00+00	2026-11-10 23:08:00+00
375	111	1003	5	\N	2026-11-11	78	16	Completed	Web	\N	2026-11-11 13:51:00+00	2026-11-11 14:29:00+00
558	110	1003	5	\N	2026-11-11	59	16	Completed	Web	\N	2026-11-11 14:22:00+00	2026-11-11 14:56:00+00
377	125	1021	6	\N	2026-11-11	49	16	Completed	Web	\N	2026-11-11 16:45:00+00	2026-11-11 17:25:00+00
379	129	1005	6	92	2026-11-11	49	18	Completed	Phone	1030	2026-11-11 16:53:00+00	2026-11-11 17:27:00+00
378	120	1022	6	\N	2026-11-11	70	15	Completed	Web	\N	2026-11-11 17:19:00+00	2026-11-11 18:03:00+00
380	101	1007	6	93	2026-11-11	50	20	Completed	Web	\N	2026-11-11 18:47:00+00	2026-11-11 19:35:00+00
575	131	1021	6	\N	2026-11-11	72	16	Completed	Web	\N	2026-11-11 19:30:00+00	2026-11-11 20:26:00+00
376	125	1021	6	\N	2026-11-11	61	16	Completed	Phone	1016	2026-11-11 20:18:00+00	2026-11-11 21:13:00+00
373	105	1002	6	\N	2026-11-11	63	15	Completed	Web	\N	2026-11-11 20:58:00+00	2026-11-11 21:43:00+00
559	130	1021	6	\N	2026-11-11	51	16	Completed	Web	\N	2026-11-11 21:57:00+00	2026-11-11 22:42:00+00
394	113	1007	6	59	2026-11-12	78	20	Completed	Web	\N	2026-11-12 13:52:00+00	2026-11-12 14:39:00+00
576	110	1021	6	\N	2026-11-12	78	16	Completed	Web	\N	2026-11-12 13:45:00+00	2026-11-12 14:32:00+00
577	110	1002	6	\N	2026-11-12	59	15	Completed	Web	\N	2026-11-12 14:16:00+00	2026-11-12 15:01:00+00
387	114	1003	5	\N	2026-11-12	64	16	Completed	Phone	1028	2026-11-12 14:52:00+00	2026-11-12 15:33:00+00
584	132	1001	5	\N	2026-11-12	64	15	Completed	Web	\N	2026-11-12 14:49:00+00	2026-11-12 15:26:00+00
390	104	1022	6	\N	2026-11-12	71	15	Completed	Web	\N	2026-11-12 15:19:00+00	2026-11-12 15:55:00+00
392	107	1005	6	27	2026-11-12	57	18	Completed	Web	\N	2026-11-12 15:56:00+00	2026-11-12 16:56:00+00
396	126	1023	5	44	2026-11-12	57	20	Completed	Phone	1014	2026-11-12 15:51:00+00	2026-11-12 16:39:00+00
388	104	1003	5	\N	2026-11-12	69	16	Completed	Web	\N	2026-11-12 16:21:00+00	2026-11-12 17:00:00+00
391	128	1004	5	94	2026-11-12	49	17	Completed	Phone	1028	2026-11-12 16:55:00+00	2026-11-12 17:42:00+00
381	112	1001	5	\N	2026-11-12	53	15	Completed	Web	\N	2026-11-12 19:46:00+00	2026-11-12 20:26:00+00
393	111	1006	5	95	2026-11-12	61	19	Completed	Web	\N	2026-11-12 20:21:00+00	2026-11-12 21:04:00+00
597	101	1001	5	\N	2026-11-17	55	15	Cancelled	Web	\N	\N	\N
598	101	1002	5	\N	2026-11-17	53	15	Cancelled	Web	\N	\N	\N
599	101	1001	5	\N	2026-11-17	55	15	Cancelled	Web	\N	\N	\N
600	101	1001	5	\N	2026-11-17	72	15	Cancelled	Web	\N	\N	\N
601	132	1021	6	\N	2026-11-18	62	16	Scheduled	Phone	1016	\N	\N
602	101	1001	5	\N	2026-11-17	64	15	Cancelled	Web	\N	\N	\N
603	129	1007	6	55	2026-11-12	76	20	Completed	Phone	1016	2026-11-12 22:24:39.086393+00	2026-11-12 22:24:45.118966+00
604	101	1002	6	\N	2026-11-23	59	15	Scheduled	Web	\N	\N	\N
605	101	1002	6	\N	2026-11-23	50	15	Cancelled	Web	\N	\N	\N
606	132	1002	6	\N	2026-11-25	51	15	Scheduled	Phone	1016	\N	\N
\.


--
-- Data for Name: appointment_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.appointment_history (history_id, appointment_id, operation, old_status, new_status, old_appointment_date, new_appointment_date, old_time_slot_id, new_time_slot_id, old_doctor_id, new_doctor_id, changed_at, changed_by, checked_in_at, checked_out_at) FROM stdin;
1	107	INSERT	\N	Scheduled	\N	2026-10-26	\N	64	\N	1001	2026-10-24 04:54:11.687924+00	\N	\N	\N
2	107	UPDATE	Scheduled	Cancelled	2026-10-26	2026-10-26	64	64	1001	1001	2026-10-24 04:54:28.101567+00	\N	\N	\N
11	108	INSERT	\N	Scheduled	\N	2026-10-26	\N	64	\N	1001	2026-10-25 08:19:20.035138+00	\N	\N	\N
18	109	INSERT	\N	Scheduled	\N	2026-10-27	\N	76	\N	1001	2026-10-27 03:59:27.771015+00	\N	\N	\N
19	110	INSERT	\N	Scheduled	\N	2026-10-29	\N	78	\N	1003	2026-10-27 04:24:17.195997+00	\N	\N	\N
20	111	INSERT	\N	Scheduled	\N	2026-10-28	\N	78	\N	1002	2026-10-27 05:03:47.946026+00	\N	\N	\N
21	112	INSERT	\N	Scheduled	\N	2026-10-28	\N	59	\N	1001	2026-10-27 07:04:01.484829+00	\N	\N	\N
22	113	INSERT	\N	Scheduled	\N	2026-10-28	\N	64	\N	1001	2026-10-27 07:06:26.820446+00	\N	\N	\N
23	114	INSERT	\N	Scheduled	\N	2026-10-29	\N	59	\N	1004	2026-10-28 00:13:59.658958+00	\N	\N	\N
24	115	INSERT	\N	Scheduled	\N	2026-10-30	\N	49	\N	1001	2026-10-28 00:20:21.08452+00	\N	\N	\N
25	114	UPDATE	Scheduled	Cancelled	2026-10-29	2026-10-29	59	59	1004	1004	2026-10-28 00:21:49.01019+00	\N	\N	\N
26	116	INSERT	\N	Scheduled	\N	2026-10-30	\N	76	\N	1004	2026-10-28 00:22:05.628835+00	\N	\N	\N
27	117	INSERT	\N	Scheduled	\N	2026-10-30	\N	76	\N	1003	2026-10-28 01:17:11.322035+00	\N	\N	\N
28	118	INSERT	\N	Scheduled	\N	2026-10-29	\N	76	\N	1001	2026-10-28 01:17:48.161549+00	\N	\N	\N
29	119	INSERT	\N	Scheduled	\N	2026-10-29	\N	64	\N	1001	2026-10-28 01:23:33.69739+00	\N	\N	\N
30	120	INSERT	\N	Scheduled	\N	2026-11-20	\N	57	\N	1002	2026-10-30 02:56:47.855105+00	\N	\N	\N
31	120	UPDATE	Scheduled	Cancelled	2026-11-20	2026-11-20	57	57	1002	1002	2026-10-30 02:57:17.951879+00	\N	\N	\N
32	122	INSERT	\N	Scheduled	\N	2026-11-05	\N	78	\N	1004	2026-11-05 04:49:14.17527+00	\N	\N	\N
33	122	UPDATE	Scheduled	Cancelled	2026-11-05	2026-11-05	78	78	1004	1004	2026-11-05 04:49:14.805167+00	\N	\N	\N
34	85	UPDATE	Scheduled	No Show	2026-10-23	2026-10-23	62	62	1007	1007	2026-11-05 05:17:17.596624+00	\N	\N	\N
35	86	UPDATE	Scheduled	No Show	2026-10-26	2026-10-26	53	53	1005	1005	2026-11-05 05:17:17.596624+00	\N	\N	\N
36	87	UPDATE	Scheduled	No Show	2026-10-26	2026-10-26	76	76	1002	1002	2026-11-05 05:17:17.596624+00	\N	\N	\N
37	88	UPDATE	Scheduled	No Show	2026-10-28	2026-10-28	70	70	1002	1002	2026-11-05 05:17:17.596624+00	\N	\N	\N
38	89	UPDATE	Scheduled	No Show	2026-10-29	2026-10-29	69	69	1002	1002	2026-11-05 05:17:17.596624+00	\N	\N	\N
39	90	UPDATE	Scheduled	No Show	2026-10-29	2026-10-29	51	51	1001	1001	2026-11-05 05:17:17.596624+00	\N	\N	\N
40	91	UPDATE	Scheduled	No Show	2026-11-02	2026-11-02	76	76	1002	1002	2026-11-05 05:17:17.596624+00	\N	\N	\N
41	108	UPDATE	Scheduled	No Show	2026-10-26	2026-10-26	64	64	1001	1001	2026-11-05 05:17:17.596624+00	\N	\N	\N
42	109	UPDATE	Scheduled	No Show	2026-10-27	2026-10-27	76	76	1001	1001	2026-11-05 05:17:17.596624+00	\N	\N	\N
43	110	UPDATE	Scheduled	No Show	2026-10-29	2026-10-29	78	78	1003	1003	2026-11-05 05:17:17.596624+00	\N	\N	\N
44	111	UPDATE	Scheduled	No Show	2026-10-28	2026-10-28	78	78	1002	1002	2026-11-05 05:17:17.596624+00	\N	\N	\N
45	112	UPDATE	Scheduled	No Show	2026-10-28	2026-10-28	59	59	1001	1001	2026-11-05 05:17:17.596624+00	\N	\N	\N
46	113	UPDATE	Scheduled	No Show	2026-10-28	2026-10-28	64	64	1001	1001	2026-11-05 05:17:17.596624+00	\N	\N	\N
47	115	UPDATE	Scheduled	No Show	2026-10-30	2026-10-30	49	49	1001	1001	2026-11-05 05:17:17.596624+00	\N	\N	\N
48	116	UPDATE	Scheduled	No Show	2026-10-30	2026-10-30	76	76	1004	1004	2026-11-05 05:17:17.596624+00	\N	\N	\N
49	117	UPDATE	Scheduled	No Show	2026-10-30	2026-10-30	76	76	1003	1003	2026-11-05 05:17:17.596624+00	\N	\N	\N
50	118	UPDATE	Scheduled	No Show	2026-10-29	2026-10-29	76	76	1001	1001	2026-11-05 05:17:17.596624+00	\N	\N	\N
51	119	UPDATE	Scheduled	No Show	2026-10-29	2026-10-29	64	64	1001	1001	2026-11-05 05:17:17.596624+00	\N	\N	\N
52	123	INSERT	\N	Scheduled	\N	2026-10-15	\N	72	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
53	123	UPDATE	Scheduled	Scheduled	2026-10-15	2026-10-15	72	72	1001	1001	2026-11-05 22:26:29.874258+00	1028	2026-10-15 18:20:00+00	\N
54	123	UPDATE	Scheduled	Completed	2026-10-15	2026-10-15	72	72	1001	1001	2026-11-05 22:26:29.874258+00	1028	2026-10-15 18:20:00+00	2026-10-15 19:05:00+00
55	124	INSERT	\N	Scheduled	\N	2026-10-15	\N	57	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
56	124	UPDATE	Scheduled	Scheduled	2026-10-15	2026-10-15	57	57	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-10-15 14:50:00+00	\N
57	124	UPDATE	Scheduled	Completed	2026-10-15	2026-10-15	57	57	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-10-15 14:50:00+00	2026-10-15 15:35:00+00
58	125	INSERT	\N	Scheduled	\N	2026-10-15	\N	53	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
59	125	UPDATE	Scheduled	Scheduled	2026-10-15	2026-10-15	53	53	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-10-15 18:50:00+00	\N
60	125	UPDATE	Scheduled	Completed	2026-10-15	2026-10-15	53	53	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-10-15 18:50:00+00	2026-10-15 19:35:00+00
61	126	INSERT	\N	Scheduled	\N	2026-10-15	\N	70	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
62	126	UPDATE	Scheduled	No Show	2026-10-15	2026-10-15	70	70	1002	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
63	127	INSERT	\N	Scheduled	\N	2026-10-15	\N	76	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
64	127	UPDATE	Scheduled	No Show	2026-10-15	2026-10-15	76	76	1003	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
65	128	INSERT	\N	Scheduled	\N	2026-10-15	\N	64	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
66	128	UPDATE	Scheduled	No Show	2026-10-15	2026-10-15	64	64	1003	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
67	129	INSERT	\N	Scheduled	\N	2026-10-15	\N	78	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
68	129	UPDATE	Scheduled	Cancelled	2026-10-15	2026-10-15	78	78	1003	1003	2026-10-10 23:00:00+00	1028	\N	\N
69	130	INSERT	\N	Scheduled	\N	2026-10-15	\N	50	\N	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
70	130	UPDATE	Scheduled	Scheduled	2026-10-15	2026-10-15	50	50	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-10-15 17:50:00+00	\N
71	130	UPDATE	Scheduled	Completed	2026-10-15	2026-10-15	50	50	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-10-15 17:50:00+00	2026-10-15 18:35:00+00
72	131	INSERT	\N	Scheduled	\N	2026-10-15	\N	76	\N	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
73	131	UPDATE	Scheduled	Scheduled	2026-10-15	2026-10-15	76	76	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-10-15 21:20:00+00	\N
74	131	UPDATE	Scheduled	Completed	2026-10-15	2026-10-15	76	76	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-10-15 21:20:00+00	2026-10-15 22:05:00+00
75	132	INSERT	\N	Scheduled	\N	2026-10-15	\N	79	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
76	132	UPDATE	Scheduled	Scheduled	2026-10-15	2026-10-15	79	79	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-15 13:50:00+00	\N
77	132	UPDATE	Scheduled	Completed	2026-10-15	2026-10-15	79	79	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-15 13:50:00+00	2026-10-15 14:35:00+00
78	133	INSERT	\N	Scheduled	\N	2026-10-15	\N	60	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
79	133	UPDATE	Scheduled	Scheduled	2026-10-15	2026-10-15	60	60	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-15 12:50:00+00	\N
80	133	UPDATE	Scheduled	Completed	2026-10-15	2026-10-15	60	60	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-15 12:50:00+00	2026-10-15 13:35:00+00
81	134	INSERT	\N	Scheduled	\N	2026-10-15	\N	54	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
82	134	UPDATE	Scheduled	Scheduled	2026-10-15	2026-10-15	54	54	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-15 15:20:00+00	\N
83	134	UPDATE	Scheduled	Completed	2026-10-15	2026-10-15	54	54	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-15 15:20:00+00	2026-10-15 16:05:00+00
84	135	INSERT	\N	Scheduled	\N	2026-10-15	\N	72	\N	1004	2026-11-05 22:26:29.874258+00	1014	\N	\N
85	135	UPDATE	Scheduled	Scheduled	2026-10-15	2026-10-15	72	72	1004	1004	2026-11-05 22:26:29.874258+00	1014	2026-10-15 18:20:00+00	\N
86	135	UPDATE	Scheduled	Completed	2026-10-15	2026-10-15	72	72	1004	1004	2026-11-05 22:26:29.874258+00	1014	2026-10-15 18:20:00+00	2026-10-15 19:05:00+00
87	136	INSERT	\N	Scheduled	\N	2026-10-15	\N	78	\N	1005	2026-11-05 22:26:29.874258+00	1029	\N	\N
88	136	UPDATE	Scheduled	Scheduled	2026-10-15	2026-10-15	78	78	1005	1005	2026-11-05 22:26:29.874258+00	1029	2026-10-15 12:50:00+00	\N
89	136	UPDATE	Scheduled	Completed	2026-10-15	2026-10-15	78	78	1005	1005	2026-11-05 22:26:29.874258+00	1029	2026-10-15 12:50:00+00	2026-10-15 13:35:00+00
90	137	INSERT	\N	Scheduled	\N	2026-10-15	\N	59	\N	1006	2026-11-05 22:26:29.874258+00	1015	\N	\N
91	137	UPDATE	Scheduled	Scheduled	2026-10-15	2026-10-15	59	59	1006	1006	2026-11-05 22:26:29.874258+00	1015	2026-10-15 13:20:00+00	\N
92	137	UPDATE	Scheduled	Completed	2026-10-15	2026-10-15	59	59	1006	1006	2026-11-05 22:26:29.874258+00	1015	2026-10-15 13:20:00+00	2026-10-15 14:05:00+00
93	138	INSERT	\N	Scheduled	\N	2026-10-15	\N	57	\N	1023	2026-11-05 22:26:29.874258+00	1028	\N	\N
94	138	UPDATE	Scheduled	Cancelled	2026-10-15	2026-10-15	57	57	1023	1023	2026-10-14 23:00:00+00	1028	\N	\N
95	139	INSERT	\N	Scheduled	\N	2026-10-16	\N	63	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
96	139	UPDATE	Scheduled	Scheduled	2026-10-16	2026-10-16	63	63	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-16 19:50:00+00	\N
97	139	UPDATE	Scheduled	Completed	2026-10-16	2026-10-16	63	63	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-16 19:50:00+00	2026-10-16 20:35:00+00
98	140	INSERT	\N	Scheduled	\N	2026-10-16	\N	59	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
99	140	UPDATE	Scheduled	Scheduled	2026-10-16	2026-10-16	59	59	1001	1001	2026-11-05 22:26:29.874258+00	1028	2026-10-16 13:20:00+00	\N
100	140	UPDATE	Scheduled	Completed	2026-10-16	2026-10-16	59	59	1001	1001	2026-11-05 22:26:29.874258+00	1028	2026-10-16 13:20:00+00	2026-10-16 14:05:00+00
101	141	INSERT	\N	Scheduled	\N	2026-10-16	\N	61	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
102	141	UPDATE	Scheduled	Scheduled	2026-10-16	2026-10-16	61	61	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-16 19:20:00+00	\N
103	141	UPDATE	Scheduled	Completed	2026-10-16	2026-10-16	61	61	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-16 19:20:00+00	2026-10-16 20:05:00+00
104	142	INSERT	\N	Scheduled	\N	2026-10-16	\N	55	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
105	142	UPDATE	Scheduled	Scheduled	2026-10-16	2026-10-16	55	55	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-10-16 14:20:00+00	\N
106	142	UPDATE	Scheduled	Completed	2026-10-16	2026-10-16	55	55	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-10-16 14:20:00+00	2026-10-16 15:05:00+00
107	143	INSERT	\N	Scheduled	\N	2026-10-16	\N	78	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
108	143	UPDATE	Scheduled	Scheduled	2026-10-16	2026-10-16	78	78	1003	1003	2026-11-05 22:26:29.874258+00	1014	2026-10-16 12:50:00+00	\N
109	143	UPDATE	Scheduled	Completed	2026-10-16	2026-10-16	78	78	1003	1003	2026-11-05 22:26:29.874258+00	1014	2026-10-16 12:50:00+00	2026-10-16 13:35:00+00
110	144	INSERT	\N	Scheduled	\N	2026-10-16	\N	53	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
111	144	UPDATE	Scheduled	Scheduled	2026-10-16	2026-10-16	53	53	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-16 18:50:00+00	\N
112	144	UPDATE	Scheduled	Completed	2026-10-16	2026-10-16	53	53	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-16 18:50:00+00	2026-10-16 19:35:00+00
113	145	INSERT	\N	Scheduled	\N	2026-10-16	\N	59	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
114	145	UPDATE	Scheduled	Scheduled	2026-10-16	2026-10-16	59	59	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-16 13:20:00+00	\N
115	145	UPDATE	Scheduled	Completed	2026-10-16	2026-10-16	59	59	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-16 13:20:00+00	2026-10-16 14:05:00+00
116	146	INSERT	\N	Scheduled	\N	2026-10-16	\N	51	\N	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
117	146	UPDATE	Scheduled	No Show	2026-10-16	2026-10-16	51	51	1021	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
118	147	INSERT	\N	Scheduled	\N	2026-10-16	\N	78	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
119	147	UPDATE	Scheduled	Scheduled	2026-10-16	2026-10-16	78	78	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-16 12:50:00+00	\N
120	147	UPDATE	Scheduled	Completed	2026-10-16	2026-10-16	78	78	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-16 12:50:00+00	2026-10-16 13:35:00+00
121	148	INSERT	\N	Scheduled	\N	2026-10-16	\N	64	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
122	148	UPDATE	Scheduled	Scheduled	2026-10-16	2026-10-16	64	64	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-16 13:50:00+00	\N
123	148	UPDATE	Scheduled	Completed	2026-10-16	2026-10-16	64	64	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-16 13:50:00+00	2026-10-16 14:35:00+00
124	149	INSERT	\N	Scheduled	\N	2026-10-16	\N	50	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
125	149	UPDATE	Scheduled	Scheduled	2026-10-16	2026-10-16	50	50	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-16 17:50:00+00	\N
126	149	UPDATE	Scheduled	Completed	2026-10-16	2026-10-16	50	50	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-16 17:50:00+00	2026-10-16 18:35:00+00
127	150	INSERT	\N	Scheduled	\N	2026-10-16	\N	50	\N	1005	2026-11-05 22:26:29.874258+00	1016	\N	\N
128	150	UPDATE	Scheduled	Scheduled	2026-10-16	2026-10-16	50	50	1005	1005	2026-11-05 22:26:29.874258+00	1016	2026-10-16 17:50:00+00	\N
129	150	UPDATE	Scheduled	Completed	2026-10-16	2026-10-16	50	50	1005	1005	2026-11-05 22:26:29.874258+00	1016	2026-10-16 17:50:00+00	2026-10-16 18:35:00+00
130	151	INSERT	\N	Scheduled	\N	2026-10-16	\N	53	\N	1006	2026-11-05 22:26:29.874258+00	1015	\N	\N
131	151	UPDATE	Scheduled	Cancelled	2026-10-16	2026-10-16	53	53	1006	1006	2026-10-16 16:00:00+00	1015	\N	\N
132	152	INSERT	\N	Scheduled	\N	2026-10-16	\N	78	\N	1007	2026-11-05 22:26:29.874258+00	1030	\N	\N
133	152	UPDATE	Scheduled	Scheduled	2026-10-16	2026-10-16	78	78	1007	1007	2026-11-05 22:26:29.874258+00	1030	2026-10-16 12:50:00+00	\N
134	152	UPDATE	Scheduled	Completed	2026-10-16	2026-10-16	78	78	1007	1007	2026-11-05 22:26:29.874258+00	1030	2026-10-16 12:50:00+00	2026-10-16 13:35:00+00
135	153	INSERT	\N	Scheduled	\N	2026-10-16	\N	78	\N	1008	2026-11-05 22:26:29.874258+00	1015	\N	\N
136	153	UPDATE	Scheduled	No Show	2026-10-16	2026-10-16	78	78	1008	1008	2026-11-05 22:26:29.874258+00	1015	\N	\N
137	154	INSERT	\N	Scheduled	\N	2026-10-19	\N	62	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
138	154	UPDATE	Scheduled	Cancelled	2026-10-19	2026-10-19	62	62	1001	1001	2026-10-18 23:00:00+00	1028	\N	\N
139	155	INSERT	\N	Scheduled	\N	2026-10-19	\N	53	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
140	155	UPDATE	Scheduled	Scheduled	2026-10-19	2026-10-19	53	53	1002	1002	2026-11-05 22:26:29.874258+00	1030	2026-10-19 18:50:00+00	\N
141	155	UPDATE	Scheduled	Completed	2026-10-19	2026-10-19	53	53	1002	1002	2026-11-05 22:26:29.874258+00	1030	2026-10-19 18:50:00+00	2026-10-19 19:35:00+00
142	156	INSERT	\N	Scheduled	\N	2026-10-19	\N	51	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
143	156	UPDATE	Scheduled	Cancelled	2026-10-19	2026-10-19	51	51	1002	1002	2026-10-16 23:00:00+00	1030	\N	\N
144	157	INSERT	\N	Scheduled	\N	2026-10-19	\N	61	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
430	259	INSERT	\N	Scheduled	\N	2026-10-28	\N	59	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
145	157	UPDATE	Scheduled	Scheduled	2026-10-19	2026-10-19	61	61	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-10-19 19:20:00+00	\N
146	157	UPDATE	Scheduled	Completed	2026-10-19	2026-10-19	61	61	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-10-19 19:20:00+00	2026-10-19 20:05:00+00
147	158	INSERT	\N	Scheduled	\N	2026-10-19	\N	62	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
148	158	UPDATE	Scheduled	Scheduled	2026-10-19	2026-10-19	62	62	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-10-19 20:20:00+00	\N
149	158	UPDATE	Scheduled	Completed	2026-10-19	2026-10-19	62	62	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-10-19 20:20:00+00	2026-10-19 21:05:00+00
150	159	INSERT	\N	Scheduled	\N	2026-10-19	\N	57	\N	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
151	159	UPDATE	Scheduled	Scheduled	2026-10-19	2026-10-19	57	57	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-10-19 14:50:00+00	\N
152	159	UPDATE	Scheduled	Completed	2026-10-19	2026-10-19	57	57	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-10-19 14:50:00+00	2026-10-19 15:35:00+00
153	160	INSERT	\N	Scheduled	\N	2026-10-19	\N	53	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
154	160	UPDATE	Scheduled	No Show	2026-10-19	2026-10-19	53	53	1021	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
155	161	INSERT	\N	Scheduled	\N	2026-10-19	\N	76	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
156	161	UPDATE	Scheduled	No Show	2026-10-19	2026-10-19	76	76	1022	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
157	162	INSERT	\N	Scheduled	\N	2026-10-19	\N	61	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
158	162	UPDATE	Scheduled	Scheduled	2026-10-19	2026-10-19	61	61	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-19 19:20:00+00	\N
159	162	UPDATE	Scheduled	Completed	2026-10-19	2026-10-19	61	61	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-19 19:20:00+00	2026-10-19 20:05:00+00
160	163	INSERT	\N	Scheduled	\N	2026-10-19	\N	51	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
161	163	UPDATE	Scheduled	Scheduled	2026-10-19	2026-10-19	51	51	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-19 20:50:00+00	\N
162	163	UPDATE	Scheduled	Completed	2026-10-19	2026-10-19	51	51	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-19 20:50:00+00	2026-10-19 21:35:00+00
163	164	INSERT	\N	Scheduled	\N	2026-10-19	\N	55	\N	1005	2026-11-05 22:26:29.874258+00	1016	\N	\N
164	164	UPDATE	Scheduled	Scheduled	2026-10-19	2026-10-19	55	55	1005	1005	2026-11-05 22:26:29.874258+00	1016	2026-10-19 14:20:00+00	\N
165	164	UPDATE	Scheduled	Completed	2026-10-19	2026-10-19	55	55	1005	1005	2026-11-05 22:26:29.874258+00	1016	2026-10-19 14:20:00+00	2026-10-19 15:05:00+00
166	165	INSERT	\N	Scheduled	\N	2026-10-19	\N	76	\N	1006	2026-11-05 22:26:29.874258+00	1014	\N	\N
167	165	UPDATE	Scheduled	Scheduled	2026-10-19	2026-10-19	76	76	1006	1006	2026-11-05 22:26:29.874258+00	1014	2026-10-19 21:20:00+00	\N
168	165	UPDATE	Scheduled	Completed	2026-10-19	2026-10-19	76	76	1006	1006	2026-11-05 22:26:29.874258+00	1014	2026-10-19 21:20:00+00	2026-10-19 22:05:00+00
169	166	INSERT	\N	Scheduled	\N	2026-10-19	\N	49	\N	1007	2026-11-05 22:26:29.874258+00	1016	\N	\N
170	166	UPDATE	Scheduled	Scheduled	2026-10-19	2026-10-19	49	49	1007	1007	2026-11-05 22:26:29.874258+00	1016	2026-10-19 15:50:00+00	\N
171	166	UPDATE	Scheduled	Completed	2026-10-19	2026-10-19	49	49	1007	1007	2026-11-05 22:26:29.874258+00	1016	2026-10-19 15:50:00+00	2026-10-19 16:35:00+00
172	167	INSERT	\N	Scheduled	\N	2026-10-19	\N	78	\N	1008	2026-11-05 22:26:29.874258+00	1014	\N	\N
173	167	UPDATE	Scheduled	Scheduled	2026-10-19	2026-10-19	78	78	1008	1008	2026-11-05 22:26:29.874258+00	1014	2026-10-19 12:50:00+00	\N
174	167	UPDATE	Scheduled	Completed	2026-10-19	2026-10-19	78	78	1008	1008	2026-11-05 22:26:29.874258+00	1014	2026-10-19 12:50:00+00	2026-10-19 13:35:00+00
175	168	INSERT	\N	Scheduled	\N	2026-10-20	\N	49	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
176	168	UPDATE	Scheduled	Scheduled	2026-10-20	2026-10-20	49	49	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-20 15:50:00+00	\N
177	168	UPDATE	Scheduled	Completed	2026-10-20	2026-10-20	49	49	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-20 15:50:00+00	2026-10-20 16:35:00+00
178	169	INSERT	\N	Scheduled	\N	2026-10-20	\N	69	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
179	169	UPDATE	Scheduled	No Show	2026-10-20	2026-10-20	69	69	1001	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
180	170	INSERT	\N	Scheduled	\N	2026-10-20	\N	69	\N	1002	2026-11-05 22:26:29.874258+00	1015	\N	\N
181	170	UPDATE	Scheduled	Scheduled	2026-10-20	2026-10-20	69	69	1002	1002	2026-11-05 22:26:29.874258+00	1015	2026-10-20 15:20:00+00	\N
182	170	UPDATE	Scheduled	Completed	2026-10-20	2026-10-20	69	69	1002	1002	2026-11-05 22:26:29.874258+00	1015	2026-10-20 15:20:00+00	2026-10-20 16:05:00+00
183	171	INSERT	\N	Scheduled	\N	2026-10-20	\N	62	\N	1002	2026-11-05 22:26:29.874258+00	1014	\N	\N
184	171	UPDATE	Scheduled	Scheduled	2026-10-20	2026-10-20	62	62	1002	1002	2026-11-05 22:26:29.874258+00	1014	2026-10-20 20:20:00+00	\N
185	171	UPDATE	Scheduled	Completed	2026-10-20	2026-10-20	62	62	1002	1002	2026-11-05 22:26:29.874258+00	1014	2026-10-20 20:20:00+00	2026-10-20 21:05:00+00
186	172	INSERT	\N	Scheduled	\N	2026-10-20	\N	64	\N	1002	2026-11-05 22:26:29.874258+00	1028	\N	\N
187	172	UPDATE	Scheduled	Scheduled	2026-10-20	2026-10-20	64	64	1002	1002	2026-11-05 22:26:29.874258+00	1028	2026-10-20 13:50:00+00	\N
188	172	UPDATE	Scheduled	Completed	2026-10-20	2026-10-20	64	64	1002	1002	2026-11-05 22:26:29.874258+00	1028	2026-10-20 13:50:00+00	2026-10-20 14:35:00+00
189	173	INSERT	\N	Scheduled	\N	2026-10-20	\N	59	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
190	173	UPDATE	Scheduled	Scheduled	2026-10-20	2026-10-20	59	59	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-10-20 13:20:00+00	\N
191	173	UPDATE	Scheduled	Completed	2026-10-20	2026-10-20	59	59	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-10-20 13:20:00+00	2026-10-20 14:05:00+00
192	174	INSERT	\N	Scheduled	\N	2026-10-20	\N	49	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
193	174	UPDATE	Scheduled	Scheduled	2026-10-20	2026-10-20	49	49	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-20 15:50:00+00	\N
194	174	UPDATE	Scheduled	Completed	2026-10-20	2026-10-20	49	49	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-20 15:50:00+00	2026-10-20 16:35:00+00
195	175	INSERT	\N	Scheduled	\N	2026-10-20	\N	54	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
196	175	UPDATE	Scheduled	Scheduled	2026-10-20	2026-10-20	54	54	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-20 15:20:00+00	\N
197	175	UPDATE	Scheduled	Completed	2026-10-20	2026-10-20	54	54	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-20 15:20:00+00	2026-10-20 16:05:00+00
198	176	INSERT	\N	Scheduled	\N	2026-10-20	\N	74	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
199	176	UPDATE	Scheduled	Scheduled	2026-10-20	2026-10-20	74	74	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-20 13:20:00+00	\N
200	176	UPDATE	Scheduled	Completed	2026-10-20	2026-10-20	74	74	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-20 13:20:00+00	2026-10-20 14:05:00+00
201	177	INSERT	\N	Scheduled	\N	2026-10-20	\N	79	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
202	177	UPDATE	Scheduled	No Show	2026-10-20	2026-10-20	79	79	1022	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
203	178	INSERT	\N	Scheduled	\N	2026-10-20	\N	78	\N	1004	2026-11-05 22:26:29.874258+00	1015	\N	\N
204	178	UPDATE	Scheduled	No Show	2026-10-20	2026-10-20	78	78	1004	1004	2026-11-05 22:26:29.874258+00	1015	\N	\N
205	179	INSERT	\N	Scheduled	\N	2026-10-20	\N	59	\N	1005	2026-11-05 22:26:29.874258+00	1016	\N	\N
206	179	UPDATE	Scheduled	No Show	2026-10-20	2026-10-20	59	59	1005	1005	2026-11-05 22:26:29.874258+00	1016	\N	\N
207	180	INSERT	\N	Scheduled	\N	2026-10-20	\N	51	\N	1006	2026-11-05 22:26:29.874258+00	1030	\N	\N
208	180	UPDATE	Scheduled	Cancelled	2026-10-20	2026-10-20	51	51	1006	1006	2026-10-20 18:00:00+00	1030	\N	\N
209	181	INSERT	\N	Scheduled	\N	2026-10-20	\N	51	\N	1024	2026-11-05 22:26:29.874258+00	1016	\N	\N
210	181	UPDATE	Scheduled	Scheduled	2026-10-20	2026-10-20	51	51	1024	1024	2026-11-05 22:26:29.874258+00	1016	2026-10-20 20:50:00+00	\N
211	181	UPDATE	Scheduled	Completed	2026-10-20	2026-10-20	51	51	1024	1024	2026-11-05 22:26:29.874258+00	1016	2026-10-20 20:50:00+00	2026-10-20 21:35:00+00
212	182	INSERT	\N	Scheduled	\N	2026-10-21	\N	53	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
213	182	UPDATE	Scheduled	Scheduled	2026-10-21	2026-10-21	53	53	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-10-21 18:50:00+00	\N
214	182	UPDATE	Scheduled	Completed	2026-10-21	2026-10-21	53	53	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-10-21 18:50:00+00	2026-10-21 19:35:00+00
215	183	INSERT	\N	Scheduled	\N	2026-10-21	\N	64	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
216	183	UPDATE	Scheduled	Cancelled	2026-10-21	2026-10-21	64	64	1001	1001	2026-10-20 23:00:00+00	1014	\N	\N
217	184	INSERT	\N	Scheduled	\N	2026-10-21	\N	49	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
218	184	UPDATE	Scheduled	Cancelled	2026-10-21	2026-10-21	49	49	1001	1001	2026-10-20 23:00:00+00	1014	\N	\N
219	185	INSERT	\N	Scheduled	\N	2026-10-21	\N	50	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
220	185	UPDATE	Scheduled	Scheduled	2026-10-21	2026-10-21	50	50	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-10-21 17:50:00+00	\N
221	185	UPDATE	Scheduled	Completed	2026-10-21	2026-10-21	50	50	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-10-21 17:50:00+00	2026-10-21 18:35:00+00
222	186	INSERT	\N	Scheduled	\N	2026-10-21	\N	70	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
223	186	UPDATE	Scheduled	No Show	2026-10-21	2026-10-21	70	70	1002	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
224	187	INSERT	\N	Scheduled	\N	2026-10-21	\N	69	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
225	187	UPDATE	Scheduled	Scheduled	2026-10-21	2026-10-21	69	69	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-10-21 15:20:00+00	\N
226	187	UPDATE	Scheduled	Completed	2026-10-21	2026-10-21	69	69	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-10-21 15:20:00+00	2026-10-21 16:05:00+00
227	188	INSERT	\N	Scheduled	\N	2026-10-21	\N	53	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
228	188	UPDATE	Scheduled	Cancelled	2026-10-21	2026-10-21	53	53	1003	1003	2026-10-19 23:00:00+00	1015	\N	\N
229	189	INSERT	\N	Scheduled	\N	2026-10-21	\N	78	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
230	189	UPDATE	Scheduled	Scheduled	2026-10-21	2026-10-21	78	78	1003	1003	2026-11-05 22:26:29.874258+00	1014	2026-10-21 12:50:00+00	\N
231	189	UPDATE	Scheduled	Completed	2026-10-21	2026-10-21	78	78	1003	1003	2026-11-05 22:26:29.874258+00	1014	2026-10-21 12:50:00+00	2026-10-21 13:35:00+00
232	190	INSERT	\N	Scheduled	\N	2026-10-21	\N	59	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
233	190	UPDATE	Scheduled	No Show	2026-10-21	2026-10-21	59	59	1003	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
234	191	INSERT	\N	Scheduled	\N	2026-10-21	\N	53	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
235	191	UPDATE	Scheduled	Scheduled	2026-10-21	2026-10-21	53	53	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-21 18:50:00+00	\N
236	191	UPDATE	Scheduled	Completed	2026-10-21	2026-10-21	53	53	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-21 18:50:00+00	2026-10-21 19:35:00+00
237	192	INSERT	\N	Scheduled	\N	2026-10-21	\N	61	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
238	192	UPDATE	Scheduled	No Show	2026-10-21	2026-10-21	61	61	1021	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
239	193	INSERT	\N	Scheduled	\N	2026-10-21	\N	70	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
240	193	UPDATE	Scheduled	Scheduled	2026-10-21	2026-10-21	70	70	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-10-21 16:20:00+00	\N
241	193	UPDATE	Scheduled	Completed	2026-10-21	2026-10-21	70	70	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-10-21 16:20:00+00	2026-10-21 17:05:00+00
242	194	INSERT	\N	Scheduled	\N	2026-10-21	\N	57	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
243	194	UPDATE	Scheduled	Scheduled	2026-10-21	2026-10-21	57	57	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-21 14:50:00+00	\N
244	194	UPDATE	Scheduled	Completed	2026-10-21	2026-10-21	57	57	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-21 14:50:00+00	2026-10-21 15:35:00+00
245	195	INSERT	\N	Scheduled	\N	2026-10-21	\N	76	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
246	195	UPDATE	Scheduled	Scheduled	2026-10-21	2026-10-21	76	76	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-21 21:20:00+00	\N
247	195	UPDATE	Scheduled	Completed	2026-10-21	2026-10-21	76	76	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-21 21:20:00+00	2026-10-21 22:05:00+00
248	196	INSERT	\N	Scheduled	\N	2026-10-21	\N	72	\N	1006	2026-11-05 22:26:29.874258+00	1014	\N	\N
249	196	UPDATE	Scheduled	Scheduled	2026-10-21	2026-10-21	72	72	1006	1006	2026-11-05 22:26:29.874258+00	1014	2026-10-21 18:20:00+00	\N
250	196	UPDATE	Scheduled	Completed	2026-10-21	2026-10-21	72	72	1006	1006	2026-11-05 22:26:29.874258+00	1014	2026-10-21 18:20:00+00	2026-10-21 19:05:00+00
251	197	INSERT	\N	Scheduled	\N	2026-10-21	\N	63	\N	1007	2026-11-05 22:26:29.874258+00	1029	\N	\N
252	197	UPDATE	Scheduled	Scheduled	2026-10-21	2026-10-21	63	63	1007	1007	2026-11-05 22:26:29.874258+00	1029	2026-10-21 19:50:00+00	\N
253	197	UPDATE	Scheduled	Completed	2026-10-21	2026-10-21	63	63	1007	1007	2026-11-05 22:26:29.874258+00	1029	2026-10-21 19:50:00+00	2026-10-21 20:35:00+00
254	198	INSERT	\N	Scheduled	\N	2026-10-21	\N	55	\N	1008	2026-11-05 22:26:29.874258+00	1015	\N	\N
255	198	UPDATE	Scheduled	Scheduled	2026-10-21	2026-10-21	55	55	1008	1008	2026-11-05 22:26:29.874258+00	1015	2026-10-21 14:20:00+00	\N
256	198	UPDATE	Scheduled	Completed	2026-10-21	2026-10-21	55	55	1008	1008	2026-11-05 22:26:29.874258+00	1015	2026-10-21 14:20:00+00	2026-10-21 15:05:00+00
257	199	INSERT	\N	Scheduled	\N	2026-10-21	\N	69	\N	1023	2026-11-05 22:26:29.874258+00	1014	\N	\N
258	199	UPDATE	Scheduled	Scheduled	2026-10-21	2026-10-21	69	69	1023	1023	2026-11-05 22:26:29.874258+00	1014	2026-10-21 15:20:00+00	\N
259	199	UPDATE	Scheduled	Completed	2026-10-21	2026-10-21	69	69	1023	1023	2026-11-05 22:26:29.874258+00	1014	2026-10-21 15:20:00+00	2026-10-21 16:05:00+00
260	200	INSERT	\N	Scheduled	\N	2026-10-22	\N	72	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
261	200	UPDATE	Scheduled	No Show	2026-10-22	2026-10-22	72	72	1001	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
262	201	INSERT	\N	Scheduled	\N	2026-10-22	\N	59	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
263	201	UPDATE	Scheduled	Scheduled	2026-10-22	2026-10-22	59	59	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-10-22 13:20:00+00	\N
264	201	UPDATE	Scheduled	Completed	2026-10-22	2026-10-22	59	59	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-10-22 13:20:00+00	2026-10-22 14:05:00+00
265	202	INSERT	\N	Scheduled	\N	2026-10-22	\N	49	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
266	202	UPDATE	Scheduled	Scheduled	2026-10-22	2026-10-22	49	49	1002	1002	2026-11-05 22:26:29.874258+00	1030	2026-10-22 15:50:00+00	\N
267	202	UPDATE	Scheduled	Completed	2026-10-22	2026-10-22	49	49	1002	1002	2026-11-05 22:26:29.874258+00	1030	2026-10-22 15:50:00+00	2026-10-22 16:35:00+00
268	203	INSERT	\N	Scheduled	\N	2026-10-22	\N	78	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
269	203	UPDATE	Scheduled	Scheduled	2026-10-22	2026-10-22	78	78	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-10-22 12:50:00+00	\N
270	203	UPDATE	Scheduled	Completed	2026-10-22	2026-10-22	78	78	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-10-22 12:50:00+00	2026-10-22 13:35:00+00
271	204	INSERT	\N	Scheduled	\N	2026-10-22	\N	76	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
272	204	UPDATE	Scheduled	Scheduled	2026-10-22	2026-10-22	76	76	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-22 21:20:00+00	\N
273	204	UPDATE	Scheduled	Completed	2026-10-22	2026-10-22	76	76	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-22 21:20:00+00	2026-10-22 22:05:00+00
274	205	INSERT	\N	Scheduled	\N	2026-10-22	\N	62	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
275	205	UPDATE	Scheduled	Scheduled	2026-10-22	2026-10-22	62	62	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-10-22 20:20:00+00	\N
276	205	UPDATE	Scheduled	Completed	2026-10-22	2026-10-22	62	62	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-10-22 20:20:00+00	2026-10-22 21:05:00+00
277	206	INSERT	\N	Scheduled	\N	2026-10-22	\N	78	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
278	206	UPDATE	Scheduled	Scheduled	2026-10-22	2026-10-22	78	78	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-22 12:50:00+00	\N
279	206	UPDATE	Scheduled	Completed	2026-10-22	2026-10-22	78	78	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-22 12:50:00+00	2026-10-22 13:35:00+00
280	207	INSERT	\N	Scheduled	\N	2026-10-22	\N	69	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
281	207	UPDATE	Scheduled	Scheduled	2026-10-22	2026-10-22	69	69	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-22 15:20:00+00	\N
282	207	UPDATE	Scheduled	Completed	2026-10-22	2026-10-22	69	69	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-22 15:20:00+00	2026-10-22 16:05:00+00
283	208	INSERT	\N	Scheduled	\N	2026-10-22	\N	60	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
284	208	UPDATE	Scheduled	Scheduled	2026-10-22	2026-10-22	60	60	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-22 12:50:00+00	\N
285	208	UPDATE	Scheduled	Completed	2026-10-22	2026-10-22	60	60	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-22 12:50:00+00	2026-10-22 13:35:00+00
286	209	INSERT	\N	Scheduled	\N	2026-10-22	\N	55	\N	1005	2026-11-05 22:26:29.874258+00	1030	\N	\N
287	209	UPDATE	Scheduled	Scheduled	2026-10-22	2026-10-22	55	55	1005	1005	2026-11-05 22:26:29.874258+00	1030	2026-10-22 14:20:00+00	\N
288	209	UPDATE	Scheduled	Completed	2026-10-22	2026-10-22	55	55	1005	1005	2026-11-05 22:26:29.874258+00	1030	2026-10-22 14:20:00+00	2026-10-22 15:05:00+00
289	210	INSERT	\N	Scheduled	\N	2026-10-22	\N	63	\N	1006	2026-11-05 22:26:29.874258+00	1028	\N	\N
290	210	UPDATE	Scheduled	Scheduled	2026-10-22	2026-10-22	63	63	1006	1006	2026-11-05 22:26:29.874258+00	1028	2026-10-22 19:50:00+00	\N
291	210	UPDATE	Scheduled	Completed	2026-10-22	2026-10-22	63	63	1006	1006	2026-11-05 22:26:29.874258+00	1028	2026-10-22 19:50:00+00	2026-10-22 20:35:00+00
292	211	INSERT	\N	Scheduled	\N	2026-10-22	\N	70	\N	1024	2026-11-05 22:26:29.874258+00	1030	\N	\N
293	211	UPDATE	Scheduled	Scheduled	2026-10-22	2026-10-22	70	70	1024	1024	2026-11-05 22:26:29.874258+00	1030	2026-10-22 16:20:00+00	\N
294	211	UPDATE	Scheduled	Completed	2026-10-22	2026-10-22	70	70	1024	1024	2026-11-05 22:26:29.874258+00	1030	2026-10-22 16:20:00+00	2026-10-22 17:05:00+00
295	212	INSERT	\N	Scheduled	\N	2026-10-23	\N	78	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
296	212	UPDATE	Scheduled	No Show	2026-10-23	2026-10-23	78	78	1001	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
297	213	INSERT	\N	Scheduled	\N	2026-10-23	\N	62	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
298	213	UPDATE	Scheduled	Scheduled	2026-10-23	2026-10-23	62	62	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-10-23 20:20:00+00	\N
299	213	UPDATE	Scheduled	Completed	2026-10-23	2026-10-23	62	62	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-10-23 20:20:00+00	2026-10-23 21:05:00+00
300	214	INSERT	\N	Scheduled	\N	2026-10-23	\N	53	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
301	214	UPDATE	Scheduled	Cancelled	2026-10-23	2026-10-23	53	53	1003	1003	2026-10-19 23:00:00+00	1015	\N	\N
302	215	INSERT	\N	Scheduled	\N	2026-10-23	\N	62	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
303	215	UPDATE	Scheduled	Scheduled	2026-10-23	2026-10-23	62	62	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-10-23 20:20:00+00	\N
304	215	UPDATE	Scheduled	Completed	2026-10-23	2026-10-23	62	62	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-10-23 20:20:00+00	2026-10-23 21:05:00+00
305	216	INSERT	\N	Scheduled	\N	2026-10-23	\N	55	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
306	216	UPDATE	Scheduled	Scheduled	2026-10-23	2026-10-23	55	55	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-10-23 14:20:00+00	\N
307	216	UPDATE	Scheduled	Completed	2026-10-23	2026-10-23	55	55	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-10-23 14:20:00+00	2026-10-23 15:05:00+00
308	217	INSERT	\N	Scheduled	\N	2026-10-23	\N	50	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
309	217	UPDATE	Scheduled	Scheduled	2026-10-23	2026-10-23	50	50	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-23 17:50:00+00	\N
310	217	UPDATE	Scheduled	Completed	2026-10-23	2026-10-23	50	50	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-23 17:50:00+00	2026-10-23 18:35:00+00
311	218	INSERT	\N	Scheduled	\N	2026-10-23	\N	49	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
312	218	UPDATE	Scheduled	No Show	2026-10-23	2026-10-23	49	49	1022	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
313	219	INSERT	\N	Scheduled	\N	2026-10-23	\N	51	\N	1005	2026-11-05 22:26:29.874258+00	1016	\N	\N
314	219	UPDATE	Scheduled	Scheduled	2026-10-23	2026-10-23	51	51	1005	1005	2026-11-05 22:26:29.874258+00	1016	2026-10-23 20:50:00+00	\N
315	219	UPDATE	Scheduled	Completed	2026-10-23	2026-10-23	51	51	1005	1005	2026-11-05 22:26:29.874258+00	1016	2026-10-23 20:50:00+00	2026-10-23 21:35:00+00
316	220	INSERT	\N	Scheduled	\N	2026-10-23	\N	51	\N	1006	2026-11-05 22:26:29.874258+00	1014	\N	\N
317	220	UPDATE	Scheduled	Scheduled	2026-10-23	2026-10-23	51	51	1006	1006	2026-11-05 22:26:29.874258+00	1014	2026-10-23 20:50:00+00	\N
318	220	UPDATE	Scheduled	Completed	2026-10-23	2026-10-23	51	51	1006	1006	2026-11-05 22:26:29.874258+00	1014	2026-10-23 20:50:00+00	2026-10-23 21:35:00+00
319	221	INSERT	\N	Scheduled	\N	2026-10-23	\N	57	\N	1007	2026-11-05 22:26:29.874258+00	1030	\N	\N
320	221	UPDATE	Scheduled	No Show	2026-10-23	2026-10-23	57	57	1007	1007	2026-11-05 22:26:29.874258+00	1030	\N	\N
321	222	INSERT	\N	Scheduled	\N	2026-10-26	\N	72	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
322	222	UPDATE	Scheduled	No Show	2026-10-26	2026-10-26	72	72	1001	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
323	223	INSERT	\N	Scheduled	\N	2026-10-26	\N	59	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
324	223	UPDATE	Scheduled	Scheduled	2026-10-26	2026-10-26	59	59	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-10-26 13:20:00+00	\N
325	223	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	59	59	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-10-26 13:20:00+00	2026-10-26 14:05:00+00
326	224	INSERT	\N	Scheduled	\N	2026-10-26	\N	72	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
327	224	UPDATE	Scheduled	Scheduled	2026-10-26	2026-10-26	72	72	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-10-26 18:20:00+00	\N
328	224	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	72	72	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-10-26 18:20:00+00	2026-10-26 19:05:00+00
329	225	INSERT	\N	Scheduled	\N	2026-10-26	\N	62	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
330	225	UPDATE	Scheduled	Scheduled	2026-10-26	2026-10-26	62	62	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-26 20:20:00+00	\N
331	225	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	62	62	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-26 20:20:00+00	2026-10-26 21:05:00+00
332	226	INSERT	\N	Scheduled	\N	2026-10-26	\N	49	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
333	226	UPDATE	Scheduled	Scheduled	2026-10-26	2026-10-26	49	49	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-26 15:50:00+00	\N
334	226	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	49	49	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-26 15:50:00+00	2026-10-26 16:35:00+00
335	227	INSERT	\N	Scheduled	\N	2026-10-26	\N	64	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
336	227	UPDATE	Scheduled	Scheduled	2026-10-26	2026-10-26	64	64	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-26 13:50:00+00	\N
337	227	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	64	64	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-26 13:50:00+00	2026-10-26 14:35:00+00
338	228	INSERT	\N	Scheduled	\N	2026-10-26	\N	63	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
339	228	UPDATE	Scheduled	Scheduled	2026-10-26	2026-10-26	63	63	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-26 19:50:00+00	\N
340	228	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	63	63	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-26 19:50:00+00	2026-10-26 20:35:00+00
341	229	INSERT	\N	Scheduled	\N	2026-10-26	\N	59	\N	1004	2026-11-05 22:26:29.874258+00	1014	\N	\N
342	229	UPDATE	Scheduled	Scheduled	2026-10-26	2026-10-26	59	59	1004	1004	2026-11-05 22:26:29.874258+00	1014	2026-10-26 13:20:00+00	\N
343	229	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	59	59	1004	1004	2026-11-05 22:26:29.874258+00	1014	2026-10-26 13:20:00+00	2026-10-26 14:05:00+00
344	230	INSERT	\N	Scheduled	\N	2026-10-26	\N	50	\N	1005	2026-11-05 22:26:29.874258+00	1030	\N	\N
345	230	UPDATE	Scheduled	Scheduled	2026-10-26	2026-10-26	50	50	1005	1005	2026-11-05 22:26:29.874258+00	1030	2026-10-26 17:50:00+00	\N
346	230	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	50	50	1005	1005	2026-11-05 22:26:29.874258+00	1030	2026-10-26 17:50:00+00	2026-10-26 18:35:00+00
347	231	INSERT	\N	Scheduled	\N	2026-10-26	\N	50	\N	1006	2026-11-05 22:26:29.874258+00	1028	\N	\N
348	231	UPDATE	Scheduled	Scheduled	2026-10-26	2026-10-26	50	50	1006	1006	2026-11-05 22:26:29.874258+00	1028	2026-10-26 17:50:00+00	\N
349	231	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	50	50	1006	1006	2026-11-05 22:26:29.874258+00	1028	2026-10-26 17:50:00+00	2026-10-26 18:35:00+00
350	232	INSERT	\N	Scheduled	\N	2026-10-26	\N	78	\N	1007	2026-11-05 22:26:29.874258+00	1029	\N	\N
351	232	UPDATE	Scheduled	Scheduled	2026-10-26	2026-10-26	78	78	1007	1007	2026-11-05 22:26:29.874258+00	1029	2026-10-26 12:50:00+00	\N
352	232	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	78	78	1007	1007	2026-11-05 22:26:29.874258+00	1029	2026-10-26 12:50:00+00	2026-10-26 13:35:00+00
353	233	INSERT	\N	Scheduled	\N	2026-10-26	\N	72	\N	1008	2026-11-05 22:26:29.874258+00	1028	\N	\N
354	233	UPDATE	Scheduled	Scheduled	2026-10-26	2026-10-26	72	72	1008	1008	2026-11-05 22:26:29.874258+00	1028	2026-10-26 18:20:00+00	\N
355	233	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	72	72	1008	1008	2026-11-05 22:26:29.874258+00	1028	2026-10-26 18:20:00+00	2026-10-26 19:05:00+00
356	234	INSERT	\N	Scheduled	\N	2026-10-26	\N	76	\N	1023	2026-11-05 22:26:29.874258+00	1014	\N	\N
357	234	UPDATE	Scheduled	Scheduled	2026-10-26	2026-10-26	76	76	1023	1023	2026-11-05 22:26:29.874258+00	1014	2026-10-26 21:20:00+00	\N
358	234	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	76	76	1023	1023	2026-11-05 22:26:29.874258+00	1014	2026-10-26 21:20:00+00	2026-10-26 22:05:00+00
359	235	INSERT	\N	Scheduled	\N	2026-10-27	\N	57	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
360	235	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	57	57	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-10-27 14:50:00+00	\N
361	235	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	57	57	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-10-27 14:50:00+00	2026-10-27 15:35:00+00
362	236	INSERT	\N	Scheduled	\N	2026-10-27	\N	76	\N	1002	2026-11-05 22:26:29.874258+00	1015	\N	\N
363	236	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	76	76	1002	1002	2026-11-05 22:26:29.874258+00	1015	2026-10-27 21:20:00+00	\N
364	236	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	76	76	1002	1002	2026-11-05 22:26:29.874258+00	1015	2026-10-27 21:20:00+00	2026-10-27 22:05:00+00
365	237	INSERT	\N	Scheduled	\N	2026-10-27	\N	63	\N	1002	2026-11-05 22:26:29.874258+00	1028	\N	\N
366	237	UPDATE	Scheduled	No Show	2026-10-27	2026-10-27	63	63	1002	1002	2026-11-05 22:26:29.874258+00	1028	\N	\N
367	238	INSERT	\N	Scheduled	\N	2026-10-27	\N	57	\N	1002	2026-11-05 22:26:29.874258+00	1028	\N	\N
368	238	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	57	57	1002	1002	2026-11-05 22:26:29.874258+00	1028	2026-10-27 14:50:00+00	\N
369	238	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	57	57	1002	1002	2026-11-05 22:26:29.874258+00	1028	2026-10-27 14:50:00+00	2026-10-27 15:35:00+00
370	239	INSERT	\N	Scheduled	\N	2026-10-27	\N	78	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
371	239	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	78	78	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-10-27 12:50:00+00	\N
372	239	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	78	78	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-10-27 12:50:00+00	2026-10-27 13:35:00+00
373	240	INSERT	\N	Scheduled	\N	2026-10-27	\N	57	\N	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
374	240	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	57	57	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-10-27 14:50:00+00	\N
375	240	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	57	57	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-10-27 14:50:00+00	2026-10-27 15:35:00+00
376	241	INSERT	\N	Scheduled	\N	2026-10-27	\N	70	\N	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
377	241	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	70	70	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-10-27 16:20:00+00	\N
378	241	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	70	70	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-10-27 16:20:00+00	2026-10-27 17:05:00+00
379	242	INSERT	\N	Scheduled	\N	2026-10-27	\N	53	\N	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
380	242	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	53	53	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-10-27 18:50:00+00	\N
381	242	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	53	53	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-10-27 18:50:00+00	2026-10-27 19:35:00+00
382	243	INSERT	\N	Scheduled	\N	2026-10-27	\N	74	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
383	243	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	74	74	1022	1022	2026-11-05 22:26:29.874258+00	1030	2026-10-27 13:20:00+00	\N
384	243	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	74	74	1022	1022	2026-11-05 22:26:29.874258+00	1030	2026-10-27 13:20:00+00	2026-10-27 14:05:00+00
385	244	INSERT	\N	Scheduled	\N	2026-10-27	\N	54	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
386	244	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	54	54	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-27 15:20:00+00	\N
387	244	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	54	54	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-27 15:20:00+00	2026-10-27 16:05:00+00
388	245	INSERT	\N	Scheduled	\N	2026-10-27	\N	78	\N	1004	2026-11-05 22:26:29.874258+00	1028	\N	\N
389	245	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	78	78	1004	1004	2026-11-05 22:26:29.874258+00	1028	2026-10-27 12:50:00+00	\N
390	245	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	78	78	1004	1004	2026-11-05 22:26:29.874258+00	1028	2026-10-27 12:50:00+00	2026-10-27 13:35:00+00
391	246	INSERT	\N	Scheduled	\N	2026-10-27	\N	51	\N	1005	2026-11-05 22:26:29.874258+00	1029	\N	\N
392	246	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	51	51	1005	1005	2026-11-05 22:26:29.874258+00	1029	2026-10-27 20:50:00+00	\N
393	246	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	51	51	1005	1005	2026-11-05 22:26:29.874258+00	1029	2026-10-27 20:50:00+00	2026-10-27 21:35:00+00
394	247	INSERT	\N	Scheduled	\N	2026-10-27	\N	53	\N	1006	2026-11-05 22:26:29.874258+00	1016	\N	\N
395	247	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	53	53	1006	1006	2026-11-05 22:26:29.874258+00	1016	2026-10-27 18:50:00+00	\N
396	247	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	53	53	1006	1006	2026-11-05 22:26:29.874258+00	1016	2026-10-27 18:50:00+00	2026-10-27 19:35:00+00
397	248	INSERT	\N	Scheduled	\N	2026-10-27	\N	51	\N	1007	2026-11-05 22:26:29.874258+00	1030	\N	\N
398	248	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	51	51	1007	1007	2026-11-05 22:26:29.874258+00	1030	2026-10-27 20:50:00+00	\N
399	248	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	51	51	1007	1007	2026-11-05 22:26:29.874258+00	1030	2026-10-27 20:50:00+00	2026-10-27 21:35:00+00
400	249	INSERT	\N	Scheduled	\N	2026-10-27	\N	57	\N	1024	2026-11-05 22:26:29.874258+00	1029	\N	\N
401	249	UPDATE	Scheduled	Scheduled	2026-10-27	2026-10-27	57	57	1024	1024	2026-11-05 22:26:29.874258+00	1029	2026-10-27 14:50:00+00	\N
402	249	UPDATE	Scheduled	Completed	2026-10-27	2026-10-27	57	57	1024	1024	2026-11-05 22:26:29.874258+00	1029	2026-10-27 14:50:00+00	2026-10-27 15:35:00+00
403	250	INSERT	\N	Scheduled	\N	2026-10-28	\N	61	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
404	250	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	61	61	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-10-28 19:20:00+00	\N
405	250	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	61	61	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-10-28 19:20:00+00	2026-10-28 20:05:00+00
406	251	INSERT	\N	Scheduled	\N	2026-10-28	\N	53	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
407	251	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	53	53	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-28 18:50:00+00	\N
408	251	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	53	53	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-28 18:50:00+00	2026-10-28 19:35:00+00
409	252	INSERT	\N	Scheduled	\N	2026-10-28	\N	51	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
410	252	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	51	51	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-28 20:50:00+00	\N
411	252	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	51	51	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-28 20:50:00+00	2026-10-28 21:35:00+00
412	253	INSERT	\N	Scheduled	\N	2026-10-28	\N	69	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
413	253	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	69	69	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-10-28 15:20:00+00	\N
414	253	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	69	69	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-10-28 15:20:00+00	2026-10-28 16:05:00+00
415	254	INSERT	\N	Scheduled	\N	2026-10-28	\N	72	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
416	254	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	72	72	1002	1002	2026-11-05 22:26:29.874258+00	1030	2026-10-28 18:20:00+00	\N
417	254	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	72	72	1002	1002	2026-11-05 22:26:29.874258+00	1030	2026-10-28 18:20:00+00	2026-10-28 19:05:00+00
418	255	INSERT	\N	Scheduled	\N	2026-10-28	\N	78	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
419	255	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	78	78	1003	1003	2026-11-05 22:26:29.874258+00	1014	2026-10-28 12:50:00+00	\N
420	255	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	78	78	1003	1003	2026-11-05 22:26:29.874258+00	1014	2026-10-28 12:50:00+00	2026-10-28 13:35:00+00
421	256	INSERT	\N	Scheduled	\N	2026-10-28	\N	50	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
422	256	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	50	50	1003	1003	2026-11-05 22:26:29.874258+00	1014	2026-10-28 17:50:00+00	\N
423	256	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	50	50	1003	1003	2026-11-05 22:26:29.874258+00	1014	2026-10-28 17:50:00+00	2026-10-28 18:35:00+00
424	257	INSERT	\N	Scheduled	\N	2026-10-28	\N	57	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
425	257	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	57	57	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-28 14:50:00+00	\N
426	257	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	57	57	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-28 14:50:00+00	2026-10-28 15:35:00+00
427	258	INSERT	\N	Scheduled	\N	2026-10-28	\N	62	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
428	258	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	62	62	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-10-28 20:20:00+00	\N
429	258	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	62	62	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-10-28 20:20:00+00	2026-10-28 21:05:00+00
431	259	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	59	59	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-28 13:20:00+00	\N
432	259	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	59	59	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-28 13:20:00+00	2026-10-28 14:05:00+00
433	260	INSERT	\N	Scheduled	\N	2026-10-28	\N	55	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
434	260	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	55	55	1022	1022	2026-11-05 22:26:29.874258+00	1030	2026-10-28 14:20:00+00	\N
435	260	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	55	55	1022	1022	2026-11-05 22:26:29.874258+00	1030	2026-10-28 14:20:00+00	2026-10-28 15:05:00+00
436	261	INSERT	\N	Scheduled	\N	2026-10-28	\N	63	\N	1004	2026-11-05 22:26:29.874258+00	1014	\N	\N
437	261	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	63	63	1004	1004	2026-11-05 22:26:29.874258+00	1014	2026-10-28 19:50:00+00	\N
438	261	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	63	63	1004	1004	2026-11-05 22:26:29.874258+00	1014	2026-10-28 19:50:00+00	2026-10-28 20:35:00+00
439	262	INSERT	\N	Scheduled	\N	2026-10-28	\N	55	\N	1005	2026-11-05 22:26:29.874258+00	1030	\N	\N
440	262	UPDATE	Scheduled	No Show	2026-10-28	2026-10-28	55	55	1005	1005	2026-11-05 22:26:29.874258+00	1030	\N	\N
441	263	INSERT	\N	Scheduled	\N	2026-10-28	\N	50	\N	1006	2026-11-05 22:26:29.874258+00	1014	\N	\N
442	263	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	50	50	1006	1006	2026-11-05 22:26:29.874258+00	1014	2026-10-28 17:50:00+00	\N
443	263	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	50	50	1006	1006	2026-11-05 22:26:29.874258+00	1014	2026-10-28 17:50:00+00	2026-10-28 18:35:00+00
444	264	INSERT	\N	Scheduled	\N	2026-10-28	\N	59	\N	1007	2026-11-05 22:26:29.874258+00	1030	\N	\N
445	264	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	59	59	1007	1007	2026-11-05 22:26:29.874258+00	1030	2026-10-28 13:20:00+00	\N
446	264	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	59	59	1007	1007	2026-11-05 22:26:29.874258+00	1030	2026-10-28 13:20:00+00	2026-10-28 14:05:00+00
447	265	INSERT	\N	Scheduled	\N	2026-10-28	\N	59	\N	1023	2026-11-05 22:26:29.874258+00	1014	\N	\N
448	265	UPDATE	Scheduled	Scheduled	2026-10-28	2026-10-28	59	59	1023	1023	2026-11-05 22:26:29.874258+00	1014	2026-10-28 13:20:00+00	\N
449	265	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	59	59	1023	1023	2026-11-05 22:26:29.874258+00	1014	2026-10-28 13:20:00+00	2026-10-28 14:05:00+00
450	266	INSERT	\N	Scheduled	\N	2026-10-29	\N	78	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
451	266	UPDATE	Scheduled	Scheduled	2026-10-29	2026-10-29	78	78	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-10-29 12:50:00+00	\N
452	266	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	78	78	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-10-29 12:50:00+00	2026-10-29 13:35:00+00
453	267	INSERT	\N	Scheduled	\N	2026-10-29	\N	69	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
454	267	UPDATE	Scheduled	Scheduled	2026-10-29	2026-10-29	69	69	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-29 15:20:00+00	\N
455	267	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	69	69	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-29 15:20:00+00	2026-10-29 16:05:00+00
456	268	INSERT	\N	Scheduled	\N	2026-10-29	\N	61	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
457	268	UPDATE	Scheduled	No Show	2026-10-29	2026-10-29	61	61	1002	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
458	269	INSERT	\N	Scheduled	\N	2026-10-29	\N	57	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
459	269	UPDATE	Scheduled	Scheduled	2026-10-29	2026-10-29	57	57	1002	1002	2026-11-05 22:26:29.874258+00	1030	2026-10-29 14:50:00+00	\N
460	269	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	57	57	1002	1002	2026-11-05 22:26:29.874258+00	1030	2026-10-29 14:50:00+00	2026-10-29 15:35:00+00
461	270	INSERT	\N	Scheduled	\N	2026-10-29	\N	53	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
462	270	UPDATE	Scheduled	Scheduled	2026-10-29	2026-10-29	53	53	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-10-29 18:50:00+00	\N
463	270	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	53	53	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-10-29 18:50:00+00	2026-10-29 19:35:00+00
464	271	INSERT	\N	Scheduled	\N	2026-10-29	\N	57	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
465	271	UPDATE	Scheduled	Scheduled	2026-10-29	2026-10-29	57	57	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-29 14:50:00+00	\N
466	271	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	57	57	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-29 14:50:00+00	2026-10-29 15:35:00+00
467	272	INSERT	\N	Scheduled	\N	2026-10-29	\N	51	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
468	272	UPDATE	Scheduled	Scheduled	2026-10-29	2026-10-29	51	51	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-29 20:50:00+00	\N
469	272	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	51	51	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-10-29 20:50:00+00	2026-10-29 21:35:00+00
470	273	INSERT	\N	Scheduled	\N	2026-10-29	\N	50	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
471	273	UPDATE	Scheduled	Scheduled	2026-10-29	2026-10-29	50	50	1003	1003	2026-11-05 22:26:29.874258+00	1014	2026-10-29 17:50:00+00	\N
472	273	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	50	50	1003	1003	2026-11-05 22:26:29.874258+00	1014	2026-10-29 17:50:00+00	2026-10-29 18:35:00+00
473	274	INSERT	\N	Scheduled	\N	2026-10-29	\N	49	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
474	274	UPDATE	Scheduled	Scheduled	2026-10-29	2026-10-29	49	49	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-29 15:50:00+00	\N
475	274	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	49	49	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-10-29 15:50:00+00	2026-10-29 16:35:00+00
476	275	INSERT	\N	Scheduled	\N	2026-10-29	\N	60	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
477	275	UPDATE	Scheduled	Scheduled	2026-10-29	2026-10-29	60	60	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-29 12:50:00+00	\N
478	275	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	60	60	1022	1022	2026-11-05 22:26:29.874258+00	1016	2026-10-29 12:50:00+00	2026-10-29 13:35:00+00
479	276	INSERT	\N	Scheduled	\N	2026-10-29	\N	66	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
480	276	UPDATE	Scheduled	Scheduled	2026-10-29	2026-10-29	66	66	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-29 15:50:00+00	\N
481	276	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	66	66	1022	1022	2026-11-05 22:26:29.874258+00	1029	2026-10-29 15:50:00+00	2026-10-29 16:35:00+00
482	277	INSERT	\N	Scheduled	\N	2026-10-29	\N	56	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
483	277	UPDATE	Scheduled	No Show	2026-10-29	2026-10-29	56	56	1022	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
484	278	INSERT	\N	Scheduled	\N	2026-10-29	\N	50	\N	1005	2026-11-05 22:26:29.874258+00	1029	\N	\N
485	278	UPDATE	Scheduled	Scheduled	2026-10-29	2026-10-29	50	50	1005	1005	2026-11-05 22:26:29.874258+00	1029	2026-10-29 17:50:00+00	\N
486	278	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	50	50	1005	1005	2026-11-05 22:26:29.874258+00	1029	2026-10-29 17:50:00+00	2026-10-29 18:35:00+00
487	279	INSERT	\N	Scheduled	\N	2026-10-29	\N	50	\N	1006	2026-11-05 22:26:29.874258+00	1015	\N	\N
488	279	UPDATE	Scheduled	Scheduled	2026-10-29	2026-10-29	50	50	1006	1006	2026-11-05 22:26:29.874258+00	1015	2026-10-29 17:50:00+00	\N
489	279	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	50	50	1006	1006	2026-11-05 22:26:29.874258+00	1015	2026-10-29 17:50:00+00	2026-10-29 18:35:00+00
490	280	INSERT	\N	Scheduled	\N	2026-10-30	\N	55	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
491	280	UPDATE	Scheduled	Scheduled	2026-10-30	2026-10-30	55	55	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-30 14:20:00+00	\N
492	280	UPDATE	Scheduled	Completed	2026-10-30	2026-10-30	55	55	1001	1001	2026-11-05 22:26:29.874258+00	1014	2026-10-30 14:20:00+00	2026-10-30 15:05:00+00
493	281	INSERT	\N	Scheduled	\N	2026-10-30	\N	76	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
494	281	UPDATE	Scheduled	Scheduled	2026-10-30	2026-10-30	76	76	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-10-30 21:20:00+00	\N
495	281	UPDATE	Scheduled	Completed	2026-10-30	2026-10-30	76	76	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-10-30 21:20:00+00	2026-10-30 22:05:00+00
496	282	INSERT	\N	Scheduled	\N	2026-10-30	\N	63	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
497	282	UPDATE	Scheduled	Scheduled	2026-10-30	2026-10-30	63	63	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-10-30 19:50:00+00	\N
498	282	UPDATE	Scheduled	Completed	2026-10-30	2026-10-30	63	63	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-10-30 19:50:00+00	2026-10-30 20:35:00+00
499	283	INSERT	\N	Scheduled	\N	2026-10-30	\N	55	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
500	283	UPDATE	Scheduled	Scheduled	2026-10-30	2026-10-30	55	55	1002	1002	2026-11-05 22:26:29.874258+00	1030	2026-10-30 14:20:00+00	\N
501	283	UPDATE	Scheduled	Completed	2026-10-30	2026-10-30	55	55	1002	1002	2026-11-05 22:26:29.874258+00	1030	2026-10-30 14:20:00+00	2026-10-30 15:05:00+00
502	284	INSERT	\N	Scheduled	\N	2026-10-30	\N	50	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
503	284	UPDATE	Scheduled	Scheduled	2026-10-30	2026-10-30	50	50	1003	1003	2026-11-05 22:26:29.874258+00	1014	2026-10-30 17:50:00+00	\N
504	284	UPDATE	Scheduled	Completed	2026-10-30	2026-10-30	50	50	1003	1003	2026-11-05 22:26:29.874258+00	1014	2026-10-30 17:50:00+00	2026-10-30 18:35:00+00
505	285	INSERT	\N	Scheduled	\N	2026-10-30	\N	49	\N	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
506	285	UPDATE	Scheduled	No Show	2026-10-30	2026-10-30	49	49	1021	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
507	286	INSERT	\N	Scheduled	\N	2026-10-30	\N	57	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
508	286	UPDATE	Scheduled	Scheduled	2026-10-30	2026-10-30	57	57	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-10-30 14:50:00+00	\N
509	286	UPDATE	Scheduled	Completed	2026-10-30	2026-10-30	57	57	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-10-30 14:50:00+00	2026-10-30 15:35:00+00
510	287	INSERT	\N	Scheduled	\N	2026-10-30	\N	50	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
511	287	UPDATE	Scheduled	Cancelled	2026-10-30	2026-10-30	50	50	1022	1022	2026-10-28 23:00:00+00	1029	\N	\N
512	288	INSERT	\N	Scheduled	\N	2026-10-30	\N	70	\N	1006	2026-11-05 22:26:29.874258+00	1028	\N	\N
513	288	UPDATE	Scheduled	Scheduled	2026-10-30	2026-10-30	70	70	1006	1006	2026-11-05 22:26:29.874258+00	1028	2026-10-30 16:20:00+00	\N
514	288	UPDATE	Scheduled	Completed	2026-10-30	2026-10-30	70	70	1006	1006	2026-11-05 22:26:29.874258+00	1028	2026-10-30 16:20:00+00	2026-10-30 17:05:00+00
515	289	INSERT	\N	Scheduled	\N	2026-10-30	\N	64	\N	1024	2026-11-05 22:26:29.874258+00	1016	\N	\N
516	289	UPDATE	Scheduled	Scheduled	2026-10-30	2026-10-30	64	64	1024	1024	2026-11-05 22:26:29.874258+00	1016	2026-10-30 13:50:00+00	\N
517	289	UPDATE	Scheduled	Completed	2026-10-30	2026-10-30	64	64	1024	1024	2026-11-05 22:26:29.874258+00	1016	2026-10-30 13:50:00+00	2026-10-30 14:35:00+00
518	290	INSERT	\N	Scheduled	\N	2026-11-02	\N	55	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
519	290	UPDATE	Scheduled	Scheduled	2026-11-02	2026-11-02	55	55	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-11-02 15:20:00+00	\N
520	290	UPDATE	Scheduled	Completed	2026-11-02	2026-11-02	55	55	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-11-02 15:20:00+00	2026-11-02 16:05:00+00
521	291	INSERT	\N	Scheduled	\N	2026-11-02	\N	72	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
522	291	UPDATE	Scheduled	No Show	2026-11-02	2026-11-02	72	72	1001	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
523	292	INSERT	\N	Scheduled	\N	2026-11-02	\N	78	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
524	292	UPDATE	Scheduled	Scheduled	2026-11-02	2026-11-02	78	78	1001	1001	2026-11-05 22:26:29.874258+00	1028	2026-11-02 13:50:00+00	\N
525	292	UPDATE	Scheduled	Completed	2026-11-02	2026-11-02	78	78	1001	1001	2026-11-05 22:26:29.874258+00	1028	2026-11-02 13:50:00+00	2026-11-02 14:35:00+00
526	293	INSERT	\N	Scheduled	\N	2026-11-02	\N	72	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
527	293	UPDATE	Scheduled	Scheduled	2026-11-02	2026-11-02	72	72	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-11-02 19:20:00+00	\N
528	293	UPDATE	Scheduled	Completed	2026-11-02	2026-11-02	72	72	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-11-02 19:20:00+00	2026-11-02 20:05:00+00
529	294	INSERT	\N	Scheduled	\N	2026-11-02	\N	53	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
530	294	UPDATE	Scheduled	No Show	2026-11-02	2026-11-02	53	53	1002	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
531	295	INSERT	\N	Scheduled	\N	2026-11-02	\N	49	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
532	295	UPDATE	Scheduled	Scheduled	2026-11-02	2026-11-02	49	49	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-11-02 16:50:00+00	\N
533	295	UPDATE	Scheduled	Completed	2026-11-02	2026-11-02	49	49	1002	1002	2026-11-05 22:26:29.874258+00	1016	2026-11-02 16:50:00+00	2026-11-02 17:35:00+00
534	296	INSERT	\N	Scheduled	\N	2026-11-02	\N	50	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
535	296	UPDATE	Scheduled	Scheduled	2026-11-02	2026-11-02	50	50	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-11-02 18:50:00+00	\N
536	296	UPDATE	Scheduled	Completed	2026-11-02	2026-11-02	50	50	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-11-02 18:50:00+00	2026-11-02 19:35:00+00
537	297	INSERT	\N	Scheduled	\N	2026-11-02	\N	62	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
538	297	UPDATE	Scheduled	Scheduled	2026-11-02	2026-11-02	62	62	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-11-02 21:20:00+00	\N
539	297	UPDATE	Scheduled	Completed	2026-11-02	2026-11-02	62	62	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-11-02 21:20:00+00	2026-11-02 22:05:00+00
540	298	INSERT	\N	Scheduled	\N	2026-11-02	\N	64	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
541	298	UPDATE	Scheduled	Cancelled	2026-11-02	2026-11-02	64	64	1021	1021	2026-10-30 23:00:00+00	1016	\N	\N
542	299	INSERT	\N	Scheduled	\N	2026-11-02	\N	61	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
543	299	UPDATE	Scheduled	Scheduled	2026-11-02	2026-11-02	61	61	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-11-02 20:20:00+00	\N
544	299	UPDATE	Scheduled	Completed	2026-11-02	2026-11-02	61	61	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-11-02 20:20:00+00	2026-11-02 21:05:00+00
545	300	INSERT	\N	Scheduled	\N	2026-11-02	\N	59	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
546	300	UPDATE	Scheduled	Scheduled	2026-11-02	2026-11-02	59	59	1022	1022	2026-11-05 22:26:29.874258+00	1030	2026-11-02 14:20:00+00	\N
547	300	UPDATE	Scheduled	Completed	2026-11-02	2026-11-02	59	59	1022	1022	2026-11-05 22:26:29.874258+00	1030	2026-11-02 14:20:00+00	2026-11-02 15:05:00+00
548	301	INSERT	\N	Scheduled	\N	2026-11-02	\N	78	\N	1005	2026-11-05 22:26:29.874258+00	1029	\N	\N
549	301	UPDATE	Scheduled	Scheduled	2026-11-02	2026-11-02	78	78	1005	1005	2026-11-05 22:26:29.874258+00	1029	2026-11-02 13:50:00+00	\N
550	301	UPDATE	Scheduled	Completed	2026-11-02	2026-11-02	78	78	1005	1005	2026-11-05 22:26:29.874258+00	1029	2026-11-02 13:50:00+00	2026-11-02 14:35:00+00
551	302	INSERT	\N	Scheduled	\N	2026-11-02	\N	70	\N	1006	2026-11-05 22:26:29.874258+00	1028	\N	\N
552	302	UPDATE	Scheduled	Scheduled	2026-11-02	2026-11-02	70	70	1006	1006	2026-11-05 22:26:29.874258+00	1028	2026-11-02 17:20:00+00	\N
553	302	UPDATE	Scheduled	Completed	2026-11-02	2026-11-02	70	70	1006	1006	2026-11-05 22:26:29.874258+00	1028	2026-11-02 17:20:00+00	2026-11-02 18:05:00+00
554	303	INSERT	\N	Scheduled	\N	2026-11-02	\N	62	\N	1007	2026-11-05 22:26:29.874258+00	1030	\N	\N
555	303	UPDATE	Scheduled	Scheduled	2026-11-02	2026-11-02	62	62	1007	1007	2026-11-05 22:26:29.874258+00	1030	2026-11-02 21:20:00+00	\N
556	303	UPDATE	Scheduled	Completed	2026-11-02	2026-11-02	62	62	1007	1007	2026-11-05 22:26:29.874258+00	1030	2026-11-02 21:20:00+00	2026-11-02 22:05:00+00
557	304	INSERT	\N	Scheduled	\N	2026-11-02	\N	63	\N	1008	2026-11-05 22:26:29.874258+00	1014	\N	\N
558	304	UPDATE	Scheduled	Scheduled	2026-11-02	2026-11-02	63	63	1008	1008	2026-11-05 22:26:29.874258+00	1014	2026-11-02 20:50:00+00	\N
559	304	UPDATE	Scheduled	Completed	2026-11-02	2026-11-02	63	63	1008	1008	2026-11-05 22:26:29.874258+00	1014	2026-11-02 20:50:00+00	2026-11-02 21:35:00+00
560	305	INSERT	\N	Scheduled	\N	2026-11-02	\N	61	\N	1023	2026-11-05 22:26:29.874258+00	1028	\N	\N
561	305	UPDATE	Scheduled	Scheduled	2026-11-02	2026-11-02	61	61	1023	1023	2026-11-05 22:26:29.874258+00	1028	2026-11-02 20:20:00+00	\N
562	305	UPDATE	Scheduled	Completed	2026-11-02	2026-11-02	61	61	1023	1023	2026-11-05 22:26:29.874258+00	1028	2026-11-02 20:20:00+00	2026-11-02 21:05:00+00
563	306	INSERT	\N	Scheduled	\N	2026-11-03	\N	61	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
564	306	UPDATE	Scheduled	No Show	2026-11-03	2026-11-03	61	61	1001	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
565	307	INSERT	\N	Scheduled	\N	2026-11-03	\N	57	\N	1002	2026-11-05 22:26:29.874258+00	1028	\N	\N
566	307	UPDATE	Scheduled	Scheduled	2026-11-03	2026-11-03	57	57	1002	1002	2026-11-05 22:26:29.874258+00	1028	2026-11-03 15:50:00+00	\N
567	307	UPDATE	Scheduled	Completed	2026-11-03	2026-11-03	57	57	1002	1002	2026-11-05 22:26:29.874258+00	1028	2026-11-03 15:50:00+00	2026-11-03 16:35:00+00
568	308	INSERT	\N	Scheduled	\N	2026-11-03	\N	55	\N	1002	2026-11-05 22:26:29.874258+00	1015	\N	\N
569	308	UPDATE	Scheduled	Scheduled	2026-11-03	2026-11-03	55	55	1002	1002	2026-11-05 22:26:29.874258+00	1015	2026-11-03 15:20:00+00	\N
570	308	UPDATE	Scheduled	Completed	2026-11-03	2026-11-03	55	55	1002	1002	2026-11-05 22:26:29.874258+00	1015	2026-11-03 15:20:00+00	2026-11-03 16:05:00+00
571	309	INSERT	\N	Scheduled	\N	2026-11-03	\N	72	\N	1002	2026-11-05 22:26:29.874258+00	1014	\N	\N
572	309	UPDATE	Scheduled	Scheduled	2026-11-03	2026-11-03	72	72	1002	1002	2026-11-05 22:26:29.874258+00	1014	2026-11-03 19:20:00+00	\N
732	422	INSERT	\N	Scheduled	\N	2026-11-16	\N	62	\N	1007	2026-11-05 22:26:29.874258+00	1030	\N	\N
573	309	UPDATE	Scheduled	Completed	2026-11-03	2026-11-03	72	72	1002	1002	2026-11-05 22:26:29.874258+00	1014	2026-11-03 19:20:00+00	2026-11-03 20:05:00+00
574	310	INSERT	\N	Scheduled	\N	2026-11-03	\N	72	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
575	310	UPDATE	Scheduled	Scheduled	2026-11-03	2026-11-03	72	72	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-11-03 19:20:00+00	\N
576	310	UPDATE	Scheduled	Completed	2026-11-03	2026-11-03	72	72	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-11-03 19:20:00+00	2026-11-03 20:05:00+00
577	311	INSERT	\N	Scheduled	\N	2026-11-03	\N	57	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
578	311	UPDATE	Scheduled	Scheduled	2026-11-03	2026-11-03	57	57	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-11-03 15:50:00+00	\N
579	311	UPDATE	Scheduled	Completed	2026-11-03	2026-11-03	57	57	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-11-03 15:50:00+00	2026-11-03 16:35:00+00
580	312	INSERT	\N	Scheduled	\N	2026-11-03	\N	50	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
581	312	UPDATE	Scheduled	Scheduled	2026-11-03	2026-11-03	50	50	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-11-03 18:50:00+00	\N
582	312	UPDATE	Scheduled	Completed	2026-11-03	2026-11-03	50	50	1003	1003	2026-11-05 22:26:29.874258+00	1015	2026-11-03 18:50:00+00	2026-11-03 19:35:00+00
583	313	INSERT	\N	Scheduled	\N	2026-11-03	\N	57	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
584	313	UPDATE	Scheduled	Scheduled	2026-11-03	2026-11-03	57	57	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-11-03 15:50:00+00	\N
585	313	UPDATE	Scheduled	Completed	2026-11-03	2026-11-03	57	57	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-11-03 15:50:00+00	2026-11-03 16:35:00+00
586	314	INSERT	\N	Scheduled	\N	2026-11-03	\N	72	\N	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
587	314	UPDATE	Scheduled	Scheduled	2026-11-03	2026-11-03	72	72	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-11-03 19:20:00+00	\N
588	314	UPDATE	Scheduled	Completed	2026-11-03	2026-11-03	72	72	1021	1021	2026-11-05 22:26:29.874258+00	1029	2026-11-03 19:20:00+00	2026-11-03 20:05:00+00
589	315	INSERT	\N	Scheduled	\N	2026-11-03	\N	56	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
590	315	UPDATE	Scheduled	Scheduled	2026-11-03	2026-11-03	56	56	1022	1022	2026-11-05 22:26:29.874258+00	1030	2026-11-03 17:20:00+00	\N
591	315	UPDATE	Scheduled	Completed	2026-11-03	2026-11-03	56	56	1022	1022	2026-11-05 22:26:29.874258+00	1030	2026-11-03 17:20:00+00	2026-11-03 18:05:00+00
592	316	INSERT	\N	Scheduled	\N	2026-11-03	\N	76	\N	1023	2026-11-05 22:26:29.874258+00	1014	\N	\N
593	316	UPDATE	Scheduled	Scheduled	2026-11-03	2026-11-03	76	76	1023	1023	2026-11-05 22:26:29.874258+00	1014	2026-11-03 22:20:00+00	\N
594	316	UPDATE	Scheduled	Completed	2026-11-03	2026-11-03	76	76	1023	1023	2026-11-05 22:26:29.874258+00	1014	2026-11-03 22:20:00+00	2026-11-03 23:05:00+00
595	317	INSERT	\N	Scheduled	\N	2026-11-03	\N	61	\N	1024	2026-11-05 22:26:29.874258+00	1029	\N	\N
596	317	UPDATE	Scheduled	Cancelled	2026-11-03	2026-11-03	61	61	1024	1024	2026-10-30 23:00:00+00	1029	\N	\N
597	318	INSERT	\N	Scheduled	\N	2026-11-04	\N	51	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
598	318	UPDATE	Scheduled	Scheduled	2026-11-04	2026-11-04	51	51	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-11-04 21:50:00+00	\N
599	318	UPDATE	Scheduled	Completed	2026-11-04	2026-11-04	51	51	1001	1001	2026-11-05 22:26:29.874258+00	1015	2026-11-04 21:50:00+00	2026-11-04 22:35:00+00
600	319	INSERT	\N	Scheduled	\N	2026-11-04	\N	59	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
601	319	UPDATE	Scheduled	Scheduled	2026-11-04	2026-11-04	59	59	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-11-04 14:20:00+00	\N
602	319	UPDATE	Scheduled	Completed	2026-11-04	2026-11-04	59	59	1002	1002	2026-11-05 22:26:29.874258+00	1029	2026-11-04 14:20:00+00	2026-11-04 15:05:00+00
603	320	INSERT	\N	Scheduled	\N	2026-11-04	\N	55	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
604	320	UPDATE	Scheduled	Scheduled	2026-11-04	2026-11-04	55	55	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-11-04 15:20:00+00	\N
605	320	UPDATE	Scheduled	Completed	2026-11-04	2026-11-04	55	55	1003	1003	2026-11-05 22:26:29.874258+00	1028	2026-11-04 15:20:00+00	2026-11-04 16:05:00+00
606	321	INSERT	\N	Scheduled	\N	2026-11-04	\N	61	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
607	321	UPDATE	Scheduled	Scheduled	2026-11-04	2026-11-04	61	61	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-11-04 20:20:00+00	\N
608	321	UPDATE	Scheduled	Completed	2026-11-04	2026-11-04	61	61	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-11-04 20:20:00+00	2026-11-04 21:05:00+00
609	322	INSERT	\N	Scheduled	\N	2026-11-04	\N	51	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
610	322	UPDATE	Scheduled	Scheduled	2026-11-04	2026-11-04	51	51	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-11-04 21:50:00+00	\N
611	322	UPDATE	Scheduled	Completed	2026-11-04	2026-11-04	51	51	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-11-04 21:50:00+00	2026-11-04 22:35:00+00
612	323	INSERT	\N	Scheduled	\N	2026-11-04	\N	53	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
613	323	UPDATE	Scheduled	No Show	2026-11-04	2026-11-04	53	53	1022	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
614	324	INSERT	\N	Scheduled	\N	2026-11-04	\N	57	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
615	324	UPDATE	Scheduled	Scheduled	2026-11-04	2026-11-04	57	57	1022	1022	2026-11-05 22:26:29.874258+00	1030	2026-11-04 15:50:00+00	\N
616	324	UPDATE	Scheduled	Completed	2026-11-04	2026-11-04	57	57	1022	1022	2026-11-05 22:26:29.874258+00	1030	2026-11-04 15:50:00+00	2026-11-04 16:35:00+00
617	325	INSERT	\N	Scheduled	\N	2026-11-04	\N	78	\N	1007	2026-11-05 22:26:29.874258+00	1029	\N	\N
618	325	UPDATE	Scheduled	Scheduled	2026-11-04	2026-11-04	78	78	1007	1007	2026-11-05 22:26:29.874258+00	1029	2026-11-04 13:50:00+00	\N
619	325	UPDATE	Scheduled	Completed	2026-11-04	2026-11-04	78	78	1007	1007	2026-11-05 22:26:29.874258+00	1029	2026-11-04 13:50:00+00	2026-11-04 14:35:00+00
620	326	INSERT	\N	Scheduled	\N	2026-11-04	\N	53	\N	1008	2026-11-05 22:26:29.874258+00	1015	\N	\N
621	326	UPDATE	Scheduled	Scheduled	2026-11-04	2026-11-04	53	53	1008	1008	2026-11-05 22:26:29.874258+00	1015	2026-11-04 19:50:00+00	\N
622	326	UPDATE	Scheduled	Completed	2026-11-04	2026-11-04	53	53	1008	1008	2026-11-05 22:26:29.874258+00	1015	2026-11-04 19:50:00+00	2026-11-04 20:35:00+00
623	327	INSERT	\N	Scheduled	\N	2026-11-04	\N	57	\N	1024	2026-11-05 22:26:29.874258+00	1029	\N	\N
624	327	UPDATE	Scheduled	Scheduled	2026-11-04	2026-11-04	57	57	1024	1024	2026-11-05 22:26:29.874258+00	1029	2026-11-04 15:50:00+00	\N
625	327	UPDATE	Scheduled	Completed	2026-11-04	2026-11-04	57	57	1024	1024	2026-11-05 22:26:29.874258+00	1029	2026-11-04 15:50:00+00	2026-11-04 16:35:00+00
626	328	INSERT	\N	Scheduled	\N	2026-11-05	\N	51	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
627	329	INSERT	\N	Scheduled	\N	2026-11-05	\N	63	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
628	330	INSERT	\N	Scheduled	\N	2026-11-05	\N	72	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
629	331	INSERT	\N	Scheduled	\N	2026-11-05	\N	50	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
630	332	INSERT	\N	Scheduled	\N	2026-11-05	\N	61	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
631	333	INSERT	\N	Scheduled	\N	2026-11-05	\N	49	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
632	333	UPDATE	Scheduled	Scheduled	2026-11-05	2026-11-05	49	49	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-11-05 16:50:00+00	\N
633	333	UPDATE	Scheduled	Completed	2026-11-05	2026-11-05	49	49	1021	1021	2026-11-05 22:26:29.874258+00	1016	2026-11-05 16:50:00+00	2026-11-05 17:35:00+00
634	334	INSERT	\N	Scheduled	\N	2026-11-05	\N	70	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
635	334	UPDATE	Scheduled	Scheduled	2026-11-05	2026-11-05	70	70	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-11-05 17:20:00+00	\N
636	334	UPDATE	Scheduled	Completed	2026-11-05	2026-11-05	70	70	1021	1021	2026-11-05 22:26:29.874258+00	1030	2026-11-05 17:20:00+00	2026-11-05 18:05:00+00
637	335	INSERT	\N	Scheduled	\N	2026-11-05	\N	56	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
638	335	UPDATE	Scheduled	Scheduled	2026-11-05	2026-11-05	56	56	1022	1022	2026-11-05 22:26:29.874258+00	1030	2026-11-05 17:20:00+00	\N
639	335	UPDATE	Scheduled	Completed	2026-11-05	2026-11-05	56	56	1022	1022	2026-11-05 22:26:29.874258+00	1030	2026-11-05 17:20:00+00	2026-11-05 18:05:00+00
640	336	INSERT	\N	Scheduled	\N	2026-11-05	\N	78	\N	1005	2026-11-05 22:26:29.874258+00	1016	\N	\N
641	336	UPDATE	Scheduled	Scheduled	2026-11-05	2026-11-05	78	78	1005	1005	2026-11-05 22:26:29.874258+00	1016	2026-11-05 13:50:00+00	\N
642	336	UPDATE	Scheduled	Completed	2026-11-05	2026-11-05	78	78	1005	1005	2026-11-05 22:26:29.874258+00	1016	2026-11-05 13:50:00+00	2026-11-05 14:35:00+00
643	337	INSERT	\N	Scheduled	\N	2026-11-05	\N	76	\N	1006	2026-11-05 22:26:29.874258+00	1015	\N	\N
644	338	INSERT	\N	Scheduled	\N	2026-11-05	\N	78	\N	1008	2026-11-05 22:26:29.874258+00	1015	\N	\N
645	338	UPDATE	Scheduled	Scheduled	2026-11-05	2026-11-05	78	78	1008	1008	2026-11-05 22:26:29.874258+00	1015	2026-11-05 13:50:00+00	\N
646	338	UPDATE	Scheduled	Completed	2026-11-05	2026-11-05	78	78	1008	1008	2026-11-05 22:26:29.874258+00	1015	2026-11-05 13:50:00+00	2026-11-05 14:35:00+00
647	339	INSERT	\N	Scheduled	\N	2026-11-05	\N	61	\N	1024	2026-11-05 22:26:29.874258+00	1016	\N	\N
648	340	INSERT	\N	Scheduled	\N	2026-11-06	\N	78	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
649	341	INSERT	\N	Scheduled	\N	2026-11-06	\N	72	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
650	342	INSERT	\N	Scheduled	\N	2026-11-06	\N	69	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
651	343	INSERT	\N	Scheduled	\N	2026-11-06	\N	53	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
652	344	INSERT	\N	Scheduled	\N	2026-11-06	\N	50	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
653	345	INSERT	\N	Scheduled	\N	2026-11-06	\N	51	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
654	346	INSERT	\N	Scheduled	\N	2026-11-06	\N	57	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
655	347	INSERT	\N	Scheduled	\N	2026-11-06	\N	72	\N	1004	2026-11-05 22:26:29.874258+00	1014	\N	\N
656	348	INSERT	\N	Scheduled	\N	2026-11-09	\N	61	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
657	349	INSERT	\N	Scheduled	\N	2026-11-09	\N	53	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
658	350	INSERT	\N	Scheduled	\N	2026-11-09	\N	78	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
659	351	INSERT	\N	Scheduled	\N	2026-11-09	\N	57	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
660	352	INSERT	\N	Scheduled	\N	2026-11-09	\N	76	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
661	353	INSERT	\N	Scheduled	\N	2026-11-09	\N	72	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
662	354	INSERT	\N	Scheduled	\N	2026-11-09	\N	55	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
663	355	INSERT	\N	Scheduled	\N	2026-11-09	\N	72	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
664	356	INSERT	\N	Scheduled	\N	2026-11-09	\N	59	\N	1004	2026-11-05 22:26:29.874258+00	1028	\N	\N
665	357	INSERT	\N	Scheduled	\N	2026-11-09	\N	76	\N	1006	2026-11-05 22:26:29.874258+00	1028	\N	\N
666	358	INSERT	\N	Scheduled	\N	2026-11-09	\N	57	\N	1007	2026-11-05 22:26:29.874258+00	1016	\N	\N
667	359	INSERT	\N	Scheduled	\N	2026-11-09	\N	55	\N	1008	2026-11-05 22:26:29.874258+00	1028	\N	\N
668	360	INSERT	\N	Scheduled	\N	2026-11-10	\N	76	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
669	361	INSERT	\N	Scheduled	\N	2026-11-10	\N	50	\N	1002	2026-11-05 22:26:29.874258+00	1014	\N	\N
670	362	INSERT	\N	Scheduled	\N	2026-11-10	\N	49	\N	1002	2026-11-05 22:26:29.874258+00	1014	\N	\N
671	363	INSERT	\N	Scheduled	\N	2026-11-10	\N	59	\N	1002	2026-11-05 22:26:29.874258+00	1028	\N	\N
672	364	INSERT	\N	Scheduled	\N	2026-11-10	\N	64	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
673	365	INSERT	\N	Scheduled	\N	2026-11-10	\N	76	\N	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
674	366	INSERT	\N	Scheduled	\N	2026-11-10	\N	54	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
675	367	INSERT	\N	Scheduled	\N	2026-11-10	\N	73	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
676	368	INSERT	\N	Scheduled	\N	2026-11-10	\N	79	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
677	369	INSERT	\N	Scheduled	\N	2026-11-10	\N	64	\N	1004	2026-11-05 22:26:29.874258+00	1015	\N	\N
678	370	INSERT	\N	Scheduled	\N	2026-11-10	\N	55	\N	1005	2026-11-05 22:26:29.874258+00	1030	\N	\N
679	371	INSERT	\N	Scheduled	\N	2026-11-10	\N	51	\N	1023	2026-11-05 22:26:29.874258+00	1015	\N	\N
680	372	INSERT	\N	Scheduled	\N	2026-11-11	\N	62	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
681	373	INSERT	\N	Scheduled	\N	2026-11-11	\N	63	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
682	374	INSERT	\N	Scheduled	\N	2026-11-11	\N	55	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
683	374	UPDATE	Scheduled	Cancelled	2026-11-11	2026-11-11	55	55	1002	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
684	375	INSERT	\N	Scheduled	\N	2026-11-11	\N	78	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
685	376	INSERT	\N	Scheduled	\N	2026-11-11	\N	61	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
686	377	INSERT	\N	Scheduled	\N	2026-11-11	\N	49	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
687	378	INSERT	\N	Scheduled	\N	2026-11-11	\N	70	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
688	379	INSERT	\N	Scheduled	\N	2026-11-11	\N	49	\N	1005	2026-11-05 22:26:29.874258+00	1030	\N	\N
689	380	INSERT	\N	Scheduled	\N	2026-11-11	\N	50	\N	1007	2026-11-05 22:26:29.874258+00	1016	\N	\N
690	381	INSERT	\N	Scheduled	\N	2026-11-12	\N	53	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
691	382	INSERT	\N	Scheduled	\N	2026-11-12	\N	55	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
692	383	INSERT	\N	Scheduled	\N	2026-11-12	\N	78	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
693	384	INSERT	\N	Scheduled	\N	2026-11-12	\N	50	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
694	385	INSERT	\N	Scheduled	\N	2026-11-12	\N	76	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
695	386	INSERT	\N	Scheduled	\N	2026-11-12	\N	62	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
696	387	INSERT	\N	Scheduled	\N	2026-11-12	\N	64	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
697	388	INSERT	\N	Scheduled	\N	2026-11-12	\N	69	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
698	389	INSERT	\N	Scheduled	\N	2026-11-12	\N	62	\N	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
699	389	UPDATE	Scheduled	Cancelled	2026-11-12	2026-11-12	62	62	1021	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
700	390	INSERT	\N	Scheduled	\N	2026-11-12	\N	71	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
701	391	INSERT	\N	Scheduled	\N	2026-11-12	\N	49	\N	1004	2026-11-05 22:26:29.874258+00	1028	\N	\N
702	392	INSERT	\N	Scheduled	\N	2026-11-12	\N	57	\N	1005	2026-11-05 22:26:29.874258+00	1016	\N	\N
703	393	INSERT	\N	Scheduled	\N	2026-11-12	\N	61	\N	1006	2026-11-05 22:26:29.874258+00	1015	\N	\N
704	394	INSERT	\N	Scheduled	\N	2026-11-12	\N	78	\N	1007	2026-11-05 22:26:29.874258+00	1029	\N	\N
705	395	INSERT	\N	Scheduled	\N	2026-11-12	\N	57	\N	1008	2026-11-05 22:26:29.874258+00	1028	\N	\N
706	396	INSERT	\N	Scheduled	\N	2026-11-12	\N	57	\N	1023	2026-11-05 22:26:29.874258+00	1014	\N	\N
707	397	INSERT	\N	Scheduled	\N	2026-11-13	\N	64	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
708	398	INSERT	\N	Scheduled	\N	2026-11-13	\N	62	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
709	399	INSERT	\N	Scheduled	\N	2026-11-13	\N	78	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
710	400	INSERT	\N	Scheduled	\N	2026-11-13	\N	59	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
711	401	INSERT	\N	Scheduled	\N	2026-11-13	\N	70	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
712	402	INSERT	\N	Scheduled	\N	2026-11-13	\N	64	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
713	403	INSERT	\N	Scheduled	\N	2026-11-13	\N	50	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
714	404	INSERT	\N	Scheduled	\N	2026-11-13	\N	69	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
715	405	INSERT	\N	Scheduled	\N	2026-11-13	\N	63	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
716	406	INSERT	\N	Scheduled	\N	2026-11-13	\N	70	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
717	407	INSERT	\N	Scheduled	\N	2026-11-13	\N	69	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
718	408	INSERT	\N	Scheduled	\N	2026-11-13	\N	57	\N	1005	2026-11-05 22:26:29.874258+00	1029	\N	\N
719	409	INSERT	\N	Scheduled	\N	2026-11-13	\N	78	\N	1007	2026-11-05 22:26:29.874258+00	1029	\N	\N
720	410	INSERT	\N	Scheduled	\N	2026-11-13	\N	57	\N	1008	2026-11-05 22:26:29.874258+00	1014	\N	\N
721	411	INSERT	\N	Scheduled	\N	2026-11-13	\N	76	\N	1024	2026-11-05 22:26:29.874258+00	1016	\N	\N
722	412	INSERT	\N	Scheduled	\N	2026-11-16	\N	69	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
723	413	INSERT	\N	Scheduled	\N	2026-11-16	\N	72	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
724	414	INSERT	\N	Scheduled	\N	2026-11-16	\N	69	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
725	415	INSERT	\N	Scheduled	\N	2026-11-16	\N	53	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
726	416	INSERT	\N	Scheduled	\N	2026-11-16	\N	49	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
727	417	INSERT	\N	Scheduled	\N	2026-11-16	\N	49	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
728	418	INSERT	\N	Scheduled	\N	2026-11-16	\N	62	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
729	419	INSERT	\N	Scheduled	\N	2026-11-16	\N	57	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
730	420	INSERT	\N	Scheduled	\N	2026-11-16	\N	70	\N	1005	2026-11-05 22:26:29.874258+00	1030	\N	\N
731	421	INSERT	\N	Scheduled	\N	2026-11-16	\N	50	\N	1006	2026-11-05 22:26:29.874258+00	1015	\N	\N
733	423	INSERT	\N	Scheduled	\N	2026-11-16	\N	62	\N	1008	2026-11-05 22:26:29.874258+00	1014	\N	\N
734	424	INSERT	\N	Scheduled	\N	2026-11-17	\N	70	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
735	425	INSERT	\N	Scheduled	\N	2026-11-17	\N	76	\N	1002	2026-11-05 22:26:29.874258+00	1014	\N	\N
736	426	INSERT	\N	Scheduled	\N	2026-11-17	\N	63	\N	1002	2026-11-05 22:26:29.874258+00	1015	\N	\N
737	427	INSERT	\N	Scheduled	\N	2026-11-17	\N	76	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
738	427	UPDATE	Scheduled	Cancelled	2026-11-17	2026-11-17	76	76	1003	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
739	428	INSERT	\N	Scheduled	\N	2026-11-17	\N	50	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
740	428	UPDATE	Scheduled	Cancelled	2026-11-17	2026-11-17	50	50	1003	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
741	429	INSERT	\N	Scheduled	\N	2026-11-17	\N	57	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
742	430	INSERT	\N	Scheduled	\N	2026-11-17	\N	56	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
743	431	INSERT	\N	Scheduled	\N	2026-11-17	\N	63	\N	1005	2026-11-05 22:26:29.874258+00	1030	\N	\N
744	432	INSERT	\N	Scheduled	\N	2026-11-17	\N	49	\N	1006	2026-11-05 22:26:29.874258+00	1030	\N	\N
745	433	INSERT	\N	Scheduled	\N	2026-11-17	\N	55	\N	1023	2026-11-05 22:26:29.874258+00	1028	\N	\N
746	434	INSERT	\N	Scheduled	\N	2026-11-18	\N	63	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
747	434	UPDATE	Scheduled	Cancelled	2026-11-18	2026-11-18	63	63	1001	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
748	435	INSERT	\N	Scheduled	\N	2026-11-18	\N	64	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
749	436	INSERT	\N	Scheduled	\N	2026-11-18	\N	51	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
750	437	INSERT	\N	Scheduled	\N	2026-11-18	\N	78	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
751	438	INSERT	\N	Scheduled	\N	2026-11-18	\N	63	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
752	439	INSERT	\N	Scheduled	\N	2026-11-18	\N	76	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
753	440	INSERT	\N	Scheduled	\N	2026-11-18	\N	62	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
754	441	INSERT	\N	Scheduled	\N	2026-11-18	\N	70	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
755	442	INSERT	\N	Scheduled	\N	2026-11-18	\N	59	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
756	443	INSERT	\N	Scheduled	\N	2026-11-18	\N	55	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
757	444	INSERT	\N	Scheduled	\N	2026-11-18	\N	78	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
758	445	INSERT	\N	Scheduled	\N	2026-11-18	\N	50	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
759	446	INSERT	\N	Scheduled	\N	2026-11-18	\N	50	\N	1004	2026-11-05 22:26:29.874258+00	1015	\N	\N
760	447	INSERT	\N	Scheduled	\N	2026-11-18	\N	70	\N	1006	2026-11-05 22:26:29.874258+00	1014	\N	\N
761	448	INSERT	\N	Scheduled	\N	2026-11-18	\N	64	\N	1007	2026-11-05 22:26:29.874258+00	1016	\N	\N
762	449	INSERT	\N	Scheduled	\N	2026-11-18	\N	50	\N	1023	2026-11-05 22:26:29.874258+00	1015	\N	\N
763	450	INSERT	\N	Scheduled	\N	2026-11-18	\N	69	\N	1024	2026-11-05 22:26:29.874258+00	1029	\N	\N
764	451	INSERT	\N	Scheduled	\N	2026-11-19	\N	72	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
765	452	INSERT	\N	Scheduled	\N	2026-11-19	\N	78	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
766	453	INSERT	\N	Scheduled	\N	2026-11-19	\N	53	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
767	454	INSERT	\N	Scheduled	\N	2026-11-19	\N	57	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
768	454	UPDATE	Scheduled	Cancelled	2026-11-19	2026-11-19	57	57	1003	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
769	455	INSERT	\N	Scheduled	\N	2026-11-19	\N	64	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
770	456	INSERT	\N	Scheduled	\N	2026-11-19	\N	57	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
771	457	INSERT	\N	Scheduled	\N	2026-11-19	\N	71	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
772	458	INSERT	\N	Scheduled	\N	2026-11-19	\N	73	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
773	459	INSERT	\N	Scheduled	\N	2026-11-19	\N	74	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
774	460	INSERT	\N	Scheduled	\N	2026-11-19	\N	55	\N	1005	2026-11-05 22:26:29.874258+00	1030	\N	\N
775	461	INSERT	\N	Scheduled	\N	2026-11-19	\N	61	\N	1006	2026-11-05 22:26:29.874258+00	1014	\N	\N
776	462	INSERT	\N	Scheduled	\N	2026-11-19	\N	72	\N	1007	2026-11-05 22:26:29.874258+00	1016	\N	\N
777	462	UPDATE	Scheduled	Cancelled	2026-11-19	2026-11-19	72	72	1007	1007	2026-11-05 22:26:29.874258+00	1016	\N	\N
778	463	INSERT	\N	Scheduled	\N	2026-11-19	\N	57	\N	1008	2026-11-05 22:26:29.874258+00	1015	\N	\N
779	464	INSERT	\N	Scheduled	\N	2026-11-20	\N	50	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
780	465	INSERT	\N	Scheduled	\N	2026-11-20	\N	51	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
781	466	INSERT	\N	Scheduled	\N	2026-11-20	\N	78	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
782	467	INSERT	\N	Scheduled	\N	2026-11-20	\N	72	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
783	468	INSERT	\N	Scheduled	\N	2026-11-20	\N	51	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
784	469	INSERT	\N	Scheduled	\N	2026-11-20	\N	62	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
785	470	INSERT	\N	Scheduled	\N	2026-11-20	\N	49	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
786	470	UPDATE	Scheduled	Cancelled	2026-11-20	2026-11-20	49	49	1021	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
787	471	INSERT	\N	Scheduled	\N	2026-11-20	\N	78	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
788	472	INSERT	\N	Scheduled	\N	2026-11-20	\N	51	\N	1005	2026-11-05 22:26:29.874258+00	1016	\N	\N
789	472	UPDATE	Scheduled	Cancelled	2026-11-20	2026-11-20	51	51	1005	1005	2026-11-05 22:26:29.874258+00	1016	\N	\N
790	473	INSERT	\N	Scheduled	\N	2026-11-20	\N	78	\N	1006	2026-11-05 22:26:29.874258+00	1028	\N	\N
791	474	INSERT	\N	Scheduled	\N	2026-11-20	\N	78	\N	1024	2026-11-05 22:26:29.874258+00	1029	\N	\N
792	475	INSERT	\N	Scheduled	\N	2026-11-23	\N	72	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
793	476	INSERT	\N	Scheduled	\N	2026-11-23	\N	63	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
794	476	UPDATE	Scheduled	Cancelled	2026-11-23	2026-11-23	63	63	1001	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
795	477	INSERT	\N	Scheduled	\N	2026-11-23	\N	61	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
796	478	INSERT	\N	Scheduled	\N	2026-11-23	\N	57	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
797	478	UPDATE	Scheduled	Cancelled	2026-11-23	2026-11-23	57	57	1003	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
798	479	INSERT	\N	Scheduled	\N	2026-11-23	\N	78	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
799	480	INSERT	\N	Scheduled	\N	2026-11-23	\N	62	\N	1021	2026-11-05 22:26:29.874258+00	1029	\N	\N
800	481	INSERT	\N	Scheduled	\N	2026-11-23	\N	59	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
801	482	INSERT	\N	Scheduled	\N	2026-11-23	\N	61	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
802	483	INSERT	\N	Scheduled	\N	2026-11-23	\N	72	\N	1023	2026-11-05 22:26:29.874258+00	1028	\N	\N
803	484	INSERT	\N	Scheduled	\N	2026-11-24	\N	59	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
804	485	INSERT	\N	Scheduled	\N	2026-11-24	\N	69	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
805	486	INSERT	\N	Scheduled	\N	2026-11-24	\N	72	\N	1002	2026-11-05 22:26:29.874258+00	1015	\N	\N
806	487	INSERT	\N	Scheduled	\N	2026-11-24	\N	78	\N	1002	2026-11-05 22:26:29.874258+00	1028	\N	\N
807	488	INSERT	\N	Scheduled	\N	2026-11-24	\N	76	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
808	489	INSERT	\N	Scheduled	\N	2026-11-24	\N	53	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
809	490	INSERT	\N	Scheduled	\N	2026-11-24	\N	76	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
810	490	UPDATE	Scheduled	Cancelled	2026-11-24	2026-11-24	76	76	1021	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
811	491	INSERT	\N	Scheduled	\N	2026-11-24	\N	56	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
812	492	INSERT	\N	Scheduled	\N	2026-11-24	\N	60	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
813	493	INSERT	\N	Scheduled	\N	2026-11-24	\N	79	\N	1022	2026-11-05 22:26:29.874258+00	1016	\N	\N
814	494	INSERT	\N	Scheduled	\N	2026-11-24	\N	63	\N	1006	2026-11-05 22:26:29.874258+00	1030	\N	\N
815	495	INSERT	\N	Scheduled	\N	2026-11-24	\N	78	\N	1023	2026-11-05 22:26:29.874258+00	1014	\N	\N
816	496	INSERT	\N	Scheduled	\N	2026-11-25	\N	57	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
817	497	INSERT	\N	Scheduled	\N	2026-11-25	\N	55	\N	1001	2026-11-05 22:26:29.874258+00	1028	\N	\N
818	498	INSERT	\N	Scheduled	\N	2026-11-25	\N	49	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
819	499	INSERT	\N	Scheduled	\N	2026-11-25	\N	72	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
820	500	INSERT	\N	Scheduled	\N	2026-11-25	\N	53	\N	1003	2026-11-05 22:26:29.874258+00	1015	\N	\N
821	501	INSERT	\N	Scheduled	\N	2026-11-25	\N	63	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
822	502	INSERT	\N	Scheduled	\N	2026-11-25	\N	78	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
823	503	INSERT	\N	Scheduled	\N	2026-11-25	\N	78	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
824	504	INSERT	\N	Scheduled	\N	2026-11-25	\N	59	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
825	505	INSERT	\N	Scheduled	\N	2026-11-25	\N	64	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
826	506	INSERT	\N	Scheduled	\N	2026-11-25	\N	62	\N	1004	2026-11-05 22:26:29.874258+00	1014	\N	\N
827	507	INSERT	\N	Scheduled	\N	2026-11-25	\N	53	\N	1006	2026-11-05 22:26:29.874258+00	1028	\N	\N
828	508	INSERT	\N	Scheduled	\N	2026-11-25	\N	50	\N	1007	2026-11-05 22:26:29.874258+00	1029	\N	\N
829	509	INSERT	\N	Scheduled	\N	2026-11-25	\N	70	\N	1008	2026-11-05 22:26:29.874258+00	1015	\N	\N
830	510	INSERT	\N	Scheduled	\N	2026-11-25	\N	50	\N	1024	2026-11-05 22:26:29.874258+00	1016	\N	\N
831	510	UPDATE	Scheduled	Cancelled	2026-11-25	2026-11-25	50	50	1024	1024	2026-11-05 22:26:29.874258+00	1016	\N	\N
832	511	INSERT	\N	Scheduled	\N	2026-11-26	\N	69	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
833	512	INSERT	\N	Scheduled	\N	2026-11-26	\N	72	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
834	513	INSERT	\N	Scheduled	\N	2026-11-26	\N	53	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
835	514	INSERT	\N	Scheduled	\N	2026-11-26	\N	72	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
836	515	INSERT	\N	Scheduled	\N	2026-11-26	\N	53	\N	1021	2026-11-05 22:26:29.874258+00	1030	\N	\N
837	516	INSERT	\N	Scheduled	\N	2026-11-26	\N	73	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
838	517	INSERT	\N	Scheduled	\N	2026-11-26	\N	56	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
839	518	INSERT	\N	Scheduled	\N	2026-11-26	\N	64	\N	1006	2026-11-05 22:26:29.874258+00	1028	\N	\N
840	519	INSERT	\N	Scheduled	\N	2026-11-26	\N	63	\N	1008	2026-11-05 22:26:29.874258+00	1015	\N	\N
841	520	INSERT	\N	Scheduled	\N	2026-11-26	\N	53	\N	1023	2026-11-05 22:26:29.874258+00	1014	\N	\N
842	520	UPDATE	Scheduled	Cancelled	2026-11-26	2026-11-26	53	53	1023	1023	2026-11-05 22:26:29.874258+00	1014	\N	\N
843	521	INSERT	\N	Scheduled	\N	2026-11-27	\N	63	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
844	521	UPDATE	Scheduled	Cancelled	2026-11-27	2026-11-27	63	63	1001	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
845	522	INSERT	\N	Scheduled	\N	2026-11-27	\N	62	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
846	523	INSERT	\N	Scheduled	\N	2026-11-27	\N	50	\N	1001	2026-11-05 22:26:29.874258+00	1015	\N	\N
847	524	INSERT	\N	Scheduled	\N	2026-11-27	\N	61	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
848	524	UPDATE	Scheduled	Cancelled	2026-11-27	2026-11-27	61	61	1002	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
849	525	INSERT	\N	Scheduled	\N	2026-11-27	\N	59	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
850	526	INSERT	\N	Scheduled	\N	2026-11-27	\N	78	\N	1002	2026-11-05 22:26:29.874258+00	1030	\N	\N
851	527	INSERT	\N	Scheduled	\N	2026-11-27	\N	57	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
852	527	UPDATE	Scheduled	Cancelled	2026-11-27	2026-11-27	57	57	1003	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
853	528	INSERT	\N	Scheduled	\N	2026-11-27	\N	64	\N	1003	2026-11-05 22:26:29.874258+00	1014	\N	\N
854	529	INSERT	\N	Scheduled	\N	2026-11-27	\N	62	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
855	530	INSERT	\N	Scheduled	\N	2026-11-27	\N	57	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
856	531	INSERT	\N	Scheduled	\N	2026-11-27	\N	64	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
857	532	INSERT	\N	Scheduled	\N	2026-11-27	\N	55	\N	1022	2026-11-05 22:26:29.874258+00	1029	\N	\N
858	533	INSERT	\N	Scheduled	\N	2026-11-27	\N	57	\N	1007	2026-11-05 22:26:29.874258+00	1030	\N	\N
859	534	INSERT	\N	Scheduled	\N	2026-11-27	\N	63	\N	1008	2026-11-05 22:26:29.874258+00	1028	\N	\N
860	535	INSERT	\N	Scheduled	\N	2026-11-30	\N	59	\N	1001	2026-11-05 22:26:29.874258+00	1014	\N	\N
861	536	INSERT	\N	Scheduled	\N	2026-11-30	\N	78	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
862	537	INSERT	\N	Scheduled	\N	2026-11-30	\N	70	\N	1002	2026-11-05 22:26:29.874258+00	1029	\N	\N
863	538	INSERT	\N	Scheduled	\N	2026-11-30	\N	76	\N	1002	2026-11-05 22:26:29.874258+00	1016	\N	\N
864	539	INSERT	\N	Scheduled	\N	2026-11-30	\N	63	\N	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
865	539	UPDATE	Scheduled	Cancelled	2026-11-30	2026-11-30	63	63	1003	1003	2026-11-05 22:26:29.874258+00	1028	\N	\N
866	540	INSERT	\N	Scheduled	\N	2026-11-30	\N	57	\N	1021	2026-11-05 22:26:29.874258+00	1016	\N	\N
867	541	INSERT	\N	Scheduled	\N	2026-11-30	\N	57	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
868	542	INSERT	\N	Scheduled	\N	2026-11-30	\N	53	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
869	543	INSERT	\N	Scheduled	\N	2026-11-30	\N	51	\N	1022	2026-11-05 22:26:29.874258+00	1030	\N	\N
870	544	INSERT	\N	Scheduled	\N	2026-11-30	\N	70	\N	1006	2026-11-05 22:26:29.874258+00	1028	\N	\N
871	545	INSERT	\N	Scheduled	\N	2026-11-30	\N	49	\N	1007	2026-11-05 22:26:29.874258+00	1030	\N	\N
872	546	INSERT	\N	Scheduled	\N	2026-11-30	\N	69	\N	1023	2026-11-05 22:26:29.874258+00	1015	\N	\N
873	329	UPDATE	Scheduled	No Show	2026-11-05	2026-11-05	63	63	1001	1001	2026-11-05 22:28:23.610362+00	\N	\N	\N
874	330	UPDATE	Scheduled	No Show	2026-11-05	2026-11-05	72	72	1001	1001	2026-11-05 22:28:23.610362+00	\N	\N	\N
875	331	UPDATE	Scheduled	No Show	2026-11-05	2026-11-05	50	50	1002	1002	2026-11-05 22:28:23.610362+00	\N	\N	\N
876	332	UPDATE	Scheduled	No Show	2026-11-05	2026-11-05	61	61	1003	1003	2026-11-05 22:28:23.610362+00	\N	\N	\N
877	339	UPDATE	Scheduled	No Show	2026-11-05	2026-11-05	61	61	1024	1024	2026-11-05 22:28:23.610362+00	\N	\N	\N
878	328	UPDATE	Scheduled	No Show	2026-11-05	2026-11-05	51	51	1001	1001	2026-11-05 22:31:06.615374+00	\N	\N	\N
879	337	UPDATE	Scheduled	No Show	2026-11-05	2026-11-05	76	76	1006	1006	2026-11-05 23:11:28.225683+00	\N	\N	\N
880	547	INSERT	\N	Scheduled	\N	2026-11-27	\N	61	\N	1007	2026-11-06 01:36:43.555369+00	\N	\N	\N
881	548	INSERT	\N	Scheduled	\N	2026-11-06	\N	51	\N	1002	2026-11-06 01:37:08.321224+00	\N	\N	\N
882	340	UPDATE	Scheduled	No Show	2026-11-06	2026-11-06	78	78	1001	1001	2026-11-06 14:41:02.415712+00	\N	\N	\N
883	342	UPDATE	Scheduled	No Show	2026-11-06	2026-11-06	69	69	1003	1003	2026-11-06 19:12:31.340755+00	\N	\N	\N
884	346	UPDATE	Scheduled	No Show	2026-11-06	2026-11-06	57	57	1022	1022	2026-11-06 19:12:31.340755+00	\N	\N	\N
885	341	UPDATE	Scheduled	No Show	2026-11-06	2026-11-06	72	72	1002	1002	2026-11-06 23:43:15.049459+00	\N	\N	\N
886	343	UPDATE	Scheduled	No Show	2026-11-06	2026-11-06	53	53	1003	1003	2026-11-06 23:43:15.049459+00	\N	\N	\N
887	344	UPDATE	Scheduled	No Show	2026-11-06	2026-11-06	50	50	1021	1021	2026-11-06 23:43:15.049459+00	\N	\N	\N
888	345	UPDATE	Scheduled	No Show	2026-11-06	2026-11-06	51	51	1022	1022	2026-11-06 23:43:15.049459+00	\N	\N	\N
889	347	UPDATE	Scheduled	No Show	2026-11-06	2026-11-06	72	72	1004	1004	2026-11-06 23:43:15.049459+00	\N	\N	\N
890	548	UPDATE	Scheduled	No Show	2026-11-06	2026-11-06	51	51	1002	1002	2026-11-06 23:43:15.049459+00	\N	\N	\N
891	350	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	78	78	1002	1002	2026-11-09 18:27:28.356298+00	\N	\N	\N
892	351	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	57	57	1002	1002	2026-11-09 18:27:28.356298+00	\N	\N	\N
893	354	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	55	55	1022	1022	2026-11-09 18:27:28.356298+00	\N	\N	\N
894	356	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	59	59	1004	1004	2026-11-09 18:27:28.356298+00	\N	\N	\N
895	358	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	57	57	1007	1007	2026-11-09 18:27:28.356298+00	\N	\N	\N
896	359	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	55	55	1008	1008	2026-11-09 18:27:28.356298+00	\N	\N	\N
897	549	INSERT	\N	Scheduled	\N	2026-11-09	\N	63	\N	1021	2026-11-09 18:49:48.582424+00	\N	\N	\N
898	550	INSERT	\N	Scheduled	\N	2026-11-09	\N	61	\N	1021	2026-11-09 18:54:28.334114+00	\N	\N	\N
899	353	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	72	72	1021	1021	2026-11-09 20:02:14.051092+00	\N	\N	\N
900	355	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	72	72	1022	1022	2026-11-09 20:02:14.051092+00	\N	\N	\N
901	348	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	61	61	1001	1001	2026-11-09 21:03:19.582119+00	\N	\N	\N
902	349	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	53	53	1001	1001	2026-11-09 21:03:19.582119+00	\N	\N	\N
903	550	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	61	61	1021	1021	2026-11-09 21:03:19.582119+00	\N	\N	\N
904	93	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	55	55	1003	1003	2026-11-10 16:05:23.494258+00	\N	\N	\N
905	352	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	76	76	1003	1003	2026-11-10 16:05:23.494258+00	\N	\N	\N
906	357	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	76	76	1006	1006	2026-11-10 16:05:23.494258+00	\N	\N	\N
907	363	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	59	59	1002	1002	2026-11-10 16:05:23.494258+00	\N	\N	\N
908	364	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	64	64	1003	1003	2026-11-10 16:05:23.494258+00	\N	\N	\N
909	368	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	79	79	1022	1022	2026-11-10 16:05:23.494258+00	\N	\N	\N
910	369	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	64	64	1004	1004	2026-11-10 16:05:23.494258+00	\N	\N	\N
911	370	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	55	55	1005	1005	2026-11-10 16:05:23.494258+00	\N	\N	\N
912	549	UPDATE	Scheduled	No Show	2026-11-09	2026-11-09	63	63	1021	1021	2026-11-10 16:05:23.494258+00	\N	\N	\N
913	367	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	73	73	1022	1022	2026-11-10 16:44:25.102282+00	\N	\N	\N
914	551	INSERT	\N	Scheduled	\N	2026-11-10	\N	70	\N	1021	2026-11-10 16:45:59.580606+00	\N	\N	\N
915	552	INSERT	\N	Scheduled	\N	2026-11-10	\N	72	\N	1002	2026-11-10 16:47:24.03612+00	\N	\N	\N
916	366	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	54	54	1022	1022	2026-11-10 17:16:52.534361+00	\N	\N	\N
917	362	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	49	49	1002	1002	2026-11-10 17:32:53.221532+00	\N	\N	\N
918	553	INSERT	\N	Scheduled	\N	2026-11-10	\N	50	\N	1021	2026-11-10 17:44:35.311896+00	\N	\N	\N
919	554	INSERT	\N	Scheduled	\N	2026-11-10	\N	53	\N	1003	2026-11-10 17:47:23.985368+00	\N	\N	\N
920	554	UPDATE	Scheduled	Scheduled	2026-11-10	2026-11-10	53	53	1003	1003	2026-11-10 17:48:02.877043+00	1014	2026-11-10 17:48:02.877043+00	\N
921	555	INSERT	\N	Scheduled	\N	2026-11-10	\N	61	\N	1021	2026-11-10 17:54:56.813264+00	\N	\N	\N
922	556	INSERT	\N	Scheduled	\N	2026-11-10	\N	63	\N	1021	2026-11-10 17:55:11.961381+00	\N	\N	\N
923	94	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	50	50	1007	1007	2026-11-10 21:23:07.45755+00	\N	\N	\N
924	361	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	50	50	1002	1002	2026-11-10 21:23:07.45755+00	\N	\N	\N
925	551	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	70	70	1021	1021	2026-11-10 21:23:07.45755+00	\N	\N	\N
926	552	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	72	72	1002	1002	2026-11-10 21:23:07.45755+00	\N	\N	\N
927	553	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	50	50	1021	1021	2026-11-10 21:23:07.45755+00	\N	\N	\N
928	555	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	61	61	1021	1021	2026-11-10 21:23:07.45755+00	\N	\N	\N
929	556	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	63	63	1021	1021	2026-11-10 22:05:27.804655+00	\N	\N	\N
930	371	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	51	51	1023	1023	2026-11-10 22:32:07.523113+00	\N	\N	\N
931	360	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	76	76	1001	1001	2026-11-10 23:37:57.06785+00	\N	\N	\N
932	365	UPDATE	Scheduled	No Show	2026-11-10	2026-11-10	76	76	1021	1021	2026-11-10 23:37:57.06785+00	\N	\N	\N
933	557	INSERT	\N	Scheduled	\N	2026-11-19	\N	51	\N	1006	2026-11-11 01:55:11.163201+00	\N	\N	\N
934	558	INSERT	\N	Scheduled	\N	2026-11-11	\N	59	\N	1003	2026-11-11 02:13:31.386497+00	\N	\N	\N
935	559	INSERT	\N	Scheduled	\N	2026-11-11	\N	51	\N	1021	2026-11-11 02:17:13.686182+00	\N	\N	\N
936	560	INSERT	\N	Scheduled	\N	2026-11-26	\N	53	\N	1001	2026-11-11 02:20:33.482197+00	\N	\N	\N
937	561	INSERT	\N	Scheduled	\N	2026-11-18	\N	53	\N	1002	2026-11-11 02:21:45.416249+00	\N	\N	\N
938	105	UPDATE	Scheduled	Cancelled	2026-12-18	2026-12-18	64	64	1001	1001	2026-11-11 02:22:24.950537+00	\N	\N	\N
939	523	UPDATE	Scheduled	Cancelled	2026-11-27	2026-11-27	50	50	1001	1001	2026-11-11 02:22:27.784758+00	\N	\N	\N
940	547	UPDATE	Scheduled	Cancelled	2026-11-27	2026-11-27	61	61	1007	1007	2026-11-11 02:22:30.428855+00	\N	\N	\N
941	560	UPDATE	Scheduled	Cancelled	2026-11-26	2026-11-26	53	53	1001	1001	2026-11-11 02:22:32.985052+00	\N	\N	\N
942	504	UPDATE	Scheduled	Cancelled	2026-11-25	2026-11-25	59	59	1021	1021	2026-11-11 02:22:35.014054+00	\N	\N	\N
943	562	INSERT	\N	Scheduled	\N	2026-11-12	\N	51	\N	1002	2026-11-11 02:27:06.768378+00	\N	\N	\N
944	563	INSERT	\N	Scheduled	\N	2026-11-13	\N	76	\N	1001	2026-11-11 02:27:21.882557+00	\N	\N	\N
945	564	INSERT	\N	Scheduled	\N	2026-11-13	\N	59	\N	1004	2026-11-11 02:27:35.720644+00	\N	\N	\N
946	565	INSERT	\N	Scheduled	\N	2026-11-13	\N	49	\N	1001	2026-11-11 02:35:02.416441+00	\N	\N	\N
947	566	INSERT	\N	Scheduled	\N	2026-11-17	\N	53	\N	1001	2026-11-11 02:40:21.446366+00	\N	\N	\N
948	567	INSERT	\N	Scheduled	\N	2026-11-17	\N	61	\N	1002	2026-11-11 02:40:41.817594+00	\N	\N	\N
949	568	INSERT	\N	Scheduled	\N	2026-12-30	\N	51	\N	1022	2026-11-11 02:41:50.999631+00	\N	\N	\N
950	569	INSERT	\N	Scheduled	\N	2026-12-30	\N	63	\N	1002	2026-11-11 02:42:12.90959+00	\N	\N	\N
951	570	INSERT	\N	Scheduled	\N	2026-12-30	\N	62	\N	1022	2026-11-11 02:42:46.876765+00	\N	\N	\N
952	571	INSERT	\N	Scheduled	\N	2026-12-24	\N	60	\N	1022	2026-11-11 02:49:43.607027+00	\N	\N	\N
953	572	INSERT	\N	Scheduled	\N	2026-12-31	\N	72	\N	1002	2026-11-11 02:55:44.787981+00	\N	\N	\N
954	573	INSERT	\N	Scheduled	\N	2026-12-02	\N	57	\N	1003	2026-11-11 09:38:38.402191+00	\N	\N	\N
955	573	UPDATE	Scheduled	Cancelled	2026-12-02	2026-12-02	57	57	1003	1003	2026-11-11 09:39:00.97301+00	\N	\N	\N
956	375	UPDATE	Scheduled	No Show	2026-11-11	2026-11-11	78	78	1003	1003	2026-11-11 19:15:49.791655+00	\N	\N	\N
957	377	UPDATE	Scheduled	No Show	2026-11-11	2026-11-11	49	49	1021	1021	2026-11-11 19:15:49.791655+00	\N	\N	\N
958	378	UPDATE	Scheduled	No Show	2026-11-11	2026-11-11	70	70	1022	1022	2026-11-11 19:15:49.791655+00	\N	\N	\N
959	379	UPDATE	Scheduled	No Show	2026-11-11	2026-11-11	49	49	1005	1005	2026-11-11 19:15:49.791655+00	\N	\N	\N
960	558	UPDATE	Scheduled	No Show	2026-11-11	2026-11-11	59	59	1003	1003	2026-11-11 19:15:49.791655+00	\N	\N	\N
961	574	INSERT	\N	Scheduled	\N	2026-11-11	\N	72	\N	1001	2026-11-11 19:16:31.333018+00	\N	\N	\N
962	574	UPDATE	Scheduled	Scheduled	2026-11-11	2026-11-11	72	72	1001	1001	2026-11-11 19:17:10.530837+00	1014	2026-11-11 19:17:10.530837+00	\N
963	575	INSERT	\N	Scheduled	\N	2026-11-11	\N	72	\N	1021	2026-11-11 19:21:29.916848+00	\N	\N	\N
964	372	UPDATE	Scheduled	Scheduled	2026-11-11	2026-11-11	62	62	1001	1001	2026-11-11 19:23:02.155663+00	1014	2026-11-11 19:23:02.155663+00	\N
965	380	UPDATE	Scheduled	No Show	2026-11-11	2026-11-11	50	50	1007	1007	2026-11-11 19:32:16.83244+00	\N	\N	\N
966	373	UPDATE	Scheduled	No Show	2026-11-11	2026-11-11	63	63	1002	1002	2026-11-11 21:33:38.781711+00	\N	\N	\N
967	376	UPDATE	Scheduled	No Show	2026-11-11	2026-11-11	61	61	1021	1021	2026-11-11 21:33:38.781711+00	\N	\N	\N
968	575	UPDATE	Scheduled	No Show	2026-11-11	2026-11-11	72	72	1021	1021	2026-11-11 21:33:38.781711+00	\N	\N	\N
969	559	UPDATE	Scheduled	No Show	2026-11-11	2026-11-11	51	51	1021	1021	2026-11-11 22:36:18.49047+00	\N	\N	\N
970	576	INSERT	\N	Scheduled	\N	2026-11-12	\N	78	\N	1021	2026-11-11 22:38:28.208702+00	\N	\N	\N
971	577	INSERT	\N	Scheduled	\N	2026-11-12	\N	59	\N	1002	2026-11-11 23:39:25.156861+00	\N	\N	\N
972	578	INSERT	\N	Scheduled	\N	2026-11-26	\N	61	\N	1002	2026-11-12 03:25:57.146871+00	\N	\N	\N
973	579	INSERT	\N	Scheduled	\N	2026-11-26	\N	57	\N	1002	2026-11-12 03:26:47.549992+00	\N	\N	\N
974	580	INSERT	\N	Scheduled	\N	2026-11-25	\N	53	\N	1022	2026-11-12 03:27:00.661964+00	\N	\N	\N
975	581	INSERT	\N	Scheduled	\N	2026-11-27	\N	69	\N	1022	2026-11-12 03:27:13.743481+00	\N	\N	\N
976	582	INSERT	\N	Scheduled	\N	2026-11-26	\N	64	\N	1003	2026-11-12 03:27:40.206299+00	\N	\N	\N
977	583	INSERT	\N	Scheduled	\N	2026-11-23	\N	57	\N	1001	2026-11-12 03:28:06.462342+00	\N	\N	\N
978	584	INSERT	\N	Scheduled	\N	2026-11-12	\N	64	\N	1001	2026-11-12 03:30:33.502077+00	\N	\N	\N
979	585	INSERT	\N	Scheduled	\N	2026-11-12	\N	57	\N	1002	2026-11-12 03:30:42.373078+00	\N	\N	\N
980	586	INSERT	\N	Scheduled	\N	2026-11-18	\N	55	\N	1002	2026-11-12 03:38:14.490777+00	\N	\N	\N
981	570	UPDATE	Scheduled	Cancelled	2026-12-30	2026-12-30	62	62	1022	1022	2026-11-12 03:42:28.101094+00	\N	\N	\N
982	465	UPDATE	Scheduled	Cancelled	2026-11-20	2026-11-20	51	51	1001	1001	2026-11-12 03:44:00.974914+00	\N	\N	\N
983	571	UPDATE	Scheduled	Cancelled	2026-12-24	2026-12-24	60	60	1022	1022	2026-11-12 03:44:09.209311+00	\N	\N	\N
984	587	INSERT	\N	Scheduled	\N	2026-11-25	\N	61	\N	1002	2026-11-12 04:23:16.28991+00	\N	\N	\N
985	382	UPDATE	Scheduled	Cancelled	2026-11-12	2026-11-12	55	55	1001	1001	2026-11-12 04:23:41.329377+00	\N	\N	\N
986	426	UPDATE	Scheduled	Cancelled	2026-11-17	2026-11-17	63	63	1002	1002	2026-11-12 04:23:52.891734+00	\N	\N	\N
987	588	INSERT	\N	Scheduled	\N	2026-11-24	\N	61	\N	1001	2026-11-12 11:02:35.348947+00	\N	\N	\N
988	589	INSERT	\N	Scheduled	\N	2026-11-17	\N	72	\N	1001	2026-11-12 11:05:06.2605+00	\N	\N	\N
989	589	UPDATE	Scheduled	Cancelled	2026-11-17	2026-11-17	72	72	1001	1001	2026-11-12 11:05:26.496011+00	\N	\N	\N
990	383	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	78	78	1001	1001	2026-11-12 15:29:46.080718+00	\N	\N	\N
991	394	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	78	78	1007	1007	2026-11-12 15:29:46.080718+00	\N	\N	\N
992	576	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	78	78	1021	1021	2026-11-12 15:29:46.080718+00	\N	\N	\N
993	577	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	59	59	1002	1002	2026-11-12 15:29:46.080718+00	\N	\N	\N
994	387	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	64	64	1003	1003	2026-11-12 17:28:43.258866+00	\N	\N	\N
995	388	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	69	69	1003	1003	2026-11-12 17:28:43.258866+00	\N	\N	\N
996	390	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	71	71	1022	1022	2026-11-12 17:28:43.258866+00	\N	\N	\N
997	392	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	57	57	1005	1005	2026-11-12 17:28:43.258866+00	\N	\N	\N
998	395	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	57	57	1008	1008	2026-11-12 17:28:43.258866+00	\N	\N	\N
999	396	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	57	57	1023	1023	2026-11-12 17:28:43.258866+00	\N	\N	\N
1000	584	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	64	64	1001	1001	2026-11-12 17:28:43.258866+00	\N	\N	\N
1001	585	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	57	57	1002	1002	2026-11-12 17:28:43.258866+00	\N	\N	\N
1002	384	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	50	50	1002	1002	2026-11-12 20:09:06.824602+00	\N	\N	\N
1003	391	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	49	49	1004	1004	2026-11-12 20:09:06.824602+00	\N	\N	\N
1004	381	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	53	53	1001	1001	2026-11-12 20:30:15.523462+00	\N	\N	\N
1005	562	UPDATE	Scheduled	Cancelled	2026-11-12	2026-11-12	51	51	1002	1002	2026-11-12 20:43:04.062461+00	\N	\N	\N
1006	385	UPDATE	Scheduled	Scheduled	2026-11-12	2026-11-12	76	76	1002	1002	2026-11-12 20:44:43.655517+00	1016	2026-11-12 20:44:43.655517+00	\N
1007	385	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	76	76	1002	1002	2026-11-12 20:46:44.481835+00	1016	2026-11-12 20:44:43.655517+00	2026-11-12 20:46:44.481835+00
1008	590	INSERT	\N	Scheduled	\N	2026-11-12	\N	63	\N	1001	2026-11-12 20:51:01.831383+00	\N	\N	\N
1009	591	INSERT	\N	Scheduled	\N	2026-11-12	\N	62	\N	1001	2026-11-12 20:51:04.429248+00	\N	\N	\N
1010	592	INSERT	\N	Scheduled	\N	2026-11-12	\N	51	\N	1001	2026-11-12 20:51:06.958271+00	\N	\N	\N
1011	593	INSERT	\N	Scheduled	\N	2026-11-12	\N	76	\N	1001	2026-11-12 20:51:08.791577+00	\N	\N	\N
1012	594	INSERT	\N	Scheduled	\N	2026-11-19	\N	55	\N	1001	2026-11-12 20:53:46.415719+00	\N	\N	\N
1013	594	UPDATE	Scheduled	Cancelled	2026-11-19	2026-11-19	55	55	1001	1001	2026-11-12 20:55:00.531403+00	\N	\N	\N
1014	595	INSERT	\N	Scheduled	\N	2026-11-17	\N	64	\N	1001	2026-11-12 20:58:38.169678+00	\N	\N	\N
1015	595	UPDATE	Scheduled	Cancelled	2026-11-17	2026-11-17	64	64	1001	1001	2026-11-12 20:58:59.171597+00	\N	\N	\N
1016	393	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	61	61	1006	1006	2026-11-12 21:00:17.963724+00	\N	\N	\N
1017	596	INSERT	\N	Scheduled	\N	2026-11-18	\N	55	\N	1001	2026-11-12 21:02:26.141246+00	\N	\N	\N
1018	442	UPDATE	Scheduled	Cancelled	2026-11-18	2026-11-18	59	59	1003	1003	2026-11-12 21:02:42.483021+00	\N	\N	\N
1019	85	UPDATE	No Show	Scheduled	2026-10-23	2026-10-23	62	62	1007	1007	2026-11-12 21:11:34.014843+00	1029	2026-10-23 20:15:00+00	\N
1020	85	UPDATE	Scheduled	Completed	2026-10-23	2026-10-23	62	62	1007	1007	2026-11-12 21:11:34.014843+00	1029	2026-10-23 20:15:00+00	2026-10-23 21:10:00+00
1021	108	UPDATE	No Show	Scheduled	2026-10-26	2026-10-26	64	64	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-10-26 13:55:00+00	\N
1022	108	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	64	64	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-10-26 13:55:00+00	2026-10-26 14:47:00+00
1023	87	UPDATE	No Show	Scheduled	2026-10-26	2026-10-26	76	76	1002	1002	2026-11-12 21:11:34.014843+00	1016	2026-10-26 21:27:00+00	\N
1024	87	UPDATE	Scheduled	Completed	2026-10-26	2026-10-26	76	76	1002	1002	2026-11-12 21:11:34.014843+00	1016	2026-10-26 21:27:00+00	2026-10-26 22:08:00+00
1025	111	UPDATE	No Show	Scheduled	2026-10-28	2026-10-28	78	78	1002	1002	2026-11-12 21:11:34.014843+00	1016	2026-10-28 12:50:00+00	\N
1026	111	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	78	78	1002	1002	2026-11-12 21:11:34.014843+00	1016	2026-10-28 12:50:00+00	2026-10-28 13:40:00+00
1027	112	UPDATE	No Show	Scheduled	2026-10-28	2026-10-28	59	59	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-10-28 13:23:00+00	\N
1028	112	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	59	59	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-10-28 13:23:00+00	2026-10-28 14:05:00+00
1029	113	UPDATE	No Show	Scheduled	2026-10-28	2026-10-28	64	64	1001	1001	2026-11-12 21:11:34.014843+00	1028	2026-10-28 14:00:00+00	\N
1030	113	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	64	64	1001	1001	2026-11-12 21:11:34.014843+00	1028	2026-10-28 14:00:00+00	2026-10-28 14:52:00+00
1031	88	UPDATE	No Show	Scheduled	2026-10-28	2026-10-28	70	70	1002	1002	2026-11-12 21:11:34.014843+00	1016	2026-10-28 16:17:00+00	\N
1032	88	UPDATE	Scheduled	Completed	2026-10-28	2026-10-28	70	70	1002	1002	2026-11-12 21:11:34.014843+00	1016	2026-10-28 16:17:00+00	2026-10-28 17:02:00+00
1033	110	UPDATE	No Show	Scheduled	2026-10-29	2026-10-29	78	78	1003	1003	2026-11-12 21:11:34.014843+00	1014	2026-10-29 12:53:00+00	\N
1034	110	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	78	78	1003	1003	2026-11-12 21:11:34.014843+00	1014	2026-10-29 12:53:00+00	2026-10-29 13:31:00+00
1035	90	UPDATE	No Show	Scheduled	2026-10-29	2026-10-29	51	51	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-10-29 20:59:00+00	\N
1036	90	UPDATE	Scheduled	Completed	2026-10-29	2026-10-29	51	51	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-10-29 20:59:00+00	2026-10-29 21:58:00+00
1037	115	UPDATE	No Show	Scheduled	2026-10-30	2026-10-30	49	49	1001	1001	2026-11-12 21:11:34.014843+00	1028	2026-10-30 15:52:00+00	\N
1038	115	UPDATE	Scheduled	Completed	2026-10-30	2026-10-30	49	49	1001	1001	2026-11-12 21:11:34.014843+00	1028	2026-10-30 15:52:00+00	2026-10-30 16:30:00+00
1039	117	UPDATE	No Show	Scheduled	2026-10-30	2026-10-30	76	76	1003	1003	2026-11-12 21:11:34.014843+00	1015	2026-10-30 21:21:00+00	\N
1040	117	UPDATE	Scheduled	Completed	2026-10-30	2026-10-30	76	76	1003	1003	2026-11-12 21:11:34.014843+00	1015	2026-10-30 21:21:00+00	2026-10-30 21:57:00+00
1041	331	UPDATE	No Show	Scheduled	2026-11-05	2026-11-05	50	50	1002	1002	2026-11-12 21:11:34.014843+00	1016	2026-11-05 18:57:00+00	\N
1042	331	UPDATE	Scheduled	Completed	2026-11-05	2026-11-05	50	50	1002	1002	2026-11-12 21:11:34.014843+00	1016	2026-11-05 18:57:00+00	2026-11-05 19:47:00+00
1043	330	UPDATE	No Show	Scheduled	2026-11-05	2026-11-05	72	72	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-11-05 19:18:00+00	\N
1044	330	UPDATE	Scheduled	Completed	2026-11-05	2026-11-05	72	72	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-11-05 19:18:00+00	2026-11-05 20:18:00+00
1045	332	UPDATE	No Show	Scheduled	2026-11-05	2026-11-05	61	61	1003	1003	2026-11-12 21:11:34.014843+00	1015	2026-11-05 20:19:00+00	\N
1046	332	UPDATE	Scheduled	Completed	2026-11-05	2026-11-05	61	61	1003	1003	2026-11-12 21:11:34.014843+00	1015	2026-11-05 20:19:00+00	2026-11-05 21:07:00+00
1047	329	UPDATE	No Show	Scheduled	2026-11-05	2026-11-05	63	63	1001	1001	2026-11-12 21:11:34.014843+00	1028	2026-11-05 20:46:00+00	\N
1048	329	UPDATE	Scheduled	Completed	2026-11-05	2026-11-05	63	63	1001	1001	2026-11-12 21:11:34.014843+00	1028	2026-11-05 20:46:00+00	2026-11-05 21:30:00+00
1049	328	UPDATE	No Show	Scheduled	2026-11-05	2026-11-05	51	51	1001	1001	2026-11-12 21:11:34.014843+00	1028	2026-11-05 21:49:00+00	\N
1050	328	UPDATE	Scheduled	Completed	2026-11-05	2026-11-05	51	51	1001	1001	2026-11-12 21:11:34.014843+00	1028	2026-11-05 21:49:00+00	2026-11-05 22:26:00+00
1051	337	UPDATE	No Show	Scheduled	2026-11-05	2026-11-05	76	76	1006	1006	2026-11-12 21:11:34.014843+00	1015	2026-11-05 22:20:00+00	\N
1052	337	UPDATE	Scheduled	Completed	2026-11-05	2026-11-05	76	76	1006	1006	2026-11-12 21:11:34.014843+00	1015	2026-11-05 22:20:00+00	2026-11-05 23:03:00+00
1053	340	UPDATE	No Show	Scheduled	2026-11-06	2026-11-06	78	78	1001	1001	2026-11-12 21:11:34.014843+00	1015	2026-11-06 13:49:00+00	\N
1054	340	UPDATE	Scheduled	Completed	2026-11-06	2026-11-06	78	78	1001	1001	2026-11-12 21:11:34.014843+00	1015	2026-11-06 13:49:00+00	2026-11-06 14:31:00+00
1055	342	UPDATE	No Show	Scheduled	2026-11-06	2026-11-06	69	69	1003	1003	2026-11-12 21:11:34.014843+00	1014	2026-11-06 16:24:00+00	\N
1056	342	UPDATE	Scheduled	Completed	2026-11-06	2026-11-06	69	69	1003	1003	2026-11-12 21:11:34.014843+00	1014	2026-11-06 16:24:00+00	2026-11-06 17:07:00+00
1057	344	UPDATE	No Show	Scheduled	2026-11-06	2026-11-06	50	50	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-06 18:48:00+00	\N
1058	344	UPDATE	Scheduled	Completed	2026-11-06	2026-11-06	50	50	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-06 18:48:00+00	2026-11-06 19:20:00+00
1059	341	UPDATE	No Show	Scheduled	2026-11-06	2026-11-06	72	72	1002	1002	2026-11-12 21:11:34.014843+00	1016	2026-11-06 19:28:00+00	\N
1060	341	UPDATE	Scheduled	Completed	2026-11-06	2026-11-06	72	72	1002	1002	2026-11-12 21:11:34.014843+00	1016	2026-11-06 19:28:00+00	2026-11-06 20:15:00+00
1061	347	UPDATE	No Show	Scheduled	2026-11-06	2026-11-06	72	72	1004	1004	2026-11-12 21:11:34.014843+00	1014	2026-11-06 19:16:00+00	\N
1062	347	UPDATE	Scheduled	Completed	2026-11-06	2026-11-06	72	72	1004	1004	2026-11-12 21:11:34.014843+00	1014	2026-11-06 19:16:00+00	2026-11-06 20:01:00+00
1063	343	UPDATE	No Show	Scheduled	2026-11-06	2026-11-06	53	53	1003	1003	2026-11-12 21:11:34.014843+00	1014	2026-11-06 19:54:00+00	\N
1064	343	UPDATE	Scheduled	Completed	2026-11-06	2026-11-06	53	53	1003	1003	2026-11-12 21:11:34.014843+00	1014	2026-11-06 19:54:00+00	2026-11-06 20:37:00+00
1065	548	UPDATE	No Show	Scheduled	2026-11-06	2026-11-06	51	51	1002	1002	2026-11-12 21:11:34.014843+00	1030	2026-11-06 21:47:00+00	\N
1066	548	UPDATE	Scheduled	Completed	2026-11-06	2026-11-06	51	51	1002	1002	2026-11-12 21:11:34.014843+00	1030	2026-11-06 21:47:00+00	2026-11-06 22:33:00+00
1067	356	UPDATE	No Show	Scheduled	2026-11-09	2026-11-09	59	59	1004	1004	2026-11-12 21:11:34.014843+00	1015	2026-11-09 14:19:00+00	\N
1068	356	UPDATE	Scheduled	Completed	2026-11-09	2026-11-09	59	59	1004	1004	2026-11-12 21:11:34.014843+00	1015	2026-11-09 14:19:00+00	2026-11-09 15:00:00+00
1069	354	UPDATE	No Show	Scheduled	2026-11-09	2026-11-09	55	55	1022	1022	2026-11-12 21:11:34.014843+00	1029	2026-11-09 15:19:00+00	\N
1070	354	UPDATE	Scheduled	Completed	2026-11-09	2026-11-09	55	55	1022	1022	2026-11-12 21:11:34.014843+00	1029	2026-11-09 15:19:00+00	2026-11-09 16:10:00+00
1071	359	UPDATE	No Show	Scheduled	2026-11-09	2026-11-09	55	55	1008	1008	2026-11-12 21:11:34.014843+00	1015	2026-11-09 15:16:00+00	\N
1072	359	UPDATE	Scheduled	Completed	2026-11-09	2026-11-09	55	55	1008	1008	2026-11-12 21:11:34.014843+00	1015	2026-11-09 15:16:00+00	2026-11-09 16:05:00+00
1073	351	UPDATE	No Show	Scheduled	2026-11-09	2026-11-09	57	57	1002	1002	2026-11-12 21:11:34.014843+00	1016	2026-11-09 15:50:00+00	\N
1074	351	UPDATE	Scheduled	Completed	2026-11-09	2026-11-09	57	57	1002	1002	2026-11-12 21:11:34.014843+00	1016	2026-11-09 15:50:00+00	2026-11-09 16:45:00+00
1075	358	UPDATE	No Show	Scheduled	2026-11-09	2026-11-09	57	57	1007	1007	2026-11-12 21:11:34.014843+00	1029	2026-11-09 15:46:00+00	\N
1076	358	UPDATE	Scheduled	Completed	2026-11-09	2026-11-09	57	57	1007	1007	2026-11-12 21:11:34.014843+00	1029	2026-11-09 15:46:00+00	2026-11-09 16:25:00+00
1077	353	UPDATE	No Show	Scheduled	2026-11-09	2026-11-09	72	72	1021	1021	2026-11-12 21:11:34.014843+00	1016	2026-11-09 19:29:00+00	\N
1078	353	UPDATE	Scheduled	Completed	2026-11-09	2026-11-09	72	72	1021	1021	2026-11-12 21:11:34.014843+00	1016	2026-11-09 19:29:00+00	2026-11-09 20:08:00+00
1079	349	UPDATE	No Show	Scheduled	2026-11-09	2026-11-09	53	53	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-11-09 19:57:00+00	\N
1080	349	UPDATE	Scheduled	Completed	2026-11-09	2026-11-09	53	53	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-11-09 19:57:00+00	2026-11-09 20:43:00+00
1081	550	UPDATE	No Show	Scheduled	2026-11-09	2026-11-09	61	61	1021	1021	2026-11-12 21:11:34.014843+00	1016	2026-11-09 20:30:00+00	\N
1082	550	UPDATE	Scheduled	Completed	2026-11-09	2026-11-09	61	61	1021	1021	2026-11-12 21:11:34.014843+00	1016	2026-11-09 20:30:00+00	2026-11-09 21:18:00+00
1083	549	UPDATE	No Show	Scheduled	2026-11-09	2026-11-09	63	63	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-09 20:56:00+00	\N
1084	549	UPDATE	Scheduled	Completed	2026-11-09	2026-11-09	63	63	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-09 20:56:00+00	2026-11-09 21:41:00+00
1085	352	UPDATE	No Show	Scheduled	2026-11-09	2026-11-09	76	76	1003	1003	2026-11-12 21:11:34.014843+00	1028	2026-11-09 22:15:00+00	\N
1086	352	UPDATE	Scheduled	Completed	2026-11-09	2026-11-09	76	76	1003	1003	2026-11-12 21:11:34.014843+00	1028	2026-11-09 22:15:00+00	2026-11-09 22:59:00+00
1087	357	UPDATE	No Show	Scheduled	2026-11-09	2026-11-09	76	76	1006	1006	2026-11-12 21:11:34.014843+00	1015	2026-11-09 22:27:00+00	\N
1088	357	UPDATE	Scheduled	Completed	2026-11-09	2026-11-09	76	76	1006	1006	2026-11-12 21:11:34.014843+00	1015	2026-11-09 22:27:00+00	2026-11-09 23:27:00+00
1089	363	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	59	59	1002	1002	2026-11-12 21:11:34.014843+00	1015	2026-11-10 14:20:00+00	\N
1090	363	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	59	59	1002	1002	2026-11-12 21:11:34.014843+00	1015	2026-11-10 14:20:00+00	2026-11-10 15:02:00+00
1091	364	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	64	64	1003	1003	2026-11-12 21:11:34.014843+00	1014	2026-11-10 14:59:00+00	\N
1092	364	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	64	64	1003	1003	2026-11-12 21:11:34.014843+00	1014	2026-11-10 14:59:00+00	2026-11-10 15:40:00+00
1093	368	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	79	79	1022	1022	2026-11-12 21:11:34.014843+00	1030	2026-11-10 14:52:00+00	\N
1094	368	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	79	79	1022	1022	2026-11-12 21:11:34.014843+00	1030	2026-11-10 14:52:00+00	2026-11-10 15:39:00+00
1095	369	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	64	64	1004	1004	2026-11-12 21:11:34.014843+00	1014	2026-11-10 14:45:00+00	\N
1096	369	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	64	64	1004	1004	2026-11-12 21:11:34.014843+00	1014	2026-11-10 14:45:00+00	2026-11-10 15:44:00+00
1097	93	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	55	55	1003	1003	2026-11-12 21:11:34.014843+00	1015	2026-11-10 15:23:00+00	\N
1098	93	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	55	55	1003	1003	2026-11-12 21:11:34.014843+00	1015	2026-11-10 15:23:00+00	2026-11-10 16:10:00+00
1099	370	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	55	55	1005	1005	2026-11-12 21:11:34.014843+00	1030	2026-11-10 15:18:00+00	\N
1100	370	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	55	55	1005	1005	2026-11-12 21:11:34.014843+00	1030	2026-11-10 15:18:00+00	2026-11-10 16:15:00+00
1101	367	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	73	73	1022	1022	2026-11-12 21:11:34.014843+00	1029	2026-11-10 15:47:00+00	\N
1102	367	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	73	73	1022	1022	2026-11-12 21:11:34.014843+00	1029	2026-11-10 15:47:00+00	2026-11-10 16:23:00+00
1103	366	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	54	54	1022	1022	2026-11-12 21:11:34.014843+00	1030	2026-11-10 16:27:00+00	\N
1104	366	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	54	54	1022	1022	2026-11-12 21:11:34.014843+00	1030	2026-11-10 16:27:00+00	2026-11-10 17:19:00+00
1105	362	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	49	49	1002	1002	2026-11-12 21:11:34.014843+00	1015	2026-11-10 16:51:00+00	\N
1106	362	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	49	49	1002	1002	2026-11-12 21:11:34.014843+00	1015	2026-11-10 16:51:00+00	2026-11-10 17:30:00+00
1107	551	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	70	70	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-10 17:16:00+00	\N
1108	551	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	70	70	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-10 17:16:00+00	2026-11-10 18:03:00+00
1109	94	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	50	50	1007	1007	2026-11-12 21:11:34.014843+00	1029	2026-11-10 18:59:00+00	\N
1110	94	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	50	50	1007	1007	2026-11-12 21:11:34.014843+00	1029	2026-11-10 18:59:00+00	2026-11-10 19:45:00+00
1111	361	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	50	50	1002	1002	2026-11-12 21:11:34.014843+00	1014	2026-11-10 18:57:00+00	\N
1112	361	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	50	50	1002	1002	2026-11-12 21:11:34.014843+00	1014	2026-11-10 18:57:00+00	2026-11-10 19:54:00+00
1113	553	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	50	50	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-10 18:53:00+00	\N
1114	553	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	50	50	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-10 18:53:00+00	2026-11-10 19:41:00+00
1115	552	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	72	72	1002	1002	2026-11-12 21:11:34.014843+00	1028	2026-11-10 19:21:00+00	\N
1116	552	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	72	72	1002	1002	2026-11-12 21:11:34.014843+00	1028	2026-11-10 19:21:00+00	2026-11-10 20:05:00+00
1117	556	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	63	63	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-10 20:55:00+00	\N
1118	556	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	63	63	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-10 20:55:00+00	2026-11-10 21:54:00+00
1119	371	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	51	51	1023	1023	2026-11-12 21:11:34.014843+00	1028	2026-11-10 21:48:00+00	\N
1120	371	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	51	51	1023	1023	2026-11-12 21:11:34.014843+00	1028	2026-11-10 21:48:00+00	2026-11-10 22:30:00+00
1121	360	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	76	76	1001	1001	2026-11-12 21:11:34.014843+00	1028	2026-11-10 22:27:00+00	\N
1122	360	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	76	76	1001	1001	2026-11-12 21:11:34.014843+00	1028	2026-11-10 22:27:00+00	2026-11-10 23:16:00+00
1123	365	UPDATE	No Show	Scheduled	2026-11-10	2026-11-10	76	76	1021	1021	2026-11-12 21:11:34.014843+00	1016	2026-11-10 22:20:00+00	\N
1124	365	UPDATE	Scheduled	Completed	2026-11-10	2026-11-10	76	76	1021	1021	2026-11-12 21:11:34.014843+00	1016	2026-11-10 22:20:00+00	2026-11-10 23:08:00+00
1125	375	UPDATE	No Show	Scheduled	2026-11-11	2026-11-11	78	78	1003	1003	2026-11-12 21:11:34.014843+00	1028	2026-11-11 13:51:00+00	\N
1126	375	UPDATE	Scheduled	Completed	2026-11-11	2026-11-11	78	78	1003	1003	2026-11-12 21:11:34.014843+00	1028	2026-11-11 13:51:00+00	2026-11-11 14:29:00+00
1127	558	UPDATE	No Show	Scheduled	2026-11-11	2026-11-11	59	59	1003	1003	2026-11-12 21:11:34.014843+00	1014	2026-11-11 14:22:00+00	\N
1128	558	UPDATE	Scheduled	Completed	2026-11-11	2026-11-11	59	59	1003	1003	2026-11-12 21:11:34.014843+00	1014	2026-11-11 14:22:00+00	2026-11-11 14:56:00+00
1129	377	UPDATE	No Show	Scheduled	2026-11-11	2026-11-11	49	49	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-11 16:45:00+00	\N
1130	377	UPDATE	Scheduled	Completed	2026-11-11	2026-11-11	49	49	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-11 16:45:00+00	2026-11-11 17:25:00+00
1131	379	UPDATE	No Show	Scheduled	2026-11-11	2026-11-11	49	49	1005	1005	2026-11-12 21:11:34.014843+00	1029	2026-11-11 16:53:00+00	\N
1132	379	UPDATE	Scheduled	Completed	2026-11-11	2026-11-11	49	49	1005	1005	2026-11-12 21:11:34.014843+00	1029	2026-11-11 16:53:00+00	2026-11-11 17:27:00+00
1133	378	UPDATE	No Show	Scheduled	2026-11-11	2026-11-11	70	70	1022	1022	2026-11-12 21:11:34.014843+00	1016	2026-11-11 17:19:00+00	\N
1134	378	UPDATE	Scheduled	Completed	2026-11-11	2026-11-11	70	70	1022	1022	2026-11-12 21:11:34.014843+00	1016	2026-11-11 17:19:00+00	2026-11-11 18:03:00+00
1135	380	UPDATE	No Show	Scheduled	2026-11-11	2026-11-11	50	50	1007	1007	2026-11-12 21:11:34.014843+00	1030	2026-11-11 18:47:00+00	\N
1136	380	UPDATE	Scheduled	Completed	2026-11-11	2026-11-11	50	50	1007	1007	2026-11-12 21:11:34.014843+00	1030	2026-11-11 18:47:00+00	2026-11-11 19:35:00+00
1137	575	UPDATE	No Show	Scheduled	2026-11-11	2026-11-11	72	72	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-11 19:30:00+00	\N
1138	575	UPDATE	Scheduled	Completed	2026-11-11	2026-11-11	72	72	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-11 19:30:00+00	2026-11-11 20:26:00+00
1139	376	UPDATE	No Show	Scheduled	2026-11-11	2026-11-11	61	61	1021	1021	2026-11-12 21:11:34.014843+00	1016	2026-11-11 20:18:00+00	\N
1140	376	UPDATE	Scheduled	Completed	2026-11-11	2026-11-11	61	61	1021	1021	2026-11-12 21:11:34.014843+00	1016	2026-11-11 20:18:00+00	2026-11-11 21:13:00+00
1141	373	UPDATE	No Show	Scheduled	2026-11-11	2026-11-11	63	63	1002	1002	2026-11-12 21:11:34.014843+00	1029	2026-11-11 20:58:00+00	\N
1142	373	UPDATE	Scheduled	Completed	2026-11-11	2026-11-11	63	63	1002	1002	2026-11-12 21:11:34.014843+00	1029	2026-11-11 20:58:00+00	2026-11-11 21:43:00+00
1143	559	UPDATE	No Show	Scheduled	2026-11-11	2026-11-11	51	51	1021	1021	2026-11-12 21:11:34.014843+00	1029	2026-11-11 21:57:00+00	\N
1144	559	UPDATE	Scheduled	Completed	2026-11-11	2026-11-11	51	51	1021	1021	2026-11-12 21:11:34.014843+00	1029	2026-11-11 21:57:00+00	2026-11-11 22:42:00+00
1145	394	UPDATE	No Show	Scheduled	2026-11-12	2026-11-12	78	78	1007	1007	2026-11-12 21:11:34.014843+00	1029	2026-11-12 13:52:00+00	\N
1146	394	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	78	78	1007	1007	2026-11-12 21:11:34.014843+00	1029	2026-11-12 13:52:00+00	2026-11-12 14:39:00+00
1147	576	UPDATE	No Show	Scheduled	2026-11-12	2026-11-12	78	78	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-12 13:45:00+00	\N
1148	576	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	78	78	1021	1021	2026-11-12 21:11:34.014843+00	1030	2026-11-12 13:45:00+00	2026-11-12 14:32:00+00
1149	577	UPDATE	No Show	Scheduled	2026-11-12	2026-11-12	59	59	1002	1002	2026-11-12 21:11:34.014843+00	1029	2026-11-12 14:16:00+00	\N
1150	577	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	59	59	1002	1002	2026-11-12 21:11:34.014843+00	1029	2026-11-12 14:16:00+00	2026-11-12 15:01:00+00
1151	387	UPDATE	No Show	Scheduled	2026-11-12	2026-11-12	64	64	1003	1003	2026-11-12 21:11:34.014843+00	1014	2026-11-12 14:52:00+00	\N
1152	387	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	64	64	1003	1003	2026-11-12 21:11:34.014843+00	1014	2026-11-12 14:52:00+00	2026-11-12 15:33:00+00
1153	584	UPDATE	No Show	Scheduled	2026-11-12	2026-11-12	64	64	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-11-12 14:49:00+00	\N
1154	584	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	64	64	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-11-12 14:49:00+00	2026-11-12 15:26:00+00
1155	390	UPDATE	No Show	Scheduled	2026-11-12	2026-11-12	71	71	1022	1022	2026-11-12 21:11:34.014843+00	1030	2026-11-12 15:19:00+00	\N
1156	390	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	71	71	1022	1022	2026-11-12 21:11:34.014843+00	1030	2026-11-12 15:19:00+00	2026-11-12 15:55:00+00
1157	392	UPDATE	No Show	Scheduled	2026-11-12	2026-11-12	57	57	1005	1005	2026-11-12 21:11:34.014843+00	1030	2026-11-12 15:56:00+00	\N
1158	392	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	57	57	1005	1005	2026-11-12 21:11:34.014843+00	1030	2026-11-12 15:56:00+00	2026-11-12 16:56:00+00
1159	396	UPDATE	No Show	Scheduled	2026-11-12	2026-11-12	57	57	1023	1023	2026-11-12 21:11:34.014843+00	1028	2026-11-12 15:51:00+00	\N
1160	396	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	57	57	1023	1023	2026-11-12 21:11:34.014843+00	1028	2026-11-12 15:51:00+00	2026-11-12 16:39:00+00
1161	388	UPDATE	No Show	Scheduled	2026-11-12	2026-11-12	69	69	1003	1003	2026-11-12 21:11:34.014843+00	1028	2026-11-12 16:21:00+00	\N
1162	388	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	69	69	1003	1003	2026-11-12 21:11:34.014843+00	1028	2026-11-12 16:21:00+00	2026-11-12 17:00:00+00
1163	391	UPDATE	No Show	Scheduled	2026-11-12	2026-11-12	49	49	1004	1004	2026-11-12 21:11:34.014843+00	1015	2026-11-12 16:55:00+00	\N
1164	391	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	49	49	1004	1004	2026-11-12 21:11:34.014843+00	1015	2026-11-12 16:55:00+00	2026-11-12 17:42:00+00
1165	381	UPDATE	No Show	Scheduled	2026-11-12	2026-11-12	53	53	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-11-12 19:46:00+00	\N
1166	381	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	53	53	1001	1001	2026-11-12 21:11:34.014843+00	1014	2026-11-12 19:46:00+00	2026-11-12 20:26:00+00
1167	393	UPDATE	No Show	Scheduled	2026-11-12	2026-11-12	61	61	1006	1006	2026-11-12 21:11:34.014843+00	1015	2026-11-12 20:21:00+00	\N
1168	393	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	61	61	1006	1006	2026-11-12 21:11:34.014843+00	1015	2026-11-12 20:21:00+00	2026-11-12 21:04:00+00
1169	597	INSERT	\N	Scheduled	\N	2026-11-17	\N	55	\N	1001	2026-11-12 21:14:40.259709+00	\N	\N	\N
1170	597	UPDATE	Scheduled	Cancelled	2026-11-17	2026-11-17	55	55	1001	1001	2026-11-12 21:15:19.151967+00	\N	\N	\N
1171	598	INSERT	\N	Scheduled	\N	2026-11-17	\N	53	\N	1002	2026-11-12 21:27:15.332958+00	\N	\N	\N
1172	598	UPDATE	Scheduled	Cancelled	2026-11-17	2026-11-17	53	53	1002	1002	2026-11-12 21:28:13.465356+00	\N	\N	\N
1173	590	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	63	63	1001	1001	2026-11-12 21:31:23.105604+00	\N	\N	\N
1174	599	INSERT	\N	Scheduled	\N	2026-11-17	\N	55	\N	1001	2026-11-12 21:36:57.485942+00	\N	\N	\N
1175	599	UPDATE	Scheduled	Cancelled	2026-11-17	2026-11-17	55	55	1001	1001	2026-11-12 21:37:36.02572+00	\N	\N	\N
1176	600	INSERT	\N	Scheduled	\N	2026-11-17	\N	72	\N	1001	2026-11-12 21:55:04.664749+00	\N	\N	\N
1177	600	UPDATE	Scheduled	Cancelled	2026-11-17	2026-11-17	72	72	1001	1001	2026-11-12 21:55:23.29334+00	\N	\N	\N
1178	386	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	62	62	1003	1003	2026-11-12 22:01:17.381328+00	\N	\N	\N
1179	591	UPDATE	Scheduled	No Show	2026-11-12	2026-11-12	62	62	1001	1001	2026-11-12 22:01:17.381328+00	\N	\N	\N
1180	593	UPDATE	Scheduled	Scheduled	2026-11-12	2026-11-12	76	76	1001	1001	2026-11-12 22:01:57.576726+00	1014	2026-11-12 22:01:57.576726+00	\N
1181	592	UPDATE	Scheduled	Scheduled	2026-11-12	2026-11-12	51	51	1001	1001	2026-11-12 22:01:58.686106+00	1014	2026-11-12 22:01:58.686106+00	\N
1182	601	INSERT	\N	Scheduled	\N	2026-11-18	\N	62	\N	1021	2026-11-12 22:10:01.052242+00	\N	\N	\N
1183	602	INSERT	\N	Scheduled	\N	2026-11-17	\N	64	\N	1001	2026-11-12 22:10:56.185489+00	\N	\N	\N
1184	602	UPDATE	Scheduled	Cancelled	2026-11-17	2026-11-17	64	64	1001	1001	2026-11-12 22:11:17.98687+00	\N	\N	\N
1185	603	INSERT	\N	Scheduled	\N	2026-11-12	\N	76	\N	1007	2026-11-12 22:24:23.312678+00	\N	\N	\N
1186	603	UPDATE	Scheduled	Scheduled	2026-11-12	2026-11-12	76	76	1007	1007	2026-11-12 22:24:39.086393+00	1016	2026-11-12 22:24:39.086393+00	\N
1187	603	UPDATE	Scheduled	Completed	2026-11-12	2026-11-12	76	76	1007	1007	2026-11-12 22:24:45.118966+00	1016	2026-11-12 22:24:39.086393+00	2026-11-12 22:24:45.118966+00
1188	604	INSERT	\N	Scheduled	\N	2026-11-23	\N	59	\N	1002	2026-11-13 00:28:43.948032+00	\N	\N	\N
1189	605	INSERT	\N	Scheduled	\N	2026-11-23	\N	50	\N	1002	2026-11-13 00:29:27.385093+00	\N	\N	\N
1190	605	UPDATE	Scheduled	Cancelled	2026-11-23	2026-11-23	50	50	1002	1002	2026-11-13 00:29:41.140709+00	\N	\N	\N
1191	606	INSERT	\N	Scheduled	\N	2026-11-25	\N	51	\N	1002	2026-11-13 00:37:16.555337+00	\N	\N	\N
1192	397	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	64	64	1001	1001	2026-11-13 19:00:51.251944+00	\N	\N	\N
1193	399	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	78	78	1001	1001	2026-11-13 19:00:51.251944+00	\N	\N	\N
1194	400	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	59	59	1002	1002	2026-11-13 19:00:51.251944+00	\N	\N	\N
1195	401	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	70	70	1002	1002	2026-11-13 19:00:51.251944+00	\N	\N	\N
1196	402	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	64	64	1002	1002	2026-11-13 19:00:51.251944+00	\N	\N	\N
1197	404	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	69	69	1003	1003	2026-11-13 19:00:51.251944+00	\N	\N	\N
1198	406	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	70	70	1021	1021	2026-11-13 19:00:51.251944+00	\N	\N	\N
1199	407	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	69	69	1022	1022	2026-11-13 19:00:51.251944+00	\N	\N	\N
1200	408	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	57	57	1005	1005	2026-11-13 19:00:51.251944+00	\N	\N	\N
1201	409	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	78	78	1007	1007	2026-11-13 19:00:51.251944+00	\N	\N	\N
1202	410	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	57	57	1008	1008	2026-11-13 19:00:51.251944+00	\N	\N	\N
1203	564	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	59	59	1004	1004	2026-11-13 19:00:51.251944+00	\N	\N	\N
1204	565	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	49	49	1001	1001	2026-11-13 19:00:51.251944+00	\N	\N	\N
1205	398	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	62	62	1001	1001	2026-11-15 04:49:58.9859+00	\N	\N	\N
1206	403	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	50	50	1003	1003	2026-11-15 04:49:58.9859+00	\N	\N	\N
1207	405	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	63	63	1003	1003	2026-11-15 04:49:58.9859+00	\N	\N	\N
1208	411	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	76	76	1024	1024	2026-11-15 04:49:58.9859+00	\N	\N	\N
1209	563	UPDATE	Scheduled	No Show	2026-11-13	2026-11-13	76	76	1001	1001	2026-11-15 04:49:58.9859+00	\N	\N	\N
\.


--
-- Data for Name: appointment_summary; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.appointment_summary (appointment_summary_id, appointment_id, visit_reason, notes, recorded_by_employee_id, recorded_date) FROM stdin;
194	1	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-02-11
195	3	Knee pain	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1006	2026-04-09
196	4	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-04-16
197	6	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-04-24
198	7	Diabetes management	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1008	2026-04-27
199	8	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-05-01
200	9	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-05-07
201	10	Skin rash evaluation	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1005	2026-05-08
202	11	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-05-11
203	13	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-05-22
204	14	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-05-22
205	15	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-05-26
206	16	Chronic condition follow-up	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1003	2026-05-29
207	17	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-05-29
208	18	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-06-03
209	20	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-06-11
210	21	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-06-12
211	23	Chronic condition follow-up	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1003	2026-06-15
212	24	Chronic condition follow-up	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1003	2026-06-17
213	25	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-07-06
214	26	Knee pain	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1006	2026-07-08
215	29	Knee pain	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1006	2026-07-16
216	30	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-07-21
217	31	Recurring headaches	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1007	2026-07-22
218	32	Chronic condition follow-up	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1003	2026-07-29
219	33	Hypertension evaluation	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1004	2026-08-04
220	34	Skin rash evaluation	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1005	2026-08-04
221	35	Chronic condition follow-up	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1003	2026-08-04
222	37	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-08-10
223	38	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-08-17
224	39	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-08-25
225	40	Recurring headaches	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1007	2026-08-28
226	41	Knee pain	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1006	2026-08-28
227	42	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-09-01
228	43	Skin rash evaluation	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1005	2026-09-01
229	44	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-09-01
230	46	Skin rash evaluation	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1005	2026-09-03
231	47	Skin rash evaluation	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1005	2026-09-03
232	48	Recurring headaches	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1007	2026-09-07
233	49	Diabetes management	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1008	2026-09-08
234	53	Diabetes management	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1008	2026-09-11
235	54	Diabetes management	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1008	2026-09-11
236	55	Chronic condition follow-up	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1003	2026-09-17
237	56	Skin rash evaluation	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1005	2026-09-17
238	57	Chronic condition follow-up	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1003	2026-09-18
239	58	Chronic condition follow-up	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1003	2026-09-22
240	61	Diabetes management	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1008	2026-09-25
241	62	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-09-25
242	63	Hypertension evaluation	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1004	2026-09-28
243	66	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-09-30
244	67	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-10-01
245	68	Skin rash evaluation	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1005	2026-10-01
246	69	Chronic condition follow-up	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1003	2026-10-02
247	71	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-10-05
248	72	Knee pain	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1006	2026-10-06
249	73	Recurring headaches	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1007	2026-10-07
250	75	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-10-13
251	77	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-10-14
252	78	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-10-16
253	79	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-10-19
254	81	Chronic condition follow-up	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1003	2026-10-19
255	82	Knee pain	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1006	2026-10-20
256	83	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-10-21
257	84	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1001	2026-10-21
261	123	Cough	Dry cough for 5 days.	1001	2026-10-15
262	124	Sore throat	Red throat, no fever.	1001	2026-10-15
263	125	Back pain	Lifted something heavy.	1001	2026-10-15
264	130	Stomach pain	Heartburn after meals.	1021	2026-10-15
265	131	Diabetes follow-up	Sugar a bit high this month.	1021	2026-10-15
266	132	Flu shot and checkup	Flu shot given.	1022	2026-10-15
267	133	Flu shot and checkup	Flu shot given.	1022	2026-10-15
268	134	Sore throat	Red throat, no fever.	1022	2026-10-15
269	135	Heart check	Mild palpitations.	1004	2026-10-15
270	136	Skin rash	Itchy rash on arm.	1005	2026-10-15
271	137	Knee pain	Pain when running.	1006	2026-10-15
272	139	Sore throat	Red throat, no fever.	1001	2026-10-16
273	140	Cough	Dry cough for 5 days.	1001	2026-10-16
274	141	Headache	Headaches after long screen time.	1001	2026-10-16
275	142	Flu shot and checkup	Flu shot given.	1002	2026-10-16
276	143	Cholesterol follow-up	Diet improved.	1003	2026-10-16
277	144	Diabetes follow-up	Sugar a bit high this month.	1003	2026-10-16
278	145	Cholesterol follow-up	Diet improved.	1003	2026-10-16
279	147	Fatigue	Tired for a few weeks.	1021	2026-10-16
280	148	Stomach pain	Heartburn after meals.	1021	2026-10-16
281	149	Back pain	Lifted something heavy.	1022	2026-10-16
282	150	Skin rash	Itchy rash on arm.	1005	2026-10-16
283	152	Headaches	Frequent headaches.	1007	2026-10-16
284	155	Flu shot and checkup	Flu shot given.	1002	2026-10-19
285	157	Flu shot and checkup	Flu shot given.	1002	2026-10-19
286	158	Diabetes follow-up	Sugar a bit high this month.	1003	2026-10-19
287	159	Blood pressure check	BP a little high.	1021	2026-10-19
288	162	Cough	Dry cough for 5 days.	1022	2026-10-19
289	163	Flu shot and checkup	Flu shot given.	1022	2026-10-19
290	164	Skin rash	Itchy rash on arm.	1005	2026-10-19
291	165	Wrist pain	Swollen wrist.	1006	2026-10-19
292	166	Dizziness	Dizzy when standing.	1007	2026-10-19
293	167	Blood sugar check	Sugar higher than last time.	1008	2026-10-19
294	168	Flu shot and checkup	Flu shot given.	1001	2026-10-20
295	170	Back pain	Lifted something heavy.	1002	2026-10-20
296	171	Sore throat	Red throat, no fever.	1002	2026-10-20
297	172	Headache	Headaches after long screen time.	1002	2026-10-20
298	173	Stomach pain	Heartburn after meals.	1003	2026-10-20
299	174	Stomach pain	Heartburn after meals.	1021	2026-10-20
300	175	Cough	Dry cough for 5 days.	1022	2026-10-20
301	176	Back pain	Lifted something heavy.	1022	2026-10-20
302	181	Heart check	Mild palpitations.	1024	2026-10-20
303	182	Annual checkup	Healthy overall. Keep exercising.	1001	2026-10-21
304	185	Flu shot and checkup	Flu shot given.	1002	2026-10-21
305	187	Cough	Dry cough for 5 days.	1002	2026-10-21
306	189	Fatigue	Tired for a few weeks.	1003	2026-10-21
307	191	Blood pressure check	BP a little high.	1021	2026-10-21
308	193	Stomach pain	Heartburn after meals.	1021	2026-10-21
309	194	Flu shot and checkup	Flu shot given.	1022	2026-10-21
310	195	Cough	Dry cough for 5 days.	1022	2026-10-21
311	196	Wrist pain	Swollen wrist.	1006	2026-10-21
312	197	Dizziness	Dizzy when standing.	1007	2026-10-21
313	198	Blood sugar check	Sugar higher than last time.	1008	2026-10-21
314	199	Dizziness	Dizzy when standing.	1023	2026-10-21
315	201	Annual checkup	Healthy overall. Keep exercising.	1002	2026-10-22
316	202	Back pain	Lifted something heavy.	1002	2026-10-22
317	203	Headache	Headaches after long screen time.	1002	2026-10-22
318	204	Diabetes follow-up	Sugar a bit high this month.	1003	2026-10-22
319	205	Diabetes follow-up	Sugar a bit high this month.	1003	2026-10-22
320	206	Fatigue	Tired for a few weeks.	1003	2026-10-22
321	207	Blood pressure check	BP a little high.	1021	2026-10-22
322	208	Back pain	Lifted something heavy.	1022	2026-10-22
323	209	Skin rash	Itchy rash on arm.	1005	2026-10-22
324	210	Knee pain	Pain when running.	1006	2026-10-22
325	211	Heart check	Mild palpitations.	1024	2026-10-22
326	213	Sore throat	Red throat, no fever.	1002	2026-10-23
327	215	Stomach pain	Heartburn after meals.	1003	2026-10-23
328	216	Cholesterol follow-up	Diet improved.	1021	2026-10-23
329	217	Fatigue	Tired for a few weeks.	1021	2026-10-23
330	219	Skin rash	Itchy rash on arm.	1005	2026-10-23
331	220	Wrist pain	Swollen wrist.	1006	2026-10-23
332	223	Flu shot and checkup	Flu shot given.	1002	2026-10-26
333	224	Fatigue	Tired for a few weeks.	1003	2026-10-26
334	225	Cholesterol follow-up	Diet improved.	1003	2026-10-26
335	226	Stomach pain	Heartburn after meals.	1021	2026-10-26
336	227	Diabetes follow-up	Sugar a bit high this month.	1021	2026-10-26
337	228	Headache	Headaches after long screen time.	1022	2026-10-26
338	229	Chest pain	ECG normal.	1004	2026-10-26
339	230	Mole check	Mole looks normal.	1005	2026-10-26
340	231	Wrist pain	Swollen wrist.	1006	2026-10-26
341	232	Headaches	Frequent headaches.	1007	2026-10-26
342	233	Blood sugar check	Sugar higher than last time.	1008	2026-10-26
343	234	Headaches	Frequent headaches.	1023	2026-10-26
344	235	Annual checkup	Healthy overall. Keep exercising.	1001	2026-10-27
345	236	Flu shot and checkup	Flu shot given.	1002	2026-10-27
346	238	Flu shot and checkup	Flu shot given.	1002	2026-10-27
347	239	Stomach pain	Heartburn after meals.	1003	2026-10-27
348	240	Stomach pain	Heartburn after meals.	1021	2026-10-27
349	241	Stomach pain	Heartburn after meals.	1021	2026-10-27
350	242	Blood pressure check	BP a little high.	1021	2026-10-27
351	243	Annual checkup	Healthy overall. Keep exercising.	1022	2026-10-27
352	244	Cough	Dry cough for 5 days.	1022	2026-10-27
353	245	Heart check	Mild palpitations.	1004	2026-10-27
354	246	Mole check	Mole looks normal.	1005	2026-10-27
355	247	Knee pain	Pain when running.	1006	2026-10-27
356	248	Headaches	Frequent headaches.	1007	2026-10-27
357	249	Heart check	Mild palpitations.	1024	2026-10-27
358	250	Headache	Headaches after long screen time.	1001	2026-10-28
359	251	Sore throat	Red throat, no fever.	1001	2026-10-28
360	252	Headache	Headaches after long screen time.	1001	2026-10-28
361	253	Sore throat	Red throat, no fever.	1002	2026-10-28
362	254	Sore throat	Red throat, no fever.	1002	2026-10-28
363	255	Cholesterol follow-up	Diet improved.	1003	2026-10-28
364	256	Diabetes follow-up	Sugar a bit high this month.	1003	2026-10-28
365	257	Stomach pain	Heartburn after meals.	1003	2026-10-28
366	258	Fatigue	Tired for a few weeks.	1021	2026-10-28
367	259	Sore throat	Red throat, no fever.	1022	2026-10-28
368	260	Annual checkup	Healthy overall. Keep exercising.	1022	2026-10-28
369	261	Heart check	Mild palpitations.	1004	2026-10-28
370	263	Wrist pain	Swollen wrist.	1006	2026-10-28
371	264	Headaches	Frequent headaches.	1007	2026-10-28
372	265	Dizziness	Dizzy when standing.	1023	2026-10-28
373	266	Flu shot and checkup	Flu shot given.	1001	2026-10-29
374	267	Headache	Headaches after long screen time.	1001	2026-10-29
375	269	Cough	Dry cough for 5 days.	1002	2026-10-29
376	270	Cough	Dry cough for 5 days.	1002	2026-10-29
377	271	Stomach pain	Heartburn after meals.	1003	2026-10-29
378	272	Stomach pain	Heartburn after meals.	1003	2026-10-29
379	273	Blood pressure check	BP a little high.	1003	2026-10-29
380	274	Diabetes follow-up	Sugar a bit high this month.	1021	2026-10-29
381	275	Cough	Dry cough for 5 days.	1022	2026-10-29
382	276	Annual checkup	Healthy overall. Keep exercising.	1022	2026-10-29
383	278	Skin rash	Itchy rash on arm.	1005	2026-10-29
384	279	Wrist pain	Swollen wrist.	1006	2026-10-29
385	280	Sore throat	Red throat, no fever.	1001	2026-10-30
386	281	Back pain	Lifted something heavy.	1002	2026-10-30
387	282	Cough	Dry cough for 5 days.	1002	2026-10-30
388	283	Flu shot and checkup	Flu shot given.	1002	2026-10-30
389	284	Cholesterol follow-up	Diet improved.	1003	2026-10-30
390	286	Fatigue	Tired for a few weeks.	1021	2026-10-30
391	288	Knee pain	Pain when running.	1006	2026-10-30
392	289	Chest pain	ECG normal.	1024	2026-10-30
393	290	Headache	Headaches after long screen time.	1001	2026-11-02
394	292	Back pain	Lifted something heavy.	1001	2026-11-02
395	293	Cough	Dry cough for 5 days.	1002	2026-11-02
396	295	Headache	Headaches after long screen time.	1002	2026-11-02
397	296	Stomach pain	Heartburn after meals.	1003	2026-11-02
398	297	Fatigue	Tired for a few weeks.	1021	2026-11-02
399	299	Cholesterol follow-up	Diet improved.	1021	2026-11-02
400	300	Sore throat	Red throat, no fever.	1022	2026-11-02
401	301	Mole check	Mole looks normal.	1005	2026-11-02
402	302	Knee pain	Pain when running.	1006	2026-11-02
403	303	Headaches	Frequent headaches.	1007	2026-11-02
404	304	Thyroid follow-up	Thyroid level slightly off.	1008	2026-11-02
405	305	Dizziness	Dizzy when standing.	1023	2026-11-02
406	307	Sore throat	Red throat, no fever.	1002	2026-11-03
407	308	Annual checkup	Healthy overall. Keep exercising.	1002	2026-11-03
408	309	Cough	Dry cough for 5 days.	1002	2026-11-03
409	310	Fatigue	Tired for a few weeks.	1003	2026-11-03
410	311	Diabetes follow-up	Sugar a bit high this month.	1003	2026-11-03
411	312	Blood pressure check	BP a little high.	1003	2026-11-03
412	313	Stomach pain	Heartburn after meals.	1021	2026-11-03
413	314	Fatigue	Tired for a few weeks.	1021	2026-11-03
414	315	Annual checkup	Healthy overall. Keep exercising.	1022	2026-11-03
415	316	Headaches	Frequent headaches.	1023	2026-11-03
416	318	Headache	Headaches after long screen time.	1001	2026-11-04
417	319	Annual checkup	Healthy overall. Keep exercising.	1002	2026-11-04
418	320	Stomach pain	Heartburn after meals.	1003	2026-11-04
419	321	Fatigue	Tired for a few weeks.	1021	2026-11-04
420	322	Stomach pain	Heartburn after meals.	1021	2026-11-04
421	324	Cough	Dry cough for 5 days.	1022	2026-11-04
422	325	Headaches	Frequent headaches.	1007	2026-11-04
423	326	Blood sugar check	Sugar higher than last time.	1008	2026-11-04
424	327	Chest pain	ECG normal.	1024	2026-11-04
425	333	Fatigue	Tired for a few weeks.	1021	2026-11-05
426	334	Fatigue	Tired for a few weeks.	1021	2026-11-05
427	335	Sore throat	Red throat, no fever.	1022	2026-11-05
428	336	Skin rash	Itchy rash on arm.	1005	2026-11-05
429	338	Blood sugar check	Sugar higher than last time.	1008	2026-11-05
430	85	Headaches	Frequent headaches.	1007	2026-10-23
431	108	Headache	Headaches after long screen time.	1001	2026-10-26
432	87	Sore throat	Red throat, no fever.	1002	2026-10-26
433	111	Flu shot and checkup	Flu shot given.	1002	2026-10-28
434	112	Sore throat	Red throat, no fever.	1001	2026-10-28
435	113	Back pain	Lifted something heavy.	1001	2026-10-28
436	88	Headache	Headaches after long screen time.	1002	2026-10-28
437	110	Diabetes follow-up	Sugar a bit high this month.	1003	2026-10-29
438	90	Sore throat	Red throat, no fever.	1001	2026-10-29
439	115	Cough	Dry cough for 5 days.	1001	2026-10-30
440	117	Cholesterol follow-up	Diet improved.	1003	2026-10-30
441	331	Sore throat	Red throat, no fever.	1002	2026-11-05
442	330	Back pain	Lifted something heavy.	1001	2026-11-05
443	332	Stomach pain	Heartburn after meals.	1003	2026-11-05
444	329	Annual checkup	Healthy overall. Keep exercising.	1001	2026-11-05
445	328	Flu shot and checkup	Flu shot given.	1001	2026-11-05
446	337	Wrist pain	Swollen wrist.	1006	2026-11-05
447	340	Flu shot and checkup	Flu shot given.	1001	2026-11-06
448	342	Stomach pain	Heartburn after meals.	1003	2026-11-06
449	344	Cholesterol follow-up	Diet improved.	1021	2026-11-06
450	341	Routine checkup	Patient seen and examined. Plan discussed with patient. Follow up as needed.	1002	2026-11-06
451	347	Heart check	Mild palpitations.	1004	2026-11-06
452	343	Cholesterol follow-up	Diet improved.	1003	2026-11-06
453	548	Sore throat	Red throat, no fever.	1002	2026-11-06
454	356	Heart check	Mild palpitations.	1004	2026-11-09
455	354	Cough	Dry cough for 5 days.	1022	2026-11-09
456	359	Thyroid follow-up	Thyroid level slightly off.	1008	2026-11-09
457	351	Flu shot and checkup	Flu shot given.	1002	2026-11-09
458	358	Dizziness	Dizzy when standing.	1007	2026-11-09
459	353	Diabetes follow-up	Sugar a bit high this month.	1021	2026-11-09
460	349	Cough	Dry cough for 5 days.	1001	2026-11-09
461	550	Fatigue	Tired for a few weeks.	1021	2026-11-09
462	549	Diabetes follow-up	Sugar a bit high this month.	1021	2026-11-09
463	352	Diabetes follow-up	Sugar a bit high this month.	1003	2026-11-09
464	357	Wrist pain	Swollen wrist.	1006	2026-11-09
465	363	Annual checkup	Healthy overall. Keep exercising.	1002	2026-11-10
466	364	Fatigue	Tired for a few weeks.	1003	2026-11-10
467	368	Flu shot and checkup	Flu shot given.	1022	2026-11-10
468	369	Heart check	Mild palpitations.	1004	2026-11-10
469	93	Stomach pain	Heartburn after meals.	1003	2026-11-10
470	370	Skin rash	Itchy rash on arm.	1005	2026-11-10
471	367	Cough	Dry cough for 5 days.	1022	2026-11-10
472	366	Sore throat	Red throat, no fever.	1022	2026-11-10
473	362	Flu shot and checkup	Flu shot given.	1002	2026-11-10
474	551	Blood pressure check	BP a little high.	1021	2026-11-10
475	94	Headaches	Frequent headaches.	1007	2026-11-10
476	361	Annual checkup	Healthy overall. Keep exercising.	1002	2026-11-10
477	553	Cholesterol follow-up	Diet improved.	1021	2026-11-10
478	552	Headache	Headaches after long screen time.	1002	2026-11-10
479	556	Fatigue	Tired for a few weeks.	1021	2026-11-10
480	371	Headaches	Frequent headaches.	1023	2026-11-10
481	360	Cough	Dry cough for 5 days.	1001	2026-11-10
482	365	Stomach pain	Heartburn after meals.	1021	2026-11-10
483	375	Fatigue	Tired for a few weeks.	1003	2026-11-11
484	558	Stomach pain	Heartburn after meals.	1003	2026-11-11
485	377	Stomach pain	Heartburn after meals.	1021	2026-11-11
486	379	Skin rash	Itchy rash on arm.	1005	2026-11-11
487	378	Sore throat	Red throat, no fever.	1022	2026-11-11
488	380	Headaches	Frequent headaches.	1007	2026-11-11
489	575	Stomach pain	Heartburn after meals.	1021	2026-11-11
490	376	Stomach pain	Heartburn after meals.	1021	2026-11-11
491	373	Back pain	Lifted something heavy.	1002	2026-11-11
492	559	Blood pressure check	BP a little high.	1021	2026-11-11
493	394	Dizziness	Dizzy when standing.	1007	2026-11-12
494	576	Stomach pain	Heartburn after meals.	1021	2026-11-12
495	577	Cough	Dry cough for 5 days.	1002	2026-11-12
496	387	Diabetes follow-up	Sugar a bit high this month.	1003	2026-11-12
497	584	Back pain	Lifted something heavy.	1001	2026-11-12
498	390	Cough	Dry cough for 5 days.	1022	2026-11-12
499	392	Skin rash	Itchy rash on arm.	1005	2026-11-12
500	396	Headaches	Frequent headaches.	1023	2026-11-12
501	388	Stomach pain	Heartburn after meals.	1003	2026-11-12
502	391	Chest pain	ECG normal.	1004	2026-11-12
503	381	Sore throat	Red throat, no fever.	1001	2026-11-12
504	393	Wrist pain	Swollen wrist.	1006	2026-11-12
\.


--
-- Data for Name: billing_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.billing_history (history_id, invoice_id, payment_id, old_status, new_status, changed_by, reason, changed_at, changed_by_patient) FROM stdin;
48	64	607	\N	Completed	1014	\N	2026-10-25 22:35:10.392562+00	\N
49	64	\N	Pending	Paid	1014	\N	2026-10-25 22:35:10.392562+00	\N
50	21	608	\N	Completed	1014	\N	2026-10-28 00:15:14.024331+00	\N
51	21	\N	Overdue	Paid	1014	\N	2026-10-28 00:15:14.024331+00	\N
52	70	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
53	70	610	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	108
54	71	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
55	72	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
56	72	611	\N	Completed	1015	\N	2026-11-05 22:26:29.874258+00	\N
57	72	\N	Pending	Paid	1015	\N	2026-11-05 22:26:29.874258+00	\N
58	73	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
59	74	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
60	74	612	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	105
61	75	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
62	75	613	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	127
63	75	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	127
64	76	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
65	77	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
66	77	614	\N	Completed	1029	\N	2026-11-05 22:26:29.874258+00	\N
67	77	\N	Pending	Paid	1029	\N	2026-11-05 22:26:29.874258+00	\N
68	78	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
69	79	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
70	80	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
71	80	615	\N	Completed	1015	\N	2026-11-05 22:26:29.874258+00	\N
72	80	\N	Pending	Paid	1015	\N	2026-11-05 22:26:29.874258+00	\N
73	81	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
74	81	616	\N	Completed	1014	\N	2026-11-05 22:26:29.874258+00	\N
75	81	\N	Pending	Paid	1014	\N	2026-11-05 22:26:29.874258+00	\N
76	82	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
77	83	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
78	84	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
79	84	617	\N	Completed	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
80	84	\N	Pending	Paid	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
81	85	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
82	85	618	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	106
83	85	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	106
84	85	618	Completed	Requested	1014	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
85	85	618	Requested	Refunded	1017	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
86	85	\N	Paid	Pending	1017	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
87	86	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
88	86	619	\N	Completed	1015	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
89	86	\N	Pending	Paid	1015	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
90	87	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
91	87	620	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	114
92	87	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	114
93	88	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
94	88	621	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	125
95	89	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
96	89	622	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	125
97	90	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
98	91	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
99	91	623	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	105
100	91	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	105
101	92	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
102	93	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
103	93	624	\N	Completed	1030	\N	2026-11-05 22:26:29.874258+00	\N
104	93	\N	Pending	Paid	1030	\N	2026-11-05 22:26:29.874258+00	\N
105	94	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
106	95	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
107	95	625	\N	Completed	1028	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
108	95	\N	Pending	Paid	1028	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
109	95	\N	Paid	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
110	95	626	\N	Completed	1028	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
111	95	\N	Pending	Paid	1028	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
112	96	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
113	96	627	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	125
114	97	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
115	97	628	\N	Completed	1016	\N	2026-11-05 22:26:29.874258+00	\N
116	97	\N	Pending	Paid	1016	\N	2026-11-05 22:26:29.874258+00	\N
117	98	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
118	98	629	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	120
119	99	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
120	99	630	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	127
121	99	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	127
122	100	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
123	100	631	\N	Completed	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
124	100	\N	Pending	Paid	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
125	100	\N	Paid	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
126	100	632	\N	Completed	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
127	100	\N	Pending	Paid	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
128	101	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
129	101	633	\N	Completed	1016	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
130	101	\N	Pending	Paid	1016	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
131	102	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
132	102	634	\N	Completed	1014	\N	2026-11-05 22:26:29.874258+00	\N
133	102	\N	Pending	Paid	1014	\N	2026-11-05 22:26:29.874258+00	\N
134	103	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
135	103	635	\N	Completed	1014	\N	2026-11-05 22:26:29.874258+00	\N
136	103	\N	Pending	Paid	1014	\N	2026-11-05 22:26:29.874258+00	\N
137	104	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
138	105	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
139	105	636	\N	Completed	1014	\N	2026-11-05 22:26:29.874258+00	\N
140	105	\N	Pending	Paid	1014	\N	2026-11-05 22:26:29.874258+00	\N
141	106	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
142	106	637	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	129
143	106	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	129
144	106	637	Completed	Requested	1028	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
145	107	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
146	107	638	\N	Completed	1028	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
147	107	\N	Pending	Paid	1028	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
148	107	\N	Paid	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
149	107	639	\N	Completed	1028	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
150	107	\N	Pending	Paid	1028	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
151	108	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
152	108	640	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	113
153	108	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	113
154	109	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
155	110	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
156	111	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
157	112	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
158	112	641	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	107
159	113	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
160	114	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
161	114	642	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	109
162	115	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
163	115	643	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	114
164	115	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	114
165	116	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
166	116	644	\N	Completed	1030	\N	2026-11-05 22:26:29.874258+00	\N
167	116	\N	Pending	Paid	1030	\N	2026-11-05 22:26:29.874258+00	\N
168	117	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
169	117	645	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	113
170	117	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	113
171	118	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
172	118	646	\N	Completed	1029	\N	2026-11-05 22:26:29.874258+00	\N
173	118	\N	Pending	Paid	1029	\N	2026-11-05 22:26:29.874258+00	\N
174	119	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
175	119	647	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	121
176	119	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	121
177	120	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
178	120	648	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	108
179	120	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	108
180	121	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
181	121	649	\N	Completed	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
182	121	\N	Pending	Paid	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
183	121	\N	Paid	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
184	121	650	\N	Completed	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
185	121	\N	Pending	Paid	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
186	121	\N	Paid	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
187	121	651	\N	Completed	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
188	121	\N	Pending	Paid	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
189	122	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
190	122	652	\N	Completed	1015	\N	2026-11-05 22:26:29.874258+00	\N
191	122	\N	Pending	Paid	1015	\N	2026-11-05 22:26:29.874258+00	\N
192	123	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
193	123	653	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	126
194	123	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	126
195	124	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
196	124	654	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	109
197	124	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	109
198	125	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
199	125	655	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	105
200	125	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	105
201	126	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
202	126	656	\N	Completed	1016	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
203	126	\N	Pending	Paid	1016	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
204	126	\N	Paid	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
205	126	657	\N	Completed	1016	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
206	126	\N	Pending	Paid	1016	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
207	127	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
208	127	658	\N	Completed	1015	\N	2026-11-05 22:26:29.874258+00	\N
209	127	\N	Pending	Paid	1015	\N	2026-11-05 22:26:29.874258+00	\N
210	128	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
211	128	659	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	115
212	128	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	115
213	129	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
214	129	660	\N	Completed	1015	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
215	129	\N	Pending	Paid	1015	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
216	129	\N	Paid	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
217	129	661	\N	Completed	1015	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
218	129	\N	Pending	Paid	1015	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
219	130	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
220	130	662	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	113
221	130	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	113
222	131	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
223	131	663	\N	Completed	1016	\N	2026-11-05 22:26:29.874258+00	\N
224	131	\N	Pending	Paid	1016	\N	2026-11-05 22:26:29.874258+00	\N
225	132	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
226	133	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
227	133	664	\N	Completed	1028	\N	2026-11-05 22:26:29.874258+00	\N
228	133	\N	Pending	Paid	1028	\N	2026-11-05 22:26:29.874258+00	\N
229	133	664	Completed	Requested	1028	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
230	134	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
231	134	665	\N	Completed	1030	\N	2026-11-05 22:26:29.874258+00	\N
232	134	\N	Pending	Paid	1030	\N	2026-11-05 22:26:29.874258+00	\N
233	135	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
234	135	666	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	109
235	135	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	109
236	136	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
237	136	667	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	115
238	136	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	115
239	137	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
240	137	668	\N	Completed	1016	\N	2026-11-05 22:26:29.874258+00	\N
241	137	\N	Pending	Paid	1016	\N	2026-11-05 22:26:29.874258+00	\N
242	138	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
243	139	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
244	139	669	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	106
245	139	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	106
246	140	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
247	141	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
248	141	670	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	105
249	142	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
250	142	671	\N	Completed	1028	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
251	142	\N	Pending	Paid	1028	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
252	143	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
253	143	672	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	129
254	143	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	129
255	144	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
256	144	673	\N	Completed	1030	\N	2026-11-05 22:26:29.874258+00	\N
257	144	\N	Pending	Paid	1030	\N	2026-11-05 22:26:29.874258+00	\N
258	144	673	Completed	Requested	1030	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
259	144	673	Requested	Refunded	1017	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
260	144	\N	Paid	Pending	1017	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
261	145	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
262	145	674	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	125
263	146	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
264	147	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
265	148	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
266	149	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
267	150	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
268	150	675	\N	Completed	1029	\N	2026-11-05 22:26:29.874258+00	\N
269	150	\N	Pending	Paid	1029	\N	2026-11-05 22:26:29.874258+00	\N
270	151	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
271	152	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
272	153	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
273	153	676	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	101
274	153	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	101
275	154	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
276	154	677	\N	Completed	1015	\N	2026-11-05 22:26:29.874258+00	\N
277	154	\N	Pending	Paid	1015	\N	2026-11-05 22:26:29.874258+00	\N
278	155	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
279	155	678	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	110
280	156	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
281	156	679	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	104
282	157	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
283	157	680	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	1
284	157	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	1
285	158	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
286	158	681	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	113
287	159	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
288	160	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
289	160	682	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	120
290	161	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
291	161	683	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	121
292	161	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	121
293	162	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
294	163	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
295	164	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
296	164	684	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	108
297	165	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
298	165	685	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	113
299	165	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	113
300	166	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
301	166	686	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	126
302	166	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	126
303	167	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
304	167	687	\N	Completed	1015	\N	2026-11-05 22:26:29.874258+00	\N
305	167	\N	Pending	Paid	1015	\N	2026-11-05 22:26:29.874258+00	\N
306	168	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
307	168	688	\N	Completed	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
308	168	\N	Pending	Paid	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
309	168	\N	Paid	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
310	168	689	\N	Completed	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
311	168	\N	Pending	Paid	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
312	168	\N	Paid	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
313	168	690	\N	Completed	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
314	168	\N	Pending	Paid	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
315	169	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
316	169	691	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	110
317	169	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	110
318	170	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
319	170	692	\N	Completed	1016	\N	2026-11-05 22:26:29.874258+00	\N
320	170	\N	Pending	Paid	1016	\N	2026-11-05 22:26:29.874258+00	\N
321	171	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
322	172	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
323	172	693	\N	Completed	1014	\N	2026-11-05 22:26:29.874258+00	\N
324	172	\N	Pending	Paid	1014	\N	2026-11-05 22:26:29.874258+00	\N
325	173	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
326	173	694	\N	Completed	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
327	173	\N	Pending	Paid	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
328	174	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
329	174	695	\N	Completed	1015	\N	2026-11-05 22:26:29.874258+00	\N
330	174	\N	Pending	Paid	1015	\N	2026-11-05 22:26:29.874258+00	\N
331	175	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
332	176	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
333	177	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
334	178	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
335	178	696	\N	Completed	1014	\N	2026-11-05 22:26:29.874258+00	\N
336	178	\N	Pending	Paid	1014	\N	2026-11-05 22:26:29.874258+00	\N
337	179	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
338	179	697	\N	Completed	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
339	179	\N	Pending	Paid	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
340	179	\N	Paid	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
341	179	698	\N	Completed	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
342	179	\N	Pending	Paid	1014	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
343	180	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
344	180	699	\N	Completed	1030	\N	2026-11-05 22:26:29.874258+00	\N
345	180	\N	Pending	Paid	1030	\N	2026-11-05 22:26:29.874258+00	\N
346	181	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
347	181	700	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	124
348	182	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
349	183	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
350	184	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
351	185	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
352	185	701	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	109
353	185	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	109
354	186	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
355	186	702	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	114
356	186	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	114
357	187	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
358	188	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
359	188	703	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	115
360	189	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
361	189	704	\N	Completed	1030	\N	2026-11-05 22:26:29.874258+00	\N
362	189	\N	Pending	Paid	1030	\N	2026-11-05 22:26:29.874258+00	\N
363	189	704	Completed	Requested	1030	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
364	189	704	Requested	Refunded	1033	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
365	189	\N	Paid	Pending	1033	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
366	190	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
367	190	705	\N	Completed	1016	\N	2026-11-05 22:26:29.874258+00	\N
368	190	\N	Pending	Paid	1016	\N	2026-11-05 22:26:29.874258+00	\N
369	191	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
370	192	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
371	193	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
372	194	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
373	194	706	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	108
374	194	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	108
375	195	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
376	195	707	\N	Completed	1016	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
377	195	\N	Pending	Paid	1016	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
378	196	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
379	196	708	\N	Completed	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
380	196	\N	Pending	Paid	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
381	196	\N	Paid	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
382	196	709	\N	Completed	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
383	196	\N	Pending	Paid	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
384	197	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
385	198	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
386	199	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
387	200	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
388	200	710	\N	Completed	1028	\N	2026-11-05 22:26:29.874258+00	\N
389	200	\N	Pending	Paid	1028	\N	2026-11-05 22:26:29.874258+00	\N
390	201	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
391	201	711	\N	Completed	1016	\N	2026-11-05 22:26:29.874258+00	\N
392	201	\N	Pending	Paid	1016	\N	2026-11-05 22:26:29.874258+00	\N
393	202	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
394	202	712	\N	Completed	1015	\N	2026-11-05 22:26:29.874258+00	\N
395	202	\N	Pending	Paid	1015	\N	2026-11-05 22:26:29.874258+00	\N
396	202	712	Completed	Requested	1015	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
397	202	712	Requested	Refunded	1017	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
398	202	\N	Paid	Pending	1017	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
399	203	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
400	204	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
401	205	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
402	206	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
403	206	713	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	115
404	206	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	115
405	207	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
406	208	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
407	209	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
408	209	714	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	111
409	210	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
410	210	715	\N	Completed	1029	\N	2026-11-05 22:26:29.874258+00	\N
411	210	\N	Pending	Paid	1029	\N	2026-11-05 22:26:29.874258+00	\N
412	211	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
413	211	716	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	107
414	212	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
415	212	717	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	126
416	213	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
417	214	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
418	215	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
419	215	718	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	129
420	215	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	129
421	216	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
422	216	719	\N	Completed	1015	\N	2026-11-05 22:26:29.874258+00	\N
423	216	\N	Pending	Paid	1015	\N	2026-11-05 22:26:29.874258+00	\N
424	217	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
425	217	720	\N	Completed	1014	\N	2026-11-05 22:26:29.874258+00	\N
426	217	\N	Pending	Paid	1014	\N	2026-11-05 22:26:29.874258+00	\N
427	218	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
428	218	721	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	104
429	218	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	104
430	219	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
431	219	722	\N	Completed	1028	\N	2026-11-05 22:26:29.874258+00	\N
432	219	\N	Pending	Paid	1028	\N	2026-11-05 22:26:29.874258+00	\N
433	220	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
434	220	723	\N	Completed	1015	\N	2026-11-05 22:26:29.874258+00	\N
435	220	\N	Pending	Paid	1015	\N	2026-11-05 22:26:29.874258+00	\N
436	221	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
437	221	724	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	125
438	221	\N	Pending	Paid	\N	\N	2026-11-05 22:26:29.874258+00	125
439	222	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
440	223	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
441	223	725	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	121
442	224	\N	\N	Pending	1014	\N	2026-11-05 22:26:29.874258+00	\N
443	225	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
444	226	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
445	226	726	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	105
446	227	\N	\N	Pending	1028	\N	2026-11-05 22:26:29.874258+00	\N
447	227	727	\N	Completed	1028	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
448	227	\N	Pending	Paid	1028	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
449	228	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
450	229	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
451	229	728	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	113
452	230	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
453	230	729	\N	Completed	1030	Paid by insurance: Cigna	2026-11-05 22:26:29.874258+00	\N
454	230	\N	Pending	Paid	1030	Paid by insurance: Cigna	2026-11-05 22:26:29.874258+00	\N
455	230	\N	Paid	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
456	230	730	\N	Completed	1030	Paid by insurance: Cigna	2026-11-05 22:26:29.874258+00	\N
457	230	\N	Pending	Paid	1030	Paid by insurance: Cigna	2026-11-05 22:26:29.874258+00	\N
458	231	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
459	231	731	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	116
460	232	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
461	233	\N	\N	Pending	1029	\N	2026-11-05 22:26:29.874258+00	\N
462	233	732	\N	Completed	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
463	233	\N	Pending	Paid	1029	Paid by insurance: Aetna	2026-11-05 22:26:29.874258+00	\N
464	234	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
465	234	733	\N	Completed	1016	\N	2026-11-05 22:26:29.874258+00	\N
466	234	\N	Pending	Paid	1016	\N	2026-11-05 22:26:29.874258+00	\N
467	234	733	Completed	Requested	1016	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
468	234	733	Requested	Refunded	1033	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
469	234	\N	Paid	Pending	1033	Patient asked for a refund	2026-11-05 22:26:29.874258+00	\N
470	235	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
471	235	734	\N	Completed	1030	\N	2026-11-05 22:26:29.874258+00	\N
472	235	\N	Pending	Paid	1030	\N	2026-11-05 22:26:29.874258+00	\N
473	236	\N	\N	Pending	1030	\N	2026-11-05 22:26:29.874258+00	\N
474	236	735	\N	Completed	1030	\N	2026-11-05 22:26:29.874258+00	\N
475	236	\N	Pending	Paid	1030	\N	2026-11-05 22:26:29.874258+00	\N
476	237	\N	\N	Pending	1016	\N	2026-11-05 22:26:29.874258+00	\N
477	237	736	\N	Completed	\N	\N	2026-11-05 22:26:29.874258+00	104
478	238	\N	\N	Pending	1015	\N	2026-11-05 22:26:29.874258+00	\N
479	238	737	\N	Completed	1015	\N	2026-11-05 22:26:29.874258+00	\N
480	238	\N	Pending	Paid	1015	\N	2026-11-05 22:26:29.874258+00	\N
481	59	738	\N	Completed	1014	Paid by insurance: blue cross shield	2026-11-09 19:14:11.379908+00	\N
482	59	\N	Pending	Paid	1014	Paid by insurance: blue cross shield	2026-11-09 19:14:11.379908+00	\N
483	155	739	\N	Completed	1014	Paid by insurance: blue cross shield	2026-11-09 19:14:11.379908+00	\N
484	155	\N	Pending	Paid	1014	Paid by insurance: blue cross shield	2026-11-09 19:14:11.379908+00	\N
485	208	740	\N	Completed	1014	Paid by insurance: blue cross shield	2026-11-09 19:14:11.379908+00	\N
486	208	\N	Pending	Paid	1014	Paid by insurance: blue cross shield	2026-11-09 19:14:11.379908+00	\N
487	237	741	\N	Completed	1017	\N	2026-11-12 00:37:17.466057+00	\N
488	237	\N	Pending	Paid	1017	\N	2026-11-12 00:37:17.466057+00	\N
489	234	742	\N	Completed	1017	\N	2026-11-12 00:37:35.619293+00	\N
490	234	\N	Pending	Paid	1017	\N	2026-11-12 00:37:35.619293+00	\N
491	163	743	\N	Completed	\N	\N	2026-11-12 04:26:09.534098+00	101
492	163	\N	Pending	Paid	\N	\N	2026-11-12 04:26:09.534098+00	101
493	203	744	\N	Completed	\N	\N	2026-11-12 11:09:59.099261+00	101
494	239	\N	\N	Pending	1016	\N	2026-11-12 20:46:44.481835+00	\N
495	203	745	\N	Completed	\N	\N	2026-11-12 20:56:32.036582+00	101
496	203	746	\N	Completed	\N	\N	2026-11-12 20:59:59.201293+00	101
497	203	747	\N	Completed	\N	\N	2026-11-12 21:00:57.803861+00	101
498	203	748	\N	Completed	\N	\N	2026-11-12 21:04:59.656994+00	101
499	240	\N	\N	Pending	1029	\N	2026-11-12 21:11:34.014843+00	\N
500	240	749	\N	Completed	\N	\N	2026-11-12 21:11:34.014843+00	101
501	240	\N	Pending	Paid	\N	\N	2026-11-12 21:11:34.014843+00	101
502	241	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
503	241	750	\N	Completed	\N	\N	2026-11-12 21:11:34.014843+00	107
504	241	\N	Pending	Paid	\N	\N	2026-11-12 21:11:34.014843+00	107
505	242	\N	\N	Pending	1016	\N	2026-11-12 21:11:34.014843+00	\N
506	243	\N	\N	Pending	1016	\N	2026-11-12 21:11:34.014843+00	\N
507	243	751	\N	Completed	1016	\N	2026-11-12 21:11:34.014843+00	\N
508	243	\N	Pending	Paid	1016	\N	2026-11-12 21:11:34.014843+00	\N
509	244	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
510	244	752	\N	Completed	1014	\N	2026-11-12 21:11:34.014843+00	\N
511	244	\N	Pending	Paid	1014	\N	2026-11-12 21:11:34.014843+00	\N
512	245	\N	\N	Pending	1028	\N	2026-11-12 21:11:34.014843+00	\N
513	246	\N	\N	Pending	1016	\N	2026-11-12 21:11:34.014843+00	\N
514	246	753	\N	Completed	1016	\N	2026-11-12 21:11:34.014843+00	\N
515	246	\N	Pending	Paid	1016	\N	2026-11-12 21:11:34.014843+00	\N
516	247	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
517	247	754	\N	Completed	1014	\N	2026-11-12 21:11:34.014843+00	\N
518	247	\N	Pending	Paid	1014	\N	2026-11-12 21:11:34.014843+00	\N
519	248	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
520	248	755	\N	Completed	\N	\N	2026-11-12 21:11:34.014843+00	109
521	248	\N	Pending	Paid	\N	\N	2026-11-12 21:11:34.014843+00	109
522	249	\N	\N	Pending	1028	\N	2026-11-12 21:11:34.014843+00	\N
523	249	756	\N	Completed	1028	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
524	249	\N	Pending	Paid	1028	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
525	249	\N	Paid	Pending	1028	\N	2026-11-12 21:11:34.014843+00	\N
526	249	757	\N	Completed	1028	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
527	249	\N	Pending	Paid	1028	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
528	250	\N	\N	Pending	1015	\N	2026-11-12 21:11:34.014843+00	\N
529	250	758	\N	Completed	1015	\N	2026-11-12 21:11:34.014843+00	\N
530	250	\N	Pending	Paid	1015	\N	2026-11-12 21:11:34.014843+00	\N
531	251	\N	\N	Pending	1016	\N	2026-11-12 21:11:34.014843+00	\N
532	252	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
533	252	759	\N	Completed	\N	\N	2026-11-12 21:11:34.014843+00	117
534	252	\N	Pending	Paid	\N	\N	2026-11-12 21:11:34.014843+00	117
535	253	\N	\N	Pending	1015	\N	2026-11-12 21:11:34.014843+00	\N
536	253	760	\N	Completed	1015	\N	2026-11-12 21:11:34.014843+00	\N
537	253	\N	Pending	Paid	1015	\N	2026-11-12 21:11:34.014843+00	\N
538	254	\N	\N	Pending	1028	\N	2026-11-12 21:11:34.014843+00	\N
539	255	\N	\N	Pending	1028	\N	2026-11-12 21:11:34.014843+00	\N
540	256	\N	\N	Pending	1015	\N	2026-11-12 21:11:34.014843+00	\N
541	257	\N	\N	Pending	1015	\N	2026-11-12 21:11:34.014843+00	\N
542	258	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
543	258	761	\N	Completed	1014	\N	2026-11-12 21:11:34.014843+00	\N
544	258	\N	Pending	Paid	1014	\N	2026-11-12 21:11:34.014843+00	\N
545	259	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
546	259	762	\N	Completed	1030	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
547	259	\N	Pending	Paid	1030	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
548	259	\N	Paid	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
549	259	763	\N	Completed	1030	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
550	259	\N	Pending	Paid	1030	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
551	259	\N	Paid	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
552	259	764	\N	Completed	1030	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
553	259	\N	Pending	Paid	1030	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
554	260	\N	\N	Pending	1016	\N	2026-11-12 21:11:34.014843+00	\N
555	260	765	\N	Completed	1016	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
556	260	\N	Pending	Paid	1016	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
557	261	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
558	262	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
559	263	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
560	263	766	\N	Completed	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
561	263	\N	Pending	Paid	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
562	263	\N	Paid	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
563	263	767	\N	Completed	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
564	263	\N	Pending	Paid	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
565	264	\N	\N	Pending	1015	\N	2026-11-12 21:11:34.014843+00	\N
566	265	\N	\N	Pending	1029	\N	2026-11-12 21:11:34.014843+00	\N
567	265	768	\N	Completed	1029	\N	2026-11-12 21:11:34.014843+00	\N
568	265	\N	Pending	Paid	1029	\N	2026-11-12 21:11:34.014843+00	\N
569	266	\N	\N	Pending	1015	\N	2026-11-12 21:11:34.014843+00	\N
570	267	\N	\N	Pending	1016	\N	2026-11-12 21:11:34.014843+00	\N
571	267	769	\N	Completed	1016	\N	2026-11-12 21:11:34.014843+00	\N
572	267	\N	Pending	Paid	1016	\N	2026-11-12 21:11:34.014843+00	\N
573	268	\N	\N	Pending	1029	\N	2026-11-12 21:11:34.014843+00	\N
574	268	770	\N	Completed	1029	\N	2026-11-12 21:11:34.014843+00	\N
575	268	\N	Pending	Paid	1029	\N	2026-11-12 21:11:34.014843+00	\N
576	269	\N	\N	Pending	1016	\N	2026-11-12 21:11:34.014843+00	\N
577	269	771	\N	Completed	1016	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
578	269	\N	Pending	Paid	1016	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
579	269	\N	Paid	Pending	1016	\N	2026-11-12 21:11:34.014843+00	\N
580	269	772	\N	Completed	1016	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
581	269	\N	Pending	Paid	1016	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
582	270	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
583	270	773	\N	Completed	\N	\N	2026-11-12 21:11:34.014843+00	101
584	270	\N	Pending	Paid	\N	\N	2026-11-12 21:11:34.014843+00	101
585	271	\N	\N	Pending	1016	\N	2026-11-12 21:11:34.014843+00	\N
586	271	774	\N	Completed	1016	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
587	271	\N	Pending	Paid	1016	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
588	271	\N	Paid	Pending	1016	\N	2026-11-12 21:11:34.014843+00	\N
589	271	775	\N	Completed	1016	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
590	271	\N	Pending	Paid	1016	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
591	272	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
592	272	776	\N	Completed	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
593	272	\N	Pending	Paid	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
594	272	\N	Paid	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
595	272	777	\N	Completed	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
596	272	\N	Pending	Paid	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
597	273	\N	\N	Pending	1028	\N	2026-11-12 21:11:34.014843+00	\N
598	273	778	\N	Completed	1028	\N	2026-11-12 21:11:34.014843+00	\N
599	273	\N	Pending	Paid	1028	\N	2026-11-12 21:11:34.014843+00	\N
600	274	\N	\N	Pending	1015	\N	2026-11-12 21:11:34.014843+00	\N
601	275	\N	\N	Pending	1015	\N	2026-11-12 21:11:34.014843+00	\N
602	276	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
603	276	779	\N	Completed	\N	\N	2026-11-12 21:11:34.014843+00	114
604	276	\N	Pending	Paid	\N	\N	2026-11-12 21:11:34.014843+00	114
605	277	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
606	278	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
607	278	780	\N	Completed	1014	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
608	278	\N	Pending	Paid	1014	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
609	278	\N	Paid	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
610	278	781	\N	Completed	1014	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
611	278	\N	Pending	Paid	1014	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
612	278	\N	Paid	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
613	278	782	\N	Completed	1014	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
614	278	\N	Pending	Paid	1014	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
615	279	\N	\N	Pending	1015	\N	2026-11-12 21:11:34.014843+00	\N
616	280	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
617	280	783	\N	Completed	\N	\N	2026-11-12 21:11:34.014843+00	104
618	280	\N	Pending	Paid	\N	\N	2026-11-12 21:11:34.014843+00	104
619	281	\N	\N	Pending	1029	\N	2026-11-12 21:11:34.014843+00	\N
620	282	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
621	283	\N	\N	Pending	1015	\N	2026-11-12 21:11:34.014843+00	\N
622	283	784	\N	Completed	\N	\N	2026-11-12 21:11:34.014843+00	120
623	283	\N	Pending	Paid	\N	\N	2026-11-12 21:11:34.014843+00	120
624	284	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
625	284	785	\N	Completed	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
626	284	\N	Pending	Paid	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
627	284	\N	Paid	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
628	284	786	\N	Completed	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
629	284	\N	Pending	Paid	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
630	284	\N	Paid	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
631	284	787	\N	Completed	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
632	284	\N	Pending	Paid	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
633	285	\N	\N	Pending	1029	\N	2026-11-12 21:11:34.014843+00	\N
634	285	788	\N	Completed	1029	\N	2026-11-12 21:11:34.014843+00	\N
635	285	\N	Pending	Paid	1029	\N	2026-11-12 21:11:34.014843+00	\N
636	286	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
637	286	789	\N	Completed	1014	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
638	286	\N	Pending	Paid	1014	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
639	286	\N	Paid	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
640	286	790	\N	Completed	1014	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
641	286	\N	Pending	Paid	1014	Paid by insurance: Aetna	2026-11-12 21:11:34.014843+00	\N
642	287	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
643	287	791	\N	Completed	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
644	287	\N	Pending	Paid	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
645	287	\N	Paid	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
646	287	792	\N	Completed	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
647	287	\N	Pending	Paid	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
648	288	\N	\N	Pending	1028	\N	2026-11-12 21:11:34.014843+00	\N
649	288	793	\N	Completed	1028	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
650	288	\N	Pending	Paid	1028	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
651	289	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
652	289	794	\N	Completed	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
653	289	\N	Pending	Paid	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
654	290	\N	\N	Pending	1028	\N	2026-11-12 21:11:34.014843+00	\N
655	291	\N	\N	Pending	1028	\N	2026-11-12 21:11:34.014843+00	\N
656	292	\N	\N	Pending	1016	\N	2026-11-12 21:11:34.014843+00	\N
657	293	\N	\N	Pending	1028	\N	2026-11-12 21:11:34.014843+00	\N
658	294	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
659	294	795	\N	Completed	1014	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
660	294	\N	Pending	Paid	1014	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
661	294	\N	Paid	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
662	294	796	\N	Completed	1014	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
663	294	\N	Pending	Paid	1014	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
664	295	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
665	295	797	\N	Completed	1030	\N	2026-11-12 21:11:34.014843+00	\N
666	295	\N	Pending	Paid	1030	\N	2026-11-12 21:11:34.014843+00	\N
667	296	\N	\N	Pending	1029	\N	2026-11-12 21:11:34.014843+00	\N
668	297	\N	\N	Pending	1016	\N	2026-11-12 21:11:34.014843+00	\N
669	298	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
670	298	798	\N	Completed	\N	\N	2026-11-12 21:11:34.014843+00	101
671	298	\N	Pending	Paid	\N	\N	2026-11-12 21:11:34.014843+00	101
672	299	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
673	300	\N	\N	Pending	1016	\N	2026-11-12 21:11:34.014843+00	\N
674	301	\N	\N	Pending	1029	\N	2026-11-12 21:11:34.014843+00	\N
675	302	\N	\N	Pending	1029	\N	2026-11-12 21:11:34.014843+00	\N
676	303	\N	\N	Pending	1029	\N	2026-11-12 21:11:34.014843+00	\N
677	304	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
678	304	799	\N	Completed	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
679	304	\N	Pending	Paid	1030	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
680	305	\N	\N	Pending	1029	\N	2026-11-12 21:11:34.014843+00	\N
681	305	800	\N	Completed	1029	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
682	305	\N	Pending	Paid	1029	Paid by insurance: blue cross shield	2026-11-12 21:11:34.014843+00	\N
683	306	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
684	307	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
685	307	801	\N	Completed	1014	\N	2026-11-12 21:11:34.014843+00	\N
686	307	\N	Pending	Paid	1014	\N	2026-11-12 21:11:34.014843+00	\N
687	308	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
688	309	\N	\N	Pending	1030	\N	2026-11-12 21:11:34.014843+00	\N
689	310	\N	\N	Pending	1028	\N	2026-11-12 21:11:34.014843+00	\N
690	311	\N	\N	Pending	1028	\N	2026-11-12 21:11:34.014843+00	\N
691	312	\N	\N	Pending	1015	\N	2026-11-12 21:11:34.014843+00	\N
692	312	802	\N	Completed	1015	Paid by insurance: Cigna	2026-11-12 21:11:34.014843+00	\N
693	312	\N	Pending	Paid	1015	Paid by insurance: Cigna	2026-11-12 21:11:34.014843+00	\N
694	313	\N	\N	Pending	1014	\N	2026-11-12 21:11:34.014843+00	\N
695	314	\N	\N	Pending	1015	\N	2026-11-12 21:11:34.014843+00	\N
696	314	803	\N	Completed	\N	\N	2026-11-12 21:11:34.014843+00	111
697	314	\N	Pending	Paid	\N	\N	2026-11-12 21:11:34.014843+00	111
698	279	804	\N	Completed	\N	\N	2026-11-12 21:17:16.915688+00	101
699	279	805	\N	Completed	\N	\N	2026-11-12 21:29:54.25666+00	101
700	279	806	\N	Completed	\N	\N	2026-11-12 21:56:31.116225+00	101
701	279	807	\N	Completed	\N	\N	2026-11-12 22:12:20.389815+00	101
702	315	\N	\N	Pending	1016	\N	2026-11-12 22:24:45.118966+00	\N
703	279	808	\N	Completed	\N	\N	2026-11-13 00:31:27.284047+00	101
704	316	\N	\N	Pending	1001	No-show fee	2026-11-15 04:49:58.9859+00	\N
705	317	\N	\N	Pending	1003	No-show fee	2026-11-15 04:49:58.9859+00	\N
706	318	\N	\N	Pending	1003	No-show fee	2026-11-15 04:49:58.9859+00	\N
707	319	\N	\N	Pending	1024	No-show fee	2026-11-15 04:49:58.9859+00	\N
708	320	\N	\N	Pending	1001	No-show fee	2026-11-15 04:49:58.9859+00	\N
709	320	809	\N	Completed	1001	Paid by insurance: blue cross shield	2026-11-15 04:49:58.9859+00	\N
710	320	\N	Pending	Paid	1001	Paid by insurance: blue cross shield	2026-11-15 04:49:58.9859+00	\N
\.


--
-- Data for Name: certificate; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.certificate (certificate_id, employee_id, name, status, issue_date, expiration_date) FROM stdin;
3	1013	BLS	Active	2026-09-28	2027-02-04
4	1002	a	Expired	0100-08-25	2026-10-26
\.


--
-- Data for Name: doctor; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.doctor (employee_id, license_number, license_issuing_state, license_expiration_date, npi_number, dea_number) FROM stdin;
1008	TX-L25689	TX	2028-04-30	1194850627	BW2568918
1006	TX-N62951	TX	2028-05-31	1972638405	BB6295136
1004	TX-M77104	TX	2027-01-31	1750416283	BH7710454
1003	TX-P30762	TX	2028-11-30	1649305172	BT3076283
1001	TX-Q48213	TX	2028-03-31	1427583910	BM4821391
1007	TX-S81437	TX	2027-12-31	1083749516	BV8143727
1005	TX-S56328	TX	2029-09-30	1861527394	BR5632845
1002	TX-R19475	TX	2027-07-31	1538294061	BO1947562
1021	TX-A10291	TX	2028-12-31	1302948576	BB1029384
1022	TX-A10292	TX	2028-12-31	1413059687	BP1029395
1023	TX-A10293	TX	2028-12-31	1524160798	BS1029406
1024	TX-A10294	TX	2028-12-31	1635271809	BC1029417
1035	A	TX	2030-08-25	1010101010	1
\.


--
-- Data for Name: doctor_schedule; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.doctor_schedule (doctor_id, day_of_week, office_id, specialty_id, shift_type_id, is_active) FROM stdin;
1008	Monday	5	21	7	t
1008	Tuesday	5	21	7	t
1008	Wednesday	5	21	7	t
1008	Thursday	5	21	7	t
1008	Friday	5	21	7	t
1006	Monday	5	19	7	t
1006	Wednesday	5	19	7	t
1006	Thursday	5	19	7	t
1006	Friday	5	19	7	t
1004	Monday	5	17	7	t
1004	Tuesday	5	17	7	t
1004	Wednesday	5	17	7	t
1004	Thursday	5	17	7	t
1004	Friday	5	17	7	t
1003	Monday	5	16	7	t
1003	Tuesday	5	16	7	t
1003	Wednesday	5	16	7	t
1003	Thursday	5	16	7	t
1003	Friday	5	16	7	t
1001	Monday	5	15	7	t
1001	Tuesday	5	15	7	t
1001	Wednesday	5	15	7	t
1001	Thursday	5	15	7	t
1001	Friday	5	15	7	t
1007	Monday	6	20	7	t
1007	Tuesday	6	20	7	t
1007	Wednesday	6	20	7	t
1007	Thursday	6	20	7	t
1007	Friday	6	20	7	t
1005	Monday	6	18	7	t
1005	Tuesday	6	18	7	t
1005	Wednesday	6	18	7	t
1005	Thursday	6	18	7	t
1005	Friday	6	18	7	t
1002	Monday	6	15	7	t
1002	Wednesday	6	15	7	t
1002	Thursday	6	15	7	t
1002	Friday	6	15	7	t
1006	Tuesday	6	19	7	t
1002	Tuesday	5	15	7	t
1021	Monday	6	16	7	t
1021	Tuesday	6	16	7	t
1021	Wednesday	6	16	7	t
1021	Thursday	6	16	7	t
1021	Friday	6	16	7	t
1022	Monday	6	15	7	t
1022	Tuesday	6	15	6	t
1022	Wednesday	6	15	7	t
1022	Thursday	6	15	6	t
1022	Friday	6	15	7	t
1023	Monday	5	20	7	t
1023	Tuesday	5	20	7	t
1023	Wednesday	5	20	7	t
1023	Thursday	5	20	7	t
1024	Tuesday	6	17	7	t
1024	Wednesday	6	17	7	t
1024	Thursday	6	17	7	t
1024	Friday	6	17	7	t
\.


--
-- Data for Name: doctor_specialty; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.doctor_specialty (doctor_id, specialty_id, is_primary, is_active) FROM stdin;
1008	21	t	t
1006	19	t	t
1004	17	t	t
1003	16	t	t
1001	15	t	t
1007	20	t	t
1005	18	t	t
1002	15	t	t
1021	16	t	t
1022	15	t	t
1023	20	t	t
1024	17	t	t
1035	17	t	t
\.


--
-- Data for Name: emergency_contact; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.emergency_contact (emergency_contact_id, patient_id, first_name, last_name, relationship, phone_number, is_primary, is_active) FROM stdin;
3	1	Tmp	Contact	Friend	7135550003	f	f
2	1	Joe	Doe	Brother	7135550155	t	t
1	1	Jane	Doe-Smith	Spouse	7135550144	f	f
6	119	Pepper	Potts	Spouse	8325556001	t	t
7	120	Bucky	Barnes	Friend	8325555018	t	t
8	121	Loki	Laufeyson	Brother	8325556003	t	t
9	122	Clint	Barton	Friend	8325555015	t	t
10	123	Laura	Barton	Spouse	8325556005	t	t
11	124	May	Parker	Aunt	8325556006	t	t
12	125	Maria	Rambeau	Friend	8325556007	t	t
13	126	Steve	Rogers	Friend	8325555012	t	t
14	127	Gamora	Zen	Partner	8325556009	t	t
15	128	Tony	Stark	Friend	8325555011	t	t
16	129	Clint	Barton	Mentor	8325555015	t	t
\.


--
-- Data for Name: employee; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.employee (employee_id, first_name, last_name, dob, employee_type_id, phone, email, office_id, is_active) FROM stdin;
1002	David	Okafor	1982-07-22	9	8327872038	davidokafor@lambda.clinic.org	6	t
1017	Admin	Acc	1972-09-08	12	7135554001	admin@lambda.clinic.org	5	t
1015	Omar	Haddad	1993-07-14	11	7135553002	omarhaddad@lambda.clinic.org	5	t
1014	Jasmine	Carter	1995-01-21	11	7135553001	jasminecarter@lambda.clinic.org	5	t
1013	Tyler	Johnson	1997-03-09	10	7135552005	tylerjohnson@lambda.clinic.org	5	t
1011	Maria	Delgado	1986-10-19	10	7135552003	mariadelgado@lambda.clinic.org	5	t
1008	James	Whitfield	1973-04-26	9	7135551008	jameswhitfield@lambda.clinic.org	5	t
1006	Marcus	Bennett	1979-05-18	9	7135551006	marcusbennett@lambda.clinic.org	5	t
1003	Linda	Tran	1975-11-05	9	7135551003	lindatran@lambda.clinic.org	5	t
1001	Sarah	Mitchell	1978-03-14	9	7135551001	sarahmitchell@lambda.clinic.org	5	t
1016	Brittany	Lopez	1998-11-30	11	7135553003	brittanylopez@lambda.clinic.org	6	t
1012	Rachel	Kim	1983-08-27	10	7135552004	rachelkim@lambda.clinic.org	6	t
1007	Elena	Vasquez	1981-12-02	9	7135551007	elenavasquez@lambda.clinic.org	6	t
1005	Priya	Raman	1984-09-12	9	7135551005	priyaraman@lambda.clinic.org	6	t
1009	Angela	Brooks	1988-02-11	10	7135552001	angelabrooks@lambda.clinic.org	5	t
1004	Robert	Hayes	1970-01-30	9	7135551004	roberthayes@lambda.clinic.org	5	t
1018	Test	Employee	1995-06-15	10	7135559002	testemployee.edited@lambda.clinic.org	6	f
1010	Kevin	Nguyen	1991-06-03	10	1234567890	kevinnguyen@lambda.clinic.org	6	t
1019	Lab	Tech	2005-05-25	13	1234567890	labtech@lambda.clinic.org	5	t
1020	Dee	Daniels	2004-07-23	13	7777777713	deedaniels@lambda.clinic.org	5	t
1021	Bruce	Banner	1969-12-18	9	7135551009	brucebanner@lambda.clinic.org	6	t
1022	Hank	Pym	1965-10-03	9	7135551010	hankpym@lambda.clinic.org	6	t
1023	Stephen	Strange	1974-11-18	9	7135551011	stephenstrange@lambda.clinic.org	5	t
1024	Helen	Cho	1980-04-09	9	7135551012	helencho@lambda.clinic.org	6	t
1025	Wanda	Maximoff	1992-02-10	10	7135552006	wandamaximoff@lambda.clinic.org	5	t
1026	Sam	Wilson	1986-09-23	10	7135552007	samwilson@lambda.clinic.org	6	t
1027	Hope	Van Dyne	1984-06-12	10	7135552008	hopevandyne@lambda.clinic.org	6	t
1028	Pepper	Potts	1983-03-26	11	7135553004	pepperpotts@lambda.clinic.org	5	t
1029	Happy	Hogan	1977-08-15	11	7135553005	happyhogan@lambda.clinic.org	6	t
1030	Maria	Hill	1985-01-30	11	7135553006	mariahill@lambda.clinic.org	6	t
1031	Scott	Lang	1979-04-06	13	7135555001	scottlang@lambda.clinic.org	5	t
1032	Riri	Williams	2002-07-19	13	7135555002	ririwilliams@lambda.clinic.org	6	t
1033	Nick	Fury	1960-12-21	12	7135554002	nickfury@lambda.clinic.org	5	t
1034	Luke	Bill	1984-11-11	10	1234567890	thisisawestsideclinicnurse@outlook.com	5	t
1035	A	P	2000-08-25	9	8327872038	a@gmail.com	5	t
\.


--
-- Data for Name: employee_audit; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.employee_audit (audit_id, employee_id, field_name, old_value, new_value, changed_at) FROM stdin;
\.


--
-- Data for Name: employee_creds; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.employee_creds (employee_creds_id, employee_id, username, password_hash, created_date, is_active) FROM stdin;
35	1017	admin@lambda.clinic.org	aedeadfaf5f95e0b8ace08fd405c8233:bda2487e7cdf011adc8a12cecf6c3845f31991d3d6844eef0f0ed2757b306a2acaf4dda8cd5959a7f4a33551d2294f986ad2b06ebc6516487649e449d91c62c6	2026-10-17	t
36	1015	omarhaddad@lambda.clinic.org	0d602a20e51a4f381a3fb8f6f3edf804:b1f303cda2b487f5b48907130d8823f209f2d57e9646b9970d6ea48500afece85c04aa3bcb1173a790ffe80316acb041d39efdf48769cc4ab508ca3a918d1a3f	2026-10-17	t
37	1014	jasminecarter@lambda.clinic.org	017ba14b578d6bf94c412b480fe130cd:42484125f7298f0843e979a96f54dcaee2b34524ee894c0606dacccc861b07f3309f44d77025802ed6fb97f337c3526d072cdba65540faaca52319cc04871d62	2026-10-17	t
38	1013	tylerjohnson@lambda.clinic.org	7a9640551e29f4b1241036757f9d5853:2dd5e76940af2325da53bbe76944a0abf72f8db347b48f0f839da5a60a67e9f82108e7dd783a00d77d2fa903f79617e7bef91450ce658579d9c962d68ad17640	2026-10-17	t
39	1011	mariadelgado@lambda.clinic.org	4a5954b9c038d4146decd2238c1fea77:9a733bd3c886101e3dec55abe5ffbad990cf41dba099e6d6eb73a194eb6452c80ebf254db16ea357abaacfc1b0f317f97944f778cd611c65dfa4daf7603b32d8	2026-10-17	t
40	1009	angelabrooks@lambda.clinic.org	000e453246e8fffac1a0ca1d77801fa4:c3d6ed54a69a3e84ff0a1866a0dac0a1a6bd4003fec8e7356e74e693416a5595f955d165558c64d0e11481a1ae537333a2ace95cff1f2760c7c067fde325d76a	2026-10-17	t
41	1008	jameswhitfield@lambda.clinic.org	3361d7a081dc10380affad959913a4b4:3b3f1c255be69501edcd640e7ebe909eeb9751c327c7770c28663347930bdd88a585a31fd7353f12da345ef1690248ce70811b7c50d447c84e7310d4164ffa9d	2026-10-17	t
42	1006	marcusbennett@lambda.clinic.org	73f643bcf2573597ee90b35754258a51:b2f6d6fef8798531c13baafc931412486f7cab2d034485eb1df0857015cf89e21f073ce7d325bbfc41841de97445a28ecdb12d1aacdc435a9b390e5aa56207ef	2026-10-17	t
44	1003	lindatran@lambda.clinic.org	0a3ba9af3b367d054cf4e2fd0a9a261c:3af6f39b4d2bab6a48ff0b0377562667a33851b22a5c017e1a3e86f2e00cee1177d2d5fc38521882865bc8ada9e90de8bfd2793cefee5d81a41da5f5a028bf00	2026-10-17	t
45	1001	sarahmitchell@lambda.clinic.org	f5aa5dfb3b69801daa60624adcf2010b:7dfb2d27d03513c8c25e8bfa094b77b35f1c6e3b03ef31d651ea81f0e9f336eb4966c1f99bb5a466ab8dfaab0d8eaa15d0b09a248d1cd6f3aef3c6a2b33e7b31	2026-10-17	t
46	1016	brittanylopez@lambda.clinic.org	65bd9889334e8cd415bd4c0598b828d5:d7290c01cf00c8221c8d752d15e6a13422a3aa5d2b481cf21032642e5c0d6fb69a08b1daf05adce1f6aee444df85e0349af64cc3614ab17d1b5ec049fb5c3599	2026-10-17	t
47	1012	rachelkim@lambda.clinic.org	9687a922c258ab366d002ba7e33b737f:9c7ce1ba51ef48ed42e28c9d940a73df06e3d421e968163b21569a2d2155782e228d2dc6528dc66a03017e8f801c496cae458a1a98255c7f7fd609a253f4ca1d	2026-10-17	t
48	1010	kevinnguyen@lambda.clinic.org	36f29665130a8a555a972c1636d583d9:61d15848bafef827b81bbfd4114e3e46d84526d578f6891135ef5ec4e985b4890928a889b594c110a4d5f70b484b98aa20b91e0719120f9418126786d63dd679	2026-10-17	t
49	1007	elenavasquez@lambda.clinic.org	a49ee873eb10f80b24cb1d36466f5b6e:6972a80a6e5856edc107c41e5bd8adffebf71a02682f1c62040a1ee2ec22e2cbebaf493bfeb4ada26701aab7205eb3f13b720d2d201f62b14a05b107c8c63839	2026-10-17	t
50	1005	priyaraman@lambda.clinic.org	c92f443dca12a36094e921a2c312b7fe:305b6244a46793dbd624d1a42f6e1bd5f9bb02fa679e7afe1b584d81dd507414e9ae8db54937e4e43fe1674016ad54ea0d10f4295711250af7c61505098069b0	2026-10-17	t
51	1002	davidokafor@lambda.clinic.org	6493fc39bc3924ca7026028e808f38ca:ee8160e120aeb37cdf3c6c60975645caf1931b88f467f65fcb1e0af75c87a1a16ba1bedeb5fc998c0ee0ec9da65977ad43cdab553e9788d59247cf67c5af465b	2026-10-17	t
43	1004	roberthayes@lambda.clinic.org	d2a08801c63e3f1c51fe9283dd72856f:2d81a9d6e6a7dea167f6400db20914d57be4a5ea19d05ef83b8fedafc9cef0b6c1b53282d31705186837a9446b23c4b212ce07bfbe37d39cb93d04caf612dc55	2026-10-17	t
52	1018	testemployee.edited@lambda.clinic.org	47149938e7772143b6f5e230c93e1096:baf909365ff97e51d57a15ad4123cb05c3fffd45d1b081fbb646e45e9d111e432f6532765c525ef2482fe001109a3184a9f8ccad14442b1e0c031e920644b6f8	2026-10-22	f
53	1019	labtech	70616dbc169841339c37d6a071d5f320:0269eae792906b5fcc8ce5e76a07addca6fc564bc79c03e163a657c5cb3a9ceb64e3de68f296c40769a2de450282a5edd681ec926aed1db3ebda23bcc57384f6	2026-10-24	t
54	1020	deedaniels@lambda.clinic.org	6152b69e2542f92dbcaa119e4fd26848:2cb9093d1c0dd5b29735701566ec2ac67c9946f75e0ce39f0ebfc4766c838d7554303596133cfc1c95e6e22c9041e3161b6fa0b73f66a0aa7e6aa98d7f28aaa2	2026-10-28	t
55	1021	brucebanner@lambda.clinic.org	c1a7e649e3fff43bcdae31d6797cb11a:f0c3eb3a2d427aab06e3388f7389754be5fcbe3897ccbe7653ae4b7d6adc3fcaa271b06f01253fe3cfc28e9d71b8a5642f50435d0215b8764f64a6a2fea8c837	2026-11-05	t
56	1022	hankpym@lambda.clinic.org	a010f3cc7138ccd37a0b49a6d769afc5:4efc141463fbc49d7fdd68ef21a0aed7155dc2bb36f6bd77ca2a68ba92e18e0b9d4308e5fc53c141b1bd21b8c3bcec3cf9f7014a69e417aa315a24a15051b07d	2026-11-05	t
57	1023	stephenstrange@lambda.clinic.org	eb91d31354ae6a483ba23c127b3b0945:58eaddc73f85865454895bdbb7206b3e3424db6b64a49332ae84e8e05fa59bc192b41849e431fd455e06fba727db10f1a9fd720e0231f81535521c75015075dd	2026-11-05	t
58	1024	helencho@lambda.clinic.org	836ea50be8c7483a6c8cf9987af4ac0c:b98d8267e72afbe21b62467b42a0cf84dbab23a8e5fc8bd704d0274990ab9efd96f3cd9a981bfb53966dcb4271bd4dd2df2aacc25a30395d844c5118df9d7884	2026-11-05	t
59	1025	wandamaximoff@lambda.clinic.org	4656545604520197f5de796db1ef8f31:b9991c9b976cb7361f9765f3c5ea6daaf96a12be152a4d1410be96dac93539bc23db127b657407a880ff976134e57291065606638eb0ea6f4bab62a5130a1b0e	2026-11-05	t
60	1026	samwilson@lambda.clinic.org	085c4d56b8d828e3b63e9bc219ac667e:48f53228c204530f42348f59c443c3c882c589629d788775bf99b9fb72452d2046db1b77cac7dc4c48621f07ad5e05966ccf46370e17660039a9b06cc9d74e69	2026-11-05	t
61	1027	hopevandyne@lambda.clinic.org	3306fae6addc057a79644bf9e41af6e5:e138ecafa016390f01853ec6c9270f7d9dc928c88b5832944d52d1dafc5cd8c5c2636ed6960a2244e874fb5b813c59139461ecda740d3dabbde0492b239c7818	2026-11-05	t
62	1028	pepperpotts@lambda.clinic.org	c4cb8f8f57da9268d066c3127a688011:20f717c7ba525e910c6fa3da4432124a08bf744d735bcc13790eeff18e4e689321d66e79ab63e75599ad1e604ab0cdf1f28762beee45c3561865bf1ff4d0a33d	2026-11-05	t
63	1029	happyhogan@lambda.clinic.org	000d60deeb986a6743a7092b6ac8f8e5:5b73e1550d12e077b30d9459ac49e43e65933eb252e371ce9483c3b5555097370534f965f40c3243ad8d44d6160435676110946534faedc31cc4633d6cbbdc09	2026-11-05	t
64	1030	mariahill@lambda.clinic.org	a1719867d93e7e7ef453d3a538862fde:c87e7ef829c4100cd1207e825a9b4231eee79ea1da5a256e3921d00993b3ec4f838259828ca3ca5c3d6752ab29dd9cde43459ae091708f7ab001df616f7e26d4	2026-11-05	t
65	1031	scottlang@lambda.clinic.org	eb7cf62456699d3c9c744125c82f6976:4a925ec205827568497521111baa4e7188e4c46bd97c5427f1f33facb17ad790bd477c1e45686d3d0dc455cec7e33625f0bdb02033382e78ed539a5db882ef45	2026-11-05	t
66	1032	ririwilliams@lambda.clinic.org	05866c23e497497bcd116c1f7c58b82d:d74bcd5d2769e11f3a6dddaf39b5d546a968c2cdee333d3cfd2c11ddbcb1276b5902627d9ddd6406da2e08e036b9546742491146cf0642cee023377b47bfc295	2026-11-05	t
67	1033	nickfury@lambda.clinic.org	841b6c078d244e12087c66a3f3d8f67c:768626e325cc7ddaeff1e8a086e67e76d7dcffee1d6677fb751363212dfffa94a51514c9d6c990cca238054feb3f37e59d69039026235c12041caf710250a8db	2026-11-05	t
68	1034	11111111	193017230fcff0be655349dd5bce0a86:8e011f43df8f7cfb263ccf80ab639e709db449b5d755cdcc5d91094d9d61091e1c316d389dfa912ad1faa274302daf05be37d07a47a99757eafaa1dd29814b5c	2026-11-11	t
69	1035	123123123	847b3a338a5a4069cc19a4d9742f74c2:d71887aaff14ca613d067d29f398ba7a387cb4cb8c1ea29d1fd667bc076162f5ad6ac7c36ccb834f263b920aceb3479f2d3e90f02f7745621bc29ee11dfb7e13	2026-11-12	t
\.


--
-- Data for Name: employee_types; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.employee_types (employee_type_id, type_name, is_active) FROM stdin;
9	Doctor	t
10	Nurse	t
11	Receptionist	t
12	Administrator	t
13	Lab Technician	t
\.


--
-- Data for Name: form_submission; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.form_submission (form_submission_id, patient_id, form_type_id, status, submitted_date) FROM stdin;
2	119	1	Completed	2026-10-15
3	120	1	Completed	2026-10-15
4	121	1	Completed	2026-10-15
5	122	1	Completed	2026-10-15
6	123	1	Completed	2026-10-15
7	124	1	Completed	2026-10-15
8	125	1	Completed	2026-10-15
9	126	1	Completed	2026-10-15
10	127	1	Completed	2026-10-15
11	128	1	Completed	2026-10-15
12	129	1	Completed	2026-10-15
13	119	2	Completed	2026-10-15
14	120	2	Completed	2026-10-15
15	121	2	Completed	2026-10-15
16	122	2	Completed	2026-10-15
17	123	2	Completed	2026-10-15
18	124	2	Completed	2026-10-15
19	125	2	Completed	2026-10-15
20	126	2	Completed	2026-10-15
21	127	2	Completed	2026-10-15
22	128	2	Completed	2026-10-15
23	129	2	Completed	2026-10-15
24	119	3	Completed	2026-10-15
25	120	3	Completed	2026-10-15
26	121	3	Pending	\N
27	122	3	Completed	2026-10-15
28	123	3	Completed	2026-10-15
29	124	3	Completed	2026-10-15
30	125	3	Completed	2026-10-15
31	126	3	Completed	2026-10-15
32	127	3	Pending	\N
33	128	3	Completed	2026-10-15
34	129	3	Completed	2026-10-15
35	110	1	Completed	2026-11-10
36	110	2	Completed	2026-11-10
37	110	3	Completed	2026-11-10
\.


--
-- Data for Name: form_type; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.form_type (form_type_id, name, is_required, is_active) FROM stdin;
1	Consent to Treat	t	t
2	HIPAA Privacy Acknowledgment	t	t
3	Medical History	t	t
4	Patient Satisfaction Survey	f	t
\.


--
-- Data for Name: home_medication; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.home_medication (home_medication_id, patient_id, medication_id, medication_name, category, dosage, frequency, start_date, is_active) FROM stdin;
24	104	2	Metformin	Prescription	500 mg	Twice daily	2025-11-01	t
25	106	3	Atorvastatin	Prescription	20 mg	Once daily	2025-06-15	t
26	106	1	Lisinopril	Prescription	10 mg	Once daily	2025-06-15	t
27	108	4	Amlodipine	Prescription	5 mg	Once daily	2024-09-10	t
28	109	5	Levothyroxine	Prescription	50 mcg	Every morning	2026-10-01	t
29	103	7	Albuterol inhaler	Prescription	2 puffs	As needed	2023-03-20	t
30	110	8	Ibuprofen	OTC	400 mg	As needed for pain	2026-08-01	t
33	114	9	Acetaminophen	Prescription	50mg	twice daily	2026-11-04	t
34	119	\N	Vitamin B12	Supplement	1000 mcg	Once daily	2026-10-16	t
35	128	8	Ibuprofen	OTC	200 mg	As needed	2026-10-29	t
36	129	\N	Fish oil	Supplement	1 capsule	Once daily	2026-10-30	t
37	110	\N	lexapro	Prescription	20	teice daily	2026-11-12	t
\.


--
-- Data for Name: insurance; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.insurance (insurance_id, patient_id, provider, policy_number, status) FROM stdin;
1	1	Test Health	TEST-0001	Pending
9	114	unitedhealth	0000110122	Pending
11	119	Aetna	AET-STARK-001	Verified
12	128	Cigna	CIG-RHODES-002	Verified
13	123	Aetna	AET-BARTON-006	Verified
14	120	Blue Cross Blue Shield	BCBS-ROGERS-003	Pending
15	125	Humana	HUM-DANVERS-004	Pending
16	122	UnitedHealthcare	UHC-ROMANOFF-005	Denied
10	110	blue cross shield	099798668987	Verified
17	101	Demo Health Insurance	Test-123456789	Pending
\.


--
-- Data for Name: invoice; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.invoice (invoice_id, patient_id, appointment_id, amount, issue_date, status) FROM stdin;
1	101	1	150.00	2026-02-11	Paid
2	101	3	320.00	2026-04-09	Paid
3	101	4	175.00	2026-04-16	Paid
4	101	6	210.00	2026-04-24	Paid
5	105	7	280.00	2026-04-27	Paid
6	105	8	150.00	2026-05-01	Overdue
7	101	9	165.00	2026-05-07	Paid
8	104	10	210.00	2026-05-08	Paid
9	105	11	150.00	2026-05-11	Paid
10	101	13	165.00	2026-05-22	Paid
11	101	14	190.00	2026-05-22	Overdue
12	104	15	150.00	2026-05-26	Paid
13	103	16	215.00	2026-05-29	Paid
14	101	17	210.00	2026-05-29	Paid
15	102	18	150.00	2026-06-03	Paid
16	106	20	150.00	2026-06-11	Paid
17	107	21	175.00	2026-06-12	Paid
18	107	23	200.00	2026-06-15	Paid
19	105	24	175.00	2026-06-17	Paid
20	105	25	150.00	2026-07-06	Paid
59	110	78	175.00	2026-10-16	Paid
22	105	29	295.00	2026-07-16	Paid
23	106	30	165.00	2026-07-21	Paid
24	105	31	300.00	2026-07-22	Overdue
25	102	32	215.00	2026-07-29	Paid
26	107	33	320.00	2026-08-04	Paid
27	101	34	210.00	2026-08-04	Paid
28	105	35	215.00	2026-08-04	Paid
29	104	37	190.00	2026-08-10	Paid
30	101	38	190.00	2026-08-17	Paid
31	103	39	175.00	2026-08-25	Paid
32	106	40	325.00	2026-08-28	Paid
33	102	41	320.00	2026-08-28	Paid
34	107	42	175.00	2026-09-01	Paid
35	105	43	250.00	2026-09-01	Paid
36	106	44	175.00	2026-09-01	Paid
37	106	46	250.00	2026-09-03	Paid
38	106	47	210.00	2026-09-03	Paid
39	109	48	300.00	2026-09-07	Paid
40	102	49	240.00	2026-09-08	Paid
41	107	53	280.00	2026-09-11	Pending
42	103	54	265.00	2026-09-11	Paid
43	109	55	190.00	2026-09-17	Paid
44	109	56	210.00	2026-09-17	Paid
45	107	57	175.00	2026-09-18	Paid
46	108	58	190.00	2026-09-22	Paid
47	106	61	240.00	2026-09-25	Pending
48	110	62	150.00	2026-09-25	Paid
49	108	63	360.00	2026-09-28	Pending
50	102	66	190.00	2026-09-30	Pending
51	101	67	175.00	2026-10-01	Pending
52	109	68	250.00	2026-10-01	Paid
53	106	69	235.00	2026-10-02	Paid
54	109	71	190.00	2026-10-05	Pending
55	109	72	305.00	2026-10-06	Pending
56	107	73	315.00	2026-10-07	Paid
57	110	75	165.00	2026-10-13	Paid
58	102	77	150.00	2026-10-14	Pending
60	106	79	210.00	2026-10-19	Pending
61	106	81	175.00	2026-10-19	Paid
62	105	82	280.00	2026-10-20	Paid
63	108	83	210.00	2026-10-21	Pending
239	109	385	150.00	2026-11-12	Pending
315	129	603	300.00	2026-11-12	Pending
75	127	132	150.00	2026-10-15	Paid
76	127	133	165.00	2026-10-15	Pending
77	127	134	195.00	2026-10-15	Paid
64	110	84	190.00	2026-10-21	Paid
21	105	26	340.00	2026-07-08	Paid
70	108	123	195.00	2026-10-15	Pending
71	103	124	150.00	2026-10-15	Pending
72	110	125	168.00	2026-10-15	Paid
73	125	130	175.00	2026-10-15	Pending
74	105	131	175.00	2026-10-15	Pending
78	104	135	345.00	2026-10-15	Pending
79	107	136	250.00	2026-10-15	Pending
80	110	137	250.00	2026-10-15	Paid
81	101	139	150.00	2026-10-16	Paid
82	101	140	150.00	2026-10-16	Pending
83	101	141	150.00	2026-10-16	Pending
84	123	142	150.00	2026-10-16	Paid
85	106	143	175.00	2026-10-16	Pending
86	119	144	175.00	2026-10-16	Paid
87	114	145	175.00	2026-10-16	Paid
316	129	398	25.00	2026-11-13	Pending
88	125	147	220.00	2026-10-16	Pending
89	125	148	175.00	2026-10-16	Pending
317	114	403	25.00	2026-11-13	Pending
90	120	149	150.00	2026-10-16	Pending
240	101	85	365.00	2026-10-23	Paid
318	103	405	25.00	2026-11-13	Pending
91	105	150	200.00	2026-10-16	Paid
241	107	108	150.00	2026-10-26	Paid
92	120	152	345.00	2026-10-16	Pending
319	120	411	25.00	2026-11-13	Pending
242	106	87	150.00	2026-10-26	Pending
93	109	155	158.00	2026-10-19	Paid
94	126	157	150.00	2026-10-19	Pending
320	110	563	25.00	2026-11-13	Paid
243	114	111	210.00	2026-10-28	Paid
95	119	158	183.00	2026-10-19	Paid
96	125	159	230.00	2026-10-19	Pending
244	114	112	156.00	2026-10-28	Paid
97	120	162	170.00	2026-10-19	Paid
245	114	113	158.00	2026-10-28	Pending
98	120	163	210.00	2026-10-19	Pending
99	127	164	200.00	2026-10-19	Paid
246	106	88	175.00	2026-10-28	Paid
247	113	110	175.00	2026-10-29	Paid
100	119	165	258.00	2026-10-19	Paid
101	119	166	300.00	2026-10-19	Paid
248	109	90	195.00	2026-10-29	Paid
102	105	167	290.00	2026-10-19	Paid
103	103	168	150.00	2026-10-20	Paid
104	107	170	170.00	2026-10-20	Pending
249	110	115	170.00	2026-10-30	Paid
105	129	171	150.00	2026-10-20	Paid
250	118	117	175.00	2026-10-30	Paid
106	129	172	175.00	2026-10-20	Paid
251	118	331	150.00	2026-11-05	Pending
107	119	173	197.00	2026-10-20	Paid
252	117	330	170.00	2026-11-05	Paid
108	113	174	175.00	2026-10-20	Paid
253	114	332	175.00	2026-11-05	Paid
109	104	175	215.00	2026-10-20	Pending
110	127	176	175.00	2026-10-20	Pending
254	117	329	150.00	2026-11-05	Pending
111	106	181	352.00	2026-10-20	Pending
255	103	328	150.00	2026-11-05	Pending
112	107	182	190.00	2026-10-21	Pending
256	114	337	250.00	2026-11-05	Pending
113	105	185	218.00	2026-10-21	Pending
114	109	187	150.00	2026-10-21	Pending
257	112	340	210.00	2026-11-06	Pending
115	114	189	175.00	2026-10-21	Paid
258	118	342	183.00	2026-11-06	Paid
116	125	191	190.00	2026-10-21	Paid
117	113	193	183.00	2026-10-21	Paid
259	123	344	248.00	2026-11-06	Paid
260	123	341	150.00	2026-11-06	Paid
261	127	347	352.00	2026-11-06	Pending
262	108	343	200.00	2026-11-06	Pending
118	124	194	221.00	2026-10-21	Paid
119	121	195	210.00	2026-10-21	Paid
263	110	548	156.00	2026-11-06	Paid
120	108	196	250.00	2026-10-21	Paid
264	124	356	275.00	2026-11-09	Pending
265	127	354	150.00	2026-11-09	Paid
121	119	197	372.00	2026-10-21	Paid
266	101	359	270.00	2026-11-09	Pending
122	105	198	225.00	2026-10-21	Paid
267	118	351	150.00	2026-11-09	Paid
123	126	199	345.00	2026-10-21	Paid
268	108	358	300.00	2026-11-09	Paid
124	109	201	150.00	2026-10-22	Paid
125	105	202	158.00	2026-10-22	Paid
269	119	353	230.00	2026-11-09	Paid
126	123	203	200.00	2026-10-22	Paid
270	101	349	158.00	2026-11-09	Paid
127	106	204	175.00	2026-10-22	Paid
128	115	205	181.00	2026-10-22	Paid
271	110	550	240.00	2026-11-09	Paid
129	119	206	240.00	2026-10-22	Paid
272	110	549	235.00	2026-11-09	Paid
130	113	207	197.00	2026-10-22	Paid
131	120	208	150.00	2026-10-22	Paid
273	115	352	230.00	2026-11-09	Paid
132	114	209	225.00	2026-10-22	Pending
274	116	357	250.00	2026-11-09	Pending
133	129	210	250.00	2026-10-22	Paid
275	105	363	150.00	2026-11-10	Pending
134	106	211	275.00	2026-10-22	Paid
135	109	213	150.00	2026-10-23	Paid
276	114	364	175.00	2026-11-10	Paid
136	115	215	175.00	2026-10-23	Paid
277	112	368	150.00	2026-11-10	Pending
137	113	216	248.00	2026-10-23	Paid
138	125	217	197.00	2026-10-23	Pending
278	123	369	345.00	2026-11-10	Paid
139	106	219	245.00	2026-10-23	Paid
140	104	220	250.00	2026-10-23	Pending
279	101	93	175.00	2026-11-10	Pending
141	105	223	162.00	2026-10-26	Pending
142	119	224	175.00	2026-10-26	Paid
280	104	370	225.00	2026-11-10	Paid
143	129	225	200.00	2026-10-26	Paid
281	120	367	150.00	2026-11-10	Pending
144	102	226	175.00	2026-10-26	Pending
282	120	366	175.00	2026-11-10	Pending
145	125	227	193.00	2026-10-26	Pending
283	120	362	210.00	2026-11-10	Paid
146	127	228	172.00	2026-10-26	Pending
155	110	238	156.00	2026-10-27	Paid
163	101	246	200.00	2026-10-27	Paid
147	126	229	325.00	2026-10-26	Pending
148	125	230	310.00	2026-10-26	Pending
284	110	551	245.00	2026-11-10	Paid
149	103	231	250.00	2026-10-26	Pending
150	129	232	300.00	2026-10-26	Paid
285	103	94	345.00	2026-11-10	Paid
151	109	233	250.00	2026-10-26	Pending
152	105	234	365.00	2026-10-26	Pending
153	101	235	150.00	2026-10-27	Paid
286	123	361	190.00	2026-11-10	Paid
154	126	236	150.00	2026-10-27	Paid
156	104	239	197.00	2026-10-27	Pending
287	110	553	215.00	2026-11-10	Paid
157	1	240	235.00	2026-10-27	Paid
288	110	552	150.00	2026-11-10	Paid
158	113	241	225.00	2026-10-27	Pending
159	125	242	245.00	2026-10-27	Pending
289	110	556	175.00	2026-11-10	Paid
160	120	243	150.00	2026-10-27	Pending
161	121	244	150.00	2026-10-27	Paid
290	129	371	365.00	2026-11-10	Pending
162	120	245	333.00	2026-10-27	Pending
291	103	360	172.00	2026-11-10	Pending
164	108	247	305.00	2026-10-27	Pending
292	122	365	225.00	2026-11-10	Pending
165	113	248	322.00	2026-10-27	Paid
293	111	375	175.00	2026-11-11	Pending
166	126	249	275.00	2026-10-27	Paid
167	116	250	150.00	2026-10-28	Paid
294	110	558	183.00	2026-11-11	Paid
295	125	377	225.00	2026-11-11	Paid
168	119	251	233.00	2026-10-28	Paid
169	110	252	150.00	2026-10-28	Paid
296	129	379	206.00	2026-11-11	Pending
170	109	253	156.00	2026-10-28	Paid
297	120	378	233.00	2026-11-11	Pending
171	118	254	225.00	2026-10-28	Pending
172	104	255	200.00	2026-10-28	Paid
298	101	380	400.00	2026-11-11	Paid
173	119	256	175.00	2026-10-28	Paid
299	131	575	175.00	2026-11-11	Pending
174	114	257	175.00	2026-10-28	Paid
300	125	376	175.00	2026-11-11	Pending
175	103	258	195.00	2026-10-28	Pending
176	120	259	158.00	2026-10-28	Pending
177	124	260	162.00	2026-10-28	Pending
301	105	373	220.00	2026-11-11	Pending
302	130	559	175.00	2026-11-11	Pending
303	113	394	372.00	2026-11-12	Pending
304	110	576	175.00	2026-11-12	Paid
305	110	577	150.00	2026-11-12	Paid
208	110	299	200.00	2026-11-02	Paid
306	114	387	175.00	2026-11-12	Pending
178	116	261	275.00	2026-10-28	Paid
307	132	584	150.00	2026-11-12	Paid
179	123	263	275.00	2026-10-28	Paid
308	104	390	150.00	2026-11-12	Pending
180	102	264	322.00	2026-10-28	Paid
309	107	392	225.00	2026-11-12	Pending
181	124	265	312.00	2026-10-28	Pending
182	109	266	150.00	2026-10-29	Pending
183	112	267	150.00	2026-10-29	Pending
310	126	396	345.00	2026-11-12	Pending
184	118	269	172.00	2026-10-29	Pending
311	104	388	175.00	2026-11-12	Pending
185	109	270	195.00	2026-10-29	Paid
312	128	391	275.00	2026-11-12	Paid
186	114	271	175.00	2026-10-29	Paid
187	106	272	175.00	2026-10-29	Pending
313	112	381	156.00	2026-11-12	Pending
188	115	273	175.00	2026-10-29	Pending
314	111	393	295.00	2026-11-12	Paid
189	116	274	230.00	2026-10-29	Pending
190	127	275	168.00	2026-10-29	Paid
191	124	276	168.00	2026-10-29	Pending
192	114	278	206.00	2026-10-29	Pending
193	104	279	295.00	2026-10-29	Pending
194	108	280	156.00	2026-10-30	Paid
195	123	281	150.00	2026-10-30	Paid
196	123	282	165.00	2026-10-30	Paid
197	120	283	213.00	2026-10-30	Pending
198	114	284	215.00	2026-10-30	Pending
199	104	286	175.00	2026-10-30	Pending
200	125	288	250.00	2026-10-30	Paid
201	113	289	320.00	2026-10-30	Paid
202	116	290	150.00	2026-11-02	Pending
203	101	292	220.00	2026-11-02	Pending
204	118	293	150.00	2026-11-02	Pending
205	126	295	150.00	2026-11-02	Pending
206	115	296	175.00	2026-11-02	Paid
207	118	297	215.00	2026-11-02	Pending
209	111	300	150.00	2026-11-02	Pending
237	104	336	255.00	2026-11-05	Paid
234	113	333	220.00	2026-11-05	Paid
210	103	301	208.00	2026-11-02	Paid
211	107	302	325.00	2026-11-02	Pending
212	126	303	365.00	2026-11-02	Pending
213	103	304	270.00	2026-11-02	Pending
214	114	305	300.00	2026-11-02	Pending
215	129	307	175.00	2026-11-03	Paid
216	129	308	150.00	2026-11-03	Paid
217	118	309	150.00	2026-11-03	Paid
218	104	310	175.00	2026-11-03	Paid
219	104	311	235.00	2026-11-03	Paid
220	104	312	230.00	2026-11-03	Paid
221	125	313	175.00	2026-11-03	Paid
222	111	314	183.00	2026-11-03	Pending
223	121	315	150.00	2026-11-03	Pending
224	124	316	400.00	2026-11-03	Pending
225	103	318	150.00	2026-11-04	Pending
226	105	319	150.00	2026-11-04	Pending
227	123	320	175.00	2026-11-04	Paid
228	116	321	175.00	2026-11-04	Pending
229	113	322	175.00	2026-11-04	Pending
230	128	324	158.00	2026-11-04	Paid
231	116	325	300.00	2026-11-04	Pending
232	106	326	275.00	2026-11-04	Pending
233	119	327	275.00	2026-11-04	Paid
235	125	334	175.00	2026-11-05	Paid
236	120	335	156.00	2026-11-05	Paid
238	112	338	247.00	2026-11-05	Paid
\.


--
-- Data for Name: invoice_item; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.invoice_item (invoice_item_id, invoice_id, fee_id, category, description, price, lab_order_id, prescription_item_id, created_at) FROM stdin;
1	1	\N	Visit	Visit (billed before itemized fees)	150.00	\N	\N	2026-02-11 00:00:00+00
2	2	\N	Visit	Visit (billed before itemized fees)	320.00	\N	\N	2026-04-09 00:00:00+00
3	3	\N	Visit	Visit (billed before itemized fees)	175.00	\N	\N	2026-04-16 00:00:00+00
4	4	\N	Visit	Visit (billed before itemized fees)	210.00	\N	\N	2026-04-24 00:00:00+00
5	5	\N	Visit	Visit (billed before itemized fees)	280.00	\N	\N	2026-04-27 00:00:00+00
6	6	\N	Visit	Visit (billed before itemized fees)	150.00	\N	\N	2026-05-01 00:00:00+00
7	7	\N	Visit	Visit (billed before itemized fees)	165.00	\N	\N	2026-05-07 00:00:00+00
8	8	\N	Visit	Visit (billed before itemized fees)	210.00	\N	\N	2026-05-08 00:00:00+00
9	9	\N	Visit	Visit (billed before itemized fees)	150.00	\N	\N	2026-05-11 00:00:00+00
10	10	\N	Visit	Visit (billed before itemized fees)	165.00	\N	\N	2026-05-22 00:00:00+00
11	11	\N	Visit	Visit (billed before itemized fees)	190.00	\N	\N	2026-05-22 00:00:00+00
12	12	\N	Visit	Visit (billed before itemized fees)	150.00	\N	\N	2026-05-26 00:00:00+00
13	13	\N	Visit	Visit (billed before itemized fees)	215.00	\N	\N	2026-05-29 00:00:00+00
14	14	\N	Visit	Visit (billed before itemized fees)	210.00	\N	\N	2026-05-29 00:00:00+00
15	15	\N	Visit	Visit (billed before itemized fees)	150.00	\N	\N	2026-06-03 00:00:00+00
16	16	\N	Visit	Visit (billed before itemized fees)	150.00	\N	\N	2026-06-11 00:00:00+00
17	17	\N	Visit	Visit (billed before itemized fees)	175.00	\N	\N	2026-06-12 00:00:00+00
18	18	\N	Visit	Visit (billed before itemized fees)	200.00	\N	\N	2026-06-15 00:00:00+00
19	19	\N	Visit	Visit (billed before itemized fees)	175.00	\N	\N	2026-06-17 00:00:00+00
20	20	\N	Visit	Visit (billed before itemized fees)	150.00	\N	\N	2026-07-06 00:00:00+00
21	21	\N	Visit	Visit (billed before itemized fees)	340.00	\N	\N	2026-07-08 00:00:00+00
22	22	\N	Visit	Visit (billed before itemized fees)	295.00	\N	\N	2026-07-16 00:00:00+00
23	23	\N	Visit	Visit (billed before itemized fees)	165.00	\N	\N	2026-07-21 00:00:00+00
24	24	\N	Visit	Visit (billed before itemized fees)	300.00	\N	\N	2026-07-22 00:00:00+00
25	25	\N	Visit	Visit (billed before itemized fees)	215.00	\N	\N	2026-07-29 00:00:00+00
26	26	\N	Visit	Visit (billed before itemized fees)	320.00	\N	\N	2026-08-04 00:00:00+00
27	27	\N	Visit	Visit (billed before itemized fees)	210.00	\N	\N	2026-08-04 00:00:00+00
28	28	\N	Visit	Visit (billed before itemized fees)	215.00	\N	\N	2026-08-04 00:00:00+00
29	29	\N	Visit	Visit (billed before itemized fees)	190.00	\N	\N	2026-08-10 00:00:00+00
30	30	\N	Visit	Visit (billed before itemized fees)	190.00	\N	\N	2026-08-17 00:00:00+00
31	31	\N	Visit	Visit (billed before itemized fees)	175.00	\N	\N	2026-08-25 00:00:00+00
32	32	\N	Visit	Visit (billed before itemized fees)	325.00	\N	\N	2026-08-28 00:00:00+00
33	33	\N	Visit	Visit (billed before itemized fees)	320.00	\N	\N	2026-08-28 00:00:00+00
34	34	\N	Visit	Visit (billed before itemized fees)	175.00	\N	\N	2026-09-01 00:00:00+00
35	35	\N	Visit	Visit (billed before itemized fees)	250.00	\N	\N	2026-09-01 00:00:00+00
36	36	\N	Visit	Visit (billed before itemized fees)	175.00	\N	\N	2026-09-01 00:00:00+00
37	37	\N	Visit	Visit (billed before itemized fees)	250.00	\N	\N	2026-09-03 00:00:00+00
38	38	\N	Visit	Visit (billed before itemized fees)	210.00	\N	\N	2026-09-03 00:00:00+00
39	39	\N	Visit	Visit (billed before itemized fees)	300.00	\N	\N	2026-09-07 00:00:00+00
40	40	\N	Visit	Visit (billed before itemized fees)	240.00	\N	\N	2026-09-08 00:00:00+00
41	41	\N	Visit	Visit (billed before itemized fees)	280.00	\N	\N	2026-09-11 00:00:00+00
42	42	\N	Visit	Visit (billed before itemized fees)	265.00	\N	\N	2026-09-11 00:00:00+00
43	43	\N	Visit	Visit (billed before itemized fees)	190.00	\N	\N	2026-09-17 00:00:00+00
44	44	\N	Visit	Visit (billed before itemized fees)	210.00	\N	\N	2026-09-17 00:00:00+00
45	45	\N	Visit	Visit (billed before itemized fees)	175.00	\N	\N	2026-09-18 00:00:00+00
46	46	\N	Visit	Visit (billed before itemized fees)	190.00	\N	\N	2026-09-22 00:00:00+00
47	47	\N	Visit	Visit (billed before itemized fees)	240.00	\N	\N	2026-09-25 00:00:00+00
48	48	\N	Visit	Visit (billed before itemized fees)	150.00	\N	\N	2026-09-25 00:00:00+00
49	49	\N	Visit	Visit (billed before itemized fees)	360.00	\N	\N	2026-09-28 00:00:00+00
50	50	\N	Visit	Visit (billed before itemized fees)	190.00	\N	\N	2026-09-30 00:00:00+00
51	51	\N	Visit	Visit (billed before itemized fees)	175.00	\N	\N	2026-10-01 00:00:00+00
52	52	\N	Visit	Visit (billed before itemized fees)	250.00	\N	\N	2026-10-01 00:00:00+00
53	53	\N	Visit	Visit (billed before itemized fees)	235.00	\N	\N	2026-10-02 00:00:00+00
54	54	\N	Visit	Visit (billed before itemized fees)	190.00	\N	\N	2026-10-05 00:00:00+00
55	55	\N	Visit	Visit (billed before itemized fees)	305.00	\N	\N	2026-10-06 00:00:00+00
56	56	\N	Visit	Visit (billed before itemized fees)	315.00	\N	\N	2026-10-07 00:00:00+00
57	57	\N	Visit	Visit (billed before itemized fees)	165.00	\N	\N	2026-10-13 00:00:00+00
58	58	\N	Visit	Visit (billed before itemized fees)	150.00	\N	\N	2026-10-14 00:00:00+00
59	59	\N	Visit	Visit (billed before itemized fees)	175.00	\N	\N	2026-10-16 00:00:00+00
60	60	\N	Visit	Visit (billed before itemized fees)	210.00	\N	\N	2026-10-19 00:00:00+00
61	61	\N	Visit	Visit (billed before itemized fees)	175.00	\N	\N	2026-10-19 00:00:00+00
62	62	\N	Visit	Visit (billed before itemized fees)	280.00	\N	\N	2026-10-20 00:00:00+00
63	63	\N	Visit	Visit (billed before itemized fees)	210.00	\N	\N	2026-10-21 00:00:00+00
64	64	\N	Visit	Visit (billed before itemized fees)	190.00	\N	\N	2026-10-21 00:00:00+00
69	70	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
70	70	8	Lab Test	Complete Blood Count	45.00	54	\N	2026-11-05 22:26:29.874258+00
71	71	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
72	72	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
73	72	19	Medication	Levothyroxine (25 mcg once daily)	18.00	\N	29	2026-11-05 22:26:29.874258+00
74	73	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
75	74	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
76	75	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
77	76	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
78	76	15	Medication	Lisinopril (10 mg once daily)	15.00	\N	30	2026-11-05 22:26:29.874258+00
79	77	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
80	77	21	Medication	Albuterol inhaler (2 puffs as needed)	45.00	\N	31	2026-11-05 22:26:29.874258+00
81	78	3	Visit	Cardiology visit	275.00	\N	\N	2026-11-05 22:26:29.874258+00
82	78	12	Lab Test	Thyroid Panel (TSH)	50.00	55	\N	2026-11-05 22:26:29.874258+00
83	78	17	Medication	Atorvastatin (20 mg once daily)	20.00	\N	32	2026-11-05 22:26:29.874258+00
84	79	4	Visit	Dermatology visit	200.00	\N	\N	2026-11-05 22:26:29.874258+00
85	79	12	Lab Test	Thyroid Panel (TSH)	50.00	56	\N	2026-11-05 22:26:29.874258+00
86	80	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-05 22:26:29.874258+00
87	81	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
88	82	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
89	83	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
90	84	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
91	85	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
92	86	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
93	87	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
94	88	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
95	88	21	Medication	Albuterol inhaler (2 puffs as needed)	45.00	\N	33	2026-11-05 22:26:29.874258+00
96	89	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
97	90	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
98	91	4	Visit	Dermatology visit	200.00	\N	\N	2026-11-05 22:26:29.874258+00
99	92	6	Visit	Neurology visit	300.00	\N	\N	2026-11-05 22:26:29.874258+00
100	92	21	Medication	Albuterol inhaler (2 puffs as needed)	45.00	\N	34	2026-11-05 22:26:29.874258+00
101	93	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
102	93	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	35	2026-11-05 22:26:29.874258+00
103	94	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
104	95	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
105	95	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	36	2026-11-05 22:26:29.874258+00
106	96	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
107	96	9	Lab Test	Basic Metabolic Panel	55.00	57	\N	2026-11-05 22:26:29.874258+00
108	97	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
109	97	17	Medication	Atorvastatin (20 mg once daily)	20.00	\N	37	2026-11-05 22:26:29.874258+00
110	98	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
111	98	10	Lab Test	Lipid Panel	60.00	58	\N	2026-11-05 22:26:29.874258+00
112	99	4	Visit	Dermatology visit	200.00	\N	\N	2026-11-05 22:26:29.874258+00
113	100	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-05 22:26:29.874258+00
114	100	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	38	2026-11-05 22:26:29.874258+00
115	101	6	Visit	Neurology visit	300.00	\N	\N	2026-11-05 22:26:29.874258+00
116	102	7	Visit	Endocrinology visit	225.00	\N	\N	2026-11-05 22:26:29.874258+00
117	102	14	Lab Test	Vitamin D	65.00	59	\N	2026-11-05 22:26:29.874258+00
118	103	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
119	104	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
120	104	17	Medication	Atorvastatin (20 mg once daily)	20.00	\N	39	2026-11-05 22:26:29.874258+00
121	105	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
122	106	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
123	106	13	Lab Test	Urinalysis	25.00	60	\N	2026-11-05 22:26:29.874258+00
124	107	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
125	107	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	40	2026-11-05 22:26:29.874258+00
126	108	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
127	109	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
128	109	14	Lab Test	Vitamin D	65.00	61	\N	2026-11-05 22:26:29.874258+00
129	110	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
130	110	13	Lab Test	Urinalysis	25.00	62	\N	2026-11-05 22:26:29.874258+00
131	111	3	Visit	Cardiology visit	275.00	\N	\N	2026-11-05 22:26:29.874258+00
132	111	9	Lab Test	Basic Metabolic Panel	55.00	63	\N	2026-11-05 22:26:29.874258+00
133	111	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	41	2026-11-05 22:26:29.874258+00
134	112	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
135	112	11	Lab Test	Hemoglobin A1c	40.00	64	\N	2026-11-05 22:26:29.874258+00
136	113	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
137	113	10	Lab Test	Lipid Panel	60.00	65	\N	2026-11-05 22:26:29.874258+00
138	113	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	42	2026-11-05 22:26:29.874258+00
139	114	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
140	115	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
141	116	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
142	116	15	Medication	Lisinopril (10 mg once daily)	15.00	\N	43	2026-11-05 22:26:29.874258+00
143	117	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
144	117	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	44	2026-11-05 22:26:29.874258+00
145	118	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
146	118	14	Lab Test	Vitamin D	65.00	66	\N	2026-11-05 22:26:29.874258+00
147	118	23	Medication	Acetaminophen (500 mg as needed)	6.00	\N	45	2026-11-05 22:26:29.874258+00
148	119	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
149	119	10	Lab Test	Lipid Panel	60.00	67	\N	2026-11-05 22:26:29.874258+00
150	120	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-05 22:26:29.874258+00
151	121	6	Visit	Neurology visit	300.00	\N	\N	2026-11-05 22:26:29.874258+00
152	121	12	Lab Test	Thyroid Panel (TSH)	50.00	68	\N	2026-11-05 22:26:29.874258+00
153	121	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	46	2026-11-05 22:26:29.874258+00
154	122	7	Visit	Endocrinology visit	225.00	\N	\N	2026-11-05 22:26:29.874258+00
155	123	6	Visit	Neurology visit	300.00	\N	\N	2026-11-05 22:26:29.874258+00
156	123	21	Medication	Albuterol inhaler (2 puffs as needed)	45.00	\N	47	2026-11-05 22:26:29.874258+00
157	124	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
158	125	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
159	125	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	48	2026-11-05 22:26:29.874258+00
160	126	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
161	126	12	Lab Test	Thyroid Panel (TSH)	50.00	69	\N	2026-11-05 22:26:29.874258+00
162	127	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
163	128	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
164	128	23	Medication	Acetaminophen (500 mg as needed)	6.00	\N	49	2026-11-05 22:26:29.874258+00
165	129	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
166	129	14	Lab Test	Vitamin D	65.00	70	\N	2026-11-05 22:26:29.874258+00
167	130	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
168	130	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	50	2026-11-05 22:26:29.874258+00
169	131	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
170	132	4	Visit	Dermatology visit	200.00	\N	\N	2026-11-05 22:26:29.874258+00
171	132	13	Lab Test	Urinalysis	25.00	71	\N	2026-11-05 22:26:29.874258+00
172	133	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-05 22:26:29.874258+00
173	134	3	Visit	Cardiology visit	275.00	\N	\N	2026-11-05 22:26:29.874258+00
174	135	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
175	136	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
176	137	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
177	137	14	Lab Test	Vitamin D	65.00	72	\N	2026-11-05 22:26:29.874258+00
178	137	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	51	2026-11-05 22:26:29.874258+00
179	138	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
180	138	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	52	2026-11-05 22:26:29.874258+00
181	139	4	Visit	Dermatology visit	200.00	\N	\N	2026-11-05 22:26:29.874258+00
182	139	21	Medication	Albuterol inhaler (2 puffs as needed)	45.00	\N	53	2026-11-05 22:26:29.874258+00
183	140	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-05 22:26:29.874258+00
184	141	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
185	141	16	Medication	Metformin (500 mg twice daily)	12.00	\N	54	2026-11-05 22:26:29.874258+00
186	142	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
187	143	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
188	143	13	Lab Test	Urinalysis	25.00	73	\N	2026-11-05 22:26:29.874258+00
189	144	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
190	145	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
191	145	19	Medication	Levothyroxine (25 mcg once daily)	18.00	\N	55	2026-11-05 22:26:29.874258+00
192	146	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
193	146	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	56	2026-11-05 22:26:29.874258+00
194	147	3	Visit	Cardiology visit	275.00	\N	\N	2026-11-05 22:26:29.874258+00
195	147	12	Lab Test	Thyroid Panel (TSH)	50.00	74	\N	2026-11-05 22:26:29.874258+00
196	148	4	Visit	Dermatology visit	200.00	\N	\N	2026-11-05 22:26:29.874258+00
197	148	14	Lab Test	Vitamin D	65.00	75	\N	2026-11-05 22:26:29.874258+00
198	148	21	Medication	Albuterol inhaler (2 puffs as needed)	45.00	\N	57	2026-11-05 22:26:29.874258+00
199	149	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-05 22:26:29.874258+00
200	150	6	Visit	Neurology visit	300.00	\N	\N	2026-11-05 22:26:29.874258+00
201	151	7	Visit	Endocrinology visit	225.00	\N	\N	2026-11-05 22:26:29.874258+00
202	151	13	Lab Test	Urinalysis	25.00	76	\N	2026-11-05 22:26:29.874258+00
203	152	6	Visit	Neurology visit	300.00	\N	\N	2026-11-05 22:26:29.874258+00
204	152	14	Lab Test	Vitamin D	65.00	77	\N	2026-11-05 22:26:29.874258+00
205	153	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
206	154	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
207	155	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
208	155	23	Medication	Acetaminophen (500 mg as needed)	6.00	\N	58	2026-11-05 22:26:29.874258+00
209	156	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
210	156	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	59	2026-11-05 22:26:29.874258+00
211	157	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
212	157	10	Lab Test	Lipid Panel	60.00	78	\N	2026-11-05 22:26:29.874258+00
213	158	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
214	158	12	Lab Test	Thyroid Panel (TSH)	50.00	79	\N	2026-11-05 22:26:29.874258+00
215	159	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
216	159	13	Lab Test	Urinalysis	25.00	80	\N	2026-11-05 22:26:29.874258+00
217	159	21	Medication	Albuterol inhaler (2 puffs as needed)	45.00	\N	60	2026-11-05 22:26:29.874258+00
218	160	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
219	161	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
220	162	3	Visit	Cardiology visit	275.00	\N	\N	2026-11-05 22:26:29.874258+00
221	162	11	Lab Test	Hemoglobin A1c	40.00	81	\N	2026-11-05 22:26:29.874258+00
222	162	19	Medication	Levothyroxine (25 mcg once daily)	18.00	\N	61	2026-11-05 22:26:29.874258+00
223	163	4	Visit	Dermatology visit	200.00	\N	\N	2026-11-05 22:26:29.874258+00
224	164	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-05 22:26:29.874258+00
225	164	9	Lab Test	Basic Metabolic Panel	55.00	82	\N	2026-11-05 22:26:29.874258+00
226	165	6	Visit	Neurology visit	300.00	\N	\N	2026-11-05 22:26:29.874258+00
227	165	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	62	2026-11-05 22:26:29.874258+00
228	166	3	Visit	Cardiology visit	275.00	\N	\N	2026-11-05 22:26:29.874258+00
229	167	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
230	168	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
231	168	14	Lab Test	Vitamin D	65.00	83	\N	2026-11-05 22:26:29.874258+00
232	168	19	Medication	Levothyroxine (25 mcg once daily)	18.00	\N	63	2026-11-05 22:26:29.874258+00
233	169	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
234	170	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
235	170	23	Medication	Acetaminophen (500 mg as needed)	6.00	\N	64	2026-11-05 22:26:29.874258+00
236	171	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
237	171	9	Lab Test	Basic Metabolic Panel	55.00	84	\N	2026-11-05 22:26:29.874258+00
238	171	17	Medication	Atorvastatin (20 mg once daily)	20.00	\N	65	2026-11-05 22:26:29.874258+00
239	172	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
240	172	13	Lab Test	Urinalysis	25.00	85	\N	2026-11-05 22:26:29.874258+00
241	173	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
242	174	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
243	175	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
244	175	17	Medication	Atorvastatin (20 mg once daily)	20.00	\N	66	2026-11-05 22:26:29.874258+00
245	176	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
246	176	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	67	2026-11-05 22:26:29.874258+00
247	177	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
248	177	16	Medication	Metformin (500 mg twice daily)	12.00	\N	68	2026-11-05 22:26:29.874258+00
249	178	3	Visit	Cardiology visit	275.00	\N	\N	2026-11-05 22:26:29.874258+00
250	179	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-05 22:26:29.874258+00
251	179	13	Lab Test	Urinalysis	25.00	86	\N	2026-11-05 22:26:29.874258+00
252	180	6	Visit	Neurology visit	300.00	\N	\N	2026-11-05 22:26:29.874258+00
253	180	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	69	2026-11-05 22:26:29.874258+00
254	181	6	Visit	Neurology visit	300.00	\N	\N	2026-11-05 22:26:29.874258+00
255	181	16	Medication	Metformin (500 mg twice daily)	12.00	\N	70	2026-11-05 22:26:29.874258+00
256	182	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
257	183	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
258	184	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
259	184	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	71	2026-11-05 22:26:29.874258+00
260	185	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
261	185	13	Lab Test	Urinalysis	25.00	87	\N	2026-11-05 22:26:29.874258+00
262	185	17	Medication	Atorvastatin (20 mg once daily)	20.00	\N	72	2026-11-05 22:26:29.874258+00
263	186	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
264	187	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
265	188	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
266	189	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
267	189	9	Lab Test	Basic Metabolic Panel	55.00	88	\N	2026-11-05 22:26:29.874258+00
268	190	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
269	190	19	Medication	Levothyroxine (25 mcg once daily)	18.00	\N	73	2026-11-05 22:26:29.874258+00
270	191	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
271	191	19	Medication	Levothyroxine (25 mcg once daily)	18.00	\N	74	2026-11-05 22:26:29.874258+00
272	192	4	Visit	Dermatology visit	200.00	\N	\N	2026-11-05 22:26:29.874258+00
273	192	23	Medication	Acetaminophen (500 mg as needed)	6.00	\N	75	2026-11-05 22:26:29.874258+00
274	193	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-05 22:26:29.874258+00
275	193	8	Lab Test	Complete Blood Count	45.00	89	\N	2026-11-05 22:26:29.874258+00
276	194	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
277	194	23	Medication	Acetaminophen (500 mg as needed)	6.00	\N	76	2026-11-05 22:26:29.874258+00
278	195	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
279	196	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
280	196	15	Medication	Lisinopril (10 mg once daily)	15.00	\N	77	2026-11-05 22:26:29.874258+00
281	197	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
282	197	8	Lab Test	Complete Blood Count	45.00	90	\N	2026-11-05 22:26:29.874258+00
283	197	19	Medication	Levothyroxine (25 mcg once daily)	18.00	\N	78	2026-11-05 22:26:29.874258+00
284	198	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
285	198	11	Lab Test	Hemoglobin A1c	40.00	91	\N	2026-11-05 22:26:29.874258+00
286	199	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
287	200	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-05 22:26:29.874258+00
288	201	3	Visit	Cardiology visit	275.00	\N	\N	2026-11-05 22:26:29.874258+00
289	201	8	Lab Test	Complete Blood Count	45.00	92	\N	2026-11-05 22:26:29.874258+00
290	202	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
291	203	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
292	203	9	Lab Test	Basic Metabolic Panel	55.00	93	\N	2026-11-05 22:26:29.874258+00
293	203	15	Medication	Lisinopril (10 mg once daily)	15.00	\N	79	2026-11-05 22:26:29.874258+00
294	204	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
295	205	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
296	206	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
297	207	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
298	207	11	Lab Test	Hemoglobin A1c	40.00	94	\N	2026-11-05 22:26:29.874258+00
299	208	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
300	208	13	Lab Test	Urinalysis	25.00	95	\N	2026-11-05 22:26:29.874258+00
301	209	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
302	210	4	Visit	Dermatology visit	200.00	\N	\N	2026-11-05 22:26:29.874258+00
303	210	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	80	2026-11-05 22:26:29.874258+00
304	211	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-05 22:26:29.874258+00
305	211	10	Lab Test	Lipid Panel	60.00	96	\N	2026-11-05 22:26:29.874258+00
306	211	15	Medication	Lisinopril (10 mg once daily)	15.00	\N	81	2026-11-05 22:26:29.874258+00
307	212	6	Visit	Neurology visit	300.00	\N	\N	2026-11-05 22:26:29.874258+00
308	212	14	Lab Test	Vitamin D	65.00	97	\N	2026-11-05 22:26:29.874258+00
309	213	7	Visit	Endocrinology visit	225.00	\N	\N	2026-11-05 22:26:29.874258+00
310	213	8	Lab Test	Complete Blood Count	45.00	98	\N	2026-11-05 22:26:29.874258+00
311	214	6	Visit	Neurology visit	300.00	\N	\N	2026-11-05 22:26:29.874258+00
312	215	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
313	215	13	Lab Test	Urinalysis	25.00	99	\N	2026-11-05 22:26:29.874258+00
314	216	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
315	217	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
316	218	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
317	219	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
318	219	10	Lab Test	Lipid Panel	60.00	100	\N	2026-11-05 22:26:29.874258+00
319	220	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
320	220	9	Lab Test	Basic Metabolic Panel	55.00	101	\N	2026-11-05 22:26:29.874258+00
321	221	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
322	222	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
323	222	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	82	2026-11-05 22:26:29.874258+00
324	223	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
325	224	6	Visit	Neurology visit	300.00	\N	\N	2026-11-05 22:26:29.874258+00
326	224	9	Lab Test	Basic Metabolic Panel	55.00	102	\N	2026-11-05 22:26:29.874258+00
327	224	21	Medication	Albuterol inhaler (2 puffs as needed)	45.00	\N	83	2026-11-05 22:26:29.874258+00
328	225	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
329	226	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
330	227	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
331	228	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
332	229	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
333	230	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
334	230	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	84	2026-11-05 22:26:29.874258+00
335	231	6	Visit	Neurology visit	300.00	\N	\N	2026-11-05 22:26:29.874258+00
336	232	7	Visit	Endocrinology visit	225.00	\N	\N	2026-11-05 22:26:29.874258+00
337	232	12	Lab Test	Thyroid Panel (TSH)	50.00	103	\N	2026-11-05 22:26:29.874258+00
338	233	3	Visit	Cardiology visit	275.00	\N	\N	2026-11-05 22:26:29.874258+00
339	234	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
340	234	8	Lab Test	Complete Blood Count	45.00	104	\N	2026-11-05 22:26:29.874258+00
341	235	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-05 22:26:29.874258+00
342	236	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-05 22:26:29.874258+00
343	236	23	Medication	Acetaminophen (500 mg as needed)	6.00	\N	85	2026-11-05 22:26:29.874258+00
344	237	4	Visit	Dermatology visit	200.00	\N	\N	2026-11-05 22:26:29.874258+00
345	237	9	Lab Test	Basic Metabolic Panel	55.00	105	\N	2026-11-05 22:26:29.874258+00
346	238	7	Visit	Endocrinology visit	225.00	\N	\N	2026-11-05 22:26:29.874258+00
347	238	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	86	2026-11-05 22:26:29.874258+00
348	239	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 20:46:44.481835+00
349	240	6	Visit	Neurology visit	300.00	\N	\N	2026-11-12 21:11:34.014843+00
350	240	14	Lab Test	Vitamin D	65.00	106	\N	2026-11-12 21:11:34.014843+00
351	241	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
352	242	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
353	243	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
354	243	10	Lab Test	Lipid Panel	60.00	107	\N	2026-11-12 21:11:34.014843+00
355	244	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
356	244	23	Medication	Acetaminophen (500 mg as needed)	6.00	\N	87	2026-11-12 21:11:34.014843+00
357	245	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
358	245	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	88	2026-11-12 21:11:34.014843+00
359	246	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
360	246	13	Lab Test	Urinalysis	25.00	108	\N	2026-11-12 21:11:34.014843+00
361	247	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
362	248	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
363	248	21	Medication	Albuterol inhaler (2 puffs as needed)	45.00	\N	89	2026-11-12 21:11:34.014843+00
364	249	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
365	249	17	Medication	Atorvastatin (20 mg once daily)	20.00	\N	90	2026-11-12 21:11:34.014843+00
366	250	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
367	251	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
368	252	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
369	252	17	Medication	Atorvastatin (20 mg once daily)	20.00	\N	91	2026-11-12 21:11:34.014843+00
370	253	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
371	254	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
372	255	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
373	256	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-12 21:11:34.014843+00
374	257	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
375	257	10	Lab Test	Lipid Panel	60.00	109	\N	2026-11-12 21:11:34.014843+00
376	258	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
377	258	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	92	2026-11-12 21:11:34.014843+00
378	259	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
379	259	14	Lab Test	Vitamin D	65.00	110	\N	2026-11-12 21:11:34.014843+00
380	259	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	93	2026-11-12 21:11:34.014843+00
381	260	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
382	261	3	Visit	Cardiology visit	275.00	\N	\N	2026-11-12 21:11:34.014843+00
383	261	9	Lab Test	Basic Metabolic Panel	55.00	111	\N	2026-11-12 21:11:34.014843+00
384	261	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	94	2026-11-12 21:11:34.014843+00
385	262	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
386	262	13	Lab Test	Urinalysis	25.00	112	\N	2026-11-12 21:11:34.014843+00
387	263	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
388	263	23	Medication	Acetaminophen (500 mg as needed)	6.00	\N	95	2026-11-12 21:11:34.014843+00
389	264	3	Visit	Cardiology visit	275.00	\N	\N	2026-11-12 21:11:34.014843+00
390	265	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
391	266	7	Visit	Endocrinology visit	225.00	\N	\N	2026-11-12 21:11:34.014843+00
392	266	8	Lab Test	Complete Blood Count	45.00	113	\N	2026-11-12 21:11:34.014843+00
393	267	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
394	268	6	Visit	Neurology visit	300.00	\N	\N	2026-11-12 21:11:34.014843+00
395	269	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
396	269	9	Lab Test	Basic Metabolic Panel	55.00	114	\N	2026-11-12 21:11:34.014843+00
397	270	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
398	270	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	96	2026-11-12 21:11:34.014843+00
399	271	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
400	271	14	Lab Test	Vitamin D	65.00	115	\N	2026-11-12 21:11:34.014843+00
401	272	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
402	272	10	Lab Test	Lipid Panel	60.00	116	\N	2026-11-12 21:11:34.014843+00
403	273	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
404	273	9	Lab Test	Basic Metabolic Panel	55.00	117	\N	2026-11-12 21:11:34.014843+00
405	274	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-12 21:11:34.014843+00
406	275	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
407	276	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
408	277	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
409	278	3	Visit	Cardiology visit	275.00	\N	\N	2026-11-12 21:11:34.014843+00
410	278	12	Lab Test	Thyroid Panel (TSH)	50.00	118	\N	2026-11-12 21:11:34.014843+00
411	278	17	Medication	Atorvastatin (20 mg once daily)	20.00	\N	97	2026-11-12 21:11:34.014843+00
412	279	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
413	280	4	Visit	Dermatology visit	200.00	\N	\N	2026-11-12 21:11:34.014843+00
414	280	13	Lab Test	Urinalysis	25.00	119	\N	2026-11-12 21:11:34.014843+00
415	281	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
416	282	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
417	282	13	Lab Test	Urinalysis	25.00	120	\N	2026-11-12 21:11:34.014843+00
418	283	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
419	283	10	Lab Test	Lipid Panel	60.00	121	\N	2026-11-12 21:11:34.014843+00
420	284	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
421	284	13	Lab Test	Urinalysis	25.00	122	\N	2026-11-12 21:11:34.014843+00
422	284	21	Medication	Albuterol inhaler (2 puffs as needed)	45.00	\N	98	2026-11-12 21:11:34.014843+00
423	285	6	Visit	Neurology visit	300.00	\N	\N	2026-11-12 21:11:34.014843+00
424	285	21	Medication	Albuterol inhaler (2 puffs as needed)	45.00	\N	99	2026-11-12 21:11:34.014843+00
425	286	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
426	286	11	Lab Test	Hemoglobin A1c	40.00	123	\N	2026-11-12 21:11:34.014843+00
427	287	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
428	287	11	Lab Test	Hemoglobin A1c	40.00	124	\N	2026-11-12 21:11:34.014843+00
429	288	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
430	289	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
431	290	6	Visit	Neurology visit	300.00	\N	\N	2026-11-12 21:11:34.014843+00
432	290	14	Lab Test	Vitamin D	65.00	125	\N	2026-11-12 21:11:34.014843+00
433	291	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
434	291	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	100	2026-11-12 21:11:34.014843+00
435	292	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
436	292	12	Lab Test	Thyroid Panel (TSH)	50.00	126	\N	2026-11-12 21:11:34.014843+00
437	293	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
438	294	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
439	294	22	Medication	Ibuprofen (400 mg as needed)	8.00	\N	101	2026-11-12 21:11:34.014843+00
440	295	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
441	295	12	Lab Test	Thyroid Panel (TSH)	50.00	127	\N	2026-11-12 21:11:34.014843+00
442	296	4	Visit	Dermatology visit	200.00	\N	\N	2026-11-12 21:11:34.014843+00
443	296	23	Medication	Acetaminophen (500 mg as needed)	6.00	\N	102	2026-11-12 21:11:34.014843+00
444	297	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
445	297	14	Lab Test	Vitamin D	65.00	128	\N	2026-11-12 21:11:34.014843+00
446	297	19	Medication	Levothyroxine (25 mcg once daily)	18.00	\N	103	2026-11-12 21:11:34.014843+00
447	298	6	Visit	Neurology visit	300.00	\N	\N	2026-11-12 21:11:34.014843+00
448	298	9	Lab Test	Basic Metabolic Panel	55.00	129	\N	2026-11-12 21:11:34.014843+00
449	298	21	Medication	Albuterol inhaler (2 puffs as needed)	45.00	\N	104	2026-11-12 21:11:34.014843+00
450	299	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
451	300	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
452	301	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
453	301	9	Lab Test	Basic Metabolic Panel	55.00	130	\N	2026-11-12 21:11:34.014843+00
454	301	15	Medication	Lisinopril (10 mg once daily)	15.00	\N	105	2026-11-12 21:11:34.014843+00
455	302	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
456	303	6	Visit	Neurology visit	300.00	\N	\N	2026-11-12 21:11:34.014843+00
457	303	12	Lab Test	Thyroid Panel (TSH)	50.00	131	\N	2026-11-12 21:11:34.014843+00
458	303	20	Medication	Omeprazole (20 mg once daily)	22.00	\N	106	2026-11-12 21:11:34.014843+00
459	304	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
460	305	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
461	306	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
462	307	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
463	308	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
464	309	4	Visit	Dermatology visit	200.00	\N	\N	2026-11-12 21:11:34.014843+00
465	309	13	Lab Test	Urinalysis	25.00	132	\N	2026-11-12 21:11:34.014843+00
466	310	6	Visit	Neurology visit	300.00	\N	\N	2026-11-12 21:11:34.014843+00
467	310	21	Medication	Albuterol inhaler (2 puffs as needed)	45.00	\N	107	2026-11-12 21:11:34.014843+00
468	311	2	Visit	Internal Medicine visit	175.00	\N	\N	2026-11-12 21:11:34.014843+00
469	312	3	Visit	Cardiology visit	275.00	\N	\N	2026-11-12 21:11:34.014843+00
470	313	1	Visit	Family Medicine visit	150.00	\N	\N	2026-11-12 21:11:34.014843+00
471	313	23	Medication	Acetaminophen (500 mg as needed)	6.00	\N	108	2026-11-12 21:11:34.014843+00
472	314	5	Visit	Orthopedics visit	250.00	\N	\N	2026-11-12 21:11:34.014843+00
473	314	8	Lab Test	Complete Blood Count	45.00	133	\N	2026-11-12 21:11:34.014843+00
474	315	6	Visit	Neurology visit	300.00	\N	\N	2026-11-12 22:24:45.118966+00
475	316	27	No Show	No-show fee	25.00	\N	\N	2026-11-15 04:49:58.9859+00
476	317	27	No Show	No-show fee	25.00	\N	\N	2026-11-15 04:49:58.9859+00
477	318	27	No Show	No-show fee	25.00	\N	\N	2026-11-15 04:49:58.9859+00
478	319	27	No Show	No-show fee	25.00	\N	\N	2026-11-15 04:49:58.9859+00
479	320	27	No Show	No-show fee	25.00	\N	\N	2026-11-15 04:49:58.9859+00
\.


--
-- Data for Name: lab_order; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.lab_order (lab_order_id, patient_id, ordered_by_employee_id, lab_test_type_id, appointment_id, status, order_date, result_notes, performed_by_employee_id, result_date) FROM stdin;
106	101	1007	21	85	Completed	2026-10-23	Normal.	1032	2026-10-24 12:15:00
107	114	1002	17	111	Completed	2026-10-28	Slightly low, take a supplement.	1032	2026-10-29 13:31:00
108	106	1002	20	88	Completed	2026-10-28	10	1032	2026-10-29 14:23:00
109	112	1001	17	340	Completed	2026-11-06	All values normal.	1031	2026-11-07 13:25:00
110	123	1021	21	344	Completed	2026-11-06	Normal.	1032	2026-11-07 10:02:00
111	127	1004	16	347	Completed	2026-11-06	All values normal.	1020	2026-11-07 09:57:00
112	108	1003	20	343	Completed	2026-11-06	Normal.	1031	2026-11-07 15:38:00
113	101	1008	15	359	Completed	2026-11-09	Slightly high, recheck in 3 months.	1020	2026-11-10 14:39:00
114	119	1021	16	353	Completed	2026-11-09	Normal.	1032	2026-11-10 11:02:00
115	110	1021	21	550	Completed	2026-11-09	Normal.	1032	2026-11-10 10:32:00
116	110	1021	17	549	Completed	2026-11-09	Slightly high, recheck in 3 months.	1032	2026-11-10 09:32:00
117	115	1003	16	352	Completed	2026-11-09	10	1020	2026-11-10 11:48:00
118	123	1004	19	369	Completed	2026-11-10	Normal.	1020	2026-11-11 15:27:00
119	104	1005	20	370	Completed	2026-11-10	Normal.	1032	2026-11-11 09:21:00
120	120	1022	20	366	Completed	2026-11-10	Slightly high, recheck in 3 months.	1032	2026-11-11 14:01:00
121	120	1002	17	362	Completed	2026-11-10	k	1019	2026-11-11 14:38:00
122	110	1021	20	551	Completed	2026-11-10	Slightly low, take a supplement.	1032	2026-11-11 12:14:00
123	123	1002	18	361	Completed	2026-11-10	Slightly low, take a supplement.	1020	2026-11-11 12:13:00
124	110	1021	18	553	Completed	2026-11-10	Slightly low, take a supplement.	1032	2026-11-11 14:36:00
125	129	1023	21	371	Completed	2026-11-10	10	1031	2026-11-11 15:07:00
126	122	1021	19	365	Completed	2026-11-10	Slightly high, recheck in 3 months.	1032	2026-11-11 10:18:00
127	125	1021	19	377	Ordered	2026-11-11	\N	\N	\N
128	120	1022	21	378	Ordered	2026-11-11	\N	\N	\N
129	101	1007	16	380	InProgress	2026-11-11	\N	1032	\N
130	105	1002	16	373	InProgress	2026-11-11	\N	1032	\N
131	113	1007	19	394	Ordered	2026-11-12	\N	\N	\N
132	107	1005	20	392	Ordered	2026-11-12	\N	\N	\N
133	111	1006	15	393	Ordered	2026-11-12	\N	\N	\N
53	114	1002	20	\N	InProgress	2026-11-04	\N	\N	\N
31	104	1008	16	\N	Completed	2026-09-18	Glucose 142 mg/dL (fasting, high). Creatinine 1.0, Sodium 139, Potassium 4.2. Kidney function normal.	\N	\N
32	104	1008	18	\N	Completed	2026-09-18	HbA1c 6.9%. Improved since June, now at target.	\N	\N
33	106	1004	17	\N	Completed	2026-07-30	Total cholesterol 201, LDL 118, HDL 52, Triglycerides 155. Borderline. Continue current statin.	\N	\N
34	108	1003	18	\N	Completed	2026-08-12	HbA1c 5.6%. Normal.	\N	\N
36	106	1003	16	\N	Completed	2026-07-30	Glucose 96, Creatinine 1.1, Sodium 141, Potassium 4.0. All values normal.	\N	\N
37	104	1003	18	\N	Completed	2026-06-20	HbA1c 7.4%. Above target (<7.0%). Referred to endocrinology.	\N	\N
39	107	1001	15	\N	Completed	2026-09-10	Hemoglobin 10.8 g/dL (low), MCV 76 (low). Consistent with iron deficiency anemia. Start iron supplement.	\N	\N
40	103	1001	19	\N	Completed	2026-09-02	TSH 2.1 mIU/L. Normal thyroid function.	\N	\N
41	101	1001	15	\N	Completed	2026-08-04	WBC 6.8, RBC 4.6, Hemoglobin 13.9 g/dL, Platelets 255. All values within normal range.	\N	\N
42	101	1001	21	\N	Completed	2026-08-04	25-OH Vitamin D 22 ng/mL. Insufficient (normal 30-100). Recommend 2000 IU daily supplement.	\N	\N
43	109	1002	19	\N	Completed	2026-09-25	TSH 6.3 mIU/L (high). Possible hypothyroidism. Repeat with Free T4 in 6 weeks.	\N	\N
44	105	1002	20	\N	Completed	2026-08-27	Clear yellow. No protein, glucose, or blood detected. Normal.	\N	\N
45	102	1002	17	\N	Completed	2026-07-15	Total cholesterol 238, LDL 162, HDL 41, Triglycerides 175. LDL elevated. Diet changes advised, recheck in 3 months.	\N	\N
46	101	1001	18	\N	Cancelled	2026-10-23	\N	\N	\N
38	110	1001	17	\N	Completed	2026-10-14	Within normal range. No follow-up needed.	1019	2026-10-23 19:15:35.053496
35	108	1003	15	\N	Completed	2026-10-15	10	1020	2026-10-27 19:21:09.194553
74	126	1004	19	229	Completed	2026-10-26	All values normal.	1031	2026-10-27 14:00:00
49	101	1002	15	\N	Completed	2026-10-27	k	1020	2026-10-27 20:12:25.151319
54	108	1001	15	123	Completed	2026-10-15	All values normal.	1031	2026-10-16 14:00:00
55	104	1004	19	135	Completed	2026-10-15	Slightly low, take a supplement.	1031	2026-10-16 14:00:00
56	107	1005	19	136	Completed	2026-10-15	Slightly low, take a supplement.	1032	2026-10-16 14:00:00
57	125	1021	16	159	Completed	2026-10-19	Normal.	1032	2026-10-20 14:00:00
58	120	1022	17	163	Completed	2026-10-19	Slightly high, recheck in 3 months.	1032	2026-10-20 14:00:00
59	105	1008	21	167	Completed	2026-10-19	All values normal.	1031	2026-10-20 14:00:00
60	129	1002	20	172	Completed	2026-10-20	All values normal.	1031	2026-10-21 14:00:00
61	104	1022	21	175	Completed	2026-10-20	All values normal.	1032	2026-10-21 14:00:00
62	127	1022	20	176	Completed	2026-10-20	Slightly high, recheck in 3 months.	1032	2026-10-21 14:00:00
63	106	1024	16	181	Completed	2026-10-20	All values normal.	1032	2026-10-21 14:00:00
64	107	1001	18	182	Completed	2026-10-21	All values normal.	1031	2026-10-22 14:00:00
65	105	1002	17	185	Completed	2026-10-21	All values normal.	1032	2026-10-22 14:00:00
66	124	1022	21	194	Completed	2026-10-21	Slightly high, recheck in 3 months.	1032	2026-10-22 14:00:00
67	121	1022	17	195	Completed	2026-10-21	Normal.	1032	2026-10-22 14:00:00
68	119	1007	19	197	Completed	2026-10-21	Slightly high, recheck in 3 months.	1032	2026-10-22 14:00:00
69	123	1002	19	203	Completed	2026-10-22	Slightly high, recheck in 3 months.	1032	2026-10-23 14:00:00
70	119	1003	21	206	Completed	2026-10-22	Normal.	1031	2026-10-23 14:00:00
71	114	1005	20	209	Completed	2026-10-22	Normal.	1032	2026-10-23 14:00:00
72	113	1021	21	216	Completed	2026-10-23	Normal.	1032	2026-10-24 14:00:00
73	129	1003	20	225	Completed	2026-10-26	Normal.	1031	2026-10-27 14:00:00
75	125	1005	21	230	Completed	2026-10-26	Slightly low, take a supplement.	1032	2026-10-27 14:00:00
76	109	1008	20	233	Completed	2026-10-26	Slightly high, recheck in 3 months.	1031	2026-10-27 14:00:00
77	105	1023	21	234	Completed	2026-10-26	Normal.	1031	2026-10-27 14:00:00
78	1	1021	17	240	Completed	2026-10-27	Slightly high, recheck in 3 months.	1032	2026-10-28 14:00:00
79	113	1021	19	241	Completed	2026-10-27	Slightly low, take a supplement.	1032	2026-10-28 14:00:00
80	125	1021	20	242	Completed	2026-10-27	Slightly high, recheck in 3 months.	1032	2026-10-28 14:00:00
81	120	1004	18	245	Completed	2026-10-27	Normal.	1031	2026-10-28 14:00:00
82	108	1006	16	247	Completed	2026-10-27	All values normal.	1032	2026-10-28 14:00:00
83	119	1001	21	251	Completed	2026-10-28	Slightly low, take a supplement.	1031	2026-10-29 14:00:00
84	118	1002	16	254	Completed	2026-10-28	Slightly low, take a supplement.	1032	2026-10-29 14:00:00
85	104	1003	20	255	Completed	2026-10-28	Slightly low, take a supplement.	1031	2026-10-29 14:00:00
86	123	1006	20	263	Completed	2026-10-28	Slightly high, recheck in 3 months.	1031	2026-10-29 14:00:00
87	109	1002	20	270	Completed	2026-10-29	All values normal.	1032	2026-10-30 14:00:00
88	116	1021	16	274	Completed	2026-10-29	Slightly high, recheck in 3 months.	1032	2026-10-30 14:00:00
89	104	1006	15	279	Completed	2026-10-29	Normal.	1031	2026-10-30 14:00:00
90	120	1002	15	283	Completed	2026-10-30	Normal.	1032	2026-10-31 14:00:00
91	114	1003	18	284	Completed	2026-10-30	Normal.	1031	2026-10-31 14:00:00
92	113	1024	15	289	Completed	2026-10-30	Slightly low, take a supplement.	1032	2026-10-31 14:00:00
93	101	1001	16	292	Completed	2026-11-02	Slightly high, recheck in 3 months.	1031	2026-11-03 14:00:00
94	118	1021	18	297	Completed	2026-11-02	Slightly low, take a supplement.	1032	2026-11-03 14:00:00
95	110	1021	20	299	Completed	2026-11-02	Normal.	1032	2026-11-03 14:00:00
96	107	1006	17	302	Completed	2026-11-02	All values normal.	1031	2026-11-03 14:00:00
97	126	1007	21	303	Completed	2026-11-02	Normal.	1032	2026-11-03 14:00:00
98	103	1008	15	304	Completed	2026-11-02	Normal.	1031	2026-11-03 14:00:00
99	129	1002	20	307	InProgress	2026-11-03	\N	1031	\N
100	104	1003	17	311	InProgress	2026-11-03	\N	1031	\N
101	104	1003	16	312	InProgress	2026-11-03	\N	1031	\N
102	124	1023	16	316	InProgress	2026-11-03	\N	1031	\N
103	106	1008	19	326	InProgress	2026-11-04	\N	1031	\N
104	113	1021	15	333	Ordered	2026-11-05	\N	\N	\N
105	104	1005	16	336	Ordered	2026-11-05	\N	\N	\N
\.


--
-- Data for Name: lab_test_type; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.lab_test_type (lab_test_type_id, name, cost, is_active) FROM stdin;
15	Complete Blood Count	45.00	t
16	Basic Metabolic Panel	55.00	t
17	Lipid Panel	60.00	t
18	Hemoglobin A1c	40.00	t
19	Thyroid Panel (TSH)	50.00	t
20	Urinalysis	25.00	t
21	Vitamin D	65.00	t
22	Test Lipid Panel ZZ	45.00	f
\.


--
-- Data for Name: medication; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.medication (medication_id, name, manufacturer, is_active) FROM stdin;
1	Lisinopril	\N	t
2	Metformin	\N	t
3	Atorvastatin	\N	t
4	Amlodipine	\N	t
5	Levothyroxine	\N	t
6	Omeprazole	\N	t
7	Albuterol inhaler	\N	t
8	Ibuprofen	\N	t
9	Acetaminophen	\N	t
10	Sertraline	\N	t
11	Test Medication ZZ	Test Pharma	f
\.


--
-- Data for Name: nurse; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.nurse (employee_id, nursing_license_number, license_issuing_state, license_expiration_date, nursing_level) FROM stdin;
1013	CNA-450276	TX	2027-03-31	CNA
1011	LPN-226841	TX	2027-10-31	LPN
1009	RN-884512	TX	2027-02-28	RN
1012	NP-117093	TX	2028-08-31	NP
1010	RN-903317	TX	2028-06-30	RN
1018	TEST-RN-0001	TX	2028-12-31	RN
1025	RN-710331	TX	2028-06-30	RN
1026	LPN-710332	TX	2028-06-30	LPN
1027	NP-710333	TX	2028-06-30	NP
1034	3281092381	TX	2034-02-03	RN
\.


--
-- Data for Name: nursing_note; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.nursing_note (nursing_note_id, appointment_id, recorded_by_employee_id, note, recorded_at, updated_at) FROM stdin;
1	123	1025	Patient arrived on time, no concerns.	2026-10-15 13:38:00	\N
2	124	1013	Patient arrived on time, no concerns.	2026-10-15 10:08:00	\N
3	125	1011	Updated allergy list, no changes.	2026-10-15 14:08:00	\N
4	130	1012	Patient asked about flu shot.	2026-10-15 13:08:00	\N
5	131	1012	Came in with a family member.	2026-10-15 16:38:00	\N
6	132	1012	Patient arrived on time, no concerns.	2026-10-15 09:08:00	\N
7	133	1026	Patient arrived on time, no concerns.	2026-10-15 08:08:00	\N
8	134	1010	Updated allergy list, no changes.	2026-10-15 10:38:00	\N
9	135	1025	Vitals taken, patient calm.	2026-10-15 13:38:00	\N
10	136	1026	Updated allergy list, no changes.	2026-10-15 08:08:00	\N
11	137	1009	Updated allergy list, no changes.	2026-10-15 08:38:00	\N
12	139	1025	Patient says pain is a 3 out of 10.	2026-10-16 15:08:00	\N
13	140	1009	Patient says pain is a 3 out of 10.	2026-10-16 08:38:00	\N
14	141	1009	Came in with a family member.	2026-10-16 14:38:00	\N
15	142	1010	Updated allergy list, no changes.	2026-10-16 09:38:00	\N
16	143	1025	Came in with a family member.	2026-10-16 08:08:00	\N
17	144	1013	Updated allergy list, no changes.	2026-10-16 14:08:00	\N
18	145	1011	Patient asked about flu shot.	2026-10-16 08:38:00	\N
19	147	1010	Updated allergy list, no changes.	2026-10-16 08:08:00	\N
20	148	1027	Patient asked about flu shot.	2026-10-16 09:08:00	\N
21	149	1027	Patient says pain is a 3 out of 10.	2026-10-16 13:08:00	\N
22	150	1012	Vitals taken, patient calm.	2026-10-16 13:08:00	\N
23	152	1027	Patient asked about flu shot.	2026-10-16 08:08:00	\N
24	155	1027	Patient arrived on time, no concerns.	2026-10-19 14:08:00	\N
25	157	1010	Patient says pain is a 3 out of 10.	2026-10-19 14:38:00	\N
26	158	1013	Updated allergy list, no changes.	2026-10-19 15:38:00	\N
27	159	1027	Updated allergy list, no changes.	2026-10-19 10:08:00	\N
28	162	1012	Patient says pain is a 3 out of 10.	2026-10-19 14:38:00	\N
29	163	1026	Updated allergy list, no changes.	2026-10-19 16:08:00	\N
30	164	1012	Patient says pain is a 3 out of 10.	2026-10-19 09:38:00	\N
31	165	1011	Updated allergy list, no changes.	2026-10-19 16:38:00	\N
32	166	1027	Updated allergy list, no changes.	2026-10-19 11:08:00	\N
33	167	1025	Patient asked about flu shot.	2026-10-19 08:08:00	\N
34	168	1025	Patient arrived on time, no concerns.	2026-10-20 11:08:00	\N
35	170	1013	Patient asked about flu shot.	2026-10-20 10:38:00	\N
36	171	1013	Patient says pain is a 3 out of 10.	2026-10-20 15:38:00	\N
37	172	1013	Came in with a family member.	2026-10-20 09:08:00	\N
38	173	1025	Patient arrived on time, no concerns.	2026-10-20 08:38:00	\N
39	174	1012	Patient arrived on time, no concerns.	2026-10-20 11:08:00	\N
40	175	1012	Vitals taken, patient calm.	2026-10-20 10:38:00	\N
41	176	1026	Patient asked about flu shot.	2026-10-20 08:38:00	\N
42	181	1010	Vitals taken, patient calm.	2026-10-20 16:08:00	\N
43	182	1009	Patient says pain is a 3 out of 10.	2026-10-21 14:08:00	\N
44	185	1027	Patient says pain is a 3 out of 10.	2026-10-21 13:08:00	\N
45	187	1010	Vitals taken, patient calm.	2026-10-21 10:38:00	\N
46	189	1011	Came in with a family member.	2026-10-21 08:08:00	\N
47	191	1027	Patient arrived on time, no concerns.	2026-10-21 14:08:00	\N
48	193	1027	Patient arrived on time, no concerns.	2026-10-21 11:38:00	\N
49	194	1026	Vitals taken, patient calm.	2026-10-21 10:08:00	\N
50	195	1027	Updated allergy list, no changes.	2026-10-21 16:38:00	\N
51	196	1011	Patient says pain is a 3 out of 10.	2026-10-21 13:38:00	\N
52	197	1026	Came in with a family member.	2026-10-21 15:08:00	\N
53	198	1011	Patient arrived on time, no concerns.	2026-10-21 09:38:00	\N
54	199	1011	Vitals taken, patient calm.	2026-10-21 10:38:00	\N
55	201	1012	Patient says pain is a 3 out of 10.	2026-10-22 08:38:00	\N
56	202	1012	Updated allergy list, no changes.	2026-10-22 11:08:00	\N
57	203	1027	Patient says pain is a 3 out of 10.	2026-10-22 08:08:00	\N
58	204	1011	Patient asked about flu shot.	2026-10-22 16:38:00	\N
59	205	1011	Patient says pain is a 3 out of 10.	2026-10-22 15:38:00	\N
60	206	1025	Updated allergy list, no changes.	2026-10-22 08:08:00	\N
61	207	1010	Vitals taken, patient calm.	2026-10-22 10:38:00	\N
62	208	1012	Updated allergy list, no changes.	2026-10-22 08:08:00	\N
63	209	1026	Vitals taken, patient calm.	2026-10-22 09:38:00	\N
64	210	1009	Patient says pain is a 3 out of 10.	2026-10-22 15:08:00	\N
65	211	1012	Updated allergy list, no changes.	2026-10-22 11:38:00	\N
66	213	1027	Updated allergy list, no changes.	2026-10-23 15:38:00	\N
67	215	1011	Patient arrived on time, no concerns.	2026-10-23 15:38:00	\N
68	216	1026	Patient says pain is a 3 out of 10.	2026-10-23 09:38:00	\N
69	217	1026	Patient says pain is a 3 out of 10.	2026-10-23 13:08:00	\N
70	219	1012	Updated allergy list, no changes.	2026-10-23 16:08:00	\N
71	220	1009	Updated allergy list, no changes.	2026-10-23 16:08:00	\N
72	223	1026	Came in with a family member.	2026-10-26 08:38:00	\N
73	224	1009	Vitals taken, patient calm.	2026-10-26 13:38:00	\N
74	225	1011	Came in with a family member.	2026-10-26 15:38:00	\N
75	226	1012	Came in with a family member.	2026-10-26 11:08:00	\N
76	227	1026	Updated allergy list, no changes.	2026-10-26 09:08:00	\N
77	228	1026	Vitals taken, patient calm.	2026-10-26 15:08:00	\N
78	229	1011	Patient asked about flu shot.	2026-10-26 08:38:00	\N
79	230	1027	Patient asked about flu shot.	2026-10-26 13:08:00	\N
80	231	1013	Patient arrived on time, no concerns.	2026-10-26 13:08:00	\N
81	232	1027	Patient asked about flu shot.	2026-10-26 08:08:00	\N
82	233	1013	Patient arrived on time, no concerns.	2026-10-26 13:38:00	\N
83	234	1009	Patient says pain is a 3 out of 10.	2026-10-26 16:38:00	\N
84	235	1025	Came in with a family member.	2026-10-27 10:08:00	\N
85	236	1011	Patient arrived on time, no concerns.	2026-10-27 16:38:00	\N
86	238	1013	Updated allergy list, no changes.	2026-10-27 10:08:00	\N
87	239	1013	Vitals taken, patient calm.	2026-10-27 08:08:00	\N
88	240	1027	Vitals taken, patient calm.	2026-10-27 10:08:00	\N
89	241	1010	Patient asked about flu shot.	2026-10-27 11:38:00	\N
90	242	1012	Patient arrived on time, no concerns.	2026-10-27 14:08:00	\N
91	243	1027	Updated allergy list, no changes.	2026-10-27 08:38:00	\N
92	244	1027	Patient asked about flu shot.	2026-10-27 10:38:00	\N
93	245	1025	Updated allergy list, no changes.	2026-10-27 08:08:00	\N
94	246	1026	Patient arrived on time, no concerns.	2026-10-27 16:08:00	\N
95	247	1010	Patient asked about flu shot.	2026-10-27 14:08:00	\N
96	248	1012	Updated allergy list, no changes.	2026-10-27 16:08:00	\N
97	249	1026	Patient arrived on time, no concerns.	2026-10-27 10:08:00	\N
98	250	1013	Patient arrived on time, no concerns.	2026-10-28 14:38:00	\N
99	251	1011	Vitals taken, patient calm.	2026-10-28 14:08:00	\N
100	252	1011	Vitals taken, patient calm.	2026-10-28 16:08:00	\N
101	253	1027	Updated allergy list, no changes.	2026-10-28 10:38:00	\N
102	254	1027	Patient asked about flu shot.	2026-10-28 13:38:00	\N
103	255	1009	Patient says pain is a 3 out of 10.	2026-10-28 08:08:00	\N
104	256	1025	Patient arrived on time, no concerns.	2026-10-28 13:08:00	\N
105	257	1013	Updated allergy list, no changes.	2026-10-28 10:08:00	\N
106	258	1027	Patient says pain is a 3 out of 10.	2026-10-28 15:38:00	\N
107	259	1010	Patient asked about flu shot.	2026-10-28 08:38:00	\N
108	260	1012	Came in with a family member.	2026-10-28 09:38:00	\N
109	261	1013	Patient arrived on time, no concerns.	2026-10-28 15:08:00	\N
110	263	1013	Came in with a family member.	2026-10-28 13:08:00	\N
111	264	1010	Patient says pain is a 3 out of 10.	2026-10-28 08:38:00	\N
112	265	1009	Patient asked about flu shot.	2026-10-28 08:38:00	\N
113	266	1013	Patient says pain is a 3 out of 10.	2026-10-29 08:08:00	\N
114	267	1013	Patient arrived on time, no concerns.	2026-10-29 10:38:00	\N
115	269	1026	Vitals taken, patient calm.	2026-10-29 10:08:00	\N
116	270	1010	Patient arrived on time, no concerns.	2026-10-29 14:08:00	\N
117	271	1025	Vitals taken, patient calm.	2026-10-29 10:08:00	\N
118	272	1025	Updated allergy list, no changes.	2026-10-29 16:08:00	\N
119	273	1009	Patient asked about flu shot.	2026-10-29 13:08:00	\N
120	274	1010	Updated allergy list, no changes.	2026-10-29 11:08:00	\N
121	275	1010	Vitals taken, patient calm.	2026-10-29 08:08:00	\N
122	276	1010	Came in with a family member.	2026-10-29 11:08:00	\N
123	278	1026	Patient asked about flu shot.	2026-10-29 13:08:00	\N
124	279	1011	Came in with a family member.	2026-10-29 13:08:00	\N
125	280	1025	Patient says pain is a 3 out of 10.	2026-10-30 09:38:00	\N
126	281	1012	Patient arrived on time, no concerns.	2026-10-30 16:38:00	\N
127	282	1010	Patient says pain is a 3 out of 10.	2026-10-30 15:08:00	\N
128	283	1012	Patient arrived on time, no concerns.	2026-10-30 09:38:00	\N
129	284	1013	Updated allergy list, no changes.	2026-10-30 13:08:00	\N
130	286	1026	Patient asked about flu shot.	2026-10-30 10:08:00	\N
131	288	1013	Patient asked about flu shot.	2026-10-30 11:38:00	\N
132	289	1027	Came in with a family member.	2026-10-30 09:08:00	\N
133	290	1011	Patient arrived on time, no concerns.	2026-11-02 09:38:00	\N
134	292	1025	Updated allergy list, no changes.	2026-11-02 08:08:00	\N
135	293	1010	Patient says pain is a 3 out of 10.	2026-11-02 13:38:00	\N
136	295	1010	Patient says pain is a 3 out of 10.	2026-11-02 11:08:00	\N
137	296	1009	Updated allergy list, no changes.	2026-11-02 13:08:00	\N
138	297	1010	Patient says pain is a 3 out of 10.	2026-11-02 15:38:00	\N
139	299	1027	Updated allergy list, no changes.	2026-11-02 14:38:00	\N
140	300	1026	Patient asked about flu shot.	2026-11-02 08:38:00	\N
141	301	1026	Patient asked about flu shot.	2026-11-02 08:08:00	\N
142	302	1009	Patient asked about flu shot.	2026-11-02 11:38:00	\N
143	303	1012	Patient asked about flu shot.	2026-11-02 15:38:00	\N
144	304	1013	Patient arrived on time, no concerns.	2026-11-02 15:08:00	\N
145	305	1011	Came in with a family member.	2026-11-02 14:38:00	\N
146	307	1013	Patient asked about flu shot.	2026-11-03 10:08:00	\N
147	308	1013	Patient says pain is a 3 out of 10.	2026-11-03 09:38:00	\N
148	309	1025	Patient asked about flu shot.	2026-11-03 13:38:00	\N
149	310	1009	Patient arrived on time, no concerns.	2026-11-03 13:38:00	\N
150	311	1011	Patient says pain is a 3 out of 10.	2026-11-03 10:08:00	\N
151	312	1009	Patient arrived on time, no concerns.	2026-11-03 13:08:00	\N
152	313	1012	Patient arrived on time, no concerns.	2026-11-03 10:08:00	\N
153	314	1026	Patient says pain is a 3 out of 10.	2026-11-03 13:38:00	\N
154	315	1026	Vitals taken, patient calm.	2026-11-03 11:38:00	\N
155	316	1009	Came in with a family member.	2026-11-03 16:38:00	\N
156	318	1025	Vitals taken, patient calm.	2026-11-04 16:08:00	\N
157	319	1012	Patient arrived on time, no concerns.	2026-11-04 08:38:00	\N
158	320	1009	Patient asked about flu shot.	2026-11-04 09:38:00	\N
159	321	1010	Patient says pain is a 3 out of 10.	2026-11-04 14:38:00	\N
160	322	1010	Patient arrived on time, no concerns.	2026-11-04 16:08:00	\N
161	324	1010	Came in with a family member.	2026-11-04 10:08:00	\N
162	325	1010	Patient arrived on time, no concerns.	2026-11-04 08:08:00	\N
163	326	1009	Patient asked about flu shot.	2026-11-04 14:08:00	\N
164	327	1026	Updated allergy list, no changes.	2026-11-04 10:08:00	\N
165	333	1012	Patient asked about flu shot.	2026-11-05 11:08:00	\N
166	334	1010	Updated allergy list, no changes.	2026-11-05 11:38:00	\N
167	335	1026	Vitals taken, patient calm.	2026-11-05 11:38:00	\N
168	336	1012	Vitals taken, patient calm.	2026-11-05 08:08:00	\N
169	338	1011	Came in with a family member.	2026-11-05 08:08:00	\N
170	574	1034	hello, character	2026-11-11 21:50:49.501352	2026-11-11 21:50:53.207483
171	574	1034	eiaokdsfhaosfih	2026-11-11 22:32:49.976708	\N
172	85	1026	Came in with a family member.	2026-10-23 15:32:00	\N
173	108	1025	Updated allergy list, no changes.	2026-10-26 09:18:00	\N
174	87	1010	Patient arrived on time, no concerns.	2026-10-26 16:41:00	\N
175	111	1027	Came in with a family member.	2026-10-28 08:05:00	\N
176	112	1011	Updated allergy list, no changes.	2026-10-28 08:44:00	\N
177	113	1013	Patient says pain is a 3 out of 10.	2026-10-28 09:21:00	\N
178	88	1027	Vitals taken, patient calm.	2026-10-28 11:32:00	\N
179	110	1025	Came in with a family member.	2026-10-29 08:06:00	\N
180	90	1034	Patient asked about flu shot.	2026-10-29 16:20:00	\N
181	115	1013	Updated allergy list, no changes.	2026-10-30 11:14:00	\N
182	117	1013	Patient asked about flu shot.	2026-10-30 16:34:00	\N
183	331	1010	Came in with a family member.	2026-11-05 13:10:00	\N
184	330	1011	Patient asked about flu shot.	2026-11-05 13:36:00	\N
185	332	1013	Patient says pain is a 3 out of 10.	2026-11-05 14:41:00	\N
186	329	1011	Patient asked about flu shot.	2026-11-05 15:06:00	\N
187	328	1009	Vitals taken, patient calm.	2026-11-05 16:07:00	\N
188	337	1011	Patient says pain is a 3 out of 10.	2026-11-05 16:34:00	\N
189	340	1034	Patient says pain is a 3 out of 10.	2026-11-06 08:05:00	\N
190	342	1009	Patient arrived on time, no concerns.	2026-11-06 10:41:00	\N
191	344	1012	Came in with a family member.	2026-11-06 13:01:00	\N
192	341	1012	Came in with a family member.	2026-11-06 13:40:00	\N
193	347	1013	Patient asked about flu shot.	2026-11-06 13:34:00	\N
194	343	1011	Patient arrived on time, no concerns.	2026-11-06 14:09:00	\N
195	548	1010	Vitals taken, patient calm.	2026-11-06 16:01:00	\N
196	356	1025	Came in with a family member.	2026-11-09 08:33:00	\N
197	354	1026	Updated allergy list, no changes.	2026-11-09 09:39:00	\N
198	359	1025	Patient asked about flu shot.	2026-11-09 09:37:00	\N
199	351	1012	Updated allergy list, no changes.	2026-11-09 10:09:00	\N
200	358	1010	Came in with a family member.	2026-11-09 10:00:00	\N
201	353	1027	Patient arrived on time, no concerns.	2026-11-09 13:43:00	\N
202	349	1025	Patient arrived on time, no concerns.	2026-11-09 14:16:00	\N
203	549	1026	Patient asked about flu shot.	2026-11-09 15:16:00	\N
204	352	1011	Patient says pain is a 3 out of 10.	2026-11-09 16:35:00	\N
205	357	1013	Patient says pain is a 3 out of 10.	2026-11-09 16:45:00	\N
206	363	1034	Updated allergy list, no changes.	2026-11-10 08:35:00	\N
207	364	1011	Came in with a family member.	2026-11-10 09:16:00	\N
208	368	1027	Patient asked about flu shot.	2026-11-10 09:07:00	\N
209	369	1011	Patient asked about flu shot.	2026-11-10 09:01:00	\N
210	93	1013	Patient asked about flu shot.	2026-11-10 09:44:00	\N
211	370	1027	Vitals taken, patient calm.	2026-11-10 09:30:00	\N
212	367	1026	Vitals taken, patient calm.	2026-11-10 10:00:00	\N
213	362	1034	Patient says pain is a 3 out of 10.	2026-11-10 11:10:00	\N
214	551	1010	Vitals taken, patient calm.	2026-11-10 11:27:00	\N
215	94	1012	Patient says pain is a 3 out of 10.	2026-11-10 13:14:00	\N
216	361	1034	Patient asked about flu shot.	2026-11-10 13:15:00	\N
217	553	1010	Updated allergy list, no changes.	2026-11-10 13:13:00	\N
218	552	1013	Patient says pain is a 3 out of 10.	2026-11-10 13:34:00	\N
219	556	1027	Patient says pain is a 3 out of 10.	2026-11-10 15:11:00	\N
220	371	1013	Patient asked about flu shot.	2026-11-10 16:00:00	\N
221	360	1025	Updated allergy list, no changes.	2026-11-10 16:40:00	\N
222	365	1027	Patient arrived on time, no concerns.	2026-11-10 16:41:00	\N
223	375	1034	Patient arrived on time, no concerns.	2026-11-11 08:04:00	\N
224	558	1025	Patient says pain is a 3 out of 10.	2026-11-11 08:37:00	\N
225	377	1012	Updated allergy list, no changes.	2026-11-11 10:59:00	\N
226	379	1010	Patient asked about flu shot.	2026-11-11 11:10:00	\N
227	378	1010	Patient says pain is a 3 out of 10.	2026-11-11 11:35:00	\N
228	380	1026	Patient arrived on time, no concerns.	2026-11-11 13:06:00	\N
229	575	1026	Vitals taken, patient calm.	2026-11-11 13:46:00	\N
230	376	1026	Vitals taken, patient calm.	2026-11-11 14:38:00	\N
231	373	1010	Updated allergy list, no changes.	2026-11-11 15:14:00	\N
232	559	1027	Patient asked about flu shot.	2026-11-11 16:18:00	\N
233	394	1012	Vitals taken, patient calm.	2026-11-12 08:09:00	\N
234	576	1012	Came in with a family member.	2026-11-12 08:05:00	\N
235	577	1010	Patient arrived on time, no concerns.	2026-11-12 08:27:00	\N
236	387	1034	Updated allergy list, no changes.	2026-11-12 09:13:00	\N
237	584	1013	Updated allergy list, no changes.	2026-11-12 09:07:00	\N
238	390	1012	Patient arrived on time, no concerns.	2026-11-12 09:32:00	\N
239	392	1010	Vitals taken, patient calm.	2026-11-12 10:09:00	\N
240	396	1013	Patient says pain is a 3 out of 10.	2026-11-12 10:07:00	\N
241	388	1034	Patient asked about flu shot.	2026-11-12 10:39:00	\N
242	391	1034	Updated allergy list, no changes.	2026-11-12 11:17:00	\N
243	381	1034	Vitals taken, patient calm.	2026-11-12 14:08:00	\N
244	393	1034	Updated allergy list, no changes.	2026-11-12 14:38:00	\N
245	592	1034	test	2026-11-12 16:14:35.310065	2026-11-12 16:16:50.650163
246	592	1034	sjssss	2026-11-12 16:32:19.714205	\N
247	592	1034	hello	2026-11-12 18:34:03.124332	\N
\.


--
-- Data for Name: office; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.office (office_id, name, apt, street, city, state, zip, phone, is_active) FROM stdin;
5	Main Street Clinic	Suite 200	1200 Main St	Houston	TX	77002	7135550100	t
6	Westside Clinic	\N	8850 Westheimer Rd	Houston	TX	77063	7135550200	t
\.


--
-- Data for Name: office_supply; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.office_supply (office_supply_id, supply_id, office_id, quantity_on_hand, expiration_date, reorder_threshold, is_active) FROM stdin;
1	1	5	40	\N	10	t
3	3	5	120	2026-11-11	30	t
12	4	6	200	2027-10-22	50	t
14	6	6	150	2028-03-05	40	t
15	7	6	250	\N	50	t
11	3	6	320	2026-11-11	30	t
8	8	5	8270	\N	100	t
10	2	6	77	\N	10	t
9	1	6	55	\N	10	t
16	8	6	101	\N	100	t
13	5	6	102	2027-11-26	100	t
2	2	5	12	\N	10	t
6	6	5	41	2028-03-05	40	t
7	7	5	150	\N	50	t
5	5	5	223	2027-11-26	100	t
4	4	5	99	2027-10-22	50	t
\.


--
-- Data for Name: patient; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.patient (patient_id, first_name, last_name, dob, gender, phone, email, address, is_active) FROM stdin;
111	William	Nguyen	2009-07-24	Male	1234567890	\N	\N	t
112	Bill	Le	2008-08-29	\N	9876543210	billle@mail.com	\N	t
113	Giselle	Doop	2026-06-21	\N	3469703407	doop@gmail.com	\N	t
114	napoleon	bonaparte	1901-08-15	\N	3469703407	napoleon1777@gmail.com	\N	t
115	Frontend	test	1998-02-02	male	3469703405	jane.doe@example.com	123 Main St, Houston, TX 77004	t
116	EmailtestAlpha	One	1990-01-01	\N	2815550100	doublememailtest@live.com	\N	t
118	osdifioj	odsoigj=psij	2004-02-02	\N	3469703406	00000110@gmail.com	\N	t
117	Mike	guy	2026-10-21	\N	7135550117	mikeguy@gmail.com	\N	t
102	Michael	Reyes	1985-02-08	Male	8325555002	michaelreyes@mail.com	2215 Navigation Blvd, Houston, TX 77003	t
103	Aisha	Patel	1999-07-21	Female	8325555003	aishapatel@mail.com	6120 Bellaire Blvd, Houston, TX 77081	t
104	Daniel	Kowalski	1962-11-30	Male	8325555004	danielkowalski@mail.com	903 Heights Blvd, Houston, TX 77008	t
105	Sophia	Chen	2001-03-12	Female	8325555005	sophiachen@mail.com	7700 Cambridge St, Houston, TX 77054	t
106	Anthony	Brown	1977-09-04	Male	8325555006	anthonybrown@mail.com	3300 Almeda Rd, Houston, TX 77004	t
107	Grace	Okonkwo	1994-12-19	Female	8325555007	graceokonkwo@mail.com	1500 Hillcroft Ave, Houston, TX 77057	t
108	Luis	Hernandez	1958-06-25	Male	8325555008	luishernandez@mail.com	5810 Telephone Rd, Houston, TX 77087	t
109	Hannah	Schmidt	1988-01-14	Female	8325555009	hannahschmidt@mail.com	2400 Bissonnet St, Houston, TX 77005	t
110	Jamal	Washington	1970-08-02	Male	8325555010	jamalwashington@mail.com	4802 Griggs Rd, Houston, TX 77021	t
1	Test	Patient	1990-01-15	Other	7135550123	test.patient@example.com	100 Test St, Houston, TX	t
101	Emily	Watson	1990-05-17	Female	8325555001	emilywatson@mail.com	4410 Montrose Blvd, Houston, TX 77006	t
119	Tony	Stark	1970-05-29	Male	8325555011	tonystark@mail.com	10880 Malibu Point Dr, Houston, TX 77002	t
120	Steve	Rogers	1988-07-04	Male	8325555012	steverogers@mail.com	569 Leaman Pl, Houston, TX 77006	t
121	Thor	Odinson	1985-01-15	Male	8325555013	thorodinson@mail.com	1 Asgard Way, Houston, TX 77019	t
122	Natasha	Romanoff	1984-11-22	Female	8325555014	natasharomanoff@mail.com	2240 Red Room Rd, Houston, TX 77007	t
123	Clint	Barton	1979-01-07	Male	8325555015	clintbarton@mail.com	88 Hawkeye Farm Ln, Houston, TX 77040	t
124	Peter	Parker	2001-08-10	Male	8325555016	peterparker@mail.com	20 Ingram St, Houston, TX 77004	t
125	Carol	Danvers	1989-04-24	Female	8325555017	caroldanvers@mail.com	300 Starforce Ave, Houston, TX 77058	t
126	Bucky	Barnes	1987-03-10	Male	8325555018	buckybarnes@mail.com	45 Winter St, Houston, TX 77008	t
127	Peter	Quill	1980-06-03	Male	8325555019	peterquill@mail.com	77 Milano Dock, Houston, TX 77012	t
128	James	Rhodes	1976-10-08	Male	8325555020	jamesrhodes@mail.com	1500 War Machine Blvd, Houston, TX 77030	t
129	Kate	Bishop	1998-02-14	Female	8325555021	katebishop@mail.com	910 Bishop Arrow Ct, Houston, TX 77024	t
130	diego	martinez	2026-11-10	\N	3469703400	test@gmail.com	\N	t
131	diego	notmartinez	2003-02-04	\N	3469703400	testingdiego@gmail.com	\N	t
132	Reek	Anderson	1998-02-05	\N	2814094011	reek.reek@mail.com	\N	t
\.


--
-- Data for Name: patient_creds; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.patient_creds (patient_creds_id, patient_id, username, password_hash, created_date, is_active) FROM stdin;
32	112	billle@mail.com	764176cfd689e9289b0a6c0fa06de63b:1fd926028047434f4dd8e291a473033fb25e8578611882a5c2441450ab10291b5f6c927c22fecfb2275d5ca7da94c9cb26faa3e173ba88d4bd27e6dd9a901184	2026-10-27	t
33	113	doop@gmail.com	302a833e3438836544c48d2f5ee030b3:ef5ebcc60b86dce98c706b08c78322d025a1696b62a22a120687f9f0e33d1c9c908ccb9bbd7b4434b138275ee445ef2f89bcca8f1b90b86cf9ce3963d9c91146	2026-10-27	t
34	114	napoleon1777@gmail.com	8e3566c564a3cbeb1bbcaccc68c382bd:f6323a7b864ec4d7fd4fe7fe3352b033d4f93365d792495ce302cd8af23ffd4ae0898ba1ebaa4c264bb1a7d87adef008b0ba98109287706d8f139a7af95da944	2026-10-27	t
1	1	test.patient@example.com	2dbc936065d5e0d75b198bfbd79e2aa2:2584ca06066f4119ec6e1428bbf81b70418fc7ea97563cab18c67bd0f5452cc1bfa948cab9d5eac1695fc9cf6e943ab599ffda99808766abd2ad99fde2c2e109	2026-10-17	t
35	116	doublememailtest@live.com	d01cfb74b3ede7e614863c33bd8fd558:abc7beb461c182cf3b45a947f3aa633b267ed76b8e696901dc367a3b165aebc958992f46cc262dc4faa1582dd652fb6c099756fbac54f64ab336b610f8d7d3ee	2026-10-27	t
50	131	testingdiego@gmail.com	589fe02c52eafc762d2bfdc140f811fd:cb7343b3291faf552d730e2e02d5c860f675d431a9bf3dece078f5e7bb39d7f4d552345013362461fb7594e2e9568c31a13177d36a9051e6778ebc52b59c1c83	2026-11-11	t
36	117	mikeguy@gmail.com	b8b4db6f29acfdc59b6e79e5991e0a11:3c568d263fb76ec2cb1dafb51f60c9531c3287cf3b6cfaea2fd7eac8802aa8013011e8fc0fa63d1213346b8ed1009ff6e245f1da33e05137c8510343beabdbbd	2026-10-28	t
37	118	00000110@gmail.com	735183ab1816ceeed1c6f5fc3756df0a:0d286d8ab0b840ffbb9ed2634c70c78fb9c8c3a4129af03735292a8a6ee20e781fe1f1c4f87c02fcc1269e0af5ce23ec0a4a0550743a0583e5182214cfe5bd84	2026-10-28	t
31	110	jamalwashington@mail.com	a72453abca5268eb97c29b59479c4d4b:68a63c828a940e1b06af200cc0c94f214e8e1a2f732feb1d39889ffa452e1443f4670b0e895509e3bb4eb8299678088dde35580a0fb68a7e09d218fc7c3305bc	2026-09-14	t
38	119	tonystark@mail.com	5a671c9511491de3391734f7a34e2e14:89c7c0247fb7e2545f58333c45ef018b8bfc0be968ecdeafc104ef2bb1988c7540734efc4e49eb8015179999680e7fda5651f3441272a3a14fcbdd19df7b1285	2026-10-15	t
39	120	steverogers@mail.com	4d4000d7059c094406aadbf1cce76d83:c3efb4b84992ef2db3448bf4dfac5bf8784aacd0490e5b0fc48f7d622be0b0d8a105addd018d01c7a0d4f25829bb78d51c55b0d9ca344edf6eb0012e4325d71d	2026-10-15	t
40	121	thorodinson@mail.com	06b799858282dbd4a63c592473b69975:71c77882b7d6c01a133eadd0bcb07dc0e1eb7c65bad725b4c787507d4389fc60add5b65e6d89bb8493ea2ac2842fae7a87f1c18cf03cfc8734ff76e164f83f53	2026-10-15	t
22	101	emilywatson@mail.com	846c3dcd3d8419e6ba753f8e1c56f207:91ee973a11b4a0328935be8b7f5ee4a2d09cfc63f0cd596e834e7c70afd0d3d64ff7155b7d36fb8c237376703c54666f57faf065e08acfe6b42da4d2c9964c97	2026-01-08	t
23	102	michaelreyes@mail.com	52d1444dde961a1ddd4c4bed69e44b62:fc58b50227dc9e5b5fa62ebfcf8c83582f7ae504ab9a54562f2b47b67e60c53bd917355c2b3d27d7f93f12a26fbb2222e5cbdb8d405af18ef6b5edeb8c1938fd	2026-01-21	t
24	103	aishapatel@mail.com	3e5640983eed738e5b677e975f852644:658f14da1d588bbf8057450de929f39f6ef7481ae5be2287b108f91a9ce78df3a92eeeedd53a2b11391703d06091c4cfcef452bcb72ceb13bdc3e4f8d2f2a087	2026-02-12	t
25	104	danielkowalski@mail.com	478639a4a2b20ed0c22f17f1b87ae181:a923905a516ebac6accd69fbac1e16da914b67c17c08b418e9fcf2939970dbde213f9284e036a712fb9e88ace34efe86ce80c332ff103df8f8995ff1f3d78306	2026-03-03	t
26	105	sophiachen@mail.com	8d892cb664174453db482ca40f548781:865b5f0324466d3d95492b1a6e314653b8a43c39f41270cbf40db081453d517f97d18f35b893a2763c9ba8ba949ee1a95f4699418e3e3e60c0e6552d7d9d99ac	2026-04-15	t
27	106	anthonybrown@mail.com	c2e4a54ee95ab3b3c7b74b7a6afccc0c:60cd27dd31e5069194d675e324024dcc1e113de41dc25aac6edf630247b489e4bd68bfa308774babe2b39c57701da979474f30ce91ff530b16980d15a2a796c7	2026-05-19	t
28	107	graceokonkwo@mail.com	63c8526965fbceb8bee97605b54cdc98:f37744d58a704449d6261b105c7f15b81d10cf584ae9659d1317ce99df1e7821818100c5e109508566cd93beca56303db8321852338521057c5cf8ec41499cbd	2026-06-09	t
29	108	luishernandez@mail.com	20023326a460a55f98e6e29823aeb7c1:51e6738299152a0b79f673bc9de7d8bf2134515cf7343ac68b6dd264a7c6354d4276b7790c96c4b2450e3ddff05c6893baa6c93e65410df9e0a16a3f735a7e11	2026-07-22	t
30	109	hannahschmidt@mail.com	244980b32a39b848cf4cbf2dfddfb85b:a8b5da3c129a8db614aa7bd0d9ce1450a91ab21b863b128142b4b7d54035b5b63b25313e77c94ae86c617732c1662394c777942bb4d6025f3716226476b1e8b3	2026-08-27	t
51	132	reek.reek@mail.com	35983ce39f10de87b14c3b72a2280bc2:684d70dc14741d83b80ee89d521fe43560a027f29ee7878a3d70122072d6adbdbfaca06f66700745a66fecd58f389c3a0195d60fca160239f8ca74f869753c02	2026-11-12	t
41	122	natasharomanoff@mail.com	13a668b8e1c2ebf2773b69aacf49d8fb:bde80c5185adf568307e44491fda182ad203cab1e40413709db644cf4f76492cebf58803eb8902de58aefcd28c3c1a9cfe5e06be9b531ccd6596ae3c9c6c4672	2026-10-15	t
42	123	clintbarton@mail.com	04b9fcd46613b9b8b44e8ad4ab9fce33:d8ee2b06ec5b5077c5ac58f4a66bb9ccb87eccfcebeac74a63323c7dcf1a8ffc46dea8db6edcf4096069863da0c19cc2fa98e47a835a3a17fb687396b6d11df4	2026-10-15	t
43	124	peterparker@mail.com	2bf2b016db57a39781e5fe3e4b88be9b:3c01d55b2e9031ed6a8654e1ba95520420bc5e9b791eaa40df41ceff2554e6f344cd36a1c49ca7fe3b38c3238969cd2992b4e114e3ebe39a4a757927d1a8a145	2026-10-15	t
44	125	caroldanvers@mail.com	22e7cfd9833e0560afa2ba932ca372c5:620d6172b114db436ca3f8dc8f19d1fcddcf80b31ba9d8bd7093b9909407525a9657245c2a3c5075d8ea89d0965628acb3209989e47c4ef5e00c14e9c7558425	2026-10-15	t
45	126	buckybarnes@mail.com	cd418b08a5e0097a649b340178445ab7:37194b1a5e84e85da903abf34bdb66fba29c9f6939bf5514b48b7faa8903a020fffea028e2bd8d15906787f503961a1cae44944e73c8b2429975c6c235cc6c3e	2026-10-15	t
46	127	peterquill@mail.com	1d1a6de3f856f6c5d0da6f5b90643188:2533aa283f80f4ffc0b51dbe4c62d9a708dacb51fe80197a512136887db3810a639da18051075f2e93fcd7d0770cc840f357afda9897db254479cf8f5bac0b1d	2026-10-15	t
47	128	jamesrhodes@mail.com	8e527a5f5d6da735dcf2fd91ade881a5:5c68ff4a2ada04c9c3ad522bbe8a7374c9a79b5d08d02909bac1fa90e124a9f0a48304c7a7f5c7fbe60f006ecc124a41bfb05e5ab09b330264f1acedf6a4d22d	2026-10-15	t
48	129	katebishop@mail.com	0e7d1c18f385d499746d1321627edd35:594e063f0f3c8135377c927107a70c8916d775564797866705fa0cc0d394061e4e85a0d4fafbc8e29d286d107c89eeba7f1bd74eeacb0ddf844813eec4355311	2026-10-15	t
49	130	test@gmail.com	1114072752262a1b467318b0be433f3a:c9da4e5047537faf8a0bbdcc215bfbc924d4931c22bb999bb86c50fb8bf9345d4b2497d7abe320435af7a1bfc482f486b328f3602ba1436b3713a7cf652a4998	2026-11-11	t
\.


--
-- Data for Name: patient_doctor; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.patient_doctor (patient_id, doctor_id, is_primary, assigned_date, is_active) FROM stdin;
108	1003	t	2026-10-17	t
106	1003	t	2026-10-17	t
104	1003	t	2026-10-17	t
110	1001	t	2026-10-17	t
107	1001	t	2026-10-17	t
103	1001	t	2026-10-17	t
101	1001	t	2026-10-17	t
109	1002	t	2026-10-17	t
105	1002	t	2026-10-17	t
102	1002	t	2026-10-17	t
125	1021	t	2026-11-05	t
127	1022	t	2026-11-05	t
123	1002	t	2026-11-05	t
119	1003	t	2026-11-05	t
114	1003	t	2026-11-05	t
120	1022	t	2026-11-05	t
126	1002	t	2026-11-05	t
129	1002	t	2026-11-05	t
113	1021	t	2026-11-05	t
124	1022	t	2026-11-05	t
121	1022	t	2026-11-05	t
115	1003	t	2026-11-05	t
1	1021	t	2026-11-05	t
116	1001	t	2026-11-05	t
118	1002	t	2026-11-05	t
112	1001	t	2026-11-05	t
111	1022	t	2026-11-05	t
128	1022	t	2026-11-05	t
117	1001	t	2026-11-05	t
122	1021	t	2026-11-10	t
131	1021	t	2026-11-11	t
130	1021	t	2026-11-11	t
132	1001	t	2026-11-12	t
\.


--
-- Data for Name: patient_vitals; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.patient_vitals (vitals_id, patient_id, appointment_id, recorded_by_employee_id, temperature, heartrate_bpm, systolic_bp, diastolic_bp, weight_lbs, height_inches, recorded_at, respiratory_rate, oxygen_saturation) FROM stdin;
198	101	1	1010	98.00	76	114	77	141.50	65.00	2026-02-11 13:06:00	15	99
199	101	3	1013	98.00	71	114	77	143.40	65.00	2026-04-09 13:35:00	16	98
200	101	4	1009	99.00	77	113	77	142.60	65.00	2026-04-16 14:06:00	18	96
201	101	6	1013	99.20	76	118	74	142.20	65.00	2026-04-24 15:08:00	15	99
202	105	7	1011	98.60	67	116	66	118.30	64.00	2026-04-27 10:38:00	15	97
203	105	8	1010	98.30	71	104	71	119.30	64.00	2026-05-01 14:06:00	16	98
204	101	9	1010	98.60	75	114	74	144.90	65.00	2026-05-07 08:10:00	15	99
205	104	10	1010	98.40	81	139	88	211.80	70.00	2026-05-08 09:06:00	17	98
206	105	11	1012	98.00	64	110	68	119.00	64.00	2026-05-11 10:10:00	14	97
207	101	13	1012	98.00	78	122	79	142.40	65.00	2026-05-22 11:36:00	15	97
208	101	14	1009	97.90	75	114	75	141.10	65.00	2026-05-22 16:06:00	16	99
209	104	15	1013	99.20	84	145	89	208.30	70.00	2026-05-26 08:39:00	17	97
210	103	16	1013	99.00	90	112	74	128.60	63.50	2026-05-29 10:40:00	15	98
211	101	17	1012	98.70	79	124	73	141.90	65.00	2026-05-29 11:05:00	14	98
212	102	18	1009	99.20	70	121	82	183.40	69.00	2026-06-03 11:35:00	15	96
213	106	20	1013	98.50	64	138	87	194.10	72.00	2026-06-11 15:09:00	15	97
214	107	21	1013	98.90	114	101	70	129.40	66.00	2026-06-12 11:39:00	15	98
215	107	23	1013	99.10	109	108	67	133.00	66.00	2026-06-15 16:35:00	15	97
216	105	24	1013	98.10	74	113	67	119.20	64.00	2026-06-17 15:40:00	15	99
217	105	25	1012	98.20	75	108	68	118.40	64.00	2026-07-06 09:06:00	15	97
218	105	26	1011	98.70	69	105	70	120.90	64.00	2026-07-08 09:35:00	14	99
219	105	29	1013	98.60	75	112	69	121.70	64.00	2026-07-16 09:40:00	14	99
220	106	30	1012	98.50	69	133	88	196.70	72.00	2026-07-21 10:08:00	14	96
221	105	31	1012	98.50	64	114	72	121.70	64.00	2026-07-22 11:06:00	17	99
222	102	32	1013	99.20	67	119	84	181.90	69.00	2026-07-29 09:08:00	15	96
223	107	33	1011	99.00	105	102	65	130.40	66.00	2026-08-04 11:08:00	17	96
224	101	34	1010	98.90	78	123	79	143.80	65.00	2026-08-04 11:35:00	18	96
225	105	35	1009	98.50	66	107	74	121.50	64.00	2026-08-04 11:40:00	17	98
226	104	37	1011	98.80	75	142	91	208.30	70.00	2026-08-10 13:06:00	18	98
227	101	38	1010	98.00	69	114	77	142.00	65.00	2026-08-17 11:10:00	18	96
228	103	39	1011	98.40	78	107	71	129.90	63.50	2026-08-25 09:37:00	15	98
229	106	40	1010	98.30	70	131	85	195.40	72.00	2026-08-28 09:38:00	14	97
230	102	41	1009	98.20	67	122	81	181.60	69.00	2026-08-28 10:07:00	15	98
231	107	42	1010	98.10	111	99	62	132.80	66.00	2026-09-01 08:09:00	18	96
232	105	43	1012	98.50	67	109	70	121.00	64.00	2026-09-01 08:06:00	15	99
233	106	44	1012	97.90	70	135	85	193.50	72.00	2026-09-01 10:08:00	15	97
234	106	46	1012	97.90	66	137	83	193.30	72.00	2026-09-03 08:40:00	18	97
235	106	47	1012	98.30	69	137	81	195.40	72.00	2026-09-03 15:05:00	18	97
236	109	48	1010	98.50	63	116	71	152.00	64.00	2026-09-07 14:37:00	15	96
237	102	49	1009	98.80	77	124	77	180.10	69.00	2026-09-08 14:07:00	16	99
238	107	53	1011	99.20	108	99	64	132.60	66.00	2026-09-11 09:05:00	17	99
239	103	54	1013	98.90	80	113	68	129.90	63.50	2026-09-11 13:08:00	14	98
240	109	55	1013	98.00	57	112	73	150.90	64.00	2026-09-17 11:38:00	15	96
241	109	56	1010	99.00	66	113	71	148.30	64.00	2026-09-17 15:37:00	17	98
242	107	57	1013	98.10	106	110	62	130.90	66.00	2026-09-18 15:06:00	15	99
243	108	58	1011	97.90	65	138	85	176.50	68.00	2026-09-22 11:39:00	17	96
244	106	61	1009	98.40	72	140	85	195.10	72.00	2026-09-25 10:36:00	16	99
245	110	62	1011	98.50	82	151	98	229.00	71.00	2026-09-25 15:05:00	18	97
246	108	63	1009	98.70	76	130	88	174.20	68.00	2026-09-28 15:05:00	18	98
247	102	66	1010	99.10	71	118	84	182.70	69.00	2026-09-30 16:35:00	18	98
248	101	67	1011	98.10	73	121	73	141.20	65.00	2026-10-01 08:36:00	14	98
249	109	68	1012	99.10	65	115	70	149.30	64.00	2026-10-01 15:38:00	18	96
250	106	69	1009	99.10	72	135	87	196.50	72.00	2026-10-02 16:09:00	16	98
251	109	71	1011	98.60	56	111	75	150.50	64.00	2026-10-05 15:09:00	18	96
252	109	72	1011	98.00	58	121	73	149.10	64.00	2026-10-06 13:39:00	17	96
253	107	73	1010	98.90	111	107	65	130.50	66.00	2026-10-07 08:35:00	18	96
254	110	75	1013	98.50	92	150	97	228.50	71.00	2026-10-13 10:09:00	17	97
255	102	77	1010	97.80	69	125	83	183.70	69.00	2026-10-14 14:37:00	16	97
256	110	78	1009	98.10	91	152	100	228.70	71.00	2026-10-16 09:09:00	17	98
257	106	79	1012	98.40	63	138	82	195.40	72.00	2026-10-19 09:38:00	17	98
258	106	81	1013	98.90	68	135	83	196.80	72.00	2026-10-19 16:07:00	16	98
259	105	82	1009	98.20	64	111	74	120.70	64.00	2026-10-20 15:37:00	16	98
260	108	83	1013	98.00	71	137	86	174.40	68.00	2026-10-21 09:36:00	18	98
261	110	84	1011	97.90	88	154	97	226.10	71.00	2026-10-21 13:40:00	17	97
263	108	123	1025	98.50	75	122	78	178.70	65.10	2026-10-15 13:35:00	16	97
264	103	124	1013	99.40	87	106	71	145.90	71.80	2026-10-15 10:05:00	12	98
265	110	125	1011	99.00	80	131	69	169.50	75.60	2026-10-15 14:05:00	13	95
266	125	130	1012	99.20	85	109	79	123.20	63.00	2026-10-15 13:05:00	12	95
267	105	131	1012	98.00	91	138	65	210.30	72.20	2026-10-15 16:35:00	15	98
268	127	132	1012	98.70	64	135	68	151.40	74.40	2026-10-15 09:05:00	14	99
269	127	133	1026	98.70	91	132	81	123.60	66.30	2026-10-15 08:05:00	18	100
270	127	134	1010	98.90	68	117	83	199.20	71.20	2026-10-15 10:35:00	12	97
271	104	135	1025	98.90	81	128	82	207.40	62.70	2026-10-15 13:35:00	13	100
272	107	136	1026	98.00	70	144	89	157.30	61.20	2026-10-15 08:05:00	16	100
273	110	137	1009	99.00	65	114	67	141.50	68.70	2026-10-15 08:35:00	16	100
274	101	139	1025	98.10	61	139	66	212.20	64.60	2026-10-16 15:05:00	18	96
275	101	140	1009	98.40	69	118	78	173.60	62.20	2026-10-16 08:35:00	15	95
276	101	141	1009	98.40	75	124	73	158.00	63.00	2026-10-16 14:35:00	14	98
277	123	142	1010	98.00	61	124	88	199.50	71.00	2026-10-16 09:35:00	18	98
278	106	143	1025	99.30	63	106	83	211.20	67.20	2026-10-16 08:05:00	17	95
279	119	144	1013	97.90	60	136	79	201.90	74.40	2026-10-16 14:05:00	14	95
280	114	145	1011	98.90	85	117	72	135.60	72.40	2026-10-16 08:35:00	15	95
281	125	147	1010	99.00	64	115	89	194.70	74.90	2026-10-16 08:05:00	13	95
282	125	148	1027	99.40	80	143	72	228.80	71.30	2026-10-16 09:05:00	12	100
283	120	149	1027	99.30	90	127	81	203.50	60.60	2026-10-16 13:05:00	15	98
284	105	150	1012	98.90	84	124	71	185.30	68.00	2026-10-16 13:05:00	18	99
285	120	152	1027	98.80	81	119	65	180.80	62.10	2026-10-16 08:05:00	16	99
286	109	155	1027	99.10	78	120	79	223.50	74.80	2026-10-19 14:05:00	14	96
287	126	157	1010	99.30	74	118	68	121.40	61.10	2026-10-19 14:35:00	14	97
288	119	158	1013	99.20	94	118	84	150.00	74.10	2026-10-19 15:35:00	15	95
289	125	159	1027	98.70	84	113	75	224.00	72.80	2026-10-19 10:05:00	17	97
290	120	162	1012	98.80	75	114	66	149.60	66.00	2026-10-19 14:35:00	12	96
291	120	163	1026	98.70	79	125	89	209.90	61.40	2026-10-19 16:05:00	17	99
292	127	164	1012	98.80	94	113	65	215.80	70.40	2026-10-19 09:35:00	12	95
293	119	165	1011	98.20	94	106	89	124.30	60.10	2026-10-19 16:35:00	12	97
294	119	166	1027	99.30	69	134	87	146.90	73.20	2026-10-19 11:05:00	17	100
295	105	167	1025	98.40	86	122	67	193.20	68.30	2026-10-19 08:05:00	12	98
296	103	168	1025	98.50	62	127	85	224.80	61.80	2026-10-20 11:05:00	17	99
297	107	170	1013	98.70	76	143	76	203.70	70.50	2026-10-20 10:35:00	16	98
298	129	171	1013	98.40	92	126	75	136.50	72.30	2026-10-20 15:35:00	15	95
299	129	172	1013	98.30	61	142	69	208.20	60.10	2026-10-20 09:05:00	13	100
300	119	173	1025	98.50	87	127	85	200.10	73.00	2026-10-20 08:35:00	17	97
301	113	174	1012	98.80	67	119	73	223.00	70.50	2026-10-20 11:05:00	15	97
302	104	175	1012	97.80	68	131	82	193.40	72.50	2026-10-20 10:35:00	16	100
303	127	176	1026	98.10	71	141	83	189.70	66.00	2026-10-20 08:35:00	12	99
304	106	181	1010	98.80	81	132	88	141.10	71.00	2026-10-20 16:05:00	17	95
305	107	182	1009	98.00	72	105	79	138.80	66.20	2026-10-21 14:05:00	13	97
306	105	185	1027	98.20	77	135	71	171.70	68.90	2026-10-21 13:05:00	18	100
307	109	187	1010	98.90	86	116	88	137.80	70.30	2026-10-21 10:35:00	16	99
308	114	189	1011	97.90	82	116	84	185.20	75.70	2026-10-21 08:05:00	18	99
309	125	191	1027	97.90	62	140	80	135.10	70.90	2026-10-21 14:05:00	14	99
310	113	193	1027	99.20	62	130	83	187.60	61.50	2026-10-21 11:35:00	12	98
311	124	194	1026	97.80	92	126	69	155.40	60.60	2026-10-21 10:05:00	14	95
312	121	195	1027	99.00	94	119	67	139.70	68.00	2026-10-21 16:35:00	15	99
313	108	196	1011	98.30	74	113	68	179.40	63.80	2026-10-21 13:35:00	15	98
314	119	197	1026	98.50	76	140	73	165.50	75.90	2026-10-21 15:05:00	13	98
315	105	198	1011	97.80	65	110	82	144.40	64.50	2026-10-21 09:35:00	16	96
316	126	199	1011	99.00	72	110	71	151.40	69.50	2026-10-21 10:35:00	16	95
317	109	201	1012	99.10	65	128	65	195.60	68.60	2026-10-22 08:35:00	15	96
318	105	202	1012	99.30	61	116	74	174.00	67.50	2026-10-22 11:05:00	12	95
319	123	203	1027	99.30	92	125	88	210.30	69.00	2026-10-22 08:05:00	12	100
320	106	204	1011	98.90	84	112	86	134.10	67.70	2026-10-22 16:35:00	17	98
321	115	205	1011	98.60	71	127	78	209.70	72.80	2026-10-22 15:35:00	17	95
322	119	206	1025	98.90	64	127	68	222.70	72.20	2026-10-22 08:05:00	18	97
323	113	207	1010	98.70	85	109	67	168.60	61.10	2026-10-22 10:35:00	14	98
324	120	208	1012	98.80	69	123	67	221.30	63.00	2026-10-22 08:05:00	14	100
325	114	209	1026	99.30	93	137	83	125.30	61.40	2026-10-22 09:35:00	15	95
326	129	210	1009	97.90	65	114	73	154.70	67.40	2026-10-22 15:05:00	14	98
327	106	211	1012	98.60	79	109	82	228.40	75.90	2026-10-22 11:35:00	15	98
328	109	213	1027	98.20	63	133	70	128.90	63.60	2026-10-23 15:35:00	15	95
329	115	215	1011	98.80	75	117	80	158.70	65.50	2026-10-23 15:35:00	15	98
330	113	216	1026	98.60	80	112	86	211.90	74.90	2026-10-23 09:35:00	16	99
331	125	217	1026	99.00	76	118	75	161.50	61.90	2026-10-23 13:05:00	18	97
332	106	219	1012	98.70	62	137	80	185.20	73.30	2026-10-23 16:05:00	15	98
333	104	220	1009	99.20	88	125	88	198.80	70.70	2026-10-23 16:05:00	14	100
334	105	223	1026	98.80	72	144	83	151.00	63.70	2026-10-26 08:35:00	13	100
335	119	224	1009	99.20	64	109	70	219.80	72.20	2026-10-26 13:35:00	18	100
336	129	225	1011	99.00	69	105	83	131.00	73.40	2026-10-26 15:35:00	15	97
337	102	226	1012	98.20	79	111	73	170.50	71.00	2026-10-26 11:05:00	13	95
338	125	227	1026	98.00	76	114	75	184.40	61.70	2026-10-26 09:05:00	18	100
339	127	228	1026	98.30	60	127	84	141.90	60.60	2026-10-26 15:05:00	12	100
340	126	229	1011	99.30	91	126	85	200.90	64.50	2026-10-26 08:35:00	13	96
341	125	230	1027	98.90	76	123	84	127.00	63.50	2026-10-26 13:05:00	16	100
342	103	231	1013	98.90	92	119	74	173.30	65.00	2026-10-26 13:05:00	14	97
343	129	232	1027	99.40	86	142	73	193.90	73.30	2026-10-26 08:05:00	14	100
344	109	233	1013	98.00	83	141	65	185.00	62.10	2026-10-26 13:35:00	17	100
345	105	234	1009	98.50	61	108	68	178.30	72.80	2026-10-26 16:35:00	15	100
346	101	235	1025	98.00	76	125	67	171.30	68.70	2026-10-27 10:05:00	18	96
347	126	236	1011	98.10	82	135	69	184.70	66.30	2026-10-27 16:35:00	15	98
348	110	238	1013	98.50	79	144	65	147.10	61.40	2026-10-27 10:05:00	15	96
349	104	239	1013	99.10	76	115	67	187.80	61.30	2026-10-27 08:05:00	14	98
350	1	240	1027	98.80	68	107	89	195.00	60.30	2026-10-27 10:05:00	15	96
351	113	241	1010	99.10	71	108	87	224.50	73.00	2026-10-27 11:35:00	13	99
352	125	242	1012	99.00	65	136	78	173.60	69.10	2026-10-27 14:05:00	16	96
353	120	243	1027	98.50	65	106	68	161.50	73.30	2026-10-27 08:35:00	16	95
354	121	244	1027	98.80	88	117	78	155.50	72.40	2026-10-27 10:35:00	18	98
355	120	245	1025	98.60	62	138	71	134.00	63.20	2026-10-27 08:05:00	16	99
356	101	246	1026	98.50	91	107	70	157.10	69.60	2026-10-27 16:05:00	13	97
357	108	247	1010	97.80	74	111	72	189.70	65.60	2026-10-27 14:05:00	12	97
358	113	248	1012	99.30	93	109	80	155.70	63.30	2026-10-27 16:05:00	12	100
359	126	249	1026	98.50	64	110	82	205.80	65.20	2026-10-27 10:05:00	18	99
360	116	250	1013	99.20	84	125	82	202.20	70.00	2026-10-28 14:35:00	16	97
361	119	251	1011	98.70	80	135	81	191.10	68.20	2026-10-28 14:05:00	15	98
362	110	252	1011	98.60	88	112	81	212.40	73.90	2026-10-28 16:05:00	13	96
363	109	253	1027	98.80	85	120	70	193.30	61.80	2026-10-28 10:35:00	14	100
364	118	254	1027	99.20	94	122	86	225.40	67.90	2026-10-28 13:35:00	12	96
365	104	255	1009	99.20	78	134	87	187.90	65.50	2026-10-28 08:05:00	12	95
366	119	256	1025	99.00	81	137	86	190.80	61.80	2026-10-28 13:05:00	12	98
367	114	257	1013	98.00	67	123	82	181.00	71.50	2026-10-28 10:05:00	16	97
368	103	258	1027	98.50	91	132	72	121.60	75.90	2026-10-28 15:35:00	18	96
369	120	259	1010	98.50	94	121	65	189.40	72.30	2026-10-28 08:35:00	12	98
370	124	260	1012	98.80	68	131	84	227.20	71.60	2026-10-28 09:35:00	12	98
371	116	261	1013	98.50	67	143	67	181.10	62.10	2026-10-28 15:05:00	18	96
372	123	263	1013	97.90	81	132	77	185.90	61.80	2026-10-28 13:05:00	12	99
373	102	264	1010	99.20	87	118	87	163.90	75.60	2026-10-28 08:35:00	14	97
374	124	265	1009	98.40	70	144	87	143.10	68.10	2026-10-28 08:35:00	17	96
375	109	266	1013	99.30	85	118	66	157.60	64.30	2026-10-29 08:05:00	14	95
376	112	267	1013	97.90	81	131	88	191.30	63.80	2026-10-29 10:35:00	18	96
377	118	269	1026	99.30	82	106	74	169.70	60.60	2026-10-29 10:05:00	17	95
378	109	270	1010	97.90	61	136	70	148.70	65.10	2026-10-29 14:05:00	14	99
379	114	271	1025	98.20	66	107	86	218.70	61.40	2026-10-29 10:05:00	16	97
380	106	272	1025	99.10	61	132	77	161.80	65.20	2026-10-29 16:05:00	16	98
381	115	273	1009	99.10	72	116	89	187.50	66.60	2026-10-29 13:05:00	17	99
382	116	274	1010	98.30	92	128	88	212.00	71.00	2026-10-29 11:05:00	16	95
383	127	275	1010	97.90	66	129	75	124.80	66.30	2026-10-29 08:05:00	16	98
384	124	276	1010	97.90	91	122	77	127.20	61.60	2026-10-29 11:05:00	16	99
385	114	278	1026	98.40	76	113	85	153.30	67.10	2026-10-29 13:05:00	15	96
386	104	279	1011	99.10	83	120	67	178.60	75.00	2026-10-29 13:05:00	17	100
387	108	280	1025	98.10	94	122	79	160.90	73.60	2026-10-30 09:35:00	14	97
388	123	281	1012	99.40	71	128	67	222.20	61.70	2026-10-30 16:35:00	13	99
389	123	282	1010	99.40	71	121	66	218.10	64.90	2026-10-30 15:05:00	12	98
390	120	283	1012	98.10	82	113	79	128.40	69.20	2026-10-30 09:35:00	15	99
391	114	284	1013	98.50	64	119	72	138.30	71.10	2026-10-30 13:05:00	12	100
392	104	286	1026	99.00	69	125	68	182.40	74.70	2026-10-30 10:05:00	18	99
393	125	288	1013	98.50	85	118	73	144.70	74.40	2026-10-30 11:35:00	16	98
394	113	289	1027	98.70	73	124	81	162.60	61.00	2026-10-30 09:05:00	15	97
395	116	290	1011	98.50	81	114	87	168.40	66.60	2026-11-02 09:35:00	17	95
396	101	292	1025	99.00	85	112	84	126.00	62.50	2026-11-02 08:05:00	18	95
397	118	293	1010	98.80	93	133	67	208.40	61.80	2026-11-02 13:35:00	13	98
398	126	295	1010	97.90	84	110	72	122.30	73.90	2026-11-02 11:05:00	16	96
399	115	296	1009	99.30	74	118	65	187.30	72.90	2026-11-02 13:05:00	17	100
400	118	297	1010	98.50	84	135	74	129.50	70.90	2026-11-02 15:35:00	18	98
401	110	299	1027	98.80	81	127	78	214.20	60.70	2026-11-02 14:35:00	13	96
402	111	300	1026	98.20	81	111	83	124.20	64.10	2026-11-02 08:35:00	13	100
403	103	301	1026	99.20	69	118	71	164.20	65.90	2026-11-02 08:05:00	16	99
404	107	302	1009	97.90	89	122	83	163.40	69.20	2026-11-02 11:35:00	17	99
405	126	303	1012	99.40	88	138	82	151.90	67.90	2026-11-02 15:35:00	17	99
406	103	304	1013	98.20	83	110	88	136.10	62.50	2026-11-02 15:05:00	14	99
407	114	305	1011	99.20	93	125	83	154.50	68.20	2026-11-02 14:35:00	15	99
408	129	307	1013	98.50	87	127	89	206.90	62.60	2026-11-03 10:05:00	15	100
409	129	308	1013	98.20	72	140	77	221.10	68.20	2026-11-03 09:35:00	15	96
410	118	309	1025	99.40	70	111	83	222.60	72.70	2026-11-03 13:35:00	18	97
411	104	310	1009	99.40	90	122	73	217.70	70.00	2026-11-03 13:35:00	12	97
412	104	311	1011	97.90	62	120	86	135.20	73.00	2026-11-03 10:05:00	17	99
413	104	312	1009	99.10	94	124	78	169.20	61.70	2026-11-03 13:05:00	13	100
414	125	313	1012	99.10	82	143	78	209.80	72.90	2026-11-03 10:05:00	17	100
415	111	314	1026	98.30	86	126	89	188.10	62.80	2026-11-03 13:35:00	18	100
416	121	315	1026	98.90	64	107	81	160.20	63.90	2026-11-03 11:35:00	13	99
417	124	316	1009	98.00	92	118	81	164.30	68.70	2026-11-03 16:35:00	15	95
418	103	318	1025	99.40	88	133	77	180.00	66.40	2026-11-04 16:05:00	16	96
419	105	319	1012	98.30	92	137	89	179.40	68.40	2026-11-04 08:35:00	13	96
420	123	320	1009	98.30	83	119	79	150.30	65.90	2026-11-04 09:35:00	18	98
421	116	321	1010	98.90	65	114	69	154.30	69.80	2026-11-04 14:35:00	16	95
422	113	322	1010	98.80	77	115	77	225.80	65.70	2026-11-04 16:05:00	18	100
423	128	324	1010	98.50	63	138	83	167.10	62.50	2026-11-04 10:05:00	13	100
424	116	325	1010	98.40	92	119	88	143.30	73.10	2026-11-04 08:05:00	13	96
425	106	326	1009	99.30	92	106	66	178.60	74.50	2026-11-04 14:05:00	17	96
426	119	327	1026	98.40	89	119	73	188.10	74.80	2026-11-04 10:05:00	13	97
427	113	333	1012	98.90	84	113	83	223.90	62.20	2026-11-05 11:05:00	13	96
428	125	334	1010	98.60	63	125	67	163.40	72.80	2026-11-05 11:35:00	18	95
429	120	335	1026	97.90	64	128	70	193.00	64.40	2026-11-05 11:35:00	12	99
430	104	336	1012	98.90	92	116	80	208.00	75.90	2026-11-05 08:05:00	18	100
431	112	338	1011	99.10	88	105	76	123.00	62.50	2026-11-05 08:05:00	18	95
439	110	574	1034	92.00	110	120	80	180.00	57.00	2026-11-11 22:32:32.793904	40	95
440	101	85	1026	99.00	75	128	78	124.20	62.50	2026-10-23 15:29:00	14	99
441	107	108	1025	98.50	80	114	83	163.20	69.20	2026-10-26 09:13:00	16	98
442	106	87	1010	98.20	71	117	75	177.80	74.50	2026-10-26 16:38:00	13	99
443	114	111	1027	98.90	109	145	94	155.50	68.20	2026-10-28 08:03:00	14	97
444	114	112	1011	99.20	71	113	83	152.60	68.20	2026-10-28 08:41:00	13	96
445	114	113	1013	98.80	72	115	73	153.10	68.20	2026-10-28 09:16:00	12	98
446	106	88	1027	98.80	82	110	84	180.90	74.50	2026-10-28 11:28:00	17	100
447	113	110	1025	98.10	85	113	72	226.50	62.20	2026-10-29 08:01:00	14	99
448	109	90	1034	99.10	79	116	77	149.00	65.10	2026-10-29 16:16:00	16	99
449	110	115	1013	98.60	76	132	78	179.20	57.00	2026-10-30 11:10:00	15	96
450	118	117	1013	98.80	85	115	70	225.50	72.70	2026-10-30 16:32:00	17	99
451	118	331	1010	98.80	81	108	68	221.00	72.70	2026-11-05 13:05:00	15	96
452	117	330	1011	98.60	74	118	78	120.00	62.00	2026-11-05 13:33:00	12	98
453	114	332	1013	97.70	81	121	75	154.80	68.20	2026-11-05 14:37:00	16	99
454	117	329	1011	98.70	75	122	82	144.00	65.00	2026-11-05 15:01:00	15	99
455	103	328	1009	99.10	90	119	78	179.60	66.40	2026-11-05 16:02:00	16	97
456	114	337	1011	99.00	72	114	82	155.10	68.20	2026-11-05 16:29:00	15	99
457	112	340	1034	98.10	82	122	82	124.60	62.50	2026-11-06 08:02:00	13	97
458	118	342	1009	98.50	89	115	77	223.00	72.70	2026-11-06 10:36:00	14	100
459	123	344	1012	98.20	74	120	78	151.20	65.90	2026-11-06 12:56:00	15	96
460	123	341	1012	98.90	63	131	82	149.80	65.90	2026-11-06 13:36:00	12	97
461	127	347	1013	98.80	65	125	77	125.70	66.30	2026-11-06 13:29:00	15	99
462	108	343	1011	98.80	65	126	77	160.00	73.60	2026-11-06 14:07:00	16	99
463	110	548	1010	98.30	66	124	84	178.40	57.00	2026-11-06 15:58:00	15	98
464	124	356	1025	98.90	70	113	79	161.80	68.70	2026-11-09 08:28:00	17	96
465	127	354	1026	98.10	73	111	82	125.00	66.30	2026-11-09 09:34:00	17	96
466	101	359	1025	97.90	73	113	76	128.80	62.50	2026-11-09 09:34:00	13	97
467	118	351	1012	99.20	67	128	77	222.60	72.70	2026-11-09 10:06:00	17	99
468	108	358	1010	98.00	65	132	77	163.60	73.60	2026-11-09 09:58:00	17	96
469	119	353	1027	99.00	65	130	70	187.60	74.80	2026-11-09 13:38:00	14	96
470	101	349	1025	98.50	86	132	68	127.60	62.50	2026-11-09 14:13:00	12	100
471	110	550	1010	98.10	77	113	69	182.10	57.00	2026-11-09 14:46:00	12	100
472	110	549	1026	98.60	69	108	69	180.90	57.00	2026-11-09 15:11:00	15	96
473	115	352	1011	98.70	92	108	81	187.30	72.90	2026-11-09 16:33:00	17	98
474	116	357	1013	98.20	77	118	77	152.90	69.80	2026-11-09 16:43:00	17	97
475	105	363	1034	98.90	92	130	81	178.10	68.40	2026-11-10 08:30:00	13	97
476	114	364	1011	98.40	75	131	78	154.80	68.20	2026-11-10 09:14:00	15	98
477	112	368	1027	97.80	68	114	74	120.50	62.50	2026-11-10 09:04:00	18	96
478	123	369	1011	98.00	71	122	81	149.20	65.90	2026-11-10 08:59:00	16	97
479	101	93	1013	99.10	85	127	76	128.50	62.50	2026-11-10 09:40:00	13	97
480	104	370	1027	97.70	73	118	83	210.50	75.90	2026-11-10 09:28:00	14	100
481	120	367	1026	97.80	92	128	71	192.10	64.40	2026-11-10 09:57:00	15	97
482	120	366	1026	98.10	83	131	74	191.80	64.40	2026-11-10 10:45:00	16	96
483	120	362	1034	98.70	90	124	68	191.30	64.40	2026-11-10 11:07:00	15	98
484	110	551	1010	98.90	60	128	78	177.90	57.00	2026-11-10 11:24:00	18	99
485	103	94	1012	99.00	81	110	81	180.40	66.40	2026-11-10 13:11:00	17	96
486	123	361	1034	98.70	69	110	77	152.30	65.90	2026-11-10 13:11:00	12	97
487	110	553	1010	98.80	77	114	72	178.30	57.00	2026-11-10 13:08:00	15	98
488	110	552	1013	98.50	62	114	69	181.30	57.00	2026-11-10 13:32:00	12	97
489	110	556	1027	98.70	70	115	82	180.10	57.00	2026-11-10 15:09:00	14	99
490	129	371	1013	98.50	81	116	77	205.40	62.60	2026-11-10 15:56:00	18	97
491	103	360	1025	98.80	60	120	77	177.50	66.40	2026-11-10 16:36:00	15	100
492	122	365	1027	99.10	90	119	77	179.00	61.00	2026-11-10 16:37:00	14	99
493	111	375	1034	98.50	91	124	76	186.50	62.80	2026-11-11 07:59:00	18	98
494	110	558	1025	98.50	66	115	70	180.50	57.00	2026-11-11 08:32:00	17	97
495	125	377	1012	98.00	63	110	81	160.70	72.80	2026-11-11 10:57:00	17	100
496	129	379	1010	98.30	71	123	68	205.00	62.60	2026-11-11 11:07:00	13	98
497	120	378	1010	98.20	64	128	73	192.50	64.40	2026-11-11 11:31:00	12	99
498	101	380	1026	98.70	81	116	69	128.40	62.50	2026-11-11 13:02:00	15	98
499	131	575	1026	97.90	61	108	78	138.00	64.00	2026-11-11 13:41:00	16	96
500	125	376	1026	97.60	81	111	82	166.30	72.80	2026-11-11 14:33:00	13	97
501	105	373	1010	98.50	71	115	83	180.90	68.40	2026-11-11 15:10:00	17	98
502	130	559	1027	98.50	70	118	83	148.00	61.00	2026-11-11 16:14:00	14	98
503	113	394	1012	98.20	85	120	75	223.20	62.20	2026-11-12 08:04:00	18	96
504	110	576	1012	97.60	75	123	73	180.20	57.00	2026-11-12 08:02:00	15	96
505	110	577	1010	99.10	76	122	77	177.30	57.00	2026-11-12 08:25:00	15	100
506	114	387	1034	98.10	85	125	68	157.20	68.20	2026-11-12 09:10:00	15	99
507	132	584	1013	98.80	65	132	70	146.00	64.00	2026-11-12 09:04:00	15	97
508	104	390	1012	98.70	81	130	84	206.90	75.90	2026-11-12 09:28:00	15	98
509	107	392	1010	98.60	80	129	76	160.90	69.20	2026-11-12 10:05:00	16	99
510	126	396	1013	98.00	70	109	82	149.90	67.90	2026-11-12 10:02:00	12	100
511	104	388	1034	97.90	70	112	71	209.50	75.90	2026-11-12 10:37:00	18	96
512	128	391	1034	98.30	62	108	79	167.80	62.50	2026-11-12 11:13:00	13	98
513	112	381	1034	98.70	90	113	82	123.60	62.50	2026-11-12 14:03:00	12	100
514	111	393	1034	98.10	60	129	81	188.50	62.80	2026-11-12 14:33:00	18	100
515	110	592	1034	98.00	119	120	80	190.00	157.00	2026-11-12 18:33:48.266632	14	95
\.


--
-- Data for Name: payment; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payment (payment_id, invoice_id, payment_type_id, handled_by, amount_paid, payment_date, status) FROM stdin;
531	57	5	1014	165.00	2026-10-19	Completed
532	34	5	1016	175.00	2026-09-07	Completed
533	28	5	1016	215.00	2026-08-09	Completed
534	24	5	1014	120.00	2026-08-10	Completed
535	19	5	1014	175.00	2026-06-24	Completed
536	10	5	1016	165.00	2026-05-31	Completed
537	8	5	1016	210.00	2026-05-22	Completed
538	3	5	1016	175.00	2026-04-21	Completed
539	48	6	\N	150.00	2026-10-14	Completed
540	46	6	1014	190.00	2026-09-22	Completed
541	36	6	\N	175.00	2026-09-09	Completed
542	35	6	1015	250.00	2026-09-05	Completed
543	33	6	\N	320.00	2026-09-03	Completed
544	30	6	1015	190.00	2026-08-26	Completed
545	27	6	1016	210.00	2026-08-12	Completed
546	18	6	1014	200.00	2026-06-23	Completed
547	5	6	1016	280.00	2026-05-03	Completed
548	1	6	\N	150.00	2026-03-03	Completed
549	60	7	1014	84.00	2026-10-21	Completed
550	56	7	1015	315.00	2026-10-08	Completed
551	54	7	1015	47.50	2026-10-21	Completed
552	45	7	1014	175.00	2026-10-04	Completed
553	42	7	1014	265.00	2026-09-24	Completed
554	41	7	1014	70.00	2026-09-30	Completed
555	39	7	1014	300.00	2026-09-12	Completed
556	38	7	1015	210.00	2026-09-12	Completed
557	31	7	1016	175.00	2026-09-12	Completed
558	26	7	1015	320.00	2026-08-22	Completed
559	22	7	1016	295.00	2026-07-20	Completed
560	21	7	1015	170.00	2026-07-21	Completed
561	20	7	1015	150.00	2026-07-16	Completed
562	17	7	1015	175.00	2026-06-25	Completed
563	16	7	1016	150.00	2026-06-24	Completed
564	14	7	1014	210.00	2026-06-10	Completed
565	13	7	1014	215.00	2026-06-05	Completed
566	9	7	1014	150.00	2026-05-23	Completed
567	7	7	1016	165.00	2026-05-19	Completed
568	2	7	1014	320.00	2026-04-28	Completed
569	62	8	\N	280.00	2026-10-21	Completed
570	61	8	\N	175.00	2026-10-21	Completed
571	53	8	\N	235.00	2026-10-19	Completed
572	52	8	1016	250.00	2026-10-03	Completed
573	44	8	\N	210.00	2026-10-03	Completed
574	43	8	\N	190.00	2026-10-03	Completed
575	40	8	1016	240.00	2026-09-24	Completed
576	37	8	\N	250.00	2026-09-20	Completed
577	32	8	\N	325.00	2026-09-07	Completed
578	29	8	\N	190.00	2026-08-22	Completed
579	25	8	\N	215.00	2026-08-13	Completed
580	23	8	\N	165.00	2026-07-30	Completed
581	15	8	\N	150.00	2026-06-03	Completed
582	12	8	\N	150.00	2026-05-27	Completed
583	4	8	\N	210.00	2026-05-07	Completed
642	114	6	\N	75.00	2026-10-24	Completed
643	115	7	\N	175.00	2026-10-22	Completed
644	116	5	1030	190.00	2026-10-21	Completed
645	117	7	\N	183.00	2026-10-22	Completed
646	118	5	1029	221.00	2026-10-21	Completed
647	119	7	\N	210.00	2026-10-21	Completed
648	120	7	\N	250.00	2026-10-24	Completed
649	121	8	\N	300.00	2026-11-05	Completed
607	64	7	1014	190.00	2026-10-25	Completed
608	21	6	1014	170.00	2026-10-27	Completed
610	70	6	\N	97.50	2026-10-17	Completed
611	72	6	1015	168.00	2026-10-15	Completed
612	74	6	\N	87.50	2026-10-15	Completed
613	75	6	\N	150.00	2026-10-15	Completed
614	77	6	1029	195.00	2026-10-15	Completed
615	80	9	1015	250.00	2026-10-15	Completed
616	81	5	1014	150.00	2026-10-16	Completed
617	84	8	\N	150.00	2026-11-05	Completed
618	85	7	\N	175.00	2026-10-16	Refunded
619	86	8	\N	175.00	2026-11-05	Completed
620	87	7	\N	175.00	2026-10-19	Completed
621	88	6	\N	110.00	2026-10-19	Completed
622	89	6	\N	87.50	2026-10-17	Completed
623	91	7	\N	200.00	2026-10-18	Completed
624	93	9	1030	158.00	2026-10-19	Completed
625	95	8	\N	175.00	2026-11-05	Completed
626	95	8	\N	8.00	2026-11-05	Completed
627	96	6	\N	115.00	2026-10-20	Completed
628	97	6	1016	170.00	2026-10-19	Completed
629	98	6	\N	105.00	2026-10-20	Completed
630	99	7	\N	200.00	2026-10-19	Completed
631	100	8	\N	250.00	2026-11-05	Completed
632	100	8	\N	8.00	2026-11-05	Completed
633	101	8	\N	300.00	2026-11-05	Completed
634	102	5	1014	290.00	2026-10-19	Completed
635	103	5	1014	150.00	2026-10-20	Completed
636	105	5	1014	150.00	2026-10-20	Completed
637	106	7	\N	175.00	2026-10-23	Requested
638	107	8	\N	175.00	2026-11-05	Completed
639	107	8	\N	22.00	2026-11-05	Completed
640	108	6	\N	175.00	2026-10-20	Completed
641	112	6	\N	95.00	2026-10-24	Completed
650	121	8	\N	50.00	2026-11-05	Completed
651	121	8	\N	22.00	2026-11-05	Completed
652	122	9	1015	225.00	2026-10-21	Completed
653	123	7	\N	345.00	2026-10-23	Completed
654	124	6	\N	150.00	2026-10-25	Completed
655	125	6	\N	158.00	2026-10-23	Completed
656	126	8	\N	150.00	2026-11-05	Completed
657	126	8	\N	50.00	2026-11-05	Completed
658	127	5	1015	175.00	2026-10-22	Completed
659	128	7	\N	181.00	2026-10-23	Completed
660	129	8	\N	175.00	2026-11-05	Completed
661	129	8	\N	65.00	2026-11-05	Completed
662	130	7	\N	197.00	2026-10-22	Completed
663	131	5	1016	150.00	2026-10-22	Completed
664	133	5	1028	250.00	2026-10-22	Requested
665	134	5	1030	275.00	2026-10-22	Completed
666	135	6	\N	150.00	2026-10-26	Completed
667	136	6	\N	175.00	2026-10-24	Completed
668	137	9	1016	248.00	2026-10-23	Completed
669	139	7	\N	245.00	2026-10-23	Completed
670	141	6	\N	81.00	2026-10-26	Completed
671	142	8	\N	175.00	2026-11-05	Completed
672	143	7	\N	200.00	2026-10-26	Completed
673	144	9	1030	175.00	2026-10-26	Refunded
674	145	6	\N	96.50	2026-10-28	Completed
675	150	9	1029	300.00	2026-10-26	Completed
676	153	7	\N	150.00	2026-10-30	Completed
677	154	9	1015	150.00	2026-10-27	Completed
678	155	6	\N	78.00	2026-10-29	Completed
679	156	6	\N	98.50	2026-10-30	Completed
680	157	7	\N	235.00	2026-10-27	Completed
681	158	6	\N	112.50	2026-10-29	Completed
682	160	6	\N	75.00	2026-10-27	Completed
683	161	6	\N	150.00	2026-10-30	Completed
684	164	6	\N	152.50	2026-10-29	Completed
685	165	6	\N	322.00	2026-10-29	Completed
686	166	6	\N	275.00	2026-10-29	Completed
687	167	6	1015	150.00	2026-10-28	Completed
688	168	8	\N	150.00	2026-11-05	Completed
689	168	8	\N	65.00	2026-11-05	Completed
690	168	8	\N	18.00	2026-11-05	Completed
691	169	6	\N	150.00	2026-10-30	Completed
692	170	5	1016	156.00	2026-10-28	Completed
693	172	5	1014	200.00	2026-10-28	Completed
694	173	8	\N	175.00	2026-11-05	Completed
695	174	9	1015	175.00	2026-10-28	Completed
696	178	6	1014	275.00	2026-10-28	Completed
697	179	8	\N	250.00	2026-11-05	Completed
698	179	8	\N	25.00	2026-11-05	Completed
699	180	9	1030	322.00	2026-10-28	Completed
700	181	6	\N	156.00	2026-10-29	Completed
701	185	7	\N	195.00	2026-10-29	Completed
702	186	7	\N	175.00	2026-10-30	Completed
703	188	6	\N	87.50	2026-11-01	Completed
704	189	5	1030	230.00	2026-10-29	Refunded
705	190	5	1016	168.00	2026-10-29	Completed
706	194	7	\N	156.00	2026-10-31	Completed
707	195	8	\N	150.00	2026-11-05	Completed
708	196	8	\N	150.00	2026-11-05	Completed
709	196	8	\N	15.00	2026-11-05	Completed
710	200	9	1028	250.00	2026-10-30	Completed
711	201	6	1016	320.00	2026-10-30	Completed
712	202	9	1015	150.00	2026-11-02	Refunded
713	206	7	\N	175.00	2026-11-05	Completed
714	209	6	\N	75.00	2026-11-03	Completed
715	210	6	1029	208.00	2026-11-02	Completed
716	211	6	\N	162.50	2026-11-03	Completed
717	212	6	\N	182.50	2026-11-02	Completed
718	215	7	\N	175.00	2026-11-06	Completed
719	216	6	1015	150.00	2026-11-03	Completed
720	217	5	1014	150.00	2026-11-03	Completed
721	218	7	\N	175.00	2026-11-05	Completed
722	219	6	1028	235.00	2026-11-03	Completed
723	220	5	1015	230.00	2026-11-03	Completed
724	221	6	\N	175.00	2026-11-04	Completed
725	223	6	\N	75.00	2026-11-06	Completed
726	226	6	\N	75.00	2026-11-07	Completed
727	227	8	\N	175.00	2026-11-05	Completed
728	229	6	\N	87.50	2026-11-04	Completed
729	230	8	\N	150.00	2026-11-05	Completed
730	230	8	\N	8.00	2026-11-05	Completed
731	231	6	\N	150.00	2026-11-05	Completed
732	233	8	\N	275.00	2026-11-05	Completed
771	269	8	\N	175.00	2026-11-12	Completed
733	234	9	1016	220.00	2026-11-05	Refunded
734	235	5	1030	175.00	2026-11-05	Completed
735	236	5	1030	156.00	2026-11-05	Completed
736	237	6	\N	127.50	2026-11-06	Completed
737	238	9	1015	247.00	2026-11-05	Completed
738	59	8	\N	175.00	2026-11-09	Completed
739	155	8	\N	78.00	2026-11-09	Completed
740	208	8	\N	200.00	2026-11-09	Completed
741	237	5	1017	127.50	2026-11-11	Completed
742	234	5	1017	220.00	2026-11-11	Completed
743	163	6	\N	200.00	2026-11-11	Completed
744	203	6	\N	40.00	2026-11-12	Completed
745	203	6	\N	20.00	2026-11-12	Completed
746	203	6	\N	20.00	2026-11-12	Completed
747	203	6	\N	20.00	2026-11-12	Completed
748	203	6	\N	20.00	2026-11-12	Completed
749	240	6	\N	365.00	2026-10-25	Completed
750	241	7	\N	150.00	2026-10-30	Completed
751	243	5	1016	210.00	2026-10-28	Completed
752	244	5	1014	156.00	2026-10-28	Completed
753	246	9	1016	175.00	2026-10-28	Completed
754	247	9	1014	175.00	2026-10-29	Completed
755	248	7	\N	195.00	2026-11-02	Completed
756	249	8	\N	150.00	2026-11-08	Completed
757	249	8	\N	20.00	2026-11-08	Completed
758	250	9	1015	175.00	2026-10-30	Completed
759	252	6	\N	170.00	2026-11-05	Completed
760	253	5	1015	175.00	2026-11-05	Completed
761	258	5	1014	183.00	2026-11-06	Completed
762	259	8	\N	175.00	2026-11-12	Completed
763	259	8	\N	65.00	2026-11-12	Completed
764	259	8	\N	8.00	2026-11-12	Completed
765	260	8	\N	150.00	2026-11-12	Completed
766	263	8	\N	150.00	2026-11-12	Completed
767	263	8	\N	6.00	2026-11-12	Completed
768	265	5	1029	150.00	2026-11-09	Completed
769	267	6	1016	150.00	2026-11-09	Completed
770	268	7	1029	300.00	2026-11-09	Completed
772	269	8	\N	55.00	2026-11-12	Completed
773	270	6	\N	158.00	2026-11-12	Completed
774	271	8	\N	175.00	2026-11-12	Completed
775	271	8	\N	65.00	2026-11-12	Completed
776	272	8	\N	175.00	2026-11-12	Completed
777	272	8	\N	60.00	2026-11-12	Completed
778	273	5	1028	230.00	2026-11-09	Completed
779	276	6	\N	175.00	2026-11-12	Completed
780	278	8	\N	275.00	2026-11-12	Completed
781	278	8	\N	50.00	2026-11-12	Completed
782	278	8	\N	20.00	2026-11-12	Completed
783	280	6	\N	225.00	2026-11-12	Completed
784	283	6	\N	210.00	2026-11-10	Completed
785	284	8	\N	175.00	2026-11-12	Completed
786	284	8	\N	25.00	2026-11-12	Completed
787	284	8	\N	45.00	2026-11-12	Completed
788	285	5	1029	345.00	2026-11-10	Completed
789	286	8	\N	150.00	2026-11-12	Completed
790	286	8	\N	40.00	2026-11-12	Completed
791	287	8	\N	175.00	2026-11-12	Completed
792	287	8	\N	40.00	2026-11-12	Completed
793	288	8	\N	150.00	2026-11-12	Completed
794	289	8	\N	175.00	2026-11-12	Completed
795	294	8	\N	175.00	2026-11-12	Completed
796	294	8	\N	8.00	2026-11-12	Completed
797	295	5	1030	225.00	2026-11-11	Completed
798	298	6	\N	400.00	2026-11-12	Completed
799	304	8	\N	175.00	2026-11-12	Completed
800	305	8	\N	150.00	2026-11-12	Completed
801	307	9	1014	150.00	2026-11-12	Completed
802	312	8	\N	275.00	2026-11-12	Completed
803	314	6	\N	295.00	2026-11-12	Completed
804	279	6	\N	20.00	2026-11-12	Completed
805	279	6	\N	10.00	2026-11-12	Completed
806	279	6	\N	20.00	2026-11-12	Completed
807	279	6	\N	20.00	2026-11-12	Completed
808	279	6	\N	20.00	2026-11-12	Completed
809	320	8	\N	25.00	2026-11-14	Completed
\.


--
-- Data for Name: payment_type; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payment_type (payment_type_id, name, is_active) FROM stdin;
5	Cash	t
6	Credit Card	t
7	Debit Card	t
8	Insurance	t
9	Check	t
\.


--
-- Data for Name: prescription; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.prescription (prescription_id, patient_id, prescriber_id, appointment_id, date_prescribed, is_active) FROM stdin;
18	104	1003	\N	2026-06-20	t
19	106	1003	\N	2026-07-30	t
20	109	1002	\N	2026-09-25	t
21	103	1001	\N	2026-09-02	t
22	105	1002	8	2026-10-23	t
28	110	1001	125	2026-10-15	t
29	127	1022	133	2026-10-15	t
30	127	1022	134	2026-10-15	t
31	104	1004	135	2026-10-15	t
32	125	1021	147	2026-10-16	t
33	120	1007	152	2026-10-16	t
34	109	1002	155	2026-10-19	t
35	119	1003	158	2026-10-19	t
36	120	1022	162	2026-10-19	t
37	119	1006	165	2026-10-19	t
38	107	1002	170	2026-10-20	t
39	119	1003	173	2026-10-20	t
40	106	1024	181	2026-10-20	t
41	105	1002	185	2026-10-21	t
42	125	1021	191	2026-10-21	t
43	113	1021	193	2026-10-21	t
44	124	1022	194	2026-10-21	t
45	119	1007	197	2026-10-21	t
46	126	1023	199	2026-10-21	t
47	105	1002	202	2026-10-22	t
48	115	1003	205	2026-10-22	t
49	113	1021	207	2026-10-22	t
50	113	1021	216	2026-10-23	t
51	125	1021	217	2026-10-23	t
52	106	1005	219	2026-10-23	t
53	105	1002	223	2026-10-26	t
54	125	1021	227	2026-10-26	t
55	127	1022	228	2026-10-26	t
56	125	1005	230	2026-10-26	t
57	110	1002	238	2026-10-27	t
58	104	1003	239	2026-10-27	t
59	125	1021	242	2026-10-27	t
60	120	1004	245	2026-10-27	t
61	113	1007	248	2026-10-27	t
62	119	1001	251	2026-10-28	t
63	109	1002	253	2026-10-28	t
64	118	1002	254	2026-10-28	t
65	103	1021	258	2026-10-28	t
66	120	1022	259	2026-10-28	t
67	124	1022	260	2026-10-28	t
68	102	1007	264	2026-10-28	t
69	124	1023	265	2026-10-28	t
70	118	1002	269	2026-10-29	t
71	109	1002	270	2026-10-29	t
72	127	1022	275	2026-10-29	t
73	124	1022	276	2026-10-29	t
74	114	1005	278	2026-10-29	t
75	108	1001	280	2026-10-30	t
76	123	1002	282	2026-10-30	t
77	120	1002	283	2026-10-30	t
78	101	1001	292	2026-11-02	t
79	103	1005	301	2026-11-02	t
80	107	1006	302	2026-11-02	t
81	111	1021	314	2026-11-03	t
82	124	1023	316	2026-11-03	t
83	128	1022	324	2026-11-04	t
84	120	1022	335	2026-11-05	t
85	112	1008	338	2026-11-05	t
86	114	1001	112	2026-10-28	t
87	114	1001	113	2026-10-28	t
88	109	1001	90	2026-10-29	t
89	110	1001	115	2026-10-30	t
90	117	1001	330	2026-11-05	t
91	118	1003	342	2026-11-06	t
92	123	1021	344	2026-11-06	t
93	127	1004	347	2026-11-06	t
94	110	1002	548	2026-11-06	t
95	101	1001	349	2026-11-09	t
96	123	1004	369	2026-11-10	t
97	110	1021	551	2026-11-10	t
98	103	1007	94	2026-11-10	t
99	103	1001	360	2026-11-10	t
100	110	1003	558	2026-11-11	t
101	129	1005	379	2026-11-11	t
102	120	1022	378	2026-11-11	t
103	101	1007	380	2026-11-11	t
104	105	1002	373	2026-11-11	t
105	113	1007	394	2026-11-12	t
106	126	1023	396	2026-11-12	t
107	112	1001	381	2026-11-12	t
\.


--
-- Data for Name: prescription_item; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.prescription_item (prescription_item_id, prescription_id, medication_id, dosage, instructions, duration_days, is_active) FROM stdin;
89	88	7	2 puffs as needed	For shortness of breath	30	t
18	18	2	500 mg	Take with breakfast and dinner	90	t
19	19	3	20 mg	Take once daily at night	90	t
20	20	5	50 mcg	Take every morning on an empty stomach	42	t
21	21	7	2 puffs	Use every 4-6 hours as needed for wheezing	30	t
22	22	8	10 mg	\N	7	f
90	89	3	20 mg once daily	At night	30	t
29	28	5	25 mcg once daily	Empty stomach	30	t
30	29	1	10 mg once daily	In the morning	30	t
31	30	7	2 puffs as needed	For shortness of breath	30	t
32	31	3	20 mg once daily	At night	30	t
33	32	7	2 puffs as needed	For shortness of breath	30	t
34	33	7	2 puffs as needed	For shortness of breath	30	t
35	34	8	400 mg as needed	With food	7	t
36	35	8	400 mg as needed	With food	7	t
37	36	3	20 mg once daily	At night	30	t
38	37	8	400 mg as needed	With food	7	t
39	38	3	20 mg once daily	At night	30	t
40	39	6	20 mg once daily	Before breakfast	14	t
41	40	6	20 mg once daily	Before breakfast	14	t
42	41	8	400 mg as needed	With food	7	t
43	42	1	10 mg once daily	In the morning	30	t
44	43	8	400 mg as needed	With food	7	t
45	44	9	500 mg as needed	Up to 3 times a day	5	t
46	45	6	20 mg once daily	Before breakfast	14	t
47	46	7	2 puffs as needed	For shortness of breath	30	t
48	47	8	400 mg as needed	With food	7	t
49	48	9	500 mg as needed	Up to 3 times a day	5	t
50	49	6	20 mg once daily	Before breakfast	14	t
51	50	8	400 mg as needed	With food	7	t
52	51	6	20 mg once daily	Before breakfast	14	t
53	52	7	2 puffs as needed	For shortness of breath	30	t
54	53	2	500 mg twice daily	With meals	30	t
55	54	5	25 mcg once daily	Empty stomach	30	t
56	55	6	20 mg once daily	Before breakfast	14	t
57	56	7	2 puffs as needed	For shortness of breath	30	t
58	57	9	500 mg as needed	Up to 3 times a day	5	t
59	58	6	20 mg once daily	Before breakfast	14	t
60	59	7	2 puffs as needed	For shortness of breath	30	t
61	60	5	25 mcg once daily	Empty stomach	30	t
62	61	6	20 mg once daily	Before breakfast	14	t
63	62	5	25 mcg once daily	Empty stomach	30	t
64	63	9	500 mg as needed	Up to 3 times a day	5	t
65	64	3	20 mg once daily	At night	30	t
66	65	3	20 mg once daily	At night	30	t
67	66	8	400 mg as needed	With food	7	t
68	67	2	500 mg twice daily	With meals	30	t
69	68	6	20 mg once daily	Before breakfast	14	t
70	69	2	500 mg twice daily	With meals	30	t
71	70	6	20 mg once daily	Before breakfast	14	t
72	71	3	20 mg once daily	At night	30	t
73	72	5	25 mcg once daily	Empty stomach	30	t
74	73	5	25 mcg once daily	Empty stomach	30	t
75	74	9	500 mg as needed	Up to 3 times a day	5	t
76	75	9	500 mg as needed	Up to 3 times a day	5	t
77	76	1	10 mg once daily	In the morning	30	t
78	77	5	25 mcg once daily	Empty stomach	30	t
79	78	1	10 mg once daily	In the morning	30	t
80	79	8	400 mg as needed	With food	7	t
81	80	1	10 mg once daily	In the morning	30	t
82	81	8	400 mg as needed	With food	7	t
83	82	7	2 puffs as needed	For shortness of breath	30	t
84	83	8	400 mg as needed	With food	7	t
85	84	9	500 mg as needed	Up to 3 times a day	5	t
86	85	6	20 mg once daily	Before breakfast	14	t
87	86	9	500 mg as needed	Up to 3 times a day	5	t
88	87	8	400 mg as needed	With food	7	t
91	90	3	20 mg once daily	At night	30	t
92	91	8	400 mg as needed	With food	7	t
93	92	8	400 mg as needed	With food	7	t
94	93	6	20 mg once daily	Before breakfast	14	t
95	94	9	500 mg as needed	Up to 3 times a day	5	t
96	95	8	400 mg as needed	With food	7	t
97	96	3	20 mg once daily	At night	30	t
98	97	7	2 puffs as needed	For shortness of breath	30	t
99	98	7	2 puffs as needed	For shortness of breath	30	t
100	99	6	20 mg once daily	Before breakfast	14	t
101	100	8	400 mg as needed	With food	7	t
102	101	9	500 mg as needed	Up to 3 times a day	5	t
103	102	5	25 mcg once daily	Empty stomach	30	t
104	103	7	2 puffs as needed	For shortness of breath	30	t
105	104	1	10 mg once daily	In the morning	30	t
106	105	6	20 mg once daily	Before breakfast	14	t
107	106	7	2 puffs as needed	For shortness of breath	30	t
108	107	9	500 mg as needed	Up to 3 times a day	5	t
\.


--
-- Data for Name: referral; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.referral (referral_id, patient_id, referring_doctor_id, specialist_doctor_id, specialty_id, date_issued, expiration_date, status, primary_doctor_id, request_reason, denial_reason, decided_at) FROM stdin;
113	107	1007	1005	18	2026-11-11	2026-11-25	Pending	1001	they are sick	\N	\N
5	110	1001	1004	17	2026-10-23	2027-01-21	Approved	\N	\N	\N	\N
6	101	1001	1005	18	2026-10-23	2026-12-31	Denied	\N	\N	\N	\N
52	126	1003	1004	17	2026-10-17	2027-01-15	Approved	1002	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
53	125	1021	1005	18	2026-10-18	2027-01-16	Approved	1021	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
17	104	1003	1008	21	2026-06-22	2026-09-20	Approved	\N	\N	\N	\N
19	107	1001	1006	19	2026-09-12	2026-12-11	Denied	\N	\N	\N	\N
7	105	1002	1005	18	2026-10-23	2026-10-31	Pending	1002	\N	\N	\N
16	110	1001	1004	17	2026-10-21	2027-01-19	Pending	1001	\N	\N	\N
18	102	1002	1005	18	2026-10-16	2027-01-14	Pending	1002	\N	\N	\N
20	106	1002	1006	19	2026-11-04	2026-11-11	Pending	1003	\N	\N	\N
25	101	1002	1004	17	2026-11-04	2027-02-02	Approved	1001	Test referral: chest pain on exertion, please evaluate.	\N	2026-11-05 04:48:28.047367+00
26	104	1021	1004	17	2026-10-05	2027-01-03	Approved	1003	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
27	107	1001	1005	18	2026-10-08	2027-01-06	Approved	1001	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
28	110	1022	1006	19	2026-10-05	2027-01-03	Approved	1001	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
29	107	1001	1023	20	2026-10-03	2027-01-01	Approved	1001	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
30	105	1002	1005	18	2026-10-09	2027-01-07	Approved	1002	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
31	102	1002	1006	19	2026-10-10	2027-01-08	Approved	1002	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
32	120	1001	1007	20	2026-10-13	2027-01-11	Approved	1022	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
33	110	1021	1008	21	2026-10-12	2027-01-10	Approved	1001	Lab results suggest a hormone issue, please evaluate.	\N	2026-11-05 22:26:29.874258+00
34	127	1022	1005	18	2026-10-09	2027-01-07	Approved	1022	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
35	119	1003	1006	19	2026-10-09	2027-01-07	Approved	1003	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
36	119	1003	1007	20	2026-10-10	2027-01-08	Approved	1003	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
37	105	1002	1008	21	2026-10-14	2027-01-12	Approved	1002	Lab results suggest a hormone issue, please evaluate.	\N	2026-11-05 22:26:29.874258+00
38	104	1021	1008	21	2026-10-20	2027-01-18	Denied	1003	Lab results suggest a hormone issue, please evaluate.	Already seen for this last month.	2026-11-05 22:26:29.874258+00
39	127	1001	1023	20	2026-10-20	2027-01-18	Denied	1022	Frequent headaches, please evaluate.	Not needed yet, recheck at the next visit.	2026-11-05 22:26:29.874258+00
40	120	1022	1004	17	2026-10-10	2027-01-08	Approved	1022	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
41	102	1002	1005	18	2026-10-16	2027-01-14	Approved	1002	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
42	106	1002	1024	17	2026-10-14	2027-01-12	Approved	1003	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
43	108	1003	1006	19	2026-10-15	2027-01-13	Approved	1003	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
44	126	1003	1023	20	2026-10-18	2027-01-16	Approved	1002	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
45	113	1002	1007	20	2026-10-22	2027-01-20	Denied	1021	Frequent headaches, please evaluate.	Not needed yet, recheck at the next visit.	2026-11-05 22:26:29.874258+00
46	114	1003	1005	18	2026-10-12	2027-01-10	Approved	1003	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
47	114	1022	1004	17	2026-10-22	2027-01-20	Denied	1003	Chest discomfort, please check the heart.	Already seen for this last month.	2026-11-05 22:26:29.874258+00
48	129	1002	1006	19	2026-10-13	2027-01-11	Approved	1002	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
49	106	1022	1005	18	2026-10-17	2027-01-15	Approved	1003	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
50	104	1003	1006	19	2026-10-13	2027-01-11	Approved	1003	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
51	109	1001	1007	20	2026-10-20	2027-01-18	Approved	1002	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
54	103	1001	1006	19	2026-10-23	2027-01-21	Approved	1001	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
55	129	1002	1007	20	2026-10-15	2027-01-13	Approved	1002	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
56	109	1002	1008	21	2026-10-20	2027-01-18	Approved	1002	Lab results suggest a hormone issue, please evaluate.	\N	2026-11-05 22:26:29.874258+00
57	105	1003	1023	20	2026-10-20	2027-01-18	Approved	1002	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
58	101	1022	1005	18	2026-10-24	2027-01-22	Approved	1001	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
59	113	1001	1007	20	2026-10-18	2027-01-16	Approved	1021	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
60	126	1022	1024	17	2026-10-24	2027-01-22	Approved	1002	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
61	116	1002	1004	17	2026-10-16	2027-01-14	Approved	1001	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
62	120	1021	1005	18	2026-10-25	2027-01-23	Approved	1022	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
63	123	1002	1006	19	2026-10-20	2027-01-18	Approved	1002	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
64	102	1022	1007	20	2026-10-17	2027-01-15	Approved	1002	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
65	124	1022	1023	20	2026-10-21	2027-01-19	Approved	1022	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
66	104	1022	1023	20	2026-10-29	2027-01-27	Pending	1003	Frequent headaches, please evaluate.	\N	\N
67	120	1002	1007	20	2026-10-30	2027-01-28	Denied	1022	Frequent headaches, please evaluate.	Already seen for this last month.	2026-11-05 22:26:29.874258+00
68	125	1021	1006	19	2026-10-27	2027-01-25	Approved	1021	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
69	113	1001	1024	17	2026-10-19	2027-01-17	Approved	1021	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
70	103	1001	1005	18	2026-10-28	2027-01-26	Approved	1001	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
71	107	1003	1006	19	2026-10-29	2027-01-27	Approved	1001	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
72	126	1002	1007	20	2026-10-24	2027-01-22	Approved	1002	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
73	103	1002	1008	21	2026-10-24	2027-01-22	Approved	1001	Lab results suggest a hormone issue, please evaluate.	\N	2026-11-05 22:26:29.874258+00
74	114	1021	1023	20	2026-10-28	2027-01-26	Approved	1003	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
75	118	1001	1008	21	2026-11-03	2027-02-01	Pending	1002	Lab results suggest a hormone issue, please evaluate.	\N	\N
76	104	1021	1024	17	2026-11-03	2027-02-01	Pending	1003	Chest discomfort, please check the heart.	\N	\N
77	112	1001	1024	17	2026-10-24	2027-01-22	Approved	1001	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
78	116	1002	1007	20	2026-10-28	2027-01-26	Approved	1001	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
79	106	1003	1008	21	2026-10-28	2027-01-26	Approved	1003	Lab results suggest a hormone issue, please evaluate.	\N	2026-11-05 22:26:29.874258+00
80	119	1003	1024	17	2026-11-01	2027-01-30	Approved	1003	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
81	104	1001	1005	18	2026-11-02	2027-01-31	Approved	1003	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
82	114	1003	1006	19	2026-10-26	2027-01-24	Approved	1003	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
83	112	1001	1008	21	2026-10-25	2027-01-23	Approved	1001	Lab results suggest a hormone issue, please evaluate.	\N	2026-11-05 22:26:29.874258+00
84	127	1022	1024	17	2026-11-01	2027-01-30	Approved	1022	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
85	127	1022	1004	17	2026-10-30	2027-01-28	Approved	1022	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
86	124	1022	1004	17	2026-11-06	2027-02-04	Approved	1022	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
87	116	1002	1006	19	2026-11-02	2027-01-31	Approved	1001	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
88	108	1002	1007	20	2026-11-02	2027-01-31	Approved	1003	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
89	101	1001	1008	21	2026-11-04	2027-02-02	Approved	1001	Lab results suggest a hormone issue, please evaluate.	\N	2026-11-05 22:26:29.874258+00
90	123	1002	1004	17	2026-11-02	2027-01-31	Approved	1002	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
91	129	1002	1023	20	2026-11-01	2027-01-30	Approved	1002	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
92	129	1002	1005	18	2026-11-08	2027-02-06	Approved	1002	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
93	101	1001	1007	20	2026-11-05	2027-02-03	Approved	1001	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
94	128	1022	1004	17	2026-11-01	2027-01-30	Approved	1022	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
95	111	1022	1006	19	2026-11-07	2027-02-05	Approved	1022	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
96	110	1002	1007	20	2026-11-06	2027-02-04	Approved	1001	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
97	120	1022	1024	17	2026-11-05	2027-02-03	Approved	1022	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
98	124	1022	1008	21	2026-11-07	2027-02-05	Approved	1022	Lab results suggest a hormone issue, please evaluate.	\N	2026-11-05 22:26:29.874258+00
99	120	1002	1023	20	2026-11-07	2027-02-05	Approved	1022	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
100	119	1001	1004	17	2026-11-10	2027-02-08	Approved	1003	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
101	128	1003	1006	19	2026-11-12	2027-02-10	Approved	1022	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
102	121	1021	1007	20	2026-11-14	2027-02-12	Approved	1022	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
103	103	1002	1024	17	2026-11-07	2027-02-05	Approved	1001	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
104	112	1003	1005	18	2026-11-15	2027-02-13	Approved	1001	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
105	1	1022	1007	20	2026-11-13	2027-02-11	Approved	1021	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
106	123	1021	1005	18	2026-11-09	2027-02-07	Approved	1002	Rash that won't clear, please evaluate.	\N	2026-11-05 22:26:29.874258+00
114	126	1007	1024	17	2026-11-11	2026-11-19	Pending	1002	sick	\N	\N
115	105	1007	1006	19	2026-11-11	2026-11-19	Pending	1002	sick	\N	\N
116	106	1007	1006	19	2026-11-11	2026-11-19	Approved	1003	sick	\N	2026-11-13 00:35:10.92426+00
107	115	1003	1024	17	2026-11-16	2027-02-14	Approved	1003	Chest discomfort, please check the heart.	\N	2026-11-05 22:26:29.874258+00
108	118	1003	1023	20	2026-11-18	2027-02-16	Approved	1002	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
109	112	1001	1007	20	2026-11-21	2027-02-19	Approved	1001	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
110	127	1002	1006	19	2026-11-21	2027-02-19	Approved	1022	Joint pain for weeks, please evaluate.	\N	2026-11-05 22:26:29.874258+00
111	108	1021	1023	20	2026-11-15	2027-02-13	Approved	1003	Frequent headaches, please evaluate.	\N	2026-11-05 22:26:29.874258+00
112	126	1002	1008	21	2026-11-15	2027-02-13	Approved	1002	Lab results suggest a hormone issue, please evaluate.	\N	2026-11-05 22:26:29.874258+00
117	109	1002	1006	19	2026-11-12	2026-11-13	Approved	1002	H	\N	2026-11-12 21:04:04.256888+00
\.


--
-- Data for Name: service_fee; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.service_fee (fee_id, category, type, name, price, specialty_id, lab_test_type_id, medication_id, is_active, updated_at) FROM stdin;
1	Visit	Primary Care	Family Medicine visit	150.00	15	\N	\N	t	2026-10-25 08:08:51.749899+00
2	Visit	Primary Care	Internal Medicine visit	175.00	16	\N	\N	t	2026-10-25 08:08:51.749899+00
3	Visit	Specialist	Cardiology visit	275.00	17	\N	\N	t	2026-10-25 08:08:51.749899+00
4	Visit	Specialist	Dermatology visit	200.00	18	\N	\N	t	2026-10-25 08:08:51.749899+00
5	Visit	Specialist	Orthopedics visit	250.00	19	\N	\N	t	2026-10-25 08:08:51.749899+00
6	Visit	Specialist	Neurology visit	300.00	20	\N	\N	t	2026-10-25 08:08:51.749899+00
7	Visit	Specialist	Endocrinology visit	225.00	21	\N	\N	t	2026-10-25 08:08:51.749899+00
8	Lab Test	Blood Test	Complete Blood Count	45.00	\N	15	\N	t	2026-10-25 08:08:51.749899+00
9	Lab Test	Blood Test	Basic Metabolic Panel	55.00	\N	16	\N	t	2026-10-25 08:08:51.749899+00
10	Lab Test	Blood Test	Lipid Panel	60.00	\N	17	\N	t	2026-10-25 08:08:51.749899+00
11	Lab Test	Blood Test	Hemoglobin A1c	40.00	\N	18	\N	t	2026-10-25 08:08:51.749899+00
12	Lab Test	Blood Test	Thyroid Panel (TSH)	50.00	\N	19	\N	t	2026-10-25 08:08:51.749899+00
13	Lab Test	Urine Test	Urinalysis	25.00	\N	20	\N	t	2026-10-25 08:08:51.749899+00
14	Lab Test	Blood Test	Vitamin D	65.00	\N	21	\N	t	2026-10-25 08:08:51.749899+00
15	Medication	Blood Pressure	Lisinopril	15.00	\N	\N	1	t	2026-10-25 08:08:51.749899+00
16	Medication	Diabetes	Metformin	12.00	\N	\N	2	t	2026-10-25 08:08:51.749899+00
17	Medication	Cholesterol	Atorvastatin	20.00	\N	\N	3	t	2026-10-25 08:08:51.749899+00
18	Medication	Blood Pressure	Amlodipine	15.00	\N	\N	4	t	2026-10-25 08:08:51.749899+00
19	Medication	Thyroid	Levothyroxine	18.00	\N	\N	5	t	2026-10-25 08:08:51.749899+00
20	Medication	Stomach	Omeprazole	22.00	\N	\N	6	t	2026-10-25 08:08:51.749899+00
21	Medication	Breathing	Albuterol inhaler	45.00	\N	\N	7	t	2026-10-25 08:08:51.749899+00
22	Medication	Pain Relief	Ibuprofen	8.00	\N	\N	8	t	2026-10-25 08:08:51.749899+00
23	Medication	Pain Relief	Acetaminophen	6.00	\N	\N	9	t	2026-10-25 08:08:51.749899+00
24	Medication	Mental Health	Sertraline	25.00	\N	\N	10	t	2026-10-25 08:08:51.749899+00
26	Medication	Other	Test Medication ZZ	12.50	\N	\N	11	f	2026-11-11 06:42:52.862663+00
25	Lab Test	Blood Test	Test Lipid Panel ZZ	45.00	\N	22	\N	f	2026-11-11 07:31:22.69949+00
27	No Show	\N	No-show fee	25.00	\N	\N	\N	t	2026-11-15 04:47:08.165827+00
\.


--
-- Data for Name: session; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.session (sid, sess, expire) FROM stdin;
\.


--
-- Data for Name: shift_type; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.shift_type (shift_type_id, name, start_time, end_time, is_active) FROM stdin;
6	Morning	08:00:00	12:00:00	t
7	Full Day	08:00:00	17:00:00	t
8	Afternoon	13:00:00	17:00:00	t
\.


--
-- Data for Name: specialty; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.specialty (specialty_id, name, requires_referral, is_active) FROM stdin;
15	Family Medicine	f	t
16	Internal Medicine	f	t
17	Cardiology	t	t
18	Dermatology	t	t
19	Orthopedics	t	t
20	Neurology	t	t
21	Endocrinology	t	t
\.


--
-- Data for Name: supply; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.supply (supply_id, name, supply_type_id, is_active) FROM stdin;
1	Nitrile gloves (box)	1	t
2	Surgical masks (box)	1	t
3	Gauze pads	2	t
4	Adhesive bandages	2	t
5	Alcohol prep pads	3	t
6	Syringes 3 mL	3	t
7	Tongue depressors	4	t
8	Thermometer probe covers	4	t
\.


--
-- Data for Name: supply_order; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.supply_order (supply_order_id, supply_id, office_id, employee_id, quantity_ordered, order_date, status) FROM stdin;
5	2	5	1013	24	2026-10-27	Received
7	6	5	1013	1	2026-10-27	Received
6	5	5	1013	1	2026-10-27	Received
4	2	6	1010	50	2026-10-25	Received
3	3	6	1010	200	2026-10-25	Received
8	8	5	1013	900000	2026-10-27	Received
9	7	5	1013	100000000	2026-10-27	Received
10	1	5	1025	20	2026-10-16	Received
11	2	5	1009	10	2026-10-21	Received
12	3	6	1026	30	2026-10-26	Received
17	4	5	1013	8	2026-10-22	Cancelled
18	5	6	1010	32	2026-11-08	Received
15	2	6	1012	20	2026-11-03	Received
14	1	6	1027	15	2026-11-02	Received
19	8	6	1010	40	2026-11-10	Received
20	8	6	1010	1	2026-11-10	Received
21	5	6	1010	20	2026-11-10	Received
13	4	6	1010	25	2026-10-30	Cancelled
22	4	6	1010	255	2026-11-10	Cancelled
23	2	5	1034	3	2026-11-11	Received
24	4	5	1034	1	2026-11-11	Received
25	4	5	1034	50	2026-11-12	Received
26	6	5	1034	30	2026-11-12	Received
27	7	5	1034	100	2026-11-12	Received
16	3	5	1011	12	2026-11-04	Cancelled
29	4	5	1034	100	2026-11-12	Received
28	4	5	1034	1000	2026-11-12	Cancelled
30	4	5	1034	100	2026-11-12	Received
31	4	5	1034	50	2026-11-12	Cancelled
32	4	5	1034	50	2026-11-12	Received
\.


--
-- Data for Name: supply_type; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.supply_type (supply_type_id, type_name, is_active) FROM stdin;
1	PPE	t
2	Wound Care	t
3	Injection	t
4	Diagnostic	t
\.


--
-- Data for Name: time_slot; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.time_slot (time_slot_id, shift_type_id, start_time, end_time, is_active) FROM stdin;
49	7	11:00:00	11:30:00	t
50	7	13:00:00	13:30:00	t
51	7	16:00:00	16:30:00	t
52	8	16:30:00	17:00:00	t
53	7	14:00:00	14:30:00	t
54	6	10:30:00	11:00:00	t
55	7	09:30:00	10:00:00	t
56	6	11:30:00	12:00:00	t
57	7	10:00:00	10:30:00	t
58	8	13:30:00	14:00:00	t
59	7	08:30:00	09:00:00	t
60	6	08:00:00	08:30:00	t
61	7	14:30:00	15:00:00	t
62	7	15:30:00	16:00:00	t
63	7	15:00:00	15:30:00	t
64	7	09:00:00	09:30:00	t
65	8	15:00:00	15:30:00	t
66	6	11:00:00	11:30:00	t
67	8	15:30:00	16:00:00	t
68	8	14:30:00	15:00:00	t
69	7	10:30:00	11:00:00	t
70	7	11:30:00	12:00:00	t
71	6	09:30:00	10:00:00	t
72	7	13:30:00	14:00:00	t
73	6	10:00:00	10:30:00	t
74	6	08:30:00	09:00:00	t
75	8	14:00:00	14:30:00	t
76	7	16:30:00	17:00:00	t
77	8	16:00:00	16:30:00	t
78	7	08:00:00	08:30:00	t
79	6	09:00:00	09:30:00	t
80	8	13:00:00	13:30:00	t
\.


--
-- Data for Name: visit_diagnosis; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.visit_diagnosis (visit_diagnosis_id, appointment_id, name, reasoning, recorded_by_employee_id, created_at, is_active) FROM stdin;
2	123	Upper respiratory infection	Rest and fluids	1001	2026-10-15 13:50:00	t
3	124	Viral sore throat	Should clear in a week	1001	2026-10-15 10:20:00	t
4	125	Lower back strain	Stretching and ice	1001	2026-10-15 14:20:00	t
5	130	Acid reflux	Avoid late meals	1021	2026-10-15 13:20:00	t
6	131	Type 2 diabetes	Needs better diet	1021	2026-10-15 16:50:00	t
7	132	Routine exam	Vaccine given	1022	2026-10-15 09:20:00	t
8	133	Routine exam	Vaccine given	1022	2026-10-15 08:20:00	t
9	134	Viral sore throat	Should clear in a week	1022	2026-10-15 10:50:00	t
10	135	Palpitations	Too much caffeine	1004	2026-10-15 13:50:00	t
11	136	Contact dermatitis	New soap	1005	2026-10-15 08:20:00	t
12	137	Knee strain	Rest for two weeks	1006	2026-10-15 08:50:00	t
13	139	Viral sore throat	Should clear in a week	1001	2026-10-16 15:20:00	t
14	140	Upper respiratory infection	Rest and fluids	1001	2026-10-16 08:50:00	t
15	141	Tension headache	Screen breaks	1001	2026-10-16 14:50:00	t
16	142	Routine exam	Vaccine given	1002	2026-10-16 09:50:00	t
17	143	High cholesterol	Still above goal	1003	2026-10-16 08:20:00	t
18	144	Type 2 diabetes	Needs better diet	1003	2026-10-16 14:20:00	t
19	145	High cholesterol	Still above goal	1003	2026-10-16 08:50:00	t
20	147	Fatigue	Checking labs	1021	2026-10-16 08:20:00	t
21	148	Acid reflux	Avoid late meals	1021	2026-10-16 09:20:00	t
22	149	Lower back strain	Stretching and ice	1022	2026-10-16 13:20:00	t
23	150	Contact dermatitis	New soap	1005	2026-10-16 13:20:00	t
24	152	Migraine	Triggers: sleep, stress	1007	2026-10-16 08:20:00	t
25	155	Routine exam	Vaccine given	1002	2026-10-19 14:20:00	t
26	157	Routine exam	Vaccine given	1002	2026-10-19 14:50:00	t
27	158	Type 2 diabetes	Needs better diet	1003	2026-10-19 15:50:00	t
28	159	High blood pressure	Two high readings	1021	2026-10-19 10:20:00	t
29	162	Upper respiratory infection	Rest and fluids	1022	2026-10-19 14:50:00	t
30	163	Routine exam	Vaccine given	1022	2026-10-19 16:20:00	t
31	164	Contact dermatitis	New soap	1005	2026-10-19 09:50:00	t
32	165	Wrist sprain	Brace for a week	1006	2026-10-19 16:50:00	t
33	166	Positional dizziness	Stand up slowly	1007	2026-10-19 11:20:00	t
34	167	Prediabetes	Diet and exercise	1008	2026-10-19 08:20:00	t
35	168	Routine exam	Vaccine given	1001	2026-10-20 11:20:00	t
36	170	Lower back strain	Stretching and ice	1002	2026-10-20 10:50:00	t
37	171	Viral sore throat	Should clear in a week	1002	2026-10-20 15:50:00	t
38	172	Tension headache	Screen breaks	1002	2026-10-20 09:20:00	t
39	173	Acid reflux	Avoid late meals	1003	2026-10-20 08:50:00	t
40	174	Acid reflux	Avoid late meals	1021	2026-10-20 11:20:00	t
41	175	Upper respiratory infection	Rest and fluids	1022	2026-10-20 10:50:00	t
42	176	Lower back strain	Stretching and ice	1022	2026-10-20 08:50:00	t
43	181	Palpitations	Too much caffeine	1024	2026-10-20 16:20:00	t
44	182	Routine exam	No problems found	1001	2026-10-21 14:20:00	t
45	185	Routine exam	Vaccine given	1002	2026-10-21 13:20:00	t
46	187	Upper respiratory infection	Rest and fluids	1002	2026-10-21 10:50:00	t
47	189	Fatigue	Checking labs	1003	2026-10-21 08:20:00	t
48	191	High blood pressure	Two high readings	1021	2026-10-21 14:20:00	t
49	193	Acid reflux	Avoid late meals	1021	2026-10-21 11:50:00	t
50	194	Routine exam	Vaccine given	1022	2026-10-21 10:20:00	t
51	195	Upper respiratory infection	Rest and fluids	1022	2026-10-21 16:50:00	t
52	196	Wrist sprain	Brace for a week	1006	2026-10-21 13:50:00	t
53	197	Positional dizziness	Stand up slowly	1007	2026-10-21 15:20:00	t
54	198	Prediabetes	Diet and exercise	1008	2026-10-21 09:50:00	t
55	199	Positional dizziness	Stand up slowly	1023	2026-10-21 10:50:00	t
56	201	Routine exam	No problems found	1002	2026-10-22 08:50:00	t
57	202	Lower back strain	Stretching and ice	1002	2026-10-22 11:20:00	t
58	203	Tension headache	Screen breaks	1002	2026-10-22 08:20:00	t
59	204	Type 2 diabetes	Needs better diet	1003	2026-10-22 16:50:00	t
60	205	Type 2 diabetes	Needs better diet	1003	2026-10-22 15:50:00	t
61	206	Fatigue	Checking labs	1003	2026-10-22 08:20:00	t
62	207	High blood pressure	Two high readings	1021	2026-10-22 10:50:00	t
63	208	Lower back strain	Stretching and ice	1022	2026-10-22 08:20:00	t
64	209	Contact dermatitis	New soap	1005	2026-10-22 09:50:00	t
65	210	Knee strain	Rest for two weeks	1006	2026-10-22 15:20:00	t
66	211	Palpitations	Too much caffeine	1024	2026-10-22 11:50:00	t
67	213	Viral sore throat	Should clear in a week	1002	2026-10-23 15:50:00	t
68	215	Acid reflux	Avoid late meals	1003	2026-10-23 15:50:00	t
69	216	High cholesterol	Still above goal	1021	2026-10-23 09:50:00	t
70	217	Fatigue	Checking labs	1021	2026-10-23 13:20:00	t
71	219	Contact dermatitis	New soap	1005	2026-10-23 16:20:00	t
72	220	Wrist sprain	Brace for a week	1006	2026-10-23 16:20:00	t
73	223	Routine exam	Vaccine given	1002	2026-10-26 08:50:00	t
74	224	Fatigue	Checking labs	1003	2026-10-26 13:50:00	t
75	225	High cholesterol	Still above goal	1003	2026-10-26 15:50:00	t
76	226	Acid reflux	Avoid late meals	1021	2026-10-26 11:20:00	t
77	227	Type 2 diabetes	Needs better diet	1021	2026-10-26 09:20:00	t
78	228	Tension headache	Screen breaks	1022	2026-10-26 15:20:00	t
79	229	Chest pain, not heart related	Normal ECG	1004	2026-10-26 08:50:00	t
80	230	Benign mole	No change	1005	2026-10-26 13:20:00	t
81	231	Wrist sprain	Brace for a week	1006	2026-10-26 13:20:00	t
82	232	Migraine	Triggers: sleep, stress	1007	2026-10-26 08:20:00	t
83	233	Prediabetes	Diet and exercise	1008	2026-10-26 13:50:00	t
84	234	Migraine	Triggers: sleep, stress	1023	2026-10-26 16:50:00	t
85	235	Routine exam	No problems found	1001	2026-10-27 10:20:00	t
86	236	Routine exam	Vaccine given	1002	2026-10-27 16:50:00	t
87	238	Routine exam	Vaccine given	1002	2026-10-27 10:20:00	t
88	239	Acid reflux	Avoid late meals	1003	2026-10-27 08:20:00	t
89	240	Acid reflux	Avoid late meals	1021	2026-10-27 10:20:00	t
90	241	Acid reflux	Avoid late meals	1021	2026-10-27 11:50:00	t
91	242	High blood pressure	Two high readings	1021	2026-10-27 14:20:00	t
92	243	Routine exam	No problems found	1022	2026-10-27 08:50:00	t
93	244	Upper respiratory infection	Rest and fluids	1022	2026-10-27 10:50:00	t
94	245	Palpitations	Too much caffeine	1004	2026-10-27 08:20:00	t
95	246	Benign mole	No change	1005	2026-10-27 16:20:00	t
96	247	Knee strain	Rest for two weeks	1006	2026-10-27 14:20:00	t
97	248	Migraine	Triggers: sleep, stress	1007	2026-10-27 16:20:00	t
98	249	Palpitations	Too much caffeine	1024	2026-10-27 10:20:00	t
99	250	Tension headache	Screen breaks	1001	2026-10-28 14:50:00	t
100	251	Viral sore throat	Should clear in a week	1001	2026-10-28 14:20:00	t
101	252	Tension headache	Screen breaks	1001	2026-10-28 16:20:00	t
102	253	Viral sore throat	Should clear in a week	1002	2026-10-28 10:50:00	t
103	254	Viral sore throat	Should clear in a week	1002	2026-10-28 13:50:00	t
104	255	High cholesterol	Still above goal	1003	2026-10-28 08:20:00	t
105	256	Type 2 diabetes	Needs better diet	1003	2026-10-28 13:20:00	t
106	257	Acid reflux	Avoid late meals	1003	2026-10-28 10:20:00	t
107	258	Fatigue	Checking labs	1021	2026-10-28 15:50:00	t
108	259	Viral sore throat	Should clear in a week	1022	2026-10-28 08:50:00	t
109	260	Routine exam	No problems found	1022	2026-10-28 09:50:00	t
110	261	Palpitations	Too much caffeine	1004	2026-10-28 15:20:00	t
111	263	Wrist sprain	Brace for a week	1006	2026-10-28 13:20:00	t
112	264	Migraine	Triggers: sleep, stress	1007	2026-10-28 08:50:00	t
113	265	Positional dizziness	Stand up slowly	1023	2026-10-28 08:50:00	t
114	266	Routine exam	Vaccine given	1001	2026-10-29 08:20:00	t
115	267	Tension headache	Screen breaks	1001	2026-10-29 10:50:00	t
116	269	Upper respiratory infection	Rest and fluids	1002	2026-10-29 10:20:00	t
117	270	Upper respiratory infection	Rest and fluids	1002	2026-10-29 14:20:00	t
118	271	Acid reflux	Avoid late meals	1003	2026-10-29 10:20:00	t
119	272	Acid reflux	Avoid late meals	1003	2026-10-29 16:20:00	t
120	273	High blood pressure	Two high readings	1003	2026-10-29 13:20:00	t
121	274	Type 2 diabetes	Needs better diet	1021	2026-10-29 11:20:00	t
122	275	Upper respiratory infection	Rest and fluids	1022	2026-10-29 08:20:00	t
123	276	Routine exam	No problems found	1022	2026-10-29 11:20:00	t
124	278	Contact dermatitis	New soap	1005	2026-10-29 13:20:00	t
125	279	Wrist sprain	Brace for a week	1006	2026-10-29 13:20:00	t
126	280	Viral sore throat	Should clear in a week	1001	2026-10-30 09:50:00	t
127	281	Lower back strain	Stretching and ice	1002	2026-10-30 16:50:00	t
128	282	Upper respiratory infection	Rest and fluids	1002	2026-10-30 15:20:00	t
129	283	Routine exam	Vaccine given	1002	2026-10-30 09:50:00	t
130	284	High cholesterol	Still above goal	1003	2026-10-30 13:20:00	t
131	286	Fatigue	Checking labs	1021	2026-10-30 10:20:00	t
132	288	Knee strain	Rest for two weeks	1006	2026-10-30 11:50:00	t
133	289	Chest pain, not heart related	Normal ECG	1024	2026-10-30 09:20:00	t
134	290	Tension headache	Screen breaks	1001	2026-11-02 09:50:00	t
135	292	Lower back strain	Stretching and ice	1001	2026-11-02 08:20:00	t
136	293	Upper respiratory infection	Rest and fluids	1002	2026-11-02 13:50:00	t
137	295	Tension headache	Screen breaks	1002	2026-11-02 11:20:00	t
138	296	Acid reflux	Avoid late meals	1003	2026-11-02 13:20:00	t
139	297	Fatigue	Checking labs	1021	2026-11-02 15:50:00	t
140	299	High cholesterol	Still above goal	1021	2026-11-02 14:50:00	t
141	300	Viral sore throat	Should clear in a week	1022	2026-11-02 08:50:00	t
142	301	Benign mole	No change	1005	2026-11-02 08:20:00	t
143	302	Knee strain	Rest for two weeks	1006	2026-11-02 11:50:00	t
144	303	Migraine	Triggers: sleep, stress	1007	2026-11-02 15:50:00	t
145	304	Hypothyroidism	Adjust dose	1008	2026-11-02 15:20:00	t
146	305	Positional dizziness	Stand up slowly	1023	2026-11-02 14:50:00	t
147	307	Viral sore throat	Should clear in a week	1002	2026-11-03 10:20:00	t
148	308	Routine exam	No problems found	1002	2026-11-03 09:50:00	t
149	309	Upper respiratory infection	Rest and fluids	1002	2026-11-03 13:50:00	t
150	310	Fatigue	Checking labs	1003	2026-11-03 13:50:00	t
151	311	Type 2 diabetes	Needs better diet	1003	2026-11-03 10:20:00	t
152	312	High blood pressure	Two high readings	1003	2026-11-03 13:20:00	t
153	313	Acid reflux	Avoid late meals	1021	2026-11-03 10:20:00	t
154	314	Fatigue	Checking labs	1021	2026-11-03 13:50:00	t
155	315	Routine exam	No problems found	1022	2026-11-03 11:50:00	t
156	316	Migraine	Triggers: sleep, stress	1023	2026-11-03 16:50:00	t
157	318	Tension headache	Screen breaks	1001	2026-11-04 16:20:00	t
158	319	Routine exam	No problems found	1002	2026-11-04 08:50:00	t
159	320	Acid reflux	Avoid late meals	1003	2026-11-04 09:50:00	t
160	321	Fatigue	Checking labs	1021	2026-11-04 14:50:00	t
161	322	Acid reflux	Avoid late meals	1021	2026-11-04 16:20:00	t
162	324	Upper respiratory infection	Rest and fluids	1022	2026-11-04 10:20:00	t
163	325	Migraine	Triggers: sleep, stress	1007	2026-11-04 08:20:00	t
164	326	Prediabetes	Diet and exercise	1008	2026-11-04 14:20:00	t
165	327	Chest pain, not heart related	Normal ECG	1024	2026-11-04 10:20:00	t
166	333	Fatigue	Checking labs	1021	2026-11-05 11:20:00	t
167	334	Fatigue	Checking labs	1021	2026-11-05 11:50:00	t
168	335	Viral sore throat	Should clear in a week	1022	2026-11-05 11:50:00	t
169	336	Contact dermatitis	New soap	1005	2026-11-05 08:20:00	t
170	338	Prediabetes	Diet and exercise	1008	2026-11-05 08:20:00	t
171	85	Migraine	Triggers: sleep, stress	1007	2026-10-23 15:46:00	t
172	108	Tension headache	Screen breaks	1001	2026-10-26 09:37:00	t
173	87	Viral sore throat	Should clear in a week	1002	2026-10-26 16:52:00	t
174	111	Routine exam	Vaccine given	1002	2026-10-28 08:21:00	t
175	112	Viral sore throat	Should clear in a week	1001	2026-10-28 08:55:00	t
176	113	Lower back strain	Stretching and ice	1001	2026-10-28 09:41:00	t
177	88	Tension headache	Screen breaks	1002	2026-10-28 11:52:00	t
178	110	Type 2 diabetes	Needs better diet	1003	2026-10-29 08:16:00	t
179	90	Viral sore throat	Should clear in a week	1001	2026-10-29 16:37:00	t
180	115	Upper respiratory infection	Rest and fluids	1001	2026-10-30 11:23:00	t
181	117	High cholesterol	Still above goal	1003	2026-10-30 16:47:00	t
182	331	Viral sore throat	Should clear in a week	1002	2026-11-05 13:20:00	t
183	330	Lower back strain	Stretching and ice	1001	2026-11-05 13:56:00	t
184	332	Acid reflux	Avoid late meals	1003	2026-11-05 15:02:00	t
185	329	Routine exam	No problems found	1001	2026-11-05 15:23:00	t
186	328	Routine exam	Vaccine given	1001	2026-11-05 16:17:00	t
187	337	Wrist sprain	Brace for a week	1006	2026-11-05 16:54:00	t
188	340	Routine exam	Vaccine given	1001	2026-11-06 08:26:00	t
189	342	Acid reflux	Avoid late meals	1003	2026-11-06 10:49:00	t
190	344	High cholesterol	Still above goal	1021	2026-11-06 13:08:00	t
191	347	Palpitations	Too much caffeine	1004	2026-11-06 13:54:00	t
192	343	High cholesterol	Still above goal	1003	2026-11-06 14:23:00	t
193	548	Viral sore throat	Should clear in a week	1002	2026-11-06 16:14:00	t
194	356	Palpitations	Too much caffeine	1004	2026-11-09 08:46:00	t
195	354	Upper respiratory infection	Rest and fluids	1022	2026-11-09 09:49:00	t
196	359	Hypothyroidism	Adjust dose	1008	2026-11-09 09:54:00	t
197	351	Routine exam	Vaccine given	1002	2026-11-09 10:28:00	t
198	358	Positional dizziness	Stand up slowly	1007	2026-11-09 10:16:00	t
199	353	Type 2 diabetes	Needs better diet	1021	2026-11-09 14:02:00	t
200	349	Upper respiratory infection	Rest and fluids	1001	2026-11-09 14:25:00	t
201	550	Fatigue	Checking labs	1021	2026-11-09 15:09:00	t
202	549	Type 2 diabetes	Needs better diet	1021	2026-11-09 15:34:00	t
203	352	Type 2 diabetes	Needs better diet	1003	2026-11-09 16:49:00	t
204	357	Wrist sprain	Brace for a week	1006	2026-11-09 17:06:00	t
205	363	Routine exam	No problems found	1002	2026-11-10 08:47:00	t
206	364	Fatigue	Checking labs	1003	2026-11-10 09:31:00	t
207	368	Routine exam	Vaccine given	1022	2026-11-10 09:20:00	t
208	369	Palpitations	Too much caffeine	1004	2026-11-10 09:18:00	t
209	93	Acid reflux	Avoid late meals	1003	2026-11-10 10:04:00	t
210	370	Contact dermatitis	New soap	1005	2026-11-10 09:52:00	t
211	367	Upper respiratory infection	Rest and fluids	1022	2026-11-10 10:17:00	t
212	366	Viral sore throat	Should clear in a week	1022	2026-11-10 11:09:00	t
213	362	Routine exam	Vaccine given	1002	2026-11-10 11:25:00	t
214	551	High blood pressure	Two high readings	1021	2026-11-10 11:46:00	t
215	94	Migraine	Triggers: sleep, stress	1007	2026-11-10 13:23:00	t
216	361	Routine exam	No problems found	1002	2026-11-10 13:25:00	t
217	553	High cholesterol	Still above goal	1021	2026-11-10 13:32:00	t
218	552	Tension headache	Screen breaks	1002	2026-11-10 13:56:00	t
219	556	Fatigue	Checking labs	1021	2026-11-10 15:23:00	t
220	371	Migraine	Triggers: sleep, stress	1023	2026-11-10 16:20:00	t
221	360	Upper respiratory infection	Rest and fluids	1001	2026-11-10 16:59:00	t
222	365	Acid reflux	Avoid late meals	1021	2026-11-10 17:02:00	t
223	375	Fatigue	Checking labs	1003	2026-11-11 08:18:00	t
224	558	Acid reflux	Avoid late meals	1003	2026-11-11 08:48:00	t
225	377	Acid reflux	Avoid late meals	1021	2026-11-11 11:11:00	t
226	379	Contact dermatitis	New soap	1005	2026-11-11 11:20:00	t
227	378	Viral sore throat	Should clear in a week	1022	2026-11-11 11:44:00	t
228	380	Migraine	Triggers: sleep, stress	1007	2026-11-11 13:27:00	t
229	575	Acid reflux	Avoid late meals	1021	2026-11-11 14:04:00	t
230	376	Acid reflux	Avoid late meals	1021	2026-11-11 14:54:00	t
231	373	Lower back strain	Stretching and ice	1002	2026-11-11 15:34:00	t
232	559	High blood pressure	Two high readings	1021	2026-11-11 16:33:00	t
233	394	Positional dizziness	Stand up slowly	1007	2026-11-12 08:22:00	t
234	576	Acid reflux	Avoid late meals	1021	2026-11-12 08:23:00	t
235	577	Upper respiratory infection	Rest and fluids	1002	2026-11-12 08:38:00	t
236	387	Type 2 diabetes	Needs better diet	1003	2026-11-12 09:23:00	t
237	584	Lower back strain	Stretching and ice	1001	2026-11-12 09:17:00	t
238	390	Upper respiratory infection	Rest and fluids	1022	2026-11-12 09:46:00	t
239	392	Contact dermatitis	New soap	1005	2026-11-12 10:21:00	t
240	396	Migraine	Triggers: sleep, stress	1023	2026-11-12 10:18:00	t
241	388	Acid reflux	Avoid late meals	1003	2026-11-12 10:55:00	t
242	391	Chest pain, not heart related	Normal ECG	1004	2026-11-12 11:36:00	t
243	381	Viral sore throat	Should clear in a week	1001	2026-11-12 14:16:00	t
244	393	Wrist sprain	Brace for a week	1006	2026-11-12 14:52:00	t
\.


--
-- Name: allergy_allergy_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.allergy_allergy_id_seq', 37, true);


--
-- Name: allergy_type_allergy_type_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.allergy_type_allergy_type_id_seq', 15, true);


--
-- Name: appointment_appointment_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.appointment_appointment_id_seq', 606, true);


--
-- Name: appointment_history_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.appointment_history_history_id_seq', 1209, true);


--
-- Name: appointment_summary_appointment_summary_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.appointment_summary_appointment_summary_id_seq', 504, true);


--
-- Name: billing_history_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.billing_history_history_id_seq', 710, true);


--
-- Name: certificate_certificate_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.certificate_certificate_id_seq', 4, true);


--
-- Name: emergency_contact_emergency_contact_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.emergency_contact_emergency_contact_id_seq', 16, true);


--
-- Name: employee_audit_audit_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.employee_audit_audit_id_seq', 1, false);


--
-- Name: employee_creds_employee_creds_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.employee_creds_employee_creds_id_seq', 69, true);


--
-- Name: employee_employee_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.employee_employee_id_seq', 1035, true);


--
-- Name: employee_types_employee_type_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.employee_types_employee_type_id_seq', 13, true);


--
-- Name: form_submission_form_submission_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.form_submission_form_submission_id_seq', 37, true);


--
-- Name: form_type_form_type_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.form_type_form_type_id_seq', 4, true);


--
-- Name: home_medication_home_medication_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.home_medication_home_medication_id_seq', 37, true);


--
-- Name: insurance_insurance_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.insurance_insurance_id_seq', 17, true);


--
-- Name: invoice_invoice_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.invoice_invoice_id_seq', 320, true);


--
-- Name: invoice_item_invoice_item_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.invoice_item_invoice_item_id_seq', 479, true);


--
-- Name: lab_order_lab_order_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.lab_order_lab_order_id_seq', 133, true);


--
-- Name: lab_test_type_lab_test_type_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.lab_test_type_lab_test_type_id_seq', 22, true);


--
-- Name: medication_medication_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.medication_medication_id_seq', 11, true);


--
-- Name: nursing_note_nursing_note_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.nursing_note_nursing_note_id_seq', 247, true);


--
-- Name: office_office_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.office_office_id_seq', 6, true);


--
-- Name: office_supply_office_supply_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.office_supply_office_supply_id_seq', 38, true);


--
-- Name: patient_creds_patient_creds_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.patient_creds_patient_creds_id_seq', 51, true);


--
-- Name: patient_patient_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.patient_patient_id_seq', 132, true);


--
-- Name: patient_vitals_vitals_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.patient_vitals_vitals_id_seq', 518, true);


--
-- Name: payment_payment_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.payment_payment_id_seq', 809, true);


--
-- Name: payment_type_payment_type_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.payment_type_payment_type_id_seq', 33, true);


--
-- Name: prescription_item_prescription_item_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.prescription_item_prescription_item_id_seq', 108, true);


--
-- Name: prescription_prescription_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.prescription_prescription_id_seq', 107, true);


--
-- Name: referral_referral_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.referral_referral_id_seq', 117, true);


--
-- Name: service_fee_fee_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.service_fee_fee_id_seq', 27, true);


--
-- Name: shift_type_shift_type_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.shift_type_shift_type_id_seq', 8, true);


--
-- Name: specialty_specialty_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.specialty_specialty_id_seq', 21, true);


--
-- Name: supply_order_supply_order_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.supply_order_supply_order_id_seq', 32, true);


--
-- Name: supply_supply_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.supply_supply_id_seq', 8, true);


--
-- Name: supply_type_supply_type_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.supply_type_supply_type_id_seq', 4, true);


--
-- Name: time_slot_time_slot_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.time_slot_time_slot_id_seq', 80, true);


--
-- Name: visit_diagnosis_visit_diagnosis_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.visit_diagnosis_visit_diagnosis_id_seq', 244, true);


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
-- Name: patient_vitals_one_per_visit; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patient_vitals_one_per_visit ON public.patient_vitals USING btree (appointment_id) WHERE (appointment_id IS NOT NULL);


--
-- Name: service_fee_one_no_show; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX service_fee_one_no_show ON public.service_fee USING btree (category) WHERE ((category)::text = 'No Show'::text);


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
-- Name: appointment appointment_no_show_fee_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER appointment_no_show_fee_trigger AFTER UPDATE OF status ON public.appointment FOR EACH ROW EXECUTE FUNCTION public.no_show_fee();


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
-- Name: employee employee_deactivation_check_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER employee_deactivation_check_trigger BEFORE UPDATE OF is_active ON public.employee FOR EACH ROW EXECUTE FUNCTION public.check_doctor_deactivation();


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

\unrestrict 0yodWBYQ8XNUgGyiU4PXoB0rfDMJ5IsNPasKcRTuf2azhrWwmMtXKjQ3qblNLuO


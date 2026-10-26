-- Service fees and itemized invoices:
--   service_fee holds the price of every visit (by specialty), lab test, and medication
--   invoice_item holds the lines of an invoice, so one invoice can have many fees
--   invoice.amount is kept equal to the sum of its lines by a trigger
--   checking a patient out creates the visit's invoice automatically
--   lab tests and prescriptions added to the visit later are added while the invoice is unpaid,
--   and removed again if they're cancelled or stopped while it's unpaid
--
-- Needs migration 011 (invoice and payment changes must say which employee made them).
-- The app sets app.employee_id itself. This file uses the admin's ID (1017) for the old invoices.
--
-- waiting for review, so it hasn't been run on Supabase yet

BEGIN;

SELECT set_config('app.employee_id', '1017', true);

-- one row per price: a visit for a specialty, a lab test, or a medication
CREATE TABLE public.service_fee (
    fee_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category character varying(20) NOT NULL,
    type character varying(50),
    name character varying(100) NOT NULL,
    price numeric(10,2) NOT NULL,
    specialty_id integer REFERENCES public.specialty(specialty_id) ON DELETE RESTRICT,
    lab_test_type_id integer REFERENCES public.lab_test_type(lab_test_type_id) ON DELETE RESTRICT,
    medication_id integer REFERENCES public.medication(medication_id) ON DELETE RESTRICT,
    is_active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_service_fee_category CHECK (category IN ('Visit', 'Lab Test', 'Medication')),
    CONSTRAINT chk_service_fee_price CHECK (price >= 0),
    -- each fee points to exactly the one thing its category prices
    CONSTRAINT chk_service_fee_link CHECK (
        (category = 'Visit' AND specialty_id IS NOT NULL AND lab_test_type_id IS NULL AND medication_id IS NULL)
        OR (category = 'Lab Test' AND lab_test_type_id IS NOT NULL AND specialty_id IS NULL AND medication_id IS NULL)
        OR (category = 'Medication' AND medication_id IS NOT NULL AND specialty_id IS NULL AND lab_test_type_id IS NULL)
    )
);

-- one price for each specialty, lab test, and medication
CREATE UNIQUE INDEX service_fee_one_per_specialty ON public.service_fee (specialty_id) WHERE specialty_id IS NOT NULL;
CREATE UNIQUE INDEX service_fee_one_per_lab_test ON public.service_fee (lab_test_type_id) WHERE lab_test_type_id IS NOT NULL;
CREATE UNIQUE INDEX service_fee_one_per_medication ON public.service_fee (medication_id) WHERE medication_id IS NOT NULL;

-- the lines of an invoice, with the price copied in so later price changes don't change old invoices
CREATE TABLE public.invoice_item (
    invoice_item_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id integer NOT NULL REFERENCES public.invoice(invoice_id) ON DELETE RESTRICT,
    fee_id integer REFERENCES public.service_fee(fee_id) ON DELETE RESTRICT,
    category character varying(20) NOT NULL,
    description character varying(150) NOT NULL,
    price numeric(10,2) NOT NULL,
    lab_order_id integer UNIQUE REFERENCES public.lab_order(lab_order_id) ON DELETE RESTRICT,
    prescription_item_id integer UNIQUE REFERENCES public.prescription_item(prescription_item_id) ON DELETE RESTRICT,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_invoice_item_category CHECK (category IN ('Visit', 'Lab Test', 'Medication')),
    CONSTRAINT chk_invoice_item_price CHECK (price >= 0)
);

CREATE INDEX idx_invoice_item_invoice ON public.invoice_item (invoice_id);

-- like every other table, so Supabase's public API roles can't read or change them
ALTER TABLE public.service_fee ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_item ENABLE ROW LEVEL SECURITY;

-- Supabase also grants those roles access to new tables, so take it back.
-- The loop skips roles that only exist on Supabase.
DO $$
DECLARE
    api_role text;
BEGIN
    FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
        EXECUTE format('REVOKE ALL ON public.service_fee FROM %I', api_role);
        EXECUTE format('REVOKE ALL ON public.invoice_item FROM %I', api_role);
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------
-- starting prices (the admin changes them on the Fees page)
-- ---------------------------------------------------------------------

-- visits, priced by specialty
INSERT INTO public.service_fee (category, type, name, price, specialty_id)
SELECT 'Visit', v.type, s.name || ' visit', v.price, s.specialty_id
FROM (VALUES
    ('Family Medicine', 'Primary Care', 150.00),
    ('Internal Medicine', 'Primary Care', 175.00),
    ('Cardiology', 'Specialist', 275.00),
    ('Dermatology', 'Specialist', 200.00),
    ('Orthopedics', 'Specialist', 250.00),
    ('Neurology', 'Specialist', 300.00),
    ('Endocrinology', 'Specialist', 225.00)
) AS v(specialty, type, price)
JOIN public.specialty s ON s.name = v.specialty;

-- any other specialty gets the primary care price until the admin changes it
INSERT INTO public.service_fee (category, type, name, price, specialty_id)
SELECT 'Visit', 'Specialist', s.name || ' visit', 150.00, s.specialty_id
FROM public.specialty s
WHERE NOT EXISTS (SELECT 1 FROM public.service_fee f WHERE f.specialty_id = s.specialty_id);

-- lab tests, starting from the cost already saved on each test
INSERT INTO public.service_fee (category, type, name, price, lab_test_type_id)
SELECT 'Lab Test', CASE WHEN t.name ILIKE '%urin%' THEN 'Urine Test' ELSE 'Blood Test' END, t.name, t.cost, t.lab_test_type_id
FROM public.lab_test_type t;

-- medications, priced per prescription fill
INSERT INTO public.service_fee (category, type, name, price, medication_id)
SELECT 'Medication', COALESCE(v.type, 'Other'), m.name, COALESCE(v.price, 20.00), m.medication_id
FROM public.medication m
LEFT JOIN (VALUES
    ('Lisinopril', 'Blood Pressure', 15.00),
    ('Amlodipine', 'Blood Pressure', 15.00),
    ('Metformin', 'Diabetes', 12.00),
    ('Atorvastatin', 'Cholesterol', 20.00),
    ('Levothyroxine', 'Thyroid', 18.00),
    ('Omeprazole', 'Stomach', 22.00),
    ('Albuterol inhaler', 'Breathing', 45.00),
    ('Ibuprofen', 'Pain Relief', 8.00),
    ('Acetaminophen', 'Pain Relief', 6.00),
    ('Sertraline', 'Mental Health', 25.00)
) AS v(medication, type, price) ON v.medication = m.name;

-- ---------------------------------------------------------------------
-- triggers
-- ---------------------------------------------------------------------

-- keeps invoice.amount equal to its lines, and Paid or Pending to match what's paid
CREATE OR REPLACE FUNCTION public.refresh_invoice_total(target_invoice integer) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
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

CREATE OR REPLACE FUNCTION public.invoice_item_changed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    PERFORM public.refresh_invoice_total(CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER invoice_item_total_trigger
    AFTER INSERT OR DELETE ON public.invoice_item
    FOR EACH ROW EXECUTE FUNCTION public.invoice_item_changed();

-- the open (not void) invoice of a visit, only while it's still unpaid
CREATE OR REPLACE FUNCTION public.unpaid_visit_invoice(visit integer) RETURNS integer
LANGUAGE sql
SET search_path = ''
AS $$
    SELECT invoice_id FROM public.invoice WHERE appointment_id = visit AND status IN ('Pending', 'Overdue') LIMIT 1;
$$;

-- adds one lab order as a line on an invoice, at today's price
CREATE OR REPLACE FUNCTION public.add_lab_order_line(target_invoice integer, order_id integer) RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
    INSERT INTO public.invoice_item (invoice_id, fee_id, category, description, price, lab_order_id)
    SELECT target_invoice, f.fee_id, 'Lab Test', f.name, f.price, l.lab_order_id
    FROM public.lab_order l
    JOIN public.service_fee f ON f.lab_test_type_id = l.lab_test_type_id AND f.is_active
    WHERE l.lab_order_id = order_id
    ON CONFLICT (lab_order_id) DO NOTHING;
$$;

-- adds one prescribed medication as a line on an invoice, at today's price
CREATE OR REPLACE FUNCTION public.add_prescription_line(target_invoice integer, item_id integer) RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
    INSERT INTO public.invoice_item (invoice_id, fee_id, category, description, price, prescription_item_id)
    SELECT target_invoice, f.fee_id, 'Medication', f.name || ' (' || pi.dosage || ')', f.price, pi.prescription_item_id
    FROM public.prescription_item pi
    JOIN public.service_fee f ON f.medication_id = pi.medication_id AND f.is_active
    WHERE pi.prescription_item_id = item_id
    ON CONFLICT (prescription_item_id) DO NOTHING;
$$;

-- checking out (Completed) creates the invoice: the visit fee, its lab tests, and its medications
CREATE OR REPLACE FUNCTION public.invoice_completed_visit() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
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

CREATE OR REPLACE TRIGGER appointment_invoice_trigger
    AFTER UPDATE OF status ON public.appointment
    FOR EACH ROW EXECUTE FUNCTION public.invoice_completed_visit();

-- a lab test ordered for a visit that's already billed is added while the bill is unpaid,
-- and a cancelled one is taken off while the bill is unpaid
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
    open_invoice := public.unpaid_visit_invoice(NEW.appointment_id);
    IF open_invoice IS NULL THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'INSERT' AND NEW.status <> 'Cancelled' THEN
        PERFORM public.add_lab_order_line(open_invoice, NEW.lab_order_id);
    ELSIF TG_OP = 'UPDATE' AND NEW.status = 'Cancelled' AND OLD.status <> 'Cancelled' THEN
        DELETE FROM public.invoice_item WHERE invoice_id = open_invoice AND lab_order_id = NEW.lab_order_id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER lab_order_billing_trigger
    AFTER INSERT OR UPDATE OF status ON public.lab_order
    FOR EACH ROW EXECUTE FUNCTION public.lab_order_billing();

-- a medication prescribed at a visit that's already billed is added while the bill is unpaid,
-- and a stopped one is taken off while the bill is unpaid
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
    open_invoice := public.unpaid_visit_invoice(visit);
    IF open_invoice IS NULL THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'INSERT' AND NEW.is_active THEN
        PERFORM public.add_prescription_line(open_invoice, NEW.prescription_item_id);
    ELSIF TG_OP = 'UPDATE' AND OLD.is_active AND NOT NEW.is_active THEN
        DELETE FROM public.invoice_item WHERE invoice_id = open_invoice AND prescription_item_id = NEW.prescription_item_id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER prescription_item_billing_trigger
    AFTER INSERT OR UPDATE OF is_active ON public.prescription_item
    FOR EACH ROW EXECUTE FUNCTION public.prescription_item_billing();

-- ---------------------------------------------------------------------
-- old invoices: one line each for the amount they already have, so totals stay the same
-- ---------------------------------------------------------------------
INSERT INTO public.invoice_item (invoice_id, category, description, price, created_at)
SELECT i.invoice_id, 'Visit', 'Visit (billed before itemized fees)', i.amount, i.issue_date::timestamp
FROM public.invoice i;

COMMIT;

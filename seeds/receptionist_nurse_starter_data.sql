-- Starter (reference) data for the receptionist, billing and nurse pages.
-- Run in the Supabase SQL Editor. Safe to run more than once: rows that
-- already exist are skipped (ON CONFLICT DO NOTHING on each table's
-- UNIQUE name), so nothing is duplicated or overwritten.

-- Payment methods for the Billing page.
INSERT INTO public.payment_type (name) VALUES
    ('Cash'),
    ('Credit Card'),
    ('Debit Card'),
    ('Insurance'),
    ('Check')
ON CONFLICT (name) DO NOTHING;

-- Allergens nurses can pick on the chart.
INSERT INTO public.allergy_type (name, category) VALUES
    ('Penicillin', 'Medication'),
    ('Amoxicillin', 'Medication'),
    ('Sulfa drugs', 'Medication'),
    ('Aspirin', 'Medication'),
    ('Ibuprofen', 'Medication'),
    ('Codeine', 'Medication'),
    ('Peanuts', 'Food'),
    ('Tree nuts', 'Food'),
    ('Shellfish', 'Food'),
    ('Eggs', 'Food'),
    ('Milk', 'Food'),
    ('Latex', 'Environmental'),
    ('Pollen', 'Environmental'),
    ('Dust mites', 'Environmental'),
    ('Bee stings', 'Other')
ON CONFLICT (name) DO NOTHING;

-- Intake forms. Required ones show as "missing" on the Front Desk until
-- the receptionist marks them completed.
INSERT INTO public.form_type (name, is_required) VALUES
    ('Consent to Treat', true),
    ('HIPAA Privacy Acknowledgment', true),
    ('Medical History', true),
    ('Patient Satisfaction Survey', false)
ON CONFLICT (name) DO NOTHING;

-- Common medications for the nurse's home-medication picker (anything
-- not listed can still be typed in).
INSERT INTO public.medication (name, manufacturer) VALUES
    ('Lisinopril', NULL),
    ('Metformin', NULL),
    ('Atorvastatin', NULL),
    ('Amlodipine', NULL),
    ('Levothyroxine', NULL),
    ('Omeprazole', NULL),
    ('Albuterol inhaler', NULL),
    ('Ibuprofen', NULL),
    ('Acetaminophen', NULL),
    ('Sertraline', NULL)
ON CONFLICT (name) DO NOTHING;

-- Supplies and their types.
INSERT INTO public.supply_type (type_name) VALUES
    ('PPE'),
    ('Wound Care'),
    ('Injection'),
    ('Diagnostic')
ON CONFLICT (type_name) DO NOTHING;

INSERT INTO public.supply (name, supply_type_id)
SELECT s.name, st.supply_type_id
FROM (VALUES
    ('Nitrile gloves (box)', 'PPE'),
    ('Surgical masks (box)', 'PPE'),
    ('Gauze pads', 'Wound Care'),
    ('Adhesive bandages', 'Wound Care'),
    ('Alcohol prep pads', 'Injection'),
    ('Syringes 3 mL', 'Injection'),
    ('Tongue depressors', 'Diagnostic'),
    ('Thermometer probe covers', 'Diagnostic')
) AS s(name, type_name)
JOIN public.supply_type st ON st.type_name = s.type_name
ON CONFLICT (name) DO NOTHING;

-- Stock every supply at every active office. A couple of items start low
-- or close to expiring so the Supplies page's warnings have something to
-- show. (UNIQUE (supply_id, office_id) keeps re-runs from duplicating.)
INSERT INTO public.office_supply (supply_id, office_id, quantity_on_hand, expiration_date, reorder_threshold)
SELECT
    sp.supply_id,
    o.office_id,
    stock.quantity_on_hand,
    CASE WHEN stock.expires_in_days IS NULL THEN NULL ELSE CURRENT_DATE + stock.expires_in_days END,
    stock.reorder_threshold
FROM (VALUES
    ('Nitrile gloves (box)', 40, NULL, 10),
    ('Surgical masks (box)', 8, NULL, 10),       -- low stock
    ('Gauze pads', 120, 20, 30),                  -- expiring soon
    ('Adhesive bandages', 200, 365, 50),
    ('Alcohol prep pads', 300, 400, 100),
    ('Syringes 3 mL', 150, 500, 40),
    ('Tongue depressors', 250, NULL, 50),
    ('Thermometer probe covers', 60, NULL, 100)  -- low stock
) AS stock(supply_name, quantity_on_hand, expires_in_days, reorder_threshold)
JOIN public.supply sp ON sp.name = stock.supply_name
CROSS JOIN public.office o
WHERE o.is_active
ON CONFLICT (supply_id, office_id) DO NOTHING;

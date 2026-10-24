-- lab technician role: new employee type, and who entered each lab result and when
-- run once in the Supabase SQL editor

BEGIN;

-- new employee type
INSERT INTO employee_types (type_name)
SELECT 'Lab Technician'
WHERE NOT EXISTS (SELECT 1 FROM employee_types WHERE type_name = 'Lab Technician');

-- who entered the result (empty until a lab tech completes the order)
ALTER TABLE lab_order
  ADD COLUMN performed_by_employee_id integer REFERENCES employee(employee_id) ON DELETE RESTRICT;

-- when the result was entered
ALTER TABLE lab_order
  ADD COLUMN result_date timestamp;

COMMIT;

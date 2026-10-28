-- Lab Technician employee type, plus who entered each lab result and when

BEGIN;

INSERT INTO employee_types (type_name)
SELECT 'Lab Technician'
WHERE NOT EXISTS (SELECT 1 FROM employee_types WHERE type_name = 'Lab Technician');

ALTER TABLE lab_order
  ADD COLUMN performed_by_employee_id integer REFERENCES employee(employee_id) ON DELETE RESTRICT;

ALTER TABLE lab_order
  ADD COLUMN result_date timestamp;

COMMIT;

-- visit_diagnosis: each diagnosis a doctor adds at a visit, with the reasoning

BEGIN;

CREATE TABLE visit_diagnosis (
  visit_diagnosis_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id integer NOT NULL REFERENCES appointment(appointment_id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  reasoning text,
  recorded_by_employee_id integer NOT NULL REFERENCES employee(employee_id) ON DELETE RESTRICT,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT chk_visit_diagnosis_name CHECK (length(trim(name)) > 0)
);

CREATE INDEX idx_visit_diagnosis_appointment ON visit_diagnosis (appointment_id);

ALTER TABLE visit_diagnosis ENABLE ROW LEVEL SECURITY;

COMMIT;

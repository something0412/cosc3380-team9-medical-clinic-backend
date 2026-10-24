-- Sample data loaded before each test file. IDs are generated in insert order.
-- Password hashes are replaced with TEST_PASSWORD after loading.

-- employee type IDs are 1 Administrator, 2 Doctor, 3 Nurse, 4 Receptionist, 5 Intern (inactive)
INSERT INTO employee_types (type_name) VALUES ('Administrator'), ('Doctor'), ('Nurse'), ('Receptionist');
INSERT INTO employee_types (type_name, is_active) VALUES ('Intern', false);

-- office IDs are 1 Main Street, 2 Westside, 3 Closed (inactive)
INSERT INTO office (name, street, city, state, zip, phone) VALUES
  ('Main Street Clinic', '1 Main St', 'Houston', 'TX', '77001', '713-555-0100'),
  ('Westside Clinic', '2 West St', 'Houston', 'TX', '77002', '713-555-0200');
INSERT INTO office (name, street, city, state, zip, phone, is_active) VALUES
  ('Closed Clinic', '3 Old St', 'Houston', 'TX', '77003', '713-555-0300', false);

-- specialty IDs are 1 Family Medicine, 2 Cardiology (referral), 3 Retired Specialty (inactive)
INSERT INTO specialty (name) VALUES ('Family Medicine');
INSERT INTO specialty (name, requires_referral) VALUES ('Cardiology', true);
INSERT INTO specialty (name, is_active) VALUES ('Retired Specialty', false);

-- shift 1 is Morning
INSERT INTO shift_type (name, start_time, end_time) VALUES ('Morning', '08:00', '12:00');

-- employee IDs are 1 admin, 2 doctor, 3 nurse, 4 receptionist (no login)
INSERT INTO employee (first_name, last_name, dob, employee_type_id, phone, email, office_id) VALUES
  ('Ada', 'Admin', '1980-01-01', 1, '713-555-1000', 'ada@test.org', 1),
  ('Dan', 'Doctor', '1975-05-05', 2, '713-555-1001', 'dan@test.org', 1),
  ('Nina', 'Nurse', '1985-03-03', 3, '713-555-1002', 'nina@test.org', 2),
  ('Rita', 'Reception', '1990-07-07', 4, '713-555-1003', 'rita@test.org', 2);

INSERT INTO employee_creds (employee_id, username, password_hash) VALUES
  (1, 'ada@test.org', 'replaced'),
  (2, 'dan@test.org', 'replaced'),
  (3, 'nina@test.org', 'replaced');

INSERT INTO doctor VALUES (2, 'TX-DAN1', 'TX', '2030-01-01', '1111111111', NULL);
INSERT INTO doctor_specialty (doctor_id, specialty_id, is_primary) VALUES (2, 1, true), (2, 2, false);
INSERT INTO doctor_schedule (doctor_id, day_of_week, office_id, specialty_id, shift_type_id) VALUES (2, 'Monday', 1, 2, 1);

INSERT INTO nurse VALUES (3, 'RN-NINA1', 'TX', '2030-01-01', 'RN');

-- patient 1 with a login
INSERT INTO patient (first_name, last_name, dob, phone, email) VALUES ('Pat', 'Patient', '1990-01-01', '713-555-9000', 'pat@test.org');
INSERT INTO patient_creds (patient_id, username, password_hash) VALUES (1, 'pat@test.org', 'replaced');

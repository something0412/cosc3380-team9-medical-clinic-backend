-- Vitals recorded by nurses. Run once, after 001_appointment_check_in.sql.

CREATE TABLE patient_vitals (
  vitals_id integer GENERATED ALWAYS AS IDENTITY NOT NULL ,

     patient_id integer NOT NULL,
     appointment_id integer, 
     recorded_by_employee_id integer NOT NULL, 

     temperature decimal(5,2) CHECK (temperature >0),

     heartrate_bpm integer CHECK (heartrate_bpm > 0),
     systolic_bp integer CHECK (systolic_bp >0 ),
     diastolic_bp integer CHECK (diastolic_bp >0),
     weight_lbs numeric(5,2) CHECK (weight_lbs >0) ,
     height_inches decimal(5,2) CHECK (height_inches > 0) ,

     CONSTRAINT patient_vitals_pkey PRIMARY KEY (vitals_id),
     CONSTRAINT patient_vitals_patient_id_fkey FOREIGN KEY (patient_id)REFERENCES public.patient(patient_id),
     CONSTRAINT patient_vitals_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointment(appointment_id),
     CONSTRAINT patient_vitals_employee_id_fkey FOREIGN KEY (recorded_by_employee_id) REFERENCES public.employee(employee_id)
);

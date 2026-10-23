-- patient_vitals: recorded time, respiratory rate, oxygen level, no limits on readings
-- run once in the Supabase SQL editor

BEGIN;

-- new columns
ALTER TABLE patient_vitals
  ADD COLUMN recorded_at timestamp NOT NULL DEFAULT now(),
  ADD COLUMN respiratory_rate integer,
  ADD COLUMN oxygen_saturation integer;

-- remove the > 0 checks so any reading can be saved
ALTER TABLE patient_vitals
  DROP CONSTRAINT patient_vitals_temperature_check,
  DROP CONSTRAINT patient_vitals_heartrate_bpm_check,
  DROP CONSTRAINT patient_vitals_systolic_bp_check,
  DROP CONSTRAINT patient_vitals_diastolic_bp_check,
  DROP CONSTRAINT patient_vitals_weight_lbs_check,
  DROP CONSTRAINT patient_vitals_height_inches_check;

-- allow readings above 999.99
ALTER TABLE patient_vitals
  ALTER COLUMN temperature TYPE numeric(10,2),
  ALTER COLUMN weight_lbs TYPE numeric(10,2),
  ALTER COLUMN height_inches TYPE numeric(10,2);

-- a row needs at least one reading
ALTER TABLE patient_vitals
  ADD CONSTRAINT patient_vitals_has_reading_check CHECK (
    num_nonnulls(temperature, heartrate_bpm, systolic_bp, diastolic_bp, respiratory_rate, oxygen_saturation, weight_lbs, height_inches) > 0
  );

-- fast lookup of a patient's latest vitals
CREATE INDEX idx_patient_vitals_patient_recorded ON patient_vitals (patient_id, recorded_at DESC);

COMMIT;

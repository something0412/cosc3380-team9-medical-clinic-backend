-- patient_vitals: add recorded time, respiratory rate and oxygen level; remove the limits on readings

BEGIN;

ALTER TABLE patient_vitals
  ADD COLUMN recorded_at timestamp NOT NULL DEFAULT now(),
  ADD COLUMN respiratory_rate integer,
  ADD COLUMN oxygen_saturation integer;

ALTER TABLE patient_vitals
  DROP CONSTRAINT patient_vitals_temperature_check,
  DROP CONSTRAINT patient_vitals_heartrate_bpm_check,
  DROP CONSTRAINT patient_vitals_systolic_bp_check,
  DROP CONSTRAINT patient_vitals_diastolic_bp_check,
  DROP CONSTRAINT patient_vitals_weight_lbs_check,
  DROP CONSTRAINT patient_vitals_height_inches_check;

ALTER TABLE patient_vitals
  ALTER COLUMN temperature TYPE numeric(10,2),
  ALTER COLUMN weight_lbs TYPE numeric(10,2),
  ALTER COLUMN height_inches TYPE numeric(10,2);

ALTER TABLE patient_vitals
  ADD CONSTRAINT patient_vitals_has_reading_check CHECK (
    num_nonnulls(temperature, heartrate_bpm, systolic_bp, diastolic_bp, respiratory_rate, oxygen_saturation, weight_lbs, height_inches) > 0
  );

CREATE INDEX idx_patient_vitals_patient_recorded ON patient_vitals (patient_id, recorded_at DESC);

COMMIT;

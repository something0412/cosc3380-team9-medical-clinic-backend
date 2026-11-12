-- each visit keeps at most one vitals row; saving again updates that row
-- visits that already have more than one keep only their newest row

BEGIN;

-- delete every vitals row that has a newer one for the same visit
DELETE FROM public.patient_vitals v
USING public.patient_vitals newer
WHERE v.appointment_id = newer.appointment_id
  AND (newer.recorded_at, newer.vitals_id) > (v.recorded_at, v.vitals_id);

-- one row per visit; older readings with no visit are not affected
CREATE UNIQUE INDEX patient_vitals_one_per_visit ON public.patient_vitals (appointment_id) WHERE appointment_id IS NOT NULL;

COMMIT;

-- A minimal doctor schedule so appointments can be booked while testing.
-- Doctor scheduling belongs to the doctor side of the project: check with
-- that teammate before running this in Supabase.
--
-- What it creates (safe to run more than once — existing rows are kept):
--   * two shifts: Morning 08:00-12:00 and Afternoon 13:00-17:00
--   * 30-minute time slots inside each shift
--   * every active doctor works Monday-Friday mornings, at the office in
--     their employee record, as their primary specialty (or any specialty
--     if none is marked primary)

-- Shifts (shift_type.name isn't UNIQUE, so check before inserting).
INSERT INTO public.shift_type (name, start_time, end_time)
SELECT s.name, s.start_time, s.end_time
FROM (VALUES
    ('Morning', time '08:00', time '12:00'),
    ('Afternoon', time '13:00', time '17:00')
) AS s(name, start_time, end_time)
WHERE NOT EXISTS (SELECT 1 FROM public.shift_type st WHERE st.name = s.name);

-- 30-minute slots across each shift: generate_series walks from the
-- shift's start to 30 minutes before its end.
INSERT INTO public.time_slot (shift_type_id, start_time, end_time)
SELECT st.shift_type_id, slot_start::time, (slot_start + interval '30 minutes')::time
FROM public.shift_type st
CROSS JOIN LATERAL generate_series(
    date '2000-01-01' + st.start_time,
    date '2000-01-01' + st.end_time - interval '30 minutes',
    interval '30 minutes'
) AS slot_start
WHERE st.name IN ('Morning', 'Afternoon')
  AND NOT EXISTS (
      SELECT 1 FROM public.time_slot ts
      WHERE ts.shift_type_id = st.shift_type_id AND ts.start_time = slot_start::time
  );

-- Each doctor's schedule: one row per weekday (primary key is
-- (doctor_id, day_of_week)). DISTINCT ON picks one specialty per doctor,
-- the primary one first.
INSERT INTO public.doctor_schedule (doctor_id, day_of_week, office_id, specialty_id, shift_type_id)
SELECT ds.doctor_id, d.day_of_week, e.office_id, ds.specialty_id, morning.shift_type_id
FROM (
    SELECT DISTINCT ON (doctor_id) doctor_id, specialty_id
    FROM public.doctor_specialty
    WHERE is_active
    ORDER BY doctor_id, is_primary DESC, specialty_id
) AS ds
JOIN public.employee e ON e.employee_id = ds.doctor_id AND e.is_active
CROSS JOIN (VALUES ('Monday'), ('Tuesday'), ('Wednesday'), ('Thursday'), ('Friday')) AS d(day_of_week)
CROSS JOIN (SELECT shift_type_id FROM public.shift_type WHERE name = 'Morning' ORDER BY shift_type_id LIMIT 1) AS morning
ON CONFLICT (doctor_id, day_of_week) DO NOTHING;

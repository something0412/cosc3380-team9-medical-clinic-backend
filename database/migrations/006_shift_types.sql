-- shift types and their 30-minute appointment time slots
-- run once in the Supabase SQL editor; shifts that already exist (same name) are skipped

BEGIN;

-- shifts
INSERT INTO shift_type (name, start_time, end_time)
SELECT v.name, v.start_time::time, v.end_time::time
FROM (VALUES
  ('Morning', '08:00', '12:00'),
  ('Afternoon', '13:00', '17:00'),
  ('Full Day', '08:00', '17:00')
) AS v(name, start_time, end_time)
WHERE NOT EXISTS (SELECT 1 FROM shift_type s WHERE LOWER(s.name) = LOWER(v.name));

-- time slots for each shift (Full Day has a 12:00-13:00 lunch break)
INSERT INTO time_slot (shift_type_id, start_time, end_time)
SELECT s.shift_type_id, v.start_time::time, v.end_time::time
FROM (VALUES
  ('Morning', '08:00', '08:30'),
  ('Morning', '08:30', '09:00'),
  ('Morning', '09:00', '09:30'),
  ('Morning', '09:30', '10:00'),
  ('Morning', '10:00', '10:30'),
  ('Morning', '10:30', '11:00'),
  ('Morning', '11:00', '11:30'),
  ('Morning', '11:30', '12:00'),

  ('Afternoon', '13:00', '13:30'),
  ('Afternoon', '13:30', '14:00'),
  ('Afternoon', '14:00', '14:30'),
  ('Afternoon', '14:30', '15:00'),
  ('Afternoon', '15:00', '15:30'),
  ('Afternoon', '15:30', '16:00'),
  ('Afternoon', '16:00', '16:30'),
  ('Afternoon', '16:30', '17:00'),

  ('Full Day', '08:00', '08:30'),
  ('Full Day', '08:30', '09:00'),
  ('Full Day', '09:00', '09:30'),
  ('Full Day', '09:30', '10:00'),
  ('Full Day', '10:00', '10:30'),
  ('Full Day', '10:30', '11:00'),
  ('Full Day', '11:00', '11:30'),
  ('Full Day', '11:30', '12:00'),
  ('Full Day', '13:00', '13:30'),
  ('Full Day', '13:30', '14:00'),
  ('Full Day', '14:00', '14:30'),
  ('Full Day', '14:30', '15:00'),
  ('Full Day', '15:00', '15:30'),
  ('Full Day', '15:30', '16:00'),
  ('Full Day', '16:00', '16:30'),
  ('Full Day', '16:30', '17:00')
) AS v(shift_name, start_time, end_time)
JOIN shift_type s ON s.name = v.shift_name
WHERE NOT EXISTS (
  SELECT 1 FROM time_slot t
  WHERE t.shift_type_id = s.shift_type_id AND t.start_time = v.start_time::time
);

COMMIT;

-- check the result
SELECT s.name, to_char(s.start_time, 'HH24:MI') AS starts, to_char(s.end_time, 'HH24:MI') AS ends, count(t.time_slot_id) AS time_slots
FROM shift_type s
LEFT JOIN time_slot t ON t.shift_type_id = s.shift_type_id
GROUP BY s.shift_type_id
ORDER BY s.start_time, s.end_time;

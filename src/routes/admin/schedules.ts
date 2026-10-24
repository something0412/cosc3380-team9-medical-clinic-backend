import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { CLINIC_TODAY } from "../../lib/clinicTime.js";
import { pool } from "../../lib/db.js";
import { withTransaction } from "../../lib/transaction.js";
import { HttpError } from "../../middleware/errorHandler.js";

export const adminSchedulesRouter = Router();

// allowed values match chk_doctor_schedule_day
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

const idParam = z.coerce.number().int().positive();
const dayParam = z.enum(DAYS, "Day must be a weekday name like Monday");

const assignmentSchema = z.object({
  officeId: z.number("Select an office").int().positive(),
  specialtyId: z.number("Select a specialty").int().positive(),
  shiftTypeId: z.number("Select a shift").int().positive(),
});

const createSchema = assignmentSchema.extend({
  doctorId: z.number("Select a doctor").int().positive(),
  dayOfWeek: dayParam,
});

const statusSchema = z.object({ isActive: z.boolean("Status must be true or false") });

type Assignment = z.infer<typeof assignmentSchema> & { doctorId: number };

const SCHEDULE_COLUMNS = `
  ds.doctor_id AS "doctorId",
  e.first_name AS "doctorFirstName",
  e.last_name AS "doctorLastName",
  e.is_active AS "doctorIsActive",
  ds.day_of_week AS "dayOfWeek",
  ds.office_id AS "officeId",
  o.name AS "officeName",
  ds.specialty_id AS "specialtyId",
  s.name AS "specialtyName",
  ds.shift_type_id AS "shiftTypeId",
  st.name AS "shiftName",
  to_char(st.start_time, 'HH24:MI') AS "startTime",
  to_char(st.end_time, 'HH24:MI') AS "endTime",
  ds.is_active AS "isActive"
`;

const SCHEDULE_JOINS = `
  FROM doctor_schedule ds
  JOIN employee e ON e.employee_id = ds.doctor_id
  JOIN office o ON o.office_id = ds.office_id
  JOIN specialty s ON s.specialty_id = ds.specialty_id
  JOIN shift_type st ON st.shift_type_id = ds.shift_type_id
`;

async function loadSchedule(doctorId: number, dayOfWeek: string) {
  const result = await pool.query(
    `SELECT ${SCHEDULE_COLUMNS} ${SCHEDULE_JOINS} WHERE ds.doctor_id = $1 AND ds.day_of_week = $2`,
    [doctorId, dayOfWeek]
  );
  return result.rows[0] ?? null;
}

function scheduleKey(params: Record<string, string | undefined>) {
  return { doctorId: idParam.parse(params.doctorId), dayOfWeek: dayParam.parse(params.dayOfWeek) };
}

// doctor, office, specialty, and shift must all be active, and the doctor must practice the specialty
async function checkAssignment(client: PoolClient, a: Assignment) {
  const result = await client.query(
    `
    SELECT
      EXISTS (SELECT 1 FROM doctor d JOIN employee e ON e.employee_id = d.employee_id WHERE d.employee_id = $1 AND e.is_active) AS "doctorOk",
      EXISTS (SELECT 1 FROM office WHERE office_id = $2 AND is_active) AS "officeOk",
      EXISTS (SELECT 1 FROM specialty WHERE specialty_id = $3 AND is_active) AS "specialtyOk",
      EXISTS (SELECT 1 FROM doctor_specialty WHERE doctor_id = $1 AND specialty_id = $3 AND is_active) AS "practicesOk",
      EXISTS (SELECT 1 FROM shift_type WHERE shift_type_id = $4 AND is_active) AS "shiftOk"
    `,
    [a.doctorId, a.officeId, a.specialtyId, a.shiftTypeId]
  );
  const check = result.rows[0];
  if (!check.doctorOk) throw new HttpError(409, "The doctor doesn't exist or is inactive");
  if (!check.officeOk) throw new HttpError(409, "The office doesn't exist or is inactive");
  if (!check.specialtyOk) throw new HttpError(409, "The specialty doesn't exist or is inactive");
  if (!check.practicesOk) throw new HttpError(409, "The doctor isn't assigned to that specialty");
  if (!check.shiftOk) throw new HttpError(409, "The shift doesn't exist or is inactive");
}

// upcoming booked appointments on this weekday that wouldn't fit the given assignment (or all of them when null)
async function countConflictingAppointments(client: PoolClient, doctorId: number, dayOfWeek: string, keep: Assignment | null) {
  const result = await client.query(
    `
    SELECT COUNT(*)::int AS count
    FROM appointment a
    JOIN time_slot t ON t.time_slot_id = a.time_slot_id
    WHERE a.doctor_id = $1
      AND EXTRACT(ISODOW FROM a.appointment_date) = $2
      AND a.appointment_date >= ${CLINIC_TODAY}
      AND a.status = 'Scheduled'
      AND ($3::int IS NULL OR a.office_id <> $3 OR a.specialty_id <> $4 OR t.shift_type_id <> $5)
    `,
    [doctorId, DAYS.indexOf(dayOfWeek as (typeof DAYS)[number]) + 1, keep?.officeId ?? null, keep?.specialtyId ?? null, keep?.shiftTypeId ?? null]
  );
  return result.rows[0].count as number;
}

const appointmentsMessage = (count: number, dayOfWeek: string) =>
  `${count} upcoming appointment${count === 1 ? " is" : "s are"} booked with this doctor on ${dayOfWeek}s. Reschedule or cancel ${count === 1 ? "it" : "them"} first.`;

// weekly schedules for every doctor, active and inactive
adminSchedulesRouter.get("/", async (_req, res) => {
  const result = await pool.query(`
    SELECT ${SCHEDULE_COLUMNS} ${SCHEDULE_JOINS}
    ORDER BY e.last_name, e.first_name, ds.doctor_id,
      array_position(ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']::varchar[], ds.day_of_week)
  `);

  res.json(result.rows);
});

// active doctors and the specialties they practice, for the schedule form
adminSchedulesRouter.get("/doctor-options", async (_req, res) => {
  const result = await pool.query(`
    SELECT
      e.employee_id AS "doctorId",
      e.first_name AS "firstName",
      e.last_name AS "lastName",
      COALESCE(
        json_agg(json_build_object('specialtyId', s.specialty_id, 'name', s.name, 'isActive', s.is_active) ORDER BY s.name)
          FILTER (WHERE s.specialty_id IS NOT NULL),
        '[]'
      ) AS specialties
    FROM doctor d
    JOIN employee e ON e.employee_id = d.employee_id
    LEFT JOIN doctor_specialty ds ON ds.doctor_id = d.employee_id AND ds.is_active
    LEFT JOIN specialty s ON s.specialty_id = ds.specialty_id
    WHERE e.is_active
    GROUP BY e.employee_id
    ORDER BY e.last_name, e.first_name
  `);

  res.json(result.rows);
});

adminSchedulesRouter.get("/:doctorId/:dayOfWeek", async (req, res) => {
  const { doctorId, dayOfWeek } = scheduleKey(req.params);
  const schedule = await loadSchedule(doctorId, dayOfWeek);
  if (!schedule) throw new HttpError(404, "Schedule not found");
  res.json(schedule);
});

// assign a doctor to an office, specialty, and shift for one weekday
adminSchedulesRouter.post("/", async (req, res) => {
  const body = createSchema.parse(req.body);

  await withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT is_active AS "isActive" FROM doctor_schedule WHERE doctor_id = $1 AND day_of_week = $2`,
      [body.doctorId, body.dayOfWeek]
    );
    if (existing.rowCount) {
      const state = existing.rows[0].isActive ? "" : " (inactive)";
      throw new HttpError(409, `This doctor already has a ${body.dayOfWeek} schedule${state}. Edit or reactivate it instead.`);
    }

    await checkAssignment(client, body);

    await client
      .query(
        `
        INSERT INTO doctor_schedule (doctor_id, day_of_week, office_id, specialty_id, shift_type_id)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [body.doctorId, body.dayOfWeek, body.officeId, body.specialtyId, body.shiftTypeId]
      )
      .catch((err) => {
        if ((err as { constraint?: string }).constraint === "doctor_schedule_pkey") {
          throw new HttpError(409, `This doctor already has a ${body.dayOfWeek} schedule. Edit or reactivate it instead.`);
        }
        throw err;
      });
  });

  res.status(201).json(await loadSchedule(body.doctorId, body.dayOfWeek));
});

// change the office, specialty, or shift while the doctor and weekday stay the same
adminSchedulesRouter.put("/:doctorId/:dayOfWeek", async (req, res) => {
  const { doctorId, dayOfWeek } = scheduleKey(req.params);
  const body = assignmentSchema.parse(req.body);
  const assignment = { ...body, doctorId };

  await withTransaction(async (client) => {
    const current = await client.query(
      `SELECT 1 FROM doctor_schedule WHERE doctor_id = $1 AND day_of_week = $2 FOR UPDATE`,
      [doctorId, dayOfWeek]
    );
    if (!current.rowCount) throw new HttpError(404, "Schedule not found");

    await checkAssignment(client, assignment);

    const conflicts = await countConflictingAppointments(client, doctorId, dayOfWeek, assignment);
    if (conflicts) throw new HttpError(409, appointmentsMessage(conflicts, dayOfWeek));

    await client.query(
      `UPDATE doctor_schedule SET office_id = $3, specialty_id = $4, shift_type_id = $5 WHERE doctor_id = $1 AND day_of_week = $2`,
      [doctorId, dayOfWeek, body.officeId, body.specialtyId, body.shiftTypeId]
    );
  });

  res.json(await loadSchedule(doctorId, dayOfWeek));
});

// activate or deactivate a weekly schedule. The row is kept either way
adminSchedulesRouter.patch("/:doctorId/:dayOfWeek/status", async (req, res) => {
  const { doctorId, dayOfWeek } = scheduleKey(req.params);
  const { isActive } = statusSchema.parse(req.body);

  await withTransaction(async (client) => {
    const current = await client.query(
      `
      SELECT is_active AS "isActive", office_id AS "officeId", specialty_id AS "specialtyId", shift_type_id AS "shiftTypeId"
      FROM doctor_schedule
      WHERE doctor_id = $1 AND day_of_week = $2
      FOR UPDATE
      `,
      [doctorId, dayOfWeek]
    );
    if (!current.rowCount) throw new HttpError(404, "Schedule not found");
    const schedule = current.rows[0];
    if (schedule.isActive === isActive) return;

    if (isActive) {
      await checkAssignment(client, { ...schedule, doctorId });
    } else {
      const booked = await countConflictingAppointments(client, doctorId, dayOfWeek, null);
      if (booked) throw new HttpError(409, appointmentsMessage(booked, dayOfWeek));
    }

    await client.query(`UPDATE doctor_schedule SET is_active = $3 WHERE doctor_id = $1 AND day_of_week = $2`, [
      doctorId,
      dayOfWeek,
      isActive,
    ]);
  });

  res.json(await loadSchedule(doctorId, dayOfWeek));
});

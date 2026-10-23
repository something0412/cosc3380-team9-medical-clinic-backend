import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { withTransaction } from "../../lib/transaction.js";
import { HttpError } from "../../middleware/errorHandler.js";

export const adminShiftsRouter = Router();
export const adminTimeSlotsRouter = Router();

const idParam = z.coerce.number().int().positive();
const time = (label: string) => z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, `${label} must be a time like 08:00`);

// HH:MM strings compare correctly as text
const hoursSchema = z
  .object({ startTime: time("Start time"), endTime: time("End time") })
  .refine((t) => t.startTime < t.endTime, { message: "End time must be after start time" });

const shiftSchema = hoursSchema.and(
  z.object({ name: z.string().trim().min(1, "Shift name is required").max(50, "Shift name must be 50 characters or less") })
);

const statusSchema = z.object({ isActive: z.boolean("Status must be true or false") });

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const booked = (count: number) => `${plural(count, "upcoming appointment")} ${count === 1 ? "is" : "are"} booked`;

// upcoming booked appointments in one time slot or in all slots of a shift
async function countUpcomingAppointments(client: PoolClient, where: "t.time_slot_id" | "t.shift_type_id", id: number) {
  const result = await client.query(
    `
    SELECT COUNT(*)::int AS count
    FROM appointment a
    JOIN time_slot t ON t.time_slot_id = a.time_slot_id
    WHERE ${where} = $1 AND a.appointment_date >= CURRENT_DATE AND a.status = 'Scheduled'
    `,
    [id]
  );
  return result.rows[0].count as number;
}

// shift types with their time slots and how many active schedules use them
adminShiftsRouter.get("/", async (_req, res) => {
  const result = await pool.query(`
    SELECT
      st.shift_type_id AS "shiftTypeId",
      st.name,
      to_char(st.start_time, 'HH24:MI') AS "startTime",
      to_char(st.end_time, 'HH24:MI') AS "endTime",
      st.is_active AS "isActive",
      (SELECT COUNT(*) FROM doctor_schedule ds WHERE ds.shift_type_id = st.shift_type_id AND ds.is_active)::int AS "activeScheduleCount",
      COALESCE(
        (
          SELECT json_agg(json_build_object(
            'timeSlotId', t.time_slot_id,
            'startTime', to_char(t.start_time, 'HH24:MI'),
            'endTime', to_char(t.end_time, 'HH24:MI'),
            'isActive', t.is_active
          ) ORDER BY t.start_time)
          FROM time_slot t
          WHERE t.shift_type_id = st.shift_type_id
        ),
        '[]'
      ) AS "timeSlots"
    FROM shift_type st
    ORDER BY st.start_time, st.name
  `);

  res.json(result.rows);
});

// shift names aren't unique in the schema, but duplicates would be confusing in dropdowns
async function checkShiftName(client: PoolClient, name: string, shiftTypeId: number | null) {
  const result = await client.query(`SELECT 1 FROM shift_type WHERE LOWER(name) = LOWER($1) AND shift_type_id <> $2`, [name, shiftTypeId ?? 0]);
  if (result.rowCount) throw new HttpError(409, "A shift with that name already exists");
}

adminShiftsRouter.post("/", async (req, res) => {
  const body = shiftSchema.parse(req.body);

  const created = await withTransaction(async (client) => {
    await checkShiftName(client, body.name, null);
    const result = await client.query(
      `INSERT INTO shift_type (name, start_time, end_time) VALUES ($1, $2, $3) RETURNING shift_type_id AS "shiftTypeId"`,
      [body.name, body.startTime, body.endTime]
    );
    return result.rows[0];
  });

  res.status(201).json(created);
});

// rename or change hours; active time slots must still fit inside the new hours
adminShiftsRouter.put("/:id", async (req, res) => {
  const shiftTypeId = idParam.parse(req.params.id);
  const body = shiftSchema.parse(req.body);

  await withTransaction(async (client) => {
    const current = await client.query(`SELECT 1 FROM shift_type WHERE shift_type_id = $1 FOR UPDATE`, [shiftTypeId]);
    if (!current.rowCount) throw new HttpError(404, "Shift not found");
    await checkShiftName(client, body.name, shiftTypeId);

    const outside = await client.query(
      `
      SELECT COUNT(*)::int AS count
      FROM time_slot
      WHERE shift_type_id = $1 AND is_active AND (start_time < $2::time OR end_time > $3::time)
      `,
      [shiftTypeId, body.startTime, body.endTime]
    );
    if (outside.rows[0].count) {
      throw new HttpError(409, `${plural(outside.rows[0].count, "active time slot")} would fall outside these hours. Update or deactivate them first.`);
    }

    await client.query(`UPDATE shift_type SET name = $2, start_time = $3, end_time = $4 WHERE shift_type_id = $1`, [
      shiftTypeId,
      body.name,
      body.startTime,
      body.endTime,
    ]);
  });

  res.json({ shiftTypeId });
});

// deactivation is blocked while active schedules or upcoming appointments use the shift
adminShiftsRouter.patch("/:id/status", async (req, res) => {
  const shiftTypeId = idParam.parse(req.params.id);
  const { isActive } = statusSchema.parse(req.body);

  await withTransaction(async (client) => {
    const current = await client.query(`SELECT is_active AS "isActive" FROM shift_type WHERE shift_type_id = $1 FOR UPDATE`, [shiftTypeId]);
    if (!current.rowCount) throw new HttpError(404, "Shift not found");
    if (current.rows[0].isActive === isActive) return;

    if (!isActive) {
      const schedules = await client.query(
        `SELECT COUNT(*)::int AS count FROM doctor_schedule WHERE shift_type_id = $1 AND is_active`,
        [shiftTypeId]
      );
      if (schedules.rows[0].count) {
        throw new HttpError(409, `${plural(schedules.rows[0].count, "active doctor schedule")} still use this shift. Change or deactivate them first.`);
      }
      const count = await countUpcomingAppointments(client, "t.shift_type_id", shiftTypeId);
      if (count) throw new HttpError(409, `${booked(count)} in this shift's time slots.`);
    }

    await client.query(`UPDATE shift_type SET is_active = $2 WHERE shift_type_id = $1`, [shiftTypeId, isActive]);
  });

  res.json({ shiftTypeId, isActive });
});

// slot must sit inside its shift and not overlap another active slot in the same shift
async function checkSlotFits(client: PoolClient, shiftTypeId: number, startTime: string, endTime: string, timeSlotId: number | null) {
  const shift = await client.query(
    `SELECT to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime" FROM shift_type WHERE shift_type_id = $1`,
    [shiftTypeId]
  );
  const hours = shift.rows[0];
  if (startTime < hours.startTime || endTime > hours.endTime) {
    throw new HttpError(409, `Time slots must be within the shift's hours (${hours.startTime}–${hours.endTime})`);
  }

  const overlap = await client.query(
    `
    SELECT to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime"
    FROM time_slot
    WHERE shift_type_id = $1 AND is_active AND time_slot_id <> $2 AND start_time < $4::time AND end_time > $3::time
    LIMIT 1
    `,
    [shiftTypeId, timeSlotId ?? 0, startTime, endTime]
  );
  if (overlap.rowCount) {
    const other = overlap.rows[0];
    throw new HttpError(409, `This overlaps the ${other.startTime}–${other.endTime} time slot`);
  }
}

// add a time slot to a shift
adminShiftsRouter.post("/:id/time-slots", async (req, res) => {
  const shiftTypeId = idParam.parse(req.params.id);
  const body = hoursSchema.parse(req.body);

  const created = await withTransaction(async (client) => {
    // lock the shift so two new slots can't overlap each other
    const shift = await client.query(`SELECT 1 FROM shift_type WHERE shift_type_id = $1 FOR UPDATE`, [shiftTypeId]);
    if (!shift.rowCount) throw new HttpError(404, "Shift not found");
    await checkSlotFits(client, shiftTypeId, body.startTime, body.endTime, null);

    const result = await client.query(
      `INSERT INTO time_slot (shift_type_id, start_time, end_time) VALUES ($1, $2, $3) RETURNING time_slot_id AS "timeSlotId"`,
      [shiftTypeId, body.startTime, body.endTime]
    );
    return result.rows[0];
  });

  res.status(201).json(created);
});

// change a slot's hours; blocked while upcoming appointments are booked in it
adminTimeSlotsRouter.put("/:id", async (req, res) => {
  const timeSlotId = idParam.parse(req.params.id);
  const body = hoursSchema.parse(req.body);

  await withTransaction(async (client) => {
    const slot = await client.query(`SELECT shift_type_id AS "shiftTypeId", is_active AS "isActive" FROM time_slot WHERE time_slot_id = $1`, [timeSlotId]);
    if (!slot.rowCount) throw new HttpError(404, "Time slot not found");
    const { shiftTypeId, isActive } = slot.rows[0];
    await client.query(`SELECT 1 FROM shift_type WHERE shift_type_id = $1 FOR UPDATE`, [shiftTypeId]);

    const count = await countUpcomingAppointments(client, "t.time_slot_id", timeSlotId);
    if (count) throw new HttpError(409, `${booked(count)} in this time slot, so its hours can't change.`);

    if (isActive) await checkSlotFits(client, shiftTypeId, body.startTime, body.endTime, timeSlotId);
    await client.query(`UPDATE time_slot SET start_time = $2, end_time = $3 WHERE time_slot_id = $1`, [timeSlotId, body.startTime, body.endTime]);
  });

  res.json({ timeSlotId });
});

adminTimeSlotsRouter.patch("/:id/status", async (req, res) => {
  const timeSlotId = idParam.parse(req.params.id);
  const { isActive } = statusSchema.parse(req.body);

  await withTransaction(async (client) => {
    const slot = await client.query(
      `
      SELECT shift_type_id AS "shiftTypeId", is_active AS "isActive",
        to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime"
      FROM time_slot
      WHERE time_slot_id = $1
      `,
      [timeSlotId]
    );
    if (!slot.rowCount) throw new HttpError(404, "Time slot not found");
    const current = slot.rows[0];
    if (current.isActive === isActive) return;

    await client.query(`SELECT 1 FROM shift_type WHERE shift_type_id = $1 FOR UPDATE`, [current.shiftTypeId]);
    if (isActive) {
      await checkSlotFits(client, current.shiftTypeId, current.startTime, current.endTime, timeSlotId);
    } else {
      const count = await countUpcomingAppointments(client, "t.time_slot_id", timeSlotId);
      if (count) throw new HttpError(409, `${booked(count)} in this time slot.`);
    }

    await client.query(`UPDATE time_slot SET is_active = $2 WHERE time_slot_id = $1`, [timeSlotId, isActive]);
  });

  res.json({ timeSlotId, isActive });
});

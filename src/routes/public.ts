import { Router } from "express";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { HttpError } from "../middleware/errorHandler.js";
import { findAvailability } from "../services/booking.js";
import { bookingDate } from "./booking.js";

// read only clinic information for the public website, no login required
export const publicRouter = Router();

// whole numbers that fit in a PostgreSQL integer column
const ID_MESSAGE = "ID must be a positive whole number";
const idParam = z.coerce.number(ID_MESSAGE).int(ID_MESSAGE).min(1, ID_MESSAGE).max(2147483647, ID_MESSAGE);

// weekly schedules where the doctor, office, specialty, assignment, and shift are all active
const ACTIVE_SCHEDULES = `
  WITH active_schedule AS (
    SELECT sch.doctor_id, sch.office_id, sch.specialty_id, sch.day_of_week
    FROM doctor_schedule sch
    JOIN employee e ON e.employee_id = sch.doctor_id AND e.is_active
    JOIN office o ON o.office_id = sch.office_id AND o.is_active
    JOIN specialty s ON s.specialty_id = sch.specialty_id AND s.is_active
    JOIN doctor_specialty ds ON ds.doctor_id = sch.doctor_id AND ds.specialty_id = sch.specialty_id AND ds.is_active
    JOIN shift_type st ON st.shift_type_id = sch.shift_type_id AND st.is_active
    WHERE sch.is_active
  )
`;

// a doctor's active specialties, primary first
const DOCTOR_SPECIALTIES = `
  COALESCE((
    SELECT json_agg(json_build_object('specialtyId', s.specialty_id, 'name', s.name, 'isPrimary', ds.is_primary) ORDER BY ds.is_primary DESC, s.name)
    FROM doctor_specialty ds
    JOIN specialty s ON s.specialty_id = ds.specialty_id
    WHERE ds.doctor_id = e.employee_id AND ds.is_active AND s.is_active
  ), '[]')
`;

const DAY_ORDER = `array_position(ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']::varchar[], a.day_of_week)`;

const OFFICE_COLUMNS = `
  o.office_id AS "officeId",
  o.name,
  o.street,
  o.apt,
  o.city,
  o.state,
  o.zip,
  o.phone
`;

// active doctors, or one doctor when an ID is given
async function loadDoctors(doctorId: number | null) {
  const result = await pool.query(
    `-- TODO P06: active doctors with their specialties and offices (booking doctor list)`,
    [doctorId]
  );
  return result.rows;
}

// doctor directory with practice offices taken only from active schedules
publicRouter.get("/doctors", async (_req, res) => {
  res.json(await loadDoctors(null));
});

// one doctor with the offices and weekdays they're scheduled to work
publicRouter.get("/doctors/:id", async (req, res) => {
  const doctorId = idParam.parse(req.params.id);
  const [doctor] = await loadDoctors(doctorId);
  if (!doctor) throw new HttpError(404, "Doctor not found");

  const offices = await pool.query(
    `
    ${ACTIVE_SCHEDULES}
    SELECT ${OFFICE_COLUMNS}, json_agg(a.day_of_week ORDER BY ${DAY_ORDER}) AS days
    FROM active_schedule a
    JOIN office o ON o.office_id = a.office_id
    WHERE a.doctor_id = $1
    GROUP BY o.office_id
    ORDER BY o.name
    `,
    [doctorId]
  );

  res.json({ ...doctor, offices: offices.rows });
});

// active offices
publicRouter.get("/offices", async (_req, res) => {
  const result = await pool.query(`SELECT ${OFFICE_COLUMNS} FROM office o WHERE o.is_active ORDER BY o.name`);
  res.json(result.rows);
});

// one office with the doctors and specialties scheduled there
publicRouter.get("/offices/:id", async (req, res) => {
  const officeId = idParam.parse(req.params.id);
  const office = await pool.query(`SELECT ${OFFICE_COLUMNS} FROM office o WHERE o.office_id = $1 AND o.is_active`, [officeId]);
  if (!office.rowCount) throw new HttpError(404, "Office not found");

  const doctors = await pool.query(
    `
    ${ACTIVE_SCHEDULES}
    SELECT
      e.employee_id AS "doctorId",
      e.first_name AS "firstName",
      e.last_name AS "lastName",
      json_agg(a.day_of_week ORDER BY ${DAY_ORDER}) AS days
    FROM active_schedule a
    JOIN employee e ON e.employee_id = a.doctor_id
    WHERE a.office_id = $1
    GROUP BY e.employee_id
    ORDER BY e.last_name, e.first_name
    `,
    [officeId]
  );

  const specialties = await pool.query(
    `
    ${ACTIVE_SCHEDULES}
    SELECT DISTINCT s.specialty_id AS "specialtyId", s.name
    FROM active_schedule a
    JOIN specialty s ON s.specialty_id = a.specialty_id
    WHERE a.office_id = $1
    ORDER BY s.name
    `,
    [officeId]
  );

  res.json({ ...office.rows[0], doctors: doctors.rows, specialties: specialties.rows });
});

// active specialties with how many active doctors practice each one
publicRouter.get("/specialties", async (_req, res) => {
  const result = await pool.query(`
    SELECT
      s.specialty_id AS "specialtyId",
      s.name,
      s.requires_referral AS "requiresReferral",
      (
        SELECT COUNT(DISTINCT ds.doctor_id)
        FROM doctor_specialty ds
        JOIN employee e ON e.employee_id = ds.doctor_id
        WHERE ds.specialty_id = s.specialty_id AND ds.is_active AND e.is_active
      )::int AS "doctorCount"
    FROM specialty s
    WHERE s.is_active
    ORDER BY s.name
  `);

  res.json(result.rows);
});

const availabilityQuery = z.object({
  specialtyId: idParam,
  date: bookingDate,
  days: z.coerce.number().int().min(1).max(14, "Search up to 14 days at a time").default(1),
  doctorId: idParam.optional(),
  officeId: idParam.optional(),
  // true also sends taken times (available: false) so the page can gray them out
  includeTaken: z.enum(["true", "false"]).optional(),
});

// open appointment times for visitors, searched without any patient or session
publicRouter.get("/availability", async (req, res) => {
  const { specialtyId, date, days, doctorId, officeId, includeTaken } = availabilityQuery.parse(req.query);
  const slots = await findAvailability({ specialtyId, date, days, doctorId, officeId }, includeTaken === "true");

  // only public fields, so a referral ID never reaches a visitor
  res.json(
    slots.map((slot) => ({
      date: slot.date,
      doctorId: slot.doctorId,
      doctorName: slot.doctorName,
      officeId: slot.officeId,
      officeName: slot.officeName,
      specialtyId: slot.specialtyId,
      specialty: slot.specialty,
      requiresReferral: slot.requiresReferral,
      timeSlotId: slot.timeSlotId,
      startTime: slot.startTime,
      endTime: slot.endTime,
      available: slot.available,
      unavailableReason: slot.unavailableReason,
    }))
  );
});

import { Router } from "express";
import { z } from "zod";
import { pool, withTransaction } from "../lib/db.js";
import { requireStaffType } from "../lib/staff.js";
import { HttpError } from "../middleware/errorHandler.js";

export const appointmentsRouter = Router();

const id = z.coerce.number().int().positive();

// "en-CA" formats as YYYY-MM-DD in the server's local time zone.
const today = () => new Date().toLocaleDateString("en-CA");

// Shared by the list and by the booking/check-in responses, so every
// endpoint here returns appointments in the same shape.
//
// - scheduledAt is "YYYY-MM-DDTHH:MM:SS" with no time zone, so the
//   browser reads it as clinic-local time.
// - visitState is the waiting-room state, derived from the check-in
//   columns plus appointment_summary (a nurse's triage note means the
//   patient is with the nurse). See database/migrations/001_appointment_check_in.sql.
// - The last three columns are readiness flags for the front desk and
//   nurses: required forms not completed, insurance status, and whether
//   the patient has a severe allergy.
const APPOINTMENT_SELECT = `
  SELECT
    a.appointment_id AS "appointmentId",
    a.patient_id AS "patientId",
    p.first_name || ' ' || p.last_name AS "patientName",
    a.doctor_id AS "doctorId",
    'Dr. ' || e.last_name AS "doctorName",
    a.office_id AS "officeId",
    to_char(a.appointment_date + ts.start_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS "scheduledAt",
    s.name AS specialty,
    a.status,
    a.checked_in_at AS "checkedInAt",
    a.checked_out_at AS "checkedOutAt",
    CASE
      WHEN a.status IN ('Cancelled', 'No Show') THEN a.status
      WHEN a.status = 'Completed' OR a.checked_out_at IS NOT NULL THEN 'Done'
      WHEN a.checked_in_at IS NULL THEN 'Expected'
      WHEN EXISTS (SELECT 1 FROM appointment_summary sm WHERE sm.appointment_id = a.appointment_id) THEN 'With nurse'
      ELSE 'Waiting'
    END AS "visitState",
    (
      SELECT count(*)::int
      FROM form_type ft
      WHERE ft.is_required AND ft.is_active
        AND NOT EXISTS (
          SELECT 1 FROM form_submission fs
          WHERE fs.patient_id = a.patient_id AND fs.form_type_id = ft.form_type_id AND fs.status = 'Completed'
        )
    ) AS "missingForms",
    ins.status AS "insuranceStatus",
    EXISTS (
      SELECT 1 FROM allergy al
      WHERE al.patient_id = a.patient_id AND al.is_active AND al.severity = 'Severe'
    ) AS "hasSevereAllergy"
  FROM appointment a
  JOIN patient p ON p.patient_id = a.patient_id
  JOIN employee e ON e.employee_id = a.doctor_id
  JOIN time_slot ts ON ts.time_slot_id = a.time_slot_id
  JOIN specialty s ON s.specialty_id = a.specialty_id
  LEFT JOIN insurance ins ON ins.patient_id = a.patient_id
`;

async function getAppointment(appointmentId: number) {
  const result = await pool.query(`${APPOINTMENT_SELECT} WHERE a.appointment_id = $1`, [appointmentId]);
  return result.rows[0];
}

const appointmentsQuerySchema = z.object({
  date: z.iso.date(),
  officeId: id.optional(),
});

// Appointments on one day, optionally at one office, e.g.
// GET /api/appointments?date=2026-10-20&officeId=1
// Used by the front desk and the nurse's queue.
appointmentsRouter.get("/api/appointments", async (req, res) => {
  const { date, officeId } = appointmentsQuerySchema.parse(req.query);

  const result = await pool.query(
    `
    ${APPOINTMENT_SELECT}
    WHERE a.appointment_date = $1
      AND ($2::int IS NULL OR a.office_id = $2)
    ORDER BY ts.start_time, p.last_name
    `,
    [date, officeId ?? null]
  );

  res.json(result.rows);
});

appointmentsRouter.get("/api/specialties", async (_req, res) => {
  const result = await pool.query(`
    SELECT specialty_id AS "specialtyId", name, requires_referral AS "requiresReferral"
    FROM specialty
    WHERE is_active
    ORDER BY name
  `);

  res.json(result.rows);
});

// Active doctors, optionally only those offering one specialty. string_agg
// collapses a doctor's specialties (one row each in doctor_specialty) into
// one "Cardiology, Internal Medicine" string, primary specialty first.
appointmentsRouter.get("/api/doctors", async (req, res) => {
  const specialtyId = id.optional().parse(req.query.specialtyId);

  const result = await pool.query(
    `
    SELECT
      d.employee_id AS "doctorId",
      'Dr. ' || e.first_name || ' ' || e.last_name AS name,
      string_agg(s.name, ', ' ORDER BY ds.is_primary DESC, s.name) AS specialties
    FROM doctor d
    JOIN employee e ON e.employee_id = d.employee_id
    LEFT JOIN doctor_specialty ds ON ds.doctor_id = d.employee_id AND ds.is_active
    LEFT JOIN specialty s ON s.specialty_id = ds.specialty_id
    WHERE e.is_active
      AND ($1::int IS NULL OR EXISTS (
        SELECT 1 FROM doctor_specialty x
        WHERE x.doctor_id = d.employee_id AND x.specialty_id = $1 AND x.is_active
      ))
    GROUP BY d.employee_id, e.first_name, e.last_name
    ORDER BY e.last_name
    `,
    [specialtyId ?? null]
  );

  res.json(result.rows);
});

// The time slots doctors work on a given day at a given office, as a
// given specialty. doctor_schedule has one row per doctor per weekday; its
// shift (e.g. "Morning") owns a set of time_slots. 'FMDay' turns the date
// into its weekday name ("Monday") to match day_of_week.
//   $1 = date, $2 = office, $3 = specialty
const SCHEDULED_SLOTS = `
  FROM doctor_schedule ds
  JOIN time_slot ts ON ts.shift_type_id = ds.shift_type_id AND ts.is_active
  JOIN specialty s ON s.specialty_id = ds.specialty_id
  JOIN employee e ON e.employee_id = ds.doctor_id AND e.is_active
  WHERE ds.is_active
    AND ds.day_of_week = to_char($1::date, 'FMDay')
    AND ds.office_id = $2
    AND ds.specialty_id = $3
`;

const availabilityQuerySchema = z.object({
  date: z.iso.date(),
  officeId: id,
  specialtyId: id,
  doctorId: id.optional(),
});

// Open slots for a specialty at one office on one day, across every
// doctor working it (or just one doctor, if doctorId is given). A slot is
// taken if it has any appointment that isn't Cancelled.
appointmentsRouter.get("/api/availability", async (req, res) => {
  const q = availabilityQuerySchema.parse(req.query);

  const result = await pool.query(
    `
    SELECT
      ds.doctor_id AS "doctorId",
      'Dr. ' || e.first_name || ' ' || e.last_name AS "doctorName",
      ts.time_slot_id AS "timeSlotId",
      to_char(ts.start_time, 'HH24:MI') AS "startTime",
      to_char(ts.end_time, 'HH24:MI') AS "endTime",
      s.name AS specialty,
      s.requires_referral AS "requiresReferral"
    ${SCHEDULED_SLOTS}
      AND ($4::int IS NULL OR ds.doctor_id = $4)
      AND NOT EXISTS (
        SELECT 1 FROM appointment a
        WHERE a.doctor_id = ds.doctor_id
          AND a.appointment_date = $1
          AND a.time_slot_id = ts.time_slot_id
          AND a.status <> 'Cancelled'
      )
    ORDER BY ts.start_time, e.last_name
    `,
    [q.date, q.officeId, q.specialtyId, q.doctorId ?? null]
  );

  res.json(result.rows);
});

const referralsQuerySchema = z.object({
  doctorId: id,
  specialtyId: id,
  date: z.iso.date(),
});

// A patient's referrals that would allow booking this doctor and
// specialty on this date: approved, not expired by the visit date, and
// written for this specialist. Feeds the booking form's referral picker.
appointmentsRouter.get("/api/patients/:patientId/referrals", async (req, res) => {
  const patientId = id.parse(req.params.patientId);
  const q = referralsQuerySchema.parse(req.query);

  const result = await pool.query(
    `
    SELECT
      r.referral_id AS "referralId",
      'Dr. ' || e.last_name AS "referredBy",
      r.date_issued AS "dateIssued",
      r.expiration_date AS "expirationDate"
    FROM referral r
    JOIN employee e ON e.employee_id = r.referring_doctor_id
    WHERE r.patient_id = $1
      AND r.specialist_doctor_id = $2
      AND r.specialty_id = $3
      AND r.status = 'Approved'
      AND r.expiration_date >= $4
    ORDER BY r.expiration_date DESC
    `,
    [patientId, q.doctorId, q.specialtyId, q.date]
  );

  res.json(result.rows);
});

const bookAppointmentSchema = z.object({
  patientId: z.number().int().positive(),
  doctorId: z.number().int().positive(),
  specialtyId: z.number().int().positive(),
  date: z.iso.date(),
  timeSlotId: z.number().int().positive(),
  referralId: z.number().int().positive().nullable().default(null),
});

// Book an appointment by phone at the receptionist's office.
//
// All in one transaction:
//   1. Lock the doctor's schedule row for that weekday (SELECT ... FOR
//      UPDATE). Two receptionists booking the same doctor and day now
//      take turns, so both can't see a slot as free and both book it.
//      This replaces a UNIQUE index, which the schema doesn't have.
//   2. Check the referral, if the specialty needs one.
//   3. Check the slot is still free, then INSERT.
appointmentsRouter.post("/api/appointments", async (req, res) => {
  const body = bookAppointmentSchema.parse(req.body);
  const { employeeId, officeId } = await requireStaffType(req, "receptionist", "book appointments");

  if (body.date < today()) {
    throw new HttpError(400, "Can't book an appointment in the past");
  }

  const appointmentId = await withTransaction(async (client) => {
    const slot = await client.query(
      `
      SELECT s.requires_referral AS "requiresReferral"
      ${SCHEDULED_SLOTS}
        AND ds.doctor_id = $4
        AND ts.time_slot_id = $5
      FOR UPDATE OF ds
      `,
      [body.date, officeId, body.specialtyId, body.doctorId, body.timeSlotId]
    );
    if (!slot.rowCount) {
      throw new HttpError(400, "The doctor isn't scheduled for that specialty and time slot at your office that day");
    }

    if (slot.rows[0].requiresReferral) {
      if (!body.referralId) {
        throw new HttpError(400, "This specialty requires a referral");
      }
      const referral = await client.query(
        `
        SELECT 1
        FROM referral
        WHERE referral_id = $1
          AND patient_id = $2
          AND specialist_doctor_id = $3
          AND specialty_id = $4
          AND status = 'Approved'
          AND expiration_date >= $5
        `,
        [body.referralId, body.patientId, body.doctorId, body.specialtyId, body.date]
      );
      if (!referral.rowCount) {
        throw new HttpError(400, "Referral not found, not approved, or expired for this patient and doctor");
      }
    }

    const taken = await client.query(
      `
      SELECT 1 FROM appointment
      WHERE doctor_id = $1 AND appointment_date = $2 AND time_slot_id = $3 AND status <> 'Cancelled'
      `,
      [body.doctorId, body.date, body.timeSlotId]
    );
    if (taken.rowCount) {
      throw new HttpError(409, "That time slot was just booked. Pick another one.");
    }

    const result = await client.query(
      `
      INSERT INTO appointment (
        patient_id, doctor_id, office_id, referral_id, appointment_date,
        time_slot_id, specialty_id, booking_channel, booked_by_employee_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'Phone', $8)
      RETURNING appointment_id
      `,
      [
        body.patientId,
        body.doctorId,
        officeId,
        body.referralId,
        body.date,
        body.timeSlotId,
        body.specialtyId,
        employeeId,
      ]
    );
    return result.rows[0].appointment_id as number;
  });

  res.status(201).json(await getAppointment(appointmentId));
});

// ---------------------------------------------------------------------------
// Check-in, check-out and no-show (receptionists, own office only)
//
// Each is an UPDATE whose WHERE clause only matches an appointment in the
// right state, so e.g. checking out someone who never checked in changes
// 0 rows instead of corrupting the record. 0 rows -> explain why.
// ---------------------------------------------------------------------------


async function explainNoUpdate(appointmentId: number, officeId: number, action: string): Promise<never> {
  const result = await pool.query(`SELECT office_id FROM appointment WHERE appointment_id = $1`, [appointmentId]);
  if (!result.rowCount) throw new HttpError(404, "Appointment not found");
  if (result.rows[0].office_id !== officeId) throw new HttpError(403, "That appointment is at another office");
  throw new HttpError(409, `Can't ${action}: the appointment isn't in the right state for that`);
}

// Only on the day of the appointment.
appointmentsRouter.patch("/api/appointments/:appointmentId/check-in", async (req, res) => {
  const appointmentId = id.parse(req.params.appointmentId);
  const { officeId } = await requireStaffType(req, "receptionist", "check patients in");

  const result = await pool.query(
    `
    UPDATE appointment
    SET checked_in_at = now()
    WHERE appointment_id = $1 AND office_id = $2
      AND status = 'Scheduled' AND checked_in_at IS NULL AND appointment_date = $3
    `,
    [appointmentId, officeId, today()]
  );
  if (!result.rowCount) await explainNoUpdate(appointmentId, officeId, "check in");

  res.json(await getAppointment(appointmentId));
});

// Check-out also marks the visit Completed, which makes it billable.
appointmentsRouter.patch("/api/appointments/:appointmentId/check-out", async (req, res) => {
  const appointmentId = id.parse(req.params.appointmentId);
  const { officeId } = await requireStaffType(req, "receptionist", "check patients out");

  const result = await pool.query(
    `
    UPDATE appointment
    SET checked_out_at = now(), status = 'Completed'
    WHERE appointment_id = $1 AND office_id = $2
      AND checked_in_at IS NOT NULL AND checked_out_at IS NULL
    `,
    [appointmentId, officeId]
  );
  if (!result.rowCount) await explainNoUpdate(appointmentId, officeId, "check out");

  res.json(await getAppointment(appointmentId));
});

// The patient never arrived: only for a scheduled visit that wasn't
// checked in, on or after its date.
appointmentsRouter.patch("/api/appointments/:appointmentId/no-show", async (req, res) => {
  const appointmentId = id.parse(req.params.appointmentId);
  const { officeId } = await requireStaffType(req, "receptionist", "mark no-shows");

  const result = await pool.query(
    `
    UPDATE appointment
    SET status = 'No Show'
    WHERE appointment_id = $1 AND office_id = $2
      AND status = 'Scheduled' AND checked_in_at IS NULL AND appointment_date <= $3
    `,
    [appointmentId, officeId, today()]
  );
  if (!result.rowCount) await explainNoUpdate(appointmentId, officeId, "mark as a no-show");

  res.json(await getAppointment(appointmentId));
});

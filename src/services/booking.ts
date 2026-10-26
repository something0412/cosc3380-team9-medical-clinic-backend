import type { Pool, PoolClient } from "pg";
import { CLINIC_NOW, CLINIC_TIME_ZONE, CLINIC_TODAY } from "../lib/clinicTime.js";
import { pool } from "../lib/db.js";
import { withTransaction } from "../lib/transaction.js";
import { HttpError } from "../middleware/errorHandler.js";

export interface SlotSearch {
  date: string;
  days?: number;
  doctorId?: number;
  specialtyId?: number;
  officeId?: number;
  timeSlotId?: number;
  patientId?: number;
  referralId?: number;
}

export interface Slot {
  date: string;
  doctorId: number;
  doctorName: string;
  officeId: number;
  officeName: string;
  specialtyId: number;
  specialty: string;
  requiresReferral: boolean;
  referralId: number | null;
  timeSlotId: number;
  startTime: string;
  endTime: string;
  available?: boolean;
  unavailableReason?: string | null;
}

interface CheckedSlot extends Slot {
  started: boolean;
  doctorBusy: boolean;
  patientBusy: boolean;
}

export interface Booking {
  patientId: number;
  doctorId: number;
  specialtyId: number;
  date: string;
  timeSlotId: number;
  referralId: number | null;
  receptionist: { employeeId: number; officeId: number } | null;
}

// scheduled slots for the search, flagged with anything that blocks booking
// overlaps compare clock times because slots in different shifts can share a time
async function checkSlots(db: Pool | PoolClient, search: SlotSearch): Promise<CheckedSlot[]> {
  const result = await db.query(
    `
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS "date",
      ds.doctor_id AS "doctorId",
      e.first_name || ' ' || e.last_name AS "doctorName",
      o.office_id AS "officeId",
      o.name AS "officeName",
      sp.specialty_id AS "specialtyId",
      sp.name AS "specialty",
      sp.requires_referral AS "requiresReferral",
      ts.time_slot_id AS "timeSlotId",
      to_char(ts.start_time, 'HH24:MI') AS "startTime",
      to_char(ts.end_time, 'HH24:MI') AS "endTime",
      d.day + ts.start_time <= ${CLINIC_NOW} AS "started",
      EXISTS (
        SELECT 1
        FROM appointment a
        JOIN time_slot t ON t.time_slot_id = a.time_slot_id
        WHERE a.doctor_id = ds.doctor_id
          AND a.appointment_date = d.day
          AND a.status <> 'Cancelled'
          AND t.start_time < ts.end_time
          AND t.end_time > ts.start_time
      ) AS "doctorBusy",
      EXISTS (
        SELECT 1
        FROM appointment a
        JOIN time_slot t ON t.time_slot_id = a.time_slot_id
        WHERE a.patient_id = $6::int
          AND a.appointment_date = d.day
          AND a.status <> 'Cancelled'
          AND t.start_time < ts.end_time
          AND t.end_time > ts.start_time
      ) AS "patientBusy",
      (
        SELECT r.referral_id
        FROM referral r
        WHERE r.patient_id = $6::int
          AND r.specialist_doctor_id = ds.doctor_id
          AND r.specialty_id = ds.specialty_id
          AND r.status = 'Approved'
          AND r.date_issued <= d.day
          AND r.expiration_date >= d.day
          AND ($8::int IS NULL OR r.referral_id = $8)
        ORDER BY r.expiration_date DESC, r.referral_id
        LIMIT 1
      ) AS "referralId"
    FROM (SELECT generate_series($1::date, $1::date + $2::int - 1, interval '1 day')::date AS day) d
    JOIN doctor_schedule ds ON ds.day_of_week = to_char(d.day, 'FMDay') AND ds.is_active
    JOIN employee e ON e.employee_id = ds.doctor_id AND e.is_active
    JOIN doctor_specialty dsp ON dsp.doctor_id = ds.doctor_id AND dsp.specialty_id = ds.specialty_id AND dsp.is_active
    JOIN specialty sp ON sp.specialty_id = ds.specialty_id AND sp.is_active
    JOIN office o ON o.office_id = ds.office_id AND o.is_active
    JOIN shift_type st ON st.shift_type_id = ds.shift_type_id AND st.is_active
    JOIN time_slot ts ON ts.shift_type_id = st.shift_type_id
      AND ts.is_active
      AND ts.start_time >= st.start_time
      AND ts.end_time <= st.end_time
    WHERE ($3::int IS NULL OR ds.doctor_id = $3)
      AND ($4::int IS NULL OR ds.specialty_id = $4)
      AND ($5::int IS NULL OR ds.office_id = $5)
      AND ($7::int IS NULL OR ts.time_slot_id = $7)
    ORDER BY d.day, ts.start_time, e.last_name, e.first_name, ds.doctor_id
    `,
    [
      search.date,
      search.days ?? 1,
      search.doctorId ?? null,
      search.specialtyId ?? null,
      search.officeId ?? null,
      search.patientId ?? null,
      search.timeSlotId ?? null,
      search.referralId ?? null,
    ]
  );
  return result.rows;
}

// times that haven't started and don't overlap another appointment
// open times only, or every time with available false and the reason when includeTaken is on
// (the booking pages gray out taken times instead of hiding them)
export async function findAvailability(search: SlotSearch, includeTaken = false): Promise<Slot[]> {
  const slots = await checkSlots(pool, search);
  return slots
    .filter((slot) => includeTaken || (!slot.started && !slot.doctorBusy && !slot.patientBusy))
    .map(({ started, doctorBusy, patientBusy, ...slot }) => ({
      ...slot,
      referralId: slot.requiresReferral ? slot.referralId : null,
      available: !started && !doctorBusy && !patientBusy,
      unavailableReason: patientBusy ? "Patient booked" : doctorBusy ? "Booked" : started ? "Past" : null,
    }));
}

const APPOINTMENT_COLUMNS = `
  a.appointment_id AS "appointmentId",
  a.patient_id AS "patientId",
  p.first_name || ' ' || p.last_name AS "patientName",
  a.doctor_id AS "doctorId",
  e.first_name || ' ' || e.last_name AS "doctorName",
  a.office_id AS "officeId",
  o.name AS "officeName",
  a.specialty_id AS "specialtyId",
  sp.name AS "specialty",
  to_char(a.appointment_date, 'YYYY-MM-DD') AS "date",
  a.time_slot_id AS "timeSlotId",
  to_char(ts.start_time, 'HH24:MI') AS "startTime",
  to_char(ts.end_time, 'HH24:MI') AS "endTime",
  a.status,
  a.booking_channel AS "bookingChannel",
  a.booked_by_employee_id AS "bookedByEmployeeId",
  a.referral_id AS "referralId",
  a.checked_in_at IS NOT NULL AS "checkedIn"
`;

// staff views also show when the patient arrived and left, in clinic time
const VISIT_COLUMNS = `
  ${APPOINTMENT_COLUMNS},
  to_char(a.checked_in_at AT TIME ZONE '${CLINIC_TIME_ZONE}', 'YYYY-MM-DD HH24:MI') AS "checkedInAt",
  to_char(a.checked_out_at AT TIME ZONE '${CLINIC_TIME_ZONE}', 'YYYY-MM-DD HH24:MI') AS "checkedOutAt"
`;

const APPOINTMENT_JOINS = `
  JOIN patient p ON p.patient_id = a.patient_id
  JOIN employee e ON e.employee_id = a.doctor_id
  JOIN office o ON o.office_id = a.office_id
  JOIN specialty sp ON sp.specialty_id = a.specialty_id
  JOIN time_slot ts ON ts.time_slot_id = a.time_slot_id
`;

export async function getAppointment(db: Pool | PoolClient, appointmentId: number) {
  const result = await db.query(`-- TODO X01: one appointment with its patient`, [
    appointmentId,
  ]);
  return result.rows[0] ?? null;
}

async function getVisit(appointmentId: number) {
  const result = await pool.query(`SELECT ${VISIT_COLUMNS} FROM appointment a ${APPOINTMENT_JOINS} WHERE a.appointment_id = $1`, [
    appointmentId,
  ]);
  return result.rows[0];
}

export interface AppointmentListFilter {
  // one clinic date, or a range relative to today when it's left out
  date?: string;
  when?: "today" | "upcoming" | "past" | "all";
  search?: string;
  includeCancelled?: boolean;
}

// every appointment list goes through here, scoped to one office, one doctor or one patient so there's no list of every appointment
export async function listAppointments(scope: { officeId: number } | { doctorId: number } | { patientId: number }, filter: AppointmentListFilter = {}) {
  const when = filter.date ? null : (filter.when ?? "today");
  const result = await pool.query(
    `
    SELECT ${VISIT_COLUMNS}
    FROM appointment a
    ${APPOINTMENT_JOINS}
    WHERE ($1::int IS NULL OR a.office_id = $1)
      AND ($2::int IS NULL OR a.doctor_id = $2)
      AND ($3::date IS NULL OR a.appointment_date = $3)
      AND ($4::text IS NULL
        OR ($4 = 'today' AND a.appointment_date = ${CLINIC_TODAY})
        OR ($4 = 'upcoming' AND a.appointment_date > ${CLINIC_TODAY})
        OR ($4 = 'past' AND a.appointment_date < ${CLINIC_TODAY})
        OR $4 = 'all')
      AND ($5 = '' OR p.first_name || ' ' || p.last_name ILIKE '%' || $5 || '%' ESCAPE '\\')
      AND ($6 OR a.status <> 'Cancelled')
      AND ($7::int IS NULL OR a.patient_id = $7)
    ORDER BY CASE WHEN $4 IN ('past', 'all') THEN a.appointment_date END DESC, a.appointment_date, ts.start_time, a.appointment_id
    `,
    [
      "officeId" in scope ? scope.officeId : null,
      "doctorId" in scope ? scope.doctorId : null,
      filter.date ?? null,
      when,
      // a typed % or _ is part of the name, not a wildcard
      (filter.search ?? "").replace(/[\\%_]/g, (character) => `\\${character}`),
      filter.includeCancelled ?? true,
      "patientId" in scope ? scope.patientId : null,
    ]
  );
  return result.rows;
}

type VisitChange = "check in" | "check out" | "mark No Show";

// one conditional update per change, so when two requests race only the first one still matches
const VISIT_CHANGES: Record<VisitChange, { set: string; allowed: string; done: string }> = {
  // patients can arrive early, so any time on the clinic date counts
  "check in": {
    done: "be checked in",
    set: "checked_in_at = now()",
    allowed: `a.status = 'Scheduled' AND a.checked_in_at IS NULL AND a.checked_out_at IS NULL AND a.appointment_date = ${CLINIC_TODAY}`,
  },
  // checking out is what completes the visit
  "check out": {
    done: "be checked out",
    set: "checked_out_at = now(), status = 'Completed'",
    allowed: "a.status = 'Scheduled' AND a.checked_in_at IS NOT NULL AND a.checked_out_at IS NULL",
  },
  // only once the whole appointment time is over, so nobody is marked absent while their slot is still running
  "mark No Show": {
    done: "be marked No Show",
    set: "status = 'No Show'",
    allowed: `a.status = 'Scheduled' AND a.checked_in_at IS NULL AND a.appointment_date + ts.end_time <= ${CLINIC_NOW}`,
  },
};

// says why a change didn't match, from the appointment as it is now
async function refuseVisitChange(appointmentId: number, officeId: number, change: VisitChange): Promise<never> {
  const result = await pool.query(
    `
    SELECT
      a.office_id AS "officeId",
      a.status,
      a.checked_in_at IS NOT NULL AS "checkedIn",
      a.appointment_date > ${CLINIC_TODAY} AS "future",
      a.appointment_date < ${CLINIC_TODAY} AS "past",
      a.appointment_date + ts.end_time > ${CLINIC_NOW} AS "notOver"
    FROM appointment a
    JOIN time_slot ts ON ts.time_slot_id = a.time_slot_id
    WHERE a.appointment_id = $1
    `,
    [appointmentId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "Appointment not found");
  if (row.officeId !== officeId) throw new HttpError(403, "That appointment is at another office");
  if (row.status !== "Scheduled") throw new HttpError(409, `Only scheduled appointments can ${VISIT_CHANGES[change].done}. This one is ${row.status}.`);

  if (change === "check in" && row.checkedIn) throw new HttpError(409, "The patient is already checked in");
  if (change === "check in" && (row.future || row.past)) throw new HttpError(409, "Patients can only be checked in on the day of their appointment");
  if (change === "check out" && !row.checkedIn) throw new HttpError(409, "The patient hasn't been checked in");
  if (change === "mark No Show" && row.checkedIn) throw new HttpError(409, "A patient who checked in can't be marked No Show");
  if (change === "mark No Show" && row.notOver) throw new HttpError(409, "An appointment can only be marked No Show after its time is over");
  throw new HttpError(409, "This appointment just changed. Reload it and try again.");
}

async function changeVisit(appointmentId: number, officeId: number, employeeId: number, change: VisitChange) {
  const { set, allowed } = VISIT_CHANGES[change];
  const changed = await withTransaction(async (client) => {
    // the appointment history trigger records who made the change
    await client.query(`SELECT set_config('app.employee_id', $1, true)`, [String(employeeId)]);
    const result = await client.query(
      `
      UPDATE appointment a
      SET ${set}
      FROM time_slot ts
      WHERE a.appointment_id = $1
        AND a.office_id = $2
        AND ts.time_slot_id = a.time_slot_id
        AND ${allowed}
      `,
      [appointmentId, officeId]
    );
    return result.rowCount;
  });
  if (!changed) await refuseVisitChange(appointmentId, officeId, change);
  return getVisit(appointmentId);
}

// receptionists do these at their own office only
export const checkInAppointment = (appointmentId: number, officeId: number, employeeId: number) => changeVisit(appointmentId, officeId, employeeId, "check in");
export const checkOutAppointment = (appointmentId: number, officeId: number, employeeId: number) => changeVisit(appointmentId, officeId, employeeId, "check out");
export const markNoShow = (appointmentId: number, officeId: number, employeeId: number) => changeVisit(appointmentId, officeId, employeeId, "mark No Show");

export async function bookAppointment(booking: Booking) {
  try {
    return await withTransaction(async (client) => {
      // same lock order every time so two bookings can't deadlock
      const patient = await client.query(`SELECT is_active AS "isActive" FROM patient WHERE patient_id = $1 FOR NO KEY UPDATE`, [
        booking.patientId,
      ]);
      if (!patient.rowCount) throw new HttpError(404, "Patient not found");
      if (!patient.rows[0].isActive) throw new HttpError(409, "This patient account is inactive");

      await client.query(`SELECT 1 FROM employee WHERE employee_id = $1 FOR SHARE`, [booking.doctorId]);
      const schedule = await client.query(
        `SELECT shift_type_id AS "shiftTypeId" FROM doctor_schedule WHERE doctor_id = $1 AND day_of_week = to_char($2::date, 'FMDay') FOR UPDATE`,
        [booking.doctorId, booking.date]
      );
      if (schedule.rowCount) {
        await client.query(`SELECT 1 FROM shift_type WHERE shift_type_id = $1 FOR SHARE`, [schedule.rows[0].shiftTypeId]);
      }
      await client.query(`SELECT 1 FROM referral WHERE patient_id = $1 AND specialist_doctor_id = $2 AND specialty_id = $3 FOR SHARE`, [
        booking.patientId,
        booking.doctorId,
        booking.specialtyId,
      ]);

      // checked after the locks so it sees bookings that committed while this one waited
      const [slot] = await checkSlots(client, {
        date: booking.date,
        doctorId: booking.doctorId,
        specialtyId: booking.specialtyId,
        timeSlotId: booking.timeSlotId,
        patientId: booking.patientId,
        referralId: booking.referralId ?? undefined,
      });
      if (!slot) throw new HttpError(409, "The doctor isn't scheduled for that specialty and time");
      if (booking.receptionist && slot.officeId !== booking.receptionist.officeId) {
        throw new HttpError(403, "Receptionists can only book appointments at their own office");
      }
      if (slot.started) throw new HttpError(409, "Appointments must be booked for a future time");
      if (slot.doctorBusy) throw new HttpError(409, "That time is no longer available");
      if (slot.patientBusy) throw new HttpError(409, "The patient already has an appointment at that time");
      if (booking.referralId && slot.referralId !== booking.referralId) {
        throw new HttpError(409, "That referral isn't valid for this appointment");
      }
      if (slot.requiresReferral && !slot.referralId) {
        throw new HttpError(409, "This specialty needs an approved referral to this doctor");
      }

      const inserted = await client.query(
        `
        INSERT INTO appointment (
          patient_id, doctor_id, office_id, referral_id, appointment_date,
          time_slot_id, specialty_id, status, booking_channel, booked_by_employee_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'Scheduled', $8, $9)
        RETURNING appointment_id AS "appointmentId"
        `,
        [
          booking.patientId,
          slot.doctorId,
          slot.officeId,
          slot.requiresReferral || booking.referralId ? slot.referralId : null,
          slot.date,
          slot.timeSlotId,
          slot.specialtyId,
          booking.receptionist ? "Phone" : "Web",
          booking.receptionist?.employeeId ?? null,
        ]
      );
      return getAppointment(client, inserted.rows[0].appointmentId);
    });
  } catch (err) {
    // the conflict trigger catches anything that slips past the checks above
    if ((err as { code?: string }).code === "23P01") throw new HttpError(409, "That time was just taken. Choose another time.");
    throw err;
  }
}

// patients cancel their own appointments, receptionists cancel at their own office
export async function cancelAppointment(appointmentId: number, scope: { patientId?: number; officeId?: number }) {
  // one conditional update so a check in can't land between the check and the write
  const result = await pool.query(
    `
    UPDATE appointment a
    SET status = 'Cancelled'
    FROM time_slot ts
    WHERE a.appointment_id = $1
      AND ts.time_slot_id = a.time_slot_id
      AND ($2::int IS NULL OR a.patient_id = $2)
      AND ($3::int IS NULL OR a.office_id = $3)
      AND a.status = 'Scheduled'
      AND a.checked_in_at IS NULL
      AND a.appointment_date + ts.start_time > ${CLINIC_NOW}
    `,
    [appointmentId, scope.patientId ?? null, scope.officeId ?? null]
  );

  if (!result.rowCount) {
    const current = await pool.query(
      `SELECT patient_id AS "patientId", office_id AS "officeId", status, checked_in_at IS NOT NULL AS "checkedIn" FROM appointment WHERE appointment_id = $1`,
      [appointmentId]
    );
    const row = current.rows[0];
    if (!row || (scope.patientId && row.patientId !== scope.patientId)) throw new HttpError(404, "Appointment not found");
    if (scope.officeId && row.officeId !== scope.officeId) throw new HttpError(403, "That appointment is at another office");
    if (row.status !== "Scheduled") throw new HttpError(409, `Only scheduled appointments can be cancelled. This one is ${row.status}.`);
    if (row.checkedIn) throw new HttpError(409, "The patient has already checked in");
    throw new HttpError(409, "Appointments that have already started can't be cancelled");
  }

  return getAppointment(pool, appointmentId);
}
import type { Pool, PoolClient } from "pg";
import { CLINIC_TODAY } from "../lib/clinicTime.js";
import { pool } from "../lib/db.js";
import { withTransaction } from "../lib/transaction.js";
import { HttpError } from "../middleware/errorHandler.js";

// a referral is good for 90 days unless the doctor picks another expiration date
const DEFAULT_DAYS = 90;

// booking still decides whether a referral fits a particular appointment
const REFERRAL_COLUMNS = `
  r.referral_id AS "referralId",
  r.patient_id AS "patientId",
  p.first_name || ' ' || p.last_name AS "patientName",
  r.referring_doctor_id AS "referringDoctorId",
  rd.first_name || ' ' || rd.last_name AS "referringDoctorName",
  r.specialist_doctor_id AS "specialistDoctorId",
  sd.first_name || ' ' || sd.last_name AS "specialistName",
  r.specialty_id AS "specialtyId",
  sp.name AS "specialty",
  to_char(r.date_issued, 'YYYY-MM-DD') AS "dateIssued",
  to_char(r.expiration_date, 'YYYY-MM-DD') AS "expirationDate",
  r.status,
  r.expiration_date < ${CLINIC_TODAY} AS "expired",
  r.primary_doctor_id AS "primaryDoctorId",
  pdoc.first_name || ' ' || pdoc.last_name AS "primaryDoctorName",
  r.request_reason AS "requestReason",
  r.denial_reason AS "denialReason"
`;

// patients see who referred them and where, without internal IDs they don't need
const PATIENT_COLUMNS = `
  r.referral_id AS "referralId",
  rd.first_name || ' ' || rd.last_name AS "referringDoctorName",
  r.specialist_doctor_id AS "specialistDoctorId",
  sd.first_name || ' ' || sd.last_name AS "specialistName",
  r.specialty_id AS "specialtyId",
  sp.name AS "specialty",
  to_char(r.date_issued, 'YYYY-MM-DD') AS "dateIssued",
  to_char(r.expiration_date, 'YYYY-MM-DD') AS "expirationDate",
  r.status,
  r.expiration_date < ${CLINIC_TODAY} AS "expired"
`;

const REFERRAL_JOINS = `
  JOIN patient p ON p.patient_id = r.patient_id
  JOIN employee rd ON rd.employee_id = r.referring_doctor_id
  JOIN employee sd ON sd.employee_id = r.specialist_doctor_id
  JOIN specialty sp ON sp.specialty_id = r.specialty_id
  LEFT JOIN employee pdoc ON pdoc.employee_id = r.primary_doctor_id
`;

const NEWEST_FIRST = `ORDER BY r.date_issued DESC, r.referral_id DESC`;

export interface NewReferral {
  patientId: number;
  specialistDoctorId: number;
  specialtyId: number;
  expirationDate?: string;
  reason: string;
}

async function getReferral(db: Pool | PoolClient, referralId: number) {
  const result = await db.query(`SELECT ${REFERRAL_COLUMNS} FROM referral r ${REFERRAL_JOINS} WHERE r.referral_id = $1`, [referralId]);
  return result.rows[0];
}

// a doctor sees referrals they sent, ones waiting for them as primary doctor, and approved ones sent to them as specialist
export async function listDoctorReferrals(doctorId: number) {
  const list = async (where: string) =>
    (await pool.query(`SELECT ${REFERRAL_COLUMNS} FROM referral r ${REFERRAL_JOINS} WHERE ${where} ${NEWEST_FIRST}`, [doctorId])).rows;
  return {
    toApprove: await list("r.primary_doctor_id = $1 AND r.referring_doctor_id <> $1"),
    sent: await list("r.referring_doctor_id = $1"),
    received: await list("r.specialist_doctor_id = $1 AND r.status = 'Approved'"),
  };
}

export async function listPatientReferrals(patientId: number) {
  const result = await pool.query(`SELECT ${PATIENT_COLUMNS} FROM referral r ${REFERRAL_JOINS} WHERE r.patient_id = $1 ${NEWEST_FIRST}`, [patientId]);
  return result.rows;
}

// active doctors and the active specialties they practice that need a referral, for the referral form
export async function listSpecialists(doctorId: number) {
  const result = await pool.query(
    `
    SELECT
      e.employee_id AS "doctorId",
      e.first_name || ' ' || e.last_name AS "doctorName",
      json_agg(json_build_object('specialtyId', sp.specialty_id, 'name', sp.name, 'requiresReferral', sp.requires_referral) ORDER BY sp.name) AS specialties
    FROM doctor d
    JOIN employee e ON e.employee_id = d.employee_id AND e.is_active
    JOIN doctor_specialty ds ON ds.doctor_id = d.employee_id AND ds.is_active
    JOIN specialty sp ON sp.specialty_id = ds.specialty_id AND sp.is_active AND sp.requires_referral
    WHERE d.employee_id <> $1
    GROUP BY e.employee_id
    ORDER BY e.last_name, e.first_name
    `,
    [doctorId]
  );
  return result.rows;
}

// the doctor has to be the patient's assigned doctor or have actually seen them
const CARES_FOR_PATIENT = `
  EXISTS (SELECT 1 FROM patient_doctor pd WHERE pd.patient_id = $1 AND pd.doctor_id = $2 AND pd.is_active)
  OR EXISTS (
    SELECT 1 FROM appointment a
    WHERE a.patient_id = $1 AND a.doctor_id = $2
      AND (a.status = 'Completed' OR (a.status = 'Scheduled' AND a.checked_in_at IS NOT NULL))
  )
`;

const SPECIALIST_PRACTICES = `
  EXISTS (
    SELECT 1
    FROM doctor_specialty ds
    JOIN specialty sp ON sp.specialty_id = ds.specialty_id AND sp.is_active
    JOIN employee e ON e.employee_id = ds.doctor_id AND e.is_active
    WHERE ds.doctor_id = $3 AND ds.specialty_id = $4 AND ds.is_active
  )
`;

// says why a referral couldn't be created, checking the patient before anything about the specialist
async function refuseReferral(client: PoolClient, doctorId: number, input: NewReferral): Promise<never> {
  const result = await client.query(
    `
    SELECT
      (SELECT is_active FROM employee WHERE employee_id = $2) AS "referrerActive",
      (SELECT is_active FROM patient WHERE patient_id = $1) AS "patientActive",
      ${CARES_FOR_PATIENT} AS "caresForPatient",
      ${SPECIALIST_PRACTICES} AS "specialistPractices",
      COALESCE($5::date, ${CLINIC_TODAY} + ${DEFAULT_DAYS}) > ${CLINIC_TODAY} AS "expiresLater"
    `,
    [input.patientId, doctorId, input.specialistDoctorId, input.specialtyId, input.expirationDate ?? null]
  );
  const row = result.rows[0];
  if (!row.referrerActive) throw new HttpError(403, "Your account is no longer active");
  if (row.patientActive === null) throw new HttpError(404, "Patient not found");
  if (!row.caresForPatient) throw new HttpError(403, "This patient isn't under your care");
  if (!row.patientActive) throw new HttpError(409, "This patient account is inactive");
  if (input.specialistDoctorId === doctorId) throw new HttpError(400, "You can't refer a patient to yourself");
  if (!row.specialistPractices) throw new HttpError(400, "That specialist doesn't practice this specialty");
  if (!row.expiresLater) throw new HttpError(400, "The expiration date has to be after today");
  throw new HttpError(409, "Something changed while saving the referral. Try again.");
}

// waits for any deactivation in progress so the insert sees committed status, patient first like in booking
async function lockPeople(client: PoolClient, doctorId: number, input: NewReferral) {
  await client.query(`SELECT 1 FROM patient WHERE patient_id = $1 FOR SHARE`, [input.patientId]);
  await client.query(`SELECT 1 FROM employee WHERE employee_id = ANY($1::int[]) ORDER BY employee_id FOR SHARE`, [
    [doctorId, input.specialistDoctorId],
  ]);
}

// every rule is in the insert itself, so nothing can change between checking and saving
// it goes to the patient's primary doctor, and the primary doctor's own referral is approved as it's sent
export async function createReferral(doctorId: number, input: NewReferral) {
  return withTransaction(async (client) => {
    // the referral trigger checks who is sending it
    await client.query(`SELECT set_config('app.employee_id', $1, true)`, [String(doctorId)]);
    await lockPeople(client, doctorId, input);

    const primary = await client.query(`SELECT doctor_id AS "doctorId" FROM patient_doctor WHERE patient_id = $1 AND is_primary AND is_active`, [
      input.patientId,
    ]);
    let primaryDoctorId: number | null = primary.rows[0]?.doctorId ?? null;

    // no primary doctor yet: today's primary care visit with me makes me their primary doctor
    if (primaryDoctorId === null) {
      const visit = await client.query(
        `
        SELECT 1 FROM appointment a
        JOIN specialty sp ON sp.specialty_id = a.specialty_id
        WHERE a.patient_id = $1 AND a.doctor_id = $2 AND a.appointment_date = ${CLINIC_TODAY}
          AND (a.status = 'Completed' OR (a.status = 'Scheduled' AND a.checked_in_at IS NOT NULL))
          AND sp.name IN ('Family Medicine', 'Internal Medicine')
        `,
        [input.patientId, doctorId]
      );
      if (!visit.rowCount) {
        throw new HttpError(409, "This patient doesn't have a primary doctor yet. Their first Family Medicine or Internal Medicine visit sets one.");
      }
      await client.query(
        `
        INSERT INTO patient_doctor (patient_id, doctor_id, is_primary, assigned_date, is_active)
        VALUES ($1, $2, true, ${CLINIC_TODAY}, true)
        ON CONFLICT (patient_id, doctor_id) DO UPDATE SET is_primary = true, is_active = true, assigned_date = EXCLUDED.assigned_date
        `,
        [input.patientId, doctorId]
      );
      primaryDoctorId = doctorId;
    }

    const result = await client.query(
      `
      INSERT INTO referral (patient_id, referring_doctor_id, specialist_doctor_id, specialty_id, date_issued, expiration_date, status, primary_doctor_id, request_reason)
      SELECT $1, $2, $3, $4, ${CLINIC_TODAY}, COALESCE($5::date, ${CLINIC_TODAY} + ${DEFAULT_DAYS}), $7, $6, $8
      WHERE EXISTS (SELECT 1 FROM employee WHERE employee_id = $2 AND is_active)
        AND EXISTS (SELECT 1 FROM patient WHERE patient_id = $1 AND is_active)
        AND (${CARES_FOR_PATIENT})
        AND $2 <> $3
        AND ${SPECIALIST_PRACTICES}
        AND COALESCE($5::date, ${CLINIC_TODAY} + ${DEFAULT_DAYS}) > ${CLINIC_TODAY}
      RETURNING referral_id AS "referralId"
      `,
      [
        input.patientId,
        doctorId,
        input.specialistDoctorId,
        input.specialtyId,
        input.expirationDate ?? null,
        primaryDoctorId,
        primaryDoctorId === doctorId ? "Approved" : "Pending",
        input.reason,
      ]
    );
    if (!result.rowCount) await refuseReferral(client, doctorId, input);
    return getReferral(client, result.rows[0].referralId);
  });
}

// only the patient's primary doctor answers it, once, before it expires; a denial needs a reason
export async function decideReferral(referralId: number, doctorId: number, decision: "Approved" | "Denied", reason: string | null) {
  const decided = await withTransaction(async (client) => {
    // the referral trigger checks who is deciding
    await client.query(`SELECT set_config('app.employee_id', $1, true)`, [String(doctorId)]);
    const result = await client.query(
      `
      UPDATE referral
      SET status = $1, denial_reason = $4
      WHERE referral_id = $2 AND primary_doctor_id = $3 AND status = 'Pending' AND expiration_date >= ${CLINIC_TODAY}
      `,
      [decision, referralId, doctorId, decision === "Denied" ? reason : null]
    );
    return result.rowCount;
  });
  if (decided) return getReferral(pool, referralId);

  const current = await getReferral(pool, referralId);
  // doctors who aren't on the referral don't find out it exists
  if (!current || (current.referringDoctorId !== doctorId && current.primaryDoctorId !== doctorId && current.specialistDoctorId !== doctorId)) {
    throw new HttpError(404, "Referral not found");
  }
  if (current.primaryDoctorId !== doctorId) throw new HttpError(403, "Only the patient's primary doctor can approve or deny it");
  if (current.status !== "Pending") throw new HttpError(409, `This referral was already ${current.status.toLowerCase()}`);
  if (current.expired) throw new HttpError(409, "This referral has expired");
  throw new HttpError(409, "This referral just changed. Reload it and try again.");
}

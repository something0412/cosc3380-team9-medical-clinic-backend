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
  r.expiration_date < ${CLINIC_TODAY} AS "expired"
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
`;

const NEWEST_FIRST = `ORDER BY r.date_issued DESC, r.referral_id DESC`;

export interface NewReferral {
  patientId: number;
  specialistDoctorId: number;
  specialtyId: number;
  expirationDate?: string;
}

async function getReferral(db: Pool | PoolClient, referralId: number) {
  const result = await db.query(`SELECT ${REFERRAL_COLUMNS} FROM referral r ${REFERRAL_JOINS} WHERE r.referral_id = $1`, [referralId]);
  return result.rows[0];
}

// a doctor sees referrals they sent and referrals sent to them, never anyone else's
export async function listDoctorReferrals(doctorId: number, view: "sent" | "received" | "all" = "all") {
  const list = async (column: string) =>
    (await pool.query(`SELECT ${REFERRAL_COLUMNS} FROM referral r ${REFERRAL_JOINS} WHERE r.${column} = $1 ${NEWEST_FIRST}`, [doctorId])).rows;
  return {
    sent: view === "received" ? [] : await list("referring_doctor_id"),
    received: view === "sent" ? [] : await list("specialist_doctor_id"),
  };
}

export async function listPatientReferrals(patientId: number) {
  const result = await pool.query(`SELECT ${PATIENT_COLUMNS} FROM referral r ${REFERRAL_JOINS} WHERE r.patient_id = $1 ${NEWEST_FIRST}`, [patientId]);
  return result.rows;
}

// active doctors and the active specialties they practice, for the referral form
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
    JOIN specialty sp ON sp.specialty_id = ds.specialty_id AND sp.is_active
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
export async function createReferral(doctorId: number, input: NewReferral) {
  return withTransaction(async (client) => {
    await lockPeople(client, doctorId, input);
    const result = await client.query(
      `
      INSERT INTO referral (patient_id, referring_doctor_id, specialist_doctor_id, specialty_id, date_issued, expiration_date, status)
      SELECT $1, $2, $3, $4, ${CLINIC_TODAY}, COALESCE($5::date, ${CLINIC_TODAY} + ${DEFAULT_DAYS}), 'Pending'
      WHERE EXISTS (SELECT 1 FROM employee WHERE employee_id = $2 AND is_active)
        AND EXISTS (SELECT 1 FROM patient WHERE patient_id = $1 AND is_active)
        AND (${CARES_FOR_PATIENT})
        AND $2 <> $3
        AND ${SPECIALIST_PRACTICES}
        AND COALESCE($5::date, ${CLINIC_TODAY} + ${DEFAULT_DAYS}) > ${CLINIC_TODAY}
      RETURNING referral_id AS "referralId"
      `,
      [input.patientId, doctorId, input.specialistDoctorId, input.specialtyId, input.expirationDate ?? null]
    );
    if (!result.rowCount) await refuseReferral(client, doctorId, input);
    return getReferral(client, result.rows[0].referralId);
  });
}

// only the specialist it was sent to answers it, once, before it expires
export async function decideReferral(referralId: number, doctorId: number, decision: "Approved" | "Denied") {
  const result = await pool.query(
    `
    UPDATE referral
    SET status = $1
    WHERE referral_id = $2 AND specialist_doctor_id = $3 AND status = 'Pending' AND expiration_date >= ${CLINIC_TODAY}
    `,
    [decision, referralId, doctorId]
  );
  if (result.rowCount) return getReferral(pool, referralId);

  const current = await getReferral(pool, referralId);
  // doctors who aren't on the referral don't find out it exists
  if (!current || (current.referringDoctorId !== doctorId && current.specialistDoctorId !== doctorId)) {
    throw new HttpError(404, "Referral not found");
  }
  if (current.specialistDoctorId !== doctorId) throw new HttpError(403, "Only the specialist this was sent to can approve or deny it");
  if (current.status !== "Pending") throw new HttpError(409, `This referral was already ${current.status.toLowerCase()}`);
  if (current.expired) throw new HttpError(409, "This referral has expired");
  throw new HttpError(409, "This referral just changed. Reload it and try again.");
}

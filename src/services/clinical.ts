import type { Pool, PoolClient } from "pg";
import { CLINIC_NOW, CLINIC_TODAY } from "../lib/clinicTime.js";
import { pool } from "../lib/db.js";
import { HttpError } from "../middleware/errorHandler.js";

// a doctor cares for a patient they're assigned to or have a booked or finished visit with
// cancelled and No Show visits don't count, and a referral alone only shows the referral itself
export const doctorCaresFor = (doctor: string, patient: string) => `(
  EXISTS (SELECT 1 FROM patient_doctor pd WHERE pd.patient_id = ${patient} AND pd.doctor_id = ${doctor} AND pd.is_active)
  OR EXISTS (SELECT 1 FROM appointment ca WHERE ca.patient_id = ${patient} AND ca.doctor_id = ${doctor} AND ca.status IN ('Scheduled', 'Completed'))
)`;

// care only happened once the patient checked in, so only those visits can be documented
const DOCUMENTABLE = `(a.status = 'Completed' OR (a.status = 'Scheduled' AND a.checked_in_at IS NOT NULL))`;

export async function assertDoctorCanSeePatient(doctorId: number, patientId: number, db: Pool | PoolClient = pool) {
  const result = await db.query(`SELECT ${doctorCaresFor("$1", "p.patient_id")} AS cares FROM patient p WHERE p.patient_id = $2`, [doctorId, patientId]);
  if (!result.rowCount) throw new HttpError(404, "Patient not found");
  if (!result.rows[0].cares) throw new HttpError(403, "This patient isn't under your care");
}

// the doctor's row is locked so a deactivation in progress is waited for and then seen
export async function lockActiveDoctor(client: PoolClient, doctorId: number) {
  const me = await client.query(`SELECT is_active AS "isActive" FROM employee WHERE employee_id = $1 FOR SHARE`, [doctorId]);
  if (!me.rows[0]?.isActive) throw new HttpError(403, "Your account is no longer active");
}

// locks one of the doctor's own visits for documenting, so its status can't change until the write commits
export async function lockDoctorVisit(client: PoolClient, appointmentId: number, doctorId: number) {
  await lockActiveDoctor(client, doctorId);
  const visit = await client.query(
    `
    SELECT a.patient_id AS "patientId", a.doctor_id AS "doctorId", a.status, a.checked_in_at IS NOT NULL AS "checkedIn", ${DOCUMENTABLE} AS documentable
    FROM appointment a
    WHERE a.appointment_id = $1
    FOR NO KEY UPDATE
    `,
    [appointmentId]
  );
  const row = visit.rows[0];
  if (!row || row.doctorId !== doctorId) throw new HttpError(404, "Appointment not found");
  if (!row.documentable) {
    const detail = row.status === "Scheduled" ? "This patient hasn't checked in yet." : `This one is ${row.status}.`;
    throw new HttpError(409, `Only checked in or completed visits can be documented. ${detail}`);
  }
  return { patientId: row.patientId as number };
}

export async function listDoctorPatients(doctorId: number, search = "") {
  const result = await pool.query(
    `
    SELECT
      p.patient_id AS "patientId",
      p.first_name AS "firstName",
      p.last_name AS "lastName",
      to_char(p.dob, 'YYYY-MM-DD') AS dob,
      EXISTS (SELECT 1 FROM patient_doctor pd WHERE pd.patient_id = p.patient_id AND pd.doctor_id = $1 AND pd.is_active) AS "assignedToMe",
      (SELECT to_char(max(a.appointment_date), 'YYYY-MM-DD') FROM appointment a WHERE a.patient_id = p.patient_id AND a.status = 'Completed') AS "lastVisit",
      (
        SELECT to_char(min(a.appointment_date), 'YYYY-MM-DD') FROM appointment a
        WHERE a.patient_id = p.patient_id AND a.status = 'Scheduled' AND a.appointment_date >= ${CLINIC_TODAY}
      ) AS "nextVisit"
    FROM patient p
    WHERE ${doctorCaresFor("$1", "p.patient_id")}
      AND ($2 = '' OR p.first_name || ' ' || p.last_name ILIKE '%' || $2 || '%' ESCAPE '\\')
    ORDER BY p.last_name, p.first_name, p.patient_id
    `,
    [doctorId, search.replace(/[\\%_]/g, (character) => `\\${character}`)]
  );
  return result.rows;
}

const VITALS_COLUMNS = `
  v.vitals_id AS "vitalsId",
  v.appointment_id AS "appointmentId",
  to_char(v.recorded_at, 'YYYY-MM-DD HH24:MI') AS "recordedAt",
  e.first_name || ' ' || e.last_name AS "recordedBy",
  v.temperature::float AS temperature,
  v.heartrate_bpm AS "heartRate",
  v.systolic_bp AS systolic,
  v.diastolic_bp AS diastolic,
  v.respiratory_rate AS "respiratoryRate",
  v.oxygen_saturation AS "oxygenSaturation",
  v.weight_lbs::float AS weight,
  v.height_inches::float AS height
`;

const PRESCRIPTION_ITEM_COLUMNS = `
  pi.prescription_item_id AS "prescriptionItemId",
  pi.prescription_id AS "prescriptionId",
  pi.medication_id AS "medicationId",
  m.name AS "medicationName",
  pi.dosage,
  pi.instructions,
  pi.duration_days AS "durationDays",
  pi.is_active AS "isActive",
  to_char(rx.date_prescribed, 'YYYY-MM-DD') AS "datePrescribed",
  rx.appointment_id AS "appointmentId",
  rx.prescriber_id AS "prescriberId",
  d.first_name || ' ' || d.last_name AS "prescriberName"
`;

const PRESCRIPTION_ITEM_JOINS = `
  JOIN prescription rx ON rx.prescription_id = pi.prescription_id
  JOIN medication m ON m.medication_id = pi.medication_id
  JOIN employee d ON d.employee_id = rx.prescriber_id
`;

export const LAB_ORDER_COLUMNS = `
  l.lab_order_id AS "labOrderId",
  l.patient_id AS "patientId",
  p.first_name || ' ' || p.last_name AS "patientName",
  l.appointment_id AS "appointmentId",
  l.lab_test_type_id AS "labTestTypeId",
  t.name AS "testName",
  l.status,
  to_char(l.order_date, 'YYYY-MM-DD') AS "orderDate",
  l.ordered_by_employee_id AS "orderedById",
  ob.first_name || ' ' || ob.last_name AS "orderedBy",
  l.result_notes AS "resultNotes",
  to_char(l.result_date, 'YYYY-MM-DD HH24:MI') AS "resultDate",
  pb.first_name || ' ' || pb.last_name AS "performedBy"
`;

export const LAB_ORDER_JOINS = `
  JOIN patient p ON p.patient_id = l.patient_id
  JOIN lab_test_type t ON t.lab_test_type_id = l.lab_test_type_id
  JOIN employee ob ON ob.employee_id = l.ordered_by_employee_id
  LEFT JOIN employee pb ON pb.employee_id = l.performed_by_employee_id
`;

// things to know before seeing the patient, shared by the chart and the visit view
export async function getPatientAlerts(patientId: number) {
  const allergies = await pool.query(
    `
    SELECT al.allergy_id AS "allergyId", al.allergy_type_id AS "allergyTypeId", t.name, t.category, al.reaction, al.severity
    FROM allergy al
    JOIN allergy_type t ON t.allergy_type_id = al.allergy_type_id
    WHERE al.patient_id = $1 AND al.is_active
    ORDER BY CASE al.severity WHEN 'Severe' THEN 1 WHEN 'Moderate' THEN 2 ELSE 3 END, t.name
    `,
    [patientId]
  );
  // provider and status only, the policy number isn't needed for care
  const insurance = await pool.query(`SELECT provider, status FROM insurance WHERE patient_id = $1`, [patientId]);
  const missingForms = await pool.query(
    `
    SELECT f.name
    FROM form_type f
    WHERE f.is_required AND f.is_active
      AND NOT EXISTS (SELECT 1 FROM form_submission s WHERE s.form_type_id = f.form_type_id AND s.patient_id = $1 AND s.status = 'Completed')
    ORDER BY f.form_type_id
    `,
    [patientId]
  );
  return { allergies: allergies.rows, insurance: insurance.rows[0] ?? null, missingForms: missingForms.rows.map((f) => f.name as string) };
}

// the clinical chart, read only after the caller has checked access
export async function getPatientChart(patientId: number, doctorId: number) {
  const patient = await pool.query(
    `
    SELECT
      p.patient_id AS "patientId",
      p.first_name AS "firstName",
      p.last_name AS "lastName",
      to_char(p.dob, 'YYYY-MM-DD') AS dob,
      p.gender,
      p.phone,
      p.is_active AS "isActive",
      EXISTS (SELECT 1 FROM patient_doctor pd WHERE pd.patient_id = p.patient_id AND pd.doctor_id = $2 AND pd.is_active) AS "assignedToMe"
    FROM patient p
    WHERE p.patient_id = $1
    `,
    [patientId, doctorId]
  );
  const homeMedications = await pool.query(
    `
    SELECT
      home_medication_id AS "homeMedicationId",
      medication_id AS "medicationId",
      medication_name AS "medicationName",
      category,
      dosage,
      frequency,
      to_char(start_date, 'YYYY-MM-DD') AS "startDate"
    FROM home_medication
    WHERE patient_id = $1 AND is_active
    ORDER BY medication_name
    `,
    [patientId]
  );
  const vitals = await pool.query(
    `SELECT ${VITALS_COLUMNS} FROM patient_vitals v JOIN employee e ON e.employee_id = v.recorded_by_employee_id
     WHERE v.patient_id = $1 ORDER BY v.recorded_at DESC, v.vitals_id DESC LIMIT 10`,
    [patientId]
  );
  const visits = await pool.query(
    `
    SELECT
      a.appointment_id AS "appointmentId",
      to_char(a.appointment_date, 'YYYY-MM-DD') AS "date",
      to_char(ts.start_time, 'HH24:MI') AS "startTime",
      a.doctor_id AS "doctorId",
      e.first_name || ' ' || e.last_name AS "doctorName",
      sp.name AS specialty,
      a.status,
      s.visit_reason AS "visitReason",
      COALESCE((SELECT json_agg(d.name ORDER BY d.created_at, d.visit_diagnosis_id) FROM visit_diagnosis d WHERE d.appointment_id = a.appointment_id), '[]') AS diagnoses
    FROM appointment a
    JOIN time_slot ts ON ts.time_slot_id = a.time_slot_id
    JOIN employee e ON e.employee_id = a.doctor_id
    JOIN specialty sp ON sp.specialty_id = a.specialty_id
    LEFT JOIN appointment_summary s ON s.appointment_id = a.appointment_id
    WHERE a.patient_id = $1 AND a.status <> 'Cancelled'
    ORDER BY a.appointment_date DESC, ts.start_time DESC, a.appointment_id DESC
    `,
    [patientId]
  );
  const labOrders = await pool.query(
    `SELECT ${LAB_ORDER_COLUMNS} FROM lab_order l ${LAB_ORDER_JOINS} WHERE l.patient_id = $1 ORDER BY l.order_date DESC, l.lab_order_id DESC`,
    [patientId]
  );
  const prescriptions = await pool.query(
    `SELECT ${PRESCRIPTION_ITEM_COLUMNS} FROM prescription_item pi ${PRESCRIPTION_ITEM_JOINS}
     WHERE rx.patient_id = $1 AND pi.is_active ORDER BY rx.date_prescribed DESC, pi.prescription_item_id DESC`,
    [patientId]
  );

  return {
    ...patient.rows[0],
    ...(await getPatientAlerts(patientId)),
    homeMedications: homeMedications.rows,
    vitals: vitals.rows,
    visits: visits.rows,
    labOrders: labOrders.rows,
    prescriptions: prescriptions.rows,
  };
}

async function getSummary(db: Pool | PoolClient, appointmentId: number) {
  const result = await db.query(
    `
    SELECT s.appointment_id AS "appointmentId", s.visit_reason AS "visitReason", s.notes,
      s.recorded_by_employee_id AS "recordedById", e.first_name || ' ' || e.last_name AS "recordedBy", to_char(s.recorded_date, 'YYYY-MM-DD') AS "recordedDate"
    FROM appointment_summary s
    JOIN employee e ON e.employee_id = s.recorded_by_employee_id
    WHERE s.appointment_id = $1
    `,
    [appointmentId]
  );
  return result.rows[0] ?? null;
}

export async function listVisitDiagnoses(db: Pool | PoolClient, appointmentId: number) {
  const result = await db.query(
    `
    SELECT d.visit_diagnosis_id AS "visitDiagnosisId", d.name, d.reasoning,
      d.recorded_by_employee_id AS "recordedById", e.first_name || ' ' || e.last_name AS "recordedBy", to_char(d.created_at, 'YYYY-MM-DD HH24:MI') AS "createdAt"
    FROM visit_diagnosis d
    JOIN employee e ON e.employee_id = d.recorded_by_employee_id
    WHERE d.appointment_id = $1
    ORDER BY d.created_at, d.visit_diagnosis_id
    `,
    [appointmentId]
  );
  return result.rows;
}

// what was recorded at one visit
export async function getVisitRecord(appointmentId: number) {
  const vitals = await pool.query(
    `SELECT ${VITALS_COLUMNS} FROM patient_vitals v JOIN employee e ON e.employee_id = v.recorded_by_employee_id
     WHERE v.appointment_id = $1 ORDER BY v.recorded_at DESC, v.vitals_id DESC`,
    [appointmentId]
  );
  const prescriptions = await pool.query(
    `SELECT ${PRESCRIPTION_ITEM_COLUMNS} FROM prescription_item pi ${PRESCRIPTION_ITEM_JOINS} WHERE rx.appointment_id = $1 ORDER BY pi.prescription_item_id`,
    [appointmentId]
  );
  return {
    summary: await getSummary(pool, appointmentId),
    diagnoses: await listVisitDiagnoses(pool, appointmentId),
    vitals: vitals.rows,
    prescriptions: prescriptions.rows,
  };
}

export async function getPrescription(db: Pool | PoolClient, prescriptionId: number) {
  const prescription = await db.query(
    `
    SELECT rx.prescription_id AS "prescriptionId", rx.patient_id AS "patientId", p.first_name || ' ' || p.last_name AS "patientName",
      rx.appointment_id AS "appointmentId", rx.prescriber_id AS "prescriberId", d.first_name || ' ' || d.last_name AS "prescriberName",
      to_char(rx.date_prescribed, 'YYYY-MM-DD') AS "datePrescribed", rx.is_active AS "isActive"
    FROM prescription rx
    JOIN patient p ON p.patient_id = rx.patient_id
    JOIN employee d ON d.employee_id = rx.prescriber_id
    WHERE rx.prescription_id = $1
    `,
    [prescriptionId]
  );
  if (!prescription.rowCount) return null;
  const items = await db.query(
    `SELECT ${PRESCRIPTION_ITEM_COLUMNS} FROM prescription_item pi ${PRESCRIPTION_ITEM_JOINS} WHERE pi.prescription_id = $1 ORDER BY pi.prescription_item_id`,
    [prescriptionId]
  );
  return { ...prescription.rows[0], items: items.rows };
}

// only the fields that were sent change, so a note saved by someone else isn't wiped out
// the first person to write the summary stays as its recorder
export async function saveVisitSummary(
  client: PoolClient,
  appointmentId: number,
  employeeId: number,
  fields: { visitReason?: string | null; notes?: string | null }
) {
  await client.query(
    `
    INSERT INTO appointment_summary (appointment_id, visit_reason, notes, recorded_by_employee_id, recorded_date)
    VALUES ($1, $2, $3, $4, ${CLINIC_TODAY})
    ON CONFLICT (appointment_id) DO UPDATE SET
      visit_reason = CASE WHEN $5 THEN EXCLUDED.visit_reason ELSE appointment_summary.visit_reason END,
      notes = CASE WHEN $6 THEN EXCLUDED.notes ELSE appointment_summary.notes END
    `,
    [appointmentId, fields.visitReason ?? null, fields.notes ?? null, employeeId, fields.visitReason !== undefined, fields.notes !== undefined]
  );
  return getSummary(client, appointmentId);
}

// a diagnosis already on the visit isn't added twice, even across repeated requests
export async function addVisitDiagnoses(client: PoolClient, appointmentId: number, employeeId: number, diagnoses: { name: string; reasoning?: string | null }[]) {
  for (const diagnosis of diagnoses) {
    await client.query(
      `
      INSERT INTO visit_diagnosis (appointment_id, name, reasoning, recorded_by_employee_id, created_at)
      SELECT $1, $2::text, $3, $4, ${CLINIC_NOW}
      WHERE NOT EXISTS (SELECT 1 FROM visit_diagnosis WHERE appointment_id = $1 AND lower(name) = lower($2::text))
      `,
      [appointmentId, diagnosis.name, diagnosis.reasoning ?? null, employeeId]
    );
  }
  return listVisitDiagnoses(client, appointmentId);
}

import type { Pool, PoolClient } from "pg";
import { CLINIC_NOW, CLINIC_TODAY } from "../lib/clinicTime.js";
import { pool } from "../lib/db.js";
import { withTransaction } from "../lib/transaction.js";
import { HttpError } from "../middleware/errorHandler.js";
import type { SessionUser } from "../middleware/sessionUser.js";

// doctors and nurses share the chart and patient record code, and each role has its own access rule
export interface Clinician {
  role: "doctor" | "nurse";
  employeeId: number;
  officeId: number;
}

// the signed in doctor or nurse, never an ID from the request
export function asClinician(user: SessionUser | undefined, role: Clinician["role"]): Clinician {
  if (!user || user.role === "patient" || user.staffType !== role) throw new HttpError(401, "Login required");
  return { role, employeeId: user.employeeId, officeId: user.officeId };
}

// a doctor cares for a patient they're assigned to or have a booked or finished visit with
// cancelled and No Show visits don't count, and a referral alone only shows the referral itself
export const doctorCaresFor = (doctor: string, patient: string) => `(
  EXISTS (SELECT 1 FROM patient_doctor pd WHERE pd.patient_id = ${patient} AND pd.doctor_id = ${doctor} AND pd.is_active)
  OR EXISTS (SELECT 1 FROM appointment ca WHERE ca.patient_id = ${patient} AND ca.doctor_id = ${doctor} AND ca.status IN ('Scheduled', 'Completed'))
)`;

// nurses aren't assigned to single visits, so they care for patients with a visit at their office today
// an older visit there doesn't keep the chart open
const nurseCaresFor = (office: string, patient: string) => `EXISTS (
  SELECT 1 FROM appointment na
  WHERE na.patient_id = ${patient} AND na.office_id = ${office} AND na.appointment_date = ${CLINIC_TODAY} AND na.status IN ('Scheduled', 'Completed')
)`;

const caresFor = (c: Clinician, param: string, patient: string) => (c.role === "doctor" ? doctorCaresFor(param, patient) : nurseCaresFor(param, patient));
const careKey = (c: Clinician) => (c.role === "doctor" ? c.employeeId : c.officeId);
const NOT_IN_CARE = { doctor: "This patient isn't under your care", nurse: "This patient doesn't have a visit at your office today" };

// care only happened once the patient checked in, so only those visits can be documented
const DOCUMENTABLE = `(a.status = 'Completed' OR (a.status = 'Scheduled' AND a.checked_in_at IS NOT NULL))`;

export async function assertCanSeePatient(c: Clinician, patientId: number, db: Pool | PoolClient = pool) {
  const result = await db.query(`-- TODO X07: check this patient is in my care`, [careKey(c), patientId]);
  if (!result.rowCount) throw new HttpError(404, "Patient not found");
  if (!result.rows[0].cares) throw new HttpError(403, NOT_IN_CARE[c.role]);
}

// the employee row is locked so a deactivation or office move in progress is waited for and then seen
export async function lockActiveEmployee(client: PoolClient, employeeId: number) {
  const me = await client.query(`SELECT is_active AS "isActive", office_id AS "officeId" FROM employee WHERE employee_id = $1 FOR SHARE`, [employeeId]);
  if (!me.rows[0]?.isActive) throw new HttpError(403, "Your account is no longer active");
  return me.rows[0].officeId as number;
}

// locks the patient and then the clinician before a patient record changes
// writes for one patient go one at a time, so the same record can't be added twice
// hideAs turns a patient outside your care into a not found error, so a record ID doesn't give anything away
export async function lockPatientInCare(client: PoolClient, c: Clinician, patientId: number, hideAs?: string) {
  const patient = await client.query(`SELECT is_active AS "isActive" FROM patient WHERE patient_id = $1 FOR NO KEY UPDATE`, [patientId]);
  if (!patient.rowCount) throw new HttpError(404, hideAs ?? "Patient not found");
  const me = { ...c, officeId: await lockActiveEmployee(client, c.employeeId) };
  const care = await client.query(`-- TODO X15: check the patient is in my care before a change`, [careKey(me), patientId]);
  if (!care.rows[0].cares) throw hideAs ? new HttpError(404, hideAs) : new HttpError(403, NOT_IN_CARE[c.role]);
  if (!patient.rows[0].isActive) throw new HttpError(409, "This patient account is inactive");
}

// locks a visit for documenting, so its status can't change until the write commits
// doctors document their own visits, and nurses document visits at their office on the day they happen
export async function lockVisit(client: PoolClient, appointmentId: number, c: Clinician) {
  const officeId = await lockActiveEmployee(client, c.employeeId);
  const visit = await client.query(
    `-- TODO X05: lock a visit and check it can be documented, get its patient`,
    [appointmentId]
  );
  const row = visit.rows[0];
  const mine = c.role === "doctor" ? row?.doctorId === c.employeeId : row?.officeId === officeId;
  if (!row || !mine) throw new HttpError(404, "Appointment not found");
  if (!row.documentable) {
    const detail = row.status === "Scheduled" ? "This patient hasn't checked in yet." : `This one is ${row.status}.`;
    throw new HttpError(409, `Only checked in or completed visits can be documented. ${detail}`);
  }
  if (c.role === "nurse" && !row.today) throw new HttpError(409, "Nurses can only document a visit on the day it happens");
  return { patientId: row.patientId as number };
}

export async function listPatientsInCare(c: Clinician, search = "") {
  const result = await pool.query(
    `-- TODO X06: patients in my care (name search)`,
    [careKey(c), search.replace(/[\\%_]/g, (character) => `\\${character}`)]
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

const ALLERGY_COLUMNS = `
  al.allergy_id AS "allergyId",
  al.patient_id AS "patientId",
  al.allergy_type_id AS "allergyTypeId",
  t.name,
  t.category,
  al.reaction,
  al.severity,
  al.is_active AS "isActive"
`;

const HOME_MEDICATION_COLUMNS = `
  hm.home_medication_id AS "homeMedicationId",
  hm.patient_id AS "patientId",
  hm.medication_id AS "medicationId",
  hm.medication_name AS "medicationName",
  hm.category,
  hm.dosage,
  hm.frequency,
  to_char(hm.start_date, 'YYYY-MM-DD') AS "startDate",
  hm.is_active AS "isActive"
`;

const NURSING_NOTE_COLUMNS = `
  nn.nursing_note_id AS "nursingNoteId",
  nn.appointment_id AS "appointmentId",
  nn.note,
  nn.recorded_by_employee_id AS "recordedById",
  e.first_name || ' ' || e.last_name AS "recordedBy",
  to_char(nn.recorded_at, 'YYYY-MM-DD HH24:MI') AS "recordedAt",
  to_char(nn.updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
`;

const NURSING_NOTE_JOINS = `
  JOIN appointment a ON a.appointment_id = nn.appointment_id
  JOIN employee e ON e.employee_id = nn.recorded_by_employee_id
`;

// things to know before seeing the patient, shared by the chart and the visit view
export async function getPatientAlerts(patientId: number, c: Clinician) {
  const allergies = await pool.query(
    `
    SELECT ${ALLERGY_COLUMNS}
    FROM allergy al
    JOIN allergy_type t ON t.allergy_type_id = al.allergy_type_id
    WHERE al.patient_id = $1 AND al.is_active
    ORDER BY CASE al.severity WHEN 'Severe' THEN 1 WHEN 'Moderate' THEN 2 ELSE 3 END, t.name
    `,
    [patientId]
  );
  const homeMedications = await pool.query(
    `SELECT ${HOME_MEDICATION_COLUMNS} FROM home_medication hm WHERE hm.patient_id = $1 AND hm.is_active ORDER BY hm.medication_name, hm.home_medication_id`,
    [patientId]
  );
  const missingForms = await pool.query(
    `-- TODO D09: patient alerts: required forms not completed`,
    [patientId]
  );
  // nurses don't need insurance for care, and doctors only see the provider and status
  const insurance = c.role === "doctor" ? await pool.query(`-- TODO D08: patient alerts: insurance provider and status`, [patientId]) : null;
  return {
    allergies: allergies.rows,
    ...(insurance && { insurance: insurance.rows[0] ?? null }),
    missingForms: missingForms.rows.map((f) => f.name as string),
    homeMedications: homeMedications.rows,
  };
}

async function listNursingNotes(db: Pool | PoolClient, by: "appointment" | "patient", id: number) {
  const result = await db.query(
    `SELECT ${NURSING_NOTE_COLUMNS} FROM nursing_note nn ${NURSING_NOTE_JOINS}
     WHERE ${by === "appointment" ? "nn.appointment_id" : "a.patient_id"} = $1 ORDER BY nn.recorded_at DESC, nn.nursing_note_id DESC LIMIT 20`,
    [id]
  );
  return result.rows;
}

// the clinical chart, read only after the caller has checked access
export async function getPatientChart(patientId: number, c: Clinician) {
  const doctor = c.role === "doctor";
  const patient = await pool.query(
    `-- TODO X08: chart: the patient's basic info`,
    doctor ? [patientId, c.employeeId] : [patientId]
  );
  const vitals = await pool.query(
    `-- TODO X09: chart: last 10 vitals`,
    [patientId]
  );
  const visits = await pool.query(
    `-- TODO X10: chart: visits`,
    [patientId]
  );
  const labOrders = await pool.query(
    `-- TODO X11: chart: lab orders`,
    [patientId]
  );
  const prescriptions = await pool.query(
    `-- TODO X12: chart: active prescriptions`,
    [patientId]
  );

  return {
    ...patient.rows[0],
    ...(await getPatientAlerts(patientId, c)),
    vitals: vitals.rows,
    nursingNotes: await listNursingNotes(pool, "patient", patientId),
    visits: visits.rows,
    labOrders: labOrders.rows,
    prescriptions: prescriptions.rows,
  };
}

async function getSummary(db: Pool | PoolClient, appointmentId: number) {
  const result = await db.query(
    `-- TODO D05: visit: the visit summary`,
    [appointmentId]
  );
  return result.rows[0] ?? null;
}

export async function listVisitDiagnoses(db: Pool | PoolClient, appointmentId: number) {
  const result = await db.query(
    `-- TODO D06: visit: diagnoses at this visit`,
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
    `-- TODO D07: visit: prescriptions written at this visit`,
    [appointmentId]
  );
  return {
    summary: await getSummary(pool, appointmentId),
    diagnoses: await listVisitDiagnoses(pool, appointmentId),
    vitals: vitals.rows,
    nursingNotes: await listNursingNotes(pool, "appointment", appointmentId),
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
    `-- TODO D10: save the visit summary`,
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

export interface VitalsReadings {
  temperature?: number | null;
  heartRate?: number | null;
  systolic?: number | null;
  diastolic?: number | null;
  respiratoryRate?: number | null;
  oxygenSaturation?: number | null;
  weight?: number | null;
  height?: number | null;
}

// every reading is a new row, so earlier readings stay as they were
export async function recordVitals(c: Clinician, appointmentId: number, readings: VitalsReadings) {
  return withTransaction(async (client) => {
    const { patientId } = await lockVisit(client, appointmentId, c);
    const created = await client.query(
      `
      INSERT INTO patient_vitals (patient_id, appointment_id, recorded_by_employee_id, temperature, heartrate_bpm, systolic_bp, diastolic_bp,
        respiratory_rate, oxygen_saturation, weight_lbs, height_inches, recorded_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, ${CLINIC_NOW})
      RETURNING vitals_id
      `,
      [
        patientId,
        appointmentId,
        c.employeeId,
        readings.temperature ?? null,
        readings.heartRate ?? null,
        readings.systolic ?? null,
        readings.diastolic ?? null,
        readings.respiratoryRate ?? null,
        readings.oxygenSaturation ?? null,
        readings.weight ?? null,
        readings.height ?? null,
      ]
    );
    const vitals = await client.query(`SELECT ${VITALS_COLUMNS} FROM patient_vitals v JOIN employee e ON e.employee_id = v.recorded_by_employee_id WHERE v.vitals_id = $1`, [
      created.rows[0].vitals_id,
    ]);
    return vitals.rows[0];
  });
}

async function getNursingNote(db: Pool | PoolClient, nursingNoteId: number) {
  const result = await db.query(`SELECT ${NURSING_NOTE_COLUMNS} FROM nursing_note nn ${NURSING_NOTE_JOINS} WHERE nn.nursing_note_id = $1`, [nursingNoteId]);
  return result.rows[0] ?? null;
}

// nursing notes have their own table, so they never touch the doctor's visit summary
export async function addNursingNote(c: Clinician, appointmentId: number, note: string) {
  return withTransaction(async (client) => {
    await lockVisit(client, appointmentId, c);
    const created = await client.query(
      `INSERT INTO nursing_note (appointment_id, recorded_by_employee_id, note, recorded_at) VALUES ($1, $2, $3, ${CLINIC_NOW}) RETURNING nursing_note_id`,
      [appointmentId, c.employeeId, note]
    );
    return getNursingNote(client, created.rows[0].nursing_note_id);
  });
}

// only the nurse who wrote a note can change it, and only while the visit can still be documented
export async function updateNursingNote(c: Clinician, nursingNoteId: number, note: string) {
  const current = await pool.query(`SELECT appointment_id AS "appointmentId", recorded_by_employee_id AS "recordedById" FROM nursing_note WHERE nursing_note_id = $1`, [
    nursingNoteId,
  ]);
  if (!current.rowCount) throw new HttpError(404, "Note not found");
  const { appointmentId, recordedById } = current.rows[0];

  return withTransaction(async (client) => {
    await lockVisit(client, appointmentId, c).catch((err) => {
      throw err instanceof HttpError && err.status === 404 ? new HttpError(404, "Note not found") : err;
    });
    if (recordedById !== c.employeeId) throw new HttpError(403, "Only the nurse who wrote a note can change it");
    await client.query(`UPDATE nursing_note SET note = $2, updated_at = ${CLINIC_NOW} WHERE nursing_note_id = $1`, [nursingNoteId, note]);
    return getNursingNote(client, nursingNoteId);
  });
}

export async function listAllergyTypes() {
  const result = await pool.query(`SELECT allergy_type_id AS "allergyTypeId", name, category FROM allergy_type WHERE is_active ORDER BY name`);
  return result.rows;
}

async function getAllergy(db: Pool | PoolClient, allergyId: number) {
  const result = await db.query(`SELECT ${ALLERGY_COLUMNS} FROM allergy al JOIN allergy_type t ON t.allergy_type_id = al.allergy_type_id WHERE al.allergy_id = $1`, [
    allergyId,
  ]);
  return result.rows[0];
}

// locks the patient a record belongs to and says whether the record is still active
async function lockRecordPatient(client: PoolClient, c: Clinician, table: "allergy" | "home_medication", recordId: number, missing: string) {
  const record = await client.query(`SELECT patient_id AS "patientId" FROM ${table} WHERE ${table}_id = $1`, [recordId]);
  if (!record.rowCount) throw new HttpError(404, missing);
  await lockPatientInCare(client, c, record.rows[0].patientId, missing);
  // read it once the patient is locked, so a change made while we waited is seen
  const locked = await client.query(`SELECT is_active AS "isActive" FROM ${table} WHERE ${table}_id = $1`, [recordId]);
  return locked.rows[0].isActive as boolean;
}

// the schema keeps one row per patient and allergy type, so a removed allergy comes back instead of being added twice
export async function addAllergy(c: Clinician, patientId: number, input: { allergyTypeId: number; reaction: string | null; severity: string }) {
  return withTransaction(async (client) => {
    await lockPatientInCare(client, c, patientId);
    const type = await client.query(`SELECT 1 FROM allergy_type WHERE allergy_type_id = $1 AND is_active`, [input.allergyTypeId]);
    if (!type.rowCount) throw new HttpError(400, "Choose an active allergy");

    const existing = await client.query(`SELECT allergy_id AS "allergyId", is_active AS "isActive" FROM allergy WHERE patient_id = $1 AND allergy_type_id = $2`, [
      patientId,
      input.allergyTypeId,
    ]);
    const old = existing.rows[0];
    if (old?.isActive) throw new HttpError(409, "This allergy is already on the patient's chart. Edit it instead.");
    if (old) {
      await client.query(`UPDATE allergy SET reaction = $2, severity = $3, is_active = true WHERE allergy_id = $1`, [old.allergyId, input.reaction, input.severity]);
      return getAllergy(client, old.allergyId);
    }
    const created = await client.query(`INSERT INTO allergy (patient_id, allergy_type_id, reaction, severity) VALUES ($1, $2, $3, $4) RETURNING allergy_id`, [
      patientId,
      input.allergyTypeId,
      input.reaction,
      input.severity,
    ]);
    return getAllergy(client, created.rows[0].allergy_id);
  });
}

// only the fields that were sent change
export async function updateAllergy(c: Clinician, allergyId: number, fields: { reaction?: string | null; severity?: string }) {
  return withTransaction(async (client) => {
    if (!(await lockRecordPatient(client, c, "allergy", allergyId, "Allergy not found"))) {
      throw new HttpError(409, "This allergy was removed. Add it again instead.");
    }
    await client.query(`UPDATE allergy SET reaction = CASE WHEN $2 THEN $3 ELSE reaction END, severity = COALESCE($4, severity) WHERE allergy_id = $1`, [
      allergyId,
      fields.reaction !== undefined,
      fields.reaction ?? null,
      fields.severity ?? null,
    ]);
    return getAllergy(client, allergyId);
  });
}

// removed allergies stay in the database as inactive
export async function removeAllergy(c: Clinician, allergyId: number) {
  return withTransaction(async (client) => {
    if (!(await lockRecordPatient(client, c, "allergy", allergyId, "Allergy not found"))) throw new HttpError(409, "This allergy was already removed");
    await client.query(`UPDATE allergy SET is_active = false WHERE allergy_id = $1`, [allergyId]);
    return getAllergy(client, allergyId);
  });
}

export async function listMedications() {
  const result = await pool.query(`SELECT medication_id AS "medicationId", name, manufacturer FROM medication WHERE is_active ORDER BY name`);
  return result.rows;
}

async function getHomeMedication(db: Pool | PoolClient, homeMedicationId: number) {
  const result = await db.query(`SELECT ${HOME_MEDICATION_COLUMNS} FROM home_medication hm WHERE hm.home_medication_id = $1`, [homeMedicationId]);
  return result.rows[0];
}

export interface HomeMedicationFields {
  category?: string | null;
  dosage?: string | null;
  frequency?: string | null;
}

// what the patient already takes at home, kept apart from prescriptions written here
// a medication picked from the list uses its own name, otherwise the typed name is kept
export async function addHomeMedication(c: Clinician, patientId: number, input: HomeMedicationFields & { medicationId?: number | null; medicationName?: string | null }) {
  return withTransaction(async (client) => {
    await lockPatientInCare(client, c, patientId);
    let name = input.medicationName ?? null;
    if (input.medicationId) {
      const medication = await client.query(`SELECT name FROM medication WHERE medication_id = $1 AND is_active`, [input.medicationId]);
      if (!medication.rowCount) throw new HttpError(400, "Choose an active medication");
      name = medication.rows[0].name;
    }

    const duplicate = await client.query(
      `SELECT 1 FROM home_medication WHERE patient_id = $1 AND is_active AND (medication_id = $2 OR lower(medication_name) = lower($3::text))`,
      [patientId, input.medicationId ?? null, name]
    );
    if (duplicate.rowCount) throw new HttpError(409, "The patient already takes this medication. Edit it instead.");

    const created = await client.query(
      `
      INSERT INTO home_medication (patient_id, medication_id, medication_name, category, dosage, frequency, start_date)
      VALUES ($1, $2, $3, $4, $5, $6, ${CLINIC_TODAY})
      RETURNING home_medication_id
      `,
      [patientId, input.medicationId ?? null, name, input.category ?? null, input.dosage ?? null, input.frequency ?? null]
    );
    return getHomeMedication(client, created.rows[0].home_medication_id);
  });
}

// only the fields that were sent change
export async function updateHomeMedication(c: Clinician, homeMedicationId: number, fields: HomeMedicationFields) {
  return withTransaction(async (client) => {
    if (!(await lockRecordPatient(client, c, "home_medication", homeMedicationId, "Home medication not found"))) {
      throw new HttpError(409, "This medication was stopped. Add it again instead.");
    }
    await client.query(
      `
      UPDATE home_medication SET
        category = CASE WHEN $2 THEN $3 ELSE category END,
        dosage = CASE WHEN $4 THEN $5 ELSE dosage END,
        frequency = CASE WHEN $6 THEN $7 ELSE frequency END
      WHERE home_medication_id = $1
      `,
      [
        homeMedicationId,
        fields.category !== undefined,
        fields.category ?? null,
        fields.dosage !== undefined,
        fields.dosage ?? null,
        fields.frequency !== undefined,
        fields.frequency ?? null,
      ]
    );
    return getHomeMedication(client, homeMedicationId);
  });
}

// stopped home medications stay in the database as inactive
export async function stopHomeMedication(c: Clinician, homeMedicationId: number) {
  return withTransaction(async (client) => {
    if (!(await lockRecordPatient(client, c, "home_medication", homeMedicationId, "Home medication not found"))) {
      throw new HttpError(409, "This medication was already stopped");
    }
    await client.query(`UPDATE home_medication SET is_active = false WHERE home_medication_id = $1`, [homeMedicationId]);
    return getHomeMedication(client, homeMedicationId);
  });
}
import { Router } from "express";
import { z } from "zod";
import { pool, withTransaction } from "../lib/db.js";
import { hashPassword } from "../lib/password.js";
import { requireStaffType } from "../lib/staff.js";
import { HttpError } from "../middleware/errorHandler.js";

export const patientsRouter = Router();

// No controllers folder: for a learning project this small, splitting
// "route" and "controller" into two files per entity was extra
// indirection without enough payoff. Each route handler just writes its
// own SQL and shapes its own response — copy this file's shape
// (Router + pool.query + res.json) for new entities (appointments,
// doctors, etc.) instead of creating a controllers/*.ts file.
//
// Columns in the real `patient` table (see clinic_database_dump.sql) are
// snake_case, matching normal SQL convention. We alias them to camelCase
// in the SELECT itself so the JSON this API returns matches normal
// JS/TS naming — that way the translation happens once, here, instead of
// every frontend component having to deal with snake_case field names.

const searchSchema = z.object({
  search: z.string().trim().optional(),
  dob: z.iso.date().optional(),
  phone: z.string().optional(),
});

// Global patient search (not limited to one office), e.g.
// GET /api/patients?search=gonz&dob=1985-04-12&phone=5550101
// Every filter is optional; with none, every patient is returned.
//
// Each "$n IS NULL OR ..." line turns a filter off when it wasn't given,
// so one query handles every combination. Phone numbers are compared as
// digits only, so "713-555-0101" matches a search for "5550101".
patientsRouter.get("/api/patients", async (req, res) => {
  const query = searchSchema.parse(req.query);
  const digits = query.phone?.replace(/\D/g, "") || null;

  const result = await pool.query(
    `
    SELECT
      patient_id AS "patientId",
      first_name AS "firstName",
      last_name AS "lastName",
      dob,
      phone,
      email,
      is_active AS "isActive"
    FROM patient
    WHERE ($1::text IS NULL
           OR first_name || ' ' || last_name ILIKE '%' || $1 || '%'
           OR last_name || ', ' || first_name ILIKE '%' || $1 || '%')
      AND ($2::date IS NULL OR dob = $2)
      AND ($3::text IS NULL OR regexp_replace(phone, '\\D', '', 'g') LIKE '%' || $3 || '%')
    ORDER BY last_name, first_name
    `,
    [query.search || null, query.dob ?? null, digits]
  );

  res.json(result.rows);
});

// Empty optional text fields from the form arrive as "" — store them as NULL.
const optionalText = z
  .string()
  .trim()
  .transform((s) => s || null)
  .nullable()
  .default(null);

const optionalEmail = z
  .union([z.email().trim().toLowerCase(), z.literal("").transform(() => null)])
  .nullable()
  .default(null);

const demographicsSchema = {
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  dob: z.iso.date(),
  gender: optionalText,
  phone: z.string().trim().min(1),
  email: optionalEmail,
  address: optionalText,
};

const registerPatientSchema = z
  .object({
    employeeId: z.number().int().positive(),
    ...demographicsSchema,
    // All optional, but if given, every field in them is required.
    emergencyContact: z
      .object({
        firstName: z.string().trim().min(1),
        lastName: z.string().trim().min(1),
        relationship: z.string().trim().min(1),
        phone: z.string().trim().min(1),
      })
      .nullable()
      .default(null),
    insurance: z
      .object({
        provider: z.string().trim().min(1),
        policyNumber: z.string().trim().min(1),
      })
      .nullable()
      .default(null),
    // Optional patient-portal account; the patient logs in with their email.
    portalPassword: z.string().min(8).nullable().default(null),
  })
  .refine((b) => !b.portalPassword || b.email, {
    message: "A portal account needs an email address",
    path: ["email"],
  });

// Register a new patient at the front desk (receptionists only). The
// patient, their emergency contact, insurance and portal login are
// inserted in one transaction: if any insert fails (e.g. a duplicate
// policy number), ROLLBACK undoes the others, so we never keep a
// half-registered patient.
patientsRouter.post("/api/patients", async (req, res) => {
  const body = registerPatientSchema.parse(req.body);
  await requireStaffType(body.employeeId, "receptionist", "register patients");

  const patient = await withTransaction(async (client) => {
    const patient = await client.query(
      `
      INSERT INTO patient (first_name, last_name, dob, gender, phone, email, address)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING
        patient_id AS "patientId",
        first_name AS "firstName",
        last_name AS "lastName",
        dob,
        phone,
        email,
        is_active AS "isActive"
      `,
      [body.firstName, body.lastName, body.dob, body.gender, body.phone, body.email, body.address]
    );
    const { patientId } = patient.rows[0];

    // A patient's first contact is always their primary one.
    if (body.emergencyContact) {
      const ec = body.emergencyContact;
      await client.query(
        `
        INSERT INTO emergency_contact (patient_id, first_name, last_name, relationship, phone_number, is_primary)
        VALUES ($1, $2, $3, $4, $5, true)
        `,
        [patientId, ec.firstName, ec.lastName, ec.relationship, ec.phone]
      );
    }

    // New policies start as 'Pending' (the column default) until verified.
    if (body.insurance) {
      await client.query(`INSERT INTO insurance (patient_id, provider, policy_number) VALUES ($1, $2, $3)`, [
        patientId,
        body.insurance.provider,
        body.insurance.policyNumber,
      ]);
    }

    if (body.portalPassword) {
      await client.query(`INSERT INTO patient_creds (patient_id, username, password_hash) VALUES ($1, $2, $3)`, [
        patientId,
        body.email,
        await hashPassword(body.portalPassword),
      ]);
    }

    return patient.rows[0];
  });

  res.status(201).json(patient);
});

const patientParamsSchema = z.object({
  patientId: z.coerce.number().int().positive(),
});

// The receptionist's patient profile: demographics plus everything
// collected at intake. (Forms have their own route in intake.ts.)
patientsRouter.get("/api/patients/:patientId", async (req, res) => {
  const { patientId } = patientParamsSchema.parse(req.params);

  const patient = await pool.query(
    `
    SELECT
      p.patient_id AS "patientId",
      p.first_name AS "firstName",
      p.last_name AS "lastName",
      p.dob,
      p.gender,
      p.phone,
      p.email,
      p.address,
      p.is_active AS "isActive",
      EXISTS (
        SELECT 1 FROM patient_creds c WHERE c.patient_id = p.patient_id AND c.is_active
      ) AS "hasPortalAccount"
    FROM patient p
    WHERE p.patient_id = $1
    `,
    [patientId]
  );
  if (!patient.rowCount) {
    throw new HttpError(404, "Patient not found");
  }

  const [contacts, insurance, primaryDoctor] = await Promise.all([
    pool.query(
      `
      SELECT
        emergency_contact_id AS "emergencyContactId",
        first_name AS "firstName",
        last_name AS "lastName",
        relationship,
        phone_number AS phone,
        is_primary AS "isPrimary"
      FROM emergency_contact
      WHERE patient_id = $1 AND is_active
      ORDER BY is_primary DESC, last_name
      `,
      [patientId]
    ),
    pool.query(
      `SELECT provider, policy_number AS "policyNumber", status FROM insurance WHERE patient_id = $1`,
      [patientId]
    ),
    pool.query(
      `
      SELECT
        pd.doctor_id AS "doctorId",
        'Dr. ' || e.first_name || ' ' || e.last_name AS name,
        pd.assigned_date AS "assignedDate"
      FROM patient_doctor pd
      JOIN employee e ON e.employee_id = pd.doctor_id
      WHERE pd.patient_id = $1 AND pd.is_primary AND pd.is_active
      `,
      [patientId]
    ),
  ]);

  res.json({
    ...patient.rows[0],
    emergencyContacts: contacts.rows,
    insurance: insurance.rows[0] ?? null,
    primaryDoctor: primaryDoctor.rows[0] ?? null,
  });
});

const updatePatientSchema = z.object({
  employeeId: z.number().int().positive(),
  ...demographicsSchema,
});

// Edit demographics (receptionists only). The form always sends every
// field, so this replaces them all.
//
// The portal login's username is the patient's email, so if the email
// changes, the login must change with it — same transaction, so they
// can't end up out of sync.
patientsRouter.put("/api/patients/:patientId", async (req, res) => {
  const { patientId } = patientParamsSchema.parse(req.params);
  const body = updatePatientSchema.parse(req.body);
  await requireStaffType(body.employeeId, "receptionist", "edit patients");

  await withTransaction(async (client) => {
    const result = await client.query(
      `
      UPDATE patient
      SET first_name = $2, last_name = $3, dob = $4, gender = $5, phone = $6, email = $7, address = $8
      WHERE patient_id = $1
      RETURNING patient_id AS "patientId"
      `,
      [patientId, body.firstName, body.lastName, body.dob, body.gender, body.phone, body.email, body.address]
    );
    if (!result.rowCount) {
      throw new HttpError(404, "Patient not found");
    }

    const creds = await client.query(`SELECT 1 FROM patient_creds WHERE patient_id = $1`, [patientId]);
    if (creds.rowCount) {
      if (!body.email) {
        throw new HttpError(400, "This patient has a portal account, so they need an email address");
      }
      await client.query(`UPDATE patient_creds SET username = $2 WHERE patient_id = $1`, [patientId, body.email]);
    }
  });

  res.json({ patientId });
});

const credentialsSchema = z.object({
  employeeId: z.number().int().positive(),
  password: z.string().min(8),
});

// Create a patient-portal login for an existing patient (receptionists
// only). Username = the patient's email, matching patient signup.
// INSERT ... SELECT only inserts if the patient exists and has an email.
patientsRouter.post("/api/patients/:patientId/credentials", async (req, res) => {
  const { patientId } = patientParamsSchema.parse(req.params);
  const body = credentialsSchema.parse(req.body);
  await requireStaffType(body.employeeId, "receptionist", "create portal accounts");

  const result = await pool.query(
    `
    INSERT INTO patient_creds (patient_id, username, password_hash)
    SELECT patient_id, email, $2
    FROM patient
    WHERE patient_id = $1 AND email IS NOT NULL
    RETURNING username
    `,
    [patientId, await hashPassword(body.password)]
  );
  if (!result.rowCount) {
    throw new HttpError(400, "Patient not found, or has no email address to log in with");
  }

  res.status(201).json(result.rows[0]);
});

// One patient_vitals row as the API returns it, shared by the chart and
// the POST so both send the same shape. Column names are renamed to
// camelCase; the decimals are cast to float so they arrive as numbers.
const VITALS_COLUMNS = `
  v.vitals_id AS "vitalsId",
  v.patient_id AS "patientId",
  v.appointment_id AS "appointmentId",
  e.first_name || ' ' || e.last_name AS "recordedBy",
  v.temperature::float AS "temperatureF",
  v.heartrate_bpm AS "heartRateBpm",
  v.systolic_bp AS systolic,
  v.diastolic_bp AS diastolic,
  v.weight_lbs::float AS "weightLbs",
  v.height_inches::float AS "heightInches"
`;

const VITALS_FROM = `
  FROM patient_vitals v
  JOIN employee e ON e.employee_id = v.recorded_by_employee_id
`;

// Everything a nurse needs on one patient's chart, in one request:
// name/DOB, active allergies, vitals (newest first) and current meds.
patientsRouter.get("/api/patients/:patientId/chart", async (req, res) => {
  const { patientId } = patientParamsSchema.parse(req.params);

  const patient = await pool.query(
    `
    SELECT
      patient_id AS "patientId",
      first_name AS "firstName",
      last_name AS "lastName",
      dob,
      gender,
      phone,
      email,
      is_active AS "isActive"
    FROM patient
    WHERE patient_id = $1
    `,
    [patientId]
  );
  if (!patient.rowCount) {
    throw new HttpError(404, "Patient not found");
  }

  // These don't depend on each other, so run them at the same time.
  const [allergies, medications] = await Promise.all([
    pool.query(
      `
      SELECT
        a.allergy_id AS "allergyId",
        t.name AS allergen,
        t.category,
        a.reaction,
        a.severity
      FROM allergy a
      JOIN allergy_type t ON t.allergy_type_id = a.allergy_type_id
      WHERE a.patient_id = $1 AND a.is_active
      ORDER BY CASE a.severity WHEN 'Severe' THEN 1 WHEN 'Moderate' THEN 2 ELSE 3 END, t.name
      `,
      [patientId]
    ),
    // Current meds come from two places: what the patient takes at home
    // (home_medication) and what the clinic prescribed (prescription_item).
    pool.query(
      `
      SELECT
        'Home' AS source,
        hm.home_medication_id AS id,
        hm.medication_name AS name,
        hm.dosage,
        hm.frequency AS directions,
        hm.start_date AS "startDate"
      FROM home_medication hm
      WHERE hm.patient_id = $1 AND hm.is_active

      UNION ALL

      SELECT
        'Prescription',
        pi.prescription_item_id,
        m.name,
        pi.dosage,
        pi.instructions,
        p.date_prescribed
      FROM prescription p
      JOIN prescription_item pi ON pi.prescription_id = p.prescription_id
      JOIN medication m ON m.medication_id = pi.medication_id
      WHERE p.patient_id = $1 AND p.is_active AND pi.is_active

      ORDER BY name
      `,
      [patientId]
    ),
  ]);

  // Newest first: generated ids only ever go up.
  const vitals = await pool.query(
    `
    SELECT ${VITALS_COLUMNS}
    ${VITALS_FROM}
    WHERE v.patient_id = $1
    ORDER BY v.vitals_id DESC
    `,
    [patientId]
  );

  res.json({
    patient: patient.rows[0],
    allergies: allergies.rows,
    vitals: vitals.rows,
    medications: medications.rows,
  });
});

// Record a set of vitals (nurses only).
//
// Every measurement is optional (a nurse may only take some), but at
// least one must be given, and blood pressure needs both numbers or
// neither. The table only checks values are > 0, so zod also rejects
// readings that can't be real (e.g. a heart rate of 900).
const vitalsSchema = z
  .object({
    recordedByEmployeeId: z.number().int().positive(),
    appointmentId: z.number().int().positive().nullable().default(null),
    temperatureF: z.number().min(85).max(115).multipleOf(0.01).nullable().default(null),
    heartRateBpm: z.number().int().min(20).max(300).nullable().default(null),
    systolic: z.number().int().min(50).max(300).nullable().default(null),
    diastolic: z.number().int().min(20).max(200).nullable().default(null),
    weightLbs: z.number().min(1).max(999.99).multipleOf(0.01).nullable().default(null),
    heightInches: z.number().min(10).max(108).multipleOf(0.01).nullable().default(null),
  })
  .refine((v) => (v.systolic === null) === (v.diastolic === null), {
    message: "Enter both blood pressure numbers, or neither",
    path: ["systolic"],
  })
  .refine((v) => v.systolic === null || v.diastolic === null || v.diastolic < v.systolic, {
    message: "Diastolic (bottom number) must be lower than systolic (top number)",
    path: ["diastolic"],
  })
  .refine(
    (v) => [v.temperatureF, v.heartRateBpm, v.systolic, v.weightLbs, v.heightInches].some((x) => x !== null),
    { message: "Enter at least one vital sign" }
  );

patientsRouter.post("/api/patients/:patientId/vitals", async (req, res) => {
  const { patientId } = patientParamsSchema.parse(req.params);
  const body = vitalsSchema.parse(req.body);
  await requireStaffType(body.recordedByEmployeeId, "nurse", "record vitals");

  const patient = await pool.query(`SELECT 1 FROM patient WHERE patient_id = $1`, [patientId]);
  if (!patient.rowCount) {
    throw new HttpError(404, "Patient not found");
  }

  // The foreign key only proves the appointment exists, not that it's
  // *this patient's* appointment, so check that here.
  if (body.appointmentId) {
    const visit = await pool.query(`SELECT 1 FROM appointment WHERE appointment_id = $1 AND patient_id = $2`, [
      body.appointmentId,
      patientId,
    ]);
    if (!visit.rowCount) {
      throw new HttpError(400, "That appointment isn't this patient's");
    }
  }

  // INSERT inside a CTE so the new row can be joined to employee for the
  // nurse's name, giving the same shape as the chart's vitals.
  const result = await pool.query(
    `
    WITH v AS (
      INSERT INTO patient_vitals (
        patient_id, appointment_id, recorded_by_employee_id,
        temperature, heartrate_bpm, systolic_bp, diastolic_bp, weight_lbs, height_inches
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    )
    SELECT ${VITALS_COLUMNS}
    FROM v
    JOIN employee e ON e.employee_id = v.recorded_by_employee_id
    `,
    [
      patientId,
      body.appointmentId,
      body.recordedByEmployeeId,
      body.temperatureF,
      body.heartRateBpm,
      body.systolic,
      body.diastolic,
      body.weightLbs,
      body.heightInches,
    ]
  );

  res.status(201).json(result.rows[0]);
});

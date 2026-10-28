import type { PoolClient } from "pg";
import { z } from "zod";
import { CLINIC_TIME_ZONE } from "../lib/clinicTime.js";
import { pool } from "../lib/db.js";
import { hashPassword } from "../lib/password.js";
import { withTransaction } from "../lib/transaction.js";
import { HttpError } from "../middleware/errorHandler.js";

const required = (label: string, max: number) =>
  z.string(`${label} is required`).trim().min(1, `${label} is required`).max(max, `${label} must be ${max} characters or less`);

// trims text and saves a blank optional field as null
const blankToNull = (value: unknown) => (typeof value === "string" ? value.trim() || null : value);

const optionalText = (label: string, max: number) =>
  z
    .preprocess(blankToNull, z.string().max(max, `${label} must be ${max} characters or less`).nullish())
    .transform((value) => value ?? null);

// patient_creds.username holds the login email and only fits 50 characters
const loginEmail = z.email("Enter a valid email address").trim().toLowerCase().max(50, "Email must be 50 characters or less");

const contactEmail = z
  .preprocess(blankToNull, z.email("Enter a valid email address").toLowerCase().max(100, "Email must be 100 characters or less").nullish())
  .transform((value) => value ?? null);

// phone numbers are digits only, exactly 10
const phone = z.string("Phone is required").trim().regex(/^\d{10}$/, "Phone must be exactly 10 digits");

const newPassword = z.string("Password is required").min(8, "Password must be at least 8 characters");

// today's date at the clinic as YYYY-MM-DD
function clinicToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: CLINIC_TIME_ZONE });
}

const birthDate = z.iso
  .date("Date of birth must be a valid date")
  .refine((value) => value >= "1900-01-01" && value <= clinicToday(), "Date of birth can't be in the future or before 1900");

// the same rules for online sign up and front desk registration
export const patientSchema = z.object({
  firstName: required("First name", 50),
  lastName: required("Last name", 50),
  dob: birthDate,
  phone,
  email: contactEmail,
  gender: optionalText("Gender", 20),
  address: optionalText("Address", 200),
});

export const signupSchema = patientSchema.extend({ email: loginEmail, password: newPassword });

export const portalLoginSchema = z.object({ email: loginEmail, password: newPassword });

export const contactInfoSchema = z.object({
  phone,
  address: optionalText("Address", 200),
  gender: optionalText("Gender", 20),
});

// patients change their login email along with their contact info
export const patientContactSchema = contactInfoSchema.extend({ email: loginEmail });

export const emergencyContactSchema = z.object({
  firstName: required("First name", 50),
  lastName: required("Last name", 50),
  relationship: required("Relationship", 50),
  phoneNumber: phone,
  isPrimary: z.boolean().default(false),
});

export const insuranceSchema = z.object({
  provider: required("Provider", 100),
  policyNumber: required("Policy number", 50),
});

// only staff set these, since a patient's own changes always go back to Pending
// staff send back the provider and policy number they reviewed, so a newer change can't be approved by mistake
export const insuranceStatusSchema = insuranceSchema.extend({
  status: z.enum(["Verified", "Denied"], "Status must be Verified or Denied"),
});

type PatientInput = z.infer<typeof patientSchema>;
type ContactInfo = z.infer<typeof contactInfoSchema>;
type EmergencyContact = z.infer<typeof emergencyContactSchema>;
type Insurance = z.infer<typeof insuranceSchema>;

// one answer for a taken email and for a likely existing record, so sign up can't show who is a patient here
export const SIGNUP_CONFLICT =
  "We couldn't create an account with these details. If you already have one, sign in instead. If you've visited the clinic before, the front desk can set up your portal login.";

const EMAIL_TAKEN = "This email is already used by another account";
const HAS_LOGIN = "This patient already has a portal login";
const POLICY_TAKEN = "This policy number is already registered to another patient";

const PATIENT_COLUMNS = `
  p.patient_id AS "patientId",
  p.first_name AS "firstName",
  p.last_name AS "lastName",
  to_char(p.dob, 'YYYY-MM-DD') AS dob,
  p.gender,
  p.phone,
  p.email,
  p.address,
  p.is_active AS "isActive"
`;

// just enough for a receptionist to tell patients apart, while contact details stay in the patient view
const DIRECTORY_COLUMNS = `
  p.patient_id AS "patientId",
  p.first_name AS "firstName",
  p.last_name AS "lastName",
  to_char(p.dob, 'YYYY-MM-DD') AS dob,
  p.is_active AS "isActive"
`;

const CONTACT_COLUMNS = `
  emergency_contact_id AS "emergencyContactId",
  first_name AS "firstName",
  last_name AS "lastName",
  relationship,
  phone_number AS "phoneNumber",
  is_primary AS "isPrimary"
`;

const INSURANCE_COLUMNS = `provider, policy_number AS "policyNumber", status`;

function isUniqueViolation(err: unknown, constraint: string) {
  const { code, constraint: name } = err as { code?: string; constraint?: string };
  return code === "23505" && name === constraint;
}

// registrations for the same person wait for each other, so neither misses the record the other is adding
async function lockIdentity(client: PoolClient, patient: PatientInput) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('patient identity'), hashtext(lower($1) || '|' || lower($2) || '|' || $3))`, [
    patient.firstName,
    patient.lastName,
    patient.dob,
  ]);
}

// the same for two logins being set up with one email
async function lockLoginEmail(client: PoolClient, email: string) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('patient login'), hashtext($1))`, [email]);
}

// locks the patient so their contact changes happen one at a time
async function lockPatient(client: PoolClient, patientId: number) {
  const result = await client.query(`SELECT is_active AS "isActive" FROM patient WHERE patient_id = $1 FOR NO KEY UPDATE`, [patientId]);
  if (!result.rowCount) throw new HttpError(404, "Patient not found");
  return result.rows[0] as { isActive: boolean };
}

async function loginEmailTaken(client: PoolClient, email: string, patientId = 0) {
  const result = await client.query(`SELECT 1 FROM patient_creds WHERE LOWER(username) = $1 AND patient_id <> $2`, [email, patientId]);
  return !!result.rowCount;
}

// same name and date of birth, ignoring case and spaces, which only suggests it's the same person
async function findMatches(client: PoolClient, patient: PatientInput) {
  const result = await client.query(
    `
    SELECT ${DIRECTORY_COLUMNS}
    FROM patient p
    WHERE lower(btrim(p.first_name)) = lower($1) AND lower(btrim(p.last_name)) = lower($2) AND p.dob = $3
    ORDER BY p.patient_id
    `,
    [patient.firstName, patient.lastName, patient.dob]
  );
  return result.rows;
}

async function insertPatient(client: PoolClient, patient: PatientInput) {
  const result = await client.query(
    `
    INSERT INTO patient AS p (first_name, last_name, dob, gender, phone, email, address)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING ${PATIENT_COLUMNS}
    `,
    [patient.firstName, patient.lastName, patient.dob, patient.gender, patient.phone, patient.email, patient.address]
  );
  return result.rows[0];
}

export async function listPatients() {
  const result = await pool.query(`SELECT ${DIRECTORY_COLUMNS} FROM patient p ORDER BY p.patient_id`);
  return result.rows;
}

// online sign up creates the patient and their login together
export async function signUpPatient(input: z.infer<typeof signupSchema>) {
  const passwordHash = await hashPassword(input.password);
  try {
    return await withTransaction(async (client) => {
      await lockIdentity(client, input);
      await lockLoginEmail(client, input.email);
      if ((await loginEmailTaken(client, input.email)) || (await findMatches(client, input)).length) {
        throw new HttpError(409, SIGNUP_CONFLICT);
      }

      const patient = await insertPatient(client, input);
      await client.query(`INSERT INTO patient_creds (patient_id, username, password_hash) VALUES ($1, $2, $3)`, [
        patient.patientId,
        input.email,
        passwordHash,
      ]);
      return patient;
    });
  } catch (err) {
    if (isUniqueViolation(err, "patient_creds_username_key")) throw new HttpError(409, SIGNUP_CONFLICT);
    throw err;
  }
}

// the front desk sees likely matches first, and can still add the patient once they've checked it's someone else
export async function registerAtFrontDesk(patient: PatientInput, confirmedNewPatient: boolean) {
  return withTransaction(async (client) => {
    await lockIdentity(client, patient);
    const matches = await findMatches(client, patient);
    if (matches.length && !confirmedNewPatient) return { matches };
    return { patient: await insertPatient(client, patient) };
  });
}

// a portal login for a patient who already has a record, so they keep their patient ID
// staff check the patient's photo ID first, because matching details on file don't prove who someone is
export async function createPortalLogin(patientId: number, login: z.infer<typeof portalLoginSchema>) {
  const passwordHash = await hashPassword(login.password);
  try {
    await withTransaction(async (client) => {
      await lockLoginEmail(client, login.email);
      const patient = await lockPatient(client, patientId);
      if (!patient.isActive) throw new HttpError(409, "This patient account is inactive");

      const existing = await client.query(`SELECT 1 FROM patient_creds WHERE patient_id = $1`, [patientId]);
      if (existing.rowCount) throw new HttpError(409, HAS_LOGIN);
      if (await loginEmailTaken(client, login.email, patientId)) throw new HttpError(409, EMAIL_TAKEN);

      await client.query(`INSERT INTO patient_creds (patient_id, username, password_hash) VALUES ($1, $2, $3)`, [
        patientId,
        login.email,
        passwordHash,
      ]);
      // the login email is also the contact email, the same as a profile update
      await client.query(`UPDATE patient SET email = $1 WHERE patient_id = $2`, [login.email, patientId]);
    });
  } catch (err) {
    if (isUniqueViolation(err, "patient_creds_patient_id_key")) throw new HttpError(409, HAS_LOGIN);
    if (isUniqueViolation(err, "patient_creds_username_key")) throw new HttpError(409, EMAIL_TAKEN);
    throw err;
  }
  return { patientId, email: login.email };
}

// the patient and their login turn on and off together, and their appointments are left for staff to handle
export async function setPatientActive(patientId: number, isActive: boolean) {
  return withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE patient SET is_active = $1 WHERE patient_id = $2 RETURNING patient_id AS "patientId", is_active AS "isActive"`,
      [isActive, patientId]
    );
    if (!updated.rowCount) throw new HttpError(404, "Patient not found");

    await client.query(`UPDATE patient_creds SET is_active = $1 WHERE patient_id = $2`, [isActive, patientId]);
    return updated.rows[0];
  });
}

export async function getPatientProfile(patientId: number) {
  const patient = await pool.query(
    `
    SELECT ${PATIENT_COLUMNS}, EXISTS (SELECT 1 FROM patient_creds c WHERE c.patient_id = p.patient_id) AS "hasLogin"
    FROM patient p
    WHERE p.patient_id = $1
    `,
    [patientId]
  );
  if (!patient.rowCount) return null;

  const contacts = await pool.query(
    `SELECT ${CONTACT_COLUMNS} FROM emergency_contact WHERE patient_id = $1 AND is_active ORDER BY is_primary DESC, emergency_contact_id`,
    [patientId]
  );
  const insurance = await pool.query(`SELECT ${INSURANCE_COLUMNS} FROM insurance WHERE patient_id = $1`, [patientId]);

  return { ...patient.rows[0], emergencyContacts: contacts.rows, insurance: insurance.rows[0] ?? null };
}

// a new email also changes the patient's login, and the front desk never changes the email
export async function updateContactInfo(patientId: number, info: ContactInfo & { email?: string }) {
  try {
    return await withTransaction(async (client) => {
      if (info.email) {
        await lockLoginEmail(client, info.email);
        if (await loginEmailTaken(client, info.email, patientId)) throw new HttpError(409, EMAIL_TAKEN);
      }

      const updated = await client.query(
        `
        UPDATE patient p
        SET phone = $1, address = $2, gender = $3, email = COALESCE($4, p.email)
        WHERE p.patient_id = $5
        RETURNING p.patient_id AS "patientId", p.phone, p.email, p.address, p.gender
        `,
        [info.phone, info.address, info.gender, info.email ?? null, patientId]
      );
      if (!updated.rowCount) throw new HttpError(404, "Patient not found");

      if (info.email) await client.query(`UPDATE patient_creds SET username = $1 WHERE patient_id = $2`, [info.email, patientId]);
      return updated.rows[0];
    });
  } catch (err) {
    if (isUniqueViolation(err, "patient_creds_username_key")) throw new HttpError(409, EMAIL_TAKEN);
    throw err;
  }
}

// a new primary contact takes primary off the patient's other contacts
export async function addEmergencyContact(patientId: number, contact: EmergencyContact) {
  return withTransaction(async (client) => {
    await lockPatient(client, patientId);
    if (contact.isPrimary) {
      await client.query(`UPDATE emergency_contact SET is_primary = false WHERE patient_id = $1 AND is_primary`, [patientId]);
    }

    const inserted = await client.query(
      `
      INSERT INTO emergency_contact (patient_id, first_name, last_name, relationship, phone_number, is_primary)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING ${CONTACT_COLUMNS}
      `,
      [patientId, contact.firstName, contact.lastName, contact.relationship, contact.phoneNumber, contact.isPrimary]
    );
    return inserted.rows[0];
  });
}

// only the patient's own active contacts can be changed, and a missing one changes nothing
export async function updateEmergencyContact(patientId: number, contactId: number, contact: EmergencyContact) {
  return withTransaction(async (client) => {
    await lockPatient(client, patientId);
    if (contact.isPrimary) {
      await client.query(
        `UPDATE emergency_contact SET is_primary = false WHERE patient_id = $1 AND emergency_contact_id <> $2 AND is_primary`,
        [patientId, contactId]
      );
    }

    const updated = await client.query(
      `
      UPDATE emergency_contact
      SET first_name = $1, last_name = $2, relationship = $3, phone_number = $4, is_primary = $5
      WHERE emergency_contact_id = $6 AND patient_id = $7 AND is_active
      RETURNING ${CONTACT_COLUMNS}
      `,
      [contact.firstName, contact.lastName, contact.relationship, contact.phoneNumber, contact.isPrimary, contactId, patientId]
    );
    if (!updated.rowCount) throw new HttpError(404, "Emergency contact not found");
    return updated.rows[0];
  });
}

// contacts are deactivated rather than deleted
export async function removeEmergencyContact(patientId: number, contactId: number) {
  const updated = await pool.query(
    `UPDATE emergency_contact SET is_active = false, is_primary = false WHERE emergency_contact_id = $1 AND patient_id = $2`,
    [contactId, patientId]
  );
  if (!updated.rowCount) throw new HttpError(404, "Emergency contact not found");
}

// new or changed insurance always goes back to Pending until staff check it
export async function saveInsurance(patientId: number, insurance: Insurance) {
  try {
    return await withTransaction(async (client) => {
      await lockPatient(client, patientId);
      const taken = await client.query(`SELECT 1 FROM insurance WHERE policy_number = $1 AND patient_id <> $2`, [
        insurance.policyNumber,
        patientId,
      ]);
      if (taken.rowCount) throw new HttpError(409, POLICY_TAKEN);

      const saved = await client.query(
        `
        INSERT INTO insurance (patient_id, provider, policy_number, status)
        VALUES ($1, $2, $3, 'Pending')
        ON CONFLICT (patient_id) DO UPDATE
        SET provider = EXCLUDED.provider, policy_number = EXCLUDED.policy_number, status = 'Pending'
        RETURNING ${INSURANCE_COLUMNS}
        `,
        [patientId, insurance.provider, insurance.policyNumber]
      );
      return saved.rows[0];
    });
  } catch (err) {
    if (isUniqueViolation(err, "insurance_policy_number_key")) throw new HttpError(409, POLICY_TAKEN);
    throw err;
  }
}

// one conditional update, so a change that commits first makes it match nothing instead of being approved
// verifying pays the patient's unpaid invoices with this insurance (migration 013),
// so the billing triggers need to know which employee did it
export async function setInsuranceStatus(patientId: number, review: z.infer<typeof insuranceStatusSchema>, employeeId: number) {
  const updated = await withTransaction(async (client) => {
    await client.query(`SELECT set_config('app.employee_id', $1, true)`, [String(employeeId)]);
    return client.query(
      `UPDATE insurance SET status = $1 WHERE patient_id = $2 AND provider = $3 AND policy_number = $4 RETURNING ${INSURANCE_COLUMNS}`,
      [review.status, patientId, review.provider, review.policyNumber]
    );
  });
  if (updated.rowCount) return updated.rows[0];

  const current = await pool.query(`SELECT 1 FROM insurance WHERE patient_id = $1`, [patientId]);
  if (!current.rowCount) throw new HttpError(404, "This patient has no insurance on file");
  throw new HttpError(409, "This patient's insurance changed. Review it again before verifying.");
}
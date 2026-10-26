import { Router } from "express";
import { CLINIC_TODAY } from "../../lib/clinicTime.js";
import { pool } from "../../lib/db.js";
import { withTransaction } from "../../lib/transaction.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { getOutstandingBalance } from "../../services/billing.js";
import {
  addEmergencyContact,
  contactInfoSchema,
  createPortalLogin,
  emergencyContactSchema,
  getPatientProfile,
  insuranceSchema,
  insuranceStatusSchema,
  portalLoginSchema,
  saveInsurance,
  setInsuranceStatus,
  updateContactInfo,
} from "../../services/patients.js";

export const receptionistPatientsRouter = Router();

// get the front desk view of one patient
receptionistPatientsRouter.get("/api/receptionist/patients/:id", async (req, res) => {
  const patientId = Number(req.params.id);

  if (!patientId) {
    res.status(400).json({ error: "Invalid patient" });
    return;
  }

  // get the patient's info, whether they have a login, their insurance and their active emergency contacts
  const patient = await getPatientProfile(patientId);
  if (!patient) {
    res.status(404).json({ error: "Patient not found" });
    return;
  }

  // get every active form and whether the patient completed it
  const forms = await pool.query(
    `
    SELECT
      f.form_type_id AS "formTypeId",
      f.name,
      f.is_required AS "isRequired",
      done.submitted_date IS NOT NULL AS completed,
      to_char(done.submitted_date, 'YYYY-MM-DD') AS "completedDate"
    FROM form_type f
    LEFT JOIN LATERAL (
      SELECT s.submitted_date
      FROM form_submission s
      WHERE s.form_type_id = f.form_type_id AND s.patient_id = $1 AND s.status = 'Completed'
      ORDER BY s.submitted_date DESC
      LIMIT 1
    ) done ON true
    WHERE f.is_active
    ORDER BY f.form_type_id
    `,
    [patientId]
  );

  // get the patient's 10 newest appointments at any office
  const appointments = await pool.query(
    `
    SELECT
      a.appointment_id AS "appointmentId",
      to_char(a.appointment_date, 'YYYY-MM-DD') AS "date",
      to_char(ts.start_time, 'HH24:MI') AS "startTime",
      to_char(ts.end_time, 'HH24:MI') AS "endTime",
      e.first_name || ' ' || e.last_name AS "doctorName",
      o.name AS "officeName",
      sp.name AS "specialty",
      a.status
    FROM appointment a
    JOIN time_slot ts ON ts.time_slot_id = a.time_slot_id
    JOIN employee e ON e.employee_id = a.doctor_id
    JOIN office o ON o.office_id = a.office_id
    JOIN specialty sp ON sp.specialty_id = a.specialty_id
    WHERE a.patient_id = $1
    ORDER BY a.appointment_date DESC, ts.start_time DESC, a.appointment_id DESC
    LIMIT 10
    `,
    [patientId]
  );

  // get what the patient still owes, the same balance the patient and Admin see
  const balance = await getOutstandingBalance(patientId);

  res.json({
    ...patient,
    forms: forms.rows,
    appointments: appointments.rows,
    balance,
  });
});

// update the patient's contact info (email is their login, so it stays)
receptionistPatientsRouter.patch("/api/receptionist/patients/:id", async (req, res) => {
  const patientId = Number(req.params.id);
  const info = contactInfoSchema.parse(req.body);

  // save the patient's phone, address and gender (empty saved as null)
  res.json(await updateContactInfo(patientId, info));
});

// add or change the patient's insurance (it goes back to Pending)
receptionistPatientsRouter.put("/api/receptionist/patients/:id/insurance", async (req, res) => {
  const patientId = Number(req.params.id);
  const insurance = insuranceSchema.parse(req.body);

  // a policy number that belongs to another patient is turned away
  res.json(await saveInsurance(patientId, insurance));
});

// verify or deny the patient's insurance
receptionistPatientsRouter.patch("/api/receptionist/patients/:id/insurance/status", async (req, res) => {
  const patientId = Number(req.params.id);
  const review = insuranceStatusSchema.parse(req.body);
  if (!req.user || req.user.role === "patient") throw new HttpError(401, "Login required");

  // verifying also pays the patient's unpaid invoices with this insurance
  res.json(await setInsuranceStatus(patientId, review, req.user.employeeId));
});

// add an emergency contact
receptionistPatientsRouter.post("/api/receptionist/patients/:id/emergency-contacts", async (req, res) => {
  const patientId = Number(req.params.id);
  const contact = emergencyContactSchema.parse(req.body);

  // save the contact and the primary flag together
  res.status(201).json(await addEmergencyContact(patientId, contact));
});

// mark a paper form the patient signed at the desk as completed
receptionistPatientsRouter.post("/api/receptionist/patients/:id/forms/:formTypeId/complete", async (req, res) => {
  const patientId = Number(req.params.id);
  const formTypeId = Number(req.params.formTypeId);

  const submission = await withTransaction(async (client) => {
    // one at a time per patient, so a double click can't save the form twice
    const patient = await client.query(`SELECT 1 FROM patient WHERE patient_id = $1 FOR NO KEY UPDATE`, [patientId]);
    if (patient.rowCount === 0) throw new HttpError(404, "Patient not found");

    // check the patient hasn't completed this form already
    const done = await client.query(
      `SELECT 1 FROM form_submission WHERE patient_id = $1 AND form_type_id = $2 AND status = 'Completed'`,
      [patientId, formTypeId]
    );
    if (done.rowCount !== 0) throw new HttpError(400, "This form is already completed");

    // save a completed submission dated today (only for an active form)
    const result = await client.query(
      `
      INSERT INTO form_submission (patient_id, form_type_id, status, submitted_date)
      SELECT $1, form_type_id, 'Completed', ${CLINIC_TODAY}
      FROM form_type
      WHERE form_type_id = $2 AND is_active
      RETURNING
        form_submission_id AS "formSubmissionId",
        form_type_id AS "formTypeId",
        status,
        to_char(submitted_date, 'YYYY-MM-DD') AS "submittedDate"
      `,
      [patientId, formTypeId]
    );
    if (result.rowCount === 0) throw new HttpError(404, "Form not found");
    return result.rows[0];
  });

  res.status(201).json(submission);
});

// set up a portal login for a patient who registered at the desk, after checking their photo ID
receptionistPatientsRouter.post("/api/receptionist/patients/:id/login", async (req, res) => {
  const patientId = Number(req.params.id);
  const login = portalLoginSchema.parse(req.body);

  res.status(201).json(await createPortalLogin(patientId, login));
});
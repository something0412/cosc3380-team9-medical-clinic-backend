import { Router } from "express";
import { pool } from "../../lib/db.js";

export const doctorPatientsRouter = Router();

// get my patients (assigned, booked, referred to me, or I ordered labs for)
doctorPatientsRouter.get("/api/doctor/patients", async (req, res) => {
  const doctorId = req.session.employeeId;
  const search = String(req.query.search ?? "").trim();

  // get the doctor's patients, matching the searched name
  const result = await pool.query(
    ``,
    [doctorId, search]
  );

  res.json(result.rows);
});

// get one patient's chart
doctorPatientsRouter.get("/api/doctor/patients/:id", async (req, res) => {
  const doctorId = req.session.employeeId;
  const patientId = Number(req.params.id);

  // check this is one of the doctor's patients
  const access = await pool.query(
    ``,
    [doctorId, patientId]
  );
  if (access.rowCount === 0) {
    res.status(403).json({ error: "This patient isn't under your care" });
    return;
  }

  // get the patient's basic info
  const patient = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's allergies
  const allergies = await pool.query(
    ``,
    [patientId]
  );

  // get the medicines the patient takes at home
  const homeMedications = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's last 10 vitals, marked normal, abnormal or critical
  const vitals = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's past and upcoming visits
  const visits = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's lab orders
  const labOrders = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's current prescriptions
  const prescriptions = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's insurance
  const insurance = await pool.query(
    ``,
    [patientId]
  );

  // get the required forms the patient still hasn't filled out
  const missingForms = await pool.query(
    ``,
    [patientId]
  );

  res.json({
    ...patient.rows[0],
    insurance: insurance.rows[0] ?? null,
    missingForms: missingForms.rows.map((f) => f.name),
    allergies: allergies.rows,
    homeMedications: homeMedications.rows,
    vitals: vitals.rows,
    visits: visits.rows,
    labOrders: labOrders.rows,
    prescriptions: prescriptions.rows,
  });
});

// get allergy types for the allergy form
doctorPatientsRouter.get("/api/doctor/allergy-types", async (_req, res) => {
  // get the list of allergy types
  const result = await pool.query(``);

  res.json(result.rows);
});

// add an allergy to a patient
doctorPatientsRouter.post("/api/doctor/patients/:id/allergies", async (req, res) => {
  const doctorId = req.session.employeeId;
  const patientId = Number(req.params.id);
  const allergyTypeId = Number(req.body.allergyTypeId);
  const reaction = String(req.body.reaction ?? "").trim();
  const severity = req.body.severity;

  if (!allergyTypeId || !["Mild", "Moderate", "Severe"].includes(severity)) {
    res.status(400).json({ error: "Allergy and severity are required" });
    return;
  }

  // check this is one of the doctor's patients
  const access = await pool.query(
    ``,
    [doctorId, patientId]
  );
  if (access.rowCount === 0) {
    res.status(403).json({ error: "This patient isn't under your care" });
    return;
  }

  // save the allergy, or turn it back on if it was removed before
  const result = await pool.query(
    ``,
    [patientId, allergyTypeId, reaction || null, severity]
  );

  res.status(201).json(result.rows[0]);
});

// remove an allergy (kept in the database as inactive)
doctorPatientsRouter.patch("/api/doctor/allergies/:id/remove", async (req, res) => {
  const doctorId = req.session.employeeId;
  const allergyId = Number(req.params.id);

  // remove one of the patient's allergies
  const result = await pool.query(
    ``,
    [allergyId, doctorId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Allergy not found for your patients" });
    return;
  }

  res.json(result.rows[0]);
});

// add a medication the patient takes at home
doctorPatientsRouter.post("/api/doctor/patients/:id/home-medications", async (req, res) => {
  const doctorId = req.session.employeeId;
  const patientId = Number(req.params.id);
  const medicationId = req.body.medicationId ? Number(req.body.medicationId) : null;
  const medicationName = String(req.body.medicationName ?? "").trim();
  const category = req.body.category || null;
  const dosage = String(req.body.dosage ?? "").trim();
  const frequency = String(req.body.frequency ?? "").trim();

  if (!medicationId && !medicationName) {
    res.status(400).json({ error: "Choose a medication or type its name" });
    return;
  }
  if (category && !["Prescription", "OTC", "Supplement"].includes(category)) {
    res.status(400).json({ error: "Category must be Prescription, OTC, or Supplement" });
    return;
  }

  // check this is one of the doctor's patients
  const access = await pool.query(
    ``,
    [doctorId, patientId]
  );
  if (access.rowCount === 0) {
    res.status(403).json({ error: "This patient isn't under your care" });
    return;
  }

  // save the medicine the patient takes at home
  const result = await pool.query(
    ``,
    [patientId, medicationId, medicationName, category, dosage || null, frequency || null]
  );

  res.status(201).json(result.rows[0]);
});

// stop a home medication (kept in the database as inactive)
doctorPatientsRouter.patch("/api/doctor/home-medications/:id/stop", async (req, res) => {
  const doctorId = req.session.employeeId;
  const homeMedicationId = Number(req.params.id);

  // stop one of the patient's home medicines
  const result = await pool.query(
    ``,
    [homeMedicationId, doctorId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Medication not found for your patients" });
    return;
  }

  res.json(result.rows[0]);
});

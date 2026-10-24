import { Router } from "express";
import { pool } from "../../lib/db.js";

export const nursePatientsRouter = Router();

// get patients seen at my office (name search)
nursePatientsRouter.get("/api/nurse/patients", async (req, res) => {
  const nurseId = req.session.employeeId;
  const search = String(req.query.search ?? "").trim();

  // get patients with an appointment at my office matching the name, with their last completed visit here
  const result = await pool.query(
    ``,
    [nurseId, search]
  );

  res.json(result.rows);
});

// get one patient's chart (read-only except allergies and home meds)
nursePatientsRouter.get("/api/nurse/patients/:id", async (req, res) => {
  const nurseId = req.session.employeeId;
  const patientId = Number(req.params.id);

  // check the patient has an appointment at my office
  const access = await pool.query(
    ``,
    [patientId, nurseId]
  );
  if (access.rowCount === 0) {
    res.status(403).json({ error: "This patient hasn't been seen at your office" });
    return;
  }

  // get the patient's basic info
  const patient = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's active allergies
  const allergies = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's active home medications
  const homeMedications = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's last 10 vitals, newest first, with abnormal/critical flags
  const vitals = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's active prescriptions, newest first
  const prescriptions = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's lab orders, newest first
  const labOrders = await pool.query(
    ``,
    [patientId]
  );

  // get the patient's last 20 visits with reason and diagnoses, newest first
  const visits = await pool.query(
    ``,
    [patientId]
  );

  res.json({
    ...patient.rows[0],
    allergies: allergies.rows,
    homeMedications: homeMedications.rows,
    vitals: vitals.rows,
    prescriptions: prescriptions.rows,
    labOrders: labOrders.rows,
    visits: visits.rows,
  });
});

// get allergy types for the add-allergy dropdown
nursePatientsRouter.get("/api/nurse/allergy-types", async (_req, res) => {
  // get all active allergy types, sorted by name
  const result = await pool.query(``);

  res.json(result.rows);
});

// get medications for the add-home-medication dropdown
nursePatientsRouter.get("/api/nurse/medications", async (_req, res) => {
  // get all active medications, sorted by name
  const result = await pool.query(``);

  res.json(result.rows);
});

// add an allergy
nursePatientsRouter.post("/api/nurse/patients/:id/allergies", async (req, res) => {
  const nurseId = req.session.employeeId;
  const patientId = Number(req.params.id);
  const allergyTypeId = Number(req.body.allergyTypeId);
  const reaction = String(req.body.reaction ?? "").trim();
  const severity = req.body.severity;

  if (!allergyTypeId || !["Mild", "Moderate", "Severe"].includes(severity)) {
    res.status(400).json({ error: "Allergy and severity are required" });
    return;
  }

  // check the patient has an appointment at my office
  const access = await pool.query(
    ``,
    [patientId, nurseId]
  );
  if (access.rowCount === 0) {
    res.status(403).json({ error: "This patient hasn't been seen at your office" });
    return;
  }

  // save the allergy (if the patient already had it, update it and turn it back on)
  const result = await pool.query(
    ``,
    [patientId, allergyTypeId, reaction || null, severity]
  );

  res.status(201).json(result.rows[0]);
});

// remove an allergy
nursePatientsRouter.patch("/api/nurse/allergies/:id/remove", async (req, res) => {
  const nurseId = req.session.employeeId;
  const allergyId = Number(req.params.id);

  // turn the allergy off, only for a patient seen at my office
  const result = await pool.query(
    ``,
    [allergyId, nurseId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Allergy not found for your office's patients" });
    return;
  }

  res.json(result.rows[0]);
});

// add a home medication
nursePatientsRouter.post("/api/nurse/patients/:id/home-medications", async (req, res) => {
  const nurseId = req.session.employeeId;
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

  // check the patient has an appointment at my office
  const access = await pool.query(
    ``,
    [patientId, nurseId]
  );
  if (access.rowCount === 0) {
    res.status(403).json({ error: "This patient hasn't been seen at your office" });
    return;
  }

  // save the home medication (use the medication's name when one was picked, otherwise the typed name)
  const result = await pool.query(
    ``,
    [patientId, medicationId, medicationName, category, dosage || null, frequency || null]
  );

  res.status(201).json(result.rows[0]);
});

// stop a home medication
nursePatientsRouter.patch("/api/nurse/home-medications/:id/stop", async (req, res) => {
  const nurseId = req.session.employeeId;
  const homeMedicationId = Number(req.params.id);

  // turn the home medication off, only for a patient seen at my office
  const result = await pool.query(
    ``,
    [homeMedicationId, nurseId]
  );

  if (result.rowCount === 0) {
    res.status(400).json({ error: "Medication not found for your office's patients" });
    return;
  }

  res.json(result.rows[0]);
});

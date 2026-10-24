import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { pool } from "../../lib/db.js";
import { HttpError } from "../../middleware/errorHandler.js";
import { assertDoctorCanSeePatient, getPatientChart, listDoctorPatients } from "../../services/clinical.js";

export const doctorPatientsRouter = Router();

const idParam = z.coerce.number("Choose a patient").int("Choose a patient").positive("Choose a patient");

function me(req: Request) {
  if (req.user?.role !== "doctor") throw new HttpError(401, "Login required");
  return req.user.employeeId;
}

// get my patients (assigned to me or with a booked or finished visit)
doctorPatientsRouter.get("/api/doctor/patients", async (req, res) => {
  const { search } = z.object({ search: z.string().trim().max(100).default("") }).parse(req.query);
  res.json(await listDoctorPatients(me(req), search));
});

// get one patient's chart
doctorPatientsRouter.get("/api/doctor/patients/:id", async (req, res) => {
  const doctorId = me(req);
  const patientId = idParam.parse(req.params.id);
  await assertDoctorCanSeePatient(doctorId, patientId);
  res.json(await getPatientChart(patientId, doctorId));
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

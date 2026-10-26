import { Router } from "express";
import { z } from "zod";
import {
  addAllergy,
  addHomeMedication,
  asClinician,
  listAllergyTypes,
  listMedications,
  removeAllergy,
  stopHomeMedication,
  updateAllergy,
  updateHomeMedication,
} from "../services/clinical.js";

// allergies and home medications work the same for doctors and nurses, so both portals use these handlers
export const clinicalRecordsRouter = Router();

const id = (label: string) => z.coerce.number(`Choose ${label}`).int(`Choose ${label}`).positive(`Choose ${label}`);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .nullish()
    .transform((value) => value || null);

const severity = z.enum(["Mild", "Moderate", "Severe"], "Severity must be Mild, Moderate or Severe");
const category = z.enum(["Prescription", "OTC", "Supplement"], "Category must be Prescription, OTC or Supplement").nullish();

const allergyBody = z.object({ allergyTypeId: id("an allergy"), reaction: optionalText(200), severity });
const allergyChanges = z
  .object({ reaction: optionalText(200).optional(), severity: severity.optional() })
  .refine((body) => body.reaction !== undefined || body.severity !== undefined, "Send a reaction or severity");

const homeMedicationFields = { category, dosage: optionalText(50), frequency: optionalText(50) };
const homeMedicationBody = z
  .object({ medicationId: id("a medication").nullish(), medicationName: optionalText(100), ...homeMedicationFields })
  .refine((body) => body.medicationId || body.medicationName, "Choose a medication or type its name");
const homeMedicationChanges = z
  .object({ category: category.optional(), dosage: optionalText(50).optional(), frequency: optionalText(50).optional() })
  .refine((body) => Object.values(body).some((value) => value !== undefined), "Send a category, dosage or frequency");

for (const role of ["doctor", "nurse"] as const) {
  const base = `/api/${role}`;

  // get allergy types for the allergy form
  clinicalRecordsRouter.get(`${base}/allergy-types`, async (_req, res) => {
    res.json(await listAllergyTypes());
  });

  // get medications for the prescription and home medication forms
  clinicalRecordsRouter.get(`${base}/medications`, async (_req, res) => {
    res.json(await listMedications());
  });

  // add an allergy to a patient
  clinicalRecordsRouter.post(`${base}/patients/:id/allergies`, async (req, res) => {
    const patientId = id("a patient").parse(req.params.id);
    res.status(201).json(await addAllergy(asClinician(req.user, role), patientId, allergyBody.parse(req.body)));
  });

  // change an allergy's reaction or severity
  clinicalRecordsRouter.patch(`${base}/allergies/:id`, async (req, res) => {
    const allergyId = id("an allergy").parse(req.params.id);
    res.json(await updateAllergy(asClinician(req.user, role), allergyId, allergyChanges.parse(req.body)));
  });

  // remove an allergy (kept in the database as inactive)
  clinicalRecordsRouter.patch(`${base}/allergies/:id/remove`, async (req, res) => {
    res.json(await removeAllergy(asClinician(req.user, role), id("an allergy").parse(req.params.id)));
  });

  // add a medication the patient takes at home
  clinicalRecordsRouter.post(`${base}/patients/:id/home-medications`, async (req, res) => {
    const patientId = id("a patient").parse(req.params.id);
    res.status(201).json(await addHomeMedication(asClinician(req.user, role), patientId, homeMedicationBody.parse(req.body)));
  });

  // change a home medication's category, dosage or frequency
  clinicalRecordsRouter.patch(`${base}/home-medications/:id`, async (req, res) => {
    const homeMedicationId = id("a home medication").parse(req.params.id);
    res.json(await updateHomeMedication(asClinician(req.user, role), homeMedicationId, homeMedicationChanges.parse(req.body)));
  });

  // stop a home medication (kept in the database as inactive)
  clinicalRecordsRouter.patch(`${base}/home-medications/:id/stop`, async (req, res) => {
    res.json(await stopHomeMedication(asClinician(req.user, role), id("a home medication").parse(req.params.id)));
  });
}

import { Router } from "express";
import { z } from "zod";
import { asClinician, assertCanSeePatient, getPatientChart, listPatientsInCare } from "../../services/clinical.js";

export const nursePatientsRouter = Router();

const idParam = z.coerce.number("Choose a patient").int("Choose a patient").positive("Choose a patient");

// get the patients with a visit at my office today (name search)
nursePatientsRouter.get("/api/nurse/patients", async (req, res) => {
  const { search } = z.object({ search: z.string().trim().max(100).default("") }).parse(req.query);
  res.json(await listPatientsInCare(asClinician(req.user, "nurse"), search));
});

// get one patient's chart
nursePatientsRouter.get("/api/nurse/patients/:id", async (req, res) => {
  const nurse = asClinician(req.user, "nurse");
  const patientId = idParam.parse(req.params.id);
  await assertCanSeePatient(nurse, patientId);
  res.json(await getPatientChart(patientId, nurse));
});

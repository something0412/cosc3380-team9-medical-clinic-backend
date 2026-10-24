import { Router } from "express";
import { z } from "zod";
import { asClinician, assertCanSeePatient, getPatientChart, listPatientsInCare } from "../../services/clinical.js";

export const doctorPatientsRouter = Router();

const idParam = z.coerce.number("Choose a patient").int("Choose a patient").positive("Choose a patient");

// get my patients (assigned to me or with a booked or finished visit)
doctorPatientsRouter.get("/api/doctor/patients", async (req, res) => {
  const { search } = z.object({ search: z.string().trim().max(100).default("") }).parse(req.query);
  res.json(await listPatientsInCare(asClinician(req.user, "doctor"), search));
});

// get one patient's chart
doctorPatientsRouter.get("/api/doctor/patients/:id", async (req, res) => {
  const doctor = asClinician(req.user, "doctor");
  const patientId = idParam.parse(req.params.id);
  await assertCanSeePatient(doctor, patientId);
  res.json(await getPatientChart(patientId, doctor));
});

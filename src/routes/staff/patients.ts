import { Router } from "express";
import { z } from "zod";
import { listPatients, patientSchema, registerAtFrontDesk } from "../../services/patients.js";

export const staffPatientsRouter = Router();

const registerSchema = patientSchema.extend({ confirmedNewPatient: z.boolean().default(false) });

staffPatientsRouter.get("/api/patients", async (_req, res) => {
    res.json(await listPatients());
});


// a likely match comes back first so the receptionist can check before adding the same person twice
staffPatientsRouter.post("/api/patients", async (req, res) => {
    const { confirmedNewPatient, ...patient } = registerSchema.parse(req.body ?? {});
    const result = await registerAtFrontDesk(patient, confirmedNewPatient);

    if (result.matches) {
        res.status(409).json({
            error: "A patient with this name and date of birth is already registered. Check the existing record, or confirm this is a different person.",
            matches: result.matches,
        });
        return;
    }

    res.status(201).json(result.patient);
});

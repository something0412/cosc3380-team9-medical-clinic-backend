import { Router } from "express";
import { z } from "zod";
import { listPatientReferrals } from "../../services/referrals.js";

export const patientReferralsRouter = Router();

const idParam = z.coerce.number().int().positive();

// the /api/patient/:id guard in app.ts already checks this is the signed in patient
patientReferralsRouter.get("/api/patient/:id/referrals", async (req, res) => {
  res.json(await listPatientReferrals(idParam.parse(req.params.id)));
});

import { Router } from "express";
import { receptionistDashboardRouter } from "./receptionistDashboard.js";
import { receptionistAppointmentsRouter } from "./receptionistAppointments.js";
import { receptionistPatientsRouter } from "./receptionistPatients.js";

// receptionist routes: add each receptionist route file here with receptionistRouter.use(...)
export const receptionistRouter = Router();

receptionistRouter.use(receptionistDashboardRouter);
receptionistRouter.use(receptionistAppointmentsRouter);
receptionistRouter.use(receptionistPatientsRouter);

import { Router } from "express";
import { nurseAppointmentsRouter } from "./nurseAppointments.js";
import { nurseDashboardRouter } from "./nurseDashboard.js";
import { nursePatientsRouter } from "./nursePatients.js";
import { nurseSuppliesRouter } from "./nurseSupplies.js";

// nurse routes: add each nurse route file here with nurseRouter.use(...)
export const nurseRouter = Router();

nurseRouter.use(nurseDashboardRouter);
nurseRouter.use(nurseAppointmentsRouter);
nurseRouter.use(nursePatientsRouter);
nurseRouter.use(nurseSuppliesRouter);

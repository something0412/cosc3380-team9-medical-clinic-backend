import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { appointmentsRouter } from "./routes/appointments.js";
import { authRouter } from "./routes/auth.js";
import { billingRouter } from "./routes/billing.js";
import { healthRouter } from "./routes/health.js";
import { intakeRouter } from "./routes/intake.js";
import { patientsRouter } from "./routes/patients.js";
import { templateRouter } from "./routes/template.js";

export const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

app.use(appointmentsRouter);
app.use(authRouter);
app.use(billingRouter);
app.use(healthRouter);
app.use(intakeRouter);
app.use(patientsRouter);
app.use(templateRouter);

app.use(notFoundHandler);
app.use(errorHandler);

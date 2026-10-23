import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import session from "express-session";
import { randomBytes } from "node:crypto";

import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

import { requireRole } from "./middleware/requireRole.js";
import { adminRouter } from "./routes/admin/index.js";
import { appointmentsRouter } from "./routes/appointments.js";
import { authRouter } from "./routes/auth.js";
import { billingRouter } from "./routes/billing.js";
import { healthRouter } from "./routes/health.js";
import { intakeRouter } from "./routes/intake.js";
import { nursingRouter } from "./routes/nursing.js";
import { patientProfileRouter } from "./routes/patientProfile.js";
import { patientsRouter } from "./routes/patients.js";
import { staffProfileRouter } from "./routes/staffProfile.js";
import { templateRouter } from "./routes/template.js";

export const app = express();

app.use(helmet());

app.use(cors({
  origin: process.env.FRONTEND_URL ?? "http://localhost:5173",
  credentials: true,
}));

// request logs, turned off while tests run
app.use(morgan("dev", { skip: () => process.env.NODE_ENV === "test" }));

app.use(express.json());

// session secret
const secret = process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required in production");
}

// sessions
app.use(session({
  secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

// patient portal: only the logged-in patient
app.use("/api/patient/:id", (req, res, next) => {
  if (req.session.role !== "patient") {
    res.status(401).json({ error: "Patient login required" });
    return;
  }
  if (req.session.patientId !== Number(req.params.id)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
});

// staff profile: only the logged-in staff member
app.use("/api/staff/:id", (req, res, next) => {
  if (!req.session.role || req.session.role === "patient") {
    res.status(401).json({ error: "Staff login required" });
    return;
  }
  if (req.session.employeeId !== Number(req.params.id)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
});

// patient list and registration: staff only
app.use("/api/patients", (req, res, next) => {
  if (!req.session.role || req.session.role === "patient") {
    res.status(401).json({ error: "Staff login required" });
    return;
  }
  next();
});

// receptionist, billing and nurse routes: staff only (each route also
// checks nurse vs receptionist itself)
app.use(
  [
    "/api/appointments", "/api/specialties", "/api/doctors", "/api/availability",
    "/api/invoices", "/api/payments", "/api/payment-types",
    "/api/emergency-contacts", "/api/form-types",
    "/api/allergy-types", "/api/allergies", "/api/medications", "/api/home-medications",
    "/api/lab-test-types", "/api/lab-orders", "/api/office-supplies", "/api/supply-orders",
  ],
  (req, res, next) => {
    if (!req.session.role || req.session.role === "patient") {
      res.status(401).json({ error: "Staff login required" });
      return;
    }
    next();
  }
);

app.use(healthRouter);
app.use(authRouter);
app.use(appointmentsRouter);
app.use(billingRouter);
app.use(intakeRouter);
app.use(nursingRouter);
app.use(patientsRouter);
app.use(patientProfileRouter);
app.use(staffProfileRouter);
app.use(templateRouter);

// admin portal: admins only
app.use("/api/admin", requireRole("admin"), adminRouter);

app.use(notFoundHandler);
app.use(errorHandler);

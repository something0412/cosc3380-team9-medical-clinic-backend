import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import session from "express-session";
import { randomBytes } from "node:crypto";

import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { requireRole } from "./middleware/requireRole.js";
import { adminRouter } from "./routes/admin/index.js";
import { authRouter } from "./routes/auth.js";
import { doctorAppointmentsRouter } from "./routes/doctor/doctorAppointments.js";
import { doctorDashboardRouter } from "./routes/doctor/doctorDashboard.js";
import { doctorLabOrdersRouter } from "./routes/doctor/doctorLabOrders.js";
import { doctorPatientsRouter } from "./routes/doctor/doctorPatients.js";
import { doctorReferralsRouter } from "./routes/doctor/doctorReferrals.js";
import { doctorScheduleRouter } from "./routes/doctor/doctorSchedule.js";
import { healthRouter } from "./routes/health.js";
import { patientProfileRouter } from "./routes/patient/patientProfile.js";
import { patientsRouter } from "./routes/patient/patients.js";
import { publicRouter } from "./routes/public.js";
import { staffProfileRouter } from "./routes/staff/staffProfile.js";
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

// doctor portal: doctors only
app.use("/api/doctor", (req, res, next) => {
  if (!req.session.role) {
    res.status(401).json({ error: "Login required" });
    return;
  }
  if (req.session.role !== "doctor") {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
});

app.use(healthRouter);
app.use(authRouter);
app.use(doctorDashboardRouter);
app.use(doctorPatientsRouter);
app.use(doctorLabOrdersRouter);
app.use(doctorReferralsRouter);
app.use(doctorAppointmentsRouter);
app.use(doctorScheduleRouter);
app.use(patientsRouter);
app.use(patientProfileRouter);
app.use(staffProfileRouter);
app.use(templateRouter);

// public website information, anyone can read it
app.use("/api/public", publicRouter);

// admin portal: admins only
app.use("/api/admin", requireRole("admin"), adminRouter);

app.use(notFoundHandler);
app.use(errorHandler);
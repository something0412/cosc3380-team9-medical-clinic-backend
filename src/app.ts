import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import session from "express-session";
import { randomBytes } from "node:crypto";

import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { requireRole } from "./middleware/requireRole.js";
import { loadSessionUser } from "./middleware/sessionUser.js";
import { adminRouter } from "./routes/admin/index.js";
import { authRouter } from "./routes/auth.js";
import { bookingRouter } from "./routes/booking.js";
import { doctorAppointmentsRouter } from "./routes/doctor/doctorAppointments.js";
import { doctorDashboardRouter } from "./routes/doctor/doctorDashboard.js";
import { doctorLabOrdersRouter } from "./routes/doctor/doctorLabOrders.js";
import { doctorPatientsRouter } from "./routes/doctor/doctorPatients.js";
import { doctorReferralsRouter } from "./routes/doctor/doctorReferrals.js";
import { doctorScheduleRouter } from "./routes/doctor/doctorSchedule.js";
import { healthRouter } from "./routes/health.js";
import { labDashboardRouter } from "./routes/lab/labDashboard.js";
import { labOrdersRouter } from "./routes/lab/labOrders.js";
import { nurseRouter } from "./routes/nurse/index.js";
import { patientPortalRouter } from "./routes/patient/portal.js";
import { patientProfileRouter } from "./routes/patient/profile.js";
import { publicRouter } from "./routes/public.js";
import { receptionistRouter } from "./routes/receptionist/index.js";
import { staffPatientsRouter } from "./routes/staff/patients.js";
import { staffProfileRouter } from "./routes/staff/profile.js";
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

const secret = process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required in production");
}

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

// deactivated or deleted accounts lose their session before any route sees it
app.use(loadSessionUser);

// only the logged in patient can use their patient portal
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

// only the logged in employee can use their staff profile
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

// the patient list and registration are for staff only
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

// lab portal: lab technicians only
app.use("/api/lab", (req, res, next) => {
  if (!req.session.role) {
    res.status(401).json({ error: "Login required" });
    return;
  }
  if (req.session.role !== "lab") {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
});

// nurse portal: nurses only
app.use("/api/nurse", (req, res, next) => {
  if (!req.session.role) {
    res.status(401).json({ error: "Login required" });
    return;
  }
  if (req.session.role !== "staff" || req.session.employeeType !== "Nurse") {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
});

// receptionist portal: receptionists only
app.use("/api/receptionist", (req, res, next) => {
  if (!req.session.role) {
    res.status(401).json({ error: "Login required" });
    return;
  }
  if (req.session.role !== "staff" || req.session.employeeType !== "Receptionist") {
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
app.use(labDashboardRouter);
app.use(labOrdersRouter);
app.use(nurseRouter);
app.use(receptionistRouter);
app.use(staffPatientsRouter);
app.use(patientPortalRouter);
app.use(patientProfileRouter);
app.use(staffProfileRouter);
app.use(templateRouter);

// public website information, anyone can read it
app.use("/api/public", publicRouter);

// appointment booking for patients and receptionists, checked in each route
app.use(bookingRouter);

// the admin portal is for admins only
app.use("/api/admin", requireRole("admin"), adminRouter);

app.use(notFoundHandler);
app.use(errorHandler);
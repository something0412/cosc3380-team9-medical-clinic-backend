import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import session from "express-session";
import { randomBytes } from "node:crypto";

import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";
import { patientsRouter } from "./routes/patients.js";
import { templateRouter } from "./routes/template.js";

export const app = express();

app.use(helmet());

app.use(cors({
  origin: process.env.FRONTEND_URL ?? "http://localhost:5173",
  credentials: true,
}));

app.use(morgan("dev"));

app.use(express.json());

// A random secret is fine for local development but resets logins on restart.
// Set a strong SESSION_SECRET in .env for stable sessions and all deployments.
const secret = process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");
if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required in production");
}

// MemoryStore is for local development only. Use a persistent store in production.
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

// Pass the verified server-side patient session to the existing patient routes.
app.use((req, res, next) => {
  if (req.session.role === "patient" && Number.isSafeInteger(req.session.patientId)) {
    res.locals.patientId = req.session.patientId;
  }
  next();
});

app.use(healthRouter);
app.use(authRouter);
app.use(patientsRouter);
app.use(templateRouter);

app.use(notFoundHandler);
app.use(errorHandler);
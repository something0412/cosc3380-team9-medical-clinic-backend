import { Router } from "express";

export const healthRouter = Router();

// Trivial enough (no database, no response shaping) that it doesn't need
// its own controller file — see controllers/patients.ts for when a route
// *does* warrant splitting into one.
healthRouter.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

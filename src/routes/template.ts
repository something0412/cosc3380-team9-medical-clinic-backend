import { Router } from "express";

export const templateRouter = Router();

// Same reasoning as health.ts: nothing here touches the database or needs
// response shaping, so the logic stays inline instead of getting its own
// controller file. This route's only job is proving the frontend can
// reach the backend end to end — copy routes/patients.ts + controllers/patients.ts
// instead when you're adding a real, database-backed feature.
templateRouter.get("/api/template", (_req, res) => {
  res.json({
    message: "Hello from the backend! This is a template route, copy this pattern for new features.",
    timestamp: new Date().toISOString(),
  });
});

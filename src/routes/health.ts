import { Router } from "express";

export const healthRouter = Router();

// health check
healthRouter.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

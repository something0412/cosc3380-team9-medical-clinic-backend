import { Router } from "express";

export const templateRouter = Router();

// template route
templateRouter.get("/api/template", (_req, res) => {
  res.json({
    message: "Hello from the backend! This is a template route, copy this pattern for new features.",
    timestamp: new Date().toISOString(),
  });
});

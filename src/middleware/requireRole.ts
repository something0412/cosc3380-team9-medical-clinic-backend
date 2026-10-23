import type { RequestHandler } from "express";
import type { SessionData } from "express-session";
import { HttpError } from "./errorHandler.js";

type Role = NonNullable<SessionData["role"]>;

// allow only logged-in users with one of these roles
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const { role } = req.session;
    if (!role) return next(new HttpError(401, "Login required"));
    if (!roles.includes(role)) return next(new HttpError(403, "Access denied"));
    next();
  };
}

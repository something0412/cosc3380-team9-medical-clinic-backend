import type { RequestHandler } from "express";
import { HttpError } from "./errorHandler.js";
import type { Role, StaffType } from "./sessionUser.js";

// allow only logged in users with one of these roles
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const role = req.user?.role;
    if (!role) return next(new HttpError(401, "Login required"));
    if (!roles.includes(role)) return next(new HttpError(403, "Access denied"));
    next();
  };
}

// nurses and receptionists share the staff role, so this checks their staff type instead
export function requireStaffType(...types: StaffType[]): RequestHandler {
  return (req, _res, next) => {
    const { user } = req;
    if (!user) return next(new HttpError(401, "Login required"));
    if (user.role === "patient" || !types.includes(user.staffType)) return next(new HttpError(403, "Access denied"));
    next();
  };
}

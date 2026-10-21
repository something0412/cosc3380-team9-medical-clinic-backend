import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", issues: err.issues });
    return;
  }

  // Postgres constraint violations are the client's fault, not a server
  // crash: a duplicate unique value (23505) is a conflict, a missing
  // foreign key row (23503) or failed CHECK (23514) is a bad request.
  // `detail` is Postgres's own explanation, e.g.
  // "Key (policy_number)=(ABC123) already exists."
  const pgCode = (err as { code?: string }).code;
  if (pgCode === "23505" || pgCode === "23503" || pgCode === "23514") {
    const detail = (err as { detail?: string; message: string }).detail ?? (err as Error).message;
    res.status(pgCode === "23505" ? 409 : 400).json({ error: detail });
    return;
  }

  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : "Internal server error";

  if (status === 500) {
    console.error(err);
  }

  res.status(status).json({ error: message });
}

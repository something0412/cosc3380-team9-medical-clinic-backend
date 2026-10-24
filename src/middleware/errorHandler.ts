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

const SERVER_ERROR = "Something went wrong. Please try again later.";

interface DatabaseError extends Error {
  code: string;
  severity: string;
}

function isDatabaseError(err: unknown): err is DatabaseError {
  return err instanceof Error && "severity" in err && typeof (err as { code?: unknown }).code === "string";
}

// database errors caused by bad input or conflicting data, without repeating the database detail
function fromDatabaseError(err: DatabaseError) {
  switch (err.code) {
    case "23505":
    case "23P01":
      return new HttpError(409, "This conflicts with an existing record");
    case "23503":
      // an insert pointing at a missing row is bad input, removing a row that's still used is a conflict
      return err.message.startsWith("insert or update")
        ? new HttpError(400, "Some of the submitted values refer to records that don't exist")
        : new HttpError(409, "This record is still in use");
    case "23502":
    case "23514":
    case "22001":
    case "22003":
    case "22007":
    case "22008":
    case "22P02":
      return new HttpError(400, "Some of the submitted values are not valid");
    default:
      return null;
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues[0]?.message ?? "Validation failed", issues: err.issues });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  // Express marks problems like bad JSON as the client's fault
  const clientError = err as { status?: unknown; expose?: unknown; type?: unknown };
  if (typeof clientError.status === "number" && clientError.status >= 400 && clientError.status < 500) {
    const message =
      clientError.type === "entity.parse.failed"
        ? "The request body isn't valid JSON"
        : clientError.expose === true && err instanceof Error
          ? err.message
          : "The request couldn't be processed";
    res.status(clientError.status).json({ error: message });
    return;
  }

  if (isDatabaseError(err)) {
    const mapped = fromDatabaseError(err);
    if (mapped) {
      res.status(mapped.status).json({ error: mapped.message });
      return;
    }
    // the code and message are enough to debug, the detail can hold personal data
    console.error(`${req.method} ${req.path} failed with database error ${err.code}: ${err.message}`);
  } else {
    console.error(`${req.method} ${req.path} failed:`, err);
  }

  res.status(500).json({ error: SERVER_ERROR });
}

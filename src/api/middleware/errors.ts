import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MissingUserContextError } from "../../db/context.js";
import { errorBody, HttpError } from "../httpError.js";

// The single place every error in the app becomes an HTTP response. No route or
// middleware upstream of this formats a response body for a failure — they either
// throw HttpError for a case they understand, or let anything else propagate here.
//
// Must be registered last, after every route.

/** A Postgres driver error carries this field; not exported by `postgres`, so shaped locally. */
interface PostgresError {
  code?: string;
  constraint_name?: string;
}

function isPostgresError(error: unknown): error is PostgresError {
  return typeof error === "object" && error !== null && "code" in error;
}

export function errorMiddleware(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json(errorBody(err.code, err.message));
    return;
  }

  if (
    err instanceof SyntaxError &&
    (err as SyntaxError & { status?: number; type?: string }).type === "entity.parse.failed"
  ) {
    // express.json() throws this for a malformed request body — a client mistake,
    // not a server one, so it gets the same clean envelope as a schema failure
    // rather than falling through to the generic 500 below.
    res.status(400).json(errorBody("invalid_request", "request body is not valid JSON"));
    return;
  }

  if (err instanceof ZodError) {
    res
      .status(400)
      .json(errorBody("invalid_request", err.issues.map((issue) => issue.message).join("; ")));
    return;
  }

  if (err instanceof MissingUserContextError) {
    // Reaching here means a route called the repository without going through
    // requireAuth first — a bug in this codebase, not a client error. 500, not 401:
    // the client did nothing wrong.
    console.error("MissingUserContextError reached the error middleware — route bug", err);
    res.status(500).json(errorBody("internal_error", "something went wrong"));
    return;
  }

  if (isPostgresError(err) && err.code === "23505") {
    // Matched by constraint name, not the bare SQLSTATE: a blanket 23505 → "already
    // exists" mapping would mislabel any other unique constraint added later. Today
    // there is exactly one meaningful case.
    if (err.constraint_name === "households_one_per_owner") {
      res.status(409).json(errorBody("household_already_exists", "household already exists"));
      return;
    }
  }

  // Unrecognised: never forward the raw driver/framework error, message or stack to
  // the client. Logged server-side so it's still diagnosable.
  // eslint-disable-next-line no-console
  console.error("unhandled error", err);
  res.status(500).json(errorBody("internal_error", "something went wrong"));
}

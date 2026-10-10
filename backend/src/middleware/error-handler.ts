/* Maps every error to RFC 9457 problem JSON with a stable code (PRODUCT.md §7.9). */
import type { ErrorRequestHandler, RequestHandler } from "express";
import type { Problem } from "@app/shared";
import { AppError, NotFoundError } from "../core/errors.js";

const PROBLEM_CONTENT_TYPE = "application/problem+json";

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/* Errors thrown by body-parser carry a `type` and an HTTP status. */
interface BodyParserError {
  type: string;
  status: number;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as BodyParserError).type === "string" &&
    typeof (err as BodyParserError).status === "number"
  );
}

function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
  if (isBodyParserError(err)) {
    if (err.type === "entity.parse.failed")
      return new AppError(400, "validation_failed", "The request body is not valid JSON.");
    if (err.type === "entity.too.large")
      return new AppError(413, "payload_too_large", "The request body is too large.");
  }
  /* An address the router couldn't decode ("%ff" is not text). */
  if (err instanceof URIError) {
    return new AppError(400, "validation_failed", "The address of this request is not valid.");
  }
  /*
   * A value the database can't store (class 22, "data exception": a NUL character in text, text
   * that is not an ID where one is expected). Validation should have caught it; the caller still
   * sent something wrong, so this is their error to fix and not a failure of ours.
   */
  if (databaseCode(err)?.startsWith("22") === true) {
    return new AppError(400, "validation_failed", "The request has a value that can't be stored.");
  }
  return undefined;
}

/* The Postgres error code of an error, wherever the driver or the query builder put it. */
function databaseCode(err: unknown): string | undefined {
  for (let current = err, depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`No route for ${req.method} ${req.path}.`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = toAppError(err);
  const status = appError?.status ?? 500;
  if (appError === undefined) req.log.error({ err }, "unhandled error");

  const problem: Problem = {
    type: "about:blank",
    title: TITLES[status] ?? "Error",
    status,
    code: appError?.code ?? "internal_error",
    detail: appError?.message ?? "Something went wrong on our side.",
    requestId: String(req.id),
    ...(appError?.fieldErrors ? { errors: appError.fieldErrors } : {}),
  };

  res.status(status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problem));
};

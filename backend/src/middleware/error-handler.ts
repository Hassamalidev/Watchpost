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

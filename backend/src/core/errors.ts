/* AppError hierarchy with stable codes, mapped once to problem JSON by the error handler (PRODUCT.md §7.11). */
import type { ApiErrorCode } from "@app/shared";

export interface FieldError {
  path: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly fieldErrors?: FieldError[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = "The request is invalid.", fieldErrors?: FieldError[]) {
    super(400, "validation_failed", message, fieldErrors);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Sign in to continue.") {
    super(401, "unauthorized", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do this.") {
    super(403, "forbidden", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found.") {
    super(404, "not_found", message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "This conflicts with the current state.") {
    super(409, "conflict", message);
  }
}

/* The thing existed but is no longer usable (an expired link). */
export class GoneError extends AppError {
  constructor(message = "This is no longer available.") {
    super(410, "gone", message);
  }
}

export class QuotaExceededError extends AppError {
  constructor(message = "Your plan's limit has been reached.") {
    super(402, "quota_exceeded", message);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = "Too many requests. Try again shortly.") {
    super(429, "rate_limited", message);
  }
}

export class ProviderError extends AppError {
  constructor(
    public readonly provider: string,
    message = "An external provider failed.",
    options?: { cause?: unknown },
  ) {
    super(502, "provider_error", message);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/* Stable error codes returned in RFC 9457 problem JSON (PRODUCT.md §7.9). */
export const API_ERROR_CODES = [
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "payload_too_large",
  "quota_exceeded",
  "rate_limited",
  "provider_error",
  "service_unavailable",
  "internal_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

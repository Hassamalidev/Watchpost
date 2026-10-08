/*
 * Check error taxonomy (PRODUCT.md Appendix B). Every failed check carries one code.
 * `impact` decides what detection does with it:
 * - failure: counts as a customer-facing failure
 * - degraded: the target works but is slow or about to break
 * - config: the monitor is misconfigured; shown to the user, never paged
 * - ours: our own fault (probe problems); never counts against the customer (§9.1 rule 8)
 */
export const CHECK_ERRORS = {
  dns_nxdomain: { impact: "failure", title: "Domain doesn't exist" },
  dns_servfail: { impact: "failure", title: "DNS server failure" },
  dns_timeout: { impact: "failure", title: "DNS lookup timed out" },
  dns_no_records: { impact: "failure", title: "No DNS records" },
  ssrf_blocked: { impact: "config", title: "Target resolves to a private or reserved address" },
  connect_refused: { impact: "failure", title: "Connection refused" },
  connect_timeout: { impact: "failure", title: "Connection timed out" },
  connect_reset: { impact: "failure", title: "Connection reset" },
  network_unreachable: { impact: "failure", title: "Network unreachable" },
  tls_handshake_failed: { impact: "failure", title: "TLS handshake failed" },
  tls_cert_expired: { impact: "failure", title: "Certificate expired" },
  tls_cert_not_yet_valid: { impact: "failure", title: "Certificate not yet valid" },
  tls_hostname_mismatch: { impact: "failure", title: "Certificate doesn't match the hostname" },
  tls_untrusted_chain: { impact: "failure", title: "Untrusted certificate chain" },
  http_status_unexpected: { impact: "failure", title: "Unexpected HTTP status" },
  http_too_many_redirects: { impact: "failure", title: "Too many redirects" },
  http_redirect_blocked: { impact: "failure", title: "Redirect blocked" },
  response_timeout: { impact: "failure", title: "No complete response within the timeout" },
  body_too_large: { impact: "config", title: "Response body over the read limit" },
  keyword_missing: { impact: "failure", title: "Keyword not found" },
  keyword_present: { impact: "failure", title: "Unwanted keyword found" },
  json_invalid: { impact: "failure", title: "Response is not valid JSON" },
  json_query_failed: { impact: "failure", title: "JSON query didn't match" },
  latency_threshold: { impact: "degraded", title: "Slower than the threshold" },
  ws_handshake_failed: { impact: "failure", title: "WebSocket handshake failed" },
  ws_expect_failed: { impact: "failure", title: "WebSocket reply didn't match" },
  tcp_expect_failed: { impact: "failure", title: "TCP reply didn't match" },
  ping_loss: { impact: "failure", title: "Packet loss over the threshold" },
  dns_value_mismatch: { impact: "failure", title: "DNS record differs from expected" },
  auth_failed: { impact: "failure", title: "The service refused the login" },
  protocol_error: { impact: "failure", title: "The service answered, but not as it should" },
  service_unhealthy: { impact: "failure", title: "The service reports it isn't serving" },
  heartbeat_missed: { impact: "failure", title: "Heartbeat missed" },
  heartbeat_failed_signal: { impact: "failure", title: "Job reported a failure" },
  heartbeat_too_long: { impact: "degraded", title: "Run exceeded the maximum duration" },
  probe_error: { impact: "ours", title: "Probe error" },
  probe_overloaded: { impact: "ours", title: "Probe overloaded" },
} as const satisfies Record<string, { impact: CheckErrorImpact; title: string }>;

export type CheckErrorImpact = "failure" | "degraded" | "config" | "ours";
export type CheckErrorCode = keyof typeof CHECK_ERRORS;
export const CHECK_ERROR_CODES = Object.keys(CHECK_ERRORS) as CheckErrorCode[];

export function checkErrorImpact(code: CheckErrorCode): CheckErrorImpact {
  return CHECK_ERRORS[code].impact;
}

/* True when a failure with this code may count toward opening a customer incident. */
export function countsAsCustomerFailure(code: CheckErrorCode): boolean {
  return CHECK_ERRORS[code].impact === "failure";
}

/* Network failures mapped to the Appendix B check error codes. */
import type { CheckErrorCode } from "@app/shared";

export class CheckError extends Error {
  constructor(
    public readonly code: CheckErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CheckError";
  }
}

const SOCKET_CODES: Record<string, CheckErrorCode> = {
  ECONNREFUSED: "connect_refused",
  ECONNRESET: "connect_reset",
  EPIPE: "connect_reset",
  ETIMEDOUT: "connect_timeout",
  ENETUNREACH: "network_unreachable",
  EHOSTUNREACH: "network_unreachable",
  EHOSTDOWN: "network_unreachable",
  ENOTFOUND: "dns_nxdomain",
  EAI_AGAIN: "dns_timeout",
  ENODATA: "dns_no_records",
  ESERVFAIL: "dns_servfail",
};

const TLS_CODES: Record<string, CheckErrorCode> = {
  CERT_HAS_EXPIRED: "tls_cert_expired",
  CERT_NOT_YET_VALID: "tls_cert_not_yet_valid",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls_hostname_mismatch",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls_untrusted_chain",
  SELF_SIGNED_CERT_IN_CHAIN: "tls_untrusted_chain",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls_untrusted_chain",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "tls_untrusted_chain",
  UNABLE_TO_GET_ISSUER_CERT: "tls_untrusted_chain",
  CERT_UNTRUSTED: "tls_untrusted_chain",
};

/* Turns a Node socket, DNS or TLS error into a CheckError. */
export function toCheckError(
  err: unknown,
  phase: "dns" | "connect" | "tls" | "response",
): CheckError {
  if (err instanceof CheckError) return err;
  const e = err as NodeJS.ErrnoException;
  const code = e?.code ?? "";
  const message = e?.message ?? String(err);
  if (TLS_CODES[code]) return new CheckError(TLS_CODES[code], message);
  if (SOCKET_CODES[code]) return new CheckError(SOCKET_CODES[code], message);
  if (code.startsWith("ERR_SSL") || code.startsWith("ERR_TLS") || phase === "tls") {
    return new CheckError("tls_handshake_failed", message);
  }
  if (phase === "dns") return new CheckError("dns_servfail", message);
  if (phase === "connect") return new CheckError("connect_reset", message);
  return new CheckError("connect_reset", message);
}

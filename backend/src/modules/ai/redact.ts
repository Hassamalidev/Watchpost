/*
 * What may be sent to the model (PRODUCT.md §9.10): structured evidence with every secret and every
 * personal address taken out. Pure, and applied to the whole input just before it is sent, so a new
 * field can't leak by being forgotten.
 *
 *  - values under keys that name a secret (authorization, cookie, token, password, api key …) → "[redacted]"
 *  - "Bearer …" and "Basic …" credentials inside any string → "[redacted]"
 *  - "password=…", "token: …" written out in free text → the value becomes "[redacted]"
 *  - query-string values of URLs → "[redacted]" (the parameter names stay; they explain a failure)
 *  - user:password@ in URLs → removed
 *  - email addresses → "[email]"
 *  - body excerpts and other long text → cut to 500 characters
 */

export const REDACTED = "[redacted]";
export const REDACTED_EMAIL = "[email]";
export const MAX_TEXT = 500;
const MAX_DEPTH = 8;
const MAX_ITEMS = 50;

const SECRET_KEY =
  /authorization|cookie|token|secret|password|passwd|api[-_]?key|apikey|signature|credential|session|private[-_]?key|^key$/i;
const CREDENTIAL = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
/* "password=…", "api_key: …" written out in free text (a log line, a note, an error message). */
const ASSIGNED_SECRET =
  /\b(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]+/gi;

/* A URL without credentials and with every query value hidden. */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.username = "";
  url.password = "";
  if (url.search !== "") {
    const names = [...new Set([...url.searchParams.keys()])];
    url.search = names.map((name) => `${encodeURIComponent(name)}=${REDACTED}`).join("&");
  }
  url.hash = "";
  return url.toString();
}

export function redactText(text: string): string {
  const cleaned = text
    .replace(URL_IN_TEXT, (match) => redactUrl(match))
    .replace(CREDENTIAL, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(
      ASSIGNED_SECRET,
      (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
    )
    .replace(EMAIL, REDACTED_EMAIL);
  return cleaned.length > MAX_TEXT ? `${cleaned.slice(0, MAX_TEXT)}…` : cleaned;
}

/* A copy of `value` that is safe to send: same shape, secrets and addresses gone. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[omitted]";
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => redact(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value).slice(0, MAX_ITEMS)) {
    result[key] = SECRET_KEY.test(key) && inner !== null ? REDACTED : redact(inner, depth + 1);
  }
  return result;
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
/* Four or more groups, or any form with "::" (fe80::1, ::1, 2001:db8::8a2e:370:7334). */
const IPV6 =
  /(?:\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*\b)?|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/i;
/* A dotted name that ends in a letters-only label: api.internal, db-1.eu.acme.io. */
const HOSTNAME = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/i;

export const INTERNAL = "[internal system]";

/*
 * A copy of `value` with every IP address and host name replaced, except the hosts in `allowed`.
 * For prompts whose answer goes to the public: the model can't repeat what it was never shown.
 */
export function scrubInternal(value: unknown, allowed: readonly string[] = []): unknown {
  const ok = new Set(allowed.map((host) => host.toLowerCase()));
  const scrub = (text: string) =>
    text
      .replace(new RegExp(IPV4.source, "g"), INTERNAL)
      .replace(new RegExp(IPV6.source, "gi"), INTERNAL)
      .replace(new RegExp(HOSTNAME.source, "gi"), (host) =>
        ok.has(host.toLowerCase()) ? host : INTERNAL,
      );
  if (typeof value === "string") return scrub(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubInternal(item, allowed));
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, scrubInternal(inner, allowed)]),
  );
}

/*
 * For text that goes to the public (status page drafts, §6.6): the first internal detail it
 * contains, or undefined when it has none. Host names in `allowed` (the customer's public site) pass.
 */
export function internalDetailIn(
  text: string,
  allowed: readonly string[] = [],
): string | undefined {
  const ip = IPV4.exec(text) ?? IPV6.exec(text);
  if (ip !== null) return ip[0];
  const ok = new Set(allowed.map((host) => host.toLowerCase()));
  let rest = text;
  for (;;) {
    const match = HOSTNAME.exec(rest);
    if (match === null) return undefined;
    if (!ok.has(match[0].toLowerCase())) return match[0];
    rest = rest.slice(match.index + match[0].length);
  }
}

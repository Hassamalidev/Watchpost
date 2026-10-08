/*
 * Monitor secrets (PRODUCT.md §12): HTTP basic passwords, bearer tokens and auth-like header values
 * are stored encrypted (secrets_enc) and replaced by MASKED in the stored config and in API output.
 * On update, a MASKED value means "keep the existing secret", so forms can round-trip safely.
 */
import type { MonitorConfig } from "@app/shared";

export const MASKED = "********";

const SECRET_HEADER =
  /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$|token|secret|key|password/i;

export function isSecretHeader(name: string): boolean {
  return SECRET_HEADER.test(name);
}

export interface MonitorSecrets {
  authPassword?: string;
  authToken?: string;
  /* The login of a service check (Redis, MQTT). */
  password?: string;
  /* Lower-cased header name → value. */
  headers?: Record<string, string>;
}

type HeaderList = Array<{ name: string; value: string }>;

function headersOf(config: MonitorConfig): HeaderList | undefined {
  return "headers" in config ? (config.headers as HeaderList) : undefined;
}

/* Splits a full config into the storable (masked) config and its secrets. */
export function extractSecrets(config: MonitorConfig): {
  config: MonitorConfig;
  secrets: MonitorSecrets | null;
} {
  const secrets: MonitorSecrets = {};
  const copy = structuredClone(config) as MonitorConfig;

  if ("auth" in copy) {
    if (copy.auth.kind === "basic") {
      secrets.authPassword = copy.auth.password;
      copy.auth = { ...copy.auth, password: MASKED };
    } else if (copy.auth.kind === "bearer") {
      secrets.authToken = copy.auth.token;
      copy.auth = { ...copy.auth, token: MASKED };
    }
  }
  if ("password" in copy && copy.password !== undefined) {
    secrets.password = copy.password;
    copy.password = MASKED;
  }
  const headers = headersOf(copy);
  if (headers !== undefined) {
    for (const header of headers) {
      if (!isSecretHeader(header.name)) continue;
      (secrets.headers ??= {})[header.name.toLowerCase()] = header.value;
      header.value = MASKED;
    }
  }
  const hasSecrets =
    secrets.authPassword !== undefined ||
    secrets.authToken !== undefined ||
    secrets.password !== undefined ||
    (secrets.headers !== undefined && Object.keys(secrets.headers).length > 0);
  return { config: copy, secrets: hasSecrets ? secrets : null };
}

/* Puts secrets back into a masked config (for updates and probe assignments). */
export function applySecrets(config: MonitorConfig, secrets: MonitorSecrets | null): MonitorConfig {
  const copy = structuredClone(config) as MonitorConfig;
  if (secrets === null) return copy;
  if ("auth" in copy) {
    if (
      copy.auth.kind === "basic" &&
      copy.auth.password === MASKED &&
      secrets.authPassword !== undefined
    ) {
      copy.auth = { ...copy.auth, password: secrets.authPassword };
    } else if (
      copy.auth.kind === "bearer" &&
      copy.auth.token === MASKED &&
      secrets.authToken !== undefined
    ) {
      copy.auth = { ...copy.auth, token: secrets.authToken };
    }
  }
  if ("password" in copy && copy.password === MASKED && secrets.password !== undefined) {
    copy.password = secrets.password;
  }
  const headers = headersOf(copy);
  if (headers !== undefined && secrets.headers !== undefined) {
    for (const header of headers) {
      const stored = secrets.headers[header.name.toLowerCase()];
      if (header.value === MASKED && stored !== undefined) header.value = stored;
    }
  }
  return copy;
}

/* True when a config still contains a MASKED placeholder that no stored secret can fill. */
export function hasUnresolvedMask(config: MonitorConfig): boolean {
  if ("auth" in config) {
    if (config.auth.kind === "basic" && config.auth.password === MASKED) return true;
    if (config.auth.kind === "bearer" && config.auth.token === MASKED) return true;
  }
  if ("password" in config && config.password === MASKED) return true;
  return (headersOf(config) ?? []).some((h) => h.value === MASKED);
}

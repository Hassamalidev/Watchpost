/* Dev-only outage simulator settings, read once from the environment. */
export interface FakeTargetConfig {
  host: string;
  httpPort: number;
  tlsPort: number;
  tcpPort: number;
  /* Days until the self-signed TLS certificate expires; small by default so expiry warnings fire. */
  tlsDays: number;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FakeTargetConfig {
  return {
    host: env.FAKE_TARGET_HOST ?? "0.0.0.0",
    httpPort: intFromEnv(env, "FAKE_TARGET_HTTP_PORT", 4100),
    tlsPort: intFromEnv(env, "FAKE_TARGET_TLS_PORT", 4101),
    tcpPort: intFromEnv(env, "FAKE_TARGET_TCP_PORT", 4102),
    tlsDays: intFromEnv(env, "FAKE_TARGET_TLS_DAYS", 5),
  };
}

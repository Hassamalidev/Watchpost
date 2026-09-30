/* Connection settings for tests that need real Postgres and Redis (docker compose locally, services in CI). */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://watchpost:watchpost@localhost:5433/watchpost";
export const TEST_REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/* Ports nothing listens on, for "dependency is down" tests. */
export const DEAD_DATABASE_URL = "postgres://watchpost:watchpost@127.0.0.1:1/watchpost";
export const DEAD_REDIS_URL = "redis://127.0.0.1:1";

export function randomIp(): string {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `10.${octet()}.${octet()}.${octet()}`;
}

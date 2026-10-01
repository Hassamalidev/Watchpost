/*
 * Browser tests against production builds of the web app and the API (`pnpm build` first; the
 * database must be migrated). The web server proxies /api/* to the API, as Caddy does in production.
 * Locally this uses the installed Chrome; set PLAYWRIGHT_CHANNEL="" to use Playwright's Chromium (CI).
 */
import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = 3100;
const API_PORT = 4000;
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const channel = process.env.PLAYWRIGHT_CHANNEL ?? "chrome";
export const STORAGE_STATE = "e2e/.auth/user.json";

/* The e2e API talks to the same database the tests read verification links from. */
export const E2E_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://watchpost:watchpost@localhost:5433/watchpost";

/* The API and the worker (started by e2e/stack.mjs) share this environment. */
const BACKEND_ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "warn",
  API_PORT: String(API_PORT),
  WEB_ORIGIN,
  BETTER_AUTH_URL: WEB_ORIGIN,
  BETTER_AUTH_SECRET: "e2e-only-secret-".padEnd(40, "x"),
  TOKEN_ENC_KEY: Buffer.alloc(32, 9).toString("base64"),
  TOKEN_ENC_KEY_ID: "e2e",
  DATABASE_URL: E2E_DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  EMAIL_TRANSPORT: "console",
  /* Webhook deliveries go to the local receiver in e2e/stack.mjs. */
  OUTBOUND_ALLOW_CIDRS: "127.0.0.0/8",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: WEB_ORIGIN,
    ...(channel === "" ? {} : { channel }),
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "light",
      use: { ...devices["Desktop Chrome"], colorScheme: "light", storageState: STORAGE_STATE },
      dependencies: ["setup"],
    },
    {
      name: "dark",
      use: { ...devices["Desktop Chrome"], colorScheme: "dark", storageState: STORAGE_STATE },
      dependencies: ["setup"],
    },
  ],
  webServer: [
    {
      command: "node ../dist/server.js",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: BACKEND_ENV,
    },
    {
      /* Worker, probe, fake-target and the webhook receiver (P1-T19 outage flow). */
      command: "node e2e/stack.mjs",
      url: "http://127.0.0.1:4199/ready",
      reuseExistingServer: false,
      timeout: 60_000,
      env: BACKEND_ENV,
    },
    {
      command: `pnpm exec next start --port ${WEB_PORT}`,
      url: WEB_ORIGIN,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});

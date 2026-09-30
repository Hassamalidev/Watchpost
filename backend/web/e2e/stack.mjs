/*
 * Everything the outage E2E needs besides the API and the web app (P1-T19): fake-target on
 * 4110–4112, a registered managed probe, the worker, the probe itself, and a webhook receiver on
 * 4199 that records deliveries (`GET /hooks`). `GET /ready` answers once the probe and worker run.
 * Playwright starts it as a web server with the same environment as the API.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const env = process.env;
const RECEIVER_PORT = 4199;
export const E2E_PROBE_ID = "0190e2e0-0000-7000-8000-000000000001";

const children = [];
function start(name, file, extraEnv) {
  const child = spawn(process.execPath, [file], {
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code) => {
    if (!shuttingDown) {
      process.stderr.write(`[stack] ${name} exited with ${code}\n`);
      process.exit(1);
    }
  });
  children.push(child);
  return child;
}

/* Registers (or re-keys) the e2e probe with a fresh secret, encrypted like the API does. */
async function registerProbe() {
  const { createTokenCipher } = await import(
    new URL("../../dist/infra/crypto.js", import.meta.url).href
  );
  const cipher = createTokenCipher({
    activeKeyId: env.TOKEN_ENC_KEY_ID,
    keys: { [env.TOKEN_ENC_KEY_ID]: Buffer.from(env.TOKEN_ENC_KEY, "base64") },
  });
  const secret = randomBytes(32).toString("base64url");
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `insert into probes (id, name, region, kind, secret_enc)
       values ($1, 'e2e-probe', 'eu-central', 'managed', $2)
       on conflict (id) do update set secret_enc = excluded.secret_enc, disabled = false`,
      [E2E_PROBE_ID, cipher.encrypt(secret, `probe:${E2E_PROBE_ID}`)],
    );
  } finally {
    await client.end();
  }
  return secret;
}

const hooks = [];
let ready = false;
let shuttingDown = false;

const receiver = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/ready") {
    res.writeHead(ready ? 200 : 503).end(ready ? "ready" : "starting");
    return;
  }
  if (req.method === "GET" && req.url === "/hooks") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(hooks));
    return;
  }
  if (req.method === "POST" && req.url === "/hook") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      hooks.push({ headers: req.headers, body, receivedAt: new Date().toISOString() });
      res.writeHead(200).end("ok");
    });
    return;
  }
  res.writeHead(404).end();
});

async function main() {
  receiver.listen(RECEIVER_PORT, "127.0.0.1");
  start("fake-target", here("../../../tools/fake-target/dist/main.js"), {
    FAKE_TARGET_HOST: "127.0.0.1",
    FAKE_TARGET_HTTP_PORT: "4110",
    FAKE_TARGET_TLS_PORT: "4111",
    FAKE_TARGET_TCP_PORT: "4112",
  });
  const secret = await registerProbe();
  start("worker", here("../../dist/worker.js"), {});
  start("probe", here("../../../probe/dist/main.js"), {
    /* The probe refuses its API's host; reaching the API as "localhost" keeps 127.0.0.1 targets allowed. */
    API_URL: `http://localhost:${env.API_PORT ?? "4000"}`,
    PROBE_ID: E2E_PROBE_ID,
    PROBE_SECRET: secret,
    PROBE_REGION: "eu-central",
    PROBE_ALLOW_CIDRS: "127.0.0.0/8,::1/128",
    PROBE_HEALTH_PORT: "0",
    LOG_LEVEL: "warn",
  });
  ready = true;
}

function shutdown() {
  shuttingDown = true;
  for (const child of children) child.kill();
  receiver.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((err) => {
  process.stderr.write(
    `[stack] failed to start: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  shutdown();
  process.exit(1);
});

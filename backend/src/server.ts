/* HTTP entry point: load config, build the container, mount the app, shut down gracefully. */
import { ConfigError, loadConfig, type AppConfig } from "./config/index.js";

const SHUTDOWN_GRACE_MS = 10_000;

function bootConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n${err.message}\n\nSee .env.example for every variable.\n\n`);
      process.exit(1);
    }
    throw err;
  }
}

/*
 * The environment is checked before the rest of the app is loaded, so a bad one is reported at
 * once instead of after every module has been read (which takes many seconds in development).
 */
const config = bootConfig();
const { createApp } = await import("./app.js");
const { createContainer } = await import("./composition/container.js");
const container = createContainer(config, { service: "api" });
const { logger } = container.infra;

const app = createApp({
  config,
  logger,
  redis: container.infra.redis,
  readinessChecks: container.readinessChecks,
  readinessWarnings: container.readinessWarnings,
  routers: container.routers,
  rawBodyRouters: container.rawBodyRouters,
});

/* Module timers (for example the platform tick); a failed run is logged and retried next time. */
const timers = container.modules
  .flatMap((m) => m.apiTimers ?? [])
  .map((timer) => {
    const handle = setInterval(() => {
      timer
        .run()
        .catch((err: unknown) => logger.warn({ err, timer: timer.name }, "api timer failed"));
    }, timer.everyMs);
    handle.unref();
    return handle;
  });

const server = app.listen(config.api.port, () => {
  logger.info(
    { port: config.api.port, modules: container.modules.map((m) => m.name) },
    "api listening",
  );
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  for (const handle of timers) clearInterval(handle);
  const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(force);
  await container.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

/* HTTP entry point: load config, build the container, mount the app, shut down gracefully. */
import { ConfigError, loadConfig, type AppConfig } from "./config/index.js";
import { createApp } from "./app.js";
import { createContainer } from "./composition/container.js";

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

const config = bootConfig();
const container = createContainer(config, { service: "api" });
const { logger } = container.infra;

const app = createApp({
  config,
  logger,
  redis: container.infra.redis,
  readinessChecks: container.readinessChecks,
  routers: container.routers,
  rawBodyRouters: container.rawBodyRouters,
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
  const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(force);
  await container.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

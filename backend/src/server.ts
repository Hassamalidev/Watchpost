/* HTTP entry point: load config, build infra, mount the app, shut down gracefully. */
import { ConfigError, loadConfig, type AppConfig } from "./config/index.js";
import { createApp } from "./app.js";
import { createLogger } from "./infra/logger.js";
import { createDbPool, pingDb } from "./infra/db.js";
import { createRedis, pingRedis } from "./infra/redis.js";

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
const logger = createLogger({ level: config.logLevel, pretty: config.env === "development" });
const db = createDbPool(config.databaseUrl);
const redis = createRedis(config.redisUrl);
redis.on("error", (err) => logger.warn({ err: err.message }, "redis connection error"));

const app = createApp({
  config,
  logger,
  redis,
  readinessChecks: {
    postgres: () => pingDb(db),
    redis: () => pingRedis(redis),
  },
});

const server = app.listen(config.api.port, () => {
  logger.info({ port: config.api.port }, "api listening");
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  clearTimeout(force);
  await Promise.allSettled([db.end(), redis.quit()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

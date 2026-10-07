/*
 * Sentinel entry point: `node dist/sentinel/main.js` in the probe image, on a server of another
 * provider than the core (PRODUCT.md §13, §16). See docs/runbooks/sentinel.md.
 */
import { pino } from "pino";
import { SentinelConfigError, loadSentinelConfig } from "./config.js";
import { createSentinel } from "./run.js";

let config;
try {
  config = loadSentinelConfig(process.env);
} catch (err) {
  if (err instanceof SentinelConfigError) {
    process.stderr.write(`\n${err.message}\n\n`);
    process.exit(1);
  }
  throw err;
}

const logger = pino({ level: config.logLevel, base: { service: "sentinel" } });
const sentinel = createSentinel({
  config,
  log: (level, event, text) => logger[level](event, text),
});

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "stopping sentinel");
  sentinel
    .stop()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const port = await sentinel.start();
logger.info(
  {
    port,
    targets: config.targets.map((t) => t.name),
    everySeconds: config.intervalMs / 1_000,
    telegram: config.telegram !== undefined,
    sms: config.sms?.to.length ?? 0,
    dryRun: config.dryRun,
  },
  "sentinel started",
);

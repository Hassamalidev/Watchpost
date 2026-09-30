/* Probe entry point: `node dist/main.js` in the probe container (PRODUCT.md §7.6, §16). */
import { pino } from "pino";
import { defaultCheckRunners } from "./checks/index.js";
import { ProbeConfigError, loadProbeConfig } from "./config.js";
import { createProbeRuntime } from "./runtime.js";

let config;
try {
  config = loadProbeConfig(process.env);
} catch (err) {
  if (err instanceof ProbeConfigError) {
    process.stderr.write(`\n${err.message}\n\n`);
    process.exit(1);
  }
  throw err;
}

const logger = pino({
  level: config.logLevel,
  base: { service: "probe", region: config.region },
  redact: { paths: ["*.secret", "*.password", "*.token", "*.headers.*"], censor: "[redacted]" },
});
const runtime = createProbeRuntime({ config, logger, runners: defaultCheckRunners });

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "stopping probe");
  runtime
    .stop()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      logger.error({ err }, "error while stopping");
      process.exit(1);
    });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await runtime.start();

/* pino JSON logger with secret redaction (PRODUCT.md §12). */
import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";

export type { Logger } from "pino";

export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.token",
  "*.secret",
  "*.authorization",
  "*.cookie",
  "*.headers.*",
];

export function createLogger(options: {
  level: string;
  pretty?: boolean;
  service?: "api" | "worker";
  /* Where JSON lines go (stdout by default); tests pass a stream to inspect output. */
  destination?: DestinationStream;
}): Logger {
  const base: LoggerOptions = {
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service: options.service ?? "api" },
  };
  if (options.destination !== undefined) return pino(base, options.destination);
  if (options.pretty) {
    return pino({ ...base, transport: { target: "pino-pretty", options: { singleLine: true } } });
  }
  return pino(base);
}

/*
 * Schemas published as JSON Schema under docs/schemas/ (P1-T03 AC). The generator script and a
 * staleness test both read this list, so adding a schema here is the only step.
 */
import type { z } from "zod";
import { EVENT_SCHEMAS } from "./events.js";
import { createMonitorSchema, monitorConfigSchema, monitorSettingsSchema } from "./monitors.js";
import {
  assignmentsResponseSchema,
  helloRequestSchema,
  helloResponseSchema,
  probeHeartbeatSchema,
  probeTaskSchema,
  resultsBatchSchema,
} from "./probe-protocol.js";
import { problemSchema } from "./problem.js";
import { checkResultSchema } from "./results.js";

export const JSON_SCHEMA_EXPORTS: Record<string, z.ZodType> = {
  "monitor-config": monitorConfigSchema,
  "monitor-settings": monitorSettingsSchema,
  "create-monitor": createMonitorSchema,
  "check-result": checkResultSchema,
  "probe-hello-request": helloRequestSchema,
  "probe-hello-response": helloResponseSchema,
  "probe-assignments-response": assignmentsResponseSchema,
  "probe-results-batch": resultsBatchSchema,
  "probe-task": probeTaskSchema,
  "probe-heartbeat": probeHeartbeatSchema,
  problem: problemSchema,
  ...Object.fromEntries(
    Object.entries(EVENT_SCHEMAS).map(([type, def]) => [
      `event.${type}.v${def.version}`,
      def.schema,
    ]),
  ),
};

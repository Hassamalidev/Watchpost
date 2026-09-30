/* BullMQ processors for the detection module: evaluations, delayed verifications and the sweep. */
import { z } from "zod";
import { defineProcessor, type JobProcessor } from "../../../infra/queues/index.js";
import type { DetectionService } from "../detection.service.js";

const jobSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("evaluate"), monitorId: z.uuid() }),
  z.object({
    kind: z.literal("verify"),
    monitorId: z.uuid(),
    workspaceId: z.uuid(),
    regions: z.array(z.string()).min(1),
  }),
  z.object({ kind: z.literal("sweep") }),
]);

export function createDetectionProcessors(service: DetectionService): JobProcessor[] {
  return [
    defineProcessor({
      queue: "evaluate",
      schema: jobSchema,
      async handle(data, { logger }) {
        if (data.kind === "evaluate") {
          const outcome = await service.evaluateMonitor(data.monitorId);
          if (outcome !== undefined && outcome.from !== outcome.decision.status) {
            logger.info(
              { monitorId: data.monitorId, from: outcome.from, to: outcome.decision.status },
              "monitor status changed",
            );
          }
          return;
        }
        if (data.kind === "verify") {
          await service.requestVerification(data);
          return;
        }
        const queued = await service.sweep();
        if (queued > 0) logger.info({ queued }, "queued evaluations for unevaluated results");
      },
    }),
  ];
}

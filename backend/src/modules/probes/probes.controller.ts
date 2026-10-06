/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import {
  assignmentsQuerySchema,
  helloRequestSchema,
  probeHeartbeatSchema,
  tasksQuerySchema,
} from "@app/shared";
import { ValidationError } from "../../core/errors.js";
import { probeOf } from "../../middleware/probe-auth.js";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { ProbesService } from "./probes.service.js";
import type { monitorIdParams, taskIdParams } from "./validators/index.js";

function parse<T>(
  schema: {
    safeParse(
      v: unknown,
    ): { success: true; data: T } | { success: false; error: { message: string } };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(`Invalid probe request: ${result.error.message}`);
  return result.data;
}

export type ProbesController = Record<
  "hello" | "assignments" | "tasks" | "heartbeat" | "testNow" | "getTask",
  RequestHandler
>;

export function createProbesController(service: ProbesService): ProbesController {
  return {
    hello: async (req, res) => {
      res.json(await service.hello(probeOf(res), parse(helloRequestSchema, req.body)));
    },
    assignments: async (req, res) => {
      const query = parse(assignmentsQuerySchema, req.query);
      res.json(await service.assignments(probeOf(res), query.after, query.full));
    },
    tasks: async (req, res) => {
      const query = parse(tasksQuerySchema, req.query);
      res.json({ tasks: await service.pollTasks(probeOf(res), query.wait) });
    },
    heartbeat: async (req, res) => {
      await service.heartbeat(probeOf(res), parse(probeHeartbeatSchema, req.body));
      res.status(204).end();
    },
    testNow: async (req, res) => {
      const { params } = inputOf<{ params: typeof monitorIdParams }>(req, res);
      res.status(202).json({ data: await service.testNow(scopeOf(req, res), params.monitorId) });
    },
    getTask: async (req, res) => {
      const { params } = inputOf<{ params: typeof taskIdParams }>(req, res);
      res.json(await service.getTask(scopeOf(req, res), params.taskId));
    },
  };
}

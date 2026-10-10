/*
 * One monitor the probe can't read must cost only that monitor. Before this was so, a single
 * config saved under older rules made the probe refuse its whole assignment list and stop
 * checking everything.
 */
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { AssignedMonitor, CheckResult } from "@app/shared";
import type { Executor } from "../../executor/executor.js";
import { createTaskLoop } from "../../tasks/tasks.js";
import type { ProbeClient } from "../../transport/client.js";
import { createAssignmentSync } from "../assignments.js";

const monitor = (id: string, config: unknown, configSeq = 1) => ({
  id,
  workspaceId: "0199c0de-0000-7000-8000-0000000000aa",
  config,
  intervalSeconds: 60,
  timeoutMs: 5_000,
  configSeq,
});
const GOOD = "0199c0de-0000-7000-8000-000000000001";
const BAD = "0199c0de-0000-7000-8000-000000000002";
const OTHER = "0199c0de-0000-7000-8000-000000000003";
const http = { type: "http", url: "https://example.com/" };
/* A header with a line break: saved before headers were held to one line. */
const broken = {
  type: "http",
  url: "https://example.com/",
  headers: [{ name: "X-A", value: "a\nb" }],
};

function clientAnswering(answers: unknown[]): ProbeClient {
  let call = 0;
  return {
    request: async (
      _method: string,
      _path: string,
      options: { schema: { parse: (v: unknown) => unknown } },
    ) => options.schema.parse(answers[Math.min(call++, answers.length - 1)]),
  } as unknown as ProbeClient;
}

describe("assignment sync", () => {
  it("keeps the monitors it can read when one in the list is unreadable", async () => {
    const upserted: AssignedMonitor[] = [];
    const sync = createAssignmentSync({
      client: clientAnswering([
        {
          cursor: 7,
          full: true,
          upserts: [
            monitor(GOOD, http),
            monitor(BAD, broken),
            monitor(OTHER, { type: "from-the-future" }),
          ],
          deletes: [],
        },
      ]),
      onUpsert: (m) => upserted.push(m),
      onRemove: () => undefined,
    });
    const result = await sync.syncOnce();
    expect(result).toEqual({ upserts: 1, deletes: 0, full: true, skipped: [BAD, OTHER] });
    expect(upserted.map((m) => m.id)).toEqual([GOOD]);
    expect(sync.monitors().map((m) => m.id)).toEqual([GOOD]);
    /* The cursor still moves on: the unreadable ones are not asked for forever. */
    expect(sync.cursor()).toBe(7);
  });

  it("stops running a monitor whose new config it can't read", async () => {
    const removed: string[] = [];
    const sync = createAssignmentSync({
      client: clientAnswering([
        { cursor: 1, full: true, upserts: [monitor(GOOD, http), monitor(BAD, http)], deletes: [] },
        { cursor: 2, full: false, upserts: [monitor(BAD, broken, 2)], deletes: [] },
      ]),
      onUpsert: () => undefined,
      onRemove: (id) => removed.push(id),
    });
    await sync.syncOnce();
    expect(await sync.syncOnce()).toMatchObject({ upserts: 0, skipped: [BAD] });
    expect(removed).toEqual([BAD]);
    expect(sync.monitors().map((m) => m.id)).toEqual([GOOD]);
  });

  it("still refuses an answer that isn't an assignment list at all", async () => {
    const sync = createAssignmentSync({
      client: clientAnswering([{ error: "nope" }]),
      onUpsert: () => undefined,
      onRemove: () => undefined,
    });
    await expect(sync.syncOnce()).rejects.toThrow();
  });
});

describe("task loop", () => {
  it("runs the tasks it can read when one of them is for an unreadable monitor", async () => {
    const ran: string[] = [];
    let polls = 0;
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const client = {
      request: async (
        _m: string,
        _p: string,
        options: { schema: { parse: (v: unknown) => unknown } },
      ) => {
        polls += 1;
        if (polls > 1) return new Promise(() => undefined);
        return options.schema.parse({
          tasks: [
            {
              id: "0199c0de-0000-7000-8000-0000000000b1",
              kind: "verify",
              monitor: monitor(BAD, broken),
              deadline,
            },
            {
              id: "0199c0de-0000-7000-8000-0000000000b2",
              kind: "verify",
              monitor: monitor(GOOD, http),
              deadline,
            },
          ],
        });
      },
    } as unknown as ProbeClient;
    const executor = {
      run: async (m: AssignedMonitor) => {
        ran.push(m.id);
        return { id: "r", monitorId: m.id } as unknown as CheckResult;
      },
    } as unknown as Executor;
    const loop = createTaskLoop({
      client,
      executor,
      report: () => undefined,
      logger: pino({ level: "silent" }),
      waitSeconds: 0,
    });
    loop.start();
    await vi.waitFor(() => expect(ran).toEqual([GOOD]));
    await loop.stop();
  });
});

/*
 * The real container wires modules the worker can run: at most one processor per queue (the worker
 * refuses to start otherwise), none on the queues worker.ts handles itself, and only registry queues.
 */
import { afterAll, describe, expect, it } from "vitest";
import { isQueueName } from "../../infra/queues/index.js";
import { buildContainerApp } from "../../__tests__/helpers/container-app.js";

const ctx = buildContainerApp();

afterAll(async () => {
  await ctx.container.close();
});

describe("container", () => {
  it("gives every queue at most one processor", () => {
    const queues = ctx.container.modules.flatMap((m) => (m.processors ?? []).map((p) => p.queue));
    /* worker.ts adds these two itself. */
    const all = [...queues, "sweeps", "emails"];
    expect(all.filter((q, i) => all.indexOf(q) !== i)).toEqual([]);
    expect(queues.every(isQueueName)).toBe(true);
  });

  it("names every module's recovery sweep uniquely", () => {
    const names = ctx.container.modules.flatMap((m) => (m.recoverySweeps ?? []).map((s) => s.name));
    expect(new Set(names).size).toBe(names.length);
  });
});

/*
 * Runs checks with a concurrency cap (PRODUCT.md §7.6). Check implementations live in checks/ and are
 * looked up by monitor type; any thrown error becomes a probe_error result, which never counts
 * against the customer (Appendix B).
 */
import type { AssignedMonitor, CheckErrorCode, CheckResult, MonitorConfig } from "@app/shared";
import { v7 as uuidv7 } from "uuid";
import type { AddressPolicy } from "../net/address-policy.js";

/* What a check implementation returns; the executor adds IDs, region and timestamps. */
export type CheckOutcome = Omit<
  CheckResult,
  "id" | "monitorId" | "region" | "checkedAt" | "taskId"
>;

export interface CheckContext {
  timeoutMs: number;
  signal: AbortSignal;
  /* SSRF rules for this probe (§9.1); every network check must use it. */
  policy: AddressPolicy;
  /* Extra trusted CA certificates (PEM), added to Node's defaults: internal CAs for private probes. */
  ca?: string[];
}

export type CheckRunner = (config: MonitorConfig, ctx: CheckContext) => Promise<CheckOutcome>;
export type CheckRunners = Partial<Record<MonitorConfig["type"], CheckRunner>>;

export interface Executor {
  run(monitor: AssignedMonitor, taskId?: string): Promise<CheckResult>;
  inFlight(): number;
  /* Resolves when every running check has finished. */
  idle(): Promise<void>;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }
  release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
  get count(): number {
    return this.active;
  }
}

export function failure(code: CheckErrorCode, message: string, latencyMs = 0): CheckOutcome {
  return { ok: false, errorCode: code, message: message.slice(0, 500), latencyMs };
}

export function createExecutor(options: {
  region: CheckResult["region"];
  concurrency: number;
  runners: CheckRunners;
  policy: AddressPolicy;
  ca?: string[];
  now?: () => number;
}): Executor {
  const now = options.now ?? Date.now;
  const semaphore = new Semaphore(options.concurrency);
  const running = new Set<Promise<unknown>>();

  async function execute(monitor: AssignedMonitor, taskId?: string): Promise<CheckResult> {
    await semaphore.acquire();
    const startedAt = now();
    try {
      const runner = options.runners[monitor.config.type];
      let outcome: CheckOutcome;
      if (runner === undefined) {
        outcome = failure("probe_error", `this probe can't run "${monitor.config.type}" checks`);
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), monitor.timeoutMs + 1_000);
        try {
          outcome = await runner(monitor.config, {
            timeoutMs: monitor.timeoutMs,
            signal: controller.signal,
            policy: options.policy,
            ...(options.ca ? { ca: options.ca } : {}),
          });
        } catch (err) {
          outcome = failure(
            "probe_error",
            `check crashed: ${(err as Error).message}`,
            now() - startedAt,
          );
        } finally {
          clearTimeout(timer);
        }
      }
      return {
        ...outcome,
        id: uuidv7(),
        monitorId: monitor.id,
        region: options.region,
        checkedAt: new Date(startedAt).toISOString(),
        ...(taskId === undefined ? {} : { taskId }),
      };
    } finally {
      semaphore.release();
    }
  }

  return {
    run(monitor, taskId) {
      const promise = execute(monitor, taskId);
      running.add(promise);
      void promise.finally(() => running.delete(promise)).catch(() => {});
      return promise;
    },
    inFlight: () => semaphore.count,
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
}

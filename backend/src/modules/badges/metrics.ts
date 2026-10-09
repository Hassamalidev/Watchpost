/*
 * A workspace's monitors in the Prometheus text format (PRODUCT.md §6.13), for people who keep their
 * dashboards and alert rules in Prometheus or Grafana. Pure: the numbers in, the text out.
 *
 * The metric names say what they measure and carry no product name, so dashboards survive a rename.
 */
import type { MonitorStatus } from "@app/shared";

export interface MonitorMetrics {
  id: string;
  name: string;
  type: string;
  paused: boolean;
  /* Undefined until the monitor has reported once. */
  status: MonitorStatus | undefined;
  /* 0 to 100, or null when there is nothing to measure yet. */
  uptime24h: number | null;
  uptime30d: number | null;
  /* Latency of successful checks in the last 24 hours, in milliseconds. */
  p50Ms: number | null;
  p95Ms: number | null;
  checks24h: number;
}

/* Backslash, quote and line feed are the three characters a label value has to escape. */
const label = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

interface Family {
  name: string;
  help: string;
  type: "gauge";
  samples: Array<{ labels: Record<string, string>; value: number }>;
}

function render(families: Family[]): string {
  const lines: string[] = [];
  for (const family of families) {
    if (family.samples.length === 0) continue;
    lines.push(`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) {
      const labels = Object.entries(sample.labels)
        .map(([key, value]) => `${key}="${label(value)}"`)
        .join(",");
      lines.push(`${family.name}{${labels}} ${sample.value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/* What a status counts as: a monitor being re-checked or in maintenance is not down. */
const UP: readonly MonitorStatus[] = ["up", "verifying", "maintenance"];

export function prometheusText(monitors: readonly MonitorMetrics[]): string {
  const base = (m: MonitorMetrics) => ({ monitor_id: m.id, monitor: m.name, type: m.type });
  const reporting = monitors.filter((m) => m.status !== undefined && !m.paused);
  const ratio = (percent: number) => Math.round(percent * 100) / 10_000;
  return render([
    {
      name: "uptime_monitor_up",
      help: "1 when the monitor is up, 0 when it is down or degraded. Absent while paused or before the first check.",
      type: "gauge",
      samples: reporting
        .filter((m) => m.status !== "pending" && m.status !== "paused")
        .map((m) => ({
          labels: base(m),
          value: UP.includes(m.status as MonitorStatus) ? 1 : 0,
        })),
    },
    {
      name: "uptime_monitor_status",
      help: "The monitor's current status as a label; the value is always 1.",
      type: "gauge",
      samples: monitors.map((m) => ({
        labels: { ...base(m), status: m.paused ? "paused" : (m.status ?? "pending") },
        value: 1,
      })),
    },
    {
      name: "uptime_monitor_paused",
      help: "1 when checks are paused.",
      type: "gauge",
      samples: monitors.map((m) => ({ labels: base(m), value: m.paused ? 1 : 0 })),
    },
    {
      name: "uptime_monitor_uptime_ratio",
      help: "Share of the window the monitor was up, 0 to 1, from recorded outages (planned maintenance left out).",
      type: "gauge",
      samples: monitors.flatMap((m) => [
        ...(m.uptime24h === null
          ? []
          : [{ labels: { ...base(m), window: "24h" }, value: ratio(m.uptime24h) }]),
        ...(m.uptime30d === null
          ? []
          : [{ labels: { ...base(m), window: "30d" }, value: ratio(m.uptime30d) }]),
      ]),
    },
    {
      name: "uptime_monitor_response_time_seconds",
      help: "Response time of successful checks over the last 24 hours, by quantile.",
      type: "gauge",
      samples: monitors.flatMap((m) => [
        ...(m.p50Ms === null
          ? []
          : [{ labels: { ...base(m), quantile: "0.5" }, value: m.p50Ms / 1_000 }]),
        ...(m.p95Ms === null
          ? []
          : [{ labels: { ...base(m), quantile: "0.95" }, value: m.p95Ms / 1_000 }]),
      ]),
    },
    {
      name: "uptime_monitor_checks_24h",
      help: "Checks run in the last 24 hours, from every region together.",
      type: "gauge",
      samples: monitors.map((m) => ({ labels: base(m), value: m.checks24h })),
    },
  ]);
}

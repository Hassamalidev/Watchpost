/*
 * Small dependency-free charts: a p50/p95 latency line chart and 90-day uptime bars. Both carry
 * their numbers as text for screen readers; color is never the only signal (PRODUCT.md §14).
 */
"use client";

import { useTranslations } from "next-intl";
import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { LatencyPoint, UptimeDay } from "../api";

const W = 600;
const H = 160;
const PAD = { left: 40, right: 8, top: 8, bottom: 20 };

function linePath(values: Array<number | null>, max: number): string {
  const n = values.length;
  let path = "";
  values.forEach((v, i) => {
    if (v === null) return;
    const x = PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD.left - PAD.right));
    const y = PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);
    path += `${path === "" ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)} `;
  });
  return path.trim();
}

export function LatencyChart({ points }: { points: LatencyPoint[] }) {
  const t = useTranslations("monitors");
  const p50 = points.map((p) => p.p50);
  const p95 = points.map((p) => p.p95);
  const max = Math.max(1, ...p95.map((v) => v ?? 0), ...p50.map((v) => v ?? 0));
  const last = points.at(-1);
  if (points.length === 0) return <p className="text-sm text-muted-foreground">{t("noLatency")}</p>;
  return (
    <figure className="grid gap-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-40 w-full"
        role="img"
        aria-label={`${t("latency")}: ${t("p50")} ${last?.p50 ?? "—"} ms, ${t("p95")} ${last?.p95 ?? "—"} ms`}
      >
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={H - PAD.bottom}
          y2={H - PAD.bottom}
          className="stroke-border"
        />
        <text x={4} y={PAD.top + 10} className="fill-muted-foreground text-[10px]">
          {Math.round(max)} ms
        </text>
        <text x={4} y={H - PAD.bottom} className="fill-muted-foreground text-[10px]">
          0
        </text>
        <path
          d={linePath(p95, max)}
          className="fill-none stroke-status-degraded"
          strokeWidth={1.5}
        />
        <path d={linePath(p50, max)} className="fill-none stroke-brand" strokeWidth={2} />
      </svg>
      <figcaption className="flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span aria-hidden className="inline-block h-0.5 w-4 bg-brand" /> {t("p50")}
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="inline-block h-0.5 w-4 bg-status-degraded" /> {t("p95")}
        </span>
      </figcaption>
    </figure>
  );
}

const DAY_TONE: Record<UptimeDay["status"], string> = {
  up: "bg-status-up",
  minor: "bg-status-degraded",
  major: "bg-status-down",
  none: "bg-muted",
};

export function UptimeBars({ days }: { days: UptimeDay[] }) {
  const t = useTranslations("monitors");
  return (
    <ol className="flex h-8 items-stretch gap-px" aria-label={t("uptimeBars")}>
      {days.map((day) => {
        const label = t("dayTitle", {
          date: day.date,
          status: day.uptimePercent === null ? t("noData") : formatPercent(day.uptimePercent),
        });
        return (
          <li key={day.date} className="flex-1" title={label}>
            <span className={cn("block h-full rounded-[1px]", DAY_TONE[day.status])} />
            <span className="sr-only">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/*
 * Alert tuning advisor (P1-T28): turns a monitor's last 30 days of incidents into concrete setting
 * changes that cut noise without hiding real outages. Pure and deterministic, like the failure
 * explainer; each suggestion carries the exact settings patch to apply.
 */
import { LAUNCH_REGIONS } from "../constants/regions.js";
import { effectiveRecoverySuccesses, type MonitorSettings } from "../schemas/monitors.js";

export interface NoiseStats {
  /* Incidents opened by checks in the period. */
  incidents: number;
  /* Of those, marked as false alarms by the team. */
  falseAlarms: number;
  /* Incidents that flapped (went up and down repeatedly while open). */
  flapping: number;
  /* Incidents that resolved on their own within a few minutes. */
  shortLived: number;
}

export type TuningSettings = Pick<
  MonitorSettings,
  "regions" | "minFailingRegions" | "recoverySuccesses" | "intervalSeconds" | "timeoutMs"
>;

export interface TuningSuggestion {
  id: "add-region" | "confirm-more-regions" | "longer-recovery" | "longer-timeout";
  title: string;
  reason: string;
  patch: Partial<MonitorSettings>;
}

/* How many noisy incidents in 30 days before we suggest anything. */
const NOISY = 2;

export function noiseLevel(stats: NoiseStats): number {
  return stats.falseAlarms + stats.flapping + stats.shortLived;
}

export function suggestTuning(stats: NoiseStats, settings: TuningSettings): TuningSuggestion[] {
  const suggestions: TuningSuggestion[] = [];
  const blips = stats.falseAlarms + stats.shortLived;
  const regionCount = settings.regions.length;
  const required = Math.min(settings.minFailingRegions, regionCount);

  if (blips >= NOISY && regionCount === 1) {
    const extra = LAUNCH_REGIONS.find((r) => !settings.regions.includes(r));
    if (extra !== undefined) {
      suggestions.push({
        id: "add-region",
        title: `Check from a second region (${extra})`,
        reason: `${blips} alerts in 30 days were false alarms or cleared within minutes. With one region, a network blip near our probe looks like an outage; a second region lets us confirm before paging.`,
        patch: { regions: [...settings.regions, extra], minFailingRegions: 2 },
      });
    }
  } else if (blips >= NOISY && required < regionCount) {
    suggestions.push({
      id: "confirm-more-regions",
      title: `Require ${required + 1} failing regions before alerting`,
      reason: `${blips} alerts in 30 days were false alarms or cleared within minutes, while only ${required} of ${regionCount} regions had to fail. Requiring one more filters out regional network trouble.`,
      patch: { minFailingRegions: required + 1 },
    });
  }

  const recovery = effectiveRecoverySuccesses(settings);
  if (stats.flapping >= NOISY && recovery < 3) {
    suggestions.push({
      id: "longer-recovery",
      title: `Wait for ${recovery + 1} good checks before recovering`,
      reason: `${stats.flapping} incidents flapped between down and up. Requiring more consecutive good checks keeps one incident open instead of a stream of "down" and "recovered" alerts.`,
      patch: { recoverySuccesses: recovery + 1 },
    });
  }

  /* Timeouts close to the limit turn slow responses into "down". */
  const longerTimeout = Math.min(
    30_000,
    settings.timeoutMs * 2,
    settings.intervalSeconds * 1_000 - 1_000,
  );
  if (blips >= NOISY && settings.timeoutMs < 10_000 && longerTimeout > settings.timeoutMs) {
    suggestions.push({
      id: "longer-timeout",
      title: `Allow ${Math.round(longerTimeout / 1_000)} s before a check times out`,
      reason: `The timeout is ${Math.round(settings.timeoutMs / 1_000)} s. Short timeouts turn slow-but-working responses into failures; track slowness with the slow-response threshold instead.`,
      patch: { timeoutMs: longerTimeout },
    });
  }

  return suggestions;
}

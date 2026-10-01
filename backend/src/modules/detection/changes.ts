/*
 * "What changed before this incident?" — the first question in every outage. Builds a timeline of
 * changes in the hours before a moment from data we already store: the address each region connected
 * to, the certificate it saw, edits to the monitor, and a jump in response time. Changes are tracked
 * per region, so geo-DNS and anycast setups (different addresses per region) don't look like changes.
 * Pure: the service loads the inputs.
 */

export type ChangeKind = "deploy" | "address" | "certificate" | "config" | "latency";

export interface ChangeEvent {
  at: string;
  kind: ChangeKind;
  title: string;
  detail: string | null;
  regions: string[];
}

export interface ChangeInputs {
  before: Date;
  createdAt: Date;
  ips: Array<{ region: string; ip: string; firstSeen: Date }>;
  certificates: Array<{
    region: string;
    fingerprint: string;
    issuer: string | null;
    validTo: string | null;
    firstSeen: Date;
  }>;
  configChanges: Date[];
  /* Deploys recorded for the workspace (P1-T26). */
  deploys?: Array<{
    version: string;
    service: string | null;
    environment: string | null;
    description: string | null;
    deployedAt: Date;
  }>;
  latency: {
    /* The hour before `before`, and the hours before that. */
    recent: { averageMs: number | null; count: number };
    baseline: { averageMs: number | null; count: number };
  };
}

/* Values that appear in a region after an earlier value there; merged across regions. */
function regionalChanges<T extends { region: string; firstSeen: Date }>(
  rows: T[],
  key: (row: T) => string,
): Array<{ value: T; previous: T; regions: string[]; at: Date }> {
  const byRegion = new Map<string, T[]>();
  for (const row of rows) byRegion.set(row.region, [...(byRegion.get(row.region) ?? []), row]);
  const merged = new Map<string, { value: T; previous: T; regions: string[]; at: Date }>();
  for (const [region, list] of byRegion) {
    const ordered = [...list].sort((a, b) => a.firstSeen.getTime() - b.firstSeen.getTime());
    for (let i = 1; i < ordered.length; i += 1) {
      const value = ordered[i]!;
      const id = key(value);
      const existing = merged.get(id);
      if (existing) {
        existing.regions.push(region);
        if (value.firstSeen < existing.at) existing.at = value.firstSeen;
      } else {
        merged.set(id, {
          value,
          previous: ordered[i - 1]!,
          regions: [region],
          at: value.firstSeen,
        });
      }
    }
  }
  return [...merged.values()];
}

export function buildChanges(input: ChangeInputs): ChangeEvent[] {
  const events: ChangeEvent[] = [];

  for (const change of regionalChanges(input.ips, (r) => r.ip)) {
    events.push({
      at: change.at.toISOString(),
      kind: "address",
      title: `Server address changed to ${change.value.ip}`,
      detail: `Was ${change.previous.ip}. A DNS change, failover or new load balancer moves traffic like this.`,
      regions: change.regions.sort(),
    });
  }

  for (const change of regionalChanges(input.certificates, (r) => r.fingerprint)) {
    const issuer = change.value.issuer ? `issued by ${change.value.issuer}` : "a new certificate";
    const until = change.value.validTo ? `, valid until ${change.value.validTo.slice(0, 10)}` : "";
    events.push({
      at: change.at.toISOString(),
      kind: "certificate",
      title: "TLS certificate changed",
      detail: `Now ${issuer}${until}.`,
      regions: change.regions.sort(),
    });
  }

  for (const deploy of input.deploys ?? []) {
    const what = deploy.service ? `${deploy.service} ${deploy.version}` : deploy.version;
    events.push({
      at: deploy.deployedAt.toISOString(),
      kind: "deploy",
      title: `Deployed ${what}${deploy.environment ? ` to ${deploy.environment}` : ""}`,
      detail: deploy.description,
      regions: [],
    });
  }

  for (const at of input.configChanges) {
    const created = Math.abs(at.getTime() - input.createdAt.getTime()) < 2_000;
    events.push({
      at: at.toISOString(),
      kind: "config",
      title: created ? "Monitor created" : "Monitor settings changed",
      detail: created ? null : "Someone edited, paused or resumed this monitor.",
      regions: [],
    });
  }

  const { recent, baseline } = input.latency;
  if (
    recent.averageMs !== null &&
    baseline.averageMs !== null &&
    recent.count >= 2 &&
    baseline.count >= 3 &&
    recent.averageMs >= baseline.averageMs * 2 &&
    recent.averageMs - baseline.averageMs >= 100
  ) {
    events.push({
      at: new Date(input.before.getTime() - 3_600_000).toISOString(),
      kind: "latency",
      title: `Response time rose from ${Math.round(baseline.averageMs)} ms to ${Math.round(recent.averageMs)} ms`,
      detail:
        "In the hour before, successful checks got much slower — often load building up before a failure.",
      regions: [],
    });
  }

  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

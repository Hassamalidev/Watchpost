/*
 * Competitor facts for the comparison pages and the per-seat calculator (PRODUCT.md §3, Appendix C).
 * Prices are what the listed sources reported on CHECKED_ON, not quotes from the vendors' own pages;
 * every page shows the date and the sources. Re-verify before changing a number.
 */
export const CHECKED_ON = "2026-09-30";

export interface Competitor {
  slug: string;
  name: string;
  /* What kind of tool it is, in a few words. */
  model: string;
  /* Reported pricing, as a sentence. */
  pricing: string;
  /* Where it fits well; a fair comparison says so. */
  goodFit: string;
  /* How Watchpost differs. Only things that exist or are marked as planned. */
  differences: string[];
  sources: string[];
}

export const COMPETITORS: readonly Competitor[] = [
  {
    slug: "uptimerobot",
    name: "UptimeRobot",
    model: "Hosted uptime monitoring",
    pricing:
      "Free plan with 50 monitors at 5-minute checks. Paid plans were reported in August 2026 at about $13 (Solo), $46 (Team) and $98 (Scale, 200 monitors) a month.",
    goodFit:
      "A large number of simple checks on the free plan, if 5-minute intervals are enough and the free-plan terms suit your use.",
    differences: [
      "The Watchpost free plan checks every 3 minutes and allows commercial use.",
      "A failure is rechecked from other regions before anyone is alerted.",
      "Every alert carries the likely cause, what to check first and the timings from each region.",
      "Marking an incident as a false alarm returns the SMS and voice credits it used (planned with SMS and voice alerts).",
    ],
    sources: [
      "https://hyperping.com/blog/uptimerobot-pricing",
      "https://uptimesignal.io/vs/uptimerobot",
      "https://blog.sporkops.com/blog/uptimerobot-pricing-alternative/",
    ],
  },
  {
    slug: "better-stack",
    name: "Better Stack",
    model: "Monitoring, on-call and observability suite",
    pricing:
      "Reported at about $29 per responder a month billed annually ($34 monthly), with 10 monitors included and about $21 to $25 for each further 50.",
    goodFit:
      "Teams that also want logs and tracing from the same vendor, which Watchpost does not offer.",
    differences: [
      "Flat plans: Pro and Business have unlimited team members, so the bill does not grow with the team.",
      "Monitors are included in the plan (150 on Pro, 500 on Business) instead of sold in packs.",
      "Watchpost stays focused on uptime, alerts and status pages; it has no logs or tracing.",
    ],
    sources: [
      "https://hyperping.com/compare/betterstack-alternative",
      "https://oneuptime.com/compare/better-uptime",
    ],
  },
  {
    slug: "pagerduty",
    name: "PagerDuty",
    model: "Enterprise on-call and incident response",
    pricing:
      "Professional was reported at about $21 per user a month billed annually ($25 monthly) and Business at about $41 ($49 monthly). Status pages are a paid add-on.",
    goodFit:
      "Large organizations that need deep on-call scheduling and already have monitoring elsewhere.",
    differences: [
      "Watchpost runs the uptime checks itself; PagerDuty needs another tool to detect the outage.",
      "Flat plans with unlimited members on Pro and Business instead of a price per user.",
      "Watchpost can open, acknowledge and resolve PagerDuty incidents, so the two can run side by side.",
      "On-call schedules and escalation policies in Watchpost are planned, not available yet.",
    ],
    sources: [
      "https://incident.io/blog/pagerduty-pricing-breakdown-2026",
      "https://spike.sh/blog/pagerduty-pricing-breakdown-2026/",
    ],
  },
  {
    slug: "opsgenie",
    name: "Opsgenie",
    model: "On-call and alerting (Atlassian)",
    pricing:
      "New sales ended on June 4, 2025. Support ends on April 5, 2027, and data that has not been migrated by then is deleted.",
    goodFit:
      "Existing customers until the end-of-support date; Atlassian points them to Jira Service Management.",
    differences: [
      "Watchpost can send alerts to Opsgenie or Jira Service Management today, so you can try it next to your current setup.",
      "On-call schedules, escalation policies and an importer for Opsgenie schedules and escalations are included.",
      "Monitoring, alerting and status pages come in one flat plan.",
    ],
    sources: [
      "https://www.servicerocket.com/resources/opsgenie-end-of-support-what-it-means-and-what-to-do-next",
      "https://alertops.com/blogs/opsgenie-end-of-life/",
    ],
  },
  {
    slug: "uptime-kuma",
    name: "Uptime Kuma",
    model: "Free, open-source, self-hosted monitoring (MIT)",
    pricing: "Free. You pay for the server it runs on and the time to maintain it.",
    goodFit:
      "People who want to self-host, check from one location and are happy to maintain the server.",
    differences: [
      "Watchpost is hosted, so it does not go down together with the server it is watching.",
      "Checks run from more than one region and a failure is confirmed before it alerts.",
      "No server to patch, back up or upgrade.",
      "Monitors can be imported from an Uptime Kuma backup. Private probes for internal services are planned, not available yet.",
    ],
    sources: [
      "https://github.com/louislam/uptime-kuma",
      "https://dev.co/devops/open-source/uptime-kuma",
    ],
  },
];

export const findCompetitor = (slug: string) => COMPETITORS.find((c) => c.slug === slug);

/* Per-user tools in the calculator: USD per user per month, billed annually, as reported. */
export const PER_SEAT_TOOLS = [
  { key: "better-stack", name: "Better Stack", perSeat: 29 },
  { key: "pagerduty", name: "PagerDuty Professional", perSeat: 21 },
] as const;

/* Watchpost Pro billed annually: flat, unlimited members. */
export const FLAT_PRO_MONTHLY = 24;
export const MAX_TEAM_SIZE = 200;

export interface SeatComparison {
  key: string;
  name: string;
  monthly: number;
  /* What the team pays more per year than on Watchpost Pro; never below zero. */
  yearlyDifference: number;
}

export function compareSeatCost(teamSize: number): SeatComparison[] {
  const size = Math.min(MAX_TEAM_SIZE, Math.max(1, Math.floor(teamSize) || 1));
  return PER_SEAT_TOOLS.map((tool) => {
    const monthly = tool.perSeat * size;
    return {
      key: tool.key,
      name: tool.name,
      monthly,
      yearlyDifference: Math.max(0, (monthly - FLAT_PRO_MONTHLY) * 12),
    };
  });
}

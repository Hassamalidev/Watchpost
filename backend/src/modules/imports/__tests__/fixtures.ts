/*
 * Exports shaped like the real ones (UptimeRobot `getMonitors`, an Uptime Kuma backup, Better
 * Stack's monitors and heartbeats lists, Opsgenie schedules and escalations): forty-odd objects
 * each, mostly ordinary, with the odd one we can't bring over.
 */
const sites = [
  "shop",
  "api",
  "checkout",
  "auth",
  "search",
  "cdn",
  "docs",
  "blog",
  "status",
  "admin",
  "billing",
  "mail",
  "files",
  "media",
  "graphql",
  "webhooks",
  "partners",
  "careers",
  "help",
  "app",
];

export function uptimeRobotFixture() {
  const monitors: Record<string, unknown>[] = [];
  sites.forEach((site, i) => {
    monitors.push({
      id: 1000 + i,
      friendly_name: `${site} website`,
      url: `https://${site}.example.com/`,
      type: 1,
      interval: i % 3 === 0 ? 60 : 300,
      status: 2,
    });
  });
  for (let i = 0; i < 8; i += 1) {
    monitors.push({
      id: 2000 + i,
      friendly_name: `${sites[i]} keyword`,
      url: `https://${sites[i]}.example.com/health`,
      type: 2,
      keyword_type: i % 2 === 0 ? 2 : 1,
      keyword_value: i % 2 === 0 ? "ok" : "error",
      interval: 300,
    });
  }
  for (let i = 0; i < 5; i += 1) {
    monitors.push({
      id: 3000 + i,
      friendly_name: `ping db-${i}`,
      url: `db-${i}.example.com`,
      type: 3,
      interval: 120,
    });
  }
  for (let i = 0; i < 5; i += 1) {
    monitors.push({
      id: 4000 + i,
      friendly_name: `port ${[22, 25, 443, 5432, 6379][i]}`,
      url: `host-${i}.example.com`,
      type: 4,
      sub_type: 99,
      port: [22, 25, 443, 5432, 6379][i],
      interval: 300,
    });
  }
  for (let i = 0; i < 4; i += 1) {
    monitors.push({ id: 5000 + i, friendly_name: `nightly job ${i}`, type: 5, interval: 86_400 });
  }
  /* What we can't read: a keyword monitor that lost its keyword, and a type that doesn't exist. */
  monitors.push({
    id: 6000,
    friendly_name: "broken keyword",
    url: "https://x.example.com",
    type: 2,
  });
  monitors.push({ id: 6001, friendly_name: "mystery", url: "https://y.example.com", type: 9 });
  return { stat: "ok", pagination: { offset: 0, limit: 50, total: monitors.length }, monitors };
}

export function uptimeKumaFixture() {
  const monitorList: Record<string, unknown>[] = [];
  sites.forEach((site, i) => {
    monitorList.push({
      id: i + 1,
      name: `${site} (kuma)`,
      type: "http",
      url: `https://${site}.internal.example.com`,
      interval: 60,
      accepted_statuscodes: ["200-299"],
      upsideDown: i === 3,
    });
  });
  for (let i = 0; i < 6; i += 1) {
    monitorList.push({
      id: 100 + i,
      name: `kuma keyword ${i}`,
      type: "keyword",
      url: `https://${sites[i]}.example.com/ready`,
      keyword: "ready",
      invertKeyword: i === 5,
      interval: 120,
    });
  }
  for (let i = 0; i < 5; i += 1) {
    monitorList.push({
      id: 200 + i,
      name: `kuma ping ${i}`,
      type: "ping",
      hostname: `10.0.0.${i + 1}`,
      interval: 60,
    });
  }
  for (let i = 0; i < 4; i += 1) {
    monitorList.push({
      id: 300 + i,
      name: `kuma port ${i}`,
      type: "port",
      hostname: `svc-${i}.example.com`,
      port: 8080 + i,
      interval: 60,
    });
  }
  for (let i = 0; i < 3; i += 1) {
    monitorList.push({
      id: 400 + i,
      name: `kuma dns ${i}`,
      type: "dns",
      hostname: `example${i}.com`,
      dns_resolve_type: ["A", "MX", "TXT"][i],
      interval: 300,
    });
  }
  for (let i = 0; i < 3; i += 1) {
    monitorList.push({ id: 500 + i, name: `kuma push ${i}`, type: "push", interval: 600 });
  }
  /* Checks that only work inside the network. */
  monitorList.push({ id: 600, name: "postgres primary", type: "postgres", interval: 60 });
  monitorList.push({ id: 601, name: "docker: worker", type: "docker", interval: 60 });
  return { version: "1.23.13", notificationList: [], monitorList };
}

export function betterStackFixture() {
  const data: Record<string, unknown>[] = [];
  sites.forEach((site, i) => {
    data.push({
      id: String(i + 1),
      type: "monitor",
      attributes: {
        url: `https://${site}.example.org`,
        pronounceable_name: `${site} (better stack)`,
        monitor_type: i % 4 === 0 ? "expected_status_code" : "status",
        check_frequency: i % 2 === 0 ? 30 : 180,
      },
    });
  });
  for (let i = 0; i < 6; i += 1) {
    data.push({
      id: String(100 + i),
      attributes: {
        url: `https://${sites[i]}.example.org/health`,
        pronounceable_name: `bs keyword ${i}`,
        monitor_type: i === 0 ? "keyword_absence" : "keyword",
        required_keyword: i === 0 ? "maintenance" : "healthy",
        check_frequency: 180,
      },
    });
  }
  for (let i = 0; i < 4; i += 1) {
    data.push({
      id: String(200 + i),
      attributes: {
        url: `edge-${i}.example.org`,
        pronounceable_name: `bs ping ${i}`,
        monitor_type: "ping",
        check_frequency: 60,
      },
    });
  }
  for (let i = 0; i < 4; i += 1) {
    data.push({
      id: String(300 + i),
      attributes: {
        url: `tcp-${i}.example.org`,
        port: String(5000 + i),
        pronounceable_name: `bs tcp ${i}`,
        monitor_type: "tcp",
        check_frequency: 60,
      },
    });
  }
  data.push({
    id: "400",
    attributes: {
      url: "https://shop.example.org/login",
      pronounceable_name: "login flow",
      monitor_type: "playwright",
      check_frequency: 600,
    },
  });
  data.push({
    id: "401",
    attributes: {
      url: "mail.example.org",
      pronounceable_name: "smtp",
      monitor_type: "smtp",
      check_frequency: 300,
    },
  });
  const heartbeats = Array.from({ length: 6 }, (_, i) => ({
    id: String(500 + i),
    attributes: { name: `bs heartbeat ${i}`, period: 3_600 * (i + 1), grace: 300 },
  }));
  return { monitors: { data }, heartbeats: { data: heartbeats } };
}

export function opsgenieFixture(emails: { a: string; b: string }) {
  const schedules: Record<string, unknown>[] = [];
  for (let i = 0; i < 20; i += 1) {
    schedules.push({
      id: `sch-${i}`,
      name: `Team ${i} schedule`,
      timezone: i % 2 === 0 ? "Europe/Berlin" : "America/New_York",
      rotations: [
        {
          name: "Primary",
          type: i % 3 === 0 ? "daily" : "weekly",
          length: i === 4 ? 2 : 1,
          startDate: "2026-09-07T08:00:00Z",
          participants: [
            { type: "user", username: emails.a },
            { type: "user", username: emails.b },
            ...(i === 2 ? [{ type: "user", username: "left@example.com" }] : []),
          ],
        },
      ],
    });
  }
  /* A schedule of people who aren't members here. */
  schedules.push({
    id: "sch-ghost",
    name: "Contractors",
    timezone: "UTC",
    rotations: [
      {
        type: "weekly",
        length: 1,
        startDate: "2026-09-07T08:00:00Z",
        participants: [{ type: "user", username: "nobody@example.com" }],
      },
    ],
  });
  const escalations: Record<string, unknown>[] = [];
  for (let i = 0; i < 20; i += 1) {
    escalations.push({
      id: `esc-${i}`,
      name: `Team ${i} escalation`,
      rules: [
        { delay: { timeAmount: 0 }, recipient: { type: "schedule", name: `Team ${i} schedule` } },
        { delay: { timeAmount: 10 }, recipient: { type: "user", username: emails.a } },
        { delay: { timeAmount: 25 }, recipient: { type: "user", username: emails.b } },
      ],
      repeat: { count: i % 3 },
    });
  }
  escalations.push({
    id: "esc-ghost",
    name: "Vendor escalation",
    rules: [{ delay: { timeAmount: 0 }, recipient: { type: "team", name: "Vendors" } }],
  });
  return { schedules, escalations };
}

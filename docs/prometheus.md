# Prometheus endpoint and status widget

## Prometheus

`GET /api/v1/metrics` answers with the workspace's monitors in the Prometheus text format (0.0.4). It is part of the public API (`docs/api.md`): the same API keys, with the `monitors:read` scope, and the same limit of 120 requests a minute per key.

```yaml
scrape_configs:
  - job_name: uptime
    scheme: https
    metrics_path: /api/v1/metrics
    scrape_interval: 60s
    authorization:
      type: Bearer
      credentials: wp_...
    static_configs:
      - targets: ["YOUR-HOST"]
```

Scrape once a minute or slower: values change when checks run, and a scrape reads every monitor.

| Metric                                 | Labels                            | Value                                                                                                                                            |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uptime_monitor_up`                    | `monitor_id`, `monitor`, `type`   | 1 when up (also while a failure is being re-checked, and in maintenance), 0 when down or degraded. Absent while paused or before the first check |
| `uptime_monitor_status`                | … plus `status`                   | Always 1; the status is the label (`up`, `verifying`, `degraded`, `down`, `maintenance`, `paused`, `pending`)                                    |
| `uptime_monitor_paused`                | …                                 | 1 when checks are paused                                                                                                                         |
| `uptime_monitor_uptime_ratio`          | … plus `window` (`24h`, `30d`)    | Share of the window the monitor was up, 0 to 1                                                                                                   |
| `uptime_monitor_response_time_seconds` | … plus `quantile` (`0.5`, `0.95`) | Response time of successful checks in the last 24 hours                                                                                          |
| `uptime_monitor_checks_24h`            | …                                 | Checks run in the last 24 hours, all regions together                                                                                            |

- Uptime is the same calculation as on monitor pages, status pages and SLA reports: recorded outages over time, planned maintenance left out.
- Response times come from hourly rollups, so the current hour is not in them yet.
- A workspace with more than 2,000 monitors gets the first 2,000.
- The names carry no product name on purpose, so dashboards and alert rules survive a rename.

An alert rule for "down for five minutes":

```yaml
- alert: MonitorDown
  expr: uptime_monitor_up == 0
  for: 5m
  annotations:
    summary: "{{ $labels.monitor }} is down"
```

## Status widget

Every published status page has a small image of its overall state:

```
https://YOUR-HOST/api/public/status-widget/<page address>.svg
```

It says `status | all systems operational` (or degraded performance, partial outage, major outage, under maintenance) in the matching colour. The status page editor shows it with HTML and Markdown to paste:

```html
<a href="https://status.example.com"
  ><img src="https://YOUR-HOST/api/public/status-widget/acme.svg" alt="Acme status" height="20"
/></a>
```

- Public, like the page; an unpublished or unknown page answers 404 with a grey "page not found" image.
- Cached for a minute, by us and by browsers and CDNs.
- It is an image and nothing else: it can't run scripts wherever it is embedded.
- Per-monitor badges (status, uptime, response time) are on each monitor's page.

## For developers of this codebase

Both live in `backend/src/modules/badges` (`embeds.ts`, `metrics.ts`). The metrics route is a public API route with a text answer (`text` on `publicRoute`).

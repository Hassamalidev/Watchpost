# PagerDuty

Watchpost sends incidents to a PagerDuty service through the Events API v2 and keeps the alert's
state in step with the incident:

| In Watchpost       | In PagerDuty                                                                       |
| ------------------ | ---------------------------------------------------------------------------------- |
| Incident triggered | Alert triggered (severity: critical → `critical`, high → `error`, low → `warning`) |
| Acknowledged       | Alert acknowledged                                                                 |
| Resolved           | Alert resolved                                                                     |
| Reminder, flapping | Trigger with the same key: added to the open alert                                 |

Every event of an incident carries the dedup key `watchpost-<incident ID>`, so one incident is one
PagerDuty alert. If someone resolves the alert in PagerDuty while the incident is still open here, the
next reminder opens it again. Needs no server configuration.

## Setup (workspace admin)

1. In PagerDuty: the service → **Integrations → Add an integration → Events API V2**.
2. Copy the **Integration Key** (32 characters).
3. In Watchpost: Integrations → PagerDuty → paste the key, pick the region (accounts at
   `*.eu.pagerduty.com` are Europe) → **Save**.

New PagerDuty channels start with **High and critical only**, so certificate and domain expiry
warnings (low severity) don't page anyone. Change it under "What to send here".

The key is write-only: after saving, Watchpost shows `********`.

## Send test

A test triggers an `info` alert under its own key (`watchpost-test-…`) and resolves it straight
away. It is a real alert: depending on the service's settings, whoever is on call may be notified.
Watchpost asks before sending it and never sends one automatically.

## Delivery

- Retries run for about 20 minutes (8 attempts). 400 (malformed event or unknown key) stops them;
  429 and 5xx are retried.

## Owner checklist

- [ ] "Send test" (after confirming) opens and resolves a "Test alert from Watchpost" alert.
- [ ] A real outage opens one alert with the summary, source (the monitor), failing regions and a
      link back to the incident.
- [ ] Acknowledge and resolve in Watchpost change the same alert in PagerDuty.
- [ ] A low-severity incident (an expiring certificate) does not page with the default rules.

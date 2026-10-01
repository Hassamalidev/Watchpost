# Splunk On-Call (VictorOps)

Watchpost posts to Splunk On-Call's generic REST endpoint. One incident is one entity
(`watchpost-<incident ID>`), so its later events change the same incident there:

| In Watchpost                 | `message_type`                       |
| ---------------------------- | ------------------------------------ |
| Triggered (critical or high) | `CRITICAL`                           |
| Triggered (low)              | `WARNING`                            |
| Acknowledged                 | `ACKNOWLEDGEMENT`                    |
| Resolved                     | `RECOVERY`                           |
| Send test                    | `INFO` (timeline only, pages nobody) |

Each message carries a link back to the incident (`vo_annotate.u.Incident`). Needs no server
configuration.

## Setup (workspace admin)

1. In Splunk On-Call: **Integrations → 3rd Party Integrations → REST – Generic**, enable it.
2. Copy the endpoint URL. It ends with `$routing_key`: replace that with one of your routing keys
   (**Settings → Routing Keys**).
3. In Watchpost: Integrations → Splunk On-Call → paste the URL → **Save and send test**.

The URL holds the API key, so it is write-only: after saving, Watchpost shows only
`https://alert.victorops.com/********`. New channels start with **High and critical only**.

## Delivery

- Retries run for about 20 minutes. 401, 403 and 404 stop them, and so does an answer of
  `"result": "failure"` (the alert itself was refused). Splunk documents no other status codes, so
  everything else is retried.

## Owner checklist

- [ ] "Send test" shows an INFO entry on the timeline without paging.
- [ ] A real outage opens one incident routed by your routing key, with a link to Watchpost.
- [ ] Acknowledge and resolve in Watchpost acknowledge and recover the same incident.

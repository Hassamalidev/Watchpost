# Zapier, Make and n8n

These tools start a workflow from a webhook, and Watchpost's [outbound webhook](webhook.md) sends one
signed JSON request per incident event. The gallery has an entry for each so the setup steps are at
hand; all three create a webhook channel.

Useful fields to map: `type` (`incident.triggered`, `incident.acknowledged`, `incident.resolved`,
`incident.reminder`, `incident.flapping`, `incident.test`), `incident.title`, `incident.severity`,
`incident.url`, `monitor.name` and `explanation.headline`. `id` is the same on retries: use it to
deduplicate.

## Zapier

1. Create a Zap with the trigger **Webhooks by Zapier → Catch Hook** and copy its URL.
2. In Watchpost: Integrations → Zapier → paste the URL → **Save and send test**.
3. In Zapier, test the trigger (the test event appears) and map the fields into your action.

## Make

1. Add a **Webhooks → Custom webhook** module to a scenario and copy its address.
2. In Watchpost: Integrations → Make → paste the address → **Save and send test**, so Make learns
   the data structure.

## n8n

1. Add a **Webhook** node with the method POST and copy its **production** URL (the test URL only
   works while the editor listens).
2. In Watchpost: Integrations → n8n → paste the URL. If the node uses header authentication, add
   that header under "Request headers" → **Save and send test**.

A self-hosted n8n must be reachable from the internet; Watchpost refuses private addresses.

## Filtering

Each channel has its own rules ("What to send here"): the lowest severity it accepts and which
events. Filter there rather than in the workflow, so tasks aren't spent on events you drop.

## Owner checklist

- [ ] "Send test" reaches each tool and shows `type: incident.test`.
- [ ] A real outage and its recovery arrive as `incident.triggered` and `incident.resolved`.
- [ ] A header set in Watchpost (for example `Authorization`) arrives with the request.

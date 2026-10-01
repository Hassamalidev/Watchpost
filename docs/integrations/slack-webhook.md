# Slack alerts through an incoming webhook

For teams that can't or don't want to install the Watchpost Slack app. A webhook posts to the one
channel chosen when it was created. Messages look the same as the app's (Block Kit with an "Open
incident" button), but Slack gives webhooks no message ID, so follow-ups are new messages instead of
thread replies. Needs no server configuration.

## Setup (workspace admin)

1. At https://api.slack.com/apps create an app ("From scratch") and turn on **Incoming Webhooks**.
2. **Add New Webhook to Workspace**, pick the channel, and copy the URL
   (`https://hooks.slack.com/services/T…/B…/…`).
3. In Watchpost: Integrations → Slack (incoming webhook) → paste the URL → **Save and send test**.

Workflow Builder URLs (`https://hooks.slack.com/triggers/…`) are a different contract and are refused.

## Delivery

- 400 (`invalid_payload`), 403, 404 and 410 (webhook revoked, channel archived) stop retries at once.
- 429 and 5xx are retried. Slack allows about one message per second per webhook.
- Slack revokes webhook URLs it finds leaked in public; the channel then shows **failing**.

## Owner checklist

- [ ] "Send test" posts "🧪 TEST · Watchpost" to the channel.
- [ ] A real outage posts "🔴 DOWN · <monitor>" with the facts and an "Open incident" button.
- [ ] After saving, the URL is shown only as `https://hooks.slack.com/********`.
- [ ] Removing the webhook in Slack makes the next alert fail without retries.

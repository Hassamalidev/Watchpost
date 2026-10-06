# Discord alerts

## Setup (workspace admin)

1. In Discord: Server Settings → Integrations → Webhooks → **New Webhook**, pick the channel, copy
   the webhook URL (`https://discord.com/api/webhooks/<id>/<token>`).
2. In Watchpost: Integrations → Add channel → Discord → paste the URL → **Send test**.

## Owner checklist

- [ ] "Send test" posts a blue "Test alert from Watchpost" embed.
- [ ] A real outage posts a red embed whose title links to the incident, with Monitor, Severity,
      Cause and Regions.
- [ ] Resolve posts a green embed, and the first embed turns green too.
- [ ] Deleting the webhook in Discord makes the next alert fail without retries and marks the channel
      failing.

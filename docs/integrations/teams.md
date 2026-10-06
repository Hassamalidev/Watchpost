# Microsoft Teams alerts (Workflows webhook)

Teams "Incoming Webhook" connectors are retired; Watchpost posts through a Teams **Workflows**
webhook. Messages appear as the Workflows bot. A two-way Teams app arrives in P6.

## Setup (workspace admin)

1. In Teams, open the channel → **… → Workflows** → template **"Send webhook alerts to a channel"**
   (the name may vary slightly by tenant).
2. Name it, pick the team and channel, create it, and copy the URL it shows.
3. In Watchpost: Integrations → Add channel → Microsoft Teams → paste the URL → **Send test**.

The URL must be an https URL on a Power Automate / Logic Apps host (`*.powerplatform.com`,
`*.logic.azure.com`, `*.powerautomate.com`, and the US government and China cloud hosts). Old
Office 365 connector URLs (`*.webhook.office.com`) are refused with a hint: Microsoft switched them
off in May 2026. The URL is write-only: after saving, Watchpost shows only its host.

## Owner checklist

- [ ] "Send test" shows an Adaptive Card titled "Test alert from Watchpost" in the channel.
- [ ] A real outage shows the incident title in red with Monitor, Severity, Cause, Regions, Started
      and an **Open incident** button that opens the incident.
- [ ] Resolve posts a green "Resolved after …" card.
- [ ] Turning the workflow off (or deleting it) makes the next alert fail without retries, marks the
      channel failing and emails the workspace admins. Note: a flow can stop working when the account
      that created it leaves the tenant.

# Integrations

One page per integration: how a workspace admin sets it up, how delivery behaves, and how the owner
confirms real delivery before a release. Automated tests cover every adapter against mocked provider
APIs; the checklists cover what mocks can't — the real provider accepting and showing our messages.

In the app, Integrations has a searchable gallery; each entry opens a setup page with these steps.
The catalog (names, categories, form fields, which fields are secret) lives in
`packages/shared/src/integrations/catalog.ts`; adding an integration means a config schema, an
adapter and a catalog entry.

| Integration              | Category   | Setup                                | Follow-ups                      | Server config needed                                                     | Guide                                  |
| ------------------------ | ---------- | ------------------------------------ | ------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- |
| Slack (app)              | Chat       | "Add to Slack" (OAuth), pick channel | Thread + first message updates  | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`                                 | [slack.md](slack.md)                   |
| Slack (incoming webhook) | Chat       | Paste a webhook URL                  | New messages                    | none                                                                     | [slack-webhook.md](slack-webhook.md)   |
| Microsoft Teams          | Chat       | Paste a Workflows webhook URL        | New messages                    | none                                                                     | [teams.md](teams.md)                   |
| Discord                  | Chat       | Paste a channel webhook URL          | First message updates           | none                                                                     | [discord.md](discord.md)               |
| Telegram                 | Chat       | Open our bot's link                  | Replies + first message updates | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` | [telegram.md](telegram.md)             |
| Google Chat              | Chat       | Paste a webhook URL                  | Thread                          | none                                                                     | [google-chat.md](google-chat.md)       |
| Mattermost               | Chat       | Paste a webhook URL                  | New messages                    | none                                                                     | [mattermost.md](mattermost.md)         |
| Rocket.Chat              | Chat       | Paste a webhook URL                  | New messages                    | none                                                                     | [rocketchat.md](rocketchat.md)         |
| Zulip                    | Chat       | Bot email + API key + channel        | Topic per monitor               | none                                                                     | [zulip.md](zulip.md)                   |
| Matrix                   | Chat       | Homeserver + access token + room ID  | Thread                          | none                                                                     | [matrix.md](matrix.md)                 |
| PagerDuty                | On-call    | Integration key + region             | Same alert: ack, resolve        | none                                                                     | [pagerduty.md](pagerduty.md)           |
| Opsgenie                 | On-call    | API key + region                     | Same alert: ack, close          | none                                                                     | [opsgenie.md](opsgenie.md)             |
| Jira Service Management  | On-call    | API key                              | Same alert: ack, close          | none                                                                     | [opsgenie.md](opsgenie.md)             |
| Splunk On-Call           | On-call    | Paste the REST endpoint URL          | Same incident: ack, recovery    | none                                                                     | [splunk-on-call.md](splunk-on-call.md) |
| Pushover                 | Push       | User key + application token         | New notifications               | none                                                                     | [pushover.md](pushover.md)             |
| ntfy                     | Push       | Server + topic (+ token)             | Notification replaced           | none                                                                     | [ntfy.md](ntfy.md)                     |
| Pushbullet               | Push       | Access token (+ channel tag)         | New notifications               | none                                                                     | [pushbullet.md](pushbullet.md)         |
| Gotify                   | Push       | Server URL + application token       | New notifications               | none                                                                     | [gotify.md](gotify.md)                 |
| SMS                      | Phone      | Verified phone number                | New messages; reply 1 or 2      | Twilio (`TWILIO_*`), alert credits                                       | [sms.md](sms.md)                       |
| Voice call               | Phone      | Verified phone number                | New and ongoing incidents only  | Twilio with `TWILIO_VOICE_FROM`, alert credits                           | [voice.md](voice.md)                   |
| Email                    | Email      | Addresses                            | New emails                      | Email transport (Resend)                                                 | [email.md](email.md)                   |
| Webhook                  | Automation | URL (+ headers)                      | One request per event           | none                                                                     | [webhook.md](webhook.md)               |
| Zapier, Make, n8n        | Automation | Paste the tool's webhook URL         | One request per event           | none                                                                     | [automation.md](automation.md)         |

Inbound: [deploys.md](deploys.md) records deploys from CI or GitHub so incidents can name a recent deploy.

## What every integration has

- **Send test** (`POST /api/w/:ws/channels/:id/test`, admins): one test alert right away, answered
  with `{ ok: true }` or `{ ok: false, error }`. Saving a new integration sends one automatically.
  On-call tools (PagerDuty, Opsgenie) are the exception: a test there is a real alert, so the app
  asks first.
- **Its own rules** ("What to send here"): the lowest severity it accepts (all, high and critical,
  critical only) and which events (down, acknowledged, resolved, reminders, flapping notices). The
  alert policy decides which integrations are asked; the rules decide what each accepts. On-call
  tools start at high and critical, so expiry warnings don't page. "Send test" ignores the rules.
- **Write-only secrets**: keys, tokens and secret URLs are stored encrypted and never returned. The
  API answers `********` (for a URL, `https://host/********`). On update, an empty or masked value
  keeps the stored one, unless the server it is sent to changed: then it must be entered again.
- **Health**: after the last failed attempt the integration shows **failing** with the provider's
  error, the incident timeline records `delivery_failed`, and owners and admins get one email per
  hour about failing integrations. The next successful delivery marks it healthy again.
- **Routing check**: the list flags an integration that no alert policy sends to.

## How delivery behaves

- Alerts are retried with backoff: 5 attempts over about 2 minutes; on-call tools 8 attempts over
  about 20 minutes; webhooks 9 attempts over about an hour. Errors that retrying can't fix (a
  deleted webhook, a revoked key) stop at once.
- Outbound requests never reach private or internal addresses (the same SSRF rules as probes), so
  self-hosted tools (Mattermost, Rocket.Chat, Zulip, Matrix, ntfy, Gotify, n8n) must be reachable
  from the internet over HTTPS.

## Owner release checklist

Use a staging workspace. For each integration, tick every line of its guide's checklist and note the
date and the build. Needing accounts: Slack, Teams, Discord, Telegram, Google Chat, PagerDuty,
Opsgenie or JSM, Splunk On-Call, Pushover, Pushbullet, Zapier, Make. Self-hostable for the check:
Mattermost, Rocket.Chat, Zulip, Matrix, ntfy, Gotify, n8n.

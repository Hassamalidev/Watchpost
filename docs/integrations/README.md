# Alert channel integrations

One page per channel: how a workspace admin sets it up, and how the owner confirms real delivery
before a release (P1-T13 acceptance). Automated tests cover every adapter against mocked provider
APIs; these checklists cover what mocks can't — the real provider accepting and showing our messages.

| Channel         | Setup                         | Server config needed                                                     | Guide                      |
| --------------- | ----------------------------- | ------------------------------------------------------------------------ | -------------------------- |
| Email           | Addresses                     | Email transport (Resend from P1-T18)                                     | [email.md](email.md)       |
| Slack           | "Add to Slack" (OAuth)        | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`                                 | [slack.md](slack.md)       |
| Microsoft Teams | Paste a Workflows webhook URL | none                                                                     | [teams.md](teams.md)       |
| Discord         | Paste a channel webhook URL   | none                                                                     | [discord.md](discord.md)   |
| Telegram        | Open our bot's link           | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` | [telegram.md](telegram.md) |
| Webhook         | URL (+ optional secret)       | none                                                                     | [webhook.md](webhook.md)   |

Inbound: [deploys.md](deploys.md) records deploys from CI or GitHub so incidents can name a recent deploy.

## Owner release checklist

Use a staging workspace. For each channel, tick every line and note the date and the build.

- [ ] Email — [checklist](email.md#owner-checklist)
- [ ] Slack — [checklist](slack.md#owner-checklist)
- [ ] Teams — [checklist](teams.md#owner-checklist)
- [ ] Discord — [checklist](discord.md#owner-checklist)
- [ ] Telegram — [checklist](telegram.md#owner-checklist)
- [ ] Webhook — [checklist](webhook.md#owner-checklist)

## How delivery behaves (all channels)

- **Send test** (`POST /api/w/:ws/channels/:id/test`, admins) sends one test alert right away and
  returns `{ ok: true }` or `{ ok: false, error }`.
- Alerts are retried with backoff: 5 attempts over about 2 minutes (webhooks: 9 attempts over about
  an hour). Errors that retrying can't fix (a deleted webhook, a revoked token) stop at once.
- After the last failure the channel shows **failing**, the incident timeline records
  `delivery_failed`, and workspace owners and admins get one email per hour about failing channels.
  The next successful delivery marks the channel healthy again.
- Follow-ups (acknowledged, resolved, reminders) thread under the first message where the provider
  allows it (Slack, Telegram) and update the first message (Slack, Discord, Telegram).
- Outbound requests never reach private or internal addresses (the same SSRF rules as probes).

# Rocket.Chat alerts

An incoming webhook integration posts the alert title and an attachment with a colored bar, a title
linking to the incident and the facts as fields. Follow-ups are new messages. Needs no server
configuration. The Rocket.Chat server must be reachable from the internet over HTTPS.

## Setup (workspace admin)

1. In Rocket.Chat: **Administration → Workspace → Integrations → New → Incoming**.
2. Enable it, choose the channel and the user to post as, and save.
3. Copy the **Webhook URL** (`https://<your server>/hooks/<id>/<token>`).
4. In Watchpost: Integrations → Rocket.Chat → paste the URL → **Save and send test**.

## Delivery

- 401, 403, 404 and 410 stop retries at once; other errors are retried.
- If the integration has a script that returns an error, Rocket.Chat answers `success: false`; we
  report the script's message and retry.

## Owner checklist

- [ ] "Send test" posts "Test alert from Watchpost" with a blue attachment.
- [ ] A real outage posts a red attachment whose title opens the incident; the recovery is green.
- [ ] Disabling the integration makes the next alert fail and marks the channel failing.

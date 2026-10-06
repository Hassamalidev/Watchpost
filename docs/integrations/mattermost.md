# Mattermost alerts

An incoming webhook posts an attachment with a colored bar (red, amber, green), a title linking to
the incident and the facts as fields. Mattermost webhooks can't thread or edit, so follow-ups are new
messages. Needs no server configuration.

The Mattermost server must be reachable from the internet over HTTPS. Watchpost refuses private and
internal addresses (the same rules as probes); servers inside your network are a job for private
probes later.

## Setup (workspace admin)

1. In Mattermost: **Integrations → Incoming Webhooks → Add Incoming Webhook**, pick the channel, save.
   (A system admin may need to enable incoming webhooks first.)
2. Copy the URL (`https://<your server>/hooks/<id>`; a sub-path before `/hooks/` is fine).
3. In Watchpost: Integrations → Mattermost → paste the URL → **Save and send test**.

## Delivery

- 401, 403, 404 and 410 stop retries at once. Other errors are retried, because what Mattermost
  answers for a bad request differs between versions.

## Owner checklist

- [ ] "Send test" posts a blue attachment titled "🧪 TEST".
- [ ] A real outage posts a red attachment whose title opens the incident, with the facts as fields;
      the recovery is green.
- [ ] Deleting the webhook makes the next alert fail and marks the channel failing.

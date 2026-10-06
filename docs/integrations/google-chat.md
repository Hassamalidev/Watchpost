# Google Chat alerts

A card in a Google Chat space with the state, the facts and an "Open incident" button. Every message
of an incident carries the same thread key, so acknowledgements, reminders and the recovery reply in
the first message's thread (spaces without threading get separate messages). Webhooks can't edit
messages. Needs no server configuration.

## Setup (workspace admin)

1. In the space: space menu → **Apps & integrations → Webhooks → Add webhook**, name it Watchpost.
2. Copy the URL (`https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=…`).
3. In Watchpost: Integrations → Google Chat → paste the URL → **Save and send test**.

## Delivery

- 400, 401, 403 and 404 (webhook deleted) stop retries at once; 429 and 5xx are retried.
- Google allows about one message per second per space, shared by all of its webhooks.

## Owner checklist

- [ ] "Send test" shows a card titled "🧪 TEST".
- [ ] A real outage shows "🔴 DOWN · <monitor>" with Monitor, Severity, Cause, Failing regions,
      Started, the likely cause and an **Open incident** button.
- [ ] Acknowledge and resolve arrive in the same thread as the first card.
- [ ] Deleting the webhook makes the next alert fail without retries.

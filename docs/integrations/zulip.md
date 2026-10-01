# Zulip alerts

A bot posts Markdown messages to a Zulip channel (stream) through the REST API. A Zulip topic is a
thread, so by default each monitor gets its own topic and an incident's follow-ups stay together.
Set a topic to send everything to one fixed topic instead. Needs no server configuration.

## Setup (workspace admin)

1. In Zulip: **Settings → Personal → Bots → Add a new bot**. The "Incoming webhook" type is enough.
2. Copy the bot's email and API key, and subscribe the bot to the channel.
3. In Watchpost: Integrations → Zulip → enter the server address (`https://<org>.zulipchat.com` or
   your own server), the bot's email and API key, and the channel name without `#`.
4. **Save and send test**.

The API key is write-only: after saving, Watchpost shows `********`. Changing the server address
means entering the key again.

## Delivery

- We send `type=stream`, which every Zulip version accepts (`channel` exists only from Zulip 9).
- 400 (unknown channel), 401 and 403 (bad key, deactivated bot) stop retries; 429 and 5xx are retried.
- Topics are cut to 60 characters.

## Owner checklist

- [ ] "Send test" posts to the channel under the topic "Watchpost" (or your fixed topic).
- [ ] A real outage posts under the monitor's name, with the facts as a list and an "Open incident" link.
- [ ] The recovery lands in the same topic.
- [ ] A wrong channel name fails "Send test" with Zulip's own message.

# Matrix alerts

A bot account posts to a room through the Matrix client-server API (works with Element, Synapse,
Dendrite and any spec-compliant homeserver). Messages carry plain text and HTML. Follow-ups are
thread replies under the incident's first message. Needs no server configuration.

## Setup (workspace admin)

1. Create a Matrix account for the bot, invite it to the room and accept the invite as the bot.
2. Copy the bot's access token (in Element: Settings → Help & About → Advanced → Access Token).
3. Copy the room's internal ID (Room settings → Advanced). It starts with `!`; an alias such as
   `#ops:example.org` is not accepted. Newer room versions have IDs without a server part.
4. In Watchpost: Integrations → Matrix → homeserver URL (for example `https://matrix.example.org`),
   access token, room ID → **Save and send test**.

Encrypted rooms: Watchpost sends unencrypted events, which clients flag in an encrypted room. Use an
unencrypted room for alerts.

## Delivery

- The delivery's ID is the transaction ID, so a retried send can't post twice.
- `M_FORBIDDEN`, `M_UNKNOWN_TOKEN`, `M_MISSING_TOKEN`, `M_NOT_FOUND` and `M_TOO_LARGE` stop retries;
  `M_LIMIT_EXCEEDED` (429) and server errors are retried.
- Logging the bot out invalidates its token. Create a token that stays valid (a dedicated session).

## Owner checklist

- [ ] "Send test" posts "🧪 Test alert from Watchpost" in the room.
- [ ] A real outage posts the facts with an "Open incident" link.
- [ ] Acknowledge and resolve appear in the thread of the first message.
- [ ] Removing the bot from the room makes the next alert fail without retries.

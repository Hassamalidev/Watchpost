# Pushbullet

A link push to all devices of the access token's owner, or to the subscribers of a Pushbullet
channel. Tapping it opens the incident. The delivery's ID is sent as the push's `guid`, so a retried
send can't notify twice. Needs no server configuration.

## Setup (workspace admin)

1. On https://www.pushbullet.com: **Settings → Account → Create Access Token**.
2. In Watchpost: Integrations → Pushbullet → paste the token.
3. To notify a team, create a Pushbullet channel, have people subscribe to it, and enter its tag.
   Leave the tag empty to push to your own devices.
4. **Save and send test**.

The token grants full access to the Pushbullet account, so use an account made for alerts. It is
write-only in Watchpost.

## Delivery

- 400, 401, 403 and 404 stop retries; 429 and 5xx are retried.
- Free Pushbullet accounts can send 500 pushes a month.

## Owner checklist

- [ ] "Send test" arrives on every device of the account (or the channel's subscribers).
- [ ] A real outage arrives as a link push that opens the incident.
- [ ] Revoking the token makes the next alert fail without retries.

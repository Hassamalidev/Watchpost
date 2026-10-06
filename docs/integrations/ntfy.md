# ntfy

Push notifications through https://ntfy.sh or your own ntfy server. Each notification has a priority
from the incident's severity, opens the incident when tapped, and has an "Open incident" button.
Every message of an incident carries the same sequence ID, so on Android and in the web app the
notification is replaced by its latest state instead of piling up. Needs no server configuration.

| Incident                   | ntfy priority |
| -------------------------- | ------------- |
| Critical, down or reminder | 5 (urgent)    |
| High, down or reminder     | 4 (high)      |
| Everything else            | 3 (default)   |

## Setup (workspace admin)

1. Pick a topic name that is hard to guess (for example `acme-alerts-8f3k2`): on a public server,
   anyone who knows the name can read your alerts.
2. Subscribe to the topic in the ntfy app.
3. In Watchpost: Integrations → ntfy → server (leave `https://ntfy.sh`, or enter your own), topic,
   and an access token if the topic is protected → **Save and send test**.

**On ntfy.sh, add an access token.** Anonymous messages are limited per sending address, and
Watchpost's servers send for many workspaces. With a token, your alerts count against your own
account's limits. The token is write-only in Watchpost; changing the server means entering it again.

A self-hosted server must be reachable from the internet over HTTPS.

## Delivery

- Messages are cut to stay under ntfy's 4,096 bytes (longer ones would turn into attachments), and
  titles to 200 characters.
- 400, 401, 403 and 413 stop retries. 429 is retried when it is a request-rate limit and final when
  the daily quota is used up (error 42908). 5xx is retried.

## Owner checklist

- [ ] "Send test" arrives in the ntfy app.
- [ ] A critical outage arrives as urgent; tapping it opens the incident.
- [ ] The recovery replaces the outage notification (Android, web).
- [ ] A protected topic without a token fails "Send test" with ntfy's "forbidden".

# Gotify

Messages to a self-hosted Gotify server through an application token. The body is Markdown, tapping
the notification opens the incident, and the priority follows the severity (critical 10, high 8,
low 5; follow-ups 4). On Android, 8 and above sounds and vibrates. Needs no server configuration.

The Gotify server must be reachable from the internet over HTTPS; Watchpost refuses private and
internal addresses.

## Setup (workspace admin)

1. In Gotify: **Apps → Create Application**, then copy its token. Gotify 3 shows it only once.
2. In Watchpost: Integrations → Gotify → server URL (a sub-path is fine, for example
   `https://example.com/gotify`) and the token → **Save and send test**.

The token is write-only in Watchpost; changing the server URL means entering it again.

## Delivery

- 400, 401, 403 and 404 stop retries; 5xx is retried.

## Owner checklist

- [ ] "Send test" arrives in the Gotify app.
- [ ] A real outage arrives with the facts as a list; tapping it opens the incident.
- [ ] Deleting the application in Gotify makes the next alert fail without retries.

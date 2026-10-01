# Pushover

Push notifications to phones through **your own** Pushover application: each workspace enters its
application token, so its messages count against its own Pushover quota (10,000 per month on the
free tier), not one shared with other Watchpost customers. Needs no server configuration.

| Incident                         | Pushover priority                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Critical or high, down/reminder  | 1 (high): bypasses quiet hours                                                       |
| Critical, in **Emergency** mode  | 2 (emergency): repeats every minute for up to an hour until acknowledged in Pushover |
| Low                              | 0 (normal)                                                                           |
| Acknowledged, resolved, flapping | 0 (normal)                                                                           |

In Emergency mode, acknowledging or resolving the incident in Watchpost cancels the repeats (they are
tagged with the incident).

## Setup (workspace admin)

1. On https://pushover.net create an application and copy its **API token**.
2. Copy your **user key**, or a delivery group's key to reach a team.
3. In Watchpost: Integrations → Pushover → paste both, choose how critical incidents arrive →
   **Save and send test**.

Both keys are write-only: after saving, Watchpost shows `********`.

## Delivery

- Pushover asks senders never to repeat a refused request: every 4xx is final, including 429, which
  means the monthly quota is used up. Only 5xx and timeouts are retried.
- A wrong key therefore fails at once and marks the channel failing; fix the key and send a test.

## Owner checklist

- [ ] "Send test" arrives with the title "Test alert from Watchpost".
- [ ] A real outage arrives with the failing regions and likely cause; tapping it opens the incident.
- [ ] In Emergency mode a critical outage repeats, and stops when the incident is acknowledged here.
- [ ] A wrong user key fails "Send test" with Pushover's own message.

# Opsgenie and Jira Service Management

Atlassian shuts Opsgenie down on **April 5, 2027** and moved its alerting into Jira Service
Management (JSM), whose alert API takes the same key header and the same fields. Watchpost serves
both with one integration: the region picks the API host.

| Region                  | API                                                       |
| ----------------------- | --------------------------------------------------------- |
| Opsgenie, United States | `https://api.opsgenie.com/v2/alerts`                      |
| Opsgenie, Europe        | `https://api.eu.opsgenie.com/v2/alerts`                   |
| Jira Service Management | `https://api.atlassian.com/jsm/ops/integration/v2/alerts` |

After you migrate to JSM, edit the integration, switch the region and paste the new integration's
key. Nothing else changes.

One Watchpost incident is one alert, identified by the alias `watchpost-<incident ID>`:

| In Watchpost       | In Opsgenie / JSM                                     |
| ------------------ | ----------------------------------------------------- |
| Incident triggered | Alert created (critical → P1, high → P2, low → P4)    |
| Acknowledged       | Alert acknowledged, with who did it                   |
| Resolved           | Alert closed                                          |
| Reminder, flapping | Create with the same alias: counted on the open alert |

## Setup (workspace admin)

1. Opsgenie: your team → **Integrations → Add integration → API**. JSM: your team's
   **Operations → Integrations → Add integration → API**. Turn the integration on.
2. Copy its API key (36 characters).
3. In Watchpost: Integrations → Opsgenie (or Jira Service Management) → paste the key and pick the
   region → **Save**.

New channels start with **High and critical only**. The key is write-only.

## Send test

A test creates a P5 alert under its own alias and closes it straight away. Opsgenie handles requests
asynchronously; if it processes the close first, close the test alert by hand. It is a real alert, so
Watchpost asks before sending it.

## Delivery

- Retries run for about 20 minutes. 400, 401 (wrong key or integration turned off), 402, 403, 404
  and 422 stop them; 429 and 5xx are retried.
- Opsgenie answers 202 "Request will be processed": acceptance, not a guarantee that the alert exists.

## Owner checklist

- [ ] "Send test" (after confirming) creates and closes a P5 "Test alert from Watchpost".
- [ ] A real outage creates one alert with the message, priority, the monitor as entity and a link
      back in the details.
- [ ] Acknowledge and resolve in Watchpost acknowledge and close the same alert.
- [ ] The same flow works with the region set to Jira Service Management after migrating.

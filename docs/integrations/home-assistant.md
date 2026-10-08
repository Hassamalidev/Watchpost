# Home Assistant

Fires a webhook trigger in Home Assistant, so an automation can flash a light, sound a siren or
speak when something goes down. Needs no server configuration on our side.

The Home Assistant server must be reachable from the internet over HTTPS (Nabu Casa remote access,
a reverse proxy or a tunnel); Watchpost refuses private and internal addresses.

## Setup (workspace admin)

1. In Home Assistant: **Settings → Automations → Create automation**, add a **Webhook** trigger and
   copy its webhook ID. In the trigger's settings, allow `POST` and untick "Only accessible from the
   local network".
2. In Watchpost: Integrations → Home Assistant → the server address (a sub-path is fine) and the
   webhook ID → **Save and send test**.
3. In the automation, read the alert from `trigger.json`.

The webhook ID is write-only in Watchpost: anyone who knows it can fire the automation.

## What the automation receives

```json
{
  "event": "triggered",
  "title": "[Critical] #482 Checkout API is down",
  "message": "…",
  "incident": {
    "number": 482,
    "title": "Checkout API is down",
    "severity": "critical",
    "status": "triggered",
    "url": "https://app.example.com/w/…/incidents/482"
  },
  "monitor": "Checkout API",
  "workspace": "Acme"
}
```

`event` is `triggered`, `acknowledged`, `resolved`, `reminder` or `test`. A condition such as
`{{ trigger.json.event == "triggered" and trigger.json.incident.severity == "critical" }}` keeps the
siren for what matters.

## Delivery

- 400, 401, 403, 404 and 405 stop retries (an unknown webhook ID answers 404 or 405); 5xx is
  retried.

## Owner checklist

- [ ] "Send test" fires the automation.
- [ ] A real outage arrives with `event: triggered` and the recovery with `event: resolved`.
- [ ] Deleting the automation makes the next alert fail without retries.

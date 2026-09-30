# Outbound webhooks

## Setup (workspace admin)

Integrations → Add channel → Webhook → your endpoint URL. Leave the secret empty to get a generated
one (`whsec_…`); it is shown to admins on the channel page. Changing the URL keeps the secret.

## What we send

`POST <your URL>` with `Content-Type: application/json`:

```json
{
  "id": "delivery.0190…",
  "type": "incident.triggered",
  "createdAt": "2026-10-01T12:00:05.000Z",
  "workspace": { "id": "…", "name": "Acme" },
  "incident": {
    "id": "…",
    "number": 482,
    "title": "Checkout API is down",
    "severity": "critical",
    "status": "triggered",
    "causeCode": "http_status_unexpected",
    "failingRegions": ["eu-central", "us-east"],
    "startedAt": "…",
    "resolvedAt": null,
    "durationSeconds": 5,
    "url": "https://app…/w/…/incidents/482"
  },
  "monitor": { "name": "Checkout API" },
  "actor": null
}
```

`type` is one of `incident.triggered`, `incident.acknowledged`, `incident.resolved`,
`incident.reminder`, `incident.flapping`, `incident.test`.

Headers:

- `Watchpost-Event-Id` — the same value as `id`; stays the same across retries, so deduplicate on it.
- `Watchpost-Signature: t=<unix seconds>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`.
  Verify against the raw body, compare in constant time, and reject timestamps older than 5 minutes.

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, header, rawBody) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  return fresh && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

Answer with any 2xx within 10 seconds. Anything else is retried with backoff, 9 attempts over about
an hour; `410 Gone` stops retries at once. Redirects are not followed. The URL must resolve to public
addresses only.

## Owner checklist

- [ ] "Send test" reaches a request bin (for example webhook.site) with both headers, and the
      signature verifies with the snippet above.
- [ ] A real outage and its recovery arrive as `incident.triggered` and `incident.resolved`.
- [ ] An endpoint answering 500 receives retries with growing gaps; one answering 410 receives none.
- [ ] A URL pointing at `http://127.0.0.1` or `http://169.254.169.254` is refused and never called.

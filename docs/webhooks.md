# Outgoing webhooks

A workspace can register HTTPS endpoints that get a signed `POST` when something happens: an incident opens, a monitor changes status, a status update is published. They are set up under **Integrations → Outgoing webhooks** by anyone who may manage channels (admins and owners), on every paid plan and the trial.

This is separate from the _webhook alert channel_: that one is a destination in an alert policy and follows escalation and routing. Outgoing webhooks are a feed of everything that happens, for your own systems.

## Events

| Type                           | When                                        | `data`                                         |
| ------------------------------ | ------------------------------------------- | ---------------------------------------------- |
| `incident.triggered`           | An incident opened                          | `incident`, `monitor` (or `null`)              |
| `incident.acknowledged`        | Someone acknowledged it                     | `incident`, `monitor`                          |
| `incident.resolved`            | It was resolved, by a person or by recovery | `incident`, `monitor`                          |
| `incident.reopened`            | A resolved incident opened again            | `incident`, `monitor`                          |
| `monitor.created`              | A monitor was created                       | `monitor`                                      |
| `monitor.updated`              | A monitor's settings changed                | `monitor`                                      |
| `monitor.deleted`              | A monitor was deleted                       | `monitor` (its `id` only)                      |
| `monitor.state_changed`        | A monitor's status changed                  | `monitor`, `from`, `to`, `at`                  |
| `status_page.update_published` | An update was published on a status page    | `statusPageId`, `statusIncidentId`, `updateId` |

An endpoint subscribes to single types, to a group (`incident.*`, `monitor.*`, `status_page.*`) or to everything (`*`). Groups include events added later. New event types and new fields may be added at any time; existing ones are not renamed or removed.

`incident` has the same fields as in the public API (`docs/api.md`) plus `url`, the incident's page in the app. `monitor` is `{ id, name, type }`. An event describes the thing as it is when the event is handled, which is usually within a second of when it happened. An endpoint gets events from the moment it is created.

`GET /api/w/:workspaceId/webhook-events` returns the list with an example of each.

## The request

```
POST <your address>
content-type: application/json
watchpost-event-id: 0199c1a0-7d00-7e40-8a55-0f1e2d3c4b5a
watchpost-event-type: incident.triggered
watchpost-signature: t=1793610848,v1=5f2b…

{
  "id": "0199c1a0-7d00-7e40-8a55-0f1e2d3c4b5a",
  "type": "incident.triggered",
  "createdAt": "2026-11-02T09:14:08.000Z",
  "workspaceId": "0199c19f-0000-7000-8000-000000000001",
  "data": { "incident": { … }, "monitor": { … } }
}
```

- `id` (and the `watchpost-event-id` header) is the same for every attempt at one event at one endpoint, and for a replay. Use it to drop duplicates: delivery is at least once.
- Up to 10 headers of your own can be set on an endpoint (an `Authorization` header, a routing key). Their values are stored encrypted and never shown again.

## Signature

`watchpost-signature: t=<unix seconds>,v1=<hex>` where `v1` is the HMAC-SHA256 of `<t>.<raw body>` with the endpoint's signing secret (`whsec_…`). The secret is shown once when the endpoint is created; it can be replaced (`POST …/webhooks/:id/secret`), and the old one stops working at once.

```js
const [t, v1] = header.split(",").map((part) => part.split("=")[1]);
const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
const ok =
  v1.length === expected.length &&
  crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) &&
  Math.abs(Date.now() / 1000 - Number(t)) < 300;
```

Use the raw body as it arrived, not a re-serialised object. The scheme is the same as for the webhook alert channel, so one verifier covers both.

## Retries and switching off

- Any `2xx` answer within 10 seconds is a success.
- Anything else (another status, a timeout, no connection) is tried again after 1, 5, 15, 60, 180, 360 and 720 minutes: eight attempts in about 22 hours. Then the delivery has failed.
- `410 Gone` fails at once and switches the endpoint off.
- 20 deliveries in a row that failed for good switch the endpoint off. A success resets the count.
- An address that resolves to a private or otherwise blocked network is refused and the endpoint is switched off.
- A switched-off endpoint gets nothing. Switch it on again on the Integrations page (or `PATCH` with `{"enabled": true}`); what happened while it was off is not sent afterwards, but past deliveries can be replayed.
- Deliveries are kept for 30 days.

## Test and replay

- **Send test** posts the example of an event (the same one the catalog shows) now, once, and tells you how the endpoint answered. It works while the endpoint is switched off, so you can check a fix first.
- **Replay** sends a stored delivery's event again, now, once, with its original `id`.

Neither is retried, and neither counts towards switching the endpoint off.

## Body templates

An endpoint can have its own body instead of the standard one, for receivers that expect a fixed shape.

- `{{path.to.value}}` is replaced by the value, escaped for use inside a JSON string. Write it between quotes.
- `{{json path.to.value}}` is replaced by the value as JSON. Write it without quotes; use it for objects, lists, numbers and booleans.
- Paths start at the envelope: `id`, `type`, `createdAt`, `workspaceId`, `data.…`. A path that doesn't exist gives an empty string, or `null` with `json`.
- Nothing in a template is run; it is text with holes. The filled-in template must be valid JSON for every event the endpoint subscribes to; this is checked with the examples when you save.
- The signature covers the body that is sent, so it is over the filled-in template.

```
{
  "text": "#{{data.incident.number}} {{data.incident.title}} is {{data.incident.status}}",
  "monitor": {{json data.monitor}}
}
```

## API

All under `/api/w/:workspaceId` (the app's own API, with a session): `GET /webhooks`, `POST /webhooks`, `PATCH /webhooks/:id`, `DELETE /webhooks/:id`, `POST /webhooks/:id/secret`, `GET /webhooks/:id/deliveries`, `POST /webhooks/:id/test`, `POST /webhooks/:id/deliveries/:deliveryId/replay`, `GET /webhook-events`. A workspace can have 10 endpoints.

## For developers of this codebase

- The public event list, the examples and the template renderer are in `packages/shared/src/schemas/webhooks.ts`. The module is `backend/src/modules/webhooks`.
- To pass a new internal event on: add its public type to `WEBHOOK_EVENT_TYPES` with a description and an example, add `{ handler: "webhooks", queue: "webhooks-events" }` to its subscribers in `composition/architecture.ts`, write the handler in `modules/webhooks/events/index.ts` (reload the thing, publish the public shape), and add a row to the table above. A test fails when a type is missing from this page.
- `webhook_deliveries` is the queue. The first attempt is made by the event handler, later ones by the `webhook-deliveries` sweep every minute; an attempt takes a two-minute lease on the row, so a crash mid-attempt means one more attempt, never a lost delivery.

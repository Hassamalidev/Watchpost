# Public API v1

The public API lets scripts, CI jobs and other tools work with a workspace. It lives under `/api/v1`, is versioned, and stays compatible: fields are added, never renamed or removed. The web app's own API (`/api/w/…`) is internal and changes with the app; don't build on it.

The complete, always-current reference is the OpenAPI 3.1 document at `GET /api/v1/openapi.json` (no key needed). It is generated from the same route descriptions the server runs, so it can't drift. This page explains the rules around it. A test fails when a route is missing from the table below.

## Keys

- A workspace admin (owner or admin role) makes a key under **Settings → API keys** and picks its scopes and, optionally, an expiry of 30, 90 or 365 days.
- The whole key (`wp_…`) is shown once. Only a SHA-256 hash is stored, so a lost key can't be recovered: revoke it and make a new one.
- A key belongs to the workspace, not to the person who made it. It keeps working when that person leaves. Revoke keys you no longer need; a workspace can have 25 that work.
- Send it with every request: `Authorization: Bearer <key>`.
- `GET /api/v1/me` answers with the workspace, the key's name and its scopes: a quick check that a key works.

## Scopes

| Scope               | Allows                                            |
| ------------------- | ------------------------------------------------- |
| `monitors:read`     | List and read monitors                            |
| `monitors:write`    | Create, change, pause, resume and delete monitors |
| `incidents:read`    | List and read incidents                           |
| `incidents:write`   | Acknowledge and resolve incidents                 |
| `maintenance:read`  | List maintenance windows                          |
| `maintenance:write` | Create and delete maintenance windows             |
| `status_pages:read` | List status pages and their components            |

A write scope includes reading the same thing. Writing needs a plan with API write access (every paid plan and the trial); the Free plan reads. The plan is checked on each request, so a key with a write scope answers `402 quota_exceeded` on writes after a downgrade and works again after an upgrade.

## Endpoints

| Method and path                            | Scope               | What it does                                                                        |
| ------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------- |
| `GET /me`                                  | any                 | The key in use                                                                      |
| `GET /monitors`                            | `monitors:read`     | List monitors (`limit`, `cursor`, `q`, `type`, `tag`, `groupId`, `paused`)          |
| `POST /monitors`                           | `monitors:write`    | Create a monitor                                                                    |
| `GET /monitors/:monitorId`                 | `monitors:read`     | Get a monitor                                                                       |
| `PATCH /monitors/:monitorId`               | `monitors:write`    | Change a monitor; send only what changes                                            |
| `POST /monitors/:monitorId/pause`          | `monitors:write`    | Pause a monitor                                                                     |
| `POST /monitors/:monitorId/resume`         | `monitors:write`    | Resume a paused monitor                                                             |
| `DELETE /monitors/:monitorId`              | `monitors:write`    | Delete a monitor                                                                    |
| `GET /incidents`                           | `incidents:read`    | List incidents, newest first (`status`, `severity`, `monitorId`, `limit`, `cursor`) |
| `GET /incidents/:incidentRef`              | `incidents:read`    | Get an incident by ID or by its number                                              |
| `POST /incidents/:incidentRef/acknowledge` | `incidents:write`   | Acknowledge; escalation stops                                                       |
| `POST /incidents/:incidentRef/resolve`     | `incidents:write`   | Resolve                                                                             |
| `GET /maintenance-windows`                 | `maintenance:read`  | List maintenance windows                                                            |
| `POST /maintenance-windows`                | `maintenance:write` | Create a maintenance window                                                         |
| `DELETE /maintenance-windows/:windowId`    | `maintenance:write` | Delete a window; one in effect ends now                                             |
| `GET /status-pages`                        | `status_pages:read` | List status pages                                                                   |

Actions taken through the API are recorded on the incident timeline as coming from the API, without a person's name.

## Conventions

- JSON in and out, camelCase fields, times in ISO 8601 UTC, IDs as UUIDs.
- **Paging:** lists that can be long answer `{ "data": […], "nextCursor": "…" }`. Pass `nextCursor` as `cursor` for the next page; `null` means the last page. `limit` is 1 to 200, 50 by default.
- **Errors** are problem documents (RFC 9457) with a stable `code`: `validation_failed` (400, with the fields that are wrong in `errors`), `unauthorized` (401), `quota_exceeded` (402), `forbidden` (403, the key lacks the scope), `not_found` (404), `conflict` (409), `rate_limited` (429).
- A key sees its own workspace only. Anything from another workspace answers 404, never 403.
- Answers carry only the fields the OpenAPI document lists.

## Rate limit

Each key may make 120 requests a minute (`API_KEY_RATE_LIMIT_PER_MINUTE` on a self-run server). The `RateLimit` and `RateLimit-Policy` headers say what is left. Past the limit the answer is `429` with `Retry-After`. If our rate-limit store is down, requests are let through.

## Idempotency

Send `Idempotency-Key: <any unique text, up to 200 characters>` with a `POST`, `PATCH` or `DELETE`.

- The first request is done and its answer is stored for 24 hours.
- The same key with the same request returns the stored answer with `Idempotency-Replayed: true`; nothing is done twice.
- The same key with a different method, path or body answers `409 conflict`.
- A request that was refused (any 4xx or 5xx) frees its key, so you can fix the request and send it again with the same key.
- While the first request is still being handled, a second one with the same key answers `409`.

## Examples

```sh
# Which workspace does this key open?
curl -s https://YOUR-HOST/api/v1/me -H "Authorization: Bearer $API_KEY"

# Create a monitor, safely retried
curl -s -X POST https://YOUR-HOST/api/v1/monitors \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -H "Idempotency-Key: create-shop-monitor" \
  -d '{"settings":{"name":"Shop"},"config":{"type":"http","url":"https://shop.example.com"}}'

# Acknowledge incident #12
curl -s -X POST https://YOUR-HOST/api/v1/incidents/12/acknowledge -H "Authorization: Bearer $API_KEY"
```

## For developers of this codebase

- A module adds a route by describing it with `publicRoute({ … })` (`backend/src/core/public-api.ts`) in `modules/<name>/<name>.public.ts` and returning the list as `publicRoutes` from its module factory. The container mounts every module's routes under `/api/v1` behind the key check, the per-key rate limit, the scope check and idempotency (`backend/src/composition/public-api.ts`).
- Answers are v1's own shapes in `packages/shared/src/schemas/api.ts`, mapped by hand from the internal views and parsed through the response schema before they are sent. Changing an internal view therefore can't change v1 by accident.
- Add a row to the table above when you add a route.

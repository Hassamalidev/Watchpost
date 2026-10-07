# Runbook: the sentinel and our own status page

The sentinel watches the platform from outside and tells the founders directly when it is down (PRODUCT.md §13). It must share nothing with what it watches: put it on a server at a **different provider** than the core server and the probes, and give it its own Telegram bot and Twilio sender, not the product's. It also serves our own status page, so that page is up when we are not.

It is the probe image started with another command (`node dist/sentinel/main.js`); the code is in `probe/src/sentinel/`.

## What it does

Every 30 seconds it requests each target once.

- A target that **answers with a failure** (the API saying "not ready", an HTTP 5xx) is down: it pages at once.
- A target that **doesn't answer** may be the sentinel's own network: it pages on the second miss in a row.
- While a target stays down the page repeats every 15 minutes; when it is back you get one "recovered" message.
- **Warnings** in the API's readiness answer (for example "no healthy probe in ap-southeast") are sent to Telegram only, when they appear, change or clear.
- A page goes to Telegram **and** SMS. If neither accepts it, it is sent again on the next round.

The API's `/api/ready` fails when Postgres or Redis is unreachable, when events are stuck for more than a minute, or when the worker has not ticked for more than a minute. So a stopped worker is paged within about 90 seconds: up to 60 for the API to notice, up to 30 for the next round.

## Set up (about 20 minutes)

1. A small server (1 vCPU, 512 MB is enough, about $5 a month) at a third provider, with Docker and the compose plugin.
2. **Telegram:** talk to @BotFather, create a bot for the sentinel and keep its token. Start a chat with the bot (or add it to a founders' group), then read the chat ID from `https://api.telegram.org/bot<token>/getUpdates`.
3. **SMS:** in the Twilio console, a sender number (or reuse the account with a separate number) and the account SID and auth token.
4. A heartbeat monitor in our own workspace gives the sentinel an address that proves ping intake works: create a heartbeat monitor, copy its ping URL.
5. `/opt/watchpost-sentinel/docker-compose.yml` is `probe/docker-compose.sentinel.yml` from this repo; `/opt/watchpost-sentinel/.env` (mode 600):

   ```
   SENTINEL_TARGETS=Platform=https://app.<domain>/api/ready,Website=https://<domain>/,Status pages=https://<a page>.status.<domain>/,Heartbeat intake=https://hb.<domain>/<token>
   SENTINEL_TELEGRAM_BOT_TOKEN=...
   SENTINEL_TELEGRAM_CHAT_ID=...
   SENTINEL_SMS_TO=+<founder 1>,+<founder 2>
   SENTINEL_SMS_FROM=+<twilio number>
   TWILIO_ACCOUNT_SID=...
   TWILIO_AUTH_TOKEN=...
   SENTINEL_PAGE_TITLE=<Product> status
   ```

   The name before `=` is what the status page and the messages show; the URLs are never shown. The heartbeat target also keeps that monitor "up": if the sentinel itself stops, that monitor goes down and the product alerts you, so each watches the other.

6. Start it: `PROBE_IMAGE=<registry>/watchpost-probe:<version> docker compose up -d`. It refuses to start, and says why, if a setting is missing or nobody would be told.
7. **Our status page:** point `status.<domain>` at this server and put Caddy in front of port 8080 (`status.<domain> { reverse_proxy 127.0.0.1:8080 }`).

`SENTINEL_DRY_RUN=true` runs the checks and logs what it would send without sending anything.

## Test it once it runs (do this before relying on it)

1. On the core server: `docker compose stop worker`. Within two minutes both founders get "DOWN: Platform. Not ready: worker …" by Telegram and SMS, and the status page shows the outage.
2. `docker compose start worker`. Within a minute: "RECOVERED: Platform is working again".
3. Stop a probe for three minutes: a Telegram warning names its region; no SMS.

Write the date of the last test here: ____.

## When it pages

- **Not ready: postgres / redis** → the database or Redis on the core server; see the core server's logs and disk.
- **Not ready: worker** → the worker container stopped or hangs; `docker compose logs --tail 100 worker`, then restart it. Alerts that were due are sent when it is back; heartbeat deadlines inside the gap are not counted as misses.
- **Not ready: outbox** → events are not being handed to the worker; usually the worker again, or Redis.
- **It can't be reached / No answer** → the server, Caddy, DNS or the provider's network. Check the provider's status first.
- **Status pages / Website down while Platform is fine** → the web container or Caddy's routing for that host.

## Limits to know

- It keeps its state in memory: after a restart it pages again for something that is still down, and the "recent events" list on the page starts empty.
- It checks from one place. If that provider has a network problem towards us, a target that doesn't answer is paged after the second miss even though customers can reach us. A target that answers with a failure is never a false page.
- It reaches you through Telegram and Twilio only. If both are down at the same moment as the platform, nobody is told; the page is retried every round until one of them accepts it.

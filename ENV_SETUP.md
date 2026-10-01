# ENV_SETUP.md — where to get Paddle and R2 keys

> **Placeholder — needs owner input.** PRODUCT.md says to save the `paddle-r2-setup.md` guide under this name. It was not in the repo at P0-T01. Replace this file with that guide.

Until then, the variables that need real values are listed in `.env.example` and PRODUCT.md Appendix A. Use Paddle **sandbox** keys first (`PADDLE_ENV=sandbox`).

## What the billing code needs (written by the build agent at P3-T02a, 2026-10-01)

This section lists exactly what the code reads, so the guide above can be checked against it. Billing stays off until step 1 is done: the billing page shows plans and limits, and says checkout isn't set up.

### 1. Paddle sandbox

1. In the Paddle **sandbox** dashboard create an API key (Developer tools → Authentication) and a client-side token. Put them in `.env`:
   ```
   PADDLE_ENV=sandbox
   PADDLE_API_KEY=...
   NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=...
   ```
2. Create a notification destination (Developer tools → Notifications) of type webhook that points to `https://<your API host>/api/webhooks/paddle`. For local work use a tunnel to port 4000. Subscribe it to: `subscription.created`, `subscription.activated`, `subscription.updated`, `subscription.past_due`, `subscription.paused`, `subscription.resumed`, `subscription.canceled`, `transaction.completed`, `transaction.payment_failed`. Copy its secret key:
   ```
   PADDLE_WEBHOOK_SECRET=...
   ```
   `PADDLE_API_KEY` and `PADDLE_WEBHOOK_SECRET` must be set together; the API refuses to start with only one.
3. Create the catalog (products, prices and the founding discount). It is safe to re-run and creating catalog objects costs nothing:
   ```
   pnpm --filter @app/api paddle:catalog
   ```
   Paste the `PADDLE_PRICE_*` and `PADDLE_DISCOUNT_FOUNDING` lines it prints into `.env`, then restart the API and the worker.
4. Set the default payment link (Checkout → Checkout settings) to the web app's origin. Paddle needs one before it opens a checkout; confirm the exact requirement in the dashboard when you do this step.

Events the server can't apply are stored with an outcome in `billing_events` (`unlinked`, `unknown_plan`, `conflict`, `invalid`) and logged as errors. After fixing the cause (for example a missing price ID), replay the notification from the Paddle dashboard.

### 2. Sandbox run (task P3-T02b)

With the keys in place, run these with Paddle's sandbox test cards and note anything that differs from PRODUCT.md §11:

- Subscribe to each plan, monthly and yearly. Confirm the first `transaction.completed` carries `billing_period`.
- Upgrade (charged at once, prorated) and move down (nothing charged; the old plan stays until the period ends).
- Switch monthly to yearly. Confirm the new yearly period is treated as paid (credits keep arriving each month).
- Buy a credit pack. Cancel, keep, pause, resume. Open the customer portal.
- Use the renewal-decline card: the workspace must keep its plan for 7 days, then move to Free.

### 3. Going live

Use live keys, a live notification destination on the real domain, `PADDLE_ENV=production`, and run `pnpm --filter @app/api paddle:catalog --live` (it refuses the live catalog without `--live`). Live and sandbox price IDs differ.

### 4. Provider balances (upstream funding)

Anthropic and Twilio sell no balance through an API (checked 2026-10-01), so the purchase is their own auto-reload, set up once with the company card:

- **Anthropic:** Console → Settings → Billing → auto-reload (a minimum balance and a reload amount).
- **Twilio:** Console → Billing → auto-recharge.

Run `pnpm --filter @app/api funding:status` to see, per provider, what customers have paid for and not used yet and the threshold to set. Then:

```
OPS_EMAIL=you@example.com          # shortfall warnings (Twilio reports its balance; Anthropic does not)
UNFUNDED_AI_MONTHLY_CAP_USD=5      # AI for all free and trial workspaces together, per month; 0 = paid only
TWILIO_ACCOUNT_SID=...             # also lets the server read the Twilio balance
TWILIO_AUTH_TOKEN=...
```

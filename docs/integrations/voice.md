# Voice calls and SMS

Alerts by text message and by phone call, through Twilio. Both are **paid channels**: every message
or call costs alert credits, which come with a paid plan or a credit pack. A workspace without
credits can't send either, so nothing is ever sent that a collected payment doesn't cover.

| Channel | What arrives                                                                 | Acting on it                             |
| ------- | ---------------------------------------------------------------------------- | ---------------------------------------- |
| SMS     | `Watchpost: DOWN API Prod (HTTP 502, 3 regions) #482. Reply 1=ack 2=resolve` | Reply `1` to acknowledge, `2` to resolve |
| Voice   | A call that reads the alert                                                  | Press `1` to acknowledge                 |

- An SMS is always one segment (160 characters, GSM alphabet); long monitor names are shortened.
- Calls are placed for new and ongoing incidents only. Nobody is called to hear that it's over.
- A reply or keypress acts on the last incident that number was alerted about.
- Marking an incident as a false alarm returns the credits its messages used.
- If a message can't be delivered after its retries, its credits are returned.

## Setup (workspace admin)

1. Integrations → **SMS** (or **Voice call**).
2. Enter the number in international format (`+14155550123`) and choose **Check cost**. The cost per
   SMS and per call depends on the country and is shown in credits.
3. **Send code by SMS** (this costs one SMS), enter the 6-digit code, **Verify number**.
4. Save. A verified number can be used for both an SMS channel and a voice channel.

At most three codes can be sent to one number per hour, and a code allows five attempts.

## Countries and prices

Only countries listed in `backend/src/config/messaging-rates.ts` can be used. Each has our cost per
SMS and per minute of a call; the price in credits is that cost divided by what one credit sets aside
for the provider (`CREDIT_PROVIDER_COST_MICROS`), rounded up, with a minimum of 2 credits for a call.
Numbers that share `+1` with the US but cost far more (the Caribbean, premium numbers) are refused.

## Server configuration

| Variable                       | Purpose                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`           | Account SID (`AC…`)                                           |
| `TWILIO_AUTH_TOKEN`            | Auth token; also verifies the signature of inbound requests   |
| `TWILIO_MESSAGING_SERVICE_SID` | SMS sender as a Messaging Service (`MG…`), preferred          |
| `TWILIO_SMS_FROM`              | SMS sender as one number, if there is no Messaging Service    |
| `TWILIO_VOICE_FROM`            | Caller number for voice alerts; without it there are no calls |

Without the SID, the token and one SMS sender, the SMS and voice integrations show as unavailable.

In the Twilio console, point the sender's **incoming message** webhook at
`https://<api host>/api/webhooks/twilio/sms` (HTTP POST). Voice needs no console setup: each call
carries its own instructions and posts the keypress to `/api/webhooks/twilio/voice`.
`BETTER_AUTH_URL` must be the public address Twilio calls, because the request signature covers the
full URL.

## Owner checklist (P3-T05b, needs a real Twilio account)

Automated tests use a fake provider. Before enabling this for customers:

- [ ] Replace the estimated rates in `messaging-rates.ts` with Twilio's current price list for each
      country (SMS per segment including carrier fees; voice per minute to mobiles).
- [ ] Register the sender as each country requires (US: A2P 10DLC or a verified toll-free number;
      sender-ID rules elsewhere), or SMS will be filtered.
- [ ] Turn on auto-recharge in the Twilio console (Open decision #14).
- [ ] With Twilio **test credentials**: send to the magic numbers and confirm the request shapes.
- [ ] With live credentials and your own phone: verify the number, send a test SMS, trigger an
      incident, reply `1`, then `2`; place a test call and press `1`.
- [ ] Confirm a request with a wrong signature is refused (`401`).
- [ ] Check that the credits charged match what Twilio billed.

## Not yet built

- A second call when the first isn't answered (needs Twilio's call status callback).
- "Press 2 to escalate" on calls: escalation arrives with on-call in Phase 4.
- WhatsApp.

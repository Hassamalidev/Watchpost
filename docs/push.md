# Notifications on your phone or computer (web push)

Watchpost can send alerts as notifications to a browser or to Watchpost installed as an app. A notification for an open incident has an **Acknowledge** button: tapping it acknowledges the incident and stops further escalation steps, even when the app is closed and you aren't signed in on that device at that moment.

Device notifications are free: they use no alert credits.

## Turn it on

1. Sign in on the device and open **My notifications**.
2. Under **Notifications on this device** choose **Turn on for this device** and allow notifications when the browser asks.
3. The device appears in your contact methods. By default it is notified at once for every urgency; change that under **When to notify me**.

Do this on every device you want to be reached on. **Turn off for this device** removes it.

## Android

Works in Chrome, Edge and Firefox. For alerts that arrive with the browser closed, install the app first:

1. Open Watchpost in Chrome.
2. Menu (three dots) → **Add to Home screen** → **Install**.
3. Open Watchpost from the home screen and turn notifications on as above.

Check that Android lets the app notify you: Settings → Apps → Watchpost → Notifications. Battery savers can delay notifications; exclude the app if alerts arrive late.

## iPhone and iPad

iOS and iPadOS 16.4 or later. Apple allows web push only for sites added to the Home Screen:

1. Open Watchpost in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open Watchpost **from the Home Screen icon** (not from Safari) and sign in.
4. Open **My notifications** → **Turn on for this device** → **Allow**.

Notes for iOS:

- Notifications on iOS show the alert; action buttons are not shown on every iOS version. Tap the notification to open the incident and acknowledge there.
- Focus modes silence notifications unless Watchpost is allowed. For alerts that must wake you, also keep an SMS or a call in your high-urgency rules.
- If notifications stop after an iOS update, turn the device off and on again under My notifications.

## Windows, macOS and Linux

Works in Chrome, Edge and Firefox, and in Safari 16 or later on macOS. The browser must be running (it may be in the background). Check the system's notification settings if nothing appears, and "Do not disturb".

## How it stays private

The message is encrypted for your browser before it leaves Watchpost; the push service that carries it (Google, Mozilla, Apple) can't read it. The Acknowledge button uses a signed link that works once and expires after 24 hours.

## Server setup (once)

Web push needs a key pair:

```sh
pnpm --filter @app/api vapid:generate
```

Put the three lines it prints into `.env` (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` with a real contact address) and restart the API and the worker. Keep the pair: changing it makes every device subscribe again. Until the keys are set, the page says device notifications aren't set up.

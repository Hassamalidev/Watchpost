# Telegram alerts

One Watchpost bot serves every workspace; a chat links to a channel through a one-day deep link.
One-way in P1; inline buttons arrive in P4.

## Server setup (owner, once per environment)

1. Create the bot with [@BotFather](https://t.me/BotFather) (`/newbot`); copy the token and the
   bot's username.
2. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and a random `TELEGRAM_WEBHOOK_SECRET`
   (16–256 letters, digits, `_` or `-`, for example `openssl rand -hex 32`), and restart the API.
3. Register the webhook (needs the public https API URL in `BETTER_AUTH_URL`):
   `pnpm --filter @app/api telegram:webhook`. Telegram then sends every update with the secret in
   `X-Telegram-Bot-Api-Secret-Token`; requests without it are refused.
4. For groups: in BotFather, allow the bot to join groups. Privacy mode can stay on (it still sees
   `/start` commands).

## Setup (workspace admin)

1. Integrations → Add channel → Telegram; Watchpost shows a link `https://t.me/<bot>?start=…`.
2. Open it on the phone (a private chat) or add the bot to a group and send the `/start …` command
   the link fills in. The bot answers "Linked to …".
3. Press **Send test**. A link works once and for 24 hours; create a new one to move the channel.

## Owner checklist

- [ ] The link opens the bot; after Start it replies "Linked to the "<name>" channel in Watchpost".
- [ ] Opening the same link again answers that it expired or was used, and the channel keeps its chat.
- [ ] "Send test" arrives in the private chat and in a group.
- [ ] A real outage arrives; resolve arrives as a reply to it, and the first message is edited.
- [ ] Blocking the bot makes the next alert fail without retries and marks the channel failing.

## Buttons on alerts (Acknowledge and Resolve)

The first message of every incident has **Acknowledge** and **Resolve** buttons under it. A tap is answered with a short notice in Telegram, and the message is edited to the new state for everyone in the chat. Nothing extra to set up: taps arrive on the same bot webhook as the link command.

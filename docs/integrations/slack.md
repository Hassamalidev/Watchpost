# Slack alerts

## Server setup (owner, once per environment)

1. Create a Slack app at https://api.slack.com/apps ("From scratch"), named Watchpost.
2. **OAuth & Permissions → Redirect URLs:** `https://<api host>/api/integrations/slack/callback`
   (locally `http://localhost:4000/api/integrations/slack/callback`).
3. **Bot token scopes:** `chat:write`, `chat:write.public`, `channels:read`, `groups:read`,
   `users:read`, `users:read.email`, `im:write`, `commands` (check Slack's current docs; P4 uses the
   last four).
4. **Basic Information:** copy the Client ID, Client Secret and Signing Secret into
   `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` and restart the API and worker.
   Without them, Slack channels are unavailable.

## Setup (workspace admin)

1. Integrations → Slack → **Add to Slack** and approve in Slack.
2. Back in Watchpost, pick a channel from the list and save it as a channel. Private channels need
   the bot invited first (`/invite @Watchpost`).
3. Put the channel in an alert policy and press **Send test**.

## Owner checklist

- [ ] "Add to Slack" returns to Watchpost with the team listed; the database holds only the
      encrypted bot token.
- [ ] Public and private channels appear in the picker; "Send test" posts to both.
- [ ] A real outage posts "🔴 DOWN · <monitor>" with Incident, Severity, Cause, Failing regions,
      Since and an "Open incident" button that opens the incident.
- [ ] Acknowledge and resolve post as thread replies, and the root message changes to the new state.
- [ ] Removing the app from Slack makes the next alert fail at once (no retries), marks the channel
      failing and emails the workspace admins.

## Buttons on alerts (Acknowledge and Resolve)

The first message of every incident has **Acknowledge** and **Resolve** buttons. They disappear as they stop applying: after an acknowledgement only Resolve is left, and a resolved incident has none.

Server setup, once (the person who runs the Slack app):

1. In the Slack app's settings open **Interactivity & Shortcuts** and turn Interactivity on.
2. Set the **Request URL** to `https://app.<domain>/api/integrations/slack/actions`.
3. Copy the app's **Signing Secret** (Basic Information) into `SLACK_SIGNING_SECRET` and restart the API.

A click is accepted only when Slack's signature on the request is valid and no older than five minutes, and when it comes from the message Watchpost posted for that incident. The person who clicked sees a short note that only they can see; everyone else sees the message change.

## The `/watchpost` command

| Command                         | What it does                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/watchpost oncall`             | Who is on call for each schedule                                                                           |
| `/watchpost ack 482`            | Acknowledges incident #482                                                                                 |
| `/watchpost resolve 482`        | Resolves incident #482                                                                                     |
| `/watchpost maintenance 1h api` | Silences alerts for monitors named like "api" for an hour (`30m`, `2h30m`, up to `24h`; no name means all) |
| `/watchpost link`               | Gives you a link that connects your Slack user to your Watchpost account                                   |

Answers are visible only to you. Looking and acknowledging work for anyone in the Slack workspace. Starting maintenance needs a linked account whose role can plan maintenance (member, admin or owner).

**Linking your account.** Type `/watchpost link`, open the link while signed in to Watchpost, and confirm. From then on your clicks and commands in Slack are recorded under your name. You can unlink under **My notifications**.

Server setup, once: in the Slack app's settings add a slash command `/watchpost` with the Request URL `https://app.<domain>/api/integrations/slack/commands`. It uses the same signing secret as the buttons.

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

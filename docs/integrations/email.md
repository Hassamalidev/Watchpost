# Email alerts

## Setup (workspace admin)

Integrations → Add channel → Email → up to 10 addresses. Put the channel in an alert policy.

## Owner checklist

- [ ] With the production transport configured (Resend, P1-T18), "Send test" arrives at a Gmail and
      an Outlook address within a minute, not in spam.
- [ ] A real outage (fake-target switched to fail) sends "[Critical] #N …", and the recovery sends
      "Resolved after …".
- [ ] Two recipients each get exactly one email per alert, also when the notify job was retried.
- [ ] Until P1-T18, with `EMAIL_TRANSPORT=console`, the worker log shows each alert email once.

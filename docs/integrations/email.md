# Email alerts

## Setup (workspace admin)

Integrations → Add channel → Email → up to 10 addresses. Put the channel in an alert policy.

Each recipient gets their own alert email with **Acknowledge** and **Resolve** links. The links are
signed, work once, expire after 24 hours and act as that recipient (their user when they are a
member of the workspace). Opening a link only shows a confirmation page, so mail scanners that
prefetch links can't acknowledge anything.

## Server setup (owner)

`EMAIL_TRANSPORT=resend`, `RESEND_API_KEY` and `EMAIL_FROM` on a verified sending domain
(`mail.<domain>` with SPF, DKIM and DMARC, per Resend's domain setup). Development uses
`EMAIL_TRANSPORT=console` (emails appear in the worker log).

## Owner checklist

- [ ] "Send test" arrives at a Gmail and an Outlook address within a minute, not in spam.
- [ ] A real outage (fake-target switched to fail) sends "[Critical] #N …", and the recovery sends
      "Resolved after …".
- [ ] Two recipients each get exactly one email per alert, also when the notify job was retried.
- [ ] Every template (verify, magic link, reset, invite, alert, channel failing, digest) reads well in
      light and dark mode in Apple Mail (macOS and iOS), Gmail (web and app) and Outlook (web and
      desktop): text readable, buttons visible, nothing clipped.
- [ ] Acknowledge from the email opens the confirmation page; confirming acknowledges the incident
      (timeline shows "via email"); the same link a second time says it was already used; a link
      older than 24 hours says it expired.
- [ ] The weekly digest arrives on Monday morning for owners and admins, with List-Unsubscribe.

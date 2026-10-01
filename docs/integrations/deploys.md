# Deploy markers

When Watchpost knows you deployed, an incident that starts within 30 minutes of a deploy says so:
the alert's first "check first" step becomes _"Deploy 9f8e7d6 to production went out 3 min before
this started; roll it back if the timing fits."_ Deploys also appear in each monitor's "Recent
changes" and in an incident's "What changed before this".

## Setup (workspace admin)

Integrations → Deploy markers → **Create deploy URL**. The URL and the GitHub secret are shown once;
**Rotate** creates new ones and retires the old URL immediately.

### From any CI

Add a step after the deploy:

```sh
curl -X POST "$WATCHPOST_DEPLOY_URL" \
  -H 'content-type: application/json' \
  -d '{"version":"'"$GIT_SHA"'","environment":"production","service":"api"}'
```

| Field         | Required | Notes                                                            |
| ------------- | -------- | ---------------------------------------------------------------- |
| `version`     | yes      | Commit, tag or build number (up to 100 characters)               |
| `service`     | no       | Which app or repo, if you deploy several                         |
| `environment` | no       | `production`, `staging`, …                                       |
| `url`         | no       | http(s) link to the release or the deploy log                    |
| `description` | no       | Up to 500 characters                                             |
| `at`          | no       | ISO 8601 time; defaults to now (ignored if more than 7 days ago) |

Answers `201 {"outcome":"recorded"}`, `400` for invalid input, `404` for an unknown or rotated URL.
Keep the URL in your CI's secret store: anyone with it can record deploys for the workspace.

### From GitHub

Repository → Settings → Webhooks → Add webhook:

- **Payload URL:** the GitHub URL shown in Watchpost (the deploy URL plus `/github`)
- **Content type:** `application/json`
- **Secret:** the secret shown in Watchpost
- **Events:** "Let me select individual events" → only **Deployment statuses**

Watchpost records `deployment_status` events with state `success` (commit SHA shortened to 12
characters, the repository as the service, the deployment environment and URL). GitHub's retries are
recorded once. Requests with a missing or wrong `X-Hub-Signature-256` are refused with `401`; other
events (including GitHub's `ping`) answer `202` and are ignored.

The GitHub secret is derived from the deploy URL token and the server's auth secret. If the server's
`BETTER_AUTH_SECRET` is ever rotated, rotate the deploy URL and update the GitHub webhook.

## Owner checklist

- [ ] curl step from a real CI run records a deploy (Integrations shows nothing secret afterwards)
- [ ] GitHub webhook "Recent deliveries" shows `201` for a deployment status and `202` for the ping
- [ ] An incident started shortly after a deploy names it in the Slack/email alert

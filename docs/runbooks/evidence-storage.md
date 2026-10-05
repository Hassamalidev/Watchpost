# Runbook: evidence storage (Cloudflare R2)

When a check fails, the probe keeps a little of what it saw: a fixed list of response headers and the first 2,000 characters of a text body. The API stores that with the result's facts (status, timings, address, certificate) as one JSON object per failed result, called an evidence bundle. The incident page shows it per failing region.

Bundles are private. They are never served from the bucket; the API reads them and checks the workspace first.

## What is stored, and what never is

- **Stored:** status, error code and message, timings, the address checked, certificate facts, and these response headers when present: content-type, content-length, content-encoding, date, server, location, retry-after, cache-control, age, via, x-cache, cf-ray, cf-cache-status, x-request-id, x-amzn-requestid, x-amz-cf-id, x-served-by, x-powered-by, www-authenticate.
- **Never stored:** request headers (so no monitor credentials), `set-cookie`, `authorization`, or any header outside the list. Binary bodies are not kept at all.
- **How often:** the first three failures of a streak, every twentieth after that, and every verification or "Test now" check. A monitor that stays down for a day stores a handful of bundles, not thousands.
- The body excerpt is the customer's own page content and can contain whatever their error page shows. Treat the bucket as customer data.

## Where it goes

| Setup                  | Store                                            |
| ---------------------- | ------------------------------------------------ |
| `R2_*` variables set   | Cloudflare R2                                    |
| Development, no `R2_*` | The folder `backend/.data/objects` (git-ignored) |
| Production, no `R2_*`  | Nowhere: results are stored without evidence     |
| Tests                  | Memory                                           |

Keys look like `evidence/<workspace id>/<yyyy-mm-dd>/<result id>.json`.

## Owner setup (P2-T04b, needs your Cloudflare account)

Automated tests use a local S3 look-alike. Nothing has been sent to a real bucket yet.

- [ ] In the Cloudflare dashboard, R2: create a bucket (for example `watchpost-prod`). Leave public access **off**.
- [ ] Bucket → Settings → Object lifecycle rules: delete objects with prefix `evidence/` 30 days after upload.
- [ ] R2 → Manage API tokens: create a token with **Object Read & Write** limited to that bucket. Copy the access key ID and the secret.
- [ ] Put `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` in the production environment. Leave `R2_ENDPOINT` empty.
- [ ] Deploy, make a monitor fail (the fake target's `/fail` works), and open the incident: the "What the failing check saw" card should show headers and the body.
- [ ] In the dashboard, confirm an object appeared under `evidence/` and that its public URL answers 401 or 404.
- [ ] If uploads fail with a checksum error, tell the agent: the S3 client's checksum settings in `backend/src/infra/storage/r2.ts` were chosen from Cloudflare's example and have not met a real bucket.

## When something is wrong

- **The card is missing on new incidents:** look for `evidence bundle not stored` in the API log. Results and incidents are never held back by a storage problem; only the bundle is skipped.
- **"The stored evidence for this region is no longer available":** the object is past 30 days, was deleted, or storage could not be reached when the page loaded.
- **Cost:** one small write per stored bundle and one read per view. During a large outage at most 100 bundles are stored per batch of results.

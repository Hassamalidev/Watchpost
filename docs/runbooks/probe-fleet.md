# Runbook: setting up and updating the probe fleet

Probes are small servers in different regions that run the checks (PRODUCT.md §7.6, §7.8, §16). Phase 2 uses three: `eu-central` (Frankfurt), `us-east` (New York or Virginia) and `ap-southeast` (Singapore), spread over at least two providers so one provider's outage can't take every region with it.

## What to buy

Per region one server with 1 vCPU, 1 to 2 GB of memory, a public IPv4 address and any current Debian or Ubuntu. About $5 to $7 a month each. Suggested split: two regions at one provider, the third at another.

## Set up one probe server (about 10 minutes each)

1. Install Docker with the compose plugin (`curl -fsSL https://get.docker.com | sh`). Create a user for deploys, add it to the `docker` group, and allow only your SSH key.
2. Firewall: allow inbound SSH from your own address only. The probe needs no inbound port; it calls the API.
3. On the core server (or your machine with the production `.env`), register the probe. This prints its credentials once:

   ```
   pnpm --filter @app/api probe:create --name eu-1 --region eu-central
   ```

4. On the probe server:

   ```
   sudo mkdir -p /opt/watchpost-probe && sudo chown $USER /opt/watchpost-probe
   ```

   Copy `probe/docker-compose.probe.yml` from this repo there as `docker-compose.yml`, and create `/opt/watchpost-probe/.env` (mode 600) with the printed lines plus the API's address:

   ```
   API_URL=https://app.<domain>
   PROBE_ID=...
   PROBE_SECRET=...
   PROBE_REGION=eu-central
   ```

5. Repeat for the other regions with their own name, region and credentials.

## Roll out an image

List the servers in `backend/scripts/probes.hosts` (this file is yours; don't commit it), the canary first:

```
eu-central    deploy@probe-eu-1.example.net
us-east       deploy@probe-us-1.example.net
ap-southeast  deploy@probe-ap-1.example.net
```

Then:

```
backend/scripts/deploy-probes.sh ghcr.io/<org>/watchpost-probe:<version>
```

The first server is updated alone and must report healthy before the others are touched; a failure stops the rollout and prints that probe's last log lines. `DRY_RUN=1` in front of the command prints what would run without connecting anywhere. There is no auto-updater on purpose: a bad probe build must not reach every region at once.

Until the image is published by CI (part of the production deploy, P1-T20), build it on a machine with Docker and push it to your registry: `docker build -f probe/Dockerfile -t <registry>/watchpost-probe:<version> . && docker push <registry>/watchpost-probe:<version>`.

## Check that it worked

- In the app: **Settings → Check regions** lists every region as "Working".
- `GET https://app.<domain>/api/ready` has no `probes` entry under `warnings`.
- A monitor's "Test now" shows a result from every region it uses.

## When a region is down

Results from the other regions keep confirming outages; monitors checked only from the dead region are not watched and say so on their page. See `probe-quarantine.md` for the notices and what to check. To replace a server, set up a new one with **new** credentials (`probe:create` again) rather than copying the old `.env`.

## Rollback

Run the script again with the previous image tag.

# Runbook: a probe was quarantined or stopped reporting

The probe health guard (`backend/src/modules/probes/guard.ts`, PRODUCT.md §9.2) protects customers from our own probe problems. When it acts, ops get an email at `OPS_EMAIL` (and an error line in the worker log); customers get nothing.

## What the two notices mean

**"Probe in <region> quarantined"**: one of our probes failed far more of its checks than usual, so its failures are being ignored. Either:

- one batch of results failed at least 90% of 20 or more monitors, or
- over the last five minutes it failed more than 30% of at least 50 monitors, and more than three times its failure rate over the previous 24 hours.

The quarantine lasts 10 minutes and is renewed every minute while the rule still holds. It ends on its own about 10 minutes after the probe looks normal again.

**"Probe in <region> stopped reporting"**: the probe hasn't contacted the API for more than two minutes. Sent once a day per probe while it lasts.

## What customers see meanwhile

- Results from that region don't count. Verification goes to the monitor's other regions.
- Monitors with other regions are confirmed from fewer of them. Their page shows a note saying so.
- Monitors checked **only** from that region are not being watched. Their page says so in red. This is the part that matters most: fix or replace the probe quickly.
- No incident is opened because of the broken probe, and no incident that is already open is resolved by it.

## What to do

1. Find the probe: the notice has its ID; `select id, name, region, last_seen_at, quarantined_until from probes where kind = 'managed' order by region;`
2. Check the host: is the container running (`docker ps`), does it have network and DNS, is the provider reporting an incident, is the disk full?
3. Check its path to the API: can it reach `https://<api host>/api/health`? A probe that can't reach us goes silent; a probe that can reach us but nothing else fails everything.
4. Look at what it reports: `select error_code, count(*) from check_results where probe_id = '<id>' and checked_at > now() - interval '10 minutes' group by 1 order by 2 desc;` One error code for everything (DNS, connect timeout) points at the probe's own network.
5. Fix or restart the probe. Nothing else is needed: once its results look normal the quarantine expires.

## If the probe was right

If many customers really are down at once (a large provider outage), the guard still quarantines the probe when only one region sees it. That is the intended trade: other regions confirm real outages. If every region sees the failures, each probe may be quarantined and nothing alerts; check the other regions' notices and, if the outage is real, end the quarantine by hand:

`update probes set quarantined_until = null where id = '<id>';`

The sweep will quarantine it again within a minute while the rule holds, so this is only useful together with a decision to trust the probe (for example by raising the thresholds in `guard.ts`).

## Limits to know

- The five-minute rule needs at least 50 monitors on the probe and the batch rule at least 20 in one batch. With fewer, there is no guard; multi-region confirmation is the protection.
- A customer's private probe is never quarantined: its network may really be down.
- Results from a quarantined probe are still stored, so per-check charts for that region show its failures.

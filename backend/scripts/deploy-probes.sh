#!/usr/bin/env bash
# Rolls a probe image out to the probe servers over SSH, one region first (PRODUCT.md §16).
#
#   backend/scripts/deploy-probes.sh <image> [hosts file]
#   backend/scripts/deploy-probes.sh ghcr.io/acme/watchpost-probe:1.4.0
#
# The hosts file (default: probes.hosts next to this script, never committed) has one probe per line:
#   <region>  <ssh target>          for example:  eu-central  deploy@probe-eu-1.example.net
# Lines starting with # and empty lines are skipped. The first line is the canary: it is updated
# alone and must report healthy before the others are touched. Any failure stops the rollout.
#
# Each server needs Docker with the compose plugin and, in /opt/watchpost-probe, the files
# docker-compose.yml (probe/docker-compose.probe.yml from this repo) and .env (the probe's
# credentials from `probe:create`). See docs/runbooks/probe-fleet.md.
#
# DRY_RUN=1 prints what would be run without connecting anywhere.
set -euo pipefail

IMAGE="${1:-}"
HOSTS_FILE="${2:-$(dirname "$0")/probes.hosts}"
REMOTE_DIR="${PROBE_REMOTE_DIR:-/opt/watchpost-probe}"
HEALTH_WAIT_SECONDS="${PROBE_HEALTH_WAIT_SECONDS:-90}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

if [ -z "$IMAGE" ]; then
  echo "Usage: $0 <image> [hosts file]" >&2
  exit 2
fi
if [ ! -f "$HOSTS_FILE" ]; then
  echo "No hosts file at $HOSTS_FILE. Create it with one '<region> <ssh target>' per line." >&2
  exit 2
fi
case "$IMAGE" in
  *[!A-Za-z0-9._/:@-]*)
    echo "The image name has characters that don't belong in one: $IMAGE" >&2
    exit 2
    ;;
esac

REGIONS=()
TARGETS=()
while read -r region target _; do
  case "$region" in "" | \#*) continue ;; esac
  if [ -z "${target:-}" ]; then
    echo "Line for '$region' in $HOSTS_FILE has no SSH target." >&2
    exit 2
  fi
  REGIONS+=("$region")
  TARGETS+=("$target")
done <"$HOSTS_FILE"

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "$HOSTS_FILE lists no probes." >&2
  exit 2
fi

run_remote() {
  local target="$1" command="$2"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "  [dry run] ssh $target -- $command"
    return 0
  fi
  ssh "${SSH_OPTS[@]}" "$target" "$command"
}

deploy_one() {
  local region="$1" target="$2"
  echo "==> $region ($target): $IMAGE"
  run_remote "$target" "cd '$REMOTE_DIR' && PROBE_IMAGE='$IMAGE' docker compose pull --quiet && PROBE_IMAGE='$IMAGE' docker compose up -d"
  # The container's own health check asks the probe's /healthz, which is green once it has synced.
  run_remote "$target" "cd '$REMOTE_DIR' && for i in \$(seq 1 $((HEALTH_WAIT_SECONDS / 3))); do s=\$(docker inspect --format '{{.State.Health.Status}}' \$(docker compose ps -q probe) 2>/dev/null || true); [ \"\$s\" = healthy ] && exit 0; sleep 3; done; echo 'probe did not become healthy' >&2; docker compose logs --tail 30 probe >&2; exit 1"
  echo "    healthy"
}

echo "Rolling out to ${#TARGETS[@]} probe(s); canary: ${REGIONS[0]}"
deploy_one "${REGIONS[0]}" "${TARGETS[0]}"
for i in "${!TARGETS[@]}"; do
  [ "$i" -eq 0 ] && continue
  deploy_one "${REGIONS[$i]}" "${TARGETS[$i]}"
done
echo "Done. Check Settings → Check regions in the app: every region should say Working."

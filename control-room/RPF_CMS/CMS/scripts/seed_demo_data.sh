#!/usr/bin/env bash
#
# Seeds demo alerts and incidents through the backend's own API, so the
# real routing/dispatch logic runs instead of hand-writing alert/
# alert_delivery/incident rows in SQL (which would bypass the composite
# FK guarantees and the partitioned-table constraints).
#
# Prerequisites:
#   1. sql/fixtures.sql already applied (zones, posts, nvr_units exist).
#   2. The backend is running and reachable at BACKEND_URL.
#
# Usage: bash scripts/seed_demo_data.sh

set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:7080}"

log() { echo "[seed_demo_data] $*"; }

nvr_id() {
  # Looks up an nvr_unit's id by name directly from Postgres, since the
  # API doesn't expose a registry lookup endpoint yet.
  PGPASSWORD="${DB_PASSWORD:-cms}" psql -h "${DB_HOST:-localhost}" -p "${DB_PORT:-5432}" \
    -U "${DB_USER:-cms}" -d "${DB_NAME:-cms}" -tAc \
    "SELECT id FROM nvr_unit WHERE name = '$1';"
}

post() {
  curl -s -X POST "$BACKEND_URL/api/alerts" -H "Content-Type: application/json" -d "$1"
}

log "checking backend health..."
curl -sf "$BACKEND_URL/health" > /dev/null || { echo "backend not reachable at $BACKEND_URL"; exit 1; }

NVR1=$(nvr_id nvr-1)
NVR2=$(nvr_id nvr-2)
[[ -n "$NVR1" && -n "$NVR2" ]] || { echo "nvr-1/nvr-2 not found - apply sql/fixtures.sql first"; exit 1; }

log "high-priority alert on nvr-1 (should auto-dispatch to an incident)..."
post "{\"nvr_id\":$NVR1,\"alert_type\":\"intrusion\",\"priority\":9,\"lat\":26.0,\"lon\":80.1}"; echo

log "high-priority alert on nvr-2 (should auto-dispatch to an incident)..."
post "{\"nvr_id\":$NVR2,\"alert_type\":\"unattended_bag\",\"priority\":8,\"lat\":26.2,\"lon\":81.4}"; echo

log "low-priority alert on nvr-1 (should sit in the operator queue)..."
post "{\"nvr_id\":$NVR1,\"alert_type\":\"loitering\",\"priority\":3,\"lat\":26.0,\"lon\":80.1}"; echo

log "another low-priority alert on nvr-2 (also queued, will be dismissed below)..."
post "{\"nvr_id\":$NVR2,\"alert_type\":\"loitering\",\"priority\":2,\"lat\":26.2,\"lon\":81.4}"; echo

log "current operator queue:"
curl -s "$BACKEND_URL/api/alerts/pending"; echo

log "promoting the first queued alert (operator decides it warrants an incident)..."
QUEUE_ID=$(curl -s "$BACKEND_URL/api/alerts/pending" | grep -o '"id":"\?[0-9]*' | head -1 | grep -o '[0-9]*')
if [[ -n "$QUEUE_ID" ]]; then
  curl -s -X POST "$BACKEND_URL/api/alerts/$QUEUE_ID/promote" \
    -H "Content-Type: application/json" -d '{"raised_by":1}'; echo
fi

log "dismissing whatever's left in the queue..."
REMAINING_ID=$(curl -s "$BACKEND_URL/api/alerts/pending" | grep -o '"id":"\?[0-9]*' | head -1 | grep -o '[0-9]*')
if [[ -n "$REMAINING_ID" ]]; then
  curl -s -X POST "$BACKEND_URL/api/alerts/$REMAINING_ID/dismiss"; echo
fi

log "done. Incidents now in the system:"
curl -s "$BACKEND_URL/api/incidents"; echo

#!/usr/bin/env bash
# Where do the alerts of the M-NVRs stop?  Read-only: it changes nothing. Run on the control-room PC:   bash diagnose-alerts.sh
# Hosts, ports and database names come from config/control-room.conf; the database login from RPF_CMS/rpf/.env (override with
# DB_USER / DB_PASSWORD / DB_NAME / DB_HOST / DB_PORT in the environment).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="${IPVSS_CONFIG:-$ROOT/config/control-room.conf}"
[[ -r "$CFG" ]] || { echo "config file not found: $CFG" >&2; exit 1; }
cfg(){ grep -E "^$1=" "$CFG" | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
envget(){ [[ -f "$2" ]] && grep -E "^$1=" "$2" | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
ENVF="$ROOT/RPF_CMS/rpf/.env"
DB_HOST="${DB_HOST:-$(cfg DB_HOST)}"; DB_PORT="${DB_PORT:-$(cfg DB_PORT)}"
DB_NAME="${DB_NAME:-$(envget DB_NAME "$ENVF")}"; DB_NAME="${DB_NAME:-$(cfg DB_NAME)}"
DB_USER="${DB_USER:-$(envget DB_USER "$ENVF")}"; DB_USER="${DB_USER:-$(cfg DB_USER)}"
export PGPASSWORD="${DB_PASSWORD:-$(envget DB_PASSWORD "$ENVF")}"
q(){ psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -X -P pager=off -c "$1"; }

echo "== 1. M-NVR units: is each one connecting, and to which zone does it belong?"
q "SELECT n.id, n.name, n.train_no, n.status, z.name AS zone,
          CASE WHEN n.cert_fingerprint LIKE 'pending-%' THEN 'NEVER CONNECTED (waiting for its bridge)' WHEN n.last_seen IS NULL THEN 'never heard' ELSE (round(extract(epoch FROM now() - n.last_seen))::text || ' s ago') END AS last_contact,
          (SELECT count(*) FROM alert a WHERE a.nvr_id = n.id) AS alerts_total,
          (SELECT count(*) FROM alert a WHERE a.nvr_id = n.id AND a.received_time > now() - interval '24 hours') AS alerts_24h
     FROM nvr_unit n LEFT JOIN zone z ON z.id = n.current_zone_id ORDER BY n.id"
echo "== 2. Zones: does the zone of each unit have an ACTIVE post to receive its alerts?"
q "SELECT z.id, z.name, (SELECT count(*) FROM rpf_post p WHERE p.zone_id = z.id AND p.active) AS active_posts,
          (SELECT count(*) FROM nvr_unit n WHERE n.current_zone_id = z.id) AS units
     FROM zone z ORDER BY z.id"
echo "== 3. Last 10 alerts: who received them?"
q "SELECT a.id, to_char(a.received_time,'MM-DD HH24:MI:SS') AS at, a.alert_type, a.priority, n.name AS unit, a.zone_id, a.assigned_post_id AS post,
          (SELECT count(*) FROM alert_delivery d WHERE d.alert_id = a.id) AS deliveries
     FROM alert a LEFT JOIN nvr_unit n ON n.id = a.nvr_id ORDER BY a.id DESC LIMIT 10"
echo "== 4. Last 8 footage requests: did the commands reach the M-NVRs?"
q "SELECT t.id, t.train_no, t.status, to_char(t.created_at,'MM-DD HH24:MI') AS asked, t.cameras_total AS cams, t.cameras_fulfilled AS got,
          (SELECT count(*) FROM nvr_command m WHERE m.train_request_id = t.id AND m.status = 'queued') AS queued,
          (SELECT count(*) FROM nvr_command m WHERE m.train_request_id = t.id AND m.status IN ('sent','acked')) AS taken_by_unit,
          (SELECT count(*) FROM nvr_command m WHERE m.train_request_id = t.id AND m.status = 'done') AS done,
          (SELECT count(*) FROM nvr_command m WHERE m.train_request_id = t.id AND m.status IN ('failed','cancelled')) AS failed_or_cancelled
     FROM train_request t ORDER BY t.id DESC LIMIT 8"
echo "== 5. Waiting commands per unit"
q "SELECT n.name, n.train_no, CASE WHEN n.last_seen IS NULL THEN 'never' ELSE round(extract(epoch FROM now() - n.last_seen))::text || ' s ago' END AS last_contact,
          count(*) FILTER (WHERE m.status = 'queued') AS queued, count(*) FILTER (WHERE m.status IN ('sent','acked')) AS taken_by_unit
     FROM nvr_unit n LEFT JOIN nvr_command m ON m.nvr_id = n.id AND m.status IN ('queued','sent','acked') GROUP BY n.id ORDER BY n.id"
cat <<'TXT'
== How to read it
 1. A unit with  NEVER CONNECTED  has not reached the CMS yet: its bridge is not running, cannot reach this PC, or uses another name
    (the unit name must equal the M-NVR's device name). A big "last_contact" number means the same: nothing arrives from it.
    Two rows for one train PC (one never connected, one connected) = the bridge registered under a different name than the one typed
    in the console: delete nothing, just use the name of the row that connects.
 2. active_posts = 0 for a unit's zone: alerts are created but have nobody to go to. Register the RPF post in THAT zone, or move the unit to
    the zone of the post (CMS console -> M-NVR units -> the unit -> Move to another zone; super admin).
 4. Requests: queued = commands waiting for the unit to connect (normal while the train is out of coverage: they are kept for as long as it takes and
    handed over the moment it connects); taken_by_unit = the unit has them and is uploading; done / failed = the unit answered. A request with
    cams above 0 but no commands at all was not fanned out: look for a line starting "request #" in the CMS log.
    A big last_contact for the unit that should get them means the train PC cannot reach the CMS: on the train PC run  bash start.sh status.
 3. Alerts listed with deliveries = 0 reached the CMS but not a post (see 2). No alert rows at all, while last_contact is small: the bridge
    connects but sends none - on the TRAIN PC run  bash start.sh status  and read "last_error" in the alerts section (for example "no GPS
    position": set FALLBACK_LAT / FALLBACK_LON, or the M-NVR has no GPS fix) and "filtered" (the event types are not forwarded).
TXT

#!/usr/bin/env bash
# Prepare the PostgreSQL of ONE computer so its CMS can share data with the other CMS of a cluster.
# Run it on EVERY computer that hosts a CMS database, as an account that can run psql as the postgres superuser:
#     sudo -u postgres bash prepare-db.sh --allow 10.0.0.0/8
#
#   --dbname   the CMS database                       (default: cms)
#   --repl-user  the account the other CMS read with   (default: cms_repl)
#   --allow    network the other CMS computers are in  (CIDR, e.g. 10.0.0.0/8) - written to pg_hba.conf
#   --password password for the replication account    (default: a random one, printed at the end)
#   --dry-run  only print what would be done
#
# It sets wal_level=logical (PostgreSQL must then be RESTARTED once), makes room for replication connections, creates a read-only
# replication account and allows the other CMS computers to connect. It never touches your data.
set -euo pipefail
DB=cms; REPL=cms_repl; ALLOW=""; PASS=""; DRY=0
while [ $# -gt 0 ]; do case "$1" in
  --dbname) DB="$2"; shift 2;; --repl-user) REPL="$2"; shift 2;; --allow) ALLOW="$2"; shift 2;; --password) PASS="$2"; shift 2;; --dry-run) DRY=1; shift;;
  *) echo "unknown option $1"; exit 2;; esac; done
PSQL="psql -v ON_ERROR_STOP=1 -X -q -tA"
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else eval "$@"; fi; }
[ -n "$PASS" ] || PASS="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"

echo "1/4 server settings for logical replication"
for kv in "wal_level='logical'" "max_wal_senders=20" "max_replication_slots=20" "max_logical_replication_workers=16" "max_worker_processes=24"; do
  run "$PSQL -d postgres -c \"ALTER SYSTEM SET ${kv%%=*} = ${kv#*=}\""
done
echo "2/4 replication account '$REPL'"
run "$PSQL -d postgres -c \"DO \\\$\\\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$REPL') THEN CREATE ROLE $REPL LOGIN REPLICATION PASSWORD '$PASS'; ELSE ALTER ROLE $REPL LOGIN REPLICATION PASSWORD '$PASS'; END IF; END \\\$\\\$\""
run "$PSQL -d $DB -c \"GRANT SELECT ON ALL TABLES IN SCHEMA public TO $REPL; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO $REPL\""
echo "3/4 who may connect (pg_hba.conf)"
if [ -n "$ALLOW" ]; then
  HBA="$($PSQL -d postgres -c 'SHOW hba_file')"; LINE="host    $DB    $REPL    $ALLOW    scram-sha-256"
  if [ "$DRY" = 1 ]; then echo "[dry-run] would add to $HBA: $LINE"
  elif grep -qF "$LINE" "$HBA"; then echo "   already allowed in $HBA"
  else cp "$HBA" "$HBA.bak-cluster"; printf '\n# CMS cluster: the other CMS computers read this database\n%s\n' "$LINE" >> "$HBA"; echo "   added to $HBA (backup: $HBA.bak-cluster)"; fi
  run "$PSQL -d postgres -c 'SELECT pg_reload_conf()' >/dev/null"
else echo "   skipped (no --allow). Add a line like:  host $DB $REPL <network-of-the-other-CMS> scram-sha-256"; fi
echo "4/4 listening address"
LA="$($PSQL -d postgres -c 'SHOW listen_addresses')"; echo "   listen_addresses = $LA  (the other CMS computers must be able to reach it; set '*' or this computer's address if it says localhost)"
echo
echo "DONE. Now RESTART PostgreSQL once (wal_level only changes on a restart), e.g.:  sudo systemctl restart postgresql"
echo "Replication account:  user=$REPL  password=$PASS   (use it in the --seed-db / --my-db connection of  node scripts/cluster.js join)"

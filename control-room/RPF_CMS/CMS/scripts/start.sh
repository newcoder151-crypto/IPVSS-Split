#!/usr/bin/env bash
#
# CMS launcher (native)
#
#   FIRST TIME:   bash scripts/start.sh --setup-db
#   EVERY RUN:    bash scripts/start.sh
#
#   FLAGS:
#     --setup-db   Create role, db, extensions, apply schema, seed data
#     --build      Build the application (placeholder until app code exists)
#     --stop       Stop app processes (does NOT touch the Postgres service)
#     --restart    Stop then start app processes
#     --status     Show Postgres service status + any running app processes
#     --logs <svc> Tail logs for a service (app services; use journalctl for postgres)
#
# Assumes: Postgres 15 + PostGIS already installed and running as a system
# service (see install steps in the accompanying message). This script owns
# the "cms" role/database/schema and any app processes it starts -- it does
# NOT install, start, or stop the Postgres service itself, since that
# service may be shared by other things on the machine.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

SQL_DIR="$PROJECT_ROOT/sql"
ENV_FILE="$PROJECT_ROOT/.env"
RUN_DIR="$PROJECT_ROOT/run"
LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"

log()  { echo "[start.sh] $*"; }
fail() { echo "[start.sh] ERROR: $*" >&2; exit 1; }

require_env() {
  [[ -f "$ENV_FILE" ]] || fail ".env not found at $ENV_FILE. Copy .env.example and edit it first."
}

db_env() {
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  DB_NAME="${DB_NAME:-cms}"
  DB_USER="${DB_USER:-cms_app}"
  DB_HOST="${DB_HOST:-localhost}"
  DB_PORT="${DB_PORT:-5432}"
  PG_SUPERUSER="${PG_SUPERUSER:-postgres}"
}

check_postgres_running() {
  if ! pg_isready -h "$DB_HOST" -p "$DB_PORT" >/dev/null 2>&1; then
    fail "Postgres is not accepting connections on $DB_HOST:$DB_PORT. Start the service first: sudo systemctl start postgresql"
  fi
}

setup_db() {
  require_env
  db_env
  check_postgres_running

  log "creating role '$DB_USER' (skips if it already exists)..."
  sudo -u "$PG_SUPERUSER" psql -v ON_ERROR_STOP=0 -c \
    "CREATE ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASSWORD';" 2>/dev/null \
    || log "role '$DB_USER' already exists, continuing."

  log "creating database '$DB_NAME' owned by '$DB_USER' (skips if it already exists)..."
  sudo -u "$PG_SUPERUSER" psql -v ON_ERROR_STOP=0 -c \
    "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null \
    || log "database '$DB_NAME' already exists, continuing."

  log "enabling postgis and pgcrypto extensions..."
  # CREATE EXTENSION requires superuser here (postgis/pgcrypto aren't
  # marked "trusted"), so this one step stays on $PG_SUPERUSER even
  # though schema/seed below run as $DB_USER.
  sudo -u "$PG_SUPERUSER" psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -c \
    "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS pgcrypto;"

  log "checking whether schema is already applied..."
  local exists
  exists=$(sudo -u "$PG_SUPERUSER" psql -d "$DB_NAME" -tAc \
    "SELECT 1 FROM information_schema.tables WHERE table_name = 'zone';")
  if [[ "$exists" == "1" ]]; then
    log "schema already applied (table 'zone' exists) - skipping. Drop and recreate the DB to re-apply cleanly."
  else
    log "applying schema (sql/schema.sql)..."
    cat "$SQL_DIR/schema.sql" | PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1
    log "schema applied."
  fi

  log "applying seed data (sql/seed.sqlx)..."
  cat "$SQL_DIR/seed.sqlx" | PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1

  # Workflow + live-update migrations. Idempotent, so they run every time; they MUST run before sql/fixtures.sql.
  for mig in "$SQL_DIR"/migrations/*.sql; do
    [ -f "$mig" ] || continue
    log "applying migration $(basename "$mig")..."
    PGOPTIONS="-c client_min_messages=warning" PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f "$mig" || fail "migration $(basename "$mig") failed"
  done
  log "seed data applied."
}

build_app() {
  log "no application code wired in yet - nothing to build."
  log "once backend/ingest code exists, add its build steps here (e.g. npm run build, go build, etc.)."
}

# --- app process management (placeholder until real services exist) ----
# Each service is expected to be a single foreground command that this
# script backgrounds, tracked by a PID file in run/ and logging to logs/.
# Replace the placeholder entries in this array as services are added.
declare -A SERVICES=(
  # [backend]="node backend/dist/server.js"
  # [ingest]="node ingest/dist/server.js"
)

start_services() {
  require_env
  db_env
  check_postgres_running
  log "Postgres is reachable at $DB_HOST:$DB_PORT."

  if [[ ${#SERVICES[@]} -eq 0 ]]; then
    log "no app services configured yet - Postgres is the only thing running."
    return 0
  fi

  for svc in "${!SERVICES[@]}"; do
    local pidfile="$RUN_DIR/$svc.pid"
    if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      log "$svc already running (pid $(cat "$pidfile"))."
      continue
    fi
    log "starting $svc..."
    nohup bash -c "${SERVICES[$svc]}" >> "$LOG_DIR/$svc.log" 2>&1 &
    echo $! > "$pidfile"
    log "$svc started (pid $(cat "$pidfile"))."
  done
}

stop_services() {
  if [[ ${#SERVICES[@]} -eq 0 ]]; then
    log "no app services configured - nothing to stop. (Postgres service is left running on purpose.)"
    return 0
  fi
  for svc in "${!SERVICES[@]}"; do
    local pidfile="$RUN_DIR/$svc.pid"
    if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      log "stopping $svc (pid $(cat "$pidfile"))..."
      kill "$(cat "$pidfile")"
      rm -f "$pidfile"
    else
      log "$svc not running."
    fi
  done
}

restart_services() {
  stop_services
  start_services
}

show_status() {
  db_env
  echo "-- Postgres service --"
  systemctl is-active postgresql 2>/dev/null || echo "unknown (systemctl not available or not systemd)"
  pg_isready -h "$DB_HOST" -p "$DB_PORT" || true
  echo
  echo "-- App services --"
  if [[ ${#SERVICES[@]} -eq 0 ]]; then
    echo "none configured yet"
  else
    for svc in "${!SERVICES[@]}"; do
      local pidfile="$RUN_DIR/$svc.pid"
      if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
        echo "$svc: running (pid $(cat "$pidfile"))"
      else
        echo "$svc: stopped"
      fi
    done
  fi
}

show_logs() {
  local svc="${1:-}"
  [[ -n "$svc" ]] || fail "--logs requires a service name, e.g. --logs backend"
  if [[ "$svc" == "db" || "$svc" == "postgres" ]]; then
    log "Postgres logs aren't managed by this script. Try: sudo journalctl -u postgresql -f"
    exit 0
  fi
  local logfile="$LOG_DIR/$svc.log"
  [[ -f "$logfile" ]] || fail "no log file at $logfile yet."
  tail -f "$logfile"
}

# --- argument parsing ---------------------------------------------------

if [[ $# -eq 0 ]]; then
  start_services
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup-db)   setup_db; shift ;;
    --build)      build_app; shift ;;
    --stop)       stop_services; shift ;;
    --restart)    restart_services; shift ;;
    --status)     show_status; shift ;;
    --logs)       shift; show_logs "${1:-}"; shift || true ;;
    *)            fail "unknown flag: $1" ;;
  esac
done
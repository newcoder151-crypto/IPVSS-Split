#!/usr/bin/env bash
# =============================================================================
# start.sh - one command to run the whole stack:
#
#   PostgreSQL  ->  CMS database (schema, seed, partitions)  ->  CMS backend
#               ->  RPF server (API + dashboard)  ->  [demo: CMS stand-in]
#
#   bash scripts/start.sh [command] [flags]
#
# Commands
#   start      (default) bring everything up in the background; safe to re-run
#   run        like start, but stay in the foreground: watch the services, restart any
#              that crash, stream the logs, and stop everything on Ctrl-C (also: start -f)
#   stop       stop the supervisor, CMS backend, RPF and the demo stand-in (never Postgres)
#   restart    stop, then start
#   status     what is running, and whether it answers
#   users ...  RPF logins:  users list | users add <name> <role> [post/zone] [password]
#                           users password <name> [new-password]
#   service-file  print a systemd unit that runs "run" at boot (see README)
#   logs [svc] follow logs: cms | rpf | sim | all (default all)
#   setup-db   only prepare the database (role, db, schema, seed, partitions)
#   check      read-only check that the database suits RPF
#   help
#
# Flags
#   --demo     also load demo zones/posts/NVRs and demo logins, raise a few demo
#              alerts through the CMS backend, and run the stand-in for the CMS
#              operator + footage ingest. DEV ONLY.
#   --no-db    do not touch the database (assume it is already prepared)
#   -f, --foreground   same as the "run" command
#
# Configuration: .env in the RPF folder (created on first run, with random
# secrets). CMS code is located via CMS_DIR (default: ../CMS). CMS is never
# modified; its own .env files are not used (values are passed in).
# =============================================================================
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
cd "$ROOT"

# ---- settings: hosts, ports, database names live in control-room/config/control-room.conf (nothing is hard-coded here) ---------
CFG="${IPVSS_CONFIG:-$ROOT/../../config/control-room.conf}"
[[ -r "$CFG" ]] || { echo "error: config file not found: $CFG  (restore control-room/config/control-room.conf, or point IPVSS_CONFIG at yours)" >&2; exit 1; }
cfg(){ grep -E "^$1=" "$CFG" | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
cfg_need(){ local v="${!1:-}"; [[ -n "$v" ]] || v="$(cfg "$1")"; [[ -n "$v" ]] || { echo "error: $1 is not set in $CFG" >&2; exit 1; }; printf '%s' "$v"; }
CFG_LOOPBACK_HOST="$(cfg_need LOOPBACK_HOST)"; CFG_DB_HOST="$(cfg_need DB_HOST)"; CFG_DB_PORT="$(cfg_need DB_PORT)"
CFG_DB_NAME="$(cfg_need DB_NAME)"; CFG_DB_USER="$(cfg_need DB_USER)"; CFG_DB_ADMIN_USER="$(cfg_need DB_ADMIN_USER)"
CFG_CMS_PORT="$(cfg_need CMS_PORT)"; CFG_RPF_PORT="$(cfg_need RPF_PORT)"; CFG_SIM_UNITS="$(cfg_need SIM_UNITS)"
CFG_LOCAL_HOSTS="$(cfg_need LOCAL_HOST_NAMES)"; CFG_RESERVED_PORTS="$(cfg_need RESERVED_PORTS)"
RUN="$ROOT/run"; LOGS="$ROOT/logs"
mkdir -p "$RUN" "$LOGS"

C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
[[ -t 1 ]] || { C_RED=; C_GRN=; C_YEL=; C_DIM=; C_OFF=; }
say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%swarn:%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

# ---------- arguments ---------------------------------------------------------
CMD="start"; DEMO=0; NO_DB=0; FOREGROUND=0; LOG_TARGET="all"; USER_ARGS=()
args=("$@")
if [[ ${#args[@]} -gt 0 && "${args[0]}" != -* ]]; then CMD="${args[0]}"; args=("${args[@]:1}"); fi
if [[ "$CMD" == users ]]; then
  if [[ ${#args[@]} -gt 0 ]]; then USER_ARGS=("${args[@]}"); fi
  args=()
fi
for a in "${args[@]:-}"; do
  case "$a" in
    "") ;;
    --demo) DEMO=1 ;;
    --no-db) NO_DB=1 ;;
    -f|--foreground) FOREGROUND=1 ;;
    cms|rpf|sim|all) LOG_TARGET="$a" ;;
    *) die "unknown argument: $a (try: bash scripts/start.sh help)" ;;
  esac
done
[[ "$CMD" == start && "$FOREGROUND" == 1 ]] && CMD=run
# legacy flag spellings from the previous start.sh
case "$CMD" in --check) CMD=check ;; --stop) CMD=stop ;; --status) CMD=status ;; --setup-db) CMD=setup-db ;; esac

usage() { sed -n '2,/^# ====*$/p' "$SELF" | sed '$d' | sed 's/^# \{0,1\}//'; }
[[ "$CMD" == help || "$CMD" == -h || "$CMD" == --help ]] && { usage; exit 0; }

# ---------- .env (created on first run) ----------------------------------------
rand_hex() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

set_env() { # set_env KEY VALUE  (replace the line if present, else append)
  local key="$1" val="$2" tmp; tmp="$(mktemp)"
  if grep -q "^${key}=" .env 2>/dev/null; then
    KEY="$key" VAL="$val" awk 'BEGIN{k=ENVIRON["KEY"];v=ENVIRON["VAL"]} $0 ~ "^"k"=" {print k"="v; next} {print}' .env > "$tmp"
  else
    { cat .env 2>/dev/null; printf '%s=%s\n' "$key" "$val"; } > "$tmp"
  fi
  cat "$tmp" > .env; rm -f "$tmp"
}

ensure_env_file() {
  if [[ ! -f .env ]]; then
    [[ -f .env.example ]] || die ".env.example is missing"
    step "First run: creating .env with generated secrets"
    cp .env.example .env
    set_env DB_HOST     "${DB_HOST:-$CFG_DB_HOST}"
    set_env DB_PORT     "${DB_PORT:-$CFG_DB_PORT}"
    set_env DB_NAME     "${DB_NAME:-$CFG_DB_NAME}"
    set_env DB_USER     "${DB_USER:-$CFG_DB_USER}"
    set_env DB_PASSWORD "${DB_PASSWORD:-$(rand_hex 16)}"
    set_env PORT        "${PORT:-$CFG_RPF_PORT}"
    set_env CMS_PORT    "${CMS_PORT:-$CFG_CMS_PORT}"
    set_env JWT_SECRET  "$(rand_hex 48)"
    set_env CMS_JWT_SECRET "$(rand_hex 48)"
    chmod 600 .env
    say "    wrote $ROOT/.env (review it; keep it out of version control)"
  fi
  # an existing .env with a blank secret still gets one
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
  if [[ -z "${CMS_JWT_SECRET:-}" || ${#CMS_JWT_SECRET} -lt 32 ]]; then
    step "Generating CMS_JWT_SECRET"; set_env CMS_JWT_SECRET "$(rand_hex 48)"; set -a; . ./.env; set +a
  fi
  if [[ -z "${JWT_SECRET:-}" || ${#JWT_SECRET} -lt 32 ]]; then
    step "Generating JWT_SECRET"; set_env JWT_SECRET "$(rand_hex 48)"; set -a; . ./.env; set +a
  fi
  [[ -n "${DB_PASSWORD:-}" && "$DB_PASSWORD" != "changeme" ]] || die "set DB_PASSWORD in .env (it is blank or still 'changeme')"
}

# ---------- settings -----------------------------------------------------------
load_settings() {
  ensure_env_file
  DB_HOST="${DB_HOST:-$CFG_DB_HOST}"; DB_PORT="${DB_PORT:-$CFG_DB_PORT}"; DB_NAME="${DB_NAME:-$CFG_DB_NAME}"; DB_USER="${DB_USER:-$CFG_DB_USER}"
  MEDIA_DIR="$(cd "$ROOT" && mkdir -p "${MEDIA_ROOT:-./media}" && cd "${MEDIA_ROOT:-./media}" && pwd)"   # one footage store for CMS and RPF
  # The ports are FIXED: CMS_PORT and RPF_PORT in config/control-room.conf. A port remembered in .env (or a PORT in the shell) is not used;
  # .env is rewritten from the config so everything that reads it sees the same values.
  RPF_PORT="$CFG_RPF_PORT"; CMS_PORT="$CFG_CMS_PORT"
  set_env PORT "$RPF_PORT"; set_env CMS_PORT "$CMS_PORT"
  CMS_DIR="${CMS_DIR:-$ROOT/../CMS}"
  PG_SUPERUSER="${PG_SUPERUSER:-$CFG_DB_ADMIN_USER}"
  PRIORITY_THRESHOLD="${PRIORITY_THRESHOLD:-7}"
  RPF_LEAST_PRIVILEGE="${RPF_LEAST_PRIVILEGE:-0}"
  ENSURE_PARTITIONS="${ENSURE_PARTITIONS:-1}"
  PARTITION_MONTHS_AHEAD="${PARTITION_MONTHS_AHEAD:-3}"
  [[ "$RPF_PORT" != "$CMS_PORT" ]] || die "PORT (RPF) and CMS_PORT are both $RPF_PORT; choose different ports in .env"
  SETSID="$(command -v setsid || true)"
  if [[ "$RPF_LEAST_PRIVILEGE" == 1 && -z "${RPF_APP_PASSWORD:-}" ]]; then
    set_env RPF_APP_PASSWORD "$(rand_hex 16)"; set -a; . ./.env; set +a
  fi
}

is_local_db() { local h; for h in $CFG_LOCAL_HOSTS; do [[ "$DB_HOST" == "$h" ]] && return 0; done; return 1; }

preflight() {
  local missing=()
  for c in node npm psql curl; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
  [[ ${#missing[@]} -eq 0 ]] || die "missing required commands: ${missing[*]}"
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge 18 ]] || die "Node.js 18 or newer is required (found $(node -v))"
  [[ -f "$CMS_DIR/sql/schema.sql" && -f "$CMS_DIR/backend/src/server.js" ]] \
    || die "CMS code not found at CMS_DIR=$CMS_DIR. Put the CMS folder next to rpf, or set CMS_DIR in .env"
  CMS_DIR="$(cd "$CMS_DIR" && pwd)"
}

# ---------- PostgreSQL ---------------------------------------------------------
pg_up() {
  if command -v pg_isready >/dev/null 2>&1; then pg_isready -q -h "$DB_HOST" -p "$DB_PORT"
  else (exec 3<>"/dev/tcp/$DB_HOST/$DB_PORT") 2>/dev/null; fi
}
as_root() { if [[ $EUID -eq 0 ]]; then "$@"; elif command -v sudo >/dev/null 2>&1; then sudo "$@"; else return 1; fi; }

ensure_postgres_running() {
  if pg_up; then say "    PostgreSQL is accepting connections on $DB_HOST:$DB_PORT"; return 0; fi
  is_local_db || die "PostgreSQL at $DB_HOST:$DB_PORT is not reachable (remote servers are not started by this script)"
  step "PostgreSQL is not running; trying to start it"
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files postgresql.service >/dev/null 2>&1; then
    as_root systemctl start postgresql 2>/dev/null || true
  fi
  if ! pg_up && command -v pg_lsclusters >/dev/null 2>&1; then
    local ver name
    while read -r ver name _; do as_root pg_ctlcluster "$ver" "$name" start 2>/dev/null || true; done < <(pg_lsclusters --no-header 2>/dev/null)
  fi
  if ! pg_up && command -v service >/dev/null 2>&1; then as_root service postgresql start 2>/dev/null || true; fi
  if ! pg_up && command -v brew >/dev/null 2>&1; then brew services start postgresql 2>/dev/null || true; fi
  local i; for i in $(seq 1 20); do pg_up && break; sleep 1; done
  pg_up || die "could not start PostgreSQL. Start it yourself, then re-run (check: pg_isready -h $DB_HOST -p $DB_PORT)"
  say "    PostgreSQL started"
}

psql_super() { # superuser, local socket (sudo/su) or TCP with PG_SUPERUSER_PASSWORD
  if [[ -n "${PG_SUPERUSER_PASSWORD:-}" ]]; then
    PGOPTIONS="-c client_min_messages=warning" PGPASSWORD="$PG_SUPERUSER_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$PG_SUPERUSER" -v ON_ERROR_STOP=1 -q "$@"
  elif is_local_db && [[ $EUID -eq 0 ]] && id "$PG_SUPERUSER" >/dev/null 2>&1; then
    (cd / && su "$PG_SUPERUSER" -c "PGOPTIONS='-c client_min_messages=warning' psql -p $DB_PORT -v ON_ERROR_STOP=1 -q $(printf '%q ' "$@")")
  elif is_local_db && command -v sudo >/dev/null 2>&1 && id "$PG_SUPERUSER" >/dev/null 2>&1; then
    (cd / && sudo -u "$PG_SUPERUSER" env PGOPTIONS="-c client_min_messages=warning" psql -p "$DB_PORT" -v ON_ERROR_STOP=1 -q "$@")
  else
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$PG_SUPERUSER" -v ON_ERROR_STOP=1 -q "$@"
  fi
}
psql_owner() { PGOPTIONS="-c client_min_messages=warning" PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q "$@"; }
owner_can_connect() { psql_owner -tAc 'SELECT 1' >/dev/null 2>&1; }
rpf_app_can_connect() { PGPASSWORD="$RPF_APP_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U rpf_app -d "$DB_NAME" -tAc 'SELECT 1' >/dev/null 2>&1; }
owner_val() { psql_owner -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }

# One DO block per month: creates the partition unless that month is already covered.
ensure_partitions() {
  [[ "$ENSURE_PARTITIONS" == 1 ]] || return 0
  psql_owner <<SQL
DO \$\$
DECLARE
  tbl text; m date; nxt date; part text; i int;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['alert','gps_point'] LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN CONTINUE; END IF;
    FOR i IN 0..${PARTITION_MONTHS_AHEAD} LOOP
      m := (date_trunc('month', now()) + make_interval(months => i))::date;
      nxt := (m + interval '1 month')::date;
      part := format('%s_%s', tbl, to_char(m, 'YYYY_MM'));
      BEGIN
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', part, tbl, m, nxt);
      EXCEPTION WHEN invalid_object_definition OR duplicate_table THEN
        NULL; -- that month is already covered by a differently named partition
      END;
    END LOOP;
  END LOOP;
END \$\$;
SQL
}

create_role_and_db() {
  psql_super -d postgres -v role="$DB_USER" -v pw="$DB_PASSWORD" -v db="$DB_NAME" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role')
\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db')
\gexec
SQL
}

ensure_database() {
  step "Database"
  ensure_postgres_running

  if owner_can_connect; then
    say "    connected to '$DB_NAME' as '$DB_USER'"
  else
    step "Creating role '$DB_USER' and database '$DB_NAME'"
    create_role_and_db \
      || die "could not create the role/database. Run as a user with sudo, set PG_SUPERUSER_PASSWORD in .env, or create them yourself (see README)."
    psql_super -d "$DB_NAME" -c 'CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS pgcrypto;' \
      || die "could not enable the postgis/pgcrypto extensions. Install PostGIS for your PostgreSQL version (e.g. apt install postgresql-postgis)."
    owner_can_connect || die "the database role '$DB_USER' already exists but rejects the DB_PASSWORD in .env.
       Either put the role's real password in .env (DB_PASSWORD=...), or reset the role to match .env:
         sudo -u $PG_SUPERUSER psql -c \"ALTER ROLE $DB_USER PASSWORD '<password from .env>'\"
       (If another application, e.g. your CMS .env, uses this role, copy its password from there instead.)"
  fi

  if [[ -z "$(owner_val "SELECT to_regclass('public.zone')")" ]]; then
    step "Applying CMS schema"; psql_owner -f "$CMS_DIR/sql/schema.sql"
  else
    say "    CMS schema already present"
  fi
  if [[ -z "$(owner_val "SELECT 1 FROM users WHERE username = 'system'")" ]]; then
    step "Applying CMS seed (admin + system users)"; psql_owner -f "$CMS_DIR/sql/seed.sqlx"
  fi
  # CMS workflow + live-update migrations (idempotent: safe on every start)
  local mig
  for mig in "$CMS_DIR"/sql/migrations/*.sql; do
    [[ -f "$mig" ]] || continue
    psql_owner -f "$mig" || die "migration $(basename "$mig") failed"
  done
  say "    CMS migrations applied"
  if [[ "$ENSURE_PARTITIONS" == 1 ]]; then
    ensure_partitions && say "    monthly partitions ensured (this month + $PARTITION_MONTHS_AHEAD ahead)"
  fi

  if [[ "$DEMO" == 1 ]]; then
    step "Demo data: zones, posts, NVR units, cameras, demo logins"
    psql_owner -f "$CMS_DIR/sql/fixtures.sql"
    node "$ROOT/scripts/seed_demo.js" | sed 's/^/    /'
  fi

  if [[ "$RPF_LEAST_PRIVILEGE" == 1 ]]; then
    step "Least-privilege role 'rpf_app' for the RPF server"
    psql_super -d "$DB_NAME" -v rpf_password="$RPF_APP_PASSWORD" -f "$ROOT/sql/rpf_app_role.sql" \
      || die "could not create rpf_app (needs a superuser). Set RPF_LEAST_PRIVILEGE=0 to run RPF as '$DB_USER'."
    # Roles are cluster-wide: if rpf_app already existed with another password, make it match .env.
    if ! rpf_app_can_connect; then
      warn "role rpf_app already existed with a different password; resetting it to RPF_APP_PASSWORD from .env"
      psql_super -d postgres -v pw="$RPF_APP_PASSWORD" <<'SQL' || die "could not reset the rpf_app password"
ALTER ROLE rpf_app PASSWORD :'pw'
SQL
      rpf_app_can_connect || die "rpf_app still cannot connect to '$DB_NAME' (check pg_hba.conf allows password logins)"
    fi
  fi
}

# ---------- process management ---------------------------------------------------
pidfile() { echo "$RUN/$1.pid"; }
running() { local f; f="$(pidfile "$1")"; [[ -f "$f" ]] && kill -0 "$(cat "$f")" 2>/dev/null; }
port_busy() { (exec 3<>"/dev/tcp/$CFG_LOOPBACK_HOST/$1") 2>/dev/null; }

spawn() { # spawn NAME WORKDIR -- [VAR=val ...] COMMAND [ARGS...]   (detached, logs to logs/NAME.log)
  local name="$1" dir="$2"; shift 3
  local -a envs=() cmd=() w
  for w in "$@"; do
    if [[ ${#cmd[@]} -eq 0 && "$w" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then envs+=("$w"); else cmd+=("$w"); fi
  done
  local pf; pf="$(pidfile "$name")"; rm -f "$pf"
  # Redirections sit on the whole subshell and the subshell exec()s into the service, so nothing
  # left running holds the caller's stdout/stderr/stdin (otherwise `start.sh | tee` or CI would
  # hang). The child writes its own pid just before exec, so the pid on file is the real process
  # even though setsid may fork.
  ( cd "$dir" || exit 1
    exec env "${envs[@]}" ${SETSID:+"$SETSID"} nohup sh -c 'echo $$ > "$0"; exec "$@"' "$pf" "${cmd[@]}" \
  ) >> "$LOGS/$name.log" 2>&1 < /dev/null &
  local i; for i in $(seq 1 40); do [[ -s "$pf" ]] && return 0; sleep 0.1; done
  warn "could not record the pid of $name"; return 1
}

wait_http() { # wait_http NAME URL
  local name="$1" url="$2" i
  for i in $(seq 1 30); do
    curl -fsS -m 2 "$url" >/dev/null 2>&1 && return 0
    running "$name" || { warn "$name exited during start-up; last log lines:"; tail -n 15 "$LOGS/$name.log" >&2 || true; return 1; }
    sleep 1
  done
  warn "$name did not answer at $url within 30s; see $LOGS/$name.log"; return 1
}

start_cms() {
  if running cms; then say "    CMS backend already running (pid $(cat "$(pidfile cms)"))"; return 0; fi
  port_busy "$CMS_PORT" && die "port $CMS_PORT is already in use by another process (set CMS_PORT in .env)"
  [[ -d "$CMS_DIR/backend/node_modules" ]] || { step "Installing CMS backend dependencies"; (cd "$CMS_DIR/backend" && npm install --omit=dev --no-audit --no-fund --silent); }
  step "Starting CMS backend on :$CMS_PORT"
  spawn cms "$CMS_DIR/backend" -- \
    DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_NAME="$DB_NAME" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" \
    PORT="$CMS_PORT" PORT_AUTO=0 PRIORITY_THRESHOLD="$PRIORITY_THRESHOLD" CMS_JWT_SECRET="$CMS_JWT_SECRET" MEDIA_ROOT="$MEDIA_DIR" \
    LEGACY_API="${LEGACY_API:-$([[ "$DEMO" == 1 ]] && echo 1 || echo 0)}" \
    AUTO_APPROVE_REQUESTS="${AUTO_APPROVE_REQUESTS:-0}" node src/server.js
  wait_http cms "http://$CFG_LOOPBACK_HOST:$CMS_PORT/health" || return 1
}

start_rpf() {
  if running rpf; then say "    RPF already running (pid $(cat "$(pidfile rpf)"))"; return 0; fi
  port_busy "$RPF_PORT" && die "port $RPF_PORT is already in use by another process (set PORT in .env)"
  local user="$DB_USER" pass="$DB_PASSWORD"
  [[ "$RPF_LEAST_PRIVILEGE" == 1 ]] && { user="rpf_app"; pass="$RPF_APP_PASSWORD"; }
  step "Starting RPF (API + dashboard) on :$RPF_PORT  [database role: $user]"
  spawn rpf "$ROOT" -- \
    DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_NAME="$DB_NAME" DB_USER="$user" DB_PASSWORD="$pass" \
    PORT="$RPF_PORT" PORT_AUTO=0 CMS_HOST="$CFG_LOOPBACK_HOST" CMS_PORT="$CMS_PORT" MEDIA_ROOT="$MEDIA_DIR" node src/server.js
  wait_http rpf "http://$CFG_LOOPBACK_HOST:$RPF_PORT/health" || return 1
}

start_sim() {
  if running sim; then say "    M-NVR simulator already running"; return 0; fi
  command -v ffmpeg >/dev/null 2>&1 || warn "ffmpeg not found: the simulated trains cannot produce footage (install ffmpeg)"
  step "Starting the M-NVR simulator (3 trains: heartbeat, GPS, alerts, footage upload on command)"
  spawn sim "$CMS_DIR" -- CMS_URL="http://$CFG_LOOPBACK_HOST:$CMS_PORT" CODEC="${SIM_CODEC:-h264}" node scripts/mnvr_sim.js run --units "$CFG_SIM_UNITS" --alerts "${SIM_ALERT_EVERY:-90}"
  sleep 1; running sim || { warn "simulator exited; see $LOGS/sim.log"; return 1; }
}

demo_alerts() {
  [[ "$(owner_val 'SELECT count(*) FROM alert')" == "0" ]] || { say "    alerts already exist; not adding demo alerts"; return 0; }
  local nvr; nvr="$(owner_val 'SELECT id FROM nvr_unit ORDER BY id LIMIT 1')"
  [[ -n "$nvr" ]] || { warn "no NVR unit found; skipping demo alerts"; return 0; }
  step "Raising demo alerts through the CMS backend"
  local body
  for body in \
    '"alert_type":"intrusion","priority":9,"lat":26.0,"lon":80.1' \
    '"alert_type":"panic_button","priority":8,"lat":26.2,"lon":81.5' \
    '"alert_type":"tamper","priority":7,"lat":26.0,"lon":80.1' \
    '"alert_type":"loitering","priority":3,"lat":26.0,"lon":80.1'; do
    curl -fsS -m 10 -X POST "http://$CFG_LOOPBACK_HOST:$CMS_PORT/api/alerts" -H 'Content-Type: application/json' \
      -d "{\"nvr_id\":$nvr,$body}" >/dev/null && say "    raised: ${body%%,*}" || warn "could not raise alert: $body"
  done
}

stop_one() {
  local name="$1" f pid i; f="$(pidfile "$name")"
  [[ -f "$f" ]] || return 0
  pid="$(cat "$f")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for i in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    say "    stopped $name (pid $pid)"
  fi
  rm -f "$f"
}

supervise() {
  local svcs="cms rpf"; [[ "$DEMO" == 1 ]] && svcs="cms rpf sim"
  echo $$ > "$(pidfile supervisor)"
  trap '' HUP   # closing the terminal must not take the stack down
  local tailpid=""
  shutdown_all() {
    trap - INT TERM
    say; step "Shutting down"
    [[ -n "$tailpid" ]] && kill "$tailpid" 2>/dev/null || true
    stop_one sim; stop_one rpf; stop_one cms
    rm -f "$(pidfile supervisor)"
    say "    (PostgreSQL is left running)"
    exit 0
  }
  trap shutdown_all INT TERM
  local logfiles=(); local n
  for n in $svcs; do : >> "$LOGS/$n.log"; logfiles+=("$LOGS/$n.log"); done
  tail -n 0 -F "${logfiles[@]}" 2>/dev/null & tailpid=$!
  step "Running in the foreground: services are watched and restarted if they crash. Ctrl-C stops everything."
  local svc now
  while true; do
    sleep 3 & wait $! || true   # waiting on a child lets Ctrl-C / SIGTERM act immediately
    for svc in $svcs; do
      running "$svc" && continue
      warn "$svc is not running; restarting it"
      tail -n 5 "$LOGS/$svc.log" 2>/dev/null | sed 's/^/    last log: /' >&2 || true
      now="$(date +%s)"
      local cv="cnt_$svc" tv="ts_$svc"
      if (( now - ${!tv:-0} > 60 )); then printf -v "$cv" '%d' 0; fi
      printf -v "$cv" '%d' $(( ${!cv:-0} + 1 )); printf -v "$tv" '%d' "$now"
      if (( ${!cv} >= 5 )); then warn "$svc keeps crashing; pausing 30s before the next attempt (see $LOGS/$svc.log)"; sleep 30; fi
      ( "start_$svc" ) || warn "could not restart $svc; will retry"
    done
  done
}

health() { curl -fsS -m 2 "$1" >/dev/null 2>&1 && echo "${C_GRN}answering${C_OFF}" || echo "${C_RED}not answering${C_OFF}"; }
show_status() {
  printf '%-12s %s\n' "PostgreSQL" "$(pg_up && echo "${C_GRN}up${C_OFF} ($DB_HOST:$DB_PORT)" || echo "${C_RED}down${C_OFF}")"
  local n label url
  if running supervisor; then printf '%-12s %s pid %s (restarts crashed services)\n' "Supervisor" "${C_GRN}running${C_OFF}" "$(cat "$(pidfile supervisor)")"
  else printf '%-12s %s\n' "Supervisor" "${C_DIM}not running${C_OFF} (services run detached; 'run' adds auto-restart)"; fi
  for n in cms rpf sim; do
    case "$n" in cms) label="CMS backend"; url="http://$CFG_LOOPBACK_HOST:$CMS_PORT/health" ;;
                 rpf) label="RPF + UI";    url="http://$CFG_LOOPBACK_HOST:$RPF_PORT/health" ;;
                 sim) label="M-NVR simulator"; url="" ;; esac
    if running "$n"; then printf '%-12s %s pid %s' "$label" "${C_GRN}running${C_OFF}" "$(cat "$(pidfile "$n")")"; [[ -n "$url" ]] && printf ' - %s' "$(health "$url")"; printf '\n'
    else printf '%-12s %s\n' "$label" "${C_DIM}stopped${C_OFF}"; fi
  done
}

# ---------- commands ---------------------------------------------------------------
ensure_rpf_deps() {
  [[ -d "$ROOT/node_modules/pg" ]] || { step "Installing RPF dependencies"; (cd "$ROOT" && npm install --omit=dev --no-audit --no-fund --silent); }
}

# The ports are never changed automatically ("the next free one" made CMS/RPF wander from port to port).
#  * a leftover copy of THIS project holding the port (an old CMS/RPF that was not stopped) is stopped, then the port is used;
#  * a service of ours that is running but not on its configured port is restarted;
#  * any other program on the port: nothing starts, and the message names it.
port_holders() { # pids LISTENing on TCP port $1: ss, lsof and /proc together (any one of them may be missing or lack permission)
  local port="$1" hex inode pid
  {
    command -v ss >/dev/null 2>&1 && ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2
    command -v lsof >/dev/null 2>&1 && lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null
    hex="$(printf '%04X' "$port")"
    for inode in $(awk -v h=":$hex" '$4 == "0A" && substr($2, length($2) - 4) == h { print $10 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null); do
      for pid in /proc/[0-9]*; do ls -l "$pid/fd" 2>/dev/null | grep -q "socket:\[$inode\]" && echo "${pid#/proc/}"; done
    done
  } | sort -u
}
holder_text() { local pid out=""; for pid in $(port_holders "$1"); do out="$out pid $pid ($(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-100));"; done; echo "${out:- a process that could not be identified}"; }
ours() { # is process $1 part of this project?
  local pid="$1" cwd cmd root cms; root="$(cd "$ROOT" && pwd)"; cms="$(cd "$CMS_DIR" 2>/dev/null && pwd)"
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"; cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)"
  [[ -n "$cwd$cmd" ]] || return 1
  [[ "$cwd" == "$root"* || "$cmd" == *"$root"* || ( -n "$cms" && ( "$cwd" == "$cms"* || "$cmd" == *"$cms"* ) ) ]]
}
claim_port() { # claim_port PORT NAME CONFIG_KEY
  local port="$1" name="$2" key="$3" pid i
  if running "$4"; then
    port_busy "$port" && return 0
    warn "$name is running but not on its configured port $port - restarting it"; stop_one "$4"
  fi
  port_busy "$port" || return 0
  for pid in $(port_holders "$port"); do
    if ours "$pid"; then warn "port $port is held by an old copy of this project (pid $pid) - stopping it"; kill "$pid" 2>/dev/null; fi
  done
  for i in $(seq 1 20); do port_busy "$port" || return 0; sleep 0.5; done
  for pid in $(port_holders "$port"); do ours "$pid" && kill -9 "$pid" 2>/dev/null; done; sleep 1
  port_busy "$port" || return 0
  die "port $port ($key in $CFG) is used by another program:$(holder_text "$port") Stop that program - the port is fixed and is not changed automatically."
}
check_ports_free() {
  [[ "$RPF_PORT" != "$CMS_PORT" ]] || die "RPF_PORT and CMS_PORT are both $RPF_PORT in $CFG; they must differ"
  claim_port "$CMS_PORT" "CMS backend" CMS_PORT cms
  claim_port "$RPF_PORT" "RPF" RPF_PORT rpf
}

print_logins() {
  local rows
  rows="$(psql_owner -tA -F'|' -c "SELECT u.username, u.role, COALESCE(p.name, z.name || ' (all posts)', 'all zones')
      FROM users u LEFT JOIN rpf_post p ON p.id = u.post_id LEFT JOIN zone z ON z.id = u.zone_id
     WHERE u.role = 'post_user' AND u.status = 'active'
     ORDER BY u.username" 2>/dev/null || true)"
  say
  say "  Officer logins for this dashboard's post:"
  if [[ -n "$rows" ]]; then
    local user role scope
    while IFS='|' read -r user role scope; do printf '    %-18s %-11s %s\n' "$user" "$role" "$scope"; done <<< "$rows"
  else
    say "    (none yet - open the dashboard in a browser and fill in the Thana / Post registration form)"
  fi
  say "  Passwords are stored hashed, so they cannot be displayed."
  if [[ "$DEMO" == 1 ]]; then say "  Accounts created by --demo use the password: ${DEMO_PASSWORD:-rpf-demo-123}  (accounts that already existed keep their old one)"; fi
  say "  Set or reset one :  bash scripts/start.sh users password <username>"
  say "  Add an officer   :  bash scripts/start.sh users add <username>     (for this dashboard's post)"
  say
}

do_start() {
  preflight
  check_ports_free
  ensure_rpf_deps
  [[ "$NO_DB" == 1 ]] || ensure_database
  say; step "Services"
  start_cms
  [[ "$DEMO" == 1 ]] && demo_alerts
  start_rpf
  [[ "$DEMO" == 1 ]] && start_sim
  say
  say "${C_GRN}Everything is up.${C_OFF}"
  say "  RPF dashboard : http://$CFG_LOOPBACK_HOST:$RPF_PORT"
  say "  CMS console   : http://$CFG_LOOPBACK_HOST:$CMS_PORT/console/   (demo logins: cms-operator / cms-zone1-admin / cms-super, password cms-demo-123)"
  say "  CMS API   : http://$CFG_LOOPBACK_HOST:$CMS_PORT   (health: /health)"
  say "  Logs      : $LOGS/{cms,rpf,sim}.log   (bash scripts/start.sh logs)"
  print_logins
  say "  Stop      : bash scripts/start.sh stop"
}

case "$CMD" in
  start)    load_settings; do_start ;;
  stop)     load_settings; step "Stopping"; stop_one supervisor; stop_one sim; stop_one rpf; stop_one cms; say "    (PostgreSQL is left running)" ;;
  restart)  load_settings; step "Stopping"; stop_one supervisor; stop_one sim; stop_one rpf; stop_one cms; do_start ;;
  run)      load_settings
            running supervisor && die "already running in the foreground elsewhere (pid $(cat "$(pidfile supervisor)")). Use: bash scripts/start.sh stop"
            do_start; supervise ;;
  users)    load_settings; preflight; ensure_rpf_deps; ensure_postgres_running >/dev/null
            exec node "$ROOT/scripts/manage_users.js" "${USER_ARGS[@]:-list}" ;;
  service-file)
            esc() { printf '%s' "$1" | sed 's/%/%%/g; s/"/\\"/g'; }
            cat <<UNIT
[Unit]
Description=RPF dashboard stack (PostgreSQL -> CMS backend -> RPF server)
After=network-online.target postgresql.service
Wants=network-online.target postgresql.service

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$(printf '%s' "$ROOT" | sed 's/%/%%/g')
ExecStart=/bin/bash "$(esc "$SELF")" run$([[ "$DEMO" == 1 ]] && echo ' --demo')
ExecStop=/bin/bash "$(esc "$SELF")" stop
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT
            ;;
  status)   load_settings; show_status ;;
  setup-db) load_settings; preflight; ensure_rpf_deps; ensure_database; say; say "${C_GRN}Database ready.${C_OFF}" ;;
  check)    load_settings; preflight; ensure_rpf_deps; ensure_postgres_running; node "$ROOT/scripts/check_db.js" ;;
  logs)
    case "$LOG_TARGET" in all) files=("$LOGS"/cms.log "$LOGS"/rpf.log "$LOGS"/sim.log) ;; *) files=("$LOGS/$LOG_TARGET.log") ;; esac
    for f in "${files[@]}"; do [[ -f "$f" ]] || : >> "$f"; done
    exec tail -n 40 -F "${files[@]}" ;;
  *) die "unknown command: $CMD (try: bash scripts/start.sh help)" ;;
esac

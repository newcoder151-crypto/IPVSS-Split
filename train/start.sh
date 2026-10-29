#!/usr/bin/env bash
# =============================================================================
# TRAIN PC:   M-NVR  +  bridge      (the control room - CMS + RPF - runs on ANOTHER PC: see ../control-room/start.sh)
#
#   bash start.sh --cms <control-room-ip>[:port]     FIRST TIME: say where the control room is (remembered afterwards)
#   bash start.sh                  start M-NVR + bridge (first run also sets up the M-NVR database)
#   bash start.sh choose-ip        choose which of this PC's addresses is shown/used (asked on first start; or  --ip <address>)
#   bash start.sh stop | restart | status | logs [mnvr|bridge]
#   bash start.sh check-cms        test the link to the control room (HTTP + database), nothing is started or changed
#   bash start.sh reset-passwords  set every M-NVR account to Admin@123
#
# Optional (only if they differ from the defaults):  --cms-db-password <pw>   --cms-db-user <user>   --cms-db-name <db>
# The bridge talks to the control room exactly as it always did:
#   HTTP        http://<control-room>:7080/nvr/v1     heartbeat, GPS, alerts, footage upload
#   PostgreSQL  <control-room>:5432 (database "cms")   its self-registration rows only
# Before the first start, on the control-room PC run once:   bash start.sh allow-train <this-pc-ip>
# Needs: Linux with Node 18+, PostgreSQL 15+ (local, for the M-NVR), ffmpeg, psql, curl, python3 (installed for you if sudo allows).
# =============================================================================
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MNVR="$ROOT/mnvr"; BR="$ROOT/bridge"
LOGS="$ROOT/logs"; mkdir -p "$LOGS" "$ROOT/data"
say(){ printf '\033[32m==>\033[0m %s\n' "$*"; }; warn(){ printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }; die(){ printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
envget(){ [[ -f "$1" ]] && grep -E "^$2=" "$1" | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
wait_url(){ for _ in $(seq 1 "${3:-90}"); do curl -fs -m 2 -o /dev/null "$1" && return 0; sleep 1; done; return 1; }

# ---- where the control room is (kept in data/train.conf; command-line flags and environment override and update it) ------------
CONF="$ROOT/data/train.conf"
conf_get(){ [[ -f "$CONF" ]] && grep -E "^$1=" "$CONF" | tail -n1 | cut -d= -f2-; }
conf_set(){ local k="$1" v="$2" tmp; touch "$CONF"; chmod 600 "$CONF" 2>/dev/null; tmp="$(grep -vE "^$k=" "$CONF")"; { [[ -n "$tmp" ]] && printf '%s\n' "$tmp"; printf '%s=%s\n' "$k" "$v"; } > "$CONF"; }

CMD="start"; ARG=""
while [[ $# -gt 0 ]]; do case "$1" in
  start|stop|status|logs|restart|reset-passwords|check-cms|choose-ip) CMD="$1";;
  --cms)             shift; v="${1:-}"; [[ -n "$v" ]] || die "--cms needs the control-room address, e.g.  --cms 172.210.140.20"
                     v="${v#http://}"; v="${v%%/*}"
                     if [[ "$v" == *:* && "$v" != *:*:* ]]; then conf_set CMS_HOST "${v%%:*}"; conf_set CMS_PORT "${v##*:}"; else conf_set CMS_HOST "$v"; fi;;
  --ip)              shift; [[ -n "${1:-}" ]] && echo "$1" > "$ROOT/data/host-ip";;
  --cms-db-password) shift; conf_set CMS_DB_PASSWORD "${1:-}";;
  --cms-db-user)     shift; conf_set CMS_DB_USER "${1:-}";;
  --cms-db-name)     shift; conf_set CMS_DB_NAME "${1:-}";;
  *) ARG="$1";;
esac; shift; done

CMS_HOST="${CMS_HOST:-$(conf_get CMS_HOST)}"
CMS_PORT="${CMS_PORT:-$(conf_get CMS_PORT)}";                 CMS_PORT="${CMS_PORT:-7080}"
CMS_DB_USER="${CMS_DB_USER:-$(conf_get CMS_DB_USER)}";        CMS_DB_USER="${CMS_DB_USER:-cms}"
CMS_DB_NAME="${CMS_DB_NAME:-$(conf_get CMS_DB_NAME)}";        CMS_DB_NAME="${CMS_DB_NAME:-cms}"
CMS_DB_PW="${CMS_DB_PASSWORD:-$(conf_get CMS_DB_PASSWORD)}";  CMS_DB_PW="${CMS_DB_PW:-cms}"
CMS_DB_PORT="${CMS_DB_PORT:-5432}"
need_cms(){ [[ -n "$CMS_HOST" ]] || die "where is the control room?  run once:   bash start.sh --cms <control-room-ip>      (e.g. 192.168.1.20; use 'localhost' only if CMS runs on this very PC)"; }

# ---- this PC's address, as shown in the messages and shown in the messages ------------------------------------------------
# Order: --ip <address> (saved in data/host-ip) or HOST_IP; else the address in 172.210.140.x; else any address that is not 192.168.x /
# docker / loopback; else the first one. (A PC with several network cards no longer prints the wrong one.)
my_ip() {
  local f="$ROOT/data/host-ip" ip ips; ips="$(hostname -I 2>/dev/null)"
  [[ -n "${HOST_IP:-}" ]] && { echo "$HOST_IP"; return; }
  [[ -s "$f" ]] && { head -n1 "$f"; return; }
  for ip in $ips; do [[ "$ip" == 172.210.140.* ]] && { echo "$ip"; return; }; done
  for ip in $ips; do case "$ip" in 192.168.*|172.17.*|172.18.*|127.*|169.254.*|*:*) ;; *.*.*.*) echo "$ip"; return;; esac; done
  echo "${ips%% *}"
}

# interactive: choose which of this PC's addresses the other PC should use to reach it (kept in data/host-ip)
pick_ip() {
  local f="$ROOT/data/host-ip" list=() ip n choice def
  for ip in $(hostname -I 2>/dev/null); do [[ "$ip" == *.*.*.* && "$ip" != 127.* && "$ip" != 169.254.* ]] && list+=("$ip"); done
  [[ ${#list[@]} -gt 0 ]] || { warn "no network address found on this PC"; return 0; }
  def="$(my_ip)"
  echo "  This PC's network addresses:"
  n=0; for ip in "${list[@]}"; do n=$((n+1)); echo "    $n) $ip$([[ "$ip" == "$def" ]] && echo '    <- current')"; done
  echo "    t) type another address"
  read -r -p "  Which address should the other PC use to reach this one? [Enter = $def] " choice
  case "$choice" in "") ip="$def";; t|T) read -r -p "  address: " ip;; *[!0-9]*) ip="$choice";; *) ip="${list[$((choice-1))]:-$def}";; esac
  [[ -n "$ip" ]] && { echo "$ip" > "$f"; say "using $ip   (change any time:  bash start.sh choose-ip)"; }
  return 0
}

# ---- every M-NVR account -> Admin@123 -------------------------------------------------------------------------------------------
DEFAULT_PW="Admin@123"
do_reset_passwords() {
  local ok=1
  say "setting every M-NVR account to $DEFAULT_PW"
  # M-NVR (the analytics worker's service account is left alone)
  ( cd "$MNVR/backend/api" && node scripts/reset_password.js --all "$DEFAULT_PW" ) || ok=0
  if [[ $ok == 1 ]]; then touch "$ROOT/data/.passwords-reset"; say "done - every M-NVR login is now $DEFAULT_PW (change it afterwards under Account / Password)"; else warn "some accounts could not be updated - run again once the M-NVR is up:  bash start.sh reset-passwords"; fi
  return 0
}


# ---- system tools -------------------------------------------------------------------------------------------------------
SUDO=""; [[ $EUID -ne 0 ]] && command -v sudo >/dev/null && sudo -n true 2>/dev/null && SUDO="sudo"
ensure_system() {
  local missing=() c
  for c in node npm psql curl ffmpeg python3; do command -v "$c" >/dev/null || missing+=("$c"); done
  [[ ${#missing[@]} -eq 0 ]] && return 0
  local pk=(); for c in "${missing[@]}"; do case "$c" in node|npm) pk+=(nodejs npm);; psql) pk+=(postgresql-client);; python3) pk+=(python3 python3-pip python3-venv);; *) pk+=("$c");; esac; done
  if command -v apt-get >/dev/null && { [[ $EUID -eq 0 ]] || [[ -n "$SUDO" ]]; }; then
    say "installing missing tools: ${missing[*]}"; $SUDO apt-get update -qq >/dev/null 2>&1; $SUDO apt-get install -y -qq "${pk[@]}" >/dev/null 2>&1 || true
  fi
  for c in "${missing[@]}"; do command -v "$c" >/dev/null || die "$c is not installed. Run:  sudo apt install -y ${pk[*]}   (then run start.sh again)"; done
}
ensure_postgres() {
  if command -v pg_isready >/dev/null && pg_isready -q -h localhost 2>/dev/null; then return 0; fi
  say "starting PostgreSQL"
  { $SUDO systemctl start postgresql || $SUDO service postgresql start; } >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8; do pg_isready -q -h localhost 2>/dev/null && return 0; sleep 1; done
  warn "PostgreSQL is not answering on localhost:5432 - install/start it (sudo apt install postgresql postgis) and run start.sh again"
}

# ---- npm packages: install whatever is missing (the individual launchers only install when node_modules is absent) -------
ensure_npm() {
  local d="$1"; [[ -f "$d/package.json" ]] || return 0
  if [[ ! -d "$d/node_modules" ]] || ! (cd "$d" && npm ls --depth=0 >/dev/null 2>&1); then
    say "installing packages: ${d#$ROOT/}"
    (cd "$d" && npm install --no-audit --no-fund --silent) >> "$LOGS/npm-install.log" 2>&1 || { tail -n 15 "$LOGS/npm-install.log" >&2; die "npm install failed in ${d#$ROOT/}"; }
  fi
}


# ---- files left over from older versions of the M-NVR (they would confuse or break the current one) ------------------------------
remove_obsolete() {
  local f
  for f in mnvr/backend/api/src/services/recovery.js mnvr/frontend/src/components/RecoveryCodeBox.tsx \
           mnvr/backend/api/src/services/mailer.js mnvr/backend/api/src/services/resetTokens.js mnvr/frontend/src/pages/ResetPassword.tsx \
           mail.env mail.env.example data/emails.json; do
    [[ -e "$ROOT/$f" ]] && rm -f "$ROOT/$f" && say "removed old file $f"
  done
  return 0
}

setkv(){ local f="$1" k="$2" v="$3"; [[ -f "$f" ]] || return 0; if grep -qE "^$k=" "$f"; then sed -i "s|^$k=.*|$k=$v|" "$f"; else printf '\n%s=%s\n' "$k" "$v" >> "$f"; fi; }
# run one SQL statement as the LOCAL PostgreSQL superuser (for the M-NVR database). Runs in the foreground, so sudo can ask for your password here.
pg_su(){
  local sql="$1" sp su
  if [[ $EUID -eq 0 ]]; then ( cd /tmp && runuser -u postgres -- psql -qtAc "$sql" ) 2>/dev/null && return 0
  elif command -v sudo >/dev/null; then ( cd /tmp && sudo -u postgres psql -qtAc "$sql" ) 2>/dev/null && return 0; fi
  sp="${PG_SUPERUSER_PASSWORD:-}"; su="${PG_SUPERUSER:-postgres}"
  [[ -n "$sp" ]] && PGPASSWORD="$sp" psql -h localhost -U "$su" -d postgres -qtAc "$sql" 2>/dev/null
}

# M-NVR database (role + database "mnvr", password "mnvr"): created HERE in the foreground, because the M-NVR launcher runs in the
# background where sudo cannot ask for a password (that was why the first-run setup silently did nothing)
ensure_mnvr_db(){
  local pw="$1"
  PGPASSWORD="$pw" psql -h localhost -U mnvr -d mnvr -tAc 'select 1' >/dev/null 2>&1 && return 0
  say "preparing the M-NVR database (sudo may ask for your password)"
  pg_su "CREATE ROLE mnvr LOGIN PASSWORD '$pw'" >/dev/null || true
  pg_su "ALTER ROLE mnvr WITH LOGIN PASSWORD '$pw'" >/dev/null || true
  pg_su "CREATE DATABASE mnvr OWNER mnvr" >/dev/null || true
  pg_su "GRANT ALL PRIVILEGES ON DATABASE mnvr TO mnvr" >/dev/null || true
  PGPASSWORD="$pw" psql -h localhost -U mnvr -d mnvr -tAc 'select 1' >/dev/null 2>&1 \
    || warn "could not create/open the M-NVR database - run: sudo -u postgres psql -c \"CREATE ROLE mnvr LOGIN PASSWORD '$pw'\" -c \"CREATE DATABASE mnvr OWNER mnvr\""
}


# Old copies of the bridge / M-NVR API left running from ANOTHER folder (an earlier install) would run next to the new ones on the same
# databases: they are stopped here. (CMS / RPF are never touched: they are not part of this PC.)
retire_foreign_services() {
  local pid cwd
  for pid in $(pgrep -f "node src/(server|index)\.js" 2>/dev/null); do
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"; [[ -n "$cwd" ]] || continue
    case "$cwd" in "$ROOT"/*) continue;; esac
    case "$cwd" in */bridge|*/mnvr/backend/api) ;; *) continue;; esac
    warn "an old copy is running from $cwd (pid $pid) - stopping it"
    kill "$pid" 2>/dev/null; sleep 0.5; kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  done
  return 0
}

# ---- the link to the control room: the CMS over HTTP, and its database for the bridge's self-registration --------------------------
CMS_URL_BASE() { echo "http://$CMS_HOST:$CMS_PORT"; }
do_check_cms() {
  need_cms
  local ok=1 me out; me="$(my_ip)"
  if out="$(curl -sS -m 6 -o /dev/null "$(CMS_URL_BASE)/health" 2>&1)"; then say "CMS answers at $(CMS_URL_BASE)"
  else warn "CMS does NOT answer at $(CMS_URL_BASE)/health  ($out)"
       echo "     -> on the control-room PC: is it running?  (bash start.sh status)   is TCP $CMS_PORT open in its firewall?  (sudo ufw allow $CMS_PORT/tcp)   is $CMS_HOST its real address?  (hostname -I)"; ok=0; fi
  if out="$(PGPASSWORD="$CMS_DB_PW" PGCONNECT_TIMEOUT=6 psql -h "$CMS_HOST" -p "$CMS_DB_PORT" -U "$CMS_DB_USER" -d "$CMS_DB_NAME" -tAc 'select 1' 2>&1 >/dev/null)"; then say "CMS database reachable ($CMS_DB_USER@$CMS_HOST/$CMS_DB_NAME)"
  else warn "CMS database NOT reachable:  $(echo "$out" | head -n2 | tr '\n' ' ')"
       case "$out" in
         *"no pg_hba.conf entry"*) echo "     -> the control room does not allow this PC yet. On the control-room PC run:   bash start.sh allow-train      (it asks: this PC's IP, or the whole network)";;
         *"password authentication failed"*) echo "     -> wrong database password: run here   bash start.sh --cms-db-password '<password>'   (default is cms)";;
         *"timed out"*|*"Connection refused"*|*"No route"*|*"could not connect"*) echo "     -> cannot connect: on the control-room PC run   bash start.sh allow-train   (makes PostgreSQL listen on the network), then open TCP $CMS_DB_PORT in its firewall (sudo ufw allow $CMS_DB_PORT/tcp)";;
       esac; ok=0; fi
  [[ $ok == 1 ]]
}

# after starting: wait until the bridge really is connected, otherwise say WHY (its own health page knows the reason)
wait_link() {
  local i j; for i in $(seq 1 20); do
    j="$(curl -s -m 3 http://127.0.0.1:8095/health 2>/dev/null)"
    if echo "$j" | grep -q '"online": true'; then say "bridge is connected to the control room ($CMS_HOST)"; return 0; fi
    sleep 2
  done
  warn "the bridge is running but NOT connected to the control room yet."
  echo "     bridge says: $(echo "$j" | tr -d '\n' | sed -n 's/.*"stage": *"\([^"]*\)".*"error": *"\([^"]*\)".*/\1 - \2/p')"
  do_check_cms || true
  echo "     (the bridge keeps retrying by itself - once the cause above is fixed it connects without a restart; look:  curl http://127.0.0.1:8095/health)"
  return 1
}

do_stop() {
  say "stopping bridge";  bash "$BR/scripts/start.sh" stop 2>/dev/null || true
  say "stopping M-NVR";   (cd "$MNVR" && bash scripts/start.sh --stop >/dev/null 2>&1) || true
}

do_start() {
  need_cms
  [[ -t 0 && ! -s "$ROOT/data/host-ip" ]] && pick_ip   # first start: you choose this PC's address
  ensure_system
  ensure_postgres
  remove_obsolete
  for d in "$MNVR/backend/api" "$BR"; do ensure_npm "$d"; done   # (the M-NVR frontend installs itself)
  retire_foreign_services

  # control room reachable? (never blocks: a train may boot before it has coverage - the bridge keeps trying)
  do_check_cms || warn "continuing - the bridge keeps retrying until the control room is reachable"

  # 2. the train: M-NVR (first run creates its database)
  local MP; MP="$(envget "$MNVR/backend/api/.env" DB_PASSWORD)"; MP="${MP:-mnvr}"
  local MPORT; MPORT="$(envget "$MNVR/backend/api/.env" PORT)"; MPORT="${MPORT:-3001}"
  ensure_mnvr_db "$MP"
  local setup=""
  [[ -n "$(PGPASSWORD="$MP" psql -h localhost -U mnvr -d mnvr -tAc "select to_regclass('public.users')" 2>/dev/null)" ]] || setup="--setup-db"
  say "starting M-NVR ${setup:+(first run: database setup)}"
  (cd "$MNVR" && setsid nohup bash scripts/start.sh $setup > "$LOGS/mnvr.log" 2>&1 < /dev/null &)
  if wait_url "http://localhost:$MPORT/api/health" 240; then
    wait_url "http://localhost:8080" 90 || warn "M-NVR web page (:8080) is still starting - see logs/mnvr.log"
    MNVR_UP=1
  else
    MNVR_UP=0
    warn "M-NVR API is NOT answering on :$MPORT - last lines of logs/mnvr.log:"; tail -n 25 "$LOGS/mnvr.log" >&2
    warn "continuing - the bridge waits for it. Details:  bash start.sh logs mnvr"
  fi


  # 3. the bridge: settings are derived from the M-NVR and the control-room address, nothing else to fill in
  if [[ ! -f "$BR/.env" || -f "$BR/.env.generated" ]]; then
    say "configuring the bridge (control room: $CMS_HOST)"
    {
      echo "CMS_URL=$(CMS_URL_BASE)"
      echo "MNVR_DB_HOST=localhost"; echo "MNVR_DB_NAME=mnvr"; echo "MNVR_DB_USER=mnvr"; echo "MNVR_DB_PASSWORD=$MP"
      echo "CMS_DB_HOST=$CMS_HOST"; echo "CMS_DB_PORT=$CMS_DB_PORT"; echo "CMS_DB_NAME=$CMS_DB_NAME"
      echo "CMS_DB_USER=$CMS_DB_USER"; echo "CMS_DB_PASSWORD=$CMS_DB_PW"
      echo "RECORDINGS_DIR=$(envget "$MNVR/backend/api/.env" RECORDINGS_PATH)"
    } > "$BR/.env"; chmod 600 "$BR/.env" 2>/dev/null; touch "$BR/.env.generated"
  fi
  say "starting the bridge"
  bash "$BR/scripts/start.sh" start || die "bridge did not start"
  wait_link || true

  [[ -f "$ROOT/data/.passwords-reset" ]] || do_reset_passwords   # once: every M-NVR account -> Admin@123

  local me; me="$(my_ip)"; me="${me:-localhost}"
  [[ "${MNVR_UP:-0}" == 1 ]] && echo "" && echo "  M-NVR + bridge are running." || { echo ""; echo "  The bridge is running, but M-NVR is NOT up yet - see: bash start.sh logs mnvr"; }
  cat <<MSG
    M-NVR   http://$me:8080     admin / Admin@123  (all logins: Admin@123)
    Bridge  http://127.0.0.1:8095/health      logs: bash start.sh logs bridge
  Control room (CMS + RPF) is on: $CMS_HOST     CMS console http://$CMS_HOST:$CMS_PORT/console/
  The first start downloads the AI packages in the background (a few GB) - M-NVR is usable meanwhile; progress: bash start.sh logs mnvr
  Stop all: bash start.sh stop
MSG
  return 0
}

[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0   # (sourced by a test: define the functions only)
case "$CMD" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status)
    (cd "$MNVR" && bash scripts/start.sh --status) 2>&1 | tail -n 12
    bash "$BR/scripts/start.sh" status ;;
  reset-passwords) do_reset_passwords ;;
  check-cms) do_check_cms ;;
  choose-ip) pick_ip ;;
  logs)
    case "$ARG" in bridge) tail -n 80 -f "$BR/logs/bridge.log";; *) tail -n 80 -f "$LOGS/mnvr.log";; esac ;;
esac

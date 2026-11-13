#!/usr/bin/env bash
# =============================================================================
# CONTROL-ROOM PC:   CMS + RPF  (with their PostgreSQL database and the footage folder)
#
#   bash start.sh                  start CMS + RPF (first run also sets up the database)
#   bash start.sh stop | restart | status | logs [cms|rpf]
#   bash start.sh allow-train      asks which train PC / network may connect to this PC's database (or:  allow-train <ip|network/bits>)
#   bash start.sh choose-ip        choose which of this PC's addresses the train uses to reach it (asked on first start)
#   bash start.sh trains           which trains have connected and when they last reported
#   bash start.sh reset-passwords  set every CMS + RPF account to Admin@123
#   bash start.sh diagnose-footage | check-footage
#   bash start.sh --demo-data      (with start) also load demo zones/posts/logins into a fresh CMS
#
# The train (M-NVR + bridge) runs on ANOTHER PC: see ../train/start.sh. The bridge talks to this PC exactly as before:
#   HTTP        http://<this-pc>:<CMS_PORT>/nvr/v1    heartbeat, GPS, alerts, footage upload   (CMS)
#   PostgreSQL  <this-pc>:<DB_PORT>              its one-time self-registration rows      (database "cms")
# Needs: Linux with Node 18+, PostgreSQL 15+ with PostGIS, ffmpeg, psql, curl (installed for you if sudo allows).
# =============================================================================
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RPFD="$ROOT/RPF_CMS/rpf"; CMSD="$ROOT/RPF_CMS/CMS"
LOGS="$ROOT/logs"; mkdir -p "$LOGS"
say(){ printf '\033[32m==>\033[0m %s\n' "$*"; }; warn(){ printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }; die(){ printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
envget(){ [[ -f "$1" ]] && grep -E "^$2=" "$1" | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
wait_url(){ for _ in $(seq 1 "${3:-90}"); do curl -fs -m 2 -o /dev/null "$1" && return 0; sleep 1; done; return 1; }

# ---- settings: hosts, ports, database names live in config/control-room.conf (nothing is hard-coded in this script) -----------
CFG="${IPVSS_CONFIG:-$ROOT/config/control-room.conf}"
[[ -r "$CFG" ]] || die "config file not found: $CFG   (it holds this PC's ports and hosts; restore it from the project, or point IPVSS_CONFIG at yours)"
cfg(){ grep -E "^$1=" "$CFG" | tail -n1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
cfg_need(){ local v="${!1:-}"; [[ -n "$v" ]] || v="$(cfg "$1")"; [[ -n "$v" ]] || die "$1 is not set in $CFG"; printf '%s' "$v"; }
CFG_LOOPBACK_HOST="$(cfg_need LOOPBACK_HOST)"; CFG_DB_HOST="$(cfg_need DB_HOST)"; CFG_DB_PORT="$(cfg_need DB_PORT)"
CFG_DB_NAME="$(cfg_need DB_NAME)"; CFG_DB_USER="$(cfg_need DB_USER)"; CFG_DB_ADMIN_USER="$(cfg_need DB_ADMIN_USER)"
CFG_CMS_PORT="$(cfg_need CMS_PORT)"; CFG_RPF_PORT="$(cfg_need RPF_PORT)"; CFG_LOCAL_HOSTS="$(cfg_need LOCAL_HOST_NAMES)"
CFG_PREFERRED_PREFIX="${PREFERRED_NETWORK_PREFIX:-$(cfg PREFERRED_NETWORK_PREFIX)}"; CFG_SKIP_PREFIXES="${SKIP_NETWORK_PREFIXES:-$(cfg SKIP_NETWORK_PREFIXES)}"


# ---- this PC's address, as shown in the messages and shown in the messages ------------------------------------------------
# Order: --ip <address> (saved in data/host-ip) or HOST_IP; else an address starting with PREFERRED_NETWORK_PREFIX (config/control-room.conf); else any address not starting with SKIP_NETWORK_PREFIXES /
# docker / loopback; else the first one. (A PC with several network cards no longer prints the wrong one.)
my_ip() {
  local f="$ROOT/data/host-ip" ip ips p skip; ips="$(hostname -I 2>/dev/null)"
  [[ -n "${HOST_IP:-}" ]] && { echo "$HOST_IP"; return; }
  [[ -s "$f" ]] && { head -n1 "$f"; return; }
  if [[ -n "$CFG_PREFERRED_PREFIX" ]]; then for ip in $ips; do [[ "$ip" == "$CFG_PREFERRED_PREFIX"* ]] && { echo "$ip"; return; }; done; fi
  for ip in $ips; do
    [[ "$ip" == *:* || "$ip" != *.*.*.* ]] && continue
    skip=0; for p in $CFG_SKIP_PREFIXES; do [[ "$ip" == "$p"* ]] && skip=1; done
    [[ $skip -eq 0 ]] && { echo "$ip"; return; }
  done
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

# ---- every CMS + RPF account -> Admin@123 -------------------------------------------------------------------------------------
DEFAULT_PW="Admin@123"
do_reset_passwords() {
  local ok=1
  say "setting every CMS + RPF account to $DEFAULT_PW"
  # CMS + RPF share one users table
  ( cd "$RPFD" && node -e "
      const bcrypt = require('bcryptjs'); const { pool } = require('./src/db');
      (async () => { const h = await bcrypt.hash(process.argv[1], 10);
        const r = await pool.query(\"UPDATE users SET password_hash = \$1 WHERE username <> 'system'\", [h]);
        console.log('  CMS + RPF accounts updated: ' + r.rowCount); await pool.end(); })().catch((e) => { console.error('  CMS/RPF: ' + e.message); process.exit(1); })" "$DEFAULT_PW" ) || ok=0
  if [[ $ok == 1 ]]; then touch "$ROOT/data/.passwords-reset"; say "done - every CMS / RPF login is now $DEFAULT_PW (change it afterwards under Account / Password)"; else warn "some accounts could not be updated - run again once the apps are up:  bash start.sh reset-passwords"; fi
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
  if command -v pg_isready >/dev/null && pg_isready -q -h "$CFG_DB_HOST" -p "$CFG_DB_PORT" 2>/dev/null; then return 0; fi
  say "starting PostgreSQL"
  { $SUDO systemctl start postgresql || $SUDO service postgresql start; } >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8; do pg_isready -q -h "$CFG_DB_HOST" -p "$CFG_DB_PORT" 2>/dev/null && return 0; sleep 1; done
  warn "PostgreSQL is not answering on $CFG_DB_HOST:$CFG_DB_PORT - install/start it (sudo apt install postgresql postgis) and run start.sh again"
}

# ---- npm packages: install whatever is missing (the individual launchers only install when node_modules is absent) -------
ensure_npm() {
  local d="$1"; [[ -f "$d/package.json" ]] || return 0
  if [[ ! -d "$d/node_modules" ]] || ! (cd "$d" && npm ls --depth=0 >/dev/null 2>&1); then
    say "installing packages: ${d#$ROOT/}"
    (cd "$d" && npm install --no-audit --no-fund --silent) >> "$LOGS/npm-install.log" 2>&1 || { tail -n 15 "$LOGS/npm-install.log" >&2; die "npm install failed in ${d#$ROOT/}"; }
  fi
}


# ---- files left over from older versions of CMS / RPF (they would confuse or break the current ones) ---------------------------
remove_obsolete() {
  local f
  for f in RPF_CMS/rpf/src/services/security.js RPF_CMS/rpf/src/routes/admin.js RPF_CMS/rpf/data/security.json \
           RPF_CMS/CMS/backend/src/services/recovery.js \
           RPF_CMS/rpf/src/services/emails.js RPF_CMS/rpf/src/services/mailer.js RPF_CMS/rpf/src/services/resetTokens.js \
           RPF_CMS/CMS/backend/src/services/emails.js RPF_CMS/CMS/backend/src/services/mailer.js RPF_CMS/CMS/backend/src/services/resetTokens.js \
           RPF_CMS/rpf/test/helpers/smtp-sink.js mail.env mail.env.example data/emails.json; do
    [[ -e "$ROOT/$f" ]] && rm -f "$ROOT/$f" && say "removed old file $f"
  done
  return 0
}


# ---- database passwords: CMS role = "cms" / password "cms" (kept in the .env files for good), no manual .env editing ---------
CMS_DB_PW="${CMS_DB_PASSWORD:-cms}"
setkv(){ local f="$1" k="$2" v="$3"; [[ -f "$f" ]] || return 0; if grep -qE "^$k=" "$f"; then sed -i "s|^$k=.*|$k=$v|" "$f"; else printf '\n%s=%s\n' "$k" "$v" >> "$f"; fi; }
# run one SQL statement as the PostgreSQL superuser. Runs in the foreground, so sudo can ask for your password here.
pg_su(){
  local sql="$1" sp su
  if [[ $EUID -eq 0 ]]; then ( cd /tmp && runuser -u postgres -- psql -qtAc "$sql" ) 2>/dev/null && return 0
  elif command -v sudo >/dev/null; then ( cd /tmp && sudo -u postgres psql -qtAc "$sql" ) 2>/dev/null && return 0; fi
  sp="$(envget "$RPFD/.env" PG_SUPERUSER_PASSWORD)"; su="$(envget "$RPFD/.env" PG_SUPERUSER)"
  [[ -n "$sp" ]] && PGPASSWORD="$sp" psql -h "$CFG_DB_HOST" -p "$CFG_DB_PORT" -U "${su:-$CFG_DB_ADMIN_USER}" -d postgres -qtAc "$sql" 2>/dev/null
}
fix_cms_role(){   # make .env and the PostgreSQL role agree on the password "cms"
  local u; u="$(envget "$RPFD/.env" DB_USER)"; u="${u:-cms}"
  local f; for f in "$RPFD/.env" "$CMSD/backend/.env" "$ROOT/.env"; do setkv "$f" DB_PASSWORD "$CMS_DB_PW"; done
  if [[ "$(pg_su "SELECT 1 FROM pg_roles WHERE rolname='$u'")" == "1" ]]; then
    pg_su "ALTER ROLE $u WITH LOGIN PASSWORD '$CMS_DB_PW'" >/dev/null && say "database role '$u' now uses the password from .env" \
      || warn "could not change the password of role '$u' (no sudo / postgres access) - run: sudo -u postgres psql -c \"ALTER ROLE $u PASSWORD '$CMS_DB_PW'\""
  fi
}
ensure_cms_db_password(){
  local u; u="$(envget "$RPFD/.env" DB_USER)"; u="${u:-cms}"
  local f; for f in "$RPFD/.env" "$CMSD/backend/.env" "$ROOT/.env"; do setkv "$f" DB_PASSWORD "$CMS_DB_PW"; done
  PGPASSWORD="$CMS_DB_PW" psql -h "$CFG_DB_HOST" -p "$CFG_DB_PORT" -U "$u" -d postgres -tAc 'select 1' >/dev/null 2>&1 && return 0
  fix_cms_role
}

# ---- ONE footage folder for CMS + RPF (this is what "footage file is not reachable from the RPF server" was about) ---------
# CMS writes delivered footage into its MEDIA_ROOT and RPF reads it from its own: if the two (or two start-ups) differ, the
# database says "delivered" while the file is somewhere else. Both are pinned to one absolute folder here, on every start,
# and anything already in the old per-app folders is copied over (nothing is overwritten or deleted).
MEDIA_DIR="${IPVSS_MEDIA_DIR:-$ROOT/media}"
setup_media() {
  mkdir -p "$MEDIA_DIR" || die "cannot create the footage folder $MEDIA_DIR"
  local old f
  for old in "$RPFD/media" "$CMSD/media" "$CMSD/backend/media"; do
    [[ -d "$old" && "$(cd "$old" && pwd)" != "$MEDIA_DIR" ]] && cp -an "$old"/. "$MEDIA_DIR"/ 2>/dev/null
  done
  for f in "$RPFD/.env" "$CMSD/backend/.env" "$ROOT/.env"; do setkv "$f" MEDIA_ROOT "$MEDIA_DIR"; done
  export MEDIA_ROOT="$MEDIA_DIR"      # an exported value wins over .env for every process started below, also on a first run
  fix_media_permissions
}

unwritable_in() { find "$1" \( -type d ! -writable -o -type f \( -name '*.part' -o -name '*.mp4' -o -name '*.json' \) ! -writable \) -print -quit 2>/dev/null; }
fix_dir_permissions() {   # $1 = folder, $2 = what it holds (for the messages)
  local dir="$1" what="$2" bad me; me="$(id -un)"; [[ -d "$dir" ]] || return 0
  bad="$(unwritable_in "$dir")"; [[ -z "$bad" ]] && return 0
  warn "the $what folder has items '$me' cannot write to (for example ${bad#$dir/}) - made by another user or an earlier sudo run; repairing"
  chmod -R u+rwX "$dir" 2>/dev/null; bad="$(unwritable_in "$dir")"
  if [[ -n "$bad" ]]; then
    if [[ $EUID -ne 0 ]] && command -v sudo >/dev/null; then sudo chown -R "$(id -u):$(id -g)" "$dir" && sudo chmod -R u+rwX "$dir"; fi
    bad="$(unwritable_in "$dir")"
  fi
  if [[ -z "$bad" ]]; then say "$what folder permissions repaired ($dir)"; else
    warn "still not writable: ${bad#$dir/} - $what will fail. Run once:  sudo chown -R $me $dir"; fi
}
# The CMS must be able to create files in every footage folder, and the RPF in its local-evidence folder. Folders made by an earlier run with sudo /
# another user, or copied in from an old install, are readable but not writable: train uploads / "keep a local copy" then fail with EACCES.
fix_media_permissions() {
  fix_dir_permissions "$MEDIA_DIR" "footage (train uploads)"
  local le="${LOCAL_EVIDENCE_DIR:-$ROOT/RPF_CMS/rpf/local-evidence}"; [[ "$le" = /* ]] || le="$ROOT/RPF_CMS/rpf/$le"
  fix_dir_permissions "$le" "local evidence (RPF copies kept at the post)"
}

# Old copies of CMS / RPF / bridge / M-NVR API left running from ANOTHER folder (an earlier install) keep their own footage
# folder and their own background workers on the same database: they deliver a request and store the file in THEIR folder, so
# the new copy finds a "delivered" record without a file. They are stopped here (their footage is copied over first).
retire_foreign_services() {
  local pid cwd media
  for pid in $(pgrep -f "node src/(server|index)\.js" 2>/dev/null); do
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"; [[ -n "$cwd" ]] || continue
    case "$cwd" in "$ROOT"/*) continue;; esac
    case "$cwd" in */RPF_CMS/CMS/backend|*/RPF_CMS/rpf) ;; *) continue;; esac
    media="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^MEDIA_ROOT=//p' | head -n1)"
    case "$cwd" in */RPF_CMS/CMS/backend) media="${media:-$cwd/../../media}";; */RPF_CMS/rpf) media="${media:-$cwd/media}";; esac
    if [[ -n "$media" && -d "$media" && "$(cd "$media" && pwd)" != "$MEDIA_DIR" ]]; then
      warn "an old copy is running from $cwd (pid $pid) - copying its footage into $MEDIA_DIR and stopping it"
      cp -a "$media"/. "$MEDIA_DIR"/ 2>/dev/null
    else
      warn "an old copy is running from $cwd (pid $pid) - stopping it"
    fi
    kill "$pid" 2>/dev/null; sleep 0.5; kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  done
  return 0
}
# after start-up: does the CMS that is really running store footage where RPF and this script expect it?
verify_media() {
  local cms rpf
  cms="$(curl -fs -m 3 "http://$CFG_LOOPBACK_HOST:$CMS_PORT/health" 2>/dev/null | sed -n 's/.*"media_root":"\([^"]*\)".*/\1/p')"
  rpf="$(curl -fs -m 3 "http://$CFG_LOOPBACK_HOST:$CFG_RPF_PORT/health" 2>/dev/null | sed -n 's/.*"media_root":"\([^"]*\)".*/\1/p')"
  [[ -n "$cms" && "$cms" == "$MEDIA_DIR" && "$rpf" == "$MEDIA_DIR" ]] && { say "footage folder OK: CMS and RPF both use $MEDIA_DIR"; return 0; }
  warn "footage folders differ - CMS: ${cms:-?}   RPF: ${rpf:-?}   expected: $MEDIA_DIR   (RPF follows the CMS automatically; details: bash start.sh diagnose-footage)"
}

# bash start.sh check-footage : every delivered file the database knows must be in the footage folder. A missing one is
# searched for in the project, /storage and your home folder (older folders, other start-ups) and copied into place.
do_check_footage() {
  local quiet="${1:-}" u p n bad=0 fixed=0 total=0 id path hit
  u="$(envget "$RPFD/.env" DB_USER)"; u="${u:-cms}"; n="$(envget "$RPFD/.env" DB_NAME)"; n="${n:-cms}"; p="$(envget "$RPFD/.env" DB_PASSWORD)"; p="${p:-$CMS_DB_PW}"
  [[ -z "$quiet" ]] && say "footage folder: $MEDIA_DIR"
  while IFS='|' read -r id path; do
    [[ -z "$id" || -z "$path" ]] && continue; total=$((total+1))
    [[ -f "$MEDIA_DIR/$path" ]] && continue
    hit="$(find "$ROOT" /storage "$HOME" -xdev -maxdepth 12 \( -name node_modules -o -name .git -o -name .venv -o -name .cache \) -prune -o -type f -path "*/$path" -not -path "$MEDIA_DIR/*" -print 2>/dev/null | head -n1)"
    if [[ -n "$hit" ]] && mkdir -p "$(dirname "$MEDIA_DIR/$path")" && cp "$hit" "$MEDIA_DIR/$path"; then fixed=$((fixed+1)); echo "  recovered #$id  $path   (found in $hit)"
    else bad=$((bad+1)); [[ -z "$quiet" ]] && echo "  missing:  #$id  $path"; fi
  done < <(PGPASSWORD="$p" psql -h "$CFG_DB_HOST" -p "$CFG_DB_PORT" -U "$u" -d "$n" -tA -F'|' -c "SELECT id, storage_path FROM delivered_footage ORDER BY id" 2>/dev/null)
  [[ -n "$quiet" && $bad -eq 0 && $fixed -eq 0 ]] && return 0
  [[ -n "$quiet" ]] && { echo "  footage check: $fixed file(s) recovered, $bad delivered file(s) not on this machine (list them: bash start.sh check-footage)"; return 0; }
  echo "  $total delivered file(s) in the database: $fixed recovered, $bad still missing."
  [[ $bad -gt 0 ]] && echo "  A still-missing file was never stored on this machine - run:  bash start.sh diagnose-footage   and send me the output."
  return 0
}
# bash start.sh diagnose-footage : shows where footage is written/looked up and what the upload chain logged
do_diagnose_footage() {
  local pid cwd f
  say "footage folder (shared by CMS + RPF): $MEDIA_DIR"
  for f in "$RPFD/.env" "$CMSD/backend/.env"; do echo "  ${f#$ROOT/}: MEDIA_ROOT=$(envget "$f" MEDIA_ROOT)"; done
  for pid in $(pgrep -f "node src/server.js" 2>/dev/null); do
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
    echo "  running ${cwd#$ROOT/} (pid $pid): MEDIA_ROOT=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^MEDIA_ROOT=//p')"
  done
  local cp; cp="$CFG_CMS_PORT"
  for f in "$cp" "$CFG_RPF_PORT"; do [[ -n "$f" ]] && echo "  /health on :$f -> $(curl -fs -m 3 "http://$CFG_LOOPBACK_HOST:$f/health" 2>/dev/null | cut -c1-300)"; done
  echo "  files in the footage folder:"; find "$MEDIA_DIR" -type f 2>/dev/null | head -n 20 | sed 's/^/    /'
  echo "  any req-*.mp4 elsewhere:"; find "$ROOT" /storage -xdev -maxdepth 8 \( -name node_modules -o -name .git \) -prune -o -type f -name 'req-*.mp4' -print 2>/dev/null | head -n 10 | sed 's/^/    /'
  local u p n; u="$(envget "$RPFD/.env" DB_USER)"; u="${u:-cms}"; n="$(envget "$RPFD/.env" DB_NAME)"; n="${n:-cms}"; p="$(envget "$RPFD/.env" DB_PASSWORD)"; p="${p:-$CMS_DB_PW}"
  echo "  latest delivered_footage rows:"; PGPASSWORD="$p" psql -h "$CFG_DB_HOST" -p "$CFG_DB_PORT" -U "$u" -d "$n" -x -c "SELECT * FROM delivered_footage ORDER BY id DESC LIMIT 2" 2>&1 | head -n 40 | sed 's/^/    /'
  echo "  log lines about uploads / footage / media (last 25):"
  grep -hiE "upload|footage|media|req-[0-9]+|stitch|no such file" "$LOGS"/*.log "$RPFD"/logs/*.log "$CMSD"/logs/*.log "$CMSD"/backend/logs/*.log 2>/dev/null | tail -n 25 | cut -c1-220 | sed 's/^/    /'
  return 0
}

# ---- trains are allowed IN by themselves ------------------------------------------------------------------------------------------
# The bridge of every train PC writes its registration rows (nvr_unit, camera) straight into the CMS database and sends footage/alerts over
# HTTP to the CMS port. On start this script therefore opens, for the train network(s), exactly: the CMS database (pg_hba.conf, only the CMS role
# and database; PostgreSQL listens on the network) and - when ufw is active - the database port and the CMS port. Nothing to run by hand.
#   ALLOW_TRAIN_NETWORKS in config/control-room.conf:   auto = the network of THIS PC's address (found here, from its own IP)
#                                                         10.1.2.0/24 10.1.3.0/24 = exactly these networks      none = open nothing
#   MANAGE_FIREWALL: auto = add ufw rules when ufw is active, yes/no = always/never
# "bash start.sh allow-train [<ip|network/bits>]" stays for adding one more PC or network by hand.
own_network() { # the network (address/bits) of this PC's chosen address
  local mine own=""; mine="$(my_ip)"
  own="$(ip -o -4 addr show 2>/dev/null | awk '{print $4}' | grep "^$mine/" | head -n1)"
  if [[ -n "$own" ]] && command -v python3 >/dev/null; then own="$(python3 -c 'import ipaddress,sys;print(ipaddress.ip_interface(sys.argv[1]).network)' "$own" 2>/dev/null)"; else own=""; fi
  [[ -n "$own" ]] || { [[ "$mine" == *.*.*.* ]] && own="${mine%.*}.0/24"; }
  echo "$own"
}

# allow_network <ip|address/bits> - idempotent; says nothing when everything is already in place
allow_network() {
  local ip="$1"
  [[ "$ip" =~ ^[0-9a-fA-F:.]+(/[0-9]+)?$ ]] || die "not an address or network: $ip   (usage: bash start.sh allow-train [<ip> | <network/bits>])"
  [[ "$ip" == */* ]] || { [[ "$ip" == *:* ]] && ip="$ip/128" || ip="$ip/32"; }
  local u n; u="$(envget "$RPFD/.env" DB_USER)"; u="${u:-$CFG_DB_USER}"; n="$(envget "$RPFD/.env" DB_NAME)"; n="${n:-$CFG_DB_NAME}"
  local PS=""; [[ $EUID -ne 0 ]] && PS="sudo"     # (may ask for your password here, in the foreground)
  local hba la; hba="$(pg_su "SHOW hba_file")"; la="$(pg_su "SHOW listen_addresses")"
  [[ -n "$hba" ]] || die "cannot reach PostgreSQL as its superuser (run with sudo access). Manual steps: README.md, 'Database access for the train'"
  local line="host    $n    $u    $ip    md5"       # md5 = scram-sha-256 or md5, whichever the role's password is stored as
  local changed=0 restart=0
  # 1. pg_hba.conf: one line per allowed network
  if ! $PS grep -qE "^host[[:space:]]+$n[[:space:]]+$u[[:space:]]+${ip//\//\\/}[[:space:]]" "$hba" 2>/dev/null; then
    printf '\n# IPVSS train bridge (added by start.sh)\n%s\n' "$line" | $PS tee -a "$hba" >/dev/null || die "cannot write $hba - add this line yourself:  $line"
    say "trains allowed: $ip  (added to $hba)"; changed=1
  fi
  # 2. listen on the network (needs one PostgreSQL restart, only done when really needed)
  if [[ -z "$la" ]] || { for h in $CFG_LOCAL_HOSTS; do [[ "$la" == "$h" ]] && la=""; done; [[ -z "$la" ]]; }; then
    pg_su "ALTER SYSTEM SET listen_addresses = '*'" >/dev/null || die "cannot set listen_addresses - set  listen_addresses = '*'  in postgresql.conf and restart PostgreSQL"
    restart=1
  fi
  if [[ $restart == 1 ]]; then
    say "PostgreSQL restarts once to listen on the network (CMS/RPF reconnect by themselves; if not:  bash start.sh restart)"
    { $PS systemctl restart postgresql || $PS service postgresql restart; } >/dev/null 2>&1 || warn "could not restart PostgreSQL - restart it yourself"
    for _ in 1 2 3 4 5 6 7 8 9 10; do pg_isready -q -h "$CFG_DB_HOST" -p "$CFG_DB_PORT" 2>/dev/null && break; sleep 1; done
  elif [[ $changed == 1 ]]; then
    pg_su "SELECT pg_reload_conf()" >/dev/null && say "PostgreSQL reloaded"
  fi
  # 3. the firewall (ufw), when there is one in use
  local fw="${MANAGE_FIREWALL:-$(cfg MANAGE_FIREWALL)}"; fw="${fw:-auto}"; local src="$ip"
  if [[ "$fw" != "no" ]] && command -v ufw >/dev/null 2>&1 && { [[ "$fw" == "yes" ]] || $PS ufw status 2>/dev/null | grep -q "^Status: active"; }; then
    local p; for p in "$CFG_DB_PORT" "$CFG_CMS_PORT"; do $PS ufw allow from "$src" to any port "$p" proto tcp >/dev/null 2>&1 || warn "could not add the ufw rule for $src port $p"; done
  elif [[ "$fw" != "no" ]]; then
    :   # no ufw in use: nothing to open here (another firewall, if any, must allow $CFG_DB_PORT and $CFG_CMS_PORT from the train network)
  fi
  return 0
}

# on every start: allow the configured train networks (default: this PC's own network)
auto_allow_trains() {
  local want="${ALLOW_TRAIN_NETWORKS:-$(cfg ALLOW_TRAIN_NETWORKS)}"; want="${want:-auto}"
  [[ "$want" == "none" ]] && { say "no train network is opened automatically (ALLOW_TRAIN_NETWORKS=none in $CFG)"; return 0; }
  local nets="$want" net
  if [[ "$want" == "auto" ]]; then
    nets="$(own_network)"
    [[ -n "$nets" ]] || { warn "could not work out this PC's network - trains are not opened automatically; set ALLOW_TRAIN_NETWORKS in $CFG (or run: bash start.sh allow-train <network/bits>)"; return 0; }
  fi
  for net in $nets; do ( allow_network "$net" ) || warn "could not open $net for trains"; done
  TRAIN_NETS="$nets"
}

# manual: one more PC or network
do_allow_train() {
  local ip="${1:-}"
  if [[ -z "$ip" || "$ip" == "lan" || "$ip" == "all" ]]; then
    local own; own="$(own_network)"
    if [[ -t 0 ]]; then
      echo "  Which PC(s) may connect as a train?"
      echo "    1) one train PC          (you type its IP address)"
      [[ -n "$own" ]] && echo "    2) the whole network      $own    (this PC's own network)"
      echo "    3) another network       (you type it as address/bits)"
      local c; read -r -p "  choose [1-3]: " c
      case "$c" in
        1) read -r -p "  train PC's IP address: " ip;;
        2) ip="$own";;
        3) read -r -p "  network (address/bits): " ip;;
        *) die "nothing chosen";;
      esac
    else
      ip="$own"; [[ -n "$ip" ]] || die "give the train PC's IP (or a network) explicitly:  bash start.sh allow-train <ip|network/bits>"
    fi
  fi
  allow_network "$ip"
  echo "  allowed: $ip"
  echo "  then on the train PC:   bash start.sh --cms $(my_ip)"
}

# trains that have registered at this CMS, and when each last reported (empty = no train has connected yet)
do_trains() {
  local pw; pw="$(envget "$RPFD/.env" DB_PASSWORD)"
  PGPASSWORD="$pw" psql -h "$CFG_DB_HOST" -p "$CFG_DB_PORT" -U "$(envget "$RPFD/.env" DB_USER || echo "$CFG_DB_USER")" -d "$(envget "$RPFD/.env" DB_NAME || echo "$CFG_DB_NAME")" -c \
    "select id, name, status, last_seen, now()-last_seen as ago from nvr_unit order by id" 2>&1 | head -n 20
}

mkdir -p "$ROOT/data"
_args=(); while [[ $# -gt 0 ]]; do if [[ "$1" == "--ip" ]]; then shift; [[ -n "${1:-}" ]] && echo "$1" > "$ROOT/data/host-ip"; else _args+=("$1"); fi; shift; done
set -- ${_args[@]+"${_args[@]}"}

CMD="start"; DEMO=0; ARG=""
for a in "$@"; do case "$a" in start|stop|status|logs|restart|reset-passwords|check-footage|diagnose-footage|allow-train|trains|choose-ip) CMD="$a";; --demo-data) DEMO=1;; *) ARG="$a";; esac; done

do_stop() {
  say "stopping CMS + RPF"; (cd "$RPFD" && bash scripts/start.sh stop >/dev/null 2>&1) || true
}

do_start() {
  [[ -t 0 && ! -s "$ROOT/data/host-ip" ]] && pick_ip   # first start: you choose this PC's address
  ensure_system
  ensure_postgres
  remove_obsolete
  for d in "$RPFD" "$CMSD/backend"; do ensure_npm "$d"; done


  # 1. control room: database, CMS, RPF
  # a CMS left running from an earlier start may use a different footage folder than RPF: always start both fresh,
  # so they share one MEDIA_ROOT (rpf/media)
  (cd "$RPFD" && bash scripts/start.sh stop) >/dev/null 2>&1 || true
  ensure_cms_db_password
  setup_media
  retire_foreign_services
  say "starting CMS + RPF (database, schema, migrations on first run)"
  if ! (cd "$RPFD" && bash scripts/start.sh start) > "$LOGS/cms-rpf-start.log" 2>&1; then
    if grep -q "rejects the DB_PASSWORD" "$LOGS/cms-rpf-start.log"; then   # (.env was created after the check above)
      fix_cms_role
      (cd "$RPFD" && bash scripts/start.sh start) > "$LOGS/cms-rpf-start.log" 2>&1 || { tail -n 20 "$LOGS/cms-rpf-start.log" >&2; die "CMS/RPF did not start"; }
    else
      tail -n 20 "$LOGS/cms-rpf-start.log" >&2; die "CMS/RPF did not start"
    fi
  fi
  CMS_PORT="$CFG_CMS_PORT"
  wait_url "http://$CFG_LOOPBACK_HOST:$CMS_PORT/health" 60 || die "CMS does not answer on :$CMS_PORT (see logs/cms-rpf-start.log)"
  verify_media
  do_check_footage quiet     # footage that sits in an older folder is moved into the shared one
  if [[ $DEMO == 1 ]]; then
    say "loading demo zones, posts and logins"
    local P; P="$(envget "$RPFD/.env" DB_PASSWORD)"
    PGPASSWORD="$P" psql -h "$CFG_DB_HOST" -p "$CFG_DB_PORT" -U "$(envget "$RPFD/.env" DB_USER || echo "$CFG_DB_USER")" -d "$(envget "$RPFD/.env" DB_NAME || echo "$CFG_DB_NAME")" -q -f "$CMSD/sql/fixtures.sql" >/dev/null 2>&1 || warn "fixtures not applied (already loaded?)"
    (cd "$RPFD" && set -a && . ./.env && set +a && node scripts/seed_demo.js >/dev/null 2>&1) || true
  fi


  [[ -f "$ROOT/data/.passwords-reset" ]] || do_reset_passwords   # once: every CMS / RPF account -> Admin@123
  TRAIN_NETS=""; auto_allow_trains

  local me; me="$(my_ip)"; me="${me:-<this-pc-ip>}"
  cat <<MSG

  CMS + RPF are running.
    CMS     http://$me:$CMS_PORT/console/        (logins: Admin@123 after the first start)
    RPF     http://$me:$CFG_RPF_PORT
  Footage folder (CMS + RPF share it): $MEDIA_DIR
  Trains allowed to connect: ${TRAIN_NETS:-none}   (ALLOW_TRAIN_NETWORKS in $CFG; one more PC: bash start.sh allow-train <ip>)
  On each train PC:              bash start.sh --cms $me
  Stop: bash start.sh stop      Logs: bash start.sh logs [cms|rpf]
MSG
  [[ $DEMO == 0 ]] && echo "  First time: open the RPF address and fill in the Thana / Post registration form (the CMS needs at least one zone: create it in the CMS console, or run: bash start.sh --demo-data)"
  return 0
}

[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0   # (sourced by a test: define the functions only)
case "$CMD" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status) (cd "$RPFD" && bash scripts/start.sh status) 2>&1 | tail -n 8 ;;
  reset-passwords) do_reset_passwords ;;
  check-footage) do_check_footage ;;
  diagnose-footage) do_diagnose_footage ;;
  allow-train) do_allow_train "$ARG" ;;
  trains) do_trains ;;
  choose-ip) pick_ip ;;
  logs) (cd "$RPFD" && bash scripts/start.sh logs "${ARG:-all}") ;;
esac
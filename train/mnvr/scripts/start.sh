#!/usr/bin/env bash
# =============================================================================
#  Railway mNVR — Single-Command Launcher (with MediaMTX)
#
#  FIRST TIME:   bash scripts/start.sh --setup-db
#  EVERY RUN:    bash scripts/start.sh
#  FLAGS:
#    --setup-db   Create DB, apply schema, seed data
#    --stop       Stop all services
#    --restart    Stop then start
#    --status     Show health of all services
#    --logs <svc> Tail logs: api|frontend|mediamtx|mtxsync|stream_manager|sidecar|indexer|analytics
#    --clean      Wipe storage/recordings and storage/hls
# =============================================================================
set -uo pipefail

# start.sh lives in scripts/ — ROOT is the repository root, one level up.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/logs"
PID_DIR="$ROOT/.pids"
mkdir -p "$LOG_DIR" "$PID_DIR"
STORAGE="/storage"   # decided properly in step 1 (needs the .env); /storage -> falls back to <repo>/storage if it cannot be created

# ── Arg parsing ───────────────────────────────────────────────────────────────
DO_SETUP=false; DO_STOP=false
DO_STATUS=false; DO_RESTART=false; DO_CLEAN=false; TAIL_SVC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup|--setup-db|-s)  DO_SETUP=true ;;
    --stop|--kill)          DO_STOP=true ;;
    --status|--health)      DO_STATUS=true ;;
    --restart|-r)           DO_RESTART=true ;;
    --clean)                DO_CLEAN=true ;;
    --logs|-l)              shift; TAIL_SVC="${1:-api}" ;;
    --help|-h|help)
      echo ""
      echo "  Railway mNVR — Usage:"
      echo "  bash start.sh                 Normal start"
      echo "  bash start.sh --setup-db      First-time DB setup"
      echo "  bash start.sh --stop          Stop all services"
      echo "  bash start.sh --status        Show service health"
      echo "  bash start.sh --logs api      Tail a log"
      echo "  bash start.sh --logs mediamtx Tail MediaMTX log"
      echo "  bash start.sh --clean         Wipe recordings + HLS"
      echo ""
      exit 0 ;;
    *) echo "Unknown flag: '$1' — use --help"; exit 1 ;;
  esac
  shift
done

# ── Colors + helpers ──────────────────────────────────────────────────────────
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[0;34m'
C='\033[0;36m'; W='\033[1;37m'; NC='\033[0m'; BOLD='\033[1m'
ok()   { echo -e "${G}  ✓${NC} $*"; }
warn() { echo -e "${Y}  ⚠${NC} $*"; }
err()  { echo -e "${R}  ✗${NC} $*" >&2; }
hdr()  { echo -e "\n${B}${BOLD}━━━ $* ━━━${NC}"; }
info() { echo -e "    $*"; }

# ── PID helpers ───────────────────────────────────────────────────────────────
pid_write() { echo "$2" > "$PID_DIR/$1.pid"; }
pid_read()  { cat "$PID_DIR/$1.pid" 2>/dev/null || true; }
pid_alive() { local p; p=$(pid_read "$1"); [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; }
pid_kill()  {
  local p; p=$(pid_read "$1")
  if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; then
    kill "$p" 2>/dev/null || true
    # Wait up to 10s for a clean SIGTERM shutdown before escalating, and
    # verify the process is really gone rather than assuming.
    for _ in $(seq 1 20); do
      kill -0 "$p" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$p" 2>/dev/null; then
      warn "$1 (PID $p) didn't exit after SIGTERM — forcing with SIGKILL"
      kill -9 "$p" 2>/dev/null || true
      sleep 0.5
    fi
    if kill -0 "$p" 2>/dev/null; then
      err "$1 (PID $p) still alive after SIGKILL — this shouldn't happen"
    else
      ok "Stopped $1 (PID $p)"
    fi
  fi
  rm -f "$PID_DIR/$1.pid"
}
kill_all() {
  for s in frontend api mediamtx mtxsync streammgr yolo indexer analytics; do pid_kill "$s"; done
  # only THIS repo's API (matched by working directory) — never the CMS / RPF / bridge node processes
  for _p in $(pgrep -f "node src/index.js" 2>/dev/null); do
    [[ "$(readlink "/proc/$_p/cwd" 2>/dev/null)" == "$ROOT/backend/api" ]] && kill "$_p" 2>/dev/null || true
  done
  pkill -f "mediamtx-sync.py"        2>/dev/null || true
  pkill -f "stream_manager.py"       2>/dev/null || true
  pkill -f "$ROOT/backend/mediamtx/mediamtx" 2>/dev/null || true
  pkill -f "uvicorn sidecar:app"     2>/dev/null || true
  pkill -f "backend/ai/indexer.py"   2>/dev/null || true
  pkill -f "ai/analytics/worker.py"  2>/dev/null || true
}

# ── --logs ────────────────────────────────────────────────────────────────────
if [[ -n "$TAIL_SVC" ]]; then
  logf="$LOG_DIR/${TAIL_SVC}.log"
  if [[ -f "$logf" ]]; then
    echo -e "${C}Tailing $logf — Ctrl+C to stop${NC}"
    exec tail -f "$logf"
  else
    err "No log: $logf"
    info "Available: $(ls "$LOG_DIR"/*.log 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
    exit 1
  fi
fi

# ── --stop ────────────────────────────────────────────────────────────────────
if $DO_STOP || $DO_RESTART; then
  hdr "Stopping Railway mNVR"
  kill_all; sleep 1; ok "All services stopped"
  $DO_STOP && exit 0
fi

# ── --clean ───────────────────────────────────────────────────────────────────
if $DO_CLEAN; then
  warn "Cleaning storage..."
  rm -rf "$STORAGE/recordings" "$STORAGE/hls"
  mkdir -p "$STORAGE/recordings" "$STORAGE/hls"
  ok "Storage cleaned"
fi

# ── --status ──────────────────────────────────────────────────────────────────
if $DO_STATUS; then
  hdr "Railway mNVR — Service Status"
  for svc in api frontend mediamtx mtxsync streammgr yolo indexer analytics; do
    if pid_alive "$svc"; then
      printf "  ${G}●${NC} %-12s PID %s\n" "$svc" "$(pid_read $svc)"
    else
      printf "  ${R}○${NC} %-12s stopped\n" "$svc"
    fi
  done
  echo ""
  check_http() {
    curl -sf --max-time 3 "$1" >/dev/null 2>&1 \
      && printf "  ${G}✓${NC} %-46s ${G}UP${NC}\n" "$2" \
      || printf "  ${R}✗${NC} %-46s ${R}DOWN${NC}\n" "$2"
  }
  check_http "http://localhost:${PORT:-3001}/api/health"  "API       http://localhost:${PORT:-3001}/api"
  check_http "http://localhost:9997/v3/paths/list"        "MediaMTX  http://localhost:9997"
  check_http "http://localhost:8889"                      "MTX WebRTC http://localhost:8889"
  check_http "http://localhost:8888"                       "MTX HLS   http://localhost:8888"
  check_http "http://localhost:8000/health"                "AI Sidecar http://localhost:8000 (Smart Search)"
  check_http "http://localhost:8080"                       "Frontend  http://localhost:8080"
  exit 0
fi

# Kill stale processes
kill_all 2>/dev/null || true; sleep 0.3

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${C}${BOLD}"
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║   Railway mNVR — Network Video Recorder                  ║"
echo "  ║   BEL · Indian Railways · EN 50155 · MediaMTX WebRTC   ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# =============================================================================
# STEP 1 — Environment
# =============================================================================
hdr "1/9  Environment"
ENV_FILE="$ROOT/backend/api/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  warn "backend/api/.env not found — creating defaults"
  cat > "$ENV_FILE" << 'ENVEOF'
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mnvr
DB_USER=mnvr
DB_PASSWORD=mnvr
JWT_SECRET=railway-nvr-super-secret-change-in-production
STORAGE_PATH=/storage
RECORDINGS_PATH=/storage/recordings
HLS_PATH=/storage/hls
PORT=3001
NODE_ENV=development
MEDIAMTX_API=http://localhost:9997
MEDIAMTX_RTSP=localhost:8554
# MEDIAMTX_WEB / MEDIAMTX_HLS intentionally NOT set here. These are the
# browser-facing WebRTC/HLS URLs — hardcoding them to localhost meant they
# silently pointed at the *viewer's own machine* whenever the dashboard was
# opened from anywhere other than this box itself, even though MediaMTX
# itself was fine. backend/api/src/routes/mediamtx.js now derives the correct
# host per-request from the incoming request when these are unset. Only
# set them explicitly if you're running behind a reverse proxy / fixed
# domain where per-request derivation would get it wrong.
ENVEOF
fi
set -a; source "$ENV_FILE"; set +a

# Ensure MediaMTX vars exist in env file (add if missing)
grep -q "MEDIAMTX_API" "$ENV_FILE" || cat >> "$ENV_FILE" << 'ADDENV'
MEDIAMTX_API=http://localhost:9997
MEDIAMTX_RTSP=localhost:8554
ADDENV

# VITE_API_URL is deliberately EMPTY: the browser then calls /api and /ws on the same host:port it loaded the page from,
# and Vite proxies them to the API on this machine. A hardcoded http://localhost:3001 breaks every other PC on the network.
if [[ ! -f "$ROOT/frontend/.env" ]]; then echo "VITE_API_URL=" > "$ROOT/frontend/.env"
elif grep -qE '^VITE_API_URL=.*localhost' "$ROOT/frontend/.env"; then sed -i 's|^VITE_API_URL=.*|VITE_API_URL=|' "$ROOT/frontend/.env"; fi

# VITE_MEDIAMTX_WEB / VITE_MEDIAMTX_HLS intentionally NOT written here —
# same reasoning as MEDIAMTX_WEB/HLS above. src/pages/CameraGrid.tsx falls
# back to window.location.hostname when these are unset at build time,
# which is correct regardless of which machine views the dashboard from.

# ── Storage: use STORAGE_PATH from .env; create it (sudo only if allowed without a prompt); else fall back inside the repo ──
STORAGE="${STORAGE_PATH:-/storage}"
if ! mkdir -p "$STORAGE/recordings" "$STORAGE/hls" "$STORAGE/search_thumbs" "$STORAGE/event_snaps" 2>/dev/null \
   || [[ ! -w "$STORAGE" ]]; then
  if command -v sudo >/dev/null && sudo -n true 2>/dev/null; then
    sudo mkdir -p "$STORAGE/recordings" "$STORAGE/hls" "$STORAGE/search_thumbs" "$STORAGE/event_snaps" \
      && sudo chown -R "$(id -u):$(id -g)" "$STORAGE" 2>/dev/null || true
  fi
fi
if [[ ! -w "$STORAGE" ]] || ! mkdir -p "$STORAGE/recordings" "$STORAGE/hls" "$STORAGE/search_thumbs" "$STORAGE/event_snaps" 2>/dev/null; then
  warn "cannot write to $STORAGE — using $ROOT/storage instead (to use $STORAGE:  sudo mkdir -p $STORAGE && sudo chown $USER $STORAGE)"
  STORAGE="$ROOT/storage"
  mkdir -p "$STORAGE/recordings" "$STORAGE/hls" "$STORAGE/search_thumbs" "$STORAGE/event_snaps"
fi
# keep .env and the processes started below pointing at the same folder
STORAGE="$(cd "$STORAGE" && pwd)"
setenv(){ if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi; export "$1=$2"; }
setenv STORAGE_PATH "$STORAGE"; setenv RECORDINGS_PATH "$STORAGE/recordings"; setenv HLS_PATH "$STORAGE/hls"

ok "Environment loaded — API :${PORT:-3001}  storage $STORAGE"

# =============================================================================
# STEP 2 — Prerequisites
# =============================================================================
hdr "2/9  Prerequisites"
MISSING=()
for cmd in node npm python3 ffmpeg psql curl; do
  command -v "$cmd" &>/dev/null && ok "$cmd" || { err "$cmd not found"; MISSING+=("$cmd"); }
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo ""
  err "Missing: ${MISSING[*]}"
  echo -e "${Y}  Fix:${NC}  sudo apt install -y nodejs npm python3 python3-pip python3-venv ffmpeg postgresql-client curl"
  exit 1
fi

# =============================================================================
# STEP 4 — Database
# =============================================================================
hdr "3/9  Database"
DB_HOST="${DB_HOST:-localhost}"; DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-mnvr}";     DB_USER="${DB_USER:-mnvr}"; DB_PASSWORD="${DB_PASSWORD:-mnvr}"

if $DO_SETUP; then
  warn "Creating user '${DB_USER}' and database '${DB_NAME}'..."
  _admin() {
    (sudo -n -u postgres psql -c "$1" 2>/dev/null) ||
    (PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U postgres -c "$1" 2>/dev/null) || true
  }
  _admin "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';"
  _admin "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
  _admin "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"
  PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -f "$ROOT/database/schema.sql" && ok "Schema applied"
  (cd "$ROOT/backend/api" && [[ ! -d node_modules ]] && npm install --silent)
  (cd "$ROOT/backend/api" && node seed.js) && ok "Seeded"
fi

warn "Checking PostgreSQL..."
for i in $(seq 1 15); do
  PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -c "SELECT 1" >/dev/null 2>&1 && { ok "PostgreSQL ready"; break; }
  [[ $i -eq 15 ]] && { err "Cannot connect to PostgreSQL — run: bash start.sh --setup-db"; exit 1; }
  printf "\r    Waiting (%d/15)..." "$i"; sleep 2
done; echo ""

# Apply any migrations in database/migrations/ on EVERY run, not just
# --setup-db. schema.sql only ever runs once, at first-time setup — a
# database that was provisioned before a given migration file was added to
# this repo never gets it applied, which is exactly what produces
#'relation "X" does not exist' errors on an otherwise-working install. Every
# migration here is written to be idempotent (CREATE TABLE IF NOT EXISTS /
# ADD COLUMN IF NOT EXISTS), so re-running an already-applied one is a no-op
# — safe to do unconditionally rather than trying to track which ones ran.
if [[ -d "$ROOT/database/migrations" ]]; then
  warn "Applying database migrations..."
  for m in "$ROOT"/database/migrations/*.sql; do
    [[ -f "$m" ]] || continue
    if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
         -v ON_ERROR_STOP=1 -f "$m" >/dev/null 2>"$LOG_DIR/migration_error.log"; then
      ok "  $(basename "$m")"
    else
      err "  $(basename "$m") failed — see $LOG_DIR/migration_error.log"
    fi
  done
fi

# =============================================================================
# STEP 5 — npm dependencies
# =============================================================================
hdr "4/9  Node.js Packages"
if [[ ! -d "$ROOT/backend/api/node_modules" ]]; then warn "Installing backend packages..."; (cd "$ROOT/backend/api" && npm install --silent) || { err "npm install failed in backend/api"; exit 1; }; fi
ok "Backend ready"
if [[ ! -d "$ROOT/frontend/node_modules" ]]; then warn "Installing frontend packages..."; (cd "$ROOT/frontend" && npm install --silent) || { err "npm install failed in frontend"; exit 1; }; fi
ok "Frontend ready"

# =============================================================================
# STEP 6 — Python venv (used by the MediaMTX-sync helper)
# =============================================================================
hdr "5/9  Python Packages"
VENV="$ROOT/backend/.venv"
if [[ ! -x "$VENV/bin/python" ]]; then
  warn "Creating Python venv..."; rm -rf "$VENV"
  if ! python3 -m venv "$VENV" 2>"$LOG_DIR/venv_error.log"; then
    command -v sudo >/dev/null && sudo -n true 2>/dev/null && sudo apt-get install -y -qq python3-venv >/dev/null 2>&1 && python3 -m venv "$VENV" 2>/dev/null
  fi
  [[ -x "$VENV/bin/python" ]] || { err "cannot create the Python venv — run:  sudo apt install -y python3-venv   (then start again)"; cat "$LOG_DIR/venv_error.log" 2>/dev/null; exit 1; }
fi
"$VENV/bin/pip" install --upgrade pip --quiet 2>/dev/null || true

# Install mediamtx-sync dependencies
warn "Installing mediamtx-sync packages..."
"$VENV/bin/pip" install -r "$ROOT/backend/mediamtx/requirements.txt" -q || warn "mediamtx-sync packages could not be installed (offline?) — camera path sync may not work"
info "──────────────────────────────────────────────────────"
ok "Python packages ready"

# =============================================================================
# STEP 7 — Download & start MediaMTX
# =============================================================================
hdr "6/9  MediaMTX (WebRTC / RTSP server)"

MTX_DIR="$ROOT/backend/mediamtx"
MTX_BIN="$MTX_DIR/mediamtx"
MTX_VER="v1.9.3"

# Detect OS/arch
ARCH=$(uname -m)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$ARCH" in
  x86_64)  ARCH_TAG="amd64" ;;
  aarch64) ARCH_TAG="arm64v8" ;;
  armv7*)  ARCH_TAG="armv7" ;;
  *)       ARCH_TAG="amd64" ;;
esac
MTX_TARBALL="mediamtx_${MTX_VER}_${OS}_${ARCH_TAG}.tar.gz"
MTX_URL="https://github.com/bluenviron/mediamtx/releases/download/${MTX_VER}/${MTX_TARBALL}"

if [[ ! -f "$MTX_BIN" ]]; then
  warn "Downloading MediaMTX ${MTX_VER} (${OS}/${ARCH_TAG})..."
  info "URL: $MTX_URL"
  if curl -L --progress-bar -o "$MTX_DIR/$MTX_TARBALL" "$MTX_URL"; then
    tar -xzf "$MTX_DIR/$MTX_TARBALL" -C "$MTX_DIR" mediamtx 2>/dev/null || \
    tar -xzf "$MTX_DIR/$MTX_TARBALL" -C "$MTX_DIR" 2>/dev/null
    chmod +x "$MTX_BIN"
    rm -f "$MTX_DIR/$MTX_TARBALL"
    ok "MediaMTX downloaded → $MTX_BIN"
  else
    err "Download failed. Download manually from:"
    err "  $MTX_URL"
    err "  Extract 'mediamtx' binary to: $MTX_DIR/"
    warn "Continuing without MediaMTX — WebRTC streams unavailable"
  fi
fi

if [[ -f "$MTX_BIN" ]]; then
  warn "Starting MediaMTX (RTSP :8554, WebRTC :8889, HLS :8888, API :9997)..."
  nohup "$MTX_BIN" "$MTX_DIR/mediamtx.yml" > "$LOG_DIR/mediamtx.log" 2>&1 &
  MTX_PID=$!
  pid_write "mediamtx" "$MTX_PID"

  # Wait for MediaMTX API to be ready
  for i in $(seq 1 20); do
    curl -sf --max-time 2 "http://localhost:9997/v3/paths/list" >/dev/null 2>&1 && { ok "MediaMTX ready ✓  (${i}s)"; break; }
    if ! kill -0 "$MTX_PID" 2>/dev/null; then
      err "MediaMTX crashed — last 10 lines of logs/mediamtx.log:"
      tail -10 "$LOG_DIR/mediamtx.log" | sed 's/^/    /'
      break
    fi
    [[ $i -eq 20 ]] && warn "MediaMTX taking longer — check logs/mediamtx.log"
    sleep 1
  done

  # Start mediamtx-sync (reads cameras from DB → creates MediaMTX paths)
  warn "Starting mediamtx-sync (camera → stream path sync every 15s)..."
  DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_NAME="$DB_NAME" \
  DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" \
  MEDIAMTX_API="http://localhost:9997" \
  SYNC_INTERVAL_SECS="15" \
  nohup "$VENV/bin/python" "$MTX_DIR/mediamtx-sync.py" > "$LOG_DIR/mtxsync.log" 2>&1 &
  pid_write "mtxsync" "$!"
  ok "mediamtx-sync PID $(pid_read mtxsync)  (logs/mtxsync.log)"
else
  warn "MediaMTX binary not found — WebRTC live streams unavailable"
  warn "Live view via WebRTC/HLS is unavailable until MediaMTX is installed"
fi

# =============================================================================
# STEP 9 — API + Recorder + C daemon
# =============================================================================
hdr "8/9  API Server + Stream Manager"

# API
warn "Starting Node.js API on :${PORT:-3001}..."
cd "$ROOT/backend/api"
nohup node src/index.js > "$LOG_DIR/api.log" 2>&1 &
API_PID=$!; pid_write "api" "$API_PID"; cd "$ROOT"
ok "API PID $API_PID  (logs/api.log)"

warn "Waiting for API..."
for i in $(seq 1 30); do
  LAST=$(tail -1 "$LOG_DIR/api.log" 2>/dev/null | tr -d '\r' || true)
  [[ -n "$LAST" ]] && printf "\r    [%2ds] %-72s" "$i" "${LAST:0:72}"
  if curl -sf --max-time 2 "http://localhost:${PORT:-3001}/api/health" >/dev/null 2>&1; then
    echo ""; ok "API ready ✓  (${i}s)"; break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo ""; err "API crashed:"; tail -10 "$LOG_DIR/api.log" | sed 's/^/    /'; exit 1
  fi
  [[ $i -eq 30 ]] && { echo ""; err "API not responding — check logs/api.log"; exit 1; }
  sleep 1
done

# ffmpeg-based stream manager — live view (push to MediaMTX) + recording,
# one thread per camera per purpose.
STREAM_MGR="$ROOT/backend/stream-manager/stream_manager.py"
if [[ -f "$STREAM_MGR" ]]; then
  DB_HOST="${DB_HOST}" DB_PORT="${DB_PORT}" DB_NAME="${DB_NAME}" \
  DB_USER="${DB_USER}" DB_PASSWORD="${DB_PASSWORD}" \
  RECORDINGS_PATH="${STORAGE:-/storage}/recordings" \
  SEGMENT_SECONDS="${SEGMENT_SECONDS:-120}" \
  MEDIAMTX_RTSP_HOST="127.0.0.1" MEDIAMTX_RTSP_PORT="8554" \
  LIVE_VIDEO_CODEC="${LIVE_VIDEO_CODEC:-libx265}" \
  ARCHIVE_VIDEO_CODEC="${ARCHIVE_VIDEO_CODEC:-hevc_nvenc}" \
  ARCHIVE_RATE_MODE="${ARCHIVE_RATE_MODE:-corridor}" \
  ARCHIVE_TARGET_BITRATE_KBPS="${ARCHIVE_TARGET_BITRATE_KBPS:-1100}" \
  ARCHIVE_MAX_BITRATE_KBPS="${ARCHIVE_MAX_BITRATE_KBPS:-1200}" \
  ARCHIVE_MIN_BITRATE_KBPS="${ARCHIVE_MIN_BITRATE_KBPS:-1000}" \
  LIVE_ENCODE_THREADS="${LIVE_ENCODE_THREADS:-2}" \
  ARCHIVE_ENCODE_THREADS="${ARCHIVE_ENCODE_THREADS:-2}" \
  nohup "$VENV/bin/python" "$STREAM_MGR" > "$LOG_DIR/stream_manager.log" 2>&1 &
  pid_write "streammgr" "$!"; sleep 1
  pid_alive "streammgr" && ok "stream_manager PID $(pid_read streammgr)  (logs/stream_manager.log)" \
    || err "stream_manager exited — check logs/stream_manager.log"
else
  err "stream_manager.py not found at $STREAM_MGR"
fi

# =============================================================================
# STEP 10 — Frontend
# =============================================================================
hdr "9/9  Frontend"
warn "Starting Vite on :8080..."
# Vite listens on "::" (IPv4 + IPv6). A machine with IPv6 switched off refuses that ("EAFNOSUPPORT"), so fall back to IPv4 there.
if node -e "require('net').createServer().listen(0,'::',function(){process.exit(0)}).on('error',function(){process.exit(1)})" 2>/dev/null; then export VITE_HOST="::"; else export VITE_HOST="0.0.0.0"; warn "IPv6 is not available here - the web page listens on IPv4 only"; fi
cd "$ROOT/frontend"
nohup npm run dev > "$LOG_DIR/frontend.log" 2>&1 &
FE_PID=$!; pid_write "frontend" "$FE_PID"
ok "Frontend PID $FE_PID  (logs/frontend.log)"

for i in $(seq 1 40); do
  LAST=$(tail -1 "$LOG_DIR/frontend.log" 2>/dev/null | tr -d '\r' || true)
  [[ -n "$LAST" ]] && printf "\r    [%2ds] %-72s" "$i" "${LAST:0:72}"
  if curl -sf --max-time 2 http://localhost:8080 >/dev/null 2>&1; then
    echo ""; ok "Frontend ready ✓  (${i}s)"; break
  fi
  [[ $i -eq 40 ]] && { echo ""; warn "Frontend still loading — visit http://localhost:8080 shortly"; }
  sleep 1
done

# (the AI parts install big packages on the first run, so they start AFTER the API and the web page are up)
# =============================================================================
# STEP 8 — AI Sidecar (YOLO + CLIP) + Smart Search Indexer
# =============================================================================
hdr "7/9  AI Sidecar + Smart Search Indexer"

AI_DIR="$ROOT/backend/ai"
AI_VENV="$AI_DIR/.venv"

if [[ -f "$AI_DIR/sidecar.py" ]]; then
  # Separate venv from backend/.venv (used by mediamtx-sync) — torch/ultralytics/
  # opencv are heavy and unrelated to that venv's needs, and keeping them
  # apart avoids any dependency-resolution fights between the two.
  [[ ! -d "$AI_VENV" ]] && { warn "Creating AI sidecar venv..."; python3 -m venv "$AI_VENV"; }

  # A venv's `bin/pip` script has its creation path baked into its shebang
  # line (`#!/abs/path/.venv/bin/python3`) — plain text, never rewritten on
  # copy. If this project folder was ever copied, renamed, or re-extracted
  # from a zip (hello, "(1)" suffixed folders) while an old .venv from a
  # previous location still physically exists somewhere on disk,
  # "$AI_VENV/bin/pip" silently executes THAT old interpreter via its
  # shebang — you get real, correct-looking pip output, just against the
  # wrong venv entirely, reporting packages "already satisfied" in a
  # completely different folder than the one you're actually running from.
  # That's what endless "it's downloading again" turns out to be: every run
  # fights a venv whose pip doesn't actually point at itself. Detect that
  # here and rebuild clean rather than patching something that can't be
  # made self-consistent in place.
  VENV_IS_FOREIGN=false
  if [[ -f "$AI_VENV/bin/pip" ]]; then
    PIP_SHEBANG="$(head -n1 "$AI_VENV/bin/pip")"
    # Only flag it when the shebang clearly names a DIFFERENT venv's own
    # python (the actual bug we saw: pointing at some other project's
    # ".../.venv/bin/python..."). A generic "#!/bin/sh" or
    # "#!/usr/bin/env python3" is a normal pip-bootstrap shape on some
    # distros (seen on this Ubuntu box) and is not evidence of anything
    # wrong — treating it as broken would rebuild the venv on every single
    # run forever, exactly defeating the point of the skip-cache below.
    if [[ "$PIP_SHEBANG" == "#!"*".venv/bin/python"* ]] && [[ "$PIP_SHEBANG" != "#!$AI_VENV"* ]]; then
      VENV_IS_FOREIGN=true
    fi
  fi
  if find "$AI_VENV/lib" -maxdepth 3 -iname '~*' 2>/dev/null | grep -q .; then
    VENV_IS_FOREIGN=true  # ghost dist-info from a previously interrupted reinstall
  fi
  if [[ "$VENV_IS_FOREIGN" == true ]]; then
    warn "AI venv is stale/foreign or corrupted (points at a different path, or has leftover partial installs) — rebuilding it clean..."
    [[ -f "$AI_VENV/bin/pip" ]] && warn "  pip shebang was: $(head -n1 "$AI_VENV/bin/pip")"
    rm -rf "$AI_VENV"
    python3 -m venv "$AI_VENV"
    rm -f "$AI_VENV/.requirements.sha256"  # force a real install below, not a skip
  fi

  "$AI_VENV/bin/pip" install --upgrade pip --quiet 2>/dev/null

  # Only touch pip/network at all if requirements.txt changed since the
  # last successful install AND the imports we actually need still work.
  # Without this check, `pip install -r requirements.txt` was running
  # (and, on a slow connection, re-resolving/re-fetching a large dependency
  # tree — torch pulls in several NVIDIA CUDA libraries as transitive
  # dependencies even on a plain `pip install torch`, easily gigabytes) on
  # every single `bash start.sh` run, forever, even when nothing changed.
  REQS_HASH_FILE="$AI_VENV/.requirements.sha256"
  REQS_HASH_NOW="$(sha256sum "$AI_DIR/requirements.txt" | awk '{print $1}')"
  NEEDS_INSTALL=true
  if [[ -f "$REQS_HASH_FILE" ]] && [[ "$(cat "$REQS_HASH_FILE")" == "$REQS_HASH_NOW" ]] \
     && "$AI_VENV/bin/python" -c "import fastapi, torch, open_clip" >/dev/null 2>&1; then
    NEEDS_INSTALL=false
    ok "AI sidecar packages already installed & verified — skipping (requirements.txt unchanged)"
  fi

  if [[ "$NEEDS_INSTALL" == true ]]; then
    warn "Installing AI sidecar packages (first run, or requirements.txt changed — can take a while)..."
    "$AI_VENV/bin/pip" install --timeout 100 --retries 10 -r "$AI_DIR/requirements.txt"

    # Belt-and-suspenders: `pip install -r requirements.txt` can come back
    # exit-0 as a whole even when the venv it's installing into is a stale
    # partial one from before this file grew CLIP support — silently
    # leaving `import open_clip` missing while fastapi/ultralytics are fine
    # (the exact symptom that bit us: /detect worked, /embed-image 500'd
    # with "No module named 'open_clip'"). Actually try the imports Smart
    # Search needs and force a clean reinstall if any are missing, rather
    # than starting a sidecar that will fail the first time someone searches.
    if "$AI_VENV/bin/python" -c "import fastapi, torch, open_clip" 2>"$LOG_DIR/sidecar_deps_check.log"; then
      echo "$REQS_HASH_NOW" > "$REQS_HASH_FILE"
      ok "AI sidecar packages ready"
    else
      warn "Some AI dependencies missing after install — forcing a clean reinstall..."
      cat "$LOG_DIR/sidecar_deps_check.log" | sed 's/^/    /'
      "$AI_VENV/bin/pip" install --force-reinstall --no-cache-dir --timeout 100 --retries 10 -r "$AI_DIR/requirements.txt"
      if "$AI_VENV/bin/python" -c "import fastapi, torch, open_clip" 2>"$LOG_DIR/sidecar_deps_check.log"; then
        echo "$REQS_HASH_NOW" > "$REQS_HASH_FILE"
        ok "AI sidecar packages ready after forced reinstall"
      else
        err "AI dependencies still broken after a forced reinstall:"
        cat "$LOG_DIR/sidecar_deps_check.log" | sed 's/^/    /'
        err "Smart Search will not work until this is fixed. Continuing without it."
        SKIP_AI_SIDECAR=true
      fi
    fi
    rm -f "$LOG_DIR/sidecar_deps_check.log"
  fi

if [[ "${SKIP_AI_SIDECAR:-false}" != true ]]; then
  # Sidecar (YOLO detection + CLIP embeddings for Smart Search). Run via
  # this venv's own python -m uvicorn, NOT a system-wide `uvicorn` binary —
  # a global/apt-installed uvicorn runs against the system Python, which
  # doesn't have fastapi/torch/etc installed here, and fails with
  # "ModuleNotFoundError: No module named 'fastapi'" even though the venv
  # above has everything it needs.
  warn "Starting AI sidecar on :8000 (YOLO + CLIP)..."
  cd "$AI_DIR"
  nohup "$AI_VENV/bin/python" -m uvicorn sidecar:app --host 0.0.0.0 --port 8000 \
    > "$LOG_DIR/sidecar.log" 2>&1 &
  pid_write "yolo" "$!"
  cd "$ROOT"

  warn "Waiting for AI sidecar..."
  for i in $(seq 1 60); do
    curl -sf --max-time 2 "http://localhost:8000/health" >/dev/null 2>&1 && { ok "AI sidecar ready ✓  (${i}s)"; break; }
    if ! pid_alive "yolo"; then
      err "AI sidecar crashed — last 15 lines of logs/sidecar.log:"
      tail -15 "$LOG_DIR/sidecar.log" | sed 's/^/    /'
      break
    fi
    # First boot downloads YOLO weights (~6MB) via ultralytics — can take a
    # little longer than the API's own health-check loop.
    [[ $i -eq 60 ]] && warn "AI sidecar taking longer than expected — check logs/sidecar.log"
    sleep 1
  done

  # Real-time person-detection indexer for Smart Search. Talks to the API
  # (needs it already up — started in the next step) and the sidecar above.
  # It's fine to start it now regardless: it retries its own login/HTTP
  # calls internally rather than requiring the API to already be ready.
  if [[ -f "$AI_DIR/indexer.py" ]]; then
    warn "Starting Smart Search indexer (samples live camera streams)..."
    API_URL="http://localhost:${PORT:-3001}" \
    API_USER="${INDEXER_USER:-admin}" API_PASS="${INDEXER_PASS:-Admin@123}" \
    YOLO_SIDECAR_URL="http://localhost:8000" \
    MEDIAMTX_RTSP="localhost:8554" \
    STORAGE_PATH="$STORAGE" \
    SAMPLE_INTERVAL_SECS="${SAMPLE_INTERVAL_SECS:-2}" \
    POLL_CAMERAS_SECS="${POLL_CAMERAS_SECS:-30}" \
    INDEXER_DETECT_CONF="${INDEXER_DETECT_CONF:-0.45}" \
    INDEXER_MAX_PEOPLE_PER_FRAME="${INDEXER_MAX_PEOPLE_PER_FRAME:-5}" \
    nohup "$AI_VENV/bin/python" "$AI_DIR/indexer.py" > "$LOG_DIR/indexer.log" 2>&1 &
    pid_write "indexer" "$!"
    ok "Indexer PID $(pid_read indexer)  (logs/indexer.log)"
  fi
fi
else
  warn "backend/ai/sidecar.py not found — Smart Search unavailable"
fi

# =============================================================================
# STEP 9b — AI Analytics worker (fall/lean, smoke, crowd, rail obstacle — CPU)
# =============================================================================
# Own venv (backend/ai/analytics/.venv): it needs a newer ultralytics (YOLO26)
# than backend/ai/requirements.txt pins for the sidecar. NEVER fatal: any
# problem here skips the worker with a warning; recording / live view /
# Smart Search keep running.
hdr "8b/9  AI Analytics Worker"
AN_DIR="$ROOT/backend/ai/analytics"
AN_VENV="$AN_DIR/.venv"
touch "$LOG_DIR/analytics.log"

an_has_creds() {
  [[ -n "${ANALYTICS_USER:-}" && -n "${ANALYTICS_PASS:-}" ]] && return 0
  [[ -f "$AN_DIR/.env" ]] && grep -qE '^ANALYTICS_USER=.+' "$AN_DIR/.env" \
                          && grep -qE '^ANALYTICS_PASS=.+' "$AN_DIR/.env"
}

# Nothing to do by hand: when the worker has no login yet, create its service account (role API_CLIENT) straight in the
# database and write backend/ai/analytics/.env. The database exists by this step.
if [[ -f "$AN_DIR/worker.py" ]] && ! an_has_creds; then
  AN_PW="$(python3 -c 'import secrets; print(secrets.token_hex(15))' 2>/dev/null || date +%s%N | sha256sum | cut -c1-30)-Aa1"
  if ( cd "$ROOT/backend/api" && node create-service-user.js analytics-worker "$AN_PW" --reset >/dev/null 2>&1 ); then
    { [[ -f "$AN_DIR/.env" ]] && grep -vE '^(ANALYTICS_USER|ANALYTICS_PASS)=' "$AN_DIR/.env" \
        || grep -vE '^(ANALYTICS_USER|ANALYTICS_PASS)=' "$AN_DIR/.env.example" 2>/dev/null || true; \
      echo "ANALYTICS_USER=analytics-worker"; echo "ANALYTICS_PASS=$AN_PW"; } > "$AN_DIR/.env.new" && mv "$AN_DIR/.env.new" "$AN_DIR/.env"
    chmod 600 "$AN_DIR/.env" 2>/dev/null || true
    ok "Analytics service account 'analytics-worker' created (credentials saved in backend/ai/analytics/.env)"
  else
    warn "Could not create the analytics service account automatically (is the database up?)"
  fi
fi

if [[ ! -f "$AN_DIR/worker.py" ]]; then
  info "backend/ai/analytics/worker.py not found — analytics worker not installed"
elif ! an_has_creds; then
  warn "Analytics worker skipped — ANALYTICS_USER / ANALYTICS_PASS not set"
  info "  1) cd backend/api && node create-service-user.js analytics-worker '<long password>'"
  info "  2) put both values in backend/ai/analytics/.env  (see .env.example)"
else
  AN_OK=true
  [[ ! -d "$AN_VENV" ]] && { warn "Creating analytics venv..."; python3 -m venv "$AN_VENV" || AN_OK=false; }

  # Same stale/foreign-venv guard as the sidecar block above.
  if [[ -f "$AN_VENV/bin/pip" ]]; then
    AN_SHEBANG="$(head -n1 "$AN_VENV/bin/pip")"
    if [[ "$AN_SHEBANG" == "#!"*".venv/bin/python"* ]] && [[ "$AN_SHEBANG" != "#!$AN_VENV"* ]]; then
      warn "Analytics venv points at a different path — rebuilding it clean..."
      rm -rf "$AN_VENV"; python3 -m venv "$AN_VENV" || AN_OK=false
    fi
  fi

  if [[ "$AN_OK" == true ]]; then
    AN_HASH_FILE="$AN_VENV/.requirements.sha256"
    AN_HASH_NOW="$(sha256sum "$AN_DIR/requirements.txt" | awk '{print $1}')"
    if [[ -f "$AN_HASH_FILE" ]] && [[ "$(cat "$AN_HASH_FILE")" == "$AN_HASH_NOW" ]] \
       && "$AN_VENV/bin/python" -c "import torch, ultralytics, cv2, requests" >/dev/null 2>&1; then
      ok "Analytics packages already installed & verified — skipping"
    else
      warn "Installing analytics packages (first run, or requirements.txt changed — can take a while)..."
      "$AN_VENV/bin/pip" install --upgrade pip --quiet 2>/dev/null || true
      if "$AN_VENV/bin/pip" install --timeout 100 --retries 10 -r "$AN_DIR/requirements.txt" \
         && "$AN_VENV/bin/python" -c "import torch, ultralytics, cv2, requests" 2>"$LOG_DIR/analytics_deps_check.log"; then
        echo "$AN_HASH_NOW" > "$AN_HASH_FILE"
        ok "Analytics packages ready"
      else
        err "Analytics dependencies failed to install/import — worker skipped:"
        [[ -f "$LOG_DIR/analytics_deps_check.log" ]] && sed 's/^/    /' "$LOG_DIR/analytics_deps_check.log"
        AN_OK=false
      fi
      rm -f "$LOG_DIR/analytics_deps_check.log"
    fi
  fi

  if [[ "$AN_OK" == true ]]; then
    warn "Starting analytics worker (polls API for per-camera analytics)..."
    # Explicit env wins over analytics/.env, keeping API_URL / storage consistent with this launcher.
    ( cd "$AN_DIR" && \
      API_URL="http://localhost:${PORT:-3001}" \
      MEDIAMTX_RTSP="localhost:8554" \
      STORAGE_PATH="$STORAGE" \
      nohup "$AN_VENV/bin/python" worker.py > "$LOG_DIR/analytics.log" 2>&1 &
      echo $! > "$PID_DIR/analytics.pid" )
    sleep 2
    if pid_alive "analytics"; then
      ok "Analytics worker PID $(pid_read analytics)  (logs/analytics.log)"
    else
      err "Analytics worker exited at startup — last lines of logs/analytics.log:"
      tail -8 "$LOG_DIR/analytics.log" | sed 's/^/    /'
      rm -f "$PID_DIR/analytics.pid"
    fi
  fi
fi

# =============================================================================
# DONE
# =============================================================================
echo ""
echo -e "${C}${BOLD}"
echo "  ╔══════════════════════════════════════════════════════════════╗"
echo "  ║          ✅  Railway mNVR System Running                    ║"
echo "  ╠══════════════════════════════════════════════════════════════╣"
printf "  ║  %-60s║\n" "🌐 Frontend    →  http://localhost:8080"
printf "  ║  %-60s║\n" "🔌 API         →  http://localhost:${PORT:-3001}/api"
printf "  ║  %-60s║\n" "📖 API Docs    →  http://localhost:${PORT:-3001}/api/docs"
printf "  ║  %-60s║\n" "📡 MediaMTX    →  http://localhost:9997  (API)"
printf "  ║  %-60s║\n" "🎥 WebRTC      →  http://localhost:8889/cam_<id>/whep"
printf "  ║  %-60s║\n" "📺 HLS         →  http://localhost:8888/cam_<id>/index.m3u8"
printf "  ║  %-60s║\n" "📷 RTSP        →  rtsp://localhost:8554/cam_<id>"
printf "  ║  %-60s║\n" "🧠 AI Sidecar  →  http://localhost:8000/health"
printf "  ║  %-60s║\n" "✨ Smart Search →  Search page → \"Smart Search (AI)\" tab"
echo "  ╠══════════════════════════════════════════════════════════════╣"
printf "  ║  %-60s║\n" "🔑 Login: admin / Admin@123"
echo "  ╠══════════════════════════════════════════════════════════════╣"
printf "  ║  %-60s║\n" "📋 Logs:    bash start.sh --logs mediamtx"
printf "  ║  %-60s║\n" "📋 Logs:    bash start.sh --logs mtxsync"
printf "  ║  %-60s║\n" "📋 Logs:    bash start.sh --logs sidecar"
printf "  ║  %-60s║\n" "📋 Logs:    bash start.sh --logs indexer"
printf "  ║  %-60s║\n" "📋 Logs:    bash start.sh --logs analytics"
printf "  ║  %-60s║\n" "📊 Status:  bash start.sh --status"
printf "  ║  %-60s║\n" "🛑 Stop:    Ctrl+C  or  bash start.sh --stop"
echo "  ╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "${Y}  All logs streaming — Ctrl+C to stop everything${NC}"
echo ""

cleanup() {
  echo ""
  warn "Shutting down all services..."
  kill_all
  ok "All stopped. Bye."; exit 0
}
trap cleanup INT TERM

tail -f "$LOG_DIR/api.log" \
        "$LOG_DIR/mediamtx.log" \
        "$LOG_DIR/mtxsync.log" \
        "$LOG_DIR/stream_manager.log" \
        "$LOG_DIR/sidecar.log" \
        "$LOG_DIR/indexer.log" \
        "$LOG_DIR/analytics.log" \
        "$LOG_DIR/frontend.log" 2>/dev/null &
wait
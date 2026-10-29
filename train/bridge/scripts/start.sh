#!/usr/bin/env bash
# Run the bridge in the background on the train unit.
#   bash scripts/start.sh [start|stop|restart|status|logs|provision ...]
# Needs: Node 18.17+, a .env (copy .env.example). Does not touch the M-NVR or CMS.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
RUN="$ROOT/run"; LOGS="$ROOT/logs"; mkdir -p "$RUN" "$LOGS"
PIDF="$RUN/bridge.pid"; LOGF="$LOGS/bridge.log"
alive() { [[ -f "$PIDF" ]] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }

cmd="${1:-start}"; shift || true
case "$cmd" in
  start)
    alive && { echo "already running (pid $(cat "$PIDF"))"; exit 0; }
    [[ -f .env ]] || { echo "no .env here - copy .env.example to .env and fill it in" >&2; exit 1; }
    command -v node >/dev/null || { echo "node is not installed" >&2; exit 1; }
    [[ -d node_modules/pg ]] || npm install --omit=dev --silent
    setsid nohup node src/index.js >> "$LOGF" 2>&1 < /dev/null & echo $! > "$PIDF"
    sleep 2; alive && echo "bridge started (pid $(cat "$PIDF")), log: $LOGF" || { echo "bridge exited - see $LOGF" >&2; tail -n 15 "$LOGF" >&2; exit 1; } ;;
  stop)    alive && { kill "$(cat "$PIDF")"; rm -f "$PIDF"; echo stopped; } || echo "not running" ;;
  restart) "$0" stop; "$0" start ;;
  status)
    if alive; then echo "running (pid $(cat "$PIDF"))"; curl -s -m 3 "http://127.0.0.1:${STATUS_PORT:-8095}/health" || true; echo; else echo "not running"; exit 1; fi ;;
  logs)    tail -n 80 -f "$LOGF" ;;
  provision) node scripts/provision.js "$@" ;;
  *) echo "usage: $0 start|stop|restart|status|logs|provision --name .. --zone .." >&2; exit 2 ;;
esac

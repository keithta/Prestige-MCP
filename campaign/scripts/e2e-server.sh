#!/usr/bin/env bash
# Start/stop the web app for end-to-end tests, tracked by pidfile.
# (Matching on a command-line pattern is unreliable here: the pattern also
# matches the shell that launched it.)
set -euo pipefail

PORT="${E2E_PORT:-3100}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="${ROOT}/.e2e-server.pid"
LOGFILE="${ROOT}/.e2e-server.log"

case "${1:-start}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "already running (pid $(cat "$PIDFILE"))"; exit 0
    fi
    cd "$ROOT/apps/web"
    DATABASE_URL="${DATABASE_URL:-postgresql://campaign:campaign@127.0.0.1:55432/campaign_test}" \
    SESSION_SECRET="${SESSION_SECRET:-e2e-session-secret-not-for-production}" \
    APP_BASE_URL="http://127.0.0.1:${PORT}" \
    NODE_ENV=production \
      node "$ROOT/node_modules/next/dist/bin/next" start -p "$PORT" > "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"

    for _ in $(seq 1 40); do
      if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/login"; then
        echo "web app ready on http://127.0.0.1:${PORT}"; exit 0
      fi
      sleep 0.5
    done
    echo "web app did not become ready; see $LOGFILE" >&2
    tail -20 "$LOGFILE" >&2
    exit 1
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat "$PIDFILE")" 2>/dev/null || true
      rm -f "$PIDFILE"
      echo "stopped"
    else
      echo "not running"
    fi
    ;;
  log) tail -f "$LOGFILE" ;;
  *) echo "usage: $0 {start|stop|log}" >&2; exit 2 ;;
esac

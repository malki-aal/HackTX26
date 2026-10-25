#!/usr/bin/env bash
# Hackathon demo launcher with a FIXED public URL: runs the local backend behind Tailscale Funnel
# (https://<machine>.<tailnet>.ts.net). Unlike a quick tunnel, the URL survives restarts, so the
# frontend needs one redeploy only. The Mac must stay on, awake and online.
# Usage: backend/scripts/demo-funnel.sh        (Ctrl-C stops the backend; the Funnel config stays)
# Reads backend/.env as usual; never prints its values. Logs go to backend/var/ (git-ignored).
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"; PORT="${PORT:-8000}"
mkdir -p var
API_LOG=var/demo-backend.log
URL_FILE=var/public-url.txt

TS="$(command -v tailscale || true)"
[ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -n "$TS" ] || { echo "Tailscale not found. Install it and sign in first (docs/DEMO_TUNNEL.md)."; exit 1; }
"$TS" status >/dev/null 2>&1 || { echo "Tailscale is not connected. Open Tailscale and sign in."; exit 1; }

# Stop a previous backend on the port and any quick tunnel from the old launcher.
for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
pkill -f "cloudflared tunnel --url http://127.0.0.1:$PORT" 2>/dev/null || true
pkill -f "scripts/demo-tunnel.sh" 2>/dev/null || true
sleep 1

# Keep the Mac awake while this runs (lid closed on battery still sleeps: stay plugged in).
command -v caffeinate >/dev/null && { caffeinate -ims -w $$ & }

API_PID=""
start_backend() {
  npm start >>"$API_LOG" 2>&1 &
  API_PID=$!
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$PORT/api/v1/health" >/dev/null && return 0
    kill -0 "$API_PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}
STOPPING=0
cleanup() { echo; echo "Stopping backend (Funnel config is kept)..."; kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; }
# Ctrl-C / kill must end the launcher too; otherwise the keep-alive loop below would restart the backend.
trap 'STOPPING=1; cleanup; exit 0' INT TERM
trap cleanup EXIT

echo "Starting backend on 127.0.0.1:$PORT (log: backend/$API_LOG)..."
start_backend || { echo "Backend failed to start; see backend/$API_LOG"; exit 1; }
echo "Backend healthy."

# Publish port 443 of this machine's ts.net name to the backend. --bg persists in tailscaled.
"$TS" funnel --bg --yes "http://127.0.0.1:$PORT" >/dev/null 2>&1 || "$TS" funnel --bg "http://127.0.0.1:$PORT" >/dev/null
HOSTNAME_="$("$TS" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
URL="https://$HOSTNAME_"
echo "$URL/api/v1" > "$URL_FILE"

# Public checks (a new Funnel name can take a minute to resolve and get its certificate).
for _ in $(seq 1 45); do curl -sf -m 10 "$URL/api/v1/health" >/dev/null && break; sleep 2; done
HEALTH="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$URL/api/v1/health" || true)"
PROTECTED="$(curl -s -m 10 "$URL/api/v1/me" | grep -oE '"code":"[A-Z_]+"' || true)"

cat <<EOF

==================================================================
 Public health:          HTTP $HEALTH
 Unauthenticated /me:    $PROTECTED (expected UNAUTHENTICATED)

 Frontend setting (Vercel, Production) - fixed, set it once:
   NEXT_PUBLIC_API_BASE_URL=$URL/api/v1
 (also saved to backend/$URL_FILE)

 Keep this terminal open and the Mac awake, plugged in and online.
 The backend restarts itself if it crashes. Ctrl-C stops it.
==================================================================
EOF

# Keep-alive: restart the backend if it exits (the public URL does not change).
while [ "$STOPPING" = 0 ]; do
  wait "$API_PID" || true
  [ "$STOPPING" = 0 ] || break
  echo "$(date '+%F %T') backend exited; restarting..." | tee -a "$API_LOG"
  sleep 2
  start_backend || echo "$(date '+%F %T') restart failed; retrying" | tee -a "$API_LOG"
done

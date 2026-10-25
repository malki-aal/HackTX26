#!/usr/bin/env bash
# Hackathon demo launcher: (re)starts the local backend and a Cloudflare quick tunnel to it.
# Usage: backend/scripts/demo-tunnel.sh        (Ctrl-C stops both)
# Reads backend/.env as usual; never prints its values. Logs go to backend/var/ (git-ignored).
# NOTE: every quick-tunnel start gets a NEW random https://*.trycloudflare.com URL. After a
# restart, the frontend's NEXT_PUBLIC_API_BASE_URL must be updated and the frontend redeployed.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"; PORT="${PORT:-8000}"
mkdir -p var
API_LOG=var/demo-backend.log
TUN_LOG=var/demo-tunnel.log
URL_FILE=var/tunnel-url.txt

command -v cloudflared >/dev/null || { echo "cloudflared not installed (brew install cloudflared)"; exit 1; }

# Stop anything left over from a previous run of this launcher (or another server on the port).
for pid in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
pkill -f "cloudflared tunnel --url http://127.0.0.1:$PORT" 2>/dev/null || true
sleep 1

echo "Starting backend on 127.0.0.1:$PORT (log: backend/$API_LOG)..."
npm start >"$API_LOG" 2>&1 &
API_PID=$!
cleanup() { echo; echo "Stopping..."; kill "${TUN_PID:-}" "$API_PID" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/v1/health" >/dev/null && break
  kill -0 "$API_PID" 2>/dev/null || { echo "Backend exited; see backend/$API_LOG"; exit 1; }
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/api/v1/health" >/dev/null || { echo "Backend not healthy; see backend/$API_LOG"; exit 1; }
echo "Backend healthy."

echo "Starting Cloudflare quick tunnel (log: backend/$TUN_LOG)..."
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$TUN_LOG" 2>&1 &
TUN_PID=$!
URL=""
for _ in $(seq 1 60); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUN_LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "No tunnel URL; see backend/$TUN_LOG"; exit 1; }
echo "$URL/api/v1" > "$URL_FILE"

# Public checks. Resolve via 1.1.1.1: macOS caches the "not found" answer it gets while a new
# tunnel hostname is still propagating, so local DNS can lag for minutes (browsers elsewhere don't).
HOSTNAME_="${URL#https://}"
RESOLVE=()
for _ in $(seq 1 30); do
  IP="$(dig +short "$HOSTNAME_" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)"
  [ -n "$IP" ] && RESOLVE=(--resolve "$HOSTNAME_:443:$IP") && curl -sf -m 10 "${RESOLVE[@]}" "$URL/api/v1/health" >/dev/null && break
  sleep 2
done
HEALTH="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "${RESOLVE[@]}" "$URL/api/v1/health" || true)"
PROTECTED="$(curl -s -m 10 "${RESOLVE[@]}" "$URL/api/v1/me" | grep -oE '"code":"[A-Z_]+"' || true)"

cat <<EOF

==================================================================
 Public health:          HTTP $HEALTH
 Unauthenticated /me:    $PROTECTED (expected UNAUTHENTICATED)

 Frontend setting (Vercel, Production):
   NEXT_PUBLIC_API_BASE_URL=$URL/api/v1
 (also saved to backend/$URL_FILE)

 This URL changes every time this launcher or the tunnel restarts.
 Keep this terminal open; Ctrl-C stops the backend and the tunnel.
==================================================================
EOF
wait "$TUN_PID"

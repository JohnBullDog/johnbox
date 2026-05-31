#!/usr/bin/env bash
# JohnBox launcher — starts ngrok first, waits for the tunnel, then starts the server.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Colours ────────────────────────────────────────────────
R='\033[0;31m'  G='\033[0;32m'  Y='\033[1;33m'
C='\033[0;36m'  B='\033[1m'     N='\033[0m'

echo -e "${B}${C}"
cat << 'EOF'
   _  _      _      ___
  | || |___ | |___ | _ ) _____ __
  | || / _ \| '_ \ | _ \/ _ \ \/ /
  |_|_|\___/|_||_/ |___/\___/_/\_\

EOF
echo -e "${N}"

# ── Kill old instances ─────────────────────────────────────
echo -e "${Y}Cleaning up old processes...${N}"
pkill ngrok 2>/dev/null || true
# Kill anything on port 3000 safely
PIDS=$(lsof -ti:3000 2>/dev/null) && echo "$PIDS" | xargs kill -9 2>/dev/null || true
sleep 1

# ── Start ngrok ────────────────────────────────────────────
echo -e "${Y}Starting ngrok tunnel...${N}"
ngrok http 3000 --log=stdout > /tmp/ngrok-johnbox.log 2>&1 &
NGROK_PID=$!

PUBLIC_URL=""
echo -n "  Waiting for tunnel"
for i in $(seq 1 20); do
  sleep 1
  echo -n "."
  RESULT=$(curl -sf http://127.0.0.1:4040/api/tunnels 2>/dev/null) || continue
  PUBLIC_URL=$(echo "$RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
t=next((t for t in d.get('tunnels',[]) if t.get('proto')=='https'), d.get('tunnels',[{}])[0])
print(t.get('public_url',''))
" 2>/dev/null)
  [ -n "$PUBLIC_URL" ] && break
done
echo ""

if [ -z "$PUBLIC_URL" ]; then
  echo -e "${R}  Warning: ngrok tunnel not available. Players will use LAN address.${N}"
else
  echo -e "${G}  Tunnel ready: ${PUBLIC_URL}${N}"
fi

# ── Start server (with auto-restart on crash) ──────────────
echo -e "${Y}Starting game server...${N}"
cd "$DIR"

SERVER_LOG="/tmp/johnbox-server.log"
> "$SERVER_LOG"

# Wrapper that restarts node if it exits unexpectedly
(while true; do
  node server/index.js >> "$SERVER_LOG" 2>&1
  EXIT=$?
  echo -e "\n[$(date)] Server exited (code $EXIT) — restarting in 2s..." >> "$SERVER_LOG"
  echo -e "${R}  Server crashed (exit $EXIT) — restarting...${N}"
  sleep 2
done) &
SERVER_PID=$!

sleep 2

# Check something is now listening on the port
if ! curl -sf http://localhost:3000/ > /dev/null 2>&1; then
  echo -e "${R}Server failed to start. Log: $SERVER_LOG${N}"
  cat "$SERVER_LOG"
  exit 1
fi
echo -e "${G}  Server log : $SERVER_LOG${N}"

# ── Open host screen ───────────────────────────────────────
echo -e "${Y}Opening host screen in browser...${N}"
DISPLAY=:0 firefox http://localhost:3000 2>/dev/null &

# ── Summary ────────────────────────────────────────────────
echo ""
echo -e "${B}${G}╔══════════════════════════════════════════════════════╗${N}"
echo -e "${B}${G}║           JohnBox is running!                        ║${N}"
echo -e "${B}${G}╚══════════════════════════════════════════════════════╝${N}"
echo ""
echo -e "  ${B}Host / TV screen :${N} http://localhost:3000"
if [ -n "$PUBLIC_URL" ]; then
  echo -e "  ${B}Players join at  :${N} ${C}${PUBLIC_URL}/play${N}"
  echo ""
  echo -e "  ${Y}► Scan the QR code on the lobby screen!${N}"
else
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo -e "  ${B}Players (LAN)    :${N} ${C}http://${LAN_IP}:3000/play${N}"
fi
echo ""
echo -e "  ${R}Press Ctrl+C to stop JohnBox${N}"
echo ""

# ── Cleanup on exit ────────────────────────────────────────
cleanup() {
  echo ""
  echo -e "${Y}Stopping JohnBox...${N}"
  kill "$SERVER_PID" 2>/dev/null || true
  kill "$NGROK_PID"  2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  echo -e "${G}Stopped. Goodbye!${N}"
  echo ""
  read -rp "Press Enter to close this window..." 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait "$SERVER_PID"

#!/bin/bash
set -e

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "---------------------------------------------------"
echo "Starting MapleStory WASM Web Stack (Local)"
echo "---------------------------------------------------"

# Install Python dependencies
echo "[1/4] Installing Python dependencies..."
pip install websockets aiosqlite 2>/dev/null || pip3 install websockets aiosqlite 2>/dev/null

# Start all services in the background
echo "[2/4] Starting HTTP server on :8000..."
python web/server.py &
PID_HTTP=$!

echo "[3/4] Starting WS proxy on :8080..."
python web/ws_proxy.py --ws-port 8080 &
PID_PROXY=$!

echo "[4/4] Starting social relay on :8090..."
python web/social_server.py --port 8090 &
PID_SOCIAL=$!

# Save PIDs for stop script
mkdir -p .local
echo "$PID_HTTP" > .local/pid_http
echo "$PID_PROXY" > .local/pid_proxy
echo "$PID_SOCIAL" > .local/pid_social

echo "---------------------------------------------------"
echo "All services started!"
echo ""
echo "Web URL:           http://localhost:8000"
echo "WS Proxy URL:      ws://localhost:8080"
echo "Social Relay URL:  ws://localhost:8090"
echo ""
echo "PIDs: http=$PID_HTTP proxy=$PID_PROXY social=$PID_SOCIAL"
echo ""
echo "To stop: ./scripts/stop_local.sh"
echo "---------------------------------------------------"

# Wait for all background processes
wait

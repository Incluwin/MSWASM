#!/bin/bash

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "---------------------------------------------------"
echo "Stopping MapleStory WASM Web Stack (Local)"
echo "---------------------------------------------------"

stopped=0

for service in http proxy social; do
    pidfile=".local/pid_${service}"
    if [ -f "$pidfile" ]; then
        pid=$(cat "$pidfile")
        if kill -0 "$pid" 2>/dev/null; then
            echo "Stopping $service (PID $pid)..."
            kill "$pid" 2>/dev/null
            stopped=$((stopped + 1))
        else
            echo "$service (PID $pid) already stopped"
        fi
        rm -f "$pidfile"
    fi
done

if [ "$stopped" -eq 0 ]; then
    echo "No running services found."
else
    echo ""
    echo "Stopped $stopped service(s)."
fi

echo "---------------------------------------------------"

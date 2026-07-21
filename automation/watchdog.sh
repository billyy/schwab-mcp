#!/bin/bash
# Health watchdog for the Schwab MCP stack (invoked by launchd every 5 min).
# KeepAlive only restarts processes that EXIT — wrangler dev can wedge with
# its root process alive but the port dead, which this catches.
set -u

GUI="gui/$(id -u)"
TUNNEL_URL="https://obsolescent-corporately-easter.ngrok-free.dev/"

probe() {
	# curl -w prints "000" itself when the connection fails
	local code
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
		-H 'ngrok-skip-browser-warning: 1' "$1" 2>/dev/null)
	echo "${code:-000}"
}

local_code=$(probe http://localhost:8788/)
if [ "$local_code" = "000" ]; then
	echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') dev server dead — kickstarting com.schwab-mcp.dev"
	launchctl kickstart -k "$GUI/com.schwab-mcp.dev"
	sleep 15
	local_code=$(probe http://localhost:8788/)
fi

tunnel_code=$(probe "$TUNNEL_URL")
# 000 = tunnel unreachable; 502 with a healthy local server = ngrok session wedged
if [ "$tunnel_code" = "000" ] || { [ "$tunnel_code" = "502" ] && [ "$local_code" != "000" ]; }; then
	echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') tunnel unhealthy (local=$local_code tunnel=$tunnel_code) — kickstarting com.schwab-mcp.ngrok"
	launchctl kickstart -k "$GUI/com.schwab-mcp.ngrok"
fi

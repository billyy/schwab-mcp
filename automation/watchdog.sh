#!/bin/bash
# Health watchdog for the Schwab MCP stack (invoked by launchd every 5 min).
# KeepAlive only restarts processes that EXIT — wrangler dev can wedge with
# its root process alive but the port dead, which this catches.
#
# It also watches the Desktop(mcp-remote) -> worker OAuth leg, which nothing
# else notices: when that grant dies, mcp-remote deletes its own token file and
# Claude Desktop just fails to connect until a human runs the re-auth by hand.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "${SCRIPT_DIR}/env.sh"

GUI="gui/$(id -u)"
TUNNEL_URL="${WORKER_URL}/"
# Re-auth drives a real Schwab login and costs an MFA text, so never retry it
# on the watchdog's own 5-minute cadence.
MCP_AUTH_COOLDOWN_SECONDS="${MCP_AUTH_COOLDOWN_SECONDS:-21600}" # 6 hours
MCP_AUTH_MAX_FAILURES="${MCP_AUTH_MAX_FAILURES:-3}"

log() {
	echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') $*"
}

probe() {
	# curl -w prints "000" itself when the connection fails
	local code
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
		-H 'ngrok-skip-browser-warning: 1' "$1" 2>/dev/null)
	echo "${code:-000}"
}

local_code=$(probe "${LOCAL_URL}/")
if [ "$local_code" = "000" ]; then
	log "dev server dead — kickstarting com.schwab-mcp.dev"
	launchctl kickstart -k "$GUI/com.schwab-mcp.dev"
	sleep 15
	local_code=$(probe "${LOCAL_URL}/")
fi

tunnel_code=$(probe "$TUNNEL_URL")
# 000 = tunnel unreachable; 502 with a healthy local server = ngrok session wedged
if [ "$tunnel_code" = "000" ] || { [ "$tunnel_code" = "502" ] && [ "$local_code" != "000" ]; }; then
	log "tunnel unhealthy (local=$local_code tunnel=$tunnel_code) — kickstarting com.schwab-mcp.ngrok"
	launchctl kickstart -k "$GUI/com.schwab-mcp.ngrok"
fi

# --- Desktop(mcp-remote) -> worker MCP leg ----------------------------------

# Only meaningful when the stack underneath is actually up, otherwise we would
# blame the MCP grant for a dead tunnel.
if [ "$local_code" = "000" ] || [ "$tunnel_code" = "000" ]; then
	exit 0
fi

# mcp-remote deletes its own token file when the grant is rejected, so a missing
# file IS the failure signal. Resolve the path rather than hardcoding it: the
# directory name tracks an internal mcp-remote version constant.
if node "${SCRIPT_DIR}/mcpRemotePaths.mjs" --tokens-file "$MCP_URL" >/dev/null 2>&1; then
	# Healthy — clear any failure bookkeeping from a previous outage.
	rm -f "$MCP_AUTH_FAIL_COUNT"
	exit 0
fi

mkdir -p "$SCHWAB_AUTH_DIR"

fails=$(cat "$MCP_AUTH_FAIL_COUNT" 2>/dev/null || echo 0)
if [ "$fails" -ge "$MCP_AUTH_MAX_FAILURES" ]; then
	log "MCP token missing but re-auth has failed ${fails}x — not retrying (clear ${MCP_AUTH_FAIL_COUNT} to resume)"
	exit 0
fi

now=$(date +%s)
last=$(cat "$MCP_AUTH_ATTEMPT_STAMP" 2>/dev/null || echo 0)
if [ $((now - last)) -lt "$MCP_AUTH_COOLDOWN_SECONDS" ]; then
	log "MCP token missing; last re-auth attempt $(( (now - last) / 60 ))m ago — within cooldown, skipping"
	exit 0
fi

log "MCP token missing — requesting re-auth via com.schwab-mcp.refresh"
echo "$now" > "$MCP_AUTH_ATTEMPT_STAMP"
touch "$MCP_AUTH_REQUEST_FLAG"
# Run it through the refresh job rather than directly: that job's launchd
# program is the app bundle holding Full Disk Access, which auto-MFA needs.
launchctl kickstart -k "$GUI/com.schwab-mcp.refresh"
osascript -e 'display notification "Claude Desktop lost its Schwab MCP authorization — re-authorizing automatically." with title "Schwab MCP"' || true

#!/bin/bash
# Retry + notify wrapper around the browser OAuth automation (invoked by launchd).
#
# Runs two phases against the two INDEPENDENT OAuth legs:
#
#   Phase 1 (always)  Schwab -> worker token. Schwab refresh tokens hard-expire
#                     after 7 days, so this runs twice weekly on a calendar.
#   Phase 2 (on flag) Desktop(mcp-remote) -> worker MCP grant. Normally never
#                     needed — mcp-remote refreshes itself — so it runs only
#                     when the watchdog drops MCP_AUTH_REQUEST_FLAG after
#                     detecting the token file is gone.
#
# Behavior:
#   - Pre-flight: checks Full Disk Access and that the Worker is reachable
#   - Retries phase 1 up to MAX_ATTEMPTS times, RETRY_DELAY seconds apart
#   - MFA short-circuit: an "MFA prompted" failure stops retries immediately
#     (only a headed run can re-seed the trusted-device cookie)
#   - Posts a macOS notification on final failure; silent on success
#   - Holds a lock on the shared Chromium profile: both phases drive the same
#     ~/.schwab-mcp-auth/profile and Playwright fails on a profile already in use
#
# Env overrides (mainly for testing):
#   WORKER_URL   Worker base URL (default: see env.sh)
#   MAX_ATTEMPTS default 3
#   RETRY_DELAY  seconds between attempts, default 300
#   FORCE_MCP_AUTH=1  run phase 2 even without the flag file

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "${SCRIPT_DIR}/env.sh"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
RETRY_DELAY="${RETRY_DELAY:-300}"
PROFILE_LOCK="${SCHWAB_AUTH_DIR}/.profile.lock"

log() {
	echo "[run-refresh] $(date '+%Y-%m-%d %H:%M:%S') $*"
}

notify() {
	local message="$1"
	osascript -e "display notification \"${message}\" with title \"Schwab MCP token refresh\" sound name \"Basso\"" || true
}

worker_reachable() {
	curl -sf -o /dev/null --max-time 15 \
		-H 'ngrok-skip-browser-warning: 1' \
		"${WORKER_URL}/" && return 0
	# Any HTTP response (even 4xx) means the tunnel + worker are up; curl -f
	# fails on 4xx, so retry without -f and check we got *some* status code.
	# (curl -w prints "000" itself when the connection fails.)
	local code
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
		-H 'ngrok-skip-browser-warning: 1' "${WORKER_URL}/" 2>/dev/null)
	[ -n "$code" ] && [ "$code" != "000" ]
}

cd "$SCRIPT_DIR" || exit 1
mkdir -p "$SCHWAB_AUTH_DIR"

# Fast pre-flight: MFA auto-entry needs to read the Messages DB. Verify TCC
# access up front so a permission problem fails in seconds, not after a full
# browser flow + wasted SMS.
if /usr/bin/sqlite3 -readonly "$HOME/Library/Messages/chat.db" "SELECT count(*) FROM sqlite_master;" >/dev/null 2>&1; then
	log "Messages DB readable — MFA auto-entry available"
else
	log "Messages DB NOT readable (Full Disk Access missing for this process tree)"
	notify "Refresh blocked: no Full Disk Access to read MFA codes. Fix FDA for SchwabRefresh.app"
	exit 1
fi

# Serialize browser automation: a manual `npm run refresh` racing the launchd
# job would otherwise fail on the in-use profile directory. shlock handles a
# stale lock left by a killed process.
if ! /usr/bin/shlock -f "$PROFILE_LOCK" -p $$; then
	log "another browser automation run holds the profile lock — exiting"
	exit 0
fi
trap 'rm -f "$PROFILE_LOCK"' EXIT

# --- Phase 1: Schwab -> worker token ---------------------------------------

schwab_refresh() {
	local attempt=1 output status
	while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
		log "attempt ${attempt}/${MAX_ATTEMPTS} (worker=${WORKER_URL})"

		if ! worker_reachable; then
			log "worker unreachable — is ngrok/wrangler dev running?"
		else
			output=$(WORKER_URL="$WORKER_URL" npm run refresh 2>&1)
			status=$?
			echo "$output"

			if [ "$status" -eq 0 ]; then
				log "refresh succeeded on attempt ${attempt}"
				return 0
			fi

			if echo "$output" | grep -q 'MFA prompted'; then
				log "MFA required — retries will not help"
				notify "MFA required. Run: cd automation && HEADED=1 npm run refresh"
				return 1
			fi

			log "refresh failed (exit ${status})"
		fi

		if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
			log "sleeping ${RETRY_DELAY}s before retry"
			sleep "$RETRY_DELAY"
		fi
		attempt=$((attempt + 1))
	done

	log "all ${MAX_ATTEMPTS} attempts failed"
	notify "Token refresh failed ${MAX_ATTEMPTS}x. Check ngrok/wrangler dev, then see ~/Library/Logs/schwab-mcp-refresh.log"
	return 1
}

schwab_refresh
schwab_status=$?

# --- Phase 2: Desktop(mcp-remote) -> worker MCP grant -----------------------

if [ ! -f "$MCP_AUTH_REQUEST_FLAG" ] && [ "${FORCE_MCP_AUTH:-0}" != "1" ]; then
	exit "$schwab_status"
fi

if [ "$schwab_status" -ne 0 ]; then
	# Phase 2 needs the same Schwab login phase 1 just failed at — attempting it
	# would only burn another MFA text. Leave the flag set for the next run.
	log "MCP re-auth requested but the Schwab refresh failed — deferring"
	exit "$schwab_status"
fi

log "MCP re-auth requested (flag=${MCP_AUTH_REQUEST_FLAG})"
if WORKER_URL="$WORKER_URL" MCP_URL="$MCP_URL" npm run mcp-auth 2>&1; then
	log "MCP re-auth succeeded"
	rm -f "$MCP_AUTH_REQUEST_FLAG" "$MCP_AUTH_FAIL_COUNT"
	notify "Claude Desktop's Schwab connection was re-authorized. Restart Claude Desktop to pick it up."
else
	fails=$(( $(cat "$MCP_AUTH_FAIL_COUNT" 2>/dev/null || echo 0) + 1 ))
	echo "$fails" > "$MCP_AUTH_FAIL_COUNT"
	log "MCP re-auth failed (consecutive failures: ${fails})"
	notify "Claude Desktop MCP re-auth failed (${fails}x). See ~/Library/Logs/schwab-mcp-refresh.log"
	exit 1
fi

exit "$schwab_status"

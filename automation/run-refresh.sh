#!/bin/bash
# Retry + notify wrapper around the Schwab OAuth refresh (invoked by launchd).
#
# Behavior:
#   - Pre-flight: checks the Worker is reachable before attempting a run
#   - Retries up to MAX_ATTEMPTS times, RETRY_DELAY seconds apart
#   - MFA short-circuit: an "MFA prompted" failure stops retries immediately
#     (only a headed run can re-seed the trusted-device cookie)
#   - Posts a macOS notification on final failure; silent on success
#
# Env overrides (mainly for testing):
#   WORKER_URL   Worker base URL (default: ngrok tunnel)
#   MAX_ATTEMPTS default 3
#   RETRY_DELAY  seconds between attempts, default 300

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_URL="${WORKER_URL:-https://obsolescent-corporately-easter.ngrok-free.dev}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
RETRY_DELAY="${RETRY_DELAY:-300}"

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

attempt=1
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
			exit 0
		fi

		if echo "$output" | grep -q 'MFA prompted'; then
			log "MFA required — retries will not help"
			notify "MFA required. Run: cd automation && HEADED=1 npm run refresh"
			exit 1
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
exit 1

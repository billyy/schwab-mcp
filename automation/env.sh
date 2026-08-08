#!/bin/bash
# Shared configuration for the automation scripts. Source it, don't execute it:
#   source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
#
# WORKER_URL must be byte-identical everywhere: mcp-remote keys its stored OAuth
# tokens by md5 of the exact server URL string, so a trailing slash or a changed
# hostname silently orphans the saved token and forces a browser re-auth.
# An already-set WORKER_URL (launchd plist, manual test) always wins.

# launchd gives agents a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin) unless the
# plist overrides it, and the watchdog plist does not — without this, `node`
# and `npm` are simply not found and the checks below fail silently.
case ":${PATH}:" in
	*:/opt/homebrew/bin:*) ;;
	*) export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}" ;;
esac

export WORKER_URL="${WORKER_URL:-https://obsolescent-corporately-easter.ngrok-free.dev}"

# The MCP endpoint Claude Desktop connects to. Keep in sync with the `schwab`
# entry in ~/Library/Application Support/Claude/claude_desktop_config.json.
export MCP_URL="${MCP_URL:-${WORKER_URL}/mcp}"

# Pinned so an npx upgrade can't rename mcp-remote's state directory (its
# directory name tracks an internal constant) and lose the stored token.
export MCP_REMOTE_VERSION="${MCP_REMOTE_VERSION:-0.1.38}"

# Local wrangler dev origin, used for health probes.
export LOCAL_URL="${LOCAL_URL:-http://localhost:8788}"

# State/flag files shared between the watchdog and the refresh wrapper.
export SCHWAB_AUTH_DIR="${SCHWAB_AUTH_DIR:-$HOME/.schwab-mcp-auth}"
export MCP_AUTH_REQUEST_FLAG="${SCHWAB_AUTH_DIR}/.request-mcp-auth"
export MCP_AUTH_ATTEMPT_STAMP="${SCHWAB_AUTH_DIR}/.mcp-auth-last-attempt"
export MCP_AUTH_FAIL_COUNT="${SCHWAB_AUTH_DIR}/.mcp-auth-fail-count"

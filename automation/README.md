# Two OAuth legs — read this first

Almost every "Claude Desktop can't connect" incident starts with confusing these:

| Leg | Credential lives in | Kept alive by |
| --- | --- | --- |
| **Schwab → worker** | KV `token:<schwabUserId>` | `refresh.ts`, twice weekly (below) |
| **Desktop (`mcp-remote`) → worker** | `~/.mcp-auth/mcp-remote-*/<md5>_tokens.json` | itself — see below |

They fail independently. The twice-weekly job renews **only** the Schwab leg;
it deliberately discards the MCP authorization code it receives
(`refresh.ts`, "not exchanged").

The MCP leg needs no automation in normal operation: the worker issues a
rotating refresh token that never expires, and `mcp-remote` exchanges it
automatically whenever it gets a 401. It only breaks if the *grant* is
destroyed — revoked, KV wiped, or the tunnel URL changed (the URL is hashed
into `mcp-remote`'s state filename, so a new URL orphans the old token).

> Historical note: a `clearStaleGrant()` in `src/index.ts` used to delete the
> MCP grant whenever the Schwab token happened to be stale. Because grant
> deletion is irreversible, a *transient* Schwab gap (Mac off over a weekend, a
> failed run) permanently broke Claude Desktop long after the Schwab side had
> healed — and the only recovery was a hand-run `npx mcp-remote`. That function
> is gone; do not reintroduce a dependency between the two legs.

When the MCP leg does die, `watchdog.sh` notices within 5 minutes (the token
file is missing), drops `~/.schwab-mcp-auth/.request-mcp-auth`, and kickstarts
the refresh job, whose phase 2 runs `mcp-auth.ts` to re-authorize unattended.
Restart Claude Desktop afterwards to pick up the new token.

Manual equivalent, if you ever want to force it:

```bash
cd automation && FORCE_MCP_AUTH=1 npm run mcp-auth
```

`mcp-auth.ts` is idempotent — it probes the stored token first and exits in
about a second when it still works.

# Schwab MCP stack services (launchd)

Four LaunchAgents keep the stack alive across reboots and crashes:

| Agent | Runs | Trigger |
| --- | --- | --- |
| `com.schwab-mcp.dev` | `npm run dev` (wrangler dev :8788) | login + KeepAlive |
| `com.schwab-mcp.ngrok` | ngrok tunnel → :8788 | login + KeepAlive |
| `com.schwab-mcp.watchdog` | `watchdog.sh` health check | every 5 min |
| `com.schwab-mcp.refresh` | Schwab token refresh (below), plus MCP re-auth when flagged | Wed + Sun 03:00, or kickstarted by the watchdog |

The watchdog exists because KeepAlive only restarts processes that *exit* —
wrangler dev can wedge with its root process alive but the port dead. It
curls both `localhost:8788` and the tunnel, kickstarts whichever layer is
unhealthy, and then checks the MCP leg's token file (only when the stack
below it is healthy, so a dead tunnel is never misread as a dead grant).
Logs: `~/Library/Logs/schwab-mcp-{dev,ngrok,watchdog}.log`.

Re-auth costs a real Schwab login and an MFA text, so the watchdog will not
retry it on its 5-minute cadence: attempts are spaced ≥6h
(`MCP_AUTH_COOLDOWN_SECONDS`) and stop entirely after 3 consecutive failures
(`MCP_AUTH_MAX_FAILURES`). Clear `~/.schwab-mcp-auth/.mcp-auth-fail-count` to
resume after fixing the underlying problem.

Shared config lives in `env.sh` (`WORKER_URL`, `MCP_URL`, state-file paths) —
`WORKER_URL` must stay byte-identical everywhere, because `mcp-remote` keys its
stored token by md5 of the exact URL string. `mcpRemotePaths.mjs` resolves that
hashed path for both the TS and shell callers; never hardcode
`mcp-remote-<version>`, since that directory name tracks an internal constant
that lags the published version (0.1.38 writes to `mcp-remote-0.1.37`). The
Desktop config pins `mcp-remote@0.1.38` for the same reason.

Install any of them with:

```bash
cp com.schwab-mcp.<name>.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.schwab-mcp.<name>.plist
```

# Schwab OAuth twice-weekly refresh

Browser automation that drives the Worker's OAuth flow end-to-end so the
Schwab refresh token in KV stays fresh. Schwab refresh tokens expire after
7 days and cannot be silently renewed — this just automates the click-through.

Runs **Sunday and Wednesday at 03:00** via launchd. Two slots per 7-day
window means one failed run (Mac off, tunnel down) doesn't expire the token.

**MFA is fully automated.** This account requires a security code on every
login; the script clicks "Text me", reads the incoming code from the local
Messages database (`~/Library/Messages/chat.db`, Schwab short code 87047),
types it in, and continues. Requires iPhone→Mac text forwarding and Full
Disk Access (below).

`run-refresh.sh` wraps the refresh with:
- a pre-flight Messages-DB access check (fails in seconds if FDA is missing)
- a pre-flight reachability check on the Worker (catches ngrok/wrangler being down)
- up to 3 attempts, 5 minutes apart
- a macOS notification on final failure — silent when it succeeds

## Full Disk Access (required for auto-MFA)

macOS attributes file permissions to the *program binary*, so the launchd job
runs through `SchwabRefresh2.app` (a compiled AppleScript applet that execs
`run-refresh.sh`). Grant it FDA once:
**System Settings → Privacy & Security → Full Disk Access → + → ⌘⇧G →**
`/Users/Billy/git/schwab-mcp/automation/SchwabRefresh2.app` → toggle on.

If the app bundle is ever rebuilt/re-signed, macOS may cling to the stale
grant for the old identity — rename the bundle (bump the version suffix),
update the plist path, and grant the new name.

The bundle is generated (git-ignored). To rebuild it:

```bash
cat > /tmp/schwab-refresh.applescript <<'EOF'
do shell script "/Users/Billy/git/schwab-mcp/automation/run-refresh.sh >> /Users/Billy/Library/Logs/schwab-mcp-refresh.log 2>&1"
EOF
osacompile -o SchwabRefresh2.app /tmp/schwab-refresh.applescript
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.schwab-mcp.refresh-app-v2" SchwabRefresh2.app/Contents/Info.plist
codesign --force -s - SchwabRefresh2.app
```

## How it works

1. DCR a fresh MCP client against the Worker (`POST /register`).
2. Open Chromium (persistent profile = trusted device cookie) → `/authorize`.
3. Click Approve on the consent screen.
4. Worker redirects to Schwab → script fills creds from macOS Keychain.
5. Schwab redirects back to `/callback` → **Worker writes `token:<schwabUserId>` to KV**.
6. Worker redirects to `localhost:8765/done` → script sees the URL and exits.

The MCP-side token at the `localhost` callback is discarded; only the
Schwab-side KV write matters.

## One-time setup

```bash
# 1. Install deps
cd automation
npm install
npm run install:browsers

# 2. Stash creds in macOS Keychain
security add-generic-password -s schwab-mcp -a username -w '<your-schwab-username>'
security add-generic-password -s schwab-mcp -a password -w '<your-schwab-password>'

# 3. First run — headed, to complete MFA and seed the trusted-device cookie
HEADED=1 npm run refresh
# Walk through MFA in the browser. Persistent profile lives in
# ~/.schwab-mcp-auth/profile so the next run won't be prompted.

# 4. Verify headless works
npm run refresh
```

## Schedule with launchd

```bash
cp com.schwab-mcp.refresh.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.schwab-mcp.refresh.plist

# Test it now without waiting for the next scheduled slot
launchctl kickstart -k gui/$(id -u)/com.schwab-mcp.refresh

# Tail logs
tail -f ~/Library/Logs/schwab-mcp-refresh.log

# Unload
launchctl bootout gui/$(id -u)/com.schwab-mcp.refresh
```

## Configuration

Override the Worker URL via env var:

```bash
WORKER_URL=https://your-worker.workers.dev npm run refresh
```

For launchd, edit the `WORKER_URL` value in the plist before bootstrapping.

## When MFA re-prompts

Schwab's trusted-device cookie eventually expires (~30 days, sometimes
sooner if Schwab invalidates it). The headless run will fail with
"MFA prompted but running headless" — re-run `HEADED=1 npm run refresh`
once interactively to re-seed.

## Caveats

- **ngrok must be up.** If the tunnel is down at a scheduled run, the
  wrapper retries 3× and then posts a macOS notification. Consider
  deploying to a real Cloudflare URL if reliability matters.
- **Schwab TOS.** Automated login is in a gray area. This is your account,
  but accept the risk.
- **Bot detection.** Stealth plugin handles most of it. If Schwab starts
  showing CAPTCHAs, this approach is dead and you're back to manual.

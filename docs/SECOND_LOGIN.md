# Running a second Schwab login

Two different meanings of "a second account" — only one of them needs this doc.

**A second account under your existing Schwab login** (another brokerage
account on the same credentials) needs nothing. `getAccounts` returns every
account on the login and `resolveAccountHash()` accepts any of them; that is
already how the drift task handles Partnership and CRT together. Just pass the
account number.

**A second Schwab _login_** (someone else's own credentials — a spouse,
say) must run as a separate instance. This doc is that setup.

## Why it cannot share the primary instance

Tokens in KV are keyed by `schwabUserId`, which **rotates on every re-auth**.
To survive that rotation, both token consumers fall back to
`kvTokenStore.loadFreshest()`:

- `src/index.ts` — the MCP session loader, when its own key is empty or stale
- `src/orders/core.ts` — `buildClient()`, on alias-key miss and on failed init

`loadFreshest()` scans every `token:*` key and returns the newest one **without
regard to which Schwab login owns it**. That is correct and necessary for one
login. With two logins in one KV namespace it becomes a cross-account hazard:

- Whoever authenticated most recently owns the "freshest" token.
- A stale-key miss on the primary can therefore adopt the *other* login's
  token. Because `schwabUserId` rotates routinely, that fallback path is hit in
  normal operation, not just in edge cases.
- On the MCP side that means one person's session can surface the other
  person's accounts.
- On the orders side `resolveAccountHash()` limits the damage to a hard 400
  (an account number from one login never matches the other), but the drift
  pipeline still breaks confusingly right after either party re-auths.
- `ORDER_DAILY_CAP` is a single global KV counter, not per-login.

**The isolation boundary is a separate KV namespace and a separate
`--persist-to` directory.** Do not put a second login's tokens in the primary
instance's KV.

## Setup

The `secondary` environment is preconfigured for a **read-only** instance: it
can read accounts, positions, and quotes, and it cannot trade.

1. **Register the callback.** In the Schwab developer portal, add
   `http://localhost:8789/callback` to your app's redirect URIs. One Schwab
   developer app can authorize multiple logins, so no second app is needed —
   but the callback URL must be registered or the OAuth flow fails.

2. **Create the secrets file.**

   ```bash
   cp .dev.vars.secondary.example .dev.vars.secondary
   ```

   Fill in `SCHWAB_CLIENT_ID` / `SCHWAB_CLIENT_SECRET` (same values as the
   primary — same app) and generate a **fresh** cookie key:

   ```bash
   openssl rand -hex 32
   ```

   `.dev.vars.*` is git-ignored (the `*.example` templates are not).

3. **Keep the read-only line.** `.dev.vars.secondary` must contain:

   ```
   ENABLED_TOOLS=-placeOrder,-cancelOrder
   ```

   This is not optional and it is not the default. `placeOrder` and
   `cancelOrder` are **core** tools, meaning they are enabled when
   `ENABLED_TOOLS` is unset. Delete that line and the instance can trade.

4. **Leave `ORDER_API_KEY` and `SCHWAB_USER_ID` unset.** `/orders`,
   `/proposals`, `/rebalance/snapshot`, and `/slack/notify` each return 503
   unless both are present, which keeps the entire LLM-free trading surface
   off.

5. **Run it**, alongside the primary:

   ```bash
   npm run dev:secondary
   ```

   Port 8789, KV namespace id distinct from the primary's, state under
   `.wrangler/state-secondary/`.

6. **She completes the OAuth herself**, in a browser, at
   `http://localhost:8789/sse` via an MCP client. Nobody else should enter
   another person's brokerage credentials on their behalf.

## Verifying the isolation

```bash
# Trading surface off (expect 503 on all four)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8789/orders
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8789/proposals
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8789/slack/notify
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:8789/rebalance/snapshot?accounts=1'

# Separate KV state on disk
ls .wrangler/state/v3/kv .wrangler/state-secondary/v3/kv
```

On startup wrangler prints `Using vars defined in .dev.vars.secondary` — it
*replaces* `.dev.vars` rather than merging, so the primary's order and Slack
secrets are not visible to this instance. Confirm that line appears.

## If the second login later wants the automated pipeline

Adding `ORDER_API_KEY`, `SCHWAB_USER_ID`, and the `SLACK_*` secrets to
`.dev.vars.secondary` turns on the order path for that instance, with its own
KV — so its own daily cap, audit log, and duplicate detection. It also needs
its own Slack channel and approver allowlist, its own scheduled tasks, and
`ENABLED_TOOLS` reconsidered. That is a deliberate, separate decision; the
read-only default above is the safe starting point.

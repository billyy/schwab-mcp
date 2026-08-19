# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Model Context Protocol (MCP) server** deployed on **Cloudflare Workers** that enables AI assistants to interact with Charles Schwab accounts through the official Schwab API. It uses OAuth 2.0 with PKCE for authentication and Durable Objects for session state management.

**Key Dependencies:**
- `@sudowealth/schwab-api` - Type-safe Schwab API client
- `@modelcontextprotocol/sdk` - MCP framework
- `workers-mcp` - Cloudflare Workers adapter for MCP
- `@cloudflare/workers-oauth-provider` - OAuth 2.0 provider
- `hono` - HTTP routing framework

## Common Commands

### Development
```bash
npm install              # Install dependencies
npm run dev             # Start local dev server on http://localhost:8788
npm run typecheck       # Run TypeScript type checking
npm run lint            # Run ESLint
npm run format          # Format code with Prettier
npm run validate        # Run typecheck + lint (used in CI)
```

### Deployment
```bash
npx wrangler login      # Authenticate with Cloudflare (first time only)
npm run deploy          # Deploy to Cloudflare Workers
```

### MCP Inspector (Testing)
```bash
npm run inspect         # Launch MCP Inspector for local testing
# Local dev: Connect to http://localhost:8788/sse
# Production: Connect to https://your-worker.workers.dev/sse

# Quick OAuth test helper
./test-oauth.sh         # Run OAuth testing checklist
```

### Cloudflare KV Management
```bash
npx wrangler kv:namespace create "OAUTH_KV"          # Create KV namespace
npx wrangler kv:key list --namespace-id=<ID>        # List stored tokens
npx wrangler secret put SCHWAB_CLIENT_ID             # Set secrets
npx wrangler secret list                             # List configured secrets
```

## Architecture

### Core Architecture: OAuth + Durable Objects + KV

The server uses a three-layer architecture:

1. **OAuth Layer** (`src/auth/`)
   - Entry point: `OAuthProvider` in `src/index.ts`
   - Routes handled by `SchwabHandler` (Hono app in `src/auth/handler.ts`)
   - Flow: `/authorize` → Schwab OAuth → `/callback` → Token exchange

2. **Durable Object Layer** (`MyMCP` class in `src/index.ts`)
   - One Durable Object instance per user session
   - Manages `EnhancedTokenManager` lifecycle
   - Handles MCP tool registration and execution
   - Stores only token identifiers in DO props (`schwabUserId`, `clientId`)

3. **KV Storage Layer** (`src/shared/kvTokenStore.ts`)
   - **Single source of truth** for OAuth tokens
   - Tokens stored by `schwabUserId` (preferred) or `clientId` (fallback)
   - Auto-migration from `clientId` to `schwabUserId` keys
   - 31-day TTL for token persistence

### OAuth Flow Details

**Authorization Flow:**
1. Client requests `/authorize` with MCP client info
2. Shows approval dialog or redirects to Schwab (if previously approved)
3. User approves → POST `/authorize` → redirect to Schwab with PKCE state
4. Schwab redirects to `/callback` with authorization code
5. Exchange code for tokens via `EnhancedTokenManager.exchangeCode()`
6. Fetch user preferences to get `schwabUserId`
7. Store token in KV under `schwabUserId` key
8. Complete OAuth flow, return to MCP client

**State Parameter:**
- Contains entire `AuthRequest` object (encoded/signed)
- Includes PKCE `code_verifier` for token exchange
- Validated with HMAC-SHA256 signature

**Token Management:**
- `EnhancedTokenManager` handles refresh (5 min before expiration)
- Tokens loaded/saved via KV store exclusively (no DO storage)
- Migration from `clientId` to `schwabUserId` keys happens automatically

### Tool Architecture

**Tool Registration:** (`src/tools/`)
- Tools split into `trader` (accounts, orders, transactions) and `market` (quotes, instruments, options)
- Each tool defined with `createToolSpec()` helper
- Filtered and registered in `MyMCP.init()` based on `ENABLED_TOOLS` config
- Tools receive `SchwabApiClient` instance with authenticated session

**Tool Filtering:** (`src/tools/config.ts`)
- Configure which tools are enabled to reduce MCP context usage
- Set via `ENABLED_TOOLS` environment variable
- Core tools (enabled by default): `getAccounts`, `getAccount`, `getQuotes`, `getPriceHistory`, `getOptionChain`, `placeOrder`, `getOrders`, `cancelOrder`
- Extended tools (disabled by default): `getAccountNumbers`, `getUserPreference`, `getOrdersByAccountNumber`, `getOrder`, `replaceOrder`, `getTransactions`, `getTransaction`, `getQuoteBySymbolId`, `searchInstruments`, `getInstrumentByCusip`, `getMarketHours`, `getMarketHoursByMarketId`, `getMovers`, `getOptionExpirationChain`
- Options: `"core"` (default), `"all"`, `"tool1,tool2"`, `"+tool1"` (add to core), `"-tool1"` (remove from core)

**Tool Pattern:**
```typescript
createToolSpec({
  name: 'getAccounts',
  description: 'Get accounts',
  schema: GetAccountsParams,  // Zod schema from @sudowealth/schwab-api
  call: async (client, params) => {
    const data = await client.trader.accounts.getAccounts(params)
    return scrubAccountIdentifiers(data, displayMap)
  }
})
```

**Account Scrubbing:**
- All responses automatically scrub sensitive account numbers
- Uses `buildAccountDisplayMap()` and `scrubAccountIdentifiers()` from SDK
- Replaces account numbers with display names (e.g., "Individual-...123")

### Configuration & Environment

**Required Secrets:**
- `SCHWAB_CLIENT_ID` - Schwab app key
- `SCHWAB_CLIENT_SECRET` - Schwab app secret
- `SCHWAB_REDIRECT_URI` - OAuth callback URL (e.g., `https://worker.workers.dev/callback`)
- `COOKIE_ENCRYPTION_KEY` - AES-256 key for cookie encryption (generate: `openssl rand -hex 32`)

**Optional Environment Variables:**
- `LOG_LEVEL` - `trace|debug|info|warn|error|fatal` (default: `info`)
- `ENVIRONMENT` - `development|staging|production` (default: `production`)
- `ENABLED_TOOLS` - Tool filtering: `core` (default), `all`, `tool1,tool2`, `+tool1`, `-tool1`

**Configuration Files:**
- `wrangler.example.jsonc` - Template (committed to git)
- `wrangler.jsonc` - Personal config (git-ignored, copy from example)
- `.dev.vars` - Local dev secrets (git-ignored)

**Config Validation:**
- All env vars validated with Zod schema in `src/config/appConfig.ts`
- Centralized via `getConfig(env)` function with memoization

### Logging

- Uses Pino logger (`src/shared/log.ts`)
- Scoped loggers via `.child(LOGGER_CONTEXTS.*)` pattern
- Automatic secret redaction via `secureLogger.ts`
- Debug mode: Set `LOG_LEVEL=debug` in `.dev.vars` or via `wrangler secret`

### Key Patterns & Conventions

**Token Key Generation:**
- Prefer `schwabUserId` over `clientId` for token keys
- Format: `token:<schwabUserId>` or `token:<clientId>` (fallback)
- Managed by `KvTokenStore.kvKey()` helper

**Error Handling:**
- Auth errors: `src/auth/errors.ts` - Custom MCP error types
- Schwab SDK errors mapped to MCP errors via `src/auth/errorMapping.ts`
- All errors include request IDs for Schwab API troubleshooting

**Reconnection Handling:**
- `MyMCP.onReconnect()` attempts token manager recovery
- Falls back to full reinitialization if needed
- Triggered on SSE reconnection via `onSSE()`

## Testing OAuth Locally

### Prerequisites
1. Schwab Developer app configured with `http://localhost:8788/callback` as redirect URI
2. `.dev.vars` file created with your credentials (see `.dev.vars.example`)
3. Local KV namespace created (already exists in this project)

### Testing Steps
```bash
# 1. Start local dev server in one terminal
npm run dev

# 2. In another terminal, launch MCP Inspector
npm run inspect

# 3. Connect to: http://localhost:8788/sse
# Expected flow:
#   → Approval dialog
#   → Redirect to Schwab login (https://api.schwabapi.com/)
#   → After login, redirect to http://localhost:8788/callback
#   → Return to MCP Inspector with tools loaded

# 4. Test tools
#   - Execute 'status' tool → should return server status
#   - Execute 'getUserPreference' → verifies OAuth token works
#   - Execute 'getAccounts' → fetches account data
```

### Troubleshooting
- **"Invalid redirect_uri"**: Check Schwab app has `http://localhost:8788/callback` configured
- **"State validation failed"**: Clear cookies and try again
- **"Token exchange failed"**: Check `SCHWAB_CLIENT_SECRET` in `.dev.vars`
- **No tools visible**: Check browser console and wrangler logs for errors
- **Enable debug logging**: Set `LOG_LEVEL=debug` in `.dev.vars`

### Quick Test Script
Run `./test-oauth.sh` for a testing checklist and common issues.

## TypeScript Configuration

- Extends `@epic-web/config/typescript`
- Includes `src/**/*.ts` and `types/**/*.d.ts`
- Types for Cloudflare Workers in `types/env.ts` and `types/worker-configuration.d.ts`

## Programmatic Orders (no LLM)

`POST /orders` (`src/orders/handler.ts`) is an API-key-authed endpoint for
placing orders without any LLM, driven by `cli/schwab-order.mjs`. Preview →
confirm → submit, with server-side guardrails (symbol allowlist, max notional,
daily cap, duplicate detection, KV audit log). Disabled unless `ORDER_API_KEY`
and `SCHWAB_USER_ID` secrets are set. Docs:

- `docs/ORDER_CLI.md` — CLI setup, order JSON format, guardrails, troubleshooting
- `docs/TRADING_AGENT.md` — optional instructions for a read-only Claude agent
  that drafts order proposals for the CLI to execute

## Option trades

Option orders go through the same LLM-free path as equity, with two rules that
are structural, not stylistic:

1. **A roll is one net-priced two-leg order** (`NET_CREDIT`/`NET_DEBIT`/
   `NET_ZERO`, `BUY_TO_CLOSE` + `SELL_TO_OPEN`), never two single-leg orders.
   Two orders can half-fill; inverted, they leave the account briefly short an
   uncovered call. A net price also **requires** a real
   `complexOrderStrategyType` — `VERTICAL` (one expiry), `CALENDAR` (one
   strike), `DIAGONAL` (both differ). With `NONE` Schwab reads `price` as a
   plain limit price and rejects it with "Limit price must be populated only
   for limit orders."
2. **`checkOptionCoverage()` (`src/orders/core.ts`) is the safety net, not
   `ORDER_MAX_NOTIONAL`.** For a net-priced spread the notional is the premium
   exchanged (~$420), while the assignment exposure is the strike × 100
   (~$38,500). Only the coverage check bounds the latter. It runs at proposal
   time, at approval time, and again inside `placeOne` — the last one because
   an approval can land hours later, after the backing shares were sold. It
   fails closed, never nets long calls against short ones, and also refuses an
   equity `SELL` that would strand a short call.

### The scheduled tasks live in `tasks/`, not just on the Mac

`tasks/*.md` are the source of truth for the two Cowork jobs; the copies at
`~/.claude/scheduled-tasks/<name>/SKILL.md` are only an install of them. That
directory is outside git, so a PR changing what `drift-diff` emits cannot touch
it and nothing fails when it falls behind — PR #18 added option support across
the CLI, `/orders`, `/proposals` and the executor while the 10:00am task still
said "never build option orders", and it silently skipped a live NFLX roll the
next morning.

`npm run validate` now runs `tasks:check`, which fails when an installed task
has drifted from its repo copy (and no-ops on a machine that never installed
them, so CI is unaffected). `npm run tasks:install` symlinks them, after which
drift is impossible. **When you change what the CLI emits or what a guardrail
does, edit `tasks/*.md` in the same commit.**

`cli/drift-diff.mjs --json` emits `optionGaps[]` — priced roll plans with a
ready-to-submit `order`, or `reasons[]` explaining why a divergence is
report-only. The 10:00am propose task submits proposable rolls alongside equity,
in the same batch, by copying each entry's `order` **verbatim** — a rebuilt body
loses the `complexOrderStrategyType` the net price depends on. Option
`proposable` is stricter than the equity flag: it already folds in coverage,
roll shape, expiry, and the per-symbol halt check, so unlike equity it needs no
guard of its own, and there is no notional floor. Docs: `docs/DRIFT_APPROVAL.md`

## Drift Approval (Slack)

`POST /proposals` (`src/proposals/handler.ts`) accepts a batch of orders from
the Cowork drift task, previews them through the same guardrails, stores them
in the `ProposalStore` Durable Object, and posts a Slack message with
Approve/Reject buttons. `POST /slack/interactions`
(`src/proposals/interactions.ts`) verifies Slack's signature + approver
allowlist and executes approved batches via `src/proposals/executor.ts` —
the identical LLM-free path `/orders` uses (shared in `src/orders/core.ts`).
Disabled unless the `SLACK_*` secrets are set. Docs: `docs/DRIFT_APPROVAL.md`

## Two independent OAuth legs

Do not couple these — a bug that did cost weeks of broken Desktop connections:

1. **Schwab → worker**: token in KV (`token:<schwabUserId>`). Renewed by the
   twice-weekly `automation/` job. Staleness is handled in `loadTokenForETM()`
   and by `loadFreshest()`.
2. **Desktop (`mcp-remote`) → worker**: the OAuth-provider grant
   (`grant:<userId>:<grantId>`) plus mcp-remote's local token file. Self-heals
   forever via a rotating refresh token — *provided the grant is never deleted*.

A former `clearStaleGrant()` deleted the MCP grant whenever `loadFreshest()`
returned null. Grant deletion is irreversible (mcp-remote gets `invalid_grant`,
discards its tokens, and only an interactive browser re-auth recovers), so a
transient Schwab gap permanently broke Claude Desktop. **Never make the MCP
grant's lifetime depend on Schwab token health.** When the Schwab side is dead,
tools return `SCHWAB_AUTH_ERROR_MESSAGE` naming the recovery command instead.

Recovery for leg 2 is automated: `watchdog.sh` detects the missing token file,
flags it, and the refresh job's phase 2 runs `automation/mcp-auth.ts`.
Docs: `automation/README.md`

### A 401 on leg 2 is not a dead grant

Leg 2's token file holds two very different things: an **access token with a
one-hour TTL** and a **refresh token whose grant lives indefinitely**. Any
health check that reads a `401` as "the grant is gone" is wrong 23 hours out of
24, and being wrong here is expensive — it escalates to a full Schwab login and
an MFA text to the owner's phone for a leg that was never broken. `mcp-auth.ts`
therefore compares the token file's mtime against `expires_in` and calls that
case `aged-out`, then hands off to `mcp-remote-client`, which exchanges the
refresh token silently. Only a `401` on a token still inside its TTL, or a
missing token file, points at the grant itself. The grant's real liveness
signal is the `grant:<userId>:<grantId>` KV record, not any status code.

### Adopt on *newer*, never on *empty-or-aged-out*

`refresh.ts` performs a full re-authorization, which mints a refresh token under
a brand-new `token:<schwabUserId>` key **and revokes the previous one**. A
session's own copy is therefore routinely recent *and* dead, so token age can
never detect it. Both `loadTokenForETM()` (`src/index.ts`) and `buildClient()`
(`src/orders/core.ts`) must compare `token_ts:` mint times and adopt whenever KV
holds a **strictly newer** token — falling back only when the key is missing or
>7 days old leaves the session pinned to a revoked token until the 7-day timer
expires, which broke Desktop and the drift pipeline for a full day (2026-08-08).

For the same reason, an adopted copy **inherits the source's mint time** rather
than being stamped `now`: re-stamping resets the 7-day refresh-token clock, hides
a genuinely expiring token, and was what made the pin last a week instead of a
day.

## Second Schwab Login

A second brokerage account **on the same Schwab login** needs no setup — pass
its account number. A second Schwab **login** (someone else's credentials) must
run as its own instance: `npm run dev:secondary` (port 8789, separate KV
namespace, `.wrangler/state-secondary/`, secrets in `.dev.vars.secondary`).

This is a correctness boundary, not a preference. `loadFreshest()` returns the
newest `token:*` key regardless of which login owns it, and both the MCP
session loader (`src/index.ts`) and `buildClient()` (`src/orders/core.ts`) fall
back to it — so two logins sharing one KV can adopt each other's tokens. The
`secondary` env is read-only by default via
`ENABLED_TOOLS=-placeOrder,-cancelOrder` (note: `placeOrder`/`cancelOrder` are
core, i.e. on by default) plus unset `ORDER_API_KEY`/`SCHWAB_USER_ID`.
Docs: `docs/SECOND_LOGIN.md`

## GitHub Actions

The `.github/workflows/deploy.yml` workflow:
1. Runs validation (`npm run validate`) on all PRs
2. Auto-deploys to Cloudflare Workers on push to `main` **only when** the
   `CLOUDFLARE_API_TOKEN` and `OAUTH_KV_ID` repo secrets are set — they are
   currently NOT set, so the deploy steps skip and only validation runs.
   This deployment is local-only: `wrangler dev` behind a static ngrok
   domain is the live worker. To re-enable CI deploys, see "GitHub Actions
   Deployment" in README.md (set the two secrets; no workflow edits needed).

## Important Notes

**Durable Objects Limitation:**
- Requires Cloudflare Workers **paid plan** (not available on free tier)
- Migration tag `v1` defined in wrangler config

**Token Storage:**
- **NEVER** store tokens in Durable Object props
- KV is the single source of truth to prevent token divergence
- DO props only store `schwabUserId` and `clientId` for key derivation

**Security:**
- Account identifiers automatically scrubbed in tool responses
- Cookies encrypted with AES-256
- State parameters signed with HMAC-SHA256
- Secrets redacted from logs automatically

**Schwab API SDK:**
- Uses `@sudowealth/schwab-api` for all API interactions
- Provides type-safe schemas for all endpoints
- Handles token refresh, error mapping, and logging
- Account scrubbing utilities included

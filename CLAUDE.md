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

## GitHub Actions

The `.github/workflows/deploy.yml` workflow:
1. Runs validation (`npm run validate`) on all PRs
2. Auto-deploys to Cloudflare Workers on push to `main`
3. Requires secrets: `CLOUDFLARE_API_TOKEN`, `OAUTH_KV_ID`

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

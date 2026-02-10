# Schwab MCP Server - Architecture Documentation

## Overview

The Schwab MCP server is a **Model Context Protocol (MCP)** server deployed on **Cloudflare Workers** that enables AI assistants (like Claude) to interact with Charles Schwab brokerage accounts through the official Schwab API. It uses OAuth 2.0 with PKCE for secure authentication and Cloudflare's edge infrastructure for global availability.

## High-Level Architecture

```
┌─────────────────┐
│  MCP Client     │
│ (Claude Desktop,│
│  MCP Inspector) │
└────────┬────────┘
         │ SSE/HTTP
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│          Cloudflare Workers Environment                 │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  OAuth Provider (Hono App)                       │  │
│  │  - /authorize  (GET/POST)                        │  │
│  │  - /callback   (OAuth redirect)                  │  │
│  │  - /token      (token exchange)                  │  │
│  │  - /.well-known/oauth-authorization-server       │  │
│  └──────────────────────────────────────────────────┘  │
│                       │                                  │
│                       ▼                                  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Durable Object (MyMCP)                          │  │
│  │  - One instance per user session                 │  │
│  │  - MCP Server instance                           │  │
│  │  - EnhancedTokenManager                          │  │
│  │  - SchwabApiClient                               │  │
│  │  - Tool registration & execution                 │  │
│  └──────────────────────────────────────────────────┘  │
│                       │                                  │
│                       ▼                                  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  KV Storage (OAUTH_KV)                           │  │
│  │  - Token storage (schwabUserId/clientId keys)    │  │
│  │  - 31-day TTL                                     │  │
│  │  - Single source of truth for tokens             │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
└────────────────────────┬─────────────────────────────────┘
                         │ HTTPS
                         │
                         ▼
              ┌──────────────────────┐
              │   Schwab API          │
              │  (api.schwabapi.com)  │
              │  - Trading endpoints  │
              │  - Market data        │
              │  - Account info       │
              └──────────────────────┘
```

## Core Components

### 1. OAuth Provider (Entry Point)

**Location:** `src/index.ts` (export default), `src/auth/handler.ts`

**Responsibilities:**
- Handle OAuth 2.0 authorization flow with PKCE
- Show approval dialog for new clients
- Exchange authorization codes for access tokens
- Manage OAuth state and PKCE verification

**Key Routes:**
```
GET  /authorize               → Show approval dialog or redirect to Schwab
POST /authorize               → Process approval, redirect to Schwab
GET  /callback                → Handle Schwab OAuth redirect
POST /token                   → Exchange code for access token
GET  /.well-known/oauth-*     → OAuth discovery metadata
GET  /sse                     → MCP SSE connection (requires auth)
```

**Implementation:**
- Uses `@cloudflare/workers-oauth-provider` for OAuth protocol
- Hono app for HTTP routing
- Encrypted cookies for approval state
- HMAC-signed state parameters

### 2. Durable Object (MyMCP)

**Location:** `src/index.ts` (class MyMCP)

**Responsibilities:**
- One instance per user session (isolated state)
- Host MCP Server instance
- Manage Schwab API client lifecycle
- Store token identifiers (NOT tokens themselves)
- Handle tool registration and execution
- Reconnection recovery

**State Management:**
```typescript
type MyMCPProps = {
  schwabUserId?: string   // Preferred token key
  clientId?: string       // Fallback token key
}
```

**Key Properties:**
- `tokenManager: EnhancedTokenManager` - Handles token refresh
- `client: SchwabApiClient` - Schwab API interactions
- `server: McpServer` - MCP protocol handler
- `props: MyMCPProps` - Durable Object persistent state

**Lifecycle:**
1. `init()` - Initialize on first connection
2. `onReconnect()` - Restore state on reconnection
3. Tool execution via MCP protocol

### 3. KV Token Store

**Location:** `src/shared/kvTokenStore.ts`

**Responsibilities:**
- **Single source of truth** for OAuth tokens
- Store access tokens, refresh tokens, expiration
- Auto-migration from `clientId` to `schwabUserId` keys
- 31-day TTL for token persistence

**Storage Schema:**
```
Key Format: token:<schwabUserId> or token:<clientId>

Value: {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: "Bearer"
  scope: string
  id_token?: string
}
```

**Migration Pattern:**
```
Old key: token:<clientId>
New key: token:<schwabUserId>

On token load:
1. Try schwabUserId key first
2. Fall back to clientId key
3. If found via clientId, migrate to schwabUserId
4. Delete old clientId key
```

### 4. Enhanced Token Manager

**Location:** `@sudowealth/schwab-api` package

**Responsibilities:**
- Load tokens from KV store
- Automatic token refresh (5 min before expiration)
- Save refreshed tokens back to KV
- Handle token exchange during OAuth

**Token Refresh Flow:**
```
┌─────────────────┐
│ API Call Needed │
└────────┬────────┘
         │
         ▼
   ┌──────────────┐
   │ Token Valid? │
   └──┬────────┬──┘
      │ Yes    │ No (expires in <5min)
      │        │
      │        ▼
      │   ┌────────────────┐
      │   │ Refresh Token  │
      │   │ via Schwab API │
      │   └───────┬────────┘
      │           │
      │           ▼
      │   ┌────────────────┐
      │   │  Save to KV    │
      │   └───────┬────────┘
      │           │
      └───────────┘
              │
              ▼
      ┌──────────────┐
      │ Execute API  │
      │    Call      │
      └──────────────┘
```

### 5. MCP Tools

**Location:** `src/tools/trader/*.ts`, `src/tools/market/*.ts`

**Organization:**
- **Trader Tools** - Account management, orders, transactions
- **Market Tools** - Quotes, instruments, options chains, movers

**Tool Pattern:**
```typescript
createToolSpec({
  name: 'getAccounts',
  description: 'Retrieve Schwab brokerage accounts',
  schema: GetAccountsParams,  // Zod schema
  call: async (client, params) => {
    const data = await client.trader.accounts.getAccounts(params)
    return scrubAccountIdentifiers(data, displayMap)
  }
})
```

**Account Scrubbing:**
- All account numbers replaced with display names
- Format: "Individual-...123", "IRA-...456"
- Uses `buildAccountDisplayMap()` from SDK
- Prevents leaking sensitive account identifiers

## OAuth 2.0 Flow (Detailed)

### Initial Authorization

```
┌─────────┐                                    ┌──────────┐
│   MCP   │                                    │  Worker  │
│ Client  │                                    │  (OAuth) │
└────┬────┘                                    └─────┬────┘
     │                                                │
     │  1. Connect to /sse                           │
     ├──────────────────────────────────────────────►│
     │                                                │
     │  2. 401 Unauthorized                          │
     │◄──────────────────────────────────────────────┤
     │     + OAuth metadata                          │
     │                                                │
     │  3. GET /.well-known/oauth-authorization-...  │
     ├──────────────────────────────────────────────►│
     │                                                │
     │  4. OAuth metadata (authorization_endpoint)   │
     │◄──────────────────────────────────────────────┤
     │                                                │
     │  5. GET /authorize?client_id=...&state=...    │
     ├──────────────────────────────────────────────►│
     │                                                │
     │  6. Approval Dialog HTML                      │
     │◄──────────────────────────────────────────────┤
     │                                                │

     User sees approval dialog in browser

     │  7. POST /authorize (approved=true)           │
     ├──────────────────────────────────────────────►│
     │                                                │
     │  8. 302 Redirect to Schwab                    │
     │◄──────────────────────────────────────────────┤
     │     Location: https://api.schwabapi.com/...   │
     │     + code_challenge (PKCE)                   │
     │     + state (contains code_verifier)          │
     │                                                │

     User logs in to Schwab

     │  9. 302 Redirect to callback                  │
     │◄───────────────────────────────────────────────
     │     Location: https://worker.dev/callback     │
     │     + code=...&state=...                      │
     │                                                │
     │  10. GET /callback?code=...&state=...         │
     ├──────────────────────────────────────────────►│
     │                                                │
     │                                        ┌───────────────┐
     │                                        │ 11. Exchange  │
     │                                        │     code for  │
     │                                        │     tokens    │
     │                                        │     (PKCE)    │
     │                                        └───┬───────────┘
     │                                            │
     │                                            ▼
     │                                    ┌───────────────────┐
     │                                    │ 12. Fetch user    │
     │                                    │     preferences   │
     │                                    │     (schwabUserId)│
     │                                    └───┬───────────────┘
     │                                        │
     │                                        ▼
     │                                    ┌───────────────────┐
     │                                    │ 13. Store token   │
     │                                    │     in KV         │
     │                                    │     (schwabUserId)│
     │                                    └───┬───────────────┘
     │                                        │
     │  14. Success HTML (close window)       │
     │◄──────────────────────────────────────────────┤
     │                                                │
     │  15. Reconnect to /sse (with auth)            │
     ├──────────────────────────────────────────────►│
     │                                                │
     │  16. SSE stream established                   │
     │◄──────────────────────────────────────────────┤
     │     MCP tools available                       │
     │                                                │
```

### State Parameter Structure

```typescript
// State contains entire AuthRequest object
{
  clientId: string              // OAuth client ID
  redirectUri: string           // MCP client redirect
  responseType: "code"
  scope: string
  state: string                 // Client's original state
  codeChallenge: string         // PKCE challenge
  codeChallengeMethod: "S256"
  code_verifier: string         // PKCE verifier (!!!)
}

// Encoded as: base64(JSON) + HMAC signature
// Prevents tampering, includes PKCE verifier for token exchange
```

### Approval Cookie Flow

```
First visit to /authorize:
1. No approval cookie → Show approval dialog
2. User clicks "Approve"
3. POST /authorize creates encrypted cookie
4. Cookie format: { clientId, approved: true }
5. Redirect to Schwab

Future visits:
1. Cookie present → Skip approval dialog
2. Redirect directly to Schwab
3. Faster re-authentication
```

## Tool Execution Flow

```
┌─────────┐          ┌──────────┐          ┌─────────────┐
│   MCP   │          │  Durable │          │   Schwab    │
│ Client  │          │  Object  │          │     API     │
└────┬────┘          └─────┬────┘          └──────┬──────┘
     │                     │                       │
     │  1. Tool Request    │                       │
     │  (getAccounts)      │                       │
     ├────────────────────►│                       │
     │                     │                       │
     │              2. Check token                 │
     │                     │                       │
     │              3. Token valid?                │
     │                     │                       │
     │                     │  4. Load token from KV│
     │                     ├───────────────────────┤
     │                     │       (if needed)     │
     │                     │                       │
     │              5. Token expired?              │
     │                     │                       │
     │                     │  6. Refresh token     │
     │                     ├──────────────────────►│
     │                     │                       │
     │                     │  7. New tokens        │
     │                     │◄──────────────────────┤
     │                     │                       │
     │              8. Save to KV                  │
     │                     │                       │
     │                     │  9. GET /accounts     │
     │                     ├──────────────────────►│
     │                     │                       │
     │                     │  10. Account data     │
     │                     │◄──────────────────────┤
     │                     │                       │
     │              11. Scrub account IDs          │
     │                     │                       │
     │  12. Tool Response  │                       │
     │◄────────────────────┤                       │
     │  (scrubbed data)    │                       │
     │                     │                       │
```

## Data Storage Architecture

### Token Storage Pattern

**DO NOT store tokens in Durable Object props**

```
❌ WRONG:
props = {
  schwabUserId: "...",
  accessToken: "...",      // NO! Can diverge from KV
  refreshToken: "..."      // NO! Creates two sources of truth
}

✅ CORRECT:
props = {
  schwabUserId: "...",     // ID only, for key derivation
  clientId: "..."          // Fallback ID
}

// Tokens ONLY in KV:
KV["token:schwabUserId"] = {
  access_token: "...",
  refresh_token: "...",
  expires_in: 1800
}
```

**Rationale:**
- KV is single source of truth
- Prevents token divergence between DO and KV
- DO can be destroyed/recreated without losing tokens
- Multiple DO instances can share same tokens (reconnection)

### Token Key Priority

```
1. Try schwabUserId (preferred):
   - Unique to Schwab account
   - Persists across OAuth apps
   - Format: token:<schwabUserId>

2. Fall back to clientId:
   - OAuth app client ID
   - Used before schwabUserId is known
   - Format: token:<clientId>

3. Auto-migration:
   - When schwabUserId becomes available
   - Copy token from clientId key to schwabUserId key
   - Delete old clientId key
   - Prevents duplicate tokens
```

## Security Architecture

### Authentication Layers

```
Layer 1: MCP Client → Worker (OAuth 2.0)
  - Client credentials (client_id)
  - Authorization code flow
  - PKCE for public clients

Layer 2: Worker → Schwab (OAuth 2.0 + mTLS)
  - Access token (Bearer)
  - Refresh token (secure storage)
  - Client credentials (app key/secret)

Layer 3: Encrypted Storage
  - Cookies: AES-256-GCM
  - State params: HMAC-SHA256
  - Tokens: KV storage (Cloudflare encrypted)
```

### Account Scrubbing

**Why:** Prevent leaking sensitive account numbers to AI models

**How:**
```typescript
// Before scrubbing:
{
  accountNumber: "123456789",
  accountType: "INDIVIDUAL"
}

// After scrubbing:
{
  accountNumber: "Individual-...789",  // Display name
  accountType: "INDIVIDUAL"
}

// Display map stored in tokenManager:
{
  "123456789": "Individual-...789",
  "987654321": "IRA-...321"
}
```

**Scope:** All tool responses automatically scrubbed

### Secret Management

```
Development (.dev.vars):
SCHWAB_CLIENT_ID=...
SCHWAB_CLIENT_SECRET=...
SCHWAB_REDIRECT_URI=http://localhost:8788/callback
COOKIE_ENCRYPTION_KEY=...

Production (wrangler secret):
$ wrangler secret put SCHWAB_CLIENT_ID
$ wrangler secret put SCHWAB_CLIENT_SECRET
$ wrangler secret put SCHWAB_REDIRECT_URI
$ wrangler secret put COOKIE_ENCRYPTION_KEY

Configuration Validation:
- All secrets validated with Zod schemas
- Invalid config throws startup error
- Centralized in src/config/appConfig.ts
```

## Logging Architecture

### Logger Hierarchy

```
Root Logger (Pino)
├─ oauth-handler     (src/auth/handler.ts)
├─ oauth-client      (src/auth/client.ts)
├─ mcp-do           (MyMCP Durable Object)
├─ token-manager    (@sudowealth/schwab-api)
└─ api-client       (@sudowealth/schwab-api)
```

### Log Levels

```
trace → debug → info → warn → error → fatal

Production default: info
Development: debug (set via LOG_LEVEL env var)
```

### Secret Redaction

**Automatic:** All logs pass through `secureLogger.ts`

```typescript
// These are automatically redacted:
{
  access_token: "abc123...",     → "[REDACTED]"
  refresh_token: "xyz789...",    → "[REDACTED]"
  Authorization: "Bearer ...",   → "[REDACTED]"
  accountNumber: "123456789",    → "...789"
}
```

## Error Handling

### Error Mapping

```
Schwab API Error → MCP Error

401 Unauthorized    → invalid_token
403 Forbidden       → insufficient_scope
429 Rate Limited    → rate_limited
500 Server Error    → server_error
Network Error       → network_error
```

**Location:** `src/auth/errorMapping.ts`

### Custom Error Types

```typescript
// src/auth/errors.ts
class AuthErrors {
  static MissingClientId = class extends Error { ... }
  static StateValidation = class extends Error { ... }
  static CodeExchange = class extends Error { ... }
  static TokenRefresh = class extends Error { ... }
}

// All errors include:
- Error code
- HTTP status
- User-friendly message
- Request ID (for Schwab support)
```

## Deployment Architecture

### Cloudflare Workers

```
┌────────────────────────────────────────┐
│  Global Cloudflare Network             │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │  Worker (serverless function)    │  │
│  │  - Runs on every request         │  │
│  │  - Stateless (except DO)         │  │
│  │  - Global distribution           │  │
│  │  - Auto-scaling                  │  │
│  └──────────────────────────────────┘  │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │  Durable Objects                 │  │
│  │  - Strongly consistent           │  │
│  │  - Single-threaded per instance  │  │
│  │  - Persistent state              │  │
│  │  - WebSocket/SSE support         │  │
│  └──────────────────────────────────┘  │
│                                         │
│  ┌──────────────────────────────────┐  │
│  │  KV Storage                      │  │
│  │  - Eventually consistent         │  │
│  │  - Global replication            │  │
│  │  - Low-latency reads             │  │
│  └──────────────────────────────────┘  │
│                                         │
└────────────────────────────────────────┘
```

### Durable Object Requirements

**IMPORTANT:** Requires Cloudflare Workers **paid plan**

- Free tier: Does NOT support Durable Objects
- Paid tier ($5/month): Unlimited Durable Objects
- Migration tag: `v1` (defined in wrangler.toml)

### Environment-Specific Config

```
Development:
- wrangler dev (local)
- Local KV namespace
- .dev.vars for secrets
- http://localhost:8788

Staging/Production:
- wrangler deploy
- Production KV namespace
- wrangler secret for secrets
- https://<worker>.workers.dev
```

## Configuration Management

### Config Loading

```typescript
// src/config/appConfig.ts
export const getConfig = (env: Env): ValidatedEnv => {
  // 1. Load from env (Cloudflare bindings)
  // 2. Validate with Zod schema
  // 3. Throw if invalid
  // 4. Memoize result
  return validatedConfig
}

// Zod schema validates:
- Required fields
- Enum values (LOG_LEVEL)
- URL formats
- Type safety
```

### Validation Errors

```
Example:
LOG_LEVEL=DEBUG  ❌

Error:
Environment validation failed:
  - LOG_LEVEL: Invalid enum value.
    Expected 'trace'|'debug'|'info'|'warn'|'error'|'fatal',
    received 'DEBUG'

Fix:
LOG_LEVEL=debug  ✅
```

## Reconnection Handling

### SSE Reconnection Flow

```
┌──────────┐                     ┌────────────┐
│   MCP    │                     │  Durable   │
│  Client  │                     │   Object   │
└─────┬────┘                     └──────┬─────┘
      │                                 │
      │  1. Initial connection          │
      ├────────────────────────────────►│
      │                                 │
      │  2. SSE stream open             │
      │◄────────────────────────────────┤
      │                                 │

      Network interruption

      │                                 │
      │  3. Reconnect attempt           │
      ├────────────────────────────────►│
      │                                 │
      │                          4. onReconnect()
      │                                 │
      │                          5. Try recover
      │                             tokenManager
      │                                 │
      │                          6. Success?
      │                             ├─Yes─► Use existing
      │                             └─No──► Full reinit
      │                                 │
      │  7. SSE stream restored         │
      │◄────────────────────────────────┤
      │     (same state)                │
      │                                 │
```

### State Recovery

```typescript
async onReconnect() {
  try {
    // Attempt to reuse existing tokenManager
    if (this.tokenManager) {
      // Token manager exists, verify it works
      await this.tokenManager.getToken()
      return // Success! Keep existing state
    }
  } catch {
    // Token manager failed, full reinit
    await this.init()
  }
}
```

## Tool Registration Pattern

### Dynamic Tool Loading

```typescript
// src/tools/index.ts
export const allToolSpecs = [
  ...traderToolSpecs,    // Account, order, transaction tools
  ...marketToolSpecs     // Quote, instrument, options tools
]

// src/index.ts (MyMCP.init)
for (const spec of allToolSpecs) {
  this.server.tool(
    spec.name,
    spec.description,
    spec.schema,
    async (params) => {
      const result = await spec.call(this.client, params)
      return toolSuccess(result)
    }
  )
}
```

### Tool Categories

**Trader Tools** (`src/tools/trader/`)
- `getAccounts` - List brokerage accounts
- `getAccount` - Get specific account details
- `getAccountPositions` - View positions
- `getOrders` - View orders
- `placeOrder` - Submit new orders
- `getTransactions` - View transaction history

**Market Tools** (`src/tools/market/`)
- `getQuotes` - Get real-time quotes
- `getInstrument` - Search instruments
- `getOptionChain` - View options data
- `getMovers` - Market movers by index

## Performance Considerations

### Cold Start Mitigation

```
First request to Durable Object:
├─ DO creation: ~50-100ms
├─ init() execution: ~200-500ms
├─ Token load from KV: ~10-50ms
└─ Total: ~260-650ms

Subsequent requests (warm DO):
├─ Tool execution: ~10-50ms
├─ API call to Schwab: ~200-800ms
└─ Total: ~210-850ms
```

### Caching Strategy

```
Token Manager:
- In-memory token cache (until expiration)
- Only fetch from KV when needed
- Refresh 5 min before expiry

Account Display Map:
- Cached in tokenManager
- Loaded once per session
- Used for all scrubbing operations

DO State:
- Persistent across requests
- Survives until idle timeout
- ~10 minute idle timeout (Cloudflare default)
```

## Testing Architecture

### Local Development

```
Terminal 1: Tunnel (HTTPS)
$ cloudflared tunnel --url http://localhost:8788
  or
$ ngrok http 8788

Terminal 2: Dev Server
$ npm run dev

Terminal 3: MCP Inspector
$ npm run inspect
Connect to: https://<tunnel-url>/sse
```

### OAuth Testing Checklist

```
1. ✓ Tunnel running with HTTPS
2. ✓ .dev.vars configured
3. ✓ Schwab portal has callback URL
4. ✓ Dev server started
5. ✓ MCP Inspector connects to /sse
6. ✓ Approval dialog appears
7. ✓ Redirect to Schwab works
8. ✓ Callback processes successfully
9. ✓ Tokens stored in KV
10. ✓ Tools available in Inspector
```

### Debug Mode

```bash
# Enable verbose logging
LOG_LEVEL=debug npm run dev

# Check wrangler output for:
- OAuth state validation
- Token exchange details
- API call parameters
- Error stack traces
```

## Migration Patterns

### Token Migration (clientId → schwabUserId)

**Scenario:** User authenticates before we know their schwabUserId

```
Step 1: Initial OAuth (no schwabUserId yet)
KV["token:<clientId>"] = { access_token: "...", ... }
DO.props = { clientId: "..." }

Step 2: First API call (fetch user preferences)
schwabUserId = "USR123456"
DO.props = { clientId: "...", schwabUserId: "USR123456" }

Step 3: Next token load
- Try KV["token:USR123456"] → Not found
- Try KV["token:<clientId>"] → Found!
- Migrate to KV["token:USR123456"]
- Delete KV["token:<clientId>"]

Step 4: Future loads
- KV["token:USR123456"] → Found
- No migration needed
```

### Durable Object Migration

```toml
# wrangler.toml
[[migrations]]
tag = "v1"
new_classes = ["MyMCP"]

# Future migrations:
[[migrations]]
tag = "v2"
renamed_classes = [
  { from = "MyMCP", to = "MyMCP_v2" }
]
```

## API Rate Limiting

### Schwab API Limits

```
Standard Limits:
- 120 requests per minute per OAuth app
- Shared across all users of the app

Handling:
- 429 response → Mapped to rate_limited error
- Exponential backoff in client
- User-friendly error message
```

### Cloudflare Limits

```
Workers Free Tier:
- 100,000 requests/day
- 10ms CPU time per request

Workers Paid Tier:
- Unlimited requests
- 50ms CPU time per request
- Required for Durable Objects
```

## Troubleshooting Guide

### Common Issues

**1. "Invalid redirect_uri" error**
```
Cause: Mismatch between .dev.vars and Schwab portal
Fix: Ensure exact match (including /callback)
```

**2. "Missing or invalid access token"**
```
Cause: No OAuth flow completed
Fix: Complete OAuth via /authorize endpoint
```

**3. "Token refresh failed"**
```
Cause: Refresh token expired or revoked
Fix: Re-authenticate via OAuth flow
```

**4. "State validation failed"**
```
Cause: HMAC signature mismatch or expired state
Fix: Clear cookies and restart OAuth flow
```

**5. Tools not appearing**
```
Cause: DO initialization failed
Fix: Check wrangler logs for errors during init()
```

## Future Enhancements

### Potential Improvements

1. **STDIO Transport for Local Dev**
   - Bypass OAuth for local testing
   - Direct API credential usage
   - Simpler Claude Desktop integration

2. **Token Encryption at Rest**
   - Encrypt tokens before KV storage
   - Additional security layer
   - Key rotation support

3. **Multi-Account Support**
   - Store tokens for multiple Schwab accounts
   - Switch between accounts in tools
   - Account-specific permissions

4. **Webhook Support**
   - Real-time order updates
   - Account change notifications
   - Push updates to MCP clients

5. **Caching Layer**
   - Cache frequently accessed data
   - Reduce API calls
   - Improve response times

## Conclusion

This architecture provides:

✅ **Security** - OAuth 2.0, PKCE, token encryption, account scrubbing
✅ **Scalability** - Cloudflare edge network, Durable Objects
✅ **Reliability** - Token auto-refresh, reconnection handling
✅ **Developer Experience** - Type-safe SDK, comprehensive logging
✅ **Production-Ready** - Error handling, rate limiting, validation

The design separates concerns clearly:
- OAuth Provider handles authentication
- Durable Objects manage session state
- KV Storage persists tokens
- MCP Server exposes tools
- Schwab SDK handles API communication

This separation enables easy testing, debugging, and future enhancements while maintaining security and reliability.

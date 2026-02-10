# Schwab MCP Server - Architecture Diagrams

This document contains detailed architectural diagrams for the Schwab MCP server.

## System Context Diagram

Shows the high-level system boundaries and external actors.

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
    ┌───────────────┤        External Systems                 ├────────────────┐
    │               │                                          │                │
    │               └──────────────────────────────────────────┘                │
    │                                                                           │
    ▼                                                                           ▼
┌─────────┐                                                            ┌──────────────┐
│  User   │                                                            │   Schwab     │
│ (Human) │                                                            │     API      │
└────┬────┘                                                            │              │
     │                                                                 │ - Trading    │
     │ Interacts                                                       │ - Market Data│
     │ via AI                                                          │ - Accounts   │
     ▼                                                                 └───────▲──────┘
┌─────────────┐                                                               │
│   Claude    │                                                               │
│  Desktop    │                                                               │
│     or      │                                                               │
│     MCP     │                                                               │
│  Inspector  │                                                               │
└──────┬──────┘                                                               │
       │                                                                      │
       │ SSE/HTTP (OAuth 2.0)                                                 │
       │                                                                      │
       ▼                                                                      │
┌──────────────────────────────────────────────────────────┐                 │
│                                                           │                 │
│         Schwab MCP Server (Cloudflare Workers)           │                 │
│                                                           │                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │                 │
│  │   OAuth     │  │   Durable    │  │  KV Storage    │  │                 │
│  │  Provider   │  │   Objects    │  │  (Tokens)      │  │                 │
│  └─────────────┘  └──────────────┘  └────────────────┘  │                 │
│                                                           │                 │
└───────────────────────────────────────────────────────────┘                 │
                                       │                                      │
                                       │ HTTPS API Calls                      │
                                       │ (Bearer Token)                       │
                                       └──────────────────────────────────────┘
```

## Component Diagram

Detailed view of internal components and their relationships.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                        Cloudflare Workers Runtime                             │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                          Worker Entry Point                             │ │
│  │                        (export default handler)                         │ │
│  └───────────────────────────────┬─────────────────────────────────────────┘ │
│                                  │                                            │
│          ┌───────────────────────┴────────────────────────┐                  │
│          │                                                 │                  │
│          ▼                                                 ▼                  │
│  ┌───────────────────┐                          ┌──────────────────────┐     │
│  │  OAuth Provider   │                          │  WebSocket/SSE       │     │
│  │  (Hono Router)    │                          │  Handler             │     │
│  │                   │                          │                      │     │
│  │  Routes:          │                          │  ┌─────────────────┐ │     │
│  │  /authorize       │                          │  │ onSSE()         │ │     │
│  │  /callback        │                          │  │ Creates/binds   │ │     │
│  │  /token           │                          │  │ Durable Object  │ │     │
│  │  /.well-known/*   │                          │  └─────────────────┘ │     │
│  └─────────┬─────────┘                          └──────────┬───────────┘     │
│            │                                               │                  │
│            │                                               │                  │
│            │                                               ▼                  │
│            │                          ┌──────────────────────────────────┐   │
│            │                          │     Durable Object (MyMCP)       │   │
│            │                          │                                  │   │
│            │                          │  ┌────────────────────────────┐  │   │
│            │                          │  │   MCP Server Instance      │  │   │
│            │                          │  │   - Tool registry          │  │   │
│            │                          │  │   - Request handling       │  │   │
│            │                          │  │   - Resource management    │  │   │
│            │                          │  └────────────┬───────────────┘  │   │
│            │                          │               │                  │   │
│            │                          │               ▼                  │   │
│            │                          │  ┌────────────────────────────┐  │   │
│            │                          │  │  EnhancedTokenManager      │  │   │
│            │                          │  │  (@sudowealth/schwab-api)  │  │   │
│            │                          │  │                            │  │   │
│            │                          │  │  - Token lifecycle         │  │   │
│            │                          │  │  - Auto-refresh (5min)     │  │   │
│            │                          │  │  - KV integration          │  │   │
│            │                          │  └────────────┬───────────────┘  │   │
│            │                          │               │                  │   │
│            │                          │               ▼                  │   │
│            │                          │  ┌────────────────────────────┐  │   │
│            │                          │  │    SchwabApiClient         │  │   │
│            │                          │  │  (@sudowealth/schwab-api)  │  │   │
│            │                          │  │                            │  │   │
│            │                          │  │  - API client methods      │  │   │
│            │                          │  │  - Request/response        │  │   │
│            │                          │  │  - Error handling          │  │   │
│            │                          │  └────────────────────────────┘  │   │
│            │                          │                                  │   │
│            │                          │  Props (Persistent):             │   │
│            │                          │  {                               │   │
│            │                          │    schwabUserId?: string         │   │
│            │                          │    clientId?: string             │   │
│            │                          │  }                               │   │
│            │                          └──────────────┬───────────────────┘   │
│            │                                         │                       │
│            └─────────────────────────────────────────┘                       │
│                                                      │                       │
│                                                      │                       │
│  ┌───────────────────────────────────────────────────┼──────────────────┐   │
│  │                  Shared Services                  │                  │   │
│  │                                                    │                  │   │
│  │  ┌──────────────────┐  ┌─────────────────┐  ┌────▼──────────────┐  │   │
│  │  │  Config Manager  │  │  Logger (Pino)  │  │  KV Token Store   │  │   │
│  │  │  (appConfig.ts)  │  │  - Contexts     │  │                   │  │   │
│  │  │                  │  │  - Log levels   │  │  Storage:         │  │   │
│  │  │  - Validation    │  │  - Redaction    │  │  token:<userId>   │  │   │
│  │  │  - Env vars      │  │  - Structured   │  │                   │  │   │
│  │  └──────────────────┘  └─────────────────┘  │  TTL: 31 days     │  │   │
│  │                                              └───────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

## OAuth Flow Sequence Diagram

Detailed sequence of OAuth 2.0 authorization code flow with PKCE.

```
User      MCP Client    OAuth Provider    Schwab API    KV Store    Durable Object
 │             │               │               │            │              │
 │ Start auth  │               │               │            │              │
 └─────────────►               │               │            │              │
               │ 1. GET /sse  │               │            │              │
               ├──────────────►               │            │              │
               │              │               │            │              │
               │ 2. 401 + OAuth discovery    │            │              │
               │◄──────────────┤              │            │              │
               │              │               │            │              │
               │ 3. GET /.well-known/oauth-authorization-server          │
               ├──────────────►               │            │              │
               │              │               │            │              │
               │ 4. Metadata  │               │            │              │
               │◄──────────────┤              │            │              │
               │              │               │            │              │
               │ 5. GET /authorize?client_id=...&state=...&code_challenge=...
               ├──────────────►               │            │              │
               │              │               │            │              │
               │              │ 6. Check cookie            │              │
               │              │    (approved before?)      │              │
               │              │               │            │              │
               │              │ No cookie     │            │              │
               │              │               │            │              │
               │ 7. Approval Dialog HTML      │            │              │
               │◄──────────────┤              │            │              │
               │              │               │            │              │
 ┌─────────────┤              │               │            │              │
 │ User sees   │              │               │            │              │
 │ approval    │              │               │            │              │
 │ dialog      │              │               │            │              │
 │             │              │               │            │              │
 │ Click       │              │               │            │              │
 │ "Approve"   │              │               │            │              │
 └─────────────►              │               │            │              │
               │ 8. POST /authorize (approved=true, state=...)           │
               ├──────────────►               │            │              │
               │              │               │            │              │
               │              │ 9. Create approval cookie  │              │
               │              │    Set-Cookie: encrypted   │              │
               │              │               │            │              │
               │ 10. 302 Redirect to Schwab  │            │              │
               │    Location: https://api.schwabapi.com/v1/oauth/authorize
               │              ?client_id=...              │              │
               │              &redirect_uri=.../callback  │              │
               │              &code_challenge=...         │              │
               │              &state=<encoded-auth-request>              │
               │◄──────────────┤              │            │              │
               │              │               │            │              │
 ┌─────────────┤              │               │            │              │
 │ Browser     │              │               │            │              │
 │ redirects   │              │               │            │              │
 │ to Schwab   │              │               │            │              │
 └─────────────►──────────────────────────────►            │              │
               │              │  11. Schwab login page     │              │
               │              │               │            │              │
 ┌─────────────┤              │               │            │              │
 │ User logs   │              │               │            │              │
 │ in with     │              │               │            │              │
 │ credentials │              │               │            │              │
 └─────────────►──────────────────────────────►            │              │
               │              │  12. POST credentials      │              │
               │              │               │            │              │
               │              │  13. 302 Redirect to callback            │
               │              │      Location: .../callback?code=...&state=...
               │◄─────────────────────────────┤            │              │
               │              │               │            │              │
               │ 14. GET /callback?code=...&state=...      │              │
               ├──────────────►               │            │              │
               │              │               │            │              │
               │              │ 15. Decode & verify state  │              │
               │              │     HMAC validation        │              │
               │              │     Extract code_verifier  │              │
               │              │               │            │              │
               │              │ 16. POST /oauth/token      │              │
               │              │     grant_type=authorization_code         │
               │              │     code=...               │              │
               │              │     code_verifier=...      │              │
               │              ├──────────────►             │              │
               │              │               │            │              │
               │              │ 17. Access + Refresh token │              │
               │              │◄──────────────┤            │              │
               │              │               │            │              │
               │              │ 18. GET /userPreference    │              │
               │              │     (to get schwabUserId)  │              │
               │              ├──────────────►             │              │
               │              │               │            │              │
               │              │ 19. User preferences       │              │
               │              │     { schwabUserId: "..." }│              │
               │              │◄──────────────┤            │              │
               │              │               │            │              │
               │              │ 20. PUT token:<schwabUserId>              │
               │              │     { access_token, refresh_token, ... }  │
               │              ├───────────────────────────►               │
               │              │               │            │              │
               │              │ 21. Token stored           │              │
               │              │◄───────────────────────────┤              │
               │              │               │            │              │
               │ 22. Success HTML (close window)           │              │
               │◄──────────────┤              │            │              │
               │              │               │            │              │
               │ 23. Reconnect GET /sse       │            │              │
               ├──────────────►               │            │              │
               │              │               │            │              │
               │              │ 24. Create/bind Durable Object            │
               │              ├───────────────────────────────────────────►
               │              │               │            │              │
               │              │               │            │ 25. init()   │
               │              │               │            │     Load token
               │              │               │            │◄─────────────┤
               │              │               │            │              │
               │              │               │     26. GET token:<userId>│
               │              │               │            ├──────────────►
               │              │               │            │              │
               │              │               │     27. Token data        │
               │              │               │            │◄─────────────┤
               │              │               │            │              │
               │              │               │            │ 28. Init     │
               │              │               │            │     complete │
               │              │               │            ├──────────────►
               │              │               │            │              │
               │ 29. SSE connection established, tools available          │
               │◄──────────────────────────────────────────────────────────
               │              │               │            │              │
```

## Tool Execution Flow

Shows the flow when an MCP client invokes a tool.

```
MCP Client    Durable Object    TokenManager    KV Store    Schwab API
    │                │                │             │            │
    │ 1. Tool call   │                │             │            │
    │  (getAccounts) │                │             │            │
    ├───────────────►                │             │            │
    │                │                │             │            │
    │                │ 2. Validate request          │            │
    │                │                │             │            │
    │                │ 3. Get token   │             │            │
    │                ├───────────────►              │            │
    │                │                │             │            │
    │                │                │ 4. Check expiration       │
    │                │                │    (expires in >5min?)   │
    │                │                │             │            │
    │                │                │ Token valid │            │
    │                │                │             │            │
    │                │ 5. Token       │             │            │
    │                │◄───────────────┤             │            │
    │                │                │             │            │
    │                │ 6. GET /trader/v1/accounts   │            │
    │                │   Authorization: Bearer <token>           │
    │                ├──────────────────────────────────────────►
    │                │                │             │            │
    │                │ 7. Account data│             │            │
    │                │◄──────────────────────────────────────────┤
    │                │                │             │            │
    │                │ 8. Build account display map │            │
    │                │    { "123...": "Individual-...123" }      │
    │                │                │             │            │
    │                │ 9. Scrub account identifiers │            │
    │                │    Replace sensitive data    │            │
    │                │                │             │            │
    │ 10. Tool result│                │             │            │
    │    (scrubbed)  │                │             │            │
    │◄───────────────┤                │             │            │
    │                │                │             │            │


Alternative flow: Token expired

MCP Client    Durable Object    TokenManager    KV Store    Schwab API
    │                │                │             │            │
    │ 1. Tool call   │                │             │            │
    ├───────────────►                │             │            │
    │                │                │             │            │
    │                │ 2. Get token   │             │            │
    │                ├───────────────►              │            │
    │                │                │             │            │
    │                │                │ 3. Check expiration       │
    │                │                │    (expires in <5min)    │
    │                │                │             │            │
    │                │                │ 4. POST /oauth/token     │
    │                │                │    grant_type=refresh_token
    │                │                │    refresh_token=...     │
    │                │                ├─────────────────────────►
    │                │                │             │            │
    │                │                │ 5. New tokens            │
    │                │                │◄─────────────────────────┤
    │                │                │             │            │
    │                │                │ 6. PUT token:<userId>    │
    │                │                │    (new tokens)          │
    │                │                ├────────────►            │
    │                │                │             │            │
    │                │                │ 7. Saved    │            │
    │                │                │◄────────────┤            │
    │                │                │             │            │
    │                │ 8. New token   │             │            │
    │                │◄───────────────┤             │            │
    │                │                │             │            │
    │                │ 9. Continue with API call... │            │
    │                │                │             │            │
```

## Token Storage Architecture

Shows how tokens are stored and accessed across components.

```
┌────────────────────────────────────────────────────────────────┐
│                     Token Storage Pattern                      │
└────────────────────────────────────────────────────────────────┘

┌─────────────────────┐
│  Durable Object     │
│                     │         ┌──────────────────────────────┐
│  Props:             │         │     KV Storage (OAUTH_KV)    │
│  {                  │         │                              │
│    schwabUserId:    │────────►│  Key: token:USR123456        │
│      "USR123456",   │  Used   │  Value: {                    │
│                     │  for    │    access_token: "...",      │
│    clientId:        │  token  │    refresh_token: "...",     │
│      "CLIENT789"    │  key    │    expires_in: 1800,         │
│  }                  │         │    token_type: "Bearer",     │
│                     │         │    scope: "...",             │
│  ❌ NO TOKENS       │         │    id_token: "..."           │
│     STORED HERE     │         │  }                           │
│                     │         │  TTL: 31 days                │
└─────────────────────┘         │                              │
                                │  Legacy Key (auto-migrated): │
                                │  token:CLIENT789 → deleted   │
                                └──────────────────────────────┘

Token Access Flow:

1. Build token key:
   ┌──────────────────────────────────────┐
   │ getTokenIds() → {                    │
   │   schwabUserId: "USR123456",         │
   │   clientId: "CLIENT789"              │
   │ }                                    │
   └──────────────────────────────────────┘
                    │
                    ▼
   ┌──────────────────────────────────────┐
   │ Try: token:USR123456                 │
   │ Found? → Return                      │
   │                                      │
   │ Not found? → Try: token:CLIENT789    │
   │ Found? → Migrate to token:USR123456  │
   │        → Delete token:CLIENT789      │
   │        → Return                      │
   │                                      │
   │ Not found? → Error (need OAuth)      │
   └──────────────────────────────────────┘

2. Token refresh (automatic):
   ┌──────────────────────────────────────┐
   │ Every API call checks:               │
   │ if (expires_at - now < 5 minutes) {  │
   │   refreshToken()                     │
   │   saveToKV(newToken)                 │
   │ }                                    │
   └──────────────────────────────────────┘

3. Multiple Durable Objects, Single Token:
   ┌─────────────┐     ┌─────────────┐
   │ DO Instance │     │ DO Instance │
   │     #1      │     │     #2      │
   │ (reconnect) │     │ (new conn)  │
   └──────┬──────┘     └──────┬──────┘
          │                   │
          └───────┬───────────┘
                  │ Both read same token
                  ▼
          ┌───────────────┐
          │  KV Storage   │
          │ token:USR123  │
          └───────────────┘
```

## Error Handling Flow

Shows how errors are mapped and handled across layers.

```
┌──────────────┐
│ Schwab API   │
│   Response   │
└──────┬───────┘
       │
       ▼
┌─────────────────────────────────────┐
│  SchwabApiClient                    │
│  (@sudowealth/schwab-api)          │
│                                     │
│  Catches:                           │
│  - HTTP errors (401, 403, 429, 500) │
│  - Network errors                   │
│  - Timeout errors                   │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  Error Mapping                      │
│  (src/auth/errorMapping.ts)         │
│                                     │
│  Schwab Error → MCP Error:          │
│  401 → invalid_token                │
│  403 → insufficient_scope           │
│  429 → rate_limited                 │
│  500 → server_error                 │
│  Network → network_error            │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  MCP Error Response                 │
│                                     │
│  {                                  │
│    code: "invalid_token",           │
│    message: "Access token expired", │
│    details: {                       │
│      requestId: "abc-123",          │
│      status: 401                    │
│    }                                │
│  }                                  │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  MCP Client                         │
│  (Claude Desktop, Inspector)        │
│                                     │
│  Displays user-friendly error       │
└─────────────────────────────────────┘


Retry Logic:

┌──────────────┐
│  API Call    │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────┐
│  SchwabApiClient             │
│                              │
│  if (error.status === 401) { │
│    // Token expired          │
│    refreshToken()            │
│    retry()                   │
│  }                           │
│                              │
│  if (error.status === 429) { │
│    // Rate limited           │
│    wait(exponentialBackoff)  │
│    retry()                   │
│  }                           │
│                              │
│  else {                      │
│    throw MappedError         │
│  }                           │
└──────────────────────────────┘
```

## Deployment Architecture

Shows the Cloudflare Workers deployment structure.

```
┌─────────────────────────────────────────────────────────────────┐
│              Cloudflare Global Network (200+ cities)            │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │   Edge POP   │  │   Edge POP   │  │   Edge POP   │         │
│  │  (New York)  │  │  (London)    │  │  (Singapore) │  ...    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘         │
│         │                 │                 │                  │
│         └─────────────────┴─────────────────┘                  │
│                           │                                    │
│                           ▼                                    │
│         ┌─────────────────────────────────────┐                │
│         │     Worker Script (Replicated)      │                │
│         │                                     │                │
│         │  - OAuth Provider                   │                │
│         │  - SSE Handler                      │                │
│         │  - Entry point routing              │                │
│         └─────────────────┬───────────────────┘                │
│                           │                                    │
│         ┌─────────────────┴───────────────────┐                │
│         │                                     │                │
│         ▼                                     ▼                │
│  ┌──────────────────┐              ┌─────────────────────┐    │
│  │ Durable Objects  │              │   KV Namespace      │    │
│  │  (Centralized)   │              │   (Replicated)      │    │
│  │                  │              │                     │    │
│  │ - Per-user state │              │ - Token storage     │    │
│  │ - Single region  │              │ - Eventually        │    │
│  │ - Consistent     │              │   consistent        │    │
│  └──────────────────┘              │ - Global reads      │    │
│                                    │ - Local writes      │    │
│                                    └─────────────────────┘    │
│                                                                │
└────────────────────────────────────┬────────────────────────────┘
                                     │
                                     │ HTTPS
                                     ▼
                          ┌──────────────────────┐
                          │    Schwab API        │
                          │ (US-based servers)   │
                          └──────────────────────┘


Request Flow:

User (Tokyo) → Cloudflare Edge (Tokyo)
                     │
                     ├─ Worker Script (runs locally)
                     │
                     ├─ Durable Object (routed to central region)
                     │  └─ Consistent state, single location
                     │
                     ├─ KV Storage (read from nearby edge)
                     │  └─ Fast reads, eventual consistency
                     │
                     └─ Schwab API (US servers)
                        └─ HTTPS API calls


Cold Start:
┌─────────────────────────────────────────────┐
│ First request to new Durable Object:       │
│ 1. Allocate DO instance     (~50-100ms)    │
│ 2. Run init()               (~200-500ms)   │
│ 3. Load token from KV       (~10-50ms)     │
│ Total: ~260-650ms                           │
└─────────────────────────────────────────────┘

Warm Request:
┌─────────────────────────────────────────────┐
│ Subsequent requests (DO already running):   │
│ 1. Route to DO              (~5-10ms)       │
│ 2. Execute tool             (~10-50ms)      │
│ 3. API call to Schwab       (~200-800ms)    │
│ Total: ~215-860ms                            │
└─────────────────────────────────────────────┘
```

## Security Model

Shows the security layers and data protection.

```
┌────────────────────────────────────────────────────────────────┐
│                      Security Layers                           │
└────────────────────────────────────────────────────────────────┘

Layer 1: Transport Security
┌──────────────────────────────────────┐
│  MCP Client ←──[HTTPS]──→ Worker    │
│                                      │
│  - TLS 1.3                           │
│  - Certificate validation            │
│  - Encrypted in transit              │
└──────────────────────────────────────┘

Layer 2: Authentication (OAuth 2.0)
┌──────────────────────────────────────┐
│  OAuth Provider                      │
│                                      │
│  - Client credentials                │
│  - Authorization code flow           │
│  - PKCE (S256)                       │
│  - State parameter (HMAC-signed)     │
│  - Approval cookies (AES-256-GCM)    │
└──────────────────────────────────────┘

Layer 3: Token Storage
┌──────────────────────────────────────┐
│  KV Storage                          │
│                                      │
│  - Cloudflare-managed encryption     │
│  - Encrypted at rest                 │
│  - Access control via bindings       │
│  - 31-day TTL (auto-expire)          │
└──────────────────────────────────────┘

Layer 4: Data Scrubbing
┌──────────────────────────────────────┐
│  Account Identifier Scrubbing        │
│                                      │
│  Before: "accountNumber": "12345678" │
│  After:  "accountNumber": "Ind-...78"│
│                                      │
│  - All tool responses scrubbed       │
│  - Prevents AI model data leakage    │
│  - Display map cached per session    │
└──────────────────────────────────────┘

Layer 5: Secret Management
┌──────────────────────────────────────┐
│  Environment Variables               │
│                                      │
│  Development:                        │
│  - .dev.vars (gitignored)            │
│                                      │
│  Production:                         │
│  - wrangler secret (encrypted)       │
│  - Never in code or logs             │
│  - Validated at startup (Zod)        │
└──────────────────────────────────────┘

Layer 6: Logging Security
┌──────────────────────────────────────┐
│  Secure Logger                       │
│                                      │
│  Auto-redacted fields:               │
│  - access_token    → [REDACTED]      │
│  - refresh_token   → [REDACTED]      │
│  - Authorization   → [REDACTED]      │
│  - accountNumber   → ...last4        │
│                                      │
│  - Structured logging (JSON)         │
│  - Request ID tracking               │
│  - Context-aware loggers             │
└──────────────────────────────────────┘


Attack Surface Mitigation:

┌─────────────────────────────────────────┐
│  Threat: Token Theft                    │
│  Mitigation:                            │
│  ✓ HTTPS only                           │
│  ✓ Encrypted storage                    │
│  ✓ Short-lived access tokens (30 min)   │
│  ✓ Refresh token rotation               │
│  ✓ Secure logging (redaction)           │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Threat: CSRF                           │
│  Mitigation:                            │
│  ✓ State parameter (HMAC-signed)        │
│  ✓ PKCE flow (code verifier)            │
│  ✓ Encrypted approval cookies           │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Threat: Data Leakage to AI             │
│  Mitigation:                            │
│  ✓ Account number scrubbing             │
│  ✓ Sensitive field removal              │
│  ✓ Display name substitution            │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  Threat: Replay Attacks                 │
│  Mitigation:                            │
│  ✓ Nonce in state parameter             │
│  ✓ Time-limited state validity          │
│  ✓ One-time authorization codes         │
└─────────────────────────────────────────┘
```

## Monitoring & Observability

```
┌────────────────────────────────────────────────────────────────┐
│                    Logging Architecture                        │
└────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Pino Logger (Structured JSON)                              │
│                                                             │
│  Log Levels: trace → debug → info → warn → error → fatal   │
│                                                             │
│  Context-based Loggers:                                     │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────┐ │
│  │ oauth-handler  │  │   mcp-do       │  │ token-manager│ │
│  │                │  │                │  │              │ │
│  │ - Auth flow    │  │ - DO lifecycle │  │ - Token ops  │ │
│  │ - State mgmt   │  │ - Tool exec    │  │ - Refresh    │ │
│  │ - Callbacks    │  │ - Reconnection │  │ - API calls  │ │
│  └────────────────┘  └────────────────┘  └──────────────┘ │
│                                                             │
│  Request Tracking:                                          │
│  { requestId: "abc-123", contextId: "oauth-handler", ... }  │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Secret Redaction Layer (secureLogger.ts)                   │
│                                                             │
│  Before: { access_token: "eyJ..." }                         │
│  After:  { access_token: "[REDACTED]" }                     │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Output Destinations                                        │
│                                                             │
│  Development:                                               │
│  └─ console.log (wrangler dev output)                       │
│                                                             │
│  Production:                                                │
│  └─ Cloudflare Workers Logs (Dashboard)                     │
│  └─ Tail Workers (real-time streaming)                      │
│      $ wrangler tail                                        │
└─────────────────────────────────────────────────────────────┘


Metrics to Monitor:

┌─────────────────────────────────────┐
│  Performance Metrics                │
│  - DO cold start time               │
│  - Token refresh latency            │
│  - API call duration                │
│  - Tool execution time              │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  Error Metrics                      │
│  - 401/403 rate (auth failures)     │
│  - 429 rate (rate limiting)         │
│  - 500 rate (API errors)            │
│  - Token refresh failures           │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  Usage Metrics                      │
│  - Active sessions (DO count)       │
│  - Tool invocation frequency        │
│  - Token rotation rate              │
│  - KV read/write operations         │
└─────────────────────────────────────┘
```

---

## Additional Resources

- **Architecture Overview**: See [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Development Guide**: See [LOCAL-DEV.md](./LOCAL-DEV.md)
- **Project Documentation**: See [CLAUDE.md](./CLAUDE.md)
- **API Documentation**: See [README.md](./README.md)

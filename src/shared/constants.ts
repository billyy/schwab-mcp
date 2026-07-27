/**
 * Application Constants
 */
export const APP_NAME = 'Schwab MCP' as const
export const APP_SERVER_NAME = 'Schwab MCP Server' as const

/**
 * Cookie Constants
 */
export const COOKIE_NAMES = {
	APPROVED_CLIENTS: 'mcp-approved-clients',
} as const

/**
 * HTTP Header Constants
 */
export const HTTP_HEADERS = {
	COOKIE: 'Cookie',
	SET_COOKIE: 'Set-Cookie',
} as const

/**
 * Logger Context Names
 */
export const LOGGER_CONTEXTS = {
	MCP_DO: 'mcp-do',
	OAUTH_HANDLER: 'oauth-handler',
	COOKIES: 'cookies',
	AUTH_CLIENT: 'auth-client',
	STATE_UTILS: 'state-utils',
	KV_TOKEN_STORE: 'kv-token-store',
	ORDERS: 'orders',
	PROPOSALS: 'proposals',
} as const

/**
 * API Endpoints
 */
export const API_ENDPOINTS = {
	SSE: '/sse',
	MCP: '/mcp',
	AUTHORIZE: '/authorize',
	TOKEN: '/token',
	CALLBACK: '/callback',
	REGISTER: '/register',
	ORDERS: '/orders',
	PROPOSALS: '/proposals',
	SLACK_INTERACTIONS: '/slack/interactions',
} as const

/**
 * Tool Names
 */
export const TOOL_NAMES = {
	STATUS: 'status',
} as const

/**
 * Environment Constants
 */
export const ENVIRONMENTS = {
	PRODUCTION: 'PRODUCTION',
} as const

/**
 * Content Types
 */
export const CONTENT_TYPES = {
	TEXT: 'text',
} as const

/**
 * KV Token Store Constants
 */
export const TOKEN_KEY_PREFIX = 'token:' as const
export const TOKEN_TIMESTAMP_KEY_PREFIX = 'token_ts:' as const
export const TTL_31_DAYS = 31 * 24 * 60 * 60
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * Orders Endpoint Constants
 */
export const SCHWAB_API_BASE_URL = 'https://api.schwabapi.com' as const
export const ORDER_AUDIT_KEY_PREFIX = 'audit:order:' as const
export const ORDER_COUNT_KEY_PREFIX = 'order_count:' as const
export const ORDER_AUDIT_TTL_SECONDS = 90 * 24 * 60 * 60

/**
 * Drift Proposal Constants
 */
export const SLACK_API_BASE_URL = 'https://slack.com/api' as const
export const PROPOSAL_AUDIT_KEY_PREFIX = 'audit:proposal:' as const
export const PROPOSAL_EXPIRY_SECONDS = 4 * 60 * 60
export const PROPOSAL_MAX_ORDERS = 10
/** An `executing` proposal older than this is considered failed (evicted waitUntil) */
export const PROPOSAL_EXECUTING_TIMEOUT_MS = 15 * 60 * 1000
/** How long the ProposalStore DO retains terminal records before alarm purge */
export const PROPOSAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

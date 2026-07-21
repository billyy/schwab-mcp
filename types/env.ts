/**
 * Environment variables and bindings for the Schwab MCP worker
 *
 * This is the single source of truth for environment variable definitions.
 * In runtime, these variables are validated and accessed through AppConfig.
 */
export interface Env {
	/**
	 * Schwab OAuth client ID for API access
	 */
	SCHWAB_CLIENT_ID: string

	/**
	 * Schwab OAuth client secret for API access
	 */
	SCHWAB_CLIENT_SECRET: string

	/**
	 * Secret key used for cookie encryption
	 */
	COOKIE_ENCRYPTION_KEY: string

	/**
	 * OAuth redirect URI for callback after authentication
	 * This should be a fixed, configured value to ensure consistency
	 * across different environments and proxies
	 */
	SCHWAB_REDIRECT_URI: string

	/**
	 * KV namespace for storing tokens (required)
	 */
	OAUTH_KV: KVNamespace

	/**
	 * Optional log level for application logging
	 */
	LOG_LEVEL?: string

	/**
	 * Environment type (development, staging, production)
	 * Defaults to production if not specified
	 */
	ENVIRONMENT?: string

	/**
	 * Optional comma-separated list of additional redirect URI regex patterns
	 */
	ALLOWED_REDIRECT_REGEXPS?: string

	/**
	 * Tools to enable: "all", "core" (default), "tool1,tool2", "+tool1" (add to core), "-tool1" (remove from core)
	 */
	ENABLED_TOOLS?: string

	/**
	 * Shared secret for the POST /orders endpoint. If unset, the endpoint is disabled.
	 */
	ORDER_API_KEY?: string

	/**
	 * Schwab user ID used to derive the KV token key for the /orders endpoint
	 */
	SCHWAB_USER_ID?: string

	/**
	 * Maximum notional value (price x quantity) per order in USD
	 */
	ORDER_MAX_NOTIONAL?: string

	/**
	 * Comma-separated list of symbols allowed for /orders. If unset, all symbols allowed.
	 */
	ORDER_SYMBOL_ALLOWLIST?: string

	/**
	 * Maximum number of orders per UTC day via /orders (default: 10)
	 */
	ORDER_DAILY_CAP?: string
}

/**
 * A validated Env object, with all required fields validated to be non-empty
 * Used to pass around a validated set of environment variables
 * All properties are readonly to prevent accidental modification after validation
 */
export interface ValidatedEnv {
	/**
	 * Schwab OAuth client ID for API access
	 */
	readonly SCHWAB_CLIENT_ID: string

	/**
	 * Schwab OAuth client secret for API access
	 */
	readonly SCHWAB_CLIENT_SECRET: string

	/**
	 * Secret key used for cookie encryption
	 */
	readonly COOKIE_ENCRYPTION_KEY: string

	/**
	 * OAuth redirect URI for callback after authentication
	 */
	readonly SCHWAB_REDIRECT_URI: string

	/**
	 * KV namespace for storing tokens (required)
	 */
	readonly OAUTH_KV: KVNamespace

	/**
	 * Optional log level for application logging
	 */
	readonly LOG_LEVEL?: string

	/**
	 * Environment type (development, staging, production)
	 * Defaults to production if not specified
	 */
	readonly ENVIRONMENT?: 'development' | 'staging' | 'production'

	/**
	 * Optional comma-separated list of additional redirect URI regex patterns
	 */
	readonly ALLOWED_REDIRECT_REGEXPS?: string

	/**
	 * Tools to enable: "all", "core" (default), "tool1,tool2", "+tool1" (add to core), "-tool1" (remove from core)
	 */
	readonly ENABLED_TOOLS: string

	/**
	 * Shared secret for the POST /orders endpoint. If unset, the endpoint is disabled.
	 */
	readonly ORDER_API_KEY?: string

	/**
	 * Schwab user ID used to derive the KV token key for the /orders endpoint
	 */
	readonly SCHWAB_USER_ID?: string

	/**
	 * Maximum notional value (price x quantity) per order in USD
	 */
	readonly ORDER_MAX_NOTIONAL?: number

	/**
	 * Comma-separated list of symbols allowed for /orders. If unset, all symbols allowed.
	 */
	readonly ORDER_SYMBOL_ALLOWLIST?: string

	/**
	 * Maximum number of orders per UTC day via /orders (default: 10)
	 */
	readonly ORDER_DAILY_CAP: number
}

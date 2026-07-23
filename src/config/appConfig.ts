import { z } from 'zod'
import { type Env, type ValidatedEnv } from '../../types/env'
import { logger } from '../shared/log'

const envSchema = z.object({
	SCHWAB_CLIENT_ID: z
		.string({
			required_error: 'SCHWAB_CLIENT_ID is required for OAuth authentication',
		})
		.min(1, 'SCHWAB_CLIENT_ID cannot be empty'),

	SCHWAB_CLIENT_SECRET: z
		.string({
			required_error:
				'SCHWAB_CLIENT_SECRET is required for OAuth authentication',
		})
		.min(1, 'SCHWAB_CLIENT_SECRET cannot be empty'),

	COOKIE_ENCRYPTION_KEY: z
		.string({
			required_error:
				'COOKIE_ENCRYPTION_KEY is required for secure cookie storage',
		})
		.min(1, 'COOKIE_ENCRYPTION_KEY cannot be empty'),

	SCHWAB_REDIRECT_URI: z
		.string({
			required_error: 'SCHWAB_REDIRECT_URI is required for OAuth callback',
		})
		.url('SCHWAB_REDIRECT_URI must be a valid URL'),

	OAUTH_KV: z.any().refine((v) => !!v, {
		message: 'OAUTH_KV binding is required for token storage',
	}),

	LOG_LEVEL: z
		.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
		.optional()
		.default('info'),

	ENVIRONMENT: z
		.enum(['development', 'staging', 'production'])
		.optional()
		.default('production'),

	ENABLED_TOOLS: z
		.string()
		.optional()
		.default('core')
		.describe(
			'Tools to enable: "all", "core" (default), "tool1,tool2", "+tool1,+tool2" (add to core), "-tool1" (remove from core)',
		),

	ORDER_API_KEY: z
		.string()
		.min(32, 'ORDER_API_KEY must be at least 32 characters')
		.optional()
		.describe(
			'Shared secret for the POST /orders endpoint. If unset, the endpoint is disabled.',
		),

	SCHWAB_USER_ID: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Schwab user ID used to derive the KV token key for the /orders endpoint',
		),

	ORDER_MAX_NOTIONAL: z
		.string()
		.optional()
		.transform((v) => (v ? Number(v) : undefined))
		.pipe(z.number().positive().optional())
		.describe('Maximum notional value (price x quantity) per order in USD'),

	ORDER_SYMBOL_ALLOWLIST: z
		.string()
		.optional()
		.describe(
			'Comma-separated list of symbols allowed for /orders. If unset, all symbols allowed.',
		),

	ORDER_DAILY_CAP: z
		.string()
		.optional()
		.default('10')
		.transform((v) => Number(v))
		.pipe(z.number().int().positive())
		.describe('Maximum number of orders per UTC day via /orders'),

	SLACK_BOT_TOKEN: z
		.string()
		.startsWith('xoxb-', 'SLACK_BOT_TOKEN must be a bot token (xoxb-...)')
		.optional()
		.describe('Slack bot token used to post drift proposals with approve buttons'),

	SLACK_SIGNING_SECRET: z
		.string()
		.min(16, 'SLACK_SIGNING_SECRET looks too short')
		.optional()
		.describe('Slack app signing secret for verifying /slack/interactions requests'),

	SLACK_CHANNEL_ID: z
		.string()
		.regex(/^[CG][A-Z0-9]+$/, 'SLACK_CHANNEL_ID must be a channel ID like C0123ABC')
		.optional()
		.describe('Channel where drift proposals are posted'),

	SLACK_APPROVER_IDS: z
		.string()
		.optional()
		.describe(
			'Comma-separated Slack member IDs (U...) allowed to approve/reject proposals',
		),
})

function buildConfigInternal(env: Env): ValidatedEnv {
	try {
		const validated = envSchema.parse(env)
		return Object.freeze(validated) as ValidatedEnv
	} catch (error) {
		if (error instanceof z.ZodError) {
			const issues = error.issues
				.map((issue) => {
					const path = issue.path.join('.')
					return `  - ${path}: ${issue.message}`
				})
				.join('\n')

			const msg = `Environment validation failed:\n${issues}`
			logger.error(msg)
			throw new Error(msg)
		}
		throw error
	}
}

// Memoized singleton config getter
export const getConfig = (() => {
	let cachedConfig: ValidatedEnv | null = null
	let cachedEnvHash: string | null = null

	return (env: Env): ValidatedEnv => {
		// Create a simple hash of the env object for memoization
		// Exclude OAUTH_PROVIDER to avoid circular reference issues
		const envHash = JSON.stringify(
			Object.keys(env)
				.filter((key) => key !== 'OAUTH_PROVIDER') // Exclude circular reference
				.sort()
				.map((key) => [key, (env as any)[key]]),
		)

		if (cachedConfig && cachedEnvHash === envHash) {
			return cachedConfig
		}

		cachedConfig = buildConfigInternal(env)
		cachedEnvHash = envHash
		return cachedConfig
	}
})()

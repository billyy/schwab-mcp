import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
	createApiClient,
	sanitizeKeyForLog,
	type SchwabApiClient,
	type EnhancedTokenManager,
	type SchwabApiLogger,
	type TokenData,
} from '@sudowealth/schwab-api'
import { DurableMCP } from 'workers-mcp'
import { type ValidatedEnv } from '../types/env'
import { SchwabHandler, initializeSchwabAuthClient } from './auth'
import { getConfig } from './config'
import { handleOrdersRequest } from './orders/handler'
import { handleProposalsRequest } from './proposals/handler'
import { handleSlackInteraction } from './proposals/interactions'
import { handleRebalanceSnapshot, handleSlackNotify } from './rebalance/handler'

// Durable Object class must be exported from the worker entry module
export { ProposalStore } from './proposals/store'
import {
	APP_NAME,
	API_ENDPOINTS,
	LOGGER_CONTEXTS,
	TOOL_NAMES,
	ENVIRONMENTS,
	CONTENT_TYPES,
	APP_SERVER_NAME,
} from './shared/constants'
import { makeKvTokenStore, type TokenIdentifiers } from './shared/kvTokenStore'
import { logger, buildLogger, type PinoLogLevel } from './shared/log'
import { logOnlyInDevelopment } from './shared/secureLogger'
import { createTool, toolError, toolSuccess } from './shared/toolBuilder'
import { HttpStreamTransport, mcpHttpHandler } from './streamableHttp'
import {
	allToolSpecs,
	type ToolSpec,
	parseEnabledTools,
	filterToolSpecs,
} from './tools'

/**
 * Returned when the Schwab authorization is dead but the MCP connection itself
 * is fine. The two legs fail independently, and the recovery for this one is the
 * refresh automation — so name it rather than surfacing an opaque 401.
 */
const SCHWAB_AUTH_ERROR_MESSAGE =
	'Schwab authorization is expired or revoked. The MCP connection itself is healthy — ' +
	'only the Schwab side needs re-authorizing. Recover by running: ' +
	'cd ~/git/schwab-mcp/automation && npm run refresh ' +
	'(add HEADED=1 if it reports that MFA needs a human).'

/**
 * DO props now contain only IDs needed for token key derivation
 * Tokens are stored exclusively in KV to prevent divergence
 */
type MyMCPProps = {
	/** Schwab user ID when available (preferred for token key) */
	schwabUserId?: string
	/** OAuth client ID (fallback for token key) */
	clientId?: string
}

export class MyMCP extends DurableMCP<MyMCPProps, Env> {
	private tokenManager!: EnhancedTokenManager
	private client!: SchwabApiClient
	private validatedConfig!: ValidatedEnv
	private mcpLogger = logger.child(LOGGER_CONTEXTS.MCP_DO)
	/** Set when the Schwab token could not be loaded/refreshed at init time. */
	private authDegraded = false
	private httpTransport?: HttpStreamTransport

	server = new McpServer({
		name: APP_NAME,
		version: '0.0.1',
	})

	async init() {
		try {
			// Register a minimal tool synchronously to ensure Claude Desktop detects tools
			this.server.tool(
				TOOL_NAMES.STATUS,
				'Check Schwab MCP server status',
				{},
				async () => ({
					content: [
						{
							type: CONTENT_TYPES.TEXT,
							text: `${APP_SERVER_NAME} is running. Use tool discovery to see all available tools.`,
						},
					],
				}),
			)
			this.validatedConfig = getConfig(this.env)
			// Initialize logger with configured level
			const logLevel = this.validatedConfig.LOG_LEVEL as PinoLogLevel
			const newLogger = buildLogger(logLevel)
			// Replace the singleton logger instance
			Object.assign(logger, newLogger)
			const redirectUri = this.validatedConfig.SCHWAB_REDIRECT_URI

			this.mcpLogger.debug('[MyMCP.init] STEP 0: Start')
			this.mcpLogger.debug('[MyMCP.init] STEP 1: Env initialized.')

			// Create KV token store - single source of truth
			const kvToken = makeKvTokenStore(this.validatedConfig.OAUTH_KV)

			// Ensure clientId is stored in props for token key derivation
			if (!this.props.clientId) {
				this.props.clientId = this.validatedConfig.SCHWAB_CLIENT_ID
				this.props = { ...this.props }
			}

			const getTokenIds = (): TokenIdentifiers => ({
				schwabUserId: this.props.schwabUserId,
				clientId: this.props.clientId,
			})

			// Debug token IDs during initialization
			logOnlyInDevelopment(
				this.mcpLogger,
				'debug',
				'[MyMCP.init] Token identifiers',
				{
					hasSchwabUserId: !!this.props.schwabUserId,
					hasClientId: !!this.props.clientId,
					expectedKeyPrefix: sanitizeKeyForLog(kvToken.kvKey(getTokenIds())),
				},
			)

			// Token save function uses KV store exclusively
			const saveTokenForETM = async (tokenSet: TokenData) => {
				const tokenIds = getTokenIds()
				await kvToken.save(tokenIds, tokenSet)
				await kvToken.saveTimestamp(tokenIds)
				this.mcpLogger.debug('ETM: Token save to KV complete', {
					keyPrefix: sanitizeKeyForLog(kvToken.kvKey(tokenIds)),
				})
			}

			// Token load function uses KV store exclusively
			const loadTokenForETM = async (): Promise<TokenData | null> => {
				const tokenIds = getTokenIds()
				this.mcpLogger.debug('[ETM Load] Attempting to load token', {
					hasSchwabUserId: !!tokenIds.schwabUserId,
					hasClientId: !!tokenIds.clientId,
					expectedKeyPrefix: sanitizeKeyForLog(kvToken.kvKey(tokenIds)),
				})

				let tokenData = await kvToken.load(tokenIds)
				this.mcpLogger.debug('ETM: Token load from KV complete', {
					keyPrefix: sanitizeKeyForLog(kvToken.kvKey(tokenIds)),
				})

				if (tokenData) {
					const stale = await kvToken.isTokenStale(tokenIds)
					if (stale) {
						this.mcpLogger.warn(
							'Refresh token is stale (>7 days), clearing token to trigger re-auth',
							{ keyPrefix: sanitizeKeyForLog(kvToken.kvKey(tokenIds)) },
						)
						await kvToken.clearToken(tokenIds)
						tokenData = null
					}
				}

				// Fallback: schwabUserId rotates on every re-auth, so the refresh
				// automation writes fresh tokens under NEW keys this session's ids
				// can't see. Adopt the freshest token in KV and copy it to our key
				// so subsequent ETM saves land somewhere consistent.
				if (!tokenData) {
					const freshest = await kvToken.loadFreshest()
					if (freshest) {
						this.mcpLogger.info(
							'Own token key empty/stale — adopting freshest KV token',
							{ keyPrefix: sanitizeKeyForLog(kvToken.kvKey(tokenIds)) },
						)
						await kvToken.save(tokenIds, freshest)
						await kvToken.saveTimestamp(tokenIds)
						tokenData = freshest
					}
				}

				return tokenData
			}

			this.mcpLogger.debug(
				'[MyMCP.init] STEP 2: Storage and event handlers defined.',
			)

			// 1. Create ETM instance (synchronous)
			const hadExistingTokenManager = !!this.tokenManager
			this.mcpLogger.debug('[MyMCP.init] STEP 3A: ETM instance setup', {
				hadExisting: hadExistingTokenManager,
			})
			if (!this.tokenManager) {
				this.tokenManager = initializeSchwabAuthClient(
					this.validatedConfig,
					redirectUri,
					loadTokenForETM,
					saveTokenForETM,
				) // This is synchronous
			}
			this.mcpLogger.debug('[MyMCP.init] STEP 3B: ETM instance ready', {
				wasReused: hadExistingTokenManager,
			})

			const mcpLogger: SchwabApiLogger = {
				debug: (message: string, ...args: any[]) =>
					this.mcpLogger.debug(message, args.length > 0 ? args[0] : undefined),
				info: (message: string, ...args: any[]) =>
					this.mcpLogger.info(message, args.length > 0 ? args[0] : undefined),
				warn: (message: string, ...args: any[]) =>
					this.mcpLogger.warn(message, args.length > 0 ? args[0] : undefined),
				error: (message: string, ...args: any[]) =>
					this.mcpLogger.error(message, args.length > 0 ? args[0] : undefined),
			}
			this.mcpLogger.debug('[MyMCP.init] STEP 4: MCP Logger adapted.')

			// 2. Proactively initialize ETM to load tokens BEFORE creating client
			this.mcpLogger.debug(
				'[MyMCP.init] STEP 5A: Proactively calling this.tokenManager.initialize() (async)...',
			)
			const etmInitSuccess = await this.tokenManager.initialize()
			this.mcpLogger.debug(
				`[MyMCP.init] STEP 5B: Proactive ETM initialization complete. Success: ${etmInitSuccess}`,
			)
			// Remember a failed init so tools can say WHY they are failing instead
			// of each one surfacing its own opaque SDK error.
			this.authDegraded = !etmInitSuccess
			if (this.authDegraded) {
				this.mcpLogger.warn(
					'ETM initialization failed — Schwab auth is degraded; tools will return the re-auth instructions',
				)
			}

			// 2.5. Auto-migrate tokens if we have schwabUserId but token was loaded from clientId key
			if (this.props.schwabUserId && this.props.clientId) {
				await kvToken.migrateIfNeeded(
					{ clientId: this.props.clientId },
					{ schwabUserId: this.props.schwabUserId },
				)
				this.mcpLogger.debug('[MyMCP.init] STEP 5C: Token migration completed')
			}

			// 3. Create SchwabApiClient AFTER tokens are loaded
			this.client = createApiClient({
				config: {
					environment: ENVIRONMENTS.PRODUCTION,
					logger: mcpLogger,
					enableLogging: true,
					logLevel:
						this.validatedConfig.ENVIRONMENT === 'production'
							? 'error'
							: 'debug',
				},
				auth: this.tokenManager,
			})
			this.mcpLogger.debug('[MyMCP.init] STEP 6: SchwabApiClient ready.')

			// 4. Register tools (this.server.tool calls are synchronous)
			// Filter tools based on ENABLED_TOOLS configuration
			const enabledTools = parseEnabledTools(this.validatedConfig.ENABLED_TOOLS)
			const filteredToolSpecs = filterToolSpecs(allToolSpecs, enabledTools)

			this.mcpLogger.debug('[MyMCP.init] STEP 7A: Calling registerTools...', {
				enabledToolsConfig: this.validatedConfig.ENABLED_TOOLS,
				totalTools: allToolSpecs.length,
				enabledCount: filteredToolSpecs.length,
				enabledNames: filteredToolSpecs.map((s) => s.name),
			})
			filteredToolSpecs.forEach((spec: ToolSpec<any>) => {
				createTool(this.client, this.server, {
					name: spec.name,
					description: spec.description,
					schema: spec.schema,
					handler: async (params, c) => {
						// Init found no usable Schwab token. Retry once before giving up:
						// the refresh automation may have written a fresh token since
						// (loadTokenForETM adopts the freshest on reload), and a long-lived
						// Desktop session must be able to recover without a reconnect.
						if (this.authDegraded) {
							this.authDegraded = !(await this.tokenManager
								.initialize()
								.catch(() => false))
							if (this.authDegraded) {
								return toolError(SCHWAB_AUTH_ERROR_MESSAGE, {
									source: spec.name,
									schwabAuthRequired: true,
								})
							}
							this.mcpLogger.info(
								'Schwab auth recovered on retry — a fresh token appeared in KV',
							)
						}
						try {
							const data = await spec.call(c, params)
							return toolSuccess({
								data,
								source: spec.name,
								message: `Successfully executed ${spec.name}`,
							})
						} catch (error) {
							// Clear the stale token on 401 so the next load re-adopts the
							// freshest KV token (or fails loudly if there isn't one).
							const status =
								(error as any)?.status ?? (error as any)?.httpStatus
							if (status === 401) {
								this.mcpLogger.warn(
									'Received 401 from Schwab API, clearing token so the next load re-adopts',
									{ tool: spec.name },
								)
								// Deliberately NOT latching authDegraded here: clearToken has
								// set up the next load to adopt the freshest KV token, and
								// latching would block that self-healing on the next call.
								await kvToken.clearToken(getTokenIds())
								return toolError(SCHWAB_AUTH_ERROR_MESSAGE, {
									source: spec.name,
									schwabAuthRequired: true,
									originalError:
										error instanceof Error ? error.message : String(error),
								})
							}
							return toolError(error, { source: spec.name })
						}
					},
				})
			})
			this.mcpLogger.debug('[MyMCP.init] STEP 7B: registerTools completed.')
			this.mcpLogger.debug(
				'[MyMCP.init] STEP 8: MyMCP.init FINISHED SUCCESSFULLY',
			)
		} catch (error: any) {
			this.mcpLogger.error(
				'[MyMCP.init] FINAL CATCH: UNHANDLED EXCEPTION in init()',
				{
					error: error.message,
					stack: error.stack,
				},
			)
			throw error // Re-throw to ensure DO framework sees the failure
		}
	}

	async onReconnect() {
		this.mcpLogger.info('Handling reconnection in MyMCP instance')
		try {
			if (!this.tokenManager) {
				this.mcpLogger.warn(
					'Token manager not initialized, attempting full initialization',
				)
				await this.init()
				return true
			}
			this.mcpLogger.info('Attempting reconnection via token manager')

			try {
				this.mcpLogger.info('Attempting to fetch access token as recovery test')
				const token = await this.tokenManager.getAccessToken()
				if (token) {
					this.mcpLogger.info(
						'Successfully retrieved access token during reconnection',
					)
					return true
				}
			} catch (tokenError) {
				this.mcpLogger.warn('Failed to get access token during reconnection', {
					error:
						tokenError instanceof Error
							? tokenError.message
							: String(tokenError),
				})
			}

			try {
				this.mcpLogger.info(
					'Attempting proactive reinitialization of token manager',
				)
				const initResult = await this.tokenManager.initialize()
				this.mcpLogger.info(
					`Token manager reinitialization ${initResult ? 'succeeded' : 'failed'}`,
				)
				if (initResult) {
					return true
				}
			} catch (initError) {
				this.mcpLogger.warn('Token manager reinitialization failed', {
					error:
						initError instanceof Error ? initError.message : String(initError),
				})
			}

			try {
				this.mcpLogger.info('Token manager state during reconnection', {
					hasTokenManager: !!this.tokenManager,
				})
			} catch (stateError) {
				this.mcpLogger.warn(
					'Failed to check token manager state during reconnection',
					{
						error:
							stateError instanceof Error
								? stateError.message
								: String(stateError),
					},
				)
			}

			this.mcpLogger.warn(
				'Reconnection recovery attempts failed, performing full reinitialization',
			)
			await this.init()
			return true
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const stack = error instanceof Error ? error.stack : undefined
			this.mcpLogger.error('Critical error during reconnection handling', {
				error: message,
				stack,
			})
			try {
				this.mcpLogger.warn(
					'Attempting emergency reinitialization after reconnection failure',
				)
				await this.init()
				return true
			} catch (initError) {
				const initMessage =
					initError instanceof Error ? initError.message : String(initError)
				this.mcpLogger.error('Emergency reinitialization also failed', {
					error: initMessage,
				})
				return false
			}
		}
	}

	async onSSE(event: any) {
		this.mcpLogger.info('SSE connection established or reconnected')
		await this.onReconnect()
		return await super.onSSE(event)
	}

	async onMessage(request: Request) {
		if (!(this as any).transport) {
			this.mcpLogger.warn(
				'POST /sse/message received with no active transport (DO evicted or restarted); instructing client to reconnect',
			)
			return new Response('SSE session expired, please reconnect', {
				status: 410,
			})
		}
		return await super.onMessage(request)
	}

	/**
	 * Streamable HTTP entry point. Invoked by the /mcp ExportedHandler via DO RPC.
	 * Lazily initializes the DO and connects a single shared HttpStreamTransport
	 * to the McpServer, then dispatches the inbound JSON-RPC message.
	 */
	async handleStreamableHttp(
		props: MyMCPProps,
		message: JSONRPCMessage,
	): Promise<JSONRPCMessage | null> {
		if (!(this as any).initRun) {
			this.props = { ...this.props, ...props }
			;(this as any).initRun = true
			await this.init()
		} else if (props && Object.keys(props).length > 0) {
			this.props = { ...this.props, ...props }
		}

		if (!this.httpTransport) {
			this.httpTransport = new HttpStreamTransport()
			await this.server.connect(this.httpTransport)
		}

		return await this.httpTransport.dispatch(message)
	}
}

const oauthProvider = new OAuthProvider({
	apiHandlers: {
		[API_ENDPOINTS.SSE]: MyMCP.mount(API_ENDPOINTS.SSE) as any,
		[API_ENDPOINTS.MCP]: mcpHttpHandler as any,
	},
	defaultHandler: SchwabHandler as any, // Cast remains
	authorizeEndpoint: API_ENDPOINTS.AUTHORIZE,
	tokenEndpoint: API_ENDPOINTS.TOKEN,
	clientRegistrationEndpoint: API_ENDPOINTS.REGISTER,
})

/**
 * The MCP grant (Desktop <-> this worker) is deliberately NOT tied to the health
 * of the Schwab token. They are independent OAuth legs:
 *
 *   - The Schwab leg is refreshed by automation/ (Wed+Sun) and self-heals via
 *     loadFreshest(). Its staleness is handled in loadTokenForETM() above.
 *   - The MCP leg self-heals on its own: the OAuth provider issues a rotating
 *     refresh token, and mcp-remote exchanges it automatically on any 401.
 *
 * A previous clearStaleGrant() deleted the MCP grant whenever the Schwab token
 * happened to be stale. Deleting a grant is irreversible: mcp-remote's refresh
 * token starts returning invalid_grant, it discards its own tokens, and only an
 * interactive browser re-auth can recover — so a TRANSIENT Schwab gap (Mac off,
 * tunnel down, a failed refresh run) permanently broke the Desktop connection
 * long after the Schwab side had healed. It also ran on /token, where it could
 * delete the grant mid-way through the very refresh that would have healed the
 * session. When the Schwab token is genuinely dead the recovery path is the
 * refresh automation, not destroying the transport's credentials, so tool calls
 * surface SCHWAB_AUTH_ERROR_MESSAGE instead.
 */

export default {
	async fetch(
		request: Request,
		env: Env & { MCP_OBJECT: DurableObjectNamespace },
		ctx: ExecutionContext,
	) {
		const url = new URL(request.url)

		// Programmatic order endpoint — API-key authed, bypasses the OAuth provider
		if (url.pathname === API_ENDPOINTS.ORDERS) {
			return handleOrdersRequest(request, env)
		}

		// Drift-approval endpoints — proposals are API-key authed; the Slack
		// interactions callback is authenticated by Slack's request signature
		if (url.pathname === API_ENDPOINTS.PROPOSALS) {
			return handleProposalsRequest(request, env)
		}
		if (url.pathname === API_ENDPOINTS.SLACK_INTERACTIONS) {
			return handleSlackInteraction(request, env, ctx)
		}
		if (url.pathname === API_ENDPOINTS.REBALANCE_SNAPSHOT) {
			return handleRebalanceSnapshot(request, env)
		}
		if (url.pathname === API_ENDPOINTS.SLACK_NOTIFY) {
			return handleSlackNotify(request, env)
		}

		return (oauthProvider as any).fetch(request, env, ctx)
	},
} satisfies ExportedHandler<Env & { MCP_OBJECT: DurableObjectNamespace }>

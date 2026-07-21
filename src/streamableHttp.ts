import {
	type Transport,
	type TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js'
import { type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { LOGGER_CONTEXTS } from './shared/constants'
import { logger } from './shared/log'

const httpLogger = logger.child(LOGGER_CONTEXTS.MCP_DO)

const REQUEST_TIMEOUT_MS = 30_000

/**
 * Minimal Streamable HTTP transport for MCP, suitable for Cloudflare Workers.
 *
 * Supports the request/response half of the Streamable HTTP spec only. Each
 * incoming JSON-RPC request is dispatched into the connected McpServer and the
 * matching response is awaited via id correlation.
 *
 * Server-initiated streams (GET /mcp) and resumption tokens are not implemented.
 */
export class HttpStreamTransport implements Transport {
	onmessage?: (message: JSONRPCMessage) => void
	onerror?: (error: Error) => void
	onclose?: () => void
	sessionId?: string

	private resolvers = new Map<string, (response: JSONRPCMessage) => void>()

	async start(): Promise<void> {}

	async close(): Promise<void> {
		this.onclose?.()
	}

	async send(
		message: JSONRPCMessage,
		_options?: TransportSendOptions,
	): Promise<void> {
		const anyMsg = message as any
		const isResponse =
			anyMsg.id !== undefined &&
			anyMsg.id !== null &&
			anyMsg.method === undefined
		if (!isResponse) return
		const id = String(anyMsg.id)
		const resolver = this.resolvers.get(id)
		if (resolver) {
			this.resolvers.delete(id)
			resolver(message)
		}
	}

	/**
	 * Dispatch a single JSON-RPC message to the connected server.
	 * Returns the matching response, or null for notifications.
	 */
	async dispatch(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
		const anyMsg = message as any
		const isNotification = anyMsg.id === undefined || anyMsg.id === null
		if (isNotification) {
			this.onmessage?.(message)
			return null
		}
		const id = String(anyMsg.id)
		return await new Promise<JSONRPCMessage | null>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (this.resolvers.has(id)) {
					this.resolvers.delete(id)
					reject(new Error(`MCP request ${id} timed out`))
				}
			}, REQUEST_TIMEOUT_MS)
			this.resolvers.set(id, (response) => {
				clearTimeout(timeout)
				resolve(response)
			})
			try {
				this.onmessage?.(message)
			} catch (err) {
				clearTimeout(timeout)
				this.resolvers.delete(id)
				reject(err instanceof Error ? err : new Error(String(err)))
			}
		})
	}
}

type StreamableHttpEnv = Env & { MCP_OBJECT: DurableObjectNamespace }

const SESSION_HEADER = 'Mcp-Session-Id'

function jsonRpcError(code: number, message: string, id: any = null, status = 400) {
	return Response.json(
		{ jsonrpc: '2.0', error: { code, message }, id },
		{ status },
	)
}

/**
 * ExportedHandler-shaped fetch handler for the Streamable HTTP `/mcp` route.
 * OAuthProvider invokes this for authenticated requests; ctx.props carries the
 * grant's stored props (schwabUserId, clientId) populated by SchwabHandler.
 */
export const mcpHttpHandler = {
	async fetch(
		request: Request,
		env: StreamableHttpEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname !== '/mcp') {
			return new Response('Not found', { status: 404 })
		}

		if (request.method === 'GET' || request.method === 'DELETE') {
			return new Response('Method not allowed', { status: 405 })
		}
		if (request.method !== 'POST') {
			return new Response('Method not allowed', { status: 405 })
		}

		let body: any
		try {
			body = await request.json()
		} catch {
			return jsonRpcError(-32700, 'Parse error', null, 400)
		}

		if (Array.isArray(body)) {
			return jsonRpcError(
				-32600,
				'Batched requests are not supported',
				null,
				400,
			)
		}
		if (!body || typeof body !== 'object') {
			return jsonRpcError(-32600, 'Invalid Request', null, 400)
		}

		let sessionId = request.headers.get(SESSION_HEADER) ?? undefined
		const isInit = body.method === 'initialize'

		if (!sessionId) {
			if (isInit) {
				sessionId = crypto.randomUUID()
			} else {
				return jsonRpcError(
					-32000,
					`Missing ${SESSION_HEADER} header`,
					body.id ?? null,
					400,
				)
			}
		}

		const ns = env.MCP_OBJECT
		const id = ns.idFromName(`http:${sessionId}`)
		const stub = ns.get(id) as unknown as {
			handleStreamableHttp(
				props: any,
				message: JSONRPCMessage,
			): Promise<JSONRPCMessage | null>
		}

		const props = (ctx as any).props ?? {}

		try {
			const responseMessage = await stub.handleStreamableHttp(props, body)
			if (responseMessage === null) {
				return new Response(null, {
					status: 202,
					headers: { [SESSION_HEADER]: sessionId },
				})
			}
			return Response.json(responseMessage, {
				headers: { [SESSION_HEADER]: sessionId },
			})
		} catch (err) {
			httpLogger.error('Streamable HTTP dispatch failed', {
				error: err instanceof Error ? err.message : String(err),
				sessionId,
			})
			return jsonRpcError(
				-32603,
				err instanceof Error ? err.message : 'Internal error',
				body.id ?? null,
				500,
			)
		}
	},
} satisfies ExportedHandler<StreamableHttpEnv>

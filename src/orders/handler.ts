import {
	createApiClient,
	PlaceOrderParams,
	buildAccountDisplayMap,
	scrubAccountIdentifiers,
	type SchwabApiClient,
} from '@sudowealth/schwab-api'
import { type Env, type ValidatedEnv } from '../../types/env'
import { initializeSchwabAuthClient } from '../auth'
import { getConfig } from '../config'
import {
	ENVIRONMENTS,
	LOGGER_CONTEXTS,
	ORDER_AUDIT_KEY_PREFIX,
	ORDER_COUNT_KEY_PREFIX,
	ORDER_AUDIT_TTL_SECONDS,
	SCHWAB_API_BASE_URL,
} from '../shared/constants'
import { makeKvTokenStore } from '../shared/kvTokenStore'
import { logger } from '../shared/log'
import { withOrderAliases } from '../shared/orderAliases'

const ordersLogger = logger.child(LOGGER_CONTEXTS.ORDERS)

/** Order statuses that count as "open" for duplicate detection */
const OPEN_ORDER_STATUSES = new Set([
	'AWAITING_PARENT_ORDER',
	'AWAITING_CONDITION',
	'AWAITING_STOP_CONDITION',
	'AWAITING_MANUAL_REVIEW',
	'ACCEPTED',
	'PENDING_ACTIVATION',
	'QUEUED',
	'WORKING',
	'NEW',
	'AWAITING_RELEASE_TIME',
	'PENDING_ACKNOWLEDGEMENT',
])

const OrderRequestSchema = withOrderAliases(PlaceOrderParams)

interface OrdersRequestBody {
	/** The order, in PlaceOrderParams shape (aliases like LMT/GTC/BTO accepted) */
	order?: unknown
	/** true = place the order for real; false/absent = preview only */
	submit?: boolean
	/** Required for submit: the orderHash returned by the preview call */
	orderHash?: string
	/** Skip the duplicate-open-order check (explicit override) */
	allowDuplicate?: boolean
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

/** Constant-time comparison via SHA-256 digests (equal-length inputs for the XOR loop) */
async function secureCompare(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder()
	const [digestA, digestB] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(a)),
		crypto.subtle.digest('SHA-256', encoder.encode(b)),
	])
	const bytesA = new Uint8Array(digestA)
	const bytesB = new Uint8Array(digestB)
	let diff = 0
	for (let i = 0; i < bytesA.length; i++) {
		diff |= bytesA[i]! ^ bytesB[i]!
	}
	return diff === 0
}

/** Deterministic hash of the validated order, used to bind submit to a prior preview */
async function hashOrder(order: Record<string, unknown>): Promise<string> {
	const canonical = JSON.stringify(order, Object.keys(order).sort())
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonical),
	)
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

/** Extract symbols from all order legs */
function extractSymbols(order: any): string[] {
	const legs: any[] = order.orderLegCollection ?? []
	return legs
		.map((leg) => leg?.instrument?.symbol)
		.filter((s): s is string => typeof s === 'string')
}

/**
 * Estimate the order's notional value. Options contracts are multiplied by 100.
 * Returns null when there is no price to bound (e.g. MARKET orders).
 */
function estimateNotional(order: any): number | null {
	const price = typeof order.price === 'number' ? order.price : null
	if (price === null) return null
	const legs: any[] = order.orderLegCollection ?? []
	let total = 0
	for (const leg of legs) {
		const qty = typeof leg?.quantity === 'number' ? leg.quantity : 0
		const multiplier = leg?.instrument?.assetType === 'OPTION' ? 100 : 1
		total += price * qty * multiplier
	}
	return total
}

/** Check open orders on the account for one matching symbol/instruction/quantity/price */
async function findDuplicateOpenOrder(
	client: SchwabApiClient,
	accountHash: string,
	order: any,
): Promise<any | null> {
	const now = new Date()
	const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
	const openOrders = await client.trader.orders.getOrdersByAccount({
		pathParams: { accountNumber: accountHash },
		queryParams: {
			fromEnteredTime: dayAgo.toISOString(),
			toEnteredTime: now.toISOString(),
		},
	})
	const candidateLegs = order.orderLegCollection ?? []
	for (const existing of openOrders as any[]) {
		if (!OPEN_ORDER_STATUSES.has(existing?.status)) continue
		if (existing.orderType !== order.orderType) continue
		if ((existing.price ?? null) !== (order.price ?? null)) continue
		const existingLegs = existing.orderLegCollection ?? []
		if (existingLegs.length !== candidateLegs.length) continue
		const legsMatch = candidateLegs.every((leg: any, i: number) => {
			const other = existingLegs[i]
			return (
				other?.instrument?.symbol === leg?.instrument?.symbol &&
				other?.instruction === leg?.instruction &&
				other?.quantity === leg?.quantity
			)
		})
		if (legsMatch) return existing
	}
	return null
}

/** Call Schwab's previewOrder endpoint (not wrapped by the SDK) via raw fetch */
async function previewOrder(
	accessToken: string,
	accountHash: string,
	orderBody: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
	const res = await fetch(
		`${SCHWAB_API_BASE_URL}/trader/v1/accounts/${accountHash}/previewOrder`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(orderBody),
		},
	)
	const text = await res.text()
	let body: unknown
	try {
		body = text ? JSON.parse(text) : null
	} catch {
		body = text
	}
	return { status: res.status, body }
}

/** Enforce the per-UTC-day submitted-order cap stored in KV */
async function checkAndIncrementDailyCap(
	kv: KVNamespace,
	cap: number,
	increment: boolean,
): Promise<{ ok: boolean; count: number }> {
	const day = new Date().toISOString().slice(0, 10)
	const key = `${ORDER_COUNT_KEY_PREFIX}${day}`
	const count = Number((await kv.get(key)) ?? '0')
	if (count >= cap) return { ok: false, count }
	if (increment) {
		await kv.put(key, String(count + 1), {
			expirationTtl: 2 * 24 * 60 * 60,
		})
	}
	return { ok: true, count: count + (increment ? 1 : 0) }
}

/** Build an authenticated Schwab API client from the KV-stored token */
async function buildClient(
	config: ValidatedEnv,
): Promise<
	| { client: SchwabApiClient; getAccessToken: () => Promise<string | null> }
	| { error: Response }
> {
	const kvToken = makeKvTokenStore(config.OAUTH_KV)
	const tokenIds = { schwabUserId: config.SCHWAB_USER_ID }

	// schwabUserId rotates per re-auth, so the static SCHWAB_USER_ID key goes
	// stale after every automation refresh — fall back to the freshest token.
	let existing = await kvToken.load(tokenIds)
	if (!existing) {
		existing = await kvToken.loadFreshest()
		if (existing) {
			await kvToken.save(tokenIds, existing)
			await kvToken.saveTimestamp(tokenIds)
		}
	}
	if (!existing) {
		return {
			error: jsonResponse(401, {
				error:
					'No usable Schwab token found in KV. Complete the OAuth flow (or run the automation refresh) first.',
			}),
		}
	}

	const tokenManager = initializeSchwabAuthClient(
		config,
		config.SCHWAB_REDIRECT_URI,
		() => kvToken.load(tokenIds),
		async (tokenData) => {
			await kvToken.save(tokenIds, tokenData)
			await kvToken.saveTimestamp(tokenIds)
		},
	)
	const initialized = await tokenManager.initialize()
	if (!initialized) {
		return {
			error: jsonResponse(401, {
				error: 'Schwab token manager failed to initialize (token expired?).',
			}),
		}
	}

	const client = createApiClient({
		config: {
			environment: ENVIRONMENTS.PRODUCTION,
			enableLogging: true,
			logLevel: config.ENVIRONMENT === 'production' ? 'error' : 'debug',
		},
		auth: tokenManager,
	})
	return { client, getAccessToken: () => tokenManager.getAccessToken() }
}

/**
 * POST /orders — programmatic order preview/submission, independent of the MCP/LLM path.
 *
 * Auth: `Authorization: Bearer <ORDER_API_KEY>` (constant-time compared).
 * Flow: call once with `submit: false` (default) to validate + get Schwab's
 * preview and an `orderHash`; call again with `submit: true` and that
 * `orderHash` to place the order. Server-side limits (symbol allowlist, max
 * notional, daily cap, duplicate detection) apply to every submit.
 */
export async function handleOrdersRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'Method not allowed. Use POST.' })
	}

	const config = getConfig(env)
	if (!config.ORDER_API_KEY || !config.SCHWAB_USER_ID) {
		return jsonResponse(503, {
			error:
				'Orders endpoint disabled. Set ORDER_API_KEY and SCHWAB_USER_ID secrets to enable.',
		})
	}

	// --- Authentication (constant-time) ---
	const authHeader = request.headers.get('Authorization') ?? ''
	const providedKey = authHeader.startsWith('Bearer ')
		? authHeader.substring(7)
		: ''
	if (!providedKey || !(await secureCompare(providedKey, config.ORDER_API_KEY))) {
		ordersLogger.warn('Orders endpoint: rejected request with bad API key')
		return jsonResponse(401, { error: 'Unauthorized' })
	}

	// --- Parse & validate ---
	let body: OrdersRequestBody
	try {
		body = (await request.json()) as OrdersRequestBody
	} catch {
		return jsonResponse(400, { error: 'Invalid JSON body' })
	}

	const parsed = OrderRequestSchema.safeParse(body.order)
	if (!parsed.success) {
		return jsonResponse(400, {
			error: 'Order failed validation against PlaceOrderParams',
			issues: parsed.error.issues.map((i) => ({
				path: i.path.join('.'),
				message: i.message,
			})),
		})
	}
	const { accountNumber: requestedAccount, ...orderBody } = parsed.data as any
	const submit = body.submit === true

	// --- Server-side limits (apply to preview too, so problems surface early) ---
	const symbols = extractSymbols(orderBody)
	if (symbols.length === 0) {
		return jsonResponse(400, { error: 'Order has no instrument symbols' })
	}
	if (config.ORDER_SYMBOL_ALLOWLIST) {
		const allowlist = new Set(
			config.ORDER_SYMBOL_ALLOWLIST.split(',').map((s) => s.trim().toUpperCase()),
		)
		// Options symbols embed the underlying (e.g. "AAPL  250815C00200000") — check the root
		const blocked = symbols.filter(
			(s) => !allowlist.has(s.split(' ')[0]!.toUpperCase()),
		)
		if (blocked.length > 0) {
			return jsonResponse(403, {
				error: `Symbol(s) not in ORDER_SYMBOL_ALLOWLIST: ${blocked.join(', ')}`,
			})
		}
	}
	if (config.ORDER_MAX_NOTIONAL !== undefined) {
		const notional = estimateNotional(orderBody)
		if (notional === null) {
			return jsonResponse(403, {
				error:
					'Orders without a limit price (e.g. MARKET) are not allowed while ORDER_MAX_NOTIONAL is set — the notional cannot be bounded.',
			})
		}
		if (notional > config.ORDER_MAX_NOTIONAL) {
			return jsonResponse(403, {
				error: `Estimated notional $${notional.toFixed(2)} exceeds ORDER_MAX_NOTIONAL $${config.ORDER_MAX_NOTIONAL}`,
			})
		}
	}

	// --- Authenticated client from KV token ---
	const built = await buildClient(config)
	if ('error' in built) return built.error
	const { client, getAccessToken } = built

	// --- Resolve account (accepts plain account number or hashValue) ---
	const accountNumbers = await client.trader.accounts.getAccountNumbers()
	const byPlain = accountNumbers.find(
		(a) => a.accountNumber === requestedAccount,
	)
	const byHash = accountNumbers.find((a) => a.hashValue === requestedAccount)
	const accountHash = byPlain?.hashValue ?? byHash?.hashValue
	if (!accountHash) {
		return jsonResponse(400, {
			error: 'accountNumber does not match any account (plain or hashValue) on this login',
		})
	}

	const orderHash = await hashOrder(orderBody)
	const displayMap = await buildAccountDisplayMap(client)

	// --- Preview path ---
	if (!submit) {
		const accessToken = await getAccessToken()
		let preview: { status: number; body: unknown } | { error: string }
		if (accessToken) {
			try {
				preview = await previewOrder(accessToken, accountHash, orderBody)
			} catch (error) {
				preview = {
					error: `previewOrder call failed: ${error instanceof Error ? error.message : String(error)}`,
				}
			}
		} else {
			preview = { error: 'Could not obtain access token for preview' }
		}
		const duplicate = await findDuplicateOpenOrder(client, accountHash, orderBody)
		return jsonResponse(200, {
			mode: 'preview',
			orderHash,
			order: orderBody,
			schwabPreview: scrubAccountIdentifiers(preview, displayMap),
			duplicateOpenOrder: duplicate
				? scrubAccountIdentifiers(duplicate, displayMap)
				: null,
			next: 'POST again with {"submit": true, "orderHash": "<orderHash>"} to place this order.',
		})
	}

	// --- Submit path ---
	if (body.orderHash !== orderHash) {
		return jsonResponse(409, {
			error:
				'orderHash missing or does not match this order. Preview first (submit: false) and pass back the returned orderHash.',
			expectedOrderHash: orderHash,
		})
	}

	if (!body.allowDuplicate) {
		const duplicate = await findDuplicateOpenOrder(client, accountHash, orderBody)
		if (duplicate) {
			return jsonResponse(409, {
				error:
					'An identical open order already exists. Pass "allowDuplicate": true to override.',
				duplicateOpenOrder: scrubAccountIdentifiers(duplicate, displayMap),
			})
		}
	}

	const cap = await checkAndIncrementDailyCap(
		config.OAUTH_KV,
		config.ORDER_DAILY_CAP,
		false,
	)
	if (!cap.ok) {
		return jsonResponse(429, {
			error: `Daily order cap reached (${config.ORDER_DAILY_CAP} orders/day)`,
		})
	}

	ordersLogger.info('[orders] Submitting order', {
		orderType: orderBody.orderType,
		symbols,
		orderHash,
	})
	try {
		const result = await client.trader.orders.placeOrderForAccount({
			pathParams: { accountNumber: accountHash },
			body: orderBody,
		})
		await checkAndIncrementDailyCap(config.OAUTH_KV, config.ORDER_DAILY_CAP, true)

		// Audit log (90-day retention)
		const auditKey = `${ORDER_AUDIT_KEY_PREFIX}${new Date().toISOString()}:${orderHash.slice(0, 8)}`
		await config.OAUTH_KV.put(
			auditKey,
			JSON.stringify({
				submittedAt: new Date().toISOString(),
				orderHash,
				order: orderBody,
				result,
			}),
			{ expirationTtl: ORDER_AUDIT_TTL_SECONDS },
		)

		ordersLogger.info('[orders] Order placed successfully', { orderHash })
		return jsonResponse(200, {
			mode: 'submitted',
			orderHash,
			result: scrubAccountIdentifiers(result, displayMap),
		})
	} catch (error: any) {
		ordersLogger.error('[orders] Order submission failed', {
			message: error?.message,
			status: error?.status,
			body: error?.body,
			orderHash,
		})
		return jsonResponse(error?.status && error.status >= 400 ? 502 : 500, {
			error: `Order submission failed: ${error?.message ?? String(error)}`,
			schwabStatus: error?.status,
			schwabBody: error?.body,
		})
	}
}

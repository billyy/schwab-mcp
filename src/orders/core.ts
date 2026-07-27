import {
	createApiClient,
	PlaceOrderParams,
	buildAccountDisplayMap,
	type SchwabApiClient,
} from '@sudowealth/schwab-api'
import { type ValidatedEnv } from '../../types/env'
import { initializeSchwabAuthClient } from '../auth'
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
export const OPEN_ORDER_STATUSES = new Set([
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

export const OrderRequestSchema = withOrderAliases(PlaceOrderParams)

export type AccountDisplayMap = Awaited<
	ReturnType<typeof buildAccountDisplayMap>
>

export function jsonResponse(
	status: number,
	body: Record<string, unknown>,
): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

/** Constant-time comparison via SHA-256 digests (equal-length inputs for the XOR loop) */
export async function secureCompare(a: string, b: string): Promise<boolean> {
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

/** Bearer-token check against ORDER_API_KEY (constant-time) */
export async function checkOrderApiKey(
	request: Request,
	config: ValidatedEnv,
): Promise<boolean> {
	if (!config.ORDER_API_KEY) return false
	const authHeader = request.headers.get('Authorization') ?? ''
	const providedKey = authHeader.startsWith('Bearer ')
		? authHeader.substring(7)
		: ''
	return !!providedKey && (await secureCompare(providedKey, config.ORDER_API_KEY))
}

/** Deterministic hash of the validated order, used to bind submit to a prior preview */
export async function hashOrder(order: Record<string, unknown>): Promise<string> {
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
export function extractSymbols(order: any): string[] {
	const legs: any[] = order.orderLegCollection ?? []
	return legs
		.map((leg) => leg?.instrument?.symbol)
		.filter((s): s is string => typeof s === 'string')
}

/**
 * Estimate the order's notional value. Options contracts are multiplied by 100.
 * Returns null when there is no price to bound (e.g. MARKET orders).
 */
export function estimateNotional(order: any): number | null {
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

export type GuardrailResult =
	| { ok: true; symbols: string[]; notional: number | null }
	| { ok: false; status: 400 | 403; error: string }

/**
 * Symbol allowlist + notional limit checks — pure, no I/O.
 * `requirePrice` rejects priceless (e.g. MARKET) orders even when
 * ORDER_MAX_NOTIONAL is unset (used by the proposals path).
 */
export function checkGuardrails(
	config: ValidatedEnv,
	orderBody: Record<string, unknown>,
	opts: { requirePrice?: boolean } = {},
): GuardrailResult {
	const symbols = extractSymbols(orderBody)
	if (symbols.length === 0) {
		return { ok: false, status: 400, error: 'Order has no instrument symbols' }
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
			return {
				ok: false,
				status: 403,
				error: `Symbol(s) not in ORDER_SYMBOL_ALLOWLIST: ${blocked.join(', ')}`,
			}
		}
	}
	const notional = estimateNotional(orderBody)
	if (notional === null) {
		if (opts.requirePrice) {
			return {
				ok: false,
				status: 403,
				error:
					'Orders without a limit price (e.g. MARKET) are not allowed on this endpoint.',
			}
		}
		if (config.ORDER_MAX_NOTIONAL !== undefined) {
			return {
				ok: false,
				status: 403,
				error:
					'Orders without a limit price (e.g. MARKET) are not allowed while ORDER_MAX_NOTIONAL is set — the notional cannot be bounded.',
			}
		}
	} else if (
		config.ORDER_MAX_NOTIONAL !== undefined &&
		notional > config.ORDER_MAX_NOTIONAL
	) {
		return {
			ok: false,
			status: 403,
			error: `Estimated notional $${notional.toFixed(2)} exceeds ORDER_MAX_NOTIONAL $${config.ORDER_MAX_NOTIONAL}`,
		}
	}
	return { ok: true, symbols, notional }
}

/** Check open orders on the account for one matching symbol/instruction/quantity/price */
export async function findDuplicateOpenOrder(
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
async function previewOrderRaw(
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
export async function checkAndIncrementDailyCap(
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
	| {
			ok: true
			client: SchwabApiClient
			getAccessToken: () => Promise<string | null>
	  }
	| { ok: false; status: number; error: string }
> {
	const kvToken = makeKvTokenStore(config.OAUTH_KV)
	const tokenIds = { schwabUserId: config.SCHWAB_USER_ID }

	const adoptFreshest = async (): Promise<boolean> => {
		const freshest = await kvToken.loadFreshest()
		if (!freshest) return false
		await kvToken.save(tokenIds, freshest)
		await kvToken.saveTimestamp(tokenIds)
		return true
	}

	// schwabUserId rotates per re-auth, so the SCHWAB_USER_ID key (which may be
	// a static placeholder like "orders-static") is just an alias — on a miss,
	// adopt the most recently written token.
	let adopted = false
	let existing = await kvToken.load(tokenIds)
	if (!existing) {
		adopted = await adoptFreshest()
		if (adopted) existing = await kvToken.load(tokenIds)
	}
	if (!existing) {
		return {
			ok: false,
			status: 401,
			error:
				'No usable Schwab token found in KV. Complete the OAuth flow (or run the automation refresh) first.',
		}
	}

	const makeManager = () =>
		initializeSchwabAuthClient(
			config,
			config.SCHWAB_REDIRECT_URI,
			() => kvToken.load(tokenIds),
			async (tokenData) => {
				await kvToken.save(tokenIds, tokenData)
				await kvToken.saveTimestamp(tokenIds)
			},
		)
	let tokenManager = makeManager()
	let initialized = await tokenManager.initialize()
	if (!initialized && !adopted) {
		// The alias key held a token whose refresh token has died (e.g. revoked
		// by a re-auth) — self-heal by adopting the freshest token and retrying.
		ordersLogger.warn(
			'[orders] Token init failed from alias key; retrying with freshest KV token',
		)
		if (await adoptFreshest()) {
			tokenManager = makeManager()
			initialized = await tokenManager.initialize()
		}
	}
	if (!initialized) {
		return {
			ok: false,
			status: 401,
			error: 'Schwab token manager failed to initialize (token expired?).',
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
	return { ok: true, client, getAccessToken: () => tokenManager.getAccessToken() }
}

export interface OrderContext {
	config: ValidatedEnv
	client: SchwabApiClient
	getAccessToken: () => Promise<string | null>
	accountNumbers: { accountNumber: string; hashValue: string }[]
	displayMap: AccountDisplayMap
}

/** buildClient + account list + display map, built once per request/batch */
export async function createOrderContext(
	config: ValidatedEnv,
): Promise<
	| { ok: true; ctx: OrderContext }
	| { ok: false; status: number; error: string }
> {
	const built = await buildClient(config)
	if (!built.ok) return built
	const { client, getAccessToken } = built
	const accountNumbers = await client.trader.accounts.getAccountNumbers()
	const displayMap = await buildAccountDisplayMap(client)
	return {
		ok: true,
		ctx: { config, client, getAccessToken, accountNumbers, displayMap },
	}
}

/** Resolve a plain account number or hashValue to the account's hashValue */
export function resolveAccountHash(
	ctx: OrderContext,
	requested: string | undefined,
): string | null {
	const byPlain = ctx.accountNumbers.find((a) => a.accountNumber === requested)
	const byHash = ctx.accountNumbers.find((a) => a.hashValue === requested)
	return byPlain?.hashValue ?? byHash?.hashValue ?? null
}

export interface PreviewOutcome {
	orderHash: string
	schwabPreview: { status: number; body: unknown } | { error: string }
	duplicateOpenOrder: unknown | null
}

/** Schwab preview + duplicate-open-order check for one order */
export async function previewOne(
	ctx: OrderContext,
	accountHash: string,
	orderBody: Record<string, unknown>,
): Promise<PreviewOutcome> {
	const orderHash = await hashOrder(orderBody)
	const accessToken = await ctx.getAccessToken()
	let preview: { status: number; body: unknown } | { error: string }
	if (accessToken) {
		try {
			preview = await previewOrderRaw(accessToken, accountHash, orderBody)
		} catch (error) {
			preview = {
				error: `previewOrder call failed: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	} else {
		preview = { error: 'Could not obtain access token for preview' }
	}
	const duplicate = await findDuplicateOpenOrder(ctx.client, accountHash, orderBody)
	return { orderHash, schwabPreview: preview, duplicateOpenOrder: duplicate }
}

export type PlaceOutcome =
	| { ok: true; orderHash: string; result: unknown }
	| {
			ok: false
			stage: 'duplicate' | 'dailyCap' | 'schwab'
			error: string
			detail?: unknown
			schwabStatus?: number
			schwabBody?: unknown
	  }

/**
 * Place one order through the guarded path shared by /orders and the proposal
 * executor: duplicate guard → daily cap → place → cap increment → audit log.
 */
export async function placeOne(
	ctx: OrderContext,
	accountHash: string,
	orderBody: Record<string, unknown>,
	opts: { allowDuplicate?: boolean } = {},
): Promise<PlaceOutcome> {
	const { config } = ctx
	const orderHash = await hashOrder(orderBody)

	if (!opts.allowDuplicate) {
		const duplicate = await findDuplicateOpenOrder(ctx.client, accountHash, orderBody)
		if (duplicate) {
			return {
				ok: false,
				stage: 'duplicate',
				error:
					'An identical open order already exists. Pass "allowDuplicate": true to override.',
				detail: duplicate,
			}
		}
	}

	const cap = await checkAndIncrementDailyCap(
		config.OAUTH_KV,
		config.ORDER_DAILY_CAP,
		false,
	)
	if (!cap.ok) {
		return {
			ok: false,
			stage: 'dailyCap',
			error: `Daily order cap reached (${config.ORDER_DAILY_CAP} orders/day)`,
		}
	}

	ordersLogger.info('[orders] Submitting order', {
		orderType: (orderBody as any).orderType,
		symbols: extractSymbols(orderBody),
		orderHash,
	})
	try {
		const result = await ctx.client.trader.orders.placeOrderForAccount({
			pathParams: { accountNumber: accountHash },
			body: orderBody as any,
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
		return { ok: true, orderHash, result }
	} catch (error: any) {
		ordersLogger.error('[orders] Order submission failed', {
			message: error?.message,
			status: error?.status,
			body: error?.body,
			orderHash,
		})
		return {
			ok: false,
			stage: 'schwab',
			error: `Order submission failed: ${error?.message ?? String(error)}`,
			schwabStatus: error?.status,
			schwabBody: error?.body,
		}
	}
}

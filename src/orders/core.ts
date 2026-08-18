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
import { describeOccSymbol, isExpired, parseOccSymbol } from '../shared/optionSymbol'
import { withOrderAliases } from '../shared/orderAliases'

const ordersLogger = logger.child(LOGGER_CONTEXTS.ORDERS)

/**
 * Order types whose `price` is the NET premium of the whole spread rather
 * than a per-share price on each leg.
 */
export const NET_ORDER_TYPES = new Set(['NET_DEBIT', 'NET_CREDIT', 'NET_ZERO'])

/** The only instructions valid on an OPTION leg */
const OPTION_INSTRUCTIONS = new Set([
	'BUY_TO_OPEN',
	'BUY_TO_CLOSE',
	'SELL_TO_OPEN',
	'SELL_TO_CLOSE',
])

/** Equity instructions that reduce the share count backing a covered call */
const EQUITY_SELL_INSTRUCTIONS = new Set([
	'SELL',
	'SELL_SHORT',
	'SELL_SHORT_EXEMPT',
])

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
 *
 * For NET_DEBIT/NET_CREDIT/NET_ZERO orders `price` is the net premium of one
 * spread, not a per-leg price, so it is counted ONCE against the number of
 * spreads. Summing it per leg would report a two-leg roll at double its real
 * cash value.
 *
 * Note what this number means for an option spread: it is the premium
 * exchanged, not the assignment exposure of the resulting short leg. A
 * $420 net-credit roll carries a $38,500 assignment obligation on a 385
 * strike. ORDER_MAX_NOTIONAL therefore does not bound that exposure —
 * `checkOptionCoverage` is what keeps the short call backed by shares.
 */
export function estimateNotional(order: any): number | null {
	const legs: any[] = order.orderLegCollection ?? []
	if (NET_ORDER_TYPES.has(order.orderType)) {
		// A net-zero spread exchanges no cash by definition, priced or not.
		if (order.orderType === 'NET_ZERO') return 0
		const price = typeof order.price === 'number' ? order.price : null
		if (price === null) return null
		const spreads = Math.max(
			0,
			...legs.map((leg) => (typeof leg?.quantity === 'number' ? leg.quantity : 0)),
		)
		return Math.abs(price) * spreads * 100
	}
	const price = typeof order.price === 'number' ? order.price : null
	if (price === null) return null
	let total = 0
	for (const leg of legs) {
		const qty = typeof leg?.quantity === 'number' ? leg.quantity : 0
		const multiplier = leg?.instrument?.assetType === 'OPTION' ? 100 : 1
		total += price * qty * multiplier
	}
	return total
}

/**
 * Structural validation for orders that touch options — pure, no I/O.
 *
 * These are the shapes a caller can get wrong in ways Schwab may accept but
 * that mean something other than intended: a plain BUY on an option leg
 * (ambiguous open/close), an unbalanced ratio passed off as a roll, a
 * multi-leg spread priced per-leg instead of net, or a symbol whose expiry has
 * already passed because the snapshot it came from was stale.
 */
export function checkOptionStructure(
	order: any,
): { ok: true } | { ok: false; status: 400 | 403; error: string } {
	const legs: any[] = order.orderLegCollection ?? []
	const optionLegs = legs.filter((l) => l?.instrument?.assetType === 'OPTION')
	if (optionLegs.length === 0) {
		if (NET_ORDER_TYPES.has(order.orderType)) {
			return {
				ok: false,
				status: 400,
				error: `orderType ${order.orderType} prices a multi-leg option spread, but this order has no OPTION legs.`,
			}
		}
		return { ok: true }
	}

	if (optionLegs.length !== legs.length) {
		return {
			ok: false,
			status: 403,
			error:
				'Orders mixing EQUITY and OPTION legs are not supported here. Place the stock and option sides as separate orders.',
		}
	}

	const underlyings = new Set<string>()
	for (const leg of optionLegs) {
		const symbol = leg?.instrument?.symbol
		const parsed = typeof symbol === 'string' ? parseOccSymbol(symbol) : null
		if (!parsed) {
			return {
				ok: false,
				status: 400,
				error: `Not a valid OCC option symbol: ${JSON.stringify(symbol)}. Expected Schwab's padded 21-char form, e.g. "JPM   261218C00385000".`,
			}
		}
		if (isExpired(parsed)) {
			return {
				ok: false,
				status: 403,
				error: `${describeOccSymbol(symbol)} expired on ${parsed.expiry} and cannot be traded. The snapshot this order was built from is stale.`,
			}
		}
		if (!OPTION_INSTRUCTIONS.has(leg?.instruction)) {
			return {
				ok: false,
				status: 400,
				error: `Option leg ${describeOccSymbol(symbol)} has instruction ${leg?.instruction ?? 'none'}; options require BUY_TO_OPEN, BUY_TO_CLOSE, SELL_TO_OPEN or SELL_TO_CLOSE so the open/close intent is explicit.`,
			}
		}
		if (!Number.isInteger(leg?.quantity) || leg.quantity <= 0) {
			return {
				ok: false,
				status: 400,
				error: `Option leg ${describeOccSymbol(symbol)} needs a positive whole contract quantity, got ${JSON.stringify(leg?.quantity)}.`,
			}
		}
		underlyings.add(parsed.underlying)
	}

	if (underlyings.size > 1) {
		return {
			ok: false,
			status: 403,
			error: `All option legs of one order must share an underlying; got ${[...underlyings].sort().join(', ')}.`,
		}
	}

	if (legs.length > 1) {
		if (!NET_ORDER_TYPES.has(order.orderType)) {
			return {
				ok: false,
				status: 403,
				error: `A ${legs.length}-leg option spread must be priced net (NET_CREDIT, NET_DEBIT or NET_ZERO), not ${order.orderType} — a per-leg price on a spread does not describe what the account pays or receives.`,
			}
		}
		const quantities = new Set(optionLegs.map((l) => l.quantity))
		if (quantities.size > 1) {
			return {
				ok: false,
				status: 403,
				error: `Unbalanced option spread: leg quantities ${optionLegs.map((l) => l.quantity).join(':')}. Only 1:1 spreads are supported here; a ratio changes the risk profile and needs its own review.`,
			}
		}
		// Schwab needs to know it is looking at a spread before it will accept a
		// net price. Left as NONE (or unset) it treats the order as a simple one,
		// reads `price` as a plain limit price, and rejects it with the misleading
		// "Limit price must be populated only for limit orders." Caught here so
		// the message names the real problem.
		const complex = order.complexOrderStrategyType
		if (!complex || complex === 'NONE') {
			return {
				ok: false,
				status: 400,
				error: `A net-priced ${legs.length}-leg order must name its strategy in complexOrderStrategyType (VERTICAL for one expiry, CALENDAR for one strike, DIAGONAL for both differing), not ${complex ?? 'unset'}. Schwab rejects a net price on an order it reads as simple.`,
			}
		}
	} else if (NET_ORDER_TYPES.has(order.orderType)) {
		return {
			ok: false,
			status: 400,
			error: `orderType ${order.orderType} describes the net price of a spread; a single-leg option order should use LIMIT.`,
		}
	}

	return { ok: true }
}

/**
 * Covered-call check: would this order leave the account short more calls than
 * its shares can cover?
 *
 * Runs against live positions, so it also catches the reverse case — an equity
 * SELL that strands an existing short call — which the equity drift path could
 * previously place unnoticed.
 *
 * Deliberately conservative in two ways:
 *   - Long calls never count as cover. Netting them against shorts would treat
 *     a cheap far-OTM long as covering a near-the-money short, which it does
 *     not; only shares do here.
 *   - Short PUTS are out of scope. Shares cannot cover a put — the backing is
 *     cash/buying power, which Schwab's own previewOrder already enforces.
 */
export async function checkOptionCoverage(
	ctx: OrderContext,
	accountHash: string,
	order: any,
): Promise<{ ok: true; checked: boolean } | { ok: false; error: string }> {
	const legs: any[] = order.orderLegCollection ?? []
	const touchesOptions = legs.some((l) => l?.instrument?.assetType === 'OPTION')
	const sellsEquity = legs.some(
		(l) =>
			l?.instrument?.assetType === 'EQUITY' &&
			EQUITY_SELL_INSTRUCTIONS.has(l?.instruction),
	)
	// Nothing here can reduce coverage: skip the positions fetch.
	if (!touchesOptions && !sellsEquity) return { ok: true, checked: false }

	let positions: any[]
	try {
		const account: any = await ctx.client.trader.accounts.getAccountByNumber({
			pathParams: { accountNumber: accountHash },
			queryParams: { fields: 'positions' },
		})
		positions = account?.securitiesAccount?.positions ?? []
	} catch (error) {
		// Fail closed: an unverifiable coverage check is not a passed one.
		return {
			ok: false,
			error: `Could not read positions to verify option coverage: ${error instanceof Error ? error.message : String(error)}`,
		}
	}

	const shares = new Map<string, number>()
	const shortCalls = new Map<string, number>()
	for (const p of positions) {
		const symbol = p?.instrument?.symbol
		if (typeof symbol !== 'string') continue
		if (p?.instrument?.assetType === 'EQUITY') {
			shares.set(symbol, (shares.get(symbol) ?? 0) + (p?.longQuantity ?? 0))
		} else if (p?.instrument?.assetType === 'OPTION') {
			const parsed = parseOccSymbol(symbol)
			if (!parsed || parsed.right !== 'C') continue
			shortCalls.set(
				parsed.underlying,
				(shortCalls.get(parsed.underlying) ?? 0) + (p?.shortQuantity ?? 0),
			)
		}
	}

	// Apply this order's effect on top of the live position.
	for (const leg of legs) {
		const symbol = leg?.instrument?.symbol
		const qty = typeof leg?.quantity === 'number' ? leg.quantity : 0
		if (typeof symbol !== 'string' || qty <= 0) continue
		if (leg?.instrument?.assetType === 'EQUITY') {
			const delta = EQUITY_SELL_INSTRUCTIONS.has(leg?.instruction) ? -qty : qty
			shares.set(symbol, (shares.get(symbol) ?? 0) + delta)
			continue
		}
		const parsed = parseOccSymbol(symbol)
		if (!parsed || parsed.right !== 'C') continue
		const current = shortCalls.get(parsed.underlying) ?? 0
		if (leg?.instruction === 'SELL_TO_OPEN') {
			shortCalls.set(parsed.underlying, current + qty)
		} else if (leg?.instruction === 'BUY_TO_CLOSE') {
			shortCalls.set(parsed.underlying, Math.max(0, current - qty))
		}
	}

	const uncovered: string[] = []
	for (const [underlying, contracts] of shortCalls) {
		if (contracts <= 0) continue
		const required = contracts * 100
		const held = shares.get(underlying) ?? 0
		if (held < required) {
			uncovered.push(
				`${underlying}: ${contracts} short call(s) need ${required} shares, account would hold ${held} (short ${required - held})`,
			)
		}
	}
	if (uncovered.length > 0) {
		return {
			ok: false,
			error: `Order would leave short calls uncovered — ${uncovered.join('; ')}. Nothing was placed.`,
		}
	}
	return { ok: true, checked: true }
}

export type GuardrailResult =
	| { ok: true; symbols: string[]; notional: number | null }
	| { ok: false; status: 400 | 403; error: string }

/**
 * Option structure + symbol allowlist + notional limit checks — pure, no I/O.
 * `requirePrice` rejects priceless (e.g. MARKET) orders even when
 * ORDER_MAX_NOTIONAL is unset (used by the proposals path).
 *
 * The coverage check is deliberately NOT here: it needs live positions, so it
 * lives in `checkOptionCoverage` and runs in the preview and place paths.
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
	const structure = checkOptionStructure(orderBody)
	if (!structure.ok) {
		return { ok: false, status: structure.status, error: structure.error }
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
	// Compare leg sets, not leg order: Schwab does not promise to echo a
	// multi-leg spread's legs back in the order they were submitted, and a roll
	// resubmitted with its legs swapped is the same duplicate order.
	const legKey = (leg: any) =>
		`${leg?.instrument?.symbol}|${leg?.instruction}|${leg?.quantity}`
	const candidateKeys = (order.orderLegCollection ?? []).map(legKey).sort()
	for (const existing of openOrders as any[]) {
		if (!OPEN_ORDER_STATUSES.has(existing?.status)) continue
		if (existing.orderType !== order.orderType) continue
		if ((existing.price ?? null) !== (order.price ?? null)) continue
		const existingKeys = (existing.orderLegCollection ?? []).map(legKey).sort()
		if (existingKeys.length !== candidateKeys.length) continue
		if (existingKeys.every((key: string, i: number) => key === candidateKeys[i])) {
			return existing
		}
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
		const freshest = await kvToken.loadFreshestEntry()
		if (!freshest) return false
		await kvToken.save(tokenIds, freshest.data)
		// Inherit the source mint time so the alias key never looks fresher than
		// the token it is a copy of.
		await kvToken.saveTimestamp(tokenIds, freshest.ts)
		return true
	}

	// schwabUserId rotates per re-auth, so the SCHWAB_USER_ID key (which may be
	// a static placeholder like "orders-static") is just an alias. Adopt not only
	// when the alias is empty but whenever KV holds a NEWER token: a re-auth
	// revokes the refresh token the alias is holding, so a present-but-dead copy
	// is the common case, not the rare one.
	let adopted = false
	let existing = await kvToken.load(tokenIds)
	const ownTs = existing ? await kvToken.getTimestamp(tokenIds) : null
	if (!existing || ownTs === null) {
		adopted = await adoptFreshest()
		if (adopted) existing = await kvToken.load(tokenIds)
	} else {
		const freshest = await kvToken.loadFreshestEntry()
		if (freshest && freshest.ts > ownTs) {
			ordersLogger.info(
				'[orders] A newer token exists in KV — adopting it for the alias key',
			)
			await kvToken.save(tokenIds, freshest.data)
			await kvToken.saveTimestamp(tokenIds, freshest.ts)
			existing = freshest.data
			adopted = true
		}
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

/** Unique account display names with digits masked to the last 3, for error messages */
export function availableAccountDisplays(ctx: OrderContext): string[] {
	const displays = new Set(Object.values(ctx.displayMap).map(String))
	return [...displays].map((d) => d.replace(/\d+(?=\d{3})/g, '…'))
}

export interface PreviewOutcome {
	orderHash: string
	schwabPreview: { status: number; body: unknown } | { error: string }
	duplicateOpenOrder: unknown | null
	/** Covered-call check against live positions; `checked: false` = not applicable */
	coverage: { ok: true; checked: boolean } | { ok: false; error: string }
}

/** Schwab preview + duplicate-open-order + covered-call checks for one order */
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
	const coverage = await checkOptionCoverage(ctx, accountHash, orderBody)
	return {
		orderHash,
		schwabPreview: preview,
		duplicateOpenOrder: duplicate,
		coverage,
	}
}

export type PlaceOutcome =
	| { ok: true; orderHash: string; result: unknown }
	| {
			ok: false
			stage: 'duplicate' | 'dailyCap' | 'coverage' | 'schwab'
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

	// Last gate before placement, re-read here rather than trusted from the
	// preview: an approval can land hours after a proposal was built, and the
	// shares backing a short call may have been sold in between.
	const coverage = await checkOptionCoverage(ctx, accountHash, orderBody)
	if (!coverage.ok) {
		ordersLogger.warn('[orders] Order blocked by coverage check', {
			error: coverage.error,
			orderHash,
		})
		return { ok: false, stage: 'coverage', error: coverage.error }
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

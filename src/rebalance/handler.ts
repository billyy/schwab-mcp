import { scrubAccountIdentifiers } from '@sudowealth/schwab-api'
import { type Env } from '../../types/env'
import { getConfig } from '../config'
import {
	checkOrderApiKey,
	createOrderContext,
	jsonResponse,
	resolveAccountHash,
	availableAccountDisplays,
	type OrderContext,
} from '../orders/core'
import { LOGGER_CONTEXTS } from '../shared/constants'
import { logger } from '../shared/log'
import { slackApi } from '../shared/slack'

const rebalanceLogger = logger.child(LOGGER_CONTEXTS.PROPOSALS)

interface SlimPosition {
	symbol: string
	assetType: string
	longQuantity: number
	shortQuantity: number
	marketValue: number | null
}

function slimPositions(account: any): SlimPosition[] {
	const positions: any[] = account?.securitiesAccount?.positions ?? []
	return positions
		.map((p) => ({
			symbol: p?.instrument?.symbol ?? '?',
			assetType: p?.instrument?.assetType ?? '?',
			longQuantity: p?.longQuantity ?? 0,
			shortQuantity: p?.shortQuantity ?? 0,
			marketValue: typeof p?.marketValue === 'number' ? p.marketValue : null,
		}))
		.filter((p) => p.symbol !== '?')
}

async function fetchAccountSlim(ctx: OrderContext, requested: string) {
	const hash = resolveAccountHash(ctx, requested)
	if (!hash) return null
	const account: any = await ctx.client.trader.accounts.getAccountByNumber({
		pathParams: { accountNumber: hash },
		queryParams: { fields: 'positions' },
	})
	// liquidationValue/cashBalance live in different balance blocks per
	// account type (margin: initialBalances; cash: currentBalances)
	const current = account?.securitiesAccount?.currentBalances ?? {}
	const initial = account?.securitiesAccount?.initialBalances ?? {}
	return {
		account: ctx.displayMap[hash] ?? 'unknown',
		liquidationValue:
			current.liquidationValue ?? initial.liquidationValue ?? null,
		cashBalance:
			current.cashBalance ??
			current.totalCash ??
			initial.cashBalance ??
			current.cashAvailableForTrading ??
			null,
		positions: slimPositions(account),
	}
}

/**
 * Which US equity session the snapshot's prices came from. The drift task runs
 * pre-market (7am ET report) as well as post-open (10am ET proposal), and
 * bid/ask outside the regular session is the thin extended-hours book — not
 * something a limit price should be derived from.
 *
 * Primary source is Schwab's market-hours calendar (classifyFromCalendar),
 * which knows holidays AND early closes — a 1pm-ET close would fool any
 * clock. classifyFromClock is the fallback when that call fails.
 */
type MarketSession = 'PRE' | 'REGULAR' | 'POST' | 'CLOSED'

/**
 * Classify from the equity market-hours calendar. Returns null when the
 * payload can't answer the question (missing/malformed), so the caller can
 * fall back to the clock.
 */
function classifyFromCalendar(hours: unknown): MarketSession | null {
	const eq = Object.values((hours as any)?.equity ?? {})[0] as any
	if (!eq || typeof eq.isOpen !== 'boolean') return null
	if (!eq.isOpen) return 'CLOSED'
	const sessions = eq.sessionHours ?? {}
	if (Object.keys(sessions).length === 0) return null // open but no windows: broken data
	const now = Date.now()
	// start/end carry explicit offsets ("2026-08-04T09:30:00-04:00")
	const within = (windows: unknown) =>
		Array.isArray(windows) &&
		windows.some((w: any) => {
			const s = Date.parse(w?.start)
			const e = Date.parse(w?.end)
			return Number.isFinite(s) && Number.isFinite(e) && now >= s && now < e
		})
	if (within(sessions.regularMarket)) return 'REGULAR'
	if (within(sessions.preMarket)) return 'PRE'
	if (within(sessions.postMarket)) return 'POST'
	return 'CLOSED'
}

function classifyFromClock(quoteStatuses: (string | null)[]): MarketSession {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		weekday: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).formatToParts(new Date())
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
	const weekday = get('weekday')
	// 'en-US' hour12:false renders midnight as '24' in some ICU builds
	const hour = Number(get('hour')) % 24
	const minutes = hour * 60 + Number(get('minute'))

	let session: MarketSession
	if (weekday === 'Sat' || weekday === 'Sun') session = 'CLOSED'
	else if (minutes < 4 * 60) session = 'CLOSED'
	else if (minutes < 9 * 60 + 30) session = 'PRE'
	else if (minutes < 16 * 60) session = 'REGULAR'
	else if (minutes <= 20 * 60) session = 'POST'
	else session = 'CLOSED'

	// Holidays: the clock says REGULAR but Schwab reports every name as closed.
	const known = quoteStatuses.filter((s): s is string => typeof s === 'string')
	if (
		session !== 'CLOSED' &&
		known.length > 0 &&
		known.every((s) => s.toLowerCase() === 'closed')
	) {
		return 'CLOSED'
	}
	return session
}

/**
 * GET /rebalance/snapshot?accounts=<a>,<b> — read-only input for the drift
 * scheduled task: slimmed positions + balances for each requested account,
 * plus live bid/ask for the union of equity symbols (so limit prices can be
 * set without a second call). Bearer ORDER_API_KEY, identifiers scrubbed.
 *
 * Also returns `marketSession`, `sessionSource` ('calendar' | 'clock'), and
 * `pricesTradable`. Callers MUST NOT build limit prices from bid/ask unless
 * `pricesTradable` is true — outside the regular session those are
 * extended-hours quotes. Each quote carries `close` (prior regular-session
 * close) for sizing notionals pre-market.
 */
export async function handleRebalanceSnapshot(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== 'GET') {
		return jsonResponse(405, { error: 'Method not allowed. Use GET.' })
	}
	const config = getConfig(env)
	if (!config.ORDER_API_KEY || !config.SCHWAB_USER_ID) {
		return jsonResponse(503, {
			error:
				'Snapshot endpoint disabled. Set ORDER_API_KEY and SCHWAB_USER_ID secrets to enable.',
		})
	}
	if (!(await checkOrderApiKey(request, config))) {
		return jsonResponse(401, { error: 'Unauthorized' })
	}

	const accountsParam = new URL(request.url).searchParams.get('accounts') ?? ''
	const requested = accountsParam
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
	if (requested.length === 0 || requested.length > 4) {
		return jsonResponse(400, {
			error: 'Pass 1-4 account numbers: ?accounts=<num>[,<num>...]',
		})
	}

	const built = await createOrderContext(config)
	if (!built.ok) {
		return jsonResponse(built.status, { error: built.error })
	}
	const { ctx } = built

	const accounts: Record<string, unknown>[] = []
	for (const req of requested) {
		const slim = await fetchAccountSlim(ctx, req)
		if (!slim) {
			return jsonResponse(400, {
				error: `Account ${req.slice(0, 2)}… does not match any account on this login`,
				availableAccounts: availableAccountDisplays(ctx),
			})
		}
		accounts.push(slim)
	}

	// Live bid/ask for every equity symbol held in any requested account
	const equitySymbols = [
		...new Set(
			accounts.flatMap((a) =>
				(a.positions as SlimPosition[])
					.filter((p) => p.assetType === 'EQUITY')
					.map((p) => p.symbol),
			),
		),
	]
	let quotes: Record<string, unknown> = {}
	const statuses: (string | null)[] = []
	if (equitySymbols.length > 0) {
		try {
			const raw = (await ctx.client.marketData.quotes.getQuotes({
				queryParams: { symbols: equitySymbols, fields: ['quote'] },
			})) as Record<string, any>
			for (const [symbol, q] of Object.entries(raw)) {
				statuses.push(q?.quote?.securityStatus ?? null)
				quotes[symbol] = {
					bid: q?.quote?.bidPrice ?? null,
					ask: q?.quote?.askPrice ?? null,
					last: q?.quote?.lastPrice ?? null,
					// Prior regular-session close: the stable price to size
					// notionals against when the regular market is not open.
					close: q?.quote?.closePrice ?? null,
					status: q?.quote?.securityStatus ?? null,
				}
			}
		} catch (error) {
			rebalanceLogger.warn('Snapshot quotes fetch failed', {
				error: error instanceof Error ? error.message : String(error),
			})
			quotes = { error: 'quotes unavailable' }
		}
	}

	// Session classification: Schwab's calendar first (holidays + early
	// closes), clock + securityStatus as fallback when that call fails.
	let calendarSession: MarketSession | null = null
	try {
		const hours = await ctx.client.marketData.marketHours.getMarketHours({
			queryParams: { markets: ['equity'] },
		})
		calendarSession = classifyFromCalendar(hours)
	} catch (error) {
		rebalanceLogger.warn('Market hours fetch failed; using clock fallback', {
			error: error instanceof Error ? error.message : String(error),
		})
	}
	const marketSession = calendarSession ?? classifyFromClock(statuses)
	return jsonResponse(200, {
		asOf: new Date().toISOString(),
		marketSession,
		sessionSource: calendarSession !== null ? 'calendar' : 'clock',
		// Also false when the quote fetch failed: a REGULAR-session verdict
		// with no quotes must not pass the caller's "safe to price limits"
		// guard.
		pricesTradable: marketSession === 'REGULAR' && !('error' in quotes),
		accounts: scrubAccountIdentifiers(accounts, ctx.displayMap) as any,
		quotes,
	})
}

/**
 * POST /slack/notify — post a message to the configured Slack channel via
 * the worker's bot token, so callers (the drift scheduled task) never hold
 * Slack credentials. Bearer ORDER_API_KEY.
 * Body: { "text": "<mrkdwn>", "blocks"?: BlockKit[] }. `text` is always
 * required — it is the notification preview and the fallback if `blocks`
 * is rejected by Slack. `blocks` (≤50, each an object with a string `type`)
 * enables rich rendering (header blocks, field tiles, dividers).
 */
export async function handleSlackNotify(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'Method not allowed. Use POST.' })
	}
	const config = getConfig(env)
	if (
		!config.ORDER_API_KEY ||
		!config.SLACK_BOT_TOKEN ||
		!config.SLACK_CHANNEL_ID
	) {
		return jsonResponse(503, {
			error:
				'Notify endpoint disabled. Set ORDER_API_KEY, SLACK_BOT_TOKEN, and SLACK_CHANNEL_ID to enable.',
		})
	}
	if (!(await checkOrderApiKey(request, config))) {
		return jsonResponse(401, { error: 'Unauthorized' })
	}

	let text: unknown
	let blocks: unknown
	try {
		const body = (await request.json()) as { text?: unknown; blocks?: unknown }
		text = body.text
		blocks = body.blocks
	} catch {
		return jsonResponse(400, { error: 'Invalid JSON body' })
	}
	if (typeof text !== 'string' || text.length === 0 || text.length > 12000) {
		return jsonResponse(400, {
			error: 'Body must be { "text": "<1-12000 chars>", "blocks"?: [...] }',
		})
	}
	if (blocks !== undefined) {
		const valid =
			Array.isArray(blocks) &&
			blocks.length > 0 &&
			blocks.length <= 50 &&
			blocks.every(
				(b) =>
					typeof b === 'object' &&
					b !== null &&
					typeof (b as { type?: unknown }).type === 'string',
			) &&
			JSON.stringify(blocks).length <= 40000
		if (!valid) {
			return jsonResponse(400, {
				error:
					'"blocks" must be 1-50 Block Kit objects (each with a string "type"), ≤40000 chars serialized',
			})
		}
	}

	const posted = await slackApi(config.SLACK_BOT_TOKEN, 'chat.postMessage', {
		channel: config.SLACK_CHANNEL_ID,
		text,
		...(blocks !== undefined ? { blocks } : {}),
	})
	if (!posted.ok && blocks !== undefined && posted.error === 'invalid_blocks') {
		// Degrade to the mandatory text fallback rather than dropping the report.
		const retry = await slackApi(config.SLACK_BOT_TOKEN, 'chat.postMessage', {
			channel: config.SLACK_CHANNEL_ID,
			text,
		})
		if (retry.ok) {
			return jsonResponse(200, { ok: true, ts: retry.ts, degraded: 'invalid_blocks' })
		}
		return jsonResponse(502, { error: `Slack post failed (${retry.error})` })
	}
	if (!posted.ok) {
		return jsonResponse(502, { error: `Slack post failed (${posted.error})` })
	}
	return jsonResponse(200, { ok: true, ts: posted.ts })
}

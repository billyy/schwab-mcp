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
import { resolveMarketSession } from '../shared/marketSession'
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
	// initialBalances is Schwab's START-OF-DAY block: it does not move
	// intraday. Falling back to it silently hands the caller a stale figure
	// that looks live — positions revalue all session while liquidationValue
	// stays pinned, which reads as a growing reconciliation gap. Report which
	// block answered so callers can say so instead of guessing.
	const liquidationValueSource =
		current.liquidationValue != null
			? 'current'
			: initial.liquidationValue != null
				? 'initial (start-of-day, does not update intraday)'
				: 'unavailable'
	return {
		account: ctx.displayMap[hash] ?? 'unknown',
		liquidationValue:
			current.liquidationValue ?? initial.liquidationValue ?? null,
		liquidationValueSource,
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
 *
 * Each account carries `liquidationValueSource`. When it starts with
 * 'initial', that account's `liquidationValue` is Schwab's START-OF-DAY
 * figure and does not move intraday: positions revalue against a frozen
 * baseline, so positions + cash − liquidationValue widens through the session
 * and is NOT a clean measure of unsettled funds. Two accounts whose sources
 * differ cannot be compared on liquidationValue mid-session.
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

	// Live bid/ask for every symbol held in any requested account
	const symbolsOfType = (assetType: string) => [
		...new Set(
			accounts.flatMap((a) =>
				(a.positions as SlimPosition[])
					.filter((p) => p.assetType === assetType)
					.map((p) => p.symbol),
			),
		),
	]
	const equitySymbols = symbolsOfType('EQUITY')
	const optionSymbols = symbolsOfType('OPTION')

	const slimQuote = (q: any) => ({
		bid: q?.quote?.bidPrice ?? null,
		ask: q?.quote?.askPrice ?? null,
		last: q?.quote?.lastPrice ?? null,
		// Prior regular-session close: the stable price to size
		// notionals against when the regular market is not open.
		close: q?.quote?.closePrice ?? null,
		// Schwab's own mid/theoretical value. Reported so a caller can show
		// what crossing the spread gives up — wide option spreads make that
		// difference the whole story.
		mark: q?.quote?.mark ?? null,
		status: q?.quote?.securityStatus ?? null,
	})

	let quotes: Record<string, unknown> = {}
	const statuses: (string | null)[] = []
	if (equitySymbols.length > 0) {
		try {
			const raw = (await ctx.client.marketData.quotes.getQuotes({
				queryParams: { symbols: equitySymbols, fields: ['quote'] },
			})) as Record<string, any>
			for (const [symbol, q] of Object.entries(raw)) {
				statuses.push(q?.quote?.securityStatus ?? null)
				quotes[symbol] = slimQuote(q)
			}
		} catch (error) {
			rebalanceLogger.warn('Snapshot quotes fetch failed', {
				error: error instanceof Error ? error.message : String(error),
			})
			quotes = { error: 'quotes unavailable' }
		}
	}

	// Option quotes are fetched separately and merged in, so that an option
	// quote failure degrades option pricing only. Folding them into the call
	// above would flip `pricesTradable` to false and cost the equity drift run
	// its whole window over contracts it never prices.
	const optionQuotes: {
		requested: number
		returned: number
		ok: boolean
		error?: string
	} = { requested: optionSymbols.length, returned: 0, ok: true }
	if (optionSymbols.length > 0 && !('error' in quotes)) {
		try {
			const raw = (await ctx.client.marketData.quotes.getQuotes({
				queryParams: { symbols: optionSymbols, fields: ['quote'] },
			})) as Record<string, any>
			for (const [symbol, q] of Object.entries(raw)) {
				quotes[symbol] = {
					...slimQuote(q),
					openInterest: q?.quote?.openInterest ?? null,
				}
				optionQuotes.returned++
			}
			// A partial return means some contract went unpriced — say so
			// rather than letting the caller read a missing key as "no gap".
			optionQuotes.ok = optionQuotes.returned === optionSymbols.length
			if (!optionQuotes.ok) {
				optionQuotes.error = `Schwab returned ${optionQuotes.returned} of ${optionSymbols.length} option quotes`
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			rebalanceLogger.warn('Snapshot option quotes fetch failed', {
				error: message,
			})
			optionQuotes.ok = false
			optionQuotes.error = `option quotes unavailable: ${message}`
		}
	} else if (optionSymbols.length > 0) {
		optionQuotes.ok = false
		optionQuotes.error = 'skipped: the equity quote fetch failed'
	}

	// Session classification: Schwab's calendar first (holidays + early
	// closes), clock + securityStatus as fallback when that call fails.
	const { session: marketSession, source: sessionSource } =
		await resolveMarketSession(ctx.client, statuses)
	return jsonResponse(200, {
		asOf: new Date().toISOString(),
		marketSession,
		sessionSource,
		// Also false when the quote fetch failed: a REGULAR-session verdict
		// with no quotes must not pass the caller's "safe to price limits"
		// guard.
		pricesTradable: marketSession === 'REGULAR' && !('error' in quotes),
		// Scoped to the option leg of pricing: `pricesTradable` stays the
		// equity gate, so an option quote outage never blocks equity orders.
		// Callers must check this before pricing any option limit.
		optionQuotes,
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
			return jsonResponse(200, {
				ok: true,
				ts: retry.ts,
				degraded: 'invalid_blocks',
			})
		}
		return jsonResponse(502, { error: `Slack post failed (${retry.error})` })
	}
	if (!posted.ok) {
		return jsonResponse(502, { error: `Slack post failed (${posted.error})` })
	}
	return jsonResponse(200, { ok: true, ts: posted.ts })
}

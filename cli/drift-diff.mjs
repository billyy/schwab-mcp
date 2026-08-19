#!/usr/bin/env node
/**
 * drift-diff — fetch the rebalance snapshot and print the CRT-vs-Partnership
 * divergence analysis. Read-only: this script never places, previews, or
 * proposes an order, and never posts to Slack.
 *
 * It exists so the scheduled drift tasks run one byte-identical command
 * instead of improvised throwaway scripts — the analysis is then reviewable,
 * diffable, and reproducible across runs.
 *
 * Usage:
 *   node cli/drift-diff.mjs            # human-readable report
 *   node cli/drift-diff.mjs --json     # machine-readable, same numbers
 *
 * CRT is the benchmark and is immutable; every note is framed as a
 * Partnership action.
 *
 * Equity gaps come with a `limitPrice`; option divergences come with a priced
 * `optionGaps[].order` — a ready-to-submit net-priced two-leg roll — when the
 * divergence is a clean 1:1 covered-call roll with usable quotes. Emitting an
 * order body is not proposing it: submitting is `cli/schwab-propose.mjs`, and
 * the 10:00am scheduled task submits equity only.
 *
 * Config (env var wins, falls back to macOS Keychain):
 *   WORKER_URL       default: http://localhost:8788
 *   ORDER_API_KEY    or Keychain: security add-generic-password -s schwab-mcp-order -a api-key -w '<key>'
 */
import { execFileSync } from 'node:child_process'

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8788'
const PORTFOLIO = { number: '13102970', label: 'Partnership' }
const BENCHMARK = { number: '80745838', label: 'CRT' }

/** Equity gaps below this notional are noise, not rebalance candidates. */
const PROPOSAL_THRESHOLD = 1000

/**
 * Option rolls have NO notional floor, unlike equity gaps.
 *
 * The $1,000 equity threshold filters rounding noise — a 3-share difference is
 * not worth a trade. An option divergence is never noise: it is a whole
 * position that either matches the benchmark or does not. A $200 net credit on
 * a roll still moves a 100-share obligation from one strike and expiry to
 * another, so it is judged on quote quality and coverage, never on size.
 */

/**
 * A roll is priced by crossing both legs — buy the closing leg at its ask,
 * sell the opening leg at its bid — the same convention the equity path uses.
 * Crossing only produces a sane price on a liquid two-sided market, so a leg
 * whose quote is one-sided, crossed, or wide disqualifies the roll rather than
 * being quietly priced off. Option spreads are where this matters: an equity
 * spread is pennies, a thin long-dated option's can be a third of its value.
 */
const OPTION_MAX_SPREAD_PCT = 0.25
/** Below this dollar width, a spread's percentage of a cheap contract is meaningless. */
const OPTION_SPREAD_ABS_FLOOR = 0.1

/**
 * Reconciliation tolerance: positions + cash vs reported liquidation value.
 *
 * When these disagree it is normally an incoming transfer that has not settled
 * yet — ACH/journal settlement runs about 5 business days, and Schwab's
 * reported liquidationValue lags the funds until then while positions and cash
 * already reflect them. Positions + cash is the accurate portfolio value; the
 * gap shrinks to zero on settlement. (Confirmed by the account holder after the
 * 2026-08-06 MA purchase, where it started at $21,087.51.) It is NOT margin.
 */
const RECONCILE_TOLERANCE = 1

function fail(message) {
	console.error(`✖ ${message}`)
	process.exit(1)
}

function getApiKey() {
	if (process.env.ORDER_API_KEY) return process.env.ORDER_API_KEY
	try {
		return execFileSync(
			'security',
			[
				'find-generic-password',
				'-s',
				'schwab-mcp-order',
				'-a',
				'api-key',
				'-w',
			],
			{ encoding: 'utf8' },
		).trim()
	} catch {
		fail(
			'No API key. Set ORDER_API_KEY or store it in the Keychain:\n' +
				"  security add-generic-password -s schwab-mcp-order -a api-key -w '<key>'",
		)
	}
}

async function fetchSnapshot() {
	const url =
		`${WORKER_URL.replace(/\/$/, '')}/rebalance/snapshot` +
		`?accounts=${PORTFOLIO.number},${BENCHMARK.number}`
	let response
	try {
		response = await fetch(url, {
			headers: { Authorization: `Bearer ${getApiKey()}` },
		})
	} catch (error) {
		fail(`Snapshot request failed: ${error.message}`)
	}
	const body = await response.text()
	if (!response.ok) fail(`Snapshot ${response.status}: ${body}`)
	try {
		return JSON.parse(body)
	} catch {
		fail(`Snapshot response is not valid JSON: ${body.slice(0, 400)}`)
	}
}

/**
 * OCC-style symbol: 6-char padded underlying, YYMMDD, C|P, strike in
 * thousandths. e.g. "FAST  260821C00050000" -> FAST 2026-08-21 call 50.
 */
function parseOption(symbol) {
	const match = /^(.{6})(\d{6})([CP])(\d{8})$/.exec(symbol)
	if (!match) return null
	const [, pad, date, right, strike] = match
	return {
		underlying: pad.trim(),
		expiry: `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`,
		right,
		strike: Number(strike) / 1000,
	}
}

function describeOption(symbol) {
	const parsed = parseOption(symbol)
	if (!parsed) return symbol
	const kind = parsed.right === 'C' ? 'call' : 'put'
	return `${parsed.underlying} ${parsed.expiry} ${kind} ${parsed.strike}`
}

function indexAccount(account) {
	const equity = new Map()
	const options = new Map()
	for (const position of account.positions) {
		const target = position.assetType === 'OPTION' ? options : equity
		target.set(position.symbol, position)
	}
	return { account, equity, options }
}

function pickAccount(snapshot, { number, label }) {
	const found = snapshot.accounts?.find(
		(a) => a.account?.includes(number.slice(-3)) || a.account?.includes(label),
	)
	if (!found) fail(`Snapshot has no ${label} account (${number})`)
	return found
}

/** Live quotes only while the regular session is open; otherwise prior close. */
function priceFor(snapshot, symbol) {
	const quote = snapshot.quotes?.[symbol]
	if (!quote) return { price: null, basis: 'unavailable' }
	if (snapshot.pricesTradable && quote.last != null)
		return { price: quote.last, basis: 'last' }
	if (quote.close != null) return { price: quote.close, basis: 'close' }
	if (quote.last != null) return { price: quote.last, basis: 'last (no close)' }
	return { price: null, basis: 'unavailable' }
}

function reconcile(account) {
	const positionsValue = account.positions.reduce(
		(sum, p) => sum + p.marketValue,
		0,
	)
	const difference =
		positionsValue + account.cashBalance - account.liquidationValue
	const source = account.liquidationValueSource ?? 'unknown'
	return {
		account: account.account,
		positionsValue,
		cashBalance: account.cashBalance,
		liquidationValue: account.liquidationValue,
		liquidationValueSource: source,
		// Schwab serves some accounts' liquidationValue only from the
		// start-of-day block. Positions then revalue all session against a
		// frozen baseline, so `difference` is NOT purely unsettled funds — it
		// also absorbs the day's P&L. Say which, rather than blaming settlement.
		staleLiquidationValue: source.startsWith('initial'),
		difference,
		reconciles: Math.abs(difference) < RECONCILE_TOLERANCE,
	}
}

function quantityGaps(snapshot, portfolio, benchmark) {
	const gaps = []
	const symbols = new Set([
		...portfolio.equity.keys(),
		...benchmark.equity.keys(),
	])
	for (const symbol of [...symbols].sort()) {
		const held = portfolio.equity.get(symbol)?.longQuantity ?? 0
		const target = benchmark.equity.get(symbol)?.longQuantity ?? 0
		if (held === target) continue
		const { price, basis } = priceFor(snapshot, symbol)
		const delta = target - held
		const notional = price == null ? null : Math.abs(delta * price)
		const quote = snapshot.quotes?.[symbol] ?? {}
		const action = delta > 0 ? 'buy' : 'sell'
		// Limit basis: cross the spread — buy at the ask, sell at the bid. Only
		// meaningful while the regular session is open; pre-market this is the
		// thin extended-hours book, so the propose task must gate on
		// pricesTradable before using it.
		const limitPrice = action === 'buy' ? quote.ask : quote.bid
		gaps.push({
			symbol,
			held,
			target,
			delta,
			action,
			price,
			priceBasis: basis,
			notional,
			bid: quote.bid ?? null,
			ask: quote.ask ?? null,
			quoteStatus: quote.status ?? null,
			limitPrice:
				limitPrice == null ? null : Math.round(limitPrice * 100) / 100,
			proposable: notional != null && notional >= PROPOSAL_THRESHOLD,
		})
	}
	return gaps
}

function optionDivergences(portfolio, benchmark) {
	const byUnderlying = new Map()
	const add = (side, symbol, position) => {
		const parsed = parseOption(symbol)
		const key = parsed?.underlying ?? symbol
		if (!byUnderlying.has(key)) byUnderlying.set(key, { held: [], target: [] })
		byUnderlying.get(key)[side].push({ symbol, position, parsed })
	}
	for (const [symbol, position] of portfolio.options)
		add('held', symbol, position)
	for (const [symbol, position] of benchmark.options)
		add('target', symbol, position)

	const divergences = []
	for (const [underlying, sides] of [...byUnderlying].sort()) {
		const heldMap = new Map(
			sides.held.map((c) => [
				c.symbol,
				c.position.shortQuantity - c.position.longQuantity,
			]),
		)
		const targetMap = new Map(
			sides.target.map((c) => [
				c.symbol,
				c.position.shortQuantity - c.position.longQuantity,
			]),
		)
		const contracts = new Set([...heldMap.keys(), ...targetMap.keys()])
		const differing = [...contracts].filter(
			(symbol) => (heldMap.get(symbol) ?? 0) !== (targetMap.get(symbol) ?? 0),
		)
		if (!differing.length) continue
		divergences.push({
			underlying,
			contracts: differing.sort().map((symbol) => ({
				symbol,
				description: describeOption(symbol),
				held: heldMap.get(symbol) ?? 0,
				target: targetMap.get(symbol) ?? 0,
			})),
		})
	}
	return divergences
}

/** Whole days from the snapshot date to an expiry date, both YYYY-MM-DD. */
function daysUntil(asOf, expiry) {
	const from = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`)
	const to = Date.parse(`${expiry}T00:00:00Z`)
	if (!Number.isFinite(from) || !Number.isFinite(to)) return null
	return Math.round((to - from) / 86400000)
}

/**
 * Validate one leg's quote for use as a limit basis. Returns the usable
 * numbers, or a reason the leg cannot be priced.
 */
function optionLegQuote(snapshot, symbol) {
	const label = describeOption(symbol)
	const q = snapshot.quotes?.[symbol]
	if (!q) {
		return { ok: false, reason: `no quote returned for ${label}` }
	}
	if (q.status !== 'Normal') {
		return {
			ok: false,
			reason: `${label} quote status is ${q.status ?? 'unknown'}, not Normal — its bid/ask is frozen`,
		}
	}
	if (q.bid == null || q.ask == null) {
		return {
			ok: false,
			reason: `${label} has no two-sided quote (bid/ask missing)`,
		}
	}
	if (q.ask < q.bid) {
		return {
			ok: false,
			reason: `${label} quote is crossed (bid ${q.bid} > ask ${q.ask})`,
		}
	}
	const mid = (q.bid + q.ask) / 2
	const spread = q.ask - q.bid
	if (
		spread > OPTION_SPREAD_ABS_FLOOR &&
		mid > 0 &&
		spread / mid > OPTION_MAX_SPREAD_PCT
	) {
		return {
			ok: false,
			reason:
				`${label} spread ${money(spread)} is ${Math.round((spread / mid) * 100)}% of ` +
				`its ${money(mid)} mid — too wide to cross safely`,
		}
	}
	return {
		ok: true,
		bid: q.bid,
		ask: q.ask,
		mid: Math.round(mid * 100) / 100,
		mark: q.mark ?? null,
		spread: Math.round(spread * 100) / 100,
		openInterest: q.openInterest ?? null,
	}
}

/**
 * Turn each option divergence into a concrete roll plan, or say why it is not
 * one. Only the shape this pipeline has been designed for is proposable: a
 * covered short call closing at one strike/expiry and reopening at another,
 * 1:1, as a single net-priced two-leg order. Everything else — ratio changes,
 * puts, long-option inventory, multi-contract reshuffles — is reported with a
 * reason and left for a human, because a wrong pairing here is a naked short.
 *
 * Emitting the order body is not proposing it: nothing is submitted or
 * previewed from this script.
 */
function optionRollPlans(snapshot, portfolio, divergences) {
	const optionQuotesUsable = snapshot.optionQuotes?.ok !== false
	return divergences.map((d) => {
		const reasons = []
		if (!optionQuotesUsable) {
			reasons.push(
				`option quotes unavailable in this snapshot (${snapshot.optionQuotes?.error ?? 'unknown'})`,
			)
		}

		const closes = d.contracts.filter((c) => c.held > c.target)
		const opens = d.contracts.filter((c) => c.target > c.held)
		if (closes.length !== 1 || opens.length !== 1) {
			reasons.push(
				`not a 1:1 roll — ${closes.length} contract(s) to close, ${opens.length} to open; needs a human`,
			)
		}
		if (d.contracts.some((c) => c.held < 0 || c.target < 0)) {
			reasons.push(
				'involves long option inventory, not a plain short-call roll',
			)
		}

		const close = closes[0]
		const open = opens[0]
		const closeParsed = close ? parseOption(close.symbol) : null
		const openParsed = open ? parseOption(open.symbol) : null
		if (closeParsed && openParsed) {
			if (closeParsed.right !== 'C' || openParsed.right !== 'C') {
				reasons.push(
					'not a call roll — shares cannot cover a put, so this path does not price it',
				)
			}
		} else if (close && open) {
			reasons.push('could not parse both contract symbols')
		}

		const closeQty = close ? close.held - close.target : 0
		const openQty = open ? open.target - open.held : 0
		if (close && open && closeQty !== openQty) {
			reasons.push(
				`unbalanced: closing ${closeQty} contract(s) but opening ${openQty}`,
			)
		}
		const contracts = closeQty === openQty ? closeQty : null

		// Coverage after the roll, computed the same conservative way the worker
		// does it: only shares cover, long calls never do.
		const shares = portfolio.equity.get(d.underlying)?.longQuantity ?? 0
		let shortCallsNow = 0
		for (const [symbol, position] of portfolio.options) {
			const parsed = parseOption(symbol)
			if (parsed?.underlying !== d.underlying || parsed.right !== 'C') continue
			shortCallsNow += position.shortQuantity ?? 0
		}
		const shortCallsAfter =
			contracts === null
				? shortCallsNow
				: Math.max(0, shortCallsNow - closeQty) + openQty
		const requiredShares = shortCallsAfter * 100
		const covered = shares >= requiredShares
		if (!covered) {
			reasons.push(
				`would leave ${shortCallsAfter} short call(s) needing ${requiredShares} shares against ${shares} held`,
			)
		}

		// Expiry sanity: a contract past its date is untradeable, and the fact
		// it is still open means the position itself needs attention.
		const closeDte = closeParsed
			? daysUntil(snapshot.asOf, closeParsed.expiry)
			: null
		const openDte = openParsed
			? daysUntil(snapshot.asOf, openParsed.expiry)
			: null
		if (closeDte !== null && closeDte < 0) {
			reasons.push(
				`closing leg expired ${-closeDte} day(s) ago — manual review`,
			)
		}
		if (openDte !== null && openDte < 0) {
			reasons.push('opening leg expiry is in the past — the snapshot is stale')
		}

		// Price it only when the shape is right; a wide-quote reason on a plan
		// that was never a roll is noise.
		let closeQuote = null
		let openQuote = null
		let pricing = null
		if (reasons.length === 0 && close && open && contracts) {
			closeQuote = optionLegQuote(snapshot, close.symbol)
			openQuote = optionLegQuote(snapshot, open.symbol)
			if (!closeQuote.ok) reasons.push(closeQuote.reason)
			if (!openQuote.ok) reasons.push(openQuote.reason)
			if (closeQuote.ok && openQuote.ok) {
				// Cross both legs: pay the ask to close, take the bid to open.
				const net = openQuote.bid - closeQuote.ask
				const netMid = openQuote.mid - closeQuote.mid
				const rounded = Math.round(net * 100) / 100
				pricing = {
					orderType:
						rounded > 0 ? 'NET_CREDIT' : rounded < 0 ? 'NET_DEBIT' : 'NET_ZERO',
					direction: rounded > 0 ? 'credit' : rounded < 0 ? 'debit' : 'even',
					netPrice: Math.abs(rounded),
					netCrossed: rounded,
					netAtMid: Math.round(netMid * 100) / 100,
					// What crossing both spreads costs versus trading at the mids.
					givesUp: Math.round((netMid - rounded) * 100) / 100,
					notional: Math.abs(rounded) * contracts * 100,
				}
			}
		}

		// Schwab's complexOrderStrategyType for a two-leg package. Same expiry,
		// different strikes is a VERTICAL — not VERTICAL_ROLL, which is for
		// rolling an entire vertical (four legs).
		const rollType =
			closeParsed && openParsed
				? closeParsed.expiry === openParsed.expiry
					? 'VERTICAL'
					: closeParsed.strike === openParsed.strike
						? 'CALENDAR'
						: 'DIAGONAL'
				: null

		const proposable = reasons.length === 0 && pricing !== null
		return {
			underlying: d.underlying,
			rollType,
			contracts,
			close: close
				? {
						symbol: close.symbol,
						description: close.description,
						instruction: 'BUY_TO_CLOSE',
						quantity: closeQty,
						daysToExpiry: closeDte,
						quote: closeQuote?.ok ? closeQuote : null,
					}
				: null,
			open: open
				? {
						symbol: open.symbol,
						description: open.description,
						instruction: 'SELL_TO_OPEN',
						quantity: openQty,
						daysToExpiry: openDte,
						quote: openQuote?.ok ? openQuote : null,
					}
				: null,
			pricing,
			coverage: {
				shares,
				shortCallsNow,
				shortCallsAfter,
				requiredShares,
				covered,
			},
			proposable,
			reasons,
			// Ready to drop into a proposal's `orders` array as-is.
			order:
				proposable && pricing
					? {
							session: 'NORMAL',
							duration: 'DAY',
							orderType: pricing.orderType,
							price: pricing.netPrice,
							// Required, and it must name the real strategy. With NONE,
							// Schwab treats the order as a simple one, reads `price` as a
							// plain limit price, and rejects it: "Limit price must be
							// populated only for limit orders." VERTICAL + NET_DEBIT
							// previews 200 (verified 2026-08-18).
							complexOrderStrategyType: rollType,
							orderStrategyType: 'SINGLE',
							orderLegCollection: [
								{
									instruction: 'BUY_TO_CLOSE',
									quantity: contracts,
									instrument: { symbol: close.symbol, assetType: 'OPTION' },
								},
								{
									instruction: 'SELL_TO_OPEN',
									quantity: contracts,
									instrument: { symbol: open.symbol, assetType: 'OPTION' },
								},
							],
						}
					: null,
		}
	})
}

function coverage(indexed) {
	const shortCalls = new Map()
	for (const [symbol, position] of indexed.options) {
		if (!position.shortQuantity) continue
		const parsed = parseOption(symbol)
		if (!parsed || parsed.right !== 'C') continue
		shortCalls.set(
			parsed.underlying,
			(shortCalls.get(parsed.underlying) ?? 0) + position.shortQuantity,
		)
	}
	const rows = []
	for (const [underlying, contracts] of [...shortCalls].sort()) {
		const shares = indexed.equity.get(underlying)?.longQuantity ?? 0
		const required = contracts * 100
		rows.push({
			underlying,
			contracts,
			shares,
			required,
			surplus: shares - required,
			covered: shares >= required,
		})
	}
	return rows
}

function money(value) {
	if (value == null) return 'n/a'
	const sign = value < 0 ? '-' : ''
	return `${sign}$${Math.abs(value).toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`
}

function signedMoney(value) {
	return `${value >= 0 ? '+' : '−'}${money(Math.abs(value))}`
}

function report(result) {
	const {
		snapshot,
		balances,
		gaps,
		options,
		optionGaps,
		coverageRows,
		cleanup,
	} = result
	const lines = []
	const push = (line = '') => lines.push(line)

	push(
		`Snapshot ${snapshot.asOf} · session ${snapshot.marketSession} ` +
			`(${snapshot.sessionSource}) · pricesTradable ${snapshot.pricesTradable}`,
	)
	push(
		snapshot.pricesTradable
			? 'Pricing basis: live last trade.'
			: 'Pricing basis: prior regular-session close (extended-hours bid/ask ignored).',
	)
	push()

	push('BALANCES')
	for (const row of balances) {
		push(
			`  ${row.account}: liquidation ${money(row.liquidationValue)} · ` +
				`cash ${money(row.cashBalance)} · positions ${money(row.positionsValue)}`,
		)
		if (row.reconciles) {
			push('    reconciles exactly')
			continue
		}
		push(
			`    positions + cash = ${money(row.positionsValue + row.cashBalance)} ` +
				`(accurate value) vs reported liquidation ${money(row.liquidationValue)} ` +
				`→ ${signedMoney(row.difference)}`,
		)
		push(
			row.staleLiquidationValue
				? `    NOTE: this liquidationValue is START-OF-DAY and does not move intraday ` +
						`(source: ${row.liquidationValueSource}). The difference therefore mixes ` +
						`unsettled funds with today's P&L and widens through the session — it is ` +
						`not a clean settlement figure. Compare day-over-day at the same time of day.`
				: `    Unsettled funds: clears in ~5 business days. Not margin.`,
		)
	}
	const gap = balances[0].liquidationValue - balances[1].liquidationValue
	push(`  Gap (${PORTFOLIO.label} − ${BENCHMARK.label}): ${signedMoney(gap)}`)
	if (balances[0].staleLiquidationValue !== balances[1].staleLiquidationValue) {
		push(
			`    WARNING: that gap is not like-for-like — ${
				balances[0].staleLiquidationValue ? PORTFOLIO.label : BENCHMARK.label
			}'s liquidationValue is start-of-day while the other is live. Intraday it ` +
				`measures staleness as much as real divergence. Do not headline it mid-session.`,
		)
	}
	push()

	push(`QUANTITY GAPS (equity) — ${gaps.length || 'none'}`)
	for (const g of gaps) {
		const tag = g.proposable
			? ' [≥ threshold → proposable]'
			: ' [below $1,000 threshold]'
		push(
			`  ${g.symbol}: holds ${g.held}, benchmark ${g.target} → ` +
				`${g.action} ${Math.abs(g.delta)} @ ${money(g.price)} (${g.priceBasis}) ` +
				`= ${money(g.notional)}${tag}`,
		)
	}
	push()

	push(`OPTION DIVERGENCES — ${options.length || 'none'}`)
	for (const d of options) {
		push(`  ${d.underlying}:`)
		for (const c of d.contracts) {
			push(
				`    ${c.description}: ${PORTFOLIO.label} net short ${c.held}, ` +
					`${BENCHMARK.label} net short ${c.target}`,
			)
		}
	}
	push()

	const rollable = optionGaps.filter((p) => p.proposable)
	push(`OPTION ROLLS — ${rollable.length} of ${optionGaps.length} proposable`)
	if (snapshot.optionQuotes && snapshot.optionQuotes.ok === false) {
		push(`  NOTE: ${snapshot.optionQuotes.error} — no roll can be priced.`)
	}
	for (const p of optionGaps) {
		const shape =
			p.close && p.open
				? `${p.rollType ?? 'roll'} ${p.contracts ?? '?'}× — close ${p.close.description} ` +
					`(${p.close.daysToExpiry}d), open ${p.open.description} (${p.open.daysToExpiry}d)`
				: 'no clean close/open pair'
		push(`  ${p.underlying}: ${shape}`)
		if (p.pricing) {
			push(
				`    crossed net ${money(p.pricing.netPrice)} ${p.pricing.direction} ` +
					`(${p.pricing.orderType}) = ${money(p.pricing.notional)} · ` +
					`mid would be ${money(Math.abs(p.pricing.netAtMid))} — crossing gives up ` +
					`${money(Math.abs(p.pricing.givesUp))}`,
			)
		}
		push(
			`    coverage after: ${p.coverage.shortCallsAfter} short call(s) need ` +
				`${p.coverage.requiredShares} sh, holds ${p.coverage.shares}` +
				`${p.coverage.covered ? '' : ' — UNCOVERED'}`,
		)
		push(
			p.proposable
				? '    → PROPOSABLE (net-priced 2-leg roll)'
				: `    → report-only: ${p.reasons.join('; ')}`,
		)
	}
	push()

	const uncovered = coverageRows.filter((r) => !r.covered)
	push(
		`COVERAGE (${PORTFOLIO.label}) — ${uncovered.length || 'no'} mismatch(es)`,
	)
	for (const r of coverageRows) {
		const note = r.covered
			? r.surplus === 0
				? 'exactly covered, no surplus'
				: `covered, ${r.surplus} surplus shares`
			: `UNCOVERED by ${Math.abs(r.surplus)} shares`
		push(
			`  ${r.underlying}: short ${r.contracts}c needs ${r.required} sh, holds ${r.shares} — ${note}`,
		)
	}
	push()

	push(
		`CLEANUP (${PORTFOLIO.label}-only equity positions) — ${cleanup.length || 'none'}`,
	)
	for (const c of cleanup)
		push(`  ${c.symbol}: ${c.held} shares, absent from ${BENCHMARK.label}`)
	push()

	const proposable = gaps.filter((g) => g.proposable)
	push(
		`PROPOSABLE EQUITY (scheduled task): ${
			proposable.length
				? proposable
						.map((g) => `${g.symbol} ${g.action} ${Math.abs(g.delta)}`)
						.join(', ')
				: 'nothing — no equity gap clears the $1,000 threshold'
		}`,
	)
	push(
		`PROPOSABLE OPTION ROLLS (manual, via cli/schwab-propose.mjs): ${
			rollable.length
				? rollable
						.map(
							(p) =>
								`${p.underlying} ${p.contracts}× ${p.pricing.direction} ${money(p.pricing.netPrice)}`,
						)
						.join(', ')
				: 'none'
		}`,
	)
	if (rollable.length) {
		push(
			'  Order bodies are in `--json` under optionGaps[].order. The 10:00am ' +
				'propose task does not submit these; copy them into a proposal file.',
		)
	}
	return lines.join('\n')
}

async function main() {
	const snapshot = await fetchSnapshot()
	const portfolio = indexAccount(pickAccount(snapshot, PORTFOLIO))
	const benchmark = indexAccount(pickAccount(snapshot, BENCHMARK))

	const gaps = quantityGaps(snapshot, portfolio, benchmark)
	const options = optionDivergences(portfolio, benchmark)
	const result = {
		snapshot,
		balances: [reconcile(portfolio.account), reconcile(benchmark.account)],
		gaps,
		options,
		optionGaps: optionRollPlans(snapshot, portfolio, options),
		coverageRows: coverage(portfolio),
		benchmarkCoverage: coverage(benchmark),
		cleanup: [...portfolio.equity.values()]
			.filter((p) => !benchmark.equity.has(p.symbol))
			.map((p) => ({ symbol: p.symbol, held: p.longQuantity })),
	}

	if (process.argv.includes('--json')) {
		const { snapshot: _snapshot, ...rest } = result
		console.log(
			JSON.stringify(
				{
					asOf: snapshot.asOf,
					marketSession: snapshot.marketSession,
					sessionSource: snapshot.sessionSource,
					pricesTradable: snapshot.pricesTradable,
					...rest,
				},
				null,
				2,
			),
		)
		return
	}
	console.log(report(result))
}

await main()

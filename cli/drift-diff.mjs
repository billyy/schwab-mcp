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
 * Config (env var wins, falls back to macOS Keychain):
 *   WORKER_URL       default: http://localhost:8788
 *   ORDER_API_KEY    or Keychain: security add-generic-password -s schwab-mcp-order -a api-key -w '<key>'
 */
import { execFileSync } from 'node:child_process'

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8788'
const PORTFOLIO = { number: '13102970', label: 'Partnership' }
const BENCHMARK = { number: '80745838', label: 'CRT' }

/** Held elsewhere (Fidelity) — divergences are surfaced, never actioned. */
const POLICY_EXCLUDED = new Set(['BSX'])

/** Equity gaps below this notional are noise, not rebalance candidates. */
const PROPOSAL_THRESHOLD = 1000

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
			excluded: POLICY_EXCLUDED.has(symbol),
			proposable:
				!POLICY_EXCLUDED.has(symbol) &&
				notional != null &&
				notional >= PROPOSAL_THRESHOLD,
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
			excluded: POLICY_EXCLUDED.has(underlying),
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
	const { snapshot, balances, gaps, options, coverageRows, cleanup } = result
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
		const tag = g.excluded
			? ' [POLICY-EXCLUDED, report-only]'
			: g.proposable
				? ' [≥ threshold → proposable]'
				: ' [below $1,000 threshold]'
		push(
			`  ${g.symbol}: holds ${g.held}, benchmark ${g.target} → ` +
				`${g.action} ${Math.abs(g.delta)} @ ${money(g.price)} (${g.priceBasis}) ` +
				`= ${money(g.notional)}${tag}`,
		)
	}
	push()

	push(`OPTION DIVERGENCES — ${options.length || 'none'} (always report-only)`)
	for (const d of options) {
		push(`  ${d.underlying}${d.excluded ? ' [POLICY-EXCLUDED]' : ''}:`)
		for (const c of d.contracts) {
			push(
				`    ${c.description}: ${PORTFOLIO.label} net short ${c.held}, ` +
					`${BENCHMARK.label} net short ${c.target}`,
			)
		}
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
		`PROPOSABLE AFTER THE OPEN: ${
			proposable.length
				? proposable
						.map((g) => `${g.symbol} ${g.action} ${Math.abs(g.delta)}`)
						.join(', ')
				: 'nothing — no equity gap clears the $1,000 threshold'
		}`,
	)
	return lines.join('\n')
}

async function main() {
	const snapshot = await fetchSnapshot()
	const portfolio = indexAccount(pickAccount(snapshot, PORTFOLIO))
	const benchmark = indexAccount(pickAccount(snapshot, BENCHMARK))

	const gaps = quantityGaps(snapshot, portfolio, benchmark)
	const result = {
		snapshot,
		balances: [reconcile(portfolio.account), reconcile(benchmark.account)],
		gaps,
		options: optionDivergences(portfolio, benchmark),
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

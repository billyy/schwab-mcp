#!/usr/bin/env node
/**
 * schwab-request — send ANY order to Slack for human approval. Posts a
 * `kind: "manual"` proposal to the Worker's /proposals endpoint: the same
 * validation, guardrails, Schwab preview, Approve/Reject buttons and LLM-free
 * executor as the drift pipeline, but a manual request never supersedes the
 * pending drift proposal (or another manual request), and vice versa. This
 * script never places orders itself.
 *
 * Usage — shorthand for a single-leg order:
 *   node cli/schwab-request.mjs <buy|sell> <shares> <SYMBOL> --limit <price> --account <acct> [options]
 *
 *   node cli/schwab-request.mjs buy 25 VTI --limit 251.40 --account 970
 *       → LIMIT BUY 25 × VTI @ $251.40, DAY
 *
 * Usage — any order body (options, spreads, GTC, several orders at once):
 *   node cli/schwab-request.mjs --order order.json --account <acct> [--note "..."]
 *   order.json holds one PlaceOrderParams object or an array of up to 10.
 *
 * Options:
 *   --account <acct>   plain number, or its unique last digits as Schwab shows
 *                      them ("…260" / "260"). Required unless every order
 *                      carries its own accountNumber.
 *   --limit <price>    limit price (required)
 *   --duration <d>     DAY (default) | GOOD_TILL_CANCEL | GTC | FILL_OR_KILL ...
 *   --note "<text>"    why — shown at the top of the Slack message
 *   --allow-duplicate  approve even if an identical order is already open
 *   --dry-run          preview with Schwab only; nothing stored or posted
 *
 * What the Worker refuses, and why it will not be talked out of it:
 *   - Orders with no limit price (MARKET, STOP). An approval can land hours
 *     after the request; a priceless order would fill at whatever the market
 *     is then.
 *   - Mutual and money-market funds (e.g. SWVXX), and dollar-sized orders.
 *     Schwab's Trader API only takes EQUITY and OPTION orders in shares —
 *     those must be placed on schwab.com.
 *   - Limit-priced orders outside the regular session (stale book).
 *   - Short calls not covered by shares, the daily cap, the symbol allowlist
 *     and ORDER_MAX_NOTIONAL, exactly as for /orders.
 *
 * Config (env var wins, falls back to macOS Keychain):
 *   WORKER_URL       default http://localhost:8788
 *   ORDER_API_KEY    or Keychain: security add-generic-password -s schwab-mcp-order -a api-key -w '<key>'
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8788'
const PROPOSALS_URL = `${WORKER_URL.replace(/\/$/, '')}/proposals`

const VALUE_FLAGS = new Set([
	'--account',
	'--limit',
	'--duration',
	'--note',
	'--order',
])
const BOOL_FLAGS = new Set(['--allow-duplicate', '--dry-run'])

function fail(message) {
	console.error(`✖ ${message}`)
	process.exit(1)
}

function usd(n) {
	return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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

function parseArgs(argv) {
	const flags = {}
	const positional = []
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (VALUE_FLAGS.has(a)) {
			if (i + 1 >= argv.length) fail(`${a} needs a value`)
			flags[a.slice(2)] = argv[++i]
		} else if (BOOL_FLAGS.has(a)) {
			flags[a.slice(2)] = true
		} else if (a.startsWith('--')) {
			fail(`Unknown option ${a}`)
		} else {
			positional.push(a)
		}
	}
	return { flags, positional }
}

function parseShares(raw) {
	if (raw.startsWith('$')) {
		fail(
			"Dollar amounts can't be ordered: Schwab's Trader API only sizes orders in shares. " +
				'(Money-market funds such as SWVXX cannot be ordered through the API at all — use schwab.com.)',
		)
	}
	const n = Number(raw.replace(/,/g, ''))
	if (!Number.isFinite(n) || n <= 0) fail(`Not a positive share count: ${raw}`)
	return n
}

function buildShorthandOrder(positional, flags) {
	if (positional.length !== 3) {
		fail(
			'Usage: schwab-request.mjs <buy|sell> <shares> <SYMBOL> --limit <price> --account <acct>\n' +
				'   or: schwab-request.mjs --order <order.json> --account <acct>',
		)
	}
	const [side, amountRaw, symbolRaw] = positional
	const instruction = side.toUpperCase()
	if (instruction !== 'BUY' && instruction !== 'SELL') {
		fail(
			`Side must be buy or sell, got "${side}" (use --order for anything else)`,
		)
	}
	const symbol = symbolRaw.toUpperCase()
	const quantity = parseShares(amountRaw)
	const duration = flags.duration ?? 'DAY'

	if (flags.limit === undefined) {
		fail(
			`${symbol} needs --limit <price>. Approval can land hours later, so priceless ` +
				'(MARKET) equity orders are refused by the Worker.',
		)
	}
	const price = Number(flags.limit)
	if (!Number.isFinite(price) || price <= 0)
		fail(`Not a valid limit price: ${flags.limit}`)
	return {
		order: {
			orderType: 'LIMIT',
			price,
			session: 'NORMAL',
			duration,
			orderStrategyType: 'SINGLE',
			orderLegCollection: [
				{ instruction, quantity, instrument: { symbol, assetType: 'EQUITY' } },
			],
		},
		words: `LIMIT ${instruction} ${quantity} × ${symbol} @ ${usd(price)} (${duration})`,
	}
}

function readOrders(path) {
	let parsed
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'))
	} catch (error) {
		fail(`Could not read ${path}: ${error.message}`)
	}
	const orders = Array.isArray(parsed) ? parsed : [parsed]
	if (orders.length === 0) fail(`${path} holds no orders`)
	return orders
}

async function main() {
	const { flags, positional } = parseArgs(process.argv.slice(2))

	let orders
	let words
	if (flags.order) {
		if (positional.length > 0)
			fail('Give either --order <file> or the shorthand, not both')
		orders = readOrders(flags.order)
		words = `${orders.length} order(s) from ${flags.order}`
	} else {
		const built = buildShorthandOrder(positional, flags)
		orders = [built.order]
		words = built.words
	}

	const accountLabel = flags.account
		? ` in account …${flags.account.replace(/\D/g, '').slice(-3)}`
		: ''
	const summary = `Manual order request: ${words}${accountLabel}.${flags.note ? ` ${flags.note}` : ''}`
	const proposal = {
		kind: 'manual',
		summary,
		...(flags.account ? { accountNumber: flags.account } : {}),
		orders,
		...(flags['allow-duplicate'] ? { allowDuplicate: true } : {}),
		...(flags['dry-run'] ? { dryRun: true } : {}),
	}

	const apiKey = getApiKey()
	console.log(
		flags['dry-run']
			? `→ DRY RUN via ${PROPOSALS_URL} — previews only, nothing stored or posted to Slack\n  ${summary}\n`
			: `→ Requesting approval via ${PROPOSALS_URL}\n  ${summary}\n`,
	)
	let res
	try {
		res = await fetch(PROPOSALS_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(proposal),
		})
	} catch (error) {
		fail(`Could not reach ${PROPOSALS_URL}: ${error.message}`)
	}
	const json = await res.json().catch(() => null)
	if (res.status !== 200) {
		console.error(JSON.stringify(json, null, 2))
		fail(`Request rejected (HTTP ${res.status})`)
	}

	const lines = (json.orders ?? []).map((o, i) => {
		const notional = o.notional === null ? '' : ` ~${usd(o.notional)}`
		return `  ${i + 1}. ${o.symbols.join(', ')}${notional} (preview ${o.previewStatus}, hash ${o.orderHash.slice(0, 8)})`
	})
	if (json.dryRun) {
		console.log(
			`✔ Dry run OK — ${lines.length} order(s) previewed by Schwab. Nothing stored, nothing posted.`,
		)
		console.log(
			`  Market session: ${json.marketSession}${json.sessionGuardWouldBlock ? ' — a real request would be blocked by the session guard.' : ''}`,
		)
		console.log(lines.join('\n'))
		return
	}
	console.log(
		`✔ Approval request ${json.proposalId} posted to Slack (expires ${json.expiresAt}).`,
	)
	console.log(lines.join('\n'))
	console.log('\nApprove or reject it from the Slack message.')
}

await main()

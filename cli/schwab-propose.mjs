#!/usr/bin/env node
/**
 * schwab-propose — POST a drift-rebalance proposal to the Worker's /proposals
 * endpoint. The Worker validates every order, previews it with Schwab, stores
 * the proposal, and posts a Slack message with Approve/Reject buttons.
 * Execution only happens when an authorized user clicks Approve in Slack —
 * this script never places orders itself.
 *
 * Usage:
 *   node cli/schwab-propose.mjs <proposal.json>
 *   cat proposal.json | node cli/schwab-propose.mjs -
 *
 * Proposal JSON:
 *   {
 *     "summary": "Partnership drifted vs CRT: SCHW -62 shares, NDAQ -70",
 *     "accountNumber": "12345678",          // default for orders lacking one
 *     "orders": [ <PlaceOrderParams>, ... ] // LIMIT orders only
 *   }
 *
 * Config (env var wins, falls back to macOS Keychain):
 *   WORKER_URL       e.g. https://your-worker.workers.dev  (default: http://localhost:8788)
 *   ORDER_API_KEY    or Keychain: security add-generic-password -s schwab-mcp-order -a api-key -w '<key>'
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8788'
const PROPOSALS_URL = `${WORKER_URL.replace(/\/$/, '')}/proposals`

function fail(message) {
	console.error(`✖ ${message}`)
	process.exit(1)
}

function getApiKey() {
	if (process.env.ORDER_API_KEY) return process.env.ORDER_API_KEY
	try {
		return execFileSync(
			'security',
			['find-generic-password', '-s', 'schwab-mcp-order', '-a', 'api-key', '-w'],
			{ encoding: 'utf8' },
		).trim()
	} catch {
		fail(
			'No API key. Set ORDER_API_KEY or store it in the Keychain:\n' +
				"  security add-generic-password -s schwab-mcp-order -a api-key -w '<key>'",
		)
	}
}

function readProposal(arg) {
	const raw = arg === '-' ? readFileSync(0, 'utf8') : readFileSync(arg, 'utf8')
	try {
		return JSON.parse(raw)
	} catch (error) {
		fail(`Proposal file is not valid JSON: ${error.message}`)
	}
}

async function main() {
	const fileArg = process.argv.slice(2).find((a) => !a.startsWith('--'))
	if (!fileArg) {
		fail('Usage: schwab-propose.mjs <proposal.json | ->')
	}

	const proposal = readProposal(fileArg)
	const apiKey = getApiKey()

	console.log(`→ Posting proposal via ${PROPOSALS_URL} ...\n`)
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
		fail(`Proposal rejected (HTTP ${res.status})`)
	}

	console.log(`✔ Proposal ${json.proposalId} created (expires ${json.expiresAt}).`)
	if (json.superseded?.length) {
		console.log(`  Superseded prior pending proposal(s): ${json.superseded.join(', ')}`)
	}
	for (const [i, o] of (json.orders ?? []).entries()) {
		const notional = o.notional !== null ? ` ~$${o.notional.toFixed(2)}` : ''
		console.log(
			`  ${i + 1}. ${o.symbols.join(', ')}${notional} (preview ${o.previewStatus}, hash ${o.orderHash.slice(0, 8)})`,
		)
	}
	console.log('\nApprove or reject it from the Slack message.')
}

await main()

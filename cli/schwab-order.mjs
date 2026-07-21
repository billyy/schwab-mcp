#!/usr/bin/env node
/**
 * schwab-order — submit an order proposal to the Worker's /orders endpoint.
 *
 * The execution path is deliberately dumb and deterministic: this script
 * validates nothing itself — the Worker validates against the same Zod
 * schema the MCP tools use, runs Schwab's own previewOrder, applies
 * server-side limits, and only places the order when you confirm.
 *
 * Usage:
 *   node cli/schwab-order.mjs <order.json>          # preview, then confirm interactively
 *   node cli/schwab-order.mjs <order.json> --yes    # skip the interactive prompt (still previews)
 *   cat order.json | node cli/schwab-order.mjs -    # read order from stdin
 *
 * Config (env var wins, falls back to macOS Keychain):
 *   WORKER_URL       e.g. https://your-worker.workers.dev  (default: http://localhost:8788)
 *   ORDER_API_KEY    or Keychain: security add-generic-password -s schwab-mcp-order -a api-key -w '<key>'
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8788'
const ORDERS_URL = `${WORKER_URL.replace(/\/$/, '')}/orders`

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

function readOrder(arg) {
	const raw =
		arg === '-' ? readFileSync(0, 'utf8') : readFileSync(arg, 'utf8')
	try {
		return JSON.parse(raw)
	} catch (error) {
		fail(`Order file is not valid JSON: ${error.message}`)
	}
}

async function post(apiKey, body) {
	let res
	try {
		res = await fetch(ORDERS_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		})
	} catch (error) {
		fail(`Could not reach ${ORDERS_URL}: ${error.message}`)
	}
	const json = await res.json().catch(() => null)
	return { status: res.status, json }
}

function describeOrder(order) {
	const legs = order.orderLegCollection ?? []
	const lines = legs.map((leg) => {
		const sym = leg.instrument?.symbol ?? '?'
		const type = leg.instrument?.assetType ?? ''
		return `  ${leg.instruction ?? '?'} ${leg.quantity ?? '?'} × ${sym}${type ? ` (${type})` : ''}`
	})
	const price =
		order.price !== undefined ? ` @ $${order.price}` : ' @ MARKET'
	return [
		`  Account:  ${order.accountNumber}`,
		`  Type:     ${order.orderType}${price}  ${order.duration ?? ''} ${order.session ?? ''}`,
		...lines,
	].join('\n')
}

async function main() {
	const args = process.argv.slice(2)
	const skipPrompt = args.includes('--yes')
	const fileArg = args.find((a) => !a.startsWith('--'))
	if (!fileArg) {
		fail('Usage: schwab-order.mjs <order.json | -> [--yes]')
	}

	const order = readOrder(fileArg)
	const apiKey = getApiKey()

	// --- Step 1: preview (server validates, runs Schwab previewOrder, checks limits) ---
	console.log(`→ Previewing order via ${ORDERS_URL} ...\n`)
	const preview = await post(apiKey, { order, submit: false })
	if (preview.status !== 200) {
		console.error(JSON.stringify(preview.json, null, 2))
		fail(`Preview rejected (HTTP ${preview.status})`)
	}

	console.log('── Order ──────────────────────────────')
	console.log(describeOrder(order))
	console.log('── Schwab preview ─────────────────────')
	console.log(JSON.stringify(preview.json.schwabPreview, null, 2))
	if (preview.json.duplicateOpenOrder) {
		console.log('\n⚠ An identical open order already exists:')
		console.log(JSON.stringify(preview.json.duplicateOpenOrder, null, 2))
	}
	console.log('───────────────────────────────────────\n')

	// --- Step 2: human confirmation ---
	if (!skipPrompt) {
		const rl = createInterface({ input: process.stdin, output: process.stdout })
		const answer = await rl.question(
			'Place this order for REAL? Type "yes" to submit: ',
		)
		rl.close()
		if (answer.trim().toLowerCase() !== 'yes') {
			console.log('Aborted — no order placed.')
			process.exit(0)
		}
	}

	// --- Step 3: submit, bound to the previewed order via orderHash ---
	const submit = await post(apiKey, {
		order,
		submit: true,
		orderHash: preview.json.orderHash,
	})
	if (submit.status !== 200) {
		console.error(JSON.stringify(submit.json, null, 2))
		fail(`Submission failed (HTTP ${submit.status})`)
	}

	console.log('✔ Order submitted.')
	console.log(JSON.stringify(submit.json.result, null, 2))
}

await main()

#!/usr/bin/env node
/**
 * sign-slack-request — DEV ONLY. Simulate a Slack interactivity callback
 * against a local worker by signing a block_actions payload exactly the way
 * Slack does (v0 HMAC-SHA256 over "v0:<ts>:<raw body>").
 *
 * Slack cannot reach `wrangler dev`, so this is how the /slack/interactions
 * endpoint is exercised locally: approve/reject flows, bad signatures, stale
 * timestamps, non-approver users, tampered proposal IDs.
 *
 * Usage:
 *   node cli/sign-slack-request.mjs approve <proposalId> [--user U123] [--stale] [--bad-sig]
 *   node cli/sign-slack-request.mjs reject  <proposalId> [--user U123]
 *
 * Config:
 *   WORKER_URL            default http://localhost:8788
 *   SLACK_SIGNING_SECRET  must match the worker's .dev.vars value
 *   SLACK_USER_ID         default user when --user is not given
 */
import { createHmac } from 'node:crypto'

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8788'
const URL_ = `${WORKER_URL.replace(/\/$/, '')}/slack/interactions`

function fail(message) {
	console.error(`✖ ${message}`)
	process.exit(1)
}

const args = process.argv.slice(2)
const action = args[0]
const proposalId = args[1]
if (!['approve', 'reject'].includes(action) || !proposalId) {
	fail('Usage: sign-slack-request.mjs <approve|reject> <proposalId> [--user U...] [--stale] [--bad-sig]')
}
const userFlag = args.indexOf('--user')
const userId =
	userFlag !== -1 ? args[userFlag + 1] : (process.env.SLACK_USER_ID ?? 'U000TEST')
const secret = process.env.SLACK_SIGNING_SECRET
if (!secret) fail('SLACK_SIGNING_SECRET is required (must match .dev.vars)')

const payload = {
	type: 'block_actions',
	user: { id: userId },
	actions: [
		{
			action_id: action === 'approve' ? 'approve_proposal' : 'reject_proposal',
			value: proposalId,
		},
	],
	// response_url is optional in the worker; omit it locally (Slack's
	// hooks.slack.com URL would not resolve to anything useful anyway)
}
const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`

let ts = Math.floor(Date.now() / 1000)
if (args.includes('--stale')) ts -= 600
let signature =
	'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')
if (args.includes('--bad-sig')) signature = 'v0=' + '0'.repeat(64)

const res = await fetch(URL_, {
	method: 'POST',
	headers: {
		'Content-Type': 'application/x-www-form-urlencoded',
		'X-Slack-Request-Timestamp': String(ts),
		'X-Slack-Signature': signature,
	},
	body,
})
const text = await res.text()
console.log(`HTTP ${res.status}`)
if (text) console.log(text)

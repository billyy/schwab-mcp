import { secureCompare } from '../orders/core'
import { type ProposalRecord, type ProposalOrder } from '../proposals/types'
import { SLACK_API_BASE_URL, LOGGER_CONTEXTS } from './constants'
import { logger } from './log'

const slackLogger = logger.child(LOGGER_CONTEXTS.PROPOSALS)

/** Max age of a Slack request signature before it is rejected as a replay */
const SLACK_SIGNATURE_TOLERANCE_SECONDS = 300

/**
 * Verify Slack's v0 request signature over the raw request body.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export async function verifySlackSignature(
	signingSecret: string,
	timestamp: string | null,
	signature: string | null,
	rawBody: string,
): Promise<boolean> {
	if (!timestamp || !signature) return false
	const ts = Number(timestamp)
	if (!Number.isFinite(ts)) return false
	const ageSeconds = Math.abs(Date.now() / 1000 - ts)
	if (ageSeconds > SLACK_SIGNATURE_TOLERANCE_SECONDS) return false

	const encoder = new TextEncoder()
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(signingSecret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const mac = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode(`v0:${timestamp}:${rawBody}`),
	)
	const expected =
		'v0=' +
		[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
	return secureCompare(expected, signature)
}

/** Minimal Slack Web API client (chat.postMessage / chat.update) */
export async function slackApi(
	token: string,
	method: 'chat.postMessage' | 'chat.update',
	body: Record<string, unknown>,
): Promise<{ ok: boolean; ts?: string; channel?: string; error?: string }> {
	try {
		const res = await fetch(`${SLACK_API_BASE_URL}/${method}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json; charset=utf-8',
			},
			body: JSON.stringify(body),
		})
		const json = (await res.json()) as {
			ok: boolean
			ts?: string
			channel?: string
			error?: string
		}
		if (!json.ok) {
			slackLogger.warn(`Slack ${method} failed`, { error: json.error })
		}
		return json
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		slackLogger.warn(`Slack ${method} threw`, { error: message })
		return { ok: false, error: message }
	}
}

/** Post an ephemeral-style reply via an interaction's response_url */
export async function respondEphemeral(
	responseUrl: string,
	text: string,
): Promise<void> {
	try {
		await fetch(responseUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				response_type: 'ephemeral',
				replace_original: false,
				text,
			}),
		})
	} catch (error) {
		slackLogger.warn('Slack response_url post failed', {
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

function usd(n: number): string {
	return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** One-line human description of an order, e.g. "LIMIT BUY 10 × VTI @ $250.00 — ~$2,500.00" */
export function describeOrder(po: ProposalOrder): string {
	const order = po.order as any
	const legs: any[] = order.orderLegCollection ?? []
	const legText = legs
		.map((leg) => {
			const qty = leg?.quantity ?? '?'
			const symbol = leg?.instrument?.symbol ?? '?'
			const instruction = leg?.instruction ?? '?'
			return `${instruction} ${qty} × ${symbol}`
		})
		.join(', ')
	const price = typeof order.price === 'number' ? ` @ ${usd(order.price)}` : ''
	const notional = po.notional !== null ? ` — ~${usd(po.notional)}` : ''
	return `${order.orderType ?? '?'} ${legText}${price}${notional}`
}

function totalNotional(p: ProposalRecord): number {
	return p.orders.reduce((sum, o) => sum + (o.notional ?? 0), 0)
}

function summaryBlocks(p: ProposalRecord): unknown[] {
	return [
		{
			type: 'header',
			text: { type: 'plain_text', text: 'Drift rebalance proposal', emoji: true },
		},
		{ type: 'section', text: { type: 'mrkdwn', text: p.summary } },
		{
			type: 'section',
			text: {
				type: 'mrkdwn',
				text: p.orders.map((o, i) => `*${i + 1}.* ${describeOrder(o)}`).join('\n'),
			},
		},
	]
}

/** Blocks for a freshly created (pending) proposal, with Approve/Reject buttons */
export function buildProposalBlocks(p: ProposalRecord): unknown[] {
	const expiresUnix = Math.floor(new Date(p.expiresAt).getTime() / 1000)
	const total = totalNotional(p)
	return [
		...summaryBlocks(p),
		{
			type: 'context',
			elements: [
				{
					type: 'mrkdwn',
					text: `Total ~${usd(total)} · Expires <!date^${expiresUnix}^{time}|${p.expiresAt}> · \`${p.id.slice(0, 8)}\``,
				},
			],
		},
		{
			type: 'actions',
			block_id: 'proposal_actions',
			elements: [
				{
					type: 'button',
					action_id: 'approve_proposal',
					style: 'primary',
					text: { type: 'plain_text', text: 'Approve & execute', emoji: true },
					value: p.id,
					confirm: {
						title: { type: 'plain_text', text: 'Execute orders?' },
						text: {
							type: 'mrkdwn',
							text: `Place ${p.orders.length} order(s) totaling ~${usd(total)} at Schwab.`,
						},
						confirm: { type: 'plain_text', text: 'Execute' },
						deny: { type: 'plain_text', text: 'Cancel' },
					},
				},
				{
					type: 'button',
					action_id: 'reject_proposal',
					style: 'danger',
					text: { type: 'plain_text', text: 'Reject', emoji: true },
					value: p.id,
				},
			],
		},
	]
}

/** Blocks for a terminal proposal state — buttons replaced by per-order outcomes */
export function buildOutcomeBlocks(
	p: ProposalRecord,
	headline: string,
): unknown[] {
	const lines = p.orders.map((o, i) => {
		const desc = describeOrder(o)
		const r = o.result
		if (!r) return `▫️ *${i + 1}.* ${desc} — not attempted`
		if (r.ok) return `✅ *${i + 1}.* ${desc}`
		if (r.stage === 'skipped') return `⏭ *${i + 1}.* ${desc} — ${r.error}`
		return `❌ *${i + 1}.* ${desc} — ${r.error}`
	})
	return [
		...summaryBlocks(p).slice(0, 2),
		{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
		{
			type: 'context',
			elements: [{ type: 'mrkdwn', text: headline }],
		},
	]
}

/** Blocks for pending-terminal states with no execution (rejected/expired/superseded) */
export function buildClosedBlocks(p: ProposalRecord, headline: string): unknown[] {
	return [
		...summaryBlocks(p),
		{ type: 'context', elements: [{ type: 'mrkdwn', text: headline }] },
	]
}

import { type Env } from '../../types/env'
import { getConfig } from '../config'
import { jsonResponse } from '../orders/core'
import { LOGGER_CONTEXTS } from '../shared/constants'
import { logger } from '../shared/log'
import {
	buildClosedBlocks,
	respondEphemeral,
	slackApi,
	verifySlackSignature,
} from '../shared/slack'
import { executeProposal } from './executor'
import { slackFeatureMissing } from './handler'
import { proposalStore } from './store'
import { type ProposalRecord } from './types'

const interactionsLogger = logger.child(LOGGER_CONTEXTS.PROPOSALS)

interface BlockActionPayload {
	type?: string
	user?: { id?: string }
	actions?: { action_id?: string; value?: string }[]
	response_url?: string
}

/**
 * POST /slack/interactions — Slack interactivity callback for proposal
 * Approve/Reject buttons. The Slack signature is verified over the raw body
 * before anything is parsed; approval is limited to SLACK_APPROVER_IDS; and
 * the ProposalStore's atomic claim guarantees a proposal executes at most
 * once. Must respond within Slack's 3s deadline, so execution runs in
 * ctx.waitUntil after an immediate 200.
 */
export async function handleSlackInteraction(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'Method not allowed. Use POST.' })
	}
	const config = getConfig(env)
	const missing = slackFeatureMissing(config, env)
	if (missing) {
		return jsonResponse(503, {
			error: `Slack interactions endpoint disabled. Missing: ${missing}`,
		})
	}

	// --- Verify Slack's signature over the RAW body before parsing anything ---
	const rawBody = await request.text()
	const verified = await verifySlackSignature(
		config.SLACK_SIGNING_SECRET!,
		request.headers.get('X-Slack-Request-Timestamp'),
		request.headers.get('X-Slack-Signature'),
		rawBody,
	)
	if (!verified) {
		interactionsLogger.warn('Slack interaction: signature verification failed')
		return jsonResponse(401, { error: 'Unauthorized' })
	}

	let payload: BlockActionPayload
	try {
		payload = JSON.parse(
			new URLSearchParams(rawBody).get('payload') ?? '',
		) as BlockActionPayload
	} catch {
		return jsonResponse(400, { error: 'Invalid interaction payload' })
	}
	if (payload.type !== 'block_actions') {
		// Not a button click (e.g. a future shortcut) — ack and ignore.
		return new Response('', { status: 200 })
	}
	const action = payload.actions?.[0]
	const actionId = action?.action_id
	const proposalId = action?.value
	const userId = payload.user?.id
	const responseUrl = payload.response_url
	if (!actionId || !proposalId || !userId) {
		return jsonResponse(400, { error: 'Malformed block_actions payload' })
	}

	// --- Server-side authorization: channel membership is NOT authorization ---
	const approvers = new Set(
		config.SLACK_APPROVER_IDS!.split(',').map((s) => s.trim()),
	)
	if (!approvers.has(userId)) {
		interactionsLogger.warn('Slack interaction: unauthorized user', { userId })
		if (responseUrl) {
			ctx.waitUntil(
				respondEphemeral(
					responseUrl,
					'You are not authorized to approve or reject proposals.',
				),
			)
		}
		return new Response('', { status: 200 })
	}

	const store = proposalStore(env.PROPOSAL_STORE!)
	const token = config.SLACK_BOT_TOKEN!

	const updateMessage = async (p: ProposalRecord, headline: string) => {
		if (!p.slack) return
		await slackApi(token, 'chat.update', {
			channel: p.slack.channel,
			ts: p.slack.ts,
			text: headline,
			blocks: buildClosedBlocks(p, headline),
		})
	}

	if (actionId === 'reject_proposal') {
		const result = await store.reject(proposalId, userId)
		if (result.ok) {
			ctx.waitUntil(
				updateMessage(result.proposal, `🚫 Rejected by <@${userId}>`),
			)
		} else if (responseUrl) {
			ctx.waitUntil(
				respondEphemeral(
					responseUrl,
					`Cannot reject: proposal is ${result.reason.replace('already_', '')}.`,
				),
			)
		}
		return new Response('', { status: 200 })
	}

	if (actionId === 'approve_proposal') {
		const result = await store.claim(proposalId, userId)
		if (result.ok) {
			interactionsLogger.info('Proposal approved, executing', {
				proposalId,
				userId,
			})
			ctx.waitUntil(executeProposal(env, result.proposal, userId))
			return new Response('', { status: 200 })
		}
		if (result.reason === 'expired' && result.proposal) {
			ctx.waitUntil(
				updateMessage(
					result.proposal,
					`⌛ Expired at ${result.proposal.expiresAt} — re-run the drift task for fresh prices.`,
				),
			)
		} else if (responseUrl) {
			ctx.waitUntil(
				respondEphemeral(
					responseUrl,
					result.reason === 'not_found'
						? 'Unknown proposal (it may have been purged).'
						: `Already handled: proposal is ${result.reason.replace('already_', '')}.`,
				),
			)
		}
		return new Response('', { status: 200 })
	}

	return new Response('', { status: 200 })
}

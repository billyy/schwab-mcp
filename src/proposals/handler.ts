import { scrubAccountIdentifiers } from '@sudowealth/schwab-api'
import { z } from 'zod'
import { type Env, type ValidatedEnv } from '../../types/env'
import { getConfig } from '../config'
import {
	OrderRequestSchema,
	availableAccountDisplays,
	checkAndIncrementDailyCap,
	checkGuardrails,
	checkOrderApiKey,
	createOrderContext,
	jsonResponse,
	previewOne,
	resolveAccountHash,
} from '../orders/core'
import {
	LOGGER_CONTEXTS,
	PROPOSAL_EXPIRY_SECONDS,
	PROPOSAL_MAX_ORDERS,
} from '../shared/constants'
import { logger } from '../shared/log'
import { resolveMarketSession } from '../shared/marketSession'
import { buildProposalBlocks, slackApi } from '../shared/slack'
import { proposalStore } from './store'
import { type ProposalOrder, type ProposalRecord } from './types'

const proposalsLogger = logger.child(LOGGER_CONTEXTS.PROPOSALS)

const ProposalRequestSchema = z.object({
	summary: z.string().min(1).max(2000),
	accountNumber: z.string().optional(),
	orders: z.array(z.unknown()).min(1).max(PROPOSAL_MAX_ORDERS),
	allowDuplicate: z.boolean().optional(),
	/**
	 * Rehearse the batch without creating anything: validation, guardrails and
	 * the real Schwab preview all run, then the request returns before the
	 * proposal is stored or posted to Slack. Because nothing approvable is
	 * produced, a dry run is exempt from the regular-session guard — the point
	 * of that guard is a human approving a stale limit, and there is no message
	 * to approve.
	 */
	dryRun: z.boolean().optional(),
})

/** All secrets/bindings the drift-approval feature needs, or a reason it is disabled */
export function slackFeatureMissing(
	config: ValidatedEnv,
	env: Env,
): string | null {
	const missing: string[] = []
	if (!config.ORDER_API_KEY) missing.push('ORDER_API_KEY')
	if (!config.SCHWAB_USER_ID) missing.push('SCHWAB_USER_ID')
	if (!config.SLACK_BOT_TOKEN) missing.push('SLACK_BOT_TOKEN')
	if (!config.SLACK_SIGNING_SECRET) missing.push('SLACK_SIGNING_SECRET')
	if (!config.SLACK_CHANNEL_ID) missing.push('SLACK_CHANNEL_ID')
	if (!config.SLACK_APPROVER_IDS) missing.push('SLACK_APPROVER_IDS')
	if (!env.PROPOSAL_STORE) missing.push('PROPOSAL_STORE binding')
	return missing.length > 0 ? missing.join(', ') : null
}

/**
 * POST /proposals — create a drift-rebalance proposal awaiting Slack approval.
 *
 * Auth: `Authorization: Bearer <ORDER_API_KEY>` (same key as /orders).
 * Body: { summary, accountNumber?, orders: PlaceOrderParams[], allowDuplicate? }
 * Every order is validated, guardrail-checked, and previewed with Schwab
 * before anything is stored or posted to Slack — a proposal is only created
 * if the whole batch is clean. Execution happens later, via the Slack
 * Approve button, through the same code path as POST /orders.
 */
export async function handleProposalsRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'Method not allowed. Use POST.' })
	}

	const config = getConfig(env)
	const missing = slackFeatureMissing(config, env)
	if (missing) {
		return jsonResponse(503, {
			error: `Proposals endpoint disabled. Missing: ${missing}`,
		})
	}

	if (!(await checkOrderApiKey(request, config))) {
		proposalsLogger.warn('Proposals endpoint: rejected request with bad API key')
		return jsonResponse(401, { error: 'Unauthorized' })
	}

	let rawBody: unknown
	try {
		rawBody = await request.json()
	} catch {
		return jsonResponse(400, { error: 'Invalid JSON body' })
	}
	const parsedBody = ProposalRequestSchema.safeParse(rawBody)
	if (!parsedBody.success) {
		return jsonResponse(400, {
			error: 'Proposal failed validation',
			issues: parsedBody.error.issues.map((i) => ({
				path: i.path.join('.'),
				message: i.message,
			})),
		})
	}
	const {
		summary,
		accountNumber: defaultAccount,
		orders,
		allowDuplicate,
		dryRun,
	} = parsedBody.data

	// --- Validate every order and run pure guardrails before any I/O ---
	const validated: { orderBody: Record<string, unknown>; accountNumber: string }[] =
		[]
	const issues: { index: number; error: unknown }[] = []
	for (const [index, raw] of orders.entries()) {
		const parsed = OrderRequestSchema.safeParse(raw)
		if (!parsed.success) {
			issues.push({
				index,
				error: parsed.error.issues.map((i) => ({
					path: i.path.join('.'),
					message: i.message,
				})),
			})
			continue
		}
		const { accountNumber: perOrderAccount, ...orderBody } = parsed.data as any
		const accountNumber = perOrderAccount ?? defaultAccount
		if (!accountNumber) {
			issues.push({
				index,
				error:
					'No accountNumber on the order and no proposal-level accountNumber default',
			})
			continue
		}
		// Proposals are strictly LIMIT-style: a stale MARKET order approved hours
		// later is unbounded risk, so priceless orders are always refused here.
		const guard = checkGuardrails(config, orderBody, { requirePrice: true })
		if (!guard.ok) {
			issues.push({ index, error: guard.error })
			continue
		}
		validated.push({ orderBody, accountNumber })
	}
	if (issues.length > 0) {
		return jsonResponse(400, {
			error: 'One or more orders failed validation or guardrails; nothing stored.',
			issues,
		})
	}

	// --- Daily-cap sanity: the whole batch must fit today's remaining budget ---
	const cap = await checkAndIncrementDailyCap(
		config.OAUTH_KV,
		config.ORDER_DAILY_CAP,
		false,
	)
	const remaining = config.ORDER_DAILY_CAP - cap.count
	if (orders.length > remaining) {
		return jsonResponse(429, {
			error: `Batch of ${orders.length} orders exceeds remaining daily cap (${remaining} of ${config.ORDER_DAILY_CAP} left today)`,
		})
	}

	// --- Preview each order with Schwab; the batch must be clean to proceed ---
	const built = await createOrderContext(config)
	if (!built.ok) {
		return jsonResponse(built.status, { error: built.error })
	}
	const { ctx } = built

	// --- Session guard: LIMIT prices are only meaningful against a live
	// regular-session book. Outside it the bid/ask is the thin extended-hours
	// quote (or a stale closed one), so a limit derived from it can be far off
	// the market — and this endpoint posts to Slack for a human to approve,
	// where the price is no longer obviously stale. Enforced here rather than
	// left to the caller: /rebalance/snapshot only *reports* pricesTradable,
	// and a caller that ignores it must not be able to create a proposal.
	const { session, source } = await resolveMarketSession(ctx.client)
	if (session !== 'REGULAR' && !dryRun) {
		proposalsLogger.warn('Proposal rejected outside regular session', {
			session,
			source,
			orderCount: orders.length,
		})
		return jsonResponse(409, {
			error: `Market session is ${session}, not REGULAR — limit prices cannot be derived from the current book. Nothing was stored or posted to Slack.`,
			marketSession: session,
			sessionSource: source,
		})
	}

	const proposalOrders: ProposalOrder[] = []
	for (const [index, { orderBody, accountNumber }] of validated.entries()) {
		const accountHash = resolveAccountHash(ctx, accountNumber)
		if (!accountHash) {
			return jsonResponse(400, {
				error: `Order ${index}: accountNumber does not match any account (plain or hashValue) on this login`,
				availableAccounts: availableAccountDisplays(ctx),
			})
		}
		const preview = await previewOne(ctx, accountHash, orderBody)
		if ('error' in preview.schwabPreview) {
			return jsonResponse(502, {
				error: `Order ${index}: Schwab preview failed — ${preview.schwabPreview.error}`,
			})
		}
		if (preview.schwabPreview.status >= 400) {
			return jsonResponse(400, {
				error: `Order ${index}: Schwab rejected the preview (status ${preview.schwabPreview.status})`,
				schwabPreview: scrubAccountIdentifiers(
					preview.schwabPreview,
					ctx.displayMap,
				),
			})
		}
		if (preview.duplicateOpenOrder && !allowDuplicate) {
			return jsonResponse(409, {
				error: `Order ${index}: an identical open order already exists. Pass "allowDuplicate": true to override.`,
				duplicateOpenOrder: scrubAccountIdentifiers(
					preview.duplicateOpenOrder,
					ctx.displayMap,
				),
			})
		}
		const guard = checkGuardrails(config, orderBody, { requirePrice: true })
		proposalOrders.push({
			order: orderBody,
			accountNumber,
			orderHash: preview.orderHash,
			symbols: guard.ok ? guard.symbols : [],
			notional: guard.ok ? guard.notional : null,
			previewStatus: preview.schwabPreview.status,
		})
	}

	// --- Dry run: everything above actually ran (including the Schwab
	// preview); stop here so nothing is stored and nothing reaches Slack. ---
	if (dryRun) {
		proposalsLogger.info('Proposal dry run completed; nothing stored or posted', {
			orderCount: proposalOrders.length,
			session,
		})
		return jsonResponse(200, {
			dryRun: true,
			stored: false,
			slackPosted: false,
			marketSession: session,
			sessionSource: source,
			sessionGuardWouldBlock: session !== 'REGULAR',
			summary,
			orders: proposalOrders.map((o) => ({
				symbols: o.symbols,
				notional: o.notional,
				orderHash: o.orderHash,
				previewStatus: o.previewStatus,
			})),
		})
	}

	// --- Store (supersedes any prior pending proposal) and post to Slack ---
	const now = new Date()
	const proposal: ProposalRecord = {
		id: crypto.randomUUID(),
		status: 'pending',
		summary,
		orders: proposalOrders,
		allowDuplicate: allowDuplicate === true,
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + PROPOSAL_EXPIRY_SECONDS * 1000).toISOString(),
	}
	const store = proposalStore(env.PROPOSAL_STORE!)
	const created = await store.create(proposal)

	for (const old of created.superseded) {
		if (old.slack) {
			await slackApi(config.SLACK_BOT_TOKEN!, 'chat.update', {
				channel: old.slack.channel,
				ts: old.slack.ts,
				text: 'Superseded by a newer drift proposal.',
				blocks: [
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: '↪️ _Superseded by a newer drift proposal._',
						},
					},
				],
			})
		}
	}

	const posted = await slackApi(config.SLACK_BOT_TOKEN!, 'chat.postMessage', {
		channel: config.SLACK_CHANNEL_ID!,
		text: `Drift rebalance proposal: ${summary}`,
		blocks: buildProposalBlocks(proposal),
	})
	if (!posted.ok || !posted.ts || !posted.channel) {
		await store.delete(proposal.id)
		return jsonResponse(502, {
			error: `Slack post failed (${posted.error ?? 'unknown'}); proposal discarded.`,
		})
	}
	await store.update(proposal.id, {
		slack: { channel: posted.channel, ts: posted.ts },
	})

	proposalsLogger.info('Proposal created', {
		proposalId: proposal.id,
		orderCount: proposalOrders.length,
	})
	return jsonResponse(200, {
		proposalId: proposal.id,
		status: proposal.status,
		expiresAt: proposal.expiresAt,
		superseded: created.superseded.map((s) => s.id),
		orders: proposalOrders.map((o) => ({
			orderHash: o.orderHash,
			symbols: o.symbols,
			notional: o.notional,
			previewStatus: o.previewStatus,
		})),
	})
}

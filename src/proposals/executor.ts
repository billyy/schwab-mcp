import { type Env } from '../../types/env'
import { getConfig } from '../config'
import {
	checkGuardrails,
	createOrderContext,
	placeOne,
	previewOne,
	resolveAccountHash,
} from '../orders/core'
import {
	LOGGER_CONTEXTS,
	ORDER_AUDIT_TTL_SECONDS,
	PROPOSAL_AUDIT_KEY_PREFIX,
} from '../shared/constants'
import { logger } from '../shared/log'
import { buildClosedBlocks, buildOutcomeBlocks, slackApi } from '../shared/slack'
import { proposalStore } from './store'
import { type ProposalRecord, type ProposalStatus } from './types'

const executorLogger = logger.child(LOGGER_CONTEXTS.PROPOSALS)

/**
 * Execute an approved proposal — the LLM-free trade path. Runs in
 * ctx.waitUntil after the Slack interaction is acked. Each order goes through
 * the exact same guarded pipeline as POST /orders submit: guardrails →
 * fresh Schwab preview → duplicate guard → daily cap → place → audit log.
 * The ProposalStore record and KV audit entries are the source of truth;
 * Slack updates are best-effort and must never re-trigger placement.
 */
export async function executeProposal(
	env: Env,
	proposal: ProposalRecord,
	approvedBy: string,
): Promise<void> {
	const config = getConfig(env)
	const store = proposalStore(env.PROPOSAL_STORE!)
	const token = config.SLACK_BOT_TOKEN!

	const updateSlack = async (blocks: unknown[], text: string) => {
		if (!proposal.slack) return
		try {
			await slackApi(token, 'chat.update', {
				channel: proposal.slack.channel,
				ts: proposal.slack.ts,
				text,
				blocks,
			})
		} catch (error) {
			executorLogger.warn('Slack update failed (execution state is in the store)', {
				proposalId: proposal.id,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	const finalize = async (status: ProposalStatus, headline: string) => {
		proposal.status = status
		await store.update(proposal.id, { status, orders: proposal.orders })
		try {
			const auditKey = `${PROPOSAL_AUDIT_KEY_PREFIX}${new Date().toISOString()}:${proposal.id.slice(0, 8)}`
			await config.OAUTH_KV.put(auditKey, JSON.stringify(proposal), {
				expirationTtl: ORDER_AUDIT_TTL_SECONDS,
			})
		} catch (error) {
			executorLogger.error('Proposal audit write failed', {
				proposalId: proposal.id,
				error: error instanceof Error ? error.message : String(error),
			})
		}
		await updateSlack(buildOutcomeBlocks(proposal, headline), headline)
	}

	try {
		await updateSlack(
			buildClosedBlocks(
				proposal,
				`⏳ Executing ${proposal.orders.length} order(s)… approved by <@${approvedBy}>`,
			),
			'Executing proposal…',
		)

		const built = await createOrderContext(config)
		if (!built.ok) {
			executorLogger.error('Proposal execution: could not build Schwab client', {
				proposalId: proposal.id,
				error: built.error,
			})
			for (const po of proposal.orders) {
				po.result = { ok: false, stage: 'skipped', error: built.error }
			}
			await finalize('failed', `❌ Execution failed: ${built.error}`)
			return
		}
		const { ctx } = built

		let dailyCapHit = false
		for (const po of proposal.orders) {
			if (dailyCapHit) {
				po.result = { ok: false, stage: 'skipped', error: 'daily cap reached' }
				continue
			}
			const guard = checkGuardrails(config, po.order, { requirePrice: true })
			if (!guard.ok) {
				po.result = { ok: false, stage: 'guardrail', error: guard.error }
				continue
			}
			const accountHash = resolveAccountHash(ctx, po.accountNumber)
			if (!accountHash) {
				po.result = {
					ok: false,
					stage: 'account',
					error: 'accountNumber no longer matches any account on this login',
				}
				continue
			}
			const preview = await previewOne(ctx, accountHash, po.order)
			if ('error' in preview.schwabPreview) {
				po.result = {
					ok: false,
					stage: 'preview',
					error: preview.schwabPreview.error,
				}
				continue
			}
			if (preview.schwabPreview.status >= 400) {
				po.result = {
					ok: false,
					stage: 'preview',
					error: `Schwab preview rejected (status ${preview.schwabPreview.status})`,
				}
				continue
			}
			const placed = await placeOne(ctx, accountHash, po.order, {
				allowDuplicate: proposal.allowDuplicate,
			})
			po.result = placed
			if (!placed.ok && placed.stage === 'dailyCap') {
				dailyCapHit = true
				po.result = { ok: false, stage: 'skipped', error: 'daily cap reached' }
			}
		}

		const okCount = proposal.orders.filter((o) => o.result?.ok).length
		const total = proposal.orders.length
		const status: ProposalStatus =
			okCount === total ? 'executed' : okCount > 0 ? 'partial' : 'failed'
		const emoji = status === 'executed' ? '✅' : status === 'partial' ? '⚠️' : '❌'
		await finalize(
			status,
			`${emoji} Executed ${okCount}/${total} — approved by <@${approvedBy}>`,
		)
		executorLogger.info('Proposal execution finished', {
			proposalId: proposal.id,
			status,
			okCount,
			total,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		executorLogger.error('Proposal execution threw', {
			proposalId: proposal.id,
			error: message,
		})
		for (const po of proposal.orders) {
			if (!po.result) {
				po.result = { ok: false, stage: 'skipped', error: `executor error: ${message}` }
			}
		}
		await finalize('failed', `❌ Execution error: ${message}`)
	}
}

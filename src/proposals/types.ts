import { type PlaceOutcome } from '../orders/core'

export type ProposalStatus =
	| 'pending'
	| 'executing'
	| 'executed'
	| 'partial'
	| 'failed'
	| 'rejected'
	| 'expired'
	| 'superseded'

export interface ProposalOrder {
	/** Validated order body (PlaceOrderParams shape, accountNumber stripped) */
	order: Record<string, unknown>
	/** Requested account (plain number or hashValue) — re-resolved at execution */
	accountNumber: string
	/** Hash from the proposal-time preview (informational; re-hashed at execution) */
	orderHash: string
	symbols: string[]
	notional: number | null
	/** Schwab preview HTTP status at proposal time (null if the call errored) */
	previewStatus: number | null
	/** Execution result, filled in by the executor */
	result?: PlaceOutcome | { ok: false; stage: 'skipped' | 'guardrail' | 'account' | 'preview'; error: string }
}

export interface ProposalRecord {
	id: string
	status: ProposalStatus
	/** Drift delta summary written by the Cowork task, shown in Slack */
	summary: string
	orders: ProposalOrder[]
	allowDuplicate: boolean
	createdAt: string
	expiresAt: string
	slack?: { channel: string; ts: string }
	decidedBy?: string
	decidedAt?: string
}

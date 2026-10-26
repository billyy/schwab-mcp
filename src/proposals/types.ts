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
	/**
	 * Whether the covered-call check actually inspected positions at proposal
	 * time. False means it was not applicable (nothing here can reduce
	 * coverage), never that it was skipped — a failed check rejects the batch.
	 * Re-run at execution regardless.
	 */
	coverageChecked: boolean
	/** Execution result, filled in by the executor */
	result?:
		| PlaceOutcome
		| {
				ok: false
				stage: 'skipped' | 'guardrail' | 'account' | 'preview' | 'coverage'
				error: string
		  }
}

/**
 * `drift` — the scheduled CRT→Partnership batch. A new one supersedes the
 * previous pending drift proposal, since only the latest prices are valid.
 * `manual` — a one-off order someone asked to have approved. Each stands on
 * its own: it never supersedes anything and is never superseded, so an ad-hoc
 * request cannot kill the drift proposal's buttons or vice versa.
 */
export type ProposalKind = 'drift' | 'manual'

export interface ProposalRecord {
	id: string
	/** Absent on records stored before kinds existed — those are all drift */
	kind?: ProposalKind
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

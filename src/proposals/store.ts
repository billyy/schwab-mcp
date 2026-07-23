import {
	LOGGER_CONTEXTS,
	PROPOSAL_EXECUTING_TIMEOUT_MS,
	PROPOSAL_RETENTION_MS,
} from '../shared/constants'
import { logger } from '../shared/log'
import { type ProposalRecord } from './types'

const storeLogger = logger.child(LOGGER_CONTEXTS.PROPOSALS)

const KEY_PREFIX = 'p:'
const PURGE_ALARM_INTERVAL_MS = 24 * 60 * 60 * 1000

interface StoredProposal extends ProposalRecord {
	/** Set when the record enters `executing`, for stale-execution detection */
	executingSince?: string
}

export type ClaimResult =
	| { ok: true; proposal: StoredProposal }
	| {
			ok: false
			reason: 'not_found' | 'expired' | `already_${string}`
			proposal?: StoredProposal
	  }

/**
 * Durable Object holding pending drift proposals.
 *
 * A DO (single named instance) instead of KV because: (1) KV is eventually
 * consistent across colos, and the Cowork POST and Slack's interaction
 * callback land on different colos — a fast Approve could miss the record;
 * (2) the DO's single-threaded execution makes `claim` (pending → executing)
 * atomic, so a double-click can never execute a proposal twice.
 */
export class ProposalStore {
	private storage: DurableObjectStorage

	constructor(state: DurableObjectState) {
		this.storage = state.storage
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		const body = (await request.json().catch(() => ({}))) as any
		switch (url.pathname) {
			case '/create':
				return json(await this.create(body as StoredProposal))
			case '/get':
				return json({ proposal: (await this.load(body.id)) ?? null })
			case '/claim':
				return json(await this.claim(body.id, body.userId))
			case '/reject':
				return json(await this.reject(body.id, body.userId))
			case '/update':
				return json(await this.update(body.id, body.patch))
			case '/delete':
				await this.storage.delete(KEY_PREFIX + body.id)
				return json({ ok: true })
			default:
				return json({ error: 'unknown path' }, 404)
		}
	}

	private async load(id: string): Promise<StoredProposal | undefined> {
		return this.storage.get<StoredProposal>(KEY_PREFIX + id)
	}

	private async save(p: StoredProposal): Promise<void> {
		await this.storage.put(KEY_PREFIX + p.id, p)
	}

	/** Store a new pending proposal, superseding any prior pending one */
	private async create(
		p: StoredProposal,
	): Promise<{ ok: true; superseded: { id: string; slack?: StoredProposal['slack'] }[] }> {
		const superseded: { id: string; slack?: StoredProposal['slack'] }[] = []
		const all = await this.storage.list<StoredProposal>({ prefix: KEY_PREFIX })
		for (const existing of all.values()) {
			if (existing.status === 'pending') {
				existing.status = 'superseded'
				await this.save(existing)
				superseded.push({ id: existing.id, slack: existing.slack })
			}
		}
		await this.save(p)
		if ((await this.storage.getAlarm()) === null) {
			await this.storage.setAlarm(Date.now() + PURGE_ALARM_INTERVAL_MS)
		}
		return { ok: true, superseded }
	}

	/** Atomic pending → executing transition (single-threaded per DO) */
	private async claim(id: string, userId: string): Promise<ClaimResult> {
		const p = await this.load(id)
		if (!p) return { ok: false, reason: 'not_found' }

		// A waitUntil-evicted execution must not wedge the proposal forever
		if (
			p.status === 'executing' &&
			p.executingSince &&
			Date.now() - new Date(p.executingSince).getTime() >
				PROPOSAL_EXECUTING_TIMEOUT_MS
		) {
			p.status = 'failed'
			await this.save(p)
			return { ok: false, reason: 'already_failed', proposal: p }
		}

		if (p.status !== 'pending') {
			return { ok: false, reason: `already_${p.status}`, proposal: p }
		}
		if (new Date(p.expiresAt).getTime() < Date.now()) {
			p.status = 'expired'
			await this.save(p)
			return { ok: false, reason: 'expired', proposal: p }
		}

		p.status = 'executing'
		p.executingSince = new Date().toISOString()
		p.decidedBy = userId
		p.decidedAt = new Date().toISOString()
		await this.save(p)
		return { ok: true, proposal: p }
	}

	private async reject(id: string, userId: string): Promise<ClaimResult> {
		const p = await this.load(id)
		if (!p) return { ok: false, reason: 'not_found' }
		if (p.status !== 'pending') {
			return { ok: false, reason: `already_${p.status}`, proposal: p }
		}
		p.status = 'rejected'
		p.decidedBy = userId
		p.decidedAt = new Date().toISOString()
		await this.save(p)
		return { ok: true, proposal: p }
	}

	private async update(
		id: string,
		patch: Partial<StoredProposal>,
	): Promise<{ ok: boolean }> {
		const p = await this.load(id)
		if (!p) return { ok: false }
		Object.assign(p, patch)
		await this.save(p)
		return { ok: true }
	}

	/** Purge records past retention; re-arm while any remain */
	async alarm(): Promise<void> {
		const all = await this.storage.list<StoredProposal>({ prefix: KEY_PREFIX })
		let remaining = 0
		for (const [key, p] of all) {
			if (Date.now() - new Date(p.createdAt).getTime() > PROPOSAL_RETENTION_MS) {
				await this.storage.delete(key)
			} else {
				remaining++
			}
		}
		if (remaining > 0) {
			await this.storage.setAlarm(Date.now() + PURGE_ALARM_INTERVAL_MS)
		}
		storeLogger.debug('ProposalStore purge alarm ran', { remaining })
	}
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

/** Typed client for the singleton ProposalStore instance */
export function proposalStore(ns: DurableObjectNamespace) {
	const stub = ns.get(ns.idFromName('singleton'))
	const call = async <T>(path: string, body: unknown): Promise<T> => {
		const res = await stub.fetch(`https://proposal-store${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		return res.json() as Promise<T>
	}
	return {
		create: (proposal: ProposalRecord) =>
			call<{ ok: true; superseded: { id: string; slack?: ProposalRecord['slack'] }[] }>(
				'/create',
				proposal,
			),
		get: (id: string) =>
			call<{ proposal: ProposalRecord | null }>('/get', { id }),
		claim: (id: string, userId: string) =>
			call<ClaimResult>('/claim', { id, userId }),
		reject: (id: string, userId: string) =>
			call<ClaimResult>('/reject', { id, userId }),
		update: (id: string, patch: Partial<ProposalRecord>) =>
			call<{ ok: boolean }>('/update', { id, patch }),
		delete: (id: string) => call<{ ok: boolean }>('/delete', { id }),
	}
}

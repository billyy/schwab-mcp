import {
	KVTokenStore as SDKKVTokenStore,
	type TokenIdentifiers,
	type KVNamespace,
} from '@sudowealth/schwab-api'
import {
	TOKEN_KEY_PREFIX,
	TOKEN_TIMESTAMP_KEY_PREFIX,
	TTL_31_DAYS,
	REFRESH_TOKEN_TTL_MS,
} from './constants'
import { logger } from './log'

// Create a type that matches the existing interface
export interface KvTokenStore<T = any> {
	load(ids: TokenIdentifiers): Promise<T | null>
	save(ids: TokenIdentifiers, data: T): Promise<void>
	kvKey(ids: TokenIdentifiers): string
	migrate(fromIds: TokenIdentifiers, toIds: TokenIdentifiers): Promise<boolean>
	migrateIfNeeded(
		fromIds: TokenIdentifiers,
		toIds: TokenIdentifiers,
	): Promise<void>
	/**
	 * Record when this token was minted. Pass `ts` to inherit an existing mint
	 * time (see loadFreshestEntry) instead of restarting the 7-day clock.
	 */
	saveTimestamp(ids: TokenIdentifiers, ts?: number): Promise<void>
	/** Mint time of the token at `ids`, or null if it has never been stamped. */
	getTimestamp(ids: TokenIdentifiers): Promise<number | null>
	isTokenStale(ids: TokenIdentifiers): Promise<boolean>
	clearToken(ids: TokenIdentifiers): Promise<void>
	/**
	 * Load the most recently written non-stale token regardless of its key.
	 * Needed because Schwab rotates schwabUserId (schwabClientCorrelId) on
	 * every re-auth, so the refresh automation writes a NEW token:<id> key
	 * each run while existing sessions still look up their old key.
	 */
	loadFreshest(): Promise<T | null>
	/**
	 * loadFreshest() plus the mint time and key it came from. Callers need the
	 * timestamp to decide whether KV holds anything NEWER than their own copy —
	 * the only reliable way to notice that a full re-auth has revoked the
	 * refresh token they are holding. See loadTokenForETM() in src/index.ts.
	 */
	loadFreshestEntry(): Promise<FreshestEntry<T> | null>
}

export interface FreshestEntry<T> {
	data: T
	/** Epoch ms the token was written, from its `token_ts:` companion key. */
	ts: number
	key: string
}

/**
 * Creates a KV-backed token store using the SDK implementation
 * This maintains backward compatibility with the existing interface
 */
export function makeKvTokenStore<T = any>(kv: KVNamespace): KvTokenStore<T> {
	const sdkStore = new SDKKVTokenStore(kv, {
		keyPrefix: TOKEN_KEY_PREFIX,
		ttl: TTL_31_DAYS,
		autoMigrate: true,
	})

	return {
		load: async (ids: TokenIdentifiers) => {
			const result = await sdkStore.load(ids)
			return result as T | null
		},
		save: async (ids: TokenIdentifiers, data: T) => {
			await sdkStore.save(ids, data as any)
		},
		kvKey: (ids: TokenIdentifiers) => {
			return sdkStore.generateKey(ids)
		},
		migrate: async (fromIds: TokenIdentifiers, toIds: TokenIdentifiers) => {
			return sdkStore.migrate(fromIds, toIds)
		},
		migrateIfNeeded: async (
			fromIds: TokenIdentifiers,
			toIds: TokenIdentifiers,
		) => {
			const sourceExists = await sdkStore.load(fromIds)
			if (!sourceExists) return
			const success = await sdkStore.migrate(fromIds, toIds)
			if (!success) {
				logger.warn('Token migration failed', {
					from: sdkStore.generateKey(fromIds),
					to: sdkStore.generateKey(toIds),
				})
			}
		},
		saveTimestamp: async (ids: TokenIdentifiers, ts?: number) => {
			const tsKey = `${TOKEN_TIMESTAMP_KEY_PREFIX}${sdkStore.generateKey(ids)}`
			await kv.put(tsKey, String(ts ?? Date.now()), {
				expirationTtl: TTL_31_DAYS,
			})
		},
		getTimestamp: async (ids: TokenIdentifiers) => {
			const tsKey = `${TOKEN_TIMESTAMP_KEY_PREFIX}${sdkStore.generateKey(ids)}`
			const storedAt = Number(await kv.get(tsKey))
			return Number.isFinite(storedAt) && storedAt > 0 ? storedAt : null
		},
		isTokenStale: async (ids: TokenIdentifiers) => {
			const tsKey = `${TOKEN_TIMESTAMP_KEY_PREFIX}${sdkStore.generateKey(ids)}`
			const storedAt = await kv.get(tsKey)
			if (!storedAt) {
				return true
			}
			const age = Date.now() - Number(storedAt)
			return age > REFRESH_TOKEN_TTL_MS
		},
		clearToken: async (ids: TokenIdentifiers) => {
			const tokenKey = sdkStore.generateKey(ids)
			const tsKey = `${TOKEN_TIMESTAMP_KEY_PREFIX}${tokenKey}`
			await Promise.all([kv.delete(tokenKey), kv.delete(tsKey)])
			logger.info('Cleared stale token and timestamp from KV', {
				tokenKey,
			})
		},
		loadFreshest: async () => (await loadFreshestEntry())?.data ?? null,
		loadFreshestEntry,
	}

	async function loadFreshestEntry(): Promise<FreshestEntry<T> | null> {
		// 'token_ts:' does not share the 'token:' prefix, so this lists tokens only
		const list = await (kv as any).list({ prefix: TOKEN_KEY_PREFIX })
		const entries: { name: string }[] = list.keys ?? []
		// Fetched in parallel: this runs on every token load (not just on a miss),
		// and each refresh run adds another token: key, so serial gets would put
		// dozens of round-trips in front of every Schwab call.
		const stamps = await Promise.all(
			entries.map(async (entry) => ({
				key: entry.name,
				ts: Number(await kv.get(`${TOKEN_TIMESTAMP_KEY_PREFIX}${entry.name}`)),
			})),
		)
		let best: { key: string; ts: number } | null = null
		for (const { key, ts } of stamps) {
			if (!Number.isFinite(ts) || ts <= 0) continue
			if (!best || ts > best.ts) best = { key, ts }
		}
		if (!best) return null
		if (Date.now() - best.ts > REFRESH_TOKEN_TTL_MS) {
			logger.warn('Freshest KV token is stale (>7 days)', { key: best.key })
			return null
		}
		const raw = await kv.get(best.key)
		if (!raw) return null
		logger.info('Loaded freshest KV token as fallback', {
			key: best.key,
			ageMinutes: Math.round((Date.now() - best.ts) / 60000),
		})
		try {
			return { data: JSON.parse(raw) as T, ts: best.ts, key: best.key }
		} catch {
			return null
		}
	}
}

// Re-export the type for backward compatibility
export type { TokenIdentifiers }

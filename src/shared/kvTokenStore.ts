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
	saveTimestamp(ids: TokenIdentifiers): Promise<void>
	isTokenStale(ids: TokenIdentifiers): Promise<boolean>
	clearToken(ids: TokenIdentifiers): Promise<void>
	/**
	 * Load the most recently written non-stale token regardless of its key.
	 * Needed because Schwab rotates schwabUserId (schwabClientCorrelId) on
	 * every re-auth, so the refresh automation writes a NEW token:<id> key
	 * each run while existing sessions still look up their old key.
	 */
	loadFreshest(): Promise<T | null>
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
		saveTimestamp: async (ids: TokenIdentifiers) => {
			const tsKey = `${TOKEN_TIMESTAMP_KEY_PREFIX}${sdkStore.generateKey(ids)}`
			await kv.put(tsKey, String(Date.now()), {
				expirationTtl: TTL_31_DAYS,
			})
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
		loadFreshest: async () => {
			// 'token_ts:' does not share the 'token:' prefix, so this lists tokens only
			const list = await (kv as any).list({ prefix: TOKEN_KEY_PREFIX })
			let best: { key: string; ts: number } | null = null
			for (const entry of list.keys ?? []) {
				const ts = Number(
					await kv.get(`${TOKEN_TIMESTAMP_KEY_PREFIX}${entry.name}`),
				)
				if (!Number.isFinite(ts) || ts <= 0) continue
				if (!best || ts > best.ts) best = { key: entry.name, ts }
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
				return JSON.parse(raw) as T
			} catch {
				return null
			}
		},
	}
}

// Re-export the type for backward compatibility
export type { TokenIdentifiers }

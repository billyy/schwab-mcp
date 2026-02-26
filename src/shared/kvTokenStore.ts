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
			const success = await sdkStore.migrate(fromIds, toIds)
			if (!success) {
				logger.warn('Token migration was not needed or failed', {
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
	}
}

// Re-export the type for backward compatibility
export type { TokenIdentifiers }

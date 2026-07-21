import {
	buildAccountDisplayMap,
	scrubAccountIdentifiers,
	GetAccountByNumberParams,
	GetAccountNumbersParams,
	GetOrdersParams,
	GetAccountsParams,
	GetOrdersByAccountParams,
	PlaceOrderParams,
	GetOrderByIdParams,
	CancelOrderParams,
	ReplaceOrderParams,
	GetTransactionsParams,
	GetTransactionByIdParams,
	GetUserPreferenceParams,
	type SchwabApiClient,
} from '@sudowealth/schwab-api'
import { logger } from '../../shared/log'
import { withOrderAliases } from '../../shared/orderAliases'
import { createToolSpec } from '../types'

/**
 * Resolve a caller-supplied account identifier to the CURRENT hashValue.
 * Accepts a current hashValue, a plain account number, or a display name.
 *
 * Account hashValues rotate whenever the OAuth session is re-established
 * (e.g. the twice-weekly automation refresh), so identifiers cached by a
 * caller mid-conversation go stale. Re-resolving on every call makes all
 * account-scoped tools immune; when nothing matches, the error tells the
 * caller how to recover.
 */
async function resolveAccountHash(
	c: SchwabApiClient,
	input: string,
): Promise<string> {
	const accounts = await c.trader.accounts.getAccountNumbers()
	const byHash = accounts.find((a) => a.hashValue === input)
	if (byHash) return byHash.hashValue
	const byPlain = accounts.find((a) => a.accountNumber === input)
	if (byPlain) return byPlain.hashValue
	const displayMap = await buildAccountDisplayMap(c)
	const byDisplay = accounts.find(
		(a) => displayMap[a.accountNumber] === input,
	)
	if (byDisplay) return byDisplay.hashValue
	throw new Error(
		'Account identifier not recognized — account hashValues rotate on every re-authentication, so cached values go stale. Call getAccounts to get the current hashValues, then retry with the new value.',
	)
}

export const toolSpecs = [
	createToolSpec({
		name: 'getAccounts',
		description:
			'List all accounts with summary info. Returns account display name, type, hashValue (use with getAccount for details), and current balances. Does not include positions — use getAccount with a specific hashValue for full details.',
		schema: GetAccountsParams,
		call: async (c, p) => {
			logger.info('[getAccounts] Fetching accounts', {
				showPositions: p?.fields,
			})
			const [accounts, accountNumbers] = await Promise.all([
				c.trader.accounts.getAccounts({
					queryParams: { fields: p?.fields },
				}),
				c.trader.accounts.getAccountNumbers(),
			])
			const hashByNumber = Object.fromEntries(
				accountNumbers.map((a) => [a.accountNumber, a.hashValue]),
			)
			const displayMap = await buildAccountDisplayMap(c)
			return accounts.map((acc) => {
				const sa = acc.securitiesAccount
				const display = displayMap[sa.accountNumber] ?? sa.accountNumber
				const hashValue = hashByNumber[sa.accountNumber]
				return {
					accountDisplay: display,
					hashValue,
					type: sa.type,
					currentBalances: sa.currentBalances,
				}
			})
		},
	}),
	createToolSpec({
		name: 'getAccountNumbers',
		description: 'Get account numbers',
		schema: GetAccountNumbersParams,
		call: async (c, p) => {
			logger.info('[getAccountNumbers] Fetching account numbers')
			const accounts = await c.trader.accounts.getAccountNumbers(p)
			const displayMap = await buildAccountDisplayMap(c)
			return accounts.map((acc) => {
				return {
					accountDisplay: displayMap[acc.accountNumber],
					hashValue: acc.hashValue,
				}
			})
		},
	}),
	createToolSpec({
		name: 'getAccount',
		description: 'Get account',
		schema: GetAccountByNumberParams,
		call: async (c, p) => {
			const account = await c.trader.accounts.getAccountByNumber({
				pathParams: { accountNumber: await resolveAccountHash(c, p.accountNumber) },
				queryParams: { fields: p.fields },
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(account, displayMap)
		},
	}),
	createToolSpec({
		name: 'getOrders',
		description: 'Get orders',
		schema: GetOrdersParams,
		call: async (c, p) => {
			logger.info('[getOrders] Fetching orders', {
				maxResults: p.maxResults,
				hasDateFilter: !!p.fromEnteredTime || !!p.toEnteredTime,
			})
			const orders = await c.trader.orders.getOrders({ queryParams: p })
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(orders, displayMap)
		},
	}),
	createToolSpec({
		name: 'getOrdersByAccountNumber',
		description: 'Get orders by account number',
		schema: GetOrdersByAccountParams,
		call: async (c, p) => {
			const orders = await c.trader.orders.getOrdersByAccount({
				pathParams: { accountNumber: await resolveAccountHash(c, p.accountNumber) },
				queryParams: p,
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(orders, displayMap)
		},
	}),
	createToolSpec({
		name: 'placeOrder',
		description:
			'Place order for a specific account. Accepts abbreviations: GTC, LMT, MKT, STP, STP_LMT, BTO, BTC, STO, STC.',
		schema: withOrderAliases(PlaceOrderParams) as typeof PlaceOrderParams,
		call: async (c, p) => {
			logger.info('[placeOrder] Placing order', {
				accountNumber: p.accountNumber ? '***' + p.accountNumber.slice(-4) : 'missing',
				orderType: p.orderType,
				session: p.session,
				duration: p.duration,
				orderStrategyType: p.orderStrategyType,
				orderLegCount: p.orderLegCollection?.length,
			})
			const { accountNumber, ...orderBody } = p
			logger.debug('[placeOrder] Full order body', { body: JSON.stringify(orderBody) })
			try {
				const order = await c.trader.orders.placeOrderForAccount({
					pathParams: { accountNumber: await resolveAccountHash(c, accountNumber) },
					body: orderBody as typeof p,
				})
				logger.info('[placeOrder] Order placed successfully', { order })
				const displayMap = await buildAccountDisplayMap(c)
				return scrubAccountIdentifiers(order, displayMap)
			} catch (error: any) {
				logger.error('[placeOrder] Order failed', {
					message: error.message,
					status: error.status,
					code: error.code,
					body: error.body,
					metadata: error.metadata,
					stack: error.stack,
				})
				throw error
			}
		},
	}),
	createToolSpec({
		name: 'getOrder',
		description: 'Get order by order id for a specific account',
		schema: GetOrderByIdParams,
		call: async (c, p) => {
			const order = await c.trader.orders.getOrderByOrderId({
				pathParams: {
					accountNumber: await resolveAccountHash(c, p.accountNumber),
					orderId: p.orderId,
				},
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(order, displayMap)
		},
	}),
	createToolSpec({
		name: 'cancelOrder',
		description: 'Cancel order by order id for a specific account',
		schema: CancelOrderParams,
		call: async (c, p) => {
			const order = await c.trader.orders.cancelOrder({
				pathParams: {
					accountNumber: await resolveAccountHash(c, p.accountNumber),
					orderId: p.orderId,
				},
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(order, displayMap)
		},
	}),
	createToolSpec({
		name: 'replaceOrder',
		description:
			'Replace order by order id for a specific account. Accepts abbreviations: GTC, LMT, MKT, STP, STP_LMT, BTO, BTC, STO, STC.',
		schema: withOrderAliases(ReplaceOrderParams) as typeof ReplaceOrderParams,
		call: async (c, p) => {
			const { accountNumber, orderId, ...orderBody } = p
			const order = await c.trader.orders.replaceOrder({
				pathParams: {
					accountNumber: await resolveAccountHash(c, accountNumber),
					orderId,
				},
				body: orderBody as typeof p,
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(order, displayMap)
		},
	}),
	createToolSpec({
		name: 'getTransactions',
		description: 'Get transactions',
		schema: GetTransactionsParams,
		call: async (c, p) => {
			logger.info('[getTransactions] Fetching accounts')
			const accounts = await c.trader.accounts.getAccountNumbers()
			if (accounts.length === 0) return []
			logger.info('[getTransactions] Fetching transactions', {
				accountCount: accounts.length,
				startDate: p.startDate,
				endDate: p.endDate,
				hasType: !!p.types,
				symbol: p.symbol,
			})
			const transactions: unknown[] = []
			for (const account of accounts) {
				const accountTransactions = await c.trader.transactions.getTransactions(
					{
						pathParams: { accountNumber: account.hashValue },
						queryParams: {
							startDate: p.startDate,
							endDate: p.endDate,
							types: p.types,
							symbol: p.symbol,
						},
					},
				)
				logger.debug('[getTransactions] Transactions for account', {
					accountHash: account.hashValue,
					count: accountTransactions.length,
				})
				transactions.push(...accountTransactions)
			}
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(transactions, displayMap)
		},
	}),
	createToolSpec({
		name: 'getTransaction',
		description: 'Get transaction',
		schema: GetTransactionByIdParams,
		call: async (c, p) => {
			logger.info('[getTransaction] Fetching transaction', {
				transactionId: p.transactionId,
			})
		},
	}),
	createToolSpec({
		name: 'getUserPreference',
		description: 'Get user preference',
		schema: GetUserPreferenceParams,
		call: async (c, p) => {
			logger.info('[getUserPreference] Fetching user preference')
			const userPreference = await c.trader.userPreference.getUserPreference(p)
			if (userPreference.streamerInfo.length === 0) {
				return []
			}
			logger.info('[getUserPreference] User preference fetched', {
				hasAccounts: userPreference.accounts?.length > 0,
				accountCount: userPreference.accounts?.length || 0,
				hasStreamerInfo: userPreference.streamerInfo?.length > 0,
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(userPreference, displayMap)
		},
	}),
] as const

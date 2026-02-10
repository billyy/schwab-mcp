import {
	GetInstrumentByCusipParams,
	GetInstrumentsParams,
	GetMarketHoursByMarketIdParams,
	GetMarketHoursParams,
	GetMoversParams,
	GetOptionChainParams,
	GetOptionExpirationChainParams,
	GetPriceHistoryParams,
	GetQuoteBySymbolIdParams,
	GetQuotesParams,
} from '@sudowealth/schwab-api'
import { logger } from '../../shared/log'
import { createToolSpec } from '../types'

/** Strip option chain responses to essential trading fields to stay under MCP size limits. */
function slimOptionChain(data: Record<string, unknown>) {
	const essentialContractFields = [
		'symbol',
		'putCall',
		'strikePrice',
		'expirationDate',
		'daysToExpiration',
		'bidPrice',
		'askPrice',
		'lastPrice',
		'markPrice',
		'totalVolume',
		'openInterest',
		'delta',
		'gamma',
		'theta',
		'vega',
		'volatility',
		'intrinsicValue',
		'timeValue',
		'isInTheMoney',
	] as const

	function slimContract(contract: Record<string, unknown>) {
		const slim: Record<string, unknown> = {}
		for (const key of essentialContractFields) {
			if (contract[key] !== undefined) {
				slim[key] = contract[key]
			}
		}
		return slim
	}

	function slimExpDateMap(
		expDateMap: Record<string, Record<string, unknown[]>> | undefined,
	) {
		if (!expDateMap) return undefined
		const result: Record<string, Record<string, unknown[]>> = {}
		for (const [expDate, strikes] of Object.entries(expDateMap)) {
			result[expDate] = {}
			for (const [strike, contracts] of Object.entries(
				strikes as Record<string, unknown[]>,
			)) {
				result[expDate][strike] = (contracts || []).map((c) =>
					slimContract(c as Record<string, unknown>),
				)
			}
		}
		return result
	}

	return {
		symbol: data.symbol,
		status: data.status,
		isDelayed: data.isDelayed,
		isIndex: data.isIndex,
		underlyingPrice: data.underlyingPrice,
		volatility: data.volatility,
		underlying: data.underlying,
		callExpDateMap: slimExpDateMap(
			data.callExpDateMap as
				| Record<string, Record<string, unknown[]>>
				| undefined,
		),
		putExpDateMap: slimExpDateMap(
			data.putExpDateMap as
				| Record<string, Record<string, unknown[]>>
				| undefined,
		),
	}
}

export const toolSpecs = [
	createToolSpec({
		name: 'getQuotes',
		description: 'Get quotes for a list of symbols',
		schema: GetQuotesParams,
		call: async (c, p) => {
			logger.info('[getQuotes] Fetching quotes', {
				symbols: p.symbols,
				fields: p.fields,
			})
			return c.marketData.quotes.getQuotes({
				queryParams: {
					symbols: p.symbols,
					fields: p.fields,
					indicative: p.indicative,
				},
			})
		},
	}),
	createToolSpec({
		name: 'getQuoteBySymbolId',
		description: 'Get quote for a one symbol',
		schema: GetQuoteBySymbolIdParams,
		call: async (c, p) => {
			logger.info('[getQuoteBySymbolId] Fetching quote', {
				symbol_id: p.symbol_id,
				fields: p.fields,
			})
			const quoteData = await c.marketData.quotes.getQuoteBySymbolId({
				pathParams: { symbol_id: p.symbol_id },
				queryParams: { fields: p.fields },
			})
			return quoteData
		},
	}),
	createToolSpec({
		name: 'searchInstruments',
		description: 'Search for instruments by symbols and projections',
		schema: GetInstrumentsParams,
		call: (c, p) =>
			c.marketData.instruments.getInstruments({
				queryParams: p,
			}),
	}),
	createToolSpec({
		name: 'getInstrumentByCusip',
		description: 'Get instrument by cusip',
		schema: GetInstrumentByCusipParams,
		call: async (c, p) => {
			const instrument = await c.marketData.instruments.getInstrumentByCusip({
				pathParams: { cusip_id: p.cusip_id },
			})
			return instrument
		},
	}),
	createToolSpec({
		name: 'getMarketHours',
		description: 'Get market hours for different markets',
		schema: GetMarketHoursParams,
		call: (c, p) =>
			c.marketData.marketHours.getMarketHours({
				queryParams: {
					markets: p.markets,
					date: p.date ? new Date(p.date).toISOString() : undefined,
				},
			}),
	}),
	createToolSpec({
		name: 'getMarketHoursByMarketId',
		description: 'Get market hours for a specific market',
		schema: GetMarketHoursByMarketIdParams,
		call: (c, p) =>
			c.marketData.marketHours.getMarketHoursByMarketId({
				pathParams: { market_id: p.market_id },
				queryParams: { date: p.date },
			}),
	}),
	createToolSpec({
		name: 'getMovers',
		description: 'Get movers for a specific index',
		schema: GetMoversParams,
		call: (c, p) =>
			c.marketData.movers.getMovers({
				pathParams: { symbol_id: p.symbol_id },
				queryParams: { sort: p.sort, frequency: p.frequency },
			}),
	}),
	createToolSpec({
		name: 'getOptionChain',
		description:
			'Get option chain for an optionable symbol. Use strikeCount, contractType, range, fromDate/toDate, and daysToExpiration to narrow results. Response is trimmed to essential trading fields.',
		schema: GetOptionChainParams,
		call: async (c, p) => {
			const data = await c.marketData.options.getOptionChain({
				queryParams: {
					symbol: p.symbol,
					contractType: p.contractType,
					strikeCount: p.strikeCount,
					strike: p.strike,
					range: p.range,
					fromDate: p.fromDate,
					toDate: p.toDate,
					daysToExpiration: p.daysToExpiration,
					expMonth: p.expMonth,
					strategy: p.strategy,
					volatility: p.volatility,
					underlyingPrice: p.underlyingPrice,
					interestRate: p.interestRate,
					interval: p.interval,
					optionType: p.optionType,
					entitlement: p.entitlement,
					includeUnderlyingQuote: p.includeUnderlyingQuote,
				},
			})
			return slimOptionChain(data)
		},
	}),
	createToolSpec({
		name: 'getOptionExpirationChain',
		description: 'Get option expiration chain for an optionable symbol',
		schema: GetOptionExpirationChainParams,
		call: (c, p) =>
			c.marketData.options.getOptionExpirationChain({
				queryParams: { symbol: p.symbol },
			}),
	}),
	createToolSpec({
		name: 'getPriceHistory',
		description: 'Get price history for a specific symbol and date range',
		schema: GetPriceHistoryParams,
		call: async (c, p) => {
			logger.info('[getPriceHistory] Fetching price history', {
				symbol: p.symbol,
				periodType: p.periodType,
				period: p.period,
				frequencyType: p.frequencyType,
				frequency: p.frequency,
				startDate: p.startDate,
				endDate: p.endDate,
			})
			try {
				const result = await c.marketData.priceHistory.getPriceHistory({
					queryParams: {
						symbol: p.symbol,
						period: p.period,
						periodType: p.periodType,
						frequency: p.frequency,
						frequencyType: p.frequencyType,
						startDate: p.startDate,
						endDate: p.endDate,
					},
				})
				logger.info('[getPriceHistory] Success', {
					symbol: result.symbol,
					candleCount: result.candles?.length,
					empty: result.empty,
				})
				return result
			} catch (error: any) {
				logger.error('[getPriceHistory] Failed', {
					message: error.message,
					status: error.status,
					code: error.code,
					body: error.body,
				})
				throw error
			}
		},
	}),
] as const

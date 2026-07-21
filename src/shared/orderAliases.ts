import { z } from 'zod'

/**
 * Common trading abbreviations that AI models tend to use.
 * Maps abbreviations → Schwab's full enum values.
 */
const DURATION_ALIASES: Record<string, string> = {
	GTC: 'GOOD_TILL_CANCEL',
	FOK: 'FILL_OR_KILL',
	IOC: 'IMMEDIATE_OR_CANCEL',
}

const ORDER_TYPE_ALIASES: Record<string, string> = {
	MKT: 'MARKET',
	LMT: 'LIMIT',
	STP: 'STOP',
	STP_LMT: 'STOP_LIMIT',
}

const INSTRUCTION_ALIASES: Record<string, string> = {
	BTO: 'BUY_TO_OPEN',
	BTC: 'BUY_TO_CLOSE',
	STO: 'SELL_TO_OPEN',
	STC: 'SELL_TO_CLOSE',
}

/** Wrap a Zod type with preprocessing to accept common aliases */
function withAliases(zodType: z.ZodTypeAny, aliases: Record<string, string>) {
	return z.preprocess(
		(val) => (typeof val === 'string' && aliases[val] ? aliases[val] : val),
		zodType,
	)
}

/** Coerce string to number if needed (mcporter CLI sends all values as strings) */
function coerceNumber(val: unknown): unknown {
	if (typeof val === 'string' && val.trim() !== '') {
		const n = Number(val)
		if (!isNaN(n)) return n
	}
	return val
}

/**
 * Wrap an order schema (PlaceOrderParams or ReplaceOrderParams) with alias
 * normalization and numeric coercion so the MCP SDK accepts common trading
 * abbreviations like GTC, LMT, BTO, etc. and string-encoded numbers from
 * CLI tools before Zod validation runs.
 */
export function withOrderAliases(schema: z.ZodObject<any>) {
	return z.object({
		...schema.shape,
		// Coerce top-level numeric fields that CLI tools may send as strings
		price: z.preprocess(coerceNumber, schema.shape.price),
		quantity: z.preprocess(coerceNumber, schema.shape.quantity),
		duration: withAliases(schema.shape.duration, DURATION_ALIASES),
		orderType: withAliases(schema.shape.orderType, ORDER_TYPE_ALIASES),
		orderLegCollection: z.preprocess(
			(val) => {
				if (!Array.isArray(val)) return val
				return val.map((leg: any) => {
					if (!leg || typeof leg !== 'object') return leg
					// Coerce leg quantity from string to number
					const coerced = { ...leg }
					if (typeof coerced.quantity === 'string') {
						const n = Number(coerced.quantity)
						if (!isNaN(n)) coerced.quantity = n
					}
					// Normalize instruction aliases
					const instr = coerced.instruction
					if (typeof instr === 'string' && INSTRUCTION_ALIASES[instr]) {
						coerced.instruction = INSTRUCTION_ALIASES[instr]
					}
					return coerced
				})
			},
			schema.shape.orderLegCollection,
		),
	})
}

/**
 * OCC option-symbol parsing, shared by the order guardrails and the Slack
 * renderer.
 *
 * Schwab's format is a fixed-width 21-char string: a 6-char space-padded
 * underlying, a YYMMDD expiry, C|P, then the strike in thousandths padded to
 * 8 digits. "JPM   261218C00385000" is a JPM 2026-12-18 385 call.
 */

export interface ParsedOption {
	underlying: string
	/** ISO calendar date, YYYY-MM-DD */
	expiry: string
	right: 'C' | 'P'
	strike: number
}

const OCC_PATTERN = /^(.{6})(\d{6})([CP])(\d{8})$/

/** Parse an OCC symbol, or null if it is not one (e.g. a plain equity ticker) */
export function parseOccSymbol(symbol: string): ParsedOption | null {
	const match = OCC_PATTERN.exec(symbol)
	if (!match) return null
	const [, pad, date, right, strike] = match
	const underlying = pad!.trim()
	if (!underlying) return null
	const expiry = `20${date!.slice(0, 2)}-${date!.slice(2, 4)}-${date!.slice(4, 6)}`
	// Rejects impossible dates like month 13 / day 45, which Date.parse reads as NaN
	if (!Number.isFinite(Date.parse(`${expiry}T00:00:00Z`))) return null
	return {
		underlying,
		expiry,
		right: right as 'C' | 'P',
		strike: Number(strike) / 1000,
	}
}

/**
 * Today's date in America/New_York as YYYY-MM-DD. Option expiry is an
 * exchange-calendar date, so it must be compared against Eastern time — UTC
 * rolls over at 8pm ET and would call a same-day expiry "expired".
 */
export function easternDateString(now: Date = new Date()): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(now)
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
	return `${get('year')}-${get('month')}-${get('day')}`
}

/** True when the contract's expiry date is already past in Eastern time */
export function isExpired(parsed: ParsedOption, now: Date = new Date()): boolean {
	return parsed.expiry < easternDateString(now)
}

/** Strike without trailing zeros: 385 → "385", 12.5 → "12.5" */
function formatStrike(strike: number): string {
	return String(Number(strike.toFixed(3)))
}

/**
 * Compact human form for Slack and log lines: "JPM 12/18/26 385C".
 * Returns the raw symbol unchanged when it is not an OCC symbol.
 */
export function describeOccSymbol(symbol: string): string {
	const parsed = parseOccSymbol(symbol)
	if (!parsed) return symbol
	const [year, month, day] = parsed.expiry.split('-') as [string, string, string]
	return `${parsed.underlying} ${month}/${day}/${year.slice(2)} ${formatStrike(parsed.strike)}${parsed.right}`
}

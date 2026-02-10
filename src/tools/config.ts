/**
 * Tool configuration for enabling/disabling tools to reduce context usage.
 *
 * Core tools are enabled by default - these are frequently used.
 * Extended tools are disabled by default - enable via ENABLED_TOOLS env var.
 */

// Tools that are enabled by default (frequently used)
export const CORE_TOOLS = [
	// Account management
	'getAccounts',
	'getAccount',

	// Market data
	'getQuotes',
	'getPriceHistory',
	'getOptionChain',

	// Order management
	'placeOrder',
	'getOrders',
	'cancelOrder',
] as const

// Tools that are disabled by default (less frequently used)
export const EXTENDED_TOOLS = [
	// Account - rarely needed directly
	'getAccountNumbers',
	'getUserPreference',

	// Orders - less common operations
	'getOrdersByAccountNumber',
	'getOrder',
	'replaceOrder',

	// Transactions
	'getTransactions',
	'getTransaction',

	// Market data - less common
	'getQuoteBySymbolId',
	'searchInstruments',
	'getInstrumentByCusip',
	'getMarketHours',
	'getMarketHoursByMarketId',
	'getMovers',
	'getOptionExpirationChain',
] as const

export type CoreToolName = (typeof CORE_TOOLS)[number]
export type ExtendedToolName = (typeof EXTENDED_TOOLS)[number]
export type ToolName = CoreToolName | ExtendedToolName

/**
 * Parse the ENABLED_TOOLS environment variable.
 *
 * Format options:
 * - "all" - Enable all tools (core + extended)
 * - "core" - Enable only core tools (default)
 * - "tool1,tool2,tool3" - Enable specific tools (comma-separated)
 * - "+tool1,+tool2" - Enable core tools PLUS specified extended tools
 * - "-tool1,-tool2" - Enable core tools MINUS specified tools
 *
 * @param envValue The ENABLED_TOOLS environment variable value
 * @returns Set of enabled tool names
 */
export function parseEnabledTools(envValue?: string): Set<string> {
	const allTools = [...CORE_TOOLS, ...EXTENDED_TOOLS]

	// Default: core tools only
	if (!envValue || envValue === 'core') {
		return new Set(CORE_TOOLS)
	}

	// All tools
	if (envValue === 'all') {
		return new Set(allTools)
	}

	// Check for additive/subtractive mode
	const parts = envValue.split(',').map((s) => s.trim())

	// Additive mode: "+tool1,+tool2" adds to core tools
	if (parts.every((p) => p.startsWith('+') || p.startsWith('-'))) {
		const enabled = new Set<string>(CORE_TOOLS)

		for (const part of parts) {
			const toolName = part.slice(1) // Remove +/- prefix
			if (part.startsWith('+')) {
				if (allTools.includes(toolName as ToolName)) {
					enabled.add(toolName)
				}
			} else if (part.startsWith('-')) {
				enabled.delete(toolName)
			}
		}

		return enabled
	}

	// Explicit list mode: "tool1,tool2,tool3"
	const enabled = new Set<string>()
	for (const toolName of parts) {
		if (allTools.includes(toolName as ToolName)) {
			enabled.add(toolName)
		}
	}

	return enabled
}

/**
 * Filter tool specs based on enabled tools configuration.
 *
 * @param toolSpecs Array of tool specifications
 * @param enabledTools Set of enabled tool names
 * @returns Filtered array of tool specifications
 */
export function filterToolSpecs<T extends { name: string }>(
	toolSpecs: readonly T[],
	enabledTools: Set<string>,
): T[] {
	return toolSpecs.filter((spec) => enabledTools.has(spec.name))
}

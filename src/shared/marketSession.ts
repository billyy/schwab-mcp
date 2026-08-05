import { LOGGER_CONTEXTS } from './constants'
import { logger } from './log'

const sessionLogger = logger.child(LOGGER_CONTEXTS.PROPOSALS)

/**
 * Which trading session the equity market is in right now.
 *
 * This matters because the drift pipeline runs both pre-market (7am ET
 * report) and post-open (10am ET proposal), and bid/ask outside the regular
 * session is the thin extended-hours book — not something a limit price
 * should be derived from.
 *
 * Primary source is Schwab's market-hours calendar (classifyFromCalendar),
 * which knows holidays AND early closes — a 1pm-ET close would fool any
 * clock. classifyFromClock is the fallback when that call fails.
 */
export type MarketSession = 'PRE' | 'REGULAR' | 'POST' | 'CLOSED'

/**
 * Classify from the equity market-hours calendar. Returns null when the
 * payload can't answer the question (missing/malformed), so the caller can
 * fall back to the clock.
 */
export function classifyFromCalendar(hours: unknown): MarketSession | null {
	const eq = Object.values((hours as any)?.equity ?? {})[0] as any
	if (!eq || typeof eq.isOpen !== 'boolean') return null
	if (!eq.isOpen) return 'CLOSED'
	const sessions = eq.sessionHours ?? {}
	if (Object.keys(sessions).length === 0) return null // open but no windows: broken data
	const now = Date.now()
	// start/end carry explicit offsets ("2026-08-04T09:30:00-04:00")
	const within = (windows: unknown) =>
		Array.isArray(windows) &&
		windows.some((w: any) => {
			const s = Date.parse(w?.start)
			const e = Date.parse(w?.end)
			return Number.isFinite(s) && Number.isFinite(e) && now >= s && now < e
		})
	if (within(sessions.regularMarket)) return 'REGULAR'
	if (within(sessions.preMarket)) return 'PRE'
	if (within(sessions.postMarket)) return 'POST'
	return 'CLOSED'
}

export function classifyFromClock(
	quoteStatuses: (string | null)[],
): MarketSession {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		weekday: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).formatToParts(new Date())
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
	const weekday = get('weekday')
	// 'en-US' hour12:false renders midnight as '24' in some ICU builds
	const hour = Number(get('hour')) % 24
	const minutes = hour * 60 + Number(get('minute'))

	let session: MarketSession
	if (weekday === 'Sat' || weekday === 'Sun') session = 'CLOSED'
	else if (minutes < 4 * 60) session = 'CLOSED'
	else if (minutes < 9 * 60 + 30) session = 'PRE'
	else if (minutes < 16 * 60) session = 'REGULAR'
	else if (minutes <= 20 * 60) session = 'POST'
	else session = 'CLOSED'

	// Holidays: the clock says REGULAR but Schwab reports every name as closed.
	const known = quoteStatuses.filter((s): s is string => typeof s === 'string')
	if (
		session !== 'CLOSED' &&
		known.length > 0 &&
		known.every((s) => s.toLowerCase() === 'closed')
	) {
		return 'CLOSED'
	}
	return session
}

/**
 * Resolve the current session: Schwab's calendar first (holidays + early
 * closes), clock + securityStatus as the fallback when that call fails.
 *
 * `quoteStatuses` is optional context for the clock fallback — pass the
 * securityStatus of any quotes already in hand, or omit when there are none.
 */
export async function resolveMarketSession(
	client: any,
	quoteStatuses: (string | null)[] = [],
): Promise<{ session: MarketSession; source: 'calendar' | 'clock' }> {
	let calendarSession: MarketSession | null = null
	try {
		const hours = await client.marketData.marketHours.getMarketHours({
			queryParams: { markets: ['equity'] },
		})
		calendarSession = classifyFromCalendar(hours)
	} catch (error) {
		sessionLogger.warn('Market hours fetch failed; using clock fallback', {
			error: error instanceof Error ? error.message : String(error),
		})
	}
	return calendarSession !== null
		? { session: calendarSession, source: 'calendar' }
		: { session: classifyFromClock(quoteStatuses), source: 'clock' }
}

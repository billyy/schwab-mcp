import { scrubAccountIdentifiers } from '@sudowealth/schwab-api'
import { type Env } from '../../types/env'
import { getConfig } from '../config'
import { LOGGER_CONTEXTS } from '../shared/constants'
import { logger } from '../shared/log'
import {
	OrderRequestSchema,
	availableAccountDisplays,
	checkGuardrails,
	checkOrderApiKey,
	createOrderContext,
	hashOrder,
	jsonResponse,
	placeOne,
	previewOne,
	resolveAccountHash,
} from './core'

const ordersLogger = logger.child(LOGGER_CONTEXTS.ORDERS)

interface OrdersRequestBody {
	/** The order, in PlaceOrderParams shape (aliases like LMT/GTC/BTO accepted) */
	order?: unknown
	/** true = place the order for real; false/absent = preview only */
	submit?: boolean
	/** Required for submit: the orderHash returned by the preview call */
	orderHash?: string
	/** Skip the duplicate-open-order check (explicit override) */
	allowDuplicate?: boolean
}

/**
 * POST /orders — programmatic order preview/submission, independent of the MCP/LLM path.
 *
 * Auth: `Authorization: Bearer <ORDER_API_KEY>` (constant-time compared).
 * Flow: call once with `submit: false` (default) to validate + get Schwab's
 * preview and an `orderHash`; call again with `submit: true` and that
 * `orderHash` to place the order. Server-side limits (symbol allowlist, max
 * notional, daily cap, duplicate detection) apply to every submit.
 */
export async function handleOrdersRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'Method not allowed. Use POST.' })
	}

	const config = getConfig(env)
	if (!config.ORDER_API_KEY || !config.SCHWAB_USER_ID) {
		return jsonResponse(503, {
			error:
				'Orders endpoint disabled. Set ORDER_API_KEY and SCHWAB_USER_ID secrets to enable.',
		})
	}

	// --- Authentication (constant-time) ---
	if (!(await checkOrderApiKey(request, config))) {
		ordersLogger.warn('Orders endpoint: rejected request with bad API key')
		return jsonResponse(401, { error: 'Unauthorized' })
	}

	// --- Parse & validate ---
	let body: OrdersRequestBody
	try {
		body = (await request.json()) as OrdersRequestBody
	} catch {
		return jsonResponse(400, { error: 'Invalid JSON body' })
	}

	const parsed = OrderRequestSchema.safeParse(body.order)
	if (!parsed.success) {
		return jsonResponse(400, {
			error: 'Order failed validation against PlaceOrderParams',
			issues: parsed.error.issues.map((i) => ({
				path: i.path.join('.'),
				message: i.message,
			})),
		})
	}
	const { accountNumber: requestedAccount, ...orderBody } = parsed.data as any
	const submit = body.submit === true

	// --- Server-side limits (apply to preview too, so problems surface early) ---
	const guard = checkGuardrails(config, orderBody)
	if (!guard.ok) {
		return jsonResponse(guard.status, { error: guard.error })
	}

	// --- Authenticated client from KV token ---
	const built = await createOrderContext(config)
	if (!built.ok) {
		return jsonResponse(built.status, { error: built.error })
	}
	const { ctx } = built

	// --- Resolve account (accepts plain account number or hashValue) ---
	const accountHash = resolveAccountHash(ctx, requestedAccount)
	if (!accountHash) {
		return jsonResponse(400, {
			error:
				'accountNumber does not match any account (plain or hashValue) on this login',
			availableAccounts: availableAccountDisplays(ctx),
		})
	}

	const orderHash = await hashOrder(orderBody)
	const { displayMap } = ctx

	// --- Preview path ---
	if (!submit) {
		const preview = await previewOne(ctx, accountHash, orderBody)
		return jsonResponse(200, {
			mode: 'preview',
			orderHash,
			order: orderBody,
			schwabPreview: scrubAccountIdentifiers(preview.schwabPreview, displayMap),
			duplicateOpenOrder: preview.duplicateOpenOrder
				? scrubAccountIdentifiers(preview.duplicateOpenOrder, displayMap)
				: null,
			next: 'POST again with {"submit": true, "orderHash": "<orderHash>"} to place this order.',
		})
	}

	// --- Submit path ---
	if (body.orderHash !== orderHash) {
		return jsonResponse(409, {
			error:
				'orderHash missing or does not match this order. Preview first (submit: false) and pass back the returned orderHash.',
			expectedOrderHash: orderHash,
		})
	}

	const placed = await placeOne(ctx, accountHash, orderBody, {
		allowDuplicate: body.allowDuplicate === true,
	})
	if (!placed.ok) {
		switch (placed.stage) {
			case 'duplicate':
				return jsonResponse(409, {
					error: placed.error,
					duplicateOpenOrder: scrubAccountIdentifiers(placed.detail, displayMap),
				})
			case 'dailyCap':
				return jsonResponse(429, { error: placed.error })
			case 'schwab':
				return jsonResponse(
					placed.schwabStatus && placed.schwabStatus >= 400 ? 502 : 500,
					{
						error: placed.error,
						schwabStatus: placed.schwabStatus,
						schwabBody: placed.schwabBody,
					},
				)
		}
	}

	return jsonResponse(200, {
		mode: 'submitted',
		orderHash,
		result: scrubAccountIdentifiers(placed.result, displayMap),
	})
}

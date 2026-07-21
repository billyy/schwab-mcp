# Order CLI — place Schwab orders without an LLM

`cli/schwab-order.mjs` is a zero-dependency Node script that submits orders
through the Worker's `POST /orders` endpoint. No AI is involved anywhere in
this path: you author the order JSON, the Worker validates it, Schwab previews
it, and nothing is placed until you type `yes`.

```
order.json ──▶ CLI ──▶ Worker /orders ──▶ Schwab
              (preview → confirm → submit)
```

## One-time setup

### 1. Enable the endpoint on the Worker

The endpoint is **disabled (returns 503) until both secrets are set**:

```bash
openssl rand -hex 32                      # generate a key, save it
npx wrangler secret put ORDER_API_KEY     # paste the key
npx wrangler secret put SCHWAB_USER_ID    # your Schwab user ID
npm run deploy
```

Your `SCHWAB_USER_ID` is the suffix of the `token:<id>` key in KV:

```bash
npx wrangler kv:key list --namespace-id=<OAUTH_KV_ID>
```

For local dev, set both in `.dev.vars` instead (see `.dev.vars.example`).

### 2. Give the CLI the key

Either export it:

```bash
export ORDER_API_KEY=<the key>
```

or store it in the macOS Keychain (checked automatically when the env var is
unset):

```bash
security add-generic-password -s schwab-mcp-order -a api-key -w '<the key>'
```

### 3. Point the CLI at your Worker

```bash
export WORKER_URL=https://your-worker.workers.dev   # default: http://localhost:8788
```

## Usage

```bash
node cli/schwab-order.mjs order.json          # preview → interactive confirm → submit
node cli/schwab-order.mjs order.json --yes    # skip the prompt (still previews first)
cat order.json | node cli/schwab-order.mjs -  # read the order from stdin
```

A run looks like:

1. **Preview** — the Worker validates the JSON, runs Schwab's own
   `previewOrder` (margin/buying-power/halt checks), and warns if an identical
   open order already exists.
2. **Confirm** — the order summary and Schwab's preview are printed; type
   `yes` to proceed, anything else aborts with no order placed.
3. **Submit** — the order is placed, bound by hash to exactly what was
   previewed. The result (order ID, status) is printed.

## Order file format

The JSON must match Schwab's `PlaceOrderParams`. Minimal equity limit order:

```json
{
  "accountNumber": "<hashValue or plain account number>",
  "session": "NORMAL",
  "duration": "DAY",
  "orderType": "LIMIT",
  "price": 230.5,
  "orderStrategyType": "SINGLE",
  "orderLegCollection": [
    {
      "instruction": "BUY",
      "quantity": 10,
      "instrument": { "symbol": "AAPL", "assetType": "EQUITY" }
    }
  ]
}
```

Option order (buy 1 call to open):

```json
{
  "accountNumber": "<hashValue>",
  "session": "NORMAL",
  "duration": "DAY",
  "orderType": "LIMIT",
  "price": 3.25,
  "orderStrategyType": "SINGLE",
  "orderLegCollection": [
    {
      "instruction": "BUY_TO_OPEN",
      "quantity": 1,
      "instrument": {
        "symbol": "AAPL  250815C00230000",
        "assetType": "OPTION"
      }
    }
  ]
}
```

Field notes:

- `accountNumber` — accepts either the plain account number or the
  `hashValue`; the Worker resolves it. (Get the hash from the `getAccounts`
  MCP tool or Schwab's `accountNumbers` endpoint.)
- Common abbreviations are accepted and normalized: `LMT`/`MKT`/`STP`/
  `STP_LMT` (orderType), `GTC`/`FOK`/`IOC` (duration), `BTO`/`BTC`/`STO`/`STC`
  (instruction).
- Option symbols use Schwab's padded format (`RRRRRRYYMMDDsWWWWWddd`), exactly
  as returned by the option chain endpoints.
- Numbers may be quoted strings; they're coerced.

## Server-side guardrails

Every submission passes through these checks in the Worker (configured via
optional env vars / secrets):

| Check | Config | Behavior |
| --- | --- | --- |
| API key | `ORDER_API_KEY` | Constant-time compared; 401 on mismatch |
| Schema | — | Zod-validated; field-level errors on 400 |
| Symbol allowlist | `ORDER_SYMBOL_ALLOWLIST` (csv) | 403 if any leg's underlying isn't listed |
| Max notional | `ORDER_MAX_NOTIONAL` (USD) | 403 if `price × qty` (×100 for options) exceeds it; MARKET orders rejected when set |
| Daily cap | `ORDER_DAILY_CAP` (default 10) | 429 once the UTC-day submit count is hit |
| Duplicate | — | 409 if an identical open order exists (`"allowDuplicate": true` overrides) |
| Preview binding | — | Submit requires the `orderHash` from the preview; 409 otherwise |
| Audit | — | Every submit written to KV (`audit:order:*`, 90-day TTL) |

## Troubleshooting

- **503 "Orders endpoint disabled"** — `ORDER_API_KEY` and/or `SCHWAB_USER_ID`
  not set on the Worker.
- **401 "Unauthorized"** — CLI key doesn't match the Worker secret.
- **401 "No Schwab token found in KV"** — the OAuth token expired or was never
  created; complete the OAuth flow or run the `automation/` refresh.
- **409 orderHash mismatch** — the order file changed between preview and
  submit; the CLI handles this automatically, so this usually means a manual
  `curl` skipped the preview step.
- **Preview shows an error from Schwab** — read it before confirming; it's
  Schwab's own rejection reason (buying power, halted symbol, bad option
  symbol, market closed for the session, etc.).

## Direct API use (no CLI)

The CLI is a thin wrapper; you can hit the endpoint from anything:

```bash
# Preview
curl -s -X POST "$WORKER_URL/orders" \
  -H "Authorization: Bearer $ORDER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"order\": $(cat order.json)}"

# Submit (orderHash comes from the preview response)
curl -s -X POST "$WORKER_URL/orders" \
  -H "Authorization: Bearer $ORDER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"order\": $(cat order.json), \"submit\": true, \"orderHash\": \"<hash>\"}"
```

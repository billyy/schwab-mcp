# Drift Approval — Slack-approved rebalance orders (LLM-free execution)

Complements the Cowork drift task (Partnership vs CRT benchmark). The task
computes the delta and drafts concrete orders; everything after that is
deterministic worker code — **no LLM is involved in placing trades**.

```
Cowork task ──POST /proposals (Bearer ORDER_API_KEY)──▶ Worker
   validate → guardrails → Schwab preview each order
   → Slack message (delta + orders + Approve/Reject buttons)
   → store in ProposalStore DO (one write, already carrying the message ts)
You click Approve ──Slack──▶ POST /slack/interactions
   verify Slack signature → approver allowlist → atomic claim
   → execute each order via the same guarded path as POST /orders
   → Slack message updated with per-order ✅/❌
```

## Creating a proposal

```bash
curl -sS -X POST "$WORKER_URL/proposals" \
  -H "Authorization: Bearer $ORDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "summary": "Partnership drifted vs CRT: SCHW 100 vs 162 — add 62",
    "accountNumber": "12345678",
    "orders": [
      {
        "orderType": "LMT",
        "price": 90.00,
        "duration": "DAY",
        "session": "NORMAL",
        "orderStrategyType": "SINGLE",
        "orderLegCollection": [
          {
            "instruction": "BUY",
            "quantity": 62,
            "instrument": { "symbol": "SCHW", "assetType": "EQUITY" }
          }
        ]
      }
    ]
  }'
```

Or `node cli/schwab-propose.mjs proposal.json` (same Keychain/`ORDER_API_KEY`
lookup as `schwab-order.mjs`).

Rules:

- **LIMIT orders only.** Priceless (MARKET) orders are always rejected on this
  endpoint — a stale market order approved hours later is unbounded risk. A
  multi-leg option spread satisfies this with a net price (`NET_CREDIT`,
  `NET_DEBIT`, `NET_ZERO`) — see [Option rolls](#option-rolls). A single-leg
  covered call sold to open uses a plain `LIMIT` instead.
- `accountNumber` (plain number or hashValue) can be set per order or once at
  the proposal level. It is re-resolved at execution, so hashValue rotation is
  harmless.
- Max 10 orders per proposal; the batch must fit the remaining
  `ORDER_DAILY_CAP` for the day.
- Every order must pass the symbol allowlist, `ORDER_MAX_NOTIONAL`, a live
  Schwab preview, and the duplicate-open-order check **at proposal time** —
  otherwise the whole request is rejected and nothing is stored or posted.
- A new proposal **supersedes** any prior pending proposal (its Slack message
  is updated and it can no longer be approved). Only the latest delta is valid.
- Proposals **expire 4 hours** after creation.
- The Cowork task's job ends at the HTTP 200. It must never poll for approval,
  auto-retry a rejected proposal, or resubmit on a non-2xx without a human
  looking at the error.

Response:

```json
{
  "proposalId": "…",
  "status": "pending",
  "expiresAt": "…",
  "superseded": ["…"],
  "orders": [
    {
      "orderHash": "…",
      "symbols": ["SCHW"],
      "notional": 5580,
      "previewStatus": 200,
      "coverageChecked": false
    }
  ]
}
```

`coverageChecked` is `true` when the covered-call check actually inspected
positions for that order. `false` means it was not applicable — nothing in the
order can reduce coverage — never that it was skipped: a failed check rejects
the whole batch with a 403. It is re-run at execution either way.

Errors: `400` validation/preview failure (per-index `issues`), `401` bad key,
`403` guardrail or coverage failure, `409` duplicate open order or non-regular
session, `429` daily cap, `502` Slack post failed, `503` feature not
configured.

## Option rolls

Most option divergences are covered-call **rolls**: close a near-dated short
call, open a later or higher-strike one. (The other proposable shape is an
opening covered-call sale — see [Where option plans come from](#where-option-plans-come-from).)
A roll is submitted as **one net-priced two-leg order**, never as two
single-leg orders:

```json
{
  "session": "NORMAL",
  "duration": "DAY",
  "orderType": "NET_CREDIT",
  "price": 4.2,
  "complexOrderStrategyType": "DIAGONAL",
  "orderStrategyType": "SINGLE",
  "orderLegCollection": [
    {
      "instruction": "BUY_TO_CLOSE",
      "quantity": 1,
      "instrument": { "symbol": "JPM   260821C00360000", "assetType": "OPTION" }
    },
    {
      "instruction": "SELL_TO_OPEN",
      "quantity": 1,
      "instrument": { "symbol": "JPM   261218C00385000", "assetType": "OPTION" }
    }
  ]
}
```

Both legs fill or neither does. Two separate orders can half-fill, and if the
ordering ever inverted the account would be briefly short an uncovered call —
the one outcome this pipeline must never produce.

**`complexOrderStrategyType` is required and must name the real strategy.** It
is not cosmetic: left as `NONE` (or unset) Schwab treats the order as a simple
one, reads `price` as a plain limit price, and rejects it with the misleading
`"Limit price must be populated only for limit orders."` `checkOptionStructure`
now catches this locally so the error names the actual cause.

The two-leg classification, which `drift-diff` computes as
`optionGaps[].rollType` and puts straight into the order body:

| Legs differ by | Value |
| --- | --- |
| Strike only (one expiry) | `VERTICAL` |
| Expiry only (one strike) | `CALENDAR` |
| Both | `DIAGONAL` |

Not `VERTICAL_ROLL` — that value is for rolling an entire vertical, four legs.
Stripped of the roll framing, a two-leg same-expiry package is just a vertical:
long the lower strike, short the higher, hence a debit.

Verified 2026-08-18 against Schwab's `previewOrder`: `VERTICAL` + `NET_DEBIT` +
`price` returns 200; the same order with `NONE` returns 400.

### Where option plans come from

`node cli/drift-diff.mjs --json` emits `optionGaps[]`, one entry per option
divergence, each with `planKind`, `proposable`, `reasons[]`, and a
ready-to-submit `order`. Copy a proposable entry's `order` into a proposal
file's `orders` array and run `cli/schwab-propose.mjs`.

Two shapes are priceable, and `planKind` names which:

| `planKind` | Shape | Order |
| --- | --- | --- |
| `"roll"` | Close one short call, open another 1:1 | Two legs, `NET_*` price, **must** carry `complexOrderStrategyType` |
| `"open"` | Nothing to close, one call sold to open | One leg, plain `LIMIT` at the bid, **must not** carry `complexOrderStrategyType` |
| `null` | Anything else, including a bare close | None — report-only |

The `complexOrderStrategyType` requirement is exactly inverted between the two,
which is the whole reason the propose task copies `order` **verbatim** instead
of rebuilding it: naming a strategy is what makes Schwab read `price` as a net
price, so the two-leg order is rejected without it and the one-leg order is
rejected with it.

An `"open"` is not a weaker roll. With no closing leg there is no half-fill to
invert, and its entire risk is the short call itself — which is bounded by the
same coverage check that bounds a roll's. What makes it a *covered* call rather
than a naked one is `checkOptionCoverage()`, and nothing else.

A bare **close** (the account holds a short call the benchmark does not) is
deliberately report-only. It is risk-reducing, but it spends cash, and nothing
has asked this path to make that call unattended.

Pricing crosses to the unfavorable side of the spread — buy a closing leg at
its **ask**, sell an opening leg at its **bid** — the same convention the equity
path uses. Each plan also reports `netAtMid` and `givesUp` so the approver can
see what crossing costs versus the mids.

A divergence is **report-only** (not proposable) when any of these hold, each
named in `reasons[]`:

| Reason | Why |
| --- | --- |
| Neither a 1:1 close/open pair nor a single opening sale | A ratio change, multi-contract reshuffle, or bare close; a wrong pairing is a naked short. |
| Not a call | Shares cannot cover a put, so this path does not price one. |
| Long option inventory involved | Only plain short-call rolls and opens are modeled. |
| Coverage would break | Resulting short calls would exceed shares ÷ 100. |
| Leg quote not `Normal`, one-sided, or crossed | A frozen quote is not a limit basis. |
| Spread wider than 25% of mid (above a $0.10 floor) | Crossing a thin option spread is where a "conservative" limit becomes a bad fill. |
| No bid on an opening sale | A $0 limit would offer to write the call for nothing. Only reachable for `"open"`; inside a roll the bid is subsumed in the net price. |
| Expiry already past | The contract is untradeable and the position needs manual review. |

Unlike equity gaps, option trades have **no notional floor**. The $1,000 equity
threshold filters rounding noise; an option divergence is a whole position, so
a $200 net credit still moves a 100-share obligation and is judged on quote
quality and coverage instead of size.

### The covered-call guard

Every order that touches an option — or that **sells equity** — is checked
against live positions before placement, in `checkOptionCoverage`:

- Resulting short calls per underlying must be backed by shares (`contracts ×
  100`). A roll that would strand a short call is refused with the numbers.
- Long calls never count as cover. Netting them against shorts would let a
  cheap far-OTM long "cover" a near-the-money short.
- Short **puts** are out of scope: shares cannot cover a put, and the backing
  is cash/buying power, which Schwab's own `previewOrder` enforces.
- It fails **closed** — if positions can't be read, the check has not passed.

It runs three times: at proposal time (so a bad batch never reaches Slack), at
approval time, and again inside `placeOne` immediately before submission. The
last one matters most: an approval can land hours after the proposal was built,
and the shares backing a short call may have been sold in between.

This also closes a hole on the equity side. An equity SELL that would strand an
existing short call is now refused — previously the drift path could place one
unnoticed.

### What `ORDER_MAX_NOTIONAL` does and does not bound

For a net-priced spread, `notional` is the **premium exchanged**, counted once
against the number of spreads (`|price| × contracts × 100`) — not summed per
leg, which would report a two-leg roll at double its real cash value.

It is not the assignment exposure. A $420 net-credit roll into a 385-strike
call carries a $38,500 obligation. `ORDER_MAX_NOTIONAL` does not bound that;
the coverage guard is what keeps it backed by shares.

## Approving in Slack

The worker posts one message per proposal to `SLACK_CHANNEL_ID` with the
summary, per-order lines, total notional, expiry, and two buttons. Only user
IDs in `SLACK_APPROVER_IDS` can act — anyone else gets an ephemeral "not
authorized" reply. Approve pops Slack's native confirm dialog, then the
buttons vanish and the message live-updates: ⏳ executing → per-order results.

Execution details:

- Orders run **sequentially**, each re-checked at approval time: guardrails
  re-run (config may have changed), account re-resolved, fresh Schwab preview,
  duplicate guard, covered-call check against live positions, daily cap — the
  identical code path as `POST /orders` submit. One failing order does not stop
  the rest (except the daily cap, which skips all remaining orders).
- Final states: `executed` (all placed), `partial`, `failed`, `rejected`,
  `expired`, `superseded`.
- Source of truth is the ProposalStore record plus KV audit entries
  (`audit:proposal:<ISO>:<id8>` and the usual `audit:order:…` per placement,
  90-day retention). A failed Slack update never re-triggers placement.

### Why the Slack post happens before the store write

The message goes up first, then the record is written once, already carrying
the message's `channel`/`ts`. This is ordering for crash-safety, not style.

Storing first left two ways to orphan a proposal whenever the isolate died in
between — and a `wrangler dev` reload mid-request is enough to do it:

- a `pending` record with no message, which nothing can approve and nothing
  clears (it lingers until a later proposal supersedes it), or
- a live message whose record never received its Slack coordinates, so
  approving it places the orders while the message still shows its buttons.

Posting first removes both: until the message exists there is nothing to roll
back, and the record is written exactly once. The one remaining window —
message posted, store write failed — fails closed. The buttons carry an id the
store does not have, `claim` answers `not_found`, nothing is placed, and the
handler withdraws the message to say so.

## Helper endpoints for the drift scheduled task

Both Bearer `ORDER_API_KEY`, built for the local Claude Code scheduled task
that replaced the sandboxed Cowork job:

- `GET /rebalance/snapshot?accounts=<num>,<num>` — read-only: scrubbed
  display name, liquidation value, cash, slimmed positions
  (symbol/assetType/long/short/marketValue) per account, plus live quotes
  for the union of equity **and option** symbols. One call supplies everything
  drift analysis and limit pricing need.

  Option quotes are fetched in a **separate** call and merged into the same
  `quotes` map, keyed by OCC symbol, each carrying an extra `openInterest`.
  The split is deliberate: folding them into the equity call would let an
  option-quote outage flip `pricesTradable` to false and cost the equity drift
  run its whole window over contracts it never prices. Their health is reported
  independently as `optionQuotes: {requested, returned, ok, error?}` — check it
  before pricing any option limit. `ok` is false on a partial return too, so a
  missing quote is never read as "no gap".

  Each quote is `{bid, ask, last, close, mark, status}`, and the response carries a
  top-level `marketSession` (`PRE`/`REGULAR`/`POST`/`CLOSED`), `sessionSource`
  (`calendar`/`clock`), and `pricesTradable`. **Callers must not derive limit
  prices from `bid`/`ask` unless `pricesTradable` is true** — outside the
  regular session those are the thin extended-hours book. `pricesTradable` is
  also false when the quote fetch itself failed (`quotes: {"error": ...}`),
  and it is market-wide, not per-symbol: a halted name still surfaces its
  frozen quote, so order-building callers should skip any symbol whose
  `status` is not `Normal`. Use `close` (prior regular-session close) to size
  notionals pre-market.
  The session comes from Schwab's equity market-hours calendar
  (`sessionSource: "calendar"`), which covers holidays and early closes. If
  that call fails, a clock in `America/New_York` with a `securityStatus`
  override takes over (`sessionSource: "clock"`) — correct on normal days and
  full holidays, but blind to early closes (1–4pm ET on a 1pm-close day reads
  as REGULAR), which is why the calendar is primary.

  This is why the drift pipeline is two scheduled tasks: `crt-partnership-drift`
  posts the report at 7:00am ET (pre-market, report-only), and
  `crt-partnership-rebalance-propose` re-runs the diff and submits the
  proposal at 10:00am ET against live quotes.
- `POST /slack/notify` `{"text": "<mrkdwn>"}` — posts to the configured
  `SLACK_CHANNEL_ID` via the worker's bot token, so the caller never holds
  Slack credentials.

## Slack app setup (one time)

1. [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From a manifest:

   ```yaml
   display_information:
     name: Schwab Drift Approvals
   features:
     bot_user:
       display_name: drift-approver
       always_online: true
   oauth_config:
     scopes:
       bot: [chat:write]
   settings:
     interactivity:
       is_enabled: true
       request_url: https://<your-worker>.workers.dev/slack/interactions
     socket_mode_enabled: false   # must be HTTP mode; Workers cannot hold sockets
   ```

2. Install to workspace. Copy the **Bot User OAuth Token** (`xoxb-…`) and the
   **Signing Secret** (Basic Information).
3. In the target channel: `/invite @drift-approver`. Copy the channel ID
   (`C…`) and your member ID (`U…`, profile → … → Copy member ID).
4. Configure the worker:

   ```bash
   npx wrangler secret put SLACK_BOT_TOKEN
   npx wrangler secret put SLACK_SIGNING_SECRET
   # channel + approvers can be vars in wrangler.jsonc or secrets:
   npx wrangler secret put SLACK_CHANNEL_ID
   npx wrangler secret put SLACK_APPROVER_IDS   # e.g. U0123ABCDEF (csv for several)
   npm run deploy
   ```

The endpoints stay 503-disabled until all of `ORDER_API_KEY`,
`SCHWAB_USER_ID`, and the four `SLACK_*` values are set (plus the
`PROPOSAL_STORE` Durable Object binding, included in the wrangler configs).

None of these values ever need updating after setup. In particular
`SCHWAB_USER_ID` does NOT need to track Schwab's rotating user ID — it is
only a stable alias for the KV token key. A static placeholder like
`SCHWAB_USER_ID=orders-static` is fine: on a miss (or a dead token under the
alias) the worker adopts the most recently written token automatically.
Credential separation: the Slack app never sees `ORDER_API_KEY` (it can
approve but not propose), and the Cowork task never sees the Slack secrets
(it can propose but not approve).

## Local testing

Slack cannot reach `wrangler dev`, so simulate its callbacks:

```bash
npm run dev                                   # worker on :8788, .dev.vars has the SLACK_* values
node cli/schwab-propose.mjs proposal.json     # → proposalId, Slack message appears (postMessage is outbound)

export SLACK_SIGNING_SECRET=...               # same as .dev.vars
node cli/sign-slack-request.mjs approve <proposalId> --user U<your-id>
node cli/sign-slack-request.mjs approve <proposalId> --bad-sig     # expect 401
node cli/sign-slack-request.mjs approve <proposalId> --stale       # expect 401
node cli/sign-slack-request.mjs approve <proposalId> --user U999   # not authorized
node cli/sign-slack-request.mjs reject  <proposalId>
```

First live test: one 1-share LIMIT order priced far from the market (it rests
without filling), approve it, verify `PLACED` + audit keys, then cancel via
the MCP `cancelOrder` tool.

## Runbook

| Situation | What happened / what to do |
|---|---|
| Button says expired | >4h old; prices are stale by design. Re-run the drift task. |
| "Already handled (superseded)" | A newer proposal replaced it — find the newest message. |
| Partial execution | Per-order errors are in the message and in `audit:proposal:*` KV. Fix and re-propose only the failed orders. |
| Stuck "⏳ Executing" | `waitUntil` was evicted. After 15 min the store treats it as failed; check `audit:order:*` to see which orders actually reached Schwab **before** re-proposing. |
| Slack message never updated but orders placed | Slack update failed after execution; KV audit is the source of truth. |

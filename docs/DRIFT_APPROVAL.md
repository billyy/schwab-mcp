# Drift Approval — Slack-approved rebalance orders (LLM-free execution)

Complements the Cowork drift task (Partnership vs CRT benchmark). The task
computes the delta and drafts concrete orders; everything after that is
deterministic worker code — **no LLM is involved in placing trades**.

```
Cowork task ──POST /proposals (Bearer ORDER_API_KEY)──▶ Worker
   validate → guardrails → Schwab preview each order → store in ProposalStore DO
   → Slack message (delta + orders + Approve/Reject buttons)
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
  endpoint — a stale market order approved hours later is unbounded risk.
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
    { "orderHash": "…", "symbols": ["SCHW"], "notional": 5580, "previewStatus": 200 }
  ]
}
```

Errors: `400` validation/preview failure (per-index `issues`), `401` bad key,
`403` guardrail, `409` duplicate open order, `429` daily cap, `502` Slack post
failed, `503` feature not configured.

## Approving in Slack

The worker posts one message per proposal to `SLACK_CHANNEL_ID` with the
summary, per-order lines, total notional, expiry, and two buttons. Only user
IDs in `SLACK_APPROVER_IDS` can act — anyone else gets an ephemeral "not
authorized" reply. Approve pops Slack's native confirm dialog, then the
buttons vanish and the message live-updates: ⏳ executing → per-order results.

Execution details:

- Orders run **sequentially**, each re-checked at approval time: guardrails
  re-run (config may have changed), account re-resolved, fresh Schwab preview,
  duplicate guard, daily cap — the identical code path as `POST /orders`
  submit. One failing order does not stop the rest (except the daily cap,
  which skips all remaining orders).
- Final states: `executed` (all placed), `partial`, `failed`, `rejected`,
  `expired`, `superseded`.
- Source of truth is the ProposalStore record plus KV audit entries
  (`audit:proposal:<ISO>:<id8>` and the usual `audit:order:…` per placement,
  90-day retention). A failed Slack update never re-triggers placement.

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

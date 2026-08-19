---
name: crt-partnership-rebalance-propose
description: Post-open (10am ET) rebalance proposal for Partnership vs CRT drift, priced off live regular-session quotes. Companion to the 7am ET report task.
---

Re-check the Partnership account against the CRT benchmark and, when drift warrants trades, submit a rebalance proposal for human approval. Everything runs through the local schwab-mcp worker at http://localhost:8788 (a wrangler dev server that must already be running on this Mac).

**CRT is the reference account — it is immutable. All rebalancing actions apply to the Partnership account only.**

This is the ORDER half of the drift pipeline. The companion task `crt-partnership-drift` already posted the human-readable divergence report to Slack at 7:00am ET, pre-market. This run fires at 10:00am ET, after the open, for one reason: limit prices must come from live regular-session quotes, not the pre-market book. **Do not post a divergence report to Slack from this task** — the only Slack message this run produces is the Approve/Reject message the worker posts for the proposal itself.

This run proposes **both equity gaps and option rolls**. They are selected by different rules — STEP 3 for equity, STEP 3B for options — and travel in the same proposal batch.

STEP 1 — Run a fresh analysis (do not reuse anything from the morning report) with EXACTLY this command, unchanged (a fixed, byte-identical command string is what lets it be allowlisted; do NOT add redirects, pipes, `cd`, or `echo`, and do NOT re-derive the analysis with an ad-hoc python/node heredoc):
```bash
node cli/drift-diff.mjs --json
```
- It fetches the snapshot itself (worker at http://localhost:8788, key from the Keychain) and emits `asOf`, `marketSession`, `sessionSource`, `pricesTradable`, `balances`, `gaps`, `options`, `optionGaps`, `coverageRows`, and `cleanup`. Each entry in `gaps` carries `symbol`, `held`, `target`, `delta`, `action`, `price`, `priceBasis`, `notional`, `bid`, `ask`, `quoteStatus`, `limitPrice`, and `proposable`.
- `gaps` is equity. `optionGaps` is the priced option roll plans — each with `underlying`, `rollType`, `contracts`, `close`, `open`, `pricing`, `coverage`, `proposable`, `reasons[]`, and a ready-to-submit `order`. (`options` is the raw, unpriced divergence list that `optionGaps` is derived from — it is the morning report's field, not this task's. Never build an order from `options`.)
- `proposable` on an equity gap encodes the $1,000 threshold. It does NOT encode the session guard or the per-symbol halt guard — those stay yours, in STEP 2 and STEP 3.
- `limitPrice` is the STEP 4 limit for equity, already crossed the right way (buy at `ask`, sell at `bid`) and rounded to the penny. `price` is the `last`-based sizing price and is NOT a limit price — never put it on an order.
- Partnership = account 13102970 (display "Partnership ...970"); CRT = 80745838 ("CRT ...838").
- If the command fails or returns an error, report it verbatim and STOP. Do not retry, do not fall back to raw curl or to any other data source.

STEP 2 — Session guard (do this before any analysis):
- If `pricesTradable` is not exactly true (market holiday, early close, halted, quote fetch failed, or the run fired off-schedule), do NOT build or submit any orders. Report the `marketSession` value and STOP. Post nothing to Slack. A missed day is fine; a limit priced off a closed book is not.

STEP 3 — Equity divergence:
- Work from `gaps` where `proposable` is true.
- The $1,000 notional floor is already applied by `proposable`; do not re-derive it, and do not override it. There is no symbol-level policy exclusion — the benchmark defines the universe, so every symbol CRT holds is in scope.
- **Per-symbol halt guard:** `pricesTradable` is market-wide, not per-symbol. Before including any symbol, check its `quoteStatus`: if it is anything other than "Normal" (e.g. halted), EXCLUDE that symbol — its bid/ask is frozen and not a valid limit basis. Note every exclusion in your output summary and in the proposal `summary` field so the approver knows the gap was seen but deferred. This guard is deliberately NOT folded into equity `proposable`, so that a halted symbol is never silently indistinguishable from a below-threshold one.

STEP 3B — Option rolls:
- Work from `optionGaps` where `proposable` is true. Ignore `coverageRows` — those are the morning report's job.
- **Option `proposable` is stricter than equity `proposable` and needs no guards of your own.** It already folds in the roll shape (balanced two-leg short-call roll, no long inventory, one underlying), post-roll share coverage, expiry sanity, and full quote health — **including the per-symbol halt check** (`status` not "Normal" → a reason) and crossed or too-wide quotes. Do not re-derive any of it and do not override it. The equity halt guard in STEP 3 does not apply here; applying it twice is harmless, but skipping a roll that is already `proposable` is not.
- There is **no notional floor for options** — an option divergence is a whole position, not rounding noise. A $94 roll qualifies where a $94 equity gap would not.
- **Copy the entry's `order` object VERBATIM into the proposal.** Do not rebuild it, re-price it, reorder its legs, or change `orderType`, `price`, or `complexOrderStrategyType`. A net price REQUIRES a real `complexOrderStrategyType` (`VERTICAL`/`CALENDAR`/`DIAGONAL`); with `NONE` Schwab reads `price` as a plain limit price and rejects the order.
- **Never split a roll into two single-leg orders.** A roll is one net-priced two-leg order. Two orders can half-fill, and inverted they leave the account briefly short an uncovered call. One `optionGaps` entry = exactly one order in the batch.
- For every `optionGaps` entry where `proposable` is false, report the underlying and its `reasons[]` verbatim in your output summary, so a report-only divergence is visibly deferred rather than silently dropped. Do NOT try to make it proposable.

- If neither STEP 3 nor STEP 3B yields anything, report "no qualifying equity gaps or option rolls" and STOP without submitting anything.

STEP 4 — Build and submit the proposal:
- Write the proposal JSON to /tmp/drift-proposal.json (this runs on the host Mac — /tmp is writable):
  { "summary": "<one-paragraph drift summary: per-symbol share deltas vs CRT, plus each option roll in words>", "accountNumber": "13102970", "orders": [ ... ] }
- Equity order rules: LIMIT only ("orderType": "LIMIT" with "price" set to the gap's `limitPrice`); "duration": "DAY", "session": "NORMAL", "orderStrategyType": "SINGLE"; one order per symbol; orderLegCollection instruction "BUY" or "SELL" with "instrument": {"symbol", "assetType": "EQUITY"}.
- Option order rules: none of your own — the `order` body from `optionGaps` is already complete and correct. Paste it in unchanged.
- Max 10 orders per proposal, counting equity and option orders together.
- Describe each option roll in the `summary` in plain words — expiry, strikes, direction, net price, and the post-roll coverage from `coverage` (shares vs required). A raw OCC symbol does not read as a date and a strike to whoever is approving it. The worker renders the roll legibly in Slack too, but the summary is what frames it.
- Check the buy side against Partnership `cashBalance`. Count an option roll's cash effect as its `pricing.notional` when `pricing.direction` is "debit", and as zero when it is a credit. If total buy notional exceeds available cash, still submit, but state the shortfall prominently in the `summary` field so the approver sees it before approving. Describe it only as a shortfall against the reported cash figure — do NOT assert how it would be funded, and in particular do not call it a margin borrow.
- **Reconcile before trusting cash.** `balances[].reconciles` tells you whether Partnership's positions + cash equals its `liquidationValue`. When it is false, check `balances[].staleLiquidationValue` before attributing a cause:
  - `staleLiquidationValue: true` — this account's `liquidationValue` is Schwab's start-of-day figure and does not move intraday. This run fires mid-session, so the difference mixes unsettled funds with the day's P&L. Do NOT quote it as the amount still settling; describe it as a start-of-day baseline against live positions.
  - `staleLiquidationValue: false` — an incoming transfer has not settled yet. Transfers take about 5 business days; until they clear, positions and cash already reflect the funds while `liquidationValue` lags them.
  - Either way: positions + cash is the correct portfolio value. Say so plainly in the `summary` field with the three numbers, and note that `cashBalance` is therefore not a reliable measure of buying power today. Do NOT call it margin, leverage, or borrowing, and do NOT frame it as an unexplained discrepancy for the approver to diagnose. Do not block the proposal on this — it is a note for the approver, not a guard.
- Submit: `WORKER_URL=http://localhost:8788 node /Users/Billy/git/schwab-mcp/cli/schwab-propose.mjs /tmp/drift-proposal.json`
- On success: report the proposalId and STOP. The worker posts the Approve/Reject Slack message; a human decides. Never poll for the outcome, never resubmit a superseded or rejected proposal. If the CLI reports that prior pending proposal(s) were superseded, name them in your output — their Slack buttons are now dead.
- On any error: report the server's response verbatim and STOP. Never retry automatically, and never restructure orders to get past a guardrail (symbol allowlist, notional cap, daily cap, coverage) — those limits are the point. A 403 naming a coverage failure in particular means the shares backing a short call are gone; it is a correct refusal, not a formatting problem.

FAILURE REPORTING — a lost window must never be quiet. If ANY step fails for a
reason that is not a deliberate guard (the STEP 2 session guard and the STEP 3/3B
"nothing qualifies" exit are the deliberate ones), treat it as a LOUD failure:
begin your output with `PROPOSAL FAILED —` and state which step broke, the
verbatim error, and whether a proposal was created. This covers tool/permission
errors writing /tmp/drift-proposal.json, a worker that is not running, and a
non-2xx from the CLI. These are the cases where the run silently does nothing
while a real gap goes unproposed — they must be visibly distinguishable from
the benign "nothing to do" outcomes. Still do not retry, and still do not
restructure orders to get past a guardrail.

Note: the worker also enforces the session guard server-side — `/proposals`
returns HTTP 409 with `marketSession` when the equity market is not in its
REGULAR session, before anything is previewed, stored, or posted to Slack. That
is a backstop, not a substitute for STEP 2: stop at STEP 2 rather than
submitting and letting the server refuse. The worker likewise re-runs the
option coverage check at proposal time, at approval time, and again at
placement — also backstops, not substitutes for STEP 3B.

OUTPUT: a short summary — the market session, which equity gaps qualified, which option rolls qualified, any equity symbols excluded for a non-Normal quote status, any option divergence that was report-only with its reasons, and the proposalId if one was created (or the reason none was).

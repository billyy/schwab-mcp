---
name: crt-partnership-drift
description: Pre-market (7am ET) CRT vs Partnership divergence report to Slack. Report-only — orders are proposed by crt-partnership-rebalance-propose after the open.
---

Compare the Partnership account against the CRT benchmark account and post a divergence report to Slack. Everything runs through the local schwab-mcp worker at http://localhost:8788 (a wrangler dev server that must already be running on this Mac).

**CRT is the reference account — it is immutable. All rebalancing actions apply to the Partnership account only.**

**THIS RUN IS REPORT-ONLY.** It fires at 7:00am ET, before the regular session opens. Pre-market bid/ask is the thin extended-hours book and is not a valid basis for a limit price, so this task NEVER builds orders and NEVER calls schwab-propose.mjs. A companion scheduled task, `crt-partnership-rebalance-propose`, re-runs the diff after the open (10:00am ET) with live quotes and submits any warranted proposal for human approval.

STEP 1 — Run the divergence analysis with EXACTLY this command, unchanged (a
fixed, byte-identical command string is what lets it be allowlisted; do NOT add
redirects, pipes, `cd`, or `echo`, and do NOT re-derive the analysis with an
ad-hoc python/node heredoc — that is what made this task prompt on every run):
```bash
node cli/drift-diff.mjs
```
- It fetches the snapshot itself (worker at http://localhost:8788, key from the Keychain) and prints every section you need: balances with reconciliation, equity quantity gaps with notionals and a proposable/below-threshold tag, option divergences, Partnership coverage, and Partnership-only cleanup positions. Add `--json` only if you need the raw numbers.
- Partnership = account 13102970 (display "Partnership ...970"); CRT = 80745838 ("CRT ...838").
- **Pricing:** the script picks the basis and prints it. Pre-market it uses the prior regular-session `close` and never `bid`/`ask` (the thin extended-hours book is not a valid basis); in a REGULAR session it uses live `last`. Report whichever basis it printed — do not assert "prior close" if it ran during the session.
- If the command fails or returns an error, report it verbatim and STOP. Do not retry, do not fall back to raw curl or to any other data source.

STEP 2 — Read the script's output (CRT is the benchmark). It has already applied these rules, so your job is to interpret and phrase, not recompute:
- Quantity differences on the same ticker (Partnership vs CRT).
- Different option strikes or expirations on the same underlying (OPTION symbols encode underlying/expiry/strike, e.g. "FAST  260821C00050000" = FAST 2026-08-21 call 50).
- Coverage mismatches (shares not fully covered by short calls, or vice versa).
- Positions in CRT missing or underweight in Partnership, and positions in Partnership absent from CRT (potential cleanup).
- Do NOT flag cost basis differences.
- **Balance reconciliation.** The script reports, per account, whether summed position `marketValue` plus `cashBalance` equals `liquidationValue`, and prints a NOTE when that account's `liquidationValue` is start-of-day. Read the NOTE before writing anything:
  - **If the script printed the start-of-day NOTE** (Partnership normally does), the difference is NOT a clean settlement figure — it mixes unsettled funds with the day's P&L, because positions revalue all session against a frozen baseline. Say that. Do not quote the difference as "the amount still settling", and do not compare it to a prior *intraday* figure; only same-time-of-day comparisons mean anything. Pre-market (the normal 7:03am ET slot) the distortion is small, since positions have barely moved off the prior close — but say which case you are in rather than assuming.
  - **Otherwise** the difference is an incoming transfer that has not settled: transfers take about **5 business days**, and until they clear, positions and cash already reflect the funds while `liquidationValue` lags them. Report it plainly as unsettled funds clearing over the next few business days, and say whether it is shrinking day-over-day.
  - In both cases: **positions + cash is the correct portfolio value.** Do NOT escalate it as an alarm, a discrepancy, or an open question for the approver to diagnose; that framing was used on 2026-08-06 and 08-07 and was wrong both times. Do NOT say or imply "margin", "leverage", "borrowed", or "on margin" — that remains flatly incorrect. And `cashBalance` alone is not a reliable basis for sizing a new buy while a transfer is still in flight.
- **The headline Gap.** If the script prints the not-like-for-like WARNING, the two accounts' `liquidationValue` figures come from different blocks (one start-of-day, one live) and the gap partly measures staleness rather than divergence. Either report the gap between positions + cash for each account instead, or state the caveat right next to the number. Never headline a mid-session gap as if it were pure divergence.

STEP 3 — Post ONLY the Divergence Flags & Rebalancing Notes to Slack via the worker (never use any other Slack mechanism):
- Author the payload as Slack Block Kit so the report renders visually. Write it to /tmp/drift-slack.json as ONE JSON object: `{ "text": "<mrkdwn fallback>", "blocks": [ ... ] }`.
  - `text` is REQUIRED: the full report as Slack mrkdwn (*bold*, • bullets), ≤12000 chars. It is the notification preview and the automatic fallback if Slack rejects the blocks — it must carry the complete report on its own.
  - `blocks`: ≤50 blocks; every section ≤3000 chars; ≤10 fields per section. Build exactly this structure:
    1. Header: `{"type":"header","text":{"type":"plain_text","emoji":true,"text":"🚨 CRT vs Partnership drift — <YYYY-MM-DD>"}}`
    2. Account summary as label/value tiles: `{"type":"section","fields":[{"type":"mrkdwn","text":"*Partnership ...970*\n$<liquidation> · cash $<cash>"},{"type":"mrkdwn","text":"*CRT ...838 (benchmark)*\n$<liquidation> · cash $<cash>"},{"type":"mrkdwn","text":"*Gap*\n<Partnership minus CRT, signed, with a one-phrase attribution>"},{"type":"mrkdwn","text":"*Flags today*\n<count> divergence(s)"}]}`
    3. `{"type":"divider"}`
    4. One section per non-empty divergence category, in this order: quantity gaps, option strike/expiry differences, coverage mismatches, cleanup (Partnership-only positions). Each section's mrkdwn: a bold numbered title line (e.g. `*1. Quantity gaps — positions in CRT missing from Partnership*`) followed by `•` bullets. Frame every note as a Partnership action ("Partnership needs to add X", "Partnership should close Y"). No full side-by-side position tables.
    5. An unsettled-transfer balance is NOT a warning — it is routine. Give it a plain section (no `⚠️`, no alarm language), titled e.g. `*Partnership — funds still settling*`, stating that positions + cash is the accurate value, the arithmetic, and that the gap clears in ~5 business days. Never name margin, leverage, or borrowing. Reserve `⚠️` and its own dedicated section for something the approver genuinely must act on before approving — an uncovered short call, a failed price basis, an unexplained position change — and never bury one of those inside a bullet list. If nothing qualifies, there is no `⚠️` section that day.
    6. Rebalancing notes as a normal section: which equity gaps clear the $1,000 threshold and will therefore be proposed by the post-open task, and what is report-only (all option divergences). Say explicitly that no orders have been submitted by this run and that the Approve/Reject message will arrive after the open.
    7. Last block — standing-policy footnote as small print: `{"type":"context","elements":[{"type":"mrkdwn","text":"<pricing basis as printed by STEP 1> · option divergences are report-only · CRT is immutable"}]}` — the first clause is normally `Pre-market run — prices are the prior regular-session close`, but if the task fired late and the script priced off live quotes, say that instead. Never claim a basis the script did not use.
  - If there are no divergences, still post: the header block, one all-clear section, and the context footnote.
- Then post it with EXACTLY this command, unchanged (a fixed, byte-identical command string is what
  lets it be allowlisted; do NOT inline the report via a heredoc or --data @-, which cannot be):
```bash
KEY=$(security find-generic-password -s schwab-mcp-order -a api-key -w) && curl -sS -X POST http://localhost:8788/slack/notify -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" --data @/tmp/drift-slack.json
```
- If the response contains `"degraded": "invalid_blocks"`, the plain-text fallback was posted instead — say so in your output summary so the block template can be fixed.

STEP 4 — None. Do not build orders, do not write /tmp/drift-proposal.json, do not run schwab-propose.mjs. Sizing candidates for the post-open task is a reporting exercise only.

OUTPUT: a short summary — divergence count, whether the report was posted (and whether it degraded to plain text), and which equity gaps are expected to be proposed after the open.
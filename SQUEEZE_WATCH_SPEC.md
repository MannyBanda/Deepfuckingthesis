# SQUEEZE_WATCH_SPEC.md — v1.3 (band grace + suspend/resume, shipped 2026-08-04; v1.2 shipped 2026-07-23)

**Purpose:** stalk the trailer's live price on every pushed sweet-spot row; push a plain-English
alert when the best book crosses a cell-aware threshold. Alerts are eyes, never directives.

## Architecture
- `odds-squeeze.mjs` — isolated module, direct Neon + direct external APIs (no internal HTTP).
  Timeout 60s. Double-sample per invocation (t=0, sleep 30s, t=30) → true 30s cadence.
  Cycle lock via job_locks ('odds_squeeze', 50s stale window).
- Zero poll-live-bdl changes: **auto-arm is a scan inside this module**, not a fire-site hook —
  arms pushed tiers (EFG_FADE / EFG_FADE_SOFT / B1-B3 / WATCHLIST, ntfy_sent, unresolved,
  <3h old). Ledger-only + GAME_BRIEF rows never arm. Max ONE watch per game (newest wins).
- Scheduling: commit 2 (post-validation). Until then HTTP-invocable: `/odds-squeeze?dry=1|test=1`.

## Gates (per sample, in order)
1. ESPN scoreboard state (free, ~10s fresh): final→disarm; Q4 ≤2:00→disarm; pregame→skip.
2. **Clock gate:** frozen clock (timeout/halftime) → skip odds pull, EXCEPT one catch-up pull
   on period increment (books repost during breaks). Clock advancing → full 30s cadence,
   no score-event gating (PM decision Jul 23: possession-length latency, never bundle events).
3. Band (v1.3): deficit outside 1–9 → strike. Strikes 1–2 GRACE-EVAL price when deficit
   is 0 (tie) or 10–11 (band+2 collar); deficit <0 or ≥12 strikes without eval. 3 consecutive
   strikes → SUSPEND (not terminal); band re-entry → RESUME same pass. See v1.3 section.
4. Price: best-of-roster implied ≤ threshold implied → alert (re-arm needs ≥.035 implied drop,
   ≈25¢; max 6 alerts per arm; TTL 3h).

## Thresholds (defaults; per-arm override via db-api arm_squeeze)
- Killer cell (B/WATCHLIST only): **-150** — policy (PM Jul 22), implied 60% vs cell 67% [PRIOR n=45].
  Tier trumps killer: an A-tier takes -200 whether the leader is killer-flagged or not (PM Jul 28).
- Non-killer B/WATCHLIST: **+117** — derived, pre-registered 46% breakeven [PRIOR].
- Non-killer A-tier (EFG_FADE): **-200** — policy (PM Jul 28), implied 66.7% vs the .70
  anchor's -233 breakeven. Supersedes the same-day dynamic mode (row p − 5pp): row-level p
  is provably shy (+12pp GAP_BASE, +9pp WATCHLIST, both sub-power n) and produced thresholds
  below the review tiers on the system's highest-confidence cell. Threshold is attention
  routing only — zero interaction with graduation, which gates sizing escalation via logged
  predictions vs outcomes at n=30. Alerts are eyes; the breakeven check decides.

## Best-price routing
Roster: williamhill_us (Caesars), espnbet, fanduel, betrivers, hardrockbet, draftkings.
(bet365 + Fanatics not carried by The Odds API for US WNBA — manual cross-check books.)
One odds call covers all armed games (2 credits: us,us2 × h2h). includeLinks=true;
ntfy Click = outcome/market/bookmaker API link, else pinned BOOK_LINKS universal link.
**Caesars = default** on ties/failures.

## Alert copy
Pinned in `research/2026-07-23_squeeze_fixtures.mjs` (24 cases, all passing). Shape:
title `JUICE: {TRAILER} {price} ({Book})` (brand word, PM Jul 28; module/schema keep 'squeeze'); body = implied-vs-cell cushion, deficit/clock,
leader eFG/band/var-share, trailer own eFG + capacity read, top-3 shop line, cap line,
"Your read - not a directive." NULL-degrades on stale (>90s) snapshots. ASCII titles.

## Data
- Every live sample → odds_history (game_id, home_ml, away_ml, source='squeeze:{book}') —
  30s multi-book price tape; feeds prod price-pairing gap + book-quality research
  (e.g. "does Caesars price trailing favorites best" — PM hypothesis, now measurable).
- sweetspot_alerts += squeeze_armed/threshold/last_alert_price/alert_count/expires_at/state.
  Written only by squeeze/arm paths; never read on poll hot path; get_ss_state untouched.


## v1.3 — Band grace + suspend/resume (PM-approved Aug 4, incident row 1148)

**Incident:** A-tier watch armed at fire (TOR@GS, def 9, +100); lead extended past 9 within
seconds; three oob samples killed the watch ~90s after arming — the oob check preceded the
odds fetch, so zero prices were ever evaluated and zero tape rows written. Disarm was terminal
(autoArm requires squeeze_armed IS NULL). The night's price peak (+110 books) occurred DURING
the oob strikes; the Q3 band re-entry was invisible. Manual shop beat the machine.

**State machine:** ARMED ⇄ SUSPENDED. Suspension = `squeeze_state.suspended=true` with
`squeeze_armed` staying TRUE (loadWatches still selects; autoArm contract untouched; zero
schema change on sweetspot_alerts). Terminal disarms unchanged: final, q4-2:00, max-alerts,
ttl, superseded, manual db-api. `bandStep(prevState, deficit)` is the pure decision function —
golden fixtures incl. row-1148 replay in research/2026-07-23_squeeze_fixtures.mjs.

**Rules:**
- Grace (strikes 1–2): full price pipeline runs at deficit 0 or 10–11. Tie grace is the
  market's neutral-WP read (PM Aug 4: juice persists at ties; deficit=0 tape = implied
  quality-gap measurement). deficit <0 = trailer leads, entry juice dead: strike, no eval.
- Copy: grace samples tagged "(out of band - grace read)"; ties read "{trailer} tied it";
  first alert after a resume carries "Back in band since Q{p} {clock}." (breadcrumb persists
  in state until it rides an alert). Fixture-pinned.
- Suspend (3rd consecutive oob): state saved (fixes v1.2's silent third-strike state loss),
  ESPN-only sampling, no odds calls/credits, no alerts. Resume on deficit 1–9: oob=0,
  falls through to price eval in the same pass.
- Unchanged across suspend cycles: alert 6-cap, rearm spacing, thresholds, TTL (no extension),
  clock-frozen guard, one-watch-per-game supersede. No cycle cap — bounded by TTL/q4-2:00/6-cap.

**§4a tape stamp:** squeeze tape writes now stamp `deficit` (odds_history ADD COLUMN,
?action=init). Tape doubles as a price-by-deficit dataset; deficit=0 rows are neutral-WP
reads feeding honest-gap work and the WNBA E4-class price test.

## Flags & failure modes
`WNBA_SQUEEZE_ON=0` kills module; `WNBA_SQUEEZE_AUTOARM=0` reverts to manual arm
(db-api arm_squeeze / disarm_squeeze). Odds/ESPN failures: logged skip, never throw.
Consciously accepted exception: squeeze alerts bypass the reasoning agent (mechanical
price+state readout, zero narrative claims).

## Rollout
1. ✅ Commit 1: module + db-api actions/columns + fixtures, HTTP-only.
2. Validation: `?test=1` real-odds/real-link alert (Caesars link preferred); `?dry=1` gate audit.
3. Commit 2: schedule hookup (match poll-live-bdl's mechanism) — target before Jul 28 slate.
4. Live dry-run on Jul 28; flag-on after tape review.

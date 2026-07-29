# SQUEEZE_WATCH_SPEC.md — v1.2 (shipped 2026-07-23)

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
3. Band: deficit (leader−trailer via ESPN) outside 1–9 → strike; 3 consecutive strikes → disarm.
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
title `SQUEEZE: {TRAILER} {price} ({Book})`; body = implied-vs-cell cushion, deficit/clock,
leader eFG/band/var-share, trailer own eFG + capacity read, top-3 shop line, cap line,
"Your read - not a directive." NULL-degrades on stale (>90s) snapshots. ASCII titles.

## Data
- Every live sample → odds_history (game_id, home_ml, away_ml, source='squeeze:{book}') —
  30s multi-book price tape; feeds prod price-pairing gap + book-quality research
  (e.g. "does Caesars price trailing favorites best" — PM hypothesis, now measurable).
- sweetspot_alerts += squeeze_armed/threshold/last_alert_price/alert_count/expires_at/state.
  Written only by squeeze/arm paths; never read on poll hot path; get_ss_state untouched.

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

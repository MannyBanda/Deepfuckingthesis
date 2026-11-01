# NBA SWEET SPOT PORT — Spec v1

**Date:** 2026-10-31 · **PM direction:** "put the WNBA Sweet Spot engine in place for the NBA — we just won't have an A-rank selector yet, because eFG% doesn't detonate the same way in the NBA (unless this research becomes it)." · **Owner:** Claude · **Status:** SPEC — nothing built.

**Goal:** run the Sweet Spot engine's *skeleton* on the NBA — quality-gap gates, deficit/time windows, ledger streams (GAP_BASE, WATCHLIST), snapshot `ss_*` columns, verdict strip — with the **A-tier selector slot empty and pluggable**, zero Opus by default, and every NBA row riding the dark-log path while `NBA_PAUSED=1`. The slot is filled only by a passed prereg (first candidate: `research/2026-10-31_paint_touch_PREREG.md`).

**Non-goals (v1):** no NBA A-tier, no B-tier, no narration, no JUICE squeeze, no killer/lane/elite tiers, no sizing. No change to WNBA behavior — byte-identical, fixture-pinned.

---

## 1. What the locked NBA research forces into this design
- **Quality gap alone is priced** (Oct 19, market-honest study): the NBA A-gate shape is accurate with no edge. → NBA GAP_BASE is a **ledger, never a push**. The engine's value in the NBA is the forward log it builds, not the alerts it sends.
- **eFG-heat is a null in the NBA** (deficit-controlled, n≈1,200; ruled-out list). → the WNBA divergence gate (eFG band × variance share — the A-tier "fade") is **disabled for NBA by config**, not ported with different thresholds.
- **Canary family closed** at both moments (Oct 23, Oct 31). → windowed-MC entries are not a selector candidate.
- **Price stamps are a live/pregame mix** (Oct 23 §8, Oct 31 audit §8a). → no price gate, no edge column, no Kelly on NBA rows until §4.3 ships. Rows carry `line_used` as *observed*, flagged `price_stale` when §4.3 says so.
- **Accuracy ≠ edge** is the standing NBA rule → every NBA ledger read reports edge vs a fair proxy, never raw conversion.

## 2. Architecture decision — league-parameterize in place
The engine is 26 `ss*` functions inline in `poll-live-bdl.mjs` with ~110 `'wnba'` gates across poll, `team-profiles-nightly` (v1 WNBA-only), `odds-squeeze` (`LEAGUE='wnba'`), `post-game-agent` (SS resolver `if (league !== 'wnba') return null`), and `db-api`. Netlify bundles per function, so extraction to a shared module is not available (hotfix #7); mirrored logic stays under source-equality fixtures.

**Option A — parameterize in place (recommended):** add `LEAGUES[league].ss` config; replace each engine-internal `league === 'wnba'` with `ssEnabled(league)` / `cfg.ss.<gate>`; thread `league` where the engine assumed WNBA. Each phase ships with a **WNBA-parity fixture**: the engine's outputs on the committed WNBA fixture states must be byte-identical before and after (the `SS_STRUCT`/`aliasMap` lesson).
**Option B — clone the engine for NBA:** faster to first row, permanent drift risk, two copies of 26 functions. Rejected.
**Option C — wait for the selector:** no forward log accrues; rejected by the PM's direction.

## 3. Config (the only place NBA thresholds live)
```js
// LEAGUES[league].ss — SS engine per league. WNBA block = today's constants moved, values unchanged (fixture-pinned).
nba: { ss: {
  enabled: true,
  gapMin: 0.15,            // qualifying quality gap (trailer win% − leader win%) — WNBA value as placeholder; NBA SS_STRUCT (Phase 2) re-pins
  deficitBand: [1, 9],     // Phase 2 may narrow to 1–6 from the NBA fine arena staircase
  timeWindow: 'preQ4',     // Q1–Q3 eligible; Q4 log-only
  leaderWpMax: null,       // "beatable leader" cut — NBA value from Phase 2, null = off
  divergenceGate: false,   // eFG-heat A-selector: OFF (null in NBA)
  selectorA: null,         // pluggable: name of a fixture-pinned pure function (trailer, leader, state) → {fire:boolean, tag} — filled only by a passed prereg
  tiers: { A: false, B: false, WATCHLIST: true, GAP_BASE: true },
  priceGate: null,         // no price gates until the stale-quote filter ships
  narration: false, squeeze: false, repush: false, gameBrief: false,
} }
```
WNBA's `ss` block carries today's values verbatim; a fixture asserts the block equals the pre-port constants.

## 4. Phases (each phase: spec → fixtures → build → WNBA parity green → ship dark)

### Phase 1 — gates compute + snapshot columns (store-only)
- `ssStandings` for NBA via `fetchStandingsCache(sql, 'nba')` (already league-parameterized at the call site; verify the cache shape for NBA).
- The gate compute that today runs under `league === 'wnba' && !WNBA_SS_COMPUTE_OFF` runs under `LEAGUES[league].ss?.enabled && !ssComputeOff(league)` (new `NBA_SS_COMPUTE_OFF` env, same pattern).
- `ss_*` snapshot columns written for NBA exactly as for WNBA (`ss_quality_gap`, `ss_leader_wp`, `ss_trailer_wp`, `ss_lead_class`, `ss_leader_efg` …); `ss_alert_fired` stays false. Fade/collapse tiers compute but cannot fire (tiers.A/B false).
- **Verdict strip stays WNBA-only this phase.** No rows, no pushes. ~60 lines.

### Phase 2 — NBA SS_STRUCT + GAP_BASE ledger (prereg'd)
- Build NBA structural cells from the fine arenas (2025-26 + 2024-25 once Amendment 1 lands): gap staircase × deficit band × time bucket, trailer-WIN and lead-HOLD, with the margin×time fair proxy alongside — the WNBA `build_ss_struct` recipe, NBA numbers, committed and byte-equality-pinned. **Prereg first** (cells, bars for "qualifying" and "strong" gap tiers, both-seasons rule now that two seasons exist).
- `gapMin` / `deficitBand` / `leaderWpMax` re-pinned from the committed cells (the July backtest's 22 → 38 → 58 staircase is the prior).
- GAP_BASE rows written for NBA (`sweetspot_alerts.league='nba'`, `ledgerOnly`), no push, dedup per league. `post-game-agent` SS resolver extended from WNBA-only to `LEAGUES[league].ss?.enabled`; `ss_ledger_summary&league=nba` verified. ~120 lines + the build script.

### Phase 3 — WATCHLIST review cue + dashboard
- WATCHLIST rows for NBA (band entry, qualifying gap, pre-Q4) → under `NBA_PAUSED` these are `PAUSED_LOG` dark-log rows; when unpaused, a priority-2 push with `Live price: {trailer} {ML} at {book}` and a `price_stale` flag (§4.3). No narration (`narration:false`).
- `bdl.html` gains the verdict strip (`get_ss_state&league=nba`, `ssVerdictCompose` V0–V8 chain unchanged, NBA `SS_STRUCT` mirror under the same byte-equality contract). Parity fixtures extended with `league` as a parameter. ~400 lines, mostly client.

### Phase 4 — the A-selector slot
- `selectorA` is a pure function with golden fixtures, evaluated at the WNBA A-tier call site when `tiers.A` is true. **It is filled only by a prereg that passed on a fresh instrument and replicated forward (price-joined n ≥ 20).** First candidate: MC-favored trailer × paint ≥ +2 × deficit 1–6 → TOUCH (`2026-10-31_paint_touch_PREREG.md`). Until then the slot is `null` and the NBA engine has no A-tier — by design, not by omission.

### 4.3 Prerequisite, any phase that shows a price — NBA stale-quote filter (own mini-spec)
In `fetchOddsAPIBatch` consumers: stamp `price_stale = true` when the stamped line's implied probability for the leader is more than 25pp below ESPN WP for the leader at the same poll, **or** the bookmaker's `last_update` predates the game's tip. Stale rows keep the line (observed) but every edge/implied/Kelly field is null and copy says "line may be pregame". Fixture: the 10 POSITION_OPEN rows from the audit (POR +136 up 26, etc.) must flag; a −568 on a 9-point lead must not. ~40 lines, ships before Phase 3's push copy.

## 5. Cascading implications (traced)
- **Dedup keys** are `(game_id, alert_subtype)` — unique per game already; league rides on the row. No collision.
- **`sweetspot_alerts` / `ss_ledger_summary` / `get_sweetspot_alerts`** take `&league=`; `league='nba'` rows are new data, not a schema change. Era note: the first NBA WATCHLIST rows are a new population — stream reads split by league always.
- **`post-game-agent`**: the SS resolver sweep extends by config; the WNBA digest copy is untouched; the NBA nightly (paused) scores dark rows mechanically as today.
- **`team-profiles-nightly`** stays WNBA-only in v1 → NBA rows carry no killer/lane/tiers_elite stamps (NULL-degrading fields already tolerate this). Elite/killer for the NBA is its own study, not a port.
- **`odds-squeeze`** stays WNBA-only (`squeeze:false`).
- **Narration** off for NBA: `ssNarrationSweep` iterates only `narration:true` leagues; `ssSeedPregameBriefs` likewise. Zero Opus added by this port.
- **`NBA_PAUSED`**: every NBA SS row is written through the same `PAUSED_LOG`/`ntfy_sent=false` convention; the dark log and the SS ledger are one tape.
- **Season consolidation** (branch `season-consolidation`, unmerged): the port reads `LEAGUES[league].season` through whatever that branch lands — Phase 1 touches none of the season literals; rebase is trivial either way.
- **Dead code:** none created; the WNBA constants that move into `LEAGUES.wnba.ss` are deleted at their old sites in the same commit (grep gate).

## 6. Fixtures (ship with each phase, all must be green to push)
Existing: tier B/C 81, parity 30, narration 67, ops 35, decision support 124, squeeze 77, season26 35, verdict 42, availability 35, fine arena 19, matchup 36. New: `ss_league_param_fixtures` — the engine's full output on the committed WNBA fixture states before/after the port (byte-equal); `ss_nba_config_fixtures` — NBA block disables divergence, A, B; `ss_struct_nba` byte-equality (Phase 2); `stale_quote_fixtures` (§4.3).

## 7. Order of operations
1. Amendment 1 build → paint/TOUCH prereg Phase 0a/0b/1 (research track, no production code).
2. Port Phase 1 (dark, store-only) → Phase 2 prereg + NBA SS_STRUCT → GAP_BASE ledger.
3. §4.3 stale-quote filter → Phase 3 WATCHLIST + strip.
4. Phase 4 only when a selector has passed and replicated.
Each step is its own go.

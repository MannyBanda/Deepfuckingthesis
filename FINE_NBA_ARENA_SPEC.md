# FINE NBA ARENA — Spec v1

**Date:** 2026-10-23 · **PM go:** "Build A first, let's do this right" (chat) · **Owner:** Claude
**Purpose:** a production-matched structural instrument for the NBA, the direct analog of the WNBA fine arena (Aug 11). Motivating study: `research/2026-10-23_canary_turnover_fuel_PREREG.md` — the 3-minute checkpoint grid classifies CLEAN ≥9 game-minutes after trigger, by which point the control team is already trailing/tied in 117/171 fires; production classifies at ~26s grain and pushed CLE@PHI 4:11 after trigger with the lead still +13.

## 1. What is built

### 1.1 Walker: additive schedule parameter (`backtest-nba-snapshots.mjs`)
`walkAndSnapshot(plays, hA, aA, schedule = CHECKPOINTS, opts = {})`. The two internal references to `CHECKPOINTS` become `schedule`. **Default call is byte-identical** — regression gate §3.
`buildFineSchedule(grainSec)` → every `grainSec` from 12:00 down to 0:00 for periods 1-4 (grain 30 → 25 marks/period, 100/game; labels `Q3_06:30`, `Q3_END`).
`opts.fine === true` adds four keys to `pbp_derived` — `hTOf, hTOu, aTOf, aTOu` (forced / unforced turnovers) — classified by a **verbatim mirror of production `bdlClassifyTOS`** (steal in text or bad pass → forced; traveling / out of bounds / 3-second / shot clock / offensive foul / double dribble / backcourt / kicked ball → unforced; else unknown, counted in neither). Keys are emitted only in fine mode so the default output is unchanged.

### 1.2 Phase: `?phase=export_fine&grain=30&n=16&c=8&offset=0`
Read-only. Selects games from `nba_backtest` (`team_stats IS NOT NULL AND game_type='regular'`, **`ORDER BY date ASC, bdl_game_id ASC`** — stable pagination), fetches BDL plays with the existing `bdlFetchAllPlays`, walks with the fine schedule, and returns per game: `{gid, date, home, away, winner, final_margin, plays, states:[{l, p, c, h:{pts,fgm,fga,fg3m,fg3a,ftm,fta,ast,to,stl,blk,oreb}, a:{…}, pd:{hPaint,aPaint,hRimM,hRimA,aRimM,aRimA,hBigLead,aBigLead,hPOT,aPOT,hTOf,hTOu,aTOf,aTOu,r6h,r6a}, floor, ctrl}]}`. `floor`/`ctrl` come from the walker's existing `computeServer` (same I1-I5 composite the coarse arena's `indicators` carry). `grain=0` selects the legacy `CHECKPOINTS` schedule (regression mode). No DB writes.
Budget: time-boxed to 85s with `nextStep`; the sandbox drives it at n=16, c=8 under the 40s gateway.

### 1.3 Committed artifact
`research/2026-10-23_fine_nba_states.json.gz` — all games, all states. Expected ≈123k states, ≈5 MB gz. Regenerable by replaying the phase (BDL plays are the source; no RNG in the walk).

### 1.4 Replay builder: `research/fine_nba_canary_replay.mjs` (sandbox, Node)
Loads the states file and **slices production functions from the repo at runtime by name** — `runMonteCarloSim`, `diffToRatesMC`, `estimateRemainingPossMC`, `classifyMCVerdict`, `classifyMCPattern` from `poll-live-bdl.mjs` — so equality with production is by construction, not by copy. Seeded `Math.random` (mulberry32, seed 20261023 + gid).
Production-shaped state machine per game, state by state:
- **Eligibility:** period ≥ 2, remaining game-minutes ≥ 1.0, `ctrl` present, ctrl margin ≥ 0.
- **Canary window:** the latest earlier state at which the combined possession diff (home + away, est. FGA + .44·FTA − OREB + TO) reaches ≥ 20 — production's `extractMCRatesFromPossLog(possLog, 20)` is 20 possessions *total*. Rates via `diffToRatesMC`; require window FGA ≥ 5 per side (production gate).
- **Trigger:** MC < .70 (absolute) OR floor − MC > .15 (divergence); XGB-drop trigger not reproducible (no XGB at fine grain — disclosed; coarse export shows 165/171 CLEANs triggered absolute). **Margin-compression gate:** peak ctrl margin over the last 10 states (≈5 min) − current ≥ 3. **Tracked-team gate** (`bwc_fired`/`buy_position`) not reproducible — disclosed, same as the coarse export.
- **Investigation:** post-trigger box diff from `trigger_stats`; `postFGA` = both teams' FGA since trigger; verdict (`classifyMCVerdict`) when postFGA ≥ 8 **and** postFGA > `last_verdict_fga` (production stale-data guard); `INV` when postFGA < 8 and increased. 1,000 sims (production).
- **Pattern:** `classifyMCPattern` after every push. CLEAN / WAVE → terminal for the game (production never resets a terminal pattern). NORMALIZED / FALSE_ALARM → reset, `prior_investigations++`, re-trigger allowed (production behavior).
- **Output:** one row per investigation: trigger state (label, idx, margin, floor, MC, reason, both teams' stats incl. POT/forced/unforced), verdict path with per-state stats and margin, pattern, push state (first CLEAN/WAVE) with stats and margin, `prior_investigations`, outcome (`winner`, `final_margin`). Plus `base_rates`: leader-holds by (period, 2-minute bucket, leader-margin bucket) over all fine states — the fair-line proxy at fine grain.

## 2. Cascading implications
- `walkAndSnapshot` is called by `phaseSnapshot` only (`walkAndSnapshot(plays, hA, aA)`); the default parameters keep that call byte-identical. No other consumer.
- `computeServer` is pure and already exported nowhere; reused in-process. No DB schema change. No production function touched (`poll-live-bdl.mjs` is read, not written).
- BDL calls: ≈1,235 games × 1-3 pages ≈ 2.5-3.7k requests on the GOAT key, same endpoint the coarse arena used. Spread over ~80 sandbox-driven calls.
- Dead code: none introduced; `phaseSnapshot` untouched.

## 3. Regression gate (must pass before any fine export is trusted)
`export_fine&grain=0` on 60 games (840 checkpoint rows) → `team_stats` and `pbp_derived` (less the four fine-only keys, which are not emitted in that mode) must equal `nba_snapshot_backtest` rows **exactly**. Any mismatch is investigated before proceeding; a BDL data-drift mismatch (plays re-edited upstream) is reported separately from a walker defect.

## 4. Verification
- `node -c` on the function.
- Regression gate §3, 840/840.
- Source-equality: `bdlClassifyTOS` mirror byte-equal to production; builder's runtime slices confirmed present and callable; `classifyMCPattern` fixtures 8/8 (incl. CLE@PHI `INV×4→CONF×2→CLEAN`).
- Spot check: CLE@PHI is not in the backtest (2026-27), so the fidelity spot check is a 2025-26 game where production fired for real (`alerts.alert_type='MC_COLLAPSE'`, date ≥ 2026-03-17): the fine replay's trigger and push labels must land within one state of the production timestamps.

## 5. What this does NOT change
No alerts, no gates, no prompt text, no sizing. The canary × turnover-fuel prereg's bars and features are untouched; Amendment 2 (instrument swap: fine arena becomes Instrument A, the coarse export stays committed as the record) is written after the gate passes and before Phase 1.

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

---

## AMENDMENT 1 (2026-10-31) — second season: 2024-25 arena

**Why:** the 2025-26 arena is contaminated for the MC-favored-trailer population (`research/2026-10-31_mc_trailer_buy_FINDINGS.md`, exploratory appendix `8e218ba`). `research/2026-10-31_paint_touch_PREREG.md` needs a season nobody has cut. Same walker, same grain, same integrity rule — only the game source changes.

### A1.1 Collector — `backtest-nba-playoffs.mjs` (two touch points)
- `SEASON` (line ~39, const 2025) becomes the **default** of a query param: `const season = parseInt(url.searchParams.get('season') || '2025')`, threaded into `collectSeason` → the BDL games URL (`seasons[]=${season}`, line ~626) and the `nba_backtest.season` column on insert (line ~680). `game_type` stays `'regular'` — the `season` column is the discriminator (it already exists in the schema).
- `boxscores`, `pbp`, `compute` phases select on null columns and need no change; they pick up 2024 rows on their next chunks. **Grep-confirm `SEASON` appears nowhere else before building** (two uses today).
- Default call (`?phase=collect_regular`) is byte-identical to today.

### A1.2 Export — `backtest-nba-snapshots.mjs` `export_fine`
- Additive `&season=` param on the `nba_backtest` selection and its COUNT. **When absent, filter `season = 2025`** — today the query has no season filter and the table holds only 2025, so this keeps the existing call byte-identical *after* 2024 rows land (an unfiltered default would silently merge seasons and break the regression gate).
- Pagination unchanged (`ORDER BY date ASC, bdl_game_id ASC`); HTTP chunks `n=16&c=8` from the sandbox as in the first build (the function is not scheduled, so hotfix #15 does not apply).

### A1.3 Committed artifact
`research/<date>_fine_nba_states_2024.json.gz` — same shape as the 2025-26 file (`{generated, spec, phase_sha, grain, games:[{gid,date,home,away,winner,final_margin,plays,states,walk}], walk_integrity_rule}`), plus `season: 2024`. **Halves split rule:** the date that divides walk-ok regular-season games into two equal halves; reported in Phase 0b of the prereg, never chosen.

### A1.4 Gates before the file is trusted
1. **Feasibility (Phase 0a):** BDL plays exist for 2024-25 — five spot games across Oct 2024 → Apr 2025 return > 400 plays each with the fields `bdlClassifyTOS` and the paint/rim accumulators read. If BDL's historical plays are thin or missing fields, STOP and report; the alternative instrument is the 2026-27 forward tape only.
2. **Regression:** `export_fine&season=2025&grain=30` on 60 games must reproduce the committed 2025-26 states for those games byte-for-byte (not just the `grain=0` checkpoint gate of §3 — the fine output itself).
3. **Walk integrity:** same rule; pass rate reported next to 2025-26's (1,221/1,235).
4. **Replay compatibility:** `research/2026-10-31_mc_trailer_buy_replay.mjs --states <2024 file>` runs unchanged; the paint fields the prereg needs are read from `pd` by the reader, so the replay gains only an additive `paint_gap` on the row.

### A1.5 Cost / time
~1,230 games × (1 games page share + 1 box + ~4–6 plays pages) ≈ 8–9k BDL calls at GOAT tier (600/min) — well under an hour of API time; the wall-clock is the chunked HTTP walk (the first build ran in sandbox chunks over a session). Zero Anthropic. No DB writes outside `nba_backtest` (new rows, `season=2024`).

### A1.6 Does not change
The 2025-26 file, the canary replay, any production path, any spec bar.

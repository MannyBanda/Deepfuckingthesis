# WNBA Data Layer v3 — Implementation Spec
**Date:** 2026-06-10
**Status:** SPEC — awaiting Manny's confirmation before any implementation
**Research basis:** research/2026-06-09_wnba_data_layer_and_spreads.md (commits 3af3426 -> 681b0de)
**Constraint:** BDL primary. SR: no live polling — schedule/pregame + quarter-boundary anchors only. ESPN fills continuous structural. Paid SR ($1,800) ruled out.

## Goals
1. Models stop consuming falsified PBP POT/SCP (validated -26% to -53% vs official).
2. Live structural stats (paint/POT/SCP/FBP/possessions) become honest: ESPN/PBP approximations anchored to official SR values at quarter boundaries, validated nightly against official BDL post-game truth.
3. WNBA XGB retrained on corrected features + per-team season priors; accepted/rejected against the line-paired OOS bar (edge test #1 standard).
4. Phantom boundary-snapshot bug class closed server-side.

## Non-goals
- No change to NBA paths (every change league-gated; aliasMap lesson applies).
- Backlog #2 (line as model feature) NOT folded in — separate test.
- No new alert types. No state machine changes.

---

## Phase 4a FIRST — Official backfill + adjudication (research-side, zero prod risk)
**Why first:** its output gates two later design decisions (live POT source; PBP-machine tolerance targets).

Build `research/backfill_wnba_official.py`:
- Pull `/wnba/v1/team_game_advanced_stats?game_ids[]=...` for all 2026 WNBA games (~90), batched, GOAT 600/min.
- Store to new table `wnba_official_stats`: bdl_game_id, team_abbr, is_home, misc JSONB (paint/pot/scp/fbp + opp_), advanced JSONB (poss/pace/pie/ratings), four_factors JSONB, scoring JSONB, fetched_at. PK (bdl_game_id, team_abbr). Migration via db-api `?action=init` (`CREATE TABLE IF NOT EXISTS`).
- Adjudication report (committed to research/):
  a. ESPN turnoverPoints (final snapshots' raw_stats_json) vs official POT — resolves the attribution question (ATL@CHI showed ESPN home pot=25 vs official 19/25 ambiguity)
  b. ESPN pointsInPaint / fastBreakPoints vs official — error distributions
  c. PBP-derived POT/SCP vs official across season — confirms undercount magnitude league-wide
  d. Possession estimator vs official possessions — calibration coefficient
**Output:** per-field verdict — ESPN direct / PBP machine / hybrid — with measured error bars. [FACT:prod-derived]

## Phase 0 — Boundary-stale guard (closes Jun 7 bug, server-side)
Observed live (Jun 9): BDL boundary sequence is `period=N, time='0.0'` (break) -> `period=N+1, time='10:00'` (parked, even after play resumed; ESPN already at 9:07). Phantom Q4 bug = early period flip with 0:00.

- New helper `isBoundaryStale(game, espnClock)`: true when `game.time` in {'0.0','10:00'} AND ESPN clock disagrees or is absent.
- Consumers:
  1. Snapshot save: suppress duplicate boundary snapshots (dedupe key period+clock already exists for transitions — extend to phantom flips). Max one boundary snapshot per transition.
  2. Quarter-clock-sensitive logic (XGB quarter gates, crunch gate, checkpoint labeler): while stale, hold previous period context until clock moves OR ESPN confirms new period.
  3. WP chart payload: tag snapshot `boundary: true` so client skips render-loop trigger (kills the band-aid debate: server-side fix, client gets clean data).
- Clock preference during stale window: ESPN clock (verified ≈SR, 0-4s).
- League-gated: WNBA first; NBA audit as follow-on (same quirk family suspected).

## Phase 1 — Model-path rewire (dual-write, no model behavior change yet)
Current (L7154-7182): `summary` = ESPN (display/indicators), `modelSummary` = `_srSummary` = BDL player aggregation; `_xgbSrc`/`_mcSrc` = modelSummary. ESPN structural fields parsed but model-invisible.

Change:
- New `buildModelSummaryWNBA(bdlPlayers, espnSummary, pbp, anchors)`:
  - Base box: BDL player aggregation (current behavior — counting stats verified identical to team_stats)
  - Structural overlay: paint/FBP/biggest_lead/POT from the Phase 4a-adjudicated source; SCP from PBP machine (Phase 2); possessions from estimator (Phase 4a-calibrated)
  - `pls_min` per player from BDL player_stats (currently fetched, dropped) -> enables I4 subB + bench for WNBA
  - Anchor correction applied when anchors exist (Phase 3)
- **Dual-write protection:** deployed XGB keeps consuming the OLD field values until Phase 6 retrain ships. New corrected values written to snapshots as parallel keys (`raw_stats_json.home.pot_v2` etc.) so the retrain trains on exactly what live will serve. Old/new swap is atomic with model swap.
- Snapshot provenance audit (pre-task): document per-field source of current raw_stats_json (ESPN vs PBP-merge at L7163) in code comments.

## Phase 2 — PBP possession-state machine (replaces regex POT/SCP)
Replace adjacent-event regex (L~1895 outputs, injected at L2395/L7163/L6214) with a possession tracker over BDL plays:
- State: possessing team, possession origin {steal/TO, OREB, normal}, points this possession.
- Credit ALL points in a possession to its origin tag: FG (via `score_value`/`scoring_play` fields — text-independent), FTs from fouls drawn in-possession, and-1s, putbacks (OREB chains both: pot persists, scp starts).
- Rules: possession ends on opponent gain (made FG -> opponent ball, DREB, TO, period end). Period end clears origin tags. OREB extends possession, sets/keeps SCP tag, preserves TO tag (a TO->miss->OREB->score counts both POT and SCP, matching official convention — verify against backfill).
- Outputs: pot/scp per team + true possession count (cross-check for estimator) + origin-tagged scoring log (future research substrate — backlog #4 adjacency).
- Acceptance vs Phase 4a ground truth (full-season replay through stored plays): proposed median |err| <= 2 pts, p90 <= 4 per stat per team. Tunable — Manny sets final tolerance.
- WNBA-only initially. NBA PBP keeps current path (aliasMap regression lesson: league-gate everything).

## Phase 3 — SR quarter-boundary anchors (anchor+delta)
Hook: existing transition block (~L9077, calibration capture).
- On WNBA period transition (Q1->Q2, half, Q3->Q4, +OT): one SR summary fetch (existing sr-data path, SR UUID = games.id). Retry once on transient (observed 1/7 failure). 1 req/s respected trivially.
- Store in `live_tracking.sr_anchors[Qn]`: {ts, per-team {paint,pot,scp,fbp,poss}, espn_at_anchor per-team same fields, sr_period_splits (native per-quarter fields -> quarter_data overlay)}.
- Apply in buildModelSummaryWNBA: `value = anchor + max(0, espn_now - espn_at_anchor)` (clamp: ESPN stat corrections can decrease; never let delta go negative). SCP delta from PBP machine (ESPN lacks SCP).
- Failure mode: no anchor (SR down, ESPN-id game) -> pure approximation, log `anchor_miss`, validation harness flags those games.
- Catch-up: if transition missed (period jumped 2), fetch once, mark gap.
- Quota: ~3-4 calls/game, 12-24/night. No live polling.

## Phase 4b — Nightly truth + validation harness
Fold into post-game agent (11:45pm MST — hours after finals, safely past BDL advanced populate latency; latency check tonight refines):
1. Pull team_game_advanced_stats for the day's WNBA games -> upsert wnba_official_stats.
2. Validation row per game per field: our_final (v2 fields) vs official; error logged to new table `wnba_field_validation` (game_id, field, source_used, ours, official, err, anchored bool).
3. Learning agent context gains official structural finals.
4. ntfy summary includes validation drift alert if any field's 7-day median error exceeds tolerance (silent data rot detector).

## Phase 5 — Season priors (storage + 2 consumers; rest follow-on)
Weekly refresh job (cron or piggyback nightly agent):
- team_season_advanced_stats (measure_type=advanced + four_factors; scope=general + clutch), team_shot_locations -> new table `wnba_team_priors` (team, season, block, stats JSONB, fetched_at).
- Consumer 1: sustainability baselines — per-team eFG/TOV/OREB/FTA-rate (own+opp) replace league constants in the Bayesian regression dimension. League-gated to WNBA.
- Consumer 2: MC clutch inputs — blend BDL clutch-scope ratings with clutch_profiles UPSERTs (shrinkage: BDL season clutch as prior, our observed Q4 rates as evidence).
- Follow-on (flagged, not built): VT/shot-diet priors from zones; pregame agent four-factors context.

## Phase 6 — Retrain + acceptance gate
- Training table: stored season snapshots with v2 corrected fields (ESPN structural history already persisted in raw_stats_json — full season available) + anchors where present + official finals + priors. Features: current 13 -> corrected pot, + paint, fbp, possessions/pace, pls_min-derived lineup signal. Windowed architecture retained (windowed biglead validated for WNBA).
- **POT correction COMPLETE (Jun 10, ahead of schedule):** live path flipped at source (buildSummaryFromESPN call site) and v1 pot backfilled across all historical snapshots with i1/floor_score/floor_team recomputed (6,888 rows corrected, dual parity gates, 391 boundary-class rows quarantined — see research/2026-06-10_pot_backfill.md). **Do NOT flip pot during training-table construction — stored pot is now correct; a build-time flip would double-flip.** Note: stored xgb_win_prob on historical snapshots still reflects flipped-pot inputs; optional rescore via rescore_xgb_prod.py before any research that consumes historical XGB scores.
- OOF CV as usual, then **acceptance = line-paired OOS test** (edge test #1 harness, reusable): new model must (a) beat current WNBA XGB OOS AND (b) be evaluated for OOS info beyond the live line. If (b) still fails, WNBA stays analytical-only — stated honestly — but dashboards/agents get the better model.
- Atomic swap: model file + feature extraction + field source flip in one commit.

---

## Cascading implications (traced)
- **computeServer/indicators (L7217):** consume ESPN `summary` — unchanged by Phase 1 (rewire touches modelSummary only). Phase 2 SCP merge at L7163 switches regex->machine output: indicator I-scores see better SCP. Floor shift possible -> regression-check on 3 recorded games before ship.
- **MC engine (_mcSrc L7446):** gets corrected cumulative stats post-swap; MC uses rates — low sensitivity, but include in regression run.
- **Agent prompts:** paint/POT lines in formatSonnetPrompt become trustworthy; grep all prompt references to pot/scp for stale caveats (blindspot #1: prompt text gets code-level rigor).
- **Learning agent:** new official-context fields — additive, no scoring change.
- **Backtest harnesses:** mc-backtest/backtest phases that read raw_stats_json must understand v2 keys — audit before Phase 6 (provenance discipline).
- **Client dashboards:** wnba-bdl.html reads snapshots' raw stats — v2 keys additive, no break; boundary `boundary:true` tag fixes WP render loop (client change: skip boundary-tagged in chart, 1 line).
- **DB:** 2 new tables (init migration), lt.sr_anchors JSONB (no migration), quarter_data overlay keys (no migration). No new columns on hot SELECT paths (hotfix learning #respected).
- **Concurrency:** SR anchor fetch inside transition block — already serialized per game; <1s typically, but it IS an await >1s risk on slow SR -> guard with lt lock flag like other slow calls.

## Dead code (post-rollout cleanup)
- Regex POT/SCP derivation (3 fallback sites) — after Phase 2 acceptance
- SR standings call -> swap to BDL `/wnba/v1/standings` (micro-phase, frees quota)
- `_srSummary` variable RENAMED (`bdlAggSummary`) — the misnomer caused a real diagnostic detour

## Test plan (Claude owns)
- **Unit (new, first tests in repo for these paths):** possession machine on synthetic sequences (TO->score, TO->miss->OREB->putback = POT+SCP, FT crediting, and-1, period-end reset, team-attribution via aliasMap fixture — the canonical regression case); anchor+delta math incl. negative-delta clamp and missing-anchor fallback; isBoundaryStale on the live-captured sequences ('0.0' break, parked '10:00').
- **Integration:** full-season replay of possession machine over stored plays vs wnba_official_stats (the Phase 2 acceptance run IS the integration test).
- **Regression:** 3 recorded games (incl. ATL@CHI 6/9) through old vs new pipeline — diff floors, indicators, XGB inputs, MC inputs; NBA untouched-path hash check.
- Syntax-gate every change (`node -c`), single descriptive commits per phase.

## Sizing & architecture call (Manny decides)
- Phase 4a: ~150-line research script. Phase 0: ~40 lines. Phase 1: ~120 lines. Phase 2: ~200-250 lines (the big one). Phase 3: ~80 lines. Phase 4b: ~100 lines. Phase 5: ~150 lines. Phase 6: retrain scripts (research/) + ~30-line swap.
- **Module question:** possession machine is the first candidate for a shared `lib/` module vs inline-in-poll. Inline = consistent with current monolith, zero bundling risk. Module = cleaner + unit-testable in isolation, needs a 15-min esbuild bundling spike (relative imports into a function bundle should work; cross-function require is what's forbidden). Recommendation: run the spike; module if it passes, inline if not.

## Sequencing
4a (backfill+adjudicate) -> 0 (guard) -> 1 (rewire dual-write) -> 2 (machine) -> 3 (anchors) -> 4b (nightly truth) -> 5 (priors) -> 6 (retrain+accept). Each phase independently shippable. Tonight's slate: BDL advanced populate-latency check slots into 4b design.

# Cross-Signal Exploration Test Plan

**Date:** May 2, 2026
**Status:** PLAN — awaiting approval before implementation
**Dependency:** mc-backtest.mjs (2,453 lines), mc_backtest_results (13,177 rows, 1,233 games)

---

## Goal

Determine how Floor, MC, and XGB interact as signals — where each fails, whether compound states outperform individuals, and how MC should integrate into the production system (agent context, independent alert, or ensemble).

## Three Core Questions

1. **Where does each signal fail, and does another catch it?**
2. **Are there compound states that outperform any individual signal?**
3. **What's the optimal signal architecture for production?**

---

## Data Landscape

| Signal | Source | AUC | Anchoring Bias | Responsiveness |
|--------|--------|-----|----------------|----------------|
| **Floor** | I1-I5 cumulative indicators | 0.694 | Heavy — Q1 stats persist into Q4 | Slow |
| **MC** | Per-possession sim from rolling window rates | 0.718 (backtest), 0.749 (triggered) | None — uses current rates | Fast |
| **XGB** | 13-feature gradient boost, 300 trees | 0.749 (OOF) | Moderate — `biglead` locks at max | Medium |

**Key asymmetry:** Floor and XGB are backward-looking (what HAS happened). MC is forward-looking (what WILL happen given current rates). This is why they should have complementary failure modes — when cumulative signals anchor stale, MC should diverge.

**Pre-computed:** mc_backtest_results has `mc_win_prob` and `floor_score` for 13,177 checkpoints. `xgb_win_prob` column exists but is NULL — needs backfill (Phase 0).

---

## Phase 0: XGB Backfill (prerequisite)

**What:** Port `extractXGBFeatures()` + `predictXGB()` from poll-live-bdl.mjs into mc-backtest.mjs. Compute XGB win probability for all 13,177 checkpoints and UPDATE mc_backtest_results.xgb_win_prob.

**Why:** Can't do cross-signal analysis without all three signals computed. The 13 features (paint, pot, to, stl, oreb, ast, blk, fta, efg, biglead, 3pr, rim_pct, runs) are all derivable from nba_snapshot_backtest.team_stats JSONB. Runs feature defaults to 0.5 (no PBP in backtest — same as prod when PBP unavailable).

**Implementation:** New phase `?phase=xgb_backfill&n=200&offset=0`. Batch process, loads xgb-model.json once, extracts features from team_stats, predicts, updates xgb_win_prob.

**Validation:** After backfill, compute XGB AUC from mc_backtest_results and compare to known OOF AUC (0.749). Should be close — any large deviation means feature extraction bug.

**Estimated rows:** 13,177 (14 checkpoints × ~1,233 games, minus games with missing data)

---

## Test 1: Signal Concordance Matrix

**Question answered:** Q1 (where does each fail?) + Q2 (compound states)

**Method:** At each checkpoint, bucket each signal:

| Bucket | Floor | MC | XGB |
|--------|-------|-----|-----|
| HIGH | > 0.70 | > 0.70 | > 0.70 |
| MED | 0.50–0.70 | 0.50–0.70 | 0.50–0.70 |
| LOW | < 0.50 | < 0.50 | < 0.50 |

Cross-tabulate all 27 cells (3×3×3). For each cell, report:
- N (how many checkpoints land here)
- ctrl_win_rate
- avg_margin_at_snapshot
- avg_final_margin

**Key cells to watch:**
- `ALL_HIGH` — consensus confidence. Expected: highest win rate (>85%)
- `FLOOR_HIGH + MC_LOW` — cumulative anchoring blind spot. MC sees deterioration floor doesn't. Expected: significantly lower than FLOOR_HIGH alone
- `MC_HIGH + FLOOR_LOW` — MC sees strength floor doesn't (possible Q1 variance the ctrl team rides out). Expected: moderate WR
- `XGB_HIGH + MC_LOW` — biglead anchoring in XGB. Expected: lower WR than XGB_HIGH alone
- `ALL_LOW` — consensus exit. Expected: lowest win rate (<30%)

**Phase:** `?phase=cross_concordance`

**Output:** 27-cell matrix table + marginal win rates for each signal at each bucket

---

## Test 2: Failure Attribution

**Question answered:** Q1 (does another signal catch what one misses?)

**Method:** Isolate all games where ctrl lost (n ≈ 400–450). At Q3_END and Q4_6 checkpoints (the decision points), classify each signal as WRONG (> 0.65, predicted win) or RIGHT (< 0.50, caught the loss).

**Attribution categories:**
- `ALL_WRONG` — all three signals missed. How many? What happened? (late heroics, OT, refs, garbage time edge)
- `ONLY_MC_RIGHT` — MC caught it, floor and XGB didn't. This is MC's unique value.
- `ONLY_XGB_RIGHT` — XGB caught it, others didn't.
- `ONLY_FLOOR_RIGHT` — Floor caught it, others didn't.
- `MC+XGB_RIGHT` — Both responsive signals caught it, floor missed (cumulative anchoring)
- `MC+FLOOR_RIGHT` — MC and floor caught it, XGB missed (biglead anchoring)
- `ALL_RIGHT` — all three saw it coming

**Also compute the inverse:** Games where ctrl WON but a signal said LOW. False alarm rate per signal.

**Phase:** `?phase=cross_failure`

**Output:** Attribution table at Q3_END and Q4_6, plus false alarm counts

---

## Test 3: MC Marginal Value

**Question answered:** Q1 + Q3 (what does MC add over existing signals?)

**Method:** Take the Floor+XGB baseline (what we have in production today). Measure how many decisions MC would flip correctly.

**Sub-tests:**

### 3a: MC Catches What Floor+XGB Miss
Games where `floor > 0.65 AND xgb > 0.65 AND ctrl_lost`. Among these "double-confident losses":
- What % had `mc < 0.50`? (MC would have warned)
- What % had `mc < 0.40`? (MC strong alarm)
- At which checkpoint did MC first drop below 0.50?
- How many minutes of warning did MC provide before the loss materialized?

### 3b: MC Prevents False Exits
Games where `floor < 0.50 AND xgb < 0.50 AND ctrl_won`. Among these "double-exit signals":
- What % had `mc > 0.60`? (MC would have held)
- Would holding have been the right call? (yes — ctrl won)

### 3c: MC Solo Alarm Precision
Games where `mc < 0.50 AND floor > 0.60 AND xgb > 0.60` (MC is the only signal alarming).
- How often is MC right? (ctrl loses)
- How often is it a false alarm? (ctrl wins despite MC warning)
- Is this precision high enough to act on, or is MC too jumpy when used alone against consensus?

**Phase:** `?phase=cross_marginal`

**Output:** Marginal value table — saves, prevents, false alarms

---

## Test 4: Compound Signal States

**Question answered:** Q2 (do compound states outperform individuals?)

**Method:** Define 8-10 specific compound conditions that map to production decisions. Measure precision (ctrl win rate) and volume (how often each state occurs) at Q3+ checkpoints.

**Compound states to test:**

| State | Floor | MC | XGB | Margin | Expected Use |
|-------|-------|-----|-----|--------|-------------|
| FORTRESS | > 0.80 | > 0.80 | > 0.80 | any | Max hold confidence |
| CONSENSUS_STRONG | > 0.70 | > 0.70 | > 0.70 | leading | Strong position |
| ANCHORED_DECAY | > 0.75 | < 0.50 | > 0.70 | leading | Cumulative blind spot — EXIT? |
| EARLY_WARNING | > 0.65 | < 0.50 | > 0.60 | leading ≤8 | MC sees shift, others lag |
| CONFIRMED_COLLAPSE | < 0.55 | < 0.40 | < 0.55 | any | Full exit |
| STRUCTURAL_BUY | > 0.65 | > 0.65 | < 0.45 | trailing | XGB wrong (biglead), buy opp |
| MC_SOLO_EXIT | > 0.65 | < 0.40 | > 0.65 | leading ≤5 | MC only alarm — act or wait? |
| RECOVERY_CONFIRMED | < 0.55 | > 0.65 | < 0.50 | trailing | MC sees recovery floor/XGB miss |
| CONSENSUS_EXIT | < 0.50 | < 0.40 | < 0.50 | any | All agree — exit immediately |
| SPLIT_DECISION | MED | split direction with other two | | ≤8 | Disagreement — agent decides |
| MARGIN_COLLAPSE | > 0.70 | any | > 0.65 | lost 10+ pts in 2 checkpoints | Signals anchored, margin screaming |
| MARGIN_COMPRESS | > 0.65 | < 0.55 | > 0.60 | lost 6+ pts in 2 checkpoints | MC + margin agree, cumulative blind |

**Margin velocity dimension:** For MARGIN_COLLAPSE and MARGIN_COMPRESS, compute margin delta across 2 consecutive checkpoints (~6 min). This catches the 58 blowout misses from the silent audit — games where all three signals stayed high but margin was evaporating. If margin velocity adds discriminatory power beyond the three WP signals, it becomes a fourth axis in compound states.

For each state: N, ctrl_win_rate, avg_final_margin, avg_time_remaining.

**The golden test:** Compare ANCHORED_DECAY precision vs FLOOR_HIGH alone. If ANCHORED_DECAY (floor high but MC low) has significantly worse win rate than FLOOR_HIGH overall, MC is providing real discriminatory value that floor alone misses.

**Phase:** `?phase=cross_compounds`

**Output:** Precision table per compound state, comparison vs individual signal baselines

---

## Test 5: Temporal Signal Value

**Question answered:** Q3 (when does each signal matter most?)

**Method:** Compute AUC for each signal at each of the 14 checkpoints (Q1_6 through Q4_END). Plot the three AUC curves.

**Hypothesis:**
- Q1–Q2: Floor and XGB dominate (cumulative anchoring isn't a problem yet — there's nothing to anchor to)
- Q3 early: MC starts adding value as floor/XGB anchor to Q1-Q2 stats
- Q3 late–Q4: MC should have highest marginal value as cumulative signals are most stale
- Q4_END: All converge (game is decided, all signals reflect reality)

**Also compute:** Per-checkpoint, the AUC of multiple ensemble approaches:
- Simple average: `(floor + mc + xgb) / 3`
- XGB-heavy: `0.5×XGB + 0.3×MC + 0.2×Floor`
- MC-heavy: `0.5×MC + 0.3×XGB + 0.2×Floor`
- Quarter-adaptive: XGB-heavy in Q2, equal in Q3, MC-heavy in Q4

Does any ensemble beat the best individual at every checkpoint, or only at certain ones? Does the optimal weighting shift as the game progresses?

**Phase:** `?phase=cross_temporal`

**Output:** 14-row table with per-checkpoint AUC for Floor, MC, XGB, 4 ensembles. Identifies crossover points and optimal weighting by game phase.

---

## Test 6: Historical Alert Decision Replay

**Question answered:** Q3 (how should MC integrate with production?)

**Method:** Pull all historical alerts from the `alerts` table (BUY, BWC, EXIT, POSITION_OPEN). For each alert, find the nearest mc_backtest_results checkpoint (by game_id + period/clock proximity). Attach MC win probability to the alert.

**Sub-tests:**

### 6a: Wrong Alerts + MC
Alerts where `agent_decision = 'SEND'` but position lost:
- What was MC at that moment?
- Would MC < 0.50 have correctly suppressed?
- What % of wrong SENDs had MC warning?

### 6b: Good Suppressions + MC
Alerts where `agent_decision = 'SUPPRESS'` and position would have lost:
- Did MC agree with the suppress? (MC < 0.50 = agreement)
- Cases where agent suppressed without MC — was agent already catching these?

### 6c: Missed Opportunities + MC
Alerts where `agent_decision = 'SUPPRESS'` but position would have WON:
- What was MC? 
- Would MC > 0.70 have correctly overridden the suppress?

**Note:** This test requires joining alerts table with mc_backtest_results on game_id + closest checkpoint. Not all alerts will have matching backtest data (prod games post-backtest period). Focus on games that exist in both.

**Phase:** `?phase=cross_replay`

**Output:** Decision flip table — saves, overrides, agreement rate

---

## Execution Sequence

| Order | Phase | Depends On | Estimated Time | Games/Rows |
|-------|-------|------------|----------------|------------|
| 0 | `xgb_backfill` | xgb-model.json | ~10 min (batch) | 13,177 rows |
| 1 | `cross_concordance` | Phase 0 | ~30 sec (pure SQL) | 13,177 rows |
| 2 | `cross_failure` | Phase 0 | ~30 sec | ~400 loss games |
| 3 | `cross_marginal` | Phase 0 | ~30 sec | ~13,177 rows |
| 4 | `cross_compounds` | Phase 0 | ~30 sec | Q3+ rows (~6,500) |
| 5 | `cross_temporal` | Phase 0 | ~30 sec | 13,177 rows |
| 6 | `cross_replay` | Phase 0 + alerts table | ~1 min | ~500 alerts |

**Total estimated time:** ~15 min including XGB backfill

Tests 1-5 are pure SQL against mc_backtest_results (fast). Phase 0 is the bottleneck — feature extraction + XGB prediction for 13K rows. Test 6 requires a join with the alerts table.

---

## What Falls Out

After all 6 tests, we'll have the data to answer:

**Architecture decision:** Does MC feed into the agent prompt as context (like conviction quality today), operate as a mechanical gate (like XGB EXIT), or generate independent alerts (like VULNERABILITY)?

**Likely answer based on what we already know:** MC as agent context + mechanical gate for specific compound states. ANCHORED_DECAY and EARLY_WARNING become mechanical risk flags. FORTRESS and CONSENSUS_STRONG become confidence boosters. MC_SOLO_EXIT precision determines whether MC can act alone or needs corroboration.

**Production integration priority based on test outcomes:**
- If Test 3a shows MC catches >50% of double-confident losses → MC is a mandatory EXIT enrichment
- If Test 4 ANCHORED_DECAY shows <60% WR vs floor HIGH baseline >80% → compound state gates have massive value
- If Test 5 shows MC AUC exceeds floor/XGB by Q3_6 → MC is the primary signal for second-half decisions
- If Test 5 weighted ensemble beats best individual by 2+ AUC points → production should use blended WP, not individual signals
- If Test 4 MARGIN_COLLAPSE shows <50% WR despite all signals HIGH → margin velocity is an independent fourth signal the agent needs
- If Test 6 shows >30% of wrong SENDs had MC warning → MC should be an agent hard gate, not just context

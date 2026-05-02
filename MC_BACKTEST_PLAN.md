# Monte Carlo Simulation — Backtest & Validation Plan

## Overview

Validate the Monte Carlo possession simulation engine against 16,910 snapshots across ~1,235 games from `nba_snapshot_backtest`. The backtest must answer three questions before MC ships to production:

1. **Is MC accurate?** Does MC win probability track actual game outcomes?
2. **Does MC add value over XGB?** Specifically, does MC catch momentum shifts that XGB misses due to cumulative anchoring?
3. **What are the right parameter values?** Regression strength, rate blending, pace adjustment, divergence thresholds.

## Data Source

### `nba_snapshot_backtest` — 16,910 rows, ~1,235 games

Each row is a 3-minute checkpoint with:
- `team_stats` JSONB: cumulative per-team stats (pts, fgm, fga, fg3m, fg3a, ftm, fta, ast, to, stl, blk, oreb)
- `pbp_derived` JSONB: paint, rim attempts/makes, biggest_lead, POT, Q4 pts, runs6
- `indicators` JSONB: I1-I5 scores, floor, controlTeam
- `conviction` JSONB: tier, combo, indicators won
- `ctrl_team_won` BOOLEAN: ground truth (did the control team at this snapshot win the game?)
- `final_margin` INTEGER: actual final margin
- `margin_at_snapshot` INTEGER: margin at checkpoint time
- `period`, `clock_sec`: game clock at checkpoint

14 checkpoints per game: Q1_3, Q1_6, Q1_9, Q1_END, Q2_3, Q2_6, Q2_9, Q2_END, Q3_3, Q3_6, Q3_9, Q3_END, Q4_3, Q4_6, Q4_9 (Q4_END excluded — game is over).

### `nba_backtest` — ~1,235 games

Join table for final scores, dates, winner. Integer `bdl_game_id` joins to `nba_snapshot_backtest.game_id`.

---

## Phase 0: Infrastructure — Build the Replay Harness

### 0.1 Rate Extraction from Checkpoint Diffs

MC needs rolling window rates, not cumulative. The backtest stores cumulative stats at each checkpoint. **Solution: diff consecutive checkpoints to derive per-window rates.**

For checkpoint N in game G:
```
windowStats = checkpoint[N].team_stats - checkpoint[N-2].team_stats
```

Using a 2-checkpoint window (~6 minutes of game time) balances recency with sample stability. This approximates the rolling window that `computeServerWindow` produces in production.

**Implementation:**
```javascript
function extractWindowRates(checkpoints, currentIndex, windowSize = 2) {
  const curr = checkpoints[currentIndex].team_stats;
  const prevIdx = Math.max(0, currentIndex - windowSize);
  const prev = checkpoints[prevIdx].team_stats;

  // Diff each stat for each team
  function diff(side) {
    const c = curr[side], p = prev[side];
    return {
      pts: c.pts - p.pts,
      fgm: c.fgm - p.fgm,
      fga: c.fga - p.fga,
      fg3m: c.fg3m - p.fg3m,
      fg3a: c.fg3a - p.fg3a,
      ftm: c.ftm - p.ftm,
      fta: c.fta - p.fta,
      to: c.to - p.to,
      oreb: c.oreb - p.oreb,
    };
  }
  return { home: diff('home'), away: diff('away') };
}
```

**Edge case:** Q1 checkpoints (indices 0-2) have no prior window. For index 0-1, fall back to cumulative stats. Flag these in results — MC accuracy at Q1 should be evaluated separately since it uses degraded input.

### 0.2 Remaining Possessions Estimation

From cumulative stats at checkpoint:
```
elapsed_minutes = (period - 1) * 12 + (12 - clock_sec/60)
remaining_minutes = 48 - elapsed_minutes  // regulation only
poss_per_team = max(homePoss, awayPoss)
pace = poss_per_team / elapsed_minutes
remaining_poss_per_team = pace * remaining_minutes / 2
```

Possession estimate: `FGA + 0.44*FTA - OREB + TO` (standard NBA formula).

### 0.3 Season Baseline for 3PT Regression

The backtest doesn't store season priors per team. Two options:
- **Simple:** Use league-average 36% as universal baseline for all teams. Introduces small error for extreme shooting teams but is consistent.
- **Better:** Build a lookup table of team season 3PT% from `season_cache` for the relevant season. One-time query, store as a static map.

**Decision:** Start with league-average 36%. If calibration shows systematic bias for high/low shooting teams, upgrade to per-team baselines.

### 0.4 Replay Script Structure

New file: `mc-backtest.mjs`

```
1. Query all games from nba_backtest (game_id, winner, final_margin)
2. For each game, query all checkpoints from nba_snapshot_backtest ORDER BY period, clock_sec
3. For each checkpoint (Q2+ only — MC needs at least 1 prior checkpoint for rates):
   a. Extract window rates (diff from prior checkpoints)
   b. Compute remaining possessions
   c. Run MC simulation (N=1000)
   d. Record: game_id, checkpoint, mc_win_prob, mc_collapse_prob, mc_median_margin,
              xgb_win_prob (from indicators JSONB), floor, margin, actual_outcome
4. Write results to mc_backtest_results table (or CSV for analysis)
```

---

## Phase 1: Baseline MC Accuracy

### 1.1 Overall AUC

Run MC at every eligible checkpoint (Q2_3 through Q4_6, ~10 per game, ~12,350 total). Compare `mc_win_prob` vs `ctrl_team_won`.

**Metrics:**
- **AUC-ROC** — discrimination: can MC distinguish wins from losses?
- **Brier score** — calibration + discrimination combined: `mean((mc_win_prob - outcome)²)`
- **Log loss** — penalizes confident wrong predictions more heavily

**Comparison baseline:**
- XGB AUC at same checkpoints (already computed during XGB backtest: 0.749 OOF)
- Floor AUC at same checkpoints
- Naive margin-based probability (historical win rate at each margin bucket)

**Success criterion:** MC AUC ≥ 0.70. MC doesn't need to beat XGB overall — it needs to beat XGB in specific segments (see Phase 2). If overall MC AUC < 0.65, the simulation model has fundamental issues.

### 1.2 Calibration Curve

Bin MC predictions into 10 buckets (0-10%, 10-20%, ..., 90-100%). For each bucket, compute actual win rate.

**What we're looking for:**
- Points should fall on the diagonal (predicted 70% → actual ~70%)
- Systematic over/under-confidence indicates model bias
- If MC is consistently overconfident (predicts 80%, actual 65%), the rate extraction or simulation model needs adjustment

**Visualization:** Calibration plot with bucket size annotations. Buckets with <50 observations get flagged as unreliable.

### 1.3 Per-Quarter Accuracy

Split results by quarter:

| Quarter | Checkpoints | Expected Behavior |
|---------|-------------|-------------------|
| Q2 | Q2_3, Q2_6, Q2_9, Q2_END | MC uses 1-2 checkpoint diffs. Noisier rates, higher variance. Expect lower AUC. |
| Q3 | Q3_3, Q3_6, Q3_9, Q3_END | MC has 2-3 quarters of window data. Core evaluation zone. |
| Q4 | Q4_3, Q4_6 | Fewer remaining possessions → tighter distributions. Should be most accurate. |

**Success criterion:** Q3-Q4 MC AUC ≥ 0.72. Q2 AUC ≥ 0.65 (degraded input expected).

---

## Phase 2: MC vs XGB — Where MC Adds Value

This is the core question. MC doesn't need to replace XGB — it needs to catch what XGB misses.

### 2.1 Lead-Change Games

**Definition:** Games where one team led by 10+ points at any checkpoint and the other team won (or took the lead). Identify from backtest by scanning checkpoint margins within a game.

**Expected population:** ~80-120 games out of 1,235 (~7-10%). These are rare but high-impact — exactly the DET@ORL scenario.

**Test:** At the checkpoint where the leading team's margin was at/near maximum:
- What did XGB predict? (Expected: high confidence for leading team, anchored by biglead)
- What did MC predict? (Expected: lower confidence, reflecting deteriorating rates)
- How early did MC detect the shift vs XGB?

**Key metric:** AUC in lead-change games only:
- MC AUC in lead-change games vs XGB AUC in lead-change games
- MC AUC in non-lead-change games vs XGB AUC in non-lead-change games

**Hypothesis:** MC dramatically outperforms XGB in lead-change games (AUC gap ≥ 0.10). MC slightly underperforms XGB in non-lead-change games (blowouts where cumulative anchoring is correct).

### 2.2 Margin Compression Detection

For every checkpoint where margin ≥ 10:
- Compute `margin_compression = margin_at_checkpoint - final_margin`
- Does `mc_collapse_prob` predict large compression?
- Does `mc_win_prob << xgb_win_prob` predict compression?

**Regression:** `margin_compression ~ mc_collapse_prob + mc_xgb_divergence + margin + quarter`

**Key metric:** Correlation between `mc_collapse_prob` and actual margin compression. Target: r ≥ 0.30.

### 2.3 MC-XGB Divergence as Early Warning

Define divergence: `mc_xgb_div = xgb_win_prob - mc_win_prob`

When `mc_xgb_div > 0.20` (XGB confident, MC skeptical):
- What fraction of the time does the leading team lose? → **precision**
- What fraction of actual lead-change games had divergence > 0.20? → **recall**
- How many minutes before XGB drops did MC diverge? → **lead time**

Sweep divergence thresholds: 0.10, 0.15, 0.20, 0.25, 0.30, 0.35.

**Expected finding:** There's a sweet spot where MC-XGB divergence is both predictive (precision > 40%) and early (lead time > 5 minutes). This becomes the divergence threshold for the agent prompt.

### 2.4 Blowout Behavior (Sanity Check)

In games where the leading team wins by 15+ (no lead change):
- MC should agree with XGB (both confident for leading team)
- MC collapse probability should be < 0.15
- If MC is consistently more skeptical than XGB in genuine blowouts, the rates are too noisy or the simulation model is under-weighting the current lead

**Failure mode:** MC says 55% in a game that's 20-point blowout → rate extraction is too noisy, window too short, or FTA/OREB rates are distorting.

---

## Phase 3: Open Question Parameter Sweeps

### 3.1 3PT Regression Strength

**Parameter:** `sampleWeightCap` — max weight on live 3PT% vs season baseline.

**Sweep:** 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90

**Formula:** `regressed3Pct = live3Pct * min(cap, attempts/30) + season3Pct * (1 - min(cap, attempts/30))`

**Evaluation:** For each cap value:
- Run full MC backtest (can subsample to 300 games for speed)
- Measure AUC, Brier score, calibration
- Specifically evaluate: do high-cap values (trust live shooting) cause overreaction to hot/cold streaks? Do low-cap values (trust season baseline) miss genuine scheme-driven shooting changes?

**Expected finding:** Cap around 0.50-0.70 balances responsiveness with stability. Very low caps (0.30) will ignore real shooting nights. Very high caps (0.90) will be noisy.

### 3.2 Rate Window Size

**Parameter:** Number of prior checkpoints to diff for rolling rates.

**Sweep:** 1 checkpoint (~3 min), 2 checkpoints (~6 min), 3 checkpoints (~9 min), 4 checkpoints (~12 min)

**Tradeoff:**
- Short window (1 cp): Most responsive to shifts, noisiest rates. Small sample ≈ 12-15 possessions.
- Long window (4 cp): Smoothest rates, but re-introduces cumulative anchoring problem.

**Evaluation:** AUC and Brier score at each window size. Also specifically: in lead-change games, which window size catches the shift earliest?

**Expected finding:** 2 checkpoints (~6 min, ~25-30 possessions) is the sweet spot. Enough sample for stable rates, recent enough to catch momentum shifts.

### 3.3 PBP Window Blending

**Parameter:** Whether to blend PBP 15-possession micro-rates into the rolling window rates.

**Note:** PBP data (`pbp_derived`) is available in the backtest but as game-cumulative paint/rim/POT/runs, NOT as a 15-possession window. The 15-possession window is computed from raw play data which isn't stored in the backtest table.

**Options:**
- **A) Pure rolling window:** MC uses only checkpoint-diffed rates. Simpler, testable with existing data.
- **B) PBP-augmented:** In production, MC could use PBP 15-possession rates when they diverge significantly from window rates. Cannot be backtested directly — would need to replay raw PBP data.

**Decision:** Start with A (pure rolling window) for backtest. If MC shows value, evaluate B as a production enhancement by observing live divergence patterns.

### 3.4 Pace Adjustment

**Parameter:** Whether to adjust remaining possession pace for game state.

**Options:**
- **Constant pace:** Use current game pace for all remaining possessions.
- **State-adjusted:** Increase pace when trailing in Q4 (teams play faster), decrease when leading.

**Test:** Compare constant vs adjusted pace on Q4 checkpoints only.

**Adjustment formula candidate:**
```
if Q4 and trailing by 5+: pace *= 1.10 (team plays faster)
if Q4 and leading by 10+: pace *= 0.95 (team slows down)
```

**Evaluation:** Does pace adjustment improve Q4 AUC? If delta < 0.01 AUC, not worth the complexity.

### 3.5 Simulation Count

**Parameter:** Number of simulations per checkpoint.

**Sweep:** 100, 250, 500, 1000, 2500

**Evaluation:** At each sim count:
- Measure variance in MC output across 10 runs of the same checkpoint
- Plot std(mc_win_prob) vs sim_count
- Find the elbow where more sims stop reducing variance meaningfully

**Expected finding:** 500-1000 is the sweet spot. 100 is too noisy (±5% variance). 2500 is marginal improvement over 1000 at 2.5x cost.

### 3.6 Overtime Handling

**Test:** Identify all games that went to OT in the backtest. At Q4_6 checkpoint:
- How often does MC predict a close game (win prob 40-60%)?
- If we count ties as 0.5 wins, does calibration improve?
- If we simulate 5-min OT, does it matter for AUC?

**Expected finding:** OT games are rare (<5% of games). The handling doesn't matter much for overall accuracy. Default to 0.5 wins for ties.

---

## Phase 4: Combination Value

### 4.1 MC + XGB Ensemble

Does combining MC and XGB produce better predictions than either alone?

**Methods to test:**
- **Simple average:** `combined = 0.5 * xgb + 0.5 * mc`
- **Weighted average:** `combined = w * xgb + (1-w) * mc`, sweep w from 0.3 to 0.7
- **Quarter-dependent:** `w = 0.7` in Q2 (trust XGB more), `w = 0.4` in Q4 (trust MC more)
- **Divergence-dependent:** When `|xgb - mc| > 0.20`, weight MC higher (it's catching a shift XGB misses)

**Evaluation:** AUC of combined vs AUC of XGB alone vs AUC of MC alone. Overall and per-segment.

### 4.2 Agent Decision Replay

For the ~500 historical alerts in the alerts table (or a representative sample):
- What would the agent have decided if MC data was in the context?
- Focus on wrong decisions: alerts that were SENT but the position lost, or SUPPRESSed but the position would have won.
- Would MC divergence have correctly flipped any of those decisions?

**This is the ultimate test:** Not just "is MC accurate" but "does MC make better betting decisions?"

### 4.3 Collapse Probability Alert Threshold

From Phase 2.2 results, determine:
- At what `mc_collapse_prob` threshold should we flag RISK in the agent prompt?
- At what threshold should we flag strong SUPPRESS signal?

**Approach:** Precision-recall curve on `mc_collapse_prob` vs actual lead loss.

| Threshold | Precision | Recall | F1 |
|-----------|-----------|--------|-----|
| > 0.15 | ? | ? | ? |
| > 0.20 | ? | ? | ? |
| > 0.25 | ? | ? | ? |
| > 0.30 | ? | ? | ? |
| > 0.35 | ? | ? | ? |

Target: RISK flag at precision ≥ 0.35 (acceptable false positive rate). SUPPRESS signal at precision ≥ 0.50.

---

## Phase 5: Failure Mode Analysis

### 5.1 Where MC is Wrong

For the top 50 MC misses (highest confidence, wrong outcome):
- What happened? Manual inspection.
- Categories: late-game heroics, injury during game, intentional fouling, overtime, referee impact, garbage time distortion
- Are there systematic patterns we can mitigate?

### 5.2 Where MC and XGB Both Fail

Cases where both MC > 0.70 and XGB > 0.70 but the team loses:
- How many? What fraction of all losses?
- These are genuinely unpredictable games — the structural picture was correct but execution failed.
- This sets the ceiling for any model's accuracy.

### 5.3 Rate Stationarity Assumption

MC assumes current rates hold for the rest of the game. When does this break?

**Test:** For each checkpoint, compute the rates in the window BEFORE and AFTER. How correlated are they?

`rate_stability = correlation(window_before_rates, window_after_rates)`

If rates are highly non-stationary (correlation < 0.3), MC's fundamental assumption is questionable. If correlation > 0.5, the assumption is reasonable.

**Expected finding:** Rates are moderately stable (0.4-0.6 correlation) over 6-minute windows but decrease as window size grows. This supports using rolling windows rather than cumulative stats.

### 5.4 Small-Sample Rate Instability

At each checkpoint, record the number of possessions in the rate extraction window. Plot MC accuracy vs window possession count.

**Expected finding:** Below ~15 possessions, MC rates are too noisy and accuracy drops. This sets the minimum window size and determines when MC should degrade gracefully (e.g., wider confidence intervals, or fall back to cumulative rates).

---

## Execution Plan

### Script: `mc-backtest.mjs`

Runs as a Netlify function with phases:

| Phase | Endpoint | Runtime | Output |
|-------|----------|---------|--------|
| init | `?phase=init` | 5s | Create `mc_backtest_results` table |
| run | `?phase=run&n=100&offset=0` | 30-45s | Process 100 games, write results |
| analyze | `?phase=analyze` | 10s | Compute AUC, calibration, segmented metrics |
| sweep | `?phase=sweep&param=regression&values=0.3,0.5,0.7` | 60s | Parameter sweep on subset |

Batch processing: 100 games per invocation, ~13 invocations to cover all 1,235 games. Each game has ~10 eligible checkpoints × 1,000 sims = manageable within serverless timeout.

### Results Table: `mc_backtest_results`

```sql
CREATE TABLE mc_backtest_results (
  game_id INTEGER NOT NULL,
  checkpoint TEXT NOT NULL,
  period INTEGER,
  clock_sec INTEGER,
  -- MC outputs
  mc_win_prob REAL,
  mc_collapse_prob REAL,
  mc_median_margin REAL,
  mc_margin_10pct REAL,
  mc_margin_90pct REAL,
  -- Comparison baselines
  xgb_win_prob REAL,
  floor_score REAL,
  margin_at_snapshot INTEGER,
  -- Ground truth
  ctrl_team_won BOOLEAN,
  final_margin INTEGER,
  -- Parameters used
  window_size INTEGER,
  regression_cap REAL,
  sim_count INTEGER,
  rate_source TEXT,         -- 'window' or 'cumulative'
  window_possessions INTEGER, -- how many possessions in the rate window
  -- Metadata
  home_alias TEXT,
  away_alias TEXT,
  ctrl_team TEXT,
  PRIMARY KEY (game_id, checkpoint)
);
```

### Analysis Queries (Phase 5 outputs)

Pre-built queries for each metric:

```sql
-- Overall AUC (approximated via concordance)
-- Calibration buckets
-- Lead-change game identification
-- MC-XGB divergence vs outcome
-- Collapse prob vs actual margin compression
-- Per-quarter splits
-- Parameter sweep comparisons
```

---

## Success Criteria Summary

| Metric | Threshold | Implication |
|--------|-----------|-------------|
| MC overall AUC | ≥ 0.70 | MC is a useful signal |
| MC Q3-Q4 AUC | ≥ 0.72 | MC is reliable when it matters most |
| MC AUC in lead-change games | > XGB AUC + 0.08 | MC catches what XGB misses |
| Calibration error | < 0.08 | MC probabilities are trustworthy |
| Collapse prob precision @ threshold | ≥ 0.35 | Collapse warning is actionable |
| MC-XGB divergence lead time | ≥ 5 min | MC provides early warning |
| MC + XGB ensemble AUC | > max(MC, XGB) AUC | Combination adds value |
| Rate stability correlation | ≥ 0.40 | Rolling window rates are meaningful |

### Go / No-Go Decision

**GO:** MC overall AUC ≥ 0.70 AND MC outperforms XGB in lead-change games by ≥ 0.08 AUC AND collapse probability is calibrated (precision ≥ 0.35 at some threshold).

**CONDITIONAL GO:** MC AUC 0.65-0.70. Ship to agent context as informational signal only (no alerts, no mechanical gates). Observe live behavior before expanding role.

**NO-GO:** MC AUC < 0.65 OR MC doesn't outperform XGB in lead-change games. The simulation model needs fundamental rework (rate extraction, possession model, or the stationarity assumption doesn't hold for NBA games).

---

## Timeline Estimate

| Step | Effort | Dependency |
|------|--------|------------|
| Build `runMonteCarloSim()` function | 2 hours | MC spec approved |
| Build `mc-backtest.mjs` replay harness | 3 hours | Function built |
| Run full backtest (1,235 games) | 15-20 min | Harness built |
| Phase 1 analysis (baseline accuracy) | 1 hour | Backtest complete |
| Phase 2 analysis (MC vs XGB segments) | 2 hours | Phase 1 complete |
| Phase 3 parameter sweeps | 3 hours | Phase 2 complete |
| Phase 4 combination analysis | 1 hour | Phase 3 complete |
| Phase 5 failure analysis | 1 hour | Phase 4 complete |
| Go/No-Go decision | — | All phases complete |
| Production integration (if GO) | 2-3 hours | Decision made |

Total: ~2-3 sessions to go from spec to shipped (if GO).

# Trajectory-Enriched Ensemble: Prototype Test Plan

**Date:** May 13, 2026
**Status:** PLAN — awaiting approval before implementation
**Predecessor:** May 13 MC/divergence research session (findings in memory)
**Dataset:** ~16,910 checkpoints across ~1,233 games (nba_snapshot_backtest)

---

## The Insight

Every point-in-time signal we have (floor, XGB, MC Cum, margin) collapses to margin correlation when tested individually. MC Cum is a 96.8% margin echo. Floor anchors to stale early-game data. XGB is the most independent (margin correlation 0.268) but still plateau at ~0.786 AUC.

**The hypothesis:** Signal TRENDS contain predictive information that point-in-time values miss. XGB at 0.55 and rising (structural improvement) is fundamentally different from XGB at 0.55 and falling (structural decay), even though a point-in-time model treats them identically.

**Why this should work:**
1. Margin correlation proved all signals echo margin — but margin VELOCITY matters (a team down 5 and closing vs down 5 and bleeding)
2. XGB-MC divergence (the 44pp predictive spread we found) is itself a trajectory phenomenon — the gap opens or closes over time
3. Floor's anti-predictive failure mode (≥0.75 trailing = 30% wins) is specifically the anchoring problem — floor was HIGH earlier and is slow to update. Trajectory (floor declining) would catch this.

**What we're NOT doing:** This is not a new model architecture (no TFT/N-BEATS yet). This is feature engineering on existing checkpoint data to prove the trajectory concept, then training a standard gradient-boosted ensemble.

---

## Data Available

The `window_xgb_export` phase in mc-backtest.mjs provides per-checkpoint:

| Field | Description |
|-------|-------------|
| `gid` | Game ID (integer, BDL) |
| `cp` | Checkpoint label (Q2_9, Q2_6, Q2_3, Q2_END, Q3_9, ..., Q4_END) |
| `p` | Period (2-4) |
| `clk` | Clock remaining in quarter (minutes) |
| `won` | Did ctrl team win (boolean — ground truth) |
| `mar` | Margin at snapshot (home - away, NOT ctrl-relative) |
| `flr` | Floor score (0-1, ctrl-relative) |
| `ctrl` | Control team alias |
| `hA/aA` | Home/away alias |
| `fmar` | Final margin |
| `w[0-12]` | 2Q windowed XGB features (13 values, ctrl-relative diffs) |
| `c[0-12]` | Cumulative XGB features (13 values, ctrl-relative diffs) |
| `mc2q` | MC 2Q windowed win prob (with mc=1 flag) |
| `mcC` | MC cumulative win prob (with mc=1 flag) |

**Feature order:** paint, pot, to, stl, oreb, ast, blk, fta, efg, biglead, 3pr, rim_pct, runs

**Checkpoint cadence:** 14 per game (Q1_6, Q1_END, Q2_3/6/9/END, Q3_3/6/9/END, Q4_3/6/9/END). Q2+ only for our analysis = 12 per game. Each is ~3 min game clock apart.

**Dataset size:** ~1,233 games × 12 Q2+ checkpoints = ~14,800 rows. After requiring 2 lookbacks (for 6-min trajectory): ~1,233 × 10 = ~12,330 rows.

---

## Phase 1: Data Pull

### Step 1a: Pull checkpoint data WITHOUT MC (fast)

Pull all games from `window_xgb_export` without the `mc=1` flag. This gives us floor, margin, and both feature vectors at every checkpoint. Fast — no MC simulation.

**Pagination:** batch=100 games per call, ~13 calls. Cache to `/tmp/trajectory_data.json`.

### Step 1b: Compute XGB win probabilities from features

Rather than pulling MC or using the production model, train an XGB model on the windowed features (same as `train_xgb_window.py`) using 5-fold stratified CV on game_id. Save OOF predictions — these ARE the XGB signal at each checkpoint.

**Why OOF instead of production model:** OOF prevents data leakage while giving us an unbiased estimate of XGB's probability at each checkpoint. Training on the same data would inflate signal quality.

### Step 1c: Pull MC values (second pass, with mc=1)

After proving trajectory concept with floor + XGB + margin, pull MC values by re-running with `mc=1&sims=200`. This is slower (~1-2 sec per game for MC sims) but only needed if Phase 2 shows trajectory adds value.

**Decision gate:** If trajectory features add < 0.005 AUC over point-in-time in Phase 2, skip MC pull and investigate why trajectory isn't helping before adding more data.

---

## Phase 2: Trajectory Feature Engineering

### 2a: Game-level chronological sort

Group all checkpoints by `gid`. Sort each game chronologically: Q2_9 → Q2_6 → Q2_3 → Q2_END → Q3_9 → ... → Q4_END.

Assign each checkpoint a `game_time` in minutes from game start:
- Q2_9 = 15 min (Q1=12 + 3 min into Q2)
- Q2_6 = 18 min
- Q2_3 = 21 min
- Q2_END = 24 min
- Q3_9 = 27 min
- ... etc.

Formula: `game_time = (period - 1) * 12 + (12 - clock_remaining)`

### 2b: Signal extraction at each checkpoint

For each checkpoint, extract:

| Signal | Source | Notes |
|--------|--------|-------|
| `floor` | `flr` field | Already ctrl-relative (0-1) |
| `xgb` | OOF prediction from Phase 1b | Ctrl-relative win prob (0-1) |
| `margin` | `mar` field | **MUST convert to ctrl-relative**: `mar * (1 if ctrl==hA else -1)` |
| `efg_diff` | `w[8]` | Windowed eFG differential (most important structural feature) |
| `paint_diff` | `w[0]` | Windowed paint differential |
| `biglead` | `w[9]` | Always cumulative even in windowed model |

### 2c: Trajectory features per signal

For each signal `S` at checkpoint index `i` within a game:

| Feature | Formula | Requires |
|---------|---------|----------|
| `S_now` | `S[i]` | 0 lookback |
| `S_delta_3m` | `S[i] - S[i-1]` | 1 lookback |
| `S_delta_6m` | `S[i] - S[i-2]` | 2 lookbacks |
| `S_trend` | `S_delta_3m / 3.0` (per-minute rate) | 1 lookback |
| `S_accel` | `S_delta_3m - (S[i-1] - S[i-2])` | 2 lookbacks |
| `S_vol_3` | `std(S[i], S[i-1], S[i-2])` | 2 lookbacks |

**6 trajectory features per signal × 4 primary signals = 24 trajectory features.**

### 2d: Divergence features (from May 13 findings)

| Feature | Formula | Rationale |
|---------|---------|-----------|
| `xgb_floor_gap` | `xgb - floor` | Floor anchoring detection |
| `xgb_margin_r` | `xgb - margin_normalized` | XGB independence from margin |
| `floor_high_xgb_low` | `floor > 0.65 AND xgb < 0.45` | Failure profile flag |
| `margin_velocity` | `margin_delta_3m` | Direct margin movement |
| `margin_accel` | `margin_delta_3m - margin_delta_prev_3m` | Margin momentum change |

**5 divergence features.**

### 2e: Game state features

| Feature | Source |
|---------|--------|
| `quarter` | Period (2/3/4) |
| `clock_pct` | Fraction of quarter remaining |
| `game_pct` | Fraction of full game elapsed |
| `is_trailing` | ctrl margin < 0 |
| `abs_margin` | Absolute margin (closeness proxy) |

**5 game state features.**

### Total feature count

| Category | Count |
|----------|-------|
| Point-in-time signals | 6 (floor, xgb, margin, efg_diff, paint_diff, biglead) |
| Trajectory features | 24 (6 per signal × 4 signals) |
| Divergence features | 5 |
| Game state features | 5 |
| **Total** | **40** |

### Minimum checkpoint requirement

Trajectory features need 2 lookbacks. First eligible checkpoint per game: 3rd Q2+ checkpoint = Q2_3 (have Q2_9 and Q2_6 as lookbacks).

---

## Phase 3: Model Training

### 3a: Baselines

Train 3 baseline models (all 5-fold stratified CV on game_id, XGBoost):

| Model | Features | Expected AUC |
|-------|----------|-------------|
| **B1: Point-in-time only** | floor, xgb, margin, quarter, clock_pct (5 features) | ~0.79-0.80 |
| **B2: Windowed XGB** | 13 windowed features (existing production model) | 0.786 |
| **B3: Kitchen sink point-in-time** | All 6 PIT signals + 5 game state + 5 divergence (16 features) | ~0.80-0.81 |

### 3b: Trajectory models

| Model | Features | Hypothesis |
|-------|----------|------------|
| **T1: PIT + trajectory (floor+xgb only)** | B1 + 12 trajectory features (floor + xgb trajectories) | Trajectory on the two most important signals |
| **T2: PIT + all trajectory** | B1 + 24 trajectory features | Full trajectory sweep |
| **T3: Full ensemble** | All 40 features | Kitchen sink — does it overfit or generalize? |

### 3c: Training config (match existing code)

```python
params = {
    'objective': 'binary:logistic',
    'eval_metric': 'auc',
    'max_depth': 4,
    'learning_rate': 0.05,
    'subsample': 0.8,
    'colsample_bytree': 0.8,
    'min_child_weight': 5,
    'seed': 42,
    'verbosity': 0,
}
# 300 rounds, early_stopping_rounds=30
```

For models with 40 features, consider `max_depth=5` and `colsample_bytree=0.6` to prevent overfitting.

---

## Phase 4: Evaluation

### 4a: Primary metrics

For each model, compute:
- Overall OOF AUC
- Brier score
- Per-quarter AUC (Q2, Q3, Q4)
- Per-quarter Brier

**Success threshold:** Trajectory model beats best point-in-time baseline by ≥ 0.01 AUC overall, with Q3-Q4 improvement ≥ 0.015. Below this, trajectory features are noise — kill the approach.

### 4b: Close game analysis

Filter to `abs(ctrl_margin) ≤ 8` at snapshot time. This is where trajectory should matter most — signals are ambiguous, trends break the tie.

- AUC in close games for each model
- Trajectory vs PIT delta in close games specifically

**Hypothesis:** Trajectory improvement concentrates in close games. Blowouts don't need trajectory — all signals agree.

### 4c: Lead-change game analysis

Identify games where ctrl team's margin changes sign (trailing → leading or vice versa) during the game. These are the highest-variance games and where anchoring failures live.

- How many lead-change games? (~25-35% of dataset based on prior research)
- AUC for trajectory model in lead-change vs non-lead-change
- Does trajectory specifically help in lead-change games?

### 4d: Feature importance analysis

From the best-performing trajectory model:
- SHAP importance ranking of all features
- Which trajectory features rank in top 10?
- Is `floor_delta_3m` more important than `floor_now`? (Would confirm the trajectory hypothesis)
- Which divergence features provide lift?

### 4e: Specific failure profile test

The May 13 finding: floor ≥ 0.65 + MC < 0.60 = 44% win rate (failure profile). Can trajectory features catch this without MC?

- Filter to checkpoints where `floor ≥ 0.65 AND xgb < 0.50`
- Does `floor_delta_3m < -0.05` (floor declining) predict losses better than static floor?
- What win rate does the trajectory model assign to this failure profile?

### 4f: Calibration check

- 10 bins, plot predicted prob vs actual win rate
- Is the trajectory model better calibrated than point-in-time?
- Especially check the 0.50-0.70 range where decisions are hardest

---

## Phase 5: Go / No-Go Criteria

### GO (trajectory features → production)

ALL of these:
- Overall AUC improvement ≥ 0.01 over B3 (kitchen sink PIT)
- Q4 AUC improvement ≥ 0.015
- Close game AUC improvement ≥ 0.02
- At least 2 trajectory features in SHAP top 10
- No evidence of overfitting (validation AUC stable across folds)

**If GO:** Proceed to MC-enriched version (add MC trajectory features from Phase 1c data), then spec production deployment.

### CONDITIONAL GO (trajectory features have signal, but marginal)

- Overall AUC improvement 0.005-0.01
- Trajectory helps in close games or lead-change games specifically
- Trajectory features show up in SHAP top 15 but not top 10

**If CONDITIONAL:** Don't build new model. Instead, inject the most impactful trajectory features (e.g., floor_delta_3m, margin_velocity) as agent context. The agent can reason about trends without a formal ensemble.

### NO-GO (trajectory is noise)

- AUC improvement < 0.005
- Trajectory features don't rank in SHAP top 15
- Or: trajectory model overfits (training AUC >> validation AUC)

**If NO-GO:** Kill trajectory approach. Signal trends at 3-minute resolution don't contain information beyond what point-in-time values already capture. Pivot to agent prompt improvements (XGB-MC divergence context, failure profile flag) which are already validated.

---

## Execution Plan

| Step | What | Time Estimate | Dependencies |
|------|------|---------------|-------------|
| 1a | Pull all checkpoint data (no MC) | ~3 min (13 API calls) | None |
| 1b | Train XGB OOF model, save predictions | ~2 min | Step 1a |
| 2 | Build trajectory features DataFrame | ~1 min | Step 1b |
| 3a | Train baselines (B1, B2, B3) | ~3 min | Step 2 |
| 3b | Train trajectory models (T1, T2, T3) | ~3 min | Step 2 |
| 4a-d | Evaluate all models | ~2 min | Step 3 |
| 4e-f | Failure profile + calibration | ~2 min | Step 3 |
| 5 | Go/No-Go decision | — | Step 4 |
| (1c) | Pull MC values (if GO) | ~15-20 min (slow) | Step 5 = GO |

**Total without MC: ~15-20 min.** All computation in Python in the sandbox. No code deployment, no Netlify changes, no DB modifications.

---

## What This Touches (Cascading Implications if GO)

**If trajectory proves out and we build a production ensemble:**

1. **poll-live-bdl.mjs:** New function `computeTrajectoryFeatures(snapshots)` reading recent snapshot history from DB. Adds ~50-100 lines. Needs to query last 2-3 snapshots for lookbacks.

2. **db-api.js:** No schema changes — trajectory computed on-the-fly from existing snapshots. Possibly a `get_recent_snapshots` helper if one doesn't exist.

3. **Agent prompt:** Trajectory signals injected as context (trend direction, divergence). ~15-20 lines of prompt additions.

4. **Model deployment:** New ensemble model JSON (~300-500KB) alongside existing xgb-model.json. `predictEnsemble()` function.

5. **Dashboard:** Optional trajectory visualization on signal strip. Low priority.

6. **Latency:** Each poll cycle now queries last 2-3 snapshots (~3ms DB read) + runs 40-feature prediction (~1ms). Negligible.

**Architecture question (surface before building):** Does the ensemble replace the existing windowed XGB, or run alongside it? If it replaces, every downstream consumer (EXIT thresholds, BUY gates, agent context) needs recalibration. If alongside, it's a second probability that the agent weighs — less disruptive but adds complexity.

---

## Risks

1. **3-minute checkpoint resolution may be too coarse.** Production polls every ~60 seconds. If trajectory signal lives in minute-level changes, our 3-minute checkpoints will miss it. Mitigation: if trajectory concept proves out at 3-min, we can compute finer-grained features from production snapshot data.

2. **Overfitting with 40 features on ~12K samples.** Mitigation: colsample_bytree=0.6, max_depth=4-5, early stopping. Monitor train-vs-val AUC gap.

3. **Trajectory features may just recapture margin.** If `margin_delta_3m` is the only useful trajectory feature, we haven't found a structural trend signal — we've just found margin velocity, which the agent already sees. Mitigation: test with and without margin trajectory features to isolate structural trajectory value.

4. **MC pull is slow.** ~1,233 games × 12 checkpoints × 200 sims = 2.96M simulations. At Netlify function timeout (~26s per call), need small batches. Mitigation: only pull MC if Phase 2 proves trajectory concept without it.

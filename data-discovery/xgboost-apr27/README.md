# XGBoost Data Discovery — April 27, 2026

## Overview

Trained XGBoost gradient-boosted tree models on the 1,235-game `nba_snapshot_backtest` table (16,910 snapshots) to evaluate whether machine-learned feature weights improve on hand-crafted I1-I5 indicator composites. Explored multiple feature sets, then cross-referenced the raw-stats model with floor scores, graduation ranks, and alert zones.

## Models

| Model | Features | AUC | Brier | Notes |
|-------|----------|-----|-------|-------|
| `xgb_model_full.json` | 21 feat incl. margin | 0.785 | 0.155 | Margin is 30% importance — mostly reads scoreboard |
| `xgb_structural.json` | 18 feat, no margin/biglead/eFG | 0.725 | 0.171 | Pure process, matches floor accuracy |
| `raw_model.json` | 14 raw stats + eFG + biglead | 0.758 | 0.163 | **Best structural model** — no indicators, no floor |

**Raw stats model is the recommended one.** Beats floor (AUC 0.691) by +6.7pp without using margin. eFG accounts for 4.4pp of that lift.

## Key Findings

### 1. BUY Zone Filter (Floor ≥ 0.65, trailing)
XGB confidence splits BUY-eligible snapshots dramatically:
- XGB < 40%: **7% win rate** (n=100)
- XGB 50-60%: **55%** (n=111)
- XGB 70%+: **89%** (n=90)

### 2. Combined Confidence Tiers
- **STRONG BUY** (floor ≥ 0.65, XGB ≥ 0.55, trailing): **76.2%** (156 games)
- **WEAK BUY** (floor ≥ 0.65, XGB < 0.45, trailing): **11.2%** (147 games)
- **EXIT SIGNAL** (floor ≥ 0.60, XGB < 0.40, Q3+): **3.5%** (205 games)
- **STRONG BWC** (both ≥ 0.65, leading): **93.2%** (1,187 games)

### 3. Graduation Enhancement (CORRECTED — BWC team perspective)

**Note:** Graduation labels were recomputed using the real `classifyBWCTier` logic (DOMINANT + lead≥8 + 4 holds + ≤1 opp indicator = A). Numbers track the BWC team (first team to fire), not the ctrl team at each snapshot. Sample sizes on A-rank XGB<0.55 are small (n=7) — treat as directional, validate with live data.

**A-rank peak:**
- XGB ≥ 0.55: **80.2%** (n=449) → XGB < 0.55: **14.3%** (n=7, small sample)

**B-rank peak (where XGB adds most value):**
- XGB ≥ 0.55: **62.3%** (n=355) → XGB < 0.55: **27.4%** (n=73)

**Zero flips:**
- XGB ≥ 0.55: **97.2%** (n=463) → XGB < 0.55: **32.1%** (n=28)

**2+ flips (biggest split — 717 games):**
- XGB ≥ 0.55: **69.2%** (n=491) → XGB < 0.55: **9.7%** (n=226)

**C→A graduation × XGB confidence tiers:**
- XGB 70-80%: 72.7% (n=44), XGB 80%+: 81.7% (n=372)

**C→B graduation × XGB confidence tiers:**
- XGB <40%: 23.1% (n=13), XGB 60-70%: 60.6% (n=94), XGB 70-80%: 69.0% (n=100)

**Discrepancy note:** Backtest tier journey reports C→A at 92.3% (n=842), our replication gets 78.7% (n=437). The backtest's graduation logic has checkpoint coverage and hold counting nuances not fully captured in the exported snapshot data. Exact graduation × XGB thresholds should be validated with live system graduation labels.

### 4. Shift Detection
XGB dropped below 0.50 before the floor in **100%** of games where the ctrl team lost (365/365). Average lead time: 30.5 minutes. (Note: floor by design can't drop below 0.50 for the ctrl team — it flips instead. So this measures XGB catching decay before the flip happens.)

### 5. Trailing Team Accuracy
When floor says BUY (≥ 0.65) and team is trailing:
- XGB agrees (> 0.50): **58.9%** win rate
- XGB disagrees (≤ 0.50): **29.6%** win rate

### 6. SHAP Feature Importance (raw model)
Top features by total SHAP across quarters:
1. Paint differential (escalates Q1→Q4)
2. eFG differential (controversial — variance vs structural)
3. Game progress
4. Offensive rebound differential
5. FTA differential

I3 (Shot Quality) and I5 (Momentum) rank lowest among indicators.

## Visualizations

- `viz1_matrix_buy.png` — Floor × XGB win rate heatmap + BUY zone gradient
- `viz2_tiers_grad.png` — Combined confidence tiers + graduation × XGB
- `viz3_flips_cal_wrong.png` — Control flips × XGB + calibration curves + floor failure catch rate
- `viz4_bwc_indicators.png` — BWC zone by XGB + indicator count × XGB
- `denmin_fixed.png` — DEN vs MIN series replay (fixed MIN perspective)
- `raw_xgb_replays.png` — 5-game replay (CLE@TOR, SAS@POR, GSW@SAC, POR@DEN, NYK@ATL)
- `shap_summary.png` — SHAP feature importance (full model with margin)

## Open Questions

- eFG drives 4.4pp of improvement but may reinforce unsustainable shooting variance
- XGB is trained on cumulative stats — same anchoring problem as floor, partially mitigated by game_progress feature
- Backtest uses in-sample model predictions (not OOF) for game replays — live performance may differ
- 1,235 games is strong but playoffs-only would be a useful subsample
- Graduation × XGB has a labeling discrepancy: our replication of `classifyBWCTier` produces different tier distributions than the backtest tier journey report (437 C→A vs 842 C→A). Checkpoint coverage, hold counting, or conv_tier mapping differences likely cause this. Live system graduation labels will provide ground truth for Phase 2 gate thresholds

## Next Steps

1. Wire `xgb_win_prob` into poll-live-bdl.mjs as advisory signal in agent prompt
2. Log on every snapshot for learning agent comparison
3. Use divergence as soft gate on BUY/BWC alerts
4. Track XGB accuracy vs floor accuracy per slate in learning agent
5. CLV tracking (#1 backlog) to validate whether XGB-confirmed alerts generate more CLV

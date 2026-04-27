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

### 3. Graduation Enhancement
- S-rank + XGB ≥ 0.55: **96.1%** → S-rank + XGB < 0.55: **52.0%**
- A-rank + XGB ≥ 0.55: **52.3%** → A-rank + XGB < 0.55: **22.5%**
- 0 flips + XGB ≥ 0.55: **97.5%** → 0 flips + XGB < 0.55: **4.8%** (catches 20/21 "impossible losses")

### 4. Shift Detection
XGB dropped below 0.50 before the floor in **100%** of games where the ctrl team lost (365/365). Average lead time: 30.5 minutes.

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

## Next Steps

1. Wire `xgb_win_prob` into poll-live-bdl.mjs as advisory signal in agent prompt
2. Log on every snapshot for learning agent comparison
3. Use divergence as soft gate on BUY/BWC alerts
4. Track XGB accuracy vs floor accuracy per slate in learning agent
5. CLV tracking (#1 backlog) to validate whether XGB-confirmed alerts generate more CLV

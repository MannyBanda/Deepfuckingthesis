# Windowed XGB + MC Cumulative Research Findings

**Date:** May 5, 2026  
**Dataset:** 14,440 checkpoints, ~1,233 games (nba_snapshot_backtest)  
**Methodology:** 5-fold stratified CV on game_id, OOF predictions for all metrics

---

## 1. XGB WINDOW COMPARISON

### 2Q Window vs 1Q Window vs Cumulative

| Model | Overall AUC | Brier | Q2 AUC | Q3 AUC | Q4 AUC |
|-------|------------|-------|--------|--------|--------|
| **2Q Window** | **0.7863** | **0.1457** | 0.6998 | **0.7877** | **0.8708** |
| 1Q Recency | 0.7728 | 0.1499 | **0.7022** | 0.7769 | 0.8549 |
| Cumulative | 0.7694 | 0.1502 | 0.6902 | 0.7621 | 0.8496 |

**Winner:** 2Q Window. Advantage grows with game time (Q4 delta = +0.021 vs cumulative).

### 2Q Window Definition (production cross-fade)

- Q2: fading(Q1) + building(Q2) — Q1 dies at Q2_END
- Q3: anchor(Q2) + building(Q3) — Q1 already dead, no re-introduction
- Q4: fading(Q2) + anchor(Q3) + building(Q4)
- Effective data: ~1Q in Q2 early, ramps to ~2Q by Q3, stays ~2Q through Q4

Fade formula: `previous_quarter_weight = 1.0 - (elapsed_minutes / 12)`

### Why 1Q Lost

At Q4_9 (3 min into Q4), 1Q only has Q3(0.75) + Q4(3min) ≈ 0.75 quarters. Hot 3-minute stretches whipsaw features. Model hedges with flatter probabilities, killing discriminative power.

### Feature Importance Shift (Windowed vs Cumulative, gain)

| Feature | Window | Cumul | Delta |
|---------|--------|-------|-------|
| efg | Higher | Lower | +2.1 (shooting efficiency gains importance) |
| oreb | Lower | Higher | Hustle stats drop |
| paint | Lower | Higher | Hustle stats drop |
| fta | Lower | Higher | Hustle stats drop |

Window strips noisy early-game hustle anchoring, surfaces current structural picture.

---

## 2. MC CUMULATIVE vs MC WINDOWED

### Overall AUC (ctrl team perspective)

| Quarter | MC Cumulative | MC 2Q Window | Floor |
|---------|--------------|-------------|-------|
| Q2 | **0.7075** | 0.6904 | 0.6510 |
| Q3 | **0.8056** | 0.7853 | 0.7130 |
| Q4 | **0.9009** | 0.8947 | 0.7448 |

**MC Cumulative wins every quarter.** Reason: MC simulates future possessions. More data = more stable rate estimates = better forward projection. Windowed rates overfit to recent hot/cold streaks.

### Architecture Implication

- **XGB wants recency** (2Q window) — classifies current structural state
- **MC wants volume** (cumulative) — projects forward scoring
- They complement because they look at different time horizons

---

## 3. MC CUMULATIVE AS PROBABILITY ANCHOR

### Overall Signal Comparison (all checkpoints)

| Signal | Overall AUC | Q2 | Q3 | Q4 |
|--------|------------|-----|-----|-----|
| **MC Cumulative** | **0.7938** | 0.7075 | 0.8056 | **0.9009** |
| XGB 2Q Window | 0.7863 | 0.7010 | 0.7849 | 0.8600 |
| Floor | ~0.70 | 0.6510 | 0.7130 | 0.7448 |

### When MC Cum and XGB Disagree (>15pp)

| Quarter | MC more bullish → MC right | XGB more bullish → XGB right |
|---------|---------------------------|------------------------------|
| Q2 | 70% | 48% |
| Q3 | 75% | 49% |
| Q4 | **87%** | 39% |

MC Cum dominates disagreements, especially in Q4.

### Signal Agreement Tiers

| Q4 Agreement | Win Rate | n |
|--------------|---------|---|
| ALL 3 high (MC+XGB+Floor) | **95.9%** | 2,213 |
| 2 of 3 | 80.9% | 591 |
| 1 of 3 | 54.0% | 430 |
| None | 40.4% | 349 |

### Correlation

MC Cum ↔ XGB 2Q: r = 0.71-0.76 (share signal but aren't redundant)

---

## 4. EXIT THRESHOLD ANALYSIS

### Graduated EXIT (floor ≥ 0.65 positions, windowed XGB)

| Threshold | Exits fire | Exit accuracy | Left hanging | Total damage |
|-----------|-----------|---------------|-------------|-------------|
| <0.35 | 87 (7%) | 65.5% | 303 | 333 |
| **<0.40** | 151 (12%) | **67.5%** | 258 | **307** |
| **<0.45** | 214 (17%) | **63.6%** | 224 | **302** ← minimum |
| <0.50 | 307 (25%) | 57.0% | 185 | 317 |
| <0.55 | 414 (34%) | 52.4% | 143 | 340 |

Total damage = premature exits + missed exits. Minimized at flat **<0.45**.

### EXIT Sharpening with MC Cum (Q4)

| Signal | EXIT accuracy | n |
|--------|-------------|---|
| XGB < 0.45 alone | 77.9% | 190 |
| + MC Cum < 0.45 confirms | **84.2%** | 146 |
| + MC Cum > 0.55 denies | 61.5% | 26 |

---

## 5. BUY CALIBRATION (CORRECTED — ctrl-relative margin)

**CRITICAL NOTE:** The backtest `margin_at_snapshot` field is home-away, NOT ctrl-relative. All trailing analyses must flip margin when ctrl is the away team.

### Corrected BUY (ctrl truly trailing + floor ≥ 0.65)

| Quarter | n | Base win rate | XGB ≥ 0.70 | XGB 0.55-0.70 | XGB < 0.45 |
|---------|---|--------------|-----------|--------------|-----------|
| Q2 | 270 | 47.4% | 50.4% (n=117) | 47.2% (n=53) | 50.0% (n=42) |
| Q3 | 213 | 39.0% | 65.0% (n=20) | 54.2% (n=48) | 27.8% (n=54) |
| Q4 | 152 | 36.8% | 64.3% (n=14) | 45.8% (n=59) | 19.4% (n=36) |

Small samples when truly trailing. Numbers are directional, not definitive.

### XGB Suppress Thresholds (ctrl trailing + floor ≥ 0.65)

| Quarter | XGB < 0.45 win rate | Verdict |
|---------|-------------------|---------|
| Q3 | 27.8% (n=54) | SUPPRESS |
| Q4 | 19.4% (n=36) | SUPPRESS |

---

## 6. TRAILING TEAM ANALYSIS (any team behind, regardless of ctrl)

### Trailing team AUC

| Quarter | MC Cum | MC 2Q | Floor |
|---------|--------|-------|-------|
| Q2 | **0.6844** | 0.6632 | 0.6413 |
| Q3 | **0.7836** | 0.7528 | 0.7071 |
| Q4 | **0.8612** | 0.8496 | 0.7314 |

### MC picking trailing team to win (trail MC ≥ 55%)

| Quarter | Win rate | n |
|---------|---------|---|
| Q2 | 52.3% | 306 |
| Q3 | 47.5% | 120 |
| Q4 | 53.8% | 13 |

MC alone picking a trailing team is roughly coin-flip.

### Compound trailing signal (Q3)

| Filter | Trail wins | n |
|--------|-----------|---|
| MC ≥ 50% alone | 47.7% | 199 |
| MC ≥ 50% + Floor ≥ 55% | **57.6%** | 66 |
| MC ≥ 55% + Floor ≥ 60% | **67.9%** | 28 |
| MC ≥ 60% + Floor ≥ 65% | **90.0%** | 10 |

Gradient is clear — compound confirmation works. But small samples.

### MC 2Q recency divergence (when recency and cumulative disagree)

| Q2 | Win rate | n |
|----|---------|---|
| 2Q ≥ 55% but Cum < 50% (pure hot streak) | 43.1% | 253 |
| Cum ≥ 55% but 2Q < 50% (underlying ability) | **58.5%** | 53 |

Cumulative ability > recent momentum for predicting trailing team comebacks.

---

## 7. CASE STUDY: DET @ ORL, May 1, 2026

Game ID: `0f33197a-1b98-4d0a-a313-5767f8e55d76`

ORL led by 22 at halftime, lost. MC Cum at halftime = 1.000 (correct — ORL should win from that position). By Q4 7:02 when DET took the lead, MC Cum dropped to ~0.441. But at Q4 2:34 (ORL down 13), floor still read 0.63 due to cumulative anchoring.

**Takeaway:** MC Cum caught the shift before floor did, but slower than PBP MC would have. Validates architecture: PBP MC for real-time canary, MC Cum for probability anchor, floor for structural control assessment.

---

## 8. MARGIN FIELD WARNING

The `nba_snapshot_backtest.margin_at_snapshot` column is **home_score - away_score** (raw scoreboard), NOT ctrl-team-relative. When ctrl is the away team, the margin appears negative even when ctrl is leading.

**Always convert:** `ctrl_margin = raw_margin * (ctrl == home_alias ? 1 : -1)`

Early analyses in this session used raw margin as "trailing" and produced inflated numbers (87.5% trailing win rate, 100% trail-16+). These were INCORRECT and have been corrected in the findings above.

---

## 9. PRODUCTION Q3 CROSS-FADE BUG IDENTIFIED

Both production `computeServerWindow` and backtest `phaseWindowXGBExport` had Q3 using only Q2(anchor) + Q3(building). This matches the intended design (Q1 dies during Q2, not Q3). The initial "fix" that re-introduced Q1 fading during Q3 was reverted after A/B testing showed the original approach produces better AUC (+0.003).

**No production fix needed** — current Q3 behavior is correct as designed.

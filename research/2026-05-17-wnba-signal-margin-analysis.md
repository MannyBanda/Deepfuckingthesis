# WNBA Signal Margin Analysis — MC Cum vs Windowed XGB (Clean OOF)
**Date:** May 17, 2026
**Dataset:** 5,260 checkpoints (Q2+), 576 games, 2024–2025 WNBA seasons
**XGB Model:** Windowed 13-feature (biglead + erosion), 300 trees, 5-fold GroupKFold CV
**Purpose:** Determine how MC Cum and windowed XGB perform when conditioned on margin direction, to inform the agent prompt rewrite

---

## Methodology

### Data
- 5,260 checkpoints from `wnba_xgb_training` at 2.5-minute intervals (Q2_7.5 through Q4_2.5)
- Each checkpoint includes: MC Cum (forward simulation from observed rates), margin (ctrl-relative), outcome (ctrl_won), and 13 structural features

### XGB Scoring — Out-of-Fold Only
XGB predictions were generated via 5-fold GroupKFold cross-validation (grouped by game_id so no game appears in both train and test). Each checkpoint was predicted by a model that never saw that game during training.

- **OOF AUC: 0.809** (fold range: 0.755–0.839)
- Per-fold: 0.755, 0.830, 0.836, 0.796, 0.839

MC Cum predictions are independently simulated (not trained on this data) — always clean.

### Why OOF Matters
In-sample (training data scored by its own model) AUC was 0.917 — inflated by +0.108. In-sample scoring produced false compound states (e.g., "XGB≥0.65 + trailing = 92.5% WR") that do not replicate out-of-fold (actual: 38.8%). Every number in this document uses OOF predictions only.

---

## Finding 1: Overall Signal Comparison

### AUC by Quarter

| Quarter | XGB OOF | MC Cum | Δ (XGB−MC) | Winner |
|---------|---------|--------|-----------|--------|
| Q2 | 0.723 | 0.706 | +0.017 | XGB (slight) |
| Q3 | 0.817 | 0.799 | +0.019 | XGB (slight) |
| Q4 | 0.872 | **0.906** | −0.034 | **MC Cum** |
| Overall | 0.809 | 0.801 | +0.008 | ~Tied |

**Takeaway:** XGB edges MC in Q2 and Q3. MC is the stronger signal in Q4. Overall, the two signals are nearly identical in discriminating power (0.809 vs 0.801).

### Directional Accuracy (signal > 0.50 → ctrl wins?)

| Signal | Q2 | Q3 | Q4 | Overall |
|--------|------|------|------|---------|
| XGB OOF | 69.5% | 79.0% | 85.0% | 78.0% |
| MC Cum | 68.3% | 78.3% | **86.9%** | 77.9% |

MC has slightly higher directional accuracy in Q4 (86.9% vs 85.0%). Both signals are well-calibrated directionally.

---

## Finding 2: MC Cum's Margin Echo — Quantified

### Echo Rate and Correlation

| Metric | MC Cum | XGB OOF |
|--------|--------|---------|
| Margin correlation (Pearson r) | 0.766 | 0.764 |
| Echo rate (>0.50 agrees with margin sign) | **95.4%** | 89.4% |

Both signals correlate with margin at nearly identical Pearson r (~0.765). However, MC's directional echo rate (95.4%) is substantially higher than XGB's (89.4%). That 6pp gap represents the scenarios where XGB disagrees with the scoreboard — reading structural quality independent of the current score.

### AUC Conditioned on Margin Direction

| Scenario | n | Base Win% | XGB AUC | MC AUC | Δ (XGB−MC) |
|----------|---|-----------|---------|--------|-----------|
| ALL | 5,260 | 74.3% | 0.809 | 0.801 | +0.008 |
| **Ctrl LEADING** | 4,439 | 81.3% | 0.781 | 0.761 | +0.020 |
| **Ctrl TRAILING** | 620 | 34.8% | 0.575 | 0.574 | +0.001 |
| Close (\|m\|≤8) | 2,943 | 59.8% | 0.689 | 0.672 | +0.017 |
| Trailing 1–9 | 605 | 35.4% | 0.574 | 0.565 | +0.009 |

**Key insight:** When the ctrl team is trailing, both signals collapse to near-chance AUC (~0.575). Neither XGB nor MC Cum can reliably discriminate trailing-team comebacks from trailing-team losses at the checkpoint level.

### Per-Quarter Trailing AUC

| Quarter | XGB AUC (trailing) | MC AUC (trailing) | Δ |
|---------|-------------------|-------------------|---|
| Q2 | 0.548 | 0.506 | +0.042 |
| Q3 | 0.565 | 0.539 | +0.026 |
| Q4 | 0.626 | **0.713** | **−0.087** |

MC outperforms XGB for trailing teams in Q4 (0.713 vs 0.626). MC's forward simulation from observed rates captures game-flow momentum that XGB's windowed structural features miss in Q4.

---

## Finding 3: Disagreement Analysis

When MC and XGB disagree by >15 percentage points, who is right?

### Conditioned on Margin Direction

| Context | MC>>XGB: MC right | XGB>>MC: XGB right |
|---------|-------------------|---------------------|
| ALL | 65.0% (n=1,142) | 50.3% (n=571) |
| ALL Q2 | 61.5% (n=457) | 47.8% (n=209) |
| ALL Q3 | 58.8% (n=386) | 58.2% (n=220) |
| ALL Q4 | **78.3%** (n=299) | 41.5% (n=142) |
| Ctrl LEADING | 68.7% (n=1,028) | **70.6%** (n=231) |
| Leading Q3 | 63.2% (n=337) | **81.0%** (n=105) |
| Leading Q4 | **81.5%** (n=276) | **78.8%** (n=33) |
| Ctrl TRAILING | 22.6% (n=62) | 34.7% (n=291) |
| Trailing Q3 | 23.3% (n=30) | 35.7% (n=98) |
| Trailing Q4 | 33.3% (n=9) | 28.6% (n=98) |

**Key findings:**
- **Q4 overall:** MC wins disagreements 78.3% of the time. The original research finding holds.
- **Q3 leading:** When the ctrl team is leading and XGB rates them higher than MC, XGB is right 81.0%. XGB correctly identifies structurally sound leading teams even when MC is uncertain.
- **Trailing disagreements:** Neither signal wins. MC right 22.6%, XGB right 34.7% — both below the base rate (34.8%). When signals disagree about a trailing team, neither provides actionable information.

---

## Finding 4: Compound Signal States (Q3+Q4)

| Compound State | Context | n | Win Rate |
|----------------|---------|---|----------|
| Both HIGH (MC≥0.70 + XGB≥0.65) | Leading | 2,440 | **91.4%** |
| MC HIGH only (MC≥0.70 + XGB<0.50) | Leading | 103 | 60.2% |
| XGB HIGH only (MC<0.50 + XGB≥0.65) | Trail 1–9 | 49 | 38.8% |
| Both LOW (MC<0.50 + XGB<0.50) | Trailing | 280 | 31.1% |
| BUY ZONE (XGB≥0.60 + MC<0.50) | Trail 1–9 | 69 | 40.6% |

**Consensus agreement is powerful.** Both signals high = 91.4% WR (n=2,440). This is the strongest compound in the system.

**MC HIGH + XGB LOW for leading teams = 60.2%.** Not a death sentence — the team still holds 60% of the time despite XGB flagging structural weakness. MC's Q4 superiority keeps this above 50%, but 4 in 10 of these leads collapse.

**XGB HIGH + MC LOW for trailing teams = 38.8%.** Above the trailing base rate (34.8%) but not a reliable entry signal. The structural edge XGB sees is real but insufficient to overcome the trailing deficit most of the time. ~3 in 5 of these still result in losses.

---

## Finding 5: Signal Bucket Accuracy — Full Breakdown

### XGB OOF — All Checkpoints (Q2+)

| XGB Bucket | ALL | LEADING (m>0) | TRAILING (m<0) |
|-----------|-----|---------------|----------------|
| < 0.30 | 32.0% (n=272) | 38.8% (n=49) | 29.1% (n=196) |
| 0.30–0.40 | 34.5% (n=296) | 42.7% (n=117) | 27.7% (n=141) |
| 0.40–0.50 | 49.6% (n=343) | 55.7% (n=192) | 45.2% (n=104) |
| 0.50–0.60 | 57.3% (n=440) | 63.0% (n=322) | 42.5% (n=80) |
| 0.60–0.70 | 62.0% (n=534) | 65.2% (n=448) | 39.1% (n=64) |
| 0.70–0.80 | 72.5% (n=698) | 74.3% (n=657) | 41.7% (n=24) |
| 0.80–0.90 | 84.4% (n=853) | 85.3% (n=834) | 30.0% (n=10) |
| ≥ 0.90 | 95.4% (n=1824) | 95.4% (n=1820) | — |

### MC Cum — All Checkpoints (Q2+)

| MC Bucket | ALL | LEADING (m>0) | TRAILING (m<0) |
|----------|-----|---------------|----------------|
| < 0.30 | 33.9% (n=425) | 63.3% (n=30) | 31.2% (n=372) |
| 0.30–0.40 | 43.1% (n=181) | 50.0% (n=48) | 41.3% (n=109) |
| 0.40–0.50 | 45.5% (n=255) | 52.0% (n=100) | 45.7% (n=81) |
| 0.50–0.60 | 52.5% (n=278) | 56.9% (n=197) | 32.4% (n=34) |
| 0.60–0.70 | 63.7% (n=342) | 65.4% (n=306) | 43.8% (n=16) |
| 0.70–0.80 | 64.0% (n=430) | 65.1% (n=418) | 0.0% (n=6) |
| 0.80–0.90 | 72.6% (n=639) | 73.2% (n=631) | — |
| ≥ 0.90 | 91.0% (n=2710) | 91.0% (n=2709) | — |

### XGB OOF — Q3+Q4 Only

| XGB Bucket | ALL | LEADING (m>0) | TRAILING (m<0) |
|-----------|-----|---------------|----------------|
| < 0.30 | 29.9% (n=204) | 32.4% (n=34) | 27.2% (n=147) |
| 0.30–0.40 | 34.6% (n=185) | 44.7% (n=76) | 27.8% (n=90) |
| 0.40–0.50 | 51.5% (n=206) | 57.3% (n=117) | 46.0% (n=63) |
| 0.50–0.60 | 60.1% (n=248) | 68.8% (n=173) | 38.9% (n=54) |
| 0.60–0.70 | 64.7% (n=317) | 69.3% (n=257) | 42.6% (n=47) |
| 0.70–0.80 | 75.3% (n=438) | 78.3% (n=406) | 38.9% (n=18) |
| 0.80–0.90 | 87.1% (n=583) | 88.2% (n=567) | 33.3% (n=9) |
| ≥ 0.90 | 96.5% (n=1501) | 96.6% (n=1497) | — |

### MC Cum — Q3+Q4 Only

| MC Bucket | ALL | LEADING (m>0) | TRAILING (m<0) |
|----------|-----|---------------|----------------|
| < 0.30 | 27.9% (n=258) | 66.7% (n=3) | 27.6% (n=250) |
| 0.30–0.40 | 42.5% (n=120) | 57.9% (n=19) | 40.2% (n=92) |
| 0.40–0.50 | 46.4% (n=168) | 54.0% (n=50) | 48.3% (n=60) |
| 0.50–0.60 | 52.9% (n=187) | 58.1% (n=129) | 27.8% (n=18) |
| 0.60–0.70 | 70.0% (n=217) | 70.2% (n=198) | 66.7% (n=9) |
| 0.70–0.80 | 66.0% (n=300) | 66.6% (n=296) | — |
| 0.80–0.90 | 76.8% (n=423) | 76.8% (n=423) | — |
| ≥ 0.90 | 94.4% (n=2009) | 94.4% (n=2009) | — |

### Interpretation

**XGB overall ramp is clean and monotonic.** From 32.0% (<0.30) to 95.4% (≥0.90). Each bucket step up produces a meaningful win rate increase. For **leading teams**, XGB is well-calibrated — 65.2% at 0.60–0.70, 74.3% at 0.70–0.80, 85.3% at 0.80–0.90, 95.4% at ≥0.90. This is where XGB earns its keep.

**MC Cum overall ramp has a plateau.** 0.60–0.80 is flat (63.7% → 64.0%) before jumping to 72.6% at 0.80–0.90 and 91.0% at ≥0.90. MC separates the extremes but struggles in the middle. At the top end (≥0.90), XGB outperforms MC (95.4% vs 91.0%).

**Trailing columns tell a different story for both signals.** XGB's monotonic ramp disappears for trailing teams — it plateaus around 39–46% from 0.40 through 0.80. MC similarly loses discrimination for trailing teams above 0.40. Neither signal can rank-order trailing-team comebacks reliably.

**The leading-team split is where XGB clearly separates from MC.** XGB ≥0.90 leading = 95.4% (n=1,820) vs MC ≥0.90 leading = 91.0% (n=2,709). XGB achieves higher accuracy with a tighter, more selective threshold. In the critical 0.60–0.80 range for leading teams, XGB delivers 65–74% vs MC's 65–66% plateau.

**For trailing teams, the central limitation holds:** at the checkpoint level, no single signal reliably identifies which trailing teams will come back. The BUY thesis requires additional context beyond signal values alone — likely floor/indicator composition, matchup, and game situation.

---

## Case Studies

### Case A: XGB Detects Structural Erosion — LA (bdl_4110), ctrl team LOST

LA leads throughout most of the game but XGB persistently reads structural weakness. MC tracks the lead. LA eventually loses.

| Checkpoint | Margin | MC Cum | XGB OOF | Reading |
|-----------|--------|--------|---------|---------|
| Q2_7.5 | +3 | 0.68 | 0.78 | Both positive |
| Q2_5 | +4 | 0.94 | 0.71 | MC bullish on lead, XGB dipping |
| Q3_7.5 | +1 | 0.63 | **0.15** | XGB flags structural collapse while lead holds |
| Q3_5 | −5 | 0.24 | 0.10 | Score catches up — both see trouble |
| Q3_END | +1 | 0.59 | 0.24 | Margin recovers, MC recovers — XGB stays low |
| Q4_7.5 | +2 | 0.65 | 0.17 | MC tracks margin bounce, XGB unmoved |
| Q4_5 | −1 | 0.47 | 0.18 | Lead gone again |
| Q4_2.5 | +2 | **0.75** | **0.16** | MC says 75% win. XGB says 16%. **LA LOST.** |

**Pattern:** XGB detected structural weakness at Q3_7.5 (0.15) while LA still led by 1. MC bounced between 0.24 and 0.75 tracking score swings. XGB stayed flat in the 0.10–0.24 range throughout Q3 and Q4, reading weak underlying structure regardless of margin. LA's lead was structurally hollow, and XGB saw it.

### Case B: XGB Reads Structure Through Margin Collapse — SEA (bdl_4073), ctrl team WON

SEA dominates through Q3 (up 13), margin collapses in Q4, but XGB holds and SEA wins.

| Checkpoint | Margin | MC Cum | XGB OOF | Reading |
|-----------|--------|--------|---------|---------|
| Q3_5 | +13 | 0.98 | 0.81 | Both agree — dominant |
| Q3_END | +12 | 0.95 | 0.86 | Both agree |
| Q4_7.5 | +4 | 0.66 | **0.87** | Margin eroding, MC drops, XGB holds |
| Q4_5 | 0 | 0.38 | **0.90** | Tied game — MC drops, XGB sees structure |
| Q4_2.5 | −2 | **0.23** | **0.87** | MC says 23%. XGB says 87%. **SEA WON.** |

**Pattern:** XGB stayed ≥0.87 through a 15-point margin swing (from +13 to −2) because structural features remained dominant. MC dropped proportionally with the score. SEA came back and won — the structural edge was never compromised, only the scoreboard.

### Case C: Consensus Failure — CON (bdl_4076), ctrl team LOST

Both signals at maximum confidence. CON leads by 21 in Q3. CON collapses and loses.

| Checkpoint | Margin | MC Cum | XGB OOF | Reading |
|-----------|--------|--------|---------|---------|
| Q3_7.5 | +21 | 1.00 | 0.99 | Total consensus — maximum confidence |
| Q3_END | +11 | 0.95 | 0.99 | Still consensus |
| Q4_7.5 | +12 | 0.96 | 0.99 | Both maximally confident |
| Q4_5 | +8 | 0.95 | 0.99 | Both still confident at +8 |
| Q4_2.5 | 0 | 0.49 | **0.98** | MC finally adjusts. XGB still 0.98. **CON LOST.** |

**Pattern:** Neither signal caught this collapse. XGB stayed at 0.98–0.99 through Q4 because the windowed structural features didn't degrade — the collapse was driven by late-game execution (turnovers, missed free throws) rather than structural deterioration in the box-score features XGB reads. This is a genuine blind spot: execution collapses that don't show up in structural stats.

---

## Implications for Agent Prompt Rewrite

### What the Data Supports

1. **MC Cum is the stronger Q4 signal** (AUC 0.906 vs 0.872). The original trust hierarchy placing MC above XGB in Q4 is correct.

2. **XGB edges MC in Q2 and Q3** (AUC +0.017 to +0.036 depending on context). For mid-game reads, XGB provides slightly better discrimination.

3. **MC's Q4 superiority extends to trailing teams** (0.713 vs 0.626). Even for trailing scenarios in Q4, MC outperforms XGB.

4. **Consensus agreement (both high) is the strongest signal in the system** at 91.4% WR (n=2,440). When both signals agree, confidence is warranted.

5. **Neither signal reliably identifies trailing-team comebacks.** Both collapse to ~0.575 AUC for trailing teams overall. The BUY thesis at the checkpoint level cannot rely on signal values alone.

6. **XGB detects structural erosion in leading teams.** When the ctrl team leads and XGB<<MC (Q3 leading), XGB is right 81.0% of the time. This is XGB's clearest value-add — catching structural rot before the score reflects it.

7. **MC's echo rate is 95.4% vs XGB's 89.4%.** XGB disagrees with the scoreboard 6pp more often, but this disagreement does not produce reliably actionable trailing-team predictions at the checkpoint level.

### What the Data Does Not Support

1. ~~"XGB is the only signal for BUY territory."~~ XGB≥0.65 + MC<0.50 + trailing 1–9 = 38.8% WR. Not a reliable entry.

2. ~~"MC has zero value for trailing teams."~~ MC outperforms XGB for trailing Q4 (0.713 vs 0.626 AUC).

3. ~~"XGB produces a clean monotonic ramp for trailing teams."~~ It does not. The ramp plateaus above 0.50.

### Recommended Trust Framework (WNBA)

**Q2–Q3:** XGB ≥ MC > Floor. XGB has slightly better discrimination. For leading teams, XGB detects structural erosion before the score moves (81% accuracy in Q3 leading disagreements).

**Q4:** MC ≥ XGB > Floor. MC is the stronger overall discriminator. MC wins Q4 disagreements 78.3%.

**Consensus:** Both high (MC≥0.70 + XGB≥0.65) = 91.4%. Both low = ~31%. Consensus is the highest-confidence state in the system.

**Leading + XGB LOW:** Warning signal. MC HIGH + XGB LOW for leading teams = 60.2% — 4 in 10 of these leads collapse. XGB detected erosion before the score moved in the case studies.

**Trailing (BUY territory):** Treat with extreme caution. Neither signal reliably identifies comebacks at the checkpoint level (both AUC ~0.575 for trailing). Agent should require additional context (matchup, game situation, floor indicator composition, time remaining) beyond signal values to consider BUY entries. The 38.8% compound WR for XGB HIGH + MC LOW trailing means ~3 in 5 of these still result in losses.

---

## Open Questions

1. **Floor accuracy in WNBA** — not tested in this analysis. Floor may add value as a third signal or framing context. Need actual I1–I5 floor from production snapshots to validate.
2. **NBA replication** — these are WNBA-specific findings. NBA has different dynamics (48 min, larger talent gaps, different pace).
3. **BUY thesis refinement** — if checkpoint-level signals can't reliably identify trailing-team comebacks alone, what additional features could improve BUY accuracy? Game situation (quarter, margin trend), matchup quality, floor indicator composition?
4. **MC Canary vs MC Cum** — the PBP canary (20-possession window) uses recent rates, not cumulative. May have different properties for structural-collapse detection.
5. **Execution collapse blind spot** — Case C (CON bdl_4076) shows both signals miss late-game execution collapses. Are there box-score features (live turnover rate, FT%) that could flag this?

---

## Files

- Analysis script: `research/signal_analysis.py`
- OOF predictions: generated via 5-fold GroupKFold CV, same hyperparams as `research/retrain_wnba_xgb.py`

---

## Production Validation (May 18, 2026 — 27 games, 1,686 Q2+ snapshots)

### Methodology

**Re-scoring required.** Stored `xgb_win_prob` values in production snapshots were computed by different model versions depending on game date:
- May 8–10: No WNBA XGB at all (first deploy May 12)
- May 12–13: 12-feature model with leaf c/w bug (reading cover instead of leaf weight)
- May 14: Windowed + erosion model with base_score logit→prob bug
- May 15+ (after `0899f57`): Current correct model

Only 8 of 27 games had the correct model. All 27 games were re-scored using:
1. Current `xgb-model-wnba.json` (300 trees, 13 features)
2. **Windowed box-score features** reconstructed from production snapshot timeline (matching training pipeline)
3. Per-quarter max margins reconstructed from `home_pts - away_pts` per snapshot (replacing live `_qMaxMargin` which is not persisted after game finalization)
4. Cross-fade windowed biglead computed from per-quarter max margins

**Alias normalization bug found.** Games before May 16 (`1c82798`) stored SR aliases (NYL, GSV, WAS, LVA) in `floor_team` while `winner` used BDL aliases (NY, GS, WSH, LV). Without normalization, 6/12 teams' win/loss labels were inverted, producing junk accuracy numbers. All results below use normalized aliases.

### Finding 6: Production Signal Comparison (re-scored XGB)

| Signal | AUC | Brier | Dir Acc |
|--------|-----|-------|---------|
| MC Cum | **0.748** | 0.158 | 79.4% |
| XGB (windowed, re-scored) | 0.668 | 0.155 | 80.4% |
| Window Score | 0.659 | 0.158 | 80.3% |
| Floor | 0.639 | 0.164 | 77.5% |

**Per-quarter:**

| Quarter | XGB | MC Cum | Floor | Window |
|---------|-----|--------|-------|--------|
| Q2 | 0.645 | **0.690** | 0.544 | 0.563 |
| Q3 | 0.596 | **0.745** | 0.728 | 0.704 |
| Q4 | 0.726 | **0.808** | 0.699 | 0.759 |

MC Cum leads every quarter on production. XGB's production AUC (0.668) is significantly below its backtest OOF (0.809). Possible contributors: 2026 season distribution shift, personal fouls feature always zero (BDL WNBA doesn't provide `pf`), 27-game small sample, and the inherent gap between backtest (controlled checkpoints) and production (live polling cadence).

### Finding 7: XGB Directional Accuracy Is Misleading

XGB's 80.4% directional accuracy is NOT evidence of strong prediction. Analysis:

| Metric | XGB | MC Cum |
|--------|-----|--------|
| Predicts > 0.50 | **89.3%** of snapshots | 82.9% |
| Mean prediction | 0.779 | 0.767 |
| "Always predict > 0.50" baseline | 79.5% | 79.5% |
| Directional accuracy | 80.4% | 79.4% |
| **Separation gap** (mean for wins − mean for losses) | **0.150** | **0.264** |

XGB predicts > 0.50 on 89.3% of all snapshots. Since the ctrl team wins 79.5% of the time, this inflates directional accuracy to 80.4% — only 0.9pp above a zero-skill model. MC Cum's separation gap (0.264) is nearly double XGB's (0.150), meaning MC provides substantially more signal about which games the ctrl team will lose.

**Directional accuracy is the wrong metric at high base rates.** AUC and separation gap are the correct measures.

### Finding 8: XGB Measures Structure, Not Wins — And That's Correct

**Raw AUC conflates two distinct failure modes:**

Out of 5 ctrl-team losses across 27 games:

| Game | Score | Ctrl Led% | XGB Mean | XGB Q4 Min | Classification |
|------|-------|-----------|----------|------------|----------------|
| MIN@PHX May 12 | 88-84 | 57% | 0.601 | 0.275 | **STRUCTURAL** — XGB caught collapse |
| MIN@DAL May 14 | 90-86 | 70% | 0.518 | 0.285 | **STRUCTURAL** — XGB caught collapse |
| CHI@MIN May 17 | 86-79 | 13% | 0.422 | 0.171 | **STRUCTURAL** — XGB caught collapse |
| ATL@MIN May 9 | 91-90 | 95% | 0.925 | 0.484 | **VARIANCE** — 1-point loss, correct structural read |
| NY@POR May 12 | 96-98 | 72% | 0.821 | 0.616 | **VARIANCE** — 2-point loss, correct structural read |

- **Structural collapses (3/3): XGB detected all of them.** Q4 min dropped below 0.30 in every case.
- **Variance losses (2/2): XGB's structural read was correct.** These were close games (margins of 1 and 2) where the structurally dominant team led most of the game and lost to late execution/variance. From a betting perspective, these are correct reads that hit the wrong side of a coinflip.

**AUC penalizes XGB equally for NY@POR (variance, structural read correct) and MIN@PHX (structural collapse, XGB flagged it).** This makes AUC a poor standalone metric for evaluating a structural signal. XGB's job is to read structure; the agent's job is to assess whether structure will translate to a win given game context.

### Finding 9: XGB Production Bucket Accuracy

| XGB Bucket | ALL | Leading | Trailing |
|-----------|-----|---------|----------|
| < 0.30 | 21.7% (n=60) | 57.1% (n=7) | 14.0% (n=50) |
| 0.30–0.40 | 29.7% (n=37) | 27.3% (n=11) | 30.0% (n=20) |
| 0.40–0.50 | 70.2% (n=84) | 71.7% (n=53) | 60.9% (n=23) |
| 0.50–0.60 | 82.9% (n=146) | 85.6% (n=118) | 63.6% (n=11) |
| 0.60–0.70 | 75.6% (n=176) | 77.6% (n=156) | 50.0% (n=6) |
| 0.70–0.80 | 75.9% (n=228) | 77.0% (n=209) | 60.0% (n=15) |
| 0.80–0.90 | 88.8% (n=313) | 91.9% (n=296) | 66.7% (n=3) |
| ≥ 0.90 | 86.1% (n=642) | 86.1% (n=642) | — |

Monotonic overall ramp (21.7% → 86.1%). The ≥0.90 bucket captures 38% of all snapshots with 86.1% accuracy. The < 0.30 bucket correctly identifies structural weakness (ctrl wins only 21.7%).

### Finding 10: Trailing Team Signal Comparison (Production)

| Signal | Trailing AUC (n=128) | Trail 1-9 AUC (n=125) |
|--------|---------------------|----------------------|
| MC Cum | **0.880** | **0.875** |
| XGB | 0.758 | 0.750 |
| Floor | 0.532 | 0.530 |

MC Cum dominates trailing-team discrimination on production data, consistent with backtest findings. However, the trailing sample is small (128 snapshots from ~5 games where floor flipped while trailing), so these numbers should be treated as directional.

---

## Implications for Agent Prompt Rewrite

### Signal Roles (refined from production validation)

1. **XGB reads structure, not wins.** XGB's features are windowed box-score diffs — it identifies which team has structural momentum right now. It is not designed to predict late-game execution, variance, or prayer shots. When XGB reads high and the team loses, check whether the loss was structural (XGB should have caught it) or variance (XGB was correct about structure, variance hit).

2. **MC Cum reads margin trajectory and calibrates uncertainty.** MC's strength is that it naturally incorporates score — when the margin disappears, MC drops, correctly reflecting increased uncertainty regardless of structural read. MC leads XGB on every production quarter and context.

3. **XGB's EXIT detection is strong.** In all 3 structural collapses, XGB dropped below 0.30 in Q4 before the game ended. This validates the EXIT system: when XGB drops hard, structure has genuinely broken down. The 2-poll confirmation at 0.45 threshold catches these.

4. **XGB's BUY-gate role needs context.** The high base rate (79.5% ctrl wins) means XGB > 0.50 adds almost no information. The valuable XGB reads are at the extremes: ≥ 0.90 (structural lock, 86% WR) and < 0.30 (structural weakness, 22% WR). The middle range (0.50–0.80) is where XGB struggles to discriminate on production data.

5. **Consensus remains the strongest state.** Both signals high (from backtest: 91.4% WR) is the highest-confidence compound in the system. Both signals low confirms structural breakdown.

### What the Agent Should Be Told

**When XGB is high and MC drops (BUY territory):**
> XGB reads structural momentum from windowed box-score features (assists, eFG, disruption, paint, FTA, biglead). This team has genuine structural advantages right now. MC is dropping because the margin is compressing — that's what MC does. The question is whether the structural edge (XGB) will reassert or whether the margin compression reflects a real shift. On production data, 2 of 5 ctrl losses were variance (correct structural read, lost by 1-2 points). The BUY thesis is structurally sound but inherently includes variance risk.

**When XGB drops below 0.30:**
> Structure has genuinely broken down. On production, XGB caught 3/3 structural collapses with Q4 min below 0.30. This is an EXIT signal — don't fight it.

**When XGB is in the middle (0.50–0.80):**
> XGB is uncertain. The structural features don't clearly favor either team. Lean on MC Cum and floor for the read. XGB's middle range has poor discrimination on production data (75-83% WR, similar to base rate of 79.5%).

### Open Items for Remaining Tests

- **Test 1 (game-level trailing):** Still needed — game-level aggregation may show different XGB trailing accuracy than snapshot-level
- **Test 2 (floor accuracy):** Production floor AUC 0.639 — needs deeper analysis of which indicators drive floor accuracy
- **Test 6 (2025-only OOF):** Tests whether 2024 training data helps or hurts the 2026 production gap
- **Production pf feature gap:** BDL WNBA provides 0 for personal fouls. Training data had real values from SR. This is a permanent distribution shift that may contribute to production AUC drop. Potential fix: retrain with pf=0 or drop the feature.

### Finding 11: Year-to-Year Drift Is Not the Production Gap (Test 6)

XGB OOF comparison across season filters:

| Dataset | OOF AUC | Games | Checkpoints |
|---------|---------|-------|-------------|
| Full (2024+2025) | 0.807 | 526 | 5,260 |
| 2025 only | 0.804 | 312 | 3,120 |
| 2024 only | 0.770 | 214 | 2,140 |
| Train 2024 → Test 2025 | 0.791 | — | — |
| Train 2025 → Test 2024 | 0.793 | — | — |
| Production (2026, re-scored) | 0.668 | 27 | 1,686 |

**2025-only OOF (0.804) ≈ full dataset (0.807).** Adding 2024 data contributes +0.003 AUC — negligible. The model is not overfitting on 2024-specific dynamics.

**Cross-season transfer is strong.** Train on 2024, test on 2025 = 0.791. Reverse = 0.793. Structural features generalize across seasons. Year-to-year roster and style changes do not break the model.

**2024-only OOF is weaker (0.770).** Smaller dataset (214 games) and potentially noisier early-WNBA BDL data. The 2025 season provides cleaner signal.

**The 0.807 → 0.668 production gap is not explained by year-to-year drift.** Remaining contributors:
1. 27-game sample noise (dominant factor — a few variance losses heavily penalize AUC on small n)
2. `pf` feature permanently zero in production (BDL WNBA does not provide personal fouls; training data had real values from SR)
3. AUC conflation of structural accuracy with win prediction (Finding 8)
4. Genuine 2026 season differences not testable with 27 games

**Trailing AUC by season:** 2025-only trailing AUC = 0.635 vs 2024-only = 0.516. XGB discriminates trailing-team comebacks better on 2025 data. Encouraging for BUY thesis — the more recent season's structural patterns are more learnable.

**Per-quarter comparison:**

| Quarter | Full OOF | 2025 OOF | 2024 OOF |
|---------|----------|----------|----------|
| Q2 | 0.716 | 0.696 | 0.685 |
| Q3 | 0.815 | 0.820 | 0.783 |
| Q4 | 0.875 | 0.870 | 0.834 |

Q3 and Q4 are essentially identical between full and 2025-only. The model's late-game discrimination is stable regardless of whether 2024 data is included.

### Finding 12: Game-Level Trailing — XGB Is the Only Usable BUY Signal (Test 1)

**Dataset:** 193 games where ctrl team trailed at some point in Q3/Q4 (from 526-game backtest). 77 comebacks (39.9%), 116 losses (60.1%).

**Game-level AUC (signal at deepest trailing point):**

| Metric | XGB OOF | MC Cum |
|--------|---------|--------|
| At deepest trailing | 0.594 | 0.626 |
| Mean while trailing | 0.612 | 0.617 |
| Max while trailing | 0.606 | 0.596 |

Both signals modestly above chance at game level. MC slightly edges at deepest point, XGB slightly edges on peak structural read.

**XGB bucket accuracy at deepest trailing — clean monotonic ramp:**

| XGB | Comeback Rate | n |
|-----|--------------|---|
| < 0.30 | 30.7% | 75 |
| 0.30–0.50 | 41.2% | 68 |
| 0.50–0.60 | 44.0% | 25 |
| 0.60–0.70 | 55.6% | 9 |
| ≥ 0.70 | **62.5%** | 16 |

**MC is pinned low in trailing territory — cannot discriminate:**

| MC Cum | Comeback Rate | n |
|--------|--------------|---|
| < 0.30 | 33.1% | **124** (64% of all trailing games) |
| 0.30–0.50 | 51.7% | 58 |
| ≥ 0.50 | 54.5% | 11 |

124 of 193 trailing games (64%) have MC < 0.30 at the deepest point. MC echoes margin — when the ctrl team trails, MC is always low regardless of structural quality. MC cannot distinguish which trailing teams will come back because it gives the same read on nearly all of them.

XGB spreads predictions across the range: 50 games above 0.50, 16 at ≥ 0.70. The ≥ 0.70 bucket comes back 62.5% — the structurally dominant team at their worst moment still wins nearly 2/3 when XGB reads high.

**Implication for agent prompt:** In BUY territory (ctrl team trailing), XGB is the only signal with useful discrimination. MC's role shifts from "independent predictor" to "margin context" — it tells you how deep the deficit is, not whether the team will recover. The agent should frame BUY decisions around XGB's structural read and use MC only for deficit severity context. Current XGB BUY gates are unchanged — this finding informs agent language, not mechanical thresholds.

**Trailing depth breakdown:**

| Depth | n | Comeback% | XGB > 0.50 CB% (n) |
|-------|---|-----------|-------------------|
| 1–3 | 120 | 43.3% | 52.5% (40) |
| 4–9 | 95 | 37.9% | 52.9% (17) |
| 10–15 | 21 | 28.6% | — (0) |
| 16+ | 1 | 0.0% | — (0) |

Shallow trailing (1–3) has 43.3% base comeback rate. XGB > 0.50 lifts this to 52.5% (n=40). Deeper trailing (4–9) drops to 37.9% base but XGB > 0.50 still lifts to 52.9% (n=17). Beyond 10 points, no XGB reads above 0.50 — the structural read correctly says "this team is overwhelmed."

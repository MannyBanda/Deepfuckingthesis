# WNBA Architecture Research Findings
**Date:** May 8, 2026
**Dataset:** 312 BDL games, 203 with SR summaries, 3,432 checkpoint rows (Q2+ with valid window)
**Methodology:** Production-faithful cross-fade window, per-checkpoint ctrl determination, game-level 5-fold OOF

---

## 1. Feature Discovery

### AUC Ranking (per-feature, Q4, no biglead)
Features computed ctrl-relative at each 2.5-min checkpoint.

| Feature | Q4 AUC | Signal |
|---------|--------|--------|
| c_ftm | 0.801 | Free throws made — execution/aggression |
| c_fta | 0.772 | Drawing contact |
| c_pot | 0.753 | Points off turnovers — conversion efficiency |
| c_ast | 0.736 | Ball movement |
| c_fbp | 0.736 | Fast break points — transition |
| c_stl | 0.725 | Disruption |
| c_to_ratio | 0.724 | Steal/TO ratio — disruption efficiency |
| c_efg | 0.681 | Shooting efficiency (I3 anchor in indicators) |

### Confirmed from indicator work
- **c_paint = 0.500** at every quarter — coin flip. Paint is noise in WNBA.
- **c_to = 0.282 Q4** — strongly inverse. More turnovers = more aggressive = winning.
- **c_pf = 0.260 Q4** — inverse. Fouling more = playing harder.
- **c_3pr = 0.487** — 3PT percentage is noise. But c_3pa (volume) = 0.603 — taking threes matters, making them doesn't predict.

### Indicator weight challenge
SHAP data doesn't disagree with indicators existing but challenges weights:
- I4 (biglead/game control) massively under-weighted at 25% — dominates when included
- I3 (eFG anchor at 30%) is 8th by AUC, below POT and steals
- I5 (momentum/runs) has 0.500 AUC — no signal

**Decision:** Indicator weights are a narrative concern, not an XGB concern. Indicators stay for agent context.

---

## 2. XGB Model

### Architecture
- **Cross-fade window** matching NBA production computeServerWindow:
  - Q2: Q1(fading) + Q2(partial)
  - Q3: Q2(anchor) + Q3(partial)
  - Q4: Q2(fading) + Q3(anchor) + Q4(partial)
- **10-minute WNBA quarters** (not 12-min NBA)
- **Per-checkpoint ctrl determination** (no look-ahead bias)
- **No biglead, no margin** — both create anchoring/scoreboard dependency
- **Min 5 FGA volume gate** for window activation

### Biglead exclusion rationale
- Windowed biglead produced 0.833 AUC but was doing 4x SHAP of everything else
- Biggest lead in a quarter is partially circular with winning that quarter
- Same production problem as NBA DET@ORL — biglead SHAP locks at peak permanently
- Without biglead: windowed collapsed to 0.608 (biglead in a trench coat)
- Cumulative held at 0.783 — structural features carry real signal independently

### Locked model
- **12 features, OOF AUC: 0.809 +/- 0.006** (5 random seeds)
- **Hyperparams:** depth 3, 400 trees, lr 0.03, subsample 0.8, colsample 0.8, min_child_weight 3

| Feature | Type | SHAP rank | Signal |
|---------|------|-----------|--------|
| c_ast | CUM | 1 | Ball movement dominance |
| c_ftm | CUM | 2 | FT execution / aggression |
| c_ast_ratio | CUM | 3 | Structured offense (assisted FG%) |
| w_dreb | WIN | 4 | Recent defensive rebounding shift |
| w_3pa | WIN | 5 | Recent 3PT volume shift |
| c_3pa | CUM | 6 | Perimeter scheme commitment |
| c_pot | CUM | 7 | Turnover conversion |
| w_fta | WIN | 8 | Recent FT drawing shift |
| c_oreb | CUM | 9 | Offensive rebounding |
| w_ftm | WIN | 10 | Recent FT execution shift |
| w_pot | WIN | 11 | Recent turnover conversion shift |
| w_ast_ratio | WIN | 12 | Recent assisted FG shift |

### Feature trimming decision
Forward selection found 6 features at 0.819 AUC vs 12 at 0.811 (+0.008). Kept all 12 because:
- AUC difference is noise (0.008)
- Agent SHAP context from all 12 features is more valuable than marginal AUC
- Even low-SHAP features provide agent context (knowing a feature ISN'T contributing is informative)

### Per-checkpoint AUC (locked model)
| Checkpoint | AUC | n |
|------------|-----|---|
| Q2_7.5 | 0.688 | 312 |
| Q2_5 | 0.699 | 312 |
| Q2_2.5 | 0.723 | 312 |
| Q3_7.5 | 0.760 | 312 |
| Q3_5 | 0.786 | 312 |
| Q3_2.5 | 0.804 | 312 |
| Q3_END | 0.793 | 312 |
| Q4_7.5 | 0.872 | 312 |
| Q4_5 | 0.880 | 312 |
| Q4_2.5 | 0.909 | 312 |

### Calibration
- 0.5-1.0 range within 1.2pp everywhere
- 0.3-0.5 bucket runs 7.6pp hot (model slightly pessimistic on low-confidence reads — safe direction)

### Collapse detection: XGB vs Floor
When floor >= 0.65 but ctrl team loses:
- Floor separation (wins vs losses): **0.054** — can't tell the difference
- XGB separation: **0.165** — 3x better
- 33% of high-floor losses have XGB below 0.60

---

## 3. Monte Carlo Cumulative

### WNBA League Baselines (312 games, fixed 3PT classification)
| Rate | WNBA | NBA | Delta |
|------|------|-----|-------|
| fg3aShare | 0.345 | 0.350 | -0.005 |
| fg3Pct | 0.347 | 0.360 | -0.013 |
| fg2Pct | 0.482 | 0.520 | -0.038 |
| toRate | 0.178 | 0.130 | +0.048 |
| orebRate | 0.348 | 0.250 | +0.098 |
| ftaRate | 0.224 | 0.220 | +0.004 |
| ftPct | 0.788 | 0.760 | +0.028 |

Key differences: WNBA has higher TO rate, much higher OREB rate, lower 2PT%.

### MC AUC — per checkpoint
| Checkpoint | MC | XGB | Floor |
|------------|-----|-----|-------|
| Q2_7.5 | 0.657 | 0.688 | 0.631 |
| Q2_5 | 0.716 | 0.699 | 0.645 |
| Q2_2.5 | 0.761 | 0.723 | 0.666 |
| Q3_5 | 0.779 | 0.786 | 0.675 |
| Q3_END | 0.894 | 0.793 | 0.749 |
| Q4_5 | 0.971 | 0.880 | 0.803 |
| Q4_2.5 | 0.998 | 0.909 | 0.851 |
| **Overall** | **0.822** | **0.809** | **0.708** |

MC wins every checkpoint from Q2_5 onward. XGB leads slightly at Q2_7.5 only.

### MC Calibration by quarter
**Q2:** Overconfident. MC 0.8-0.9 bucket: actual 65.2% (-19.8pp). Same as NBA Q2.

**Q3:** Best calibrated.
- MC 0.6-0.7: actual 65.2% (+0.2pp — perfect)
- MC 0.7-0.8: actual 71.2% (-3.8pp)
- MC 0.8-0.9: actual 78.7% (-6.3pp)

**Q4:** Underconfident (different from NBA).
- MC 0.7-0.8: actual 89.2% (+14.2pp)
- MC 0.8-0.9: actual 93.3% (+8.3pp)
- MC 0.9-1.0: actual 99.4% (+4.4pp)

NBA Q4 MC was perfectly calibrated (0.1pp off). WNBA Q4 MC underestimates — structural advantages hold MORE reliably in shorter games with fewer remaining possessions.

### PBP 3PT classification fix
Original PBP reconstruction only checked type field for 3PT identification. BDL puts "three point" and "3-pointer" in the text field for misses. Fix applied to all 3 reconstruction blocks + added ev.shooting_play as shot detection trigger. This moved fg3aShare from 0.120 to 0.345 and fg3Pct from 1.000 to 0.347.

---

## 4. Compound Signal Analysis

### Three-signal agreement (MC>=0.70 + XGB>=0.65 + Floor>=0.65)
- **All HIGH: 91.6%** accuracy (Q2=82.9%, Q3=91.1%, Q4=98.6%)
- **MC+XGB HIGH, Floor LOW: 83-86%** — floor irrelevant when MC+XGB agree
- **Floor HIGH, MC+XGB both LOW: 20.2%** — cumulative anchoring. Floor confidently wrong.
- **MC HIGH + XGB LOW: 64.0%** — MC leads in disagreements
- **XGB HIGH + MC LOW: 42.9%** — don't trust XGB over MC

### Signal role conclusion
- **MC Cum** = best single predictor, win probability anchor
- **XGB** = structural quality + collapse detector, 3x floor discrimination on losses
- **Floor** = narrative context only. Never gates decisions. When floor disagrees with MC+XGB, floor is wrong 80% of the time.

---

## 5. Compound Establishment Thresholds

### Chosen config: MC>=0.85 + XGB>=0.60, 2 checkpoint holds (~5 poll holds)
- **Accuracy: 90.9%** (89.6% Q2-confirmed, 93.2% Q3-confirmed)
- **Coverage: 82%** (257 of 312 games)
- **Median confirmation: Q2_2.5** (53% confirm by Q2_2.5, 88% by Q3_END)

### Accuracy by confirmation timing
| Confirmed at | Accuracy | n |
|-------------|----------|---|
| Q2 | 89.6% | 134 |
| Q3 | 93.2% | 88 |
| Q4 | 90.0% | 30 |

Accuracy is stable regardless of when compound fires. Early confirmations are not worse.

### Loss profile (23 losses from 252 confirmed games)
- **100% were leading** at confirmation (avg margin +10.3)
- MC at confirmation: avg 0.964
- XGB at confirmation: avg 0.868
- 14 confirmed in Q2, 6 in Q3, 3 in Q4
- All are blown leads — structural dominance that collapsed

### vs NBA reference
- NBA CONFIRMED (MC>=0.80 + Floor>=0.65, 5 poll holds): 86%
- NBA LOCKED (10+ holds): 92%
- **WNBA compound at 90.9% exceeds NBA CONFIRMED by ~5pp** but base rate is higher (88.7% vs ~83%)

---

## 6. EXIT Thresholds

### XGB EXIT sweep (post-compound confirmation)
| Threshold | Exits | True | False | Precision | Recall |
|-----------|-------|------|-------|-----------|--------|
| XGB<0.35 | 20 | 13 | 7 | 65.0% | 46.4% |
| XGB<0.40 | 26 | 16 | 10 | 61.5% | 57.1% |
| **XGB<0.45** | **36** | **21** | **15** | **58.3%** | **75.0%** |
| XGB<0.50 | 46 | 22 | 24 | 47.8% | 78.6% |

**Recommended: XGB<0.45 with 2-poll confirmation** (matching NBA pattern).
- Catches 75% of compound losses
- 58.3% precision improvable with confirmation + MC gate
- Q4-specific XGB<0.35 at 71.4% precision for tight late-game exits

---

## 7. BUY Gate Values

### Finding: insufficient data for WNBA-specific BUY gates
- Only 103 trailing checkpoints from 259 confirmed games
- 83% of trailing checkpoints are down 1-4 points only
- Overall comeback rate: 44.7% (lower than NBA)

### Structural finding
WNBA confirmed teams rarely trail significantly. Structural dominance is more durable in 40-min games — BUY window is inherently narrower than NBA. When the dominant team trails, deficits are small (1-4 points) and brief.

**Recommendation:** Port NBA BUY thresholds as starting point (trailing 1-15, compound confirmed), tune with live production data.

---

## 8. PBP Canary (Directional)

### Proxy test: 3-checkpoint lookback rates (~7.5 min = 15-20 possessions)
Using combined trigger: PBP MC<0.70 OR (floor - PBP MC) > 0.15

- **Canary fired BEFORE lead lost:** 20 of 45 compound losses (44%)
- **Average margin when canary fired:** +5.1 (team still leading)
- **Median early warning:** 2 checkpoints (5 min before lead lost)
- **False positive rate:** 64% of winning games also triggered

### Conclusion
PBP canary detects structural deterioration before the scoreboard. Raw precision is too low (17.5%) — needs investigation pipeline (CLEAN/WAVE/NORMALIZED pattern classification) to be actionable. Same as NBA.

**Deferred:** Building possession logs server-side from bdl_pbp for proper canary investigation testing.

---

## 9. Architecture Decision

### Signal hierarchy
1. **MC Cum + XGB** = co-primary compound (establishment, PO, monitoring)
2. **Floor/Indicators** = narrative context for agent and subscribers (WHY, not WHETHER)
3. **PBP Canary** = early warning trigger -> investigation pipeline -> collapse classification

### Lifecycle
```
XGB+MC compound met (MC>=0.85, XGB>=0.60) -> TRACKING (1st hold)
    |
Compound sustained 2 checkpoints -> POSITION OPEN
    |
Compound team trailing, MC+XGB still strong -> BUY
    (Agent uses floor/SHAP for narrative)
    |
MC trajectory declining -> EDGE / position monitoring
    |
XGB drops below 0.45 (2-poll confirmed) -> EXIT
PBP canary fires -> investigation -> CLEAN pattern -> MC_COLLAPSE
```

### What changes from NBA
- Floor demoted from decision gate to narrative layer
- No checkpoint graduation system — compound signal sustaining replaces MF/minF
- XGB+MC compound replaces MC+Floor compound
- Simpler state machine — fewer states, clearer transitions

### What stays same as NBA
- Agent is narrator for all downstream alerts
- PBP trajectory signals (T1-T8) feed agent as event context
- State machine lifecycle structure
- PBP canary -> investigation -> pattern pipeline
- Alerts route through agent for SEND/SUPPRESS
- ntfy push alerts in plain English

---

## 10. Open Items for Production Tuning
- Sustain threshold relaxation (establishment MC>=0.85/XGB>=0.60, sustain TBD)
- BUY gate values (insufficient backtest data, tune with live games)
- PBP possession logs for proper canary investigation
- Canary investigation patterns (CLEAN/WAVE/NORMALIZED) on WNBA data
- XGB model file export (xgb-model-wnba.json)
- WNBA-specific agent prompt rules
- Per-quarter EXIT thresholds (flat 0.45 vs quarter-specific)

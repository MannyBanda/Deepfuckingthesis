# Market Edge Test #1 — Does structure diverge from the live line, and does it pay?
**Date:** 2026-06-09
**Status:** COMPLETE — findings validated OOS
**Hypothesis:** Our structural models (XGB, MC Cum) contain information beyond the live betting line. If true, model-vs-line divergence should (A) produce +EV bets settled at stored lines, and (B) predict line movement toward the model.

## Data
- Source: production `snapshots` joined to `odds_history` (both written every poll cycle since odds-api integration).
- Join rule: each snapshot paired with the FIRST odds row at ts >= snapshot ts, within 120s (forward pairing kills the stale-quote artifact). Median pairing lag: 0s (same poll cycle).
- Markets dropped when |ML| > 2500 (dead). p_line = devigged two-sided implied prob from best-line MLs.
- xgb_win_prob / mc_cum_win_prob converted ctrl-relative -> home-relative via floor_team (WNBA SR aliases normalized via ALIAS_MAP).
- **Coverage [FACT:prod]:** NBA 64 usable games, 4,987 pairs (2026-04-21 -> 06-05, ALL PLAYOFFS — regime caveat). WNBA 83 games, 5,588 pairs (05-08 -> 06-08).
- OOS protocol: per league, weights/thresholds set on first 70% of games by date, evaluated on last 30%.

## Findings

### 1. Same-subset AUC (Q2+ rows where MC exists) [FACT:prod]
| | LINE | XGB | MC |
|---|---|---|---|
| NBA all | 0.827 | 0.802 | **0.831** |
| NBA Q2 | **0.819** | 0.753 | 0.788 |
| NBA Q3 | 0.783 | 0.797 | **0.816** |
| NBA Q4 | 0.904 | 0.867 | **0.935** |
| WNBA all | **0.821** | 0.740 | 0.772 |
| WNBA Q2 | **0.784** | 0.756 | 0.731 |
| WNBA Q3 | **0.826** | 0.765 | 0.796 |
| WNBA Q4 | **0.848** | 0.684 | 0.818 |

NBA Q3 is the only window where BOTH models beat the line. WNBA: line wins every quarter.

### 2. OOS incremental information (headline result)
winner ~ logit(p_line) + logit(p_xgb), fit IS, evaluated OOS, per-game cluster bootstrap on LL delta:
- **NBA: +0.0044 per-row LL [95% CI +0.0017, +0.0075], 14/19 OOS games improved, P(delta>0) = 100%.** XGB adds real information beyond the playoff live line. [PRIOR — MED-n: 19 OOS games]
- **WNBA: -0.0085 [CI -0.0262, +0.0087], 10/23 improved, P = 18%.** Structure adds nothing beyond the line; point estimate negative. [PRIOR — MED-n]

### 3. Test A — terminal ROI of divergence bets (first crossing per game, settle at stored best line)
- NBA pooled D>=0.20: XGB +11.9% (n=59), MC +15.0% (n=55) — CIs span zero. NBA OOS positive for every threshold/model (n=13-19, LOW-n, ordering only).
- **NBA Q3-entry: XGB D>=0.10 n=50, IS +10% / OOS +48%, win 54%. MC D>=0.10 n=52, IS +17% / OOS +28%, win 67%.** Directionally consistent IS->OOS. LOW-n: no precision claims, ordering only.
- **WNBA: classic overfit signature — IS +42-90%, OOS -32% to -70% across every model/threshold. DEAD.**

### 4. Stale-quote control (delayed execution)
Bet at the line observed 60s/120s AFTER the signal: NBA MC ROI decays +15.0 -> +11.8 -> +8.7; XGB +11.9 -> +8.1 -> +7.4; WNBA flat. Edge is not a data-latency artifact. 5% price haircut (best-line optimism bound) leaves NBA MC at +9.2%.

### 5. Test B — line convergence (does the market come to us in 5-10 min?)
Weak. NBA XGB +10min: +0.66pp toward model vs -0.67pp baseline (~1.3pp net) — real but small. MC "convergence" fully explained by baseline drift (leaders' lines rise as clock burns). Head-to-head where XGB and MC disagree on direction: NBA line follows MC 57/43 short-term (line follows scoreboard).
**Implication: the edge pays through terminal outcomes, not fast line compression. The 5-10 min cash-out channel is NOT where the measurable alpha lives.**

## Verdicts
1. **NBA structure is real alpha vs the playoff live line, concentrated in Q3.** Cleanest stat: OOS LL delta CI excludes zero on game-cluster bootstrap.
2. **WNBA: the market beats every model we have. Do not bet WNBA model-vs-line divergence.** Consistent with BDL WNBA data fidelity issues and XGB WNBA Q4 AUC 0.684.
3. MC Q4 NBA (AUC 0.935 vs line 0.904) confirms MC's late-game sharpness from prior backtests, now vs the market directly.
4. Test B reframes the product: divergence is a HOLD-to-resolution signal, not a scalp signal.

## Caveats / provenance
- NBA dataset is 100% playoffs (small team pool, repeated matchups; cluster bootstrap mitigates row correlation, not team correlation).
- Best-line both sides inflates ROI vs single-book execution (~5pp haircut bound provided).
- Q3 policy n=45-52 — LOW per rigor cutoffs. The DIRECTION is validated; the magnitudes are not.
- Regular-season NBA replication required when season resumes; keep logging odds_history (it's free — already wired).

## Next steps (proposed, not committed)
1. Keep accumulating: every game logged grows the only dataset that defines edge.
2. Spec a "divergence monitor" read on the dashboard: p_line vs p_xgb vs p_mc at-a-glance + alert when NBA Q3 divergence crosses threshold. (Decision support, not automation.)
3. Proceed to assessment item #2: feed pregame/live spread into XGB as a feature — this test doubles as the dataset for it.

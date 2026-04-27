# XGBoost Integration Spec — DFT System

**Author:** Claude (lead engineer)
**Date:** April 27, 2026
**Status:** SPEC — awaiting Manny's alignment before implementation
**Based on:** 1,235-game backtest, 16,910 snapshots, raw stats model (AUC 0.758 vs floor 0.691)

---

## 1. What XGBoost Solves

The floor score is a hand-crafted composite of five indicators (I1-I5) that measures structural process control. It's good at identifying which team dominates the process. It's bad at three things the data proved:

**A. Confidence calibration.** The floor says 0.75 in games that are genuinely 55/45. When the floor says BUY at 0.65+ and the team is trailing, it's right only 44.8% of the time. XGBoost splits that into 58.9% (XGB agrees) vs 29.6% (XGB disagrees). That's a 29-point spread on the same floor reading.

**B. Structural shift detection.** In 100% of games where the control team lost (365/365), XGBoost dropped below 0.50 before the floor recognized the shift. The floor can't drop below 0.50 for the ctrl team by design — it just eventually flips. XGBoost sees the decay in raw stats before the indicator composites cross their thresholds.

**C. Graduation validation.** A-rank peak with XGB agreement is 80.2%; without it, 14.3% (small sample, n=7). B-rank splits 62.3% / 27.4% (n=73 disagreements). Zero-flip games split 97.2% / 32.1%. The biggest actionable split: 2+ flip games go from 69.2% (XGB agrees) to 9.7% (XGB disagrees) across 717 games. The graduation system identifies process consistency; XGBoost validates whether that consistency reflects genuine structural quality or inflated indicators. Exact graduation × XGB thresholds need validation with live system graduation labels — our backtest replication has a labeling discrepancy vs the tier journey report.

---

## 2. Model Architecture

### 2.1 Model: `raw_model.json`
- **Algorithm:** XGBoost gradient-boosted trees, 300 estimators, max_depth=5
- **Training data:** 16,910 snapshots across 1,235 NBA games (nba_snapshot_backtest table)
- **Validation:** 5-fold GroupKFold (no game leakage between folds)
- **OOF AUC:** 0.758 (vs floor 0.691)
- **File size:** ~745KB JSON

### 2.2 Features (14 inputs, all ctrl-team-relative)

| # | Feature | Source in poll loop | Notes |
|---|---------|-------------------|-------|
| 1 | game_progress | period + clock → elapsed/2880 | 0.0 = tipoff, 1.0 = end of Q4 |
| 2 | ctrl_paint_diff | `hs.points_in_the_paint - as.points_in_the_paint` × flip | Already computed in computeServer as hPaint/aPaint |
| 3 | ctrl_pot_diff | `hs.points_off_turnovers - as.points_off_turnovers` × flip | Already computed as hPOT/aPOT |
| 4 | ctrl_to_diff | `hs.turnovers - as.turnovers` × flip | Sign: positive = ctrl has MORE turnovers (bad) |
| 5 | ctrl_stl_diff | `hs.steals - as.steals` × flip | |
| 6 | ctrl_oreb_diff | `hs.offensive_rebounds - as.offensive_rebounds` × flip | |
| 7 | ctrl_ast_diff | `hs.assists - as.assists` × flip | |
| 8 | ctrl_blk_diff | `hs.blocks - as.blocks` × flip | Escalates Q1→Q4 per SHAP |
| 9 | ctrl_fta_diff | `hs.free_throws_att - as.free_throws_att` × flip | |
| 10 | ctrl_efg_diff | eFG% differential × flip | (fgm + 0.5×fg3m)/fga per team |
| 11 | ctrl_biglead_diff | `hs.biggest_lead - as.biggest_lead` × flip | Game control signal, not margin proxy (+0.4pp AUC) |
| 12 | ctrl_3pr_diff | 3PT attempt rate differential × flip | Shot diet, not results |
| 13 | ctrl_rim_pct_diff | Rim FG% differential × flip | atRimM/atRimA per team |
| 14 | ctrl_run_share | ctrl team's 6-0 runs / total runs | From pbpResult.runs6 |

**`flip`** = 1 if ctrl team is home, -1 if away. Converts home-relative raw stats to ctrl-team-relative.

**Features NOT included (intentionally):** margin, I1-I5 scores, floor_score, TP/LS, sustainability grades. XGBoost learns its own weights from raw stats independently of the framework.

### 2.3 Feature Availability in Live Data

All 14 features are available after `computeServer()` runs in the poll loop. The summary object (`summary.home.statistics` / `summary.away.statistics`) contains every stat field. `pbpResult.runs6` provides run data. No additional API calls needed.

**Two features have degraded live coverage:**
- `ctrl_rim_pct_diff` (feature 13): `field_goals_at_rim_made/att` comes from SR game summary, not BDL. When SR data is unavailable, use 0 (neutral). Impact: rim_pct_diff is ranked 14th by SHAP — minimal degradation.
- `ctrl_run_share` (feature 14): requires PBP data. When pbpResult is null, use 0.5 (neutral). Impact: ranked 11th by SHAP.

These are the same placeholders used in the game replay analysis. The model was validated with these placeholders on live data.

---

## 3. Implementation Plan

### 3.1 Pure JS Inference Engine (~80 lines)

**No npm dependency.** XGBoost's JSON model format is an array of decision trees. Each tree is a set of nodes with split conditions. Inference = traverse each tree, sum leaf values, apply sigmoid. I'll write a `predictXGB(modelJson, features)` function in pure JS that:

1. Loads the model JSON once at function cold start
2. For each tree, traverses from root following split conditions
3. Sums all leaf values
4. Applies sigmoid: `1 / (1 + Math.exp(-sum))`

Single-digit milliseconds per prediction. No native bindings, no bundle size impact.

**Location:** Top of `poll-live-bdl.mjs`, loaded once via `JSON.parse(fs.readFileSync(...))` at module scope.

### 3.2 Feature Extraction Function (~40 lines)

```
function extractXGBFeatures(summary, ind, pbpResult, currentPeriod, clock) → Float32Array[14]
```

Runs after `computeServer()`, takes the same summary + pbpResult objects. Returns the 14-element feature vector. Handles:
- ctrl-team-relative flipping using `ind.controlTeam` and `ind.homeAlias`
- Missing rim stats (SR unavailable) → 0
- Missing runs (PBP unavailable) → 0.5
- Game progress calculation from period + clock

### 3.3 Integration Point in Poll Loop

After `computeServer()` returns `ind`, before alert evaluation:

```
const xgbFeatures = extractXGBFeatures(summary, ind, pbpResult, currentPeriod, clock);
const xgbWinProb = predictXGB(XGB_MODEL, xgbFeatures);
const xgbDivergence = xgbWinProb - ind.score;
const xgbAligned = Math.abs(xgbDivergence) < 0.15;
```

These values flow into three consumers: snapshot persistence, alert evaluation, and agent prompt.

---

## 4. Database Changes

### 4.1 Snapshots Table

```sql
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS xgb_win_prob REAL;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS xgb_divergence REAL;
```

Saved on every snapshot alongside floor_score. Enables post-hoc analysis by learning agent and debug dashboard.

### 4.2 Alerts Table

```sql
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS xgb_win_prob REAL;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS xgb_aligned BOOLEAN;
```

Stamped at alert-fire time. Learning agent uses this to compare XGB-aligned vs XGB-divergent alert accuracy.

### 4.3 Init Migration

Add columns via `?action=init` endpoint in db-api.js. Standard `ADD COLUMN IF NOT EXISTS` pattern.

---

## 5. Alert System Changes

### 5.1 Philosophy

XGBoost is **advisory for the first 2 weeks**, then promoted to harder gates based on learning agent data. During advisory phase, `xgb_win_prob` and `xgb_aligned` are logged on every alert and snapshot, and the divergence is fed to the agent prompt, but no mechanical gates change.

### 5.2 Advisory Phase (ship first)

**Agent prompt addition.** After the existing context block, add one line:

```
XGB STRUCTURAL READ: {xgbWinProb}% ctrl win probability (Floor: {floor}). {ALIGNED | ⚠️ DIVERGENT {divergence}%}.
```

The agent already reasons over TP, LS, sustainability, conviction. This gives it one more empirical signal. When divergence is large, the agent has data-backed justification to suppress.

**No mechanical gates change.** BUY/BWC/EXIT thresholds stay the same. The agent decides what to do with the XGB signal.

### 5.3 Gate Phase (ship after 2+ weeks of data)

Based on backtest findings, these are the gates to evaluate once live data confirms:

| Alert Type | Gate | Backtest Evidence |
|-----------|------|-------------------|
| BUY (trailing) | XGB < 0.40 → hard suppress | 7% win rate at floor≥0.65, XGB<40% |
| BUY (trailing) | XGB ≥ 0.55 → confidence boost | 76.2% win rate (STRONG BUY tier) |
| BWC (leading) | XGB < 0.40 → hard suppress | 6.1% win rate |
| EXIT | XGB < 0.40 + Q3+ → fire XGB_EXIT_WARNING | 3.5% win rate (EXIT SIGNAL tier) |
| POSITION_SAFE | XGB < 0.50 → suppress reassurance | Don't confirm a position XGB doubts |
| Graduation | XGB < 0.55 at graduation → downgrade confidence | B-rank drops to 27.4%, 2+ flips to 9.7%. A-rank sample too small (n=7) for hard gate — validate live |

**These gates are NOT implemented in the advisory phase.** They're documented here as the spec for promotion. The learning agent accumulates the data to validate each gate threshold.

---

## 6. Learning Agent Changes

### 6.1 Arc-Level XGB Tracking

The post-game learning agent already builds arcs from alerts. Add to arc analysis:

- `xgb_at_entry`: XGB win prob at first BUY/BWC fire
- `xgb_at_terminal`: XGB win prob at last non-TRACKING alert
- `xgb_aligned_at_entry`: boolean
- `xgb_min_during_arc`: lowest XGB during the arc (early warning detection)

### 6.2 Nightly Comparison

Add to the Sonnet analysis prompt:

```
XGB ACCURACY THIS SLATE:
- Alerts where XGB aligned (>0.50): X/Y correct (Z%)
- Alerts where XGB divergent (<0.50): X/Y correct (Z%)
- XGB would have suppressed N alerts, M of which were wrong
```

### 6.3 Rolling Metrics

Track in learnings table or separate:
- XGB-aligned alert accuracy (rolling 7-day, 30-day)
- XGB-divergent alert accuracy (same windows)
- XGB gate simulation: "if we had suppressed XGB<0.40 BUYs, accuracy would have been X%"

---

## 7. Dashboard Changes (v3.html)

### 7.1 Snapshot Display

Add `xgb_win_prob` to the snapshot detail view. Display as a small bar or number next to floor score. Color: green when aligned, amber/red when divergent.

### 7.2 Game Card

Add XGB agreement indicator to the game card header. Simple icon: ✓ (aligned) or ⚠️ (divergent >15%).

### 7.3 Debug Dashboard

Add to Section 6 (Alert Accuracy):
- Filter by XGB-aligned vs XGB-divergent
- Show accuracy split in summary cards
- XGB accuracy column in detail table

---

## 8. Cascading Implications

### 8.1 What Changes
- Snapshot save adds 2 columns (xgb_win_prob, xgb_divergence)
- Alert save adds 2 columns (xgb_win_prob, xgb_aligned)
- Agent prompt gets one additional context line
- Learning agent gets XGB comparison metrics
- Model JSON file added to repo (~745KB)

### 8.2 What Does NOT Change
- I1-I5 indicator computation (unchanged)
- Floor score calculation (unchanged)
- Alert thresholds (unchanged in advisory phase)
- Graduation logic (unchanged in advisory phase)
- TP/LS computation (unchanged)
- Sustainability audit (unchanged)
- BWC state machine (unchanged)
- Client-side analysis (unchanged — XGB is server-only)

### 8.3 Performance Impact
- Cold start: ~50ms to parse 745KB JSON (once per function invocation)
- Inference: <1ms per prediction
- DB writes: 2 additional REAL columns per snapshot/alert (negligible)
- No additional API calls

### 8.4 Risk Mitigation
- **Model file missing/corrupt:** try-catch on load, `xgbWinProb = null` if unavailable. System operates normally without XGB.
- **Feature extraction error:** try-catch on feature extraction, null fallback. Non-fatal.
- **Agent over-reliance on XGB:** Advisory phase prevents this. Agent sees XGB as one signal among many, not a veto.
- **Rollback:** Remove model file + set `XGB_ENABLED = false` flag. All columns are nullable — no schema rollback needed.

---

## 9. Files Changed

| File | Changes | Lines |
|------|---------|-------|
| `poll-live-bdl.mjs` | Add predictXGB(), extractXGBFeatures(), integration in poll loop, agent prompt line | ~130 |
| `db-api.js` | Add columns in init, include in snapshot/alert queries | ~15 |
| `data-discovery/xgboost-apr27/raw_model.json` | Already in repo | 0 (exists) |
| `v3.html` | XGB display on snapshots + game card (deferred to after advisory validation) | ~30 |
| `debug.html` | XGB accuracy split in alert section (deferred) | ~40 |
| `post-game-agent.mjs` | XGB arc tracking + nightly comparison | ~40 |

**Total implementation: ~185 lines of new code** for advisory phase (poll + db-api + learning agent). Dashboard changes deferred until advisory phase validates.

---

## 10. Implementation Order

1. **predictXGB() + extractXGBFeatures()** — pure JS inference engine + feature extraction
2. **DB schema** — add columns via init
3. **Poll loop integration** — compute XGB after computeServer(), save on snapshots
4. **Alert stamping** — add xgb_win_prob + xgb_aligned on alert writes
5. **Agent prompt** — one line of XGB context
6. **Learning agent** — XGB comparison metrics in nightly analysis
7. **Validate** — run through a live slate, pull snapshots, confirm values look correct
8. **Dashboard** — XGB display (deferred 2+ weeks)
9. **Gate promotion** — hard gates based on accumulated live data (deferred)

---

## 11. Retraining Strategy

The model should be retrained:
- **After each playoff round** (sample size grows, population shifts)
- **Before each new season** (roster changes, rule changes)
- **If live accuracy diverges >5pp from backtest** (concept drift)

Retraining uses the same `export_xgb` endpoint on backtest-nba-snapshots function. Training script saved at `data-discovery/xgboost-apr27/`. New model JSON replaces old one in repo.

WNBA and NCAAMB would need their own models trained on league-specific backtest data. Same architecture, different weights.

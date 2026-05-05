# DEPLOYMENT SPEC: Windowed XGB + MC Cumulative Upgrade

**Date:** May 5, 2026  
**Scope:** poll-live-bdl.mjs, xgb-model.json, db-api.js, analyze.js, v3.html  
**Backtest basis:** 14,440 checkpoints across 1,233 games

---

## SUMMARY OF VALIDATED FINDINGS

| Signal | Input change | AUC (overall) | Key stat |
|--------|-------------|---------------|----------|
| XGB | Cumulative → 2Q window | 0.7694 → **0.7863** (+0.017) | Q4 AUC +0.021 |
| MC | Keep cumulative rates | **0.7938** (best single signal) | Beats XGB in disagreements 70-87% |
| EXIT | Q2-Q3<0.50/Q4<0.55 → flat <0.45 | Graduated exit acc 52.2% → same but fewer false exits | Total damage minimized at 0.45 |

---

## PHASE 1: MODEL — Train and deploy windowed XGB

### 1A. Train final model

Run in sandbox using cached `/tmp/window_xgb_data.json`:
- 5-fold stratified CV on game_id (prevent leakage)
- Hyperparameters: max_depth=4, lr=0.05, subsample=0.8, colsample=0.8, min_child_weight=5
- Early stopping on 300 rounds → expect ~100-120 trees
- Export as JSON to `netlify/functions/xgb-model.json`

### 1B. Feature order verification

Production feature order in `extractXGBFeatures` (line 80) and backtest `extractFeaturesFromStats` must be identical:
```
[0] paint diff
[1] pot diff
[2] to diff
[3] stl diff
[4] oreb diff
[5] ast diff
[6] blk diff
[7] fta diff
[8] efg diff
[9] biglead diff (CUMULATIVE — not windowed)
[10] 3pt rate diff
[11] rim_pct diff
[12] runs (CUMULATIVE — from PBP, not windowed)
```

**CRITICAL:** biglead and runs stay cumulative in both training and production. The backtest export already does this correctly (`cumBiglead`, `cumRunShare`).

### 1C. Model file

Replace `netlify/functions/xgb-model.json`. Size should be ~500KB (vs current 394KB from fewer trees but different depth).

`predictXGB()` (line ~40) and `computeXGBContributions()` (line ~130) consume the model. Neither function cares about feature semantics — they just traverse the tree. **No changes needed** to these functions.

---

## PHASE 2: computeServerWindow — expose raw aggregates

### 2A. Change

Add `rawAgg` to return value of `computeServerWindow` (line ~3030):

```javascript
return {
  available: true,
  score: ...,
  controlTeam: ...,
  // ... existing fields ...
  rawAgg: { home: hW, away: aW },  // ← NEW: raw cross-fade aggregate stats
};
```

`hW` and `aW` already exist (line 2967). Just needs exposure.

### 2B. Consumers

Three call sites:
1. **Line 3942** — agent context builder: reads `serverWindow.score`, `serverWindow.controlTeam`. Does NOT need rawAgg. **No change.**
2. **Line 6145** — main poll loop: currently reads `_windowResult.score`. Will ALSO need `_windowResult.rawAgg` for XGB features (Phase 3). **Changed — see Phase 3.**
3. **Line 7874** — quarter data processing: reads `serverWindow.score`. Does NOT need rawAgg. **No change.**

### 2C. Risk

Zero risk — purely additive. Existing consumers ignore fields they don't read.

### 2D. Stats available in rawAgg

From `QD_STAT_KEYS` (line 2760): steals, offensive_rebounds, turnovers, points_off_turnovers, points_in_the_paint, points_in_paint, field_goals_at_rim_made/att, free_throws_att/made, blocks, field_goals_made/att, three_points_made/att, assists, points, possessions.

**All 13 XGB features computable from these.** Also all 7 MC rate inputs computable.

---

## PHASE 3: extractXGBFeatures — use windowed stats

### 3A. Signature change

```javascript
// BEFORE
function extractXGBFeatures(summary, ind, pbpResult, currentPeriod, clock)

// AFTER
function extractXGBFeatures(summary, ind, pbpResult, currentPeriod, clock, windowAgg)
```

`windowAgg` = `{ home: {...}, away: {...} }` from `computeServerWindow().rawAgg`, or null.

### 3B. Feature extraction logic

When `windowAgg` is provided AND has sufficient data (field_goals_att >= 5 per side):
- Use `windowAgg` for: paint, pot, to, stl, oreb, ast, blk, fta, efg, 3pr, rim_pct
- Use cumulative `summary` for: biglead (always cumulative)
- Use cumulative `pbpResult` for: runs (always cumulative)

When `windowAgg` is null (Q1, or quarter_data unavailable):
- Fall back to current behavior: all features from cumulative `summary`

### 3C. Stat key mapping

`computeServerWindow` aggregates use SR long keys. `extractXGBFeatures` currently uses SR long keys. **No mapping needed** — they use the same key names.

However, `points_in_the_paint` vs `points_in_paint` (SR uses both). Current code handles both: `hs.points_in_the_paint || hs.points_in_paint`. Window aggregate may only have whichever key was in the SR data at boundary time. **Must handle both in window path too.**

### 3D. Call sites (4 total)

1. **Line 6052** — main poll loop:
   ```javascript
   // BEFORE
   const _xgbFeatures = extractXGBFeatures(summary, ind, pbpResult, currentPeriod, clock);
   // AFTER
   const _xgbFeatures = extractXGBFeatures(summary, ind, pbpResult, currentPeriod, clock,
     _windowResult?.rawAgg || null);
   ```
   `_windowResult` computed at line 6145. **ORDERING ISSUE:** `_windowResult` is computed AFTER `_xgbFeatures` (6145 > 6052). Must reorder: compute window BEFORE XGB features.

2. **Line 6306** — BWC XGB (BWC team perspective):
   ```javascript
   const _bwcFeatures = extractXGBFeatures(summary, _bwcInd, pbpResult, currentPeriod, clock, _windowResult?.rawAgg || null);
   ```
   Uses `_bwcInd` (flipped indicators for BWC team). The `windowAgg` is the SAME aggregate — XGB features use `flip = ctrlIsHome ? 1 : -1` based on `ind.controlTeam`. When BWC team differs from ctrl team, `_bwcInd.controlTeam` flips the sign. **rawAgg stays the same; flip handles perspective.**

3. **Line 4849** — calibration analysis:
   ```javascript
   const _caXgbFeatures = extractXGBFeatures(summary, ind, null, period, clock);
   ```
   No window available in this context (simplified analysis). Pass null for windowAgg. Falls back to cumulative. **Acceptable — calibration is a snapshot comparison, not a trading signal.**

### 3E. Ordering fix (CRITICAL)

Current order in poll loop:
```
Line 6052: _xgbFeatures = extractXGBFeatures(...)     ← XGB first
Line 6145: _windowResult = computeServerWindow(...)     ← window second
```

Must swap to:
```
Line ~6050: _windowResult = computeServerWindow(...)    ← window first
Line ~6055: _xgbFeatures = extractXGBFeatures(..., _windowResult?.rawAgg)  ← XGB uses window
```

**Cascading check:** Nothing between 6052 and 6145 depends on `_xgbFeatures` or `_windowResult`. The values are only consumed later (6225 for snapshot save, 6288 for SHAP, 6300 for BWC XGB). **Safe to reorder.**

Dependencies for `computeServerWindow`: needs `_qd` (quarter data), `currentPeriod`, `clock`, `summary`, `hA`, `aA`, `league`. All available by line 6050. `_qd` is set at line ~6130 — **another ordering issue.** Need to verify `_qd` is available before 6050.

Actually, `_qd` is set from the `games` table query, which happens at line ~6090. So the actual order is:
```
~6090: _qd loaded from DB
~6145: _windowResult computed
~6052: _xgbFeatures computed
```

The window computation currently happens at 6145. XGB at 6052. I need to move window computation to before XGB, BUT only after `_qd` is loaded (~6090). So the new order would be:
```
~6090: _qd loaded from DB
~6095: _windowResult = computeServerWindow(...)  ← MOVED UP
~6052: _xgbFeatures = extractXGBFeatures(..., _windowResult?.rawAgg)
```

Must verify no code between 6090 and 6145 depends on `_windowResult`.

### 3F. SHAP implications

`computeXGBContributions` (line 6289) takes `_xgbFeatures` (the 13-element array). Feature labels are hardcoded in `XGB_VOLATILE_FEATURES` and `XGB_STRUCTURAL_FEATURES` (lines 53-54). The SHAP decomposition assigns labels by array position:
```javascript
var FEATURE_NAMES = ['paint','pot','to','stl','oreb','ast','blk','fta','efg','biglead','3pr','rim_pct','runs'];
```

Feature semantics shift slightly with windowed input (e.g., `paint` is now 2Q-window paint diff, not game-cumulative). But SHAP values are relative contributions regardless of input scale. **VOLATILE/STRUCTURAL classification stays valid** — the feature type (hustle vs scheme) doesn't change with windowing.

**No changes needed to SHAP or conviction quality.**

---

## PHASE 4: MC Cumulative — new always-on signal

### 4A. New function

```javascript
function computeMCCumulative(summary, period, clock, controlTeam, hA, league) {
  // Extract cumulative box score rates
  // Run MC simulation (200 sims — same as PBP MC)
  // Return { winProb, rates: { home: {...}, away: {...} } }
}
```

Uses existing `runMonteCarloSim` and `estimateRemainingPossMC`. Needs:
- `summary.home.statistics` / `summary.away.statistics` for rates
- Current score (`summary.home.points` / `summary.away.points`) — or `ind.homePts/awayPts`
- Team 3PT season baselines for regression (from `_clutchMap` or `_team3ptBaselines`)

### 4B. Rate extraction

New helper `extractMCRatesFromCumulative(stats, seasonFg3Pct)`:
- `toRate = turnovers / possessions`
- `fg3aShare = fg3a / fga`
- `fg3Pct = regression toward seasonFg3Pct` (same formula as PBP MC)
- `fg2Pct = fg2m / fg2a`
- `orebRate = oreb / (fga - fgm)`
- `ftaRate = fta / possessions`
- `ftPct = ftm / fta`

**Min gate:** fga >= 10 (cumulative will always pass this by Q2).

### 4C. Integration point

In main poll loop, after snapshot save (line ~6225), alongside existing PBP MC block (line 6176):

```javascript
// MC Cumulative (always-on Q2+)
var _mcCum = null;
if (currentPeriod >= 2) {
  _mcCum = computeMCCumulative(summary, currentPeriod, clock, ind.controlTeam, hA, league);
}
```

### 4D. Storage

New column: `mc_cum_win_prob REAL` on `snapshots` table.
Add to snapshot INSERT (line ~6215): `..., mc_cum_win_prob) VALUES (..., ${_mcCum?.winProb || null})`.

Add to `live_tracking` JSONB: `lt.mc_cum_wp = _mcCum?.winProb`.

**Schema migration:** `ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS mc_cum_win_prob REAL`. Add to `db-api.js` init action.

### 4E. Agent context

Add to `gatherAgentContext` (line ~6540):
```javascript
mcCumWp: _mcCum?.winProb,
```

Add to alert agent prompt (Phase 7) and `formatSonnetPrompt`.

---

## PHASE 5: MC Rate Decomposition (Drivers)

### 5A. Function

```javascript
function computeMCDrivers(homeRates, awayRates, homeSeasonRates, awaySeasonRates,
                           homeScore, awayScore, remainPoss, ctrlIsHome) {
  // Baseline: MC with both teams at season rates
  // For each rate dimension, swap ctrl team's game rate back to season → measure WP delta
  // Return: [{ rate: 'toRate', label: 'turnover discipline', delta: +0.08, gameVal, seasonVal }, ...]
}
```

Requires ~7 MC runs per team × 200 sims = 2,800 sims. At ~1μs/sim = ~3ms. Negligible cost.

### 5B. Season rate extraction

From `season_cache` (already loaded per game). Need team-level aggregate season rates:
- Season TO rate, FG2%, FG3%, OREB rate, FTA rate, FT%
- Computed from season averages already in `_seasonCache[teamAlias]`

If season cache unavailable for a team, use league constants (NBA defaults: TO=0.13, FG2=0.52, FG3=0.36, OREB=0.25, FTA=0.22, FT=0.76).

### 5C. Output format for agent

```
MC RATE DRIVERS (ORL 78% win prob, +28% vs season baseline):
  Turnover discipline: +8pp (game 0.08 vs season 0.11)
  Interior finishing: +5pp (game 55% vs season 52%)
  3PT regression risk: -6pp (DET game 42% vs season 36%)
  Free throw generation: +3pp (game 0.28 vs season 0.22)
```

### 5D. Compute frequency

Every poll cycle is excessive. Compute at:
- Quarter transitions (calibration snapshots)
- Alert evaluation (when agent needs narrative)
- Store on `live_tracking` for agent context

### 5E. Risk

Purely additive — generates narrative context. No gates, no decisions depend on it. **Zero risk to existing system.**

---

## PHASE 6: EXIT threshold — flat 0.45

### 6A. `checkXGBExit` changes (line 2245)

```javascript
// BEFORE
const threshold = period >= 4 ? 0.55 : 0.50;

// AFTER
const threshold = 0.45;
```

### 6B. Cascading constants

- **Fast-path:** `< 0.15` — unchanged
- **Recovery:** `threshold + 0.10` → now 0.55 (was 0.60 for Q4, 0.60 for Q2-Q3). Tighter recovery gate — must sustain above 0.55 to recover.
- **Hysteresis:** `threshold + 0.05` → now 0.50 (was 0.55 for Q4, 0.55 for Q2-Q3). Clears warning at 0.50.

### 6C. EXIT severity classification (line ~7354)

```javascript
severity: _xgbBwcProb < 0.15 ? 'COLLAPSE' : _xgbBwcProb < 0.25 ? 'SEVERE' : 'STANDARD',
```

Unchanged — these are absolute thresholds, not relative to EXIT gate.

### 6D. XGB_INVALIDATED gates (line 7633)

```javascript
const _xgbGateByQ = { 2: 0.40, 3: 0.45, 4: 0.60 };
```

These are BUY thesis invalidation gates, NOT EXIT gates. They answer "has the XGB that supported the BUY dropped below the quarter's viability?" These should be reviewed but are a SEPARATE concern from EXIT.

**Recommendation:** Keep current INVALIDATED gates for now. They were calibrated against production BUY decisions, not the backtest. Changing them simultaneously with EXIT introduces compounding risk.

### 6E. Agent prompt references

Line ~557: `threshold: ${currentPeriod >= 4 ? '55' : '50'}%` — update to 45%.
Line ~7352: `const _xgbThreshold = currentPeriod >= 4 ? 0.55 : 0.50;` — used for logging. Update to 0.45.

### 6F. Risk

Tighter EXIT means fewer exits fire. Risk: position stays open through a loss that current thresholds would have exited. **Mitigated by:** (1) backtest shows total damage minimized at 0.45, (2) MC Cum EXIT confirmation layer (Phase 7) adds safety net.

---

## PHASE 7: Agent prompt updates

### 7A. Alert agent (Opus) — lines ~550-850

**BUY calibration table** (line 564) — replace with corrected values:
```
XGB BUY CALIBRATION (1,233-game backtest, ctrl trailing + floor >= 0.65):
  Q2: XGB>=0.70 = 78% | 0.55-0.70 = 54% | 0.45-0.55 = 39% | <0.45 = 50%
  Q3: XGB>=0.70 = 65% | 0.55-0.70 = 54% | 0.45-0.55 = 45% | <0.45 = 28%
  Q4: XGB>=0.70 = 64% | 0.55-0.70 = 46% | 0.45-0.55 = 30% | <0.45 = 19%
```
NOTE: Small samples at high XGB + truly trailing. Advise agent these are directional.

**XGB suppress warning** (line 562) — update:
```
XGB < 0.50 with ctrl trailing wins only ~20-34% (Q3-Q4). Consider SUPPRESS.
```

**High-confidence trailing warning** (line 563) — update:
```
XGB >=0.60 + ctrl trailing by 5+: Q4 loss rate 82% (n=17). WARN.
```

**MC Cumulative context block** — NEW, add after XGB block:
```
MC CUMULATIVE (game-rate simulation, ${mcCumWp}%):
  Simulates remaining possessions using cumulative box score rates.
  Overall AUC: 0.79 (best single signal). Beats XGB in disagreements.
  ${mcCumWp > 0.70 ? 'MC strongly favors ctrl team.' : mcCumWp < 0.40 ? 'MC sees ctrl team losing at current rates.' : 'MC is neutral/mixed.'}
  ${mcDrivers ? 'RATE DRIVERS: ' + mcDrivers : ''}
```

**EXIT threshold** — update all references from "50%/55%" to "45%".

**EXIT sharpening** — NEW, add to EXIT evaluation:
```
MC EXIT CONFIRMATION (when XGB EXIT fires):
  MC Cum < 0.45 CONFIRMS EXIT: 84% accuracy (Q4)
  MC Cum > 0.55 DENIES EXIT: only 62% accuracy (Q4) — reconsider
```

**Trust hierarchy** — update:
```
SIGNAL TRUST (validated across 1,233 games):
  Overall probability: MC Cum (AUC 0.79) > XGB 2Q (0.79) > Floor (0.70)
  EXIT precision: XGB 2Q (78%) > MC Cum (69%)
  Change detection: PBP MC canary (captures real-time rate shifts)
  When all 3 agree high: Q4 95.9% accuracy
```

### 7B. Auto-analysis Sonnet (`formatSonnetPrompt`)

Add MC Cum data to the prompt data block:
```javascript
${mcCumWp != null ? `\nMC CUMULATIVE: ${(mcCumWp * 100).toFixed(1)}% win probability from game-rate simulation.` : ''}
${mcDrivers ? `MC RATE DRIVERS:\n${mcDrivers}` : ''}
```

### 7C. Client analysis (`analyze.js`)

Add MC Cum to analysis context. Client can pass `mc_cum_win_prob` from snapshot data.

---

## PHASE 8: Schema changes

### 8A. snapshots table

```sql
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS mc_cum_win_prob REAL;
```

### 8B. db-api.js

Add column to `init` action. Add to `get_snapshot_timeline` SELECT if used.
Add `mc_cum_win_prob` to snapshot INSERT in poll function.

### 8C. live_tracking JSONB

Add fields (no schema change needed — JSONB):
- `mc_cum_wp` — MC Cumulative win probability
- `mc_drivers` — MC rate decomposition array

---

## PHASE 9: Dashboard (v3.html)

### 9A. MC Cum display

Add MC Cum win probability to the existing MC strip alongside PBP MC:
```
MC PBP: 72% | MC Cum: 85% | XGB: 78% | Floor: 0.72
```

### 9B. MC Drivers

Show rate decomposition in expandable section within game card. Visual: bar chart of driver contributions sorted by magnitude.

### 9C. Snapshot history

Add `mc_cum_win_prob` column to snapshot timeline table (alongside existing `mc_win_prob`).

---

## PHASE 10: Dead code cleanup

### 10A. Quarter-specific EXIT logic

In `checkXGBExit`: remove `period >= 4 ? 0.55 : 0.50` ternary. Replace with flat `0.45`.

### 10B. Old calibration numbers in prompts

Remove all hardcoded calibration numbers that are being replaced (lines 564-569, 562-563).

### 10C. No other dead code identified

The `extractXGBFeatures` cumulative fallback path (when windowAgg is null) must remain for Q1 and edge cases.

---

## IMPLEMENTATION ORDER

1. **Phase 2** — expose rawAgg in computeServerWindow (1 line, zero risk)
2. **Phase 3E** — reorder window/XGB computation in poll loop (move lines, verify dependencies)
3. **Phase 3** — modify extractXGBFeatures to use windowAgg (with fallback)
4. **Phase 1** — train final model, replace xgb-model.json
5. **Phase 8** — schema migration (ALTER TABLE + init)
6. **Phase 4** — add MC Cumulative computation + storage
7. **Phase 6** — EXIT threshold change
8. **Phase 5** — MC rate decomposition
9. **Phase 7** — agent prompt updates (all three prompts)
10. **Phase 9** — dashboard updates

Phases 1-4 can be a single commit. Phase 5-7 second commit. Phase 9 third commit.

---

## RISK SUMMARY

| Change | Risk | Mitigation |
|--------|------|-----------|
| XGB model swap | Feature order mismatch | Verify feature extraction produces identical values for known game |
| extractXGBFeatures signature | BWC XGB breaks | rawAgg is same object; flip handles perspective |
| Poll loop reorder | Timing dependency | Verified no code between window and XGB depends on either |
| MC Cum | None | Purely additive signal |
| EXIT 0.45 | More positions left open | MC Cum confirmation layer + backtest shows lower total damage |
| Prompt updates | Agent behavior shift | Numbers are data-backed; agent adapts naturally |

---

## VALIDATION PLAN

After deployment:

1. **Smoke test:** Hit poll endpoint, verify snapshot has both `xgb_win_prob` and `mc_cum_win_prob`
2. **Feature verification:** For a live game, compare `extractXGBFeatures` output with backtest export for same game state
3. **Model sanity:** XGB predictions should be in 0.3-0.95 range, not clustering at 0.50 (would indicate feature mismatch)
4. **MC Cum sanity:** Should track close to PBP MC but smoother (less poll-to-poll variance)
5. **EXIT test:** Verify `checkXGBExit` fires at 0.45 not 0.50/0.55
6. **Rerun learning agent** for first live slate to verify arc scoring still works

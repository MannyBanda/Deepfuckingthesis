# WNBA Pipeline Implementation Spec
**Date:** May 8, 2026
**Status:** READY FOR IMPLEMENTATION
**Risk:** Modifies 8 shared functions in poll-live-bdl.mjs (NBA playoff hot path)
**Mitigation:** Every change is league-gated; NBA branches are byte-identical to current code

---

## 0. Guiding Principle

Every modified function gets a `league` parameter. The first line of the WNBA branch is `if (league === 'wnba')`. The NBA path (`else`) is copy-pasted from current production — zero logic changes, zero threshold changes. If a function already has `league` in scope via its caller, pass it through.

---

## 1. LEAGUES Config Enrichment (line ~290)

**Current WNBA config block (line 290-302):**
```javascript
wnba: {
  srBase, srKeyEnv, espnSlug, espnBase, espnSummaryBase,
  bdlPrefix, bdlHasSeasonStats: false, season, aliasMap,
  dryRun: true,
}
```

**Add these fields:**
```javascript
wnba: {
  ...existing,
  dryRun: false,                    // FLIP — regular season live
  bdlHasBoxScores: false,           // BDL has no box_scores endpoint for WNBA
  quarterMinutes: 10,               // vs NBA 12
  gameMinutes: 40,                  // vs NBA 48
  periodCount: 4,                   // same as NBA
  twoPointBaseline: 0.46,           // vs NBA 0.52
  weights: { I1: 0.15, I2: 0.20, I3: 0.30, I4: 0.25, I5: 0.10 },
  mcDefaults: {
    toRate: 0.178, fg3aShare: 0.345, fg3Pct: 0.347, fg2Pct: 0.482,
    orebRate: 0.348, ftaRate: 0.224, ftPct: 0.788,
  },
  xgbModelFile: 'xgb-model-wnba.json',
  xgbFeatureCount: 12,              // vs NBA 13
  xgbFeatureLabels: [
    'ast','ftm','ast_ratio','w_dreb','w_3pa','3pa',
    'pot','w_fta','oreb','w_ftm','w_pot','w_ast_ratio'
  ],
}
```

**NBA config — add explicit defaults so functions can read from config instead of hardcoding:**
```javascript
nba: {
  ...existing,
  bdlHasBoxScores: true,
  quarterMinutes: 12,
  gameMinutes: 48,
  periodCount: 4,
  twoPointBaseline: 0.52,
  weights: { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 },
  mcDefaults: {
    toRate: 0.13, fg3aShare: 0.35, fg3Pct: 0.36, fg2Pct: 0.52,
    orebRate: 0.25, ftaRate: 0.22, ftPct: 0.76,
  },
  xgbModelFile: 'xgb-model.json',
  xgbFeatureCount: 13,
  xgbFeatureLabels: ['paint','pot','to','stl','oreb','ast','blk','fta','efg','biglead','3pr','rim_pct','runs'],
}
```

**NCAAMB config — add same explicit defaults (preserves current values):**
```javascript
ncaamb: {
  ...existing,
  bdlHasBoxScores: false,
  quarterMinutes: 20,               // halves
  gameMinutes: 40,
  periodCount: 2,
  twoPointBaseline: 0.49,
  weights: { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 },
  mcDefaults: null,                  // MC not active for NCAAMB
  xgbModelFile: null,                // XGB not active for NCAAMB
}
```

**Regression:** NBA config values are identical to current hardcoded values. Zero behavior change.

---

## 2. `W` Indicator Weights (lines 327, 4085)

**Current (both locations):**
```javascript
const W = { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };
```

**Change:** Replace with config lookup. Both locations become:
```javascript
const W = LEAGUES[league]?.weights || { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };
```

**Line 327** — global scope, used by `computeServer` and `computeServerWindow`. Problem: it's a global `const` not inside a function. These functions need `league` to look up the right weights.

**Solution:** Move `W` usage inside the functions that consume it. Both `computeServer` and `computeServerWindow` already compute the composite score using `W`. Change them to accept `league` and compute `W` locally:
```javascript
function computeServer(summary, pbpData, seasonQ4, league) {
  const cfg = LEAGUES[league] || LEAGUES.nba;
  const W = cfg.weights || { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };
  // ... rest unchanged for NBA ...
```

**Line 4085** — inside `computeServerContext`. Already has `league` param:
```javascript
async function computeServerContext(sql, game, league, summary, ind, ...) {
  const cfg = LEAGUES[league] || LEAGUES.nba;
  const W = cfg.weights || { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };
```

**Global `W` at line 327** — becomes `var W_NBA = { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };` (kept for any remaining references, but all active consumers use league-local `W`).

**Callsite changes:**
- Line 5426: `computeServer(summary, pbpResult, _seasonQ4Cache || {})` → add `league`
- Line 6253: same
- `computeServerWindow` at line 3060 already has `league` param

**Regression assertion:** For `league === 'nba'`, `W` resolves to `{I1:0.10, I2:0.15, I3:0.20, I4:0.30, I5:0.25}` — identical.

---

## 3. `computeServer` Indicator Logic (line 2764)

**Signature change:** `computeServer(summary, pbpData, seasonQ4)` → `computeServer(summary, pbpData, seasonQ4, league)`

**Strategy:** Each indicator block gets an `if (league === 'wnba') { ... } else { ... }` wrapper. The `else` block is the EXACT current NBA code.

### I1 — Disruption & Conversion
**NBA (unchanged):** disruption threshold ±1, POT threshold ±4, chaos layer
**WNBA:** disruption threshold ±2, POT threshold ±3, chaos layer preserved (uses forced TOs, not raw — compatible with WNBA spec "NO raw turnovers")

```javascript
// I1 — Disruption & Conversion
const hDisrupt = (hs.steals || 0) + (hs.blocks || 0);
const aDisrupt = (as.steals || 0) + (as.blocks || 0);
const disruptDiff = hDisrupt - aDisrupt;
const disruptThresh = league === 'wnba' ? 2 : 1;
const i1subA = disruptDiff > disruptThresh ? 1 : disruptDiff < -disruptThresh ? -1 : 0;
const hPOT = hs.points_off_turnovers || 0, aPOT = as.points_off_turnovers || 0;
const potDiff = hPOT - aPOT;
const potThresh = league === 'wnba' ? 3 : 4;
const i1subB = potDiff > potThresh ? 1 : potDiff < -potThresh ? -1 : 0;
let i1raw = i1subA + i1subB;
// Chaos layer — forced vs unforced TO split (preserved for WNBA — uses forced TOs, not raw)
if (pbpData) { /* ... unchanged ... */ }
```

### I2 — Interior Control (NBA) / Perimeter & FT Access (WNBA)
**NBA (unchanged):** paint volume ±6, rim efficiency ±10%
**WNBA:** 3PT% diff ±3%, FTA diff ±2

```javascript
let i2raw;
if (league === 'wnba') {
  // WNBA I2: Perimeter & FT Access
  const h3Pct = (hs.three_points_att || 0) > 4 ? (hs.three_points_made || 0) / (hs.three_points_att || 1) * 100 : null;
  const a3Pct = (as.three_points_att || 0) > 4 ? (as.three_points_made || 0) / (as.three_points_att || 1) * 100 : null;
  let wi2a = 0;
  if (h3Pct != null && a3Pct != null) {
    if (h3Pct - a3Pct > 3) wi2a = 1;
    else if (a3Pct - h3Pct > 3) wi2a = -1;
  }
  const hFTA = hs.free_throws_att || 0, aFTA = as.free_throws_att || 0;
  const wi2b = (hFTA - aFTA > 2) ? 1 : (aFTA - hFTA > 2) ? -1 : 0;
  i2raw = wi2a + wi2b;
} else {
  // NBA I2: Interior Control (EXACT current code)
  const hPaint = hs.points_in_the_paint || hs.points_in_paint || 0;
  // ... exact current code ...
  i2raw = i2subA + i2subB;
}
const I2 = { score: i2raw > 0 ? 1 : i2raw < 0 ? 0 : 0.5, leader: ... };
```

### I3 — Shot Quality & Creation
**NBA (unchanged):** eFG ±0.02, assist ratio ±5, C&S 3s ±2
**WNBA:** eFG ±0.03, assists diff ±2 (raw count, not ratio), no C&S sub

```javascript
let i3raw;
if (league === 'wnba') {
  const efgDiff = hEFG - aEFG;
  const astDiff = hAst - aAst;
  i3raw = (efgDiff > 0.03 ? 1 : efgDiff < -0.03 ? -1 : 0)
        + (astDiff > 2 ? 1 : astDiff < -2 ? -1 : 0);
} else {
  // NBA (EXACT current code — eFG ±0.02, AR ±5, C&S ±2)
  i3raw = (hEFG > aEFG + 0.02 ? 1 : hEFG < aEFG - 0.02 ? -1 : 0)
        + (hAR > aAR + 5 ? 1 : hAR < aAR - 5 ? -1 : 0)
        + (hCS3 > aCS3 + 2 ? 1 : hCS3 < aCS3 - 2 ? -1 : 0);
}
```

**Note:** `hEFG`, `aEFG`, `hAst`, `aAst`, `hAR`, `aAR`, `hCS3`, `aCS3` must all be computed BEFORE the branch (they're used by both). Move shared computations above the `if`.

### I4 — Game Control
**NBA (unchanged):** biggest_lead ±2 with 75% contested check, Q4 scoring ±2
**WNBA:** biggest_lead ±4 (no contested check), Q4 scoring ±2

```javascript
let i4subA = 0;
if (league === 'wnba') {
  const blDiff = hBigLead - aBigLead;
  i4subA = blDiff > 4 ? 1 : blDiff < -4 ? -1 : 0;
} else {
  // NBA (EXACT current code — ±2, 75% contested)
  if (hBigLead >= aBigLead + 2) {
    i4subA = (aBigLead >= 0.75 * hBigLead) ? 0 : 1;
  } else if (aBigLead >= hBigLead + 2) {
    i4subA = (hBigLead >= 0.75 * aBigLead) ? 0 : -1;
  }
}
// i4subB unchanged — Q4 scoring diff ±2 works for both leagues
```

### I5 — Sustained Execution (NBA) / Momentum (WNBA)
**NBA (unchanged):** run share from PBP, threshold 0.55/0.45
**WNBA:** FBP diff ±3, total rebounds diff ±3

```javascript
let I5 = { score: 0.5, leader: 'EVEN' };
if (league === 'wnba') {
  const hFBP = hs.fast_break_pts || hs.fast_break_points || 0;
  const aFBP = as.fast_break_pts || as.fast_break_points || 0;
  const hReb = hs.rebounds || ((hs.offensive_rebounds || 0) + (hs.defensive_rebounds || 0));
  const aReb = as.rebounds || ((as.offensive_rebounds || 0) + (as.defensive_rebounds || 0));
  const i5raw = (hFBP - aFBP > 3 ? 1 : hFBP - aFBP < -3 ? -1 : 0)
              + (hReb - aReb > 3 ? 1 : aReb - hReb > 3 ? -1 : 0);
  I5 = { score: i5raw > 0 ? 1 : i5raw === 0 ? 0.5 : 0, leader: i5raw > 0 ? hA : i5raw < 0 ? aA : 'EVEN' };
} else {
  // NBA (EXACT current runShare code)
  if (pbpData?.runs6) { /* ... unchanged ... */ }
}
```

**NOTE:** WNBA I5 uses `fast_break_pts` which SR summary provides natively. The BDL `buildSummaryFromBDLServer` sets `fast_break_pts = 0` (hardcoded). Since WNBA uses SR summary directly, this field will be populated. No issue.

---

## 4. `computeServerWindow` (line 3060)

**Already has `league` parameter.**

### periodLength fix (line ~3088)
**Current:** `const periodLength = league === 'ncaamb' ? 20 : 12;`
**Change:** `const periodLength = league === 'ncaamb' ? 20 : league === 'wnba' ? 10 : 12;`

### WNBA window branching
WNBA uses quarters (same as NBA). The NBA cross-fade logic at lines 3103-3122 works for WNBA — same Q2/Q3/Q4 structure. No change needed.

### Window I1-I5 indicators (lines 3157-3222)
Same league-branching pattern as `computeServer`:
- Window I1: disruption threshold ±2 for WNBA (currently ±1)
- Window I2: WNBA uses 3PT% diff ±3% + FTA diff ±2 (not paint/rim)
- Window I3: WNBA eFG ±0.03, assists diff ±2 (not AR ±5)
- Window I4: WNBA biggest_lead ±4 (not ±2 with contested check)
- Window I5: WNBA FBP ±3 + rebounds ±3 (not runShare) — NOTE: window stats may not have FBP since quarter_data doesn't diff fast_break_pts. If unavailable, set I5 to EVEN (same as NBA I5 fallback when runs not available).

### Composite line (line ~3214)
**Current:** `const raw = wI1.score * W.I1 + ...` — uses global `W`
**Change:** `const W = (LEAGUES[league]?.weights) || { I1:0.10, I2:0.15, I3:0.20, I4:0.30, I5:0.25 };`

---

## 5. `computeConviction` (line 2891)

**Signature change:** `computeConviction(ind)` → `computeConviction(ind, league)`

**7 callsites** — all have `league` in scope. Add `league` param to each call.

### WNBA conviction rules (from expansion spec)
```javascript
if (league === 'wnba') {
  // WNBA killer pairs — different from NBA
  const hasI3I4 = has('I3', 'I4');
  const hasI3I2 = has('I3', 'I2');
  const hasI4I2 = has('I4', 'I2');
  const hasKillerPair = hasI3I4 || hasI3I2 || hasI4I2;

  // WNBA danger: I1+I5 only (83.3% — monitor, don't flag as danger yet)
  const isDanger = false; // monitoring only per expansion spec

  if (count >= 4 || (hasI3I4 && count >= 3)) {
    tier = 'DOMINANT';
  } else if (hasKillerPair) {
    tier = 'STRONG';
  } else if (count >= 2) {
    tier = 'MODEST';
  } else if (count >= 1) {
    tier = 'CONDITIONAL';
  } else {
    tier = 'NO ENTRY';
  }
} else {
  // NBA (EXACT current code)
  ...
}
```

**Regression:** NBA path is byte-identical.

---

## 6. `estimateRemainingPossMC` (line 1942)

**Signature change:** `estimateRemainingPossMC(homeStats, awayStats, period, clockSec)` → add `league`

**Current hardcoded values:**
```javascript
var elapsedMin = (Math.min(period, 4) - 1) * 12 + (12 - clockSec / 60);
var remainMin = 48 - elapsedMin;
```

**Change:**
```javascript
var qMin = (LEAGUES[league]?.quarterMinutes) || 12;
var gameMin = (LEAGUES[league]?.gameMinutes) || 48;
var elapsedMin = (Math.min(period, 4) - 1) * qMin + (qMin - clockSec / 60);
var remainMin = gameMin - elapsedMin;
```

**4 callsites** (lines 2001, 6426, 7777, 7848). All have `league` in scope.

**Regression:** NBA: `qMin=12, gameMin=48` — identical to current.

---

## 7. MC Baselines (lines 2020-2021, ~1880s fallbacks)

### `MC_DEFAULT_RATES` (line 2020)
**Change to league-aware lookup:**
```javascript
var MC_NBA_DEFAULTS = {
  toRate: 0.13, fg3aShare: 0.35, fg3Pct: 0.36, fg2Pct: 0.52,
  orebRate: 0.25, ftaRate: 0.22, ftPct: 0.76,
};
function getMCDefaults(league) {
  return LEAGUES[league]?.mcDefaults || MC_NBA_DEFAULTS;
}
```

### `extractMCRatesFromCumulative` (line ~1966)
**Signature change:** add `league` param. Replace hardcoded fallbacks with `getMCDefaults(league)`:
```javascript
function extractMCRatesFromCumulative(stats, seasonFg3Pct, league) {
  var defaults = getMCDefaults(league);
  // ... same logic, but replace 0.36 → defaults.fg3Pct, 0.50 → defaults.fg2Pct, etc.
```

**Specifically these lines change:**
- Line ~1881: `0.35` → `defaults.fg3aShare`
- Line ~1884: `0.25` → `defaults.orebRate`
- Line ~1886: `0.76` → `defaults.ftPct`
- And the similar pattern in the return block

### `computeMCDrivers` (line ~2030)
Uses `MC_DEFAULT_RATES` for swap analysis. Change to accept `league`:
```javascript
function computeMCDrivers(mcCumResult, ctrlIsHome, homeScore, awayScore, ctrlSeasonRates, league) {
  var defaults = getMCDefaults(league);
  // ... rest uses defaults instead of MC_DEFAULT_RATES
```

### `_teamSeasonRates` fallback defaults (line ~5947)
**Current:** `toRate: tPoss > 0 ? tTO / tPoss : 0.13` etc.
**Change:** `toRate: tPoss > 0 ? tTO / tPoss : defaults.toRate` where `defaults = getMCDefaults(league)`

**Regression:** NBA: `getMCDefaults('nba')` returns exact current values.

---

## 8. XGB Model Loading & Feature Extraction

### Model loading (line 22-25)
**Current:** Single model loaded at startup.
**Change:** Load both models at startup:
```javascript
var XGB_MODELS = {};
try {
  const __xgbDir = dirname(fileURLToPath(import.meta.url));
  XGB_MODELS.nba = JSON.parse(readFileSync(join(__xgbDir, 'xgb-model.json'), 'utf8'));
} catch (e) { /* non-fatal */ }
try {
  const __xgbDir = dirname(fileURLToPath(import.meta.url));
  XGB_MODELS.wnba = JSON.parse(readFileSync(join(__xgbDir, 'xgb-model-wnba.json'), 'utf8'));
} catch (e) { /* non-fatal */ }
// Backward compat
var XGB_MODEL = XGB_MODELS.nba || null;
```

### `predictXGB` (line ~39)
**Signature change:** `predictXGB(features)` → `predictXGB(features, league)`
```javascript
function predictXGB(features, league) {
  var model = (league && XGB_MODELS[league]) || XGB_MODEL;
  if (!model) return null;
  // ... rest uses `model` instead of `XGB_MODEL`
}
```

### `computeXGBContributions` (line ~61)
**Same pattern:** add `league` param, use `XGB_MODELS[league] || XGB_MODEL`.
Feature count changes from hardcoded 13 to `model.feature_count || 13`.

### `extractXGBFeatures` (line 81)
**Signature change:** add `league`
```javascript
function extractXGBFeatures(summary, ind, pbpResult, currentPeriod, clock, windowAgg, league) {
  if (league === 'wnba') return extractXGBFeaturesWNBA(summary, ind, windowAgg);
  // ... EXACT current NBA code ...
}
```

### `extractXGBFeaturesWNBA` (NEW function)
**12 features from research findings:**
```javascript
function extractXGBFeaturesWNBA(summary, ind, windowAgg) {
  if (!summary?.home?.statistics || !summary?.away?.statistics) return null;
  const hs = summary.home.statistics, as = summary.away.statistics;
  const ctrlIsHome = ind.controlTeam === ind.homeAlias;
  const flip = ctrlIsHome ? 1 : -1;

  // Cumulative stats
  const hFGA = Number(hs.field_goals_att || 0) || 1;
  const aFGA = Number(as.field_goals_att || 0) || 1;
  const hFGM = Number(hs.field_goals_made || 0);
  const aFGM = Number(as.field_goals_made || 0);
  const hAst = Number(hs.assists || 0), aAst = Number(as.assists || 0);
  const hAR = hFGM > 0 ? hAst / hFGM : 0, aAR = aFGM > 0 ? aAst / aFGM : 0;

  // Windowed stats (if available)
  var wH = null, wA = null;
  if (windowAgg?.home && windowAgg?.away) {
    var wHFGA = Number(windowAgg.home.field_goals_att || 0);
    var wAFGA = Number(windowAgg.away.field_goals_att || 0);
    if (wHFGA >= 5 && wAFGA >= 5) { wH = windowAgg.home; wA = windowAgg.away; }
  }

  return [
    // [0] c_ast — cumulative assists diff
    (hAst - aAst) * flip,
    // [1] c_ftm — cumulative FT made diff
    (Number(hs.free_throws_made || 0) - Number(as.free_throws_made || 0)) * flip,
    // [2] c_ast_ratio — cumulative assisted FG% diff
    (hAR - aAR) * flip,
    // [3] w_dreb — windowed defensive rebounds diff
    wH ? (Number(wH.defensive_rebounds || 0) - Number(wA.defensive_rebounds || 0)) * flip : 0,
    // [4] w_3pa — windowed 3PT attempts diff
    wH ? (Number(wH.three_points_att || 0) - Number(wA.three_points_att || 0)) * flip : 0,
    // [5] c_3pa — cumulative 3PT attempts diff
    (Number(hs.three_points_att || 0) - Number(as.three_points_att || 0)) * flip,
    // [6] c_pot — cumulative points off turnovers diff
    (Number(hs.points_off_turnovers || 0) - Number(as.points_off_turnovers || 0)) * flip,
    // [7] w_fta — windowed FT attempts diff
    wH ? (Number(wH.free_throws_att || 0) - Number(wA.free_throws_att || 0)) * flip : 0,
    // [8] c_oreb — cumulative offensive rebounds diff
    (Number(hs.offensive_rebounds || 0) - Number(as.offensive_rebounds || 0)) * flip,
    // [9] w_ftm — windowed FT made diff
    wH ? (Number(wH.free_throws_made || 0) - Number(wA.free_throws_made || 0)) * flip : 0,
    // [10] w_pot — windowed points off turnovers diff
    wH ? (Number(wH.points_off_turnovers || 0) - Number(wA.points_off_turnovers || 0)) * flip : 0,
    // [11] w_ast_ratio — windowed assisted FG% diff
    wH ? (function() {
      var whFGM = Number(wH.field_goals_made || 0), waFGM = Number(wA.field_goals_made || 0);
      var whAR = whFGM > 0 ? Number(wH.assists || 0) / whFGM : 0;
      var waAR = waFGM > 0 ? Number(wA.assists || 0) / waFGM : 0;
      return (whAR - waAR) * flip;
    })() : 0,
  ];
}
```

### `XGB_FEATURE_LABELS` and volatile/structural sets (line ~55)
Add WNBA equivalents:
```javascript
var XGB_FEATURE_LABELS_WNBA = ['ast','ftm','ast_ratio','w_dreb','w_3pa','3pa','pot','w_fta','oreb','w_ftm','w_pot','w_ast_ratio'];
```
Volatile/structural classification can be deferred — used for agent narrative only.

### Callsite changes (4 total)
All add `league` param:
- Line 5044: `extractXGBFeatures(summary, ind, null, period, clock, null)` → add `league`
- Line 6301: same
- Line 6571: same
- `predictXGB(features)` → add `league` at all ~8 callsites

**Regression:** NBA feature array is identical 13-element array. NBA model loaded identically.

---

## 9. SR Fetch Branch (line ~6052)

### Batch box_scores guard (line ~5977)
**Current:** `const boxResult = await bdlFetch(...box_scores...)`
**Change:**
```javascript
let bdlBoxScores = [];
if (cfg.bdlHasBoxScores !== false) {
  try {
    const boxResult = await bdlFetch(`${cfg.bdlPrefix}/v1/box_scores?date=${bdlDateStr}`);
    bdlBoxScores = boxResult?.data || [];
    // ... existing NCAAMB next-day logic ...
  } catch (e) { log(`BDL box_scores failed: ${e.message}`); }
}
```

### Per-game SR summary fetch (line ~6052)
**Replace the boxScore lookup with league-aware block:**
```javascript
let boxScore = null, summary = null, gameStatus = null;

if (league === 'wnba') {
  // ── WNBA: SR game summary primary (BDL has no box_scores) ──
  try {
    await sleep(SR_DELAY_MS);
    summary = await srFetch(league, `games/${game.id}/summary.json`);
    gameStatus = (summary.status || 'scheduled').toLowerCase();
    // Normalize SR status
    if (gameStatus === 'complete') gameStatus = 'closed';
  } catch (srErr) {
    log(`${matchup}: SR summary fetch failed — ${srErr.message}`);
    continue;
  }
} else {
  // ── NBA/NCAAMB: BDL box_scores primary ──
  boxScore = bdlBoxScores.find(b => b.id === bdlGid);
  if (!boxScore) {
    log(`${matchup}: no box score — game may not have started`);
    continue;
  }
  gameStatus = normalizeBdlStatusServer(boxScore.status, boxScore);
}
```

### Finalization path (FINAL/closed games, line ~6061)
**4 boxScore references to guard:**

1. **Score extraction:**
```javascript
const homePts = league === 'wnba'
  ? Number(summary.home?.points || 0)
  : (boxScore.home_team_score || 0);
const awayPts = league === 'wnba'
  ? Number(summary.away?.points || 0)
  : (boxScore.visitor_team_score || 0);
```

2. **Game-end boundary capture (finalSummary):**
```javascript
const finalSummary = league === 'wnba'
  ? summary
  : buildSummaryFromBDLServer(boxScore, pbpResult, lineupsArr);
```

### Live game path (line ~6247)
**Current:**
```javascript
const summary = buildSummaryFromBDLServer(boxScore, pbpResult, lineupsArr);
```
**Change:**
```javascript
if (league !== 'wnba') {
  summary = buildSummaryFromBDLServer(boxScore, pbpResult, lineupsArr);
}
// WNBA: summary already set from SR fetch above
```

### Period/clock extraction
**Current code extracts from BDL `boxScore.time` string.** For WNBA SR summary:
```javascript
let currentPeriod, clock;
if (league === 'wnba') {
  currentPeriod = summary.quarter || (summary.periods || []).length || 0;
  clock = summary.clock || '';
} else {
  // Existing BDL extraction code
  currentPeriod = summary.quarter;
  clock = summary.clock;
}
```

**Note:** SR summary already has `quarter` and `clock` fields in the expected format.

---

## 10. WNBA XGB Model Export

**Source:** Research findings from `research/2026-05-08-wnba-architecture-research.md`
**Hyperparams:** depth 3, 400 trees, lr 0.03, subsample 0.8, colsample 0.8, min_child_weight 3
**Training data:** 3,432 checkpoints from `wnba_backtest` table (Q2+ with valid window)
**Features:** 12 (6 cumulative + 6 windowed), no biglead

**Process:**
1. Pull checkpoint data via `backtest-wnba` endpoint
2. Compute features per checkpoint (Python script)
3. Train XGBoost with exact hyperparams
4. Export tree structure as `xgb-model-wnba.json` (same schema as NBA model)
5. Include `feature_count: 12` in the JSON
6. Place in `netlify/functions/` alongside `xgb-model.json`

**Model JSON schema (matches NBA):**
```json
{
  "base_score": 0.5,
  "feature_count": 12,
  "trees": [
    { "s": [...], "c": [...], "l": [...], "r": [...], "w": [...], "ev": [...] },
    ...
  ]
}
```

---

## 11. Odds Handling

**No WNBA odds source.** Current code already handles null gracefully:
- `oddsAPICache` fetch is NBA-only (line ~6020: `league === 'nba' ? await fetchOddsAPIBatch() : {}`)
- `bdlOdds` returns null when endpoint doesn't exist
- Alert ML gates check `odds?.awayML` before applying — null = gate inactive

**No changes needed.**

---

## 12. BDL PBP for WNBA

BDL WNBA has plays endpoint. `bdlGid` mapping still needed for PBP.

**Current batch plays fetch (line ~6010):**
```javascript
const playsFetches = potentiallyLive.map(g => {
  const bdlGid = bdlGameIds[`${g.away_alias}@${g.home_alias}`];
  if (!bdlGid) return Promise.resolve(null);
  return bdlFetch(`${cfg.bdlPrefix}/v1/plays?game_id=${bdlGid}&per_page=500`).catch(() => null);
});
```

**This already works for WNBA** — `bdlGameData()` maps aliases to BDL game IDs, and the plays endpoint exists for WNBA. If `bdlGid` mapping fails (no BDL data for a game), PBP returns null and the system continues without PBP-derived signals (runs, forced TOs, zone data). Non-fatal.

**No changes needed.**

---

## 13. Agent Prompts (DEFERRED)

NBA-specific references in prompts:
- Conviction combo descriptions ("I4+I5=100%, I3+I4=99%")
- Trust hierarchy ("Q4: MC>XGB>Floor")
- BUY power pairs ("I1+I2 anchor")

**Deferral rationale:** Agent still operates — it receives correct indicators/conviction from the mechanical engine. Prompt text says "GROUND TRUTH — do not override." Agent will produce less WNBA-optimized narratives but won't produce wrong decisions. Tune prompts after collecting 20+ live games.

---

## 14. Regression Test Checklist

After implementation, before push:

### Syntax
- [ ] `node -c netlify/functions/poll-live-bdl.mjs`

### NBA Value Identity
- [ ] `computeServer(nbaSummary, pbp, q4, 'nba')` returns identical I1-I5 to current `computeServer(nbaSummary, pbp, q4)`
- [ ] `computeConviction(nbaInd, 'nba')` returns identical tier/combo
- [ ] `extractXGBFeatures(nbaSummary, nbaInd, pbp, 3, '8:00', windowAgg, 'nba')` returns identical 13-element array
- [ ] `predictXGB(nbaFeatures, 'nba')` returns identical probability
- [ ] `estimateRemainingPossMC(hs, as, 3, 480, 'nba')` returns identical value
- [ ] `getMCDefaults('nba')` returns `{toRate:0.13, fg3aShare:0.35, fg3Pct:0.36, fg2Pct:0.52, orebRate:0.25, ftaRate:0.22, ftPct:0.76}`

### WNBA Config
- [ ] `LEAGUES.wnba.dryRun === false`
- [ ] `LEAGUES.wnba.weights` matches expansion spec
- [ ] `LEAGUES.wnba.mcDefaults` matches research findings
- [ ] `XGB_MODELS.wnba` loaded successfully (non-null)
- [ ] `XGB_MODELS.nba` still loaded (backward compat)

### Deploy Validation
- [ ] Push → Netlify deploys (~55s)
- [ ] Hit poll endpoint: `/.netlify/functions/poll-live-bdl` — no crash
- [ ] Pull recent NBA playoff snapshots from DB — values unchanged
- [ ] Verify no new DB columns needed (pure function-level changes)

---

## 15. File Inventory

| File | Changes | Risk |
|------|---------|------|
| `netlify/functions/poll-live-bdl.mjs` | All 13 changes above | HIGH — playoff hot path. All gated by league. |
| `netlify/functions/xgb-model-wnba.json` | NEW — WNBA XGB model | NONE — new file, no NBA impact |
| `WNBA_PIPELINE_SPEC.md` | This spec | NONE — documentation |

**Total files modified:** 1 (poll-live-bdl.mjs) + 1 new (xgb-model-wnba.json)

---

## 16. Implementation Order

1. Export WNBA XGB model → `xgb-model-wnba.json` (Python, sandbox only)
2. LEAGUES config enrichment (all 3 leagues)
3. `W` weights → league-local in each function
4. `computeServer` → league-branched I1-I5
5. `computeServerWindow` → league-branched window I1-I5 + periodLength
6. `computeConviction` → league-branched combos
7. `estimateRemainingPossMC` → league-aware quarter/game minutes
8. MC baselines → league-aware defaults
9. XGB model loading → multi-model + league-aware predict/features
10. SR fetch branch → WNBA per-game summary
11. `dryRun: false`
12. Syntax check + regression test
13. Single commit, push, deploy, validate

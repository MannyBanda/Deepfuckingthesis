# XGB Conviction Quality & Trajectory Signals

## Purpose

The base XGB model produces a win probability from 13 raw stat differentials. This spec adds a layer that evaluates **how the model is arriving at its prediction** — diagnosing conviction quality across three dimensions:

1. **Scoreboard translation:** Is statistical dominance translating into an actual lead? The single largest discriminator between right and wrong high-confidence predictions is `biglead` SHAP contribution. When XGB >= 70% and biglead is the top driver, loss rate is 4.9%. When it's NOT the top driver, loss rate is 19.3%.

2. **Conviction basis:** Is conviction grounded in structural features (shooting, paint, ball movement) or volatile features (turnovers, hustle)? Teams with >60% volatile conviction at XGB > 70% lose 46% vs 29% structurally grounded.

3. **Trajectory:** Is the structural picture strengthening or decaying? EFG SHAP dropping >=0.30 in one checkpoint predicts 48% loss rate (1.33x lift) among XGB >= 65% games.

## Backtest Validation

All findings validated against 16,910 snapshots across 1,235 games (OOF cross-validated SHAP, GroupKFold by game_id, correct chronological ordering).

### XGB >= 70% Failure Mode Hierarchy (n=10,056; 1,423 wrong)

**Discriminating power ranked by lift — which modes separate right from wrong predictions:**

| Mode | Present n | Loss% | Absent Loss% | Lift |
|---|:---:|:---:|:---:|:---:|
| Trailing 5+ | 39 | 76.9% | 13.9% | 5.53x |
| Trailing any | 255 | 58.4% | 13.0% | 4.50x |
| Margin +/-3 | 843 | 38.4% | 11.9% | 3.22x |
| Early game Q1/Q2 | 3,348 | 21.3% | 10.6% | 2.01x |
| EFG as top driver | 1,003 | 25.4% | 12.9% | 1.97x |
| OREB as top driver | 728 | 23.6% | 13.4% | 1.76x |
| Paint SHAP negative | 3,133 | 19.5% | 11.7% | 1.66x |
| Vol concentration >=40% | 2,222 | 20.3% | 12.4% | 1.64x |
| Vol concentration >=50% | 1,407 | 21.2% | 13.0% | 1.63x |
| Top-1 volatile | 1,821 | 20.5% | 12.7% | 1.61x |
| Biglead top driver | 3,383 | **4.6%** | 19.0% | **0.24x** |

**Key insight:** Biglead as top driver is the strongest SAFETY signal (0.24x lift = nearly zero risk). Its absence is the strongest danger signal. The SHAP gap between right and wrong predictions on biglead alone is **-0.969** — nearly a full logit point.

**What this means:** When the model says 70%+ AND the team has built a big lead, they win 95.4%. When the model says 70%+ but no commanding lead, other features are compensating for the absence of scoreboard confirmation — and 19% of the time, that compensation is noise.

### Feature Classification

**Structural (scheme-driven, repeatable):** `paint`, `ast`, `blk`, `fta`, `efg`, `biglead`, `3pr`, `rim_pct`
**Volatile (circumstantial, event-driven):** `pot`, `oreb`, `stl`, `to`, `runs`

### SHAP Gap: Right vs Wrong (XGB >= 70%)

| Feature | Right avg SHAP | Wrong avg SHAP | Delta | Note |
|---|:---:|:---:|:---:|---|
| biglead | +0.966 | -0.002 | **-0.969** | Dominant discriminator |
| paint | +0.320 | +0.103 | -0.217 | Structural collapse |
| fta | +0.106 | +0.036 | -0.069 | Structural collapse |
| efg | +0.131 | +0.074 | -0.058 | Structural collapse |
| ast | +0.105 | +0.054 | -0.051 | Structural collapse |
| pot | +0.132 | +0.069 | -0.063 | Volatile lower |
| oreb | +0.071 | +0.071 | 0.000 | Compensating |

### Trajectory Signal Effectiveness (XGB >= 65% checkpoints, base loss 36.0%)

| Signal | Threshold | n | Loss Rate | Lift |
|---|---|:---:|:---:|:---:|
| EFG SHAP delta | <= -0.30 | 444 | 48.0% | 1.33x |
| EFG SHAP delta | <= -0.40 | 253 | 51.4% | 1.43x |
| Volatile concentration | >= 0.60 | 1,036 | 47.8% | 1.33x |
| Volatile concentration | >= 0.70 | 582 | 48.6% | 1.35x |
| Top-1 feature is volatile | -- | 2,205 | 44.4% | 1.23x |
| vol_conc>50% + efg_delta<-0.15 | combo | 339 | 48.4% | 1.34x |

## Architecture

### Code path

```
extractXGBFeatures()     -> 13 raw stat diffs (line ~80)
     |
predictXGB()             -> win probability scalar (line ~35)
     |
computeXGBContributions()-> SHAP array [{f,v}, ...] (line ~53)
     |
computeConvictionQuality()  <- NEW -- snapshot conviction metrics
     |
computeTrajectorySignals()  <- NEW -- delta signals from checkpoint history
     |
Injected into v2Ctx      -> flows to agent prompt (line ~5960)
     |
Rendered in buildV2AgentPrompt() -> agent sees plain English warnings
```

### Data flow

1. `computeXGBContributions(_xgbFeatures)` already runs every poll cycle (line 5965) and at every checkpoint (line 6276).
2. Checkpoint SHAP arrays stored in `game_checkpoints` table and loaded into `lt.checkpoints` via `live_tracking` JSONB across poll cycles.
3. Current SHAP already passed to agent via `v2Ctx.xgbShap` (line 5966).
4. **No new DB columns, no new queries, no new tables.** Everything computes from data already in scope.

## Implementation

### 1. New constants (near XGB_FEATURE_LABELS, line ~48)

```javascript
var XGB_VOLATILE_FEATURES = new Set(['pot', 'to', 'stl', 'oreb', 'runs']);
var XGB_STRUCTURAL_FEATURES = new Set(['paint', 'ast', 'blk', 'fta', 'efg', 'biglead', '3pr', 'rim_pct']);
```

### 2. New function: computeConvictionQuality(shapArray)

**Input:** SHAP array as returned by `computeXGBContributions()` -- array of `{f, v}` objects sorted by |v|.

**Output:** Object with:
- `volConcentration` (float 0-1): share of total positive SHAP from volatile features
- `strConcentration` (float 0-1): share of total positive SHAP from structural features
- `top1Feature` (string): name of highest positive SHAP feature
- `top1IsVolatile` (boolean): whether top-1 feature is in the volatile set
- `top1Share` (float 0-1): share of total positive SHAP from top-1 feature
- `basis` (string): "STRUCTURAL" if volConcentration < 0.30, "VOLATILE" if > 0.50, "MIXED" otherwise
- `bigleadShare` (float 0-1): share of total positive SHAP from biglead specifically
- `bigleadAnchored` (boolean): true when biglead >25% of positive SHAP -- scoreboard-confirmed dominance, 95.4% win rate in backtest
- `noScoreboardConfirmation` (boolean): true when biglead SHAP <= 0 despite high XGB -- stats not translating to lead, 19% loss rate in backtest

```javascript
function computeConvictionQuality(shapArray) {
  if (!shapArray || shapArray.length === 0) return null;
  const posFeatures = shapArray.filter(s => s.v > 0);
  const totalPos = posFeatures.reduce((sum, s) => sum + s.v, 0) || 0.001;

  let volPos = 0, strPos = 0, bigleadVal = 0;
  for (const s of shapArray) {
    if (s.f === 'biglead') bigleadVal = s.v;
    if (s.v > 0) {
      if (XGB_VOLATILE_FEATURES.has(s.f)) volPos += s.v;
      else strPos += s.v;
    }
  }

  const top1 = posFeatures.length > 0
    ? posFeatures.reduce((a, b) => a.v >= b.v ? a : b)
    : { f: 'none', v: 0 };
  const volConc = volPos / totalPos;
  const bigleadShare = Math.max(bigleadVal, 0) / totalPos;

  return {
    volConcentration: Math.round(volConc * 1000) / 1000,
    strConcentration: Math.round(strPos / totalPos * 1000) / 1000,
    top1Feature: top1.f,
    top1IsVolatile: XGB_VOLATILE_FEATURES.has(top1.f),
    top1Share: Math.round((top1.v / totalPos) * 1000) / 1000,
    basis: volConc >= 0.50 ? 'VOLATILE' : volConc < 0.30 ? 'STRUCTURAL' : 'MIXED',
    bigleadShare: Math.round(bigleadShare * 1000) / 1000,
    bigleadAnchored: bigleadShare > 0.25,
    noScoreboardConfirmation: bigleadVal <= 0,
  };
}
```

### 3. New function: computeTrajectorySignals(currentShap, cpArray, convictionQuality, xgbProb)

**Input:**
- `currentShap`: current SHAP array from `computeXGBContributions()`
- `cpArray`: checkpoint objects with `.shap` arrays (from `lt.checkpoints`)
- `convictionQuality`: output of `computeConvictionQuality()` for current SHAP
- `xgbProb`: current XGB win probability scalar

**Output:** Object with:
- `efgDelta` (float): change in efg SHAP from previous checkpoint (null if no prior)
- `divergence` (float): sum of volatile SHAP deltas minus sum of structural SHAP deltas
- `consecutiveVolDominant` (int): consecutive checkpoints where vol_concentration > 0.50
- `warnings` (array of strings): plain English warnings based on validated thresholds

**Warning priority order (by discriminating power):**

| Warning | Condition | Backtest evidence |
|---|---|---|
| NO_SCOREBOARD_TRANSLATION | biglead SHAP <= 0 AND XGB >= 0.70 | 19% loss vs 5% with biglead |
| EFFICIENCY_COLLAPSE | efg SHAP delta <= -0.30 | 1.33x lift, 48% loss |
| VOLATILE_FOUNDATION | vol_conc >= 0.50 AND top-1 volatile | 1.28x lift combo |
| STRUCTURAL_INVERSION | divergence >= 0.40 | 1.08x lift |

```javascript
function computeTrajectorySignals(currentShap, cpArray, convictionQuality, xgbProb) {
  if (!currentShap || currentShap.length === 0) return null;

  // Build lookup for current SHAP by feature name
  const currMap = {};
  for (const s of currentShap) currMap[s.f] = s.v;

  // Find most recent checkpoint with SHAP data
  let prevShapMap = null;
  for (let i = cpArray.length - 1; i >= 0; i--) {
    if (cpArray[i].shap && cpArray[i].shap.length > 0) {
      prevShapMap = {};
      for (const s of cpArray[i].shap) prevShapMap[s.f] = s.v;
      break;
    }
  }

  let efgDelta = null, divergence = null;
  if (prevShapMap) {
    efgDelta = (currMap['efg'] || 0) - (prevShapMap['efg'] || 0);
    efgDelta = Math.round(efgDelta * 1000) / 1000;

    let volDelta = 0, strDelta = 0;
    for (const f of XGB_FEATURE_LABELS) {
      const delta = (currMap[f] || 0) - (prevShapMap[f] || 0);
      if (XGB_VOLATILE_FEATURES.has(f)) volDelta += delta;
      else strDelta += delta;
    }
    divergence = Math.round((volDelta - strDelta) * 1000) / 1000;
  }

  // Count consecutive checkpoints where volatile features dominate (including current)
  let consecutiveVolDominant = 0;
  if (convictionQuality && convictionQuality.volConcentration >= 0.50) {
    consecutiveVolDominant = 1;
    for (let i = cpArray.length - 1; i >= 0; i--) {
      const cpConv = cpArray[i].shap ? computeConvictionQuality(cpArray[i].shap) : null;
      if (cpConv && cpConv.volConcentration >= 0.50) {
        consecutiveVolDominant++;
      } else {
        break;
      }
    }
  }

  // Evaluate warnings (ordered by discriminating power)
  const warnings = [];

  // 1. Biglead / scoreboard translation (strongest discriminator)
  if (convictionQuality && convictionQuality.noScoreboardConfirmation && xgbProb >= 0.70) {
    warnings.push('NO_SCOREBOARD_TRANSLATION: XGB reads '
      + Math.round(xgbProb * 100) + '% but biglead SHAP is flat/negative'
      + ' — statistical dominance is not translating to scoreboard control.'
      + ' In backtest, XGB >=70% without biglead confirmation has 19% loss rate vs 5% with it.');
  }

  // 2. Efficiency collapse (1.33-1.43x lift)
  if (efgDelta != null && efgDelta <= -0.30) {
    warnings.push('EFFICIENCY_COLLAPSE: Shooting efficiency SHAP dropped '
      + Math.abs(efgDelta).toFixed(2)
      + ' this checkpoint — opponent gaining structural shooting edge');
  }

  // 3. Volatile foundation (1.28x lift as combo)
  if (convictionQuality && convictionQuality.volConcentration >= 0.50 && convictionQuality.top1IsVolatile) {
    warnings.push('VOLATILE_FOUNDATION: '
      + Math.round(convictionQuality.volConcentration * 100)
      + '% of XGB conviction from volatile stats ('
      + convictionQuality.top1Feature + ' dominant at '
      + Math.round(convictionQuality.top1Share * 100) + '% share)'
      + ' — edge built on turnovers/hustle, may not sustain');
  }

  // 4. Structural inversion (1.08x lift)
  if (divergence != null && divergence >= 0.40) {
    warnings.push('STRUCTURAL_INVERSION: Volatile metrics growing while'
      + ' efficiency metrics declining, divergence='
      + divergence.toFixed(2)
      + ' — structural foundation shifting to opponent');
  }

  return { efgDelta, divergence, consecutiveVolDominant, warnings };
}
```

### 4. Attach to v2Ctx

**Location:** Inside v2Ctx object literal (~line 5960-5970), after `xgbShap`.

```javascript
convictionQuality: (() => {
  const _shap = _xgbFeatures ? computeXGBContributions(_xgbFeatures) : null;
  return _shap ? computeConvictionQuality(_shap) : null;
})(),
trajectorySignals: (() => {
  const _shap = _xgbFeatures ? computeXGBContributions(_xgbFeatures) : null;
  if (!_shap) return null;
  const _cq = computeConvictionQuality(_shap);
  const _cpHist = lt.checkpoints || [];
  return computeTrajectorySignals(_shap, _cpHist, _cq, _xgbWinProb);
})(),
```

**Scoping note:** `lt.checkpoints` is loaded from `live_tracking` JSONB at cycle start (line 5697), contains checkpoint data with SHAP arrays from prior cycles. Updated at line 6327 with current cycle's checkpoints. Alert processing at ~line 5870 reads prior-cycle data, which is correct for delta computation.

**Also attach to calibration-analysis path** (~line 4508) for consistency.

### 5. Render in agent prompt

**Location:** In `buildV2AgentPrompt(ctx)`, after existing XGB SHAP line (line ~401).

```javascript
${ctx.convictionQuality ? `
XGB CONVICTION QUALITY:
Basis: ${ctx.convictionQuality.basis} — ${Math.round(ctx.convictionQuality.strConcentration * 100)}% structural / ${Math.round(ctx.convictionQuality.volConcentration * 100)}% volatile
Top driver: ${ctx.convictionQuality.top1Feature} (${Math.round(ctx.convictionQuality.top1Share * 100)}% of positive SHAP)${ctx.convictionQuality.top1IsVolatile ? ' ⚠️ VOLATILE' : ''}
Scoreboard: ${ctx.convictionQuality.bigleadAnchored ? 'CONFIRMED — biglead driving ' + Math.round(ctx.convictionQuality.bigleadShare * 100) + '% (95% win rate in backtest)' : ctx.convictionQuality.noScoreboardConfirmation ? '⚠️ NOT CONFIRMED — biglead SHAP flat/negative, stats not translating to lead' : 'PARTIAL — biglead contributing ' + Math.round(ctx.convictionQuality.bigleadShare * 100) + '%'}` : ''}
${ctx.trajectorySignals && ctx.trajectorySignals.warnings.length > 0 ? `
CONVICTION WARNINGS:
${ctx.trajectorySignals.warnings.join('\n')}` : ''}
```

### 6. Agent prompt rules

**Location:** Near existing XGB rules (~line 399-413).

```
CONVICTION QUALITY (how XGB arrives at its prediction):
- SCOREBOARD STATUS is the strongest signal:
  - "CONFIRMED" (biglead anchored) = team has built commanding lead, dominance is real. XGB highly reliable (95% win rate).
  - "NOT CONFIRMED" (biglead flat/negative) = dominant in stats but no lead. Other features compensating. Elevate scrutiny (19% loss rate vs 5%).
  - "PARTIAL" = some biglead contribution. Moderate confidence.
- VOLATILE vs STRUCTURAL basis:
  - STRUCTURAL = conviction from shooting, paint, ball movement. Trust.
  - MIXED = partial volatile contribution. Weight stress/window more.
  - VOLATILE = conviction from turnovers/hustle. Skepticism warranted.
- CONVICTION WARNINGS fire on validated thresholds. Multiple warnings compounding = strong suppress/downgrade signal. Single warning = flag as RISK.
- These signals matter MOST for BUY and BWC_EDGE. For EXIT, XGB threshold itself is sufficient.
```

## Cascading Implications

### What this changes
- Agent prompt gets 3-5 additional lines per alert (conviction quality + warnings)
- Agent gains backtest-validated reasons to SUPPRESS/DOWNGRADE when:
  - Stats haven't translated to scoreboard (biglead signal)
  - Conviction riding volatile/hustle stats
  - Shooting efficiency actively collapsing
- No changes to mechanical thresholds, EXIT logic, floor computation, or gates

### What this does NOT change
- XGB win probability (same model, same output)
- SHAP computation (already exists)
- Checkpoint storage (SHAP already stored)
- Alert dedup, throttling, position tracking
- VULNERABILITY alert (mechanical, bypasses agent)
- Learning agent (no new fields)

### Risk
- **Over-suppression:** Agent suppresses every flagged alert. Mitigation: prompt says single warning = RISK, not auto-SUPPRESS. 54% of volatile-basis teams still win. 81% of no-scoreboard teams still win.
- **Token budget:** 3-5 extra lines. Negligible.
- **Latency:** Two array scans per poll cycle. Sub-millisecond.
- **False biglead confidence:** Q1 blowout lead generates high biglead SHAP, but Q1 leads regress. Mitigation: agent already has period context + structural stress/window catches later-game decay independently.

## TOR@CLE Validation

At Q3_END, the agent would have seen:

```
XGB CONVICTION QUALITY:
Basis: MIXED — 57% structural / 43% volatile
Top driver: pot (43% of positive SHAP) ⚠️ VOLATILE
Scoreboard: PARTIAL — biglead contributing 0%

CONVICTION WARNINGS:
EFFICIENCY_COLLAPSE: Shooting efficiency SHAP dropped 0.42 this checkpoint — opponent gaining structural shooting edge
STRUCTURAL_INVERSION: Volatile metrics growing while efficiency metrics declining, divergence=0.61 — structural foundation shifting to opponent
```

Three signals firing together: pot-driven volatile conviction, no scoreboard confirmation, efficiency collapsing. Combined with existing structural stress (CLE dominating Q3), agent has overwhelming grounds to SUPPRESS Q4 BUY sends.

## Implementation Order

1. Add constants (XGB_VOLATILE_FEATURES, XGB_STRUCTURAL_FEATURES)
2. Add computeConvictionQuality() function
3. Add computeTrajectorySignals() function
4. Verify lt.checkpoints scoping (confirmed: persists via live_tracking JSONB with SHAP arrays)
5. Attach convictionQuality and trajectorySignals to v2Ctx (alert + calibration-analysis paths)
6. Add agent prompt section in buildV2AgentPrompt()
7. Add agent rules for conviction quality interpretation
8. Syntax check, commit, deploy
9. Validate on next live slate

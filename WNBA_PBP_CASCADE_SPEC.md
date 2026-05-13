# WNBA PBP Cascade Driver — Implementation Spec

**Date:** May 12, 2026
**Status:** SPEC — awaiting confirmation before build
**Prerequisite research:** 526-game MC rate decomposition (this session)
**NBA reference:** v3.html `computePBPDivergence()` + `pbpDivColor()` (commit 9de8117)

---

## What This Is

Port the PBP cascade driver visualization from v3.html (NBA) to wnba-bdl.html with **WNBA-specific driver classification** based on MC possession rate decomposition, not indicator scores.

The NBA version classifies divergence drivers using I2+I3 (structural, 88% cascade) vs I1 (volatile, fades). **This does not transfer to WNBA.** Research on 213 divergence events across 526 WNBA games found the NBA's "structural" indicators (shooting/paint) have the LOWEST win rate (43.6%) while "volatile" indicators (disruption) have the HIGHEST (66.3%).

The WNBA classification uses **MC possession rates** — what's actually driving the canary's probability estimate.

---

## Research Findings (526 games, 213 divergence events, 35 trailing)

### What drives canary divergence
The canary diverges primarily because the ctrl team's **fg2Pct** improved by +15.3pp in the recent window vs their cumulative rate. Secondary: toRate improvement (+8.3pp), fg3Pct (+6.2pp).

### What predicts CASCADE vs FADE

| Rate delta (window−cumulative) | CASCADE | FADE | Signal |
|---|---|---|---|
| **ftaRate** | −0.054 | −0.010 | **★ FT-driven divergences FADE** |
| toRate | +0.086 | +0.076 | Marginal |
| fg2Pct, fg3Pct | ~same | ~same | Don't discriminate |

**ftaRate is the cascade discriminator.** When divergence is NOT FT-driven (ref-independent edge), it cascades.

### What predicts trailing BUY wins (n=35, 15W/20L)

| Rate delta | Wins | Losses | Delta |
|---|---|---|---|
| **fg3aShare** | −0.046 | +0.042 | **−0.087 ★★ Winners shift AWAY from 3s** |
| fg3Pct | +0.082 | +0.042 | +0.040 ★ |
| fg2Pct | +0.192 | +0.161 | +0.031 ★ |
| toRate | +0.042 | +0.061 | −0.018 |

Winning trailing teams: fg2Pct 60.8% in window (vs 48.0% cumulative), NOT chasing with volume 3s (fg3aShare declining). Losing trailing teams: modest fg2Pct improvement (51.8%), flat fg3aShare.

### Dominant rate driver (trailing)

| Driver | Win Rate | n |
|---|---|---|
| fg3Pct-driven | **62.5%** | 8 |
| fg2Pct-driven | 50.0% | 20 |
| toRate-driven | **0.0%** | 3 |
| fg3aShare-driven | 0.0% | 4 |

### Shooting vs turnover driven (trailing)

| Classification | Win Rate | n |
|---|---|---|
| Shooting-driven (≥60% of signal) | 46.9% | 32 |
| TO-driven (<60% shooting) | 0.0% | 3 |

---

## Driver Classification Logic

### WNBA `computePBPDivergenceWNBA(snap, allSnaps, snapIdx)`

**Trigger:** Same as NBA — `pbp - mcCum >= 0.15 AND pbp >= 0.65`

**Classification:** MC rate decomposition from raw_stats_json.

```
1. Parse current snapshot's raw_stats_json → cumulative rates
2. Find lookback snapshot (~4 snapshots back in allSnaps) → compute windowed rates via diff
3. Rate deltas = windowed - cumulative (per team, then ctrl-relative)
4. Score:
   - shootingDelta = |fg2Pct_delta| + |fg3Pct_delta|
   - toDelta = |toRate_delta|
   - ftaDelta = |ftaRate_delta|
   - total = shootingDelta + toDelta + ftaDelta
5. Classify:
   - SHOOTING: shootingDelta/total >= 0.55 AND ftaDelta/total < 0.35
   - FT_DRIVEN: ftaDelta/total >= 0.40
   - TO_DRIVEN: toDelta/total >= 0.50 AND shootingDelta/total < 0.30
   - MIXED: everything else
```

### Cascade Confidence

```
- Q2: HIGH (all divergences cascade ~85% in Q2)
- SHOOTING driver + PBP >= 0.80: HIGH
- FT_DRIVEN or TO_DRIVEN: LOW
- Otherwise: MODERATE
```

### Driver Labels (subscriber-facing)

```javascript
var driverLabels = {
  SHOOTING:  'Shooting efficiency surge — likely to stick',
  FT_DRIVEN: 'Free throw-driven edge — ref-dependent, may fade',
  TO_DRIVEN: 'Turnover-driven heater — may fade',
  MIXED:     'Mixed driver — watch for confirmation'
};
```

### Colors (matching NBA visual language)

```javascript
var driverColors = {
  SHOOTING:  '#34d399',  // green — durable (matches NBA STRUCTURAL)
  FT_DRIVEN: '#f5b544',  // amber — volatile (matches NBA VOLATILE)
  TO_DRIVEN: '#f5b544',  // amber — volatile
  MIXED:     '#a78bfa'   // purple — default
};
var driverIcons = {
  SHOOTING: '●', FT_DRIVEN: '◇', TO_DRIVEN: '◇', MIXED: '◉'
};
```

---

## Implementation Plan

### Files Modified

**wnba-bdl.html only** — no server changes needed. All data (raw_stats_json, mc_win_prob, mc_cum_win_prob) already available on snapshots.

### Changes (7 blocks, ~120 lines)

#### 1. CSS — divergence callout styles (~8 lines)
**Location:** After `.sig-pill:active` (line ~103)

Add `.div-callout`, `.div-driver`, `.div-body`, `.div-stat` — identical to v3.html lines 413-416.

#### 2. `computePBPDivergenceWNBA(snap, allSnaps, snapIdx)` function (~55 lines)
**Location:** Before `renderMCStrip()` (line ~1090)

```
Inputs:
  - snap: current snapshot from _allSnapshots
  - allSnaps: full _allSnapshots array
  - snapIdx: index of snap in allSnaps (for lookback)

Steps:
  a) Read mc_win_prob and mc_cum_win_prob from snap
  b) Check trigger: gap >= 0.15 AND pbp >= 0.65
  c) Parse snap.raw_stats_json → extract h/a cumulative box scores
  d) Find lookback snap (allSnaps[max(0, snapIdx-4)])
  e) Parse lookback.raw_stats_json → diff for windowed stats
  f) Compute per-team rates (cumulative and windowed)
  g) Compute rate deltas (window - cumulative), ctrl-relative
  h) Classify driver: SHOOTING / FT_DRIVEN / TO_DRIVEN / MIXED
  i) Compute cascade confidence
  j) Return {active, gap, driver, confidence, label, rates:{fg2Pct, fg3Pct, toRate, ftaRate}}

Edge cases:
  - raw_stats_json missing or unparseable → return null
  - lookback snap < 4 back (early Q2) → use cumulative only, driver=MIXED
  - Window FGA < 5 for either team → insufficient data, return null
```

#### 3. `pbpDivColorWNBA(snap, allSnaps, snapIdx)` function (~12 lines)
**Location:** Immediately after `computePBPDivergenceWNBA`

Same trigger logic, returns hex color for PBP line segment. Caches result on `snap._divColor` to avoid recomputing on every render.

#### 4. PBP line rendering — per-segment coloring (~15 lines)
**Location:** Replace WNBA `renderXGBChart` PBP path (line ~1612-1613)

**Current:** Single purple path
```javascript
if(_wps.canary){var cp=buildPath(pts,'mc_win_prob');if(cp.hasData)html+='<path ... stroke="#a78bfa" .../>';}
```

**New:** Per-segment colored paths (matching NBA approach). Build point array with per-point colors via `pbpDivColorWNBA`, then render as individual line segments with appropriate stroke color.

#### 5. Gap fill between PBP and MC Cum (~20 lines)
**Location:** Inside `renderXGBChart`, after floor line, before PBP line

When PBP series AND MC series are both on, and gap >= 0.15 + pbp >= 0.65: fill the area between PBP and MC Cum paths with the driver color at 12% opacity. Port directly from v3.html lines 1556-1580.

#### 6. Divergence callout HTML (~12 lines)
**Location:** After signal pills `</div>`, before MC investigation strip (line ~1219)

```html
<div class="div-callout" style="border-left-color:{color}">
  <div class="div-driver" style="color:{color}">{icon} {DRIVER} · cascade {confidence}</div>
  <div class="div-body">
    PBP→MC gap: <span class="div-stat">+{gap}pp</span>
    · fg2% <span class="div-stat">{fg2Pct}</span>
    · fg3% <span class="div-stat">{fg3Pct}</span>
    {if FT_DRIVEN: · FTA <span class="div-stat" style="color:#f5b544">{ftaRate}</span>}
    {if TO_DRIVEN: · TO <span class="div-stat" style="color:#f5b544">{toRate}</span>}
  </div>
</div>
```

Shows MC rate stats instead of NBA's I2/I3 indicator scores. Same visual layout.

#### 7. Time-based x-axis fix (~5 lines)
**Location:** `renderXGBChart` buildPath function (line ~1575)

**Current:** Index-based x-axis `px = (i/(pts.length-1))*W`
**New:** Time-based x-axis `px = (pts[i]._gs / maxGS) * W` using 600-second WNBA quarters

Port from v3.html (commit 45e00cb). Compute `_gs` for each point: `(period-1)*600 + (600-clockSec)`. Set `maxGS = maxQ * 600`.

---

## Data Flow

```
Snapshot (from DB via action=history)
  ├── mc_win_prob (PBP MC canary)
  ├── mc_cum_win_prob (MC cumulative)
  └── raw_stats_json (full BDL box score)
        ├── home team: fgm, fga, fg3m, fg3a, ftm, fta, tov, oreb
        └── away team: fgm, fga, fg3m, fg3a, ftm, fta, tov, oreb

computePBPDivergenceWNBA(snap, allSnaps, idx)
  ├── Current cumulative rates ← raw_stats_json
  ├── Lookback cumulative rates ← allSnaps[idx-4].raw_stats_json
  ├── Window rates = current - lookback
  ├── Rate deltas = window - cumulative (ctrl-relative)
  └── Driver classification → {SHOOTING, FT_DRIVEN, TO_DRIVEN, MIXED}
```

---

## What Does NOT Change

- Signal pill row (MC, XGB, PBP, Floor) — identical, already exists
- MC investigation strip (`renderMCStrip`) — already ported, no changes
- Server polling logic — no changes to poll-live-bdl.mjs
- Agent prompt — no changes (WNBA agent already has divergence context from NBA port)
- Alert thresholds — no changes
- PBP series default ON — already set (`canary: true`)

---

## Differences from NBA Implementation

| Aspect | NBA (v3.html) | WNBA (wnba-bdl.html) |
|---|---|---|
| Driver classification | Indicator-based (I2+I3 vs I1) | MC rate decomposition (fg2/fg3 vs toRate/ftaRate) |
| Callout stats | I2, I3 scores | fg2%, fg3%, toRate or ftaRate |
| Driver labels | STRUCTURAL / VOLATILE | SHOOTING / FT_DRIVEN / TO_DRIVEN |
| Colors | Same green/amber/purple | Same green/amber/purple |
| Icons | Same ●/◇/◉ | Same ●/◇/◉ |
| X-axis | Time-based (720s quarters) | Time-based (600s quarters) — currently index-based, FIXING |
| Gap fill | Identical | Identical |
| Trigger | gap ≥ 0.15, PBP ≥ 0.65 | Same |

---

## Risk Assessment

| Risk | Mitigation |
|---|---|
| raw_stats_json parsing on render | Cache parsed stats on snap object; only parse once per snapshot |
| Lookback snap missing early Q2 | Fallback to driver=MIXED when < 4 snapshots available |
| raw_stats_json format varies | BDL team_stats format is stable; use defensive `.get()` with fallbacks |
| Per-segment SVG more complex than single path | NBA already does this successfully; same approach |
| Performance with many snapshots | Lookback only parses 2 snapshots (current + lookback), not all |

---

## Estimated Effort

| Step | Lines | Time |
|---|---|---|
| CSS (copy from v3.html) | ~8 | 5 min |
| computePBPDivergenceWNBA | ~55 | 20 min |
| pbpDivColorWNBA | ~12 | 5 min |
| PBP per-segment rendering | ~15 | 10 min |
| Gap fill | ~20 | 10 min |
| Divergence callout HTML | ~12 | 5 min |
| Time-based x-axis fix | ~5 | 5 min |
| **Total** | **~127** | **~60 min** |

---

## Compound Establishment Threshold Change

Separate from the cascade port, deploying in the same commit:

**Change:** MC Cum threshold from ≥0.85 → ≥0.80 in compound establishment (poll-live-bdl.mjs)

**Accuracy impact:** 88.9% → 87.7% (−1.2pp), catches 5.5% more games (n=3,095 → 3,264)

**Code location:** `poll-live-bdl.mjs` line ~2791:
```javascript
// Current:
baseThreshold = mcCumWinProb != null && mcCumWinProb >= 0.85
             && xgbWinProb != null && xgbWinProb >= 0.60;
// New:
baseThreshold = mcCumWinProb != null && mcCumWinProb >= 0.80
             && xgbWinProb != null && xgbWinProb >= 0.60;
```

**Cascading updates:** Agent prompt references to "MC Cum (≥0.85)" → "MC Cum (≥0.80)" — grep and update all instances.

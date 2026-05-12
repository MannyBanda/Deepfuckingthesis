# PBP Cascade Driver — Signal Strip Redesign Spec

**Version:** 1.1
**Date:** May 12, 2026
**Status:** APPROVED — ready for implementation
**Scope:** v3.html signal strip redesign + PBP divergence driver classification + agent prompt integration

---

## 1. Research Findings

**Dataset:** 103 divergence moments across 40 NBA games. A "divergence" = PBP MC ≥ 0.70 while MC Cum < 0.55.

**Core finding:** When PBP MC diverges from MC Cum, the TYPE of structural advantage — not the magnitude — predicts whether MC Cum and XGB will follow ("cascade") or the PBP signal will fade.

### 1.1 Cascade Rates

| Condition | Cascade Rate | n |
|-----------|-------------|---|
| Overall | 77.7% | 103 |
| PBP MC ≥ 0.80 | **88%** | 77 |
| PBP MC 0.70–0.80 | 50% | 26 |
| Q2 divergence | **100%** | 44 |
| Q3/Q4 divergence | 61% | 59 |
| Gap < 0.30 | **100%** | 10 |
| Gap > 0.50 | 69% | 51 |

### 1.2 Driver Classification

| Feature at Divergence | Cascade (n=80) | Fade (n=23) | Read |
|-----------------------|---------------|-------------|------|
| **I3 (Shot Quality)** | 0.46 | **0.00** | Shooting edge sticks |
| **I2 (Rim Pressure)** | 0.32 | 0.07 | Paint/FT edge sticks |
| **I1 (Possession/Transition)** | 0.51 | **0.87** | **INVERTED — high I1 predicts fade** |
| TO diff (ctrl advantage) | -1.1 | **-8.9** | Massive TO advantage = volatile |
| POT diff | +2.5 | **+13.0** | Scoring off turnovers = volatile |
| SCP diff | +0.2 | **+6.6** | Second chance from TOs = volatile |
| AST diff | +0.3 | -2.5 | Assists = scheme, not circumstance |
| BLK diff | -1.9 | -7.1 | Blocks alone don't sustain |

**Summary:** I1-driven divergence (turnovers, steals, POT) = volatile heater that regresses. I2+I3-driven divergence (paint pressure, shooting quality, assists) = scheme-driven edge that cascades to cumulative signals.

### 1.3 Floor Paradox

| Floor at Divergence | Cascade Rate |
|---------------------|-------------|
| Floor < 0.60 | **100%** (n=45) |
| Floor 0.60–0.70 | 57% (n=23) |
| Floor 0.70–0.80 | **28%** (n=18) |
| Floor 0.80+ | **100%** (n=17) |

Floor < 0.60 is 100% because these are early-Q2 divergences where floor hasn't anchored yet — PBP sees it before floor does. Floor 0.70–0.80 fades because floor is propped up by I1 volatile stats that regress. Floor 0.80+ cascades because the edge is genuinely dominant.

---

## 2. Classification Algorithm

Computed client-side on each snapshot where divergence exists.

### 2.1 Divergence Detection

```
gap = mc_win_prob - mc_cum_win_prob
isDiverging = gap ≥ 0.15 AND mc_win_prob ≥ 0.65
```

### 2.2 Driver Classification

```
// Indicator-based classification
volatileScore = i1                    // I1 alone — turnover/steal/transition dominance
structuralScore = (i2 + i3) / 2       // I2+I3 average — paint + shooting quality

if (structuralScore ≥ 0.50):           STRUCTURAL
else if (volatileScore ≥ 0.75 AND structuralScore < 0.25):  VOLATILE
else:                                  MIXED
```

### 2.3 Cascade Confidence Tag

```
// Combine driver + PBP strength + quarter for a single read
if (quarter == 2):                     HIGH (Q2 = 100% cascade)
if (driver == STRUCTURAL AND pbp_mc ≥ 0.80):  HIGH
if (driver == STRUCTURAL AND pbp_mc < 0.80):   MODERATE
if (driver == MIXED):                  MODERATE
if (driver == VOLATILE):               LOW
if (gap > 0.50 AND driver != STRUCTURAL):      LOW (overextended)
```

### 2.4 Output Object

Stored on `cs._pbpDivergence` per game card:

```javascript
{
  active: true,           // divergence detected
  gap: 0.48,              // PBP MC - MC Cum
  driver: 'STRUCTURAL',   // STRUCTURAL | VOLATILE | MIXED
  confidence: 'HIGH',     // HIGH | MODERATE | LOW
  i1: 0.50, i2: 0.75, i3: 1.0,  // indicator scores at this snapshot
  label: 'Shooting + paint edge — likely to stick'  // human-readable
}
```

---

## 3. Signal Strip Redesign (v3.html)

### 3.1 Current State

- MC investigation strip sits in the structural read section (collapsible card)
- Shows pattern badge (INVESTIGATING / COLLAPSE / OSCILLATING / CLEARED)
- WP chart defaults to ESPN mode; Structural mode is secondary toggle
- Signal series (MC Cum, PBP, Floor) only render in "Structural" mode on the chart itself
- No toggleable pills, no independent strip

### 3.2 New Design

**Default chart mode: STRUCTURAL** (currently defaults to ESPN). The structural chart with signal overlay is the primary view — ESPN WP is the secondary toggle. Change: `cs._wpMode` initializes to `'xgb'` instead of `'espn'` (v3.html line 1065).

Move signal strip to **below the WP chart**, matching WNBA dashboard pattern. The WP chart (ESPN or Structural mode) renders above; the signal strip renders below as a unified component.

#### Layout (top to bottom)

```
┌─────────────────────────────────────────┐
│  ESPN / STRUCTURAL toggle    XGB 71%    │
│                              MC  98%    │
│  ┌─────────────────────────────────┐    │
│  │         WP / XGB Chart          │    │
│  │   (ESPN win prob or XGB line)   │    │
│  └─────────────────────────────────┘    │
│  1ST    2ND    3RD    4TH               │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │       Signal Strip Chart         │    │
│  │  MC Cum (gold) ─────────────    │    │
│  │  XGB (cyan)    ─────────────    │    │
│  │  PBP MC (purple/color-coded)    │    │
│  │  Floor (orange, off default)    │    │
│  │  ░░░ gap fill (structural)░░░   │    │
│  └─────────────────────────────────┘    │
│  [MC 98%] [XGB 71%] [PBP 99%] [Floor]  │
│                                         │
│  ┌──── DIVERGENCE CALLOUT ──────┐       │
│  │ PBP → MC gap: +0.48          │       │
│  │ STRUCTURAL — shooting + paint │       │
│  │ Cascade confidence: HIGH      │       │
│  └──────────────────────────────┘       │
└─────────────────────────────────────────┘
```

#### Signal Strip Chart

- Height: 60px (compact — this is a secondary chart)
- Y-axis: 0% to 100% (same as WP chart above, visually aligned)
- X-axis: game time, aligned with WP chart quarter labels
- Gridline at 50% (dashed, subtle)
- Background: `var(--bg-surface-2)`

#### Series

| Series | Color | Default | Source |
|--------|-------|---------|--------|
| MC Cum | `#FDB927` (gold) | ON | `mc_cum_win_prob` |
| XGB | `#67e8f9` (cyan) | ON | `xgb_win_prob` |
| PBP MC | `#a78bfa` (purple) / color-coded | **ON** (changed from OFF) | `mc_win_prob` |
| Floor | `#ff6b35` (orange) | OFF | `floor_score` |

#### Toggle Pills

Below the chart, horizontal row of pill buttons (same as WNBA):
- Each pill shows label + current value: `[MC 98%]`
- Active: colored background, colored text
- Inactive: dim text, no background
- Tap toggles series on/off, re-renders chart

### 3.3 PBP MC Color-Coding (Divergence Driver)

When PBP MC diverges from MC Cum (gap ≥ 0.15), the PBP line segments change color:

| Condition | PBP Line Color | Meaning |
|-----------|---------------|---------|
| No divergence (gap < 0.15) | `#a78bfa` (default purple) | PBP aligned with cumulative |
| STRUCTURAL divergence | `#34d399` (green) | Edge is scheme-driven — likely to cascade |
| VOLATILE divergence | `#f5b544` (amber) | Edge is turnover-driven — may fade |
| MIXED divergence | `#a78bfa` (purple, unchanged) | Ambiguous driver |

The color shift is per-segment — as the game evolves, the PBP line may transition from green to amber or vice versa, showing the driver shifting in real time.

### 3.4 Gap Fill Shading

When PBP MC > MC Cum by ≥ 0.15 AND at least one of MC/PBP series is toggled ON:

- Fill the area between the PBP line and the MC Cum line
- Fill color matches the PBP line color (green, amber, or purple) at 12% opacity
- Creates a visual "divergence zone" that shows both magnitude and quality

When PBP MC < MC Cum (PBP is BELOW cumulative — rare but possible):
- No fill. This means PBP is more bearish than cumulative — different signal, not divergence.

### 3.5 Divergence Callout

When `cs._pbpDivergence.active` is true, render a compact callout below the pills:

```
┌─ ● STRUCTURAL ─────────────────────┐
│  PBP→MC gap: +48pp  Cascade: HIGH  │
│  I2 (Paint) 0.75  I3 (Shooting) 1.0│
└─────────────────────────────────────┘
```

- Border-left color matches driver (green/amber/purple)
- Shows gap magnitude, cascade confidence, and the indicator scores driving it
- Collapses/hides when no divergence active (gap < 0.15)
- Only shows when PBP pill is toggled ON

### 3.6 MC Investigation Integration

The existing MC investigation strip (COLLAPSE / OSCILLATING / CLEARED badges) moves INTO the divergence callout area. When an MC investigation is active:

```
┌─ ▼ COLLAPSE ────────────────────────┐
│  Pattern: CLEAN  Trigger: MC<0.70   │
│  Post-trigger rates: paint -8, TO +3│
└─────────────────────────────────────┘
```

When both divergence AND investigation are active (divergence up top, investigation below):

```
┌─ ● STRUCTURAL ─────────────────────┐
│  PBP→MC gap: +48pp  Cascade: HIGH  │
└─────────────────────────────────────┘
┌─ ▼ COLLAPSE ────────────────────────┐
│  Pattern: CLEAN  Trigger: MC<0.70   │
└─────────────────────────────────────┘
```

---

## 4. Agent Prompt Integration

### 4.1 New Context Block

Add to auto-analysis and alert agent prompts when divergence is active:

```
PBP DIVERGENCE: PBP MC 0.96 vs MC Cum 0.48 (gap +0.48)
Driver: STRUCTURAL (I2=0.75, I3=1.0 — paint + shooting dominance)
Cascade confidence: HIGH
Research: Structural divergences cascade to MC Cum 88% of the time.
I1=0.50 (moderate) — not a turnover-driven heater.
```

### 4.2 Agent Decision Influence

The divergence classification should influence agent reasoning but NOT be a hard gate:

- **STRUCTURAL + HIGH confidence:** Agent should lean toward SEND on BUY/BWC alerts even if MC Cum is still low. "PBP sees structural rates that cumulative hasn't absorbed yet."
- **VOLATILE + LOW confidence:** Agent should lean toward SUPPRESS or DOWNGRADE. "PBP elevation is turnover-driven and may regress. Wait for cumulative confirmation."
- **MIXED:** No influence — standard agent evaluation.

### 4.3 Prompt Text

```
PBP DIVERGENCE DRIVER (research-validated, 103 game study):
When PBP MC diverges from MC Cum, the DRIVER TYPE predicts whether cumulative signals will follow:
- STRUCTURAL (I2+I3 dominant): 88% cascade rate. Shooting and paint edges are scheme-driven and persist.
- VOLATILE (I1 dominant): Turnover-driven advantages regress. POT/SCP production fades as TO rates normalize.
- Q2 divergence: 100% cascade regardless of driver — enough game remaining.
- PBP MC ≥ 0.80: 88% cascade. PBP MC 0.70-0.80: coin flip (50%).
Use this to calibrate trust in PBP MC when it disagrees with MC Cum.
Do NOT use divergence driver as a hard gate — it's probabilistic context for your reasoning.
```

---

## 5. Data Flow

### 5.1 No Server Changes Required

All data already exists on snapshots:
- `mc_win_prob` (PBP MC)
- `mc_cum_win_prob` (MC Cum)
- `xgb_win_prob`
- `i1`, `i2`, `i3`, `i4`, `i5`
- `floor_score`

Classification is computed client-side in `renderCard()` on every render cycle.

### 5.2 Computation Location

```javascript
// In renderCard(), after snapshot processing, before chart rendering:
function computePBPDivergence(latestSnap) {
  var pbp = latestSnap.mc_win_prob;
  var mc = latestSnap.mc_cum_win_prob;
  if (pbp == null || mc == null) return null;
  var gap = pbp - mc;
  if (gap < 0.15 || pbp < 0.65) return null;

  var i1 = latestSnap.i1 || 0, i2 = latestSnap.i2 || 0, i3 = latestSnap.i3 || 0;
  var structScore = (i2 + i3) / 2;
  var driver = 'MIXED';
  if (structScore >= 0.50) driver = 'STRUCTURAL';
  else if (i1 >= 0.75 && structScore < 0.25) driver = 'VOLATILE';

  var quarter = latestSnap.period || 2;
  var confidence = 'MODERATE';
  if (quarter == 2) confidence = 'HIGH';
  else if (driver == 'STRUCTURAL' && pbp >= 0.80) confidence = 'HIGH';
  else if (driver == 'VOLATILE') confidence = 'LOW';
  else if (gap > 0.50 && driver != 'STRUCTURAL') confidence = 'LOW';

  return { active: true, gap: gap, driver: driver, confidence: confidence,
           i1: i1, i2: i2, i3: i3, pbp: pbp, mc: mc };
}
```

### 5.3 Per-Segment Coloring

For drawing the PBP line with color-coded segments, the chart renderer needs divergence data on EACH snapshot, not just the latest. The `renderSignalStripChart()` function iterates through all snapshots, computing gap and driver per-point, then draws line segments with appropriate stroke color.

---

## 6. Implementation Plan

### 6.1 Steps

| Step | What | Lines | Notes |
|------|------|-------|-------|
| 1 | CSS for signal strip, pills, divergence callout | ~40 | New styles, match WNBA patterns |
| 2 | Default chart mode → Structural | 1 | `cs._wpMode` init `'xgb'` instead of `'espn'` |
| 3 | `computePBPDivergence()` function | ~30 | Classification algorithm |
| 4 | `renderSignalStripChart()` function | ~120 | Canvas chart with 4 series, color-coded PBP, gap fill |
| 5 | Toggle pill row + callout HTML | ~40 | In `renderCard()`, below WP chart |
| 6 | Move MC investigation strip into callout area | ~20 | Relocate existing HTML generation |
| 7 | Agent prompt integration | ~15 | Divergence context block in alert + analysis prompts |
| **Total** | | **~265** | |

### 6.2 Files Modified

- `v3.html` — default chart mode change (line 1065), signal strip chart, pills, divergence callout, MC investigation relocation, CSS (~250 lines)
- `netlify/functions/poll-live-bdl.mjs` — agent prompt divergence context (~15 lines)

### 6.3 Risk Assessment

- **Low risk:** All client-side rendering changes. No server polling logic touched.
- **Agent prompt change:** Additive context block, no existing prompt text modified.
- **Regression surface:** MC investigation strip relocation — verify CLEAN/WAVE/NORMALIZED badges still render correctly in new location.

---

## 7. Future Extensions

- **Threshold recalibration:** After observing live slates with the new WNBA XGB model, recalibrate compound thresholds using XGB probability distribution from the new model.
- **Cascade prediction model:** The research data (103 events) is a starting point. With a full season of data (~500+ divergence events), a lightweight logistic model could replace the indicator-based heuristic with a proper probability estimate.
- **WNBA port:** Same signal strip and divergence classification applies to `wnba-bdl.html`. WNBA already has the strip layout — just needs the color-coded PBP line and divergence callout added.
- **PBP cascade market model (backlog):** Predict when PBP MC divergence will cascade to live ML movement. This spec's classification is the prerequisite — it identifies WHICH divergences to track for ML movement.

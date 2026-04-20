# Checkpoint-Based Graduation System — Implementation Spec

**Date:** April 20, 2026  
**Status:** APPROVED — ready to build  
**File affected:** `netlify/functions/poll-live-bdl.mjs` (sole file)  
**Depends on:** V2 BWC Alert Engine Steps 1-6 (deployed), existing graduation code (deployed)  
**Replaces:** Current 60s-poll watermark graduation (lines ~4981-5075)

---

## 1. Problem Statement

The current graduation system fires POSITION OPEN based on a single 60s snapshot meeting rank criteria. Production backtest (196 games) showed A-tier watermark at 74.4% — 20pp below the checkpoint-based backtest (93.4% on 1,230 games). Root cause: 76% of graduations fire on a single snapshot spike. A team's floor can momentarily reach 0.95 due to cumulative anchoring while their mean floor across the game is 0.57.

The full-season backtest at 3-minute checkpoint intervals (1,230 games, 14 checkpoints per game) confirmed:
- Mean floor ≥ 0.80 + min floor ≥ 0.65 = **87.7% full season** (n=334)
- Only one team graduated + MF≥0.80 = **84.7% full season** (n=457)  
- 6+ checkpoints at peak tier = **90.6% full / 84.7% competitive** (n=1016/569)
- Wire-to-wire = **99.7% full / 98.8% competitive** (n=362/84)

Competitive games defined as: ABS(margin) ≤ 5 at any Q3 checkpoint OR ≤ 7 at any Q4 checkpoint.

---

## 2. Architecture Overview

### Current flow (REPLACE):
```
Every 60s poll → computeServer() → classifyRank() from raw ctrl_team_holds → 
  if rank improved → GRADUATION → fire PO immediately
```

### New flow (BUILD):
```
Every 60s poll → computeServer() → check if 3-min checkpoint crossed →
  if checkpoint: capture { floor, rank, margin, conv, team } on lt.checkpoints[] →
    compute running mean floor + min floor from array →
    evaluate graduation from checkpoint-level holds →
    apply lane-specific MF gates →
    fire PO if all gates pass
```

The 60s poll loop, indicator computation, BWC fire, state machine, BUY path, and transition alerts are UNCHANGED. The checkpoint scaffold is a purely additive layer between the existing `computeServer()` output and the graduation detection block.

---

## 3. Constants

### 3.1 Checkpoint definitions

Add near existing BWC state machine constants (~line 1328):

```javascript
// 3-minute checkpoint boundaries (game seconds from start)
// gameSec = (period - 1) * 720 + (720 - clockRemainingInSeconds)
const GRAD_CHECKPOINTS = [
  { label: 'Q1_END', period: 1, clockSec: 0,   gameSec: 720  },
  { label: 'Q2_9',   period: 2, clockSec: 540, gameSec: 900  },
  { label: 'Q2_6',   period: 2, clockSec: 360, gameSec: 1080 },
  { label: 'Q2_3',   period: 2, clockSec: 180, gameSec: 1260 },
  { label: 'Q2_END', period: 2, clockSec: 0,   gameSec: 1440 },
  { label: 'Q3_9',   period: 3, clockSec: 540, gameSec: 1620 },
  { label: 'Q3_6',   period: 3, clockSec: 360, gameSec: 1800 },
  { label: 'Q3_3',   period: 3, clockSec: 180, gameSec: 1980 },
  { label: 'Q3_END', period: 3, clockSec: 0,   gameSec: 2160 },
  { label: 'Q4_9',   period: 4, clockSec: 540, gameSec: 2340 },
  { label: 'Q4_6',   period: 4, clockSec: 360, gameSec: 2520 },
  { label: 'Q4_3',   period: 4, clockSec: 180, gameSec: 2700 },
];
```

### 3.2 Lane thresholds

```javascript
const LANE_THRESHOLDS = {
  underdog:       { mfGate: 0.70, minFGate: 0.60 },  // pregame ML > +100
  tossup:         { mfGate: 0.75, minFGate: 0.65 },  // pregame ML -100 to +100
  favorite:       { mfGate: 0.75, minFGate: 0.65 },  // pregame ML -101 to -250
  heavy_favorite: { mfGate: 0.80, minFGate: 0.65 },  // pregame ML -251 or worse
};
```

---

## 4. New `lt` (live_tracking) Fields

All stored in the existing `live_tracking` JSONB column on `games` table. No schema migration needed.

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `lt.checkpoints` | `Array<{label, floor, rank, margin, conv, team, oppCount, period, clock}>` | `[]` | Captured checkpoint readings |
| `lt.next_cp_idx` | `integer` | `0` | Index into GRAD_CHECKPOINTS for next expected checkpoint |
| `lt.cp_holds` | `integer` | `0` | Consecutive checkpoints where BWC team has control |
| `lt.cp_peak_rank` | `string` | `'C'` | Watermark rank from checkpoint evaluations |
| `lt.cp_graduation` | `{rank, cp_label, floor, margin, period, clock}` | `null` | When/where graduation happened |
| `lt.cp_opp_holds` | `integer` | `0` | Consecutive checkpoints where opponent has control |
| `lt.cp_opp_graduation` | `{rank, cp_label, floor, margin}` | `null` | Opponent graduation (for only_one_grad) |
| `lt.pregame_ml` | `integer` | `null` | BWC team's pregame ML (captured at first odds reading) |
| `lt.lane` | `string` | `null` | 'underdog' / 'tossup' / 'favorite' / 'heavy_favorite' |

Existing `lt` fields that STAY unchanged:
- `lt.bwc_fired` — still fires at 3 consecutive 60s holds (BWC establishment)
- `lt.po_fired` — set when PO fires (gates downstream state transition alerts)
- `lt.graduation` — per-team graduation map (used by only_one_grad suppression)
- `lt.ctrl_team_holds` — 60s poll counter (still used by TRACKING alert and state machine)
- `lt.ctrl_flips` — total control flips (still used for S-rank detection)
- `lt._prev_bwc_state` — state machine memory
- `lt.home_peak_floor` / `lt.away_peak_floor` — erosion tracking

---

## 5. Checkpoint Capture Logic

### 5.1 Where in the poll loop

Insert AFTER `updateLiveTracking()` call and AFTER `computeConviction()` / indicator computation, but BEFORE the existing graduation detection block. The checkpoint capture needs the current period, clock, floor, indicators, and margin — all of which are already computed by that point.

**Location:** Inside the `if (lt.bwc_fired)` block, approximately line ~4980, BEFORE the current `// ── V2 GRADUATION DETECTION` comment.

### 5.2 Logic

```javascript
// ── CHECKPOINT CAPTURE (3-min boundaries) ──
if (lt.bwc_fired) {
  if (!lt.checkpoints) lt.checkpoints = [];
  if (lt.next_cp_idx == null) lt.next_cp_idx = 0;

  // Convert current game time to gameSec
  const cpClockMatch = String(clock).match(/(\d+):(\d+)/);
  const cpClockSec = cpClockMatch 
    ? parseInt(cpClockMatch[1]) * 60 + parseInt(cpClockMatch[2]) 
    : 720;
  const currentGameSec = (currentPeriod - 1) * 720 + (720 - cpClockSec);

  // Check if we've crossed the next checkpoint boundary
  while (lt.next_cp_idx < GRAD_CHECKPOINTS.length) {
    const nextCp = GRAD_CHECKPOINTS[lt.next_cp_idx];
    if (currentGameSec < nextCp.gameSec) break; // haven't reached it yet

    // ── Capture this checkpoint ──
    const bwcTeam = lt.bwc_fired.team;
    const cpConv = computeConviction(ind);
    const cpOppCount = cpConv.indicatorsLost.length;
    const cpCtrlIsHome = ind.controlTeam === hA;
    const cpCtrlPts = cpCtrlIsHome ? ind.homePts : ind.awayPts;
    const cpOppPts = cpCtrlIsHome ? ind.awayPts : ind.homePts;
    const cpMargin = cpCtrlPts - cpOppPts;

    const cpEntry = {
      label: nextCp.label,
      floor: ind.score,
      team: ind.controlTeam,
      margin: cpMargin,
      conv: cpConv.tier,
      oppCount: cpOppCount,
      period: currentPeriod,
      clock: clock,
    };
    lt.checkpoints.push(cpEntry);

    // ── Update checkpoint-level holds ──
    if (ind.controlTeam === bwcTeam) {
      lt.cp_holds = (lt.cp_holds || 0) + 1;
      lt.cp_opp_holds = 0; // reset opponent counter
    } else {
      lt.cp_holds = 0; // reset BWC team counter
      // Track opponent graduation
      if (cpMargin >= 2 && ind.score >= 0.60) {
        lt.cp_opp_holds = (lt.cp_opp_holds || 0) + 1;
      } else {
        lt.cp_opp_holds = 0;
      }
    }

    // ── Classify rank at this checkpoint (BWC team only) ──
    if (ind.controlTeam === bwcTeam && cpMargin >= 2 && ind.score >= 0.60) {
      const cpRank = classifyRank(cpConv.tier, cpMargin, lt.cp_holds, cpOppCount);

      // Graduation = rank improved from previous peak
      const prevPeak = lt.cp_peak_rank || 'C';
      const CP_RANK_ORDER = { C: 0, B: 1, A: 2 };
      if (CP_RANK_ORDER[cpRank] > CP_RANK_ORDER[prevPeak]) {
        lt.cp_peak_rank = cpRank;
        lt.cp_graduation = {
          rank: cpRank, cp_label: nextCp.label,
          floor: ind.score, margin: cpMargin,
          period: currentPeriod, clock: clock,
        };
        log(`${matchup}: ▲ CP GRADUATION ${bwcTeam} ${prevPeak}→${cpRank} @ ${nextCp.label}`);
      }
    }

    // ── Opponent rank classification ──
    if (ind.controlTeam !== bwcTeam && lt.cp_opp_holds >= 2 && cpMargin >= 2 && ind.score >= 0.60) {
      const oppTeam = ind.controlTeam;
      const oppConvForRank = computeConviction(ind);
      // For opponent rank, their "opp indicators" are the BWC team's indicators
      const oppOppCount = oppConvForRank.indicatorsWon.length; // BWC team's indicators won = opponent's opposition
      const oppRank = classifyRank(oppConvForRank.tier, cpMargin, lt.cp_opp_holds, oppOppCount);
      
      if (oppRank === 'B' || oppRank === 'A') {
        const prevOppRank = lt.cp_opp_graduation?.rank || 'C';
        if (CP_RANK_ORDER[oppRank] > (CP_RANK_ORDER[prevOppRank] || 0)) {
          lt.cp_opp_graduation = {
            rank: oppRank, cp_label: nextCp.label,
            floor: ind.score, margin: cpMargin,
          };
          log(`${matchup}: ⚠ CP OPP GRADUATION ${oppTeam} → ${oppRank}-Rank @ ${nextCp.label}`);
        }
      }
    }

    lt.next_cp_idx++;
    log(`${matchup}: 📍 CP ${nextCp.label} captured — team=${cpEntry.team} floor=${cpEntry.floor.toFixed(2)} margin=${cpEntry.margin} conv=${cpEntry.conv} holds=${lt.cp_holds}`);
  }
}
```

### 5.3 Critical: oppCount computation for opponent rank

When computing opponent rank at a checkpoint, the opponent's "opponent indicator count" is how many indicators the BWC TEAM wins (since from the opponent's perspective, the BWC team's indicators are opposition). This uses `indicatorsWon` from `computeConviction(ind)` which is control-team-relative. When the opponent IS the control team, their `indicatorsLost` are the BWC team's indicators. Verify this carefully during implementation.

---

## 6. Mean Floor / Min Floor Computation

### 6.1 Function

Add near checkpoint constants (~line 1400):

```javascript
function computeCheckpointFloorStats(checkpoints, bwcTeam) {
  // Only BWC-eligible checkpoints: team has control + floor >= 0.60 + margin >= 2
  const eligible = checkpoints.filter(cp => 
    cp.team === bwcTeam && cp.floor >= 0.60 && cp.margin >= 2
  );
  if (eligible.length === 0) return { meanFloor: null, minFloor: null, eligibleCount: 0 };

  let sum = 0, min = 999;
  for (const cp of eligible) {
    sum += cp.floor;
    if (cp.floor < min) min = cp.floor;
  }
  return {
    meanFloor: Math.round((sum / eligible.length) * 1000) / 1000,
    minFloor: Math.round(min * 1000) / 1000,
    eligibleCount: eligible.length,
  };
}
```

### 6.2 When to compute

Compute EVERY time a checkpoint is captured (inside the while loop in §5.2, after pushing `cpEntry`). Store on `lt`:

```javascript
const cpFloorStats = computeCheckpointFloorStats(lt.checkpoints, lt.bwc_fired.team);
lt.cp_mean_floor = cpFloorStats.meanFloor;
lt.cp_min_floor = cpFloorStats.minFloor;
lt.cp_eligible_count = cpFloorStats.eligibleCount;
```

---

## 7. Lane Classification (Pregame Odds)

### 7.1 Capture pregame ML

On FIRST odds reading for a game (when `lt.pregame_ml` is null), capture the BWC team's ML:

```javascript
// Inside the poll loop, after odds are fetched and BWC has fired
if (lt.bwc_fired && lt.pregame_ml == null && odds) {
  const bwcIsHome = lt.bwc_fired.team === hA;
  lt.pregame_ml = bwcIsHome ? odds.homeML : odds.awayML;
  
  // Classify lane
  const ml = lt.pregame_ml;
  if (ml == null) lt.lane = 'tossup'; // no odds available, default
  else if (ml > 100) lt.lane = 'underdog';
  else if (ml >= -100) lt.lane = 'tossup';
  else if (ml >= -250) lt.lane = 'favorite';
  else lt.lane = 'heavy_favorite';
  
  log(`${matchup}: 🏷 Lane: ${lt.lane} (pregame ML ${ml > 0 ? '+' : ''}${ml})`);
}
```

**Location:** After odds fetch (~line 4616) and after BWC fire detection (~line 4740). Must be AFTER `lt.bwc_fired` is set so we know which team's ML to capture.

**Important:** This captures the FIRST odds reading after BWC fires, not necessarily pregame. For most games, BWC fires early Q2 and the line hasn't moved much from pregame. If BDL returns stale pregame odds (which it often does for the first few polls), this is effectively pregame ML.

### 7.2 Lane lookup for PO gate

```javascript
function getLaneGates(lane) {
  return LANE_THRESHOLDS[lane] || LANE_THRESHOLDS.tossup;
}
```

---

## 8. POSITION OPEN Firing Rules (REPLACE existing graduation block)

### 8.1 What to REMOVE

Remove the entire current graduation detection block at lines ~4981-5075:
- `// ── V2 GRADUATION DETECTION (fires POSITION OPEN at rank upgrade) ──`
- All code through the opponent graduation tracking closing brace

### 8.2 What to REPLACE WITH

The new PO evaluation happens at each checkpoint capture (inside the §5.2 while loop), AFTER rank classification and mean floor computation:

```javascript
// ── POSITION OPEN EVALUATION (checkpoint-gated) ──
if (lt.cp_graduation && !lt.po_fired && ind.controlTeam === bwcTeam) {
  const gRank = lt.cp_graduation.rank;
  const gates = getLaneGates(lt.lane || 'tossup');
  
  let poShouldFire = false;
  let poBlockReason = null;

  // A-Rank: fires at any checkpoint meeting MF/minF gates
  if (gRank === 'A') {
    if (lt.cp_mean_floor >= gates.mfGate && lt.cp_min_floor >= gates.minFGate) {
      poShouldFire = true;
    } else {
      poBlockReason = `MF ${lt.cp_mean_floor?.toFixed(3)} < ${gates.mfGate} or minF ${lt.cp_min_floor?.toFixed(2)} < ${gates.minFGate}`;
    }
  }

  // B-Rank: requires Q3_6+ AND MF/minF gates
  if (gRank === 'B') {
    const bCpClockSec = cpClockMatch ? parseInt(cpClockMatch[1]) * 60 + parseInt(cpClockMatch[2]) : 720;
    const pastQ3_6 = currentPeriod > 3 || (currentPeriod === 3 && bCpClockSec <= 360);
    if (pastQ3_6 && lt.cp_mean_floor >= gates.mfGate && lt.cp_min_floor >= gates.minFGate) {
      poShouldFire = true;
    } else if (!pastQ3_6) {
      poBlockReason = `B-Rank requires Q3_6+ (currently Q${currentPeriod} ${clock})`;
    } else {
      poBlockReason = `MF ${lt.cp_mean_floor?.toFixed(3)} < ${gates.mfGate} or minF ${lt.cp_min_floor?.toFixed(2)} < ${gates.minFGate}`;
    }
  }

  // only_one_grad check
  if (poShouldFire) {
    if (lt.cp_opp_graduation && (lt.cp_opp_graduation.rank === 'B' || lt.cp_opp_graduation.rank === 'A')) {
      poShouldFire = false;
      poBlockReason = `opponent also graduated (${lt.cp_opp_graduation.rank}-Rank)`;
      log(`${matchup}: ✗ PO SUPPRESSED — both graduated: ${bwcTeam} ${gRank} vs opp ${lt.cp_opp_graduation.rank}`);
    }
  }

  // Fire PO
  if (poShouldFire && alertMinsLeft >= 1.0) {
    const isWireToWire = (lt.ctrl_flips || 0) === 0;
    const poRank = (gRank === 'A' && isWireToWire) ? 'S' : gRank;

    lt.po_fired = {
      team: bwcTeam, rank: poRank,
      period: currentPeriod, clock: clock,
      mean_floor: lt.cp_mean_floor,
      min_floor: lt.cp_min_floor,
      lane: lt.lane,
      checkpoint_count: lt.cp_eligible_count,
    };

    await routeV2Alert('POSITION_OPEN', 'FIRED', null, false);
    log(`${matchup}: ★ POSITION OPEN — ${bwcTeam} ${poRank}-Rank @ ${nextCp.label} | MF=${lt.cp_mean_floor?.toFixed(3)} minF=${lt.cp_min_floor?.toFixed(2)} lane=${lt.lane}`);
  } else if (poBlockReason) {
    log(`${matchup}: ⏳ PO blocked — ${gRank}-Rank but ${poBlockReason}`);
  }
}
```

### 8.3 Firing rules summary

| Lane | A-Rank Gate | B-Rank Gate | C-Rank |
|------|------------|------------|--------|
| Underdog (+101+) | MF≥0.70 + minF≥0.60 | MF≥0.70 + minF≥0.60 + Q3_6+ | No PO |
| Toss-up (-100 to +100) | MF≥0.75 + minF≥0.65 | MF≥0.75 + minF≥0.65 + Q3_6+ | No PO |
| Favorite (-101 to -250) | MF≥0.75 + minF≥0.65 | MF≥0.75 + minF≥0.65 + Q3_6+ | No PO |
| Heavy Fav (-251+) | MF≥0.80 + minF≥0.65 | MF≥0.80 + minF≥0.65 + Q3_6+ | No PO |

All lanes also require: only_one_grad (opponent NOT graduated B+), alertMinsLeft >= 1.0.

---

## 9. BUY Confidence Enrichment

### 9.1 Confidence tier classification

Add function near checkpoint constants:

```javascript
function classifyBuyConfidence(lt) {
  if (!lt.bwc_fired) return 'COLD';
  const grad = lt.cp_graduation;
  const mf = lt.cp_mean_floor;
  
  if (grad && (grad.rank === 'A' || grad.rank === 'B') && mf >= 0.75) return 'GRADUATED';
  if (grad && (grad.rank === 'A' || grad.rank === 'B')) return 'GRADUATED_WEAK';
  if (lt.checkpoints && lt.checkpoints.length >= 2) return 'TRACKED';
  return 'COLD';
}
```

### 9.2 Add to v2Ctx

In the `v2Ctx` construction block (~line 4861), add:

```javascript
// Checkpoint graduation context
cpMeanFloor: lt.cp_mean_floor || null,
cpMinFloor: lt.cp_min_floor || null,
cpEligibleCount: lt.cp_eligible_count || 0,
cpPeakRank: lt.cp_peak_rank || null,
cpGraduation: lt.cp_graduation || null,
cpOppGraduation: lt.cp_opp_graduation || null,
lane: lt.lane || null,
pregameML: lt.pregame_ml || null,
buyConfidence: classifyBuyConfidence(lt),
```

### 9.3 Agent prompt updates

In `buildV2AgentPrompt` (~line 158), replace the existing Graduation line (~line 239) with:

```
Checkpoint graduation: ${ctx.cpGraduation 
  ? ctx.cpPeakRank + '-Rank (graduated @ ' + ctx.cpGraduation.cp_label + ', MF=' + (ctx.cpMeanFloor?.toFixed(3) || '?') + ', minF=' + (ctx.cpMinFloor?.toFixed(2) || '?') + ', ' + ctx.cpEligibleCount + ' eligible CPs)'
    + (ctx.cpOppGraduation ? ' ⚠ OPPONENT ALSO GRADUATED ' + ctx.cpOppGraduation.rank + '-Rank' : '')
  : 'Pre-graduation (' + (ctx.cpEligibleCount || 0) + ' eligible CPs, MF=' + (ctx.cpMeanFloor?.toFixed(3) || '?') + ')'
} | Lane: ${ctx.lane || 'unknown'} (pregame ML ${ctx.pregameML || '?'}) | Control flips: ${ctx.ctrlFlips}
```

Add after the existing BUY + GRADUATION CONFIDENCE LAYER section (~line 262):

```
  BUY CONFIDENCE TIERS (checkpoint-based):
  • GRADUATED (MF≥0.75): Team graduated B+ with sustained structural proof. Trail 1-4 = high confidence — structural thesis proven, trailing is likely variance.
  • GRADUATED_WEAK (MF<0.75): Team graduated but mean floor is marginal. Structural badge earned but quality is suspect. Apply standard scrutiny.
  • TRACKED: System identified structural interest (BWC fired, checkpoints accumulating) but team hasn't graduated. Evaluate floor trajectory — is MF building or declining?
  • COLD: No BWC context. Rely entirely on standard BUY evidence (floor, conviction, TP, sustainability).
  
  UNDERDOG CONTEXT: When lane is 'underdog', graduation carries extra weight — an underdog sustaining structural control against a favorite is inherently significant. The market hasn't priced this in.
  
  Current BUY confidence: ${ctx.buyConfidence}
```

### 9.4 Update POSITION_OPEN prompt section

Replace the existing PO prompt section (~line 250) to include lane context:

```
- POSITION_OPEN: The team has GRADUATED through the checkpoint system — sustained structural rank confirmed across multiple 3-minute evaluation windows.
  ${ctx.poRank === 'S' ? 'S-Rank (98%+): Wire-to-wire structural dominance. ALWAYS SEND.' 
  : ctx.poRank === 'A' ? 'A-Rank: Sustained DOMINANT conviction with lead 8+. Mean floor ' + (ctx.cpMeanFloor?.toFixed(3) || '?') + ' across ' + ctx.cpEligibleCount + ' checkpoints.'
  : ctx.poRank === 'B' ? 'B-Rank: Sustained DOMINANT/STRONG conviction with lead 3+. Mean floor ' + (ctx.cpMeanFloor?.toFixed(3) || '?') + ' across ' + ctx.cpEligibleCount + ' checkpoints.'
  : ''}
  Lane: ${ctx.lane || 'unknown'}. ${ctx.lane === 'underdog' ? 'UNDERDOG graduation — market has not priced structural control. Edge is structural floor vs implied probability. ALWAYS SEND.' : ctx.lane === 'heavy_favorite' ? 'Heavy favorite — PO confirms structural read but line may offer limited edge. Frame as position confirmation, not direct entry.' : 'Evaluate edge: floor vs current ML implied probability.'}
  This IS a position recommendation.
```

---

## 10. ntfy Title Format

In `routeV2Alert` (~line 4816), update POSITION_OPEN title:

```javascript
if (v2Type === 'POSITION_OPEN') {
  const rankStr = lt.po_fired?.rank ? ` (${lt.po_fired.rank})` : '';
  const laneStr = lt.lane === 'underdog' ? ' 🐶' : lt.lane === 'heavy_favorite' ? ' 🏠' : '';
  ntfyTitle = `POSITION OPEN${rankStr}${laneStr} — ${bwcTeam || ind.controlTeam}${mlStr}`;
}
```

Example outputs:
- `POSITION OPEN (A) 🐶 — MEM ML +180`
- `POSITION OPEN (B) — PHI ML -140`
- `POSITION OPEN (S) — OKC ML -280`

---

## 11. What Does NOT Change

| Component | Status | Why |
|-----------|--------|-----|
| BWC fire (3 consecutive 60s holds, period ≥ 2, floor ≥ 0.60, margin ≥ 2) | **No change** | TRACKING fires here. Checkpoint scaffold starts after BWC fire. |
| TRACKING alert | **No change** | Still fires at BWC establishment. Subscriber gets early signal. |
| `updateLiveTracking()` (holds, peaks, flips) | **No change** | 60s-level tracking continues for state machine, erosion, flips. |
| `computeBwcState()` / `computeErosion()` / `computeExitSeverity()` | **No change** | State machine runs independently of graduation. |
| State transition alerts (HOLDING, EDGE, VALUE, EXIT, SAFE, etc.) | **No change** | Still gated on `lt.po_fired`. Silent pre-graduation, active after PO. |
| BUY alert mechanical gates (floor ≥ 0.55, trailing, margin 1-15, ML gate) | **No change** | BUY path is independent. Only enriched with graduation context. |
| Transition alerts (RECOVERY PATH, LEAD CRUMBLING, etc.) | **No change** | Operate outside BWC state machine. |
| `routeV2Alert()` (except ntfy title tweak) | **No change** | Same agent routing, DB INSERT, ntfy path. |
| Auto-analysis / calibration snapshot system | **No change** | Quarter boundary triggers unchanged. |
| Snapshot writes / DB schema | **No change** | `live_tracking` is JSONB — new fields added dynamically. |
| `classifyRank()` function signature | **No change** | Same function, but now called with checkpoint-level holds instead of 60s holds. |
| Alerts table schema | **No change** | No new columns. Checkpoint context is in the agent prompt. |

---

## 12. Dead Code to Remove

| Code | Location | Reason |
|------|----------|--------|
| Entire `// ── V2 GRADUATION DETECTION` block | Lines ~4981-5044 | Replaced by checkpoint-based graduation in §5-8 |
| Entire `// ── Opponent graduation tracking` block | Lines ~5046-5074 | Replaced by checkpoint-level opponent tracking in §5.2 |
| `lt.rank_current` assignment | Line ~4994 | Replaced by `lt.cp_peak_rank` |
| `lt.opp_bwc_holds` usage in old opponent tracking | Lines ~5050-5070 | Replaced by `lt.cp_opp_holds` |

**KEEP** (not dead code):
- `lt.graduation` map — still used by v2Ctx for backward compatibility. The new `lt.cp_graduation` is the checkpoint-based version. Both can coexist during transition.
- `lt.po_fired` — still the gate for state transition alerts. Now set by checkpoint PO logic instead of watermark PO logic.

---

## 13. Validation Data Reference

### Full season (1,230 games, 14 checkpoints):

| Metric | Value | Section |
|--------|-------|---------|
| C→A graduation | 92.3% (n=842) | §2 |
| C→B graduation | 75.6% (n=283) | §2 |
| A + MF≥0.80 | 81.0% (n=468) | §19 |
| A + MF≥0.85 | 87.7% (n=260) | §19 |
| MF≥0.80 + only_one_grad | 84.7% (n=457) | §21 |
| MF≥0.80 + minF≥0.65 | 87.7% (n=334) | §24 |
| MF≥0.80 + minF≥0.70 | 90.2% (n=235) | §24 |
| 6+ cp at peak tier | 90.6% (n=1016) | §3 |
| Wire-to-wire | 99.7% (n=362) | §6 |

### Competitive games (774 games, within 5 in Q3 or 7 in Q4):

| Metric | Value | Section |
|--------|-------|---------|
| C→A graduation | 86.3% (n=424) | §2 |
| MF≥0.80 + only_one_grad | 75.0% (n=156) | §21 |
| MF≥0.80 + minF≥0.65 | 76.1% (n=109) | §24 |
| 6+ cp at peak tier | 84.7% (n=569) | §3 |
| Wire-to-wire | 98.8% (n=84) | §6 |
| Only_one_grad @ MF≥0.70 | 62.9% (n=420) | §21 |
| Only_one_grad @ MF≥0.80 | 75.0% (n=156) | §21 |
| Both_grad @ MF≥0.80 | 14.3% (n=21) | §21 |

### Rolling mean floor divergence (competitive, §23):

| Checkpoint | Winners | Losers | Gap |
|-----------|---------|--------|-----|
| Q1_END | 0.713 | 0.705 | 0.008 |
| Q2_END | 0.728 | 0.717 | 0.011 |
| Q3_6 | 0.735 | 0.723 | 0.012 |
| Q4_END | 0.750 | 0.731 | 0.019 |

---

## 14. Implementation Order

1. Add constants: `GRAD_CHECKPOINTS`, `LANE_THRESHOLDS` (~line 1328)
2. Add helper functions: `computeCheckpointFloorStats`, `classifyBuyConfidence`, `getLaneGates` (~line 1400)
3. Add pregame ML capture logic (after odds fetch, ~line 4616)
4. Add checkpoint capture block (§5.2, before existing graduation detection, ~line 4980)
5. Remove old graduation detection + opponent tracking blocks (lines ~4981-5074)
6. Add PO evaluation to checkpoint capture block (§8.2)
7. Update v2Ctx with new checkpoint fields (§9.2, ~line 4861)
8. Update `buildV2AgentPrompt` graduation line + BUY confidence section (§9.3-9.4, ~line 239/250/262)
9. Update ntfy title for POSITION_OPEN (§10, in routeV2Alert)
10. `node -c netlify/functions/poll-live-bdl.mjs` — syntax check
11. Commit + push + Netlify deploy
12. Verify with live game: checkpoint capture logs, lane classification, PO gate evaluation

---

## 15. Testing Checklist

### Pre-deploy
- [ ] `node -c` passes
- [ ] `grep -n "GRAD_CHECKPOINTS\|cp_holds\|cp_mean_floor\|cp_graduation\|classifyBuyConfidence"` confirms all new fields are used
- [ ] No references to removed `lt.rank_current`, old `lt.opp_bwc_holds` in graduation context

### Live validation (first slate)
- [ ] Server logs show `📍 CP Q1_END captured` at correct game times
- [ ] Server logs show `🏷 Lane: underdog/tossup/favorite` at BWC fire
- [ ] For a dominant team: checkpoints accumulate, graduation fires, PO fires with MF/minF in log
- [ ] For a contested game: PO blocked with reason logged (`MF 0.68 < 0.75`)
- [ ] For both-graduated: PO suppressed with `✗ PO SUPPRESSED — both graduated` in log
- [ ] TRACKING still fires at BWC establishment (unchanged)
- [ ] State transition alerts still gated on `lt.po_fired`
- [ ] BUY alerts fire independently with `buyConfidence` in agent reasoning

### Regression
- [ ] BUY mechanical gates unchanged (floor/margin/trailing/ML)
- [ ] Auto-analysis still fires at quarter boundaries
- [ ] Snapshot writes include all existing fields
- [ ] ntfy alerts readable on mobile (plain English, action-first)

# Checkpoint-Based Graduation System — Implementation Spec

**Date:** April 20, 2026 (v2 — rewritten with production validation)  
**Status:** APPROVED — ready to build  
**File affected:** `netlify/functions/poll-live-bdl.mjs` (sole file)  
**Depends on:** V2 BWC Alert Engine Steps 1-6 (deployed), existing graduation code (deployed)  
**Replaces:** Current 60s-poll watermark graduation (lines ~4981-5075)

---

## 1. Problem Statement

The current graduation system fires POSITION OPEN on a single 60s snapshot meeting rank criteria. No mean floor averaging, no checkpoint cadence, no confirmation requirement. A team's cumulative floor can spike to 0.95 from stale Q1 dominance while their recent play is 0.48.

**Backtest evidence (1,230 games, 3-min checkpoints):**
- Mean floor ≥ 0.80 + min floor ≥ 0.65 = 87.7% (n=334)
- Only one team graduated + MF≥0.80 = 84.7% (n=457)
- 6+ checkpoints at peak tier = 90.6% full / 84.7% competitive (n=1016/569)
- Wire-to-wire = 99.7% full / 98.8% competitive (n=362/84)
- 60s resolution produces 2.94 tier bounces per game — too noisy for classification

**Production validation (23 games, Apr 6–19, server snapshots):**
- Checkpoint PO accuracy: 9/11 (82%) — S 2/2, A 4/5, B 3/4
- BUY SENT accuracy over same games: 9/23 (39%) — PO is fundamentally different quality
- Gates correctly blocked 1 bad call (GSW@DEN, lost by 23)
- Gates incorrectly blocked 6 correct calls — all from MF/minF thresholds calibrated to backtest floor distributions that don't match production
- MIN@DEN: checkpoint system correctly never graduated MIN (peak C) while BUY path fired 6 SENT alerts, 5 wrong — validates graduation context for BUY enrichment
- GSW@SAC: PO A-rank + 7 BUY/BWC alerts, all correct — system alignment at its best

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
    compute running mean floor + min floor + MF trajectory direction →
    evaluate graduation from checkpoint-level holds →
    apply lane-specific MF gates →
    fire PO if all gates pass
```

The 60s poll loop, indicator computation, BWC fire, state machine, BUY path, and transition alerts are UNCHANGED. The checkpoint scaffold is a purely additive layer between the existing `computeServer()` output and the graduation detection block.

**Design principles confirmed by production testing:**
- Rank watermark holds (no downgrades). MF is the dynamic quality layer — if MF declines, PO gates prevent firing even though rank badge is earned.
- Exit logic completely untouched — `computeBwcState`/`computeErosion`/`computeExitSeverity` run independently, don't reference graduation.
- Agent gets trajectory data (RISING/FLAT/DECLINING), not pre-computed confidence labels. This is consistent with how the structural stress section works — Opus reasons from raw dimensions, not lossy compression.

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

ML boundaries calibrated to actual implied probability bands. A -105 and -135 line are both coin flips — they belong in toss-up, not favorite. minF lowered to 0.58 across all lanes: production floor computation produces lower values than backtest, and the original 0.65 gate was catching early-checkpoint noise on correct calls (DET@ORL: one checkpoint at 0.60 while leading by 14 permanently blocked a team that won by 16).

**⚠ OPEN DECISION: heavy_favorite MF gate.** Production showed 0/5 heavy favorite BWC games produced a PO, but all 5 BWC teams won. The 0.80 gate is unreachable — floor computation structurally compresses for heavy favorites (SAC@POR: leading 10-20 all game, MF peaked at 0.783). Recommendation: drop to 0.75 to match toss-up. Heavy favorites winning is expected — the edge value is lower — but blanket suppression of a 100% correct lane is worse. See §13 for full data.

```javascript
const LANE_THRESHOLDS = {
  underdog:       { mfGate: 0.70, minFGate: 0.58 },  // pregame ML > +100 (<50% implied)
  tossup:         { mfGate: 0.75, minFGate: 0.58 },  // pregame ML +100 to -150 (50-60% implied)
  favorite:       { mfGate: 0.72, minFGate: 0.58 },  // pregame ML -151 to -300 (60-75% implied)
  heavy_favorite: { mfGate: 0.75, minFGate: 0.58 },  // pregame ML -301 or worse (75%+ implied)
};
```

---

## 4. New `lt` (live_tracking) Fields

All stored in the existing `live_tracking` JSONB column on `games` table. No schema migration needed.

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `lt.checkpoints` | `Array<{label, floor, team, margin, conv, oppCount, period, clock}>` | `[]` | Captured checkpoint readings |
| `lt.next_cp_idx` | `integer` | `0` | Index into GRAD_CHECKPOINTS for next expected checkpoint |
| `lt.cp_holds` | `integer` | `0` | Consecutive checkpoints where BWC team has control |
| `lt.cp_peak_rank` | `string` | `'C'` | Watermark rank from checkpoint evaluations |
| `lt.cp_graduation` | `{rank, cp_label, floor, margin, period, clock}` | `null` | When/where graduation happened |
| `lt.cp_opp_holds` | `integer` | `0` | Consecutive checkpoints where opponent has control |
| `lt.cp_opp_graduation` | `{rank, cp_label, floor, margin}` | `null` | Opponent graduation (for only_one_grad) |
| `lt.cp_mean_floor` | `number` | `null` | Running mean of eligible checkpoint floors |
| `lt.cp_min_floor` | `number` | `null` | Running min of eligible checkpoint floors |
| `lt.cp_eligible_count` | `integer` | `0` | Count of eligible checkpoints |
| `lt.pregame_ml` | `integer` | `null` | BWC team's pregame ML (captured at first odds reading) |
| `lt.lane` | `string` | `null` | 'underdog' / 'tossup' / 'favorite' / 'heavy_favorite' |

Existing `lt` fields that STAY unchanged:
- `lt.bwc_fired` — still fires at 3 consecutive 60s holds (BWC establishment)
- `lt.po_fired` — set when PO fires (gates downstream state transition alerts)
- `lt.graduation` — per-team graduation map (backward compat, coexists with `lt.cp_graduation`)
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
      if (cpMargin >= 2 && ind.score >= 0.60) {
        lt.cp_opp_holds = (lt.cp_opp_holds || 0) + 1;
      } else {
        lt.cp_opp_holds = 0;
      }
    }

    // ── Classify rank at this checkpoint (BWC team only) ──
    if (ind.controlTeam === bwcTeam && cpMargin >= 2 && ind.score >= 0.60) {
      const cpRank = classifyRank(cpConv.tier, cpMargin, lt.cp_holds, cpOppCount);

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
      const oppRank = classifyRank(cpConv.tier, cpMargin, lt.cp_opp_holds, cpOppCount);
      
      if (oppRank === 'B' || oppRank === 'A') {
        const prevOppRank = lt.cp_opp_graduation?.rank || 'C';
        const CP_RANK_ORDER = { C: 0, B: 1, A: 2 };
        if (CP_RANK_ORDER[oppRank] > (CP_RANK_ORDER[prevOppRank] || 0)) {
          lt.cp_opp_graduation = {
            rank: oppRank, cp_label: nextCp.label,
            floor: ind.score, margin: cpMargin,
          };
          log(`${matchup}: ⚠ CP OPP GRADUATION ${ind.controlTeam} → ${oppRank}-Rank @ ${nextCp.label}`);
        }
      }
    }

    // ── Compute running mean floor / min floor ──
    const cpFloorStats = computeCheckpointFloorStats(lt.checkpoints, bwcTeam);
    lt.cp_mean_floor = cpFloorStats.meanFloor;
    lt.cp_min_floor = cpFloorStats.minFloor;
    lt.cp_eligible_count = cpFloorStats.eligibleCount;

    // ── POSITION OPEN EVALUATION (§8) ──
    // [PO evaluation code inserted here — see §8.2]

    lt.next_cp_idx++;
    log(`${matchup}: 📍 CP ${nextCp.label} captured — team=${cpEntry.team} floor=${cpEntry.floor.toFixed(2)} margin=${cpEntry.margin} conv=${cpEntry.conv} holds=${lt.cp_holds} MF=${lt.cp_mean_floor?.toFixed(3) || '?'}`);
  }
}
```

### 5.3 oppCount computation note

When computing opponent rank at a checkpoint, `cpOppCount` comes from `computeConviction(ind).indicatorsLost` — which is control-team-relative. When the opponent IS the control team, their `indicatorsLost` are the BWC team's won indicators. This is correct: from the opponent's perspective, the BWC team's indicators are opposition. Verify during implementation that `classifyRank` receives the right oppCount value.

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

### 6.2 MF Trajectory Classification

The MF trajectory tells the agent whether the structural thesis is building, holding, or fading. This replaces the old GRADUATED/GRADUATED_WEAK/TRACKED/COLD label system — labels are lossy compression that prevent Opus from recovering the raw signal. Trajectory direction + raw MF array gives Opus the dimensions to reason from, consistent with how the structural stress section already works.

```javascript
function computeMFTrajectory(checkpoints, bwcTeam) {
  const eligible = checkpoints.filter(cp => 
    cp.team === bwcTeam && cp.floor >= 0.60 && cp.margin >= 2
  );
  if (eligible.length < 2) return { direction: 'INSUFFICIENT', floors: eligible.map(cp => cp.floor) };

  // Compare first half of eligible CPs to second half
  const mid = Math.floor(eligible.length / 2);
  const firstHalf = eligible.slice(0, mid);
  const secondHalf = eligible.slice(mid);
  const firstAvg = firstHalf.reduce((s, cp) => s + cp.floor, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((s, cp) => s + cp.floor, 0) / secondHalf.length;
  const delta = secondAvg - firstAvg;

  let direction;
  if (delta > 0.04) direction = 'RISING';
  else if (delta < -0.04) direction = 'DECLINING';
  else direction = 'FLAT';

  return {
    direction,
    delta: Math.round(delta * 1000) / 1000,
    floors: eligible.map(cp => cp.floor),
    firstAvg: Math.round(firstAvg * 1000) / 1000,
    secondAvg: Math.round(secondAvg * 1000) / 1000,
  };
}
```

**Production examples:**
- GSW@SAC (✅): eligible floors [0.68, 0.68, 0.86, 0.74] → firstAvg 0.68, secondAvg 0.80, delta +0.12 → RISING
- GSW@LAC 4/15 (❌): eligible floors [0.75, 0.80, 0.70, 0.88] → firstAvg 0.775, secondAvg 0.79, delta +0.015 → FLAT
- MIN@DEN (❌ BWC): floor collapsed 0.78 → 0.51 → never eligible again after Q1 — trajectory not computable, which is itself diagnostic

---

## 7. Lane Classification (Pregame Odds)

### 7.1 Capture pregame ML

On FIRST odds reading after BWC fires (when `lt.pregame_ml` is null), capture the BWC team's ML:

```javascript
// Inside the poll loop, after odds fetch AND after BWC fire detection
if (lt.bwc_fired && lt.pregame_ml == null && odds) {
  const bwcIsHome = lt.bwc_fired.team === hA;
  lt.pregame_ml = bwcIsHome ? odds.homeML : odds.awayML;
  
  const ml = lt.pregame_ml;
  if (ml == null) lt.lane = 'tossup';
  else if (ml > 100) lt.lane = 'underdog';
  else if (ml >= -150) lt.lane = 'tossup';
  else if (ml >= -300) lt.lane = 'favorite';
  else lt.lane = 'heavy_favorite';
  
  log(`${matchup}: 🏷 Lane: ${lt.lane} (pregame ML ${ml > 0 ? '+' : ''}${ml})`);
}
```

**Location:** After odds fetch (~line 4616) and after BWC fire detection (~line 4740). Must be AFTER `lt.bwc_fired` is set so we know which team's ML to capture.

**Note:** This captures the FIRST odds reading after BWC fires, not necessarily pregame. For most games, BWC fires early Q2 and the line hasn't moved much. If BDL returns stale pregame odds (common for first few polls), this is effectively pregame ML.

### 7.2 Lane lookup helper

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

### 8.2 PO evaluation (inside §5.2 checkpoint capture, after MF computation)

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

  // C-Rank: never fires PO
  if (gRank === 'C') {
    poBlockReason = 'C-Rank — no PO';
  }

  // only_one_grad check
  if (poShouldFire) {
    if (lt.cp_opp_graduation && (lt.cp_opp_graduation.rank === 'B' || lt.cp_opp_graduation.rank === 'A')) {
      poShouldFire = false;
      poBlockReason = `opponent also graduated (${lt.cp_opp_graduation.rank}-Rank @ ${lt.cp_opp_graduation.cp_label})`;
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

| Lane | ML Range | A-Rank Gate | B-Rank Gate | C-Rank |
|------|----------|------------|------------|--------|
| Underdog | +101+ | MF≥0.70 + minF≥0.58 | MF≥0.70 + minF≥0.58 + Q3_6+ | No PO |
| Toss-up | +100 to -150 | MF≥0.75 + minF≥0.58 | MF≥0.75 + minF≥0.58 + Q3_6+ | No PO |
| Favorite | -151 to -300 | MF≥0.72 + minF≥0.58 | MF≥0.72 + minF≥0.58 + Q3_6+ | No PO |
| Heavy Fav | -301+ | MF≥0.75 + minF≥0.58 | MF≥0.75 + minF≥0.58 + Q3_6+ | No PO |

All lanes also require: `only_one_grad` (opponent NOT graduated B+), `alertMinsLeft >= 1.0`.

**Production data behind these gates:**

| Gate | Original | Updated | Why |
|------|----------|---------|-----|
| minF all lanes | 0.60-0.65 | **0.58** | DET@ORL: single CP at 0.60 while leading by 14 permanently blocked a ✅ PO. Floor computation noise, not structural signal. |
| Favorite MF | 0.75 | **0.72** | Slightly above underdog (0.70). Production favorites cluster MF 0.72-0.78. |
| Heavy fav MF | 0.80 | **0.75** | 0.80 unreachable in production — 5/5 heavy fav BWC teams won, 0 POs fired. Floor computation compresses for dominant favorites (SAC@POR: leading 10-20 all game, MF peaked 0.783). |
| Toss-up ML boundary | ±100 | **+100 to -150** | A -105/-135 line is a coin flip (52-57% implied), not a favorite. |
| Favorite ML boundary | -101 to -250 | **-151 to -300** | Matches actual market perception of "clear favorite." |

---

## 9. Agent Context: MF Trajectory (replaces BUY confidence tiers)

### 9.1 Design rationale

The original spec defined four BUY confidence labels: GRADUATED / GRADUATED_WEAK / TRACKED / COLD. Production testing exposed the problem — SAC at +380 with DOMINANT conviction and MF rising 0.68→0.74 would get labeled "GRADUATED_WEAK" because MF < 0.75. Opus sees "weak" and over-discounts a signal that's getting stronger.

Labels are lossy compression. The structural stress section already proves the better pattern: give Opus the raw dimensions (combined read, rolling window, per-quarter breakdown) and let it reason from there. The MF trajectory follows the same principle — direction + raw checkpoint floors + lane context gives Opus everything it needs without pre-solving edge cases in code.

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
mfTrajectory: lt.bwc_fired ? computeMFTrajectory(lt.checkpoints || [], lt.bwc_fired.team) : null,
```

### 9.3 Agent prompt: graduation context line

In `buildV2AgentPrompt` (~line 239), replace the existing Graduation line with:

```javascript
const mfTraj = ctx.mfTrajectory;
const mfTrajStr = mfTraj
  ? `MF ${mfTraj.direction} (${mfTraj.floors.map(f => f.toFixed(2)).join(' → ')})${mfTraj.direction !== 'INSUFFICIENT' ? ' Δ=' + (mfTraj.delta > 0 ? '+' : '') + mfTraj.delta.toFixed(3) : ''}`
  : 'No trajectory data';
```

Then in the POSITION HEALTH section:

```
${ctx.cpGraduation 
  ? 'Graduation: ' + ctx.cpPeakRank + '-Rank (graduated @ ' + ctx.cpGraduation.cp_label + ', floor was ' + Number(ctx.cpGraduation.floor).toFixed(2) + ') | ' + mfTrajStr + ' | MF=' + (ctx.cpMeanFloor?.toFixed(3) || '?') + ' minF=' + (ctx.cpMinFloor?.toFixed(2) || '?') + ' (' + ctx.cpEligibleCount + ' eligible CPs)'
    + (ctx.cpOppGraduation ? ' ⚠ OPPONENT ALSO GRADUATED ' + ctx.cpOppGraduation.rank + '-Rank @ ' + ctx.cpOppGraduation.cp_label : '')
  : 'Pre-graduation (' + (ctx.cpEligibleCount || 0) + ' eligible CPs, MF=' + (ctx.cpMeanFloor?.toFixed(3) || '?') + ' ' + mfTrajStr + ')'
} | Lane: ${ctx.lane || 'unknown'} (pregame ML ${ctx.pregameML || '?'}) | Control flips: ${ctx.ctrlFlips}
```

### 9.4 Agent prompt: POSITION_OPEN rule

Replace the existing PO prompt section (~line 250):

```
- POSITION_OPEN: The team has GRADUATED through the checkpoint system — sustained structural rank confirmed across multiple 3-minute evaluation windows.
  ${ctx.poRank === 'S' ? 'S-Rank (98%+): Wire-to-wire structural dominance. ALWAYS SEND.' 
  : ctx.poRank === 'A' ? 'A-Rank: Sustained DOMINANT conviction with lead 8+. ' + mfTrajStr + ' across ' + ctx.cpEligibleCount + ' checkpoints.'
  : ctx.poRank === 'B' ? 'B-Rank: Sustained DOMINANT/STRONG conviction with lead 3+. ' + mfTrajStr + ' across ' + ctx.cpEligibleCount + ' checkpoints.'
  : ''}
  Lane: ${ctx.lane || 'unknown'}. ${ctx.lane === 'underdog' ? 'UNDERDOG graduation — market has not priced structural control. Edge is structural floor vs implied probability. ALWAYS SEND.' : ctx.lane === 'heavy_favorite' ? 'Heavy favorite — PO confirms structural read but line may offer limited edge. Frame as position confirmation, not direct entry.' : 'Evaluate edge: floor vs current ML implied probability.'}
  This IS a position recommendation.
```

### 9.5 Agent prompt: BUY + graduation trajectory section

Replace the existing GRADUATION CONFIDENCE LAYER section (~line 262):

```
  CHECKPOINT GRADUATION CONTEXT (additional data for BUY evaluation — does not override BUY evidence above):
  ${ctx.cpGraduation
    ? 'Team GRADUATED ' + ctx.cpPeakRank + '-Rank @ ' + ctx.cpGraduation.cp_label + '. ' + mfTrajStr
    : ctx.cpEligibleCount > 0
      ? 'Pre-graduation: ' + ctx.cpEligibleCount + ' eligible checkpoints. ' + mfTrajStr
      : 'No checkpoint data — cold BUY with no BWC context.'
  }
  
  HOW TO USE MF TRAJECTORY ON BUY DECISIONS:
  • RISING = structural thesis is building, not fading. Trailing is more likely variance. Increases BUY confidence.
  • FLAT = structural edge is real but not separating. Apply standard BUY scrutiny from evidence above.
  • DECLINING = the game may have shifted since graduation. The rank badge is stale. Extra skepticism — check if indicators that powered graduation are still held.
  • INSUFFICIENT = fewer than 2 eligible checkpoints. Rely on standard BUY evidence.
  
  LANE AMPLIFIERS:
  • Underdog + RISING MF = highest confidence — market hasn't priced sustained structural control, and it's getting stronger.
  • Heavy favorite + DECLINING MF = lowest confidence — expected dominance is fading, position may be compromised.
  
  DEFICIT DEPTH + GRADUATION: trail 5-9 with graduation = structural thesis may be wrong, apply extra scrutiny regardless of trajectory. Trail 10+ with graduation = near-automatic SUPPRESS (the structural read was incorrect regardless of rank).
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
- `POSITION OPEN (A) 🏠 — BOS ML -350`

---

## 11. What Does NOT Change

| Component | Status | Why |
|-----------|--------|-----|
| BWC fire (3 consecutive 60s holds, period ≥ 2, floor ≥ 0.60, margin ≥ 2) | **No change** | TRACKING fires here. Checkpoint scaffold starts after BWC fire. |
| TRACKING alert | **No change** | Still fires at BWC establishment. Subscriber gets early signal. |
| `updateLiveTracking()` (holds, peaks, flips) | **No change** | 60s-level tracking continues for state machine, erosion, flips. |
| `computeBwcState()` / `computeErosion()` / `computeExitSeverity()` | **No change** | State machine runs independently of graduation. |
| State transition alerts (HOLDING, EDGE, VALUE, EXIT, SAFE, etc.) | **No change** | Still gated on `lt.po_fired`. Silent pre-graduation, active after PO. |
| BUY alert mechanical gates (floor ≥ 0.55, trailing, margin 1-15, ML gate) | **No change** | BUY path is independent. Only enriched with graduation trajectory context. |
| Transition alerts (RECOVERY PATH, LEAD CRUMBLING, etc.) | **No change** | Operate outside BWC state machine. |
| `routeV2Alert()` (except ntfy title tweak) | **No change** | Same agent routing, DB INSERT, ntfy path. |
| Auto-analysis / calibration snapshot system | **No change** | Quarter boundary triggers unchanged. |
| Snapshot writes / DB schema | **No change** | `live_tracking` is JSONB — new fields added dynamically. |
| `classifyRank()` function signature | **No change** | Same function, but now called with checkpoint-level holds instead of 60s holds. |
| Alerts table schema | **No change** | No new columns. Checkpoint + trajectory context lives in agent prompt. |

---

## 12. Dead Code to Remove

| Code | Location | Reason |
|------|----------|--------|
| Entire `// ── V2 GRADUATION DETECTION` block | Lines ~4981-5044 | Replaced by checkpoint-based graduation in §5-8 |
| Entire `// ── Opponent graduation tracking` block | Lines ~5046-5074 | Replaced by checkpoint-level opponent tracking in §5.2 |
| `lt.rank_current` assignment | Line ~4994 | Replaced by `lt.cp_peak_rank` |
| `lt.opp_bwc_holds` usage in old opponent tracking | Lines ~5050-5070 | Replaced by `lt.cp_opp_holds` |

**KEEP** (not dead code):
- `lt.graduation` map — still used by v2Ctx for backward compatibility. The new `lt.cp_graduation` is the checkpoint-based version. Both coexist during transition.
- `lt.po_fired` — still the gate for state transition alerts. Now set by checkpoint PO logic instead of watermark PO logic.

---

## 13. Validation Data

### Full season backtest (1,230 games, 14 checkpoints):

| Metric | Value |
|--------|-------|
| C→A graduation | 92.3% (n=842) |
| C→B graduation | 75.6% (n=283) |
| A + MF≥0.80 | 81.0% (n=468) |
| A + MF≥0.85 | 87.7% (n=260) |
| MF≥0.80 + only_one_grad | 84.7% (n=457) |
| MF≥0.80 + minF≥0.65 | 87.7% (n=334) |
| MF≥0.80 + minF≥0.70 | 90.2% (n=235) |
| 6+ cp at peak tier | 90.6% (n=1016) |
| Wire-to-wire | 99.7% (n=362) |

### Competitive backtest (774 games, within 5 in Q3 or 7 in Q4):

| Metric | Value |
|--------|-------|
| C→A graduation | 86.3% (n=424) |
| MF≥0.80 + only_one_grad | 75.0% (n=156) |
| MF≥0.80 + minF≥0.65 | 76.1% (n=109) |
| 6+ cp at peak tier | 84.7% (n=569) |
| Wire-to-wire | 98.8% (n=84) |

### Production test (23 games, Apr 6-19, minF 0.58, fav MF 0.72):

**PO Results: 9/11 correct (82%)**

| Game | Rank | Lane | MF | Result | Correct |
|------|------|------|----|--------|---------|
| CHA@ORL 4/17 | S | underdog +124 | 0.803 | ORL +31 | ✅ |
| ORL@DET 4/19 | S | underdog +315 | 0.723 | ORL +11 | ✅ |
| LAC@POR 4/10 | A | tossup -122 | 0.807 | POR +19 | ✅ |
| GSW@SAC 4/10 | A | underdog +380 | 0.740 | SAC +6 | ✅ |
| DET@ORL 4/06 | A | tossup -102 | 0.768 | ORL +16 | ✅ |
| GSW@LAC 4/12 | A | favorite -180 | 0.734 | LAC +5 | ✅ |
| GSW@LAC 4/15 | A | favorite -218 | 0.783 | GSW +5 | ❌ |
| POR@LAC 3/31 | B | underdog +164 | 0.737 | POR +10 | ✅ |
| DET@CHA 4/10 | B | underdog +180 | 0.830 | DET +18 | ✅ |
| MIN@DET 4/02 | B | favorite -205 | 0.767 | DET +5 | ✅ |
| MIA@CHA 4/14 | B | underdog +195 | 0.758 | CHA +1 | ❌ |

**Graduated but blocked by gates: 6 (5 correct, 1 saved)**

| Game | Rank | Lane | MF | Block Reason | Would-be |
|------|------|------|----|-------------|----------|
| SAC@POR 4/12 | B | heavy_fav -3000 | 0.753 | MF < 0.80* | ✅ |
| MIN@ORL 4/08 | A | heavy_fav -470 | 0.627 | MF < 0.80* | ✅ |
| SAC@GSW 4/07 | B | heavy_fav -1000 | 0.730 | MF < 0.80* | ✅ |
| LAC@SAC 4/05 | B | heavy_fav -900 | 0.671 | MF < 0.80* | ✅ |
| CHA@MIN 4/05 | B | favorite -162 | 0.716 | MF < 0.72 | ✅ |
| GSW@DEN 3/29 | B | underdog +470 | 0.672 | MF < 0.70 | ❌ saved |

*These games used the original 0.80 heavy_fav gate. With the updated 0.75 gate, SAC@POR (0.753) and SAC@GSW (0.730) would pass. MIN@ORL (0.627) and LAC@SAC (0.671) would still be blocked.

**By rank (PO-fired only):** S 2/2 (100%), A 4/5 (80%), B 3/4 (75%)

**By lane (BWC games, n=21):**

| Lane | Games | BWC Won | PO Fired | PO Correct |
|------|-------|---------|----------|------------|
| Underdog | 9 | 5/9 | 6 | 5/6 (83%) |
| Toss-up | 3 | 3/3 | 2 | 2/2 (100%) |
| Favorite | 4 | 3/4 | 3 | 2/3 (67%) |
| Heavy fav | 5 | 5/5 | 0 | N/A |

**BUY layer cross-reference (Apr 6+ only, 41 alerts):**
- BUY SENT accuracy: 39% (9/23) — PO at 82% is fundamentally different quality
- MIN@DEN: 13 alerts, 6 SENT, 5 wrong — checkpoint system correctly never graduated. MF trajectory would give agent "never graduated, no eligible CPs" → supports SUPPRESS
- GSW@SAC: PO A-rank ✅ + 7 alerts all correct ✅ — graduation confirmed thesis, BUY/BWC aligned
- No BUYs fired on any of the 6 PO-blocked games — neither path surfaced these positions

### Rolling mean floor divergence (competitive backtest, §23):

| Checkpoint | Winners | Losers | Gap |
|-----------|---------|--------|-----|
| Q1_END | 0.713 | 0.705 | 0.008 |
| Q2_END | 0.728 | 0.717 | 0.011 |
| Q3_6 | 0.735 | 0.723 | 0.012 |
| Q4_END | 0.750 | 0.731 | 0.019 |

---

## 14. Implementation Order

1. Add constants: `GRAD_CHECKPOINTS`, `LANE_THRESHOLDS` (~line 1328)
2. Add helper functions: `computeCheckpointFloorStats`, `computeMFTrajectory`, `getLaneGates` (~line 1400)
3. Add pregame ML capture logic (after odds fetch + BWC fire, ~line 4740)
4. Add checkpoint capture block (§5.2, before existing graduation detection, ~line 4980)
5. Remove old graduation detection + opponent tracking blocks (lines ~4981-5074)
6. Add PO evaluation inside checkpoint capture block (§8.2)
7. Update v2Ctx with new checkpoint fields + mfTrajectory (§9.2, ~line 4861)
8. Update `buildV2AgentPrompt` — graduation context line + PO rule + BUY trajectory section (§9.3-9.5)
9. Update ntfy title for POSITION_OPEN (§10, in routeV2Alert)
10. `node -c netlify/functions/poll-live-bdl.mjs` — syntax check
11. Commit + push + Netlify deploy
12. Verify with live game: checkpoint capture logs, lane classification, MF trajectory in agent reasoning

---

## 15. Testing Checklist

### Pre-deploy
- [ ] `node -c` passes
- [ ] `grep -n "GRAD_CHECKPOINTS\|cp_holds\|cp_mean_floor\|cp_graduation\|computeMFTrajectory\|mfTrajectory"` confirms all new fields are used
- [ ] No references to removed `lt.rank_current`, old `lt.opp_bwc_holds` in graduation context
- [ ] No references to `classifyBuyConfidence` or `buyConfidence` (replaced by trajectory)

### Live validation (first slate)
- [ ] Server logs show `📍 CP Q1_END captured` at correct game times
- [ ] Server logs show `🏷 Lane: underdog/tossup/favorite/heavy_favorite` at BWC fire
- [ ] For a dominant team: checkpoints accumulate, graduation fires, PO fires with MF/minF in log
- [ ] For a contested game: PO blocked with reason logged (`MF 0.68 < 0.75`)
- [ ] For both-graduated: PO suppressed with `✗ PO SUPPRESSED — both graduated` in log
- [ ] TRACKING still fires at BWC establishment (unchanged)
- [ ] State transition alerts still gated on `lt.po_fired`
- [ ] BUY agent reasoning references MF trajectory (RISING/FLAT/DECLINING), not confidence labels
- [ ] MF trajectory direction logged correctly (check agent_reasoning in alerts table)

### Regression
- [ ] BUY mechanical gates unchanged (floor/margin/trailing/ML)
- [ ] Auto-analysis still fires at quarter boundaries
- [ ] Snapshot writes include all existing fields
- [ ] ntfy alerts readable on mobile (plain English, action-first)

# Compound Establishment Spec

**Date:** May 7, 2026
**Status:** Proposed — awaiting Manny's confirmation
**Scope:** NBA only. NCAAMB retains floor-based BWC establishment.

## Problem

BWC establishment (TRACKING) fires on `floor ≥ 0.60 + margin ≥ 2 + 3 holds + Q2+ + XGB ≥ 0.40`. This is a weak, noisy signal (floor alone = 81% AUC, first fire = 51% coin flip). The compound system (MC ≥ 0.80 + Floor ≥ 0.65) then evaluates WITHIN this lifecycle for PO confirmation — but the lifecycle starts on a signal that's far weaker than what confirms it.

The graduation simplification spec assumed BWC establishment stays unchanged. It should have replaced it with compound-based establishment.

## Design

**Single gate:** First poll where compound threshold is met → `lt.bwc_fired` + TRACKING alert + first compound hold. Then 4 more consecutive holds → PO (5 total).

**Compound threshold (unchanged from current):**
- Base: MC Cum ≥ 0.80 AND Floor ≥ 0.65
- Q2 extra: margin ≥ 5 AND 0 prior ctrl flips
- Q3+: base threshold only

**Execution flow on establishment poll:**
1. `!lt.bwc_fired && league === 'nba' && Q2+` → check compound threshold
2. Threshold met → set `lt.bwc_fired`, `lt.compound_holds = 1`, stale guard fields, `_just_established = true`
3. Enter existing `if (lt.bwc_fired)` block → compound function sees stale guard (same period+clock) → no double-count
4. TRACKING alert fires via existing `_just_established` mechanism (line ~7108)

**On subsequent polls:** bwc_fired is set → skip establishment → compound function runs normally → increments if threshold met.

## What Changes

### Dead Code (remove)

| Lines | What |
|---|---|
| 6649-6669 | Floor-based BWC candidate tracking: `_bwc_candidate`, `_bwc_candidate_holds`, 3-hold logic, XGB 0.40 gate, control-team-change reset |

### Dead `lt` Fields (remove from death clearing)

| Field | Was |
|---|---|
| `lt._bwc_candidate` | Candidate team name |
| `lt._bwc_candidate_holds` | Candidate hold counter |

### New Code (~15 lines)

**Location:** Replace the removed block (lines 6649-6669) with compound establishment check.

```javascript
// NBA: compound-based establishment (MC + Floor)
// NCAAMB: retains floor-based BWC establishment below
if (!lt.bwc_fired && league === 'nba' && currentPeriod >= 2 && ind.controlTeam !== 'Neither') {
  const _estabMC = _mcCum?.winProb != null ? _mcCum.winProb : null;
  const _estabMet = _estabMC != null && _estabMC >= 0.80 && ind.score >= 0.65;
  const _estabQ2 = currentPeriod !== 2 || (_v2Margin >= 5 && (lt.ctrl_flips || 0) === 0);

  if (_estabMet && _estabQ2) {
    lt.bwc_fired = { team: ind.controlTeam, period: currentPeriod, clock, floor: ind.score };
    lt._prev_bwc_state = _v2Margin >= 3 ? 'LOCK' : 'EDGE';
    lt._just_established = true;
    // Seed compound state — this poll is hold #1
    lt.compound_holds = 1;
    lt.compound_last_period = currentPeriod;
    lt.compound_last_clock = clock;
    log(`${matchup}: ★ COMPOUND ESTABLISHMENT — ${ind.controlTeam} MC=${_estabMC.toFixed(3)} floor=${ind.score.toFixed(2)} margin=${_v2Margin} Q${currentPeriod} ${clock}`);
  }
} else if (!lt.bwc_fired && league === 'ncaamb' && ind.score >= 0.60 && _v2Margin >= 2) {
  // NCAAMB retains floor-based BWC candidate tracking
  if (lt._bwc_candidate === ind.controlTeam) {
    lt._bwc_candidate_holds = (lt._bwc_candidate_holds || 0) + 1;
  } else {
    lt._bwc_candidate = ind.controlTeam;
    lt._bwc_candidate_holds = 1;
  }
  if (lt._bwc_candidate_holds >= 3 && currentPeriod >= 2) {
    if (_xgbWinProb != null && _xgbWinProb < 0.40) {
      log(`${matchup}: XGB GATE — blocking BWC establishment`);
    } else {
      lt.bwc_fired = { team: ind.controlTeam, period: currentPeriod, clock, floor: ind.score };
      lt._prev_bwc_state = _v2Margin >= 3 ? 'LOCK' : 'EDGE';
      lt._just_established = true;
      log(`${matchup}: ★ V2 BWC FIRED — ${ind.controlTeam} floor ${ind.score.toFixed(2)} margin ${_v2Margin}`);
    }
  }
} else if (!lt.bwc_fired && league === 'ncaamb' && ind.controlTeam !== lt._bwc_candidate) {
  lt._bwc_candidate = null;
  lt._bwc_candidate_holds = 0;
}
```

### BWC Death Clearing (line ~6590)

Remove `_bwc_candidate` and `_bwc_candidate_holds` from the NBA death clearing. NCAAMB death still clears them (shared block, but candidate fields are only written by NCAAMB path now).

Actually, since death clearing is a shared block (runs for all leagues), and NCAAMB still uses `_bwc_candidate`, we keep those two lines in death clearing unchanged. No harm clearing fields that NBA no longer writes.

### Agent Prompt (line ~641)

Current TRACKING rule says:
> "First structural signal — the system has identified ${ctx.ctrlTeam} as structurally interesting (floor ${ctx.floor}, margin ${ctx.margin})"

Change to:
> "First compound structural signal — MC Cum AND indicator floor both confirm ${ctx.ctrlTeam} as structurally dominant (MC ${ctx.mcCumAtTracking}%, floor ${ctx.floor}, margin ${ctx.margin}). This is a stronger initial signal than historical first-fires."

### Agent Prompt — POSITION_OPEN rule (line ~647)

Current text references "sustained compound structural signals — MC Cum ≥ 0.80 AND Floor ≥ 0.65 — for 5 consecutive polls."

Clarify this is 5 holds AFTER tracking, so 6 total:
No — actually it's still 5 holds total. TRACKING fires on hold #1, PO fires on hold #5. The subscriber sees TRACKING first, then 4 more holds later sees PO. This is correct — 5 total compound-qualifying polls.

Wait, re-reading the current flow: TRACKING fires at establishment (hold 1). Then `checkCompoundConfirmation` runs inside the bwc_fired block. It starts with `compound_holds = 1` (seeded at establishment). On the next qualifying poll, it increments to 2. At 5, it fires `compound_confirmed = true` → PO.

So TRACKING = hold 1, PO = hold 5. That's 4 additional holds after TRACKING. The subscriber gets notified at hold 1 (game is on radar) and hold 5 (position confirmed). The gap is ~2 minutes of game clock at production polling (4 polls × 30s).

The prompt text saying "5 consecutive polls" is still correct — it takes 5 total holds to confirm, with TRACKING being the first one.

### BUY Cold Path (line ~7035)

Unchanged. BUY can still bootstrap `lt.bwc_fired` for a team without prior tracking. This is the "cold BUY" path — BUY fires on its own floor-based criteria, and if no tracking exists, it creates bwc_fired on the fly so the tracking lifecycle activates for position management.

### Snapshot INSERT (line ~6479)

Unchanged — already writes `_snapLT?.compound_tier`.

### v2Ctx (line ~6842)

Unchanged — already reads compound fields from lt.

### formatSonnetPrompt (line ~4562)

Unchanged — already uses compound context.

### Post-game Agent

Unchanged.

### v3.html

Unchanged.

## What Does NOT Change

| System | Why |
|---|---|
| NCAAMB BWC establishment | Retains floor-based 3-hold + XGB 0.40 gate |
| `checkCompoundConfirmation()` function | Same logic, now starts from seeded hold 1 |
| Compound tiers (CONFIRMED/RECOVERING/LOCKED) | Same thresholds and watermark |
| PO evaluation (fires when compound_confirmed) | Same gate |
| Opponent compound flip PO | Same — independent of establishment |
| BWC death | Same — clears all tracking state |
| BWC state machine (LOCK/EDGE/VALUE) | Same — derived from margin, independent of how bwc_fired was set |
| XGB EXIT | Same — fires when XGB + MC Cum both collapse |
| BUY system | Same — independent floor-based trigger, cold BUY still bootstraps bwc_fired |
| Checkpoint capture | Same — runs inside bwc_fired block |
| Trajectory functions | Same — read checkpoints |
| Lane/pregame ML capture | Same — fires after bwc_fired is set |

## Edge Cases

**1. Floor 0.60-0.64 with strong MC:** Under old system, BWC fires and tracking starts. Under compound, no tracking. This is intentional — if indicators are borderline (floor < 0.65), compound doesn't confirm. The signal isn't strong enough for a TRACKING notification.

**2. BWC death → re-establishment:** After death clears bwc_fired, the new control team needs to hit compound threshold to start a new tracking lifecycle. This is stricter than the old system (floor 0.60 + 3 holds) but more meaningful — the second team proved it through compound, not just floor.

**3. Q2 with small lead:** Q2 compound requires margin ≥ 5 + 0 flips. Games where control team leads by 1-4 in Q2 won't get TRACKING until Q3 when the margin gate drops. This is intentional — Q2 small leads are noisy.

**4. Late-game first TRACKING:** In competitive games, compound may not be met until Q3 or Q4. TRACKING fires late. This means fewer checkpoint observations before PO, but the compound signal is strong enough at a single read (88.7% accuracy) that checkpoint accumulation is less important.

**5. BUY fires before TRACKING:** Possible if BUY criteria are met but compound isn't (e.g., floor ≥ 0.65 + trailing, but MC < 0.80). BUY creates bwc_fired via cold path. Then compound starts evaluating inside the lifecycle. This is correct — BUY is an independent system that can bootstrap tracking.

## Cascading Implications

**Fewer TRACKING alerts:** Only fires when compound threshold is met (MC ≥ 0.80 + Floor ≥ 0.65) vs old gate (floor ≥ 0.60 + 3 holds). Subscriber sees fewer but higher-quality "game on radar" notifications.

**Shorter TRACKING → PO gap:** Old system: TRACKING at floor 0.60, then wait for compound to confirm (could be many minutes). New system: TRACKING at compound threshold, PO 4 polls later (~2 min game clock). The arc is tighter.

**Checkpoint context:** Fewer checkpoints between TRACKING and PO since the gap is shorter. Trajectory functions (MF, full CP trend, floor-margin, conviction) have less data. But compound signal at hold 1 is already 88.7% accurate — trajectory adds marginal value (as validated in the graduation research).

**Learning agent:** Arc starts at TRACKING (compound-quality), ends at terminal. Arcs are shorter but start from a stronger baseline. `graduation_rank` column on alerts already stores compound tier. No schema changes.

## Verification

After implementation, verify on next live slate:
1. Log shows `★ COMPOUND ESTABLISHMENT` instead of `★ V2 BWC FIRED`
2. No TRACKING alerts fire for games where compound never reaches threshold
3. TRACKING → PO gap is ~2 min game clock (4 polls at 30s)
4. Cold BUY still works (creates bwc_fired without prior compound)
5. BWC death + re-establishment works for new control team
6. NCAAMB games still fire TRACKING on floor-based criteria

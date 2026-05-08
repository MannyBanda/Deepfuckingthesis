# WNBA Server-Side Blockers Spec
**Date:** May 8, 2026
**Status:** READY FOR REVIEW
**Scope:** 3 blockers in poll-live-bdl.mjs that prevent meaningful WNBA position tracking

---

## Blocker 1: BWC Establishment Path

### Current behavior
WNBA falls into `league !== 'nba'` (line 6872) — NCAAMB's floor-based 3-hold candidate:
```
floor >= 0.60 + margin >= 2 → 3 consecutive holds → BWC fired (XGB gate < 0.40)
```

### Problem
WNBA research validated a compound signal (MC + XGB), not floor-only. Floor is demoted to narrative for WNBA — it's wrong 80% of the time when it disagrees with MC+XGB. Using floor-based establishment means WNBA BWC fires on the wrong signal.

### Fix
Add `league === 'wnba'` block between NBA and NCAAMB paths:

**Establishment threshold (WNBA):** MC Cum ≥ 0.85 AND XGB ≥ 0.60, Q2+
**Q2 early gate:** Same as NBA — margin ≥ 5 + 0 flips (research showed Q2-confirmed = 89.6%, slightly below Q3+ = 93.2%, so Q2 gate is appropriate)

```javascript
} else if (!lt.bwc_fired && league === 'wnba' && currentPeriod >= 2 && ind.controlTeam !== 'Neither') {
  // WNBA: MC Cum + XGB compound (floor demoted to narrative)
  const _estabMC = _mcCum?.winProb != null ? _mcCum.winProb : null;
  const _estabXGB = _xgbWinProb;
  const _estabMet = _estabMC != null && _estabMC >= 0.85
                 && _estabXGB != null && _estabXGB >= 0.60;
  const _estabQ2 = currentPeriod !== 2 || (_v2Margin >= 5 && (lt.ctrl_flips_q2plus || 0) === 0);

  if (_estabMet && _estabQ2) {
    lt.bwc_fired = { team: ind.controlTeam, period: currentPeriod, clock, floor: ind.score };
    lt._prev_bwc_state = _v2Margin >= 3 ? 'LOCK' : 'EDGE';
    lt._just_established = true;
    lt.compound_holds = 1;
    lt.compound_last_period = currentPeriod;
    lt.compound_last_clock = clock;
    log(`${matchup}: ★ WNBA COMPOUND ESTABLISHMENT — ${ind.controlTeam} MC=${_estabMC.toFixed(3)} XGB=${_estabXGB.toFixed(3)} floor=${ind.score.toFixed(2)} margin=${_v2Margin} Q${currentPeriod} ${clock}`);
  }
}
```

**Line change:** Replace the `else if (!lt.bwc_fired && league !== 'nba' ...` block with three branches:
1. `league === 'nba'` — existing compound (MC ≥ 0.80 + floor ≥ 0.65)
2. `league === 'wnba'` — NEW compound (MC ≥ 0.85 + XGB ≥ 0.60)
3. `league === 'ncaamb'` (or default) — existing floor-based 3-hold candidate

### Cascading implications
- `lt.bwc_fired` structure is identical — no downstream changes
- `lt.compound_holds = 1` seeds the WNBA compound graduation (Blocker 2)
- All BWC Death, state machine transitions, alert routing reads `lt.bwc_fired` — unchanged

---

## Blocker 2: Compound Graduation Thresholds

### Current behavior
`checkCompoundConfirmation` (line 2562) hardcodes:
- **Sustain:** MC Cum ≥ 0.80 AND Floor ≥ 0.60
- **Confirmation:** 5 holds → CONFIRMED (0 flips) or RECOVERING (1+ flips)
- **LOCKED:** 10 holds, 0 flips
- **Q2 early:** lead ≥ 5, 0 flips

### Problem
WNBA research validated different compound:
- **Sustain:** MC Cum ≥ 0.85 AND XGB ≥ 0.60 (floor demoted)
- **Confirmation:** 2 checkpoint holds ≈ 5 poll holds (research used 2.5-min checkpoints ≈ 2-3 poll cycles each)
- **Accuracy:** 90.9% overall, 93.2% Q3+, 89.6% Q2

### Fix
Add `league` parameter to `checkCompoundConfirmation`. Branch the threshold and hold count.

**Signature:** `checkCompoundConfirmation(lt, mcCumWinProb, floor, period, clock, ctrlTeam, bwcTeam, ctrlMargin, priorFlips, league, xgbWinProb)`

```javascript
// WNBA: MC Cum + XGB compound (floor is narrative only)
// NBA: MC Cum + Floor compound
let baseThreshold;
if (league === 'wnba') {
  baseThreshold = mcCumWinProb != null && mcCumWinProb >= 0.85
               && xgbWinProb != null && xgbWinProb >= 0.60;
} else {
  baseThreshold = mcCumWinProb != null && mcCumWinProb >= 0.80 && floor >= 0.60;
}
```

**Hold count for confirmation:**
```javascript
const holdsNeeded = league === 'wnba' ? 5 : 5;
// Note: Research says "2 checkpoint holds" at 2.5-min spacing ≈ 5 minutes of game clock.
// With ~60s wall-clock poll interval and ~30s game-clock per poll, that's ~5 poll holds.
// Keep at 5 for consistency — same real-time validation window as NBA.
```

Actually, 2 checkpoint holds at 2.5-min spacing = 5 minutes of game clock. At ~30s game-clock per poll cycle, that's ~10 polls. But the NBA uses 5 polls for confirmation. The WNBA compound is already MORE selective (MC 0.85 vs 0.80, XGB instead of floor), so 5 poll holds is appropriate — the higher threshold compensates for fewer holds.

**LOCKED upgrade:** Keep at 10 holds, 0 flips. Same logic.

**Q2 early path:** Keep identical (margin ≥ 5, 0 flips). Works for both leagues.

### Callsite change
Line 7486:
```javascript
const _compoundResult = checkCompoundConfirmation(
  lt, _compoundMcCum, ind.score, currentPeriod, clock,
  ind.controlTeam, bwcTeam, _v2Margin, lt.cp_ctrl_flips,
  league, _xgbWinProb   // NEW params
);
```

### Cascading implications
- `_compoundResult.tier` / `.holds` / `.confirmed` — same shape, no downstream changes
- Agent context receives compound tier via `ctx.compoundTier` — unchanged
- Alert type routing reads `lt.compound_confirmed` — unchanged
- Position alerts (POSITION_OPEN, etc.) fire on `lt.compound_confirmed` — works for both

---

## Blocker 3: GRAD_CHECKPOINTS for WNBA

### Current state
NBA checkpoints (12-min quarters, 48-min game):
```
Q1_END (720s), Q2_9 (900), Q2_6 (1080), Q2_3 (1260), Q2_END (1440),
Q3_9 (1620), Q3_6 (1800), Q3_3 (1980), Q3_END (2160),
Q4_9 (2340), Q4_6 (2520), Q4_3 (2700)
```

WNBA checkpoints from backtest (10-min quarters, 40-min game):
```
Q1_END (600s), Q2_7.5 (750), Q2_5 (900), Q2_2.5 (1050), Q2_END (1200),
Q3_7.5 (1350), Q3_5 (1500), Q3_2.5 (1650), Q3_END (1800),
Q4_7.5 (1950), Q4_5 (2100), Q4_2.5 (2250)
```

### Fix
Make `GRAD_CHECKPOINTS` league-aware:

```javascript
const GRAD_CHECKPOINTS_NBA = [
  { label: 'Q1_END', period: 2, clockSec: 720, gameSec: 720  },
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

const GRAD_CHECKPOINTS_WNBA = [
  { label: 'Q1_END', period: 2, clockSec: 600, gameSec: 600  },
  { label: 'Q2_7.5', period: 2, clockSec: 450, gameSec: 750  },
  { label: 'Q2_5',   period: 2, clockSec: 300, gameSec: 900  },
  { label: 'Q2_2.5', period: 2, clockSec: 150, gameSec: 1050 },
  { label: 'Q2_END', period: 2, clockSec: 0,   gameSec: 1200 },
  { label: 'Q3_7.5', period: 3, clockSec: 450, gameSec: 1350 },
  { label: 'Q3_5',   period: 3, clockSec: 300, gameSec: 1500 },
  { label: 'Q3_2.5', period: 3, clockSec: 150, gameSec: 1650 },
  { label: 'Q3_END', period: 3, clockSec: 0,   gameSec: 1800 },
  { label: 'Q4_7.5', period: 4, clockSec: 450, gameSec: 1950 },
  { label: 'Q4_5',   period: 4, clockSec: 300, gameSec: 2100 },
  { label: 'Q4_2.5', period: 4, clockSec: 150, gameSec: 2250 },
];

function getGradCheckpoints(league) {
  if (league === 'wnba') return GRAD_CHECKPOINTS_WNBA;
  return GRAD_CHECKPOINTS_NBA;
}

// Backward compat
const GRAD_CHECKPOINTS = GRAD_CHECKPOINTS_NBA;
```

### Consumers of GRAD_CHECKPOINTS (7 references)

1. **Line 7375:** `Object.fromEntries(GRAD_CHECKPOINTS.map(...))` — checkpoint ordering
2. **Line 7404:** `GRAD_CHECKPOINTS.findIndex(cp => cp.label === lastLabel)` — catch-up loop
3. **Line 7416-7424:** Catch-up iteration, checkpoint recording
4. **Line 2532:** `checkXGBExit` doesn't use checkpoints directly — no change
5. **updateLiveTracking** (line 2475) — doesn't reference GRAD_CHECKPOINTS

All 7 references are inside the per-game loop where `league` is in scope. Replace each `GRAD_CHECKPOINTS` with `getGradCheckpoints(league)`.

### Note on checkpoint labels
WNBA labels use decimal notation (Q2_7.5, Q2_5, Q2_2.5) matching the backtest. These are stored in `game_checkpoints.label` (PK with game_id). No collision with NBA labels since game_id is league-specific.

### Cascading implications
- `game_checkpoints` table: PK is (game_id, label). WNBA labels are different strings from NBA — no collision, no schema change needed.
- Checkpoint graduation logic (B-rank Q3_6 gate): WNBA equivalent would be Q3_5 gate. This is inside `checkpointGraduation` which compares label ordering — need to verify the B-rank gate label is league-correct.
- Learning agent: reads checkpoint labels from DB — will see WNBA labels naturally.
- Client display: will need to understand WNBA labels for history display.

---

## Implementation Order

1. **GRAD_CHECKPOINTS** — add WNBA array + `getGradCheckpoints(league)`, replace all 7 references
2. **checkCompoundConfirmation** — add `league` + `xgbWinProb` params, branch threshold
3. **BWC Establishment** — split 3-way (NBA / WNBA / NCAAMB)
4. Syntax check + verify NBA path unchanged

**Estimated scope:** ~80 lines changed, all in poll-live-bdl.mjs. Same file, same risk profile as prior changes — all gated by `league`, NBA path byte-identical.

---

## Moderate Gaps (fix in same pass if approved)

### Sustainability twoPointBaseline
**Line 3753:** `var twoPointBaseline = sznDefault <= 34 ? 0.49 : 0.52;`
**Fix:** `var twoPointBaseline = LEAGUES[league]?.twoPointBaseline || (sznDefault <= 34 ? 0.49 : 0.52);`
Note: `computeSustainability` already has `league` param. One-line fix.

### Sustainability seasonPrior3Pct
**Line 3430:** `var seasonPrior3Pct = 36.0;`
**Fix:** `var seasonPrior3Pct = league === 'wnba' ? 34.7 : league === 'ncaamb' ? 33.5 : 36.0;`

### Season cache bdlHasSeasonStats
**WNBA config:** `bdlHasSeasonStats: false` — blocks season cache loading.
**Fix:** Flip to `true` — BDL has WNBA `player_season_stats` and `team_season_stats` endpoints.
**Risk:** If BDL WNBA season stats don't exist for 2026 (first season), the fetch will 404 and fall back gracefully. Low risk.

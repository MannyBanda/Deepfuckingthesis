# XGB EXIT SPEC — Pure XGB Replaces Control Flip EXIT

## Evidence Base

**1,175 BWC-eligible games backtested.** Pure XGB <0.40 delivers:
- **84.2% overall accuracy** (vs 72.5% current control flip)
- **92.4% exit accuracy** when it fires (vs 63.7%)
- **88.3% loss protection** — catches losses current misses
- **91.0% hold accuracy** — dramatically fewer premature exits

Q4-specific (Manny's call: threshold 0.45):
- **90.8% exit accuracy, 90.2% overall**
- Current Q4 control flip: 63.8% — barely above coin flip

---

## Core Change

**EXIT no longer fires on structural control flip.** EXIT fires when XGB win
probability for the BWC team drops below a quarter-aware threshold.

Control flips still affect the BWC state machine (LOCK→EDGE→VALUE→DEEP_TRAIL)
for narrative and other alerts. But the EXIT *alert* — the one that tells the
subscriber to get out — is now driven purely by XGB.

---

## Thresholds

| Period | XGB EXIT Threshold | Backtest Exit Accuracy | Notes |
|--------|-------------------|----------------------|-------|
| Q1     | No EXIT           | —                    | Existing rule preserved |
| Q2     | < 0.40            | 92.4%                | Broad backtest number |
| Q3     | < 0.40            | 92.4%                | Same |
| Q4     | < 0.45            | 90.8%                | Manny's call — tighter, catches more |

---

## Granularity: Backtest vs Production

### The gap

The backtest validated at **3-minute checkpoint intervals** (14 per game). Production
polls every **~60 seconds**. This matters:

| | Checkpoints (backtest) | Poll-level (production) |
|---|---|---|
| **Readings per quarter** | ~4 | ~12 |
| **Noise risk** | Low — 3min smooths possessions | Higher — single dead ball can spike |
| **Detection speed** | Up to 3min delay | ~60s delay |
| **Accuracy transfer** | Validated directly | NOT validated — accuracy could be lower |

### The risk

A single bad 60-second window (opponent 6-0 run, timeout, dead ball) could briefly
push XGB below threshold. At checkpoint granularity, that noise is smoothed out by
the next 2 minutes of play. At poll granularity, it could trigger a premature EXIT.

**Conversely:** In Q4, 3-minute checkpoints only give 4 readings. A real collapse
between checkpoints costs valuable exit time. The subscriber is watching a live game
— a 3-minute lag is noticeable.

### Recommendation: Poll-level with confirmation window

XGB is already computed every poll cycle. Use it, but require **sustained signal**
before firing:

```
XGB EXIT fires when:
  1. XGB < quarter_threshold for 2 consecutive polls (~2 minutes)
  OR
  2. XGB < 0.15 on any single poll (extreme collapse, no confirmation needed)
```

**Why 2 polls (~2min), not 3-minute checkpoints:**
- Faster than checkpoint-only (catches Q4 collapses ~1min earlier)
- Still smooths single-possession noise (requires sustained drop)
- Not tied to arbitrary game-clock boundaries

**Hysteresis on recovery:**
- Once `xgb_exit_warned` is set, clear it only if XGB recovers above
  threshold + 0.05 (e.g., above 0.45 in Q2-Q3, above 0.50 in Q4)
- Prevents oscillation around threshold from producing warn/clear/warn chatter

---

## Architecture Changes

### 1. `computeBwcState()` — MODIFY

Remove the EXIT return. When BWC team loses structural control, the state goes
to VALUE or DEEP_TRAIL based on margin — not EXIT.

```
BEFORE:
  if (bwcFired.team === ctrlTeam) {
    if (margin >= 3) return 'LOCK';
    if (margin >= 1) return 'EDGE';
    if (margin >= -7) return 'VALUE';
    return 'DEEP_TRAIL';
  } else {
    return 'EXIT';           // ← REMOVE THIS
  }

AFTER:
  // Always compute state from BWC team's perspective
  const bwcMargin = bwcFired.team === homeAlias
    ? (homePts - awayPts) : (awayPts - homePts);
  if (bwcMargin >= 3) return 'LOCK';
  if (bwcMargin >= 1) return 'EDGE';
  if (bwcMargin >= -7) return 'VALUE';
  return 'DEEP_TRAIL';
```

**Why:** The BWC state should reflect the position's MARGIN situation regardless of
who holds structural control. A BWC team can be in LOCK (up 5) while the opponent
holds structural indicators — that's still LOCK for position tracking. XGB decides
whether the structural situation warrants an EXIT separately.

**Cascading impact:**
- `STATE_RANK` — remove EXIT entry (or keep for backwards compat with stored data)
- `classifyTransition()` — no path produces EXIT, so no DEGRADING→EXIT transition
- V2 state transition block — no `v2BwcState === 'EXIT'` branch fires
- Prior alerts stored with bwc_state='EXIT' still exist in DB — no migration needed

### 2. New: `checkXGBExit()` — ADD

```javascript
function checkXGBExit(lt, xgbWinProb, period) {
  if (period < 2) return false;
  if (xgbWinProb == null) return false;
  if (lt.xgb_exit_sent) return false;  // one-shot per position

  const threshold = period >= 4 ? 0.45 : 0.40;

  // Extreme collapse — bypass confirmation
  if (xgbWinProb < 0.15) return true;

  if (xgbWinProb < threshold) {
    if (!lt.xgb_exit_warned) {
      lt.xgb_exit_warned = Date.now();
      return false;  // first warning — start confirmation window
    }
    if (Date.now() - lt.xgb_exit_warned >= 90000) {
      return true;   // sustained below threshold for ~2 polls
    }
    return false;     // still in confirmation window
  } else if (xgbWinProb >= threshold + 0.05) {
    lt.xgb_exit_warned = null;  // recovered — clear with hysteresis
  }
  return false;
}
```

**Where it runs:** In the poll loop, AFTER the existing V2 state transition block,
BEFORE the BUY triggers. Gated on `lt.bwc_fired && lt.po_fired` (same as current
EXIT — only applies to graduated positions).

### 3. XGB EXIT Alert Routing

When `checkXGBExit()` returns true:

```javascript
if (checkXGBExit(lt, xgbWinProb, currentPeriod)) {
  lt.xgb_exit_sent = true;
  lt.position_closed = true;
  lt.position_closed_ts = Date.now();

  const exitSeverity = {
    severity: xgbWinProb < 0.15 ? 'COLLAPSE' : xgbWinProb < 0.25 ? 'SEVERE' : 'STANDARD',
    xgb: xgbWinProb,
    threshold: currentPeriod >= 4 ? 0.45 : 0.40,
    bwcState: computeBwcState(lt, ind.controlTeam, _v2Margin),
    ctrlTeam: ind.controlTeam,
    bwcTeam: lt.bwc_fired.team,
    ctrlMatchesBWC: ind.controlTeam === lt.bwc_fired.team,
  };

  await routeV2Alert('EXIT', 'FIRED', exitSeverity, false);
}
```

### 4. Recovery After XGB EXIT

After `lt.xgb_exit_sent = true` and `lt.position_closed = true`:

Recovery fires when XGB recovers above threshold + hysteresis for 2 consecutive
polls AND BWC state is VALUE or better:

```javascript
if (lt.xgb_exit_sent && lt.position_closed && xgbWinProb != null) {
  const recoveryThreshold = (currentPeriod >= 4 ? 0.45 : 0.40) + 0.10;

  if (xgbWinProb >= recoveryThreshold) {
    if (!lt.xgb_recovery_warned) {
      lt.xgb_recovery_warned = Date.now();
    } else if (Date.now() - lt.xgb_recovery_warned >= 90000) {
      // Sustained recovery — fire recovery alert based on BWC state
      const bwcState = computeBwcState(lt, ind.controlTeam, _v2Margin);
      let recoveryType = 'THESIS_ALIVE';
      if (bwcState === 'LOCK') recoveryType = 'POSITION_SAFE';
      else if (bwcState === 'EDGE') recoveryType = 'POSITION_RECOVERING';

      lt.xgb_exit_sent = false;  // allow re-exit if XGB drops again
      lt.xgb_recovery_warned = null;
      lt.xgb_exit_warned = null;

      await routeV2Alert(recoveryType, 'FIRED', null, false);
      // Note: position_closed stays true — agent decides whether to SEND
      // and re-open position (elevated re-entry bar applies)
    }
  } else {
    lt.xgb_recovery_warned = null;  // recovery stalled, reset
  }
}
```

**Recovery threshold = EXIT threshold + 0.10:**
- Q2-Q3: Must recover to 0.50 (from <0.40 exit)
- Q4: Must recover to 0.55 (from <0.45 exit)
- This prevents oscillation: exit at 0.39, recover to 0.41, immediately re-enter

### 5. Existing State Transitions — PRESERVE

The LOCK→EDGE→VALUE→DEEP_TRAIL transitions and their alerts (BWC_EDGE,
POSITION_SAFE, POSITION_RECOVERING, THESIS_ALIVE on state changes) continue
to work exactly as before. They describe margin-based situation changes and give
the subscriber updates about their position.

The ONLY change is: `computeBwcState()` never returns EXIT, so the DEGRADING path
never produces an EXIT alert via state transition. EXIT comes exclusively from XGB.

**This means:**
- BWC_EDGE still fires when margin compresses from LOCK→EDGE
- VALUE still fires when margin drops into 0 to -7
- POSITION_SAFE still fires when margin recovers to 3+
- POSITION_RECOVERING fires on DEEP_TRAIL→EDGE recovery
- THESIS_ALIVE fires on DEEP_TRAIL→VALUE recovery
- These ALL still use the structural control flip for state determination

The subscriber still gets the full narrative arc. XGB just owns the EXIT decision.

### 6. STRUCTURAL_SHIFT — REPURPOSE

Currently: pre-flip warning. With XGB EXIT, there's no "flip" to warn about.

**New role: Pre-EXIT XGB warning.** Fires when XGB crosses a warning threshold
above the EXIT threshold:

```
Warning threshold = EXIT threshold + 0.10
  Q2-Q3: XGB crosses below 0.50 (EXIT at 0.40)
  Q4: XGB crosses below 0.55 (EXIT at 0.45)
```

Only fires once per descent (dedup via `lt.structural_shift_warned`).
Gives subscriber a heads-up: "XGB declining — structural edge weakening."

*Optional — can defer this. STRUCTURAL_SHIFT currently works and can stay
as-is for the first deployment. The indicator-based pre-flip warning is still
directionally useful even without being tied to EXIT.*

---

## Agent Prompt Changes

### EXIT block — REWRITE

```
- EXIT: The XGB structural model has dropped below the exit threshold for
  ${ctx.bwcTeam}, indicating the raw game stats no longer support the
  position thesis. XGB reading: ${ctx.xgbAtExit}% (threshold:
  ${ctx.exitThreshold}%). Current BWC state: ${ctx.bwcState}
  (margin: ${ctx.margin}).

  Context the subscriber needs:
  1. Whether structural control has ALSO flipped (double confirmation)
     or if this is a raw-stats deterioration while indicators lag
  2. The margin situation — are they still leading?
  3. What changed in the underlying stats (paint, eFG, turnovers)
  4. Whether this looks like a permanent shift or a temporary dip

  EXIT on graduated positions is ALWAYS SEND. Your job is the narrative,
  not the decision.
```

### Recovery blocks — MODIFY

Add XGB context to THESIS_ALIVE/POSITION_RECOVERING/POSITION_SAFE:

```
When position_closed (after XGB EXIT):
  XGB has recovered to ${ctx.xgbNow}% (was ${ctx.xgbAtExit}% at EXIT).
  Recovery threshold: ${ctx.recoveryThreshold}%.
  This is a RE-ENTRY signal. Apply elevated scrutiny.
```

---

## What This Touches (implementation checklist)

### poll-live-bdl.mjs
- [ ] `computeBwcState()` — remove EXIT branch, compute margin from BWC team perspective
- [ ] Add `checkXGBExit()` function
- [ ] Add XGB EXIT detection block (after state transitions, before BUY triggers)
- [ ] Add XGB recovery detection block
- [ ] Update `formatSonnetPrompt()` — EXIT context block
- [ ] Update agent prompt — EXIT rules, recovery rules
- [ ] `live_tracking` new fields: `xgb_exit_sent`, `xgb_exit_warned`, `xgb_recovery_warned`

### db-api.js
- [ ] No schema changes needed (EXIT alerts already stored with standard fields)
- [ ] `xgb_win_prob` already on alerts table

### v3.html
- [ ] EXIT alert display — may want to show XGB reading in card
- [ ] No structural changes needed (client doesn't decide EXIT)

### post-game-agent.mjs (learning agent)
- [ ] Arc scoring — EXIT is now XGB-based, same correctness logic applies
- [ ] No structural changes needed

### Dead code to remove
- [ ] `computeExitSeverity()` — replaced by XGB-based severity
- [ ] `STATE_RANK['EXIT']` — can keep for backwards compat
- [ ] EXIT branch in `computeBwcState()` — the core change

---

## What This Does NOT Change

- BWC establishment and graduation (checkpoint system)
- BUY lifecycle and XGB_INVALIDATED exit (separate system)
- Indicator calculation (I1-I5)
- Sustainability audit
- TP/LS computation
- Floor score computation
- All other alert types (BUY, BWC, WINDOW BUY, RECOVERY PATH, etc.)
- LOCK/EDGE/VALUE/DEEP_TRAIL state transitions and their alerts

---

## Risk Assessment

### Known risk: Cumulative anchoring in XGB

The ATL@NYK Game 2 replay showed XGB at 81-86% for NYK at control flip
while ATL won by 1. XGB inherits the same cumulative anchoring problem as the
floor — 42 minutes of NYK dominance masks ATL's Q4 takeover.

**Mitigation:** The backtest shows this is a ~8% failure rate at the <0.40
threshold (92.4% accuracy). This is dramatically better than the 36.3% premature
exit rate of the current control flip system.

### Known risk: No PBP runs in XGB features

Snapshot-based XGB uses `runShare = 0.5` (neutral) because PBP run data isn't in
the raw_stats_json. The backtest used the same limitation. Feature #14 (runs)
contributes less than 1% of AUC — minimal impact.

### Known risk: Confirmation window delay

The 90-second confirmation window means a genuine collapse is detected ~2 minutes
after the first signal. In Q4 crunch time, this is meaningful.

**Mitigation:** The extreme collapse fast-path (XGB < 0.15) bypasses confirmation
entirely. And 90 seconds is faster than the current system's checkpoint-based
detection (up to 3 minutes).

---

## Sequencing

1. **Implement `computeBwcState()` change + `checkXGBExit()`**
2. **Update agent prompt for XGB EXIT context**
3. **Add recovery detection**
4. **Test on first live slate** — monitor logs for XGB EXIT triggers
5. **Optional: Repurpose STRUCTURAL_SHIFT as pre-EXIT warning**

# GRADUATION SIMPLIFICATION SPEC v3
## Compound threshold graduation + EXIT compound (MC Cum + Windowed XGB)

**Date:** May 6, 2026 (v3 — EXIT compound added, position monitoring closed)
**Status:** SPEC — awaiting confirmation before implementation
**Risk Level:** HIGH — touches agent prompts, PO firing, EXIT logic, alert context, learning agent
**Backup:** backups/graduation-pre-simplification/ at commit daa0dbe

---

## 0. TERMINOLOGY

- **Position tracking** replaces "BWC tracking." The state where the system has identified structural control but not yet confirmed a position.
- **Position open / confirmed** = compound threshold met for 5 consecutive polls.
- **S/A/B/C ranks are retired.** Replaced by confidence tiers: TRACKING → CONFIRMED → RECOVERING → LOCKED.

---

## 1. SCOPE

**IN SCOPE:** NBA graduation path in poll-live-bdl.mjs. EXIT compound (windowed XGB + MC Cum gate). Agent prompts. PO firing logic. v2Ctx construction. Alert fields. Dashboard display. Learning agent graduation references.

**OUT OF SCOPE:** NCAAMB graduation (lines ~7371-7460 — separate system, unchanged). PBP MC canary investigation pipeline (unchanged — canary triggers investigation, EXIT is separate). BUY/PO decoupled system (unchanged). Alert routing/dedup (unchanged).

**CLOSED (research completed May 6):**
- Position monitoring (LOCK/EDGE/VALUE as compound states): insufficient discrimination. 85% of confirmed positions never dip below MC 0.90. The 0.70-0.90 middle zone is only 20 games at 80% win rate — not alarming enough for a separate alert layer. MC Cum level injected into agent narrative on existing position alerts instead.
- PBP MC canary as EXIT discriminator: fires 70% on both true and false exits — too volatile for gating decisions. Role is early warning/investigation trigger only.

---

## 2. WHAT CHANGES

### 2A. New Position Confirmation Logic

**Replaces:** recomputeCheckpointState() → S/A/B/C ranks → PO evaluation with MF/minF/lane gates

**New system — uniform 5 poll holds, two paths:**

```
Q2 EARLY CONFIRMATION:
  5 consecutive polls where:
    MC Cum >= 0.80 AND Floor >= 0.65 AND ctrl_margin >= 5 AND 0 prior flips
  -> CONFIRMED (95.5%, 22/48 playoff games trigger)

Q3+ STANDARD CONFIRMATION:
  5 consecutive polls where:
    MC Cum >= 0.80 AND Floor >= 0.65
  -> CONFIRMED (81.8%, 44/48 trigger)
  -> If 1+ prior flips: RECOVERING (73%)
```

**Why 5 polls:** 5 consecutive deduped polls = ~2.5 min game clock = ~5 min wall clock. Production-validated on 48 playoff games with backfilled MC Cum (500 sims, production-equivalent). Accuracy climbs from 78.7% (1 hold) to 81.8% (5 holds) with minimal coverage loss (47->44 games).

**Why lead>=5 in Q2:** Every Q2 game where compound fires at margin 0-4 is a loss (3/3). The margin gate filters games where Q2 MC is overconfident in close situations. Q3+ does not need a margin gate because MC calibration improves with game time.

**Why 0 flips required for Q2:** Q2 with flips = untested control. By Q3+, a flip followed by 5 sustained holds proves the team re-established control through challenge.

### 2B. Confidence Tiers

| Tier | Condition | Accuracy | Subscriber alert? |
|---|---|---|---|
| TRACKING | Position tracking started, compound not yet met | n/a | No — internal only |
| CONFIRMED | 5 holds, 0 prior flips | 86% | Yes -> POSITION_OPEN |
| RECOVERING | 5 holds, 1+ prior flips | 73% | Yes -> POSITION_OPEN (agent notes lower confidence) |
| LOCKED | 10+ holds, 0 prior flips | 92% | No new alert — upgrades context on subsequent alerts |

CONFIRMED and RECOVERING both fire POSITION_OPEN. The difference is agent language:
- CONFIRMED: "Structural position confirmed — compound signals aligned."
- RECOVERING: "Position confirmed after control flip — structural edge recovered but game contested."

LOCKED does not fire a separate alert. It upgrades confidence language on position monitoring alerts.

### 2C. Close Game Acknowledgment

Compound plateaus at 75% accuracy in close games (margin <= 8) regardless of hold count. This is the best close-game accuracy the system has produced:
- Pre-graduation first fire: 51.1%
- Floor graduation B-rank close games: 68.6%
- Compound 5 holds close games: 75.0%

The agent prompt must communicate this honestly. Close-game compound is a 75% edge, not a certainty.

### 2D. Implementation — checkCompoundConfirmation()

New function (~30 lines). Called every poll cycle (not just at checkpoint boundaries).

- Tracks lt.compound_holds (consecutive poll count above threshold)
- Resets to 0 when compound threshold is not met
- Resets to 0 on control flip (streak requires same team throughout)
- Returns { confirmed, tier, holds, path }
- Q2 path adds lead>=5 and 0-flip requirements
- Concurrent invocation under-count (last-write-wins) makes system marginally more conservative — expected behavior, not a bug

### 2E. PO Firing Logic

checkCompoundConfirmation() returns confirmed: true AND !lt.po_fired -> PO fires.

- PO stores tier string (CONFIRMED/RECOVERING/LOCKED)
- Suppress throttle (escalating 3/6/12 min) UNCHANGED
- PO_ACTIVE sentinel still written to game_checkpoints
- lt.po_fired: { team, tier, period, clock, holds, path, mc, floor }

### 2F. Flip PO Logic

Opponent compound confirmation — opponent floor/MC Cum must meet compound threshold for 5 holds while opponent has control.

- lt.cp_opp_holds tracking STAYS
- Opponent must be more recent controller
- Flip PO fires POSITION_OPEN with flipped: true

### 2G. Death Clearing

Clears: lt.compound_holds, lt.compound_confirmed
DELETE FROM game_checkpoints on death STAYS for PO_ACTIVE cleanup.

### 2H. Agent Prompt Rules

~180 lines graduation rules -> ~40 lines compound rules.

Remove all S/A/B/C rank references, MF trajectory, checkpoint counts, flip penalties, lane gates, POST-EXIT graduation validation.

Replace with: compound state, trust hierarchy by quarter, close game note, RECOVERING context, post-EXIT re-entry (compound must re-meet, no carryover).

### 2I-2N. Other Changes

- formatSonnetPrompt: replace graduation context with compound state
- v2Ctx: remove dead fields, add compound fields
- Alert INSERT: graduation_rank -> tier string, cp_eligible_count -> compound_holds
- Snapshot INSERT: grad_rank -> compound tier
- Post-game agent: reads new tier strings, arc scoring unchanged
- v3.html: grad_rank color mapping updated

No schema migrations needed.

---

## 3. EXIT COMPOUND (NEW — validated May 6)

### 3A. Problem

Current EXIT uses cumulative XGB with flat 0.45 threshold. Cumulative XGB is slow to detect structural collapse because early-game dominance anchors the probability high. In 2/10 playoff losses, cumulative XGB never dropped below 0.55 — EXIT never fired.

### 3B. Solution: Windowed XGB + MC Cum Gate

Two-signal compound where each signal does what it's best at:

```
EXIT TRIGGER: Windowed XGB (2Q boundary diff)
  - Threshold: < 0.45 flat
  - Fast-path: < 0.15 (bypass confirmation)
  - 2-poll confirmation (90 seconds)
  - Recovery: >= 0.50 clears warning

EXIT GATE: MC Cum < 0.70
  - Windowed XGB EXIT fires first (early detection)
  - MC Cum confirms sustained structural shift
  - EXIT only acts when BOTH signals agree
```

### 3C. Validation (48 playoff games, 45 confirmed positions)

| Configuration | TP | FP | Precision | Recall |
|---|---|---|---|---|
| Windowed XGB EXIT only | 10/10 | 10/35 | 50% | 100% |
| **Windowed XGB + MC Cum < 0.70** | **8/10** | **3/35** | **73%** | **80%** |
| Cumulative XGB EXIT (current prod) | 8/10 | varies | ~50% | 80% |

**2 missed losses (accepted cost):**
- CLE@TOR (MC Cum 0.787 at EXIT): MC Cum anchored from strong first half
- DET@ORL (MC Cum 0.877 at EXIT): blowout reversal, MC Cum anchored from 22-point lead

Both are blowout reversals where cumulative anchoring prevents MC Cum from dropping. The PBP canary catches both of these through the investigation pipeline, so subscribers still get the MC_COLLAPSE alert — EXIT just doesn't fire.

**3 false positives (structurally correct exits):**
- LAL@HOU (MC Cum 0.169, margin -4): genuinely losing, won in OT
- CLE@TOR OT (MC Cum 0.487, margin 0): overtime coin flip
- ORL@DET (MC Cum 0.715, margin 2): borderline threshold

All three were structurally correct reads — the team was losing at EXIT time and recovered. Hard to call these "wrong."

### 3D. Why PBP MC Doesn't Gate EXIT

PBP MC (20-possession window) fires on 70% of both true and false exits. It's too volatile — a 20-possession run triggers it whether the shift is permanent or temporary. MC Cum is smoother and only drops below 0.70 when the structural shift has infected full-game rates.

Signal roles:
- **Windowed XGB** = early structural decay detector (fires first, most sensitive)
- **MC Cum** = confirmation of sustained shift (smoother, less reactive)
- **PBP MC** = investigation trigger (catches collapses for MC_COLLAPSE alert, not for EXIT gating)
- **Floor** = narrative context + indicator decomposition (too anchored for decisions)

### 3E. Implementation — checkXGBExit() Changes

Modify existing checkXGBExit() (~10 lines changed):

1. Replace cumulative XGB input with windowed XGB (`_xgbBwcProb` computed from window features)
2. Add MC Cum gate: `if (mcCumWinProb >= 0.70) return false;` before threshold check
3. Pass `mcCumWinProb` as new parameter
4. Threshold stays 0.45, confirmation stays 2-poll 90s, fast-path stays 0.15

Call site changes:
- Compute windowed XGB features at EXIT check time (window already computed for snapshot XGB)
- Pass mc_cum_win_prob (already available from always-on MC trajectory)

### 3F. Infrastructure Deployed

`backfill_mc_pbp` phase added to mc-backtest.mjs (commit c956442). Fetches BDL plays retroactively, builds possession log, computes PBP 20-possession windowed MC at each snapshot. Writes mc_win_prob to snapshots. All 48 playoff games backfilled (5,407 snapshots).

---

## 4. SIGNAL ROLES (validated May 6)

| Signal | Best at | Weakness | Role |
|---|---|---|---|
| Windowed XGB (2Q) | Early structural decay, recency | Noisy in Q2 (only 1Q of data) | EXIT trigger, entry gates |
| MC Cum (full game) | Sustained probability, calibration | Cumulative anchoring in blowouts | EXIT gate, confirmation |
| PBP MC (20 poss) | Real-time collapse detection | Too volatile for gating | Investigation trigger |
| Floor (cumulative) | Indicator decomposition, narrative | Anti-predictive in lead-change games | Agent context, not decisions |
| XGB Cum (full game) | Stable structural read | Misses 2/10 collapses entirely | Replaced by windowed for EXIT |

Trust hierarchy by quarter (unchanged):
- Q2: Floor ≈ XGB > MC (MC off calibration by 10pp)
- Q3: MC ≈ XGB > Floor
- Q4: MC > XGB > Floor

---

## 5. DEAD CODE TO REMOVE

### Functions (~220 lines — classifyRank KEPT for NCAAMB):
- computeCheckpointFloorStats() (2483-2500)
- computeMFTrajectory() (2502-2531)
- computeFullCPTrend() (2533-2562)
- computeFloorMarginSignal() (2564-2597)
- computeConvictionTrend() (2599-2630)
- recomputeCheckpointState() (2632-2700)
- getLaneGates() (2701-2703)

### Constants:
- LANE_THRESHOLDS (2306-2311) — dead

### Keep:
- GRAD_CHECKPOINTS — still drives checkpoint capture + NCAAMB
- classifyRank — NCAAMB uses it (line ~7394)
- lt.cp_opp_holds — flip PO tracking

---

## 6. PRODUCTION VALIDATION

48 NBA playoff games (Apr 19-May 5, 2026). MC Cum backfilled via backfill_mc_cum phase (500 sims, production-equivalent, commit 3d7089c). Data deduped by (period, clock) to remove concurrent invocation duplicates.

| Signal | Accuracy | n |
|---|---|---|
| 5 holds, 0 flips | 86% | 29 |
| 5 holds, 1+ flips | 73% | 15 |
| 10 holds, 0 flips | 92% | 25 |
| Q2 early (5 holds + lead>=5, 0 flips) | 95.5% | 22 |
| Close games (margin <= 8, 5+ holds) | 75% | 12 |
| PBP canary on compound losses | 11/11 caught | 11 |

### Q2 Lead Gate
| Gate | Accuracy | Games |
|---|---|---|
| lead >= 0 | 84.0% | 25 (3 extra games = ALL losses) |
| lead >= 5 | 95.5% | 22 (sweet spot) |
| lead >= 8 | 94.7% | 19 (loses 3 wins) |

### Poll Interval
60s wall clock per poll. ~28-30s game clock per poll (dead ball time). 5 polls = ~5 min wall = ~2.5 min game clock. 45% raw snapshot dedup rate from concurrent crons.

---

## 7. CASCADING IMPLICATIONS

- Learning agent: LOW risk. Scores on terminal outcome, not tier.
- Subscriber copy: MEDIUM risk. Agent generates all copy, prompt rewrite handles this.
- Position monitoring (LOCK/EDGE/VALUE): CLOSED. No separate alert layer — MC Cum injected into agent narrative.
- XGB EXIT: IN SCOPE. Windowed XGB replaces cumulative, MC Cum gate added.
- PBP MC canary: NONE. Independent system. Investigation pipeline unchanged.
- BUY system: LOW. Context fields change, logic unchanged.
- NCAAMB: NONE. Separate code path, classifyRank preserved.

---

## 8. IMPLEMENTATION PLAN

**Graduation (Phases 1-10):**
Phase 1: Dead code removal (~220 lines, 7 functions + LANE_THRESHOLDS)
Phase 2: New compound function (~30 lines)
Phase 3: PO firing logic (~80 lines changed)
Phase 4: Flip PO (~30 lines)
Phase 5: Death clearing (~10 lines)
Phase 6: v2Ctx + alert INSERT (~20 lines)
Phase 7: Agent prompts (~180 -> ~40 lines) — highest risk phase
Phase 8: Post-game agent (~15 lines)
Phase 9: v3.html (~5 lines)
Phase 10: Smoke test

**EXIT Compound (Phases 11-14):**
Phase 11: checkXGBExit() — add MC Cum gate, switch to windowed XGB input (~10 lines changed)
Phase 12: EXIT call site — compute windowed features for EXIT check (~15 lines)
Phase 13: Agent prompt EXIT rules — add MC Cum context to EXIT decision (~10 lines)
Phase 14: EXIT smoke test on live game

---

## 9. CONFIRMED DEPENDENCIES

1. MC Cum available at compound check time (line 6383, checkpoints at 7065, same scope)
2. lt persisted after compound evaluation (line 7913)
3. classifyRank needed by NCAAMB — do NOT remove
4. Concurrent invocation hold under-count = expected conservative behavior

---

## 10. FILES MODIFIED

| File | Change | Est. lines |
|---|---|---|
| poll-live-bdl.mjs | Major (graduation + EXIT) | -400, +145 (net -255) |
| post-game-agent.mjs | Minor | ~15 |
| v3.html | Minor | ~5 |
| mc-backtest.mjs | backfill_mc_pbp phase (already deployed) | +367 |
| db-api.js | None | 0 |

No schema migrations. No new tables. No new env vars.

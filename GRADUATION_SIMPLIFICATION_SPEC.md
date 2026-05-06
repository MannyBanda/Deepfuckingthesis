# GRADUATION SIMPLIFICATION SPEC v2
## Replacing multi-checkpoint floor graduation with compound threshold (MC Cum + Floor)

**Date:** May 6, 2026 (v2 — production-validated)
**Status:** SPEC — awaiting confirmation before implementation
**Risk Level:** HIGH — touches agent prompts, PO firing, alert context, learning agent
**Backup:** backups/graduation-pre-simplification/ at commit daa0dbe

---

## 0. TERMINOLOGY

- **Position tracking** replaces "BWC tracking." The state where the system has identified structural control but not yet confirmed a position.
- **Position open / confirmed** = compound threshold met for 5 consecutive polls.
- **S/A/B/C ranks are retired.** Replaced by confidence tiers: TRACKING → CONFIRMED → RECOVERING → LOCKED.

---

## 1. SCOPE

**IN SCOPE:** NBA graduation path in poll-live-bdl.mjs. Agent prompts. PO firing logic. v2Ctx construction. Alert fields. Dashboard display. Learning agent graduation references.

**OUT OF SCOPE:** NCAAMB graduation (lines ~7371-7460 — separate system, unchanged). Position monitoring states (LOCK/EDGE/VALUE — separate research thread). XGB EXIT (unchanged). PBP MC canary (unchanged). BUY/PO decoupled system (unchanged). Alert routing/dedup (unchanged).

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

## 3. DEAD CODE TO REMOVE

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

## 4. PRODUCTION VALIDATION

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

## 5. CASCADING IMPLICATIONS

- Learning agent: LOW risk. Scores on terminal outcome, not tier.
- Subscriber copy: MEDIUM risk. Agent generates all copy, prompt rewrite handles this.
- Position monitoring (LOCK/EDGE/VALUE): DEFERRED to separate research thread.
- XGB EXIT: NONE. Independent system.
- PBP MC canary: NONE. Independent system.
- BUY system: LOW. Context fields change, logic unchanged.
- NCAAMB: NONE. Separate code path, classifyRank preserved.

---

## 6. IMPLEMENTATION PLAN

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

---

## 7. CONFIRMED DEPENDENCIES

1. MC Cum available at compound check time (line 6383, checkpoints at 7065, same scope)
2. lt persisted after compound evaluation (line 7913)
3. classifyRank needed by NCAAMB — do NOT remove
4. Concurrent invocation hold under-count = expected conservative behavior

---

## 8. FILES MODIFIED

| File | Change | Est. lines |
|---|---|---|
| poll-live-bdl.mjs | Major | -400, +110 (net -290) |
| post-game-agent.mjs | Minor | ~15 |
| v3.html | Minor | ~5 |
| db-api.js | None | 0 |

No schema migrations. No new tables. No new env vars.

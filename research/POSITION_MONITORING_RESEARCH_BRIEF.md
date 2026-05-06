# POSITION MONITORING RESEARCH BRIEF
## What do LOCK/EDGE/VALUE mean in compound terms?

**Date:** May 6, 2026
**Status:** QUEUED — next research thread after graduation simplification
**Prerequisite:** Graduation simplification spec v2 (commit 4466b0b)

---

## CONTEXT

The graduation simplification replaces S/A/B/C ranks with compound confidence tiers
(TRACKING/CONFIRMED/RECOVERING/LOCKED) for position OPEN decisions. But position
MONITORING — what happens AFTER a position is opened — is unchanged and still uses
the old margin+indicator-based states (LOCK/EDGE/VALUE).

These states drive subscriber alerts:
- **POSITION_SAFE** (was BWC_LOCK): team comfortably ahead, position healthy
- **LEAD COMPRESSING** (was BWC_EDGE): lead narrowing from 3+ to 1-2
- **POSITION_RECOVERING** (was VALUE→EDGE): team recovering from behind

The question: should these states use MC Cum + Floor compound instead of
margin + indicators? What MC+margin combinations predict final outcome
for already-confirmed positions?

---

## WHAT TO TEST

### 1. Post-confirmation trajectory
For each of the 48 playoff games where compound confirmed (5 holds):
- Track MC Cum + Floor + margin at EVERY subsequent poll
- What does the trajectory look like for wins vs losses?
- At what MC level does win probability cross key thresholds (90%, 80%, 70%, 50%)?

### 2. Position state definitions
Test compound-based state definitions:
- **LOCKED**: MC >= 0.85, margin >= 5 → what accuracy?
- **EDGE**: MC 0.70-0.85, margin 1-5 → accuracy?
- **DETERIORATING**: MC < 0.70 or margin negative → accuracy?
- Do these discriminate better than current margin+indicator states?

### 3. State transition alerts
When should the system alert on position changes?
- LOCKED → EDGE: MC drops from 0.85+ to 0.70-0.85
- EDGE → DETERIORATING: MC drops below 0.70
- Do these transitions predict losses early enough to act?

### 4. Interaction with PBP canary
The PBP canary already fires on collapses (11/11 playoff losses caught).
Does position monitoring add value ON TOP of the canary?
Or is the canary sufficient for EXIT while position monitoring is just
confidence communication to subscribers?

---

## DATA AVAILABLE

- 48 playoff games with backfilled MC Cum (production-equivalent, 500 sims)
- All snapshots accessible via db-api history endpoint
- Deduped snapshot data saved at /tmp/prod_mc_cum_deduped.json
- PBP MC canary results via mc-backtest validate_game endpoint
- XGB win prob on all snapshots

---

## STARTING POINT

1. Load deduped production data (already computed this session)
2. For each confirmed position, trace MC+margin through end of game
3. Classify post-confirmation snapshots by outcome
4. Find natural breakpoints in MC+margin that predict state transitions
5. Compare against current LOCK/EDGE/VALUE definitions

---

## WHAT WE ALREADY KNOW

From today's research:
- MC Cum > 0.80 + Floor > 0.65 at Q4 checkpoint level = 95.8% (all) / 86.6% (actionable margin <= 10)
- Post-confirmation, if MC stays >= 0.80: team holds
- Post-confirmation, if MC drops to 0.50-0.60: coin flip
- Post-confirmation, if MC drops below 0.50: collapse underway
- XGB EXIT at Q2-Q3 < 0.50, Q4 < 0.55 is already well-calibrated
- PBP canary catches 11/11 playoff compound losses in Q3
- MC-based EXIT is a coin flip at all thresholds — EXIT stays with XGB

The research question is NOT "should MC replace XGB for EXIT" (no).
It's "what should the agent tell the subscriber about position health
between OPEN and EXIT?"

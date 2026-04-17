# Alert System v2 — Test Harness Handoff

**Date:** April 17, 2026
**File:** `netlify/functions/test-v2-engine.mjs` (896 lines)
**HEAD:** `bb39fe0` on `main`
**Deployed:** Yes (Netlify auto-deploy)

---

## What We're Building

Alert System v2 replaces the flat alert types (BUY, BWC, LEAD LOST, etc.) with a **BWC state machine** that tracks one thesis team's structural lifecycle through LOCK → EDGE → VALUE → EXIT states. This gives subscribers a coherent game narrative instead of disconnected alert spam.

**Forcing function:** GSW@LAC 4/15 — LAC had 0.93 floor at Q4 10:23, collapsed to 0.52 by Q4 8:16, lost the game 121-126. V1 auto-analysis SENT "DOMINANT strengthening" at Q4 12:00 (reinforcing the position right before collapse). V1 had zero cash-out signals. V2 must catch this.

---

## Architecture Decisions Made This Session

**1. Single thesis team.** BWC tracks ONE team — the first to demonstrate 3+ consecutive holds at BWC-eligible conditions (floor ≥ 0.60, leading 2+, period ≥ 2). Opponent structural data enriches severity, doesn't create competing alerts. No oscillating "buy SAC.. no wait buy GSW."

**2. Directional filtering.** Transitions classified as:
- **DEGRADING** (subscriber needs to act): LOCK→EDGE (`BWC_EDGE`), EDGE→VALUE (`VALUE`), VALUE→EXIT (`EXIT`), also LOCK→VALUE, LOCK→EXIT, EDGE→EXIT
- **RECOVERING** (bet validation): EXIT→VALUE (`THESIS_ALIVE`), VALUE→EDGE (`POSITION_RECOVERING`), any→LOCK (`POSITION_SAFE`)
- **LATERAL** (noise, filtered out): same-rank transitions

**3. Material change gate.** Same-direction re-fires need: different state (always fires), OR floor delta ≥ 0.10, OR margin delta ≥ 5, OR 5+ minutes elapsed.

**4. EXIT severity.** When EXIT fires, opponent's structural profile determines urgency:
- `TEMPORARY`: opponent floor low, few holds, only I3 (variance)
- `CONCERNING`: opponent has I1 or I4 (structural) with 3+ holds
- `STRUCTURAL_TAKEOVER`: opponent floor ≥ 0.70, 5+ holds, 2+ non-I3 indicators

**5. Erosion thresholds.** Peak-relative: CAUTION at 40% edge erosion, COLLAPSE at 70%. Hysteresis: 2-snapshot minimum before returning to STABLE from elevated level.

**6. 3-hold minimum** for initial BWC fire — prevents chattering from brief control.

**7. Initial state from margin** — LOCK (≥3) or EDGE (2), not hardcoded LOCK.

---

## Test Game Set (9 games, 1,889 snapshots)

| # | Game ID | Game | Snaps | Archetype | Winner |
|---|---------|------|-------|-----------|--------|
| 1 | `ea840c07...` | GSW@LAC 4/15 | 196 | BWC → collapse → ctrl LOST | GSW |
| 2 | `460c21bf...` | POR@PHX 4/14 | 180 | BUY → ctrl flip → BWC (+700) | POR |
| 3 | `34b37d8e...` | MIA@CHA 4/14 | 219 | BUY+BWC → OT bad beat | CHA |
| 4 | `d50df249...` | ORL@PHI 4/15 | 181 | BWC → 8 LC → 11 RP → recovers | PHI |
| 5 | `7710d87d...` | GSW@SAC 4/10 | 187 | BWC → LEAD_LOST → BUY (+700) | SAC |
| 6 | `0342c2c0...` | GSW@LAC 4/12 | 204 | BWC → LEAD_LOST → ctrl recovers | LAC |
| 7 | `f98b9fa2...` | POR@DEN 4/6 | 203 | DEN dominant, OT, +700 | DEN |
| 8 | `91fec01b...` | NOP@MIN 4/12 | 157 | Clean BWC hold (wire-to-wire) | MIN |
| 9 | `7655ef88...` | DAL@SAS 4/10 | 162 | BUY only (never led, no BWC) | SAS |

---

## Test Plan & Current Status

### Test 1: BWC State Machine — ✅ PASSING (9/9)

All state classifications correct. Zero errors across 9 games.

**URL:** `.../.netlify/functions/test-v2-engine?all=true&mode=mechanical`

### Test 2: Erosion Thresholds — ✅ VALIDATED

GSW@LAC COLLAPSE fires at Q4 8:16 (floor 0.52, peak 0.93, delta -0.41). Would have gated the v1 auto-analysis "strengthening" ntfy at Q4 12:00. Known noise: same-timestamp oscillation at Q4 6:36 (data artifact from multiple snapshots at same clock — production dedup handles this).

### Test 3: Directional Alerts — ✅ VALIDATED (with known noise)

**Clean games (working as designed):**

| Game | Degrading | Recovering | Total | Notes |
|------|-----------|-----------|-------|-------|
| NOP@MIN | 1 | 2 | 3 | Perfect clean hold |
| POR@DEN | 0 | 0 | 0 | BUY-only, no BWC — correct |
| GSW@LAC 4/15 | 7 | 5 | 12 | Clear arc to EXIT |
| POR@PHX | 4 | 5 | 9 | VALUE at Q4 11:41 (+700 play) |
| ORL@PHI | 5 | 6 | 11 | Two TEMPORARY EXITs, recovered |

**Still noisy (expect agent layer to suppress):**

| Game | Degrading | Recovering | Total | Root Cause |
|------|-----------|-----------|-------|------------|
| GSW@SAC | 17 | 17 | 34 | Rapid EXIT↔VALUE in Q3 (ctrl flips every 1-2 snaps) |
| MIA@CHA | 9 | 8 | 17 | OT game, natural lead changes |
| DAL@SAS | 7 | 7 | 14 | Noisy for a 19-point blowout |

**Root cause of remaining noise:** Material change gate blocks same-state re-fires, but EXIT→VALUE→EXIT is three different states each time so each fires. A universal cooldown (3min between ANY transitions) would fix mechanically, but we're testing whether the agent layer naturally suppresses this before adding more mechanical gates.

### Test 4: Context Package Assembly — 🔄 IN PROGRESS

Context mode output verified for GSW@LAC 4/15 (12 trigger points). Data is pasted in session transcript. Each context package includes:
- Engine data (floor, margin, I1-I5, indicators won)
- Opponent profile (indicators won, I3 flag)
- Position health (peak, delta, erosion, holds, BWC lifecycle state)
- Sustainability (ctrl/opp)
- Floor trajectory (last 6 snapshots)
- Prior alert reasoning trail (compounding — last 5 v2 alerts with decisions)

**Observation:** `priorAlertTrail` compounding is working — each trigger sees the full chain of prior decisions. At EXIT (Q4 0:50), the trail shows: VALUE → BWC_EDGE → POSITION_SAFE → BWC_EDGE → POSITION_SAFE, giving the agent full lifecycle context.

**TODO:** Verify context packages on 2-3 more games before agent mode. Manny pasted GSW@LAC context results — analysis pending in next session.

### Test 5: Agent Prompt Quality — ⬜ NOT STARTED

~20-30 Opus calls across key trigger points. ~$2-4 in API cost.

Focus areas:
- VALUE triggers: does agent reason about how lead was lost and structural retention?
- EXIT triggers: does agent reference the full LOCK→EDGE→VALUE arc?
- EXIT severity: does STRUCTURAL_TAKEOVER lean harder on SEND than TEMPORARY?
- Noisy games (GSW@SAC): does agent SUPPRESS rapid-fire transitions?

**The agent prompt template** is at line 735 of the harness. It includes opponent profile, position health, erosion, BWC lifecycle, floor trajectory, and prior alert reasoning trail. Rules section covers VALUE, EXIT, BWC, BUY, and the "reasoning as journal" principle for context compounding.

### Test 6: Monitor Enrichment — ⬜ NOT STARTED (non-blocking)

Compare v1 vs v2 monitor prompts at 5-6 key moments. ~$1-2. Non-blocking for v2 ship.

### Test 7: Velocity Guard — ⬜ NOT STARTED

Verify GSW@LAC auto-analysis suppression. The critical check: at Q4 12:00, erosion is at COLLAPSE — would the agent suppress or reframe the "strengthening" position update?

---

## How to Run Tests

```
# All 9 games, mechanical only (free, deterministic)
.../test-v2-engine?all=true&mode=mechanical

# Single game with context packages ($0 — no API calls)
.../test-v2-engine?game_id=ea840c07-415b-4b90-af7b-50215fd27298&mode=context

# Single game with agent calls (~$0.50-1.00 per game)
.../test-v2-engine?game_id=ea840c07-415b-4b90-af7b-50215fd27298&mode=agent
```

Base URL: `https://poetic-starlight-aa8938.netlify.app/.netlify/functions`

---

## Key Files in Repo

| File | Lines | Role |
|------|-------|------|
| `netlify/functions/test-v2-engine.mjs` | 896 | Test harness (this work) |
| `netlify/functions/poll-live-bdl.mjs` | ~5,800+ | Production polling (v1 — will be modified for v2) |
| `TIERED_ALERT_SPEC.md` | 877 | v2 spec (needs rewrite based on test findings) |
| `netlify/functions/backtest-nba-snapshots.mjs` | ~3,300 | Phase 2 backtest engine |

---

## Immediate Next Steps

1. **Verify context packages** on 2-3 more games (POR@PHX for VALUE, GSW@SAC for noise)
2. **Run agent mode** on GSW@LAC forcing function — does agent SEND the EXIT? Does it suppress noisy recovery alerts?
3. **Run agent mode** on GSW@SAC — does agent naturally suppress the 34 transitions to ~6-8 meaningful alerts?
4. **Velocity guard test** — GSW@LAC Q4 12:00 auto-analysis with COLLAPSE erosion
5. **Decide on universal cooldown** — if agent doesn't suppress noise sufficiently, add 3min mechanical cooldown between any BWC transitions

---

## Deferred Decisions

- **Universal cooldown:** 3min between any BWC transitions regardless of state/direction. Deferred to see if agent layer handles noise naturally.
- **COLD→STALLED rename:** Agreed, deferred — touches many files.
- **Spec rewrite:** `TIERED_ALERT_SPEC.md` needs full rewrite based on test findings + new directional filtering architecture. Do after tests validate.

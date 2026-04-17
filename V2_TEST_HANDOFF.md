# Alert System v2 — Test Harness Handoff

**Date:** April 17, 2026 (updated end of session 6)
**File:** `netlify/functions/test-v2-engine.mjs` (~1,120 lines)
**HEAD:** `8b3c620` on `main`
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

## Test Game Set (9 games, 1,637 clean snapshots — 252 Sonnet-injected removed)

| # | Game ID | Game | Raw→Clean | Filtered | Archetype | Winner |
|---|---------|------|-----------|----------|-----------|--------|
| 1 | `ea840c07-415b-4b90-af7b-50215fd27298` | GSW@LAC 4/15 | 196→155 | 41 | BWC → collapse → ctrl LOST | GSW |
| 2 | `460c21bf-ca28-4318-899c-01e9e473d99e` | POR@PHX 4/14 | 180→163 | 17 | BUY → ctrl flip → BWC (+700) | POR |
| 3 | `34b37d8e-01cf-4bae-a587-0390d92c608d` | MIA@CHA 4/14 | 219→173 | 46 | BUY+BWC → OT bad beat | CHA |
| 4 | `d50df249-f9ad-4bde-aa74-598462feef58` | ORL@PHI 4/15 | 181→164 | 17 | BWC → EXIT → recovers (PHI won 109-97) | PHI |
| 5 | `7710d87d-045b-47a2-ac65-0d6986d1940c` | GSW@SAC 4/10 | 187→162 | 25 | BWC → LEAD_LOST → BUY (+700) | SAC |
| 6 | `0342c2c0-8e36-42cc-b94f-261d506a3b43` | GSW@LAC 4/12 | 204→145 | 59 | BWC → LEAD_LOST → ctrl recovers | LAC |
| 7 | `f98b9fa2-83b6-4bc5-9d2c-cb55d090fbb5` | POR@DEN 4/6 | 203→165 | 38 | DEN dominant, OT, +700 (no BWC) | DEN |
| 8 | `91fec01b-1b8b-4e04-88d5-91545b4a4822` | NOP@MIN 4/12 | 157→152 | 5 | Clean BWC hold (wire-to-wire) | MIN |
| 9 | `7655ef88-636f-4b22-9bc7-ae8c1d874ed1` | DAL@SAS 4/10 | 162→158 | 4 | BUY only (never led, no BWC) | SAS |

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

**Noise resolved by 3-min universal cooldown (shipped this session):**

| Game | Before Cooldown | After Cooldown | Notes |
|------|----------------|----------------|-------|
| GSW@SAC | 34 transitions | 12 | Q3 8:58-7:31 burst of 8 collapsed to 1 |
| MIA@CHA | 17 transitions | 8 | OT game, natural lead changes |
| DAL@SAS | 14 transitions | ~4 | Blowout noise eliminated |

**THESIS_ALIVE exempt from cooldown** — EXIT→VALUE is always a significant state change worth evaluating. Without this exemption, the +700 SAC entry at Q4 12:00 was being eaten by the Q3 0:00 EXIT cooldown.

### Test 4: Context Package Assembly — ✅ COMPLETE

Verified on 3 games: GSW@LAC 4/15, POR@PHX 4/14, GSW@SAC 4/10. Each context package includes:
- Engine data (floor, margin, I1-I5, indicators won)
- Opponent profile (indicators won, I3 flag, oppI3Won boolean)
- Position health (peak, delta, erosion, holds, BWC lifecycle state)
- BWC team identity (`bwcTeam` field — subscriber's position team)
- Sustainability (ctrl/opp)
- Floor trajectory (last 6 snapshots)
- Prior alert reasoning trail (compounding — last 5 v2 alerts with decisions)

`trigger_idx` param added for single-trigger agent testing (avoids Netlify timeout).
Usage: `?game_id=X&mode=agent&trigger_idx=N`

### Test 5: Agent Prompt Quality — ✅ VALIDATED (41/41 triggers, 0 wrong)

**Sessions 1-3 commits (7 total):**

1. `e038fd4` — Bump max_tokens 500→600
2. `4ca9f41` — Add score line to agent prompt (away-home with team side label)
3. `9d9579c` — Filter Sonnet-injected snapshots (no raw_stats_json); document bug
4. `1ef0a6a` — BUY: lower threshold to 0.55 (CANDIDATE), remove BWC restriction, add clock gate, add buyTier
5. `aa57e24` — Add 3-min BUY cooldown to reduce trigger noise
6. `e9c3dec` — BUY/VALUE sweet spot: 1-7 (was 1-4) in agent prompt

**Agent Scorecard (31 triggers across 6 games, 0 wrong):**

| Game | Trigger | Decision | Correct? | Notes |
|------|---------|----------|----------|-------|
| GSW@LAC 4/15 | BWC_EDGE Q2 9:41 | SEND | ✅ | Position update with RISK line |
| GSW@LAC 4/15 | EXIT Q4 0:50 | SEND | ✅ | References LAC as subscriber position |
| GSW@SAC | BUY CAND Q2 11:48 (GSW) | SUPPRESS | ✅ | GSW only I3, opp has I1, COLLAPSE erosion |
| GSW@SAC | BUY FIRED Q2 10:44 (GSW) | SUPPRESS | ✅ | GSW I2+I3 variance-driven, TP NO PATH |
| GSW@SAC | POSITION_SAFE Q3 7:59 | SEND | ✅ | Prior RISK didn't materialize, 4/5 indicators |
| GSW@SAC | BWC_EDGE Q3 8:58 | SEND | ✅ | RISK: FRAGILE sust flagged |
| GSW@SAC | BWC_EDGE Q3 6:17 | SEND | ✅ | Prior RISK materialized (FRAGILE→MIXED) |
| GSW@SAC | BWC_EDGE Q3 3:37 | SEND | ✅ | RISK: I1 flip concern |
| GSW@SAC | THESIS_ALIVE Q3 2:25 | SEND | ✅ | I1+I4+I5, trailing 1 |
| GSW@SAC | POSITION_RECOVERING Q3 1:43 | SEND | ✅ | Recovery validated |
| GSW@SAC | BUY CAND Q4 12:00 (SAC) | SEND | ✅ | **+700 money shot** — I1+I4, BWC lifecycle |
| GSW@SAC | THESIS_ALIVE Q4 8:56 | SEND | ✅ | I1+I4, STRONG RECOVERY |
| GSW@SAC | POSITION_RECOVERING Q4 6:16 | SEND | ✅ | Lead retaken |
| GSW@SAC | BWC_EDGE Q4 4:28 | SEND | ✅ | Holding 106-104 |
| GSW@SAC | BWC_EDGE Q4 1:46 | SEND | ✅ | Closing chapter, SAC wins |
| POR@PHX | VALUE Q4 11:41 | SEND | ✅ | Textbook — floor 0.95, 4/5 indicators |
| POR@DEN | BUY Q2 10:52 | SEND | ✅ | DEN won at +700, oppI3 thesis |
| POR@DEN | BUY Q4 10:02 | SUPPRESS | ✅ | Trailing 15, opp DURABLE, TP CONTESTED |
| POR@DEN | BUY Q4 4:19 | SUPPRESS | ✅ | Trailing 9, TP UNLIKELY, "cold BUY" |
| POR@DEN | BUY Q4 10:02 (re-test) | SUPPRESS | ✅ | Confirmed after 1-7 sweet spot update |
| POR@DEN | BUY Q4 4:19 (re-test) | SUPPRESS | ✅ | Confirmed — no material change |
| MIA@CHA | BUY Q2 5:53 (CHA) | SUPPRESS | ✅ | CHA only 1/5, COLD sust |
| MIA@CHA | THESIS_ALIVE Q4 9:51 | SUPPRESS | ✅ | I4 lost, structural core broken |
| MIA@CHA | VALUE Q4 4:27 | SEND | ✅ | Bad beat — 4/5 indicators, lost OT by 1 |
| ORL@PHI | EXIT Q2 5:42 | SEND | ✅ | TEMPORARY — PHI recovered, correct at decision time |
| **Total** | **31 triggers** | **0 wrong** | **✅** | **6 games, every archetype covered** |

**Session 6 — Sequential Compounding (GSW@SAC full arc with trend signals):**

| Game | Trigger | Decision | Correct? | Refs Trends? |
|------|---------|----------|----------|-------------|
| GSW@SAC | BUY CAND Q2 11:48 (GSW) | SUPPRESS | ✅ | No |
| GSW@SAC | BUY FIRED Q2 10:44 (GSW) | SUPPRESS | ✅ | No |
| GSW@SAC | BUY CAND Q2 8:52 (GSW) | SUPPRESS | ✅ | Yes (FALLING) |
| GSW@SAC | BWC_EDGE Q3 8:58 | SEND | ✅ | No |
| GSW@SAC | POSITION_SAFE Q3 7:59 | SEND | ✅ | No |
| GSW@SAC | BWC_EDGE Q3 6:17 | SEND | ✅ | No |
| GSW@SAC | BWC_EDGE Q3 3:37 | SEND | ✅ | No |
| GSW@SAC | BUY FIRED Q3 2:31 (SAC warm) | SEND | ✅ | No |
| GSW@SAC | POSITION_RECOVERING Q3 1:43 | SEND | ✅ | No |
| GSW@SAC | **BUY CAND Q4 12:00 (+700)** | **SEND** | **✅** | **Yes (CONVERGING)** |
| **Total** | **10 triggers** | **0 wrong** | **✅** | **2/10 referenced, 0 load-bearing** |

**Cumulative: 41/41 correct across sessions 1-6 (0 wrong decisions).**

**Archetypes validated:**
- BWC → collapse → EXIT (GSW@LAC 4/15) ✅
- BWC → LEAD_LOST → BUY +700 (GSW@SAC) ✅ — full 15-trigger chain
- BWC → EXIT → recovers (ORL@PHI) ✅
- BWC → OT bad beat (MIA@CHA) ✅
- BUY-only, no BWC (POR@DEN) ✅ — "cold BUY" vs "warm BUY" distinction emerged
- BUY → ctrl flip → BWC +700 (POR@PHX) ✅

**Not agent-tested (low priority — mechanical passing, archetypes covered):**
- NOP@MIN: clean hold (1 BWC_EDGE, no stress)
- DAL@SAS: blowout (BWC EDGE/VALUE cycling, SAS won by 19+)
- GSW@LAC 4/12: BWC → LEAD_LOST → recovers (similar to ORL@PHI)

### Test 6: Monitor / Trend Signal Validation — ✅ RESOLVED (monitor killed)

Tested whether monitor agent or inline trend signals (momentum, sustArc, floorMarginRel) improve agent decisions. GSW@SAC full arc: 14 triggers, 10 tested with sequential compounding via `test_decisions` table. **0 decisions changed from baseline.** Trend signals referenced 2/10 times (reinforcing only, never load-bearing). Agent reads what it needs from indicators + erosion + floor trajectory + prior trail.

**Commits (8 total, session 6):**
1. `bc82e92` — Test 6: Monitor enrichment A/B (`computeMonitorContext`, `&monitor=true`)
2. `001eddc` — Fix: thread `useMonitor` through BWC transition code path
3. `c5d3981` — Refactor: inline trend signals, kill separate monitor path (-51 lines)
4. `8eb69ca` — Add momentum back to inline trend signals
5. `6b2c300`→`f8d217c`→`42d76b1` — Dedup stale polls, window 6 deduped, raw 40
6. `0b4b680` — Trigger range batching (`trigger_idx=0-6`)
7. `2f2bb5c` — Sequential compounding via `test_decisions` table
8. `7e0ce3a` — Fix clock comparison (numeric, not string)

**Verdict:** Kill monitor. Do NOT wire trend signals to production. Two-layer authority (engine + agent).

### Test 7: Velocity Guard — ⬜ NOT STARTED

Verify GSW@LAC auto-analysis suppression. The critical check: at Q4 12:00, erosion is at COLLAPSE — would the agent suppress or reframe the "strengthening" position update?

---

## How to Run Tests

```
# All 9 games, mechanical only (free, deterministic)
.../test-v2-engine?all=true&mode=mechanical

# Single game with context packages ($0 — no API calls)
.../test-v2-engine?game_id=7710d87d-045b-47a2-ac65-0d6986d1940c&mode=context

# Single game, all agent triggers (~$0.50-1.00 per game, may timeout)
.../test-v2-engine?game_id=7710d87d-045b-47a2-ac65-0d6986d1940c&mode=agent

# Single trigger agent test (recommended — avoids timeout)
.../test-v2-engine?game_id=7710d87d-045b-47a2-ac65-0d6986d1940c&mode=agent&trigger_idx=10

# trigger_idx=0 with mode=agent returns availableTriggers list with indices
```

Base URL: `https://poetic-starlight-aa8938.netlify.app/.netlify/functions`

---

## Key Files in Repo

| File | Lines | Role |
|------|-------|------|
| `netlify/functions/test-v2-engine.mjs` | ~1,120 | Test harness (sessions 1-6) |
| `netlify/functions/poll-live-bdl.mjs` | ~5,800+ | Production polling (v1 — will be modified for v2) |
| `V2_AGENT_RULES.md` | ~256 | **Canonical agent rules — single source of truth** |
| `V2_TEST_HANDOFF.md` | — | This document (test plan + results) |
| `TIERED_ALERT_SPEC.md` | 877 | Old v2 spec (needs full rewrite from agent rules) |
| `netlify/functions/backtest-nba-snapshots.mjs` | ~3,300 | Phase 2 backtest engine |

---

## Immediate Next Steps (Session 7)

1. **Write finalized spec.** `TIERED_ALERT_SPEC.md` full rewrite from V2_AGENT_RULES.md + test results (41/41). This is the build blueprint.
2. **Wire v2 to production.** Agent prompt validated — replace v1 alert agent in `poll-live-bdl.mjs`. Main deliverable.
3. **Sonnet snapshot injection — production fix.** Trace where in `poll-live-bdl.mjs` auto-analysis writes to snapshots table and stop it. 252 contaminated snapshots (13.3%).
4. **Deprecate monitor agent.** Remove monitor Sonnet calls from poll loop, `gatherAgentContext`, `formatSonnetPrompt`. Keep `monitor_observations` table for now (historical data).
5. **POR@DEN BUY noise.** 13 BUY triggers in no-BWC game. Low priority — agent suppresses correctly.
6. **Test 7: Velocity guard.** GSW@LAC Q4 12:00 auto-analysis with COLLAPSE erosion.

---

## Architecture Decisions Made This Session (Session 2)

**8. Universal 3-min cooldown.** All BWC transitions cooldown-gated. `lastAnyBwcTs` tracks last fire. Prevents trail pollution from rapid ctrl oscillation (GSW@SAC Q3: 34→12 transitions). Applied BEFORE `shouldFire` check.

**9. THESIS_ALIVE cooldown exemption.** EXIT→VALUE always significant — bypasses cooldown. Without this, +700 SAC entry at Q4 12:00 was eaten by Q3 0:00 EXIT cooldown.

**10. BWC_EDGE = always SEND with RISK.** Position update for subscribers already holding. Must include specific forward-looking RISK concern. Subsequent alerts reference whether prior RISK materialized. Creates compounding risk register across alert chain.

**11. BUY coexists with lifecycle.** BUY fires for structurally dominant teams trailing with NO prior BWC. After BWC fires, everything shifts to lifecycle alerts (VALUE, EXIT, THESIS_ALIVE). Both systems serve different game states cleanly.

---

## Architecture Decisions Made Session 3

**12. Sonnet snapshot filter.** Auto-analysis at quarter boundaries injects Sonnet-assigned indicator scores as snapshot rows (no `raw_stats_json`). 252 contaminated (13.3%). Test harness filters `WHERE raw_stats_json IS NOT NULL`. Production fix pending.

**13. BUY fires for BWC team.** Removed `!isBwcGame` guard. BUY identifies entry/re-entry for ANY structurally dominant team trailing. Forcing function: GSW@SAC Q4 12:00 +700 money shot was blocked by old guard.

**14. BUY threshold 0.55 (CANDIDATE).** Lowered from 0.65 FIRED-only. CANDIDATE tier (0.55-0.65) gives agent visibility.

**15. 3-min BUY cooldown.** `lastBuyTs` tracks last BUY fire. GSW@SAC Q2 noise: 10→5 triggers.

**16. Score line in agent prompt.** Explicit `Score: GSW 78 - SAC 77 (SAC is HOME)` — fixed agent score misreads.

**17. BUY/VALUE sweet spot 1-7.** Extended from 1-4. Agent guidance, not hard gate. Mechanical gate remains at -15.

**18. "Cold BUY" vs "warm BUY".** Agent independently discovered: BUY with BWC lifecycle = "warm" (thesis history). BUY with no BWC = "cold" (unproven, higher bar).

---

## Architecture Decisions Made Session 6

**19. Kill the monitor agent.** The separate Sonnet-based monitor (narrating game state every 3 polls to `monitor_observations` table) is dead. Its three unique signals (momentum, sust arc, floor-margin relationship) are mechanical computations on snapshot data — they don't require Sonnet. Tested as inline trend signals; proven redundant. 0/10 decisions changed.

**20. Two-layer authority.** Was three-layer (engine → monitor → agent). Now two-layer (engine → agent). Engine computes I1-I5, floor, erosion, BWC state, conviction. Agent (Opus) decides SEND/SUPPRESS from engine output + floor trajectory + prior trail.

**21. Sequential compounding via DB.** `test_decisions` table stores agent decisions across requests (PRIMARY KEY game_id, trigger_idx, monitor). Each trigger loads all prior stored decisions, injects into priorAlertTrail with real reasoning. Produces richer body text but same decisions as isolated tests.

**22. Snapshot dedup for trend signals.** Pull 40 raw snapshots, dedup consecutive same-period+clock entries, take last 6 unique. Halftime alone generates ~28 stale polls at same clock — must widen raw window and dedup. (Moot for production since trend signals not being wired, but pattern documented for future snapshot windowing.)

**23. Clock comparison must be numeric.** `parseClockSecs()` required — string comparison of clocks is wrong ("6:58" > "10:44" lexicographically). Bug caused SAC's BWC fire at Q2 6:58 to leak into Q2 10:44 trail as "prior" alert. Fixed with numeric seconds conversion.

---

## Deferred Decisions

- **COLD→STALLED rename:** Agreed, deferred — touches many files.
- **Spec rewrite:** `TIERED_ALERT_SPEC.md` needs full rewrite based on test findings + V2_AGENT_RULES.md. Priority for session 7.
- ~~**Monitor as veto authority:** Monitor must earn trust from live data before being given override power.~~ **KILLED (Test 6).** Monitor proven redundant — 0 decisions changed. Two-layer authority (engine + agent). Do not wire to production.

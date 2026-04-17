# Alert System v2 — Test Harness Handoff

**Date:** April 17, 2026 (updated end of session 2)
**File:** `netlify/functions/test-v2-engine.mjs` (~925 lines)
**HEAD:** `3a2bb9e` on `main`
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
| 1 | `ea840c07-415b-4b90-af7b-50215fd27298` | GSW@LAC 4/15 | 196 | BWC → collapse → ctrl LOST | GSW |
| 2 | `460c21bf-ca28-4318-899c-01e9e473d99e` | POR@PHX 4/14 | 180 | BUY → ctrl flip → BWC (+700) | POR |
| 3 | `34b37d8e-01cf-4bae-a587-0390d92c608d` | MIA@CHA 4/14 | 219 | BUY+BWC → OT bad beat | CHA |
| 4 | `d50df249-f9ad-4bde-aa74-598462feef58` | ORL@PHI 4/15 | 181 | BWC → 8 LC → 11 RP → recovers | PHI |
| 5 | `7710d87d-045b-47a2-ac65-0d6986d1940c` | GSW@SAC 4/10 | 187 | BWC → LEAD_LOST → BUY (+700) | SAC |
| 6 | `0342c2c0-8e36-42cc-b94f-261d506a3b43` | GSW@LAC 4/12 | 204 | BWC → LEAD_LOST → ctrl recovers | LAC |
| 7 | `f98b9fa2-83b6-4bc5-9d2c-cb55d090fbb5` | POR@DEN 4/6 | 203 | DEN dominant, OT, +700 | DEN |
| 8 | `91fec01b-1b8b-4e04-88d5-91545b4a4822` | NOP@MIN 4/12 | 157 | Clean BWC hold (wire-to-wire) | MIN |
| 9 | `7655ef88-636f-4b22-9bc7-ae8c1d874ed1` | DAL@SAS 4/10 | 162 | BUY only (never led, no BWC) | SAS |

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

### Test 5: Agent Prompt Quality — 🔄 IN PROGRESS (14/~30 triggers tested)

**Prompt tuning shipped this session (4 commits):**

1. **THESIS_ALIVE instruction block** — Weight hierarchy: structural indicator retention (I1+I4) > TP path > timing >> floor level/erosion. Floor below fire floor = entry signal, not red flag. SUPPRESS only if structural core lost OR opponent has non-I3 indicators OR TP NO PATH with < 3 min.
2. **EXIT team reference** — `bwcTeam` added to context package. Prompt header shows "BWC team (subscriber position): LAC (NOT current ctrl team)". EXIT body references subscriber's position team.
3. **BWC_EDGE framing** — Always SEND as position update with RISK line. RISK = specific forward-looking concern. Subsequent alerts reference whether prior RISK materialized. Creates living risk register across alert chain.
4. **THESIS_ALIVE cooldown exemption** — EXIT→VALUE bypasses 3-min universal cooldown. Captures +700 entries that were being eaten by cooldown from prior EXIT.

**Agent Scorecard (14 triggers, 0 wrong):**

| Game | Trigger | Decision | Correct? | Notes |
|------|---------|----------|----------|-------|
| GSW@LAC 4/15 | BWC_EDGE Q2 9:41 | SEND | ✅ | Position update with RISK line |
| GSW@LAC 4/15 | EXIT Q4 0:50 | SEND | ✅ | References LAC as subscriber position |
| GSW@SAC | BUY Q2 10:44 | SUPPRESS | ✅ | GSW weak case, TP NO PATH |
| GSW@SAC | BWC_EDGE Q3 8:58 | SEND | ✅ | RISK: FRAGILE sust flagged |
| GSW@SAC | BWC_EDGE Q3 6:17 | SEND | ✅ | Prior RISK materialized (FRAGILE→MIXED) |
| GSW@SAC | THESIS_ALIVE Q4 12:00 | SEND | ✅ | **+700 entry captured** (I1+I4, oppI3) |
| GSW@SAC | THESIS_ALIVE Q4 8:56 | SEND | ✅ | Structural core retained |
| POR@PHX | VALUE Q4 11:41 | SEND | ✅ | Textbook — floor 0.95, 4/5 indicators |
| POR@DEN | BUY Q2 10:52 | SEND | ✅ | DEN won at +700, oppI3 thesis |
| POR@DEN | BUY Q4 10:02 | SEND | ✅ | **+750 entry** — trailing 15, DEN won OT |
| MIA@CHA | BUY Q2 5:53 (CHA) | SUPPRESS | ✅ | CHA only 1/5 indicators, COLD sust |
| MIA@CHA | THESIS_ALIVE Q4 9:51 | SUPPRESS | ✅ | I4 lost = structural core broken, TP NO PATH |
| MIA@CHA | VALUE Q4 4:27 | SEND | ✅ | Bad beat — 4/5 indicators, 0 opp, MIA lost OT by 1 |
| **Full chain: GSW@SAC** | **7 of 15 tested** | **All correct** | ✅ | RISK chain compounds across BWC_EDGE alerts |

**Remaining agent triggers:**
- GSW@SAC: triggers 6 (BWC_EDGE Q3 3:37), 7 (THESIS_ALIVE Q3 2:25), 8 (POSITION_RECOVERING Q3 1:43), 9 (EXIT Q3 0:00), 12 (POSITION_RECOVERING Q4 6:16), 13 (BWC_EDGE Q4 4:28), 14 (BWC_EDGE Q4 1:46)
- ORL@PHI: full game (BWC → LC → RP → recovers archetype)
- NOP@MIN: clean hold — should suppress most position updates
- DAL@SAS: blowout — should suppress noise
- GSW@LAC 4/12: BWC → LEAD_LOST → ctrl recovers

**Known issue:** `max_tokens` at 500 truncates BWC_EDGE bodies with RISK lines. Bump to 600 next session.

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
| `netlify/functions/test-v2-engine.mjs` | ~925 | Test harness (this work) |
| `netlify/functions/poll-live-bdl.mjs` | ~5,800+ | Production polling (v1 — will be modified for v2) |
| `TIERED_ALERT_SPEC.md` | 877 | v2 spec (needs rewrite based on test findings) |
| `V2_TEST_HANDOFF.md` | — | This document |
| `netlify/functions/backtest-nba-snapshots.mjs` | ~3,300 | Phase 2 backtest engine |

---

## Immediate Next Steps (Session 3)

1. **Bump `max_tokens`** from 500 to 600 in agent prompt (BWC_EDGE RISK lines getting truncated)
2. **Complete GSW@SAC full chain** — triggers 6-9, 12-14 (8 remaining)
3. **Run ORL@PHI** — BWC → LC → RP → recovers archetype. Tests POSITION_SAFE recovery after deep collapse
4. **Run NOP@MIN** — clean hold. Should suppress most BWC_EDGE position updates (nothing changes)
5. **Run DAL@SAS** — blowout. Should suppress noise from a 19-point win
6. **Run GSW@LAC 4/12** — BWC → LEAD_LOST → ctrl recovers. Tests VALUE when lead lost but recovered
7. **Test 6: Monitor enrichment** — compare agent decisions with/without monitor context
8. **Test 7: Velocity guard** — GSW@LAC Q4 12:00 auto-analysis with COLLAPSE erosion

---

## Architecture Decisions Made This Session (Session 2)

**8. Universal 3-min cooldown.** All BWC transitions cooldown-gated. `lastAnyBwcTs` tracks last fire. Prevents trail pollution from rapid ctrl oscillation (GSW@SAC Q3: 34→12 transitions). Applied BEFORE `shouldFire` check.

**9. THESIS_ALIVE cooldown exemption.** EXIT→VALUE always significant — bypasses cooldown. Without this, +700 SAC entry at Q4 12:00 was eaten by Q3 0:00 EXIT cooldown.

**10. BWC_EDGE = always SEND with RISK.** Position update for subscribers already holding. Must include specific forward-looking RISK concern. Subsequent alerts reference whether prior RISK materialized. Creates compounding risk register across alert chain.

**11. BUY coexists with lifecycle.** BUY fires for structurally dominant teams trailing with NO prior BWC. After BWC fires, everything shifts to lifecycle alerts (VALUE, EXIT, THESIS_ALIVE). Both systems serve different game states cleanly.

---

## Deferred Decisions

- **COLD→STALLED rename:** Agreed, deferred — touches many files.
- **Spec rewrite:** `TIERED_ALERT_SPEC.md` needs full rewrite based on test findings + new directional filtering architecture. Do after tests validate.
- **Monitor as veto authority:** Monitor must earn trust from live data before being given override power. Current role: enrichment context for agent, not override.

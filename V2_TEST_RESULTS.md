# V2 Alert Engine — Test Harness Results

**Date:** April 17, 2026 (sessions 1-6)
**Harness:** `netlify/functions/test-v2-engine.mjs` (~1,120 lines)
**Data:** 9 games, 1,637 clean snapshots (252 Sonnet-injected filtered)
**Scorecard:** 9/9 mechanical, 41/41 agent decisions correct (0 wrong)

---

## 1. Overall Scorecard

### Mechanical Engine: 9/9 (100%)

BWC state machine, erosion detection, directional filtering, trigger generation, context package assembly — zero errors across all 9 test games.

### Agent Decisions: 41/41 (100%)

| Game | Archetype | Agent Triggers | Correct | Key Decision |
|------|-----------|---------------|---------|--------------|
| GSW@SAC 4/10 | BWC→LEAD_LOST→BUY(+700) | 10* | 10/10 | Money shot SEND at +700 |
| POR@PHX 4/14 | BUY→ctrl flip→BWC(+700) | 3 | 3/3 | VALUE SEND at 0.95 floor |
| MIA@CHA 4/14 | BWC→EXIT→OT bad beat | 6 | 6/6 | THESIS_ALIVE SUPPRESS (I4 lost) |
| ORL@PHI 4/15 | BWC→EXIT→recovers | 7 | 7/7 | EXIT TEMPORARY correct |
| GSW@LAC 4/15 | BWC→collapse→ctrl LOST | 7 | 7/7 | EXIT catches collapse |
| POR@DEN 4/6 | No BWC (BUY only) | 8 | 8/8 | All cold BUYs suppressed |
| **Total** | | **41** | **41/41** | |

*GSW@SAC: 10 of 14 tested with full sequential compounding; remaining 4 are BWC_EDGE/POSITION_RECOVERING in Q4 (SEND-by-rule, not agent-discretionary).

### Monitor/Trend Signals: NOT NEEDED

- Baseline without signals: 31/31 (sessions 1-3)
- With trend signals + compounding: 10/10 (session 6)
- Decisions changed: **0**
- **Verdict: Kill monitor, do not wire trend signals.**

---

## 2. Test Game Set

| # | Game | Snaps | Archetype | BWC Team | Winner | v1 Alerts |
|---|------|-------|-----------|----------|--------|-----------|
| 1 | GSW@LAC 4/15 | 155 | BWC → collapse → ctrl LOST | LAC | GSW | 0 (missed collapse) |
| 2 | POR@PHX 4/14 | 163 | BUY → ctrl flip → BWC (+700) | POR | POR | — |
| 3 | MIA@CHA 4/14 | 173 | BUY+BWC → OT bad beat | MIA | CHA | — |
| 4 | ORL@PHI 4/15 | 164 | BWC → EXIT → recovers | PHI | PHI | — |
| 5 | GSW@SAC 4/10 | 162 | BWC → LEAD_LOST → BUY (+700) | SAC | SAC | 9 alerts |
| 6 | GSW@LAC 4/12 | 145 | BWC → LEAD_LOST → recovers | LAC | LAC | — |
| 7 | POR@DEN 4/6 | 165 | DEN dominant, OT, +700 (no BWC) | none | DEN | — |
| 8 | NOP@MIN 4/12 | 152 | Clean BWC hold (wire-to-wire) | MIN | MIN | — |
| 9 | DAL@SAS 4/10 | 158 | BUY only (never led, no BWC) | none | SAS | — |

**Critical data quality note:** 252 snapshots (13.3%) were Sonnet-injected — auto-analysis at quarter boundaries wrote indicator scores as snapshot rows with NO `raw_stats_json`. Filtered from all test results. Worst: GSW@LAC 4/12 at 59 (29%). Production fix pending.

---

## 3. Mechanical Engine Findings

### 3a. BWC State Machine

All 9 games classify correctly. State sequences match expected archetypes:

**GSW@SAC (the reference game):**
- BWC fires Q2 6:58 (SAC, floor 0.68, margin 6)
- State sequence: EDGE → LOCK → EDGE → EDGE → EDGE → VALUE → EDGE → EDGE → EDGE
- 9 transitions, 162 snapshots, 0 errors

**GSW@LAC 4/15 (the forcing function):**
- LAC had 0.93 floor at Q4 10:23, crashed to 0.52 by Q4 8:16
- v1 auto-analysis sent "DOMINANT strengthening" at Q4 12:00 — reinforcing position right before collapse
- v2 erosion detection fires COLLAPSE, EXIT fires correctly

**NOP@MIN (clean hold):**
- Wire-to-wire dominance, minimal transitions, no stress — validates quiet games don't generate noise

**POR@DEN (no BWC):**
- Team never led → no BWC fires → BUY-only triggers. Validates that BWC correctly doesn't fire for non-leading teams.

### 3b. Erosion Detection

Peak-relative thresholds: CAUTION at 20% × peak, COLLAPSE at 35% × peak.

**GSW@SAC erosion arc:**
```
Q2 1:59  STABLE → CAUTION  (floor 0.68, peak 0.86, delta -0.180)
Q2 0:33  CAUTION → STABLE  (floor 0.76, recovered)
Q2 0:00  STABLE → CAUTION  (floor 0.71, halftime dip)
Q3 10:35 CAUTION → STABLE  (floor 0.77, Q3 start recovery)
Q3 0:24  STABLE → COLLAPSE (floor 0.60, delta -0.260 — end-of-Q3 run)
Q4 6:48  COLLAPSE → CAUTION (floor 0.65, partial recovery)
Q4 0:46  CAUTION → STABLE  (floor 0.73, SAC closes out)
```

This arc is the textbook case: early-game stability, mid-game CAUTION oscillation, late-Q3 COLLAPSE when opponent runs, Q4 recovery. The erosion levels correctly track the structural degradation and recovery.

**GSW@LAC 4/15 (the $1,300 loss game):**
- COLLAPSE fires at Q4 8:16 (floor 0.52, peak 0.93, delta -0.41)
- v1 had zero mechanism to detect this
- v2 erosion would have fired EXIT + COLLAPSE, giving subscriber a cash-out signal

### 3c. Directional Filtering & Cooldown

**Before cooldown (raw transitions):**

| Game | Transitions | Notes |
|------|------------|-------|
| GSW@SAC | 34 | Q3 8:58-7:31 burst of 8 in <90 seconds |
| MIA@CHA | 17 | OT game, natural lead changes |
| DAL@SAS | 14 | Blowout noise |

**After 3-min universal cooldown:**

| Game | Transitions | Reduction | Meaningful signals lost |
|------|------------|-----------|----------------------|
| GSW@SAC | 12 | 65% | 0 |
| MIA@CHA | 8 | 53% | 0 |
| DAL@SAS | ~4 | 71% | 0 |

**THESIS_ALIVE cooldown exemption validated:** Without exemption, GSW@SAC Q4 12:00 +700 money shot was eaten by Q3 0:00 EXIT cooldown (180s gap). With exemption, EXIT→VALUE always fires — this is the most important signal in the system.

### 3d. BUY Trigger Generation

**GSW@SAC BUY triggers (5 total):**

| Time | Tier | Margin | Floor | Opp Indicators | BWC Match | Correct? |
|------|------|--------|-------|----------------|-----------|----------|
| Q2 11:48 | CANDIDATE | -5 | 0.55 | I1 | NO | SUPPRESS ✅ |
| Q2 10:44 | FIRED | -3 | 0.68 | none | NO | SUPPRESS ✅ |
| Q2 8:52 | CANDIDATE | -1 | 0.63 | I1 | NO | SUPPRESS ✅ |
| Q3 2:31 | FIRED | -1 | 0.73 | I3 | YES | SEND ✅ |
| Q4 12:00 | CANDIDATE | -7 | 0.60 | I3 | YES | SEND ✅ |

Pattern: Q2 BUYs all correctly suppressed (wrong-side, GSW is not the structural team). Q3 and Q4 BUYs correctly sent (SAC is BWC team, warm BUY with lifecycle context).

**POR@DEN BUY triggers (13 total, no BWC):**
All cold BUYs — no BWC lifecycle context. 8 tested, all correctly suppressed except POR@DEN Q2 10:52 (SEND — DEN won at +700, oppI3 thesis). Known noise: 13 triggers in a no-BWC game may need tighter mechanical gating.

---

## 4. Agent Decision Patterns

### 4a. BUY: "Cold" vs "Warm" Distinction

The agent independently discovered and consistently applied different evaluation standards:

**Cold BUY (no BWC lifecycle):**
- No prior position history. Agent applies higher bar.
- Example: POR@DEN Q4 10:02 — DEN FIRED, trailing 15, floor 0.70. Agent SUPPRESS: "outside sweet spot, opponent DURABLE, no BWC lifecycle to leverage — cold BUY with no thesis history."
- Example: POR@DEN Q4 4:19 — DEN FIRED, trailing 9, TP UNLIKELY. Agent SUPPRESS: "cold BUY, no structural narrative established."

**Warm BUY (BWC team trailing, bwcTeamMatch: YES):**
- Full lifecycle context available. Agent references BWC fire floor, prior alerts, thesis arc.
- Example: GSW@SAC Q3 2:31 — SAC FIRED, trailing 1, floor 0.73 (above BWC fire 0.68). Agent SEND: "VALUE thesis firing cleanly — prior BWC_EDGE alerts confirmed structural control through lead compression."
- Example: GSW@SAC Q4 12:00 — SAC CANDIDATE, trailing 7, floor 0.60. Agent SEND: "SAC VALUE BUY — trailing 82-89 entering Q4 at home. BWC fired Q2 at 0.68, peak 0.86. I1+I4 retained. This is the classic VALUE setup."

### 4b. Wrong-Side BUY Suppression

Three GSW BUYs at Q2 11:48/10:44/8:52 — GSW had mechanical floor control but SAC was the structurally dominant team (SAC held I1 Disruption, would fire BWC 5 minutes later).

Agent reasoning on Q2 10:44: "GSW trailing by 3 with I2+I3 only. No BWC lifecycle, no disruption or game control indicators. TP NO PATH. The structural picture does not support a buy — GSW's edge is variance (shot quality), not process."

This is the agent correctly distinguishing between the floor holder (GSW temporarily) and the structurally dominant team (SAC). The `bwcTeamMatch: NO` flag was key context.

### 4c. BWC_EDGE RISK Chain (Compounding)

Each BWC_EDGE body ends with a RISK line. Subsequent alerts reference whether prior risks materialized:

**GSW@SAC Q3 arc (triggers 3→4→5→6):**

```
Trigger 3 (Q3 8:58, BWC_EDGE):
  Body: "SAC position update — lead trimmed from 6 to 2..."
  RISK: "Floor dropped 0.06 from 0.86 peak — if GSW converts this 
         scoring run into a lead change, watch whether I1 or I4 flip."

Trigger 4 (Q3 7:59, POSITION_SAFE):
  Body: "The floor erosion flagged in the last update has stabilized 
         at 0.80 — the dip from 0.86 didn't accelerate into collapse."
  RISK: "Floor-margin divergence means SAC's process metrics are 
         slightly softer than the scoreboard suggests."

Trigger 5 (Q3 6:17, BWC_EDGE):
  Body: "Floor has dipped from 0.80 to 0.73... the lead compression 
         flagged as a risk in the prior alert is showing up."
  RISK: "Floor has fallen 0.13 from peak. If GSW takes the lead 
         and I1 or I4 flip, the structural thesis erodes."

Trigger 6 (Q3 3:37, BWC_EDGE):
  Body: "The lead that was 6 at BWC fire has compressed, but the 
         engine that built it remains intact."
  RISK: "Margin is now 1 — if GSW takes the lead, watch whether 
         SAC's I4 Game Control flips."
```

Each alert references the prior RISK, reports whether it materialized, and flags the next concern. This creates a living risk register that a subscriber (Manny's brother) can follow on ntfy without needing the dashboard.

### 4d. THESIS_ALIVE: Floor ≠ Red Flag

The most nuanced agent behavior: at THESIS_ALIVE (EXIT→VALUE), the floor is at its lowest point — that's the ENTRY SIGNAL, not a warning.

**GSW@SAC Q4 12:00 (the money shot):**
- Floor: 0.60 (peak was 0.86, COLLAPSE erosion)
- Margin: -7 (SAC trailing 82-89)
- BWC state: VALUE
- I1+I4 retained, oppI3Won=true
- TP: CONTESTED

Agent SEND reasoning: "SAC retains structural core I1+I4. Opponent's only won indicator is I3 — variance-based. COLLAPSE erosion and -7 deficit are WHY plus-money exists. The structural reason the lead existed has not changed."

Body includes honest risk: "This is a higher-risk VALUE entry than typical — the structural thesis is intact but the margin for error has narrowed considerably. RISK: If SAC loses I4 or opponent upgrades from DURABLE to LOCKED IN, this becomes an EXIT."

**Contrast with MIA@CHA THESIS_ALIVE (correctly suppressed):**
- I4 lost (structural core broken)
- TP: NO PATH
- Agent SUPPRESS: "I4 Game Control flipped to opponent. Without I4, the structural thesis that built the position is gone."

### 4e. EXIT: Team Identity Matters

**GSW@LAC trigger 6 (EXIT):**
Early testing revealed the agent could confuse which team the subscriber holds. Body must explicitly name the BWC team.

Correct body: "LAC position — your structural edge is gone. GSW has taken over I2+I3+I1. The thesis that built LAC's lead has dissolved."

The `bwcTeam` field in the context package was the fix — agent always knows the subscriber's team.

**ORL@PHI Q2 5:42 (EXIT TEMPORARY):**
PHI floor collapsed 0.73→0.38. ORL seized I2 with LOCKED IN sustainability. Agent correctly SENDs EXIT with TEMPORARY severity. PHI recovered and won 109-97 — but the EXIT was correct at decision time. EXIT severity classification (TEMPORARY vs CONCERNING vs STRUCTURAL_TAKEOVER) gives the subscriber appropriate urgency.

### 4f. Opponent Profile: I3 vs Structural Indicators

The agent consistently distinguishes:
- **oppI3Won = true:** "Shot quality variance, not structural dominance." Used to JUSTIFY the buy thesis (opponent's lead is unsustainable).
- **oppI3Won = false, opp has I1/I2/I4:** "Structural counter-indicators." Used to SUPPRESS or add caution.

Example (GSW@SAC Q2 8:52, SUPPRESS): "Opponent holds I1 Disruption — a structural counter-indicator, not mere variance."

Example (GSW@SAC Q3 2:31, SEND): "Opponent's only won indicator is I3 (Shot Quality), which is expected variance, not structural dominance."

This maps directly to the DFT thesis: bet the structurally dominant team when trailing because opponent leads built on variance are unsustainable.

---

## 5. Compounding Results (Session 6)

### 5a. Sequential Compounding Architecture

`test_decisions` table stores agent decisions across requests:
```
PRIMARY KEY (game_id, trigger_idx, monitor)
Columns: decision, reasoning, body, ts
```

Each trigger loads all prior stored decisions, rebuilds `priorAlertTrail` with real reasoning (not PENDING stubs). Agent sees the full narrative arc.

### 5b. GSW@SAC Full Arc (10 triggers, sequential)

| # | Trigger | Decision | Prior Trail Length | Refs Prior Reasoning? |
|---|---------|----------|-------------------|----------------------|
| 0 | BUY Q2 11:48 | SUPPRESS | 0 | — |
| 1 | BUY Q2 10:44 | SUPPRESS | 0 | — |
| 2 | BUY Q2 8:52 | SUPPRESS | 0 | — |
| 3 | BWC_EDGE Q3 8:58 | SEND | 1 (BWC fire) | Yes — "position update for subscriber holding from Q2 BWC fire" |
| 4 | POSITION_SAFE Q3 7:59 | SEND | 2 | Yes — "prior BWC_EDGE RISK addressed" |
| 5 | BWC_EDGE Q3 6:17 | SEND | 3 | Yes — "prior RISK materialized (FRAGILE→MIXED)" |
| 6 | BWC_EDGE Q3 3:37 | SEND | 4 | Yes — "prior floor risk not yet triggered" |
| 7 | BUY Q3 2:31 | SEND | 5 | Yes — "prior BWC_EDGE alerts confirmed structural control" |
| 8 | POSITION_RECOVERING Q3 1:43 | SEND | 5 | Yes — "prior margin compression resolved" |
| 9 | BUY Q4 12:00 (+700) | SEND | 5 | Yes — "full lifecycle trail from Q2 through Q3 collapse" |

### 5c. Compounding Impact on Body Quality

**Trigger 9 without compounding (isolated, session 3):**
Good body — cites I1+I4, identifies oppI3 as variance. Generic sizing caution.

**Trigger 9 with full compounding (session 6, 9 prior decisions stored):**
Richer body — references specific prior alerts ("BWC fired in Q2 at floor 0.68, built peak edge 0.86"), traces the collapse arc, explicitly flags "higher-risk VALUE entry than typical," includes specific EXIT conditions. More honest about degraded position while still correctly SENDing.

**Decision unchanged.** Compounding improves narrative quality but doesn't change SEND/SUPPRESS outcomes. The context package already contains enough mechanical data for correct decisions.

### 5d. Trend Signal Impact

| Signal | What It Computes | Times Referenced | Load-Bearing? |
|--------|-----------------|-----------------|---------------|
| `momentum` | RISING/FALLING/STABLE (streak + delta from 6 deduped snapshots) | 1/10 (trigger 2) | No |
| `sustArc` | IMPROVING/DEGRADING/STABLE of opponent sust over window | 0/10 | No |
| `floorMarginRel` | ALIGNED/DIVERGING/CONVERGING | 1/10 (trigger 9) | No |

The agent derives the same insights from raw data: it reads the floor trajectory directly ("0.80 → 0.73 over the last minute"), it checks erosion level + peak delta for degradation, and it compares floor direction to margin direction from the score line. Labels are redundant vocabulary.

---

## 6. Bugs Found During Testing

### 6a. Sonnet Snapshot Injection (CRITICAL — production fix pending)

Auto-analysis at quarter boundaries writes Sonnet-assigned indicator scores to the snapshots table as if they were mechanical compute output. 252 contaminated rows (13.3%). These have no `raw_stats_json` and contain suspiciously uniform indicator values.

**Test harness fix:** `WHERE raw_stats_json IS NOT NULL` filter on all snapshot queries.
**Production fix needed:** Trace where in `poll-live-bdl.mjs` auto-analysis results get saved to snapshots table.

### 6b. Clock Comparison String vs Numeric (fixed session 6)

`"6:58" > "10:44"` is `true` lexicographically. This caused SAC's BWC fire at Q2 6:58 (later in game) to leak into Q2 10:44's prior alert trail as a "prior" alert. Agent then treated GSW BUY as VALUE play off SAC's BWC — wrong.

**Fix:** `parseClockSecs()` converts "M:SS" to total seconds for all comparisons.

### 6c. BWC Transition Code Path Missing useMonitor (fixed session 6)

Second `assembleContextPackage` call site (BWC transitions, line 415) wasn't passing the `useMonitor` flag. Only BUY triggers received trend signals. Moot since trend signals are killed, but the pattern matters: multiple call sites must be audited when adding context fields.

### 6d. Stale Poll Dedup (fixed session 6)

Halftime generates ~28 snapshots at the same clock value. Without dedup, the 6-snapshot trend window was entirely stale data from the break. Fix: pull 40 raw, dedup consecutive same-period+clock entries, take last 6 unique.

### 6e. max_tokens Truncation (fixed session 3)

BWC_EDGE bodies with RISK lines were truncated at 500 tokens. Bumped to 600.

### 6f. Score Format Misread (fixed session 3)

Agent misread away-home score format. Fixed with explicit score line: `Score: GSW 78 - SAC 77 (SAC is HOME)`.

### 6g. BWC Team Guard Blocking Money Shot (fixed session 3)

`!isBwcGame` guard on BUY triggers prevented the +700 SAC money shot at Q4 12:00. BUY must fire for ANY structurally dominant team trailing, including the BWC team.

---

## 7. v1 Production Comparison (GSW@SAC)

The only game with both v1 production alerts and v2 test results:

| v1 Alert | v1 Decision | v2 Equivalent | v2 Decision | Improvement |
|----------|-------------|---------------|-------------|-------------|
| BWC FIRED Q2 6:58 | DOWNGRADE | BWC initial fire | SEND | v2 establishes position (v1 downgraded due to I4 COMBO EVEN) |
| BWC CAND Q2 0:33 | SEND | (not triggered — covered by BWC lifecycle) | — | Lifecycle replaces repeated BWC fires |
| LEAD LOST Q3 5:56 | — | BWC_EDGE chain (Q3 8:58→7:59→6:17→3:37) | SEND×4 | v2 narrates degradation before lead is lost |
| BWC FIRED Q3 1:43 | SEND | POSITION_RECOVERING Q3 1:43 | SEND | v2 gives lifecycle context (recovery from VALUE) |
| BUY FIRED Q3 0:53 | SEND | BUY FIRED Q3 2:31 (warm) | SEND | v2 earlier trigger, warm BUY with lifecycle |
| BUY CAND Q3 0:24 | SEND | (absorbed by Q3 2:31 BUY) | — | Cooldown reduces noise |
| BUY CAND Q4 12:00 | SEND | BUY CAND Q4 12:00 (+700) | SEND | Same decision, richer body |
| LEAD LOST Q4 6:48 | — | THESIS_ALIVE Q4 8:56 | SEND | v2 catches EXIT→VALUE transition |
| BWC FIRED Q4 4:51 | SEND | BWC_EDGE Q4 4:28 | SEND | v2 gives state context (EDGE, erosion CAUTION) |

**Key v2 improvements:**
1. BWC_EDGE chain narrates degradation BEFORE lead is lost (v1 only had LEAD LOST after the fact)
2. THESIS_ALIVE catches EXIT→VALUE (v1 had no concept of this)
3. Warm BUY with lifecycle context vs context-free BUY
4. Erosion tracking provides structural degradation warnings
5. Prior alert trail creates compounding narrative

---

## 8. Architecture Validated

### What the engine needs for production:

1. **BWC state machine** — tracks LOCK/EDGE/VALUE/EXIT per game, fires on transitions
2. **Erosion detection** — peak-relative CAUTION/COLLAPSE thresholds
3. **Directional filtering** — DEGRADING vs RECOVERING classification
4. **3-min universal cooldown** with THESIS_ALIVE exemption
5. **Material change gate** — floor ±0.10, margin ±5, or 5 min elapsed
6. **BUY trigger generation** — FIRED (≥0.65) and CANDIDATE (0.55-0.65) with `bwcTeamMatch` flag
7. **Context package assembly** — engine data + opponent profile + erosion + BWC lifecycle + floor trajectory + prior trail
8. **Agent prompt** (Opus 4.6) — receives context package, returns SEND/SUPPRESS + reasoning + body

### What the engine does NOT need:

1. ~~Monitor agent~~ (Sonnet narration — killed, proven redundant)
2. ~~Trend signals~~ (momentum/sustArc/floorMarginRel — redundant with floor trajectory)
3. ~~I4 COMBO~~ (v1 concept — replaced by indicator counting + oppI3Won)
4. ~~Separate monitor_observations table writes~~

### Production wiring scope:

The test harness (`test-v2-engine.mjs`) replays historical snapshots. Production (`poll-live-bdl.mjs`) needs the same logic running in real-time on each poll cycle. Key difference: production computes from live BDL data, test harness reads from stored snapshots. The BWC state machine, erosion detection, and context assembly are the same code — just needs to be extracted and called from the poll loop.

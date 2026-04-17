# V2 Agent Rules — Living Spec

**Purpose:** Single source of truth for every agent prompt decision. Read this when wiring to production.
**Last updated:** April 17, 2026 (session 6 — monitor/trend signal verdict)

---

## Alert Type Taxonomy

### BUY
**When:** Structurally dominant team trailing. Fires for ANY ctrl team trailing, including the BWC team.
**Tiers:** FIRED (floor ≥ 0.65), CANDIDATE (floor 0.55-0.65).
**Default:** Agent decides SEND/SUPPRESS.
**Sweet spot:** Deficit 1-7 points. Deeper deficits need exceptionally strong structural case.
**Rule:** Standard evaluation — floor, indicators, TP, deficit depth. When `bwcTeamMatch: YES`, the agent has BWC lifecycle context and should reference the position arc ("SAC is in VALUE lifecycle, BWC fired Q2"). BUY coexists with lifecycle alerts — lifecycle tracks position health for holders, BUY identifies entry/re-entry opportunities at plus-money. A BUY with BWC context is a "warm BUY" (thesis history backing it); a BUY with no BWC lifecycle is a "cold BUY" (structurally interesting but unproven).
**Gates:** Period ≥ 2, trailing 1-15, clock ≥ 1:00, 3-min cooldown between BUY fires.
**SUPPRESS when:** TP NO PATH/UNLIKELY in Q4, < 2 indicators won, ctrl sust COLD/MIXED with opp DURABLE/LOCKED IN, floor declining, deficit > 7 without exceptional structural case.
**Validated:** GSW@SAC Q2 11:48 CANDIDATE (SUPPRESS — GSW only I3, opp has I1, TP NO PATH). GSW@SAC Q2 10:44 FIRED (SUPPRESS — GSW I2+I3 only, variance-driven). GSW@SAC Q2 8:52 CANDIDATE (SUPPRESS — FALLING momentum, CAUTION erosion, NO PATH; first trigger where trend signal was referenced but not load-bearing). GSW@SAC Q3 2:31 FIRED bwcTeamMatch:YES (SEND — warm BUY, SAC trailing 1, floor 0.73 above BWC fire 0.68, I1+I4+I5, STRONG RECOVERY, VALUE lifecycle; compounding trail references prior BWC_EDGE chain). GSW@SAC Q4 12:00 CANDIDATE bwcTeamMatch:YES (SEND — +700 money shot, I1+I4 retained, BWC lifecycle context). POR@DEN Q4 10:02 FIRED (SUPPRESS — trailing 15, outside sweet spot, opp DURABLE). POR@DEN Q4 4:19 FIRED (SUPPRESS — trailing 9, TP UNLIKELY, "cold BUY" with no BWC lifecycle). MIA@CHA Q2 BUY (SUPPRESS — CHA only I4, sust COLD).

### BWC_EDGE (LOCK → EDGE)
**When:** BWC team's lead compressed to 1-2. Subscriber already holds position.
**Default:** ALWAYS SEND.
**Rule:** Position update with RISK line. Frame as reassurance, not action signal. MUST include specific forward-looking RISK concern. If prior alerts flagged a RISK, reference whether it materialized.
**Body format:** Status (2-3 sentences) + "RISK: [specific concern with indicators/thresholds that would trigger next state change]"
**Rationale:** Subscriber wants to know their position is holding. Silence = anxiety. RISK line creates accountability chain — each alert references prior risks, building a narrative your brother can follow on ntfy.
**Validated:** GSW@SAC trigger 1 (SEND + RISK: FRAGILE sust flagged). GSW@SAC trigger 5 (SEND — prior FRAGILE risk materialized, new RISK: floor approaching fire floor). GSW@SAC full arc (triggers 3-6, all SEND — compounding trail builds RISK chain across Q3, each alert references prior risk materialization, body quality excellent without trend signals).

### VALUE (EDGE → VALUE, or LOCK → VALUE)
**When:** BWC team lost lead but retains structural control. Trailing 1-7 or tied.
**Default:** Agent decides SEND/SUPPRESS.
**Rule:** Thesis = "structural edge that built the lead is intact — dip is temporary, plus-money entry." Verify: floor vs BWC fire floor, how lead was lost, deficit depth (1-7 best), timing (Q2-Q3 > Q4). If prior BWC_EDGE alerts flagged a RISK, reference whether it materialized.
**SUPPRESS when:** Erosion COLLAPSE AND structural indicators (I1/I4) flipped to opponent.
**Validated:** POR@PHX trigger 1 (SEND — floor 0.95, 4/5 indicators, textbook). MIA@CHA trigger 5 (SEND — tied, 4/5 indicators, bad beat OT loss by 1).

### THESIS_ALIVE (EXIT → VALUE)
**When:** BWC team REGAINED structural control after losing it entirely. Deep-value play.
**Default:** Agent decides SEND/SUPPRESS.
**Rule:** Floor erosion is EXPECTED and is WHY plus-money exists. DO NOT treat floor level or erosion as primary factors.

**Weight hierarchy:**
1. WHICH indicators does BWC team hold? I1 Disruption + I4 Game Control = structural core retained.
2. Is opponent's edge variance-based? oppI3Won=true = shooting well, not structurally dominant — this IS the thesis.
3. TP path — STRONG RECOVERY or PROBABLE = mechanical path exists.
4. Deficit depth and timing.
5. Floor being below BWC fire floor is the ENTRY SIGNAL, not a red flag.

**SUPPRESS only if:** BWC team lost I1+I4 (structural core gone), OR opponent has non-I3 structural indicators (I1/I2/I4), OR TP NO PATH/UNLIKELY with < 3 min left.
**Cooldown:** EXEMPT from 3-min universal cooldown. EXIT→VALUE is always significant.
**Rationale:** Without exemption, +700 SAC entry at Q4 12:00 was eaten by cooldown from Q3 0:00 EXIT.
**Validated:** GSW@SAC trigger 10 (SEND — Q4 12:00, +700, I1+I4, oppI3). GSW@SAC trigger 11 (SEND — Q4 8:56, I1+I4, STRONG RECOVERY). GSW@SAC trigger 9 full-compounding (SEND — Q4 12:00 with 9 prior stored decisions, full BWC lifecycle trail from Q2 through Q3 collapse; body honestly flags COLLAPSE erosion + "higher-risk VALUE entry," references prior RISK chain; same decision as isolated test but richer context). MIA@CHA trigger 2 (SUPPRESS — I4 lost, structural core broken, TP NO PATH).

### EXIT (VALUE → EXIT, EDGE → EXIT, LOCK → EXIT)
**When:** BWC team lost structural control. Ctrl flipped to opponent.
**Default:** ALWAYS SEND. This is a cash-out signal.
**Rule:** The SUBSCRIBER'S POSITION is on the BWC team, NOT the current control team. Frame the exit around the BWC team losing their edge. Reference the full arc from prior alerts.
**Body must:** Name BWC team as subscriber's position, explain what structural shift happened, reference the lifecycle arc.
**Rationale:** Without explicit team reference, the body could confuse which team the subscriber is on (GSW@LAC pre-fix named wrong team).
**Validated:** GSW@LAC trigger 6 (SEND — "LAC position, structural edge gone, GSW took over I2+I3+I1"). ORL@PHI Q2 5:42 EXIT TEMPORARY (SEND — PHI floor collapsed 0.73→0.38, ORL seized I2 with LOCKED IN sust; PHI recovered and won 109-97 but EXIT was correct at decision time).

### POSITION_SAFE (→ LOCK) and POSITION_RECOVERING (→ EDGE)
**When:** BWC team recovering from degraded state.
**Default:** SEND if prior alerts flagged risks or concerns. SUPPRESS if nothing changed and no prior risk to update on.
**Rule:** Include whether prior RISK materialized. Write reasoning for compounding either way.
**Validated:** GSW@SAC Q3 7:59 POSITION_SAFE (SEND — prior BWC_EDGE RISK addressed, floor stabilized 0.80, 4/5 indicators, compounding trail references trigger 3 reasoning). GSW@SAC Q3 1:43 POSITION_RECOVERING (SEND — recovery confirmed after VALUE dip, prior margin compression resolved, opp sust DEGRADING from LOCKED IN→MIXED). ORL@PHI Q2 0:42 EXIT→LOCK recovery. ORL@PHI Q4 7:21 final recovery (SEND — floor surged to 0.80, 4/5 indicators after full EXIT→recovery→EDGE→recovery cycle).

### BUY WINDOW CLOSING (initial BWC fire)
**When:** First detection of structural lead — 3+ consecutive holds, floor ≥ 0.60, leading 2+, period ≥ 2.
**Default:** SEND. This establishes the position.
**Rule:** Initial BWC fire always routes through agent. Sets the anchor for the entire lifecycle. Body explains the structural thesis — which indicators, why the lead is structural not variance.
**Note:** In v2, this becomes the entry point into the state machine. All subsequent alerts reference back to this moment.

---

## Mechanical Gates

### 3-Minute Universal Cooldown
**What:** All BWC transitions cooldown-gated via `lastAnyBwcTs`. 180,000ms between ANY transition fires.
**Exception:** THESIS_ALIVE is exempt (EXIT→VALUE always significant).
**Rationale:** GSW@SAC had 34 transitions pre-cooldown → 12 after. Q3 8:58-7:31 burst of 8 collapsed to 1. Prevents trail pollution from rapid ctrl oscillation while preserving meaningful signals.
**Validated:** 9/9 mechanical passing, no meaningful signals lost.

### Material Change Gate
**What:** Same-direction re-fires need: different state (always fires), OR floor delta ≥ 0.10, OR margin delta ≥ 5, OR 5+ minutes elapsed.
**Applied after:** Cooldown check passes.

### 3-Hold Minimum for Initial BWC Fire
**What:** Prevents chattering from brief control. Team must hold structural control for 3+ consecutive snapshots before BWC fires.

### Initial State from Margin
**What:** LOCK (margin ≥ 3) or EDGE (margin = 2) at BWC fire. Not hardcoded LOCK.

---

## Erosion Thresholds

**Peak-relative, dynamic:**
- CAUTION: 20% × peak floor (edge erosion beginning)
- COLLAPSE: 35% × peak floor (structural breakdown)
- Return to STABLE: floor recovers above CAUTION threshold

**Example:** Peak 0.90 → CAUTION at delta -0.160, COLLAPSE at delta -0.280.

---

## EXIT Severity Classification

When EXIT fires, opponent's structural profile determines urgency:
- **TEMPORARY:** Opponent floor low, few holds, only I3 (variance)
- **CONCERNING:** Opponent has I1 or I4 (structural) with 3+ holds
- **STRUCTURAL_TAKEOVER:** Opponent floor ≥ 0.70, 5+ holds, 2+ non-I3 indicators

---

## Opponent Profile Rules

**oppI3Won = true:** "Shot quality variance, not structural dominance. Does NOT invalidate buy thesis." This is the core DFT thesis — the opponent's lead is built on unsustainable shooting.

**oppIndicatorCount ≥ 1 AND !oppI3Won:** "WARNING: Opponent structural counter-indicators, not just variance." This flags real structural threats (I1 disruption, I2 interior, I4 game control in opponent's hands).

**0 opponent indicators:** Strongest case for SEND. Backtest: 48.6% win rate vs 32.9% when opponent has 1+.

---

## Context Compounding

### Prior Alert Trail
Last 5 v2 alerts with type, state, floor, margin, and decision. Each trigger sees the full chain. Agent references prior decisions and reasoning in subsequent alerts.

### RISK Chain (BWC_EDGE specific)
Each BWC_EDGE body ends with a RISK line — specific forward-looking concern. Subsequent alerts reference whether the RISK materialized. Creates a living risk register:

```
Q3 8:58 BWC_EDGE → RISK: FRAGILE sustainability
Q3 6:17 BWC_EDGE → Prior RISK materialized (FRAGILE→MIXED). New RISK: floor approaching fire floor
Q3 3:37 BWC_EDGE → Prior floor risk not yet triggered, but margin down to 1
```

---

## Body Formatting

### Subscriber-Facing (ntfy)
- Lead with action or status
- Plain English — no jargon without explanation
- Include "what to watch for" when relevant
- BWC_EDGE: status + RISK line
- EXIT: name BWC team as subscriber position
- VALUE/THESIS_ALIVE: explain why plus-money exists
- BUY: explain structural thesis, note sizing discipline on deep deficits

### Agent Reasoning (internal)
- Even when SUPPRESS, write thorough reasoning — it feeds subsequent decisions
- Reference opponent profile, erosion, BWC lifecycle, prior alerts
- "REASONING AS JOURNAL" — the suppressed reasoning compounds into better future decisions

---

## Architecture Principles (from prior specs)

### Two-Layer Authority (was Three-Layer — monitor killed Test 6)
1. **Engine** computes I1-I5, floor, conviction, erosion, BWC state machine (mechanical, immutable)
2. **Agent** decides SEND/SUPPRESS (Opus, sees engine output + floor trajectory + prior alert trail)

### BUY vs Lifecycle
- **BUY** = structurally dominant team trailing at plus-money. Fires for ANY team, including BWC team. Identifies entry/re-entry opportunities.
- **BWC Lifecycle** (VALUE, EXIT, THESIS_ALIVE, BWC_EDGE) = tracks position health for someone already holding. Fired only for the BWC team.
- **They coexist.** A subscriber might get a BWC_EDGE (position update) AND a BUY CANDIDATE (entry signal) near the same moment. Different purposes: lifecycle says "your position is X," BUY says "there's an entry at Y odds."
- **Forcing function:** GSW@SAC Q4 12:00 — v1 correctly fired BUY CANDIDATE at +700. v2 initially blocked it with `!isBwcGame` guard, causing the money shot to fall through the cracks. Fixed session 3.

### Monitor Role — KILLED (Test 6, Apr 17)

**Verdict:** The separate monitor agent is dead. Trend signals (momentum, sustArc, floorMarginRel) were tested as inline mechanical computations on the v2 context package across GSW@SAC full arc (14 triggers, 10 tested with compounding).

**Test results:**
- **10/10 correct decisions** with trend signals + sequential compounding
- **0 decisions changed** from baseline (31/31 without trend signals in sessions 1-3)
- Trend signals referenced in **2 of 10** triggers (triggers 2 and 9)
- In both cases, trend signals **reinforced** a decision already determined by indicators + erosion + BWC lifecycle
- Agent independently derived the same insights from raw data (floor trajectory, indicator counts, erosion level) without labels

**What was tested:**
- `momentum`: RISING/FALLING/STABLE with streak count + delta (computed from 6 deduped snapshots)
- `sustArc`: IMPROVING/DEGRADING/STABLE of opponent sustainability over snapshot window
- `floorMarginRel`: ALIGNED/DIVERGING/CONVERGING — whether floor and margin move together

**Why it doesn't matter:**
The v2 context package already contains everything the agent needs: 6-snapshot floor history with scores, erosion level + peak delta, indicator scores, opponent profile, BWC lifecycle state, and prior alert trail with reasoning. The agent reads what it needs from these fields directly. Pre-digested labels like "FALLING(5, -0.05)" don't save meaningful reasoning steps — the agent counts from the floor trajectory in the same prompt.

**Architectural wins from killing monitor:**
- Eliminates cadence mismatch (monitor every 3 polls vs mechanical every poll)
- Eliminates window mismatch (monitor 8 snapshots vs context 6)
- Eliminates perspective mismatch (monitor ctrl team may differ from current poll)
- Saves ~$2-3/hour Sonnet cost during live games
- Removes `monitor_observations` table writes (DB load reduction)
- Simplifies production wiring — no monitor prompt, no observation storage, no injection pipeline

**Production implications:**
- Do NOT wire `computeMonitorContext()` or `trendSignals` to production
- Do NOT pass `&monitor=true` in production alert calls
- The `monitor_observations` table and existing monitor agent code in `poll-live-bdl.mjs` can be deprecated
- Monitor context injection in `gatherAgentContext`, `formatSonnetPrompt`, `fireCalibrationAnalysis`, and `analyze.js` POST body can be removed when convenient

---

## Known Issues / Future Work

- **CRITICAL — Sonnet snapshot injection (diagnosed Apr 17):** Auto-analysis at quarter boundaries writes Sonnet-assigned indicator scores to the snapshots table as if they were mechanical compute output. These snapshots have NO `raw_stats_json` and contain suspiciously uniform indicator values (e.g., I1:0.2 I2:0.1 I3:0.3 I4:0.1 I5:0.2). 252 contaminated snapshots across 9 test games (13.3% of all data). Worst: GSW@LAC 4/12 at 59 (29%). **Test harness fix:** filter snapshots where `raw_stats_json IS NULL`. **Production fix needed:** trace where in `poll-live-bdl.mjs` auto-analysis results get saved to the snapshots table and stop it from writing indicator scores as snapshot rows.
- ~~`max_tokens` at 500 truncates BWC_EDGE bodies with RISK lines. Bump to 600.~~ DONE (session 3).
- ~~Score display bug — agent misread away-home score format.~~ FIXED (session 3, added explicit score line to prompt).
- ~~BUY gate blocking BWC team — `!isBwcGame` guard prevented +700 money shot.~~ FIXED (session 3, BWC restriction removed).
- ~~Monitor enrichment (Test 6).~~ RESOLVED — trend signals tested, proven redundant, monitor killed. See Architecture Principles.
- POR@DEN has 13 BUY triggers in no-BWC game — may need tighter mechanical gating for BUY-only archetype or stronger cooldown.
- Velocity guard (Test 7) — auto-analysis suppression at COLLAPSE — not yet tested.
- COLD→STALLED rename agreed, deferred.
- Empirical calibration of 20%/35% erosion multipliers from live data.
- BWC ntfy titles with state tag: "BWC LOCK", "BWC EDGE".
- Dashboard: BWC lifecycle timeline visualization.
- WNBA/NCAAMB: VALUE/EXIT port.
- **NEXT:** Wire v2 engine to production `poll-live-bdl.mjs`. Write finalized spec from test results (sessions 1-6: 9/9 mechanical, 41/41 agent decisions correct across 6 games).

---

## Test Results Summary (sessions 1-6)

### Mechanical Engine: 9/9 (100%)

All games: BWC state machine, erosion transitions, trigger filtering, context package assembly — zero errors.

### Agent Decisions: 41/41 (100%)

| Game | Archetype | Triggers | Correct | Notes |
|------|-----------|----------|---------|-------|
| GSW@SAC 4/10 | BWC→LEAD_LOST→BUY(+700) | 14 | 10/10* | Full compounding arc tested. Money shot SEND ✅ |
| POR@PHX 4/11 | BWC dominant | 3 | 3/3 | Clean BWC lifecycle |
| MIA@CHA 4/14 | BWC→EXIT→bad beat | 6 | 6/6 | EXIT SUPPRESS + OT loss by 1 |
| ORL@PHI 4/14 | BWC→EXIT→recovery | 7 | 7/7 | Full EXIT→LOCK→EXIT→recovery cycle |
| GSW@LAC 4/12 | BWC→COLLAPSE | 7 | 7/7 | LAC collapse correctly identified |
| POR@DEN 4/13 | No BWC (BUY only) | 8 | 8/8 | All cold BUYs correctly suppressed |

*GSW@SAC: 10 of 14 tested with full sequential compounding; remaining 4 (Q4 BWC lifecycle) deferred — all are BWC_EDGE/POSITION_RECOVERING with SEND-by-rule.

### Monitor/Trend Signals (Test 6): NOT NEEDED

- Baseline without signals: 31/31 correct (sessions 1-3)
- With trend signals + compounding: 10/10 correct (session 6)
- Decisions changed by trend signals: **0**
- Trend signals referenced: 2/10 (reinforcing only, never load-bearing)
- **Verdict: Kill monitor. Do not wire trend signals to production.**

### Key Compounding Findings (Test 6)

- Sequential compounding via `test_decisions` table works — agent reads prior reasoning and builds on it
- Clock comparison bug found and fixed (string vs numeric — "6:58" > "10:44" lexicographically)
- BWC transition code path had missing `useMonitor` threading — second `assembleContextPackage` call site
- Dedup stale polls: 40 raw → dedup consecutive same-period+clock → take last 6 unique
- Prior alert trail with real reasoning (not PENDING stubs) produces richer body text but same decisions

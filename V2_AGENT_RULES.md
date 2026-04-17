# V2 Agent Rules — Living Spec

**Purpose:** Single source of truth for every agent prompt decision. Read this when wiring to production.
**Last updated:** April 17, 2026 (session 2)

---

## Alert Type Taxonomy

### BUY
**When:** Structurally dominant team trailing, NO prior BWC. Never led.
**Default:** Agent decides SEND/SUPPRESS.
**Rule:** Standard evaluation — floor, indicators, TP, deficit depth. No BWC lifecycle to reference.
**SUPPRESS when:** TP NO PATH, < 2 indicators won, ctrl sust COLD/MIXED with opp DURABLE/LOCKED IN, floor declining.
**Validated:** GSW@SAC trigger 0 (SUPPRESS — GSW weak case, TP NO PATH). POR@DEN trigger 0 (SEND — DEN +700). POR@DEN trigger 8 (SEND — DEN +750, trailing 15). MIA@CHA trigger 0 (SUPPRESS — CHA only I4, sust COLD).

### BWC_EDGE (LOCK → EDGE)
**When:** BWC team's lead compressed to 1-2. Subscriber already holds position.
**Default:** ALWAYS SEND.
**Rule:** Position update with RISK line. Frame as reassurance, not action signal. MUST include specific forward-looking RISK concern. If prior alerts flagged a RISK, reference whether it materialized.
**Body format:** Status (2-3 sentences) + "RISK: [specific concern with indicators/thresholds that would trigger next state change]"
**Rationale:** Subscriber wants to know their position is holding. Silence = anxiety. RISK line creates accountability chain — each alert references prior risks, building a narrative your brother can follow on ntfy.
**Validated:** GSW@SAC trigger 1 (SEND + RISK: FRAGILE sust flagged). GSW@SAC trigger 5 (SEND — prior FRAGILE risk materialized, new RISK: floor approaching fire floor).

### VALUE (EDGE → VALUE, or LOCK → VALUE)
**When:** BWC team lost lead but retains structural control. Trailing 1-7 or tied.
**Default:** Agent decides SEND/SUPPRESS.
**Rule:** Thesis = "structural edge that built the lead is intact — dip is temporary, plus-money entry." Verify: floor vs BWC fire floor, how lead was lost, deficit depth (1-4 best), timing (Q2-Q3 > Q4). If prior BWC_EDGE alerts flagged a RISK, reference whether it materialized.
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
**Validated:** GSW@SAC trigger 10 (SEND — Q4 12:00, +700, I1+I4, oppI3). GSW@SAC trigger 11 (SEND — Q4 8:56, I1+I4, STRONG RECOVERY). MIA@CHA trigger 2 (SUPPRESS — I4 lost, structural core broken, TP NO PATH).

### EXIT (VALUE → EXIT, EDGE → EXIT, LOCK → EXIT)
**When:** BWC team lost structural control. Ctrl flipped to opponent.
**Default:** ALWAYS SEND. This is a cash-out signal.
**Rule:** The SUBSCRIBER'S POSITION is on the BWC team, NOT the current control team. Frame the exit around the BWC team losing their edge. Reference the full arc from prior alerts.
**Body must:** Name BWC team as subscriber's position, explain what structural shift happened, reference the lifecycle arc.
**Rationale:** Without explicit team reference, the body could confuse which team the subscriber is on (GSW@LAC pre-fix named wrong team).
**Validated:** GSW@LAC trigger 6 (SEND — "LAC position, structural edge gone, GSW took over I2+I3+I1").

### POSITION_SAFE (→ LOCK) and POSITION_RECOVERING (→ EDGE)
**When:** BWC team recovering from degraded state.
**Default:** SEND if prior alerts flagged risks or concerns. SUPPRESS if nothing changed and no prior risk to update on.
**Rule:** Include whether prior RISK materialized. Write reasoning for compounding either way.
**Validated:** Not yet individually tested (pending GSW@SAC chain completion).

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

### Three-Layer Authority
1. **Engine** computes I1-I5, floor, conviction (mechanical, immutable)
2. **Monitor** narrates game state (Sonnet, observational — not in test harness yet)
3. **Agent** decides SEND/SUPPRESS (Opus, sees engine + monitor + trail)

### BUY vs Lifecycle
- **BUY** = structurally dominant team trailing, never held a lead. No BWC lifecycle.
- **After BWC fires** = lifecycle takes over. VALUE/EXIT/THESIS_ALIVE replace BUY for the BWC team.
- Both coexist cleanly. Different game states, different alert types.

### Monitor Role (deferred — Test 6)
Monitor enriches agent context but has no veto authority. Must earn trust from live data before being given override power. Current role: reinforcing witness.

---

## Known Issues / Future Work

- **CRITICAL — Sonnet snapshot injection (diagnosed Apr 17):** Auto-analysis at quarter boundaries writes Sonnet-assigned indicator scores to the snapshots table as if they were mechanical compute output. These snapshots have NO `raw_stats_json` and contain suspiciously uniform indicator values (e.g., I1:0.2 I2:0.1 I3:0.3 I4:0.1 I5:0.2). This causes false ctrl flips — e.g., GSW@SAC Q3 0:00 → Q4 12:00 showed EXIT→THESIS_ALIVE with zero game action because a Sonnet snapshot briefly asserted GSW control between two mechanical SAC snapshots. **Test harness fix:** filter snapshots where `raw_stats_json IS NULL`. **Production fix needed:** trace where in `poll-live-bdl.mjs` auto-analysis results get saved to the snapshots table and stop it from writing indicator scores as snapshot rows. This is the same class of bug as the client Sonnet indicator injection that was previously fixed.
- ~~`max_tokens` at 500 truncates BWC_EDGE bodies with RISK lines. Bump to 600.~~ DONE (session 3).
- Monitor enrichment (Test 6) not yet wired to test harness.
- Velocity guard (Test 7) — auto-analysis suppression at COLLAPSE — not yet tested.
- COLD→STALLED rename agreed, deferred.
- Empirical calibration of 20%/35% erosion multipliers from live data.
- BWC ntfy titles with state tag: "BWC LOCK", "BWC EDGE".
- Dashboard: BWC lifecycle timeline visualization.
- WNBA/NCAAMB: VALUE/EXIT port.

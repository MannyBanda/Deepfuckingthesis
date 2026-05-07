# GRADUATION SIMPLIFICATION SPEC v4 — PROPOSED CHANGES
## Review document for Manny — strategic analysis + full prompt text

**Date:** May 7, 2026
**Purpose:** Identify every spec change needed, draft actual prompt text, ensure BUY accuracy is preserved

---

## 1. SPEC CORRECTIONS FROM REVIEW

### 1A. Dead Code List (Section 5) — SHRUNK

**v3 spec killed 7 functions. v4 kills 4.**

The trajectory functions (`computeMFTrajectory`, `computeFloorMarginSignal`, `computeConvictionTrend`, `computeFullCPTrend`) read checkpoint data but are NOT graduation machinery — they're agent context signals. Checkpoints are still captured. These functions still work. They should stay.

**KILL (4 functions + 1 constant, ~120 lines):**
- `recomputeCheckpointState()` (2632-2700) — graduation rank computation
- `computeCheckpointFloorStats()` (2483-2500) — eligible CP stats that feed graduation MF/minF gates
- `getLaneGates()` (2699-2703) — lane-specific MF/minF thresholds
- `LANE_THRESHOLDS` (2308-2311) — dead constants

**KEEP (4 functions, ~150 lines):**
- `computeMFTrajectory()` — floor direction for agent (RISING/FLAT/DECLINING)
- `computeFloorMarginSignal()` — floor vs margin divergence (DIVERGING_POSITIVE/CONVERGING_DOWN)
- `computeConvictionTrend()` — conviction stability (STABLE/DEGRADING/IMPROVING)
- `computeFullCPTrend()` — unfiltered floor trajectory (catches hidden declines)

**Also KEEP:**
- `classifyRank()` — NCAAMB uses it
- `computeTrajectorySignals()` — XGB SHAP trajectory (uses checkpoint SHAP, not ranks)
- `computeMeanErosion()` — uses poll-level floor sums, independent of checkpoints
- `GRAD_CHECKPOINTS` — still drives checkpoint capture

### 1B. v2Ctx Field Changes (Section 2I) — SPECIFIED

**REMOVE from v2Ctx:**
- `cpPeakRank` → replaced by `compoundTier`
- `cpGraduation` → replaced by compound confirmation data
- `cpOppGraduation` → opponent graduation concept stays but simplified
- `lane` → lanes are removed (compound thresholds are universal)
- `pregameML` → can stay (useful context) or remove if unused
- `cpMeanFloor` → no longer used for gates (MF trajectory function stays for agent context)
- `cpMinFloor` → no longer used for gates
- `cpEligibleCount` → replaced by `compoundHolds`

**ADD to v2Ctx:**
- `compoundTier` — TRACKING/CONFIRMED/RECOVERING/LOCKED (string)
- `compoundHolds` — consecutive compound hold count (int)
- `compoundPath` — Q2_EARLY or STANDARD (string)
- `mcCumAtConfirmation` — MC Cum when compound first confirmed (float, null if not confirmed)
- `priorFlips` — control flips before confirmation (int)

**KEEP (unchanged):**
- `mfTrajectory` — still computed from checkpoints
- `fullCPTrend` — still computed from checkpoints
- `floorMarginSignal` — still computed from checkpoints
- `convictionTrend` — still computed from checkpoints
- `cpCtrlFlips` → rename to `priorFlips` in context
- `bwcFlipped`, `isSecondBwc`, `deadTeam`, `deadHadPO`, `deadRank` — death/flip context stays
- `positionClosed` — stays
- `buyPosition` — stays
- ALL erosion fields, floor reliability, XGB, MC, SHAP — unchanged

### 1C. PO Firing Logic — SPECIFIED

**Current:** `recomputeCheckpointState()` → rank → `getLaneGates()` → MF/minF gates → fire
**New:** `checkCompoundConfirmation()` → confirmed → fire

The ~140-line PO evaluation block (rank gates, Q3_6 gate, lane gates, MF gates) reduces to:
```
if (compoundResult.confirmed && !lt.po_fired) {
  // Set po_fired with compound data, route through agent
}
```

---

## 2. AGENT PROMPT — DATA INJECTION CHANGES

### 2A. POSITION TRACKING Section (replaces graduation context)

**CURRENT (lines ~556-562):**
```
${ctx.cpGraduation 
  ? 'Graduation: ' + ctx.cpPeakRank + '-Rank (graduated @ ' + ctx.cpGraduation.cp_label + '...'
  : 'Pre-graduation (' + ctx.cpEligibleCount + ' eligible CPs...'
} | Lane: ${ctx.lane || 'unknown'} (pregame ML ${ctx.pregameML || '?'}) | CP flips: ${ctx.cpCtrlFlips}
```

**NEW:**
```
POSITION TRACKING:
${ctx.compoundTier === 'CONFIRMED' || ctx.compoundTier === 'RECOVERING' || ctx.compoundTier === 'LOCKED'
  ? 'Position: ' + ctx.compoundTier + ' (' + ctx.compoundHolds + ' compound holds, ' + ctx.compoundPath + ' path)'
    + ' | MC Cum at confirmation: ' + (ctx.mcCumAtConfirmation != null ? (ctx.mcCumAtConfirmation * 100).toFixed(1) + '%' : '?')
    + ' | Prior flips: ' + (ctx.priorFlips || 0)
    + ' | Control flips (game total): ' + ctx.ctrlFlips
  : 'Pre-confirmation (' + (ctx.compoundHolds || 0) + ' compound holds toward threshold)'
    + ' | Control flips: ' + ctx.ctrlFlips
}
```

### 2B. POSITION HEALTH Section — unchanged

Peak floor, mean floor, erosion, conviction trend, full CP trend, consecutive holds, floor-margin signal — ALL STAY. These are computed independently of graduation.

### 2C. EXIT Context — ADD windowed XGB + MC Cum

In the EXIT severity section, add:
```
${ctx.exitSeverity?.windowedXgb != null ? 'Windowed XGB (2Q): ' + (ctx.exitSeverity.windowedXgb * 100).toFixed(1) + '% (recent structural decay detector)' : ''}
${ctx.exitSeverity?.mcCumAtExit != null ? 'MC Cum at EXIT: ' + (ctx.exitSeverity.mcCumAtExit * 100).toFixed(1) + '% (sustained shift confirmation, gate < 70%)' : ''}
```

---

## 3. AGENT PROMPT — RULES CHANGES

### 3A. TRACKING Rule — MINOR WORDING

**CURRENT:** "First structural signal — the system just identified ${ctx.ctrlTeam} as structurally interesting (3 consecutive holds, floor ${ctx.floor}, margin ${ctx.margin}). This is NOT a position recommendation..."

**NEW:** Same, just change "3 consecutive holds" → "structural tracking initiated" (holds threshold is mechanical, agent doesn't need the number):
```
- TRACKING: First structural signal — the system has identified ${ctx.ctrlTeam} as structurally interesting (floor ${ctx.floor}, margin ${ctx.margin}). This is NOT a position recommendation — the subscriber learns a game is on the radar. ALWAYS SEND unless the game is clearly meaningless (garbage time, both teams eliminated, period 4 with < 2 min left). Body should explain: which team, what structural picture (indicators, floor, margin), and that we are watching for the edge to develop. Frame as: "Watching [TEAM] — [why they look structurally dominant]. Will update if this develops into a position." Keep it short — this is a heads-up, not a thesis.
```

### 3B. POSITION_OPEN Rule — MAJOR REWRITE

**CURRENT:** ~50 lines of rank-specific conditional logic (A-rank wire-to-wire, A-with-flips, B-rank, etc.)

**NEW:**
```
- POSITION_OPEN: The team has sustained compound structural signals — MC Cum ≥ 0.80 AND Floor ≥ 0.65 — for 5 consecutive polls (~2.5 minutes game clock). This is a significant structural confirmation.
  ${ctx.compoundTier === 'CONFIRMED' && ctx.compoundPath === 'Q2_EARLY'
    ? 'Q2 EARLY CONFIRMATION (95.5% accuracy): Compound sustained with lead ≥5 and zero prior control flips. Strongest early signal — structural dominance established before halftime with scoreboard separation. ALWAYS SEND.'
    : ctx.compoundTier === 'CONFIRMED'
    ? 'CONFIRMED (86% accuracy, 0 prior flips): Structural position validated. Compound signals sustained without control being contested. Standard confidence — evaluate structural stress and current indicators.'
    : ctx.compoundTier === 'RECOVERING'
    ? 'RECOVERING (73% accuracy, ' + (ctx.priorFlips || '1+') + ' prior flips): Position confirmed after control was contested. Structural edge recovered but game is competitive. The compound held DESPITE the flip history — this earned it through challenge. Note lower baseline accuracy in body. Check: are the indicators that slipped during flips back? Is conviction trend STABLE or DEGRADING?'
    : ctx.compoundTier === 'LOCKED'
    ? 'LOCKED (92% accuracy, 10+ sustained holds): Highest-confidence structural read — compound signals sustained across extended evaluation. ALWAYS SEND.'
    : ''}
  ${ctx.isSecondBwc ? 'SECOND POSITION TEAM: ' + ctx.bwcTeam + ' took structural control away from ' + ctx.deadTeam + (ctx.deadHadPO ? ' (who had a confirmed position)' : ' (who was tracking but never confirmed)') + '. The reversal itself is evidence — ' + ctx.bwcTeam + ' earned this through merit after ' + ctx.deadTeam + ' collapsed. ALWAYS SEND.'
  : ctx.bwcFlipped ? 'POSITION FLIP: The system originally tracked ' + ctx.originalBwcTeam + ' but they FAILED to confirm. ' + ctx.bwcTeam + ' then confirmed ' + ctx.compoundTier + ' — taking structural control away from a previously dominant team. The floor appears modest because cumulative stats are anchored by ' + ctx.originalBwcTeam + "'s early dominance, but " + ctx.bwcTeam + ' is sustaining compound signals DESPITE that headwind. ALWAYS SEND.'
  : ''}
  CLOSE GAME CONTEXT: Compound accuracy plateaus at 75% in close games (margin ≤ 8). This is the best close-game accuracy the system has ever produced (up from 51% at first fire and 69% with old graduation), but it is an edge, not a certainty. Communicate honestly in body.
  ${ctx.positionClosed ? 'POST-EXIT RE-ENTRY: Position was previously closed via EXIT. Compound has RESET — these 5 holds are FRESH post-EXIT readings, not carryover. ' + (ctx.compoundPath === 'Q2_EARLY' ? 'Q2 re-entry requires lead ≥5 and 0 flips since EXIT.' : 'Standard re-entry threshold applies (MC Cum ≥ 0.80 + Floor ≥ 0.65, 5 holds).') + ' Verify via per-quarter breakdown that structural signals are genuinely post-EXIT, not cumulative anchoring. Reference the EXIT reasoning from PRIOR ALERT REASONING TRAIL — what specifically broke? Has it been fixed? If the same weaknesses persist, SUPPRESS regardless of compound confirmation.' : ''}
  MF trajectory provides additional context on the structural trend:
  - RISING MF = structural thesis is building. Increases PO confidence.
  - DECLINING MF = floor eroding despite compound holding. MC Cum is more reliable than floor in this scenario, but flag as context and check per-quarter breakdown.
  Also check: Full CP trend (all, unfiltered) gives the trajectory including bad stretches. If MF says RISING but full CP trend says DECLINING, compound may overstate current control.
  This IS a position recommendation. Body should reference the tracking arc (if prior TRACKING alert exists), explain the compound confirmation, current structural picture, and frame as: "Position open on [TEAM] — structural edge confirmed." Include odds/ML if available.
```

### 3C. VALUE Rule — MINOR (swap "graduation badge" references)

**CURRENT keeps concept, change two references:**

Replace: "graduation badge is stale anchoring from pre-EXIT dominance"
With: "compound confirmation is stale anchoring from pre-EXIT dominance"

Replace: "graduation badge may overstate current control"
With: "compound confirmation may overstate current control"

Rest of VALUE rules (erosion, floor-margin signal, conviction trend, deficit depth) stay exactly as-is.

### 3D. THESIS_ALIVE Rule — NO CHANGE

All references are structural (I1+I4, TP path, opponent profile). No graduation references.

### 3E. EXIT Rule — UPDATED for windowed XGB + MC Cum gate

**NEW:**
```
- EXIT: Structural position has deteriorated. Two independent signals agree:
  (1) Windowed XGB (2Q cross-fade): reads recent structural data, detects decay faster than cumulative stats. Dropped below 0.45 threshold.
  (2) MC Cum (game-rate simulation): confirms the structural shift is sustained across full-game rates, not just a brief window. Dropped below 0.70.
  ${ctx.exitSeverity?.windowedXgb != null ? 'Windowed XGB: ' + (ctx.exitSeverity.windowedXgb * 100).toFixed(1) + '% (threshold: 45%). ' : ''}${ctx.exitSeverity?.mcCumAtExit != null ? 'MC Cum: ' + (ctx.exitSeverity.mcCumAtExit * 100).toFixed(1) + '% (gate: 70%). ' : ''}${ctx.exitSeverity?.ctrlMatchesBWC === false ? 'NOTE: Structural control has ALSO flipped to ' + ctx.exitSeverity.ctrlTeam + ' — triple confirmation (XGB + MC + control flip).' : ctx.exitSeverity?.ctrlMatchesBWC === true ? 'NOTE: ' + ctx.bwcTeam + ' still holds structural control but underlying stats are deteriorating — this is the slow bleed that cumulative indicators miss.' : ''} Position state: ${ctx.exitSeverity?.bwcState || 'unknown'}.
  The SUBSCRIBER'S POSITION is on ${ctx.bwcTeam || 'the tracked team'}. Frame the exit around the underlying stats declining. Reference the full arc from prior alerts.
  EXIT on confirmed positions is ALWAYS SEND. Your job is the narrative — what changed in the underlying stats, whether this looks permanent or temporary, and what the subscriber should watch for.
  Floor-margin confirmation: CONVERGING_DOWN + conviction DEGRADING = strong EXIT confirmation (genuine structural death). DIVERGING_POSITIVE (floor low but margin growing) = structural floor is stale while the team is actually winning — flag this honestly but still SEND.
```

### 3F. BWC_EDGE Rule — MINOR WORDING

Replace: "The graduation badge does not guarantee current structural control"
With: "Compound confirmation does not guarantee current structural control"

Rest stays exactly as-is.

### 3G. BUY Rule — STRATEGIC REWRITE of lifecycle section

**KEEP EXACTLY AS-IS (validated, drives accuracy):**
- All BUY EVIDENCE section (trail depth, indicator profiles, power pairs, opponent kills, timing, XGB calibration)
- I3 INVERSION finding
- FLIP BUY rules
- CANDIDATE BUY rules
- XGB quarter rules

**REWRITE: Lifecycle section → Position Tracking context**

**CURRENT (~50 lines of rank-based lifecycle)**

**NEW:**
```
  POSITION TRACKING CONTEXT FOR BUY DECISIONS:
  The BUY team's relationship to position tracking determines baseline confidence:

  - BUY team = tracked team with CONFIRMED/LOCKED position: "Warm BUY" — compound structural signals sustained, team trailing is the thesis working. The position was mechanically validated through MC Cum ≥ 0.80 + Floor ≥ 0.65 for 5+ consecutive polls. MF trajectory tells you if the structural trend is holding.
  - BUY team = tracked team with RECOVERING position: "Warm BUY with caution" — position confirmed after control flip, 73% baseline. Trailing could be the thesis (structural team behind on variance) or the original instability reasserting. Check conviction trend and per-quarter breakdown.
  - BUY team = tracked team, TRACKING only (compound not confirmed): System identified structural interest but compound signals never sustained. Lower confidence — rely entirely on standard BUY evidence. This is a cold BUY with partial context.
  - BUY team = original tracked team but tracking FLIPPED to opponent: Near-automatic SUPPRESS. This team LOST structural control. You are buying against the confirmed structural direction.
  - BUY team = opponent of tracked team (not flipped): Evaluate independently. If opponent has confirmed, their structural case is strong.
  - No tracking context at all: Cold BUY — rely entirely on standard BUY evidence above.

  HOW TO USE MF TRAJECTORY ON BUY DECISIONS:
  - RISING = structural thesis is building, not fading. Trailing is more likely variance. Increases BUY confidence.
  - FLAT = structural edge is real but not separating. Apply standard BUY scrutiny from evidence above.
  - DECLINING = the game may have shifted since position confirmation. The compound confirmed earlier — check if indicators that powered it are still held. Extra skepticism.
  - INSUFFICIENT = fewer than 2 eligible checkpoints. Rely on standard BUY evidence.

  POSITION TRACKING AMPLIFIERS:
  - CONFIRMED/LOCKED + RISING MF = highest confidence warm BUY. Sustained compound + building structural trend + trailing at plus money.
  - RECOVERING + DECLINING MF = lowest confidence. Position contested AND structural trend fading.

  DEFICIT DEPTH + POSITION TRACKING: trail 5-9 with confirmed position = structural thesis may be wrong despite compound, apply extra scrutiny. Trail 10+ with confirmed position = near-automatic SUPPRESS.

  HOW TO USE CONTROL FLIPS ON BUY DECISIONS:

  CONFIRMED POSITION (compound confirmed, subscriber holds position):
  Compound confirmed after sustained structural signals. Trailing is the thesis working. Control flips provide risk context.
  - 0 flips = strongest warm BUY. Structural thesis unchallenged — trailing is pure variance.
  - 1-2 flips = warm BUY with caution. Note flips in RISK line. Apply standard BUY evidence.
  - 3+ flips = extreme skepticism. Structural control REPEATEDLY contested. The compound may reflect cumulative anchoring rather than current dominance. Rely entirely on standard BUY evidence (deficit depth, indicator profile, opponent indicators). Do NOT treat compound confirmation as confidence — treat it as context only. SUPPRESS unless BUY evidence is independently strong (trail 1-4, 3+ indicators, opp 0 structural indicators).

  POSITION CLOSED (EXIT was sent — thesis previously broke):
  Compound has RESET after EXIT. What matters is whether compound has re-confirmed with FRESH holds post-EXIT.
  - If compound re-confirmed post-EXIT: re-entry is credible — team proved it can sustain structural signals AFTER the thesis broke. Still requires evidence that the specific structural failures from the EXIT have been fixed. Reference EXIT reasoning from PRIOR ALERT REASONING TRAIL.
  - If compound NOT re-confirmed post-EXIT: the position thesis failed and hasn't been mechanically restored. Near-automatic SUPPRESS unless BUY evidence is independently overwhelming.
  - In BOTH cases: reference the agent's prior EXIT reasoning. What specific structural failures caused the EXIT? Have those indicators flipped back? If the same weaknesses persist, SUPPRESS regardless.
```

### 3H. STRUCTURAL STRESS CHECK — MINOR WORDING

**NEW:**
```
- STRUCTURAL STRESS CHECK: When combined read is COLLAPSING, FLIPPED, or SHIFT, the cumulative floor may be anchored from earlier-quarter dominance that has since eroded. The rolling window shows who is winning RECENT quarters.
  For entry signals (BUY, VALUE, THESIS_ALIVE): COLLAPSING + trailing = near-automatic SUPPRESS. SHIFT = extreme skepticism.
  For position alerts (POSITION_OPEN, BWC_EDGE, POSITION_SAFE, POSITION_RECOVERING): When the rolling window is SIGNIFICANTLY weaker than the cumulative floor, you MAY SUPPRESS or DOWNGRADE — this OVERRIDES the per-alert-type rules above. Compound confirmation does not guarantee CURRENT structural control. Evaluate whether the indicators that powered the position are still held in recent quarters using the per-quarter breakdown. If recent quarters show the opponent winning paint, disruption, or game control, the compound is stale.
  DOWNGRADE is preferred over SUPPRESS for POSITION_OPEN (subscriber should know confirmation happened but that it is contested).
  BWC_EDGE and POSITION_SAFE may fully SUPPRESS (these are updates to existing positions — no value in reassuring about a compromised position).
  EXEMPT from stress override: EXIT on confirmed positions (always SEND), TRACKING (always SEND), LOCKED with 0 flips (strongest signal, sustained across 10+ polls — stress override should not touch).
  REINFORCING (DOMINANT/STRONG combined read) = cumulative floor is trustworthy, proceed normally.
```

### 3I. MC_COLLAPSE Rule — MINOR WORDING

Replace: "Do not reference the dead team's floor or graduation state"
With: "Do not reference the dead team's floor or position tracking state"

Rest stays exactly as-is.

### 3J. XGB_INVALIDATED Rule — NO CHANGE

Already correctly references BUY position, not graduation.

### 3K. All XGB REASONING rules — NO CHANGE

Already independent of graduation. SHAP-based, not rank-based.

---

## 4. formatSonnetPrompt CHANGES

The auto-analysis Opus prompt also receives graduation context. Changes mirror the agent prompt:

- Replace `graduationCtx` parameter with compound tier/holds/path
- Replace graduation context string with position tracking context
- Keep MF trajectory, floor-margin signal, conviction trend (checkpoint functions stay)
- Add windowed XGB context alongside cumulative XGB

---

## 5. WHAT STAYS EXACTLY AS-IS (critical for BUY accuracy)

The following prompt sections are UNCHANGED:
- All BUY EVIDENCE (trail depth, indicators, power pairs, opponent kills, timing)
- I3 INVERSION finding
- XGB BUY CALIBRATION numbers
- XGB REASONING section (SHAP interpretation, decision guidance)
- CONVICTION QUALITY interpretation
- MC_COLLAPSE handling (CLEAN/WAVE/NORMALIZED/FALSE_ALARM)
- CANDIDATE BUY evaluation rules
- FLIP BUY rules
- ANCHORED FLOOR CHECK
- EARLY GAME NOTE
- TP/LS context interpretation
- BODY RULES (plain English, lead with action)
- FLOOR RELIABILITY
- SIGNAL TRUST HIERARCHY
- All MC trajectory and MC driver context

---

## 6. STRATEGIC SUMMARY

**What this spec removes:** ~120 lines of graduation rank machinery (4 functions + constants) + ~50 lines of rank-conditional prompt logic. ~170 lines net removal.

**What this spec adds:** ~30-line compound function + ~60 lines of compound-aware prompt rules. ~90 lines net addition.

**Net:** System becomes ~80 lines simpler while preserving ALL validated decision signals.

**BUY accuracy protection:** Every BUY decision signal that has been validated stays: trail depth, indicator profiles, MF trajectory, floor-margin divergence, conviction trend, XGB calibration, opponent indicator kills, flip context. The ONLY change to BUY rules is swapping rank-based lifecycle (A-Rank warm buy, B-Rank moderate, C-Rank cold) for compound-tier lifecycle (CONFIRMED/LOCKED warm, RECOVERING warm-with-caution, TRACKING cold). The decision criteria are equivalent but cleaner.

**Position accuracy improvement:** Compound (86% confirmed, 75% close games) beats graduation (A-rank 74-93% variable, first-fire 51%). MC Cum solves the A-with-flips problem (58.5% → 93.3% with MC≥0.80). Q2 early path at 95.5% is new — graduation couldn't confirm this early.

**EXIT accuracy improvement:** Windowed XGB + MC Cum gate (73% precision, 80% recall) vs cumulative XGB alone (~50% precision). Catches structural decay faster. 2 missed losses are blowout reversals already caught by PBP canary.

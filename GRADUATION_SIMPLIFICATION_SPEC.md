# GRADUATION SIMPLIFICATION SPEC v4
## Compound threshold position confirmation + EXIT compound (MC Cum + Windowed XGB)

**Date:** May 7, 2026 (v4 — full prompt text, corrected dead code, trajectory functions preserved)
**Status:** SPEC — awaiting confirmation before implementation
**Risk Level:** HIGH — touches agent prompts, PO firing, EXIT logic, alert context, learning agent
**Backup:** backups/graduation-pre-simplification/ at commit daa0dbe

---

## 0. TERMINOLOGY

- **Position tracking** replaces "BWC tracking." The state where the system has identified structural control but not yet confirmed a position.
- **Position open / confirmed** = compound threshold met for 5 consecutive polls.
- **S/A/B/C ranks are retired.** Replaced by confidence tiers: TRACKING → CONFIRMED → RECOVERING → LOCKED.
- **Warm BUY** = BUY where position tracking has compound-confirmed the team. **Cold BUY** = no tracking context or TRACKING only.

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

**Why 5 polls:** 5 consecutive deduped polls = ~2.5 min game clock = ~5 min wall clock. Production-validated on 48 playoff games with backfilled MC Cum (500 sims, production-equivalent). Accuracy climbs from 78.7% (1 hold) to 81.8% (5 holds) with minimal coverage loss (47→44 games).

**Why lead>=5 in Q2:** Every Q2 game where compound fires at margin 0-4 is a loss (3/3). The margin gate filters games where Q2 MC is overconfident in close situations. Q3+ does not need a margin gate because MC calibration improves with game time.

**Why 0 flips required for Q2:** Q2 with flips = untested control. By Q3+, a flip followed by 5 sustained holds proves the team re-established control through challenge.

### 2B. Confidence Tiers

| Tier | Condition | Accuracy | Subscriber alert? |
|---|---|---|---|
| TRACKING | Position tracking started, compound not yet met | n/a | No — internal only |
| CONFIRMED | 5 holds, 0 prior flips | 86% | Yes → POSITION_OPEN |
| RECOVERING | 5 holds, 1+ prior flips | 73% | Yes → POSITION_OPEN (agent notes lower confidence) |
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
- **STALE POLL GUARD:** Only counts a hold when game clock has advanced since the last counted hold. Stores `lt.compound_last_period` and `lt.compound_last_clock`. If current (period, clock) matches stored values, skip — do not increment or reset. This prevents hold inflation during timeouts, halftime, quarter transitions, and concurrent cron invocations. The 5-hold threshold was validated on deduped data (one reading per unique game-clock moment) — production must match.
- Resets compound_holds to 0 when compound threshold is not met (on a non-stale poll)
- Resets compound_holds to 0 on control flip (streak requires same team throughout)
- Returns { confirmed, tier, holds, path }
- Q2 path adds lead>=5 and 0-flip requirements
- Concurrent invocation under-count (last-write-wins) makes system marginally more conservative — expected behavior, not a bug

**POST-CONFIRMATION BEHAVIOR:**

`compound_tier` is a **watermark** — it only upgrades, never degrades:
```
null → TRACKING → CONFIRMED/RECOVERING → LOCKED
```
`compound_holds` is the **live streak** — resets to 0 when compound threshold breaks on a non-stale poll.

After CONFIRMED fires at 5 holds, if MC Cum drops to 0.78 on the next poll, compound_holds resets to 0 but compound_tier stays CONFIRMED. The agent sees both: "CONFIRMED position (0 current holds)" — useful stress context for BUY and POSITION_SAFE decisions. A warm BUY stays warm during a brief dip.

LOCKED upgrade (10 holds, 0 flips) requires 10 consecutive in a **single unbroken streak**. If the streak breaks at 7 and restarts, the new streak starts at 0 — need a fresh 10.

**EXIT resets compound entirely.** When EXIT fires, compound_tier resets to TRACKING, compound_holds resets to 0, compound_confirmed resets to false. Re-entry requires a fresh 5-hold streak meeting the same confirmation criteria for the current quarter (Q2 rules if still in Q2, Q3+ rules if in Q3+). This is the same bar as initial entry — no carryover from pre-EXIT dominance.

**Q2→Q3 STREAK CARRYOVER:**

If a team has 4 compound holds in Q2, the stale poll guard pauses the streak during halftime. When Q3 starts and hold 5 fires, confirmation evaluates under **Q3+ STANDARD rules** (no margin or flip gate), not Q2 EARLY rules. Q2_EARLY means confirmation completed during Q2 — if it spills into Q3, the team didn't sustain long enough to confirm before halftime.

**lt FIELD INVENTORY (consolidated):**

New fields:
| Field | Type | Purpose |
|---|---|---|
| `lt.compound_holds` | int | Live consecutive streak count (resets on break) |
| `lt.compound_tier` | string | Watermark tier — only upgrades (TRACKING/CONFIRMED/RECOVERING/LOCKED) |
| `lt.compound_confirmed` | bool | Has compound ever confirmed this tracking period |
| `lt.compound_path` | string | Q2_EARLY or STANDARD |
| `lt.compound_mc_at_confirm` | float | MC Cum when first confirmed (null if not yet) |
| `lt.compound_last_period` | int | Stale poll guard — last period where hold was counted |
| `lt.compound_last_clock` | string | Stale poll guard — last clock where hold was counted |

Dead fields (remove from death clearing + v2Ctx):
| Field | Replaced by |
|---|---|
| `lt.cp_peak_rank` | `lt.compound_tier` |
| `lt.cp_graduation` | `lt.compound_confirmed` + tier |
| `lt.cp_opp_graduation` | opponent compound tracking |
| `lt.cp_mean_floor` | `lt.compound_mc_at_confirm` |
| `lt.cp_min_floor` | (dropped — no longer needed for gates) |
| `lt.cp_eligible_count` | `lt.compound_holds` |

Kept fields (checkpoint capture + flip tracking — NOT graduation):
| Field | Reason |
|---|---|
| `lt.cp_holds` | Checkpoint capture loop counter |
| `lt.cp_opp_holds` | Opponent checkpoint holds for flip PO |
| `lt.cp_ctrl_flips` | Control flip count (agent risk context) |

### 2E. PO Firing Logic

checkCompoundConfirmation() returns confirmed: true AND !lt.po_fired → PO fires.

- PO stores tier string (CONFIRMED/RECOVERING/LOCKED)
- Suppress throttle (escalating 3/6/12 min) UNCHANGED
- PO_ACTIVE sentinel still written to game_checkpoints
- lt.po_fired: { team, tier, period, clock, holds, path, mc, floor }

### 2F. Flip PO Logic

Opponent compound confirmation — opponent floor/MC Cum must meet compound threshold for 5 holds while opponent has control.

- lt.cp_opp_holds tracking STAYS
- **OPPONENT STALE POLL GUARD:** Same dedup as primary compound — only counts opponent hold when (period, clock) has advanced. Stores `lt.compound_opp_last_period` and `lt.compound_opp_last_clock`.
- Opponent must be more recent controller
- Flip PO fires POSITION_OPEN with flipped: true

### 2G. Death Clearing

Clears all compound state: lt.compound_holds, lt.compound_tier, lt.compound_confirmed, lt.compound_path, lt.compound_mc_at_confirm, lt.compound_last_period, lt.compound_last_clock, lt.compound_opp_last_period, lt.compound_opp_last_clock
DELETE FROM game_checkpoints on death STAYS for PO_ACTIVE cleanup.

### 2H. v2Ctx Field Changes

**REMOVE from v2Ctx:**
- `cpPeakRank` → replaced by `compoundTier`
- `cpGraduation` → replaced by compound confirmation data
- `cpOppGraduation` → opponent tracking simplified (stays as concept)
- `lane` → lanes removed (compound thresholds are universal)
- `cpMeanFloor` → no longer used for gates (MF trajectory stays as agent context)
- `cpMinFloor` → no longer used for gates
- `cpEligibleCount` → replaced by `compoundHolds`

**ADD to v2Ctx:**
- `compoundTier` — TRACKING/CONFIRMED/RECOVERING/LOCKED (string)
- `compoundHolds` — consecutive compound hold count (int)
- `compoundPath` — Q2_EARLY or STANDARD (string)
- `mcCumAtConfirmation` — MC Cum when compound first confirmed (float, null if not confirmed)
- `priorFlips` — control flips before confirmation (int)

**KEEP UNCHANGED:**
- `mfTrajectory` — still computed from checkpoints (computeMFTrajectory stays)
- `fullCPTrend` — still computed from checkpoints (computeFullCPTrend stays)
- `floorMarginSignal` — still computed from checkpoints (computeFloorMarginSignal stays)
- `convictionTrend` — still computed from checkpoints (computeConvictionTrend stays)
- `cpCtrlFlips` — stays (controls flip context for agent)
- `bwcFlipped`, `isSecondBwc`, `deadTeam`, `deadHadPO`, `deadRank` — death/flip context stays
- `positionClosed`, `buyPosition` — stay
- ALL erosion fields, floor reliability, XGB, SHAP, MC, conviction quality — unchanged
- `pregameML` — stays (useful context)

### 2I. Alert INSERT Changes

Alert INSERT (line ~7018) — reuse existing columns with new semantics:
- `graduation_rank` column → store compound tier string (CONFIRMED/RECOVERING/LOCKED/TRACKING)
  - Old: `${lt.po_fired?.rank || null}` → New: `${lt.po_fired?.tier || lt.compound_tier || null}`
- `cp_eligible_count` column → store compound_holds count
  - Old: `${lt.cp_eligible_count || null}` → New: `${lt.compound_holds || null}`
- `cp_mean_floor` → store MC Cum at confirmation (or current MC Cum)
  - Old: `${lt.cp_mean_floor || null}` → New: `${lt.compound_mc_at_confirm || null}`
- `cp_ctrl_flips` → store prior flips count (semantics unchanged)
- `lane` → `${null}` (lanes removed, column stays for historical data)

No new columns needed. No schema migration.

### 2J. Snapshot INSERT Changes

Two snapshot INSERT locations write `grad_rank` column:

**NBA path (line ~6424):**
- Old: `${_snapLT?.cp_peak_rank || null}`
- New: `${_snapLT?.compound_tier || null}`
- Writes compound tier per snapshot (TRACKING/CONFIRMED/RECOVERING/LOCKED or null)

**NCAAMB path (line ~8012):**
- Old: `${lt?.cp_peak_rank || null}`
- **NO CHANGE** — NCAAMB keeps classifyRank, continues writing S/A/B/C

`bwc_state` column at both locations: **NO CHANGE** — still writes LOCK/EDGE/VALUE from `_prev_bwc_state`.

### 2K. Post-Game Agent Changes (~30 lines across 4 blocks)

**Block 1: GRADUATION RANK ACCURACY (lines 333-368):**
Replace A/B rank bucketing with compound tier bucketing:
```javascript
const tierAccuracy = {
  CONFIRMED: { correct: 0, total: 0 },
  RECOVERING: { correct: 0, total: 0 },
  LOCKED: { correct: 0, total: 0 },
};
poAlerts.forEach(po => {
  const bucket = tierAccuracy[po.tier];
  if (!bucket) return;
  bucket.total++;
  if (po.ctrlWon) bucket.correct++;
});
```
Log line: `Position: CONFIRMED X/Y (Z%) | RECOVERING X/Y (Z%) | LOCKED X/Y (Z%)`

**Block 2: Suppressed rank breakdown (line 386-387):**
- Old: `${a.graduation_rank}_${a.wouldBeCorrect ? 'miss' : 'save'}`
- New: `${a.graduation_rank}_${a.wouldBeCorrect ? 'miss' : 'save'}` — same code, new values (CONFIRMED/RECOVERING/LOCKED instead of A/B)

**Block 3: Opus prompt line (line 441):**
- Old: `Grad: ${full.graduation_rank || '-'}-Rank MF=${full.mf_trajectory || '-'} stress=${full.combined_read || '-'} CPs=${full.cp_eligible_count || '-'} flips=${full.cp_ctrl_flips != null ? full.cp_ctrl_flips : '-'} lane=${full.lane || '-'}`
- New: `Position: ${full.graduation_rank || '-'} (${full.cp_eligible_count || '-'} holds) MF=${full.mf_trajectory || '-'} stress=${full.combined_read || '-'} flips=${full.cp_ctrl_flips != null ? full.cp_ctrl_flips : '-'}`
- Drops: `lane` reference, `-Rank` suffix. Adds: holds count context. Changes: "Grad" → "Position"

**Block 4: Arc detail output (line 719):**
- Old: `gradRank: a.terminal.graduation_rank`
- New: `compoundTier: a.terminal.graduation_rank` — field rename in output JSON, reads same column

### 2L. v3.html Changes

**Snapshot history column (line 2859):**
- Column label stays "Grad" (or rename to "Tier" — optional)
- Color mapping update:
  - Old: `A=green, B=amber, C=dim`
  - New: `LOCKED=var(--green), CONFIRMED=var(--green), RECOVERING=var(--amber), TRACKING=var(--fg-dim)`
- Value display: show first letter or abbreviated tier (L/C/R/T) for column width

**Two `_snapCols` defaults (lines 2736, 2926, 2940):** `grad:true` stays.

### 2M. formatSonnetPrompt Changes

Replace graduation context injection with compound state. Keep trajectory signal injections (MF trajectory, floor-margin signal, conviction trend) — they still compute from checkpoints.

No schema migrations needed.

---

## 3. EXIT COMPOUND (validated May 6)

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

Both are blowout reversals where cumulative anchoring prevents MC Cum from dropping. The PBP canary catches both through the investigation pipeline — subscribers still get MC_COLLAPSE.

**3 false positives (structurally correct exits):**
- LAL@HOU (MC Cum 0.169, margin -4): genuinely losing, won in OT
- CLE@TOR OT (MC Cum 0.487, margin 0): overtime coin flip
- ORL@DET (MC Cum 0.715, margin 2): borderline threshold

All three were structurally correct reads — the team was losing at EXIT time and recovered.

### 3D. Why PBP MC Doesn't Gate EXIT

PBP MC (20-possession window) fires on 70% of both true and false exits. Too volatile — a 20-possession run triggers it whether the shift is permanent or temporary. MC Cum is smoother and only drops below 0.70 when the structural shift has infected full-game rates.

Signal roles:
- **Windowed XGB** = early structural decay detector (fires first, most sensitive)
- **MC Cum** = confirmation of sustained shift (smoother, less reactive)
- **PBP MC** = investigation trigger (catches collapses for MC_COLLAPSE alert, not for EXIT gating)
- **Floor** = narrative context + indicator decomposition (too anchored for decisions)

### 3E. Implementation — checkXGBExit() Changes

Modify existing checkXGBExit() (~10 lines changed):

1. Add MC Cum gate: `if (mcCumWinProb >= 0.70) return false;` before threshold check
2. Pass `mcCumWinProb` as new parameter
3. Threshold stays 0.45, confirmation stays 2-poll 90s, fast-path stays 0.15
4. Recovery stays >= 0.50 (was threshold + 0.05)
5. **On EXIT fire:** Reset compound state — lt.compound_tier = 'TRACKING', lt.compound_holds = 0, lt.compound_confirmed = false, lt.compound_path = null, lt.compound_mc_at_confirm = null. Set lt.position_closed = true. Re-entry requires fresh 5-hold streak under current quarter's rules (same bar as initial entry).

Call site changes:
- `_xgbBwcProb` already computed from windowed features (extractXGBFeatures uses window stats since windowed XGB deploy)
- Pass mc_win_prob (already available from always-on MC trajectory)

### 3F. Infrastructure Deployed

`backfill_mc_pbp` phase added to mc-backtest.mjs (commit c956442). All 48 playoff games backfilled (5,407 snapshots).

---

## 4. SIGNAL ROLES (validated May 6)

| Signal | Best at | Weakness | Role |
|---|---|---|---|
| Windowed XGB (2Q) | Early structural decay, recency | Noisy in Q2 (only 1Q of data) | EXIT trigger, entry gates |
| MC Cum (full game) | Sustained probability, calibration | Cumulative anchoring in blowouts | EXIT gate, position confirmation |
| PBP MC (20 poss) | Real-time collapse detection | Too volatile for gating | Investigation trigger |
| Floor (cumulative) | Indicator decomposition, narrative | Anti-predictive in lead-change games | Agent context via trajectory functions |
| XGB Cum (full game) | Stable structural read | Misses 2/10 collapses entirely | Replaced by windowed for EXIT |

**Trajectory functions (checkpoint-based, KEPT for agent context):**

| Function | Signal | Used by |
|---|---|---|
| computeMFTrajectory | RISING/FLAT/DECLINING floor trend | BUY amplifiers, PO context |
| computeFloorMarginSignal | DIVERGING_POSITIVE/CONVERGING_DOWN | VALUE override, EXIT confirmation |
| computeConvictionTrend | STABLE/DEGRADING/IMPROVING | VALUE, BUY scrutiny |
| computeFullCPTrend | Unfiltered floor trajectory | Cross-check on MF trajectory |

Trust hierarchy by quarter (unchanged):
- Q2: Floor ≈ XGB > MC (MC off calibration by 10pp)
- Q3: MC ≈ XGB > Floor
- Q4: MC > XGB > Floor

---

## 5. DEAD CODE TO REMOVE

### Functions (~120 lines):
- `computeCheckpointFloorStats()` (2483-2500) — eligible CP stats feeding graduation MF/minF gates
- `recomputeCheckpointState()` (2632-2700) — graduation rank computation (S/A/B/C)
- `getLaneGates()` (2699-2703) — lane-specific MF/minF thresholds

### Constants:
- `LANE_THRESHOLDS` (2308-2311) — dead

### KEEP (agent context — NOT graduation machinery):
- `computeMFTrajectory()` (2502-2531) — floor direction signal
- `computeFullCPTrend()` (2533-2562) — unfiltered floor trajectory
- `computeFloorMarginSignal()` (2564-2597) — floor vs margin divergence
- `computeConvictionTrend()` (2599-2630) — conviction stability
- `classifyRank()` — NCAAMB uses it
- `computeTrajectorySignals()` — XGB SHAP trajectory (uses checkpoint SHAP, independent)
- `computeMeanErosion()` — uses poll-level floor sums, independent
- `GRAD_CHECKPOINTS` — still drives checkpoint capture + NCAAMB
- `lt.cp_opp_holds` — flip PO tracking

---

## 6. AGENT PROMPT — FULL TEXT

This section contains the exact prompt text for every rule that changes. Sections marked NO CHANGE are listed for completeness but their text stays exactly as currently deployed.

### 6A. Data Injection — POSITION TRACKING Section

**Replaces the graduation context line at ~556-562. Trajectory signals (MF, floor-margin, conviction, full CP) stay in the POSITION HEALTH block — they still compute from checkpoints.**

```javascript
// Build position tracking context string (replaces graduation context)
const compoundCtxStr = ctx.compoundTier === 'CONFIRMED' || ctx.compoundTier === 'RECOVERING' || ctx.compoundTier === 'LOCKED'
  ? 'Position: ' + ctx.compoundTier + ' (' + ctx.compoundHolds + ' compound holds, ' + ctx.compoundPath + ' path)'
    + ' | MC Cum at confirmation: ' + (ctx.mcCumAtConfirmation != null ? (ctx.mcCumAtConfirmation * 100).toFixed(1) + '%' : '?')
    + ' | Prior flips: ' + (ctx.priorFlips || 0)
    + ' | Control flips (game total): ' + ctx.ctrlFlips
  : 'Pre-confirmation (' + (ctx.compoundHolds || 0) + ' compound holds toward threshold)'
    + ' | Control flips: ' + ctx.ctrlFlips;
```

This replaces the old graduation context line. The rest of the POSITION HEALTH block stays:
```
POSITION HEALTH:
Peak floor: ... | Mean floor: ... | Current: ...
Erosion: ... (peak-anchored / mean-anchored)
${compoundCtxStr}
${mfTrajStr}
${fullCPTrend context}
${convictionTrend context}
Consecutive holds: ...
Position lifecycle: ...
${positionClosed context}
${buyPosition context}
```

### 6B. Data Injection — EXIT Severity Addition

**Add to existing EXIT severity block in v2Ctx prompt:**
```javascript
${ctx.exitSeverity?.windowedXgb != null
  ? 'Windowed XGB (2Q): ' + (ctx.exitSeverity.windowedXgb * 100).toFixed(1) + '% — reads recent structural data, detects decay faster than cumulative.'
  : ''}
${ctx.exitSeverity?.mcCumAtExit != null
  ? 'MC Cum at EXIT: ' + (ctx.exitSeverity.mcCumAtExit * 100).toFixed(1) + '% — confirms sustained shift (gate: < 70%).'
  : ''}
```

### 6C. Rules — TRACKING (minor wording only)

```
- TRACKING: First structural signal — the system has identified ${ctx.ctrlTeam} as structurally interesting (floor ${ctx.floor}, margin ${ctx.margin}). This is NOT a position recommendation — the subscriber learns a game is on the radar. ALWAYS SEND unless the game is clearly meaningless (garbage time, both teams eliminated, period 4 with < 2 min left). Body should explain: which team, what structural picture (indicators, floor, margin), and that we are watching for the edge to develop. Frame as: "Watching [TEAM] — [why they look structurally dominant]. Will update if this develops into a position." Keep it short — this is a heads-up, not a thesis.
```

### 6D. Rules — POSITION_OPEN (MAJOR REWRITE)

```
- POSITION_OPEN: The team has sustained compound structural signals — MC Cum ≥ 0.80 AND Floor ≥ 0.65 — for 5 consecutive polls (~2.5 minutes game clock). This is a significant structural confirmation.
  ${ctx.compoundTier === 'CONFIRMED' && ctx.compoundPath === 'Q2_EARLY'
    ? 'Q2 EARLY CONFIRMATION (95.5% accuracy): Compound sustained with lead ≥5 and zero prior control flips. Strongest early signal — structural dominance established before halftime with scoreboard separation. ALWAYS SEND.'
    : ctx.compoundTier === 'CONFIRMED'
    ? 'CONFIRMED (86% accuracy, 0 prior flips): Structural position validated. Compound signals sustained without control being contested. Standard confidence — evaluate structural stress and current indicators.'
    : ctx.compoundTier === 'RECOVERING'
    ? 'RECOVERING (73% accuracy, ' + (ctx.priorFlips || '1+') + ' prior flips): Position confirmed after control was contested. Structural edge recovered but game is competitive. The compound held DESPITE flip history — this was earned through challenge. Note lower baseline accuracy in body. Check: are the indicators that slipped during flips back? Is conviction trend STABLE or DEGRADING?'
    : ctx.compoundTier === 'LOCKED'
    ? 'LOCKED (92% accuracy, 10+ sustained holds): Highest-confidence structural read — compound signals sustained across extended evaluation. ALWAYS SEND.'
    : ''}
  ${ctx.isSecondBwc ? 'SECOND POSITION TEAM: ' + ctx.bwcTeam + ' took structural control away from ' + ctx.deadTeam + (ctx.deadHadPO ? ' (who had a confirmed position)' : ' (who was tracking but never confirmed)') + '. The reversal itself is evidence — ' + ctx.bwcTeam + ' earned this through merit after ' + ctx.deadTeam + ' collapsed. ALWAYS SEND.' : ''}
  ${ctx.bwcFlipped ? 'POSITION FLIP: The system originally tracked ' + ctx.originalBwcTeam + ' but they FAILED to confirm. ' + ctx.bwcTeam + ' then confirmed ' + ctx.compoundTier + ' — taking structural control away from a previously dominant team. The floor appears modest because cumulative stats are anchored by ' + ctx.originalBwcTeam + "'s early dominance, but " + ctx.bwcTeam + " is sustaining compound signals DESPITE that headwind. ALWAYS SEND." : ''}
  CLOSE GAME CONTEXT: Compound accuracy plateaus at 75% in close games (margin ≤ 8). This is the best close-game accuracy the system has ever produced (up from 51% at first fire, 69% with old graduation), but it is an edge, not a certainty. Communicate honestly in body.
  ${ctx.positionClosed ? 'POST-EXIT RE-ENTRY: Position was previously closed via EXIT. Compound has RESET — these 5 holds are FRESH post-EXIT readings, not carryover. ' + (ctx.compoundPath === 'Q2_EARLY' ? 'Q2 re-entry requires lead ≥5 and 0 flips since EXIT.' : 'Standard re-entry threshold applies (MC Cum ≥ 0.80 + Floor ≥ 0.65, 5 holds).') + ' Verify via per-quarter breakdown that structural signals are genuinely post-EXIT, not cumulative anchoring. Reference the EXIT reasoning from PRIOR ALERT REASONING TRAIL — what specifically broke? Has it been fixed? If the same weaknesses persist, SUPPRESS regardless of compound confirmation.' : ''}
  MF trajectory provides additional context:
  - RISING MF = structural thesis building. Increases PO confidence.
  - DECLINING MF = floor eroding despite compound holding. MC Cum is more reliable than floor here, but flag as context and check per-quarter breakdown.
  Also check: Full CP trend (all, unfiltered) gives the trajectory including bad stretches. If MF says RISING but full CP trend says DECLINING, compound may overstate current control.
  This IS a position recommendation. Body should reference the tracking arc (if prior TRACKING alert), explain compound confirmation, current structural picture, and frame as: "Position open on [TEAM] — structural edge confirmed." Include odds/ML if available.
```

### 6E. Rules — VALUE (minor wording only)

Replace these specific phrases:
- "graduation badge is stale anchoring from pre-EXIT dominance" → "compound confirmation is stale anchoring from pre-EXIT dominance"
- "graduation badge may overstate current control" → "compound confirmation may overstate current control"

**Rest of VALUE rule stays exactly as-is** (erosion, floor-margin signal, conviction trend, deficit depth, timing, multi-signal SUPPRESS criteria).

### 6F. Rules — THESIS_ALIVE

**NO CHANGE.** All references are structural (I1+I4, TP path, opponent profile).

### 6G. Rules — EXIT (REWRITE)

```
- EXIT: Structural position has deteriorated. Two independent signals agree the edge is gone:
  (1) Windowed XGB (2Q cross-fade) dropped below 0.45 — detects recent structural shifts faster than cumulative stats.
  (2) MC Cum dropped below 0.70 — confirms the shift is sustained across full-game rates, not just a brief window.
  ${ctx.exitSeverity?.windowedXgb != null ? 'Windowed XGB: ' + (ctx.exitSeverity.windowedXgb * 100).toFixed(1) + '% (threshold: 45%).' : ''} ${ctx.exitSeverity?.mcCumAtExit != null ? 'MC Cum: ' + (ctx.exitSeverity.mcCumAtExit * 100).toFixed(1) + '% (gate: 70%).' : ''} ${ctx.exitSeverity?.ctrlMatchesBWC === false ? 'NOTE: Structural control has ALSO flipped to ' + ctx.exitSeverity.ctrlTeam + ' — triple confirmation (XGB + MC + control flip).' : ctx.exitSeverity?.ctrlMatchesBWC === true ? 'NOTE: ' + ctx.bwcTeam + ' still holds structural control but underlying stats are deteriorating — this is the slow bleed that cumulative indicators miss.' : ''} Position state: ${ctx.exitSeverity?.bwcState || 'unknown'}.
  The SUBSCRIBER'S POSITION is on ${ctx.bwcTeam || 'the tracked team'}. Frame the exit around the underlying stats declining. Reference the full arc from prior alerts.
  EXIT on confirmed positions is ALWAYS SEND. Your job is the narrative — what changed in the underlying stats, whether this looks permanent or temporary, and what the subscriber should watch for.
  Floor-margin confirmation: CONVERGING_DOWN + conviction DEGRADING = strong EXIT confirmation (genuine structural death). DIVERGING_POSITIVE (floor low but margin growing) = structural floor is stale while the team is actually winning — flag this honestly but still SEND.
```

### 6H. Rules — BWC_EDGE (minor wording)

Replace: "The graduation badge does not guarantee current structural control"
With: "Compound confirmation does not guarantee current structural control"

Rest stays exactly as-is (SEND by default, RISK line, structural stress override).

### 6I. Rules — POSITION_SAFE / POSITION_RECOVERING

**NO CHANGE.**

### 6J. Rules — BUY (lifecycle rewrite, ALL evidence preserved)

**KEEP EXACTLY AS-IS (validated, drives BUY accuracy):**
- BUY EVIDENCE block (trail depth, indicators, power pairs, opponent kills, timing)
- I3 INVERSION finding
- XGB BUY CALIBRATION numbers (per-quarter, per-XGB-band)
- FLIP BUY rules
- CANDIDATE BUY evaluation

**REPLACE the BWC LIFECYCLE section with:**

```
  POSITION TRACKING CONTEXT FOR BUY DECISIONS:
  The BUY team's relationship to position tracking determines baseline confidence:

  - BUY team = tracked team with CONFIRMED/LOCKED position: "Warm BUY" — compound structural signals sustained (MC Cum ≥ 0.80 + Floor ≥ 0.65 for 5+ consecutive polls). Team trailing is the thesis working. MF trajectory tells you if the structural trend is holding.
  - BUY team = tracked team with RECOVERING position: "Warm BUY with caution" — position confirmed after control flip, 73% baseline. Trailing could be the thesis (structural team behind on variance) OR the original instability reasserting. Check conviction trend and per-quarter breakdown.
  - BUY team = tracked team, TRACKING only (compound not confirmed): System identified structural interest but compound signals never sustained. Lower confidence. Rely entirely on standard BUY evidence. This is a cold BUY with partial context.
  - BUY team = original tracked team but tracking FLIPPED to opponent: Near-automatic SUPPRESS. This team LOST structural control to the opponent. You are buying against the confirmed structural direction. The team that took it away confirmed through compound and wins historically.
  - BUY team = opponent of tracked team (not flipped): Evaluate independently. If opponent has confirmed, their structural case is strong — they earned it against the tracked team.
  - No tracking context at all: Cold BUY — rely entirely on standard BUY evidence above.

  HOW TO USE MF TRAJECTORY ON BUY DECISIONS:
  - RISING = structural thesis is building, not fading. Trailing is more likely variance. Increases BUY confidence.
  - FLAT = structural edge is real but not separating. Apply standard BUY scrutiny from evidence above.
  - DECLINING = the game may have shifted since position confirmation. Extra skepticism — check if indicators that powered the position are still held.
  - INSUFFICIENT = fewer than 2 eligible checkpoints. Rely on standard BUY evidence.

  POSITION TRACKING AMPLIFIERS:
  - CONFIRMED/LOCKED + RISING MF = highest confidence warm BUY. Sustained compound + building structural trend + trailing at plus money.
  - RECOVERING + DECLINING MF = lowest confidence. Position contested AND structural trend fading.

  DEFICIT DEPTH + POSITION TRACKING: trail 5-9 with confirmed position = structural thesis may be wrong despite compound, apply extra scrutiny regardless of trajectory. Trail 10+ with confirmed position = near-automatic SUPPRESS (the structural read was incorrect regardless of compound).

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

### 6K. Rules — STRUCTURAL STRESS CHECK

```
- STRUCTURAL STRESS CHECK: When combined read is COLLAPSING, FLIPPED, or SHIFT, the cumulative floor may be anchored from earlier-quarter dominance that has since eroded. The rolling window shows who is winning RECENT quarters.
  For entry signals (BUY, VALUE, THESIS_ALIVE): COLLAPSING + trailing = near-automatic SUPPRESS. SHIFT = extreme skepticism.
  For position alerts (POSITION_OPEN, BWC_EDGE, POSITION_SAFE, POSITION_RECOVERING): When the rolling window is SIGNIFICANTLY weaker than the cumulative floor, you MAY SUPPRESS or DOWNGRADE — this OVERRIDES the per-alert-type rules above. Compound confirmation does not guarantee CURRENT structural control. Evaluate whether the indicators that powered the position are still held in recent quarters using the per-quarter breakdown. If recent quarters show the opponent winning paint, disruption, or game control, the compound is stale.
  DOWNGRADE is preferred over SUPPRESS for POSITION_OPEN (subscriber should know confirmation happened but that it is contested).
  BWC_EDGE and POSITION_SAFE may fully SUPPRESS (these are updates to existing positions — no value in reassuring about a compromised position).
  EXEMPT from stress override: EXIT on confirmed positions (always SEND), TRACKING (always SEND), LOCKED with 0 flips (strongest signal, sustained across 10+ polls — stress override should not touch).
  REINFORCING (DOMINANT/STRONG combined read) = cumulative floor is trustworthy, proceed normally with per-alert-type rules.
```

### 6L. Rules — MC_COLLAPSE (minor wording)

Replace: "Do not reference the dead team's floor or graduation state"
With: "Do not reference the dead team's floor or position tracking state"

### 6M. Rules — TRACKING_INVALIDATED (minor wording)

Replace: "If the dead team had a graduated position, this is an implicit EXIT"
With: "If the dead team had a confirmed position, this is an implicit EXIT"

### 6N. Rules — NO CHANGE (complete list)

- XGB_INVALIDATED: NO CHANGE
- XGB REASONING: NO CHANGE
- CONVICTION QUALITY: NO CHANGE
- ANCHORED FLOOR CHECK: NO CHANGE
- EARLY GAME NOTE: NO CHANGE
- TP context interpretation: NO CHANGE
- BODY RULES: NO CHANGE
- FLOOR RELIABILITY: NO CHANGE
- SIGNAL TRUST HIERARCHY: NO CHANGE
- MC trajectory/driver context: NO CHANGE
- CANDIDATE BUY rules: NO CHANGE
- FLIP BUY rules: NO CHANGE

---

## 7. PRODUCTION VALIDATION

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

## 8. CASCADING IMPLICATIONS

- Learning agent: LOW risk. Scores on terminal outcome, not tier.
- Subscriber copy: MEDIUM risk. Agent generates all copy, prompt rewrite handles this.
- Position monitoring (LOCK/EDGE/VALUE): CLOSED. No separate alert layer.
- XGB EXIT: IN SCOPE. MC Cum gate added.
- PBP MC canary: NONE. Independent system.
- BUY system: LOW. Lifecycle context fields change, all BUY evidence and decision criteria unchanged.
- NCAAMB: NONE. Separate code path, classifyRank preserved.
- Trajectory functions: NONE. All 4 preserved — they read checkpoints (still captured) and produce agent context (still needed).

---

## 9. IMPLEMENTATION PLAN

**Graduation (Phases 1-11):**
Phase 1: Dead code removal (~120 lines: 3 functions + LANE_THRESHOLDS)
Phase 2: New checkCompoundConfirmation() function (~30 lines)
Phase 3: PO firing logic — replace rank/gate evaluation with compound confirmation (~80 lines changed)
Phase 4: Flip PO — opponent compound tracking (~30 lines)
Phase 5: Death clearing — clear compound_holds, compound_confirmed (~10 lines)
Phase 6: v2Ctx — remove graduation fields, add compound fields (~20 lines)
Phase 7: Agent prompt — POSITION_OPEN, BUY lifecycle, EXIT, stress check (~180 lines replaced with ~100 lines) — HIGHEST RISK
Phase 8: formatSonnetPrompt — graduation context → compound context (~15 lines)
Phase 9: Snapshot INSERT — NBA path writes compound tier to grad_rank (~2 lines changed)
Phase 10: Post-game agent — compound tier bucketing, prompt line, arc output (~30 lines across 4 blocks)
Phase 11: v3.html — compound tier color mapping + column display (~10 lines)
Phase 12: Smoke test

**EXIT Compound (Phases 13-15):**
Phase 13: checkXGBExit() — add MC Cum gate parameter (~10 lines changed)
Phase 14: EXIT call site — pass mc_win_prob to checkXGBExit (~5 lines)
Phase 15: EXIT smoke test

---

## 10. CONFIRMED DEPENDENCIES

1. MC Cum available at compound check time (line 6383, checkpoints at 7065, same scope)
2. lt persisted after compound evaluation (line 7913)
3. classifyRank needed by NCAAMB — do NOT remove
4. Concurrent invocation hold under-count = expected conservative behavior
5. Stale poll guard: compound_last_period + compound_last_clock prevent hold inflation during timeouts/halftime/quarter transitions
6. Checkpoint capture loop unchanged — trajectory functions still have data source
7. computeMeanErosion uses poll-level floor sums — independent of checkpoints/graduation
8. Windowed XGB features already computed for snapshot — reuse for EXIT

---

## 11. FILES MODIFIED

| File | Change | Est. lines |
|---|---|---|
| poll-live-bdl.mjs | Major (graduation + EXIT + snapshot INSERT) | -250, +160 (net -90) |
| post-game-agent.mjs | Moderate (4 blocks: tier bucketing, prompt, output) | ~30 |
| v3.html | Minor (color mapping, column display) | ~10 |
| db-api.js | None | 0 |

No schema migrations. No new tables. No new env vars.

---

## 12. WHAT STAYS EXACTLY AS-IS (BUY accuracy protection)

These prompt sections are UNCHANGED — they drive BUY accuracy and are independent of graduation:
- All BUY EVIDENCE (trail depth, indicators, power pairs, opponent kills, timing, I3 inversion)
- XGB BUY CALIBRATION numbers (per-quarter, per-XGB-band)
- XGB REASONING section (SHAP interpretation, decision guidance)
- CONVICTION QUALITY interpretation
- MC_COLLAPSE handling (CLEAN/WAVE/NORMALIZED/FALSE_ALARM, trust hierarchy with XGB)
- CANDIDATE BUY evaluation rules
- FLIP BUY rules
- ANCHORED FLOOR CHECK
- EARLY GAME NOTE (Q1-Q2 sample size caveat)
- TP/LS context interpretation
- BODY RULES (plain English, lead with action)
- FLOOR RELIABILITY (team-specific win rates)
- SIGNAL TRUST HIERARCHY (quarter-dependent, validated on 14,440 checkpoints)
- All MC trajectory and MC driver context
- Floor-margin signal interpretation (DIVERGING_POSITIVE overrides, CONVERGING_DOWN confirms)
- Conviction trend interpretation (STABLE/DEGRADING/IMPROVING)

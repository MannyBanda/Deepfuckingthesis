# GRADUATION SIMPLIFICATION SPEC
## Replacing multi-checkpoint floor graduation with compound threshold (MC Cum + Floor)

**Date:** May 6, 2026  
**Status:** SPEC — awaiting confirmation before implementation  
**Risk Level:** HIGH — touches agent prompts, PO firing, alert context, learning agent  
**Backup:** `backups/graduation-pre-simplification/` at commit `daa0dbe`

---

## 1. SCOPE

**IN SCOPE:** NBA graduation path in `poll-live-bdl.mjs`. Agent prompts. PO firing logic. v2Ctx construction. Alert fields. Dashboard display. Learning agent graduation references.

**OUT OF SCOPE:** NCAAMB graduation (lines ~7371-7460 — separate system, unchanged). BWC state machine (LOCK/EDGE etc — unchanged). XGB EXIT (unchanged). PBP MC canary (unchanged). BUY/PO decoupled system (unchanged). Alert routing/dedup (unchanged).

---

## 2. WHAT CHANGES

### 2A. New Position Confirmation Logic

**Replaces:** `recomputeCheckpointState()` → S/A/B/C ranks → PO evaluation with MF/minF/lane gates

**New system (two paths):**

```
Q2 EARLY CONFIRMATION:
  3 consecutive checkpoints where:
    MC Cum ≥ 0.85 AND Floor ≥ 0.70 AND ctrl_margin ≥ 5
  → Position confirmed

Q3+ STANDARD CONFIRMATION:
  First checkpoint where:
    MC Cum ≥ 0.80 AND Floor ≥ 0.65
  → Position confirmed
```

**Implementation:** New function `checkCompoundConfirmation(lt, period, floor, mcCum, ctrlMargin)`:
- Tracks `lt.compound_holds` (consecutive Q2 checkpoint count above Q2 threshold)
- Resets `lt.compound_holds` to 0 when a checkpoint fails Q2 threshold
- Returns `{ confirmed: bool, path: 'Q2_EARLY'|'Q3_STANDARD', holds: n }`
- Q3+ is a single-read check — no tracking needed

**Data required at each checkpoint:** `mc_cum_win_prob` (already stored on every snapshot Q2+) and `floor_score` (already computed). Both are available in the polling loop when checkpoints fire.

### 2B. PO Firing Logic (lines ~7223-7300)

**Current:** Graduation rank (A/B/C) → lane gates (MF/minF thresholds) → PO fires or blocks  
**New:** `checkCompoundConfirmation()` returns `confirmed: true` → PO fires

**Changes:**
- Remove `classifyRank()` call in PO evaluation
- Remove `getLaneGates()` / `LANE_THRESHOLDS` usage for PO
- Remove B-rank Q3_6 gate
- Remove MF/minF gate checks
- PO fires when compound is confirmed AND `!lt.po_fired AND ind.controlTeam === bwcTeam AND alertMinsLeft >= 1.0`
- PO rank field: set to `'COMPOUND'` (or keep using A/B for backward compat — see §4)
- Suppress throttle logic (lines ~7219-7237) UNCHANGED — still needed

**The PO_ACTIVE sentinel** still written to `game_checkpoints` for race-safe recovery. The `conv` field stores `'COMPOUND'` instead of `'A'`/`'B'`.

### 2C. Flip PO Logic (lines ~7310-7370)

**Current:** Opponent graduation (B+ rank, 2+ opp holds, more recent than BWC graduation) → flip PO  
**New:** Opponent compound confirmation using same thresholds. The opponent team's floor/MC Cum must meet compound threshold.

**Changes:**
- Replace `lt.cp_opp_graduation` check with compound check on opponent's indicators
- Opponent needs: Floor ≥ 0.65 AND MC Cum ≥ 0.80 (uses current snapshot values, ctrl-relative to opponent)
- Opponent holds ≥ 2 requirement STAYS (prevents single-snapshot flip)
- `lt.cp_opp_holds` tracking STAYS (consecutive opponent checkpoints)
- Remove `lt.cp_opp_graduation` state

**RISK:** MC Cum is computed ctrl-relative. When opponent has control, MC Cum already reflects opponent perspective (it uses `controlTeam` from indicators). Flip PO fires when opponent has control AND their compound is met. This is architecturally consistent — MC Cum at that checkpoint is already from the opponent's POV.

### 2D. BWC Death Graduation Clearing (lines ~6523-6550)

**Current clears:** `lt.cp_graduation`, `lt.cp_opp_graduation`, `lt.cp_mean_floor`, `lt.cp_min_floor`, `lt.cp_eligible_count`, `lt.cp_ctrl_flips`, `lt.cp_peak_rank`

**New clears:** `lt.compound_holds` (Q2 consecutive counter), `lt.compound_confirmed` (if we store this). Everything else that was cleared is now dead — remove.

**DELETE FROM game_checkpoints** on death STAYS — still needed for PO_ACTIVE sentinel cleanup.

### 2E. Checkpoint Capture (Phase B, lines ~7130-7170)

**STAYS UNCHANGED.** Checkpoints are still captured at 3-minute intervals to `game_checkpoints` table. The data (floor, margin, team, conv, xgb, shap) is still valuable for:
- PO_ACTIVE sentinel (race-safe PO recovery)
- Post-game analysis / debugging
- Backtest data pipeline
- NCAAMB graduation (uses same table)

**What changes:** After capture, instead of calling `recomputeCheckpointState()` and deriving S/A/B/C ranks, we call `checkCompoundConfirmation()`.

### 2F. Agent Prompt Rules (lines ~550-730 in formatAgentPromptV2)

**THIS IS THE BIGGEST REWRITE.** ~180 lines of graduation-specific prompt rules need to be replaced.

**What gets removed:**
- All S/A/B/C rank references and rules
- MF trajectory analysis (RISING/DECLINING/FLAT)
- Checkpoint count requirements
- Flip penalty rules
- Lane-based gates discussion
- "Full CP trend" vs "eligible MF" comparison
- POST-EXIT RE-ENTRY graduation validation rules
- B-rank multiple flips scrutiny rules

**What replaces it:**
- Compound state: CONFIRMED (MC≥0.80+Floor≥0.65 met) or PRE-CONFIRMATION
- Q2 early confirmation note if applicable
- Simple flip context: compound was met, then control flipped — is compound still met for new team?
- MC Cum value + Floor value at confirmation point
- POST-EXIT RE-ENTRY: simplified to "compound must be met for re-entry" (no graduated-rank-quality assessment)
- Trust hierarchy reminder: Q2 Floor≈XGB>MC, Q3 MC≈XGB>Floor, Q4 MC>XGB>Floor

**Draft prompt skeleton:**
```
COMPOUND CONFIRMATION:
Status: [CONFIRMED at Q{period} {clock} | PRE-CONFIRMATION]
MC Cum: {value} | Floor: {value} | Margin: {margin}
[Q2 early: {holds}/3 consecutive holds above threshold]
[Ctrl flips since BWC: {count}]
```

### 2G. formatSonnetPrompt Graduation Context (lines ~4506-4525)

**Current:** Outputs graduation rank, MF trajectory, eligible CPs, opponent graduation  
**New:** Outputs compound state, MC Cum/Floor at confirmation, Q2 holds if applicable

### 2H. v2Ctx Construction (lines ~6787-6802)

**Fields that change meaning:**
- `poRank` → set to `'COMPOUND'` (or null if not confirmed)
- `cpMeanFloor` → REMOVED (dead)
- `cpMinFloor` → REMOVED (dead)
- `cpEligibleCount` → REMOVED (dead)
- `cpPeakRank` → REMOVED (dead)
- `cpGraduation` → REPLACED with `compoundConfirmation: { path, period, clock, mc, floor }`
- `cpOppGraduation` → REMOVED (dead)
- `cpCtrlFlips` → STAYS (still useful context)
- `mfTrajectory` → REMOVED (dead)
- `fullCPTrend` → REMOVED (dead)
- `floorMarginSignal` → REMOVED (dead)
- `convictionTrend` → REMOVED (dead)
- `lane` → STAYS (still useful for BUY lane context, pregame ML)

**New fields:**
- `compoundState: 'CONFIRMED'|'PRE_CONFIRMATION'`
- `compoundMC: number` (MC Cum at confirmation)
- `compoundFloor: number` (Floor at confirmation)
- `compoundPath: 'Q2_EARLY'|'Q3_STANDARD'`

### 2I. Alert INSERT (lines ~7010-7040)

**Column mapping (backward compatible — columns stay, values change):**
- `graduation_rank` → `'COMPOUND'` when confirmed, null otherwise
- `mf_trajectory` → null (dead)
- `cp_eligible_count` → null (dead — or repurpose for compound_holds count)
- `cp_ctrl_flips` → STAYS (still tracked via lt.cp_ctrl_flips or lt.ctrl_flips)
- `cp_mean_floor` → null (dead)

**No schema migration needed.** Existing columns accept the new values. Historical data retains old graduation ranks for comparison.

### 2J. Snapshot INSERT (lines ~6409-6425)

**`grad_rank`** column currently stores `lt.cp_peak_rank`. Repurpose to store compound state:
- `'CONFIRMED'` when compound is met
- `null` otherwise

### 2K. Post-Game Learning Agent (post-game-agent.mjs)

**Lines 267-304, 338-387, 440:**
- `graduation_rank` → now reads `'COMPOUND'` instead of `'A'`/`'B'`/`'C'`
- Arc scoring logic at line 338 that keys on `graduation_rank` → simplify
- Line 386 that filters `graduation_rank` for structural scoring → adapt
- Graduation context at lines 295-302 (reads `lt.cp_graduation`) → adapt to new structure

**No fundamental changes to arc scoring logic.** The learning agent scores arcs on terminal alert outcome, not graduation rank.

### 2L. v3.html Dashboard

**Line 2859:** `grad_rank` display in snapshot history. Change color mapping:
- `'COMPOUND'` → green
- null → dim
- Legacy `'A'`/`'B'`/`'C'` still renders correctly for historical data

---

## 3. DEAD CODE TO REMOVE

### Functions (poll-live-bdl.mjs):
| Function | Lines | Reason |
|---|---|---|
| `classifyRank()` | 2411-2418 | Only used by graduation ranking |
| `computeCheckpointFloorStats()` | 2483-2500 | MF/minF computation — graduation-only |
| `computeMFTrajectory()` | 2502-2531 | MF trajectory — graduation-only |
| `computeFullCPTrend()` | 2533-2562 | Full CP trend — graduation-only |
| `computeFloorMarginSignal()` | 2564-2597 | Floor-margin signal — graduation-only |
| `computeConvictionTrend()` | 2599-2630 | Conviction trend — graduation-only |
| `recomputeCheckpointState()` | 2632-2700 | Core graduation engine — replaced |
| `getLaneGates()` | 2701-2703 | Lane gate lookup — graduation-only |

**~290 lines of dead functions.**

### Constants:
| Constant | Line | Reason |
|---|---|---|
| `LANE_THRESHOLDS` | 2306-2311 | Only used by PO lane gates — dead |

**Keep:** `GRAD_CHECKPOINTS` (still used for checkpoint capture timing).

### lt.* fields that become dead:
- `lt.cp_graduation` → replaced by `lt.compound_confirmed`
- `lt.cp_opp_graduation` → dead
- `lt.cp_peak_rank` → dead
- `lt.cp_mean_floor` → dead
- `lt.cp_min_floor` → dead
- `lt.cp_eligible_count` → dead
- `lt.cp_holds` → dead (replaced by `lt.compound_holds`)
- `lt.cp_opp_holds` → STAYS (still used for flip PO opponent hold check)
- `lt.graduation` → dead for NBA (NCAAMB still uses it at line ~7389)

### Agent prompt text:
- Lines ~550-730: ~180 lines of graduation-specific rules → replace with ~40 lines of compound rules
- **Net reduction: ~140 lines**

---

## 4. BACKWARD COMPATIBILITY DECISIONS

### Option A: Keep rank letters
Map compound to existing rank system: CONFIRMED → 'A', PRE_CONFIRMATION → 'C'. Pro: zero changes to consumers. Con: misleading — 'A' no longer means what it used to.

### Option B: New value 'COMPOUND' (RECOMMENDED)
Store `'COMPOUND'` in `graduation_rank` and `grad_rank`. Pro: clean break, historical data distinguishable. Con: consumers that switch on 'A'/'B'/'C' need null checks.

**Recommendation: Option B.** The learning agent and v3.html both handle null/unknown gracefully. `'COMPOUND'` is explicit about the new system.

---

## 5. CASCADING IMPLICATIONS

### 5A. Learning Agent Scoring
**Risk: LOW.** Arc scoring uses terminal alert outcome (ctrl_won vs position_team), not graduation rank. The `graduation_rank` field in prompts provides context but doesn't drive scoring logic. With `'COMPOUND'` replacing ranks, the Opus analysis prompt gets cleaner context.

### 5B. Subscriber Alert Copy
**Risk: MEDIUM.** Current PO alerts say "A-Rank structural edge confirmed" or "B-Rank graduation." Need new copy: "Structural position confirmed — compound signals aligned (MC {x}%, Floor {y})." The agent prompt rewrite (§2F) handles this. No direct alert copy template exists — it's all agent-generated.

### 5C. BWC State Machine
**Risk: NONE.** BWC state (LOCK/EDGE/VALUE) is computed from margin + indicators, not graduation. Completely independent.

### 5D. XGB EXIT
**Risk: NONE.** XGB EXIT uses `_xgbBwcProb` and quarter-specific thresholds. Does not reference graduation.

### 5E. PBP MC Canary
**Risk: NONE.** Canary fires on windowed MC rates and divergence. Does not reference graduation.

### 5F. BUY System
**Risk: LOW.** BUY fires independently of PO/graduation. The only interaction: BUY alert context includes graduation data (`cpMeanFloor`, `cpPeakRank`). With compound, the context changes to `compoundState`/`compoundMC`/`compoundFloor`. Agent prompt rules for BUY+graduation (lines ~680-725) need rewriting.

### 5G. NCAAMB
**Risk: NONE.** NCAAMB graduation at lines ~7371-7460 is a completely separate code path gated by `league === 'ncaamb'`. Uses `lt.graduation` (not `lt.cp_graduation`). Untouched.

### 5H. Backtest Infrastructure
**Risk: LOW.** `backtest-nba-snapshots.mjs` has its own checkpoint logic for backtesting. It reads `game_checkpoints` but doesn't write graduation state. The checkpoint table structure is unchanged. Backtest phases that reference graduation ranks (`report_all`, `report_calibration`) will see `'COMPOUND'` in new data.

### 5I. Dashboard Historical Data
**Risk: LOW.** Old snapshots have `grad_rank` = 'A'/'B'/'C'. New snapshots have 'COMPOUND'. v3.html color mapping handles both. No visual regression.

---

## 6. IMPLEMENTATION PLAN

### Phase 1: Dead Code Removal (~290 lines)
Remove the 8 dead functions and LANE_THRESHOLDS. `node -c` after removal. These have zero callers outside the graduation path being replaced.

### Phase 2: New Compound Function (~30 lines)
Add `checkCompoundConfirmation()`. Add `lt.compound_holds`, `lt.compound_confirmed` tracking.

### Phase 3: PO Firing Logic (~80 lines changed)
Replace Phase C graduation evaluation + PO firing with compound check. Keep PO_ACTIVE sentinel writes. Keep suppress throttle.

### Phase 4: Flip PO (~30 lines changed)
Replace opponent graduation check with opponent compound check.

### Phase 5: BWC Death (~10 lines changed)
Replace graduation field clearing with compound field clearing.

### Phase 6: v2Ctx + Alert INSERT (~20 lines changed)
Update field mappings. Remove dead fields from v2Ctx. Add compound fields.

### Phase 7: Agent Prompts (~180 lines rewritten)
Rewrite graduation rules in formatAgentPromptV2. Rewrite BWC LIFECYCLE in formatSonnetPrompt. This is the highest-risk phase — prompt changes can have unexpected effects on agent behavior.

### Phase 8: Post-Game Agent (~15 lines changed)
Update graduation_rank references. Update context building.

### Phase 9: v3.html (~5 lines changed)
Update grad_rank color mapping.

### Phase 10: Smoke Test
- Hit poll endpoint on a live game, verify compound confirmation fires
- Check alert INSERT has correct field values
- Verify learning agent handles 'COMPOUND' rank
- Check v3.html renders new snapshots correctly
- Verify NCAAMB path is completely unaffected

---

## 7. WHAT I'M NOT SURE ABOUT

1. **MC Cum availability at checkpoint time.** ✅ CONFIRMED. `var _mcCum` declared at line 6383, computed at line 6390, stored on `lt.mc_cum_wp` at line 6498. Checkpoint section starts at line 7065. Same function scope (`var` declaration). `_mcCum.winProb` is ctrl-relative (uses `ind.controlTeam`). No code movement needed.

2. **Q2 consecutive hold persistence across polling cycles.** ✅ CONFIRMED. `lt` is saved to `games.live_tracking` JSONB at line 7913 (after checkpoint section at 7065-7370). `lt.compound_holds` will persist between polls.

3. **Agent prompt regression risk.** The agent currently uses graduation rank heavily for POSITION_OPEN decisions. Switching from "A-Rank with X flips" to "Compound confirmed MC=0.85 Floor=0.72" changes the agent's decision-making context. Could lead to different SEND/SUPPRESS ratios. **→ Monitor first slate after deployment.**

---

## 8. FILES MODIFIED

| File | Change Type | Lines Changed (est.) |
|---|---|---|
| `poll-live-bdl.mjs` | Major | -430, +120 (net -310) |
| `post-game-agent.mjs` | Minor | ~15 |
| `v3.html` | Minor | ~5 |
| `db-api.js` | None | 0 |

**No schema migrations. No new tables. No new env vars. No new dependencies.**

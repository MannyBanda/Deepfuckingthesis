# Tiered Alert System — Build Specification

**Version:** 1.0
**Date:** April 16, 2026
**Based on:** Phase 2 backtest (1,235 games / 9,861 snapshots / 15 reports)
**Status:** ARCHITECTURE COMPLETE — ready to implement

---

## Problem Statement

The indicator system is highly predictive (87.8% at Q4_END, DOMINANT 97.6%) but the alert layer fires too many losers. BUY is 69% overall, WINDOW BUY 62.4%. The goal is 95% per alert by mechanically filtering losers before the agent sees them, using backtest-proven quality signals.

## Key Backtest Findings Driving This Spec

- **Deficit depth > conviction** for BUY: DOMINANT trailing 10+ = 93.8%, trailing 1-4 = 54.7%
- **Close games (±5 margin) are coin flips** regardless of conviction (49-59%)
- **I4 sub-agreement** = strongest quality filter: agree 96.7% vs disagree 75.7%
- **Consecutive holds 6+** = 88.3% (all snaps) vs holds=1 = 61.5%
- **Floor velocity surging** = 84.4% vs stable/new = 64.6%
- **Peak-to-end 0.25+ drop** = 72.2% (cash-out territory)
- **BWC** is strongest signal overall (67-94% by checkpoint)
- **Opponent indicators** don't add a BUY gate (floor threshold self-selects), but BWC with 2+ opp indicators drops to 68.2%
- **Opponent I3 won** (shooting quality) = 84.7% ctrl win rate — variance IS the opportunity

---

## Files Affected

| File | Lines (current) | Changes | Risk |
|---|---|---|---|
| `poll-live-bdl.mjs` | 5,957 | Heavy — L1/L2/L3/L4 all touch this | HIGH |
| `db-api.js` | 2,430 | Schema migrations only | LOW |
| `analyze.js` | 862 | Velocity guard on client auto-analysis | LOW |
| `bdl.html` | ~12,300 | None in this spec | NONE |
| `debug.html` | ~3,200 | None in this spec | NONE |

---

## LAYER 1: New Metrics (Compute Layer)

### L1.1 — I4 Sub-Agreement

**What:** Expose I4 subA and subB scores from `computeServer()`, compute agreement in `computeConviction()`.

**Current code (poll-live-bdl.mjs lines 1740-1753):**
```js
// I4 — Game Control
const hBigLead = hs.biggest_lead || 0, aBigLead = as.biggest_lead || 0;
const bigLeadDiff = hBigLead - aBigLead;
const i4subA = bigLeadDiff > 4 ? 1 : bigLeadDiff < -4 ? -1 : 0;
let i4subB = 0;
// ... computes i4subB from periods/seasonQ4 ...
const i4raw = i4subA + i4subB;
const I4 = { score: i4raw > 0 ? 1 : i4raw === 0 ? 0.5 : 0, leader: ... };
```

**Change:** Add `i4subA` and `i4subB` to the I4 object returned by `computeServer()`.

**Current return (line ~1773):**
```js
return {
  controlTeam, score, I1, I2, I3, I4, I5,
  homeAlias: hA, awayAlias: aA, homePts: hS, awayPts: aS,
};
```

**New return:**
```js
// I4 object changes from:
const I4 = { score: ..., leader: ... };
// to:
const I4 = { score: ..., leader: ..., subA: i4subA, subB: i4subB };
```

**Then in `computeConviction()` (line ~1779), add I4 sub-agreement computation:**

**Current return (line ~1833):**
```js
return { tier, combo, count, indicatorsWon: wins, indicatorsLost: loses,
         indicatorsEven: even, pairs, isDanger };
```

**New return:**
```js
// Compute I4 sub-agreement
const ctrlI4subA = ctrlHome ? ind.I4.subA : -ind.I4.subA;
const ctrlI4subB = ctrlHome ? ind.I4.subB : -ind.I4.subB;
const i4SubAgree = (ctrlI4subA > 0 && ctrlI4subB > 0) ? 'AGREE'
                 : (ctrlI4subA < 0 || ctrlI4subB < 0) && (ctrlI4subA > 0 || ctrlI4subB > 0) ? 'DISAGREE'
                 : 'MIXED';  // one or both are 0

return { tier, combo, count, indicatorsWon: wins, indicatorsLost: loses,
         indicatorsEven: even, pairs, isDanger, i4SubAgree };
```

**Cascading implications:**
- `conviction` object is used in ~15 places in poll-live-bdl.mjs. Adding a new field is additive — no existing code breaks.
- The backtest `computeConviction` (backtest-nba-snapshots.mjs line ~405) is a SEPARATE copy. Does NOT need this change (backtest already has its own I4 split report).
- Alert agent ctx already passes `conviction.tier`, `conviction.combo`. New field `conviction.i4SubAgree` needs to be added to the agent ctx object (see L3).
- Client-side `computeConviction` in `bdl.html` is also a separate copy. NOT touched in this spec. Can be synced later.

**Mitigation:** Test with `node -c`. The I4 object shape change ({score, leader} → {score, leader, subA, subB}) is additive. Grep for `ind.I4.score` and `ind.I4.leader` to confirm no destructuring breaks.

```bash
grep -n "I4\.score\|I4\.leader\|I4\.subA\|I4\.subB" netlify/functions/poll-live-bdl.mjs
```

---

### L1.2 — Per-Game Live Tracking State

**What:** Track peak floor, trough floor, consecutive holds per game. Persisted to DB so Netlify cold starts don't lose state.

**Storage decision:** JSONB column on `games` table. The `games` table already has per-game live state (`prev_tp_class`, `prev_ctrl_team`, etc. — see db-api.js lines 156-166). Adding `live_tracking JSONB` is consistent.

**Schema change (db-api.js):**
```js
// Add after line 166 (existing ALTER TABLE games block):
try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS live_tracking JSONB`; } catch(e) {}
```

**JSONB shape:**
```json
{
  "home_peak_floor": 0.93,
  "home_peak_time": "Q3 2:15",
  "home_trough_floor": 0.42,
  "home_trough_time": "Q1 8:30",
  "away_peak_floor": 0.71,
  "away_peak_time": "Q2 6:44",
  "away_trough_floor": 0.55,
  "away_trough_time": "Q1 11:00",
  "ctrl_team_current": "LAC",
  "ctrl_team_holds": 8,
  "last_floor": 0.85
}
```

**Write location (poll-live-bdl.mjs):** After snapshot INSERT (~line 4940), before alert checks (~line 5040). This is the natural insertion point — we have `ind` (with controlTeam, score), `currentPeriod`, `clock`.

**Implementation:**
```js
// ── L1.2: Update per-game live tracking state ──
let liveTracking = null;
try {
  const ltRows = await sql`SELECT live_tracking FROM games WHERE id = ${game.id}`;
  liveTracking = ltRows[0]?.live_tracking;
  if (typeof liveTracking === 'string') liveTracking = JSON.parse(liveTracking);
} catch(e) { /* non-fatal */ }
if (!liveTracking) liveTracking = {};

// Determine which side is ctrl
const ctrlSide = ind.controlTeam === hA ? 'home' : 'away';
const oppSide = ctrlSide === 'home' ? 'away' : 'home';
const timeStr = `Q${currentPeriod} ${clock}`;

// Update peak/trough for CTRL team
const peakKey = ctrlSide + '_peak_floor';
const troughKey = ctrlSide + '_trough_floor';
if (!liveTracking[peakKey] || ind.score > liveTracking[peakKey]) {
  liveTracking[peakKey] = ind.score;
  liveTracking[ctrlSide + '_peak_time'] = timeStr;
}
if (!liveTracking[troughKey] || ind.score < liveTracking[troughKey]) {
  liveTracking[troughKey] = ind.score;
  liveTracking[ctrlSide + '_trough_time'] = timeStr;
}

// Update peak/trough for OPP team (when opp had control, their floor = 1 - ind.score... 
// Actually NO — we only track peaks when a team IS the ctrl team.
// The opp team's peak was set when THEY were ctrl in a prior poll.
// So we only update the current ctrl team's peak/trough.

// Consecutive holds
if (liveTracking.ctrl_team_current === ind.controlTeam) {
  liveTracking.ctrl_team_holds = (liveTracking.ctrl_team_holds || 0) + 1;
} else {
  liveTracking.ctrl_team_current = ind.controlTeam;
  liveTracking.ctrl_team_holds = 1;
}
liveTracking.last_floor = ind.score;

// Write back
try {
  await sql`UPDATE games SET live_tracking = ${JSON.stringify(liveTracking)} WHERE id = ${game.id}`;
} catch(e) { log(`${matchup}: live_tracking write failed: ${e.message}`); }
```

**Cascading implications:**
- One extra SELECT + UPDATE per poll cycle per game. Minimal perf impact (poll already does 5-10 queries per game).
- `live_tracking` is read BEFORE alert checks but AFTER snapshot INSERT. This means the tracking reflects the CURRENT poll's data, which is what we want for alert tier classification.
- On game finalization (line ~4660, `gameStatus === 'closed'`), live_tracking persists — no cleanup needed. It's per-game state that's useful for post-game analysis too.
- If the column doesn't exist yet (pre-migration), the SELECT returns null, and we initialize fresh. Safe.

**Risk:** The UPDATE to `games` table happens every 60s per live game. This is fine — Neon handles this easily, and we're already doing multiple writes per game per poll.

---

### L1.3 — Velocity Direction

**What:** Compute floor direction from last 5 snapshots. Pure computation, no storage needed — snapshots already fetched in `gatherAgentContext()`.

**Current code (gatherAgentContext, line 311-316):**
```js
const snaps = await sql`SELECT floor_score, floor_team, period, clock, ...
  FROM snapshots WHERE game_id = ${gameId} ORDER BY ts DESC LIMIT 5`;
if (snaps.length > 0) {
  floorHistory = snaps.map(s => `Q${s.period} ${s.clock}: ...`).join('\n');
}
```

**Change:** After computing `floorHistory`, also compute velocity:

```js
let velocityDir = 'stable', velocityCount = 0;
if (snaps.length >= 3) {
  // snaps are newest-first. Compare consecutive pairs.
  let rises = 0, declines = 0;
  for (let i = 0; i < Math.min(snaps.length - 1, 4); i++) {
    const newer = Number(snaps[i].floor_score);
    const older = Number(snaps[i + 1].floor_score);
    if (newer > older + 0.01) rises++;
    else if (newer < older - 0.01) declines++;
  }
  if (rises >= 3) velocityDir = 'surging';
  else if (rises > declines) velocityDir = 'rising';
  else if (declines >= 3) velocityDir = 'crashing';
  else if (declines > rises) velocityDir = 'declining';
  else velocityDir = 'stable';
  velocityCount = rises - declines; // positive = net rising
}
```

**Return value change:** `gatherAgentContext` currently returns `{ floorHistory, priorAlerts, quarterSummary, learningsContext, monitorContext }`. Add `velocityDir, velocityCount`:

```js
return { floorHistory, priorAlerts, quarterSummary, learningsContext,
         monitorContext, velocityDir, velocityCount };
```

**Cascading implications:**
- `gatherAgentContext` is called in 5 places (grep confirms: lines 3936, 5261, 5482, 5543, 5652 — but line 3936 is auto-analysis which stores to `agentCtx` var, and lines 5261/5482/5543/5652 are the alert agent call sites). All 5 already destructure the return value. New fields are additive — existing destructuring still works.
- However, the auto-analysis call at line 3936 uses `agentCtx.floorHistory` etc. The new fields will be available but unused until we wire them into the agent prompt (L3).

**Risk:** Minimal. Pure additive computation on data already fetched.

---

### L1.4 — Deficit Bucket Classification

**What:** Pure function that classifies margin into backtest-proven buckets.

**New function (add near computeConviction, ~line 1835):**

```js
function classifyDeficit(margin, isTrailing) {
  if (!isTrailing && margin >= 8) return 'lead_8+';
  if (!isTrailing && margin >= 3) return 'lead_3-7';
  if (Math.abs(margin) <= 2) return 'tied_0-2';
  if (isTrailing && margin >= 10) return 'trail_10+';
  if (isTrailing && margin >= 5) return 'trail_5-9';
  if (isTrailing && margin >= 1) return 'trail_1-4';
  return 'tied_0-2'; // fallback
}

function isCloseGame(margin) {
  return Math.abs(margin) <= 5;
}
```

**Cascading implications:** None — new pure functions, called only from L2 code.

---

### L1.5 — Opponent Indicators Won

**What:** Compute which indicators the opponent holds. Uses the same inversion logic already in place at the agent call site (lines 5250-5260).

**Current code (lines 5250-5260) — already computes ctrl-relative scores:**
```js
const indNames = ['I1','I2','I3','I4','I5'];
const indScores = [ind.I1, ind.I2, ind.I3, ind.I4, ind.I5];
const _ctrlIsHomeAgent = ind.controlTeam === hA;
const _ctrlScore = (s) => s == null ? 0.5 : (_ctrlIsHomeAgent ? s : 1 - s);
const indWon = indNames.filter((n, i) => indScores[i] && _ctrlScore(indScores[i].score) >= 0.55);
const indLost = indNames.filter((n, i) => indScores[i] && _ctrlScore(indScores[i].score) <= 0.45);
```

**Change:** `indLost` already represents opponent indicators won (from ctrl team's perspective, "lost" = opponent won). We just need to compute `oppIndicatorCount` and check for I2 specifically:

```js
const oppIndicatorCount = indLost.length;
const oppHasI2 = indLost.includes('I2');
const oppHasI4 = indLost.includes('I4');
```

**Cascading implications:** These variables exist at the right scope (inside the `if (alertType)` block at line 5207). They're available for L2 tier classification and L3 agent context.

---

## LAYER 2: BUY Tier Classification

### L2.1 — `computeBuyTier()` Function

**What:** New function that takes Layer 1 metrics and returns tier A/B/C with reason string.

**Location:** Add after `classifyDeficit()` (~line 1840).

```js
function computeBuyTier({ alertType, convictionTier, deficitBucket, i4SubAgree,
                           consecutiveHolds, velocityDir, period, floor,
                           isCloseGame, oppIndicatorCount }) {
  // ── TIER A: High confidence (93-97% target) ──
  
  // Override: DOMINANT + trail_10+ always Tier A
  if (convictionTier === 'DOMINANT' && deficitBucket === 'trail_10+') {
    return { tier: 'A', reason: 'DOMINANT + deep deficit (93.8% backtest)' };
  }
  
  // BWC path
  if (alertType === 'BUY WINDOW CLOSING') {
    // BWC Tier A: DOMINANT + lead_8+ + holds 4+ + 0-1 opp indicators
    if (convictionTier === 'DOMINANT' && deficitBucket === 'lead_8+' &&
        consecutiveHolds >= 4 && oppIndicatorCount <= 1) {
      return { tier: 'A', reason: 'BWC DOMINANT leading 8+, durable holds, clean opp profile' };
    }
    // BWC with 2+ opp indicators: downgrade one tier
    if (oppIndicatorCount >= 2) {
      // BWC Tier C if 2+ opp indicators
      if (convictionTier === 'DOMINANT' || convictionTier === 'STRONG') {
        return { tier: 'C', reason: `BWC downgraded — ${oppIndicatorCount} opponent indicators (68% backtest)` };
      }
      return { tier: 'C', reason: `BWC weak conviction + ${oppIndicatorCount} opponent indicators` };
    }
    // BWC Tier B: DOMINANT/STRONG + lead_3+ + holds 2+
    if ((convictionTier === 'DOMINANT' || convictionTier === 'STRONG') &&
        (deficitBucket === 'lead_3-7' || deficitBucket === 'lead_8+') &&
        consecutiveHolds >= 2) {
      return { tier: 'B', reason: 'BWC solid conviction + lead + established holds' };
    }
    // BWC default: Tier C
    return { tier: 'C', reason: 'BWC below Tier B threshold' };
  }
  
  // WINDOW BUY: always Tier C
  if (alertType === 'WINDOW BUY') {
    return { tier: 'C', reason: 'WINDOW BUY — agent-only territory (62% backtest baseline)' };
  }
  
  // ── Close game override ──
  if (isCloseGame) {
    // Close games can reach Tier B ONLY with full stacked confirmation
    if (i4SubAgree === 'AGREE' && consecutiveHolds >= 4 &&
        (velocityDir === 'rising' || velocityDir === 'surging') && period >= 3) {
      return { tier: 'B', reason: 'Close game with full stacked confirmation (I4 agree + holds 4+ + rising + Q3+)' };
    }
    return { tier: 'C', reason: `Close game (margin ±5) — ${convictionTier} is ${deficitBucket}, framework unreliable here` };
  }
  
  // ── BUY Standard tiers ──
  
  // Tier A requirements: ALL of these
  if ((convictionTier === 'DOMINANT' || convictionTier === 'STRONG') &&
      (deficitBucket === 'trail_5-9' || deficitBucket === 'trail_10+') &&
      i4SubAgree === 'AGREE' && consecutiveHolds >= 4 && period >= 2) {
    return { tier: 'A', reason: `${convictionTier} + ${deficitBucket} + I4 agree + ${consecutiveHolds} holds` };
  }
  
  // Tier B: meets MOST of Tier A
  if ((convictionTier === 'DOMINANT' || convictionTier === 'STRONG') &&
      (deficitBucket === 'trail_5-9' || deficitBucket === 'trail_10+')) {
    // Has conviction + deficit but missing a quality signal
    if (i4SubAgree !== 'DISAGREE' && consecutiveHolds >= 2) {
      return { tier: 'B', reason: `${convictionTier} + ${deficitBucket}, quality signals partial (I4:${i4SubAgree}, holds:${consecutiveHolds})` };
    }
  }
  if (convictionTier === 'MODEST' && deficitBucket === 'trail_10+' && i4SubAgree === 'AGREE') {
    return { tier: 'B', reason: 'MODEST but deep deficit + I4 agree (80.5% base, boosted)' };
  }
  if ((convictionTier === 'DOMINANT' || convictionTier === 'STRONG') &&
      deficitBucket === 'trail_5-9' && consecutiveHolds >= 2) {
    return { tier: 'B', reason: `${convictionTier} trailing 5-9 with established holds` };
  }
  
  // ── Tier C: everything else ──
  let reason = '';
  if (deficitBucket === 'trail_1-4') reason = `Shallow deficit (trail 1-4) — 52-59% regardless of conviction`;
  else if (consecutiveHolds <= 1) reason = `Just took control (holds=${consecutiveHolds}) — 61% baseline`;
  else if (convictionTier === 'CONDITIONAL') reason = `CONDITIONAL conviction — insufficient structural evidence`;
  else if (i4SubAgree === 'DISAGREE') reason = `I4 sub-components disagree (75.7% vs 96.7% when agree)`;
  else reason = `Below Tier B threshold: ${convictionTier} ${deficitBucket} I4:${i4SubAgree} holds:${consecutiveHolds}`;
  
  return { tier: 'C', reason };
}
```

**Call site:** Inside the `if (alertType)` block (line ~5207), AFTER the indicator computation (lines 5250-5260) and BEFORE the agent call (line 5261). We need `liveTracking` to be available here too.

**New code inserted at ~line 5260 (after indLost computation, before agentCtx):**
```js
// L2: Compute BUY tier
const deficitBucket = classifyDeficit(margin, ctrlTrailing);
const closeGame = isCloseGame(margin);
const buyTier = computeBuyTier({
  alertType,
  convictionTier: conviction.tier,
  deficitBucket,
  i4SubAgree: conviction.i4SubAgree,
  consecutiveHolds: liveTracking?.ctrl_team_holds || 1,
  velocityDir: agentCtx.velocityDir || 'stable',
  period: currentPeriod,
  floor: ind.score,
  isCloseGame: closeGame,
  oppIndicatorCount: indLost.length,
});
```

**ORDERING DEPENDENCY:** `agentCtx` is gathered AFTER the tier computation in current code (line 5268: `const agentCtx = await gatherAgentContext(...)`). But `computeBuyTier` needs `velocityDir` from `agentCtx`. 

**Fix:** Move `gatherAgentContext()` call ABOVE `computeBuyTier()`. Currently it's at line 5268. Move to ~line 5258, right after indicator computation.

**Before (current order):**
```
5250: indicator computation (indWon, indLost, i4Won, etc.)
5268: const agentCtx = await gatherAgentContext(...)
5271: const agentResult = await runAlertAgent({...})
```

**After (new order):**
```
5250: indicator computation
5258: const agentCtx = await gatherAgentContext(...)  ← moved up
5260: const buyTier = computeBuyTier({...})            ← NEW
5270: const agentResult = await runAlertAgent({...})   ← receives buyTier
```

**Cascading implications:**
- Moving `gatherAgentContext` up by ~10 lines is safe — it only depends on `sql`, `game.id`, `matchup`, all available earlier.
- `buyTier` object needs to be passed into the agent context (L3).
- `liveTracking` variable from L1.2 is computed earlier in the poll cycle (after snapshot INSERT). It's in scope at the alert check block.

**CRITICAL: liveTracking scope.** L1.2 writes `liveTracking` at ~line 4940. Alert checks start at ~line 5040. The `liveTracking` variable must be declared with `let` at a scope visible to both. Currently, the snapshot INSERT and alert checks are within the same `try` block inside the per-game for loop (line 4637). So `liveTracking` declared at line ~4935 is in scope at line ~5260. **Verified safe.**

---

### L2.2 — Hard Suppress on Tier C Trailing 1-4

**What:** Mechanical gate that suppresses BUY FIRED for trailing 1-4 when conviction is STRONG or below. This removes ~45% of loser volume.

**Current code does not check deficit depth for BUY FIRED.** The BUY FIRED block (line 5056) checks: `ind.score >= 0.65 && ctrlTrailing && margin >= 1 && margin <= 15 && currentPeriod >= 2 && alertMinsLeft >= 1.0`.

**Change:** Do NOT add a hard suppress at the FIRED gate level. Instead, let `computeBuyTier` classify it as Tier C, and let the agent see the Tier C default-SUPPRESS instruction. Reason: a hard suppress loses data — we want the alert logged to the DB for accuracy tracking. The tier system preserves observability.

**Alternative approach (if we want to be more aggressive):** Add a hard suppress ONLY for the most obvious cases: `CONDITIONAL` or `MODEST` at trailing 1-2. But even this should wait until we see how the agent handles Tier C instructions.

**Decision: No hard suppress. Tier C + agent instructions handles it.**

---

## LAYER 3: Agent Prompt Overhaul

### L3.1 — Framework Context Constant

**What:** Static string prepended to every agent call, encoding phase 2 backtest knowledge.

**Location:** New constant at top of file, after `sendNtfy` function (~line 155).

```js
const FRAMEWORK_CONTEXT = `FRAMEWORK CONTEXT (from 1,235-game backtest, 9,861 snapshots):
...
// Full text from Layer 3 spec above — ~40 lines
`;
```

**Size consideration:** This adds ~2,000 tokens to every agent call. Current prompt is ~1,500 tokens of instructions + ~500 tokens of dynamic data. Total ~4,000 tokens input. Opus 4.6 handles this easily within the 500-token output budget.

---

### L3.2 — Agent Prompt Rewrite

**What:** Replace the current inline prompt string in `runAlertAgent()` (lines 162-274, ~112 lines) with a structured three-section prompt.

**Current prompt structure (lines 162-274):**
```
"You are a live NBA betting alert quality agent..."
ALERT: [dynamic data]
INDICATORS: [dynamic data]
FLOOR TRAJECTORY: [dynamic data]
...extensive inline RULES block (~80 lines)...
BODY RULES: ...
"Respond in EXACTLY this format: DECISION/REASONING/BODY"
```

**New prompt structure:**
```
Section 1: FRAMEWORK_CONTEXT constant (static, ~40 lines)
Section 2: DECISION_RULES string built from buyTier (tier-specific, ~30 lines)
Section 3: CURRENT_ALERT template (dynamic data, ~40 lines)
```

**Key change:** The current RULES block (lines 223-274) is replaced with tier-specific decision rules. Most of the current rules are still valid but get reorganized by tier.

**Rules that STAY (move to Framework Context or Decision Rules):**
- I4 COMBO logic (lines 224-227) — stays, enhanced with I4 sub-agreement data
- BODY RULES (lines 261-274) — stays verbatim
- MONITOR OVERRIDE PROTECTION (line 241) — stays, enhanced with tier interaction
- TP as context not veto (line 244-247) — stays

**Rules that are REPLACED:**
- FIRED vs CANDIDATE generic rules (lines 223-228) — replaced with tier-specific rules
- EARLY GAME NOTE (line 240) — replaced by period being a tier input
- CANDIDATE BUY floor 0.55-0.65 rule (line 242) — subsumed by Tier C
- ANCHORED FLOOR CHECK (line 239) — replaced by peak-to-current delta metric

**Rules that are REMOVED (dead/superseded):**
- LEAN BUY references (killed long ago, but mentioned in prompt) — clean up
- Generic "SEND unless clear contradiction" for FIRED — replaced by tier-specific defaults

**New ctx fields passed to `runAlertAgent`:**
```js
const agentResult = await runAlertAgent({
  // ... all existing fields ...
  // NEW fields:
  buyTier: buyTier.tier,        // 'A', 'B', 'C'
  buyTierReason: buyTier.reason, // human-readable classification reason
  deficitBucket,                 // 'trail_10+', 'trail_5-9', etc.
  i4SubAgree: conviction.i4SubAgree,  // 'AGREE', 'DISAGREE', 'MIXED'
  consecutiveHolds: liveTracking?.ctrl_team_holds || 1,
  velocityDir: agentCtx.velocityDir,
  velocityCount: agentCtx.velocityCount,
  peakFloor: liveTracking?.[ctrlSide + '_peak_floor'] || null,
  peakFloorTime: liveTracking?.[ctrlSide + '_peak_time'] || null,
  troughFloor: liveTracking?.[ctrlSide + '_trough_floor'] || null,
  peakTroughSpread: peakFloor && troughFloor ? (peakFloor - troughFloor).toFixed(2) : null,
  isCloseGame: closeGame,
  oppIndicatorCount: indLost.length,
  oppI2: oppHasI2,
});
```

**Cascading implications:**
- `runAlertAgent` receives these as `ctx.*` — the prompt template string references them. No other function uses `ctx`.
- The 5 call sites for `runAlertAgent` (line 3936 auto-analysis, 5261 main, 5482 RP, 5543 LC, 5652 VB) need to be checked:
  - **Main (5261):** Gets all new fields. ✓
  - **Auto-analysis (3936):** Needs new fields too. But auto-analysis is a POSITION UPDATE, not a tier-classified alert. It should receive `buyTier: null` and skip tier rules. The prompt should handle null tier gracefully.
  - **RP (5482):** RECOVERY PATH bypasses the tier system (transition alert). Pass `buyTier: null`.
  - **LC (5543):** LEAD CRUMBLING. Pass `buyTier: null`.
  - **VB (5652):** VARIANCE BREAKING. Pass `buyTier: null`.
  
  For null tier, the prompt falls back to the existing type-specific rules (RP, LC, VB rules from current prompt, retained in Framework Context).

**CRITICAL: The prompt must handle `buyTier: null` for non-BUY/BWC/WB alerts.** Add a conditional in the prompt template:

```js
const tierBlock = ctx.buyTier
  ? `\nTIER: ${ctx.buyTier} — ${ctx.buyTierReason}\n${TIER_RULES[ctx.buyTier]}`
  : ''; // Transition alerts skip tier system
```

---

### L3.3 — Alert Agent Call Sites Audit

All 5 `runAlertAgent` call sites and their required changes:

| Line | Type | Change Needed |
|---|---|---|
| 3936 | AUTO_ANALYSIS | Add new fields with `buyTier: null`. Add velocity guard (L4.3) |
| 5261 | BUY/BWC/WB FIRED+CANDIDATE | Full new fields including `buyTier` |
| 5482 | RECOVERY PATH | Add new fields with `buyTier: null` |
| 5543 | LEAD CRUMBLING | Add new fields with `buyTier: null` |
| 5652 | VARIANCE BREAKING | Add new fields with `buyTier: null` |

For lines 5482, 5543, 5652 — these also call `gatherAgentContext` (via the shared `transitionAgentCtx` at line 5439). The new `velocityDir` and `velocityCount` will be available from that shared context. `liveTracking` is also in scope. Safe to add the new fields.

---

### L3.4 — Alerts Table: New Columns

**What:** Store tier classification for accuracy tracking and post-game analysis.

**Schema change (db-api.js):**
```js
try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS buy_tier TEXT`; } catch(e) {}
try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS buy_tier_reason TEXT`; } catch(e) {}
try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS i4_sub_agree TEXT`; } catch(e) {}
try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS consecutive_holds INTEGER`; } catch(e) {}
try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS velocity_dir TEXT`; } catch(e) {}
try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS deficit_bucket TEXT`; } catch(e) {}
```

**Write location:** The alert INSERT (line ~5310+) already writes conviction_tier, agent_decision, etc. Add the new columns to the same INSERT.

**Cascading implications:** All alert INSERTs (5 call sites) need the new columns. The main one at ~5310 and the transition alert INSERTs at ~5520, ~5570, ~5610, ~5660.

---

## LAYER 4: Monitor Enhancement + Cash-Out

### L4.1 — Mechanical Cash-Out Trigger (60s Path)

**What:** Every poll cycle, check if a prior SENT alert's ctrl team has dropped 0.25+ from peak. Fire ntfy directly, no agent.

**Location:** After live_tracking update (~line 4940), before alert threshold checks (~line 5040). This catches collapses BEFORE we check for new BUY/BWC signals.

```js
// ── L4.1: Mechanical CASH_OUT check ──
if (liveTracking && ind.controlTeam) {
  const ctrlSide = ind.controlTeam === hA ? 'home' : 'away';
  const peakFloor = liveTracking[ctrlSide + '_peak_floor'];
  if (peakFloor) {
    const peakDelta = ind.score - peakFloor;
    if (peakDelta <= -0.25) {
      // Check for prior SENT alert for this ctrl team
      try {
        const priorSent = await sql`
          SELECT alert_type, floor_score, period, clock, ts
          FROM alerts WHERE game_id = ${game.id}
            AND control_team = ${ind.controlTeam}
            AND ntfy_sent = true
            AND alert_type IN ('BUY', 'BUY WINDOW CLOSING', 'WINDOW BUY')
          ORDER BY ts DESC LIMIT 1`;
        if (priorSent.length > 0) {
          // Dedup: one CASH_OUT per game per quarter
          const cashOutDedup = await sql`
            SELECT 1 FROM alerts WHERE game_id = ${game.id}
              AND alert_type = 'CASH_OUT' AND period = ${currentPeriod} LIMIT 1`;
          if (cashOutDedup.length === 0) {
            const prior = priorSent[0];
            const body = `Your ${prior.alert_type} position on ${ind.controlTeam} is at risk.\n`
              + `Entered at Q${prior.period} ${prior.clock} (floor ${Number(prior.floor_score).toFixed(0)}%).\n`
              + `Floor dropped from peak ${(peakFloor*100).toFixed(0)}% to ${(ind.score*100).toFixed(0)}% — `
              + `a ${Math.abs(peakDelta*100).toFixed(0)}-point structural collapse.\n`
              + `Consider closing your position.\n`
              + `${aA} ${ind.awayPts}-${ind.homePts} ${hA} · Q${currentPeriod} ${clock}`;
            await sendNtfy(`⚠️ CASH OUT — ${ind.controlTeam}`, body, 5);
            await sql`INSERT INTO alerts (game_id, league, alert_type, period, clock,
              control_team, floor_score, margin, is_trailing, alert_tier,
              agent_decision, agent_reasoning, ntfy_sent,
              i1, i2, i3, i4, i5, conviction_tier, conviction_combo)
              VALUES (${game.id}, ${league}, ${'CASH_OUT'}, ${currentPeriod}, ${clock},
              ${ind.controlTeam}, ${ind.score}, ${margin}, ${ctrlTrailing}, ${'MECHANICAL'},
              ${'SEND'}, ${'Peak delta ' + peakDelta.toFixed(2) + ' exceeds -0.25 threshold'},
              ${true},
              ${ind.I1?.score ?? null}, ${ind.I2?.score ?? null}, ${ind.I3?.score ?? null},
              ${ind.I4?.score ?? null}, ${ind.I5?.score ?? null},
              ${conviction.tier}, ${conviction.combo})`;
            log(`${matchup}: CASH_OUT FIRED — peak ${peakFloor.toFixed(2)} → current ${ind.score.toFixed(2)}, delta ${peakDelta.toFixed(2)}`);
          }
        }
      } catch(e) { log(`${matchup}: CASH_OUT check error: ${e.message}`); }
    }
  }
}
```

**Cascading implications:**
- `CASH_OUT` is a new `alert_type` value. Post-game scoring agent (post-game-agent.mjs) needs to handle it — mark as CORRECT if the ctrl team's lead eroded further or they lost, INCORRECT if they recovered and won comfortably. Add to the scoring logic.
- Debug page alert accuracy section needs to display CASH_OUT alerts. Since it reads from the `alerts` table generically, it should work without changes, but the type filter dropdowns may need updating.
- The `POSITION_TYPES` array (line 3907) that gates auto-analysis position updates should include 'CASH_OUT'.

---

### L4.2 — Auto-Analysis Velocity Guard

**What:** Suppress auto-analysis ntfy when floor has dropped 0.15+ from peak.

**Location:** Inside `fireCalibrationAnalysis()`, after the position gate check (line ~3930), before routing to the agent (line ~3936).

**Current flow:**
```
3920: check for priorPosition
3922: if (!priorPosition) → suppress (position gate)
3930: else → route through agent as position update
3936: const agentResult = await runAlertAgent({...})
```

**New flow (insert between 3922 and 3930):**
```js
// L4.2: Velocity guard — suppress reinforcement when floor is dropping
if (priorPosition) {
  let velocityGuardTriggered = false;
  try {
    const ltRows = await sql`SELECT live_tracking FROM games WHERE id = ${game.id}`;
    const lt = ltRows[0]?.live_tracking;
    if (lt) {
      const parsed = typeof lt === 'string' ? JSON.parse(lt) : lt;
      const ctrlSide = ind.controlTeam === hA ? 'home' : 'away';
      const peakFloor = parsed[ctrlSide + '_peak_floor'];
      if (peakFloor && (ind.score - peakFloor) <= -0.15) {
        velocityGuardTriggered = true;
        log(`${matchup}: ${triggerTag} velocity guard — floor dropped ${(ind.score - peakFloor).toFixed(2)} from peak ${peakFloor.toFixed(2)}`);
      }
    }
  } catch(e) { /* non-fatal */ }
  
  if (velocityGuardTriggered) {
    // Still save to DB but don't send ntfy
    const aaReasoning = `Velocity guard: floor dropped ${(ind.score - peakFloor).toFixed(2)} from peak — suppressing reinforcement`;
    try {
      await sql`INSERT INTO alerts (...) VALUES (...ntfy_sent=${false}...)`;
    } catch(e) {}
    // Skip the agent call entirely — no point reasoning about a position we won't reinforce
  } else {
    // ... existing agent call path ...
  }
}
```

**NOTE:** The `peakFloor` variable from the try block is out of scope in the `if (velocityGuardTriggered)` block. Need to hoist it:

```js
let velocityGuardTriggered = false;
let peakFloorForGuard = null;
// ... compute inside try ...
peakFloorForGuard = peakFloor;
velocityGuardTriggered = true;
```

**Cascading implications:**
- The auto-analysis INSERT needs the same new columns as L3.4 (`buy_tier`, etc.) but they can be null for auto-analysis.
- The agent is NOT called when velocity guard triggers. This saves an Opus API call (~$0.02 per call).

---

### L4.3 — Monitor Prompt Enhancement (Erosion Detection)

**What:** Add Layer 1 metrics to monitor prompt and erosion detection instructions.

**Location:** `runMonitorAgent()` (line 626) and `getMonitorData()` (line 402).

**`getMonitorData` change:** Currently fetches snapshots and builds per-game data. Add: query `live_tracking` from games table for each live game. Add the tracking data to the per-game object passed to the monitor.

```js
// In getMonitorData, after building per-game snapshot data:
// Fetch live tracking for all live games
const trackingRows = await sql`
  SELECT id, live_tracking FROM games WHERE id = ANY(${liveGameIds})`;
const trackingMap = {};
for (const r of trackingRows) {
  trackingMap[r.id] = typeof r.live_tracking === 'string'
    ? JSON.parse(r.live_tracking) : r.live_tracking;
}
// Add to each game's data object
game.liveTracking = trackingMap[game.id] || {};
```

**Monitor prompt change:** Add erosion detection section to the system prompt. Currently the monitor prompt (inside `runMonitorAgent`, line ~640) is a long template string. Add a new section after the existing SLATE block:

```
EROSION DETECTION:
For each ACTIVE POSITION, assess erosion using:
- Peak-to-current delta: {peakDelta} (approaching -0.25 = cash-out zone)
- Consecutive holds trend: {holdsHistory}
- Velocity direction: {velocityDir}
- Opponent indicators: {oppIndicators}
If peak delta is between -0.15 and -0.25 with declining holds or diverging I4,
flag EROSION_WARNING in your observation.
```

**monitor_observations table changes (db-api.js):**
```js
try { await sql`ALTER TABLE monitor_observations ADD COLUMN IF NOT EXISTS erosion_signals INT DEFAULT 0`; } catch(e) {}
try { await sql`ALTER TABLE monitor_observations ADD COLUMN IF NOT EXISTS proposed_alert_type TEXT`; } catch(e) {}
try { await sql`ALTER TABLE monitor_observations ADD COLUMN IF NOT EXISTS proposal_urgency TEXT`; } catch(e) {}
```

**Cascading implications:**
- The monitor observation INSERT (inside `runMonitorAgent`) needs the new columns.
- The alert agent reads monitor observations via `gatherAgentContext` (lines 395-405). The new columns are available but the agent prompt doesn't reference them until the monitor→agent proposal path is built.
- Monitor→agent proposal path is a FUTURE item (spec'd in Layer 4 architecture but can be deferred to a follow-up session since the mechanical cash-out at -0.25 handles the urgent case).

---

## DEAD CODE TO CLEAN UP

| Location | Description | Action |
|---|---|---|
| Line 5163 | Comment about removed CANDIDATE BUY TP CONTESTED | Delete comment |
| Prompt line ~233 | LEAD CRUMBLING rules reference | Update when THESIS ERODING rename ships |
| Various | `LEAN BUY` referenced nowhere in code but may appear in prompt | Grep and clean |
| `game._alertHistory` | In-memory dedup that resets on cold start | Keep — serves as fast path before DB dedup |

**Grep verification:**
```bash
grep -n "LEAN" netlify/functions/poll-live-bdl.mjs  # Should find nothing
grep -n "LEAN" bdl.html                              # May find client references
```

---

## BUILD ORDER

| Step | Layer | Description | Files | Est. Lines |
|---|---|---|---|---|
| 1 | L1.1 | I4 sub-agreement in computeServer + computeConviction | poll-live-bdl.mjs | ~15 |
| 2 | L1.4 | classifyDeficit + isCloseGame functions | poll-live-bdl.mjs | ~15 |
| 3 | DB | Schema migrations (live_tracking, new alert columns, monitor columns) | db-api.js | ~15 |
| 4 | L1.2 | Per-game live tracking state (read/write in poll loop) | poll-live-bdl.mjs | ~40 |
| 5 | L1.3 | Velocity computation in gatherAgentContext | poll-live-bdl.mjs | ~20 |
| 6 | L2.1 | computeBuyTier function | poll-live-bdl.mjs | ~80 |
| 7 | L3.1 | FRAMEWORK_CONTEXT constant | poll-live-bdl.mjs | ~50 |
| 8 | L3.2 | Agent prompt rewrite (replace lines 162-274) | poll-live-bdl.mjs | ~200 (net ~+90) |
| 9 | L3.3 | Wire new fields to all 5 runAlertAgent call sites | poll-live-bdl.mjs | ~50 |
| 10 | L3.4 | New columns in alert INSERT (all 5+ INSERT sites) | poll-live-bdl.mjs | ~30 |
| 11 | L4.1 | Mechanical CASH_OUT trigger | poll-live-bdl.mjs | ~40 |
| 12 | L4.2 | Auto-analysis velocity guard | poll-live-bdl.mjs | ~25 |
| 13 | L4.3 | Monitor prompt enhancement | poll-live-bdl.mjs | ~30 |
| 14 | — | Syntax check, push, deploy, run ?action=init | all | — |

**Total: ~610 lines new/modified code.**

Steps 1-6 can ship as one commit (Layer 1 + Layer 2 — no behavior change, just new computation).
Steps 7-10 ship as one commit (Layer 3 — agent prompt overhaul).
Steps 11-13 ship as one commit (Layer 4 — cash-out + velocity guard + monitor).
Step 14 after each commit.

---

## TESTING STRATEGY

**After Steps 1-6 (L1+L2):**
- Deploy, wait for live games
- Console script to verify: `fetch('/api?action=get_latest_snapshots&game_id=XXX')` and check that `live_tracking` JSONB is populated
- Grep server logs for `SNAP IND` lines — verify I4 subA/subB values visible
- No alert behavior changes — existing alerts fire exactly as before

**After Steps 7-10 (L3):**
- Run `test-agent.js` — existing 38 scenarios. Some may need updating if the prompt format changed the expected parse pattern (DECISION/REASONING/BODY format stays the same, so parsing should be stable).
- Add new test scenarios for each tier:
  - Tier A DOMINANT trail_10+ → expect SEND
  - Tier C close game MODEST trail_2 → expect SUPPRESS
  - Tier B STRONG trail_7 I4 agree holds=3 → expect SEND
- Watch first live slate with new prompt — compare agent decisions to old behavior

**After Steps 11-13 (L4):**
- Verify CASH_OUT by checking: does `alerts` table get CASH_OUT rows after a peak-to-current drop > 0.25?
- Verify velocity guard by checking: does auto-analysis get suppressed with `velocity_guard` reasoning when floor drops 0.15+ from peak?
- Monitor logs should show erosion_signals count in observations

---

## RISK REGISTER

| Risk | Impact | Mitigation |
|---|---|---|
| I4 object shape change breaks downstream | Alerts stop computing | Grep for `.I4.score`, `.I4.leader`. Additive change — no destructuring breaks. |
| `live_tracking` SELECT adds latency | Poll cycle slower | Single SELECT by PK, <5ms. Already doing 5-10 queries per game. |
| Agent prompt too long (token overflow) | Agent fails/truncates | Framework context ~2K tokens + dynamic ~500 = ~2.5K. Well within limits. Agent output capped at 500 tokens. |
| Tier C suppresses too aggressively | Miss valid close-game signals | Agent can still SEND Tier C with stacked confirmation. Tier C is a DEFAULT, not a hard gate. |
| CASH_OUT fires on normal late-game compression | False cash-out alerts | Peak delta threshold -0.25 is calibrated from backtest (72.2% win rate at that level = 28% loss). Only fires if prior SENT exists. |
| Concurrent poll invocations write conflicting live_tracking | State corruption | Last-write-wins is acceptable — floor/peak values converge within 1 poll cycle. |
| gatherAgentContext moved earlier changes timing | Stale data | Moves by ~10 lines within same synchronous block. Data hasn't changed. |

---

## POST-DEPLOY MONITORING

After first full slate with new system:
1. Query alerts table: `SELECT buy_tier, agent_decision, COUNT(*) FROM alerts WHERE date = 'YYYY-MM-DD' GROUP BY 1, 2`
2. Verify tier distribution: expect ~40% Tier A, ~30% Tier B, ~30% Tier C
3. Verify Tier A alerts are mostly SEND, Tier C mostly SUPPRESS
4. Check CASH_OUT alerts: did any fire? Were they appropriate?
5. Check velocity guard: grep logs for "velocity guard" — how many auto-analyses were suppressed?
6. Compare nightly accuracy to pre-change baselines

---

## FUTURE WORK (NOT IN THIS SPEC)

- THESIS ERODING alert type (rename LEAD CRUMBLING) — separate spec
- Monitor → agent proposal path (monitor proposes alerts, agent gates them)
- Client-side sync of `computeConviction` with I4 sub-agreement
- Debug page Section 8: tier accuracy dashboard
- BWC rename
- Playoff-specific tier calibration (once N > 20 playoff games)

# Agent Prompt Changes: XGB-MC Divergence Context + Failure Profile (v2)

**Date:** May 13, 2026
**Status:** SPEC — awaiting approval before implementation
**Validated by:**
- NBA: May 13 divergence research (14,440 checkpoints, 1,233 games, close-game analysis)
- WNBA: May 8 compound signal analysis (3,432 checkpoints, 312 games)
- Failure profile confirmed independently by trajectory prototype (n=393, 41.5% WR)
**Files touched:** `poll-live-bdl.mjs` only
**Net change:** ~47 lines added, 1 line replaced. Zero new DB columns, zero new functions, zero state machine changes.

---

## What We're Adding

Two context injections, each with league-specific validated numbers:

### 1. XGB-MC Directional Divergence

**Current state:** Line ~800 in buildV2AgentPrompt shows the MC Cum vs XGB gap magnitude when >15pp, with a generic note: "MC Cum dominates disagreements (70-87%)." No direction, no win rates, no league-specific context.

**Problem:** "XGB 40% / MC Cum 75%" and "XGB 75% / MC Cum 40%" both render as "35pp gap" but have opposite implications. The agent must infer the direction and what it means.

**Validated numbers by league:**

| Direction | NBA (1,233 games, close |margin|≤8) | WNBA (312 games, all) |
|-----------|--------------------------------------|------------------------|
| MC >> XGB (MC leads by 10+pp) | 92% ctrl wins | 64.0% ctrl wins |
| XGB >> MC (XGB leads by 10+pp) | 50% ctrl wins | 42.9% ctrl wins |

Both leagues show the same directional pattern: when MC leads the divergence, trust MC. When XGB leads, the structural read isn't confirmed by rates.

### 2. Failure Profile Flag

**Current state:** No explicit failure profile detection. The agent sees floor, XGB, and MC Cum as separate numbers and must notice the pattern on its own.

**Validated numbers by league:**

| Profile | NBA | WNBA |
|---------|-----|------|
| Floor ≥ 0.65 + MC Cum < 0.60 | 44% win rate | — |
| Floor ≥ 0.65 + XGB < 0.50 | 41.5% win rate (n=393) | — |
| Floor HIGH + MC+XGB both LOW | 51% of all wrong calls | 20.2% win rate |

WNBA failure profile is MORE severe (20.2%) because floor is narrative-only in WNBA — the trust hierarchy already says floor is wrong 80% when it disagrees with MC+XGB. The failure profile flag makes this explicit and actionable on each specific alert.

---

## Implementation

### Change 1: Compute divergence classification (poll loop, before ctx construction)

**Location:** After `_mcCum` and `_xgbWinProb` are both available, before the ctx object is built (~line 7425).

**New code (~18 lines):**

```javascript
// ── XGB-MC divergence classification ──
// NBA: validated May 13 (14,440 checkpoints, 1,233 games, close-game analysis)
// WNBA: validated May 8 (3,432 checkpoints, 312 games, compound signal analysis)
var _xgbMcGap = null, _xgbMcClass = null, _failureProfile = false;
if (_xgbWinProb != null && _mcCum?.winProb != null) {
  _xgbMcGap = _xgbWinProb - _mcCum.winProb;  // positive = XGB higher
  if (_xgbMcGap > 0.10)       _xgbMcClass = 'XGB_LEADS';
  else if (_xgbMcGap < -0.10) _xgbMcClass = 'MC_LEADS';
  else                        _xgbMcClass = 'CONVERGED';
}
// Failure profile: floor high but MC/XGB don't confirm
// NBA: floor>=0.65 + MC<0.60 = 44% WR, floor>=0.65 + XGB<0.50 = 41.5% WR
// WNBA: floor HIGH + MC+XGB LOW = 20.2% WR
if (ind.score >= 0.65) {
  if (league === 'wnba') {
    // WNBA: floor is narrative-only — failure profile when EITHER MC or XGB is low
    if ((_mcCum?.winProb != null && _mcCum.winProb < 0.60) ||
        (_xgbWinProb != null && _xgbWinProb < 0.50)) {
      _failureProfile = true;
    }
  } else {
    // NBA: failure profile when MC Cum < 0.60 OR XGB < 0.50
    if ((_mcCum?.winProb != null && _mcCum.winProb < 0.60) ||
        (_xgbWinProb != null && _xgbWinProb < 0.50)) {
      _failureProfile = true;
    }
  }
}
```

**Note:** NBA and WNBA branches currently have identical logic — separated for clarity and future threshold divergence as WNBA data grows. Can collapse to a single `if` block if preferred.

### Change 2: Add 3 fields to ctx object

**Location:** ctx construction (~line 7465), after existing `mcCumWp` and `mcDrivers` lines.

```javascript
xgbMcGap: _xgbMcGap,            // number: XGB - MC Cum (positive = XGB higher)
xgbMcClass: _xgbMcClass,        // string: 'XGB_LEADS' | 'MC_LEADS' | 'CONVERGED' | null
failureProfile: _failureProfile, // boolean
```

### Change 3: Replace MC Cum vs XGB gap line in buildV2AgentPrompt (MC TRAJECTORY section)

**Location:** Line ~800, inside the MC TRAJECTORY block.

**Current text (REMOVE this single interpolation):**
```
${ctx.mcCumWp != null && ctx.xgbWinProb != null && Math.abs(ctx.mcCumWp - ctx.xgbWinProb) > 0.15 ? 'MC Cum vs XGB gap: ' + Math.round(Math.abs(ctx.mcCumWp - ctx.xgbWinProb) * 100) + 'pp — MC Cum dominates disagreements (70-87%).' : ''}
```

**New text (REPLACE with):**
```
${ctx.xgbMcClass === 'MC_LEADS'
  ? 'SIGNAL DIVERGENCE: MC Cum (' + (ctx.mcCumWp * 100).toFixed(0) + '%) >> XGB (' + (ctx.xgbWinProb * 100).toFixed(0) + '%), gap ' + Math.round(Math.abs(ctx.xgbMcGap) * 100) + 'pp. MC LEADS — rates project a win that structural features don\\'t fully reflect. ' + (ctx.league === 'wnba' ? 'WNBA: MC leads divergence = 64% ctrl wins (312 games). Trust MC Cum over XGB.' : 'NBA close-game WR in this profile: 92%. Trust MC Cum over XGB.')
  : ctx.xgbMcClass === 'XGB_LEADS'
  ? 'SIGNAL DIVERGENCE: XGB (' + (ctx.xgbWinProb * 100).toFixed(0) + '%) >> MC Cum (' + (ctx.mcCumWp * 100).toFixed(0) + '%), gap ' + Math.round(Math.abs(ctx.xgbMcGap) * 100) + 'pp. XGB LEADS — structural quality not translating to possession rates. ' + (ctx.league === 'wnba' ? 'WNBA: XGB leads divergence = 42.9% ctrl wins (312 games). Do NOT trust XGB over MC.' : 'NBA close-game WR in this profile: 50%. Elevated caution.')
  : ''}
```

### Change 4: Add failure profile warning in buildV2AgentPrompt

**Location:** After the XGB CONVICTION WARNINGS block (line ~763, after the `ctx.trajectorySignals` check), before the existing `ctx.xgbAligned` WARNING line (line ~764).

**New text:**
```
${ctx.failureProfile ? (ctx.league === 'wnba'
  ? '⚠️ FAILURE PROFILE ACTIVE: Floor reads ' + (ctx.floor * 100).toFixed(0) + '% but ' + (ctx.mcCumWp != null && ctx.mcCumWp < 0.60 ? 'MC Cum ' + (ctx.mcCumWp * 100).toFixed(0) + '% (<60%)' : '') + (ctx.mcCumWp != null && ctx.mcCumWp < 0.60 && ctx.xgbWinProb != null && ctx.xgbWinProb < 0.50 ? ' AND ' : '') + (ctx.xgbWinProb != null && ctx.xgbWinProb < 0.50 ? 'XGB ' + (ctx.xgbWinProb * 100).toFixed(0) + '% (<50%)' : '') + ' don\\'t confirm structural edge.\\nWNBA floor HIGH + MC+XGB LOW = 20.2% win rate (312 games). Floor is narrative context only in WNBA — this combination is nearly always wrong.\\nFor BUY/BWC: SUPPRESS. For POSITION_OPEN: Note extreme risk in body.'
  : '⚠️ FAILURE PROFILE ACTIVE: Floor reads ' + (ctx.floor * 100).toFixed(0) + '% but ' + (ctx.mcCumWp != null && ctx.mcCumWp < 0.60 ? 'MC Cum ' + (ctx.mcCumWp * 100).toFixed(0) + '% (<60%)' : '') + (ctx.mcCumWp != null && ctx.mcCumWp < 0.60 && ctx.xgbWinProb != null && ctx.xgbWinProb < 0.50 ? ' AND ' : '') + (ctx.xgbWinProb != null && ctx.xgbWinProb < 0.50 ? 'XGB ' + (ctx.xgbWinProb * 100).toFixed(0) + '% (<50%)' : '') + ' don\\'t confirm structural edge.\\nHistorical win rate in this profile: 41-44% (1,233 games). 51% of all wrong calls system-wide have floor ≥0.65. Likely cumulative anchoring from early-game dominance.\\nFor BUY/BWC: SUPPRESS unless per-quarter breakdown shows the current quarter specifically supports the floor read.\\nFor POSITION_OPEN: Note elevated risk in body — compound threshold passed but underlying structural quality is contested.')
: ''}
```

### Change 5: Add divergence + failure profile blocks to formatSonnetPrompt (auto-analysis)

**Location:** After the existing MC PBP-floor divergence check (~line 4878), before the MC RATE DRIVERS section.

**Divergence block (~8 lines):**
```javascript
// XGB-MC directional divergence (league-specific)
if (xgbData?.winProb != null && mcData?.mcCumWp != null) {
  const gap = xgbData.winProb - mcData.mcCumWp;
  if (gap < -0.10) {
    p += `  SIGNAL DIVERGENCE: MC Cum (${(mcData.mcCumWp * 100).toFixed(0)}%) >> XGB (${(xgbData.winProb * 100).toFixed(0)}%), gap ${Math.round(Math.abs(gap) * 100)}pp. ${league === 'wnba' ? 'MC leads divergence = 64% ctrl wins.' : 'Close-game WR: 92%. Trust MC.'}\n`;
  } else if (gap > 0.10) {
    p += `  SIGNAL DIVERGENCE: XGB (${(xgbData.winProb * 100).toFixed(0)}%) >> MC Cum (${(mcData.mcCumWp * 100).toFixed(0)}%), gap ${Math.round(Math.abs(gap) * 100)}pp. ${league === 'wnba' ? 'XGB leads divergence = 42.9% ctrl wins. Don\'t trust XGB over MC.' : 'Close-game WR: 50%. Caution.'}\n`;
  }
}
```

**Failure profile block (~6 lines):**
```javascript
// Failure profile flag (league-specific)
if (ind?.score >= 0.65 && (
  (mcData?.mcCumWp != null && mcData.mcCumWp < 0.60) ||
  (xgbData?.winProb != null && xgbData.winProb < 0.50)
)) {
  p += league === 'wnba'
    ? `⚠️ FAILURE PROFILE: Floor ${(ind.score * 100).toFixed(0)}% but MC/XGB don't confirm. WNBA floor HIGH + MC+XGB LOW = 20.2% WR. Floor is narrative-only.\n`
    : `⚠️ FAILURE PROFILE: Floor ${(ind.score * 100).toFixed(0)}% but MC/XGB don't confirm. Historical WR: 41-44%. Likely cumulative anchoring.\n`;
}
```

### Change 6: Post-game learning agent (post-game-agent.mjs)

**No changes.** The learning agent evaluates arcs after the fact — it doesn't make real-time decisions that need divergence context. The failure profile pattern will naturally surface in wrong-arc analysis.

---

## What This Does NOT Touch

| Component | Status | Why |
|-----------|--------|-----|
| Alert thresholds (BUY/BWC/EXIT gates) | Untouched | Context injections for agent reasoning, not mechanical gates |
| Checkpoint/graduation logic | Untouched | Compound confirmation thresholds are separate |
| EXIT/BUY mechanical decisions | Untouched | XGB EXIT fires on its own threshold |
| State machine (BWC lifecycle) | Untouched | No state transitions affected |
| DB schema | Untouched | Computed on-the-fly, not stored |
| Dashboard (v3.html, wnba-bdl.html) | Untouched | No visualization changes |
| ntfy formatting | Untouched | Body text comes from agent reasoning |
| XGB_INVALIDATED alert path (line 8485) | Untouched | Separate ctx without new fields; always SEND |
| post-game-agent.mjs | Untouched | Post-hoc evaluation, no real-time decisions |
| analyze.js (client analysis) | Untouched | Manual deep-dive, not automated gate |

---

## Expected Agent Behavior Changes

### NBA scenarios

| Signals | Before | After |
|---------|--------|-------|
| Floor 0.75, MC 0.45, XGB 0.55 | Agent sees 3 numbers, must infer | "FAILURE PROFILE (41-44% WR)" + "MC LEADS, 92% WR" → strong SUPPRESS |
| Floor 0.65, MC 0.80, XGB 0.40 | XGB low, MC high, no guidance | "MC LEADS, 92% WR" → trust MC, don't over-penalize low XGB |
| Floor 0.70, MC 0.50, XGB 0.72 | Generic "MC dominates" | "XGB LEADS, 50% WR" → structural quality unconfirmed by rates |
| Floor 0.85, MC 0.85, XGB 0.80 | All high | No new text fires — prompt identical to before |

### WNBA scenarios

| Signals | Before | After |
|---------|--------|-------|
| Floor 0.70, MC 0.40, XGB 0.35 | Trust hierarchy says "floor wrong 80%" | "FAILURE PROFILE (20.2% WR)" → quantified, actionable |
| Floor 0.65, MC 0.75, XGB 0.45 | MC high, XGB low | "MC LEADS, 64% WR" → trust MC |
| Floor 0.60, MC 0.50, XGB 0.65 | XGB higher than MC | "XGB LEADS, 42.9% WR — don't trust XGB over MC" |

---

## Risks

1. **Q2 false failure profiles:** Floor 0.65 + XGB 0.48 in Q2 when XGB is naturally noisier. NBA prompt says "SUPPRESS unless per-quarter breakdown shows current quarter supports floor." WNBA prompt says "SUPPRESS" outright because floor is narrative-only.

2. **Agent over-indexing:** Agent might mechanically suppress every failure profile fire. NBA prompt explicitly includes the escape hatch ("unless per-quarter breakdown"). WNBA has no escape hatch because the 20.2% WR data is unambiguous.

3. **WNBA sample sizes:** Directional numbers from 312 games. Pattern is clear but exact percentages may shift. These are agent context, not hard gates — even imprecise percentages correctly convey "MC leads > XGB leads."

4. **Interaction with existing trust hierarchy:** WNBA trust hierarchy already says "Floor HIGH + MC+XGB LOW = 20.2%." The failure profile repeats this on the specific alert. Intentional redundancy — reference text vs HERE-AND-NOW flag.

---

## Validation Plan

### Immediate (first live slate)

1. Trigger poll endpoint via `curl`, inspect agent prompt for a game with divergent signals.
2. Verify `_xgbMcClass` correct (MC_LEADS / XGB_LEADS / CONVERGED).
3. Verify failure profile fires only when floor ≥ 0.65 AND (MC < 0.60 OR XGB < 0.50).
4. Verify no new text when signals converged and floor < 0.65.
5. Verify correct league-specific text (NBA numbers vs WNBA numbers).

### Within 1 week

1. Pull alerts where `agent_reasoning` mentions "FAILURE PROFILE" or "SIGNAL DIVERGENCE."
2. Did agent correctly incorporate context into SEND/SUPPRESS?
3. Any wrong SUPPRESS from failure profile (team won)?
4. Any wrong SEND despite failure profile (team lost)?

---

## Implementation Checklist

| # | What | Lines | Location |
|---|------|-------|----------|
| 1 | Compute `_xgbMcGap`, `_xgbMcClass`, `_failureProfile` | ~18 | poll-live-bdl.mjs, before ctx (~7425) |
| 2 | Add 3 fields to ctx object | ~3 | poll-live-bdl.mjs, ctx (~7465) |
| 3 | Replace MC gap line with directional + league-specific | ~4 (replace 1) | buildV2AgentPrompt, MC TRAJECTORY (~800) |
| 4 | Add failure profile warning with league-specific text | ~8 | buildV2AgentPrompt, after conviction warnings (~763) |
| 5 | Add divergence block to formatSonnetPrompt | ~8 | formatSonnetPrompt, after MC divergence (~4878) |
| 6 | Add failure profile block to formatSonnetPrompt | ~6 | formatSonnetPrompt, after divergence block |
| 7 | Syntax check (`node -c`) + commit + push | — | — |

**Total: ~47 lines added, 1 line replaced. Single commit.**

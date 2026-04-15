# Monitor → Alert Agent Wire-Up Spec

**Date:** April 14, 2026
**Status:** PROPOSED — awaiting review

---

## WHAT

Wire the latest monitor observation into every `runAlertAgent` call so the alert agent has game-arc context (momentum, sustainability trajectory, risk factors) when making SEND/SUPPRESS decisions.

## WHY

The POR@PHX Q4 data proves the gap: at Q4 2:29, the alert agent suppressed a BUY FIRED (POR 0.57, trailing 3, TP PROBABLE) without knowing that momentum had been RISING for 6 consecutive polls and the floor-margin divergence was actively resolving. POR won 114-110. The monitor had the context. The agent didn't.

---

## CURRENT STATE

- **Prompt slot exists.** Lines 189-193 of `runAlertAgent` already have the `${ctx.monitorContext ? ... : ''}` conditional block with full MONITOR OBSERVATIONS section and NOTE about usage.
- **MONITOR OVERRIDE PROTECTION rule exists.** Line 230 — I4 COMBO YES + FIRED = always SEND even with monitor concerns, but add CAUTION line.
- **`monitorContext` is never populated.** All 5 `runAlertAgent` call sites pass `undefined` for monitorContext.
- **`gatherAgentContext` does not query monitor_observations.**

## CHANGES REQUIRED

### 1. Add monitor observation query to `gatherAgentContext`

**File:** `poll-live-bdl.mjs`
**Location:** End of `gatherAgentContext` function, before the `return` statement (currently line ~352)
**What:** Query the latest monitor observation for this game and format it as a string.

```
// After learningsContext block, before return:

let monitorContext = '';
try {
  const monObs = await sql`
    SELECT narrative, risk_factors, momentum_direction, momentum_streak, momentum_delta,
           sust_arc, sust_arc_detail, floor_margin_rel, floor_score, margin, period, clock, control_team
    FROM monitor_observations
    WHERE game_id = ${gameId}
    ORDER BY ts DESC LIMIT 1`;
  if (monObs.length > 0) {
    const m = monObs[0];
    monitorContext = `Q${m.period} ${m.clock} | ${m.control_team} floor ${Number(m.floor_score).toFixed(2)}, margin ${m.margin}\n`
      + `Momentum: ${m.momentum_direction}(${m.momentum_streak}, ${m.momentum_delta >= 0 ? '+' : ''}${Number(m.momentum_delta).toFixed(2)}) | Sust arc: ${m.sust_arc}${m.sust_arc_detail ? ' (' + m.sust_arc_detail + ')' : ''} | Floor-margin: ${m.floor_margin_rel}\n`
      + `Observation: ${m.narrative}\n`
      + `Risk: ${m.risk_factors}`;
  }
} catch (e) { /* non-fatal — monitor_observations table may not exist or be empty */ }
```

**Return:** Add `monitorContext` to the return object:
```
return { floorHistory, priorAlerts, quarterSummary, learningsContext, monitorContext };
```

### 2. Pass `monitorContext` at all 5 `runAlertAgent` call sites

Each call site currently ends with `learningsContext: agentCtx.learningsContext,` (or equivalent). Add one line after each:

| # | Line | Path | Change |
|---|------|------|--------|
| 1 | ~3770 | AUTO_ANALYSIS | Add `monitorContext: agentCtx.monitorContext,` |
| 2 | ~5070 | Main alerts (BUY/BWC/WB) | Add `monitorContext: agentCtx.monitorContext,` |
| 3 | ~5282 | RECOVERY PATH | Add `monitorContext: rpAgentCtx.monitorContext,` |
| 4 | ~5341 | LEAD CRUMBLING | Add `monitorContext: lcAgentCtx.monitorContext,` |
| 5 | ~5445 | VARIANCE BREAKING | Add `monitorContext: vbAgentCtx.monitorContext,` |

**Note:** Each call site uses its own `agentCtx` variable name (`agentCtx`, `rpAgentCtx`, `lcAgentCtx`, `vbAgentCtx`). Must match the local variable.

---

## CASCADING IMPLICATIONS

### A. Timing: Monitor runs AFTER alert agent in each poll cycle

The poll cycle flow is:
1. For each game: fetch data → compute indicators → check thresholds → route through alert agent
2. After ALL games: run monitor agent (3-min throttle)

**Implication:** The monitor observation available to the alert agent is always from a **prior cycle** (up to 3 min stale). This is correct behavior — the observation is contextual background, not real-time data. The alert agent has its own fresh snapshot data.

**Mitigation:** None needed. This is architecturally sound. The observation's timestamp is embedded in the context (`Q4 2:29 |...`) so the agent can see how recent it is.

### B. Control team mismatch between monitor and alert

The monitor's `control_team` might differ from the alert's control team if floor control flipped between the monitor cycle and the current poll.

**Example:** Monitor wrote `PHX controls at 0.57` 3 minutes ago, but now POR controls at 0.65. The alert fires for POR but the monitor context references PHX.

**Mitigation:** The formatted context includes the control team and timestamp. The agent prompt already says "Monitor observations provide trajectory context... they do not override mechanical FIRED thresholds." The agent sees fresh indicator data and the stale monitor read — it can reason about the flip. No code change needed; the mismatch itself is informative ("control just flipped from what the monitor saw").

### C. Token budget

Current agent prompt: ~2500-3000 input tokens (depending on prior alerts, floor history, learnings).
Monitor context adds: ~200-400 tokens (narrative ~150, risk ~150, mechanical signals ~50).
New total: ~2700-3400 tokens.

**Mitigation:** Well within Opus limits. No truncation needed. If future observations get longer, the `substring(0, 300)` on narrative in the prior-observation injection already caps the feed-forward chain — this is the full observation, which is 2-4 sentences per field per the prompt rules.

### D. Monitor observation is null

Early Q1 (before 5 live snapshots) or if monitor Sonnet call failed: no observation exists.

**Mitigation:** Already handled. The prompt template has `${ctx.monitorContext ? ... : ''}`. When monitorContext is empty string `''`, this evaluates to falsy and the entire MONITOR OBSERVATIONS block is omitted. Zero impact on agent behavior when no observation exists.

### E. First observation per game

The first monitor observation has no prior-observation context, so it's a full narrative restart (expected). This is fine — the alert agent doesn't need the monitor to have continuity, it just needs the latest read.

### F. Multiple alerts in same poll cycle

Multiple alerts can fire for the same game in one cycle (e.g., BUY + RECOVERY PATH). Each calls `gatherAgentContext` separately, which queries the DB each time.

**Mitigation:** This is the existing pattern for all context fields. The monitor query is a single-row `LIMIT 1` with an index on `game_id` — negligible cost. Not worth caching within a cycle.

### G. Interaction with existing MONITOR OVERRIDE PROTECTION rule

Line 230 already defines the interaction: I4 COMBO YES + FIRED = always SEND, monitor can only add CAUTION. This rule was written anticipating this wire-up and tested with scenarios 37-38 in test-agent.js.

**Mitigation:** None needed. Rule is already in production and tested.

---

## DEAD CODE CHECK

Searched for dead code related to the old monitor agent v1:

```
grep -n "getMonitorableConditions\|monitorableConditions\|activeAlerts.*monitor\|leadThreats\|emergingCandidate\|EMERGING\|TRACKING\|CONFIRMED\|FADING\|INVALIDATED\|SLATE_FOCUS" poll-live-bdl.mjs
```

**Finding:** Zero references to old v1 monitor functions. The v2 rewrite was a clean replacement. No dead code to remove.

**Other dead code candidates checked:**
- `monitor_status`, `monitor_reasoning`, `monitor_ts` columns on alerts table: mentioned in memories as "dead cols, left for compat." These are NOT referenced in any code path. Could be dropped via `ALTER TABLE` but low priority — they're nullable and cost nothing.
- `emerging_signal` column on alerts table: referenced in memories but not in current code. Same — dead but harmless.

**Recommendation:** Leave dead columns for now. They're nullable, don't affect queries, and removing them risks migration errors on a production table.

---

## TEST PLAN

### Verify with existing test-agent.js scenarios

The 38 existing test scenarios don't need changes — they pass `monitorContext: undefined` and the prompt correctly omits the block. They continue to validate baseline behavior without monitor context.

### New test scenarios to add (2)

**Test 39: Monitor context present — FIRED BUY with RISING momentum**
```
{
  alertType: 'BUY', alertTier: 'FIRED',
  floor: '0.73', margin: 3, isTrailing: true,
  period: 4, clock: '2:00', minsLeft: '2.0',
  i4: '0.50', i4Won: false, i4Combo: false, i4Decisive: false,
  indicatorsWon: 3, indWon: 'I1+I3+I5', indLost: '',
  convictionTier: 'STRONG', convictionCombo: 'I3+I5',
  tpClass: 'PROBABLE', ctrlSust: 'DURABLE', oppSust: 'COLD',
  ml: 150,
  monitorContext: 'Q4 3:17 | POR floor 0.57, margin -7\nMomentum: RISING(6, +0.23) | Sust arc: STABLE (LOCKED IN) | Floor-margin: ALIGNED\nObservation: Since the prior read, POR has closed the gap from 7 to 3 while maintaining floor control. The momentum rising trend continues as structural edge translates into scoreboard gains.\nRisk: If PHX exploits their free throw advantage and forces turnovers, I4 could flip.',
}
// Expected: SEND — RISING(6) momentum + 3 indicators + PROBABLE TP = strong structural case
```

**Test 40: Monitor context present — CANDIDATE BUY with FALLING momentum**
```
{
  alertType: 'BUY', alertTier: 'CANDIDATE',
  floor: '0.58', margin: 8, isTrailing: true,
  period: 3, clock: '5:00', minsLeft: '17.0',
  i4: '0.00', i4Won: false, i4Combo: false, i4Decisive: true,
  indicatorsWon: 1, indWon: 'I2', indLost: 'I4',
  convictionTier: 'CONDITIONAL', convictionCombo: 'I2',
  tpClass: 'UNLIKELY', ctrlSust: 'MIXED', oppSust: 'LOCKED IN',
  ml: 350,
  monitorContext: 'Q3 8:00 | PHX floor 0.60, margin 10\nMomentum: FALLING(4, -0.15) | Sust arc: DEGRADING (DURABLE → MIXED) | Floor-margin: DIVERGING\nObservation: PHX structural edge is eroding as opponent finds rhythm. Floor dropped from 0.75 to 0.60 over last 4 polls.\nRisk: If opponent hits 2 more threes, floor drops below 0.50.',
}
// Expected: SUPPRESS — CANDIDATE + I4 NO + FALLING momentum + DEGRADING sust = no case
```

---

## IMPLEMENTATION ORDER

1. Add monitor query + format to `gatherAgentContext` return
2. Add `monitorContext: agentCtx.monitorContext` to all 5 call sites
3. `node -c` syntax check
4. Add test scenarios 39-40 to test-agent.js
5. Run `?test=39,40` to verify
6. Run `?test=b1,b2,b3,b4,b5,b6,b7,b8,b9,b10,b11` to verify no regressions on existing scenarios
7. Commit and push

**Estimated changes:** ~20 lines in `gatherAgentContext`, 5 single-line additions at call sites, ~30 lines in test-agent.js. Total: ~55 lines across 2 files.

---

## WHAT DOES NOT CHANGE

- `runAlertAgent` prompt template — the monitorContext slot and MONITOR OVERRIDE PROTECTION rule are already in production
- Monitor agent v2 — no changes to how observations are written
- Alert thresholds — no mechanical gates change
- Alert dedup — no changes
- Transition alert routing — LEAD LOST stays direct-fire, RP/LC/VB get monitor context through the same agent path
- Post-game scoring — no changes
- ntfy format — no changes (agent BODY already handles CAUTION lines)

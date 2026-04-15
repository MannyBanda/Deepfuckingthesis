# Monitor → Analysis Wire-Up Spec (Auto-Analysis + Client Analysis)

**Date:** April 14, 2026
**Status:** PROPOSED — awaiting review

---

## WHAT

Wire the latest monitor observation into both:
1. **Auto Sonnet analysis** (`fireCalibrationAnalysis` → `formatSonnetPrompt` in poll-live-bdl.mjs)
2. **Client Sonnet analysis** (analyze.js)

So the analysis Sonnet has game-arc context (momentum, sustainability trajectory, risk factors) when producing FWP, NARRATIVE, and RISK assessments.

## WHY

The analysis Sonnet currently sees a single point-in-time snapshot. It doesn't know if the floor has been RISING for 6 polls or FALLING for 4. It doesn't know if opponent sustainability is DEGRADING or STABLE. The monitor has been watching the game continuously — its observations add trajectory context that a single snapshot can't provide.

---

## PATH 1: AUTO-ANALYSIS (server-side)

### Current flow:
```
fireCalibrationAnalysis() → builds payload → formatSonnetPrompt() → Anthropic API
```

### Change 1a: Query monitor observation in fireCalibrationAnalysis

**File:** poll-live-bdl.mjs
**Location:** Inside `fireCalibrationAnalysis`, after the analysis history query (section 4, ~line 3550) and before the payload build (section 6, ~line 3614).

Query is identical to the one already in `gatherAgentContext`:
```js
let monitorContext = null;
try {
  const monObs = await sql`
    SELECT narrative, risk_factors, momentum_direction, momentum_streak, momentum_delta,
           sust_arc, sust_arc_detail, floor_margin_rel, floor_score, margin, period, clock, control_team
    FROM monitor_observations
    WHERE game_id = ${game.id}
    ORDER BY ts DESC LIMIT 1`;
  if (monObs.length > 0) {
    const m = monObs[0];
    monitorContext = `Q${m.period} ${m.clock} | ${m.control_team} floor ${Number(m.floor_score).toFixed(2)}, margin ${m.margin}\n`
      + `Momentum: ${m.momentum_direction}(${m.momentum_streak}, ${m.momentum_delta >= 0 ? '+' : ''}${Number(m.momentum_delta).toFixed(2)}) | Sust arc: ${m.sust_arc}${m.sust_arc_detail ? ' (' + m.sust_arc_detail + ')' : ''} | Floor-margin: ${m.floor_margin_rel}\n`
      + `Observation: ${m.narrative}\n`
      + `Risk: ${m.risk_factors}`;
  }
} catch (e) { /* non-fatal */ }
```

**Note:** This is a copy of the same query from `gatherAgentContext`. NOT extracted into a shared function because `gatherAgentContext` is called per-alert (potentially multiple times per game per cycle) while `fireCalibrationAnalysis` is called once per quarter transition. Different call patterns, same query. Shared function adds indirection without benefit.

### Change 1b: Pass monitorContext to formatSonnetPrompt

**Location:** The `formatSonnetPrompt` call (~line 3614)

Add `monitorContext` to the parameter object:
```js
const userPrompt = formatSonnetPrompt({
  hA, aA, period, clock, score: scoreLine,
  thesis: thesis || null,
  sust, leadComp, ind, clutchData, odds, espnWP, wpProfiles, analysisHistory,
  ctx: clientCtx || {},
  quarterDataFromDB,
  summary,
  conviction: calConviction,
  monitorContext,  // ← ADD THIS
});
```

### Change 1c: Add monitorContext to formatSonnetPrompt function

**Location:** `formatSonnetPrompt` function signature (~line 3168) — add `monitorContext` to destructured params.

**Location:** Before the `GAME DATA` section at the end of the function (~line 3490), after analysis history and before `return p`:

```js
// Monitor observation (game-arc context)
if (monitorContext) {
  p += `\nMONITOR OBSERVATION (continuous 3-minute game observer — most recent read):\n`;
  p += monitorContext + '\n';
  p += 'USE: The monitor tracks momentum, sustainability arcs, and floor-margin dynamics between snapshots. ';
  p += 'Reference its trajectory reads in your NARRATIVE and RISK. ';
  p += 'If the monitor flags a specific flip scenario in its Risk section, address it. ';
  p += 'Monitor observations do NOT override your ground truth indicators.\n';
}
```

### Change 1d: Add monitorContext to layerInventory diagnostic

**Location:** The `layerInventory` array (~line 3640)

Add: `monitorContext ? 'monitor' : null,`

---

## PATH 2: CLIENT ANALYSIS (analyze.js)

### Architecture constraint: analyze.js has no DB access

analyze.js is a stateless Sonnet relay — it receives a payload from the client and forwards to Anthropic. It does NOT import neon or have DATABASE_URL access. Adding DB access would change its architecture.

**Decision:** Client fetches monitor observation and passes in the payload. analyze.js includes it in the prompt.

### Change 2a: Accept monitorContext in analyze.js payload

**File:** analyze.js
**Location:** After the payload parsing block (~line 490)

Add one line:
```js
var monitorContext = body.monitorContext || null;
```

### Change 2b: Add monitor section to analyze.js prompt

**Location:** In the prompt building (~line 808), before the GAME DATA line.

Add a new section variable and include it:
```js
var monitorSection = '';
if (monitorContext) {
  monitorSection = '\nMONITOR OBSERVATION (continuous 3-minute game observer — most recent read):\n'
    + monitorContext + '\n'
    + 'USE: The monitor tracks momentum, sustainability arcs, and floor-margin dynamics between snapshots. '
    + 'Reference its trajectory reads in your NARRATIVE and RISK. '
    + 'If the monitor flags a specific flip scenario in its Risk section, address it. '
    + 'Monitor observations do NOT override your ground truth indicators.\n';
}
```

Then include `monitorSection` in the prompt concatenation before GAME DATA:
```js
+ narrativeSection + wpSection + espnWPSection + monitorSection
+ '\nGAME DATA:\n' + JSON.stringify(summaryData);
```

### Change 2c: Client-side — fetch monitor observation before calling analyze

**File:** bdl.html
**Location:** The `analyzeGame()` function (or wherever the analyze POST is built)

Before the fetch to analyze.js, add:
```js
// Fetch latest monitor observation for this game
let monitorContext = null;
try {
  const monRes = await fetch(`/.netlify/functions/db-api?action=get_monitor_observations&game_id=${gameId}&latest_per_game=1`);
  const monData = await monRes.json();
  if (monData.observations && monData.observations.length > 0) {
    const m = monData.observations[0];
    monitorContext = `Q${m.period} ${m.clock} | ${m.control_team} floor ${Number(m.floor_score).toFixed(2)}, margin ${m.margin}\n`
      + `Momentum: ${m.momentum_direction}(${m.momentum_streak}, ${m.momentum_delta >= 0 ? '+' : ''}${Number(m.momentum_delta).toFixed(2)}) | Sust arc: ${m.sust_arc}${m.sust_arc_detail ? ' (' + m.sust_arc_detail + ')' : ''} | Floor-margin: ${m.floor_margin_rel}\n`
      + `Observation: ${m.narrative}\n`
      + `Risk: ${m.risk_factors}`;
  }
} catch (e) { /* non-fatal — monitor may not have observations yet */ }
```

Then add `monitorContext` to the POST body sent to analyze.js.

**Note:** The formatting logic is duplicated 3x now (gatherAgentContext, fireCalibrationAnalysis, bdl.html client). This is intentional — each context has different runtime constraints (server function, server function, browser). Extracting a shared formatter would require either a shared module (Netlify bundles separately) or a utility endpoint (extra HTTP call). The format is 6 lines of string concatenation — duplication cost is low, coupling cost of sharing is high.

---

## CASCADING IMPLICATIONS

### A. Timing alignment — auto-analysis fires at quarter transitions

Auto-analysis fires at Q1→Q2, Q2→Q3, Q3→Q4 transitions. The monitor fires every 3 minutes. So the latest monitor observation at a quarter transition could be up to 3 minutes stale.

**This is fine.** The quarter transition snapshot has fresh indicator data. The monitor observation provides the arc context ("momentum was RISING for 6 polls leading into this break"). The staleness is a feature — it's the pre-transition state.

### B. Client analysis fires on manual button press

The user clicks "Analyze" whenever they want. The monitor observation could be from any point in the game.

**This is fine.** Same reasoning — the analysis has fresh snapshot data, the monitor adds arc context. The observation timestamp is embedded in the context.

### C. Token budget for analysis

Auto-analysis prompts are already large (3000-6000 tokens depending on layers). Monitor adds ~200-400 tokens.

**Mitigation:** Well within Opus limits (auto-analysis uses Opus). Client analysis uses Sonnet — also within limits.

### D. Monitor observation is null

Early Q1, first game of the night, or monitor Sonnet call failed.

**Mitigation:** All three paths check for null/empty before adding the section. When null, zero impact — no section in prompt.

### E. No changes to SYSTEM_PROMPT

The SYSTEM_PROMPT is shared between auto-analysis and client analysis. The monitor guidance is in the prompt section itself ("USE: The monitor tracks..."), not in the system prompt. No system prompt changes needed.

### F. No changes to output format

The analysis Sonnet outputs FWP, EDGE, RISK, CLOSING, NARRATIVE, Sustainability, Lead Source, DISAGREEMENT. None of these formats change. The monitor context just informs what Sonnet writes in NARRATIVE and RISK.

---

## DEAD CODE CHECK

No dead code found in either path. `formatSonnetPrompt` is used only by `fireCalibrationAnalysis`. analyze.js is self-contained.

---

## IMPLEMENTATION ORDER

1. poll-live-bdl.mjs: Add `monitorContext` to `formatSonnetPrompt` signature
2. poll-live-bdl.mjs: Add monitor section to `formatSonnetPrompt` body (before GAME DATA)
3. poll-live-bdl.mjs: Add monitor observation query to `fireCalibrationAnalysis`
4. poll-live-bdl.mjs: Pass `monitorContext` in `formatSonnetPrompt` call
5. poll-live-bdl.mjs: Add `'monitor'` to layerInventory
6. analyze.js: Accept `monitorContext` from payload
7. analyze.js: Build `monitorSection` and add to prompt
8. `node -c` both files
9. Client-side (bdl.html): Fetch monitor obs + pass in analyze POST body — **DEFER to separate commit** since bdl.html is 12K+ lines and higher risk. The server-side changes are independent and can ship first.
10. Commit and push

**Estimated changes:** ~25 lines in poll-live-bdl.mjs, ~10 lines in analyze.js. Client-side deferred.

---

## WHAT DOES NOT CHANGE

- SYSTEM_PROMPT — shared between both analysis paths, no changes
- Analysis output format (FWP, EDGE, RISK, etc.) — no changes
- Monitor agent — no changes to how observations are written
- Alert agent wire-up — already shipped, independent
- get_monitor_observations endpoint — already supports the queries needed
- Post-game scoring — no changes

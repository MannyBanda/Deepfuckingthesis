# Alert System v2 — Production Build Specification

**Version:** 2.0
**Date:** April 17, 2026
**Status:** VALIDATED — ready to wire to production
**Evidence:** 9/9 mechanical, 41/41 agent decisions correct across 6 games, 6 test sessions
**Replaces:** TIERED_ALERT_SPEC v1.0 (pre-harness, invalidated by test data)
**Source:** V2_TEST_RESULTS.md, V2_AGENT_RULES.md, V2_TEST_HANDOFF.md, test-v2-engine.mjs (~1,120 lines)

---

## 1. Problem Statement

v1 fires disconnected alerts with no narrative continuity. Subscribers get "BUY SAC" then
"LEAD LOST SAC" then "BUY WINDOW CLOSING SAC" with no thread connecting them.

**Forcing function:** GSW@LAC 4/15 — LAC 0.93 floor at Q4 10:23, collapsed to 0.52 by Q4 8:16,
lost 121-126. v1 auto-analysis sent "DOMINANT strengthening" at Q4 12:00 right before collapse.
Zero cash-out signals fired. $1,300 loss.

v2 replaces flat alerts with a BWC state machine tracking one thesis team through
LOCK → EDGE → VALUE → EXIT states. Each alert references prior alerts, building a compounding
narrative arc.

---

## 2. Architecture

### Two-Layer Authority (was three — monitor killed in Test 6)

1. **Engine** — computes I1-I5, floor, conviction, erosion, BWC state machine. Mechanical, immutable.
2. **Agent** (Opus 4.6) — decides SEND/SUPPRESS, writes plain-English body. Sees engine output +
   floor trajectory + prior alert reasoning trail. Cannot override mechanical scores.

### BWC State Machine

Single thesis team. First team to demonstrate 3+ consecutive holds at BWC-eligible conditions
(floor ≥ 0.60, leading 2+, period ≥ 2) becomes the BWC team. All subsequent alerts track this
team's lifecycle:

```
LOCK (leading 3+) ←→ EDGE (leading 1-2) ←→ VALUE (tied/trailing 1-7, ctrl retained) ←→ EXIT (ctrl flipped)
                                                                                    ↕
                                                                              DEEP_TRAIL (trailing 8+)
```

Transitions classified as:
- **DEGRADING** (subscriber needs to act): LOCK→EDGE, EDGE→VALUE, *→EXIT
- **RECOVERING** (position validation): EXIT→VALUE (THESIS_ALIVE), VALUE→EDGE, *→LOCK
- **LATERAL** (noise, filtered): same-rank transitions

### Alert Types

| Type | When | Default | Agent? |
|---|---|---|---|
| BUY WINDOW CLOSING | Initial BWC fire (3-hold minimum) | SEND | Yes — establishes position |
| BWC_EDGE | LOCK→EDGE (lead compressing to 1-2) | ALWAYS SEND | Yes — must include RISK line |
| VALUE | Lead lost, ctrl retained (tied/trailing 1-7) | Agent decides | Yes |
| EXIT | Ctrl flipped to opponent | ALWAYS SEND | Yes — cash-out signal |
| THESIS_ALIVE | EXIT→VALUE (regained ctrl after losing it) | Agent decides | Yes — cooldown exempt |
| POSITION_SAFE | Recovery to LOCK | SEND if prior risk | Yes |
| POSITION_RECOVERING | Recovery to EDGE | SEND if prior risk | Yes |
| BUY | Dominant team trailing, any game | Agent decides | Yes — warm/cold distinction |

### BUY Coexists with Lifecycle

BUY fires for ANY structurally dominant team trailing — including the BWC team. After BWC fires,
lifecycle alerts (VALUE, EXIT, THESIS_ALIVE) track position health. BUY identifies entry/re-entry
at plus-money. A BUY with BWC context = "warm BUY" (thesis history). BUY without = "cold BUY"
(unproven, higher bar).

### What Dies

| v1 Alert | Replacement |
|---|---|
| WINDOW BUY (54% accuracy) | Killed — no replacement |
| LEAN BUY (17% accuracy) | Killed (already dead) |
| RECOVERY PATH | THESIS_ALIVE (EXIT→VALUE) |
| LEAD CRUMBLING | BWC_EDGE (LOCK→EDGE) + erosion detection |
| LEAD LOST | VALUE (lead lost, ctrl retained) or EXIT (ctrl lost) |
| VARIANCE BREAKING | Agent context on opponent sustainability — not a separate type |
| Monitor agent (Sonnet) | Killed — proven redundant in Test 6 (0/41 decisions changed) |

---

## 3. Files Affected

| File | Lines (current) | Net Change | Risk |
|---|---|---|---|
| `poll-live-bdl.mjs` | 5,957 | ~-470 (add ~300, remove ~770) | HIGH |
| `db-api.js` | 2,430 | +15 | LOW |
| `analyze.js` | 862 | -20 | LOW |
| `bdl.html` | ~12,235 | -15 | LOW |
| `post-game-agent.mjs` | ~270 | ~5 | LOW |

---

## 4. DB Schema Changes (`db-api.js`)

### 4a. New column on `games` table

Insert after line 173 (after `away_lead_degraded_at` ALTER):

```js
try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS live_tracking JSONB`; } catch(e) {}
```

**JSONB shape** (written every poll cycle per game):

```json
{
  "home_peak_floor": 0.93,
  "home_peak_time": "Q3 2:15",
  "away_peak_floor": 0.71,
  "away_peak_time": "Q2 6:44",
  "ctrl_team_current": "LAC",
  "ctrl_team_holds": 8,
  "bwc_fired": {
    "team": "SAC",
    "period": 2,
    "clock": "6:58",
    "floor": 0.68
  },
  "_prev_bwc_state": "EDGE",
  "_bwc_candidate": null,
  "_bwc_candidate_holds": 0,
  "_last_any_bwc_ts": 1713400000000,
  "_last_buy_ts": null,
  "_last_fired_state": "EDGE",
  "_last_fired_floor": 0.71,
  "_last_fired_margin": 2,
  "_last_fired_ts": 1713400000000
}
```

**Cascading:** None. New column, read/write only by new poll code. If column doesn't exist
pre-migration, SELECT returns null, code initializes fresh.

### 4b. New columns on `alerts` table

Insert after line 333 (after `emerging_signal` ALTER):

```js
try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS bwc_state TEXT`; } catch(e) {}
try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS erosion_level TEXT`; } catch(e) {}
try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS peak_floor REAL`; } catch(e) {}
try { await sql`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS exit_severity TEXT`; } catch(e) {}
```

**Cascading:** Additive. No existing queries break. Alert accuracy queries in debug.html and
post-game-agent group by `alert_type` — new types auto-appear.

### 4c. Dead columns (DO NOT remove — historical data exists)

Mark as deprecated in a comment. These columns are no longer written to by v2 code but contain
historical v1 data that post-game analysis may reference:

**On `games` table:**
- `prev_home_tp_class`, `prev_home_ls_class`, `prev_home_ls_margin`, `prev_home_opp_sust`
- `prev_away_tp_class`, `prev_away_ls_class`, `prev_away_ls_margin`, `prev_away_opp_sust`
- `home_lead_degraded_at`, `away_lead_degraded_at`
- `prev_tp_class`, `prev_ls_class`, `prev_opp_sust` (old single-side tracking)
- `prev_tp_exp`, `prev_ls_exp`, `prev_ctrl_team`

**On `alerts` table:**
- `monitor_status`, `monitor_reasoning`, `monitor_ts`, `parent_alert_id`, `emerging_signal`

**On `poll_state` table:**
- `monitor_last_run`

---

## 5. Snapshot Contamination Fix (`poll-live-bdl.mjs`)

### Root cause (diagnosed from live DB data)

Two sources of non-mechanical snapshots:

1. **Calibration snapshots** (source = `calibration_q1`/`calibration_q2`/`auto_q3` etc) at line 5783.
   Indicator values ARE correct (0/0.5/1 from `computeServer`). Missing `raw_stats_json` column.
   Fix: add the column to the INSERT.

2. **Client snapshots** (source = `client`). Written by the dashboard when the Analyze button is
   pressed. Contain **Sonnet-derived weighted indicator scores** (e.g., I1:0.25, I2:0.10) that are
   NOT mechanical 0/0.5/1 values. These masquerade as real snapshots and cause false control flips
   when replayed by the v2 engine.

### Fix 1: Add `raw_stats_json` to calibration snapshot INSERT

**Current** (line 5783-5794) — columns list ends with `ls_exp_swing)`.

**Change:** Add `, raw_stats_json` to column list and `${rawStatsJson}` to values. The
`rawStatsJson` variable is computed at line 4910 as `var` (function-scoped in the handler) and is
accessible at line 5783.

**Cascading:** None. Additive column in INSERT. Calibration snapshots now have the same audit trail
as polling snapshots.

### Fix 2: v2 engine snapshot reads filter by source

All v2 code that reads snapshots for state computation (floor trajectory, prior context) must use:
```sql
WHERE source = 'server'
```
This excludes both client-written Sonnet snapshots AND calibration snapshots from before the fix.

**Applies to:**
- `gatherAgentContext` floor history query (line ~310) — add `AND source = 'server'`
- Any new snapshot queries added for v2 context assembly

The client snapshot write path itself is unchanged — it's useful for the dashboard. The v2 engine
simply ignores non-server snapshots.

---

## 6. New Mechanical Functions (`poll-live-bdl.mjs`)

Add as standalone functions above the main handler. Source of truth: test harness lines 80-191,
validated 9/9. Copy and adapt (harness uses array iteration; production reads from `live_tracking`
JSONB).

### 6a. `updateLiveTracking(lt, ctrlTeam, floor, period, clock, homeAlias)`

Updates peak floor and consecutive holds. Called every poll cycle after `computeServer`.

```js
function updateLiveTracking(lt, ctrlTeam, floor, period, clock, homeAlias) {
  if (!lt) lt = {};
  const side = ctrlTeam === homeAlias ? 'home' : 'away';
  const peakKey = side + '_peak_floor';
  const timeStr = 'Q' + period + ' ' + clock;

  if (!lt[peakKey] || floor > lt[peakKey]) {
    lt[peakKey] = floor;
    lt[side + '_peak_time'] = timeStr;
  }

  if (lt.ctrl_team_current === ctrlTeam) {
    lt.ctrl_team_holds = (lt.ctrl_team_holds || 0) + 1;
  } else {
    lt.ctrl_team_current = ctrlTeam;
    lt.ctrl_team_holds = 1;
  }

  return lt;
}
```

**Cascading:** None. New standalone function.

### 6b. `computeBwcState(lt, ctrlTeam, margin)`

Returns current BWC state or null if BWC hasn't fired.

```js
function computeBwcState(lt, ctrlTeam, margin) {
  const bwcFired = lt.bwc_fired;
  if (!bwcFired || !ctrlTeam) return null;

  if (bwcFired.team === ctrlTeam) {
    if (margin >= 3) return 'LOCK';
    if (margin >= 1) return 'EDGE';
    if (margin >= -7) return 'VALUE';   // tied or trailing 1-7
    return 'DEEP_TRAIL';                // trailing 8+
  } else {
    return 'EXIT';                      // ctrl flipped to opponent
  }
}
```

### 6c. `classifyTransition(fromState, toState)`

```js
const STATE_RANK = { 'LOCK': 4, 'EDGE': 3, 'VALUE': 2, 'EXIT': 1, 'DEEP_TRAIL': 0 };

function classifyTransition(fromState, toState) {
  const fromRank = STATE_RANK[fromState] ?? -1;
  const toRank = STATE_RANK[toState] ?? -1;
  if (toRank < fromRank) return 'DEGRADING';
  if (toRank > fromRank) return 'RECOVERING';
  return 'LATERAL';
}
```

### 6d. `computeErosion(lt, floor, homeAlias, ctrlTeam)`

Peak-relative erosion detection. CAUTION at 40% edge erosion, COLLAPSE at 70%.

```js
function computeErosion(lt, floor, homeAlias, ctrlTeam) {
  const side = ctrlTeam === homeAlias ? 'home' : 'away';
  const peakFloor = lt[side + '_peak_floor'] || null;
  if (!peakFloor || floor >= peakFloor) {
    return { level: 'STABLE', peakFloor, peakDelta: 0 };
  }
  const peakDelta = floor - peakFloor;
  const edgeAboveCoinFlip = peakFloor - 0.50;
  if (edgeAboveCoinFlip <= 0) {
    return { level: 'STABLE', peakFloor, peakDelta };
  }
  const cautionDelta = -(edgeAboveCoinFlip * 0.40);
  const collapseDelta = -(edgeAboveCoinFlip * 0.70);
  let level = 'STABLE';
  if (peakDelta <= collapseDelta) level = 'COLLAPSE';
  else if (peakDelta <= cautionDelta) level = 'CAUTION';
  return { level, peakFloor, peakDelta, cautionDelta, collapseDelta };
}
```

### 6e. `computeExitSeverity(ctrlIndicators, ctrlIndicatorCount, ctrlFloor, holds)`

At EXIT, the current ctrl team IS the opponent. Assesses how structural their position is.

```js
function computeExitSeverity(ctrlIndicators, ctrlIndicatorCount, ctrlFloor, holds) {
  const oppOnlyI3 = ctrlIndicatorCount === 1 && ctrlIndicators.includes('I3');
  const oppHasI1 = ctrlIndicators.includes('I1');
  const oppHasI4 = ctrlIndicators.includes('I4');

  if (holds >= 5 && ctrlFloor >= 0.70 && ctrlIndicatorCount >= 2 && !oppOnlyI3) {
    return { severity: 'STRUCTURAL_TAKEOVER',
      reason: 'Opponent floor ' + ctrlFloor.toFixed(2) + ', ' + holds + ' holds, '
        + ctrlIndicatorCount + ' indicators (' + ctrlIndicators.join('+') + ')' };
  }
  if (holds >= 3 && (oppHasI1 || oppHasI4) && ctrlFloor >= 0.60) {
    return { severity: 'CONCERNING',
      reason: 'Opponent structural indicators (' + ctrlIndicators.join('+') + ') with '
        + holds + ' holds' };
  }
  return { severity: 'TEMPORARY',
    reason: 'Opponent floor ' + ctrlFloor.toFixed(2) + ', ' + holds + ' holds'
      + (oppOnlyI3 ? ', only I3 (variance)'
        : ctrlIndicatorCount === 0 ? ', no indicators won' : '') };
}
```

**All five functions: zero cascading implications. New standalone code.**

---

## 7. BWC Trigger Detection + Context Assembly (`poll-live-bdl.mjs`)

### 7a. Where it goes

The new BWC trigger detection block replaces the existing mechanical alert block
(lines ~5041-5401) and transition alerts block (lines ~5403-5714). Both blocks are removed entirely
and replaced with a single unified block.

### 7b. Per-poll-cycle flow (new code, ~200 lines)

```
1. Read live_tracking from games table
2. Call updateLiveTracking(lt, ctrlTeam, floor, period, clock, hA)
3. Compute BWC state: computeBwcState(lt, ctrlTeam, ctrlMargin)
4. Compute erosion: computeErosion(lt, floor, hA, ctrlTeam)
5. Check BWC first fire conditions (3-hold, floor ≥ 0.60, leading 2+, period ≥ 2)
6. If BWC previously fired: check state transitions → fire lifecycle alerts
7. Check BUY triggers (FIRED ≥ 0.65, CANDIDATE 0.55-0.65, trailing 1-15, period ≥ 2)
8. For each trigger: assemble context package → call runAlertAgent → ntfy + DB
9. Write live_tracking back to games table
```

### 7c. Initial BWC fire detection

```js
// BWC candidate tracking — persisted in live_tracking
if (!lt.bwc_fired && period >= 2 && floor >= 0.60 && ctrlMargin >= 2) {
  if (lt._bwc_candidate === ctrlTeam) {
    lt._bwc_candidate_holds = (lt._bwc_candidate_holds || 0) + 1;
  } else {
    lt._bwc_candidate = ctrlTeam;
    lt._bwc_candidate_holds = 1;
  }

  if (lt._bwc_candidate_holds >= 3) {
    lt.bwc_fired = { team: ctrlTeam, period, clock, floor };
    const initialState = ctrlMargin >= 3 ? 'LOCK' : 'EDGE';
    lt._prev_bwc_state = initialState;
    // → route through agent as "BUY WINDOW CLOSING" (initial fire)
    // → save to alerts table with bwc_state = initialState
    // → record in game._v2Alerts for compounding trail
  }
} else if (!lt.bwc_fired && ctrlTeam !== lt._bwc_candidate) {
  lt._bwc_candidate = null;
  lt._bwc_candidate_holds = 0;
}
```

**Cascading:** `lt._bwc_candidate*` fields persist in `live_tracking` JSONB across cold starts.
If a game spans a deploy, the candidate tracking picks up where it left off.

### 7d. State transition detection (after BWC fires)

```js
if (lt.bwc_fired) {
  const bwcState = computeBwcState(lt, ctrlTeam, ctrlMargin);
  const prevState = lt._prev_bwc_state;

  if (bwcState && prevState && bwcState !== prevState) {
    const direction = classifyTransition(prevState, bwcState);

    // Skip LATERAL and DEEP_TRAIL (BUY handles deep trails)
    if (direction !== 'LATERAL' && bwcState !== 'DEEP_TRAIL') {

      // Map state + direction → alert type
      let alertType = null;
      if (direction === 'DEGRADING') {
        if (bwcState === 'EDGE') alertType = 'BWC_EDGE';
        else if (bwcState === 'VALUE') alertType = 'VALUE';
        else if (bwcState === 'EXIT') alertType = 'EXIT';
      } else if (direction === 'RECOVERING') {
        if (bwcState === 'LOCK') alertType = 'POSITION_SAFE';
        else if (bwcState === 'EDGE') alertType = 'POSITION_RECOVERING';
        else if (bwcState === 'VALUE') alertType = 'THESIS_ALIVE';
      }

      if (alertType) {
        // Apply gates (cooldown, material change) → assemble context → agent → ntfy → DB
      }
    }
  }

  lt._prev_bwc_state = bwcState;
}
```

### 7e. Mechanical gates

**3-minute universal cooldown** (all BWC transitions):
```js
const BWC_COOLDOWN_MS = 180000;
const msSinceAnyBwc = lt._last_any_bwc_ts ? (Date.now() - lt._last_any_bwc_ts) : Infinity;
const cooldownExempt = alertType === 'THESIS_ALIVE';  // EXIT→VALUE always fires
const cooldownPassed = cooldownExempt || msSinceAnyBwc >= BWC_COOLDOWN_MS;
```

**Material change gate** (prevents same-direction re-fires without meaningful delta):
```js
const stateChanged = bwcState !== lt._last_fired_state;
const floorDelta = Math.abs(floor - (lt._last_fired_floor || 0));
const marginDelta = Math.abs(ctrlMargin - (lt._last_fired_margin || 0));
const timeDelta = lt._last_fired_ts ? (Date.now() - lt._last_fired_ts) : Infinity;
const materialChange = floorDelta >= 0.10 || marginDelta >= 5 || timeDelta >= 300000;
const shouldFire = cooldownPassed && (stateChanged || materialChange);
```

**BUY triggers** (separate cooldown):
```js
const BUY_COOLDOWN_MS = 180000;
if (period >= 2 && floor >= 0.55 && ctrlTrailing && margin >= 1 && margin <= 15
    && alertMinsLeft >= 1.0) {
  const msSinceLastBuy = lt._last_buy_ts ? (Date.now() - lt._last_buy_ts) : Infinity;
  if (msSinceLastBuy >= BUY_COOLDOWN_MS) {
    const buyTier = floor >= 0.65 ? 'FIRED' : 'CANDIDATE';
    const bwcTeamMatch = lt.bwc_fired?.team === ctrlTeam;
    // → assemble context with bwcTeamMatch flag → agent
  }
}
```

**Clock gate:** < 1 min remaining = suppress (unchanged from v1, uses `alertMinsLeft`).

**Cascading:** All gate timestamps persist in `live_tracking` JSONB. Survives cold starts.

### 7f. Context package assembly

Built per-trigger, passed to agent. Shape matches harness `assembleContextPackage` (lines 532-675):

```js
const ctx = {
  // Engine data
  floor, margin: ctrlMargin, period, clock, ctrlTeam,
  i1, i2, i3, i4, i5,                          // control-team-relative (0-1)
  ctrlIndicators: indWon.join('+') || 'none',   // e.g., "I1+I4+I5"
  ctrlIndicatorCount: indWon.length,

  // Opponent profile
  oppIndicatorCount, oppIndicatorsWon: oppIndWon.join('+') || 'none',
  oppI3Won: oppIndWon.length === 1 && oppIndWon[0] === 'I3',

  // Position health
  peakFloor: erosion.peakFloor,
  peakDelta: erosion.peakDelta,
  erosionLevel: erosion.level,
  consecutiveHolds: lt.ctrl_team_holds || 0,
  bwcState,
  bwcTeam: lt.bwc_fired?.team || null,
  bwcFirePeriod: lt.bwc_fired?.period || null,
  bwcFireFloor: lt.bwc_fired?.floor || null,

  // Score context
  homeAlias: hA, awayAlias: aA,
  homePts: ind.homePts, awayPts: ind.awayPts,
  ctrlIsHome: ctrlTeam === hA,

  // Sustainability + TP/LS
  ctrlSust, oppSust, tpClass, lsClass,

  // Trail data (from DB queries)
  floorHistory,      // last 5 server snapshots, formatted
  priorAlertTrail,   // last 5 v2 alerts for this game, with reasoning
};
```

**Floor history query:**
```sql
SELECT period, clock, floor_score, floor_team, home_pts, away_pts, tp_class, ls_class
FROM snapshots WHERE game_id = $1 AND source = 'server'
ORDER BY ts DESC LIMIT 5
```

**Prior alert trail query:**
```sql
SELECT alert_type, bwc_state, period, clock, floor_score, margin,
       agent_decision, agent_reasoning
FROM alerts WHERE game_id = $1 AND alert_type != 'AUTO_ANALYSIS'
ORDER BY ts DESC LIMIT 5
```

---

## 8. Agent Prompt Rewrite (`poll-live-bdl.mjs`)

### 8a. `runAlertAgent()` (lines 160-280) — FULL REWRITE

Replace the entire prompt string. Do not attempt to merge v1 and v2 prompts.

**Function signature unchanged:**
```js
async function runAlertAgent(ctx) { ... }
```

**New prompt** (source: harness lines 916-965, validated 41/41):

```
You are a live NBA betting alert quality agent. A mechanical system has identified a
potential betting signal. Your job is to assess whether it should be sent to the bettor.

ALERT:
Type: {alertType} ({alertTier})
Control team: {ctrlTeam} | Floor: {floor} | Margin: {margin} (trailing/leading/tied)
Score: {awayAlias} {awayPts} - {homeAlias} {homePts} ({ctrlTeam} is HOME/AWAY)
Period: Q{period} {clock}
BWC team (subscriber position): {bwcTeam} (NOT current ctrl team — ctrl flipped to {ctrlTeam})

INDICATORS (control-team-relative):
I1-I5 scores, won count, sust, TP, LS

OPPONENT PROFILE:
Won count, which indicators, oppI3Won flag with guidance text

POSITION HEALTH:
Peak floor, delta, erosion level, consecutive holds, BWC lifecycle state + fire info

FLOOR TRAJECTORY:
Last 5 server snapshots with TP/LS

PRIOR ALERT REASONING TRAIL:
Last 5 alerts with decisions and reasoning

RULES:
- VALUE: structural edge intact, dip temporary, plus-money entry. 1-7 sweet spot.
- THESIS_ALIVE: deep-value — erosion is EXPECTED. Weight I1+I4 core, oppI3Won, TP path.
- EXIT: cash-out. Frame around BWC team losing edge. Reference arc.
- BWC_EDGE: ALWAYS SEND. Status + RISK line. Accountability chain.
- POSITION_SAFE/RECOVERING: SEND if prior risk to update on.
- BUY: trailing team, floor/indicators/TP/deficit depth. 1-7 sweet spot.
- REASONING AS JOURNAL: thorough even when SUPPRESS.

Respond: DECISION / REASONING / BODY
```

(Full prompt text in Section 8 of the raw spec file — too long to inline here.
See test-v2-engine.mjs lines 916-965 for exact validated text.)

**Model:** `claude-opus-4-6`
**max_tokens:** 600

**Fallback:** Agent failure → FIRED sends with mechanical fallback body, CANDIDATE drops.

### 8b. What the new prompt removes vs v1

| v1 Prompt Element | Status |
|---|---|
| I4 COMBO YES/NO rules | Replaced by indicator counting + oppI3Won |
| MONITOR OVERRIDE PROTECTION | Removed (monitor killed) |
| LEAN BUY / WINDOW BUY rules | Removed (killed) |
| RECOVERY PATH / LEAD CRUMBLING / VARIANCE BREAKING rules | Replaced by lifecycle |
| ANCHORED FLOOR CHECK | Replaced by erosion detection |
| `ctx.monitorContext` | Removed |
| `ctx.learningsContext` | Removed (prior alert trail replaces it) |
| `ctx.windowScore` | Removed |
| `ctx.i4Combo`, `ctx.i4Decisive` | Removed |

### 8c. Call sites audit

**v1 call sites (5) → v2 call sites (3):**

| Call Site | v1 | v2 |
|---|---|---|
| Mechanical alerts (~line 5261) | Active | **REPLACED** by v2 lifecycle triggers |
| RECOVERY PATH (~line 5482) | Active | **REMOVED** |
| LEAD CRUMBLING (~line 5544) | Active | **REMOVED** |
| VARIANCE BREAKING (~line 5653) | Active | **REMOVED** |
| Auto-analysis (~line 3936) | Active | **KEPT** (separate system) |
| v2 BWC lifecycle triggers | — | **NEW** |
| v2 BUY triggers | — | **NEW** |

**Auto-analysis compatibility:** The auto-analysis call at line 3936 passes v1-shaped ctx with
fields like `ctx.i4Combo`, `ctx.monitorContext`. These fields don't appear in the v2 prompt
template string — they're harmlessly ignored. Fields that ARE used (`ctx.alertType`, `ctx.floor`,
`ctx.margin`, etc.) are already present. **No changes needed to auto-analysis ctx construction.**

**Verification post-build:** grep for all `runAlertAgent(` calls. Must find exactly 3:
auto-analysis (~line 3936), v2 lifecycle triggers (new), v2 BUY triggers (new).

---

## 9. Auto-Analysis Enhancement (`poll-live-bdl.mjs`)

### 9a. Pass `live_tracking` to `fireCalibrationAnalysis`

**Current signature** (line 3654):
```js
async function fireCalibrationAnalysis(sql, game, league, summary, ind, sust, leadComp,
  espnWP, odds, matchup, hA, aA, period, clock, trigger)
```

**New signature** — add `liveTracking` parameter:
```js
async function fireCalibrationAnalysis(sql, game, league, summary, ind, sust, leadComp,
  espnWP, odds, matchup, hA, aA, period, clock, trigger, liveTracking)
```

**Call site** (line 5835) — add `lt` as final argument:
```js
fireCalibrationAnalysis(sql, game, league, summary, ind, sust, leadComp,
  espnWP, odds, matchup, hA, aA, currentPeriod, clock, t.trigger, lt)
```

**Usage inside function:** Before the agent call (~line 3936), compute erosion/BWC state and
format into the agent's context so auto-analysis Sonnet sees the position health:

```js
let erosionContext = '';
if (liveTracking?.bwc_fired) {
  const ero = computeErosion(liveTracking, ind.score, hA, ind.controlTeam);
  const bState = computeBwcState(liveTracking, ind.controlTeam, margin);
  erosionContext = '\nBWC STATE: ' + (bState || 'none') + ' | Erosion: ' + ero.level
    + (ero.peakFloor ? ' (peak ' + ero.peakFloor.toFixed(2) + ', delta '
      + ero.peakDelta.toFixed(3) + ')' : '')
    + ' | Holds: ' + (liveTracking.ctrl_team_holds || 0);
}
```

This fixes the GSW@LAC failure mode — agent sees COLLAPSE and reframes naturally.

### 9b. POSITION_TYPES update (line 3907)

**Current:**
```js
const POSITION_TYPES = ['BUY', 'BUY WINDOW CLOSING', 'WINDOW BUY', 'RECOVERY PATH',
  'LEAD CRUMBLING', 'LEAD LOST', 'VARIANCE BREAKING'];
```

**New** (keep v1 types for historical lookback — prior alerts may have those types):
```js
const POSITION_TYPES = ['BUY', 'BUY WINDOW CLOSING', 'BWC_EDGE', 'VALUE', 'EXIT',
  'THESIS_ALIVE', 'POSITION_SAFE', 'POSITION_RECOVERING',
  'WINDOW BUY', 'RECOVERY PATH', 'LEAD CRUMBLING', 'LEAD LOST', 'VARIANCE BREAKING'];
```

---

## 10. Code to Remove

### 10a. Monitor agent (~350 lines in `poll-live-bdl.mjs`)

**Functions to delete:**
- `getMonitorData()` — line ~395 to ~625
- `runMonitorAgent()` — line ~626 to ~810
- `saveMonitorObservations()` — line ~810 to ~830

**Block to delete:**
- Monitor execution, lines 5899-5926 (section 6 in poll loop)

**References to remove in `gatherAgentContext()` (lines 308-391):**
- Lines 374-391: `monitorContext` fetch from `monitor_observations` table
- Line 391: `monitorContext` in return object → remove from return

**References to remove in `fireCalibrationAnalysis()` (lines 3654-4055):**
- Lines 3766-3782: `monitorContext` fetch from `monitor_observations`
- Line 3792: `monitorContext` in `formatSonnetPrompt` call → set to null or remove
- Line 3821: `monitorContext ? 'monitor' : null` in layer inventory → remove

**Reference to remove in `formatSonnetPrompt()` (line 3306+):**
- Lines 3630-3633: `if (monitorContext) { ... }` block → delete

**Cascading to other files:**

`analyze.js`:
- Line 491: `var monitorContext = body.monitorContext || null;` → delete
- Lines 810-828: monitor section construction + injection → delete

`bdl.html`:
- Lines 2938-2946: fetch from `get_monitor_observations` → delete
- Line 3031: `monitorContext: monitorContext,` in analyze POST body → delete

**What stays:**
- `monitor_observations` TABLE — do not drop. Historical data exists.
- `get_monitor_observations` endpoint in `db-api.js` — harmless, leave for now.

### 10b. v1 mechanical alert block (~360 lines, lines ~5041-5401)

**Delete entirely.** This includes:
- Lead degraded suppression logic (5024-5039)
- BUY FIRED detection (5055-5069)
- BWC FIRED detection (5070-5094)
- WINDOW BUY detection (5097-5136)
- All 6 CANDIDATE sub-type detections (5140-5199)
- Lead degraded suppression gate (5201-5205)
- Per-type in-memory dedup `game._alertHistory` (5207-5221)
- DB-level dedup 2-min window (5223-5234)
- Agent routing, ntfy formatting, DB write for v1 alerts (5236-5401)

**What survives (move above v2 block as shared computation):**
- Clock gate: `alertMinsLeft` computation (lines 5043-5048)
- Odds/edge: `ctrlML`, `ctrlEdge`, `spreadVal` (lines ~4980-5018)
- TP for BUY context: `tpForBuy` computation (lines 5019-5022)
- Indicator win/loss: `indWon`, `indLost` arrays (lines 5246-5256)

### 10c. v1 transition alerts block (~310 lines, lines ~5403-5714)

**Delete entirely.** This includes:
- TP/LS computation for transitions (5408-5414)
- Per-side prev_ column reads (5416-5425)
- RECOVERY PATH detection + agent routing (5451-5523)
- LEAD CRUMBLING detection + agent routing (5528-5593)
- LEAD LOST detection (5594-5620)
- VARIANCE BREAKING detection + agent routing (5622-5693)
- Per-side prev_ column writes (5696-5710)

**Cascading:** `computeThroughputServer` and `computeLeadSafetyServer` are still called for
snapshot persistence (line 4900-4904). Only the transition alert usage is removed. The functions
themselves stay.

---

## 11. ntfy Title/Body Format (v2)

### BWC Lifecycle alerts

| Type | Title Format |
|---|---|
| BWC initial fire | `WINDOW CLOSING: {team} ML {ml}` |
| BWC_EDGE | `EDGE: {bwcTeam} — {matchup}` |
| VALUE | `VALUE: {bwcTeam} ML {ml} — {matchup}` |
| EXIT | `EXIT: {bwcTeam} position — {matchup}` |
| THESIS_ALIVE | `THESIS ALIVE: {bwcTeam} ML {ml} — {matchup}` |
| POSITION_SAFE | `POSITION SAFE: {bwcTeam} — {matchup}` |
| POSITION_RECOVERING | `RECOVERING: {bwcTeam} — {matchup}` |

### BUY alerts

| Tier | Title Format |
|---|---|
| FIRED | `BUY {team} ML {ml}` |
| CANDIDATE | `BUY [CANDIDATE] {team} ML {ml}` |

**Body:** Always agent-written (plain English). Prefixed with score line.
Mechanical fallback body used only when agent fails.

---

## 12. `live_tracking` Write/Read Cycle

### Read (start of each game's processing)

```js
let lt = {};
try {
  const ltRows = await sql`SELECT live_tracking FROM games WHERE id = ${game.id}`;
  if (ltRows[0]?.live_tracking) {
    lt = typeof ltRows[0].live_tracking === 'string'
      ? JSON.parse(ltRows[0].live_tracking) : ltRows[0].live_tracking;
  }
} catch(e) { /* non-fatal — initialize fresh */ }
```

### Write (end of each game's processing, after all alert checks)

```js
try {
  await sql`UPDATE games SET live_tracking = ${JSON.stringify(lt)} WHERE id = ${game.id}`;
} catch(e) { log(matchup + ': live_tracking write failed: ' + e.message); }
```

### Fields that persist across cold starts

| Field | Purpose |
|---|---|
| `bwc_fired` | Who, when, at what floor |
| `_prev_bwc_state` | For transition detection |
| `ctrl_team_current` | Current control team |
| `ctrl_team_holds` | Consecutive holds count |
| `home_peak_floor` / `away_peak_floor` | Peak tracking for erosion |
| `_bwc_candidate` / `_bwc_candidate_holds` | Pre-fire tracking |
| `_last_any_bwc_ts` | Universal cooldown timestamp |
| `_last_buy_ts` | BUY cooldown timestamp |
| `_last_fired_state` / `_last_fired_floor` / `_last_fired_margin` / `_last_fired_ts` | Material change gate |

---

## 13. Build Order

| Step | What | Lines Δ | Risk | Verification |
|---|---|---|---|---|
| 1 | DB columns (`db-api.js` Section 4) | +15 | LOW | `?action=init`, no errors |
| 2 | `raw_stats_json` in calibration INSERT (Section 5, Fix 1) | +1 | LOW | Next quarter boundary saves with raw data |
| 3 | v2 mechanical functions (Section 6) as new standalone functions | +80 | LOW | `node -c` syntax check |
| 4 | `live_tracking` read/write cycle + `updateLiveTracking` calls (Section 12) | +30 | LOW | Check DB for `live_tracking` JSONB after 1 poll |
| 5 | v2 trigger detection + context assembly AFTER v1 block, flag-gated: logs but no ntfy/agent (Section 7) | +200 | MEDIUM | Logs show triggers at correct moments |
| 6 | Rewrite `runAlertAgent` prompt (Section 8) | ±100 | MEDIUM | v1 alerts use new prompt — verify decisions |
| 7 | Enable v2 agent+ntfy, delete v1 mechanical+transition blocks (Sections 10b, 10c) | -670 | HIGH | Full slate monitoring |
| 8 | Delete monitor agent code (Section 10a) | -350 | MEDIUM | No live dependency |
| 9 | Clean up analyze.js + bdl.html monitor refs (Section 10a cascading) | -35 | LOW | Client analysis still works |

**Steps 1-4:** One commit. No behavioral change — new code isn't called by alert paths yet.
**Step 5:** Separate commit. v2 logging alongside v1. Zero subscriber impact.
**Step 6:** With Step 5 or separate. New prompt applies to v1 alert routing too.
**Step 7:** The cutover. One commit: remove v1 blocks, enable v2 sends. **No overlap window.**
**Steps 8-9:** Cleanup after Step 7 validated on a live slate.

---

## 14. Testing Strategy

### Pre-deploy (today's blowout)

1. Deploy Steps 1-5 during current game
2. Watch server logs for v2 trigger output — BWC state machine, erosion, triggers
3. No subscriber impact (v2 logging only, v1 still active and sending)

### First live game

1. Deploy Step 6 (new agent prompt) before tip
2. v1 block still fires — v2 logs alongside for comparison
3. Compare v1 decisions vs v2 trigger points in server logs
4. If v2 triggers match expectations → deploy Step 7 (cutover) before next game

### Validation criteria for Step 7 cutover

- BWC fires for correct team (structurally dominant, leading, 3+ holds)
- State transitions match game flow (lead compressed → EDGE, lost → VALUE, ctrl lost → EXIT)
- Erosion fires CAUTION/COLLAPSE at correct thresholds
- BUY triggers fire for trailing teams with warm/cold distinction
- Agent SEND/SUPPRESS decisions are reasonable
- No double ntfy (v1 removed before v2 enabled — single commit guarantees this)

### Post-cutover

- Post-game agent scores v2 types automatically (dynamic grouping)
- Manual review of first 3-5 games
- Monitor no-BWC games (POR@DEN archetype) for BUY noise

---

## 15. Deferred Items (NOT in this spec)

- COLD → STALLED sustainability tier rename
- Empirical calibration of 20%/35% erosion multipliers from live data
- BWC lifecycle timeline visualization on dashboard
- WNBA/NCAAMB port of v2 alerts
- `buy_tier`/`buy_reason` columns on alerts — superseded by `bwc_state`/`erosion_level`
- POR@DEN BUY noise (13 triggers in no-BWC game) — accepted, monitor in production
- Dashboard alert type filter updates for v2 types (deferrable — new types show in "all" view)

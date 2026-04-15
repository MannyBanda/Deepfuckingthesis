# Mechanical Dedup Tightening — Architecture Spec

**Date:** April 15, 2026
**Status:** PROPOSED — awaiting review

---

## PROBLEM STATEMENT

Tonight's POR@PHX produced 39 raw alerts for 2 games. The agent handled dedup well (12 flagged as dedup, all correct), but each dedup costs a Sonnet API call. At Q4 11:41, 4 alerts fired at the same timestamp (BUY, RP, BUY again, RP again) — the agent correctly identified 3 as duplicates, but that's 3 unnecessary Sonnet calls.

**Root cause:** The mechanical dedup layer uses in-memory state that SHOULD persist cross-poll via `schedule_json` cache, but has gaps:
1. If the poll function hits the 120s timeout, `cachedGames` never saves → next poll has no dedup memory
2. BUY (main block) and RP (transition block) fire independently in the same poll cycle — no cross-type awareness
3. Multiple polls can hit the same BDL clock timestamp (BDL updates every ~30s, our polls are every 60s)

**Goal:** Reduce unnecessary Sonnet calls by catching duplicates mechanically BEFORE they reach the agent.

---

## CURRENT DEDUP ARCHITECTURE

### Main Alerts (BUY / BWC / WB / CANDIDATES)
- **Location:** Lines 5056-5073
- **Mechanism:** `game._alertHistory[alertType]` — object with `{ts, floor, period, edge}`
- **Re-fire rule:** `minsSinceLast >= 5 || floorDelta >= 0.10 || edgeDelta >= 20`
- **Persists via:** `schedule_json` on `poll_state` (JSON roundtrip safe — verified)
- **Scope:** Per alert type name (e.g., key "BUY" covers FIRED and CANDIDATE BUY)

### Transition Alerts
| Alert | Dedup var | Key format | Rule |
|-------|-----------|------------|------|
| RECOVERY PATH | `game._lastTpAlert` (line 5306) | `${gameId}_TP_RECOVERY_Q${period}` | Once per quarter |
| LEAD CRUMBLING | `game._lastLsAlert` (line 5367) | `${gameId}_LS_CRUMBLE_Q${period}` | Once per quarter |
| LEAD LOST | `game._lastLsLostAlert` (line 5432) | `${gameId}_LS_LOST_Q${period}` | Once per quarter |
| VARIANCE BREAKING | `game._lastSustAlert` (line 5461) | `${gameId}_SUST_BREAK_Q${period}` | Once per quarter |

### Auto-Analysis
- **No mechanical dedup.** Position gate filters (only fires as position update if prior actionable SENT exists). Agent handles noise.

---

## CHANGE 1: DB-BACKED DEDUP

### Design

Replace all in-memory dedup with a single DB query at the top of the alert evaluation block. Query recent alerts for this game, then use the result set for all dedup checks.

### Query (one per game per poll cycle)

```sql
SELECT alert_type, alert_tier, period, clock, floor_score, edge, ts, agent_decision
FROM alerts
WHERE game_id = $1 AND league = $2
ORDER BY ts DESC LIMIT 20
```

Store result as `recentAlerts` (local variable, not on game object). This query runs once per game, serves all dedup checks for main + transition alerts.

**Cost:** 1 additional DB query per live game per poll cycle. For a typical 5-game slate, that's 5 queries/minute — negligible vs the 5+ queries we already run per game (snapshots, games, quarter data, season cache, monitor observations).

### Main Alert Dedup (replaces `_alertHistory`)

```javascript
// Find most recent alert of this type for this game
const lastOfType = recentAlerts.find(a => a.alert_type === alertType);
const minsSinceLast = lastOfType ? (Date.now() - new Date(lastOfType.ts).getTime()) / 60000 : Infinity;
const floorDelta = lastOfType ? ind.score - Number(lastOfType.floor_score) : Infinity;
const edgeDelta = (lastOfType && lastOfType.edge != null && ctrlEdge != null)
  ? ctrlEdge - Number(lastOfType.edge) : Infinity;
const dedupPass = minsSinceLast >= 5 || floorDelta >= 0.10 || edgeDelta >= 20;
```

**Key difference from current:** `lastOfType.ts` is a DB timestamp (reliable), not `Date.now()` from a prior poll's JS runtime (fragile if `schedule_json` didn't save).

### Transition Alert Dedup (replaces `_lastTpAlert`, `_lastLsAlert`, etc.)

```javascript
// Check if this transition type already fired this quarter
const alreadyFiredThisQ = recentAlerts.some(a =>
  a.alert_type === 'RECOVERY PATH' && a.period === currentPeriod
);
if (alreadyFiredThisQ) { /* skip */ }
```

Same pattern for LC, LL, VB. Simpler than the current string-key approach and inherently persistent.

### Where to Place the Query

**Location:** Inside the alert evaluation block (line ~4830), BEFORE the main alert if/else chain. After `ctrlEdge` is computed (line ~4854) since we need edge for the re-fire check.

```
Line 4827: log(matchup status line)
Line 4829: { // LIGHTWEIGHT ENTRY SIGNAL CHECK block opens
Line 4843: ctrlEdge computed
            ← INSERT recentAlerts query HERE
Line 4890: let alertType = null ...
```

### Failure Mode

If the DB query fails (connection issue, timeout), `recentAlerts` defaults to `[]`, meaning all dedup checks pass — equivalent to "first fire." The agent remains the safety net, same as today. No new failure mode introduced.

---

## CHANGE 2: WITHIN-POLL BATCH DEDUP

### Problem

In a single poll cycle, the main alert block and transition alert block fire independently. When POR is trailing by 1 with floor 0.95 and TP STRONG:
- Main block fires BUY (floor ≥ 0.65, trailing, FIRED)
- Transition block fires RECOVERY PATH (floor ≥ 0.30, trailing, TP STRONG)

Both reach the agent separately. The agent correctly identifies RP as redundant, but that's a wasted Sonnet call.

### Design

**Principle:** If the main alert block fires an actionable entry alert (BUY/BWC/WB), suppress same-side transition alerts (RP/VB) that would be redundant. LC/LL are cash-out warnings for existing positions — never suppress.

**Implementation:** After the main alert agent call completes and writes to DB, set a flag that the transition block reads.

```javascript
// After main alert INSERT (line ~5235):
const mainAlertFired = alertType !== null; // true if main alert passed all gates + dedup
const mainAlertType = alertType;           // 'BUY', 'BWC', 'WINDOW BUY', etc.
const mainAlertSent = shouldSend;          // agent said SEND

// In transition block, before RECOVERY PATH (line ~5288):
if (mainAlertFired && mainAlertType === 'BUY' && mainAlertSent) {
  log(`${matchup}: RECOVERY PATH superseded — BUY already sent this cycle`);
  // Skip RP entirely — no agent call, no DB write
}
```

### Supersession Rules

| Main alert fired | Transition alert | Action |
|-----------------|-----------------|--------|
| BUY FIRED/SENT | RECOVERY PATH | **Suppress RP** — BUY is the entry signal, RP is just the thesis |
| BUY FIRED/SUPPRESS | RECOVERY PATH | **Keep RP** — agent suppressed BUY, RP may have different reasoning |
| BUY CANDIDATE | RECOVERY PATH | **Keep RP** — agent might send RP but suppress candidate |
| BWC FIRED | VARIANCE BREAKING | N/A — BWC = leading, VB = trailing (different sides, can't co-fire) |
| WINDOW BUY | RECOVERY PATH | **Suppress RP** — WB is the entry signal |
| Any | LEAD CRUMBLING | **Always keep** — cash-out warning, different purpose |
| Any | LEAD LOST | **Always keep** — cash-out warning, different purpose |

**Simplified rule:** Suppress RP and VB only when `mainAlertSent === true` AND `mainAlertType` is BUY or WINDOW BUY (trailing-side entry signals). All other combinations: keep both.

### Why Not Suppress CANDIDATE + RP?

If the main block generated a CANDIDATE BUY (which the agent might suppress), and the transition block generates an RP (which the agent might send), suppressing RP would lose a potentially useful signal. Only suppress when the main alert was definitively SENT.

### Transition-to-Transition Dedup

Within the transition block, can multiple transitions co-fire?
- **RP + VB:** Both require trailing. Could co-fire if TP is strong AND opponent sust just flipped. But VB requires a sustainability TRANSITION (was stable, now breaking) while RP just requires TP STRONG. If both fire, VB is higher-signal (opponent variance collapsing). **Suppress RP when VB fires.**
- **LC + LL:** LC requires leading 5+, LL requires lead gone. Can't co-fire (mutually exclusive margin conditions).
- **RP + LC/LL:** RP requires trailing, LC/LL require leading. Can't co-fire (same control team can't be both).
- **VB + LC/LL:** Same — VB requires trailing, LC requires leading.

So the only within-transition co-fire is RP + VB. Priority: VB > RP.

---

## IMPLEMENTATION PLAN

### Step 1: Add `recentAlerts` query

**File:** `poll-live-bdl.mjs`
**Location:** Line ~4845, after `ctrlEdge` computed, before main alert chain

```javascript
// ── DB-BACKED DEDUP: fetch recent alerts for this game ──
let recentAlerts = [];
try {
  recentAlerts = await sql`
    SELECT alert_type, alert_tier, period, clock, floor_score, edge, ts, agent_decision
    FROM alerts WHERE game_id = ${game.id} AND league = ${league}
    ORDER BY ts DESC LIMIT 20`;
} catch (e) { /* non-fatal — empty array means all dedup checks pass */ }
```

**Lines added:** 6
**Risk:** None — query failure defaults to empty array (no dedup = current behavior).

### Step 2: Replace `_alertHistory` dedup with DB lookup

**File:** `poll-live-bdl.mjs`
**Location:** Lines 5056-5073

**Before (current):**
```javascript
if (!game._alertHistory) game._alertHistory = {};
const dedupKey = alertType;
const lastFired = game._alertHistory[dedupKey];
const minsSinceLast = lastFired ? (Date.now() - lastFired.ts) / 60000 : Infinity;
const floorDelta = lastFired ? ind.score - lastFired.floor : Infinity;
const edgeDelta = (lastFired && lastFired.edge != null && ctrlEdge != null) ? ctrlEdge - lastFired.edge : Infinity;
const dedupPass = minsSinceLast >= 5 || floorDelta >= 0.10 || edgeDelta >= 20;
...
game._alertHistory[alertType] = { ts: Date.now(), floor: ind.score, period: currentPeriod, edge: ctrlEdge };
```

**After:**
```javascript
const lastOfType = recentAlerts.find(a => a.alert_type === alertType);
const minsSinceLast = lastOfType ? (Date.now() - new Date(lastOfType.ts).getTime()) / 60000 : Infinity;
const floorDelta = lastOfType ? ind.score - Number(lastOfType.floor_score) : Infinity;
const edgeDelta = (lastOfType && lastOfType.edge != null && ctrlEdge != null) ? ctrlEdge - Number(lastOfType.edge) : Infinity;
const dedupPass = minsSinceLast >= 5 || floorDelta >= 0.10 || edgeDelta >= 20;
```

**Lines changed:** 8 → 5 (net -3)
**Lines removed:** `_alertHistory` init, `_alertHistory` read, `_alertHistory` write (3 lines dead)

### Step 3: Replace transition dedup vars with DB lookup

**RECOVERY PATH** (lines 5306-5307):
```javascript
// Before:
if (!game._lastTpAlert || game._lastTpAlert !== tpAlertKey) {
  game._lastTpAlert = tpAlertKey;

// After:
const rpAlreadyFired = recentAlerts.some(a => a.alert_type === 'RECOVERY PATH' && a.period === currentPeriod);
if (!rpAlreadyFired) {
```

**LEAD CRUMBLING** (lines 5367-5368): Same pattern, check `a.alert_type === 'LEAD CRUMBLING'`.

**LEAD LOST** (lines 5432-5433): Same pattern, check `a.alert_type === 'LEAD LOST'`.

**VARIANCE BREAKING** (lines 5461-5462): Same pattern, check `a.alert_type === 'VARIANCE BREAKING'`.

**Lines changed per transition:** 2 → 2 (no net change)
**Lines removed:** Each `_last*Alert` write line becomes dead (4 writes total)

### Step 4: Add within-poll batch dedup flags

**After main alert INSERT** (line ~5235):
```javascript
// Batch dedup flag for transition block
const mainEntryFired = alertType === 'BUY' || alertType === 'WINDOW BUY';
const mainEntrySent = mainEntryFired && shouldSend;
```

**In transition block, before RP** (line ~5288):
```javascript
// Skip RP if main block already SENT a BUY/WB this cycle
if (mainEntrySent) {
  log(`${matchup}: RECOVERY PATH superseded by ${alertType} SENT this cycle`);
} else if (oppPtsT > ctrlPtsT && marginT >= 1 && ...) {
  // existing RP logic
}
```

**In transition block, RP+VB co-fire** — if both RP and VB would fire, skip RP:
No code change needed — VB check (line ~5455) runs after RP. If VB fires AND RP already fired in the same poll, the agent sees VB as higher priority. But since we're adding DB dedup, the per-quarter check prevents double-firing anyway. VB and RP have different alert_types so they don't collide.

Actually, RP and VB CAN co-fire in the same quarter (both require trailing, different gates). If we want to suppress RP when VB fires, we need to evaluate VB first or set a flag. **For v1, skip this optimization** — let both fire, agent handles it. The DB dedup prevents cross-poll duplicates, which is the main win.

**Lines added:** ~6

### Step 5: Clean up dead code

| Dead code | Location | Lines removed |
|-----------|----------|---------------|
| `if (!game._alertHistory) game._alertHistory = {};` | Line 5058 | 1 |
| `const lastFired = game._alertHistory[dedupKey];` | Line 5060 | 1 |
| `game._alertHistory[alertType] = { ts: ... };` | Line 5073 | 1 |
| `game._lastTpAlert = tpAlertKey;` | Line 5307 | 1 |
| `game._lastLsAlert = lsAlertKey;` | Line 5368 | 1 |
| `game._lastLsLostAlert = lostKey;` | Line 5433 | 1 |
| `game._lastSustAlert = sustAlertKey;` | Line 5462 | 1 |
| `const dedupKey = alertType;` | Line 5059 | 1 |
| `const tpAlertKey = ...` | Line 5305 | 1 |
| `const lsAlertKey = ...` | Line 5366 | 1 |
| `const lostKey = ...` | Line 5431 | 1 |
| `const sustAlertKey = ...` | Line 5460 | 1 |

**Total dead lines:** 12

**NOT dead:**
- `cacheUpdated = true;` at line 5074 — other callers still set this. But the alertHistory write was the trigger. Since we're removing the write, remove this `cacheUpdated = true` only if no other meaningful state changed in this block. **Check:** `cacheUpdated` is also set at lines 4518, 4637, 5609. The one at 5074 only fires when a main alert passes dedup. With DB-backed dedup, the alert still fires and writes to the DB — the `cacheUpdated` flag is for saving `schedule_json`. Since we no longer store dedup state on the game object, we still want to save status changes. **Keep `cacheUpdated = true` at this location** — other game state (like `status` changes from BDL) needs to be saved.

---

## CASCADING IMPLICATIONS

### 1. `schedule_json` no longer carries dedup state
**Impact:** The `_alertHistory` and `_last*Alert` properties on game objects in `schedule_json` become vestigial. They won't be written anymore, and won't be read.
**Mitigation:** None needed. Old properties in saved JSON are harmless — they'll exist as unused fields on restored game objects. No cleanup required.

### 2. `gatherAgentContext` queries overlap
**Impact:** `gatherAgentContext` already queries `alerts` table (top 5, different columns, formatted for prompt). Our new `recentAlerts` query (top 20, dedup columns) runs separately.
**Mitigation:** Accept the overlap. The queries serve different purposes (dedup check vs agent prompt context), need different projections, and run at different times in the code. Merging them would couple dedup logic to agent context formatting. Cost: 1 extra lightweight query per game — negligible.

### 3. Alert INSERT failure leaves no dedup trace
**Impact:** If `INSERT INTO alerts` fails (line ~5232), the alert won't appear in `recentAlerts` next poll → could re-fire.
**Mitigation:** This is the SAME failure mode as today (if `_alertHistory` write fails, same result). The agent remains the safety net. The `INSERT` has a catch block that logs but doesn't throw — consistent with current behavior.

### 4. DB clock vs JS clock
**Impact:** `minsSinceLast` now uses DB `ts` (server-assigned `NOW()`) vs `Date.now()` in JS. These should be very close (same Netlify function context), but could differ by up to a few seconds.
**Mitigation:** Negligible. The 5-minute threshold has plenty of margin for sub-second clock drift.

### 5. `recentAlerts` query sees alerts from CURRENT poll cycle
**Impact:** In the same poll cycle, if BUY fires and writes to DB at line 5232, does the transition block's `recentAlerts` (queried earlier) include it? **No** — `recentAlerts` was queried once at the top. The BUY INSERT happens mid-cycle. So the transition block won't see the just-fired BUY in `recentAlerts`.
**Mitigation:** This is exactly what Change 2 (batch dedup flags) solves. The `mainEntrySent` flag communicates within the same poll cycle. `recentAlerts` handles cross-poll dedup. They complement each other.

### 6. First poll after deployment
**Impact:** First poll after code deploys will have no `_alertHistory` on game objects (not loaded from schedule_json since new code doesn't read them). `recentAlerts` from DB will have all prior alerts.
**Mitigation:** This is BETTER than today. DB has the complete history. No cold-start problem.

### 7. Transition alert INSERT includes `alert_type` column
**Impact:** The DB dedup for transitions checks `a.alert_type === 'RECOVERY PATH' && a.period === currentPeriod`. This requires the INSERT to use the exact string 'RECOVERY PATH'. 
**Verification:** Checked all 4 INSERT statements — they use string literals: `${'RECOVERY PATH'}`, `${'LEAD CRUMBLING'}`, `${'LEAD LOST'}`, `${'VARIANCE BREAKING'}`. ✅ Consistent.

---

## NET IMPACT

| Metric | Before | After |
|--------|--------|-------|
| Sonnet calls (POR@PHX tonight) | 27 | ~14 (est. -48%) |
| Dedup reliability | Fragile (schedule_json race) | Robust (DB is source of truth) |
| Lines of code | +0 | Net -6 (12 dead removed, 6 new added) |
| DB queries per game per poll | ~6 | ~7 (+1 lightweight SELECT) |
| New failure modes | None | None (query failure = no dedup = agent catches it) |

---

## TESTING PLAN

1. **Syntax check:** `node -c poll-live-bdl.mjs`
2. **Deploy and monitor first live slate** — watch server logs for:
   - `recentAlerts` query success (no errors in log)
   - Dedup messages showing DB-backed reasoning: "deduped — 2.3min since last, floor delta +0.05, edge delta +3.2pp"
   - Batch dedup messages: "RECOVERY PATH superseded by BUY SENT this cycle"
3. **Verify no regression:** Alerts that SHOULD fire still fire (first-fire, re-fire on floor+0.10, re-fire on edge+20pp, re-fire on 5min)
4. **Edge case:** Verify transition per-quarter dedup works across halftime (Q2 RP should not block Q3 RP)
5. **Compare alert count** to tonight's baseline: expect ~40-50% fewer raw alerts reaching the agent, same number of SENT alerts

---

## OPEN QUESTIONS

1. **Should `recentAlerts` filter by `agent_decision`?** Currently we check all alerts regardless of whether agent SENT or SUPPRESSED. This means a suppressed BUY at Q3 5:00 would block a new BUY at Q3 6:00 (only 1 min elapsed). Is that correct? **Hypothesis: Yes** — the mechanical conditions haven't changed enough to justify re-evaluating. If floor/edge jumped meaningfully, the re-fire thresholds would pass.

2. **Should auto-analysis alerts be in `recentAlerts` scope?** Currently `AUTO_ANALYSIS` alerts are in the DB. The main dedup only checks `alertType === 'BUY'` etc., so AUTO_ANALYSIS rows won't collide. **No change needed.**

3. **RP+VB co-fire suppression:** Deferred to v2. The DB dedup prevents cross-poll duplicates. Within-poll RP+VB co-fire is rare and the agent handles it. Not worth the complexity for v1.

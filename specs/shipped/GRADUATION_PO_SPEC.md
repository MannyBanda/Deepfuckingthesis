# Graduation-Based POSITION OPEN — Implementation Spec

**Date:** April 19, 2026
**Status:** DRAFT — pending Manny review
**Depends on:** V2 BWC Alert Engine Steps 1-6 (deployed), Step 7 cutover
**Files affected:** `poll-live-bdl.mjs`, `bdl.html` (display only)

---

## 1. Problem Statement

POSITION OPEN currently fires at first BWC eligibility (3 consecutive holds, period ≥ 2, floor ≥ 0.60, margin ≥ 2). In close games, this is a **51.1% coin flip** (n=476). 95% of first fires are Tier C at Q1_6 — just "a team has a lead and some indicators."

The backtest data (`report_position_open&close=1`, `report_tier_journey&close=1`) proves that **graduation** — earning a higher rank through sustained structural dominance — is the actual signal. Mean floor alone was tested and rejected: in close games, MF≥0.80 is only 61.9% (n=147) with no threshold producing actionable accuracy.

---

## 2. Core Design: TRACKING → GRADUATION → POSITION OPEN

### TRACKING (internal, subscriber-invisible)
- BWC fires at existing thresholds (3 holds, period ≥ 2, floor ≥ 0.60, margin ≥ 2)
- State machine starts: LOCK/EDGE/VALUE/EXIT transitions computed every poll
- Rank (C/B/A) computed every poll
- **No alerts fire. Subscriber has no idea this game exists.**

### GRADUATION (rank upgrade detected)
- Rank crosses from C→B, C→A, or B→A
- Timing gates applied (B-Rank requires Q3_6+, A-Rank fires at any checkpoint)
- S-Rank determined (A-graduation + zero control flips = wire-to-wire)

### POSITION OPEN (first subscriber-facing alert)
- Fires at graduation if timing gates pass
- Includes rank (S/A/B) and full structural picture accumulated during tracking
- Sets `lt.po_fired` — all subsequent state transitions generate subscriber alerts
- Pre-graduation state transitions logged but suppressed

### Why this is better than firing at first BWC
1. **Accuracy:** B-Rank at Q3_6+ = 68.6% vs first-fire = 51.1% (close games)
2. **Optionality:** During TRACKING, we haven't committed to an anchor team. If the opponent graduates instead, we can anchor on them without issuing a confusing POSITION SHIFT.
3. **Silence is correct:** ~45% of close games never graduate. No POSITION OPEN is better than a wrong POSITION OPEN.

---

## 3. Rank Classification

### Function: `classifyRank`
```javascript
function classifyRank(convictionTier, ctrlMargin, consecutiveHolds, oppIndicatorCount) {
  if (convictionTier === 'DOMINANT' && ctrlMargin >= 8 
      && consecutiveHolds >= 4 && oppIndicatorCount <= 1) return 'A';
  if (oppIndicatorCount >= 2) return 'C';
  if ((convictionTier === 'DOMINANT' || convictionTier === 'STRONG') 
      && ctrlMargin >= 3 && consecutiveHolds >= 2) return 'B';
  return 'C';
}
```

Identical to backtest `classifyBWCTier`. Must stay in sync — any deviation means the live system diverges from validated numbers.

### Rank definitions (from backtest data)

| Rank | Criteria | Close Win% | Full Win% | Typical timing |
|------|----------|-----------|-----------|----------------|
| **S** | Wire-to-wire + A-graduation + 0 ctrl flips | 98.3% (n=58) | 99.7% (n=377) | Determined retroactively |
| **A** | DOMINANT + lead 8+ + holds 4+ + opp indicators ≤ 1 | 74.2% (n=155) | 93.4% (n=732) | Earliest Q2_END |
| **B** | DOMINANT/STRONG + lead 3+ + holds 2+ + opp indicators < 2 | 68.6% (n=318) | 88.0% (n=1,013) | Earliest Q1_END |
| **C** | First BWC fire, no graduation | 51.1% (n=476) | 64.2% (n=1,172) | Q1_6 |

### S-Rank determination
S-Rank is not a classification output — it's an upgrade applied when:
- Current rank = A
- `lt.ctrl_flips === 0` (BWC team held control at every poll since tracking started)

S-Rank cannot be determined at a single moment. It's a cumulative property tracked via the `ctrl_flips` counter.

---

## 4. POSITION OPEN Firing Rules

### A-Rank PO
- **Gate:** Rank classified as A
- **Timing:** Any point in the game (A-graduation is inherently slow — earliest cluster at Q2_END, median 17.75 min after first fire)
- **No additional gates required** — A-graduation criteria are already stringent

### B-Rank PO
- **Gate:** Rank classified as B
- **Timing:** Q3_6 or later only
  - `currentPeriod > 3` OR `(currentPeriod === 3 AND clockSeconds ≤ 360)`
- **Rationale:** First-to-B accuracy by checkpoint in close games:
  - Q1_END: 52.5% (coin flip)
  - Q2_6: 60.6%
  - Q2_END: 62.1%
  - **Q3_6: 66.7%** ← inflection point
  - Q3_END: 79.2%

### C-Rank
- **No PO fires.** C-Rank = TRACKING state only.
- The subscriber never learns about C-Rank games unless they graduate.

### Wire-to-wire upgrade
- If PO fires at A-Rank AND `ctrl_flips === 0` → rank displayed as S
- Does NOT change the firing logic, only the rank label on the alert

---

## 5. Opponent Graduation (Phase 1: Log Only)

### Why it matters
When both teams reach B in close games, the first-to-B wins only **21.4%** (n=28). The second team to graduate wins ~79%. The opponent graduation signal invalidates the original anchor.

### Phase 1 implementation (log only, no subscriber alerts)
During TRACKING (before PO fires), if the opponent takes control and accumulates BWC-eligible holds:
- Track `lt.opp_bwc_holds` — consecutive polls where opponent has control + margin ≥ 2 + floor ≥ 0.50
- When `opp_bwc_holds ≥ 3`, compute opponent's rank using `classifyRank`
- If opponent reaches B or A: **log but do not alert**

During TRACKING, if opponent graduates BEFORE the anchor team's PO fires:
- We have NOT committed to the anchor team yet
- The system can evaluate which team has the stronger graduation case
- **Decision logic (Phase 2):** fire PO for the team with the higher rank, or the most recent graduate if ranks are equal

After PO has fired (subscriber committed), if opponent also graduates:
- **Phase 2:** fire POSITION SHIFT alert (new alert type, not yet built)
- For now: log only — `⚠ OPPONENT GRADUATED — ${team} reached ${rank}-Rank`

### Why Phase 1 is log-only
We need production data to validate the opponent graduation signal before sending subscriber alerts. The 21.4% / 80.8% numbers come from the backtest; live validation is required before acting on it.

---

## 6. Code Changes — `poll-live-bdl.mjs`

### 6.1 New function: `classifyRank` (~line 1360)

**Location:** After `classifyTransition`, before `computeErosion`

```javascript
function classifyRank(convictionTier, ctrlMargin, consecutiveHolds, oppIndicatorCount) {
  if (convictionTier === 'DOMINANT' && ctrlMargin >= 8 
      && consecutiveHolds >= 4 && oppIndicatorCount <= 1) return 'A';
  if (oppIndicatorCount >= 2) return 'C';
  if ((convictionTier === 'DOMINANT' || convictionTier === 'STRONG') 
      && ctrlMargin >= 3 && consecutiveHolds >= 2) return 'B';
  return 'C';
}
```

**Cascading:** None. New function, no existing callers.

---

### 6.2 Add `ctrl_flips` counter to `updateLiveTracking` (~line 1333)

**Current:**
```javascript
} else {
  lt.ctrl_team_current = ctrlTeam;
  lt.ctrl_team_holds = 1;
}
```

**Change to:**
```javascript
} else {
  lt.ctrl_team_current = ctrlTeam;
  lt.ctrl_team_holds = 1;
  lt.ctrl_flips = (lt.ctrl_flips || 0) + 1;
}
```

**Cascading:** `updateLiveTracking` called every poll cycle (~line 4690). Adding a counter is safe — no existing code reads `ctrl_flips`. New graduation code reads it for S-Rank detection. Old games without the field default to `0` via `|| 0`.

---

### 6.3 Replace POSITION_OPEN fire block (lines 4928-4934)

**REMOVE:**
```javascript
// ── V2 INITIAL BWC FIRE (POSITION OPEN) ──
if (lt._just_established) {
  delete lt._just_established;
  if (alertMinsLeft >= 1.0) {
    await routeV2Alert('POSITION_OPEN', 'FIRED', null, false);
  }
}
```

**REPLACE WITH:**
```javascript
// ── V2 GRADUATION DETECTION (fires POSITION OPEN at rank upgrade) ──
if (lt.bwc_fired && !lt.po_fired) {
  // Initialize graduation tracking if needed
  if (!lt.graduation) lt.graduation = {};
  const bwcTeam = lt.bwc_fired.team;
  if (!lt.graduation[bwcTeam]) lt.graduation[bwcTeam] = { rank: 'C' };

  // Compute rank only when BWC team has control
  if (ind.controlTeam === bwcTeam) {
    const gradConviction = computeConviction(ind);
    const oppCount = _oppIndW.length; // already computed above
    const curRank = classifyRank(
      gradConviction.tier, _v2Margin, lt.ctrl_team_holds || 0, oppCount
    );
    lt.rank_current = curRank;

    const prevRank = lt.graduation[bwcTeam].rank || 'C';
    const RANK_ORDER = { C: 0, B: 1, A: 2 };

    // Graduation = rank improved from previous peak
    if (RANK_ORDER[curRank] > RANK_ORDER[prevRank]) {
      lt.graduation[bwcTeam] = {
        rank: curRank, period: currentPeriod, clock,
        floor: ind.score, margin: _v2Margin
      };
      log(`${matchup}: ▲ GRADUATION ${bwcTeam} ${prevRank}→${curRank} ` +
          `Q${currentPeriod} ${clock}`);
    }

    // Check if POSITION OPEN should fire
    const gRank = lt.graduation[bwcTeam].rank;
    let poShouldFire = false;

    // A-Rank: fires at any checkpoint
    if (gRank === 'A') poShouldFire = true;

    // B-Rank: requires Q3_6+ (period > 3, or period 3 with clock ≤ 6:00)
    if (gRank === 'B') {
      const cm = String(clock).match(/(\d+):(\d+)/);
      const clockSec = cm ? parseInt(cm[1]) * 60 + parseInt(cm[2]) : 720;
      const pastQ3_6 = currentPeriod > 3 || (currentPeriod === 3 && clockSec <= 360);
      if (pastQ3_6) poShouldFire = true;
    }

    if (poShouldFire && alertMinsLeft >= 1.0) {
      // S-Rank upgrade: A-graduation + zero control flips
      const isWireToWire = (lt.ctrl_flips || 0) === 0;
      const poRank = (gRank === 'A' && isWireToWire) ? 'S' : gRank;

      lt.po_fired = {
        team: bwcTeam, rank: poRank,
        period: currentPeriod, clock
      };
      await routeV2Alert('POSITION_OPEN', 'FIRED', null, false);
      log(`${matchup}: ★ POSITION OPEN — ${bwcTeam} ` +
          `${poRank}-Rank Q${currentPeriod} ${clock}`);
    }
  }

  // ── Opponent graduation tracking (log only, Phase 1) ──
  if (ind.controlTeam !== bwcTeam) {
    const oppTeam = ind.controlTeam;
    if (_v2Margin >= 2 && ind.score >= 0.50) {
      lt.opp_bwc_holds = (lt.opp_bwc_holds || 0) + 1;
      if (lt.opp_bwc_holds >= 3 && !lt.graduation[oppTeam]) {
        const oppConv = computeConviction(ind);
        const oppOppCount = _ctrlInd.length; // anchor's indicators (they're "opponent" now)
        const oppRank = classifyRank(
          oppConv.tier, _v2Margin, lt.opp_bwc_holds, oppOppCount
        );
        if (oppRank === 'B' || oppRank === 'A') {
          lt.graduation[oppTeam] = {
            rank: oppRank, period: currentPeriod, clock,
            floor: ind.score, margin: _v2Margin
          };
          log(`${matchup}: ⚠ OPP GRADUATION ${oppTeam} → ${oppRank}-Rank ` +
              `Q${currentPeriod} ${clock}`);
        }
      }
    } else {
      lt.opp_bwc_holds = 0; // reset when opponent not BWC-eligible
    }
  } else {
    lt.opp_bwc_holds = 0; // reset when anchor team has control
  }
}
```

### Cascading implications for 6.3

| Concern | Risk | Mitigation |
|---------|------|------------|
| `computeConviction(ind)` — is `ind` correct here? | LOW | `ind` is the current poll's indicator output, same object used everywhere in this block. Already validated. |
| `_oppIndW` scope — available here? | LOW | Computed at ~line 4776 in the same scope. Verified. |
| `_v2Margin` scope — available here? | LOW | Computed at ~line 4697 in the same scope. Verified. |
| `clock` format for Q3_6 check | MED | BDL returns clock as `"8:03"` or `"12:00"`. Regex `(\d+):(\d+)` handles both. Fallback to 720 (start of quarter) if parse fails = safe default (won't fire B-Rank PO). |
| Old games without `lt.graduation` | LOW | Lazy initialization with `if (!lt.graduation)`. All reads use `?.` optional chaining. |
| `lt.po_fired` on old games | LOW | Defaults to falsy (`undefined`). Graduation block runs, finds no graduation, does nothing. |
| First poll after deploy for mid-game | MED | Games already in progress will have `lt.bwc_fired` but no `lt.graduation`. The graduation block initializes tracking from scratch. Rank will compute from CURRENT state, not from historical accumulation. This means in-progress games may graduate immediately if current conditions meet criteria. **Acceptable:** this is a one-time transient for games live at deploy time. |

---

### 6.4 Gate pre-graduation alerts (line 4937)

**Current:**
```javascript
if (lt.bwc_fired && v2BwcState && lt._prev_bwc_state 
    && v2BwcState !== lt._prev_bwc_state) {
```

**Change to:**
```javascript
if (lt.bwc_fired && lt.po_fired && v2BwcState && lt._prev_bwc_state 
    && v2BwcState !== lt._prev_bwc_state) {
```

Single addition: `lt.po_fired &&`

**Cascading:**
- Pre-graduation state transitions (LOCK→EDGE, EDGE→VALUE, etc.) computed but not alerted. The state machine continues running — `lt._prev_bwc_state` still updates, erosion still tracks. Only the alert routing is gated.
- C-Rank games that never graduate: state transitions permanently silenced. **Correct behavior** — subscriber has no position, nothing to update.
- Risk: BUY alerts (line ~5005) are NOT gated by this. BUY is independent of BWC lifecycle. If a BUY fires for the same team before PO, the subscriber gets a BUY without prior context of the position. **Acceptable:** BUY has its own entry criteria and doesn't depend on PO having fired.

---

### 6.5 Remove `_just_established` flag

**Line 4710** (BWC fire site):
```javascript
lt._just_established = true;  // REMOVE this line
```

**Lines 4929-4930** (consumption site):
```javascript
// These lines are already removed as part of 6.3 replacement
```

**Cascading:** `_just_established` was only set at line 4710 and consumed at line 4929. No other references. Clean removal.

---

### 6.6 Agent prompt: add rank context

**In `v2Ctx` construction (~line 4826), add:**
```javascript
poRank: lt.po_fired?.rank || null,
graduationPeriod: lt.graduation?.[lt.bwc_fired?.team]?.period || null,
graduationFloor: lt.graduation?.[lt.bwc_fired?.team]?.floor || null,
ctrlFlips: lt.ctrl_flips || 0,
```

**In `buildV2AgentPrompt`, add rank framing for POSITION_OPEN alerts:**
```
if (ctx.alertType === 'POSITION_OPEN' && ctx.poRank) {
  // Add to prompt:
  "This is a ${ctx.poRank}-Rank POSITION OPEN.
   S-Rank (98%+): Wire-to-wire structural dominance. ALWAYS SEND.
   A-Rank (74-93%): Earned structural graduation. SEND unless extreme concern.
   B-Rank (67-80%): Qualified structural edge. Evaluate case carefully."
}
```

**Cascading:** Prompt-only change. Agent can still SUPPRESS — rank framing adjusts confidence expectations but doesn't override agent judgment.

---

### 6.7 ntfy title format

**In `routeV2Alert`, V2_TITLE_MAP + title construction (~line 4800):**

**Current:**
```javascript
ntfyTitle = `${V2_TITLE_MAP[v2Type] || v2Type}${tierTag} — ${bwcTeam || ind.controlTeam}${mlStr}`;
```

**Change to (for POSITION_OPEN only):**
```javascript
if (v2Type === 'POSITION_OPEN') {
  const rankStr = lt.po_fired?.rank ? ` (${lt.po_fired.rank})` : '';
  ntfyTitle = `POSITION OPEN${rankStr} — ${bwcTeam || ind.controlTeam}${mlStr}`;
} else {
  ntfyTitle = `${V2_TITLE_MAP[v2Type] || v2Type}${tierTag} — ${bwcTeam || ind.controlTeam}${mlStr}`;
}
```

**Example outputs:**
- `POSITION OPEN (S) — DEN ML +140`
- `POSITION OPEN (A) — OKC ML -180`
- `POSITION OPEN (B) — MEM ML +220`

---

## 7. What Does NOT Change

| Component | Status | Why |
|-----------|--------|-----|
| BWC fire thresholds (3 holds, period ≥ 2, floor ≥ 0.60, margin ≥ 2) | **No change** | Working correctly. BWC fire = tracking starts. |
| State machine functions (`computeBwcState`, `classifyTransition`, `computeErosion`, `computeExitSeverity`) | **No change** | State machine runs from BWC fire regardless of graduation. |
| `updateLiveTracking` (except adding `ctrl_flips` counter) | **No change** | Peak floor tracking, hold counting all stay. |
| State transition alert types (HOLDING, ENTRY VALUE, EXIT, SECOND CHANCE, STRENGTHENING, POSITION SAFE) | **No change** | These fire after PO, same as before. Only gated pre-graduation. |
| BUY alert path | **No change** | BUY is independent of BWC lifecycle. |
| Transition alerts (RECOVERY PATH, LEAD CRUMBLING, LEAD LOST, VARIANCE BREAKING) | **No change** | These operate outside the BWC state machine. |
| `routeV2Alert` function (except ntfy title tweak) | **No change** | Same agent routing, same DB INSERT, same ntfy path. |
| Auto-analysis / calibration snapshot system | **No change** | Fires at quarter transitions regardless of graduation. |
| Snapshot writes / DB schema | **No change** | `live_tracking` is JSONB — new fields added dynamically. |
| Client dashboard (`bdl.html`) | **No change required** | Dashboard reads snapshots/alerts as-is. Rank display is a future enhancement. |

---

## 8. DB Schema Impact

**No migrations required.** All new data stored in `live_tracking` JSONB column on `games` table (already exists). New fields:

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `lt.graduation` | `{ [teamAlias]: { rank, period, clock, floor, margin } }` | `{}` (lazy init) | Per-team graduation state |
| `lt.ctrl_flips` | `integer` | `0` | Total control flips since game start |
| `lt.po_fired` | `{ team, rank, period, clock }` | `null` | When/if PO fired |
| `lt.rank_current` | `string` | `null` | Current rank at last poll (logging) |
| `lt.opp_bwc_holds` | `integer` | `0` | Opponent consecutive BWC-eligible holds |

---

## 9. Dead Code to Remove

| Code | Location | Action |
|------|----------|--------|
| `lt._just_established = true` | Line 4710 (BWC fire site) | **REMOVE** |
| `if (lt._just_established) { ... }` block | Lines 4928-4934 | **REPLACED** by graduation detection |

Total: 2 lines removed, ~55 lines added (graduation detection + opponent tracking).

---

## 10. Backtest Validation Reference

### Data sources
- `report_tier_journey&close=1` — 476 close games, 6-min checkpoints
- `report_tier_journey` — 1,230 full-season games
- `report_position_open&close=1` — mean floor validation (rejected)
- `report_production_replay` — 34 games at 60s resolution
- `GRADUATION_FINDINGS.pdf` — synthesized analysis

### Key numbers (close games unless noted)

| Metric | Value | Source |
|--------|-------|--------|
| First BWC fire win rate | 51.1% (n=476) | Tier journey §1 |
| C→A graduation win rate | 81.5% (n=146) | Tier journey §2 |
| C→B graduation win rate | 71.0% (n=214) | Tier journey §2 |
| A-Rank first-to-graduate wins | 74.2% (n=155) | Tier journey §16 |
| B-Rank at Q3_6+ wins | 66.7% (n=54) | Tier journey §16 |
| B-Rank at Q3_END+ wins | 79.2% (n=24) | Tier journey §16 |
| Grad B + Q3_6+ (combined rule) | 68.6% (n=318) | Position open §5 |
| Wire-to-wire wins | 98.3% (n=58) | Tier journey §6 |
| Zero flips wins | 73.1% (n=130) | Tier journey §4 |
| One flip wins | 37.7% (n=154) | Tier journey §4 |
| Both teams graduated, first-to-B wins | 21.4% (n=28) | Tier journey §16 |
| Second-to-graduate wins | 80.8% (n=26) | Position open §6 |
| Winners who never graduated | 45.2% | Tier journey §18 |
| Mean floor ≥ 0.80 (sole gate, close) | 61.9% (n=147) | Position open §1 |
| Mean floor ≥ 0.75 + 0 flips + Q3_6+ (close) | 65.9% (n=123) | Position open §5 |

### Why mean floor was rejected
In close games, mean floor produces a compressed 55-68% band across all thresholds. Zero-flips gate is inverted in close games (teams WITH flips outperform at every threshold — flips indicate resilience, not instability). The graduation system's conviction + holds + lead + opponent indicators encodes a richer structural signal than a simple floor average.

---

## 11. Implementation Order

1. Add `classifyRank` function (standalone, no dependencies)
2. Add `ctrl_flips` counter to `updateLiveTracking`
3. Remove `lt._just_established = true` from BWC fire site
4. Replace POSITION_OPEN block with graduation detection
5. Gate state transition alerts on `lt.po_fired`
6. Update agent prompt with rank context
7. Update ntfy title format with rank
8. Add opponent graduation logging (Phase 1)
9. `node -c poll-live-bdl.mjs` — syntax check
10. Commit + push + Netlify deploy
11. Verify with live game (graduation logging visible in Netlify function logs)

---

## 12. Future Work (Not in This Build)

| Item | Priority | Depends on |
|------|----------|------------|
| POSITION SHIFT alert (opponent graduation, subscriber-facing) | Phase 2 | Production validation of opponent graduation logging |
| Dashboard rank display (S/A/B badge on game card) | Low | PO fires correctly in production |
| Rank in alerts table (new column) | Low | Can use existing `alert_tier` column |
| B-Rank at Q3_END+ accuracy comparison | Low | More production data |
| Pre-graduation anchor selection (fire PO for second team if they graduate first) | Phase 2 | Opponent graduation validated |

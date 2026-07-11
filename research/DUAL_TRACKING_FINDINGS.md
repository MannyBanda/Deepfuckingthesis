# Dual Tracking & Graduation Findings — Session Summary

**Date:** April 19, 2026
**Status:** Findings validated, spec needed for dual tracking + oppCount threshold change
**Next session:** Spec dual tracking architecture + deploy oppCount >= 3

---

## What We Shipped This Session

### 1. Graduation-Based POSITION OPEN (deployed, commit c8baff4)

Replaced the instant POSITION OPEN at first BWC fire (51.1% coin flip in close games) with a two-stage system:

- **TRACKING** fires at BWC establishment (3 consecutive holds, period ≥ 2, floor ≥ 0.60, margin ≥ 2). Routes through the Opus alert agent. Subscriber gets a heads-up: "we're watching this team." NOT a position recommendation.
- **POSITION OPEN** fires at graduation (rank upgrade C→B or C→A). B-Rank requires Q3_6+ timing gate. A-Rank fires at any checkpoint. S-Rank = A-graduation + zero control flips (wire-to-wire).

State transition alerts (HOLDING, EXIT, etc.) gated on `lt.po_fired` — silent pre-graduation.

### 2. I4 subA Biggest Lead Threshold (deployed, same commit)

Replaced flat ±4 threshold with two-tier rule across all 4 locations (2 server, 2 client):
- **Flip:** Need ≥2 gap between biggest leads (was >4)
- **Contested:** If opponent's biggest lead ≥ 75% of leader's → EVEN

This made I4 more responsive — validated in PHI@ORL where I4 flipped to PHI at Q3 5:12 when their lead separated, triggering the I3+I4 killer pair and STRONG conviction → B-Rank graduation → POSITION OPEN.

### 3. Opponent Graduation Logging (deployed, Phase 1 log-only)

Tracks opponent's BWC-eligible holds and rank classification. Logs but doesn't alert. Groundwork for dual tracking.

---

## Dual Tracking — The Concept

### Current model (deployed): Single anchor

First team to hit BWC owns the tracking slot (`!lt.bwc_fired` gate). Only one team can fire TRACKING. Opponent tracking is a sidecar that logs but can't fire alerts or graduate.

### Proposed model: Dual independent tracking

Both teams can earn TRACKING independently. Neither is "the position" until graduation. Each team accumulates holds, conviction, and rank separately. When one graduates, we evaluate both candidates — POSITION OPEN fires for the stronger graduation, or we suppress if both graduated (contested signal).

Key insight from Manny: "Could we keep both tracking positions alive and then use the PBP window to assess whether they graduate later? It could enable us to open a position based on who graduates first within the PBP window or assess each team at that point to identify which graduation looks stronger."

---

## Replay Results

### MIN@DEN Apr 18 — DEN won 116-105

**With oppCount >= 2 (current deployed):**
- MIN: TRACKING Q2 12:00. Never graduated (MODEST conviction, I1+I2+I4, no killer pair).
- DEN: TRACKING Q3 4:44. Never graduated — STRONG conviction (I3+I5 killer pair), margin 11, 22 holds, but MIN had I1+I2 (2 opp indicators) which forced C-rank.
- Result: Both tracked, neither graduated, no POSITION OPEN. **Correct silence but missed DEN winning by 11.**

**With oppCount >= 3 (tested in replay):**
- MIN: TRACKING Q2 12:00. Never graduated (same — MODEST, no killer pair).
- DEN: TRACKING Q3 4:44. **Graduated B-Rank instantly** — STRONG conviction, margin 11, holds 3, opp indicators = 2 (below new >= 3 threshold). POSITION OPEN fired Q3 4:44.
- Result: DEN got POSITION OPEN, won by 11. **Correct call.**

### PHI@ORL Apr 15 — PHI won 109-97

**With oppCount >= 3:**
- PHI: TRACKING Q2 12:00. Stuck at MODEST (I1+I3, no killer pair) for 50+ checkpoints. At Q3 5:12, I4 kicked in → I1+I3+I4 = STRONG (I3+I4 killer pair). Margin 11, opp indicators 0. **Graduated B-Rank, POSITION OPEN fired Q3 5:12.**
- ORL: Never reached TRACKING. Never had 3 consecutive holds with floor ≥ 0.60 and margin ≥ 2.
- Result: Clean single-team signal. PHI graduated, won by 12. **Correct call.**

---

## Key Findings

### 1. oppCount >= 3 is the right threshold (needs backtest validation)

With >= 2, two opponent indicators vetoes graduation even when the team has a killer pair and double-digit margin. DEN had STRONG conviction, margin 11, 22 consecutive holds — blocked because MIN held I1+I2. That's too conservative.

With >= 3, the veto requires genuine structural opposition (3+ indicators), while 2 opponent indicators are handled by the conviction tier requirements (STRONG/DOMINANT already imply the team has a killer pair that the opponent's indicators haven't disrupted).

**Action:** Change deployed `classifyRank` from `oppCount >= 2` to `oppCount >= 3`. Consider backtest validation first.

### 2. Conviction tier > indicator count for graduation

MIN had 3 indicators (I1+I2+I4) but MODEST conviction — no killer pair. DEN had 2 indicators (I3+I5) but STRONG conviction — killer pair. DEN won by 11. The graduation system correctly weighted quality (killer pairs) over quantity (raw count). This is by design — `classifyRank` requires DOMINANT or STRONG conviction for B-rank, and those tiers require killer pairs.

### 3. Dual TRACKING flags game contentiousness

MIN@DEN: both teams earned TRACKING → "game is contested" flag. This is the 21.4% first-to-B signal from the backtest. When both teams track, the subscriber should expect uncertainty. When only one team tracks (PHI@ORL), it's a cleaner signal.

### 4. Cumulative anchoring remains a known failure mode

MIN held I1+I2+I4 cumulatively through Q4 while trailing by 7-9. Those indicators were anchored from Q1-Q2 dominance that had evaporated. The rolling window would show DEN winning recent quarters. This is the existing backlog item — graduation doesn't fix anchoring, but it does prevent acting on anchored indicators (MIN never graduated because MODEST conviction can't reach B-rank).

---

## What Needs Speccing Next Session

### 1. Dual tracking architecture

Replace single BWC anchor (`!lt.bwc_fired`) with per-team tracking slots. Each team independently:
- Accumulates holds when they have control + floor ≥ 0.60 + margin ≥ 2
- Resets holds when they lose control or fail thresholds
- Fires TRACKING independently at 3 consecutive holds in period ≥ 2
- Tracks graduation rank independently

Key design decisions needed:
- **BWC state machine:** Currently anchored to `lt.bwc_fired.team`. Options: (a) run state machine for both teams in parallel, (b) only activate state machine after PO fires and anchor on the graduated team. Option (b) is simpler and consistent with how we gated state transitions on `lt.po_fired`.
- **POSITION OPEN comparative logic:** When a team graduates, check if the other team also graduated. If both graduated → suppress or downgrade (21.4% signal). If only one graduated → fire PO for them. If neither graduated → silence.
- **Rolling window as tiebreaker:** If both teams are at the same rank, the rolling window control team breaks the tie. The team winning recent quarters has more credible graduation.
- **Second TRACKING alert framing:** When a second team earns TRACKING after the first, the ntfy could flag contentiousness: "TRACKING — DEN Q3 4:44 (⚠ MIN also tracked Q2 12:00)"

### 2. oppCount >= 3 deployment

Either deploy directly (two-game validation is promising but thin) or run the backtest replay against all 9,861 snapshots with the new threshold first.

### 3. Console replay tool enhancement

The dual tracking replay script works well for game-by-game validation. Could be extended to run against all games in a date range and produce aggregate stats (how many games: both tracked, one tracked, neither; graduation accuracy at each threshold).

---

## Files Changed This Session

| File | Change |
|------|--------|
| `poll-live-bdl.mjs` | +136 lines: classifyRank, ctrl_flips, TRACKING alert, graduation detection, opponent graduation logging, state transition gate, agent prompt rules, v2Ctx rank fields, ntfy titles, I4 subA threshold |
| `bdl.html` | +3 lines: I4 subA threshold (2 locations) |
| `GRADUATION_PO_SPEC.md` | Already in repo (committed before this session) |

Commit: `c8baff4` — pushed to main, Netlify auto-deployed.

---

## Replay Script Location

Console scripts used this session (not committed to repo — paste in browser console):
- `dual-tracking-replay.js` — original with oppCount >= 2
- `dual-tracking-replay-v2.js` — oppCount >= 3, configurable game target
- `dual-tracking-phi-orl.js` — PHI@ORL Apr 15
- `dual-tracking-min-den.js` — MIN@DEN Apr 18 with oppCount >= 3

# ONLY_ONE_GRAD + BUY Graduation Enrichment — Implementation Spec

**Date:** April 19, 2026  
**Status:** Spec complete, awaiting approval  
**Validation:** 1,233 full / 477 close game backtest (`report_dual_tracking_sim`)  
**File touched:** `netlify/functions/poll-live-bdl.mjs` (sole file, ~5,362 lines)  
**Estimated diff:** ~40 lines changed/added across 5 surgical sites  
**Risk:** Low — all changes are additive or threshold tweaks, no structural refactoring  

---

## Validated Findings Driving This Spec

1. **`only_one_grad` is the top strategy** across all 16 combos (85.5% full / 64.3% close)
2. **oppCount >= 3** adds 27-31 POs at 67% with zero POs lost — pure upside
3. **Graduation context on BUY** is architecturally free — v2Ctx already has `poRank`, `graduationPeriod`, `graduationFloor`
4. **Post-signal trailing data** proves BUY is the value trigger (22-29% trailing rate), not PO
5. **Graduation is backward-looking** — teams that trail after graduating only come back 24% (full) / 29% (close)

---

## Change Group 1: oppCount >= 3

**What:** Loosen the C-rank veto from 2+ opponent indicators to 3+.  
**Why:** 2 opponent indicators blocks graduation even when the team has STRONG conviction (killer pair) and double-digit margin. With >= 3, the veto requires genuine structural opposition. Backtest: 27 new POs at 66.7%, zero lost.  
**Risk:** Near zero. Pure additive — no existing correct POs are affected.

### Site 1 — `classifyRank` function (line ~1372)

```
BEFORE: if (oppIndicatorCount >= 2) return 'C';
AFTER:  if (oppIndicatorCount >= 3) return 'C';
```

**One line. No cascading implications.** The function is called from:
- Line ~4982: primary team graduation detection ✓ (want the change)
- Line ~5035: opponent graduation tracking ✓ (want the change)

No client-side copy exists (`bdl.html` does not have `classifyRank`).

Backtest sync note: `backtest-nba-snapshots.mjs` has its own `classifyBWCTier` (line ~3710 in `reportTierJourney`). That function is used for backtest analysis only, not production. Update separately if/when backtest is re-run. **Do NOT block this deploy on backtest sync.**

---

## Change Group 2: Opponent Tracking Fixes

The opponent tracking block (lines ~5027-5051) already tracks holds, calls `classifyRank`, and stores graduation to `lt.graduation[oppTeam]`. It currently has 3 bugs that must be fixed before we rely on it for PO suppression.

### Site 2a — Floor threshold (line ~5030)

```
BEFORE: if (_v2Margin >= 2 && ind.score >= 0.50) {
AFTER:  if (_v2Margin >= 2 && ind.score >= 0.60 && currentPeriod >= 2) {
```

**Two fixes in one line:**
- Floor 0.50 → 0.60: matches BWC eligibility requirement for primary team (line ~4724)
- Add `currentPeriod >= 2`: matches primary team's period gate (line ~4724)

**Cascading implication:** Fewer opponent graduations will fire (higher bar). This is correct — we were crediting opponent BWC holds at a lower bar than the primary team, which inflated opponent graduation and would cause false suppressions.

### Site 2b — Allow rank upgrades (lines ~5032-5043)

Currently the opponent graduation block has `!lt.graduation[oppTeam]` which means once the opponent graduates to B, it never upgrades to A. The primary team DOES upgrade (lines ~4988-4994 compare `RANK_ORDER`).

```
BEFORE:
if (lt.opp_bwc_holds >= 3 && !lt.graduation[oppTeam]) {
    const oppConv = computeConviction(ind);
    const oppOppCount = _ctrlInd.length;
    const oppRank = classifyRank(
      oppConv.tier, _v2Margin, lt.opp_bwc_holds, oppOppCount
    );
    if (oppRank === 'B' || oppRank === 'A') {
      lt.graduation[oppTeam] = {
        rank: oppRank, period: currentPeriod, clock,
        floor: ind.score, margin: _v2Margin
      };
      log(`${matchup}: ⚠ OPP GRADUATION ${oppTeam} → ${oppRank}-Rank Q${currentPeriod} ${clock}`);
    }
}

AFTER:
if (lt.opp_bwc_holds >= 3) {
    const oppConv = computeConviction(ind);
    const oppOppCount = _ctrlInd.length;
    const oppRank = classifyRank(
      oppConv.tier, _v2Margin, lt.opp_bwc_holds, oppOppCount
    );
    if (oppRank === 'B' || oppRank === 'A') {
      const prevOppRank = lt.graduation?.[oppTeam]?.rank || null;
      const OPP_RANK_ORDER = { C: 0, B: 1, A: 2 };
      if (!prevOppRank || (OPP_RANK_ORDER[oppRank] || 0) > (OPP_RANK_ORDER[prevOppRank] || 0)) {
        lt.graduation[oppTeam] = {
          rank: oppRank, period: currentPeriod, clock,
          floor: ind.score, margin: _v2Margin
        };
        log(`${matchup}: ⚠ OPP GRADUATION ${oppTeam} ${prevOppRank || 'C'}→${oppRank}-Rank Q${currentPeriod} ${clock}`);
      }
    }
}
```

**Cascading implication:** Opponent rank can now upgrade B→A. This makes the suppression check more accurate — if the opponent reaches A-rank, we definitely should suppress. Previously the opponent would be stuck at B even if they earned A.

---

## Change Group 3: PO Suppression (`only_one_grad`)

**What:** When PO should fire for the primary team, check if the opponent has ALSO graduated. If yes, suppress PO.  
**Why:** Both-graduated games: first-to-graduate wins only 8% full / 21% close. Suppression is correct 92-79% of the time.

### Site 3 — PO fire decision (insert after line ~5017, before `lt.po_fired = {`)

Current code structure:
```javascript
if (poShouldFire && alertMinsLeft >= 1.0) {
  const isWireToWire = (lt.ctrl_flips || 0) === 0;
  const poRank = (gRank === 'A' && isWireToWire) ? 'S' : gRank;

  lt.po_fired = { ... };
  await routeV2Alert('POSITION_OPEN', 'FIRED', null, false);
  log(`★ POSITION OPEN — ...`);
}
```

Insert suppression check:
```javascript
if (poShouldFire && alertMinsLeft >= 1.0) {
  // only_one_grad: suppress PO if opponent has also graduated
  const oppTeamForPO = bwcTeam === hA ? aA : hA;
  const oppGradForPO = lt.graduation?.[oppTeamForPO];
  if (oppGradForPO && (oppGradForPO.rank === 'B' || oppGradForPO.rank === 'A')) {
    poShouldFire = false;
    log(`${matchup}: ✗ PO SUPPRESSED (both graduated) — ${bwcTeam} ${gRank} vs ${oppTeamForPO} ${oppGradForPO.rank}`);
  }
}

if (poShouldFire && alertMinsLeft >= 1.0) {
  const isWireToWire = (lt.ctrl_flips || 0) === 0;
  // ... existing PO fire code unchanged ...
}
```

**Key behavior:** When suppressed, `lt.po_fired` is NEVER set. This means:
- The `!lt.po_fired` gate on the graduation block keeps it running next iteration ✓
- The BWC team can still try to graduate again (B→A) on next iteration ✓
- The suppression check will re-evaluate each time — if opponent graduation was erroneous (data issue), it self-corrects ✓
- State transition alerts (gated on `lt.po_fired`) correctly stay silent — no HOLDING/EXIT alerts for a contested game ✓

**NOT changed:** The state transition gate at line ~5055 (`lt.bwc_fired && lt.po_fired && ...`) stays as-is. No state transitions fire when PO is suppressed. This is correct — state transitions tell subscribers about their position, and we haven't opened a position.

**NOT changed:** BUY alerts are completely independent of PO. BUY fires based on floor/margin/trailing, not on `lt.po_fired`. BUY continues to fire normally whether PO fired, was suppressed, or never triggered. ✓

---

## Change Group 4: BUY Graduation Context Enrichment

**What:** Enrich the graduation context in the agent prompt so the agent can use graduation rank as a confidence tier for BUY decisions.  
**Why:** Graduation rank is already in v2Ctx but presented as a static badge. The agent needs temporal context (delta from graduation) and explicit rules about how graduation affects BUY confidence.

### Site 4a — v2Ctx construction (lines ~4889-4894)

Add graduation delta field:

```
BEFORE:
// Graduation context
poRank: lt.po_fired?.rank || null,
graduationPeriod: lt.graduation?.[lt.bwc_fired?.team]?.period || null,
graduationFloor: lt.graduation?.[lt.bwc_fired?.team]?.floor || null,
ctrlFlips: lt.ctrl_flips || 0,

AFTER:
// Graduation context
poRank: lt.po_fired?.rank || null,
graduationPeriod: lt.graduation?.[lt.bwc_fired?.team]?.period || null,
graduationFloor: lt.graduation?.[lt.bwc_fired?.team]?.floor || null,
graduationRank: lt.graduation?.[lt.bwc_fired?.team]?.rank || null,
ctrlFlips: lt.ctrl_flips || 0,
```

Note: `poRank` contains the PO rank (including S-rank wire-to-wire upgrade). `graduationRank` is the raw graduation rank (A/B/C) from `lt.graduation`. When PO was suppressed, `poRank` is null but `graduationRank` still has the team's achieved rank. This distinction matters for BUY context — a suppressed PO means both teams graduated, so graduation rank is less reliable. The agent sees both fields and can reason about it.

### Site 4b — Graduation line in `buildV2AgentPrompt` (line ~239)

```
BEFORE:
${ctx.poRank ? 'Graduation: ' + ctx.poRank + '-Rank' + (ctx.graduationPeriod ? ' (graduated Q' + ctx.graduationPeriod + ')' : '') + ' | Control flips: ' + ctx.ctrlFlips : ctx.ctrlFlips != null ? 'Pre-graduation tracking | Control flips: ' + ctx.ctrlFlips : ''}

AFTER:
${ctx.poRank ? 'Graduation: ' + ctx.poRank + '-Rank (graduated Q' + (ctx.graduationPeriod || '?') + ', floor was ' + (ctx.graduationFloor != null ? Number(ctx.graduationFloor).toFixed(2) : '?') + ', now ' + ctx.floor + ') | Control flips: ' + ctx.ctrlFlips : ctx.graduationRank ? 'Graduation: ' + ctx.graduationRank + '-Rank (graduated Q' + (ctx.graduationPeriod || '?') + ', floor was ' + (ctx.graduationFloor != null ? Number(ctx.graduationFloor).toFixed(2) : '?') + ', now ' + ctx.floor + ') — PO SUPPRESSED (opponent also graduated) | Control flips: ' + ctx.ctrlFlips : ctx.ctrlFlips != null ? 'Pre-graduation tracking | Control flips: ' + ctx.ctrlFlips : ''}
```

This produces three possible outputs:
1. **PO fired:** `Graduation: A-Rank (graduated Q2, floor was 0.88, now 0.67) | Control flips: 0`
2. **PO suppressed:** `Graduation: A-Rank (graduated Q2, floor was 0.88, now 0.67) — PO SUPPRESSED (opponent also graduated) | Control flips: 1`
3. **Pre-graduation:** `Pre-graduation tracking | Control flips: 0`

The agent now sees the arc (floor at graduation vs current floor) and knows whether PO was suppressed.

### Site 4c — BUY rules in agent prompt (line ~256)

Replace the BUY rule with graduation confidence tiers:

```
BEFORE:
- BUY: structurally dominant team trailing. Standard evaluation — floor, indicators, TP, deficit depth (1-7 sweet spot; deeper deficits need stronger structural case). When bwcTeamMatch is noted, the team has BWC lifecycle context — reference the position arc. This is a "warm BUY" (thesis history). Without BWC context = "cold BUY" (unproven, higher bar for SEND).

AFTER:
- BUY: structurally dominant team trailing. Standard evaluation — floor, indicators, TP, deficit depth (1-4 sweet spot; 5-9 needs very strong structural case; 10+ near-automatic SUPPRESS). When BWC team matches BUY team, graduation rank provides confidence tiers:
  • A-Rank graduated BUY (trail 1-4): HIGHEST confidence warm BUY — team proved sustained dominance, trailing is likely variance. Default SEND unless erosion is COLLAPSE or structural stress is COLLAPSING/FLIPPED.
  • B-Rank graduated BUY (trail 1-4): MODERATE confidence — structural edge confirmed but not overwhelming. Evaluate indicators, TP, and floor delta from graduation carefully.
  • Tracked but not graduated (trail 1-4): System identified structural interest but edge never separated. Lower confidence. Require strong floor (0.70+) and favorable TP.
  • Cold BUY (no BWC context): Unproven. Higher bar for SEND — require 3+ indicators, STRONG/DOMINANT conviction, shallow deficit.
  CRITICAL: Graduation rank reflects PEAK structural state, not CURRENT state. If floor has dropped significantly from graduation floor (shown in Graduation line), the game may have shifted. CAUTION/COLLAPSE erosion with graduated rank does NOT increase confidence — the graduation was earned in a different game state. Weight the delta, not the badge.
  DEFICIT DEPTH: trail 1-4 = viable entry window. trail 5-9 = structural thesis may be wrong, SUPPRESS unless A-Rank + REINFORCING stress read. trail 10+ = SUPPRESS (graduated team down 10+ = structural read was incorrect).
```

**Cascading implication:** The agent now has explicit graduated BUY confidence tiers AND a deficit depth framework that aligns with the backtest (trail 1-4 = 43-52% vs trail 5+ = 9-24%). The warning about graduation being backward-looking prevents the agent from treating A-Rank as an override for bad current data.

---

## What Is NOT Changed

| Component | Why untouched |
|-----------|---------------|
| `lt.bwc_fired` gate | Single anchor for BWC establishment is fine. Dual tracking at BWC level showed no benefit. |
| TRACKING alert | Still fires for first team only. The backtest didn't validate a second TRACKING alert for the opponent. |
| BWC state transitions | Gate on `lt.po_fired` is correct — no state alerts for contested/suppressed games. |
| BUY mechanical gates | Floor >= 0.55, period >= 2, margin 1-15, ML gate — all unchanged. |
| BUY alert path | Fully independent of PO. BUY fires based on floor/trailing, routes through same agent. |
| `routeV2Alert` | No changes needed. v2Ctx construction feeds all alert types through the same path. |
| Alert INSERT | No new DB columns. `poRank`/graduation fields are context for the agent prompt, not persisted on the alert. |
| `bdl.html` | No client changes. classifyRank is server-only. |
| `db-api.js` | No schema changes. |
| `analyze.js` | No changes. |
| `post-game-agent.mjs` | No changes. |

---

## Dead Code Assessment

**No dead code is introduced by this change.**

The opponent tracking block at lines ~5027-5051 transitions from "Phase 1 log-only" to "functional" — its output (`lt.graduation[oppTeam]`) is now consumed by the PO suppression check. The comment `// ── Opponent graduation tracking (log only, Phase 1) ──` should be updated to `// ── Opponent graduation tracking (used by PO suppression) ──`.

**Pre-existing dead code NOT addressed by this spec** (separate cleanup session):
- Monitor agent dead code (~100+ lines, killed Apr 17, Steps 8-9 backlog)
- v1 alert code (~670 lines, Step 7 cutover backlog)
- These are tracked in `V2_TEST_HANDOFF.md` and should NOT be mixed into this change.

---

## Implementation Order

1. **classifyRank oppCount** (1 line) — zero risk, deploy and confirm
2. **Opponent tracking fixes** (2a + 2b, ~15 lines) — low risk, fixes existing bugs
3. **PO suppression** (Group 3, ~6 lines) — depends on Group 2 being correct
4. **Agent prompt enrichment** (4a + 4b + 4c, ~15 lines) — independent of Groups 1-3, can deploy in parallel

Groups 1-3 should be one commit (they're interdependent for correctness). Group 4 can be a separate commit.

---

## Testing Plan

### Pre-deploy (Claude verifies)
- `node -c netlify/functions/poll-live-bdl.mjs` — syntax check
- `grep -n "oppCount\|>= 2\|>= 3" netlify/functions/poll-live-bdl.mjs` — verify no stale >= 2 references
- `grep -n "0\.50\|0\.60" netlify/functions/poll-live-bdl.mjs` — verify opponent floor threshold updated

### Live validation (next slate)
- Check server logs for `✗ PO SUPPRESSED` messages — confirms suppression path works
- Check server logs for `⚠ OPP GRADUATION` — confirms opponent tracking fires with new thresholds
- If a BUY fires after TRACKING, verify the agent reasoning references graduation context
- Compare agent decision on a graduated BUY vs ungraduated BUY — confirm the prompt is differentiating

### Regression check
- TRACKING alerts should fire unchanged
- POSITION OPEN should fire for games where only one team graduates (majority of games)
- BUY alerts should fire with identical mechanical triggers (floor/margin/trailing gates unchanged)
- State transition alerts (HOLDING, EXIT, etc.) should be silent when PO is suppressed

---

## Future Considerations (NOT in this spec)

1. **Deficit depth mechanical gate:** Auto-downgrade BUY to CANDIDATE when graduated team trails 5+. Data supports it (17% close) but it's an agent prompt optimization, not architecture.
2. **Suppression notification:** When PO is suppressed, optionally send a status update: "Both teams showed structural graduation — game contested, no position." Product decision.
3. **Graduation decay:** Consider decaying graduation rank over time (e.g., 4+ checkpoints after graduation without maintaining BWC state → downgrade). Addresses the backward-looking concern at the mechanical level.
4. **BUY deficit gate tightening:** Current margin 1-15 could tighten to 1-7 for graduated teams based on backtest (trail 10+ = 10% close win rate).

# DECISION_SUPPORT_V1_SPEC.md

**Status:** APPROVED (Manny, Aug 5) — with amended surge-tip copy template (below). Implementation per rollout order.
**Date:** Aug 5, 2026
**Research basis:** research/2026-08-03_winning_profiles_cut.md (§1 trailer temp — triple-source; §4 flip-worth; §6 loss paths; §10 era check / 2026 regime; §11 price-path exit study)
**Directive:** iterate, don't build. Every component rides an existing surface. No new tiers, no gates, no sizing/cap changes, no push-behavior changes. Goal = protect 14-1 accuracy by formalizing take / pass / cash-out reads.

---

## Component 1 — FUEL + TEMP read (dashboard + narration)

**What it shows (plain English, two lines):**
- LEAD FUEL: what the leader's lead is made of — `TRANSIENT (heat)` (red eFG band or 3PT-heavy), `TRANSIENT (takeaway)` (pot ≥6), both, or `EARNED` (normal temp, low takeaway feed)
- TRAILER TEMP: trailing team's eFG band (cold / warm / hot, period-relative)
- When the shape = EARNED lead + COLD trailer with TO <4 ("clean-cold"): append the regime-tagged caution chip **`STICKY LEAD SHAPE (2026)`** — this season's sub-breakeven cell. Context only; never suppresses, never gates.

**Placement:**
- **Dashboard (wnba-bdl.html):** inside the fade read block, directly ABOVE the scoring composition, on EVERY live game card — position or no position, fire or no fire. Manny uses it to pattern-read whole slates.
- **Narration (poll-live-bdl.mjs):** same two lines appended to A/B/WATCHLIST fire + D-12 review narration context.

**Definition contract (one definition, all consumers — per the elite-definition lesson):**
- `computeFuelTemp(leaderStats, trailerStats, period)` pure function. Inputs: fgm/fga/fg3m/ftm/pot/to from raw_stats_json (v2-corrected pot). Thresholds pinned in one constants block: eFG bands (existing period table), pot ≥6, 3PT-share ≥40, TO <4, var-share >45 where available.
- Duplicated verbatim client + server (Netlify bundling prevents shared require) with **mirrored golden fixtures on both sides** — the computeKillerFields pattern. Drift between copies = test failure.

**Explicit non-changes:** no new columns on critical polling-path SELECTs (client computes from snapshot data the card already fetches); no alert thresholds touched; caution chip renders nothing when data is insufficient (no fake reads — the schedule-badge lesson).

## Component 2 — REGIME PULSE + REGIME STATE (nightly digest)

**Pulse lines (post-game-agent.mjs digest, pinned copy fixtures):**
1. FUEL PULSE: within-band fuel-cut conversion, rolling 30d vs season — "Transient-fed: X/Y this month (season A/B). Earned: …"
2. SYSTEM PULSE: SS-wide realized vs predicted, rolling 30d (extends existing ledger summary framing to a monthly regime lens)

**REGIME STATE (its own named state, computed nightly, stored on the learnings/digest row):**
- `TRANSIENT_COLLAPSE: ACTIVE` — rolling-30d transient-fed conversion ≥60% at n≥8
- `NEUTRAL` — n<8 or between thresholds (silent default; no state claims on thin windows)
- `INVERTED` — ≤45% at n≥8 → digest flags loudly; STICKY chip copy auto-degrades to neutral wording
- Thresholds pre-registered here; changing them requires a spec amendment, not a code tweak.
- Surfaces: digest line always; dashboard regime chip is **v2, not in scope**.

## Component 3 — CASH surge watch (exit side; validated by research §11, Aug 5)

**Concept:** when a cold-at-fire position's comeback surges deep enough that the market declares it — and cash-out locks profit — prompt the cash. First-flip cashing is REFUTED (−$113 vs hold, §11.2); the profit-locked surge rule plateaus at +$2.7–3.2K vs +$1.3K hold in-sample across all thresholds −250…−1000.

**Trigger (constants pinned, probability-framed, book-agnostic):** open position + trailer was COLD at fire (computeFuelTemp) + de-vig two-sided win-prob ≥ 0.78 + estimated cash-out (payout × p × 0.93) ≥ stake. One-shot per position. Warm-at-fire positions: no trigger — ride (all-pos variant underperforms cold-only at every threshold).

**Surface & infra:** rides the SQUEEZE WATCH watcher (already polling armed positions' prices) + existing push surface. No new push stream, no flip/score detection needed (pure tape trigger — no Q4 blind spot).

**SHADOW MODE FIRST:** copy is a prompt, never an imperative. **Template (Manny-amended Aug 5):**

> "Cashout check: [TRAILER][ (elite)] now leads by [N]. Market has [TRAILER] ≈[P]%. Cash-out locks ≈$[X] of $[Y] payout; riding risks a loss because [plain-English fire-time reason — e.g. '[TRAILER] was cold at entry (44% eFG) and cold-start comebacks have given leads back']."

Template mechanics: [N] = current margin from the odds row / latest snapshot; [P] = de-vig prob rounded; elite tag from consumer `tiers_elite` only (one-consumer-definition contract); the because-clause is generated from the FIRE-TIME fuel/temp read. To make that readable at surge time without joins, Component 1's narration hook **stamps the computeFuelTemp result into the SS row's existing context JSONB at fire** (no new columns, no polling-path SELECT changes). Digest logs shadow-rule P&L vs hold on every new position. **Promotion to directive language: n≥15 forward positions with shadow ≥ hold** (pre-registered, §11). Calibration: Manny screenshots real bet365 Cash Out offers at tip-fire; digest tracks offer-vs-fair haircut.

## Component 4 — Pre-registered promotion bars

- STICKY warning graduates to explicit "sub-breakeven at market prices" language only at forward ≤50% conversion, n≥12 clean-cold in-band spots.
- Transient-cell sizing-CONFIDENCE language (within existing tier caps, NEVER tier elevation, NEVER cap changes) only at forward ≥70%, n≥15.
- CASH surge watch earns directive copy at n≥15 forward positions with shadow ≥ hold (§11 bar); haircut constant recalibrated from real offers at n≥8 logged.
- All three tracked in the ledger; graduation watchdog remains propose-only.

## Architecture & scope estimate

~300 lines total, all inline in existing files (consistent with house pattern): poll-live-bdl.mjs (~70: computeFuelTemp + narration hook), odds-squeeze.mjs (~40: surge-watch exit condition on the existing watcher), wnba-bdl.html (~70: mirrored fn + card render), post-game-agent.mjs (~90: pulse queries + copy + regime state + shadow-P&L line), fixtures (~60, three harnesses: fuel/temp goldens ×2 sides, digest copy pins, surge-tip copy pins). No schema changes required (regime state rides the existing learnings row JSON). No new module warranted at this size — flag for extraction if DS v2 grows it past ~500 lines.

## Test plan (ships with implementation, per testing ownership)

1. computeFuelTemp goldens: 8 pinned cases incl. row 23 (earned+clean-cold → STICKY), PHX@MIN (transient-heat), LA@DAL (transient-takeaway at var 20), insufficient-data → no render. Client and server fixture files must assert identical outputs.
2. Digest copy pins for both pulse lines + all three regime states.
3. Surge watch: trigger fires only on (cold-at-fire ∧ de-vig p≥0.78 ∧ cash≥stake), one-shot per position, warm never triggers; tape fixtures for trigger/no-trigger incl. the #545 near-miss (peak −400) and a deep-favorite entry (no t=0 artifact); tip copy pins.
4. Regression: verdict strip 41 cases + digest fixtures still green.

## Backlogged (logged Aug 5, not in scope)

- **A. Pool expansion:** transient-collapse WITHOUT the quality-gap filter — do underdog/non-elite trailers convert transient-fed leads too? (More juice outside current scope.)
- **B. Sticky-lead opportunity:** earned + clean-cold shape holds 64–75% across cuts — leader side is often plus-money while ahead. "What leads are sticky?" as a bettable question, leader-side. Ledger-first if pursued.

## Rollout order (on go-ahead)

1. Component 1 (fuel/temp read + STICKY chip) — highest loss-protection value per line
2. Component 2 (pulse + regime state) — the tripwire that keeps 1 honest
3. Component 3 (CASH surge watch, shadow mode) — tape verified + rule validated in-sample Aug 5
4. Bars (component 4) are governance, active from day one of logging

## Implementation anchors (pinned Aug 5 pre-implementation, from live session)

- **poll-live-bdl.mjs:** `EFG_BANDS` + `efgTier` at ~L5117 (reuse, don't redefine); SS narration writer at ~L948–994 (`player_ctx_json` UPDATE at ~948 is the stamp site for the fuel/temp JSONB; `narration_text` UPDATE at ~994; narration context builder note at ~L1145 lists consumers). `WNBA_SS_NARRATE_WATCHLIST` flag at ~L1011.
- **wnba-bdl.html:** scoring composition state at `cs.scoringComp` ~L4155, renderers consuming `sc` at ~L4232 / ~L4298 — fuel/temp block renders immediately above the ~L4232 render path. Client `computeFuelTemp` mirror + period-band constants colocated there.
- **odds-squeeze.mjs:** `bestPrice(event, alias)` ~L106; armed-watch sample pass ~L166–223 — surge-watch exit condition hooks inside that pass (per-watch, one-shot flag on the watch row/state).
- **post-game-agent.mjs:** digest copy fixture pattern + `ssOverrideLaneLine` as the model for FUEL/SYSTEM PULSE lines + regime state.
- Line numbers are anchors, not gospel — fresh session re-verifies with grep before editing (files drift).

---

## v1.1 ADDENDUM (APPROVED Manny, Aug 5 — post-C1/C2/C3 ship, pre-slate)

**Governance note:** amended at n=0 forward surge positions — pre-registration clock restarts today at zero cost. Locked after tonight.

### A. CASH surge trigger amendment
- Trigger: cold-at-fire + trailer **leads ≥1** + trailer best price **≤ −400** (`SURGE_PRICE = -400` replaces `SURGE_P` as the gate; §11 plateau −250…−1000 is flat, so this is bookkeeping not EV). De-vig p still computed + stamped every fire — calibration only.
- Profit-lock leg, dual path (% is the DEFAULT state; $ activates when a bet row exists at that sample — watcher re-checks every 30s, so mid-game logging upgrades the path automatically):
  - bet logged: payout × p × 0.93 ≥ stake; copy shows real $
  - no bet: p × 0.93 ≥ implied(fire price, `line_used`); copy shows %. Identical math when entered at fire price. `line_used` NULL → lock leg unevaluable → no fire (no fake reads).
- Stamp on fire (both paths): `surge_p`, `surge_lead`, `surge_frac` (= p × 0.93), plus `surge_est_cash`/`surge_stake` when $ path. Nightly digest computes shadow P&L as `surge_frac × settled payout − stake` from whatever bets exist by digest time — logging order is moot.
- One-shot, supersede guard, no-tape-on-oob unchanged.

### B. Closed-card AT FIRE render
- `get_ss_state` gains a FOURTH isolated query: earliest fuelTemp stamp for the game (+ its period/clock).
- Closed cards render `AT FIRE (Q2 9:42): EARNED · trailer cold [STICKY]` from the stamp; live cards keep the live compute; no stamp → nothing.

### C. Backfill
- `stamp_ss_fueltemp` db-api POST (JSONB merge, id-keyed, refuses rows already stamped).
- Sandbox script recomputes fuelTemp from fire-time snapshots for all historical SS rows via the repo-extracted computeFuelTemp (no reimplementation drift); leader vShare from the row's own `variance_share`; stamps tagged `src:'backfill'`. Seeds FUEL PULSE season baseline + regime denominator tonight. Distribution reported vs research §1/§10.

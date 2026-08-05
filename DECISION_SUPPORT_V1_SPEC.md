# DECISION_SUPPORT_V1_SPEC.md

**Status:** PROPOSED — awaiting Manny go-ahead. No code until then.
**Date:** Aug 5, 2026
**Research basis:** research/2026-08-03_winning_profiles_cut.md (§1 trailer temp — triple-source; §4 flip-worth; §6 loss paths; §10 era check / 2026 regime)
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

## Component 3 — CASH-shape tip (exit side)

**Trigger:** server poll detects the trailer of an OPEN-position game (bet-logged or Manny-flagged) taking the lead (margin sign flip, 1-poll confirm).
**Copy appended to the existing JUICE/narration push surface (no new push stream):**
- Trailer was COLD at fire → "Flip is live. [Trailer] was cold at entry — this shape historically gives the lead back. Check cash-out vs breakeven now."
- Trailer was WARM at fire → "Flip is live. [Trailer] was warm at entry — this shape tends to hold. Breakeven rule applies; hold is the default."
- **No percentages in copy** until price-path validation clears (rigor rule: thin slices carry no precision on decision surfaces).
**Prerequisite task:** odds-tape coverage assessment (odds_history + SQUEEZE-era depth for WNBA in-game). If historical tape is thin, forward SQUEEZE tape accumulates the validation sample.

## Component 4 — Pre-registered promotion bars

- STICKY warning graduates to explicit "sub-breakeven at market prices" language only at forward ≤50% conversion, n≥12 clean-cold in-band spots.
- Transient-cell sizing-CONFIDENCE language (within existing tier caps, NEVER tier elevation, NEVER cap changes) only at forward ≥70%, n≥15.
- CASH tip earns numeric copy only after price-path validation on ≥10 taped flips.
- All three tracked in the ledger; graduation watchdog remains propose-only.

## Architecture & scope estimate

~300 lines total, all inline in existing files (consistent with house pattern): poll-live-bdl.mjs (~90: pure fn + narration hook + flip detector), wnba-bdl.html (~70: mirrored fn + card render), post-game-agent.mjs (~90: pulse queries + copy + regime state), fixtures (~60, three harnesses: fuel/temp goldens ×2 sides, digest copy pins, flip-tip copy pins). No schema changes required (regime state rides the existing learnings row JSON). No new module warranted at this size — flag for extraction if DS v2 grows it past ~500 lines.

## Test plan (ships with implementation, per testing ownership)

1. computeFuelTemp goldens: 8 pinned cases incl. row 23 (earned+clean-cold → STICKY), PHX@MIN (transient-heat), LA@DAL (transient-takeaway at var 20), insufficient-data → no render. Client and server fixture files must assert identical outputs.
2. Digest copy pins for both pulse lines + all three regime states.
3. Flip-detector: sign-flip + 1-poll confirm + one-shot per position; tip copy pins cold/warm variants.
4. Regression: verdict strip 41 cases + digest fixtures still green.

## Backlogged (logged Aug 5, not in scope)

- **A. Pool expansion:** transient-collapse WITHOUT the quality-gap filter — do underdog/non-elite trailers convert transient-fed leads too? (More juice outside current scope.)
- **B. Sticky-lead opportunity:** earned + clean-cold shape holds 64–75% across cuts — leader side is often plus-money while ahead. "What leads are sticky?" as a bettable question, leader-side. Ledger-first if pursued.

## Rollout order (on go-ahead)

1. Component 1 (fuel/temp read + STICKY chip) — highest loss-protection value per line
2. Component 2 (pulse + regime state) — the tripwire that keeps 1 honest
3. Component 3 (cash tip) after tape-coverage assessment
4. Bars (component 4) are governance, active from day one of logging

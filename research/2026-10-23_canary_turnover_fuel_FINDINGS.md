# Canary × Turnover Fuel — PHASE 1 FINDINGS

**Date:** 2026-10-23 · **Instrument A:** fine NBA arena (`2026-10-23_fine_nba_canary_fires.json.gz`, 30s grain, production-shaped replay) · **Script:** `research/2026-10-23_canary_fuel_cuts.py`
**Prereg:** `2026-10-23_canary_turnover_fuel_PREREG.md` @ `d7eb6e2` · Amendments 1-2 in the Phase 0 docs · **Amendment 3 (PM, pre-data, chat):** primary stratum = all one-per-game CLEANs (n=653); `tracked_proxy` reported alongside; floor slices are the pre-declared secondary.
**Population:** production-style CLEAN, control team leading by ≥1 at trigger, one row per game, 2025-26 regular season. All rates are **trailer-WIN** (the control team lost). Power: HIGH ≥200 · MED 80-200 · LOW <80.
**Proxy:** fair-line P(leader holds | period × 2-min bucket × leader-margin bucket) from 88,583 fine states; edge = trailer-WIN − proxy P(trailer wins) at the push state.

---

## Verdicts

| | Verdict | T3−T1 win | T3−T1 edge | halves | n/tercile |
|---|---|---|---|---|---|
| **H1 — pre-fire fuel, F1 net POT (primary)** | **NOT PROMOTED** | −3.5pp | −0.4pp | −0.3 / −6.8 | 204-227 HIGH |
| H1 — F2 trailer TO rate (alongside) | NOT PROMOTED (direction reversed) | −7.1pp | −4.9pp | −4.6 / −9.5 | 217-218 HIGH |
| **H2 — clean-up, F3 (primary, bet-time)** | **NOT PROMOTED** | +4.9pp | +1.5pp | +3.9 / +5.9 | 217-218 HIGH; non-monotone |
| H2 — coarse 20-possession look (secondary) | null | +5.3pp | — | — | 57 LOW |

Both hypotheses fail the 8pp/8pp bar at HIGH power, and the signs are the wrong way. A lead built on the trailer's turnovers is **not** softer than a shooting-built lead, and a trailer that "cleans up" between trigger and push does **not** convert more.

**Mechanism (why).** F3 is almost pure mean reversion: a trailer with a high pre-fire TO rate regresses toward its norm no matter what, so the "cleaned up most" tercile is enriched for sloppy teams — and sloppy teams lose. The pre-fire TO burden (F2) runs the other way from the hypothesis for the same reason: it marks a worse team, not a lead with less floor under it. The motivating case (PHI 14 TOs → 2 TOs → win) was the regression, not a signal.

## The bigger finding: the canary's trailer-win number, measured at bet-time

| Instrument | CLEAN definition | push lands | trailer-WIN | n |
|---|---|---|---|---|
| May 2026 (coarse, post-hoc) | never recovered through end of game | ≥ 9 min after trigger | 77.6% (all) / 72.6% (ctrl-leading) | 277 / 197 |
| Coarse export, post-hoc | same | same | 71.6% | 204 |
| Coarse export, production-style | incremental `classifyMCPattern` | ≥ 9 min | 61.4% | 171 |
| **Fine arena, production-style** | incremental, 30s grain | **≈ 4 min** (production 4:11) | **42.1%** | **653 HIGH** |
| Production, real pushes | live | live | 36.8% | 19 LOW |

~10pp of the May number was hindsight (post-hoc classification), ~19pp was the sampling moment (the coarse grid classifies after the collapse has already happened, when the "trailer" is usually the new leader). At the moment the push actually lands, **the trailer wins 42% and the margin × time proxy says 41.9% — edge +0.2pp, both halves agree (42.6 / 41.6).** The canary as a trailer buy, unconditioned, is market-fair. It remains a valid *defense* signal (the lead erodes); it is not a side-picker by itself. Production's own 19 lived pushes (36.8%) sit with the fine number, not the May one.

**Prompt constants affected** (correction queued, not applied): "72.6% precision", the margin qualifier "≤3 = 81% · 4-8 = 72% · 9-15 = 63%", and the trust-hierarchy framing built on them. Production-grain, bet-time values: ctrl margin at trigger **1-3 = 50.5% (194) · 4-8 = 53.0% (253) · 9-15 = 24.5% (159) · 16+ = 8.5% (47 LOW)**; at the push: 1-3 = 46.2% · 4-8 = 44.6% · 9-15 = 33.3% · 16+ = 11.1% (LOW).

## Floor slices (pre-declared secondary; the PM's next cut)

| floor at trigger | n | trailer-WIN | edge vs proxy |
|---|---|---|---|
| > .75 (anchored) | 291 HIGH | 32.0% | −4.7pp |
| ≤ .75 (pre-declared complement) | 362 HIGH | 50.3% | +4.1pp |
| exploratory: .60-.75 | 275 HIGH | 50.9% | **+6.7pp** |
| exploratory: < .60 | 87 MED | 48.3% | −4.1pp |

This reproduces May's `cross_deep` ordering (MC collapse with floor still anchored → opponent rarely wins; floor dropping → coin-flip-plus) at production grain. The **.60-.75 band — the floor has started to soften but has not collapsed — is the only cell on the board with a positive, HIGH-power edge** (+6.7pp). It is exploratory (the prereg split was >.75 vs ≤.75), so it is a candidate for its own prereg, not a finding. The feature × floor interactions point the same way and flip sign across the floor classes (F3 within floor ≤.75: +11.5pp; within floor >.75: −8.9pp) — exploratory, same treatment.

## Descriptive (no bar)

- **F4 FTA edge at trigger:** trailer-WIN 47.3% when the *trailer* holds the FTA edge (T1, +6.4pp vs proxy) vs 39.4% when the leader does (T3, −2.5pp). T3−T1 = −7.9pp win / **−8.8pp edge**, monotone, halves −7.4 / −8.6. This is the strongest separation on the board and it is the one channel the prereg left descriptive. It gets its own prereg or nothing; it is not promoted here.
- **F5 trailer unforced-TO share:** null (−0.8pp, non-monotone).
- **Trigger period:** Q2 44.6% (+2.4pp) · Q3 38.1% (−2.6pp) · Q4 34.4% (−11.2pp, LOW).

## What changes

**Nothing ships.** No gate, no copy, no sizing. Three things are queued for PM decision:
1. **Prompt-constant correction** — the MC_COLLAPSE precision and margin-qualifier numbers in `poll-live-bdl.mjs` (line ~2043 and the trust-hierarchy block) and `MC_PRODUCTION_SPEC.md` are hindsight-and-coarse artifacts; the bet-time values above should replace them. Spec-first.
2. **Floor-softening prereg** (floor at trigger .60-.75 as the canary-buy conditioner; bar, halves, and a price-joined Instrument B leg) — the only positive-edge cell.
3. **FTA-edge prereg** — the descriptive channel that nearly cleared a bar it was never given.

## Provenance & caveats

- Instrument A reproduces 11/14 real production pushes on production's own snapshots (7 within a minute). Deviations disclosed in the Phase 0b doc: no position gate (`tracked_proxy` stratum: 40.4%, −0.5pp — same picture), no XGB-drop trigger, per-side terminal, 0.36 3PT baseline.
- Single season (2025-26); halves are chronological, not independent seasons.
- The proxy is margin × time, not a market. A live line knows team quality; edges vs the proxy are an **upper bound** on edge vs the market. The +600 question (CLE +13, floor 1.00 at trigger) sits in the two weakest cells here — floor > .75 and margin 9-15 — and is answerable only on Instrument B with ESPN WP / live lines.
- Resulting guard: the CLE@PHI win does not upgrade any cell; it was the motivating case and is logged as single-game variance.

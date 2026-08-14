# PREREG: Cross-League Sweet-Spot Portability Scan v1
**Date:** 2026-08-14 · **PM go:** Manny, in-chat Aug 14 (one-league tranche start) · **Backlog:** #11
**Status at commit:** no timeline data pulled for analysis. Feasibility probes disclosed below.

## Goal
Rank basketball leagues by structural fit for the quality-gap comeback engine. Fit scan only — no prices, no edge claims, nothing ships. Edge study on winners is a separate, later prereg with the Odds API.

## Hypothesis (pre-stated)
Engine fit scales with quality dispersion — domestic leagues with lopsided tables (Greek A1, Israeli Winner, ACB, Turkish BSL) may beat the deliberately-balanced EuroLeague itself. FIBA 40-min format is WNBA-shaped, where our priors live.

## Leagues (13)
International benchmarks: EuroLeague (sr:competition:138), Eurocup (141), Champions League (14051).
Domestic: Greek A1 (304), Israeli Super League (1197), Liga ACB (264), Turkish Super Lig (519), Italy Serie A (262), France LNB Elite (156), Germany BBL (227), ABA Liga (235), Lithuania LKL (975), NBL Australia (1524).
Cups / All-Star / preseason excluded by design (KO format, tiny n).

## Seasons
2024-25 and 2025-26, both completed, per league. (NBL: the two most recent completed seasons.)

## Instrument
SR Global Basketball v2 per-game timelines (score_change events with running score + match_clock), pulled once per game; grain applied at analysis time.
- Checkpoints: 30-second walk over game time — the fine-arena instrument, production-matched, applied identically per league. States pre-Q4, deficit 1-9, dedup per the fine-arena walker (first perception of a state, not parked leads).
- Comparability cut: end-Q2/end-Q3 single-checkpoint staircase reported alongside for lineage with the NBA 1,235 and WNBA 524 instruments. State counts reported with game-clustering noted, plus per-game deduped Q3_END n.
- Clock-coverage QA is step zero per league: % score_changes with usable clock, repair count (minute-field interpolation), monotonicity violations. A league with a broken clock feed is flagged and its 30s numbers carry an instrument caveat; no league is ranked on a secretly broken instrument.
- OT: checkpoint states from regulation periods 1-4 only; winner = final score incl. OT.

## Definitions
- As-of records: each team's win% from prior completed games in the same season feed, ordered by start time; >=5 GP guard both teams or the state is excluded.
- Gap = trailer win% − leader win%. Cells: worse <= −.15 / even (−.15, +.15) / better >= +.15.
- Rate: trailer-WINS. Deficit bands: 1-9 primary; 1-6 reported as NBA-comparable secondary.

## Primary metric & bars
- Staircase monotonicity (worse < even < better) pooled, AND
- Better-cell premium (better minus even) >= +8pp pooled with better-cell n >= 40.
- Both-seasons rule: STRUCTURAL fit tag only if the staircase is monotone in each season independently; otherwise ordering-only.
- Power tags: HIGH 200+ / MED 80-200 / LOW <80 per cell. No directive language below MED.

## Deliverable
Per-league table: staircase (3 rates + n), premium, monotonicity flags, dispersion index (SD of final team win%), season legs, fit ranking. Correlation of premium vs dispersion is the hypothesis read.
Bettability column: each league carries CONFIRMED (seen on PM's book) / EXPECTED (bet365 pattern, unverified) / UNKNOWN. As of prereg: EuroLeague CONFIRMED (PM app screenshot, Aug 14); all others EXPECTED or UNKNOWN. The October logging phase is gated per-league on PM eyeballing the live catalog at season tip — no league enters logging, regardless of scan rank, until bettability flips to CONFIRMED.

## Execution structure: tranches
The scan is registered as ONE study over all 13 leagues; execution proceeds in tranches. Tranche 1 = EuroLeague (both seasons) — instrument pilot: clock-coverage QA, walker validation, and the EL staircase. Tranches 2+ = remaining leagues as mechanical repeats; no methodology changes between tranches — any walker fix found in tranche 1 applies uniformly and is noted in findings. Per-league results are read as they land; the cross-league ranking and dispersion-correlation read compute only when all tranches complete. Bars unchanged.

## Disclosed pre-registration data contact
Feasibility probes on 2026-08-14, before this commit: competitions inventory; EL seasons list; EL 24/25 summaries page 1 (period_scores/stats schema inspection, 1 game printed); one EL timeline (sr:sport_event:51549433) schema inspection. No staircase, gap, or deficit numbers were computed from any of it.

## What ships
Nothing. Findings + puller/walker scripts + compact per-game score-trajectory states commit to research/ with date prefix. Winners earn the deep-dive (free EuroLeague official API) and the separate edge prereg.

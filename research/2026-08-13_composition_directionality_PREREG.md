# PREREG v3 — COMPOSITION DIRECTIONALITY AT DEPTH (Arms A/B/C)

**Date:** 2026-08-13 (PM go in chat). Committed BEFORE cut. EXPLORATORY: 2026 tape already consumed by v1/v2 — no promotion from it; survivors earn a named forward prereg only.
**Parents:** compression PREREG/findings (first-crossing dead), trigger-discovery PREREG/findings (margin-derived entries dead; "any future attempt must use information NOT in the margin timeline"). This study is that attempt: lead COMPOSITION and composition RATES — the DFT-native information layer — measured at deficit crossings.
**PM framing honored:** we don't need accuracy across shapes; we need one or more narrow shapes, sweet-spot style.

## Shared design

Crossing points: first crossing of deficit 10 / 15 / 20 / 25 (historical marks are Q2+ by instrument). One row per game-side per depth. Primary outcome: **tighten** = final deficit < deficit at crossing. Secondary: net margin change over the 6 minutes following the crossing (12 marks). Discovery on 2024-25 (576 games, 30s marks incl. paint makes); validation on 2026 spreads for survivors only.

**Advance bar per cell (taller than v2, since v2 showed price-free tighten ~55% is worthless — the naive baseline had 55% and lost to the market): tighten ≥ 58% pooled AND ≥ 52% in both seasons independently AND n ≥ 60.**
**Validation bar (unchanged): cover ≥ 56% at n ≥ 40 vs 52.38 → named forward prereg, nothing else.**

## Arm A — composition LEVELS at crossings (all thresholds PINNED from the engine, none invented)

- Leader cumulative eFG band: <45 / 45-55 / >55 (SS_STRUCT greenVeto bands)
- Leader variance share (vPct, computeScoringComp definition: [3PT pts + midrange pts] / total pts): >55 vs ≤55 (sweet-spot pinned threshold)
- Leader POT ≥6 vs <6 (FUELTEMP_TH.POT_MIN — takeaway feed as a stock)
- Trailer cumulative eFG: <45 / 45-55 / >55 (TEMP_ABS bands)
- Conditioners report-only: quality-gap cells (as-of strict records), leader wp strata

Historical vShare from box: variance pts = 3·f3m + 2·(fgm − f3m − pntm); total = 2·fgm + f3m + ftm (paint makes pntm from the committed coordinateToZoneServer-mirror accumulation).

## Arm C — composition RATES at crossings (trailing 5-minute window, 10 marks)

- Leader eFG deceleration: windowed eFG vs own cumulative at crossing — any (below), strong (≥10pp below)
- Trailer eFG acceleration: windowed ≥10pp above own cumulative
- Leader takeaway liveness: ≥4 POT gained in the window (validated channel measured as a rate, not a stock)
- Guard: windowed reads require ≥5 window FGA for the measured team, else NO READ (the 3-minute-trajectory noise lesson)

Margin-derived velocity is EXCLUDED by design (v2 conclusion: the market has the margin timeline).

## Arm B — SS-fire spread alternative (descriptive menu fact, NO bars, no gates)

All resolved SS rows (EFG_FADE / SOFT / B tiers / WATCHLIST / GAP_BASE) joined to the live spread at fire (first odds row ts ≥ fire ts, dt ≤ 240s): trailer cover%, by subtype and by fire-ML sign; ROI/$ at −110 spread vs ROI/$ at the fire ML. Output is a menu comparison for the PM (scissor question: does minus-money A-tier favor the spread instrument?), explicitly NOT a signal at these n.

## Multiplicity honesty

Fixed feature set (~14 features × 4 depths). Handled by: frozen set (no post-hoc additions — new ideas go to v4), both-seasons requirement, taller pooled bar, independent price validation for survivors, and the forward-prereg requirement before anything is tradeable. Nothing ships from any arm under any outcome.

# PREREG — COMPRESSION STUDY (tightening after peak deficit)

**Date:** 2026-08-13 (PM go in chat, evening session)
**Status:** committed BEFORE data cut
**Backlog lineage:** market-edge backlog #3 — distributional margin, P(compression) not P(win)
**Trigger:** PM observation — WSH win from 22 down, POR near-comeback from ~30, LA from ~20 tonight; hypothesis that Q3/Q4 tightening after a peak deficit is common enough, and predictable enough, to buy the trailer against the live spread near the peak.

## Question

How often, and how far, do WNBA games tighten after a peak deficit — and does the LIVE SPREAD under-price that tightening in ex-ante identifiable states?

Known adjacent facts (context, not evidence): Q4_COLLAPSE trailer-WINS 0/24 historical; closing-capacity ceiling (erases single digits, not 15-25; ATL Jun 24 lost from −25 despite 26-14 Q4); fine-arena d79 trailer-WINS 35.8%. Wins from deep are dead; partial claw-backs are unmeasured. This study measures them.

## Definitions

- **Margin series:** per game, per team-side, own deficit d(t) = opp pts − own pts at each mark.
- **D_peak** (per game-side): max d(t) over available marks. Study population: sides with D_peak ≥ 12. Both sides of one game may qualify independently (different peaks); each is one row (the dedupe unit is game-side).
- **Time-of-peak:** FIRST mark at which d(t) reaches D_peak. Buckets by gameSec: Q1 (<600], Q2 (600-1200], Q3-early (1200-1500], Q3-late (1500-1800], Q4-early (1800-2100], Q4-late (2100-2400]. Q1 reported for completeness; the prereg'd claims live in Q2+.
- **Compression C = D_peak − final deficit.** Final deficit is negative when the trailer wins, so a win yields C > D_peak. OT finals count as final.
- **Instrument note:** historical marks are 30s samples — true peaks between marks are invisible; D_peak is mark-sampled by construction on both instruments (2026 archive ~26s median, near-matched grain).
- **Gap** = trailer as-of win% − leader as-of win% (leader = the side inflicting D_peak). As-of records are STRICT (< game date), season-scoped, rebuilt from the same export (fine-arena convention).
- **Fuel at peak** = computeFuelTemp (ported verbatim: FUELTEMP_TH {POT_MIN 6, THREE_SHARE 40, VSHARE 45, TO_CLEAN 4, MIN_FGA 12, TEMP 45/55}; EFG_BANDS {1:[54,61],2:[56,63],3:[58,66],4:[60,69]}) on the peak-mark cumulative boxes. vShare unavailable historically → null path (heat = red band OR 3-share ≥ 40).
- **Ex-ante triggers (the tradeable objects — a peak is unknowable live):** T15 / T20 / T25 = first snapshot at which d(t) ≥ 15 / 20 / 25. Hypothetical entry: trailer against the live spread, joined to the FIRST odds row with ts ≥ trigger ts and dt ≤ 240s (no join → excluded, exclusion count reported). Trailer spread = home_spread if trailer is home, else −home_spread. Cover: (trailer final − opp final) + trailer spread > 0; push = 0, reported separately, excluded from cover%.
- **Breakeven:** spread prices are not on tape (points only) — assume standard −110 both sides → 52.38%.

## Instruments & population

1. **Historical arena:** `backtest-wnba?phase=export_checkpoints&grain=30` full walk (NO in-band filter — verified at source before this prereg), 576 games 2024+2025, scores + slim boxes at every 30s mark. No spread tape exists for these seasons → base rates + predictors only.
2. **2026 production archive:** finished games in the games table; margin timelines from `get_snapshot_timeline` (server-source snapshots, ~26s median); live spread tape from `odds_history` (median consensus spread, verified live-moving: CHI@GS −7.75 → −22.5 in-game; ML observed pulled late while spread stays quoted). Edge-vs-line is 2026-only and carries the [this season] tag; regime is TRANSIENT_COLLAPSE ACTIVE and all 2026 numbers are era-riders by construction.

## Hypotheses & bars

- **H0 (descriptive, no bar):** distribution of C by D_peak bucket (12-15 / 16-19 / 20-24 / 25+) × time-of-peak. Report median C, P(C≥8), P(C≥12), P(trailer-WINS), n. 2024 and 2025 independently, then pooled; 2026 separately tagged. Also the PM's "straight blowouts are rare" claim, quantified: share of D_peak ≥ 15 sides with C < 5.
- **H1 (predictor):** the quality-gap staircase orders compression. Cells gap ≥ +.15 / middle / ≤ −.15 on P(C≥10), controlled by D_peak bucket. **Bar: monotone ordering in 2024 AND 2025 independently, AND ≥8pp pooled separation between the outer cells within at least the two most-populated D_peak buckets.** Leader wp strata and fuel class at peak: reported, NO bars, first pass. Killer flag: deferred to a follow-up cut if H1 clears (port cost not justified before the primary predictor exists).
- **H2 (the money question, 2026 only):** T15/T20/T25 cover% vs 52.38%. **Bar: cover ≥ 56% at n ≥ 40 for any trigger** → candidate for a forward-logging phase (NOT a bet stream; logging first, per #9 convention). Below n=40: report-only, no directive language, LOW tag.
- **H3 (mechanism, no bar):** decompose post-trigger compression into live vs dead-time (dead = after the first odds row where both MLs are null and stay null). If compression is mostly dead-time, the finding is about garbage-time pricing specifically — still tradeable if H2 clears, but named for what it is.

## Rules

One row per game-side. Both-seasons rule for any structural claim. Edge vs the line is primary wherever a price exists; conversion rates without prices are half-findings and labeled as such. Power tags HIGH 200+ / MED 80-200 / LOW <80. All rates labeled (C-threshold or trailer-WINS — no bare "converts"). Failures commit with findings docs. Scripts + states files commit alongside so every number is regenerable.

## Promotion rule

Nothing ships from this study. H2 clearing its bar produces a PM decision package (forward-logging spec proposal, sizing untouched). H1 clearing adds a predictor candidate to the follow-up cut (killer port + fuel bars). All engine/code changes require separate specs and explicit PM go.

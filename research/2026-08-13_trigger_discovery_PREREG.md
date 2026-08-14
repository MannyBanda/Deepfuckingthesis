# PREREG v2 — PEAK-IDENTIFICATION TRIGGERS (compression follow-up, EXPLORATORY)

**Date:** 2026-08-13 (PM directive in chat: "explore some other triggers that help us identify peak deficit better")
**Status:** committed BEFORE cut. EXPLORATORY tag on everything — the 2026 tape was already consumed by the H2 first-crossing test, so no result here promotes; survivors get named for a forward-tape prereg only.
**Parent:** research/2026-08-13_compression_PREREG.md + findings (H2 failed; mechanism = trigger ≠ peak; post-crossing expansion −2.4 vs market's +2.7 tightening allowance).

## Design — two stages, anti-forking-paths

**Stage 1 DISCOVERY (2024-25 arena only, 576 games, 30s marks, NO prices exist):** trigger quality is a pure margin-timeline property — does the trigger fire after the true peak, with clock remaining, often enough to matter? The historical tape has never been cut for trigger timing.

**Stage 2 VALIDATION (2026 tape, live spreads):** only variants clearing the Stage-1 bar get their cover% measured. Everything else never touches the price data.

## Candidate triggers (declared now, mechanisms attached)

All require running-max deficit ≥ D, D ∈ {15, 20}. First fire only (ex-ante honest). Eligible population: game-sides whose running max ever reaches D.

- **PB-k (pullback):** fire at first mark where current deficit ≤ runningMax − k, k ∈ {3, 5, 7}. Mechanism: the run that built the lead has visibly broken; k points of claw-back is the confirmation price paid to avoid entering during expansion.
- **ST-m (stall):** fire at first mark where no NEW running max for m minutes, m ∈ {3, 5}, AND current deficit ≥ runningMax − 2 (lead parked, not receding — distinguishes from PB). Mechanism tension declared up front: the fine-arena sampling-moment lesson says parked leads are STRONGER holds at small deficits; this tests whether that inverts at blowout depth.
- **TB (time-boxed control):** first crossing of D only if it occurs by Q3-end (gameSec ≤ 1800). Known-weak control (H2 subset ran 49.2% at T15); included as the baseline-plus.

Conditioners reported WITHOUT bars: quality gap cell, leader wp, leader red-band eFG at fire.

## Stage-1 metrics & advance bar

Per variant: n fired, coverage (% of eligible sides that ever fire), clock at fire, peak-capture P(no new running max after fire), mean future expansion (max future deficit − d_fire), **primary: tighten-rate = P(final deficit < deficit at fire)** and mean net (final − fire).

**Advance bar (declared): tighten-rate ≥ 55% pooled AND ≥ 52% in 2024 and 2025 independently AND pooled n ≥ 80.** Baseline for reference: naive first-crossing at the same depth. Honesty note pinned now: tighten-rate is the price-free analog of covering a spread equal to the entry deficit — real live spreads sit BELOW the current deficit (the book pre-grants tightening), so tighten-rate overstates cover economics by construction. Stage 2 exists because of exactly this.

## Stage-2 metrics

For survivors only: join live spread (first row ts ≥ fire, dt ≤ 240s), cover% vs 52.38, Wilson 95, cushion at fire (trailer spread − deficit at fire) to show how much the market re-prices after the pullback/stall. **No promotion bar on this tape** — a survivor with cover ≥ 56% at n ≥ 40 earns a NAMED FORWARD PREREG (fresh tape, from tomorrow), nothing else. Below that: recorded and shelved.

## Rules

One row per game-side per variant. Both-seasons rule at Stage 1. All rates labeled. Power tags. Variant count is fixed at the eight above × two depths — no post-hoc variants added after seeing results (any new idea goes in a v3 prereg). Failures commit with findings. Nothing ships from this study under any outcome.

# PREREG — LATE-GAME EXECUTION TRAIT ("clean-up" tendency)

**Date:** 2026-08-18. **Status:** committed pre-data. **PM go:** in chat ("Yes" to prereg + Phase 0).
**Motivating case (disclosed as hypothesis-generation, NOT evidence):** row 42 (NY@CHI, Aug 18) — takeaway-fed TRANSIENT lead did not regress; NY's late turnovers kept feeding the channel, including after briefly taking the lead inside Q4 5:00.

## Mechanism under test

Points-off-turnovers is the ONLY fuel channel the TRAILER supplies. Leader eFG heat and 3P barrages regress on the leader's own variance; POT regresses only if the trailer's ball security improves. The TRANSIENT stamp is therefore trailer-blind in exactly one channel. Hypothesis: late-game ball security is a stable team trait that conditions whether takeaway-fed leads actually regress.

**Prior art honestly stated:** trailer-side overlays are 0-for-2 (trailer temp — killed; trailer eliteness — killed). This candidate differs by having a causal mechanism (the trailer feeds the channel), which is why it earns a prereg. It may still die the same way.

## Phase 0 — feasibility + motivating case (this session)

Verify per-quarter TO and possession components are derivable: 2026 from snapshot cumulative diffs at quarter boundaries; 2024–25 from the arena walker (states carry cumulative `tto`/`lto` at 30s grain — quarter-boundary reconstruction). Document NY's 2026 late-TO profile vs the league aggregate (aggregate only — no per-team rankings in Phase 0; that is Phase A substrate). No hypothesis is tested in Phase 0.

## Metrics (adjudication pre-registered)

- **M1 (absolute):** (Q3+Q4 team TO) / (Q3+Q4 possessions), possessions = FGA + 0.44·FTA + TO − OREB from quarter diffs. Fallback denominator if components are unavailable on a surface: TO per 10 team minutes — the surface's denominator is declared in findings and never mixed.
- **M2 (clean-up delta):** M1 minus the same rate over Q1+Q2 (does the team tighten or loosen late).
- **Adjudication rule:** the metric with the higher Phase A pooled reliability advances to Phase B alone. If both fail the bar, the study STOPS and the matchup-sheet column idea dies with it.

## Phase A — stability gate (HARD gate)

- **Primary:** split-half reliability — within each team-season (2024, 2025, 2026), split games odd/even by date, compute the metric on each half, Pearson r across pooled team-seasons (n≈39). **Bar: r ≥ .40.**
- **Secondary (descriptive, no bar):** per-season legs; year-over-year carryover (2024→2025 team pairs); early/late season stability.
- Team-season minimum 16 GP to enter; as-of computations in later phases use strict-< with ≥10 GP and shrinkage to league mean (shrinkage weight k=10 pseudo-games, fixed here).
- **If Phase A fails: full stop.** No display column ships on an unstable trait — a column of noise manufactures conviction at the window.

## Phase B — does the trait predict channel regression?

- **Population:** the validated takeaway cell — in-band (deficit 1–9), gap ≥ .15, leader POT ≥ 6, pre-Q4.
- **Split:** trailer late-execution tercile (as-of, strict-<, shrunk; unrankable trailers excluded and counted).
- **Surfaces:** arena (2024+2025, conversion, both-seasons rule) + 2026 price-joined tape (edge vs de-vig primary per standing rule; realizable edge reported alongside as secondary per the Aug 18 addendum convention).
- **Bar:** clean tercile beats sloppy tercile by ≥ 8pp conversion in BOTH historical seasons independently AND positive edge separation on the 2026 joined tape. n ≥ 25 per tercile per surface, else ordering only.

## Phase C — incrementality

Clean-vs-sloppy separation must survive WITHIN gap class (reported at gap .15–.30 and .30+ separately). If separation vanishes within class, verdict = PROXY (the gap stamp already carries it) and nothing ships beyond Phase A's display column.

## Product ladder (pre-committed)

1. **Phase A pass alone** → display-only matchup-sheet column (factual trait, rotation-ladder precedent). Code ships only on explicit PM go.
2. **Phase B pass at power** → time-conditioned caution kernel on takeaway-flagged fires, ACA pattern (one copy source, three surfaces).
3. **Forward stamp** (trailer late-execution percentile on POT-flagged SS rows, NULL-degrading, display-only) eligible after Phase A pass — starts the forward OOS tape regardless of Phase B outcome.
4. **Never a gate** without the full promotion bar (~25–40 forward triggers + realized-within-5pp discipline).

## Multiplicity & amendments

Metrics limited to M1/M2 with the adjudication rule. Cells limited to those named above. Anything else is labeled POST-HOC. Amendments allowed pre-data-contact only, dated, in a companion file.

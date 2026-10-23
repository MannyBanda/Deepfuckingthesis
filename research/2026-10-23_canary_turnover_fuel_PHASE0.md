# Canary × Turnover Fuel — PHASE 0 (coverage, counts, cut points) + AMENDMENT 1

**Date:** 2026-10-23
**Prereg:** `research/2026-10-23_canary_turnover_fuel_PREREG.md` @ `d7eb6e2`
**Export:** `research/2026-10-23_canary_fuel_fires.json.gz` — 818 fires / 1,235 games, phase `canary_fuel_export` @ `7587c8b`, seed 20261023 (+offset). Regenerability verified: re-running offset 300 (100 games, 68 fires) reproduced the committed rows byte-for-byte.
**Script:** `research/2026-10-23_canary_fuel_phase0.py`
**Outcome contact:** NONE. Nothing below reads `ctrl_won`, `winner`, or `final_margin`, and the `base_rates` proxy table is held back until Phase 1.

---

## Coverage

| | n |
|---|---|
| Games in `nba_snapshot_backtest` | 1,235 |
| Date range | 2025-10-21 → 2026-04-15 (**one season: 2025-26 regular, all rows**) |
| Fires (combined canary, ctrl margin ≥ 1 at trigger) | 818 |
| Production-style pattern: CLEAN / WAVE / NORMALIZED / FALSE_ALARM / unclassified | **171** / 52 / 71 / 329 / 195 |
| Post-hoc (May replay) pattern: CLEAN / WAVE / NORMALIZED / FALSE_ALARM | 204 / 19 / 127 / 468 |
| CLEAN(prod): POT non-null at trigger | 171/171 |
| CLEAN(prod): XGB at trigger (from `mc_backtest_results`) | 171/171 |
| CLEAN(prod): floor at trigger > .75 | 68/171 |
| Proxy table: checkpoint-states Q3_9..Q4_3, margin ≠ 0 | 8,155 states in 28 cells |

"Unclassified" = the game reached Q4_END before three verdicts accumulated. Production would never have pushed on these.

## Three instrument facts (the reason this doc exists before any cut)

**1. The backtest is single-season.** Every row is 2025-26 regular season. The prereg's bar 3 ("both backtest seasons independently") cannot be executed as written. See Amendment 1.

**2. The hindsight gap is material.** Production-style CLEAN (n=171) and post-hoc CLEAN (n=204) overlap on only **119** games. 49 production CLEANs later NORMALIZED and 3 became WAVEs — production would have pushed on all 52 of those, the May replay counted none of them. Conversely 20 post-hoc CLEANs are FALSE_ALARM in production order, 29 were never classified in time, and 36 are production WAVEs. The May 77.6% was measured on a population ~58% overlapping with what production actually pushes. This is reported as a population fact; the precision consequence is a Phase 1 number.

**3. At the push moment the lead is usually already gone.** With 3-minute checkpoints the earliest CLEAN is three verdicts after the trigger (≥ 9 game-minutes; push checkpoint = Q3_END 68 · Q4_9 49 · Q4_6 32 · Q4_3 22). By then the control team is **trailing or tied in 117 of 171** CLEAN fires; it still leads in 54 (1-3: 36 · 4-8: 16 · 9-15: 2). Production classifies on a ~26s grid and pushed CLE@PHI 4:11 of game time after the trigger with the lead still +13. So the backtest's "trailer buy at the push" is, two-thirds of the time, a "buy the team that just took the lead" — a very different price than the +600 that motivated this. The fine-arena lesson applies in full: Instrument A measures the sampling moment, Instrument B (production archive) is the transfer check for the bet-time state.

## Corrected margin-at-trigger counts (n only; precision is Phase 1)

CLEAN(prod), ctrl margin at trigger: **1-3: 58 · 4-8: 77 · 9-15: 30 · 16+: 6.** The May table's "≤3 = 179" shrinks to 58 once ctrl-trailing triggers are excluded and production classification is used. Trigger checkpoint: Q3_9 101 · Q3_6 36 · Q3_3 27 · Q3_END 7. Trigger reason: absolute 165 · divergence 6.

## Tercile cut points (CLEAN(prod), n=171 → 57 per tercile)

| Feature | lo cut | hi cut | read |
|---|---|---|---|
| F1 net POT (leader − trailer) at trigger | −2 | +5 | top tercile = leader POT advantage ≥ 6 |
| F2 trailer TO rate at trigger | .130 | .174 | |
| F3 clean-up delta (post − pre trailer TO rate, trigger → push) | −.068 | +.007 | bottom tercile = cleaned up by ≥ 6.8 pp of possessions |
| F4 FTA edge (leader − trailer), descriptive | −3 | +2 | |

Post-trigger trailer possessions at the push: median 19.9, min 13.6 — enough for a turnover rate; F3 is non-null on all 171.

**Power:** 57 per tercile is LOW on the standing register (HIGH ≥200 · MED 80-200 · LOW <80). The prereg's n ≥ 40/tercile bar is met, but the register's rule — ordering only, no directive language below MED — governs the findings' language regardless of whether the bars pass. The §8 ladder's PASS deliverable will therefore carry the *fact* (e.g., "lead is takeaway-fed") and not a printed rate unless Instrument B or a second season lifts the cell to MED.

---

## AMENDMENT 1 (instrument defect, pre-Phase-1, 2026-10-23)

Permitted under prereg §9 ("instrument defects … dated and disclosed; bars and features do not move").

**A1.1 — Replication split.** Bar 3 "both backtest seasons independently" → **both chronological halves of 2025-26 independently**, split at the CLEAN(prod) median trigger date **2026-01-20** (≈ 85/86 fires per half). Same requirement: sign agreement and ≥ 4pp in each half. This is weaker than a true second season (shared rosters, shared regime) and is disclosed as such; a second season lands when the 2026-27 archive matures.

**A1.2 — Secondary stratum, report-only, no promotion authority.** Because production pushes much earlier than the 3-minute replay can (fact 3), add a pre-declared read at the **first verdict checkpoint after trigger** (`path[0]`, ~3 game-minutes — the closest the instrument gets to production latency). Same F1/F2 features at trigger; F3 recomputed trigger → `path[0]`; same proxy. Reported alongside the primary; it cannot pass or fail anything on its own.

**A1.3 — Proxy direction at the push.** The prereg wrote edge as "trailer-WIN − (1 − proxy hold rate)". At the push the original trailer is itself the leader in 117/171 rows; the Phase 1 script evaluates the proxy at the push checkpoint using the **scoreboard** leader and flips it when the original trailer leads: proxy P(trailer wins) = hold rate if the trailer leads, 1 − hold rate if it trails, 0.5 if tied. This is a clarification of the formula, not a change to the metric.

Nothing else moves. Features, terciles, the 8pp/8pp bars, monotonicity, and the ladder stand as committed at `d7eb6e2`.

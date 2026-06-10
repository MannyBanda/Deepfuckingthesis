# WNBA v3 Phase 4a — Adjudication Report
**Date:** 2026-06-10
**Data:** 86/88 finished 2026 games backfilled to `wnba_official_stats` (24832/24833 lack advanced data at BDL — nightly job retries). 81 team-rows matched: last live snapshot (P4, near-final) vs official BDL game advanced. Residual-time noise: snapshots are 0-60s before true final, so exact% is a floor.

## Verdicts per field [FACT:prod, n=81]

| Field | Source tested | mean err | median abs | p90 abs | exact% | VERDICT |
|---|---|---|---|---|---|---|
| paint | ESPN pointsInPaint | +0.07 | 0.0 | 2.0 | 89% | **ESPN direct — APPROVED** |
| fbp | ESPN fastBreakPoints | -2.05 | 0.0 | 9.0 | 75% | ESPN direct, anchor-corrected (tail games undercount) |
| pot (same side) | ESPN turnoverPoints | -0.33 | 6.0 | 14.0 | 17% | — |
| **pot (FLIPPED)** | ESPN turnoverPoints, opponent-attributed | -0.64 | **0.0** | 7.0 | **67%** | **ESPN direct WITH ATTRIBUTION FLIP — APPROVED** |
| scp | PBP regex derivation | -2.47 | 2.0 | 6.0 | 30% | **REJECTED — Phase 2 possession machine required (ESPN lacks SCP)** |
| possessions | FGA-OREB+TOV+0.4*FTA estimator | +0.65 | 1.6 | 4.0 | 2%* | Estimator APPROVED (~2% error; *continuous value, exact match not expected) |

## Headline finding: ESPN `turnoverPoints` is OPPONENT-attributed
ESPN reports each team's "turnoverPoints" as points scored off that team's turnovers BY THE OPPONENT (or equivalently, our parser maps the value to the wrong side). Flipping attribution takes POT from 17%-exact to 67%-exact with median error 0.

### Consequences
1. **Live display bug, league-wide, all season:** every WNBA raw_stats_json `pot` stored to date is side-flipped, and any consumer of ESPN-summary `points_off_turnovers` (indicator I1 disruption inputs, agent prompt paint/POT lines, evidence panels) has been seeing inverted POT — which inverts SIGN in ctrl-relative diffs. Severity on I1/floor needs a quick impact check (I1 is 15% weight in WNBA).
2. **Retrain dataset:** historical pot values must be flipped during Phase 6 training-table construction. Trivial, but mandatory.
3. **Shared-parser caution:** `_parseESPNTeamStats` serves NBA too. NBA's primary path is BDL (ESPN summary rarely used), but the flip fix must be league-gated OR verified against NBA official data before touching the shared mapping. Do not assume the flip generalizes.

## Phase gates resolved
- Phase 1 structural overlay sources: paint=ESPN, fbp=ESPN(+anchor), pot=ESPN-flipped(+anchor), scp=Phase-2 machine, poss=estimator (optionally calibrated by +0.65 offset).
- Phase 2 acceptance target confirmed necessary and quantified: beat PBP-regex SCP baseline (median 2, p90 6, mean -2.47); spec tolerance median<=2 / p90<=4 is achievable bar.
- Phase 4b nightly: validation harness writes to wnba_field_validation using these same comparisons; drift alarm thresholds seeded from this report's p90s.

## Artifacts
- `research/backfill_wnba_official.py` (idempotent; rerunnable any time)
- db-api: `upsert_wnba_official`, `get_wnba_official`, `get_final_snapshots` (commit 857ea23)
- Tables: `wnba_official_stats` (172 rows), `wnba_field_validation` (empty, 4b)

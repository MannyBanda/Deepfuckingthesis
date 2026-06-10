# WNBA Data Layer Audit + Live Spreads Test
**Date:** 2026-06-09
**Context:** Follow-up to market edge test #1 (3dce296). WNBA models lose to the line everywhere; before concluding "no WNBA edge," audit whether the input data layer is the bottleneck, and test the spread market as an alternative edge surface.

## Part 1 — WNBA data layer audit [FACT: code + live API]

### Current WNBA live data path (poll-live-bdl.mjs ~L7154-7184)
- Display/indicators/floor/alerts: ESPN summary (`buildSummaryFromESPN`), enriched with BDL-PBP SCP + runs.
- Models (XGB/MC): `modelSummary = _srSummary` — **misleadingly named; it is `buildSummaryFromBDLPlayerStats` (BDL-derived), NOT Sportradar.**
- **Sportradar live game summary is never fetched during live WNBA polls.** SR is schedule/pregame only.

### What SR WNBA summary actually carries (verified live via sr-data proxy, IND@WSH 6/8)
- 78 cumulative TEAM fields incl: points_in_paint (+att/made/pct), points_off_turnovers, second_chance_pts (+att/made/pct), fast_break_pts (+att/made/pct), biggest_lead, possessions, offensive/defensive_points_per_possession, off/def rating, fouls_drawn, bench_points, pls_min, rim/midrange FG splits, time_leading, true_shooting.
- 57 per-period fields (paint, POT, SCP, FBP, biggest_lead per quarter — native quarter boundaries, no PBP reconstruction needed).
- Full per-player statistics (62 fields) — BDL WNBA has NO per-player endpoint at all.

### Implication
The WNBA XGB feature set (13 reduced features: disruption, ast_ratio, to_ratio, etc.) was shrunk to fit BDL's gaps. SR would unlock the NBA-grade feature set (paint, pot, fta, efg, biglead, 3pr, rim_pct, runs + possessions/pace) plus native per-quarter boundaries (kills the cross-fade reconstruction fragility AND likely the phantom-boundary snapshot class of bugs for model inputs).

### Open feasibility questions (need a live-slate check)
1. Does the SR trial key return in-progress summaries (not just closed games)?
2. Update latency vs ESPN/BDL?
3. Live field completeness (some fields may populate only post-game)?
4. Quota: trial = 1 req/s + daily cap. ~3 games x ~150 polls = ~450 calls/night + schedule/pregame load. Tight vs typical 1,000/day trial cap; paid tier is the fallback (cost decision).

### Options (no code committed — assessment only)
- **A (preferred): SR live summary as WNBA model source; retrain WNBA XGB on full feature set.** Gate on live-slate feasibility check first.
- B: ESPN as model source (fresher, fewer structural fields) or ESPN-fast/SR-structural hybrid.
- C: Fix BDL boundary-snapshot bug regardless (already an open decision from Jun 7).
- D: Paid SR tier if quota blocks A.
- Honest caveat: better inputs raise the WNBA model ceiling but do not guarantee it clears the line. The line-paired OOS test from edge test #1 is the acceptance bar for any retrain.

## Part 2 — Live spreads test [FACT:prod]

Data: same snapshot<->odds join, now with `home_spread` (median consensus point across books; prices not stored — assume -110, breakeven 52.4%). 10,554 pairs, 148 games. Cover = final_margin + home_spread > 0.

### Findings
1. **Live spread is well calibrated in both leagues** (mean per-game residual: NBA -1.0 pt, WNBA -0.3 pt). No free lunch from bias.
2. **Divergence-side ATS (bet the side our model favors vs the ML line to cover the live spread, first crossing per game):**
   - **NBA MC D>=0.10: 68.3% cover [CI 57-79], n=63; IS 61% -> OOS 84% (n=19).** Strongest policy result in the study. Direction survives OOS. [PRIOR — MED-n borderline; magnitudes not trusted]
   - NBA XGB: ~51-53%, nothing.
   - **WNBA: IS 55-65% -> OOS 32-43%. Overfit signature again. WNBA now triple-falsified (ML divergence ROI, OOS blend LL, ATS).**
3. Continuous check: corr(MC divergence, spread residual) positive with game-cluster CI excluding zero in both leagues (NBA +0.28 [+0.08,+0.46]; WNBA +0.20 [+0.05,+0.34]) — but pooled/in-sample; WNBA does not survive the OOS policy cut.

### Interpretation
The NBA MC-vs-spread result suggests live spreads underreact to scoreboard-anchored win probability (plausible mechanism: books shade live favorites for comeback liability). NOT actionable yet: n is LOW-MED, all-playoffs regime, spread prices unobserved (assumed -110), median-consensus point may not be executable.

### Logging gap found
We store spread POINT but not spread PRICES. If ATS becomes a research thread, add spread price capture to the odds-api batch (schema + 2-line change — backlogged, not built).

## Verdicts
1. WNBA model weakness has a concrete, addressable data-layer cause: models run on the worst of three available sources while the best (SR) goes unused live.
2. Next concrete step: live-slate SR feasibility check (tonight's 3-game WNBA slate works) — zero prod risk, answers questions 1-3 above.
3. NBA MC-vs-spread is a genuinely promising new thread; park until regular season replication or more playoff games accumulate.
4. WNBA betting edge from current models: falsified across all three tests. Treat WNBA alerts as analytical, not bettable, until the data layer upgrade + retrain clears the line bar.

## Addendum: BDL endpoint re-probe (Jun 9, live API verification)

**Genuinely NEW for WNBA (all were 404 at May launch):**
1. `/wnba/v1/team_stats` — per-game TEAM box (fgm/fga, 3s, FTs, oreb/dreb, ast/stl/blk, turnovers, fouls). Filters: `game_ids[]`, `seasons[]`, `team_ids[]`. Verified populated for Jun 8 games. Basic box only — no paint/POT/SCP/FBP/possessions.
2. `/wnba/v1/player_stats` — per-game PLAYER stats including **plus_minus**, min, pts, full box. (The per-player endpoint that 404'd at launch.) Unlocks I4-style lineup signal + bench points for WNBA.
3. `/wnba/v1/standings` — W/L, conference records, playoff seed. Can replace the SR standings call -> frees SR quota for live summaries (synergy with Option A).

**Still missing for WNBA:** season_averages (all variants 404), box_scores, any advanced stats, any live box endpoint.

**NBA:** `/v1/season_averages/{category}` with categories general/clutch/defense/shooting/playtype/tracking/hustle/shotdashboard and `type=advanced` returns 74-field player season advanced (off/def/net rating, usage, pace, PIE, ranks). No team-level season advanced exists (`type=team` is silently ignored — returns player rows; verified). `/v1/stats/advanced` per-game player advanced unchanged.

**Probe hygiene notes:** BDL 400 `{"param":"id"}` errors on /games/advanced etc. are router fall-throughs to `/games/:id` — phantom routes, not hidden endpoints. No OpenAPI spec served from api host. Project-file BDL_Full_Spec.pdf is a zip of screenshots, not parseable.

**Open question for tonight's slate:** do team_stats/player_stats update LIVE in-game or post-game only? Test alongside SR live-summary feasibility.

**Revised data-layer architecture implication:** BDL's new endpoints close the lineup/plus_minus/standings gaps but NOT the structural-stat gap — paint/POT/SCP/FBP/possessions/per-period remain SR-only. Recommended stack: SR live summary -> structural model inputs; BDL player_stats -> lineup/bench/plus_minus enrichment + season caching; BDL standings -> replace SR standings; ESPN -> fast display tier.

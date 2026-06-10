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

## CORRECTION to BDL addendum (same day): WNBA advanced stats DO exist

My probe missed them — I pattern-matched NBA route names instead of reading the WNBA OpenAPI spec (https://www.balldontlie.io/openapi/wnba.yml, docs at wnba.balldontlie.io). The WNBA API uses different resource naming. All verified live with our GOAT key:

1. `/wnba/v1/team_game_advanced_stats` — per-game team PIE, pace, **possessions**, net/off/def rating, assist ratio/pct, turnover ratio. Has `period` param (0=full game) — accepted but returned 0 rows for period=3 on Jun 8 game; per-period population unverified.
2. `/wnba/v1/player_game_advanced_stats` — per-player per-game PIE, ratings, usage, possessions, pace.
3. `/wnba/v1/team_season_advanced_stats` — measure_type: advanced/misc/scoring/usage/defense/**four_factors**/opponent/base; scope: general/**clutch**. Four-factors payload includes own+opponent eFG/TOV%/OREB%/FTA-rate with league ranks. Clutch scope returns clutch PIE/pace/ratings.
4. `/wnba/v1/player_season_advanced_stats` — same measure_type/scope matrix per player.
5. `/wnba/v1/team_shot_locations` + 6. `/wnba/v1/player_shot_locations` — zone-level FG splits (restricted area, mid_range, corner 3s, ATB 3) or 5ft ranges.
Also: `/wnba/v1/player_season_stats`, `/wnba/v1/team_season_stats` (season averages — fields top-level, not nested).
Also: `/wnba/v1/odds` — PER-VENDOR spread value+price, ML, totals with updated_at (betmgm/betrivers/caesars/draftkings/fanatics/fanduel) — closes the spread-price logging gap via existing GOAT sub. `/wnba/v1/odds/player_props` live.

### Revised data-layer picture
- **Season-prior layer: BDL now covers it fully** (four factors + clutch ratings + shot zones + advanced ratings). Feeds hierarchical team priors (backlog #8), per-team sustainability baselines, VT/shot-diet priors, MC clutch inputs.
- **Live intra-game structural counting stats (paint/POT/SCP/FBP, per-period boundaries): still SR-only.** SR option stands but is narrowed to the live structural tier.
- Docs explicitly state team_stats/player_stats are "updated in real-time for games currently in progress." Advanced game stats carry no liveness note (NBA's say post-completion only). Verify both tonight.

### Tonight's live-slate checklist (consolidated)
1. SR live summary: in-progress availability, latency, field completeness, quota math
2. BDL team_stats/player_stats live cadence (docs claim real-time)
3. BDL game advanced stats: live vs post-game; does `period` populate during/after games
4. BDL boundary catch for the phantom period=4 bug (Jun 7 open decision)

## Live-slate verification results (Jun 9 night, PHX@GS live + 2 finals)

**1. POT/SCP proxy validation vs SR — FAILED.** Final-box comparison, DFT PBP-derived vs SR official:
- ATL@CHI: POT 14/17 vs SR 19/25 (-26%/-32%). SCP 0/12 vs SR 1/17.
- DAL@MIN: POT 9/10 vs SR 19/10 (home -53%, away exact). SCP 2/6 vs 4/11.
- Systematic undercount, occasionally severe. POT is WNBA XGB feature [11] — the model trains and serves on corrupted POT. Biglead mostly fine (live-margin override working).

**2. BDL lag re-measured: ~30-60 game-seconds behind ESPN/SR** (7 samples over 4 min; prior belief was ~90s — improved but material). ESPN and SR track each other within ~0-4s. BDL team_stats totals update every ~30-60s.

**3. SR trial key serves LIVE in-progress summaries.** status=inprogress, live clock, paint/POT/SCP/FBP/possessions all populating mid-game, latency ≈ ESPN. One transient fetch failure in 7 samples — needs throttle+retry. Feasibility for Option A: CONFIRMED.

**4. BDL liveness:** team_stats + player_stats live in-game (docs claim verified; team_stats == player_stats aggregation exactly). Game advanced stats (team+player): 0 rows during live game — post-game only.

**5. Boundary states captured live:** during Q1->Q2 break, BDL game showed period=1 time='0.0', then period=2 time='10:00' parked while ESPN/SR showed Q2 9:07 running. Spec input for the extraction guard: treat time in {'0.0','10:00'} as boundary-stale regardless of period.

## GAP ANALYSIS — current BDL usage vs target sourcing (WNBA)

| # | Data category | Current source | Target source | Notes |
|---|---|---|---|---|
| 1 | Live team box (fga/ast/stl/blk/tov/oreb) | Aggregate /wnba/v1/player_stats | Keep (or team_stats for simplicity) | Verified identical; low priority |
| 2 | Live structural: paint, POT, SCP, FBP, possessions, per-period | PBP regex reconstruction (POT/SCP only; no paint/FBP/poss) | **SR live summary** | Proxy falsified tonight; SR live confirmed. HEADLINE CHANGE. Requires XGB retrain (feature distribution shift) |
| 3 | PBP (runs, shot zones, margin flow) | /wnba/v1/plays | Keep BDL plays | Drop POT/SCP derivation after #2 ships |
| 4 | plus_minus / lineup / bench | Fetched in player_stats, unused | **Start consuming** | I4 subB + bench_points for WNBA |
| 5 | Season priors (four factors, clutch, shot zones, season avgs) | League constants + 6-9 game clutch UPSERTs | **NEW: BDL team/player_season_advanced_stats (four_factors, clutch scope), shot_locations, season_stats** | Per-team sustainability baselines, MC clutch inputs, VT/shot-diet priors, hierarchical priors (#8) |
| 6 | Post-game advanced (PIE/ratings/poss per game) | None | **NEW: BDL game advanced stats** | Post-game only — learning agent, backtests, retrain features |
| 7 | Odds | The Odds API (best ML, median spread point, no prices) | **ADD: BDL /wnba/v1/odds** | Per-vendor spread value+price, ML, totals; closes spread-price gap; relieves Odds API quota |
| 8 | Standings | SR | **BDL standings** | Frees SR daily quota for live summaries |
| 9 | Schedule / game IDs | SR + ESPN fallback | Keep | SR UUID is the system key |
| 10 | Display / fast score | ESPN | Keep | Fastest tier confirmed again tonight |

**Coupling note:** #2 (SR structural) + #5 (season priors) + retrain on true POT/paint/FBP/possessions is one coherent WNBA model-v2 program, accepted/rejected by the line-paired OOS bar from edge test #1.

## REVISED GAP ANALYSIS v2 — BDL-primary, SR minimal (no live polling), ESPN fills
Constraint set by Manny: SR paid tier ($1,800) not justified at current stage. BDL is building out WNBA; work with BDL + ESPN + SR-trial-no-live.

### Key discovery (live snapshot verification, ATL@CHI + PHX@GS Jun 9)
**ESPN's WNBA summary ALREADY provides paint, FBP, POT, and largestLead live — and `_parseESPNTeamStats` already maps them — but only the DISPLAY path consumes them. The model path (`modelSummary`) uses BDL aggregation + the falsified PBP POT/SCP.** Snapshot raw stats (ESPN-built) for ATL@CHI final: paint 48/26, fbp 11/7, pot 16/25, bigLead 10/6, poss 78.4/72 — all populated.
Accuracy vs SR finals (1 game): bigLead EXACT both sides; SCP is PBP-derived (still undercounts); ESPN POT within 0-3 pts one side, off ~6-9 the other (attribution/definition needs multi-game verification). Possessions estimator within ~2-3% of SR.

### Q1 — New from BDL (vs WNBA launch in May)
LIVE (verified real-time tonight): player_stats (per-player box incl **plus_minus** — unlocks I4 subB, bench, lineup reads; plus_minus currently fetched but unused), team_stats (== our player aggregation).
POST-GAME: team/player_game_advanced_stats (PIE, ratings, pace, TRUE possessions).
SEASON: team/player_season_advanced_stats (four_factors own+opp w/ ranks, clutch scope, misc/scoring/usage/defense/opponent), shot_locations (zones/5ft), season_stats, standings, player_injuries.
ODDS: per-vendor spread value+price, ML, totals (6 books).

### Q2 — SR-only fields: approximation plan
| Field | Approximation | Status |
|---|---|---|
| biggest_lead | ESPN largestLead + live margin tracker | VERIFIED EXACT vs SR — solved |
| paint | ESPN pointsInPaint (live, populated) | accuracy vs SR TBD; low stakes (paint=noise in WNBA framework) |
| FBP | ESPN fastBreakPoints (live, populated) | accuracy TBD |
| POT | ESPN turnoverPoints AND/OR rebuilt PBP possession-state machine | ESPN mixed in 1-game check; rebuild PBP from regex->possession-origin tracking (credit ALL pts in possession incl FTs) |
| SCP | Rebuilt PBP possession-state machine (ESPN doesn't provide SCP) | current regex falsified; possession-origin rebuild is the fix |
| possessions (live) | FGA - OREB + TOV + 0.4*FTA estimator (already computed) | within ~2-3% of SR; calibrate vs BDL post-game TRUE possessions |
| per-period splits | quarter_data boundary diffs + boundary-stale guard (time in {'0.0','10:00'}) | existing mechanism, guard pending |

**Validation harness (SR's new job):** nightly post-game SR summary pull (3-6 calls/night, trivial trial quota, NO live polling) -> compare every approximated field vs SR ground truth -> error tracked in DB per field per game. Approximations graduate into the model only when within tolerance (proposed: POT/SCP/paint within ±2-3 pts). This converts "we think it's close" into a measured number, permanently.

### Q3 — Remaining gap (acknowledged, not solved without paid SR)
1. Official live POT/SCP/paint — we get approximations with measured error bars instead
2. SR native per-quarter team splits (78 fields/period) — reconstructed from boundaries instead
3. fouls_drawn, time_leading, official rim/midrange splits live
4. Live in-game advanced ratings (BDL's are post-game only)
5. Source redundancy: ESPN becomes the single live structural source (SR was the hedge); mitigated by BDL box cross-checks

### SR's reduced role
Schedule/game IDs (system key) + pregame context + nightly post-game validation ONLY. Standings -> BDL. Injuries -> optionally BDL. Zero live polling.

### Sequencing implication (one program, spec pending Manny's go)
1. Plumb ESPN structural fields (+ BDL plus_minus) into modelSummary — biggest win, near-zero new fetches
2. Rebuild PBP POT/SCP as possession-state machine
3. Stand up nightly SR validation harness
4. Retrain WNBA XGB on corrected features + BDL season priors (four_factors/clutch/zones)
5. Accept/reject vs the line-paired OOS bar (edge test #1 standard)

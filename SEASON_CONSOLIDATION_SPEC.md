# SEASON_CONSOLIDATION_SPEC v1

**Status:** Phase 1 SHIPPED (this commit). Phase 2 queued.
**Date:** 2026-10-19 (PM go: Manny, "consolidate is the right solve").

## Problem

The season was a hardcoded literal in 13 files / 55 sites in three formats
(`'2025'`, `'2025-26'`, `2025`), nothing derived it, and nothing handled the
empty weeks after a season boundary. Flipping the literal on opening night
reproduces the June `Floor: ? ? ?` failure (SR current-season stats null →
`computePreGameFloor` null). The WNBA proxy literal had been wrong since June.

## 1. Single source — `netlify/lib/season.js`

Pure CJS, no deps, outside `netlify/functions/` so Netlify never discovers it as a
function; esbuild inlines it into every importer (verified locally with the same
bundler config before push).

- `seasonFor(league, date?)` → `'YYYY'` start-year. Rollover: NBA/NCAAMB Aug 1
  (split-year), WNBA Apr 1 (calendar-year, offseason keeps the finished season).
  Env override `DFT_SEASON_<LEAGUE>` is an emergency lever only.
- `priorSeason`, `seasonLabel` (`'2026-27'` for split-year tables, `'2026'` WNBA).
- `pickBaselineSeason(league, currentGP)` → `{season, source: current|prior, gp}`,
  bar `WARM_START_GP = 10` (inclusive).
- `seasonCandidates(league, labelFn)` → `[current, prior]`; `newestPerKey(rows, …)`.
- `gpFromSRStats`, `gpFromSRSplits`, `srBaselinePaths`, `baselineLine`.

Consistency check (log-only): the 4am schedule fetch logs `WARN season mismatch`
if SR `game.season.year` ≠ derived.

## 2. Warm-start policy — the class decides, not the call site

| Class | Rule | Feeds |
|---|---|---|
| BASELINES | current if team GP ≥ 10 else prior, always stamped `{season, source}` | BDL player season averages (MC rates, 3PT baselines, sustainability personnel), BDL shotdashboard, BDL clutch (bdl-enrich), SR statistics + splits (pregame-agent, generate-thesis, sr-data proxy), `clutch_profiles` read |
| RECORDS / ROSTERS | current only; 0-0 is truth | SR/BDL standings, SR depth charts, injuries, lineups |
| ARTIFACTS | newest row ≤ current wins | `floor_wp_coefficients`, `wp_profiles` |

Any prompt that received a prior-season baseline carries one pinned line:
`BASELINE SEASON: 2025-26 (prior season) for DET 0 GP … below the 10-GP warm-start bar.`
Writes stamp the season of the DATA, never today's date. Mixed seasons across the
two teams in one game are allowed; the step at GP 10 is per team.

## 3. What shipped (Phase 1)

- `poll-live-bdl.mjs`: `LEAGUES.*.season` removed; `bdlSeasonStatsNBA` rewritten
  (fixes the latent "5th game of the season" recent-game bug — `per_page=5` with no
  date bound returned a FUTURE game for the first week of every season); per-team
  warm-start with a 1-call daily GP re-check for warm-started teams; cache rows
  keyed by the data's season; `fetchTrackingData` per-team warm-start + pinned
  prompt line; floor_wp/clutch reads newest-≤-current / GP-aware; clutch write
  stamps the current season; schedule-season WARN.
- `sr-data.js`: derived season, `&season=` override, proxy-side warm-start for
  `statistics` / `splits_game` / `splits_schedule` with `_dft_baseline` stamped on
  the JSON (carried through NCAAMB normalization).
- `bdl-data.js`, `db-api.js` (11 defaults; `get_season_cache`, `get_floor_wp`,
  `get_wp_profiles`, `get_clutch_profiles` resolve newest-≤-current / warm-start
  when no season is given), `bdl-enrich.js` (per-team warm-start via BDL games),
  `pregame-agent.mjs` + `generate-thesis.mjs` (stats/splits warm-start on
  `own_record.total.games_played`; depth stays current; `=== BASELINE SEASON ===`
  pinned; manual ⚡ path composes the line from the proxy's picks),
  `post-game-agent.mjs`, `odds-squeeze.mjs`, `team-profiles-nightly.mjs`.
- `backtest-nba-snapshots.mjs`: `populate_floor_wp` now REQUIRES `?season=YYYY-YY`
  — a backtest labels by its data, never by today.
- Clients (`bdl`, `v3`, `ncaamb-bdl`, `wnba-bdl`, `debug`): every season literal
  removed; explicit `season=` still honored for viewing a past season.
- DDL `DEFAULT '2025…'` clauses dropped (every writer passes season explicitly;
  `CREATE TABLE IF NOT EXISTS` makes this text-only in prod).

## 4. Tests

- `research/season_fixtures.mjs` — 57 pins + the **literal lint**: any `'20xx'` /
  `'20xx-yy'` / `season=20xx` / `|| 20xx` in 21 production files fails the harness
  (`// season-lint: allow` opts a line out). The bug class is now a failing test.
- Pre-push gate: `node --check` every touched file + every dashboard's extracted
  script; all standing harnesses green (squeeze 77, decision-support 124, verdict
  42, narration 67, parity 30, team_profiles 51, availability 35, fine arena 19,
  ops 35, tier B/C 81, season26 35, matchup 36, team_ctx_client 10, season 57,
  build_ss_struct OK). `team_ctx_fixtures` 28/30 is PRE-EXISTING on `c0d33b8`.
- esbuild bundle of all 11 importers with Netlify's bundler settings; bundled
  `sr-data`/`bdl-data`/`bdl-enrich` executed as a runtime smoke (bdl-enrich
  produced a real DET/BOS warm-start from 2025 with live eFGs).

## 5. Phase 2 (queued)

`season_baselines (league, season, team_alias, kind, payload_json, games_played,
updated_at)` — one cache for SR stats/splits, BDL shotdashboard, BDL clutch.
Prior-season rows never expire (immutable); current rows TTL 20h. Kills the
warm-start double-fetch and cuts pregame SR spend from ~12 calls/game to ~6.

## 6. Debt noted, not touched

- `generate-thesis.mjs` still duplicates ~200 lines of pregame-agent's SR fetch
  (v3.0 split); the lib removed only the season part. The warm-start orchestration
  (~15 lines) is duplicated in both agents by the same pattern.
- `bdlSeasonStatsNCAAMB` is now an alias of `bdlSeasonStatsBatch` (serves WNBA too).

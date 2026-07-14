# TEAM_PROFILES — team identity, tier splits, form, H2H (nightly)

**Date:** 2026-07-13 · **Amended:** 2026-07-14 (fixture-adjudicated: strict tier cutoff,
aggregate eFG + fgm/fga primitives, OREB provenance tolerance — see §2a) · **Status:** SHIPPED v1
(nightly + backfill; consumption/injection §6-§7 pending) (RE-DERIVED — original written 2026-07-04,
lost to the expired read-only PAT; recovered from chat history Jul 13 and extended with
§7 narration-v2 integration) · **Companion:** SWEETSPOT_NARRATION_V2_SPEC.md

## 1. Purpose

Systematize the team-specific knowledge class that produced the Atlanta read (Jul 4):
identity (which levers a team wins on), opponent-quality tier splits, recent form vs
baseline, H2H, and schedule context — computed nightly from BDL data and injected into
every agent prompt and notification. Non-gating in v1: context for Opus/Fable and Manny,
never a mechanical veto, pending backtest validation.

## 2. Golden fixture (Atlanta, session-derived Jul 4)

ATL = POSSESSION_BULLY: wins on possession volume (TO margin +3.5, FTA +4.8, OREB +4.9)
while losing shot quality (eFG diff −5.2). vs top tier (≥.600): 1-6, eFG −11.1, TO
margin collapses to +1.3 (n=7). vs rest: 11-3 (n=14). Form L5: 0-5, own eFG −8.0 vs
baseline (COLD), opp eFG +6.1 (OPPONENTS_HOT). H2H vs GS: 0-3 (avg −6.3). These exact
numbers are the fixture the nightly compute must reproduce from `team_game_stats`.

## 3. Tables

### 3a. `team_game_stats` — one row per team per finalized game

```sql
CREATE TABLE IF NOT EXISTS team_game_stats (
  game_id    TEXT NOT NULL,      -- BDL game id
  team_alias TEXT NOT NULL,
  league     TEXT NOT NULL,
  season     INT  NOT NULL,
  date       TEXT,
  opp_alias  TEXT,
  is_home    BOOLEAN,
  pts INT, opp_pts INT,
  efg REAL, opp_efg REAL,
  to_ct INT, opp_to_ct INT,
  fta INT, opp_fta INT,
  oreb INT, opp_oreb INT,
  fg3m INT, fg3a INT, opp_fg3m INT, opp_fg3a INT,
  fgm INT, fga INT, opp_fgm INT, opp_fga INT,   -- §2a: aggregate-eFG primitives
  poss REAL,                -- estimated possessions (FGA − OREB + TO + 0.44·FTA); stored NOW so the
                            -- v2 per-possession refinement is a recompute, not a re-ingestion
  dft_game_id TEXT,         -- nullable join key to internal games.id via date+alias match at
                            -- ingestion — required for the kNN reference-class substrate claim
  PRIMARY KEY (game_id, team_alias)
);
```

Substrate value beyond profiles: future reference-class work (kNN detector backlog — the
`dft_game_id` join key is what makes this claim real) and season-boundary-safe by
construction.

**Alias discipline (canonical rule):** all aliases in these tables are BDL-canonical
(LV, NY, GS, WSH, LA, POR, TOR — not SR's LVA/NYL/GSV/WAS/LAS/PDX/TOY). `cfg.aliasMap`
applies ONLY where SR-sourced data enters, never here. H2H keys, poll-side Map lookups,
and composeTeamContext matching all assume BDL form — the aliasMap regression (WNBA fix
breaking NBA PBP) is the standing lesson on what silent alias mixing does.

### 3b. `team_profiles` — computed nightly, one row per team-season (recovered verbatim)

```sql
CREATE TABLE IF NOT EXISTS team_profiles (
  team_alias TEXT NOT NULL,
  league     TEXT NOT NULL,
  season     INT  NOT NULL,
  w INT, l INT,
  archetype  TEXT,
  profile    JSONB,          -- everything else (see §5)
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (team_alias, league, season)
);
```

JSONB body: metric set will iterate; avoids migration churn (raw_stats_json/sust_json
precedent). Scalars top-level: record + archetype (queryable).

## 4. Nightly compute — `team-profiles-nightly.mjs` (~280-340 lines, WNBA-only v1)

`export const config = { schedule: "30 8 * * *" };` — 1:30am MST, after WNBA finals
settle (post-game-agent cron pattern). Flow per league:

1. **Discover** finalized games missing from `team_game_stats`: BDL `/games` trailing
   4-day window, `status='post'` nonzero scores, diff against existing game_ids.
   Self-healing — a missed night is picked up next run.
2. **Pull** missing games via `/wnba/v1/player_stats?game_ids[]=…` (batched,
   cursor-paginated — proven Jul 4: 21 games → 502 rows over ~6 pages). Aggregate player
   rows → team-game lines. All math `Number()`-wrapped (BDL strings). BDL scores are
   `home_score`/`away_score` — resolve home/away identity before team-side stats. DFT
   internal WNBA game ids do NOT map to BDL ids — discovery goes through dates.
3. **INSERT** rows (`ON CONFLICT DO NOTHING`).
4. **Recompute all profiles** for the league-season in memory (~300 rows — trivial),
   UPSERT `team_profiles`. Full recompute nightly is deliberate: opponent win% moves,
   retroactively re-tiering past games (best current estimate of opponent quality).
5. ntfy one-liner (ASCII Title): `team-profiles: wnba 15 teams updated, N games ingested`.

**Modes:** default incremental · `?reingest=1` (backfill w/ ON CONFLICT DO UPDATE —
schema-amendment migrations) · `?backfill=1&from=&to=` (season-to-date ≈150 games ≈
30-40 API calls, single invocation OK for WNBA) · `?recompute=1` (skip ingestion) ·
`?dry=1` (no writes). **Concurrency:** DB lock row (PENDING sentinel) before ingestion —
hotfix learning #11.

## 5. Derived metrics (`profile` JSONB — recovered verbatim) + archetypes

```jsonc
{
  "identity": { "g","ppg","opp_ppg","margin_pg","efg","opp_efg","efg_diff",
                "to_pg","opp_to_pg","to_margin","fta_diff","oreb_diff",
                "fg3_pct","opp_fg3_pct" },
  "tiers":    { "cutoff": 0.600,
                "top":  { "n","w","l","efg_diff","to_margin","fta_diff","ppg","opp_ppg" },
                "rest": { … } },            // INSUFFICIENT until every team has ≥8 finals
  "form":     { "l5":  { "w","l","own_efg_delta","opp_efg_delta","margin_delta",
                         "own_tag","opp_tag" },   // tags COLD/HOT at ±4.0pp
                "l10": { … } },             // deltas vs season-EXCLUDING-window
  "h2h":      { "GS": { "w","l","avg_margin" }, … },   // this season, per opponent
  "schedule": { "last_game_date", "road_streak" }
}
```

Rest days / B2B computed at consumption time (`today − last_game_date`), not stored.

**Archetype rules (v1 heuristic, mechanical):** lever thresholds eFG diff ±1.5pp · TO
margin ±2.0 · FTA ±3.0 · OREB ±1.5. DUAL_EDGE (eFG≥+1.5 AND TO≥+2.0) · SHOTMAKER
(eFG≥+2.0, TO<+2.0) · POSSESSION_BULLY (TO≥+2.5 AND eFG≤−1.0 — ATL) · POSSESSION_LEAN
(TO≥+2.0, eFG −1.0..+1.5) · SHOT_DEFICIT (eFG≤−2.0, TO<+2.0) · FLAT. Label is push
compression; prompts always get the underlying numbers so a wrong label can't mislead.

## 6. Consumption (recovered)

- **db-api:** `?action=get_team_profiles&league=wnba[&team=ATL]` (+~40 lines, mirrors
  get_clutch_profiles).
- **Poll-side:** one isolated SELECT per league cycle (15 rows) into a module Map —
  critical-path rule compliant (clutch_profiles precedent).
- **`composeTeamContext(pHome,pAway,gameCtx)`** (+~60 lines inline): ~150-220-token
  factual block, header `TEAM CONTEXT (season priors — context only, small-n: treat
  splits as direction, not probabilities)`. Degradation: missing row → omit team line;
  both missing → omit block; `updated_at` > 36h → append staleness note.
- **Injection points (4):** alert reasoning agent prompt · formatSonnetPrompt (both call
  sites) · Sweet Spot Stage-2 narration (§7) · one plain-English line in mechanical ntfy
  bodies.
- **Flag:** `TEAM_CTX_ON=1` + diag mode.

## 7. Narration-v2 integration (NEW — supersedes NARRATION_V2 §7 "empty hook")

The narration prompt's `TEAM CONTEXT` section is populated by `composeTeamContext`
output from day one. Build order: profiles nightly + backfill ship FIRST (one backfill
invocation seeds the season), then narration v2 wires the live section. Narration v2
still degrades gracefully (section omitted) if profiles are stale/missing — no hard
dependency either direction. For the narration specifically, H2H and form earn priority
placement: "MIN erased a halftime deficit against PHX in June" is the compelling
sentence the Jul 13 narration couldn't write.

## 8. Settled decisions (original D1-D5, recs adopted — PM may override)

Tier cutoff .600 · mechanical pushes get ONE plain-English profile line · form displays
L5 (L10 stored) · dual-table architecture · H2H current season only.

## 9. Testing & rollout

Backfill dry-run → ATL golden fixture must reproduce §2 numbers exactly → backfill live
→ nightly cron observed one night → TEAM_CTX_ON=1 → injection verified in agent logs →
narration v2 section activates. Fixture file: `research/team_profiles_fixtures.mjs`
(archetype rules table-driven + ATL numbers).

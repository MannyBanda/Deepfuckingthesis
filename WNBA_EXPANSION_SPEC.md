# WNBA Expansion Spec — LEAGUE Config + Odds Infrastructure

**Date:** April 15, 2026
**Status:** Validated — all endpoints confirmed working
**Preseason tip:** ~April 25, 2026 (10 days)

---

## 1. LEAGUES Config Block

```javascript
wnba: {
  srBase: 'https://api.sportradar.com/wnba/trial/v8/en/',
  srKeyEnv: 'SR_API_KEY',              // same key covers NBA + WNBA
  espnSlug: 'wnba',
  espnBase: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/',
  espnSummaryBase: 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/wnba/summary',
  bdlPrefix: '/wnba',
  bdlHasSeasonStats: true,
  bdlHasBoxScores: false,              // NEW FLAG — uses player_stats + team_stats instead
  bdlHasOdds: false,                   // NEW FLAG — ready to flip when source available
  oddsSource: null,                    // null | 'bdl' | 'espn' | 'external' — hydration target
  season: '2026',
  quarterMinutes: 10,                  // NBA: 12, WNBA: 10
  shotClock: 30,                       // NBA: 24, WNBA: 30
  foulLimit: 6,                        // NBA: 6, NCAAMB: 5
  periodType: 'quarter',               // NBA: quarter, NCAAMB: half
  sznDefault3Pct: 33,                  // season 3PT% default (NBA: 36, NCAAMB: 33)
  twoPointBaseline: 0.46,             // 2PT% baseline for COLD tier + TP structRate (NBA: 0.52, NCAAMB: 0.49) — TBD from 2025 data
  vtThreshold3PA: 28,                  // volume threat projected 3PA (NBA: 34) — scaled for 10-min quarters
  aliasMap: {                          // SR alias → BDL abbreviation
    NYL: 'NY', WAS: 'WSH', LVA: 'LV', CON: 'CT',
    ATL: 'ATL', IND: 'IND', CHI: 'CHI', MIN: 'MIN',
    PHX: 'PHX', SEA: 'SEA', DAL: 'DAL', LAS: 'LA',
    PDX: 'POR', TOY: 'TOR', GSV: 'GSV',
  },
  // Filter out non-game entities from SR teams list
  srTeamFilter: (team) => !team.name?.includes('National Team') && team.market !== 'Team',
},
```

### Constants Rationale

| Constant | NBA | NCAAMB | WNBA | Reasoning |
|----------|-----|--------|------|-----------|
| `sznDefault3Pct` | 36% | 33% | 33% | WNBA 2025 league avg ~33.4% (MIN led at 37.8%) |
| `twoPointBaseline` | 0.52 | 0.49 | 0.46 | WNBA 2025: MIN 47.2% FG overall, lower 2PT conversion. Need early-season calibration — placeholder 0.46 |
| `vtThreshold3PA` | 34 | 34 | 28 | 10-min quarters = ~83% of NBA possessions. 34 × 0.83 ≈ 28 |
| `quarterMinutes` | 12 | 20 | 10 | Per WNBA rules |
| `shotClock` | 24 | 30 | 30 | Per WNBA rules |

**TBD after first week:** `twoPointBaseline` needs real 2025 2PT% data to calibrate. Currently estimated from overall FG% minus 3PT contribution.

---

## 2. Odds Infrastructure — Ready to Hydrate

### 2a. `bdlOdds()` in poll-live-bdl.mjs

Current code has hardcoded league paths. Refactor to use config flags:

```javascript
async function bdlOdds(league, bdlGameId) {
  const cfg = LEAGUES[league];
  
  // If league doesn't have BDL odds, try alternate source
  if (cfg.bdlHasOdds === false) {
    return fetchOddsAlternate(league, bdlGameId, cfg);
  }
  
  // Existing BDL path
  let path;
  if (league === 'nba') {
    path = `/nba/v2/odds?game_ids[]=${bdlGameId}`;
  } else {
    path = `${cfg.bdlPrefix}/v1/odds?game_ids[]=${bdlGameId}`;
  }
  // ... rest unchanged
}
```

### 2b. `fetchOddsAlternate()` — Hydration Point

New function that returns `null` today but has the interface ready:

```javascript
async function fetchOddsAlternate(league, bdlGameId, cfg) {
  const source = cfg.oddsSource;
  
  if (source === 'espn') {
    // ESPN scoreboard odds — extract from competition.odds[]
    // Shape: { homeSpread, homeML, awayML, total }
    // TODO: wire when ESPN WNBA scoreboard includes odds in regular season
    return null;
  }
  
  if (source === 'external') {
    // External odds API (e.g., the-odds-api.com)
    // TODO: wire with API key in env var
    return null;
  }
  
  // No source configured — return null gracefully
  // All downstream code already handles null odds:
  //   - ctrlEdge stays null → BWC edge gate skipped (DEVELOPING path)
  //   - ctrlML stays null → ML gate skipped (no suppression)
  //   - MIP not computed → no market-implied probability in context
  //   - odds_history not saved (no data)
  //   - Sonnet prompt shows "N/A" for spread/ML
  return null;
}
```

### 2c. Downstream Null-Safety Audit

Every odds consumer already handles `null` correctly:

| Location | Behavior when odds = null |
|----------|--------------------------|
| `computeServerContext()` MIP block | Skipped — `ctx.mip` not set |
| BWC edge gate (`ctrlEdge`) | `ctrlEdge` stays null → edge check skipped, BWC fires on floor + lead only |
| BUY ML gate (`ctrlML`) | `ctrlML` null → ML gate skipped (no -250 suppression) |
| CANDIDATE ML gate | Same — no ML filtering |
| `formatSonnetPrompt()` MARKET line | Shows "N/A" for all odds fields |
| `odds_history` INSERT | Block gated on `odds` truthiness — skipped |
| Alert agent context | `Edge: N/A | ML: N/A | Spread: N/A` — Sonnet handles gracefully |
| `bdl-enrich.js` client odds | Already returns `oddsPath = null` for WNBA |
| `tp_ratio` column | Calculated from structural data, not odds — unaffected |

**Key implication:** Without odds, the ML gate (-250) doesn't fire. This means WNBA alerts won't suppress heavy favorites. That's acceptable for launch — we'll manually monitor and add the gate once odds are wired.

### 2d. When Odds Source is Found — Hydration Steps

1. Set `LEAGUES.wnba.oddsSource` to `'espn'` or `'external'`
2. Implement the corresponding branch in `fetchOddsAlternate()`
3. Return `{ homeSpread, homeML, awayML, total }` — same shape as `bdlOdds()`
4. Everything downstream just works — edge calc, ML gate, MIP, alert agent context, Sonnet prompt

---

## 3. BDL Data Fetch Adaptation

### 3a. New Flag: `bdlHasBoxScores`

WNBA doesn't have `/box_scores`. The poll loop and enrichment need to use `player_stats` + `team_stats` instead.

The main poll loop already uses SR game summary as the primary data source for live indicators — BDL box scores are only used for:
- Post-game enrichment (`game_pbp.box_score_json`)
- Diagnostic endpoints
- Season cache building

For **live polling**, no change needed — SR game summary is the engine.

For **post-game enrichment** and **diagnostics**, add a WNBA-aware fetch:

```javascript
async function bdlBoxScoreWNBA(league, bdlGameId) {
  const cfg = LEAGUES[league];
  // Fetch player_stats + team_stats separately, merge into box_score shape
  const [playerResp, teamResp] = await Promise.all([
    bdlFetch(`${cfg.bdlPrefix}/v1/player_stats?game_ids[]=${bdlGameId}&per_page=100`),
    bdlFetch(`${cfg.bdlPrefix}/v1/team_stats?game_ids[]=${bdlGameId}`),
  ]);
  
  if (!playerResp?.data || !teamResp?.data) return null;
  
  // Merge into the shape computeServer/enrichment expects
  return {
    players: playerResp.data,
    teams: teamResp.data,
    // Map to match NBA box_scores shape where needed
  };
}
```

### 3b. Season Stats

WNBA uses the batch endpoint like NCAAMB:
```
/wnba/v1/player_season_stats?season=2026&team_id={id}&per_page=100
```
`bdlSeasonStatsNCAAMB()` already handles this pattern. Just needs the league routing:

```javascript
// In season cache logic:
if (league === 'nba') {
  // per-player fetch
} else {
  // batch endpoint — works for both NCAAMB and WNBA
  await bdlSeasonStatsNCAAMB(league, bdlTeamId, season);
}
```

---

## 4. SR Team Filtering

SR WNBA teams list includes non-game entities that must be filtered:

**All-Star teams:** Team Clark (CLK), Team Collier (COL), Team Delle Donne (EDD), Team Parker (CNP) — `market === 'Team'`

**National teams:** Puerto Rico (PUR), Brazil (BRA), Japan (JNT), China (CHN), Nigeria (NGR) — `name === 'National Team'`

The `srTeamFilter` function on the LEAGUE config handles this:
```javascript
srTeamFilter: (team) => !team.name?.includes('National Team') && team.market !== 'Team'
```

Applied when building SR team lookups for schedule matching and game ID resolution.

---

## 5. ESPN WP — Already Works

Validation confirmed:
- Scoreboard: `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard` → 200
- Win Probability: `https://sports.core.api.espn.com/v2/sports/basketball/leagues/wnba/events/{id}/competitions/{id}/probabilities` → 200, returns `homeWinPercentage`

The existing `espnWinProb()` function uses `cfg.espnSummaryBase` which we set to the WNBA URL. **Zero code changes needed** — just config.

---

## 6. Env Var Changes

| Var | Action | Notes |
|-----|--------|-------|
| `SR_API_KEY` | No change | Same key covers NBA + WNBA (confirmed) |
| `SR_WNBA_KEY` | Not needed yet | Only if SR separates keys per league |
| `BDL_API_KEY` | No change | Same key, GOAT tier now covers WNBA |

---

## 7. Alias Mapping Detail

| SR Alias | BDL Abbr | Team |
|----------|----------|------|
| NYL | NY | New York Liberty |
| WAS | WSH | Washington Mystics |
| LVA | LV | Las Vegas Aces |
| CON | CT | Connecticut Sun |
| ATL | ATL | Atlanta Dream |
| IND | IND | Indiana Fever |
| CHI | CHI | Chicago Sky |
| MIN | MIN | Minnesota Lynx |
| PHX | PHX | Phoenix Mercury |
| SEA | SEA | Seattle Storm |
| DAL | DAL | Dallas Wings |
| LAS | LA | Los Angeles Sparks |
| PDX | POR | Portland Fire (2026 expansion) |
| TOY | TOR | Toyota Antelopes (2026 expansion) |
| GSV | GSV | Golden State Valkyries (2026 expansion) |

**Note:** Expansion team BDL abbreviations (POR, TOR, GSV) confirmed from SR teams list. The BDL teams endpoint returned 33 teams (includes defunct franchises like Houston Comets). Active team filtering needed.

---

## 8. Backtest Endpoint — Indicator Validation

### Purpose

Validate whether NBA-calibrated I1-I5 weights and conviction combos hold for WNBA before enabling live alerts. Uses BDL as primary data source (GOAT tier, 60 calls/s) with targeted SR sampling for full indicator validation.

### Architecture: BDL-Primary, SR-Targeted

**Phase 1 — BDL bulk collection (fast, unlimited):**
- Pull all 2025 WNBA games via `/wnba/v1/games?seasons[]=2025` (paginate, ~300 games)
- For each completed game, fetch `/wnba/v1/team_stats?game_ids[]={id}` (both teams' basic box score)
- Cache game outcomes (winner, final score, margin) + basic stats
- All at 60 calls/s — full season in under 30 seconds

**Phase 2 — SR targeted sample (slow, cached):**
- Select ~50 games stratified by margin type: blowouts (15+), comfortable (8-14), close (1-7), OT
- Fetch SR game summary for each (`games/{id}/summary.json`) at 1 call/s — under 1 minute
- Cache full SR responses in DB or JSONB so we never re-fetch
- These provide the fields BDL lacks: possessions, points_in_paint, fast_break_pts, second_chance_pts, points_off_turnovers, biggest_lead, bench_points, per-period stats, on_court

**Phase 3 — Compute + validate:**
- Run `computeServer()` against each cached SR game summary
- Compare I1-I5 scores, conviction tiers, and indicator combos against known outcomes
- Produce accuracy report by indicator and combo

### BDL-Only Indicator Coverage

| Indicator | BDL Coverage | Missing Fields |
|-----------|-------------|----------------|
| I1 Possession & Transition | Partial | points_off_turnovers, second_chance_pts, fast_break_pts |
| I2 Rim Pressure & Foul | Partial | points_in_paint (att/made), bonus status |
| I3 Shot Quality & Creation | **Full** | — |
| I4 Lineup Integrity | None | biggest_lead, bench_points, per-period pls_min |
| I5 Tempo & Efficiency | None | possessions, pace, off/def points_per_possession |

I3 can be fully validated from BDL alone across all ~300 games. I1 and I2 get partial validation. I4 and I5 require the SR sample.

### Endpoint: `/.netlify/functions/backtest-wnba`

```
GET  ?phase=collect    — Phase 1: BDL bulk game + stats collection, cache to DB
GET  ?phase=sample     — Phase 2: SR targeted sample (50 games), cache to DB  
GET  ?phase=compute    — Phase 3: Run computeServer on cached data, produce report
GET  ?phase=report     — Return latest validation report
```

### Validation Report Shape

```json
{
  "gamesAnalyzed": 50,
  "source": "sr_cached",
  "indicators": {
    "I1": { "winCorrelation": 0.81, "avgWinnerScore": 0.72, "avgLoserScore": 0.38 },
    "I2": { "winCorrelation": 0.77, "avgWinnerScore": 0.68, "avgLoserScore": 0.41 },
    "I3": { "winCorrelation": 0.74, "avgWinnerScore": 0.65, "avgLoserScore": 0.43 },
    "I4": { "winCorrelation": 0.96, "avgWinnerScore": 0.82, "avgLoserScore": 0.22 },
    "I5": { "winCorrelation": 0.69, "avgWinnerScore": 0.61, "avgLoserScore": 0.44 }
  },
  "convictionAccuracy": {
    "DOMINANT": { "games": 8, "wins": 8, "pct": 100 },
    "STRONG": { "games": 12, "wins": 11, "pct": 91.7 },
    "MODEST": { "games": 15, "wins": 11, "pct": 73.3 },
    "CONDITIONAL": { "games": 10, "wins": 5, "pct": 50 },
    "NO_ENTRY": { "games": 5, "wins": 2, "pct": 40 }
  },
  "comboPatterns": {
    "I4+I5": { "games": 6, "wins": 6, "pct": 100 },
    "I3+I4": { "games": 8, "wins": 8, "pct": 100 },
    "I3+I5": { "games": 5, "wins": 5, "pct": 100 },
    "I1+I5": { "games": 4, "wins": 2, "pct": 50 },
    "I1+I2+I5": { "games": 3, "wins": 1, "pct": 33 }
  },
  "recommendations": [
    "I4 win correlation 0.96 — consistent with NBA (0.98). Keep weight at 30%.",
    "I5 win correlation 0.69 — lower than NBA (0.78). Consider reducing weight from 25% to 20%.",
    "I3+I5 combo 100% — may be small sample. Expand SR sample to validate."
  ]
}
```

### DB Cache Table

```sql
CREATE TABLE IF NOT EXISTS wnba_backtest (
  game_id TEXT PRIMARY KEY,
  bdl_game_id INTEGER,
  date TEXT,
  home_alias TEXT,
  away_alias TEXT,
  home_score INTEGER,
  away_score INTEGER,
  winner TEXT,
  margin INTEGER,
  bdl_stats JSONB,          -- BDL team_stats for both teams
  sr_summary JSONB,         -- Full SR game summary (null until Phase 2)
  indicators JSONB,         -- computeServer output
  conviction_tier TEXT,
  conviction_combo TEXT,
  computed_at TIMESTAMPTZ
);
```

### Key Questions the Backtest Answers

1. **Does I4 (biggest_lead + live scoring diff) predict WNBA winners at 98% like NBA?** If not, I4's 30% weight needs adjustment.
2. **Does the I4+I5 combo still = 100%?** This is the DOMINANT conviction anchor.
3. **Are the danger combos (I1+I5, I1+I2+I5) still dangerous?** These have 40-50% win rates in NBA — if they're higher in WNBA, we might upgrade them.
4. **Is I5 (tempo/efficiency) less predictive with a 30-sec shot clock?** Longer shot clock = more deliberate possessions = different tempo dynamics.
5. **Does the 2PT baseline (0.46 placeholder) produce correct COLD tier classifications?**

### Implementation Order

1. Build `backtest-wnba.mjs` with Phase 1 (BDL collection)
2. Add `wnba_backtest` table via init endpoint
3. Run Phase 1 — collect all 2025 games + stats
4. Build Phase 2 (SR sampling) + Phase 3 (compute)
5. Run Phases 2-3, review report
6. Adjust WNBA weights/thresholds based on findings
7. Then enable live polling with calibrated weights

---

## 9. Implementation Order (Updated)

1. Add WNBA to LEAGUES config in `poll-live-bdl.mjs`
2. Refactor `bdlOdds()` → add `fetchOddsAlternate()` stub
3. Add `bdlHasBoxScores` / `bdlHasOdds` flags, wire into existing conditionals
4. Update `bdl-enrich.js` odds path to use config flag instead of hardcoded league check
5. Add SR team filter for non-game entities
6. Alias mapping
7. Add `SR_WNBA_KEY` env var to Netlify (maps to same key for now)
8. **Build backtest endpoint (`backtest-wnba.mjs`)**
9. **Run backtest Phases 1-3, produce validation report**
10. **Tune weights/thresholds based on backtest findings**
11. Test against 2025 completed game data via SR game summary
12. Build WNBA dashboard (`wnba-bdl.html`)
13. Enable live polling with DRY_RUN
14. Calibrate during preseason, go live for regular season
15. Clean up temp functions (`validate-wnba.mjs`, `backtest-wnba.mjs`)

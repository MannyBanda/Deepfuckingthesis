# WNBA Expansion Spec — Validated Framework

**Date:** April 15, 2026
**Status:** VALIDATED — 203-game backtest (2025 season), 88.7% overall accuracy
**Preseason tip:** ~April 25, 2026 (10 days)

---

## 0. Backtest Results (203 games, natural distribution)

### Overall: 88.7% (180/203)

| Tier | Games | Wins | Accuracy | NBA Reference |
|------|-------|------|----------|---------------|
| DOMINANT | 100 | 99 | 99.0% | 100% |
| STRONG | 44 | 43 | 97.7% | 97% |
| MODEST | 35 | 27 | 77.1% | 75% |
| CONDITIONAL | 24 | 11 | 45.8% | ~50% |

### Killer Combos

| Combo | Games | Wins | Accuracy | NBA Reference |
|-------|-------|------|----------|---------------|
| I3+I4 | 106 | 105 | 99.1% | I4+I5: 100% |
| I4+I5 | 65 | 64 | 98.5% | I3+I4: 99% |
| I3+I5 | 75 | 73 | 97.3% | I3+I5: 96% |

### By Margin Bucket

| Bucket | Games | Wins | Accuracy |
|--------|-------|------|----------|
| Blowout (15+) | 63 | 63 | 100% |
| Comfortable (8-14) | 61 | 57 | 93.4% |
| Close (1-7) | 79 | 60 | 75.9% |

### Per-Indicator Win Correlation

| Indicator | Winner Won | Winner Lost | Even | Correlation | When it fires (non-EVEN) |
|-----------|-----------|-------------|------|-------------|--------------------------|
| I3 Shot Quality | 144 | 25 | 34 | 0.709 | 85.2% (144/169) |
| I4 Game Control | 134 | 9 | 60 | 0.660 | 93.7% (134/143) |
| I1 Disruption | 112 | 48 | 43 | 0.552 | 70.0% (112/160) |
| I5 Momentum | 102 | 33 | 68 | 0.502 | 75.6% (102/135) |
| I2 Perimeter+FT | 95 | 19 | 89 | 0.468 | 83.3% (95/114) |

### Key Insight: WNBA is a Shot Quality League, Not an Interior Control League

From the 126-game explore analysis:
- **eFG diff (76.8%)**, assists (76.7%), TS% (76.2%), biggest_lead (76%) — top predictors
- **Paint diff (55.9%)**, rim made (51.8%) — barely above noise
- **Turnovers are INVERSE (41.2%)** — winners turn it over MORE (aggressive play)
- **Personal fouls are INVERSE (37.6%)** — winners foul MORE (aggressive defense)

---

## 1. WNBA Indicator Framework

### I1 — Disruption & Conversion (Weight: 15%)
- Sub-A: disruption combined (steals + blocks diff), threshold ±2
- Sub-B: points off turnovers diff, threshold ±3
- **NO raw turnovers** — inverse in WNBA

### I2 — Perimeter & FT Access (Weight: 20%)
- Sub-A: 3PT% diff, threshold ±3%
- Sub-B: FTA diff, threshold ±2
- **Replaces NBA's Interior Control** — paint/rim are noise in WNBA

### I3 — Shot Quality (Weight: 30% — WNBA ANCHOR)
- Sub-A: eFG diff, threshold ±0.03
- Sub-B: assists diff, threshold ±2
- **Heaviest weight** — eFG is most predictive single stat (76.8%)

### I4 — Game Control (Weight: 25%)
- Sub-A: biggest_lead diff, threshold ±4
- Sub-B: last quarter scoring diff, threshold ±2
- **Same structure as NBA** — game control transfers across leagues

### I5 — Momentum (Weight: 10%)
- Sub-A: fastbreak pts diff, threshold ±3
- Sub-B: total rebounds diff, threshold ±3
- **Different proxies from NBA** — needs PBP runs for live version

### Conviction Engine

- **DOMINANT:** 4+ indicators OR (I3+I4 pair AND 3+ indicators)
- **STRONG:** Any killer pair (I3+I4, I3+I2, I4+I2)
- **MODEST:** 2+ indicators, no killer pair, not danger combo
- **CONDITIONAL:** 1 indicator
- **NO ENTRY:** 0 indicators
- **Danger combo:** I1+I5 only (no I3, no I4) — 83.3% in WNBA vs 50% in NBA, monitor

### Weight Comparison

| Indicator | NBA Weight | WNBA Weight | Rationale |
|-----------|-----------|-------------|-----------|
| I1 | 10% | 15% | Disruption matters more in WNBA |
| I2 | 15% | 20% | Perimeter replaces paint |
| I3 | 20% | **30%** | Shot quality is the WNBA anchor |
| I4 | **30%** | 25% | Still strong but I3 takes the lead |
| I5 | 25% | 10% | Needs PBP runs, currently weakest signal |

---

## 2. LEAGUES Config Block

```javascript
wnba: {
  srBase: 'https://api.sportradar.com/wnba/trial/v8/en/',
  srKeyEnv: 'SR_WNBA_KEY',
  espnSlug: 'wnba',
  espnBase: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/',
  espnSummaryBase: 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/wnba/summary',
  bdlPrefix: '/wnba',
  bdlHasSeasonStats: true,
  bdlHasBoxScores: false,
  bdlHasOdds: false,
  oddsSource: null,
  season: '2026',
  quarterMinutes: 10,
  shotClock: 30,
  foulLimit: 6,
  periodType: 'quarter',
  sznDefault3Pct: 33,
  twoPointBaseline: 0.46,             // TBD — calibrate from 2026 preseason
  vtThreshold3PA: 28,
  aliasMap: {
    NYL: 'NY', WAS: 'WSH', LVA: 'LV', CON: 'CON',
    ATL: 'ATL', IND: 'IND', CHI: 'CHI', MIN: 'MIN',
    PHX: 'PHX', SEA: 'SEA', DAL: 'DAL', LAS: 'LA',
    PDX: 'POR', TOY: 'TOR', GSV: 'GS',
  },
  srTeamFilter: (team) => !team.name?.includes('National Team') && team.market !== 'Team',
},
```

---

## 3. Odds Infrastructure — Ready to Hydrate

- **BDL:** No WNBA odds. `/wnba/v1/odds` and `/wnba/v2/odds` both 404.
- **ESPN:** Scoreboard has no odds for WNBA. Win probability works.
- **Architecture:** `fetchOddsAlternate()` stub returns null. When source found, set `oddsSource`, implement branch, return `{ homeSpread, homeML, awayML, total }`.
- **Impact:** Without odds, ML gate (-250) dormant, BWC edge gate skipped, Sonnet receives N/A.

---

## 4. Data Sources — Validated

### BDL WNBA (GOAT tier)

Working: teams, games, players, active players, player_stats, team_stats, player_season_stats, team_season_stats, standings, injuries, plays.
Missing: box_scores (404), odds (404).

### SR WNBA (trial/v8)

Working: game summary (all I1-I5 fields), PBP, teams, schedule, standings, rankings, injuries, seasons.
Missing: depth chart, hierarchy (same gaps as NCAAMB).
Key env var: `SR_WNBA_KEY`. Trial tier: 1 req/sec, ~1000 calls per key.

### ESPN WNBA

Working: scoreboard, win probability.
Missing: odds (not in competition object).

---

## 5. Alias Mapping (Validated)

| SR | BDL | Team | Verified |
|----|-----|------|----------|
| NYL | NY | New York Liberty | ✅ |
| WAS | WSH | Washington Mystics | ✅ |
| LVA | LV | Las Vegas Aces | ✅ |
| CON | CON | Connecticut Sun | ✅ |
| LAS | LA | Los Angeles Sparks | ✅ |
| GSV | GS | Golden State Valkyries | ✅ |
| PDX | POR | Portland Fire (2026) | From SR |
| TOY | TOR | Toyota Antelopes (2026) | From SR |
| ATL, IND, CHI, MIN, PHX, SEA, DAL | (identity) | Same in both | ✅ |

SR teams list includes non-game entities: All-Star teams (CLA, COL, EDD, CNP) + National teams (PUR, BRA, JNT, CHN, NGR). Filter via `srTeamFilter`.

---

## 6. Env Vars

| Var | Action | Value |
|-----|--------|-------|
| `SR_WNBA_KEY` | **ADD** | `1nDh8uu5p5SunUs9hs3bjh0CcEPEr7JCF5cVVvUj` |
| `SR_API_KEY` | No change | NBA key |
| `BDL_API_KEY` | No change | GOAT tier covers WNBA |

---

## 7. Implementation Order

1. ~~Validate endpoints~~ ✅
2. ~~Build backtest~~ ✅
3. ~~Explore raw stat predictiveness~~ ✅
4. ~~Design WNBA indicators from data~~ ✅
5. ~~Validate on 203-game backtest~~ ✅ (88.7%, DOMINANT 99%)
6. Add WNBA to LEAGUES config (safe — additive)
7. Implement WNBA `computeServer` in poll function (league-branched)
8. Refactor `bdlOdds()` → `fetchOddsAlternate()` stub
9. Build WNBA dashboard (`wnba-bdl.html`)
10. Enable live polling DRY_RUN during preseason
11. Calibrate `twoPointBaseline` from 2026 data
12. Wire odds when source available
13. Go live for regular season
14. Clean up temp functions

---

## 8. Backtest Infrastructure

Files: `backtest-wnba.mjs`, `validate-wnba.mjs` (temp, delete after launch).
DB: `wnba_backtest` table (312 BDL games, 203 SR summaries).
Phases: init, reset, collect, sample, compute, report, explore, diagnose, status.

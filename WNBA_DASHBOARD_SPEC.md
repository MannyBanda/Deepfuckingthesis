# WNBA Dashboard Spec (`wnba-bdl.html`)
**Date:** May 8, 2026
**Source:** Fork from `v3.html` (3,950 lines)
**Approach:** Separate file — simpler first pass, avoids league-switching complexity in a 4K-line file

---

## Architectural Difference: Server-Snapshot-Only

The single biggest change from NBA v3. The NBA dashboard has two data paths:

| | NBA v3 | WNBA |
|---|--------|------|
| Live scores | BDL `box_scores` every 10s | Server snapshots (DB poll) |
| Indicators | Client-side `computeClientIndicators()` from BDL box score | Server snapshots (`i1`-`i5`, `floor_score`, `floor_team`) |
| XGB/MC | Server snapshots | Server snapshots (same) |
| ESPN WP | Direct ESPN fetch | Direct ESPN fetch (same, `league=wnba`) |

**Why:** BDL has no `box_scores` endpoint for WNBA (`bdlHasBoxScores: false`). The entire client-side indicator compute path (`computeClientIndicators`, `buildV3Summary`, BDL box score polling) is dead code for WNBA.

**Impact:** The WNBA dashboard is simpler — it's a pure server-snapshot viewer. The poll cycle becomes:
1. Fetch `get_latest_snapshots` for all game IDs → scores, indicators, floor, XGB, MC, TP/LS
2. Fetch `get_live_tracking` for live games → compound state, SHAP, checkpoints
3. Fetch ESPN WP directly → win probability chart
4. Render

The 10s client poll interval can stay — it just reads from DB instead of BDL.

---

## Changes by Section

### 1. Constants & Config (~30 lines changed)

**Title:** `DFT · WNBA` (line 6)

**Team colors (TC map):** Replace 30 NBA teams with 15 WNBA teams:
```javascript
const TC = {
  ATL:'#E31837', CHI:'#568CBB', CON:'#F05023', DAL:'#C4D600',
  GSV:'#582C83', IND:'#041E42', LVA:'#A7A8AA', LAS:'#552583',
  MIN:'#266150', NYL:'#6ECBA0', PHO:'#CB6015', PDX:'#E03A3E',
  SEA:'#2C5235', TOY:'#A6192E', WAS:'#E31837',
  // Also keep SR aliases that differ from display
  NYL:'#6ECBA0', LVA:'#A7A8AA', LAS:'#552583', GSV:'#582C83',
  TOY:'#A6192E', PDX:'#E03A3E',
};
```
*NOTE: Colors need verification against official WNBA brand guidelines. Portland Fire and Toronto Tempo are expansion teams — use their announced brand colors.*

**ESPN alias map:** WNBA-specific (ESPN may use different abbreviations):
```javascript
const ESPN_ALIAS_MAP = {}; // Verify against live ESPN WNBA scoreboard response
```
*Populate once we see actual ESPN WNBA abbreviations in a scoreboard response.*

**Indicator weights:**
```javascript
const W = {I1:.15, I2:.20, I3:.30, I4:.25, I5:.10};
```

**Indicator names:**
```javascript
var indNames = {I1:'Disruption', I2:'Perimeter/FT', I3:'Shot Quality', I4:'Game Control', I5:'Momentum'};
```

**localStorage prefix:** `wnba:` instead of `nba4:` (all 8 occurrences)

**Schedule meta text:** `WNBA games` instead of `NBA games` (line 650)

**Version:** `window.__wnbaVersion = 'wnba-1.0';`

### 2. Schedule Discovery (~15 lines changed)

**ESPN scoreboard:** `league=wnba` instead of `league=nba` (line 622)
```javascript
var r = await fetch(FN+'espn-data?type=scoreboard&league=wnba&date='+dateStr);
```

**SR schedule:** Already league-parameterized via `sr-data.js` proxy — just needs `league=wnba` param added to the `sr()` helper or hardcoded.

**Game ID mapping:** Games discovered via poll_state `schedule_json` for WNBA. Alternative: fetch from DB via `get_games&league=wnba&date=YYYY-MM-DD`. This avoids SR schedule fetch from client entirely (server already discovered them).

**Recommended approach:** Skip client-side SR schedule fetch. Instead:
```javascript
// Fetch games from DB (server already discovered and cached them)
var r = await fetch(FN+'db-api?action=get_games&league=wnba&date='+d.str);
var dbGames = (await r.json()).games || [];
games = dbGames.map(g => ({
  id: g.id, status: 'scheduled', scheduled: null,
  home: {alias: g.home_alias || g.matchup?.split('@')[1]},
  away: {alias: g.away_alias || g.matchup?.split('@')[0]},
  homePoints: g.home_pts, awayPoints: g.away_pts,
}));
```
This eliminates SR rate limit concerns from the client and uses games the server already validated.

### 3. Live Data Polling (~50 lines changed)

**Remove:** BDL box_score fetch (`bdl('box_scores', ...)` — lines 656, 723)
**Remove:** `computeClientIndicators()` calls (line 741)
**Remove:** `buildV3Summary()` function (line 2046-2080) — not needed without BDL box scores
**Remove:** `computeClientIndicators()` function (line 2084-2300+) — ~220 lines of dead code

**Replace with:** Server snapshot polling
```javascript
// Every 10s for live games:
var ids = liveGames.map(g => g.id).join(',');
var snapResp = await fetch(FN+'db-api?action=get_latest_snapshots&game_ids='+encodeURIComponent(ids));
var snapData = (await snapResp.json()).snapshots || {};
for (var gid in snapData) {
  var s = snapData[gid];
  var g = games.find(x => x.id === gid);
  if (!g) continue;
  g.homePoints = s.home_pts;
  g.awayPoints = s.away_pts;
  g.period = s.period;
  g.clock = s.clock;
  // Floor/indicators come from snapshot
  var cs = cardState[gid] || {};
  cs._serverFloor = s.floor_score;
  cs._serverFloorTeam = s.floor_team;
  cs.sonnetIndicators = {
    score: s.floor_score, controlTeam: s.floor_team,
    I1:{score:s.i1}, I2:{score:s.i2}, I3:{score:s.i3}, I4:{score:s.i4}, I5:{score:s.i5},
    source:'server'
  };
}
```

**ESPN WP:** Same as NBA — `league=wnba` in the fetch URL (line 1512)

### 4. Card Rendering (~20 lines changed)

**Period labels:** Same as NBA (Q1-Q4, OT) — WNBA uses quarters. No change needed.

**Indicator evidence panels (I2):** Replace paint/rim evidence with perimeter/FT evidence:
```javascript
// NBA I2:
evRow('Rim FG', ...)
evRow('Paint FG', ...)
evRow('FTA', ...)
evRow('FTM', ...)

// WNBA I2:
evRow('FTA', ...)
evRow('FTM', ...)
evRow('3PT Att', ...)  // perimeter volume
evRow('3PT Made', ...)
```
*Paint/rim data comes from PBP which WNBA doesn't have client-side. FTA/FTM comes from player stats in the snapshot.*

**I5 evidence panel:** May need adjustment — NBA I5 uses runs/pace data from PBP. WNBA can show what's available from the snapshot.

### 5. Unchanged (works as-is)

All DB API calls are game-id-based and league-agnostic:
- `get_latest_snapshots` — ✓
- `get_live_tracking` — ✓ (compound state, SHAP, checkpoints)
- `get_quarter_data` — ✓
- `get_alerts` — ✓ (filter by date, shows all leagues)
- `get_auto_analyses` — ✓
- `get_analyses` — ✓
- `get_theses` — ✓ (will be empty until pregame agent supports WNBA)
- `get_odds` — ✓

Other unchanged:
- WP chart rendering (ESPN data flows the same)
- XGB/MC chart rendering (reads from snapshot history)
- MC investigation strip (reads from live_tracking)
- Confidence table (reads from live_tracking checkpoints)
- Sustainability display (reads from snapshot sust_json)
- Alert toast (reads from alerts table)
- ⚡ Analyze button (hits analyze.js which reads from DB — league-aware via snapshot data)

### 6. Demo Mode

Replace NBA demo presets with WNBA games. Can use tonight's opening night games once they're final:
```javascript
const DEMO_GAMES = [
  {id:'<CON@NYL game id>', label:'CON@NYL'},
  {id:'<WAS@TOR game id>', label:'WAS@TOR'},
  {id:'<GSV@SEA game id>', label:'GSV@SEA'},
];
```

---

## Implementation Plan

**Estimated scope:** ~200 lines changed from 3,950 (mostly deletions of BDL compute code)

| Step | What | Lines |
|------|------|-------|
| 1 | Copy v3.html → wnba-bdl.html | 0 (copy) |
| 2 | Constants: title, TC, weights, indNames, localStorage prefix, schedule meta | ~30 |
| 3 | Schedule: DB-based game discovery instead of SR | ~15 |
| 4 | Poll: Replace BDL box_score fetch with snapshot polling | ~30 |
| 5 | Delete dead code: `computeClientIndicators`, `buildV3Summary`, BDL box_score calls | ~-250 |
| 6 | Evidence panels: I2 perimeter/FT, I5 momentum | ~10 |
| 7 | ESPN: `league=wnba` on scoreboard + WP fetches | ~2 |
| 8 | Demo mode: WNBA presets | ~10 |
| **Net** | | **~3,700 lines** (smaller than v3) |

**Risk:** Low. All data comes from the same DB API that NBA uses. No new endpoints needed. Server is already populating snapshots correctly (verified tonight with live games).

**Dependencies:** None blocking. Odds will populate once team name mapping is verified. Theses will populate once pregame agent supports WNBA.

---

## Open Questions

1. **Team colors:** Need official brand colors for all 15 teams, especially expansion (Portland Fire, Toronto Tempo). Placeholder colors in spec.
2. **ESPN alias mapping:** Need to capture a live WNBA scoreboard response to verify abbreviation mapping. May diverge from SR.
3. **`get_games` date filter:** The current `get_games` endpoint doesn't filter by date — returns all games. May need a date filter for clean schedule display, or filter client-side.
4. **Alerts filter:** `get_alerts&date=` returns all leagues. WNBA dashboard should filter `league=wnba` client-side, or the endpoint should accept a `league` param.
5. **Merge vs fork long-term:** Maintaining two separate 4K-line files is a maintenance burden. After WNBA stabilizes, consider refactoring v3 to be league-parameterized (one file, league selector in chrome bar). But fork-first is the right call to avoid regression risk on the NBA dashboard during playoffs.

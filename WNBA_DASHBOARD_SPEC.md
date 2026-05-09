# WNBA Dashboard Spec — `wnba-bdl.html`
**Date:** May 9, 2026 (v4 — all questions resolved)
**Source:** Fork from `v3.html` (3,959 lines)
**Status:** SPEC COMPLETE — awaiting implementation go-ahead

---

## 1. Architecture: Hybrid BDL + Server Snapshots

### Why fork, not parameterize
v3.html is 3,959 lines with NBA-specific logic throughout. Parameterizing creates regression risk during NBA playoffs. Fork now, merge later.

### Data flow

**NBA v3 (dual-path):**
```
Every 10s: BDL box_scores → scores, status, per-player stats
           → computeClientIndicators() → client-side floor/I1-I5
           → fetchLivePBP() → PBP audit, evidence panels, shot zones
Every 60s: hydrateFromServerSnapshots() → server floor, XGB, MC, sustainability, quarter data
Every 30s: fetchEspnWP() → WP chart
```

**WNBA (hybrid, plain 10s/60s polling — no event-driven):**
```
Every 10s: BDL plays → live scores (latest play home_score/away_score), run tracking, TO classification
           BDL team_stats → team box score → evidence panel data
Every 60s: hydrateFromServerSnapshots() → server floor, I1-I5, XGB, MC, TP/LS, sustainability, quarter data
Every 30s: fetchEspnWP() → WP chart
```

Server computes indicators from SR summary (higher quality — paint, POT, SCP, FBP, possessions). Client provides real-time scores and PBP context from BDL. Server is structural authority; BDL is the real-time layer.

### BDL WNBA endpoints (verified May 8–9, 2026)

| Endpoint | Status | Data |
|----------|--------|------|
| `games` | ✅ | Game list, IDs, status |
| `plays` | ✅ | Full PBP — shot types, `home_score`/`away_score` on every play, team, clock, period. **No x,y coordinates. No `shooting_play` field — see Section 3C.** ~450/game. |
| `team_stats` | ✅ | Team-level box score — fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, reb, ast, stl, blk, `turnovers` (not `to`), `fouls` (not `pf`). **No `pts` field — compute as `(fgm-fg3m)*2 + fg3m*3 + ftm`.** |
| `stats` (per-player) | ❌ 404 | Not available |
| `box_scores` (batch) | ❌ | Doesn't exist |
| `odds` | ❌ | Not available (server uses The Odds API) |
| Play coordinates | ❌ | No x,y — shot zones dead |

### Why NOT client-side indicator compute
BDL team_stats could compute rough indicators, but server already computes from SR (includes paint, POT, SCP, FBP, possessions — data BDL lacks). Server indicators are strictly higher quality. Client compute would disagree with server reads. Keep server as authority.

---

## 2. Files Touched

| File | Change | Risk |
|------|--------|------|
| `wnba-bdl.html` | New (fork from v3) | None |
| `analyze.js` | WNBA system prompt branch (~50 lines) | Medium |
| `netlify.toml` | Add xgb-model-wnba.json to included_files | None |

**NOT touched (previously planned, now deferred):**
- `poll-live-bdl.mjs` — no ntfy data ping needed (scrapped event-driven)
- `db-api.js` — `get_alerts` and `get_games` already accept `league` param; `get_latest_snapshots` and `get_live_tracking` are game_id-based, no league filter needed

---

## 3. Changes in `wnba-bdl.html`

### 3A. Constants & Config

| What | NBA v3 | WNBA |
|------|--------|------|
| Title | `DFT · v3` | `DFT · WNBA` |
| TC (team colors) | 30 NBA teams | 15 WNBA teams |
| W (indicator weights) | I1:.10 I2:.15 I3:.20 I4:.30 I5:.25 | I1:.15 I2:.20 I3:.30 I4:.25 I5:.10 |
| indNames | I2:'Interior', I5:'Execution' | I2:'Perimeter/FT', I5:'Momentum' |
| BDL_TEAM_MATCH | 30 NBA teams | 15 WNBA teams (see below) |
| ESPN_ALIAS_MAP | `{NOP:'NO', GSW:'GS',...}` | `{NYL:'NY', GSV:'GS', WAS:'WSH', LVA:'LV', LAS:'LA', PDX:'POR', TOY:'TOR'}` |
| localStorage prefix | `nba4:` | `wnba:` (10 occurrences) |

**BDL_TEAM_MATCH (verified from live BDL data):**
```javascript
const BDL_TEAM_MATCH = {
  ATL:'Dream', CHI:'Sky', CON:'Sun', DAL:'Wings', GS:'Valkyries',
  IND:'Fever', LA:'Sparks', LV:'Aces', MIN:'Lynx', NY:'Liberty',
  PHX:'Mercury', POR:'Fire', SEA:'Storm', TOR:'Tempo', WSH:'Mystics'
};
```
Keys are DFT aliases (post-aliasMap). `buildBdlGameMap()` matches by `full_name.includes(BDL_TEAM_MATCH[alias])`.

**ESPN_ALIAS_MAP (verified from live ESPN scoreboard May 8–10):**
```javascript
const ESPN_ALIAS_MAP = {NYL:'NY', GSV:'GS', WAS:'WSH', LVA:'LV', LAS:'LA', PDX:'POR', TOY:'TOR'};
```
Identical to LEAGUES.wnba.aliasMap on the server. All 15 teams confirmed — the 8 not in the map (ATL, CHI, CON, DAL, IND, MIN, PHX, SEA) are identical between SR and ESPN.

**WNBA team colors (TC):**
```javascript
const TC = {
  ATL:'#C8102E', CHI:'#418FDE', CON:'#DC4405', DAL:'#00A4E4',
  GS:'#552583', IND:'#002D62', LA:'#702F8A', LV:'#000000',
  MIN:'#236192', NY:'#2BACE2', PHX:'#E56020', POR:'#E03C31',
  SEA:'#2C5234', TOR:'#A6192E', WSH:'#002B5C',
  HOME:'#888', AWAY:'#888'
};
```
Note: PDX (Portland Fire) and TOY (Toronto Tempo) are expansion teams — brand colors approximate, update from official guides when available.

**Inline conviction (`snapConviction` in snapshot history drawer) — WNBA killer pairs:**
```javascript
function snapConviction(s, flipInd){
  // ... score computation same ...
  var has = function(a,b){ return wins.indexOf(a)>=0 && wins.indexOf(b)>=0; };
  // WNBA: I3+I4 is DOMINANT pair (not I4+I5 — I5 AUC=0.500)
  var hasI3I4 = has('I3','I4');
  var hasI3I2 = has('I3','I2');
  var hasI4I2 = has('I4','I2');
  var hasKiller = hasI3I4 || hasI3I2 || hasI4I2;
  // No validated danger combos for WNBA
  if(count >= 4 || (hasI3I4 && count >= 3)) return 'DOM';
  if(hasKiller) return 'STR';
  if(count >= 2) return 'MOD';
  if(count >= 1) return 'COND';
  return '--';
}
```

### 3B. Schedule Discovery

**Replace** `sr('schedule', ...)` with `get_poll_state&league=wnba`:

```javascript
// WNBA: games from server poll_state (SR already discovered)
var psResp = await fetch(FN+'db-api?action=get_poll_state&league=wnba');
var psData = await psResp.json();
var sched = psData.state?.schedule_json || [];
if (typeof sched === 'string') sched = JSON.parse(sched);

games = sched.map(function(g){
  return {
    id: g.id, status: g.status, scheduled: g.scheduled,
    venue: '',
    home: { alias: g.home_alias, name: g.home_name },
    away: { alias: g.away_alias, name: g.away_name },
    homePoints: null, awayPoints: null,
    period: 0, clock: '', summary: null, bdlData: null, dataSource: 'BDL'
  };
});
```

**Skip** `bdl('box_scores')` status correction — doesn't exist for WNBA.

**Keep** `buildBdlGameMap()` — works as-is with WNBA `BDL_TEAM_MATCH`.

**Keep** `fetchEspnScoreboard()` — change `league=nba` → `league=wnba`.

**Skip** `fetchStandings()` — no BDL WNBA standings endpoint.

### 3C. CRITICAL: `parseBDLPBP()` shot detection fix

WNBA BDL plays do NOT have `shooting_play` field (0 of 453 plays verified). The guard `if(ev.shooting_play)` skips ALL shots, killing runs, scoring events, zone data, and POT/SCP tracking.

**Fix:** Replace `if(ev.shooting_play)` with:

```javascript
var _isShotPlay = ev.shooting_play != null ? ev.shooting_play
  : /shot|layup|dunk|hook|tip|free throw/i.test(type);
if(_isShotPlay){
```

**NBA regression risk:** Zero. NBA plays always have `shooting_play`, so the ternary uses `ev.shooting_play` (truthy/falsy). The regex only fires when `shooting_play` is `undefined` (WNBA).

**3PT classification:** Already correct. `is3 = ev.score_value === 3 || tx.includes('three point')` catches WNBA's text-based "three point" pattern (e.g., "misses 27-foot three point jumper").

### 3D. Poll Cycle — Hybrid Refresh

**Delete:** `refreshLiveCards()` (BDL box_scores polling + computeClientIndicators)

**Replace with `refreshLiveCardsWNBA()`:**

```javascript
async function refreshLiveCardsWNBA(){
  try {
    var updated = false;
    for (var gi = 0; gi < games.length; gi++) {
      var g = games[gi];
      if (getState(g) !== 'LIVE') continue;
      var bdlId = bdlGameMap[g.id];
      if (!bdlId) continue;
      var cs = cardState[g.id];
      if (!cs) continue;

      // 1a. BDL plays → scores, period, clock, PBP
      try {
        var playsRes = await bdl('plays', {game_id: bdlId, league: 'wnba'});
        var plays = playsRes.data || [];
        if (plays.length > 0) {
          var last = plays[plays.length - 1];
          g.homePoints = last.home_score != null ? last.home_score : g.homePoints;
          g.awayPoints = last.away_score != null ? last.away_score : g.awayPoints;
          g.period = last.period || g.period;
          g.clock = last.clock || g.clock;
          if ((last.type || '').toLowerCase().includes('end game')) g.status = 'closed';
          var hA = g.home?.alias || '', aA = g.away?.alias || '';
          var hE = ESPN_ALIAS_MAP[hA] || hA, aE = ESPN_ALIAS_MAP[aA] || aA;
          cs.pbpAudit = parseBDLPBP(plays, hE, aE);
          cs._bdlPlays = plays;
          updated = true;
        }
      } catch(e) { console.warn('[BDL plays]', g.id, e.message); }

      // 1b. BDL team_stats → evidence panels
      try {
        var tsRes = await bdl('team_stats', {game_id: bdlId, league: 'wnba'});
        var tsData = tsRes.data || [];
        if (tsData.length >= 2) {
          cs._bdlTeamStats = tsData;
          cs._teamEvidence = buildTeamEvidence(tsData, g);
          updated = true;
        }
      } catch(e) { console.warn('[BDL team_stats]', g.id, e.message); }
    }
    if (updated) { renderPills(); games.forEach(function(g){ renderCard(g.id); }); }
  } catch(e) { console.warn('[POLL]', e.message); }

  pollAlerts();
  maybeResyncTheses();
  maybeResyncSnapshots();
  maybeRefreshEspnWP();
}
```

**`buildTeamEvidence(tsData, game)` — adapter from BDL team_stats:**

```javascript
function buildTeamEvidence(tsData, game){
  var hA = ESPN_ALIAS_MAP[game.home?.alias] || game.home?.alias || '';
  var aA = ESPN_ALIAS_MAP[game.away?.alias] || game.away?.alias || '';
  var home = tsData.find(function(t){ return t.team?.abbreviation === hA; }) || tsData[0];
  var away = tsData.find(function(t){ return t.team?.abbreviation === aA; }) || tsData[1];
  function adapt(ts){
    if(!ts) return null;
    var fg3m = ts.fg3m || 0, fgm = ts.fgm || 0, ftm = ts.ftm || 0;
    return {
      stl: ts.stl||0, blk: ts.blk||0,
      turnovers: ts.turnovers||0, pf: ts.fouls||0,
      fta: ts.fta||0, ftm: ftm,
      fg3a: ts.fg3a||0, fg3m: fg3m,
      fga: ts.fga||0, fgm: fgm,
      ast: ts.ast||0, oreb: ts.oreb||0, dreb: ts.dreb||0,
      reb: ts.reb||0,
      pts: (fgm - fg3m) * 2 + fg3m * 3 + ftm
    };
  }
  return { home: adapt(home), away: adapt(away) };
}
```

**`getFloor()` chain:** `sonnetIndicators → clientInd(null) → _serverFloor → rollingWindow` — works unchanged. `clientInd` is always null (no client compute), falls through to `_serverFloor`.

### 3E. Dead Code (~290 lines removed)

| Function | Lines | Why dead |
|----------|-------|----------|
| `computeClientIndicators()` | ~139 | Server computes from SR |
| `buildV3Summary()` | ~32 | BDL box_scores format converter — not needed |
| `refreshLiveCards()` | ~55 | Replaced by `refreshLiveCardsWNBA()` |
| BDL box_score fetch blocks in loadSchedule | ~15 | Endpoint doesn't exist |
| Shot zone rendering + coordinate helpers | ~50 | No x,y coordinates |

**KEPT:** `bdl()`, `buildBdlGameMap()`, `parseBDLPBP()` (with shooting_play fix), `bdlClassifyTO()`, `bdlExtractPlayer()`, `normalizeBdlClock()`, `coordinateToZone()` (still used by parseBDLPBP for type-based classification even without coordinates).

### 3F. Evidence Panels

**Data source:** `cs._teamEvidence` (from `buildTeamEvidence`) replaces `cs._lastBoxScore` player rollup. Fallback to latest snapshot `raw_stats_json` if `_teamEvidence` is null.

**Rendering pattern change:**
```javascript
// NBA:  var hPl = box.home_team?.players || []; sum(hPl, 'stl')
// WNBA: var ev = cs._teamEvidence; (ev?.home?.stl || 0)
```

**I2 evidence panel — Perimeter/FT (not Interior Control):**

| NBA I2 rows | WNBA I2 rows |
|-------------|--------------|
| Rim FG (PBP) | FTA |
| Paint FG (PBP) | FTM |
| FTA | FG3A |
| FTM | FG3M |

PBP-derived rows (forced TO, runs) stay the same — `parseBDLPBP` provides these from `cs.pbpAudit`.

### 3G. Quarter Dominance Grid

**Column reorder — WNBA (FTA first, PNT last):**
```javascript
var statDefs = [
  {label:'FTA', get:function(d){ return d.free_throws_att||0; }},
  {label:'AST', get:function(d){ return d.assists||0; }},
  {label:'3PM', get:function(d){ return d.three_points_made||0; }},
  {label:'STL', get:function(d){ return d.steals||0; }},
  {label:'TO',  get:function(d){ return d.turnovers||d.total_turnovers||0; }, invert:true},
  {label:'PNT', get:function(d){ return d.points_in_the_paint||d.points_in_paint||0; }}
];
```

**Live partial quarter row:** Replace `qdRollup(players)` with `qdRollupEvidence(te)`:
```javascript
function qdRollupEvidence(te){
  return {
    steals: te?.stl||0, turnovers: te?.turnovers||0, total_turnovers: te?.turnovers||0,
    free_throws_att: te?.fta||0, three_points_made: te?.fg3m||0,
    assists: te?.ast||0, points_in_the_paint: 0
  };
}
```
Paint shows `·` in live partial (BDL team_stats has no paint stat). Completed quarter rows from server `quarter_data` DO have paint (from SR).

### 3H. ESPN WP

`league=nba` → `league=wnba` in `fetchEspnScoreboard()` and `fetchEspnWP()`. No other changes.

### 3I. Analyze Button

**Replace** `bdl('box_scores') → buildV3Summary()` with `raw_stats_json` from latest snapshot:

```javascript
var summaryData = null;
var cs = cardState[gameId];
if (cs && cs._latestRawStats) {
  summaryData = buildWNBASummary(cs._latestRawStats, g);
}
```

**`buildWNBASummary(rawStats, game)`:**
```javascript
function buildWNBASummary(raw, game){
  var hA = ESPN_ALIAS_MAP[game.home?.alias] || game.home?.alias || '';
  var aA = ESPN_ALIAS_MAP[game.away?.alias] || game.away?.alias || '';
  function mapStats(s){
    if(!s) return {};
    var fga = s.fga||1, fgm = s.fgm||0, fg3m = s.fg3m||0, ftm = s.ftm||0;
    return {
      field_goals_made:fgm, field_goals_att:s.fga||0,
      three_points_made:fg3m, three_points_att:s.fg3a||0,
      two_points_made:fgm-fg3m, two_points_att:(s.fga||0)-(s.fg3a||0),
      free_throws_made:ftm, free_throws_att:s.fta||0,
      assists:s.ast||0, steals:s.stl||0, blocks:s.blk||0,
      offensive_rebounds:s.oreb||0, turnovers:s.to||0, total_turnovers:s.to||0,
      personal_fouls:s.fd||0,
      points:(fgm-fg3m)*2+fg3m*3+ftm,
      points_in_paint:s.paint||0, points_off_turnovers:s.pot||0,
      second_chance_pts:s.scp||0, fast_break_pts:s.fbp||0,
      possessions:s.poss||0, biggest_lead:s.bigLead||0, bench_points:s.bench||0,
      effective_fg_pct:+((fgm+0.5*fg3m)/fga*100).toFixed(1),
      field_goals_pct:+(fgm/fga*100).toFixed(1),
      three_points_pct:s.fg3a>0?+(fg3m/s.fg3a*100).toFixed(1):0,
      offensive_points_per_possession:s.poss>0?+(((fgm-fg3m)*2+fg3m*3+ftm)/s.poss).toFixed(2):0
    };
  }
  return {
    _dataSource:'server_raw', status:'inprogress',
    quarter:game.period||0, clock:game.clock||'',
    home:{name:game.home?.name||'',alias:hA,points:game.homePoints||0,statistics:mapStats(raw.home),players:[]},
    away:{name:game.away?.name||'',alias:aA,points:game.awayPoints||0,statistics:mapStats(raw.away),players:[]}
  };
}
```

`players:[]` means analyze.js sustainability personnel layer falls back to regression + shot-type grades. Correct behavior — can't see per-player in-game stats.

**Pass `league:'wnba'` in analysis payload.**

### 3J. Alert Toast

```javascript
var r = await fetch(FN+'db-api?action=get_alerts&league=wnba&date='+d.str+'&limit=200');
```

### 3K. Date Navigation

Use `get_poll_state&league=wnba` for schedule. Historical: `get_games&league=wnba`.

### 3L. Game Status Determination

1. **poll_state `schedule_json`** — SR sets `scheduled`, `inprogress`, `closed`. Primary at load time.
2. **BDL plays** — last play `type: "End Game"` → closed. Plays exist with `home_score > 0` → live.
3. **ESPN scoreboard** — `STATUS_FINAL`/`STATUS_IN_PROGRESS`/`STATUS_SCHEDULED` as tiebreaker.

### 3M. Demo Mode

Opening night presets (May 8):
- CON@NYL (`a01c0aa0-885e-4258-82c5-695c2ada9546`) — blowout, LOCKED
- GSV@SEA (`8f658fb4-cc4e-4499-a66f-025474c73ba8`) — competitive, LOCKED
- WAS@TOR (`61500e2a-18d1-4bb9-82ce-ab3010c4ce53`) — close, no compound

---

## 4. Server-Side Changes

### 4A. analyze.js — WNBA system prompt branch (~50 lines)

Add `league` to payload, branch system prompt. Key diffs from NBA:
- Indicator names (I2='Perimeter/FT', I5='Momentum'), weights (I3=30% anchor)
- Signal trust (MC >> XGB >> Floor; floor never gates)
- Game structure (10-min quarters, 40-min, 30-sec shot clock)
- Conviction (I3+I4 DOMINANT, no I4+I5 killer pair)
- Turnovers inverse

### 4B. netlify.toml — included_files

```toml
[functions."poll-live-bdl"]
  timeout = 120
  included_files = ["netlify/functions/xgb-model.json", "netlify/functions/xgb-model-wnba.json"]
```

---

## 5. What's Genuinely Missing vs NBA v3

| Feature | NBA v3 | WNBA | Permanent? |
|---------|--------|------|------------|
| Live scores (10s) | BDL box_scores | BDL plays | **Solved** |
| Per-player stats | box_scores players[] | Team-level only | **Yes** |
| Shot zones | PBP x,y coords | Hidden | **Yes** |
| Run tracking | BDL plays | BDL plays (with fix) | **Solved** |
| Indicators/floor | Client compute | Server (higher quality) | **Better** |
| Sust. personnel | Per-player in-game | Regression + shot-type only | **Partial** |
| Standings/ranks | BDL standings | Not available | **Yes** |
| Paint in live QD partial | PBP-derived | Shows `·` | **Yes** |
| Analysis button | BDL box_scores | Server raw_stats_json | **Solved** |

---

## 6. Implementation Order

| # | What | Risk | Lines |
|---|------|------|-------|
| 1 | Copy v3.html → wnba-bdl.html | None | 0 |
| 2 | Constants: TC, W, indNames, BDL_TEAM_MATCH, ESPN_ALIAS_MAP, localStorage, title | Low | ~40 |
| 3 | `parseBDLPBP()` shooting_play fix | None | 2 |
| 4 | Schedule: poll_state path, skip box_scores/standings | Medium | ~30 |
| 5 | `buildTeamEvidence()` + `buildWNBASummary()` adapters | Low | ~60 |
| 6 | Poll: `refreshLiveCardsWNBA()` | Medium | ~50 |
| 7 | Delete dead code | Low | -290 |
| 8 | Evidence panels: `_teamEvidence`, I2 perimeter/FT | Medium | ~40 |
| 9 | QD grid: column reorder + live partial | Low | ~20 |
| 10 | Inline conviction: WNBA killer pairs | Low | ~15 |
| 11 | Analyze: `buildWNBASummary` + league payload | Medium | ~20 |
| 12 | analyze.js: WNBA system prompt | Medium | ~50 |
| 13 | Alert toast: `&league=wnba` | Low | 1 |
| 14 | ESPN: `league=wnba` | Low | 2 |
| 15 | netlify.toml: included_files | None | 1 |
| 16 | Demo mode | Low | ~10 |
| 17 | Game status updates in poll loop | Low | ~10 |
| 18 | Smoke test | — | — |

**Estimated net: ~3,800 lines (3,959 - 290 dead + ~130 new)**

---

## 7. Resolved Questions

| # | Question | Resolution |
|---|----------|------------|
| 1 | Team colors | Set. PDX/TOY approximate — update when official. |
| 2 | ESPN alias mapping | All 15 verified. Map = LEAGUES.wnba.aliasMap. |
| 3 | BDL plays live | Verified. No `shooting_play`, no `coordinate_x`. |
| 4 | BDL team_stats fields | `fouls` not `pf`, `turnovers` not `to`, no `pts`. |
| 5 | Merge timeline | 2-3 weeks stable. |
| 6 | `shooting_play` missing | Type-regex fallback. Zero NBA regression. |
| 7 | ntfy event-driven | Scrapped. Plain 10s/60s polling. |
| 8 | 3PT classification | Already correct via `tx.includes('three point')`. |
| 9 | XGB model included_files | Add to netlify.toml defensively. |
| 10 | Game status chain | poll_state → BDL plays → ESPN scoreboard. |
| 11 | summaryData for analyze | Build from server snapshot raw_stats_json. |

---

*End of spec.*

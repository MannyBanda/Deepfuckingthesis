# WNBA Dashboard Spec — `wnba-bdl.html`
**Date:** May 9, 2026 (v5 — shooting_play fix expanded, court visual + player stats unlocked)
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
| Play coordinates | ❌ | No x,y — but zone classification works via text fallback (see 3C, 3N) |

### Why NOT client-side indicator compute
BDL team_stats could compute rough indicators, but server already computes from SR (includes paint, POT, SCP, FBP, possessions — data BDL lacks). Server indicators are strictly higher quality. Client compute would disagree with server reads. Keep server as authority.

---

## 2. Files Touched

| File | Change | Risk |
|------|--------|------|
| `wnba-bdl.html` | New (fork from v3) | None |
| `poll-live-bdl.mjs` | `shooting_play` fix at 2 locations (lines 1753, 1902) | **Low** — NBA always has field, regex only fires for WNBA |
| `analyze.js` | WNBA system prompt branch (~50 lines) | Medium |
| `netlify.toml` | Add xgb-model-wnba.json to included_files | None |

**NOT touched:**
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

**WNBA team colors (TC) — brightest per team, optimized for dark bg contrast:**
```javascript
const TC = {
  ATL:'#E35205',  // Dream Coral
  CHI:'#72C5EB',  // Sky Blue (lightened from #418FDE for dark bg)
  CON:'#FB4F14',  // Sun Orange
  DAL:'#00A4E4',  // Wings Blue
  GS: '#AD96DC',  // Valkyrie Violet
  IND:'#FFCD00',  // Fever Yellow
  LA: '#FFC72C',  // Sparks Gold
  LV: '#C8102E',  // Aces Red
  MIN:'#78BE21',  // Lynx Aurora Green
  NY: '#6ECEB2',  // Liberty Seafoam
  PHX:'#E56020',  // Mercury Orange
  POR:'#E03C31',  // Fire Red (approx — expansion team)
  SEA:'#FBE122',  // Storm Yellow
  TOR:'#6CACE4',  // Tempo Borealis Blue (approx — expansion team)
  WSH:'#E31837',  // Mystics Red (shifted from #C8102E to differentiate from LV)
  HOME:'#888', AWAY:'#888'
};
```

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

**Replace** `fetchStandings()` — use SR standings via `sr-data?league=wnba&type=standings` instead of BDL. SR confirmed working (all 13+ teams with W/L records).

### 3C. CRITICAL: `shooting_play` fix — 3 locations (client + server x2)

WNBA BDL plays do NOT have `shooting_play` field (0 of 453 plays verified). The guard `if(ev.shooting_play)` skips ALL shots, killing runs, scoring events, zone data, POT/SCP tracking, and MC possession logs.

**Verified impact on opening night data:** `game_pbp` table has `totalShots: 0`, `scoreLog: 0`, `runs: 0` for all 3 WNBA games. Turnovers work (different code path). `biggestLeadHome` works (separate tracking). But all shot-dependent data is empty.

**Fix pattern (identical at all 3 locations):**

Replace:
```javascript
if (ev.shooting_play) {
```
With:
```javascript
var _isShotPlay = ev.shooting_play != null ? ev.shooting_play
  : /shot|layup|dunk|hook|tip|free throw/i.test(type);
if (_isShotPlay) {
```

**Location 1 — `wnba-bdl.html` client-side `parseBDLPBP()` (line ~2330 in v3):**
Gates all shot parsing → zone classification, runs, scoring events, POT/SCP tracking, per-player shot data for court visual and zone detail.

**Location 2 — `poll-live-bdl.mjs` line 1753 — server PBP parser:**
Gates server-side `parseBDLPBPServer()` → zone data, runs, scoring events persisted to `game_pbp` table. Also feeds the I1-I5 indicator detail and court visual data on page load for completed games.

**Location 3 — `poll-live-bdl.mjs` line 1902 — possession log builder:**
Gates `buildPossLogServer()` → per-possession FGA/FGM tracking for MC engine input. Without this fix, WNBA MC possession logs have zero shot data.

**NBA regression risk:** Zero at all 3 locations. NBA plays always have `shooting_play` (boolean), so the ternary uses `ev.shooting_play` directly. The regex only fires when `shooting_play` is `undefined` (WNBA).

**3PT classification:** Already correct at all locations. `is3 = ev.score_value === 3 || tx.includes('three point')` catches WNBA's text-based pattern.

**Backfill:** After deploying the fix, re-parse the 3 opening night games by hitting `?action=save_pbp` with fresh BDL plays data to populate the correct zone/shot/run data in `game_pbp`.

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

### 3E. Dead Code (~240 lines removed)

| Function | Lines | Why dead |
|----------|-------|----------|
| `computeClientIndicators()` | ~139 | Server computes from SR |
| `buildV3Summary()` | ~32 | BDL box_scores format converter — not needed |
| `refreshLiveCards()` | ~55 | Replaced by `refreshLiveCardsWNBA()` |
| BDL box_score fetch blocks in loadSchedule | ~15 | Endpoint doesn't exist |

**KEPT:** `bdl()`, `buildBdlGameMap()`, `parseBDLPBP()` (with shooting_play fix), `bdlClassifyTO()`, `bdlExtractPlayer()`, `bdlExtractAssist()`, `bdlExtractBlock()`, `bdlExtractSteal()`, `normalizeBdlClock()`, `coordinateToZone()` (text fallback classifies zones without coordinates), shot zone court visual (`courtSVG()` — ported from bdl.html, adapted for 4 zones).

### 3F. I1-I5 Indicator Detail (tap pill → expandable `buildIndEvidence()`)

**Data source chain:** PBP player stats (from `compilePBPPlayerStats`, see 3O) → `_teamEvidence` (from BDL team_stats) → latest snapshot `raw_stats_json`. PBP is preferred because it provides per-player breakdowns.

**Rendering: `buildIndEvidence()` currently reads from `cs._lastBoxScore` (per-player arrays).** For WNBA, read from `cs._pbpPlayerStats` (compiled from PBP) with `_teamEvidence` as fallback:

```javascript
// NBA:  var box = cs._lastBoxScore; var hPl = box.home_team?.players || [];
//       function sum(pl, f){ var t=0; pl.forEach(function(p){ t += p[f]||0; }); return t; }
// WNBA: var pbs = cs._pbpPlayerStats;  // from compilePBPPlayerStats()
//       var ev = cs._teamEvidence;       // from buildTeamEvidence()
//       function teamStat(side, f){
//         if(pbs && pbs[side]) return pbs[side].totals[f] || 0;
//         if(ev && ev[side]) return ev[side][f] || 0;
//         return 0;
//       }
```

**I2 indicator detail — WNBA is Perimeter/FT (not Interior Control):**

| NBA I2 rows | WNBA I2 rows |
|-------------|--------------|
| Rim FG (PBP) | FTA |
| Paint FG (PBP) | FTM |
| FTA | FG3A |
| FTM | FG3M |

Note: Rim FG and Paint FG from PBP ARE available (text classification works) — they just aren't the I2-defining stats for WNBA. They could be added as supplementary rows.

PBP-derived rows (forced TO, runs, biggest lead) stay the same — `parseBDLPBP` provides these from `cs.pbpAudit`.

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

**Live partial quarter row:** Replace `qdRollup(players)` with `qdRollupEvidence(te, pbp, side)`:
```javascript
function qdRollupEvidence(te, pbp, side){
  // PBP-derived paint: (rim_made + paint_made) * 2
  var paintPts = 0;
  if(pbp && pbp[side]){
    paintPts = ((pbp[side].rim?.made||0) + (pbp[side].paint?.made||0)) * 2;
  }
  return {
    steals: te?.stl||0, turnovers: te?.turnovers||0, total_turnovers: te?.turnovers||0,
    free_throws_att: te?.fta||0, three_points_made: te?.fg3m||0,
    assists: te?.ast||0, points_in_the_paint: paintPts
  };
}
```
PBP zone data provides paint for the live partial row (rim+paint zones from text classification). Completed quarter rows from server `quarter_data` also have paint (from SR).

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

`players` array populated from `compilePBPPlayerStats()` (see 3O) — gives sustainability audit real per-player shooting data (FGM/FGA by zone, assisted%, context). Falls back to empty `[]` if no PBP data (regression + shot-type grades only).

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

### 3N. Shot Zone Court Visual (ported from bdl.html)

The court visual works for WNBA using text-based zone classification. `coordinateToZone()` text fallback chain:
- `"layup"`, `"dunk"`, `"tip"` → rim
- `"hook"`, `"float"` → paint
- `"N-foot"` where N ≤ 4 → rim, N ≤ 9 → paint, N ≥ 22 → 3pt, else → mid
- `"three point"` in text or `score_value === 3` → 3pt

**4 zones instead of 5:** Corner 3 vs above-the-break 3 cannot be distinguished without coordinates. Merge into single "3PT" zone.

**Zone positions for WNBA (modified from bdl.html's `zPos`):**
```javascript
var zPos = {
  home: [
    {k:'rim',   cx:150, cy:178},
    {k:'paint', cx:90,  cy:130},
    {k:'mid',   cx:230, cy:120},
    {k:'three', cx:150, cy:30}   // merged corner3+above3
  ],
  away: [
    {k:'rim',   cx:150, cy:40},
    {k:'paint', cx:210, cy:88},
    {k:'mid',   cx:70,  cy:98},
    {k:'three', cx:150, cy:188}  // merged corner3+above3
  ]
};
```

**Zone data source:** `parseBDLPBP()` → `aggTeam()` already computes `{rim: {made, att}, paint: {...}, mid: {...}, threes: {...}}`. For the court visual, merge threes into a single zone:

```javascript
function buildZonesForCourt(pbpSide){
  if(!pbpSide) return null;
  return {
    rim:   {m: pbpSide.rim?.made||0,   a: pbpSide.rim?.att||0,   players: pbpSide.rim?.byPlayer||[]},
    paint: {m: pbpSide.paint?.made||0, a: pbpSide.paint?.att||0, players: pbpSide.paint?.byPlayer||[]},
    mid:   {m: pbpSide.mid?.made||0,   a: pbpSide.mid?.att||0,   players: pbpSide.mid?.byPlayer||[]},
    three: {m: pbpSide.threes?.made||0, a: pbpSide.threes?.att||0, players: pbpSide.threes?.byPlayer||[]}
  };
}
```

**Per-player zone detail (tap bubble → player breakdown):** `parseBDLPBP` `shots[]` array has `{p: player, z: zone, m: made}` per shot. `byPlayer` needs to be populated in `aggTeam()` — currently returns `byPlayer:[]` in v3.html. Add player aggregation:

```javascript
// Inside aggTeam(), after computing zone shot arrays:
function playerAgg(shotArr){
  var map = {};
  shotArr.forEach(function(s){
    if(!map[s.p]) map[s.p] = {n: s.p, m: 0, a: 0};
    map[s.p].a++;
    if(s.m) map[s.p].m++;
  });
  return Object.values(map).sort(function(a,b){ return b.a - a.a; });
}
// Then in the return:
threes: {made:thM.length, att:th.length, ..., byPlayer: playerAgg(th)},
rim:    {made:riM.length, att:ri.length, ..., byPlayer: playerAgg(ri)},
paint:  {made:paM.length, att:pa.length, ..., byPlayer: playerAgg(pa)},
mid:    {made:miM.length, att:mi.length, ..., byPlayer: playerAgg(mi)}
```

**S:V ratio header:** `structVarCalc()` from bdl.html. For WNBA with merged 3PT:
```javascript
function structVarCalc(zones){
  var s = (zones.rim.m + zones.paint.m) * 2;
  var v = zones.three.m * 3 + zones.mid.m * 2;
  var t = s + v;
  return {s:s, v:v, pct: t > 0 ? Math.round(s/t*100) : 0};
}
```

**Court SVG rendering:** Port `courtSVG()` from bdl.html (~50 lines) — half-court outline with zone bubbles at fixed positions. Circle radius scales with volume (`Math.max(12, Math.min(26, d.a*2.5))`). Color coded by efficiency (green/amber/red). Tap handler shows per-player zone detail panel.

**Data persistence:** `game_pbp` table already stores `pbp_json` for WNBA games. Once the `shooting_play` fix is deployed (3C), zone data populates correctly. Completed games load PBP from DB via `fetchPBPFromDB()`. Live games get fresh PBP every 10s via `refreshLiveCardsWNBA()`.

### 3O. PBP Player Stats Compilation

Per-player stats compiled from BDL plays text extraction. Every play has full player names (e.g., `"Breanna Stewart makes 7-foot turnaround jump shot (Marine Johannes assists)"`). Extraction functions already exist: `bdlExtractPlayer()`, `bdlExtractAssist()`, `bdlExtractBlock()`, `bdlExtractSteal()`.

```javascript
function compilePBPPlayerStats(plays, homeAbbr, awayAbbr){
  if(!plays || plays.length === 0) return null;
  var stats = {home: {}, away: {}};

  plays.forEach(function(ev){
    var type = (ev.type||'').trim(), tl = type.toLowerCase();
    var text = (ev.text||'').trim(), tx = text.toLowerCase();
    var tAbbr = ev.team?.abbreviation || '';
    var side = tAbbr === homeAbbr ? 'home' : tAbbr === awayAbbr ? 'away' : null;
    if(!side) return;
    var player = bdlExtractPlayer(text);
    if(!player || player === '?') return;

    // Initialize player
    if(!stats[side][player]) stats[side][player] = {
      name:player, fgm:0, fga:0, fg3m:0, fg3a:0, ftm:0, fta:0,
      pts:0, ast:0, stl:0, blk:0, to:0, oreb:0, dreb:0, reb:0,
      zones:{rim:{m:0,a:0}, paint:{m:0,a:0}, mid:{m:0,a:0}, three:{m:0,a:0}}
    };
    var p = stats[side][player];

    // Shooting plays
    var _isShotPlay = ev.shooting_play != null ? ev.shooting_play
      : /shot|layup|dunk|hook|tip|free throw/i.test(tl);
    if(_isShotPlay){
      var made = ev.scoring_play || false;
      var is3 = ev.score_value === 3 || tx.includes('three point');

      if(tl.includes('free throw')){
        p.fta++;
        if(made){ p.ftm++; p.pts += 1; }
        return;
      }
      p.fga++;
      if(is3) p.fg3a++;
      var zone = coordinateToZone(null, null, type, text, ev.score_value);
      // Map to 4-zone system (merge corner3+above3 → three)
      var zKey = (zone === 'corner3' || zone === 'above3') ? 'three'
               : (zone === 'rim' || zone === 'paint' || zone === 'mid') ? zone : 'mid';
      p.zones[zKey].a++;
      if(made){
        p.fgm++;
        if(is3) p.fg3m++;
        p.pts += ev.score_value || (is3 ? 3 : 2);
        p.zones[zKey].m++;
      }
      return;
    }

    // Turnovers
    if(tl.includes('turnover')){ p.to++; return; }

    // Rebounds
    if(tl.includes('rebound')){
      if(tl.includes('offensive')){ p.oreb++; p.reb++; }
      else if(tl.includes('defensive')){ p.dreb++; p.reb++; }
      return;
    }

    // Assists — credited to the assister, not the scorer
    var assister = bdlExtractAssist(text);
    if(assister && assister !== '?'){
      if(!stats[side][assister]) stats[side][assister] = {
        name:assister, fgm:0, fga:0, fg3m:0, fg3a:0, ftm:0, fta:0,
        pts:0, ast:0, stl:0, blk:0, to:0, oreb:0, dreb:0, reb:0,
        zones:{rim:{m:0,a:0}, paint:{m:0,a:0}, mid:{m:0,a:0}, three:{m:0,a:0}}
      };
      stats[side][assister].ast++;
    }

    // Steals — credited to the stealer (appears in turnover plays of the OTHER team)
    var stealer = bdlExtractSteal(text);
    if(stealer && stealer !== '?'){
      var stealSide = side === 'home' ? 'away' : 'home'; // stealer is on opposing team
      if(!stats[stealSide][stealer]) stats[stealSide][stealer] = {
        name:stealer, fgm:0, fga:0, fg3m:0, fg3a:0, ftm:0, fta:0,
        pts:0, ast:0, stl:0, blk:0, to:0, oreb:0, dreb:0, reb:0,
        zones:{rim:{m:0,a:0}, paint:{m:0,a:0}, mid:{m:0,a:0}, three:{m:0,a:0}}
      };
      stats[stealSide][stealer].stl++;
    }

    // Blocks
    var blocker = bdlExtractBlock(text);
    if(blocker && blocker !== '?'){
      var blockSide = side === 'home' ? 'away' : 'home';
      if(!stats[blockSide][blocker]) stats[blockSide][blocker] = {
        name:blocker, fgm:0, fga:0, fg3m:0, fg3a:0, ftm:0, fta:0,
        pts:0, ast:0, stl:0, blk:0, to:0, oreb:0, dreb:0, reb:0,
        zones:{rim:{m:0,a:0}, paint:{m:0,a:0}, mid:{m:0,a:0}, three:{m:0,a:0}}
      };
      stats[blockSide][blocker].blk++;
    }
  });

  // Sort by pts desc and compute totals
  function finalize(side){
    var arr = Object.values(stats[side]).sort(function(a,b){ return b.pts - a.pts; });
    var totals = {fgm:0, fga:0, fg3m:0, fg3a:0, ftm:0, fta:0, pts:0, ast:0, stl:0, blk:0, to:0, oreb:0, dreb:0, reb:0};
    arr.forEach(function(p){
      for(var k in totals) totals[k] += p[k] || 0;
    });
    return {players: arr, totals: totals};
  }
  return {home: finalize('home'), away: finalize('away')};
}
```

**Store as `cs._pbpPlayerStats`** in `refreshLiveCardsWNBA()` after parsing plays:
```javascript
cs._pbpPlayerStats = compilePBPPlayerStats(plays, hE, aE);
```

**Usage:**
- **I1-I5 indicator detail:** `teamStat('home', 'stl')` reads from `_pbpPlayerStats.home.totals.stl`
- **Analyze button:** `buildWNBASummary` populates `players[]` from `_pbpPlayerStats.home.players`
- **Sustainability personnel:** Opus sees per-player shooting splits (zone %, assisted %, shot context)
- **Shot zone court visual:** `byPlayer` arrays for tap-to-expand zone detail

### 3P. SR Standings

SR WNBA standings confirmed working via `sr-data?league=wnba&type=standings&year=2026`.

**Replace** BDL standings fetch with SR:
```javascript
async function fetchStandings(){
  try {
    var r = await fetch(FN+'sr-data?league=wnba&type=standings&year=2026');
    if(!r.ok) return;
    var data = await r.json();
    var confs = data.conferences || [];
    standings = {};
    confs.forEach(function(c){
      var teams = [];
      // WNBA has no divisions — teams directly under conference
      (c.teams || []).forEach(function(t){
        teams.push({alias: t.alias||'', name: t.market||'', wins: t.wins||0, losses: t.losses||0});
      });
      standings[c.alias || c.name || '?'] = teams;
    });
  } catch(e){ console.warn('[Standings]', e.message); }
}
```

---

## 4. Server-Side Changes

### 4A. `poll-live-bdl.mjs` — `shooting_play` fix (2 locations)

See Section 3C for the fix pattern. Apply identically at lines 1753 and 1902. Zero NBA regression risk.

After deploying, backfill the 3 opening night games by re-fetching BDL plays and re-saving to `game_pbp`.

### 4B. analyze.js — WNBA system prompt branch (~50 lines)

Add `league` to payload, branch system prompt. Key diffs from NBA:
- Indicator names (I2='Perimeter/FT', I5='Momentum'), weights (I3=30% anchor)
- Signal trust (MC >> XGB >> Floor; floor never gates)
- Game structure (10-min quarters, 40-min, 30-sec shot clock)
- Conviction (I3+I4 DOMINANT, no I4+I5 killer pair)
- Turnovers inverse

### 4C. netlify.toml — included_files

```toml
[functions."poll-live-bdl"]
  timeout = 120
  included_files = ["netlify/functions/xgb-model.json", "netlify/functions/xgb-model-wnba.json"]
```

---

## 5. What's Genuinely Missing vs NBA v3

| Feature | NBA v3 | WNBA | Status |
|---------|--------|------|--------|
| Live scores (10s) | BDL box_scores | BDL plays | **Solved** |
| Per-player stats | box_scores players[] | PBP text extraction (`compilePBPPlayerStats`) | **Solved** |
| Shot zone court visual | PBP x,y coords → 5 zones | PBP text classification → 4 zones (corner3+above3 merged) | **Solved** |
| Per-player zone detail (tap bubble) | x,y coords + player name | Text zone + player name (`byPlayer` arrays) | **Solved** |
| Run tracking | BDL plays | BDL plays (with shooting_play fix) | **Solved** |
| Indicators/floor | Client compute from BDL | Server compute from SR (higher quality) | **Better** |
| Sust. personnel grading | Per-player box_scores | Per-player PBP stats (FGM/FGA by zone, assisted%) | **Solved** |
| Standings | BDL standings | SR standings | **Solved** |
| Paint in live QD partial | BDL box_score rollup | PBP zone data: (rim_made + paint_made) * 2 | **Solved** |
| Analysis button | BDL box_scores → summaryData | Server raw_stats_json + PBP player stats | **Solved** |
| Corner 3 vs above-break 3 | x,y coordinate split | Cannot distinguish — merged into single 3PT zone | **Permanent** (cosmetic only) |

---

## 6. Implementation Order

| # | What | Risk | Lines |
|---|------|------|-------|
| 1 | **Server fix:** `shooting_play` in poll-live-bdl.mjs (lines 1753, 1902) | **Low** | 4 |
| 2 | Copy v3.html → wnba-bdl.html | None | 0 |
| 3 | Constants: TC, W, indNames, BDL_TEAM_MATCH, ESPN_ALIAS_MAP, localStorage, title | Low | ~40 |
| 4 | `parseBDLPBP()` shooting_play fix + `byPlayer` aggregation in `aggTeam()` | Low | ~15 |
| 5 | Schedule: poll_state path, skip box_scores | Medium | ~30 |
| 6 | `compilePBPPlayerStats()` function | Medium | ~90 |
| 7 | `buildTeamEvidence()` + `buildWNBASummary()` adapters | Low | ~60 |
| 8 | Poll: `refreshLiveCardsWNBA()` (stores _pbpPlayerStats + _teamEvidence) | Medium | ~55 |
| 9 | Delete dead code (computeClientIndicators, buildV3Summary, refreshLiveCards, box_score fetches) | Low | -240 |
| 10 | Shot zone court visual: port `courtSVG()` from bdl.html, adapt for 4 zones | Medium | ~80 |
| 11 | I1-I5 indicator detail: read from `_pbpPlayerStats` / `_teamEvidence`, I2 perimeter/FT | Medium | ~40 |
| 12 | QD grid: column reorder + live partial from `_teamEvidence` | Low | ~20 |
| 13 | Inline conviction: WNBA killer pairs | Low | ~15 |
| 14 | Analyze: `buildWNBASummary` with PBP player stats + league payload | Medium | ~25 |
| 15 | analyze.js: WNBA system prompt branch | Medium | ~50 |
| 16 | SR standings: `fetchStandings()` via sr-data proxy | Low | ~20 |
| 17 | Alert toast: `&league=wnba` | Low | 1 |
| 18 | ESPN: `league=wnba` | Low | 2 |
| 19 | netlify.toml: included_files | None | 1 |
| 20 | Demo mode: opening night presets | Low | ~10 |
| 21 | Game status updates in poll loop | Low | ~10 |
| 22 | Backfill: re-parse 3 opening night games to fix empty game_pbp data | Low | script |
| 23 | Smoke test | — | — |

**Estimated net: ~3,900 lines (3,959 - 240 dead + ~180 new)**

---

## 7. Resolved Questions

| # | Question | Resolution |
|---|----------|------------|
| 1 | Team colors | Brightest per team for dark bg. PDX/TOR approximate. |
| 2 | ESPN alias mapping | All 15 verified. Map = LEAGUES.wnba.aliasMap. |
| 3 | BDL plays live | Verified. No `shooting_play`, no `coordinate_x`. |
| 4 | BDL team_stats fields | `fouls` not `pf`, `turnovers` not `to`, no `pts`. |
| 5 | Merge timeline | 2-3 weeks stable. |
| 6 | `shooting_play` missing | **3 fix locations** (client + server x2). Type-regex fallback. Zero NBA regression. |
| 7 | ntfy event-driven | Scrapped. Plain 10s/60s polling. |
| 8 | 3PT classification | Already correct via `tx.includes('three point')`. |
| 9 | XGB model included_files | Add to netlify.toml defensively. |
| 10 | Game status chain | poll_state → BDL plays → ESPN scoreboard. |
| 11 | summaryData for analyze | Build from server raw_stats_json + PBP player stats. |
| 12 | Shot zone court visual | **NOT dead.** Text classification → 4 zones. Port `courtSVG()` from bdl.html. |
| 13 | Per-player stats | **Solved.** `compilePBPPlayerStats()` from play text extraction. |
| 14 | Sustainability personnel | **Solved.** PBP player stats provide per-player shooting by zone. |
| 15 | Standings | **Solved.** SR has WNBA standings (`sr-data?league=wnba&type=standings`). |
| 16 | game_pbp data empty | **Root cause:** `shooting_play` bug on server. Fix + backfill 3 opening night games. |

---

*End of spec.*

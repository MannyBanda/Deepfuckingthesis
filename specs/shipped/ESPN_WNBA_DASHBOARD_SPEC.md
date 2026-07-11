# ESPN WNBA Phase 4 — Dashboard Integration Spec

**Date:** May 15, 2026
**Status:** SPEC — awaiting confirmation before implementation
**Scope:** `wnba-bdl.html` + `espn-data.js`. WNBA only. NBA untouched.

---

## Goal

Replace BDL as the dashboard's 10s polling source for WNBA. ESPN summary becomes primary for score/clock, team stats (indicators), and WP. BDL demoted to 30-60s PBP-only features. Eliminates the 90s stale data problem.

---

## Architecture: Before → After

### Before (current)
```
Every 10s:
  BDL games (2 dates)        → score/clock for ALL games     [90s stale]
  Per LIVE game:
    BDL plays                 → pbpAudit, scoring events      [90s stale]
    BDL team_stats            → _teamEvidence → indicators    [90s stale]

Every 30s:
  ESPN winprob per game       → espnWP, wpHistory             [~5-15s]

Every 60s:
  DB snapshots                → _serverFloor, MC, XGB, sust
```

### After (proposed)
```
Every 10s:
  ESPN scoreboard (1 call)    → score/clock/status ALL games  [~5-15s]
  Per LIVE game:
    ESPN summary (via proxy)  → team stats + WP + bench       [~5-15s]
    → _teamEvidence → indicators
    → espnWP, wpHistory (folded in — no separate 30s)
    IF ESPN FAILS for a game:
      BDL team_stats fallback  → _teamEvidence → indicators   [90s stale, but never dark]

Every 30s:
  Per LIVE game:
    BDL plays                 → pbpAudit, scoring events, shot zones [90s stale, OK for drill-downs]
    (also provides score/clock from last play as secondary backup)

Every 60s:
  DB snapshots                → _serverFloor, MC, XGB, sust  [unchanged]
```

**Fallback hierarchy for score/clock:** ESPN scoreboard (10s) → ESPN summary header (10s) → BDL plays last play (30s).
**Fallback hierarchy for indicators:** ESPN summary boxscore (10s) → BDL team_stats on ESPN failure (10s) → server floor via DB snapshots (60s).

**Net effect:** Indicators update at ESPN speed (~5-15s) instead of BDL speed (~90s). If ESPN hiccups for a game, that game degrades to BDL 90s data for that cycle — never goes dark. PBP drill-downs (shot zones, margin flow, scoring comp, forced/unforced TOs) remain on BDL at 30s cadence — acceptable since none are on the critical betting-decision path.

---

## File 1: `netlify/functions/espn-data.js`

### Change: Extend `type=winprob` response to include boxscore + header

The `winprob` handler already fetches the full ESPN summary. It currently extracts WP, predictor, officials, season series but **strips the boxscore**. Add three new fields to the response.

**Location:** Inside the `if (type === 'winprob')` block, after the existing extractions (officials, season series) and before the `return` statement (~line 170).

**New extraction code (insert before the return):**

```javascript
// ── BOXSCORE TEAM STATS (for dashboard indicators) ──
var boxscore = null;
var boxTeams = data.boxscore?.teams || [];
if (boxTeams.length >= 2) {
  boxscore = boxTeams.map(function(bt) {
    return {
      homeAway: bt.homeAway,
      abbr: bt.team?.abbreviation || '',
      statistics: (bt.statistics || []).map(function(st) {
        return { name: st.name, displayValue: st.displayValue };
      }),
    };
  });
}

// ── PLAYERS (minimal: name, starter, points, position for bench calc) ──
var players = null;
var boxPlayers = data.boxscore?.players || [];
if (boxPlayers.length >= 2) {
  players = boxPlayers.map(function(bp) {
    return {
      homeAway: bp.homeAway || '',
      abbr: bp.team?.abbreviation || '',
      athletes: (bp.statistics?.[0]?.athletes || []).map(function(a) {
        var keys = bp.statistics?.[0]?.keys || [];
        var ptsIdx = keys.indexOf('points');
        return {
          name: a.athlete?.displayName || '',
          position: a.athlete?.position?.abbreviation || '',
          starter: !!a.starter,
          didNotPlay: !!a.didNotPlay,
          points: ptsIdx >= 0 ? (Number(a.stats?.[ptsIdx]) || 0) : 0,
        };
      }),
    };
  });
}

// ── HEADER (score, period, clock, status, linescores) ──
var header = null;
if (comp.competitors) {
  header = {
    homeScore: homeTeam?.score ? parseInt(homeTeam.score) : null,
    awayScore: awayTeam?.score ? parseInt(awayTeam.score) : null,
    period: comp.status?.period || 0,
    clock: comp.status?.displayClock || '',
    status: comp.status?.type?.name || '',
    linescores: {
      home: (homeTeam?.linescores || []).map(function(ls) { return Number(ls.value || 0); }),
      away: (awayTeam?.linescores || []).map(function(ls) { return Number(ls.value || 0); }),
    },
  };
}
```

**Modify the return body** to include the three new fields:

```javascript
// Add to the return JSON object:
boxscore: boxscore,
players: players,
header: header,
```

**Impact:** ~40 lines added. Existing fields (current, opening, wpHistory, predictor, officials, seasonseries) unchanged. Backward compatible — NBA dashboard doesn't use these new fields.

---

## File 2: `wnba-bdl.html`

### Change 2a: New global state variables

**Location:** After `var _pbpPlayCount = {};` (line ~529)

```javascript
var _lastBDLPBPRefresh = 0; // throttle BDL plays to 30s
```

### Change 2b: New function `buildTeamEvidenceFromESPN(espnData, game)`

**Location:** After existing `buildTeamEvidence` function (line ~840)

This parses the ESPN boxscore team stats into the same `_teamEvidence` shape that `computeClientIndicators` reads, but with the bonus fields BDL is missing.

```javascript
function buildTeamEvidenceFromESPN(espnData, game) {
  if (!espnData || !espnData.boxscore || espnData.boxscore.length < 2) return null;
  var hA = ESPN_ALIAS_MAP[game.home?.alias] || game.home?.alias || '';
  var aA = ESPN_ALIAS_MAP[game.away?.alias] || game.away?.alias || '';
  var homeBox = espnData.boxscore.find(function(b) { return b.homeAway === 'home'; });
  var awayBox = espnData.boxscore.find(function(b) { return b.homeAway === 'away'; });
  if (!homeBox || !awayBox) return null;

  function parseStats(statsArr) {
    var s = { stl:0, blk:0, turnovers:0, pf:0, fta:0, ftm:0, fg3a:0, fg3m:0,
              fga:0, fgm:0, ast:0, oreb:0, dreb:0, reb:0, pts:0,
              paint:0, fbp:0, pot:0, scp:0, biggest_lead:0,
              lead_changes:0, lead_pct:0, bench:0 };
    (statsArr || []).forEach(function(st) {
      var v = st.displayValue;
      if (st.name === 'fieldGoalsMade-fieldGoalsAttempted') {
        var p = v.split('-'); s.fga = Number(p[1]) || 0; s.fgm = Number(p[0]) || 0;
      } else if (st.name === 'threePointFieldGoalsMade-threePointFieldGoalsAttempted') {
        var p = v.split('-'); s.fg3a = Number(p[1]) || 0; s.fg3m = Number(p[0]) || 0;
      } else if (st.name === 'freeThrowsMade-freeThrowsAttempted') {
        var p = v.split('-'); s.fta = Number(p[1]) || 0; s.ftm = Number(p[0]) || 0;
      } else if (st.name === 'assists') { s.ast = +v; }
      else if (st.name === 'steals') { s.stl = +v; }
      else if (st.name === 'blocks') { s.blk = +v; }
      else if (st.name === 'turnovers') { s.turnovers = +v; }
      else if (st.name === 'fouls') { s.pf = +v; }
      else if (st.name === 'offensiveRebounds') { s.oreb = +v; }
      else if (st.name === 'defensiveRebounds') { s.dreb = +v; }
      else if (st.name === 'totalRebounds') { s.reb = +v; }
      else if (st.name === 'pointsInPaint') { s.paint = +v; }
      else if (st.name === 'fastBreakPoints') { s.fbp = +v; }
      else if (st.name === 'turnoverPoints') { s.pot = +v; }
      else if (st.name === 'largestLead') { s.biggest_lead = +v; }
      else if (st.name === 'leadChanges') { s.lead_changes = +v; }
      else if (st.name === 'leadPercentage') { s.lead_pct = +v; }
    });
    // Derived: pts from FG if not directly available
    s.pts = (s.fgm - s.fg3m) * 2 + s.fg3m * 3 + s.ftm;
    return s;
  }

  var hStats = parseStats(homeBox.statistics);
  var aStats = parseStats(awayBox.statistics);

  // Bench points from player starter flags
  if (espnData.players && espnData.players.length >= 2) {
    var homePl = espnData.players.find(function(p) { return p.homeAway === 'home'; });
    var awayPl = espnData.players.find(function(p) { return p.homeAway === 'away'; });
    if (homePl) {
      var hStarterPts = (homePl.athletes || []).filter(function(a) { return a.starter; })
        .reduce(function(t, a) { return t + (a.points || 0); }, 0);
      hStats.bench = Math.max(0, hStats.pts - hStarterPts);
    }
    if (awayPl) {
      var aStarterPts = (awayPl.athletes || []).filter(function(a) { return a.starter; })
        .reduce(function(t, a) { return t + (a.points || 0); }, 0);
      aStats.bench = Math.max(0, aStats.pts - aStarterPts);
    }
  }

  return { home: hStats, away: aStats, source: 'espn' };
}
```

**Impact:** ~55 lines. New function, no existing code modified.

### Change 2c: Restructure `refreshLiveCards()` (line ~753)

Replace the current function body. The new flow:

1. **ESPN scoreboard** (1 call, all games) → score/clock/status
2. **Per LIVE game: ESPN summary** (parallel) → team stats + WP
3. **Per LIVE game: BDL plays** (throttled 30s) → PBP features
4. `computeClientIndicators` + render

```javascript
async function refreshLiveCards() {
  try {
    // ─── 1. ESPN SCOREBOARD — score/clock/status for ALL games (1 call) ───
    try {
      var d = getSlateDate(dateOffset);
      var dateStr = d.year + d.month + d.day;
      var sbResp = await fetch(FN + 'espn-data?type=scoreboard&league=wnba&date=' + dateStr);
      if (sbResp.ok) {
        var sbData = await sbResp.json();
        var eg = sbData.games || [];
        games.forEach(function(g) {
          var hA = g.home?.alias || '', aA = g.away?.alias || '';
          var hE = ESPN_ALIAS_MAP[hA] || hA, aE = ESPN_ALIAS_MAP[aA] || aA;
          var match = eg.find(function(e) {
            return (e.homeAbbr === hA || e.homeAbbr === hE) && (e.awayAbbr === aA || e.awayAbbr === aE);
          });
          if (!match) return;
          // Also map ESPN ID if not yet mapped
          if (match.espnId && !espnGameMap[g.id]) espnGameMap[g.id] = match.espnId;
          if (match.homeScore != null) g.homePoints = match.homeScore;
          if (match.awayScore != null) g.awayPoints = match.awayScore;
          if (match.period) g.period = match.period;
          if (match.clock && match.clock !== '0.0') g.clock = match.clock;
          var ms = (match.status || '').replace('STATUS_', '').toLowerCase();
          if (ms === 'final') g.status = 'closed';
          else if (ms === 'in_progress' || ms === 'halftime' || ms === 'end_period') g.status = 'inprogress';
        });
      }
    } catch (e) { console.warn('[ESPN-SB]', e.message); }

    // ─── 2. Per LIVE game: ESPN summary (team stats + WP) ───
    var liveGames = games.filter(function(g) {
      return getState(g) === 'LIVE' && espnGameMap[g.id] && cardState[g.id];
    });
    if (liveGames.length > 0) {
      await Promise.all(liveGames.map(async function(g) {
        var cs = cardState[g.id];
        var espnId = espnGameMap[g.id];

        // ESPN summary — team stats + WP + header (10s)
        var espnOk = false;
        try {
          var r = await fetch(FN + 'espn-data?type=winprob&league=wnba&event_id=' + espnId);
          if (r.ok) {
            var data = await r.json();

            // 2a. Score/clock/period from header (more precise than scoreboard)
            if (data.header) {
              if (data.header.homeScore != null) g.homePoints = data.header.homeScore;
              if (data.header.awayScore != null) g.awayPoints = data.header.awayScore;
              if (data.header.period) g.period = data.header.period;
              if (data.header.clock) g.clock = data.header.clock;
              var hs = (data.header.status || '').replace('STATUS_', '').toLowerCase();
              if (hs === 'final') g.status = 'closed';
            }

            // 2b. Team evidence from ESPN boxscore
            var espnEvidence = buildTeamEvidenceFromESPN(data, g);
            if (espnEvidence) {
              cs._teamEvidence = espnEvidence;
              cs._teamEvidenceSource = 'espn';
              espnOk = true;
            }

            // 2c. WP (folded into 10s — no separate 30s cycle)
            if (data.current && data.current.homeWinPct != null) {
              var homeWP = Math.round(data.current.homeWinPct * 100);
              cs.espnWP = {
                home: homeWP, away: 100 - homeWP,
                opening: data.opening ? Math.round(data.opening.homeWinPct * 100) : null
              };
              if (data.wpHistory && data.wpHistory.length > 0) {
                cs.espnWPHistory = data.wpHistory;
                if (getState(g) === 'FINAL') {
                  try { localStorage.setItem('wnba:wpHist:' + g.id, JSON.stringify(cs.espnWPHistory)); } catch (e) {}
                }
              }
            }
          }
        } catch (e) { console.warn('[ESPN-SUM]', g.id, e.message); }

        // 2e. BDL team_stats FALLBACK — only if ESPN failed for this game
        if (!espnOk) {
          try {
            var bdlId = bdlGameMap[g.id];
            if (bdlId) {
              var tsRes = await bdl('team_stats', { game_id: bdlId, league: 'wnba' });
              var tsData = (tsRes && tsRes.data) || [];
              if (tsData.length >= 2) {
                cs._bdlTeamStats = tsData;
                cs._teamEvidence = buildTeamEvidence(tsData, g);
                cs._teamEvidenceSource = 'bdl-fallback';
              }
            }
          } catch (e2) { console.warn('[BDL-FALLBACK]', g.id, e2.message); }
        }

        // 2d. Compute client-side indicators from ESPN data (10s)
        var _ci = computeClientIndicators(g.id);
        if (_ci) cs.clientInd = _ci;

        // Persist ESPN WP history when game goes FINAL
        if (getState(g) === 'FINAL') {
          if (cs.espnWPHistory && cs.espnWPHistory.length > 10 && !cs._wpSaved) {
            cs._wpSaved = true;
            try { localStorage.setItem('wnba:wpHist:' + g.id, JSON.stringify(cs.espnWPHistory)); } catch (e) {}
          }
        }
      }));
    }

    // ─── 3. BDL plays — throttled to 30s for PBP features ───
    if (Date.now() - _lastBDLPBPRefresh >= 30000) {
      _lastBDLPBPRefresh = Date.now();
      var pbpGames = games.filter(function(g) {
        return getState(g) === 'LIVE' && bdlGameMap[g.id] && cardState[g.id];
      });
      if (pbpGames.length > 0) {
        await Promise.all(pbpGames.map(async function(g) {
          var bdlId = bdlGameMap[g.id];
          var cs = cardState[g.id];
          var hA = g.home?.alias || '', aA = g.away?.alias || '';
          var hE = ESPN_ALIAS_MAP[hA] || hA, aE = ESPN_ALIAS_MAP[aA] || aA;
          try {
            var plRes = await bdl('plays', { game_id: bdlId, league: 'wnba' });
            var plays = (plRes && plRes.data) || [];
            if (plays.length > 0) {
              // Fingerprint — skip if play count unchanged
              var prev = _pbpPlayCount[g.id] || 0;
              if (plays.length !== prev) {
                _pbpPlayCount[g.id] = plays.length;
                cs.pbpAudit = parseBDLPBP(plays, hE, aE);
                cs._bdlPlays = plays;
                cs._pbpPlayerStats = compilePBPPlayerStats(plays, hE, aE);
                cs.pbpWindow = computePBPWindow(cs.pbpAudit, hE, aE);
                buildScoringCompForCard(g.id);
              }
            }
          } catch (e) { console.warn('[BDL-PBP]', g.id, e.message); }
        }));
      }
    }

    // Render
    renderPills();
    games.forEach(function(g) { renderCard(g.id); });
  } catch (e) { console.warn('[POLL]', e.message); }

  pollAlerts();
  maybeResyncTheses();
  maybeResyncSnapshots();
  // maybeRefreshEspnWP REMOVED — folded into ESPN summary above
  maybeRefreshOdds();
}
```

**What's removed:**
- BDL `games` score fetch (replaced by ESPN scoreboard + summary header + BDL plays last-play backup)
- `maybeRefreshEspnWP()` call (WP folded into 10s summary)

**What's kept as fallback:**
- BDL `team_stats` — fires ONLY when ESPN summary fails for a game. Uses existing `buildTeamEvidence()`. Logs `[BDL-FALLBACK]` so you can see when it activates.

**What's kept but throttled:**
- BDL `plays` fetch — every 30s instead of 10s

### Change 2d: Update `computeClientIndicators` to use ESPN fields

**Location:** line ~2397

Two targeted changes inside `computeClientIndicators`:

**I1 — POT now from _teamEvidence (ESPN has it directly):**

Current code (line ~2419):
```javascript
var hPOT=bdl?bdl.potHome||0:0,aPOT=bdl?bdl.potAway||0:0;
```

Replace with:
```javascript
var hPOT = te.home.pot || (bdl ? bdl.potHome || 0 : 0);
var aPOT = te.away.pot || (bdl ? bdl.potAway || 0 : 0);
```

**I4 — biggest_lead now from _teamEvidence (ESPN has it directly):**

Current code (line ~2456):
```javascript
var hBL=bdl?bdl.biggestLeadHome||0:0,aBL=bdl?bdl.biggestLeadAway||0:0;
```

Replace with:
```javascript
var hBL = te.home.biggest_lead || (bdl ? bdl.biggestLeadHome || 0 : 0);
var aBL = te.away.biggest_lead || (bdl ? bdl.biggestLeadAway || 0 : 0);
```

**Impact:** 2 lines changed. ESPN values preferred, BDL PBP as fallback.

### Change 2e: Update `buildIndEvidence` for I4

**Location:** line ~1970 (inside I4 evidence section)

Current code:
```javascript
if(pbp&&pbp._bdl){
  html+=evRow('Big Lead',pbp._bdl.biggestLeadHome||0,pbp._bdl.biggestLeadAway||0);
}
```

Replace with:
```javascript
var evBLH_src = (te && te.home && te.home.biggest_lead) ? te.home.biggest_lead : (pbp && pbp._bdl ? pbp._bdl.biggestLeadHome || 0 : 0);
var evBLA_src = (te && te.away && te.away.biggest_lead) ? te.away.biggest_lead : (pbp && pbp._bdl ? pbp._bdl.biggestLeadAway || 0 : 0);
html += evRow('Big Lead', evBLH_src, evBLA_src);
```

Also update the subA verdict calculation below it to use these same variables instead of re-reading from `pbp._bdl`.

**Impact:** ~6 lines. ESPN biggest_lead preferred, PBP fallback.

### Change 2f: Add I1 evidence rows for paint, FBP, POT from ESPN

**Location:** Inside `buildIndEvidence`, I1 section (line ~1940)

After the existing forced/unforced TO rows, add:
```javascript
// ESPN-sourced stats (not available from BDL WNBA)
if (_te && _te.source === 'espn') {
  html += evRow('Pts off TO', _te.home.pot || 0, _te.away.pot || 0);
  html += evRow('Fast Break', _te.home.fbp || 0, _te.away.fbp || 0);
}
```

And for I2, add paint evidence:
```javascript
if (_te && _te.source === 'espn') {
  html += evRow('Paint', _te.home.paint || 0, _te.away.paint || 0);
}
```

**Impact:** ~8 lines. New evidence rows only render when ESPN data available.

### Change 2g: Remove `maybeRefreshEspnWP` from polling cadence

**Location:** The function itself stays (for backward compat if called elsewhere), but the call is removed from `refreshLiveCards` (already handled in change 2c).

If the ONLY caller is `refreshLiveCards`, the function body can be gutted to a no-op or left as dead code for now.

---

## Section-by-Section Code Path Trace

### Section 1: HERO (score/clock/status)

**Renders at:** `renderCard` lines 1296-1315

**Reads:** `g.homePoints`, `g.awayPoints`, `g.period`, `g.clock` (on the game object directly, not cardState)

**Current write locations (3 writers):**

| Writer | Line | Source | When |
|--------|------|--------|------|
| `buildBdlGameMap()` | 620-626 | BDL `games` endpoint | Once at startup (`loadSchedule`) |
| `refreshLiveCards()` top | 767-773 | BDL `games` (both dates) | Every 10s |
| `refreshLiveCards()` plays | 793-797 | BDL `plays` last play | Every 10s per LIVE game |

**New write locations (3 writers):**

| Writer | Line | Source | When |
|--------|------|--------|------|
| `buildBdlGameMap()` | 620-626 | BDL `games` endpoint | Once at startup — **UNCHANGED** |
| `refreshLiveCards()` top | NEW | ESPN scoreboard (1 call all games) | Every 10s |
| `refreshLiveCards()` ESPN summary | NEW | ESPN summary `header` (per LIVE game) | Every 10s, overwrites scoreboard with more precise values |
| `refreshLiveCards()` BDL plays | MOVED | BDL `plays` last play | Every 30s (throttled, provides backup score) |

**What changes:**
- Lines 756-775 (BDL `games` score fetch block) → **REPLACED** by ESPN scoreboard block
- Lines 793-797 (BDL plays score overwrite) → **MOVED** into the 30s BDL PBP throttle block
- ESPN summary `header` provides per-LIVE-game score/clock/period/status at 10s

**Field compatibility:** Identical — `homeScore`/`awayScore`/`period`/`clock` from ESPN map directly to `g.homePoints`/`g.awayPoints`/`g.period`/`g.clock`.

**`renderCard` reads — no changes needed:**
- Line 1296: `g.period` for period label → same field, faster data
- Line 1298: `g.clock` for status text → same field, faster data
- Line 1315: `g.awayPoints`, `g.homePoints` for score display → same fields, faster data

**Other reads of score fields — no changes needed:**
- Line 1025: `renderPills` — `g.period` for "Q3" in pill label
- Line 1636: `renderCard` sustainability — margin calc from `g.homePoints - g.awayPoints`
- Line 2411: `computeClientIndicators` — `g.period` for I4 Q4 detection
- Line 3506: `buildScoringCompForCard` — `g.homePoints, g.awayPoints`

---

### Section 2: ESPN WP Chart

**Renders at:** `renderCard` lines 1321-1420 (WP chart block)

**Reads:** `cs.espnWP` (current WP), `cs.espnWPHistory` (chart data), `cs._allSnapshots` (structural chart)

**Current write flow:**
1. `mountAllCards()` line 1067 → `fetchEspnWP()` per game (initial load)
2. `maybeRefreshEspnWP()` line 831 → `fetchEspnWP()` every 30s during live games
3. `fetchEspnWP()` line 1841 → calls `espn-data?type=winprob` → writes `cs.espnWP`, `cs.espnWPHistory`
4. `hydrateFromServerSnapshots()` line 2109 → fallback from DB snapshot `espn_wp_home/away`

**`fetchEspnWP` writes (line 1850-1855):**
```javascript
cs.espnWP = {home: homeWP, away: 100-homeWP, opening: ...};
cs.espnWPHistory = data.wpHistory;
```

**New write flow:**
1. `mountAllCards()` line 1067 → `fetchEspnWP()` per game — **UNCHANGED** (initial load still needs dedicated WP call)
2. `refreshLiveCards()` ESPN summary → writes same `cs.espnWP` and `cs.espnWPHistory` at 10s — **NEW, REPLACES maybeRefreshEspnWP**
3. `hydrateFromServerSnapshots()` line 2109 — **UNCHANGED** (DB fallback stays)

**What changes:**
- `maybeRefreshEspnWP()` call REMOVED from end of `refreshLiveCards` (line 831)
- `fetchEspnWP` function KEPT (still called by `mountAllCards` at startup)
- `maybeRefreshEspnWP` function KEPT (harmless dead code, or can be deleted)
- WP data now written in the ESPN summary block of `refreshLiveCards` using identical field names

**Field compatibility:** Identical — new code writes `cs.espnWP = {home, away, opening}` and `cs.espnWPHistory = data.wpHistory` using the same response shape from the same proxy endpoint.

**`renderCard` reads — no changes needed:**
- Line 1321: `cs.espnWP` gate — same object shape
- Lines 1323-1325: `cs.espnWP.home`, `.away`, `.opening` — same fields
- Line 1688: `cs.espnWPHistory` for chart rendering — same array
- Lines 819-821: FINAL persistence of `cs.espnWPHistory` — same logic, moved into new flow

---

### Section 3: Structural Read — Floor Meter + I1-I5 Pills

**Renders at:** `renderCard` lines 1525-1630

**Reads:** `getFloor(cs)` → returns object with `{score, controlTeam, I1, I2, I3, I4, I5, source}`

**`getFloor` priority chain (line 2051-2057):**
```
1. cs.sonnetIndicators  → from Opus analysis (syncAnalysesFromDB)
2. cs.clientInd          → from computeClientIndicators (10s poll)  ← THIS GETS FASTER
3. cs._serverFloor       → from DB snapshots (60s hydration)
4. cs.rollingWindow      → from quarter_data DB
```

**`cs.clientInd` write path:**
```
refreshLiveCards → computeClientIndicators(gameId) → cs.clientInd
```

**`computeClientIndicators` input chain (line 2397-2495):**
```
cs._teamEvidence (te)     → I1 stl/blk, I2 fg3a/fg3m/fta, I3 fgm/fga/ast, I5 oreb/dreb
cs.pbpAudit._bdl (bdl)    → I1 POT, I4 biggestLead
cs.pbpAudit.scoringEvents → I4 Q4 scoring delta
```

**Current `_teamEvidence` → `computeClientIndicators` field map:**

| Indicator | Field reads from `te` | Field reads from `pbp._bdl` | Change needed? |
|---|---|---|---|
| I1 Disruption subA | `te.home.stl`, `te.home.blk` | — | ❌ No — same field names in ESPN |
| I1 Disruption subB (POT) | — | `bdl.potHome`, `bdl.potAway` | ✅ YES — ESPN has `te.home.pot` directly |
| I1 Chaos layer | — | `pbp.home.tos.forced/unforced` | ❌ No — still from BDL PBP (30s) |
| I2 3PT subA | `te.home.fg3a`, `te.home.fg3m` | — | ❌ No — same field names |
| I2 FTA subB | `te.home.fta` | — | ❌ No — same field names |
| I3 eFG | `te.home.fgm`, `te.home.fga`, `te.home.fg3m` | — | ❌ No — same field names |
| I3 Assists | `te.home.ast` | — | ❌ No — same field names |
| I4 Big Lead subA | — | `bdl.biggestLeadHome/Away` | ✅ YES — ESPN has `te.home.biggest_lead` |
| I4 Q4 scoring subB | — | `pbp.scoringEvents` | ❌ No — still from BDL PBP (30s) |
| I5 Rebounds | `te.home.oreb`, `te.home.dreb` | — | ❌ No — same field names |

**Exact code changes in `computeClientIndicators`:**

Line ~2419 (I1 POT):
```javascript
// BEFORE:
var hPOT=bdl?bdl.potHome||0:0,aPOT=bdl?bdl.potAway||0:0;
// AFTER:
var hPOT = te.home.pot || (bdl ? bdl.potHome || 0 : 0);
var aPOT = te.away.pot || (bdl ? bdl.potAway || 0 : 0);
```

Line ~2456 (I4 biggest lead):
```javascript
// BEFORE:
var hBL=bdl?bdl.biggestLeadHome||0:0,aBL=bdl?bdl.biggestLeadAway||0:0;
// AFTER:
var hBL = te.home.biggest_lead || (bdl ? bdl.biggestLeadHome || 0 : 0);
var aBL = te.away.biggest_lead || (bdl ? bdl.biggestLeadAway || 0 : 0);
```

**Impact on getFloor chain:** Zero. `computeClientIndicators` returns the same `{score, controlTeam, I1-I5}` shape. `getFloor` sees `cs.clientInd` at priority 2 exactly as before — it's just populated faster (10s ESPN vs 90s BDL) and with more data (POT, biggest_lead non-zero).

**`renderCard` reads of floor — no changes needed:**
- Line 1527: `getFloor(cs)` call — unchanged
- Line 1537: `floor.score` for floor meter — unchanged
- Line 1538: `floor.controlTeam` for team color — unchanged
- Lines 1611-1629: I1-I5 pill loop, reads `floor[indKey].score` and `floor[indKey].leader` — unchanged

---

### Section 4: Indicator Evidence Panels

**Renders at:** `buildIndEvidence()` line 1908, called from `renderCard` line 1631

**Reads:** `cs._teamEvidence` (via `_te`), `cs._pbpPlayerStats` (via `_pbs`), `cs.pbpAudit` (via `pbp`)

**`tStat` helper (line 1940-1943):** Reads from `_pbs` first (PBP-derived player totals), falls back to `_te` (team stats). Both are side-keyed (`home`/`away`).

**Per-indicator evidence reads:**

| Indicator | Evidence rows | Source | Change needed? |
|---|---|---|---|
| **I1** | Steals | `tStat('home','stl')` → `_te.home.stl` | ❌ No — same field name |
| | Blocks | `tStat('home','blk')` → `_te.home.blk` | ❌ No |
| | Turnovers | `tStat('home','to')` or `tStat('home','turnovers')` | ❌ No — ESPN has `turnovers` |
| | Forced TO | `pbp.home.tos.forced` | ❌ No — BDL PBP, 30s |
| | Unforced TO | `pbp.home.tos.unforced` | ❌ No — BDL PBP, 30s |
| | **NEW: Pts off TO** | — | ✅ ADD — `_te.home.pot` (ESPN-only) |
| | **NEW: Fast Break** | — | ✅ ADD — `_te.home.fbp` (ESPN-only) |
| **I2** | FTA, FTM | `tStat('home','fta')`, `tStat('home','ftm')` | ❌ No |
| | FG3A, FG3M | `tStat('home','fg3a')`, `tStat('home','fg3m')` | ❌ No |
| | **NEW: Paint** | — | ✅ ADD — `_te.home.paint` (ESPN-only) |
| **I3** | eFG% | Computed from `fgm`, `fga`, `fg3m` | ❌ No |
| | 3PT | `fg3m/fg3a` | ❌ No |
| | Assists, Ast Ratio | `tStat('home','ast')` | ❌ No |
| **I4** | Big Lead | `pbp._bdl.biggestLeadHome\|Away` (line 1974) | ✅ CHANGE — prefer `_te.home.biggest_lead` |
| | Per-Q margins | `cs._serverQDBoundaries` | ❌ No — DB data |
| | SubA verdict | `pbp._bdl.biggestLeadHome\|Away` (lines 1993-1994) | ✅ CHANGE — prefer `_te.home.biggest_lead` |
| | SubB Q4 delta | `pbp.scoringEvents` | ❌ No — BDL PBP |
| | Lead Chg / Ties | `pbp.scoringEvents` | ❌ No — BDL PBP |
| **I5** | Runs (6+) | `pbp.runs6` or `pbp._bdl.scoreLog` | ❌ No — BDL PBP |
| | FG% | `tStat('home','fgm')`, `tStat('home','fga')` | ❌ No |

**Exact code changes in `buildIndEvidence`:**

I1 section — add new ESPN-only rows after unforced TO (after line ~1953):
```javascript
if (_te && _te.source === 'espn') {
  html += evRow('Pts off TO', _te.home.pot || 0, _te.away.pot || 0);
  html += evRow('Fast Break', _te.home.fbp || 0, _te.away.fbp || 0);
}
```

I2 section — add paint row after FG3M (after line ~1960):
```javascript
if (_te && _te.source === 'espn') {
  html += evRow('Paint', _te.home.paint || 0, _te.away.paint || 0);
}
```

I4 Big Lead row — line 1974, prefer ESPN (change from):
```javascript
if(pbp&&pbp._bdl){
  html+=evRow('Big Lead',pbp._bdl.biggestLeadHome||0,pbp._bdl.biggestLeadAway||0);
}
```
To:
```javascript
var _blH = (_te && _te.home.biggest_lead) ? _te.home.biggest_lead : (pbp && pbp._bdl ? pbp._bdl.biggestLeadHome || 0 : 0);
var _blA = (_te && _te.away.biggest_lead) ? _te.away.biggest_lead : (pbp && pbp._bdl ? pbp._bdl.biggestLeadAway || 0 : 0);
if (_blH || _blA) { html += evRow('Big Lead', _blH, _blA); }
```

I4 SubA verdict — lines 1993-1994, use same `_blH`/`_blA` variables instead of re-reading from PBP:
```javascript
// BEFORE:
var evBLH=pbp&&pbp._bdl?pbp._bdl.biggestLeadHome||0:0;
var evBLA=pbp&&pbp._bdl?pbp._bdl.biggestLeadAway||0:0;
// AFTER:
var evBLH = _blH;
var evBLA = _blA;
```

---

### Section 5: Drawer — Quarter Dominance Live Row

**Renders at:** `renderDrawer` lines 2950-2990

**Reads:** `cs._teamEvidence` via `_te`, `cs.pbpAudit` via `_pbp`, `cs._serverQDBoundaries`

**Current `qdFromEvidence` helper (line 2957-2961):**
```javascript
function qdFromEvidence(te, pbpSide) {
  var paintPts = 0;
  if (pbpSide) { paintPts = ((pbpSide.rim?.made||0) + (pbpSide.paint?.made||0)) * 2; }
  return { steals: te?.stl||0, turnovers: te?.turnovers||0, ..., points_in_the_paint: paintPts };
}
```

Paint is PBP-derived because BDL `_teamEvidence` didn't have it. With ESPN, `_te.home.paint` is available directly.

**Change:** Prefer `te.paint` when available, fall back to PBP-derived:
```javascript
function qdFromEvidence(te, pbpSide) {
  var paintPts = te?.paint || 0;
  if (!paintPts && pbpSide) { paintPts = ((pbpSide.rim?.made||0) + (pbpSide.paint?.made||0)) * 2; }
  return { steals: te?.stl||0, turnovers: te?.turnovers||0, ..., points_in_the_paint: paintPts };
}
```

**Impact:** 2 lines changed. ESPN paint preferred, PBP-derived fallback. All other fields (`stl`, `turnovers`, `fta`, `fg3m`, `ast`) use the same field names from both BDL and ESPN shapes.

---

## Sections NOT Changing (confirmed by trace)

| Section | Data path | Why unchanged |
|---|---|---|
| Signal strip (MC/XGB/PBP/Floor pills) | `cs._allSnapshots[last]` → snapshot columns | Reads from DB snapshot hydration (60s), not poll loop |
| Divergence callout | `computePBPDivergenceWNBA` on `cs._allSnapshots` | Same — DB snapshots |
| MC Investigation strip | `cs._serverMC` from `live_tracking` | DB hydration via `hydrateFromServerSnapshots` |
| Value Read | `cs.prediction` from `syncAnalysesFromDB` | Analyses table, not poll loop |
| Conviction bar | `cs.prediction.convictionTier` | Same — analyses DB |
| Sonnet Signal | `cs.prediction`, `cs.analysis` | Same — analyses DB + localStorage |
| MC Cum/PBP/XGB/Floor row | `cs._mcCumWp`, `cs._mcPbpWp` from `live_tracking` | DB hydration |
| MC Rate Drivers | `cs._mcDrivers` from `live_tracking` | DB hydration |
| Windows (QTR/PBP) | `cs.rollingWindow` from `quarter_data`, `cs.pbpWindow` from BDL PBP | QTR window: DB. PBP window: BDL plays (30s) |
| Sustainability rows | `cs.sustainabilityAudit` from `sust_json` | DB snapshot hydration |
| Scoring Composition | `cs.scoringComp` ← `cs.pbpAudit` | BDL plays (30s) |
| Shot Zones | `cs.pbpAudit.raw.shots` | BDL plays (30s) |
| Margin Flow | `cs.pbpAudit.scoringEvents` | BDL plays (30s) |
| Pre-Game Thesis | `theses[id]` | `syncThesesFromDB` |

- `loadSchedule()` — still reads from poll_state, still calls `buildBdlGameMap`, `fetchEspnScoreboard`, `mountAllCards`
- `buildTeamEvidence()` — kept intact, called by BDL fallback path when ESPN fails
- `hydrateFromServerSnapshots()` — still hydrates from DB on 60s cadence
- `computeClientIndicators()` — same logic, just reads ESPN fields when available
- `getFloor()` priority chain — unchanged
- `renderCard()` — unchanged (reads same cs.* fields)
- `parseBDLPBP()` — unchanged, still parses BDL plays for PBP features
- `computePBPWindow()` — unchanged
- All collapsible sections (scoring comp, shot zones, margin flow) — unchanged, still use pbpAudit
- `syncAnalysesFromDB()`, `syncCalibrationAnalyses()` — unchanged
- `pollAlerts()` — unchanged
- NBA dashboard (`bdl.html`, `v3.html`) — completely untouched

---

## ESPN → BDL Coverage Summary

| Feature | Source | Cadence | Notes |
|---------|--------|---------|-------|
| Score/clock/status | ESPN scoreboard + summary | 10s | BDL plays (30s) as backup via last play |
| Team stats (basic: FG, 3PT, FT, AST, STL, BLK, TO, REB) | ESPN summary | 10s | BDL team_stats fires on ESPN failure |
| Paint, FBP, POT, biggest_lead, bench | ESPN summary | 10s | **NEW** — BDL had zeros. No BDL fallback (BDL doesn't have these) |
| Lead changes, lead % | ESPN summary | 10s | **NEW**. No BDL fallback |
| Win probability + history | ESPN summary | 10s | was 30s separate |
| PBP audit (forced/unforced TO, runs) | BDL plays | 30s | throttled from 10s |
| Shot zones (court visual) | BDL plays | 30s | throttled from 10s |
| Scoring composition | BDL plays → pbpAudit | 30s | throttled from 10s |
| Margin flow chart | BDL plays → scoring events | 30s | throttled from 10s |
| Second chance points | BDL plays → PBP-derived | 30s | ESPN doesn't have SCP |
| Server floor, MC, XGB, sust | DB snapshots | 60s | unchanged |
| Odds | The Odds API | 30s | unchanged |

---

## Alias Safety

ESPN scoreboard uses ESPN-native abbreviations (MIN, DAL, NY, POR, etc). Our game objects use SR abbreviations (NYL, PDX, LVA, etc). The existing `ESPN_ALIAS_MAP` converts SR→ESPN for matching. This is already correct and tested — the scoreboard matching code in `fetchEspnScoreboard` (line ~649) uses the exact same pattern.

ESPN summary's `boxscore` has `homeAway` field on each team entry — we match by `homeAway` not by abbreviation, so **no alias conversion needed** for boxscore parsing.

---

## Risk Assessment

**Low risk:**
- espn-data.js change is additive (new fields in response, existing fields untouched)
- `buildTeamEvidenceFromESPN` is a new function, no existing code modified
- `computeClientIndicators` changes are 2 lines with fallback to current behavior

**Medium risk:**
- `refreshLiveCards` rewrite — this is the core poll loop. But the new version is structurally clearer (ESPN first, BDL fallback, PBP throttled). If ESPN fails for a game, BDL `team_stats` fires as fallback — indicators degrade to 90s but never go dark. Server floor still fills via 60s hydration as the last-resort backstop.

**Testing plan:**
1. Deploy, open dashboard on a live WNBA game
2. Verify indicators update on 10s cadence (not 90s)
3. Verify paint/FBP/POT/biggest_lead show real values (not 0)
4. Verify WP chart still works
5. Verify PBP features (shot zones, margin flow, scoring comp) still populate on 30s cadence
6. Verify FINAL game hydration still works (DB snapshots + analyses)
7. Verify NBA dashboard completely unaffected

---

## Line Count Estimate

| File | Added | Modified | Removed |
|------|-------|----------|---------|
| espn-data.js | ~40 | 3 (return body) | 0 |
| wnba-bdl.html | ~55 (buildTeamEvidenceFromESPN) + ~105 (refreshLiveCards incl fallback) + ~16 (indicator/evidence tweaks) | ~6 | ~45 (old refreshLiveCards body) |
| **Net** | **~175 added** | **~9 modified** | **~45 removed** |

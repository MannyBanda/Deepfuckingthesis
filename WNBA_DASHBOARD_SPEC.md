# WNBA Dashboard Spec — `wnba-bdl.html`
**Date:** May 8, 2026
**Source:** Fork from `v3.html` (3,950 lines)
**Status:** SPEC COMPLETE — awaiting implementation go-ahead

---

## 1. Architectural Overview

### Why fork, not parameterize
v3.html is 3,950 lines with NBA-specific logic woven throughout — BDL box_score polling, client-side indicator compute, NBA team color maps, NBA-specific evidence panels. Parameterizing all of this with `if (league === 'wnba')` creates regression risk during NBA playoffs. Fork now, merge later when WNBA stabilizes.

### The fundamental data flow change

**NBA v3 (dual-path):**
```
Every 10s: BDL box_scores → scores, status, player stats
           ↓
           computeClientIndicators() → client-side floor/I1-I5
           fetchLivePBP() → PBP audit, evidence panels
Every 60s: hydrateFromServerSnapshots() → server floor, XGB, MC, sustainability, quarter data
Every 30s: fetchEspnWP() → ESPN WP chart
```
Client computes its own indicators from BDL. Server snapshots are supplemental enrichment.

**WNBA (server-snapshot-only):**
```
On ntfy ping (or 30s fallback): get_latest_snapshots → scores, floor, I1-I5, XGB, MC, TP/LS
                                get_live_tracking → compound state, SHAP, MC investigation
Every 60s: hydrateFromServerSnapshots() → full snapshot history, quarter data, sustainability
Every 30s: fetchEspnWP() → ESPN WP chart
```
BDL has no `box_scores` endpoint for WNBA. The server is the sole data source for scores, indicators, and all structural signals. The client is a pure renderer.

### Event-driven refresh via ntfy

**New topic:** `dft_live_data` (separate from subscriber alert topic `manny_nba_control`)

**Server side (poll-live-bdl.mjs, 1 line):**
After all snapshots are written for a league cycle, push a lightweight ping:
```javascript
// After snapshot save loop completes for WNBA:
if (league === 'wnba' && liveCount > 0) {
  fetch(`https://ntfy.sh/dft_live_data`, {
    method: 'POST',
    headers: { 'Title': 'data', 'Priority': '1', 'Tags': 'arrow_down' },
    body: JSON.stringify({ league: 'wnba', ts: Date.now(), games: liveCount }),
  }).catch(() => {});
}
```
Priority 1 (min) = silent ping. No phone notification. Just an EventSource message.

**Client side (wnba-bdl.html):**
```javascript
// On load:
const sse = new EventSource('https://ntfy.sh/dft_live_data/sse');
sse.onmessage = function(e) {
  try {
    var msg = JSON.parse(e.data);
    var payload = JSON.parse(msg.message || '{}');
    if (payload.league === 'wnba') refreshFromServer();
  } catch(e) { /* non-fatal */ }
};
// Fallback: 30s poll timer in case SSE connection drops
var fallbackTimer = setInterval(function() {
  if (Date.now() - lastRefresh > 45000) refreshFromServer();
}, 30000);
```

**Cascading implications:**
- ntfy topic `dft_live_data` is public (no auth). Anyone can subscribe. Data is just `{league, ts, games}` — no sensitive content.
- NBA can use the same topic later (push `{league:'nba'}` pings). Client filters by league.
- SSE connection is long-lived. May drop on mobile sleep/background. The 30s fallback poll catches this.
- ntfy free tier: 250 messages/hour. At 1 push per 60s cron = 60/hour. Well under limit.
- Server push adds ~50ms latency per cron cycle (non-blocking `fetch` with `.catch()`). No risk.

---

## 2. File-Level Changes (what to touch)

| File | Change | Risk |
|------|--------|------|
| `wnba-bdl.html` | New file (fork from v3.html) | None — new file |
| `poll-live-bdl.mjs` | Add ntfy data ping after WNBA snapshot loop | Low — 3 lines, non-blocking |
| `db-api.js` | Add `league` param to `get_alerts`, add `date` param to `get_games` | Low — additive WHERE clauses |
| `analyze.js` | Add league lookup from `games` table, use `getSonnetSystemPrompt` | Medium — touches analysis path |

---

## 3. Section-by-Section Changes in `wnba-bdl.html`

### 3A. Constants & Config (lines 475-556)

**Title (line 6):** `DFT · WNBA`

**Version:** `window.__wnbaVersion = 'wnba-1.0';`

**Team colors (lines 482-489):** Replace 30 NBA teams with 15 WNBA teams.
```javascript
const TC = {
  ATL:'#E31837', CHI:'#568CBB', CON:'#DC4405', DAL:'#002B5C',
  GSV:'#582C83', IND:'#002D62', LVA:'#000000', LAS:'#552583',
  MIN:'#236192', NYL:'#6ECBA0', PHO:'#CB6015', PDX:'#E03A3E',
  SEA:'#2C5234', TOY:'#B4975A', WAS:'#002B5C',
};
```
*NOTE: These need verification against official brand guides. Portland Fire and Toronto Tempo are new.*

**Indicator weights (line 479):**
```javascript
const W = {I1:.15, I2:.20, I3:.30, I4:.25, I5:.10};
```
Weight display only — client doesn't compute indicators for WNBA.

**Indicator names (line 1329):**
```javascript
var indNames = {I1:'Disruption', I2:'Perimeter/FT', I3:'Shot Quality', I4:'Game Control', I5:'Momentum'};
```

**BDL_TEAM_MATCH (line 555):** Replace with WNBA team names:
```javascript
const BDL_TEAM_MATCH = {
  ATL:'Dream', CHI:'Sky', CON:'Sun', DAL:'Wings', GSV:'Valkyries',
  IND:'Fever', LVA:'Aces', LAS:'Sparks', MIN:'Lynx', NYL:'Liberty',
  PHO:'Mercury', PDX:'Fire', SEA:'Storm', TOY:'Tempo', WAS:'Mystics',
};
```
Used only for display (team name rendering), not for BDL game mapping.

**ESPN_ALIAS_MAP (line 548):** Needs verification from live ESPN WNBA scoreboard response. Likely:
```javascript
const ESPN_ALIAS_MAP = {};  // verify — ESPN may use NY, LV, GS, LA, etc.
```

**localStorage prefix:** All 8 occurrences of `nba4:` → `wnba:`
- `wnba:schedule:` (schedule cache)
- `wnba:theses` (theses)
- `wnba:wpHist:` (ESPN WP history)
- `wnba:analysis:` (persisted analyses)

**Cascading implication:** Separate localStorage namespaces mean NBA and WNBA dashboards can coexist in the same browser without data collision.

### 3B. Schedule Discovery (lines 598-670)

**Current NBA flow:**
1. `sr('schedule', ...)` → SR NBA schedule API
2. `buildBdlGameMap()` → BDL game ID mapping (for box_score polling)
3. `bdl('box_scores', ...)` → BDL status correction
4. `fetchEspnScoreboard()` → ESPN game ID mapping
5. `fetchStandings()` → conference rank display

**WNBA replacement:**
1. Fetch game list from DB (server already discovered and cached via poll_state)
2. Skip BDL game map (no box_scores)
3. Skip BDL status correction (snapshots have status)
4. `fetchEspnScoreboard()` with `league=wnba`
5. Skip standings (no WNBA standings in BDL yet)

```javascript
async function loadSchedule() {
  showLoading(true); showErr(null);
  try {
    var d = getSlateDate(dateOffset);
    // Fetch from poll_state schedule_json (server cached)
    var r = await fetch(FN + 'db-api?action=get_poll_state&league=wnba');
    var ps = (await r.json()).state;
    if (!ps || !ps.schedule_json) {
      games = []; showLoading(false); return;
    }
    var cached = typeof ps.schedule_json === 'string' ? JSON.parse(ps.schedule_json) : ps.schedule_json;
    games = cached.map(function(g) {
      return {
        id: g.id, status: g.status, scheduled: g.scheduled,
        home: { alias: g.home_alias, name: g.home_name || '' },
        away: { alias: g.away_alias, name: g.away_name || '' },
        homePoints: null, awayPoints: null, period: 0, clock: '',
      };
    });
    // Sort: live first, then pre, then final
    var order = {inprogress:0, halftime:0, scheduled:1, closed:2, complete:2};
    games.sort(function(a,b) {
      return (order[a.status]??1) - (order[b.status]??1)
        || new Date(a.scheduled||0) - new Date(b.scheduled||0);
    });
    document.getElementById('schedule-meta').innerHTML =
      '<span class="accent">'+esc(d.str)+'</span><span>&middot;</span><span>'
      +games.length+' WNBA games</span><span>&middot;</span><span>MST</span>';

    await fetchEspnScoreboard(); // uses league=wnba
    mountAllCards();
    // Initial hydration from server snapshots
    await refreshFromServer();
    showLoading(false);
    startEventSource(); // connect ntfy SSE
    startFallbackPoll(); // 30s safety net
  } catch(e) { showErr(e.message); showLoading(false); }
}
```

**Cascading implications:**
- No SR schedule call from client → eliminates SR rate limit concern from dashboard
- No BDL game mapping → `bdlGameMap` object removed entirely
- No `buildBdlGameMap()` function needed
- Game status comes from `poll_state.schedule_json.status` (updated by server each cron cycle) and from snapshots
- Date navigation (`dateOffset`) needs to query poll_state for the requested date, not just today. The `get_poll_state` endpoint returns the latest — need a date param or use `get_poll_history`.

**Open question:** `get_poll_state` only returns the latest entry. For date navigation (Yesterday/Today), we'd need `get_poll_history` and filter by date, or add a `date` param to `get_poll_state`. Alternatively, the WNBA dashboard can query `get_games&league=wnba` and filter client-side by date — simpler, works now.

### 3C. Poll Cycle — Replace BDL with Server Snapshots (lines 718-810)

**Delete entirely:**
- `refreshLiveCards()` function (~55 lines) — BDL box_score polling loop
- `fetchLivePBP()` function (~23 lines) — BDL plays fetch
- `_livePBPQueue` variable

**Replace with:**
```javascript
var lastRefresh = 0;

async function refreshFromServer() {
  lastRefresh = Date.now();
  if (!games.length) return;
  var liveIds = games.filter(function(g) {
    return getState(g) !== 'FINAL' || !cardState[g.id]?._allSnapshots;
  }).map(function(g) { return g.id; });
  if (liveIds.length === 0) return;

  // Batch fetch latest snapshots for all games
  try {
    var r = await fetch(FN + 'db-api?action=get_latest_snapshots&game_ids=' + encodeURIComponent(liveIds.join(',')));
    if (!r.ok) return;
    var data = (await r.json()).snapshots || {};
    var updated = false;
    for (var gid in data) {
      var s = data[gid];
      var g = games.find(function(x) { return x.id === gid; });
      if (!g) continue;
      // Update scores + status
      if (s.home_pts != null) { g.homePoints = s.home_pts; g.awayPoints = s.away_pts; }
      if (s.period) g.period = s.period;
      if (s.clock) g.clock = s.clock;
      // Update cardState with server data
      var cs = cardState[gid] || {};
      if (s.floor_score != null) {
        cs._serverFloor = {
          score: s.floor_score, controlTeam: s.floor_team,
          I1:{score:s.i1}, I2:{score:s.i2}, I3:{score:s.i3}, I4:{score:s.i4}, I5:{score:s.i5},
          source: 'server'
        };
      }
      if (s.espn_wp_home != null) {
        cs.espnWP = { home: s.espn_wp_home, away: s.espn_wp_away || (100 - s.espn_wp_home) };
      }
      updated = true;
    }
    if (updated) { renderPills(); games.forEach(function(g) { renderCard(g.id); }); }
  } catch(e) { console.warn('[REFRESH]', e.message); }

  // Periodic deeper hydration (quarter data, full history, live_tracking)
  maybeResyncSnapshots();
  // Poll alerts for toast
  pollAlerts();
  // ESPN WP chart refresh
  maybeRefreshEspnWP();
}
```

**Cascading implications:**
- `getFloor(cs)` fallback chain still works: `sonnetIndicators → clientInd → _serverFloor → rollingWindow`. For WNBA, `clientInd` will always be null (no `computeClientIndicators`). `_serverFloor` becomes the primary path. This is correct — server has SR-enriched data.
- Evidence panels (I1-I5 tap detail) lose BDL player stats. They'll show server snapshot values only (score per indicator). PBP evidence (rim/paint breakdown, forced TOs) won't be available. The panels should gracefully degrade to showing indicator scores without stat breakdowns. See Section 3E.
- `pollInterval` variable (10s) can be removed — replaced by event-driven refresh.

### 3D. Dead Code Removal (~380 lines)

| Function | Lines | Why dead |
|----------|-------|----------|
| `bdl()` helper | 1 | No BDL calls |
| `normalizeBdlStatus()` | 10 | No BDL box_scores |
| `normalizeBdlClock()` | 12 | Status from snapshots |
| `buildBdlGameMap()` | 15 | No BDL game ID mapping |
| `fetchLivePBP()` | 23 | No BDL plays |
| `buildV3Summary()` | 32 | No BDL box_score → summary conversion |
| `computeClientIndicators()` | 139 | No client-side indicator compute |
| BDL PBP helpers (bdlCoordsValid, bdlDistFromBasket, bdlClassifyTO, bdlExtractPlayer, etc.) | ~80 | No BDL PBP data |
| `refreshLiveCards()` | 55 | Replaced by `refreshFromServer()` |
| `_livePBPQueue` + related | 5 | No PBP queue |
| BDL box_score fetch blocks in `loadSchedule` | 15 | No status correction from BDL |
| **Total** | **~387** | |

**Variables to remove:** `bdlGameMap`, `BDL_TEAM_MATCH` (keep as display map but rename), `_livePBPQueue`, `BDL_BASKET_X/Y`, `BDL_RIM_TYPES`, `BDL_PAINT_TYPES`, `BDL_RIM_SET`, `BDL_PAINT_SET`.

**Cascading implications:**
- `renderCard` references `cs._lastBoxScore` for evidence panels → will be null. Evidence panels must handle gracefully.
- `openDrawer` → `renderDrawer` references PBP audit data → will be null. Drawer sections that depend on PBP should hide gracefully.
- Shot zone visualization depends on BDL PBP coordinate data → remove or hide for WNBA.

### 3E. Evidence Panels (lines 1598-1700)

**I1 (Disruption):** Currently shows Steals, Blocks, Turnovers, Forced TO, Unforced TO. For WNBA without BDL player stats:
- Show indicator score from server snapshot
- Hide detailed breakdowns unless server includes them in `raw_stats_json`
- Graceful fallback: show "Server floor: X.XX" if no detail available

**I2 (Perimeter/FT — was "Interior"):** Replace paint/rim evidence with:
```javascript
// WNBA I2: Perimeter/FT access (not paint/rim)
if (indKey === 'I2') {
  // Pull from raw_stats_json if available on latest snapshot
  var raw = cs._allSnapshots && cs._allSnapshots.length > 0
    ? cs._allSnapshots[cs._allSnapshots.length-1].raw_stats_json : null;
  if (raw) {
    var hs = raw.home?.statistics || {};
    var as = raw.away?.statistics || {};
    html += evRow('FTA', hs.free_throws_att || 0, as.free_throws_att || 0);
    html += evRow('FTM', hs.free_throws_made || 0, as.free_throws_made || 0);
    html += evRow('3PT Att', hs.three_points_att || 0, as.three_points_att || 0);
    html += evRow('3PT Made', hs.three_points_made || 0, as.three_points_made || 0);
  } else {
    html += '<div style="color:var(--fg-tertiary);font-size:11px;padding:4px 0">Score: ' + (floor?.I2?.score || '—') + '</div>';
  }
}
```

**I3 (Shot Quality):** Can still show eFG%, 3PT, Assists, Ast Ratio from `raw_stats_json`.

**I4 (Game Control):** Biggest lead from PBP won't be available. Per-quarter margins from `_serverQDBoundaries` will work (already has this fallback path).

**I5 (Momentum):** Runs data from PBP won't be available. Show score from snapshot only.

**Cascading implication:** `raw_stats_json` is saved on every snapshot and contains the full SR summary statistics. This is the same data the server uses for `computeServer()`. Reading it on the client for evidence panels means we have full stat breakdowns without BDL — we just need to parse the SR-shaped object instead of the BDL-shaped one. The field names differ (SR uses `three_points_att`, BDL player stats use `fg3a`). Evidence panels need SR field names.

### 3F. ESPN WP (lines 1508-1530)

**Change:** `league=nba` → `league=wnba` in two places:
1. Scoreboard fetch (line 622): `league=wnba`
2. Win probability fetch (line 1512): `league=wnba`

No other changes — WP chart rendering, history persistence, all identical.

### 3G. Analyze Button (lines 2370-2470)

**Current flow:**
1. Build `summaryData` from BDL box_score (`buildV3Summary(cs._lastBoxScore)`)
2. Post to `analyze.js`
3. Parse response

**WNBA change:**
Build `summaryData` from latest snapshot's `raw_stats_json` instead of BDL box_score:
```javascript
// Replace buildV3Summary(cs._lastBoxScore) with:
var latest = cs._allSnapshots && cs._allSnapshots.length > 0
  ? cs._allSnapshots[cs._allSnapshots.length-1] : null;
var summaryData = latest?.raw_stats_json || null;
if (!summaryData) { showToast('Error', 'No snapshot data available'); return; }
```

**Cascading implication — analyze.js:**
`analyze.js` has its own hardcoded NBA system prompt (line ~467). It does NOT use `getSonnetSystemPrompt()`. For WNBA games to get the right analysis, `analyze.js` needs to:
1. Accept `league` in the payload (add to POST body from client)
2. Look up the game's league from the `games` table if not provided
3. Use the WNBA system prompt for WNBA games

This is a **dependency** — without this fix, the ⚡ analyze button produces NBA-framed analysis for WNBA games. Options:
- **Quick fix:** Pass `league: 'wnba'` from client in payload, branch system prompt in analyze.js
- **Clean fix:** Have analyze.js query the game's league from DB and import `getSonnetSystemPrompt` logic

Since Netlify bundles each function separately (can't `require('./poll-live-bdl.mjs')`), analyze.js needs its own copy of the WNBA system prompt or a shared module. Recommend: duplicate the prompt function in analyze.js for now, refactor to shared module later.

### 3H. Alert Toast (lines 3571-3620)

**Current:** Fetches `get_alerts&date=X&limit=200`, processes all alerts regardless of league.

**WNBA change:** Filter client-side:
```javascript
alerts = alerts.filter(function(a) { return a.league === 'wnba'; });
```

**Better (db-api.js change):** Add optional `league` param to `get_alerts`:
```sql
-- Current:
SELECT * FROM alerts WHERE DATE(ts AT TIME ZONE 'America/Phoenix') = $date ORDER BY ts DESC LIMIT $limit

-- With league param:
SELECT * FROM alerts WHERE DATE(ts AT TIME ZONE 'America/Phoenix') = $date
  AND ($league IS NULL OR league = $league)
  ORDER BY ts DESC LIMIT $limit
```

**Recommendation:** Do both. Client-side filter is the safety net. Server-side filter reduces payload size (during NBA playoffs + WNBA, there could be 50+ NBA alerts per night).

### 3I. Demo Mode (lines 500-515, 872-906)

Replace 3 NBA demo game presets with WNBA opening night games:
```javascript
const DEMO_GAMES = [
  { id: '<CON@NYL game id>', label: 'CON @ NYL' },
  { id: '<WAS@TOR game id>', label: 'WAS @ TOR' },
  { id: '<GSV@SEA game id>', label: 'GSV @ SEA' },
];
```
Fill in actual game IDs after tonight's games are final.

### 3J. Date Navigation

**Current:** Uses `dateOffset` to shift dates, fetches SR schedule for each date.

**WNBA:** Use `get_games&league=wnba` with client-side date filter, or add `date` param to endpoint.

**Recommended db-api.js change:**
```javascript
if (action === 'get_games') {
  const league = params.league || 'nba';
  const date = params.date || null;
  const rows = date
    ? await sql`SELECT * FROM games WHERE league = ${league} AND date = ${date} ORDER BY matchup ASC`
    : await sql`SELECT * FROM games WHERE league = ${league} ORDER BY date DESC, matchup ASC LIMIT 50`;
  return { statusCode: 200, headers, body: JSON.stringify({ games: rows }) };
}
```

---

## 4. Server-Side Changes

### 4A. ntfy data ping (poll-live-bdl.mjs)

After the WNBA game processing loop completes (after all snapshots saved), add:
```javascript
// After: log(`${league.toUpperCase()}: ${liveCount} games processed`)
if (league === 'wnba' && liveCount > 0) {
  fetch('https://ntfy.sh/dft_live_data', {
    method: 'POST',
    headers: { 'Title': 'data', 'Priority': '1' },
    body: JSON.stringify({ league: 'wnba', ts: Date.now(), games: liveCount }),
  }).catch(() => {});
}
```

3 lines. Non-blocking. No risk to NBA.

**Cascading implication:** None. The `dft_live_data` topic is separate from `manny_nba_control`. No subscriber phones will ping. The `Priority: 1` ensures even if someone subscribes to this topic manually, it's silent.

### 4B. db-api.js — league param on get_alerts + date param on get_games

**get_alerts (~3 lines changed):**
```javascript
const league = params.league || null;
// Add to WHERE: AND ($league IS NULL OR league = $league)
```

**get_games (~5 lines changed):**
Add optional `date` param as described in 3J.

**Cascading implication:** Both changes are additive (new optional params). Existing callers that don't pass the params get identical behavior. NBA dashboard, debug dashboard, post-game agent — all unaffected.

### 4C. analyze.js — league-aware system prompt

See Section 3G. The analyze endpoint needs to know the game's league to use the right system prompt. Two approaches:

**Option A (quick):** Client passes `league: 'wnba'` in payload. analyze.js branches:
```javascript
const systemPrompt = body.league === 'wnba' ? WNBA_SYSTEM_PROMPT : NBA_SYSTEM_PROMPT;
```
Requires duplicating the WNBA system prompt in analyze.js.

**Option B (clean):** analyze.js queries the game's league from DB:
```javascript
const gameRow = await sql`SELECT league FROM games WHERE id = ${body.gameId} LIMIT 1`;
const league = gameRow[0]?.league || 'nba';
```
Then branches the system prompt. No client change needed.

**Recommendation:** Option A for now (faster, no DB query overhead on the analysis path). Migrate to shared module when we refactor.

---

## 5. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| NBA regression | None | — | Separate file, no NBA code touched |
| ntfy SSE drops | Medium | Low | 30s fallback poll catches it |
| Evidence panels empty | Certain | Low | raw_stats_json fallback provides full SR stats |
| Odds not populated | Medium | Low | Odds API team names may not match; graceful null handling |
| analyze.js wrong prompt | Certain until fixed | Medium | Fix in same commit (Option A) |
| ESPN alias mismatch | Low | Low | Verify from live scoreboard response, fix mapping |
| get_alerts returns NBA+WNBA | Certain until fixed | Low | Client-side filter as safety net |

---

## 6. Implementation Order

| Step | What | Files | Lines | Risk |
|------|------|-------|-------|------|
| 1 | db-api.js: `league` on get_alerts, `date` on get_games | db-api.js | ~8 | Low |
| 2 | poll-live-bdl.mjs: ntfy data ping after WNBA snapshots | poll-live-bdl.mjs | ~3 | Low |
| 3 | Copy v3.html → wnba-bdl.html | — | 0 | None |
| 4 | Constants: title, TC, W, indNames, localStorage prefix, ESPN league | wnba-bdl.html | ~40 | Low |
| 5 | Schedule: replace SR+BDL with DB-based discovery | wnba-bdl.html | ~30 | Low |
| 6 | Poll: replace refreshLiveCards with refreshFromServer + EventSource | wnba-bdl.html | ~50 | Low |
| 7 | Delete dead code: BDL compute, PBP, box_score functions | wnba-bdl.html | -387 | Low |
| 8 | Evidence panels: SR raw_stats_json fallback, I2 perimeter/FT | wnba-bdl.html | ~30 | Low |
| 9 | Analyze button: raw_stats_json input + league payload | wnba-bdl.html | ~5 | Low |
| 10 | analyze.js: WNBA system prompt branch | analyze.js | ~50 | Medium |
| 11 | Alert toast: client-side league filter | wnba-bdl.html | ~1 | Low |
| 12 | Demo mode: WNBA presets | wnba-bdl.html | ~10 | Low |
| 13 | Smoke test: load dashboard, verify game cards render | — | — | — |

**Net file size:** ~3,560 lines (v3 3,950 - 387 dead code - misc = smaller, cleaner)

---

## 7. Open Questions

1. **Team colors:** Need official WNBA brand colors for all 15 teams. Expansion teams (PDX Fire, TOY Tempo) launched in 2026 — verify.
2. **ESPN alias mapping:** Capture a live WNBA scoreboard response to verify abbreviation conventions.
3. **Date navigation:** poll_state only stores today. For Yesterday navigation, need `get_poll_history` query or `get_games` with date filter.
4. **Merge timeline:** When should we consider merging wnba-bdl.html back into a league-parameterized v3? After WNBA pipeline is stable (~2-3 weeks of live games).
5. **analyze.js prompt duplication:** Accept the duplication for now, or invest in a shared prompt module? Duplication is faster, shared module is cleaner but requires Netlify bundling investigation.

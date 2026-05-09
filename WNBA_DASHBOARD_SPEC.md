# WNBA Dashboard Spec — `wnba-bdl.html`
**Date:** May 8, 2026 (revised)
**Source:** Fork from `v3.html` (3,950 lines)
**Status:** SPEC COMPLETE — awaiting implementation go-ahead

---

## 1. Architecture: Hybrid BDL + Server Snapshots

### Why fork, not parameterize
v3.html is 3,950 lines with NBA-specific logic throughout. Parameterizing creates regression risk during NBA playoffs. Fork now, merge later.

### Data flow

**NBA v3 (dual-path):**
```
Every 10s: BDL box_scores → scores, status, per-player stats
           → computeClientIndicators() → client-side floor/I1-I5
           → fetchLivePBP() → PBP audit, evidence panels, shot zones
Every 60s: hydrateFromServerSnapshots() → server floor, XGB, MC, sustainability, quarter data
Every 30s: fetchEspnWP() → WP chart
```

**WNBA (hybrid):**
```
Every 10s: BDL plays → live scores (from latest play), run tracking, TO classification
           BDL team_stats → team-level box score for evidence panels
On ntfy ping (or 30s fallback):
           get_latest_snapshots → floor, I1-I5, XGB, MC, TP/LS (server-authoritative)
           get_live_tracking → compound state, SHAP, MC investigation
Every 60s: hydrateFromServerSnapshots() → full snapshot history, quarter data, sustainability
Every 30s: fetchEspnWP() → WP chart
```

Server computes indicators from SR summary (higher quality — paint, POT, SCP, FBP, possessions). Client provides real-time scores and PBP context from BDL. Server is structural authority; BDL is the real-time layer.

### BDL WNBA endpoints (verified May 8, 2026)

| Endpoint | Status | Data |
|----------|--------|------|
| `games` | ✅ | Game list, IDs, status |
| `plays` | ✅ | Full PBP — shot types, `home_score`/`away_score` on every play, team, clock, period. **No x,y coordinates.** ~450/game. |
| `team_stats` | ✅ | Team-level box score — FGM, FGA, FG3M, FG3A, FTM, FTA, OREB, DREB, AST, STL, BLK, turnovers, PF, PTS |
| `stats` (per-player) | ❌ 404 | Not available |
| `box_scores` (batch) | ❌ | Doesn't exist |
| `odds` | ❌ | Not available (server uses The Odds API) |
| Play coordinates | ❌ | No x,y — shot zones dead |

### Why NOT client-side indicator compute
BDL team_stats could compute rough indicators, but server already computes from SR (includes paint, POT, SCP, FBP, possessions — data BDL lacks). Server indicators are strictly higher quality. Client compute would disagree with server reads. Keep server as authority.

### ntfy event-driven refresh

**Topic:** `dft_live_data` (separate from subscriber `manny_nba_control`)

**Server (3 lines):** After WNBA snapshot loop: silent push `{league:'wnba', ts, games}`. Priority 1 = no phone notification.

**Client:** EventSource to `ntfy.sh/dft_live_data/sse`. On message → fetch snapshots + live_tracking. 30s fallback poll if SSE drops.

**ntfy free tier:** 250 msg/hr. We send 60/hr. Fine.

---

## 2. Files Touched

| File | Change | Risk |
|------|--------|------|
| `wnba-bdl.html` | New (fork from v3) | None |
| `poll-live-bdl.mjs` | ntfy data ping (3 lines) | Low |
| `db-api.js` | `league` on get_alerts, `date` on get_games (~8 lines) | Low |
| `analyze.js` | WNBA system prompt branch (~50 lines) | Medium |

---

## 3. Changes in `wnba-bdl.html`

### 3A. Constants & Config

| What | NBA v3 | WNBA |
|------|--------|------|
| Title | `DFT · v3` | `DFT · WNBA` |
| TC (team colors) | 30 NBA teams | 15 WNBA teams (verify brand colors) |
| W (indicator weights) | I1:.10 I2:.15 I3:.20 I4:.30 I5:.25 | I1:.15 I2:.20 I3:.30 I4:.25 I5:.10 |
| indNames | I2:'Interior', I5:'Execution' | I2:'Perimeter/FT', I5:'Momentum' |
| BDL_TEAM_MATCH | 30 NBA: `{ATL:'Hawks',...}` | 15 WNBA: `{ATL:'Dream', CON:'Sun',...}` |
| ESPN_ALIAS_MAP | `{NOP:'NO', GSW:'GS',...}` | TBD — verify from live ESPN response |
| localStorage prefix | `nba4:` | `wnba:` (all occurrences) |

**Inline conviction (line 2780) — CRITICAL fix:**
Snapshot history drawer computes conviction using NBA killer pairs. For WNBA:
- I4+I5 is NOT killer (I5 AUC=0.500)
- I3+I4 with 3+ indicators = DOMINANT
- I3+I2, I4+I2 = killer pairs
- No validated danger combos

### 3B. Schedule Discovery

1. Game list from `get_poll_state&league=wnba` (server already discovered via SR/ESPN)
2. `buildBdlGameMap()` — **KEEP** — calls `bdl('games')` for BDL game IDs (needed for plays/team_stats)
3. Skip `bdl('box_scores')` status correction — doesn't exist
4. `fetchEspnScoreboard()` with `league=wnba`
5. Skip `fetchStandings()` — no BDL WNBA standings

`buildBdlGameMap` works as-is — matches by `full_name.includes(BDL_TEAM_MATCH[alias])`.

### 3C. Poll Cycle — Hybrid Refresh

**Delete:** `refreshLiveCards()` (BDL box_scores polling + computeClientIndicators)

**Replace with two layers:**

**Layer 1 — BDL real-time (every 10s):**
- `bdl('plays', {game_id})` per live game → latest play has `home_score`/`away_score` → real-time scores
- Parse plays → `parseBDLPBP()` → run tracking, TO classification, scoring patterns
- `bdl('team_stats', {game_id})` per live game → team box score → evidence panel data
- Store on cardState: `cs._bdlPlays`, `cs.pbpAudit`, `cs._bdlTeamStats`

**Layer 2 — Server snapshots (on ntfy ping, 30s fallback):**
- `get_latest_snapshots` → floor, I1-I5, XGB, MC, TP/LS (structural authority)
- `get_live_tracking` → compound state, SHAP, MC investigation, checkpoints
- Store on cardState: `cs._serverFloor`, `cs.sonnetIndicators`, etc.

**`getFloor()` chain:** `sonnetIndicators → clientInd(null) → _serverFloor → rollingWindow` — works perfectly. `clientInd` is always null (no client compute), falls through to `_serverFloor`.

### 3D. Dead Code (~290 lines removed)

| Function | Lines | Why dead |
|----------|-------|----------|
| `computeClientIndicators()` | 139 | Server computes from SR |
| `buildV3Summary()` | 32 | Converts box_score format — not needed |
| `refreshLiveCards()` | 55 | Replaced by hybrid refresh |
| BDL box_score fetch blocks | 15 | Endpoint doesn't exist |
| Shot zone rendering + coordinate helpers | ~50 | No x,y coordinates |

**KEPT:** `bdl()`, `buildBdlGameMap()`, `parseBDLPBP()` (works on WNBA plays), `bdlClassifyTO()`, `bdlExtractPlayer()`, `normalizeBdlClock()`.

### 3E. Evidence Panels

**Data source change:** `cs._lastBoxScore` (BDL per-player) → `cs._bdlTeamStats` (BDL team-level) + `cs.pbpAudit` (PBP-derived).

| Indicator | NBA source | WNBA source | Change |
|-----------|-----------|-------------|--------|
| I1 Disruption | Box score per-player (stl, blk, to) + PBP (forced/unforced TO) | team_stats (stl, blk, turnovers) + PBP (forced/unforced TO) | Team-level only, PBP same |
| I2 Interior → Perimeter/FT | Box score rim/paint FG + FTA | team_stats FTA, FTM, FG3A, FG3M | Different stats (perimeter not paint) |
| I3 Shot Quality | Box score per-player eFG%, 3PT, AST | team_stats FGM/FGA/FG3M → eFG%, AST | Team-level only |
| I4 Game Control | PBP biggest lead + per-Q margins | PBP biggest lead + server quarter data | Same PBP + server fallback |
| I5 Execution → Momentum | PBP runs + pace | PBP runs | Same |
| Shot zones | PBP x,y coordinates | **HIDDEN** | Dead — no coordinates |

**BDL team_stats field names (verified):** `fgm`, `fga`, `fg3m`, `fg3a`, `ftm`, `fta`, `oreb`, `dreb`, `reb`, `ast`, `stl`, `blk`, `turnovers`, `pf`, `pts`. Note: `turnovers` (not `to`) — differs from `raw_stats_json` shorthand.

**`raw_stats_json` shorthand keys (verified):** `ast`, `fta`, `ftm`, `fg3a`, `fg3m`, `fga`, `fgm`, `stl`, `blk`, `to`, `oreb`, `paint`, `paintA`, `paintM`, `pot`, `scp`, `fbp`, `poss`, `bigLead`, `bench`, `fd`, `oppp`, `dppp`, `atRimA`, `atRimM`. Same for NBA and WNBA.

### 3F. Quarter Dominance Grid

Reorder columns — paint first is misleading for WNBA (paint AUC 0.500):

| NBA order | WNBA order |
|-----------|------------|
| PNT, FTA, 3PM, TO, STL, AST | FTA, AST, 3PM, STL, TO, PNT |

### 3G. ESPN WP

`league=nba` → `league=wnba` in scoreboard fetch + WP fetch. No other changes.

### 3H. Analyze Button

Build `summaryData` from latest snapshot `raw_stats_json` (shorthand keys). Pass `league: 'wnba'` in payload. Fix analyze.js to branch system prompt (see Section 4C).

### 3I. Alert Toast

Filter: `alerts = alerts.filter(a => a.league === 'wnba')`. Plus db-api.js `league` param.

### 3J. Date Navigation

Use `get_games&league=wnba&date=YYYY-MM-DD` (needs db-api.js `date` param). Fallback: client-side date filter on full game list.

### 3K. Demo Mode

WNBA opening night presets (fill game IDs after games are final).

---

## 4. Server-Side Changes

### 4A. ntfy data ping — 3 lines in poll-live-bdl.mjs
### 4B. db-api.js — `league` on get_alerts, `date` on get_games (~8 lines)
### 4C. analyze.js — WNBA system prompt branch (~50 lines, duplicated from getSonnetSystemPrompt)

---

## 5. What's Genuinely Missing vs NBA v3

| Feature | NBA v3 | WNBA | Permanent? |
|---------|--------|------|------------|
| Live scores (10s) | BDL box_scores | BDL plays | **Solved** |
| Per-player stats | box_scores players[] | Team-level only | **Yes** — no per-player endpoint |
| Shot zones | PBP x,y coords | Hidden | **Yes** — no coordinates |
| Run tracking | BDL plays | BDL plays | **Solved** |
| TO classification | BDL play text | BDL play text | **Solved** |
| Indicators/floor | Client compute | Server (higher quality) | **Better** |
| Standings/ranks | BDL standings | Not available | **Yes** — no BDL standings |
| Analysis button | Works | Works after analyze.js fix | **Fix required** |

---

## 6. Implementation Order

| # | What | Risk |
|---|------|------|
| 1 | db-api.js: league on get_alerts, date on get_games | Low |
| 2 | poll-live-bdl.mjs: ntfy data ping | Low |
| 3 | Copy v3.html → wnba-bdl.html | None |
| 4 | Constants: TC, W, indNames, BDL_TEAM_MATCH, localStorage, title | Low |
| 5 | Schedule: poll_state + buildBdlGameMap (keep) | Low |
| 6 | Poll: hybrid refresh (BDL plays/team_stats 10s + server snapshots ntfy) | Medium |
| 7 | Delete dead code: computeClientIndicators, buildV3Summary, shot zones | Low |
| 8 | Evidence panels: _bdlTeamStats + pbpAudit, I2 perimeter/FT | Medium |
| 9 | Inline conviction: WNBA killer pairs | Low |
| 10 | Quarter dominance grid: column reorder | Low |
| 11 | Analyze: raw_stats_json + league payload | Low |
| 12 | analyze.js: WNBA system prompt | Medium |
| 13 | Alert toast: league filter | Low |
| 14 | ESPN: league=wnba | Low |
| 15 | Demo mode | Low |
| 16 | Smoke test | — |

---

## 7. Open Questions

1. **Team colors:** Need official WNBA brand colors (especially PDX, TOY expansion teams).
2. **ESPN alias mapping:** Verify from live ESPN WNBA scoreboard response.
3. **BDL plays during live games:** Verified on completed games. Confirm real-time during live.
4. **BDL team_stats during live games:** Same — verify updates in real-time, not just post-game.
5. **Merge timeline:** Consider merging into league-parameterized v3 after ~2-3 weeks stable.

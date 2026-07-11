# WNBA BDL Fixes Spec

**Date:** May 10, 2026
**Scope:** Two fixes — season year mismatch + BDL player_stats SR fallback

---

## Fix 1: WNBA Season Year Mismatch

### Problem

`LEAGUES.wnba.season` is `'2025'` but BDL WNBA uses calendar year `2026` for the current season. NBA uses start year (2025-26 season = `2025`), WNBA is a single calendar-year league.

**Live impact right now:** `getSeasonStatsForTeams()` calls `bdlSeasonStatsNCAAMB()` which hits `/wnba/v1/player_season_stats?season=2025` — returns last year's player averages. No error, just stale data silently feeding the sustainability audit baselines.

### Verified Data

```
BDL WNBA games May 2026:     season = 2026
BDL player_season_stats:      ?season=2025 → last year (28 GP)
                              ?season=2026 → current (1 GP)
BDL standings:                ?season=2025 → 13 teams (last year)
                              ?season=2026 → 15 teams (current, with expansion)
```

### Consumers of `cfg.season`

| Location | Usage | Impact |
|---|---|---|
| `poll-live-bdl.mjs:6252` | `getSeasonStatsForTeams(sql, league, cfg.season, ...)` → BDL `player_season_stats?season=` | **BROKEN** — fetching 2025 data |
| `pregame-agent.mjs:1081` | SR `seasons/${season}/REG/standings.json` | Not yet used for WNBA (hardcoded NBA) but will break when WNBA support added |
| `pregame-agent.mjs:1103-1110` | SR `seasons/${season}/REG/teams/.../statistics.json`, depth_chart, splits | Same — future WNBA breakage |
| Schedule fetch | `games/${year}/${month}/${day}/schedule.json` | **NOT affected** — uses date, not cfg.season |
| `loadSeasonQ4` | Queries `games` table by league | **NOT affected** — no season param |

### Fix

Add `bdlSeason` property to LEAGUES config. SR season may differ from BDL season — keep `season` for SR, add `bdlSeason` for BDL calls.

**poll-live-bdl.mjs — LEAGUES.wnba config (~line 358):**

```javascript
wnba: {
  // ... existing fields ...
  season: '2026',       // CHANGED from '2025' — WNBA uses calendar year for both SR and BDL
  // If SR WNBA turns out to use a different convention, split into srSeason/bdlSeason
}
```

Note: SR WNBA schedule fetch uses date-based URLs (not season-based), so the main `season` consumer for WNBA is BDL season cache. Until pregame-agent WNBA is built, we can't verify SR's season convention — but WNBA is a calendar-year league so `2026` is almost certainly correct for both.

**Cascading check — season_cache table:**

Season cache rows are keyed by `(league, season, team_alias)`. Changing from `'2025'` to `'2026'` means:
- Old 2025 cache rows become orphaned (harmless — never matched again)
- First poll after deploy will find 0 cached rows → refresh all teams from BDL with correct 2026 data
- This is the desired behavior — one-time refresh, then caching works normally

**Files touched:** `poll-live-bdl.mjs` only (1 line).

---

## Fix 2: BDL Player Stats Fallback When SR Fails (WNBA)

### Problem

WNBA poll loop is SR-only for box score data. When SR fails (rate limit, ESPN ID bug, 403), the game is skipped entirely:

```javascript
// poll-live-bdl.mjs ~line 6430
if (league === 'wnba') {
  try {
    _srSummary = await srFetch(league, `games/${game.id}/summary.json`);
    // ...
  } catch (srErr) {
    log(`${matchup}: SR summary fetch failed — ${srErr.message}`);
    continue;  // ← GAME SKIPPED, no data collected
  }
}
```

This already happened May 10 when the SR WNBA key was rate-limited. The SR retry fix only works pre-tip. Mid-game SR failures = blind.

### Solution

When SR fails for WNBA, fall back to BDL `player_stats` + `plays` to build an SR-shaped summary. BDL player_stats returns per-player box scores that aggregate to match team totals (cross-verified: perfect match on CHI@POR).

### Validated Data

**BDL `/wnba/v1/player_stats?game_ids[]=24757`:**
- Returns all players for both teams (22 players: 13 POR, 9 CHI)
- Fields: `player, team, game, min, fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, reb, ast, stl, blk, turnover, pf, pts, plus_minus`
- Field names match what `bts()` expects: `turnover` (singular), `pf`, `pts`, `stl`, `blk`
- Null values on `stl`, `blk`, `turnover`, `oreb` for some players — `|| 0` handles correctly
- **Aggregated totals match `team_stats` perfectly for both teams**

**BDL `/wnba/v1/plays?game_id=24757`:**
- Already fetched in the poll loop (line ~6382, `allPlaysResults`)
- Returns PBP with `scoring_play`, `score_value`, `type`, `text` — all parsed by `parseBDLPBPServer`
- No `shooting_play` field (known — regex fallback handles this)

**What BDL player_stats CANNOT provide:**
- Starters/lineups — no `/wnba/v1/lineups` endpoint → `bench_points` will be 0 (all players treated as bench)
- Per-quarter scores — WNBA game object has no `home_q1` etc. → period scoring array will be empty
- These are non-critical: bench_points is I4 subB context, quarter scores feed period display but indicators don't depend on them

### Implementation

**New function: `buildSummaryFromBDLPlayerStats()` (~30 lines)**

```javascript
// Build SR-shaped summary from BDL player_stats (WNBA fallback when SR is down)
// Returns same shape as buildSummaryFromBDLServer but without starters/quarter scores
function buildSummaryFromBDLPlayerStats(playerStats, bdlGame, pbpResult) {
  // playerStats = array from /wnba/v1/player_stats?game_ids[]=X
  // bdlGame = game object from /wnba/v1/games (has home_score, away_score, status, period, time)
  const hA = bdlGame.home_team?.abbreviation || 'HOME';
  const aA = bdlGame.visitor_team?.abbreviation || 'AWAY';

  // Split players by team
  const homePlayers = playerStats.filter(p => p.team?.abbreviation === hA);
  const awayPlayers = playerStats.filter(p => p.team?.abbreviation === aA);

  // Reshape into boxScore-compatible format for bts()
  // bts() reads: p.fgm, p.fga, p.fg3m, p.fg3a, p.ftm, p.fta, p.ast, p.stl, p.blk,
  //              p.oreb, p.dreb, p.reb, p.turnover, p.pf, p.pts, p.player.id, p.min
  // BDL player_stats already has all these field names — pass through directly

  const fakeBoxScore = {
    id: bdlGame.id,
    status: bdlGame.status,
    time: bdlGame.time,
    period: bdlGame.period,
    home_team: { team: bdlGame.home_team, players: homePlayers },
    visitor_team: { team: bdlGame.visitor_team, players: awayPlayers },
    // No quarter scores available from WNBA game object
  };

  // No lineups → empty starterIds → bench_points = total points (not ideal but functional)
  return buildSummaryFromBDLServer(fakeBoxScore, pbpResult, null);
}
```

**Modify WNBA SR fetch block (~line 6430):**

```javascript
if (league === 'wnba') {
  // ── WNBA: SR game summary primary, BDL player_stats fallback ──
  try {
    await sleep(SR_DELAY_MS);
    _srSummary = await srFetch(league, `games/${game.id}/summary.json`);
    if (!_srSummary || (!_srSummary.home && !_srSummary.away)) {
      throw new Error('SR summary empty');
    }
  } catch (srErr) {
    log(`${matchup}: SR summary failed (${srErr.message}) — trying BDL player_stats fallback`);
    // Fallback: build summary from BDL per-player stats
    if (bdlGid) {
      try {
        const psResp = await bdlFetch(`${cfg.bdlPrefix}/v1/player_stats?game_ids[]=${bdlGid}&per_page=50`);
        const bdlPlayers = psResp?.data || [];
        if (bdlPlayers.length > 0) {
          // Need game object for status/score — fetch single game
          const gameResp = await bdlFetch(`${cfg.bdlPrefix}/v1/games/${bdlGid}`);
          const bdlGame = gameResp?.data || null;
          if (bdlGame) {
            const playsResult = allPlaysResults[gi];
            const plays = playsResult?.data || [];
            const pbpFallback = parseBDLPBPServer(plays, cfg.aliasMap?.[hA]||hA, cfg.aliasMap?.[aA]||aA);
            _srSummary = buildSummaryFromBDLPlayerStats(bdlPlayers, bdlGame, pbpFallback);
            log(`${matchup}: ★ BDL fallback succeeded — ${bdlPlayers.length} players, building summary`);
          } else {
            log(`${matchup}: BDL game fetch failed — skipping`);
            continue;
          }
        } else {
          log(`${matchup}: BDL player_stats empty (game may not have started) — skipping`);
          continue;
        }
      } catch (bdlErr) {
        log(`${matchup}: BDL fallback also failed (${bdlErr.message}) — skipping`);
        continue;
      }
    } else {
      log(`${matchup}: no BDL game ID for fallback — skipping`);
      continue;
    }
  }
}
```

### Game Status Handling

BDL WNBA game statuses (observed):
- `"post"` = completed (equivalent to NBA's `"Final"`)
- Need to handle in `normalizeBdlStatusServer` or inline

When the fallback fires, the status check block (~line 6455) expects either SR status or BDL boxScore status. The fallback sets `_srSummary` as the built summary, so we need to also set game status. Two options:

**Option A (simpler):** After building fallback summary, set game status from BDL game object directly:
```javascript
// After successful fallback build:
if (bdlGame.status === 'post') {
  gameStatus = 'closed';
} else if (bdlGame.status === 'in_progress') {
  gameStatus = 'in progress';
} else {
  gameStatus = bdlGame.status || 'scheduled';
}
```

This bypasses the existing SR status check at line ~6455. The fallback block should set `gameStatus` directly and skip the SR branch of the status check.

**Option B:** Add a flag `_usedBdlFallback = true` and branch the status check accordingly.

Recommend Option A — set `gameStatus` inline when fallback fires, then the existing status check only runs for the SR path.

### Cascading Implications

| Component | Impact | Mitigation |
|---|---|---|
| `computeServer(summary, ...)` | Receives same shape — no change needed | `bts()` output is identical to SR stats shape |
| `computeConviction(ind, ...)` | Indicators computed from summary — no change | Works on the `bts()` output |
| XGB features | `extractXGBFeatures` reads from summary | Same fields available |
| MC engine | Reads cumulative rates from summary stats | Same fields available |
| Quarter data capture | No quarter scores in BDL game object → `periods` array empty | Quarter data boundaries won't capture. Non-blocking — boundaries already captured when SR was working. If SR was never available for a game, quarter data stays empty. |
| Sustainability audit | Reads `summary.home.players[]` → player averages from season cache | Works — `bpa()` in `buildSummaryFromBDLServer` creates player objects with statistics |
| `bench_points` | No starters → all points counted as bench | I4 subB will read inflated bench_points. Non-critical — I4 subA (biggest_lead) is the primary driver. Note: could use PBP first-quarter starters heuristic if this matters later |
| PBP MC | Already uses BDL plays (already fetched) | No change |
| Alert agent context | Reads indicators + floor + MC + XGB | All computed from summary — no change |

### aliasMap Consideration

When the fallback fires, `parseBDLPBPServer` needs BDL abbreviations (not SR). The current code at line ~6641 does:
```javascript
parseBDLPBPServer(plays, league==='wnba'?(cfg.aliasMap[hA]||hA):hA, ...)
```

This maps SR aliases (e.g., `LVA`) → BDL aliases (e.g., `LV`). In the fallback path, we're working with BDL data directly, so `hA`/`aA` are already SR aliases (from the SR schedule). The aliasMap application is still correct — same transform needed.

**BUT:** If the fallback also needs to match BDL player_stats team abbreviation to the SR aliases in the poll loop, there could be a mismatch. BDL returns `abbreviation: "GS"` but the poll loop tracks `hA = "GSV"` (from SR schedule). The `getBdlGid()` helper already handles this via `aliasMap`, so the `bdlGid` lookup works. The player_stats are fetched by `game_ids[]` not by team, so the team abbreviation mismatch doesn't affect the fetch — only the `filter` in `buildSummaryFromBDLPlayerStats`.

**Fix:** `buildSummaryFromBDLPlayerStats` filters players by `p.team.abbreviation`. BDL returns `"GS"` but we need to compare against... the BDL abbreviation, not SR. Since the function receives `bdlGame` (which has BDL abbreviations), and `playerStats` (which also has BDL abbreviations), the filtering is self-consistent. The function returns a summary object with BDL team names, which then feeds into `computeServer`. The indicator engine doesn't care about team names — it uses home/away positional structure.

No aliasMap issue in the fallback path.

### Score Extraction

When using BDL fallback, the summary needs `home.points` and `away.points` for score/margin. The `bts()` function computes `s.points` from player aggregation, and we verified this matches the game score (POR 83, CHI 98). The `buildSummaryFromBDLServer` function sets `homeStats.points_against = awayStats.points` — this will work correctly.

The summary also needs `home_points` and `away_points` at the top level for some consumers. `buildSummaryFromBDLServer` constructs these from the boxScore's quarter scores, which won't exist for WNBA. But `computeServer` reads points from `home.statistics.points`, not from the top-level fields. The margin is computed from `summary.home.statistics.points - summary.away.statistics.points` (or similar). Verified: `bts()` populates `s.points` correctly.

---

## Files Changed

| File | Change | Lines |
|---|---|---|
| `poll-live-bdl.mjs` | LEAGUES.wnba.season `'2025'` → `'2026'` | 1 |
| `poll-live-bdl.mjs` | New `buildSummaryFromBDLPlayerStats()` function | ~20 |
| `poll-live-bdl.mjs` | Modify WNBA SR fetch block to add BDL fallback | ~25 |
| `poll-live-bdl.mjs` | Add BDL game status handling in fallback path | ~5 |

**Total: ~50 lines changed in 1 file.**

---

## Testing

1. **Season fix:** Deploy → check poll logs for `Season cache: X teams stale/missing — refreshing` (all WNBA teams will refresh on first poll since 2026 cache rows don't exist). Verify via `db-api?action=get_season_cache` that WNBA rows now have `season=2026`.

2. **BDL fallback:** Hard to test without SR actually failing. Options:
   - Temporarily comment out the SR fetch to force the fallback path
   - Or wait for next SR rate limit event (they happen)
   - Check logs for `★ BDL fallback succeeded` when it fires

3. **Cross-check:** For a completed WNBA game, compare: (a) snapshot from SR path vs (b) snapshot that would have been produced from BDL fallback. Run both in a test script and diff the indicator scores.

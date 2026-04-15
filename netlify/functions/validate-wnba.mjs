// Temporary WNBA endpoint validation function
// Hit: /.netlify/functions/validate-wnba
// Add ?sr_key=YOUR_KEY to also validate SR endpoints
// Delete this file after validation

let BDL_KEY_ACTIVE = process.env.BDL_API_KEY;
const BDL_BASE = 'https://api.balldontlie.io/wnba/v1';

async function bdlFetch(path, label) {
  const url = `${BDL_BASE}${path}`;
  const result = { endpoint: label, url, status: null, error: null, shape: null, sample: null, count: null };
  try {
    const r = await fetch(url, { headers: { Authorization: BDL_KEY_ACTIVE } });
    result.status = r.status;
    if (!r.ok) { result.error = await r.text(); return result; }
    const json = await r.json();
    const data = json.data;
    result.count = Array.isArray(data) ? data.length : (data ? 1 : 0);
    if (Array.isArray(data) && data.length > 0) {
      result.shape = Object.keys(data[0]);
      result.sample = data[0];
    } else if (data && typeof data === 'object') {
      result.shape = Object.keys(data);
      result.sample = data;
    }
    result.meta = json.meta || null;
    return result;
  } catch (e) {
    result.error = e.message;
    return result;
  }
}

async function srFetch(baseUrl, apiKey, path, label) {
  const url = `${baseUrl}${path}?api_key=${apiKey}`;
  const safeUrl = `${baseUrl}${path}?api_key=***`;
  const result = { endpoint: label, url: safeUrl, status: null, error: null, shape: null, sample: null };
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    result.status = r.status;
    if (!r.ok) { result.error = (await r.text()).substring(0, 500); return result; }
    const json = await r.json();
    result.topKeys = Object.keys(json);
    // For game summary, dig into structure
    if (json.home) {
      result.homeStatKeys = json.home?.statistics ? Object.keys(json.home.statistics) : [];
      result.periodsCount = json.home?.statistics?.periods?.length || 0;
      if (json.home?.statistics?.periods?.[0]) {
        result.periodStatKeys = Object.keys(json.home.statistics.periods[0]);
      }
      result.homeOnCourt = json.home?.statistics?.on_court ? true : false;
      result.awayOnCourt = json.away?.statistics?.on_court ? true : false;
    }
    // For schedule, grab game IDs
    if (json.games) {
      result.gameCount = json.games.length;
      result.sampleGameKeys = json.games[0] ? Object.keys(json.games[0]) : [];
      result.gameIds = json.games.slice(0, 5).map(g => ({ id: g.id, status: g.status, home: g.home?.alias, away: g.away?.alias }));
    }
    // For daily schedule
    if (json.league?.games) {
      result.gameCount = json.league.games.length;
      result.gameIds = json.league.games.slice(0, 5).map(g => ({ id: g.id, status: g.status, home: g.home?.alias, away: g.away?.alias }));
    }
    // For teams
    if (json.league?.teams) {
      result.teamCount = json.league.teams.length;
      result.teams = json.league.teams.map(t => ({ id: t.id, name: t.name, alias: t.alias, market: t.market }));
    }
    // For standings
    if (json.league?.season?.conferences) {
      result.conferences = json.league.season.conferences.map(c => ({
        name: c.name,
        teamCount: c.teams?.length || c.divisions?.reduce((s, d) => s + (d.teams?.length || 0), 0) || 0
      }));
    }
    // For injuries
    if (json.league?.players) {
      result.injuryCount = json.league.players.length;
      result.sampleInjury = json.league.players[0] || null;
    }
    // For team profile
    if (json.players) {
      result.playerCount = json.players.length;
      result.samplePlayer = json.players[0] ? { name: json.players[0].full_name, position: json.players[0].primary_position } : null;
    }
    // For stats
    if (json.season) {
      result.seasonYear = json.season.year;
    }
    if (json.players) {
      result.statPlayerCount = json.players.length;
      if (json.players[0]?.total) {
        result.totalStatKeys = Object.keys(json.players[0].total);
      }
      if (json.players[0]?.average) {
        result.avgStatKeys = Object.keys(json.players[0].average);
      }
    }
    // For PBP
    if (json.periods) {
      result.periodCount = json.periods.length;
      const allEvents = json.periods.flatMap(p => p.events || []);
      result.eventCount = allEvents.length;
      result.sampleEvent = allEvents[0] || null;
    }
    result.sample = JSON.stringify(json).substring(0, 2000);
    return result;
  } catch (e) {
    result.error = e.message;
    return result;
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const srKey = url.searchParams.get('sr_key');
  const bdlKeyOverride = url.searchParams.get('bdl_key');
  const SR_BASE = srKey ? `https://api.sportradar.com/wnba/trial/v8/en/` : null;
  
  // Allow BDL key override for testing
  if (bdlKeyOverride) BDL_KEY_ACTIVE = bdlKeyOverride;
  
  const results = { bdl: [], sr: [], timestamp: new Date().toISOString(), bdlKeyUsed: BDL_KEY_ACTIVE ? `${BDL_KEY_ACTIVE.substring(0,4)}...${BDL_KEY_ACTIVE.substring(BDL_KEY_ACTIVE.length-4)}` : 'MISSING' };

  // ============ BDL ENDPOINTS ============
  console.log('Starting BDL validation...');

  // 1. Teams
  results.bdl.push(await bdlFetch('/teams', 'Teams'));

  // 2. Games (2025 season)
  const gamesRes = await bdlFetch('/games?seasons[]=2025&per_page=10', 'Games (2025)');
  results.bdl.push(gamesRes);
  const gameId = gamesRes.sample?.id;
  
  // Also try 2024 if 2025 is empty
  if (!gameId) {
    const games2024 = await bdlFetch('/games?seasons[]=2024&per_page=10', 'Games (2024 fallback)');
    results.bdl.push(games2024);
    var fallbackGameId = games2024.sample?.id;
  }
  const useGameId = gameId || fallbackGameId;

  // 3. Players
  results.bdl.push(await bdlFetch('/players?per_page=3', 'Players'));

  // 4. Active Players
  results.bdl.push(await bdlFetch('/players/active?per_page=3', 'Active Players'));

  // 5. Player Stats (per-game)
  if (useGameId) {
    results.bdl.push(await bdlFetch(`/player_stats?game_ids[]=${useGameId}&per_page=5`, `Player Stats (game ${useGameId})`));
  }

  // 6. Team Stats (per-game)
  if (useGameId) {
    results.bdl.push(await bdlFetch(`/team_stats?game_ids[]=${useGameId}`, `Team Stats (game ${useGameId})`));
  }

  // 7. Player Season Stats
  results.bdl.push(await bdlFetch('/player_season_stats?season=2025&per_page=3', 'Player Season Stats (2025)'));
  // Fallback
  const pss2025 = results.bdl[results.bdl.length - 1];
  if (pss2025.count === 0) {
    results.bdl.push(await bdlFetch('/player_season_stats?season=2024&per_page=3', 'Player Season Stats (2024 fallback)'));
  }

  // 8. Team Season Stats
  results.bdl.push(await bdlFetch('/team_season_stats?season=2025&per_page=3', 'Team Season Stats (2025)'));
  const tss2025 = results.bdl[results.bdl.length - 1];
  if (tss2025.count === 0) {
    results.bdl.push(await bdlFetch('/team_season_stats?season=2024&per_page=3', 'Team Season Stats (2024 fallback)'));
  }

  // 9. Standings
  results.bdl.push(await bdlFetch('/standings?season=2025', 'Standings (2025)'));
  const st2025 = results.bdl[results.bdl.length - 1];
  if (st2025.count === 0) {
    results.bdl.push(await bdlFetch('/standings?season=2024', 'Standings (2024 fallback)'));
  }

  // 10. Player Injuries
  results.bdl.push(await bdlFetch('/player_injuries?per_page=5', 'Player Injuries'));

  // 11. Plays (PBP)
  if (useGameId) {
    results.bdl.push(await bdlFetch(`/plays?game_id=${useGameId}`, `Plays/PBP (game ${useGameId})`));
  }

  // 12. Box Scores
  if (useGameId) {
    results.bdl.push(await bdlFetch(`/box_scores?game_ids[]=${useGameId}`, `Box Scores (game ${useGameId})`));
  }

  // 13. Odds — test multiple paths with absolute URLs
  const BDL_RAW = 'https://api.balldontlie.io';
  if (useGameId) {
    const oddsPaths = [
      { path: `/wnba/v1/odds?game_ids[]=${useGameId}`, label: '/wnba/v1/odds' },
      { path: `/nba/v2/odds?game_ids[]=${useGameId}`, label: '/nba/v2/odds (cross-league)' },
      { path: `/wnba/v2/odds?game_ids[]=${useGameId}`, label: '/wnba/v2/odds' },
    ];
    for (const op of oddsPaths) {
      try {
        const oddsR = await fetch(`${BDL_RAW}${op.path}`, { headers: { Authorization: BDL_KEY_ACTIVE } });
        const body = oddsR.ok ? await oddsR.json() : await oddsR.text();
        results.bdl.push({
          endpoint: `Odds ${op.label} (game ${useGameId})`,
          status: oddsR.status,
          error: oddsR.ok ? null : (typeof body === 'string' ? body.substring(0, 200) : null),
          sample: oddsR.ok ? body.data?.[0] || null : null,
          count: oddsR.ok ? body.data?.length : null,
          shape: oddsR.ok && body.data?.[0] ? Object.keys(body.data[0]) : null
        });
      } catch(e) { results.bdl.push({ endpoint: `Odds ${op.label}`, error: e.message }); }
    }
  }

  // ============ SR ENDPOINTS (if key provided) ============
  if (SR_BASE) {
    console.log('Starting SR validation...');

    // Need a delay between SR calls (trial = 1 req/sec)
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    // 1. Teams list
    results.sr.push(await srFetch(SR_BASE, srKey, 'league/teams.json', 'Teams'));
    await delay(1100);

    // 2. Seasons
    results.sr.push(await srFetch(SR_BASE, srKey, 'league/seasons.json', 'Seasons'));
    await delay(1100);

    // 3. Schedule (WNBA 2025 season: May-Sep)
    results.sr.push(await srFetch(SR_BASE, srKey, 'games/2025/05/17/schedule.json', 'Schedule (May 17 2025)'));
    await delay(1100);

    results.sr.push(await srFetch(SR_BASE, srKey, 'games/2025/08/01/schedule.json', 'Schedule (Aug 1 2025)'));
    await delay(1100);

    // 4. Standings
    results.sr.push(await srFetch(SR_BASE, srKey, 'seasons/2025/REG/standings.json', 'Standings (2025)'));
    await delay(1100);

    // 5. Daily Injuries
    results.sr.push(await srFetch(SR_BASE, srKey, 'league/injuries.json', 'Daily Injuries'));
    await delay(1100);

    // Find a completed game ID from schedule results
    let srGameId = null;
    for (const r of results.sr) {
      if (r.gameIds) {
        const closed = r.gameIds.find(g => g.status === 'closed');
        if (closed) { srGameId = closed.id; break; }
      }
    }

    // If we found a game, hit game-level endpoints
    if (srGameId) {
      console.log(`Found SR game: ${srGameId}`);

      // 6. Game Summary
      results.sr.push(await srFetch(SR_BASE, srKey, `games/${srGameId}/summary.json`, `Game Summary (${srGameId})`));
      await delay(1100);

      // 7. PBP
      results.sr.push(await srFetch(SR_BASE, srKey, `games/${srGameId}/pbp.json`, `PBP (${srGameId})`));
      await delay(1100);
    } else {
      results.sr.push({ endpoint: 'Game Summary', error: 'No closed game ID found from schedule' });
      results.sr.push({ endpoint: 'PBP', error: 'No closed game ID found from schedule' });
    }

    // 8. Team profile (use first team from teams list)
    const teamList = results.sr.find(r => r.endpoint === 'Teams');
    const srTeamId = teamList?.teams?.[0]?.id;
    if (srTeamId) {
      results.sr.push(await srFetch(SR_BASE, srKey, `teams/${srTeamId}/profile.json`, `Team Profile (${srTeamId})`));
      await delay(1100);

      // 9. Team seasonal stats
      results.sr.push(await srFetch(SR_BASE, srKey, `seasons/2025/REG/teams/${srTeamId}/statistics.json`, `Team Stats (${srTeamId})`));
      await delay(1100);
    }

    // 10. Rankings
    results.sr.push(await srFetch(SR_BASE, srKey, 'seasons/2025/REG/rankings.json', 'Rankings (2025)'));
  } else {
    results.sr.push({ note: 'SR validation skipped — add ?sr_key=YOUR_KEY to URL' });
  }

  // ============ SUMMARY ============
  const summary = {
    bdl: {
      total: results.bdl.length,
      success: results.bdl.filter(r => r.status === 200).length,
      failed: results.bdl.filter(r => r.status !== 200).map(r => `${r.endpoint}: ${r.status} ${r.error?.substring(0, 100) || ''}`),
      fieldReport: {}
    },
    sr: {
      total: results.sr.length,
      success: results.sr.filter(r => r.status === 200).length,
      failed: results.sr.filter(r => r.status && r.status !== 200).map(r => `${r.endpoint}: ${r.status} ${r.error?.substring(0, 100) || ''}`),
    }
  };

  // Check critical fields for our framework
  const teamStats = results.bdl.find(r => r.endpoint.startsWith('Team Stats'));
  if (teamStats?.sample) {
    const s = teamStats.sample;
    const critical = {
      // I1 fields
      turnovers: s.turnovers, steals: s.steals, oreb: s.oreb,
      // I2 fields  
      pts_in_paint: s.pts_in_paint, fta: s.fta, blk: s.blk, pf: s.pf,
      // I3 fields
      ast: s.ast, fgm: s.fgm, fg_pct: s.fg_pct, fg3m: s.fg3m, fg3a: s.fg3a, fg3_pct: s.fg3_pct,
      // I4 fields (bench/biggest_lead may not be on BDL)
      // I5 fields
      possessions: s.possessions, pace: s.pace,
      // Other
      pts: s.pts, reb: s.reb, dreb: s.dreb,
    };
    summary.bdl.fieldReport.teamStats = {
      present: Object.entries(critical).filter(([k, v]) => v !== undefined).map(([k]) => k),
      missing: Object.entries(critical).filter(([k, v]) => v === undefined).map(([k]) => k),
      allFields: Object.keys(s)
    };
  }

  return new Response(JSON.stringify({ summary, results }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
};

export const config = { path: '/.netlify/functions/validate-wnba' };

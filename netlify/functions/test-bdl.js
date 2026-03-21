// ══════════════════════════════════════════════════════════════════════════════
// BDL Endpoint Probe — Comprehensive Migration Data Discovery (Parallel)
// All endpoint tests fire simultaneously — BDL allows 600 req/min (10/sec)
//
// Deploy to netlify/functions/test-bdl.js, then hit:
//   /.netlify/functions/test-bdl                   — NBA, all tests
//   /.netlify/functions/test-bdl?league=ncaamb      — NCAAMB, all tests
//   /.netlify/functions/test-bdl?test=plays         — PBP only
//   /.netlify/functions/test-bdl?test=all           — explicit all
//   /.netlify/functions/test-bdl?game_id=12345      — specific game
//
// Valid test= values: plays, stats, box_scores, lineups, game, games,
//                     advanced (NBA), ncaamb (NCAAMB-specific), all
// ══════════════════════════════════════════════════════════════════════════════

const BDL_KEY = process.env.BDL_API_KEY;
const BASE = 'https://api.balldontlie.io';
const hdrs = () => ({ Authorization: BDL_KEY });

// ── Shared helpers ──────────────────────────────────────────────────────────

async function bdlFetch(path) {
  const url = BASE + path;
  const start = Date.now();
  try {
    const r = await fetch(url, { headers: hdrs() });
    const elapsed = Date.now() - start;
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, status: r.status, error: txt.substring(0, 300), elapsed, url };
    }
    const data = await r.json();
    return { ok: true, status: r.status, data, elapsed, url };
  } catch (e) {
    return { ok: false, status: 0, error: e.message, elapsed: Date.now() - start, url };
  }
}

function fieldInventory(arr, label) {
  if (!Array.isArray(arr) || arr.length === 0) return { label, count: 0, fields: [] };
  const allKeys = new Set();
  arr.forEach(item => { if (item && typeof item === 'object') Object.keys(item).forEach(k => allKeys.add(k)); });
  const fields = {};
  [...allKeys].sort().forEach(k => {
    const val = arr[0][k];
    const valType = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
    let sample = val;
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) sample = '{' + Object.keys(val).join(',') + '}';
    else if (Array.isArray(val)) sample = '[' + val.length + ' items]';
    else if (typeof val === 'string' && val.length > 80) sample = val.substring(0, 80) + '...';
    fields[k] = { type: valType, sample };
  });
  return { label, count: arr.length, fieldCount: [...allKeys].length, fields };
}

function findEventSamples(plays) {
  if (!Array.isArray(plays) || plays.length === 0) return {};
  const samples = {};
  const targets = {
    'made_2pt': e => e.scoring_play && e.score_value === 2,
    'made_3pt': e => e.scoring_play && e.score_value === 3,
    'missed_shot': e => e.shooting_play && !e.scoring_play,
    'free_throw': e => (e.type || '').toLowerCase().includes('free throw'),
    'turnover': e => (e.type || '').toLowerCase().includes('turnover'),
    'rebound': e => (e.type || '').toLowerCase().includes('rebound'),
    'foul': e => (e.type || '').toLowerCase().includes('foul'),
    'steal': e => (e.type || '').toLowerCase().includes('steal'),
    'block': e => (e.type || '').toLowerCase().includes('block'),
    'assist_in_text': e => (e.text || '').toLowerCase().includes('assist'),
    'has_coordinates': e => e.coordinate_x != null && e.coordinate_y != null,
    'layup': e => (e.type || '').toLowerCase().includes('layup') || (e.text || '').toLowerCase().includes('layup'),
    'dunk': e => (e.type || '').toLowerCase().includes('dunk') || (e.text || '').toLowerCase().includes('dunk'),
    'three_pointer': e => (e.type || '').toLowerCase().includes('three') || (e.text || '').toLowerCase().includes('three'),
    'jump_shot': e => (e.type || '').toLowerCase().includes('jump shot'),
    'driving': e => (e.type || '').toLowerCase().includes('driving') || (e.text || '').toLowerCase().includes('driving'),
    'pullup': e => (e.type || '').toLowerCase().includes('pullup') || (e.type || '').toLowerCase().includes('pull-up'),
    'hook': e => (e.type || '').toLowerCase().includes('hook'),
    'floater': e => (e.type || '').toLowerCase().includes('float'),
    'tip': e => (e.type || '').toLowerCase().includes('tip'),
    'fast_break_in_text': e => (e.text || '').toLowerCase().includes('fast break'),
  };
  for (const [name, filter] of Object.entries(targets)) {
    samples[name] = plays.find(filter) || null;
  }
  return samples;
}

function analyzeCoordinates(plays) {
  if (!Array.isArray(plays)) return null;
  const withCoords = plays.filter(e => e.coordinate_x != null && e.coordinate_y != null);
  if (withCoords.length === 0) return { hasCoordinates: false, count: 0 };

  const xs = withCoords.map(e => e.coordinate_x);
  const ys = withCoords.map(e => e.coordinate_y);
  const shooting = withCoords.filter(e => e.shooting_play);

  const stats = {
    hasCoordinates: true,
    totalEvents: plays.length,
    withCoords: withCoords.length,
    shootingWithCoords: shooting.length,
    x: { min: Math.min(...xs), max: Math.max(...xs), mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) },
    y: { min: Math.min(...ys), max: Math.max(...ys), mean: +(ys.reduce((a, b) => a + b, 0) / ys.length).toFixed(2) },
  };

  if (shooting.length > 10) {
    stats.yDistribution = {
      y_lt_15: shooting.filter(e => e.coordinate_y < 15).length,
      y_15_to_35: shooting.filter(e => e.coordinate_y >= 15 && e.coordinate_y <= 35).length,
      y_gt_35: shooting.filter(e => e.coordinate_y > 35).length,
      note: 'If most shots cluster at one end → half-court coords',
    };

    // Rim shots (layups/dunks) → reveals basket location
    const rim = shooting.filter(e => { const t = (e.type || '').toLowerCase(); return t.includes('layup') || t.includes('dunk'); });
    if (rim.length > 0) {
      stats.rimShotCoords = rim.slice(0, 8).map(e => ({
        x: e.coordinate_x, y: e.coordinate_y, type: e.type,
        text: (e.text || '').substring(0, 60), team: e.team?.abbreviation || '?',
      }));
    }

    // 3-pointers → reveals arc range
    const threes = shooting.filter(e => e.score_value === 3 || (e.type || '').toLowerCase().includes('three'));
    if (threes.length > 0) {
      stats.threePointCoords = {
        sampleCount: threes.length,
        samples: threes.slice(0, 8).map(e => ({
          x: e.coordinate_x, y: e.coordinate_y, type: e.type,
          team: e.team?.abbreviation || '?', text: (e.text || '').substring(0, 60),
        })),
      };
    }

    // Mid-range
    const mid = shooting.filter(e => {
      const t = (e.type || '').toLowerCase();
      return (t.includes('jump shot') || t.includes('pullup') || t.includes('fadeaway'))
        && !t.includes('three') && e.score_value !== 3;
    });
    if (mid.length > 0) {
      stats.midRangeCoords = mid.slice(0, 5).map(e => ({
        x: e.coordinate_x, y: e.coordinate_y, type: e.type, team: e.team?.abbreviation || '?',
      }));
    }
  }
  return stats;
}

// ── Individual test functions (each returns a result object) ─────────────────

async function testPlays(pfx, gid) {
  const out = {};

  // Fire all pagination sizes + cursor test in parallel
  const [p100, p250, p500, fp] = await Promise.all([
    bdlFetch(`${pfx}/v1/plays?game_id=${gid}&per_page=100`),
    bdlFetch(`${pfx}/v1/plays?game_id=${gid}&per_page=250`),
    bdlFetch(`${pfx}/v1/plays?game_id=${gid}&per_page=500`),
    bdlFetch(`${pfx}/v1/plays?game_id=${gid}&per_page=50`),
  ]);

  for (const [label, r] of [['per_page_100', p100], ['per_page_250', p250], ['per_page_500', p500]]) {
    if (r.ok) {
      const plays = r.data?.data || [];
      out[label] = { returned: plays.length, meta: r.data?.meta || {}, elapsed: r.elapsed + 'ms' };

      // Deep analysis on the largest successful fetch
      if (label === 'per_page_500' || (!out._analyzed && plays.length > 0)) {
        out._analyzed = true;
        out.fieldInventory = fieldInventory(plays, 'plays');
        out.first3 = plays.slice(0, 3);
        out.last3 = plays.slice(-3);

        // Event type frequency
        const types = {};
        plays.forEach(e => { types[e.type || 'UNKNOWN'] = (types[e.type || 'UNKNOWN'] || 0) + 1; });
        out.eventTypes = types;

        out.targetedSamples = findEventSamples(plays);
        out.coordinateAnalysis = analyzeCoordinates(plays);

        // Period breakdown
        const byPeriod = {};
        plays.forEach(e => { byPeriod[e.period || 0] = (byPeriod[e.period || 0] || 0) + 1; });
        out.eventsByPeriod = byPeriod;

        out.textSamples = plays.filter(e => e.text).slice(0, 5).map(e => e.text);

        // Participants
        const withP = plays.filter(e => e.participants && e.participants.length > 0);
        out.participantsAnalysis = {
          eventsWithParticipants: withP.length, totalEvents: plays.length,
          samples: withP.slice(0, 5).map(e => ({ type: e.type, participants: e.participants, text: (e.text || '').substring(0, 80) })),
        };

        // Running score tracking
        const withScores = plays.filter(e => e.home_score != null || e.away_score != null);
        out.scoreTracking = {
          eventsWithScores: withScores.length, totalEvents: plays.length,
          lastScoreEvent: withScores.length > 0 ? withScores[withScores.length - 1] : null,
        };
      }
    } else {
      out[label] = { error: r.error, status: r.status };
    }
  }

  // Cursor pagination test
  if (fp.ok) {
    const meta = fp.data?.meta || {};
    out.paginationTest = { firstPageCount: (fp.data?.data || []).length, meta, hasNextCursor: meta.next_cursor != null };
    if (meta.next_cursor) {
      const sp = await bdlFetch(`${pfx}/v1/plays?game_id=${gid}&per_page=50&cursor=${meta.next_cursor}`);
      if (sp.ok) {
        out.paginationTest.secondPageCount = (sp.data?.data || []).length;
        out.paginationTest.secondMeta = sp.data?.meta || {};
      }
    }
  }

  delete out._analyzed;
  return out;
}

async function testStats(pfx, gid, league) {
  const out = {};
  const statsPath = league === 'ncaamb'
    ? `${pfx}/v1/player_stats?game_id=${gid}&per_page=100`
    : `${pfx}/v1/stats?game_ids[]=${gid}&per_page=100`;

  // Fire main + period test in parallel (period test NBA only)
  const fetches = [bdlFetch(statsPath)];
  if (league === 'nba') fetches.push(bdlFetch(`/nba/v1/stats?game_ids[]=${gid}&per_page=100&periods[]=1`));

  const [r, q1] = await Promise.all(fetches);

  if (r.ok) {
    const data = r.data?.data || [];
    out.count = data.length;
    out.elapsed = r.elapsed + 'ms';
    out.fieldInventory = fieldInventory(data, 'player_stats');
    out.samplePlayer = data[0] || null;
    const teams = {};
    data.forEach(p => {
      const abbr = p.team?.abbreviation || p.player?.team?.abbreviation || '?';
      if (!teams[abbr]) teams[abbr] = { players: 0, totalPts: 0, totalFgm: 0, totalFga: 0, totalOreb: 0, totalTov: 0, totalStl: 0, totalBlk: 0, totalAst: 0, totalFtm: 0, totalFta: 0, totalFg3m: 0, totalFg3a: 0 };
      teams[abbr].players++;
      teams[abbr].totalPts += p.pts || 0;
      teams[abbr].totalFgm += p.fgm || 0;
      teams[abbr].totalFga += p.fga || 0;
      teams[abbr].totalOreb += p.oreb || 0;
      teams[abbr].totalTov += p.turnover || 0;
      teams[abbr].totalStl += p.stl || 0;
      teams[abbr].totalBlk += p.blk || 0;
      teams[abbr].totalAst += p.ast || 0;
      teams[abbr].totalFtm += p.ftm || 0;
      teams[abbr].totalFta += p.fta || 0;
      teams[abbr].totalFg3m += p.fg3m || 0;
      teams[abbr].totalFg3a += p.fg3a || 0;
    });
    out.teamBreakdown = teams;
    out.meta = r.data?.meta || {};
  } else {
    out.error = r.error; out.status = r.status; out.url = r.url;
  }

  if (q1) {
    out.period1Test = q1.ok
      ? { count: (q1.data?.data || []).length, sample: (q1.data?.data || [])[0] || null }
      : { error: q1.error, status: q1.status };
  }

  return out;
}

async function testBoxScores(pfx, gid, gameDate) {
  const out = {};
  // Fire date + live in parallel
  const fetches = [bdlFetch(`${pfx}/v1/box_scores/live`)];
  if (gameDate) fetches.unshift(bdlFetch(`${pfx}/v1/box_scores?date=${gameDate}`));

  const results = await Promise.all(fetches);
  const dateR = gameDate ? results[0] : null;
  const liveR = gameDate ? results[1] : results[0];

  if (dateR) {
    if (dateR.ok) {
      const data = dateR.data?.data || [];
      out.dateQuery = { gamesReturned: data.length, elapsed: dateR.elapsed + 'ms' };
      const ourGame = data.find(g => g.id === gid) || data[0];
      if (ourGame) {
        out.gameShape = {
          topLevelFields: Object.keys(ourGame).sort(),
          hasHomeTeam: !!ourGame.home_team, hasVisitorTeam: !!ourGame.visitor_team,
          homePlayerCount: ourGame.home_team?.players?.length || 0,
          visitorPlayerCount: ourGame.visitor_team?.players?.length || 0,
        };
        if (ourGame.home_team?.players?.[0]) out.sampleHomePlayer = ourGame.home_team.players[0];
        if (ourGame.visitor_team?.players?.[0]) out.sampleVisitorPlayer = ourGame.visitor_team.players[0];
        out.gameMetadata = {
          status: ourGame.status, period: ourGame.period, time: ourGame.time,
          period_detail: ourGame.period_detail,
          home_team_score: ourGame.home_team_score, visitor_team_score: ourGame.visitor_team_score,
        };
      }
    } else {
      out.dateQuery = { error: dateR.error, status: dateR.status, url: dateR.url };
    }
  }

  out.live = liveR.ok
    ? { gamesReturned: (liveR.data?.data || []).length, elapsed: liveR.elapsed + 'ms',
        games: (liveR.data?.data || []).map(g => ({
          id: g.id, status: g.status, period: g.period, time: g.time,
          home: g.home_team?.team?.abbreviation || g.home_team?.abbreviation,
          away: g.visitor_team?.team?.abbreviation || g.visitor_team?.abbreviation,
          score: (g.home_team_score || 0) + '-' + (g.visitor_team_score || 0),
        })) }
    : { error: liveR.error, status: liveR.status };

  return out;
}

async function testLineups(pfx, gid) {
  const r = await bdlFetch(`${pfx}/v1/lineups?game_ids[]=${gid}&per_page=50`);
  if (r.ok) {
    const data = r.data?.data || [];
    return { count: data.length, elapsed: r.elapsed + 'ms', fieldInventory: fieldInventory(data, 'lineups'),
             samples: data.slice(0, 4), meta: r.data?.meta || {} };
  }
  return { error: r.error, status: r.status, url: r.url };
}

async function testGameDetail(pfx, gid) {
  const r = await bdlFetch(`${pfx}/v1/games/${gid}`);
  if (r.ok) {
    const g = r.data?.data || r.data;
    return { allFields: Object.keys(g).sort(), fullData: g, elapsed: r.elapsed + 'ms' };
  }
  return { error: r.error, status: r.status };
}

async function testGamesList(pfx, gameDate) {
  if (!gameDate) return { skipped: 'no gameDate' };
  const r = await bdlFetch(`${pfx}/v1/games?dates[]=${gameDate}&per_page=15`);
  if (r.ok) {
    const data = r.data?.data || [];
    return { count: data.length, elapsed: r.elapsed + 'ms', fieldInventory: fieldInventory(data, 'games'),
             sampleGame: data[0] || null, meta: r.data?.meta || {} };
  }
  return { error: r.error, status: r.status };
}

async function testAdvanced(gid) {
  // Try v1 and v2 in parallel
  const [r1, r2] = await Promise.all([
    bdlFetch(`/nba/v1/stats/advanced?game_ids[]=${gid}&per_page=100`),
    bdlFetch(`/v2/stats/advanced?game_ids[]=${gid}&per_page=100`),
  ]);
  if (r1.ok) {
    const data = r1.data?.data || [];
    return { path: 'v1', count: data.length, elapsed: r1.elapsed + 'ms',
             fieldInventory: fieldInventory(data, 'advanced'), samplePlayer: data[0] || null };
  }
  if (r2.ok) {
    const data = r2.data?.data || [];
    return { path: 'v2', count: data.length, elapsed: r2.elapsed + 'ms',
             fieldInventory: fieldInventory(data, 'advanced_v2'), samplePlayer: data[0] || null };
  }
  return { v1_error: r1.error, v2_error: r2.error };
}

async function testNcaambSpecific(pfx, gid) {
  const [ts, rk, br] = await Promise.all([
    bdlFetch(`${pfx}/v1/team_stats?game_id=${gid}&per_page=50`),
    bdlFetch(`${pfx}/v1/rankings?season=2025`),
    bdlFetch(`${pfx}/v1/bracket?season=2025`),
  ]);
  return {
    team_stats: ts.ok
      ? { count: (ts.data?.data || []).length, fieldInventory: fieldInventory(ts.data?.data || [], 'team_stats'),
          sample: (ts.data?.data || [])[0] || null, elapsed: ts.elapsed + 'ms' }
      : { error: ts.error, status: ts.status, url: ts.url },
    rankings: rk.ok
      ? { count: (rk.data?.data || []).length, sample: (rk.data?.data || [])[0] || null, elapsed: rk.elapsed + 'ms' }
      : { error: rk.error, status: rk.status },
    bracket: br.ok
      ? { topLevelKeys: Object.keys(br.data || {}), elapsed: br.elapsed + 'ms',
          sample: JSON.stringify(br.data).substring(0, 500) }
      : { error: br.error, status: br.status },
  };
}

// ── Main handler ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (!BDL_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'BDL_API_KEY not set' }) };

  const params = event.queryStringParameters || {};
  const league = (params.league || 'nba').toLowerCase();
  const singleTest = params.test || null;
  const forceGameId = params.game_id ? parseInt(params.game_id) : null;
  const pfx = league === 'ncaamb' ? '/ncaab' : league === 'wnba' ? '/wnba' : '/nba';
  const totalStart = Date.now();

  try {
    // ── STEP 0: Find a recent completed game (sequential — need gid for everything) ──
    let game = null;
    let gameDate = null;

    if (forceGameId) {
      const gr = await bdlFetch(`${pfx}/v1/games/${forceGameId}`);
      if (gr.ok && gr.data) {
        game = gr.data.data || gr.data;
        gameDate = game.date;
      }
    }

    if (!game) {
      const today = new Date();
      for (let d = 0; d <= 5; d++) {
        const dt = new Date(today - d * 86400000).toISOString().split('T')[0];
        const gr = await bdlFetch(`${pfx}/v1/games?dates[]=${dt}&per_page=15`);
        if (gr.ok && gr.data?.data) {
          const final = gr.data.data.find(g => g.status === 'Final');
          if (final) { game = final; gameDate = dt; break; }
          if (!game && gr.data.data.length > 0) { game = gr.data.data[0]; gameDate = dt; }
        }
      }
    }

    if (!game) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'No games found in last 5 days', league }) };
    }

    const gid = game.id;
    const _game = {
      id: gid, date: gameDate, status: game.status,
      home: game.home_team?.abbreviation, away: game.visitor_team?.abbreviation,
      score: (game.home_team_score || 0) + '-' + (game.visitor_team_score || 0),
      homeId: game.home_team?.id, awayId: game.visitor_team?.id,
    };

    // ── STEP 1: Fire all applicable tests in parallel ──
    const shouldRun = (name) => !singleTest || singleTest === name || singleTest === 'all';

    const testMap = {};
    if (shouldRun('plays'))      testMap.plays = testPlays(pfx, gid);
    if (shouldRun('stats'))      testMap.stats = testStats(pfx, gid, league);
    if (shouldRun('box_scores')) testMap.box_scores = testBoxScores(pfx, gid, gameDate);
    if (shouldRun('lineups'))    testMap.lineups = testLineups(pfx, gid);
    if (shouldRun('game'))       testMap.game_detail = testGameDetail(pfx, gid);
    if (shouldRun('games'))      testMap.games_list = testGamesList(pfx, gameDate);
    if (league === 'nba' && shouldRun('advanced'))  testMap.advanced = testAdvanced(gid);
    if (league === 'ncaamb' && shouldRun('ncaamb')) testMap.ncaamb_specific = testNcaambSpecific(pfx, gid);

    // Await all in parallel
    const keys = Object.keys(testMap);
    const values = await Promise.all(Object.values(testMap));
    const results = { _game };
    keys.forEach((k, i) => { results[k] = values[i]; });

    results._summary = {
      league, gameId: gid, gameDate,
      testsRun: keys.length,
      totalElapsed: (Date.now() - totalStart) + 'ms',
      timestamp: new Date().toISOString(),
      note: 'All tests ran in parallel — BDL 600 req/min',
    };

    return { statusCode: 200, headers, body: JSON.stringify(results, null, 2) };

  } catch (e) {
    return { statusCode: 200, headers,
      body: JSON.stringify({ error: 'Fatal: ' + e.message, stack: e.stack?.substring(0, 500) }) };
  }
};

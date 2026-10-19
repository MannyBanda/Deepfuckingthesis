// Sportradar Multi-League API Proxy
// Adds API key server-side, handles CORS, rate limit awareness
// Supports: nba, ncaamb, wnba via ?league= param (defaults to nba)
// Season is DERIVED (netlify/lib/season.js, SEASON_CONSOLIDATION_SPEC v1) —
// never hardcoded here. `&season=YYYY` overrides for viewing a past season.

const SEASON = require('../lib/season.js');

const LEAGUES = {
  nba: {
    base: 'https://api.sportradar.com/nba/trial/v8/en/',
    keyEnv: 'SR_API_KEY',
    seasonType: 'REG',
    hasDepthChart: true,
    hasSplits: true,
    hasDailyInjuries: true,
    hasHierarchy: false,    // NBA team IDs are hardcoded client-side
    hasNetRankings: false,
    hasRpi: false,
    hasBracket: false,
    hasPolls: false,
  },
  ncaamb: {
    base: 'https://api.sportradar.com/ncaamb/trial/v8/en/',
    keyEnv: 'SR_NCAAMB_KEY',
    seasonType: 'REG',
    hasDepthChart: false,
    hasSplits: false,
    hasDailyInjuries: false,
    hasHierarchy: true,
    hasNetRankings: true,
    hasRpi: true,
    hasBracket: true,
    hasPolls: true,
  },
  wnba: {
    base: 'https://api.sportradar.com/wnba/trial/v8/en/',
    keyEnv: 'SR_WNBA_KEY',
    seasonType: 'REG',
    hasDepthChart: false,
    hasSplits: true,
    hasDailyInjuries: true,
    hasHierarchy: true,
    hasNetRankings: false,
    hasRpi: false,
    hasBracket: false,
    hasPolls: false,
  },
};

// Endpoint path builders — league config injected at call time
const ENDPOINTS = {
  // === Shared across all leagues ===
  schedule:        (p, cfg) => `games/${p.year}/${p.month}/${p.day}/schedule.json`,
  profile:         (p, cfg) => `teams/${p.team_id}/profile.json`,
  statistics:      (p, cfg) => `seasons/${cfg.season}/${p.season_type || cfg.seasonType}/teams/${p.team_id}/statistics.json`,
  standings:       (p, cfg) => `seasons/${cfg.season}/${p.season_type || cfg.seasonType}/standings.json`,
  summary:         (p, cfg) => `games/${p.game_id}/summary.json`,
  pbp:             (p, cfg) => `games/${p.game_id}/pbp.json`,

  // === NBA + WNBA only ===
  injuries:        (p, cfg) => `league/injuries.json`,
  depth_chart:     (p, cfg) => `teams/${p.team_id}/depth_chart.json`,

  // === NBA + WNBA (has splits) ===
  splits_game:     (p, cfg) => `seasons/${cfg.season}/${p.season_type || cfg.seasonType}/teams/${p.team_id}/splits/game.json`,
  splits_schedule: (p, cfg) => `seasons/${cfg.season}/${p.season_type || cfg.seasonType}/teams/${p.team_id}/splits/schedule.json`,

  // === NCAAMB + WNBA (dynamic team discovery) ===
  hierarchy:       (p, cfg) => `league/hierarchy.json`,

  // === NCAAMB only ===
  net_rankings:    (p, cfg) => `seasons/${cfg.season}/${p.season_type || cfg.seasonType}/rankings/net.json`,
  rpi:             (p, cfg) => `seasons/${cfg.season}/${p.season_type || cfg.seasonType}/rankings/rpi.json`,
  polls:           (p, cfg) => `seasons/${cfg.season}/${p.season_type || cfg.seasonType}/rankings.json`,
  bracket:         (p, cfg) => `tournaments/${p.tournament_id || 'NCAA'}/schedule.json`,

  // === Tournament schedule (NCAAMB March Madness) ===
  tournament_list: (p, cfg) => `tournaments.json`,
  tournament_schedule: (p, cfg) => `tournaments/${p.tournament_id}/schedule.json`,
  tournament_summary:  (p, cfg) => `tournaments/${p.tournament_id}/summary.json`,
};

// Endpoints that are gated by league capabilities
const LEAGUE_GATES = {
  depth_chart:     'hasDepthChart',
  splits_game:     'hasSplits',
  splits_schedule: 'hasSplits',
  injuries:        'hasDailyInjuries',
  hierarchy:       'hasHierarchy',
  net_rankings:    'hasNetRankings',
  rpi:             'hasRpi',
  polls:           'hasPolls',
  bracket:         'hasBracket',
  tournament_list: 'hasBracket',
  tournament_schedule: 'hasBracket',
  tournament_summary:  'hasBracket',
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const params = event.queryStringParameters || {};
  const type = params.type;
  const league = (params.league || 'nba').toLowerCase();

  // Validate league
  const cfg = LEAGUES[league];
  if (!cfg) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid league. Valid: ' + Object.keys(LEAGUES).join(', ') }),
    };
  }

  // Validate endpoint
  if (!type || !ENDPOINTS[type]) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid type. Valid: ' + Object.keys(ENDPOINTS).join(', ') }),
    };
  }

  // Check league-specific gate
  const gate = LEAGUE_GATES[type];
  if (gate && !cfg[gate]) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: `${type} is not available for ${league}`,
        league,
        gated: true,
      }),
    };
  }

  // Get API key
  const apiKey = process.env[cfg.keyEnv];
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: `${cfg.keyEnv} not configured in environment` }),
    };
  }

  try {
    // Season resolved per request: explicit &season= wins, else derived for the league.
    const season = String(params.season || SEASON.seasonFor(league));
    const srGet = async (ssn) => {
      const path = ENDPOINTS[type](params, Object.assign({}, cfg, { season: ssn }));
      const resp = await fetch(`${cfg.base}${path}?api_key=${apiKey}`);
      if (resp.status === 429) return { rateLimited: true };
      if (!resp.ok) { const text = await resp.text(); return { errStatus: resp.status, errText: text }; }
      return { data: await resp.json() };
    };

    let r = await srGet(season);

    // BASELINE types warm-start (SEASON_CONSOLIDATION_SPEC v1 §2): with no explicit
    // &season=, a team under WARM_START_GP games this season is served the PRIOR
    // season's statistics/splits, stamped as `_dft_baseline` on the JSON (SR bodies
    // are objects, so the extra key is harmless to every consumer).
    const BASELINE_TYPES = { statistics: SEASON.gpFromSRStats, splits_game: SEASON.gpFromSRSplits, splits_schedule: SEASON.gpFromSRSplits };
    if (!params.season && BASELINE_TYPES[type] && r.data) {
      const gp = BASELINE_TYPES[type](r.data);
      const pick = SEASON.pickBaselineSeason(league, gp, season);
      if (pick.source === 'prior') {
        await new Promise((res) => setTimeout(res, 1100)); // SR trial: 1 req/sec
        const pr = await srGet(pick.season);
        if (pr.data) { r = pr; r.data._dft_baseline = pick; }
        else r.data._dft_baseline = Object.assign({}, pick, { season, source: 'current', fallbackFailed: true });
      } else {
        r.data._dft_baseline = pick;
      }
    }

    if (r.rateLimited) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ error: 'Sportradar rate limited. Retry in 1s.', retry: true, league }),
      };
    }

    if (r.errStatus) {
      return {
        statusCode: r.errStatus,
        headers,
        body: JSON.stringify({ error: `SR ${r.errStatus}: ${String(r.errText || '').substring(0, 200)}`, league }),
      };
    }

    let data = r.data;

    // === NCAAMB Statistics Normalization ===
    // NCAAMB returns a flat { own_record, opponents, players } shape.
    // Normalize to match NBA's { team_records, player_records } so the client
    // code doesn't need league branching for stats consumption.
    if (type === 'statistics' && league === 'ncaamb' && data.own_record && !data.team_records) {
      data = normalizeNcaambStats(data);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, league }),
    };
  }
};

// Reshape NCAAMB flat statistics into NBA-compatible structure.
// NBA shape:
//   team_records[0].record_type="total" .own_record.total/average .opponents.total/average
//   player_records[i] .player{} .total/average
//
// NCAAMB raw shape:
//   own_record.total/average
//   opponents.total/average
//   players[i] .full_name, .total, .average, etc.
//
// We wrap into the NBA container so client code can use one destructuring path.
function normalizeNcaambStats(raw) {
  return {
    _normalized: true,
    _source: 'ncaamb_flat',
    _dft_baseline: raw._dft_baseline || undefined, // carry the warm-start stamp through normalization
    // Team-level: wrap in team_records array with a single "total" entry
    team_records: [{
      record_type: 'total',
      own_record: raw.own_record,
      opponents: raw.opponents,
    }],
    // Player-level: map players array to player_records shape
    player_records: (raw.players || []).map(p => ({
      player: {
        id: p.id,
        full_name: p.full_name,
        first_name: p.first_name,
        last_name: p.last_name,
        position: p.position || p.primary_position,
        jersey_number: p.jersey_number,
      },
      total: p.total,
      average: p.average,
      // Preserve NCAAMB bonus fields at player level
      usage_pct: p.usage_pct,
      true_shooting_pct: p.true_shooting_pct,
      true_shooting_att: p.true_shooting_att,
    })),
    // Preserve raw for debugging
    _raw_own: raw.own_record,
    _raw_opponents: raw.opponents,
  };
}

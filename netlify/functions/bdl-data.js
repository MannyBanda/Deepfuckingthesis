// BallDontLie Multi-League API Proxy
// Fallback data source when Sportradar is throttled
// Supports: nba, ncaamb, wnba via ?league= param (defaults to nba)

const BDL_BASE = 'https://api.balldontlie.io';

// League path prefixes and capability flags
const LEAGUES = {
  nba: {
    prefix: '/nba',
    hasAdvanced: true,    // /v2/stats/advanced
    hasOdds: true,        // /v2/odds
    hasClutch: true,      // /v1/team_season_averages/clutch
    hasInjuries: true,    // /v1/player_injuries
    hasTracking: true,    // /v1/team_season_averages (shotdashboard etc.)
    hasBracket: false,
    hasRankings: false,
  },
  ncaamb: {
    prefix: '/ncaab',
    hasAdvanced: false,
    hasOdds: true,        // /ncaab/v1/odds
    hasClutch: false,
    hasInjuries: false,
    hasTracking: false,
    hasBracket: true,     // /ncaab/v1/bracket
    hasRankings: true,    // /ncaab/v1/rankings
  },
  wnba: {
    prefix: '/wnba',
    hasAdvanced: false,
    hasOdds: false,
    hasClutch: false,
    hasInjuries: true,    // /wnba/v1/player_injuries
    hasTracking: false,
    hasBracket: false,
    hasRankings: false,
  },
};

// Gate map: endpoint type → required capability
const GATES = {
  advanced: 'hasAdvanced',
  odds: 'hasOdds',
  clutch: 'hasClutch',
  player_injuries: 'hasInjuries',
  tracking: 'hasTracking',
  bracket: 'hasBracket',
  rankings: 'hasRankings',
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

  const apiKey = process.env.BDL_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'BDL_API_KEY not configured in environment' }),
    };
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

  // Check capability gate
  const gate = GATES[type];
  if (gate && !cfg[gate]) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: `${type} is not available for ${league} via BDL`,
        league,
        gated: true,
      }),
    };
  }

  const pfx = cfg.prefix;  // e.g. '/nba', '/ncaab', '/wnba'

  // Build URL based on type
  let url;
  switch (type) {
    case 'games':
      // NBA:    /nba/v1/games?dates[]=YYYY-MM-DD
      // NCAAMB: /ncaab/v1/games?dates[]=YYYY-MM-DD
      url = `${BDL_BASE}${pfx}/v1/games?dates[]=${params.date}&per_page=25`;
      break;

    case 'game':
      // Single game detail
      url = `${BDL_BASE}${pfx}/v1/games/${params.game_id}`;
      break;

    case 'stats':
      // Basic box score stats
      // NBA:    /nba/v1/stats?game_ids[]=ID
      // NCAAMB: /ncaab/v1/player_stats?game_id=ID  (different param name!)
      if (league === 'ncaamb') {
        url = `${BDL_BASE}${pfx}/v1/player_stats?game_id=${params.game_id}&per_page=100`;
      } else {
        url = `${BDL_BASE}${pfx}/v1/stats?game_ids[]=${params.game_id}&per_page=100`;
        if (params.period) url += `&periods[]=${params.period}`;
      }
      break;

    case 'team_stats':
      // NCAAMB/WNBA team stats
      url = `${BDL_BASE}${pfx}/v1/team_stats?game_id=${params.game_id}&per_page=50`;
      break;

    case 'advanced':
      // NBA only (gated above for other leagues)
      url = `${BDL_BASE}/v2/stats/advanced?game_ids[]=${params.game_id}&per_page=100`;
      if (params.period) url += `&periods[]=${params.period}`;
      break;

    case 'player_injuries':
      // NBA + WNBA
      url = `${BDL_BASE}${pfx}/v1/player_injuries?per_page=100`;
      if (params.team_id) url += `&team_ids[]=${params.team_id}`;
      if (params.team_id2) url += `&team_ids[]=${params.team_id2}`;
      break;

    case 'team_games':
      // Recent games for a team — used by NBA thesis gen for recent form
      url = `${BDL_BASE}${pfx}/v1/games?team_ids[]=${params.team_id}&per_page=${params.per_page||5}`;
      if (params.end_date) url += `&end_date=${params.end_date}`;
      if (params.start_date) url += `&start_date=${params.start_date}`;
      break;

    case 'multi_stats':
      // Box scores across multiple games — comma-separated game_ids expanded to game_ids[]=X&game_ids[]=Y
      url = `${BDL_BASE}${pfx}/v1/stats?per_page=100`;
      if (params.game_ids) {
        params.game_ids.split(',').forEach(id => { url += `&game_ids[]=${id.trim()}`; });
      }
      break;

    case 'odds':
      // NBA:    /nba/v2/odds?game_id=ID
      // NCAAMB: /ncaab/v1/odds?game_ids[]=ID (array param per BDL spec)
      if (league === 'nba') {
        url = `${BDL_BASE}/v2/odds?game_id=${params.game_id}`;
      } else {
        url = `${BDL_BASE}${pfx}/v1/odds?game_ids[]=${params.game_id}`;
      }
      break;

    case 'standings':
      // /ncaab/v1/standings?season=YYYY or /wnba/v1/standings?season=YYYY
      url = `${BDL_BASE}${pfx}/v1/standings?season=${params.season || '2025'}`;
      break;

    case 'rankings':
      // NCAAMB only: /ncaab/v1/rankings?season=YYYY
      url = `${BDL_BASE}${pfx}/v1/rankings?season=${params.season || '2025'}`;
      break;

    case 'bracket':
      // NCAAMB only: /ncaab/v1/bracket?season=YYYY
      url = `${BDL_BASE}${pfx}/v1/bracket?season=${params.season || '2025'}`;
      break;

    case 'season_stats':
      // Player season stats (all leagues)
      url = `${BDL_BASE}${pfx}/v1/player_season_stats?season=${params.season || '2025'}&per_page=100`;
      if (params.team_id) url += `&team_id=${params.team_id}`;
      break;

    case 'team_season_stats':
      // Team season stats (all leagues)
      url = `${BDL_BASE}${pfx}/v1/team_season_stats?season=${params.season || '2025'}&per_page=50`;
      if (params.team_id) url += `&team_id=${params.team_id}`;
      break;

    case 'plays':
      // Play-by-play (all leagues)
      url = `${BDL_BASE}${pfx}/v1/plays?game_id=${params.game_id}&per_page=100`;
      if (params.period) url += `&period=${params.period}`;
      break;

    default:
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Invalid type. Valid: games, game, stats, team_stats, advanced, player_injuries, team_games, multi_stats, odds, standings, rankings, bracket, season_stats, team_season_stats, plays',
          league,
        }),
      };
  }

  try {
    const resp = await fetch(url, {
      headers: { 'Authorization': apiKey },
    });

    if (!resp.ok) {
      const text = await resp.text();
      return {
        statusCode: resp.status,
        headers,
        body: JSON.stringify({ error: `BDL ${resp.status}: ${text.substring(0, 200)}`, league }),
      };
    }

    const data = await resp.json();
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

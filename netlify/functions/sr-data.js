// Sportradar NBA API Proxy
// Adds API key server-side, handles CORS, rate limit awareness
// v2 — season year parameterized, added rankings/transfers/hierarchy/changelog

const SR_BASE = 'https://api.sportradar.com/nba/trial/v8/en/';
const DEFAULT_SEASON = '2025';

// Helper: resolve season year from params (allows ?season=2024 override, defaults to current)
const szn = (p) => p.season || DEFAULT_SEASON;

const ENDPOINTS = {
  schedule: (p) => `games/${p.year}/${p.month}/${p.day}/schedule.json`,
  injuries: () => `league/injuries.json`,
  profile: (p) => `teams/${p.team_id}/profile.json`,
  depth_chart: (p) => `teams/${p.team_id}/depth_chart.json`,
  statistics: (p) => `seasons/${szn(p)}/REG/teams/${p.team_id}/statistics.json`,
  splits_game: (p) => `seasons/${szn(p)}/REG/teams/${p.team_id}/splits/game.json`,
  splits_schedule: (p) => `seasons/${szn(p)}/REG/teams/${p.team_id}/splits/schedule.json`,
  standings: (p) => `seasons/${szn(p)}/REG/standings.json`,
  rankings: (p) => `seasons/${szn(p)}/REG/rankings.json`,
  summary: (p) => `games/${p.game_id}/summary.json`,
  pbp: (p) => `games/${p.game_id}/pbp.json`,
  hierarchy: () => `league/hierarchy.json`,
  transfers: () => `league/transfers.json`,
  changelog: () => `league/changelog.json`,
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

  if (!type || !ENDPOINTS[type]) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid type. Valid: ' + Object.keys(ENDPOINTS).join(', ') }),
    };
  }

  const apiKey = process.env.SR_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'SR_API_KEY not configured in environment' }),
    };
  }

  try {
    const path = ENDPOINTS[type](params);
    const url = `${SR_BASE}${path}?api_key=${apiKey}`;

    const resp = await fetch(url);

    if (resp.status === 429) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ error: 'Sportradar rate limited. Retry in 1s.', retry: true }),
      };
    }

    if (!resp.ok) {
      const text = await resp.text();
      return {
        statusCode: resp.status,
        headers,
        body: JSON.stringify({ error: `SR ${resp.status}: ${text.substring(0, 200)}` }),
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
      body: JSON.stringify({ error: err.message }),
    };
  }
};

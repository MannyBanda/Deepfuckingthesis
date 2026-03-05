// BallDontLie NBA API Proxy
// Fallback data source when Sportradar is throttled

const BDL_BASE = 'https://api.balldontlie.io';

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

  // Build URL based on type
  let url;
  switch (type) {
    case 'games':
      // /v1/games?dates[]=YYYY-MM-DD
      url = `${BDL_BASE}/v1/games?dates[]=${params.date}&per_page=25`;
      break;
    case 'game':
      // /v1/games/:id - single game with quarter scores and bonus
      url = `${BDL_BASE}/v1/games/${params.game_id}`;
      break;
    case 'stats':
      // /v1/stats?game_ids[]=ID&per_page=100
      url = `${BDL_BASE}/v1/stats?game_ids[]=${params.game_id}&per_page=100`;
      if (params.period) url += `&periods[]=${params.period}`;
      break;
    case 'advanced':
      // /v2/stats/advanced?game_ids[]=ID&per_page=100
      url = `${BDL_BASE}/v2/stats/advanced?game_ids[]=${params.game_id}&per_page=100`;
      if (params.period) url += `&periods[]=${params.period}`;
      break;
    case 'player_injuries':
      // /v1/player_injuries?team_ids[]=ID&per_page=100
      url = `${BDL_BASE}/v1/player_injuries?per_page=100`;
      if (params.team_id) url += `&team_ids[]=${params.team_id}`;
      if (params.team_id2) url += `&team_ids[]=${params.team_id2}`;
      break;
    default:
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid type. Valid: games, game, stats, advanced, player_injuries' }),
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
        body: JSON.stringify({ error: `BDL ${resp.status}: ${text.substring(0, 200)}` }),
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

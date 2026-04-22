// odds-api.js — Proxy for The Odds API (line shopping)
// Live games: /v4/sports/basketball_nba/odds (1 credit)
// Completed games: /v4/historical/sports/basketball_nba/odds?date=ISO (10 credits)

exports.handler = async function(event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };

  var apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ODDS_API_KEY not configured' }) };
  }

  try {
    var params = event.queryStringParameters || {};
    var histDate = params.date || null;
    var url;

    if (histDate) {
      // Historical odds — pass ISO date to get odds snapshot at that time
      url = 'https://api.the-odds-api.com/v4/historical/sports/basketball_nba/odds'
        + '?apiKey=' + apiKey
        + '&regions=us,us2'
        + '&markets=h2h'
        + '&oddsFormat=american'
        + '&date=' + encodeURIComponent(histDate);
    } else {
      // Live/upcoming odds
      url = 'https://api.the-odds-api.com/v4/sports/basketball_nba/odds'
        + '?apiKey=' + apiKey
        + '&regions=us,us2'
        + '&markets=h2h'
        + '&oddsFormat=american';
    }

    var resp = await fetch(url);
    if (!resp.ok) {
      var errText = await resp.text();
      return { statusCode: resp.status, headers, body: JSON.stringify({ error: 'Odds API: ' + resp.status, detail: errText }) };
    }

    var data = await resp.json();
    var remaining = resp.headers.get('x-requests-remaining');
    var used = resp.headers.get('x-requests-used');

    // Historical endpoint wraps data in { data: [...], ... }
    var games = histDate ? (data.data || []) : data;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        games: games,
        credits: { remaining: remaining, used: used },
        historical: !!histDate
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

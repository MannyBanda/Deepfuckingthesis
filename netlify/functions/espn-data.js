// ESPN Data Proxy — Win Probability + Scoreboard
// No API key needed — ESPN's public undocumented API
// Proxied through Netlify to avoid CORS

const ESPN_BASE = {
  nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/',
  ncaamb: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/',
  wnba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/',
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
  const league = params.league || 'nba';
  const base = ESPN_BASE[league];

  if (!base) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid league: ' + league }) };
  }

  if (!type || !['scoreboard', 'winprob'].includes(type)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid type. Valid: scoreboard, winprob' }) };
  }

  try {
    if (type === 'scoreboard') {
      // Fetch today's scoreboard for ESPN event ID mapping
      const date = params.date || ''; // YYYYMMDD format, optional
      const url = base + 'scoreboard' + (date ? '?dates=' + date : '') + (league === 'ncaamb' ? (date ? '&' : '?') + 'groups=100&limit=200' : '');
      const resp = await fetch(url);
      if (!resp.ok) {
        return { statusCode: resp.status, headers, body: JSON.stringify({ error: 'ESPN scoreboard: ' + resp.status }) };
      }
      const data = await resp.json();

      // Extract minimal mapping data: espnId, team abbreviations, status
      const games = (data.events || []).map(ev => {
        const comp = ev.competitions?.[0] || {};
        const home = comp.competitors?.find(c => c.homeAway === 'home');
        const away = comp.competitors?.find(c => c.homeAway === 'away');
        return {
          espnId: ev.id,
          homeAbbr: home?.team?.abbreviation || '',
          awayAbbr: away?.team?.abbreviation || '',
          homeName: home?.team?.displayName || '',
          awayName: away?.team?.displayName || '',
          status: ev.status?.type?.name || '',
          shortDetail: ev.status?.type?.shortDetail || '',
        };
      });
      return { statusCode: 200, headers, body: JSON.stringify({ games }) };
    }

    if (type === 'winprob') {
      const eventId = params.event_id;
      if (!eventId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'event_id required for winprob' }) };
      }

      // Use site.web.api for summary (includes winprobability)
      const url = 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/' +
        (league === 'nba' ? 'nba' : league === 'ncaamb' ? 'mens-college-basketball' : 'wnba') +
        '/summary?event=' + eventId;
      const resp = await fetch(url);
      if (!resp.ok) {
        return { statusCode: resp.status, headers, body: JSON.stringify({ error: 'ESPN summary: ' + resp.status }) };
      }
      const data = await resp.json();

      // Extract win probability (last entry = current)
      const wp = data.winprobability || [];
      const latest = wp.length > 0 ? wp[wp.length - 1] : null;
      const first = wp.length > 0 ? wp[0] : null;

      // Extract home/away from header
      const comp = data.header?.competitions?.[0] || {};
      const homeTeam = comp.competitors?.find(c => c.homeAway === 'home');
      const awayTeam = comp.competitors?.find(c => c.homeAway === 'away');

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          homeAbbr: homeTeam?.team?.abbreviation || '',
          awayAbbr: awayTeam?.team?.abbreviation || '',
          current: latest ? {
            homeWinPct: latest.homeWinPercentage,
            awayWinPct: 1 - (latest.homeWinPercentage || 0),
            playId: latest.playId || null,
          } : null,
          opening: first ? {
            homeWinPct: first.homeWinPercentage,
          } : null,
          dataPoints: wp.length,
        }),
      };
    }
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

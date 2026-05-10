// ESPN Data Proxy — Win Probability + Scoreboard + Probabilities History
// No API key needed — ESPN's public undocumented API
// Proxied through Netlify to avoid CORS

const ESPN_BASE = {
  nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/',
  ncaamb: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/',
  wnba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/',
};

const ESPN_LEAGUE_SLUG = {
  nba: 'nba',
  ncaamb: 'mens-college-basketball',
  wnba: 'wnba',
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

  if (!type || !['scoreboard', 'winprob', 'probabilities', 'teams', 'team_schedule'].includes(type)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid type. Valid: scoreboard, winprob, probabilities, teams, team_schedule' }) };
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
          homeScore: home?.score ? parseInt(home.score) : null,
          awayScore: away?.score ? parseInt(away.score) : null,
          period: ev.status?.period || 0,
          clock: ev.status?.displayClock || '',
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

      // Use site.web.api for summary (includes winprobability, predictor, officials)
      const slug = ESPN_LEAGUE_SLUG[league] || 'nba';
      const url = 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/' + slug + '/summary?event=' + eventId;
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

      // ── FULL WP HISTORY for chart ──
      // Downsample if > 300 points to keep payload reasonable
      var wpHistory = wp.map(function(p) {
        return {
          homeWP: p.homeWinPercentage != null ? Math.round(p.homeWinPercentage * 1000) / 1000 : null,
          secondsLeft: p.secondsLeft != null ? p.secondsLeft : null,
          seq: p.sequenceNumber || null,
        };
      });
      if (wpHistory.length > 300) {
        // Keep every Nth point + always keep first and last
        var step = Math.ceil(wpHistory.length / 300);
        var sampled = [wpHistory[0]];
        for (var i = step; i < wpHistory.length - 1; i += step) {
          sampled.push(wpHistory[i]);
        }
        sampled.push(wpHistory[wpHistory.length - 1]);
        wpHistory = sampled;
      }

      // ── PREDICTOR (pre-game model) ──
      var predictor = null;
      if (data.predictor) {
        var pred = data.predictor;
        predictor = {
          homeProjection: pred.homeTeam?.gameProjection || null,
          awayProjection: pred.awayTeam?.gameProjection || null,
          homeTeamChanceLoss: pred.homeTeam?.teamChanceLoss || null,
          awayTeamChanceLoss: pred.awayTeam?.teamChanceLoss || null,
        };
      }

      // ── OFFICIALS (referee assignments) ──
      var officials = null;
      var gameInfo = data.gameInfo || {};
      if (gameInfo.officials && gameInfo.officials.length > 0) {
        officials = gameInfo.officials.map(function(o) {
          return {
            name: o.displayName || o.fullName || '',
            position: o.position?.displayName || '',
            order: o.order || 0,
          };
        });
      }

      // ── SEASON SERIES ──
      var seasonseries = null;
      if (data.seasonseries && data.seasonseries.length > 0) {
        seasonseries = data.seasonseries.map(function(g) {
          return {
            date: g.date || '',
            homeScore: g.homeScore || null,
            awayScore: g.awayScore || null,
            homeWinner: g.homeWinner || false,
          };
        });
      }

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
          wpHistory: wpHistory,
          predictor: predictor,
          officials: officials,
          seasonseries: seasonseries,
        }),
      };
    }

    if (type === 'probabilities') {
      // Dedicated probabilities endpoint — play-level WP history
      // Alternative to winprob when you only need the chart data (lighter payload)
      const eventId = params.event_id;
      if (!eventId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'event_id required for probabilities' }) };
      }

      const slug = ESPN_LEAGUE_SLUG[league] || 'nba';
      const url = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/' + slug +
        '/events/' + eventId + '/competitions/' + eventId + '/probabilities?limit=500';
      const resp = await fetch(url);
      if (!resp.ok) {
        return { statusCode: resp.status, headers, body: JSON.stringify({ error: 'ESPN probabilities: ' + resp.status }) };
      }
      const data = await resp.json();

      var items = (data.items || []).map(function(p) {
        return {
          homeWP: p.homeWinPercentage != null ? Math.round(p.homeWinPercentage * 1000) / 1000 : null,
          secondsLeft: p.secondsLeft != null ? p.secondsLeft : null,
          seq: p.sequenceNumber || null,
        };
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          count: data.count || items.length,
          history: items,
        }),
      };
    }

    if (type === 'teams') {
      // Get all teams with ESPN IDs
      const url = base + 'teams?limit=50';
      const resp = await fetch(url);
      if (!resp.ok) {
        return { statusCode: resp.status, headers, body: JSON.stringify({ error: 'ESPN teams: ' + resp.status }) };
      }
      const data = await resp.json();
      var teams = [];
      (data.sports || []).forEach(function(sport) {
        (sport.leagues || []).forEach(function(lg) {
          (lg.teams || []).forEach(function(t) {
            var team = t.team || t;
            teams.push({
              espnId: team.id,
              abbr: team.abbreviation || '',
              name: team.displayName || '',
              shortName: team.shortDisplayName || '',
            });
          });
        });
      });
      return { statusCode: 200, headers, body: JSON.stringify({ teams }) };
    }

    if (type === 'team_schedule') {
      // Get recent completed games for a team
      const teamId = params.team_id;
      if (!teamId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'team_id required for team_schedule' }) };
      }
      const limit = parseInt(params.limit) || 20;
      const slug = ESPN_LEAGUE_SLUG[league] || 'nba';

      // ESPN team schedule endpoint
      const url = 'https://site.api.espn.com/apis/site/v2/sports/basketball/' + slug + '/teams/' + teamId + '/schedule';
      const resp = await fetch(url);
      if (!resp.ok) {
        return { statusCode: resp.status, headers, body: JSON.stringify({ error: 'ESPN team schedule: ' + resp.status }) };
      }
      const data = await resp.json();

      // Filter completed games, take most recent N
      var completed = [];
      (data.events || []).forEach(function(ev) {
        var status = ev.competitions?.[0]?.status?.type?.name || '';
        if (status !== 'STATUS_FINAL') return;
        var comp = ev.competitions?.[0] || {};
        var home = comp.competitors?.find(function(c) { return c.homeAway === 'home'; });
        var away = comp.competitors?.find(function(c) { return c.homeAway === 'away'; });
        var homeWon = home?.winner || false;
        completed.push({
          eventId: ev.id,
          date: ev.date || '',
          homeAbbr: home?.team?.abbreviation || '',
          awayAbbr: away?.team?.abbreviation || '',
          homeScore: parseInt(home?.score || 0),
          awayScore: parseInt(away?.score || 0),
          homeWon: homeWon,
        });
      });

      // Sort by date descending, take last N
      completed.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
      var recent = completed.slice(0, limit);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          teamId: teamId,
          total: completed.length,
          returned: recent.length,
          games: recent,
        }),
      };
    }
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

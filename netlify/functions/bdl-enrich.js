// BDL Enrichment — Clutch Stats, Odds, and Tracking Data
// Proxies BallDontLie GOAT-tier endpoints for pre-game and live enrichment
// Pulls: clutch (base+advanced+misc+scoring), odds (v2 multi-vendor), tracking (catch_and_shoot + pull_up)

const BDL_BASE = 'https://api.balldontlie.io';

// BDL team IDs mapped from SR abbreviations
const BDL_TEAMS = {
  ATL:1, BOS:2, BKN:3, CHA:4, CHI:5, CLE:6, DAL:7, DEN:8, DET:9, GSW:10,
  HOU:11, IND:12, LAC:13, LAL:14, MEM:15, MIA:16, MIL:17, MIN:18, NOP:19, NYK:20,
  OKC:21, ORL:22, PHI:23, PHX:24, POR:25, SAC:26, SAS:27, TOR:28, UTA:29, WAS:30
};

async function bdlFetch(path, apiKey) {
  const url = `${BDL_BASE}${path}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': apiKey },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`BDL ${resp.status}: ${path} — ${text.substring(0, 200)}`);
  }
  return resp.json();
}

// Extract stats from BDL team_season_averages response
// Response format: { data: [{ team: {...}, season: N, season_type: "...", stats: {...} }] }
function extractStats(resp) {
  const entry = resp?.data?.[0];
  if (!entry) return {};
  return entry.stats || entry;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  const apiKey = process.env.BDL_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'BDL_API_KEY not configured' }) };
  }

  try {
    const { homeTeam, awayTeam, bdlGameId, season, pulls } = JSON.parse(event.body);
    const s = season || 2025;
    const homeId = BDL_TEAMS[homeTeam];
    const awayId = BDL_TEAMS[awayTeam];
    const result = { home: homeTeam, away: awayTeam, errors: [], sources: [] };
    const pullSet = new Set(pulls || ['clutch', 'odds', 'tracking']);

    // ════════════════════════════════════════════════════════════════
    // CLUTCH STATS — 4 type pairings per team (base, advanced, misc, scoring)
    // ════════════════════════════════════════════════════════════════
    if (pullSet.has('clutch') && homeId && awayId) {
      result.clutch = { tier: 2, home: {}, away: {} };

      // ── clutch/advanced — PRIMARY: NetRtg, OffRtg, DefRtg, Pace, eFG%, TS% ──
      try {
        const [hAdv, aAdv] = await Promise.all([
          bdlFetch(`/nba/v1/team_season_averages/clutch?team_id=${homeId}&season=${s}&type=advanced`, apiKey),
          bdlFetch(`/nba/v1/team_season_averages/clutch?team_id=${awayId}&season=${s}&type=advanced`, apiKey),
        ]);
        const h = extractStats(hAdv), a = extractStats(aAdv);
        Object.assign(result.clutch.home, {
          netRtg: h.net_rating ?? null,
          offRtg: h.offensive_rating ?? null,
          defRtg: h.defensive_rating ?? null,
          efg: h.effective_field_goal_percentage ?? null,
          ts: h.true_shooting_percentage ?? null,
          pace: h.pace ?? null,
          tovRatio: h.turnover_ratio ?? null,
          orebPct: h.offensive_rebound_percentage ?? null,
          drebPct: h.defensive_rebound_percentage ?? null,
          pie: h.pie ?? null,
        });
        Object.assign(result.clutch.away, {
          netRtg: a.net_rating ?? null,
          offRtg: a.offensive_rating ?? null,
          defRtg: a.defensive_rating ?? null,
          efg: a.effective_field_goal_percentage ?? null,
          ts: a.true_shooting_percentage ?? null,
          pace: a.pace ?? null,
          tovRatio: a.turnover_ratio ?? null,
          orebPct: a.offensive_rebound_percentage ?? null,
          drebPct: a.defensive_rebound_percentage ?? null,
          pie: a.pie ?? null,
        });
        result.sources.push('clutch/advanced');
      } catch (e) {
        result.errors.push(`clutch/advanced: ${e.message}`);
      }

      // ── clutch/base — W, L, GP, PTS, AST, STL, BLK, TOV, +/- ──
      try {
        const [hBase, aBase] = await Promise.all([
          bdlFetch(`/nba/v1/team_season_averages/clutch?team_id=${homeId}&season=${s}&type=base`, apiKey),
          bdlFetch(`/nba/v1/team_season_averages/clutch?team_id=${awayId}&season=${s}&type=base`, apiKey),
        ]);
        const h = extractStats(hBase), a = extractStats(aBase);
        Object.assign(result.clutch.home, {
          gp: h.gp ?? h.games_played ?? null,
          w: h.w ?? h.wins ?? null,
          l: h.l ?? h.losses ?? null,
          wl: (h.w != null && h.l != null) ? `${h.w}-${h.l}` : (h.wins != null && h.losses != null) ? `${h.wins}-${h.losses}` : null,
          pts: h.pts ?? null,
          ast: h.ast ?? null,
          stl: h.stl ?? null,
          blk: h.blk ?? null,
          tov: h.tov ?? h.turnover ?? null,
          plusMinus: h.plus_minus ?? null,
          fg_pct: h.fg_pct ?? null,
          fg3_pct: h.fg3_pct ?? null,
          ft_pct: h.ft_pct ?? null,
        });
        Object.assign(result.clutch.away, {
          gp: a.gp ?? a.games_played ?? null,
          w: a.w ?? a.wins ?? null,
          l: a.l ?? a.losses ?? null,
          wl: (a.w != null && a.l != null) ? `${a.w}-${a.l}` : (a.wins != null && a.losses != null) ? `${a.wins}-${a.losses}` : null,
          pts: a.pts ?? null,
          ast: a.ast ?? null,
          stl: a.stl ?? null,
          blk: a.blk ?? null,
          tov: a.tov ?? a.turnover ?? null,
          plusMinus: a.plus_minus ?? null,
          fg_pct: a.fg_pct ?? null,
          fg3_pct: a.fg3_pct ?? null,
          ft_pct: a.ft_pct ?? null,
        });
        result.sources.push('clutch/base');
      } catch (e) {
        result.errors.push(`clutch/base: ${e.message}`);
      }

      // ── clutch/misc — FBP, POT, paint pts, SCP (+ opponent versions) ──
      try {
        const [hMisc, aMisc] = await Promise.all([
          bdlFetch(`/nba/v1/team_season_averages/clutch?team_id=${homeId}&season=${s}&type=misc`, apiKey),
          bdlFetch(`/nba/v1/team_season_averages/clutch?team_id=${awayId}&season=${s}&type=misc`, apiKey),
        ]);
        const h = extractStats(hMisc), a = extractStats(aMisc);
        Object.assign(result.clutch.home, {
          fbp: h.points_fast_break ?? null,
          pot: h.points_off_turnovers ?? null,
          paint: h.points_paint ?? null,
          scp: h.points_second_chance ?? null,
          oppFbp: h.opp_points_fast_break ?? null,
          oppPot: h.opp_points_off_turnovers ?? null,
          oppPaint: h.opp_points_paint ?? null,
          oppScp: h.opp_points_second_chance ?? null,
        });
        Object.assign(result.clutch.away, {
          fbp: a.points_fast_break ?? null,
          pot: a.points_off_turnovers ?? null,
          paint: a.points_paint ?? null,
          scp: a.points_second_chance ?? null,
          oppFbp: a.opp_points_fast_break ?? null,
          oppPot: a.opp_points_off_turnovers ?? null,
          oppPaint: a.opp_points_paint ?? null,
          oppScp: a.opp_points_second_chance ?? null,
        });
        result.sources.push('clutch/misc');
      } catch (e) {
        result.errors.push(`clutch/misc: ${e.message}`);
      }

      // ── clutch/scoring — shot distribution in clutch ──
      try {
        const [hScor, aScor] = await Promise.all([
          bdlFetch(`/nba/v1/team_season_averages/clutch?team_id=${homeId}&season=${s}&type=scoring`, apiKey),
          bdlFetch(`/nba/v1/team_season_averages/clutch?team_id=${awayId}&season=${s}&type=scoring`, apiKey),
        ]);
        const h = extractStats(hScor), a = extractStats(aScor);
        Object.assign(result.clutch.home, {
          pctAssisted2pt: h.pct_assisted_2pt ?? null,
          pctAssisted3pt: h.pct_assisted_3pt ?? null,
          pctAssistedFgm: h.pct_assisted_fgm ?? null,
          pctPts2pt: h.pct_pts_2pt ?? null,
          pctPts3pt: h.pct_pts_3pt ?? null,
          pctPtsFbp: h.pct_pts_fast_break ?? null,
          pctPtsPaint: h.pct_pts_paint ?? null,
          pctPtsFt: h.pct_pts_free_throw ?? null,
        });
        Object.assign(result.clutch.away, {
          pctAssisted2pt: a.pct_assisted_2pt ?? null,
          pctAssisted3pt: a.pct_assisted_3pt ?? null,
          pctAssistedFgm: a.pct_assisted_fgm ?? null,
          pctPts2pt: a.pct_pts_2pt ?? null,
          pctPts3pt: a.pct_pts_3pt ?? null,
          pctPtsFbp: a.pct_pts_fast_break ?? null,
          pctPtsPaint: a.pct_pts_paint ?? null,
          pctPtsFt: a.pct_pts_free_throw ?? null,
        });
        result.sources.push('clutch/scoring');
      } catch (e) {
        result.errors.push(`clutch/scoring: ${e.message}`);
      }
    }

    // ════════════════════════════════════════════════════════════════
    // ODDS — Multi-vendor via v2 endpoint
    // ════════════════════════════════════════════════════════════════
    if (pullSet.has('odds') && bdlGameId) {
      try {
        const oddsData = await bdlFetch(`/nba/v2/odds?game_id=${bdlGameId}`, apiKey);
        const odds = oddsData?.data || [];

        // Vendor preference: DK → FD → Caesars → BetMGM → BetRivers → first
        const preferred = odds.find(o => o.vendor === 'draftkings')
          || odds.find(o => o.vendor === 'fanduel')
          || odds.find(o => o.vendor === 'caesars')
          || odds.find(o => o.vendor === 'betmgm')
          || odds.find(o => o.vendor === 'betrivers')
          || odds[0];

        if (preferred) {
          result.odds = {
            vendor: preferred.vendor,
            homeSpread: preferred.spread_home_value ?? null,
            homeSpreadOdds: preferred.spread_home_odds ?? null,
            awaySpread: preferred.spread_away_value ?? null,
            awaySpreadOdds: preferred.spread_away_odds ?? null,
            homeML: preferred.moneyline_home_odds ?? null,
            awayML: preferred.moneyline_away_odds ?? null,
            total: preferred.total_value ?? null,
            totalOverOdds: preferred.total_over_odds ?? null,
            totalUnderOdds: preferred.total_under_odds ?? null,
            updatedAt: preferred.updated_at ?? null,
          };

          // All vendors for line shopping context
          result.oddsAll = odds.map(o => ({
            vendor: o.vendor,
            homeML: o.moneyline_home_odds,
            awayML: o.moneyline_away_odds,
            spread: o.spread_home_value,
            total: o.total_value,
            updated: o.updated_at,
          }));
          result.sources.push('odds/v2');
        }
      } catch (e) {
        result.errors.push(`odds: ${e.message}`);
      }
    }

    // ════════════════════════════════════════════════════════════════
    // TRACKING — Catch-and-shoot + Pull-up (sustainability baselines)
    // ════════════════════════════════════════════════════════════════
    if (pullSet.has('tracking') && homeId && awayId) {
      result.tracking = { home: {}, away: {} };

      try {
        const [hCAS, aCAS] = await Promise.all([
          bdlFetch(`/nba/v1/team_season_averages/catch_and_shoot?team_id=${homeId}&season=${s}&type=advanced`, apiKey),
          bdlFetch(`/nba/v1/team_season_averages/catch_and_shoot?team_id=${awayId}&season=${s}&type=advanced`, apiKey),
        ]);
        const h = extractStats(hCAS), a = extractStats(aCAS);
        result.tracking.home.catchAndShoot = {
          efg: h.effective_field_goal_percentage ?? null,
          fg3pct: h.fg3_pct ?? null,
          fga: h.fga ?? null, fg3a: h.fg3a ?? null,
        };
        result.tracking.away.catchAndShoot = {
          efg: a.effective_field_goal_percentage ?? null,
          fg3pct: a.fg3_pct ?? null,
          fga: a.fga ?? null, fg3a: a.fg3a ?? null,
        };
        result.sources.push('catch_and_shoot');
      } catch (e) {
        result.errors.push(`catch_and_shoot: ${e.message}`);
      }

      try {
        const [hPU, aPU] = await Promise.all([
          bdlFetch(`/nba/v1/team_season_averages/pull_up?team_id=${homeId}&season=${s}&type=advanced`, apiKey),
          bdlFetch(`/nba/v1/team_season_averages/pull_up?team_id=${awayId}&season=${s}&type=advanced`, apiKey),
        ]);
        const h = extractStats(hPU), a = extractStats(aPU);
        result.tracking.home.pullUp = {
          efg: h.effective_field_goal_percentage ?? null,
          fg3pct: h.fg3_pct ?? null,
          fga: h.fga ?? null, fg3a: h.fg3a ?? null,
        };
        result.tracking.away.pullUp = {
          efg: a.effective_field_goal_percentage ?? null,
          fg3pct: a.fg3_pct ?? null,
          fga: a.fga ?? null, fg3a: a.fg3a ?? null,
        };
        result.sources.push('pull_up');
      } catch (e) {
        result.errors.push(`pull_up: ${e.message}`);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

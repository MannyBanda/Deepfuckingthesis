// BDL Enrichment - Clutch Stats, Odds, and Tracking Data
// Proxies BallDontLie GOAT-tier endpoints for pre-game and live enrichment

var BDL_BASE = 'https://api.balldontlie.io';

// BDL team IDs mapped from SR abbreviations
var BDL_TEAMS = {
  ATL:1, BOS:2, BKN:3, CHA:4, CHI:5, CLE:6, DAL:7, DEN:8, DET:9, GSW:10,
  HOU:11, IND:12, LAC:13, LAL:14, MEM:15, MIA:16, MIL:17, MIN:18, NOP:19, NYK:20,
  OKC:21, ORL:22, PHI:23, PHX:24, POR:25, SAC:26, SAS:27, TOR:28, UTA:29, WAS:30
};

async function bdlFetch(path, apiKey) {
  var url = BDL_BASE + path;
  var resp = await fetch(url, {
    headers: { 'Authorization': apiKey },
  });
  if (!resp.ok) {
    var text = '';
    try { text = await resp.text(); } catch(_) {}
    throw new Error('BDL ' + resp.status + ': ' + path.substring(0, 80) + ' - ' + text.substring(0, 200));
  }
  return resp.json();
}

// Extract stats from BDL team_season_averages response
function extractStats(resp) {
  var entry = resp && resp.data && resp.data[0];
  if (!entry) return {};
  return entry.stats || entry;
}

exports.handler = async function(event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  var apiKey = process.env.BDL_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'BDL_API_KEY not configured' }) };
  }

  try {
    var body = JSON.parse(event.body);
    var homeTeam = body.homeTeam;
    var awayTeam = body.awayTeam;
    var bdlGameId = body.bdlGameId;
    var s = body.season || 2025;
    var pulls = body.pulls;

    var homeId = BDL_TEAMS[homeTeam];
    var awayId = BDL_TEAMS[awayTeam];
    var result = { home: homeTeam, away: awayTeam, errors: [], sources: [] };
    var pullSet = {};
    var pullArr = pulls || ['clutch', 'odds', 'tracking'];
    for (var i = 0; i < pullArr.length; i++) pullSet[pullArr[i]] = true;

    // ================================================================
    // CLUTCH STATS - 4 type pairings per team
    // Path: /nba/v1/team_season_averages/clutch?team_ids[]=X&season=Y&season_type=regular&type=Z
    // ================================================================
    if (pullSet.clutch && homeId && awayId) {
      result.clutch = { tier: 2, home: {}, away: {} };

      // -- clutch/advanced: NetRtg, OffRtg, DefRtg, Pace, eFG%, TS%
      try {
        var clutchAdvResults = await Promise.all([
          bdlFetch('/nba/v1/team_season_averages/clutch?team_ids[]=' + homeId + '&season=' + s + '&season_type=regular&type=advanced', apiKey),
          bdlFetch('/nba/v1/team_season_averages/clutch?team_ids[]=' + awayId + '&season=' + s + '&season_type=regular&type=advanced', apiKey),
        ]);
        var hA = extractStats(clutchAdvResults[0]);
        var aA = extractStats(clutchAdvResults[1]);
        Object.assign(result.clutch.home, {
          netRtg: hA.net_rating != null ? hA.net_rating : null,
          offRtg: hA.offensive_rating != null ? hA.offensive_rating : null,
          defRtg: hA.defensive_rating != null ? hA.defensive_rating : null,
          efg: hA.effective_field_goal_percentage != null ? hA.effective_field_goal_percentage : null,
          ts: hA.true_shooting_percentage != null ? hA.true_shooting_percentage : null,
          pace: hA.pace != null ? hA.pace : null,
          tovRatio: hA.turnover_ratio != null ? hA.turnover_ratio : null,
          orebPct: hA.offensive_rebound_percentage != null ? hA.offensive_rebound_percentage : null,
          drebPct: hA.defensive_rebound_percentage != null ? hA.defensive_rebound_percentage : null,
          pie: hA.pie != null ? hA.pie : null,
        });
        Object.assign(result.clutch.away, {
          netRtg: aA.net_rating != null ? aA.net_rating : null,
          offRtg: aA.offensive_rating != null ? aA.offensive_rating : null,
          defRtg: aA.defensive_rating != null ? aA.defensive_rating : null,
          efg: aA.effective_field_goal_percentage != null ? aA.effective_field_goal_percentage : null,
          ts: aA.true_shooting_percentage != null ? aA.true_shooting_percentage : null,
          pace: aA.pace != null ? aA.pace : null,
          tovRatio: aA.turnover_ratio != null ? aA.turnover_ratio : null,
          orebPct: aA.offensive_rebound_percentage != null ? aA.offensive_rebound_percentage : null,
          drebPct: aA.defensive_rebound_percentage != null ? aA.defensive_rebound_percentage : null,
          pie: aA.pie != null ? aA.pie : null,
        });
        result.sources.push('clutch/advanced');
      } catch (e) {
        result.errors.push('clutch/advanced: ' + e.message);
      }

      // -- clutch/base: W, L, GP, PTS, AST, STL, BLK, TOV, +/-
      try {
        var clutchBaseResults = await Promise.all([
          bdlFetch('/nba/v1/team_season_averages/clutch?team_ids[]=' + homeId + '&season=' + s + '&season_type=regular&type=base', apiKey),
          bdlFetch('/nba/v1/team_season_averages/clutch?team_ids[]=' + awayId + '&season=' + s + '&season_type=regular&type=base', apiKey),
        ]);
        var hB = extractStats(clutchBaseResults[0]);
        var aB = extractStats(clutchBaseResults[1]);
        Object.assign(result.clutch.home, {
          gp: hB.gp || hB.games_played || null,
          w: hB.w || hB.wins || null,
          l: hB.l || hB.losses || null,
          wl: (hB.w != null && hB.l != null) ? hB.w + '-' + hB.l : (hB.wins != null && hB.losses != null) ? hB.wins + '-' + hB.losses : null,
          pts: hB.pts || null,
          ast: hB.ast || null,
          stl: hB.stl || null,
          blk: hB.blk || null,
          tov: hB.tov || hB.turnover || null,
          plusMinus: hB.plus_minus != null ? hB.plus_minus : null,
          fg_pct: hB.fg_pct != null ? hB.fg_pct : null,
          fg3_pct: hB.fg3_pct != null ? hB.fg3_pct : null,
          ft_pct: hB.ft_pct != null ? hB.ft_pct : null,
        });
        Object.assign(result.clutch.away, {
          gp: aB.gp || aB.games_played || null,
          w: aB.w || aB.wins || null,
          l: aB.l || aB.losses || null,
          wl: (aB.w != null && aB.l != null) ? aB.w + '-' + aB.l : (aB.wins != null && aB.losses != null) ? aB.wins + '-' + aB.losses : null,
          pts: aB.pts || null,
          ast: aB.ast || null,
          stl: aB.stl || null,
          blk: aB.blk || null,
          tov: aB.tov || aB.turnover || null,
          plusMinus: aB.plus_minus != null ? aB.plus_minus : null,
          fg_pct: aB.fg_pct != null ? aB.fg_pct : null,
          fg3_pct: aB.fg3_pct != null ? aB.fg3_pct : null,
          ft_pct: aB.ft_pct != null ? aB.ft_pct : null,
        });
        result.sources.push('clutch/base');
      } catch (e) {
        result.errors.push('clutch/base: ' + e.message);
      }

      // -- clutch/misc: FBP, POT, paint pts, SCP (+ opponent versions)
      try {
        var clutchMiscResults = await Promise.all([
          bdlFetch('/nba/v1/team_season_averages/clutch?team_ids[]=' + homeId + '&season=' + s + '&season_type=regular&type=misc', apiKey),
          bdlFetch('/nba/v1/team_season_averages/clutch?team_ids[]=' + awayId + '&season=' + s + '&season_type=regular&type=misc', apiKey),
        ]);
        var hM = extractStats(clutchMiscResults[0]);
        var aM = extractStats(clutchMiscResults[1]);
        Object.assign(result.clutch.home, {
          fbp: hM.points_fast_break != null ? hM.points_fast_break : null,
          pot: hM.points_off_turnovers != null ? hM.points_off_turnovers : null,
          paint: hM.points_paint != null ? hM.points_paint : null,
          scp: hM.points_second_chance != null ? hM.points_second_chance : null,
          oppFbp: hM.opp_points_fast_break != null ? hM.opp_points_fast_break : null,
          oppPot: hM.opp_points_off_turnovers != null ? hM.opp_points_off_turnovers : null,
          oppPaint: hM.opp_points_paint != null ? hM.opp_points_paint : null,
          oppScp: hM.opp_points_second_chance != null ? hM.opp_points_second_chance : null,
        });
        Object.assign(result.clutch.away, {
          fbp: aM.points_fast_break != null ? aM.points_fast_break : null,
          pot: aM.points_off_turnovers != null ? aM.points_off_turnovers : null,
          paint: aM.points_paint != null ? aM.points_paint : null,
          scp: aM.points_second_chance != null ? aM.points_second_chance : null,
          oppFbp: aM.opp_points_fast_break != null ? aM.opp_points_fast_break : null,
          oppPot: aM.opp_points_off_turnovers != null ? aM.opp_points_off_turnovers : null,
          oppPaint: aM.opp_points_paint != null ? aM.opp_points_paint : null,
          oppScp: aM.opp_points_second_chance != null ? aM.opp_points_second_chance : null,
        });
        result.sources.push('clutch/misc');
      } catch (e) {
        result.errors.push('clutch/misc: ' + e.message);
      }

      // -- clutch/scoring: shot distribution in clutch
      try {
        var clutchScoResults = await Promise.all([
          bdlFetch('/nba/v1/team_season_averages/clutch?team_ids[]=' + homeId + '&season=' + s + '&season_type=regular&type=scoring', apiKey),
          bdlFetch('/nba/v1/team_season_averages/clutch?team_ids[]=' + awayId + '&season=' + s + '&season_type=regular&type=scoring', apiKey),
        ]);
        var hS = extractStats(clutchScoResults[0]);
        var aS = extractStats(clutchScoResults[1]);
        Object.assign(result.clutch.home, {
          pctPts2pt: hS.pct_pts_2pt != null ? hS.pct_pts_2pt : null,
          pctPts3pt: hS.pct_pts_3pt != null ? hS.pct_pts_3pt : null,
          pctPtsFbp: hS.pct_pts_fast_break != null ? hS.pct_pts_fast_break : null,
          pctPtsFt: hS.pct_pts_ft != null ? hS.pct_pts_ft : null,
          pctPtsPaint: hS.pct_pts_paint != null ? hS.pct_pts_paint : null,
          pctAst2pt: hS.pct_assisted_2pt != null ? hS.pct_assisted_2pt : null,
          pctAst3pt: hS.pct_assisted_3pt != null ? hS.pct_assisted_3pt : null,
          pctAstFgm: hS.pct_assisted_fgm != null ? hS.pct_assisted_fgm : null,
        });
        Object.assign(result.clutch.away, {
          pctPts2pt: aS.pct_pts_2pt != null ? aS.pct_pts_2pt : null,
          pctPts3pt: aS.pct_pts_3pt != null ? aS.pct_pts_3pt : null,
          pctPtsFbp: aS.pct_pts_fast_break != null ? aS.pct_pts_fast_break : null,
          pctPtsFt: aS.pct_pts_ft != null ? aS.pct_pts_ft : null,
          pctPtsPaint: aS.pct_pts_paint != null ? aS.pct_pts_paint : null,
          pctAst2pt: aS.pct_assisted_2pt != null ? aS.pct_assisted_2pt : null,
          pctAst3pt: aS.pct_assisted_3pt != null ? aS.pct_assisted_3pt : null,
          pctAstFgm: aS.pct_assisted_fgm != null ? aS.pct_assisted_fgm : null,
        });
        result.sources.push('clutch/scoring');
      } catch (e) {
        result.errors.push('clutch/scoring: ' + e.message);
      }
    }

    // ================================================================
    // ODDS - Multi-vendor via v2 endpoint
    // Path: /nba/v2/odds?game_ids[]=X (array param format)
    // ================================================================
    if (pullSet.odds && bdlGameId) {
      try {
        var oddsResp = await bdlFetch('/nba/v2/odds?game_ids[]=' + bdlGameId, apiKey);
        var odds = (oddsResp && oddsResp.data) || [];

        // Vendor preference: DK > FD > Caesars > BetMGM > BetRivers > first
        var preferred = null;
        var vendorOrder = ['draftkings', 'fanduel', 'caesars', 'betmgm', 'betrivers'];
        for (var v = 0; v < vendorOrder.length; v++) {
          for (var o = 0; o < odds.length; o++) {
            if (odds[o].vendor === vendorOrder[v]) { preferred = odds[o]; break; }
          }
          if (preferred) break;
        }
        if (!preferred && odds.length > 0) preferred = odds[0];

        if (preferred) {
          result.odds = {
            vendor: preferred.vendor,
            homeSpread: preferred.spread_home_value != null ? preferred.spread_home_value : null,
            homeSpreadOdds: preferred.spread_home_odds != null ? preferred.spread_home_odds : null,
            awaySpread: preferred.spread_away_value != null ? preferred.spread_away_value : null,
            awaySpreadOdds: preferred.spread_away_odds != null ? preferred.spread_away_odds : null,
            homeML: preferred.moneyline_home_odds != null ? preferred.moneyline_home_odds : null,
            awayML: preferred.moneyline_away_odds != null ? preferred.moneyline_away_odds : null,
            total: preferred.total_value != null ? preferred.total_value : null,
            totalOverOdds: preferred.total_over_odds != null ? preferred.total_over_odds : null,
            totalUnderOdds: preferred.total_under_odds != null ? preferred.total_under_odds : null,
            updatedAt: preferred.updated_at || null,
          };

          result.oddsAll = [];
          for (var oi = 0; oi < odds.length; oi++) {
            result.oddsAll.push({
              vendor: odds[oi].vendor,
              homeML: odds[oi].moneyline_home_odds,
              awayML: odds[oi].moneyline_away_odds,
              spread: odds[oi].spread_home_value,
              total: odds[oi].total_value,
              updated: odds[oi].updated_at,
            });
          }
          result.sources.push('odds/v2');
        }
      } catch (e) {
        result.errors.push('odds: ' + e.message);
      }
    }

    // ================================================================
    // TRACKING - Catch-and-shoot + Pull-up (sustainability baselines)
    // Path: /nba/v1/team_season_averages/shotdashboard?team_ids[]=X&season=Y&season_type=regular&type=catch_and_shoot
    // Category is "shotdashboard", type is the specific dashboard view
    // ================================================================
    if (pullSet.tracking && homeId && awayId) {
      result.tracking = { home: {}, away: {} };

      // -- catch_and_shoot
      try {
        var casResults = await Promise.all([
          bdlFetch('/nba/v1/team_season_averages/shotdashboard?team_ids[]=' + homeId + '&season=' + s + '&season_type=regular&type=catch_and_shoot', apiKey),
          bdlFetch('/nba/v1/team_season_averages/shotdashboard?team_ids[]=' + awayId + '&season=' + s + '&season_type=regular&type=catch_and_shoot', apiKey),
        ]);
        var hCAS = extractStats(casResults[0]);
        var aCAS = extractStats(casResults[1]);
        result.tracking.home.catchAndShoot = {
          efg: hCAS.effective_field_goal_percentage || hCAS.efg_pct || null,
          fg3pct: hCAS.fg3_pct || hCAS.fg3_percentage || null,
          fga: hCAS.fga || null,
          fg3a: hCAS.fg3a || null,
        };
        result.tracking.away.catchAndShoot = {
          efg: aCAS.effective_field_goal_percentage || aCAS.efg_pct || null,
          fg3pct: aCAS.fg3_pct || aCAS.fg3_percentage || null,
          fga: aCAS.fga || null,
          fg3a: aCAS.fg3a || null,
        };
        result.sources.push('catch_and_shoot');
      } catch (e) {
        result.errors.push('catch_and_shoot: ' + e.message);
      }

      // -- pullups (BDL shotdashboard type: "pullups")
      try {
        var puResults = await Promise.all([
          bdlFetch('/nba/v1/team_season_averages/shotdashboard?team_ids[]=' + homeId + '&season=' + s + '&season_type=regular&type=pullups', apiKey),
          bdlFetch('/nba/v1/team_season_averages/shotdashboard?team_ids[]=' + awayId + '&season=' + s + '&season_type=regular&type=pullups', apiKey),
        ]);
        var hPU = extractStats(puResults[0]);
        var aPU = extractStats(puResults[1]);
        result.tracking.home.pullUp = {
          efg: hPU.effective_field_goal_percentage || hPU.efg_pct || null,
          fg3pct: hPU.fg3_pct || hPU.fg3_percentage || null,
          fga: hPU.fga || null,
          fg3a: hPU.fg3a || null,
        };
        result.tracking.away.pullUp = {
          efg: aPU.effective_field_goal_percentage || aPU.efg_pct || null,
          fg3pct: aPU.fg3_pct || aPU.fg3_percentage || null,
          fga: aPU.fga || null,
          fg3a: aPU.fg3a || null,
        };
        result.sources.push('pull_up');
      } catch (e) {
        result.errors.push('pull_up: ' + e.message);
      }
    }

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ error: 'Function error: ' + (err.message || String(err)) }),
    };
  }
};

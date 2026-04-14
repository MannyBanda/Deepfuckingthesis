// Pre-Game Thesis Generation via Claude Sonnet — Smart Compute Layer v3.0
// v3.0: Pregame Agent (scheduled auto-generation), mechanical pregame floor,
//       judge/jury Sonnet architecture, indicator weights aligned to live system.
// v2.1: GP GATE, SIA guardrails, show-your-work requirements.
//
// DUAL MODE:
//   POST = client-triggered manual generation (SSE streaming)
//   Scheduled cron = auto-triggered pregame agent (DB write + ntfy)

import { neon } from '@neondatabase/serverless';

// ── INDICATOR WEIGHTS (aligned with live system — poll-live-bdl.mjs) ────────
var W = { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };

// ── NBA TEAM IDS (SR UUIDs — stable) ────────────────────────────────────────
var SR_TEAM_IDS = {
  ATL:'583ecb8f-fb46-11e1-82cb-f4ce4684ea4c',BOS:'583eccfa-fb46-11e1-82cb-f4ce4684ea4c',
  BKN:'583ec9d6-fb46-11e1-82cb-f4ce4684ea4c',CHA:'583ec97e-fb46-11e1-82cb-f4ce4684ea4c',
  CHI:'583ec5fd-fb46-11e1-82cb-f4ce4684ea4c',CLE:'583ec773-fb46-11e1-82cb-f4ce4684ea4c',
  DAL:'583ecf50-fb46-11e1-82cb-f4ce4684ea4c',DEN:'583ed102-fb46-11e1-82cb-f4ce4684ea4c',
  DET:'583ec928-fb46-11e1-82cb-f4ce4684ea4c',GSW:'583ec825-fb46-11e1-82cb-f4ce4684ea4c',
  HOU:'583ecb3a-fb46-11e1-82cb-f4ce4684ea4c',IND:'583ec7cd-fb46-11e1-82cb-f4ce4684ea4c',
  LAC:'583ecdfb-fb46-11e1-82cb-f4ce4684ea4c',LAL:'583ecae2-fb46-11e1-82cb-f4ce4684ea4c',
  MEM:'583eca88-fb46-11e1-82cb-f4ce4684ea4c',MIA:'583ecea6-fb46-11e1-82cb-f4ce4684ea4c',
  MIL:'583ecefd-fb46-11e1-82cb-f4ce4684ea4c',MIN:'583eca2f-fb46-11e1-82cb-f4ce4684ea4c',
  NOP:'583ecc9a-fb46-11e1-82cb-f4ce4684ea4c',NYK:'583ec70e-fb46-11e1-82cb-f4ce4684ea4c',
  OKC:'583ecfff-fb46-11e1-82cb-f4ce4684ea4c',ORL:'583ed157-fb46-11e1-82cb-f4ce4684ea4c',
  PHI:'583ec87d-fb46-11e1-82cb-f4ce4684ea4c',PHX:'583ecfa8-fb46-11e1-82cb-f4ce4684ea4c',
  POR:'583ed056-fb46-11e1-82cb-f4ce4684ea4c',SAC:'583ed0ac-fb46-11e1-82cb-f4ce4684ea4c',
  SAS:'583ecd4f-fb46-11e1-82cb-f4ce4684ea4c',TOR:'583ecda6-fb46-11e1-82cb-f4ce4684ea4c',
  UTA:'583ece50-fb46-11e1-82cb-f4ce4684ea4c',WAS:'583ec8d4-fb46-11e1-82cb-f4ce4684ea4c',
};

var BDL_TEAM_IDS = {
  ATL:1,BOS:2,BKN:3,CHA:4,CHI:5,CLE:6,DAL:7,DEN:8,DET:9,GSW:10,
  HOU:11,IND:12,LAC:13,LAL:14,MEM:15,MIA:16,MIL:17,MIN:18,NOP:19,NYK:20,
  OKC:21,ORL:22,PHI:23,PHX:24,POR:25,SAC:26,SAS:27,TOR:28,UTA:29,WAS:30,
};

// ══════════════════════════════════════════════════════════════════════════════
// HELPER UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

function getPlayers(stats) {
  var own = stats && (stats.own_record || stats);
  return (own && own.players) || (stats && stats.players) || [];
}

function getTeamStats(stats) {
  var own = stats && (stats.own_record || stats);
  return (own && own.statistics) || (stats && stats.statistics) || {};
}

function getOppStats(stats) {
  var opp = stats && stats.opponents;
  if (!opp) {
    var own = stats && stats.own_record;
    opp = own && own.opponents;
  }
  return (opp && opp.statistics) || {};
}

function dg(sym) {
  if (sym === '\u25BC\u25BC\u25BC') return 3;
  if (sym === '\u25BC\u25BC') return 2;
  if (sym === '\u25BC') return 1;
  return 0;
}

function dgSym(n) {
  if (n >= 3) return '\u25BC\u25BC\u25BC';
  if (n >= 2) return '\u25BC\u25BC';
  if (n >= 1) return '\u25BC';
  return '\u2014';
}

// Get team games played from standings
function getTeamGP(standings, alias) {
  if (!standings) return 0;
  var allTeams = [];
  (standings.conferences || []).forEach(function(conf) {
    (conf.teams || []).forEach(function(t) { allTeams.push(t); });
    (conf.divisions || []).forEach(function(div) {
      (div.teams || []).forEach(function(t) { allTeams.push(t); });
    });
  });
  for (var i = 0; i < allTeams.length; i++) {
    if ((allTeams[i].alias || '').toUpperCase() === alias.toUpperCase()) {
      return (allTeams[i].wins || 0) + (allTeams[i].losses || 0);
    }
  }
  return 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. ROSTER AUDIT
// ══════════════════════════════════════════════════════════════════════════════

function computeRosterAudit(analytical, homeAlias, awayAlias) {
  var out = { home: [], away: [] };
  var gtd = { home: [], away: [] };
  var injTeams = (analytical.injuries && analytical.injuries.teams) || [];

  injTeams.forEach(function(team) {
    var alias = (team.alias || '').toUpperCase();
    var side = alias === homeAlias.toUpperCase() ? 'home' :
               alias === awayAlias.toUpperCase() ? 'away' : null;
    if (!side) return;

    (team.players || []).forEach(function(p) {
      var st = (p.status || '').toUpperCase();
      var entry = {
        name: p.full_name || p.name || '?',
        position: p.primary_position || p.position || '?',
        injury: p.desc || p.comment || p.injury || '?',
        stats: null,
        gamesPlayed: 0
      };
      if (st === 'OUT' || st === 'O' || st === 'IR') {
        out[side].push(entry);
      } else if (st === 'DAY-TO-DAY' || st === 'GTD' || st === 'DOUBTFUL' || st === 'QUESTIONABLE' || st === 'D' || st === 'Q') {
        entry.statusLabel = st;
        gtd[side].push(entry);
      }
    });
  });

  // Check profile ACT/SUS/NWT flags
  ['home', 'away'].forEach(function(side) {
    var profile = analytical[side + 'Profile'];
    if (!profile) return;
    (profile.players || []).forEach(function(pp) {
      var st = (pp.status || '').toUpperCase();
      if (st === 'SUS' || st === 'NWT') {
        var name = pp.full_name || pp.name || '?';
        var alreadyListed = out[side].some(function(o) { return o.name === name; }) ||
                            gtd[side].some(function(g) { return g.name === name; });
        if (!alreadyListed) {
          out[side].push({ name: name, position: pp.primary_position || pp.position || '?', injury: 'Status: ' + st, stats: null, gamesPlayed: 0 });
        }
      }
    });
  });

  // Match OUT/GTD players to season stat lines + games played
  function matchStats(list, statsObj) {
    var players = getPlayers(statsObj);
    list.forEach(function(entry) {
      for (var i = 0; i < players.length; i++) {
        var pn = (players[i].full_name || players[i].name || '').toLowerCase();
        if (pn === entry.name.toLowerCase() && players[i].average) {
          var a = players[i].average;
          entry.stats = {
            minutes: a.minutes || 0, points: a.points || 0, rebounds: a.rebounds || 0,
            assists: a.assists || 0, steals: a.steals || 0, blocks: a.blocks || 0,
            turnovers: a.turnovers || 0, oreb: a.offensive_rebounds || 0,
            fta: a.free_throws_att || 0, ftm: a.free_throws_made || 0,
            tpm: a.three_points_made || 0, tpa: a.three_points_att || 0,
            fgm: a.field_goals_made || 0, fga: a.field_goals_att || 0,
            usage: a.usage_pct || 0, atRimAtt: a.field_goals_at_rim_att || 0,
            atRimMade: a.field_goals_at_rim_made || 0,
            fbp: a.fast_break_points || 0,
            paintPts: a.points_in_the_paint || a.points_in_paint || 0
          };
          // Grab games played from total object or top-level
          var total = players[i].total || {};
          entry.gamesPlayed = total.games_played || players[i].games_played || 0;
          break;
        }
      }
    });
  }

  matchStats(out.home, analytical.homeStats);
  matchStats(out.away, analytical.awayStats);
  matchStats(gtd.home, analytical.homeStats);
  matchStats(gtd.away, analytical.awayStats);

  return { out: out, gtd: gtd };
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. STRUCTURAL IMPACT ASSESSMENT (with GP Gate)
// ══════════════════════════════════════════════════════════════════════════════

function computeSIA(rosterAudit, analytical, homeAlias, awayAlias) {
  var result = { home: null, away: null };

  // Get team GP from standings for GP gate calculation
  var teamGP = {
    home: getTeamGP(analytical.standings, homeAlias),
    away: getTeamGP(analytical.standings, awayAlias)
  };

  ['home', 'away'].forEach(function(side) {
    var outPlayers = rosterAudit.out[side];
    if (outPlayers.length === 0) {
      result[side] = { impacts: [], aggregated: { I1: 0, I2: 0, I3: 0, I4: 0, I5: 0 }, caps: {} };
      return;
    }

    var ts = getTeamStats(analytical[side + 'Stats']);
    var tt = {
      points: ts.points || 100, assists: ts.assists || 24, steals: ts.steals || 7.5,
      blocks: ts.blocks || 5, oreb: ts.offensive_rebounds || 10, fta: ts.free_throws_att || 22,
      atRimAtt: ts.field_goals_at_rim_att || 25, minutes: 240,
      fbp: ts.fast_break_points || 12, paintPts: ts.points_in_the_paint || 48
    };

    var impacts = [];
    var aggregated = { I1: 0, I2: 0, I3: 0, I4: 0, I5: 0 };
    var tGP = teamGP[side] || 70; // fallback to ~70 if standings unavailable

    outPlayers.forEach(function(p) {
      if (!p.stats) {
        impacts.push({ name: p.name, position: p.position, I1: '\u2014', I2: '\u2014', I3: '\u2014', I4: '\u2014', I5: '\u2014', note: 'no stats', gpGate: 'UNKNOWN' });
        return;
      }
      var s = p.stats;
      var impact = { name: p.name, position: p.position };
      impact.statLine = s.points.toFixed(1) + 'p ' + s.rebounds.toFixed(1) + 'r ' + s.assists.toFixed(1) + 'a ' +
        s.steals.toFixed(1) + 's ' + s.blocks.toFixed(1) + 'b ' + s.turnovers.toFixed(1) + 'to ' +
        s.minutes.toFixed(0) + 'min USG:' + s.usage.toFixed(1) + '%';

      // ── GP GATE ──
      // Determine how much of the season this player has actually played.
      // If they've been out most of the year, season team stats ALREADY
      // reflect their absence — further discounting is double-penalty.
      var playerGP = p.gamesPlayed || 0;
      var gpRatio = tGP > 0 ? playerGP / tGP : 1;
      var gpGate = 'FULL'; // default: full degradation applies
      if (gpRatio < 0.40) {
        gpGate = 'SUPPRESSED';
      } else if (gpRatio < 0.70) {
        gpGate = 'REDUCED';
      }
      impact.gpGate = gpGate;
      impact.playerGP = playerGP;
      impact.teamGP = tGP;
      impact.gpRatio = Math.round(gpRatio * 100);

      // ── Compute raw degradation tiers ──
      // I1: Possession & Transition
      var i1 = (s.steals / tt.steals) * 0.40 + (s.oreb / tt.oreb) * 0.35 + (s.fbp / Math.max(tt.fbp, 1)) * 0.25;
      var i1tier = i1 > 0.22 ? 3 : i1 > 0.12 ? 2 : i1 > 0.05 ? 1 : 0;

      // I2: Rim Pressure & Foul
      var rimP = s.atRimAtt > 0 ? (s.atRimAtt / tt.atRimAtt) : (s.paintPts / Math.max(tt.paintPts, 1));
      var i2 = (s.fta / tt.fta) * 0.30 + (s.blocks / Math.max(tt.blocks, 1)) * 0.30 + rimP * 0.40;
      var i2tier = i2 > 0.25 ? 3 : i2 > 0.13 ? 2 : i2 > 0.05 ? 1 : 0;

      // I3: Shot Quality & Creation
      var i3 = (s.assists / Math.max(tt.assists, 1)) * 0.55 + (s.usage / 100) * 0.45;
      var i3tier = i3 > 0.28 ? 3 : i3 > 0.15 ? 2 : i3 > 0.07 ? 1 : 0;

      // I4: Lineup Integrity
      var i4 = (s.minutes / tt.minutes) * 0.55 + (s.usage / 100) * 0.45;
      var i4tier = i4 > 0.22 ? 3 : i4 > 0.12 ? 2 : i4 > 0.05 ? 1 : 0;

      // I5: Tempo & Efficiency
      var i5 = (s.points / tt.points) * 0.60 + (s.fbp / Math.max(tt.fbp, 1)) * 0.40;
      var i5tier = i5 > 0.22 ? 2 : i5 > 0.10 ? 1 : 0;

      // ── Apply GP Gate ──
      if (gpGate === 'SUPPRESSED') {
        // Season stats already reflect this player's absence. Zero out all degradation.
        i1tier = 0; i2tier = 0; i3tier = 0; i4tier = 0; i5tier = 0;
      } else if (gpGate === 'REDUCED') {
        // Partial season — reduce each tier by one (floor of 0)
        i1tier = Math.max(i1tier - 1, 0);
        i2tier = Math.max(i2tier - 1, 0);
        i3tier = Math.max(i3tier - 1, 0);
        i4tier = Math.max(i4tier - 1, 0);
        i5tier = Math.max(i5tier - 1, 0);
      }
      // gpGate === 'FULL' → no modification

      impact.I1 = dgSym(i1tier);
      impact.I2 = dgSym(i2tier);
      impact.I3 = dgSym(i3tier);
      impact.I4 = dgSym(i4tier);
      impact.I5 = dgSym(i5tier);

      impacts.push(impact);
      aggregated.I1 += i1tier;
      aggregated.I2 += i2tier;
      aggregated.I3 += i3tier;
      aggregated.I4 += i4tier;
      aggregated.I5 += i5tier;
    });

    result[side] = { impacts: impacts, aggregated: aggregated };
  });

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. ROLE REDISTRIBUTION
// ══════════════════════════════════════════════════════════════════════════════

function computeRedistribution(rosterAudit, sia, analytical, homeAlias, awayAlias) {
  var result = { home: [], away: [] };

  ['home', 'away'].forEach(function(side) {
    var oppSide = side === 'home' ? 'away' : 'home';
    var siaData = sia[side];
    if (!siaData || siaData.impacts.length === 0) return;

    var oppAlias = side === 'home' ? awayAlias : homeAlias;
    var oppAllowed = getOppStats(analytical[oppSide + 'Stats']);
    var oppOwn = getTeamStats(analytical[oppSide + 'Stats']);
    var ownDepth = analytical[side + 'Depth'];
    var ownStats = analytical[side + 'Stats'];
    var allPlayers = getPlayers(ownStats);

    var oppPaint = oppAllowed.points_in_the_paint || 0;
    var oppSteals = oppOwn.steals || 0;
    var opp3Pct = oppAllowed.three_points_att > 0 ? (oppAllowed.three_points_made || 0) / oppAllowed.three_points_att * 100 : 0;
    var weakInterior = oppPaint >= 48;
    var nonDisruptive = oppSteals < 7.5;
    var weak3PTD = opp3Pct >= 37.0;

    // Parse depth chart
    var depthPos = [];
    if (ownDepth) {
      var pos = Array.isArray(ownDepth.positions) ? ownDepth.positions : Array.isArray(ownDepth) ? ownDepth : [];
      pos.forEach(function(p) {
        var pls = Array.isArray(p.players) ? p.players : [];
        depthPos.push({
          position: p.name || p.position || '?',
          d1: pls.find(function(x) { return x.depth === 1 || x.depth === '1'; }),
          d2: pls.find(function(x) { return x.depth === 2 || x.depth === '2'; })
        });
      });
    }

    siaData.impacts.forEach(function(impact) {
      // Skip players with no degradation (includes GP-gate SUPPRESSED)
      if (dg(impact.I1) === 0 && dg(impact.I2) === 0 && dg(impact.I3) === 0 && dg(impact.I4) === 0 && dg(impact.I5) === 0) return;

      // Find backup from depth chart
      var backupName = null;
      for (var i = 0; i < depthPos.length; i++) {
        var d1 = depthPos[i].d1;
        if (d1 && (d1.full_name || d1.name || '').toLowerCase() === impact.name.toLowerCase() && depthPos[i].d2) {
          backupName = depthPos[i].d2.full_name || depthPos[i].d2.name || '?';
          break;
        }
      }
      if (!backupName) return;

      var pos = (impact.position || '').toUpperCase();
      var isInterior = pos === 'C' || pos === 'PF' || pos === 'F-C' || pos === 'C-F';
      var isBH = pos === 'PG' || pos === 'SG' || pos === 'G';
      var isWing = pos === 'SF' || pos === 'SG' || pos === 'G-F' || pos === 'F-G';

      if (dg(impact.I2) >= 2 && isInterior && weakInterior) {
        result[side].push({ outPlayer: impact.name, backup: backupName, indicator: 'I2',
          reason: backupName + ' absorbs interior role vs ' + oppAlias + ' weak interior D (' + oppPaint.toFixed(0) + ' paint/gm)', reduction: 1 });
      }
      if (dg(impact.I3) >= 2 && isBH && nonDisruptive) {
        result[side].push({ outPlayer: impact.name, backup: backupName, indicator: 'I3',
          reason: backupName + ' absorbs creation vs ' + oppAlias + ' non-disruptive D (' + oppSteals.toFixed(1) + ' stl/gm)', reduction: 1 });
      }
      if (dg(impact.I1) >= 2 && isBH && nonDisruptive) {
        result[side].push({ outPlayer: impact.name, backup: backupName, indicator: 'I1',
          reason: backupName + ' absorbs transition duties vs non-disruptive D', reduction: 1 });
      }
      if (dg(impact.I3) >= 1 && isWing && weak3PTD) {
        var backupStats = null;
        for (var j = 0; j < allPlayers.length; j++) {
          if ((allPlayers[j].full_name || allPlayers[j].name || '').toLowerCase() === backupName.toLowerCase()) {
            backupStats = allPlayers[j].average || {}; break;
          }
        }
        if (backupStats && (backupStats.three_points_att || 0) > 1.5) {
          var b3 = (backupStats.three_points_made || 0) / backupStats.three_points_att * 100;
          if (b3 >= 35) {
            result[side].push({ outPlayer: impact.name, backup: backupName, indicator: 'I3',
              reason: backupName + ' (' + b3.toFixed(1) + '% 3PT) vs weak 3PT D (' + opp3Pct.toFixed(1) + '%)', reduction: 1 });
          }
        }
      }
    });
  });

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. SYSTEM RESILIENCE MODIFIER
// ══════════════════════════════════════════════════════════════════════════════

function computeSRM(rosterAudit, analytical) {
  var result = { home: { qualifies: false, defRtg: null }, away: { qualifies: false, defRtg: null } };

  ['home', 'away'].forEach(function(side) {
    if (rosterAudit.out[side].length === 0) return;
    var oppStats = getOppStats(analytical[side + 'Stats']);
    var ptsAllowed = oppStats.points || 0;
    var defRtg = ptsAllowed > 0 ? ptsAllowed : null;
    result[side].defRtg = defRtg;
    if (defRtg && defRtg <= 110.5) result[side].qualifies = true;
  });

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. DEPLETION GATE
// ══════════════════════════════════════════════════════════════════════════════

function computeDepletionGate(rosterAudit) {
  var result = { home: null, away: null };

  ['home', 'away'].forEach(function(side) {
    var rotOut = rosterAudit.out[side].filter(function(p) { return p.stats && p.stats.minutes >= 12; }).length;
    var total = rosterAudit.out[side].length;
    if (rotOut >= 5) result[side] = { count: rotOut, total: total, ceiling: 0.60, label: 'SEVERE DEPLETION' };
    else if (rotOut >= 4) result[side] = { count: rotOut, total: total, ceiling: 0.65, label: 'HEAVY DEPLETION' };
    else if (rotOut >= 3) result[side] = { count: rotOut, total: total, ceiling: 0.75, label: 'MODERATE DEPLETION' };
  });

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. PYTHAGOREAN WIN EXPECTATION
// ══════════════════════════════════════════════════════════════════════════════

function computePythagorean(standings, homeAlias, awayAlias) {
  var result = { home: null, away: null };
  if (!standings) return result;

  var allTeams = [];
  (standings.conferences || []).forEach(function(conf) {
    (conf.teams || []).forEach(function(t) { allTeams.push(t); });
    (conf.divisions || []).forEach(function(div) {
      (div.teams || []).forEach(function(t) { allTeams.push(t); });
    });
  });

  function calc(alias) {
    var t = null;
    for (var i = 0; i < allTeams.length; i++) {
      if ((allTeams[i].alias || '').toUpperCase() === alias.toUpperCase()) { t = allTeams[i]; break; }
    }
    if (!t) return null;
    var pf = (t.calc_points && t.calc_points.for) || t.points_for || 0;
    var pa = (t.calc_points && t.calc_points.against) || t.points_against || 0;
    var gp = (t.wins || 0) + (t.losses || 0);
    if (!pf || !pa || !gp) return null;
    var pythWin = Math.pow(pf, 13.91) / (Math.pow(pf, 13.91) + Math.pow(pa, 13.91));
    var expW = Math.round(pythWin * gp * 10) / 10;
    var actW = t.wins || 0;
    var delta = Math.round((actW - expW) * 10) / 10;
    var cap = null, label = null;
    if (delta <= -5) { cap = 0.70; label = 'PYTH CAP (UNDER): ' + delta + ' wins below expected'; }
    else if (delta <= -3) { cap = 0.75; label = 'PYTH CAP (UNDER): ' + delta + ' wins below expected'; }
    else if (delta >= 5) { cap = 0.75; label = 'PYTH CAP (OVER): +' + delta + ' wins above expected'; }
    else if (delta >= 3) { label = 'PYTH WARNING (OVER): +' + delta + ' wins above \u2014 conviction downgrade in close games'; }
    return { actual: actW, losses: t.losses || 0, gp: gp, expected: expW, delta: delta, cap: cap, label: label };
  }

  result.home = calc(homeAlias);
  result.away = calc(awayAlias);
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. APPLY ADJUSTMENTS — Redistribution + SRM → final indicator context
// ══════════════════════════════════════════════════════════════════════════════

function applyAdjustments(sia, redistribution, srm) {
  var final = { home: {}, away: {} };

  ['home', 'away'].forEach(function(side) {
    var siaData = sia[side];
    if (!siaData || siaData.impacts.length === 0) {
      final[side] = { caps: { I1: null, I2: null, I3: null, I4: null, I5: null }, adjustments: [], adjusted: { I1: 0, I2: 0, I3: 0, I4: 0, I5: 0 } };
      return;
    }

    var adjustments = [];
    var adj = { I1: siaData.aggregated.I1, I2: siaData.aggregated.I2, I3: siaData.aggregated.I3, I4: siaData.aggregated.I4, I5: siaData.aggregated.I5 };

    // Redistribution (reduce by 1, floor of 1)
    (redistribution[side] || []).forEach(function(r) {
      if (adj[r.indicator] > 1) {
        var before = adj[r.indicator];
        adj[r.indicator] = Math.max(adj[r.indicator] - r.reduction, 1);
        adjustments.push(r.indicator + ': ' + dgSym(before) + ' \u2192 ' + dgSym(adj[r.indicator]) + ' (REDISTRIBUTION: ' + r.reason + ')');
      }
    });

    // SRM (reduce I1/I2 by 1)
    if (srm[side] && srm[side].qualifies) {
      ['I1', 'I2'].forEach(function(ind) {
        if (adj[ind] >= 1) {
          var before = adj[ind];
          adj[ind] = Math.max(adj[ind] - 1, 0);
          if (before !== adj[ind]) adjustments.push(ind + ': ' + dgSym(before) + ' \u2192 ' + dgSym(adj[ind]) + ' (SRM: top-10 defense)');
        }
      });
    }

    // Convert to advisory caps (informational, not hard overrides)
    var caps = {};
    ['I1', 'I2', 'I3', 'I4', 'I5'].forEach(function(ind) {
      if (adj[ind] >= 4) caps[ind] = 0.0;
      else if (adj[ind] >= 2) caps[ind] = 0.5;
      else caps[ind] = null;
    });

    final[side] = { caps: caps, adjustments: adjustments, adjusted: adj };
  });

  return final;
}

// ══════════════════════════════════════════════════════════════════════════════
// 8. BHV + CHAOS RISK
// ══════════════════════════════════════════════════════════════════════════════

function computeBHV(analytical, homeAlias, awayAlias, rosterAudit) {
  var result = { home: null, away: null };

  ['home', 'away'].forEach(function(side) {
    var oppSide = side === 'home' ? 'away' : 'home';
    var depth = analytical[side + 'Depth'];
    var stats = analytical[side + 'Stats'];
    var oppStats = analytical[oppSide + 'Stats'];

    var pgName = null;
    if (depth) {
      var positions = Array.isArray(depth.positions) ? depth.positions : Array.isArray(depth) ? depth : [];
      for (var i = 0; i < positions.length; i++) {
        var pName = (positions[i].name || positions[i].position || '').toUpperCase();
        if (pName === 'PG' || pName === 'POINT GUARD') {
          var pls = Array.isArray(positions[i].players) ? positions[i].players : [];
          var d1 = pls.find(function(x) { return x.depth === 1 || x.depth === '1'; });
          if (d1) pgName = d1.full_name || d1.name;
          break;
        }
      }
    }

    var toRate = 0;
    if (pgName && stats) {
      var players = getPlayers(stats);
      for (var j = 0; j < players.length; j++) {
        if ((players[j].full_name || players[j].name || '').toLowerCase() === pgName.toLowerCase()) {
          toRate = (players[j].average && players[j].average.turnovers) || 0; break;
        }
      }
    }

    var bhvTier = toRate > 3.5 ? 'HIGH' : toRate >= 2.5 ? 'MODERATE' : 'LOW';
    var pgIsOut = rosterAudit ? rosterAudit.out[side].some(function(o) { return pgName && o.name.toLowerCase() === pgName.toLowerCase(); }) : false;
    var oppTeamStats = getTeamStats(oppStats);
    var oppSteals = oppTeamStats.steals || 0;
    var oppTopSteals = oppSteals >= 8.0;
    var chaosRisk = 'NONE';
    if ((bhvTier === 'HIGH' || pgIsOut) && oppTopSteals) chaosRisk = 'HIGH';
    else if (bhvTier === 'MODERATE' && oppTopSteals) chaosRisk = 'ELEVATED';

    result[side] = { pgName: pgName || 'unknown', pgIsOut: pgIsOut, toRate: toRate, bhvTier: bhvTier,
      oppSteals: oppSteals, oppTopSteals: oppTopSteals, chaosRisk: chaosRisk };
  });

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 9. FORMAT PRE-COMPUTED ASSESSMENT
// ══════════════════════════════════════════════════════════════════════════════

function formatPreComputed(homeAlias, awayAlias, rosterAudit, sia, finalCaps, redistribution, srm, depletion, pyth, bhv) {
  var L = [];
  L.push('=== PRE-COMPUTED STRUCTURAL ASSESSMENT (server-side) ===');
  L.push('');

  ['away', 'home'].forEach(function(side) {
    var alias = side === 'home' ? homeAlias : awayAlias;
    var outP = rosterAudit.out[side];
    var gtdP = rosterAudit.gtd[side];

    if (outP.length === 0 && gtdP.length === 0) {
      L.push(alias + ' ROSTER: HEALTHY');
      L.push('');
      return;
    }

    L.push(alias + ' STRUCTURAL IMPACT ASSESSMENT:');
    outP.forEach(function(p) {
      var imp = sia[side] && sia[side].impacts.find(function(x) { return x.name === p.name; });
      if (imp && p.stats) {
        L.push('  ' + p.name + ' [' + p.position + '] OUT (' + p.injury + ')');
        L.push('    Per-game: ' + imp.statLine);
        // Surface GP gate status
        var gpNote = '';
        if (imp.gpGate === 'SUPPRESSED') {
          gpNote = ' \u2014 GP GATE: SUPPRESSED (GP ' + imp.playerGP + '/' + imp.teamGP + ' = ' + imp.gpRatio + '% < 40%). Season stats already reflect absence. No indicator discount applied.';
        } else if (imp.gpGate === 'REDUCED') {
          gpNote = ' \u2014 GP GATE: REDUCED (GP ' + imp.playerGP + '/' + imp.teamGP + ' = ' + imp.gpRatio + '% < 70%). All tiers reduced by one.';
        } else {
          gpNote = ' (GP ' + imp.playerGP + '/' + imp.teamGP + ' = ' + imp.gpRatio + '%)';
        }
        L.push('    Impact: I1:' + imp.I1 + ' I2:' + imp.I2 + ' I3:' + imp.I3 + ' I4:' + imp.I4 + ' I5:' + imp.I5 + gpNote);
      } else {
        L.push('  ' + p.name + ' [' + p.position + '] OUT (' + p.injury + ') \u2014 no season stats matched');
      }
    });
    gtdP.forEach(function(p) { L.push('  ' + p.name + ' [' + p.position + '] ' + (p.statusLabel || 'GTD') + ' (' + p.injury + ')'); });

    var fc = finalCaps[side];
    if (fc && fc.adjustments && fc.adjustments.length > 0) {
      L.push('  ADJUSTMENTS:');
      fc.adjustments.forEach(function(a) { L.push('    ' + a); });
    }
    if (fc && fc.caps) {
      var cArr = [];
      ['I1', 'I2', 'I3', 'I4', 'I5'].forEach(function(ind) {
        if (fc.caps[ind] !== null && fc.caps[ind] !== undefined) cArr.push(ind + ' advisory cap ' + fc.caps[ind]);
      });
      if (cArr.length > 0) {
        L.push('  ADVISORY CAPS: ' + cArr.join(' | '));
        L.push('  NOTE: These reflect production loss from OUT players (after GP gate, redistribution, SRM). Use as analytical context, not mechanical overrides.');
      }
    }
    if (depletion[side]) {
      L.push('  DEPLETION GATE: ' + depletion[side].label + ' (' + depletion[side].count + ' rotation players OUT)');
      L.push('  CEILING: ' + alias + ' control score should not exceed ' + depletion[side].ceiling + ' without strong justification.');
    }
    L.push('');
  });

  L.push('BHV + CHAOS RISK:');
  ['away', 'home'].forEach(function(side) {
    var alias = side === 'home' ? homeAlias : awayAlias;
    var b = bhv[side];
    if (b) {
      var note = b.pgIsOut ? ' (OUT \u2014 backup PG)' : '';
      L.push('  ' + alias + ': PG ' + b.pgName + note + ' \u2014 TO ' + b.toRate.toFixed(1) + '/gm \u2014 BHV: ' + b.bhvTier);
      if (b.chaosRisk !== 'NONE') {
        var opp = side === 'home' ? awayAlias : homeAlias;
        L.push('    CHAOS RISK: ' + b.chaosRisk + ' vs ' + opp + ' (' + b.oppSteals.toFixed(1) + ' stl/gm)');
      }
    }
  });
  L.push('');

  L.push('PYTHAGOREAN:');
  ['away', 'home'].forEach(function(side) {
    var alias = side === 'home' ? homeAlias : awayAlias;
    var p = pyth[side];
    if (p) {
      L.push('  ' + alias + ': ' + p.actual + '-' + p.losses + ' actual vs ' + p.expected.toFixed(1) + ' expected (delta ' + (p.delta >= 0 ? '+' : '') + p.delta + ')');
      if (p.label) L.push('    \u26A0 ' + p.label);
    }
  });
  L.push('');

  ['away', 'home'].forEach(function(side) {
    var alias = side === 'home' ? homeAlias : awayAlias;
    if (srm[side] && srm[side].qualifies && rosterAudit.out[side].length > 0)
      L.push('SYSTEM RESILIENCE: ' + alias + ' qualifies (DefRtg ' + (srm[side].defRtg || '?') + ') \u2014 I1/I2 downgrades discounted.');
  });

  L.push('');
  L.push('=== END PRE-COMPUTED ASSESSMENT ===');
  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// 10a. MECHANICAL PREGAME FLOOR (new — aligned with live computeServer weights)
// ══════════════════════════════════════════════════════════════════════════════

// Computes I1-I5 from SR season team stats using pregame proxies.
// Returns same shape as computeServer() so computeConviction() works unchanged.
function computePreGameFloor(homeStats, awayStats, standings, seasonQ4, siaCaps, homeAlias, awayAlias) {
  if (!homeStats || !awayStats) return null;

  // Extract per-game averages (SR season stats 'average' or 'statistics' sub-object)
  function avg(stats) {
    var a = stats.average || stats.statistics || stats;
    var t = stats.total || {};
    var gp = t.games_played || a.games_played || 1;
    return {
      stl: a.steals || (t.steals ? t.steals/gp : 0),
      blk: a.blocks || (t.blocks ? t.blocks/gp : 0),
      pot: a.points_off_turnovers || (t.points_off_turnovers ? t.points_off_turnovers/gp : 0),
      paint: a.points_in_paint || a.points_in_the_paint || (t.points_in_paint ? t.points_in_paint/gp : 0),
      paintM: a.points_in_paint_made || (t.points_in_paint_made ? t.points_in_paint_made/gp : 0),
      paintA: a.points_in_paint_att || (t.points_in_paint_att ? t.points_in_paint_att/gp : 0),
      fgm: a.field_goals_made || (t.field_goals_made ? t.field_goals_made/gp : 0),
      fga: a.field_goals_att || (t.field_goals_att ? t.field_goals_att/gp : 0),
      fg3m: a.three_points_made || (t.three_points_made ? t.three_points_made/gp : 0),
      ast: a.assists || (t.assists ? t.assists/gp : 0),
      pts: a.points || (t.points ? t.points/gp : 0),
      ptsA: a.points_against || (t.points_against ? t.points_against/gp : 0),
      oreb: a.off_rebounds || a.offensive_rebounds || (t.offensive_rebounds ? t.offensive_rebounds/gp : 0),
      to: a.turnovers || (t.turnovers ? t.turnovers/gp : 0),
      fta: a.free_throws_att || (t.free_throws_att ? t.free_throws_att/gp : 0),
      gp: gp,
    };
  }

  var h = avg(homeStats);
  var a = avg(awayStats);
  var diffs = {}; // store raw diffs for Sonnet context

  // I1 — Disruption & Conversion (pregame: stl+blk ±1, POT ±2)
  var hDisrupt = h.stl + h.blk, aDisrupt = a.stl + a.blk;
  diffs.i1subA_diff = +(hDisrupt - aDisrupt).toFixed(1);
  var i1subA = diffs.i1subA_diff > 1 ? 1 : diffs.i1subA_diff < -1 ? -1 : 0;
  diffs.i1subB_diff = +(h.pot - a.pot).toFixed(1);
  var i1subB = diffs.i1subB_diff > 2 ? 1 : diffs.i1subB_diff < -2 ? -1 : 0;
  var i1raw = i1subA + i1subB;
  var I1 = { score: i1raw > 0 ? 1 : i1raw === 0 ? 0.5 : 0, leader: i1raw > 0 ? homeAlias : i1raw < 0 ? awayAlias : 'EVEN' };

  // I2 — Interior Control (pregame: paint ±4, paint FG% ±0.05)
  diffs.i2subA_diff = +(h.paint - a.paint).toFixed(1);
  var i2subA = diffs.i2subA_diff > 4 ? 1 : diffs.i2subA_diff < -4 ? -1 : 0;
  var hPaintPct = h.paintA >= 3 ? h.paintM / h.paintA : null;
  var aPaintPct = a.paintA >= 3 ? a.paintM / a.paintA : null;
  var i2subB = 0;
  if (hPaintPct != null && aPaintPct != null) {
    diffs.i2subB_diff = +((hPaintPct - aPaintPct) * 100).toFixed(1);
    if (hPaintPct - aPaintPct > 0.05) i2subB = 1;
    else if (aPaintPct - hPaintPct > 0.05) i2subB = -1;
  } else { diffs.i2subB_diff = null; }
  var i2raw = i2subA + i2subB;
  var I2 = { score: i2raw > 0 ? 1 : i2raw < 0 ? 0 : 0.5, leader: i2raw > 0 ? homeAlias : i2raw < 0 ? awayAlias : 'EVEN' };

  // I3 — Shot Quality & Creation (pregame: eFG ±0.02, AR ±3)
  var hEFG = (h.fgm + 0.5 * h.fg3m) / (h.fga || 1);
  var aEFG = (a.fgm + 0.5 * a.fg3m) / (a.fga || 1);
  diffs.i3sub1_diff = +((hEFG - aEFG) * 100).toFixed(1);
  var hAR = (h.ast / (h.fgm || 1)) * 100;
  var aAR = (a.ast / (a.fgm || 1)) * 100;
  diffs.i3sub2_diff = +(hAR - aAR).toFixed(1);
  var i3raw = (hEFG > aEFG + 0.02 ? 1 : hEFG < aEFG - 0.02 ? -1 : 0)
            + (hAR > aAR + 3 ? 1 : hAR < aAR - 3 ? -1 : 0);
  var I3 = { score: i3raw > 0 ? 1 : i3raw === 0 ? 0.5 : 0, leader: i3raw > 0 ? homeAlias : i3raw < 0 ? awayAlias : 'EVEN' };

  // I4 — Game Control (pregame: avg win margin ±2.5, Q4 margin ±2)
  var hMargin = h.pts - h.ptsA;
  var aMargin = a.pts - a.ptsA;
  diffs.i4subA_diff = +(hMargin - aMargin).toFixed(1);
  var i4subA = diffs.i4subA_diff > 2.5 ? 1 : diffs.i4subA_diff < -2.5 ? -1 : 0;
  var i4subB = 0;
  if (seasonQ4) {
    var sznQ4diff = (seasonQ4[homeAlias] || 0) - (seasonQ4[awayAlias] || 0);
    diffs.i4subB_diff = +sznQ4diff.toFixed(1);
    i4subB = sznQ4diff > 2 ? 1 : sznQ4diff < -2 ? -1 : 0;
  } else { diffs.i4subB_diff = null; }
  var i4raw = i4subA + i4subB;
  var I4 = { score: i4raw > 0 ? 1 : i4raw === 0 ? 0.5 : 0, leader: i4raw > 0 ? homeAlias : i4raw < 0 ? awayAlias : 'EVEN' };

  // I5 — Sustained Execution (pregame: net rating ±3)
  var hPoss = h.fga - h.oreb + h.to + 0.44 * h.fta;
  var aPoss = a.fga - a.oreb + a.to + 0.44 * a.fta;
  var hOrtg = hPoss > 0 ? (h.pts / hPoss * 100) : 100;
  var hDrtg = aPoss > 0 ? (a.pts / aPoss * 100) : 100; // opponent pts on opponent poss
  var aOrtg = aPoss > 0 ? (a.pts / aPoss * 100) : 100;
  var aDrtg = hPoss > 0 ? (h.pts / hPoss * 100) : 100;
  var hNet = hOrtg - hDrtg, aNet = aOrtg - aDrtg;
  diffs.i5_diff = +(hNet - aNet).toFixed(1);
  var I5 = { score: diffs.i5_diff > 3 ? 1 : diffs.i5_diff < -3 ? 0 : 0.5,
             leader: diffs.i5_diff > 3 ? homeAlias : diffs.i5_diff < -3 ? awayAlias : 'EVEN' };

  // Apply SIA caps if provided
  if (siaCaps) {
    ['home', 'away'].forEach(function(side) {
      var caps = siaCaps[side]?.caps;
      if (!caps) return;
      var inds = { I1: I1, I2: I2, I3: I3, I4: I4, I5: I5 };
      var alias = side === 'home' ? homeAlias : awayAlias;
      Object.keys(caps).forEach(function(k) {
        if (caps[k] != null && inds[k]) {
          // Cap means this team's score on this indicator can't exceed caps[k]
          // If this team is winning the indicator (leader === alias), clamp
          if (inds[k].leader === alias && inds[k].score > caps[k]) {
            inds[k].score = caps[k];
            if (caps[k] === 0.5) inds[k].leader = 'EVEN';
            else if (caps[k] === 0) inds[k].leader = alias === homeAlias ? awayAlias : homeAlias;
          }
        }
      });
    });
  }

  // Composite
  var raw = I1.score * W.I1 + I2.score * W.I2 + I3.score * W.I3 + I4.score * W.I4 + I5.score * W.I5;
  var controlHome = raw >= 0.5;
  var controlTeam = controlHome ? homeAlias : awayAlias;
  var score = controlHome ? raw : 1 - raw;

  return {
    controlTeam: controlTeam,
    score: Math.round(score * 100) / 100,
    I1: I1, I2: I2, I3: I3, I4: I4, I5: I5,
    homeAlias: homeAlias, awayAlias: awayAlias,
    diffs: diffs,
    homeAvgs: h, awayAvgs: a,
    homeNet: +hNet.toFixed(1), awayNet: +aNet.toFixed(1),
  };
}

// ── CONVICTION ENGINE (from poll-live-bdl.mjs — combo-pattern-driven, 171 games) ──
function computeConviction(ind) {
  if (!ind || ind.score == null) return { tier: 'NO ENTRY', combo: 'NONE', indicatorsWon: [], indicatorsLost: [], count: 0, pairs: [] };
  var ctrlHome = ind.controlTeam === ind.homeAlias;

  var wins = [], loses = [], even = [];
  ['I1','I2','I3','I4','I5'].forEach(function(k) {
    var s = ind[k]?.score;
    if (s == null) return;
    var ctrlScore = ctrlHome ? s : 1 - s;
    if (ctrlScore > 0.5) wins.push(k);
    else if (ctrlScore < 0.5) loses.push(k);
    else even.push(k);
  });

  var count = wins.length;
  var pairs = [];
  for (var i = 0; i < wins.length; i++) {
    for (var j = i + 1; j < wins.length; j++) {
      pairs.push(wins[i] + '+' + wins[j]);
    }
  }

  var tier = 'NO ENTRY';
  var combo = wins.length > 0 ? wins.join('+') : 'NONE';

  if (count >= 4 || pairs.indexOf('I4+I5') >= 0) tier = 'DOMINANT';
  else if (pairs.indexOf('I3+I4') >= 0 || pairs.indexOf('I3+I5') >= 0) tier = 'STRONG';
  else if (count >= 2) tier = 'MODEST';
  else if (count === 1) tier = 'CONDITIONAL';

  return { tier: tier, combo: combo, indicatorsWon: wins, indicatorsLost: loses, count: count, pairs: pairs };
}

// Format mechanical floor for inclusion in user prompt
function formatMechanicalFloor(floor, conviction, homeAlias, awayAlias) {
  if (!floor) return '';
  var d = floor.diffs;
  var lines = [
    '=== MECHANICAL PREGAME FLOOR (ground truth \u2014 do NOT override indicator scores) ===',
    'CONTROL TEAM: ' + floor.controlTeam,
    'FLOOR: ' + floor.score.toFixed(2) + ' \u2014 ' + getVerdictLabel(floor.score),
    'CONVICTION: ' + conviction.tier + ' \u2014 ' + conviction.combo,
    'INDICATORS WON: ' + (conviction.indicatorsWon.join(', ') || 'NONE'),
    'INDICATORS LOST: ' + (conviction.indicatorsLost.join(', ') || 'NONE'),
    '',
    'RAW DIFFERENTIALS (' + homeAlias + ' minus ' + awayAlias + ', per-game season averages):',
    '  I1 subA: steals+blocks diff = ' + (d.i1subA_diff >= 0 ? '+' : '') + d.i1subA_diff + ' (threshold \u00B11) \u2192 ' + floor.I1.leader,
    '  I1 subB: POT diff = ' + (d.i1subB_diff >= 0 ? '+' : '') + d.i1subB_diff + ' (threshold \u00B12) \u2192 ' + (d.i1subB_diff > 2 ? homeAlias : d.i1subB_diff < -2 ? awayAlias : 'EVEN'),
    '  I2 subA: paint pts diff = ' + (d.i2subA_diff >= 0 ? '+' : '') + d.i2subA_diff + ' (threshold \u00B14) \u2192 ' + (d.i2subA_diff > 4 ? homeAlias : d.i2subA_diff < -4 ? awayAlias : 'EVEN'),
    '  I2 subB: paint FG% diff = ' + (d.i2subB_diff != null ? (d.i2subB_diff >= 0 ? '+' : '') + d.i2subB_diff + '% (threshold \u00B15%)' : 'N/A'),
    '  I3 sub1: eFG% diff = ' + (d.i3sub1_diff >= 0 ? '+' : '') + d.i3sub1_diff + '% (threshold \u00B12%)',
    '  I3 sub2: assist ratio diff = ' + (d.i3sub2_diff >= 0 ? '+' : '') + d.i3sub2_diff + ' (threshold \u00B13)',
    '  I4 subA: avg win margin diff = ' + (d.i4subA_diff >= 0 ? '+' : '') + d.i4subA_diff + ' (threshold \u00B12.5)',
    '  I4 subB: Q4 margin diff = ' + (d.i4subB_diff != null ? (d.i4subB_diff >= 0 ? '+' : '') + d.i4subB_diff + ' (threshold \u00B12)' : 'N/A'),
    '  I5: net rating diff = ' + (d.i5_diff >= 0 ? '+' : '') + d.i5_diff + ' (threshold \u00B13)',
    '',
    'NET RATINGS: ' + homeAlias + ' ' + (floor.homeNet >= 0 ? '+' : '') + floor.homeNet + ' | ' + awayAlias + ' ' + (floor.awayNet >= 0 ? '+' : '') + floor.awayNet,
    '',
  ];
  return lines.join('\n');
}

function getVerdictLabel(score) {
  if (score >= 0.90) return 'DOMINANT';
  if (score >= 0.75) return 'STRONG';
  if (score >= 0.60) return 'EARNED';
  if (score >= 0.45) return 'NO EDGE';
  return 'WAIT';
}

// ══════════════════════════════════════════════════════════════════════════════
// 10. SYSTEM PROMPT
// ══════════════════════════════════════════════════════════════════════════════

function buildSystemPrompt() {
  return [
    'You are an NBA pre-game structural analyst. Build game thesis documents predicting where the structural battle will be fought and what to monitor live.',
    '',
    "The user's strategy: BET THE STRUCTURALLY DOMINANT TEAM WHEN TRAILING, because the opponent's lead is built on unsustainable variance. The thesis identifies WHICH team has real structural control.",
    '',
    'INDICATORS (weighted): I1 Possession & Transition (10%) \u2014 TO margin, steals, OREBs, POT, SCP, FBP. I2 Rim Pressure & Foul (15%) \u2014 paint pts, at-rim rates, FTA, blocks. I3 Shot Quality & Creation (20%) \u2014 assist ratio, eFG%, shot zones. I4 Game Control (30%) \u2014 win margin tendency, bench depth, biggest lead, Q4 closing. I5 Sustained Execution (25%) \u2014 net rating, tempo, run dominance.',
    '',
    'Each scored 1.0 (clear edge), 0.5 (contested), 0.0 (opponent). Control: 0.90+ DOMINANT | 0.75-0.89 STRONG | 0.60-0.74 EARNED | 0.45-0.59 NO EDGE | <0.45 WAIT.',
    '',
    'STRUCTURAL IMPACT ASSESSMENT (MANDATORY \u2014 execute before scoring indicators):',
    '',
    'The server has pre-computed a Structural Impact Assessment for each team with OUT players. This includes per-player production shares, indicator degradation tiers, GP gate status, redistribution adjustments, and System Resilience Modifier.',
    '',
    'GP GATE: The server checks how much of the season each OUT player actually played.',
    '- SUPPRESSED (GP <40% of team games): Season team stats ALREADY reflect this player absence. Their per-game numbers look impressive but the team has been playing without them all year. Do NOT discount team indicators further for this player. Treat as a known condition, not a new loss.',
    '- REDUCED (GP 40-70%): Season stats are a blend. Some inflation exists but the team has meaningful experience without this player. Degradation tiers are already reduced by one in the pre-computation.',
    '- FULL (GP 70%+): Season stats meaningfully include this player production. Full degradation applies.',
    '',
    'ANALYTICAL RULES:',
    '1. Display the full SIA in your AVAILABILITY section BEFORE scoring indicators. This is mandatory.',
    '2. When a player with FULL GP gate has a primary indicator contribution (the pre-computed tier shows degradation), you cannot award 1.0 on that indicator to their team without explaining why the remaining roster still has a clear edge.',
    '3. When a player is GP GATE SUPPRESSED, do NOT penalize their team further. The team stats you are reading ARE the without-this-player stats.',
    '4. DEPLETION GATE ceilings are strong guidelines. You can exceed them only with explicit justification showing the opponent is severely compromised or the matchup creates unusual structural opportunity.',
    '5. Redistribution and System Resilience adjustments are already applied in the pre-computed tiers. Do not double-count.',
    '6. Show your reasoning when SIA data and your matchup read create tension. Example: "DAL season paint pts rank 5th, but Lively (FULL GP, I2 degradation) is OUT \u2014 remaining interior is [X]. CHA interior defense ranks [Y]. Awarding I2 to CHA."',
    '',
    'Compute from the data: Context-Adjusted Strength, Structural Identity, Shot Diet, Win/Loss Delta, Comeback Score (0-10), Lead-Keep Score (0-10), Foul Resilience.',
    'BHV, Chaos Risk, and Pythagorean are pre-computed \u2014 use provided values.',
    '',
    '3PT VULNERABILITY PROFILE (both teams): ELITE (38%+ on 2+ 3PA/gm — sustainable, identity shooter), AVERAGE (33-38% or 30%+ on 3+ att/gm — reliable, not a regression candidate), NON-SHOOTER (<33% or <1.5 3PA/gm — if hitting, regression is coming). Name 2-3 per team.',
    '',
    'ML THRESHOLD (if odds provided): Convert control score to FWP. ML THRESHOLD = ML where MIP is 5%+ below FWP.',
    '',
    'OUTPUT FORMAT (PLAIN TEXT ONLY \u2014 no Markdown. Do not use ** for bold, # for headers, or * for bullets. Use \u2501 lines, \u26A0 \u2713 \u2705 \u274C emoji, and ALL CAPS for section headers instead.):',
    'COMPACT THESIS \u2014 [AWAY] vs [HOME] | [Time] MST',
    '[Date] | [Venue]',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'AVAILABILITY (PRE-COMPUTED — copy exactly as provided, do NOT rearrange or mix players between teams)',
    '[The server has pre-computed the availability section with correct team attribution. Reproduce it verbatim.]',
    '[If NEW/RETURNING players are listed, include them with 🔄 tag after the team they belong to.]',
    '',
    'SIA (from pre-computed assessment):',
    '[Player] OUT \u2014 [stat line] \u2014 I1:[impact] I2:[impact] I3:[impact] I4:[impact] I5:[impact] [GP GATE: status]',
    'ADJUSTMENTS: [any redistribution or SRM notes]',
    'NET CONTEXT: [advisory caps if applicable]',
    'DEPLETION GATE: [if applicable]',
    '',
    'REST [TEAM A] X day | [TEAM B] X day',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'CONTROL SCORE: [Team] [X.XX] \u2014 [Verdict]',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'I1-I5 scored with 1-line reasons (informed by SIA context)',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'SHOT DIET',
    '[TEAM]: [Interior/Transition | Perimeter/Creation | Balanced] \u2014 season 3PT% [X]% on [Y] 3PA/gm',
    '',
    '3PT HEATER WATCHLIST',
    '[TEAM]: [Player] ([szn 3PT%] on [vol]/gm) [ELITE|AVERAGE|NON-SHOOTER], ...',
    '',
    'KEY FLAGS',
    '\u26A0 [Flag]',
    '\u2713 [Clean note]',
    '',
    'MARKET     Spread: [X] | ML: [X/X] | O/U: [X]',
    'ML THRESHOLD: [details]',
    '',
    'ENTRY      [description]',
    'PASS       [description]',
    '',
    'CLUTCH GATE: [pre-game note]',
    '',
    'WATCH',
    '1. [item]',
    '2. [item]',
    '3. [item]',
  ].join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// 11. NCAAMB SYSTEM PROMPT
// ══════════════════════════════════════════════════════════════════════════════

function buildNCAAMBSystemPrompt() {
  return [
    'You are an NCAA Men\'s Basketball pre-game structural analyst for March Madness and regular season betting.',
    '',
    'LEAGUE CONTEXT:',
    '- Two 20-minute halves (not four quarters). 30-second shot clock. 5 personal fouls = disqualification.',
    '- ~65-70 possessions per game (vs NBA ~100). Pace is slower, each possession matters more.',
    '- Tournament games are neutral site \u2014 ignore home/away advantage for March Madness.',
    '- 362 teams \u2014 roster depth and talent gaps vary enormously compared to NBA.',
    '',
    "The user's strategy: BET THE STRUCTURALLY DOMINANT TEAM WHEN TRAILING, because the opponent's lead is built on unsustainable variance. The thesis identifies WHICH team has real structural control.",
    '',
    'INDICATORS (weighted): I1 Possession & Transition (10%) \u2014 TO margin, steals, OREBs, POT, SCP, FBP. I2 Rim Pressure & Foul (15%) \u2014 paint pts, at-rim rates, FTA, blocks. I3 Shot Quality & Creation (20%) \u2014 assist ratio, eFG%, shot zones. I4 Game Control (30%) \u2014 depth, win margin tendency, rotation quality. I5 Sustained Execution (25%) \u2014 net rating, tempo, run dominance.',
    '',
    'Each scored 1.0 (clear edge), 0.5 (contested), 0.0 (opponent). Control: 0.90+ DOMINANT | 0.75-0.89 STRONG | 0.60-0.74 EARNED | 0.45-0.59 NO EDGE | <0.45 WAIT.',
    '',
    'NCAAMB-SPECIFIC ANALYSIS:',
    '- NET RANKINGS are the primary strength-of-schedule metric. Weight NET rank + quad records (Q1-Q4 win-loss) heavily.',
    '- Q1 wins (vs top-30 NET home / top-75 away) indicate elite-level competitiveness.',
    '- No daily injury report \u2014 injuries come from team profile roster status only.',
    '- No depth chart \u2014 derive rotation quality from minutes distribution in season stats.',
    '- No splits, no clutch data, no tracking data.',
    '',
    'Compute from the data: Context-Adjusted Strength (using NET rank + quad records), Structural Identity, Shot Diet, Comeback Score (0-10), Lead-Keep Score (0-10).',
    'Pythagorean is pre-computed \u2014 use provided values.',
    '',
    '3PT VULNERABILITY PROFILE (both teams): ELITE (38%+ on 2+ 3PA/gm), AVERAGE (33-38% or 30%+ on 3+ att/gm), NON-SHOOTER (<33% or <1.5 3PA/gm). Name 2-3 per team.',
    '',
    'ML THRESHOLD (if odds provided): Convert control score to FWP. ML THRESHOLD = ML where MIP is 5%+ below FWP.',
    '',
    'OUTPUT FORMAT (PLAIN TEXT ONLY \u2014 no Markdown):',
    'COMPACT THESIS \u2014 [AWAY] vs [HOME] | [Time] MST',
    '[Date] | [Venue]',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'NET RANKINGS',
    '[AWAY]: NET #X (W-L) Q1:X-X Q2:X-X Q3:X-X Q4:X-X | SOS:#X | Conf: [conference] [conf record]',
    '[HOME]: NET #X (W-L) Q1:X-X Q2:X-X Q3:X-X Q4:X-X | SOS:#X | Conf: [conference] [conf record]',
    'MATCHUP QUALITY: [Quad X game for both teams]',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'AVAILABILITY',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'CONTROL SCORE: [Team] [X.XX] \u2014 [Verdict]',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'I1-I5 scored with 1-line reasons',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'SHOT DIET / 3PT HEATER WATCHLIST / KEY FLAGS / MARKET / ENTRY / PASS / WATCH',
  ].join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// 12. AUTO MODE — Pregame Agent Infrastructure
// ══════════════════════════════════════════════════════════════════════════════

var LEAGUE_CFG = {
  nba: { srBase: 'https://api.sportradar.com/nba/trial/v8/en/', srKeyEnv: 'SR_API_KEY', season: '2025' },
  ncaamb: { srBase: 'https://api.sportradar.com/ncaamb/trial/v8/en/', srKeyEnv: 'SR_NCAAMB_KEY', season: '2025' },
};

async function srFetchDirect(league, path) {
  var cfg = LEAGUE_CFG[league] || LEAGUE_CFG.nba;
  var key = process.env[cfg.srKeyEnv];
  if (!key) throw new Error('Missing ' + cfg.srKeyEnv);
  var url = cfg.srBase + path + (path.includes('?') ? '&' : '?') + 'api_key=' + key;
  var resp = await fetch(url);
  if (resp.status === 429) throw new Error('SR rate limited');
  if (!resp.ok) throw new Error('SR ' + resp.status + ' on ' + path.split('?')[0]);
  return resp.json();
}

async function bdlFetchDirect(path) {
  var key = process.env.BDL_API_KEY;
  var resp = await fetch('https://api.balldontlie.io' + path, { headers: { Authorization: key } });
  if (!resp.ok) throw new Error('BDL ' + resp.status);
  return resp.json();
}

async function sendNtfy(title, body) {
  var topic = process.env.NTFY_TOPIC || 'manny_nba_control';
  try {
    await fetch('https://ntfy.sh/' + topic, {
      method: 'POST', body: body,
      headers: { Title: title.replace(/[^\x20-\x7E]/g, ''), Priority: '3', Tags: 'clipboard' },
    });
  } catch (e) { console.log('ntfy error:', e.message); }
}

async function loadSeasonQ4Auto(sql, league) {
  try {
    var rows = await sql`
      SELECT home_alias, away_alias, quarter_data
      FROM games WHERE league = ${league} AND home_pts IS NOT NULL AND home_pts > 0
      AND quarter_data IS NOT NULL ORDER BY date DESC LIMIT 200
    `;
    var teamQ4 = {};
    for (var r of rows) {
      var qd = typeof r.quarter_data === 'string' ? JSON.parse(r.quarter_data) : r.quarter_data;
      if (!qd?.diffs?.['4']) continue;
      var hQ4 = qd.diffs['4']?.home?.points, aQ4 = qd.diffs['4']?.away?.points;
      if (hQ4 == null || aQ4 == null) continue;
      var margin = hQ4 - aQ4;
      if (!teamQ4[r.home_alias]) teamQ4[r.home_alias] = [];
      if (!teamQ4[r.away_alias]) teamQ4[r.away_alias] = [];
      teamQ4[r.home_alias].push(margin);
      teamQ4[r.away_alias].push(-margin);
    }
    var result = {};
    for (var team of Object.keys(teamQ4)) {
      if (teamQ4[team].length >= 3) result[team] = teamQ4[team].reduce(function(a,b){return a+b;},0) / teamQ4[team].length;
    }
    return result;
  } catch (e) { return {}; }
}

// ── AUTO TRIM FUNCTIONS (simplified from client-side) ──────────────────────

function autoTrimProfile(p) {
  if (!p) return '(unavailable)';
  return (p.players||[]).filter(function(pl){return pl.status==='ACT'||pl.status==='SUS'||pl.status==='NWT'||pl.status==='OUT'||pl.status==='INJ';})
    .map(function(pl){var inj=pl.injuries?JSON.stringify(pl.injuries):'';return (pl.full_name||'?')+' ['+(pl.primary_position||'?')+'] '+(pl.status||'?')+(inj?' — '+inj:'');}).join('\n');
}

function autoTrimStats(s) {
  if (!s) return '(unavailable)';
  var own = s.own_record || s;
  var teamStats = own.statistics || s.statistics || {};
  var oppStats = (s.opponents||{}).statistics || {};
  var players = (own.players||s.players||[]).sort(function(a,b){return (b.average?.minutes||0)-(a.average?.minutes||0);}).slice(0,10)
    .map(function(pl){var a=pl.average||{};return (pl.full_name||'?')+' ['+(pl.primary_position||'?')+'] '+(a.minutes||0)+'mpg '+(a.points||0)+'ppg '+(a.assists||0)+'apg '+(a.steals||0)+'spg '+(a.turnovers||0)+'to FG:'+(a.field_goals_made||0)+'/'+(a.field_goals_att||0)+' 3P:'+(a.three_points_made||0)+'/'+(a.three_points_att||0);});
  var t = teamStats;
  var teamLine = 'Team: '+(t.points||0)+'ppg '+(t.assists||0)+'apg '+(t.steals||0)+'spg '+(t.blocks||0)+'bpg '+(t.turnovers||t.total_turnovers||0)+'to POT:'+(t.points_off_turnovers||0)+' Paint:'+(t.points_in_the_paint||t.points_in_paint||0)+' OREB:'+(t.offensive_rebounds||0)+' FTA:'+(t.free_throws_att||0);
  var oppLine = oppStats ? 'Opp allowed: '+(oppStats.points||0)+'ppg Paint:'+(oppStats.points_in_the_paint||oppStats.points_in_paint||0)+' FTA:'+(oppStats.free_throws_att||0)+' Stl:'+(oppStats.steals||0) : '';
  return teamLine + '\n' + oppLine + '\nTop players:\n' + players.join('\n');
}

function autoTrimDepth(d) {
  if (!d) return '(unavailable)';
  var pos = [];
  if (d.positions && Array.isArray(d.positions)) pos = d.positions;
  else if (d.positions && typeof d.positions === 'object') {
    Object.keys(d.positions).forEach(function(name){
      var val = d.positions[name]; var players = Array.isArray(val) ? val : (val?.players || []);
      if (players.length > 0) pos.push({name:name, players:players});
    });
  }
  if (pos.length === 0) return JSON.stringify(d).substring(0,2000);
  return pos.map(function(p){return (p.name||'?')+': '+(p.players||[]).map(function(pl){return (pl.depth||'?')+'. '+(pl.full_name||'?');}).join(', ');}).join('\n');
}

function autoTrimStandings(s) {
  if (!s) return '(unavailable)';
  var teams = [];
  (s.conferences||[]).forEach(function(conf){(conf.divisions||[]).forEach(function(div){(div.teams||[]).forEach(function(t){
    teams.push((t.name||'?')+' '+(t.wins||0)+'-'+(t.losses||0)+' ('+(t.win_pct||0).toFixed(3)+') PF:'+(t.calc_points?.for||'?')+' PA:'+(t.calc_points?.against||'?'));
  });});});
  return teams.join('\n');
}

function autoTrimInjuries(inj) {
  if (!inj) return '(unavailable)';
  return (inj.teams||[]).filter(function(t){return (t.players||[]).length>0;})
    .map(function(t){return (t.alias||'?')+': '+(t.players||[]).map(function(p){
      var li=(Array.isArray(p.injuries)?p.injuries:[])[0]||{};
      return (p.full_name||'?')+' ['+(p.primary_position||'?')+'] '+(li.status||p.status||'?')+' — '+(li.desc||li.comment||'?');
    }).join('; ');}).join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// 13. PREGAME AGENT — auto-generate theses before tip
// ══════════════════════════════════════════════════════════════════════════════

async function runPregameAgent() {
  var logs = [];
  function log(msg) { logs.push(msg); console.log('[PREGAME] ' + msg); }
  log('Pregame agent starting...');

  var sql = neon(process.env.DATABASE_URL);
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { log('ERROR: Missing ANTHROPIC_API_KEY'); return { logs: logs, generated: 0 }; }

  // 1. Get today's schedule from poll_state
  var now = new Date();
  var mst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Phoenix' }));
  var dateKey = mst.toISOString().split('T')[0];

  var league = 'nba'; // MVP: NBA only
  var pollRows;
  try {
    pollRows = await sql`SELECT schedule_json FROM poll_state WHERE league = ${league} AND date = ${dateKey} LIMIT 1`;
  } catch (e) { log('poll_state query failed: ' + e.message); return { logs: logs, generated: 0 }; }

  if (!pollRows || pollRows.length === 0 || !pollRows[0].schedule_json) {
    log('No schedule found for ' + dateKey + ' — nothing to do');
    return { logs: logs, generated: 0 };
  }

  var schedule = typeof pollRows[0].schedule_json === 'string' ? JSON.parse(pollRows[0].schedule_json) : pollRows[0].schedule_json;
  log('Schedule: ' + schedule.length + ' games on ' + dateKey);

  // 2. Find games tipping in 5-15 minutes
  var candidates = [];
  for (var g of schedule) {
    if (!g.scheduled) continue;
    var tip = new Date(g.scheduled);
    var minsTilTip = (tip - now) / 60000;
    if (minsTilTip >= 5 && minsTilTip <= 15) {
      candidates.push({ game: g, minsTilTip: Math.round(minsTilTip) });
    }
  }

  if (candidates.length === 0) {
    log('No games tipping in 5-15 minutes — nothing to do');
    return { logs: logs, generated: 0 };
  }
  log('Candidates: ' + candidates.map(function(c) { return c.game.away_alias + '@' + c.game.home_alias + ' (' + c.minsTilTip + 'min)'; }).join(', '));

  // 3. Check which don't have theses yet
  var gameIds = candidates.map(function(c) { return c.game.id; });
  var existingRows;
  try {
    existingRows = await sql`SELECT game_id FROM theses WHERE game_id = ANY(${gameIds})`;
  } catch (e) { existingRows = []; }
  var existingSet = new Set((existingRows || []).map(function(r) { return r.game_id; }));

  var toGenerate = candidates.filter(function(c) { return !existingSet.has(c.game.id); });
  if (toGenerate.length === 0) {
    log('All candidates already have theses — nothing to do');
    return { logs: logs, generated: 0 };
  }
  log('Generating theses for ' + toGenerate.length + ' games');

  // 4. Fetch shared data (once per invocation)
  var injuries = null, standings = null, seasonQ4 = {};
  try {
    injuries = await srFetchDirect(league, 'league/injuries.json');
    await new Promise(function(r) { setTimeout(r, 1100); });
    standings = await srFetchDirect(league, 'seasons/' + LEAGUE_CFG[league].season + '/REG/standings.json');
    await new Promise(function(r) { setTimeout(r, 1100); });
  } catch (e) { log('Shared SR fetch error: ' + e.message); }

  try { seasonQ4 = await loadSeasonQ4Auto(sql, league); } catch (e) {}

  // 5. Process each game (cap at 3 per invocation)
  var generated = [];
  for (var c of toGenerate.slice(0, 3)) {
    var game = c.game;
    var hA = game.home_alias, aA = game.away_alias;
    var matchup = aA + ' @ ' + hA;
    log('Processing: ' + matchup);

    var hId = SR_TEAM_IDS[hA], aId = SR_TEAM_IDS[aA];
    if (!hId || !aId) { log('Unknown team alias: ' + hA + ' or ' + aA); continue; }

    try {
      // Fetch per-game SR data (10 calls with 1.1s delays for rate limit)
      var srCalls = [
        { key: 'homeProfile', path: 'teams/' + hId + '/profile.json' },
        { key: 'awayProfile', path: 'teams/' + aId + '/profile.json' },
        { key: 'homeDepth', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + hId + '/depth_chart.json' },
        { key: 'awayDepth', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + aId + '/depth_chart.json' },
        { key: 'homeStats', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + hId + '/statistics.json' },
        { key: 'awayStats', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + aId + '/statistics.json' },
        { key: 'homeSplitsGame', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + hId + '/splits/game.json' },
        { key: 'awaySplitsGame', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + aId + '/splits/game.json' },
        { key: 'homeSplitsSchedule', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + hId + '/splits/schedule.json' },
        { key: 'awaySplitsSchedule', path: 'seasons/' + LEAGUE_CFG[league].season + '/REG/teams/' + aId + '/splits/schedule.json' },
      ];

      var collected = {};
      for (var call of srCalls) {
        try {
          collected[call.key] = await srFetchDirect(league, call.path);
        } catch (e) {
          log('  SR ' + call.key + ' failed: ' + e.message);
          collected[call.key] = null;
        }
        await new Promise(function(r) { setTimeout(r, 1100); });
      }

      // BDL odds
      var oddsText = '';
      try {
        var tipDate = new Date(game.scheduled).toISOString().split('T')[0];
        var bdlGames = await bdlFetchDirect('/nba/v1/games?dates[]=' + tipDate);
        var bdlGame = (bdlGames.data||[]).find(function(bg) {
          return (bg.home_team?.abbreviation === hA && (bg.visitor_team?.abbreviation === aA || bg.away_team?.abbreviation === aA));
        });
        if (bdlGame?.id) {
          await new Promise(function(r) { setTimeout(r, 200); });
          var oddsResp = await bdlFetchDirect('/nba/v1/odds?game_id=' + bdlGame.id);
          var oddsArr = oddsResp.data || [];
          if (oddsArr.length > 0) {
            var book = oddsArr[0];
            oddsText = '\n=== ODDS ===\nSpread: ' + (book.spread_home_value||'?') + ' | ML: ' + (book.moneyline_home_odds||'?') + '/' + (book.moneyline_away_odds||'?') + ' | O/U: ' + (book.total_value||'?') + '\n';
          }
        }
      } catch (e) { log('  BDL odds failed (non-fatal): ' + e.message); }

      // Build sections (trimmed text for Sonnet)
      var sections = {
        injuries: autoTrimInjuries(injuries),
        homeRoster: autoTrimProfile(collected.homeProfile),
        awayRoster: autoTrimProfile(collected.awayProfile),
        homeDepth: autoTrimDepth(collected.homeDepth),
        awayDepth: autoTrimDepth(collected.awayDepth),
        homeStats: autoTrimStats(collected.homeStats),
        awayStats: autoTrimStats(collected.awayStats),
        homeSplitsGame: collected.homeSplitsGame ? JSON.stringify(collected.homeSplitsGame).substring(0, 8000) : '(unavailable)',
        awaySplitsGame: collected.awaySplitsGame ? JSON.stringify(collected.awaySplitsGame).substring(0, 8000) : '(unavailable)',
        homeSplitsSchedule: collected.homeSplitsSchedule ? JSON.stringify(collected.homeSplitsSchedule).substring(0, 8000) : '(unavailable)',
        awaySplitsSchedule: collected.awaySplitsSchedule ? JSON.stringify(collected.awaySplitsSchedule).substring(0, 8000) : '(unavailable)',
        standings: autoTrimStandings(standings),
        odds: oddsText,
      };

      // Build analytical object for SIA pipeline
      var analytical = { standings: standings, league: league };
      if (collected.homeProfile) analytical.homeProfile = collected.homeProfile;
      if (collected.awayProfile) analytical.awayProfile = collected.awayProfile;
      if (collected.homeStats) analytical.homeSeasonStats = collected.homeStats;
      if (collected.awayStats) analytical.awaySeasonStats = collected.awayStats;

      // Run SIA pipeline
      var rosterAudit = computeRosterAudit(analytical, hA, aA);
      var sia = computeSIA(rosterAudit, analytical, hA, aA);
      var redistribution = computeRedistribution(rosterAudit, sia, analytical, hA, aA);
      var srm = computeSRM(rosterAudit, analytical);
      var finalCaps = applyAdjustments(sia, redistribution, srm);
      var depletion = computeDepletionGate(rosterAudit);
      var pyth = computePythagorean(standings, hA, aA);
      var bhv = computeBHV(analytical, hA, aA, rosterAudit);
      var preComputed = formatPreComputed(hA, aA, rosterAudit, sia, finalCaps, redistribution, srm, depletion, pyth, bhv);

      // Compute mechanical pregame floor
      var homeStatsRaw = collected.homeStats?.own_record || collected.homeStats;
      var awayStatsRaw = collected.awayStats?.own_record || collected.awayStats;
      var floor = computePreGameFloor(homeStatsRaw, awayStatsRaw, standings, seasonQ4, finalCaps, hA, aA);
      var conviction = floor ? computeConviction(floor) : { tier: 'NO ENTRY', combo: 'NONE', indicatorsWon: [], indicatorsLost: [] };
      var floorText = floor ? formatMechanicalFloor(floor, conviction, hA, aA) : '';

      log('  Floor: ' + (floor ? floor.controlTeam + ' ' + floor.score.toFixed(2) + ' ' + getVerdictLabel(floor.score) + ' | ' + conviction.tier + ' (' + conviction.combo + ')' : 'FAILED'));

      // Build prompt
      var tipTime = new Date(game.scheduled).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix' });
      var systemPrompt = buildSystemPrompt();
      var userPrompt = 'Build a complete pre-game thesis for this NBA matchup.\n\n' +
        'MATCHUP: ' + aA + ' @ ' + hA + '\n' +
        'DATE: ' + dateKey + ' | TIME: ' + tipTime + ' MST\n' +
        'VENUE: ' + (game.venue || 'TBD') + '\n\n' +
        floorText +
        preComputed + '\n\n' +
        '=== INJURIES ===\n' + sections.injuries + '\n\n' +
        '=== ' + hA + ' ROSTER ===\n' + sections.homeRoster + '\n\n' +
        '=== ' + aA + ' ROSTER ===\n' + sections.awayRoster + '\n\n' +
        '=== ' + hA + ' DEPTH CHART ===\n' + sections.homeDepth + '\n\n' +
        '=== ' + aA + ' DEPTH CHART ===\n' + sections.awayDepth + '\n\n' +
        '=== ' + hA + ' SEASON STATS ===\n' + sections.homeStats + '\n\n' +
        '=== ' + aA + ' SEASON STATS ===\n' + sections.awayStats + '\n\n' +
        '=== ' + hA + ' SPLITS (Game) ===\n' + sections.homeSplitsGame + '\n\n' +
        '=== ' + aA + ' SPLITS (Game) ===\n' + sections.awaySplitsGame + '\n\n' +
        '=== ' + hA + ' SPLITS (Schedule) ===\n' + sections.homeSplitsSchedule + '\n\n' +
        '=== ' + aA + ' SPLITS (Schedule) ===\n' + sections.awaySplitsSchedule + '\n\n' +
        '=== STANDINGS ===\n' + sections.standings + '\n' +
        sections.odds + '\n\n' +
        'IMPORTANT: The PRE-COMPUTED STRUCTURAL ASSESSMENT contains SIA context. The MECHANICAL PREGAME FLOOR provides indicator scores as ground truth \u2014 do not override them. Show SIA notation in AVAILABILITY. Add DISAGREEMENT if your contextual read differs from the mechanical floor.\n\n' +
        'Output the compact thesis format.';

      // Call Sonnet (non-streaming for auto mode)
      var anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
      });

      if (!anthropicResp.ok) {
        var errText = await anthropicResp.text();
        log('  Sonnet error: ' + anthropicResp.status + ' ' + errText.substring(0, 200));
        continue;
      }

      var sonnetData = await anthropicResp.json();
      var thesis = sonnetData.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');

      // Save to DB
      await sql`
        INSERT INTO theses (game_id, league, text, created_at)
        VALUES (${game.id}, ${league}, ${thesis}, NOW())
        ON CONFLICT (game_id) DO UPDATE SET text = ${thesis}, created_at = NOW()
      `;

      generated.push({
        matchup: matchup,
        floor: floor ? floor.score.toFixed(2) : '?',
        verdict: floor ? getVerdictLabel(floor.score) : '?',
        conviction: conviction.tier,
        controlTeam: floor ? floor.controlTeam : '?',
      });
      log('  Thesis saved for ' + matchup);

    } catch (e) {
      log('  ERROR processing ' + matchup + ': ' + e.message);
    }
  }

  // 6. Send ntfy summary
  if (generated.length > 0) {
    var ntfyTitle = 'DFT Pre-Game: ' + generated.length + ' ' + (generated.length === 1 ? 'thesis' : 'theses') + ' ready';
    var ntfyBody = generated.map(function(g) {
      return g.matchup + '\nFloor: ' + g.controlTeam + ' ' + g.floor + ' ' + g.verdict + ' (' + g.conviction + ')';
    }).join('\n\n');
    await sendNtfy(ntfyTitle, ntfyBody);
    log('ntfy sent: ' + ntfyTitle);
  }

  return { logs: logs, generated: generated.length };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER — Netlify Functions v2 with streaming
// ══════════════════════════════════════════════════════════════════════════════

export default async function(request) {
  // AUTO MODE — triggered by cron schedule (GET request, no body)
  if (request.method !== 'POST' && request.method !== 'OPTIONS') {
    try {
      var result = await runPregameAgent();
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }

  // MANUAL MODE — existing POST handler below
  var corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    var body = await request.json();
    var apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Missing ANTHROPIC_API_KEY' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── Legacy mode (backward compat — non-streaming) ──
    if (body.systemPrompt && body.userPrompt) {
      var legResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: body.systemPrompt, messages: [{ role: 'user', content: body.userPrompt }] }),
      });
      if (!legResp.ok) {
        var e = await legResp.text();
        return new Response(JSON.stringify({ error: 'Anthropic ' + legResp.status + ': ' + e.substring(0, 300) }), {
          status: legResp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      var legData = await legResp.json();
      return new Response(JSON.stringify({
        thesis: legData.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n'),
        usage: legData.usage
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── Smart compute mode ──
    var matchup = body.matchup || {};
    var sections = body.sections || {};
    var analytical = body.analytical || {};
    var homeAlias = matchup.home || 'HOME';
    var awayAlias = matchup.away || 'AWAY';
    var league = analytical.league || 'nba';

    var systemPrompt, userPrompt, preComputedResult;

    if (league === 'ncaamb') {
      // ══════════════════════════════════════════════════════════════════
      // NCAAMB PATH — simplified pre-compute
      // ══════════════════════════════════════════════════════════════════
      var pyth = computePythagorean(analytical.standings, homeAlias, awayAlias);

      var ncaaPre = '=== PRE-COMPUTED STRUCTURAL ASSESSMENT (NCAAMB) ===\n\nPYTHAGOREAN EXPECTATION:\n';
      if (pyth.home) ncaaPre += homeAlias + ': ' + pyth.home.actual + '-' + pyth.home.losses + ' (expected ' + pyth.home.expected.toFixed(0) + '-' + (pyth.home.gp - pyth.home.expected).toFixed(0) + ', delta ' + (pyth.home.delta >= 0 ? '+' : '') + pyth.home.delta + ')' + (pyth.home.label ? ' \u2014 ' + pyth.home.label : '') + '\n';
      else ncaaPre += homeAlias + ': (not found in standings)\n';
      if (pyth.away) ncaaPre += awayAlias + ': ' + pyth.away.actual + '-' + pyth.away.losses + ' (expected ' + pyth.away.expected.toFixed(0) + '-' + (pyth.away.gp - pyth.away.expected).toFixed(0) + ', delta ' + (pyth.away.delta >= 0 ? '+' : '') + pyth.away.delta + ')' + (pyth.away.label ? ' \u2014 ' + pyth.away.label : '') + '\n';
      else ncaaPre += awayAlias + ': (not found in standings)\n';

      ncaaPre += '\nAVAILABILITY (from team profiles):\n';
      ['home', 'away'].forEach(function(side) {
        var alias = side === 'home' ? homeAlias : awayAlias;
        var profile = analytical[side + 'Profile'];
        if (!profile || !profile.players) { ncaaPre += alias + ': (roster unavailable)\n'; return; }
        var out = [], active = 0;
        (profile.players || []).forEach(function(p) {
          var st = (p.status || '').toUpperCase();
          if (st === 'OUT' || st === 'INJ' || st === 'SUS' || st === 'NWT') {
            out.push((p.full_name||'?') + ' [' + (p.primary_position||'?') + '] ' + st);
          } else { active++; }
        });
        ncaaPre += alias + ': ' + active + ' players available\n';
        if (out.length) ncaaPre += alias + ' OUT: ' + out.join(' | ') + '\n';
        else ncaaPre += alias + ': FULL STRENGTH\n';
      });

      systemPrompt = buildNCAAMBSystemPrompt();
      userPrompt = 'Build a complete pre-game thesis for this NCAAMB matchup.\n\n' +
        'MATCHUP: ' + awayAlias + ' @ ' + homeAlias + '\n' +
        'DATE: ' + (matchup.date || '?') + ' | TIME: ' + (matchup.time || '?') + ' MST\n' +
        'VENUE: ' + (matchup.venue || 'TBD') + '\n\n' +
        ncaaPre + '\n\n' +
        (sections.netRankings ? '=== NET RANKINGS ===\n' + sections.netRankings + '\n\n' : '') +
        '=== ' + homeAlias + ' ROSTER ===\n' + (sections.homeRoster || '(unavailable)') + '\n\n' +
        '=== ' + awayAlias + ' ROSTER ===\n' + (sections.awayRoster || '(unavailable)') + '\n\n' +
        '=== ' + homeAlias + ' SEASON STATS ===\n' + (sections.homeStats || '(unavailable)') + '\n\n' +
        '=== ' + awayAlias + ' SEASON STATS ===\n' + (sections.awayStats || '(unavailable)') + '\n\n' +
        '=== STANDINGS ===\n' + (sections.standings || '(unavailable)') + '\n' +
        (sections.odds || '') + '\n\n' +
        'NCAAMB CONTEXT: Two 20-min halves. 5 fouls. 30-sec shot clock. ~65-70 poss/game. No depth chart, splits, clutch, or tracking. NET rankings + quad records are the primary strength metric.\n\nOutput the compact thesis format.';

      preComputedResult = {
        rosterAudit: { homeOut: 0, awayOut: 0, homeOutNames: [], awayOutNames: [] },
        siaCaps: { home: {}, away: {} },
        depletion: { home: null, away: null },
        pyth: pyth, league: 'ncaamb',
      };

    } else {
      // ══════════════════════════════════════════════════════════════════
      // NBA PATH — full SIA pre-compute pipeline
      // ══════════════════════════════════════════════════════════════════
      var rosterAudit = computeRosterAudit(analytical, homeAlias, awayAlias);
      var sia = computeSIA(rosterAudit, analytical, homeAlias, awayAlias);
      var redistribution = computeRedistribution(rosterAudit, sia, analytical, homeAlias, awayAlias);
      var srm = computeSRM(rosterAudit, analytical);
      var finalCaps = applyAdjustments(sia, redistribution, srm);
      var depletion = computeDepletionGate(rosterAudit);
      var pyth = computePythagorean(analytical.standings, homeAlias, awayAlias);
      var bhv = computeBHV(analytical, homeAlias, awayAlias, rosterAudit);
      var preComputed = formatPreComputed(homeAlias, awayAlias, rosterAudit, sia, finalCaps, redistribution, srm, depletion, pyth, bhv);

      systemPrompt = buildSystemPrompt();
      userPrompt = 'Build a complete pre-game thesis for this NBA matchup.\n\n' +
        'MATCHUP: ' + awayAlias + ' @ ' + homeAlias + '\n' +
        'DATE: ' + (matchup.date || '?') + ' | TIME: ' + (matchup.time || '?') + ' MST\n' +
        'VENUE: ' + (matchup.venue || 'TBD') + '\n\n' +
        preComputed + '\n\n' +
        '=== PRE-COMPUTED AVAILABILITY (use this exactly \u2014 do NOT mix players between teams) ===\n' + (sections.availability || '(unavailable)') + '\n\n' +
        '=== INJURIES (raw report) ===\n' + (sections.injuries || '(unavailable)') + '\n\n' +
        (sections.returning || '') +
        '=== ' + homeAlias + ' ROSTER ===\n' + (sections.homeRoster || '(unavailable)') + '\n\n' +
        '=== ' + awayAlias + ' ROSTER ===\n' + (sections.awayRoster || '(unavailable)') + '\n\n' +
        '=== ' + homeAlias + ' DEPTH CHART ===\n' + (sections.homeDepth || '(unavailable)') + '\n\n' +
        '=== ' + awayAlias + ' DEPTH CHART ===\n' + (sections.awayDepth || '(unavailable)') + '\n\n' +
        '=== ' + homeAlias + ' SEASON STATS ===\n' + (sections.homeStats || '(unavailable)') + '\n\n' +
        '=== ' + awayAlias + ' SEASON STATS ===\n' + (sections.awayStats || '(unavailable)') + '\n\n' +
        '=== ' + homeAlias + ' SPLITS (Game) ===\n' + (sections.homeSplitsGame || '(unavailable)') + '\n\n' +
        '=== ' + awayAlias + ' SPLITS (Game) ===\n' + (sections.awaySplitsGame || '(unavailable)') + '\n\n' +
        '=== ' + homeAlias + ' SPLITS (Schedule) ===\n' + (sections.homeSplitsSchedule || '(unavailable)') + '\n\n' +
        '=== ' + awayAlias + ' SPLITS (Schedule) ===\n' + (sections.awaySplitsSchedule || '(unavailable)') + '\n\n' +
        '=== STANDINGS ===\n' + (sections.standings || '(unavailable)') + '\n' +
        (sections.odds || '') + '\n' + (sections.tracking || '') + '\n' + (sections.clutch || '') + '\n' +
        (sections.recentForm || '') + '\n\n' +
        'IMPORTANT: The PRE-COMPUTED STRUCTURAL ASSESSMENT contains SIA context with GP gate status. Players marked GP GATE SUPPRESSED should NOT cause further indicator discounts \u2014 team stats already reflect their absence. Players marked FULL GP gate with degradation tiers inform your indicator scoring. Show SIA notation in AVAILABILITY. If a depletion gate ceiling is set, justify exceeding it if you do.\n\n' +
        'Output the compact thesis format.';

      preComputedResult = {
        rosterAudit: { homeOut: rosterAudit.out.home.length, awayOut: rosterAudit.out.away.length,
          homeOutNames: rosterAudit.out.home.map(function(p) { return p.name; }),
          awayOutNames: rosterAudit.out.away.map(function(p) { return p.name; }) },
        siaCaps: { home: finalCaps.home.caps, away: finalCaps.away.caps },
        depletion: depletion, pyth: pyth, bhv: bhv
      };
    }

    // ── CALL SONNET (streaming) ──
    var anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, stream: true, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
    });

    if (!anthropicResp.ok) {
      var errText = await anthropicResp.text();
      return new Response(JSON.stringify({ error: 'Anthropic ' + anthropicResp.status + ': ' + errText.substring(0, 300) }), {
        status: anthropicResp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── STREAM RESPONSE ──
    var encoder = new TextEncoder();
    var readable = new ReadableStream({
      async start(controller) {
        try {
          // Send preComputed data as first event
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'preComputed', data: preComputedResult }) + '\n\n'));

          // Read Anthropic SSE stream and forward text deltas
          var reader = anthropicResp.body.getReader();
          var decoder = new TextDecoder();
          var buffer = '';
          var fullText = '';
          var usage = null;

          while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });

            var lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();
              if (!line.startsWith('data: ')) continue;
              var jsonStr = line.slice(6);
              if (jsonStr === '[DONE]') continue;

              try {
                var evt = JSON.parse(jsonStr);
                if (evt.type === 'content_block_delta' && evt.delta && evt.delta.text) {
                  fullText += evt.delta.text;
                  controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'delta', text: evt.delta.text }) + '\n\n'));
                }
                if (evt.type === 'message_delta' && evt.usage) {
                  usage = evt.usage;
                }
                if (evt.type === 'message_start' && evt.message && evt.message.usage) {
                  usage = evt.message.usage;
                }
              } catch (parseErr) {
                // Skip unparseable lines
              }
            }
          }

          // Send final done event with complete thesis and usage
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'done', thesis: fullText, usage: usage }) + '\n\n'));
          controller.close();
        } catch (streamErr) {
          try {
            controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'error', error: streamErr.message }) + '\n\n'));
            controller.close();
          } catch (e) {
            controller.error(streamErr);
          }
        }
      }
    });

    return new Response(readable, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SCHEDULE CONFIG — auto-generate theses before tip
// ══════════════════════════════════════════════════════════════════════════════
export const config = {
  schedule: "*/5 * * * *",  // every 5 minutes — checks for games tipping in 5-15 min
};

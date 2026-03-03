// Pre-Game Thesis Generation via Claude Sonnet — Smart Compute Layer v2.0
// Pre-computes: Roster Audit, Structural Impact Assessment, Role Redistribution,
// System Resilience Modifier, Depletion Gate, Pythagorean, BHV + Chaos Risk
// Then sends pre-computed facts to Sonnet for synthesis into compact thesis format.

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

// Match an injury/standings team object to home/away using multiple strategies
function matchTeamSide(team, homeAlias, awayAlias, homeId, awayId) {
  // Strategy 1: Match by SR ID (most reliable — injuries lack alias)
  if (homeId && (team.id === homeId || team.sr_id === homeId)) return 'home';
  if (awayId && (team.id === awayId || team.sr_id === awayId)) return 'away';
  // Strategy 2: Match by alias/abbreviation
  var alias = (team.alias || team.abbreviation || team.abbr || '').toUpperCase();
  if (alias && alias === homeAlias.toUpperCase()) return 'home';
  if (alias && alias === awayAlias.toUpperCase()) return 'away';
  // Strategy 3: Match by name (e.g. "Hornets") or market (e.g. "Charlotte")
  var name = (team.name || '').toLowerCase();
  var market = (team.market || '').toLowerCase();
  var hL = homeAlias.toLowerCase(), aL = awayAlias.toLowerCase();
  if (name.indexOf(hL) >= 0 || market.indexOf(hL) >= 0) return 'home';
  if (name.indexOf(aL) >= 0 || market.indexOf(aL) >= 0) return 'away';
  return null;
}

// Resolve depth chart positions from various SR response structures
// SR depth_chart endpoint wraps positions inside team metadata object
// positions can be: Array of {name, players[]} OR Object {PG: [...], SG: [...], ...}
function resolveDepthPositions(depth) {
  if (!depth) return [];
  
  // Check for positions key first (most common)
  var positions = depth.positions;
  if (positions) {
    // If it's already an array, use directly
    if (Array.isArray(positions)) return positions;
    // If it's an object keyed by position name (e.g. {PG: [...], SG: [...], C: [...], PF: [...], SF: [...]})
    if (typeof positions === 'object' && positions !== null) {
      var converted = [];
      Object.keys(positions).forEach(function(posName) {
        var val = positions[posName];
        // Value could be array of players directly, or object with players array
        var players = [];
        if (Array.isArray(val)) {
          players = val;
        } else if (val && Array.isArray(val.players)) {
          players = val.players;
        } else if (val && typeof val === 'object') {
          // Could be nested: {depth1: {...}, depth2: {...}} or similar
          players = Object.values(val).filter(function(v) { return v && typeof v === 'object' && (v.full_name || v.name); });
        }
        if (players.length > 0) {
          converted.push({ name: posName, position: posName, players: players });
        }
      });
      if (converted.length > 0) return converted;
    }
  }
  
  // Direct array
  if (Array.isArray(depth)) return depth;
  // SR sometimes nests as depth_chart.positions within team object
  if (depth.depth_chart) return resolveDepthPositions(depth.depth_chart);
  // Search for any key containing an array of objects with 'players' arrays
  var keys = Object.keys(depth);
  for (var i = 0; i < keys.length; i++) {
    // Skip known non-position keys
    if (['id','name','market','alias','founded','sr_id','reference','venue','league','conference','division','coaches'].indexOf(keys[i]) >= 0) continue;
    var val = depth[keys[i]];
    if (Array.isArray(val) && val.length > 0 && val[0] && (Array.isArray(val[0].players) || val[0].name || val[0].position)) {
      return val;
    }
  }
  return [];
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. ROSTER AUDIT
// ══════════════════════════════════════════════════════════════════════════════

function computeRosterAudit(analytical, homeAlias, awayAlias, matchup) {
  var out = { home: [], away: [] };
  var gtd = { home: [], away: [] };
  var injTeams = (analytical.injuries && analytical.injuries.teams) || [];
  var homeId = (matchup && matchup.homeId) || '';
  var awayId = (matchup && matchup.awayId) || '';

  injTeams.forEach(function(team) {
    var side = matchTeamSide(team, homeAlias, awayAlias, homeId, awayId);
    if (!side) return;

    (team.players || []).forEach(function(p) {
      // SR nests status inside p.injuries[0].status, NOT p.status
      var injArr = Array.isArray(p.injuries) ? p.injuries : [];
      var latestInj = injArr.length > 0 ? injArr[0] : {};
      var st = (latestInj.status || p.status || '').toUpperCase();
      var injDesc = latestInj.desc || latestInj.comment || p.desc || p.comment || '?';
      // Fallback: parse comment text for status keywords
      if (!st && injDesc) {
        var descUp = (typeof injDesc === 'string' ? injDesc : '').toUpperCase();
        if (descUp.indexOf('OUT') >= 0 || descUp.indexOf('NOT WITH TEAM') >= 0) st = 'OUT';
        else if (descUp.indexOf('DAY-TO-DAY') >= 0 || descUp.indexOf('GAME TIME') >= 0) st = 'DAY-TO-DAY';
        else if (descUp.indexOf('DOUBTFUL') >= 0) st = 'DOUBTFUL';
        else if (descUp.indexOf('QUESTIONABLE') >= 0) st = 'QUESTIONABLE';
        else if (descUp.indexOf('PROBABLE') >= 0) st = 'PROBABLE';
      }
      var entry = {
        name: p.full_name || p.name || '?',
        position: p.primary_position || p.position || '?',
        injury: injDesc,
        stats: null
      };
      if (st === 'OUT' || st === 'O' || st === 'IR' || st === 'NOT WITH TEAM') {
        out[side].push(entry);
      } else if (st === 'DAY-TO-DAY' || st === 'GTD' || st === 'DOUBTFUL' || st === 'QUESTIONABLE' || st === 'D' || st === 'Q' || st === 'GAME TIME' || st === 'PROBABLE') {
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
          out[side].push({ name: name, position: pp.primary_position || pp.position || '?', injury: 'Status: ' + st, stats: null });
        }
      }
    });
  });

  // Match OUT/GTD players to season stat lines
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
// 2. STRUCTURAL IMPACT ASSESSMENT
// ══════════════════════════════════════════════════════════════════════════════

function computeSIA(rosterAudit, analytical, homeAlias, awayAlias) {
  var result = { home: null, away: null };

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

    outPlayers.forEach(function(p) {
      if (!p.stats) {
        impacts.push({ name: p.name, position: p.position, I1: '\u2014', I2: '\u2014', I3: '\u2014', I4: '\u2014', I5: '\u2014', note: 'no stats' });
        return;
      }
      var s = p.stats;
      var impact = { name: p.name, position: p.position };
      impact.statLine = s.points.toFixed(1) + 'p ' + s.rebounds.toFixed(1) + 'r ' + s.assists.toFixed(1) + 'a ' +
        s.steals.toFixed(1) + 's ' + s.blocks.toFixed(1) + 'b ' + s.turnovers.toFixed(1) + 'to ' +
        s.minutes.toFixed(0) + 'min USG:' + s.usage.toFixed(1) + '%';

      // I1: Possession & Transition
      var i1 = (s.steals / tt.steals) * 0.40 + (s.oreb / tt.oreb) * 0.35 + (s.fbp / Math.max(tt.fbp, 1)) * 0.25;
      impact.I1 = i1 > 0.22 ? '\u25BC\u25BC\u25BC' : i1 > 0.12 ? '\u25BC\u25BC' : i1 > 0.05 ? '\u25BC' : '\u2014';

      // I2: Rim Pressure & Foul
      var rimP = s.atRimAtt > 0 ? (s.atRimAtt / tt.atRimAtt) : (s.paintPts / Math.max(tt.paintPts, 1));
      var i2 = (s.fta / tt.fta) * 0.30 + (s.blocks / Math.max(tt.blocks, 1)) * 0.30 + rimP * 0.40;
      impact.I2 = i2 > 0.25 ? '\u25BC\u25BC\u25BC' : i2 > 0.13 ? '\u25BC\u25BC' : i2 > 0.05 ? '\u25BC' : '\u2014';

      // I3: Shot Quality & Creation
      var i3 = (s.assists / Math.max(tt.assists, 1)) * 0.55 + (s.usage / 100) * 0.45;
      impact.I3 = i3 > 0.28 ? '\u25BC\u25BC\u25BC' : i3 > 0.15 ? '\u25BC\u25BC' : i3 > 0.07 ? '\u25BC' : '\u2014';

      // I4: Lineup Integrity
      var i4 = (s.minutes / tt.minutes) * 0.55 + (s.usage / 100) * 0.45;
      impact.I4 = i4 > 0.22 ? '\u25BC\u25BC\u25BC' : i4 > 0.12 ? '\u25BC\u25BC' : i4 > 0.05 ? '\u25BC' : '\u2014';

      // I5: Tempo & Efficiency
      var i5 = (s.points / tt.points) * 0.60 + (s.fbp / Math.max(tt.fbp, 1)) * 0.40;
      impact.I5 = i5 > 0.22 ? '\u25BC\u25BC' : i5 > 0.10 ? '\u25BC' : '\u2014';

      impacts.push(impact);
      aggregated.I1 += dg(impact.I1);
      aggregated.I2 += dg(impact.I2);
      aggregated.I3 += dg(impact.I3);
      aggregated.I4 += dg(impact.I4);
      aggregated.I5 += dg(impact.I5);
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
      var pos = resolveDepthPositions(ownDepth);
      pos.forEach(function(p) {
        var pls = Array.isArray(p.players) ? p.players : [];
        depthPos.push({
          position: p.name || p.position || '?',
          depth1: pls.find(function(x) { return x.depth === 1 || x.depth === '1'; }),
          depth2: pls.find(function(x) { return x.depth === 2 || x.depth === '2'; })
        });
      });
    }

    siaData.impacts.forEach(function(impact) {
      if (!impact.name) return;
      var posEntry = null;
      for (var i = 0; i < depthPos.length; i++) {
        var d1 = depthPos[i].depth1;
        if (d1 && (d1.full_name || d1.name || '').toLowerCase() === impact.name.toLowerCase()) {
          posEntry = depthPos[i]; break;
        }
      }
      if (!posEntry || !posEntry.depth2) return;
      var backupName = posEntry.depth2.full_name || posEntry.depth2.name || '?';

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
    else if (delta >= 3) { label = 'PYTH WARNING (OVER): +' + delta + ' wins above — conviction downgrade in close games'; }
    return { actual: actW, losses: t.losses || 0, gp: gp, expected: expW, delta: delta, cap: cap, label: label };
  }

  result.home = calc(homeAlias);
  result.away = calc(awayAlias);
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. BHV + CHAOS RISK
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
      var positions = resolveDepthPositions(depth);
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
// 8. APPLY ADJUSTMENTS — Redistribution + SRM → final indicator caps
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

    // Convert to caps
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
// 8b. FLOOR SCORE — Guaranteed minimum for each team from opponent's SIA caps
// ══════════════════════════════════════════════════════════════════════════════

function computeFloorScores(finalCaps, depletion) {
  var W = { I1: 0.25, I2: 0.25, I3: 0.20, I4: 0.20, I5: 0.10 };
  var floors = { home: null, away: null };

  // For each side, compute their guaranteed floor considering BOTH teams' caps
  // Key logic: if BOTH teams capped at 0 on same indicator → contested (0.5), not a free win
  ['home', 'away'].forEach(function(side) {
    var oppSide = side === 'home' ? 'away' : 'home';
    var oppCaps = finalCaps[oppSide] && finalCaps[oppSide].caps;
    var ownCaps = finalCaps[side] && finalCaps[side].caps;
    if (!oppCaps && !ownCaps) return;

    var hasAnyCap = false;
    if (oppCaps) ['I1','I2','I3','I4','I5'].forEach(function(ind) { if (oppCaps[ind] !== null && oppCaps[ind] !== undefined) hasAnyCap = true; });
    if (ownCaps) ['I1','I2','I3','I4','I5'].forEach(function(ind) { if (ownCaps[ind] !== null && ownCaps[ind] !== undefined) hasAnyCap = true; });
    if (!hasAnyCap) return;

    var floor = 0;
    var details = [];
    ['I1','I2','I3','I4','I5'].forEach(function(ind) {
      var oppCap = oppCaps ? oppCaps[ind] : null;
      var ownCap = ownCaps ? ownCaps[ind] : null;
      var myMin;

      // Both teams gutted on this indicator → contested
      if (oppCap === 0.0 && ownCap === 0.0) {
        myMin = 0.5;
        details.push(ind + '=0.5 (BOTH capped 0.0 — contested)');
      }
      // Own team gutted → lose the indicator
      else if (ownCap === 0.0) {
        myMin = 0.0;
        details.push(ind + '=0.0 (own capped 0.0 — lose)');
      }
      // Opponent gutted, own uncapped → guaranteed win
      else if (oppCap === 0.0 && (ownCap === null || ownCap === undefined)) {
        myMin = 1.0;
        details.push(ind + '=1.0 (opp capped 0.0, own healthy)');
      }
      // Opponent gutted, own limited → can't fully exploit
      else if (oppCap === 0.0 && ownCap === 0.5) {
        myMin = 0.5;
        details.push(ind + '=0.5 (opp capped 0.0, own capped 0.5)');
      }
      // Opponent limited → at least contested
      else if (oppCap === 0.5) {
        myMin = 0.5;
      }
      // Own limited but opponent uncapped → contested at best
      else if (ownCap === 0.5) {
        myMin = 0.5;
      }
      // No relevant caps → contested baseline
      else {
        myMin = 0.5;
      }
      floor += myMin * W[ind];
    });

    // Round to 3 decimal places
    floor = Math.round(floor * 1000) / 1000;

    // Apply own depletion ceiling — floor can't exceed own ceiling
    var ceiling = depletion[side] ? depletion[side].ceiling : 1.0;
    if (floor > ceiling) floor = ceiling;

    // Only report floor if it's meaningfully above baseline (0.50)
    if (details.length > 0) {
      floors[side] = { floor: floor, details: details, verdict: floor >= 0.90 ? 'DOMINANT' : floor >= 0.75 ? 'STRONG' : floor >= 0.60 ? 'EARNED' : floor >= 0.45 ? 'NO EDGE' : 'WAIT' };
    }
  });

  return floors;
}

// ══════════════════════════════════════════════════════════════════════════════
// 9. FORMAT PRE-COMPUTED ASSESSMENT
// ══════════════════════════════════════════════════════════════════════════════

function formatPreComputed(homeAlias, awayAlias, rosterAudit, sia, finalCaps, redistribution, srm, depletion, pyth, bhv, floorScores) {
  var L = [];
  L.push('=== PRE-COMPUTED STRUCTURAL ASSESSMENT (server-side \u2014 DO NOT OVERRIDE) ===');
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
        L.push('    Impact: I1:' + imp.I1 + ' I2:' + imp.I2 + ' I3:' + imp.I3 + ' I4:' + imp.I4 + ' I5:' + imp.I5);
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
        if (fc.caps[ind] !== null && fc.caps[ind] !== undefined) cArr.push(ind + ' capped at ' + fc.caps[ind]);
      });
      if (cArr.length > 0) {
        L.push('  NET CAPS: ' + cArr.join(' | '));
        L.push('  RULE: ' + alias + ' CANNOT score above these caps. Pre-computed from production data \u2014 not negotiable.');
      }
    }
    if (depletion[side]) {
      L.push('  DEPLETION GATE: ' + depletion[side].label + ' (' + depletion[side].count + ' rotation players OUT)');
      L.push('  HARD CEILING: ' + alias + ' control score cannot exceed ' + depletion[side].ceiling);
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
  // Floor scores — guaranteed minimums from opponent SIA caps
  var hasFloor = false;
  ['away', 'home'].forEach(function(side) {
    var alias = side === 'home' ? homeAlias : awayAlias;
    var f = floorScores && floorScores[side];
    if (f) {
      hasFloor = true;
      L.push('FLOOR SCORE: ' + alias + ' MINIMUM ' + f.floor.toFixed(3) + ' (' + f.verdict + ' guaranteed)');
      L.push('  Basis: ' + f.details.join(' | '));
      L.push('  RULE: ' + alias + ' control score CANNOT be below ' + f.floor.toFixed(2) + '. This is mathematically guaranteed by opponent SIA caps.');
    }
  });
  if (hasFloor) L.push('');

  L.push('=== END PRE-COMPUTED ASSESSMENT \u2014 Score indicators WITHIN these caps ===');
  return L.join('\n');
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
    'INDICATORS (weighted): I1 Possession & Transition (25%) \u2014 TO margin, steals, OREBs, POT, SCP, FBP. I2 Rim Pressure & Foul (25%) \u2014 paint pts, at-rim rates, FTA, blocks. I3 Shot Quality & Creation (20%) \u2014 assist ratio, eFG%, shot zones. I4 Lineup Integrity (20%) \u2014 bench depth, biggest lead, win/loss delta. I5 Tempo & Efficiency (10%) \u2014 pace, pts/possession.',
    '',
    'Each scored 1.0 (clear edge), 0.5 (contested), 0.0 (opponent). Control: 0.90+ DOMINANT | 0.75-0.89 STRONG | 0.60-0.74 EARNED | 0.45-0.59 NO EDGE | <0.45 WAIT.',
    '',
    'CRITICAL \u2014 PRE-COMPUTED STRUCTURAL ASSESSMENT:',
    'The server has pre-computed a Structural Impact Assessment (SIA) with indicator caps for teams with OUT players. These are HARD LIMITS from actual production data. You MUST:',
    '1. Read the SIA section FIRST before scoring ANY indicator',
    '2. NEVER score an indicator above its pre-computed cap for a depleted team',
    '3. If a DEPLETION GATE ceiling is set, your final control score CANNOT exceed it',
    '4. Redistribution and System Resilience adjustments are ALREADY applied \u2014 do not double-count',
    '5. Show the full SIA in your AVAILABILITY section with per-player impact notation',
    '6. When season team stats conflict with SIA caps, the caps win \u2014 season stats include production from OUT players',
    '7. If a FLOOR SCORE is provided for a team, that team CANNOT score below the floor. The floor is mathematically guaranteed by opponent SIA caps.',
    '8. NOTE: The client will recompute the weighted control score from your individual I1-I5 scores. Focus on scoring each indicator accurately \u2014 do not worry about the weighted arithmetic.',
    '',
    'Compute from the data: Context-Adjusted Strength, Structural Identity, Shot Diet, Win/Loss Delta, Comeback Score (0-10), Lead-Keep Score (0-10), Foul Resilience.',
    'BHV, Chaos Risk, and Pythagorean are pre-computed \u2014 use provided values.',
    '',
    '3PT VULNERABILITY PROFILE (both teams): NON-SHOOTERS (<33% or <1.5 3PA/gm), VOLATILE (33-38% on 3+ att/gm). Name 2-3 per team.',
    '',
    'ML THRESHOLD (if odds provided): Convert control score to FWP. ML THRESHOLD = ML where MIP is 5%+ below FWP.',
    '',
    'OUTPUT FORMAT (PLAIN TEXT ONLY \u2014 no Markdown. Do not use ** for bold, # for headers, or * for bullets. Use \u2501 lines, \u26A0 \u2713 \u2705 \u274C emoji, and ALL CAPS for section headers instead.):',
    'COMPACT THESIS \u2014 [AWAY] vs [HOME] | [Time] MST',
    '[Date] | [Venue]',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'AVAILABILITY',
    '[TEAM] [Player] \u2705 IN | [Player] \u274C OUT | [Player] \u26A0\uFE0F GTD/QUESTIONABLE/DOUBTFUL',
    '[TEAM] [Player] \u2705 IN | [Player] \u274C OUT | ...',
    '',
    'SIA (from pre-computed assessment):',
    '[Player] OUT \u2014 [stat line] \u2014 I1:[impact] I2:[impact] I3:[impact] I4:[impact] I5:[impact]',
    'ADJUSTMENTS: [any redistribution or SRM notes]',
    'NET CAPS: [indicator caps]',
    'DEPLETION GATE: [if applicable]',
    '',
    'REST [TEAM A] X day | [TEAM B] X day',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'CONTROL SCORE: [Team] [X.XX] \u2014 [Verdict]',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'I1-I5 scored with 1-line reasons (respecting SIA caps)',
    '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501',
    'SHOT DIET',
    '[TEAM]: [Interior/Transition | Perimeter/Creation | Balanced] \u2014 season 3PT% [X]% on [Y] 3PA/gm',
    '',
    '3PT HEATER WATCHLIST',
    '[TEAM]: [Player] ([szn 3PT%] on [vol]/gm) [NON-SHOOTER|VOLATILE]',
    '',
    'KEY FLAGS',
    '\u26A0 [Warning flag 1]',
    '\u26A0 [Warning flag 2]',
    '\u2713 [Clean read note if applicable]',
    '',
    'MARKET / ML THRESHOLD / ENTRY / PASS / CLUTCH GATE / WATCH'
  ].join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// DATA INTEGRITY DIAGNOSTIC — Checks every field path the compute layer needs
// ══════════════════════════════════════════════════════════════════════════════

function diagnoseData(analytical, homeAlias, awayAlias, matchup) {
  var report = { endpoints: {}, critical: [], warnings: [], summary: '' };
  var homeId = (matchup && matchup.homeId) || '';
  var awayId = (matchup && matchup.awayId) || '';

  function keys(obj, depth) {
    if (!obj || typeof obj !== 'object') return String(obj === null ? 'null' : typeof obj);
    if (depth <= 0) return Array.isArray(obj) ? '[Array(' + obj.length + ')]' : '{' + Object.keys(obj).length + ' keys}';
    if (Array.isArray(obj)) return '[Array(' + obj.length + ')' + (obj.length > 0 ? ' → ' + keys(obj[0], depth - 1) : '') + ']';
    var k = Object.keys(obj);
    if (k.length > 12) return '{' + k.slice(0, 12).join(', ') + '... (' + k.length + ' keys)}';
    return '{' + k.join(', ') + '}';
  }

  // ── INJURIES ──
  var inj = analytical.injuries;
  var injReport = { exists: !!inj, structure: keys(inj, 2) };
  if (inj) {
    injReport.topKeys = Object.keys(inj);
    injReport.hasTeams = Array.isArray(inj.teams);
    injReport.teamsCount = Array.isArray(inj.teams) ? inj.teams.length : 0;
    if (Array.isArray(inj.teams) && inj.teams.length > 0) {
      var sample = inj.teams[0];
      injReport.sampleTeamKeys = Object.keys(sample);
      injReport.sampleTeam = { alias: sample.alias, name: sample.name, market: sample.market, abbreviation: sample.abbreviation, abbr: sample.abbr, sr_id: sample.sr_id, hasPlayers: Array.isArray(sample.players), playerCount: (sample.players || []).length };
      if (sample.players && sample.players.length > 0) {
        var sp = sample.players[0];
        injReport.samplePlayerKeys = Object.keys(sp);
        // Dump ALL scalar values from sample player for field discovery
        var playerDump = {};
        Object.keys(sp).forEach(function(k) {
          var v = sp[k];
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) playerDump[k] = v;
          else if (typeof v === 'object' && v !== null) playerDump[k] = '{' + Object.keys(v).join(',') + '}';
        });
        injReport.samplePlayerDump = playerDump;
        injReport.samplePlayer = { full_name: sp.full_name, name: sp.name, status: sp.status, desc: sp.desc, comment: sp.comment, injury: sp.injury, primary_position: sp.primary_position, position: sp.position };
      }
    }
    // Check for nested structures (common SR pattern)
    if (inj.league && inj.league.teams) { injReport.nestedPath = 'league.teams'; injReport.nestedCount = inj.league.teams.length; }
    if (inj.season && inj.season.teams) { injReport.nestedPath = 'season.teams'; }

    // Find teams matching our aliases
    if (Array.isArray(inj.teams)) {
      var matched = inj.teams.filter(function(t) {
        return matchTeamSide(t, homeAlias, awayAlias, homeId, awayId) !== null;
      });
      injReport.matchedTeams = matched.map(function(t) {
        var side = matchTeamSide(t, homeAlias, awayAlias, homeId, awayId);
        return { side: side, id: t.id, name: t.name, market: t.market, players: (t.players || []).length };
      });
      var allStatuses = [];
      // RAW DUMP of first matched player — definitively identifies field structure
      if (matched.length > 0 && matched[0].players && matched[0].players.length > 0) {
        injReport.rawPlayerJSON = JSON.stringify(matched[0].players[0]).substring(0, 600);
        injReport.rawPlayerKeys = Object.keys(matched[0].players[0]);
      }
      matched.forEach(function(t) {
        (t.players || []).forEach(function(p) {
          var nm = p.full_name || p.name || '?';
          var injArr = Array.isArray(p.injuries) ? p.injuries : [];
          var latestInj = injArr.length > 0 ? injArr[0] : {};
          var st = latestInj.status || p.status || '??';
          var desc = latestInj.desc || '';
          allStatuses.push(nm + ':' + st + (desc ? '(' + desc + ')' : ''));
        });
      });
      injReport.matchedPlayerStatuses = allStatuses;
    }
  } else {
    report.critical.push('injuries: MISSING — analytical.injuries is falsy');
  }
  report.endpoints.injuries = injReport;

  // ── PROFILES ──
  ['home', 'away'].forEach(function(side) {
    var alias = side === 'home' ? homeAlias : awayAlias;
    var prof = analytical[side + 'Profile'];
    var profReport = { exists: !!prof, structure: keys(prof, 1) };
    if (prof) {
      profReport.topKeys = Object.keys(prof);
      profReport.hasPlayers = Array.isArray(prof.players);
      profReport.playerCount = (prof.players || []).length;
      if (prof.players && prof.players.length > 0) {
        var sp = prof.players[0];
        profReport.samplePlayer = { full_name: sp.full_name, status: sp.status, primary_position: sp.primary_position };
        // Count by status
        var counts = {};
        prof.players.forEach(function(p) { var s = p.status || '?'; counts[s] = (counts[s] || 0) + 1; });
        profReport.statusCounts = counts;
      }
    } else {
      report.critical.push(side + 'Profile: MISSING');
    }
    report.endpoints[side + 'Profile'] = profReport;
  });

  // ── STATS ──
  ['home', 'away'].forEach(function(side) {
    var alias = side === 'home' ? homeAlias : awayAlias;
    var stats = analytical[side + 'Stats'];
    var statsReport = { exists: !!stats, structure: keys(stats, 1) };
    if (stats) {
      statsReport.topKeys = Object.keys(stats);
      statsReport.hasOwnRecord = !!stats.own_record;
      statsReport.hasStatistics = !!(stats.statistics || (stats.own_record && stats.own_record.statistics));
      statsReport.hasOpponents = !!(stats.opponents || (stats.own_record && stats.own_record.opponents));
      var ts = getTeamStats(stats);
      statsReport.teamStatsKeys = Object.keys(ts).slice(0, 15);
      statsReport.teamStatsPoints = ts.points;
      statsReport.teamStatsSteals = ts.steals;
      var os = getOppStats(stats);
      statsReport.oppStatsKeys = Object.keys(os).slice(0, 10);
      statsReport.oppStatsPaint = os.points_in_the_paint;
      var players = getPlayers(stats);
      statsReport.playerCount = players.length;
      if (players.length > 0) {
        var sp = players[0];
        statsReport.samplePlayer = { full_name: sp.full_name, hasAverage: !!sp.average, averageKeys: sp.average ? Object.keys(sp.average).slice(0, 10) : [] };
      }
      if (players.length === 0) report.critical.push(side + 'Stats: 0 players found via getPlayers()');
    } else {
      report.critical.push(side + 'Stats: MISSING');
    }
    report.endpoints[side + 'Stats'] = statsReport;
  });

  // ── DEPTH CHARTS ──
  ['home', 'away'].forEach(function(side) {
    var depth = analytical[side + 'Depth'];
    var depthReport = { exists: !!depth, structure: keys(depth, 1) };
    if (depth) {
      depthReport.allKeys = Object.keys(depth);
      depthReport.topKeys = Object.keys(depth);
      // Check each key's type/shape for depth resolution debugging
      var keyTypes = {};
      Object.keys(depth).forEach(function(k) {
        var v = depth[k];
        if (Array.isArray(v)) keyTypes[k] = 'Array(' + v.length + ')' + (v.length > 0 && v[0] ? ' first:{' + Object.keys(v[0]).slice(0,5).join(',') + '}' : '');
        else if (v && typeof v === 'object') keyTypes[k] = 'Object{' + Object.keys(v).slice(0,5).join(',') + '}';
        else keyTypes[k] = typeof v;
      });
      depthReport.keyTypes = keyTypes;
      var pos = resolveDepthPositions(depth);
      depthReport.hasPositions = Array.isArray(depth.positions);
      depthReport.resolvedPositions = pos.length;
      depthReport.positionCount = pos.length;
      if (pos.length > 0) {
        depthReport.samplePosition = { name: pos[0].name, position: pos[0].position, playerCount: (pos[0].players || []).length };
        if (pos[0].players && pos[0].players.length > 0) {
          depthReport.sampleDepthPlayer = { full_name: pos[0].players[0].full_name, name: pos[0].players[0].name, depth: pos[0].players[0].depth };
        }
      }
      if (pos.length === 0) report.warnings.push(side + 'Depth: 0 positions found');
    } else {
      report.warnings.push(side + 'Depth: MISSING');
    }
    report.endpoints[side + 'Depth'] = depthReport;
  });

  // ── STANDINGS ──
  var stnd = analytical.standings;
  var stndReport = { exists: !!stnd, structure: keys(stnd, 1) };
  if (stnd) {
    stndReport.topKeys = Object.keys(stnd);
    stndReport.hasConferences = Array.isArray(stnd.conferences);
    var teamCount = 0;
    (stnd.conferences || []).forEach(function(c) {
      (c.divisions || []).forEach(function(d) {
        teamCount += (d.teams || []).length;
      });
    });
    stndReport.totalTeams = teamCount;
    if (teamCount === 0) report.warnings.push('standings: 0 teams found in conferences.divisions.teams path');
  } else {
    report.warnings.push('standings: MISSING');
  }
  report.endpoints.standings = stndReport;

  // ── CROSS-REFERENCE: Can SIA match injury names to stat lines? ──
  var crossRef = { home: [], away: [] };
  ['home', 'away'].forEach(function(side) {
    var injTeams = (analytical.injuries && analytical.injuries.teams) || [];
    var alias = side === 'home' ? homeAlias : awayAlias;
    var teamInj = injTeams.find(function(t) { return matchTeamSide(t, homeAlias, awayAlias, homeId, awayId) === side; });
    if (!teamInj) { crossRef[side].push('No injury team found for ' + alias + ' (id:' + (side === 'home' ? homeId : awayId).substring(0,8) + ')'); return; }
    var outPlayers = (teamInj.players || []).filter(function(p) {
      var injArr = Array.isArray(p.injuries) ? p.injuries : [];
      var st = (injArr.length > 0 ? (injArr[0].status || '') : (p.status || '')).toUpperCase();
      return st === 'OUT' || st === 'O' || st === 'IR';
    });
    var statPlayers = getPlayers(analytical[side + 'Stats']);
    outPlayers.forEach(function(op) {
      var opName = (op.full_name || op.name || '?').toLowerCase();
      var found = statPlayers.some(function(sp) { return (sp.full_name || sp.name || '').toLowerCase() === opName; });
      crossRef[side].push(opName + ': stats ' + (found ? 'MATCHED' : 'NOT FOUND'));
    });
  });
  report.crossRef = crossRef;

  // ── SUMMARY ──
  var total = Object.keys(report.endpoints).length;
  var ok = Object.values(report.endpoints).filter(function(e) { return e.exists; }).length;
  report.summary = ok + '/' + total + ' endpoints present | ' + report.critical.length + ' critical | ' + report.warnings.length + ' warnings';

  return report;
}

// ══════════════════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════════════════

exports.handler = async function(event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'POST only' }) };

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };

  try {
    var body = JSON.parse(event.body);

    // Legacy thin-proxy mode (backward compat)
    if (body.systemPrompt && body.userPrompt) {
      var legResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4000, system: body.systemPrompt, messages: [{ role: 'user', content: body.userPrompt }] }),
      });
      if (!legResp.ok) { var e = await legResp.text(); return { statusCode: legResp.status, headers: headers, body: JSON.stringify({ error: 'Anthropic ' + legResp.status + ': ' + e.substring(0, 300) }) }; }
      var legData = await legResp.json();
      return { statusCode: 200, headers: headers, body: JSON.stringify({ thesis: legData.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n'), usage: legData.usage }) };
    }

    // ── Smart compute mode ──
    var matchup = body.matchup || {};
    var sections = body.sections || {};
    var analytical = body.analytical || {};
    var homeAlias = matchup.home || 'HOME';
    var awayAlias = matchup.away || 'AWAY';

    // ── PRE-COMPUTE ──
    var diagnostics = diagnoseData(analytical, homeAlias, awayAlias, matchup);
    var rosterAudit = computeRosterAudit(analytical, homeAlias, awayAlias, matchup);
    var sia = computeSIA(rosterAudit, analytical, homeAlias, awayAlias);
    var redistribution = computeRedistribution(rosterAudit, sia, analytical, homeAlias, awayAlias);
    var srm = computeSRM(rosterAudit, analytical);
    var finalCaps = applyAdjustments(sia, redistribution, srm);
    var depletion = computeDepletionGate(rosterAudit);
    var pyth = computePythagorean(analytical.standings, homeAlias, awayAlias);
    var bhv = computeBHV(analytical, homeAlias, awayAlias, rosterAudit);
    var floorScores = computeFloorScores(finalCaps, depletion);

    var preComputed = formatPreComputed(homeAlias, awayAlias, rosterAudit, sia, finalCaps, redistribution, srm, depletion, pyth, bhv, floorScores);

    // ── BUILD PROMPTS ──
    var systemPrompt = buildSystemPrompt();

    var userPrompt = 'Build a complete pre-game thesis for this NBA matchup.\n\n' +
      'MATCHUP: ' + awayAlias + ' @ ' + homeAlias + '\n' +
      'DATE: ' + (matchup.date || '?') + ' | TIME: ' + (matchup.time || '?') + ' MST\n' +
      'VENUE: ' + (matchup.venue || 'TBD') + '\n\n' +
      preComputed + '\n\n' +
      '=== INJURIES ===\n' + (sections.injuries || '(unavailable)') + '\n\n' +
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
      (sections.odds || '') + '\n' + (sections.tracking || '') + '\n' + (sections.clutch || '') + '\n\n' +
      'IMPORTANT: The PRE-COMPUTED STRUCTURAL ASSESSMENT contains HARD indicator caps. Score each indicator WITHIN those caps. If a depletion gate ceiling is set, your final control score CANNOT exceed it. Show full SIA notation in AVAILABILITY.\n\n' +
      'Output the compact thesis format.';

    // ── CALL SONNET ──
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4000, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
    });

    if (!resp.ok) {
      var errText = await resp.text();
      return { statusCode: resp.status, headers: headers, body: JSON.stringify({ error: 'Anthropic ' + resp.status + ': ' + errText.substring(0, 300) }) };
    }

    var data = await resp.json();
    var thesis = data.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');

    return {
      statusCode: 200, headers: headers,
      body: JSON.stringify({
        thesis: thesis, usage: data.usage,
        preComputed: {
          rosterAudit: { homeOut: rosterAudit.out.home.length, awayOut: rosterAudit.out.away.length,
            homeOutNames: rosterAudit.out.home.map(function(p) { return p.name; }),
            awayOutNames: rosterAudit.out.away.map(function(p) { return p.name; }) },
          siaCaps: { home: finalCaps.home.caps, away: finalCaps.away.caps },
          floorScores: floorScores,
          depletion: depletion, pyth: pyth, bhv: bhv,
          diagnostics: diagnostics
        }
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: err.message }) };
  }
};

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
        stats: null
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
      var pos = Array.isArray(ownDepth.positions) ? ownDepth.positions : Array.isArray(ownDepth) ? ownDepth : [];
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
// 9. FORMAT PRE-COMPUTED ASSESSMENT
// ══════════════════════════════════════════════════════════════════════════════

function formatPreComputed(homeAlias, awayAlias, rosterAudit, sia, finalCaps, redistribution, srm, depletion, pyth, bhv) {
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
    var rosterAudit = computeRosterAudit(analytical, homeAlias, awayAlias);
    var sia = computeSIA(rosterAudit, analytical, homeAlias, awayAlias);
    var redistribution = computeRedistribution(rosterAudit, sia, analytical, homeAlias, awayAlias);
    var srm = computeSRM(rosterAudit, analytical);
    var finalCaps = applyAdjustments(sia, redistribution, srm);
    var depletion = computeDepletionGate(rosterAudit);
    var pyth = computePythagorean(analytical.standings, homeAlias, awayAlias);
    var bhv = computeBHV(analytical, homeAlias, awayAlias, rosterAudit);

    var preComputed = formatPreComputed(homeAlias, awayAlias, rosterAudit, sia, finalCaps, redistribution, srm, depletion, pyth, bhv);

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
          depletion: depletion, pyth: pyth, bhv: bhv
        }
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: err.message }) };
  }
};

// Live Game Analysis via Claude Sonnet - Predictive Layer v4.0
// v4.0: Lead Composition engine, guardrails-based entry logic, bidirectional team-named signals, FLIPPED thesis status
// v3.1: 3PT Sustainability Audit (personnel, Bayesian regression, shot type, tiered output)

// ══════════════════════════════════════════════════════════════════════════════
// 3PT SUSTAINABILITY AUDIT ENGINE
// ══════════════════════════════════════════════════════════════════════════════

function computeSustainabilityAudit(summaryData, trackingData, homeTeam, awayTeam) {
  if (!summaryData) return null;

  function auditTeam(teamData, oppData, teamAlias, tracking) {
    if (!teamData) return null;
    var stats = teamData.statistics || {};
    var players = teamData.players || [];

    // ── Team-level live 3PT ──
    var team3PM = stats.three_points_made || 0;
    var team3PA = stats.three_points_att || 0;
    var teamFGA = stats.field_goals_att || 1;
    var live3Pct = team3PA > 0 ? (team3PM / team3PA * 100) : 0;
    var live3Rate = (team3PA / teamFGA * 100);

    // ── Team season 3PT baseline from player averages ──
    var seasonPrior3Pct = 36.0; // NBA average fallback
    var gotSeasonData = false;
    var seasonTot3PM = 0, seasonTot3PA = 0;
    players.forEach(function(p) {
      var avg = p.average || p.season || {};
      var m = avg.three_points_made || avg.fg3m || 0;
      var a = avg.three_points_att || avg.fg3a || 0;
      seasonTot3PM += m;
      seasonTot3PA += a;
    });
    if (seasonTot3PA >= 5) {
      seasonPrior3Pct = seasonTot3PM / seasonTot3PA * 100;
      gotSeasonData = true;
    }

    // ── PERSONNEL AUDIT ──
    var personnelDetails = [];
    var makesByTier = { elite: 0, average: 0, non: 0 };
    var attByTier = { elite: 0, average: 0, non: 0 };

    players.forEach(function(p) {
      var live = p.statistics || {};
      var avg = p.average || p.season || {};
      var live3m = live.three_points_made || 0;
      var live3a = live.three_points_att || 0;
      if (live3a < 2) return;

      var szn3m = avg.three_points_made || avg.fg3m || 0;
      var szn3a = avg.three_points_att || avg.fg3a || 0;
      var sznPct = szn3a >= 1.0 ? (szn3m / szn3a * 100) : null;
      var sznVol = szn3a;

      var tier, tierLabel;
      if (sznPct === null) {
        tier = 'non'; tierLabel = 'UNKNOWN';
      } else if (sznPct >= 38.0 && sznVol >= 2.0) {
        tier = 'elite'; tierLabel = 'ELITE';
      } else if (sznPct >= 33.0 || (sznPct >= 30.0 && sznVol >= 3.0)) {
        tier = 'average'; tierLabel = 'AVERAGE';
      } else {
        tier = 'non'; tierLabel = 'NON-SHOOTER';
      }

      // Low-volume overrides
      if (sznVol < 1.5 && tier === 'elite') { tier = 'average'; tierLabel = 'AVG (low vol)'; }
      if (sznVol < 0.8 && tier !== 'non') { tier = 'non'; tierLabel = 'NON-SHOOTER (rare)'; }

      makesByTier[tier] += live3m;
      attByTier[tier] += live3a;

      var livePct = (live3m / live3a * 100).toFixed(0);
      var sznStr = sznPct !== null ? sznPct.toFixed(1) + '% (' + sznVol.toFixed(1) + '/gm)' : 'N/A';
      var hot = sznPct !== null && (live3m / live3a * 100) > sznPct + 12;

      personnelDetails.push({
        name: p.full_name || p.name || '?',
        live3m: live3m, live3a: live3a, livePct: livePct,
        sznPct: sznPct, sznVol: sznVol, sznStr: sznStr,
        tier: tier, tierLabel: tierLabel, hot: hot,
      });
    });

    var totalMakes = team3PM || 1;
    var elitePct = (makesByTier.elite / totalMakes * 100);
    var nonPct = (makesByTier.non / totalMakes * 100);

    var personnelGrade;
    if (elitePct >= 70) personnelGrade = 'LOCKED IN';
    else if (elitePct >= 50 && nonPct <= 20) personnelGrade = 'DURABLE';
    else if (nonPct >= 50) personnelGrade = 'UNSUSTAINABLE';
    else if (nonPct >= 35) personnelGrade = 'FRAGILE';
    else personnelGrade = 'MIXED';

    // ── BAYESIAN REGRESSION MODEL ──
    var priorStrength = 30; // ~1 game of 3PA as prior weight
    var priorAlpha = seasonPrior3Pct / 100 * priorStrength;
    var priorBeta = (1 - seasonPrior3Pct / 100) * priorStrength;
    var posteriorAlpha = priorAlpha + team3PM;
    var posteriorBeta = priorBeta + (team3PA - team3PM);
    var posteriorMean = posteriorAlpha / (posteriorAlpha + posteriorBeta) * 100;

    var deviation = live3Pct - seasonPrior3Pct;

    // Regression pull: how far posterior moved from observed toward prior
    var regressionPull = 0;
    if (team3PA > 0 && Math.abs(live3Pct - seasonPrior3Pct) > 0.5) {
      regressionPull = Math.abs(posteriorMean - live3Pct) / Math.abs(live3Pct - seasonPrior3Pct) * 100;
    }
    regressionPull = Math.min(100, Math.max(0, regressionPull));

    // Regression probability: base rate from sample size, adjusted by deviation
    var regressionProb;
    if (team3PA <= 8) regressionProb = 85;
    else if (team3PA <= 14) regressionProb = 70;
    else if (team3PA <= 20) regressionProb = 55;
    else if (team3PA <= 28) regressionProb = 40;
    else regressionProb = 25;

    if (deviation > 15) regressionProb = Math.min(95, regressionProb + 15);
    else if (deviation > 8) regressionProb = Math.min(95, regressionProb + 8);
    else if (deviation > 3) regressionProb = Math.min(95, regressionProb + 3);
    else if (deviation < -8) regressionProb = Math.max(5, regressionProb - 15);
    else if (deviation < -3) regressionProb = Math.max(5, regressionProb - 8);

    var regressionGrade;
    if (regressionProb >= 75) regressionGrade = 'HIGH';
    else if (regressionProb >= 55) regressionGrade = 'MODERATE';
    else if (regressionProb >= 35) regressionGrade = 'LOW';
    else regressionGrade = 'MINIMAL';

    // ── SHOT TYPE CONTEXT ──
    var shotTypeGrade = 'UNKNOWN';
    var shotTypeNote = '';
    var teamAssists = stats.assists || 0;
    var teamFGM = stats.field_goals_made || 1;
    var assistRatio = teamAssists / teamFGM * 100;

    if (tracking) {
      var cas = tracking.catchAndShoot || {};
      var pu = tracking.pullUp || {};
      var casEfg = cas.efg || cas.fg3pct || null;
      var puEfg = pu.efg || pu.fg3pct || null;

      if (casEfg !== null && puEfg !== null) {
        if (assistRatio >= 60 && casEfg >= 38) {
          shotTypeGrade = 'DURABLE';
          shotTypeNote = 'High ast% (' + assistRatio.toFixed(0) + '%) + strong C&S baseline (' + casEfg + '%)';
        } else if (assistRatio < 45 && puEfg < 35) {
          shotTypeGrade = 'FRAGILE';
          shotTypeNote = 'Low ast% (' + assistRatio.toFixed(0) + '%) + weak pull-up baseline (' + puEfg + '%)';
        } else if (assistRatio >= 50) {
          shotTypeGrade = 'MIXED';
          shotTypeNote = 'Moderate ast% (' + assistRatio.toFixed(0) + '%) — C&S ' + casEfg + '% / Pull-up ' + puEfg + '%';
        } else {
          shotTypeGrade = 'FRAGILE';
          shotTypeNote = 'Pull-up heavy (' + assistRatio.toFixed(0) + '% ast) — pull-up baseline ' + puEfg + '%';
        }
      } else {
        if (assistRatio >= 65) { shotTypeGrade = 'DURABLE'; shotTypeNote = 'High ast% (' + assistRatio.toFixed(0) + '%) suggests C&S'; }
        else if (assistRatio < 45) { shotTypeGrade = 'FRAGILE'; shotTypeNote = 'Low ast% (' + assistRatio.toFixed(0) + '%) suggests pull-up/iso'; }
        else { shotTypeGrade = 'MIXED'; shotTypeNote = 'Moderate ast% (' + assistRatio.toFixed(0) + '%)'; }
      }
    } else {
      if (assistRatio >= 65) { shotTypeGrade = 'DURABLE'; shotTypeNote = 'High ast% (' + assistRatio.toFixed(0) + '%)'; }
      else if (assistRatio < 45) { shotTypeGrade = 'FRAGILE'; shotTypeNote = 'Low ast% (' + assistRatio.toFixed(0) + '%)'; }
      else { shotTypeGrade = 'MIXED'; shotTypeNote = 'Moderate ast% (' + assistRatio.toFixed(0) + '%)'; }
    }

    // ── COMPOSITE TIER ──
    var scores = { personnel: 0, regression: 0, shotType: 0 };

    if (personnelGrade === 'LOCKED IN') scores.personnel = 0;
    else if (personnelGrade === 'DURABLE') scores.personnel = 0.5;
    else if (personnelGrade === 'MIXED') scores.personnel = 1;
    else if (personnelGrade === 'FRAGILE') scores.personnel = 1.5;
    else scores.personnel = 2;

    if (regressionGrade === 'MINIMAL') scores.regression = 0;
    else if (regressionGrade === 'LOW') scores.regression = 0.5;
    else if (regressionGrade === 'MODERATE') scores.regression = 1;
    else scores.regression = 2;

    if (shotTypeGrade === 'LOCKED IN' || shotTypeGrade === 'DURABLE') scores.shotType = 0;
    else if (shotTypeGrade === 'MIXED') scores.shotType = 1;
    else scores.shotType = 2;

    // Weighted: personnel 40%, regression 35%, shot type 25%
    var composite = scores.personnel * 0.40 + scores.regression * 0.35 + scores.shotType * 0.25;

    var tier;
    if (composite <= 0.3) tier = 'LOCKED IN';
    else if (composite <= 0.7) tier = 'DURABLE';
    else if (composite <= 1.1) tier = 'MIXED';
    else if (composite <= 1.5) tier = 'FRAGILE';
    else tier = 'UNSUSTAINABLE';

    // ── Override: at/below season norm = not a sustainability concern ──
    if (live3Pct <= seasonPrior3Pct + 2) {
      tier = 'LOCKED IN';
      regressionGrade = 'MINIMAL';
      personnelGrade = 'N/A (at baseline)';
    }

    // ── Override: too few attempts ──
    if (team3PA < 5) tier = 'TOO EARLY';

    return {
      teamAlias: teamAlias,
      live3PM: team3PM, live3PA: team3PA,
      live3Pct: live3Pct.toFixed(1), live3Rate: live3Rate.toFixed(1),
      seasonPrior: seasonPrior3Pct.toFixed(1), gotSeasonData: gotSeasonData,
      deviation: deviation.toFixed(1),
      personnelGrade: personnelGrade, personnelDetails: personnelDetails,
      elitePct: elitePct.toFixed(0), nonPct: nonPct.toFixed(0),
      posteriorMean: posteriorMean.toFixed(1),
      regressionPull: regressionPull.toFixed(0),
      regressionProb: regressionProb, regressionGrade: regressionGrade,
      shotTypeGrade: shotTypeGrade, shotTypeNote: shotTypeNote,
      assistRatio: assistRatio.toFixed(0),
      composite: composite.toFixed(2), tier: tier,
    };
  }

  return {
    home: auditTeam(summaryData.home, summaryData.away, homeTeam, trackingData ? trackingData.home : null),
    away: auditTeam(summaryData.away, summaryData.home, awayTeam, trackingData ? trackingData.away : null),
  };
}

function formatSustainabilityAudit(audit) {
  if (!audit) return '';

  function formatTeam(t) {
    if (!t) return '';
    if (t.tier === 'TOO EARLY') return t.teamAlias + ': ' + t.live3PM + '/' + t.live3PA + ' 3PT — TOO EARLY (< 5 attempts)\n';

    var out = t.teamAlias + ': ' + t.live3PM + '/' + t.live3PA + ' (' + t.live3Pct + '%) vs season ' + t.seasonPrior + '%'
      + (t.gotSeasonData ? '' : ' [NBA avg fallback]') + '\n';

    if (t.personnelGrade === 'N/A (at baseline)') {
      out += '  Personnel: N/A — shooting at/below baseline\n';
    } else {
      out += '  Personnel: ' + t.elitePct + '% makes from ELITE, ' + t.nonPct + '% from NON-SHOOTERS — ' + t.personnelGrade + '\n';
      t.personnelDetails.forEach(function(p) {
        out += '    ' + p.name + ': ' + p.live3m + '/' + p.live3a + ' (' + p.livePct + '%) vs szn ' + p.sznStr + ' [' + p.tierLabel + ']' + (p.hot ? ' HOT' : '') + '\n';
      });
    }

    out += '  Regression: prior ' + t.seasonPrior + '% | posterior ' + t.posteriorMean + '% | pull ' + t.regressionPull + '% — ' + t.regressionGrade + ' (' + t.regressionProb + '%)\n';
    out += '  Shot type: ' + t.shotTypeNote + ' — ' + t.shotTypeGrade + '\n';
    out += '  -> TIER: ' + t.tier + ' (composite ' + t.composite + ')\n';
    return out;
  }

  return '\n3PT SUSTAINABILITY AUDIT:\n' + formatTeam(audit.away) + formatTeam(audit.home);
}

// ══════════════════════════════════════════════════════════════════════════════
// LEAD COMPOSITION ENGINE
// ══════════════════════════════════════════════════════════════════════════════

function computeLeadComposition(summaryData, homeTeam, awayTeam, audit) {
  if (!summaryData) return null;

  function composeTeam(teamData, alias) {
    if (!teamData) return null;
    var stats = teamData.statistics || {};
    var totalPts = stats.points || 0;
    if (totalPts === 0) return null;

    var rawPaint = stats.points_in_the_paint || 0;
    var atRimPts = (stats.field_goals_at_rim_made || 0) * 2;
    var paintPts = Math.max(rawPaint, atRimPts);
    var ftPts = stats.free_throws_made || 0;
    var threePts = (stats.three_points_made || 0) * 3;
    var fbPts = stats.fast_break_points || 0;
    var potPts = stats.points_off_turnovers || 0;
    var scPts = stats.second_chance_points || 0;
    var midOther = Math.max(0, totalPts - paintPts - ftPts - threePts);
    var structural = paintPts + ftPts;
    var variance = threePts + midOther;

    return {
      team: alias, total: totalPts, paint: paintPts, ft: ftPts, three: threePts,
      midOther: midOther, transition: fbPts, pot: potPts, secondChance: scPts,
      structural: structural, variance: variance,
      structuralPct: totalPts > 0 ? Math.round(structural / totalPts * 100) : 0,
      variancePct: totalPts > 0 ? Math.round(variance / totalPts * 100) : 0,
    };
  }

  var home = composeTeam(summaryData.home, homeTeam);
  var away = composeTeam(summaryData.away, awayTeam);
  if (!home || !away) return null;

  var margin = home.total - away.total;
  var absMargin = Math.abs(margin);
  var leadTeam = margin >= 0 ? homeTeam : awayTeam;
  var trailTeam = margin >= 0 ? awayTeam : homeTeam;
  var structuralMargin = (margin >= 0 ? 1 : -1) * (home.structural - away.structural);
  var varianceMargin = (margin >= 0 ? 1 : -1) * (home.variance - away.variance);

  // Get lead team sustainability tier
  var leadIsHome = margin >= 0;
  var leadSust = audit ? (leadIsHome ? audit.home : audit.away) : null;
  var leadTier = (leadSust && leadSust.tier ? leadSust.tier : '').toUpperCase();

  var classification = 'MIXED';
  var durability;

  if (absMargin <= 2) {
    classification = 'EVEN';
    durability = 'EVEN — margin too small to classify';
  } else if (structuralMargin >= absMargin * 0.6) {
    classification = 'STRUCTURAL';
    durability = leadTeam + ' lead is STRUCTURAL — paint/FT drives margin (+' + Math.abs(structuralMargin) + ')';
  } else if (varianceMargin >= absMargin * 0.6) {
    if (leadTier === 'LOCKED' || leadTier === 'LOCKED IN') {
      classification = 'IDENTITY';
      durability = leadTeam + ' lead is IDENTITY — perimeter production at season baseline (' + leadTier + '). Offensive identity, not variance.';
    } else if (leadTier === 'DURABLE') {
      classification = 'HOT';
      durability = leadTeam + ' lead is HOT — above baseline but credible shooters (' + leadTier + '). Elevated but sustainable.';
    } else if (leadTier === 'MIXED') {
      classification = 'MIXED';
      durability = 'MIXED — 3PT/mid drives margin with uncertain sustainability (' + leadTier + '). Structural favors ' + (structuralMargin < 0 ? trailTeam : leadTeam) + ' (' + (structuralMargin >= 0 ? '+' : '') + structuralMargin + ')';
    } else if (leadTier === 'FRAGILE' || leadTier === 'UNSUSTAINABLE') {
      classification = 'VOLATILE';
      durability = leadTeam + ' lead is VOLATILE — perimeter production ' + leadTier + '. Structural favors ' + (structuralMargin < 0 ? trailTeam : leadTeam) + ' (' + (structuralMargin >= 0 ? '+' : '') + structuralMargin + '). Entry signal for trailing team.';
    } else {
      // TOO EARLY, empty, null — default to MIXED
      classification = 'MIXED';
      durability = 'MIXED — 3PT/mid drives margin but sustainability data insufficient' + (leadTier ? ' (' + leadTier + ')' : '') + '.';
    }
  } else {
    classification = 'MIXED';
    durability = 'MIXED — no single source dominates margin';
  }

  return {
    home: home, away: away,
    margin: margin, absMargin: absMargin,
    leadTeam: leadTeam, trailTeam: trailTeam,
    structuralMargin: structuralMargin, varianceMargin: varianceMargin,
    durability: durability, classification: classification,
  };
}

function formatLeadComposition(comp) {
  if (!comp) return '';
  var h = comp.home, a = comp.away;

  var out = '\nLEAD COMPOSITION: ' + a.team + ' ' + a.total + ' — ' + h.team + ' ' + h.total + ' (' + comp.leadTeam + ' ' + (comp.margin >= 0 ? '+' : '') + comp.margin + ')\n';

  out += a.team + ': Paint ' + a.paint + ' (' + Math.round(a.paint/a.total*100) + '%) | FT ' + a.ft + ' | 3PT ' + a.three + ' (' + Math.round(a.three/a.total*100) + '%) | Mid ' + a.midOther + ' | Trans ' + a.transition + '\n';
  out += h.team + ': Paint ' + h.paint + ' (' + Math.round(h.paint/h.total*100) + '%) | FT ' + h.ft + ' | 3PT ' + h.three + ' (' + Math.round(h.three/h.total*100) + '%) | Mid ' + h.midOther + ' | Trans ' + h.transition + '\n';

  out += 'Structural (Paint+FT): ' + a.team + ' ' + a.structural + ' (' + a.structuralPct + '%) vs ' + h.team + ' ' + h.structural + ' (' + h.structuralPct + '%) = ' + (comp.structuralMargin >= 0 ? comp.leadTeam : comp.trailTeam) + ' +' + Math.abs(comp.structuralMargin) + '\n';
  out += 'Variance (3PT+Mid): ' + a.team + ' ' + a.variance + ' (' + a.variancePct + '%) vs ' + h.team + ' ' + h.variance + ' (' + h.variancePct + '%) = ' + (comp.varianceMargin >= 0 ? comp.leadTeam : comp.trailTeam) + ' +' + Math.abs(comp.varianceMargin) + '\n';
  out += 'MARGIN DURABILITY: ' + comp.durability + '\n';

  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ══════════════════════════════════════════════════════════════════════════════

var SYSTEM_PROMPT = 'You are an elite NBA live-game analyst providing real-time control assessment and outcome prediction for sports betting.\n\n'
+ 'CORE TASK: Determine which team structurally controls this game, assess whether each team\'s production is sustainable, evaluate whether control is compounding or fading, and identify the best entry — on EITHER team — using pre-computed data and your own reasoning.\n\n'
+ 'FIVE INDICATORS (score each 0.00-1.00 for the controlling team):\n'
+ 'I1 Possession & Transition (25%): TO margin, steals, OREBs, fast break pts, pts off TOs, second chance pts\n'
+ 'I2 Rim Pressure & Foul (25%): Paint points, at-rim FG, FTA, blocks, fouls, bonus status\n'
+ 'I3 Shot Quality & Creation (20%): eFG%, assist ratio (65%+ sustainable, <50% isolation-dependent), shot diet\n'
+ 'I4 Lineup Integrity (20%): Biggest lead, bench contribution, which lineups producing, plus/minus\n'
+ 'I5 Tempo & Efficiency (10%): Possessions, pts/possession differential, pace control\n\n'
+ 'CONTROL: 0.90+ DOMINANT | 0.75-0.89 STRONG | 0.60-0.74 EARNED | 0.45-0.59 NO EDGE | <0.45 WAIT\n\n'
+ 'YOU RECEIVE PRE-COMPUTED DATA LAYERS:\n\n'
+ '1. 3PT SUSTAINABILITY AUDIT (per team):\n'
+ '   - PERSONNEL AUDIT: What % of 3PM came from ELITE (38%+ season) vs NON-SHOOTERS (<33%)\n'
+ '   - BAYESIAN REGRESSION: Sample-size-aware posterior expected 3PT% and regression probability\n'
+ '   - SHOT TYPE: Assist ratio proxy — catch-and-shoot (durable) vs pull-up/isolation (fragile)\n'
+ '   - COMPOSITE TIER: LOCKED IN / DURABLE / MIXED / FRAGILE / UNSUSTAINABLE\n\n'
+ '2. SCORING COMPOSITION (both teams):\n'
+ '   - Structural points (Paint + FT) vs Perimeter points (3PT + Mid-range)\n'
+ '   - CLASSIFICATION (pre-computed, cross-references sustainability tier):\n'
+ '     STRUCTURAL = paint/FT drives margin. Most durable.\n'
+ '     IDENTITY = perimeter drives margin but sustainability LOCKED — this is the team\'s offensive identity executing. Durable.\n'
+ '     HOT = perimeter drives margin, sustainability DURABLE — above baseline but credible. Elevated but sustainable.\n'
+ '     MIXED = no clear dominance or uncertain sustainability.\n'
+ '     VOLATILE = perimeter drives margin, sustainability FRAGILE/UNSUSTAINABLE — regression coming. Entry signal for trailing team.\n'
+ '     EVEN = margin too small to classify.\n'
+ '   CRITICAL: IDENTITY and HOT leads should NOT trigger entry signals for the trailing team. Only VOLATILE leads indicate regression opportunity.\n\n'
+ '3. STRUCTURAL FLOOR (cumulative I1-I5):\n'
+ '   - Dashboard\'s client-side indicator scores on ALL game data from tip to now\n'
+ '   - This is "who has controlled this game overall"\n\n'
+ '4. ROLLING WINDOW (when available, Q3+):\n'
+ '   - I1-I5 scored on the two most recent quarters (Q2+Q3, or Q3+Q4)\n'
+ '   - This is "who is controlling the game RIGHT NOW"\n'
+ '   - In Q2: window is TOO EARLY (not enough data), but directional arrows still fire\n\n'
+ '5. GAP ACCELERATION (when window available):\n'
+ '   - Gap = window score minus floor score. Positive = window stronger than cumulative (edge compounding)\n'
+ '   - Tracked across check-ins. Classification:\n'
+ '     GROWING = gap widening (edge compounding) | DECLINING = gap narrowing (edge fading)\n'
+ '     STABLE = no clear trend | FLIPPED = control changing hands | TOO EARLY = insufficient data\n\n'
+ '6. DIRECTIONAL ARROWS (both teams, per quarter):\n'
+ '   - Raw sub-metric trends across completed quarters, grouped by indicator:\n'
+ '     I2: Paint pts, At-rim att, FTA | I1: Steals, TOs committed | I3: 3PA share, Assist ratio | I5: Possessions\n'
+ '   - Each metric: RISING (▲), FALLING (▼), or FLAT (▬) with per-quarter values\n'
+ '   - ADJUSTMENT SIGNAL derived from arrow pattern:\n'
+ '     INTERIOR PIVOT = structural arrows rising + variance falling (team adjusting toward rim)\n'
+ '     STRUCTURAL EROSION = structural arrows falling (interior game fading)\n'
+ '     VARIANCE SHIFT = moving toward perimeter (less durable production)\n'
+ '     STRUCTURAL ACCEL = multiple structural inputs compounding\n\n'
+ '7. EVENT FLAGS (player-level, not absorbed by indicator math):\n'
+ '   - Trag1 (Role Player Heater): non-star shooting far above season norms — variance signal\n'
+ '   - Trag2 (Star Process): star cold but process intact/declining — forward regression read\n'
+ '   - Trag3 (Foul Gate): key player in foul trouble — forward indicator degradation\n'
+ '   - Trag4 (Closing Lineup): who is on the floor generating the current read\n\n'
+ '8. DEPTH AUDIT (PBP, when available): 3PT assisted/unassisted, forced/unforced TOs, shot zones, scoring runs\n\n'
+ 'HOW TO USE THE LAYERS TOGETHER:\n'
+ '   The STRUCTURAL FLOOR answers "who should win." The ROLLING WINDOW answers "who is winning now." The GAP answers "is the edge compounding or fading."\n'
+ '   The ARROWS show HOW — is the team adjusting its approach (interior pivot, variance shift).\n'
+ '   The EVENT FLAGS explain WHY — personnel events the math can\'t capture.\n'
+ '   SUSTAINABILITY + LEAD COMPOSITION answer "is the scoreline real."\n\n'
+ '   COMBINED READ (pre-computed from floor × window × acceleration):\n'
+ '   DOMINANT = floor 0.75+ / window 0.80+ / growing or stable\n'
+ '   STRONG = floor 0.75+ / window 0.75+\n'
+ '   EMERGING = floor 0.60-0.74 / window 0.75+ / growing\n'
+ '   EARNED = floor 0.60+ / window 0.60+\n'
+ '   ERODING = floor 0.75+ / window 0.60-0.74 / declining\n'
+ '   COLLAPSING = floor 0.75+ / window <0.60\n'
+ '   FADING = floor 0.60-0.74 / window <0.60\n'
+ '   SHIFT = floor and window disagree on control team\n'
+ '   NO EDGE = neither team has structural control\n\n'
+ 'ENTRY STRATEGY — FIND THE STRUCTURAL EDGE AT VALUE PRICE:\n'
+ '   Evaluate BOTH teams. Pre-game thesis is context, not permanent anchor.\n'
+ '   Core strategy: buy structural control when trailing on variance. Applies either direction.\n'
+ '   ENTRY SIGNALS:\n'
+ '   OPTIMAL WINDOW = structurally dominant + TRAILING + opponent scoring VOLATILE + gap GROWING\n'
+ '   WINDOW OPEN = structural edge + trailing or at value + opponent scoring MIXED or VOLATILE\n'
+ '   WINDOW CLOSING = structural edge team now LEADING + variance cooling\n'
+ '   NO WINDOW = no structural edge, or opponent scoring IDENTITY/HOT/STRUCTURAL (no regression expected), or dominant team at full price\n'
+ '   FADE = structural read says do not buy either team\n\n'
+ '   CRITICAL: A team leading AND priced beyond -400 ML has NO VALUE regardless of structural control.\n\n'
+ 'FWP (Framework Win Probability) IS GAME-STATE-AWARE:\n'
+ '   FWP = probability of WINNING given score, time, AND structural control. NOT the control score.\n'
+ '   Factor in: score margin, quarter, time remaining, combined read trajectory. BE ACCURATE.\n\n'
+ 'CONVICTION GUIDELINES:\n'
+ '  DOMINANT = control 0.85+ driven by I1+I2, opponent unsustainable, gap GROWING\n'
+ '  STRONG = control 0.70+, lead composition supports read, gap STABLE or GROWING\n'
+ '  EARNED = control 0.60+ with edge, may have mixed sustainability\n'
+ '  CONDITIONAL = edge exists but gap DECLINING, sustainability concerns, or lead composition tension\n'
+ '  NO ENTRY = no structural edge for either team, or no value at current price\n'
+ '  State which indicators drive your score. I1+I2 (50% weight) warrants higher conviction than I4+I5 (30%).\n\n'
+ 'OUTPUT FORMAT (follow exactly):\n\n'
+ 'DECISION:\n'
+ 'EDGE: [+X% | No market data] | FWP: [X%] | MIP: [X% | N/A]\n'
+ 'ENTRY: [OPTIMAL WINDOW | WINDOW OPEN | WINDOW CLOSING | NO WINDOW | FADE]\n'
+ 'CONVICTION: [DOMINANT | STRONG | EARNED | CONDITIONAL | NO ENTRY]\n'
+ 'SIGNAL: [BUY TeamAlias | NO VALUE | PASS] — [1-line reason naming both teams]\n'
+ 'Sustainability: [TeamA]: [tier] | [TeamB]: [tier]\n'
+ 'Scoring: [STRUCTURAL | IDENTITY | HOT | MIXED | VOLATILE | EVEN] — [1-line]\n'
+ 'SPREAD ANALYSIS: [1-line]\n'
+ 'Team Quality: [context for both teams]\n'
+ 'Clutch: [Tier X] — [CLEAR|WATCH|FIRES|NEUTRALIZED]\n'
+ 'Prediction: [1-line decisive call]\n\n'
+ 'EVIDENCE:\n'
+ 'CONTROL: [Team] [score] — [level]\n'
+ 'COMBINED READ: [DOMINANT|STRONG|EMERGING|EARNED|ERODING|FADING|COLLAPSING|SHIFT|NO EDGE] — [note]\n\n'
+ 'I1 Possession & Transition (25%): [team] [score] — [explanation]\n'
+ 'I2 Rim Pressure & Foul (25%): [team] [score] — [explanation]\n'
+ 'I3 Shot Quality & Creation (20%): [team] [score] — [explanation]\n'
+ 'I4 Lineup Integrity (20%): [team] [score] — [explanation]\n'
+ 'I5 Tempo & Efficiency (10%): [team] [score] — [explanation]\n\n'
+ 'EVENT FLAGS:\n'
+ 'Trag1 — Role Player Heater: [detail or CLEAR]\n'
+ 'Trag2 — Star Process: [detail or CLEAR]\n'
+ 'Trag3 — Foul Gate: [detail or CLEAR]\n'
+ 'Trag4 — Closing Lineup: [detail or CLEAR]\n\n'
+ 'THESIS STATUS: [CONFIRMED|DEVELOPING|CONTESTED|DENIED|FLIPPED] — [note]\n'
+ 'FLIPPED = thesis was wrong AND the other team has emerged as the structural edge with a valid entry.\n'
+ 'DIVERGENCE NOTES: [where your scores differ from dashboard and why]\n\n'
+ 'Be concise. 1 line per indicator. Decisive when clear. Passing is correct when it is not.';

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

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  }

  try {
    var body = JSON.parse(event.body);
    var summaryData = body.summaryData;
    var thesis = body.thesis;
    var homeTeam = body.homeTeam;
    var awayTeam = body.awayTeam;
    var period = body.period;
    var score = body.score;
    var clutchData = body.clutchData;
    var oddsData = body.oddsData;
    var edgeHistory = body.edgeHistory;
    var analysisHistory = body.analysisHistory;
    var trackingData = body.trackingData;
    var pbpAudit = body.pbpAudit;
    var rollingWindow = body.rollingWindow;
    var acceleration = body.acceleration;
    var subMetricArrows = body.subMetricArrows;
    var adjustment = body.adjustment;
    var combinedRead = body.combinedRead;

    if (!summaryData) {
      return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'summaryData required' }) };
    }

    // ── 3PT SUSTAINABILITY AUDIT (pre-computed) ──
    var audit = computeSustainabilityAudit(summaryData, trackingData, homeTeam, awayTeam);
    var sustainabilitySection = formatSustainabilityAudit(audit);

    // ── LEAD COMPOSITION (pre-computed) ──
    var leadComp = computeLeadComposition(summaryData, homeTeam, awayTeam, audit);
    var leadCompSection = formatLeadComposition(leadComp);

    // ── CLUTCH SECTION ──
    var clutchSection = '';
    if (clutchData) {
      var tierLabel = clutchData.tier === 1 ? 'L15 NBA.com Tier 1' : clutchData.tier === 2 ? 'Season BDL Tier 2' : 'Tier 3';
      clutchSection = '\nCLUTCH (' + tierLabel + '):\n';
      clutchSection += awayTeam + ': NetRtg ' + (clutchData.away && clutchData.away.netRtg != null ? clutchData.away.netRtg : 'N/A') + ' OffRtg ' + (clutchData.away && clutchData.away.offRtg != null ? clutchData.away.offRtg : 'N/A') + ' DefRtg ' + (clutchData.away && clutchData.away.defRtg != null ? clutchData.away.defRtg : 'N/A') + ' ' + (clutchData.away && clutchData.away.wl ? clutchData.away.wl : '') + '\n';
      clutchSection += homeTeam + ': NetRtg ' + (clutchData.home && clutchData.home.netRtg != null ? clutchData.home.netRtg : 'N/A') + ' OffRtg ' + (clutchData.home && clutchData.home.offRtg != null ? clutchData.home.offRtg : 'N/A') + ' DefRtg ' + (clutchData.home && clutchData.home.defRtg != null ? clutchData.home.defRtg : 'N/A') + ' ' + (clutchData.home && clutchData.home.wl ? clutchData.home.wl : '') + '\n';
      var hNet = clutchData.home ? clutchData.home.netRtg : null;
      var aNet = clutchData.away ? clutchData.away.netRtg : null;
      if (hNet != null && aNet != null) {
        var better = hNet > aNet ? homeTeam : awayTeam;
        clutchSection += 'Edge: ' + better + ' by ' + Math.abs(hNet - aNet).toFixed(1) + ' NetRtg\n';
      }
      if (clutchData.tier <= 2) {
        var h = clutchData.home || {}, a = clutchData.away || {};
        if (a.efg != null) clutchSection += awayTeam + ': eFG ' + a.efg + '% TS ' + (a.ts != null ? a.ts : '?') + '% TOV% ' + (a.tovPct != null ? a.tovPct : '?') + ' Pace ' + (a.pace != null ? a.pace : '?') + '\n';
        if (h.efg != null) clutchSection += homeTeam + ': eFG ' + h.efg + '% TS ' + (h.ts != null ? h.ts : '?') + '% TOV% ' + (h.tovPct != null ? h.tovPct : '?') + ' Pace ' + (h.pace != null ? h.pace : '?') + '\n';
        if (a.fbp != null) clutchSection += awayTeam + ' conv: FBP ' + a.fbp + ' POT ' + (a.pot != null ? a.pot : '?') + ' Paint ' + (a.paint != null ? a.paint : '?') + '\n';
        if (h.fbp != null) clutchSection += homeTeam + ' conv: FBP ' + h.fbp + ' POT ' + (h.pot != null ? h.pot : '?') + ' Paint ' + (h.paint != null ? h.paint : '?') + '\n';
        if (a.pctPts3pt != null) clutchSection += awayTeam + ' diet: 3PT% ' + a.pctPts3pt + ' Paint% ' + (a.pctPtsPaint != null ? a.pctPtsPaint : '?') + ' FT% ' + (a.pctPtsFt != null ? a.pctPtsFt : '?') + '\n';
        if (h.pctPts3pt != null) clutchSection += homeTeam + ' diet: 3PT% ' + h.pctPts3pt + ' Paint% ' + (h.pctPtsPaint != null ? h.pctPtsPaint : '?') + ' FT% ' + (h.pctPtsFt != null ? h.pctPtsFt : '?') + '\n';
      }
    } else {
      clutchSection = '\nCLUTCH: Not provided.\n';
    }

    // ── ODDS + SERVER-SIDE MIP ──
    var oddsSection = '';
    if (oddsData && (oddsData.homeML || oddsData.homeSpread)) {
      function mlToProb(ml) {
        var n = parseFloat(ml);
        if (isNaN(n) || n === 0) return null;
        return n < 0 ? Math.abs(n) / (Math.abs(n) + 100) : 100 / (n + 100);
      }
      var homeMIP = mlToProb(oddsData.homeML);
      var awayMIP = mlToProb(oddsData.awayML);
      var mipNote = '';
      if (homeMIP !== null && awayMIP !== null) {
        var vigSum = homeMIP + awayMIP;
        var homeNorm = (homeMIP / vigSum * 100).toFixed(1);
        var awayNorm = (awayMIP / vigSum * 100).toFixed(1);
        mipNote = '\nPRE-COMPUTED MIP: If ' + homeTeam + ' wins -> Edge = FWP - ' + homeNorm + '% | If ' + awayTeam + ' wins -> Edge = FWP - ' + awayNorm + '%\nUse the MIP of the team you are PREDICTING TO WIN.\n';
      }
      oddsSection = '\nMARKET: Spread ' + homeTeam + ' ' + (oddsData.homeSpread || 'N/A') + ' | ML ' + awayTeam + ' ' + (oddsData.awayML || 'N/A') + ' / ' + homeTeam + ' ' + (oddsData.homeML || 'N/A') + ' | O/U ' + (oddsData.total || 'N/A') + mipNote + '\n';
    } else {
      oddsSection = '\nMARKET: No odds.\n';
    }

    // ── TRACKING BASELINES ──
    var trackingSection = '';
    if (trackingData) {
      var ht = trackingData.home || {}, at = trackingData.away || {};
      trackingSection = '\nSHOOTING BASELINES:\n';
      if (ht.catchAndShoot || at.catchAndShoot) trackingSection += 'C&S: ' + awayTeam + ' ' + (at.catchAndShoot ? at.catchAndShoot.efg || '?' : '?') + '% | ' + homeTeam + ' ' + (ht.catchAndShoot ? ht.catchAndShoot.efg || '?' : '?') + '%\n';
      if (ht.pullUp || at.pullUp) trackingSection += 'Pull-up: ' + awayTeam + ' ' + (at.pullUp ? at.pullUp.efg || '?' : '?') + '% | ' + homeTeam + ' ' + (ht.pullUp ? ht.pullUp.efg || '?' : '?') + '%\n';
    }

    // ── EDGE HISTORY ──
    var edgeSection = '';
    if (edgeHistory && edgeHistory.length > 0) {
      edgeSection = '\nEDGE HISTORY:\n' + edgeHistory.map(function(e) { return e.time + ' | ' + e.edge + ' FWP ' + e.fwp + ' | ' + e.control + ' ' + e.score; }).join('\n') + '\n';
    }

    // ── ANALYSIS HISTORY (game narrative across prior calls) ──
    var narrativeSection = '';
    if (analysisHistory && analysisHistory.length > 0) {
      narrativeSection = '\nGAME NARRATIVE (your prior reads this game — track how your assessment has evolved):\n';
      analysisHistory.forEach(function(h, i) {
        narrativeSection += (i+1) + '. ' + (h.time||'?') + ' Q' + (h.period||'?') + (h.clock?' '+h.clock:'') + ' ' + (h.score||'') + ' | '
          + (h.controlTeam||'?') + ' ' + (h.controlScore ? h.controlScore.toFixed(2) : '?') + ' ' + (h.verdict||'')
          + ' | ' + (h.entry||'—') + '/' + (h.conviction||'—')
          + ' | Lead:' + (h.leadTeam||'?') + '=' + (h.leadSust||'?') + ' Trail:' + (h.trailTeam||'?') + '=' + (h.trailSust||'?')
          + ' | ' + (h.signal||'—')
          + (h.thesisStatus ? ' | Thesis:' + h.thesisStatus : '')
          + (h.keyRead ? ' — ' + h.keyRead.substring(0, 80) : '')
          + '\n';
      });
    }

    // ── PBP DEPTH AUDIT ──
    var pbpSection = '';
    if (pbpAudit && (pbpAudit.home || pbpAudit.away)) {
      var pAge = pbpAudit.pbpAge != null ? pbpAudit.pbpAge + ' min ago' : '';
      var pPer = pbpAudit.pbpPeriod ? 'Q' + pbpAudit.pbpPeriod : '?';
      pbpSection = '\nDEPTH AUDIT (PBP through ' + pPer + ' ' + pAge + '):\n';
      
      // Format each team's data
      var teams = [{data: pbpAudit.away, alias: pbpAudit.awayAlias || awayTeam},
                   {data: pbpAudit.home, alias: pbpAudit.homeAlias || homeTeam}];
      
      teams.forEach(function(t) {
        var tm = t.data;
        if (!tm) return;
        pbpSection += '\n' + t.alias + ' SHOT MAP:\n';
        
        // 3PT detail
        if (tm.threes && tm.threes.byPlayer && tm.threes.byPlayer.length > 0) {
          pbpSection += '  3PT (' + tm.threes.made + '/' + tm.threes.att + ', ' + tm.threes.pct + '%, ' + tm.threes.assisted + '/' + tm.threes.made + ' ast): ';
          tm.threes.byPlayer.forEach(function(p) {
            var ctxStr = Object.entries(p.contexts || {}).map(function(e){return e[0]+':'+e[1];}).join(',');
            pbpSection += p.name + ' ' + p.made + '/' + p.att + ' (' + p.assisted + ' ast, ' + ctxStr + ') | ';
          });
          pbpSection += '\n';
          if (tm.threes.corner) pbpSection += '  Corner: ' + tm.threes.corner.made + '/' + tm.threes.corner.att + ' | Above: ' + tm.threes.above.made + '/' + tm.threes.above.att + '\n';
        }
        
        // At-rim detail
        if (tm.rim && tm.rim.byPlayer && tm.rim.byPlayer.length > 0) {
          pbpSection += '  AT-RIM (' + tm.rim.made + '/' + tm.rim.att + ', ' + tm.rim.pct + '%): ';
          tm.rim.byPlayer.forEach(function(p) {
            var ctxStr = Object.entries(p.contexts || {}).map(function(e){return e[0]+':'+e[1];}).join(',');
            pbpSection += p.name + ' ' + p.made + '/' + p.att + ' (' + ctxStr + ') | ';
          });
          pbpSection += '\n';
        }
        
        // Mid-range detail
        if (tm.mid && tm.mid.byPlayer && tm.mid.byPlayer.length > 0) {
          pbpSection += '  MID-RANGE (' + tm.mid.made + '/' + tm.mid.att + ', ' + tm.mid.pct + '%, ' + tm.mid.assisted + '/' + tm.mid.made + ' ast): ';
          tm.mid.byPlayer.forEach(function(p) {
            pbpSection += p.name + ' ' + p.made + '/' + p.att + ' (' + p.assisted + ' ast) | ';
          });
          pbpSection += '\n';
        }
        
        // Zone summary
        if (tm.shotDiet) {
          pbpSection += '  ZONES: rim ' + tm.shotDiet.rimPct + '% | mid ' + tm.shotDiet.midPct + '% | 3pt ' + tm.shotDiet.threePct + '% of FGA\n';
        }
        
        // TO breakdown
        if (tm.tos && tm.tos.total > 0) {
          pbpSection += '  TOs: ' + tm.tos.forced + ' forced / ' + tm.tos.unforced + ' unforced' + (tm.tos.unknown > 0 ? ' / ' + tm.tos.unknown + ' unclear' : '') + '\n';
          tm.tos.byPlayer.forEach(function(to) {
            pbpSection += '    Q' + to.q + ' ' + to.p + ' — ' + (to.forced === true ? 'FORCED' : to.forced === false ? 'UNFORCED' : '?') + ' (' + (to.type || '?') + ')\n';
          });
        }
      });
      
      // Scoring runs
      if (pbpAudit.runs && pbpAudit.runs.length > 0) {
        pbpSection += '\nSCORING RUNS:\n';
        pbpAudit.runs.forEach(function(r) {
          var mechStr = Array.isArray(r.mechanism) ? r.mechanism.join('+') : (r.mechanism || '?');
          var lineupStr = Array.isArray(r.lineup) ? r.lineup.join(', ') : '';
          pbpSection += '  ' + r.team + ' ' + r.pts + '-' + r.count + ' run (Q' + r.q + '): ' + mechStr + '\n';
          if (lineupStr) pbpSection += '    Lineup: ' + lineupStr + '\n';
        });
      }
    }

    // ── ROLLING WINDOW ARCHITECTURE ──
    var windowSection = '';
    if (rollingWindow) {
      if (rollingWindow.available) {
        windowSection = '\nROLLING WINDOW (' + rollingWindow.windowQuarters.map(function(q){return 'Q'+q;}).join('+') + ', ' + (rollingWindow.windowPossessions||'?') + ' poss):\n';
        windowSection += 'Control: ' + rollingWindow.controlTeam + ' ' + rollingWindow.score.toFixed(2) + '\n';
        ['I1','I2','I3','I4','I5'].forEach(function(k) {
          var ind = rollingWindow[k];
          if (ind) windowSection += '  ' + k + ': ' + ind.score.toFixed(1) + ' — ' + (ind.detail||'') + '\n';
        });
        windowSection += 'Data quality: ' + (rollingWindow.dataQuality||'?') + (rollingWindow.missingFields && rollingWindow.missingFields.length > 0 ? ' (missing: ' + rollingWindow.missingFields.join(', ') + ')' : '') + '\n';
      } else {
        windowSection = '\nROLLING WINDOW: ' + (rollingWindow.reason || 'TOO EARLY') + '\n';
      }
    }

    var gapSection = '';
    if (acceleration && acceleration.entries && acceleration.entries.length > 0) {
      var lastEntry = acceleration.entries[acceleration.entries.length - 1];
      gapSection = '\nGAP ACCELERATION:\n';
      gapSection += 'Gap: ' + (lastEntry.gap >= 0 ? '+' : '') + lastEntry.gap.toFixed(3) + ' | Acceleration: ' + acceleration.accel + ' (' + acceleration.consecutive + ' consecutive)\n';
      gapSection += 'History: ' + acceleration.entries.slice(-5).map(function(e) { return (e.gap >= 0 ? '+' : '') + e.gap.toFixed(2) + ' (' + e.score + ')'; }).join(' → ') + '\n';
    } else if (acceleration) {
      gapSection = '\nGAP: ' + (acceleration.accel || 'TOO EARLY') + '\n';
    }

    var arrowSection = '';
    if (subMetricArrows && (subMetricArrows.home || subMetricArrows.away)) {
      arrowSection = '\nDIRECTIONAL ARROWS:\n';
      var arrowOrder = [
        {header: 'I2 RIM PRESSURE', keys: ['paint','atRim','fta']},
        {header: 'I1 POSSESSION', keys: ['steals','tos']},
        {header: 'I3 SHOT QUALITY', keys: ['fg3aShare','astRatio']},
        {header: 'I5 TEMPO', keys: ['poss']},
      ];
      arrowSection += String('').padEnd(12) + homeTeam.padEnd(18) + awayTeam + '\n';
      arrowOrder.forEach(function(grp) {
        arrowSection += grp.header + ':\n';
        grp.keys.forEach(function(key) {
          var hm = subMetricArrows.home ? subMetricArrows.home[key] : null;
          var am = subMetricArrows.away ? subMetricArrows.away[key] : null;
          var label = hm ? hm.label : (am ? am.label : key);
          var hStr = hm && hm.arrow ? hm.display : '—';
          var aStr = am && am.arrow ? am.display : '—';
          arrowSection += '  ' + label.padEnd(10) + hStr.padEnd(18) + aStr + '\n';
        });
      });
    }

    var adjustmentSection = '';
    if (adjustment && adjustment.signal && adjustment.signal !== 'NO ADJUSTMENT' && adjustment.signal !== 'NO DATA') {
      adjustmentSection = 'ADJUSTMENT: ' + adjustment.signal + ' (' + adjustment.team + ') — ' + adjustment.note + '\n';
    }

    var combinedReadSection = '';
    if (combinedRead && combinedRead.read) {
      combinedReadSection = '\nCOMBINED READ: ' + combinedRead.read + ' — ' + (combinedRead.note || '') + '\n';
    }

    // ── BUILD PROMPT ──
    var userPrompt = awayTeam + ' @ ' + homeTeam + ' | ' + period + ' | ' + score + '\n\n'
      + (thesis ? 'THESIS:\n' + thesis + '\n' : 'No thesis.')
      + '\n' + clutchSection + oddsSection + trackingSection + sustainabilitySection + leadCompSection
      + windowSection + gapSection + combinedReadSection + arrowSection + adjustmentSection
      + pbpSection + edgeSection + narrativeSection
      + '\nGAME DATA:\n' + JSON.stringify(summaryData);

    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 25000);

    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      var errText = await resp.text();
      return { statusCode: resp.status, headers: headers, body: JSON.stringify({ error: 'Anthropic ' + resp.status + ': ' + errText.substring(0, 300) }) };
    }

    var data = await resp.json();
    var analysis = data.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ analysis: analysis, usage: data.usage, sustainabilityAudit: audit, leadComposition: leadComp }),
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { statusCode: 504, headers: headers, body: JSON.stringify({ error: 'Analysis timed out (25s). Try again.' }) };
    }
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: err.message }) };
  }
};

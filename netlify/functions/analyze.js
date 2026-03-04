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

function computeLeadComposition(summaryData, homeTeam, awayTeam) {
  if (!summaryData) return null;

  function composeTeam(teamData, alias) {
    if (!teamData) return null;
    var stats = teamData.statistics || {};
    var totalPts = stats.points || 0;
    if (totalPts === 0) return null;

    var paintPts = stats.points_in_the_paint || 0;
    var ftPts = stats.free_throws_made || 0;
    var threePts = (stats.three_points_made || 0) * 3;
    var fbPts = stats.fast_break_points || 0;
    var potPts = stats.points_off_turnovers || 0;
    var scPts = stats.second_chance_points || 0;

    // Mid/Other = everything not paint, FT, or 3PT
    var midOther = Math.max(0, totalPts - paintPts - ftPts - threePts);

    // Structural = paint + FT (scheme-driven, matchup-driven, contact-driven)
    var structural = paintPts + ftPts;
    // Variance = 3PT + mid-range (shooting % fluctuates game-to-game)
    var variance = threePts + midOther;

    return {
      team: alias,
      total: totalPts,
      paint: paintPts,
      ft: ftPts,
      three: threePts,
      midOther: midOther,
      transition: fbPts,
      pot: potPts,
      secondChance: scPts,
      structural: structural,
      variance: variance,
      structuralPct: totalPts > 0 ? Math.round(structural / totalPts * 100) : 0,
      variancePct: totalPts > 0 ? Math.round(variance / totalPts * 100) : 0,
    };
  }

  var home = composeTeam(summaryData.home, homeTeam);
  var away = composeTeam(summaryData.away, awayTeam);
  if (!home || !away) return null;

  // Margin analysis
  var margin = home.total - away.total;
  var leadTeam = margin >= 0 ? homeTeam : awayTeam;
  var trailTeam = margin >= 0 ? awayTeam : homeTeam;
  var lead = margin >= 0 ? home : away;
  var trail = margin >= 0 ? away : home;

  var structuralMargin = lead.structural - trail.structural;
  var varianceMargin = lead.variance - trail.variance;

  // Classify margin durability
  var durability;
  if (Math.abs(margin) <= 2) {
    durability = 'EVEN — margin too small to classify';
  } else if (structuralMargin >= Math.abs(margin) * 0.6) {
    durability = leadTeam + ' lead is STRUCTURALLY SOURCED — structural margin (' + (structuralMargin >= 0 ? '+' : '') + structuralMargin + ') exceeds total margin (' + (margin >= 0 ? '+' : '') + margin + ')';
  } else if (varianceMargin >= Math.abs(margin) * 0.6) {
    durability = leadTeam + ' lead is VARIANCE SOURCED — variance production (' + (varianceMargin >= 0 ? '+' : '') + varianceMargin + ') drives margin while structural favors ' + (structuralMargin >= 0 ? leadTeam : trailTeam) + ' (' + (structuralMargin >= 0 ? '+' : '') + structuralMargin + ')';
  } else {
    durability = 'MIXED — lead built from both structural (' + (structuralMargin >= 0 ? '+' : '') + structuralMargin + ') and variance (' + (varianceMargin >= 0 ? '+' : '') + varianceMargin + ') sources';
  }

  return {
    home: home, away: away,
    margin: margin, absMargin: Math.abs(margin),
    leadTeam: leadTeam, trailTeam: trailTeam,
    structuralMargin: structuralMargin,
    varianceMargin: varianceMargin,
    durability: durability,
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
+ 'CORE TASK: Determine which team structurally controls this game, assess whether each team\'s production is sustainable, and identify the best entry — on EITHER team — using pre-computed data and your own reasoning.\n\n'
+ 'FIVE INDICATORS (score each 0.00-1.00 for the controlling team):\n'
+ 'I1 Possession & Transition (25%): TO margin, steals, OREBs, fast break pts, pts off TOs, second chance pts\n'
+ 'I2 Rim Pressure & Foul (25%): Paint points, at-rim FG, FTA, blocks, fouls, bonus status\n'
+ 'I3 Shot Quality & Creation (20%): eFG%, assist ratio (65%+ sustainable, <50% isolation-dependent), shot diet\n'
+ 'I4 Lineup Integrity (20%): Biggest lead, bench contribution, which lineups producing, plus/minus\n'
+ 'I5 Tempo & Efficiency (10%): Possessions, pts/possession differential, pace control\n\n'
+ 'CONTROL: 0.90+ DOMINANT | 0.75-0.89 STRONG | 0.60-0.74 EARNED | 0.45-0.59 NO EDGE | <0.45 WAIT\n\n'
+ 'EIGHT TRAJECTORY SIGNALS (evaluate for BOTH teams):\n'
+ 'T1 Role Player Heater | T2 Star Process Integrity | T3 Quarter Delta (highest weight) | T4 Foul Gate | T5 Interior Trend | T6 Quarter Assist Ratio | T7 Closing Lineup | T8 Shot Diet Misalignment\n\n'
+ 'YOU RECEIVE THREE PRE-COMPUTED DATA LAYERS:\n\n'
+ '1. 3PT SUSTAINABILITY AUDIT (per team):\n'
+ '   - PERSONNEL AUDIT: What % of 3PM came from ELITE shooters (38%+ season, 2+ 3PA/gm) vs NON-SHOOTERS (<33% or <0.8 3PA/gm)\n'
+ '   - BAYESIAN REGRESSION MODEL: Posterior expected 3PT% given season prior + live data. Sample-size-aware regression probability.\n'
+ '   - SHOT TYPE: Assist ratio proxy for catch-and-shoot (durable) vs pull-up/isolation (fragile)\n'
+ '   - COMPOSITE TIER: LOCKED IN / DURABLE / MIXED / FRAGILE / UNSUSTAINABLE\n'
+ '   Use these tiers as your primary 3PT sustainability read. Override only with specific evidence and explicit justification.\n\n'
+ '2. LEAD COMPOSITION (both teams):\n'
+ '   - Structural points (Paint + FT): scheme-driven, matchup-driven, contact-driven — these don\'t randomly disappear\n'
+ '   - Variance points (3PT + Mid-range): shooting % fluctuates game-to-game — these can regress\n'
+ '   - Transition points: supplementary structural signal (cross-ref with I1 for durability)\n'
+ '   - MARGIN DURABILITY: pre-computed classification of whether the lead is structurally sourced, variance sourced, or mixed\n'
+ '   This tells you WHERE the margin came from. The 3PT audit tells you whether the perimeter portion will hold. Together they answer: is this lead real?\n\n'
+ '3. DEPTH AUDIT (PBP, when available):\n'
+ '   - 3PT assisted/unassisted splits — actual shot creation quality\n'
+ '   - Forced vs unforced TO classification — I1 chaos layer\n'
+ '   - Shot zone distribution vs structural identity — T8 reads\n'
+ '   - Scoring run composition — paint/transition (structural) vs perimeter heaters (variance)\n'
+ '   - At-rim contexts (drive/cut/putback/transition) — scheme-driven vs opportunity interior pressure\n\n'
+ 'ENTRY STRATEGY — FIND THE STRUCTURAL EDGE AT VALUE PRICE:\n'
+ '   Evaluate BOTH teams as potential entries. The pre-game thesis identified a projected dominant team — use as context for divergence tracking, not as a permanent anchor.\n\n'
+ '   The core strategy: buy the team with structural control when they are trailing or at value odds, because the other team\'s lead is built on production that will regress.\n'
+ '   This applies in EITHER direction. If the thesis team is structurally dominant and trailing, buy the thesis team. If the thesis was wrong and the other team has emerged as structurally dominant while trailing or at value, buy that team instead.\n\n'
+ '   ENTRY SIGNAL GUIDELINES (defaults — you may deviate with explicit justification):\n'
+ '   OPTIMAL WINDOW = structurally dominant team TRAILING + lead team\'s production FRAGILE/UNSUSTAINABLE + lead composition confirms variance-sourced margin\n'
+ '   WINDOW OPEN = structurally dominant team TRAILING or at value odds + lead team MIXED sustainability\n'
+ '   WINDOW CLOSING = structurally dominant team now LEADING + variance cooling. Edge shrinking.\n'
+ '   NO WINDOW = no structural edge for either team, OR dominant team already leading at fully-priced odds\n'
+ '   FADE = structural read says do not buy either team — thesis team trailing against durable opponent, no flip opportunity\n\n'
+ '   CRITICAL: A team leading AND priced beyond -400 ML has NO VALUE regardless of structural control.\n\n'
+ '   SUSTAINABILITY + LEAD COMPOSITION INTERACTION (guidelines, not absolute rules):\n'
+ '   When lead is VARIANCE SOURCED and opponent 3PT is FRAGILE/UNSUSTAINABLE → strong entry signal on trailing team\n'
+ '   When lead is STRUCTURALLY SOURCED (60%+ from Paint/FT) → 3PT tier is less relevant to margin durability. A team can be FRAGILE from 3PT but hold a structural lead built on paint dominance.\n'
+ '   When lead is STRUCTURALLY SOURCED and 3PT is LOCKED/DURABLE → strongest fade signal (do not buy trailing team)\n'
+ '   When lead is MIXED → weigh both sustainability and composition; explain which factor dominates your read\n'
+ '   If your entry signal conflicts with the default sustainability mapping, state which data resolves the tension (e.g., "Despite MIA 3PT tier DURABLE, their lead is only +4 while structural margin favors CLE by +10 — perimeter shooting is real but insufficient to hold").\n\n'
+ 'FWP (Framework Win Probability) IS GAME-STATE-AWARE:\n'
+ '   FWP is NOT the control score. FWP = probability of WINNING THE GAME given current score, time remaining, AND structural control.\n'
+ '   A team with 0.66 control UP 9 in Q4 has ~90%+ FWP. That same team DOWN 3 in Q1 might have ~55% FWP.\n'
+ '   Factor in: score margin, quarter, time remaining, momentum trajectory. Edge is computed client-side from your FWP vs market odds.\n'
+ '   If your FWP is too low for a team leading comfortably, the edge calculation will show a false negative edge and recommend PASS on a winning team.\n'
+ '   If your FWP is too high for a trailing team, it will show a false positive edge. BE ACCURATE.\n\n'
+ 'EDGE IS COMPUTED CLIENT-SIDE: Just output your FWP accurately.\n\n'
+ 'SPREAD ANALYSIS: Compare live spread against your structural projection. Reference specific structural factors.\n\n'
+ 'COHERENCE: Your entry signal, conviction, sustainability reads, lead composition, and prediction should tell a consistent story. If they don\'t, explain the tension. Unusual combinations (e.g., OPTIMAL WINDOW + opponent DURABLE) are not prohibited but should be rare and explicitly justified by lead composition data.\n\n'
+ 'CONVICTION GUIDELINES:\n'
+ '  DOMINANT = control 0.85+ driven primarily by I1+I2 (structural indicators), opponent production clearly unsustainable\n'
+ '  STRONG = control 0.70+, lead composition supports structural durability or variance regression\n'
+ '  EARNED = control 0.60+ with identifiable edge, may have mixed sustainability picture\n'
+ '  CONDITIONAL = structural edge exists but sustainability concerns, quality gaps, or lead composition tension\n'
+ '  NO ENTRY = no structural edge for either team, or no value at current price\n'
+ '  State which indicators are driving your score. I1+I2 heavy (50% weight, most structurally predictive) warrants higher conviction than I4+I5 heavy (30% weight, least decisive).\n\n'
+ 'TEAM QUALITY: Bad team (bottom-12, missing stars) leading good team (top-12, full strength) on FRAGILE/UNSUSTAINABLE shooting = ideal entry. State quality gap.\n\n'
+ 'GAME NARRATIVE: When prior analysis history is provided, track how control, sustainability, and your signals have evolved. Reference shifts explicitly. Own prior mistakes. Never repeat verbatim — advance the narrative.\n\n'
+ 'OUTPUT FORMAT (follow exactly):\n\n'
+ 'DECISION:\n'
+ 'EDGE: [+X% | No market data] | FWP: [X%] | MIP: [X% | N/A]\n'
+ 'ENTRY: [OPTIMAL WINDOW | WINDOW OPEN | WINDOW CLOSING | NO WINDOW | FADE]\n'
+ 'CONVICTION: [DOMINANT | STRONG | EARNED | CONDITIONAL | NO ENTRY]\n'
+ 'SIGNAL: [BUY TeamAlias | NO VALUE | PASS] — [1-line reason naming both teams]\n'
+ 'Sustainability: [TeamA]: [LOCKED IN|DURABLE|MIXED|FRAGILE|UNSUSTAINABLE] | [TeamB]: [LOCKED IN|DURABLE|MIXED|FRAGILE|UNSUSTAINABLE]\n'
+ 'Lead Source: [STRUCTURAL | VARIANCE | MIXED | EVEN] — [1-line noting structural vs variance margin]\n'
+ 'SPREAD ANALYSIS: [1-line — is spread accurate given structural reads?]\n'
+ 'Team Quality: [context for both teams]\n'
+ 'Clutch: [Tier X] — [CLEAR|WATCH|FIRES|NEUTRALIZED]\n'
+ 'Prediction: [1-line decisive call]\n\n'
+ 'EVIDENCE:\n'
+ 'CONTROL: [Team] [score] — [level]\n\n'
+ 'I1 Possession & Transition (25%): [team] [score] — [explanation]\n'
+ 'I2 Rim Pressure & Foul (25%): [team] [score] — [explanation]\n'
+ 'I3 Shot Quality & Creation (20%): [team] [score] — [explanation]\n'
+ 'I4 Lineup Integrity (20%): [team] [score] — [explanation]\n'
+ 'I5 Tempo & Efficiency (10%): [team] [score] — [explanation]\n\n'
+ 'TRAJECTORY: [team or NEUTRAL] — [count]/8 signals\n'
+ 'T1 — Role Player Heater: [TEAM_ALIAS] [player] [detail] or CLEAR\n'
+ 'T2 — Star Process Integrity: [TEAM_ALIAS] [player] [detail] or CLEAR\n'
+ 'T3 — Quarter Delta: [detail or CLEAR]\n'
+ 'T4 — Foul Gate: [TEAM_ALIAS] [player] [detail] or CLEAR\n'
+ 'T5 — Interior Trend: [detail or CLEAR]\n'
+ 'T6 — Quarter Assist Ratio: [detail or CLEAR]\n'
+ 'T7 — Closing Lineup: [detail or CLEAR]\n'
+ 'T8 — Shot Diet Misalignment: [TEAM_ALIAS] [detail] or CLEAR\n\n'
+ 'THESIS STATUS: [CONFIRMED|DEVELOPING|CONTESTED|DENIED|FLIPPED] — [note]\n'
+ 'FLIPPED = thesis was wrong AND the other team has emerged as the structural edge with a valid entry. Name the team.\n'
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

    if (!summaryData) {
      return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'summaryData required' }) };
    }

    // ── 3PT SUSTAINABILITY AUDIT (pre-computed) ──
    var audit = computeSustainabilityAudit(summaryData, trackingData, homeTeam, awayTeam);
    var sustainabilitySection = formatSustainabilityAudit(audit);

    // ── LEAD COMPOSITION (pre-computed) ──
    var leadComp = computeLeadComposition(summaryData, homeTeam, awayTeam);
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

    // ── BUILD PROMPT ──
    var userPrompt = awayTeam + ' @ ' + homeTeam + ' | ' + period + ' | ' + score + '\n\n'
      + (thesis ? 'THESIS:\n' + thesis + '\n' : 'No thesis.')
      + '\n' + clutchSection + oddsSection + trackingSection + sustainabilitySection + leadCompSection + pbpSection + edgeSection + narrativeSection
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

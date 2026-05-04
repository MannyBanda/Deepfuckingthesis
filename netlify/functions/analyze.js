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

    var rawPaint = stats.points_in_the_paint || 0;
    // SR sometimes delays points_in_the_paint — use at-rim makes × 2 as floor proxy
    var atRimPts = (stats.field_goals_at_rim_made || 0) * 2;
    var paintPts = Math.max(rawPaint, atRimPts);
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

var SYSTEM_PROMPT = 'You are an NBA structural analyst. You receive pre-computed mechanical indicators as GROUND TRUTH — do not recompute them. Your job: synthesize a predictive read, compute FWP, identify risks, and write a plain-English narrative.\n\n'
+ 'GROUND TRUTH (provided by the mechanical engine — do NOT override):\n'
+ '  - I1-I5 indicator scores with team labels and who wins each\n'
+ '    (Scale: 1.0 = control team dominates, 0.0 = opponent dominates, 0.5 = even. Won ≥0.55, lost ≤0.45)\n'
+ '  - Composite floor score (weighted I1-I5, 0-1) and control team\n'
+ '  - Mechanical conviction tier: DOMINANT / STRONG / MODEST / CONDITIONAL / NO ENTRY\n'
+ '    Based on which indicator COMBINATIONS the control team wins (171-game validated):\n'
+ '    DOMINANT = I4+I5 pair (100% win rate) OR 4+ indicators\n'
+ '    STRONG = I3+I4 (99%) or I3+I5 (96%) pair without I4+I5\n'
+ '    MODEST = 2+ indicators but missing killer pairs (I4+I5, I3+I4, I3+I5). 70-80% win rate.\n'
+ '    CONDITIONAL = 1 indicator only. 40-70%. Needs strong contextual justification.\n'
+ '    NO ENTRY = 0 indicators\n'
+ '  - Sustainability tiers (with player-level shooter breakdown)\n'
+ '  - TP (Throughput) and LS (Lead Safety) classifications\n'
+ '  - Per-quarter stats flow showing trends\n\n'
+ 'YOUR ANALYTICAL JOBS:\n'
+ '1. FWP (Framework Win Probability) — game-state-aware win probability.\n'
+ '   Factor in: score margin, quarter, time remaining, structural control, closing dynamics, team identity.\n'
+ '   FWP reflects who you predict WINS — not who currently leads. A team trailing on variance with DOMINANT conviction can have >50% FWP.\n'
+ '   Output BOTH teams with alias labels. Must sum to ~100%.\n'
+ '   COHERENCE: Higher conviction → FWP should reflect greater certainty for control team (all else equal).\n\n'
+ '2. NARRATIVE — plain English structural read for non-technical subscribers.\n'
+ '   Lead with the action: what should the reader do or watch for?\n'
+ '   Explain the structural edge in simple terms. Translate indicator language.\n'
+ '   Name specific stats that drive the read (e.g., "DEN dominating paint 48-22 and controlling runs 7 to 3").\n'
+ '   2-3 sentences max.\n\n'
+ '3. RISK FLAGS — what could go wrong despite the structural read.\n'
+ '   Look for: foul trouble on key players, quarter-over-quarter trend erosion, sustainability concerns,\n'
+ '   closing lineup questions, momentum shifts the indicators haven\'t fully captured.\n'
+ '   If conviction is DOMINANT and no real risk exists, say "NONE — structural dominance across all dimensions."\n'
+ '   1-2 sentences.\n\n'
+ '4. CLOSING PROJECTION — how does this game resolve from here?\n'
+ '   Given the structural state, margin, and time remaining, what happens?\n'
+ '   Be specific: "DEN closes on a 12-4 run in the final 4 minutes as POR\'s shooting regresses."\n'
+ '   1 sentence.\n\n'
+ '5. DISAGREEMENT — if your contextual read of the reference data conflicts with mechanical conviction,\n'
+ '   flag it here with reasoning. You cannot change the conviction tier, but you can explain why\n'
+ '   you think the situation is better or worse than the tier suggests.\n'
+ '   Examples: "Floor is 0.85 STRONG but biggest lead was built in Q1 and control is eroding every quarter."\n'
+ '   "Conviction is MODEST but this team\'s 4th-foul situation on their rim protector will collapse I2 by Q4."\n'
+ '   Say "NONE" if you agree with mechanical conviction.\n\n'
+ 'REFERENCE DATA (available for your analysis — use as needed, do not recompute indicators from it):\n'
+ '  - Per-quarter stats breakdown with team labels\n'
+ '  - Raw box score stats (paint, steals, assists, 3PT, etc.)\n'
+ '  - PBP run data and scoring patterns\n'
+ '  - Sustainability audit detail (personnel tiers, Bayesian regression, shot type proxy)\n'
+ '  - Lead composition (structural vs variance points)\n'
+ '  - Odds and spread data\n'
+ '  - ESPN Win Probability\n'
+ '  - Team WP Identity Profiles (COMEBACK, FRONTRUNNER, VOLATILE, CLOSER, STEADY)\n'
+ '  - Rolling window (recent ~2-quarter control trend)\n'
+ '  - Gap acceleration (is edge compounding or fading)\n'
+ '  - Directional arrows (per-quarter sub-metric trends)\n'
+ '  - Bonus status\n'
+ '  - XGB structural model (independent 13-feature raw-stats win probability model)\n'
+ '  - Monte Carlo trajectory (possession-level simulation from last 20 possessions projected forward)\n\n'
+ 'XGB CONVICTION QUALITY:\n'
+ '  XGB is an independent raw-stat model (13 features, 300 trees). It is NOT derived from the floor.\n'
+ '  When XGB and floor ALIGN (within 15pp), structural conviction is confirmed by two independent signals.\n'
+ '  When DIVERGENT: XGB sees something floor misses (or vice versa). Investigate SHAP drivers.\n'
+ '  Conviction basis: STRUCTURAL (paint/pot/steals driven — durable) vs VOLATILE (efg/rim driven — fragile).\n'
+ '  Scoreboard confirmation: if the leading SHAP driver (e.g. paint_diff) matches the box score reality, conviction is confirmed.\n'
+ '  If SHAP says paint dominance but box score shows paint is close, conviction is UNCONFIRMED — FWP should reflect uncertainty.\n'
+ '  CRITICAL: XGB biglead feature locks permanently at max lead — it cannot shrink. In comeback games, XGB will overstate\n'
+ '  the leading team because biglead SHAP contribution stays frozen. When biglead is the top SHAP driver and margin has\n'
+ '  compressed significantly, discount XGB and weight MC and recent window more heavily.\n\n'
+ 'MONTE CARLO STRUCTURAL INVESTIGATION:\n'
+ '  MC computes win probability from RECENT possession-level rates (last 20 possessions), NOT cumulative stats.\n'
+ '  MC is immune to the cumulative anchoring that affects floor and XGB.\n'
+ '  TRUST HIERARCHY when MC investigation is active: MC > XGB > Floor > Graduation badge.\n'
+ '  MC patterns: CLEAN = sustained collapse (72.6% precision Q3+, confirmed). WAVE = oscillating, 60% — risk flag only.\n'
+ '  NORMALIZED = rates recovered, hold validated. Investigation active = await classification.\n'
+ '  Always-on MC trajectory (mc_win_prob): available every poll Q2+. Shows structural trend independent of cumulative anchoring.\n'
+ '  When floor says 0.90 and MC says 0.30, MC is right — floor is anchored to stale early-game data.\n'
+ '  Q2 MC caveat: Q2 fires have 24+ minutes remaining for recovery. Frame as early warning, not confirmed collapse.\n\n'
+ 'DATA QUALITY NOTE — PAINT POINTS:\n'
+ '  SR often delays or zeros out points_in_the_paint in the game summary JSON.\n'
+ '  Use DEPTH AUDIT rim section or LEAD COMPOSITION structural points as the authoritative paint signal.\n\n'
+ 'SUSTAINABILITY RULES:\n'
+ '  - LOCKED IN/DURABLE = shooting is at or below baseline from players who CAN shoot. Sustainable.\n'
+ '  - STALLED = 3PT below 95% of season baseline AND 2PT% below 85% of league baseline — genuine offensive collapse, not a cold stretch. Regression unreliable.\n'
+ '  - FRAGILE/UNSUSTAINABLE = shooting above baseline, driven by non-shooters or unsustainable volume.\n'
+ '  - When referencing sustainability in your narrative, verify which team has which tier.\n'
+ '    Do NOT attribute UNSUSTAINABLE to the wrong team.\n\n'
+ 'BONUS STATUS RULE:\n'
+ '  "TeamX IN BONUS" = TeamX BENEFITS (free throws on every foul). Pure upside for TeamX.\n'
+ '  When one team is in bonus before 4:00 of any quarter: structural I2 multiplier.\n'
+ '  When BOTH in bonus: advantage neutralizes.\n\n'
+ 'OUTPUT FORMAT (follow exactly — each field on its own line):\n\n'
+ 'FWP: [AwayAlias] XX% / [HomeAlias] YY%\n'
+ 'EDGE: [+X% | No market data]\n'
+ 'RISK: [1-2 sentences identifying what could undermine the structural read, or NONE]\n'
+ 'CLOSING: [1-sentence projection of how the game resolves]\n'
+ 'NARRATIVE: [2-3 sentence plain English read for subscribers — lead with action, explain structural edge, name key stats]\n'
+ 'Sustainability: [TeamA]: [tier] | [TeamB]: [tier]\n'
+ 'Lead Source: [STRUCTURAL | VARIANCE | MIXED | EVEN] — [1-line]\n'
+ 'DISAGREEMENT: [NONE | 1-2 sentences explaining where you disagree with mechanical conviction and why]\n\n'
+ 'Be concise. Decisive when the indicators are clear. Your value is context and projection, not recomputing what the engine already knows.';

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
    var quarterDiffs = body.quarterDiffs || null;
    var acceleration = body.acceleration;
    var subMetricArrows = body.subMetricArrows;
    var adjustment = body.adjustment;
    var combinedRead = body.combinedRead;
    var wpProfiles = body.wpProfiles || null;
    var espnWP = body.espnWP || null;
    var dashboardScores = body.dashboardScores || null;
    var conviction = body.conviction || null;
    var throughputData = body.throughput || null;
    var leadSafetyData = body.leadSafety || null;
    var volumeThreatData = body.volumeThreat || null;
    var xgbData = body.xgbData || null;
    var mcData = body.mcData || null;
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

    // ── BONUS STATUS ──
    var bonusSection = '';
    var bonusStatus = body.bonusStatus;
    var gameClock = body.gameClock;
    var gamePeriod = body.gamePeriod || 0;
    if (bonusStatus && gamePeriod >= 1) {
      var clockMins = 12;
      if (gameClock) {
        // Strip period prefix if present ("Q4 8:03" → "8:03", "Q3 :15.2" → ":15.2")
        var cleanClock = gameClock.replace(/^(?:Q\d+|OT\d?)\s+/i, '');
        if (/^END\s|^Half/i.test(gameClock)) cleanClock = '0:00';
        if (/^:\d/.test(cleanClock)) cleanClock = '0' + cleanClock; // ":45.0" → "0:45.0"
        var cp = cleanClock.split(':');
        clockMins = (parseInt(cp[0]) || 0) + (parseInt(cp[1] || 0) / 60);
      }
      var homeInBonus = bonusStatus.home || false;
      var awayInBonus = bonusStatus.away || false;
      var homeDouble = bonusStatus.homeDouble || false;
      var awayDouble = bonusStatus.awayDouble || false;
      if (homeInBonus || awayInBonus) {
        var bothInBonus = homeInBonus && awayInBonus;
        bonusSection = '\nBONUS STATUS: ';
        if (bothInBonus) {
          bonusSection += 'BOTH teams in bonus — advantage NEUTRALIZED\n';
        } else {
          var bonusTeam = homeInBonus ? homeTeam : awayTeam;
          var penalizedTeam = homeInBonus ? awayTeam : homeTeam;
          bonusSection += bonusTeam + ' IN BONUS (BENEFITS ' + bonusTeam + ', PENALIZES ' + penalizedTeam + ')';
          if (clockMins >= 4.0) {
            bonusSection += ' with ' + clockMins.toFixed(1) + ' min remaining — STRUCTURAL I2 MULTIPLIER.\n';
            bonusSection += '  ' + bonusTeam + ' GAINS: Every drive/paint touch = automatic free throws. Compounds every possession.\n';
            bonusSection += '  ' + penalizedTeam + ' LOSES: Cannot play physical defense. Their players risk fouling out. Interior defense compromised.\n';
          } else {
            bonusSection += ' with ' + clockMins.toFixed(1) + ' min remaining\n';
          }
        }
      }
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
      edgeSection = '\nEDGE HISTORY (edge = FWP minus market implied prob, FWP = your prior Framework Win Probability):\n' + edgeHistory.map(function(e) { return (e.time||'?') + ' | ' + (e.edge||'?') + ' FWP ' + (e.fwp||'?') + ' | ' + (e.control||'?') + ' ' + (e.score||'?'); }).join('\n') + '\n';
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
          if (tm.threes.corner && tm.threes.above) pbpSection += '  Corner: ' + tm.threes.corner.made + '/' + tm.threes.corner.att + ' | Above: ' + tm.threes.above.made + '/' + tm.threes.above.att + '\n';
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
          pbpSection += '  TOs: ' + (tm.tos.forced||0) + ' forced / ' + (tm.tos.unforced||0) + ' unforced' + (tm.tos.unknown > 0 ? ' / ' + tm.tos.unknown + ' unclear' : '') + '\n';
          (tm.tos.byPlayer||[]).forEach(function(to) {
            pbpSection += '    Q' + (to.q||'?') + ' ' + (to.p||'?') + ' — ' + (to.forced === true ? 'FORCED' : to.forced === false ? 'UNFORCED' : '?') + ' (' + (to.type || '?') + ')\n';
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
        var windowLabel = rollingWindow.possessionBased
          ? 'Last ' + rollingWindow.windowPossessions + ' possessions, ' + (rollingWindow.timeSpanMin||0).toFixed(1) + ' min'
          : (rollingWindow.crossFade ? rollingWindow.windowQuarters.join('+') : rollingWindow.windowQuarters.map(function(q){return 'Q'+q;}).join('+')) + ', ' + (rollingWindow.windowPossessions||'?') + ' poss';
        windowSection = '\nROLLING WINDOW (' + windowLabel + '):\n';
        windowSection += 'Control: ' + rollingWindow.controlTeam + ' ' + (rollingWindow.score != null ? rollingWindow.score.toFixed(2) : '?') + '\n';
        ['I1','I2','I3','I4','I5'].forEach(function(k) {
          var ind = rollingWindow[k];
          if (ind && ind.score != null) windowSection += '  ' + k + ': ' + ind.score.toFixed(1) + ' \u2014 ' + (ind.detail||'') + '\n';
        });
        if (rollingWindow.possessionBased && rollingWindow.enrichSummary) {
          windowSection += '\nWINDOW INSIGHTS:\n' + rollingWindow.enrichSummary;
        }
        windowSection += 'Data quality: ' + (rollingWindow.dataQuality||'?') + (rollingWindow.missingFields && rollingWindow.missingFields.length > 0 ? ' (missing: ' + rollingWindow.missingFields.join(', ') + ')' : '') + '\n';
      } else {
        windowSection = '\nROLLING WINDOW: ' + (rollingWindow.reason || 'TOO EARLY') + '\n';
      }
    }

    // Per-quarter stat breakdown from server quarter_data
    var quarterSection = '';
    if (quarterDiffs && Object.keys(quarterDiffs).length > 0) {
      quarterSection = '\nPER-QUARTER BREAKDOWN:\n';
      var qdKeys = Object.keys(quarterDiffs).map(Number).filter(function(n){return !isNaN(n);}).sort(function(a,b){return a-b;});
      var hAlias = body.homeTeam || 'HOME', aAlias = body.awayTeam || 'AWAY';
      qdKeys.forEach(function(qk) {
        var qd = quarterDiffs[qk];
        if (!qd || !qd.home || !qd.away) return;
        var h = qd.home, a = qd.away;
        var isPartial = rollingWindow && rollingWindow.windowQuarters && rollingWindow.windowQuarters.some(function(wq){return wq === 'Q'+qk+'*';});
        var label = 'Q' + qk + (isPartial ? '*' : '');
        var hPaint = h.points_in_the_paint || h.points_in_paint || 0;
        var aPaint = a.points_in_the_paint || a.points_in_paint || 0;
        quarterSection += '  ' + label + ' (' + hAlias + ' vs ' + aAlias + '):'
          + ' Paint ' + hAlias + ':' + hPaint + ' ' + aAlias + ':' + aPaint
          + ' | FT ' + hAlias + ':' + (h.free_throws_made||0) + '/' + (h.free_throws_att||0) + ' ' + aAlias + ':' + (a.free_throws_made||0) + '/' + (a.free_throws_att||0)
          + ' | 3P ' + hAlias + ':' + (h.three_points_made||0) + '/' + (h.three_points_att||0) + ' ' + aAlias + ':' + (a.three_points_made||0) + '/' + (a.three_points_att||0)
          + ' | AST ' + hAlias + ':' + (h.assists||0) + ' ' + aAlias + ':' + (a.assists||0)
          + ' | TO ' + hAlias + ':' + (h.turnovers||h.total_turnovers||0) + ' ' + aAlias + ':' + (a.turnovers||a.total_turnovers||0)
          + ' | STL ' + hAlias + ':' + (h.steals||0) + ' ' + aAlias + ':' + (a.steals||0)
          + (h.possessions ? ' | Poss ' + hAlias + ':' + (h.possessions||0) + ' ' + aAlias + ':' + (a.possessions||0) : '')
          + '\n';
      });
    }

    var gapSection = '';
    if (acceleration && acceleration.entries && acceleration.entries.length > 0) {
      var lastEntry = acceleration.entries[acceleration.entries.length - 1];
      gapSection = '\nGAP ACCELERATION (gap = floor score difference between teams, positive = ctrl advantage):\n';
      gapSection += 'Gap: ' + (lastEntry.gap >= 0 ? '+' : '') + (lastEntry.gap != null ? lastEntry.gap.toFixed(3) : '?') + ' | Acceleration: ' + acceleration.accel + ' (' + acceleration.consecutive + ' consecutive)\n';
      gapSection += 'History: ' + acceleration.entries.slice(-5).map(function(e) { return (e.gap >= 0 ? '+' : '') + (e.gap != null ? e.gap.toFixed(2) : '?') + ' (' + e.score + ')'; }).join(' → ') + '\n';
    } else if (acceleration) {
      gapSection = '\nGAP: ' + (acceleration.accel || 'TOO EARLY') + '\n';
    }

    var arrowSection = '';
    if (subMetricArrows && (subMetricArrows.home || subMetricArrows.away)) {
      arrowSection = '\nDIRECTIONAL ARROWS (quarter-over-quarter trends, ▲=rising ▼=falling ▬=flat, values in parens are per-quarter raw stats):\n';
      var arrowOrder = [
        {header: 'I2 INTERIOR', keys: ['paint','atRim','fta']},
        {header: 'I1 DISRUPTION', keys: ['steals','tos']},
        {header: 'I3 SHOT QUALITY', keys: ['fg3aShare','astRatio']},
        {header: 'I5 EXECUTION', keys: ['poss']},
      ];
      arrowSection += String('').padEnd(12) + String(homeTeam||'HOME').padEnd(18) + String(awayTeam||'AWAY') + '\n';
      arrowOrder.forEach(function(grp) {
        arrowSection += grp.header + ':\n';
        grp.keys.forEach(function(key) {
          var hm = subMetricArrows.home ? subMetricArrows.home[key] : null;
          var am = subMetricArrows.away ? subMetricArrows.away[key] : null;
          var label = String(hm ? hm.label : (am ? am.label : key));
          var hStr = String(hm && hm.arrow ? (hm.display || '?') : '—');
          var aStr = String(am && am.arrow ? (am.display || '?') : '—');
          arrowSection += '  ' + label.padEnd(10) + hStr.padEnd(18) + aStr + '\n';
        });
      });
    }

    var adjustmentSection = '';
    if (adjustment && adjustment.signal && adjustment.signal !== 'NO ADJUSTMENT' && adjustment.signal !== 'NO DATA') {
      adjustmentSection = 'ADJUSTMENT: ' + adjustment.signal + ' (' + (adjustment.team || '?') + ') — ' + (adjustment.note || '') + '\n';
    }

    var combinedReadSection = '';
    if (combinedRead && combinedRead.read) {
      combinedReadSection = '\nCOMBINED READ (cumulative + rolling window synthesis): ' + combinedRead.read + ' — ' + (combinedRead.note || '') + '\n';
    }

    // ── WP IDENTITY PROFILES (from DB — weekly batch) ──
    var wpSection = '';
    if (wpProfiles) {
      wpSection = '\n' + wpProfiles + '\n';
    }

    // ── ESPN WIN PROBABILITY (live model) ──
    var espnWPSection = '';
    if (espnWP && (espnWP.home != null || espnWP.away != null)) {
      var wpHome = espnWP.home != null ? espnWP.home : '?';
      var wpAway = espnWP.away != null ? espnWP.away : '?';
      var wpHomeAlias = espnWP.homeAlias || homeTeam;
      var wpAwayAlias = espnWP.awayAlias || awayTeam;
      espnWPSection = '\nESPN WIN PROBABILITY (live model):\n';
      espnWPSection += wpHomeAlias + ' ' + wpHome + '% / ' + wpAwayAlias + ' ' + wpAway + '%';
      if (espnWP.opening != null) {
        espnWPSection += ' | Opening: ' + wpHomeAlias + ' ' + espnWP.opening + '%';
      }
      espnWPSection += ' (' + (espnWP.dataPoints || 0) + ' data points)\n';
      espnWPSection += 'NOTE: ESPN WP is a reference model, not ground truth. It uses play-by-play and score context.\n';
      espnWPSection += 'DIVERGENCE CHECK: If your FWP diverges >15% from ESPN WP, explain WHY in your analysis.\n';
      espnWPSection += 'Common valid divergences: sustainability concern ESPN misses, structural control not reflected in score, foul trouble.\n';
    }

    // ── GROUND TRUTH (mechanical indicators — matches formatSonnetPrompt) ──
    var groundTruthSection = '';
    if (dashboardScores && dashboardScores.controlTeam) {
      var ctrlHome = dashboardScores.controlTeam === homeTeam;
      function ctrlScore(ind) {
        if (!ind || ind.score == null) return null;
        return ctrlHome ? ind.score : 1 - ind.score;
      }
      var i1c = ctrlScore(dashboardScores.I1);
      var i2c = ctrlScore(dashboardScores.I2);
      var i3c = ctrlScore(dashboardScores.I3);
      var i4c = ctrlScore(dashboardScores.I4);
      var i5c = ctrlScore(dashboardScores.I5);
      groundTruthSection = 'GROUND TRUTH (mechanical engine — do not override):\n';
      groundTruthSection += 'Control: ' + dashboardScores.controlTeam + ' '
        + (dashboardScores.score != null ? Number(dashboardScores.score).toFixed(2) : '?')
        + ' (floor = weighted I1-I5 composite, 0-1) | ';
      groundTruthSection += 'Conviction: ' + (conviction ? conviction.tier : 'N/A')
        + ' (' + (conviction ? conviction.combo : 'N/A') + ')';
      if (conviction && conviction.pairs && conviction.pairs.length > 0) {
        groundTruthSection += ' | Killer pairs: ' + conviction.pairs.join(', ');
      }
      if (conviction && conviction.isDanger) groundTruthSection += ' | DANGER COMBO';
      groundTruthSection += '\n';
      groundTruthSection += '(Indicator scale: 1.0=ctrl dominates, 0.0=opponent dominates, 0.5=even. Won >=0.55, lost <=0.45)\n';
      groundTruthSection += 'I1 Disruption: ' + (dashboardScores.I1 ? dashboardScores.I1.leader || 'EVEN' : '?') + ' ' + (i1c != null ? i1c.toFixed(1) : '?') + ' | ';
      groundTruthSection += 'I2 Interior: ' + (dashboardScores.I2 ? dashboardScores.I2.leader || 'EVEN' : '?') + ' ' + (i2c != null ? i2c.toFixed(1) : '?') + ' | ';
      groundTruthSection += 'I3 Shot Quality: ' + (dashboardScores.I3 ? dashboardScores.I3.leader || 'EVEN' : '?') + ' ' + (i3c != null ? i3c.toFixed(1) : '?') + ' | ';
      groundTruthSection += 'I4 Game Control: ' + (dashboardScores.I4 ? dashboardScores.I4.leader || 'EVEN' : '?') + ' ' + (i4c != null ? i4c.toFixed(1) : '?') + ' | ';
      groundTruthSection += 'I5 Execution: ' + (dashboardScores.I5 ? dashboardScores.I5.leader || 'EVEN' : '?') + ' ' + (i5c != null ? i5c.toFixed(1) : '?') + '\n';
      if (conviction && conviction.indicatorsWon) {
        groundTruthSection += 'Indicators won by ' + dashboardScores.controlTeam + ': '
          + (conviction.indicatorsWon.length > 0 ? conviction.indicatorsWon.join('+') : 'NONE');
        if (conviction.indicatorsLost && conviction.indicatorsLost.length > 0) {
          groundTruthSection += ' | Lost: ' + conviction.indicatorsLost.join('+');
        }
        groundTruthSection += '\n';
      }
      groundTruthSection += '\n';
    }

    // ── THROUGHPUT / LEAD SAFETY ──
    var tpLsSection = '';
    if (throughputData) {
      tpLsSection += '\nTHROUGHPUT (trailing team comeback projection): ' + throughputData.classification + '\n';
      tpLsSection += '  Deficit: ' + throughputData.deficit + ' | Expected swing: ' + throughputData.expected + ' pts | Remaining poss: ' + (throughputData.remainingPoss || '?') + '\n';
      tpLsSection += '  Ctrl structRate: ' + (throughputData.ctrlStructRate != null ? Number(throughputData.ctrlStructRate).toFixed(2) : '?')
        + ' | Opp structRate: ' + (throughputData.oppStructRate != null ? Number(throughputData.oppStructRate).toFixed(2) : '?') + '\n';
    }
    if (leadSafetyData) {
      tpLsSection += '\nLEAD SAFETY (leading team margin security): ' + leadSafetyData.classification + '\n';
      tpLsSection += '  Lead: ' + leadSafetyData.lead + ' | Expected opp recovery: ' + leadSafetyData.expected + ' pts | Remaining poss: ' + (leadSafetyData.remainingPoss || '?') + '\n';
    }

    // ── VOLUME THREAT ──
    var volumeSection = '';
    if (volumeThreatData) {
      var hVT = volumeThreatData.home, aVT = volumeThreatData.away;
      if ((hVT && hVT.active) || (aVT && aVT.active) || (hVT && hVT.mitigated) || (aVT && aVT.mitigated)) {
        volumeSection = '\nVOLUME THREAT DETECTION:\n';
        if (hVT && hVT.active) {
          volumeSection += homeTeam + ': ACTIVE — projected ' + hVT.projected3PA + ' 3PA (live ' + hVT.live3PA + '), '
            + hVT.live3Pct + '% (szn ' + hVT.baseline + '%), C&S 3PM: ' + hVT.cs3PM + '\n';
          volumeSection += '  Scheme-driven perimeter production at baseline. This is structural offense, not variance.\n';
          volumeSection += '  Floor discount: ' + Math.round(hVT.discount * 100) + '% | TP/LS structRate bonus: ' + hVT.vtBonus
            + (hVT.mitigated && aVT ? ' (partially mitigated — ' + awayTeam + ' has ' + aVT.live3PA + ' 3PA, ratio:' + hVT.mitRatio + ')' : '') + '\n';
        } else if (hVT && hVT.mitigated) {
          volumeSection += homeTeam + ': MITIGATED — projected ' + hVT.projected3PA + ' 3PA but ' + awayTeam
            + ' matching volume (' + (aVT ? aVT.live3PA : '?') + ' 3PA, ratio:' + hVT.mitRatio + '). Shared game profile.\n';
        }
        if (aVT && aVT.active) {
          volumeSection += awayTeam + ': ACTIVE — projected ' + aVT.projected3PA + ' 3PA (live ' + aVT.live3PA + '), '
            + aVT.live3Pct + '% (szn ' + aVT.baseline + '%), C&S 3PM: ' + aVT.cs3PM + '\n';
          volumeSection += '  Scheme-driven perimeter production at baseline. This is structural offense, not variance.\n';
          volumeSection += '  Floor discount: ' + Math.round(aVT.discount * 100) + '% | TP/LS structRate bonus: ' + aVT.vtBonus
            + (aVT.mitigated && hVT ? ' (partially mitigated — ' + homeTeam + ' has ' + hVT.live3PA + ' 3PA, ratio:' + aVT.mitRatio + ')' : '') + '\n';
        } else if (aVT && aVT.mitigated) {
          volumeSection += awayTeam + ': MITIGATED — projected ' + aVT.projected3PA + ' 3PA but ' + homeTeam
            + ' matching volume (' + (hVT ? hVT.live3PA : '?') + ' 3PA, ratio:' + aVT.mitRatio + '). Shared game profile.\n';
        }
        if ((hVT && hVT.active) || (aVT && aVT.active)) {
          volumeSection += 'HOW TO USE: A team with active volume threat has a structural perimeter counter-engine. The control team\'s structural edge is overstated — discount conviction and FWP accordingly. Do NOT treat baseline-rate 3PT shooting from a volume threat team as variance to regress.\n';
        }
      }
    }

    // ── XGB STRUCTURAL MODEL ──
    var xgbSection = '';
    if (xgbData && xgbData.winProb != null) {
      xgbSection = '\nXGB STRUCTURAL MODEL:\n';
      xgbSection += 'XGB win probability: ' + (xgbData.winProb * 100).toFixed(1) + '% | Floor: ' + (dashboardScores && dashboardScores.floor ? (dashboardScores.floor * 100).toFixed(1) + '%' : '?') + ' | ' + (xgbData.aligned ? 'ALIGNED' : 'DIVERGENT (' + (xgbData.divergence > 0 ? '+' : '') + (xgbData.divergence * 100).toFixed(1) + '%)') + '\n';
      if (xgbData.shap && xgbData.shap.length > 0) {
        xgbSection += 'SHAP drivers: ' + xgbData.shap.map(function(s) { return s.f + '=' + (s.v > 0 ? '+' : '') + s.v.toFixed(2); }).join(', ') + '\n';
      }
      if (xgbData.convictionQuality) {
        var cq = xgbData.convictionQuality;
        xgbSection += 'Conviction basis: ' + (cq.basis || '?') + ' | Top driver: ' + (cq.topDriver || '?') + ' | Scoreboard: ' + (cq.scoreboard || '?') + '\n';
        if (cq.warning) xgbSection += 'XGB WARNING: ' + cq.warning + '\n';
      }
      if (xgbData.trajectorySignals && xgbData.trajectorySignals.warnings && xgbData.trajectorySignals.warnings.length > 0) {
        xgbSection += 'Trajectory warnings:\n' + xgbData.trajectorySignals.warnings.join('\n') + '\n';
      }
    }

    // ── MONTE CARLO STRUCTURAL INVESTIGATION ──
    var mcSection = '';
    if (mcData) {
      if (mcData.mcWinProb != null) {
        mcSection = '\nMONTE CARLO (always-on trajectory):\n';
        mcSection += 'MC win probability: ' + (mcData.mcWinProb * 100).toFixed(1) + '% (ctrl team, last 20 possessions projected forward)\n';
      }
      if (mcData.investigation) {
        var inv = mcData.investigation;
        mcSection += '\nMC STRUCTURAL INVESTIGATION:\n';
        mcSection += 'Status: ' + (inv.pattern ? inv.pattern : 'INVESTIGATING') + ' | Ctrl: ' + (inv.ctrlTeam || '?') + ' | Triggered: Q' + (inv.triggerPeriod || '?') + ' ' + (inv.triggerClock || '?') + ' at margin +' + (inv.triggerMargin || '?') + '\n';
        if (inv.currentMC != null) mcSection += 'Current investigation MC: ' + (inv.currentMC * 100).toFixed(1) + '%\n';
        if (inv.verdicts && inv.verdicts.length > 0) mcSection += 'Verdict sequence: ' + inv.verdicts.join(' > ') + '\n';
        if (inv.pattern === 'CLEAN') mcSection += 'CLEAN = sustained structural collapse confirmed. Post-trigger rates never recovered. MC > XGB > Floor when active.\n';
        else if (inv.pattern === 'WAVE') mcSection += 'WAVE = oscillating collapse. Rates deteriorated, recovered, then deteriorated again. 60% precision — flag as risk, do not confirm.\n';
        else if (inv.pattern === 'NORMALIZED') mcSection += 'NORMALIZED = rates recovered after initial deterioration. Hold validated — position is stronger for having been tested.\n';
        else if (!inv.pattern) mcSection += 'Investigation in progress — awaiting enough post-trigger data for pattern classification.\n';
        if (inv.alertSent) mcSection += 'MC_COLLAPSE alert has been sent to subscribers.\n';
      }
    }

    // ── BUILD PROMPT ──
    var userPrompt = awayTeam + ' @ ' + homeTeam + ' | ' + period + ' | ' + score + '\n\n'
      + groundTruthSection
      + (thesis ? 'THESIS:\n' + thesis + '\n' : 'No thesis.')
      + '\n' + clutchSection + oddsSection + tpLsSection + bonusSection + trackingSection + sustainabilitySection + leadCompSection
      + windowSection + quarterSection + gapSection + combinedReadSection + arrowSection + adjustmentSection
      + pbpSection + volumeSection + xgbSection + mcSection + edgeSection + narrativeSection + wpSection + espnWPSection
      + '\nGAME DATA:\n' + JSON.stringify(summaryData);

    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 2500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

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
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: err.message, stack: (err.stack || '').substring(0, 500) }) };
  }
};

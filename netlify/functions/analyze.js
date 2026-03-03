// Live Game Analysis via Claude Sonnet - Predictive Layer v3.1
// Added: 3PT Sustainability Audit (personnel, Bayesian regression, shot type, tiered output)

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
// SYSTEM PROMPT
// ══════════════════════════════════════════════════════════════════════════════

var SYSTEM_PROMPT = 'You are an elite NBA live-game analyst providing real-time control assessment and outcome prediction for sports betting.\n\n'
+ 'CORE TASK: Determine which team structurally controls this game and predict who wins, using the full game summary data provided.\n\n'
+ 'FIVE INDICATORS (score each 0.00-1.00 for the controlling team):\n'
+ 'I1 Possession & Transition (25%): TO margin, steals, OREBs, fast break pts, pts off TOs, second chance pts\n'
+ 'I2 Rim Pressure & Foul (25%): Paint points, at-rim FG, FTA, blocks, fouls, bonus status\n'
+ 'I3 Shot Quality & Creation (20%): eFG%, assist ratio (65%+ sustainable, <50% isolation-dependent), shot diet\n'
+ 'I4 Lineup Integrity (20%): Biggest lead, bench contribution, which lineups producing, plus/minus\n'
+ 'I5 Tempo & Efficiency (10%): Possessions, pts/possession differential, pace control\n\n'
+ 'CONTROL: 0.90+ DOMINANT | 0.75-0.89 STRONG | 0.60-0.74 EARNED | 0.45-0.59 NO EDGE | <0.45 WAIT\n\n'
+ 'EIGHT TRAJECTORY SIGNALS (evaluate for BOTH teams):\n'
+ 'T1 Role Player Heater | T2 Star Process Integrity | T3 Quarter Delta (highest weight) | T4 Foul Gate | T5 Interior Trend | T6 Quarter Assist Ratio | T7 Closing Lineup | T8 Shot Diet Misalignment\n\n'
+ 'CRITICAL RULES:\n\n'
+ '1. SUSTAINABILITY IS YOUR PRIMARY LENS: A pre-computed 3PT SUSTAINABILITY AUDIT is provided for both teams. It contains:\n'
+ '   - PERSONNEL AUDIT: What % of 3PM came from ELITE shooters (38%+ season, 2+ 3PA/gm) vs NON-SHOOTERS (<33% or <0.8 3PA/gm)\n'
+ '   - BAYESIAN REGRESSION MODEL: Posterior expected 3PT% given season prior + live data. Includes regression probability accounting for sample size.\n'
+ '   - SHOT TYPE: Assist ratio proxy for catch-and-shoot (durable) vs pull-up/isolation (fragile), cross-referenced with season C&S and pull-up baselines\n'
+ '   - COMPOSITE TIER: LOCKED IN (structural) / DURABLE (mostly structural) / MIXED / FRAGILE (regression likely) / UNSUSTAINABLE (variance-driven)\n\n'
+ '   USE THESE TIERS DIRECTLY. Do not override unless you have specific evidence the audit missed. If you override, state why.\n\n'
+ '   When DEPTH AUDIT (PBP) data is provided, USE IT to enhance your reads:\n'
+ '   - 3PT assisted/unassisted splits override team-level assist ratio proxy — actual shot creation quality\n'
+ '   - Forced vs unforced TO classification enables I1 chaos layer — forced TOs are structural, unforced regress\n'
+ '   - Shot zone distribution vs structural identity enables precise T8 reads\n'
+ '   - Scoring run composition shows whether leads are paint/transition (structural) or perimeter heaters (variance)\n'
+ '   - At-rim contexts (drive/cut/putback/transition) show scheme-driven vs opportunity-driven interior pressure\n'
+ '   - Mid-range assisted/unassisted shows creation quality at that range\n\n'
+ '2. ENTRY STRATEGY — BUYING STRUCTURAL CONTROL AT A DISCOUNT:\n'
+ '   The user bets on the structurally dominant team WHEN TRAILING or at value odds because the opponent produces on unsustainable variance. This is the ONLY entry.\n\n'
+ '   OPTIMAL WINDOW = thesis team TRAILING + opponent 3PT tier FRAGILE/UNSUSTAINABLE. Maximum edge — opponent lead built on math that regresses.\n'
+ '   WINDOW OPEN = thesis team TRAILING or below ML threshold + opponent tier MIXED. Moderate edge — some regression expected.\n'
+ '   WINDOW CLOSING = thesis team now LEADING + opponent variance already cooling. Edge shrinking as market corrects.\n'
+ '   NO WINDOW = thesis team already leading at market-priced odds (no discount), OR opponent tier LOCKED IN/DURABLE (their lead is real).\n'
+ '   COUNTER-SIGNAL = thesis team trailing against LOCKED IN/DURABLE opponent. Pre-game thesis may be wrong. Do NOT buy.\n\n'
+ '   A team AHEAD and priced as heavy favorite has NO EDGE. Say "NO WINDOW — already priced in."\n\n'
+ '   SIGNAL line names the SPECIFIC TEAM to buy or says NO VALUE/PASS. Follow the edge — if thesis is DENIED but opponent has structural edge at value odds, SIGNAL that team instead.\n\n'
+ '3. SUSTAINABILITY TIER CAPS ON ENTRY:\n'
+ '   LOCKED IN/DURABLE opponent lead = COUNTER-SIGNAL (do not fade)\n'
+ '   MIXED opponent lead = CONDITIONAL (reduced conviction)\n'
+ '   FRAGILE opponent lead = ENTRY SUPPORTED\n'
+ '   UNSUSTAINABLE opponent lead = OPTIMAL WINDOW\n'
+ '   TOO EARLY = WAIT\n\n'
+ '4. EDGE IS COMPUTED CLIENT-SIDE: Just output your FWP accurately.\n\n'
+ '5. SPREAD ANALYSIS: Compare live spread against your structural projection. If you project Team A winning by 8-12 and spread is Team A -1.5, the spread is mispriced. If spread aligns with projection, say so. Always reference specific structural factors.\n\n'
+ '6. COHERENCE CHECK: Sustainability tier, entry signal, and prediction MUST align. Cannot call OPTIMAL WINDOW if opponent is DURABLE. Cannot call COUNTER-SIGNAL if opponent is UNSUSTAINABLE.\n\n'
+ '7. CONVICTION:\n'
+ '  DOMINANT = sustainable control 0.85+ by quality team, opponent FRAGILE/UNSUSTAINABLE\n'
+ '  STRONG = sustainable control 0.70+, opponent MIXED or worse\n'
+ '  EARNED = sustainable/mixed control 0.60+ with edge\n'
+ '  CONDITIONAL = sustainability concerns or quality gaps\n'
+ '  NO ENTRY = no structural edge, opponent LOCKED IN/DURABLE, or already priced in\n\n'
+ '8. TEAM QUALITY: Bad team (bottom-12, missing stars) leading good team (top-12, full strength) on FRAGILE/UNSUSTAINABLE shooting = ideal entry. State quality gap.\n\n'
+ '9. GAME NARRATIVE: When prior analysis history is provided, use it for continuity. Track how control, sustainability, and your signals have evolved across calls. Reference shifts explicitly: "Control climbed from 0.65→0.78 as opponent sustainability degraded MIXED→FRAGILE." If your prior read was wrong, own it. If the window you called earlier has closed, say so. Never repeat your prior read verbatim — each call should advance the narrative.\n\n'
+ 'OUTPUT FORMAT (follow exactly):\n\n'
+ 'DECISION:\n'
+ 'EDGE: [+X% | No market data] | FWP: [X%] | MIP: [X% | N/A]\n'
+ 'ENTRY: [OPTIMAL WINDOW | WINDOW OPEN | WINDOW CLOSING | NO WINDOW | COUNTER-SIGNAL]\n'
+ 'CONVICTION: [DOMINANT | STRONG | EARNED | CONDITIONAL | NO ENTRY]\n'
+ 'SIGNAL: [BUY TeamAlias | NO VALUE | PASS] — [1-line reason naming both teams]\n'
+ 'Sustainability: [TeamA]: [LOCKED IN|DURABLE|MIXED|FRAGILE|UNSUSTAINABLE] | [TeamB]: [LOCKED IN|DURABLE|MIXED|FRAGILE|UNSUSTAINABLE]\n'
+ 'SPREAD ANALYSIS: [1-line — is spread accurate given structural reads? e.g. "ORL -1.5 mispriced — DET projects winning outright by 6-10"]\n'
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
+ 'T1 — Role Player Heater: [TEAM_ALIAS] [player] [detail] or CLEAR (prefix with team alias in brackets of the team with the heater)\n'
+ 'T2 — Star Process Integrity: [TEAM_ALIAS] [player] [detail] or CLEAR (prefix with the cold star\'s team alias in brackets)\n'
+ 'T3 — Quarter Delta: [detail or CLEAR]\n'
+ 'T4 — Foul Gate: [TEAM_ALIAS] [player] [detail] or CLEAR (prefix with team alias of player in foul trouble)\n'
+ 'T5 — Interior Trend: [detail or CLEAR]\n'
+ 'T6 — Quarter Assist Ratio: [detail or CLEAR]\n'
+ 'T7 — Closing Lineup: [detail or CLEAR]\n'
+ 'T8 — Shot Diet Misalignment: [TEAM_ALIAS] [detail] or CLEAR (prefix with team alias of the misaligned team)\n\n'
+ 'THESIS STATUS: [CONFIRMED|DEVELOPING|CONTESTED|DENIED] — [note]\n'
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
      + '\n' + clutchSection + oddsSection + trackingSection + sustainabilitySection + pbpSection + edgeSection + narrativeSection
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
      body: JSON.stringify({ analysis: analysis, usage: data.usage, sustainabilityAudit: audit }),
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { statusCode: 504, headers: headers, body: JSON.stringify({ error: 'Analysis timed out (25s). Try again.' }) };
    }
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: err.message }) };
  }
};

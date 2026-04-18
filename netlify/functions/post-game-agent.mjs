// ══════════════════════════════════════════════════════════════════════════════
// post-game-agent.mjs — Nightly Post-Game Learning Agent
//
// Runs at 11:45pm MST (6:45am UTC) daily. For each day's games:
//   1. COLLECT: alerts, final scores, snapshots, agent decisions
//   2. SCORE: mark each alert correct/incorrect vs final outcome
//   3. ANALYZE: one Sonnet call to identify patterns across the full slate
//   4. STORE: save findings to `learnings` table
//
// This is the feedback loop that makes the alert system smarter over time.
// ══════════════════════════════════════════════════════════════════════════════

import { neon } from '@neondatabase/serverless';

function log(msg) { console.log(`[post-game-agent] ${msg}`); }

// Get today's date in Arizona time (UTC-7, no DST)
function getArizonaDate() {
  const now = new Date();
  const az = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  return {
    year: az.getUTCFullYear(),
    month: az.getUTCMonth() + 1,
    day: az.getUTCDate(),
    dateStr: `${az.getUTCFullYear()}-${String(az.getUTCMonth() + 1).padStart(2, '0')}-${String(az.getUTCDate()).padStart(2, '0')}`,
  };
}

// Fetch final scores from BDL
async function fetchFinalScores(dateStr) {
  const apiKey = process.env.BDL_API_KEY;
  if (!apiKey) { log('No BDL_API_KEY'); return []; }
  try {
    const resp = await fetch(`https://api.balldontlie.io/nba/v1/games?dates[]=${dateStr}`, {
      headers: { Authorization: apiKey },
    });
    if (!resp.ok) { log(`BDL scores ${resp.status}`); return []; }
    const data = await resp.json();
    const games = (data.data || []).map(g => ({
      home: g.home_team?.abbreviation,
      away: g.visitor_team?.abbreviation,
      homeScore: Number(g.home_team_score) || 0,
      awayScore: Number(g.visitor_team_score) || 0,
      status: g.status,
    }));
    games.forEach(g => log(`  BDL: ${g.away} ${g.awayScore} @ ${g.home} ${g.homeScore} [${g.status}]`));
    return games;
  } catch (e) { log(`BDL fetch error: ${e.message}`); return []; }
}

// Score a single alert against final outcome
function scoreAlert(alert, games) {
  // Find matching game
  const game = games.find(g => {
    const matchup = `${alert.control_team}`;
    return g.home === matchup || g.away === matchup;
  });
  if (!game || game.status !== 'Final') return null;

  const ctrlIsHome = game.home === alert.control_team;
  const ctrlFinalPts = Number(ctrlIsHome ? game.homeScore : game.awayScore) || 0;
  const oppFinalPts = Number(ctrlIsHome ? game.awayScore : game.homeScore) || 0;
  const ctrlWon = ctrlFinalPts > oppFinalPts;
  const finalMargin = ctrlFinalPts - oppFinalPts;

  // Alert-type-specific accuracy
  let correct = false;
  // V2 types
  if (['POSITION_OPEN', 'BWC_EDGE', 'POSITION_RECOVERING', 'POSITION_SAFE'].includes(alert.alert_type)) {
    correct = ctrlWon; // Hold signals — ctrl team should win
  } else if (['VALUE', 'THESIS_ALIVE'].includes(alert.alert_type)) {
    correct = ctrlWon; // Entry signals — ctrl team should win
  } else if (alert.alert_type === 'EXIT') {
    correct = !ctrlWon; // Exit warning — ctrl lost edge, alert correct if ctrl loses
  // V1 types (backward compat during transition)
  } else if (['BUY', 'WINDOW BUY', 'RECOVERY PATH', 'AUTO_ANALYSIS'].includes(alert.alert_type)) {
    correct = ctrlWon; // Control team should win
  } else if (alert.alert_type === 'BUY WINDOW CLOSING') {
    correct = ctrlWon; // BWC = control team leading, should hold
  } else if (alert.alert_type === 'LEAD CRUMBLING') {
    correct = !ctrlWon; // Lead crumbled = control team lost (alert was right about danger)
  } else if (alert.alert_type === 'LEAD LOST') {
    correct = !ctrlWon; // Lead lost = warning was correct
  } else if (alert.alert_type === 'VARIANCE BREAKING') {
    correct = ctrlWon; // Variance broke = control team should come back
  }

  // Spread accuracy
  let spreadCorrect = null;
  if (alert.spread != null) {
    const spreadVal = parseFloat(alert.spread);
    if (!isNaN(spreadVal)) {
      // Spread is from control team perspective (negative = favorite)
      spreadCorrect = (finalMargin + spreadVal) > 0;
    }
  }

  return {
    correct,
    ctrlWon,
    finalMargin,
    spreadCorrect,
    homeScore: game.homeScore,
    awayScore: game.awayScore,
  };
}

export default async function handler(req) {
  log('Post-game learning agent starting...');

  const sql = neon(process.env.DATABASE_URL);
  // Allow date override via query param for reprocessing
  const url = new URL(req.url, 'https://localhost');
  const dateOverride = url.searchParams.get('date');
  const today = dateOverride ? { dateStr: dateOverride } : getArizonaDate();
  log(`Processing date: ${today.dateStr}${dateOverride ? ' (manual override)' : ' (Arizona time)'}`);

  // ── 1. COLLECT ──────────────────────────────────────────────────────────

  // Check if we already ran today (idempotent)
  try {
    const existing = await sql`SELECT 1 FROM learnings WHERE date = ${today.dateStr} LIMIT 1`;
    if (existing.length > 0) {
      log(`Already processed ${today.dateStr}, skipping`);
      return new Response(JSON.stringify({ ok: true, message: 'Already processed' }));
    }
    // Claim the row immediately to prevent duplicate cron runs
    await sql`INSERT INTO learnings (date, games_analyzed, alerts_scored, findings) VALUES (${today.dateStr}, 0, 0, 'Processing...')`;
  } catch (e) {
    if (e.message && e.message.includes('duplicate') || e.message.includes('unique')) {
      log(`Race condition caught — another invocation claimed ${today.dateStr}`);
      return new Response(JSON.stringify({ ok: true, message: 'Already claimed' }));
    }
    log(`Learnings table check: ${e.message}`);
  }

  // Get today's alerts — filter by GAME date, not alert timestamp
  // (late-night MST games have UTC timestamps on the next calendar day)
  const alerts = await sql`
    SELECT a.*, g.away_alias, g.home_alias, g.date as game_date,
      g.winner as game_winner, g.home_pts as game_home_pts, g.away_pts as game_away_pts
    FROM alerts a
    JOIN games g ON a.game_id = g.id
    WHERE g.date = ${today.dateStr}
    ORDER BY a.ts
  `;
  log(`Found ${alerts.length} alerts for ${today.dateStr}`);

  if (alerts.length === 0) {
    log('No alerts to analyze');
    try {
      await sql`UPDATE learnings SET findings = 'No alerts fired today.' WHERE date = ${today.dateStr}`;
    } catch (e) { log(`Save empty learning: ${e.message}`); }
    return new Response(JSON.stringify({ ok: true, message: 'No alerts' }));
  }

  // Fetch final scores from BDL, fall back to games table if unavailable
  let finalScores = await fetchFinalScores(today.dateStr);
  log(`BDL returned ${finalScores.length} games`);

  if (finalScores.length === 0) {
    // Fallback: build scores from games table (already joined on alerts)
    const gameMap = {};
    alerts.forEach(a => {
      if (a.game_winner && !gameMap[a.game_id]) {
        gameMap[a.game_id] = {
          home: a.home_alias, away: a.away_alias,
          homeScore: Number(a.game_home_pts) || 0, awayScore: Number(a.game_away_pts) || 0,
          status: 'Final',
        };
      }
    });
    finalScores = Object.values(gameMap);
    if (finalScores.length > 0) {
      log(`BDL empty — using games table fallback (${finalScores.length} games)`);
    } else {
      log('No final scores available from BDL or games table');
      try { await sql`UPDATE learnings SET findings = 'No final scores available.' WHERE date = ${today.dateStr}`; } catch(e) {}
      return new Response(JSON.stringify({ ok: true, message: 'No final scores' }));
    }
  }

  // ── 2. SCORE ────────────────────────────────────────────────────────────

  const scoredAlerts = alerts.map(a => {
    const matchup = `${a.away_alias}@${a.home_alias}`;
    const result = scoreAlert(a, finalScores);
    return { ...a, matchup, result };
  }).filter(a => a.result !== null);

  log(`Scored ${scoredAlerts.length}/${alerts.length} alerts (rest had no final score)`);
  // Diagnostic: log first 10 scored alerts with details
  scoredAlerts.slice(0, 10).forEach(a => {
    log(`  ${a.alert_type} ${a.control_team} agent:${a.agent_decision||'NULL'} → ${a.result.correct ? 'CORRECT' : 'WRONG'} (ctrl ${a.result.ctrlWon ? 'won' : 'lost'} by ${a.result.finalMargin})`);
  });

  // ── V2 type classifications ──
  // Entry types = the money metric (subscriber opened a position based on this)
  const ENTRY_TYPES = ['BUY', 'VALUE', 'THESIS_ALIVE'];
  // Hold types = position updates for existing holders
  const HOLD_TYPES = ['POSITION_OPEN', 'BWC_EDGE', 'POSITION_RECOVERING', 'POSITION_SAFE', 'AUTO_ANALYSIS'];
  // Exit types = cash-out signals (correct when ctrl LOSES)
  const EXIT_TYPES = ['EXIT'];
  // V1 backward compat (transition period — will coexist with V2 until cutover stabilizes)
  const V1_ACTIONABLE = ['WINDOW BUY', 'BUY WINDOW CLOSING', 'RECOVERY PATH', 'VARIANCE BREAKING'];
  const V1_TRANSITIONAL = ['LEAD LOST', 'LEAD CRUMBLING'];
  // Combined: all types that go to ntfy
  const ALL_KNOWN = [...ENTRY_TYPES, ...HOLD_TYPES, ...EXIT_TYPES, ...V1_ACTIONABLE, ...V1_TRANSITIONAL];

  // Readable name map — subscriber-facing labels
  const READABLE = {
    'POSITION_OPEN': 'Position Open', 'BWC_EDGE': 'Holding', 'VALUE': 'Entry Value',
    'EXIT': 'Exit', 'THESIS_ALIVE': 'Second Chance', 'POSITION_RECOVERING': 'Strengthening',
    'POSITION_SAFE': 'Position Safe', 'AUTO_ANALYSIS': 'Position Update',
    'BUY': 'Buy', 'BUY WINDOW CLOSING': 'Buy Window Closing', 'WINDOW BUY': 'Window Buy',
    'RECOVERY PATH': 'Recovery Path', 'VARIANCE BREAKING': 'Variance Breaking',
    'LEAD LOST': 'Lead Lost', 'LEAD CRUMBLING': 'Lead Crumbling',
  };
  const readable = (t) => READABLE[t] || t;

  // Delivered = ntfy actually sent to user. Prefer ntfy_sent column, fall back to agent_decision for old data.
  const delivered = scoredAlerts.filter(a => a.ntfy_sent === true || (a.ntfy_sent == null && a.agent_decision !== 'SUPPRESS' && a.agent_decision !== 'FALLBACK_DROP'));
  const suppressed = scoredAlerts.filter(a => a.agent_decision === 'SUPPRESS');
  const deduped = scoredAlerts.filter(a => a.ntfy_sent === false && a.agent_decision !== 'SUPPRESS');

  // Split suppressed: agent decisions vs position-gate (never reached agent)
  const positionGated = suppressed.filter(a => a.agent_reasoning && a.agent_reasoning.includes('position gate'));
  const agentSuppressed = suppressed.filter(a => !a.agent_reasoning || !a.agent_reasoning.includes('position gate'));

  // Split agent suppressions: structural calls vs dedup (agent correctly blocked noise)
  const DEDUP_PATTERNS = ['duplicate', 'already sent', 'already SENT', 'bettor already has', 'already received', 'already been alerted', 'already correctly suppressed', 'resending', 'no meaningful change', 'zero meaningful change', 'below the 0.10 threshold', 'nothing new', 'no new actionable'];
  const isDedup = (r) => r && DEDUP_PATTERNS.some(p => r.toLowerCase().includes(p.toLowerCase()));
  const agentDedup = agentSuppressed.filter(a => isDedup(a.agent_reasoning));
  const agentStructural = agentSuppressed.filter(a => !isDedup(a.agent_reasoning));

  // ── HEADLINE: Entry accuracy (the money metric) ──
  const deliveredEntry = delivered.filter(a => ENTRY_TYPES.includes(a.alert_type));
  const deliveredEntryCorrect = deliveredEntry.filter(a => a.result.correct).length;
  const entryAccuracy = deliveredEntry.length > 0
    ? Math.round((deliveredEntryCorrect / deliveredEntry.length) * 100) : null;

  // ── HOLD accuracy (position updates — system trust metric) ──
  const deliveredHold = delivered.filter(a => HOLD_TYPES.includes(a.alert_type));
  const deliveredHoldCorrect = deliveredHold.filter(a => a.result.correct).length;

  // ── EXIT accuracy (correct when ctrl lost) ──
  const deliveredExit = delivered.filter(a => EXIT_TYPES.includes(a.alert_type));
  const deliveredExitCorrect = deliveredExit.filter(a => a.result.correct).length;

  // ── V1 compat: old actionable + transitional (transition period) ──
  const deliveredV1Actionable = delivered.filter(a => V1_ACTIONABLE.includes(a.alert_type));
  const deliveredV1ActionableCorrect = deliveredV1Actionable.filter(a => a.result.correct).length;
  const deliveredV1Transitional = delivered.filter(a => V1_TRANSITIONAL.includes(a.alert_type));
  const deliveredV1TransitionalHeld = deliveredV1Transitional.filter(a => a.result.correct).length;

  // Combined delivered headline: entry + V1 actionable (transition period blended number)
  const deliveredActionable = [...deliveredEntry, ...deliveredV1Actionable];
  const deliveredActionableCorrect = deliveredEntryCorrect + deliveredV1ActionableCorrect;
  const accuracyOverall = deliveredActionable.length > 0
    ? Math.round((deliveredActionableCorrect / deliveredActionable.length) * 100) : entryAccuracy;

  // Agent saves — structural suppression that would have been wrong
  const agentSaves = agentStructural.filter(a => !a.result.correct).length;
  // Agent misses — structural suppression that would have been right
  const agentMisses = agentStructural.filter(a => a.result.correct).length;
  // Agent dedup correct — dedup suppressions that were correct (not a miss, signal already delivered)
  const agentDedupCorrect = agentDedup.filter(a => a.result.correct).length;
  // Dedup correct — system deduped alerts that were correct
  const dedupCorrect = deduped.filter(a => a.result.correct).length;
  // Position-gated correct — gated alerts that were correct (not a miss, no prior position)
  const posGatedCorrect = positionGated.filter(a => a.result.correct).length;

  // By type (delivered only, using readable names)
  const byType = {};
  delivered.forEach(a => {
    const label = readable(a.alert_type);
    if (!byType[label]) byType[label] = { correct: 0, total: 0 };
    byType[label].total++;
    if (a.result.correct) byType[label].correct++;
  });
  Object.keys(byType).forEach(k => {
    byType[k].pct = Math.round((byType[k].correct / byType[k].total) * 100);
  });

  // Raw mechanical accuracy (all alerts, diagnostic only)
  const rawCorrect = scoredAlerts.filter(a => a.result.correct).length;
  const rawTotal = scoredAlerts.length;

  // ── BWC LIFECYCLE STATS ──
  // Group all alerts by game_id, find games where POSITION_OPEN fired
  const gameAlerts = {};
  scoredAlerts.forEach(a => {
    if (!gameAlerts[a.game_id]) gameAlerts[a.game_id] = { matchup: a.matchup, alerts: [], wrong: 0 };
    gameAlerts[a.game_id].alerts.push(a);
    if (!a.result.correct) gameAlerts[a.game_id].wrong++;
  });

  const BWC_LIFECYCLE_TYPES = ['POSITION_OPEN', 'BWC_EDGE', 'VALUE', 'EXIT', 'THESIS_ALIVE', 'POSITION_RECOVERING', 'POSITION_SAFE'];
  const lifecycleGames = {};
  Object.entries(gameAlerts).forEach(([gameId, g]) => {
    const sorted = [...g.alerts].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    // Group by control team
    const byTeam = {};
    sorted.forEach(a => {
      if (!byTeam[a.control_team]) byTeam[a.control_team] = [];
      byTeam[a.control_team].push(a);
    });
    Object.entries(byTeam).forEach(([team, teamAlerts]) => {
      const lifecycleAlerts = teamAlerts.filter(a => BWC_LIFECYCLE_TYPES.includes(a.alert_type));
      if (lifecycleAlerts.length === 0) return;
      const hasOpen = lifecycleAlerts.some(a => a.alert_type === 'POSITION_OPEN');
      if (!hasOpen) return;
      const terminal = lifecycleAlerts[lifecycleAlerts.length - 1];
      const hasExit = lifecycleAlerts.some(a => a.alert_type === 'EXIT');
      const key = `${gameId}_${team}`;
      lifecycleGames[key] = {
        matchup: g.matchup, team, alerts: lifecycleAlerts,
        terminalType: terminal.alert_type,
        collapsed: hasExit,
        ctrlWon: terminal.result?.ctrlWon,
        peakFloor: Math.max(...lifecycleAlerts.map(a => Number(a.peak_floor) || Number(a.floor_score) || 0)),
        worstErosion: lifecycleAlerts.reduce((worst, a) => {
          const rank = { 'STEADY': 0, 'MINOR': 1, 'MODERATE': 2, 'SEVERE': 3, 'COLLAPSE': 4 };
          return (rank[a.erosion_level] || 0) > (rank[worst] || 0) ? a.erosion_level : worst;
        }, 'STEADY'),
      };
    });
  });

  const lifecycleStats = {
    opened: Object.keys(lifecycleGames).length,
    held: Object.values(lifecycleGames).filter(g => !g.collapsed).length,
    collapsed: Object.values(lifecycleGames).filter(g => g.collapsed).length,
    held_correct: Object.values(lifecycleGames).filter(g => !g.collapsed && g.ctrlWon).length,
    collapsed_correct: Object.values(lifecycleGames).filter(g => g.collapsed && !g.ctrlWon).length,
    by_terminal: {},
  };
  Object.values(lifecycleGames).forEach(g => {
    const t = readable(g.terminalType);
    if (!lifecycleStats.by_terminal[t]) lifecycleStats.by_terminal[t] = { total: 0, correct: 0 };
    lifecycleStats.by_terminal[t].total++;
    const isCorrect = g.collapsed ? !g.ctrlWon : g.ctrlWon;
    if (isCorrect) lifecycleStats.by_terminal[t].correct++;
  });

  // ── EROSION ACCURACY ──
  const erosionAccuracy = {};
  scoredAlerts.filter(a => a.erosion_level).forEach(a => {
    if (!erosionAccuracy[a.erosion_level]) erosionAccuracy[a.erosion_level] = { total: 0, ctrlWon: 0 };
    erosionAccuracy[a.erosion_level].total++;
    if (a.result.ctrlWon) erosionAccuracy[a.erosion_level].ctrlWon++;
  });

  // ── EXIT SEVERITY ACCURACY ──
  const exitSevAccuracy = {};
  scoredAlerts.filter(a => a.alert_type === 'EXIT' && a.exit_severity).forEach(a => {
    if (!exitSevAccuracy[a.exit_severity]) exitSevAccuracy[a.exit_severity] = { total: 0, correct: 0 };
    exitSevAccuracy[a.exit_severity].total++;
    if (!a.result.ctrlWon) exitSevAccuracy[a.exit_severity].correct++; // EXIT correct = ctrl lost
  });

  // ── Alert chain detection within games ──
  const alertChains = [];
  Object.entries(gameAlerts).forEach(([gameId, g]) => {
    const sorted = [...g.alerts].sort((a, b) => new Date(a.ts) - new Date(b.ts));
    if (sorted.length < 2) return;

    const byTeam = {};
    sorted.forEach(a => {
      if (!byTeam[a.control_team]) byTeam[a.control_team] = [];
      byTeam[a.control_team].push(a);
    });

    Object.entries(byTeam).forEach(([team, teamAlerts]) => {
      if (teamAlerts.length < 2) return;

      const chain = teamAlerts.map(a => ({
        type: a.alert_type, period: a.period, clock: a.clock,
        decision: a.agent_decision || (a.ntfy_sent ? 'DIRECT' : 'UNKNOWN'),
        correct: a.result?.correct,
        floor: Number(a.floor_score).toFixed(2),
        margin: a.margin,
        erosion: a.erosion_level || null,
        bwcState: a.bwc_state || null,
      }));

      const types = chain.map(c => c.type);
      const decisions = chain.map(c => c.decision);
      const suppressCount = decisions.filter(d => d === 'SUPPRESS').length;

      // V2 chain patterns
      let pattern = null;
      const hasOpen = types.includes('POSITION_OPEN');
      const hasExit = types.includes('EXIT');
      const hasValue = types.includes('VALUE');
      const hasThesisAlive = types.includes('THESIS_ALIVE');
      const hasBuy = types.includes('BUY');
      const hasEdge = types.includes('BWC_EDGE');
      const hasSafe = types.includes('POSITION_SAFE');

      if (hasOpen && hasExit && hasThesisAlive) {
        pattern = 'LIFECYCLE_RECOVERY'; // full arc: open → exit → second chance
      } else if (hasOpen && hasExit) {
        pattern = 'LIFECYCLE_COLLAPSE'; // open → ... → exit
      } else if (hasOpen && (hasSafe || types.includes('POSITION_RECOVERING'))) {
        pattern = 'LIFECYCLE_HOLD'; // open → held through to safe/strengthening
      } else if (hasBuy && hasOpen) {
        pattern = 'BUY_THEN_LIFECYCLE'; // trail buy → took lead → BWC lifecycle
      } else if (hasExit && hasThesisAlive) {
        pattern = 'EXIT_TO_SECOND_CHANCE'; // exit → thesis alive (without open in this team's chain)
      } else if (types.filter(t => t === 'BWC_EDGE').length >= 2) {
        pattern = 'MULTI_HOLD_UPDATE'; // multiple holding updates
      } else if (types.filter(t => t === 'AUTO_ANALYSIS').length >= 2) {
        pattern = 'MULTI_UPDATE';
      // V1 compat patterns
      } else if (types.includes('VARIANCE BREAKING') && (hasBuy || types.includes('WINDOW BUY'))) {
        pattern = 'VB_TO_ENTRY';
      } else if (types.includes('RECOVERY PATH') && (hasBuy || types.includes('WINDOW BUY'))) {
        pattern = 'RP_TO_ENTRY';
      } else if (types.includes('LEAD CRUMBLING') && types.includes('LEAD LOST')) {
        pattern = 'LC_TO_LOST';
      } else if (types.includes('BUY WINDOW CLOSING') && types.includes('LEAD CRUMBLING')) {
        pattern = 'BWC_TO_LC';
      } else if (suppressCount >= 2) {
        pattern = 'SUPPRESS_CHAIN';
      }

      if (pattern || teamAlerts.length >= 3) {
        const allCorrect = chain.every(c => c.correct);
        const allWrong = chain.every(c => !c.correct);
        alertChains.push({
          matchup: g.matchup, team, pattern: pattern || 'MULTI_ALERT',
          chain, chainLength: chain.length,
          outcome: allCorrect ? 'ALL_CORRECT' : allWrong ? 'ALL_WRONG' : 'MIXED',
          suppressions: suppressCount,
        });
      }
    });
  });

  const cascadeGames = Object.values(gameAlerts).filter(g => g.wrong >= 3);

  // Detect conflicting signal games (both teams got alerts)
  const conflictGames = Object.values(gameAlerts).filter(g => {
    const teams = new Set(g.alerts.map(a => a.control_team));
    return teams.size > 1;
  });

  // Agent decision accuracy
  const agentStats = {
    entry_correct: deliveredEntryCorrect,
    entry_total: deliveredEntry.length,
    hold_correct: deliveredHoldCorrect,
    hold_total: deliveredHold.length,
    exit_correct: deliveredExitCorrect,
    exit_total: deliveredExit.length,
    // V1 compat
    v1_actionable_correct: deliveredV1ActionableCorrect,
    v1_actionable_total: deliveredV1Actionable.length,
    v1_transitional_held: deliveredV1TransitionalHeld,
    v1_transitional_total: deliveredV1Transitional.length,
    // Agent filter stats
    saves: agentSaves,
    missed_winners: agentMisses,
    agent_dedup: agentDedup.length,
    agent_dedup_correct: agentDedupCorrect,
    deduped: deduped.length,
    dedup_correct: dedupCorrect,
    position_gated: positionGated.length,
    position_gated_correct: posGatedCorrect,
    // Lifecycle
    lifecycle: lifecycleStats,
    erosion: erosionAccuracy,
    exit_severity: exitSevAccuracy,
    // Chains
    chains: alertChains.length,
    chain_patterns: alertChains.reduce((acc, c) => { acc[c.pattern] = (acc[c.pattern] || 0) + 1; return acc; }, {}),
    raw_correct: rawCorrect,
    raw_total: rawTotal,
  };

  // TP gate failures
  const tpFailures = scoredAlerts.filter(a =>
    !a.result.correct &&
    a.tp_class &&
    a.tp_class !== 'UNLIKELY' && a.tp_class !== 'NO PATH'
  );

  // Sustainability misreads
  const sustMisreads = scoredAlerts.filter(a =>
    !a.result.correct &&
    (a.ctrl_sust === 'LOCKED IN' || a.ctrl_sust === 'DURABLE') &&
    [...ENTRY_TYPES, ...HOLD_TYPES, ...V1_ACTIONABLE, 'BUY WINDOW CLOSING'].includes(a.alert_type)
  );

  // CANDIDATE performance
  const candidates = scoredAlerts.filter(a => a.alert_tier === 'CANDIDATE');
  const candidatesSent = candidates.filter(a => a.agent_decision === 'SEND' || a.agent_decision === 'DOWNGRADE');
  const candidatesSentCorrect = candidatesSent.filter(a => a.result.correct);

  log(`Entry accuracy: ${entryAccuracy != null ? entryAccuracy + '%' : '-'} (${deliveredEntryCorrect}/${deliveredEntry.length}) | Combined: ${accuracyOverall}% | Agent saves: ${agentSaves} misses: ${agentMisses} | Raw: ${rawCorrect}/${rawTotal}`);
  log(`By type: ${JSON.stringify(byType)}`);
  log(`Hold: ${deliveredHoldCorrect}/${deliveredHold.length} | Exit: ${deliveredExitCorrect}/${deliveredExit.length}`);
  log(`Lifecycle: ${JSON.stringify(lifecycleStats)}`);
  log(`Erosion: ${JSON.stringify(erosionAccuracy)} | Exit severity: ${JSON.stringify(exitSevAccuracy)}`);
  log(`Agent: saves=${agentSaves}, missed=${agentMisses}, agent_dedup=${agentDedup.length}(${agentDedupCorrect} correct), sys_dedup=${deduped.length}(${dedupCorrect} correct), pos_gated=${positionGated.length}(${posGatedCorrect} correct)`);
  log(`Alert chains: ${alertChains.length} detected — ${JSON.stringify(agentStats.chain_patterns)}`);
  log(`Cascades: ${cascadeGames.length}, Conflicts: ${conflictGames.length}, TP failures: ${tpFailures.length}`);
  log(`Candidates sent: ${candidatesSent.length}/${candidates.length}, correct: ${candidatesSentCorrect.length}`);

  // ── 3. ANALYZE (Sonnet) ─────────────────────────────────────────────────

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  let findings = '', patterns = '[]', recommendations = '[]';

  if (anthropicKey && scoredAlerts.length > 0) {
    const alertSummary = scoredAlerts.map(a => {
      const r = a.result;
      const agentTag = a.alert_tier === 'CANDIDATE' ? ` [CANDIDATE, agent:${a.agent_decision}]` : ` [FIRED, agent:${a.agent_decision}]`;
      const v2Fields = a.bwc_state || a.erosion_level ? ` | bwc_state:${a.bwc_state || '-'} erosion:${a.erosion_level || '-'} peak:${a.peak_floor ? Number(a.peak_floor).toFixed(2) : '-'} exit_sev:${a.exit_severity || '-'}` : '';
      return `${a.matchup} Q${a.period} ${a.clock}: ${readable(a.alert_type)}${agentTag} — ${a.control_team} floor:${Number(a.floor_score).toFixed(2)} margin:${a.margin} ${a.is_trailing ? 'trailing' : 'leading'} | TP:${a.tp_class || '?'} LS:${a.ls_class || '?'} sust:${a.ctrl_sust || '?'}/${a.opp_sust || '?'} edge:${a.edge || '?'}%${v2Fields} | RESULT: ${r.correct ? 'CORRECT' : 'WRONG'} (final margin: ${r.finalMargin > 0 ? '+' : ''}${r.finalMargin})${a.agent_reasoning ? ' | Agent reasoning: ' + a.agent_reasoning : ''}`;
    }).join('\n');

    const cascadeDetail = cascadeGames.map(g =>
      `${g.matchup}: ${g.wrong} wrong alerts — ${g.alerts.map(a => `${readable(a.alert_type)}(${a.result.correct ? '✓' : '✗'})`).join(', ')}`
    ).join('\n');

    const conflictDetail = conflictGames.map(g => {
      const teams = [...new Set(g.alerts.map(a => a.control_team))];
      return `${g.matchup}: alerts for both ${teams.join(' and ')} — ${g.alerts.map(a => `${readable(a.alert_type)} ${a.control_team}(${a.result.correct ? '✓' : '✗'})`).join(', ')}`;
    }).join('\n');

    // Build chain summary for Sonnet
    const chainSummary = alertChains.length > 0 ? alertChains.map(c => {
      const steps = c.chain.map(s => `${readable(s.type)}(agent:${s.decision},${s.correct ? '✓' : '✗'}) Q${s.period} floor:${s.floor} margin:${s.margin}${s.erosion ? ' erosion:' + s.erosion : ''}`).join(' → ');
      return `${c.matchup} ${c.team} [${c.pattern}]: ${steps} — ${c.outcome}`;
    }).join('\n') : '';

    // Lifecycle summary for Sonnet
    const lifecycleSummary = Object.keys(lifecycleGames).length > 0
      ? Object.values(lifecycleGames).map(g => {
        const arc = g.alerts.map(a => readable(a.alert_type)).join(' → ');
        return `${g.matchup} ${g.team}: ${arc} | peak floor:${g.peakFloor.toFixed(2)} worst erosion:${g.worstErosion} | ctrl ${g.ctrlWon ? 'WON' : 'LOST'}`;
      }).join('\n')
      : 'No BWC lifecycle games tonight.';

    // Erosion summary
    const erosionSummary = Object.keys(erosionAccuracy).length > 0
      ? Object.entries(erosionAccuracy).map(([level, s]) => `${level}: ctrl won ${s.ctrlWon}/${s.total} (${Math.round(s.ctrlWon/s.total*100)}%)`).join(', ')
      : 'No erosion data.';

    // Exit severity summary
    const exitSevSummary = Object.keys(exitSevAccuracy).length > 0
      ? Object.entries(exitSevAccuracy).map(([sev, s]) => `${sev}: ${s.correct}/${s.total} correctly warned`).join(', ')
      : 'No exit alerts tonight.';

    const prompt = `You are the post-game learning agent for a live NBA betting alert system (V2 architecture). Analyze tonight's results and identify patterns.

ALERT SYSTEM ARCHITECTURE (V2):
The system generates three categories of alerts:
- ENTRY signals (Buy, Entry Value, Second Chance) — subscriber should open a position. This is the headline accuracy metric.
- HOLD signals (Position Open, Holding, Strengthening, Position Safe, Position Update) — updates for subscribers already in a position. System trust metric.
- EXIT signals (Exit) — subscriber should close their position. Correct when the team loses.

BWC STATE MACHINE: When a structurally dominant team takes the lead, a Position Open alert fires and the BWC lifecycle begins. The system tracks the position through states:
LOCK (lead 3+) → EDGE (lead 1-2) → VALUE (lost lead, ctrl retained) → EXIT (ctrl lost)
Improving transitions reverse this path. Each alert carries erosion_level (STEADY/MINOR/MODERATE/SEVERE/COLLAPSE) and peak_floor.

ACCURACY SUMMARY:
Entry accuracy (headline): ${entryAccuracy != null ? entryAccuracy + '%' : '-'} (${deliveredEntryCorrect}/${deliveredEntry.length})
Hold accuracy: ${deliveredHold.length > 0 ? Math.round(deliveredHoldCorrect/deliveredHold.length*100) + '%' : '-'} (${deliveredHoldCorrect}/${deliveredHold.length})
Exit accuracy: ${deliveredExit.length > 0 ? Math.round(deliveredExitCorrect/deliveredExit.length*100) + '%' : '-'} (${deliveredExitCorrect}/${deliveredExit.length})
${deliveredV1Actionable.length > 0 ? `V1 actionable (transition compat): ${deliveredV1ActionableCorrect}/${deliveredV1Actionable.length}` : ''}
Raw mechanical (all alerts): ${rawTotal > 0 ? Math.round((rawCorrect / rawTotal) * 100) : '?'}% (${rawCorrect}/${rawTotal})
Agent saves (suppressed losers): ${agentSaves}
Agent missed winners (structural suppression, would have won): ${agentMisses}
Agent dedup (suppressed duplicate signals): ${agentDedup.length} (${agentDedupCorrect} correct — NOT misses, signal already delivered)
System deduped (agent said SEND, system blocked): ${deduped.length} (${dedupCorrect} correct — NOT misses)
Position-gated (no prior actionable alert): ${positionGated.length} (${posGatedCorrect} correct — never reached agent)
By type (delivered only): ${JSON.stringify(byType)}
Candidates sent: ${candidatesSent.length}/${candidates.length}, correct: ${candidatesSentCorrect.length}

BWC LIFECYCLE:
${lifecycleSummary}
Summary: ${lifecycleStats.opened} opened, ${lifecycleStats.held} held (${lifecycleStats.held_correct} ctrl won), ${lifecycleStats.collapsed} collapsed to Exit (${lifecycleStats.collapsed_correct} correctly warned)

EROSION ACCURACY:
${erosionSummary}
Question: Did erosion level predict outcome? Is STEADY safe and COLLAPSE fatal?

EXIT SEVERITY:
${exitSevSummary}

NOTE ON CATEGORIES:
- Agent saves/misses: ONLY structural SUPPRESS decisions where the agent evaluated the signal and rejected it. True agent accuracy measure.
- Agent dedup: agent said SUPPRESS citing "duplicate" — signal already delivered. Correct noise prevention, not a miss.
- System deduped: agent said SEND but system blocked (mechanical dedup). Correct behavior.
- Position-gated: suppressed because no prior entry signal for that game. Not missed opportunities.

SCORED ALERTS:
${alertSummary}

${cascadeGames.length > 0 ? `CASCADE GAMES (3+ wrong alerts):\n${cascadeDetail}` : 'No cascade games.'}

${conflictGames.length > 0 ? `CONFLICTING SIGNALS (both teams got alerts):\n${conflictDetail}` : 'No conflicting signals.'}

${alertChains.length > 0 ? `ALERT CHAINS (multi-alert sequences within games):\n${chainSummary}\nPatterns: LIFECYCLE_HOLD = position held through, LIFECYCLE_COLLAPSE = position degraded to exit, LIFECYCLE_RECOVERY = exit then second chance, BUY_THEN_LIFECYCLE = trail buy into BWC lifecycle, EXIT_TO_SECOND_CHANCE = exit reversed, MULTI_HOLD_UPDATE = multiple holding updates, SUPPRESS_CHAIN = multiple suppressions` : 'No multi-alert chains detected.'}

TP GATE FAILURES (TP passed but alert was wrong): ${tpFailures.length}/${scoredAlerts.filter(a => !a.result.correct).length} wrong alerts

Respond in EXACTLY this format:

FINDINGS:
[2-4 paragraph analysis of tonight's slate. What worked, what didn't, why. Be specific — name games, alert types, lifecycle arcs. Evaluate whether erosion levels predicted correctly. Did EXIT alerts fire at the right time? Did the lifecycle tell a coherent story within each game?]

PATTERNS:
[JSON array of pattern objects, each with "pattern" (string description), "confidence" (high/medium/low), "games" (array of matchup strings that exhibited it), "impact" (how many alerts affected). Include lifecycle patterns — did LIFECYCLE_COLLAPSE arcs end with ctrl losing? Did LIFECYCLE_HOLD arcs cash?]

RECOMMENDATIONS:
[JSON array of recommendation objects, each with "action" (specific threshold/gate change), "rationale" (why), "expected_impact" (what would change)]`;

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (resp.ok) {
        const data = await resp.json();
        const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

        const findingsMatch = text.match(/FINDINGS:\s*([\s\S]*?)(?=\nPATTERNS:)/i);
        const patternsMatch = text.match(/PATTERNS:\s*(\[[\s\S]*?\])(?=\s*\nRECOMMENDATIONS:)/i);
        const recsMatch = text.match(/RECOMMENDATIONS:\s*(\[[\s\S]*)/i);

        findings = findingsMatch ? findingsMatch[1].trim() : text;
        if (patternsMatch) {
          try { patterns = patternsMatch[1].trim(); JSON.parse(patterns); } catch { patterns = '[]'; }
        }
        if (recsMatch) {
          try {
            let recsText = recsMatch[1].trim();
            const arrMatch = recsText.match(/\[[\s\S]*\]/);
            if (arrMatch) { recommendations = arrMatch[0]; JSON.parse(recommendations); }
          } catch { recommendations = '[]'; }
        }

        log(`Sonnet analysis complete (${data.usage?.input_tokens}in/${data.usage?.output_tokens}out)`);
      } else {
        log(`Sonnet ${resp.status}`);
        findings = `Agent analysis unavailable (API ${resp.status}). Entry: ${entryAccuracy != null ? entryAccuracy + '%' : '-'} (${deliveredEntryCorrect}/${deliveredEntry.length}).`;
      }
    } catch (e) {
      log(`Sonnet error: ${e.message}`);
      findings = `Agent analysis failed: ${e.message}. Entry: ${entryAccuracy != null ? entryAccuracy + '%' : '-'} (${deliveredEntryCorrect}/${deliveredEntry.length}).`;
    }
  } else {
    findings = `No API key or no scored alerts. Entry: ${entryAccuracy != null ? entryAccuracy + '%' : '-'} (${deliveredEntryCorrect}/${deliveredEntry.length}).`;
  }

  // ── 4. STORE ────────────────────────────────────────────────────────────

  const uniqueGames = new Set(scoredAlerts.map(a => a.game_id));

  try {
    await sql`UPDATE learnings SET
      games_analyzed = ${uniqueGames.size}, alerts_scored = ${scoredAlerts.length},
      accuracy_overall = ${accuracyOverall}, accuracy_by_type = ${JSON.stringify(byType)},
      agent_accuracy = ${JSON.stringify(agentStats)}, findings = ${findings},
      patterns = ${patterns}, recommendations = ${recommendations}
      WHERE date = ${today.dateStr}`;
    log(`Learning saved for ${today.dateStr}`);
  } catch (e) {
    log(`Learning save failed: ${e.message}`);
  }

  // ── 5. NTFY SUMMARY ────────────────────────────────────────────────────
  // Send a brief nightly summary so Manny sees it without opening debug
  const topic = process.env.NTFY_TOPIC;
  if (topic && scoredAlerts.length > 0) {
    // Build plain English summary
    const pct = entryAccuracy != null ? entryAccuracy : (accuracyOverall != null ? accuracyOverall : 0);
    const emoji = pct >= 80 ? '🟢' : pct >= 60 ? '🟡' : '🔴';

    // Headline: entry accuracy (the money metric)
    let headline;
    if (deliveredEntry.length > 0) {
      headline = `${emoji} ${deliveredEntryCorrect}/${deliveredEntry.length} entry signals hit tonight (${pct}%)`;
    } else if (deliveredActionable.length > 0) {
      // Transition period: V1 types only
      const combinedPct = accuracyOverall != null ? accuracyOverall : 0;
      headline = `${emoji} ${deliveredActionableCorrect}/${deliveredActionable.length} alerts hit tonight (${combinedPct}%)`;
    } else {
      headline = `No entry signals sent tonight`;
    }

    // Per-type breakdown (entry types with readable names)
    const typeLines = [];
    ENTRY_TYPES.forEach(t => {
      const label = readable(t);
      const b = byType[label];
      if (b) typeLines.push(`${label}: ${b.correct}/${b.total}`);
    });
    // V1 compat types
    V1_ACTIONABLE.forEach(t => {
      const label = readable(t);
      const b = byType[label];
      if (b) typeLines.push(`${label}: ${b.correct}/${b.total}`);
    });

    // Lifecycle line
    let lifecycleLine = '';
    if (lifecycleStats.opened > 0) {
      lifecycleLine = `\nBWC lifecycle: ${lifecycleStats.opened} opened, ${lifecycleStats.held} held, ${lifecycleStats.collapsed} collapsed`;
    }

    // Exit line
    let exitLine = '';
    if (deliveredExit.length > 0) {
      exitLine = `\nExit alerts: ${deliveredExitCorrect}/${deliveredExit.length} correctly warned`;
    }

    // Agent value line — only structural SUPPRESS decisions
    let agentLine = '';
    if (agentSaves > 0 || agentMisses > 0) {
      agentLine = `\nAI filter blocked ${agentSaves + agentMisses} signals`;
      if (agentSaves > 0) agentLine += ` — ${agentSaves} would have lost`;
      if (agentMisses > 0) agentLine += `, ${agentMisses} would have won`;
    }

    // Agent dedup line
    let agentDedupLine = '';
    if (agentDedup.length > 0) {
      agentDedupLine = `\n${agentDedup.length} duplicates blocked by AI`;
    }

    // System dedup line
    let dedupLine = '';
    if (deduped.length > 0) {
      dedupLine = `\n${deduped.length} system deduped`;
    }

    // Position-gated line
    let gatedLine = '';
    if (positionGated.length > 0) {
      gatedLine = `\n${positionGated.length} position updates gated (no prior entry)`;
    }

    // V1 transitional line (backward compat)
    let transLine = '';
    if (deliveredV1Transitional.length > 0) {
      transLine = `\nLead alerts: ${deliveredV1TransitionalHeld}/${deliveredV1Transitional.length} held`;
    }

    // Chain line
    let chainLine = '';
    if (alertChains.length > 0) {
      const correctChains = alertChains.filter(c => c.outcome === 'ALL_CORRECT').length;
      chainLine = `\nAlert chains: ${alertChains.length} detected, ${correctChains} fully correct`;
    }

    const body = headline
      + (typeLines.length > 0 ? '\n' + typeLines.join(' | ') : '')
      + lifecycleLine
      + exitLine
      + agentLine
      + agentDedupLine
      + dedupLine
      + gatedLine
      + transLine
      + chainLine;

    try {
      await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers: { 'Title': 'Tonight\'s results', 'Priority': '3', 'Tags': 'basketball' },
        body: body,
      });
      log('Nightly summary sent to ntfy');
    } catch (e) { log(`Ntfy summary failed: ${e.message}`); }
  }

  log('Post-game learning agent complete');
  return new Response(JSON.stringify({
    ok: true,
    date: today.dateStr,
    alerts: scoredAlerts.length,
    accuracy: accuracyOverall,
    entryAccuracy,
    agentStats,
    lifecycle: lifecycleStats,
    chains: alertChains.map(c => ({ matchup: c.matchup, team: c.team, pattern: c.pattern, length: c.chainLength, outcome: c.outcome })),
    diagnostics: scoredAlerts.slice(0, 15).map(a => ({
      type: a.alert_type, ctrl: a.control_team, agent: a.agent_decision,
      correct: a.result.correct, ctrlWon: a.result.ctrlWon, margin: a.result.finalMargin,
      erosion: a.erosion_level || null, bwcState: a.bwc_state || null,
    })),
  }));
}

export const config = {
  schedule: "45 6 * * *",  // 6:45am UTC = 11:45pm MST (Arizona)
};

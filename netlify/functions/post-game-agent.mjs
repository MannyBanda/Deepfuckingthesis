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
  if (['BUY', 'WINDOW BUY', 'RECOVERY PATH', 'AUTO_ANALYSIS'].includes(alert.alert_type)) {
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

  // Compute accuracy breakdowns — split actionable vs transitional
  const ACTIONABLE_TYPES = ['BUY', 'WINDOW BUY', 'BUY WINDOW CLOSING', 'RECOVERY PATH', 'VARIANCE BREAKING', 'AUTO_ANALYSIS'];
  const TRANSITIONAL_TYPES = ['LEAD LOST', 'LEAD CRUMBLING'];

  // Delivered = actually reached ntfy (everything except SUPPRESS and FALLBACK_DROP)
  const delivered = scoredAlerts.filter(a => a.agent_decision !== 'SUPPRESS' && a.agent_decision !== 'FALLBACK_DROP');
  const suppressed = scoredAlerts.filter(a => a.agent_decision === 'SUPPRESS' || a.agent_decision === 'FALLBACK_DROP');

  // Delivered actionable — THE headline number
  const deliveredActionable = delivered.filter(a => ACTIONABLE_TYPES.includes(a.alert_type));
  const deliveredActionableCorrect = deliveredActionable.filter(a => a.result.correct).length;

  // Delivered transitional — informational only
  const deliveredTransitional = delivered.filter(a => TRANSITIONAL_TYPES.includes(a.alert_type));
  const deliveredTransitionalHeld = deliveredTransitional.filter(a => a.result.correct).length;

  // Agent saves — suppressed alerts that would have been wrong
  const agentSaves = suppressed.filter(a => !a.result.correct).length;
  // Agent misses — suppressed alerts that would have been right
  const agentMisses = suppressed.filter(a => a.result.correct).length;

  // Overall accuracy = delivered actionable only
  const accuracyOverall = deliveredActionable.length > 0
    ? Math.round((deliveredActionableCorrect / deliveredActionable.length) * 100) : null;

  // By type (delivered only)
  const byType = {};
  delivered.forEach(a => {
    if (!byType[a.alert_type]) byType[a.alert_type] = { correct: 0, total: 0 };
    byType[a.alert_type].total++;
    if (a.result.correct) byType[a.alert_type].correct++;
  });
  Object.keys(byType).forEach(k => {
    byType[k].pct = Math.round((byType[k].correct / byType[k].total) * 100);
  });

  // Raw mechanical accuracy (all alerts, diagnostic only)
  const rawCorrect = scoredAlerts.filter(a => a.result.correct).length;
  const rawTotal = scoredAlerts.length;

  // Agent decision accuracy
  const agentStats = {
    delivered_correct: deliveredActionableCorrect,
    delivered_total: deliveredActionable.length,
    saves: agentSaves,
    missed_winners: agentMisses,
    transitional_held: deliveredTransitionalHeld,
    transitional_total: deliveredTransitional.length,
    raw_correct: rawCorrect,
    raw_total: rawTotal,
  };

  // Detect cascade games (3+ wrong alerts from same game)
  const gameAlerts = {};
  scoredAlerts.forEach(a => {
    if (!gameAlerts[a.game_id]) gameAlerts[a.game_id] = { matchup: a.matchup, alerts: [], wrong: 0 };
    gameAlerts[a.game_id].alerts.push(a);
    if (!a.result.correct) gameAlerts[a.game_id].wrong++;
  });
  const cascadeGames = Object.values(gameAlerts).filter(g => g.wrong >= 3);

  // Detect conflicting signal games (both teams got alerts)
  const conflictGames = Object.values(gameAlerts).filter(g => {
    const teams = new Set(g.alerts.map(a => a.control_team));
    return teams.size > 1;
  });

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
    ['BUY', 'WINDOW BUY', 'BUY WINDOW CLOSING'].includes(a.alert_type)
  );

  // CANDIDATE performance
  const candidates = scoredAlerts.filter(a => a.alert_tier === 'CANDIDATE');
  const candidatesSent = candidates.filter(a => a.agent_decision === 'SEND' || a.agent_decision === 'DOWNGRADE');
  const candidatesSentCorrect = candidatesSent.filter(a => a.result.correct);

  log(`Delivered accuracy: ${accuracyOverall}% (${deliveredActionableCorrect}/${deliveredActionable.length}) | Agent saves: ${agentSaves} | Raw: ${rawCorrect}/${rawTotal}`);
  log(`By type: ${JSON.stringify(byType)}`);
  log(`Agent: sent_correct=${agentStats.sent_correct}, sent_wrong=${agentStats.sent_wrong}, suppressed_correct=${agentStats.suppressed_correct}, suppressed_missed=${agentStats.suppressed_missed}`);
  log(`Cascades: ${cascadeGames.length}, Conflicts: ${conflictGames.length}, TP failures: ${tpFailures.length}`);
  log(`Candidates sent: ${candidatesSent.length}/${candidates.length}, correct: ${candidatesSentCorrect.length}`);

  // ── 3. ANALYZE (Sonnet) ─────────────────────────────────────────────────

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  let findings = '', patterns = '[]', recommendations = '[]';

  if (anthropicKey && scoredAlerts.length > 0) {
    const alertSummary = scoredAlerts.map(a => {
      const r = a.result;
      const agentTag = a.alert_tier === 'CANDIDATE' ? ` [CANDIDATE, agent:${a.agent_decision}]` : ` [FIRED, agent:${a.agent_decision}]`;
      return `${a.matchup} Q${a.period} ${a.clock}: ${a.alert_type}${agentTag} — ${a.control_team} floor:${Number(a.floor_score).toFixed(2)} margin:${a.margin} ${a.is_trailing ? 'trailing' : 'leading'} | TP:${a.tp_class || '?'} LS:${a.ls_class || '?'} sust:${a.ctrl_sust || '?'}/${a.opp_sust || '?'} edge:${a.edge || '?'}% | RESULT: ${r.correct ? 'CORRECT' : 'WRONG'} (final margin: ${r.finalMargin > 0 ? '+' : ''}${r.finalMargin})${a.agent_reasoning ? ' | Agent reasoning: ' + a.agent_reasoning : ''}`;
    }).join('\n');

    const cascadeDetail = cascadeGames.map(g =>
      `${g.matchup}: ${g.wrong} wrong alerts — ${g.alerts.map(a => `${a.alert_type}(${a.result.correct ? '✓' : '✗'})`).join(', ')}`
    ).join('\n');

    const conflictDetail = conflictGames.map(g => {
      const teams = [...new Set(g.alerts.map(a => a.control_team))];
      return `${g.matchup}: alerts for both ${teams.join(' and ')} — ${g.alerts.map(a => `${a.alert_type} ${a.control_team}(${a.result.correct ? '✓' : '✗'})`).join(', ')}`;
    }).join('\n');

    const prompt = `You are the post-game learning agent for a live NBA betting alert system. Analyze tonight's results and identify patterns.

ACCURACY SUMMARY:
Delivered actionable: ${accuracyOverall}% (${deliveredActionableCorrect}/${deliveredActionable.length})
Raw mechanical (all alerts): ${rawTotal > 0 ? Math.round((rawCorrect / rawTotal) * 100) : '?'}% (${rawCorrect}/${rawTotal})
Agent saves (suppressed losers): ${agentSaves}
Agent missed winners (suppressed winners): ${agentMisses}
Transitional alerts (LEAD LOST/CRUMBLING): ${deliveredTransitionalHeld}/${deliveredTransitional.length} held
By type (delivered only): ${JSON.stringify(byType)}
Candidates sent: ${candidatesSent.length}/${candidates.length}, correct: ${candidatesSentCorrect.length}

SCORED ALERTS:
${alertSummary}

${cascadeGames.length > 0 ? `CASCADE GAMES (3+ wrong alerts):\n${cascadeDetail}` : 'No cascade games.'}

${conflictGames.length > 0 ? `CONFLICTING SIGNALS (both teams got alerts):\n${conflictDetail}` : 'No conflicting signals.'}

TP GATE FAILURES (TP passed but alert was wrong): ${tpFailures.length}/${scoredAlerts.filter(a => !a.result.correct).length} wrong alerts

Respond in EXACTLY this format:

FINDINGS:
[2-4 paragraph analysis of tonight's slate. What worked, what didn't, why. Be specific — name games, alert types, patterns.]

PATTERNS:
[JSON array of pattern objects, each with "pattern" (string description), "confidence" (high/medium/low), "games" (array of matchup strings that exhibited it), "impact" (how many alerts affected)]

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
          max_tokens: 1500,
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
            // Extract just the JSON array
            const arrMatch = recsText.match(/\[[\s\S]*\]/);
            if (arrMatch) { recommendations = arrMatch[0]; JSON.parse(recommendations); }
          } catch { recommendations = '[]'; }
        }

        log(`Sonnet analysis complete (${data.usage?.input_tokens}in/${data.usage?.output_tokens}out)`);
      } else {
        log(`Sonnet ${resp.status}`);
        findings = `Agent analysis unavailable (API ${resp.status}). Delivered: ${accuracyOverall}% (${deliveredActionableCorrect}/${deliveredActionable.length}).`;
      }
    } catch (e) {
      log(`Sonnet error: ${e.message}`);
      findings = `Agent analysis failed: ${e.message}. Delivered: ${accuracyOverall}% (${deliveredActionableCorrect}/${deliveredActionable.length}).`;
    }
  } else {
    findings = `No API key or no scored alerts. Delivered: ${accuracyOverall}% (${deliveredActionableCorrect}/${deliveredActionable.length}).`;
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
    const pct = accuracyOverall != null ? accuracyOverall : 0;
    const emoji = pct >= 80 ? '🟢' : pct >= 60 ? '🟡' : '🔴';

    // Headline: delivered actionable accuracy
    const headline = deliveredActionable.length > 0
      ? `${emoji} ${deliveredActionableCorrect}/${deliveredActionable.length} alerts hit tonight (${pct}%)`
      : `No actionable alerts sent tonight`;

    // Per-type breakdown (delivered only, actionable)
    const typeLines = [];
    ['BUY', 'WINDOW BUY', 'BUY WINDOW CLOSING', 'RECOVERY PATH', 'AUTO_ANALYSIS'].forEach(t => {
      const b = byType[t];
      if (b) typeLines.push(`${t}: ${b.correct}/${b.total}`);
    });

    // Agent value line
    let agentLine = '';
    if (agentSaves > 0 || agentMisses > 0) {
      agentLine = `\nThe AI filter blocked ${agentSaves + agentMisses} signals`;
      if (agentSaves > 0) agentLine += ` — ${agentSaves} would have lost`;
      if (agentMisses > 0) agentLine += `, ${agentMisses} would have won`;
    }

    // Transitional line (gray tier — informational)
    let transLine = '';
    if (deliveredTransitional.length > 0) {
      transLine = `\nLead alerts: ${deliveredTransitionalHeld}/${deliveredTransitional.length} held`;
    }

    const body = headline
      + (typeLines.length > 0 ? '\n' + typeLines.join(' | ') : '')
      + agentLine
      + transLine;

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
    agentStats,
    diagnostics: scoredAlerts.slice(0, 15).map(a => ({
      type: a.alert_type, ctrl: a.control_team, agent: a.agent_decision,
      correct: a.result.correct, ctrlWon: a.result.ctrlWon, margin: a.result.finalMargin,
    })),
  }));
}

export const config = {
  schedule: "45 6 * * *",  // 6:45am UTC = 11:45pm MST (Arizona)
};

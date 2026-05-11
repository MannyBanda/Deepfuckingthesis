// ══════════════════════════════════════════════════════════════════════════════
// post-game-agent.mjs — Nightly Post-Game Learning Agent (V2 Arc Scoring)
//
// Runs at 11:45pm MST (6:45am UTC) daily. For each league (NBA, WNBA):
//   1. COLLECT: alerts, final scores, live_tracking state
//   2. BUILD ARCS: group delivered alerts into position arcs per game+team
//   3. SCORE: grade each arc on its terminal alert (last thing subscriber saw)
//   4. ANALYZE: one Sonnet call to identify patterns across the full slate
//   5. STORE: save findings to `learnings` table (one row per date+league)
//   6. NOTIFY: send ntfy summary
//
// Scoring model: arcs, not individual alerts. The terminal alert is what the
// subscriber acted on. Mid-arc updates aren't independently graded.
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

// Fetch final scores from BDL (NBA only — WNBA uses games table fallback)
async function fetchFinalScores(dateStr, league) {
  // WNBA: skip BDL because BDL abbreviations (LV, NY, etc.) don't match SR abbreviations
  // (LVA, NYL, etc.) stored in alerts. Games table fallback uses correct SR abbreviations.
  if (league === 'wnba') return [];

  const apiKey = process.env.BDL_API_KEY;
  if (!apiKey) { log('No BDL_API_KEY'); return []; }
  try {
    const resp = await fetch(`https://api.balldontlie.io/${league}/v1/games?dates[]=${dateStr}`, {
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

// Resolve game outcome for a control team
function resolveOutcome(ctrlTeam, games) {
  const game = games.find(g => g.home === ctrlTeam || g.away === ctrlTeam);
  if (!game || game.status !== 'Final') return null;
  const ctrlIsHome = game.home === ctrlTeam;
  const ctrlPts = Number(ctrlIsHome ? game.homeScore : game.awayScore) || 0;
  const oppPts = Number(ctrlIsHome ? game.awayScore : game.homeScore) || 0;
  return {
    ctrlWon: ctrlPts > oppPts,
    finalMargin: ctrlPts - oppPts,
    homeScore: game.homeScore,
    awayScore: game.awayScore,
  };
}

// Readable alert names for subscriber-facing output
const READABLE = {
  'POSITION_OPEN': 'Position Open', 'BWC_EDGE': 'Holding', 'VALUE': 'Entry Value',
  'EXIT': 'Exit', 'THESIS_ALIVE': 'Second Chance', 'POSITION_RECOVERING': 'Strengthening',
  'POSITION_SAFE': 'Position Safe', 'AUTO_ANALYSIS': 'Position Update',
  'MC_COLLAPSE': 'Structural Stress',
  'TRACKING_INVALIDATED': 'Tracking Invalidated',
  'BUY': 'Buy', 'TRACKING': 'Tracking',
};
const readable = (t) => READABLE[t] || t;

// Hold-type alerts (subscriber has position, system gave confidence or update)
const HOLD_TYPES = ['POSITION_OPEN', 'BWC_EDGE', 'POSITION_SAFE', 'POSITION_RECOVERING', 'AUTO_ANALYSIS', 'MC_COLLAPSE'];

// Exit-class alerts (system told subscriber to exit or invalidated the position)
const EXIT_TYPES = ['EXIT', 'TRACKING_INVALIDATED', 'XGB_THESIS_INVALIDATED'];

// Dedup pattern detection in agent reasoning
const DEDUP_PATTERNS = ['duplicate', 'already sent', 'already SENT', 'bettor already has', 'already received',
  'already been alerted', 'already correctly suppressed', 'resending', 'no meaningful change',
  'zero meaningful change', 'below the 0.10 threshold', 'nothing new', 'no new actionable'];
const isDedup = (r) => r && DEDUP_PATTERNS.some(p => r.toLowerCase().includes(p.toLowerCase()));

// WNBA-specific Opus prompt context
const WNBA_SIGNAL_CONTEXT = `
WNBA-SPECIFIC SIGNAL RULES (critical for analysis):
- Floor score is NARRATIVE ONLY in WNBA — wrong 80% of the time vs MC + XGB. Do NOT treat floor as a reliable signal.
- I3 (Shot Quality) is the anchor indicator (30% weight), not I4/I2 as in NBA.
- Paint/rim stats are noise in WNBA — perimeter game dominates.
- Q4 BUY is nearly dead: XGB < 0.45 = 2% win rate. Only XGB >= 0.70 is viable.
- MC Q4 underestimates ctrl win probability by +8-14pp — expect MC to read low.
- I3 anti-inversion: losing I3 = 17.6% win rate (opposite of NBA where losing I3 = 49%).
- Turnovers are inversely correlated with winning (unlike NBA).
- XGB gates differ: Q2 < 0.45, Q3 < 0.45, Q4 < 0.70 (vs NBA Q2 < 0.40, Q3 < 0.45, Q4 < 0.60).
When evaluating WNBA arcs, weight MC and XGB signals heavily. Floor-based decisions are inherently suspect.`;

// ══════════════════════════════════════════════════════════════════════════════
// processLeague — core per-league analysis pipeline
// ══════════════════════════════════════════════════════════════════════════════
async function processLeague(sql, league, dateStr, isOverride) {
  const leagueUpper = league.toUpperCase();
  log(`--- ${leagueUpper} processing for ${dateStr} ---`);

  // Load floor reliability coefficients
  var _floorWPCoeffs = {};
  try {
    const fwpRows = await sql`SELECT team_alias, reliability_class, grip FROM floor_wp_coefficients WHERE league = ${league} AND season = '2025-26'`;
    for (const r of fwpRows) _floorWPCoeffs[r.team_alias] = { reliabilityClass: r.reliability_class || 'NEUTRAL', grip: r.grip || 0 };
  } catch(e) { /* table may not exist — non-fatal */ }

  // ── 1. COLLECT ──────────────────────────────────────────────────────────

  // Idempotent check (skip if already processed, unless manual override)
  if (!isOverride) {
    try {
      const existing = await sql`SELECT 1 FROM learnings WHERE date = ${dateStr} AND league = ${league} LIMIT 1`;
      if (existing.length > 0) {
        log(`Already processed ${dateStr} ${leagueUpper}, skipping`);
        return { ok: true, league, message: 'Already processed' };
      }
    } catch (e) { log(`Learnings check: ${e.message}`); }
  }

  // Claim the row (upsert for manual reruns)
  try {
    await sql`INSERT INTO learnings (date, league, games_analyzed, alerts_scored, findings, scoring_version)
      VALUES (${dateStr}, ${league}, 0, 0, 'Processing...', 'v2')
      ON CONFLICT (date, league) DO UPDATE SET findings = 'Reprocessing...', scoring_version = 'v2'`;
  } catch (e) { log(`Learnings claim: ${e.message}`); }

  // Get today's alerts (join games for matchup + outcome, filtered by league)
  const alerts = await sql`
    SELECT a.*, g.away_alias, g.home_alias, g.date as game_date,
      g.winner as game_winner, g.home_pts as game_home_pts, g.away_pts as game_away_pts
    FROM alerts a
    JOIN games g ON a.game_id = g.id
    WHERE g.date = ${dateStr} AND a.league = ${league}
    ORDER BY a.ts
  `;
  log(`Found ${alerts.length} ${leagueUpper} alerts for ${dateStr}`);

  if (alerts.length === 0) {
    log(`No ${leagueUpper} alerts to analyze`);
    try {
      await sql`UPDATE learnings SET findings = ${'No alerts fired today.'} WHERE date = ${dateStr} AND league = ${league}`;
    } catch (e) { log(`Save empty: ${e.message}`); }
    return { ok: true, league, message: 'No alerts' };
  }

  // Get live_tracking for game-level context
  const gameIds = [...new Set(alerts.map(a => a.game_id))];
  let liveTrackingMap = {};
  try {
    const ltRows = await sql`SELECT id, live_tracking FROM games WHERE id = ANY(${gameIds}) AND live_tracking IS NOT NULL`;
    ltRows.forEach(r => {
      liveTrackingMap[r.id] = typeof r.live_tracking === 'string' ? JSON.parse(r.live_tracking) : r.live_tracking;
    });
    log(`Loaded live_tracking for ${Object.keys(liveTrackingMap).length}/${gameIds.length} games`);
  } catch (e) { log(`live_tracking query: ${e.message}`); }

  // Fetch final scores from BDL (NBA) or games table fallback (WNBA)
  let finalScores = await fetchFinalScores(dateStr, league);
  log(`BDL returned ${finalScores.length} ${leagueUpper} games`);

  if (finalScores.length === 0) {
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
      log('No final scores available');
      try { await sql`UPDATE learnings SET findings = 'No final scores available.' WHERE date = ${dateStr} AND league = ${league}`; } catch(e) {}
      return { ok: true, league, message: 'No final scores' };
    }
  }

  // ── 2. BUILD POSITION ARCS ──────────────────────────────────────────────

  // Group alerts by game_id + position_team (falls back to control_team for older alerts)
  const alertsByGameTeam = {};
  alerts.forEach(a => {
    const posTeam = a.position_team || a.control_team;
    const key = `${a.game_id}__${posTeam}`;
    if (!alertsByGameTeam[key]) alertsByGameTeam[key] = {
      gameId: a.game_id, team: posTeam,
      matchup: `${a.away_alias}@${a.home_alias}`,
      alerts: [],
    };
    alertsByGameTeam[key].alerts.push(a);
  });

  // Helper: convert period + clock to a single game-time number (higher = later in game)
  function gameTimeSortKey(a) {
    const p = Number(a.period) || 0;
    const cm = String(a.clock || '12:00').match(/(\d+):(\d+)/);
    const clockSec = cm ? parseInt(cm[1]) * 60 + parseInt(cm[2]) : 720;
    return p * 720 + (720 - clockSec); // Q1 12:00 = 0, Q4 0:00 = 2880
  }

  // Build arcs from delivered alerts
  const arcs = [];
  const allSuppressed = [];

  Object.values(alertsByGameTeam).forEach(group => {
    const { gameId, team, matchup, alerts: groupAlerts } = group;

    // Separate delivered vs suppressed
    const delivered = groupAlerts.filter(a =>
      a.ntfy_sent === true || (a.ntfy_sent == null && a.agent_decision !== 'SUPPRESS' && a.agent_decision !== 'FALLBACK_DROP')
    );
    const suppressed = groupAlerts.filter(a => a.agent_decision === 'SUPPRESS');

    suppressed.forEach(a => allSuppressed.push({ ...a, matchup }));

    if (delivered.length === 0) return;

    // Sort by game time (period + clock), not wall-clock ts — concurrency can reorder ts
    delivered.sort((a, b) => gameTimeSortKey(a) - gameTimeSortKey(b));

    // Skip TRACKING-only arcs (no position taken)
    const nonTracking = delivered.filter(a => a.alert_type !== 'TRACKING');
    if (nonTracking.length === 0) return;

    // Resolve outcome
    const outcome = resolveOutcome(team, finalScores);
    if (!outcome) return;

    // Terminal = last non-TRACKING delivered alert by game time
    const terminal = nonTracking[nonTracking.length - 1];

    // Score: EXIT-class signals invert (correct when position_team lost = signal justified)
    const isExitLike = EXIT_TYPES.includes(terminal.alert_type);
    const correct = isExitLike ? !outcome.ctrlWon : outcome.ctrlWon;

    // Sub-classify failures
    let failureType = null;
    if (!correct) {
      if (terminal.alert_type === 'EXIT') failureType = 'premature_exit';
      else if (isExitLike) failureType = 'premature_invalidation';
      else if (terminal.alert_type === 'BUY') failureType = 'wrong_entry';
      else if (terminal.alert_type === 'THESIS_ALIVE') failureType = 'false_recovery';
      else if (terminal.alert_type === 'VALUE') failureType = 'false_dip';
      else if (HOLD_TYPES.includes(terminal.alert_type)) failureType = 'left_hanging';
      else failureType = 'other';
    }

    // Determine arc type
    const buyRelated = nonTracking.every(a => ['BUY', 'XGB_INVALIDATED'].includes(a.alert_type));
    const arcType = buyRelated ? 'standalone_buy' : 'lifecycle';

    // Get live_tracking context
    const lt = liveTrackingMap[gameId] || null;

    arcs.push({
      gameId, team, matchup, arcType,
      alerts: delivered.map(a => ({
        type: a.alert_type, period: a.period, clock: a.clock,
        floor: Number(a.floor_score).toFixed(2), margin: a.margin,
        decision: a.agent_decision || 'DIRECT',
        graduation_rank: a.graduation_rank || null,
        mf_trajectory: a.mf_trajectory || null,
        combined_read: a.combined_read || null,
        cp_ctrl_flips: a.cp_ctrl_flips != null ? a.cp_ctrl_flips : null,
        erosion: a.erosion_level || null,
        is_flip_buy: a.is_flip_buy || false,
      })),
      terminal: {
        type: terminal.alert_type,
        period: terminal.period, clock: terminal.clock,
        floor: Number(terminal.floor_score).toFixed(2),
        margin: terminal.margin,
        graduation_rank: terminal.graduation_rank || null,
        mf_trajectory: terminal.mf_trajectory || null,
        combined_read: terminal.combined_read || null,
        cp_ctrl_flips: terminal.cp_ctrl_flips != null ? terminal.cp_ctrl_flips : null,
        erosion: terminal.erosion_level || null,
        i1: terminal.i1, i2: terminal.i2, i3: terminal.i3, i4: terminal.i4, i5: terminal.i5,
        conviction_tier: terminal.conviction_tier, conviction_combo: terminal.conviction_combo,
        tp_class: terminal.tp_class, ls_class: terminal.ls_class,
        ctrl_sust: terminal.ctrl_sust, opp_sust: terminal.opp_sust,
        edge: terminal.edge, lane: terminal.lane || null,
        position_closed: terminal.position_closed || false,
        is_flip_buy: terminal.is_flip_buy || false,
      },
      correct, failureType, outcome,
      ltContext: lt ? {
        bwcTeam: lt.bwc_fired?.team || null,
        graduation: lt.cp_graduation ? {
          rank: lt.cp_graduation.rank, floor: lt.cp_graduation.floor,
          cp_label: lt.cp_graduation.cp_label,
        } : null,
        oppGraduation: lt.cp_opp_graduation ? {
          rank: lt.cp_opp_graduation.rank, cp_label: lt.cp_opp_graduation.cp_label,
        } : null,
        cpCtrlFlips: lt.cp_ctrl_flips || 0,
        positionClosed: lt.position_closed || false,
        checkpointCount: (lt.checkpoints || []).length,
      } : null,
    });
  });

  log(`Built ${arcs.length} position arcs from ${alerts.length} alerts`);

  // ── 3. SCORE ────────────────────────────────────────────────────────────

  const scoredArcs = arcs.filter(a => a.outcome !== null);
  const correctArcs = scoredArcs.filter(a => a.correct);
  const wrongArcs = scoredArcs.filter(a => !a.correct);
  const arcAccuracy = scoredArcs.length > 0 ? Math.round((correctArcs.length / scoredArcs.length) * 100) : null;

  // Arc type breakdown
  const lifecycleArcs = scoredArcs.filter(a => a.arcType === 'lifecycle');
  const standaloneBuyArcs = scoredArcs.filter(a => a.arcType === 'standalone_buy');

  // Failure breakdown
  const failures = {};
  wrongArcs.forEach(a => { failures[a.failureType] = (failures[a.failureType] || 0) + 1; });

  // Left hanging detection
  const leftHanging = wrongArcs.filter(a => a.failureType === 'left_hanging');

  log(`Arc accuracy: ${arcAccuracy}% (${correctArcs.length}/${scoredArcs.length})`);
  log(`Lifecycle: ${lifecycleArcs.filter(a=>a.correct).length}/${lifecycleArcs.length} | Standalone BUY: ${standaloneBuyArcs.filter(a=>a.correct).length}/${standaloneBuyArcs.length}`);
  log(`Failures: ${JSON.stringify(failures)}`);
  if (leftHanging.length > 0) log(`LEFT HANGING: ${leftHanging.map(a => `${a.matchup} ${a.team}`).join(', ')}`);

  // ── COMPOUND TIER ACCURACY ──
  const poAlerts = [];
  scoredArcs.forEach(arc => {
    arc.alerts.forEach(a => {
      if (a.type === 'POSITION_OPEN' && a.graduation_rank) {
        poAlerts.push({ tier: a.graduation_rank, cpFlips: a.cp_ctrl_flips, ctrlWon: arc.outcome.ctrlWon });
      }
    });
  });

  const tierAccuracy = {
    CONFIRMED: { correct: 0, total: 0 },
    RECOVERING: { correct: 0, total: 0 },
    LOCKED: { correct: 0, total: 0 },
  };
  poAlerts.forEach(po => {
    const bucket = tierAccuracy[po.tier];
    if (!bucket) return;
    bucket.total++;
    if (po.ctrlWon) bucket.correct++;
  });

  const confRate = tierAccuracy.CONFIRMED.total > 0 ? Math.round((tierAccuracy.CONFIRMED.correct / tierAccuracy.CONFIRMED.total) * 100) : null;
  const recRate = tierAccuracy.RECOVERING.total > 0 ? Math.round((tierAccuracy.RECOVERING.correct / tierAccuracy.RECOVERING.total) * 100) : null;
  const lockRate = tierAccuracy.LOCKED.total > 0 ? Math.round((tierAccuracy.LOCKED.correct / tierAccuracy.LOCKED.total) * 100) : null;
  log(`Position: CONFIRMED ${tierAccuracy.CONFIRMED.correct}/${tierAccuracy.CONFIRMED.total} (${confRate || '-'}%) | RECOVERING ${tierAccuracy.RECOVERING.correct}/${tierAccuracy.RECOVERING.total} (${recRate || '-'}%) | LOCKED ${tierAccuracy.LOCKED.correct}/${tierAccuracy.LOCKED.total} (${lockRate || '-'}%)`);

  // ── SUPPRESSED ALERT EVALUATION ──
  const positionGated = allSuppressed.filter(a => a.agent_reasoning && a.agent_reasoning.includes('position gate'));
  const agentSuppressed = allSuppressed.filter(a => !a.agent_reasoning || !a.agent_reasoning.includes('position gate'));
  const agentDedup = agentSuppressed.filter(a => isDedup(a.agent_reasoning));
  const agentStructural = agentSuppressed.filter(a => !isDedup(a.agent_reasoning));

  const structuralScored = agentStructural.map(a => {
    const posTeam = a.position_team || a.control_team;
    const outcome = resolveOutcome(posTeam, finalScores);
    if (!outcome) return null;
    const wouldBeCorrect = a.alert_type === 'EXIT' ? !outcome.ctrlWon : outcome.ctrlWon;
    return { ...a, outcome, wouldBeCorrect };
  }).filter(Boolean);

  const agentSaves = structuralScored.filter(a => !a.wouldBeCorrect).length;
  const agentMisses = structuralScored.filter(a => a.wouldBeCorrect).length;

  const suppressedRankBreakdown = {};
  structuralScored.filter(a => a.graduation_rank).forEach(a => {
    const key = `${a.graduation_rank}_${a.wouldBeCorrect ? 'miss' : 'save'}`;
    suppressedRankBreakdown[key] = (suppressedRankBreakdown[key] || 0) + 1;
  });

  log(`Agent: saves=${agentSaves}, missed=${agentMisses}, dedup=${agentDedup.length}, pos_gated=${positionGated.length}`);

  // ── EROSION ACCURACY ──
  const erosionAccuracy = {};
  scoredArcs.forEach(arc => {
    arc.alerts.forEach(a => {
      if (!a.erosion) return;
      if (!erosionAccuracy[a.erosion]) erosionAccuracy[a.erosion] = { total: 0, ctrlWon: 0 };
      erosionAccuracy[a.erosion].total++;
      if (arc.outcome.ctrlWon) erosionAccuracy[a.erosion].ctrlWon++;
    });
  });

  // ── EXIT SEVERITY ACCURACY ──
  const exitSevAccuracy = {};
  scoredArcs.forEach(arc => {
    const exitAlerts = arc.alerts.filter(a => a.type === 'EXIT');
    exitAlerts.forEach(() => {
      const exitFull = alerts.find(al => al.game_id === arc.gameId && (al.position_team || al.control_team) === arc.team && al.alert_type === 'EXIT');
      const sev = exitFull?.exit_severity || 'unknown';
      if (!exitSevAccuracy[sev]) exitSevAccuracy[sev] = { total: 0, correct: 0 };
      exitSevAccuracy[sev].total++;
      if (!arc.outcome.ctrlWon) exitSevAccuracy[sev].correct++;
    });
  });

  // ── 4. ANALYZE (Sonnet) ─────────────────────────────────────────────────

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  let findings = '', patterns = '[]', recommendations = '[]';

  if (anthropicKey && scoredArcs.length > 0) {
    // Build enriched arc summaries for Sonnet
    const arcSummaries = scoredArcs.map(arc => {
      const steps = arc.alerts.map(a => {
        const full = alerts.find(al => al.game_id === arc.gameId && (al.position_team || al.control_team) === arc.team
          && al.alert_type === a.type && al.period === a.period && al.clock === a.clock);

        let line = `  ${readable(a.type)} Q${a.period} ${a.clock}: floor=${a.floor} margin=${a.margin}`;
        if (full) {
          line += ` agent:${full.agent_decision || 'DIRECT'}`;
          if (full.i1 != null) {
            line += `\n    I1:${Number(full.i1).toFixed(2)} I2:${Number(full.i2).toFixed(2)} I3:${Number(full.i3).toFixed(2)} I4:${Number(full.i4).toFixed(2)} I5:${Number(full.i5).toFixed(2)}`;
          }
          if (full.conviction_tier) line += ` | Conv: ${full.conviction_tier}(${full.conviction_combo || '-'})`;
          line += `\n    TP:${full.tp_class || '-'} LS:${full.ls_class || '-'} sust:${full.ctrl_sust || '-'}/${full.opp_sust || '-'} edge:${full.edge || '-'}%`;
          if (full.bwc_state || full.erosion_level) {
            line += `\n    BWC: state=${full.bwc_state || '-'} erosion=${full.erosion_level || '-'} peak=${full.peak_floor ? Number(full.peak_floor).toFixed(2) : '-'} exit_sev=${full.exit_severity || '-'}`;
          }
          if (full.graduation_rank || full.mf_trajectory || full.combined_read) {
            line += `\n    Position: ${full.graduation_rank || '-'} (${full.cp_eligible_count || '-'} holds) MF=${full.mf_trajectory || '-'} stress=${full.combined_read || '-'} flips=${full.cp_ctrl_flips != null ? full.cp_ctrl_flips : '-'}`;
            if (full.position_closed) line += ' posClosed=true';
            if (full.is_flip_buy) line += ' FLIP_BUY';
          }
          if (full.agent_reasoning) line += `\n    Reasoning: ${full.agent_reasoning.substring(0, 200)}`;
        }
        return line;
      }).join('\n');

      const resultTag = arc.correct ? 'CORRECT' : `WRONG (${arc.failureType})`;
      const marginStr = arc.outcome.finalMargin > 0 ? `+${arc.outcome.finalMargin}` : `${arc.outcome.finalMargin}`;

      let header = `ARC: ${arc.matchup} — ${arc.team} [${arc.arcType.toUpperCase()}] → ${resultTag}`;
      const _arcReliability = _floorWPCoeffs[arc.team];
      if (_arcReliability && _arcReliability.reliabilityClass !== 'NEUTRAL') {
        header += ` | Floor reliability: ${_arcReliability.reliabilityClass} (grip ${_arcReliability.grip > 0 ? '+' : ''}${_arcReliability.grip})`;
      }
      header += `\nCtrl ${arc.outcome.ctrlWon ? 'WON' : 'LOST'} by ${Math.abs(arc.outcome.finalMargin)} (final margin: ${marginStr})`;
      header += `\nTerminal: ${readable(arc.terminal.type)} Q${arc.terminal.period} ${arc.terminal.clock}`;
      if (arc.failureType === 'left_hanging') header += '\nNo EXIT fired — subscriber left holding a losing position';
      if (arc.failureType === 'false_recovery') header += '\nEXIT was correct but system re-entered subscriber into a losing position';

      let ltLine = '';
      if (arc.ltContext) {
        const lt = arc.ltContext;
        ltLine = `\nGame context: BWC=${lt.bwcTeam || '-'}`;
        if (lt.graduation) ltLine += ` grad=${lt.graduation.rank}-Rank@${lt.graduation.cp_label}`;
        if (lt.oppGraduation) ltLine += ` oppGrad=${lt.oppGraduation.rank}@${lt.oppGraduation.cp_label}`;
        ltLine += ` cpFlips=${lt.cpCtrlFlips} CPs=${lt.checkpointCount}`;
      }

      return `${header}${ltLine}\n${steps}`;
    }).join('\n\n');

    // Compound tier summary
    const gradSummary = [
      `COMPOUND TIER ACCURACY:`,
      tierAccuracy.CONFIRMED.total > 0 ? `CONFIRMED: ${tierAccuracy.CONFIRMED.correct}/${tierAccuracy.CONFIRMED.total} (${confRate}%)` : null,
      tierAccuracy.RECOVERING.total > 0 ? `RECOVERING: ${tierAccuracy.RECOVERING.correct}/${tierAccuracy.RECOVERING.total} (${recRate}%)` : null,
      tierAccuracy.LOCKED.total > 0 ? `LOCKED: ${tierAccuracy.LOCKED.correct}/${tierAccuracy.LOCKED.total} (${lockRate}%)` : null,
    ].filter(Boolean).join('\n');

    // Failure breakdown
    const failureSummary = Object.keys(failures).length > 0
      ? `FAILURE BREAKDOWN:\n${Object.entries(failures).map(([type, count]) => `  ${type}: ${count}`).join('\n')}`
      : 'No failures tonight.';

    // Left hanging detail
    const leftHangingDetail = leftHanging.length > 0
      ? `LEFT HANGING:\n${leftHanging.map(a => `  ${a.matchup} ${a.team}: terminal=${readable(a.terminal.type)} Q${a.terminal.period} ${a.terminal.clock}, lost by ${Math.abs(a.outcome.finalMargin)}`).join('\n')}`
      : '';

    // Agent quality
    const agentSummary = `AGENT QUALITY:
Structural suppressions: ${structuralScored.length} (saves: ${agentSaves}, missed winners: ${agentMisses})
Dedup suppressions: ${agentDedup.length} | Position-gated: ${positionGated.length}${Object.keys(suppressedRankBreakdown).length > 0 ? '\nSuppressed by rank: ' + JSON.stringify(suppressedRankBreakdown) : ''}`;

    // Erosion + exit severity
    const erosionSummary = Object.keys(erosionAccuracy).length > 0
      ? 'EROSION: ' + Object.entries(erosionAccuracy).map(([level, s]) => `${level}: ctrl won ${s.ctrlWon}/${s.total} (${Math.round(s.ctrlWon/s.total*100)}%)`).join(', ')
      : '';
    const exitSevSummary = Object.keys(exitSevAccuracy).length > 0
      ? 'EXIT SEVERITY: ' + Object.entries(exitSevAccuracy).map(([sev, s]) => `${sev}: ${s.correct}/${s.total} correctly warned`).join(', ')
      : '';

    // Conflicting signals
    const gameTeams = {};
    scoredArcs.forEach(a => {
      if (!gameTeams[a.gameId]) gameTeams[a.gameId] = { matchup: a.matchup, teams: [] };
      gameTeams[a.gameId].teams.push({ team: a.team, correct: a.correct, terminal: a.terminal.type });
    });
    const conflicts = Object.values(gameTeams).filter(g => g.teams.length > 1);
    const conflictSummary = conflicts.length > 0
      ? `CONFLICTING SIGNALS:\n${conflicts.map(g => `  ${g.matchup}: ${g.teams.map(t => `${t.team} terminal=${readable(t.terminal)} ${t.correct ? 'CORRECT' : 'WRONG'}`).join(' vs ')}`).join('\n')}`
      : '';

    const leagueLabel = league === 'wnba' ? 'WNBA' : 'NBA';
    const leagueSignalContext = league === 'wnba' ? WNBA_SIGNAL_CONTEXT : '';

    const prompt = `You are the post-game learning agent for a live ${leagueLabel} betting alert system. Analyze tonight's results.
${leagueSignalContext}
SCORING MODEL:
Alerts are grouped into POSITION ARCS per game per team. Each arc is scored on its TERMINAL alert — the last thing the subscriber saw and acted on.

- EXIT terminal + ctrl lost = arc CORRECT (warned subscriber)
- EXIT terminal + ctrl won = arc WRONG (premature exit)
- Any non-EXIT terminal + ctrl won = arc CORRECT
- Any non-EXIT terminal + ctrl lost = arc WRONG

Failure types:
- wrong_entry: BUY was terminal, no lifecycle or EXIT followed
- left_hanging: hold-type alert was terminal, system should have fired EXIT
- false_recovery: THESIS_ALIVE was terminal, system pulled subscriber back after EXIT and was wrong
- false_dip: VALUE was terminal, system said dip was temporary, it wasn't
- premature_exit: EXIT was terminal but ctrl won, system exited too early

ARC ACCURACY: ${arcAccuracy != null ? arcAccuracy + '%' : '-'} (${correctArcs.length}/${scoredArcs.length})
Lifecycle arcs: ${lifecycleArcs.filter(a=>a.correct).length}/${lifecycleArcs.length}
Standalone BUY: ${standaloneBuyArcs.filter(a=>a.correct).length}/${standaloneBuyArcs.length}

${gradSummary}

${failureSummary}
${leftHangingDetail}

${agentSummary}
${erosionSummary}
${exitSevSummary}
${conflictSummary}

POSITION ARCS:
${arcSummaries}

WHAT TO ANALYZE:
1. Were "left_hanging" failures detectable? Should EXIT have fired based on what the system knew at the terminal alert?
2. Were "false_recovery" signals justified? Check THESIS_ALIVE graduation rank, MF trajectory, combined read.
3. Is graduation correctly separating structural dominance?
4. Did EXIT fire at the right time when it did fire?
5. For wrong arcs — was the structural read fundamentally wrong or was the timing wrong?${league === 'wnba' ? '\n6. Were floor-based signals misleading? (Floor is unreliable in WNBA — check if MC/XGB told a different story.)' : ''}

Respond in EXACTLY this format:

FINDINGS:
[2-4 paragraph analysis. Name specific arcs, graduation ranks, failure types.]

PATTERNS:
[JSON array: {"pattern": "description", "confidence": "high/medium/low", "games": ["matchup"], "impact": N}]

RECOMMENDATIONS:
[JSON array: {"action": "specific change", "rationale": "why", "expected_impact": "what would change"}]`;

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
        const recsMatch = text.match(/RECOMMENDATIONS:\s*([\s\S]*)/i);

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
        findings = `Agent analysis unavailable (API ${resp.status}). Arc accuracy: ${arcAccuracy != null ? arcAccuracy + '%' : '-'}.`;
      }
    } catch (e) {
      log(`Sonnet error: ${e.message}`);
      findings = `Agent analysis failed: ${e.message}. Arc accuracy: ${arcAccuracy != null ? arcAccuracy + '%' : '-'}.`;
    }
  } else {
    findings = `No API key or no scored arcs. Arc accuracy: ${arcAccuracy != null ? arcAccuracy + '%' : '-'}.`;
  }

  // ── 5. STORE ────────────────────────────────────────────────────────────

  const accuracyByType = {
    arcs: {
      lifecycle: { correct: lifecycleArcs.filter(a=>a.correct).length, total: lifecycleArcs.length },
      standalone_buy: { correct: standaloneBuyArcs.filter(a=>a.correct).length, total: standaloneBuyArcs.length },
    },
    rank: tierAccuracy,
    failures,
  };

  const agentAccuracy = {
    saves: agentSaves,
    missed_winners: agentMisses,
    agent_dedup: agentDedup.length,
    position_gated: positionGated.length,
    structural_total: structuralScored.length,
    suppressed_rank: suppressedRankBreakdown,
    erosion: erosionAccuracy,
    exit_severity: exitSevAccuracy,
  };

  try {
    await sql`UPDATE learnings SET
      games_analyzed = ${gameIds.length}, alerts_scored = ${alerts.length},
      accuracy_overall = ${arcAccuracy}, accuracy_by_type = ${JSON.stringify(accuracyByType)},
      agent_accuracy = ${JSON.stringify(agentAccuracy)}, findings = ${findings},
      patterns = ${patterns}, recommendations = ${recommendations},
      scoring_version = ${'v2'}
      WHERE date = ${dateStr} AND league = ${league}`;
    log(`Learning saved for ${dateStr} ${leagueUpper}`);
  } catch (e) {
    log(`Learning save failed: ${e.message}`);
  }

  // ── 6. NTFY SUMMARY ────────────────────────────────────────────────────

  const topic = process.env.NTFY_TOPIC;
  if (topic && scoredArcs.length > 0) {
    const pct = arcAccuracy || 0;
    const emoji = pct >= 80 ? '🟢' : pct >= 60 ? '🟡' : '🔴';

    let headline = `${emoji} ${leagueUpper}: ${correctArcs.length}/${scoredArcs.length} position arcs correct tonight (${pct}%)`;

    // Tier line
    const rankParts = [];
    if (tierAccuracy.CONFIRMED.total > 0) rankParts.push(`CONFIRMED: ${tierAccuracy.CONFIRMED.correct}/${tierAccuracy.CONFIRMED.total}`);
    if (tierAccuracy.RECOVERING.total > 0) rankParts.push(`RECOVERING: ${tierAccuracy.RECOVERING.correct}/${tierAccuracy.RECOVERING.total}`);
    if (tierAccuracy.LOCKED.total > 0) rankParts.push(`LOCKED: ${tierAccuracy.LOCKED.correct}/${tierAccuracy.LOCKED.total}`);
    if (standaloneBuyArcs.length > 0) rankParts.push(`BUY: ${standaloneBuyArcs.filter(a=>a.correct).length}/${standaloneBuyArcs.length}`);
    const rankLine = rankParts.length > 0 ? '\n' + rankParts.join(' | ') : '';

    // Left hanging line
    const hangLine = leftHanging.length > 0
      ? `\nLeft hanging: ${leftHanging.length} (${leftHanging.map(a => `${a.matchup} ${a.team}`).join(', ')})`
      : '';

    // Failure detail
    const failParts = [];
    if (failures.wrong_entry) failParts.push(`wrong entry: ${failures.wrong_entry}`);
    if (failures.false_recovery) failParts.push(`false recovery: ${failures.false_recovery}`);
    if (failures.false_dip) failParts.push(`false dip: ${failures.false_dip}`);
    if (failures.premature_exit) failParts.push(`premature exit: ${failures.premature_exit}`);
    const failLine = failParts.length > 0 ? '\n' + failParts.join(' | ') : '';

    // Agent line
    let agentLine = '';
    if (agentSaves > 0 || agentMisses > 0) {
      agentLine = `\nAI filter: ${agentSaves} saves`;
      if (agentMisses > 0) agentLine += `, ${agentMisses} missed winners`;
    }

    const body = headline + rankLine + hangLine + failLine + agentLine;

    try {
      await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers: { 'Title': `${leagueUpper} Results`, 'Priority': '3', 'Tags': 'basketball' },
        body: body,
      });
      log(`${leagueUpper} nightly summary sent to ntfy`);
    } catch (e) { log(`Ntfy failed: ${e.message}`); }
  }

  log(`--- ${leagueUpper} complete ---`);
  return {
    ok: true, league,
    arcs: scoredArcs.length,
    accuracy: arcAccuracy,
    arcBreakdown: {
      lifecycle: { correct: lifecycleArcs.filter(a=>a.correct).length, total: lifecycleArcs.length },
      standalone_buy: { correct: standaloneBuyArcs.filter(a=>a.correct).length, total: standaloneBuyArcs.length },
    },
    rank: tierAccuracy,
    failures,
    agent: { saves: agentSaves, misses: agentMisses, dedup: agentDedup.length, posGated: positionGated.length },
    arcsDetail: scoredArcs.map(a => ({
      matchup: a.matchup, team: a.team, arcType: a.arcType,
      terminal: a.terminal.type, correct: a.correct, failureType: a.failureType,
      ctrlWon: a.outcome.ctrlWon, finalMargin: a.outcome.finalMargin,
      compoundTier: a.terminal.graduation_rank, alertCount: a.alerts.length,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Handler — loops over leagues, delegates to processLeague
// ══════════════════════════════════════════════════════════════════════════════
export default async function handler(req) {
  log('Post-game learning agent starting...');

  const sql = neon(process.env.DATABASE_URL);

  const url = new URL(req.url, 'https://localhost');
  const dateOverride = url.searchParams.get('date');
  const leagueOverride = url.searchParams.get('league');
  const today = dateOverride ? { dateStr: dateOverride } : getArizonaDate();
  log(`Processing date: ${today.dateStr}${dateOverride ? ' (manual override)' : ' (Arizona time)'}`);

  const leagues = leagueOverride ? [leagueOverride] : ['nba', 'wnba'];
  const results = [];

  for (const league of leagues) {
    try {
      const result = await processLeague(sql, league, today.dateStr, !!dateOverride);
      results.push(result);
    } catch (e) {
      log(`${league.toUpperCase()} processing failed: ${e.message}`);
      results.push({ ok: false, league, error: e.message });
    }
  }

  log('Post-game learning agent complete');
  return new Response(JSON.stringify({ ok: true, date: today.dateStr, results }));
}

export const config = {
  schedule: "45 6 * * *",  // 6:45am UTC = 11:45pm MST (Arizona)
};

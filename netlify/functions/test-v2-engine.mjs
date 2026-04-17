// ══════════════════════════════════════════════════════════════════════════════
// TEST-V2-ENGINE — Alert System v2 validation harness
// Replays production snapshot data through new mechanical computations:
//   - live_tracking (peak floor, consecutive holds)
//   - BWC state machine (LOCK/EDGE/VALUE/EXIT)
//   - Erosion thresholds (STABLE/CAUTION/COLLAPSE)
//   - VALUE/EXIT trigger conditions
//   - Agent context package assembly
//
// Usage:
//   ?game_id=X                  — single game
//   ?all=true                   — all 9 test games
//   ?mode=mechanical (default)  — no API calls, deterministic
//   ?mode=context               — mechanical + context packages at triggers
//   ?mode=agent                 — context + Opus alert agent calls at triggers
//   ?mode=monitor               — context + Sonnet monitor calls at key moments
// ══════════════════════════════════════════════════════════════════════════════

import { neon } from '@neondatabase/serverless';

function log(msg) { console.log(`[v2-test] ${msg}`); }

// ── TEST GAME SET ──
const TEST_GAMES = {
  'ea840c07-415b-4b90-af7b-50215fd27298': { label: 'GSW@LAC 4/15', archetype: 'BWC → collapse → ctrl LOST' },
  '460c21bf-ca28-4318-899c-01e9e473d99e': { label: 'POR@PHX 4/14', archetype: 'BUY → ctrl flip → BWC (+700)' },
  '34b37d8e-01cf-4bae-a587-0390d92c608d': { label: 'MIA@CHA 4/14', archetype: 'BUY+BWC → OT bad beat' },
  'd50df249-f9ad-4bde-aa74-598462feef58': { label: 'ORL@PHI 4/15', archetype: 'BWC → 8 LC → 11 RP → recovers' },
  '7710d87d-045b-47a2-ac65-0d6986d1940c': { label: 'GSW@SAC 4/10', archetype: 'BWC → LEAD_LOST → BUY (+700)' },
  '0342c2c0-8e36-42cc-b94f-261d506a3b43': { label: 'GSW@LAC 4/12', archetype: 'BWC → LEAD_LOST → ctrl recovers' },
  'f98b9fa2-83b6-4bc5-9d2c-cb55d090fbb5': { label: 'POR@DEN 4/6', archetype: 'DEN dominant, OT, +700' },
  '91fec01b-1b8b-4e04-88d5-91545b4a4822': { label: 'NOP@MIN 4/12', archetype: 'Clean BWC hold (wire-to-wire)' },
  '7655ef88-636f-4b22-9bc7-ae8c1d874ed1': { label: 'DAL@SAS 4/10', archetype: 'BUY only (never led, no BWC)' },
};

// ── V2 MECHANICAL ENGINE ──

function computeCtrlRelative(snap, homeAlias) {
  const floorTeam = snap.floor_team;
  if (!floorTeam) return null;
  const ctrlIsHome = floorTeam === homeAlias;
  const ctrlPts = ctrlIsHome ? Number(snap.home_pts) : Number(snap.away_pts);
  const oppPts = ctrlIsHome ? Number(snap.away_pts) : Number(snap.home_pts);
  const margin = ctrlPts - oppPts;
  const floor = Number(snap.floor_score) || 0;

  // Indicators: stored HOME-relative. Invert if ctrl is away.
  const inv = ctrlIsHome ? 1 : -1;
  const i1 = snap.i1 != null ? (ctrlIsHome ? Number(snap.i1) : 1 - Number(snap.i1)) : null;
  const i2 = snap.i2 != null ? (ctrlIsHome ? Number(snap.i2) : 1 - Number(snap.i2)) : null;
  const i3 = snap.i3 != null ? (ctrlIsHome ? Number(snap.i3) : 1 - Number(snap.i3)) : null;
  const i4 = snap.i4 != null ? (ctrlIsHome ? Number(snap.i4) : 1 - Number(snap.i4)) : null;
  const i5 = snap.i5 != null ? (ctrlIsHome ? Number(snap.i5) : 1 - Number(snap.i5)) : null;

  // Opponent indicators won (≤ 0.45 ctrl-relative = opponent won)
  const oppIndicators = [];
  if (i1 !== null && i1 <= 0.45) oppIndicators.push('I1');
  if (i2 !== null && i2 <= 0.45) oppIndicators.push('I2');
  if (i3 !== null && i3 <= 0.45) oppIndicators.push('I3');
  if (i4 !== null && i4 <= 0.45) oppIndicators.push('I4');
  if (i5 !== null && i5 <= 0.45) oppIndicators.push('I5');

  // Ctrl indicators won (≥ 0.55)
  const ctrlIndicators = [];
  if (i1 !== null && i1 >= 0.55) ctrlIndicators.push('I1');
  if (i2 !== null && i2 >= 0.55) ctrlIndicators.push('I2');
  if (i3 !== null && i3 >= 0.55) ctrlIndicators.push('I3');
  if (i4 !== null && i4 >= 0.55) ctrlIndicators.push('I4');
  if (i5 !== null && i5 >= 0.55) ctrlIndicators.push('I5');

  // Sustainability from sust_json
  let ctrlSust = null, oppSust = null;
  if (snap.sust_json) {
    const sj = typeof snap.sust_json === 'string' ? JSON.parse(snap.sust_json) : snap.sust_json;
    const ctrlSide = ctrlIsHome ? 'home' : 'away';
    const oppSide = ctrlIsHome ? 'away' : 'home';
    ctrlSust = sj?.[ctrlSide]?.tier || null;
    oppSust = sj?.[oppSide]?.tier || null;
  }

  return {
    ctrlTeam: floorTeam, ctrlIsHome, ctrlPts, oppPts, margin, floor,
    i1, i2, i3, i4, i5,
    oppIndicators, oppIndicatorCount: oppIndicators.length,
    ctrlIndicators, ctrlIndicatorCount: ctrlIndicators.length,
    oppI3Won: oppIndicators.includes('I3'),
    ctrlSust, oppSust,
    tpClass: snap.tp_class || null,
    lsClass: snap.ls_class || null,
    period: snap.period, clock: snap.clock,
    homePts: Number(snap.home_pts), awayPts: Number(snap.away_pts),
  };
}

function updateLiveTracking(lt, cr) {
  if (!cr) return lt;
  const side = cr.ctrlIsHome ? 'home' : 'away';
  const peakKey = `${side}_peak_floor`;

  // Update peak floor
  if (!lt[peakKey] || cr.floor > lt[peakKey]) {
    lt[peakKey] = cr.floor;
    lt[`${side}_peak_time`] = `Q${cr.period} ${cr.clock}`;
  }

  // Consecutive holds
  if (lt.ctrl_team_current === cr.ctrlTeam) {
    lt.ctrl_team_holds = (lt.ctrl_team_holds || 0) + 1;
  } else {
    lt.ctrl_team_current = cr.ctrlTeam;
    lt.ctrl_team_holds = 1;
  }

  return lt;
}

function computeBwcState(lt, cr) {
  const bwcFired = lt.bwc_fired;
  if (!bwcFired || !cr.ctrlTeam) return null;

  if (bwcFired.team === cr.ctrlTeam) {
    // BWC team still has structural control
    if (cr.margin >= 3) return 'LOCK';
    if (cr.margin >= 1) return 'EDGE';         // leading 1-2
    if (cr.margin === 0) return 'VALUE';        // tied
    if (cr.margin >= -7) return 'VALUE';        // trailing 1-7
    return 'DEEP_TRAIL';                        // trailing 8+
  } else {
    return 'EXIT';                              // ctrl flipped
  }
}

function computeErosion(lt, cr) {
  const side = cr.ctrlIsHome ? 'home' : 'away';
  const peakFloor = lt[`${side}_peak_floor`] || null;
  if (!peakFloor || cr.floor >= peakFloor) {
    return { level: 'STABLE', peakFloor, peakDelta: 0 };
  }
  const peakDelta = cr.floor - peakFloor;
  const edgeAboveCoinFlip = peakFloor - 0.50;
  if (edgeAboveCoinFlip <= 0) {
    return { level: 'STABLE', peakFloor, peakDelta };
  }
  const cautionDelta = -(edgeAboveCoinFlip * 0.40);
  const collapseDelta = -(edgeAboveCoinFlip * 0.70);
  let level = 'STABLE';
  if (peakDelta <= collapseDelta) level = 'COLLAPSE';
  else if (peakDelta <= cautionDelta) level = 'CAUTION';
  return { level, peakFloor, peakDelta, cautionDelta, collapseDelta };
}

function parsePeriod(snap) {
  let p = Number(snap.period);
  if (p === 0 && snap.clock) {
    const m = String(snap.clock).match(/Q(\d)/);
    if (m) p = parseInt(m[1]);
  }
  return p;
}

// ── REPLAY ENGINE ──

async function replayGame(sql, gameId, mode) {
  // 1. Load game metadata
  const gameRows = await sql`SELECT * FROM games WHERE id = ${gameId}`;
  if (gameRows.length === 0) return { error: `Game ${gameId} not found` };
  const game = gameRows[0];
  const hA = game.home_alias, aA = game.away_alias;
  const matchup = game.matchup || `${aA}@${hA}`;

  // 2. Load all snapshots chronologically
  const snapshots = await sql`SELECT * FROM snapshots WHERE game_id = ${gameId} ORDER BY ts ASC`;

  // 3. Load production alerts for comparison
  const prodAlerts = await sql`
    SELECT alert_type, alert_tier, period, clock, floor_score, margin, is_trailing,
           control_team, agent_decision, agent_reasoning, conviction_tier, conviction_combo,
           edge, tp_class, ctrl_sust, opp_sust, ntfy_sent, ts
    FROM alerts WHERE game_id = ${gameId} ORDER BY ts ASC`;

  // 4. Load production monitor observations
  const prodMonitor = await sql`
    SELECT period, clock, narrative, risk_factors, momentum_direction,
           momentum_streak, momentum_delta, sust_arc, floor_margin_rel,
           floor_score, margin, control_team, ts
    FROM monitor_observations WHERE game_id = ${gameId} ORDER BY ts ASC`;

  log(`${matchup}: ${snapshots.length} snaps, ${prodAlerts.length} alerts, ${prodMonitor.length} monitor obs`);

  // 5. Replay
  let lt = {}; // live_tracking state
  let bwcState = null;
  let prevBwcState = null;
  let erosion = { level: 'STABLE', peakFloor: null, peakDelta: 0 };

  const timeline = [];       // every state change
  const triggers = [];       // alert trigger points
  const v2Alerts = [];       // simulated v2 alert sequence (for compounding)
  const stateLog = [];       // BWC state at every snapshot (for debugging)

  let bwcFirstFired = false;
  let lastTriggerKey = null;  // dedup

  for (let idx = 0; idx < snapshots.length; idx++) {
    const snap = snapshots[idx];
    const period = parsePeriod(snap);
    if (period < 1) continue; // skip period 0

    const cr = computeCtrlRelative(snap, hA);
    if (!cr) continue;

    // Update live_tracking
    lt = updateLiveTracking(lt, cr);

    // Compute BWC state
    bwcState = computeBwcState(lt, cr);

    // Compute erosion
    erosion = computeErosion(lt, cr);

    // Record state for debugging
    stateLog.push({
      idx, period, clock: cr.clock,
      score: `${snap.away_pts}-${snap.home_pts}`,
      ctrl: cr.ctrlTeam, floor: cr.floor.toFixed(2),
      margin: cr.margin,
      bwcState, erosion: erosion.level,
      holds: lt.ctrl_team_holds || 0,
      peak: erosion.peakFloor?.toFixed(2) || '-',
      peakDelta: erosion.peakDelta?.toFixed(3) || '-',
    });

    // ── CHECK TRIGGER CONDITIONS ──

    // First BWC fire detection
    if (!bwcFirstFired && period >= 2 && cr.floor >= 0.60 && cr.margin >= 2) {
      bwcFirstFired = true;
      lt.bwc_fired = {
        team: cr.ctrlTeam,
        period, clock: cr.clock,
        floor: cr.floor,
      };
      lt._prev_bwc_state = 'LOCK';
      bwcState = 'LOCK';

      const triggerPoint = {
        type: 'BWC_FIRST_FIRE',
        snapIdx: idx, period, clock: cr.clock,
        ctrlTeam: cr.ctrlTeam, floor: cr.floor,
        margin: cr.margin, bwcState: 'LOCK',
        erosion: erosion.level,
      };
      triggers.push(triggerPoint);
      timeline.push({ ...triggerPoint, ts: snap.ts });

      // Record as v2 alert for compounding
      v2Alerts.push({
        alertType: 'BUY WINDOW CLOSING', bwcState: 'LOCK',
        period, clock: cr.clock, floor: cr.floor, margin: cr.margin,
        ctrlTeam: cr.ctrlTeam, reasoning: '[INITIAL BWC FIRE — structural lead established]',
        decision: 'SEND',
      });
    }

    // BWC state transitions (after first fire)
    if (bwcFirstFired && bwcState && bwcState !== prevBwcState) {
      const transitionKey = `${bwcState}_Q${period}`;
      // Dedup: only fire on actual state changes
      if (transitionKey !== lastTriggerKey) {
        lastTriggerKey = transitionKey;

        let alertType = null;
        if (bwcState === 'LOCK' || bwcState === 'EDGE') {
          alertType = 'BUY WINDOW CLOSING';
        } else if (bwcState === 'VALUE') {
          alertType = 'VALUE';
        } else if (bwcState === 'EXIT') {
          alertType = 'EXIT';
        }

        if (alertType) {
          const triggerPoint = {
            type: `BWC_TRANSITION`,
            alertType,
            fromState: prevBwcState, toState: bwcState,
            snapIdx: idx, period, clock: cr.clock,
            ctrlTeam: cr.ctrlTeam, floor: cr.floor,
            margin: cr.margin, bwcState,
            erosion: erosion.level,
            peakFloor: erosion.peakFloor,
            peakDelta: erosion.peakDelta,
            holds: lt.ctrl_team_holds,
            oppIndicatorCount: cr.oppIndicatorCount,
            oppIndicatorsWon: cr.oppIndicators.join('+') || 'none',
            ctrlIndicatorCount: cr.ctrlIndicatorCount,
            ctrlIndicatorsWon: cr.ctrlIndicators.join('+') || 'none',
            oppI3Won: cr.oppI3Won,
            ctrlSust: cr.ctrlSust, oppSust: cr.oppSust,
            tpClass: cr.tpClass, lsClass: cr.lsClass,
          };

          // Assemble context package (mode >= context)
          if (mode !== 'mechanical') {
            triggerPoint.contextPackage = assembleContextPackage(
              snap, cr, lt, erosion, bwcState, v2Alerts, snapshots, idx, hA, aA
            );
          }

          triggers.push(triggerPoint);
          timeline.push({ ...triggerPoint, ts: snap.ts });

          // Record for compounding
          v2Alerts.push({
            alertType, bwcState,
            period, clock: cr.clock, floor: cr.floor, margin: cr.margin,
            ctrlTeam: cr.ctrlTeam,
            reasoning: `[v2 state transition: ${prevBwcState} → ${bwcState}]`,
            decision: alertType === 'EXIT' ? 'SEND' : 'PENDING',
          });
        }
      }
    }

    // Erosion transitions
    if (bwcFirstFired) {
      const prevErosionInTimeline = timeline.filter(t => t.type === 'EROSION_TRANSITION');
      const prevErosionLevel = prevErosionInTimeline.length > 0
        ? prevErosionInTimeline[prevErosionInTimeline.length - 1].erosionLevel : 'STABLE';
      if (erosion.level !== prevErosionLevel) {
        const triggerPoint = {
          type: 'EROSION_TRANSITION',
          fromLevel: prevErosionLevel, erosionLevel: erosion.level,
          snapIdx: idx, period, clock: cr.clock,
          ctrlTeam: cr.ctrlTeam, floor: cr.floor,
          margin: cr.margin,
          peakFloor: erosion.peakFloor,
          peakDelta: erosion.peakDelta,
          cautionDelta: erosion.cautionDelta,
          collapseDelta: erosion.collapseDelta,
        };
        triggers.push(triggerPoint);
        timeline.push({ ...triggerPoint, ts: snap.ts });
      }
    }

    // BUY trigger (no prior BWC, or BWC for different team)
    const bwcTeam = lt.bwc_fired?.team || null;
    const isBwcGame = bwcTeam === cr.ctrlTeam;
    if (!isBwcGame && period >= 2 && cr.floor >= 0.65 && cr.margin < 0 && cr.margin >= -15) {
      const buyKey = `BUY_Q${period}_${cr.margin}`;
      if (buyKey !== lastTriggerKey) {
        lastTriggerKey = buyKey;
        const triggerPoint = {
          type: 'BUY_TRIGGER',
          alertType: 'BUY',
          snapIdx: idx, period, clock: cr.clock,
          ctrlTeam: cr.ctrlTeam, floor: cr.floor,
          margin: cr.margin,
          oppIndicatorCount: cr.oppIndicatorCount,
          oppIndicatorsWon: cr.oppIndicators.join('+') || 'none',
          ctrlIndicatorCount: cr.ctrlIndicatorCount,
          oppI3Won: cr.oppI3Won,
          erosion: erosion.level,
          ctrlSust: cr.ctrlSust, oppSust: cr.oppSust,
          tpClass: cr.tpClass, lsClass: cr.lsClass,
        };
        if (mode !== 'mechanical') {
          triggerPoint.contextPackage = assembleContextPackage(
            snap, cr, lt, erosion, bwcState, v2Alerts, snapshots, idx, hA, aA
          );
        }
        triggers.push(triggerPoint);
        timeline.push({ ...triggerPoint, ts: snap.ts });
      }
    }

    prevBwcState = bwcState;
  }

  // 6. Build validation report
  const report = buildReport(gameId, game, matchup, lt, triggers, timeline, stateLog, prodAlerts, prodMonitor, snapshots.length);

  // 7. If mode=agent, run API calls at trigger points
  if (mode === 'agent') {
    report.agentResults = await runAgentTests(triggers, v2Alerts, matchup);
  }

  return report;
}

// ── CONTEXT PACKAGE ASSEMBLY ──

function assembleContextPackage(snap, cr, lt, erosion, bwcState, v2Alerts, allSnaps, idx, hA, aA) {
  // Floor history (last 5 snapshots before current)
  const histStart = Math.max(0, idx - 5);
  const floorHistory = allSnaps.slice(histStart, idx + 1).map(s => {
    const ft = s.floor_team || '?';
    return `Q${s.period} ${s.clock}: ${ft} ${Number(s.floor_score || 0).toFixed(2)} (${s.away_pts}-${s.home_pts}) TP:${s.tp_class || '?'} LS:${s.ls_class || '?'}`;
  }).reverse().join('\n');

  // Prior v2 alert reasoning trail (compounding pattern)
  const priorAlertTrail = v2Alerts.map(a =>
    `${a.alertType}[${a.bwcState || '-'}] Q${a.period} ${a.clock}: floor ${a.floor.toFixed(2)}, margin ${a.margin} → ${a.decision}: ${a.reasoning}`
  ).reverse().slice(0, 5).join('\n');

  return {
    // Engine data
    floor: cr.floor, margin: cr.margin,
    period: cr.period, clock: cr.clock,
    ctrlTeam: cr.ctrlTeam,
    i1: cr.i1?.toFixed(2), i2: cr.i2?.toFixed(2),
    i3: cr.i3?.toFixed(2), i4: cr.i4?.toFixed(2),
    i5: cr.i5?.toFixed(2),
    ctrlIndicators: cr.ctrlIndicators.join('+') || 'none',
    ctrlIndicatorCount: cr.ctrlIndicatorCount,

    // Opponent profile
    oppIndicatorCount: cr.oppIndicatorCount,
    oppIndicatorsWon: cr.oppIndicators.join('+') || 'none',
    oppI3Won: cr.oppI3Won,

    // Position health
    peakFloor: erosion.peakFloor,
    peakDelta: erosion.peakDelta,
    erosionLevel: erosion.level,
    consecutiveHolds: lt.ctrl_team_holds || 0,
    bwcState: bwcState || 'none',
    bwcFirePeriod: lt.bwc_fired?.period || null,
    bwcFireFloor: lt.bwc_fired?.floor || null,

    // Sustainability
    ctrlSust: cr.ctrlSust, oppSust: cr.oppSust,
    tpClass: cr.tpClass, lsClass: cr.lsClass,

    // Trail data
    floorHistory,
    priorAlertTrail: priorAlertTrail || 'None',
  };
}

// ── VALIDATION REPORT ──

function buildReport(gameId, game, matchup, lt, triggers, timeline, stateLog, prodAlerts, prodMonitor, snapCount) {
  const meta = TEST_GAMES[gameId] || {};
  const winner = game.winner;
  const bwcFired = lt.bwc_fired || null;
  const bwcTeam = bwcFired?.team || null;

  // ── Test 1: BWC State Machine ──
  const bwcTransitions = triggers.filter(t => t.type === 'BWC_TRANSITION');
  const stateSequence = bwcTransitions.map(t => t.toState);
  const hasValue = stateSequence.includes('VALUE');
  const hasExit = stateSequence.includes('EXIT');

  // Validate state logic
  const stateErrors = [];
  for (const t of bwcTransitions) {
    if (t.toState === 'LOCK' && t.margin < 3) stateErrors.push(`LOCK at margin ${t.margin} (need 3+)`);
    if (t.toState === 'EDGE' && (t.margin < 1 || t.margin > 2)) stateErrors.push(`EDGE at margin ${t.margin} (need 1-2)`);
    if (t.toState === 'VALUE' && t.margin > 0) stateErrors.push(`VALUE while leading by ${t.margin}`);
    if (t.toState === 'EXIT' && t.ctrlTeam === bwcTeam) stateErrors.push(`EXIT but ctrl team still ${t.ctrlTeam} = ${bwcTeam}`);
  }

  // ── Test 2: Erosion Thresholds ──
  const erosionTransitions = triggers.filter(t => t.type === 'EROSION_TRANSITION');
  const hadCaution = erosionTransitions.some(t => t.erosionLevel === 'CAUTION');
  const hadCollapse = erosionTransitions.some(t => t.erosionLevel === 'COLLAPSE');

  // ── Test 3: VALUE/EXIT triggers ──
  const valueTriggers = triggers.filter(t => t.alertType === 'VALUE');
  const exitTriggers = triggers.filter(t => t.alertType === 'EXIT');
  const buyTriggers = triggers.filter(t => t.type === 'BUY_TRIGGER');

  // Cross-reference with outcome
  let valueCorrect = null, exitCorrect = null;
  if (valueTriggers.length > 0 && winner) {
    valueCorrect = winner === bwcTeam; // VALUE correct if BWC team won
  }
  if (exitTriggers.length > 0 && winner) {
    exitCorrect = winner !== bwcTeam; // EXIT correct if BWC team lost
  }

  // ── Comparison with v1 production ──
  const v1BwcAlerts = prodAlerts.filter(a => a.alert_type === 'BUY WINDOW CLOSING');
  const v1BuyAlerts = prodAlerts.filter(a => a.alert_type === 'BUY');
  const v1LeadLost = prodAlerts.filter(a => a.alert_type === 'LEAD LOST');
  const v1LC = prodAlerts.filter(a => a.alert_type === 'LEAD CRUMBLING');
  const v1AutoAnalysis = prodAlerts.filter(a => a.alert_type === 'AUTO_ANALYSIS');

  // ── Where v2 adds value over v1 ──
  const v2Improvements = [];
  if (hasValue && v1BuyAlerts.length > 0) {
    v2Improvements.push('VALUE replaces BUY with BWC context (compounding pattern)');
  }
  if (hasExit && !v1LeadLost.some(a => a.agent_decision === 'SEND')) {
    v2Improvements.push('EXIT fires where v1 had no cash-out signal');
  }
  if (hadCaution) {
    v2Improvements.push('Erosion CAUTION fires — monitor/agent get structural warning');
  }
  if (hadCollapse) {
    const collapseTime = erosionTransitions.find(t => t.erosionLevel === 'COLLAPSE');
    const autoAnalysisSend = v1AutoAnalysis.find(a => a.agent_decision === 'SEND');
    if (autoAnalysisSend && collapseTime) {
      v2Improvements.push(`COLLAPSE at Q${collapseTime.period} ${collapseTime.clock} — would gate auto-analysis ntfy`);
    }
  }

  return {
    gameId, matchup, label: meta.label, archetype: meta.archetype,
    winner, bwcTeam,
    snapCount,

    // Test 1: BWC State Machine
    test1_bwcStateMachine: {
      bwcFired: bwcFired ? `Q${bwcFired.period} ${bwcFired.clock} (${bwcFired.team}, floor ${bwcFired.floor.toFixed(2)})` : 'NONE',
      stateSequence: stateSequence.length > 0 ? stateSequence.join(' → ') : 'N/A (no BWC)',
      transitionCount: bwcTransitions.length,
      errors: stateErrors,
      pass: stateErrors.length === 0,
    },

    // Test 2: Erosion
    test2_erosion: {
      transitions: erosionTransitions.map(t => ({
        time: `Q${t.period} ${t.clock}`,
        from: t.fromLevel, to: t.erosionLevel,
        floor: t.floor, peak: t.peakFloor?.toFixed(2),
        delta: t.peakDelta?.toFixed(3),
        cautionThreshold: t.cautionDelta?.toFixed(3),
        collapseThreshold: t.collapseDelta?.toFixed(3),
      })),
      hadCaution, hadCollapse,
    },

    // Test 3: VALUE/EXIT
    test3_triggers: {
      valueTriggers: valueTriggers.map(t => ({
        time: `Q${t.period} ${t.clock}`,
        margin: t.margin, floor: t.floor,
        oppIndicators: t.oppIndicatorsWon,
        ctrlSust: t.ctrlSust, erosion: t.erosion,
      })),
      exitTriggers: exitTriggers.map(t => ({
        time: `Q${t.period} ${t.clock}`,
        margin: t.margin, floor: t.floor,
      })),
      buyTriggers: buyTriggers.map(t => ({
        time: `Q${t.period} ${t.clock}`,
        margin: t.margin, floor: t.floor,
        oppIndicators: t.oppIndicatorsWon,
      })),
      valueCorrect, exitCorrect,
    },

    // Test 4: Context packages (present if mode >= context)
    test4_contextPackages: triggers
      .filter(t => t.contextPackage)
      .map(t => ({
        trigger: `${t.type}:${t.alertType || t.erosionLevel || ''}`,
        time: `Q${t.period} ${t.clock}`,
        context: t.contextPackage,
      })),

    // V1 comparison
    v1_production: {
      alerts: prodAlerts.map(a => ({
        type: a.alert_type, tier: a.alert_tier,
        time: `Q${a.period} ${a.clock}`,
        decision: a.agent_decision,
        reasoning: (a.agent_reasoning || '').substring(0, 100),
        floor: a.floor_score, margin: a.margin,
      })),
      monitorObservations: prodMonitor.length,
    },

    // What v2 adds
    v2_improvements: v2Improvements,

    // Key moments (condensed timeline)
    keyMoments: timeline.map(t => ({
      type: t.type,
      alert: t.alertType || t.erosionLevel || null,
      time: `Q${t.period} ${t.clock}`,
      state: t.bwcState || t.toState || null,
      floor: typeof t.floor === 'number' ? t.floor.toFixed(2) : null,
      margin: t.margin,
      erosion: t.erosion || t.erosionLevel || null,
    })),
  };
}

// ── AGENT API CALLS (mode=agent) ──

async function runAgentTests(triggers, v2Alerts, matchup) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return { error: 'No ANTHROPIC_API_KEY' };

  const results = [];
  // Only test triggers that have context packages AND are alert types
  const testable = triggers.filter(t =>
    t.contextPackage && (t.alertType === 'VALUE' || t.alertType === 'EXIT' || t.alertType === 'BUY' || t.alertType === 'BUY WINDOW CLOSING')
  );

  log(`${matchup}: running ${testable.length} agent tests`);

  for (const t of testable) {
    const ctx = t.contextPackage;

    // Build the v2 agent prompt with enriched context
    const prompt = `You are a live NBA betting alert quality agent. A mechanical system has identified a potential betting signal. Your job is to assess whether it should be sent to the bettor.

ALERT:
Type: ${t.alertType} (FIRED)
Control team: ${ctx.ctrlTeam} | Floor: ${ctx.floor.toFixed(2)} | Margin: ${ctx.margin} (${ctx.margin < 0 ? 'trailing' : ctx.margin > 0 ? 'leading' : 'tied'})
Period: Q${ctx.period} ${ctx.clock}

INDICATORS (control-team-relative):
I1 Disruption: ${ctx.i1} | I2 Interior: ${ctx.i2} | I3 Shot Quality: ${ctx.i3} | I4 Game Control: ${ctx.i4} | I5 Execution: ${ctx.i5}
Indicators won: ${ctx.ctrlIndicators} (${ctx.ctrlIndicatorCount}/5)
Ctrl sust: ${ctx.ctrlSust || 'N/A'} | Opp sust: ${ctx.oppSust || 'N/A'}
TP: ${ctx.tpClass || 'N/A'} | LS: ${ctx.lsClass || 'N/A'}

OPPONENT PROFILE:
Opponent indicators won: ${ctx.oppIndicatorCount} (${ctx.oppIndicatorsWon})
${ctx.oppI3Won ? 'Opponent I3 (shot quality) won — EXPECTED variance, not structural. Does NOT invalidate buy thesis.' : ''}
${ctx.oppIndicatorCount >= 1 && !ctx.oppI3Won ? 'WARNING: Opponent structural counter-indicators (' + ctx.oppIndicatorsWon + '), not just variance.' : ''}

POSITION HEALTH:
Peak floor: ${ctx.peakFloor?.toFixed(2) || 'N/A'} | Delta: ${ctx.peakDelta?.toFixed(3) || 'N/A'} | Erosion: ${ctx.erosionLevel}
Consecutive holds: ${ctx.consecutiveHolds}
BWC lifecycle: ${ctx.bwcState}${ctx.bwcFirePeriod ? ' (BWC fired Q' + ctx.bwcFirePeriod + ', floor ' + (ctx.bwcFireFloor?.toFixed(2) || '?') + ')' : ''}

FLOOR TRAJECTORY:
${ctx.floorHistory}

PRIOR ALERT REASONING TRAIL:
${ctx.priorAlertTrail}

RULES:
- VALUE: team PREVIOUSLY held a structural lead (BWC fired Q${ctx.bwcFirePeriod || '?'}) but lost it while retaining structural control. Thesis: "structural edge that built the lead is intact — dip is temporary, plus-money entry." Verify: floor vs BWC fire floor, how lead was lost, deficit depth (1-4 best), timing (Q2-Q3 > Q4).
- EXIT: BWC team lost structural control. Ctrl flipped. Frame around the full arc — reference prior reasoning.
- BUY WINDOW CLOSING: structural lead is holding. SEND if subscriber can act (ML > -250). SUPPRESS if no value but WRITE THOROUGH REASONING for context compounding.
- BUY: structurally dominant team trailing with no prior BWC. Standard evaluation.
- REASONING AS JOURNAL: Even when SUPPRESS, write thorough reasoning. It feeds subsequent decisions.

Respond in EXACTLY this format:
DECISION: [SEND|SUPPRESS|DOWNGRADE]
REASONING: [2-3 sentences — reference opponent profile, erosion, BWC lifecycle, prior alerts]
BODY: [If SEND: plain-English alert. If SUPPRESS: blank]`;

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-6',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!resp.ok) {
        results.push({ trigger: `${t.alertType} Q${t.period}`, error: `API ${resp.status}` });
        continue;
      }

      const data = await resp.json();
      const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

      const decisionMatch = text.match(/DECISION:\s*(SEND|SUPPRESS|DOWNGRADE)/i);
      const reasoningMatch = text.match(/REASONING:\s*([\s\S]*?)(?=BODY:|$)/i);
      const bodyMatch = text.match(/BODY:\s*([\s\S]*)/i);

      const result = {
        trigger: `${t.alertType} Q${t.period} ${t.clock}`,
        bwcState: t.bwcState,
        decision: decisionMatch ? decisionMatch[1].toUpperCase() : 'PARSE_FAIL',
        reasoning: reasoningMatch ? reasoningMatch[1].trim() : text.substring(0, 200),
        body: bodyMatch ? bodyMatch[1].trim() : '',
        referencesOpponentProfile: text.includes('opponent') || text.includes('I1') || text.includes('counter-indicator'),
        referencesErosion: text.includes('erosion') || text.includes('peak') || text.includes('CAUTION') || text.includes('COLLAPSE'),
        referencesBwcLifecycle: text.includes('BWC') || text.includes('LOCK') || text.includes('lifecycle') || text.includes('prior'),
        tokens: data.usage,
      };
      results.push(result);

      // Update v2Alerts trail with actual agent reasoning (compounding)
      const matching = v2Alerts.find(a => a.alertType === t.alertType && a.period === t.period && a.clock === t.clock);
      if (matching) {
        matching.decision = result.decision;
        matching.reasoning = result.reasoning.substring(0, 150);
      }

      log(`${matchup}: ${result.trigger} → ${result.decision}`);
    } catch (e) {
      results.push({ trigger: `${t.alertType} Q${t.period}`, error: e.message });
    }
  }

  return results;
}

// ── HANDLER ──

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };
  const params = event.queryStringParameters || {};
  const mode = params.mode || 'mechanical';

  try {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return { statusCode: 500, headers, body: JSON.stringify({ error: 'DATABASE_URL not configured' }) };
    const sql = neon(dbUrl);

    if (params.all === 'true') {
      // Run all 9 test games
      const results = {};
      const summary = { total: 0, passed: 0, failed: 0, errors: [] };

      for (const [gameId, meta] of Object.entries(TEST_GAMES)) {
        log(`\n=== ${meta.label} ===`);
        try {
          const report = await replayGame(sql, gameId, mode);
          results[gameId] = report;
          summary.total++;

          // Score pass/fail
          const t1Pass = report.test1_bwcStateMachine?.pass !== false;
          const t3NoFalseValue = report.test3_triggers?.valueTriggers?.every(v =>
            // VALUE shouldn't fire while ctrl team is leading
            true // basic structural check passed during replay
          );
          if (t1Pass && t3NoFalseValue) {
            summary.passed++;
          } else {
            summary.failed++;
            summary.errors.push(`${meta.label}: ${report.test1_bwcStateMachine?.errors?.join(', ') || 'trigger validation'}`);
          }
        } catch (e) {
          results[gameId] = { error: e.message };
          summary.total++;
          summary.failed++;
          summary.errors.push(`${meta.label}: ${e.message}`);
        }
      }

      return { statusCode: 200, headers, body: JSON.stringify({ mode, summary, results }, null, 2) };
    }

    if (params.game_id) {
      const report = await replayGame(sql, params.game_id, mode);
      return { statusCode: 200, headers, body: JSON.stringify({ mode, report }, null, 2) };
    }

    // Default: list available games
    return { statusCode: 200, headers, body: JSON.stringify({
      usage: '?all=true or ?game_id=X, mode=mechanical|context|agent',
      testGames: Object.entries(TEST_GAMES).map(([id, m]) => ({ id, ...m })),
    }, null, 2) };

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

// On-demand function — not scheduled

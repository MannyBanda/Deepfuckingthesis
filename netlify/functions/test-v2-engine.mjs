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
//   ?monitor=true               — adds computed monitor trends to agent prompt (use with mode=agent)
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
  'b3b02f44-3d8f-4fd1-a33e-207fbf6b91b6': { label: 'MIN@DEN G2 4/20', archetype: 'VT killed Q1 floor → paper B-grad Q4 → lost. Stress override validation' },
  '2dc47535-1ae1-43d0-85d6-a2a022ca3d9e': { label: 'ATL@NYK G2 4/20', archetype: 'A-Rank W2W → Q4 collapse → EXIT → ATL FLIP BUY (+600)' },
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

// State rank for directional classification (higher = better for thesis team)
const STATE_RANK = { 'LOCK': 4, 'EDGE': 3, 'VALUE': 2, 'EXIT': 1, 'DEEP_TRAIL': 0 };

function classifyTransition(fromState, toState) {
  const fromRank = STATE_RANK[fromState] ?? -1;
  const toRank = STATE_RANK[toState] ?? -1;
  if (toRank < fromRank) return 'DEGRADING';
  if (toRank > fromRank) return 'RECOVERING';
  return 'LATERAL';
}

function computeExitSeverity(cr, lt, bwcTeam) {
  // At EXIT, the opponent holds control. Assess how structural their position is.
  const oppHolds = lt.ctrl_team_holds || 0;
  const oppFloor = cr.floor; // current ctrl team (opponent) floor
  const thesisPeak = lt.bwc_fired?.floor || 0;

  // Opponent structural indicators (from ctrl-relative, but ctrl IS the opponent now)
  const oppHasI1 = cr.ctrlIndicators.includes('I1');
  const oppHasI2 = cr.ctrlIndicators.includes('I2');
  const oppHasI4 = cr.ctrlIndicators.includes('I4');
  const oppStructuralIndicators = cr.ctrlIndicatorCount; // these are the OPPONENT's won indicators
  const oppOnlyI3 = cr.ctrlIndicatorCount === 1 && cr.ctrlIndicators.includes('I3');

  let severity = 'TEMPORARY';
  let reason = '';

  if (oppHolds >= 5 && oppFloor >= 0.70 && oppStructuralIndicators >= 2 && !oppOnlyI3) {
    severity = 'STRUCTURAL_TAKEOVER';
    reason = `Opponent floor ${oppFloor.toFixed(2)}, ${oppHolds} holds, ${oppStructuralIndicators} indicators (${cr.ctrlIndicators.join('+')})`;
  } else if (oppHolds >= 3 && (oppHasI1 || oppHasI4) && oppFloor >= 0.60) {
    severity = 'CONCERNING';
    reason = `Opponent has structural indicators (${cr.ctrlIndicators.join('+')}) with ${oppHolds} holds`;
  } else {
    reason = `Opponent floor ${oppFloor.toFixed(2)}, ${oppHolds} holds` +
      (oppOnlyI3 ? ', only I3 (variance)' : oppStructuralIndicators === 0 ? ', no indicators won' : '');
  }

  return { severity, reason, oppFloor, oppHolds, oppIndicators: cr.ctrlIndicators.join('+') || 'none' };
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

async function replayGame(sql, gameId, mode, triggerIdx = null, useMonitor = false) {
  // 1. Load game metadata
  const gameRows = await sql`SELECT * FROM games WHERE id = ${gameId}`;
  if (gameRows.length === 0) return { error: `Game ${gameId} not found` };
  const game = gameRows[0];
  const hA = game.home_alias, aA = game.away_alias;
  const matchup = game.matchup || `${aA}@${hA}`;

  // Load stored production live_tracking for graduation/lane context
  let storedLT = null;
  try {
    storedLT = game.live_tracking
      ? (typeof game.live_tracking === 'string' ? JSON.parse(game.live_tracking) : game.live_tracking)
      : null;
  } catch (e) { /* non-fatal */ }

  // 2. Load all snapshots chronologically
  // Filter out Sonnet-injected snapshots (no raw_stats_json) — these have AI-assigned indicator
  // scores that masquerade as mechanical compute, causing false ctrl flips at quarter boundaries.
  // See: GSW@SAC Q3 0:00 → Q4 12:00 diagnosis (Apr 17 session 3).
  const allSnapshots = await sql`SELECT * FROM snapshots WHERE game_id = ${gameId} ORDER BY ts ASC`;
  const snapshots = allSnapshots.filter(s => s.raw_stats_json != null);
  const filteredCount = allSnapshots.length - snapshots.length;
  if (filteredCount > 0) log(`Filtered ${filteredCount} Sonnet-injected snapshots (no raw_stats_json)`);

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
  let bwcCandidateTeam = null;  // team being evaluated for BWC (pre-fire)
  let bwcCandidateHolds = 0;    // consecutive holds for BWC candidate
  let erosionHoldCount = 0;     // hysteresis: how many snaps in current erosion level
  let prevErosionLevel = 'STABLE';

  // Material change gate for re-fires
  let lastFiredAlert = {};  // { alertType, period, clock, floor, margin, ts, bwcState }
  let lastDegradeTs = null;
  let lastRecoverTs = null;
  let lastAnyBwcTs = null;  // Universal cooldown — 3min between ANY BWC transitions
  const BWC_COOLDOWN_MS = 3 * 60 * 1000;  // 3 minutes
  let lastBuyTs = null;     // BUY cooldown — 3min between BUY fires
  const BUY_COOLDOWN_MS = 3 * 60 * 1000;
  let positionClosed = false; // Tracks post-EXIT position gate for agent context

  // Graduation state (mirrors production checkpoint system)
  let gradCheckpoints = [];
  let gradNextCpIdx = 0;
  let gradCpHolds = 0, gradCpOppHolds = 0;
  let gradCpPeakRank = 'C', gradCpGraduation = null, gradCpOppGraduation = null;
  let gradCpCtrlFlips = 0;
  let gradPoFired = false;

  // Conviction from won indicator list (lightweight version of production computeConviction)
  function convictionFromWins(wins) {
    const count = wins.length;
    const has = (a, b) => wins.includes(a) && wins.includes(b);
    const hasI4I5 = has('I4', 'I5'), hasI3I4 = has('I3', 'I4'), hasI3I5 = has('I3', 'I5');
    const isDanger = (count === 2 && wins.includes('I1') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4'))
      || (count === 3 && wins.includes('I1') && wins.includes('I2') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4'))
      || (count === 3 && wins.includes('I2') && wins.includes('I3') && wins.includes('I5') && !wins.includes('I4'));
    if (count >= 4 || hasI4I5) return 'DOMINANT';
    if ((hasI3I4 || hasI3I5) && !isDanger) return 'STRONG';
    if (count >= 2 && !isDanger) return 'MODEST';
    if (count >= 1) return 'CONDITIONAL';
    return 'NO ENTRY';
  }

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

    // First BWC fire detection — requires 3 consecutive holds at BWC-eligible conditions
    if (!bwcFirstFired && period >= 2 && cr.floor >= 0.60 && cr.margin >= 2) {
      if (bwcCandidateTeam === cr.ctrlTeam) {
        bwcCandidateHolds++;
      } else {
        bwcCandidateTeam = cr.ctrlTeam;
        bwcCandidateHolds = 1;
      }

      if (bwcCandidateHolds >= 3) {
        bwcFirstFired = true;
        const initialState = cr.margin >= 3 ? 'LOCK' : 'EDGE';
        lt.bwc_fired = {
          team: cr.ctrlTeam,
          period, clock: cr.clock,
          floor: cr.floor,
        };
        lt._prev_bwc_state = initialState;
        bwcState = initialState;

        // Initialize graduation checkpoint tracking
        const _fireGameSec = snapToGameSec(period, cr.clock);
        gradNextCpIdx = 0;
        while (gradNextCpIdx < REPLAY_GRAD_CHECKPOINTS.length && REPLAY_GRAD_CHECKPOINTS[gradNextCpIdx].gameSec <= _fireGameSec) {
          gradNextCpIdx++;
        }

        const triggerPoint = {
          type: 'BWC_FIRST_FIRE',
          snapIdx: idx, period, clock: cr.clock,
          ctrlTeam: cr.ctrlTeam, floor: cr.floor,
          margin: cr.margin, bwcState: initialState,
          erosion: erosion.level,
          holdsAtFire: bwcCandidateHolds,
        };
        triggers.push(triggerPoint);
        timeline.push({ ...triggerPoint, ts: snap.ts });

        // Record as v2 alert for compounding
        v2Alerts.push({
          alertType: 'BUY WINDOW CLOSING', bwcState: initialState,
          period, clock: cr.clock, floor: cr.floor, margin: cr.margin,
          ctrlTeam: cr.ctrlTeam, reasoning: `[INITIAL BWC FIRE — structural lead established after ${bwcCandidateHolds} holds]`,
          decision: 'SEND',
        });
        lastAnyBwcTs = snap.ts ? new Date(snap.ts).getTime() : Date.now();
        lastFiredAlert = { alertType: 'BUY WINDOW CLOSING', floor: cr.floor, margin: cr.margin, bwcState: initialState, period, clock: cr.clock };
      }
    } else if (!bwcFirstFired) {
      // Reset candidate if conditions not met
      if (cr.ctrlTeam !== bwcCandidateTeam) {
        bwcCandidateTeam = null;
        bwcCandidateHolds = 0;
      }
    }

    // BWC state transitions — directional filtering + material change gate
    if (bwcFirstFired && bwcState && bwcState !== prevBwcState) {
      const direction = classifyTransition(prevBwcState, bwcState);
      const bwcTeam = lt.bwc_fired.team;

      // Skip LATERAL transitions entirely (same rank = noise)
      // Skip DEEP_TRAIL (BUY handles these)
      if (direction !== 'LATERAL' && bwcState !== 'DEEP_TRAIL') {

        // Determine alert type from state + direction
        let alertType = null;
        if (direction === 'DEGRADING') {
          if (bwcState === 'EDGE') alertType = 'BWC_EDGE';         // lead compressing
          else if (bwcState === 'VALUE') alertType = 'VALUE';       // lead lost, ctrl retained
          else if (bwcState === 'EXIT') alertType = 'EXIT';         // ctrl flipped
        } else if (direction === 'RECOVERING') {
          if (bwcState === 'LOCK') alertType = 'POSITION_SAFE';    // full recovery
          else if (bwcState === 'EDGE') alertType = 'POSITION_RECOVERING'; // retook lead
          else if (bwcState === 'VALUE') alertType = 'THESIS_ALIVE'; // regained ctrl from EXIT
        }

        if (alertType) {
          // Material change gate: same direction re-fire needs meaningful delta
          const snapTs = snap.ts ? new Date(snap.ts).getTime() : Date.now();
          const lastSameDir = direction === 'DEGRADING' ? lastDegradeTs : lastRecoverTs;
          const msSinceLast = lastSameDir ? (snapTs - lastSameDir) : Infinity;
          const lastFloor = lastFiredAlert.floor || 0;
          const lastMargin = lastFiredAlert.margin || 0;
          const floorDelta = Math.abs(cr.floor - lastFloor);
          const marginDelta = Math.abs(cr.margin - lastMargin);
          const lastState = lastFiredAlert.bwcState || null;

          // Universal cooldown: 3min between ANY BWC transitions (prevents trail pollution)
          // THESIS_ALIVE exempt — EXIT→VALUE is always a significant state change worth evaluating
          const msSinceAnyBwc = lastAnyBwcTs ? (snapTs - lastAnyBwcTs) : Infinity;
          const cooldownExempt = alertType === 'THESIS_ALIVE';
          const cooldownPassed = cooldownExempt || msSinceAnyBwc >= BWC_COOLDOWN_MS;

          // Gate: cooldown must pass, THEN different state always fires, same state needs material change.
          const stateChanged = bwcState !== lastState;
          const materialChange = floorDelta >= 0.10 || marginDelta >= 5 || msSinceLast >= 5 * 60 * 1000;
          const shouldFire = cooldownPassed && (stateChanged || materialChange);

          if (shouldFire) {
            const triggerPoint = {
              type: 'BWC_TRANSITION',
              alertType, direction,
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

            // EXIT severity — assess opponent's structural position
            if (bwcState === 'EXIT') {
              triggerPoint.exitSeverity = computeExitSeverity(cr, lt, bwcTeam);
            }

            // Context package (mode >= context)
            if (mode !== 'mechanical') {
              triggerPoint.contextPackage = assembleContextPackage(
                snap, cr, lt, erosion, bwcState, v2Alerts, snapshots, idx, hA, aA, useMonitor, storedLT, positionClosed
              );
            }

            triggers.push(triggerPoint);
            timeline.push({ ...triggerPoint, ts: snap.ts });

            // Update gate tracking
            lastFiredAlert = { alertType, floor: cr.floor, margin: cr.margin, bwcState, period, clock: cr.clock };
            lastAnyBwcTs = snapTs;
            if (direction === 'DEGRADING') lastDegradeTs = snapTs;
            else lastRecoverTs = snapTs;

            // Record for compounding
            v2Alerts.push({
              alertType, bwcState, direction,
              period, clock: cr.clock, floor: cr.floor, margin: cr.margin,
              ctrlTeam: cr.ctrlTeam,
              reasoning: `[${direction}: ${prevBwcState} → ${bwcState}${bwcState === 'EXIT' ? ' (' + (triggerPoint.exitSeverity?.severity || '') + ')' : ''}]`,
              decision: 'PENDING',
            });

            // Track position gate for agent context
            // Only EXIT sets position closed. THESIS_ALIVE/PO only clear when agent SENDS.
            if (alertType === 'EXIT') positionClosed = true;
          }
        }
      }
    }

    // ── GRADUATION CHECKPOINTS (mirrors production checkpoint system) ──
    if (bwcFirstFired && gradNextCpIdx < REPLAY_GRAD_CHECKPOINTS.length) {
      const bwcTeam = lt.bwc_fired.team;
      const _gameSec = snapToGameSec(period, cr.clock);

      while (gradNextCpIdx < REPLAY_GRAD_CHECKPOINTS.length) {
        const nextCp = REPLAY_GRAD_CHECKPOINTS[gradNextCpIdx];
        if (_gameSec < nextCp.gameSec) break;

        const cpConvTier = convictionFromWins(cr.ctrlIndicators);
        const cpOppCount = cr.oppIndicatorCount;
        const cpEntry = { label: nextCp.label, floor: cr.floor, team: cr.ctrlTeam, margin: cr.margin, conv: cpConvTier, oppCount: cpOppCount, period, clock: cr.clock };

        // Checkpoint-level control flip
        if (gradCheckpoints.length > 0 && gradCheckpoints[gradCheckpoints.length - 1].team !== cpEntry.team) {
          gradCpCtrlFlips++;
        }
        gradCheckpoints.push(cpEntry);

        const RANK_ORDER = { C: 0, B: 1, A: 2 };

        // Update cp holds
        if (cr.ctrlTeam === bwcTeam) { gradCpHolds++; gradCpOppHolds = 0; }
        else { gradCpHolds = 0; gradCpOppHolds = (cr.margin >= 2 && cr.floor >= 0.60) ? gradCpOppHolds + 1 : 0; }

        // BWC team rank classification
        if (cr.ctrlTeam === bwcTeam && cr.margin >= 2 && cr.floor >= 0.60) {
          const cpRank = replayClassifyRank(cpConvTier, cr.margin, gradCpHolds, cpOppCount);
          if (RANK_ORDER[cpRank] > (RANK_ORDER[gradCpPeakRank] || 0)) {
            gradCpPeakRank = cpRank;
            gradCpGraduation = { rank: cpRank, cp_label: nextCp.label, cp_idx: gradNextCpIdx, floor: cr.floor, margin: cr.margin };
          }
        }

        // Opponent rank
        if (cr.ctrlTeam !== bwcTeam && gradCpOppHolds >= 2 && cr.margin >= 2 && cr.floor >= 0.60) {
          const oppRank = replayClassifyRank(cpConvTier, cr.margin, gradCpOppHolds, cpOppCount);
          if ((oppRank === 'B' || oppRank === 'A') && RANK_ORDER[oppRank] > (RANK_ORDER[gradCpOppGraduation?.rank] || 0)) {
            gradCpOppGraduation = { rank: oppRank, cp_label: nextCp.label, cp_idx: gradNextCpIdx, floor: cr.floor, margin: cr.margin };
          }
        }

        // MF stats
        const eligible = gradCheckpoints.filter(cp => cp.team === bwcTeam && cp.floor >= 0.60 && cp.margin >= 2);
        const gradMF = eligible.length > 0 ? eligible.reduce((s, cp) => s + cp.floor, 0) / eligible.length : null;
        const gradMinF = eligible.length > 0 ? Math.min(...eligible.map(cp => cp.floor)) : null;

        // ── POSITION OPEN CHECK ──
        if (gradCpGraduation && !gradPoFired && cr.ctrlTeam === bwcTeam) {
          const gRank = gradCpGraduation.rank;
          const MF_GATE = 0.65, MIN_F_GATE = 0.58; // NBA defaults
          const B_CONFIRM_SEC = 1800; // Q3_6

          let poFires = false;
          if (gRank === 'A' && gradMF >= MF_GATE && gradMinF >= MIN_F_GATE) poFires = true;
          if (gRank === 'B' && _gameSec >= B_CONFIRM_SEC && gradMF >= MF_GATE && gradMinF >= MIN_F_GATE) poFires = true;

          if (poFires) {
            gradPoFired = true;
            const mfTraj = computeMFTrajectory(gradCheckpoints, bwcTeam);
            const triggerPoint = {
              type: 'GRADUATION_PO',
              alertType: 'POSITION_OPEN',
              snapIdx: idx, period, clock: cr.clock,
              ctrlTeam: cr.ctrlTeam, floor: cr.floor, margin: cr.margin,
              bwcState,
              poRank: gRank, mf: gradMF, minF: gradMinF,
              cpFlips: gradCpCtrlFlips, cpEligible: eligible.length,
              mfTrajectory: mfTraj,
              positionClosed,
            };
            if (mode !== 'mechanical') {
              triggerPoint.contextPackage = assembleContextPackage(
                snap, cr, lt, erosion, bwcState, v2Alerts, snapshots, idx, hA, aA, useMonitor, storedLT, positionClosed
              );
              // Enrich context with graduation data
              if (triggerPoint.contextPackage) {
                triggerPoint.contextPackage.poRank = gRank;
                triggerPoint.contextPackage.cpPeakRank = gradCpPeakRank;
                triggerPoint.contextPackage.cpGraduation = gradCpGraduation;
                triggerPoint.contextPackage.cpOppGraduation = gradCpOppGraduation;
                triggerPoint.contextPackage.cpMeanFloor = gradMF ? Math.round(gradMF * 1000) / 1000 : null;
                triggerPoint.contextPackage.cpMinFloor = gradMinF ? Math.round(gradMinF * 1000) / 1000 : null;
                triggerPoint.contextPackage.cpEligibleCount = eligible.length;
                triggerPoint.contextPackage.cpCtrlFlips = gradCpCtrlFlips;
                triggerPoint.contextPackage.mfTrajectory = mfTraj;
              }
            }
            triggers.push(triggerPoint);
            timeline.push({ ...triggerPoint, ts: snap.ts });

            // positionClosed stays true — only agent SEND should clear

            v2Alerts.push({
              alertType: 'POSITION_OPEN', bwcState, direction: null,
              period, clock: cr.clock, floor: cr.floor, margin: cr.margin,
              ctrlTeam: cr.ctrlTeam,
              reasoning: `[GRADUATION PO: ${gRank}-Rank @ ${gradCpGraduation.cp_label}, MF=${gradMF?.toFixed(3)}, ${gradCpCtrlFlips} cp flips${positionClosed ? ', RE-ENTRY (position was closed)' : ''}]`,
              decision: 'PENDING',
            });
          }
        }

        gradNextCpIdx++;
      }
    }

    // Erosion transitions with hysteresis
    // Once in CAUTION/COLLAPSE, stay there for at least 2 snapshots before returning to STABLE
    if (bwcFirstFired) {
      let effectiveErosion = erosion.level;

      // Hysteresis: if we were at CAUTION/COLLAPSE and raw says STABLE, check hold count
      if ((prevErosionLevel === 'CAUTION' || prevErosionLevel === 'COLLAPSE') && effectiveErosion === 'STABLE') {
        if (erosionHoldCount < 2) {
          effectiveErosion = prevErosionLevel; // hold the elevated level
        }
      }

      if (effectiveErosion !== prevErosionLevel) {
        erosionHoldCount = 1; // reset hold on transition
        const triggerPoint = {
          type: 'EROSION_TRANSITION',
          fromLevel: prevErosionLevel, erosionLevel: effectiveErosion,
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
        prevErosionLevel = effectiveErosion;
      } else {
        erosionHoldCount++;
      }
    }

    // BUY trigger — fires for ANY structurally dominant team trailing, including BWC team.
    // BWC lifecycle (VALUE, THESIS_ALIVE) tracks position health for holders.
    // BUY identifies entry/re-entry opportunities at plus-money. They coexist.
    if (period >= 2 && cr.floor >= 0.55 && cr.margin < 0 && cr.margin >= -15) {
      // Clock gate: suppress < 1 min remaining (hard gate from production)
      const clockMin = parseFloat(cr.clock) || 0;
      const snapTs = snap.ts ? new Date(snap.ts).getTime() : Date.now();
      const msSinceLastBuy = lastBuyTs ? (snapTs - lastBuyTs) : Infinity;
      if (clockMin >= 1.0 && msSinceLastBuy >= BUY_COOLDOWN_MS) {
        const buyTier = cr.floor >= 0.65 ? 'FIRED' : 'CANDIDATE';
        const buyKey = `BUY_${buyTier}_Q${period}_${cr.margin}`;
        if (buyKey !== lastTriggerKey) {
          lastTriggerKey = buyKey;
          lastBuyTs = snapTs;
          const triggerPoint = {
            type: 'BUY_TRIGGER',
            alertType: 'BUY',
            buyTier,
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
            bwcTeamMatch: (lt.bwc_fired?.team === cr.ctrlTeam) ? 'YES' : 'NO',
          };
          if (mode !== 'mechanical') {
            triggerPoint.contextPackage = assembleContextPackage(
              snap, cr, lt, erosion, bwcState, v2Alerts, snapshots, idx, hA, aA, useMonitor, storedLT, positionClosed
            );
          }
          triggers.push(triggerPoint);
          timeline.push({ ...triggerPoint, ts: snap.ts });
        }
      }
    }

    prevBwcState = bwcState;
  }

  // 6. Build validation report
  const report = buildReport(gameId, game, matchup, lt, triggers, timeline, stateLog, prodAlerts, prodMonitor, snapshots.length);

  // 7. If mode=agent, run API calls at trigger points
  if (mode === 'agent') {
    report.agentResults = await runAgentTests(sql, gameId, triggers, v2Alerts, matchup, triggerIdx, useMonitor);
  }

  return report;
}

// ── CONTEXT PACKAGE ASSEMBLY ──

// MF trajectory — copied from production poll-live-bdl.mjs
function computeMFTrajectory(checkpoints, bwcTeam) {
  const eligible = checkpoints.filter(cp =>
    cp.team === bwcTeam && cp.floor >= 0.60 && cp.margin >= 2
  );
  if (eligible.length < 2) return { direction: 'INSUFFICIENT', floors: eligible.map(cp => cp.floor) };
  const mid = Math.floor(eligible.length / 2);
  const firstHalf = eligible.slice(0, mid);
  const secondHalf = eligible.slice(mid);
  const firstAvg = firstHalf.reduce((s, cp) => s + cp.floor, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((s, cp) => s + cp.floor, 0) / secondHalf.length;
  const delta = secondAvg - firstAvg;
  let direction;
  if (delta > 0.04) direction = 'RISING';
  else if (delta < -0.04) direction = 'DECLINING';
  else direction = 'FLAT';
  return { direction, delta: Math.round(delta * 1000) / 1000, floors: eligible.map(cp => cp.floor),
    firstAvg: Math.round(firstAvg * 1000) / 1000, secondAvg: Math.round(secondAvg * 1000) / 1000 };
}


// ── buildV2AgentPrompt — copied from production poll-live-bdl.mjs for 1:1 prompt parity ──
function buildV2AgentPrompt(ctx) {
  // Build structural stress section (rolling window, combined read, gap acceleration, per-quarter data)
  // Same format as formatSonnetPrompt so agent sees identical data layers as auto-analysis
  let stress = '';
  const rw = ctx.windowData;
  if (rw && rw.available) {
    const wLabel = rw.windowQuarters ? rw.windowQuarters.join('+') : '?';
    stress += `STRUCTURAL STRESS (rolling window vs cumulative — does the recent game agree with the floor?):\n`;
    stress += `Window (${wLabel}, ${rw.windowPossessions || '?'} poss): ${rw.controlTeam} ${rw.score != null ? rw.score.toFixed(2) : '?'}\n`;
    ['I1','I2','I3','I4','I5'].forEach(k => {
      const i = rw[k];
      if (i && i.score != null) stress += `  ${k}: ${i.score.toFixed(1)} — ${i.detail || ''}\n`;
    });
    stress += `Data quality: ${rw.dataQuality || '?'}\n`;
  } else {
    stress += `STRUCTURAL STRESS: Window not yet available\n`;
  }
  // Combined read
  if (ctx.combinedRead && ctx.combinedRead.read) {
    stress += `Combined read: ${ctx.combinedRead.read} — ${ctx.combinedRead.note || ''}\n`;
  }
  // Warning for COLLAPSING/FLIPPED
  if (ctx.combinedRead && (ctx.combinedRead.read === 'COLLAPSING' || ctx.combinedRead.read === 'FLIPPED')) {
    const wCtrl = rw ? rw.controlTeam || '?' : '?';
    stress += `WARNING: Rolling window DISAGREES with cumulative floor. Recent quarters favor ${wCtrl}. Cumulative indicators may be anchored from earlier quarters that no longer reflect game state.\n`;
  }
  // Gap acceleration with history (same format as formatSonnetPrompt)
  if (ctx.accelData && ctx.accelData.entries && ctx.accelData.entries.length > 0) {
    const acc = ctx.accelData;
    const last = acc.entries[acc.entries.length - 1];
    stress += `Gap: ${last.gap >= 0 ? '+' : ''}${last.gap != null ? last.gap.toFixed(3) : '?'} | Acceleration: ${acc.accel} (${acc.consecutive} consecutive)\n`;
    stress += `History: ${acc.entries.slice(-5).map(e => (e.gap >= 0 ? '+' : '') + (e.gap != null ? e.gap.toFixed(2) : '?') + ' (' + e.score + ')').join(' -> ')}\n`;
  } else if (ctx.accelData) {
    stress += `Acceleration: ${ctx.accelData.accel || 'TOO EARLY'}\n`;
  }
  // Per-quarter breakdown (same format as formatSonnetPrompt lines 3161-3169)
  if (ctx.quarterDiffs && Object.keys(ctx.quarterDiffs).length > 0) {
    stress += `Per-quarter breakdown:\n`;
    const qdKeys = Object.keys(ctx.quarterDiffs).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
    for (const qk of qdKeys) {
      const d = ctx.quarterDiffs[qk];
      if (!d || !d.home || !d.away) continue;
      const h = d.home, a = d.away;
      const hPaint = h.points_in_the_paint || h.points_in_paint || 0;
      const aPaint = a.points_in_the_paint || a.points_in_paint || 0;
      stress += '  Q' + qk + ' (' + ctx.homeAlias + ' vs ' + ctx.awayAlias + '):'
        + ' Paint ' + ctx.homeAlias + ':' + hPaint + ' ' + ctx.awayAlias + ':' + aPaint
        + ' | FTA ' + ctx.homeAlias + ':' + (h.free_throws_att||0) + ' ' + ctx.awayAlias + ':' + (a.free_throws_att||0)
        + ' | 3P ' + ctx.homeAlias + ':' + (h.three_points_made||0) + '/' + (h.three_points_att||0) + ' ' + ctx.awayAlias + ':' + (a.three_points_made||0) + '/' + (a.three_points_att||0)
        + ' | AST ' + ctx.homeAlias + ':' + (h.assists||0) + ' ' + ctx.awayAlias + ':' + (a.assists||0)
        + ' | TO ' + ctx.homeAlias + ':' + (h.turnovers||h.total_turnovers||0) + ' ' + ctx.awayAlias + ':' + (a.turnovers||a.total_turnovers||0)
        + ' | STL ' + ctx.homeAlias + ':' + (h.steals||0) + ' ' + ctx.awayAlias + ':' + (a.steals||0)
        + (h.possessions ? ' | Poss ' + ctx.homeAlias + ':' + (h.possessions||0) + ' ' + ctx.awayAlias + ':' + (a.possessions||0) : '')
        + '\n';
    }
  }

  // MF trajectory string for prompt sections
  const mfTraj = ctx.mfTrajectory;
  const mfTrajStr = mfTraj
    ? `MF ${mfTraj.direction} (${mfTraj.floors.map(f => f.toFixed(2)).join(' -> ')})${mfTraj.direction !== 'INSUFFICIENT' ? ' delta=' + (mfTraj.delta > 0 ? '+' : '') + mfTraj.delta.toFixed(3) : ''}`
    : 'No trajectory data';

  return `You are a live NBA betting alert quality agent. A mechanical system has identified a potential betting signal. Your job is to assess whether it should be sent to the bettor.

ALERT:
Type: ${ctx.alertType} (${ctx.alertTier || 'FIRED'})
Control team: ${ctx.ctrlTeam} | Floor: ${ctx.floor} | Margin: ${ctx.margin} (${ctx.margin < 0 ? 'trailing' : ctx.margin > 0 ? 'leading' : 'tied'})
Score: ${ctx.awayAlias} ${ctx.awayPts} - ${ctx.homeAlias} ${ctx.homePts} (${ctx.ctrlTeam} is ${ctx.ctrlIsHome ? 'HOME' : 'AWAY'})
Period: Q${ctx.period} ${ctx.clock}
${ctx.bwcTeam ? 'BWC team (subscriber position): ' + ctx.bwcTeam + (ctx.bwcTeam !== ctx.ctrlTeam ? ' (NOT current ctrl team — ctrl flipped to ' + ctx.ctrlTeam + ')' : '') : ''}
${ctx.isFlipBuy ? `
FLIP BUY CONTEXT:
An EXIT alert was SENT for ${ctx.flipBuyContext.exitTeam} at Q${ctx.flipBuyContext.exitPeriod} ${ctx.flipBuyContext.exitClock} (floor was ${ctx.flipBuyContext.exitFloor?.toFixed(2) || '?'}, margin ${ctx.flipBuyContext.exitMargin || '?'}).
The structural edge has been confirmed as flipped — this BUY is NOT counter-betting. It is an independent structural signal on the team that took control away from the original position.
The EXIT + BUY firing simultaneously is TWO independent signals corroborating the same structural reversal.
Evaluate ${ctx.ctrlTeam}'s structural case on its own merit. The position gate is LIFTED — the subscriber was already told to exit ${ctx.flipBuyContext.exitTeam}.` : ''}

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
Peak floor: ${ctx.peakFloor != null ? Number(ctx.peakFloor).toFixed(2) : 'N/A'} | Delta: ${ctx.peakDelta != null ? Number(ctx.peakDelta).toFixed(3) : 'N/A'} | Erosion: ${ctx.erosionLevel}
Consecutive holds: ${ctx.consecutiveHolds}
BWC lifecycle: ${ctx.bwcState}${ctx.bwcFirePeriod ? ' (BWC fired Q' + ctx.bwcFirePeriod + ', floor ' + (ctx.bwcFireFloor != null ? Number(ctx.bwcFireFloor).toFixed(2) : '?') + ')' : ''}
${ctx.positionClosed ? 'POSITION STATE: CLOSED — an EXIT was previously SENT. The subscriber was told to exit this position. Any SEND decision on a position alert (POSITION_OPEN, THESIS_ALIVE) will RE-OPEN the position for the subscriber.' : ''}
${ctx.cpGraduation 
  ? 'Graduation: ' + ctx.cpPeakRank + '-Rank (graduated @ ' + ctx.cpGraduation.cp_label + ', floor was ' + Number(ctx.cpGraduation.floor).toFixed(2) + ') | ' + mfTrajStr + ' | MF=' + (ctx.cpMeanFloor?.toFixed(3) || '?') + ' minF=' + (ctx.cpMinFloor?.toFixed(2) || '?') + ' (' + ctx.cpEligibleCount + ' eligible CPs)'
    + (ctx.cpOppGraduation ? ' | OPPONENT ALSO GRADUATED ' + ctx.cpOppGraduation.rank + '-Rank @ ' + ctx.cpOppGraduation.cp_label : '')
  : 'Pre-graduation (' + (ctx.cpEligibleCount || 0) + ' eligible CPs, MF=' + (ctx.cpMeanFloor?.toFixed(3) || '?') + ' ' + mfTrajStr + ')'
} | Lane: ${ctx.lane || 'unknown'} (pregame ML ${ctx.pregameML || '?'}) | CP flips: ${ctx.cpCtrlFlips} | Control flips (game total): ${ctx.ctrlFlips}

${stress}
FLOOR TRAJECTORY:
${ctx.floorHistory || 'No prior snapshots'}

PRIOR ALERT REASONING TRAIL:
${ctx.priorAlertTrail || 'None'}

RULES:
- TRACKING: First structural signal — the system just identified ${ctx.ctrlTeam} as structurally interesting (3 consecutive holds, floor ${ctx.floor}, margin ${ctx.margin}). This is NOT a position recommendation — the subscriber learns a game is on the radar. ALWAYS SEND unless the game is clearly meaningless (garbage time, both teams eliminated, period 4 with < 2 min left). Body should explain: which team, what structural picture (indicators, floor, margin), and that we are watching for the edge to develop. Frame as: "Watching [TEAM] — [why they look structurally dominant]. Will update if this develops into a position." Keep it short — this is a heads-up, not a thesis.
- POSITION_OPEN: The team has GRADUATED through the checkpoint system — sustained structural rank confirmed across multiple 3-minute evaluation windows.
  ${ctx.bwcFlipped ? 'BWC FLIP: The system originally tracked ' + ctx.originalBwcTeam + ' but they FAILED to graduate (peak C). ' + ctx.bwcTeam + ' then graduated ' + ctx.poRank + '-Rank — taking structural control away from a previously dominant team. This is one of the strongest signals in the system (74-86% win rate). The floor appears modest because cumulative stats are anchored by ' + ctx.originalBwcTeam + "'s early dominance, but " + ctx.bwcTeam + " is holding control DESPITE that headwind. ALWAYS SEND."
  : ctx.poRank === 'A' && ctx.cpCtrlFlips === 0 ? 'A-Rank WIRE-TO-WIRE (85.6%): Zero checkpoint-level control flips — structural dominance unchallenged. ' + mfTrajStr + ' across ' + ctx.cpEligibleCount + ' checkpoints. ALWAYS SEND.'
  : ctx.poRank === 'A' ? 'A-Rank: Sustained DOMINANT conviction with lead 8+. ' + mfTrajStr + ' across ' + ctx.cpEligibleCount + ' checkpoints. CP flips: ' + ctx.cpCtrlFlips + (ctx.cpCtrlFlips >= 2 ? ' (multiple flips — A-with-flips is 58.5% in competitive games. Apply extra scrutiny: check structural stress, per-quarter breakdown, whether indicators that powered graduation are still held.)' : '') + '.'
  : ctx.poRank === 'B' ? 'B-Rank: Sustained DOMINANT/STRONG conviction with lead 3+. ' + mfTrajStr + ' across ' + ctx.cpEligibleCount + ' checkpoints.'
  + (ctx.cpCtrlFlips === 0 ? ' Zero CP flips — clean structural hold. Standard evaluation.'
   : ctx.cpCtrlFlips === 1 ? ' 1 CP flip — structural control briefly contested. Check: did the BWC team reclaim indicators that slipped? If yes, the graduation is earned through recovery. If the same indicators are still contested, the flip signals fragility.'
   : ' ' + ctx.cpCtrlFlips + ' CP flips — structural control REPEATEDLY contested. B-rank with multiple flips is significantly weaker than B with zero flips. The graduation badge says the team held long enough to pass mechanical gates, but the flips say the opponent keeps taking control back. Apply A-with-flips level scrutiny (58.5% baseline): check structural stress, verify indicators that powered graduation are still held in recent quarters, and confirm the current checkpoint is not another temporary reclaim before the next flip. DOWNGRADE if stress is SHIFT/ERODING. SUPPRESS if stress is COLLAPSING.')
  : ''}
  ${!ctx.bwcFlipped ? 'Lane: ' + (ctx.lane || 'unknown') + '. ' + (ctx.lane === 'underdog' ? 'UNDERDOG graduation — market has not priced structural control. Edge is structural floor vs implied probability. ALWAYS SEND.' : ctx.lane === 'heavy_favorite' ? 'Heavy favorite — PO confirms structural read but line may offer limited edge. Frame as position confirmation, not direct entry.' : 'Evaluate edge: floor vs current ML implied probability.') : ''}
  ${ctx.positionClosed ? 'POST-EXIT RE-ENTRY: The subscriber was told to EXIT this position earlier in the game. If you SEND this POSITION_OPEN, you are telling them to RE-ENTER — this must clear a HIGHER bar than a normal PO. The structural thesis PREVIOUSLY FAILED (that is why EXIT fired). For re-entry to be justified: (1) graduation must show RISING or FLAT MF trajectory with 3+ eligible checkpoints — the team rebuilt control over sustained evaluation windows AFTER the EXIT, (2) structural stress combined read must be REINFORCING or DOMINANT — not COLLAPSING/SHIFT/ERODING, (3) the indicators that powered the EXIT (opponent gaining I1/I2/I4) must have flipped BACK to the BWC team in the per-quarter breakdown. If ANY of these fail, SUPPRESS — the graduation badge is stale anchoring from pre-EXIT dominance, not evidence of current control. DOWNGRADE is acceptable if graduation is mechanically real but stress is mixed.' : ''}
  This IS a position recommendation. Body should reference the arc from TRACKING (if prior alert exists), explain the graduation criteria met, current structural picture, and frame as: "Position open on [TEAM] — [rank] structural edge confirmed." Include odds/ML if available.
- VALUE: team PREVIOUSLY held a structural lead (BWC fired Q${ctx.bwcFirePeriod || '?'}) but lost it while retaining structural control. Thesis: "structural edge that built the lead is intact — dip is temporary, plus-money entry." Verify: floor vs BWC fire floor, how lead was lost, deficit depth (1-7 best), timing (Q2-Q3 > Q4). If prior BWC_EDGE alerts flagged a RISK, reference whether it materialized. SUPPRESS if erosion is COLLAPSE AND structural indicators (I1/I4) have flipped to opponent.
- THESIS_ALIVE: BWC team regained structural control AFTER an EXIT. This is a deep-value play — floor erosion is EXPECTED and is WHY plus-money exists. DO NOT treat floor level or erosion as primary factors. Weight hierarchy: (1) WHICH indicators does the BWC team still hold? I1 Disruption + I4 Game Control = structural core retained. (2) Is opponent's edge variance-based? oppI3Won=true means opponent is shooting well, not structurally dominant — this is the thesis. (3) TP path — STRONG RECOVERY or PROBABLE = mechanical path exists. (4) Deficit depth and timing. Floor being below BWC fire floor is the ENTRY SIGNAL, not a red flag. SUPPRESS only if: BWC team lost I1+I4 (structural core gone), OR opponent has non-I3 structural indicators (I1/I2/I4), OR TP is NO PATH/UNLIKELY with < 3 min left.
- EXIT: BWC team (${ctx.bwcFirePeriod ? 'the team that fired BWC in Q' + ctx.bwcFirePeriod : 'original BWC team'}) lost structural control. The SUBSCRIBER'S POSITION is on the BWC team, NOT the current control team. Frame the exit around the BWC team losing their edge. Reference the full arc from prior alerts.
- BWC_EDGE: SEND by default — this is a position update for a subscriber already holding. Frame as reassurance: structural picture holding, lead compressing. Do NOT frame as a buy signal. MAY SUPPRESS if structural stress override applies (see STRUCTURAL STRESS CHECK). MUST include a RISK line at the end of the body — identify the ONE specific thing that could flip this position next (e.g., indicator about to flip, sustainability degrading, erosion approaching threshold). If prior alerts flagged a RISK, reference whether it materialized or not. The RISK line creates accountability across the alert chain. Format body as: status update (2-3 sentences) + "RISK: [specific forward-looking concern]"
- POSITION_SAFE / POSITION_RECOVERING: SEND as reassurance if prior alerts flagged risks or concerns. Include whether prior RISK materialized. SUPPRESS only if nothing changed AND no prior risk to update on. Write reasoning for compounding either way.
- BUY: structurally dominant team trailing. Standard evaluation — floor, indicators, TP, deficit depth (1-7 sweet spot; deeper deficits need stronger structural case). When bwcTeamMatch is noted, the team has BWC lifecycle context — reference the position arc. This is a "warm BUY" (thesis history). Without BWC context = "cold BUY" (unproven, higher bar for SEND).
- BUY EVIDENCE (from 9,861-snapshot backtest, 502 BUY-eligible):
  WHAT WINS: trail 1-4 (44.6%) > trail 5-9 (25%) > trail 10+ (0%). 3+ ctrl indicators (45.6%) > <=2 (36.6%). Opp 0 indicators (48.6%) vs opp I1 or I2 won (28.5%). Best stack: trail 1-4 + 3+ ind + opp 0 indicators = 57.4% (n=115).
  POWER PAIRS: I1+I2 (55.2%, n=134) is the BUY anchor — physical dominance while trailing. I1+I4 (52.4%). TRAP: I3+I4 (38.9%, n=149) — the BWC killer combo is the WORST BUY pair.
  I3 INVERSION: ctrl I3 won = 37.3%. ctrl I3 LOST (opp shooting well) = 49%. When the BUY team has shot quality but is STILL trailing, they are losing for reasons shooting cannot fix. When trailing BECAUSE of poor shooting, that is the variance the thesis exploits.
  OPPONENT KILLS: opp I1 (disruption) -> 28.8%. opp I2 (paint) -> 30.6%. opp I1 OR I2 -> 28.5%. These are STRUCTURAL threats. opp I3 only -> thesis intact (variance).
  TIMING: Q4 trail 5-9 = 14.8% — hard suppress. Q4 trail 1-4 = 43% — still viable.
  CHECKPOINT GRADUATION CONTEXT (additional data for BUY evaluation — does not override BUY evidence above):
  ${ctx.cpGraduation
    ? 'BWC team (' + ctx.bwcTeam + ') GRADUATED ' + ctx.cpPeakRank + '-Rank @ ' + ctx.cpGraduation.cp_label + '. ' + mfTrajStr
    : ctx.cpEligibleCount > 0
      ? 'BWC team (' + ctx.bwcTeam + ') pre-graduation: ' + ctx.cpEligibleCount + ' eligible checkpoints. ' + mfTrajStr
      : ctx.bwcTeam
        ? 'BWC team (' + ctx.bwcTeam + ') tracked but no eligible checkpoints — structural interest identified but never confirmed.'
        : 'No BWC context — cold BUY.'
  }
  ${ctx.cpOppGraduation ? 'Opponent graduated ' + ctx.cpOppGraduation.rank + '-Rank @ ' + ctx.cpOppGraduation.cp_label + (ctx.cpOppGraduation.cp_idx > (ctx.cpGraduation?.cp_idx ?? -1) ? ' (MORE RECENT than BWC graduation — opponent is structurally ascending)' : '') : ''}
  ${ctx.bwcFlipped ? 'BWC FLIPPED: System originally tracked ' + ctx.originalBwcTeam + ' -> structural control transferred to ' + ctx.bwcTeam + '. Latest-to-graduate wins 84.5% historically.' : ''}
  
  BWC LIFECYCLE STATUS FOR BUY DECISIONS:
  The BUY team's relationship to the BWC lifecycle determines baseline confidence:
  
  - BUY team = current BWC team WITH active PO: "Warm BUY" — graduated team trailing is the thesis working. MF trajectory tells you if the structural edge is holding.
  - BUY team = current BWC team WITHOUT PO (graduated but gates blocked): Structural edge confirmed mechanically but quality didn't meet PO gates. Moderate confidence — rely on standard BUY evidence with graduation as supporting context.
  - BUY team = BWC team but NEVER graduated (tracked, no graduation): System identified structural interest but edge never separated. Lower confidence. Rely entirely on standard BUY evidence. MF trajectory may show INSUFFICIENT.
  - BUY team = original BWC team but BWC was FLIPPED to opponent: Near-automatic SUPPRESS. This team LOST structural control to the opponent. You are buying against the confirmed structural direction. The team that took it away from them graduated more recently and wins 84.5% of the time.
  - BUY team = opponent of BWC team (not flipped): Evaluate independently. If opponent has graduated, their structural case is strong — they earned it against the BWC team.
  - No BWC context at all: Cold BUY — rely entirely on standard BUY evidence above.
  
  FLIP BUY (EXIT + opponent BUY = structural reversal):
  When FLIP BUY CONTEXT is present above, the system has confirmed the structural reversal from TWO independent directions: EXIT confirmed the original position is dead, AND BUY independently identified the new control team as structurally dominant. This is NOT counter-betting — it is the highest-conviction structural signal because both the protective system (EXIT) and the offensive system (BUY) agree.
  
  SEND if: BUY team controls 2+ indicators AND at least one is I1 (disruption) or I2 (interior) — these are structural, not variance.
  SEND if: combined read = FLIPPED — the rolling window confirms the structural reversal.
  LEAN SEND if: combined read = COLLAPSING AND BUY team controls I1 or I2 — reversal in progress, structural indicators confirm direction.
  SUPPRESS if: BUY team's only advantage is I3 (shot quality) — variance on both sides, no confirmed structural reversal.
  SUPPRESS if: combined read = ERODING only — EXIT may have been premature, edge hasn't fully transferred. Wait for stronger confirmation.
  SUPPRESS if: deficit > 9 or < 1 min remaining — structural reversal confirmed but no betting window.
  
  Body MUST frame as structural reversal: "STRUCTURAL FLIP — your [exitTeam] position was exited at [time] because structural control shifted to [buyTeam]. [buyTeam] now independently qualifies as a BUY — [specific indicators]. This is not a counter-bet — the system independently confirmed the structural edge reversed."
  
  HOW TO USE MF TRAJECTORY ON BUY DECISIONS:
  - RISING = structural thesis is building, not fading. Trailing is more likely variance. Increases BUY confidence.
  - FLAT = structural edge is real but not separating. Apply standard BUY scrutiny from evidence above.
  - DECLINING = the game may have shifted since graduation. The rank badge is stale. Extra skepticism — check if indicators that powered graduation are still held.
  - INSUFFICIENT = fewer than 2 eligible checkpoints. Rely on standard BUY evidence.
  
  LANE AMPLIFIERS:
  - Underdog + RISING MF = highest confidence — market hasn't priced sustained structural control, and it's getting stronger.
  - Heavy favorite + DECLINING MF = lowest confidence — expected dominance is fading, position may be compromised.
  
  DEFICIT DEPTH + GRADUATION: trail 5-9 with graduation = structural thesis may be wrong, apply extra scrutiny regardless of trajectory. Trail 10+ with graduation = near-automatic SUPPRESS (the structural read was incorrect regardless of rank).
  
  HOW TO USE CP FLIPS ON BUY DECISIONS:
  
  POSITION OPEN (agent endorsed PO — subscriber holds a position):
  The agent already validated this graduation. Trailing is the thesis working. CP flips provide risk context.
  - 0 flips = strongest warm BUY. Structural thesis unchallenged — trailing is pure variance.
  - 1-2 flips = warm BUY with caution. Note flips in RISK line. Apply standard BUY evidence.
  - 3+ flips = extreme skepticism. Structural control has been REPEATEDLY contested at the checkpoint level — this is a competitive game, not a structural mismatch. The graduation may be mechanically valid but the game is not separating. Rely entirely on standard BUY evidence (deficit depth, indicator profile, opponent indicators). Do NOT treat graduation as confidence — treat it as context only. SUPPRESS unless BUY evidence is independently strong (trail 1-4, 3+ indicators, opp 0 structural indicators).
  
  POSITION CLOSED (EXIT was sent — agent already rejected this thesis):
  The thesis BROKE. The agent already said to exit and may have suppressed re-entry. Rank at original graduation does not matter — A and B exits are equally severe. What matters is the quality of re-graduation AFTER the exit.
  - If original rank was A and team re-graduates B or A: the structural foundation was deep enough to earn A originally. Re-graduation is more credible — the team has a proven ability to sustain structural control. Still requires something fundamentally changed since the SUPPRESS reasoning.
  - If original rank was B and team re-graduates B or A: weaker credibility. The team never fully separated structurally before the thesis broke. Re-graduation may be cumulative anchoring. Apply extreme skepticism — require clear evidence in per-quarter breakdown that recent quarters (post-EXIT) are structurally dominated by the BUY team, not just cumulative carryover.
  - In BOTH cases: reference the agent's prior EXIT and SUPPRESS reasoning from the PRIOR ALERT REASONING TRAIL. What specific structural failures caused the EXIT? Have those specific indicators flipped back? If the same weaknesses persist, SUPPRESS regardless of re-graduation rank.
- STRUCTURAL STRESS CHECK: When combined read is COLLAPSING, FLIPPED, or SHIFT, the cumulative floor may be anchored from earlier-quarter dominance that has since eroded. The rolling window shows who is winning RECENT quarters.
  For entry signals (BUY, VALUE, THESIS_ALIVE): COLLAPSING + trailing = near-automatic SUPPRESS. SHIFT = extreme skepticism.
  For position alerts (POSITION_OPEN, BWC_EDGE, POSITION_SAFE, POSITION_RECOVERING): When the rolling window is SIGNIFICANTLY weaker than the cumulative floor, you MAY SUPPRESS or DOWNGRADE — this OVERRIDES the per-alert-type ALWAYS SEND rules above. The graduation badge does not guarantee current structural control. Evaluate whether the indicators that powered graduation are still held in recent quarters using the per-quarter breakdown. If recent quarters show the opponent winning paint, disruption, or game control, the graduation is stale.
  DOWNGRADE is preferred over SUPPRESS for POSITION_OPEN (subscriber should know graduation happened but that it is contested).
  BWC_EDGE and POSITION_SAFE may fully SUPPRESS (these are updates to existing positions — no value in reassuring the subscriber about a position that is structurally compromised).
  EXEMPT from stress override: EXIT (always SEND), TRACKING (always SEND), A-Rank WIRE-TO-WIRE with 0 flips (strongest signal, stress override should not touch).
  REINFORCING (DOMINANT/STRONG combined read) = cumulative floor is trustworthy, proceed normally with per-alert-type rules.
- REASONING AS JOURNAL: Even when SUPPRESS, write thorough reasoning. It feeds subsequent decisions.

BODY RULES (read by non-technical bettors on their phone):
- Lead with score + action, explain WHY in basketball terms with structural data, end with what to watch.
- Translate indicators: I1=turnovers/steals, I2=paint/interior, I3=shot quality, I4=game flow, I5=pace/execution.
- Say "X/5 structural categories (codes)" not just codes. Include conviction, edge %, sustainability tiers.
- 2-4 sentences max. Keep structural metrics but make them readable.

Respond in EXACTLY this format:
DECISION: [SEND|SUPPRESS|DOWNGRADE]
REASONING: [2-3 sentences — reference opponent profile, erosion, BWC lifecycle, prior alerts]
BODY: [If SEND: plain-English alert. If SUPPRESS: blank]`;
}

function assembleContextPackage(snap, cr, lt, erosion, bwcState, v2Alerts, allSnaps, idx, hA, aA, useMonitor = false, storedLT = null, positionClosed = false) {
  // Floor history (last 5 raw snapshots before current — agent reads these directly)
  const histStart = Math.max(0, idx - 5);
  const rawWindow = allSnaps.slice(histStart, idx + 1);
  const floorHistory = rawWindow.map(s => {
    const ft = s.floor_team || '?';
    return `Q${s.period} ${s.clock}: ${ft} ${Number(s.floor_score || 0).toFixed(2)} (${s.away_pts}-${s.home_pts}) TP:${s.tp_class || '?'} LS:${s.ls_class || '?'}`;
  }).reverse().join('\n');

  // ── Inline trend signals (deduped window, no stale polls) ──
  let trendSignals = null;
  if (useMonitor) {
    // Pull wider raw window (40 snapshots — halftime alone is ~28 stale polls),
    // dedup consecutive same-period+clock, then take last 6 unique data points.
    const wideStart = Math.max(0, idx - 39);
    const wideRaw = allSnaps.slice(wideStart, idx + 1);

    // Dedup: collapse consecutive snapshots with identical period+clock (halftime, timeouts)
    const deduped = [wideRaw[0]];
    for (let i = 1; i < wideRaw.length; i++) {
      if (!(wideRaw[i].period === wideRaw[i - 1].period && wideRaw[i].clock === wideRaw[i - 1].clock)) {
        deduped.push(wideRaw[i]);
      }
    }
    // Last 6 unique snapshots (~6-10 min of actual game time)
    const trendSnaps = deduped.length > 6 ? deduped.slice(-6) : deduped;

    if (trendSnaps.length >= 3) {
      // Opp sustainability arc — how opponent sust changed over window
      const sustTiers = { 'LOCKED IN': 5, 'DURABLE': 4, 'MIXED': 3, 'STALLED': 2, 'COLD': 2, 'FRAGILE': 1, 'UNSUSTAINABLE': 0 };
      const oppSustHistory = trendSnaps.map(s => {
        try {
          const sj = s.sust_json ? (typeof s.sust_json === 'string' ? JSON.parse(s.sust_json) : s.sust_json) : null;
          if (sj) {
            const sCtrlHome = (s.floor_team || '') === hA;
            return sj[sCtrlHome ? 'away' : 'home']?.tier || null;
          }
        } catch (e) {}
        return null;
      }).filter(Boolean);

      let sustArc = 'STABLE', sustArcDetail = '';
      if (oppSustHistory.length >= 2) {
        const firstVal = sustTiers[oppSustHistory[0]] ?? 3;
        const lastVal = sustTiers[oppSustHistory[oppSustHistory.length - 1]] ?? 3;
        sustArc = lastVal < firstVal ? 'DEGRADING' : lastVal > firstVal ? 'IMPROVING' : 'STABLE';
        const seen = [];
        oppSustHistory.forEach(t => { if (seen[seen.length - 1] !== t) seen.push(t); });
        sustArcDetail = seen.join(' → ');
      }

      // Floor-margin relationship — are structural edge and scoreboard moving together?
      const floors = trendSnaps.map(s => Number(s.floor_score || 0));
      const margins = trendSnaps.map(s => {
        const h = Number(s.home_pts || 0), a = Number(s.away_pts || 0);
        return cr.ctrlIsHome ? h - a : a - h;
      });
      let floorMarginRel = 'ALIGNED';
      if (floors.length >= 3 && margins.length >= 3) {
        const floorChange = floors[floors.length - 1] - floors[0];
        const marginChange = margins[margins.length - 1] - margins[0];
        const floorUp = floorChange > 0.03, floorDown = floorChange < -0.03;
        const marginUp = marginChange > 2, marginDown = marginChange < -2;
        if ((floorUp && marginDown) || (floorDown && marginUp)) floorMarginRel = 'DIVERGING';
        else if ((floorUp && marginUp) || (floorDown && marginDown)) floorMarginRel = 'CONVERGING';
      }

      // Momentum — pre-digested label so agent doesn't have to count floor trajectory
      let momDir = null, momStreak = 0;
      for (let j = floors.length - 1; j > 0; j--) {
        const diff = floors[j] - floors[j - 1];
        if (diff > 0.01) {
          if (momDir === 'RISING' || momDir === null) { momDir = 'RISING'; momStreak++; }
          else break;
        } else if (diff < -0.01) {
          if (momDir === 'FALLING' || momDir === null) { momDir = 'FALLING'; momStreak++; }
          else break;
        } else {
          if (momDir === null) momStreak++;
          else break;
        }
      }
      momDir = momDir || 'STABLE';
      const momDelta = momStreak > 0
        ? Math.round((floors[floors.length - 1] - floors[Math.max(0, floors.length - 1 - momStreak)]) * 100) / 100
        : 0;

      trendSignals = {
        sustArc, sustArcDetail, floorMarginRel,
        momentum: `${momDir}(${momStreak}, ${momDelta >= 0 ? '+' : ''}${momDelta.toFixed(2)})`,
        windowSize: trendSnaps.length,
        dedupedFrom: wideRaw.length,
        removed: wideRaw.length - deduped.length,
      };
    }
  }

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
    bwcTeam: lt.bwc_fired?.team || null,
    bwcFirePeriod: lt.bwc_fired?.period || null,
    bwcFireFloor: lt.bwc_fired?.floor || null,

    // Score context
    homeAlias: hA, awayAlias: aA,
    homePts: cr.homePts, awayPts: cr.awayPts,
    ctrlIsHome: cr.ctrlIsHome,

    // Sustainability
    ctrlSust: cr.ctrlSust, oppSust: cr.oppSust,
    tpClass: cr.tpClass, lsClass: cr.lsClass,

    // Trail data
    floorHistory,
    priorAlertTrail: priorAlertTrail || 'None',

    // Inline trend signals (same window as floor history — only when &monitor=true)
    trendSignals,

    // Graduation/lane/flip context from stored production live_tracking
    poRank: storedLT?.po_fired?.rank || null,
    graduationPeriod: storedLT?.graduation?.[storedLT?.bwc_fired?.team]?.period || null,
    graduationFloor: storedLT?.graduation?.[storedLT?.bwc_fired?.team]?.floor || null,
    graduationRank: storedLT?.graduation?.[storedLT?.bwc_fired?.team]?.rank || null,
    ctrlFlips: storedLT?.ctrl_flips || 0,
    cpMeanFloor: storedLT?.cp_mean_floor || null,
    cpMinFloor: storedLT?.cp_min_floor || null,
    cpEligibleCount: storedLT?.cp_eligible_count || 0,
    cpPeakRank: storedLT?.cp_peak_rank || null,
    cpGraduation: storedLT?.cp_graduation || null,
    cpOppGraduation: storedLT?.cp_opp_graduation || null,
    cpCtrlFlips: storedLT?.cp_ctrl_flips || 0,
    lane: storedLT?.lane || null,
    pregameML: storedLT?.pregame_ml || null,
    mfTrajectory: storedLT?.bwc_fired ? computeMFTrajectory(storedLT?.checkpoints || [], storedLT.bwc_fired.team) : null,
    bwcFlipped: storedLT?.bwc_flipped || false,
    originalBwcTeam: storedLT?.original_bwc_team || null,
    isFlipBuy: false,
    flipBuyContext: null,
    positionClosed,
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

    // Test 3: Directional alerts
    test3_triggers: {
      degrading: bwcTransitions.filter(t => t.direction === 'DEGRADING').map(t => ({
        alert: t.alertType,
        time: `Q${t.period} ${t.clock}`,
        transition: `${t.fromState} → ${t.toState}`,
        margin: t.margin, floor: t.floor,
        oppIndicators: t.oppIndicatorsWon,
        ctrlSust: t.ctrlSust, erosion: t.erosion,
        exitSeverity: t.exitSeverity || null,
      })),
      recovering: bwcTransitions.filter(t => t.direction === 'RECOVERING').map(t => ({
        alert: t.alertType,
        time: `Q${t.period} ${t.clock}`,
        transition: `${t.fromState} → ${t.toState}`,
        margin: t.margin, floor: t.floor,
      })),
      buyTriggers: buyTriggers.map(t => ({
        time: `Q${t.period} ${t.clock}`,
        tier: t.buyTier || 'FIRED',
        margin: t.margin, floor: t.floor,
        oppIndicators: t.oppIndicatorsWon,
        bwcTeamMatch: t.bwcTeamMatch || 'N/A',
      })),
      valueCorrect, exitCorrect,
      summary: {
        degradingCount: bwcTransitions.filter(t => t.direction === 'DEGRADING').length,
        recoveringCount: bwcTransitions.filter(t => t.direction === 'RECOVERING').length,
        filteredOut: stateLog.filter(s => s.bwcState).length - bwcTransitions.length,
      },
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
      direction: t.direction || null,
      time: `Q${t.period} ${t.clock}`,
      state: t.bwcState || t.toState || null,
      floor: typeof t.floor === 'number' ? t.floor.toFixed(2) : null,
      margin: t.margin,
      erosion: t.erosion || t.erosionLevel || null,
      exitSeverity: t.exitSeverity?.severity || null,
    })),
  };
}

// ── AGENT API CALLS (mode=agent) ──

async function runAgentTests(sql, gameId, triggers, v2Alerts, matchup, triggerIdx = null, useMonitor = false) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return { error: 'No ANTHROPIC_API_KEY' };

  const results = [];
  // Only test triggers that have context packages AND are alert types
  let allTestable = triggers.filter(t =>
    t.contextPackage && (t.alertType === 'VALUE' || t.alertType === 'EXIT' || t.alertType === 'BUY'
      || t.alertType === 'BWC_EDGE' || t.alertType === 'POSITION_SAFE' || t.alertType === 'THESIS_ALIVE'
      || t.alertType === 'POSITION_RECOVERING' || t.alertType === 'TRACKING' || t.alertType === 'POSITION_OPEN')
  );

  // Load stored decisions from prior runs (for compounding across calls)
  let storedDecisions = [];
  try {
    storedDecisions = await sql`SELECT trigger_idx, decision, reasoning, body
      FROM test_decisions WHERE game_id = ${gameId} AND monitor = ${useMonitor}
      ORDER BY trigger_idx ASC`;
  } catch (e) { log(`No stored decisions: ${e.message}`); }

  // Load game_context for structural stress data (rolling window, combined read, per-quarter)
  let gameContextRows = [];
  try {
    gameContextRows = await sql`SELECT period, context_json FROM game_context WHERE game_id = ${gameId} ORDER BY period ASC`;
  } catch (e) { log(`No game_context: ${e.message}`); }

  // Inject stored decisions into v2Alerts for prior trail compounding
  const storedMap = {};
  storedDecisions.forEach(d => { storedMap[d.trigger_idx] = d; });
  allTestable.forEach((t, i) => {
    if (storedMap[i]) {
      const matching = v2Alerts.find(a =>
        a.alertType === t.alertType && a.period === t.period && a.clock === t.clock
      );
      if (matching) {
        matching.decision = storedMap[i].decision;
        matching.reasoning = (storedMap[i].reasoning || '').substring(0, 150);
      }
    }
  });

  // Select which triggers to run
  let testable = allTestable;
  if (triggerIdx != null && typeof triggerIdx === 'number' && triggerIdx >= 0 && triggerIdx < testable.length) {
    testable = [testable[triggerIdx]];
  } else if (triggerIdx != null && typeof triggerIdx === 'string' && triggerIdx.includes('-')) {
    const [start, end] = triggerIdx.split('-').map(Number);
    if (!isNaN(start) && !isNaN(end) && start >= 0 && end < testable.length) {
      testable = testable.slice(start, end + 1);
    }
  }
  const totalTestable = allTestable.length;

  log(`${matchup}: running ${testable.length} of ${totalTestable} agent tests, ${storedDecisions.length} stored decisions loaded`);

  for (const t of testable) {
    const ctx = t.contextPackage;

    // Rebuild priorAlertTrail from v2Alerts (may have stored decisions injected)
    // Clock comparison must be numeric — NBA clocks count down, higher = earlier in quarter
    const parseClockSecs = (c) => {
      if (!c) return 0;
      const parts = String(c).split(':');
      return (parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0);
    };
    const triggerClockSecs = parseClockSecs(t.clock);
    const currentTrailAlerts = v2Alerts.filter(a =>
      a.period < t.period || (a.period === t.period && parseClockSecs(a.clock) > triggerClockSecs)
    );
    ctx.priorAlertTrail = currentTrailAlerts.length > 0
      ? currentTrailAlerts.map(a =>
          `${a.alertType}[${a.bwcState || '-'}] Q${a.period} ${a.clock}: floor ${a.floor.toFixed(2)}, margin ${a.margin} → ${a.decision}: ${a.reasoning}`
        ).reverse().slice(0, 5).join('\n')
      : 'None';

    // ── Enrich ctx with game_context stress data + trigger metadata for buildV2AgentPrompt ──
    const gcMatch = gameContextRows
      .filter(r => Number(r.period) <= t.period)
      .sort((a, b) => Number(b.period) - Number(a.period))[0];
    let gcCtx = null;
    if (gcMatch) {
      try { gcCtx = typeof gcMatch.context_json === 'string' ? JSON.parse(gcMatch.context_json) : gcMatch.context_json; }
      catch (e) { /* bad JSON */ }
    }

    // Set alert metadata on ctx
    ctx.alertType = t.alertType;
    ctx.alertTier = t.buyTier || 'FIRED';

    // Pass game_context structural stress data through ctx for buildV2AgentPrompt
    ctx.windowData = gcCtx?.rollingWindow || null;
    ctx.quarterDiffs = gcCtx?.quarterDiffs || null;
    ctx.accelData = gcCtx?.acceleration || null;
    ctx.combinedRead = gcCtx?.combinedRead || null;

    const prompt = buildV2AgentPrompt(ctx);

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
          max_tokens: 600,
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
        priorTrailUsed: ctx.priorAlertTrail.substring(0, 200),
        referencesOpponentProfile: text.includes('opponent') || text.includes('I1') || text.includes('counter-indicator'),
        referencesErosion: text.includes('erosion') || text.includes('peak') || text.includes('CAUTION') || text.includes('COLLAPSE'),
        referencesBwcLifecycle: text.includes('BWC') || text.includes('LOCK') || text.includes('lifecycle') || text.includes('prior'),
        monitorPresent: !!ctx.trendSignals,
        referencesMonitor: text.includes('DIVERGING') || text.includes('CONVERGING') || text.includes('sustainability arc') || text.includes('sust arc') || text.includes('DEGRADING') || text.includes('IMPROVING') || text.includes('momentum') || text.includes('RISING') || text.includes('FALLING'),
        monitorData: ctx.trendSignals || null,
        stressPresent: !!(gcCtx?.rollingWindow?.available),
        stressCombinedRead: gcCtx?.combinedRead?.read || null,
        referencesStress: text.includes('window') || text.includes('COLLAPSING') || text.includes('FLIPPED') || text.includes('combined read') || text.includes('rolling') || text.includes('recent quarters') || text.includes('structural stress') || text.includes('anchored'),
        tokens: data.usage,
      };
      results.push(result);

      // Update v2Alerts trail with actual agent reasoning (compounding)
      const matching = v2Alerts.find(a => a.alertType === t.alertType && a.period === t.period && a.clock === t.clock);
      if (matching) {
        matching.decision = result.decision;
        matching.reasoning = result.reasoning.substring(0, 150);
      }

      // Save decision to DB for cross-request compounding
      const tIdx = allTestable.indexOf(t);
      if (tIdx >= 0) {
        try {
          await sql`INSERT INTO test_decisions (game_id, trigger_idx, monitor, decision, reasoning, body)
            VALUES (${gameId}, ${tIdx}, ${useMonitor}, ${result.decision}, ${result.reasoning.substring(0, 500)}, ${result.body.substring(0, 1000)})
            ON CONFLICT (game_id, trigger_idx, monitor) DO UPDATE SET
              decision = EXCLUDED.decision, reasoning = EXCLUDED.reasoning, body = EXCLUDED.body, ts = NOW()`;
        } catch (e) { log(`Failed to save decision: ${e.message}`); }
      }

      log(`${matchup}: ${result.trigger} → ${result.decision}`);
    } catch (e) {
      results.push({ trigger: `${t.alertType} Q${t.period}`, error: e.message });
    }
  }

  return {
    triggerIndex: triggerIdx,
    totalTestable,
    storedDecisions: storedDecisions.length,
    storedSummary: storedDecisions.map(d => `${d.trigger_idx}: ${d.decision}`),
    availableTriggers: triggers
      .filter(t => t.contextPackage && t.alertType)
      .map((t, i) => `${i}: ${t.alertType}[${t.bwcState || '-'}] Q${t.period} ${t.clock}${storedMap[i] ? ' ✅' : ''}`),
    results,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// REPLAY MODE — recompute indicators from raw_stats_json with configurable params
// Full cascade: indicators → floor → VT → TP/LS → BWC state → graduation → alerts
// ══════════════════════════════════════════════════════════════════════════════

// ── LEAGUE DEFAULTS ──
const LEAGUE_DEFAULTS = {
  nba: {
    weights: { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 },
    i1: { disrupt_gap: 1, pot_gap: 4, chaos_gap: 4 },
    i2: { paint_gap: 6, rim_pct_gap: 0.10, rim_min_att: 6 },
    i3: { efg_gap: 0.02, ar_gap: 5, cs3_gap: 2 },
    i4: { bigLead_gap: 2, bigLead_contested_ratio: 0.75, q4_gap: 2 },
    i5: { run_share_hi: 0.55, run_share_lo: 0.45, min_total_runs: 4 },
    vt: { projected_threshold: 34, min_3pa: 15, deviation_floor: -5, deviation_ceiling: 15, discount_base: 0.25, discount_scale: 0.15, discount_cap: 0.50, mitigation_floor: 0.70, vt_bonus_scaling: 0.50 },
    tp: { baseline_2pt: 0.52, quality_floor: 0.75, min_fg2a: 6, degradation_24: 0.70, degradation_18: 0.85 },
    floor: { control_threshold: 0.50 },
    alerts: { buy_floor_min: 0.65, buy_margin_max: 15, buy_period_min: 2, buy_ml_suppress: -400, buy_ml_candidate: -250, bwc_floor_min: 0.60, bwc_lead_min: 2, window_buy_floor_min: 0.45, window_buy_margin_min: -15, window_buy_margin_max: 5, window_buy_qtr_window_min: 0.75, recovery_floor_min: 0.30, clock_gate_min: 1.0 },
    graduation: { mf_gate: 0.65, min_floor: 0.58, b_rank_confirm_cp: 'Q3_6', flip_mf_min: 0.55, flip_min_holds: 2 },
  },
  wnba: {
    weights: { I1: 0.15, I2: 0.20, I3: 0.30, I4: 0.25, I5: 0.10 },
    i1: { disrupt_gap: 1, pot_gap: 4, chaos_gap: 4 },
    i2: { paint_gap: 4, rim_pct_gap: 0.10, rim_min_att: 6 },
    i3: { efg_gap: 0.02, ar_gap: 5, cs3_gap: 2 },
    i4: { bigLead_gap: 2, bigLead_contested_ratio: 0.75, q4_gap: 2 },
    i5: { run_share_hi: 0.55, run_share_lo: 0.45, min_total_runs: 4 },
    vt: { projected_threshold: 28, min_3pa: 10, deviation_floor: -5, deviation_ceiling: 15, discount_base: 0.25, discount_scale: 0.15, discount_cap: 0.50, mitigation_floor: 0.70, vt_bonus_scaling: 0.50 },
    tp: { baseline_2pt: 0.48, quality_floor: 0.75, min_fg2a: 6, degradation_24: 0.70, degradation_18: 0.85 },
    floor: { control_threshold: 0.50 },
    alerts: { buy_floor_min: 0.60, buy_margin_max: 15, buy_period_min: 2, buy_ml_suppress: -400, buy_ml_candidate: -250, bwc_floor_min: 0.55, bwc_lead_min: 2, window_buy_floor_min: 0.45, window_buy_margin_min: -15, window_buy_margin_max: 5, window_buy_qtr_window_min: 0.75, recovery_floor_min: 0.30, clock_gate_min: 1.0 },
    graduation: { mf_gate: 0.60, min_floor: 0.55, b_rank_confirm_cp: 'Q3_6', flip_mf_min: 0.55, flip_min_holds: 2 },
  },
  ncaamb: {
    weights: { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 },
    i1: { disrupt_gap: 1, pot_gap: 4, chaos_gap: 4 },
    i2: { paint_gap: 6, rim_pct_gap: 0.10, rim_min_att: 6 },
    i3: { efg_gap: 0.02, ar_gap: 5, cs3_gap: 2 },
    i4: { bigLead_gap: 2, bigLead_contested_ratio: 0.75, q4_gap: 2 },
    i5: { run_share_hi: 0.55, run_share_lo: 0.45, min_total_runs: 4 },
    vt: { projected_threshold: 34, min_3pa: 15, deviation_floor: -5, deviation_ceiling: 15, discount_base: 0.25, discount_scale: 0.15, discount_cap: 0.50, mitigation_floor: 0.70, vt_bonus_scaling: 0.50 },
    tp: { baseline_2pt: 0.49, quality_floor: 0.75, min_fg2a: 6, degradation_24: 0.70, degradation_18: 0.85 },
    floor: { control_threshold: 0.50 },
    alerts: { buy_floor_min: 0.65, buy_margin_max: 15, buy_period_min: 2, buy_ml_suppress: -400, buy_ml_candidate: -250, bwc_floor_min: 0.60, bwc_lead_min: 2, window_buy_floor_min: 0.45, window_buy_margin_min: -15, window_buy_margin_max: 5, window_buy_qtr_window_min: 0.75, recovery_floor_min: 0.30, clock_gate_min: 1.0 },
    graduation: { mf_gate: 0.65, min_floor: 0.58, b_rank_confirm_cp: 'Q3_6', flip_mf_min: 0.55, flip_min_holds: 2 },
  },
};

// Deep merge: user config overrides league defaults per-section
function mergeConfig(...sources) {
  const result = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [key, val] of Object.entries(src)) {
      if (val && typeof val === 'object' && !Array.isArray(val) && result[key] && typeof result[key] === 'object') {
        result[key] = { ...result[key], ...val };
      } else {
        result[key] = val;
      }
    }
  }
  return result;
}

function buildConfig(league, preset, inline) {
  const base = LEAGUE_DEFAULTS[league] || LEAGUE_DEFAULTS.nba;
  return mergeConfig(base, preset, inline);
}

// ── RECOMPUTE INDICATORS (pure function) ──
// Takes raw_stats_json fields + config → returns full indicator set
function recomputeIndicators(raw, config, context) {
  const h = raw.home, a = raw.away;
  const fallbacks = [];

  // I1 — Disruption & Conversion
  const hDisrupt = (h.stl || 0) + (h.blk || 0);
  const aDisrupt = (a.stl || 0) + (a.blk || 0);
  const disruptDiff = hDisrupt - aDisrupt;
  const i1subA = disruptDiff > config.i1.disrupt_gap ? 1 : disruptDiff < -config.i1.disrupt_gap ? -1 : 0;
  const potDiff = (h.pot || 0) - (a.pot || 0);
  const i1subB = potDiff > config.i1.pot_gap ? 1 : potDiff < -config.i1.pot_gap ? -1 : 0;
  let i1raw = i1subA + i1subB;

  // Chaos layer — needs forced/unforced TOs from PBP enrichment
  let i1chaos = null;
  if (h.forced_to != null && a.forced_to != null) {
    // h.forced_to = home team's TOs that were forced (by away). So away's forcing ability = h.forced_to
    const hForcingAbility = a.forced_to || 0; // home forces away's TOs
    const aForcingAbility = h.forced_to || 0; // away forces home's TOs
    const hUnforced = h.unforced_to || 0;
    const aUnforced = a.unforced_to || 0;
    if (hForcingAbility >= aForcingAbility + config.i1.chaos_gap) i1raw += 0.5;
    else if (aForcingAbility >= hForcingAbility + config.i1.chaos_gap) i1raw -= 0.5;
    else if (hUnforced >= aUnforced + config.i1.chaos_gap) i1raw -= 0.5;
    else if (aUnforced >= hUnforced + config.i1.chaos_gap) i1raw += 0.5;
    i1chaos = { hForcing: hForcingAbility, aForcing: aForcingAbility, hUnforced, aUnforced };
  } else {
    fallbacks.push('i1_chaos');
  }
  const I1 = { score: i1raw > 0 ? 1 : i1raw === 0 ? 0.5 : 0, leader: i1raw > 0 ? 'home' : i1raw < 0 ? 'away' : 'EVEN', subA: i1subA, subB: i1subB, chaos: i1chaos, raw: i1raw };

  // I2 — Interior Control
  const paintDiff = (h.paint || 0) - (a.paint || 0);
  const i2subA = paintDiff > config.i2.paint_gap ? 1 : paintDiff < -config.i2.paint_gap ? -1 : 0;
  const hRimPct = (h.atRimA || 0) >= config.i2.rim_min_att ? (h.atRimM || 0) / h.atRimA : null;
  const aRimPct = (a.atRimA || 0) >= config.i2.rim_min_att ? (a.atRimM || 0) / a.atRimA : null;
  let i2subB = 0;
  if (hRimPct != null && aRimPct != null) {
    i2subB = (hRimPct - aRimPct) > config.i2.rim_pct_gap ? 1 : (aRimPct - hRimPct) > config.i2.rim_pct_gap ? -1 : 0;
  }
  const i2raw = i2subA + i2subB;
  const I2 = { score: i2raw > 0 ? 1 : i2raw < 0 ? 0 : 0.5, leader: i2raw > 0 ? 'home' : i2raw < 0 ? 'away' : 'EVEN', subA: i2subA, subB: i2subB, raw: i2raw };

  // I3 — Shot Quality & Creation
  const hFGA = h.fga || 1, aFGA = a.fga || 1;
  const hEFG = ((h.fgm || 0) + 0.5 * (h.fg3m || 0)) / hFGA;
  const aEFG = ((a.fgm || 0) + 0.5 * (a.fg3m || 0)) / aFGA;
  const hFGM = h.fgm || 1, aFGM = a.fgm || 1;
  const hAR = ((h.ast || 0) / hFGM) * 100, aAR = ((a.ast || 0) / aFGM) * 100;
  const i3subEFG = hEFG > aEFG + config.i3.efg_gap ? 1 : hEFG < aEFG - config.i3.efg_gap ? -1 : 0;
  const i3subAR = hAR > aAR + config.i3.ar_gap ? 1 : hAR < aAR - config.i3.ar_gap ? -1 : 0;
  let i3subCS3 = 0;
  if (h.assisted_3pm != null && a.assisted_3pm != null) {
    const hCS3 = h.assisted_3pm || 0, aCS3 = a.assisted_3pm || 0;
    i3subCS3 = hCS3 > aCS3 + config.i3.cs3_gap ? 1 : hCS3 < aCS3 - config.i3.cs3_gap ? -1 : 0;
  } else {
    fallbacks.push('i3_cs3');
  }
  const i3raw = i3subEFG + i3subAR + i3subCS3;
  const I3 = { score: i3raw > 0 ? 1 : i3raw === 0 ? 0.5 : 0, leader: i3raw > 0 ? 'home' : i3raw < 0 ? 'away' : 'EVEN', subEFG: i3subEFG, subAR: i3subAR, subCS3: i3subCS3, raw: i3raw };

  // I4 — Game Control
  const hBigLead = h.bigLead || 0, aBigLead = a.bigLead || 0;
  let i4subA = 0;
  if (hBigLead >= aBigLead + config.i4.bigLead_gap) {
    i4subA = (aBigLead >= config.i4.bigLead_contested_ratio * hBigLead) ? 0 : 1;
  } else if (aBigLead >= hBigLead + config.i4.bigLead_gap) {
    i4subA = (hBigLead >= config.i4.bigLead_contested_ratio * aBigLead) ? 0 : -1;
  }
  // I4 subB — Q4+ uses live Q4 diff from context, pre-Q4 falls back to stored
  let i4subB = 0;
  if (context.q4ScoringDiff != null) {
    i4subB = context.q4ScoringDiff > config.i4.q4_gap ? 1 : context.q4ScoringDiff < -config.i4.q4_gap ? -1 : 0;
  } else if (context.seasonQ4Diff != null) {
    i4subB = context.seasonQ4Diff > config.i4.q4_gap ? 1 : context.seasonQ4Diff < -config.i4.q4_gap ? -1 : 0;
  } else {
    fallbacks.push('i4_subB');
  }
  const i4raw = i4subA + i4subB;
  const I4 = { score: i4raw > 0 ? 1 : i4raw === 0 ? 0.5 : 0, leader: i4raw > 0 ? 'home' : i4raw < 0 ? 'away' : 'EVEN', subA: i4subA, subB: i4subB, raw: i4raw };

  // I5 — Sustained Execution (run share)
  let I5 = { score: 0.5, leader: 'EVEN', runShare: null, raw: 0 };
  if (raw.runs6) {
    const hRuns = raw.runs6.home || 0, aRuns = raw.runs6.away || 0;
    const totalRuns = raw.runs6.total || (hRuns + aRuns);
    if (totalRuns >= config.i5.min_total_runs) {
      const runShare = hRuns / totalRuns;
      I5 = {
        score: runShare > config.i5.run_share_hi ? 1 : runShare < config.i5.run_share_lo ? 0 : 0.5,
        leader: runShare > config.i5.run_share_hi ? 'home' : runShare < config.i5.run_share_lo ? 'away' : 'EVEN',
        runShare: Math.round(runShare * 1000) / 1000,
        raw: runShare > config.i5.run_share_hi ? 1 : runShare < config.i5.run_share_lo ? -1 : 0,
      };
    }
  }

  // Composite
  const W = config.weights;
  const raw_composite = I1.score * W.I1 + I2.score * W.I2 + I3.score * W.I3 + I4.score * W.I4 + I5.score * W.I5;
  const controlHome = raw_composite >= config.floor.control_threshold;
  const controlTeam = controlHome ? context.hA : context.aA;
  const floor = controlHome ? raw_composite : 1 - raw_composite;

  // Resolve leaders from home/away to team aliases
  function resolveLeader(l) { return l === 'home' ? context.hA : l === 'away' ? context.aA : 'EVEN'; }
  I1.leader = resolveLeader(I1.leader);
  I2.leader = resolveLeader(I2.leader);
  I3.leader = resolveLeader(I3.leader);
  I4.leader = resolveLeader(I4.leader);
  I5.leader = resolveLeader(I5.leader);

  return {
    I1, I2, I3, I4, I5,
    composite: Math.round(raw_composite * 100) / 100,
    controlTeam,
    floor: Math.round(floor * 100) / 100,
    homeAlias: context.hA,
    awayAlias: context.aA,
    fallbacks,
  };
}

// ── RECOMPUTE CONVICTION (from recomputed indicators) ──
function recomputeConviction(ind) {
  if (!ind || ind.floor == null) return { tier: 'NO ENTRY', combo: 'NONE', count: 0, indicatorsWon: [], indicatorsLost: [], pairs: [] };
  const ctrlHome = ind.controlTeam === ind.homeAlias;
  const wins = [], loses = [], even = [];
  for (const [key, val] of [['I1', ind.I1], ['I2', ind.I2], ['I3', ind.I3], ['I4', ind.I4], ['I5', ind.I5]]) {
    if (!val) { even.push(key); continue; }
    const ctrlScore = ctrlHome ? val.score : 1 - val.score;
    if (ctrlScore > 0.5) wins.push(key);
    else if (ctrlScore < 0.5) loses.push(key);
    else even.push(key);
  }
  const count = wins.length;
  const has = (a, b) => wins.includes(a) && wins.includes(b);
  const combo = count > 0 ? wins.join('+') : 'NONE';
  const hasI4I5 = has('I4', 'I5'), hasI3I4 = has('I3', 'I4'), hasI3I5 = has('I3', 'I5');
  const hasKillerPair = hasI4I5 || hasI3I4 || hasI3I5;
  const isDanger = (
    (count === 2 && wins.includes('I1') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4')) ||
    (count === 3 && wins.includes('I1') && wins.includes('I2') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4')) ||
    (count === 3 && wins.includes('I2') && wins.includes('I3') && wins.includes('I5') && !wins.includes('I4'))
  );
  let tier;
  if (count >= 4 || hasI4I5) tier = 'DOMINANT';
  else if (hasKillerPair && !isDanger) tier = 'STRONG';
  else if (count >= 2 && !isDanger) tier = 'MODEST';
  else if (count >= 1) tier = 'CONDITIONAL';
  else tier = 'NO ENTRY';
  const pairs = [];
  if (hasI4I5) pairs.push('I4+I5');
  if (hasI3I4) pairs.push('I3+I4');
  if (hasI3I5) pairs.push('I3+I5');
  return { tier, combo, count, indicatorsWon: wins, indicatorsLost: loses, indicatorsEven: even, pairs, isDanger };
}

// ── REPLAY WITH CONFIG ──
// Full cascade: raw_stats_json → indicators → floor → BWC → graduation → alerts
const REPLAY_GRAD_CHECKPOINTS = [
  { label: 'Q2_9', period: 2, clockSec: 540, gameSec: 900 },
  { label: 'Q2_6', period: 2, clockSec: 360, gameSec: 1080 },
  { label: 'Q2_3', period: 2, clockSec: 180, gameSec: 1260 },
  { label: 'Q2_END', period: 2, clockSec: 0, gameSec: 1440 },
  { label: 'Q3_9', period: 3, clockSec: 540, gameSec: 1620 },
  { label: 'Q3_6', period: 3, clockSec: 360, gameSec: 1800 },
  { label: 'Q3_3', period: 3, clockSec: 180, gameSec: 1980 },
  { label: 'Q3_END', period: 3, clockSec: 0, gameSec: 2160 },
  { label: 'Q4_9', period: 4, clockSec: 540, gameSec: 2340 },
  { label: 'Q4_6', period: 4, clockSec: 360, gameSec: 2520 },
  { label: 'Q4_3', period: 4, clockSec: 180, gameSec: 2700 },
];

function snapToGameSec(period, clock) {
  const parts = (clock || '0:00').split(':');
  const min = parseInt(parts[0]) || 0;
  const sec = parseInt(parts[1]) || 0;
  const clockSec = min * 60 + sec;
  return (period - 1) * 720 + (720 - clockSec);
}

function replayClassifyRank(convictionTier, ctrlMargin, consecutiveHolds, oppIndicatorCount) {
  if (convictionTier === 'DOMINANT' && ctrlMargin >= 8 && consecutiveHolds >= 4 && oppIndicatorCount <= 1) return 'A';
  if (oppIndicatorCount >= 3) return 'C';
  if ((convictionTier === 'DOMINANT' || convictionTier === 'STRONG') && ctrlMargin >= 3 && consecutiveHolds >= 2) return 'B';
  return 'C';
}

async function replayWithConfig(sql, gameId, config, diffOnly, runAgent = false, floorSource = 'stored', triggerIdx = null) {
  // 1. Load game + snapshots
  const gameRows = await sql`SELECT * FROM games WHERE id = ${gameId}`;
  if (gameRows.length === 0) return { error: 'Game not found: ' + gameId };
  const game = gameRows[0];
  const hA = game.home_alias, aA = game.away_alias;
  const matchup = game.matchup || (aA + '@' + hA);

  const allSnaps = await sql`SELECT * FROM snapshots WHERE game_id = ${gameId} AND source = 'server' ORDER BY ts ASC`;
  const snapshots = allSnaps.filter(s => s.raw_stats_json != null);
  if (snapshots.length === 0) return { error: 'No snapshots with raw_stats_json for ' + matchup };
  log(`[replay] ${matchup}: ${snapshots.length} snapshots (${allSnaps.length - snapshots.length} filtered)`);

  // Load production alerts for comparison
  const prodAlerts = await sql`
    SELECT alert_type, alert_tier, period, clock, floor_score, margin, is_trailing,
           control_team, agent_decision, conviction_tier, tp_class, ctrl_sust, ntfy_sent, ts
    FROM alerts WHERE game_id = ${gameId} ORDER BY ts ASC`;

  // 2. Derive Q4 scoring diff from snapshot sequence (for I4 subB)
  // Find the last pre-Q4 score to compute Q4 diff at each Q4+ snapshot
  let lastPreQ4Home = null, lastPreQ4Away = null;
  for (const s of snapshots) {
    const p = parsePeriod(s);
    if (p < 4) { lastPreQ4Home = Number(s.home_pts); lastPreQ4Away = Number(s.away_pts); }
  }

  // 3. Replay loop — recompute + cascade
  const rows = [];       // per-snapshot comparison
  const divergences = { I1: 0, I2: 0, I3: 0, I4: 0, I5: 0, floor: 0, control: 0 };
  let controlFlips = [];

  // BWC state machine (recomputed)
  let rlt = {}; // replay live_tracking
  let rBwcState = null, rPrevBwcState = null;
  let rBwcFirstFired = false;
  let rBwcCandidateTeam = null, rBwcCandidateHolds = 0;

  // Graduation state (recomputed)
  let rCheckpoints = [];
  let rNextCpIdx = 0;
  let rCpHolds = 0, rCpOppHolds = 0;
  let rCpPeakRank = 'C', rCpGraduation = null, rCpOppGraduation = null;
  let rCpCtrlFlips = 0;
  let rPoFired = false;

  // Alert tracking (recomputed)
  let rAlertTriggers = [];
  let rLastBuyTs = null;
  const BUY_COOLDOWN = 3 * 60 * 1000;
  const BWC_COOLDOWN = 3 * 60 * 1000;

  // BWC transition gate tracking
  let rLastFiredAlert = {};
  let rLastDegradeTs = null, rLastRecoverTs = null, rLastAnyBwcTs = null;
  let rPositionClosed = false;

  // State capture helper for agent integration
  function captureState(rc, rConv, snap) {
    const sj = snap.sust_json ? (typeof snap.sust_json === 'string' ? JSON.parse(snap.sust_json) : snap.sust_json) : null;
    const ctrlIsHome = rc.controlTeam === hA;
    return {
      i1: (ctrlIsHome ? rc.I1.score : 1 - rc.I1.score).toFixed(2),
      i2: (ctrlIsHome ? rc.I2.score : 1 - rc.I2.score).toFixed(2),
      i3: (ctrlIsHome ? rc.I3.score : 1 - rc.I3.score).toFixed(2),
      i4: (ctrlIsHome ? rc.I4.score : 1 - rc.I4.score).toFixed(2),
      i5: (ctrlIsHome ? rc.I5.score : 1 - rc.I5.score).toFixed(2),
      ctrlIndicators: rConv.indicatorsWon.join('+') || 'none',
      ctrlIndicatorCount: rConv.indicatorsWon.length,
      oppIndicatorsWon: rConv.indicatorsLost.join('+') || 'none',
      oppIndicatorCount: rConv.indicatorsLost.length,
      oppI3Won: rConv.indicatorsLost.includes('I3'),
      ctrlSust: ctrlIsHome ? (sj?.home?.tier || null) : (sj?.away?.tier || null),
      oppSust: ctrlIsHome ? (sj?.away?.tier || null) : (sj?.home?.tier || null),
      tpClass: snap.tp_class || null, lsClass: snap.ls_class || null,
      convictionTier: rConv.tier, convictionCombo: rConv.combo, convictionPairs: rConv.pairs?.join(', ') || '',
    };
  }

  function captureBwcGrad(rc) {
    const bwcTeam = rlt.bwc_fired?.team;
    const side = bwcTeam === hA ? 'home' : bwcTeam === aA ? 'away' : (rc.controlTeam === hA ? 'home' : 'away');
    const peak = rlt[side + '_peak_floor'] || null;
    const currentFloor = (bwcTeam === rc.controlTeam) ? rc.floor : (1 - rc.floor);  // BWC team's floor
    const peakDelta = peak ? currentFloor - peak : 0;
    const edge = (peak || 0) - 0.50;
    const erosionLevel = edge > 0 && peakDelta <= -(edge * 0.70) ? 'COLLAPSE' : edge > 0 && peakDelta <= -(edge * 0.40) ? 'CAUTION' : 'STABLE';
    const elig = rCheckpoints.filter(cp => cp.team === (rlt.bwc_fired?.team) && cp.floor >= 0.60 && cp.margin >= 2);
    const mf = elig.length > 0 ? elig.reduce((s, cp) => s + cp.floor, 0) / elig.length : null;
    const minF = elig.length > 0 ? Math.min(...elig.map(cp => cp.floor)) : null;
    const mfTraj = rlt.bwc_fired ? computeMFTrajectory(rCheckpoints, rlt.bwc_fired.team) : null;
    return {
      _bwc: { team: rlt.bwc_fired?.team, firePeriod: rlt.bwc_fired?.period, fireFloor: rlt.bwc_fired?.floor, state: rBwcState, holds: rlt.ctrl_team_holds || 0, ctrlFlips: rlt.ctrl_flips || 0, peakFloor: peak, peakDelta, erosionLevel, positionClosed: rPositionClosed },
      _grad: { graduation: rCpGraduation, oppGraduation: rCpOppGraduation, peakRank: rCpPeakRank, mf, minF, cpFlips: rCpCtrlFlips, eligibleCount: elig.length, mfTrajectory: mfTraj, poFired: rPoFired },
    };
  }

  // Floor history tracking (for agent context)
  const floorLog = []; // {idx, period, clock, storedFloor, storedTeam, recomputedFloor, recomputedTeam, homePts, awayPts, tp, ls}

  // Load game_context for structural stress (stored — not recomputed)
  let gameContextRows = [];
  if (runAgent) {
    try {
      gameContextRows = await sql`SELECT period, context_json FROM game_context WHERE game_id = ${gameId} ORDER BY period ASC`;
    } catch (e) { log(`[replay] No game_context: ${e.message}`); }
  }

  for (let idx = 0; idx < snapshots.length; idx++) {
    const snap = snapshots[idx];
    const period = parsePeriod(snap);
    if (period < 1) continue;

    const raw = typeof snap.raw_stats_json === 'string' ? JSON.parse(snap.raw_stats_json) : snap.raw_stats_json;
    if (!raw || !raw.home || !raw.away) continue;

    const clock = snap.clock || '0:00';
    const homePts = Number(snap.home_pts), awayPts = Number(snap.away_pts);
    const gameSec = snapToGameSec(period, clock);

    // Build context for I4 subB
    let q4ScoringDiff = null;
    if (period >= 4 && lastPreQ4Home != null) {
      const hQ4 = homePts - lastPreQ4Home;
      const aQ4 = awayPts - lastPreQ4Away;
      q4ScoringDiff = hQ4 - aQ4;
    }

    const recompCtx = { period, clock, hA, aA, q4ScoringDiff, seasonQ4Diff: null, gameSec };

    // ── RECOMPUTE ──
    const rc = recomputeIndicators(raw, config, recompCtx);
    const rConv = recomputeConviction(rc);
    const ctrlIsHome = rc.controlTeam === hA;
    const ctrlPts = ctrlIsHome ? homePts : awayPts;
    const oppPts = ctrlIsHome ? awayPts : homePts;
    const rMargin = ctrlPts - oppPts;
    const rTrailing = rMargin < 0;

    // Stored values for comparison
    const storedFloor = Number(snap.floor_score) || 0;
    const storedCtrl = snap.floor_team || null;
    const storedI1 = snap.i1 != null ? Number(snap.i1) : null;
    const storedI2 = snap.i2 != null ? Number(snap.i2) : null;
    const storedI3 = snap.i3 != null ? Number(snap.i3) : null;
    const storedI4 = snap.i4 != null ? Number(snap.i4) : null;
    const storedI5 = snap.i5 != null ? Number(snap.i5) : null;

    // Compare (stored indicators are HOME-relative)
    const rcI1Home = ctrlIsHome ? rc.I1.score : 1 - rc.I1.score;
    const rcI2Home = ctrlIsHome ? rc.I2.score : 1 - rc.I2.score;
    const rcI3Home = ctrlIsHome ? rc.I3.score : 1 - rc.I3.score;
    const rcI4Home = ctrlIsHome ? rc.I4.score : 1 - rc.I4.score;
    const rcI5Home = ctrlIsHome ? rc.I5.score : 1 - rc.I5.score;

    const i1Changed = storedI1 != null && Math.abs(rcI1Home - storedI1) > 0.01;
    const i2Changed = storedI2 != null && Math.abs(rcI2Home - storedI2) > 0.01;
    const i3Changed = storedI3 != null && Math.abs(rcI3Home - storedI3) > 0.01;
    const i4Changed = storedI4 != null && Math.abs(rcI4Home - storedI4) > 0.01;
    const i5Changed = storedI5 != null && Math.abs(rcI5Home - storedI5) > 0.01;
    const floorDelta = rc.floor - storedFloor;
    const controlChanged = storedCtrl && rc.controlTeam !== storedCtrl;

    if (i1Changed) divergences.I1++;
    if (i2Changed) divergences.I2++;
    if (i3Changed) divergences.I3++;
    if (i4Changed) divergences.I4++;
    if (i5Changed) divergences.I5++;
    if (Math.abs(floorDelta) > 0.01) divergences.floor++;
    if (controlChanged) { divergences.control++; controlFlips.push({ idx, period, clock, from: storedCtrl, to: rc.controlTeam }); }

    const anyDivergence = i1Changed || i2Changed || i3Changed || i4Changed || i5Changed || Math.abs(floorDelta) > 0.01 || controlChanged;

    // ── BWC STATE MACHINE (recomputed) ──
    // Update tracking
    if (!rlt.ctrl_team_current || rlt.ctrl_team_current !== rc.controlTeam) {
      rlt.ctrl_flips = (rlt.ctrl_flips || 0) + 1;
      rlt.ctrl_team_current = rc.controlTeam;
      rlt.ctrl_team_holds = 1;
    } else {
      rlt.ctrl_team_holds = (rlt.ctrl_team_holds || 0) + 1;
    }
    const side = ctrlIsHome ? 'home' : 'away';
    const peakKey = side + '_peak_floor';
    if (!rlt[peakKey] || rc.floor > rlt[peakKey]) rlt[peakKey] = rc.floor;

    // BWC candidate detection
    if (!rBwcFirstFired && period >= 2 && rc.floor >= config.alerts.bwc_floor_min && rMargin >= config.alerts.bwc_lead_min) {
      if (rBwcCandidateTeam === rc.controlTeam) {
        rBwcCandidateHolds++;
      } else {
        rBwcCandidateTeam = rc.controlTeam;
        rBwcCandidateHolds = 1;
      }
      if (rBwcCandidateHolds >= 3) {
        rBwcFirstFired = true;
        rlt.bwc_fired = { team: rc.controlTeam, period, clock, floor: rc.floor };
        rBwcState = rMargin >= 3 ? 'LOCK' : 'EDGE';
        rlt._prev_bwc_state = rBwcState;
        rlt.checkpoints = [];
        rlt.next_cp_idx = 0;
        // Skip past checkpoints already elapsed
        while (rlt.next_cp_idx < REPLAY_GRAD_CHECKPOINTS.length && REPLAY_GRAD_CHECKPOINTS[rlt.next_cp_idx].gameSec <= gameSec) {
          rlt.next_cp_idx++;
        }
      }
    } else if (!rBwcFirstFired && rBwcCandidateTeam && rc.controlTeam !== rBwcCandidateTeam) {
      rBwcCandidateTeam = null;
      rBwcCandidateHolds = 0;
    }

    // BWC state updates
    if (rBwcFirstFired) {
      const bwcTeam = rlt.bwc_fired.team;
      if (rc.controlTeam === bwcTeam) {
        rBwcState = rMargin >= 3 ? 'LOCK' : rMargin >= 1 ? 'EDGE' : rMargin >= -7 ? 'VALUE' : 'DEEP_TRAIL';
      } else {
        rBwcState = 'EXIT';
      }

      // ── GRADUATION CHECKPOINTS ──
      while (rlt.next_cp_idx < REPLAY_GRAD_CHECKPOINTS.length) {
        const nextCp = REPLAY_GRAD_CHECKPOINTS[rlt.next_cp_idx];
        if (gameSec < nextCp.gameSec) break;

        // Capture checkpoint
        const cpOppCount = rConv.indicatorsLost.length;
        const cpEntry = {
          label: nextCp.label, floor: rc.floor, team: rc.controlTeam,
          margin: rMargin, conv: rConv.tier, oppCount: cpOppCount,
          period, clock,
        };

        // Checkpoint-level control flip
        if (rCheckpoints.length > 0 && rCheckpoints[rCheckpoints.length - 1].team !== cpEntry.team) {
          rCpCtrlFlips++;
        }
        rCheckpoints.push(cpEntry);

        // Update cp holds
        if (rc.controlTeam === bwcTeam) {
          rCpHolds++;
          rCpOppHolds = 0;
        } else {
          rCpHolds = 0;
          if (rMargin >= 2 && rc.floor >= config.alerts.bwc_floor_min) {
            rCpOppHolds++;
          } else {
            rCpOppHolds = 0;
          }
        }

        // BWC team rank classification
        if (rc.controlTeam === bwcTeam && rMargin >= 2 && rc.floor >= config.alerts.bwc_floor_min) {
          const cpRank = replayClassifyRank(rConv.tier, rMargin, rCpHolds, cpOppCount);
          const RANK_ORDER = { C: 0, B: 1, A: 2 };
          if (RANK_ORDER[cpRank] > (RANK_ORDER[rCpPeakRank] || 0)) {
            rCpPeakRank = cpRank;
            rCpGraduation = { rank: cpRank, cp_label: nextCp.label, cp_idx: rlt.next_cp_idx, floor: rc.floor, margin: rMargin };
          }
        }

        // Opponent rank
        if (rc.controlTeam !== bwcTeam && rCpOppHolds >= 2 && rMargin >= 2 && rc.floor >= config.alerts.bwc_floor_min) {
          const oppRank = replayClassifyRank(rConv.tier, rMargin, rCpOppHolds, cpOppCount);
          if (oppRank === 'B' || oppRank === 'A') {
            const prevOppRank = rCpOppGraduation?.rank || 'C';
            const RANK_ORDER = { C: 0, B: 1, A: 2 };
            if (RANK_ORDER[oppRank] > (RANK_ORDER[prevOppRank] || 0)) {
              rCpOppGraduation = { rank: oppRank, cp_label: nextCp.label, cp_idx: rlt.next_cp_idx, floor: rc.floor, margin: rMargin };
            }
          }
        }

        // MF stats
        const eligible = rCheckpoints.filter(cp => cp.team === bwcTeam && cp.floor >= config.alerts.bwc_floor_min && cp.margin >= 2);
        const rMF = eligible.length > 0 ? eligible.reduce((s, cp) => s + cp.floor, 0) / eligible.length : null;
        const rMinF = eligible.length > 0 ? Math.min(...eligible.map(cp => cp.floor)) : null;

        // ── POSITION OPEN CHECK ──
        if (rCpGraduation && !rPoFired && rc.controlTeam === bwcTeam) {
          const gRank = rCpGraduation.rank;
          const mfGate = config.graduation.mf_gate;
          const minFGate = config.graduation.min_floor;

          if (gRank === 'A' && rMF >= mfGate && rMinF >= minFGate) {
            rPoFired = true;
            const bg = captureBwcGrad(rc);
            rAlertTriggers.push({ type: 'POSITION_OPEN', rank: gRank, idx, period, clock, floor: rc.floor, margin: rMargin, ctrl: rc.controlTeam, mf: rMF, cpFlips: rCpCtrlFlips, reopened_position: rPositionClosed || undefined,
              _state: captureState(rc, rConv, snap), ...bg,
            });
            // rPositionClosed stays true — only agent SEND should clear (post-collection)
          }
          if (gRank === 'B') {
            // B-rank confirmation gate
            const bConfirmCp = config.graduation.b_rank_confirm_cp || 'Q3_6';
            const bConfirmSec = REPLAY_GRAD_CHECKPOINTS.find(cp => cp.label === bConfirmCp)?.gameSec || 1800;
            if (gameSec >= bConfirmSec && rMF >= mfGate && rMinF >= minFGate) {
              rPoFired = true;
              const bg = captureBwcGrad(rc);
              rAlertTriggers.push({ type: 'POSITION_OPEN', rank: gRank, idx, period, clock, floor: rc.floor, margin: rMargin, ctrl: rc.controlTeam, mf: rMF, cpFlips: rCpCtrlFlips, reopened_position: rPositionClosed || undefined,
                _state: captureState(rc, rConv, snap), ...bg,
              });
              // rPositionClosed stays true — only agent SEND should clear (post-collection)
            }
          }
        }

        rlt.next_cp_idx++;
      }
    }

    // ── BWC STATE TRANSITION TRIGGERS ──
    if (rBwcFirstFired && rBwcState && rPrevBwcState && rBwcState !== rPrevBwcState) {
      const rDir = classifyTransition(rPrevBwcState, rBwcState);

      if (rDir !== 'LATERAL' && rBwcState !== 'DEEP_TRAIL') {
        let rTransAlertType = null;
        if (rDir === 'DEGRADING') {
          if (rBwcState === 'EDGE') rTransAlertType = 'BWC_EDGE';
          else if (rBwcState === 'VALUE') rTransAlertType = 'VALUE';
          else if (rBwcState === 'EXIT') rTransAlertType = 'EXIT';
        } else if (rDir === 'RECOVERING') {
          if (rBwcState === 'LOCK') rTransAlertType = 'POSITION_SAFE';
          else if (rBwcState === 'EDGE') rTransAlertType = 'POSITION_RECOVERING';
          else if (rBwcState === 'VALUE') rTransAlertType = 'THESIS_ALIVE';
        }

        if (rTransAlertType) {
          // Post-EXIT position gate
          if (rPositionClosed && !['EXIT', 'THESIS_ALIVE'].includes(rTransAlertType)) {
            rAlertTriggers.push({ type: rTransAlertType, gated: 'position_closed', idx, period, clock, floor: rc.floor, margin: rMargin, from: rPrevBwcState, to: rBwcState });
          } else {
            // Cooldown + material change gates
            const snapTs = snap.ts ? new Date(snap.ts).getTime() : Date.now();
            const msSinceAnyBwc = rLastAnyBwcTs ? (snapTs - rLastAnyBwcTs) : Infinity;
            const cooldownExempt = rTransAlertType === 'THESIS_ALIVE';
            const cooldownPassed = cooldownExempt || msSinceAnyBwc >= BWC_COOLDOWN;

            const stateChanged = rBwcState !== rLastFiredAlert.bwcState;
            const floorDelta = Math.abs(rc.floor - (rLastFiredAlert.floor || 0));
            const marginDelta = Math.abs(rMargin - (rLastFiredAlert.margin || 0));
            const lastSameDir = rDir === 'DEGRADING' ? rLastDegradeTs : rLastRecoverTs;
            const timeDelta = lastSameDir ? (snapTs - lastSameDir) : Infinity;
            const materialChange = floorDelta >= 0.10 || marginDelta >= 5 || timeDelta >= 300000;
            const shouldFire = cooldownPassed && (stateChanged || materialChange);

            if (shouldFire) {
              const bg = captureBwcGrad(rc);

              rAlertTriggers.push({
                type: rTransAlertType, tier: 'FIRED', direction: rDir,
                from: rPrevBwcState, to: rBwcState,
                idx, period, clock, floor: rc.floor, margin: rMargin,
                conv: rConv.tier, ctrl: rc.controlTeam,
                _state: captureState(rc, rConv, snap), ...bg,
              });

              // Position gate: EXIT closes position. THESIS_ALIVE/POSITION_OPEN only re-open
              // when agent decides SEND — since we collect triggers before running agent,
              // we can only SET position_closed here, not clear it. Agent context carries
              // positionClosed flag for THESIS_ALIVE/PO re-entry evaluation.
              if (rTransAlertType === 'EXIT') rPositionClosed = true;

              // Update gate tracking
              rLastFiredAlert = { alertType: rTransAlertType, floor: rc.floor, margin: rMargin, bwcState: rBwcState };
              rLastAnyBwcTs = snapTs;
              if (rDir === 'DEGRADING') rLastDegradeTs = snapTs;
              else rLastRecoverTs = snapTs;
            }
          }
        }
      }
    }

    // ── BUY CHECK (recomputed) ──
    const clockMin = parseFloat(clock) || 0;
    const snapTs = snap.ts ? new Date(snap.ts).getTime() : Date.now();
    if (period >= config.alerts.buy_period_min && rc.floor >= config.alerts.buy_floor_min
        && rTrailing && Math.abs(rMargin) <= config.alerts.buy_margin_max
        && clockMin >= config.alerts.clock_gate_min
        && (!rLastBuyTs || (snapTs - rLastBuyTs) >= BUY_COOLDOWN)) {
      rLastBuyTs = snapTs;
      rAlertTriggers.push({ type: 'BUY', tier: 'FIRED', idx, period, clock, floor: rc.floor, margin: rMargin, conv: rConv.tier, ctrl: rc.controlTeam, _state: captureState(rc, rConv, snap), ...captureBwcGrad(rc) });
    } else if (period >= config.alerts.buy_period_min && rc.floor >= (config.alerts.buy_floor_min - 0.10)
        && rc.floor < config.alerts.buy_floor_min
        && rTrailing && Math.abs(rMargin) <= config.alerts.buy_margin_max
        && clockMin >= config.alerts.clock_gate_min
        && (!rLastBuyTs || (snapTs - rLastBuyTs) >= BUY_COOLDOWN)) {
      rLastBuyTs = snapTs;
      rAlertTriggers.push({ type: 'BUY', tier: 'CANDIDATE', idx, period, clock, floor: rc.floor, margin: rMargin, conv: rConv.tier, ctrl: rc.controlTeam, _state: captureState(rc, rConv, snap), ...captureBwcGrad(rc) });
    }

    // ── FLOOR LOG (for agent floor history) ──
    floorLog.push({
      idx, period, clock,
      storedFloor, storedCtrl,
      recomputedFloor: rc.floor, recomputedTeam: rc.controlTeam,
      homePts, awayPts,
      tp: snap.tp_class || null, ls: snap.ls_class || null,
    });

    // ── BUILD ROW ──
    const indicatorsChanged = [i1Changed && 'I1', i2Changed && 'I2', i3Changed && 'I3', i4Changed && 'I4', i5Changed && 'I5'].filter(Boolean);

    if (!diffOnly || anyDivergence) {
      rows.push({
        idx, period, clock,
        home_pts: homePts, away_pts: awayPts,
        stored: {
          floor: storedFloor, controlTeam: storedCtrl,
          I1: storedI1, I2: storedI2, I3: storedI3, I4: storedI4, I5: storedI5,
          tp: snap.tp_class || null, ls: snap.ls_class || null,
        },
        recomputed: {
          floor: rc.floor, controlTeam: rc.controlTeam,
          I1: rcI1Home, I2: rcI2Home, I3: rcI3Home, I4: rcI4Home, I5: rcI5Home,
          conviction: rConv.tier,
          bwcState: rBwcFirstFired ? rBwcState : null,
          graduation: rCpGraduation ? rCpGraduation.rank : null,
          fallbacks: rc.fallbacks.length > 0 ? rc.fallbacks : undefined,
        },
        divergence: anyDivergence ? {
          floor_delta: Math.round(floorDelta * 1000) / 1000,
          indicators_changed: indicatorsChanged.length > 0 ? indicatorsChanged : undefined,
          control_flipped: controlChanged || undefined,
          bwc_state: rBwcFirstFired ? rBwcState : undefined,
        } : undefined,
      });
    }

    rPrevBwcState = rBwcState;
  }

  // ── COMPARE ALERTS ──
  const storedBuyAlerts = prodAlerts.filter(a => a.alert_type === 'BUY');
  const recomputedBuyAlerts = rAlertTriggers.filter(a => a.type === 'BUY');
  const storedPOAlerts = prodAlerts.filter(a => a.alert_type === 'POSITION_OPEN');
  const recomputedPOAlerts = rAlertTriggers.filter(a => a.type === 'POSITION_OPEN');
  const storedExitAlerts = prodAlerts.filter(a => a.alert_type === 'EXIT');
  const recomputedExitAlerts = rAlertTriggers.filter(a => a.type === 'EXIT' && !a.gated);
  const recomputedGated = rAlertTriggers.filter(a => a.gated);
  const recomputedTransitions = rAlertTriggers.filter(a => ['BWC_EDGE', 'VALUE', 'EXIT', 'THESIS_ALIVE', 'POSITION_SAFE', 'POSITION_RECOVERING'].includes(a.type));

  // ── BUILD SUMMARY ──
  const totalSnaps = snapshots.length;
  const divergedSnaps = rows.filter(r => r.divergence).length;

  const summary = {
    game: matchup,
    game_id: gameId,
    config_diff: Object.keys(config).length > 0 ? 'custom' : 'league defaults',
    total_snapshots: totalSnaps,
    snapshots_diverged: divergedSnaps,
    divergence_rate: totalSnaps > 0 ? (divergedSnaps / totalSnaps * 100).toFixed(1) + '%' : '0%',

    indicator_changes: {
      I1: { changed: divergences.I1, pct: (divergences.I1 / totalSnaps * 100).toFixed(1) + '%' },
      I2: { changed: divergences.I2, pct: (divergences.I2 / totalSnaps * 100).toFixed(1) + '%' },
      I3: { changed: divergences.I3, pct: (divergences.I3 / totalSnaps * 100).toFixed(1) + '%' },
      I4: { changed: divergences.I4, pct: (divergences.I4 / totalSnaps * 100).toFixed(1) + '%' },
      I5: { changed: divergences.I5, pct: (divergences.I5 / totalSnaps * 100).toFixed(1) + '%' },
    },

    floor_impact: {
      diverged_snaps: divergences.floor,
      control_flips: controlFlips.length,
      flip_details: controlFlips,
    },

    bwc_impact: {
      bwc_fired: rBwcFirstFired,
      bwc_team: rlt.bwc_fired?.team || null,
      bwc_fire_period: rlt.bwc_fired?.period || null,
      stored_bwc_fire: prodAlerts.find(a => a.alert_type === 'BUY WINDOW CLOSING' || a.alert_type === 'TRACKING')?.period || null,
    },

    graduation_impact: {
      recomputed_graduation: rCpGraduation,
      recomputed_opp_graduation: rCpOppGraduation,
      po_fired: rPoFired,
      cp_flips: rCpCtrlFlips,
      checkpoints_captured: rCheckpoints.length,
    },

    alert_impact: {
      stored_buy_count: storedBuyAlerts.length,
      recomputed_buy_count: recomputedBuyAlerts.length,
      stored_po_count: storedPOAlerts.length,
      recomputed_po_count: recomputedPOAlerts.length,
      stored_exit_count: storedExitAlerts.length,
      recomputed_exit_count: recomputedExitAlerts.length,
      recomputed_transitions: recomputedTransitions.length,
      position_gated: recomputedGated.length,
      position_gated_details: recomputedGated.length > 0 ? recomputedGated : undefined,
      recomputed_triggers: rAlertTriggers,
      stored_alerts: prodAlerts.map(a => ({ type: a.alert_type, tier: a.alert_tier, period: a.period, clock: a.clock, floor: a.floor_score, margin: a.margin, decision: a.agent_decision })),
    },
  };

  // ── AGENT INTEGRATION (mode=replay with agent=true) ──
  let agentResults = null;
  if (runAgent) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      agentResults = { error: 'No ANTHROPIC_API_KEY' };
    } else {
      const testable = rAlertTriggers.filter(t => !t.gated && t._state);
      let selected = testable;
      if (triggerIdx != null) {
        const tiStr = String(triggerIdx);
        if (tiStr.includes('-')) {
          const [start, end] = tiStr.split('-').map(Number);
          if (!isNaN(start) && !isNaN(end) && start >= 0 && end < testable.length) {
            selected = testable.slice(start, end + 1);
          } else { selected = []; }
        } else {
          const ti = parseInt(triggerIdx);
          if (!isNaN(ti) && ti >= 0 && ti < testable.length) {
            selected = [testable[ti]];
          } else { selected = []; }
        }
      }

      log(`[replay-agent] ${matchup}: running ${selected.length} of ${testable.length} triggers`);
      const agentRuns = [];
      const v2TrailAlerts = []; // for compounding

      for (const t of selected) {
        // Build floor history from floorLog
        const histEnd = floorLog.findIndex(f => f.idx >= t.idx);
        const histSlice = floorLog.slice(Math.max(0, (histEnd > 0 ? histEnd : floorLog.length) - 5), histEnd > 0 ? histEnd + 1 : floorLog.length);
        const floorHistory = histSlice.map(f => {
          const fl = floorSource === 'recomputed' ? f.recomputedFloor : f.storedFloor;
          const ft = floorSource === 'recomputed' ? f.recomputedTeam : f.storedCtrl;
          return `Q${f.period} ${f.clock}: ${ft} ${Number(fl).toFixed(2)} (${f.awayPts}-${f.homePts}) TP:${f.tp || '?'} LS:${f.ls || '?'}`;
        }).reverse().join('\n');

        // Build prior alert trail from v2TrailAlerts
        const parseClockSecs = (c) => { const p = String(c || '0:00').split(':'); return (parseInt(p[0])||0)*60 + (parseInt(p[1])||0); };
        const tClockSecs = parseClockSecs(t.clock);
        const priorAlerts = v2TrailAlerts.filter(a => a.period < t.period || (a.period === t.period && parseClockSecs(a.clock) > tClockSecs));
        const priorAlertTrail = priorAlerts.length > 0
          ? priorAlerts.map(a => {
              const fl = floorSource === 'recomputed' ? a.floor : a.storedFloor;
              return `${a.alertType}[${a.bwcState||'-'}] Q${a.period} ${a.clock}: floor ${Number(fl).toFixed(2)}, margin ${a.margin} → ${a.decision}: ${a.reasoning}`;
            }).reverse().slice(0, 5).join('\n')
          : 'None';

        // Load structural stress from game_context
        const gcMatch = gameContextRows
          .filter(r => Number(r.period) <= t.period)
          .sort((a, b) => Number(b.period) - Number(a.period))[0];
        let gcCtx = null;
        if (gcMatch) {
          try { gcCtx = typeof gcMatch.context_json === 'string' ? JSON.parse(gcMatch.context_json) : gcMatch.context_json; }
          catch (e) { /* bad JSON */ }
        }

        // Build v2Ctx from recomputed data + stored supporting data
        const s = t._state;
        const bwc = t._bwc || {};
        const grad = t._grad || {};
        const v2Ctx = {
          alertType: t.type, alertTier: t.tier || 'FIRED',
          ctrlTeam: t.ctrl || t.floor_team, floor: Number(t.floor).toFixed(2),
          margin: t.margin,
          awayAlias: aA, homeAlias: hA,
          awayPts: floorLog.find(f => f.idx === t.idx)?.awayPts || 0,
          homePts: floorLog.find(f => f.idx === t.idx)?.homePts || 0,
          ctrlIsHome: (t.ctrl || t.floor_team) === hA,
          period: t.period, clock: t.clock,
          bwcTeam: bwc.team || rlt.bwc_fired?.team || null,
          // Indicators (ctrl-relative, recomputed)
          i1: s.i1, i2: s.i2, i3: s.i3, i4: s.i4, i5: s.i5,
          ctrlIndicators: s.ctrlIndicators, ctrlIndicatorCount: s.ctrlIndicatorCount,
          ctrlSust: s.ctrlSust, oppSust: s.oppSust,
          tpClass: s.tpClass, lsClass: s.lsClass,
          oppIndicatorCount: s.oppIndicatorCount, oppIndicatorsWon: s.oppIndicatorsWon, oppI3Won: s.oppI3Won,
          convictionTier: s.convictionTier, convictionCombo: s.convictionCombo, convictionPairs: s.convictionPairs,
          // Position health (recomputed)
          peakFloor: bwc.peakFloor || null, peakDelta: bwc.peakDelta || null,
          erosionLevel: bwc.erosionLevel || 'STABLE',
          consecutiveHolds: bwc.holds || 0,
          bwcState: bwc.state || t.to || null,
          bwcFirePeriod: bwc.firePeriod || null, bwcFireFloor: bwc.fireFloor || null,
          // Floor + prior trail
          floorHistory, priorAlertTrail,
          // Structural stress (stored)
          windowData: gcCtx?.rollingWindow || null,
          quarterDiffs: gcCtx?.quarterDiffs || null,
          accelData: gcCtx?.acceleration || null,
          combinedRead: gcCtx?.combinedRead || null,
          // Graduation (recomputed)
          poRank: grad.poFired ? grad.peakRank : null,
          cpMeanFloor: grad.mf ? Math.round(grad.mf * 1000) / 1000 : null,
          cpMinFloor: grad.minF ? Math.round(grad.minF * 1000) / 1000 : null,
          cpEligibleCount: grad.eligibleCount || 0,
          cpPeakRank: grad.peakRank || null,
          cpGraduation: grad.graduation || null,
          cpOppGraduation: grad.oppGraduation || null,
          cpCtrlFlips: grad.cpFlips || 0,
          ctrlFlips: bwc.ctrlFlips || 0,
          lane: game.live_tracking?.lane || null,
          pregameML: game.live_tracking?.pregame_ml || null,
          mfTrajectory: grad.mfTrajectory || null,
          bwcFlipped: false, positionClosed: bwc.positionClosed || false,
          originalBwcTeam: null,
          isFlipBuy: false, flipBuyContext: null,
        };

        const prompt = buildV2AgentPrompt(v2Ctx);

        try {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
          });

          if (!resp.ok) { agentRuns.push({ trigger: `${t.type} Q${t.period} ${t.clock}`, error: `API ${resp.status}` }); continue; }
          const data = await resp.json();
          const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

          const decisionMatch = text.match(/DECISION:\s*(SEND|SUPPRESS|DOWNGRADE)/i);
          const reasoningMatch = text.match(/REASONING:\s*([\s\S]*?)(?=BODY:|$)/i);
          const bodyMatch = text.match(/BODY:\s*([\s\S]*)/i);

          const result = {
            trigger: `${t.type} Q${t.period} ${t.clock}`,
            alertType: t.type, period: t.period, clock: t.clock,
            bwcState: bwc.state || t.to || null,
            positionClosed: bwc.positionClosed || false,
            decision: decisionMatch ? decisionMatch[1].toUpperCase() : 'PARSE_FAIL',
            reasoning: reasoningMatch ? reasoningMatch[1].trim() : text.substring(0, 200),
            body: bodyMatch ? bodyMatch[1].trim() : '',
            floorSource,
            stressPresent: !!(gcCtx?.rollingWindow?.available),
            stressCombinedRead: gcCtx?.combinedRead?.read || null,
            referencesStress: text.includes('window') || text.includes('COLLAPSING') || text.includes('FLIPPED') || text.includes('combined read') || text.includes('rolling'),
            referencesPositionClosed: text.includes('EXIT') || text.includes('re-entry') || text.includes('RE-ENTRY') || text.includes('position closed') || text.includes('CLOSED'),
            tokens: data.usage,
          };
          agentRuns.push(result);

          // Update trail for compounding
          const storedFloorAtTrigger = floorLog.find(f => f.idx === t.idx)?.storedFloor || t.floor;
          v2TrailAlerts.push({
            alertType: t.type, bwcState: bwc.state || t.to,
            period: t.period, clock: t.clock,
            floor: t.floor, storedFloor: storedFloorAtTrigger, margin: t.margin,
            decision: result.decision,
            reasoning: result.reasoning.substring(0, 150),
          });

          log(`[replay-agent] ${t.type} Q${t.period} ${t.clock} → ${result.decision}`);
        } catch (e) {
          agentRuns.push({ trigger: `${t.type} Q${t.period} ${t.clock}`, error: e.message });
        }
      }

      agentResults = {
        totalTestable: testable.length,
        ran: selected.length,
        floorSource,
        triggers: testable.map((t, i) => `[${i}] ${t.type} Q${t.period} ${t.clock} floor=${Number(t.floor).toFixed(2)} margin=${t.margin}`),
        results: agentRuns,
      };
    }
  }

  return { summary, snapshots: rows, checkpoints: rCheckpoints, agentResults };
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

    // ── PRESET MANAGEMENT (action= routes) ──
    if (params.action === 'list_presets') {
      const rows = await sql`SELECT name, league, config_json, description, created_at FROM replay_configs ORDER BY created_at DESC`;
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, presets: rows }, null, 2) };
    }
    if (params.action === 'save_preset') {
      const body = event.httpMethod === 'POST' ? JSON.parse(event.body || '{}') : {};
      const name = body.name || params.name;
      const league = body.league || params.league || 'nba';
      const description = body.description || params.description || null;
      let configJson = body.config || (params.config ? JSON.parse(Buffer.from(params.config, 'base64').toString()) : null);
      if (!name || !configJson) return { statusCode: 400, headers, body: JSON.stringify({ error: 'name and config required' }) };
      const configStr = typeof configJson === 'string' ? configJson : JSON.stringify(configJson);
      await sql`INSERT INTO replay_configs (name, league, config_json, description)
        VALUES (${name}, ${league}, ${configStr}::jsonb, ${description})
        ON CONFLICT (name) DO UPDATE SET league = ${league}, config_json = ${configStr}::jsonb, description = ${description}, created_at = NOW()`;
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, saved: name }) };
    }
    if (params.action === 'delete_preset') {
      if (!params.name) return { statusCode: 400, headers, body: JSON.stringify({ error: 'name required' }) };
      await sql`DELETE FROM replay_configs WHERE name = ${params.name}`;
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, deleted: params.name }) };
    }
    if (params.action === 'get_preset') {
      if (!params.name) return { statusCode: 400, headers, body: JSON.stringify({ error: 'name required' }) };
      const rows = await sql`SELECT * FROM replay_configs WHERE name = ${params.name}`;
      if (rows.length === 0) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found: ' + params.name }) };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, preset: rows[0] }, null, 2) };
    }

    // ── REPLAY MODE ──
    if (mode === 'replay') {
      if (!params.game_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'game_id required for mode=replay' }) };

      // Build config: league defaults → preset → inline overrides
      const league = params.league || 'nba';
      let presetConfig = null;
      if (params.preset) {
        const presetRows = await sql`SELECT config_json FROM replay_configs WHERE name = ${params.preset}`;
        if (presetRows.length > 0) {
          presetConfig = typeof presetRows[0].config_json === 'string' ? JSON.parse(presetRows[0].config_json) : presetRows[0].config_json;
        } else {
          return { statusCode: 404, headers, body: JSON.stringify({ error: 'Preset not found: ' + params.preset }) };
        }
      }
      let inlineConfig = null;
      if (params.config) {
        try { inlineConfig = JSON.parse(Buffer.from(params.config, 'base64').toString()); }
        catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid base64 config: ' + e.message }) }; }
      }

      const finalConfig = buildConfig(league, presetConfig, inlineConfig);
      const diffOnly = params.diff_only === 'true';
      const runAgent = params.agent === 'true';
      const floorSource = params.floor_source || 'stored';
      const replayTriggerIdx = params.trigger_idx != null ? params.trigger_idx : null;

      const result = await replayWithConfig(sql, params.game_id, finalConfig, diffOnly, runAgent, floorSource, replayTriggerIdx);
      return { statusCode: 200, headers, body: JSON.stringify({ mode: 'replay', league, preset: params.preset || null, config: finalConfig, agent: runAgent, floor_source: floorSource, ...result }, null, 2) };
    }

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
          if (t1Pass) {
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
      const triggerIdx = params.trigger_idx != null
        ? (params.trigger_idx.includes('-') ? params.trigger_idx : parseInt(params.trigger_idx))
        : null;
      const useMonitor = params.monitor === 'true';

      // Ensure test_decisions table exists + handle reset
      await sql`CREATE TABLE IF NOT EXISTS test_decisions (
        game_id TEXT NOT NULL, trigger_idx INTEGER NOT NULL, monitor BOOLEAN DEFAULT false,
        decision TEXT, reasoning TEXT, body TEXT, ts TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (game_id, trigger_idx, monitor)
      )`;
      if (params.reset === 'true') {
        await sql`DELETE FROM test_decisions WHERE game_id = ${params.game_id} AND monitor = ${useMonitor}`;
      }

      const report = await replayGame(sql, params.game_id, mode, triggerIdx, useMonitor);
      return { statusCode: 200, headers, body: JSON.stringify({ mode, monitor: useMonitor, report }, null, 2) };
    }

    // Default: list available games
    return { statusCode: 200, headers, body: JSON.stringify({
      usage: '?all=true or ?game_id=X, mode=mechanical|context|agent|replay, monitor=true for monitor enrichment',
      replay_usage: '?mode=replay&game_id=X&league=nba&preset=NAME&config=BASE64_JSON&diff_only=true',
      preset_actions: '?action=list_presets | save_preset | delete_preset&name=X | get_preset&name=X',
      testGames: Object.entries(TEST_GAMES).map(([id, m]) => ({ id, ...m })),
    }, null, 2) };

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

// On-demand function — not scheduled

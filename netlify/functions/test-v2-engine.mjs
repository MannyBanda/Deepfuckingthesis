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
                snap, cr, lt, erosion, bwcState, v2Alerts, snapshots, idx, hA, aA, useMonitor
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
          }
        }
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
              snap, cr, lt, erosion, bwcState, v2Alerts, snapshots, idx, hA, aA, useMonitor
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
    report.agentResults = await runAgentTests(triggers, v2Alerts, matchup, triggerIdx, useMonitor);
  }

  return report;
}

// ── MONITOR TREND COMPUTATION ──
// Computes the same signals as production computeMonitorTrends() from replay snapshots.
// These are the signals the monitor uniquely produces that v2 context packages don't have:
// - Momentum direction/streak/delta (labeled trend vs raw floor history)
// - Sustainability arc (opp sust trajectory, not just point-in-time)
// - Floor-margin relationship (ALIGNED/DIVERGING/CONVERGING)

function computeMonitorContext(allSnaps, idx, hA, aA, ctrlTeam, ctrlIsHome) {
  // Use last 8 snapshots up to current index (same window as production monitor)
  const start = Math.max(0, idx - 7);
  const trendSnaps = allSnaps.slice(start, idx + 1);
  if (trendSnaps.length < 3) return null;

  const floors = trendSnaps.map(s => Number(s.floor_score || 0));
  const margins = trendSnaps.map(s => {
    const h = Number(s.home_pts || 0), a = Number(s.away_pts || 0);
    return ctrlIsHome ? h - a : a - h;
  });

  // ── Momentum ──
  let dir = null, streak = 0;
  for (let j = floors.length - 1; j > 0; j--) {
    const diff = floors[j] - floors[j - 1];
    if (diff > 0.01) {
      if (dir === 'RISING' || dir === null) { dir = 'RISING'; streak++; }
      else break;
    } else if (diff < -0.01) {
      if (dir === 'FALLING' || dir === null) { dir = 'FALLING'; streak++; }
      else break;
    } else {
      if (dir === null) { streak++; }
      else break;
    }
  }
  // Check for oscillation
  if (floors.length >= 4) {
    let changes = 0;
    for (let k = 2; k < floors.length; k++) {
      const prev = floors[k - 1] - floors[k - 2];
      const curr = floors[k] - floors[k - 1];
      if ((prev > 0.01 && curr < -0.01) || (prev < -0.01 && curr > 0.01)) changes++;
    }
    if (changes >= 2 && streak <= 1) dir = 'OSCILLATING';
  }
  const momentumDir = dir || 'STABLE';
  const momentumDelta = streak > 0
    ? Math.round((floors[floors.length - 1] - floors[Math.max(0, floors.length - 1 - streak)]) * 100) / 100
    : 0;

  // ── Sustainability arc (opponent) ──
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

  let sustArcDir = 'STABLE', sustArcDetail = '';
  if (oppSustHistory.length >= 2) {
    const firstVal = sustTiers[oppSustHistory[0]] ?? 3;
    const lastVal = sustTiers[oppSustHistory[oppSustHistory.length - 1]] ?? 3;
    sustArcDir = lastVal < firstVal ? 'DEGRADING' : lastVal > firstVal ? 'IMPROVING' : 'STABLE';
    const seen = [];
    oppSustHistory.forEach(t => { if (seen[seen.length - 1] !== t) seen.push(t); });
    sustArcDetail = seen.join(' → ');
  }

  // ── Floor-margin relationship ──
  let floorMarginRel = 'ALIGNED';
  if (floors.length >= 3 && margins.length >= 3) {
    const floorChange = floors[floors.length - 1] - floors[0];
    const marginChange = margins[margins.length - 1] - margins[0];
    const floorUp = floorChange > 0.03, floorDown = floorChange < -0.03;
    const marginUp = marginChange > 2, marginDown = marginChange < -2;
    if ((floorUp && marginDown) || (floorDown && marginUp)) floorMarginRel = 'DIVERGING';
    else if ((floorUp && marginUp) || (floorDown && marginDown)) floorMarginRel = 'CONVERGING';
  }

  return {
    momentum: `${momentumDir}(${streak}, ${momentumDelta >= 0 ? '+' : ''}${momentumDelta.toFixed(2)})`,
    momentumDir,
    momentumStreak: streak,
    momentumDelta,
    sustArc: sustArcDir,
    sustArcDetail,
    floorMarginRel,
  };
}

// ── CONTEXT PACKAGE ASSEMBLY ──

function assembleContextPackage(snap, cr, lt, erosion, bwcState, v2Alerts, allSnaps, idx, hA, aA, useMonitor = false) {
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

    // Monitor enrichment (only when &monitor=true)
    monitorContext: useMonitor
      ? computeMonitorContext(allSnaps, idx, hA, aA, cr.ctrlTeam, cr.ctrlIsHome)
      : null,
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

async function runAgentTests(triggers, v2Alerts, matchup, triggerIdx = null, useMonitor = false) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return { error: 'No ANTHROPIC_API_KEY' };

  const results = [];
  // Only test triggers that have context packages AND are alert types
  let testable = triggers.filter(t =>
    t.contextPackage && (t.alertType === 'VALUE' || t.alertType === 'EXIT' || t.alertType === 'BUY'
      || t.alertType === 'BWC_EDGE' || t.alertType === 'POSITION_SAFE' || t.alertType === 'THESIS_ALIVE'
      || t.alertType === 'POSITION_RECOVERING')
  );

  // If trigger_idx specified, only test that one (avoids Netlify timeout)
  if (triggerIdx != null && triggerIdx >= 0 && triggerIdx < testable.length) {
    testable = [testable[triggerIdx]];
  }
  const totalTestable = triggers.filter(t => t.contextPackage && t.alertType).length;

  log(`${matchup}: running ${testable.length} of ${totalTestable} agent tests${triggerIdx != null ? ` (trigger_idx=${triggerIdx})` : ''}`);

  for (const t of testable) {
    const ctx = t.contextPackage;

    // Build the v2 agent prompt with enriched context
    const prompt = `You are a live NBA betting alert quality agent. A mechanical system has identified a potential betting signal. Your job is to assess whether it should be sent to the bettor.

ALERT:
Type: ${t.alertType} (${t.buyTier || 'FIRED'})
Control team: ${ctx.ctrlTeam} | Floor: ${ctx.floor.toFixed(2)} | Margin: ${ctx.margin} (${ctx.margin < 0 ? 'trailing' : ctx.margin > 0 ? 'leading' : 'tied'})
Score: ${ctx.awayAlias} ${ctx.awayPts} - ${ctx.homeAlias} ${ctx.homePts} (${ctx.ctrlTeam} is ${ctx.ctrlIsHome ? 'HOME' : 'AWAY'})
Period: Q${ctx.period} ${ctx.clock}
${ctx.bwcTeam ? 'BWC team (subscriber position): ' + ctx.bwcTeam + (ctx.bwcTeam !== ctx.ctrlTeam ? ' (NOT current ctrl team — ctrl flipped to ' + ctx.ctrlTeam + ')' : '') : ''}

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
${ctx.monitorContext ? `
MONITOR OBSERVATION (continuous game observer — mechanically computed trends):
Momentum: ${ctx.monitorContext.momentum} | Floor-margin: ${ctx.monitorContext.floorMarginRel}
Opp sustainability arc: ${ctx.monitorContext.sustArc}${ctx.monitorContext.sustArcDetail ? ' (' + ctx.monitorContext.sustArcDetail + ')' : ''}
NOTE: These trends are computed from the last 8 snapshots. Momentum labels what the floor trajectory already shows. Floor-margin DIVERGING means the structural edge (floor) and the scoreboard (margin) are moving in opposite directions — this is expected in DFT (process dominance precedes score). Use these signals as supplemental context, not as primary decision factors.` : ''}

RULES:
- VALUE: team PREVIOUSLY held a structural lead (BWC fired Q${ctx.bwcFirePeriod || '?'}) but lost it while retaining structural control. Thesis: "structural edge that built the lead is intact — dip is temporary, plus-money entry." Verify: floor vs BWC fire floor, how lead was lost, deficit depth (1-7 best), timing (Q2-Q3 > Q4). If prior BWC_EDGE alerts flagged a RISK, reference whether it materialized. SUPPRESS if erosion is COLLAPSE AND structural indicators (I1/I4) have flipped to opponent.
- THESIS_ALIVE: BWC team regained structural control AFTER an EXIT. This is a deep-value play — floor erosion is EXPECTED and is WHY plus-money exists. DO NOT treat floor level or erosion as primary factors. Weight hierarchy: (1) WHICH indicators does the BWC team still hold? I1 Disruption + I4 Game Control = structural core retained. (2) Is opponent's edge variance-based? oppI3Won=true means opponent is shooting well, not structurally dominant — this is the thesis. (3) TP path — STRONG RECOVERY or PROBABLE = mechanical path exists. (4) Deficit depth and timing. Floor being below BWC fire floor is the ENTRY SIGNAL, not a red flag. SUPPRESS only if: BWC team lost I1+I4 (structural core gone), OR opponent has non-I3 structural indicators (I1/I2/I4), OR TP is NO PATH/UNLIKELY with < 3 min left.
- EXIT: BWC team (${ctx.bwcFirePeriod ? 'the team that fired BWC in Q' + ctx.bwcFirePeriod : 'original BWC team'}) lost structural control. The SUBSCRIBER'S POSITION is on the BWC team, NOT the current control team. Frame the exit around the BWC team losing their edge. Reference the full arc from prior alerts.
- BWC_EDGE: ALWAYS SEND. This is a position update for a subscriber already holding. Frame as reassurance: structural picture holding, lead compressing. Do NOT frame as a buy signal. MUST include a RISK line at the end of the body — identify the ONE specific thing that could flip this position next (e.g., indicator about to flip, sustainability degrading, erosion approaching threshold). If prior alerts flagged a RISK, reference whether it materialized or not. The RISK line creates accountability across the alert chain. Format body as: status update (2-3 sentences) + "RISK: [specific forward-looking concern]"
- POSITION_SAFE / POSITION_RECOVERING: SEND as reassurance if prior alerts flagged risks or concerns. Include whether prior RISK materialized. SUPPRESS only if nothing changed AND no prior risk to update on. Write reasoning for compounding either way.
- BUY: structurally dominant team trailing with no prior BWC. Standard evaluation — floor, indicators, TP, deficit depth (1-7 sweet spot; deeper deficits need stronger structural case).
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
        referencesOpponentProfile: text.includes('opponent') || text.includes('I1') || text.includes('counter-indicator'),
        referencesErosion: text.includes('erosion') || text.includes('peak') || text.includes('CAUTION') || text.includes('COLLAPSE'),
        referencesBwcLifecycle: text.includes('BWC') || text.includes('LOCK') || text.includes('lifecycle') || text.includes('prior'),
        monitorPresent: !!ctx.monitorContext,
        referencesMonitor: text.includes('momentum') || text.includes('DIVERGING') || text.includes('CONVERGING') || text.includes('RISING') || text.includes('FALLING') || text.includes('sust arc') || text.includes('sustainability arc'),
        monitorData: ctx.monitorContext || null,
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

  return {
    triggerIndex: triggerIdx,
    totalTestable,
    availableTriggers: triggers
      .filter(t => t.contextPackage && t.alertType)
      .map((t, i) => `${i}: ${t.alertType}[${t.bwcState || '-'}] Q${t.period} ${t.clock}`),
    results,
  };
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
      const triggerIdx = params.trigger_idx != null ? parseInt(params.trigger_idx) : null;
      const useMonitor = params.monitor === 'true';
      const report = await replayGame(sql, params.game_id, mode, triggerIdx, useMonitor);
      return { statusCode: 200, headers, body: JSON.stringify({ mode, monitor: useMonitor, report }, null, 2) };
    }

    // Default: list available games
    return { statusCode: 200, headers, body: JSON.stringify({
      usage: '?all=true or ?game_id=X, mode=mechanical|context|agent, monitor=true for monitor enrichment',
      testGames: Object.entries(TEST_GAMES).map(([id, m]) => ({ id, ...m })),
    }, null, 2) };

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

// On-demand function — not scheduled

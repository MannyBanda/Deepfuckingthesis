// NBA Snapshot Backtest — In-game indicator accuracy
// Walks each game's PBP and emits 8 checkpoint snapshots:
//   Q1@6:00, Q1_END, Q2@6:00, Q2_END, Q3@6:00, Q3_END, Q4@6:00, Q4_END
//
// For each snapshot, we compute cumulative team_stats + pbp_derived THROUGH
// that moment, then run the same computeServer + computeConviction we use for
// end-of-game truth. Truth label = final winner (ctrl_team_won).
//
// Answers three questions simultaneously (same ~10k rows, different GROUP BYs):
//   1. Calibration: when floor=X, what's the actual win rate?
//   2. Time decay: how does accuracy evolve Q1 → Q4?
//   3. Alert sim: forward win rate when BUY/BWC/WB thresholds would've fired
//
// Phases:
//   ?phase=init&confirm=wipe — DROP + CREATE table
//   ?phase=init              — Idempotent create
//   ?phase=snapshot&n=200&c=8 — Walk PBP, emit snapshots
//   ?phase=compute&force=1   — Run computeServer on snapshots
//   ?phase=report_calibration — Floor-bucket vs actual win rate
//   ?phase=report_time       — Accuracy by checkpoint
//   ?phase=report_alert_sim  — Simulate BUY/BWC/WB thresholds
//   ?phase=report_all        — All three in one response
//   ?phase=status            — Progress
//   ?phase=inspect&gid=X     — Dump snapshots for one game

import { neon } from '@neondatabase/serverless';

const BDL_BASE = 'https://api.balldontlie.io';
const BDL_KEY = process.env.BDL_API_KEY;

const W = { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };

// Checkpoint definitions — 8 per game
// clock_remaining = seconds left in that period (720 = 12:00 start, 0 = end)
const CHECKPOINTS = [
  { label: 'Q1_6', period: 1, clockSec: 360 },
  { label: 'Q1_END', period: 1, clockSec: 0 },
  { label: 'Q2_6', period: 2, clockSec: 360 },
  { label: 'Q2_END', period: 2, clockSec: 0 },
  { label: 'Q3_6', period: 3, clockSec: 360 },
  { label: 'Q3_END', period: 3, clockSec: 0 },
  { label: 'Q4_6', period: 4, clockSec: 360 },
  { label: 'Q4_END', period: 4, clockSec: 0 },
];

// ── PBP zone classification ─────────────────────────────────────────────────
const BDL_BASKET_X = 25, BDL_BASKET_Y = 1.5;
const BDL_RIM_RADIUS = 4, BDL_PAINT_RADIUS = 9, BDL_THREE_RADIUS = 22, BDL_CORNER_Y_MAX = 9;
const BDL_RIM_SET = new Set(['layup shot','driving layup shot','running layup shot','cutting layup shot','reverse layup shot','finger roll layup','layup shot putback','putback layup shot','driving reverse layup shot','running reverse layup shot','dunk shot','driving dunk shot','running dunk shot','cutting dunk shot','alley oop dunk shot','putback dunk shot','running alley oop dunk shot','tip shot','tip dunk shot']);
const BDL_PAINT_SET = new Set(['driving floating jump shot','floating jump shot','driving hook shot','hook shot','running hook shot','driving finger roll layup','turnaround hook shot']);

function bdlCoordsValid(x, y) { return x != null && y != null && x > -1000 && y > -1000 && x < 1000 && y < 1000; }
function bdlDistFromBasket(x, y) { return Math.sqrt(Math.pow(x - BDL_BASKET_X, 2) + Math.pow(y - BDL_BASKET_Y, 2)); }

function classifyZone(x, y, shotType, text, scoreValue) {
  const tl = (shotType || '').toLowerCase().trim();
  const tx = (text || '').toLowerCase();
  const is3 = scoreValue === 3 || tx.includes('three point');
  if (BDL_RIM_SET.has(tl)) return 'rim';
  if (BDL_PAINT_SET.has(tl)) return 'paint';
  if (is3) return 'three';
  if (bdlCoordsValid(x, y)) {
    const d = bdlDistFromBasket(x, y);
    if (d < BDL_RIM_RADIUS) return 'rim';
    if (d < BDL_PAINT_RADIUS) return 'paint';
    if (d >= BDL_THREE_RADIUS) return 'three';
    return 'mid';
  }
  const dm = tx.match(/(\d+)-foot/);
  if (dm) { const dd = parseInt(dm[1]); if (dd <= 4) return 'rim'; if (dd <= 9) return 'paint'; if (dd >= 22) return 'three'; return 'mid'; }
  if (tl.includes('layup') || tl.includes('dunk') || tl.includes('tip')) return 'rim';
  if (tl.includes('hook') || tl.includes('float')) return 'paint';
  return 'mid';
}

function parseClockToSec(clockStr) {
  if (!clockStr) return 720;
  const s = String(clockStr).trim();
  // Format 1: "12:00" or "11:45"
  const m1 = s.match(/^(\d+):(\d+)$/);
  if (m1) return parseInt(m1[1]) * 60 + parseInt(m1[2]);
  // Format 2: "28.6" (tenths of seconds, under 1 min)
  const m2 = s.match(/^(\d+)\.(\d+)$/);
  if (m2) return parseInt(m2[1]);
  // Integer seconds
  const m3 = s.match(/^(\d+)$/);
  if (m3) return parseInt(m3[1]);
  return 720;
}

// ── Snapshot-aware PBP walker ───────────────────────────────────────────────
// Walks plays in order, accumulating state. At each checkpoint boundary,
// emits a snapshot of cumulative team_stats + pbp_derived THROUGH that moment.
//
// A checkpoint fires when we encounter the first play whose (period, clockSec)
// is past the checkpoint's moment. "Past" means: period > cp.period, OR
// period === cp.period && clockSec <= cp.clockSec.
function walkAndSnapshot(plays, hA, aA) {
  const sorted = plays.slice().sort((a, b) => (a.order || 0) - (b.order || 0));

  // State: everything accumulates; snapshots capture state-at-moment
  const state = {
    // Box-score aggregates per team (for computeServer h/a args)
    h: { pts: 0, fgm: 0, fga: 0, fg3m: 0, fg3a: 0, ftm: 0, fta: 0, ast: 0, to: 0, stl: 0, blk: 0, oreb: 0 },
    a: { pts: 0, fgm: 0, fga: 0, fg3m: 0, fg3a: 0, ftm: 0, fta: 0, ast: 0, to: 0, stl: 0, blk: 0, oreb: 0 },
    // PBP-derived
    hPaint: 0, aPaint: 0, hRimM: 0, hRimA: 0, aRimM: 0, aRimA: 0,
    hBigLead: 0, aBigLead: 0, hPOT: 0, aPOT: 0,
    q4hPts: 0, q4aPts: 0,
    scoreLog: [],
    pendPOT: null, lastPeriod: 0,
  };

  function snapshotState() {
    // Runs6 must be recomputed from scoreLog at each snapshot (runs are
    // boundary-sensitive: they close when the other team scores, so we
    // can't accumulate them — we rebuild each time).
    const runs6 = [];
    let runTeam = null, runPts = 0;
    for (const s of state.scoreLog) {
      if (s.team === runTeam) { runPts += s.pts; }
      else {
        if (runPts >= 6 && runTeam) runs6.push({ team: runTeam, pts: runPts });
        runTeam = s.team;
        runPts = s.pts;
      }
    }
    if (runPts >= 6 && runTeam) runs6.push({ team: runTeam, pts: runPts });

    return {
      team_stats: { home: { ...state.h }, away: { ...state.a } },
      pbp_derived: {
        hPaint: state.hPaint, aPaint: state.aPaint,
        hRimM: state.hRimM, hRimA: state.hRimA,
        aRimM: state.aRimM, aRimA: state.aRimA,
        hBigLead: state.hBigLead, aBigLead: state.aBigLead,
        hPOT: state.hPOT, aPOT: state.aPOT,
        q4hPts: state.q4hPts, q4aPts: state.q4aPts,
        runs6: {
          h: runs6.filter(r => r.team === hA).length,
          a: runs6.filter(r => r.team === aA).length,
          total: runs6.length,
          detail: runs6,
        },
      },
    };
  }

  const snapshots = [];
  let nextCpIdx = 0;

  for (const ev of sorted) {
    const type = (ev.type || '').trim();
    const tl = type.toLowerCase();
    const text = (ev.text || '').replace(/\n/g, ' ').trim();
    const tx = text.toLowerCase();
    const tAbbr = ev.team?.abbreviation || '';
    const team = tAbbr === hA ? hA : tAbbr === aA ? aA : null;
    const period = ev.period || 0;
    const clockSec = parseClockToSec(ev.clock);

    // ── Fire any checkpoints we've crossed BEFORE processing this play ──
    // A checkpoint fires when we reach its moment. We emit state AT that moment,
    // so we fire BEFORE applying this play if this play is the first past the boundary.
    while (nextCpIdx < CHECKPOINTS.length) {
      const cp = CHECKPOINTS[nextCpIdx];
      const crossed = period > cp.period || (period === cp.period && clockSec <= cp.clockSec);
      if (!crossed) break;

      const snap = snapshotState();
      snapshots.push({
        checkpoint: cp.label,
        period: cp.period,
        clockSec: cp.clockSec,
        ...snap,
      });
      nextCpIdx++;
    }

    // ── Reset pending POT on period change ──
    if (period !== state.lastPeriod && state.lastPeriod > 0) state.pendPOT = null;
    state.lastPeriod = period;

    // ── Track biggest_lead from cumulative home_score/away_score ──
    const hs = ev.home_score, as = ev.away_score;
    if (hs != null && as != null) {
      const mg = hs - as;
      if (mg > state.hBigLead) state.hBigLead = mg;
      if (-mg > state.aBigLead) state.aBigLead = -mg;
    }

    if (tl.includes('substitution') || tx.includes('enters the game for')) continue;

    // ── Shooting plays ──
    if (ev.shooting_play) {
      const made = !!ev.scoring_play;
      const is3 = ev.score_value === 3 || tx.includes('three point');

      // Free throws
      if (tl.includes('free throw')) {
        if (team === hA) { state.h.fta++; if (made) state.h.ftm++; }
        else if (team === aA) { state.a.fta++; if (made) state.a.ftm++; }

        if (made && team) {
          const pts = 1;
          if (team === hA) state.h.pts += pts;
          else state.a.pts += pts;
          state.scoreLog.push({ team, pts, q: period });
          if (period === 4) {
            if (team === hA) state.q4hPts += pts;
            else if (team === aA) state.q4aPts += pts;
          }
          if (state.pendPOT === team) {
            if (team === hA) state.hPOT += pts;
            else if (team === aA) state.aPOT += pts;
          }
        }
        const ftM = type.match(/(\d+)\s*of\s*(\d+)/i);
        if (ftM && ftM[1] === ftM[2] && made) state.pendPOT = null;
        continue;
      }

      // Field goals
      const pts = made ? (ev.score_value || (is3 ? 3 : 2)) : 0;
      const zone = classifyZone(ev.coordinate_x, ev.coordinate_y, type, text, ev.score_value);

      // FGA / FG3A
      if (team === hA) { state.h.fga++; if (is3) state.h.fg3a++; }
      else if (team === aA) { state.a.fga++; if (is3) state.a.fg3a++; }

      // FGM / FG3M
      if (made && team) {
        if (team === hA) { state.h.fgm++; if (is3) state.h.fg3m++; }
        else { state.a.fgm++; if (is3) state.a.fg3m++; }
      }

      // Rim attempts (both makes and misses)
      if (zone === 'rim') {
        if (team === hA) { state.hRimA++; if (made) state.hRimM++; }
        else if (team === aA) { state.aRimA++; if (made) state.aRimM++; }
      }
      // Paint pts (made 2s only, includes rim)
      if ((zone === 'rim' || zone === 'paint') && made && pts === 2) {
        if (team === hA) state.hPaint += 2;
        else if (team === aA) state.aPaint += 2;
      }

      // Blocks — "X blocks Y's ..." pattern
      if (text.toLowerCase().includes('blocks') && !made) {
        // The blocker is on the OTHER team; extract via regex
        const blockMatch = text.match(/^([A-Z][a-zA-Z'.\s-]+?)\s+blocks/i);
        if (blockMatch && team) {
          // Blocker team is opposite of shooter team
          const blockerTeam = team === hA ? aA : hA;
          if (blockerTeam === hA) state.h.blk++;
          else state.a.blk++;
        }
      }

      if (made && team) {
        // Accumulate team points — THIS was missing, causing all state.pts to
        // only count free throws (the fix is here).
        if (team === hA) state.h.pts += pts;
        else state.a.pts += pts;

        state.scoreLog.push({ team, pts, q: period });
        if (period === 4) {
          if (team === hA) state.q4hPts += pts;
          else if (team === aA) state.q4aPts += pts;
        }
        if (state.pendPOT === team) {
          if (team === hA) state.hPOT += pts;
          else if (team === aA) state.aPOT += pts;
        }
        state.pendPOT = null;

        // Assists — "(X assists)" pattern
        const astMatch = text.match(/\(([^)]+?)\s+assists?\)/i);
        if (astMatch) {
          if (team === hA) state.h.ast++;
          else state.a.ast++;
        }
      }
      continue;
    }

    // ── Turnovers ──
    if (tl.includes('turnover')) {
      if (team === hA) state.h.to++;
      else if (team === aA) state.a.to++;

      // Steal credited in text like "(X steals)"
      const stealMatch = text.match(/\(([^)]+?)\s+steals?\)/i);
      if (stealMatch && team) {
        const stealerTeam = team === hA ? aA : hA;
        if (stealerTeam === hA) state.h.stl++;
        else state.a.stl++;
      }

      state.pendPOT = team === hA ? aA : hA;
      continue;
    }

    // ── Offensive fouls count as TO and flip POT ──
    if (tl.includes('foul') && tl.includes('offensive')) {
      if (team === hA) state.h.to++;
      else if (team === aA) state.a.to++;
      state.pendPOT = team === hA ? aA : hA;
      continue;
    }

    // ── Rebounds ──
    if (tl.includes('rebound') && tl.includes('offensive')) {
      if (team === hA) state.h.oreb++;
      else if (team === aA) state.a.oreb++;
    }

    if (tl.includes('end period') || tl.includes('end game')) {
      state.pendPOT = null;
    }
  }

  // Fire any remaining checkpoints after processing all plays
  // (game ended, we're "past" all remaining checkpoints)
  while (nextCpIdx < CHECKPOINTS.length) {
    const cp = CHECKPOINTS[nextCpIdx];
    const snap = snapshotState();
    snapshots.push({
      checkpoint: cp.label,
      period: cp.period,
      clockSec: cp.clockSec,
      ...snap,
    });
    nextCpIdx++;
  }

  return snapshots;
}

// ── computeServer — same as production parser (copy for isolation) ──────────
function computeServer({ h, a, hA, aA, hPaint, aPaint, hRimM, hRimA, aRimM, aRimA,
                          hBigLead, aBigLead, hPOT, aPOT, runs6, q4hPts, q4aPts }) {
  if ((h.pts || 0) === 0 && (a.pts || 0) === 0) return null;

  const hDisrupt = (h.stl || 0) + (h.blk || 0);
  const aDisrupt = (a.stl || 0) + (a.blk || 0);
  const i1subA = (hDisrupt - aDisrupt) > 1 ? 1 : (hDisrupt - aDisrupt) < -1 ? -1 : 0;
  const i1subB = (hPOT - aPOT) > 4 ? 1 : (aPOT - hPOT) > 4 ? -1 : 0;
  const I1 = (i1subA + i1subB) > 0 ? 1 : (i1subA + i1subB) === 0 ? 0.5 : 0;

  const paintDiff = hPaint - aPaint;
  const i2subA = paintDiff > 6 ? 1 : paintDiff < -6 ? -1 : 0;
  const hRimPct = hRimA >= 6 ? hRimM / hRimA : null;
  const aRimPct = aRimA >= 6 ? aRimM / aRimA : null;
  let i2subB = 0;
  if (hRimPct != null && aRimPct != null) {
    if (hRimPct - aRimPct > 0.10) i2subB = 1;
    else if (aRimPct - hRimPct > 0.10) i2subB = -1;
  }
  const I2 = (i2subA + i2subB) > 0 ? 1 : (i2subA + i2subB) < 0 ? 0 : 0.5;

  const hEFG = ((h.fgm || 0) + 0.5 * (h.fg3m || 0)) / (h.fga || 1);
  const aEFG = ((a.fgm || 0) + 0.5 * (a.fg3m || 0)) / (a.fga || 1);
  const hAR = ((h.ast || 0) / (h.fgm || 1)) * 100;
  const aAR = ((a.ast || 0) / (a.fgm || 1)) * 100;
  const i3raw = (hEFG > aEFG + 0.02 ? 1 : hEFG < aEFG - 0.02 ? -1 : 0)
              + (hAR > aAR + 5 ? 1 : hAR < aAR - 5 ? -1 : 0);
  const I3 = i3raw > 0 ? 1 : i3raw === 0 ? 0.5 : 0;

  const blDiff = hBigLead - aBigLead;
  const i4subA = blDiff > 4 ? 1 : blDiff < -4 ? -1 : 0;
  let i4subB = 0;
  if (q4hPts != null && q4aPts != null) {
    const q4diff = q4hPts - q4aPts;
    i4subB = q4diff > 2 ? 1 : q4diff < -2 ? -1 : 0;
  }
  const I4 = (i4subA + i4subB) > 0 ? 1 : (i4subA + i4subB) === 0 ? 0.5 : 0;

  let I5 = 0.5;
  const hRuns = runs6.filter(r => r.team === hA).length;
  const aRuns = runs6.filter(r => r.team === aA).length;
  const totalRuns = hRuns + aRuns;
  if (totalRuns >= 4) {
    const rs = hRuns / totalRuns;
    I5 = rs > 0.55 ? 1 : rs < 0.45 ? 0 : 0.5;
  }

  const composite = I1 * W.I1 + I2 * W.I2 + I3 * W.I3 + I4 * W.I4 + I5 * W.I5;
  const ctrlHome = composite >= 0.5;
  const controlTeam = ctrlHome ? hA : aA;
  const score = ctrlHome ? composite : 1 - composite;

  return {
    controlTeam,
    score: Math.round(score * 100) / 100,
    composite: Math.round(composite * 100) / 100,
    I1, I2, I3, I4, I5,
    homeAlias: hA, awayAlias: aA,
    homePts: h.pts || 0, awayPts: a.pts || 0,
    raw: { hPaint, aPaint, hRimM, hRimA, aRimM, aRimA, hBigLead, aBigLead, hPOT, aPOT, hRuns, aRuns, totalRuns, q4hPts, q4aPts },
  };
}

function computeConviction(ind) {
  if (!ind || ind.score == null) return { tier: 'NO ENTRY', combo: 'NONE', indicatorsWon: [], indicatorsLost: [], count: 0, pairs: [], isDanger: false };
  const ctrlHome = ind.controlTeam === ind.homeAlias;
  const iVals = [
    { k: 'I1', v: ctrlHome ? ind.I1 : 1 - ind.I1 },
    { k: 'I2', v: ctrlHome ? ind.I2 : 1 - ind.I2 },
    { k: 'I3', v: ctrlHome ? ind.I3 : 1 - ind.I3 },
    { k: 'I4', v: ctrlHome ? ind.I4 : 1 - ind.I4 },
    { k: 'I5', v: ctrlHome ? ind.I5 : 1 - ind.I5 },
  ];
  const won = iVals.filter(x => x.v === 1).map(x => x.k);
  const lost = iVals.filter(x => x.v === 0).map(x => x.k);
  const even = iVals.filter(x => x.v === 0.5).map(x => x.k);
  const count = won.length;
  const combo = won.join('+') || 'NONE';

  const killerPairs = new Set(['I4+I5','I3+I4','I3+I5']);
  const pairs = [];
  for (let i = 0; i < won.length; i++) {
    for (let j = i + 1; j < won.length; j++) {
      const pair = `${won[i]}+${won[j]}`;
      if (killerPairs.has(pair)) pairs.push(pair);
    }
  }

  let tier;
  if ((won.includes('I4') && won.includes('I5')) || count >= 4) tier = 'DOMINANT';
  else if ((won.includes('I3') && won.includes('I4')) || (won.includes('I3') && won.includes('I5'))) tier = 'STRONG';
  else if (count >= 2) tier = 'MODEST';
  else if (count === 1) tier = 'CONDITIONAL';
  else tier = 'NO ENTRY';

  // Danger combos (false positives from backtest)
  const wonSet = new Set(won);
  const isDanger =
    (wonSet.has('I1') && wonSet.has('I5') && count === 2) ||
    (wonSet.has('I1') && wonSet.has('I2') && wonSet.has('I5') && count === 3) ||
    (wonSet.has('I2') && wonSet.has('I3') && wonSet.has('I5') && count === 3);

  return { tier, combo, count, indicatorsWon: won, indicatorsLost: lost, indicatorsEven: even, pairs, isDanger };
}

// ── BDL fetch ───────────────────────────────────────────────────────────────
async function bdlFetch(path, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(`${BDL_BASE}${path}`, { headers: { Authorization: BDL_KEY } });
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      if (!resp.ok) throw new Error(`BDL ${resp.status}`);
      return await resp.json();
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

// ── PHASE: INIT ─────────────────────────────────────────────────────────────
async function phaseInit(sql, url) {
  const confirm = url?.searchParams?.get('confirm');
  if (confirm === 'wipe') {
    await sql`DROP TABLE IF EXISTS nba_snapshot_backtest`;
  }

  await sql`
    CREATE TABLE IF NOT EXISTS nba_snapshot_backtest (
      game_id INTEGER NOT NULL,
      checkpoint TEXT NOT NULL,
      period INTEGER,
      clock_sec INTEGER,
      home_alias TEXT,
      away_alias TEXT,
      margin_at_snapshot INTEGER,   -- h.pts - a.pts at this moment
      team_stats JSONB,
      pbp_derived JSONB,
      indicators JSONB,
      conviction JSONB,
      ctrl_team_won BOOLEAN,        -- truth = final game outcome
      final_margin INTEGER,         -- final score margin (signed, home - away)
      computed_at TIMESTAMPTZ,
      PRIMARY KEY (game_id, checkpoint)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_snap_checkpoint ON nba_snapshot_backtest(checkpoint)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_snap_tier ON nba_snapshot_backtest((conviction->>'tier'))`;
  await sql`CREATE INDEX IF NOT EXISTS idx_snap_floor ON nba_snapshot_backtest(((indicators->>'score')::real))`;

  return {
    status: 'ok',
    message: confirm === 'wipe' ? 'Table wiped and recreated' : 'Table ready',
    nextStep: '?phase=snapshot&n=200&c=8',
  };
}

// ── PHASE: SNAPSHOT — walk PBP, emit 8 checkpoints per game ─────────────────
async function phaseSnapshot(sql, url) {
  const startTime = Date.now();
  const TIME_BUDGET_MS = 100000;
  const batchSize = parseInt(url.searchParams.get('n') || '200');
  const concurrency = Math.min(parseInt(url.searchParams.get('c') || '8'), 20);
  const force = url.searchParams.get('force') === '1';
  const offsetParam = parseInt(url.searchParams.get('offset') || '0');
  const dryRun = url.searchParams.get('dry') === '1';

  // Diagnostics
  const dbg = { force, batchSize, concurrency, offsetParam, dryRun, checkpoints: [] };
  dbg.checkpoints.push({ step: 'entered_handler', ms: Date.now() - startTime });

  // Normal: pick games without Q4_END snapshot (resumable).
  // Force: re-snapshot ALL games (INSERT...ON CONFLICT DO UPDATE refreshes
  //   team_stats + pbp_derived). Use after walker bug fixes.
  let games;
  try {
    games = force
      ? await sql`
          SELECT bt.bdl_game_id, bt.home_alias, bt.away_alias,
                 bt.home_pts, bt.away_pts, bt.winner_alias, bt.margin
          FROM nba_backtest bt
          WHERE bt.team_stats IS NOT NULL AND bt.game_type = 'regular'
          ORDER BY bt.date ASC
          LIMIT ${batchSize}
          OFFSET ${offsetParam}
        `
      : await sql`
          SELECT bt.bdl_game_id, bt.home_alias, bt.away_alias,
                 bt.home_pts, bt.away_pts, bt.winner_alias, bt.margin
          FROM nba_backtest bt
          LEFT JOIN nba_snapshot_backtest snap
            ON snap.game_id = bt.bdl_game_id AND snap.checkpoint = 'Q4_END'
          WHERE bt.team_stats IS NOT NULL
            AND bt.game_type = 'regular'
            AND snap.game_id IS NULL
          ORDER BY bt.date ASC
          LIMIT ${batchSize}
        `;
    dbg.checkpoints.push({ step: 'select_complete', ms: Date.now() - startTime, gamesFound: games.length });
  } catch (e) {
    return {
      error: 'SELECT failed',
      stage: 'games_query',
      mode: force ? 'force' : 'normal',
      message: e.message,
      stack: e.stack?.split('\n').slice(0, 5),
      dbg,
    };
  }

  if (games.length === 0) {
    return { status: 'ok', message: 'No more games to snapshot', nextStep: '?phase=compute&force=1', dbg };
  }

  // Dry run: just return what we'd process, no BDL/DB writes.
  if (dryRun) {
    return {
      status: 'ok',
      mode: 'dry-run',
      gamesFound: games.length,
      firstFew: games.slice(0, 3),
      dbg,
    };
  }

  let gamesDone = 0, snapshotsWritten = 0, failed = 0;
  const failLog = [];

  async function processGame(g) {
    const { bdl_game_id: gid, home_alias: hA, away_alias: aA, winner_alias, margin } = g;
    try {
      const resp = await bdlFetch(`/nba/v1/plays?game_id=${gid}&per_page=500`);
      const plays = resp?.data || [];
      if (plays.length === 0) {
        return { ok: false, gid, reason: 'no plays' };
      }

      const snapshots = walkAndSnapshot(plays, hA, aA);
      if (snapshots.length === 0) return { ok: false, gid, reason: 'no snapshots emitted' };

      // Insert snapshots sequentially per game. 8 inserts per game × 8-way
      // game concurrency = 64 total in-flight at peak, not 1,600.
      for (const snap of snapshots) {
        const h = snap.team_stats.home, a = snap.team_stats.away;
        const marginAtSnap = (h.pts || 0) - (a.pts || 0);
        await sql`
          INSERT INTO nba_snapshot_backtest (
            game_id, checkpoint, period, clock_sec,
            home_alias, away_alias, margin_at_snapshot,
            team_stats, pbp_derived,
            ctrl_team_won, final_margin
          )
          VALUES (
            ${gid}, ${snap.checkpoint}, ${snap.period}, ${snap.clockSec},
            ${hA}, ${aA}, ${marginAtSnap},
            ${JSON.stringify(snap.team_stats)},
            ${JSON.stringify(snap.pbp_derived)},
            NULL, ${margin}
          )
          ON CONFLICT (game_id, checkpoint) DO UPDATE SET
            team_stats = EXCLUDED.team_stats,
            pbp_derived = EXCLUDED.pbp_derived,
            margin_at_snapshot = EXCLUDED.margin_at_snapshot
        `;
      }

      return { ok: true, gid, snapshots: snapshots.length };
    } catch (e) {
      return { ok: false, gid, reason: e.message };
    }
  }

  for (let i = 0; i < games.length; i += concurrency) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;
    const slice = games.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(processGame));
    for (const r of results) {
      if (r.ok) { gamesDone++; snapshotsWritten += r.snapshots; }
      else { failed++; if (failLog.length < 10) failLog.push(`${r.gid}: ${r.reason}`); }
    }
  }

  const remaining = await sql`
    SELECT COUNT(*) AS n FROM nba_backtest bt
    LEFT JOIN nba_snapshot_backtest snap
      ON snap.game_id = bt.bdl_game_id AND snap.checkpoint = 'Q4_END'
    WHERE bt.team_stats IS NOT NULL AND bt.game_type = 'regular' AND snap.game_id IS NULL
  `;

  const nextOffset = parseInt(url.searchParams.get('offset') || '0') + games.length;
  const totalGames = await sql`SELECT COUNT(*) AS n FROM nba_backtest WHERE team_stats IS NOT NULL AND game_type = 'regular'`;

  return {
    status: 'ok',
    mode: force ? 'force (re-snapshot all)' : 'normal (only games without snapshots)',
    gamesProcessed: games.length,
    gamesDone,
    snapshotsWritten,
    failed,
    failLog,
    remainingGames: force
      ? Math.max(0, Number(totalGames[0].n) - nextOffset)
      : Number(remaining[0].n),
    elapsedMs: Date.now() - startTime,
    nextStep: force
      ? (nextOffset < Number(totalGames[0].n)
          ? `?phase=snapshot&force=1&n=${batchSize}&c=${concurrency}&offset=${nextOffset}`
          : '?phase=compute&force=1')
      : (remaining[0].n > 0
          ? `?phase=snapshot&n=${batchSize}&c=${concurrency} again`
          : '?phase=compute&force=1'),
  };
}

// ── PHASE: COMPUTE — run indicators + conviction on every snapshot ──────────
async function phaseCompute(sql, url) {
  const startTime = Date.now();
  const TIME_BUDGET_MS = 100000;
  const batchSize = parseInt(url?.searchParams?.get('n') || '500');
  const force = url?.searchParams?.get('force') === '1';

  const rows = force
    ? await sql`
        SELECT game_id, checkpoint, home_alias, away_alias, final_margin,
               team_stats, pbp_derived
        FROM nba_snapshot_backtest
        WHERE team_stats IS NOT NULL AND pbp_derived IS NOT NULL
        ORDER BY game_id, checkpoint
        LIMIT ${batchSize}
      `
    : await sql`
        SELECT game_id, checkpoint, home_alias, away_alias, final_margin,
               team_stats, pbp_derived
        FROM nba_snapshot_backtest
        WHERE team_stats IS NOT NULL AND pbp_derived IS NOT NULL AND indicators IS NULL
        LIMIT ${batchSize}
      `;

  if (rows.length === 0) {
    return { status: 'ok', message: 'Nothing to compute', nextStep: '?phase=report_all' };
  }

  let computed = 0, errors = 0;

  async function computeOne(row) {
    try {
      const ts = typeof row.team_stats === 'string' ? JSON.parse(row.team_stats) : row.team_stats;
      const pd = typeof row.pbp_derived === 'string' ? JSON.parse(row.pbp_derived) : row.pbp_derived;

      const ind = computeServer({
        h: ts.home, a: ts.away, hA: row.home_alias, aA: row.away_alias,
        hPaint: pd.hPaint, aPaint: pd.aPaint,
        hRimM: pd.hRimM, hRimA: pd.hRimA, aRimM: pd.aRimM, aRimA: pd.aRimA,
        hBigLead: pd.hBigLead, aBigLead: pd.aBigLead,
        hPOT: pd.hPOT, aPOT: pd.aPOT,
        runs6: pd.runs6?.detail || [],
        q4hPts: pd.q4hPts, q4aPts: pd.q4aPts,
      });

      if (!ind) return { ok: false, err: 'computeServer returned null' };

      const conv = computeConviction(ind);

      // ctrl_team_won based on FINAL margin (not snapshot margin)
      const homeWonFinal = row.final_margin > 0;
      const ctrlHomeWonFinal = (ind.controlTeam === row.home_alias && homeWonFinal) ||
                                (ind.controlTeam === row.away_alias && !homeWonFinal);

      await sql`
        UPDATE nba_snapshot_backtest
        SET indicators = ${JSON.stringify(ind)},
            conviction = ${JSON.stringify(conv)},
            ctrl_team_won = ${ctrlHomeWonFinal},
            computed_at = NOW()
        WHERE game_id = ${row.game_id} AND checkpoint = ${row.checkpoint}
      `;
      return { ok: true };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  }

  const CONCURRENCY = 20;
  const errLog = [];
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;
    const slice = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map(async (row, idx) => {
      const r = await computeOne(row);
      return { r, row, idx: i + idx };
    }));
    for (const { r, row } of results) {
      if (r.ok) computed++;
      else {
        errors++;
        if (errLog.length < 5) {
          errLog.push({
            game_id: row.game_id,
            checkpoint: row.checkpoint,
            err: r.err,
          });
        }
      }
    }
  }

  const remaining = await sql`
    SELECT COUNT(*) AS n FROM nba_snapshot_backtest
    WHERE team_stats IS NOT NULL AND pbp_derived IS NOT NULL AND indicators IS NULL
  `;

  return {
    status: 'ok',
    computed,
    errors,
    errLog,
    total: rows.length,
    remaining: Number(remaining[0].n),
    elapsedMs: Date.now() - startTime,
    nextStep: remaining[0].n > 0 ? '?phase=compute again' : '?phase=report_all',
  };
}

// ── REPORT: CALIBRATION — bucket snapshots by floor, measure actual win rate ──
async function reportCalibration(sql) {
  // Bucket floor (indicators.score) in 0.05 increments from 0.45 to 1.00
  const rows = await sql`
    SELECT 
      FLOOR((indicators->>'score')::real / 0.05) * 0.05 AS bucket_lo,
      COUNT(*) AS n,
      SUM(CASE WHEN ctrl_team_won THEN 1 ELSE 0 END) AS wins
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND (indicators->>'score')::real >= 0.45
    GROUP BY bucket_lo
    ORDER BY bucket_lo
  `;

  return rows.map(r => ({
    bucket: `${Number(r.bucket_lo).toFixed(2)}–${(Number(r.bucket_lo) + 0.05).toFixed(2)}`,
    n: Number(r.n),
    wins: Number(r.wins),
    actual_pct: Number(r.n) > 0 ? Math.round(Number(r.wins) / Number(r.n) * 1000) / 10 : null,
    predicted_midpoint: Math.round((Number(r.bucket_lo) + 0.025) * 1000) / 10,
    delta: Number(r.n) > 0 ? Math.round((Number(r.wins) / Number(r.n) - (Number(r.bucket_lo) + 0.025)) * 1000) / 10 : null,
  }));
}

// ── REPORT: TIME DECAY — accuracy by checkpoint ─────────────────────────────
async function reportTimeDecay(sql) {
  const rows = await sql`
    SELECT checkpoint, period,
           COUNT(*) AS n,
           SUM(CASE WHEN ctrl_team_won THEN 1 ELSE 0 END) AS wins
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL
    GROUP BY checkpoint, period
    ORDER BY period, checkpoint
  `;

  const byCheckpoint = rows.map(r => ({
    checkpoint: r.checkpoint,
    period: r.period,
    n: Number(r.n),
    wins: Number(r.wins),
    pct: Number(r.n) > 0 ? Math.round(Number(r.wins) / Number(r.n) * 1000) / 10 : null,
  }));

  // Cross-cut by tier within each checkpoint
  const tierRows = await sql`
    SELECT checkpoint, (conviction->>'tier') AS tier,
           COUNT(*) AS n,
           SUM(CASE WHEN ctrl_team_won THEN 1 ELSE 0 END) AS wins
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL
    GROUP BY checkpoint, tier
    ORDER BY checkpoint, tier
  `;

  const byCheckpointTier = {};
  for (const r of tierRows) {
    if (!byCheckpointTier[r.checkpoint]) byCheckpointTier[r.checkpoint] = {};
    byCheckpointTier[r.checkpoint][r.tier] = {
      n: Number(r.n),
      wins: Number(r.wins),
      pct: Number(r.n) > 0 ? Math.round(Number(r.wins) / Number(r.n) * 1000) / 10 : null,
    };
  }

  return { by_checkpoint: byCheckpoint, by_checkpoint_and_tier: byCheckpointTier };
}

// ── REPORT: ALERT SIM — simulate BUY/BWC/WB firing based on snapshot state ──
async function reportAlertSim(sql) {
  const rows = await sql`
    SELECT (indicators->>'score')::real AS floor,
           (conviction->>'tier') AS tier,
           margin_at_snapshot AS margin,
           checkpoint,
           ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL
  `;

  // NOTE: these are structurally-reduced proxies for the production alerts.
  //   BUY      = floor >= 0.65 AND margin <= 0 AND margin >= -15
  //   BWC      = floor >= 0.60 AND margin >= 2  (edge proxy skipped)
  //   WINDOW_BUY = floor >= 0.45 AND margin in [-15, 5]
  // The live production alerts add sust/TP/LS/ML gates we don't have at this layer.
  // Forward win rate = ctrl_team_won given the trigger condition.

  const sim = {
    BUY: { fires: 0, wins: 0 },
    BWC: { fires: 0, wins: 0 },
    WINDOW_BUY: { fires: 0, wins: 0 },
  };

  for (const r of rows) {
    const floor = r.floor;
    const margin = r.margin;
    const won = !!r.ctrl_team_won;

    if (floor >= 0.65 && margin <= 0 && margin >= -15) {
      sim.BUY.fires++; if (won) sim.BUY.wins++;
    }
    if (floor >= 0.60 && margin >= 2) {
      sim.BWC.fires++; if (won) sim.BWC.wins++;
    }
    if (floor >= 0.45 && margin >= -15 && margin <= 5) {
      sim.WINDOW_BUY.fires++; if (won) sim.WINDOW_BUY.wins++;
    }
  }

  const out = {};
  for (const [k, v] of Object.entries(sim)) {
    out[k] = {
      fires: v.fires,
      wins: v.wins,
      accuracy_pct: v.fires > 0 ? Math.round(v.wins / v.fires * 1000) / 10 : null,
    };
  }
  return out;
}

// ── PHASE: REPORT_ALL ───────────────────────────────────────────────────────
async function phaseReportAll(sql) {
  const [calibration, timeDecay, alertSim] = await Promise.all([
    reportCalibration(sql),
    reportTimeDecay(sql),
    reportAlertSim(sql),
  ]);

  const totals = await sql`
    SELECT COUNT(*) AS total_snaps,
           COUNT(DISTINCT game_id) AS games,
           SUM(CASE WHEN ctrl_team_won THEN 1 ELSE 0 END) AS wins
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL
  `;

  return {
    totals: {
      total_snapshots: Number(totals[0].total_snaps),
      total_games: Number(totals[0].games),
      overall_accuracy_pct: Number(totals[0].total_snaps) > 0
        ? Math.round(Number(totals[0].wins) / Number(totals[0].total_snaps) * 1000) / 10
        : null,
    },
    calibration: {
      description: 'Per-0.05 floor bucket: predicted_midpoint is bucket center; delta is (actual - predicted). Positive delta = underconfident; negative = overconfident.',
      buckets: calibration,
    },
    time_decay: timeDecay,
    alert_sim: {
      description: 'Simulated BUY/BWC/WB firing based purely on snapshot floor + margin. Does NOT model sust/TP/LS/ML gates from production.',
      simulations: alertSim,
    },
  };
}

// ── PHASE: STATUS ───────────────────────────────────────────────────────────
async function phaseStatus(sql) {
  const counts = await sql`
    SELECT COUNT(*) AS total,
           COUNT(DISTINCT game_id) AS games,
           COUNT(indicators) AS computed,
           COUNT(*) FILTER (WHERE indicators IS NULL) AS uncomputed
    FROM nba_snapshot_backtest
  `;
  const byCheckpoint = await sql`
    SELECT checkpoint, COUNT(*) AS n, COUNT(indicators) AS computed
    FROM nba_snapshot_backtest
    GROUP BY checkpoint ORDER BY checkpoint
  `;
  const sourceGames = await sql`SELECT COUNT(*) AS n FROM nba_backtest WHERE team_stats IS NOT NULL AND game_type = 'regular'`;

  return {
    source_games_available: Number(sourceGames[0].n),
    total_snapshots: Number(counts[0].total),
    games_snapshotted: Number(counts[0].games),
    computed: Number(counts[0].computed),
    uncomputed: Number(counts[0].uncomputed),
    by_checkpoint: byCheckpoint.map(r => ({
      checkpoint: r.checkpoint,
      snapshots: Number(r.n),
      computed: Number(r.computed),
    })),
  };
}

// ── PHASE: INSPECT — show all snapshots for one game ────────────────────────
async function phaseInspect(sql, url) {
  const gid = url?.searchParams?.get('gid');
  if (!gid) return { error: 'Provide ?gid=...' };

  const snapshots = await sql`
    SELECT checkpoint, period, clock_sec, margin_at_snapshot,
           team_stats, pbp_derived, indicators, conviction, ctrl_team_won, final_margin
    FROM nba_snapshot_backtest
    WHERE game_id = ${gid}
    ORDER BY period, clock_sec DESC
  `;

  if (snapshots.length === 0) return { error: 'No snapshots for this game' };

  return {
    gid,
    snapshots: snapshots.map(s => ({
      checkpoint: s.checkpoint,
      period: s.period,
      clock_sec: s.clock_sec,
      margin_at_snapshot: s.margin_at_snapshot,
      final_margin: s.final_margin,
      floor: s.indicators?.score,
      composite: s.indicators?.composite,
      control_team: s.indicators?.controlTeam,
      tier: s.conviction?.tier,
      combo: s.conviction?.combo,
      indicators: { I1: s.indicators?.I1, I2: s.indicators?.I2, I3: s.indicators?.I3, I4: s.indicators?.I4, I5: s.indicators?.I5 },
      ctrl_team_won: s.ctrl_team_won,
      // Dense stats for sanity check
      hPts: s.team_stats?.home?.pts, aPts: s.team_stats?.away?.pts,
      hBigLead: s.pbp_derived?.hBigLead, aBigLead: s.pbp_derived?.aBigLead,
      hPaint: s.pbp_derived?.hPaint, aPaint: s.pbp_derived?.aPaint,
      runs6_total: s.pbp_derived?.runs6?.total,
    })),
  };
}

// ── HANDLER ─────────────────────────────────────────────────────────────────
export default async (req) => {
  const sql = neon(process.env.DATABASE_URL);
  const url = new URL(req.url);
  const phase = url.searchParams.get('phase') || 'status';

  try {
    let result;
    switch (phase) {
      case 'init':              result = await phaseInit(sql, url); break;
      case 'snapshot':          result = await phaseSnapshot(sql, url); break;
      case 'compute':           result = await phaseCompute(sql, url); break;
      case 'report_calibration': result = { calibration: await reportCalibration(sql) }; break;
      case 'report_time':       result = await reportTimeDecay(sql); break;
      case 'report_alert_sim':  result = await reportAlertSim(sql); break;
      case 'report_all':        result = await phaseReportAll(sql); break;
      case 'status':            result = await phaseStatus(sql); break;
      case 'inspect':           result = await phaseInspect(sql, url); break;
      default:
        result = { error: `Unknown phase: ${phase}. Use init, snapshot, compute, report_all, report_calibration, report_time, report_alert_sim, status, inspect.` };
    }
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack?.split('\n').slice(0, 5) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/backtest-nba-snapshots' };

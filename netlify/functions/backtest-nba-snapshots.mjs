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

// Fetch ALL plays for a game. Try per_page=500 first (BDL NBA plays
// accepts this despite spec saying max 100). Only paginate via next_cursor
// if the response indicates more pages exist.
async function bdlFetchAllPlays(gid) {
  // First request: grab as many as possible in one shot
  const first = await bdlFetch(`/nba/v1/plays?game_id=${gid}&per_page=500`);
  const allPlays = first?.data || [];
  let cursor = first?.meta?.next_cursor;

  // If there's no next_cursor, we got everything (vast majority of games)
  if (!cursor) return allPlays;

  // Rare case: >500 plays (OT games, high-event games). Follow cursor.
  const MAX_EXTRA_PAGES = 10;
  for (let page = 0; page < MAX_EXTRA_PAGES; page++) {
    const resp = await bdlFetch(`/nba/v1/plays?game_id=${gid}&per_page=500&cursor=${cursor}`);
    const plays = resp?.data || [];
    allPlays.push(...plays);
    cursor = resp?.meta?.next_cursor;
    if (!cursor || plays.length === 0) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return allPlays;
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
      const plays = await bdlFetchAllPlays(gid);
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

        // Compute ctrl_team_won at snapshot time so it's never NULL.
        // We need indicators to know which team controls — but indicators
        // aren't computed yet in the snapshot phase. We'll set it during
        // the compute phase instead. Set to NULL here, compute fills it.
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
            margin_at_snapshot = EXCLUDED.margin_at_snapshot,
            indicators = NULL,
            conviction = NULL,
            ctrl_team_won = NULL,
            computed_at = NULL
        `;
      }

      return { ok: true, gid, snapshots: snapshots.length, plays: plays.length };
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

  let computed = 0, errors = 0, noData = 0;

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

      if (!ind) {
        // Zero-state snapshot (BDL missing PBP for this period).
        // Mark as computed with no_data flag so it doesn't block future runs.
        await sql`
          UPDATE nba_snapshot_backtest
          SET indicators = ${JSON.stringify({ no_data: true })},
              conviction = ${JSON.stringify({ tier: 'NO_DATA', combo: 'NONE' })},
              ctrl_team_won = NULL,
              computed_at = NOW()
          WHERE game_id = ${row.game_id} AND checkpoint = ${row.checkpoint}
        `;
        return { ok: true, no_data: true };
      }

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

  const CONCURRENCY = Math.min(parseInt(url?.searchParams?.get('c') || '5'), 20);
  const errLog = [];
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;
    const slice = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map(async (row, idx) => {
      const r = await computeOne(row);
      return { r, row, idx: i + idx };
    }));
    for (const { r, row } of results) {
      if (r.ok) { computed++; if (r.no_data) noData++; }
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
    noData,
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
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
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
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
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
           indicators->>'controlTeam' AS ctrl,
           home_alias,
           checkpoint,
           ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;

  // NOTE: these are structurally-reduced proxies for the production alerts.
  //   BUY      = floor >= 0.65 AND ctrl trailing 1-15
  //   BWC      = floor >= 0.60 AND ctrl leading 2+  (edge proxy skipped)
  //   WINDOW_BUY = floor >= 0.45 AND ctrlMargin in [-15, 5]
  // margin_at_snapshot is HOME-RELATIVE. Must convert to ctrl-relative.

  const sim = {
    BUY: { fires: 0, wins: 0 },
    BWC: { fires: 0, wins: 0 },
    WINDOW_BUY: { fires: 0, wins: 0 },
  };

  for (const r of rows) {
    const floor = r.floor;
    const ctrlHome = r.ctrl === r.home_alias;
    const ctrlMargin = ctrlHome ? r.margin : -r.margin;
    const won = !!r.ctrl_team_won;

    if (floor >= 0.65 && ctrlMargin <= 0 && ctrlMargin >= -15) {
      sim.BUY.fires++; if (won) sim.BUY.wins++;
    }
    if (floor >= 0.60 && ctrlMargin >= 2) {
      sim.BWC.fires++; if (won) sim.BWC.wins++;
    }
    if (floor >= 0.45 && ctrlMargin >= -15 && ctrlMargin <= 5) {
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

// ── REPORT: INDICATORS — per-indicator win rate by checkpoint ────────────────
async function reportIndicators(sql) {
  // Pull all computed snapshots with real data
  const rows = await sql`
    SELECT checkpoint, indicators, ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;

  // For each indicator, bucket by value (0, 0.5, 1) relative to ctrl team
  const indicators = ['I1', 'I2', 'I3', 'I4', 'I5'];
  const checkpoints = ['Q1_6', 'Q1_END', 'Q2_6', 'Q2_END', 'Q3_6', 'Q3_END', 'Q4_6', 'Q4_END'];

  // Per-indicator overall (all checkpoints)
  const byIndicator = {};
  for (const ind of indicators) {
    byIndicator[ind] = { won: { n: 0, wins: 0 }, even: { n: 0, wins: 0 }, lost: { n: 0, wins: 0 } };
  }

  // Per-indicator × checkpoint
  const byIndicatorCheckpoint = {};
  for (const ind of indicators) {
    byIndicatorCheckpoint[ind] = {};
    for (const cp of checkpoints) {
      byIndicatorCheckpoint[ind][cp] = { won: { n: 0, wins: 0 }, even: { n: 0, wins: 0 }, lost: { n: 0, wins: 0 } };
    }
  }

  for (const row of rows) {
    const data = typeof row.indicators === 'string' ? JSON.parse(row.indicators) : row.indicators;
    const won = !!row.ctrl_team_won;
    const ctrlHome = data.controlTeam === data.homeAlias;

    for (const ind of indicators) {
      const raw = data[ind];
      if (raw == null) continue;
      // Convert to ctrl-team-relative
      const val = ctrlHome ? raw : 1 - raw;
      const bucket = val === 1 ? 'won' : val === 0 ? 'lost' : 'even';

      byIndicator[ind][bucket].n++;
      if (won) byIndicator[ind][bucket].wins++;

      if (byIndicatorCheckpoint[ind][row.checkpoint]) {
        byIndicatorCheckpoint[ind][row.checkpoint][bucket].n++;
        if (won) byIndicatorCheckpoint[ind][row.checkpoint][bucket].wins++;
      }
    }
  }

  // Format output
  const summary = {};
  for (const ind of indicators) {
    summary[ind] = {};
    for (const b of ['won', 'even', 'lost']) {
      const d = byIndicator[ind][b];
      summary[ind][b] = { n: d.n, wins: d.wins, pct: d.n > 0 ? Math.round(d.wins / d.n * 1000) / 10 : null };
    }
  }

  const byCheckpoint = {};
  for (const ind of indicators) {
    byCheckpoint[ind] = {};
    for (const cp of checkpoints) {
      byCheckpoint[ind][cp] = {};
      for (const b of ['won', 'even', 'lost']) {
        const d = byIndicatorCheckpoint[ind][cp][b];
        byCheckpoint[ind][cp][b] = { n: d.n, wins: d.wins, pct: d.n > 0 ? Math.round(d.wins / d.n * 1000) / 10 : null };
      }
    }
  }

  return { summary, by_checkpoint: byCheckpoint };
}

// ── REPORT: COMBOS — indicator combo win rate by checkpoint ──────────────────
async function reportCombos(sql) {
  const rows = await sql`
    SELECT checkpoint, indicators, conviction, ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;

  const comboCounts = {};  // combo string → { n, wins, by_checkpoint: { cp → {n, wins} } }
  const pairCounts = {};   // pair string → { n, wins, by_checkpoint }
  const checkpoints = ['Q1_6', 'Q1_END', 'Q2_6', 'Q2_END', 'Q3_6', 'Q3_END', 'Q4_6', 'Q4_END'];
  const indicators = ['I1', 'I2', 'I3', 'I4', 'I5'];

  for (const row of rows) {
    const data = typeof row.indicators === 'string' ? JSON.parse(row.indicators) : row.indicators;
    const conv = typeof row.conviction === 'string' ? JSON.parse(row.conviction) : row.conviction;
    const won = !!row.ctrl_team_won;
    const ctrlHome = data.controlTeam === data.homeAlias;

    // Determine which indicators ctrl team won
    const wonInds = [];
    for (const ind of indicators) {
      const raw = data[ind];
      if (raw == null) continue;
      const val = ctrlHome ? raw : 1 - raw;
      if (val === 1) wonInds.push(ind);
    }

    const combo = wonInds.length > 0 ? wonInds.join('+') : 'NONE';

    // Track combo
    if (!comboCounts[combo]) {
      comboCounts[combo] = { n: 0, wins: 0, by_checkpoint: {} };
      for (const cp of checkpoints) comboCounts[combo].by_checkpoint[cp] = { n: 0, wins: 0 };
    }
    comboCounts[combo].n++;
    if (won) comboCounts[combo].wins++;
    if (comboCounts[combo].by_checkpoint[row.checkpoint]) {
      comboCounts[combo].by_checkpoint[row.checkpoint].n++;
      if (won) comboCounts[combo].by_checkpoint[row.checkpoint].wins++;
    }

    // Track pairs
    for (let i = 0; i < wonInds.length; i++) {
      for (let j = i + 1; j < wonInds.length; j++) {
        const pair = `${wonInds[i]}+${wonInds[j]}`;
        if (!pairCounts[pair]) {
          pairCounts[pair] = { n: 0, wins: 0, by_checkpoint: {} };
          for (const cp of checkpoints) pairCounts[pair].by_checkpoint[cp] = { n: 0, wins: 0 };
        }
        pairCounts[pair].n++;
        if (won) pairCounts[pair].wins++;
        if (pairCounts[pair].by_checkpoint[row.checkpoint]) {
          pairCounts[pair].by_checkpoint[row.checkpoint].n++;
          if (won) pairCounts[pair].by_checkpoint[row.checkpoint].wins++;
        }
      }
    }
  }

  // Format: sort by frequency, add pct
  const formatGroup = (counts) => {
    return Object.entries(counts)
      .sort((a, b) => b[1].n - a[1].n)
      .map(([k, v]) => ({
        combo: k,
        n: v.n,
        wins: v.wins,
        pct: v.n > 0 ? Math.round(v.wins / v.n * 1000) / 10 : null,
        by_checkpoint: Object.fromEntries(
          Object.entries(v.by_checkpoint)
            .filter(([, d]) => d.n > 0)
            .map(([cp, d]) => [cp, { n: d.n, wins: d.wins, pct: Math.round(d.wins / d.n * 1000) / 10 }])
        ),
      }));
  };

  return {
    combos: formatGroup(comboCounts),
    pairs: formatGroup(pairCounts),
  };
}

// ── REPORT: ALERT SIM BY CHECKPOINT — BUY/BWC/WB win rate per checkpoint ────
async function reportAlertSimByCheckpoint(sql) {
  const rows = await sql`
    SELECT (indicators->>'score')::real AS floor,
           margin_at_snapshot AS margin,
           indicators->>'controlTeam' AS ctrl,
           home_alias,
           checkpoint,
           ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;

  const checkpoints = ['Q1_6', 'Q1_END', 'Q2_6', 'Q2_END', 'Q3_6', 'Q3_END', 'Q4_6', 'Q4_END'];
  const types = ['BUY', 'BWC', 'WINDOW_BUY'];
  const result = {};
  for (const t of types) {
    result[t] = {};
    for (const cp of checkpoints) result[t][cp] = { fires: 0, wins: 0 };
  }

  for (const r of rows) {
    const floor = r.floor, won = !!r.ctrl_team_won, cp = r.checkpoint;
    const ctrlHome = r.ctrl === r.home_alias;
    const ctrlMargin = ctrlHome ? r.margin : -r.margin;

    if (floor >= 0.65 && ctrlMargin <= 0 && ctrlMargin >= -15) {
      result.BUY[cp].fires++; if (won) result.BUY[cp].wins++;
    }
    if (floor >= 0.60 && ctrlMargin >= 2) {
      result.BWC[cp].fires++; if (won) result.BWC[cp].wins++;
    }
    if (floor >= 0.45 && ctrlMargin >= -15 && ctrlMargin <= 5) {
      result.WINDOW_BUY[cp].fires++; if (won) result.WINDOW_BUY[cp].wins++;
    }
  }

  // Add pct
  for (const t of types) {
    for (const cp of checkpoints) {
      const d = result[t][cp];
      d.pct = d.fires > 0 ? Math.round(d.wins / d.fires * 1000) / 10 : null;
    }
  }
  return result;
}

// ── REPORT: STABILITY — control team flips between checkpoints ──────────────
async function reportStability(sql) {
  const rows = await sql`
    SELECT game_id, checkpoint, indicators->>'controlTeam' AS ctrl,
           (indicators->>'score')::real AS floor, ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  const checkpoints = ['Q1_6', 'Q1_END', 'Q2_6', 'Q2_END', 'Q3_6', 'Q3_END', 'Q4_6', 'Q4_END'];

  // Group by game
  const games = {};
  for (const r of rows) {
    if (!games[r.game_id]) games[r.game_id] = {};
    games[r.game_id][r.checkpoint] = { ctrl: r.ctrl, floor: r.floor, won: r.ctrl_team_won };
  }

  // Count flips between adjacent checkpoints
  const flipStats = {};
  for (let i = 1; i < checkpoints.length; i++) {
    const from = checkpoints[i - 1], to = checkpoints[i];
    const key = `${from}→${to}`;
    flipStats[key] = { total: 0, flips: 0, flipWins: 0, holdWins: 0, holdTotal: 0 };
  }

  // Track longest controller per game
  const longestCtrl = { wins: 0, losses: 0, total: 0, ties: 0 };

  for (const [gid, cps] of Object.entries(games)) {
    // Flips
    for (let i = 1; i < checkpoints.length; i++) {
      const from = checkpoints[i - 1], to = checkpoints[i];
      const key = `${from}→${to}`;
      const a = cps[from], b = cps[to];
      if (!a || !b) continue;
      flipStats[key].total++;
      if (a.ctrl !== b.ctrl) {
        flipStats[key].flips++;
        if (b.won) flipStats[key].flipWins++;
      } else {
        flipStats[key].holdTotal++;
        if (b.won) flipStats[key].holdWins++;
      }
    }

    // Longest controller: count checkpoints per team
    const teamCounts = {};
    let lastWon = null;
    for (const cp of checkpoints) {
      const d = cps[cp];
      if (!d || !d.ctrl) continue;
      teamCounts[d.ctrl] = (teamCounts[d.ctrl] || 0) + 1;
      lastWon = d.won;
    }
    const teams = Object.entries(teamCounts).sort((a, b) => b[1] - a[1]);
    if (teams.length === 0) continue;
    longestCtrl.total++;

    if (teams.length >= 2 && teams[0][1] === teams[1][1]) {
      longestCtrl.ties++;
    } else {
      // Did the longest controller win?
      const longestTeam = teams[0][0];
      const q4end = cps['Q4_END'];
      if (q4end) {
        // ctrl_team_won is relative to Q4_END ctrl team — we need to check
        // if longestTeam === Q4_END ctrl team and Q4_END.won, OR
        // longestTeam !== Q4_END ctrl team and !Q4_END.won
        const longestWon = (longestTeam === q4end.ctrl && q4end.won) ||
                           (longestTeam !== q4end.ctrl && !q4end.won);
        if (longestWon) longestCtrl.wins++;
        else longestCtrl.losses++;
      }
    }
  }

  // Format flips
  const transitions = {};
  for (const [key, d] of Object.entries(flipStats)) {
    transitions[key] = {
      total: d.total,
      flips: d.flips,
      flip_pct: d.total > 0 ? Math.round(d.flips / d.total * 1000) / 10 : null,
      flip_new_ctrl_wins_pct: d.flips > 0 ? Math.round(d.flipWins / d.flips * 1000) / 10 : null,
      hold_wins_pct: d.holdTotal > 0 ? Math.round(d.holdWins / d.holdTotal * 1000) / 10 : null,
    };
  }

  longestCtrl.win_pct = (longestCtrl.total - longestCtrl.ties) > 0
    ? Math.round(longestCtrl.wins / (longestCtrl.total - longestCtrl.ties) * 1000) / 10 : null;

  return { transitions, longest_controller: longestCtrl };
}

// ── REPORT: MARGIN × FLOOR — win rate by floor bucket AND margin bucket ─────
async function reportMarginFloor(sql) {
  const rows = await sql`
    SELECT (indicators->>'score')::real AS floor,
           margin_at_snapshot AS margin,
           indicators->>'controlTeam' AS ctrl,
           home_alias,
           ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;

  // Floor buckets: 0.50-0.60, 0.60-0.70, 0.70-0.80, 0.80-0.90, 0.90+
  // Margin buckets (from ctrl team perspective): trailing 10+, trailing 5-9,
  //   trailing 1-4, tied/close (0-2), leading 3-7, leading 8+
  const floorBuckets = [
    { label: '0.50-0.60', lo: 0.50, hi: 0.60 },
    { label: '0.60-0.70', lo: 0.60, hi: 0.70 },
    { label: '0.70-0.80', lo: 0.70, hi: 0.80 },
    { label: '0.80-0.90', lo: 0.80, hi: 0.90 },
    { label: '0.90+', lo: 0.90, hi: 2.0 },
  ];
  const marginBuckets = [
    { label: 'trailing 10+', test: m => m <= -10 },
    { label: 'trailing 5-9', test: m => m >= -9 && m <= -5 },
    { label: 'trailing 1-4', test: m => m >= -4 && m <= -1 },
    { label: 'tied/close 0-2', test: m => m >= 0 && m <= 2 },
    { label: 'leading 3-7', test: m => m >= 3 && m <= 7 },
    { label: 'leading 8+', test: m => m >= 8 },
  ];

  const grid = {};
  for (const fb of floorBuckets) {
    grid[fb.label] = {};
    for (const mb of marginBuckets) {
      grid[fb.label][mb.label] = { n: 0, wins: 0 };
    }
  }

  for (const r of rows) {
    const floor = r.floor;
    const won = !!r.ctrl_team_won;
    const ctrlHome = r.ctrl === r.home_alias;
    const ctrlMargin = ctrlHome ? r.margin : -r.margin;

    for (const fb of floorBuckets) {
      if (floor >= fb.lo && floor < fb.hi) {
        for (const mb of marginBuckets) {
          if (mb.test(ctrlMargin)) {
            grid[fb.label][mb.label].n++;
            if (won) grid[fb.label][mb.label].wins++;
            break;
          }
        }
        break;
      }
    }
  }

  // Add pct
  for (const fb of floorBuckets) {
    for (const mb of marginBuckets) {
      const d = grid[fb.label][mb.label];
      d.pct = d.n > 0 ? Math.round(d.wins / d.n * 1000) / 10 : null;
    }
  }

  return {
    description: 'Ctrl-relative margin × floor grid. Negative = ctrl team trailing. Positive = ctrl team leading.',
    grid,
  };
}

// ── REPORT: FLOOR VELOCITY — floor change between adjacent checkpoints ──────
async function reportFloorVelocity(sql) {
  const rows = await sql`
    SELECT game_id, checkpoint, (indicators->>'score')::real AS floor, ctrl_team_won,
           indicators->>'controlTeam' AS ctrl
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  const checkpoints = ['Q1_6', 'Q1_END', 'Q2_6', 'Q2_END', 'Q3_6', 'Q3_END', 'Q4_6', 'Q4_END'];

  // Group by game
  const games = {};
  for (const r of rows) {
    if (!games[r.game_id]) games[r.game_id] = {};
    games[r.game_id][r.checkpoint] = { floor: r.floor, ctrl: r.ctrl, won: r.ctrl_team_won };
  }

  // Velocity buckets: floor change between adjacent checkpoints
  // Only meaningful when ctrl team stays the same (no flip)
  const velocityBuckets = [
    { label: 'crash (≤-0.15)', test: d => d <= -0.15 },
    { label: 'decline (-0.15 to -0.05)', test: d => d > -0.15 && d <= -0.05 },
    { label: 'stable (-0.05 to +0.05)', test: d => d > -0.05 && d < 0.05 },
    { label: 'rising (+0.05 to +0.15)', test: d => d >= 0.05 && d < 0.15 },
    { label: 'surge (≥+0.15)', test: d => d >= 0.15 },
  ];

  const results = {};
  for (let i = 1; i < checkpoints.length; i++) {
    const from = checkpoints[i - 1], to = checkpoints[i];
    const key = `${from}→${to}`;
    results[key] = {};
    for (const vb of velocityBuckets) results[key][vb.label] = { n: 0, wins: 0 };
  }

  // Peak-to-end analysis: max floor during game vs Q4_END
  const peakDrops = [
    { label: 'no drop (peak at end)', test: d => d >= 0 },
    { label: 'minor drop (0 to -0.10)', test: d => d < 0 && d >= -0.10 },
    { label: 'moderate drop (-0.10 to -0.25)', test: d => d < -0.10 && d >= -0.25 },
    { label: 'collapse (< -0.25)', test: d => d < -0.25 },
  ];
  const peakToEnd = {};
  for (const pb of peakDrops) peakToEnd[pb.label] = { n: 0, wins: 0 };

  for (const [gid, cps] of Object.entries(games)) {
    // Adjacent velocity
    for (let i = 1; i < checkpoints.length; i++) {
      const from = checkpoints[i - 1], to = checkpoints[i];
      const key = `${from}→${to}`;
      const a = cps[from], b = cps[to];
      if (!a || !b) continue;
      // Only count same-ctrl transitions (flips handled in stability report)
      if (a.ctrl !== b.ctrl) continue;
      const delta = b.floor - a.floor;
      for (const vb of velocityBuckets) {
        if (vb.test(delta)) {
          results[key][vb.label].n++;
          if (b.won) results[key][vb.label].wins++;
          break;
        }
      }
    }

    // Peak to end
    let peakFloor = 0;
    for (const cp of checkpoints) {
      if (cps[cp] && cps[cp].floor > peakFloor) peakFloor = cps[cp].floor;
    }
    const endData = cps['Q4_END'];
    if (endData && peakFloor > 0) {
      const drop = endData.floor - peakFloor;
      for (const pb of peakDrops) {
        if (pb.test(drop)) {
          peakToEnd[pb.label].n++;
          if (endData.won) peakToEnd[pb.label].wins++;
          break;
        }
      }
    }
  }

  // Add pct
  for (const key of Object.keys(results)) {
    for (const vb of velocityBuckets) {
      const d = results[key][vb.label];
      d.pct = d.n > 0 ? Math.round(d.wins / d.n * 1000) / 10 : null;
    }
  }
  for (const pb of peakDrops) {
    const d = peakToEnd[pb.label];
    d.pct = d.n > 0 ? Math.round(d.wins / d.n * 1000) / 10 : null;
  }

  return {
    adjacent_velocity: results,
    peak_to_end: {
      description: 'Max floor across all checkpoints vs Q4_END floor. Shows how often floor crashes predict losses.',
      buckets: peakToEnd,
    },
  };
}

// ── REPORT: LOSING ALERT AUTOPSY — profile BUY failures ─────────────────────
async function reportLosingAutopsy(sql) {
  const rows = await sql`
    SELECT game_id, checkpoint, margin_at_snapshot AS margin,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl,
           home_alias,
           indicators->>'I1' AS i1, indicators->>'I2' AS i2,
           indicators->>'I3' AS i3, indicators->>'I4' AS i4, indicators->>'I5' AS i5,
           (conviction->>'tier') AS tier, (conviction->>'combo') AS combo,
           (conviction->>'count')::int AS ind_count,
           ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;

  // BUY condition: floor >= 0.65, ctrl trailing 1-15 (ctrl-relative margin)
  const buyAlerts = rows.filter(r => {
    const ctrlHome = r.ctrl === r.home_alias;
    const ctrlMargin = ctrlHome ? r.margin : -r.margin;
    return r.floor >= 0.65 && ctrlMargin <= 0 && ctrlMargin >= -15;
  });
  const winners = buyAlerts.filter(r => r.ctrl_team_won);
  const losers = buyAlerts.filter(r => !r.ctrl_team_won);

  function profileGroup(group) {
    if (group.length === 0) return {};
    const tiers = {}, deficits = {}, i4status = { won: 0, even: 0, lost: 0 }, indCounts = {};
    let floorSum = 0;
    for (const r of group) {
      // Tier
      tiers[r.tier] = (tiers[r.tier] || 0) + 1;
      // Deficit bucket — ctrl-relative
      const ctrlHome = r.ctrl === r.home_alias;
      const ctrlMargin = ctrlHome ? r.margin : -r.margin;
      const absM = Math.abs(ctrlMargin);
      const db = absM >= 10 ? 'trail_10+' : absM >= 5 ? 'trail_5-9' : 'trail_1-4';
      deficits[db] = (deficits[db] || 0) + 1;
      // I4 — ctrl-relative
      const i4raw = parseFloat(r.i4);
      const ctrlI4 = ctrlHome ? i4raw : 1 - i4raw;
      if (ctrlI4 === 1) i4status.won++;
      else if (ctrlI4 === 0) i4status.lost++;
      else i4status.even++;
      // Indicator count
      const ic = r.ind_count || 0;
      indCounts[ic] = (indCounts[ic] || 0) + 1;
      floorSum += r.floor;
    }
    return {
      n: group.length,
      avg_floor: Math.round(floorSum / group.length * 100) / 100,
      tiers: Object.fromEntries(Object.entries(tiers).sort((a,b) => b[1]-a[1]).map(([k,v]) => [k, { n: v, pct: Math.round(v/group.length*1000)/10 }])),
      deficit_buckets: deficits,
      i4_ctrl_status: i4status,
      indicator_counts: Object.fromEntries(Object.entries(indCounts).sort((a,b) => Number(a[0])-Number(b[0])).map(([k,v]) => [k, { n: v, pct: Math.round(v/group.length*1000)/10 }])),
    };
  }

  // By checkpoint
  const checkpoints = ['Q1_6','Q1_END','Q2_6','Q2_END','Q3_6','Q3_END','Q4_6','Q4_END'];
  const byCheckpoint = {};
  for (const cp of checkpoints) {
    const cpLosers = losers.filter(r => r.checkpoint === cp);
    const cpAll = buyAlerts.filter(r => r.checkpoint === cp);
    byCheckpoint[cp] = { total_buys: cpAll.length, losers: cpLosers.length, loser_pct: cpAll.length > 0 ? Math.round(cpLosers.length/cpAll.length*1000)/10 : null };
  }

  return {
    total_buy_alerts: buyAlerts.length,
    winners: profileGroup(winners),
    losers: profileGroup(losers),
    by_checkpoint: byCheckpoint,
  };
}

// ── REPORT: CONVICTION × DEFICIT DEPTH ──────────────────────────────────────
async function reportConvictionDeficit(sql) {
  const rows = await sql`
    SELECT margin_at_snapshot AS margin,
           (conviction->>'tier') AS tier,
           indicators->>'controlTeam' AS ctrl,
           home_alias,
           ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;

  const tiers = ['DOMINANT','STRONG','MODEST','CONDITIONAL','NO ENTRY'];
  const deficits = [
    { label: 'trailing 10+', test: m => m <= -10 },
    { label: 'trailing 5-9', test: m => m >= -9 && m <= -5 },
    { label: 'trailing 1-4', test: m => m >= -4 && m <= -1 },
    { label: 'tied 0-2', test: m => m >= 0 && m <= 2 },
    { label: 'leading 3-7', test: m => m >= 3 && m <= 7 },
    { label: 'leading 8+', test: m => m >= 8 },
  ];

  const grid = {};
  for (const t of tiers) {
    grid[t] = {};
    for (const d of deficits) grid[t][d.label] = { n: 0, wins: 0 };
  }

  for (const r of rows) {
    const t = r.tier;
    if (!grid[t]) continue;
    const ctrlHome = r.ctrl === r.home_alias;
    const ctrlMargin = ctrlHome ? r.margin : -r.margin;
    for (const d of deficits) {
      if (d.test(ctrlMargin)) {
        grid[t][d.label].n++;
        if (r.ctrl_team_won) grid[t][d.label].wins++;
        break;
      }
    }
  }

  for (const t of tiers) {
    for (const d of deficits) {
      const v = grid[t][d.label];
      v.pct = v.n > 0 ? Math.round(v.wins / v.n * 1000) / 10 : null;
    }
  }

  return { description: 'Ctrl-relative margin. Conviction tier × deficit depth.', grid };
}

// ── REPORT: I4 SUB-COMPONENT SPLIT ──────────────────────────────────────────
async function reportI4Split(sql) {
  const rows = await sql`
    SELECT checkpoint, pbp_derived, indicators, ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
      AND pbp_derived IS NOT NULL
  `;

  const checkpoints = ['Q1_6','Q1_END','Q2_6','Q2_END','Q3_6','Q3_END','Q4_6','Q4_END'];
  // subA = biggest_lead gap (±4), subB = Q4 scoring diff (±2)
  // Re-derive from pbp_derived
  const combos = {}; // 'A+B+' → {n, wins} etc
  const byCheckpoint = {};
  for (const cp of checkpoints) byCheckpoint[cp] = {};

  for (const r of rows) {
    const pd = typeof r.pbp_derived === 'string' ? JSON.parse(r.pbp_derived) : r.pbp_derived;
    const ind = typeof r.indicators === 'string' ? JSON.parse(r.indicators) : r.indicators;
    if (!pd || !ind || ind.score == null) continue;

    const hBL = pd.hBigLead || 0, aBL = pd.aBigLead || 0;
    const blDiff = hBL - aBL;
    const subA = blDiff > 4 ? 1 : blDiff < -4 ? -1 : 0;

    const q4h = pd.q4hPts, q4a = pd.q4aPts;
    let subB = 0;
    if (q4h != null && q4a != null) {
      const q4diff = q4h - q4a;
      subB = q4diff > 2 ? 1 : q4diff < -2 ? -1 : 0;
    }

    // Convert to labels
    const aLabel = subA > 0 ? 'A_home' : subA < 0 ? 'A_away' : 'A_even';
    const bLabel = subB > 0 ? 'B_home' : subB < 0 ? 'B_away' : 'B_even';
    const key = `${aLabel}|${bLabel}`;
    const won = !!r.ctrl_team_won;

    if (!combos[key]) combos[key] = { n: 0, wins: 0 };
    combos[key].n++;
    if (won) combos[key].wins++;

    if (!byCheckpoint[r.checkpoint][key]) byCheckpoint[r.checkpoint][key] = { n: 0, wins: 0 };
    byCheckpoint[r.checkpoint][key].n++;
    if (won) byCheckpoint[r.checkpoint][key].wins++;
  }

  // Format
  const formatted = Object.entries(combos)
    .sort((a,b) => b[1].n - a[1].n)
    .map(([k,v]) => ({
      combo: k,
      n: v.n,
      wins: v.wins,
      pct: v.n > 0 ? Math.round(v.wins/v.n*1000)/10 : null,
    }));

  // Key question: when subA and subB disagree, what happens?
  const agreement = { agree: { n: 0, wins: 0 }, disagree: { n: 0, wins: 0 }, mixed: { n: 0, wins: 0 } };
  for (const [k, v] of Object.entries(combos)) {
    const [a, b] = k.split('|');
    const aDir = a.includes('home') ? 1 : a.includes('away') ? -1 : 0;
    const bDir = b.includes('home') ? 1 : b.includes('away') ? -1 : 0;
    if (aDir !== 0 && bDir !== 0 && aDir === bDir) { agreement.agree.n += v.n; agreement.agree.wins += v.wins; }
    else if (aDir !== 0 && bDir !== 0 && aDir !== bDir) { agreement.disagree.n += v.n; agreement.disagree.wins += v.wins; }
    else { agreement.mixed.n += v.n; agreement.mixed.wins += v.wins; }
  }
  for (const v of Object.values(agreement)) {
    v.pct = v.n > 0 ? Math.round(v.wins/v.n*1000)/10 : null;
  }

  return {
    description: 'I4 subA = biggest_lead gap (±4 threshold). I4 subB = Q4 scoring diff (±2). Home-relative. Agreement = both favor same side.',
    all_combos: formatted,
    agreement_analysis: agreement,
  };
}

// ── REPORT: VELOCITY AT ALERT TIME ──────────────────────────────────────────
async function reportVelocityAtAlert(sql) {
  const rows = await sql`
    SELECT game_id, checkpoint, (indicators->>'score')::real AS floor,
           margin_at_snapshot AS margin,
           indicators->>'controlTeam' AS ctrl, home_alias, ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  const checkpoints = ['Q1_6','Q1_END','Q2_6','Q2_END','Q3_6','Q3_END','Q4_6','Q4_END'];
  const games = {};
  for (const r of rows) {
    if (!games[r.game_id]) games[r.game_id] = {};
    games[r.game_id][r.checkpoint] = r;
  }

  const velocityBuckets = [
    { label: 'crashing (3+ declining)', test: v => v <= -3 },
    { label: 'declining (1-2 declining)', test: v => v >= -2 && v <= -1 },
    { label: 'stable/new', test: v => v === 0 },
    { label: 'rising (1-2 rising)', test: v => v >= 1 && v <= 2 },
    { label: 'surging (3+ rising)', test: v => v >= 3 },
  ];

  // For each snapshot that meets BUY conditions, compute "velocity score":
  // count how many of the last 3 checkpoints had rising vs declining floor (same ctrl)
  const result = {};
  for (const vb of velocityBuckets) result[vb.label] = { n: 0, wins: 0 };

  for (const [gid, cps] of Object.entries(games)) {
    for (let i = 0; i < checkpoints.length; i++) {
      const cp = checkpoints[i];
      const snap = cps[cp];
      if (!snap) continue;
      const ctrlHome = snap.ctrl === snap.home_alias;
      const ctrlMargin = ctrlHome ? snap.margin : -snap.margin;
      if (!(snap.floor >= 0.65 && ctrlMargin <= 0 && ctrlMargin >= -15)) continue;

      // Compute velocity: look back up to 3 checkpoints
      let velocityScore = 0;
      for (let j = 1; j <= Math.min(3, i); j++) {
        const prev = cps[checkpoints[i - j]];
        const curr = j === 1 ? snap : cps[checkpoints[i - j + 1]];
        if (!prev || !curr) continue;
        if (prev.ctrl !== curr.ctrl) break; // flip = stop looking back
        const delta = curr.floor - prev.floor;
        if (delta > 0.03) velocityScore++;
        else if (delta < -0.03) velocityScore--;
      }

      for (const vb of velocityBuckets) {
        if (vb.test(velocityScore)) {
          result[vb.label].n++;
          if (snap.ctrl_team_won) result[vb.label].wins++;
          break;
        }
      }
    }
  }

  for (const v of Object.values(result)) {
    v.pct = v.n > 0 ? Math.round(v.wins/v.n*1000)/10 : null;
  }

  return { description: 'BUY-eligible snapshots profiled by floor velocity (count of rising vs declining checkpoints in last 3). Positive = rising floor.', buckets: result };
}

// ── REPORT: CONSECUTIVE HOLDS AT ALERT TIME ─────────────────────────────────
async function reportConsecutiveHolds(sql) {
  const rows = await sql`
    SELECT game_id, checkpoint, (indicators->>'score')::real AS floor,
           margin_at_snapshot AS margin,
           indicators->>'controlTeam' AS ctrl, home_alias, ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  const checkpoints = ['Q1_6','Q1_END','Q2_6','Q2_END','Q3_6','Q3_END','Q4_6','Q4_END'];
  const games = {};
  for (const r of rows) {
    if (!games[r.game_id]) games[r.game_id] = {};
    games[r.game_id][r.checkpoint] = r;
  }

  // Hold buckets
  const holdBuckets = [
    { label: '1 (just took control)', min: 1, max: 1 },
    { label: '2-3', min: 2, max: 3 },
    { label: '4-5', min: 4, max: 5 },
    { label: '6+', min: 6, max: 99 },
  ];

  // All snapshots (not just BUY)
  const allResult = {};
  const buyResult = {};
  for (const hb of holdBuckets) {
    allResult[hb.label] = { n: 0, wins: 0 };
    buyResult[hb.label] = { n: 0, wins: 0 };
  }

  for (const [gid, cps] of Object.entries(games)) {
    for (let i = 0; i < checkpoints.length; i++) {
      const cp = checkpoints[i];
      const snap = cps[cp];
      if (!snap || !snap.ctrl) continue;

      // Count consecutive holds backward
      let holds = 1;
      for (let j = i - 1; j >= 0; j--) {
        const prev = cps[checkpoints[j]];
        if (!prev || prev.ctrl !== snap.ctrl) break;
        holds++;
      }

      for (const hb of holdBuckets) {
        if (holds >= hb.min && holds <= hb.max) {
          allResult[hb.label].n++;
          if (snap.ctrl_team_won) allResult[hb.label].wins++;

          // Also check BUY eligibility — ctrl-relative margin
          const ctrlHome2 = snap.ctrl === snap.home_alias;
          const ctrlMargin2 = ctrlHome2 ? snap.margin : -snap.margin;
          if (snap.floor >= 0.65 && ctrlMargin2 <= 0 && ctrlMargin2 >= -15) {
            buyResult[hb.label].n++;
            if (snap.ctrl_team_won) buyResult[hb.label].wins++;
          }
          break;
        }
      }
    }
  }

  for (const v of Object.values(allResult)) v.pct = v.n > 0 ? Math.round(v.wins/v.n*1000)/10 : null;
  for (const v of Object.values(buyResult)) v.pct = v.n > 0 ? Math.round(v.wins/v.n*1000)/10 : null;

  return {
    all_snapshots: allResult,
    buy_eligible_only: buyResult,
  };
}

// ── REPORT: FLIP RECOVERY RATE ──────────────────────────────────────────────
async function reportFlipRecovery(sql) {
  const rows = await sql`
    SELECT game_id, checkpoint, indicators->>'controlTeam' AS ctrl, ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  const checkpoints = ['Q1_6','Q1_END','Q2_6','Q2_END','Q3_6','Q3_END','Q4_6','Q4_END'];
  const games = {};
  for (const r of rows) {
    if (!games[r.game_id]) games[r.game_id] = {};
    games[r.game_id][r.checkpoint] = r;
  }

  // For each flip, track: does the original controller recover within 1, 2, 3 checkpoints?
  let totalFlips = 0;
  const recovery = { within_1: 0, within_2: 0, within_3: 0, never: 0 };
  const flipOutcomes = {
    recovered_won: 0, recovered_lost: 0,
    stayed_flipped_won: 0, stayed_flipped_lost: 0,
  };

  for (const [gid, cps] of Object.entries(games)) {
    for (let i = 1; i < checkpoints.length; i++) {
      const prev = cps[checkpoints[i-1]];
      const curr = cps[checkpoints[i]];
      if (!prev || !curr || !prev.ctrl || !curr.ctrl) continue;
      if (prev.ctrl === curr.ctrl) continue;

      // This is a flip. Original controller = prev.ctrl
      totalFlips++;
      const originalCtrl = prev.ctrl;
      let recovered = false;
      let recoveryWindow = 0;

      for (let j = i + 1; j < checkpoints.length; j++) {
        const future = cps[checkpoints[j]];
        if (!future || !future.ctrl) break;
        if (future.ctrl === originalCtrl) {
          recovered = true;
          recoveryWindow = j - i;
          if (recoveryWindow <= 1) recovery.within_1++;
          else if (recoveryWindow <= 2) recovery.within_2++;
          else recovery.within_3++;
          break;
        }
      }
      if (!recovered) recovery.never++;

      // Track outcomes
      const q4end = cps['Q4_END'];
      if (q4end) {
        const originalWon = (originalCtrl === q4end.ctrl && q4end.ctrl_team_won) ||
                            (originalCtrl !== q4end.ctrl && !q4end.ctrl_team_won);
        if (recovered) {
          if (originalWon) flipOutcomes.recovered_won++;
          else flipOutcomes.recovered_lost++;
        } else {
          if (originalWon) flipOutcomes.stayed_flipped_won++;
          else flipOutcomes.stayed_flipped_lost++;
        }
      }
    }
  }

  const recoveredTotal = recovery.within_1 + recovery.within_2 + recovery.within_3;
  return {
    total_flips: totalFlips,
    recovery_rate: {
      within_1_checkpoint: { n: recovery.within_1, pct: totalFlips > 0 ? Math.round(recovery.within_1/totalFlips*1000)/10 : null },
      within_2_checkpoints: { n: recovery.within_2, pct: totalFlips > 0 ? Math.round(recovery.within_2/totalFlips*1000)/10 : null },
      within_3_checkpoints: { n: recovery.within_3, pct: totalFlips > 0 ? Math.round(recovery.within_3/totalFlips*1000)/10 : null },
      never_recovered: { n: recovery.never, pct: totalFlips > 0 ? Math.round(recovery.never/totalFlips*1000)/10 : null },
      total_recovered_pct: totalFlips > 0 ? Math.round(recoveredTotal/totalFlips*1000)/10 : null,
    },
    outcomes: {
      recovered_and_won: { n: flipOutcomes.recovered_won, pct: recoveredTotal > 0 ? Math.round(flipOutcomes.recovered_won/recoveredTotal*1000)/10 : null },
      recovered_and_lost: { n: flipOutcomes.recovered_lost, pct: recoveredTotal > 0 ? Math.round(flipOutcomes.recovered_lost/recoveredTotal*1000)/10 : null },
      stayed_flipped_new_ctrl_won: { n: flipOutcomes.stayed_flipped_won, pct: recovery.never > 0 ? Math.round(flipOutcomes.stayed_flipped_won/recovery.never*1000)/10 : null },
      stayed_flipped_new_ctrl_lost: { n: flipOutcomes.stayed_flipped_lost, pct: recovery.never > 0 ? Math.round(flipOutcomes.stayed_flipped_lost/recovery.never*1000)/10 : null },
    },
  };
}

// ── PHASE: REPORT_ALL ───────────────────────────────────────────────────────
async function phaseReportAll(sql) {
  var startTime = Date.now();

  // Totals query
  var totalsP = sql`
    SELECT COUNT(*) AS total_snaps,
           COUNT(DISTINCT game_id) AS games,
           SUM(CASE WHEN ctrl_team_won THEN 1 ELSE 0 END) AS wins
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;

  // Run all 17 reports in parallel
  var [totals, calibration, timeDecay, alertSim, indicators, combos,
       alertsByCp, stability, marginFloor, velocity, autopsy,
       convictionDeficit, i4Split, velocityAtAlert, consecutiveHolds,
       flipRecovery, opponentProfile, tierSim] = await Promise.all([
    totalsP,
    reportCalibration(sql),
    reportTimeDecay(sql),
    reportAlertSim(sql),
    reportIndicators(sql),
    reportCombos(sql),
    reportAlertSimByCheckpoint(sql),
    reportStability(sql),
    reportMarginFloor(sql),
    reportFloorVelocity(sql),
    reportLosingAutopsy(sql),
    reportConvictionDeficit(sql),
    reportI4Split(sql),
    reportVelocityAtAlert(sql),
    reportConsecutiveHolds(sql),
    reportFlipRecovery(sql),
    reportOpponentProfile(sql),
    reportTierSim(sql),
  ]);

  return {
    _meta: {
      total_snapshots: Number(totals[0].total_snaps),
      total_games: Number(totals[0].games),
      overall_accuracy_pct: Number(totals[0].total_snaps) > 0
        ? Math.round(Number(totals[0].wins) / Number(totals[0].total_snaps) * 1000) / 10
        : null,
      elapsed_ms: Date.now() - startTime,
      reports_run: 17,
    },
    calibration: calibration,
    time_decay: timeDecay,
    alert_sim: alertSim,
    indicators: indicators,
    combos: combos,
    alerts_by_checkpoint: alertsByCp,
    stability: stability,
    margin_floor: marginFloor,
    floor_velocity: velocity,
    autopsy: autopsy,
    conviction_deficit: convictionDeficit,
    i4_split: i4Split,
    velocity_at_alert: velocityAtAlert,
    consecutive_holds: consecutiveHolds,
    flip_recovery: flipRecovery,
    opponent_profile: opponentProfile,
    tier_sim: tierSim,
  };
}

// ── REPORT: BWC EROSION v2 — Tier A + B erosion with fire timing splits ─────
async function reportBWCErosion(sql) {
  var rows = await sql`
    SELECT game_id, checkpoint, margin_at_snapshot AS margin,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl,
           indicators->>'homeAlias' AS home_alias,
           indicators->>'awayAlias' AS away_alias,
           (indicators->>'I1')::text AS i1raw, (indicators->>'I2')::text AS i2raw,
           (indicators->>'I3')::text AS i3raw, (indicators->>'I4')::text AS i4raw,
           (indicators->>'I5')::text AS i5raw,
           (conviction->>'tier') AS tier,
           (conviction->>'count')::int AS ind_count,
           pbp_derived,
           ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  var checkpoints = ['Q1_6','Q1_END','Q2_6','Q2_END','Q3_6','Q3_END','Q4_6','Q4_END'];
  var cpPeriod = { 'Q1_6':1,'Q1_END':1,'Q2_6':2,'Q2_END':2,'Q3_6':3,'Q3_END':3,'Q4_6':4,'Q4_END':4 };

  var games = {};
  for (var r of rows) {
    if (!games[r.game_id]) games[r.game_id] = {};
    games[r.game_id][r.checkpoint] = r;
  }

  function getI4SubAgree(r) {
    if (!r || !r.pbp_derived) return 'MIXED';
    var pd = typeof r.pbp_derived === 'string' ? JSON.parse(r.pbp_derived) : r.pbp_derived;
    var hBL = pd.hBigLead || 0, aBL = pd.aBigLead || 0;
    var subA = (hBL - aBL) > 4 ? 1 : (hBL - aBL) < -4 ? -1 : 0;
    var q4h = pd.q4hPts, q4a = pd.q4aPts;
    var subB = 0;
    if (q4h != null && q4a != null) {
      var q4diff = q4h - q4a;
      subB = q4diff > 2 ? 1 : q4diff < -2 ? -1 : 0;
    }
    var ctrlHome = r.ctrl === r.home_alias;
    var ctrlSubA = ctrlHome ? subA : -subA;
    var ctrlSubB = ctrlHome ? subB : -subB;
    if (ctrlSubA > 0 && ctrlSubB > 0) return 'AGREE';
    if (ctrlSubA < 0 || ctrlSubB < 0) return 'DISAGREE';
    return 'MIXED';
  }

  function getOppCount(r) {
    var ctrlHome = r.ctrl === r.home_alias;
    var scores = [parseFloat(r.i1raw), parseFloat(r.i2raw), parseFloat(r.i3raw),
                  parseFloat(r.i4raw), parseFloat(r.i5raw)];
    var count = 0;
    for (var s of scores) {
      if (isNaN(s)) continue;
      if (ctrlHome ? (s === 0) : (s === 1)) count++;
    }
    return count;
  }

  function getCtrlMargin(r) {
    return (r.ctrl === r.home_alias) ? r.margin : -r.margin;
  }

  function classifyBWCTier(conv, defBucket, holds, oppCount) {
    if (conv === 'DOMINANT' && defBucket === 'lead_8+' && holds >= 4 && oppCount <= 1) return 'A';
    if (oppCount >= 2) return 'C';
    if ((conv === 'DOMINANT' || conv === 'STRONG') &&
        (defBucket === 'lead_3-7' || defBucket === 'lead_8+') && holds >= 2) return 'B';
    return 'C';
  }

  function classifyFireTiming(cp) {
    var p = cpPeriod[cp];
    if (p <= 2) return 'early';  // Q2_END or earlier
    if (p === 3) return 'mid';   // Q3_6, Q3_END
    return 'late';               // Q4_6, Q4_END
  }

  function newErosionSet() {
    return {
      'held_8+':        { n:0, wins:0 },
      'compressed_3-7': { n:0, wins:0 },
      'tight_1-2':      { n:0, wins:0 },
      'tied_0':         { n:0, wins:0 },
      'lost_lead':      { n:0, wins:0 },
    };
  }

  function classifyErosion(minMargin) {
    if (minMargin >= 8) return 'held_8+';
    if (minMargin >= 3) return 'compressed_3-7';
    if (minMargin >= 1) return 'tight_1-2';
    if (minMargin === 0) return 'tied_0';
    return 'lost_lead';
  }

  // ── Results structure ──
  var tiers = ['A', 'B', 'C'];
  var timings = ['early', 'mid', 'late'];
  var results = {};
  for (var t of tiers) {
    results[t] = {
      total: 0, totalWins: 0,
      erosion: newErosionSet(),
      by_timing: {},
      ctrl_at_worst: { retained: { n:0, wins:0 }, lost: { n:0, wins:0 } },
      ctrl_by_bucket: {
        'compressed_3-7': { retained: {n:0,wins:0}, lost: {n:0,wins:0} },
        'tight_1-2':     { retained: {n:0,wins:0}, lost: {n:0,wins:0} },
        'tied_0':        { retained: {n:0,wins:0}, lost: {n:0,wins:0} },
        'lost_lead':     { retained: {n:0,wins:0}, lost: {n:0,wins:0} },
      },
      erosion_by_qtr: { Q2:{n:0,wins:0}, Q3:{n:0,wins:0}, Q4:{n:0,wins:0} },
      details: [],
    };
    for (var tm of timings) {
      results[t].by_timing[tm] = { total: 0, wins: 0, erosion: newErosionSet() };
    }
  }

  // ── Walk each game ──
  for (var gid of Object.keys(games)) {
    var cps = games[gid];
    var prevCtrl = null, consecutiveHolds = 0;

    // Find first fire for each tier
    var fires = { A: null, B: null, C: null };

    for (var ci = 0; ci < checkpoints.length; ci++) {
      var cp = checkpoints[ci];
      var r = cps[cp];
      if (!r) continue;

      var period = cpPeriod[cp];
      if (r.ctrl === prevCtrl) { consecutiveHolds++; }
      else { consecutiveHolds = 1; prevCtrl = r.ctrl; }

      if (period < 2) continue;
      var ctrlMargin = getCtrlMargin(r);
      if (ctrlMargin < 2 || r.floor < 0.60) continue;

      var defBucket = ctrlMargin >= 8 ? 'lead_8+' : ctrlMargin >= 3 ? 'lead_3-7' : 'tied_0-2';
      var oppCount = getOppCount(r);
      var bwcTier = classifyBWCTier(r.tier, defBucket, consecutiveHolds, oppCount);

      if (bwcTier === 'A' && !fires.A) {
        fires.A = { ci: ci, ctrl: r.ctrl, margin: ctrlMargin, cp: cp, won: !!r.ctrl_team_won };
      }
      if ((bwcTier === 'A' || bwcTier === 'B') && !fires.B) {
        fires.B = { ci: ci, ctrl: r.ctrl, margin: ctrlMargin, cp: cp, won: !!r.ctrl_team_won };
      }
      if ((bwcTier === 'A' || bwcTier === 'B' || bwcTier === 'C') && !fires.C) {
        fires.C = { ci: ci, ctrl: r.ctrl, margin: ctrlMargin, cp: cp, won: !!r.ctrl_team_won };
      }
      if (fires.A && fires.B && fires.C) break;
    }

    // Track erosion for each tier's first fire
    for (var tier of tiers) {
      var fire = fires[tier];
      if (!fire) continue;

      var res = results[tier];
      res.total++;
      if (fire.won) res.totalWins++;

      var timing = classifyFireTiming(fire.cp);
      res.by_timing[timing].total++;
      if (fire.won) res.by_timing[timing].wins++;

      // Walk subsequent checkpoints
      var minMargin = fire.margin;
      var minCp = fire.cp;
      var ctrlAtMin = true;

      for (var ci2 = fire.ci + 1; ci2 < checkpoints.length; ci2++) {
        var cp2 = checkpoints[ci2];
        var r2 = cps[cp2];
        if (!r2) continue;

        var bwcTeamIsHome = fire.ctrl === r2.home_alias;
        var bwcTeamMargin = bwcTeamIsHome ? r2.margin : -r2.margin;

        if (bwcTeamMargin < minMargin) {
          minMargin = bwcTeamMargin;
          minCp = cp2;
          ctrlAtMin = (r2.ctrl === fire.ctrl);
        }
      }

      var bucket = classifyErosion(minMargin);
      res.erosion[bucket].n++;
      if (fire.won) res.erosion[bucket].wins++;
      res.by_timing[timing].erosion[bucket].n++;
      if (fire.won) res.by_timing[timing].erosion[bucket].wins++;

      // Track ctrl retention for eroded cases
      if (bucket !== 'held_8+') {
        if (ctrlAtMin) { res.ctrl_at_worst.retained.n++; if (fire.won) res.ctrl_at_worst.retained.wins++; }
        else { res.ctrl_at_worst.lost.n++; if (fire.won) res.ctrl_at_worst.lost.wins++; }

        // Per-bucket ctrl retention
        if (res.ctrl_by_bucket[bucket]) {
          if (ctrlAtMin) { res.ctrl_by_bucket[bucket].retained.n++; if (fire.won) res.ctrl_by_bucket[bucket].retained.wins++; }
          else { res.ctrl_by_bucket[bucket].lost.n++; if (fire.won) res.ctrl_by_bucket[bucket].lost.wins++; }
        }

        var worstQ = 'Q' + cpPeriod[minCp];
        if (res.erosion_by_qtr[worstQ]) { res.erosion_by_qtr[worstQ].n++; if (fire.won) res.erosion_by_qtr[worstQ].wins++; }

        // Save details for severe erosion
        if (minMargin <= 2) {
          res.details.push({
            gid: gid, fire_cp: fire.cp, fire_margin: fire.margin,
            min_margin: minMargin, min_cp: minCp,
            ctrl_retained: ctrlAtMin, won: fire.won, ctrl: fire.ctrl,
          });
        }
      }
    }
  }

  // ── Format output ──
  function formatErosion(ero) {
    var out = {};
    for (var k of Object.keys(ero)) {
      out[k] = { n: ero[k].n, wins: ero[k].wins, pct: ero[k].n > 0 ? Math.round(ero[k].wins / ero[k].n * 1000) / 10 : null };
    }
    return out;
  }

  function formatCtrl(c) {
    return { n: c.n, wins: c.wins, pct: c.n > 0 ? Math.round(c.wins / c.n * 1000) / 10 : null };
  }

  var output = {};
  for (var tier of tiers) {
    var res = results[tier];
    var anyEroded = res.total - res.erosion['held_8+'].n;
    var anyErodedWins = res.totalWins - res.erosion['held_8+'].wins;
    var severeN = res.erosion['tight_1-2'].n + res.erosion['tied_0'].n + res.erosion['lost_lead'].n;
    var severeW = res.erosion['tight_1-2'].wins + res.erosion['tied_0'].wins + res.erosion['lost_lead'].wins;

    // "edge zone" = compressed_3-7 + ctrl retained
    // Can't separate ctrl from the erosion buckets directly in this structure,
    // so compute it from details + ctrl_at_worst
    var ctrlRetainedCompressed = { n: 0, wins: 0 };
    // We need to re-walk... actually let me use the detail data differently.
    // The ctrl_at_worst covers ALL eroded cases. Let me just report it as-is.

    var byTimingFormatted = {};
    for (var tm of timings) {
      var td = res.by_timing[tm];
      byTimingFormatted[tm] = {
        total: td.total, wins: td.wins, pct: td.total > 0 ? Math.round(td.wins / td.total * 1000) / 10 : null,
        erosion: formatErosion(td.erosion),
      };
    }

    var erosionQtrFormatted = {};
    for (var q of Object.keys(res.erosion_by_qtr)) {
      var eq = res.erosion_by_qtr[q];
      erosionQtrFormatted[q] = { n: eq.n, wins: eq.wins, pct: eq.n > 0 ? Math.round(eq.wins / eq.n * 1000) / 10 : null };
    }

    output['tier_' + tier] = {
      total_games: res.total,
      overall_win_rate: res.total > 0 ? Math.round(res.totalWins / res.total * 1000) / 10 : null,
      erosion: formatErosion(res.erosion),
      summary: {
        held_lead: { n: res.erosion['held_8+'].n, pct: res.total > 0 ? Math.round(res.erosion['held_8+'].n / res.total * 1000) / 10 : null },
        any_erosion: { n: anyEroded, wins: anyErodedWins, pct: anyEroded > 0 ? Math.round(anyErodedWins / anyEroded * 1000) / 10 : null },
        severe_erosion: { n: severeN, wins: severeW, pct: severeN > 0 ? Math.round(severeW / severeN * 1000) / 10 : null },
      },
      ctrl_at_worst: {
        retained: formatCtrl(res.ctrl_at_worst.retained),
        lost: formatCtrl(res.ctrl_at_worst.lost),
      },
      ctrl_by_erosion_bucket: {
        'compressed_3-7': { retained: formatCtrl(res.ctrl_by_bucket['compressed_3-7'].retained), lost: formatCtrl(res.ctrl_by_bucket['compressed_3-7'].lost) },
        'tight_1-2': { retained: formatCtrl(res.ctrl_by_bucket['tight_1-2'].retained), lost: formatCtrl(res.ctrl_by_bucket['tight_1-2'].lost) },
        'tied_0': { retained: formatCtrl(res.ctrl_by_bucket['tied_0'].retained), lost: formatCtrl(res.ctrl_by_bucket['tied_0'].lost) },
        'lost_lead': { retained: formatCtrl(res.ctrl_by_bucket['lost_lead'].retained), lost: formatCtrl(res.ctrl_by_bucket['lost_lead'].lost) },
      },
      by_fire_timing: byTimingFormatted,
      erosion_by_period: erosionQtrFormatted,
      severe_details: res.details.sort(function(a,b) { return a.min_margin - b.min_margin; }).slice(0, 20),
    };
  }

  return {
    description: 'BWC Tier A and B erosion analysis. Tracks first fire per game through subsequent checkpoints. Fire timing: early=Q2, mid=Q3, late=Q4.',
    ...output,
  };
}

// ── REPORT: VALUE PLAY — deep dive on lost_lead + ctrl_retained ─────────────
// Answers: is there a deficit depth cutoff? Does timing gate viability?
async function reportValuePlay(sql) {
  var rows = await sql`
    SELECT game_id, checkpoint, margin_at_snapshot AS margin,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl,
           indicators->>'homeAlias' AS home_alias,
           indicators->>'awayAlias' AS away_alias,
           (indicators->>'I1')::text AS i1raw, (indicators->>'I2')::text AS i2raw,
           (indicators->>'I3')::text AS i3raw, (indicators->>'I4')::text AS i4raw,
           (indicators->>'I5')::text AS i5raw,
           (conviction->>'tier') AS tier,
           pbp_derived,
           ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  var checkpoints = ['Q1_6','Q1_END','Q2_6','Q2_END','Q3_6','Q3_END','Q4_6','Q4_END'];
  var cpPeriod = { 'Q1_6':1,'Q1_END':1,'Q2_6':2,'Q2_END':2,'Q3_6':3,'Q3_END':3,'Q4_6':4,'Q4_END':4 };

  var games = {};
  for (var r of rows) {
    if (!games[r.game_id]) games[r.game_id] = {};
    games[r.game_id][r.checkpoint] = r;
  }

  function getOppCount(r) {
    var ctrlHome = r.ctrl === r.home_alias;
    var scores = [parseFloat(r.i1raw), parseFloat(r.i2raw), parseFloat(r.i3raw),
                  parseFloat(r.i4raw), parseFloat(r.i5raw)];
    var count = 0;
    for (var s of scores) { if (!isNaN(s) && (ctrlHome ? (s === 0) : (s === 1))) count++; }
    return count;
  }

  function classifyBWCTier(conv, defBucket, holds, oppCount) {
    if (conv === 'DOMINANT' && defBucket === 'lead_8+' && holds >= 4 && oppCount <= 1) return 'A';
    if (oppCount >= 2) return 'C';
    if ((conv === 'DOMINANT' || conv === 'STRONG') &&
        (defBucket === 'lead_3-7' || defBucket === 'lead_8+') && holds >= 2) return 'B';
    return 'C';
  }

  // Collect all lost_lead + ctrl_retained cases with detail
  var valuePlays = [];

  for (var gid of Object.keys(games)) {
    var cps = games[gid];
    var prevCtrl = null, consecutiveHolds = 0;

    // Find first BWC fire (any tier)
    var bwcFire = null;
    for (var ci = 0; ci < checkpoints.length; ci++) {
      var cp = checkpoints[ci];
      var r = cps[cp];
      if (!r) continue;
      var period = cpPeriod[cp];
      if (r.ctrl === prevCtrl) { consecutiveHolds++; }
      else { consecutiveHolds = 1; prevCtrl = r.ctrl; }
      if (period < 2) continue;
      var ctrlHome = r.ctrl === r.home_alias;
      var ctrlMargin = ctrlHome ? r.margin : -r.margin;
      if (ctrlMargin < 2 || r.floor < 0.60) continue;
      var defBucket = ctrlMargin >= 8 ? 'lead_8+' : ctrlMargin >= 3 ? 'lead_3-7' : 'tied_0-2';
      var oppCount = getOppCount(r);
      var bwcTier = classifyBWCTier(r.tier, defBucket, consecutiveHolds, oppCount);
      if (bwcTier !== 'C' || (ctrlMargin >= 2 && r.floor >= 0.60 && period >= 2)) {
        bwcFire = { ci: ci, ctrl: r.ctrl, margin: ctrlMargin, cp: cp, won: !!r.ctrl_team_won, tier: bwcTier, firePeriod: period };
        break;
      }
    }

    if (!bwcFire) continue;

    // Walk subsequent checkpoints, find EACH checkpoint where BWC team is trailing
    for (var ci2 = bwcFire.ci + 1; ci2 < checkpoints.length; ci2++) {
      var cp2 = checkpoints[ci2];
      var r2 = cps[cp2];
      if (!r2) continue;

      var bwcTeamIsHome = bwcFire.ctrl === r2.home_alias;
      var bwcTeamMargin = bwcTeamIsHome ? r2.margin : -r2.margin;
      var ctrlRetained = (r2.ctrl === bwcFire.ctrl);

      if (bwcTeamMargin < 0) {
        valuePlays.push({
          gid: gid,
          bwcTier: bwcFire.tier,
          fire_cp: bwcFire.cp,
          fire_margin: bwcFire.margin,
          fire_period: bwcFire.firePeriod,
          trail_cp: cp2,
          trail_period: cpPeriod[cp2],
          deficit: bwcTeamMargin,
          ctrl_retained: ctrlRetained,
          floor_at_trail: r2.floor,
          won: bwcFire.won,
        });
      }
    }
  }

  // ── Analysis: deficit depth × ctrl_retained ──
  var depthBuckets = [
    { label: 'trail_1-4', test: function(d) { return d >= -4; } },
    { label: 'trail_5-9', test: function(d) { return d >= -9; } },
    { label: 'trail_10-15', test: function(d) { return d >= -15; } },
    { label: 'trail_16+', test: function(d) { return d < -15; } },
  ];

  var byDepth = {};
  for (var db of depthBuckets) {
    byDepth[db.label] = { retained: {n:0,wins:0}, lost: {n:0,wins:0} };
  }

  for (var vp of valuePlays) {
    for (var db of depthBuckets) {
      if (db.test(vp.deficit)) {
        var side = vp.ctrl_retained ? 'retained' : 'lost';
        byDepth[db.label][side].n++;
        if (vp.won) byDepth[db.label][side].wins++;
        break;
      }
    }
  }

  // ── Analysis: period of trailing checkpoint × ctrl_retained ──
  var byPeriod = {};
  for (var p = 2; p <= 4; p++) {
    byPeriod['Q' + p] = { retained: {n:0,wins:0}, lost: {n:0,wins:0} };
  }

  for (var vp of valuePlays) {
    var qKey = 'Q' + vp.trail_period;
    if (!byPeriod[qKey]) continue;
    var side = vp.ctrl_retained ? 'retained' : 'lost';
    byPeriod[qKey][side].n++;
    if (vp.won) byPeriod[qKey][side].wins++;
  }

  // ── Cross-cut: depth × period (ctrl_retained ONLY) ──
  var crossCut = {};
  for (var db of depthBuckets) {
    crossCut[db.label] = {};
    for (var p = 2; p <= 4; p++) {
      crossCut[db.label]['Q' + p] = { n: 0, wins: 0 };
    }
  }

  for (var vp of valuePlays) {
    if (!vp.ctrl_retained) continue;
    var qKey = 'Q' + vp.trail_period;
    for (var db of depthBuckets) {
      if (db.test(vp.deficit)) {
        crossCut[db.label][qKey].n++;
        if (vp.won) crossCut[db.label][qKey].wins++;
        break;
      }
    }
  }

  // ── Analysis: floor at trailing checkpoint (ctrl_retained only) ──
  var byFloor = [
    { label: '0.50-0.60', lo: 0.50, hi: 0.60 },
    { label: '0.60-0.70', lo: 0.60, hi: 0.70 },
    { label: '0.70-0.80', lo: 0.70, hi: 0.80 },
    { label: '0.80+', lo: 0.80, hi: 2.0 },
  ];
  var floorDist = {};
  for (var fb of byFloor) floorDist[fb.label] = { n: 0, wins: 0 };

  for (var vp of valuePlays) {
    if (!vp.ctrl_retained) continue;
    for (var fb of byFloor) {
      if (vp.floor_at_trail >= fb.lo && vp.floor_at_trail < fb.hi) {
        floorDist[fb.label].n++;
        if (vp.won) floorDist[fb.label].wins++;
        break;
      }
    }
  }

  // ── Format helper ──
  function fmt(o) {
    return { n: o.n, wins: o.wins, pct: o.n > 0 ? Math.round(o.wins / o.n * 1000) / 10 : null };
  }

  // ── Format output ──
  var depthFormatted = {};
  for (var k of Object.keys(byDepth)) {
    depthFormatted[k] = { retained: fmt(byDepth[k].retained), lost: fmt(byDepth[k].lost) };
  }

  var periodFormatted = {};
  for (var k of Object.keys(byPeriod)) {
    periodFormatted[k] = { retained: fmt(byPeriod[k].retained), lost: fmt(byPeriod[k].lost) };
  }

  var crossFormatted = {};
  for (var dk of Object.keys(crossCut)) {
    crossFormatted[dk] = {};
    for (var pk of Object.keys(crossCut[dk])) {
      crossFormatted[dk][pk] = fmt(crossCut[dk][pk]);
    }
  }

  var floorFormatted = {};
  for (var fk of Object.keys(floorDist)) floorFormatted[fk] = fmt(floorDist[fk]);

  // Totals
  var totalRetained = valuePlays.filter(function(v) { return v.ctrl_retained; });
  var totalLost = valuePlays.filter(function(v) { return !v.ctrl_retained; });

  return {
    description: 'Deep dive on BWC teams that lost their lead. Every trailing checkpoint after a BWC fire. Deficit depth × period × ctrl retention × floor.',
    total_trailing_snapshots: valuePlays.length,
    retained_total: fmt({ n: totalRetained.length, wins: totalRetained.filter(function(v){return v.won;}).length }),
    lost_total: fmt({ n: totalLost.length, wins: totalLost.filter(function(v){return v.won;}).length }),
    by_deficit_depth: depthFormatted,
    by_period: periodFormatted,
    cross_cut_depth_x_period_ctrl_retained: crossFormatted,
    floor_at_trailing_checkpoint_ctrl_retained: floorFormatted,
  };
}

// ── PHASE: VALIDATE — comprehensive data integrity checks ──────────────────
async function phaseValidate(sql) {
  var checks = {};

  // ── 1. ctrl_team_won vs final_margin consistency at Q4_END ──
  // At Q4_END, ctrl_team_won should match: ctrl=home AND final>0, or ctrl=away AND final<0
  var q4rows = await sql`
    SELECT game_id, checkpoint, final_margin,
           indicators->>'controlTeam' AS ctrl,
           home_alias, away_alias,
           ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE checkpoint = 'Q4_END'
      AND indicators IS NOT NULL AND indicators->>'no_data' IS NULL
      AND final_margin IS NOT NULL
  `;
  var ctrlWonMismatches = [];
  for (var r of q4rows) {
    var ctrlIsHome = r.ctrl === r.home_alias;
    var homeWon = r.final_margin > 0;
    var expectedCtrlWon = (ctrlIsHome && homeWon) || (!ctrlIsHome && !homeWon);
    if (!!r.ctrl_team_won !== expectedCtrlWon) {
      ctrlWonMismatches.push({ game_id: r.game_id, ctrl: r.ctrl, home: r.home_alias, final_margin: r.final_margin, stored: r.ctrl_team_won, expected: expectedCtrlWon });
    }
  }
  checks.ctrl_team_won_integrity = {
    status: ctrlWonMismatches.length === 0 ? 'PASS' : 'FAIL',
    q4end_checked: q4rows.length,
    mismatches: ctrlWonMismatches.length,
    samples: ctrlWonMismatches.slice(0, 5),
  };

  // ── 2. final_margin nulls ──
  var nullFinals = await sql`
    SELECT COUNT(*) AS n FROM nba_snapshot_backtest
    WHERE final_margin IS NULL AND indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;
  checks.final_margin_nulls = {
    status: Number(nullFinals[0].n) === 0 ? 'PASS' : 'FAIL',
    null_count: Number(nullFinals[0].n),
  };

  // ── 3. final_margin = 0 (ties — shouldn't exist in NBA) ──
  var tiedGames = await sql`
    SELECT COUNT(DISTINCT game_id) AS n FROM nba_snapshot_backtest WHERE final_margin = 0
  `;
  checks.tied_games = {
    status: Number(tiedGames[0].n) === 0 ? 'PASS' : 'WARN',
    count: Number(tiedGames[0].n),
    note: 'NBA games cannot tie. Non-zero = data issue.',
  };

  // ── 4. Floor always >= 0.50 (ctrl-relative) ──
  var badFloors = await sql`
    SELECT COUNT(*) AS n FROM nba_snapshot_backtest
    WHERE (indicators->>'score')::real < 0.50
      AND indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;
  checks.floor_always_gte_50 = {
    status: Number(badFloors[0].n) === 0 ? 'PASS' : 'FAIL',
    violations: Number(badFloors[0].n),
  };

  // ── 5. indicators JSONB has controlTeam and homeAlias populated ──
  var missingCtrl = await sql`
    SELECT COUNT(*) AS n FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
      AND (indicators->>'controlTeam' IS NULL OR indicators->>'homeAlias' IS NULL)
  `;
  checks.ctrl_and_home_alias_populated = {
    status: Number(missingCtrl[0].n) === 0 ? 'PASS' : 'FAIL',
    missing: Number(missingCtrl[0].n),
  };

  // ── 6. margin_at_snapshot = home_pts - away_pts verification ──
  // Sample 100 random snapshots, check margin_at_snapshot matches team_stats
  var sampleRows = await sql`
    SELECT game_id, checkpoint, margin_at_snapshot,
           (team_stats->'home'->>'pts')::int AS h_pts,
           (team_stats->'away'->>'pts')::int AS a_pts
    FROM nba_snapshot_backtest
    WHERE team_stats IS NOT NULL
    ORDER BY random()
    LIMIT 100
  `;
  var marginMismatches = [];
  for (var s of sampleRows) {
    var expected = (s.h_pts || 0) - (s.a_pts || 0);
    if (s.margin_at_snapshot !== expected) {
      marginMismatches.push({ game_id: s.game_id, cp: s.checkpoint, stored: s.margin_at_snapshot, computed: expected, h: s.h_pts, a: s.a_pts });
    }
  }
  checks.margin_at_snapshot_accuracy = {
    status: marginMismatches.length === 0 ? 'PASS' : 'FAIL',
    sampled: sampleRows.length,
    mismatches: marginMismatches.length,
    samples: marginMismatches.slice(0, 5),
  };

  // ── 7. BUY count reconciliation: <= 0 vs < 0 ──
  var buyCountBroken = await sql`
    SELECT
      COUNT(*) FILTER (WHERE (indicators->>'score')::real >= 0.65
        AND CASE WHEN indicators->>'controlTeam' = home_alias
            THEN margin_at_snapshot ELSE -margin_at_snapshot END <= 0
        AND CASE WHEN indicators->>'controlTeam' = home_alias
            THEN margin_at_snapshot ELSE -margin_at_snapshot END >= -15
      ) AS buy_lte0,
      COUNT(*) FILTER (WHERE (indicators->>'score')::real >= 0.65
        AND CASE WHEN indicators->>'controlTeam' = home_alias
            THEN margin_at_snapshot ELSE -margin_at_snapshot END < 0
        AND CASE WHEN indicators->>'controlTeam' = home_alias
            THEN margin_at_snapshot ELSE -margin_at_snapshot END >= -15
      ) AS buy_lt0,
      COUNT(*) FILTER (WHERE (indicators->>'score')::real >= 0.65
        AND CASE WHEN indicators->>'controlTeam' = home_alias
            THEN margin_at_snapshot ELSE -margin_at_snapshot END = 0
      ) AS buy_tied
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;
  var bRow = buyCountBroken[0];
  checks.buy_filter_reconciliation = {
    status: 'INFO',
    buy_lte0_includes_ties: Number(bRow.buy_lte0),
    buy_lt0_strict_trailing: Number(bRow.buy_lt0),
    tied_with_floor_065: Number(bRow.buy_tied),
    note: 'Production BUY = strictly trailing (< 0). alert_sim uses <= 0 (bug). Gap = tied snapshots.',
  };

  // ── 8. Q4_END ctrl_team_won vs ctrlMargin direction ──
  // If ctrl won the game AND ctrl controls at Q4_END, ctrlMargin should be positive
  var q4margin = await sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE ctrl_team_won = true AND
        CASE WHEN indicators->>'controlTeam' = home_alias
          THEN margin_at_snapshot ELSE -margin_at_snapshot END > 0
      ) AS won_and_leading,
      COUNT(*) FILTER (WHERE ctrl_team_won = true AND
        CASE WHEN indicators->>'controlTeam' = home_alias
          THEN margin_at_snapshot ELSE -margin_at_snapshot END <= 0
      ) AS won_but_trailing_or_tied,
      COUNT(*) FILTER (WHERE ctrl_team_won = false AND
        CASE WHEN indicators->>'controlTeam' = home_alias
          THEN margin_at_snapshot ELSE -margin_at_snapshot END > 0
      ) AS lost_but_leading
    FROM nba_snapshot_backtest
    WHERE checkpoint = 'Q4_END'
      AND indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;
  var qm = q4margin[0];
  checks.q4end_margin_vs_outcome = {
    status: 'INFO',
    total: Number(qm.total),
    won_and_leading: Number(qm.won_and_leading),
    won_but_trailing_or_tied: Number(qm.won_but_trailing_or_tied),
    lost_but_leading: Number(qm.lost_but_leading),
    note: 'At Q4_END, ctrl team that won should almost always be leading. won_but_trailing = ctrl flipped late.',
  };

  // ── 9. Snapshot coverage ──
  var coverage = await sql`
    SELECT checkpoint, COUNT(*) AS n,
           COUNT(DISTINCT game_id) AS games,
           COUNT(*) FILTER (WHERE ctrl_team_won IS NULL) AS null_outcome
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    GROUP BY checkpoint ORDER BY checkpoint
  `;
  checks.snapshot_coverage = coverage.map(function(c) {
    return { checkpoint: c.checkpoint, snapshots: Number(c.n), games: Number(c.games), null_outcome: Number(c.null_outcome) };
  });

  // ── 10. Conviction tier distribution (sanity) ──
  var tierDist = await sql`
    SELECT conviction->>'tier' AS tier, COUNT(*) AS n
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    GROUP BY conviction->>'tier'
    ORDER BY n DESC
  `;
  checks.conviction_distribution = tierDist.map(function(t) { return { tier: t.tier, n: Number(t.n) }; });

  // ── 11. Home vs away ctrl team distribution ──
  var ctrlSide = await sql`
    SELECT
      COUNT(*) FILTER (WHERE indicators->>'controlTeam' = home_alias) AS ctrl_home,
      COUNT(*) FILTER (WHERE indicators->>'controlTeam' = away_alias) AS ctrl_away,
      COUNT(*) FILTER (WHERE indicators->>'controlTeam' != home_alias
                         AND indicators->>'controlTeam' != away_alias) AS ctrl_neither
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;
  var cs = ctrlSide[0];
  checks.ctrl_team_side_distribution = {
    ctrl_home: Number(cs.ctrl_home),
    ctrl_away: Number(cs.ctrl_away),
    ctrl_neither: Number(cs.ctrl_neither),
    home_pct: Math.round(Number(cs.ctrl_home) / (Number(cs.ctrl_home) + Number(cs.ctrl_away)) * 1000) / 10,
    note: 'Should be roughly 55-60% home (home advantage). ctrl_neither should be 0.',
  };

  // ── Summary ──
  var failures = Object.entries(checks).filter(function(e) { return e[1].status === 'FAIL'; });
  var warnings = Object.entries(checks).filter(function(e) { return e[1].status === 'WARN'; });

  return {
    summary: {
      total_checks: Object.keys(checks).length,
      passed: Object.entries(checks).filter(function(e) { return e[1].status === 'PASS'; }).length,
      failed: failures.length,
      warnings: warnings.length,
      info: Object.entries(checks).filter(function(e) { return e[1].status === 'INFO'; }).length,
      verdict: failures.length === 0 ? 'DATA CLEAN — safe to build on' : 'ISSUES FOUND — investigate before building',
    },
    checks,
  };
}

// ── DIAGNOSTIC: BUY COUNT GAP — why alert_sim (502) != validation SQL (394) ─
async function diagnoseBuyGap(sql) {
  // Method A: JS-side filtering (same as alert_sim)
  var jsRows = await sql`
    SELECT game_id, checkpoint,
           (indicators->>'score')::real AS floor,
           margin_at_snapshot AS margin,
           indicators->>'controlTeam' AS ctrl,
           home_alias,
           ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;

  var jsBuys = [];
  for (var r of jsRows) {
    var ctrlHome = r.ctrl === r.home_alias;
    var ctrlMargin = ctrlHome ? r.margin : -r.margin;
    if (r.floor >= 0.65 && ctrlMargin <= 0 && ctrlMargin >= -15) {
      jsBuys.push({ gid: r.game_id, cp: r.checkpoint, floor: r.floor, margin: r.margin, ctrlMargin: ctrlMargin, ctrl: r.ctrl, home: r.home_alias, ctrlHome: ctrlHome });
    }
  }

  // Method B: SQL-side filtering (same as validation)
  var sqlBuys = await sql`
    SELECT game_id, checkpoint,
           (indicators->>'score')::real AS floor,
           margin_at_snapshot AS margin,
           indicators->>'controlTeam' AS ctrl,
           home_alias,
           CASE WHEN indicators->>'controlTeam' = home_alias
                THEN margin_at_snapshot ELSE -margin_at_snapshot END AS ctrl_margin
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
      AND (indicators->>'score')::real >= 0.65
      AND CASE WHEN indicators->>'controlTeam' = home_alias
              THEN margin_at_snapshot ELSE -margin_at_snapshot END <= 0
      AND CASE WHEN indicators->>'controlTeam' = home_alias
              THEN margin_at_snapshot ELSE -margin_at_snapshot END >= -15
  `;

  // Build lookup sets
  var jsSet = new Set(jsBuys.map(function(r) { return r.gid + '_' + r.cp; }));
  var sqlSet = new Set(sqlBuys.map(function(r) { return r.game_id + '_' + r.checkpoint; }));

  // Find differences
  var inJsNotSql = jsBuys.filter(function(r) { return !sqlSet.has(r.gid + '_' + r.cp); });
  var inSqlNotJs = sqlBuys.filter(function(r) { return !jsSet.has(r.game_id + '_' + r.checkpoint); });

  // Analyze the JS-only rows: what do they look like?
  var jsOnlyFloorDist = {};
  var jsOnlyMarginDist = {};
  for (var j of inJsNotSql) {
    var fBucket = Math.floor(j.floor * 100) / 100;
    jsOnlyFloorDist[fBucket] = (jsOnlyFloorDist[fBucket] || 0) + 1;
    jsOnlyMarginDist[j.ctrlMargin] = (jsOnlyMarginDist[j.ctrlMargin] || 0) + 1;
  }

  return {
    js_side_count: jsBuys.length,
    sql_side_count: sqlBuys.length,
    gap: jsBuys.length - sqlBuys.length,
    in_js_not_sql: inJsNotSql.length,
    in_sql_not_js: inSqlNotJs.length,
    js_only_samples: inJsNotSql.slice(0, 20).map(function(r) {
      return { gid: r.gid, cp: r.cp, floor: r.floor, margin: r.margin, ctrlMargin: r.ctrlMargin, ctrl: r.ctrl, home: r.home, ctrlHome: r.ctrlHome };
    }),
    sql_only_samples: inSqlNotJs.slice(0, 10).map(function(r) {
      return { gid: r.game_id, cp: r.checkpoint, floor: r.floor, margin: r.margin, ctrlMargin: r.ctrl_margin, ctrl: r.ctrl, home: r.home_alias };
    }),
    js_only_floor_distribution: jsOnlyFloorDist,
    js_only_margin_distribution: jsOnlyMarginDist,
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

// ── PHASE: WIPE_INDICATORS — clear stale compute data for clean recompute ──
async function phaseWipeIndicators(sql) {
  const result = await sql`
    UPDATE nba_snapshot_backtest
    SET indicators = NULL, conviction = NULL, ctrl_team_won = NULL, computed_at = NULL
    WHERE indicators IS NOT NULL
  `;
  const remaining = await sql`SELECT COUNT(*) AS n FROM nba_snapshot_backtest WHERE indicators IS NULL`;
  return {
    status: 'ok',
    message: 'Wiped all indicators/conviction/ctrl_team_won',
    rows_wiped: result.count || 'unknown',
    rows_needing_compute: Number(remaining[0].n),
    nextStep: '?phase=compute',
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

// ── REPORT: OPPONENT PROFILE ────────────────────────────────────────────────
async function reportOpponentProfile(sql) {
  const rows = await sql`
    SELECT indicators, conviction, margin_at_snapshot AS margin, ctrl_team_won, checkpoint
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
  `;

  // For each snapshot, determine which indicators the OPPONENT won
  // I1-I5 are home-relative: I=1 means home won, I=0 means away won
  // If ctrl is home: opponent won when I=0, opponent even when I=0.5
  // If ctrl is away: opponent won when I=1, opponent even when I=0.5

  function getOppIndicators(ind) {
    var ctrlHome = ind.controlTeam === ind.homeAlias;
    var result = {};
    for (var k of ['I1','I2','I3','I4','I5']) {
      var v = parseFloat(ind[k]);
      if (ctrlHome) {
        result[k] = v === 0 ? 'won' : v === 0.5 ? 'even' : 'lost';
      } else {
        result[k] = v === 1 ? 'won' : v === 0.5 ? 'even' : 'lost';
      }
    }
    return result;
  }

  // ── Section 1: Individual opponent indicators vs BUY accuracy ──
  // BUY condition: floor >= 0.65, trailing (margin < 0, >= -15)
  var allSnaps = [];
  for (var r of rows) {
    var ind = typeof r.indicators === 'string' ? JSON.parse(r.indicators) : r.indicators;
    var conv = typeof r.conviction === 'string' ? JSON.parse(r.conviction) : r.conviction;
    if (!ind || ind.score == null) continue;
    var opp = getOppIndicators(ind);
    var oppCount = 0;
    for (var k of ['I1','I2','I3','I4','I5']) { if (opp[k] === 'won') oppCount++; }
    var ctrlHome = ind.controlTeam === ind.homeAlias;
    var ctrlMargin = ctrlHome ? r.margin : -r.margin;
    allSnaps.push({
      floor: parseFloat(ind.score),
      ctrlMargin: ctrlMargin,
      won: !!r.ctrl_team_won,
      tier: conv?.tier,
      opp, oppCount,
      checkpoint: r.checkpoint,
    });
  }

  var buySnaps = allSnaps.filter(function(s) { return s.floor >= 0.65 && s.ctrlMargin <= 0 && s.ctrlMargin >= -15; });

  // Individual opponent indicators
  var oppIndividual = {};
  for (var k of ['I1','I2','I3','I4','I5']) {
    oppIndividual[k] = {};
    for (var state of ['won','even','lost']) {
      var group = buySnaps.filter(function(s) { return s.opp[k] === state; });
      var wins = group.filter(function(s) { return s.won; }).length;
      oppIndividual[k][state] = { n: group.length, wins: wins, pct: group.length > 0 ? Math.round(wins/group.length*1000)/10 : null };
    }
  }

  // ── Section 2: Opponent indicator COUNT vs BUY accuracy ──
  var oppCountBuckets = {};
  for (var s of buySnaps) {
    var label = s.oppCount + ' opp indicators';
    if (!oppCountBuckets[label]) oppCountBuckets[label] = { n: 0, wins: 0 };
    oppCountBuckets[label].n++;
    if (s.won) oppCountBuckets[label].wins++;
  }
  for (var k2 of Object.keys(oppCountBuckets)) {
    oppCountBuckets[k2].pct = Math.round(oppCountBuckets[k2].wins / oppCountBuckets[k2].n * 1000) / 10;
  }

  // ── Section 3: Opponent indicator COMBOS (which won) vs BUY accuracy ──
  var oppCombos = {};
  for (var s2 of buySnaps) {
    var wonList = [];
    for (var k3 of ['I1','I2','I3','I4','I5']) { if (s2.opp[k3] === 'won') wonList.push(k3); }
    var comboKey = wonList.length === 0 ? 'NONE' : wonList.join('+');
    if (!oppCombos[comboKey]) oppCombos[comboKey] = { n: 0, wins: 0 };
    oppCombos[comboKey].n++;
    if (s2.won) oppCombos[comboKey].wins++;
  }
  for (var kc of Object.keys(oppCombos)) {
    oppCombos[kc].pct = Math.round(oppCombos[kc].wins / oppCombos[kc].n * 1000) / 10;
  }
  // Sort by n desc
  var oppCombosSorted = Object.entries(oppCombos)
    .sort(function(a,b) { return b[1].n - a[1].n; })
    .map(function(e) { return { combo: e[0], n: e[1].n, wins: e[1].wins, pct: e[1].pct }; });

  // ── Section 4: Opponent indicators × deficit depth ──
  var defBuckets = [
    { label: 'trail_10+', test: function(m) { return m <= -10; } },
    { label: 'trail_5-9', test: function(m) { return m >= -9 && m <= -5; } },
    { label: 'trail_1-4', test: function(m) { return m >= -4 && m <= -1; } },
  ];
  var oppByDeficit = {};
  for (var db of defBuckets) {
    oppByDeficit[db.label] = {};
    var dbSnaps = buySnaps.filter(function(s) { return db.test(s.ctrlMargin); });
    for (var oc = 0; oc <= 5; oc++) {
      var ocSnaps = dbSnaps.filter(function(s) { return s.oppCount === oc; });
      var ocWins = ocSnaps.filter(function(s) { return s.won; }).length;
      if (ocSnaps.length > 0) {
        oppByDeficit[db.label][oc + ' opp ind'] = { n: ocSnaps.length, wins: ocWins, pct: Math.round(ocWins/ocSnaps.length*1000)/10 };
      }
    }
  }

  // ── Section 5: Close-game zone (margin -5 to +5) opponent profile (ALL snaps, not just BUY) ──
  var closeSnaps = allSnaps.filter(function(s) { return s.ctrlMargin >= -5 && s.ctrlMargin <= 5; });
  var closeOppCount = {};
  for (var cc = 0; cc <= 5; cc++) {
    var ccSnaps = closeSnaps.filter(function(s) { return s.oppCount === cc; });
    var ccWins = ccSnaps.filter(function(s) { return s.won; }).length;
    if (ccSnaps.length > 0) {
      closeOppCount[cc + ' opp ind'] = { n: ccSnaps.length, wins: ccWins, pct: Math.round(ccWins/ccSnaps.length*1000)/10 };
    }
  }

  // ── Section 6: "BUY killers" — opponent combos with worst ctrl win rate (n >= 20) ──
  var killers = oppCombosSorted.filter(function(c) { return c.n >= 20; })
    .sort(function(a,b) { return a.pct - b.pct; })
    .slice(0, 10);

  // ── Section 7: Opponent I4 specifically (since ctrl I4 is our best predictor) ──
  // When opponent has I4, how does that change things?
  var oppI4Impact = {};
  for (var state2 of ['won','even','lost']) {
    var i4group = buySnaps.filter(function(s) { return s.opp.I4 === state2; });
    var i4wins = i4group.filter(function(s) { return s.won; }).length;
    oppI4Impact[state2] = {
      n: i4group.length, wins: i4wins,
      pct: i4group.length > 0 ? Math.round(i4wins/i4group.length*1000)/10 : null,
    };
    // Sub-cut by deficit
    var sub = {};
    for (var db2 of defBuckets) {
      var dbGroup = i4group.filter(function(s) { return db2.test(s.ctrlMargin); });
      var dbWins = dbGroup.filter(function(s) { return s.won; }).length;
      if (dbGroup.length > 0) sub[db2.label] = { n: dbGroup.length, wins: dbWins, pct: Math.round(dbWins/dbGroup.length*1000)/10 };
    }
    oppI4Impact[state2].by_deficit = sub;
  }

  // ── Section 8: BWC opponent profile ──
  var bwcSnaps = allSnaps.filter(function(s) { return s.floor >= 0.60 && s.ctrlMargin >= 2; });
  var bwcOppCount = {};
  for (var bc = 0; bc <= 5; bc++) {
    var bcSnaps = bwcSnaps.filter(function(s) { return s.oppCount === bc; });
    var bcWins = bcSnaps.filter(function(s) { return s.won; }).length;
    if (bcSnaps.length > 0) {
      bwcOppCount[bc + ' opp ind'] = { n: bcSnaps.length, wins: bcWins, pct: Math.round(bcWins/bcSnaps.length*1000)/10 };
    }
  }

  return {
    description: 'Opponent indicator profile vs BUY/BWC alert accuracy. Ctrl-relative margin. Opponent indicators inverted from home-relative I1-I5.',
    buy_eligible: { total: buySnaps.length, win_rate: Math.round(buySnaps.filter(function(s){return s.won;}).length/buySnaps.length*1000)/10 },
    opponent_individual_indicators: oppIndividual,
    opponent_indicator_count: oppCountBuckets,
    opponent_combos: oppCombosSorted,
    opponent_by_deficit: oppByDeficit,
    close_game_opponent_profile: { zone: 'margin -5 to +5', total: closeSnaps.length, by_opp_count: closeOppCount },
    buy_killers_worst_combos: killers,
    opponent_I4_deep_dive: oppI4Impact,
    bwc_opponent_profile: { total: bwcSnaps.length, by_opp_count: bwcOppCount },
  };
}

// ── REPORT: TIER SIMULATION ─────────────────────────────────────────────────
// Simulates the full tiered alert system against backtest data.
// Walks each game's checkpoints in order to compute temporal metrics
// (consecutive holds, velocity, I4 sub-agreement, peak/trough) then
// classifies each BUY/BWC-eligible snapshot into Tier A/B/C.
async function reportTierSim(sql) {
  var rows = await sql`
    SELECT game_id, checkpoint, margin_at_snapshot AS margin,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl,
           indicators->>'homeAlias' AS home_alias,
           indicators->>'awayAlias' AS away_alias,
           (indicators->>'I1')::text AS i1raw, (indicators->>'I2')::text AS i2raw,
           (indicators->>'I3')::text AS i3raw, (indicators->>'I4')::text AS i4raw,
           (indicators->>'I5')::text AS i5raw,
           (conviction->>'tier') AS tier,
           (conviction->>'combo') AS combo,
           (conviction->>'count')::int AS ind_count,
           pbp_derived,
           ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  var checkpoints = ['Q1_6','Q1_END','Q2_6','Q2_END','Q3_6','Q3_END','Q4_6','Q4_END'];
  var cpPeriod = { 'Q1_6':1,'Q1_END':1,'Q2_6':2,'Q2_END':2,'Q3_6':3,'Q3_END':3,'Q4_6':4,'Q4_END':4 };

  // Group by game
  var games = {};
  for (var r of rows) {
    if (!games[r.game_id]) games[r.game_id] = {};
    games[r.game_id][r.checkpoint] = r;
  }

  // ── Helper: compute I4 sub-agreement from pbp_derived ──
  function getI4SubAgree(r) {
    if (!r || !r.pbp_derived) return 'MIXED';
    var pd = typeof r.pbp_derived === 'string' ? JSON.parse(r.pbp_derived) : r.pbp_derived;
    var hBL = pd.hBigLead || 0, aBL = pd.aBigLead || 0;
    var blDiff = hBL - aBL;
    var subA = blDiff > 4 ? 1 : blDiff < -4 ? -1 : 0;
    var q4h = pd.q4hPts, q4a = pd.q4aPts;
    var subB = 0;
    if (q4h != null && q4a != null) {
      var q4diff = q4h - q4a;
      subB = q4diff > 2 ? 1 : q4diff < -2 ? -1 : 0;
    }
    // Convert to ctrl-relative
    var ctrlHome = r.ctrl === r.home_alias;
    var ctrlSubA = ctrlHome ? subA : -subA;
    var ctrlSubB = ctrlHome ? subB : -subB;
    if (ctrlSubA > 0 && ctrlSubB > 0) return 'AGREE';
    if (ctrlSubA < 0 && ctrlSubB < 0) return 'DISAGREE'; // both favor opponent = I4 lost
    if ((ctrlSubA > 0 && ctrlSubB < 0) || (ctrlSubA < 0 && ctrlSubB > 0)) return 'DISAGREE';
    return 'MIXED';
  }

  // ── Helper: classify deficit ──
  function classifyDeficit(margin, isTrailing) {
    if (!isTrailing && margin >= 8) return 'lead_8+';
    if (!isTrailing && margin >= 3) return 'lead_3-7';
    if (Math.abs(margin) <= 2) return 'tied_0-2';
    if (isTrailing && margin >= 10) return 'trail_10+';
    if (isTrailing && margin >= 5) return 'trail_5-9';
    if (isTrailing && margin >= 1) return 'trail_1-4';
    return 'tied_0-2';
  }

  // ── Helper: opponent indicators count ──
  function getOppIndicatorCount(r) {
    if (!r) return 0;
    var ctrlHome = r.ctrl === r.home_alias;
    var count = 0;
    // I values are stored as the raw score object string like "{"score":1,"leader":"HOME"}"
    // But in our query we extract as text. The indicators->>I1 returns the JSON object as text.
    // Actually, looking at the schema, indicators is JSONB with I1/I2/I3/I4/I5 as numbers.
    // In our query: (indicators->>'I1')::text gives us the score number as string.
    // Wait — looking at the compute phase, indicators is stored as full object:
    // { controlTeam, score, I1:{score,leader}, I2:{score,leader}... }
    // So indicators->>'I1' returns the JSON object {"score":1,"leader":"HOME"}
    // We need to parse it. Actually let me re-check...
    // From the backtest computeServer (line 393): returns { I1, I2, I3, I4, I5 } where each is {score, leader}
    // BUT the backtest computeServer (line 341) returns simpler objects:
    // I1 = (i1subA + i1subB) > 0 ? 1 : ... — just a number!
    // So in the backtest, I1-I5 are plain numbers, not objects.
    // indicators->>'I1' is a string number like "1" or "0.5" or "0"
    var scores = [parseFloat(r.i1raw), parseFloat(r.i2raw), parseFloat(r.i3raw),
                  parseFloat(r.i4raw), parseFloat(r.i5raw)];
    for (var s of scores) {
      if (isNaN(s)) continue;
      // Home-relative: 1=home won, 0=away won
      // If ctrl is home: opp won when score=0
      // If ctrl is away: opp won when score=1
      var oppWon = ctrlHome ? (s === 0) : (s === 1);
      if (oppWon) count++;
    }
    return count;
  }

  // ── Helper: computeBuyTier (mirrors production spec) ──
  function computeBuyTier(p) {
    var alertType = p.alertType, conv = p.convictionTier, deficit = p.deficitBucket;
    var i4sa = p.i4SubAgree, holds = p.consecutiveHolds, vel = p.velocityDir;
    var period = p.period, closeGame = p.isCloseGame, oppCount = p.oppIndicatorCount;

    // Override: DOMINANT + trail_10+
    if (conv === 'DOMINANT' && deficit === 'trail_10+') return 'A';

    // BWC path
    if (alertType === 'BWC') {
      if (conv === 'DOMINANT' && deficit === 'lead_8+' && holds >= 4 && oppCount <= 1) return 'A';
      if (oppCount >= 2) return 'C';
      if ((conv === 'DOMINANT' || conv === 'STRONG') &&
          (deficit === 'lead_3-7' || deficit === 'lead_8+') && holds >= 2) return 'B';
      return 'C';
    }

    // WINDOW BUY always C
    if (alertType === 'WB') return 'C';

    // Close game override
    if (closeGame) {
      if (i4sa === 'AGREE' && holds >= 4 && (vel === 'rising' || vel === 'surging') && period >= 3) return 'B';
      return 'C';
    }

    // BUY standard tiers
    // Tier A
    if ((conv === 'DOMINANT' || conv === 'STRONG') &&
        (deficit === 'trail_5-9' || deficit === 'trail_10+') &&
        i4sa === 'AGREE' && holds >= 4 && period >= 2) return 'A';

    // Tier B
    if ((conv === 'DOMINANT' || conv === 'STRONG') &&
        (deficit === 'trail_5-9' || deficit === 'trail_10+') &&
        i4sa !== 'DISAGREE' && holds >= 2) return 'B';
    if (conv === 'MODEST' && deficit === 'trail_10+' && i4sa === 'AGREE') return 'B';
    if ((conv === 'DOMINANT' || conv === 'STRONG') && deficit === 'trail_5-9' && holds >= 2) return 'B';

    // Tier C
    return 'C';
  }

  // ── Walk each game's checkpoints ──
  var buyResults = { A: { n:0, wins:0 }, B: { n:0, wins:0 }, C: { n:0, wins:0 } };
  var bwcResults = { A: { n:0, wins:0 }, B: { n:0, wins:0 }, C: { n:0, wins:0 } };
  var buyByCheckpoint = {};
  var bwcByCheckpoint = {};
  for (var cp of checkpoints) {
    buyByCheckpoint[cp] = { A: {n:0,wins:0}, B: {n:0,wins:0}, C: {n:0,wins:0} };
    bwcByCheckpoint[cp] = { A: {n:0,wins:0}, B: {n:0,wins:0}, C: {n:0,wins:0} };
  }

  // Tier × deficit cross-cut (BUY only)
  var buyTierDeficit = {};
  for (var t of ['A','B','C']) {
    buyTierDeficit[t] = {};
    for (var d of ['trail_10+','trail_5-9','trail_1-4']) buyTierDeficit[t][d] = {n:0,wins:0};
  }

  // Close game analysis
  var closeGameTiers = { B: {n:0,wins:0}, C: {n:0,wins:0} };

  // Detailed tier A/B/C reason distribution
  var tierReasons = { A: {}, B: {}, C: {} };

  for (var gid of Object.keys(games)) {
    var cps = games[gid];
    var prevCtrl = null, consecutiveHolds = 0;
    var peakFloor = 0, troughFloor = 1;
    var floorHistory = [];

    for (var ci = 0; ci < checkpoints.length; ci++) {
      var cp = checkpoints[ci];
      var r = cps[cp];
      if (!r) continue;

      var period = cpPeriod[cp];

      // Update consecutive holds
      if (r.ctrl === prevCtrl) {
        consecutiveHolds++;
      } else {
        consecutiveHolds = 1;
        prevCtrl = r.ctrl;
        // Reset peak/trough for new ctrl team
        peakFloor = r.floor;
        troughFloor = r.floor;
      }

      // Update peak/trough for current ctrl team
      if (r.floor > peakFloor) peakFloor = r.floor;
      if (r.floor < troughFloor) troughFloor = r.floor;

      // Velocity from last 3 checkpoints
      floorHistory.push(r.floor);
      var velocityDir = 'stable';
      if (floorHistory.length >= 3) {
        var recent = floorHistory.slice(-4); // last 4 entries = 3 transitions
        var rises = 0, declines = 0;
        for (var vi = recent.length - 1; vi > 0; vi--) {
          if (recent[vi] > recent[vi-1] + 0.01) rises++;
          else if (recent[vi] < recent[vi-1] - 0.01) declines++;
        }
        if (rises >= 3) velocityDir = 'surging';
        else if (rises > declines) velocityDir = 'rising';
        else if (declines >= 3) velocityDir = 'crashing';
        else if (declines > rises) velocityDir = 'declining';
      }

      var margin = Math.abs(r.margin);
      var isTrailing = r.margin < 0; // margin is home-relative, ctrl may be away
      // Actually need to determine if CTRL team is trailing
      var ctrlHome = r.ctrl === r.home_alias;
      var ctrlMargin = ctrlHome ? r.margin : -r.margin;
      var ctrlTrailing = ctrlMargin < 0;
      var absMargin = Math.abs(ctrlMargin);
      var deficitBucket = classifyDeficit(absMargin, ctrlTrailing);
      var closeGame = Math.abs(ctrlMargin) <= 5;
      var i4sa = getI4SubAgree(r);
      var oppCount = getOppIndicatorCount(r);

      // ── BUY eligible: floor >= 0.65, trailing, margin 1-15 ──
      if (r.floor >= 0.65 && ctrlTrailing && absMargin >= 1 && absMargin <= 15 && period >= 2) {
        var buyTier = computeBuyTier({
          alertType: 'BUY', convictionTier: r.tier, deficitBucket: deficitBucket,
          i4SubAgree: i4sa, consecutiveHolds: consecutiveHolds,
          velocityDir: velocityDir, period: period,
          isCloseGame: closeGame, oppIndicatorCount: oppCount,
        });
        buyResults[buyTier].n++;
        if (r.ctrl_team_won) buyResults[buyTier].wins++;
        buyByCheckpoint[cp][buyTier].n++;
        if (r.ctrl_team_won) buyByCheckpoint[cp][buyTier].wins++;
        // Deficit cross-cut
        if (buyTierDeficit[buyTier][deficitBucket]) {
          buyTierDeficit[buyTier][deficitBucket].n++;
          if (r.ctrl_team_won) buyTierDeficit[buyTier][deficitBucket].wins++;
        }
        // Close game tracking
        if (closeGame && (buyTier === 'B' || buyTier === 'C')) {
          closeGameTiers[buyTier].n++;
          if (r.ctrl_team_won) closeGameTiers[buyTier].wins++;
        }
      }

      // ── BWC eligible: floor >= 0.60, leading 2+ ──
      if (r.floor >= 0.60 && !ctrlTrailing && ctrlMargin >= 2 && period >= 2) {
        var bwcTier = computeBuyTier({
          alertType: 'BWC', convictionTier: r.tier, deficitBucket: deficitBucket,
          i4SubAgree: i4sa, consecutiveHolds: consecutiveHolds,
          velocityDir: velocityDir, period: period,
          isCloseGame: closeGame, oppIndicatorCount: oppCount,
        });
        bwcResults[bwcTier].n++;
        if (r.ctrl_team_won) bwcResults[bwcTier].wins++;
        bwcByCheckpoint[cp][bwcTier].n++;
        if (r.ctrl_team_won) bwcByCheckpoint[cp][bwcTier].wins++;
      }
    }
  }

  // Add pct to all result buckets
  function addPct(obj) {
    for (var k of Object.keys(obj)) {
      if (obj[k].n != null) {
        obj[k].pct = obj[k].n > 0 ? Math.round(obj[k].wins / obj[k].n * 1000) / 10 : null;
      } else if (typeof obj[k] === 'object') {
        addPct(obj[k]);
      }
    }
  }
  addPct(buyResults);
  addPct(bwcResults);
  addPct(buyByCheckpoint);
  addPct(bwcByCheckpoint);
  addPct(buyTierDeficit);
  addPct(closeGameTiers);

  // Summary comparison: what would accuracy be if we ONLY sent Tier A? A+B?
  var buyAOnly = buyResults.A;
  var buyAB = { n: buyResults.A.n + buyResults.B.n, wins: buyResults.A.wins + buyResults.B.wins };
  buyAB.pct = buyAB.n > 0 ? Math.round(buyAB.wins / buyAB.n * 1000) / 10 : null;
  var buyAll = { n: buyResults.A.n + buyResults.B.n + buyResults.C.n,
                 wins: buyResults.A.wins + buyResults.B.wins + buyResults.C.wins };
  buyAll.pct = buyAll.n > 0 ? Math.round(buyAll.wins / buyAll.n * 1000) / 10 : null;

  var bwcAOnly = bwcResults.A;
  var bwcAB = { n: bwcResults.A.n + bwcResults.B.n, wins: bwcResults.A.wins + bwcResults.B.wins };
  bwcAB.pct = bwcAB.n > 0 ? Math.round(bwcAB.wins / bwcAB.n * 1000) / 10 : null;

  // Volume impact: how many alerts LOST by suppressing Tier C?
  var buyVolumeImpact = {
    current_fires: buyAll.n,
    current_accuracy: buyAll.pct,
    tier_a_only: { fires: buyResults.A.n, accuracy: buyResults.A.pct, pct_of_current: Math.round(buyResults.A.n / buyAll.n * 1000) / 10 },
    tier_ab: { fires: buyAB.n, accuracy: buyAB.pct, pct_of_current: Math.round(buyAB.n / buyAll.n * 1000) / 10 },
    tier_c_suppressed: { fires: buyResults.C.n, accuracy: buyResults.C.pct, pct_of_losers_removed: buyResults.C.n > 0 ? Math.round((buyResults.C.n - buyResults.C.wins) / (buyAll.n - buyAll.wins) * 1000) / 10 : null },
  };

  return {
    description: 'Simulates tiered alert classification against 9,861 backtest snapshots. Temporal metrics (holds, velocity) computed from checkpoint sequence. I4 sub-agreement from pbp_derived.',
    buy_by_tier: buyResults,
    bwc_by_tier: bwcResults,
    buy_by_checkpoint: buyByCheckpoint,
    bwc_by_checkpoint: bwcByCheckpoint,
    buy_tier_x_deficit: buyTierDeficit,
    close_game_tiers: closeGameTiers,
    buy_volume_impact: buyVolumeImpact,
    headline: {
      buy_tier_a_accuracy: buyResults.A.pct,
      buy_tier_ab_accuracy: buyAB.pct,
      buy_all_accuracy: buyAll.pct,
      bwc_tier_a_accuracy: bwcResults.A.pct,
      bwc_tier_ab_accuracy: bwcAB.pct,
      buy_tier_c_would_suppress: buyResults.C.n,
      buy_tier_c_correct_kills: buyResults.C.n - buyResults.C.wins,
    },
  };
}

// ── REPORT: BUY PROFILE — what separates winning BUYs from losing BUYs ──────
async function reportBuyProfile(sql) {
  const rows = await sql`
    SELECT game_id, checkpoint,
           margin_at_snapshot AS margin,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl,
           home_alias,
           indicators->>'I1' AS i1, indicators->>'I2' AS i2,
           indicators->>'I3' AS i3, indicators->>'I4' AS i4, indicators->>'I5' AS i5,
           (conviction->>'tier') AS tier,
           ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  const cpOrder = ['Q1_6','Q1_END','Q2_6','Q2_END','Q3_6','Q3_END','Q4_6','Q4_END'];
  const cpIndex = {};
  for (let i = 0; i < cpOrder.length; i++) cpIndex[cpOrder[i]] = i;

  // ── Build game-indexed lookup for prior-checkpoint floor delta ──
  const byGame = {};
  for (const r of rows) {
    if (!byGame[r.game_id]) byGame[r.game_id] = {};
    byGame[r.game_id][r.checkpoint] = r;
  }

  // ── Helper: ctrl-relative indicator state ──
  function ctrlInd(r, key) {
    const raw = parseFloat(r[key.toLowerCase()]);
    if (isNaN(raw)) return null;
    const ctrlHome = r.ctrl === r.home_alias;
    const v = ctrlHome ? raw : 1 - raw;
    return v === 1 ? 'won' : v === 0 ? 'lost' : 'even';
  }

  // ── Helper: opponent indicator state (inverse of ctrl) ──
  function oppInd(r, key) {
    const raw = parseFloat(r[key.toLowerCase()]);
    if (isNaN(raw)) return null;
    const ctrlHome = r.ctrl === r.home_alias;
    const v = ctrlHome ? raw : 1 - raw;
    return v === 0 ? 'won' : v === 1 ? 'lost' : 'even';
  }

  // ── Enrich each row with derived fields ──
  const enriched = [];
  for (const r of rows) {
    const ctrlHome = r.ctrl === r.home_alias;
    const ctrlMargin = ctrlHome ? r.margin : -r.margin;

    // BUY eligible: floor >= 0.65, trailing 1-15
    if (r.floor < 0.65 || ctrlMargin > 0 || ctrlMargin < -15) continue;

    // Ctrl indicators won
    const ctrlWon = [];
    const oppWon = [];
    for (const k of ['I1','I2','I3','I4','I5']) {
      if (ctrlInd(r, k) === 'won') ctrlWon.push(k);
      if (oppInd(r, k) === 'won') oppWon.push(k);
    }

    // Floor delta from prior checkpoint
    const cpIdx = cpIndex[r.checkpoint];
    let floorDelta = null;
    if (cpIdx > 0) {
      const priorCp = cpOrder[cpIdx - 1];
      const priorRow = byGame[r.game_id]?.[priorCp];
      if (priorRow && priorRow.floor != null) {
        floorDelta = Math.round((r.floor - priorRow.floor) * 1000) / 1000;
      }
    }

    enriched.push({
      game_id: r.game_id,
      checkpoint: r.checkpoint,
      floor: r.floor,
      ctrlMargin,
      won: !!r.ctrl_team_won,
      tier: r.tier,
      ctrlWon,
      ctrlCombo: ctrlWon.length > 0 ? ctrlWon.join('+') : 'NONE',
      ctrlCount: ctrlWon.length,
      oppWon,
      oppCombo: oppWon.length > 0 ? oppWon.join('+') : 'NONE',
      oppCount: oppWon.length,
      floorDelta,
      defBucket: Math.abs(ctrlMargin) >= 10 ? 'trail_10+' : Math.abs(ctrlMargin) >= 5 ? 'trail_5-9' : 'trail_1-4',
      periodBucket: r.checkpoint.startsWith('Q1') ? 'Q1' : r.checkpoint.startsWith('Q2') ? 'Q2' : r.checkpoint.startsWith('Q3') ? 'Q3' : 'Q4',
    });
  }

  const total = enriched.length;
  const totalWins = enriched.filter(s => s.won).length;

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 1: Control-team indicator combos for BUY
  // ══════════════════════════════════════════════════════════════════════════
  const comboCounts = {};
  for (const s of enriched) {
    if (!comboCounts[s.ctrlCombo]) comboCounts[s.ctrlCombo] = { n: 0, wins: 0 };
    comboCounts[s.ctrlCombo].n++;
    if (s.won) comboCounts[s.ctrlCombo].wins++;
  }
  const ctrlCombos = Object.entries(comboCounts)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([combo, v]) => ({ combo, n: v.n, wins: v.wins, pct: Math.round(v.wins / v.n * 1000) / 10 }));

  // Also do pairs
  const pairCounts = {};
  for (const s of enriched) {
    for (let i = 0; i < s.ctrlWon.length; i++) {
      for (let j = i + 1; j < s.ctrlWon.length; j++) {
        const pair = s.ctrlWon[i] + '+' + s.ctrlWon[j];
        if (!pairCounts[pair]) pairCounts[pair] = { n: 0, wins: 0 };
        pairCounts[pair].n++;
        if (s.won) pairCounts[pair].wins++;
      }
    }
  }
  const ctrlPairs = Object.entries(pairCounts)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([pair, v]) => ({ pair, n: v.n, wins: v.wins, pct: Math.round(v.wins / v.n * 1000) / 10 }));

  // Single indicator impact
  const singleImpact = {};
  for (const k of ['I1','I2','I3','I4','I5']) {
    for (const state of ['won','even','lost']) {
      const group = enriched.filter(s => ctrlInd({ i1: '', i2: '', i3: '', i4: '', i5: '', ctrl: 'x', home_alias: 'x', ...s }, k) === state);
      // Re-derive from ctrlWon
      let grp;
      if (state === 'won') grp = enriched.filter(s => s.ctrlWon.includes(k));
      else if (state === 'lost') grp = enriched.filter(s => s.oppWon.includes(k));
      else grp = enriched.filter(s => !s.ctrlWon.includes(k) && !s.oppWon.includes(k));

      const w = grp.filter(s => s.won).length;
      if (!singleImpact[k]) singleImpact[k] = {};
      singleImpact[k][state] = { n: grp.length, wins: w, pct: grp.length > 0 ? Math.round(w / grp.length * 1000) / 10 : null };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 2: Floor trajectory at BUY moment
  // ══════════════════════════════════════════════════════════════════════════
  const withDelta = enriched.filter(s => s.floorDelta !== null);
  const deltaBuckets = [
    { label: 'rising_strong (>+0.10)', test: d => d > 0.10 },
    { label: 'rising_mild (+0.01 to +0.10)', test: d => d > 0 && d <= 0.10 },
    { label: 'stable (-0.01 to +0.01)', test: d => d >= -0.01 && d <= 0.01 },  // intentional overlap at 0, handle order
    { label: 'declining_mild (-0.10 to -0.01)', test: d => d < -0.01 && d >= -0.10 },
    { label: 'declining_strong (<-0.10)', test: d => d < -0.10 },
  ];
  // Fix stable bucket — needs to not match rising_mild or declining_mild
  const floorTrajectory = {};
  for (const s of withDelta) {
    let label;
    if (s.floorDelta > 0.10) label = 'rising_strong';
    else if (s.floorDelta > 0.01) label = 'rising_mild';
    else if (s.floorDelta >= -0.01) label = 'stable';
    else if (s.floorDelta >= -0.10) label = 'declining_mild';
    else label = 'declining_strong';

    if (!floorTrajectory[label]) floorTrajectory[label] = { n: 0, wins: 0 };
    floorTrajectory[label].n++;
    if (s.won) floorTrajectory[label].wins++;
  }
  for (const k of Object.keys(floorTrajectory)) {
    floorTrajectory[k].pct = Math.round(floorTrajectory[k].wins / floorTrajectory[k].n * 1000) / 10;
  }

  // Floor delta by checkpoint (does trajectory matter more at certain points?)
  const trajectoryByCheckpoint = {};
  for (const s of withDelta) {
    if (!trajectoryByCheckpoint[s.checkpoint]) trajectoryByCheckpoint[s.checkpoint] = { rising: { n: 0, wins: 0 }, stable: { n: 0, wins: 0 }, declining: { n: 0, wins: 0 } };
    const bucket = s.floorDelta > 0.01 ? 'rising' : s.floorDelta < -0.01 ? 'declining' : 'stable';
    trajectoryByCheckpoint[s.checkpoint][bucket].n++;
    if (s.won) trajectoryByCheckpoint[s.checkpoint][bucket].wins++;
  }
  for (const cp of Object.keys(trajectoryByCheckpoint)) {
    for (const b of ['rising', 'stable', 'declining']) {
      const v = trajectoryByCheckpoint[cp][b];
      v.pct = v.n > 0 ? Math.round(v.wins / v.n * 1000) / 10 : null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 3: Multivariate "golden BUY" stacks
  // ══════════════════════════════════════════════════════════════════════════
  function stackWinRate(filter, label) {
    const group = enriched.filter(filter);
    const wins = group.filter(s => s.won).length;
    return { label, n: group.length, wins, pct: group.length > 0 ? Math.round(wins / group.length * 1000) / 10 : null };
  }

  const stacks = [
    // Baseline
    stackWinRate(() => true, 'ALL BUY-eligible'),

    // Deficit
    stackWinRate(s => s.defBucket === 'trail_1-4', 'trail 1-4'),
    stackWinRate(s => s.defBucket === 'trail_5-9', 'trail 5-9'),
    stackWinRate(s => s.defBucket === 'trail_10+', 'trail 10+'),

    // Indicator count
    stackWinRate(s => s.ctrlCount >= 3, '3+ ctrl indicators'),
    stackWinRate(s => s.ctrlCount >= 4, '4+ ctrl indicators'),
    stackWinRate(s => s.ctrlCount <= 2, '≤2 ctrl indicators'),

    // Opponent profile
    stackWinRate(s => s.oppCount === 0, 'opponent 0 indicators'),
    stackWinRate(s => s.oppCount <= 1, 'opponent ≤1 indicator'),
    stackWinRate(s => s.oppWon.includes('I1'), 'opponent I1 won'),
    stackWinRate(s => s.oppWon.includes('I2'), 'opponent I2 won'),
    stackWinRate(s => s.oppWon.includes('I1') || s.oppWon.includes('I2'), 'opponent I1 OR I2 won'),
    stackWinRate(s => s.oppCount >= 1 && !s.oppWon.includes('I1') && !s.oppWon.includes('I2'), 'opponent indicator(s) but NOT I1/I2'),

    // Two-factor stacks
    stackWinRate(s => s.defBucket === 'trail_1-4' && s.ctrlCount >= 3, 'trail 1-4 + 3+ ind'),
    stackWinRate(s => s.defBucket === 'trail_1-4' && s.oppCount <= 1, 'trail 1-4 + opp ≤1'),
    stackWinRate(s => s.ctrlCount >= 3 && s.oppCount <= 1, '3+ ind + opp ≤1'),
    stackWinRate(s => s.defBucket === 'trail_1-4' && !(s.oppWon.includes('I1') || s.oppWon.includes('I2')), 'trail 1-4 + no opp I1/I2'),
    stackWinRate(s => s.ctrlCount >= 3 && !(s.oppWon.includes('I1') || s.oppWon.includes('I2')), '3+ ind + no opp I1/I2'),

    // Three-factor stacks (golden BUY candidates)
    stackWinRate(s => s.defBucket === 'trail_1-4' && s.ctrlCount >= 3 && s.oppCount <= 1, 'trail 1-4 + 3+ ind + opp ≤1'),
    stackWinRate(s => s.defBucket === 'trail_1-4' && s.ctrlCount >= 3 && !(s.oppWon.includes('I1') || s.oppWon.includes('I2')), 'trail 1-4 + 3+ ind + no opp I1/I2'),
    stackWinRate(s => s.defBucket === 'trail_1-4' && s.ctrlCount >= 4, 'trail 1-4 + 4+ ind'),
    stackWinRate(s => s.defBucket === 'trail_1-4' && s.ctrlCount >= 3 && s.oppCount === 0, 'trail 1-4 + 3+ ind + opp 0'),

    // With floor trajectory (subset with delta available)
    stackWinRate(s => s.floorDelta != null && s.floorDelta > 0.01, 'rising floor (>+0.01)'),
    stackWinRate(s => s.floorDelta != null && s.floorDelta < -0.01, 'declining floor (<-0.01)'),
    stackWinRate(s => s.defBucket === 'trail_1-4' && s.ctrlCount >= 3 && s.floorDelta != null && s.floorDelta > 0.01, 'trail 1-4 + 3+ ind + rising floor'),
    stackWinRate(s => s.defBucket === 'trail_1-4' && s.ctrlCount >= 3 && !(s.oppWon.includes('I1') || s.oppWon.includes('I2')) && s.floorDelta != null && s.floorDelta > 0.01, 'trail 1-4 + 3+ ind + no opp I1/I2 + rising'),

    // I4-specific stacks (testing whether I4 adds discriminating power for BUY)
    stackWinRate(s => s.ctrlWon.includes('I4'), 'ctrl I4 won'),
    stackWinRate(s => s.oppWon.includes('I4'), 'opp I4 won'),
    stackWinRate(s => !s.ctrlWon.includes('I4') && !s.oppWon.includes('I4'), 'I4 even'),
    stackWinRate(s => s.ctrlWon.includes('I4') && s.ctrlWon.includes('I5'), 'ctrl I4+I5'),
    stackWinRate(s => s.ctrlWon.includes('I4') && s.defBucket === 'trail_1-4', 'ctrl I4 won + trail 1-4'),
    stackWinRate(s => s.oppWon.includes('I4') && s.defBucket === 'trail_1-4', 'opp I4 won + trail 1-4'),
  ];

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 4: Checkpoint × deficit interaction
  // ══════════════════════════════════════════════════════════════════════════
  const cpDefGrid = {};
  const defLabels = ['trail_1-4', 'trail_5-9', 'trail_10+'];
  const periodLabels = ['Q1', 'Q2', 'Q3', 'Q4'];
  for (const p of periodLabels) {
    cpDefGrid[p] = {};
    for (const d of defLabels) {
      const group = enriched.filter(s => s.periodBucket === p && s.defBucket === d);
      const wins = group.filter(s => s.won).length;
      cpDefGrid[p][d] = { n: group.length, wins, pct: group.length > 0 ? Math.round(wins / group.length * 1000) / 10 : null };
    }
    // Period totals
    const pGroup = enriched.filter(s => s.periodBucket === p);
    const pWins = pGroup.filter(s => s.won).length;
    cpDefGrid[p].total = { n: pGroup.length, wins: pWins, pct: pGroup.length > 0 ? Math.round(pWins / pGroup.length * 1000) / 10 : null };
  }

  // Also by individual checkpoint (Q2_6, Q2_END, etc.) for trail_1-4 only
  const cpDetailTrail14 = {};
  for (const cp of cpOrder) {
    const group = enriched.filter(s => s.checkpoint === cp && s.defBucket === 'trail_1-4');
    const wins = group.filter(s => s.won).length;
    cpDetailTrail14[cp] = { n: group.length, wins, pct: group.length > 0 ? Math.round(wins / group.length * 1000) / 10 : null };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION 5: Winners vs Losers comparison table
  // ══════════════════════════════════════════════════════════════════════════
  function profileWL(group) {
    const n = group.length;
    if (n === 0) return {};
    let floorSum = 0, deltaSum = 0, deltaCount = 0;
    const defDist = {}, cpDist = {}, indCountDist = {}, oppCountDist = {};
    for (const s of group) {
      floorSum += s.floor;
      if (s.floorDelta != null) { deltaSum += s.floorDelta; deltaCount++; }
      defDist[s.defBucket] = (defDist[s.defBucket] || 0) + 1;
      cpDist[s.periodBucket] = (cpDist[s.periodBucket] || 0) + 1;
      indCountDist[s.ctrlCount] = (indCountDist[s.ctrlCount] || 0) + 1;
      oppCountDist[s.oppCount] = (oppCountDist[s.oppCount] || 0) + 1;
    }
    return {
      n,
      avg_floor: Math.round(floorSum / n * 100) / 100,
      avg_floor_delta: deltaCount > 0 ? Math.round(deltaSum / deltaCount * 1000) / 1000 : null,
      deficit_dist: Object.fromEntries(Object.entries(defDist).map(([k, v]) => [k, { n: v, pct: Math.round(v / n * 1000) / 10 }])),
      period_dist: Object.fromEntries(Object.entries(cpDist).map(([k, v]) => [k, { n: v, pct: Math.round(v / n * 1000) / 10 }])),
      ctrl_indicator_count: Object.fromEntries(Object.entries(indCountDist).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => [k, { n: v, pct: Math.round(v / n * 1000) / 10 }])),
      opp_indicator_count: Object.fromEntries(Object.entries(oppCountDist).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => [k, { n: v, pct: Math.round(v / n * 1000) / 10 }])),
      has_opp_I1_or_I2: Math.round(group.filter(s => s.oppWon.includes('I1') || s.oppWon.includes('I2')).length / n * 1000) / 10,
    };
  }

  const winners = enriched.filter(s => s.won);
  const losers = enriched.filter(s => !s.won);

  return {
    description: 'BUY profile analysis — what separates winning BUYs from losing BUYs. BUY eligible = floor >= 0.65, ctrl trailing 1-15.',
    baseline: { total, wins: totalWins, pct: Math.round(totalWins / total * 1000) / 10 },
    section_1_ctrl_combos: {
      description: 'Control team indicator combinations for BUY-eligible snapshots',
      combos: ctrlCombos,
      pairs: ctrlPairs,
      single_indicator_impact: singleImpact,
    },
    section_2_floor_trajectory: {
      description: 'Floor delta from prior checkpoint at BUY-eligible moment',
      snapshots_with_delta: withDelta.length,
      by_delta_bucket: floorTrajectory,
      by_checkpoint: trajectoryByCheckpoint,
    },
    section_3_golden_stacks: {
      description: 'Multivariate combinations — do discriminators compound?',
      stacks: stacks.filter(s => s.n > 0),
    },
    section_4_checkpoint_deficit: {
      description: 'Period × deficit depth interaction for BUY',
      grid: cpDefGrid,
      trail_1_4_by_checkpoint: cpDetailTrail14,
    },
    section_5_winner_vs_loser: {
      description: 'Side-by-side profile comparison',
      winners: profileWL(winners),
      losers: profileWL(losers),
    },
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
      case 'report_indicators': result = await reportIndicators(sql); break;
      case 'report_combos':     result = await reportCombos(sql); break;
      case 'report_alerts_by_cp': result = await reportAlertSimByCheckpoint(sql); break;
      case 'report_stability':  result = await reportStability(sql); break;
      case 'report_margin_floor': result = await reportMarginFloor(sql); break;
      case 'report_velocity':   result = await reportFloorVelocity(sql); break;
      case 'report_autopsy':    result = await reportLosingAutopsy(sql); break;
      case 'report_conviction_deficit': result = await reportConvictionDeficit(sql); break;
      case 'report_i4_split':   result = await reportI4Split(sql); break;
      case 'report_velocity_at_alert': result = await reportVelocityAtAlert(sql); break;
      case 'report_consecutive_holds': result = await reportConsecutiveHolds(sql); break;
      case 'report_flip_recovery': result = await reportFlipRecovery(sql); break;
      case 'report_opponent_profile': result = await reportOpponentProfile(sql); break;
      case 'report_tier_sim': result = await reportTierSim(sql); break;
      case 'report_bwc_erosion': result = await reportBWCErosion(sql); break;
      case 'report_value_play': result = await reportValuePlay(sql); break;
      case 'report_buy_profile': result = await reportBuyProfile(sql); break;
      case 'report_buy_deep': {
        const [convDef, autopsy, marginFloor, alertsByCp, oppProfile] = await Promise.all([
          reportConvictionDeficit(sql),
          reportLosingAutopsy(sql),
          reportMarginFloor(sql),
          reportAlertSimByCheckpoint(sql),
          reportOpponentProfile(sql),
        ]);
        result = { conviction_deficit: convDef, autopsy, margin_floor: marginFloor, alerts_by_checkpoint: alertsByCp, opponent_profile: oppProfile };
        break;
      }
      case 'validate': result = await phaseValidate(sql); break;
      case 'diagnose_buy_gap': result = await diagnoseBuyGap(sql); break;
      case 'report_all':        result = await phaseReportAll(sql); break;
      case 'status':            result = await phaseStatus(sql); break;
      case 'wipe_indicators':    result = await phaseWipeIndicators(sql); break;
      case 'inspect':           result = await phaseInspect(sql, url); break;
      default:
        result = { error: `Unknown phase: ${phase}. Use init, snapshot, compute, wipe_indicators, report_all, report_calibration, report_time, report_alert_sim, status, inspect.` };
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

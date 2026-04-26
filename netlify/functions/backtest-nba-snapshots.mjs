// NBA Snapshot Backtest — In-game indicator accuracy
// Walks each game's PBP and emits 14 checkpoint snapshots (3-min intervals from Q2):
//   Q1@6:00, Q1_END, Q2@9:00, Q2@6:00, Q2@3:00, Q2_END, Q3@9:00, Q3@6:00, Q3@3:00, Q3_END, Q4@9:00, Q4@6:00, Q4@3:00, Q4_END
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

// Checkpoint definitions — 14 per game (3-min intervals from Q2 onward)
// clock_remaining = seconds left in that period (720 = 12:00 start, 0 = end)
const CHECKPOINTS = [
  { label: 'Q1_6', period: 1, clockSec: 360 },
  { label: 'Q1_END', period: 1, clockSec: 0 },
  { label: 'Q2_9', period: 2, clockSec: 540 },
  { label: 'Q2_6', period: 2, clockSec: 360 },
  { label: 'Q2_3', period: 2, clockSec: 180 },
  { label: 'Q2_END', period: 2, clockSec: 0 },
  { label: 'Q3_9', period: 3, clockSec: 540 },
  { label: 'Q3_6', period: 3, clockSec: 360 },
  { label: 'Q3_3', period: 3, clockSec: 180 },
  { label: 'Q3_END', period: 3, clockSec: 0 },
  { label: 'Q4_9', period: 4, clockSec: 540 },
  { label: 'Q4_6', period: 4, clockSec: 360 },
  { label: 'Q4_3', period: 4, clockSec: 180 },
  { label: 'Q4_END', period: 4, clockSec: 0 },
];
const CP_LABELS = CHECKPOINTS.map(c => c.label);

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

  // Flip: need ≥2 gap. Contested: opponent within 75% of leader's biggest lead.
  let i4subA = 0;
  if (hBigLead >= aBigLead + 2) {
    i4subA = (aBigLead >= 0.75 * hBigLead) ? 0 : 1;
  } else if (aBigLead >= hBigLead + 2) {
    i4subA = (hBigLead >= 0.75 * aBigLead) ? 0 : -1;
  }
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

// ── PHASE: SNAPSHOT — walk PBP, emit 14 checkpoints per game ────────────────
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
  const checkpoints = CP_LABELS;

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
  const checkpoints = CP_LABELS;
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

  const checkpoints = CP_LABELS;
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

  const checkpoints = CP_LABELS;

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

  const checkpoints = CP_LABELS;

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
  const checkpoints = CP_LABELS;
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

  const checkpoints = CP_LABELS;
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
    let subA = 0;
    if (hBL >= aBL + 2) { subA = (aBL >= 0.75 * hBL) ? 0 : 1; }
    else if (aBL >= hBL + 2) { subA = (hBL >= 0.75 * aBL) ? 0 : -1; }

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

  const checkpoints = CP_LABELS;
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

  const checkpoints = CP_LABELS;
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

  const checkpoints = CP_LABELS;
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

  var checkpoints = CP_LABELS;
  var cpPeriod = Object.fromEntries(CHECKPOINTS.map(c => [c.label, c.period]));

  var games = {};
  for (var r of rows) {
    if (!games[r.game_id]) games[r.game_id] = {};
    games[r.game_id][r.checkpoint] = r;
  }

  function getI4SubAgree(r) {
    if (!r || !r.pbp_derived) return 'MIXED';
    var pd = typeof r.pbp_derived === 'string' ? JSON.parse(r.pbp_derived) : r.pbp_derived;
    var hBL = pd.hBigLead || 0, aBL = pd.aBigLead || 0;
    var subA = 0;
    if (hBL >= aBL + 2) { subA = (aBL >= 0.75 * hBL) ? 0 : 1; }
    else if (aBL >= hBL + 2) { subA = (hBL >= 0.75 * aBL) ? 0 : -1; }
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
    if (oppCount >= 3) return 'C';
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

  var checkpoints = CP_LABELS;
  var cpPeriod = Object.fromEntries(CHECKPOINTS.map(c => [c.label, c.period]));

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
    if (oppCount >= 3) return 'C';
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

  var checkpoints = CP_LABELS;
  var cpPeriod = Object.fromEntries(CHECKPOINTS.map(c => [c.label, c.period]));

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
    var subA = 0;
    if (hBL >= aBL + 2) { subA = (aBL >= 0.75 * hBL) ? 0 : 1; }
    else if (aBL >= hBL + 2) { subA = (hBL >= 0.75 * aBL) ? 0 : -1; }
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
      if (oppCount >= 3) return 'C';
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

  const cpOrder = CP_LABELS;
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

// ── REPORT: TIER JOURNEY — Floor trajectory, tier persistence, BWC lifecycle ─
// ?phase=report_tier_journey          — full dataset
// ?phase=report_tier_journey&close=1  — competitive games (within 5 in Q3, within 7 in Q4)
async function reportTierJourney(sql, url) {
  var closeOnly = url?.searchParams?.get('close') === '1';

  var rows = await sql`
    SELECT game_id, checkpoint, margin_at_snapshot AS margin,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl,
           indicators->>'homeAlias' AS home_alias,
           indicators->>'awayAlias' AS away_alias,
           (indicators->>'I1')::text AS i1raw, (indicators->>'I2')::text AS i2raw,
           (indicators->>'I3')::text AS i3raw, (indicators->>'I4')::text AS i4raw,
           (indicators->>'I5')::text AS i5raw,
           (conviction->>'tier') AS conv_tier,
           (conviction->>'count')::int AS ind_count,
           pbp_derived,
           ctrl_team_won, final_margin
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  var checkpoints = CP_LABELS;

  // Group by game
  var games = {};
  for (var r of rows) {
    if (!games[r.game_id]) games[r.game_id] = [];
    games[r.game_id].push(r);
  }

  // Competitive game filter: within 5 at any Q3 checkpoint, OR within 7 at any Q4 checkpoint
  var Q3_CPS = new Set(['Q3_9','Q3_6','Q3_3','Q3_END']);
  var Q4_CPS = new Set(['Q4_9','Q4_6','Q4_3','Q4_END']);
  if (closeOnly) {
    var allGameIds = Object.keys(games);
    for (var gid of allGameIds) {
      var snaps = games[gid];
      var competitive = snaps.some(function(s) {
        var absM = Math.abs(s.margin);
        if (Q3_CPS.has(s.checkpoint) && absM <= 5) return true;
        if (Q4_CPS.has(s.checkpoint) && absM <= 7) return true;
        return false;
      });
      if (!competitive) delete games[gid];
    }
  }

  // ── Helpers (same as reportBWCErosion) ──
  function getCtrlMargin(r) {
    return (r.ctrl === r.home_alias) ? r.margin : -r.margin;
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

  function classifyBWCTier(conv, lead, holds, oppCount) {
    if (conv === 'DOMINANT' && lead >= 8 && holds >= 4 && oppCount <= 1) return 'A';
    if (oppCount >= 3) return 'C';
    if ((conv === 'DOMINANT' || conv === 'STRONG') && lead >= 3 && holds >= 2) return 'B';
    return 'C';
  }

  function classifyDeficit(ctrlMargin) {
    if (ctrlMargin >= 8) return 'lead_8+';
    if (ctrlMargin >= 3) return 'lead_3-7';
    if (ctrlMargin >= 1) return 'lead_1-2';
    if (ctrlMargin >= -2) return 'tied';
    if (ctrlMargin >= -4) return 'trail_1-4';
    if (ctrlMargin >= -9) return 'trail_5-9';
    return 'trail_10+';
  }

  // ── Per-game analysis ──
  // Section 1: Tier trajectory (tier at each checkpoint for BWC-eligible teams)
  var tierAtFire = { A: { n: 0, wins: 0 }, B: { n: 0, wins: 0 }, C: { n: 0, wins: 0 } };
  var tierAtFireByCp = {};
  for (var cp of checkpoints) tierAtFireByCp[cp] = { A: { n:0,wins:0 }, B: { n:0,wins:0 }, C: { n:0,wins:0 } };

  // Section 2: Tier graduation tracking
  var graduations = {
    c_to_b: { n: 0, wins: 0 },
    c_to_a: { n: 0, wins: 0 },
    b_to_a: { n: 0, wins: 0 },
    stayed_c: { n: 0, wins: 0 },
    stayed_b: { n: 0, wins: 0 },
    born_a: { n: 0, wins: 0 },   // first fire was already A
    born_b: { n: 0, wins: 0 },   // first fire was already B
  };

  // Section 3: Tier persistence (how many checkpoints at peak tier)
  var persistenceBuckets = {
    '1 cp': { n: 0, wins: 0 },
    '2-3 cp': { n: 0, wins: 0 },
    '4-5 cp': { n: 0, wins: 0 },
    '6+ cp': { n: 0, wins: 0 },
  };

  // Section 4: First BWC team analysis — did the first BWC team win?
  var firstBWC = { same_team_won: 0, different_team_won: 0, total: 0, flip_counts: {} };

  // Section 5: Floor trajectory of winning vs losing BWC teams
  var floorTrajectory = { winners: [], losers: [] };

  // Section 6: Control path (wire-to-wire vs contested)
  var controlPath = {
    wire_to_wire: { n: 0, wins: 0 },   // same ctrl all checkpoints, never trailed
    early_lock: { n: 0, wins: 0 },      // ctrl settled by Q2_END, no flip after
    contested: { n: 0, wins: 0 },       // ctrl flipped at least once
    late_flip: { n: 0, wins: 0 },       // ctrl flipped in Q3+
  };

  // Section 7: Early signals — Q1/Q2 profile of teams that eventually reached A
  var earlySignals = {
    eventual_A: { q1_floors: [], q2_floors: [], q1_convictions: {}, q1_leads: [] },
    eventual_B: { q1_floors: [], q2_floors: [], q1_convictions: {}, q1_leads: [] },
    stayed_C: { q1_floors: [], q2_floors: [], q1_convictions: {}, q1_leads: [] },
  };

  // Section 8: Floor hold quality between checkpoints
  var floorHolds = {
    stable: { n: 0, wins: 0 },    // floor delta ≤ 0.03
    growing: { n: 0, wins: 0 },   // floor delta > 0.03
    eroding: { n: 0, wins: 0 },   // floor delta < -0.03
    collapsing: { n: 0, wins: 0 }, // floor delta < -0.10
  };

  // Section 9: Floor plateau detection
  var plateaus = {
    plateaued: { n: 0, wins: 0 },      // ±0.03 for 3+ consecutive checkpoints
    still_building: { n: 0, wins: 0 },  // rising trend in last 3 checkpoints
    declining: { n: 0, wins: 0 },       // declining trend in last 3 checkpoints
  };

  // Section 10: One-sided vs fought games
  var gameNature = {
    one_sided: { n: 0, wins: 0 },    // ctrl team led at every checkpoint
    fought: { n: 0, wins: 0 },       // ctrl team trailed at some point
    comeback: { n: 0, wins: 0 },     // ctrl team trailed 5+ at some point
  };

  var totalGames = 0;

  // Section 11: Graduation timing — when does team first reach peak tier?
  var gradTiming = {};
  for (var cp of checkpoints) gradTiming[cp] = { to_a: { n:0,wins:0 }, to_b: { n:0,wins:0 } };

  // Section 12: Conditions at graduation (floor + margin + lead bucket)
  var gradConditions = {
    to_a: { floors: [], margins: [], leads: [] },
    to_b: { floors: [], margins: [], leads: [] },
  };

  // Section 13: Q1→Q2 floor acceleration as standalone predictor
  var accelBuckets = {
    'surge (>0.08)': { n: 0, wins: 0, grad_a: 0, grad_b: 0 },
    'climb (0.04-0.08)': { n: 0, wins: 0, grad_a: 0, grad_b: 0 },
    'flat (-0.02 to 0.04)': { n: 0, wins: 0, grad_a: 0, grad_b: 0 },
    'declining (<-0.02)': { n: 0, wins: 0, grad_a: 0, grad_b: 0 },
  };

  // Section 14: Value window — graduated tier × margin at graduation
  var valueWindow = {
    a_lead_1_4: { n:0, wins:0 },
    a_lead_5_8: { n:0, wins:0 },
    a_lead_9_plus: { n:0, wins:0 },
    b_lead_1_4: { n:0, wins:0 },
    b_lead_5_8: { n:0, wins:0 },
    b_lead_9_plus: { n:0, wins:0 },
  };

  // Section 15: Time-to-graduate (checkpoints from first fire to peak tier)
  var timeToGrad = {
    '0 (born at peak)': { n:0, wins:0 },
    '1 cp': { n:0, wins:0 },
    '2 cp': { n:0, wins:0 },
    '3 cp': { n:0, wins:0 },
    '4+ cp': { n:0, wins:0 },
  };

  // Section 16: First team to GRADUATE (per-team independent tracking)
  var firstToGradB = { n: 0, won: 0 };
  var firstToGradA = { n: 0, won: 0 };
  var bothGradB = { n: 0, first_won: 0 };
  var onlyOneGradB = { n: 0, won: 0 };
  var firstGradBByQ = {};
  var firstGradAByQ = {};
  for (var _cp of checkpoints) { firstGradBByQ[_cp] = {n:0,wins:0}; firstGradAByQ[_cp] = {n:0,wins:0}; }

  // Section 17: Floor quality across checkpoint sequence
  var meanFloorBuckets = {
    '0.50-0.59': {n:0,wins:0}, '0.60-0.69': {n:0,wins:0}, '0.70-0.79': {n:0,wins:0},
    '0.80-0.89': {n:0,wins:0}, '0.90+': {n:0,wins:0}
  };
  var minFloorBuckets = {
    '<0.40': {n:0,wins:0}, '0.40-0.49': {n:0,wins:0}, '0.50-0.59': {n:0,wins:0},
    '0.60-0.69': {n:0,wins:0}, '0.70+': {n:0,wins:0}
  };
  var floorVarianceBuckets = {
    'tight (<0.03)': {n:0,wins:0}, 'moderate (0.03-0.08)': {n:0,wins:0},
    'volatile (0.08-0.15)': {n:0,wins:0}, 'chaotic (0.15+)': {n:0,wins:0}
  };
  var meanMinSpreadBuckets = {
    'tight (<0.05)': {n:0,wins:0}, 'moderate (0.05-0.10)': {n:0,wins:0},
    'gapped (0.10-0.20)': {n:0,wins:0}, 'dangerous (0.20+)': {n:0,wins:0}
  };

  // Section 18: Winner backtrace
  var winnerProfile = {
    total: 0, graduated_a: 0, graduated_b_only: 0, stayed_c: 0, never_bwc: 0,
    was_first_bwc_team: 0,
    was_first_to_grad_b: 0, was_second_to_grad_b: 0, was_only_to_grad_b: 0,
    was_first_to_grad_a: 0, was_second_to_grad_a: 0, was_only_to_grad_a: 0,
    gradB_cps: [], gradA_cps: [], floorAtGradB: [], floorAtGradA: [],
    marginAtGradB: [], marginAtGradA: [],
  };
  var winnerGradBByCp = {};
  var winnerGradAByCp = {};
  for (var _cp2 of checkpoints) { winnerGradBByCp[_cp2] = {n:0}; winnerGradAByCp[_cp2] = {n:0}; }
  var winnerPath = { c_to_a: 0, c_to_b: 0, b_to_a: 0, born_a: 0, born_b: 0, stayed_c: 0, never_bwc: 0 };
  var winnerCtrlPath = { wire_to_wire: 0, took_over: 0 };

  // Section 19: Mean floor × tier
  var s19_mfTier = {};
  ['A','B'].forEach(function(t) { [0.70,0.75,0.80,0.85].forEach(function(mf) {
    s19_mfTier[t+'_mf'+mf.toFixed(2)] = {n:0,wins:0};
  }); });

  // Section 20: Mean floor × checkpoint count at peak
  var s20_mfCp = {};
  [0.70,0.75,0.80].forEach(function(mf) { [2,3,4,5,6].forEach(function(cp) {
    s20_mfCp['mf'+mf.toFixed(2)+'_cp'+cp] = {n:0,wins:0};
  }); });

  // Section 21: Mean floor × only_one_grad
  var s21_mfGrad = {};
  [0.70,0.75,0.80].forEach(function(mf) {
    s21_mfGrad[mf.toFixed(2)] = { only_one: {n:0,wins:0}, both: {n:0,wins:0} };
  });

  // Section 22: PO gate simulation
  var s22_poGate = {};
  [0.70,0.75,0.80,0.85].forEach(function(mf) {
    s22_poGate[mf.toFixed(2)] = {
      would_fire: {n:0,wins:0}, would_suppress: {n:0,wins:0},
      winners_lost: 0, bad_pos_prevented: 0
    };
  });

  // Section 23: Rolling mean floor by checkpoint (winners vs losers)
  var s23_rollingMF = { winners: {}, losers: {} };
  checkpoints.forEach(function(cp) { s23_rollingMF.winners[cp] = []; s23_rollingMF.losers[cp] = []; });

  // Section 24: Mean floor + min floor combined gate
  var s24_mfMinF = {};
  [0.75,0.80].forEach(function(mf) { [0.60,0.65,0.70].forEach(function(mn) {
    s24_mfMinF['mf'+mf.toFixed(2)+'_min'+mn.toFixed(2)] = {n:0,wins:0};
  }); });

  for (var [gid, snaps] of Object.entries(games)) {
    // Build checkpoint map
    var cpMap = {};
    for (var s of snaps) cpMap[s.checkpoint] = s;

    // Need at least Q2_6 to analyze BWC
    if (!cpMap['Q2_6']) continue;

    // Walk checkpoints, compute tier at each
    var tierSeq = [];
    var floorSeq = [];
    var ctrlSeq = [];
    var marginSeq = [];
    var holdCount = 0;
    var prevCtrl = null;
    var firstFireCp = null;
    var firstFireTier = null;
    var firstFireTeam = null;
    var peakTier = 'C';
    var peakTierCps = 0;
    var currentTierRun = 0;
    var currentTier = null;
    var won = null;
    var ctrlFlips = 0;
    var lastFlipCp = null;
    var gradCp = null;      // checkpoint where peak tier was first reached
    var gradCpIdx = null;
    var gradFloor = null;
    var gradMargin = null;
    var firstFireCpIdx = null;

    // Per-team graduation tracking
    var homeA = snaps[0].home_alias;
    var awayA = snaps[0].away_alias;
    var ptHolds = {};  // per-team consecutive checkpoint holds
    ptHolds[homeA] = 0; ptHolds[awayA] = 0;
    var ptFirstB = {}; ptFirstB[homeA] = null; ptFirstB[awayA] = null;
    var ptFirstA = {}; ptFirstA[homeA] = null; ptFirstA[awayA] = null;
    var ptFirstBWC = {}; ptFirstBWC[homeA] = null; ptFirstBWC[awayA] = null;
    var ptFloorAtB = {}; ptFloorAtB[homeA] = null; ptFloorAtB[awayA] = null;
    var ptMarginAtB = {}; ptMarginAtB[homeA] = null; ptMarginAtB[awayA] = null;
    var ptFloorAtA = {}; ptFloorAtA[homeA] = null; ptFloorAtA[awayA] = null;
    var ptMarginAtA = {}; ptMarginAtA[homeA] = null; ptMarginAtA[awayA] = null;
    var ptFirstBTier = {}; ptFirstBTier[homeA] = null; ptFirstBTier[awayA] = null;

    for (var ci = 0; ci < checkpoints.length; ci++) {
      var cpLabel = checkpoints[ci];
      var snap = cpMap[cpLabel];
      if (!snap || !snap.ctrl) {
        tierSeq.push(null);
        floorSeq.push(null);
        ctrlSeq.push(null);
        marginSeq.push(null);
        continue;
      }

      won = snap.ctrl_team_won;
      var ctrlMargin = getCtrlMargin(snap);
      var oppCount = getOppCount(snap);

      // Track ctrl flips
      if (prevCtrl && prevCtrl !== snap.ctrl) {
        ctrlFlips++;
        lastFlipCp = cpLabel;
      }

      // Consecutive holds
      if (prevCtrl === snap.ctrl) holdCount++;
      else holdCount = 1;
      prevCtrl = snap.ctrl;

      // Per-team hold tracking
      var curT = snap.ctrl;
      var othT = curT === homeA ? awayA : homeA;
      ptHolds[curT]++;
      if (holdCount === 1) ptHolds[othT] = 0; // ctrl just changed

      // Is this BWC-eligible? (ctrl team leading 2+, floor ≥ 0.50)
      var bwcEligible = ctrlMargin >= 2 && snap.floor >= 0.50;
      var tier = null;
      if (bwcEligible) {
        tier = classifyBWCTier(snap.conv_tier, ctrlMargin, holdCount, oppCount);

        // Per-team graduation tracking
        if (ptFirstBWC[curT] === null) ptFirstBWC[curT] = cpLabel;
        if (ptFirstB[curT] === null && (tier === 'B' || tier === 'A')) {
          ptFirstB[curT] = cpLabel;
          ptFloorAtB[curT] = snap.floor;
          ptMarginAtB[curT] = ctrlMargin;
          ptFirstBTier[curT] = tier;
        }
        if (ptFirstA[curT] === null && tier === 'A') {
          ptFirstA[curT] = cpLabel;
          ptFloorAtA[curT] = snap.floor;
          ptMarginAtA[curT] = ctrlMargin;
        }

        // Track first fire
        if (!firstFireCp) {
          firstFireCp = cpLabel;
          firstFireCpIdx = ci;
          firstFireTier = tier;
          firstFireTeam = snap.ctrl;
          tierAtFire[tier].n++;
          if (won) tierAtFire[tier].wins++;
          tierAtFireByCp[cpLabel][tier].n++;
          if (won) tierAtFireByCp[cpLabel][tier].wins++;
        }

        // Track peak tier
        var tierRank = { A: 3, B: 2, C: 1 };
        if (tierRank[tier] > (tierRank[peakTier] || 0)) {
          peakTier = tier;
          gradCp = cpLabel;
          gradCpIdx = ci;
          gradFloor = snap.floor;
          gradMargin = ctrlMargin;
        }

        // Track current tier persistence
        if (tier === currentTier) currentTierRun++;
        else { currentTierRun = 1; currentTier = tier; }
        if (tier === peakTier) peakTierCps++;
      }

      tierSeq.push(tier);
      floorSeq.push(snap.floor);
      ctrlSeq.push(snap.ctrl);
      marginSeq.push(ctrlMargin);
    }

    // Skip games where BWC never fired
    if (!firstFireCp) continue;
    totalGames++;

    // ── Section 2: Graduation tracking ──
    // Walk tier sequence to find graduation
    var tiers = tierSeq.filter(t => t !== null);
    if (tiers.length > 0) {
      var first = tiers[0];
      var best = tiers.reduce((a, b) => {
        var rank = { A: 3, B: 2, C: 1 };
        return (rank[b] || 0) > (rank[a] || 0) ? b : a;
      }, tiers[0]);

      if (first === 'C' && best === 'A') { graduations.c_to_a.n++; if (won) graduations.c_to_a.wins++; }
      else if (first === 'C' && best === 'B') { graduations.c_to_b.n++; if (won) graduations.c_to_b.wins++; }
      else if (first === 'B' && best === 'A') { graduations.b_to_a.n++; if (won) graduations.b_to_a.wins++; }
      else if (first === 'C' && best === 'C') { graduations.stayed_c.n++; if (won) graduations.stayed_c.wins++; }
      else if (first === 'B' && best === 'B') { graduations.stayed_b.n++; if (won) graduations.stayed_b.wins++; }
      else if (first === 'A') { graduations.born_a.n++; if (won) graduations.born_a.wins++; }
      if (first === 'B' && best === 'B') { graduations.born_b.n++; if (won) graduations.born_b.wins++; }
    }

    // ── Section 3: Peak tier persistence ──
    if (peakTierCps === 1) { persistenceBuckets['1 cp'].n++; if (won) persistenceBuckets['1 cp'].wins++; }
    else if (peakTierCps <= 3) { persistenceBuckets['2-3 cp'].n++; if (won) persistenceBuckets['2-3 cp'].wins++; }
    else if (peakTierCps <= 5) { persistenceBuckets['4-5 cp'].n++; if (won) persistenceBuckets['4-5 cp'].wins++; }
    else { persistenceBuckets['6+ cp'].n++; if (won) persistenceBuckets['6+ cp'].wins++; }

    // ── Section 4: First BWC team analysis ──
    firstBWC.total++;
    // Did the first BWC team win? ctrl_team_won is relative to Q4_END ctrl.
    // We need to check if firstFireTeam won the game.
    var q4end = cpMap['Q4_END'];
    var firstTeamWon = false;
    if (q4end) {
      // If firstFireTeam is Q4_END's ctrl team and ctrl_team_won, OR
      // firstFireTeam is NOT Q4_END's ctrl team and !ctrl_team_won
      firstTeamWon = (firstFireTeam === q4end.ctrl && q4end.ctrl_team_won) ||
                     (firstFireTeam !== q4end.ctrl && !q4end.ctrl_team_won);
    }
    if (firstTeamWon) firstBWC.same_team_won++;
    else firstBWC.different_team_won++;

    // Track flip counts
    var flipKey = String(ctrlFlips);
    firstBWC.flip_counts[flipKey] = firstBWC.flip_counts[flipKey] || { n: 0, first_team_won: 0 };
    firstBWC.flip_counts[flipKey].n++;
    if (firstTeamWon) firstBWC.flip_counts[flipKey].first_team_won++;

    // ── Section 5: Floor trajectory ──
    var validFloors = floorSeq.filter(f => f !== null);
    if (validFloors.length >= 3) {
      var trajObj = {
        floors: floorSeq,
        tiers: tierSeq,
        first_fire_cp: firstFireCp,
        peak_tier: peakTier,
        final_margin: snaps[0].final_margin,
      };
      if (firstTeamWon) floorTrajectory.winners.push(trajObj);
      else floorTrajectory.losers.push(trajObj);
    }

    // ── Section 6: Control path classification ──
    var validCtrls = [];
    var validMargins = [];
    for (var ci2 = 0; ci2 < checkpoints.length; ci2++) {
      if (ctrlSeq[ci2] !== null) { validCtrls.push(ctrlSeq[ci2]); validMargins.push(marginSeq[ci2]); }
    }
    var allSameCtrl = validCtrls.every(c => c === validCtrls[0]);
    var neverTrailed = validMargins.every(m => m >= 0);

    if (allSameCtrl && neverTrailed) {
      controlPath.wire_to_wire.n++; if (firstTeamWon) controlPath.wire_to_wire.wins++;
    } else if (ctrlFlips === 0 || (lastFlipCp && checkpoints.indexOf(lastFlipCp) <= 3)) {
      controlPath.early_lock.n++; if (firstTeamWon) controlPath.early_lock.wins++;
    } else if (lastFlipCp && checkpoints.indexOf(lastFlipCp) >= 4) {
      controlPath.late_flip.n++; if (firstTeamWon) controlPath.late_flip.wins++;
    } else {
      controlPath.contested.n++; if (firstTeamWon) controlPath.contested.wins++;
    }

    // ── Section 7: Early signals ──
    var q1_6 = cpMap['Q1_6'];
    var q2_6 = cpMap['Q2_6'];
    var bucket = peakTier === 'A' ? 'eventual_A' : peakTier === 'B' ? 'eventual_B' : 'stayed_C';
    if (q1_6 && q1_6.floor) {
      earlySignals[bucket].q1_floors.push(q1_6.floor);
      var q1conv = q1_6.conv_tier || 'NONE';
      earlySignals[bucket].q1_convictions[q1conv] = (earlySignals[bucket].q1_convictions[q1conv] || 0) + 1;
      earlySignals[bucket].q1_leads.push(getCtrlMargin(q1_6));
    }
    if (q2_6 && q2_6.floor) {
      earlySignals[bucket].q2_floors.push(q2_6.floor);
    }

    // ── Section 8: Floor hold quality (checkpoint-to-checkpoint) ──
    for (var fi = 1; fi < floorSeq.length; fi++) {
      if (floorSeq[fi] === null || floorSeq[fi - 1] === null) continue;
      // Only count transitions where the team was BWC-eligible at both checkpoints
      if (tierSeq[fi] === null || tierSeq[fi - 1] === null) continue;
      var delta = floorSeq[fi] - floorSeq[fi - 1];
      if (delta < -0.10) { floorHolds.collapsing.n++; if (won) floorHolds.collapsing.wins++; }
      else if (delta < -0.03) { floorHolds.eroding.n++; if (won) floorHolds.eroding.wins++; }
      else if (delta > 0.03) { floorHolds.growing.n++; if (won) floorHolds.growing.wins++; }
      else { floorHolds.stable.n++; if (won) floorHolds.stable.wins++; }
    }

    // ── Section 9: Floor plateau detection (last 3 BWC-eligible checkpoints) ──
    var eligibleFloors = [];
    for (var pi = 0; pi < floorSeq.length; pi++) {
      if (floorSeq[pi] !== null && tierSeq[pi] !== null) eligibleFloors.push(floorSeq[pi]);
    }
    if (eligibleFloors.length >= 3) {
      var last3 = eligibleFloors.slice(-3);
      var d1 = last3[1] - last3[0], d2 = last3[2] - last3[1];
      if (Math.abs(d1) <= 0.03 && Math.abs(d2) <= 0.03) {
        plateaus.plateaued.n++; if (won) plateaus.plateaued.wins++;
      } else if (d1 > 0 && d2 > 0) {
        plateaus.still_building.n++; if (won) plateaus.still_building.wins++;
      } else if (d1 < 0 && d2 < 0) {
        plateaus.declining.n++; if (won) plateaus.declining.wins++;
      } else {
        // Mixed — count as plateaued for simplicity
        plateaus.plateaued.n++; if (won) plateaus.plateaued.wins++;
      }
    }

    // ── Section 10: Game nature ──
    var everTrailed = validMargins.some(m => m < 0);
    var deepTrail = validMargins.some(m => m <= -5);
    if (!everTrailed) {
      gameNature.one_sided.n++; if (firstTeamWon) gameNature.one_sided.wins++;
    } else if (deepTrail) {
      gameNature.comeback.n++; if (firstTeamWon) gameNature.comeback.wins++;
    } else {
      gameNature.fought.n++; if (firstTeamWon) gameNature.fought.wins++;
    }

    // ── Section 11: Graduation timing ──
    if (gradCp && peakTier !== firstFireTier) {
      var gradKey = peakTier === 'A' ? 'to_a' : 'to_b';
      gradTiming[gradCp][gradKey].n++;
      if (won) gradTiming[gradCp][gradKey].wins++;

      // Section 12: Conditions at graduation
      gradConditions[gradKey].floors.push(gradFloor);
      gradConditions[gradKey].margins.push(gradMargin);
      var leadBucket = gradMargin >= 9 ? '9+' : gradMargin >= 5 ? '5-8' : '1-4';
      gradConditions[gradKey].leads.push(leadBucket);
    }

    // ── Section 13: Q1→Q2 floor acceleration predictor ──
    var q1end = cpMap['Q1_END'];
    var q2end = cpMap['Q2_END'];
    if (q1end && q2end && q1end.floor && q2end.floor) {
      var accel = q2end.floor - q1end.floor;
      var aKey;
      if (accel > 0.08) aKey = 'surge (>0.08)';
      else if (accel >= 0.04) aKey = 'climb (0.04-0.08)';
      else if (accel >= -0.02) aKey = 'flat (-0.02 to 0.04)';
      else aKey = 'declining (<-0.02)';
      accelBuckets[aKey].n++;
      if (firstTeamWon) accelBuckets[aKey].wins++;
      if (peakTier === 'A') accelBuckets[aKey].grad_a++;
      else if (peakTier === 'B') accelBuckets[aKey].grad_b++;
    }

    // ── Section 14: Value window — graduated tier × margin at graduation ──
    if (gradCp && gradMargin != null) {
      var vwKey = null;
      if (peakTier === 'A') {
        if (gradMargin <= 4) vwKey = 'a_lead_1_4';
        else if (gradMargin <= 8) vwKey = 'a_lead_5_8';
        else vwKey = 'a_lead_9_plus';
      } else if (peakTier === 'B') {
        if (gradMargin <= 4) vwKey = 'b_lead_1_4';
        else if (gradMargin <= 8) vwKey = 'b_lead_5_8';
        else vwKey = 'b_lead_9_plus';
      }
      if (vwKey) {
        valueWindow[vwKey].n++;
        if (won) valueWindow[vwKey].wins++;
      }
    }

    // ── Section 15: Time-to-graduate (checkpoints from first fire to peak) ──
    if (gradCpIdx != null && firstFireCpIdx != null) {
      var cpsToGrad = gradCpIdx - firstFireCpIdx;
      if (cpsToGrad === 0) { timeToGrad['0 (born at peak)'].n++; if (won) timeToGrad['0 (born at peak)'].wins++; }
      else if (cpsToGrad === 1) { timeToGrad['1 cp'].n++; if (won) timeToGrad['1 cp'].wins++; }
      else if (cpsToGrad === 2) { timeToGrad['2 cp'].n++; if (won) timeToGrad['2 cp'].wins++; }
      else if (cpsToGrad === 3) { timeToGrad['3 cp'].n++; if (won) timeToGrad['3 cp'].wins++; }
      else { timeToGrad['4+ cp'].n++; if (won) timeToGrad['4+ cp'].wins++; }
    }

    // ── Section 16: First team to GRADUATE ──
    // Determine game winner
    var gameWinner = null;
    if (q4end) {
      gameWinner = q4end.ctrl_team_won ? q4end.ctrl : (q4end.ctrl === homeA ? awayA : homeA);
    }

    // First team to reach B
    var fb_home = ptFirstB[homeA], fb_away = ptFirstB[awayA];
    var firstBTeam = null;
    if (fb_home && fb_away) {
      var hIdx = checkpoints.indexOf(fb_home), aIdx = checkpoints.indexOf(fb_away);
      firstBTeam = hIdx <= aIdx ? homeA : awayA;
      bothGradB.n++;
      if (firstBTeam === gameWinner) bothGradB.first_won++;
    } else if (fb_home) {
      firstBTeam = homeA;
      onlyOneGradB.n++; if (firstBTeam === gameWinner) onlyOneGradB.won++;
    } else if (fb_away) {
      firstBTeam = awayA;
      onlyOneGradB.n++; if (firstBTeam === gameWinner) onlyOneGradB.won++;
    }
    if (firstBTeam && gameWinner) {
      firstToGradB.n++;
      if (firstBTeam === gameWinner) firstToGradB.won++;
      var fbCp = ptFirstB[firstBTeam];
      if (fbCp) { firstGradBByQ[fbCp].n++; if (firstBTeam === gameWinner) firstGradBByQ[fbCp].wins++; }
    }

    // First team to reach A
    var fa_home = ptFirstA[homeA], fa_away = ptFirstA[awayA];
    var firstATeam = null;
    if (fa_home && fa_away) {
      var hIdxA = checkpoints.indexOf(fa_home), aIdxA = checkpoints.indexOf(fa_away);
      firstATeam = hIdxA <= aIdxA ? homeA : awayA;
    } else if (fa_home) { firstATeam = homeA; }
    else if (fa_away) { firstATeam = awayA; }
    if (firstATeam && gameWinner) {
      firstToGradA.n++;
      if (firstATeam === gameWinner) firstToGradA.won++;
      var faCp = ptFirstA[firstATeam];
      if (faCp) { firstGradAByQ[faCp].n++; if (firstATeam === gameWinner) firstGradAByQ[faCp].wins++; }
    }

    // ── Section 17: Floor quality across checkpoint sequence ──
    var bwcFloors = [];
    for (var qi = 0; qi < floorSeq.length; qi++) {
      if (floorSeq[qi] !== null && tierSeq[qi] !== null) bwcFloors.push(floorSeq[qi]);
    }
    if (bwcFloors.length >= 3) {
      var fSum = 0, fMin = 999, fMax = -999;
      for (var fk2 = 0; fk2 < bwcFloors.length; fk2++) {
        fSum += bwcFloors[fk2];
        if (bwcFloors[fk2] < fMin) fMin = bwcFloors[fk2];
        if (bwcFloors[fk2] > fMax) fMax = bwcFloors[fk2];
      }
      var fMean = fSum / bwcFloors.length;
      var fVar = 0;
      for (var fk3 = 0; fk3 < bwcFloors.length; fk3++) fVar += (bwcFloors[fk3] - fMean) * (bwcFloors[fk3] - fMean);
      var fStd = Math.sqrt(fVar / bwcFloors.length);
      var fSpread = fMean - fMin;

      // Mean floor bucket
      var mfb2;
      if (fMean < 0.60) mfb2 = '0.50-0.59'; else if (fMean < 0.70) mfb2 = '0.60-0.69';
      else if (fMean < 0.80) mfb2 = '0.70-0.79'; else if (fMean < 0.90) mfb2 = '0.80-0.89'; else mfb2 = '0.90+';
      meanFloorBuckets[mfb2].n++; if (firstTeamWon) meanFloorBuckets[mfb2].wins++;

      // Min floor bucket
      var mnb2;
      if (fMin < 0.40) mnb2 = '<0.40'; else if (fMin < 0.50) mnb2 = '0.40-0.49';
      else if (fMin < 0.60) mnb2 = '0.50-0.59'; else if (fMin < 0.70) mnb2 = '0.60-0.69'; else mnb2 = '0.70+';
      minFloorBuckets[mnb2].n++; if (firstTeamWon) minFloorBuckets[mnb2].wins++;

      // Variance bucket
      var vb2;
      if (fStd < 0.03) vb2 = 'tight (<0.03)'; else if (fStd < 0.08) vb2 = 'moderate (0.03-0.08)';
      else if (fStd < 0.15) vb2 = 'volatile (0.08-0.15)'; else vb2 = 'chaotic (0.15+)';
      floorVarianceBuckets[vb2].n++; if (firstTeamWon) floorVarianceBuckets[vb2].wins++;

      // Mean-min spread bucket
      var msb2;
      if (fSpread < 0.05) msb2 = 'tight (<0.05)'; else if (fSpread < 0.10) msb2 = 'moderate (0.05-0.10)';
      else if (fSpread < 0.20) msb2 = 'gapped (0.10-0.20)'; else msb2 = 'dangerous (0.20+)';
      meanMinSpreadBuckets[msb2].n++; if (firstTeamWon) meanMinSpreadBuckets[msb2].wins++;

      // ── Section 19: Mean floor × tier ──
      var graduated19 = peakTier === 'A' || peakTier === 'B';
      if (graduated19) {
        for (var mft19 of [0.70,0.75,0.80,0.85]) {
          var k19 = peakTier + '_mf' + mft19.toFixed(2);
          if (fMean >= mft19) { s19_mfTier[k19].n++; if (firstTeamWon) s19_mfTier[k19].wins++; }
        }
      }

      // ── Section 20: Mean floor × checkpoint count at peak ──
      if (graduated19) {
        for (var mft20 of [0.70,0.75,0.80]) {
          for (var cpc20 of [2,3,4,5,6]) {
            if (fMean >= mft20 && peakTierCps >= cpc20) {
              var k20 = 'mf' + mft20.toFixed(2) + '_cp' + cpc20;
              s20_mfCp[k20].n++; if (firstTeamWon) s20_mfCp[k20].wins++;
            }
          }
        }
      }

      // ── Section 21: Mean floor × only_one_grad ──
      if (graduated19) {
        var bothGrad21 = ptFirstB[homeA] !== null && ptFirstB[awayA] !== null;
        for (var mft21 of [0.70,0.75,0.80]) {
          if (fMean >= mft21) {
            var bucket21 = bothGrad21 ? 'both' : 'only_one';
            s21_mfGrad[mft21.toFixed(2)][bucket21].n++;
            if (firstTeamWon) s21_mfGrad[mft21.toFixed(2)][bucket21].wins++;
          }
        }
      }

      // ── Section 22: PO gate simulation ──
      if (graduated19) {
        for (var mft22 of [0.70,0.75,0.80,0.85]) {
          if (fMean >= mft22) {
            s22_poGate[mft22.toFixed(2)].would_fire.n++;
            if (firstTeamWon) s22_poGate[mft22.toFixed(2)].would_fire.wins++;
          } else {
            s22_poGate[mft22.toFixed(2)].would_suppress.n++;
            if (firstTeamWon) {
              s22_poGate[mft22.toFixed(2)].would_suppress.wins++;
              s22_poGate[mft22.toFixed(2)].winners_lost++;
            } else {
              s22_poGate[mft22.toFixed(2)].bad_pos_prevented++;
            }
          }
        }
      }

      // ── Section 23: Rolling mean floor by checkpoint ──
      var runSum23 = 0, runCount23 = 0;
      for (var ci23 = 0; ci23 < checkpoints.length; ci23++) {
        if (floorSeq[ci23] !== null && tierSeq[ci23] !== null) {
          runSum23 += floorSeq[ci23];
          runCount23++;
        }
        if (runCount23 > 0) {
          var runMean23 = runSum23 / runCount23;
          var target23 = firstTeamWon ? s23_rollingMF.winners : s23_rollingMF.losers;
          target23[checkpoints[ci23]].push(runMean23);
        }
      }

      // ── Section 24: Mean floor + min floor combined gate ──
      if (graduated19) {
        for (var mft24 of [0.75,0.80]) {
          for (var mnft24 of [0.60,0.65,0.70]) {
            if (fMean >= mft24 && fMin >= mnft24) {
              var k24 = 'mf' + mft24.toFixed(2) + '_min' + mnft24.toFixed(2);
              s24_mfMinF[k24].n++; if (firstTeamWon) s24_mfMinF[k24].wins++;
            }
          }
        }
      }
    }

    // ── Section 18: Winner backtrace ──
    if (gameWinner) {
      var wTeam = gameWinner;
      winnerProfile.total++;
      if (firstFireTeam === wTeam) winnerProfile.was_first_bwc_team++;

      if (ptFirstA[wTeam] !== null) {
        winnerProfile.graduated_a++;
        winnerProfile.gradA_cps.push(checkpoints.indexOf(ptFirstA[wTeam]));
        winnerProfile.floorAtGradA.push(ptFloorAtA[wTeam]);
        winnerProfile.marginAtGradA.push(ptMarginAtA[wTeam]);
        winnerGradAByCp[ptFirstA[wTeam]].n++;

        // Also track B if they went through it
        if (ptFirstB[wTeam] !== null) {
          winnerProfile.gradB_cps.push(checkpoints.indexOf(ptFirstB[wTeam]));
          winnerProfile.floorAtGradB.push(ptFloorAtB[wTeam]);
          winnerProfile.marginAtGradB.push(ptMarginAtB[wTeam]);
          winnerGradBByCp[ptFirstB[wTeam]].n++;
        }

        // Was winner first/second/only to A?
        var lTeam = wTeam === homeA ? awayA : homeA;
        if (ptFirstA[lTeam] !== null) {
          var wIdx = checkpoints.indexOf(ptFirstA[wTeam]), lIdx = checkpoints.indexOf(ptFirstA[lTeam]);
          if (wIdx <= lIdx) winnerProfile.was_first_to_grad_a++;
          else winnerProfile.was_second_to_grad_a++;
        } else { winnerProfile.was_only_to_grad_a++; }

        // Path
        if (ptFirstB[wTeam] && checkpoints.indexOf(ptFirstB[wTeam]) < checkpoints.indexOf(ptFirstA[wTeam])) {
          if (ptFirstBWC[wTeam] && checkpoints.indexOf(ptFirstBWC[wTeam]) < checkpoints.indexOf(ptFirstB[wTeam])) winnerPath.c_to_a++;
          else winnerPath.b_to_a++;
        } else { winnerPath.born_a++; }

      } else if (ptFirstB[wTeam] !== null) {
        winnerProfile.graduated_b_only++;
        winnerProfile.gradB_cps.push(checkpoints.indexOf(ptFirstB[wTeam]));
        winnerProfile.floorAtGradB.push(ptFloorAtB[wTeam]);
        winnerProfile.marginAtGradB.push(ptMarginAtB[wTeam]);
        winnerGradBByCp[ptFirstB[wTeam]].n++;

        var lTeam2 = wTeam === homeA ? awayA : homeA;
        if (ptFirstB[lTeam2] !== null) {
          var wIdx2 = checkpoints.indexOf(ptFirstB[wTeam]), lIdx2 = checkpoints.indexOf(ptFirstB[lTeam2]);
          if (wIdx2 <= lIdx2) winnerProfile.was_first_to_grad_b++;
          else winnerProfile.was_second_to_grad_b++;
        } else { winnerProfile.was_only_to_grad_b++; }

        if (ptFirstBWC[wTeam] && checkpoints.indexOf(ptFirstBWC[wTeam]) < checkpoints.indexOf(ptFirstB[wTeam])) winnerPath.c_to_b++;
        else winnerPath.born_b++;

      } else if (ptFirstBWC[wTeam] !== null) {
        winnerProfile.stayed_c++; winnerPath.stayed_c++;
      } else {
        winnerProfile.never_bwc++; winnerPath.never_bwc++;
      }

      // Ctrl path
      if (firstFireTeam === wTeam && q4end && q4end.ctrl === wTeam) winnerCtrlPath.wire_to_wire++;
      else if (ptFirstBWC[wTeam] !== null) winnerCtrlPath.took_over++;
    }
  }

  // ── Aggregate helpers ──
  function pct(obj) {
    for (var k in obj) {
      if (obj[k] && typeof obj[k].n === 'number') {
        obj[k].pct = obj[k].n > 0 ? Math.round(obj[k].wins / obj[k].n * 1000) / 10 : null;
      }
    }
    return obj;
  }

  function avgArr(arr) {
    if (!arr || arr.length === 0) return null;
    return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 1000) / 1000;
  }

  function medianArr(arr) {
    if (!arr || arr.length === 0) return null;
    var sorted = arr.slice().sort((a, b) => a - b);
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Aggregate floor trajectories into avg per checkpoint
  function avgTrajectory(list) {
    var result = {};
    for (var ci3 = 0; ci3 < checkpoints.length; ci3++) {
      var vals = list.map(t => t.floors[ci3]).filter(f => f !== null);
      result[checkpoints[ci3]] = { avg: avgArr(vals), median: medianArr(vals), n: vals.length };
    }
    return result;
  }

  // ── Early signals: compute stats ──
  for (var esKey of ['eventual_A', 'eventual_B', 'stayed_C']) {
    var es = earlySignals[esKey];
    es.q1_floor_avg = avgArr(es.q1_floors);
    es.q1_floor_median = medianArr(es.q1_floors);
    es.q2_floor_avg = avgArr(es.q2_floors);
    es.q2_floor_median = medianArr(es.q2_floors);
    es.q1_lead_avg = avgArr(es.q1_leads);
    es.n = es.q1_floors.length;
    // Remove raw arrays from output to keep response manageable
    delete es.q1_floors;
    delete es.q2_floors;
    delete es.q1_leads;
  }

  // ── First BWC flip count stats ──
  for (var fk in firstBWC.flip_counts) {
    var fc = firstBWC.flip_counts[fk];
    fc.first_team_win_pct = fc.n > 0 ? Math.round(fc.first_team_won / fc.n * 1000) / 10 : null;
  }

  return {
    _meta: {
      filter: closeOnly ? 'competitive games (within 5 in Q3, within 7 in Q4)' : 'all games',
      total_games_analyzed: totalGames,
      total_games_in_dataset: Object.keys(games).length,
    },
    section_1_tier_at_first_fire: {
      description: 'What tier was the BWC team when it first fired?',
      overall: pct(tierAtFire),
      by_checkpoint: Object.fromEntries(
        Object.entries(tierAtFireByCp).map(([k, v]) => [k, pct(v)])
          .filter(([k, v]) => v.A.n + v.B.n + v.C.n > 0)
      ),
    },
    section_2_tier_graduation: {
      description: 'Did the team graduate from its first-fire tier to a higher one? Win rate by path.',
      paths: pct(graduations),
    },
    section_3_peak_tier_persistence: {
      description: 'How many checkpoints did the team spend at its peak tier?',
      buckets: pct(persistenceBuckets),
    },
    section_4_first_bwc_team: {
      description: 'Did the FIRST team to achieve BWC status win the game? How often did control flip?',
      first_team_won_pct: firstBWC.total > 0 ? Math.round(firstBWC.same_team_won / firstBWC.total * 1000) / 10 : null,
      total: firstBWC.total,
      same_team_won: firstBWC.same_team_won,
      different_team_won: firstBWC.different_team_won,
      by_flip_count: firstBWC.flip_counts,
    },
    section_5_floor_trajectory: {
      description: 'Average floor at each checkpoint for winning vs losing BWC teams.',
      winners: { n: floorTrajectory.winners.length, trajectory: avgTrajectory(floorTrajectory.winners) },
      losers: { n: floorTrajectory.losers.length, trajectory: avgTrajectory(floorTrajectory.losers) },
    },
    section_6_control_path: {
      description: 'How was control established? Wire-to-wire vs contested vs late flip.',
      paths: pct(controlPath),
    },
    section_7_early_signals: {
      description: 'Q1/Q2 profile of teams that eventually reached each peak tier.',
      profiles: earlySignals,
    },
    section_8_floor_hold_quality: {
      description: 'Floor delta between consecutive BWC-eligible checkpoints.',
      transitions: pct(floorHolds),
    },
    section_9_floor_plateau: {
      description: 'Is the floor plateaued (±0.03 for 3+ cp), still building, or declining?',
      states: pct(plateaus),
    },
    section_10_game_nature: {
      description: 'Did the BWC team lead throughout, or did they trail at some point?',
      paths: pct(gameNature),
    },
    section_11_graduation_timing: {
      description: 'At which checkpoint did the team first reach its peak tier?',
      by_checkpoint: Object.fromEntries(
        Object.entries(gradTiming).map(([k, v]) => [k, pct(v)])
          .filter(([k, v]) => v.to_a.n + v.to_b.n > 0)
      ),
    },
    section_12_conditions_at_graduation: {
      description: 'Floor, margin, and lead bucket when the team graduated to its peak tier.',
      to_a: {
        n: gradConditions.to_a.floors.length,
        avg_floor: avgArr(gradConditions.to_a.floors),
        median_floor: medianArr(gradConditions.to_a.floors),
        avg_margin: avgArr(gradConditions.to_a.margins),
        median_margin: medianArr(gradConditions.to_a.margins),
        lead_distribution: gradConditions.to_a.leads.reduce((acc, l) => { acc[l] = (acc[l]||0)+1; return acc; }, {}),
      },
      to_b: {
        n: gradConditions.to_b.floors.length,
        avg_floor: avgArr(gradConditions.to_b.floors),
        median_floor: medianArr(gradConditions.to_b.floors),
        avg_margin: avgArr(gradConditions.to_b.margins),
        median_margin: medianArr(gradConditions.to_b.margins),
        lead_distribution: gradConditions.to_b.leads.reduce((acc, l) => { acc[l] = (acc[l]||0)+1; return acc; }, {}),
      },
    },
    section_13_acceleration_predictor: {
      description: 'Q1_END→Q2_END floor acceleration as predictor of graduation and win rate.',
      buckets: (() => {
        var out = {};
        for (var ak in accelBuckets) {
          var ab = accelBuckets[ak];
          out[ak] = {
            n: ab.n,
            wins: ab.wins,
            win_pct: ab.n > 0 ? Math.round(ab.wins / ab.n * 1000) / 10 : null,
            grad_a_pct: ab.n > 0 ? Math.round(ab.grad_a / ab.n * 1000) / 10 : null,
            grad_b_pct: ab.n > 0 ? Math.round(ab.grad_b / ab.n * 1000) / 10 : null,
          };
        }
        return out;
      })(),
    },
    section_14_value_window: {
      description: 'Graduated tier × lead at graduation. Where is accuracy highest at moderate leads?',
      grid: pct(valueWindow),
    },
    section_15_time_to_graduate: {
      description: 'How many checkpoints from first fire to reaching peak tier?',
      buckets: pct(timeToGrad),
    },

    section_16_first_to_graduate: {
      description: 'Which team GRADUATED to B/A first (per-team tracking)? Did that team win?',
      first_to_b: {
        n: firstToGradB.n, won: firstToGradB.won,
        pct: firstToGradB.n > 0 ? Math.round(firstToGradB.won / firstToGradB.n * 1000) / 10 : null,
      },
      first_to_a: {
        n: firstToGradA.n, won: firstToGradA.won,
        pct: firstToGradA.n > 0 ? Math.round(firstToGradA.won / firstToGradA.n * 1000) / 10 : null,
      },
      both_graduated_b: {
        n: bothGradB.n, first_won: bothGradB.first_won,
        pct: bothGradB.n > 0 ? Math.round(bothGradB.first_won / bothGradB.n * 1000) / 10 : null,
        description: 'Both teams reached B — did the first to get there win?',
      },
      only_one_graduated_b: {
        n: onlyOneGradB.n, won: onlyOneGradB.won,
        pct: onlyOneGradB.n > 0 ? Math.round(onlyOneGradB.won / onlyOneGradB.n * 1000) / 10 : null,
        description: 'Only one team reached B — did they win?',
      },
      first_b_by_checkpoint: pct(firstGradBByQ),
      first_a_by_checkpoint: pct(firstGradAByQ),
    },

    section_17_floor_quality: {
      description: 'Floor quality across BWC-eligible checkpoint sequence. Mean, min, variance, spread — which separates winners?',
      by_mean_floor: pct(meanFloorBuckets),
      by_min_floor: pct(minFloorBuckets),
      by_variance: pct(floorVarianceBuckets),
      by_mean_min_spread: pct(meanMinSpreadBuckets),
    },

    section_18_winner_backtrace: {
      description: 'Start from WINNERS — trace their graduation patterns backward.',
      total_winners: winnerProfile.total,
      graduation_distribution: {
        graduated_to_a: winnerProfile.graduated_a,
        graduated_to_b_only: winnerProfile.graduated_b_only,
        stayed_c: winnerProfile.stayed_c,
        never_bwc: winnerProfile.never_bwc,
        pct_graduated_a: winnerProfile.total > 0 ? Math.round(winnerProfile.graduated_a / winnerProfile.total * 1000) / 10 : null,
        pct_graduated_b_plus: winnerProfile.total > 0 ? Math.round((winnerProfile.graduated_a + winnerProfile.graduated_b_only) / winnerProfile.total * 1000) / 10 : null,
      },
      graduation_path: winnerPath,
      winner_was_first_bwc_team: {
        n: winnerProfile.was_first_bwc_team,
        pct: winnerProfile.total > 0 ? Math.round(winnerProfile.was_first_bwc_team / winnerProfile.total * 1000) / 10 : null,
      },
      ctrl_path: winnerCtrlPath,
      anchor_reliability: {
        description: 'Of winners who graduated: were they FIRST, SECOND, or ONLY team to graduate?',
        first_to_b: winnerProfile.was_first_to_grad_b,
        second_to_b: winnerProfile.was_second_to_grad_b,
        only_to_b: winnerProfile.was_only_to_grad_b,
        first_to_a: winnerProfile.was_first_to_grad_a,
        second_to_a: winnerProfile.was_second_to_grad_a,
        only_to_a: winnerProfile.was_only_to_grad_a,
      },
      winner_grad_b_by_checkpoint: winnerGradBByCp,
      winner_grad_a_by_checkpoint: winnerGradAByCp,
      conditions_at_graduation: {
        b_graduates: {
          n: winnerProfile.floorAtGradB.length,
          median_floor: medianArr(winnerProfile.floorAtGradB),
          avg_floor: avgArr(winnerProfile.floorAtGradB),
          median_margin: medianArr(winnerProfile.marginAtGradB),
        },
        a_graduates: {
          n: winnerProfile.floorAtGradA.length,
          median_floor: medianArr(winnerProfile.floorAtGradA),
          avg_floor: avgArr(winnerProfile.floorAtGradA),
          median_margin: medianArr(winnerProfile.marginAtGradA),
        },
      },
    },

    section_19_mean_floor_x_tier: {
      description: 'Mean floor threshold × graduated tier. Which MF gate works for each rank?',
      grid: pct(s19_mfTier),
    },

    section_20_mean_floor_x_cp_count: {
      description: 'Mean floor threshold × checkpoints sustained at peak tier.',
      grid: pct(s20_mfCp),
    },

    section_21_mean_floor_x_only_one_grad: {
      description: 'Mean floor × whether only one team or both teams graduated.',
      thresholds: Object.fromEntries(
        Object.entries(s21_mfGrad).map(function(e) {
          var oo = e[1].only_one, bo = e[1].both;
          return [e[0], {
            only_one: { n: oo.n, wins: oo.wins, pct: oo.n > 0 ? Math.round(oo.wins / oo.n * 1000) / 10 : null },
            both: { n: bo.n, wins: bo.wins, pct: bo.n > 0 ? Math.round(bo.wins / bo.n * 1000) / 10 : null },
          }];
        })
      ),
    },

    section_22_po_gate_simulation: {
      description: 'If PO required mean floor >= threshold, how many fire, how many correct winners lost, how many bad positions prevented?',
      thresholds: Object.fromEntries(
        Object.entries(s22_poGate).map(function(e) {
          var d = e[1];
          return [e[0], {
            would_fire: { n: d.would_fire.n, wins: d.would_fire.wins, pct: d.would_fire.n > 0 ? Math.round(d.would_fire.wins / d.would_fire.n * 1000) / 10 : null },
            would_suppress: { n: d.would_suppress.n, wins: d.would_suppress.wins },
            winners_lost: d.winners_lost,
            bad_positions_prevented: d.bad_pos_prevented,
          }];
        })
      ),
    },

    section_23_rolling_mean_floor: {
      description: 'Average running mean floor at each checkpoint for winners vs losers. Shows when mean floor diverges enough to trust.',
      winners: Object.fromEntries(
        checkpoints.map(function(cp) {
          var vals = s23_rollingMF.winners[cp];
          return [cp, { avg: vals.length > 0 ? Math.round(vals.reduce(function(a,b){return a+b;},0) / vals.length * 1000) / 1000 : null, n: vals.length }];
        })
      ),
      losers: Object.fromEntries(
        checkpoints.map(function(cp) {
          var vals = s23_rollingMF.losers[cp];
          return [cp, { avg: vals.length > 0 ? Math.round(vals.reduce(function(a,b){return a+b;},0) / vals.length * 1000) / 1000 : null, n: vals.length }];
        })
      ),
    },

    section_24_mean_floor_plus_min_floor: {
      description: 'Combined gate: mean floor >= X AND min floor >= Y. Does adding a min floor guard improve accuracy?',
      grid: pct(s24_mfMinF),
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// POSITION OPEN ANALYSIS — Mean floor as primary signal for PO firing rules
// ?phase=report_position_open          — full dataset
// ?phase=report_position_open&close=1  — competitive games (within 5 in Q3, within 7 in Q4)
// ══════════════════════════════════════════════════════════════════════════════
async function reportPositionOpen(sql, url) {
  var closeOnly = url?.searchParams?.get('close') === '1';

  var rows = await sql`
    SELECT game_id, checkpoint, margin_at_snapshot AS margin,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl,
           indicators->>'homeAlias' AS home_alias,
           indicators->>'awayAlias' AS away_alias,
           (indicators->>'I1')::text AS i1raw, (indicators->>'I2')::text AS i2raw,
           (indicators->>'I3')::text AS i3raw, (indicators->>'I4')::text AS i4raw,
           (indicators->>'I5')::text AS i5raw,
           (conviction->>'tier') AS conv_tier,
           (conviction->>'count')::int AS ind_count,
           ctrl_team_won, final_margin
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  var checkpoints = CP_LABELS;
  var cpIdx = {}; for (var i = 0; i < checkpoints.length; i++) cpIdx[checkpoints[i]] = i;

  // Group by game
  var gameMap = {};
  for (var r of rows) {
    if (!gameMap[r.game_id]) gameMap[r.game_id] = [];
    gameMap[r.game_id].push(r);
  }

  // Competitive game filter
  var Q3_CPS_PO = new Set(['Q3_9','Q3_6','Q3_3','Q3_END']);
  var Q4_CPS_PO = new Set(['Q4_9','Q4_6','Q4_3','Q4_END']);
  if (closeOnly) {
    for (var gid of Object.keys(gameMap)) {
      var competitive = gameMap[gid].some(function(s) {
        var absM = Math.abs(s.margin);
        if (Q3_CPS_PO.has(s.checkpoint) && absM <= 5) return true;
        if (Q4_CPS_PO.has(s.checkpoint) && absM <= 7) return true;
        return false;
      });
      if (!competitive) delete gameMap[gid];
    }
  }

  function getCtrlMargin(r) { return (r.ctrl === r.home_alias) ? r.margin : -r.margin; }
  function getOppCount(r) {
    var ctrlHome = r.ctrl === r.home_alias;
    var scores = [parseFloat(r.i1raw), parseFloat(r.i2raw), parseFloat(r.i3raw),
                  parseFloat(r.i4raw), parseFloat(r.i5raw)];
    var c = 0;
    for (var s of scores) { if (isNaN(s)) continue; if (ctrlHome ? (s === 0) : (s === 1)) c++; }
    return c;
  }
  function classifyBWCTier(conv, lead, holds, oppCount) {
    if (conv === 'DOMINANT' && lead >= 8 && holds >= 4 && oppCount <= 1) return 'A';
    if (oppCount >= 3) return 'C';
    if ((conv === 'DOMINANT' || conv === 'STRONG') && lead >= 3 && holds >= 2) return 'B';
    return 'C';
  }
  function ph(b) { return { n: b.n, wins: b.wins, pct: b.n > 0 ? Math.round(b.wins / b.n * 1000) / 10 : null }; }
  function avgArr(a) { if (!a.length) return null; return Math.round(a.reduce(function(x,y){return x+y;},0) / a.length * 1000) / 1000; }
  function medArr(a) { if (!a.length) return null; var s = a.slice().sort(function(x,y){return x-y;}); var m = Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; }

  // ── Section 1: Mean floor sole gate — sweep thresholds ──
  // At each checkpoint, for the BWC team: compute running mean floor across all BWC-eligible cps.
  // Record win rate for games where mean floor crosses each threshold.
  var meanFloorGates = {};
  var thresholds = [0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90];
  for (var t of thresholds) meanFloorGates[t.toFixed(2)] = { n: 0, wins: 0 };

  // ── Section 2: Mean floor × zero flips ──
  var meanFloorZeroFlips = {};
  for (var t of thresholds) meanFloorZeroFlips[t.toFixed(2)] = { n: 0, wins: 0 };
  var meanFloorWithFlips = {};
  for (var t of thresholds) meanFloorWithFlips[t.toFixed(2)] = { n: 0, wins: 0 };

  // ── Section 3: Mean floor × margin window (at first crossing) ──
  var meanFloorMargin = {};
  for (var t of thresholds) {
    meanFloorMargin[t.toFixed(2)] = {
      lead_1_4: { n:0, wins:0 }, lead_5_8: { n:0, wins:0 },
      lead_9_plus: { n:0, wins:0 }, trailing_or_tied: { n:0, wins:0 }
    };
  }

  // ── Section 4: Mean floor × minimum checkpoint ──
  var meanFloorByCp = {};
  for (var t of thresholds) {
    meanFloorByCp[t.toFixed(2)] = {};
    for (var cp of checkpoints) meanFloorByCp[t.toFixed(2)][cp] = { n: 0, wins: 0 };
  }

  // ── Section 5: Combined rules comparison ──
  // Each rule: { label, minMeanFloor, zeroFlips, minCp (index), marginMin, marginMax, trackOpp }
  var rules = [
    { label: 'MF≥0.75 only',             mf: 0.75, zf: false, minCp: 0, mMin: -99, mMax: 999 },
    { label: 'MF≥0.75 + 0 flips',        mf: 0.75, zf: true,  minCp: 0, mMin: -99, mMax: 999 },
    { label: 'MF≥0.75 + 0 flips + lead 1-8', mf: 0.75, zf: true, minCp: 0, mMin: 1, mMax: 8 },
    { label: 'MF≥0.75 + 0 flips + Q3_6+',    mf: 0.75, zf: true, minCp: 4, mMin: -99, mMax: 999 },
    { label: 'MF≥0.75 + 0 flips + lead 1-8 + Q3_6+', mf: 0.75, zf: true, minCp: 4, mMin: 1, mMax: 8 },
    { label: 'MF≥0.80 only',             mf: 0.80, zf: false, minCp: 0, mMin: -99, mMax: 999 },
    { label: 'MF≥0.80 + 0 flips',        mf: 0.80, zf: true,  minCp: 0, mMin: -99, mMax: 999 },
    { label: 'MF≥0.80 + 0 flips + lead 1-8', mf: 0.80, zf: true, minCp: 0, mMin: 1, mMax: 8 },
    { label: 'MF≥0.80 + 0 flips + Q2_END+',  mf: 0.80, zf: true, minCp: 3, mMin: -99, mMax: 999 },
    { label: 'MF≥0.80 + 0 flips + lead 1-8 + Q2_END+', mf: 0.80, zf: true, minCp: 3, mMin: 1, mMax: 8 },
    { label: 'MF≥0.70 + 0 flips + Q3_6+',    mf: 0.70, zf: true, minCp: 4, mMin: -99, mMax: 999 },
    { label: 'MF≥0.70 + 0 flips + lead 1-8 + Q3_6+', mf: 0.70, zf: true, minCp: 4, mMin: 1, mMax: 8 },
    { label: 'Grad B + Q3_6+ (current proposal)', mf: 0, zf: false, minCp: 4, mMin: -99, mMax: 999, gradGate: 'B' },
    { label: 'Grad A any cp (current proposal)',   mf: 0, zf: false, minCp: 0, mMin: -99, mMax: 999, gradGate: 'A' },
  ];
  var ruleResults = [];
  for (var ri = 0; ri < rules.length; ri++) ruleResults.push({ n: 0, wins: 0, first_cp_dist: {} });

  // ── Section 6: Opponent graduation interaction ──
  var oppGradInteraction = {
    opp_not_graduated: { n: 0, wins: 0 },   // PO team graduated, opp hasn't
    opp_also_graduated: { n: 0, wins: 0 },  // both graduated
    second_team_anchor: { n: 0, wins: 0 },  // anchor flipped to 2nd team
  };

  // ── Section 7: First PO per game — when would each rule first fire? ──
  // (captured per-rule in ruleResults[i].first_cp_dist)

  // ── Section 8: Mean floor at each checkpoint as running average ──
  var runningMFByCp = {};
  for (var cp of checkpoints) runningMFByCp[cp] = { floors: [], wins: 0, n: 0 };

  var totalGames = 0;
  var totalBWCGames = 0;

  // ── GAME LOOP ──
  for (var [gid, snaps] of Object.entries(gameMap)) {
    var cpMap = {};
    for (var s of snaps) cpMap[s.checkpoint] = s;
    if (!cpMap['Q2_6']) continue;
    totalGames++;

    var homeA = snaps[0].home_alias;
    var awayA = snaps[0].away_alias;
    var won = null;
    var prevCtrl = null;
    var holdCount = 0;
    var ctrlFlips = 0;
    var bwcFloors = [];        // running list of floors at BWC-eligible checkpoints
    var firstBWCTeam = null;
    var firstMeanFloorCross = {};  // threshold → first checkpoint it was crossed (per game, one count)

    // Per-team tracking for graduation comparison
    var ptHolds = {}; ptHolds[homeA] = 0; ptHolds[awayA] = 0;
    var ptFirstB = {}; ptFirstB[homeA] = null; ptFirstB[awayA] = null;
    var ptFirstA = {}; ptFirstA[homeA] = null; ptFirstA[awayA] = null;
    var ptFloors = {}; ptFloors[homeA] = []; ptFloors[awayA] = [];

    // Per-rule: first cp this game where rule fires
    var ruleFired = [];
    for (var ri = 0; ri < rules.length; ri++) ruleFired.push(null);

    var anyBWC = false;

    for (var ci = 0; ci < checkpoints.length; ci++) {
      var cpLabel = checkpoints[ci];
      var snap = cpMap[cpLabel];
      if (!snap || !snap.ctrl) continue;

      won = snap.ctrl_team_won;
      var ctrlMargin = getCtrlMargin(snap);
      var oppCount = getOppCount(snap);

      // Track flips
      if (prevCtrl && prevCtrl !== snap.ctrl) ctrlFlips++;
      if (prevCtrl === snap.ctrl) holdCount++;
      else holdCount = 1;
      prevCtrl = snap.ctrl;

      // Per-team holds
      var curT = snap.ctrl;
      var othT = curT === homeA ? awayA : homeA;
      ptHolds[curT]++;
      if (holdCount === 1) ptHolds[othT] = 0;

      // BWC eligible?
      var bwcEligible = ctrlMargin >= 2 && snap.floor >= 0.50;
      if (!bwcEligible) continue;
      anyBWC = true;

      if (!firstBWCTeam) firstBWCTeam = snap.ctrl;

      var tier = classifyBWCTier(snap.conv_tier, ctrlMargin, holdCount, oppCount);

      // Per-team graduation
      if (ptFirstB[curT] === null && (tier === 'B' || tier === 'A')) ptFirstB[curT] = cpLabel;
      if (ptFirstA[curT] === null && tier === 'A') ptFirstA[curT] = cpLabel;
      ptFloors[curT].push(snap.floor);

      // Running mean floor for current BWC team
      bwcFloors.push(snap.floor);
      var meanFloor = bwcFloors.reduce(function(a,b){return a+b;}, 0) / bwcFloors.length;

      // Section 8: running MF by checkpoint
      runningMFByCp[cpLabel].n++;
      runningMFByCp[cpLabel].floors.push(meanFloor);
      if (won) runningMFByCp[cpLabel].wins++;

      // Section 1 & 2 & 3 & 4: mean floor threshold crossings (first time per game)
      for (var t of thresholds) {
        var tk = t.toFixed(2);
        if (meanFloor >= t && !firstMeanFloorCross[tk]) {
          firstMeanFloorCross[tk] = cpLabel;

          // Section 1: sole gate
          meanFloorGates[tk].n++;
          if (won) meanFloorGates[tk].wins++;

          // Section 2: zero flips split
          if (ctrlFlips === 0) { meanFloorZeroFlips[tk].n++; if (won) meanFloorZeroFlips[tk].wins++; }
          else { meanFloorWithFlips[tk].n++; if (won) meanFloorWithFlips[tk].wins++; }

          // Section 3: margin window at crossing
          var mb;
          if (ctrlMargin >= 9) mb = 'lead_9_plus';
          else if (ctrlMargin >= 5) mb = 'lead_5_8';
          else if (ctrlMargin >= 1) mb = 'lead_1_4';
          else mb = 'trailing_or_tied';
          meanFloorMargin[tk][mb].n++;
          if (won) meanFloorMargin[tk][mb].wins++;

          // Section 4: by checkpoint
          meanFloorByCp[tk][cpLabel].n++;
          if (won) meanFloorByCp[tk][cpLabel].wins++;
        }
      }

      // Section 5: Combined rules — check each rule at this checkpoint
      for (var ri = 0; ri < rules.length; ri++) {
        if (ruleFired[ri] !== null) continue; // already fired this game
        var rule = rules[ri];

        // Checkpoint minimum
        if (ci < rule.minCp) continue;
        // Margin window
        if (ctrlMargin < rule.mMin || ctrlMargin > rule.mMax) continue;
        // Zero flips
        if (rule.zf && ctrlFlips > 0) continue;
        // Graduation gate (for comparison rules)
        if (rule.gradGate === 'B' && tier !== 'B' && tier !== 'A') continue;
        if (rule.gradGate === 'A' && tier !== 'A') continue;
        // Mean floor
        if (!rule.gradGate && meanFloor < rule.mf) continue;

        // Rule fires!
        ruleFired[ri] = cpLabel;
        ruleResults[ri].n++;
        if (won) ruleResults[ri].wins++;
        if (!ruleResults[ri].first_cp_dist[cpLabel]) ruleResults[ri].first_cp_dist[cpLabel] = 0;
        ruleResults[ri].first_cp_dist[cpLabel]++;
      }
    }

    if (!anyBWC) continue;
    totalBWCGames++;

    // Section 6: Opponent graduation interaction
    // Determine winner alias
    var winnerAlias = null;
    if (won !== null) {
      // won = ctrl_team_won, so we need to figure out who the ctrl team was at last checkpoint
      // Use the firstBWCTeam as anchor reference
      var anchorTeam = firstBWCTeam;
      var oppTeam = anchorTeam === homeA ? awayA : homeA;

      // Did anchor's opponent also graduate?
      if (ptFirstB[anchorTeam] !== null) {
        if (ptFirstB[oppTeam] === null) {
          // Only anchor graduated
          oppGradInteraction.opp_not_graduated.n++;
          if (won) oppGradInteraction.opp_not_graduated.wins++;
        } else {
          // Both graduated
          oppGradInteraction.opp_also_graduated.n++;
          if (won) oppGradInteraction.opp_also_graduated.wins++;

          // Did the second team to graduate end up winning?
          var anchorBIdx = cpIdx[ptFirstB[anchorTeam]] || 0;
          var oppBIdx = cpIdx[ptFirstB[oppTeam]] || 0;
          if (oppBIdx > anchorBIdx) {
            // Opponent graduated second — did they win?
            oppGradInteraction.second_team_anchor.n++;
            // won is from perspective of CTRL team, which may vary
            // We need: did the second-to-graduate team win?
            // Since we track per-team, check if opponent is the actual winner
            // won = ctrl_team_won at last snapshot. But ctrl could be either team.
            // Simplify: use last snap's ctrl alignment
            var lastSnap = snaps[snaps.length - 1];
            var lastCtrl = lastSnap?.ctrl;
            var oppWon = (lastCtrl === oppTeam && lastSnap?.ctrl_team_won) ||
                         (lastCtrl !== oppTeam && !lastSnap?.ctrl_team_won);
            if (oppWon) oppGradInteraction.second_team_anchor.wins++;
          }
        }
      }
    }
  }

  // ── Build output ──
  var ruleComparison = [];
  for (var ri = 0; ri < rules.length; ri++) {
    ruleComparison.push({
      rule: rules[ri].label,
      ...ph(ruleResults[ri]),
      first_fire_distribution: ruleResults[ri].first_cp_dist,
    });
  }

  // Section 8: running mean floor trajectory
  var mfTrajectory = {};
  for (var cp of checkpoints) {
    mfTrajectory[cp] = {
      n: runningMFByCp[cp].n,
      avg_mean_floor: avgArr(runningMFByCp[cp].floors),
      median_mean_floor: medArr(runningMFByCp[cp].floors),
      win_rate: runningMFByCp[cp].n > 0 ? Math.round(runningMFByCp[cp].wins / runningMFByCp[cp].n * 1000) / 10 : null,
    };
  }

  return {
    _meta: {
      filter: closeOnly ? 'competitive games (within 5 in Q3, within 7 in Q4)' : 'all games',
      total_games: totalGames,
      total_bwc_games: totalBWCGames,
    },

    section_1_mean_floor_sole_gate: {
      description: 'Win rate when mean floor first crosses each threshold (one count per game). Tests mean floor as standalone PO signal.',
      thresholds: Object.fromEntries(Object.entries(meanFloorGates).map(function(e) { return [e[0], ph(e[1])]; })),
    },

    section_2_mean_floor_x_flips: {
      description: 'Mean floor gate split by zero flips vs 1+ flips at crossing. Tests whether zero-flip gate adds value.',
      zero_flips: Object.fromEntries(Object.entries(meanFloorZeroFlips).map(function(e) { return [e[0], ph(e[1])]; })),
      with_flips: Object.fromEntries(Object.entries(meanFloorWithFlips).map(function(e) { return [e[0], ph(e[1])]; })),
    },

    section_3_mean_floor_x_margin: {
      description: 'Mean floor × margin window at first crossing. Where is the value window (enough lead to be real, not so much the line is dead)?',
      by_threshold: Object.fromEntries(Object.entries(meanFloorMargin).map(function(e) {
        return [e[0], Object.fromEntries(Object.entries(e[1]).map(function(f) { return [f[0], ph(f[1])]; }))];
      })),
    },

    section_4_mean_floor_x_checkpoint: {
      description: 'Mean floor × checkpoint where threshold first crossed. When does crossing happen and does later crossing = better accuracy?',
      by_threshold: Object.fromEntries(Object.entries(meanFloorByCp).map(function(e) {
        return [e[0], Object.fromEntries(Object.entries(e[1]).map(function(f) { return [f[0], ph(f[1])]; }))];
      })),
    },

    section_5_combined_rules: {
      description: 'Head-to-head comparison of proposed PO firing rules. n = games where rule fires, pct = win rate when it fires. Includes graduation-based rules for comparison.',
      rules: ruleComparison,
    },

    section_6_opponent_graduation: {
      description: 'Does opponent also graduating change the signal? second_team_anchor = when opp graduated 2nd, did THEY win?',
      opp_not_graduated: ph(oppGradInteraction.opp_not_graduated),
      opp_also_graduated: ph(oppGradInteraction.opp_also_graduated),
      second_team_to_graduate_wins: ph(oppGradInteraction.second_team_anchor),
    },

    section_7_mean_floor_trajectory: {
      description: 'Running mean floor trajectory across checkpoints for all BWC-eligible games. Shows when mean floor stabilizes.',
      by_checkpoint: mfTrajectory,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCTION REPLAY — 60-second resolution graduation analysis from live snapshots
// ?phase=report_production_replay             — full dataset
// ?phase=report_production_replay&close=1     — final margin ≤ 8 only
// ?phase=report_production_replay&game=GAMEID — single game deep-dive
// ══════════════════════════════════════════════════════════════════════════════
async function reportProductionReplay(sql, url) {
  var closeOnly = url?.searchParams?.get('close') === '1';
  var singleGame = url?.searchParams?.get('game') || null;
  var marginFilter = closeOnly ? 8 : 999;
  var t0 = Date.now();

  // ── 1. Pull server snapshots from live snapshots table ──
  var snapQuery;
  if (singleGame) {
    snapQuery = await sql`
      SELECT s.game_id, s.ts, s.period, s.clock, s.home_pts, s.away_pts,
             s.floor_score, s.floor_team, s.i1, s.i2, s.i3, s.i4, s.i5,
             g.winner, g.margin, g.home_alias, g.away_alias, g.matchup, g.date
      FROM snapshots s
      JOIN games g ON g.id = s.game_id
      WHERE s.source = 'server'
        AND s.game_id = ${singleGame}
        AND s.floor_score IS NOT NULL
        AND s.floor_team IS NOT NULL
      ORDER BY s.ts
    `;
  } else {
    snapQuery = await sql`
      SELECT s.game_id, s.ts, s.period, s.clock, s.home_pts, s.away_pts,
             s.floor_score, s.floor_team, s.i1, s.i2, s.i3, s.i4, s.i5,
             g.winner, g.margin, g.home_alias, g.away_alias, g.matchup, g.date
      FROM snapshots s
      JOIN games g ON g.id = s.game_id
      WHERE s.source = 'server'
        AND g.winner IS NOT NULL
        AND s.floor_score IS NOT NULL
        AND s.floor_team IS NOT NULL
        AND ABS(g.margin) <= ${marginFilter}
      ORDER BY s.game_id, s.ts
    `;
  }

  // ── 2. Group by game, filter 10+ server snaps ──
  var gameMap = {};
  for (var r of snapQuery) {
    if (!gameMap[r.game_id]) gameMap[r.game_id] = [];
    gameMap[r.game_id].push(r);
  }

  var gameIds = Object.keys(gameMap).filter(gid => gameMap[gid].length >= 10);

  // ── Helper: parse clock string to seconds remaining in period ──
  function clockToSec(clockStr) {
    if (!clockStr) return 0;
    var clean = String(clockStr).replace(/^Q\d+\s*/i, '').trim();
    var parts = clean.split(':');
    if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    if (parts.length === 1) return parseInt(parts[0]) || 0;
    return 0;
  }

  // ── Helper: game-seconds elapsed (0 = game start, 2880 = end of regulation) ──
  function gameSecondsElapsed(period, clockStr) {
    var p = Math.max(1, Math.min(4, Number(period) || 1));
    var remaining = clockToSec(clockStr);
    return (p - 1) * 720 + (720 - remaining);
  }

  // ── Helper: seconds → "Q3 8:42" style label ──
  function secToLabel(gameSec) {
    var q = Math.floor(gameSec / 720) + 1;
    var inQ = gameSec % 720;
    var remaining = 720 - inQ;
    var m = Math.floor(remaining / 60);
    var s = remaining % 60;
    return 'Q' + q + ' ' + m + ':' + String(s).padStart(2, '0');
  }

  // ── Helper: conviction + opp count from snapshot indicators ──
  function computeFromSnap(snap) {
    var ctrlHome = snap.floor_team === snap.home_alias;
    var scores = [
      { key: 'I1', raw: parseFloat(snap.i1) },
      { key: 'I2', raw: parseFloat(snap.i2) },
      { key: 'I3', raw: parseFloat(snap.i3) },
      { key: 'I4', raw: parseFloat(snap.i4) },
      { key: 'I5', raw: parseFloat(snap.i5) },
    ];
    var wins = [], oppCount = 0;
    for (var s of scores) {
      if (isNaN(s.raw)) continue;
      var ctrlScore = ctrlHome ? s.raw : 1 - s.raw;
      if (ctrlScore > 0.5) wins.push(s.key);
      else if (ctrlScore < 0.5) oppCount++;
    }
    var count = wins.length;
    var has = function(a, b) { return wins.includes(a) && wins.includes(b); };
    var hasI4I5 = has('I4', 'I5');
    var hasI3I4 = has('I3', 'I4');
    var hasI3I5 = has('I3', 'I5');
    var hasKillerPair = hasI4I5 || hasI3I4 || hasI3I5;
    var isDanger = (
      (count === 2 && wins.includes('I1') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4')) ||
      (count === 3 && wins.includes('I1') && wins.includes('I2') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4')) ||
      (count === 3 && wins.includes('I2') && wins.includes('I3') && wins.includes('I5') && !wins.includes('I4'))
    );
    var tier;
    if (count >= 4 || hasI4I5) tier = 'DOMINANT';
    else if (hasKillerPair && !isDanger) tier = 'STRONG';
    else if (count >= 2 && !isDanger) tier = 'MODEST';
    else if (count >= 1) tier = 'CONDITIONAL';
    else tier = 'NO ENTRY';
    return { convTier: tier, oppCount, indWon: count, wins };
  }

  // ── Helper: BWC tier classification (same as tier journey) ──
  function classifyTier(conv, lead, holds, oppCount) {
    if (conv === 'DOMINANT' && lead >= 8 && holds >= 4 && oppCount <= 1) return 'A';
    if (oppCount >= 3) return 'C';
    if ((conv === 'DOMINANT' || conv === 'STRONG') && lead >= 3 && holds >= 2) return 'B';
    return 'C';
  }

  // ── Helper: ctrl-relative margin (positive = ctrl leading) ──
  function getCtrlMargin(snap) {
    var homeMargin = Number(snap.home_pts) - Number(snap.away_pts);
    return snap.floor_team === snap.home_alias ? homeMargin : -homeMargin;
  }

  // ── Helper: percentile from sorted array ──
  function percentile(arr, p) {
    if (!arr.length) return null;
    var sorted = arr.slice().sort(function(a, b) { return a - b; });
    var idx = (p / 100) * (sorted.length - 1);
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  function pctHelper(bucket) {
    return { n: bucket.n, wins: bucket.wins, pct: bucket.n > 0 ? Math.round(bucket.wins / bucket.n * 1000) / 10 : null };
  }

  // ── 3. Replay graduation at 60-second resolution ──
  var allGradTimingB = [];    // game-seconds when first reached B
  var allGradTimingA = [];    // game-seconds when first reached A
  var allFirstBWC = [];       // game-seconds when first BWC-eligible
  var allOscillations = [];   // oscillation count per game
  var allPeakHoldSec = [];    // longest continuous hold at peak tier, in seconds
  var allPeakHoldMinBucket = { '0-2': {n:0,wins:0}, '2-5': {n:0,wins:0}, '5-10': {n:0,wins:0}, '10-20': {n:0,wins:0}, '20+': {n:0,wins:0} };
  var oscByType = { B_to_C: 0, A_to_B: 0, A_to_C: 0 };
  var oscWinRate = { zero: {n:0,wins:0}, one: {n:0,wins:0}, two_plus: {n:0,wins:0} };

  // Graduation timing: checkpoint-equivalent buckets (game seconds → nearest 6-min checkpoint)
  var gradBByQuarter = { Q1: {n:0,wins:0}, Q2: {n:0,wins:0}, Q3: {n:0,wins:0}, Q4: {n:0,wins:0} };
  var gradAByQuarter = { Q1: {n:0,wins:0}, Q2: {n:0,wins:0}, Q3: {n:0,wins:0}, Q4: {n:0,wins:0} };

  // Hold time vs checkpoint comparison: for games that graduated, map hold-minutes to checkpoint-equivalent
  var holdMinVsCheckpointBuckets = {
    '1cp_equiv': {n:0,wins:0}, '2cp_equiv': {n:0,wins:0}, '3cp_equiv': {n:0,wins:0}, '4cp_plus_equiv': {n:0,wins:0}
  };

  // Wire-to-wire at 60s: did ctrl team at first BWC stay ctrl to end?
  var wireToWire = {n:0,wins:0};
  var notWireToWire = {n:0,wins:0};

  // Floor at graduation buckets
  var floorAtGrad = {
    '0.50-0.59': {n:0,wins:0}, '0.60-0.69': {n:0,wins:0}, '0.70-0.79': {n:0,wins:0},
    '0.80-0.89': {n:0,wins:0}, '0.90+': {n:0,wins:0}
  };

  // Margin at graduation buckets
  var marginAtGrad = {
    'lead_1-2': {n:0,wins:0}, 'lead_3-7': {n:0,wins:0}, 'lead_8-14': {n:0,wins:0}, 'lead_15+': {n:0,wins:0}
  };

  // Section: time-to-graduate from first BWC fire (in seconds)
  var timeFromFireToB = [];
  var timeFromFireToA = [];

  // Section: early graduation signal — did floor surge predict graduation?
  var earlyFloorSurge = { surged: {n:0,wins:0}, flat: {n:0,wins:0}, dropped: {n:0,wins:0} };

  // Single-game deep dive accumulator
  var singleGameTimeline = null;

  // ── Section 9: First team to GRADUATE (not just first BWC fire) ──
  var firstToGradB = { n: 0, won: 0 };
  var firstToGradA = { n: 0, won: 0 };
  var bothGradB = { n: 0, first_won: 0 };  // both teams reached B
  var onlyOneGradB = { n: 0, won: 0 };      // only one team graduated to B
  var firstGradBByQ = { Q1:{n:0,wins:0}, Q2:{n:0,wins:0}, Q3:{n:0,wins:0}, Q4:{n:0,wins:0} };
  var firstGradAByQ = { Q1:{n:0,wins:0}, Q2:{n:0,wins:0}, Q3:{n:0,wins:0}, Q4:{n:0,wins:0} };

  // ── Section 10: Inter-checkpoint floor quality ──
  // Checkpoint boundaries at 6-min intervals (game-seconds)
  var cpBoundaries = [0, 360, 720, 1080, 1440, 1800, 2160, 2520, 2880];
  var cpLabels = CP_LABELS;

  // Aggregate buckets for inter-checkpoint quality metrics
  var meanFloorBuckets = {
    '0.50-0.59': {n:0,wins:0}, '0.60-0.69': {n:0,wins:0}, '0.70-0.79': {n:0,wins:0},
    '0.80-0.89': {n:0,wins:0}, '0.90+': {n:0,wins:0}
  };
  var minFloorBuckets = {
    '<0.40': {n:0,wins:0}, '0.40-0.49': {n:0,wins:0}, '0.50-0.59': {n:0,wins:0},
    '0.60-0.69': {n:0,wins:0}, '0.70+': {n:0,wins:0}
  };
  var floorVarianceBuckets = {
    'tight (<0.03)': {n:0,wins:0}, 'moderate (0.03-0.08)': {n:0,wins:0},
    'volatile (0.08-0.15)': {n:0,wins:0}, 'chaotic (0.15+)': {n:0,wins:0}
  };
  // Mean-min spread: how far does floor dip below average?
  var meanMinSpreadBuckets = {
    'tight (<0.05)': {n:0,wins:0}, 'moderate (0.05-0.10)': {n:0,wins:0},
    'gapped (0.10-0.20)': {n:0,wins:0}, 'dangerous (0.20+)': {n:0,wins:0}
  };
  // Per-checkpoint-window quality (aggregated across games)
  var perWindowQuality = {};
  for (var wl of cpLabels) perWindowQuality[wl] = { floors: [], wins: [], mins: [], stddevs: [] };

  // ── Section 11: Winner backtrace — start from winners, trace their graduation ──
  var winnerProfile = {
    total_winners: 0,
    graduated_a: 0, graduated_b_only: 0, stayed_c: 0, never_bwc: 0,
    was_first_to_grad_b: 0, was_second_to_grad_b: 0, was_only_to_grad_b: 0,
    was_first_to_grad_a: 0, was_second_to_grad_a: 0, was_only_to_grad_a: 0,
    was_first_bwc_team: 0,
    // Timing arrays for percentiles
    firstBWC_sec: [], gradB_sec: [], gradA_sec: [],
    fireToGradB_sec: [], fireToGradA_sec: [],
    floorAtGradB: [], floorAtGradA: [],
    marginAtGradB: [], marginAtGradA: [],
  };
  var winnerGradBByQ = { Q1:{n:0}, Q2:{n:0}, Q3:{n:0}, Q4:{n:0} };
  var winnerGradAByQ = { Q1:{n:0}, Q2:{n:0}, Q3:{n:0}, Q4:{n:0} };
  var winnerPath = { c_to_a: 0, c_to_b: 0, b_to_a: 0, born_a: 0, born_b: 0, stayed_c: 0, never_bwc: 0 };
  var winnerCtrlPath = { wire_to_wire: 0, took_over: 0, recaptured: 0 };

  var totalGames = 0;
  var totalSnaps = 0;

  for (var gid of gameIds) {
    var snaps = gameMap[gid];
    if (snaps.length < 10) continue;
    totalGames++;
    totalSnaps += snaps.length;

    var won = snaps[0].winner === snaps[0].floor_team;
    // Determine if ctrl_team_won: the ctrl team at the LAST snapshot — did they win?
    var lastSnap = snaps[snaps.length - 1];
    var lastCtrl = lastSnap.floor_team;
    won = lastSnap.winner === lastCtrl;
    // Actually: winner is stored on games. Use first snapshot's winner field.
    // winner = the team that won. We track the first BWC team and whether THEY won.
    var gameWinner = snaps[0].winner;

    // ── Per-game replay ──
    var prevCtrl = null;
    var holdCount = 0;  // consecutive snapshots with same ctrl team
    var firstBWCSec = null;
    var firstBWCTeam = null;
    var firstBTierSec = null;
    var firstATierSec = null;
    var currentTier = null;
    var peakTier = null;
    var peakTierRank = 0;
    var oscillations = 0;
    var prevBWCTier = null;
    var tierRankMap = { A: 3, B: 2, C: 1 };

    // Continuous hold tracking
    var currentHoldStart = null;  // game-sec when current peak-tier run started
    var longestPeakHoldSec = 0;
    var currentPeakRunStart = null;
    var inPeakRun = false;

    // Floor tracking for surge detection
    var floorAt360 = null;  // floor at ~6 min elapsed (Q1 6:00)
    var floorAt720 = null;  // floor at ~12 min elapsed (Q1 end)

    // Graduation moment data
    var gradFloor = null;
    var gradMargin = null;
    var gradGameSec = null;

    // Timeline for single-game mode
    var timeline = [];

    // Per-team graduation tracking (both teams independently)
    var homeAlias = snaps[0].home_alias;
    var awayAlias = snaps[0].away_alias;
    var perTeam = {};
    perTeam[homeAlias] = { holds: 0, firstB: null, firstA: null, firstBWC: null, floorAtB: null, marginAtB: null, floorAtA: null, marginAtA: null };
    perTeam[awayAlias] = { holds: 0, firstB: null, firstA: null, firstBWC: null, floorAtB: null, marginAtB: null, floorAtA: null, marginAtA: null };

    // Inter-checkpoint floor collection: floors grouped by checkpoint window
    var windowFloors = {};
    for (var wli = 0; wli < cpLabels.length; wli++) windowFloors[cpLabels[wli]] = [];

    for (var si = 0; si < snaps.length; si++) {
      var snap = snaps[si];
      var gameSec = gameSecondsElapsed(snap.period, snap.clock);
      var ctrlMargin = getCtrlMargin(snap);
      var floor = parseFloat(snap.floor_score);

      // Floor tracking at known game-seconds
      if (floorAt360 === null && gameSec >= 360) floorAt360 = floor;
      if (floorAt720 === null && gameSec >= 720) floorAt720 = floor;

      // Consecutive ctrl holds
      if (prevCtrl === snap.floor_team) {
        holdCount++;
      } else {
        holdCount = 1;
      }
      prevCtrl = snap.floor_team;

      // Per-team hold tracking
      var curTeam = snap.floor_team;
      var otherTeam = curTeam === homeAlias ? awayAlias : homeAlias;
      if (perTeam[curTeam]) perTeam[curTeam].holds++;
      // Reset other team's holds when ctrl just changed (holdCount reset to 1)
      if (holdCount === 1 && perTeam[otherTeam]) perTeam[otherTeam].holds = 0;

      // Collect floor into checkpoint window
      var winIdx = -1;
      for (var wi = 0; wi < cpBoundaries.length - 1; wi++) {
        if (gameSec >= cpBoundaries[wi] && gameSec < cpBoundaries[wi + 1]) { winIdx = wi; break; }
      }
      if (winIdx === -1 && gameSec >= cpBoundaries[cpBoundaries.length - 1]) winIdx = cpBoundaries.length - 2;
      if (winIdx >= 0 && winIdx < cpLabels.length) windowFloors[cpLabels[winIdx]].push(floor);

      // Compute conviction + opp count
      var comp = computeFromSnap(snap);

      // BWC eligibility: ctrl team leading 2+, floor >= 0.50
      var bwcEligible = ctrlMargin >= 2 && floor >= 0.50;
      var tier = null;

      if (bwcEligible) {
        tier = classifyTier(comp.convTier, ctrlMargin, holdCount, comp.oppCount);

        // First BWC fire
        if (firstBWCSec === null) {
          firstBWCSec = gameSec;
          firstBWCTeam = snap.floor_team;
        }

        // First B
        if (firstBTierSec === null && (tier === 'B' || tier === 'A')) {
          firstBTierSec = gameSec;
        }

        // First A
        if (firstATierSec === null && tier === 'A') {
          firstATierSec = gameSec;
        }

        // Per-team graduation: track which team reached B/A first
        if (perTeam[snap.floor_team]) {
          if (perTeam[snap.floor_team].firstBWC === null) {
            perTeam[snap.floor_team].firstBWC = gameSec;
          }
          if (perTeam[snap.floor_team].firstB === null && (tier === 'B' || tier === 'A')) {
            perTeam[snap.floor_team].firstB = gameSec;
            perTeam[snap.floor_team].floorAtB = floor;
            perTeam[snap.floor_team].marginAtB = ctrlMargin;
          }
          if (perTeam[snap.floor_team].firstA === null && tier === 'A') {
            perTeam[snap.floor_team].firstA = gameSec;
            perTeam[snap.floor_team].floorAtA = floor;
            perTeam[snap.floor_team].marginAtA = ctrlMargin;
          }
        }

        // Oscillation detection: tier went DOWN from previous BWC-eligible snapshot
        if (prevBWCTier !== null && tier !== prevBWCTier) {
          var prevRank = tierRankMap[prevBWCTier] || 0;
          var curRank = tierRankMap[tier] || 0;
          if (curRank < prevRank) {
            oscillations++;
            if (prevBWCTier === 'B' && tier === 'C') oscByType.B_to_C++;
            else if (prevBWCTier === 'A' && tier === 'B') oscByType.A_to_B++;
            else if (prevBWCTier === 'A' && tier === 'C') oscByType.A_to_C++;
          }
        }
        prevBWCTier = tier;

        // Track peak tier
        var curRank2 = tierRankMap[tier] || 0;
        if (curRank2 > peakTierRank) {
          peakTier = tier;
          peakTierRank = curRank2;
          gradFloor = floor;
          gradMargin = ctrlMargin;
          gradGameSec = gameSec;
        }

        // Continuous hold at peak tier
        if (tier === peakTier && peakTierRank > 0) {
          if (!inPeakRun) {
            currentPeakRunStart = gameSec;
            inPeakRun = true;
          }
        } else {
          if (inPeakRun && currentPeakRunStart !== null) {
            var runLen = gameSec - currentPeakRunStart;
            if (runLen > longestPeakHoldSec) longestPeakHoldSec = runLen;
          }
          inPeakRun = false;
          currentPeakRunStart = null;
        }
      } else {
        // Not BWC-eligible — if we were in a peak run, close it
        if (inPeakRun && currentPeakRunStart !== null) {
          var runLen2 = gameSec - currentPeakRunStart;
          if (runLen2 > longestPeakHoldSec) longestPeakHoldSec = runLen2;
        }
        inPeakRun = false;
        currentPeakRunStart = null;
        // Reset prevBWCTier when not eligible
        prevBWCTier = null;
      }

      if (singleGame) {
        timeline.push({
          ts: snap.ts, gameSec, period: snap.period, clock: snap.clock,
          floor, ctrlMargin, ctrl: snap.floor_team,
          conv: comp.convTier, indWon: comp.indWon, oppInd: comp.oppCount,
          tier, bwcEligible, holdCount, oscillations
        });
      }
    }

    // Close any open peak run at game end
    if (inPeakRun && currentPeakRunStart !== null) {
      var finalSec = gameSecondsElapsed(lastSnap.period, lastSnap.clock);
      var finalRun = finalSec - currentPeakRunStart;
      if (finalRun > longestPeakHoldSec) longestPeakHoldSec = finalRun;
    }

    // ── Aggregate per-game results ──
    if (firstBWCSec === null) continue; // no BWC-eligible snapshots — skip

    // Determine if firstBWCTeam won
    var firstTeamWon = firstBWCTeam === gameWinner;

    // Graduation timing
    if (firstBWCSec !== null) allFirstBWC.push(firstBWCSec);
    if (firstBTierSec !== null) {
      allGradTimingB.push(firstBTierSec);
      var q = Math.floor(firstBTierSec / 720);
      var qLabel = ['Q1','Q2','Q3','Q4'][Math.min(q, 3)];
      gradBByQuarter[qLabel].n++;
      if (firstTeamWon) gradBByQuarter[qLabel].wins++;

      // Time from first BWC to B graduation
      timeFromFireToB.push(firstBTierSec - firstBWCSec);
    }
    if (firstATierSec !== null) {
      allGradTimingA.push(firstATierSec);
      var q2 = Math.floor(firstATierSec / 720);
      var qLabel2 = ['Q1','Q2','Q3','Q4'][Math.min(q2, 3)];
      gradAByQuarter[qLabel2].n++;
      if (firstTeamWon) gradAByQuarter[qLabel2].wins++;

      timeFromFireToA.push(firstATierSec - firstBWCSec);
    }

    // Oscillations
    allOscillations.push(oscillations);
    if (oscillations === 0) { oscWinRate.zero.n++; if (firstTeamWon) oscWinRate.zero.wins++; }
    else if (oscillations === 1) { oscWinRate.one.n++; if (firstTeamWon) oscWinRate.one.wins++; }
    else { oscWinRate.two_plus.n++; if (firstTeamWon) oscWinRate.two_plus.wins++; }

    // Peak hold time
    allPeakHoldSec.push(longestPeakHoldSec);
    var holdMin = longestPeakHoldSec / 60;
    var holdBucket;
    if (holdMin < 2) holdBucket = '0-2';
    else if (holdMin < 5) holdBucket = '2-5';
    else if (holdMin < 10) holdBucket = '5-10';
    else if (holdMin < 20) holdBucket = '10-20';
    else holdBucket = '20+';
    allPeakHoldMinBucket[holdBucket].n++;
    if (firstTeamWon) allPeakHoldMinBucket[holdBucket].wins++;

    // Hold time → checkpoint equivalent (6min per cp)
    var cpEquiv = Math.floor(longestPeakHoldSec / 360);
    if (cpEquiv === 0) { holdMinVsCheckpointBuckets['1cp_equiv'].n++; if (firstTeamWon) holdMinVsCheckpointBuckets['1cp_equiv'].wins++; }
    else if (cpEquiv === 1) { holdMinVsCheckpointBuckets['2cp_equiv'].n++; if (firstTeamWon) holdMinVsCheckpointBuckets['2cp_equiv'].wins++; }
    else if (cpEquiv === 2) { holdMinVsCheckpointBuckets['3cp_equiv'].n++; if (firstTeamWon) holdMinVsCheckpointBuckets['3cp_equiv'].wins++; }
    else { holdMinVsCheckpointBuckets['4cp_plus_equiv'].n++; if (firstTeamWon) holdMinVsCheckpointBuckets['4cp_plus_equiv'].wins++; }

    // Wire-to-wire: did first BWC team stay ctrl at last snapshot?
    if (firstBWCTeam === lastCtrl) {
      wireToWire.n++; if (firstTeamWon) wireToWire.wins++;
    } else {
      notWireToWire.n++; if (firstTeamWon) notWireToWire.wins++;
    }

    // Floor at graduation
    if (gradFloor !== null && peakTier) {
      var fb;
      if (gradFloor < 0.60) fb = '0.50-0.59';
      else if (gradFloor < 0.70) fb = '0.60-0.69';
      else if (gradFloor < 0.80) fb = '0.70-0.79';
      else if (gradFloor < 0.90) fb = '0.80-0.89';
      else fb = '0.90+';
      floorAtGrad[fb].n++;
      if (firstTeamWon) floorAtGrad[fb].wins++;
    }

    // Margin at graduation
    if (gradMargin !== null) {
      var mb;
      if (gradMargin <= 2) mb = 'lead_1-2';
      else if (gradMargin <= 7) mb = 'lead_3-7';
      else if (gradMargin <= 14) mb = 'lead_8-14';
      else mb = 'lead_15+';
      marginAtGrad[mb].n++;
      if (firstTeamWon) marginAtGrad[mb].wins++;
    }

    // Early floor surge: compare floor at ~6min vs ~12min
    if (floorAt360 !== null && floorAt720 !== null) {
      var delta = floorAt720 - floorAt360;
      if (delta > 0.08) { earlyFloorSurge.surged.n++; if (firstTeamWon) earlyFloorSurge.surged.wins++; }
      else if (delta < -0.05) { earlyFloorSurge.dropped.n++; if (firstTeamWon) earlyFloorSurge.dropped.wins++; }
      else { earlyFloorSurge.flat.n++; if (firstTeamWon) earlyFloorSurge.flat.wins++; }
    }

    if (singleGame) singleGameTimeline = timeline;

    // ── Per-team graduation aggregation ──
    var hGrad = perTeam[homeAlias] || {};
    var aGrad = perTeam[awayAlias] || {};

    // First team to graduate to B
    var firstBTeam = null;
    if (hGrad.firstB !== null && aGrad.firstB !== null) {
      firstBTeam = hGrad.firstB <= aGrad.firstB ? homeAlias : awayAlias;
      bothGradB.n++;
      if (firstBTeam === gameWinner) bothGradB.first_won++;
    } else if (hGrad.firstB !== null) {
      firstBTeam = homeAlias;
      onlyOneGradB.n++;
      if (firstBTeam === gameWinner) onlyOneGradB.won++;
    } else if (aGrad.firstB !== null) {
      firstBTeam = awayAlias;
      onlyOneGradB.n++;
      if (firstBTeam === gameWinner) onlyOneGradB.won++;
    }
    if (firstBTeam) {
      firstToGradB.n++;
      if (firstBTeam === gameWinner) firstToGradB.won++;
      var fbQ = Math.floor((hGrad.firstB !== null && (aGrad.firstB === null || hGrad.firstB <= aGrad.firstB) ? hGrad.firstB : aGrad.firstB) / 720);
      var fbQLabel = ['Q1','Q2','Q3','Q4'][Math.min(fbQ, 3)];
      firstGradBByQ[fbQLabel].n++;
      if (firstBTeam === gameWinner) firstGradBByQ[fbQLabel].wins++;
    }

    // First team to graduate to A
    var firstATeam = null;
    if (hGrad.firstA !== null && aGrad.firstA !== null) {
      firstATeam = hGrad.firstA <= aGrad.firstA ? homeAlias : awayAlias;
    } else if (hGrad.firstA !== null) {
      firstATeam = homeAlias;
    } else if (aGrad.firstA !== null) {
      firstATeam = awayAlias;
    }
    if (firstATeam) {
      firstToGradA.n++;
      if (firstATeam === gameWinner) firstToGradA.won++;
      var faQ = Math.floor((hGrad.firstA !== null && (aGrad.firstA === null || hGrad.firstA <= aGrad.firstA) ? hGrad.firstA : aGrad.firstA) / 720);
      var faQLabel = ['Q1','Q2','Q3','Q4'][Math.min(faQ, 3)];
      firstGradAByQ[faQLabel].n++;
      if (firstATeam === gameWinner) firstGradAByQ[faQLabel].wins++;
    }

    // ── Inter-checkpoint quality aggregation ──
    // For the ctrl team at each checkpoint window: compute mean, min, stddev of floor
    var ctrlTeamWon = firstBWCTeam === gameWinner; // use firstBWCTeam's perspective for floor quality
    for (var wli2 = 0; wli2 < cpLabels.length; wli2++) {
      var wLabel = cpLabels[wli2];
      var wFloors = windowFloors[wLabel];
      if (wFloors.length < 2) continue;

      var sum = 0, min = 999, max = -999;
      for (var fi = 0; fi < wFloors.length; fi++) {
        sum += wFloors[fi];
        if (wFloors[fi] < min) min = wFloors[fi];
        if (wFloors[fi] > max) max = wFloors[fi];
      }
      var mean = sum / wFloors.length;
      var variance = 0;
      for (var fi2 = 0; fi2 < wFloors.length; fi2++) {
        variance += (wFloors[fi2] - mean) * (wFloors[fi2] - mean);
      }
      var stddev = Math.sqrt(variance / wFloors.length);
      var meanMinSpread = mean - min;

      // Track per-window aggregates
      perWindowQuality[wLabel].floors.push(mean);
      perWindowQuality[wLabel].wins.push(firstTeamWon ? 1 : 0);
      perWindowQuality[wLabel].mins.push(min);
      perWindowQuality[wLabel].stddevs.push(stddev);

      // Bucket by mean floor
      var mfb;
      if (mean < 0.60) mfb = '0.50-0.59';
      else if (mean < 0.70) mfb = '0.60-0.69';
      else if (mean < 0.80) mfb = '0.70-0.79';
      else if (mean < 0.90) mfb = '0.80-0.89';
      else mfb = '0.90+';
      meanFloorBuckets[mfb].n++;
      if (firstTeamWon) meanFloorBuckets[mfb].wins++;

      // Bucket by min floor
      var mnb;
      if (min < 0.40) mnb = '<0.40';
      else if (min < 0.50) mnb = '0.40-0.49';
      else if (min < 0.60) mnb = '0.50-0.59';
      else if (min < 0.70) mnb = '0.60-0.69';
      else mnb = '0.70+';
      minFloorBuckets[mnb].n++;
      if (firstTeamWon) minFloorBuckets[mnb].wins++;

      // Bucket by stddev
      var vb;
      if (stddev < 0.03) vb = 'tight (<0.03)';
      else if (stddev < 0.08) vb = 'moderate (0.03-0.08)';
      else if (stddev < 0.15) vb = 'volatile (0.08-0.15)';
      else vb = 'chaotic (0.15+)';
      floorVarianceBuckets[vb].n++;
      if (firstTeamWon) floorVarianceBuckets[vb].wins++;

      // Bucket by mean-min spread
      var msb;
      if (meanMinSpread < 0.05) msb = 'tight (<0.05)';
      else if (meanMinSpread < 0.10) msb = 'moderate (0.05-0.10)';
      else if (meanMinSpread < 0.20) msb = 'gapped (0.10-0.20)';
      else msb = 'dangerous (0.20+)';
      meanMinSpreadBuckets[msb].n++;
      if (firstTeamWon) meanMinSpreadBuckets[msb].wins++;
    }

    // ── Winner backtrace ──
    var winTeam = gameWinner;
    var loseTeam = winTeam === homeAlias ? awayAlias : homeAlias;
    var wGrad = perTeam[winTeam];
    var lGrad = perTeam[loseTeam];

    if (wGrad && winTeam) {
      winnerProfile.total_winners++;

      // Was winner the first BWC team?
      if (firstBWCTeam === winTeam) winnerProfile.was_first_bwc_team++;

      // Winner's firstBWC timing
      if (wGrad.firstBWC !== null) winnerProfile.firstBWC_sec.push(wGrad.firstBWC);

      // Winner's graduation path
      if (wGrad.firstA !== null) {
        winnerProfile.graduated_a++;
        winnerProfile.gradA_sec.push(wGrad.firstA);
        winnerProfile.floorAtGradA.push(wGrad.floorAtA);
        winnerProfile.marginAtGradA.push(wGrad.marginAtA);
        var waQ = ['Q1','Q2','Q3','Q4'][Math.min(Math.floor(wGrad.firstA / 720), 3)];
        winnerGradAByQ[waQ].n++;

        if (wGrad.firstBWC !== null) winnerProfile.fireToGradA_sec.push(wGrad.firstA - wGrad.firstBWC);

        // Also track B timing if they went through B on the way to A
        if (wGrad.firstB !== null) {
          winnerProfile.gradB_sec.push(wGrad.firstB);
          winnerProfile.floorAtGradB.push(wGrad.floorAtB);
          winnerProfile.marginAtGradB.push(wGrad.marginAtB);
          if (wGrad.firstBWC !== null) winnerProfile.fireToGradB_sec.push(wGrad.firstB - wGrad.firstBWC);
          var wbQ2 = ['Q1','Q2','Q3','Q4'][Math.min(Math.floor(wGrad.firstB / 720), 3)];
          winnerGradBByQ[wbQ2].n++;
        }

        // Was winner first or second to A?
        if (lGrad && lGrad.firstA !== null) {
          if (wGrad.firstA <= lGrad.firstA) winnerProfile.was_first_to_grad_a++;
          else winnerProfile.was_second_to_grad_a++;
        } else {
          winnerProfile.was_only_to_grad_a++;
        }

        // Path classification for A graduates
        if (wGrad.firstB !== null && wGrad.firstB < wGrad.firstA) {
          // Had B before A
          if (wGrad.firstBWC !== null && wGrad.firstBWC < wGrad.firstB) winnerPath.c_to_a++;
          else winnerPath.b_to_a++;
        } else {
          winnerPath.born_a++;
        }
      } else if (wGrad.firstB !== null) {
        winnerProfile.graduated_b_only++;
        winnerProfile.gradB_sec.push(wGrad.firstB);
        winnerProfile.floorAtGradB.push(wGrad.floorAtB);
        winnerProfile.marginAtGradB.push(wGrad.marginAtB);
        var wbQ = ['Q1','Q2','Q3','Q4'][Math.min(Math.floor(wGrad.firstB / 720), 3)];
        winnerGradBByQ[wbQ].n++;

        if (wGrad.firstBWC !== null) winnerProfile.fireToGradB_sec.push(wGrad.firstB - wGrad.firstBWC);

        // Was winner first or second to B?
        if (lGrad && lGrad.firstB !== null) {
          if (wGrad.firstB <= lGrad.firstB) winnerProfile.was_first_to_grad_b++;
          else winnerProfile.was_second_to_grad_b++;
        } else {
          winnerProfile.was_only_to_grad_b++;
        }

        // Path for B-only
        if (wGrad.firstBWC !== null && wGrad.firstBWC < wGrad.firstB) winnerPath.c_to_b++;
        else winnerPath.born_b++;
      } else if (wGrad.firstBWC !== null) {
        winnerProfile.stayed_c++;
        winnerPath.stayed_c++;
      } else {
        winnerProfile.never_bwc++;
        winnerPath.never_bwc++;
      }

      // Winner ctrl path: wire-to-wire, took over, or recaptured
      if (firstBWCTeam === winTeam && lastSnap.floor_team === winTeam) {
        winnerCtrlPath.wire_to_wire++;
      } else if (firstBWCTeam !== winTeam && wGrad.firstBWC !== null) {
        // Winner wasn't first BWC team but eventually got ctrl
        winnerCtrlPath.took_over++;
      } else if (firstBWCTeam === winTeam && lastSnap.floor_team !== winTeam) {
        // Winner was first but lost ctrl by end
        winnerCtrlPath.recaptured++;
      }
    }
  }

  // ── 4. Build output ──
  var result = {
    _meta: {
      description: 'Production replay: 60-second resolution graduation analysis from live server snapshots',
      total_games: totalGames,
      total_snaps: totalSnaps,
      avg_snaps_per_game: totalGames > 0 ? Math.round(totalSnaps / totalGames) : 0,
      close_games_only: closeOnly,
      elapsed_ms: Date.now() - t0,
    },

    section_1_graduation_timing: {
      description: 'Game-seconds when graduation first occurs. 720=Q1 end, 1440=Q2 end, 2160=Q3 end, 2880=Q4 end.',
      first_bwc_eligible: {
        n: allFirstBWC.length,
        median_sec: percentile(allFirstBWC, 50),
        p25_sec: percentile(allFirstBWC, 25),
        p75_sec: percentile(allFirstBWC, 75),
        median_label: secToLabel(percentile(allFirstBWC, 50) || 0),
      },
      first_tier_b: {
        n: allGradTimingB.length,
        median_sec: percentile(allGradTimingB, 50),
        p25_sec: percentile(allGradTimingB, 25),
        p75_sec: percentile(allGradTimingB, 75),
        median_label: secToLabel(percentile(allGradTimingB, 50) || 0),
        pct_of_bwc_eligible: allFirstBWC.length > 0 ? Math.round(allGradTimingB.length / allFirstBWC.length * 1000) / 10 : null,
      },
      first_tier_a: {
        n: allGradTimingA.length,
        median_sec: percentile(allGradTimingA, 50),
        p25_sec: percentile(allGradTimingA, 25),
        p75_sec: percentile(allGradTimingA, 75),
        median_label: secToLabel(percentile(allGradTimingA, 50) || 0),
        pct_of_bwc_eligible: allFirstBWC.length > 0 ? Math.round(allGradTimingA.length / allFirstBWC.length * 1000) / 10 : null,
      },
      by_quarter_b: { Q1: pctHelper(gradBByQuarter.Q1), Q2: pctHelper(gradBByQuarter.Q2), Q3: pctHelper(gradBByQuarter.Q3), Q4: pctHelper(gradBByQuarter.Q4) },
      by_quarter_a: { Q1: pctHelper(gradAByQuarter.Q1), Q2: pctHelper(gradAByQuarter.Q2), Q3: pctHelper(gradAByQuarter.Q3), Q4: pctHelper(gradAByQuarter.Q4) },
    },

    section_2_time_from_fire_to_graduation: {
      description: 'Seconds from first BWC eligibility to graduation. 0 = graduated on first eligible snapshot.',
      fire_to_b: {
        n: timeFromFireToB.length,
        median_sec: percentile(timeFromFireToB, 50),
        p25_sec: percentile(timeFromFireToB, 25),
        p75_sec: percentile(timeFromFireToB, 75),
        instant_graduation_n: timeFromFireToB.filter(function(t) { return t <= 60; }).length,
        instant_graduation_pct: timeFromFireToB.length > 0 ? Math.round(timeFromFireToB.filter(function(t) { return t <= 60; }).length / timeFromFireToB.length * 1000) / 10 : null,
      },
      fire_to_a: {
        n: timeFromFireToA.length,
        median_sec: percentile(timeFromFireToA, 50),
        p25_sec: percentile(timeFromFireToA, 25),
        p75_sec: percentile(timeFromFireToA, 75),
        instant_graduation_n: timeFromFireToA.filter(function(t) { return t <= 60; }).length,
        instant_graduation_pct: timeFromFireToA.length > 0 ? Math.round(timeFromFireToA.filter(function(t) { return t <= 60; }).length / timeFromFireToA.length * 1000) / 10 : null,
      },
    },

    section_3_oscillation: {
      description: 'Micro-graduation oscillation: how often does tier bounce DOWN after upgrading? At 60s resolution.',
      total_oscillations: allOscillations.reduce(function(a, b) { return a + b; }, 0),
      avg_per_game: totalGames > 0 ? Math.round(allOscillations.reduce(function(a, b) { return a + b; }, 0) / totalGames * 100) / 100 : 0,
      by_type: oscByType,
      by_oscillation_count: {
        zero: pctHelper(oscWinRate.zero),
        one: pctHelper(oscWinRate.one),
        two_plus: pctHelper(oscWinRate.two_plus),
      },
    },

    section_4_continuous_hold_time: {
      description: 'Longest continuous hold at peak tier (in real minutes, not checkpoint count). Win rate by hold duration.',
      median_hold_sec: percentile(allPeakHoldSec, 50),
      p25_hold_sec: percentile(allPeakHoldSec, 25),
      p75_hold_sec: percentile(allPeakHoldSec, 75),
      median_hold_min: percentile(allPeakHoldSec, 50) != null ? Math.round(percentile(allPeakHoldSec, 50) / 60 * 10) / 10 : null,
      by_duration: {
        '0-2 min': pctHelper(allPeakHoldMinBucket['0-2']),
        '2-5 min': pctHelper(allPeakHoldMinBucket['2-5']),
        '5-10 min': pctHelper(allPeakHoldMinBucket['5-10']),
        '10-20 min': pctHelper(allPeakHoldMinBucket['10-20']),
        '20+ min': pctHelper(allPeakHoldMinBucket['20+']),
      },
    },

    section_5_hold_time_vs_checkpoints: {
      description: 'Peak hold time mapped to checkpoint equivalents (1 cp ≈ 6 min). Compare with tier journey checkpoint-count data.',
      by_cp_equivalent: {
        '<1 cp (0-6 min)': pctHelper(holdMinVsCheckpointBuckets['1cp_equiv']),
        '1-2 cp (6-12 min)': pctHelper(holdMinVsCheckpointBuckets['2cp_equiv']),
        '2-3 cp (12-18 min)': pctHelper(holdMinVsCheckpointBuckets['3cp_equiv']),
        '3+ cp (18+ min)': pctHelper(holdMinVsCheckpointBuckets['4cp_plus_equiv']),
      },
    },

    section_6_wire_to_wire: {
      description: 'First BWC team stays ctrl at last snapshot = wire-to-wire.',
      wire_to_wire: pctHelper(wireToWire),
      flipped: pctHelper(notWireToWire),
    },

    section_7_conditions_at_graduation: {
      floor_at_graduation: Object.fromEntries(Object.entries(floorAtGrad).map(function(e) { return [e[0], pctHelper(e[1])]; })),
      margin_at_graduation: Object.fromEntries(Object.entries(marginAtGrad).map(function(e) { return [e[0], pctHelper(e[1])]; })),
    },

    section_8_early_floor_surge: {
      description: 'Floor delta from Q1-6min to Q1-end as predictor. Surge > +0.08, drop < -0.05.',
      surged: pctHelper(earlyFloorSurge.surged),
      flat: pctHelper(earlyFloorSurge.flat),
      dropped: pctHelper(earlyFloorSurge.dropped),
    },

    section_9_first_to_graduate: {
      description: 'Which team GRADUATED to B (or A) first? Did that team win? This is the POSITION OPEN anchor question.',
      first_to_b: {
        n: firstToGradB.n,
        won: firstToGradB.won,
        pct: firstToGradB.n > 0 ? Math.round(firstToGradB.won / firstToGradB.n * 1000) / 10 : null,
      },
      first_to_a: {
        n: firstToGradA.n,
        won: firstToGradA.won,
        pct: firstToGradA.n > 0 ? Math.round(firstToGradA.won / firstToGradA.n * 1000) / 10 : null,
      },
      both_graduated_b: {
        n: bothGradB.n,
        first_won: bothGradB.first_won,
        pct: bothGradB.n > 0 ? Math.round(bothGradB.first_won / bothGradB.n * 1000) / 10 : null,
        description: 'Both teams reached B — did the first one to get there win?',
      },
      only_one_graduated_b: {
        n: onlyOneGradB.n,
        won: onlyOneGradB.won,
        pct: onlyOneGradB.n > 0 ? Math.round(onlyOneGradB.won / onlyOneGradB.n * 1000) / 10 : null,
        description: 'Only one team reached B — did they win?',
      },
      first_b_by_quarter: {
        Q1: pctHelper(firstGradBByQ.Q1), Q2: pctHelper(firstGradBByQ.Q2),
        Q3: pctHelper(firstGradBByQ.Q3), Q4: pctHelper(firstGradBByQ.Q4),
      },
      first_a_by_quarter: {
        Q1: pctHelper(firstGradAByQ.Q1), Q2: pctHelper(firstGradAByQ.Q2),
        Q3: pctHelper(firstGradAByQ.Q3), Q4: pctHelper(firstGradAByQ.Q4),
      },
    },

    section_10_intercheckpoint_floor_quality: {
      description: 'Floor quality BETWEEN 6-min checkpoints from ~60s snapshots. Mean, min, variance as quality gates.',
      by_mean_floor: Object.fromEntries(Object.entries(meanFloorBuckets).map(function(e) { return [e[0], pctHelper(e[1])]; })),
      by_min_floor: Object.fromEntries(Object.entries(minFloorBuckets).map(function(e) { return [e[0], pctHelper(e[1])]; })),
      by_variance: Object.fromEntries(Object.entries(floorVarianceBuckets).map(function(e) { return [e[0], pctHelper(e[1])]; })),
      by_mean_min_spread: Object.fromEntries(Object.entries(meanMinSpreadBuckets).map(function(e) { return [e[0], pctHelper(e[1])]; })),
      per_window_summary: Object.fromEntries(cpLabels.map(function(wl) {
        var d = perWindowQuality[wl];
        if (d.floors.length === 0) return [wl, { n: 0 }];
        var avgMean = d.floors.reduce(function(a,b){return a+b;},0) / d.floors.length;
        var avgMin = d.mins.reduce(function(a,b){return a+b;},0) / d.mins.length;
        var avgStd = d.stddevs.reduce(function(a,b){return a+b;},0) / d.stddevs.length;
        var winCount = d.wins.reduce(function(a,b){return a+b;},0);
        return [wl, {
          n: d.floors.length,
          avg_mean_floor: Math.round(avgMean * 1000) / 1000,
          avg_min_floor: Math.round(avgMin * 1000) / 1000,
          avg_stddev: Math.round(avgStd * 1000) / 1000,
          avg_mean_min_spread: Math.round((avgMean - avgMin) * 1000) / 1000,
          win_rate: Math.round(winCount / d.floors.length * 1000) / 10,
        }];
      })),
    },

    section_11_winner_backtrace: {
      description: 'Start from WINNERS and trace their graduation patterns backward. How did the winning team get there?',
      total_winners: winnerProfile.total_winners,
      graduation_distribution: {
        graduated_to_a: winnerProfile.graduated_a,
        graduated_to_b_only: winnerProfile.graduated_b_only,
        stayed_c: winnerProfile.stayed_c,
        never_bwc_eligible: winnerProfile.never_bwc,
        pct_graduated_a: winnerProfile.total_winners > 0 ? Math.round(winnerProfile.graduated_a / winnerProfile.total_winners * 1000) / 10 : null,
        pct_graduated_b_plus: winnerProfile.total_winners > 0 ? Math.round((winnerProfile.graduated_a + winnerProfile.graduated_b_only) / winnerProfile.total_winners * 1000) / 10 : null,
      },
      graduation_path: winnerPath,
      winner_was_first_bwc_team: {
        n: winnerProfile.was_first_bwc_team,
        pct: winnerProfile.total_winners > 0 ? Math.round(winnerProfile.was_first_bwc_team / winnerProfile.total_winners * 1000) / 10 : null,
      },
      ctrl_path: winnerCtrlPath,
      anchor_reliability: {
        description: 'Of winners who graduated to B: were they the FIRST, SECOND, or ONLY team to graduate?',
        first_to_b: winnerProfile.was_first_to_grad_b,
        second_to_b: winnerProfile.was_second_to_grad_b,
        only_to_b: winnerProfile.was_only_to_grad_b,
        first_to_a: winnerProfile.was_first_to_grad_a,
        second_to_a: winnerProfile.was_second_to_grad_a,
        only_to_a: winnerProfile.was_only_to_grad_a,
      },
      winner_timing: {
        first_bwc: {
          n: winnerProfile.firstBWC_sec.length,
          median_sec: percentile(winnerProfile.firstBWC_sec, 50),
          median_label: secToLabel(percentile(winnerProfile.firstBWC_sec, 50) || 0),
          p25_sec: percentile(winnerProfile.firstBWC_sec, 25),
          p75_sec: percentile(winnerProfile.firstBWC_sec, 75),
        },
        grad_b: {
          n: winnerProfile.gradB_sec.length,
          median_sec: percentile(winnerProfile.gradB_sec, 50),
          median_label: secToLabel(percentile(winnerProfile.gradB_sec, 50) || 0),
        },
        grad_a: {
          n: winnerProfile.gradA_sec.length,
          median_sec: percentile(winnerProfile.gradA_sec, 50),
          median_label: secToLabel(percentile(winnerProfile.gradA_sec, 50) || 0),
        },
        fire_to_grad_b: {
          n: winnerProfile.fireToGradB_sec.length,
          median_sec: percentile(winnerProfile.fireToGradB_sec, 50),
        },
        fire_to_grad_a: {
          n: winnerProfile.fireToGradA_sec.length,
          median_sec: percentile(winnerProfile.fireToGradA_sec, 50),
        },
      },
      winner_grad_b_by_quarter: winnerGradBByQ,
      winner_grad_a_by_quarter: winnerGradAByQ,
      conditions_at_graduation: {
        b_graduates: {
          n: winnerProfile.floorAtGradB.length,
          median_floor: percentile(winnerProfile.floorAtGradB, 50),
          median_margin: percentile(winnerProfile.marginAtGradB, 50),
          p25_floor: percentile(winnerProfile.floorAtGradB, 25),
          p75_floor: percentile(winnerProfile.floorAtGradB, 75),
        },
        a_graduates: {
          n: winnerProfile.floorAtGradA.length,
          median_floor: percentile(winnerProfile.floorAtGradA, 50),
          median_margin: percentile(winnerProfile.marginAtGradA, 50),
          p25_floor: percentile(winnerProfile.floorAtGradA, 25),
          p75_floor: percentile(winnerProfile.floorAtGradA, 75),
        },
      },
    },
  };

  if (singleGame && singleGameTimeline) {
    result.single_game_timeline = {
      game_id: singleGame,
      matchup: snapQuery[0]?.matchup || null,
      winner: snapQuery[0]?.winner || null,
      final_margin: snapQuery[0]?.margin || null,
      snapshots: singleGameTimeline.length,
      timeline: singleGameTimeline,
    };
  }

  return result;
}

// ── REPORT: DUAL TRACKING SIM — validate dual tracking + oppCount + I4 threshold ──
// ?phase=report_dual_tracking_sim             — full dataset
// ?phase=report_dual_tracking_sim&close=1     — final margin ≤ 8 only
// ══════════════════════════════════════════════════════════════════════════════
async function reportDualTrackingSim(sql, url) {
  var closeOnly = url?.searchParams?.get('close') === '1';
  var marginFilter = closeOnly ? 8 : 999;

  var rows = await sql`
    SELECT game_id, checkpoint, margin_at_snapshot AS margin,
           indicators, pbp_derived, ctrl_team_won, final_margin
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
      AND pbp_derived IS NOT NULL
      AND ABS(final_margin) <= ${marginFilter}
    ORDER BY game_id, checkpoint
  `;

  var checkpoints = CP_LABELS;
  var cpIdx = {}; for (var ci = 0; ci < checkpoints.length; ci++) cpIdx[checkpoints[ci]] = ci;
  var Wt = { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };

  // Group by game
  var gameMap = {};
  for (var r of rows) {
    var ind = typeof r.indicators === 'string' ? JSON.parse(r.indicators) : r.indicators;
    var pd = typeof r.pbp_derived === 'string' ? JSON.parse(r.pbp_derived) : r.pbp_derived;
    if (!ind || !pd) continue;
    if (!gameMap[r.game_id]) gameMap[r.game_id] = [];
    gameMap[r.game_id].push({
      checkpoint: r.checkpoint,
      margin: r.margin,
      ctrl_team_won: r.ctrl_team_won,
      final_margin: r.final_margin,
      homeAlias: ind.homeAlias,
      awayAlias: ind.awayAlias,
      I1: ind.I1, I2: ind.I2, I3: ind.I3, I4: ind.I4, I5: ind.I5,
      storedCtrl: ind.controlTeam,
      storedFloor: ind.score,
      hBigLead: pd.hBigLead || 0, aBigLead: pd.aBigLead || 0,
      q4hPts: pd.q4hPts, q4aPts: pd.q4aPts,
    });
  }

  // ── Recompute I4 with new biggest-lead rule ──
  function computeNewI4(hBigLead, aBigLead, q4hPts, q4aPts) {
    var subA = 0;
    if (hBigLead >= aBigLead + 2) {
      subA = (aBigLead >= 0.75 * hBigLead) ? 0 : 1;
    } else if (aBigLead >= hBigLead + 2) {
      subA = (hBigLead >= 0.75 * aBigLead) ? 0 : -1;
    }
    var subB = 0;
    if (q4hPts != null && q4aPts != null) {
      var q4d = q4hPts - q4aPts;
      subB = q4d > 2 ? 1 : q4d < -2 ? -1 : 0;
    }
    var raw = subA + subB;
    return raw > 0 ? 1 : raw === 0 ? 0.5 : 0;
  }

  // ── Recompute control/floor/conviction from indicator set ──
  function recompute(snap, useNewI4) {
    var i4 = useNewI4 ? computeNewI4(snap.hBigLead, snap.aBigLead, snap.q4hPts, snap.q4aPts) : snap.I4;
    var composite = snap.I1 * Wt.I1 + snap.I2 * Wt.I2 + snap.I3 * Wt.I3 + i4 * Wt.I4 + snap.I5 * Wt.I5;
    var ctrlHome = composite >= 0.5;
    var ctrl = ctrlHome ? snap.homeAlias : snap.awayAlias;
    var floor = ctrlHome ? composite : 1 - composite;
    floor = Math.round(floor * 100) / 100;
    // Margin relative to ctrl team
    var ctrlMargin = ctrlHome ? snap.margin : -snap.margin;
    // Indicators relative to ctrl team
    var vals = [
      { k: 'I1', v: ctrlHome ? snap.I1 : 1 - snap.I1 },
      { k: 'I2', v: ctrlHome ? snap.I2 : 1 - snap.I2 },
      { k: 'I3', v: ctrlHome ? snap.I3 : 1 - snap.I3 },
      { k: 'I4', v: ctrlHome ? i4 : 1 - i4 },
      { k: 'I5', v: ctrlHome ? snap.I5 : 1 - snap.I5 },
    ];
    var won = vals.filter(function(x) { return x.v === 1; }).map(function(x) { return x.k; });
    var lost = vals.filter(function(x) { return x.v === 0; }).map(function(x) { return x.k; });
    var count = won.length;
    var oppCount = lost.length;
    // Conviction tier
    var killerPairs = ['I4+I5','I3+I4','I3+I5'];
    var hasPair = false;
    for (var pi = 0; pi < won.length; pi++) {
      for (var pj = pi + 1; pj < won.length; pj++) {
        var pair = won[pi] + '+' + won[pj];
        if (killerPairs.indexOf(pair) >= 0) { hasPair = true; break; }
      }
      if (hasPair) break;
    }
    var tier;
    if ((won.indexOf('I4') >= 0 && won.indexOf('I5') >= 0) || count >= 4) tier = 'DOMINANT';
    else if ((won.indexOf('I3') >= 0 && won.indexOf('I4') >= 0) || (won.indexOf('I3') >= 0 && won.indexOf('I5') >= 0)) tier = 'STRONG';
    else if (count >= 2) tier = 'MODEST';
    else if (count === 1) tier = 'CONDITIONAL';
    else tier = 'NO ENTRY';
    // Winner determination: did the ctrl team win?
    // ctrl_team_won in DB is relative to stored ctrl. Adjust if our ctrl differs.
    var ctrlWon;
    if (ctrl === snap.storedCtrl) ctrlWon = snap.ctrl_team_won;
    else ctrlWon = !snap.ctrl_team_won;
    return { ctrl: ctrl, floor: floor, ctrlMargin: ctrlMargin, tier: tier, count: count, oppCount: oppCount, won: won, hasPair: hasPair, ctrlWon: ctrlWon };
  }

  // ── Rank classification with parameterized oppCount threshold ──
  function classifyRankSim(tier, lead, holds, oppCount, oppThresh) {
    if (tier === 'DOMINANT' && lead >= 8 && holds >= 4 && oppCount <= 1) return 'A';
    if (oppCount >= oppThresh) return 'C';
    if ((tier === 'DOMINANT' || tier === 'STRONG') && lead >= 3 && holds >= 2) return 'B';
    return 'C';
  }

  // ── Walk one game under one config → per-team graduation state ──
  function walkGame(snaps, useNewI4, oppThresh) {
    var homeA = snaps[0].homeAlias, awayA = snaps[0].awayAlias;
    var cpMap = {};
    for (var s of snaps) cpMap[s.checkpoint] = s;
    // Per-team tracking
    var teams = [homeA, awayA];
    var holds = {}; holds[homeA] = 0; holds[awayA] = 0;
    var bwcFired = {}; bwcFired[homeA] = false; bwcFired[awayA] = false;
    var bwcCp = {}; bwcCp[homeA] = null; bwcCp[awayA] = null;
    var curRank = {}; curRank[homeA] = null; curRank[awayA] = null;
    var gradCp = {}; gradCp[homeA] = null; gradCp[awayA] = null;
    var gradRank = {}; gradRank[homeA] = null; gradRank[awayA] = null;
    var gradFloor = {}; gradFloor[homeA] = null; gradFloor[awayA] = null;
    var gradTier = {}; gradTier[homeA] = null; gradTier[awayA] = null;
    var gradHolds = {}; gradHolds[homeA] = 0; gradHolds[awayA] = 0;
    var prevCtrl = null;
    var firstBWCTeam = null;
    var winner = null;
    var ctrlWonFinal = null;

    // Track last-known state per team (for opponent context at first graduation)
    var lastState = {};
    lastState[homeA] = { floor: null, tier: null, margin: null, oppCount: null, cp: null, indWon: null };
    lastState[awayA] = { floor: null, tier: null, margin: null, oppCount: null, cp: null, indWon: null };
    // Track cumulative hold peaks (did they ever have a strong run?)
    var peakHolds = {}; peakHolds[homeA] = 0; peakHolds[awayA] = 0;

    var firstGradTeam = null;
    var firstGradContext = null; // snapshot of opponent state at first graduation

    for (var ci = 0; ci < checkpoints.length; ci++) {
      var cpLabel = checkpoints[ci];
      var snap = cpMap[cpLabel];
      if (!snap) continue;
      var rc = recompute(snap, useNewI4);
      ctrlWonFinal = rc.ctrlWon;
      if (ci === checkpoints.length - 1 || !cpMap[checkpoints[ci + 1]]) {
        winner = rc.ctrlWon ? rc.ctrl : (rc.ctrl === homeA ? awayA : homeA);
      }
      var curTeam = rc.ctrl;
      var othTeam = curTeam === homeA ? awayA : homeA;
      // Update consecutive holds
      if (curTeam === prevCtrl) {
        holds[curTeam]++;
      } else {
        holds[curTeam] = 1;
        holds[othTeam] = 0;
      }
      if (holds[curTeam] > peakHolds[curTeam]) peakHolds[curTeam] = holds[curTeam];
      prevCtrl = curTeam;

      // Save last-known state for the controlling team
      lastState[curTeam] = {
        floor: rc.floor, tier: rc.tier, margin: rc.ctrlMargin,
        oppCount: rc.oppCount, cp: cpLabel, indWon: rc.won.slice(),
      };

      // BWC eligibility: period >= 2 (Q2_6+), floor >= 0.60, margin >= 2, 3+ holds
      var periodOK = cpIdx[cpLabel] >= 2;
      var bwcEligible = periodOK && rc.floor >= 0.60 && rc.ctrlMargin >= 2 && holds[curTeam] >= 3;
      if (bwcEligible) {
        if (!bwcFired[curTeam]) {
          bwcFired[curTeam] = true;
          bwcCp[curTeam] = cpLabel;
          if (!firstBWCTeam) firstBWCTeam = curTeam;
        }
        // Classify rank
        var rank = classifyRankSim(rc.tier, rc.ctrlMargin, holds[curTeam], rc.oppCount, oppThresh);
        var prevRankVal = curRank[curTeam];
        curRank[curTeam] = rank;
        // Detect graduation (rank upgrade)
        var justGraduated = false;
        if (!gradCp[curTeam]) {
          if ((prevRankVal === 'C' || prevRankVal === null) && (rank === 'B' || rank === 'A')) {
            gradCp[curTeam] = cpLabel;
            gradRank[curTeam] = rank;
            gradFloor[curTeam] = rc.floor;
            gradTier[curTeam] = rc.tier;
            gradHolds[curTeam] = holds[curTeam];
            justGraduated = true;
          } else if (prevRankVal === 'B' && rank === 'A') {
            gradCp[curTeam] = cpLabel;
            gradRank[curTeam] = rank;
            gradFloor[curTeam] = rc.floor;
            gradTier[curTeam] = rc.tier;
            gradHolds[curTeam] = holds[curTeam];
            justGraduated = true;
          }
        }
        // Rank upgrade after initial graduation
        if (gradCp[curTeam] && gradRank[curTeam] === 'B' && rank === 'A') {
          gradRank[curTeam] = 'A';
          gradCp[curTeam] = cpLabel;
        }

        // ── Capture opponent context at moment of FIRST graduation in this game ──
        if (justGraduated && !firstGradTeam) {
          firstGradTeam = curTeam;
          var opp = othTeam;
          var oppLast = lastState[opp];
          firstGradContext = {
            gradTeam: curTeam, gradRank: rank, gradCp: cpLabel,
            gradFloor: rc.floor, gradMargin: rc.ctrlMargin, gradTier: rc.tier,
            gradHolds: holds[curTeam],
            // Opponent structural state
            oppTeam: opp,
            oppCurrentHolds: holds[opp],         // 0 since ctrl team has control
            oppPeakHolds: peakHolds[opp],         // best consecutive run so far
            oppHadBWC: bwcFired[opp],             // did opp already achieve BWC?
            oppBestRank: curRank[opp] || gradRank[opp] || 'none',
            oppIndicators: rc.oppCount,           // how many ind the opp currently owns
            // Opponent's last-known state (from when THEY had control)
            oppLastFloor: oppLast.floor,
            oppLastTier: oppLast.tier,
            oppLastMargin: oppLast.margin,
            oppLastCp: oppLast.cp,
            oppLastIndWon: oppLast.indWon,
            // Recency: how many checkpoints ago did opp have control?
            oppRecency: oppLast.cp ? ci - cpIdx[oppLast.cp] : null,
          };
        }
      } else {
        curRank[curTeam] = null;
      }
    }
    if (!winner && snaps.length > 0) {
      var fm = snaps[0].final_margin;
      winner = fm > 0 ? homeA : awayA;
    }

    // Enrich firstGradContext with outcome data
    if (firstGradContext) {
      var opp = firstGradContext.oppTeam;
      firstGradContext.oppEventuallyGrad = !!gradCp[opp];
      firstGradContext.oppFinalRank = gradRank[opp] || 'none';
      firstGradContext.oppGradCp = gradCp[opp] || null;
      firstGradContext.cpGap = (gradCp[opp] && firstGradContext.gradCp)
        ? cpIdx[gradCp[opp]] - cpIdx[firstGradContext.gradCp] : null;
      firstGradContext.firstTeamWon = firstGradContext.gradTeam === winner;
    }

    return {
      homeA: homeA, awayA: awayA, winner: winner,
      firstBWCTeam: firstBWCTeam,
      bwcFired: bwcFired, bwcCp: bwcCp,
      gradCp: gradCp, gradRank: gradRank, gradFloor: gradFloor,
      gradTier: gradTier, gradHolds: gradHolds,
      firstGradContext: firstGradContext,
    };
  }

  // ── Apply PO strategy to game walk result ──
  function applyStrategy(gw, strategy) {
    var homeA = gw.homeA, awayA = gw.awayA;
    var poTeam = null, poCp = null, poRank = null;

    if (strategy === 'single_anchor') {
      // Only the first BWC team can graduate
      var anchor = gw.firstBWCTeam;
      if (anchor && gw.gradCp[anchor]) {
        poTeam = anchor;
        poCp = gw.gradCp[anchor];
        poRank = gw.gradRank[anchor];
      }
    } else if (strategy === 'first_to_grad') {
      // First team to graduate gets PO
      var hCp = gw.gradCp[homeA], aCp = gw.gradCp[awayA];
      if (hCp && aCp) {
        poTeam = cpIdx[hCp] <= cpIdx[aCp] ? homeA : awayA;
        poCp = cpIdx[hCp] <= cpIdx[aCp] ? hCp : aCp;
      } else if (hCp) { poTeam = homeA; poCp = hCp; }
      else if (aCp) { poTeam = awayA; poCp = aCp; }
      if (poTeam) poRank = gw.gradRank[poTeam];
    } else if (strategy === 'only_one_grad') {
      // PO only if exactly one team graduated (in the entire game)
      var hGrad = !!gw.gradCp[homeA], aGrad = !!gw.gradCp[awayA];
      if (hGrad && !aGrad) { poTeam = homeA; poCp = gw.gradCp[homeA]; poRank = gw.gradRank[homeA]; }
      else if (aGrad && !hGrad) { poTeam = awayA; poCp = gw.gradCp[awayA]; poRank = gw.gradRank[awayA]; }
      // Both graduated → suppress
    } else if (strategy === 'stronger_grad') {
      // If both graduated, compare rank > floor > holds. If only one, use them.
      var hGr = !!gw.gradCp[homeA], aGr = !!gw.gradCp[awayA];
      if (hGr && !aGr) { poTeam = homeA; }
      else if (aGr && !hGr) { poTeam = awayA; }
      else if (hGr && aGr) {
        // Compare: rank first (A > B), then floor, then holds
        var hR = gw.gradRank[homeA], aR = gw.gradRank[awayA];
        var rankVal = { A: 3, B: 2, C: 1 };
        if ((rankVal[hR] || 0) > (rankVal[aR] || 0)) poTeam = homeA;
        else if ((rankVal[aR] || 0) > (rankVal[hR] || 0)) poTeam = awayA;
        else if ((gw.gradFloor[homeA] || 0) > (gw.gradFloor[awayA] || 0)) poTeam = homeA;
        else if ((gw.gradFloor[awayA] || 0) > (gw.gradFloor[homeA] || 0)) poTeam = awayA;
        else if ((gw.gradHolds[homeA] || 0) > (gw.gradHolds[awayA] || 0)) poTeam = homeA;
        else poTeam = awayA; // fallback to away (arbitrary)
      }
      if (poTeam) { poCp = gw.gradCp[poTeam]; poRank = gw.gradRank[poTeam]; }
    }

    return { poTeam: poTeam, poCp: poCp, poRank: poRank };
  }

  // ── Run simulation ──
  var configs = [
    { name: 'old_i4_opp2', newI4: false, oppThresh: 2 },
    { name: 'old_i4_opp3', newI4: false, oppThresh: 3 },
    { name: 'new_i4_opp2', newI4: true, oppThresh: 2 },
    { name: 'new_i4_opp3', newI4: true, oppThresh: 3 },
  ];
  var strategyNames = ['single_anchor', 'first_to_grad', 'only_one_grad', 'stronger_grad'];

  function mkBucket() { return { n: 0, wins: 0 }; }
  function ph(b) { return { n: b.n, wins: b.wins, pct: b.n > 0 ? Math.round(b.wins / b.n * 1000) / 10 : null }; }

  // Accumulators: results[config][strategy] = { po_fired, po_correct, no_po, by_rank, by_cp, both_grad, only_one_grad }
  var acc = {};
  for (var cfg of configs) {
    acc[cfg.name] = {};
    for (var strat of strategyNames) {
      acc[cfg.name][strat] = {
        po: mkBucket(),
        no_po: mkBucket(),
        by_rank: { A: mkBucket(), B: mkBucket() },
        by_cp: {},
        both_graduated: 0,
        only_one_graduated: 0,
        neither_graduated: 0,
      };
      for (var cp of checkpoints) acc[cfg.name][strat].by_cp[cp] = mkBucket();
    }
  }

  // Track marginal changes between configs
  var marginal = {
    opp2_to_opp3_old_i4: { gained: mkBucket(), lost: mkBucket(), changed: 0 },
    opp2_to_opp3_new_i4: { gained: mkBucket(), lost: mkBucket(), changed: 0 },
    old_to_new_i4_opp2: { gained: mkBucket(), lost: mkBucket(), changed: 0 },
    old_to_new_i4_opp3: { gained: mkBucket(), lost: mkBucket(), changed: 0 },
  };

  var totalGames = 0;

  // Collect opponent context at first graduation (for target config new_i4_opp3)
  var firstGradContexts = [];

  // Post-signal trailing analysis: does the PO team ever trail after the signal?
  var trailingData = {
    at_graduation: [], // { signalTeam, signalCp, isHome, won, rank, snapshots_after[] }
    at_tracking: [],   // same shape but signal = BWC fire (tracking)
  };

  for (var gid in gameMap) {
    var snaps = gameMap[gid];
    if (snaps.length < 3) continue;
    totalGames++;

    // Walk game under each config
    var walks = {};
    for (var cfg of configs) {
      walks[cfg.name] = walkGame(snaps, cfg.newI4, cfg.oppThresh);
    }
    var winner = walks[configs[0].name].winner;

    // Apply each strategy to each config's walk
    var decisions = {};
    for (var cfg of configs) {
      decisions[cfg.name] = {};
      var gw = walks[cfg.name];
      var hGrad = !!gw.gradCp[gw.homeA], aGrad = !!gw.gradCp[gw.awayA];

      for (var strat of strategyNames) {
        var d = applyStrategy(gw, strat);
        decisions[cfg.name][strat] = d;
        var a = acc[cfg.name][strat];

        // Count graduation patterns
        if (hGrad && aGrad) a.both_graduated++;
        else if (hGrad || aGrad) a.only_one_graduated++;
        else a.neither_graduated++;

        if (d.poTeam) {
          var correct = d.poTeam === winner;
          a.po.n++; if (correct) a.po.wins++;
          if (d.poRank && a.by_rank[d.poRank]) { a.by_rank[d.poRank].n++; if (correct) a.by_rank[d.poRank].wins++; }
          if (d.poCp && a.by_cp[d.poCp]) { a.by_cp[d.poCp].n++; if (correct) a.by_cp[d.poCp].wins++; }
        } else {
          a.no_po.n++;
          // Track: did the winner actually graduate? (missed opportunity)
          if (gw.gradCp[winner]) a.no_po.wins++; // wins = "missed opportunities" here
        }
      }
    }

    // ── Marginal analysis: compare configs pairwise on first_to_grad strategy ──
    function compareMarginal(mKey, cfgA, cfgB) {
      var dA = decisions[cfgA]['first_to_grad'];
      var dB = decisions[cfgB]['first_to_grad'];
      if (dA.poTeam !== dB.poTeam || (!!dA.poTeam !== !!dB.poTeam)) {
        marginal[mKey].changed++;
        // Gained: B has PO but A doesn't
        if (!dA.poTeam && dB.poTeam) {
          marginal[mKey].gained.n++;
          if (dB.poTeam === winner) marginal[mKey].gained.wins++;
        }
        // Lost: A has PO but B doesn't
        if (dA.poTeam && !dB.poTeam) {
          marginal[mKey].lost.n++;
          if (dA.poTeam === winner) marginal[mKey].lost.wins++;
        }
      }
    }
    compareMarginal('opp2_to_opp3_old_i4', 'old_i4_opp2', 'old_i4_opp3');
    compareMarginal('opp2_to_opp3_new_i4', 'new_i4_opp2', 'new_i4_opp3');
    compareMarginal('old_to_new_i4_opp2', 'old_i4_opp2', 'new_i4_opp2');
    compareMarginal('old_to_new_i4_opp3', 'old_i4_opp3', 'new_i4_opp3');

    // Collect firstGradContext from target config for opponent-state analysis
    var targetWalk = walks['new_i4_opp3'];
    if (targetWalk.firstGradContext) {
      firstGradContexts.push(targetWalk.firstGradContext);
    }

    // ── Post-signal trailing analysis ──
    // Build checkpoint margin map from raw snapshots
    var cpMargins = {};
    for (var s of snaps) cpMargins[s.checkpoint] = s.margin; // home - away

    // PO at graduation (first_to_grad on new_i4_opp3)
    var gradDecision = decisions['new_i4_opp3']['first_to_grad'];
    if (gradDecision.poTeam && gradDecision.poCp) {
      var gIsHome = gradDecision.poTeam === targetWalk.homeA;
      var gSignalCpIdx = cpIdx[gradDecision.poCp];
      var gAfter = [];
      for (var ai = gSignalCpIdx + 1; ai < checkpoints.length; ai++) {
        var m = cpMargins[checkpoints[ai]];
        if (m !== undefined) {
          var teamMargin = gIsHome ? m : -m;
          gAfter.push({ cp: checkpoints[ai], teamMargin: teamMargin });
        }
      }
      trailingData.at_graduation.push({
        signalTeam: gradDecision.poTeam, signalCp: gradDecision.poCp,
        rank: gradDecision.poRank, isHome: gIsHome,
        won: gradDecision.poTeam === winner, after: gAfter,
      });
    }

    // PO at tracking (first BWC fire on new_i4_opp3)
    var tw = targetWalk;
    if (tw.firstBWCTeam && tw.bwcCp[tw.firstBWCTeam]) {
      var tIsHome = tw.firstBWCTeam === tw.homeA;
      var tSignalCpIdx = cpIdx[tw.bwcCp[tw.firstBWCTeam]];
      var tAfter = [];
      for (var ai2 = tSignalCpIdx + 1; ai2 < checkpoints.length; ai2++) {
        var m2 = cpMargins[checkpoints[ai2]];
        if (m2 !== undefined) {
          var teamMargin2 = tIsHome ? m2 : -m2;
          tAfter.push({ cp: checkpoints[ai2], teamMargin: teamMargin2 });
        }
      }
      trailingData.at_tracking.push({
        signalTeam: tw.firstBWCTeam, signalCp: tw.bwcCp[tw.firstBWCTeam],
        rank: tw.gradRank[tw.firstBWCTeam] || 'C', isHome: tIsHome,
        won: tw.firstBWCTeam === winner, after: tAfter,
      });
    }
  }

  // ── Post-signal trailing analysis ──
  function analyzeTrailing(entries) {
    var result = {
      total: entries.length,
      correct: 0,
      ever_trailed: 0,
      trailed_and_won: mkBucket(),     // trailed then won = successful BUY window
      never_trailed_and_won: mkBucket(), // won without trailing = no entry window
      by_deepest_deficit: {
        'never_trailed': mkBucket(),
        'trail_1_4': mkBucket(),
        'trail_5_9': mkBucket(),
        'trail_10_plus': mkBucket(),
      },
      by_signal_cp: {},
      by_rank: { A: { total: 0, trailed: 0, won: 0 }, B: { total: 0, trailed: 0, won: 0 }, C: { total: 0, trailed: 0, won: 0 } },
      trailing_checkpoint_count: { '0': mkBucket(), '1': mkBucket(), '2_3': mkBucket(), '4_plus': mkBucket() },
    };
    for (var cp of checkpoints) result.by_signal_cp[cp] = { total: 0, trailed: 0, won: 0 };

    for (var e of entries) {
      if (e.won) result.correct++;
      var deepest = 0;
      var trailingCps = 0;
      for (var a of e.after) {
        if (a.teamMargin < 0) {
          trailingCps++;
          if (-a.teamMargin > deepest) deepest = -a.teamMargin;
        }
      }
      var trailed = deepest > 0;
      if (trailed) result.ever_trailed++;

      // Trailed and won = BUY window that worked
      if (trailed) { result.trailed_and_won.n++; if (e.won) result.trailed_and_won.wins++; }
      else { result.never_trailed_and_won.n++; if (e.won) result.never_trailed_and_won.wins++; }

      // By deepest deficit
      var defKey = !trailed ? 'never_trailed' : deepest <= 4 ? 'trail_1_4' : deepest <= 9 ? 'trail_5_9' : 'trail_10_plus';
      result.by_deepest_deficit[defKey].n++; if (e.won) result.by_deepest_deficit[defKey].wins++;

      // By signal checkpoint
      if (result.by_signal_cp[e.signalCp]) {
        result.by_signal_cp[e.signalCp].total++;
        if (trailed) result.by_signal_cp[e.signalCp].trailed++;
        if (e.won) result.by_signal_cp[e.signalCp].won++;
      }

      // By rank
      var rk = e.rank || 'C';
      if (!result.by_rank[rk]) result.by_rank[rk] = { total: 0, trailed: 0, won: 0 };
      result.by_rank[rk].total++;
      if (trailed) result.by_rank[rk].trailed++;
      if (e.won) result.by_rank[rk].won++;

      // By trailing checkpoint count
      var tcKey = trailingCps === 0 ? '0' : trailingCps === 1 ? '1' : trailingCps <= 3 ? '2_3' : '4_plus';
      result.trailing_checkpoint_count[tcKey].n++; if (e.won) result.trailing_checkpoint_count[tcKey].wins++;
    }
    return result;
  }

  var trailGrad = analyzeTrailing(trailingData.at_graduation);
  var trailTrack = analyzeTrailing(trailingData.at_tracking);

  // ── Opponent context analysis at first graduation ──
  // Question: can we predict at first graduation whether the opponent will also graduate?
  var fgAnalysis = {
    total: firstGradContexts.length,
    first_grad_won: mkBucket(),
    opp_eventually_graduated: mkBucket(),
    // Bucket by opponent signals at first graduation moment
    by_opp_had_bwc: { yes: mkBucket(), no: mkBucket() },
    by_opp_peak_holds: { '0': mkBucket(), '1': mkBucket(), '2': mkBucket(), '3+': mkBucket() },
    by_opp_indicators: { '0': mkBucket(), '1': mkBucket(), '2+': mkBucket() },
    by_opp_recency: { recent_1: mkBucket(), recent_2: mkBucket(), stale_3plus: mkBucket(), never: mkBucket() },
    by_opp_last_floor: { 'none': mkBucket(), 'below_60': mkBucket(), '60_69': mkBucket(), '70_79': mkBucket(), '80_plus': mkBucket() },
    // Combined danger signals
    by_danger_level: { low: mkBucket(), medium: mkBucket(), high: mkBucket() },
    // Second graduation outcomes (when opponent DID graduate)
    second_grad_outcomes: {
      total: 0, second_team_won: 0,
      by_cp_gap: { '0': mkBucket(), '1': mkBucket(), '2-3': mkBucket(), '4+': mkBucket() },
      by_opp_final_rank: { A: mkBucket(), B: mkBucket() },
    },
    // "Wait" strategy sim: if we delayed PO when danger=high, what happens?
    wait_strategy: {
      would_delay: 0, delay_correct: 0, // delayed = opp DID graduate and won
      would_fire: 0, fire_correct: 0,    // fired = opp didn't graduate, first team won
    },
  };

  for (var fg of firstGradContexts) {
    var firstWon = fg.firstTeamWon;
    fgAnalysis.first_grad_won.n++; if (firstWon) fgAnalysis.first_grad_won.wins++;
    fgAnalysis.opp_eventually_graduated.n++; if (fg.oppEventuallyGrad) fgAnalysis.opp_eventually_graduated.wins++;

    // By opponent had BWC
    var bwcKey = fg.oppHadBWC ? 'yes' : 'no';
    fgAnalysis.by_opp_had_bwc[bwcKey].n++; if (firstWon) fgAnalysis.by_opp_had_bwc[bwcKey].wins++;

    // By opponent peak holds
    var phKey = fg.oppPeakHolds >= 3 ? '3+' : String(fg.oppPeakHolds);
    fgAnalysis.by_opp_peak_holds[phKey].n++; if (firstWon) fgAnalysis.by_opp_peak_holds[phKey].wins++;

    // By opponent indicator count at first graduation
    var indKey = fg.oppIndicators >= 2 ? '2+' : String(fg.oppIndicators);
    fgAnalysis.by_opp_indicators[indKey].n++; if (firstWon) fgAnalysis.by_opp_indicators[indKey].wins++;

    // By opponent recency (how recently they had control)
    var recKey = fg.oppRecency === null ? 'never'
      : fg.oppRecency <= 1 ? 'recent_1'
      : fg.oppRecency <= 2 ? 'recent_2' : 'stale_3plus';
    fgAnalysis.by_opp_recency[recKey].n++; if (firstWon) fgAnalysis.by_opp_recency[recKey].wins++;

    // By opponent last floor
    var lfKey = 'none';
    if (fg.oppLastFloor !== null) {
      if (fg.oppLastFloor >= 0.80) lfKey = '80_plus';
      else if (fg.oppLastFloor >= 0.70) lfKey = '70_79';
      else if (fg.oppLastFloor >= 0.60) lfKey = '60_69';
      else lfKey = 'below_60';
    }
    fgAnalysis.by_opp_last_floor[lfKey].n++; if (firstWon) fgAnalysis.by_opp_last_floor[lfKey].wins++;

    // Combined danger level
    var dangerScore = 0;
    if (fg.oppHadBWC) dangerScore += 2;
    if (fg.oppPeakHolds >= 2) dangerScore += 1;
    if (fg.oppIndicators >= 2) dangerScore += 2;
    if (fg.oppRecency !== null && fg.oppRecency <= 1) dangerScore += 1;
    if (fg.oppLastFloor !== null && fg.oppLastFloor >= 0.65) dangerScore += 1;
    var dangerKey = dangerScore >= 4 ? 'high' : dangerScore >= 2 ? 'medium' : 'low';
    fgAnalysis.by_danger_level[dangerKey].n++; if (firstWon) fgAnalysis.by_danger_level[dangerKey].wins++;

    // Second graduation outcomes
    if (fg.oppEventuallyGrad) {
      var sg = fgAnalysis.second_grad_outcomes;
      sg.total++;
      if (!firstWon) sg.second_team_won++;
      var gapKey = fg.cpGap === 0 ? '0' : fg.cpGap === 1 ? '1' : fg.cpGap <= 3 ? '2-3' : '4+';
      sg.by_cp_gap[gapKey].n++; if (!firstWon) sg.by_cp_gap[gapKey].wins++; // wins = second team won
      if (fg.oppFinalRank === 'A' || fg.oppFinalRank === 'B') {
        sg.by_opp_final_rank[fg.oppFinalRank].n++;
        if (!firstWon) sg.by_opp_final_rank[fg.oppFinalRank].wins++;
      }
    }

    // Wait strategy: if danger=high, delay and see if opp graduates → bet second team
    if (dangerKey === 'high') {
      fgAnalysis.wait_strategy.would_delay++;
      if (fg.oppEventuallyGrad && !firstWon) fgAnalysis.wait_strategy.delay_correct++;
    } else {
      fgAnalysis.wait_strategy.would_fire++;
      if (firstWon) fgAnalysis.wait_strategy.fire_correct++;
    }
  }

  // ── Format output ──
  var output = {
    meta: {
      total_games: totalGames,
      dataset: closeOnly ? 'close (final margin ≤ 8)' : 'full',
      configs: configs.map(function(c) { return c.name; }),
      strategies: strategyNames,
    },
    results: {},
    marginal_analysis: {},
  };

  for (var cfg of configs) {
    output.results[cfg.name] = {};
    for (var strat of strategyNames) {
      var a = acc[cfg.name][strat];
      var cpFormatted = {};
      for (var cp of checkpoints) {
        if (a.by_cp[cp].n > 0) cpFormatted[cp] = ph(a.by_cp[cp]);
      }
      output.results[cfg.name][strat] = {
        po_fired: ph(a.po),
        no_po: { n: a.no_po.n, missed_opportunities: a.no_po.wins },
        by_rank: { A: ph(a.by_rank.A), B: ph(a.by_rank.B) },
        by_checkpoint: cpFormatted,
        graduation_patterns: {
          both_graduated: a.both_graduated,
          only_one_graduated: a.only_one_graduated,
          neither_graduated: a.neither_graduated,
        },
      };
    }
  }

  // Format marginal
  for (var mKey in marginal) {
    var m = marginal[mKey];
    output.marginal_analysis[mKey] = {
      total_changed: m.changed,
      gained_po: ph(m.gained),
      lost_po: ph(m.lost),
    };
  }

  // ── Head-to-head comparison table: best config × strategy combo ──
  var headToHead = [];
  for (var cfg of configs) {
    for (var strat of strategyNames) {
      var a = acc[cfg.name][strat];
      headToHead.push({
        config: cfg.name,
        strategy: strat,
        po_n: a.po.n,
        po_pct: a.po.n > 0 ? Math.round(a.po.wins / a.po.n * 1000) / 10 : null,
        silence_n: a.no_po.n,
        coverage: totalGames > 0 ? Math.round(a.po.n / totalGames * 1000) / 10 : null,
      });
    }
  }
  headToHead.sort(function(a, b) { return (b.po_pct || 0) - (a.po_pct || 0); });
  output.head_to_head = headToHead;

  // Add opponent-at-first-grad analysis
  function fmtTrailing(t) {
    var byCpFormatted = {};
    for (var cp of checkpoints) {
      if (t.by_signal_cp[cp] && t.by_signal_cp[cp].total > 0) {
        var sc = t.by_signal_cp[cp];
        byCpFormatted[cp] = {
          n: sc.total, trailed: sc.trailed,
          trail_pct: Math.round(sc.trailed / sc.total * 1000) / 10,
          won: sc.won, win_pct: Math.round(sc.won / sc.total * 1000) / 10,
        };
      }
    }
    var byRankFormatted = {};
    for (var rk in t.by_rank) {
      if (t.by_rank[rk].total > 0) {
        var r = t.by_rank[rk];
        byRankFormatted[rk] = {
          n: r.total, trailed: r.trailed,
          trail_pct: Math.round(r.trailed / r.total * 1000) / 10,
          won: r.won, win_pct: Math.round(r.won / r.total * 1000) / 10,
        };
      }
    }
    return {
      total_signals: t.total,
      accuracy: t.total > 0 ? Math.round(t.correct / t.total * 1000) / 10 : null,
      ever_trailed_pct: t.total > 0 ? Math.round(t.ever_trailed / t.total * 1000) / 10 : null,
      entry_window: {
        trailed_then_won: ph(t.trailed_and_won),
        never_trailed_won: ph(t.never_trailed_and_won),
      },
      by_deepest_deficit: {
        never_trailed: ph(t.by_deepest_deficit.never_trailed),
        trail_1_4: ph(t.by_deepest_deficit.trail_1_4),
        trail_5_9: ph(t.by_deepest_deficit.trail_5_9),
        trail_10_plus: ph(t.by_deepest_deficit.trail_10_plus),
      },
      by_signal_checkpoint: byCpFormatted,
      by_rank: byRankFormatted,
      trailing_checkpoint_count: {
        '0': ph(t.trailing_checkpoint_count['0']),
        '1': ph(t.trailing_checkpoint_count['1']),
        '2_3': ph(t.trailing_checkpoint_count['2_3']),
        '4_plus': ph(t.trailing_checkpoint_count['4_plus']),
      },
    };
  }

  output.post_signal_trailing = {
    config_used: 'new_i4_opp3',
    po_at_graduation: fmtTrailing(trailGrad),
    po_at_tracking: fmtTrailing(trailTrack),
  };

  // Add opponent-at-first-grad analysis
  output.opponent_at_first_grad = {
    config_used: 'new_i4_opp3',
    total_games_with_graduation: fgAnalysis.total,
    first_grad_win_rate: ph(fgAnalysis.first_grad_won),
    opp_graduation_rate: ph(fgAnalysis.opp_eventually_graduated),
    by_opp_had_bwc: { yes: ph(fgAnalysis.by_opp_had_bwc.yes), no: ph(fgAnalysis.by_opp_had_bwc.no) },
    by_opp_peak_holds: {
      '0': ph(fgAnalysis.by_opp_peak_holds['0']),
      '1': ph(fgAnalysis.by_opp_peak_holds['1']),
      '2': ph(fgAnalysis.by_opp_peak_holds['2']),
      '3+': ph(fgAnalysis.by_opp_peak_holds['3+']),
    },
    by_opp_indicators: {
      '0': ph(fgAnalysis.by_opp_indicators['0']),
      '1': ph(fgAnalysis.by_opp_indicators['1']),
      '2+': ph(fgAnalysis.by_opp_indicators['2+']),
    },
    by_opp_recency: {
      recent_1: ph(fgAnalysis.by_opp_recency.recent_1),
      recent_2: ph(fgAnalysis.by_opp_recency.recent_2),
      stale_3plus: ph(fgAnalysis.by_opp_recency.stale_3plus),
      never: ph(fgAnalysis.by_opp_recency.never),
    },
    by_opp_last_floor: {
      none: ph(fgAnalysis.by_opp_last_floor['none']),
      below_60: ph(fgAnalysis.by_opp_last_floor['below_60']),
      '60_69': ph(fgAnalysis.by_opp_last_floor['60_69']),
      '70_79': ph(fgAnalysis.by_opp_last_floor['70_79']),
      '80_plus': ph(fgAnalysis.by_opp_last_floor['80_plus']),
    },
    by_danger_level: {
      low: ph(fgAnalysis.by_danger_level.low),
      medium: ph(fgAnalysis.by_danger_level.medium),
      high: ph(fgAnalysis.by_danger_level.high),
    },
    second_graduation_detail: {
      total: fgAnalysis.second_grad_outcomes.total,
      second_team_won_pct: fgAnalysis.second_grad_outcomes.total > 0
        ? Math.round(fgAnalysis.second_grad_outcomes.second_team_won / fgAnalysis.second_grad_outcomes.total * 1000) / 10 : null,
      by_checkpoint_gap: {
        same_cp: ph(fgAnalysis.second_grad_outcomes.by_cp_gap['0']),
        '1_cp_later': ph(fgAnalysis.second_grad_outcomes.by_cp_gap['1']),
        '2_3_cp_later': ph(fgAnalysis.second_grad_outcomes.by_cp_gap['2-3']),
        '4_plus_cp_later': ph(fgAnalysis.second_grad_outcomes.by_cp_gap['4+']),
      },
      by_opp_rank: {
        A: ph(fgAnalysis.second_grad_outcomes.by_opp_final_rank.A),
        B: ph(fgAnalysis.second_grad_outcomes.by_opp_final_rank.B),
      },
    },
    wait_strategy_sim: {
      description: 'If danger=high → delay PO, wait for second grad. Otherwise fire immediately.',
      would_delay: fgAnalysis.wait_strategy.would_delay,
      delay_correct_pct: fgAnalysis.wait_strategy.would_delay > 0
        ? Math.round(fgAnalysis.wait_strategy.delay_correct / fgAnalysis.wait_strategy.would_delay * 1000) / 10 : null,
      would_fire: fgAnalysis.wait_strategy.would_fire,
      fire_correct_pct: fgAnalysis.wait_strategy.would_fire > 0
        ? Math.round(fgAnalysis.wait_strategy.fire_correct / fgAnalysis.wait_strategy.would_fire * 1000) / 10 : null,
    },
  };

  return output;
}

// ── REPORT: BUY JOURNEY — Trailing team structural control lifecycle ────────
// ?phase=report_buy_journey          — full dataset
// ?phase=report_buy_journey&close=1  — competitive games only
//
// Mirrors reportTierJourney but from the TRAILING team's perspective.
// BUY-eligible = ctrl team trailing (ctrlMargin < 0), floor >= 0.50.
// Answers: when trailing teams have structural control, what predicts comebacks?

async function reportBuyJourney(sql, url) {
  var closeOnly = url?.searchParams?.get('close') === '1';

  var rows = await sql`
    SELECT game_id, checkpoint, margin_at_snapshot AS margin,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl,
           indicators->>'homeAlias' AS home_alias,
           indicators->>'awayAlias' AS away_alias,
           (indicators->>'I1')::text AS i1raw, (indicators->>'I2')::text AS i2raw,
           (indicators->>'I3')::text AS i3raw, (indicators->>'I4')::text AS i4raw,
           (indicators->>'I5')::text AS i5raw,
           (conviction->>'tier') AS conv_tier,
           (conviction->>'count')::int AS ind_count,
           pbp_derived,
           ctrl_team_won, final_margin
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  var checkpoints = CP_LABELS;

  // Group by game
  var games = {};
  for (var r of rows) {
    if (!games[r.game_id]) games[r.game_id] = [];
    games[r.game_id].push(r);
  }

  // Competitive game filter
  var Q3_CPS = new Set(['Q3_9','Q3_6','Q3_3','Q3_END']);
  var Q4_CPS = new Set(['Q4_9','Q4_6','Q4_3','Q4_END']);
  if (closeOnly) {
    for (var gid of Object.keys(games)) {
      var snaps = games[gid];
      var competitive = snaps.some(function(s) {
        var absM = Math.abs(s.margin);
        if (Q3_CPS.has(s.checkpoint) && absM <= 5) return true;
        if (Q4_CPS.has(s.checkpoint) && absM <= 7) return true;
        return false;
      });
      if (!competitive) delete games[gid];
    }
  }

  // ── Helpers ──
  function getCtrlMargin(r) {
    return (r.ctrl === r.home_alias) ? r.margin : -r.margin;
  }

  function getCtrlIndCount(r) {
    var ctrlHome = r.ctrl === r.home_alias;
    var scores = [parseFloat(r.i1raw), parseFloat(r.i2raw), parseFloat(r.i3raw),
                  parseFloat(r.i4raw), parseFloat(r.i5raw)];
    var count = 0;
    for (var s of scores) {
      if (isNaN(s)) continue;
      if (ctrlHome ? (s === 1) : (s === 0)) count++;
    }
    return count;
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

  function ctrlIndState(r, key) {
    var raw = parseFloat(r[key.toLowerCase()]);
    if (isNaN(raw)) return null;
    var ctrlHome = r.ctrl === r.home_alias;
    var v = ctrlHome ? raw : 1 - raw;
    return v === 1 ? 'won' : v === 0 ? 'lost' : 'even';
  }

  function deficitBucket(deficit) {
    if (deficit <= 2) return 'trail_1-2';
    if (deficit <= 4) return 'trail_3-4';
    if (deficit <= 7) return 'trail_5-7';
    if (deficit <= 10) return 'trail_8-10';
    return 'trail_11+';
  }

  function floorBucket(f) {
    if (f >= 0.90) return '0.90+';
    if (f >= 0.80) return '0.80-0.89';
    if (f >= 0.70) return '0.70-0.79';
    if (f >= 0.60) return '0.60-0.69';
    return '0.50-0.59';
  }

  var pct = function(obj) {
    var out = {};
    for (var k in obj) {
      var v = obj[k];
      if (v && typeof v === 'object' && 'n' in v && 'wins' in v) {
        out[k] = { n: v.n, wins: v.wins, pct: v.n > 0 ? Math.round(v.wins / v.n * 1000) / 10 : null };
      } else {
        out[k] = v;
      }
    }
    return out;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION ACCUMULATORS
  // ══════════════════════════════════════════════════════════════════════════

  var totalGames = 0;
  var totalBuyGames = 0;

  // S1: First BUY-eligible fire by checkpoint
  var s1_firstFireByCp = {};
  for (var cp of checkpoints) s1_firstFireByCp[cp] = { n: 0, wins: 0 };

  // S2: Floor at first fire
  var s2_floorAtFire = {
    '0.50-0.59': {n:0,wins:0}, '0.60-0.69': {n:0,wins:0}, '0.70-0.79': {n:0,wins:0},
    '0.80-0.89': {n:0,wins:0}, '0.90+': {n:0,wins:0},
  };

  // S3: Deficit at first fire
  var s3_deficitAtFire = {
    'trail_1-2': {n:0,wins:0}, 'trail_3-4': {n:0,wins:0}, 'trail_5-7': {n:0,wins:0},
    'trail_8-10': {n:0,wins:0}, 'trail_11+': {n:0,wins:0},
  };

  // S4: Peak floor while trailing
  var s4_peakFloor = {
    '0.50-0.59': {n:0,wins:0}, '0.60-0.69': {n:0,wins:0}, '0.70-0.79': {n:0,wins:0},
    '0.80-0.89': {n:0,wins:0}, '0.90+': {n:0,wins:0},
  };

  // S5: Floor progression — mean floor at each checkpoint for winners vs losers
  var s5_floorProg = { winners: {}, losers: {} };
  for (var cp of checkpoints) { s5_floorProg.winners[cp] = []; s5_floorProg.losers[cp] = []; }

  // S6: Deficit progression — mean ctrl-relative margin at each cp
  var s6_deficitProg = { winners: {}, losers: {} };
  for (var cp of checkpoints) { s6_deficitProg.winners[cp] = []; s6_deficitProg.losers[cp] = []; }

  // S7: Max consecutive BUY-eligible holds
  var s7_consHolds = {
    '1 cp': {n:0,wins:0}, '2-3 cp': {n:0,wins:0}, '4-5 cp': {n:0,wins:0},
    '6-7 cp': {n:0,wins:0}, '8+ cp': {n:0,wins:0},
  };

  // S8: Floor velocity while trailing
  var s8_velocity = {
    'surging (>+0.08)': {n:0,wins:0}, 'rising (+0.03 to +0.08)': {n:0,wins:0},
    'stable (-0.03 to +0.03)': {n:0,wins:0}, 'declining (-0.03 to -0.08)': {n:0,wins:0},
    'collapsing (<-0.08)': {n:0,wins:0},
  };

  // S9: Floor x deficit grid (checkpoint-level)
  var floorBuckets = ['0.50-0.59','0.60-0.69','0.70-0.79','0.80-0.89','0.90+'];
  var defBuckets = ['trail_1-2','trail_3-4','trail_5-7','trail_8-10','trail_11+'];
  var s9_grid = {};
  for (var fb of floorBuckets) { s9_grid[fb] = {}; for (var db of defBuckets) s9_grid[fb][db] = {n:0,wins:0}; }

  // S10: Indicator count while trailing (checkpoint-level)
  var s10_indCount = { '0': {n:0,wins:0}, '1': {n:0,wins:0}, '2': {n:0,wins:0},
    '3': {n:0,wins:0}, '4': {n:0,wins:0}, '5': {n:0,wins:0} };

  // S11: Conviction tier while trailing
  var s11_conviction = {};

  // S12: Individual indicator impact
  var s12_indImpact = {};
  for (var ind of ['I1','I2','I3','I4','I5']) {
    s12_indImpact[ind] = { won: {n:0,wins:0}, even: {n:0,wins:0}, lost: {n:0,wins:0} };
  }

  // S13: Indicator pairs
  var s13_pairs = {};

  // S14: Opponent indicator count
  var s14_oppCount = { '0': {n:0,wins:0}, '1': {n:0,wins:0}, '2+': {n:0,wins:0} };

  // S15: Win rate by checkpoint
  var s15_byCp = {};
  for (var cp of checkpoints) s15_byCp[cp] = { n: 0, wins: 0 };

  // S16: Comeback path
  var s16_comeback = {
    took_lead: { n: 0, wins: 0 },
    never_led: { n: 0, wins: 0 },
    took_lead_by_q: {},
  };
  for (var cp of checkpoints) s16_comeback.took_lead_by_q[cp] = { n: 0, wins: 0 };

  // S17: Winner backtrace
  var s17_backtrace = {
    total_winners: 0,
    avg_floor_at_first_fire: [],
    avg_deficit_at_first_fire: [],
    avg_peak_floor: [],
    avg_ind_count_at_first_fire: [],
    first_fire_cp_dist: {},
    took_lead: 0,
    never_led_but_won: 0,
    comeback_q_dist: {},
  };
  for (var cp of checkpoints) {
    s17_backtrace.first_fire_cp_dist[cp] = 0;
    s17_backtrace.comeback_q_dist[cp] = 0;
  }

  // S18: Floor threshold sweep (game-level: peak floor while trailing)
  var s18_floorSweep = {};
  for (var t = 0.50; t <= 0.90; t += 0.05) {
    s18_floorSweep[t.toFixed(2)] = { n: 0, wins: 0 };
  }

  // S19: Combined gates sweep
  var s19_combined = {};
  var floorGates = [0.55, 0.60, 0.65, 0.70, 0.75, 0.80];
  var indGates = [1, 2, 3, 4];
  var defGates = [4, 7, 10, 15];
  for (var fg of floorGates) {
    for (var ig of indGates) {
      for (var dg of defGates) {
        s19_combined['f' + fg.toFixed(2) + '_i' + ig + '_d' + dg] = { n:0, wins:0 };
      }
    }
  }

  // S20: Total checkpoints spent as trailing ctrl
  var s20_trailDuration = {
    '1 cp': {n:0,wins:0}, '2-3 cp': {n:0,wins:0}, '4-5 cp': {n:0,wins:0},
    '6-8 cp': {n:0,wins:0}, '9+ cp': {n:0,wins:0},
  };

  // ══════════════════════════════════════════════════════════════════════════
  // GAME WALK
  // ══════════════════════════════════════════════════════════════════════════

  for (var [gid, snaps] of Object.entries(games)) {
    var cpMap = {};
    for (var s of snaps) cpMap[s.checkpoint] = s;
    if (!cpMap['Q1_END']) continue;
    totalGames++;

    var homeA = snaps[0].home_alias;
    var awayA = snaps[0].away_alias;

    // ── Identify BUY-eligible checkpoints ──
    var buyCheckpoints = [];
    var firstBuyTeam = null;
    var firstBuyCp = null;
    var firstBuyCpIdx = null;
    var firstBuyFloor = null;
    var firstBuyDeficit = null;
    var firstBuyIndCount = null;
    var peakFloorWhileTrailing = 0;
    var maxConsecutiveHolds = 0;
    var currentRunLength = 0;
    var prevBuyTeam = null;
    var prevBuyFloor = null;
    var totalBuyCheckpoints = 0;
    var tookLead = false;
    var tookLeadCp = null;
    var won = null;

    for (var ci = 0; ci < checkpoints.length; ci++) {
      var cpLabel = checkpoints[ci];
      var snap = cpMap[cpLabel];
      if (!snap || !snap.ctrl) continue;

      var ctrlMargin = getCtrlMargin(snap);
      var isBuyEligible = ctrlMargin < 0 && snap.floor >= 0.50;

      if (isBuyEligible) {
        var deficit = Math.abs(ctrlMargin);
        var indCount = getCtrlIndCount(snap);
        var oppCount = getOppCount(snap);
        won = snap.ctrl_team_won;

        buyCheckpoints.push({
          cpLabel: cpLabel, cpIdx: ci, snap: snap,
          ctrlMargin: ctrlMargin, floor: snap.floor, deficit: deficit,
          indCount: indCount, oppCount: oppCount,
        });

        // First fire tracking
        if (!firstBuyTeam) {
          firstBuyTeam = snap.ctrl;
          firstBuyCp = cpLabel;
          firstBuyCpIdx = ci;
          firstBuyFloor = snap.floor;
          firstBuyDeficit = deficit;
          firstBuyIndCount = indCount;
        }

        // Peak floor
        if (snap.floor > peakFloorWhileTrailing) peakFloorWhileTrailing = snap.floor;

        // Consecutive holds
        if (snap.ctrl === prevBuyTeam) {
          currentRunLength++;
        } else {
          currentRunLength = 1;
        }
        if (currentRunLength > maxConsecutiveHolds) maxConsecutiveHolds = currentRunLength;
        prevBuyTeam = snap.ctrl;

        // S8: Floor velocity
        if (prevBuyFloor !== null && snap.ctrl === firstBuyTeam) {
          var delta = snap.floor - prevBuyFloor;
          var velKey;
          if (delta > 0.08) velKey = 'surging (>+0.08)';
          else if (delta > 0.03) velKey = 'rising (+0.03 to +0.08)';
          else if (delta > -0.03) velKey = 'stable (-0.03 to +0.03)';
          else if (delta > -0.08) velKey = 'declining (-0.03 to -0.08)';
          else velKey = 'collapsing (<-0.08)';
          s8_velocity[velKey].n++;
          if (won) s8_velocity[velKey].wins++;
        }
        if (snap.ctrl === firstBuyTeam) prevBuyFloor = snap.floor;

        totalBuyCheckpoints++;

        // ── Checkpoint-level accumulators ──

        // S9: Floor x deficit grid
        var fb = floorBucket(snap.floor);
        var db = deficitBucket(deficit);
        s9_grid[fb][db].n++;
        if (won) s9_grid[fb][db].wins++;

        // S10: Indicator count
        s10_indCount[String(Math.min(indCount, 5))].n++;
        if (won) s10_indCount[String(Math.min(indCount, 5))].wins++;

        // S11: Conviction
        var convKey = snap.conv_tier || 'UNKNOWN';
        if (!s11_conviction[convKey]) s11_conviction[convKey] = {n:0,wins:0};
        s11_conviction[convKey].n++;
        if (won) s11_conviction[convKey].wins++;

        // S12: Individual indicators
        for (var ind of ['I1','I2','I3','I4','I5']) {
          var state = ctrlIndState(snap, ind + 'raw');
          if (state) { s12_indImpact[ind][state].n++; if (won) s12_indImpact[ind][state].wins++; }
        }

        // S13: Indicator pairs
        var indStates = {};
        for (var ind of ['I1','I2','I3','I4','I5']) indStates[ind] = ctrlIndState(snap, ind + 'raw');
        var indArr = ['I1','I2','I3','I4','I5'];
        for (var a = 0; a < indArr.length; a++) {
          for (var b = a + 1; b < indArr.length; b++) {
            if (indStates[indArr[a]] === 'won' && indStates[indArr[b]] === 'won') {
              var pairKey = indArr[a] + '+' + indArr[b];
              if (!s13_pairs[pairKey]) s13_pairs[pairKey] = {n:0,wins:0};
              s13_pairs[pairKey].n++;
              if (won) s13_pairs[pairKey].wins++;
            }
          }
        }
        // Golden stack
        if (indCount >= 3 && oppCount === 0 && deficit <= 4) {
          if (!s13_pairs['golden_3i_0opp_t14']) s13_pairs['golden_3i_0opp_t14'] = {n:0,wins:0};
          s13_pairs['golden_3i_0opp_t14'].n++;
          if (won) s13_pairs['golden_3i_0opp_t14'].wins++;
        }

        // S14: Opponent indicator count
        var oppKey = oppCount >= 2 ? '2+' : String(oppCount);
        s14_oppCount[oppKey].n++;
        if (won) s14_oppCount[oppKey].wins++;

        // S15: Win rate by checkpoint
        s15_byCp[cpLabel].n++;
        if (won) s15_byCp[cpLabel].wins++;

        // S19: Combined gates
        for (var fg of floorGates) {
          if (snap.floor < fg) continue;
          for (var ig of indGates) {
            if (indCount < ig) continue;
            for (var dg of defGates) {
              if (deficit > dg) continue;
              var gateKey = 'f' + fg.toFixed(2) + '_i' + ig + '_d' + dg;
              s19_combined[gateKey].n++;
              if (won) s19_combined[gateKey].wins++;
            }
          }
        }
      }

      // Track if the first BUY team took the lead later
      if (firstBuyTeam && !tookLead && snap.ctrl === firstBuyTeam && ctrlMargin > 0) {
        tookLead = true;
        tookLeadCp = cpLabel;
      }

      // Floor/deficit progression for first BUY team
      if (firstBuyTeam && snap.ctrl === firstBuyTeam) {
        var target = snap.ctrl_team_won ? s5_floorProg.winners : s5_floorProg.losers;
        target[cpLabel].push(snap.floor);
        var dtarget = snap.ctrl_team_won ? s6_deficitProg.winners : s6_deficitProg.losers;
        dtarget[cpLabel].push(ctrlMargin);
      }
    }

    // Skip games with no BUY-eligible checkpoints
    if (buyCheckpoints.length === 0) continue;
    totalBuyGames++;

    // Determine if first BUY team won
    var firstBuyWon = false;
    for (var bc of buyCheckpoints) {
      if (bc.snap.ctrl === firstBuyTeam) {
        firstBuyWon = bc.snap.ctrl_team_won;
        break;
      }
    }

    // ── Game-level accumulators ──

    // S1
    s1_firstFireByCp[firstBuyCp].n++;
    if (firstBuyWon) s1_firstFireByCp[firstBuyCp].wins++;

    // S2
    s2_floorAtFire[floorBucket(firstBuyFloor)].n++;
    if (firstBuyWon) s2_floorAtFire[floorBucket(firstBuyFloor)].wins++;

    // S3
    s3_deficitAtFire[deficitBucket(firstBuyDeficit)].n++;
    if (firstBuyWon) s3_deficitAtFire[deficitBucket(firstBuyDeficit)].wins++;

    // S4
    s4_peakFloor[floorBucket(peakFloorWhileTrailing)].n++;
    if (firstBuyWon) s4_peakFloor[floorBucket(peakFloorWhileTrailing)].wins++;

    // S7
    var holdKey;
    if (maxConsecutiveHolds <= 1) holdKey = '1 cp';
    else if (maxConsecutiveHolds <= 3) holdKey = '2-3 cp';
    else if (maxConsecutiveHolds <= 5) holdKey = '4-5 cp';
    else if (maxConsecutiveHolds <= 7) holdKey = '6-7 cp';
    else holdKey = '8+ cp';
    s7_consHolds[holdKey].n++;
    if (firstBuyWon) s7_consHolds[holdKey].wins++;

    // S16
    if (tookLead) {
      s16_comeback.took_lead.n++;
      if (firstBuyWon) s16_comeback.took_lead.wins++;
      s16_comeback.took_lead_by_q[tookLeadCp].n++;
      if (firstBuyWon) s16_comeback.took_lead_by_q[tookLeadCp].wins++;
    } else {
      s16_comeback.never_led.n++;
      if (firstBuyWon) s16_comeback.never_led.wins++;
    }

    // S17
    if (firstBuyWon) {
      s17_backtrace.total_winners++;
      s17_backtrace.avg_floor_at_first_fire.push(firstBuyFloor);
      s17_backtrace.avg_deficit_at_first_fire.push(firstBuyDeficit);
      s17_backtrace.avg_peak_floor.push(peakFloorWhileTrailing);
      s17_backtrace.avg_ind_count_at_first_fire.push(firstBuyIndCount);
      s17_backtrace.first_fire_cp_dist[firstBuyCp]++;
      if (tookLead) {
        s17_backtrace.took_lead++;
        s17_backtrace.comeback_q_dist[tookLeadCp]++;
      } else {
        s17_backtrace.never_led_but_won++;
      }
    }

    // S18
    for (var t = 0.50; t <= 0.90; t += 0.05) {
      if (peakFloorWhileTrailing >= t) {
        s18_floorSweep[t.toFixed(2)].n++;
        if (firstBuyWon) s18_floorSweep[t.toFixed(2)].wins++;
      }
    }

    // S20
    var durKey;
    if (totalBuyCheckpoints <= 1) durKey = '1 cp';
    else if (totalBuyCheckpoints <= 3) durKey = '2-3 cp';
    else if (totalBuyCheckpoints <= 5) durKey = '4-5 cp';
    else if (totalBuyCheckpoints <= 8) durKey = '6-8 cp';
    else durKey = '9+ cp';
    s20_trailDuration[durKey].n++;
    if (firstBuyWon) s20_trailDuration[durKey].wins++;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // OUTPUT ASSEMBLY
  // ══════════════════════════════════════════════════════════════════════════

  function avg(arr) { return arr.length > 0 ? Math.round(arr.reduce((a,b)=>a+b,0) / arr.length * 100) / 100 : null; }
  function med(arr) {
    if (arr.length === 0) return null;
    var sorted = arr.slice().sort((a,b) => a - b);
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? Math.round(sorted[mid]*100)/100 : Math.round((sorted[mid-1]+sorted[mid])/2*100)/100;
  }

  // Build floor/deficit progression output
  var floorProgOut = { winners: {}, losers: {} };
  var defProgOut = { winners: {}, losers: {} };
  for (var cp of checkpoints) {
    floorProgOut.winners[cp] = { n: s5_floorProg.winners[cp].length, mean: avg(s5_floorProg.winners[cp]) };
    floorProgOut.losers[cp] = { n: s5_floorProg.losers[cp].length, mean: avg(s5_floorProg.losers[cp]) };
    defProgOut.winners[cp] = { n: s6_deficitProg.winners[cp].length, mean: avg(s6_deficitProg.winners[cp]) };
    defProgOut.losers[cp] = { n: s6_deficitProg.losers[cp].length, mean: avg(s6_deficitProg.losers[cp]) };
  }

  // Filter combined gates to n >= 10, sort by win rate
  var s19_filtered = {};
  for (var k in s19_combined) {
    if (s19_combined[k].n >= 10) {
      s19_filtered[k] = {
        n: s19_combined[k].n, wins: s19_combined[k].wins,
        pct: Math.round(s19_combined[k].wins / s19_combined[k].n * 1000) / 10
      };
    }
  }
  var s19_sorted = Object.entries(s19_filtered)
    .sort((a,b) => b[1].pct - a[1].pct)
    .reduce((obj, [k,v]) => { obj[k] = v; return obj; }, {});

  // S12 output
  var s12_out = {};
  for (var ind in s12_indImpact) {
    s12_out[ind] = {};
    for (var state in s12_indImpact[ind]) {
      var v = s12_indImpact[ind][state];
      s12_out[ind][state] = { n: v.n, wins: v.wins, pct: v.n > 0 ? Math.round(v.wins / v.n * 1000) / 10 : null };
    }
  }

  // S13 output
  var s13_out = Object.entries(s13_pairs)
    .filter(([k,v]) => v.n >= 5)
    .sort((a,b) => b[1].n - a[1].n)
    .reduce((obj, [k,v]) => {
      obj[k] = { n: v.n, wins: v.wins, pct: Math.round(v.wins / v.n * 1000) / 10 };
      return obj;
    }, {});

  // S17 output
  var s17_out = {
    total_winners: s17_backtrace.total_winners,
    total_buy_games: totalBuyGames,
    win_rate: totalBuyGames > 0 ? Math.round(s17_backtrace.total_winners / totalBuyGames * 1000) / 10 : null,
    avg_floor_at_first_fire: avg(s17_backtrace.avg_floor_at_first_fire),
    median_floor_at_first_fire: med(s17_backtrace.avg_floor_at_first_fire),
    avg_deficit_at_first_fire: avg(s17_backtrace.avg_deficit_at_first_fire),
    median_deficit_at_first_fire: med(s17_backtrace.avg_deficit_at_first_fire),
    avg_peak_floor: avg(s17_backtrace.avg_peak_floor),
    avg_ind_count: avg(s17_backtrace.avg_ind_count_at_first_fire),
    first_fire_cp_dist: s17_backtrace.first_fire_cp_dist,
    took_lead_pct: s17_backtrace.total_winners > 0
      ? Math.round(s17_backtrace.took_lead / s17_backtrace.total_winners * 1000) / 10 : null,
    never_led_but_won: s17_backtrace.never_led_but_won,
    comeback_checkpoint_dist: s17_backtrace.comeback_q_dist,
  };

  return {
    _meta: {
      filter: closeOnly ? 'competitive games (within 5 in Q3, within 7 in Q4)' : 'all games',
      total_games_analyzed: totalGames,
      total_games_with_buy_eligible: totalBuyGames,
      buy_eligible_pct: totalGames > 0 ? Math.round(totalBuyGames / totalGames * 1000) / 10 : null,
    },

    section_1_first_fire: {
      description: 'At which checkpoint does a trailing ctrl team first appear? Win rate = did that team win the game.',
      by_checkpoint: pct(s1_firstFireByCp),
    },

    section_2_floor_at_first_fire: {
      description: 'Floor bucket at the first BUY-eligible checkpoint. Higher floor while trailing = stronger structural thesis.',
      by_floor: pct(s2_floorAtFire),
    },

    section_3_deficit_at_first_fire: {
      description: 'How far behind is the ctrl team at first fire? Shallower deficits = more realistic comebacks.',
      by_deficit: pct(s3_deficitAtFire),
    },

    section_4_peak_floor_while_trailing: {
      description: 'Highest floor the ctrl team achieved at any BUY-eligible checkpoint. The graduation equivalent — how strong did structural control get while behind?',
      by_peak_floor: pct(s4_peakFloor),
    },

    section_5_floor_progression: {
      description: 'Mean floor at each checkpoint for the first BUY team, split by outcome. Shows whether winning trailing teams build floor faster.',
      progression: floorProgOut,
    },

    section_6_deficit_progression: {
      description: 'Mean ctrl-relative margin at each checkpoint for the first BUY team, split by outcome. Negative = trailing. Shows whether deficit narrows for winners.',
      progression: defProgOut,
    },

    section_7_consecutive_trailing_holds: {
      description: 'Max consecutive checkpoints maintaining ctrl while trailing. Persistence = conviction strength.',
      by_hold_count: pct(s7_consHolds),
    },

    section_8_floor_velocity: {
      description: 'Floor delta between consecutive BUY-eligible checkpoints. Is the structural thesis strengthening or weakening?',
      by_velocity: pct(s8_velocity),
    },

    section_9_floor_x_deficit: {
      description: 'The money grid. Floor bucket x deficit bucket -> win rate. Every BUY-eligible snapshot.',
      grid: (function() {
        var out = {};
        for (var fb of floorBuckets) {
          out[fb] = {};
          for (var db of defBuckets) {
            var v = s9_grid[fb][db];
            out[fb][db] = { n: v.n, wins: v.wins, pct: v.n > 0 ? Math.round(v.wins / v.n * 1000) / 10 : null };
          }
        }
        return out;
      })(),
    },

    section_10_indicator_count: {
      description: 'How many indicators (I1-I5) does the ctrl team win while trailing? More indicators = stronger structural argument.',
      by_count: pct(s10_indCount),
    },

    section_11_conviction: {
      description: 'Conviction tier (DOMINANT/STRONG/etc) while trailing -> win rate.',
      by_conviction: pct(s11_conviction),
    },

    section_12_individual_indicators: {
      description: 'Each indicator won/even/lost by ctrl team while trailing -> win rate. Which indicators matter most for comebacks?',
      by_indicator: s12_out,
    },

    section_13_indicator_pairs: {
      description: 'Indicator pair combinations while trailing (both won) -> win rate. Includes golden_3i_0opp_t14 = 3+ indicators + 0 opp indicators + trail 1-4.',
      pairs: s13_out,
    },

    section_14_opponent_indicators: {
      description: 'How many indicators does the OPPONENT win while trailing ctrl has structural control? More opp indicators = weaker thesis.',
      by_opp_count: pct(s14_oppCount),
    },

    section_15_win_rate_by_checkpoint: {
      description: 'Win rate of BUY-eligible snapshots at each checkpoint. Time-based accuracy curve — does being trailing ctrl matter more in Q2 vs Q4?',
      by_checkpoint: pct(s15_byCp),
    },

    section_16_comeback_path: {
      description: 'Did the first BUY team ever take the lead? When? Taking the lead is confirmation the structural thesis converted.',
      took_lead: pct({ took_lead: s16_comeback.took_lead, never_led: s16_comeback.never_led }),
      lead_taken_at: pct(s16_comeback.took_lead_by_q),
    },

    section_17_winner_backtrace: {
      description: 'Profile of trailing ctrl teams that WON. What do successful comebacks look like?',
      profile: s17_out,
    },

    section_18_floor_threshold_sweep: {
      description: 'Peak floor while trailing >= threshold -> win rate + volume. Where does floor become predictive for comebacks?',
      thresholds: pct(s18_floorSweep),
    },

    section_19_combined_gates: {
      description: 'Floor >= X + indicators >= Y + deficit <= Z -> win rate. Best combined gates for BUY filtering. Format: fX.XX_iY_dZ. Only combos with n>=10, sorted by win rate.',
      gates: s19_sorted,
    },

    section_20_trailing_duration: {
      description: 'Total checkpoints spent as trailing ctrl team -> win rate. Does prolonged trailing-with-control predict anything?',
      by_duration: pct(s20_trailDuration),
    },
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// GRADUATION SIM v2 — full CHECKPOINT_GRADUATION_SPEC v3 rules + enhancements
// ?phase=report_graduation_sim             — all games
// ?phase=report_graduation_sim&close=1     — competitive games only
// ?phase=report_graduation_sim&detail=1    — include per-game detail list
// ?phase=report_graduation_sim&mf=0.65     — override MF gate
// ══════════════════════════════════════════════════════════════════════════════
async function reportGraduationSim(sql, url) {
  var closeOnly = url?.searchParams?.get('close') === '1';
  var showDetail = url?.searchParams?.get('detail') === '1';
  var laneOverride = url?.searchParams?.get('lane') || null;

  // ── Lane thresholds from spec ──
  var LANE_THRESHOLDS = {
    underdog:       { mfGate: 0.70, minFGate: 0.58 },
    tossup:         { mfGate: 0.75, minFGate: 0.58 },
    favorite:       { mfGate: 0.72, minFGate: 0.58 },
    heavy_favorite: { mfGate: 0.75, minFGate: 0.58 },
  };
  var activeLane = laneOverride || 'tossup';
  var gates = LANE_THRESHOLDS[activeLane] || LANE_THRESHOLDS.tossup;
  var mfOverride = url?.searchParams?.get('mf');
  if (mfOverride) gates = { mfGate: parseFloat(mfOverride), minFGate: gates.minFGate };

  var rows = await sql`
    SELECT game_id, checkpoint, margin_at_snapshot AS margin,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl,
           indicators->>'homeAlias' AS home_alias,
           indicators->>'awayAlias' AS away_alias,
           (indicators->>'I1')::text AS i1raw, (indicators->>'I2')::text AS i2raw,
           (indicators->>'I3')::text AS i3raw, (indicators->>'I4')::text AS i4raw,
           (indicators->>'I5')::text AS i5raw,
           (conviction->>'tier') AS conv_tier,
           (conviction->>'count')::int AS ind_count,
           ctrl_team_won, final_margin
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  var checkpoints = CP_LABELS;
  var cpIdx = {}; for (var i = 0; i < checkpoints.length; i++) cpIdx[checkpoints[i]] = i;
  var Q3_6_IDX = cpIdx['Q3_6'];

  var gameMap = {};
  for (var r of rows) {
    if (!gameMap[r.game_id]) gameMap[r.game_id] = [];
    gameMap[r.game_id].push(r);
  }

  var Q3_CPS = new Set(['Q3_9','Q3_6','Q3_3','Q3_END']);
  var Q4_CPS = new Set(['Q4_9','Q4_6','Q4_3','Q4_END']);
  if (closeOnly) {
    for (var gid of Object.keys(gameMap)) {
      var competitive = gameMap[gid].some(function(s) {
        var absM = Math.abs(s.margin);
        if (Q3_CPS.has(s.checkpoint) && absM <= 5) return true;
        if (Q4_CPS.has(s.checkpoint) && absM <= 7) return true;
        return false;
      });
      if (!competitive) delete gameMap[gid];
    }
  }

  function getCtrlMargin(r) { return (r.ctrl === r.home_alias) ? r.margin : -r.margin; }
  function getOppCount(r) {
    var ctrlHome = r.ctrl === r.home_alias;
    var scores = [parseFloat(r.i1raw), parseFloat(r.i2raw), parseFloat(r.i3raw),
                  parseFloat(r.i4raw), parseFloat(r.i5raw)];
    var c = 0;
    for (var s of scores) { if (isNaN(s)) continue; if (ctrlHome ? (s === 0) : (s === 1)) c++; }
    return c;
  }
  function classifyBWCTier(conv, lead, holds, oppCount) {
    if (conv === 'DOMINANT' && lead >= 8 && holds >= 4 && oppCount <= 1) return 'A';
    if (oppCount >= 3) return 'C';
    if ((conv === 'DOMINANT' || conv === 'STRONG') && lead >= 3 && holds >= 2) return 'B';
    return 'C';
  }
  function ph(b) { return { n: b.n, wins: b.wins, pct: b.n > 0 ? Math.round(b.wins / b.n * 1000) / 10 : null }; }
  function teamWon(team, homeAlias, finalMargin) {
    if (finalMargin === 0) return false;
    var homeWon = finalMargin > 0;
    return (team === homeAlias) ? homeWon : !homeWon;
  }

  // ── Accumulators ──
  var totalGames = 0, totalBWCGames = 0, no_bwc = 0;
  var poFired = { n: 0, wins: 0 };
  // S-rank is POST-HOC only now — all A-grades fire as 'A'
  var poByRank = { A: {n:0,wins:0}, B: {n:0,wins:0} };
  var postHocS = { n: 0, wins: 0 }; // A-rank + zero ctrl flips at game end
  var postHocA = { n: 0, wins: 0 }; // A-rank with flips (not W2W)
  var poByCheckpoint = {};
  for (var cp of checkpoints) poByCheckpoint[cp] = {n:0,wins:0};
  var poFlipped = { n: 0, wins: 0 };
  var poNotFlipped = { n: 0, wins: 0 };
  var graduated_blocked = { n: 0, wins: 0 };
  var never_graduated = { n: 0, wins: 0 };

  // Margin at PO fire
  var poMarginBuckets = {
    'lead_1_4': {n:0,wins:0}, 'lead_5_8': {n:0,wins:0},
    'lead_9_12': {n:0,wins:0}, 'lead_13_plus': {n:0,wins:0},
    'trailing_or_tied': {n:0,wins:0}
  };

  // MF sensitivity sweep
  var mfSweep = {};
  var sweepThresholds = [0.60, 0.65, 0.70, 0.72, 0.75, 0.78, 0.80, 0.85];
  for (var t of sweepThresholds) mfSweep[t.toFixed(2)] = {n:0,wins:0};

  // Conviction cross-tab at PO fire
  var convByRank = {
    A: { DOMINANT:{n:0,wins:0}, STRONG:{n:0,wins:0}, MODEST:{n:0,wins:0}, CONDITIONAL:{n:0,wins:0}, other:{n:0,wins:0} },
    B: { DOMINANT:{n:0,wins:0}, STRONG:{n:0,wins:0}, MODEST:{n:0,wins:0}, CONDITIONAL:{n:0,wins:0}, other:{n:0,wins:0} },
  };

  // ── Flip deep analysis ──
  var flipByCheckpoint = {};
  for (var cp of checkpoints) flipByCheckpoint[cp] = {n:0,wins:0};
  var flipByRank = { A: {n:0,wins:0}, B: {n:0,wins:0} };
  var flipLossOrigin = { type1_both_wrong: 0, type2_original_was_right: 0, total_flip_losses: 0 };

  // ── B confirmation window sweep ──
  // For each N (0,1,2,3,4): B fires N checkpoints after graduation, not at fixed Q3_6
  var bConfirmNs = [0, 1, 2, 3, 4];
  var bConfirmSweep = {};
  for (var n of bConfirmNs) bConfirmSweep[n] = { n: 0, wins: 0 };

  // ── Flip criteria comparison ──
  // Track alongside main sim: lighter flip criteria
  var flipCriteria = {
    current: { n: 0, wins: 0 },    // graduated B+, 2+ holds, MF>=0.55, more recent
    lighter: { n: 0, wins: 0 },    // BWC-eligible (floor>=0.60, margin>=2), 2+ holds, more recent ctrl
    lightest: { n: 0, wins: 0 },   // BWC-eligible, 1+ hold (just took control back)
  };

  // Detail list
  var detailList = [];

  // ── GAME LOOP ──
  for (var [gid, snaps] of Object.entries(gameMap)) {
    var cpMap = {};
    for (var s of snaps) cpMap[s.checkpoint] = s;
    if (!cpMap['Q2_6']) continue;
    totalGames++;

    var homeA = snaps[0].home_alias;
    var awayA = snaps[0].away_alias;
    var finalM = snaps[0].final_margin;

    var teamState = {};
    teamState[homeA] = { cpHolds: 0, eligibleFloors: [], peakRank: 'C', gradCpIdx: null, gradRank: null };
    teamState[awayA] = { cpHolds: 0, eligibleFloors: [], peakRank: 'C', gradCpIdx: null, gradRank: null };

    var bwcTeam = null;
    var ctrlFlips = 0;
    var prevCtrl = null;

    var gamePO = null;
    var gameBlocked = null;

    // B confirmation sweep trackers (per-N)
    var bConfirmFired = {};
    for (var bn of bConfirmNs) bConfirmFired[bn] = null;

    // Flip criteria trackers (per-criteria, per-game)
    var flipCriteriaFired = { current: null, lighter: null, lightest: null };

    for (var ci = 0; ci < checkpoints.length; ci++) {
      var cpLabel = checkpoints[ci];
      var snap = cpMap[cpLabel];
      if (!snap || !snap.ctrl) continue;

      var ctrlMargin = getCtrlMargin(snap);
      var oppCount = getOppCount(snap);
      var ctrlTeam = snap.ctrl;
      var oppTeam = ctrlTeam === homeA ? awayA : homeA;

      if (prevCtrl && prevCtrl !== ctrlTeam) ctrlFlips++;
      prevCtrl = ctrlTeam;

      teamState[ctrlTeam].cpHolds++;
      teamState[oppTeam].cpHolds = 0;

      var bwcEligible = snap.floor >= 0.60 && ctrlMargin >= 2;
      if (!bwcEligible) continue;

      if (!bwcTeam) bwcTeam = ctrlTeam;

      teamState[ctrlTeam].eligibleFloors.push(snap.floor);

      var holds = teamState[ctrlTeam].cpHolds;
      var rank = classifyBWCTier(snap.conv_tier, ctrlMargin, holds, oppCount);

      var RANK_ORDER = { C: 0, B: 1, A: 2 };
      if (RANK_ORDER[rank] > RANK_ORDER[teamState[ctrlTeam].peakRank]) {
        teamState[ctrlTeam].peakRank = rank;
        teamState[ctrlTeam].gradCpIdx = ci;
        teamState[ctrlTeam].gradRank = rank;
      }

      // ── BWC team PO evaluation ──
      if (ctrlTeam === bwcTeam) {
        var bwcFloors = teamState[bwcTeam].eligibleFloors;
        var mf = bwcFloors.reduce(function(a,b){return a+b;},0) / bwcFloors.length;
        var minF = Math.min.apply(null, bwcFloors);

        if (!gamePO && teamState[bwcTeam].gradRank) {
          var gRank = teamState[bwcTeam].gradRank;

          // A-rank: fire at any checkpoint (NO S classification at fire time)
          if (gRank === 'A') {
            if (mf >= gates.mfGate && minF >= gates.minFGate) {
              gamePO = { team: bwcTeam, rank: 'A', cpLabel: cpLabel, cpIdx: ci,
                         mf: mf, minF: minF, margin: ctrlMargin, flipped: false,
                         conv: snap.conv_tier };
              gameBlocked = null;
            } else {
              gameBlocked = { rank: gRank, team: bwcTeam, mf: mf, minF: minF,
                reason: 'A-Rank MF ' + mf.toFixed(3) + (mf < gates.mfGate ? ' < ' + gates.mfGate : '') +
                        (minF < gates.minFGate ? ' | minF ' + minF.toFixed(2) + ' < ' + gates.minFGate : '') };
            }
          }
          // B-rank: Q3_6+ gate
          if (gRank === 'B') {
            var pastQ3_6 = ci >= Q3_6_IDX;
            if (pastQ3_6 && mf >= gates.mfGate && minF >= gates.minFGate) {
              gamePO = { team: bwcTeam, rank: 'B', cpLabel: cpLabel, cpIdx: ci,
                         mf: mf, minF: minF, margin: ctrlMargin, flipped: false,
                         conv: snap.conv_tier };
              gameBlocked = null;
            } else {
              var reason = !pastQ3_6
                ? 'B-Rank waiting Q3_6+ (at ' + cpLabel + ')'
                : 'B-Rank MF ' + mf.toFixed(3) + (mf < gates.mfGate ? ' < ' + gates.mfGate : '') +
                  (minF < gates.minFGate ? ' | minF ' + minF.toFixed(2) + ' < ' + gates.minFGate : '');
              gameBlocked = { rank: gRank, team: bwcTeam, mf: mf, minF: minF, reason: reason };
            }
          }
        }

        // ── B confirmation window sweep (parallel tracker) ──
        if (teamState[bwcTeam].gradRank === 'B' || teamState[bwcTeam].gradRank === 'A') {
          if (teamState[bwcTeam].gradRank === 'B') {
            var cpsSinceGrad = ci - teamState[bwcTeam].gradCpIdx;
            for (var bn of bConfirmNs) {
              if (bConfirmFired[bn] === null && cpsSinceGrad >= bn && mf >= gates.mfGate && minF >= gates.minFGate) {
                bConfirmFired[bn] = { team: bwcTeam, ci: ci };
              }
            }
          }
        }
      }

      // ── FLIP EVALUATION (main sim — current criteria) ──
      // Check when opponent has control
      if (ctrlTeam !== bwcTeam && bwcTeam) {
        var oppState = teamState[ctrlTeam];

        // ── Current criteria: graduated B+, 2+ holds, MF>=0.55, more recent ──
        if (oppState.gradRank && (oppState.gradRank === 'B' || oppState.gradRank === 'A')) {
          var bwcGradIdx = teamState[bwcTeam].gradCpIdx;
          var oppGradIdx = oppState.gradCpIdx;
          var oppIsMoreRecent = bwcGradIdx === null || oppGradIdx > bwcGradIdx;

          var oppFloors = oppState.eligibleFloors;
          var oppMF = oppFloors.length > 0
            ? oppFloors.reduce(function(a,b){return a+b;},0) / oppFloors.length : null;

          if (oppIsMoreRecent && oppState.cpHolds >= 2 && oppMF !== null && oppMF >= 0.55) {
            // Flip fires — overwrite PO (or create if none existed)
            if (!gamePO || gamePO.team !== ctrlTeam) {
              var prevPOTeam = gamePO ? gamePO.team : bwcTeam;
              gamePO = { team: ctrlTeam, rank: oppState.gradRank, cpLabel: cpLabel, cpIdx: ci,
                         mf: oppMF, minF: null, margin: ctrlMargin, flipped: true,
                         original_bwc: prevPOTeam, conv: snap.conv_tier };
              gameBlocked = null;
            }
          }

          // Track for criteria comparison (current)
          if (oppIsMoreRecent && oppState.cpHolds >= 2 && oppMF !== null && oppMF >= 0.55) {
            if (!flipCriteriaFired.current) flipCriteriaFired.current = { team: ctrlTeam };
          }
        }

        // ── Lighter criteria: BWC-eligible + 2+ holds (no graduation required) ──
        if (oppState.cpHolds >= 2) {
          if (!flipCriteriaFired.lighter) flipCriteriaFired.lighter = { team: ctrlTeam };
        }

        // ── Lightest criteria: BWC-eligible + 1+ hold (just has control) ──
        if (oppState.cpHolds >= 1) {
          if (!flipCriteriaFired.lightest) flipCriteriaFired.lightest = { team: ctrlTeam };
        }
      }

      // Also: flip when PO already exists on different team
      if (gamePO && !gamePO.flipped && ctrlTeam !== gamePO.team && bwcTeam) {
        var oppState2 = teamState[ctrlTeam];
        if (oppState2.gradRank && (oppState2.gradRank === 'B' || oppState2.gradRank === 'A')) {
          var origGradIdx2 = teamState[gamePO.team]?.gradCpIdx ?? -1;
          var oppGradIdx2 = oppState2.gradCpIdx;
          var oppFloors2 = oppState2.eligibleFloors;
          var oppMF2 = oppFloors2.length > 0
            ? oppFloors2.reduce(function(a,b){return a+b;},0) / oppFloors2.length : null;

          if (oppGradIdx2 > origGradIdx2 && oppState2.cpHolds >= 2 && oppMF2 !== null && oppMF2 >= 0.55) {
            var prevTeam = gamePO.team;
            gamePO = { team: ctrlTeam, rank: oppState2.gradRank, cpLabel: cpLabel, cpIdx: ci,
                       mf: oppMF2, minF: null, margin: ctrlMargin, flipped: true,
                       original_bwc: prevTeam, conv: snap.conv_tier };
          }
        }
      }
    } // end checkpoint loop

    // ── Determine outcomes ──
    if (!bwcTeam) { no_bwc++; continue; }
    totalBWCGames++;

    if (gamePO) {
      var poWon = teamWon(gamePO.team, homeA, finalM);
      poFired.n++; if (poWon) poFired.wins++;

      // Rank (A or B only at fire time)
      poByRank[gamePO.rank].n++; if (poWon) poByRank[gamePO.rank].wins++;

      // Post-hoc S: A-rank + zero ctrl flips at game end
      if (gamePO.rank === 'A' && !gamePO.flipped) {
        if (ctrlFlips === 0) { postHocS.n++; if (poWon) postHocS.wins++; }
        else { postHocA.n++; if (poWon) postHocA.wins++; }
      }

      poByCheckpoint[gamePO.cpLabel].n++; if (poWon) poByCheckpoint[gamePO.cpLabel].wins++;

      if (gamePO.flipped) {
        poFlipped.n++; if (poWon) poFlipped.wins++;
        flipByCheckpoint[gamePO.cpLabel].n++; if (poWon) flipByCheckpoint[gamePO.cpLabel].wins++;
        flipByRank[gamePO.rank].n++; if (poWon) flipByRank[gamePO.rank].wins++;

        // Flip loss origin
        if (!poWon) {
          flipLossOrigin.total_flip_losses++;
          var originalWon = teamWon(gamePO.original_bwc, homeA, finalM);
          if (originalWon) flipLossOrigin.type2_original_was_right++;
          else flipLossOrigin.type1_both_wrong++;
        }
      } else {
        poNotFlipped.n++; if (poWon) poNotFlipped.wins++;
      }

      // Margin bucket
      var m = gamePO.margin;
      var mBucket = m <= 0 ? 'trailing_or_tied' : m <= 4 ? 'lead_1_4' : m <= 8 ? 'lead_5_8' : m <= 12 ? 'lead_9_12' : 'lead_13_plus';
      poMarginBuckets[mBucket].n++; if (poWon) poMarginBuckets[mBucket].wins++;

      // Conviction cross-tab
      var convKey = gamePO.conv || 'other';
      if (!convByRank[gamePO.rank]) convKey = 'other';
      if (convByRank[gamePO.rank]) {
        var cb = convByRank[gamePO.rank][convKey] || convByRank[gamePO.rank].other;
        cb.n++; if (poWon) cb.wins++;
      }

      if (showDetail) {
        detailList.push({
          game_id: gid, matchup: awayA + '@' + homeA,
          po_team: gamePO.team, rank: gamePO.rank, cp: gamePO.cpLabel,
          mf: Math.round(gamePO.mf * 1000) / 1000, margin: gamePO.margin,
          conv: gamePO.conv, flipped: gamePO.flipped,
          original_bwc: gamePO.original_bwc || null,
          postHocS: gamePO.rank === 'A' && !gamePO.flipped && ctrlFlips === 0,
          ctrl_flips: ctrlFlips, won: poWon, final_margin: finalM,
        });
      }
    } else if (gameBlocked) {
      var blockedTeamWon = teamWon(gameBlocked.team, homeA, finalM);
      graduated_blocked.n++; if (blockedTeamWon) graduated_blocked.wins++;
    } else {
      var bwcWon = teamWon(bwcTeam, homeA, finalM);
      never_graduated.n++; if (bwcWon) never_graduated.wins++;
    }

    // ── B confirmation window sweep results ──
    for (var bn of bConfirmNs) {
      if (bConfirmFired[bn]) {
        var bcWon = teamWon(bConfirmFired[bn].team, homeA, finalM);
        bConfirmSweep[bn].n++; if (bcWon) bConfirmSweep[bn].wins++;
      }
    }

    // ── Flip criteria comparison results ──
    for (var fcKey of ['current', 'lighter', 'lightest']) {
      if (flipCriteriaFired[fcKey]) {
        var fcWon = teamWon(flipCriteriaFired[fcKey].team, homeA, finalM);
        flipCriteria[fcKey].n++; if (fcWon) flipCriteria[fcKey].wins++;
      }
    }

    // ── MF Sensitivity Sweep ──
    for (var st of sweepThresholds) {
      var stKey = st.toFixed(2);
      var anyGrad = false, sweepTeam = null;
      for (var team of [homeA, awayA]) {
        if (teamState[team].gradRank && (teamState[team].gradRank === 'A' || teamState[team].gradRank === 'B')) {
          var tFloors = teamState[team].eligibleFloors;
          if (tFloors.length > 0) {
            var tMF = tFloors.reduce(function(a,b){return a+b;},0) / tFloors.length;
            var tMinF = Math.min.apply(null, tFloors);
            if (tMF >= st && tMinF >= 0.58) {
              if (teamState[team].gradRank === 'A' || teamState[team].gradCpIdx >= Q3_6_IDX) {
                if (!anyGrad) { anyGrad = true; sweepTeam = team; }
              }
            }
          }
        }
      }
      if (anyGrad && sweepTeam) {
        var swWon = teamWon(sweepTeam, homeA, finalM);
        mfSweep[stKey].n++; if (swWon) mfSweep[stKey].wins++;
      }
    }
  } // end game loop

  // ── Build output ──
  var result = {
    _meta: {
      filter: closeOnly ? 'competitive games (within 5 in Q3, within 7 in Q4)' : 'all games',
      lane: activeLane, gates: gates,
      total_games: totalGames, total_bwc_games: totalBWCGames, no_bwc_games: no_bwc,
    },

    section_1_overall: {
      description: 'Overall PO accuracy. S dissolved into A at fire time; S is post-hoc only.',
      po_fired: ph(poFired),
      po_coverage: totalBWCGames > 0 ? Math.round(poFired.n / totalBWCGames * 1000) / 10 + '%' : null,
      graduated_but_blocked: ph(graduated_blocked),
      never_graduated: ph(never_graduated),
    },

    section_2_by_rank: {
      description: 'Rank at fire time (A or B only). S is post-hoc — see section 3.',
      A: ph(poByRank.A),
      B: ph(poByRank.B),
    },

    section_3_post_hoc_s: {
      description: 'S = A-rank (non-flipped) with zero ctrl flips at game end. Post-hoc only, not assigned at fire time.',
      S_post_hoc: ph(postHocS),
      A_with_flips: ph(postHocA),
      note: 'A-rank total = S_post_hoc + A_with_flips + A-rank flipped POs',
    },

    section_4_flip_deep: {
      description: 'Flip analysis: when, to which rank, and loss origin (Type 2 = original PO team actually won).',
      standard_po: ph(poNotFlipped),
      flipped_po: ph(poFlipped),
      flip_rate: poFired.n > 0 ? Math.round(poFlipped.n / poFired.n * 1000) / 10 + '%' : null,
      flip_by_rank: {
        A: ph(flipByRank.A),
        B: ph(flipByRank.B),
      },
      flip_by_checkpoint: Object.fromEntries(
        Object.entries(flipByCheckpoint).filter(function(e) { return e[1].n > 0; }).map(function(e) { return [e[0], ph(e[1])]; })
      ),
      flip_loss_origin: {
        total_flip_losses: flipLossOrigin.total_flip_losses,
        type1_both_wrong: flipLossOrigin.type1_both_wrong,
        type2_original_was_right: flipLossOrigin.type2_original_was_right,
        type2_pct: flipLossOrigin.total_flip_losses > 0
          ? Math.round(flipLossOrigin.type2_original_was_right / flipLossOrigin.total_flip_losses * 1000) / 10 + '%'
          : null,
        interpretation: 'Type 1 = both teams wrong, flip did not hurt. Type 2 = original was correct, flip actively damaged accuracy.',
      },
    },

    section_5_flip_criteria_comparison: {
      description: 'Flip with different triggering criteria. Current = graduated B+, 2+ holds, MF>=0.55. Lighter = BWC-eligible + 2+ holds (no graduation). Lightest = BWC-eligible + 1 hold.',
      current_graduated: ph(flipCriteria.current),
      lighter_eligible_2holds: ph(flipCriteria.lighter),
      lightest_eligible_1hold: ph(flipCriteria.lightest),
    },

    section_6_b_confirmation_window: {
      description: 'B-rank with relative confirmation: PO fires N checkpoints after B graduation (not fixed Q3_6). Compare to find optimal confirmation depth.',
      by_n: Object.fromEntries(bConfirmNs.map(function(n) {
        return ['N=' + n + '_cps_after_grad', ph(bConfirmSweep[n])];
      })),
      note: 'N=0 = fire immediately at graduation. N=2 = fire 2 checkpoints later. Current spec uses fixed Q3_6 gate instead.',
    },

    section_7_conviction_cross_tab: {
      description: 'Conviction tier at the checkpoint where PO fired, cross-tabbed by rank.',
      A: Object.fromEntries(
        Object.entries(convByRank.A).filter(function(e) { return e[1].n > 0; }).map(function(e) { return [e[0], ph(e[1])]; })
      ),
      B: Object.fromEntries(
        Object.entries(convByRank.B).filter(function(e) { return e[1].n > 0; }).map(function(e) { return [e[0], ph(e[1])]; })
      ),
    },

    section_8_by_checkpoint: {
      description: 'When does PO fire?',
      checkpoints: Object.fromEntries(
        Object.entries(poByCheckpoint).filter(function(e) { return e[1].n > 0; }).map(function(e) { return [e[0], ph(e[1])]; })
      ),
    },

    section_9_margin_at_fire: {
      description: 'Lead at PO fire.',
      buckets: Object.fromEntries(
        Object.entries(poMarginBuckets).filter(function(e) { return e[1].n > 0; }).map(function(e) { return [e[0], ph(e[1])]; })
      ),
    },

    section_10_mf_sensitivity: {
      description: 'Volume and accuracy at different MF gate thresholds.',
      by_threshold: Object.fromEntries(
        Object.entries(mfSweep).map(function(e) { return [e[0], ph(e[1])]; })
      ),
    },
  };

  if (showDetail && detailList.length > 0) {
    detailList.sort(function(a,b) { return a.game_id - b.game_id; });
    result.section_11_detail = {
      description: 'Per-game detail.',
      count: detailList.length,
      games: detailList,
    };
  }

  return result;
}



// ── BUY EXIT TRIGGER SIMULATION ─────────────────────────────────────────────
// Tests 4 EXIT thresholds (A/D/B/C) on BUY-eligible games using backtest
// checkpoint data (~1,230 games). Measures precision, flip signal accuracy,
// and reclaim analysis. Lane breakdown requires odds (future enhancement).
// Usage: ?phase=report_buy_exit_sim  or  ?phase=report_buy_exit_sim&close=1
async function reportBuyExitSim(sql, url) {
  var closeOnly = url?.searchParams?.get('close') === '1';
  var t0 = Date.now();

  // ── 1. Pull all backtest snapshots ──
  var rows = await sql`
    SELECT game_id, checkpoint,
           margin_at_snapshot AS margin,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl,
           indicators->>'homeAlias' AS home_alias,
           indicators->>'awayAlias' AS away_alias,
           ctrl_team_won, final_margin
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  var checkpoints = CP_LABELS;
  var cpIndex = {};
  for (var ci = 0; ci < checkpoints.length; ci++) cpIndex[checkpoints[ci]] = ci;

  // ── 2. Group by game ──
  var games = {};
  for (var r of rows) {
    if (!games[r.game_id]) games[r.game_id] = [];
    games[r.game_id].push(r);
  }

  // ── 3. Competitive game filter (close=1): within 5 in Q3, within 7 in Q4 ──
  var Q3_CPS = new Set(['Q3_9', 'Q3_6', 'Q3_3', 'Q3_END']);
  var Q4_CPS = new Set(['Q4_9', 'Q4_6', 'Q4_3', 'Q4_END']);
  var allGameIds = Object.keys(games);

  if (closeOnly) {
    for (var gid of allGameIds) {
      var competitive = games[gid].some(function(s) {
        var absM = Math.abs(s.margin);
        if (Q3_CPS.has(s.checkpoint) && absM <= 5) return true;
        if (Q4_CPS.has(s.checkpoint) && absM <= 7) return true;
        return false;
      });
      if (!competitive) delete games[gid];
    }
  }

  var gameIds = Object.keys(games);

  // ── Helpers ──
  function getCtrlMargin(r) {
    return (r.ctrl === r.home_alias) ? r.margin : -r.margin;
  }

  // ── 4. Process each game ──
  var results = [];

  for (var gid of gameIds) {
    var snaps = games[gid];
    // Sort by checkpoint order
    snaps.sort(function(a, b) { return (cpIndex[a.checkpoint] || 0) - (cpIndex[b.checkpoint] || 0); });

    var meta = snaps[0];

    // Find first BUY-eligible checkpoint: floor >= 0.55, ctrl trailing, Q2+
    var buySnap = null;
    var buyIdx = -1;
    for (var i = 0; i < snaps.length; i++) {
      var s = snaps[i];
      if (!s.checkpoint.startsWith('Q2') && !s.checkpoint.startsWith('Q3') && !s.checkpoint.startsWith('Q4')) continue;
      if (s.floor < 0.55) continue;
      var ctrlM = getCtrlMargin(s);
      if (ctrlM >= 0) continue; // not trailing
      buySnap = s;
      buyIdx = i;
      break;
    }
    if (!buySnap) continue;

    var buyTeam = buySnap.ctrl;
    var buyFloor = buySnap.floor;
    var buyMargin = Math.abs(getCtrlMargin(buySnap));
    var buyTeamWon = buySnap.ctrl_team_won;
    // ctrl_team_won is relative to ctrl at THAT checkpoint — need to verify it's the buy team
    // Actually ctrl_team_won tracks whether the ctrl team at snapshot time won the game
    // Since buyTeam = ctrl at buySnap, buyTeamWon = buySnap.ctrl_team_won
    // But if ctrl changes later, we need to check if buyTeam won from any snap where buyTeam is ctrl
    // Safest: check final_margin + team identity
    var buyIsHome = buyTeam === meta.home_alias;
    var finalM = meta.final_margin; // home - away
    var buyTeamWonFinal = buyIsHome ? finalM > 0 : finalM < 0;

    // ── Find EXIT triggers: opponent takes control at various floor thresholds ──
    var triggerA = null, triggerD = null, triggerB = null, triggerC = null;

    for (var j = buyIdx + 1; j < snaps.length; j++) {
      var snap = snaps[j];
      if (!snap.ctrl || snap.ctrl === buyTeam) continue; // same team still controls
      var oppFloor = snap.floor;

      if (!triggerA) triggerA = { idx: j, checkpoint: snap.checkpoint, oppFloor: oppFloor, oppTeam: snap.ctrl };
      if (!triggerD && oppFloor >= 0.50) triggerD = { idx: j, checkpoint: snap.checkpoint, oppFloor: oppFloor, oppTeam: snap.ctrl };
      if (!triggerB && oppFloor >= 0.60) triggerB = { idx: j, checkpoint: snap.checkpoint, oppFloor: oppFloor, oppTeam: snap.ctrl };
      if (!triggerC && oppFloor >= 0.65) triggerC = { idx: j, checkpoint: snap.checkpoint, oppFloor: oppFloor, oppTeam: snap.ctrl };
      if (triggerA && triggerD && triggerB && triggerC) break;
    }

    // ── Check reclaim for each trigger ──
    function checkReclaim(trigInfo) {
      if (!trigInfo) return { reclaimed: false };
      for (var k = trigInfo.idx + 1; k < snaps.length; k++) {
        if (snaps[k].ctrl === buyTeam) {
          var holdCPs = k - trigInfo.idx;
          return { reclaimed: true, reclaimCP: snaps[k].checkpoint, holdCheckpoints: holdCPs };
        }
      }
      return { reclaimed: false };
    }

    // Track opponent run stats
    var oppRuns = 0;
    var longestOppRun = 0;
    var currentOppRun = 0;
    var peakOppFloor = 0;
    for (var j = buyIdx + 1; j < snaps.length; j++) {
      if (snaps[j].ctrl && snaps[j].ctrl !== buyTeam) {
        currentOppRun++;
        if (snaps[j].floor > peakOppFloor) peakOppFloor = snaps[j].floor;
      } else {
        if (currentOppRun > 0) { oppRuns++; if (currentOppRun > longestOppRun) longestOppRun = currentOppRun; }
        currentOppRun = 0;
      }
    }
    if (currentOppRun > 0) { oppRuns++; if (currentOppRun > longestOppRun) longestOppRun = currentOppRun; }

    results.push({
      gameId: gid, buyTeam: buyTeam, buyFloor: buyFloor, buyMargin: buyMargin,
      buyCP: buySnap.checkpoint, buyTeamWon: buyTeamWonFinal,
      finalMargin: finalM, homeAlias: meta.home_alias, awayAlias: meta.away_alias,
      oppRuns: oppRuns, longestOppRun: longestOppRun, peakOppFloor: peakOppFloor,
      triggerA: triggerA, triggerD: triggerD, triggerB: triggerB, triggerC: triggerC,
      reclaimA: checkReclaim(triggerA), reclaimD: checkReclaim(triggerD),
      reclaimB: checkReclaim(triggerB), reclaimC: checkReclaim(triggerC),
    });
  }

  // ── 5. Aggregate stats ──
  var triggerDefs = [
    { name: 'A_any_flip', key: 'triggerA', reclaim: 'reclaimA' },
    { name: 'D_opp_050', key: 'triggerD', reclaim: 'reclaimD' },
    { name: 'B_opp_060', key: 'triggerB', reclaim: 'reclaimB' },
    { name: 'C_opp_065', key: 'triggerC', reclaim: 'reclaimC' },
  ];

  function computeStats(subset, label) {
    var n = subset.length;
    if (n === 0) return null;
    var wins = subset.filter(function(r) { return r.buyTeamWon; }).length;
    var losses = n - wins;
    var winRate = +(wins / n * 100).toFixed(1);

    var tStats = [];
    for (var t of triggerDefs) {
      var exited = subset.filter(function(r) { return r[t.key] != null; });
      var notExited = subset.filter(function(r) { return r[t.key] == null; });
      var correctExit = exited.filter(function(r) { return !r.buyTeamWon; }).length;
      var falseExit = exited.filter(function(r) { return r.buyTeamWon; }).length;
      var falseReclaim = exited.filter(function(r) { return r.buyTeamWon && r[t.reclaim].reclaimed; }).length;
      var heldWon = notExited.filter(function(r) { return r.buyTeamWon; }).length;
      var heldLost = notExited.filter(function(r) { return !r.buyTeamWon; }).length;
      var precision = exited.length > 0 ? +(correctExit / exited.length * 100).toFixed(1) : null;
      var exitRate = +(exited.length / n * 100).toFixed(1);

      // FLIP BUY: opponent win rate from exit trigger point = precision (same thing)
      var flipRate = precision;

      // Win rate of held games (no exit fired)
      var heldWinRate = notExited.length > 0 ? +(heldWon / notExited.length * 100).toFixed(1) : null;

      tStats.push({
        trigger: t.name, exits: exited.length, exitRate: exitRate, total: n,
        correct: correctExit, false: falseExit, falseReclaim: falseReclaim,
        heldWon: heldWon, heldLost: heldLost, heldWinRate: heldWinRate,
        precision: precision, flipRate: flipRate,
      });
    }

    return {
      label: label, n: n, wins: wins, losses: losses, winRate: winRate,
      triggers: tStats,
    };
  }

  var overall = computeStats(results, 'ALL');

  // ── Buy floor buckets ──
  var byBuyFloor = {};
  for (var fb of ['0.55-0.64', '0.65-0.74', '0.75+']) {
    var sub = results.filter(function(r) {
      if (fb === '0.55-0.64') return r.buyFloor >= 0.55 && r.buyFloor < 0.65;
      if (fb === '0.65-0.74') return r.buyFloor >= 0.65 && r.buyFloor < 0.75;
      return r.buyFloor >= 0.75;
    });
    if (sub.length > 0) byBuyFloor[fb] = computeStats(sub, fb);
  }

  // ── Buy deficit buckets ──
  var byDeficit = {};
  for (var db of ['trail_1-4', 'trail_5-9', 'trail_10+']) {
    var sub = results.filter(function(r) {
      if (db === 'trail_1-4') return r.buyMargin >= 1 && r.buyMargin <= 4;
      if (db === 'trail_5-9') return r.buyMargin >= 5 && r.buyMargin <= 9;
      return r.buyMargin >= 10;
    });
    if (sub.length > 0) byDeficit[db] = computeStats(sub, db);
  }

  // ── Buy checkpoint buckets ──
  var byBuyCP = {};
  for (var cp of ['Q2', 'Q3', 'Q4']) {
    var sub = results.filter(function(r) { return r.buyCP.startsWith(cp); });
    if (sub.length > 0) byBuyCP[cp] = computeStats(sub, cp);
  }

  // ── Opponent run analysis (no flip vs 1+ flips) ──
  var noFlip = results.filter(function(r) { return r.oppRuns === 0; });
  var hasFlip = results.filter(function(r) { return r.oppRuns >= 1; });
  var flipProfile = {
    noFlip: computeStats(noFlip, 'no_opp_runs'),
    hasFlip: computeStats(hasFlip, '1_plus_opp_runs'),
    by_opp_peak_floor: {},
  };
  for (var pf of ['<0.50', '0.50-0.59', '0.60-0.69', '0.70+']) {
    var sub = hasFlip.filter(function(r) {
      if (pf === '<0.50') return r.peakOppFloor < 0.50;
      if (pf === '0.50-0.59') return r.peakOppFloor >= 0.50 && r.peakOppFloor < 0.60;
      if (pf === '0.60-0.69') return r.peakOppFloor >= 0.60 && r.peakOppFloor < 0.70;
      return r.peakOppFloor >= 0.70;
    });
    if (sub.length > 0) flipProfile.by_opp_peak_floor[pf] = computeStats(sub, pf);
  }

  // ── 6. Reclaim analysis ──
  var reclaimAnalysis = {};
  for (var t of triggerDefs) {
    var rGames = results.filter(function(r) { return r[t.key] != null && r[t.reclaim].reclaimed; });
    var holdCPs = rGames.map(function(r) { return r[t.reclaim].holdCheckpoints; }).sort(function(a, b) { return a - b; });
    var rWins = rGames.filter(function(r) { return r.buyTeamWon; }).length;
    reclaimAnalysis[t.name] = {
      count: rGames.length,
      medianHoldCPs: holdCPs.length > 0 ? holdCPs[Math.floor(holdCPs.length / 2)] : null,
      avgHoldCPs: holdCPs.length > 0 ? +(holdCPs.reduce(function(s, v) { return s + v; }, 0) / holdCPs.length).toFixed(1) : null,
      maxHoldCPs: holdCPs.length > 0 ? holdCPs[holdCPs.length - 1] : null,
      reclaimWinRate: rGames.length > 0 ? +(rWins / rGames.length * 100).toFixed(1) : null,
    };
  }

  // ── 7. False exit detail (top 20 by buy floor) ──
  var falseExits = [];
  for (var r of results) {
    if (!r.buyTeamWon) continue;
    for (var t of triggerDefs) {
      if (r[t.key]) {
        falseExits.push({
          trigger: t.name, gameId: r.gameId, buyTeam: r.buyTeam,
          homeAlias: r.homeAlias, awayAlias: r.awayAlias,
          buyFloor: r.buyFloor, buyMargin: r.buyMargin, buyCP: r.buyCP,
          exitCP: r[t.key].checkpoint, oppFloor: r[t.key].oppFloor,
          reclaimed: r[t.reclaim].reclaimed,
          holdCPs: r[t.reclaim].reclaimed ? r[t.reclaim].holdCheckpoints : null,
        });
      }
    }
  }
  falseExits.sort(function(a, b) { return b.buyFloor - a.buyFloor; });

  return {
    scope: closeOnly ? 'competitive_games_within_5_Q3_within_7_Q4' : 'full_season',
    totalGamesInDataset: allGameIds.length,
    totalGamesAfterFilter: gameIds.length,
    buyEligibleGames: results.length,
    checkpointResolution: '3-minute intervals (14 checkpoints per game)',
    overall: overall,
    byBuyFloor: byBuyFloor,
    byDeficit: byDeficit,
    byBuyCheckpoint: byBuyCP,
    flipProfile: flipProfile,
    reclaimAnalysis: reclaimAnalysis,
    falseExitDetail: falseExits.slice(0, 30),
    proposedSpec: {
      heavy_favorite: 'Trigger A (any flip)',
      favorite: 'Trigger A (any flip)',
      tossup: 'Trigger B (opp >= 0.60)',
      underdog: 'Trigger D (opp >= 0.50)',
      flipBuySignal: 'Trigger C (opp >= 0.65) in any lane',
    },
    elapsed_ms: Date.now() - t0,
  };
}


// ── HANDLER ─────────────────────────────────────────────────────────────────
// ── REPORT: FLIP VOLATILITY — team-level floor flip analysis ────────────────
async function reportFlipVolatility(sql) {
  // Pull all backtest snapshots with game date
  const rows = await sql`
    SELECT s.game_id, s.checkpoint, s.period, s.clock_sec,
           s.home_alias, s.away_alias,
           s.margin_at_snapshot,
           s.indicators->>'controlTeam' as ctrl_team,
           (s.indicators->>'score')::real as floor_score,
           s.ctrl_team_won,
           s.final_margin,
           bt.date as game_date
    FROM nba_snapshot_backtest s
    JOIN (SELECT DISTINCT bdl_game_id, date FROM nba_backtest) bt ON bt.bdl_game_id = s.game_id
    ORDER BY s.game_id, s.period ASC, s.clock_sec DESC
  `;

  // Group by game
  const gameMap = {};
  for (const r of rows) {
    if (!gameMap[r.game_id]) gameMap[r.game_id] = [];
    gameMap[r.game_id].push(r);
  }

  // Core analysis function — reusable across filters
  function analyzeFlips(games, label) {
    const teamFlips = {};
    const teamFloorWP = {}; // team -> {bucket -> {wins, total}}
    let totalGames = 0, totalFlips = 0;

    for (const [gid, snaps] of Object.entries(games)) {
      if (snaps.length < 4) continue;
      totalGames++;

      const home = snaps[0].home_alias;
      const away = snaps[0].away_alias;
      const fm = snaps[0].final_margin;
      const winner = fm > 0 ? home : fm < 0 ? away : null;

      let prevFloorTeam = null;
      const snapData = [];

      for (const s of snaps) {
        const ft = s.ctrl_team;
        const fs = s.floor_score || 0;
        const mg = s.margin_at_snapshot || 0;
        const signedFloor = ft === home ? fs : -fs;
        const mgScaled = mg / 16.0;
        const divergence = signedFloor - mgScaled;

        snapData.push({ period: s.period, ft, fs, signedFloor, mg, mgScaled, divergence });

        // Floor WP tracking: at this floor score, did the control team win?
        if (ft && fs >= 0.40) {
          const bucket = Math.floor(fs * 10) / 10; // 0.4, 0.5, 0.6, etc
          const won = ft === winner;
          if (!teamFloorWP[ft]) teamFloorWP[ft] = {};
          if (!teamFloorWP[ft][bucket]) teamFloorWP[ft][bucket] = { wins: 0, total: 0 };
          teamFloorWP[ft][bucket].total++;
          if (won) teamFloorWP[ft][bucket].wins++;
        }

        if (prevFloorTeam && ft && ft !== prevFloorTeam) {
          const idx = snapData.length - 1;
          const start = Math.max(0, idx - 10);
          const preFlip = snapData.slice(start, idx);

          if (preFlip.length >= 2) {
            const absDivs = preFlip.map(r => Math.abs(r.divergence));
            const peakDiv = Math.max(...absDivs);
            const flipWinnerWon = ft === winner;
            totalFlips++;

            for (const team of [prevFloorTeam, ft]) {
              if (!teamFlips[team]) teamFlips[team] = [];
              teamFlips[team].push({
                gained: team === ft, stuck: flipWinnerWon,
                peakDiv, period: s.period, margin: mg
              });
            }
          }
        }
        if (ft) prevFloorTeam = ft;
      }
    }

    // Compute team coefficients
    const teamCoeffs = {};
    for (const [team, flips] of Object.entries(teamFlips)) {
      const n = flips.length;
      if (n < 3) continue;
      const gained = flips.filter(f => f.gained);
      const lost = flips.filter(f => !f.gained);
      const gainedStick = gained.length ? Math.round(100 * gained.filter(f => f.stuck).length / gained.length) : null;
      const lostStick = lost.length ? Math.round(100 * lost.filter(f => f.stuck).length / lost.length) : null;
      const highDiv = flips.filter(f => f.peakDiv >= 0.80);
      const q4 = flips.filter(f => f.period === 4);
      const q4Gained = q4.filter(f => f.gained);

      teamCoeffs[team] = {
        totalFlips: n,
        stickRate: Math.round(100 * flips.filter(f => f.stuck).length / n),
        gained: { n: gained.length, stick: gainedStick },
        lost: { n: lost.length, stick: lostStick },
        grip: (gainedStick || 0) - (lostStick || 0),
        highDiv: { n: highDiv.length, stick: highDiv.length >= 3 ? Math.round(100 * highDiv.filter(f => f.stuck).length / highDiv.length) : null },
        q4: { n: q4.length, gainedStick: q4Gained.length >= 2 ? Math.round(100 * q4Gained.filter(f => f.stuck).length / q4Gained.length) : null },
      };
    }

    // Divergence buckets
    const allGained = Object.values(teamFlips).flat().filter(f => f.gained);
    const divBuckets = {};
    for (const [lo, hi] of [[0,0.3],[0.3,0.5],[0.5,0.7],[0.7,0.9],[0.9,1.1],[1.1,3.0]]) {
      const b = allGained.filter(f => f.peakDiv >= lo && f.peakDiv < hi);
      if (b.length >= 3) {
        divBuckets[`${lo.toFixed(1)}-${hi.toFixed(1)}`] = {
          n: b.length, stick: Math.round(100 * b.filter(f => f.stuck).length / b.length)
        };
      }
    }

    // Floor WP by team — win rate at each floor bucket
    const floorWP = {};
    for (const [team, buckets] of Object.entries(teamFloorWP)) {
      const teamBuckets = {};
      for (const [bucket, data] of Object.entries(buckets)) {
        if (data.total >= 5) {
          teamBuckets[bucket] = { wp: Math.round(100 * data.wins / data.total), n: data.total };
        }
      }
      if (Object.keys(teamBuckets).length >= 2) floorWP[team] = teamBuckets;
    }

    // Sort by grip
    const sorted = Object.entries(teamCoeffs).sort((a, b) => b[1].grip - a[1].grip);

    return {
      label, totalGames, totalFlips,
      popStick: totalFlips ? Math.round(100 * allGained.filter(f => f.stuck).length / allGained.length) : 0,
      divBuckets,
      teams: Object.fromEntries(sorted),
      floorWP,
    };
  }

  // Build filtered game sets
  const allGames = gameMap;
  const closeGames = {};
  const postASBGames = {};
  const closePostASB = {};

  for (const [gid, snaps] of Object.entries(gameMap)) {
    const fm = Math.abs(snaps[0].final_margin || 0);
    const dt = snaps[0].game_date;
    const isClose = fm <= 8;
    const isPostASB = dt && dt >= '2026-02-20';

    if (isClose) closeGames[gid] = snaps;
    if (isPostASB) postASBGames[gid] = snaps;
    if (isClose && isPostASB) closePostASB[gid] = snaps;
  }

  const full = analyzeFlips(allGames, 'full_season');
  const close = analyzeFlips(closeGames, 'close_games_8');
  const postASB = analyzeFlips(postASBGames, 'post_allstar');
  const closePost = analyzeFlips(closePostASB, 'close_post_allstar');

  return { full, close, postASB, closePostASB: closePost };
}

// ── POPULATE: FLOOR WP COEFFICIENTS — compute and save to DB ────────────────
async function populateFloorWP(sql) {
  const report = await reportFlipVolatility(sql);
  const closeTeams = report.close?.teams || {};
  const closeWP = report.close?.floorWP || {};
  const fullTeams = report.full?.teams || {};
  const fullWP = report.full?.floorWP || {};
  const postASBTeams = report.postASB?.teams || {};
  const postASBWP = report.postASB?.floorWP || {};

  // Classification: based on close-game floor WP at 0.7+ buckets
  function classify(team) {
    const wp = closeWP[team];
    if (!wp) return 'NEUTRAL';
    // Average win rate at 0.7, 0.8, 0.9 buckets (close games)
    const highBuckets = ['0.7', '0.8', '0.9'].map(b => wp[b]).filter(Boolean);
    if (highBuckets.length < 2) return 'NEUTRAL';
    const avgWP = highBuckets.reduce((s, b) => s + b.wp, 0) / highBuckets.length;
    if (avgWP >= 80) return 'ELITE';
    if (avgWP >= 70) return 'STRONG';
    if (avgWP >= 60) return 'NEUTRAL';
    if (avgWP >= 50) return 'WEAK';
    return 'BROKEN';
  }

  const allTeams = new Set([...Object.keys(closeTeams), ...Object.keys(fullTeams)]);
  let saved = 0;

  for (const team of allTeams) {
    const ct = closeTeams[team] || {};
    const ft = fullTeams[team] || {};
    const pt = postASBTeams[team] || {};
    const reliabilityClass = classify(team);

    await sql`
      INSERT INTO floor_wp_coefficients (team_alias, league, season, reliability_class, grip,
        floor_wp_json, close_floor_wp_json, post_asb_floor_wp_json,
        q4_gained_stick, total_flips, gained_stick, lost_stick, updated_at)
      VALUES (${team}, 'nba', '2025-26', ${reliabilityClass}, ${ct.grip || ft.grip || 0},
        ${JSON.stringify(fullWP[team] || {})}, ${JSON.stringify(closeWP[team] || {})}, ${JSON.stringify(postASBWP[team] || {})},
        ${ct.q4?.gainedStick ?? ft.q4?.gainedStick ?? null}, ${ft.totalFlips || 0},
        ${ct.gained?.stick ?? ft.gained?.stick ?? null}, ${ct.lost?.stick ?? ft.lost?.stick ?? null}, NOW())
      ON CONFLICT (team_alias, league, season) DO UPDATE SET
        reliability_class = EXCLUDED.reliability_class, grip = EXCLUDED.grip,
        floor_wp_json = EXCLUDED.floor_wp_json, close_floor_wp_json = EXCLUDED.close_floor_wp_json,
        post_asb_floor_wp_json = EXCLUDED.post_asb_floor_wp_json,
        q4_gained_stick = EXCLUDED.q4_gained_stick, total_flips = EXCLUDED.total_flips,
        gained_stick = EXCLUDED.gained_stick, lost_stick = EXCLUDED.lost_stick,
        updated_at = NOW()
    `;
    saved++;
  }

  return { saved, teams: [...allTeams].sort(), classifications: Object.fromEntries([...allTeams].sort().map(t => [t, classify(t)])) };
}

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
      case 'report_tier_journey': result = await reportTierJourney(sql, url); break;
      case 'report_position_open': result = await reportPositionOpen(sql, url); break;
      case 'report_production_replay': result = await reportProductionReplay(sql, url); break;
      case 'report_dual_tracking_sim': result = await reportDualTrackingSim(sql, url); break;
      case 'report_buy_journey': result = await reportBuyJourney(sql, url); break;
      case 'report_graduation_sim': result = await reportGraduationSim(sql, url); break;
      case 'report_buy_exit_sim': result = await reportBuyExitSim(sql, url); break;
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
      case 'report_flip_volatility': result = await reportFlipVolatility(sql); break;
      case 'populate_floor_wp': result = await populateFloorWP(sql); break;
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

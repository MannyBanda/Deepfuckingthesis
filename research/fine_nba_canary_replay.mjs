// fine_nba_canary_replay.mjs — FINE_NBA_ARENA_SPEC §1.4
// Replays the production MC canary → investigation → pattern state machine over the
// committed 30s fine states (research/2026-10-23_fine_nba_states.json.gz).
//
// Production fidelity by construction: the MC engine and the classifiers are SLICED
// FROM netlify/functions/poll-live-bdl.mjs AT RUNTIME by function name (not copied),
// so the replay cannot drift from production without this script failing to find them.
//
// Usage:  node research/fine_nba_canary_replay.mjs [--states path] [--out path] [--sims 1000] [--seed 20261023] [--limit N]
// Output: research/2026-10-23_fine_nba_canary_fires.json.gz — one row per investigation
//         + base_rates (leader-holds by period × 2-min bucket × leader-margin bucket)

import fs from 'fs';
import zlib from 'zlib';
import path from 'path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => { if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']); return acc; }, []));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const STATES = args.states || path.join(ROOT, 'research/2026-10-23_fine_nba_states.json.gz');
const OUT = args.out || path.join(ROOT, 'research/2026-10-23_fine_nba_canary_fires.json.gz');
const SIMS = parseInt(args.sims || '1000');            // production: 1000 (canary + investigation)
const SEED = parseInt(args.seed || '20261023');
const LIMIT = args.limit ? parseInt(args.limit) : Infinity;

// ── Slice production functions by name ───────────────────────────────────────
const PROD = fs.readFileSync(path.join(ROOT, 'netlify/functions/poll-live-bdl.mjs'), 'utf8');
function slice(name) {
  const i = PROD.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('production function not found: ' + name);
  const j = PROD.indexOf('\n}\n', i);
  return PROD.slice(i, j + 3);
}
const PROD_SRC = ['simulatePossessionMC', 'runMonteCarloSim', 'diffToRatesMC', 'estimateRemainingPossMC', 'classifyMCVerdict', 'classifyMCPattern'].map(slice).join('\n');
const prod = new Function('LEAGUES', PROD_SRC + '\nreturn { runMonteCarloSim, diffToRatesMC, estimateRemainingPossMC, classifyMCVerdict, classifyMCPattern };')({}); // LEAGUES={} → NBA 12/48 defaults
const { runMonteCarloSim, diffToRatesMC, estimateRemainingPossMC, classifyMCVerdict, classifyMCPattern } = prod;

// ── Production constants (poll-live-bdl canary block) ────────────────────────
const MC_ABS = 0.70, DIVERGENCE = 0.15, COMPRESS_MIN = 3, MARGIN_HISTORY = 10, WINDOW_POSS_TOTAL = 20, WINDOW_FGA_MIN = 5, POST_FGA_MIN = 8, MIN_REMAIN_MIN = 1.0;
const FG3_BASELINE = 0.36, REGRESSION_CAP = 0.60;   // production passes per-team baselines; 0.36 league default disclosed

function mulberry32(a) { return function() { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const estPoss = s => (s.fga || 0) + 0.44 * (s.fta || 0) - (s.oreb || 0) + (s.to || 0);
const remainMin = st => (4 - st.p) * 12 + st.c / 60;
const mBucket = m => m <= 3 ? '1-3' : m <= 8 ? '4-8' : m <= 15 ? '9-15' : '16+';
const lite = (st, side) => ({ ...st[side], poss: Math.round(estPoss(st[side]) * 10) / 10,
  pot: side === 'h' ? st.pd.hPOT : st.pd.aPOT, paint: side === 'h' ? st.pd.hPaint : st.pd.aPaint,
  tof: side === 'h' ? st.pd.hTOf : st.pd.aTOf, tou: side === 'h' ? st.pd.hTOu : st.pd.aTOu, biglead: side === 'h' ? st.pd.hBigLead : st.pd.aBigLead });

// ── Load states ──────────────────────────────────────────────────────────────
const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(STATES)).toString());
const games = data.games.filter(g => g.walk && g.walk.ok).slice(0, LIMIT);
console.error(`loaded ${data.games.length} games, ${games.length} pass walk integrity`);

const rows = [];
const base = {};
const counts = { games: 0, eligible_states: 0, canary_evals: 0, triggers: 0, pattern: {}, not_leading_at_trigger: 0, window_unavailable: 0 };
const savedRandom = Math.random;
const t0 = Date.now();

for (const g of games) {
  counts.games++;
  Math.random = mulberry32(SEED + Number(g.gid));
  const S = g.states;
  const alias = { h: g.home, a: g.away };
  const winnerSide = g.winner === g.home ? 'h' : g.winner === g.away ? 'a' : null;

  // base rates over all Q2+ states (scoreboard leader)
  for (const st of S) {
    if (st.p < 2 || st.p > 4) continue;
    const m = st.h.pts - st.a.pts; if (m === 0) continue;
    const key = `Q${st.p}|${Math.floor((720 - st.c) / 120) * 2}-${Math.floor((720 - st.c) / 120) * 2 + 2}min|${mBucket(Math.abs(m))}`;
    if (!base[key]) base[key] = { n: 0, leader_won: 0 };
    base[key].n++;
    if (winnerSide && ((m > 0) === (winnerSide === 'h'))) base[key].leader_won++;
  }

  let mc = { triggered: false, prior_investigations: 0 };
  let marginHist = [];
  // Terminal per CONTROL SIDE (deviation from production, disclosed): production holds one slot per game but its
  // tracked-team gate (not reproducible) prevents a non-positioned team's fire from consuming that slot. Without the
  // gate, per-game terminal let an untracked team's early CLEAN block the real one (ATL@ORL, PHI@NYK in the fidelity
  // check). Each side gets at most one terminal investigation; findings dedupe to one row per game.
  const terminal = { h: false, a: false };

  for (let i = 0; i < S.length && !(terminal.h && terminal.a); i++) {
    const st = S[i];
    if (st.p < 2 || st.p > 4) continue;
    if (!st.ctrl) continue;
    const ctrl = st.ctrl === 'home' ? 'h' : 'a', opp = ctrl === 'h' ? 'a' : 'h';
    const ctrlMargin = st[ctrl].pts - st[opp].pts;
    if (ctrlMargin < 0) continue;                 // production: _v2Margin >= 0
    if (remainMin(st) < MIN_REMAIN_MIN) continue;  // production: alertMinsLeft >= 1.0
    counts.eligible_states++;

    if (!mc.triggered) {
      if (terminal[ctrl]) continue;
      // ── CANARY (production: 10-poll margin history, 20-possession PBP window, abs/div trigger, compression gate) ──
      marginHist.push(ctrlMargin); if (marginHist.length > MARGIN_HISTORY) marginHist.shift();
      let j = i - 1;
      while (j >= 0 && (estPoss(S[i].h) - estPoss(S[j].h)) + (estPoss(S[i].a) - estPoss(S[j].a)) < WINDOW_POSS_TOTAL) j--;
      if (j < 0) { counts.window_unavailable++; continue; }
      const hR = diffToRatesMC(S[i].h, S[j].h, FG3_BASELINE, REGRESSION_CAP);
      const aR = diffToRatesMC(S[i].a, S[j].a, FG3_BASELINE, REGRESSION_CAP);
      if (!hR || !aR || hR._windowFGA < WINDOW_FGA_MIN || aR._windowFGA < WINDOW_FGA_MIN) { counts.window_unavailable++; continue; }
      const remain = estimateRemainingPossMC(S[i].h, S[i].a, st.p, st.c);
      if (remain <= 0) continue;
      counts.canary_evals++;
      const sim = runMonteCarloSim(hR, aR, st.h.pts, st.a.pts, remain, { simCount: SIMS, ctrlTeam: ctrl === 'h' ? 'home' : 'away' });
      const absFired = sim.winProb < MC_ABS;
      const divFired = st.floor != null && (st.floor - sim.winProb) > DIVERGENCE;
      const peak = Math.max(...marginHist);
      const compressed = (peak - ctrlMargin) >= COMPRESS_MIN;
      if ((absFired || divFired) && compressed) {
        if (ctrlMargin < 1) counts.not_leading_at_trigger++;   // margin 0 fires are kept but flagged (prereg population = ≥1)
        counts.triggers++;
        // tracked-team PROXY (production gate bwc_fired/buy_position is not reproducible): the control team showed a
        // BWC-eligible structural read — floor >= .65 with margin >= 2 — at some state in the 5 minutes before trigger.
        let trackedProxy = false;
        for (let k = Math.max(0, i - MARGIN_HISTORY); k < i; k++) { const sk = S[k]; if (!sk.ctrl) continue; const cs = sk.ctrl === 'home' ? 'h' : 'a'; if (cs === ctrl && sk.floor != null && sk.floor >= 0.65 && (sk[cs].pts - sk[cs === 'h' ? 'a' : 'h'].pts) >= 2) { trackedProxy = true; break; } }
        mc = { triggered: true, idx: i, ctrl, reason: absFired ? 'absolute' : 'divergence', mc: sim.winProb, peak, tracked_proxy: trackedProxy,
               floor: st.floor, margin: ctrlMargin, window_idx: j, window_poss: Math.round(hR._windowPoss + aR._windowPoss),
               trig: { h: lite(st, 'h'), a: lite(st, 'a') }, verdicts: [], path: [], last_verdict_fga: 0, pattern: null,
               prior_investigations: mc.prior_investigations || 0 };
      }
    } else {
      // ── INVESTIGATION (production: box diff vs trigger stats, postFGA≥8 gate, stale-data guard, verdict→pattern) ──
      const T = S[mc.idx];
      const postFGA = (st.h.fga - T.h.fga) + (st.a.fga - T.a.fga);
      if (postFGA >= POST_FGA_MIN) {
        if (postFGA > mc.last_verdict_fga) {
          const hR = diffToRatesMC(st.h, T.h, FG3_BASELINE, REGRESSION_CAP);
          const aR = diffToRatesMC(st.a, T.a, FG3_BASELINE, REGRESSION_CAP);
          if (hR && aR) {
            const remain = estimateRemainingPossMC(st.h, st.a, st.p, st.c);
            if (remain > 0) {
              const inv = runMonteCarloSim(hR, aR, st.h.pts, st.a.pts, remain, { simCount: SIMS, ctrlTeam: mc.ctrl === 'h' ? 'home' : 'away' });
              const v = classifyMCVerdict(inv.winProb);
              mc.verdicts.push(v); mc.last_verdict_fga = postFGA;
              mc.path.push({ idx: i, l: st.l, v, mc: inv.winProb, post_fga: postFGA, ctrl_margin: ctrlMargin, floor: st.floor, h: lite(st, 'h'), a: lite(st, 'a') });
              const pat = classifyMCPattern(mc.verdicts);
              if (pat) {
                mc.pattern = pat;
                counts.pattern[pat] = (counts.pattern[pat] || 0) + 1;
                const ctrlAlias = alias[mc.ctrl];
                rows.push({
                  gid: g.gid, date: g.date, home: g.home, away: g.away, ctrl: ctrlAlias, ctrl_side: mc.ctrl, trailer: alias[mc.ctrl === 'h' ? 'a' : 'h'],
                  prior_investigations: mc.prior_investigations, tracked_proxy: mc.tracked_proxy,
                  trigger: { idx: mc.idx, l: T.l, p: T.p, c: T.c, margin: mc.margin, peak: mc.peak, floor: mc.floor, mc: mc.mc, reason: mc.reason,
                             window_idx: mc.window_idx, window_poss: mc.window_poss, h: mc.trig.h, a: mc.trig.a },
                  verdicts: mc.verdicts.slice(), path: mc.path, pattern: pat,
                  push: { idx: i, l: st.l, p: st.p, c: st.c, ctrl_margin: ctrlMargin, floor: st.floor, mc: inv.winProb, h: lite(st, 'h'), a: lite(st, 'a'),
                          game_min_after_trigger: Math.round(((st.p - T.p) * 12 + (T.c - st.c) / 60) * 10) / 10 },
                  winner: g.winner, ctrl_won: g.winner === ctrlAlias, final_margin: g.final_margin,
                });
                if (pat === 'CLEAN' || pat === 'WAVE') { terminal[mc.ctrl] = true; mc = { triggered: false, prior_investigations: mc.prior_investigations + 1 }; } // terminal for this side; slot frees for the other side
                else mc = { triggered: false, prior_investigations: mc.prior_investigations + 1 }; // production: reset, re-trigger allowed
              }
            }
          }
        }
      } else if (postFGA > mc.last_verdict_fga) {
        mc.verdicts.push('INV'); mc.last_verdict_fga = postFGA;
        mc.path.push({ idx: i, l: st.l, v: 'INV', mc: null, post_fga: postFGA, ctrl_margin: ctrlMargin, floor: st.floor, h: lite(st, 'h'), a: lite(st, 'a') });
      }
    }
  }
  // an investigation still open at game end is recorded as UNCLASSIFIED (production would never have pushed)
  if (mc.triggered && !mc.pattern) {
    counts.pattern.UNCLASSIFIED = (counts.pattern.UNCLASSIFIED || 0) + 1;
    const T = S[mc.idx]; const ctrlAlias = alias[mc.ctrl];
    rows.push({ gid: g.gid, date: g.date, home: g.home, away: g.away, ctrl: ctrlAlias, ctrl_side: mc.ctrl, trailer: alias[mc.ctrl === 'h' ? 'a' : 'h'],
      prior_investigations: mc.prior_investigations, tracked_proxy: mc.tracked_proxy, trigger: { idx: mc.idx, l: T.l, p: T.p, c: T.c, margin: mc.margin, peak: mc.peak, floor: mc.floor, mc: mc.mc, reason: mc.reason, window_idx: mc.window_idx, window_poss: mc.window_poss, h: mc.trig.h, a: mc.trig.a },
      verdicts: mc.verdicts.slice(), path: mc.path, pattern: null, push: null, winner: g.winner, ctrl_won: g.winner === ctrlAlias, final_margin: g.final_margin });
  }
  if (counts.games % 100 === 0) console.error(`${counts.games} games, ${rows.length} investigations, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
Math.random = savedRandom;

const out = { generated: new Date().toISOString().slice(0, 10), spec: 'FINE_NBA_ARENA_SPEC.md §1.4', states: path.basename(STATES),
  config: { sims: SIMS, seed: SEED, seed_rule: 'mulberry32(seed + gid) per game', mc_abs: MC_ABS, divergence: DIVERGENCE, compress_min: COMPRESS_MIN, margin_history: MARGIN_HISTORY,
            window_poss_total: WINDOW_POSS_TOTAL, window_fga_min: WINDOW_FGA_MIN, post_fga_min: POST_FGA_MIN, min_remain_min: MIN_REMAIN_MIN, fg3_baseline: FG3_BASELINE, regression_cap: REGRESSION_CAP,
            production_functions_sliced: ['simulatePossessionMC', 'runMonteCarloSim', 'diffToRatesMC', 'estimateRemainingPossMC', 'classifyMCVerdict', 'classifyMCPattern'],
            deviations: ['terminal CLEAN/WAVE is per control SIDE, not per game (production single slot + tracked gate not reproducible); findings dedupe to one row per game'],
            not_reproduced: ['xgb_drop trigger (no XGB at fine grain)', 'tracked-team gate (bwc_fired/buy_position) — tracked_proxy flag = floor>=.65 & margin>=2 within 10 states before trigger', 'per-team 3PT baselines (0.36 used)'] },
  counts, elapsed_s: Math.round((Date.now() - t0) / 1000), base_rates: base, rows };
fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(out)));
console.error(JSON.stringify({ ...counts, rows: rows.length, elapsed_s: out.elapsed_s }));
console.error('wrote ' + OUT);

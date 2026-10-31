// 2026-10-31_mc_trailer_buy_replay.mjs — PREREG research/2026-10-31_mc_trailer_buy_PREREG.md §5 Instrument A
// Read-only replay over the committed fine NBA states (research/2026-10-23_fine_nba_states.json.gz):
// for every Q3+ state, compute the TRAILER-relative windowed Monte Carlo (20-possession box-diff window,
// FGA>=5 both sides, production MC sliced by name) and record the FIRST PERCEPTION per game at which the
// trailer's windowed MC >= 0.55 (primary) and >= 0.70 (secondary, ordering only), plus the next-state read
// (persistence, H2) and the margin×time fair proxy cell. Outcome fields ride the rows for Phase 1; Phase 0
// prints counts only. No production path touched. No DB.
//
// Usage: node research/2026-10-31_mc_trailer_buy_replay.mjs [--states path] [--out path] [--sims 1000] [--seed 20261031] [--limit N]
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => { if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']); return acc; }, []));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const STATES = args.states || path.join(ROOT, 'research/2026-10-23_fine_nba_states.json.gz');
const OUT = args.out || path.join(ROOT, 'research/2026-10-31_mc_trailer_buy_fires.json.gz');
const SIMS = parseInt(args.sims || '1000');
const SEED = parseInt(args.seed || '20261031');
const LIMIT = args.limit ? parseInt(args.limit) : Infinity;

// ── Slice production functions by name (byte-faithful: the replay cannot drift from production without failing here) ──
const PROD = fs.readFileSync(path.join(ROOT, 'netlify/functions/poll-live-bdl.mjs'), 'utf8');
function slice(name) {
  const i = PROD.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('production function not found: ' + name);
  const j = PROD.indexOf('\n}\n', i);
  return PROD.slice(i, j + 3);
}
const PROD_SRC = ['simulatePossessionMC', 'runMonteCarloSim', 'diffToRatesMC', 'estimateRemainingPossMC'].map(slice).join('\n');
const LEAGUES = { nba: { quarterMinutes: 12, gameMinutes: 48, periodCount: 4 } };
const prod = new Function('LEAGUES', PROD_SRC + '\nreturn { runMonteCarloSim, diffToRatesMC, estimateRemainingPossMC };')(LEAGUES);
const { runMonteCarloSim, diffToRatesMC, estimateRemainingPossMC } = prod;

// ── Prereg constants (§5, §6) ────────────────────────────────────────────────
const T_PRIMARY = 0.55, T_SECONDARY = 0.70;
const DEFICIT_MIN = 1, DEFICIT_MAX = 9;
const P_MIN = 3, Q4_MIN_CLOCK_SEC = 60;                   // production MIN_REMAIN_MIN = 1.0 (applied to Q4 states)
const WINDOW_POSS_TOTAL = 20, WINDOW_FGA_MIN = 5;         // production canary window
const FG3_BASELINE = 0.36, REGRESSION_CAP = 0.60;         // disclosed: league default, not per-team
const HALVES_SPLIT = '2026-01-14';                        // arena's established chronological split

function mulberry32(a) { return function() { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const estPoss = s => (s.fga || 0) + 0.44 * (s.fta || 0) - (s.oreb || 0) + (s.to || 0);
const mBucket = m => m <= 3 ? '1-3' : m <= 8 ? '4-8' : m <= 15 ? '9-15' : '16+';
const dBand = d => d <= 3 ? '1-3' : d <= 6 ? '4-6' : '7-9';
const proxyKey = st => `Q${st.p}|${Math.floor((720 - st.c) / 120) * 2}-${Math.floor((720 - st.c) / 120) * 2 + 2}min|${mBucket(Math.abs(st.h.pts - st.a.pts))}`;
const floorBand = f => f == null ? null : f < 0.60 ? '<.60' : f < 0.75 ? '.60-.75' : '>.75';

// ── Load states ──────────────────────────────────────────────────────────────
const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(STATES)).toString());
const games = data.games.filter(g => g.walk && g.walk.ok).slice(0, LIMIT);
console.error(`loaded ${data.games.length} games, ${games.length} pass walk integrity`);

// ── Base rates: leader-holds by period × 2-min bucket × margin bucket over all Q2+ states (identical to the Oct 23 replay) ──
const base = {};
for (const g of games) {
  const winnerSide = g.winner === g.home ? 'h' : g.winner === g.away ? 'a' : null;
  for (const st of g.states) {
    if (st.p < 2 || st.p > 4) continue;
    const m = st.h.pts - st.a.pts; if (m === 0) continue;
    const k = proxyKey(st);
    if (!base[k]) base[k] = { n: 0, leader_won: 0 };
    base[k].n++;
    if (winnerSide && ((m > 0) === (winnerSide === 'h'))) base[k].leader_won++;
  }
}

// ── Trailer-relative windowed MC at state i (null when window unavailable) ──
function trailerMC(S, i) {
  const st = S[i];
  const m = st.h.pts - st.a.pts; if (m === 0) return null;
  const trailer = m > 0 ? 'a' : 'h';
  let j = i - 1;
  while (j >= 0 && (estPoss(S[i].h) - estPoss(S[j].h)) + (estPoss(S[i].a) - estPoss(S[j].a)) < WINDOW_POSS_TOTAL) j--;
  if (j < 0) return { unavailable: 'window' };
  const hR = diffToRatesMC(S[i].h, S[j].h, FG3_BASELINE, REGRESSION_CAP);
  const aR = diffToRatesMC(S[i].a, S[j].a, FG3_BASELINE, REGRESSION_CAP);
  if (!hR || !aR || hR._windowFGA < WINDOW_FGA_MIN || aR._windowFGA < WINDOW_FGA_MIN) return { unavailable: 'fga' };
  const remain = estimateRemainingPossMC(S[i].h, S[i].a, st.p, st.c, 'nba');
  if (!(remain > 0)) return { unavailable: 'remain' };
  const sim = runMonteCarloSim(hR, aR, st.h.pts, st.a.pts, remain, { simCount: SIMS, ctrlTeam: trailer === 'h' ? 'home' : 'away' });
  return { trailer, deficit: Math.abs(m), mc: sim.winProb, window_idx: j, window_poss: Math.round(hR._windowPoss + aR._windowPoss), remain };
}

const rows = [];
const counts = { games: 0, q3plus_states: 0, eligible_states: 0, evals: 0, window_unavailable: 0, fga_unavailable: 0, first55: 0, first70: 0, games_no_eligible: 0 };
const savedRandom = Math.random;
const t0 = Date.now();

for (const g of games) {
  counts.games++;
  Math.random = mulberry32(SEED + Number(g.gid));
  const S = g.states;
  const alias = { h: g.home, a: g.away };
  let row55 = null, row70 = null, anyEligible = false;

  for (let i = 0; i < S.length; i++) {   // full scan (coverage counts are complete); first-perception rows are taken once
    const st = S[i];
    if (st.p < P_MIN || st.p > 4) continue;
    counts.q3plus_states++;
    if (st.p === 4 && st.c < Q4_MIN_CLOCK_SEC) continue;
    const m = st.h.pts - st.a.pts; const d = Math.abs(m);
    if (m === 0 || d < DEFICIT_MIN || d > DEFICIT_MAX) continue;
    counts.eligible_states++; anyEligible = true;
    const r = trailerMC(S, i);
    if (!r || r.unavailable) { if (r && r.unavailable === 'window') counts.window_unavailable++; else if (r && r.unavailable === 'fga') counts.fga_unavailable++; continue; }
    counts.evals++;
    const mkRow = (thr) => {
      // persistence: next state (30s later), same trailer still trailing, window available
      let persisted = null, next_mc = null;
      if (i + 1 < S.length) {
        const n = trailerMC(S, i + 1);
        if (n && !n.unavailable && n.trailer === r.trailer) { next_mc = n.mc; persisted = n.mc >= T_PRIMARY; }
      }
      const pk = proxyKey(st); const b = base[pk];
      const trailerAlias = alias[r.trailer];
      return {
        gid: g.gid, date: g.date, half: g.date < HALVES_SPLIT ? 'H1' : 'H2', home: g.home, away: g.away,
        threshold: thr, idx: i, l: st.l, p: st.p, c: st.c, mins_left: Math.round(((4 - st.p) * 12 + st.c / 60) * 10) / 10,
        trailer: trailerAlias, trailer_side: r.trailer, deficit: r.deficit, deficit_band: dBand(r.deficit),
        mc: Math.round(r.mc * 10000) / 10000, window_poss: r.window_poss, remain: r.remain,
        floor: st.floor, ctrl: st.ctrl, floor_is_trailer: st.ctrl != null && ((st.ctrl === 'home' ? 'h' : 'a') === r.trailer),
        ctrl_floor_band: (st.ctrl != null && ((st.ctrl === 'home' ? 'h' : 'a') !== r.trailer)) ? floorBand(st.floor) : null,
        next_mc: next_mc == null ? null : Math.round(next_mc * 10000) / 10000, persisted,
        proxy_key: pk, proxy_n: b ? b.n : 0, fair: b && b.n ? Math.round((1 - b.leader_won / b.n) * 10000) / 10000 : null,
        // outcome fields — present for Phase 1; Phase 0 reader never prints them
        winner: g.winner, trailer_won: g.winner === trailerAlias, final_margin: g.final_margin,
      };
    };
    if (!row55 && r.mc >= T_PRIMARY) { row55 = mkRow(T_PRIMARY); counts.first55++; }
    if (!row70 && r.mc >= T_SECONDARY) { row70 = mkRow(T_SECONDARY); counts.first70++; }
  }
  if (!anyEligible) counts.games_no_eligible++;
  if (row55) rows.push(row55);
  if (row70) rows.push(row70);
  if (counts.games % 100 === 0) console.error(`${counts.games} games, ${rows.length} rows, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
Math.random = savedRandom;

const out = { generated: new Date().toISOString().slice(0, 10), prereg: 'research/2026-10-31_mc_trailer_buy_PREREG.md', states: path.basename(STATES),
  config: { sims: SIMS, seed: SEED, seed_rule: 'mulberry32(seed + gid) per game', t_primary: T_PRIMARY, t_secondary: T_SECONDARY, deficit: [DEFICIT_MIN, DEFICIT_MAX],
            p_min: P_MIN, q4_min_clock_sec: Q4_MIN_CLOCK_SEC, window_poss_total: WINDOW_POSS_TOTAL, window_fga_min: WINDOW_FGA_MIN,
            fg3_baseline: FG3_BASELINE, regression_cap: REGRESSION_CAP, halves_split: HALVES_SPLIT,
            production_functions_sliced: ['simulatePossessionMC', 'runMonteCarloSim', 'diffToRatesMC', 'estimateRemainingPossMC'],
            deviations: ['box-diff 20-possession window (production mc_win_prob uses the PBP possession log)', 'league 0.36 3PT baseline (production per-team)', `${SIMS} sims (production mc_win_prob: 500)`] },
  counts, elapsed_s: Math.round((Date.now() - t0) / 1000), base_rates: base, rows };
fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(out)));
console.error(JSON.stringify({ ...counts, rows: rows.length, elapsed_s: out.elapsed_s }));
console.error('wrote ' + OUT);

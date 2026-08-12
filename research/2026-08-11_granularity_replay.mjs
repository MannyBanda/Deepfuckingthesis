// ════════════════════════════════════════════════════════════════════════════
// 2026-08-11 — INSTRUMENT-GRANULARITY REPLAY (2026 tape)
// Prereg: research/2026-08-11_granularity_replay_PREREG.md (recipe + bars fixed
// there BEFORE cutting). Downsamples the 2026 production tape to the arena's
// 2.5-min checkpoint grid and compares against native snapshot granularity —
// same games, same season, same recipe; the instrument is the only difference.
// Run: node research/2026-08-11_granularity_replay.mjs --pull   (cache tape)
//      node research/2026-08-11_granularity_replay.mjs          (analyze)
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync } from 'fs';

const BASE = 'https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api';
const AUTH = 'Basic ' + Buffer.from('manny:DFT2025!').toString('base64');
const api = async (qs) => {
  const r = await fetch(`${BASE}?${qs}`, { headers: { Authorization: AUTH } });
  if (!r.ok) throw new Error(`${qs.split('&')[0]} -> ${r.status}`);
  return r.json();
};
const CACHE = '/tmp/gran_cache.json';
const SEASON_START = '2026-05-01';
const QSEC = 600; // WNBA quarter

const clkSec = (c) => {
  if (c == null) return null; c = String(c);
  if (c.includes(':')) { const p = c.split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
  const n = parseFloat(c); return isNaN(n) ? null : n;
};
const elapsed = (period, clock) => {
  const cs = clkSec(clock); if (cs == null || !period) return null;
  return (period - 1) * QSEC + (QSEC - cs);
};

// ── PHASE 1: PULL (cached; slim fields only) ────────────────────────────────
async function pull() {
  const prev = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : null;
  const games = prev?.games || (await api('action=get_games&league=wnba')).games || [];
  const g26 = games.filter((g) => g.date >= SEASON_START && g.winner && String(g.id).includes('-'));
  const snaps = prev?.snaps || {};
  const Q = g26.filter((g) => !snaps[g.id]);
  let done = 0;
  console.log(`2026 finished games ${g26.length}, remaining to fetch ${Q.length}`);
  const save = () => writeFileSync(CACHE, JSON.stringify({ games, snaps }));
  async function worker() {
    while (Q.length) {
      const g = Q.shift();
      try {
        const h = (await api(`action=history&game_id=${g.id}`)).snapshots || [];
        snaps[g.id] = h.map((s) => {
          let hfga = null, afga = null;
          try {
            const rs = typeof s.raw_stats_json === 'string' ? JSON.parse(s.raw_stats_json) : s.raw_stats_json;
            hfga = rs?.home?.fga != null ? Number(rs.home.fga) : null;
            afga = rs?.away?.fga != null ? Number(rs.away.fga) : null;
          } catch (e) { /* leave null */ }
          return { ts: s.ts, period: Number(s.period), clock: s.clock,
            hp: s.home_pts != null ? Number(s.home_pts) : null,
            ap: s.away_pts != null ? Number(s.away_pts) : null, hfga, afga };
        });
      } catch (e) { snaps[g.id] = { err: e.message }; }
      if (++done % 25 === 0) { save(); console.log(`  history ${done} (checkpointed)`); }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  save();
  console.log(`cached -> ${CACHE} (${Object.keys(snaps).length} games)`);
}

// ── shared recipe pieces (prereg §Population) ───────────────────────────────
function loadTape() {
  const { games, snaps } = JSON.parse(readFileSync(CACHE, 'utf8'));
  const g26 = games.filter((g) => g.date >= SEASON_START && g.winner && String(g.id).includes('-'));
  const timeline = {};
  for (const g of g26) {
    for (const [al, won] of [[g.home_alias, g.winner === g.home_alias], [g.away_alias, g.winner === g.away_alias]]) {
      (timeline[al] = timeline[al] || []).push({ date: g.date, won });
    }
  }
  for (const al in timeline) timeline[al].sort((a, b) => a.date < b.date ? -1 : 1);
  const asOf = (al, date) => {
    const gs = (timeline[al] || []).filter((r) => r.date < date);
    return { gp: gs.length, wp: gs.length ? gs.filter((r) => r.won).length / gs.length : null };
  };
  return { g26, snaps, asOf };
}
// Evaluate one snapshot into a candidate state (or null) — the ONE recipe both arms use.
function evalSnap(s, g, asOf) {
  if (!s || s.period < 2 || s.period > 4) return null;
  if (!isFinite(s.hp) || !isFinite(s.ap)) return null;
  const m = Math.abs(s.hp - s.ap);
  if (m < 1 || m > 15) return null;
  if (!(s.hfga >= 12 && s.afga >= 12)) return null;
  const ldHome = s.hp > s.ap;
  const ldAl = ldHome ? g.home_alias : g.away_alias;
  const trAl = ldHome ? g.away_alias : g.home_alias;
  const rl = asOf(ldAl, g.date), rt = asOf(trAl, g.date);
  if (rl.gp < 10 || rt.gp < 10) return null;
  const el = elapsed(s.period, s.clock); if (el == null) return null;
  return { period: s.period, el, margin: m, leader: ldAl, trailer: trAl,
    gap: rt.wp - rl.wp, won: g.winner === trAl };
}
const bucketOfEl = (el) => {
  const p = Math.min(4, Math.floor(el / QSEC) + 1);
  const into = el - (p - 1) * QSEC;
  return `Q${p}-${into <= 300 ? 'early' : 'late'}`;
};
const conv = (a) => a.length ? Math.round(1000 * a.filter((x) => x.won).length / a.length) / 10 : null;
const fmt = (a) => a.length ? `${conv(a).toFixed(1)}% (n=${a.length})` : '- (n=0)';
const dcells = (states) => {
  const q = states.filter((x) => x.gap >= 0.15);
  return {
    d13: q.filter((x) => x.margin <= 3), d46: q.filter((x) => x.margin >= 4 && x.margin <= 6),
    d79: q.filter((x) => x.margin >= 7 && x.margin <= 9),
    d1012: q.filter((x) => x.margin >= 10 && x.margin <= 12), d1315: q.filter((x) => x.margin >= 13),
  };
};

// ── PHASE 2: ANALYZE ────────────────────────────────────────────────────────
function analyze() {
  const { g26, snaps, asOf } = loadTape();

  // H0 — inter-snapshot elapsed spacing (periods 2-4, positive deltas only)
  const gaps = [];
  for (const g of g26) {
    const h = snaps[g.id]; if (!Array.isArray(h)) continue;
    const els = h.filter((s) => s.period >= 2 && s.period <= 4)
      .map((s) => elapsed(s.period, s.clock)).filter((e) => e != null).sort((a, b) => a - b);
    for (let i = 1; i < els.length; i++) { const d = els[i] - els[i - 1]; if (d > 0 && d < 900) gaps.push(d); }
  }
  gaps.sort((a, b) => a - b);
  const pct = (p) => gaps[Math.floor(p * gaps.length)];
  const inBand = gaps.filter((d) => d >= 60 && d <= 90).length / gaps.length;
  console.log(`\n══ H0 — INSTRUMENT SPACING (n=${gaps.length} deltas, ${g26.length} games) ══`);
  console.log(`  median ${pct(0.5)}s | p25 ${pct(0.25)}s | p75 ${pct(0.75)}s | p90 ${pct(0.9)}s`);
  console.log(`  share in [60,90]s: ${(100 * inBand).toFixed(1)}% (memory said ~70% at ~75s)`);

  // FINE arm — first qualifying snapshot per (game, leader, bucket)
  // COARSE arm — arena marks snapped to nearest snapshot within ±75s
  const fine = [], coarse = [], episodesAll = [];
  const MARKS = [];
  for (let p = 2; p <= 4; p++) for (const off of [150, 300, 450, 600]) MARKS.push((p - 1) * QSEC + off);
  let coarseMarksHit = 0, coarseMarksTotal = 0;
  for (const g of g26) {
    const h = snaps[g.id]; if (!Array.isArray(h) || !h.length) continue;
    const walk = h.map((s) => ({ s, el: elapsed(s.period, s.clock) }))
      .filter((x) => x.el != null && x.s.period >= 2 && x.s.period <= 4)
      .sort((a, b) => a.el - b.el);
    // FINE
    const seenF = new Set();
    for (const { s } of walk) {
      const st = evalSnap(s, g, asOf); if (!st) continue;
      const key = `${st.leader}|${bucketOfEl(st.el)}`;
      if (seenF.has(key)) continue; seenF.add(key);
      fine.push({ ...st, gid: g.id, bucket: bucketOfEl(st.el) });
    }
    // COARSE
    const seenC = new Set();
    for (const mk of MARKS) {
      coarseMarksTotal++;
      let best = null, bd = 76;
      for (const w of walk) { const d = Math.abs(w.el - mk); if (d < bd) { bd = d; best = w; } }
      if (!best) continue;
      coarseMarksHit++;
      const st = evalSnap(best.s, g, asOf); if (!st) continue;
      const key = `${st.leader}|${bucketOfEl(mk)}`;
      if (seenC.has(key)) continue; seenC.add(key);
      coarse.push({ ...st, gid: g.id, bucket: bucketOfEl(mk) });
    }
    // EPISODES — contiguous in-band runs (same leader, gap>=.15, margin 1-9)
    let cur = null;
    const flush = () => { if (cur) { episodesAll.push(cur); cur = null; } };
    for (const { s, el } of walk) {
      const st = evalSnap(s, g, asOf);
      const inb = st && st.gap >= 0.15 && st.margin <= 9;
      if (inb && cur && cur.leader === st.leader) { cur.end = el; cur.n++; }
      else { flush(); if (inb) cur = { gid: g.id, leader: st.leader, start: el, end: el, n: 1, won: st.won, margin0: st.margin }; }
    }
    flush();
    // mark episodes seen by coarse
    const cIn = coarse.filter((c) => c.gid === g.id && c.gap >= 0.15 && c.margin <= 9);
    for (const ep of episodesAll.filter((e) => e.gid === g.id)) {
      ep.seen = cIn.some((c) => c.leader === ep.leader && c.el >= ep.start - 1 && c.el <= ep.end + 1);
      ep.dur = ep.end - ep.start;
    }
  }

  console.log(`\n══ REPRO GATE — FINE arm vs documented deficit26 ══`);
  const F = dcells(fine), C = dcells(coarse);
  console.log(`  d13 fine ${fmt(F.d13)}  target 65.4 (n=104)`);
  console.log(`  d46 fine ${fmt(F.d46)}  target 60.0 (n=55)`);
  console.log(`  d79 fine ${fmt(F.d79)}  target 42.9 (n=35)`);

  console.log(`\n══ H2 — CONVERSION BY INSTRUMENT (gap>=.15) ══`);
  console.log(`  cell |    FINE (75s tape)    |  COARSE (2.5-min grid)  | hist arena`);
  const hist = { d13: 60.8, d46: 39.4, d79: 32.0, d1012: 25.0, d1315: 14.5 };
  for (const k of ['d13', 'd46', 'd79', 'd1012', 'd1315']) {
    console.log(`  ${k.padEnd(5)}| ${fmt(F[k]).padEnd(21)} | ${fmt(C[k]).padEnd(23)} | ${hist[k]}`);
  }
  console.log(`  coarse marks with a snapshot within ±75s: ${coarseMarksHit}/${coarseMarksTotal} (${(100 * coarseMarksHit / coarseMarksTotal).toFixed(1)}%)`);
  console.log(`  states: fine ${fine.length}, coarse ${coarse.length}`);

  console.log(`\n══ H1/H3 — EPISODES (in-band: gap>=.15, margin 1-9) ══`);
  const eps = episodesAll;
  const missed = eps.filter((e) => !e.seen), seen = eps.filter((e) => e.seen);
  console.log(`  episodes ${eps.length} | seen by coarse ${seen.length} | MISSED ${missed.length} (${(100 * missed.length / eps.length).toFixed(1)}%)  [H1 bar: >10% = material]`);
  const durs = eps.map((e) => e.dur).sort((a, b) => a - b);
  console.log(`  episode duration: median ${durs[Math.floor(durs.length / 2)]}s | <120s: ${(100 * durs.filter((d) => d < 120).length / durs.length).toFixed(1)}% (PM's sub-2-min concern)`);
  const cw = (a) => a.length ? `${(100 * a.filter((e) => e.won).length / a.length).toFixed(1)}% (n=${a.length})` : '- (0)';
  console.log(`  trailer conversion — missed episodes: ${cw(missed)} | seen episodes: ${cw(seen)}   [H3: ordering only]`);
  const mShort = missed.filter((e) => e.dur < 120), sShort = seen.filter((e) => e.dur < 120);
  console.log(`  short (<120s) only — missed: ${cw(mShort)} | seen: ${cw(sShort)}`);

  writeFileSync('research/fixtures_gran_states.json', JSON.stringify({ fine, coarse, episodes: eps }, null, 0));
  console.log(`\nstates committed -> research/fixtures_gran_states.json (fine ${fine.length} + coarse ${coarse.length} + episodes ${eps.length})`);
}

if (process.argv.includes('--pull')) await pull();
else analyze();

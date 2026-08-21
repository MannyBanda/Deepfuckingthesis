// ════════════════════════════════════════════════════════════════════════════
// LATE-EXECUTION PHASE B+C (prereg 492e0fd + Amendment 1)
// Population: in-band (1-9), gap>=.15, leader POT>=6, pre-Q4.
// Split: trailer M1 (late TO/100poss) as-of, strict-<, >=10 GP, shrinkage k=10
// to the AS-OF league mean. Terciles per surface population; arena legs share
// pooled-arena boundaries. Unrankable trailers excluded and counted.
// Surfaces: fine arena (conversion, both-seasons) + 2026 tape (devig primary,
// realizable secondary per Aug 18 convention).
// Inputs: fixtures_fine_states.json.gz (committed), /tmp/hist_ck.json,
// /tmp/late_exec_substrate.json, /tmp/ee_cache.json (session caches;
// regenerable via the Phase A pipeline + ee --pull).
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';

const K = 10; // shrinkage pseudo-games (prereg-fixed)

// ── team-game late-TO rows (Phase A parsers, verbatim conventions) ──
const TG = [];
const H = JSON.parse(readFileSync('/tmp/hist_ck.json', 'utf8'));
for (const g of H) {
  const cps = (g.checkpoints || []).slice().sort((a, b) => a.gameSec - b.gameSec);
  const bound = {}; for (const c of cps) if (c.period >= 2 && c.period <= 4) bound[c.period] = c;
  if (Object.keys(bound).length < 3) continue;
  for (const [sk, team] of [['home', g.home], ['away', g.away]]) {
    const v = (p, f) => bound[p][sk][f];
    if ([2, 3, 4].some((p) => ['to', 'fga', 'fta', 'oreb'].some((f) => v(p, f) == null))) continue;
    const late = {}; for (const f of ['to', 'fga', 'fta', 'oreb']) late[f] = v(4, f) - v(2, f);
    const pL = late.fga + 0.44 * late.fta + late.to - late.oreb;
    if (pL <= 5) continue;
    TG.push({ season: g.season, date: g.date, team, toL: late.to, possL: pL });
  }
}
const S26 = JSON.parse(readFileSync('/tmp/late_exec_substrate.json', 'utf8'));
for (const r of S26) if (r.bounds >= 4 && r.qto.every((x) => x != null) && r.qposs.every((x) => x != null && x > 0))
  TG.push({ season: 2026, date: r.date, team: r.team, toL: r.qto[2] + r.qto[3], possL: r.qposs[2] + r.qposs[3] });
TG.sort((a, b) => a.date < b.date ? -1 : 1);

// as-of shrunk M1 for (team, date): strict-<, >=10 GP, league mean as-of same season
function m1AsOf(team, date, season) {
  const mine = TG.filter((t) => t.season === season && t.team === team && t.date < date);
  if (mine.length < 10) return null;
  const lg = TG.filter((t) => t.season === season && t.date < date);
  const lgRate = 100 * lg.reduce((a, t) => a + t.toL, 0) / lg.reduce((a, t) => a + t.possL, 0);
  const my = 100 * mine.reduce((a, t) => a + t.toL, 0) / mine.reduce((a, t) => a + t.possL, 0);
  return (mine.length * my + K * lgRate) / (mine.length + K);
}

// ── arena-side qualifying states ──
const A = JSON.parse(gunzipSync(readFileSync('research/fixtures_fine_states.json.gz')).toString());
const PRE_Q4 = new Set(['Q2-early', 'Q2-late', 'Q3-early', 'Q3-late']);
const arena = [];
let unrankA = 0;
for (const s of A) {
  if (!(s.margin >= 1 && s.margin <= 9 && s.gap >= 0.15 && (s.lpot || 0) >= 6 && PRE_Q4.has(s.tb))) continue;
  const m1 = m1AsOf(s.trailer, s.date, s.season);
  if (m1 == null) { unrankA++; continue; }
  arena.push({ season: s.season, gid: s.gid, m1, won: s.won, gap: s.gap });
}

// ── 2026-side qualifying states (ee_cache machinery, FADE population) ──
const { games, snaps, odds } = JSON.parse(readFileSync('/tmp/ee_cache.json', 'utf8'));
const QSEC = 600;
const clkSec = (c) => { if (c == null) return null; c = String(c); if (c.includes(':')) { const p = c.split(':'); return (+p[0]) * 60 + (+p[1] || 0); } const n = parseFloat(c); return isNaN(n) ? null : n; };
const el = (p, c) => { const cs = clkSec(c); if (cs == null || !p) return null; return (p - 1) * QSEC + (QSEC - cs); };
const impl = (ml) => ml == null || !isFinite(ml) ? null : (ml > 0 ? 100 / (ml + 100) : (-ml) / ((-ml) + 100));
const g26 = games.filter((g) => g.date >= '2026-05-01' && g.winner && String(g.id).includes('-'));
const tl = {};
for (const g of g26) for (const [a, w] of [[g.home_alias, g.winner === g.home_alias], [g.away_alias, g.winner === g.away_alias]]) (tl[a] = tl[a] || []).push({ date: g.date, won: w });
for (const a in tl) tl[a].sort((x, y) => x.date < y.date ? -1 : 1);
const asOfWp = (a, d) => { const gs = (tl[a] || []).filter((r) => r.date < d); return gs.length ? gs.filter((r) => r.won).length / gs.length : null; };

const tape = [];
let unrank26 = 0;
for (const g of g26) {
  const h = snaps[g.id]; if (!Array.isArray(h)) continue;
  const ot = Array.isArray(odds[g.id]) ? odds[g.id].filter((o) => o.hml != null && o.aml != null && o.ts) : [];
  const seen = new Set();
  const rows = h.map((s) => ({ ...s, e: el(s.period, s.clock) })).filter((s) => s.e != null && isFinite(s.hp) && isFinite(s.ap)).sort((a, b) => a.e - b.e);
  for (const s of rows) {
    if (s.period < 2 || s.period > 3) continue;                      // pre-Q4
    const m = Math.abs(s.hp - s.ap); if (m < 1 || m > 9) continue;
    if (!(s.h && s.a && s.h.fga >= 12 && s.a.fga >= 12)) continue;
    const ldHome = s.hp > s.ap;
    const ld = ldHome ? g.home_alias : g.away_alias, tr = ldHome ? g.away_alias : g.home_alias;
    const lwp = asOfWp(ld, g.date), twp = asOfWp(tr, g.date);
    if (lwp == null || twp == null || (twp - lwp) < 0.15) continue;
    const L = ldHome ? s.h : s.a;
    if ((Number(L.pot) || 0) < 6) continue;                           // leader POT gate
    const key = `${ld}|${Math.floor(s.e / 300)}`;
    if (seen.has(key)) continue; seen.add(key);
    const m1 = m1AsOf(tr, g.date, 2026);
    if (m1 == null) { unrank26++; continue; }
    let devig = null, raw = null;
    const st = Date.parse(s.ts); let best = null, bd = Infinity;
    for (const o of ot) { const d = Math.abs(Date.parse(o.ts) - st); if (d < bd) { bd = d; best = o; } }
    if (best && bd <= 240000) {
      const it = impl(tr === g.home_alias ? best.hml : best.aml), il = impl(tr === g.home_alias ? best.aml : best.hml);
      if (it != null && il != null && it + il > 0) { raw = it; devig = it / (it + il); }
    }
    tape.push({ gid: g.id, m1, won: g.winner === tr, gap: twp - lwp, devig, raw });
  }
}

// ── terciles + reporting ──
const terc = (pop) => { const v = pop.map((s) => s.m1).sort((a, b) => a - b); return [v[Math.floor(v.length / 3)], v[Math.floor(2 * v.length / 3)]]; };
const bucket = (s, [t1, t2]) => s.m1 <= t1 ? 'CLEAN' : s.m1 <= t2 ? 'MID' : 'SLOPPY';
const rpt = (rows, label, priced) => {
  const n = rows.length; if (!n) { console.log(`  ${label}: n=0`); return null; }
  const g = {}; for (const s of rows) g[s.gid] = g[s.gid] ?? s.won;
  const conv = 100 * rows.filter((s) => s.won).length / n;
  let extra = '';
  if (priced) {
    const j = rows.filter((s) => s.devig != null);
    if (j.length) {
      const jc = 100 * j.filter((s) => s.won).length / j.length;
      const dv = 100 * j.reduce((a, s) => a + s.devig, 0) / j.length;
      const rw = 100 * j.reduce((a, s) => a + s.raw, 0) / j.length;
      extra = ` | joined ${j.length} devig-edge ${(jc - dv >= 0 ? '+' : '')}${(jc - dv).toFixed(1)}pp realizable ${(jc - rw >= 0 ? '+' : '')}${(jc - rw).toFixed(1)}pp`;
    }
  }
  console.log(`  ${label.padEnd(9)} states ${String(n).padStart(3)} conv ${conv.toFixed(1).padStart(5)}% | games ${Object.keys(g).length}${extra}`);
  return conv;
};

console.log(`unrankable excluded: arena ${unrankA}, 2026 ${unrank26}`);
console.log(`\n== ARENA (2024+2025) — gap>=.15, leader POT>=6, pre-Q4, band 1-9 ==`);
const bA = terc(arena);
console.log(`tercile boundaries (shrunk M1): <=${bA[0].toFixed(2)} | <=${bA[1].toFixed(2)} (pooled-arena, shared by legs)`);
for (const seas of ['pooled', 2024, 2025]) {
  const pop = seas === 'pooled' ? arena : arena.filter((s) => s.season === seas);
  console.log(seas === 'pooled' ? 'POOLED:' : `${seas} leg:`);
  const c = {}; for (const t of ['CLEAN', 'MID', 'SLOPPY']) c[t] = rpt(pop.filter((s) => bucket(s, bA) === t), t, false);
  if (c.CLEAN != null && c.SLOPPY != null) console.log(`  CLEAN−SLOPPY: ${(c.CLEAN - c.SLOPPY).toFixed(1)}pp`);
}
console.log(`\n== 2026 TAPE — same cell, priced ==`);
const b26 = terc(tape);
console.log(`tercile boundaries: <=${b26[0].toFixed(2)} | <=${b26[1].toFixed(2)}`);
const c26 = {}; for (const t of ['CLEAN', 'MID', 'SLOPPY']) c26[t] = rpt(tape.filter((s) => bucket(s, b26) === t), t, true);
if (c26.CLEAN != null && c26.SLOPPY != null) console.log(`  CLEAN−SLOPPY: ${(c26.CLEAN - c26.SLOPPY).toFixed(1)}pp`);

console.log(`\n== PHASE C — incrementality within gap class (arena pooled) ==`);
for (const [lo, hi, lab] of [[0.15, 0.30, 'gap .15-.30'], [0.30, 9, 'gap .30+']]) {
  const pop = arena.filter((s) => s.gap >= lo && s.gap < hi);
  console.log(`${lab}:`);
  const c = {}; for (const t of ['CLEAN', 'MID', 'SLOPPY']) c[t] = rpt(pop.filter((s) => bucket(s, bA) === t), t, false);
  if (c.CLEAN != null && c.SLOPPY != null) console.log(`  CLEAN−SLOPPY: ${(c.CLEAN - c.SLOPPY).toFixed(1)}pp`);
}

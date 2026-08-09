// ════════════════════════════════════════════════════════════════════════════
// 2026-08-09 — STUDY 1: TEAM-RELATIVE eFG BANDS (pre-registered in chat, PM go)
// Question: does leader heat measured as (live eFG − own as-of season eFG)
// discriminate trailer conversion better than the absolute bands
// (cold <45 / warm 45–55 / hot >55)?
// Pre-registered delta cutpoints: cold ≤ −5 | neutral (−5,+5] | warm (+5,+12] | hot > +12
// Pre-registered success bar: delta hot-vs-neutral separation ≥ 8pp in powered
// cells (n≥80) on the operative population (gap ≥ +.15, pre-Q4), ordering holds OOS.
// H2 direct test: within absolute-hot states, high-baseline leaders hold better.
// Baselines: as-of-date season eFG from team_game_stats, shrunk toward league
// mean with K=6 pseudo-games (no lookahead). Z-variant: delta ÷ as-of game-level SD.
// OOS: temporal split at 2026-07-15 (derive before, validate after). NOTE: this
// deviates from the proposed 2024-25-derive plan — historical checkpoints lack
// box-line eFG at state time; deviation disclosed in findings.
// Run: node research/2026-08-09_relative_efg_bands.mjs  (needs /tmp/ftg_cache.json + /tmp/tgs_all.json)
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';

const { games, g26, snaps } = JSON.parse(readFileSync('/tmp/ftg_cache.json', 'utf8'));
const tgs = JSON.parse(readFileSync('/tmp/tgs_all.json', 'utf8')).team_game_stats;
const byId = Object.fromEntries(games.map((g) => [g.id, g]));

// ── as-of baselines from team_game_stats ────────────────────────────────────
const LG = 0.5175; // league mean eFG (computed from full 2026 tgs pull)
const K = 6;       // shrinkage pseudo-games
const tl = {};
for (const r of tgs) (tl[r.team_alias] = tl[r.team_alias] || []).push({ date: r.date, efg: Number(r.efg) });
for (const t in tl) tl[t].sort((a, b) => (a.date < b.date ? -1 : 1));
function baseline(team, date) {
  const gs = (tl[team] || []).filter((r) => r.date < date && isFinite(r.efg));
  const n = gs.length;
  if (n < 5) return { n, efg: null, sd: null };
  const mean = gs.reduce((s, r) => s + r.efg, 0) / n;
  const shrunk = (mean * n + LG * K) / (n + K);
  const sd = n >= 8 ? Math.sqrt(gs.reduce((s, r) => s + (r.efg - mean) ** 2, 0) / (n - 1)) : null;
  return { n, efg: shrunk * 100, sd: sd == null ? null : sd * 100 };
}

// ── as-of win records for gap (same recipe as prior studies) ────────────────
const wtl = {};
for (const g of games) {
  if (g.date < '2026-05-01' || !g.winner || !String(g.id).includes('-')) continue;
  for (const [al, won] of [[g.home_alias, g.winner === g.home_alias], [g.away_alias, g.winner === g.away_alias]])
    (wtl[al] = wtl[al] || []).push({ date: g.date, won });
}
for (const al in wtl) wtl[al].sort((a, b) => (a.date < b.date ? -1 : 1));
const asOfWp = (al, date) => {
  const gs = (wtl[al] || []).filter((r) => r.date < date);
  return { gp: gs.length, wp: gs.length ? gs.filter((r) => r.won).length / gs.length : null };
};

const clockMin = (c) => { const m = String(c || '').match(/(\d+):(\d+)/); return m ? Number(m[1]) + Number(m[2]) / 60 : null; };
const bucketOf = (p, c) => { const m = clockMin(c); if (m == null || p < 2 || p > 4) return null; return `Q${p}-${m >= 5 ? 'early' : 'late'}`; };

// ── state extraction (mirrors takeaway-decay recipe) ────────────────────────
const states = [];
for (const gid of g26) {
  const g = byId[gid], h = snaps[gid];
  if (!Array.isArray(h) || !h.length) continue;
  h.sort((a, b) => (String(a.ts) < String(b.ts) ? -1 : 1));
  const seen = {};
  for (const s of h) {
    const bk = bucketOf(Number(s.period), s.clock);
    if (!bk) continue;
    const hp = Number(s.home_pts), ap = Number(s.away_pts);
    if (!isFinite(hp) || !isFinite(ap)) continue;
    const margin = Math.abs(hp - ap);
    if (margin < 1 || margin > 9) continue;
    const ldHome = hp > ap;
    const trAl = ldHome ? g.away_alias : g.home_alias, ldAl = ldHome ? g.home_alias : g.away_alias;
    const key = trAl + '|' + bk;
    if (seen[key]) continue;
    const rs = typeof s.raw === 'string' ? JSON.parse(s.raw) : s.raw;
    if (!rs || !rs.home || !rs.away) continue;
    const Lb = ldHome ? rs.home : rs.away;
    const fgm = Number(Lb.fgm), fga = Number(Lb.fga), fg3m = Number(Lb.fg3m) || 0;
    if (!isFinite(fgm) || !isFinite(fga) || fga < 12) continue;
    const liveEfg = ((fgm + 0.5 * fg3m) / fga) * 100;
    const rl = asOfWp(ldAl, g.date), rt = asOfWp(trAl, g.date);
    if (rl.gp < 10 || rt.gp < 10) { seen[key] = true; continue; }
    const bl = baseline(ldAl, g.date);
    if (bl.efg == null) { seen[key] = true; continue; }
    seen[key] = true;
    states.push({
      game_id: gid, date: g.date, bucket: bk, deficit: margin, trailer: trAl, leader: ldAl,
      gap: +(rt.wp - rl.wp).toFixed(3), liveEfg: +liveEfg.toFixed(1),
      blEfg: +bl.efg.toFixed(1), blSd: bl.sd == null ? null : +bl.sd.toFixed(1), blN: bl.n,
      delta: +(liveEfg - bl.efg).toFixed(1),
      z: bl.sd ? +((liveEfg - bl.efg) / bl.sd).toFixed(2) : null,
      trailer_won: g.winner === trAl,
    });
  }
}
console.log(`states ${states.length} across ${new Set(states.map((s) => s.game_id)).size} games`);

// ── band classifiers ────────────────────────────────────────────────────────
const absBand = (e) => (e < 45 ? 'cold' : e <= 55 ? 'warm' : 'hot');
const dltBand = (d) => (d <= -5 ? 'cold' : d <= 5 ? 'neutral' : d <= 12 ? 'warm' : 'hot');
const zBand = (z) => (z == null ? null : z <= -0.5 ? 'cold' : z <= 0.5 ? 'neutral' : z <= 1.5 ? 'warm' : 'hot');
const pow = (n) => (n >= 200 ? 'HIGH' : n >= 80 ? 'MED' : 'LOW');
const pct = (a) => (a.length ? ((100 * a.filter((s) => s.trailer_won).length) / a.length).toFixed(1) : '—');

function table(pop, label, fn, bands) {
  console.log(`\n── ${label} ──`);
  for (const b of bands) {
    const cell = pop.filter((s) => fn(s) === b);
    console.log(`  ${b.padEnd(8)} n=${String(cell.length).padStart(4)} [${pow(cell.length)}]  trailer-conv ${pct(cell)}%`);
  }
}

function runCut(pop, tag) {
  console.log(`\n═══ ${tag} (n=${pop.length}) ═══`);
  table(pop, 'ABSOLUTE bands (live eFG)', (s) => absBand(s.liveEfg), ['cold', 'warm', 'hot']);
  table(pop, 'DELTA bands (live − own baseline)', (s) => dltBand(s.delta), ['cold', 'neutral', 'warm', 'hot']);
  table(pop.filter((s) => s.z != null), 'Z bands (delta ÷ own SD)', (s) => zBand(s.z), ['cold', 'neutral', 'warm', 'hot']);
  // H2 direct: within absolute-hot, split leader baseline at league median
  const med = 51.75;
  const hot = pop.filter((s) => absBand(s.liveEfg) === 'hot');
  const hi = hot.filter((s) => s.blEfg >= med), lo = hot.filter((s) => s.blEfg < med);
  console.log(`\n── H2: within ABSOLUTE-HOT (n=${hot.length}) ──`);
  console.log(`  high-baseline leaders (≥${med}) n=${hi.length} [${pow(hi.length)}]  trailer-conv ${pct(hi)}%`);
  console.log(`  low-baseline leaders  (<${med}) n=${lo.length} [${pow(lo.length)}]  trailer-conv ${pct(lo)}%`);
}

// ── populations ─────────────────────────────────────────────────────────────
const preQ4 = states.filter((s) => s.bucket.startsWith('Q2') || s.bucket.startsWith('Q3'));
const op = preQ4.filter((s) => s.gap >= 0.15);          // operative population
const opAll = states.filter((s) => s.gap >= 0.15);
runCut(op, 'OPERATIVE: gap ≥ +.15, pre-Q4');
runCut(preQ4.filter((s) => s.gap < 0.15), 'CONTROL: gap < +.15, pre-Q4');
runCut(opAll.filter((s) => s.bucket.startsWith('Q4')), 'Q4 (operative gap, reference only)');

// ── OOS temporal split on the operative population ──────────────────────────
const SPLIT = '2026-07-15';
for (const [tag, popn] of [[`DERIVE < ${SPLIT}`, op.filter((s) => s.date < SPLIT)], [`VALIDATE ≥ ${SPLIT}`, op.filter((s) => s.date >= SPLIT)]]) {
  console.log(`\n═══ OOS ${tag} (n=${popn.length}) ═══`);
  table(popn, 'DELTA bands', (s) => dltBand(s.delta), ['cold', 'neutral', 'warm', 'hot']);
}

// persist states for follow-ups
import { writeFileSync } from 'fs';
writeFileSync('/tmp/study1_states.json', JSON.stringify(states));
console.log('\nstates saved -> /tmp/study1_states.json');

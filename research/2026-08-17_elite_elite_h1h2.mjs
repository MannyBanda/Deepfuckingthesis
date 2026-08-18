// ════════════════════════════════════════════════════════════════════════════
// 2026-08-17 — ELITE-ELITE H1/H2: 2026 price-joined surface
// Prereg: 2026-08-15_elite_elite_PREREG.md (6ef8bd1) + AMENDMENT 1 (cc1fce6).
// Population (prereg): both teams win% >= .550 as-of the state date (strict <),
// each >= 12 GP, trailer deficit 1-9, full-game 2026 window.
// SELECTION MACHINERY is byte-faithful to 2026-08-13_fine26_extraction.mjs
// (period 2-4, both fga>=12, first-perception dedup per game x leader x bucket);
// only the POPULATION FILTER changes (>=.550 both sides, gp>=12, margin<=9).
// Price join: nearest odds_history ML pair within 240s of the snapshot ts,
// de-vig by normalizing the two implieds. Unjoined states DROP from H1/H2.
// Run: node research/2026-08-17_elite_elite_h1h2.mjs --pull   (cache tape)
//      node research/2026-08-17_elite_elite_h1h2.mjs          (analyze)
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { gzipSync } from 'zlib';

const BASE = 'https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api';
const AUTH = 'Basic ' + Buffer.from('manny:DFT2025!').toString('base64');
const api = async (qs) => {
  const r = await fetch(`${BASE}?${qs}`, { headers: { Authorization: AUTH } });
  if (!r.ok) throw new Error(`${qs.split('&')[0]} -> ${r.status}`);
  return r.json();
};
const CACHE = '/tmp/ee_cache.json';
const SEASON_START = '2026-05-01';
const QSEC = 600;
const JOIN_MAX_S = 240;           // <=4 min, FUEL-map convention

const clkSec = (c) => { if (c == null) return null; c = String(c); if (c.includes(':')) { const p = c.split(':'); return (+p[0]) * 60 + (+p[1] || 0); } const n = parseFloat(c); return isNaN(n) ? null : n; };
const elapsed = (period, clock) => { const cs = clkSec(clock); if (cs == null || !period) return null; return (period - 1) * QSEC + (QSEC - cs); };
const bucketOfEl = (el) => { const p = Math.min(4, Math.floor(el / QSEC) + 1); const into = el - (p - 1) * QSEC; return `Q${p}-${into <= 300 ? 'early' : 'late'}`; };

// verbatim from poll-live-bdl.mjs L5206 @ a3f885a
const EFG_BANDS = { 1: [54, 61], 2: [56, 63], 3: [58, 66], 4: [60, 69] };
const efgTier = (efg, period) => { if (efg == null || isNaN(efg)) return 'na'; const b = EFG_BANDS[period] || EFG_BANDS[4]; if (efg <= b[0]) return 'green'; if (efg <= b[1]) return 'orange'; return 'red'; };

// American odds -> implied probability (raw, with juice)
const impl = (ml) => { if (ml == null || !isFinite(ml)) return null; return ml > 0 ? 100 / (ml + 100) : (-ml) / ((-ml) + 100); };

// ── PULL ────────────────────────────────────────────────────────────────────
async function pull() {
  const prev = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : null;
  const games = prev?.games || (await api('action=get_games&league=wnba')).games || [];
  const g26 = games.filter((g) => g.date >= SEASON_START && g.winner && String(g.id).includes('-'));
  const snaps = prev?.snaps || {};
  const odds = prev?.odds || {};
  const Q = g26.filter((g) => !snaps[g.id] || !odds[g.id]);
  let done = 0;
  console.log(`2026 finished games ${g26.length}, remaining to fetch ${Q.length}`);
  const save = () => writeFileSync(CACHE, JSON.stringify({ games, snaps, odds }));
  const num = (x) => x == null ? null : Number(x);
  const side = (o) => o ? { fga: num(o.fga), fgm: num(o.fgm), f3m: num(o.fg3m), f3a: num(o.fg3a), pot: num(o.pot) } : null;
  async function worker() {
    while (Q.length) {
      const g = Q.shift();
      if (!snaps[g.id]) {
        try {
          const h = (await api(`action=history&game_id=${g.id}`)).snapshots || [];
          snaps[g.id] = h.map((s) => {
            let hs = null, as = null;
            try { const rs = typeof s.raw_stats_json === 'string' ? JSON.parse(s.raw_stats_json) : s.raw_stats_json; hs = side(rs?.home); as = side(rs?.away); } catch (e) { /* null */ }
            return { ts: s.ts, period: Number(s.period), clock: s.clock,
              hp: s.home_pts != null ? Number(s.home_pts) : null,
              ap: s.away_pts != null ? Number(s.away_pts) : null, h: hs, a: as };
          });
        } catch (e) { snaps[g.id] = { err: e.message }; }
      }
      if (!odds[g.id]) {
        try {
          const o = (await api(`action=get_odds&league=wnba&game_id=${g.id}`)).odds || [];
          odds[g.id] = o.map((r) => ({ ts: r.ts, hml: r.home_ml != null ? Number(r.home_ml) : null, aml: r.away_ml != null ? Number(r.away_ml) : null }));
        } catch (e) { odds[g.id] = { err: e.message }; }
      }
      if (++done % 25 === 0) { save(); console.log(`  fetched ${done} (checkpointed)`); }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  save();
  console.log(`cached -> ${CACHE} (${Object.keys(snaps).length} snap games, ${Object.keys(odds).length} odds games)`);
}

// ── BUILD ───────────────────────────────────────────────────────────────────
function build() {
  const { games, snaps, odds } = JSON.parse(readFileSync(CACHE, 'utf8'));
  const g26 = games.filter((g) => g.date >= SEASON_START && g.winner && String(g.id).includes('-'));
  const timeline = {};
  for (const g of g26) for (const [al, won] of [[g.home_alias, g.winner === g.home_alias], [g.away_alias, g.winner === g.away_alias]]) (timeline[al] = timeline[al] || []).push({ date: g.date, won });
  for (const al in timeline) timeline[al].sort((a, b) => a.date < b.date ? -1 : 1);
  const asOf = (al, date) => { const gs = (timeline[al] || []).filter((r) => r.date < date); return { gp: gs.length, wp: gs.length ? gs.filter((r) => r.won).length / gs.length : null }; };

  const states = [];
  const diag = { games: 0, cand: 0, joined: 0, unjoined: 0, noOddsTape: 0 };
  for (const g of g26) {
    const h = snaps[g.id]; if (!Array.isArray(h)) continue;
    const otape = Array.isArray(odds[g.id]) ? odds[g.id].filter((o) => o.hml != null && o.aml != null && o.ts) : [];
    diag.games++;
    const seen = new Set();
    const rows = h.map((s) => ({ ...s, el: elapsed(s.period, s.clock) })).filter((s) => s.el != null).sort((x, y) => x.el - y.el);
    for (const s of rows) {
      if (s.period < 2 || s.period > 4) continue;
      if (!isFinite(s.hp) || !isFinite(s.ap)) continue;
      const m = Math.abs(s.hp - s.ap);
      if (m < 1 || m > 9) continue;                                    // prereg band
      if (!(s.h && s.a && s.h.fga >= 12 && s.a.fga >= 12)) continue;
      const ldHome = s.hp > s.ap;
      const ldAl = ldHome ? g.home_alias : g.away_alias, trAl = ldHome ? g.away_alias : g.home_alias;
      const rl = asOf(ldAl, g.date), rt = asOf(trAl, g.date);
      if (rl.gp < 12 || rt.gp < 12) continue;                          // prereg >=12 GP
      if (!(rl.wp >= 0.550 && rt.wp >= 0.550)) continue;               // prereg elite-elite
      const key = `${ldAl}|${bucketOfEl(s.el)}`;
      if (seen.has(key)) continue; seen.add(key);
      diag.cand++;
      const L = ldHome ? s.h : s.a;
      const lefg = L.fga > 0 ? ((L.fgm + 0.5 * (L.f3m || 0)) / L.fga) * 100 : null;
      const l3 = L.f3a > 0 ? (L.f3m / L.f3a) * 100 : 0;
      const lband = efgTier(lefg, s.period);
      const earned = !(lband === 'red' || l3 >= 40 || (L.pot || 0) >= 6);   // fine_arena_states.mjs L69

      // ── price join: nearest ML pair within JOIN_MAX_S of this snapshot ts
      let jml = null, jlat = null, devig = null, trRaw = null;
      if (!otape.length) diag.noOddsTape++;
      else {
        const st = Date.parse(s.ts);
        let best = null, bestD = Infinity;
        for (const o of otape) { const d = Math.abs(Date.parse(o.ts) - st); if (d < bestD) { bestD = d; best = o; } }
        if (best && bestD <= JOIN_MAX_S * 1000) {
          const trML = (trAl === g.home_alias) ? best.hml : best.aml;
          const ldML = (trAl === g.home_alias) ? best.aml : best.hml;
          const it = impl(trML), il = impl(ldML);
          if (it != null && il != null && (it + il) > 0) {
            jml = trML; jlat = Math.round(bestD / 1000); trRaw = +it.toFixed(4);
            devig = +(it / (it + il)).toFixed(4);
          }
        }
      }
      if (devig != null) diag.joined++; else diag.unjoined++;

      states.push({ gid: g.id, date: g.date, period: s.period, el: s.el, bucket: bucketOfEl(s.el),
        margin: m, leader: ldAl, trailer: trAl, lwp: rl.wp, twp: rt.wp, lgp: rl.gp, tgp: rt.gp,
        gap: +(rt.wp - rl.wp).toFixed(6), lefg: lefg == null ? null : +lefg.toFixed(2), lband, l3: +l3.toFixed(1),
        lpot: L.pot || 0, earned, fuel_src: 'arena_reconstruction',
        trailer_ml: jml, join_lat_s: jlat, trailer_impl_raw: trRaw, devig,
        won: g.winner === trAl });
    }
  }
  return { states, diag };
}

// ── ANALYZE ─────────────────────────────────────────────────────────────────
const power = (n) => n >= 200 ? 'HIGH' : n >= 80 ? 'MED' : 'LOW';
function cell(rows, label) {
  const n = rows.length;
  if (!n) return `${label.padEnd(26)} n=0`;
  const w = rows.filter((s) => s.won).length;
  const conv = 100 * w / n;
  const g = {}; for (const s of rows) g[s.gid] = g[s.gid] ?? s.won;
  const gn = Object.keys(g).length, gw = Object.values(g).filter(Boolean).length;
  const jr = rows.filter((s) => s.devig != null);
  const mk = jr.length ? 100 * jr.reduce((a, s) => a + s.devig, 0) / jr.length : null;
  const jc = jr.length ? 100 * jr.filter((s) => s.won).length / jr.length : null;
  const edge = mk != null ? jc - mk : null;
  return `${label.padEnd(26)} states n=${String(n).padStart(3)} conv=${conv.toFixed(1).padStart(5)}% | games ${String(gn).padStart(2)} ${(100 * gw / gn).toFixed(1).padStart(5)}% | joined ${String(jr.length).padStart(3)} conv=${jc == null ? '  —  ' : jc.toFixed(1).padStart(5)}% mkt=${mk == null ? '  —  ' : mk.toFixed(1).padStart(5)}% edge=${edge == null ? '  —  ' : ((edge > 0 ? '+' : '') + edge.toFixed(1)).padStart(6)}pp | ${power(jr.length)}`;
}

function analyze() {
  const { states, diag } = build();
  const S = states;
  console.log(`\n=== ELITE-ELITE 2026 SURFACE ===`);
  console.log(`games scanned ${diag.games} | candidate states ${diag.cand} | joined ${diag.joined} | unjoined ${diag.unjoined} | games w/o odds tape ${diag.noOddsTape}`);
  console.log(`JOIN RATE: ${(100 * diag.joined / Math.max(diag.cand, 1)).toFixed(1)}%`);
  const J = S.filter((s) => s.devig != null);
  if (J.length) {
    const lats = J.map((s) => s.join_lat_s).sort((a, b) => a - b);
    console.log(`join latency: median ${lats[Math.floor(lats.length / 2)]}s | p90 ${lats[Math.floor(lats.length * 0.9)]}s | max ${lats[lats.length - 1]}s`);
  }
  console.log(`unique games in population: ${new Set(S.map((s) => s.gid)).size}`);

  console.log(`\n── H1: gap ordering vs de-vig market (BAR: gap>=.10 beats gap<0 by >=10pp AND positive edge; n>=40 joined) ──`);
  console.log(cell(S.filter((s) => s.gap >= 0.10), 'gap >= .10  [BAR CELL]'));
  console.log(cell(S.filter((s) => s.gap > 0 && s.gap < 0.10), 'gap 0 to .10'));
  console.log(cell(S.filter((s) => s.gap > 0), 'gap > 0  [A1.1]'));
  console.log(cell(S.filter((s) => s.gap < 0), 'gap < 0'));

  console.log(`\n── A1.2 descriptive staircase (ORDERING ONLY — no bars attach) ──`);
  for (const t of [0.05, 0.10, 0.15, 0.20, 0.25, 0.30]) console.log(cell(S.filter((s) => s.gap >= t), `gap >= ${t.toFixed(2)}`));

  console.log(`\n── H2: fuel inversion within gap>0 (BAR: EARNED > TRANSIENT AND earned beats market by >=5pp; n>=25/cell) ──`);
  const pos = S.filter((s) => s.gap > 0);
  console.log(cell(pos.filter((s) => s.earned), 'EARNED lead'));
  console.log(cell(pos.filter((s) => !s.earned), 'TRANSIENT lead'));
  console.log(`\n  secondary proxy (reported separately, never pooled): red-band leader eFG`);
  console.log(cell(pos.filter((s) => s.lband === 'red'), '  red-band leader'));
  console.log(cell(pos.filter((s) => s.lband !== 'red'), '  non-red leader'));

  console.log(`\n── context: full population by deficit (descriptive) ──`);
  console.log(cell(S.filter((s) => s.margin <= 3), 'deficit 1-3'));
  console.log(cell(S.filter((s) => s.margin >= 4 && s.margin <= 6), 'deficit 4-6'));
  console.log(cell(S.filter((s) => s.margin >= 7 && s.margin <= 9), 'deficit 7-9'));
  console.log(cell(S.filter((s) => s.period < 4), 'pre-Q4'));
  console.log(cell(S.filter((s) => s.period === 4), 'Q4'));

  writeFileSync('research/fixtures_ee26_states.json.gz', gzipSync(JSON.stringify(states)));
  console.log(`\nstates committed -> research/fixtures_ee26_states.json.gz (${states.length})`);
}

if (process.argv.includes('--pull')) pull(); else analyze();

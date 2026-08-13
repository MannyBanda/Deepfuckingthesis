// ════════════════════════════════════════════════════════════════════════════
// 2026-08-13 — FINE26 EXTRACTION: extend the committed deficit26 derivation
// (2026-08-11_granularity_replay.mjs) to the FULL SS_STRUCT schema on the 2026
// tape: time decay, gap tiers, leader strata, holds, eFG bands.
// SELECTION RECIPE IS BYTE-FAITHFUL to the committed derivation (period 2-4,
// margin 1-15, both fga>=12, both gp>=10 strict-< as-of, first-perception dedup
// per game×leader×bucket). Only FIELDS are extended (lwp/twp/tgp, lefg, lband,
// l3pct, lpot, earned per fine_arena_states.mjs L69).
// REPRODUCTION GATE: restricted to the committed gid set, deficit cells must
// reproduce the SS_STRUCT deficit26 pin EXACTLY (62.9/105, 60.0/55, 40.7/27)
// or the script exits 1.
// STATUS: descriptive / R3-rider-class per PARITY composition rules — these are
// season numbers for PM familiarity; they gate nothing and pool with nothing.
// Run: node research/2026-08-13_fine26_extraction.mjs --pull   (cache tape)
//      node research/2026-08-13_fine26_extraction.mjs          (analyze)
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { gunzipSync, gzipSync } from 'zlib';

const BASE = 'https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api';
const AUTH = 'Basic ' + Buffer.from('manny:DFT2025!').toString('base64');
const api = async (qs) => {
  const r = await fetch(`${BASE}?${qs}`, { headers: { Authorization: AUTH } });
  if (!r.ok) throw new Error(`${qs.split('&')[0]} -> ${r.status}`);
  return r.json();
};
const CACHE = '/tmp/fine26_cache.json';
const SEASON_START = '2026-05-01';
const QSEC = 600;

const clkSec = (c) => { if (c == null) return null; c = String(c); if (c.includes(':')) { const p = c.split(':'); return (+p[0]) * 60 + (+p[1] || 0); } const n = parseFloat(c); return isNaN(n) ? null : n; };
const elapsed = (period, clock) => { const cs = clkSec(clock); if (cs == null || !period) return null; return (period - 1) * QSEC + (QSEC - cs); };
const bucketOfEl = (el) => { const p = Math.min(4, Math.floor(el / QSEC) + 1); const into = el - (p - 1) * QSEC; return `Q${p}-${into <= 300 ? 'early' : 'late'}`; };

// verbatim from poll-live-bdl.mjs L5206 @ a3f885a
const EFG_BANDS = { 1: [54, 61], 2: [56, 63], 3: [58, 66], 4: [60, 69] };
const efgTier = (efg, period) => { if (efg == null || isNaN(efg)) return 'na'; const b = EFG_BANDS[period] || EFG_BANDS[4]; if (efg <= b[0]) return 'green'; if (efg <= b[1]) return 'orange'; return 'red'; };

// ── PULL (slim, cached, resumable) ──────────────────────────────────────────
async function pull() {
  const prev = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : null;
  const games = prev?.games || (await api('action=get_games&league=wnba')).games || [];
  const g26 = games.filter((g) => g.date >= SEASON_START && g.winner && String(g.id).includes('-'));
  const snaps = prev?.snaps || {};
  const Q = g26.filter((g) => !snaps[g.id]);
  let done = 0;
  console.log(`2026 finished games ${g26.length}, remaining to fetch ${Q.length}`);
  const save = () => writeFileSync(CACHE, JSON.stringify({ games, snaps }));
  const side = (o) => o ? { fga: num(o.fga), fgm: num(o.fgm), f3m: num(o.fg3m), f3a: num(o.fg3a), pot: num(o.pot) } : null;
  const num = (x) => x == null ? null : Number(x);
  async function worker() {
    while (Q.length) {
      const g = Q.shift();
      try {
        const h = (await api(`action=history&game_id=${g.id}`)).snapshots || [];
        snaps[g.id] = h.map((s) => {
          let hs = null, as = null;
          try { const rs = typeof s.raw_stats_json === 'string' ? JSON.parse(s.raw_stats_json) : s.raw_stats_json; hs = side(rs?.home); as = side(rs?.away); } catch (e) { /* null */ }
          return { period: Number(s.period), clock: s.clock,
            hp: s.home_pts != null ? Number(s.home_pts) : null,
            ap: s.away_pts != null ? Number(s.away_pts) : null, h: hs, a: as };
        });
      } catch (e) { snaps[g.id] = { err: e.message }; }
      if (++done % 25 === 0) { save(); console.log(`  history ${done} (checkpointed)`); }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  save();
  console.log(`cached -> ${CACHE} (${Object.keys(snaps).length} games)`);
}

// ── STATE BUILD — committed selection recipe, extended fields ───────────────
function build() {
  const { games, snaps } = JSON.parse(readFileSync(CACHE, 'utf8'));
  const g26 = games.filter((g) => g.date >= SEASON_START && g.winner && String(g.id).includes('-'));
  const timeline = {};
  for (const g of g26) for (const [al, won] of [[g.home_alias, g.winner === g.home_alias], [g.away_alias, g.winner === g.away_alias]]) (timeline[al] = timeline[al] || []).push({ date: g.date, won });
  for (const al in timeline) timeline[al].sort((a, b) => a.date < b.date ? -1 : 1);
  const asOf = (al, date) => { const gs = (timeline[al] || []).filter((r) => r.date < date); return { gp: gs.length, wp: gs.length ? gs.filter((r) => r.won).length / gs.length : null }; };

  const states = [];
  for (const g of g26) {
    const h = snaps[g.id]; if (!Array.isArray(h)) continue;
    const seen = new Set();
    const rows = h.map((s) => ({ ...s, el: elapsed(s.period, s.clock) })).filter((s) => s.el != null).sort((x, y) => x.el - y.el);
    for (const s of rows) {
      if (s.period < 2 || s.period > 4) continue;
      if (!isFinite(s.hp) || !isFinite(s.ap)) continue;
      const m = Math.abs(s.hp - s.ap); if (m < 1 || m > 15) continue;
      if (!(s.h && s.a && s.h.fga >= 12 && s.a.fga >= 12)) continue;
      const ldHome = s.hp > s.ap;
      const ldAl = ldHome ? g.home_alias : g.away_alias, trAl = ldHome ? g.away_alias : g.home_alias;
      const rl = asOf(ldAl, g.date), rt = asOf(trAl, g.date);
      if (rl.gp < 10 || rt.gp < 10) continue;
      const key = `${ldAl}|${bucketOfEl(s.el)}`;
      if (seen.has(key)) continue; seen.add(key);
      const L = ldHome ? s.h : s.a;
      const lefg = L.fga > 0 ? ((L.fgm + 0.5 * (L.f3m || 0)) / L.fga) * 100 : null;
      const l3 = L.f3a > 0 ? (L.f3m / L.f3a) * 100 : 0;
      const lband = efgTier(lefg, s.period);
      const earned = !(lband === 'red' || l3 >= 40 || (L.pot || 0) >= 6);   // fine_arena_states.mjs L69
      states.push({ gid: g.id, date: g.date, period: s.period, el: s.el, bucket: bucketOfEl(s.el),
        margin: m, leader: ldAl, trailer: trAl, lwp: rl.wp, twp: rt.wp, lgp: rl.gp, tgp: rt.gp,
        gap: rt.wp - rl.wp, lefg: lefg == null ? null : +lefg.toFixed(2), lband, l3: +l3.toFixed(1),
        lpot: L.pot || 0, earned, won: g.winner === trAl });
    }
  }
  return states;
}

// ── ANALYZE ─────────────────────────────────────────────────────────────────
function analyze() {
  const states = build();
  const conv = (a) => a.length ? Math.round(1000 * a.filter((s) => s.won).length / a.length) / 10 : null;
  const hold = (a) => a.length ? Math.round(1000 * a.filter((s) => !s.won).length / a.length) / 10 : null;
  const fmt = (a, r) => a.length ? `${r(a).toFixed(1)} (n=${a.length})` : '— (n=0)';

  // REPRODUCTION GATE — committed gid set must reproduce the deficit26 pin exactly
  const committed = JSON.parse(readFileSync('research/fixtures_gran_states.json', 'utf8'));
  const gids = new Set((committed.fine || []).map((s) => s.gid));
  const repro = states.filter((s) => gids.has(s.gid) && s.gap >= 0.15);
  const rc = { d13: repro.filter((s) => s.margin <= 3), d46: repro.filter((s) => s.margin >= 4 && s.margin <= 6), d79: repro.filter((s) => s.margin >= 7 && s.margin <= 9) };
  const PIN = { d13: [62.9, 105], d46: [60.0, 55], d79: [40.7, 27] };
  let ok = true;
  for (const k of ['d13', 'd46', 'd79']) { const got = [conv(rc[k]), rc[k].length]; const want = PIN[k]; const pass = got[0] === want[0] && got[1] === want[1]; if (!pass) ok = false; console.log(`REPRO ${k}: got ${got[0]}/${got[1]} want ${want[0]}/${want[1]} ${pass ? 'PASS' : 'FAIL'}`); }
  if (!ok) { console.log('REPRODUCTION GATE FAILED — extraction not faithful, stopping.'); process.exit(1); }

  // FULL-TAPE cells — build_ss_struct populations verbatim
  const S = states;
  const BAND = S.filter((s) => s.margin <= 9);
  const OP = BAND.filter((s) => s.gap >= 0.15);
  const preQ4 = OP.filter((s) => s.period < 4);
  const allGap = S.filter((s) => s.gap >= 0.15);
  const pb = preQ4.filter((s) => s.lwp < 0.40);
  const elite = (s) => s.twp >= 0.600 && s.tgp >= 15;

  const cells = {
    deficit26: { d13: allGap.filter((s) => s.margin <= 3), d46: allGap.filter((s) => s.margin >= 4 && s.margin <= 6), d79: allGap.filter((s) => s.margin >= 7 && s.margin <= 9) },
    time26: { preQ4: preQ4, q4e: OP.filter((s) => s.bucket === 'Q4-early'), q4l: OP.filter((s) => s.bucket === 'Q4-late') },
    gap26: { qual: BAND.filter((s) => s.gap >= 0.15 && s.gap < 0.35), strong: BAND.filter((s) => s.gap >= 0.35) },
    leader26: { bad: OP.filter((s) => s.lwp < 0.40), mid: OP.filter((s) => s.lwp >= 0.40 && s.lwp < 0.550), qual: OP.filter((s) => elite(s) && s.lwp >= 0.550) },
    greenVeto26: { sub45: pb.filter((s) => s.lefg < 45), warm: pb.filter((s) => s.lefg >= 45 && s.lefg <= 55), hot: pb.filter((s) => s.lefg > 55) },
  };
  const holds26 = S.filter((s) => s.gap < 0 && s.earned);

  const BASE_STRUCT = { deficit26: { d13: [54.9, 335], d46: [52.2, 138], d79: [35.8, 106] }, time26: { preQ4: [55.3, 421], q4e: [44.7, 85], q4l: [31.5, 73] }, gap26: { qual: [45.9, 390], strong: [60.8, 189] }, leader26: { bad: [54.3, 370], mid: [47.3, 169], qual: [32.5, 40] }, greenVeto26: { sub45: [46.8, 47], warm: [64.6, 113], hot: [72.0, 50] } };
  const power = (n) => n >= 200 ? 'HIGH' : n >= 80 ? 'MED' : 'LOW';

  console.log(`\nFULL TAPE: ${new Set(S.map((s) => s.gid)).size} games, ${S.length} states (band ${BAND.length})`);
  console.log('\n2026 cell | value | base(24-25 fine) | delta | R1-eligible(>10pp & n>=30) | power');
  for (const grp of Object.keys(cells)) for (const k of Object.keys(cells[grp])) {
    const a = cells[grp][k]; const v = conv(a); const b = BASE_STRUCT[grp]?.[k];
    const d = b && v != null ? +(v - b[0]).toFixed(1) : null;
    const r1 = d != null && Math.abs(d) > 10 && a.length >= 30 ? 'YES' : 'no';
    console.log(`${grp}.${k}: ${fmt(a, conv)} | base ${b ? b[0] + '/' + b[1] : '—'} | Δ ${d == null ? '—' : (d > 0 ? '+' : '') + d}pp | R1 ${r1} | ${power(a.length)}`);
  }
  console.log(`holds26.quality_lead (lead-HOLD): ${fmt(holds26, hold)} | base 75.1/338 | Δ ${holds26.length ? ((hold(holds26) - 75.1) > 0 ? '+' : '') + (hold(holds26) - 75.1).toFixed(1) : '—'}pp | ${power(holds26.length)}`);

  writeFileSync('research/fixtures_fine26_states.json.gz', gzipSync(JSON.stringify(states)));
  console.log(`\nstates committed -> research/fixtures_fine26_states.json.gz (${states.length})`);
}

if (process.argv.includes('--pull')) pull(); else analyze();

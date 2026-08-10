// 2026-08-10 — STICKY HOLD STUDY Phase 1 (pre-registered in chat, PM go)
// Counter-lane hypothesis: sticky leads (EARNED + trailer period-green + clean
// TOs) HOLD at rates the market underprices when the leader is the worse team.
// Bar: hold edge >= +8pp vs best-price implied at n>=40, OOS ordering intact.
import { readFileSync, writeFileSync } from 'fs';
const { games, g26, snaps } = JSON.parse(readFileSync('/tmp/ftg_cache.json', 'utf8'));
const byId = Object.fromEntries(games.map((g) => [g.id, g]));
const EFG_BANDS = { 1:[54,61], 2:[56,63], 3:[58,66], 4:[60,69] };
const wtl = {};
for (const g of games) {
  if (g.date < '2026-05-01' || !g.winner || !String(g.id).includes('-')) continue;
  for (const [al, won] of [[g.home_alias, g.winner === g.home_alias], [g.away_alias, g.winner === g.away_alias]])
    (wtl[al] = wtl[al] || []).push({ date: g.date, won });
}
for (const al in wtl) wtl[al].sort((a, b) => (a.date < b.date ? -1 : 1));
const asOf = (al, date) => { const gs = (wtl[al] || []).filter((r) => r.date < date);
  return { gp: gs.length, wp: gs.length ? gs.filter((r) => r.won).length / gs.length : null }; };
const clockMin = (c) => { const m = String(c || '').match(/(\d+):(\d+)/); return m ? +m[1] + m[2] / 60 : null; };
const bucketOf = (p, c) => { const m = clockMin(c); if (m == null || p < 2 || p > 4) return null; return `Q${p}-${m >= 5 ? 'early' : 'late'}`; };
const n_ = (v) => { const x = Number(v); return isFinite(x) ? x : 0; };

const states = [];
for (const gid of g26) {
  const g = byId[gid], h = snaps[gid];
  if (!Array.isArray(h) || !h.length) continue;
  h.sort((a, b) => (String(a.ts) < String(b.ts) ? -1 : 1));
  const seen = {};
  for (const s of h) {
    const bk = bucketOf(Number(s.period), s.clock);
    if (!bk) continue;
    const p = Number(s.period), hp = n_(s.home_pts), ap = n_(s.away_pts);
    const margin = Math.abs(hp - ap);
    if (margin < 1 || margin > 9) continue;
    const ldHome = hp > ap;
    const ldAl = ldHome ? g.home_alias : g.away_alias, trAl = ldHome ? g.away_alias : g.home_alias;
    const key = ldAl + '|' + bk;
    if (seen[key]) continue;
    const rs = typeof s.raw === 'string' ? JSON.parse(s.raw) : s.raw;
    if (!rs || !rs.home || !rs.away) continue;
    const L = ldHome ? rs.home : rs.away, T = ldHome ? rs.away : rs.home;
    const lFgm = n_(L.fgm), lFga = n_(L.fga), lF3 = n_(L.fg3m);
    const tFgm = n_(T.fgm), tFga = n_(T.fga), tF3 = n_(T.fg3m);
    if (lFga < 12 || tFga < 12) continue;
    seen[key] = true;
    const lEfg = ((lFgm + 0.5 * lF3) / lFga) * 100;
    const tEfg = ((tFgm + 0.5 * tF3) / tFga) * 100;
    const lPts = ldHome ? hp : ap;
    const threeShare = lPts > 0 ? (3 * lF3 / lPts) * 100 : 0;
    const lBand = lEfg > EFG_BANDS[p][1] ? 'red' : lEfg > EFG_BANDS[p][0] ? 'orange' : 'green';
    const vShare = (s.ssl === ldAl && s.ssv != null) ? Number(s.ssv) : null;
    const heat = lBand === 'red' || threeShare >= 40 || (vShare != null && vShare > 45);
    const takeaway = n_(L.pot) >= 6;
    const earned = !heat && !takeaway;
    const tGreen = tEfg <= EFG_BANDS[p][0];
    const clean = n_(T.to) < 4;
    const rl = asOf(ldAl, g.date), rt = asOf(trAl, g.date);
    if (rl.gp < 10 || rt.gp < 10) continue;
    states.push({ game_id: gid, date: g.date, ts: s.ts, bucket: bk, period: p, margin,
      leader: ldAl, trailer: trAl, ldHome, gap: +(rt.wp - rl.wp).toFixed(3),
      sticky: earned && tGreen && clean, earned, tGreen, clean,
      holds: g.winner === ldAl });
  }
}
const sticky = states.filter((s) => s.sticky);
const firstPerGame = Object.values(sticky.reduce((m, s) => { if (!m[s.game_id] || s.ts < m[s.game_id].ts) m[s.game_id] = s; return m; }, {}));
const pow = (n) => (n >= 200 ? 'HIGH' : n >= 80 ? 'MED' : 'LOW');
const hold = (a) => (a.length ? `HOLDS ${((100 * a.filter((s) => s.holds).length) / a.length).toFixed(1)}% (n=${a.length} [${pow(a.length)}])` : '— (n=0)');
console.log(`in-band states ${states.length} | sticky states ${sticky.length} | sticky games ${firstPerGame.length}`);
console.log(`\nPRIMARY — first sticky state per game:`);
console.log(`  all sticky:        ${hold(firstPerGame)}`);
console.log(`  gap >= .15 (dog leader): ${hold(firstPerGame.filter((s) => s.gap >= 0.15))}`);
console.log(`  gap 0 to .15:      ${hold(firstPerGame.filter((s) => s.gap >= 0 && s.gap < 0.15))}`);
console.log(`  gap < 0 (leader better): ${hold(firstPerGame.filter((s) => s.gap < 0))}`);
console.log(`  pre-Q4:            ${hold(firstPerGame.filter((s) => s.period < 4))}`);
console.log(`  Q4:                ${hold(firstPerGame.filter((s) => s.period === 4))}`);
console.log(`\nCONTEXT — non-sticky in-band leads (first per game):`);
const nsFirst = Object.values(states.filter((s) => !s.sticky).reduce((m, s) => { if (!m[s.game_id] || s.ts < m[s.game_id].ts) m[s.game_id] = s; return m; }, {}));
console.log(`  all: ${hold(nsFirst)} | gap>=.15: ${hold(nsFirst.filter((s) => s.gap >= 0.15))}`);
console.log(`\nOOS split (first sticky per game):`);
console.log(`  derive <07-15:  ${hold(firstPerGame.filter((s) => s.date < '2026-07-15'))} | gap>=.15: ${hold(firstPerGame.filter((s) => s.date < '2026-07-15' && s.gap >= 0.15))}`);
console.log(`  validate >=07-15: ${hold(firstPerGame.filter((s) => s.date >= '2026-07-15'))} | gap>=.15: ${hold(firstPerGame.filter((s) => s.date >= '2026-07-15' && s.gap >= 0.15))}`);
writeFileSync('/tmp/sticky_states.json', JSON.stringify({ sticky, firstPerGame }));
console.log('\nsaved -> /tmp/sticky_states.json');

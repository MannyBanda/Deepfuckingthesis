// 2026-08-09 — eFG-BAR SENSITIVITY on fully fire-shaped states (pre-registered in chat)
// Population: pre-Q4, deficit 1-9, gap >= +.15, leader as-of wp < .400, both >=10 GP.
// Primary: 45-55 pooled vs >55 pooled trailer conversion. Secondary: fine bins
// (ordering only) + vshare>55 subset. Sensitivity read only — no bar change here.
import { readFileSync } from 'fs';
const { games, g26, snaps } = JSON.parse(readFileSync('/tmp/ftg_cache.json', 'utf8'));
const byId = Object.fromEntries(games.map((g) => [g.id, g]));
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
const bucketOf = (p, c) => { const m = clockMin(c); if (m == null || p < 2 || p > 3) return null; return `Q${p}-${m >= 5 ? 'early' : 'late'}`; };

const states = [];
for (const gid of g26) {
  const g = byId[gid], h = snaps[gid];
  if (!Array.isArray(h) || !h.length) continue;
  h.sort((a, b) => (String(a.ts) < String(b.ts) ? -1 : 1));
  const seen = {};
  for (const s of h) {
    const bk = bucketOf(Number(s.period), s.clock);
    if (!bk) continue;
    const hp = +s.home_pts, ap = +s.away_pts;
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
    const fgm = +Lb.fgm, fga = +Lb.fga, fg3m = +Lb.fg3m || 0;
    if (!isFinite(fgm) || !isFinite(fga) || fga < 12) continue;
    const rl = asOf(ldAl, g.date), rt = asOf(trAl, g.date);
    if (rl.gp < 10 || rt.gp < 10) { seen[key] = true; continue; }
    seen[key] = true;
    states.push({ bucket: bk, gap: rt.wp - rl.wp, ldWp: rl.wp,
      efg: ((fgm + 0.5 * fg3m) / fga) * 100,
      vshare: (s.ssl === ldAl && s.ssv != null) ? +s.ssv : null,
      won: g.winner === trAl });
  }
}
const pop = states.filter((s) => s.gap >= 0.15 && s.ldWp < 0.40);
const pow = (n) => (n >= 200 ? 'HIGH' : n >= 80 ? 'MED' : 'LOW');
const pct = (a) => (a.length ? ((100 * a.filter((s) => s.won).length) / a.length).toFixed(1) + '%' : '—');
const line = (t, a) => console.log(`  ${t.padEnd(10)} n=${String(a.length).padStart(3)} [${pow(a.length)}]  conv ${pct(a)}`);
console.log(`fire-shaped (pre-Q4, band, gap>=.15, leader<.400): n=${pop.length}`);
console.log('\nPRIMARY (pooled):');
line('<45', pop.filter((s) => s.efg < 45));
line('45-55', pop.filter((s) => s.efg >= 45 && s.efg <= 55));
line('>55', pop.filter((s) => s.efg > 55));
console.log('\nSECONDARY fine bins (ordering only):');
for (const [lo, hi] of [[0,45],[45,50],[50,55],[55,60],[60,65],[65,101]])
  line(`${lo}-${hi===101?'+':hi}`, pop.filter((s) => s.efg >= lo && s.efg < hi));
const vs = pop.filter((s) => s.vshare != null && s.vshare > 55);
console.log(`\nWITH vshare>55 stamped (n=${vs.length}):`);
line('45-55', vs.filter((s) => s.efg >= 45 && s.efg <= 55));
line('>55', vs.filter((s) => s.efg > 55));
// context: same sweep on gap-qualified but leader NOT bad (>=.40)
const ctl = states.filter((s) => s.gap >= 0.15 && s.ldWp >= 0.40);
console.log(`\nCONTEXT — gap>=.15 but leader >= .400 (n=${ctl.length}):`);
line('45-55', ctl.filter((s) => s.efg >= 45 && s.efg <= 55));
line('>55', ctl.filter((s) => s.efg > 55));

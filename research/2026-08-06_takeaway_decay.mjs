// 2026-08-06 — TAKEAWAY DECAY × NET-POT study (pre-registered in chat; PM-directed)
// Reuses /tmp/ftg_cache.json (199-game 2026 archive). Buckets: Q2/Q3/Q4 × early(>=5:00)/late.
import { readFileSync, writeFileSync, existsSync } from 'fs';
const POLL = readFileSync('netlify/functions/poll-live-bdl.mjs', 'utf8');
function extractFn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  const open = src.indexOf('{', src.indexOf(')', i));
  let d = 0, j = open;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}
const extractVar = (s, n) => s.slice(s.indexOf(`var ${n}`), s.indexOf(';', s.indexOf(`var ${n}`)) + 1);
const { computeFuelTemp } = new Function(`${[extractVar(POLL,'EFG_BANDS'), extractFn(POLL,'efgTier'),
  extractVar(POLL,'FUELTEMP_TH'), extractFn(POLL,'computeFuelTemp')].join(';\n')}; return { computeFuelTemp };`)();

const AUTH = 'Basic ' + Buffer.from('manny:DFT2025!').toString('base64');
const api = async (qs) => (await fetch(`https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api?${qs}`, { headers: { Authorization: AUTH } })).json();
const { games, g26, snaps } = JSON.parse(readFileSync('/tmp/ftg_cache.json', 'utf8'));
const byId = Object.fromEntries(games.map((g) => [g.id, g]));

// as-of records (single-call true dates)
const timeline = {};
for (const g of games) {
  if (g.date < '2026-05-01' || !g.winner || !String(g.id).includes('-')) continue;
  for (const [al, won] of [[g.home_alias, g.winner === g.home_alias], [g.away_alias, g.winner === g.away_alias]])
    (timeline[al] = timeline[al] || []).push({ date: g.date, won });
}
for (const al in timeline) timeline[al].sort((a, b) => (a.date < b.date ? -1 : 1));
const asOf = (al, date) => {
  const gs = (timeline[al] || []).filter((r) => r.date < date);
  return { gp: gs.length, wp: gs.length ? gs.filter((r) => r.won).length / gs.length : null };
};
const clockMin = (c) => { const m = String(c || '').match(/(\d+):(\d+)/); return m ? Number(m[1]) + Number(m[2]) / 60 : null; };
const bucketOf = (p, c) => { const m = clockMin(c); if (m == null || p < 2 || p > 4) return null; return `Q${p}-${m >= 5 ? 'early' : 'late'}`; };

const states = [];
for (const gid of g26) {
  const g = byId[gid], h = snaps[gid];
  if (!Array.isArray(h) || !h.length) continue;
  h.sort((a, b) => (String(a.ts) < String(b.ts) ? -1 : 1));
  const seen = {}; // trailerAlias|bucket -> done
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
    const mk = (t) => ({ fgm: t.fgm, fga: t.fga, fg3m: t.fg3m, ftm: t.ftm, to: t.to, pot: t.pot_v2 != null ? t.pot_v2 : t.pot });
    const L = mk(ldHome ? rs.home : rs.away), T = mk(ldHome ? rs.away : rs.home);
    L.vShare = (s.ssl === ldAl && s.ssv != null) ? Number(s.ssv) : null;
    const ft = computeFuelTemp(L, T, Number(s.period));
    if (ft.insufficient) continue;
    const rl = asOf(ldAl, g.date), rt = asOf(trAl, g.date);
    if (rl.gp < 10 || rt.gp < 10) { seen[key] = true; continue; }
    seen[key] = true;
    states.push({ game_id: gid, bucket: bk, deficit: margin, ts: s.ts, trailer: trAl, leader: ldAl,
      gap: +(rt.wp - rl.wp).toFixed(3), fuel: ft.fuel, takeaway: ft.takeaway, heat: ft.heat,
      leaderPot: ft.pot, trailerPot: Number(T.pot) || 0, netPot: (ft.pot || 0) - (Number(T.pot) || 0),
      trailer_won: g.winner === trAl });
  }
}
console.log(`states ${states.length} across ${new Set(states.map(s=>s.game_id)).size} games`);

// odds join (cached per game)
const OC = '/tmp/ftg_odds_bygame.json';
const oddsCache = existsSync(OC) ? JSON.parse(readFileSync(OC, 'utf8')) : {};
const need = [...new Set(states.map((s) => s.game_id))].filter((id) => !oddsCache[id]);
console.log(`odds: ${need.length} games to fetch`);
let done = 0;
const Q = [...need];
async function worker() {
  while (Q.length) {
    const id = Q.shift();
    try { oddsCache[id] = ((await api(`action=get_odds&game_id=${id}`)).odds || []).filter((r) => r.home_ml != null && r.away_ml != null).map((r) => ({ ts: r.ts, h: r.home_ml, a: r.away_ml })); }
    catch { oddsCache[id] = []; }
    if (++done % 40 === 0) { writeFileSync(OC, JSON.stringify(oddsCache)); console.log(`  odds ${done}`); }
  }
}
await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
writeFileSync(OC, JSON.stringify(oddsCache));
const mlProb = (ml) => (ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));
let joined = 0;
for (const st of states) {
  const g = byId[st.game_id];
  const rows = oddsCache[st.game_id] || [];
  const t0 = new Date(st.ts).getTime();
  let best = null, bd = Infinity;
  for (const r of rows) { const d = Math.abs(new Date(r.ts).getTime() - t0); if (d < bd) { bd = d; best = r; } }
  if (best && bd <= 180000) {
    const trHome = st.trailer === g.home_alias;
    const pT = mlProb(trHome ? best.h : best.a), pO = mlProb(trHome ? best.a : best.h);
    st.implied = +(pT / (pT + pO)).toFixed(4);
    joined++;
  }
}
console.log(`odds joined ${joined}/${states.length}`);
writeFileSync('/tmp/ftg_decay_states.json', JSON.stringify(states, null, 1));
console.log('-> /tmp/ftg_decay_states.json (odds cached separately)');

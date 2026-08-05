// ════════════════════════════════════════════════════════════════════════════
// DS v1.1 C — fuelTemp BACKFILL (DECISION_SUPPORT_V1_SPEC v1.1 addendum §C)
// Recomputes the fire-time fuel/temp read for historical SS rows from their
// fire snapshots, using the REPO-EXTRACTED computeFuelTemp (no reimplementation
// drift), and stamps via db-api stamp_ss_fueltemp (merge; refuses live stamps).
// Leader vShare = the row's own fire-time variance_share. Stamps tagged
// src:'backfill'. Seeds the FUEL PULSE season baseline + regime denominator.
// Run: node research/2026-08-05_fueltemp_backfill.mjs [--dry]
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
const POLL = readFileSync('netlify/functions/poll-live-bdl.mjs', 'utf8');
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const i = src.indexOf(sig); if (i < 0) throw new Error(`not found: ${name}`);
  const open = src.indexOf('{', src.indexOf(')', i));
  let d = 0, j = open;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}
function extractVar(src, name) {
  const i = src.indexOf(`var ${name}`); if (i < 0) throw new Error(`not found: ${name}`);
  return src.slice(i, src.indexOf(';', i) + 1);
}
const { computeFuelTemp } = new Function(`${[extractVar(POLL, 'EFG_BANDS'), extractFn(POLL, 'efgTier'),
  extractVar(POLL, 'FUELTEMP_TH'), extractFn(POLL, 'computeFuelTemp')].join(';\n')}; return { computeFuelTemp };`)();

const BASE = 'https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api';
const AUTH = 'Basic ' + Buffer.from('manny:DFT2025!').toString('base64');
const DRY = process.argv.includes('--dry');
const api = async (qs, opts) => {
  const r = await fetch(`${BASE}?${qs}`, { headers: { Authorization: AUTH, 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error(`${qs.split('&')[0]} -> ${r.status}`);
  return r.json();
};
const clkSec = (c) => { const m = /^(\d+):(\d+)/.exec(String(c || '')); return m ? +m[1] * 60 + +m[2] : null; };

const rows = (await api('action=get_sweetspot_alerts&league=wnba&limit=1000')).sweetspot_alerts || [];
const todo = rows.filter((r) => r.game_id !== 'SS_FORCE_TEST' && r.alert_subtype !== 'GAME_BRIEF'
  && Number(r.period) > 0 && !(r.player_ctx_json && (typeof r.player_ctx_json === 'string'
    ? r.player_ctx_json.includes('"fuelTemp"') : r.player_ctx_json.fuelTemp)));
console.log(`rows total ${rows.length}, backfill candidates ${todo.length}${DRY ? ' [DRY]' : ''}`);

const gameCache = {}, snapCache = {};
const stats = { stamped: 0, skipNoGame: 0, skipNoSnap: 0, skipAlias: 0, insufficient: 0, refused: 0, errors: 0 };
const dist = {}; // fuel|temp -> {n, won, sticky, stickyWon} among resolved

for (const row of todo) {
  try {
    if (!gameCache[row.game_id]) gameCache[row.game_id] = (await api(`action=get_ss_state&league=wnba&game_id=${row.game_id}`)).game;
    const gm = gameCache[row.game_id];
    if (!gm || !gm.home_alias) { stats.skipNoGame++; continue; }
    const ldHome = row.leader_alias === gm.home_alias;
    if (!ldHome && row.leader_alias !== gm.away_alias) { stats.skipAlias++; continue; }
    if (!snapCache[row.game_id]) snapCache[row.game_id] = (await api(`action=history&game_id=${row.game_id}`)).snapshots || [];
    const snaps = snapCache[row.game_id];
    // fire snapshot: exact period+clock, else nearest-in-period by clock seconds
    let fire = snaps.find((s) => Number(s.period) === Number(row.period) && String(s.clock) === String(row.clock));
    if (!fire) {
      const target = clkSec(row.clock);
      const inP = snaps.filter((s) => Number(s.period) === Number(row.period) && clkSec(s.clock) != null);
      if (target != null && inP.length) fire = inP.reduce((a, b) => Math.abs(clkSec(a.clock) - target) <= Math.abs(clkSec(b.clock) - target) ? a : b);
    }
    if (!fire || !fire.raw_stats_json) { stats.skipNoSnap++; continue; }
    const rs = typeof fire.raw_stats_json === 'string' ? JSON.parse(fire.raw_stats_json) : fire.raw_stats_json;
    const mk = (t) => t ? { fgm: t.fgm, fga: t.fga, fg3m: t.fg3m, ftm: t.ftm, to: t.to,
      pot: t.pot_v2 != null ? t.pot_v2 : t.pot } : null;
    const L = mk(ldHome ? rs.home : rs.away), T = mk(ldHome ? rs.away : rs.home);
    if (!L || !T) { stats.skipNoSnap++; continue; }
    L.vShare = row.variance_share != null ? Number(row.variance_share) : null;
    const ft = computeFuelTemp(L, T, Number(row.period));
    if (ft.insufficient) { stats.insufficient++; continue; }
    ft.src = 'backfill';
    ft.at = { period: fire.period, clock: fire.clock };
    if (!DRY) {
      const res = await api('action=stamp_ss_fueltemp', { method: 'POST', body: JSON.stringify({ id: row.id, fuelTemp: ft }) });
      if (!res.stamped) { stats.refused++; continue; }
    }
    stats.stamped++;
    if (row.resolved) {
      const k = `${ft.fuel.startsWith('TRANSIENT') ? 'TRANSIENT' : 'EARNED'}|${ft.temp}`;
      const d = (dist[k] = dist[k] || { n: 0, won: 0, sticky: 0, stickyWon: 0 });
      d.n++; if (row.trailer_won) d.won++;
      if (ft.sticky) { d.sticky++; if (row.trailer_won) d.stickyWon++; }
    }
  } catch (e) { stats.errors++; console.log(`row ${row.id}: ${e.message}`); }
}
console.log('\n== BACKFILL REPORT ==');
console.log(JSON.stringify(stats));
console.log('\nfuel|temp distribution (RESOLVED rows, row units — dedupe happens in the pulse query):');
for (const [k, d] of Object.entries(dist).sort()) {
  console.log(`  ${k.padEnd(18)} n=${String(d.n).padStart(3)}  conv ${d.n ? Math.round(d.won / d.n * 100) : 0}%${d.sticky ? `  [sticky ${d.sticky}, conv ${Math.round(d.stickyWon / d.sticky * 100)}%]` : ''}`);
}

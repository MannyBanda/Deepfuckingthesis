// ════════════════════════════════════════════════════════════════════════════
// 2026-08-06 — FUEL × TEMP × GAP MAP (full-2026 unselected cut)
// State recipe (mirrors §8/§10): first Q2–Q3 snapshot per game with score-derived
// deficit 1–9 and a valid computeFuelTemp read (both FGA ≥ 12). Gap unfiltered —
// stratification axis. Outcome: trailer wins final. As-of records via single-call
// true dates (the §10 date-bug fix). pot = pot_v2 ?? pot. vShare only when
// snapshot ss_leader_alias matches the score-derived leader.
// Run: node research/2026-08-06_fuel_temp_gap_map.mjs [--pull] [--odds]
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync } from 'fs';
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
const api = async (qs) => {
  const r = await fetch(`${BASE}?${qs}`, { headers: { Authorization: AUTH } });
  if (!r.ok) throw new Error(`${qs.split('&')[0]} -> ${r.status}`);
  return r.json();
};
const CACHE = '/tmp/ftg_cache.json';
const SEASON_START = '2026-05-01';

// ── PHASE 1: PULL (cached) ──────────────────────────────────────────────────
async function pull() {
  const prev = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : null;
  const games = prev?.games || (await api('action=get_games&league=wnba')).games || [];
  const alerts = prev?.alerts || (await api('action=get_sweetspot_alerts&league=wnba&limit=1000')).sweetspot_alerts || [];
  // 2026-season finished games only, UUID ids (numeric ids = historical/backtest imports)
  const g26 = games.filter((g) => g.date >= SEASON_START && g.winner && String(g.id).includes('-'));
  const snaps = prev?.snaps || {};
  let done = 0;
  const Q = g26.filter((g) => !snaps[g.id]);
  console.log(`games total ${games.length}, 2026-season finished ${g26.length}, remaining to fetch ${Q.length}`);
  const save = () => writeFileSync(CACHE, JSON.stringify({ games, alerts, g26: g26.map((g) => g.id), snaps }));
  async function worker() {
    while (Q.length) {
      const g = Q.shift();
      try {
        const h = (await api(`action=history&game_id=${g.id}`)).snapshots || [];
        // keep only fields we need — cache size control
        snaps[g.id] = h.map((s) => ({
          ts: s.ts, period: Number(s.period), clock: s.clock,
          home_pts: s.home_pts, away_pts: s.away_pts,
          raw: s.raw_stats_json, ssl: s.ss_leader_alias, ssv: s.ss_variance_share,
        }));
      } catch (e) { snaps[g.id] = { err: e.message }; }
      if (++done % 25 === 0) { save(); console.log(`  history ${done} fetched (checkpoint saved)`); }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  save();
  console.log(`cached -> ${CACHE} (${Object.keys(snaps).length} games)`);
}

// ── PHASE 2: STATES ─────────────────────────────────────────────────────────
function build() {
  const { games, alerts, g26, snaps } = JSON.parse(readFileSync(CACHE, 'utf8'));
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  // fired tag: pushed tiers only (log-only streams are not selection)
  const FIRED = new Set(['EFG_FADE', 'B1', 'B2', 'B3', 'WATCHLIST']);
  const firedGames = new Set(alerts.filter((a) => FIRED.has(a.alert_subtype)).map((a) => a.game_id));
  // as-of records: per-team date-ordered results within 2026 season (all finished 2026 games)
  const timeline = {};
  for (const g of games) {
    if (g.date < SEASON_START || !g.winner || !String(g.id).includes('-')) continue;
    for (const [al, won] of [[g.home_alias, g.winner === g.home_alias], [g.away_alias, g.winner === g.away_alias]]) {
      (timeline[al] = timeline[al] || []).push({ date: g.date, won });
    }
  }
  for (const al in timeline) timeline[al].sort((a, b) => a.date < b.date ? -1 : 1);
  const asOf = (al, date) => {
    const gs = (timeline[al] || []).filter((r) => r.date < date);
    return { gp: gs.length, wp: gs.length ? gs.filter((r) => r.won).length / gs.length : null };
  };

  const states = [];
  const skip = { noSnaps: 0, noQualSnap: 0, gp: 0 };
  for (const gid of g26) {
    const g = byId[gid], h = snaps[gid];
    if (!Array.isArray(h) || !h.length) { skip.noSnaps++; continue; }
    h.sort((a, b) => String(a.ts) < String(b.ts) ? -1 : 1);
    // Recipe v2 (amended pre-results, disclosed): first in-band hit per
    // (game, trailing side) — up to 2 states/game. §10-comparable: each state is
    // a real betting-window moment for that side. firstOfGame flags the
    // one-per-game subset for the independence sensitivity.
    const found = {}; // trailer alias -> state
    let firstAlias = null;
    for (const s of h) {
      if (Object.keys(found).length === 2) break;
      if (s.period !== 2 && s.period !== 3) continue;
      const hp = Number(s.home_pts), ap = Number(s.away_pts);
      if (!isFinite(hp) || !isFinite(ap)) continue;
      const margin = Math.abs(hp - ap);
      if (margin < 1 || margin > 9) continue;
      const ldHome = hp > ap;
      const trAlias = ldHome ? g.away_alias : g.home_alias;
      if (found[trAlias]) continue;
      const rs = typeof s.raw === 'string' ? JSON.parse(s.raw) : s.raw;
      if (!rs || !rs.home || !rs.away) continue;
      const mk = (t) => ({ fgm: t.fgm, fga: t.fga, fg3m: t.fg3m, ftm: t.ftm, to: t.to,
        pot: t.pot_v2 != null ? t.pot_v2 : t.pot });
      const L = mk(ldHome ? rs.home : rs.away), T = mk(ldHome ? rs.away : rs.home);
      const ldAlias = ldHome ? g.home_alias : g.away_alias;
      L.vShare = (s.ssl === ldAlias && s.ssv != null) ? Number(s.ssv) : null;
      const ft = computeFuelTemp(L, T, s.period);
      if (ft.insufficient) continue;
      found[trAlias] = { s, ft, margin, ldAlias, trAlias };
      if (!firstAlias) firstAlias = trAlias;
    }
    const sts = Object.values(found);
    if (!sts.length) { skip.noQualSnap++; continue; }
    for (const st of sts) {
      const rl = asOf(st.ldAlias, g.date), rt = asOf(st.trAlias, g.date);
      if (rl.gp < 10 || rt.gp < 10) { skip.gp++; continue; }
      states.push({
        game_id: gid, date: g.date, matchup: g.matchup,
        leader: st.ldAlias, trailer: st.trAlias, deficit: st.margin,
        period: st.s.period, clock: st.s.clock, ts: st.s.ts,
        gap: +(rt.wp - rl.wp).toFixed(4), ldWp: +rl.wp.toFixed(3), trWp: +rt.wp.toFixed(3),
        fuel: st.ft.fuel, heat: st.ft.heat, takeaway: st.ft.takeaway,
        temp: st.ft.temp, sticky: st.ft.sticky,
        leaderEfg: st.ft.leaderEfg, trailerEfg: st.ft.trailerEfg,
        pot: st.ft.pot, trailerTo: st.ft.trailerTo, vShare: st.ft.vShare,
        trailer_won: g.winner === st.trAlias, fired: firedGames.has(gid),
        firstOfGame: st.trAlias === firstAlias,
      });
    }
  }
  console.log(`states ${states.length} | skips ${JSON.stringify(skip)}`);
  writeFileSync('/tmp/ftg_states.json', JSON.stringify(states, null, 1));
  console.log('-> /tmp/ftg_states.json');
}

// ── PHASE 3: ODDS JOIN ──────────────────────────────────────────────────────
async function odds() {
  const states = JSON.parse(readFileSync('/tmp/ftg_states.json', 'utf8'));
  const mlProb = (ml) => ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
  let joined = 0;
  for (const st of states) {
    try {
      const rows = (await api(`action=get_odds&game_id=${st.game_id}`)).odds || [];
      const t0 = new Date(st.ts).getTime();
      let best = null, bd = Infinity;
      for (const r of rows) {
        if (r.home_ml == null || r.away_ml == null) continue;
        const d = Math.abs(new Date(r.ts).getTime() - t0);
        if (d < bd) { bd = d; best = r; }
      }
      if (best && bd <= 180000) {
        const trHome = st.trailer !== st.leader && st.trailer === st.matchup.split('@')[1];
        const tMl = trHome ? best.home_ml : best.away_ml;
        const oMl = trHome ? best.away_ml : best.home_ml;
        const pT = mlProb(tMl), pO = mlProb(oMl);
        st.trailerMl = tMl;
        st.implied = +(pT / (pT + pO)).toFixed(4);
        st.oddsGapSec = Math.round(bd / 1000);
        joined++;
      }
    } catch { /* no tape */ }
  }
  console.log(`odds joined ${joined}/${states.length}`);
  writeFileSync('/tmp/ftg_states.json', JSON.stringify(states, null, 1));
}

const run = async () => {
  if (process.argv.includes('--pull') || !existsSync(CACHE)) await pull();
  build();
  if (process.argv.includes('--odds')) await odds();
};
run();

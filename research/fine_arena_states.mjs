// ══════════════════════════════════════════════════════════════════════════════
// fine_arena_states.mjs — FINE_ARENA_SPEC §3/§4: shared states builder.
// Faithful port of research/2026-08-10_spec_cuts_regime.py state construction,
// grain-aware (buckets derive from gameSec, not label — identical mapping for
// the legacy 2.5-min labels, verified by fixture). Used by BOTH the walker
// regression gate and the analysis scripts — one recipe, no drift.
//
// AS-OF RULE (PM directive, Aug 11): team records are computed from games with
// date STRICTLY BEFORE the state's game date — never closing-season numbers.
// Fixture-pinned in fine_arena_fixtures.mjs.
// ══════════════════════════════════════════════════════════════════════════════
export const EB = { 2: [56, 63], 3: [58, 66], 4: [60, 69] };
export const ALIAS = { LVA: 'LV', NYL: 'NY', GSV: 'GS', WAS: 'WSH', LAS: 'LA', PDX: 'POR', TOY: 'TOR' };
export const al = (a) => ALIAS[a] || a;

export const tbucketOfGameSec = (gs) => {
  const p = Math.min(4, Math.ceil(gs / 600));
  const into = gs - (p - 1) * 600;
  return `Q${p}-${into <= 300 ? 'early' : 'late'}`;
};

// games: export rows [{game_id, season, date, home, away, winner, checkpoints:[...]}]
// opts.minGameSec/maxGameSec: optional window clamp (coarse-comparable = [750,2250])
export function buildTimeline(games) {
  const tl = {};
  for (const g of games) {
    for (const [t, won] of [[al(g.home), g.winner === g.home], [al(g.away), g.winner === g.away]]) {
      (tl[t] = tl[t] || []).push([String(g.date).slice(0, 10), won]);
    }
  }
  for (const t in tl) tl[t].sort((a, b) => a[0] < b[0] ? -1 : 1);
  return tl;
}
export const asOf = (tl, t, date) => {
  const gs = (tl[t] || []).filter((r) => r[0] < date);   // STRICT < — never closing-season
  return { gp: gs.length, wp: gs.length ? gs.filter((r) => r[1]).length / gs.length : null };
};

export function buildStates(games, opts) {
  opts = opts || {};
  const tl = buildTimeline(games);
  const seen = new Set(), S = [];
  for (const g of games) {
    const date = String(g.date).slice(0, 10);
    const hA = al(g.home), aA = al(g.away);
    const cps = (g.checkpoints || []).slice().sort((x, y) => x.gameSec - y.gameSec);
    for (const c of cps) {
      const p = c.period;
      if (!EB[p]) continue;
      if (opts.minGameSec != null && c.gameSec < opts.minGameSec) continue;
      if (opts.maxGameSec != null && c.gameSec > opts.maxGameSec) continue;
      const h = c.home, a = c.away;
      const hp = h.pts || 0, ap = a.pts || 0;
      const m = Math.abs(hp - ap);
      if (m < 1 || m > 15) continue;
      const ldH = hp > ap;
      const [L, T] = ldH ? [h, a] : [a, h];
      const [ldAl, trAl] = ldH ? [hA, aA] : [aA, hA];
      const tb = tbucketOfGameSec(c.gameSec);
      const key = `${g.game_id}|${ldAl}|${tb}`;
      if (seen.has(key)) continue;
      if ((L.fga || 0) < 12 || (T.fga || 0) < 12) continue;
      seen.add(key);
      const lEfg = (L.fgm + 0.5 * L.f3m) / L.fga * 100;
      const tEfg = (T.fgm + 0.5 * T.f3m) / T.fga * 100;
      const lPts = ldH ? hp : ap;
      const three = lPts ? 3 * (L.f3m || 0) / lPts * 100 : 0;
      const lBand = lEfg > EB[p][1] ? 'red' : (lEfg > EB[p][0] ? 'orange' : 'green');
      const earned = !(lBand === 'red' || three >= 40 || (L.pot || 0) >= 6);
      const gl = asOf(tl, ldAl, date), gt = asOf(tl, trAl, date);
      if (gl.gp < 10 || gt.gp < 10) continue;
      S.push({ season: g.season, date, gid: g.game_id, tb, period: p, margin: m,
        leader: ldAl, trailer: trAl, lwp: gl.wp, twp: gt.wp, lgp: gl.gp, tgp: gt.gp,
        gap: gt.wp - gl.wp, lefg: lEfg, tefg: tEfg, lband: lBand, earned,
        ttemp: tEfg < 45 ? 'cold' : tEfg > 55 ? 'hot' : 'warm',
        won: g.winner === (ldH ? g.away : g.home),
        // grain-era extras (null-safe on legacy exports without pntm):
        gameSec: c.gameSec,
        lpaint: L.pntm != null ? 2 * L.pntm : null, lftm: L.ftm, lpot: L.pot || 0,
        lto: L.to, tto: T.to, lfga: L.fga, tfga: T.fga });
    }
  }
  return S;
}

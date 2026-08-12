// ══════════════════════════════════════════════════════════════════════════════
// 2026-08-11 — FINE_ARENA §5: TIER-SHAPE REPLAY (price-blind, model-legs replayed)
// Extracts divergenceRead (fade), comebackProb (collapse), computeLeadComposition
// (lead class) + efgTier + ssClassifyTier VERBATIM from poll-live-bdl.mjs and
// classifies every fine-arena state. PRICE LEG BLIND: ssClassifyTier called with
// edge=1 stub (documented) — measures shape selectivity, never P&L.
// Run: node research/2026-08-11_tier_shape_replay.mjs  (needs /tmp/arena_fine30.json)
// ══════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync } from 'fs';
import { buildTimeline, asOf, al } from './fine_arena_states.mjs';
const POLL = readFileSync('netlify/functions/poll-live-bdl.mjs', 'utf8');
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const i = src.indexOf(sig); if (i < 0) throw new Error(`not found: ${name}`);
  const open = src.indexOf('{', src.indexOf(')', i));
  let d = 0, j = open;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}
const extractVar = (src, name) => { const i = src.indexOf(`var ${name}`); return src.slice(i, src.indexOf(';', i) + 1); };
const mod = new Function([
  extractVar(POLL, 'EFG_BANDS'), extractFn(POLL, 'efgTier'), extractFn(POLL, '_clkSec'),
  extractFn(POLL, 'cbDepthRate'), extractFn(POLL, 'divergenceRead'), extractFn(POLL, 'comebackProb'),
  extractFn(POLL, 'computeLeadComposition'), extractFn(POLL, 'ssClassifyTier'),
].join(';\n') + '; return { divergenceRead, comebackProb, computeLeadComposition, ssClassifyTier };')();
const { divergenceRead, comebackProb, computeLeadComposition, ssClassifyTier } = mod;

const games = JSON.parse(readFileSync('/tmp/arena_fine30.json', 'utf8'));
const tl = buildTimeline(games);
const clkOf = (gameSec) => { const p = Math.min(4, Math.ceil(gameSec / 600)); const cs = p * 600 - gameSec; return `${Math.floor(cs / 60)}:${String(cs % 60).padStart(2, '0')}`; };

// classify every deduped state (same dedupe as Phase 1: leader|game|bucket)
const tbOf = (gs) => { const p = Math.min(4, Math.ceil(gs / 600)); return `Q${p}-${gs - (p - 1) * 600 <= 300 ? 'early' : 'late'}`; };
const rows = [];
for (const g of games) {
  const date = String(g.date).slice(0, 10), hA = al(g.home), aA = al(g.away);
  const seen = new Set();
  for (const c of (g.checkpoints || []).slice().sort((x, y) => x.gameSec - y.gameSec)) {
    const p = c.period; if (p < 2 || p > 4) continue;
    const hp = c.home.pts || 0, ap = c.away.pts || 0, m = Math.abs(hp - ap);
    if (m < 1 || m > 15) continue;
    const ldH = hp > ap;
    const [L, T] = ldH ? [c.home, c.away] : [c.away, c.home];
    const [ldAl, trAl] = ldH ? [hA, aA] : [aA, hA];
    const key = `${ldAl}|${tbOf(c.gameSec)}`;
    if (seen.has(key)) continue;
    if ((L.fga || 0) < 12 || (T.fga || 0) < 12) continue;
    seen.add(key);
    const rl = asOf(tl, ldAl, date), rt = asOf(tl, trAl, date);
    if (rl.gp < 10 || rt.gp < 10) continue;
    const clock = clkOf(c.gameSec);
    // sc shape for divergenceRead: leader/trailer sides with efgBox + vPct
    const mkSide = (S, team, pts) => {
      const paint = 2 * (S.pntm || 0), ft = S.ftm || 0, three = 3 * (S.f3m || 0);
      const structural = paint + ft, vPct = pts > 0 ? Math.round((1 - Math.min(1, structural / pts)) * 100) : null;
      return { team, total: pts, fga: S.fga, efgBox: S.fga ? (S.fgm + 0.5 * S.f3m) / S.fga * 100 : null, vPct };
    };
    const sc = { period: p, clock,
      home: mkSide(c.home, hA, hp), away: mkSide(c.away, aA, ap) };
    const fade = divergenceRead(sc);
    // computeLeadComposition consumes the summary shape (points_in_the_paint etc.)
    const mkStat = (S) => ({ points_in_the_paint: 2 * (S.pntm || 0), free_throws_made: S.ftm || 0, three_points_made: S.f3m || 0 });
    const comp = computeLeadComposition({ home: { alias: hA, points: hp, statistics: mkStat(c.home) },
      away: { alias: aA, points: ap, statistics: mkStat(c.away) } });
    const coll = comebackProb(rl.wp, rt.wp, m, p, fade);
    const tierRes = ssClassifyTier(1 /* PRICE-BLIND STUB */, p, m, coll?.tier, fade?.tier, comp?.classification);
    rows.push({ season: g.season, gid: g.game_id, date, tb: tbOf(c.gameSec), period: p, margin: m,
      leader: ldAl, trailer: trAl, gap: rt.wp - rl.wp, lwp: rl.wp,
      fade: fade?.tier, coll: coll?.tier, cls: comp?.classification,
      tier: tierRes.tier, soft: tierRes.softCell, ledger: tierRes.ledgerSub,
      won: g.winner === (ldH ? g.away : g.home) });
  }
}
const conv = (a) => a.length ? (100 * a.filter((x) => x.won).length / a.length).toFixed(1) : null;
const fmt = (a) => a.length ? `${conv(a)}% (n=${a.length})` : '-';
const bys = (a) => [2024, 2025].map((y) => `${y}: ${fmt(a.filter((x) => x.season === y))}`).join(' | ');
console.log(`states classified: ${rows.length}`);
console.log('\n══ TIER-SHAPE FUNNEL (price-blind — edge leg stubbed; fade+collapse+class replayed verbatim) ══');
const shapes = {
  'A-shape  (STRONG FADE × VOLATILE)': rows.filter((r) => r.tier === 'A'),
  'B1-shape (LEAN FADE × VOLATILE)': rows.filter((r) => r.soft === 'B1'),
  'B2-shape (STRONG FADE × MIXED)': rows.filter((r) => r.soft === 'B2'),
  'B3-shape (LEAN FADE × MIXED)': rows.filter((r) => r.soft === 'B3'),
  'GAP_BASE (base pass, shapes fail)': rows.filter((r) => r.ledger === 'GAP_BASE'),
  'Q4_COLLAPSE (Q4 d10-15)': rows.filter((r) => r.ledger === 'Q4_COLLAPSE'),
  'collapse-fail (no STRONG/SHORT)': rows.filter((r) => !r.tier && !r.ledger),
};
for (const [k, a] of Object.entries(shapes)) console.log(`  ${k.padEnd(36)} ${fmt(a).padEnd(15)} ${bys(a)}`);
console.log('\n  A+B pooled:', fmt(rows.filter((r) => r.tier)), '|', bys(rows.filter((r) => r.tier)));
console.log('  2026 live ledger reference: A-tier 5/5+1/1 soft · WATCHLIST ~70% · GAP_BASE ~80% (selection-layered, price-gated — NOT directly comparable)');
writeFileSync('research/fixtures_tier_replay_states.json', JSON.stringify(rows));
console.log(`\nstates committed -> research/fixtures_tier_replay_states.json (${rows.length})`);

// ════════════════════════════════════════════════════════════════════════════
// SWEETSPOT TIER B/C + WATCHLIST FIXTURES (SWEETSPOT_TIER_BC_SPEC.md §4)
// Extracts ssClassifyTier + ssComposePush from poll-live-bdl.mjs (not retyped) and
// runs a battery covering: every ladder cell + boundaries, A2.3 copy assertions
// (terms in full, no jargon, ASCII titles), B kelly halving, band clauses,
// consensus omission. Suppress/ledgerOnly DB paths are covered by force tests
// 3/4/5 (live) — this harness is the pure-logic layer.
// Run: node research/ss_tier_bc_fixtures.mjs
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';

const POLL = readFileSync('netlify/functions/poll-live-bdl.mjs', 'utf8');

function extractFn(src, name) {
  const sig = `function ${name}(`;
  const i = src.indexOf(sig);
  if (i < 0) throw new Error(`fn not found: ${name}`);
  const open = src.indexOf('{', src.indexOf(')', i));
  let depth = 0, j = open;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

const ssClassifyTier = new Function(`${extractFn(POLL, 'ssClassifyTier')}; return ssClassifyTier;`)();
const ssComposePush = new Function(`${extractFn(POLL, 'ssComposePush')}; return ssComposePush;`)();

let pass = 0, fail = 0;
function T(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 1. LADDER CLASSIFICATION ────────────────────────────────────────────────
console.log('\n[1] ssClassifyTier — cells');
const C = (e, p, d, c, f, cl) => ssClassifyTier(e, p, d, c, f, cl);
let r;
r = C(0.2, 3, 6, 'STRONG', 'STRONG FADE', 'VOLATILE');
T('A: pristine dual-gate', r.tier === 'A' && !r.softCell && !r.ledgerSub);
r = C(0.2, 3, 6, 'SHORT', 'STRONG FADE', 'VOLATILE');
T('A: SHORT collapse also qualifies', r.tier === 'A');
r = C(0.2, 3, 6, 'STRONG', 'LEAN FADE', 'VOLATILE');
T('B1: fade soft', r.tier === 'B' && r.softCell === 'B1');
r = C(0.2, 2, 6, 'STRONG', 'STRONG FADE', 'MIXED');
T('B2: variance soft', r.tier === 'B' && r.softCell === 'B2');
r = C(0.2, 3, 6, 'SHORT', 'LEAN FADE', 'MIXED');
T('B3: mid-heat, both one step', r.tier === 'B' && r.softCell === 'B3');
r = C(0.2, 3, 6, 'STRONG', 'NO FADE', 'STRUCTURAL');
T('GAP_BASE: base gates pass, shapes fail', !r.tier && r.ledgerSub === 'GAP_BASE');
r = C(0.2, 3, 6, 'STRONG', 'STRONG FADE', 'STRUCTURAL');
T('GAP_BASE: clean fade but STRUCTURAL class (fails A+B)', r.ledgerSub === 'GAP_BASE');
r = C(0.2, 3, 6, 'STRONG', 'NO EDGE', 'EVEN');
T('GAP_BASE: NO EDGE / EVEN also routes to ledger', r.ledgerSub === 'GAP_BASE');
r = C(0.2, 4, 12, 'STRONG', 'NO FADE', 'STRUCTURAL');
T('Q4_COLLAPSE: Q4 deficit 12', !r.tier && r.ledgerSub === 'Q4_COLLAPSE');
r = C(0.2, 4, 12, 'SHORT', 'STRONG FADE', 'VOLATILE');
T('Q4_COLLAPSE: fires regardless of fade/class shape', r.ledgerSub === 'Q4_COLLAPSE');

console.log('\n[2] ssClassifyTier — gates & boundaries');
T('edge null → nothing', !C(null, 3, 6, 'STRONG', 'STRONG FADE', 'VOLATILE').tier && !C(null, 3, 6, 'STRONG', 'STRONG FADE', 'VOLATILE').ledgerSub);
T('edge 0 → nothing', !C(0, 3, 6, 'STRONG', 'STRONG FADE', 'VOLATILE').tier);
T('edge negative → nothing', !C(-0.05, 3, 6, 'STRONG', 'STRONG FADE', 'VOLATILE').tier);
T('collapse NO_EDGE → nothing', !C(0.2, 3, 6, 'NO_EDGE', 'STRONG FADE', 'VOLATILE').tier && !C(0.2, 3, 6, 'NO_EDGE', 'STRONG FADE', 'VOLATILE').ledgerSub);
T('collapse DEAD → nothing', !C(0.2, 4, 12, 'DEAD', 'NO FADE', 'STRUCTURAL').ledgerSub);
T('deficit 9 boundary → A', C(0.2, 3, 9, 'STRONG', 'STRONG FADE', 'VOLATILE').tier === 'A');
T('deficit 10 pre-Q4 → nothing (BANKED, no ledger shape)', (() => { const x = C(0.2, 3, 10, 'STRONG', 'STRONG FADE', 'VOLATILE'); return !x.tier && !x.ledgerSub; })());
T('Q4 with A shape at deficit 6 → nothing (A is pre-Q4 only)', (() => { const x = C(0.2, 4, 6, 'STRONG', 'STRONG FADE', 'VOLATILE'); return !x.tier && !x.ledgerSub; })());
T('Q4 deficit 10 boundary → Q4_COLLAPSE', C(0.2, 4, 10, 'STRONG', 'NO FADE', 'EVEN').ledgerSub === 'Q4_COLLAPSE');
T('Q4 deficit 15 boundary → Q4_COLLAPSE', C(0.2, 4, 15, 'SHORT', 'NO FADE', 'EVEN').ledgerSub === 'Q4_COLLAPSE');
T('Q4 deficit 16 → nothing (DEAD territory)', !C(0.2, 4, 16, 'STRONG', 'NO FADE', 'EVEN').ledgerSub);
T('Q4 deficit 9 → nothing (below Q4 band)', !C(0.2, 4, 9, 'STRONG', 'NO FADE', 'EVEN').ledgerSub);

// ── 3. PUSH COPY (A2.3 verbatim standard) ───────────────────────────────────
const BASE = {
  subtype: 'EFG_FADE', tier: 'A', softCell: null, period: 3, clock: '5:42',
  leaderAl: 'CHI', trailerAl: 'ATL', leaderWP: 0.353, trailerWP: 0.706, gap: 0.353,
  leaderW: 6, leaderL: 11, trailerW: 12, trailerL: 5,
  leaderEfg: 71.3, leaderBand: 'red', varShare: 62, leadClass: 'VOLATILE',
  fadeTier: 'STRONG FADE', collapseTier: 'SHORT', collapseTrue: 0.61, pLow: 0.54, pHigh: 0.68,
  bestML: 180, bestBook: 'FanDuel', consensusML: 165, impliedBest: 0.357,
  edge: 0.253, kellySize: 0.071, margin: 6, books: 8,
};

console.log('\n[3] ssComposePush — Tier A copy');
let p = ssComposePush({ ...BASE });
T('title: action + price + book', p.title === 'SWEET SPOT A - Back ATL +180 (FanDuel)', p.title);
T('title is ASCII-only (hotfix #2)', /^[\x00-\x7F]*$/.test(p.title));
T('priority 5', p.priority === 5);
T('body leads with Back … down … Q{P} {clock}', p.body.startsWith('Back ATL (12-5) down 6 to CHI (6-11), Q3 5:42.'));
T('WHY names effective FG in full', p.body.includes('71% effective FG (shooting efficiency)'));
T('WHY glosses variance share in plain English', p.body.includes('62% of their lead comes from that heat rather than structure'));
T('quality gap as both win rates', p.body.includes('wins 71% of games vs CHI\'s 35% (quality gap)'));
T('NUMBERS: true chance + range + market + edge', p.body.includes('~61% (range 54–68%) vs the market\'s 36% — a +25-point edge'));
T('best price + consensus', p.body.includes('Best price +180 at FanDuel (consensus +165)'));
T('SIZE: quarter-Kelly in words', p.body.includes('~7.1% of bankroll (quarter-Kelly)'));
T('window clause in plain English', p.body.includes('Valid while the deficit stays single digits, before Q4.'));
T('no raw band color', !p.body.includes('(red)'));
T('no "1/4-Kelly" jargon', !p.body.includes('1/4-Kelly'));
T('no "pp" jargon', !/\dpp/.test(p.body));
T('no TIER B clause on A', !p.body.includes('TIER B'));

console.log('\n[4] ssComposePush — Tier B variants');
p = ssComposePush({ ...BASE, subtype: 'EFG_FADE_SOFT', tier: 'B', softCell: 'B1', fadeTier: 'LEAN FADE' });
T('B title', p.title === 'SWEET SPOT B - Back ATL +180 (FanDuel)', p.title);
T('B priority 4', p.priority === 4);
T('B1 soft clause: shooting-heat read moderate', p.body.includes('TIER B: one gate is a step soft: shooting-heat read moderate — confidence a notch below A.'));
T('B clause sits after WHY, before NUMBERS', p.body.indexOf('quality gap') < p.body.indexOf('TIER B') && p.body.indexOf('TIER B') < p.body.indexOf('NUMBERS'));
T('B kelly halved + labeled eighth-Kelly', p.body.includes('~3.5% of bankroll (eighth-Kelly — half of A sizing)'));
p = ssComposePush({ ...BASE, subtype: 'EFG_FADE_SOFT', tier: 'B', softCell: 'B2', leadClass: 'MIXED' });
T('B2 soft clause: lead-mix read moderate', p.body.includes('one gate is a step soft: lead-mix read moderate'));
p = ssComposePush({ ...BASE, subtype: 'EFG_FADE_SOFT', tier: 'B', softCell: 'B3', fadeTier: 'LEAN FADE', leadClass: 'MIXED' });
T('B3 soft clause: both reads a step soft', p.body.includes('TIER B: both reads a step soft — confidence a notch below A.'));

console.log('\n[5] ssComposePush — WATCHLIST');
p = ssComposePush({ ...BASE, subtype: 'WATCHLIST', tier: null, period: 2, margin: 7 });
T('title: REVIEW + not a bet call', p.title === 'REVIEW - ATL down 7 to CHI (not a bet call)', p.title);
T('title is ASCII-only', /^[\x00-\x7F]*$/.test(p.title));
T('priority 2', p.priority === 2);
T('quality gap with both win rates', p.body.includes('wins 71% of games vs CHI\'s 35% (quality gap)'));
T('red band → running red-hot', p.body.includes('71% effective FG — running red-hot'));
T('explicitly non-directive', p.body.includes("System gates haven't aligned for a bet; worth a dashboard look."));
p = ssComposePush({ ...BASE, subtype: 'WATCHLIST', tier: null, leaderBand: 'orange' });
T('orange band → running hot', p.body.includes('— running hot') && !p.body.includes('red-hot'));
p = ssComposePush({ ...BASE, subtype: 'WATCHLIST', tier: null, leaderBand: 'green' });
T('green band → no heat clause', !p.body.includes('running'));

console.log('\n[6] ssComposePush — graceful degradation');
p = ssComposePush({ ...BASE, books: 1, consensusML: null });
T('consensus omitted when 1 book', !p.body.includes('consensus'));
p = ssComposePush({ ...BASE, bestBook: null });
T('missing book → "best book" fallback', p.body.includes('at best book'));
p = ssComposePush({ ...BASE, kellySize: null });
T('missing kelly → ? not NaN', p.body.includes('~?% of bankroll'));
p = ssComposePush({ ...BASE, leaderEfg: null, varShare: null });
T('missing efg/var → ? placeholders', p.body.includes('?% effective FG') && p.body.includes('?% of their lead'));

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);

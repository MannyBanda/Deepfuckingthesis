// ═══ MATCHUP SHEET FIXTURES — extracts prepMatchupData from wnba-bdl.html (anti-drift) ═══
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'wnba-bdl.html'), 'utf8');
const m = html.match(/\/\/ ── MATCHUP_SHEET_PURE_BEGIN[\s\S]*?function prepMatchupData([\s\S]*?)\/\/ ── MATCHUP_SHEET_PURE_END/);
if (!m) { console.log('EXTRACT FAILED — markers missing'); process.exit(1); }
const prepMatchupData = new Function('return function prepMatchupData' + m[1])();

let pass = 0, fail = 0;
const T = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

const mk = (w, l, over = {}) => ({ w, l, archetype: 'FLAT', updated_at: '2026-07-15T08:30:00Z', profile: {
  identity: { efg_diff: 2.4, to_margin: 1.3, fta_diff: -0.5, oreb_diff: 0.8 },
  tiers: { top: { w: 2, l: 6, n: 8, efg_diff: -3.1 }, rest: { w: 10, l: 4 }, insufficient: false },
  form: { l5: { w: 4, l: 1, own_efg_delta: 3.4, opp_efg_delta: -5.2, own_tag: 'HOT', opp_tag: 'OPPONENTS_COLD' } },
  h2h: { TOR: { w: 3, l: 0, avg_margin: 7 } }, ...over } });

console.log('BOTH SIDES PRESENT');
let d = prepMatchupData('TOR', 'WSH', { WSH: mk(12, 10), TOR: mk(10, 14, { h2h: { WSH: { w: 0, l: 3, avg_margin: -7 } } }) });
T('away side present', !!d.away && d.away.alias === 'WSH');
T('home side present', !!d.home && d.home.alias === 'TOR');
T('record passthrough', d.away.w === 12 && d.away.l === 10);
T('levers mapped', d.away.efgd === 2.4 && d.away.toMargin === 1.3 && d.away.fta === -0.5 && d.away.oreb === 0.8);
T('tier splits mapped', d.away.top.w === 2 && d.away.top.l === 6 && d.away.top.efgd === -3.1 && d.away.rest.w === 10);
T('L5 + tags', d.away.l5.w === 4 && d.away.l5.tags.length === 2 && d.away.l5.tags[0] === 'HOT');
T('h2h cross-referenced to opponent', d.away.h2h.w === 3 && d.away.h2h.l === 0 && d.away.h2h.avg === 7);
T('h2h opposite perspective', d.home.h2h.w === 0 && d.home.h2h.l === 3);

console.log('INFLATION BADGE');
// wp .545 (12-10); wpTop .25 (2-6), wpRest .714 (10-4) -> adj .482 -> infl +.06 -> HONEST
T('honest inside threshold', d.away.badge === 'HONEST' && Math.abs(d.away.infl - 0.06) < 0.011);
// inflated: 14-8 (.636) with top 1-7 (.125), rest 13-1 (.929) -> adj .527 -> +.11 INFLATED
d = prepMatchupData('TOR', 'WSH', { WSH: mk(14, 8, { tiers: { top: { w: 1, l: 7, n: 8, efg_diff: -5 }, rest: { w: 13, l: 1 }, insufficient: false } }), TOR: mk(10, 14) });
T('inflated at >= +.10', d.away.badge === 'INFLATED');
// deflated: 8-14 (.364) with top 4-4 (.5), rest 4-10 (.286) -> adj .393... make stronger: top 5-3 (.625), rest 3-11 (.214) -> adj .420 -> -.056 HONEST; use top 6-2 (.75), rest 2-12 (.143) -> adj .446 -> -.08 HONEST; top 7-1 (.875), rest 1-13 (.071) -> adj .473 -> -.11 DEFLATED
d = prepMatchupData('TOR', 'WSH', { WSH: mk(8, 14, { tiers: { top: { w: 7, l: 1, n: 8, efg_diff: 4 }, rest: { w: 1, l: 13 }, insufficient: false } }), TOR: mk(10, 14) });
T('deflated at <= -.10', d.away.badge === 'DEFLATED');
// tier cells < 2 games fall back to overall -> infl 0 -> HONEST
d = prepMatchupData('TOR', 'WSH', { WSH: mk(12, 10, { tiers: { top: { w: 1, l: 0, n: 1, efg_diff: 2 }, rest: { w: 11, l: 10 }, insufficient: true } }), TOR: mk(10, 14) });
T('small-n top cell falls back (infl ~0, HONEST)', d.away.badge === 'HONEST' && Math.abs(d.away.infl) < 0.06);
T('insufficient flag passthrough', d.away.insufficient === true);

console.log('DEGRADATION');
d = prepMatchupData('TOR', 'WSH', { TOR: mk(10, 14) });
T('missing away -> null side', d.away === null && !!d.home);
d = prepMatchupData('TOR', 'WSH', {});
T('empty map -> both null', d.away === null && d.home === null);
d = prepMatchupData('TOR', 'WSH', { WSH: mk(12, 10, { h2h: {} }), TOR: mk(10, 14, { h2h: {} }) });
T('no meetings -> h2h null', d.away.h2h === null);
d = prepMatchupData('TOR', 'WSH', { WSH: { w: 5, l: 5, archetype: 'FLAT', profile: {} }, TOR: mk(10, 14) });
T('bare profile degrades (levers em-dash-able, no throw)', d.away.efgd === null && d.away.l5 === null && d.away.top === null);
T('bare profile infl falls back to 0 HONEST', d.away.badge === 'HONEST');

console.log(`\n${pass}/${pass + fail} passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

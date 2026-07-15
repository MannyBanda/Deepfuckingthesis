// ═══ MATCHUP SHEET FIXTURES — extracts prepMatchupData from wnba-bdl.html (anti-drift) ═══
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'wnba-bdl.html'), 'utf8');
const m = html.match(/\/\/ ── MATCHUP_SHEET_PURE_BEGIN[\s\S]*?function prepMatchupData([\s\S]*?)\/\/ ── MATCHUP_SHEET_PURE_END/);
if (!m) { console.log('EXTRACT FAILED — markers missing'); process.exit(1); }
const prepMatchupData = new Function('return function prepMatchupData' + m[1])();
const m2 = html.match(/\/\/ ── MATCHUP_CMP_PURE_BEGIN[\s\S]*?function msCompare([\s\S]*?)\/\/ ── MATCHUP_CMP_PURE_END/);
if (!m2) { console.log('CMP EXTRACT FAILED — markers missing'); process.exit(1); }
const msCompare = new Function('return function msCompare' + m2[1])();

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

console.log('SCHEDULE-INFLATION BADGE (research/lane definition: vs-rest wp − vs-top wp)');
// GS anchor: 17-7 with top 2-6 (.250), rest 15-1 (.938) -> +.69 INFLATED
d = prepMatchupData('TOR', 'WSH', { WSH: mk(17, 7, { tiers: { top: { w: 2, l: 6, n: 8, efg_diff: -5.8 }, rest: { w: 15, l: 1 }, insufficient: false } }), TOR: mk(10, 14) });
T('GS anchor -> INFLATED +.69', d.away.badge === 'INFLATED' && Math.abs(d.away.infl - 0.69) < 0.011);
// IND anchor: 14-9 with top 3-2 (.600), rest 11-7 (.611) -> +.01 HONEST
d = prepMatchupData('TOR', 'WSH', { WSH: mk(14, 9, { tiers: { top: { w: 3, l: 2, n: 5, efg_diff: 5.2 }, rest: { w: 11, l: 7 }, insufficient: false } }), TOR: mk(10, 14) });
T('IND anchor -> HONEST +.01', d.away.badge === 'HONEST' && Math.abs(d.away.infl - 0.01) < 0.011);
// MIN anchor: top 6-2 (.750), rest 9-5 (.643) -> -.11 DEFLATED (lane territory)
d = prepMatchupData('TOR', 'WSH', { WSH: mk(15, 7, { tiers: { top: { w: 6, l: 2, n: 8, efg_diff: 3 }, rest: { w: 9, l: 5 }, insufficient: false } }), TOR: mk(10, 14) });
T('MIN anchor -> DEFLATED -.11', d.away.badge === 'DEFLATED' && Math.abs(d.away.infl + 0.11) < 0.011);
// tier cell < 2 games -> infl null, no badge (no fake HONEST 0)
d = prepMatchupData('TOR', 'WSH', { WSH: mk(12, 10, { tiers: { top: { w: 1, l: 0, n: 1, efg_diff: 2 }, rest: { w: 11, l: 10 }, insufficient: true } }), TOR: mk(10, 14) });
T('small-n top cell -> null badge', d.away.badge === null && d.away.infl === null);
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
T('bare profile -> null badge (no schedule split)', d.away.badge === null && d.away.infl === null);

console.log('COLOR COMPARE');
let c = msCompare(
  { w: 14, l: 8, efgd: 4.0, toMargin: 2.1, fta: 0.2, oreb: 0.1, top: { w: 5, l: 3 }, rest: { w: 9, l: 5 }, l5: { w: 4, l: 1 } },
  { w: 8, l: 14, efgd: -1.0, toMargin: 1.9, fta: -0.1, oreb: -0.2, top: { w: 1, l: 7 }, rest: { w: 7, l: 7 }, l5: { w: 2, l: 3 } });
T('clear winner -> away green (rec/efgd/top/l5)', c.rec === 'a' && c.efgd === 'a' && c.top === 'a' && c.l5 === 'a');
T('within-floor levers grey (toMargin 2.1v1.9, fta .2v-.1, oreb .1v-.2)', c.toMargin === 'even' && c.fta === 'even' && c.oreb === 'even');
T('vs rest .643 v .500 colored (gap > 10%/floor)', c.rest === 'a');
c = msCompare(
  { w: 12, l: 10, efgd: 8.0, toMargin: null, fta: 1.0, oreb: 0, top: { w: 2, l: 6 }, rest: null, l5: null },
  { w: 11, l: 11, efgd: 7.5, toMargin: 3.0, fta: -1.0, oreb: 0, top: { w: 2, l: 5 }, rest: null, l5: { w: 3, l: 2 } });
T('relative-10% grey (efgd 8 v 7.5)', c.efgd === 'even');
T('record within 5pts grey (.545 v .500)', c.rec === 'even');
T('null side -> even (toMargin, rest, l5)', c.toMargin === 'even' && c.rest === 'even' && c.l5 === 'even');
T('fta 1 v -1 colored home-lose', c.fta === 'a');
T('top .25 v .286 grey inside floor', c.top === 'even');
c = msCompare(null, { w: 10, l: 14, efgd: 1 });
T('whole side null -> all even, no throw', c.rec === 'even' && c.efgd === 'even');

console.log(`\n${pass}/${pass + fail} passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

// ══════════════════════════════════════════════════════════════════════════════
// ss_season26_fixtures.mjs — PARITY Amendment 2 §4: ssSeasonPanel pure logic.
// Extracts SS_SEASON26 + ssSeasonPanel from wnba-bdl.html (not retyped).
// Value-verify of the block lives in research/build_ss_season26.mjs — run both
// as the pre-push gate. Run: node research/ss_season26_fixtures.mjs
// ══════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
const HTML = readFileSync('wnba-bdl.html', 'utf8');
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const i = src.indexOf(sig); if (i < 0) throw new Error(`not found: ${name}`);
  const open = src.indexOf('{', src.indexOf(')', i));
  let d = 0, j = open;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}
const block = HTML.slice(HTML.indexOf('var SS_SEASON26'), HTML.indexOf('// SS_SEASON26_END'));
const panel = new Function(`${block};\n${extractFn(HTML, 'ssSeasonPanel')}; return ssSeasonPanel;`)();

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : fail++; if (!c) console.log(`  \u2717 ${n}`); };

// ── R4 suppression: Q4 inside 5:00 -> suspension copy, no cell rates render ──
let r = panel({ period: 4, clock: '3:12', margin: 5, gap: 0.22, leaderWp: 0.35 });
T('R4: Q4 3:12 suspends', r.includes('suspended (R4)') && r.includes('[2026]'));
T('R4: no deficit rates leak', !r.includes('62.9') && !r.includes('DEFICIT'));
r = panel({ period: 4, clock: null, margin: 5 });
T('R4: unknown Q4 clock degrades conservatively to suspension', r.includes('suspended (R4)'));
r = panel({ period: 4, clock: '7:30', margin: 5, gap: 0.22, leaderWp: 0.35 });
T('R4: Q4 7:30 renders (early), Q4-early highlighted', r.includes('DEFICIT') && /amber[^<]*">Q4-early/.test(r));

// ── header contract: [2026] tag + asof + games + WIN/HOLD framing ──
r = panel({ period: 2, clock: '5:00', margin: 5, gap: 0.22, leaderWp: 0.35, leaderEfg: 58 });
T('header: [2026] tag', r.includes('THIS SEASON [2026]'));
T('header: asof + games', r.includes('as of 2026-08-12') && r.includes('140 games'));
T('R2: trailer-WINS framing + HOLD label', r.includes('trailer-WINS') && r.includes('leads HOLD 65.0%'));

// ── raw render (PM decision): low-n cells print rate + n + LOW tag ──
T('raw: sub45 n=6 prints 16.7% [n=6 LOW]', r.includes('16.7% [n=6 LOW]'));
T('raw: power tags present (MED on preQ4 n=151)', r.includes('[n=151 MED]'));

// ── empty cell copy ──
T('leader.qual empty prints "no 2026 sample"', r.includes('no 2026 sample'));

// ── highlight selection ──
T('hl: margin 5 highlights d46', /amber[^<]*">4-6 60\.7%/.test(r));
T('hl: preQ4 highlighted for period 2', /amber[^<]*">pre-Q4 63\.6%/.test(r));
T('hl: gap .22 highlights qual tier', /amber[^<]*">\.15-\.35 54\.9%/.test(r));
T('hl: leader .35 highlights bad stratum', /amber[^<]*">&lt;\.400 58\.3%|amber[^<]*"><\.400 58\.3%/.test(r));
T('hl: eFG 58 highlights hot band', /amber[^<]*">>55 72\.7%|amber[^<]*">&gt;55 72\.7%/.test(r));
let r2 = panel({ period: 3, clock: '8:00', margin: 8, gap: 0.40, leaderWp: 0.45, leaderEfg: 50 });
T('hl: margin 8 -> d79, strong gap, mid leader, warm band', /amber[^<]*">7-9 40\.7%/.test(r2) && /amber[^<]*">\.35\+ 66\.7%/.test(r2) && /amber[^<]*">\.400-\.550 63\.8%/.test(r2) && /amber[^<]*">45-55 53\.8%/.test(r2));
let r3 = panel({ period: 2, clock: '5:00', margin: 12, gap: 0.22, leaderWp: 0.35 });
T('hl: out-of-band margin 12 highlights no deficit cell', !/amber[^<]*">(1-3|4-6|7-9)/.test(r3));
T('no-efg state: no eFG band highlighted', !/amber[^<]*">(<45|&lt;45|45-55|>55|&gt;55)/.test(r3));

console.log(`\nss_season26_fixtures: ${pass}/${pass + fail}${fail ? ' — FAIL' : ' — all green'}`);
process.exit(fail ? 1 : 0);

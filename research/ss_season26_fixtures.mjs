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
const dotAt = (html, pct) => html.includes(`left:${pct}%;width:12px`);
const dots = (html) => (html.match(/width:12px/g) || []).length;
const curRate = (html, txt) => {
  let i = -1; const M = '--green);font-weight:600">';
  while ((i = html.indexOf(M, i + 1)) !== -1) {
    const close = html.indexOf('<', i);
    if (html.slice(i + M.length, close).includes(txt)) return true;
  }
  return false;
};

// ── R4 suppression unchanged ──
let r = panel({ period: 4, clock: '3:12', margin: 5, gap: 0.22, leaderWp: 0.35 });
T('R4: Q4 3:12 suspends', r.includes('suspended (R4)') && r.includes('[2026]'));
T('R4: no rates leak', !r.includes('62.9') && !r.includes('DEFICIT'));
r = panel({ period: 4, clock: null, margin: 5 });
T('R4: unknown Q4 clock degrades to suspension', r.includes('suspended (R4)'));

// ── header + labels contract unchanged ──
r = panel({ period: 2, clock: '6:40', margin: 5, gap: 0.37, leaderWp: 0.26, leaderEfg: 58.2 });
T('header: [2026] + asof + games', r.includes('THIS SEASON [2026]') && r.includes('as of 2026-08-12') && r.includes('140 games'));
T('R2: trailer-WINS framing + HOLD', r.includes('trailer-WINS') && r.includes('leads HOLD 65.0%'));
T('raw: sub45 prints 16.7% [n=6 LOW]', r.includes('16.7% [n=6 LOW]'));
T('raw: MED tag on preQ4 n=151', r.includes('[n=151 MED]'));
T('leader.qual empty prints no 2026 sample', r.includes('no 2026 sample'));

// ── dot geometry (ATL@CON hypothetical) ──
T('deficit dot: margin 5 -> 50%', dotAt(r, '50'));
T('gap dot: .37 -> 61.7%', dotAt(r, '61.7'));
T('leader dot: .26 -> 18.3%', dotAt(r, '18.3'));
T('efg dot: 58.2 -> 62.7%', dotAt(r, '62.7'));
T('time dot: Q2 6:40 -> 31.1%', dotAt(r, '31.1'));
T('five dots render', dots(r) === 5);

// ── current-segment amber highlight ──
T('hl: 4-6 amber', curRate(r, '4-6 60.7%'));
T('hl: .35+ amber (gap .37 in strong)', curRate(r, '.35+ 66.7%'));
T('hl: <.400 amber', curRate(r, '45;.400 58.3%') || curRate(r, 'lt;.400 58.3%'));
T('hl: >55 amber', curRate(r, '55 72.7%'));
T('hl: pre-Q4 amber', curRate(r, 'pre-Q4 63.6%'));

// ── liveMargin precedence (the header-score sourcing) ──
r = panel({ period: 2, clock: '6:40', margin: 5, liveMargin: 8, gap: 0.22, leaderWp: 0.35 });
T('liveMargin 8 beats scoringComp 5: dot 83.3%', dotAt(r, '83.3') && !dotAt(r, '50'));
T('liveMargin 8: 7-9 amber not 4-6', curRate(r, '7-9 40.7%') && !curRate(r, '4-6 60.7%'));
T('liveMargin 8: label shows down 8', r.includes('down <b style="color:var(--green)">8</b>'));

// ── clamps + edge states ──
r = panel({ period: 3, clock: '8:00', liveMargin: 12, gap: 0.55, leaderWp: 0.45, leaderEfg: 50 });
T('out-of-band margin 12: dot pins 100%, no deficit cell amber', dotAt(r, '100') && !curRate(r, '1-3 62.9%') && !curRate(r, '4-6 60.7%') && !curRate(r, '7-9 40.7%'));
T('gap .55 -> 91.7%', dotAt(r, '91.7'));
T('mid leader .45 -> 50% + amber', dotAt(r, '50') && curRate(r, '.400-.550 63.8%'));
T('warm efg 50 -> 44.4% + amber', dotAt(r, '44.4') && curRate(r, '45-55 53.8%'));
r = panel({ period: 2, clock: '6:40', liveMargin: 0, gap: 0.22, leaderWp: 0.35 });
T('tied: dot 0%, label tied, no deficit amber', dotAt(r, '0') && r.includes('>tied</b>') && !curRate(r, '1-3 62.9%'));
r = panel({ period: 2, clock: '6:40', margin: 5, gap: 0.22, leaderWp: 0.35 });
T('missing eFG: 4 dots, no eFG band amber', dots(r) === 4 && !curRate(r, '16.7%') && !curRate(r, '53.8%') && !curRate(r, '72.7%'));
r = panel({ period: 4, clock: '7:30', margin: 5, gap: 0.22, leaderWp: 0.35 });
T('Q4 7:30: time dot 77.5% + Q4e amber', dotAt(r, '77.5') && curRate(r, 'Q4e 63.0%'));
// \u00a77 fire-time review states (renderer side): Q1 fires get a time dot
r = panel({ period: 1, clock: '1:57', margin: 5, gap: 0.355, leaderWp: 0.364, leaderEfg: 63.3 });
T('Q1 1:57 fire: time dot 18.8% (elapsed 8.05/30*70)', dotAt(r, '18.8'));
T('Q1 fire: pre-Q4 amber, five dots', curRate(r, 'pre-Q4 63.6%') && dots(r) === 5);
T('Q1 fire: gap .355 dot 59.2% + strong amber', dotAt(r, '59.2') && curRate(r, '.35+ 66.7%'));

// \u00a79 theme + empty-state pins
r = panel({ period: 2, clock: '6:40', margin: 5, gap: 0.37, leaderWp: 0.26, leaderEfg: 58.2 });
T('theme: green dot, no amber anywhere', r.includes('background:var(--green)') && !r.includes('var(--amber)'));
T('theme: grey tracks (#3a4149 live, #22262c dead)', r.includes('#3a4149') && r.includes('#22262c') && !r.includes('#2d3a4d'));
r = panel({});
T('empty state (reference-only): header renders, zero dots, zero highlights', r.includes('THIS SEASON [2026]') && dots(r) === 0 && !r.includes('--green);font-weight:600'));

console.log(`\nss_season26_fixtures: ${pass}/${pass + fail}${fail ? ' \u2014 FAIL' : ' \u2014 all green'}`);
process.exit(fail ? 1 : 0);

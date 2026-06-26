// ════════════════════════════════════════════════════════════════════════════
// SWEET-SPOT PARITY HARNESS (Phase 2a, Chunk 5)
// Proves the SERVER port (poll-live-bdl.mjs) reproduces the CLIENT gates
// (wnba-bdl.html, source of truth) EXACTLY. Both function sets are extracted from
// their ACTUAL files (not retyped) and run head-to-head on a battery that hits
// every branch + band/threshold boundary. eFG parity is judged by BAND, not raw
// value (per mitigation #1). Also asserts the canonical scenarios.
// Run: node research/ss_parity.mjs
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';

const POLL = readFileSync('netlify/functions/poll-live-bdl.mjs', 'utf8');
const HTML = readFileSync('wnba-bdl.html', 'utf8');

// ── brace-matched extraction of a `function NAME(...) {...}` from source ──
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
// extract `var EFG_BANDS = {...};`
function extractEfgBands(src) {
  const i = src.indexOf('EFG_BANDS');
  const open = src.indexOf('{', i);
  let depth = 0, j = open;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return 'var EFG_BANDS = ' + src.slice(open, j) + ';';
}

const FNS = ['efgTier', '_clkSec', 'americanToImplied', 'cbDepthRate',
             'divergenceRead', 'comebackProb', 'comebackEV', 'computeScoringComp'];

function buildModule(src, label) {
  let code = extractEfgBands(src) + '\n';
  for (const f of FNS) code += extractFn(src, f) + '\n';
  code += `return { ${FNS.join(', ')} };`;
  try {
    return new Function(code)();
  } catch (e) {
    console.error(`FAILED to build ${label} module:`, e.message);
    process.exit(1);
  }
}

const SRV = buildModule(POLL, 'server');
const CLI = buildModule(HTML, 'client');
console.log(`Extracted ${FNS.length} fns + EFG_BANDS from each file.\n`);

let checks = 0, fails = 0;
const failLog = [];
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function diff(label, s, c) {
  checks++;
  if (!eq(s, c)) { fails++; if (failLog.length < 25) failLog.push({ label, server: s, client: c }); }
}

// ── BATTERY 1: efgTier across every band boundary, all periods ──
for (const p of [1, 2, 3, 4]) {
  for (const efg of [49, 53, 54, 55, 56, 57, 58, 60, 61, 62, 63, 65, 66, 68, 69, 70, 72, 80, null, NaN]) {
    diff(`efgTier(${efg},${p})`, SRV.efgTier(efg, p), CLI.efgTier(efg, p));
  }
}
// ── BATTERY 2: _clkSec ──
for (const c of ['5:00', '2:30', '3:00', '1:00', '0:45', '180', '90', null, '', 'xx']) {
  diff(`_clkSec(${c})`, SRV._clkSec(c), CLI._clkSec(c));
}
// ── BATTERY 3: americanToImplied + cbDepthRate ──
for (const ml of [100, 120, 150, 200, 250, -110, -150, -250, 0, null]) {
  diff(`amToImp(${ml})`, SRV.americanToImplied(ml), CLI.americanToImplied(ml));
}
for (const d of [1, 5, 6, 9, 10, 14, 15, 19, 20, 25]) {
  diff(`cbDepth(${d})`, SRV.cbDepthRate(d), CLI.cbDepthRate(d));
}
// ── BATTERY 4: divergenceRead — sweep margin × efg × vPct × fga × period × clock ──
function mkSc(lead, trail, p, clk) {
  // lead/trail = {pts, efg, v, fga}; build home=lead, away=trail
  return {
    home: { total: lead.pts, efgBox: lead.efg, vPct: lead.v, fga: lead.fga, team: 'LDR' },
    away: { total: trail.pts, efgBox: trail.efg, vPct: trail.v, fga: trail.fga, team: 'TRL' },
    period: p, clock: clk
  };
}
let dCount = 0;
for (const margin of [0, 1, 2, 3, 5, 8, 9, 10, 12, 18]) {
  for (const efg of [50, 54, 55, 56, 61, 62, 66, 69, 70, 72]) {
    for (const v of [40, 45, 46, 55, 56, 60]) {
      for (const fga of [10, 12, 18]) {
        for (const p of [2, 3, 4]) {
          for (const clk of ['5:00', '2:30']) {
            const sc = mkSc({ pts: 50 + margin, efg, v, fga }, { pts: 50, efg: 50, v: 50, fga: 20 }, p, clk);
            diff(`divRead m${margin} e${efg} v${v} f${fga} p${p} ${clk}`, SRV.divergenceRead(sc), CLI.divergenceRead(sc));
            dCount++;
          }
        }
      }
    }
  }
}
// ── BATTERY 5: comebackProb — leaderWP × trailerWP × deficit × period × fadeRead ──
let cpCount = 0;
for (const lwp of [null, 0.30, 0.39, 0.40, 0.45]) {
  for (const twp of [null, 0.45, 0.50, 0.55, 0.62]) {
    for (const def of [3, 5, 6, 7, 8, 9, 14, 15, 19, 20]) {
      for (const p of [2, 3, 4]) {
        for (const fr of [null, { tier: 'STRONG FADE' }, { tier: 'LEAN FADE' }, { tier: 'NO FADE' }]) {
          diff(`cbProb l${lwp} t${twp} d${def} p${p} ${fr && fr.tier}`, SRV.comebackProb(lwp, twp, def, p, fr), CLI.comebackProb(lwp, twp, def, p, fr));
          cpCount++;
        }
      }
    }
  }
}
// ── BATTERY 6: comebackEV ──
for (const pp of [0.10, 0.40, 0.50, 0.56, 0.68, 0.85]) {
  for (const ml of [100, 120, 150, 200, 250, -110, -150, null]) {
    diff(`cbEV ${pp}/${ml}`, SRV.comebackEV(pp, ml), CLI.comebackEV(pp, ml));
  }
}
// ── BATTERY 7: computeScoringComp — zone distributions → classification ──
function mkSide(rimM, rimA, pntM, pntA, midM, midA, tM, tA) {
  return { rim: { made: rimM, att: rimA }, paint: { made: pntM, att: pntA }, mid: { made: midM, att: midA }, threes: { made: tM, att: tA } };
}
const sideGrid = [
  mkSide(8, 12, 6, 10, 4, 9, 2, 6),    // paint-heavy (structural)
  mkSide(2, 5, 3, 6, 5, 12, 10, 22),   // three/mid-heavy (variance)
  mkSide(5, 9, 5, 9, 5, 11, 5, 14),    // balanced
  mkSide(0, 0, 0, 0, 0, 0, 0, 0),      // empty
  mkSide(10, 14, 8, 11, 2, 5, 1, 4),   // heavy paint
];
let scCount = 0;
for (let hi = 0; hi < sideGrid.length; hi++) {
  for (let ai = 0; ai < sideGrid.length; ai++) {
    for (const [hp, ap] of [[60, 50], [50, 60], [55, 55], [70, 52], [48, 70]]) {
      const pbp = { home: sideGrid[hi], away: sideGrid[ai] };
      diff(`scComp h${hi} a${ai} ${hp}-${ap}`, SRV.computeScoringComp(pbp, 'H', 'A', hp, ap), CLI.computeScoringComp(pbp, 'H', 'A', hp, ap));
      scCount++;
    }
  }
}

console.log(`── PARITY BATTERY ──`);
console.log(`  divergenceRead: ${dCount} cases`);
console.log(`  comebackProb:   ${cpCount} cases`);
console.log(`  computeScoringComp: ${scCount} cases`);
console.log(`  total checks:   ${checks}`);
console.log(`  MISMATCHES:     ${fails}`);
if (fails) {
  console.log(`\n✗ PARITY FAIL — port diverges from client:`);
  for (const f of failLog) console.log(`  ${f.label}\n    server: ${JSON.stringify(f.server)}\n    client: ${JSON.stringify(f.client)}`);
} else {
  console.log(`\n✓ PARITY PASS — server port is byte-identical to client on every case.`);
}

// ── CANONICAL SCENARIO ASSERTIONS (the known traps + the A trigger) ──
console.log(`\n── CANONICAL SCENARIOS (server engine) ──`);
let sFail = 0;
function assert(name, cond, detail) { console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) sFail++; }

// ATL-banked: leader up 12 → BANKED regardless of heat (fade unavailable at margin>=10)
{
  const sc = mkSc({ pts: 62, efg: 72, v: 60, fga: 20 }, { pts: 50, efg: 50, v: 50, fga: 20 }, 3, '5:00');
  const r = SRV.divergenceRead(sc);
  assert('ATL-banked (margin 12 → BANKED, no fade)', r.label === 'BANKED' && r.tier === 'NO FADE', r.tier + '/' + r.label);
}
// POR-trap: leader is STRUCTURAL (low vPct) → never STRONG/LEAN FADE even if hot
{
  const sc = mkSc({ pts: 56, efg: 64, v: 35, fga: 20 }, { pts: 50, efg: 55, v: 60, fga: 20 }, 3, '5:00');
  const r = SRV.divergenceRead(sc);
  assert('POR-trap (structural leader → not a fade)', r.tier !== 'STRONG FADE' && r.tier !== 'LEAN FADE', r.tier + '/' + r.label);
}
// A-trigger fade: hot + variance + thin + pre-Q4 → STRONG FADE
{
  const sc = mkSc({ pts: 56, efg: 72, v: 60, fga: 20 }, { pts: 50, efg: 50, v: 50, fga: 20 }, 3, '5:00');
  const r = SRV.divergenceRead(sc);
  assert('A-fade (hot+variance+thin → STRONG FADE)', r.tier === 'STRONG FADE', r.tier + '/' + r.label);
}
// A-trigger collapse: bad leader + quality gap + short deficit → SHORT
{
  const pr = SRV.comebackProb(0.32, 0.60, 6, 3, { tier: 'STRONG FADE' });
  assert('A-collapse (sub-.40 leader, gap .28, deficit 6 → SHORT)', pr.tier === 'SHORT', pr.tier + ' p=' + (pr.pPoint && pr.pPoint.toFixed(2)));
}
// NO_QUALITY_EDGE: gap < .10 → blocked even if leader bad
{
  const pr = SRV.comebackProb(0.35, 0.42, 6, 3, { tier: 'STRONG FADE' });
  assert('NO_QUALITY_EDGE (gap .07 → blocked)', pr.tier === 'NO_QUALITY_EDGE', pr.tier);
}
// NO_EDGE: leader >= .40 → blocked
{
  const pr = SRV.comebackProb(0.45, 0.60, 6, 3, null);
  assert('NO_EDGE (leader .45 → blocked)', pr.tier === 'NO_EDGE', pr.tier);
}
// deficit 10-14 collapse-only (fade BANKED there): finding #1
{
  const sc = mkSc({ pts: 62, efg: 72, v: 60, fga: 20 }, { pts: 50, efg: 50, v: 50, fga: 20 }, 3, '5:00');
  const fr = SRV.divergenceRead(sc); // margin 12 → BANKED
  const pr = SRV.comebackProb(0.32, 0.60, 12, 3, fr);
  assert('deficit-12 = collapse-only (fade BANKED, collapse STRONG)', fr.label === 'BANKED' && pr.tier === 'STRONG', fr.label + ' / ' + pr.tier);
}

console.log(`\n${fails === 0 && sFail === 0 ? '✓✓ HARNESS GREEN' : '✗ HARNESS HAS FAILURES'} — parity ${fails === 0 ? 'PASS' : 'FAIL'}, scenarios ${sFail === 0 ? 'PASS' : sFail + ' FAIL'}`);
process.exit(fails === 0 && sFail === 0 ? 0 : 1);

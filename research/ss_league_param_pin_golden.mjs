// ════════════════════════════════════════════════════════════════════════════
// SS LEAGUE-PARAM GOLDEN PIN (NBA_SWEETSPOT_PORT_PHASE1_SPEC §4.1 / §5.1)
// Runs the PRE-REFACTOR inline Sweet Spot compute block (poll-live-bdl.mjs as of
// commit 3119e2f — the last commit before ssComputeShape existed) on the six shared
// inputs and writes the outputs to research/fixtures_ss_shape_golden.json.
// The block and its helpers are sliced from the git blob, never retyped, so the pin
// regenerates byte-for-byte from history at any time:  node research/ss_league_param_pin_golden.mjs
// The harness (research/ss_league_param_fixtures.mjs) asserts ssComputeShape('wnba', …)
// reproduces every pinned field exactly.
// ════════════════════════════════════════════════════════════════════════════
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { CASES, toLegacyArgs } from './ss_league_param_inputs.mjs';

const PRE_REFACTOR_COMMIT = '3119e2f';
const SRC = execSync(`git show ${PRE_REFACTOR_COMMIT}:netlify/functions/poll-live-bdl.mjs`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

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
function extractLine(src, startsWith) {
  const i = src.indexOf(startsWith);
  if (i < 0) throw new Error(`line not found: ${startsWith}`);
  return src.slice(i, src.indexOf('\n', i));
}
// The inline block: from `const _ssPbp = game._bdlPbp;` through `var _ssFired = _ssTier != null;`
// (two `if (...) {` blocks left open — closed below after the return).
const bStart = SRC.indexOf('const _ssPbp = game._bdlPbp;');
const bEndLine = 'var _ssFired = _ssTier != null;';
const bEnd = SRC.indexOf(bEndLine, bStart) + bEndLine.length;
if (bStart < 0 || bEnd < bEndLine.length) throw new Error('inline block not found in pre-refactor source');
const BLOCK = SRC.slice(bStart, bEnd);

const HELPERS = [
  extractLine(SRC, 'var EFG_BANDS = '),
  extractFn(SRC, 'efgTier'),
  extractLine(SRC, 'function _clkSec(c)'),
  extractLine(SRC, 'function americanToImplied(ml)'),
  extractLine(SRC, 'function cbDepthRate(d)'),
  extractFn(SRC, 'divergenceRead'),
  extractFn(SRC, 'comebackProb'),
  extractFn(SRC, 'comebackEV'),
  extractFn(SRC, 'computeScoringComp'),
  extractFn(SRC, 'ssClassifyTier'),
].join('\n');

const legacyShape = new Function('game', 'hA', 'aA', 'ind', 'summary', 'currentPeriod', 'clock', 'odds', 'ssStandings', `
${HELPERS}
${BLOCK}
      return {
        leadAl: _ssLeadAl, trailAl: _ssTrailAl, deficit: _ssDeficit, homeTrails: _ssHomeTrails,
        leadWP: _ssLeadWP, trailWP: _ssTrailWP, gap: _ssGap,
        leadEfg: _ssLeadEfg, leadBand: _ssLeadBand, varShare: _ssVar, cls: _ssClass,
        fadeT: _ssFadeT, collT: _ssCollT,
        pPoint: _ssPr.pPoint != null ? _ssPr.pPoint : null, pLow: _ssPr.pLow != null ? _ssPr.pLow : null, pHigh: _ssPr.pHigh != null ? _ssPr.pHigh : null,
        trailML: _ssTrailML != null ? _ssTrailML : null, implied: _ssImplied, edge: _ssEdge,
        kelly: (_ssEv && _ssEv.size != null) ? _ssEv.size : null,
        tier: _ssTier, softCell: _ssLad.softCell, ledgerSub: _ssLad.ledgerSub, fired: _ssFired,
      };
    }
  }
  return null;
`);

const pins = CASES.map((c) => {
  const a = toLegacyArgs(c);
  const out = legacyShape(a.game, a.hA, a.aA, a.ind, a.summary, a.currentPeriod, a.clock, a.odds, a.ssStandings);
  return { name: c.name, out };
});
const golden = { source_commit: PRE_REFACTOR_COMMIT, pinned_at: new Date().toISOString().slice(0, 10), cases: pins };
writeFileSync('research/fixtures_ss_shape_golden.json', JSON.stringify(golden, null, 2) + '\n');
console.log(`pinned ${pins.length} WNBA golden cases from ${PRE_REFACTOR_COMMIT} → research/fixtures_ss_shape_golden.json`);
pins.forEach((p) => console.log(`  ${p.name}\n    → ${p.out ? `tier=${p.out.tier || 'none'} ledger=${p.out.ledgerSub || '—'} gap=${p.out.gap != null ? p.out.gap.toFixed(3) : 'null'} efg=${p.out.leadEfg != null ? p.out.leadEfg.toFixed(1) : 'null'} band=${p.out.leadBand || '—'} fade=${p.out.fadeT || '—'} coll=${p.out.collT || '—'} cls=${p.out.cls} edge=${p.out.edge != null ? p.out.edge.toFixed(3) : 'null'}` : 'null (early-out)'}`));

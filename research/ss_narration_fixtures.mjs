// ════════════════════════════════════════════════════════════════════════════
// SS NARRATION V2 FIXTURES (SWEETSPOT_NARRATION_V2_SPEC.md §8) — pure logic.
// Extracts ssImpliedToML, ssPriceLadder, ssBuildNarrationPrompt, ssBuildBriefPrompt
// from poll-live-bdl.mjs (not retyped). Pins: ladder math (row 304 regression,
// p=.76-class fire), edge-guaranteeing rounding, prompt section presence + order,
// word-budget instruction (150-190 target / 200 cap; brief 90/120), §2 exclusions
// (no floor score in prompt), no-prices-in-brief, framing rules carried.
// Run: node research/ss_narration_fixtures.mjs
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
const POLL = readFileSync('netlify/functions/poll-live-bdl.mjs', 'utf8');
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const i = src.indexOf(sig); if (i < 0) throw new Error(`not found: ${name}`);
  const open = src.indexOf('{', src.indexOf(')', i));
  let d = 0, j = open;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}
const fns = ['ssImpliedToML', 'ssPriceLadder', 'ssBuildNarrationPrompt', 'ssBuildBriefPrompt'];
const mod = new Function(`${fns.map((f) => extractFn(POLL, f)).join(';\n')}; return { ${fns.join(', ')} };`)();
const { ssImpliedToML, ssPriceLadder, ssBuildNarrationPrompt, ssBuildBriefPrompt } = mod;

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\u2713' : '\u2717'} ${n}`); };
const implied = (ml) => ml > 0 ? 100 / (ml + 100) : (-ml) / ((-ml) + 100);

// ── ladder math ──
console.log('PRICE LADDER');
// Row 304 regression class: p=.7622 (spec: probe -196, full ~-127/-128; ±2 tolerance
// documented — edge-guaranteeing integer rounding vs the Jul 13 hand-derived pins)
const l304 = ssPriceLadder(0.7622, -310);
T(`row-304 probe ${l304.probeLine} within [-198,-194]`, l304.probeLine >= -198 && l304.probeLine <= -194);
T(`row-304 full ${l304.fullLine} within [-129,-125]`, l304.fullLine >= -129 && l304.fullLine <= -125);
T(`row-304 edge-now +0.4pp-class (got ${l304.edgeNowPP})`, Math.abs(l304.edgeNowPP - 0.6) <= 0.5);
T('probe line GUARANTEES >= +10pp', 0.7622 - implied(l304.probeLine) >= 0.0999);
T('full line GUARANTEES >= +20pp', 0.7622 - implied(l304.fullLine) >= 0.1999);
T('ladder text has all three rungs', l304.text.includes('captured price') && l304.text.includes('Probe territory') && l304.text.includes('Full tier size'));
// plus-money side
const lp = ssPriceLadder(0.55, 135);
T('p=.55 probe is plus-money', lp.probeLine > 0 && Math.abs(implied(lp.probeLine) - 0.45) < 0.01);
T('null p -> empty text, no crash', ssPriceLadder(null, -200).text === '');
T('null line -> rungs still render', ssPriceLadder(0.7, null).text.includes('Probe territory'));
T('monotonic: full is always longer odds than probe', (() => {
  for (const p of [0.35, 0.5, 0.65, 0.8, 0.9]) {
    const l = ssPriceLadder(p, -150);
    if (l.probeLine == null || l.fullLine == null) continue;
    if (implied(l.fullLine) > implied(l.probeLine)) return false;
  }
  return true;
})());
T('ssImpliedToML round-trips within tolerance', (() => {
  for (const q of [0.25, 0.4, 0.5622, 0.6622, 0.75, 0.9]) {
    const ml = ssImpliedToML(q);
    if (Math.abs(implied(ml) - q) > 0.006 || implied(ml) > q + 1e-9) return false;
  }
  return true;
})());

// ── fire narration prompt ──
console.log('\nFIRE NARRATION PROMPT');
const row = {
  alert_subtype: 'EFG_FADE', trailer_alias: 'MIN', leader_alias: 'PHX', margin: 7,
  period: 1, clock: '0:45', leader_efg: 68, leader_efg_band: 'EXTREME', variance_share: 61,
  lead_class: 'PERIMETER', trailer_wp: 0.75, leader_wp: 0.32, quality_gap: 0.406,
  collapse_true: 0.7622, implied: 0.756, line_used: -310,
};
const blocks = {
  ladderText: l304.text,
  quarterFlow: 'QUARTER FLOW (how the lead was built):\nQ1: MIN 18 - PHX 25 (3P MIN 1/5, PHX 5/8)\n',
  snapState: 'LIVE STATE (as of Q1 0:45, control team PHX): indicator reads I1-I5 (control-relative) 0.4/0.5/0.8/0.6/0.5 | trailer comeback path (TP): PROBABLE | leader safety (LS): AT RISK | structural model (XGB) 61% | Monte Carlo cumulative 58%\n',
  teamCtx: '\nTEAM CONTEXT (season priors — context only, small-n: treat splits as direction, not probabilities):\nMIN 18-6 SHOTMAKER — eFG diff +6.2pp\n',
  playerCtx: 'PLAYER CONTEXT + FRAMING RULES:\n- STAR carrier: X. Sample (28.4 ppg identity)\n',
};
const fp = ssBuildNarrationPrompt(row, blocks);
T('never re-decide framing present', fp.includes('never re-decide'));
T('4-part structure with price guidance as part 3', fp.includes('(3) Price guidance'));
T('word budget: 150-190 target + 200 hard cap', fp.includes('150-190 words') && fp.includes('200 words is a hard cap'));
T('ladder precedes contract, model told never to recompute', fp.indexOf('PRICE LADDER') < fp.indexOf('Write exactly 4') && fp.includes('never recompute'));
T('section order: ladder -> quarter flow -> live state -> team ctx -> player ctx', (() => {
  const idx = ['PRICE LADDER', 'QUARTER FLOW', 'LIVE STATE', 'TEAM CONTEXT', 'PLAYER CONTEXT'].map((k) => fp.indexOf(k));
  return idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]));
})());
T('STAR carrier rule wired when playerCtx present', fp.includes('sustaining at her norm'));
T('TP CONTESTED/BLOCK must-surface rule present', fp.includes('CONTESTED or BLOCK'));
T('§2 exclusion: no floor score leaks + explicit ban', !/floor[_ ]?score:? ?0?\.\d/i.test(fp) && fp.includes('never mention floor scores'));
T('eFG-heat non-predictive guard present', fp.includes('quality gap plus deficit plus price'));
T('full-name metric rule present', fp.includes('effective field-goal percentage'));
T('markdown ban present (ntfy renders asterisks literally)', fp.includes('NO markdown'));
const fpNoPctx = ssBuildNarrationPrompt(row, { ...blocks, playerCtx: '' });
T('carrier rule ABSENT when no player ctx', !fpNoPctx.includes('sustaining at her norm'));

// ── brief prompt ──
console.log('\nBRIEF PROMPT');
const bp = ssBuildBriefPrompt('TOR', 'WSH', { teamCtx: '\nTEAM CONTEXT (...):\nWSH 11-10 FLAT\n', liveLine: 'currently Q2 5:00' });
T('explicit no-position lead instruction', bp.includes('Lead with "No position"'));
T('3-part structure', bp.includes('(3) What would change it'));
T('brief budget: ~90 target / 120 cap', bp.includes('90 words') && bp.includes('120 words is a hard cap'));
T('NO prices/odds/lean — hard rule', bp.includes('no prices, no odds, no lean'));
T('no ladder in brief', !bp.includes('PRICE LADDER'));
T('anti-hallucination rule when ctx missing', bp.includes('rather than inventing one'));
T('markdown ban in brief', bp.includes('NO markdown'));
T('live line rendered', bp.includes('currently Q2 5:00'));
const bpBare = ssBuildBriefPrompt('TOR', 'WSH', {});
T('bare brief still valid, default reason present', bpBare.includes('No position') && bpBare.includes('too thin'));

console.log(`\n${pass}/${pass + fail} passed${fail ? ' \u2014 FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

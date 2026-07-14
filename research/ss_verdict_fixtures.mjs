// ════════════════════════════════════════════════════════════════════════════
// SS VERDICT STRIP FIXTURES (SWEETSPOT_VERDICT_STRIP_SPEC.md §7) — pure-logic layer.
// Extracts ssVerdictCompose + ssGapFmt from wnba-bdl.html; pins every V-state's copy
// verbatim, all 3 trap flags, priority collisions (V1>V2, T1>T4/T5), the IND@LV
// regression case (gap .148 → V4+T1), SEA@WSH (→ V2, no trap), V8 freeze, garbage
// line, and the no-abbreviation sweep. Live validation (fetch path, stale guard,
// render) is a deploy-night check per spec §7.
// Run: node research/ss_verdict_fixtures.mjs
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
const SRC = readFileSync('wnba-bdl.html', 'utf8');
function extract(name) {
  const sig = `function ${name}(`;
  const i = SRC.indexOf(sig); if (i < 0) throw new Error(`not found: ${name}`);
  const open = SRC.indexOf('{', SRC.indexOf(')', i));
  let d = 0, j = open;
  for (; j < SRC.length; j++) { if (SRC[j] === '{') d++; else if (SRC[j] === '}') { d--; if (!d) { j++; break; } } }
  return SRC.slice(i, j);
}
const ctx = extract('ssGapFmt') + ';' + extract('ssVerdictCompose');
const { ssVerdictCompose, ssGapFmt } = new Function(`${ctx}; return { ssVerdictCompose, ssGapFmt };`)();

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\u2713' : '\u2717'} ${n}`); };
const allTexts = [];
const C = (st) => { const r = ssVerdictCompose(st); allTexts.push(r.text); if (r.trap) allTexts.push(r.trap); return r; };

// ── gap formatting (display thresholds must never be crossed by rounding) ──
T('gapFmt .148 stays .148 (never rounds up across .15)', ssGapFmt(0.148) === '.148');
T('gapFmt .199 stays .199 (never rounds up across .20)', ssGapFmt(0.199) === '.199');
T('gapFmt .27 renders .27', ssGapFmt(0.27) === '.27');
T('gapFmt .334 renders .33', ssGapFmt(0.3339921) === '.33');
T('gapFmt .15 exact renders .15', ssGapFmt(0.15) === '.15');
T('gapFmt null returns null', ssGapFmt(null) === null);

// ── V0 ──
let r = C({ period: 1, homeAlias: 'CHI', awayAlias: 'DAL' });
T('V0 gates closed', r.v === 'V0' && r.text === 'Gates open in Q2 \u2014 no verdict yet.');

// ── V1 beats V0 (Q1 fire — PHX@MIN Jul 13, A fired Q1 0:45) ──
r = C({ period: 1, homePts: 20, awayPts: 24, homeAlias: 'MIN', awayAlias: 'PHX', leaderAlias: 'PHX',
  gap: 0.406, rows: [{ subtype: 'EFG_FADE', leader: 'PHX', trailer: 'MIN' }] });
T('V1 outranks V0 on a Q1 A fire', r.v === 'V1' && r.text === 'SWEET SPOT A LIVE \u2014 see the push for price and size.');

// ── V1 A beats V2 (priority collision) ──
r = C({ period: 3, homePts: 60, awayPts: 55, homeAlias: 'DAL', awayAlias: 'CHI', leaderAlias: 'DAL',
  gap: 0.25, subtypes: ['WATCHLIST', 'EFG_FADE'] });
T('V1 A beats V2', r.v === 'V1' && r.text === 'SWEET SPOT A LIVE \u2014 see the push for price and size.');
T('V1 has no trap (not trap-eligible)', r.trap === null);

// ── V1 B ──
r = C({ period: 3, homePts: 60, awayPts: 55, homeAlias: 'DAL', awayAlias: 'CHI', leaderAlias: 'DAL',
  gap: 0.25, subtypes: ['EFG_FADE_SOFT'] });
T('V1 B soft', r.v === 'V1' && r.text === 'SWEET SPOT B LIVE \u2014 see the push for price and size.');

// ── V2 — SEA@WSH case (spec-named fixture: → V2, no trap) ──
r = C({ period: 2, homePts: 38, awayPts: 42, homeAlias: 'WSH', awayAlias: 'SEA', leaderAlias: 'SEA',
  gap: 0.27, leadClass: 'MIXED', efgBand: 'green', trailerWinsStruct: false, subtypes: ['WATCHLIST', 'GAP_BASE'] });
T('V2 SEA@WSH exact copy (above bar)', r.v === 'V2' && r.text ===
  'REVIEW \u2014 WSH is the much better team (.27 quality gap, above your .20 bar) trailing by 4. Bet gates haven\u2019t aligned; your read decides.');
T('V2 SEA@WSH no trap', r.trap === null);
T('V2 beats V3 when both rows exist', r.v === 'V2');

// ── V2 below-bar variant ──
r = C({ period: 2, homePts: 38, awayPts: 42, homeAlias: 'WSH', awayAlias: 'SEA', leaderAlias: 'SEA',
  gap: 0.17, leadClass: 'MIXED', efgBand: 'green', trailerWinsStruct: false, subtypes: ['WATCHLIST'] });
T('V2 below-bar clause', r.text.includes('(.17 quality gap, below your .20 bar)'));

// ── V3 — GAP_BASE ledger shape with counter ──
r = C({ period: 2, homePts: 40, awayPts: 44, homeAlias: 'DAL', awayAlias: 'CHI', leaderAlias: 'CHI',
  gap: 0.33, leadClass: 'MIXED', efgBand: 'green', trailerWinsStruct: false, subtypes: ['GAP_BASE'], gapBaseN: 3 });
T('V3 exact copy with 3/30 counter', r.v === 'V3' && r.text ===
  'GAP SPOT, UNPROVEN \u2014 base gates pass but the fade reads don\u2019t. The ledger is collecting this shape (3/30 resolved so far). Not a validated bet.');

// ── V4 + T1 — the IND@LV regression case (spec-named fixture) ──
// gap .148, collapse NO_EDGE, lead classed VOLATILE but structural delta favors the
// trailer, leader band orange → V4 verdict, T1 trap (and T1 must beat T5).
r = C({ period: 3, homePts: 68, awayPts: 62, homeAlias: 'LV', awayAlias: 'IND', leaderAlias: 'LV',
  gap: 0.148, collapseTier: 'NO_EDGE', leadClass: 'VOLATILE', efgBand: 'orange',
  trailerWinsStruct: true, subtypes: [] });
T('IND@LV → V4', r.v === 'V4');
T('IND@LV gap renders .148 not .15', r.text.includes('quality gap (.148) is below the review line (.15)'));
T('IND@LV V4 exact copy', r.text ===
  'NO SPOT \u2014 quality gap (.148) is below the review line (.15). Anything taken here is the speculative stream \u2014 size like it.');
T('IND@LV → T1 (tested-and-killed shape)', r.trap ===
  '\u26a0 Trailer winning the structural battle below the gap bar is a tested-and-killed shape (Jun 21, 1-for-7 \u2014 the market prices visible structure).');
T('IND@LV T1 beats T5 despite orange band', r.trap.includes('tested-and-killed'));

// ── V4 with null gap ──
r = C({ period: 2, homePts: 40, awayPts: 36, homeAlias: 'ATL', awayAlias: 'GS', leaderAlias: 'ATL',
  gap: null, leadClass: 'MIXED', efgBand: 'green', trailerWinsStruct: false, subtypes: [] });
T('V4 null gap wording', r.v === 'V4' && r.text.includes('quality gap (no standings gap) is below the review line (.15)'));

// ── V5 — leader too good ──
r = C({ period: 3, homePts: 60, awayPts: 55, homeAlias: 'LV', awayAlias: 'IND', leaderAlias: 'LV',
  gap: 0.22, collapseTier: 'NO_EDGE', leadClass: 'MIXED', efgBand: 'green', trailerWinsStruct: false, subtypes: [] });
T('V5 exact copy', r.v === 'V5' && r.text ===
  'NO SPOT \u2014 LV wins too much to be a fade target, whatever the heat says. Anything taken here is the speculative stream \u2014 size like it.');

// ── V6 — out of band pre-Q4 ──
r = C({ period: 3, homePts: 70, awayPts: 58, homeAlias: 'CHI', awayAlias: 'ATL', leaderAlias: 'CHI',
  gap: 0.22, collapseTier: 'SHORT', leadClass: 'MIXED', efgBand: 'green', subtypes: [] });
T('V6 exact copy', r.v === 'V6' && r.text ===
  'OUT OF BAND \u2014 ATL down 12: leads this size are banked (regression erases single digits, not 12). No chasing from here.');
T('V6 not trap-eligible (STRUCTURAL lead would not flag)', C({ period: 3, homePts: 70, awayPts: 58,
  homeAlias: 'CHI', awayAlias: 'ATL', leaderAlias: 'CHI', gap: 0.22, collapseTier: 'SHORT',
  leadClass: 'STRUCTURAL', efgBand: 'green', subtypes: [] }).trap === null);

// ── V7 — Q4 deep collect + dead ──
r = C({ period: 4, homePts: 72, awayPts: 60, homeAlias: 'CHI', awayAlias: 'ATL', leaderAlias: 'CHI',
  gap: 0.22, collapseTier: 'SHORT', leadClass: 'MIXED', subtypes: [], q4CollapseN: 1 });
T('V7 collect exact copy', r.v === 'V7' && r.text === 'Q4 DEEP \u2014 unproven ledger shape, collecting (1/30). Not a validated bet.');
r = C({ period: 4, homePts: 80, awayPts: 62, homeAlias: 'CHI', awayAlias: 'ATL', leaderAlias: 'CHI',
  gap: 0.22, collapseTier: 'SHORT', leadClass: 'MIXED', subtypes: [] });
T('V7 dead exact copy', r.v === 'V7' && r.text === 'DEAD \u2014 out of range at this stage.');

// ── VX fallback (uncovered spec region — flagged as D-7 for PM review) ──
r = C({ period: 4, homePts: 68, awayPts: 62, homeAlias: 'LV', awayAlias: 'IND', leaderAlias: 'LV',
  gap: 0.22, collapseTier: 'SHORT', leadClass: 'MIXED', efgBand: 'green', trailerWinsStruct: false, subtypes: [] });
T('VX Q4 in-range no-row', r.v === 'VX' && r.text ===
  'NO PUSH \u2014 inside the range late (.22 quality gap, down 6 in Q4) but the watch window closed after Q3. Nothing fired; your read decides.');
r = C({ period: 3, homePts: 60, awayPts: 56, homeAlias: 'LV', awayAlias: 'IND', leaderAlias: 'LV',
  gap: 0.22, collapseTier: 'SHORT', leadClass: 'MIXED', efgBand: 'green', trailerWinsStruct: false, subtypes: [] });
T('VX pre-Q4 read forming', r.v === 'VX' && r.text ===
  'READ FORMING \u2014 gates are live but no alert row yet (next server read lands in about a minute).');

// ── T4 — structural leader, real gap (on V2) ──
r = C({ period: 2, homePts: 38, awayPts: 44, homeAlias: 'CHI', awayAlias: 'POR', leaderAlias: 'POR',
  gap: 0.24, leadClass: 'STRUCTURAL', efgBand: 'green', trailerWinsStruct: false, subtypes: ['WATCHLIST'] });
T('T4 POR@CHI rule exact copy', r.trap ===
  '\u26a0 Structural leader = the pass shape (POR@CHI rule). Conscious override territory only \u2014 probe size (CHI@DAL convention).');

// ── T1 via leadClass leg (STRUCTURAL below bar → T1 not T4) ──
r = C({ period: 2, homePts: 38, awayPts: 44, homeAlias: 'CHI', awayAlias: 'POR', leaderAlias: 'POR',
  gap: 0.18, leadClass: 'STRUCTURAL', efgBand: 'green', trailerWinsStruct: false, subtypes: ['WATCHLIST'] });
T('T1 via STRUCTURAL leadClass below .20', r.trap != null && r.trap.includes('tested-and-killed'));

// ── T5 — heat without gap ──
r = C({ period: 2, homePts: 44, awayPts: 38, homeAlias: 'GS', awayAlias: 'ATL', leaderAlias: 'GS',
  gap: 0.10, leadClass: 'MIXED', efgBand: 'red', trailerWinsStruct: false, subtypes: [] });
T('T5 hot=mirage exact copy', r.trap ===
  '\u26a0 Hot leader without a quality gap \u2014 the \u201chot = mirage\u201d family is 3x killed (NBA n=1,200; player-level; team-level). Heat only matters ON TOP of a gap.');

// ── V8 + row anchoring (D-7/D-8 amendment) — the CHI@DAL real-data regression ──
// Rows fired with leader CHI / trailer DAL; DAL completed the comeback so the LAST
// snapshot has leader DAL, gap negative. Verdict must fall through to current-state V4
// (row trailer no longer trailing) and the outcome must anchor to the ROW's trailer +
// games.winner — never the drifting snapshot.
const chiDalRows = [{ subtype: 'WATCHLIST', leader: 'CHI', trailer: 'DAL' }, { subtype: 'GAP_BASE', leader: 'CHI', trailer: 'DAL' }];
r = C({ period: 4, clock: '7.7', homePts: 96, awayPts: 91, homeAlias: 'DAL', awayAlias: 'CHI',
  leaderAlias: 'DAL', gap: -0.3339921, collapseTier: 'NO_EDGE', leadClass: 'VOLATILE', efgBand: 'green',
  trailerWinsStruct: false, rows: chiDalRows, gameStatus: 'closed', finalHome: 96, finalAway: 91, winner: 'DAL' });
T('CHI@DAL: row out of band → current-state V4 body', r.v === 'V8' && r.text.startsWith('NO SPOT \u2014 quality gap (-0.33) is below the review line (.15).'));
T('CHI@DAL: no negative-gap REVIEW garbage', !r.text.includes('much better team'));
T('CHI@DAL: outcome anchored to row trailer + winner', r.text.endsWith('Final 96-91 \u2014 DAL completed the comeback.'));
// NY@TOR — no-comeback, winner-based
r = C({ period: 4, homePts: 91, awayPts: 93, homeAlias: 'NY', awayAlias: 'TOR', leaderAlias: 'TOR',
  gap: 0.21, leadClass: 'MIXED', efgBand: 'green', trailerWinsStruct: false,
  rows: [{ subtype: 'WATCHLIST', leader: 'TOR', trailer: 'NY' }],
  gameStatus: 'closed', finalHome: 91, finalAway: 93, winner: 'TOR' });
T('V8 no-comeback (winner-based, row in band → REVIEW frozen)', r.v === 'V8' && r.text.startsWith('REVIEW \u2014 NY is the much better team') && r.text.endsWith('Final 93-91 \u2014 NY did not come back.'));

// ── live flip: watched trailer takes the lead mid-game → falls out of V2 ──
r = C({ period: 4, homePts: 78, awayPts: 75, homeAlias: 'DAL', awayAlias: 'CHI', leaderAlias: 'DAL',
  gap: -0.20, collapseTier: 'NO_EDGE', leadClass: 'MIXED', efgBand: 'green', trailerWinsStruct: false,
  rows: chiDalRows });
T('live flip → not V2, current-state V4', r.v === 'V4' && !r.text.includes('much better team'));

// ── D-7 blowout drift: stale WATCHLIST row must not outrank the deficit ceiling ──
r = C({ period: 3, homePts: 80, awayPts: 58, homeAlias: 'CHI', awayAlias: 'ATL', leaderAlias: 'CHI',
  gap: 0.22, collapseTier: 'SHORT', leadClass: 'MIXED', efgBand: 'green', trailerWinsStruct: false,
  rows: [{ subtype: 'WATCHLIST', leader: 'CHI', trailer: 'ATL' }] });
T('D-7: row down 22 pre-Q4 → V6 not V2', r.v === 'V6' && r.text.includes('ATL down 22'));
r = C({ period: 4, homePts: 72, awayPts: 60, homeAlias: 'CHI', awayAlias: 'ATL', leaderAlias: 'CHI',
  gap: 0.22, collapseTier: 'SHORT', leadClass: 'MIXED', efgBand: 'green', trailerWinsStruct: false,
  rows: [{ subtype: 'WATCHLIST', leader: 'CHI', trailer: 'ATL' }], q4CollapseN: 1 });
T('D-7: row down 12 in Q4 → V7 collect not V2', r.v === 'V7');

// ── in-band control: row-anchored V2 still fires with row trailer + row deficit ──
r = C({ period: 3, homePts: 66, awayPts: 60, homeAlias: 'CHI', awayAlias: 'DAL', leaderAlias: 'CHI',
  gap: 0.33, leadClass: 'MIXED', efgBand: 'green', trailerWinsStruct: false, rows: chiDalRows });
T('in-band row → V2 with row trailer, row deficit', r.v === 'V2' && r.text.includes('DAL is the much better team') && r.text.includes('trailing by 6'));

// ── garbage line append ──
r = C({ period: 3, homePts: 60, awayPts: 55, homeAlias: 'LV', awayAlias: 'IND', leaderAlias: 'LV',
  gap: 0.10, leadClass: 'MIXED', efgBand: 'green', trailerWinsStruct: false, subtypes: [], lineUsed: -50000 });
T('garbage line appended', r.text.endsWith('Line dead.'));

// ── no-abbreviation sweep on all produced copy ──
T('no abbreviations anywhere', allTexts.every(t => !/GAP_BASE|Q4_COLLAPSE|EFG_FADE|WATCHLIST|XGB|\bWP\b|\beFG\b|[Kk]elly|\d+pp\b/.test(t)));

console.log(`\n${pass}/${pass + fail} passed${fail ? ' \u2014 FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

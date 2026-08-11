// ══════════════════════════════════════════════════════════════════════════════
// ss_parity_fixtures.mjs — PARITY_SPEC Amendment 1 v3 §8: Items A+B pure logic.
// Extracts SS_STRUCT + ssLeadClassDisplay + ssGateLine + ssRiderEligible +
// ssCellRead from wnba-bdl.html (not retyped). Also enforces the ssLeadClassDisplay
// client/server function-text mirror (aliasMap treatment for the translation).
// SS_STRUCT byte-equality + value-verify live in research/build_ss_struct.mjs —
// run both as the pre-push gate. Run: node research/ss_parity_fixtures.mjs
// ══════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
const HTML = readFileSync('wnba-bdl.html', 'utf8');
const POLL = readFileSync('netlify/functions/poll-live-bdl.mjs', 'utf8');
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const i = src.indexOf(sig); if (i < 0) throw new Error(`not found: ${name}`);
  const open = src.indexOf('{', src.indexOf(')', i));
  let d = 0, j = open;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}
const structBlock = HTML.slice(HTML.indexOf('var SS_STRUCT'), HTML.indexOf('// SS_STRUCT_END'));
const fns = ['ssLeadClassDisplay', 'ssGateLine', 'ssRiderEligible', 'ssCellRead'];
const mod = new Function(`${structBlock};\n${fns.map((f) => extractFn(HTML, f)).join(';\n')}; return { ${fns.join(', ')} };`)();
const { ssLeadClassDisplay, ssGateLine, ssRiderEligible, ssCellRead } = mod;

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : fail++; if (!c) console.log(`  \u2717 ${n}`); };

// ── translation mirror: client function-text === server function-text ──
const bodyOf = (t) => t.slice(t.indexOf('{'));
T('ssLeadClassDisplay client/server function-body equality',
  bodyOf(extractFn(HTML, 'ssLeadClassDisplay')) === bodyOf(extractFn(POLL, 'ssLeadClassDisplay')));

// ── Item A: ssGateLine (>=8) ──
console.log('GATE LINE');
let r = ssGateLine({ gap: 0.36, leaderWp: 0.38, margin: 7, fuel: 'TRANSIENT (heat)', leadClass: 'VOLATILE', temp: 'warm' });
T('strong gap + fade country + transient variance-built',
  r.text === 'GAP .36 STRONG \u00b7 LDR .38 \u2192 FADE COUNTRY \u00b7 LEAD: transient \u00b7 variance-built' && r.country === 'FADE COUNTRY' && r.temp === 'warm');
r = ssGateLine({ gap: 0.19, leaderWp: 0.59, margin: 5, fuel: 'EARNED', leadClass: 'MIXED' });
T('qualified + watch-only + earned (mixed adds no qualifier)',
  r.text === 'GAP .19 qualified \u00b7 LDR .59 \u2192 WATCH-ONLY \u00b7 LEAD: earned');
T('below bar renders', ssGateLine({ gap: 0.08, leaderWp: 0.30, margin: 5, fuel: 'EARNED' }).text.indexOf('GAP .08 below bar') === 0);
T('thin margin overrides fuel (\u00a72 precedence)', ssGateLine({ gap: 0.20, leaderWp: 0.30, margin: 2, fuel: 'TRANSIENT (heat)', leadClass: 'VOLATILE' }).text.includes('LEAD: too thin to read'));
T('null gap -> GAP \u2014', ssGateLine({ leaderWp: 0.50, margin: 5, fuel: 'EARNED' }).text.indexOf('GAP \u2014') === 0);
T('null leaderWp -> LDR ? and null country', (() => { const x = ssGateLine({ gap: 0.20, margin: 5, fuel: 'EARNED' }); return x.text.includes('LDR ?') && x.country === null; })());
T('leader exactly .400 is WATCH-ONLY (< is strict)', ssGateLine({ gap: 0.20, leaderWp: 0.400, margin: 5, fuel: 'EARNED' }).country === 'WATCH-ONLY');
T('gap exactly .15 qualified / .35 STRONG', ssGateLine({ gap: 0.15, leaderWp: 0.3, margin: 5, fuel: 'EARNED' }).text.includes('qualified')
  && ssGateLine({ gap: 0.35, leaderWp: 0.3, margin: 5, fuel: 'EARNED' }).text.includes('STRONG'));
T('earned structural qualifier', ssGateLine({ gap: 0.22, leaderWp: 0.30, margin: 6, fuel: 'EARNED', leadClass: 'STRUCTURAL' }).text.includes('LEAD: earned \u00b7 structurally built'));
T('no fuel -> LEAD: \u2014', ssGateLine({ gap: 0.22, leaderWp: 0.30, margin: 6 }).text.includes('LEAD: \u2014'));

// ── R1 rider rule boundary ──
console.log('RIDER RULE (R1)');
T('exactly 10pp -> NO rider (strictly >10)', ssRiderEligible({ p: 50 }, { p: 60, n: 30 }) === false);
T('10.1pp + n=30 -> rider', ssRiderEligible({ p: 50 }, { p: 60.1, n: 30 }) === true);
T('11pp + n=29 -> NO rider', ssRiderEligible({ p: 50 }, { p: 61, n: 29 }) === false);
T('negative direction also rides', ssRiderEligible({ p: 60 }, { p: 49, n: 40 }) === true);
T('null-safe', ssRiderEligible(null, { p: 60, n: 40 }) === false && ssRiderEligible({ p: 50 }, null) === false);

// ── Item B: ssCellRead (>=10) ──
console.log('CELL READ v3');
const fadeBase = { gap: 0.20, leaderWp: 0.18, period: 3, clock: '6:00', leadClass: 'VOLATILE' };
r = ssCellRead({ ...fadeBase, margin: 5 });
T('fade d46 template + R1 rider (spec \u00a74 pinned)', r ===
  'FADE SHAPE \u2014 real gap (.20) on a .18 leader. Down 4-6 like this, trailers WIN ~39% historically [n=155] \u2014 running ~60% this season [n=55].');
T('fade d13: no rider (4.6pp below bar)', (() => { const x = ssCellRead({ ...fadeBase, margin: 2.5 }); return false; })() || (() => {
  const x = ssCellRead({ ...fadeBase, margin: 3 });
  return x.includes('Down 1-3') && x.includes('~61% historically [n=232]') && !x.includes('this season');
})());
T('fade d79: rider RENDERS (10.9pp, n=35 \u2014 mechanical R1; flagged to PM)', (() => {
  const x = ssCellRead({ ...fadeBase, margin: 8 });
  return x.includes('Down 7-9') && x.includes('~32% historically [n=97]') && x.includes('~43% this season [n=35]');
})());
T('hot leader adds hotCell rider [this season]', ssCellRead({ ...fadeBase, margin: 5, leaderEfg: 58 }).includes('Hot leader adds [this season: ~72%, n=50]'));
T('killer flag does NOT ride in v1 (EK chip owns it; hist provenance)', !ssCellRead({ ...fadeBase, margin: 5, leaderKiller: true }).includes('67'));
T('Q4-early: q4e base, no deficit rider', (() => {
  const x = ssCellRead({ ...fadeBase, period: 4, clock: '7:12', margin: 5 });
  return x.includes('In early Q4, trailers WIN ~38% [n=66]') && !x.includes('this season');
})());
T('R4: Q4 <5:00 suspension + HOLD copy', ssCellRead({ ...fadeBase, period: 4, clock: '4:59', margin: 5 }) ===
  'Inside 5:00 \u2014 comeback numbers suspended. Holding side: quality leads HOLD ~74% [n=264].');
T('R4: Q4 unknown clock degrades conservatively to suspension', ssCellRead({ ...fadeBase, period: 4, clock: null, margin: 5 }).includes('comeback numbers suspended'));
T('thin margin template (spec \u00a74 pinned)', ssCellRead({ gap: 0.22, leaderWp: 0.30, period: 3, clock: '6:00', margin: 2 }) ===
  'Margin too thin to read the lead. Gap qualified (.22); down 1-3, trailers WIN ~61% [n=232].');
T('watch-only quality template (MIN@DAL shape, spec \u00a74 pinned)', ssCellRead({ gap: 0.19, leaderWp: 0.59, period: 3, clock: '6:00', margin: 5 }) ===
  'WATCH-ONLY \u2014 real gap (.19) but the leader is quality (.59). The weakest qualified shape: trailers WIN ~35% [n=34, stable both seasons]. Price decides.');
T('watch-only mid-tier variant', (() => {
  const x = ssCellRead({ gap: 0.19, leaderWp: 0.48, period: 3, clock: '6:00', margin: 5 });
  return x.includes('mid-tier (.48)') && x.includes('WIN ~44% [n=134]') && x.includes('Price decides.');
})());
T('below-bar gap -> null (gate line owns it)', ssCellRead({ gap: 0.08, leaderWp: 0.30, period: 3, clock: '6:00', margin: 5 }) === null);
T('out-of-band deficit -> null', ssCellRead({ ...fadeBase, margin: 12 }) === null);
T('R2 audit: every rendered rate labeled WIN or HOLD', (() => {
  const states = [
    { ...fadeBase, margin: 5 }, { ...fadeBase, margin: 8, leaderEfg: 58 },
    { ...fadeBase, period: 4, clock: '3:00', margin: 5 },
    { gap: 0.22, leaderWp: 0.30, period: 3, clock: '6:00', margin: 2 },
    { gap: 0.19, leaderWp: 0.59, period: 3, clock: '6:00', margin: 5 },
  ];
  return states.every((s) => {
    const x = ssCellRead(s); if (x == null) return true;
    return /~\d+%/.test(x) ? (x.includes('WIN') || x.includes('HOLD')) : true;
  });
})());

console.log(`\n${pass}/${pass + fail} passed${fail ? ' \u2014 FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

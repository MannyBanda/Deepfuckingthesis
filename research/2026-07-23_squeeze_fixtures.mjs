// SQUEEZE_WATCH_SPEC v1.2 — copy + threshold fixture harness
// run: node research/2026-07-23_squeeze_fixtures.mjs
import { composeSqueeze, implied, leaderBandOf, trailerTempOf, efgFromRaw, probToAmerican, pickThreshold } from '../netlify/functions/odds-squeeze.mjs';
import { readFileSync } from 'fs';
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : (fail++, console.log('FAIL:', name)); };

// ── threshold math ──
ok('implied +117 = 46%', Math.abs(implied(117) - 0.4608) < 0.001);
ok('implied -150 = 60%', Math.abs(implied(-150) - 0.6) < 0.001);
ok('+155 crosses +117 (juicier)', implied(155) <= implied(117));
ok('+110 does not cross +117', implied(110) > implied(117));
ok('-140 crosses -150', implied(-140) <= implied(-150));
ok('-165 does not cross -150', implied(-165) > implied(-150));
ok('rearm: +140 to +170 = drop >= .035', implied(140) - implied(170) >= 0.035);
ok('rearm: +140 to +150 blocked', implied(140) - implied(150) < 0.035);
// ── F2 (Aug 6): engine-mirrored bands replace static bandOf ──
ok('leader bands Q2: 51 green / 58 orange / 66 red', leaderBandOf(51,2)==='green' && leaderBandOf(58,2)==='orange' && leaderBandOf(66,2)==='red');
ok('leader bands Q4 shift: 59 green / 62 orange / 70 red', leaderBandOf(59,4)==='green' && leaderBandOf(62,4)==='orange' && leaderBandOf(70,4)==='red');
ok('trailer temp absolute: 43 cold / 51 warm / 59 hot', trailerTempOf(43)==='cold' && trailerTempOf(51)==='warm' && trailerTempOf(59)==='hot');
ok('efgFromRaw math (8fgm 2fg3m 17fga = 52.9)', Math.abs(efgFromRaw({fgm:8,fg3m:2,fga:17}) - 52.94) < 0.1);
ok('efgFromRaw null on no attempts', efgFromRaw({fgm:0,fg3m:0,fga:0}) === null);
// mirror contract: EFG_BANDS in squeeze must be source-identical to poll-live-bdl
{
  const sq = readFileSync('netlify/functions/odds-squeeze.mjs','utf8');
  const pl = readFileSync('netlify/functions/poll-live-bdl.mjs','utf8');
  const bandsOf = (src) => (src.match(/EFG_BANDS = \{[^}]*\}/) || [''])[0].replace(/\s+/g,'');
  ok('EFG_BANDS mirror contract (squeeze == poll)', bandsOf(sq) !== '' && bandsOf(sq) === bandsOf(pl));
  const abs = (sq.match(/TEMP_ABS = \{[^}]*\}/) || [''])[0];
  ok('TEMP_ABS mirrors FUELTEMP_TH (45/55)', abs.includes('45') && abs.includes('55') && pl.includes('TEMP_ABS_COLD: 45') && pl.includes('TEMP_ABS_HOT: 55'));
}

// ── copy fixtures ──
const base = { trailer:'NY', leader:'CHI', price:-140, book:'williamhill_us', threshold:-150,
  cellRate:67, cellName:'killer cell', deficit:6, period:3, clock:'4:12',
  leaderEfg:66, leaderBand:'red', leaderVar:58, trailerEfg:51, trailerTemp:'warm', asOf:null,
  capLine:'Cap $300.', shopLine:'Caesars -140 | FanDuel -145 | DK -148', stale:false };

const A = composeSqueeze(base);
ok('A title', A.title === 'JUICE: NY -140 (Caesars)');
ok('A implied+cushion', A.body.includes('Implied 58% vs killer cell 67% (+9pp)'));
ok('A leader line', A.body.includes('CHI lead: 66% eFG (red) - 58% from threes/midrange.'));
ok('A trailer read (abs temp)', A.body.includes('NY own: 51% eFG (warm) - room to climb.'));
ok('A shop line', A.body.includes('Best: Caesars -140 | FanDuel -145 | DK -148.'));
ok('A non-directive', A.body.includes('Your read - not a directive.'));
ok('A ascii title', /^[\x00-\x7F]+$/.test(A.title));

const B = composeSqueeze({ ...base, trailer:'LV', leader:'WSH', price:145, book:'fanduel',
  threshold:117, cellRate:53, cellName:'no-scalp cell', deficit:4, clock:'7:50',
  leaderEfg:61, leaderBand:'orange', leaderVar:52, trailerEfg:54, capLine:'Lane spot ($600 cap, declare before entry).' });
ok('B title plus-price', B.title === 'JUICE: LV +145 (FanDuel)');
ok('B cushion math', B.body.includes('Implied 41% vs no-scalp cell 53% (+12pp)'));
ok('B lane cap line', B.body.includes('Lane spot ($600 cap, declare before entry). Your read - not a directive.'));

const C = composeSqueeze({ ...base, stale:true });
ok('C stale degrade (no snapshot at all)', C.body.includes('Live eFG read unavailable (no snapshot)') && !C.body.includes('CHI lead:'));
const C2 = composeSqueeze({ ...base, asOf:'read as of Q4 2:28' });
ok('C2 aged snapshot labels, never drops', C2.body.includes('CHI lead: 66% eFG (red) - 58% from threes/midrange (read as of Q4 2:28).'));

const D = composeSqueeze({ ...base, trailerEfg:43, trailerTemp:trailerTempOf(43) });
ok('D cold trailer warning', D.body.includes('cold - may not collect'));

const E = composeSqueeze({ ...base, trailerEfg:59, trailerTemp:trailerTempOf(59) });
ok('E hot trailer read', E.body.includes('running hot themselves'));

const F = composeSqueeze({ ...base, leaderVar:null });
ok('F no-var omits clause', F.body.includes('CHI lead: 66% eFG (red).'));

const G = composeSqueeze({ ...base, cellRate:53, price:155, threshold:117, cellName:'no-scalp cell' });
ok('G negative cushion prints honestly', G.body.includes('(-8pp)') || G.body.includes('(+'));

ok('A tap-opens line', A.body.includes('Tap opens: Caesars slip.'));
ok('B tap-opens best book', B.body.includes('Tap opens: FanDuel slip.'));

// ── ACA P2 (Aug 6): F5 cushion gate + real capLines + open-position line ──
const Q4 = composeSqueeze({ ...base, period:4, clock:'2:22' });
ok('F5: Q4 replaces cushion with provenance-honest line', Q4.body.includes('Fire-state cell rates no longer apply this late') && Q4.body.includes('Q4 re-entry recipe: down <=3, >=5:00 left, >=+200') && !Q4.body.includes('vs killer cell 67%'));
ok('F5: Q3 keeps the cushion', A.body.includes('vs killer cell 67%'));
const CAPS = { a:'$1,400 cap (A-tier). Staged adds = one position vs cap.', b:'$600 cap (B-tier). Staged adds = one position vs cap.',
  lane:'$300 cap - LANE team: $600 if declared before entry. Staged adds = one position vs cap.', w:'$300 cap (WATCHLIST). Staged adds = one position vs cap.' };
ok('capLine renders verbatim in body', composeSqueeze({ ...base, capLine:CAPS.lane }).body.includes(CAPS.lane));
const POS = composeSqueeze({ ...base, posLine:'You hold MIN $300 @ +195 - this alert is an ADD against the same position cap.' });
ok('open-position ADD line renders', POS.body.includes('this alert is an ADD against the same position cap'));
ok('no position line when absent', !A.body.includes('ADD against the same position cap'));
// source-level: placeholder capLine retired; lane stamp + column wired
{
  const sq = readFileSync('netlify/functions/odds-squeeze.mjs','utf8');
  const pl = readFileSync('netlify/functions/poll-live-bdl.mjs','utf8');
  ok('placeholder capLine retired', !sq.includes('Cap per tier rules'));
  ok('arm SELECT carries subtype + trailer_lane', sq.includes('sa.alert_subtype, sa.trailer_lane'));
  ok('fire-site lane stamp wired into INSERT', pl.includes('trailer_lane)') && pl.includes('ACA P2 \u2014 OVERRIDE_LANE trailer stamp'));
  // ── ACA P2b: shape-confirmation mirror contracts (verbatim source equality) ──
  const fnOf = (src, name) => {
    const i = src.indexOf(`function ${name}(`); if (i < 0) return null;
    let d = 0, j = src.indexOf('{', src.indexOf(')', i));
    for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
    return src.slice(i, j);
  };
  for (const nm of ['computeFuelTemp', 'ssCautionLines', 'efgTier'])
    ok(`${nm} mirror contract (squeeze == poll)`, fnOf(sq, nm) !== null && fnOf(sq, nm) === fnOf(pl, nm));
  ok('FUELTEMP_TH mirror contract', (sq.match(/var FUELTEMP_TH = \{[^}]*\}/) || [''])[0] !== '' && (sq.match(/var FUELTEMP_TH = \{[^}]*\}/) || [''])[0] === (pl.match(/var FUELTEMP_TH = \{[^}]*\}/) || ['x'])[0]);
}

// P2b compose pins
const SH = composeSqueeze({ ...base, shapeLine: 'SHAPE NOW (Q3 4:12): EARNED - trailer cold [STICKY]. Unchanged since fire.',
  cautionBlock: '- STICKY LEAD SHAPE (2026): earned lead against a cold, clean trailer (3 turnovers) \u2014 this season\'s toughest comeback shape. Context only, never a gate.\n' });
ok('P2b shape line renders', SH.body.includes('SHAPE NOW (Q3 4:12): EARNED - trailer cold [STICKY]. Unchanged since fire.'));
ok('P2b caution kernel renders before shop line', SH.body.indexOf('STICKY LEAD SHAPE (2026)') > -1 && SH.body.indexOf('STICKY LEAD SHAPE (2026)') < SH.body.indexOf('Best:'));
const SH2 = composeSqueeze({ ...base, shapeLine: 'SHAPE NOW (Q4 2:22): TRANSIENT (heat) - trailer warm. At fire: EARNED - trailer cold [STICKY] - SHAPE HAS CHANGED.' });
ok('P2b shape-changed variant renders', SH2.body.includes('SHAPE HAS CHANGED'));
ok('P2b absent when null', !A.body.includes('SHAPE NOW'));

// ── dynamic A-tier threshold (spec §4 dynamic mode, activated 7/28) ──
ok('probToAmerican .65 = -186', probToAmerican(0.65) === -186);
ok('probToAmerican .45 = +122', probToAmerican(0.45) === 122);
ok('probToAmerican clamps high', probToAmerican(0.99) === probToAmerican(0.90));
ok('A-tier flat -200 (PM policy 7/28)', pickThreshold({ alert_subtype:'EFG_FADE', leader_killer:false, line_used:-105, edge:0.097605444 }) === -200);
ok('row 818/26 replay: -130 crosses -200', implied(-130) <= implied(-200));
ok('-250 does not cross -200', implied(-250) > implied(-200));
ok('killer A takes -200 (tier trumps killer)', pickThreshold({ alert_subtype:'EFG_FADE', leader_killer:true }) === -200);
ok('killer WATCHLIST keeps -150', pickThreshold({ alert_subtype:'WATCHLIST', leader_killer:true }) === -150);
ok('WATCHLIST non-killer keeps +117', pickThreshold({ alert_subtype:'WATCHLIST', leader_killer:false }) === 117);

// ═══ v1.3 — bandStep (grace + suspend/resume) ═══════════════════════════════
import { bandStep } from '../netlify/functions/odds-squeeze.mjs';

// unit cells
ok('in-band fresh', bandStep(null, 5).mode === 'in_band' && bandStep(null, 5).oob === 0);
ok('in-band resets oob', bandStep({ oob_count: 2 }, 8).mode === 'in_band' && bandStep({ oob_count: 2 }, 8).oob === 0);
ok('def 10 = grace strike 1', bandStep({}, 10).mode === 'grace' && bandStep({}, 10).oob === 1);
ok('def 11 = grace (collar edge)', bandStep({ oob_count: 1 }, 11).mode === 'grace' && bandStep({ oob_count: 1 }, 11).oob === 2);
ok('def 12 = strike skip (beyond collar)', bandStep({}, 12).mode === 'strike_skip');
ok('def 0 tie = grace (neutral-WP read)', bandStep({}, 0).mode === 'grace');
ok('def -3 trailer leads = skip, no eval', bandStep({}, -3).mode === 'strike_skip' && bandStep({}, -3).oob === 1);
ok('3rd oob = suspend not terminal', bandStep({ oob_count: 2 }, 10).mode === 'suspend' && bandStep({ oob_count: 2 }, 10).suspended === true);
ok('suspended stays while oob', bandStep({ suspended: true, oob_count: 3 }, 12).mode === 'suspended');
ok('suspended + band re-entry = resume', (() => { const s = bandStep({ suspended: true, oob_count: 3 }, 9); return s.mode === 'resume' && s.oob === 0 && s.suspended === false; })());

// oscillation 9→10→9→10 never suspends (oob resets each re-entry)
{
  let st = {}; const modes = [];
  for (const d of [9, 10, 9, 10, 9]) { const s = bandStep(st, d); modes.push(s.mode); st = { oob_count: s.oob, suspended: s.suspended }; }
  ok('oscillation never suspends', modes.join(',') === 'in_band,grace,in_band,grace,in_band');
}

// hover at tie → suspend at 3 → resume when leader retakes
{
  let st = {}; const modes = [];
  for (const d of [0, 0, 0, 0, 3]) { const s = bandStep(st, d); modes.push(s.mode); st = { oob_count: s.oob, suspended: s.suspended }; }
  ok('tie hover: grace,grace,suspend,suspended,resume', modes.join(',') === 'grace,grace,suspend,suspended,resume');
}

// ── GOLDEN: row-1148 replay (Aug 4 TOR@GS incident, spec v1.3 §5) ──
// arm at def 9 → TOR extends 10/11 (v1.2 died here blind) → suspend → GS claws back → resume
{
  let st = {}; const modes = [];
  for (const d of [9, 10, 11, 11, 11, 10, 9, 8]) { const s = bandStep(st, d); modes.push(s.mode); st = { oob_count: s.oob, suspended: s.suspended }; }
  ok('row-1148 golden: strike 1 evals price (grace)', modes[1] === 'grace');
  ok('row-1148 golden: full arc', modes.join(',') === 'in_band,grace,grace,suspend,suspended,suspended,resume,in_band');
}

// ── v1.3 copy fixtures ──
const H = composeSqueeze({ ...base, deficit: 10, oobGrace: true });
ok('H grace tag on oob eval', H.body.includes('NY down 10, Q3 4:12 (out of band - grace read).'));
const I = composeSqueeze({ ...base, deficit: 0, oobGrace: true });
ok('I tie copy (no "down 0")', I.body.includes('NY tied it, Q3 4:12 (grace read).') && !I.body.includes('down 0'));
const J = composeSqueeze({ ...base, resumedAt: { period: 3, clock: '6:30' } });
ok('J resume breadcrumb', J.body.includes('Back in band since Q3 6:30.'));
ok('A normal deficit line untagged', A.body.includes('NY down 6, Q3 4:12.') && !A.body.includes('grace'));
ok('H ascii-safe', /^[\x00-\x7F]+$/.test(H.body) && /^[\x00-\x7F]+$/.test(I.body));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

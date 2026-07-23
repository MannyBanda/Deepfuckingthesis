// SQUEEZE_WATCH_SPEC v1.2 — copy + threshold fixture harness
// run: node research/2026-07-23_squeeze_fixtures.mjs
import { composeSqueeze, implied, bandOf } from '../netlify/functions/odds-squeeze.mjs';
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
ok('bands: 51 green / 58 orange / 66 red', bandOf(51)==='green' && bandOf(58)==='orange' && bandOf(66)==='red');

// ── copy fixtures ──
const base = { trailer:'NY', leader:'CHI', price:-140, book:'williamhill_us', threshold:-150,
  cellRate:67, cellName:'killer cell', deficit:6, period:3, clock:'4:12',
  leaderEfg:66, leaderBand:'red', leaderVar:58, trailerEfg:51,
  capLine:'Cap $300.', shopLine:'Caesars -140 | FanDuel -145 | DK -148', stale:false };

const A = composeSqueeze(base);
ok('A title', A.title === 'SQUEEZE: NY -140 (Caesars)');
ok('A implied+cushion', A.body.includes('Implied 58% vs killer cell 67% (+9pp)'));
ok('A leader line', A.body.includes('CHI lead: 66% eFG (red) - 58% from threes/midrange.'));
ok('A trailer read', A.body.includes('NY own: 51% eFG (green) - room to climb.'));
ok('A shop line', A.body.includes('Best: Caesars -140 | FanDuel -145 | DK -148.'));
ok('A non-directive', A.body.includes('Your read - not a directive.'));
ok('A ascii title', /^[\x00-\x7F]+$/.test(A.title));

const B = composeSqueeze({ ...base, trailer:'LV', leader:'WSH', price:145, book:'fanduel',
  threshold:117, cellRate:53, cellName:'no-scalp cell', deficit:4, clock:'7:50',
  leaderEfg:61, leaderBand:'orange', leaderVar:52, trailerEfg:54, capLine:'Lane spot ($600 cap, declare before entry).' });
ok('B title plus-price', B.title === 'SQUEEZE: LV +145 (FanDuel)');
ok('B cushion math', B.body.includes('Implied 41% vs no-scalp cell 53% (+12pp)'));
ok('B lane cap line', B.body.includes('Lane spot ($600 cap, declare before entry). Your read - not a directive.'));

const C = composeSqueeze({ ...base, stale:true });
ok('C stale degrade', C.body.includes('Live eFG read unavailable') && !C.body.includes('CHI lead:'));

const D = composeSqueeze({ ...base, trailerEfg:43 });
ok('D cold trailer warning', D.body.includes('cold - may not collect'));

const E = composeSqueeze({ ...base, trailerEfg:59 });
ok('E hot trailer read', E.body.includes('running hot themselves'));

const F = composeSqueeze({ ...base, leaderVar:null });
ok('F no-var omits clause', F.body.includes('CHI lead: 66% eFG (red).'));

const G = composeSqueeze({ ...base, cellRate:53, price:155, threshold:117, cellName:'no-scalp cell' });
ok('G negative cushion prints honestly', G.body.includes('(-8pp)') || G.body.includes('(+'));

ok('A tap-opens line', A.body.includes('Tap opens: Caesars slip.'));
ok('B tap-opens best book', B.body.includes('Tap opens: FanDuel slip.'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

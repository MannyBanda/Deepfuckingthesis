// ══════════════════════════════════════════════════════════════════════════════
// fine_arena_fixtures.mjs — FINE_ARENA_SPEC §6 harness.
// (1) genGrainMarks pins  (2) marks-param default identity on synthetic plays
// (3) paint accumulation behavior  (4) zone classifier equality vs poll-live-bdl
//     (Sets byte-compared; function behavior compared on coordinate-less corpus —
//     the walker mirror hardcodes the no-coords branch since WNBA plays carry none)
// (5) AS-OF GAP PIN (PM directive): records strictly BEFORE game date, never
//     closing-season  (6) tbucket mapping identical to the python label mapping.
// The states-level walker regression (rebuilt default-grain states ≡ committed
// fixtures_spec_cut_states.json) runs post-deploy via the rebuild script.
// Run: node research/fine_arena_fixtures.mjs
// ══════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
import { buildStates, buildTimeline, asOf, tbucketOfGameSec } from './fine_arena_states.mjs';
const BT = readFileSync('netlify/functions/backtest-wnba.mjs', 'utf8');
const POLL = readFileSync('netlify/functions/poll-live-bdl.mjs', 'utf8');
function extractFn(src, name) {
  const sig = `function ${name}(`;
  const i = src.indexOf(sig); if (i < 0) throw new Error(`not found: ${name}`);
  const open = src.indexOf('{', src.indexOf(')', i));
  let d = 0, j = open;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}
const extractConst = (src, name) => {
  const i = src.indexOf(`const ${name}`); if (i < 0) throw new Error(`not found: ${name}`);
  return src.slice(i, src.indexOf(';\n', i) + 1);
};
// build the walker sandbox (backtest copy)
const btSandbox = new Function(`${extractConst(BT, 'BDL_RIM_SET')}\n${extractConst(BT, 'BDL_PAINT_SET')}\nconst bdlCoordsValid = () => false;\n${extractFn(BT, 'coordinateToZoneServer')};\n${extractFn(BT, 'genGrainMarks')};\nconst WNBA_CHECKPOINTS = ${BT.slice(BT.indexOf('[', BT.indexOf('const WNBA_CHECKPOINTS')), BT.indexOf('];', BT.indexOf('const WNBA_CHECKPOINTS')) + 1)};\n${extractFn(BT, 'parseClockSec')};\n${extractFn(BT, 'reconstructCheckpoints')};\nreturn { coordinateToZoneServer, genGrainMarks, WNBA_CHECKPOINTS, reconstructCheckpoints };`)();
const { coordinateToZoneServer, genGrainMarks, WNBA_CHECKPOINTS, reconstructCheckpoints } = btSandbox;
// poll copy (stub its coord deps to the no-coords path)
const pollZone = new Function(`${extractConst(POLL, 'BDL_RIM_SET')}\n${extractConst(POLL, 'BDL_PAINT_SET')}\nconst bdlCoordsValid = () => false, BDL_CORNER_Y_MAX = 0, BDL_RIM_RADIUS = 0, BDL_PAINT_RADIUS = 0, BDL_THREE_RADIUS = 0;\nconst bdlDistFromBasket = () => 99;\n${extractFn(POLL, 'coordinateToZoneServer')};\nreturn coordinateToZoneServer;`)();

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : fail++; if (!c) console.log(`  \u2717 ${n}`); };

// ── (1) genGrainMarks pins ──
const m30 = genGrainMarks(30);
T('grain=30: 60 marks', m30.length === 60);
T('grain=30: first 630 / last 2400', m30[0].gameSec === 630 && m30[m30.length - 1].gameSec === 2400);
T('grain=30: 630 -> Q2 clock 570', m30[0].period === 2 && m30[0].clockSec === 570);
T('grain=30: 1200 -> Q2 clock 0 (period boundary belongs to closing quarter)',
  m30.find((x) => x.gameSec === 1200).period === 2 && m30.find((x) => x.gameSec === 1200).clockSec === 0);
T('grain=30: 1230 -> Q3 clock 570', m30.find((x) => x.gameSec === 1230).period === 3);
T('grain=30: labels unique', new Set(m30.map((x) => x.label)).size === 60);
T('grain=150 spans coarse family', genGrainMarks(150).some((x) => x.gameSec === 750) && genGrainMarks(150).some((x) => x.gameSec === 2250));

// ── (2)+(3) synthetic plays: default identity + paint behavior ──
const P = (order, period, clock, team, type, text, sv, hs, as_) => ({
  order, period, clock, team: { abbreviation: team }, type, text,
  scoring_play: sv != null, score_value: sv, home_score: hs, away_score: as_ });
const plays = [
  P(1, 2, '9:00', 'AAA', 'layup shot', 'X makes layup', 2, 2, 0),
  P(2, 2, '8:30', 'BBB', 'hook shot', 'Y makes hook shot', 2, 2, 2),
  P(3, 2, '8:00', 'AAA', 'jump shot', 'X makes 15-foot jump shot', 2, 4, 2),
  P(4, 2, '7:00', 'BBB', 'jump shot', 'Y makes three point jumper', 3, 4, 5),
  P(5, 2, '6:00', 'AAA', 'jump shot', 'X misses jump shot', null, 4, 5),
  P(6, 3, '5:00', 'BBB', 'turnover', 'Y lost ball turnover (X steals)', null, 4, 5),
  P(7, 4, '3:00', 'AAA', 'driving layup shot', 'X makes driving layup', 2, 6, 5),
];
const dflt = reconstructCheckpoints(plays, 'AAA', 'BBB');
const expl = reconstructCheckpoints(plays, 'AAA', 'BBB', WNBA_CHECKPOINTS);
T('default marks === explicit WNBA_CHECKPOINTS (identity)', JSON.stringify(dflt) === JSON.stringify(expl));
T('default: 11 snaps, labels preserved', dflt.length === 11 && dflt[0].cp.label === 'Q2_7.5' && dflt[10].cp.label === 'Q4_2.5');
const last = dflt[dflt.length - 1];
T('paint: layups+hook counted, mid + 3 excluded (A=2 paint of 3 fgm, B=1 of 2)',
  last.home.paintM === 2 && last.away.paintM === 1);
T('legacy fields intact (fgm/f3m/stl)', last.home.fgm === 3 && last.away.fg3m === 1 && last.home.stl === 1);
const fine = reconstructCheckpoints(plays, 'AAA', 'BBB', genGrainMarks(30));
T('grain=30 walk: 60 snaps, same final accumulation as default', fine.length === 60 &&
  fine[fine.length - 1].home.fgm === last.home.fgm && fine[fine.length - 1].away.paintM === last.away.paintM);

// ── (4) zone classifier equality vs poll ──
T('RIM/PAINT sets byte-identical to poll', extractConst(BT, 'BDL_RIM_SET').replace(/\s+/g, ' ') === extractConst(POLL, 'BDL_RIM_SET').replace(/\s+/g, ' ')
  && extractConst(BT, 'BDL_PAINT_SET').replace(/\s+/g, ' ') === extractConst(POLL, 'BDL_PAINT_SET').replace(/\s+/g, ' '));
const corpus = [
  ['layup shot', 'X makes layup', 2], ['driving dunk shot', 'X makes dunk', 2],
  ['hook shot', 'Y makes hook', 2], ['floating jump shot', 'Y floater', 2],
  ['jump shot', 'X makes 3-foot shot', 2], ['jump shot', 'X makes 8-foot shot', 2],
  ['jump shot', 'X makes 15-foot jumper', 2], ['jump shot', 'X makes 23-foot shot', 2],
  ['jump shot', 'makes three point jumper', 3], ['step back jumpshot', 'X misses', null],
  ['tip shot', 'X tip in', 2], ['turnaround hook shot', 'Y makes', 2],
  ['pullup jump shot', 'X makes pullup', 2], ['', 'X makes floater', 2],
];
T('zone behavior === poll on coordinate-less corpus (n=' + corpus.length + ')',
  corpus.every(([ty, tx, sv]) => coordinateToZoneServer(null, null, ty, tx, sv) === pollZone(null, null, ty, tx, sv)));

// ── (5) AS-OF GAP PIN (PM directive: never closing-season records) ──
{
  // AAA: loses its LAST 10 games late in the season. As-of mid-season AAA is 10-0;
  // closing season AAA is 10-10. The state's gap must use the 10-0.
  const mkG = (i, date, home, away, winner) => ({ game_id: `g${i}`, season: 2024, date,
    home, away, winner, checkpoints: [] });
  const sched = [];
  for (let i = 1; i <= 10; i++) sched.push(mkG(i, `2024-06-${String(i).padStart(2, '0')}`, 'AAA', 'CCC', 'AAA'));
  for (let i = 1; i <= 12; i++) sched.push(mkG(100 + i, `2024-06-${String(10 + i).padStart(2, '0')}`, 'BBB', 'DDD', i <= 6 ? 'BBB' : 'DDD'));
  for (let i = 1; i <= 10; i++) sched.push(mkG(200 + i, `2024-07-${String(i).padStart(2, '0')}`, 'AAA', 'DDD', 'DDD'));
  const stateGame = { game_id: 'gx', season: 2024, date: '2024-06-23', home: 'AAA', away: 'BBB', winner: 'BBB',
    checkpoints: [{ label: 'Q2_7.5', period: 2, gameSec: 750,
      home: { pts: 30, fgm: 12, fga: 24, f3m: 2, ftm: 4, to: 3, pot: 2 },
      away: { pts: 25, fgm: 10, fga: 22, f3m: 1, ftm: 4, to: 4, pot: 4 } }] };
  const S = buildStates([...sched, stateGame]);
  T('as-of: exactly one state built', S.length === 1);
  const st = S[0];
  T('as-of: leader AAA wp = 1.000 (10-0 as-of, NOT 10-10 closing = .500)', st && st.leader === 'AAA' && st.lwp === 1);
  T('as-of: trailer BBB pre-date record (12 gp, .500)', st && st.tgp === 12 && st.twp === 0.5);
  const tl = buildTimeline([...sched, stateGame]);
  T('as-of: strictly < (same-date games excluded)', asOf(tl, 'AAA', '2024-06-05').gp === 4);
}

// ── (6) tbucket mapping matches the python label mapping ──
T('tbucket: 750/900 early, 1050/1200 late (python parity)',
  tbucketOfGameSec(750) === 'Q2-early' && tbucketOfGameSec(900) === 'Q2-early'
  && tbucketOfGameSec(1050) === 'Q2-late' && tbucketOfGameSec(1200) === 'Q2-late'
  && tbucketOfGameSec(1950) === 'Q4-early' && tbucketOfGameSec(2250) === 'Q4-late');

console.log(`\nfine_arena_fixtures: ${pass}/${pass + fail} passed${fail ? ' \u2014 FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

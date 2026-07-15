// ════════════════════════════════════════════════════════════════════════════
// TEAM CONTEXT FIXTURES (TEAM_PROFILES_SPEC §6 consumption layer) — pure logic.
// Extracts composeTeamContext + composeTeamCtxLine from poll-live-bdl.mjs (not
// retyped). Pins: full-block content, all §6 degradation paths (missing one team,
// missing both, wrong league, unloaded map), 36h staleness note, tier small-n
// marker, one-liner archetype phrases, COLD/HOT suffix, and the no-jargon sweep
// on the subscriber-facing one-liner (block is Opus-facing — jargon allowed).
// Run: node research/team_ctx_fixtures.mjs
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
const shims = `const TEAM_CTX_ON = true; const log = () => {}; var _teamCtxMap = null;`;
const { composeTeamContext, composeTeamCtxLine } = new Function(
  `${shims}; ${extractFn(POLL, 'composeTeamContext')}; ${extractFn(POLL, 'composeTeamCtxLine')}; return { composeTeamContext, composeTeamCtxLine };`
)();

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\u2713' : '\u2717'} ${n}`); };

const mk = (w, l, archetype, over = {}) => ({
  w, l, archetype, league: 'wnba',
  updated_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), // fresh (2h)
  profile: {
    identity: { efg_diff: 6.2, to_margin: 1.4, fta_diff: 1.9, oreb_diff: -0.3, ...over.identity },
    tiers: { insufficient: false, top: { n: 6, w: 5, l: 1, efg_diff: 5.2 }, rest: { n: 18, w: 13, l: 5 }, ...over.tiers },
    form: { l5: { w: 3, l: 2, own_efg_delta: -1.1, opp_efg_delta: 10.3, own_tag: null, opp_tag: 'OPPONENTS_HOT', ...(over.l5 || {}) } },
    h2h: over.h2h || { PHX: { w: 3, l: 0, avg_margin: 9.3 } },
    schedule: { last_game_date: '2026-07-13', road_streak: over.road ?? 0 },
  },
});
const MAP = {
  MIN: mk(18, 6, 'SHOTMAKER'),
  PHX: mk(8, 17, 'SHOT_DEFICIT', { identity: { efg_diff: -4.2, to_margin: -0.3 }, tiers: { top: { n: 12, w: 2, l: 10, efg_diff: -5.6 }, rest: { n: 13, w: 6, l: 7 }, insufficient: false }, h2h: { MIN: { w: 0, l: 3, avg_margin: -9.3 } }, l5: { own_tag: null } }),
};

// ── full block ──
console.log('FULL BLOCK');
const b = composeTeamContext('MIN', 'PHX', 'wnba', MAP);
T('header present with small-n framing + TO-margin convention', b.includes('TEAM CONTEXT (season priors — context only, small-n: treat splits as direction, not probabilities; TO margin: + = forces more turnovers than it commits):'));
T('home line: record + archetype + levers', b.includes('MIN 18-6 SHOTMAKER — eFG diff +6.2pp, TO margin +1.4, FTA +1.9, OREB -0.3'));
T('tier split with strict-cutoff label', b.includes('vs top(>.600) 5-1 (eFG +5.2pp), vs rest 13-5'));
T('form with tag bracket', b.includes('L5 3-2, own eFG -1.1pp, opp eFG +10.3pp [OPPONENTS_HOT]'));
T('H2H cross-referenced to opponent', b.includes('H2H vs PHX: 3-0 (avg +9.3)'));
T('away line present', b.includes('PHX 8-17 SHOT_DEFICIT'));
T('no staleness note when fresh', !b.includes('stale'));
T('no road streak note at 0', !b.includes('road streak'));

// ── degradation paths (§6) ──
console.log('\nDEGRADATION');
const oneMissing = composeTeamContext('MIN', 'XXX', 'wnba', MAP);
T('missing away row -> home line only, no crash', oneMissing.includes('MIN 18-6') && !oneMissing.includes('XXX'));
T('both missing -> empty string', composeTeamContext('XXX', 'YYY', 'wnba', MAP) === '');
T('wrong league -> empty string (MIN alias collision guard)', composeTeamContext('MIN', 'PHX', 'nba', MAP) === '');
T('unloaded map -> empty string', composeTeamContext('MIN', 'PHX', 'wnba', null) === '');
T('undefined aliases -> empty string', composeTeamContext(undefined, undefined, 'wnba', MAP) === '');

// ── staleness ──
console.log('\nSTALENESS');
const staleMap = { MIN: { ...MAP.MIN, updated_at: new Date(Date.now() - 40 * 3600 * 1000).toISOString() }, PHX: MAP.PHX };
T('>36h -> staleness note appended', composeTeamContext('MIN', 'PHX', 'wnba', staleMap).includes('>36h stale'));

// ── tier small-n marker ──
const smallN = { MIN: mk(4, 2, 'SHOTMAKER', { tiers: { insufficient: true, top: { n: 2, w: 1, l: 1, efg_diff: 2.0 }, rest: { n: 4, w: 3, l: 1 } } }), PHX: MAP.PHX };
T('insufficient tiers -> small-n marker', composeTeamContext('MIN', 'PHX', 'wnba', smallN).includes('[tier splits small-n]'));

// ── road streak ──
const roadMap = { MIN: mk(18, 6, 'SHOTMAKER', { road: 4 }), PHX: MAP.PHX };
T('road streak >1 rendered', composeTeamContext('MIN', 'PHX', 'wnba', roadMap).includes('road streak 4'));

// ── one-liner ──
console.log('\nONE-LINER (subscriber-facing)');
const line = composeTeamCtxLine('MIN', 'PHX', 'wnba', MAP);
T('leads with trailer', line.startsWith('Season lens: MIN'));
T('trailer phrase + tier record', line.includes('MIN wins on shot-making and is 5-1 vs winning teams'));
T('leader phrase + tier record', line.includes('PHX gets outshot most nights and is 2-10 vs winning teams'));
T('no jargon in one-liner', !/eFG|TO margin|pp\b|SHOTMAKER|SHOT_DEFICIT|POSSESSION|DUAL_EDGE|FLAT|archetype|tier/i.test(line));
const archs = {
  DUAL_EDGE: 'wins on both shot-making and ball control',
  SHOTMAKER: 'wins on shot-making',
  POSSESSION_BULLY: 'wins on extra possessions, not shooting',
  POSSESSION_LEAN: 'leans on ball control',
  SHOT_DEFICIT: 'gets outshot most nights',
  FLAT: 'has no clear identity edge',
};
for (const [a, phrase] of Object.entries(archs)) {
  const m = { AAA: mk(10, 10, a, { h2h: {} }) };
  T(`${a} -> "${phrase}"`, composeTeamCtxLine('AAA', 'ZZZ', 'wnba', m).includes(phrase));
}
const coldMap = { AAA: mk(10, 10, 'SHOTMAKER', { l5: { own_tag: 'COLD' }, h2h: {} }) };
T('COLD form suffix', composeTeamCtxLine('AAA', 'ZZZ', 'wnba', coldMap).includes('(shooting cold lately)'));
const hotMap = { AAA: mk(10, 10, 'SHOTMAKER', { l5: { own_tag: 'HOT' }, h2h: {} }) };
T('HOT form suffix', composeTeamCtxLine('AAA', 'ZZZ', 'wnba', hotMap).includes('(shooting hot lately)'));
T('one-liner both missing -> empty', composeTeamCtxLine('XXX', 'YYY', 'wnba', MAP) === '');
T('one-liner wrong league -> empty', composeTeamCtxLine('MIN', 'PHX', 'nba', MAP) === '');

console.log(`\n${pass}/${pass + fail} passed${fail ? ' \u2014 FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

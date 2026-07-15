// ═══ CLIENT TEAM CTX FIXTURES — extracts prepMatchupData + composeClientTeamCtx from wnba-bdl.html ═══
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'wnba-bdl.html'), 'utf8');
const m1 = html.match(/\/\/ ── MATCHUP_SHEET_PURE_BEGIN[\s\S]*?function prepMatchupData([\s\S]*?)\/\/ ── MATCHUP_SHEET_PURE_END/);
const m2 = html.match(/\/\/ ── TEAM_CTX_COMPOSE_PURE_BEGIN[\s\S]*?function composeClientTeamCtx([\s\S]*?)\/\/ ── TEAM_CTX_COMPOSE_PURE_END/);
if (!m1 || !m2) { console.log('EXTRACT FAILED — markers missing'); process.exit(1); }
const prepMatchupData = new Function('return function prepMatchupData' + m1[1])();
const composeClientTeamCtx = new Function('prepMatchupData', 'return function composeClientTeamCtx' + m2[1])(prepMatchupData);

let pass = 0, fail = 0;
const T = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

const mk = (w, l, over = {}) => ({ w, l, archetype: 'FLAT', updated_at: '2026-07-15T08:30:00Z', profile: {
  identity: { efg_diff: 2.4, to_margin: 1.3, fta_diff: -0.5, oreb_diff: 0.8 },
  tiers: { top: { w: 2, l: 6, n: 8, efg_diff: -3.1 }, rest: { w: 10, l: 4 }, insufficient: false },
  form: { l5: { w: 4, l: 1, own_efg_delta: 3.4, opp_efg_delta: -5.2, own_tag: 'HOT', opp_tag: 'OPPONENTS_COLD' } },
  h2h: { TOR: { w: 3, l: 0, avg_margin: 7 } }, ...over } });

console.log('FULL BLOCK');
let b = composeClientTeamCtx('TOR', 'WSH', { WSH: mk(12, 10), TOR: mk(10, 14, { h2h: { WSH: { w: 0, l: 3, avg_margin: -7 } } }) });
T('header + small-n framing + TO-margin convention', b.includes('TEAM CONTEXT (season priors — context only, small-n: treat splits as direction, not probabilities; TO margin: + = forces more turnovers than it commits):'));
T('away line first with record + archetype + levers', b.split('\n')[1].startsWith('WSH 12-10 FLAT — eFG diff +2.4pp, TO margin +1.3, FTA -0.5, OREB +0.8'));
T('tier split rendered', b.includes('vs top(>.600) 2-6 (eFG -3.1pp), vs rest 10-4'));
T('L5 + tags', b.includes('L5 4-1, own eFG +3.4pp, opp eFG -5.2pp [HOT, OPPONENTS_COLD]'));
T('h2h cross-referenced both perspectives', b.includes('H2H vs TOR: 3-0 (avg +7)') && b.includes('H2H vs WSH: 0-3 (avg -7)'));
T('two team lines', b.split('\n').length === 3);

console.log('DEGRADATION');
b = composeClientTeamCtx('TOR', 'WSH', { TOR: mk(10, 14) });
T('missing away -> single home line, still valid block', b.split('\n').length === 2 && b.includes('TOR 10-14'));
T('empty map -> empty string', composeClientTeamCtx('TOR', 'WSH', {}) === '');
b = composeClientTeamCtx('TOR', 'WSH', { WSH: { w: 5, l: 5, archetype: 'FLAT', profile: {} }, TOR: mk(10, 14) });
T('bare profile -> ? placeholders, no throw', b.includes('WSH 5-5 FLAT — eFG diff ?pp'));

console.log('LENGTH CAP');
const longArch = 'X'.repeat(900);
b = composeClientTeamCtx('TOR', 'WSH', { WSH: mk(12, 10, {}), TOR: { w: 10, l: 14, archetype: longArch, profile: { identity: {}, h2h: {} } } });
T('capped at 1200 chars', b.length <= 1200);

console.log(`\n${pass}/${pass + fail} passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

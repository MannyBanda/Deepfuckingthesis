// ══════════════════════════════════════════════════════════════════════════════
// season_fixtures.mjs — SEASON_CONSOLIDATION_SPEC v1 §5
// Pins netlify/lib/season.js (derivation table, labels, prior, env override,
// warm-start pick, newest-<=-current selection, SR GP extraction, pinned prompt
// line) AND lints every production function + client for stray season
// literals. The literal class of bug is now a failing test. Run:
//   node research/season_fixtures.mjs
// ══════════════════════════════════════════════════════════════════════════════
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const S = require('../netlify/lib/season.js');

let pass = 0, fail = 0;
const T = (n, c, got) => { c ? pass++ : fail++; if (!c) console.log(`  ✗ ${n}${got !== undefined ? ' — got ' + JSON.stringify(got) : ''}`); };

// ── 1. derivation table (UTC dates) ──
delete process.env.DFT_SEASON_NBA; delete process.env.DFT_SEASON_WNBA; delete process.env.DFT_SEASON_NCAAMB;
const D = [
  ['nba', '2026-10-19', '2026'], ['nba', '2026-10-20', '2026'], ['nba', '2027-01-15', '2026'],
  ['nba', '2027-06-15', '2026'], ['nba', '2027-07-31', '2026'], ['nba', '2027-08-01', '2027'],
  ['ncaamb', '2026-11-05', '2026'], ['ncaamb', '2027-03-20', '2026'], ['ncaamb', '2027-08-15', '2027'],
  ['wnba', '2026-10-19', '2026'], ['wnba', '2027-01-15', '2026'], ['wnba', '2027-03-31', '2026'],
  ['wnba', '2027-04-01', '2027'], ['wnba', '2027-09-01', '2027'],
];
for (const [lg, dt, exp] of D) T(`seasonFor(${lg}, ${dt}) = ${exp}`, S.seasonFor(lg, dt) === exp, S.seasonFor(lg, dt));
T('seasonFor() with no date returns a 4-digit string', /^\d{4}$/.test(S.seasonFor('nba')), S.seasonFor('nba'));
T('seasonFor league is case-insensitive', S.seasonFor('NBA', '2026-10-19') === '2026');
T('seasonFor unknown league falls back to Aug-1 split-year', S.seasonFor('xyz', '2026-07-01') === '2025');

// ── 2. labels + prior ──
T("seasonLabel nba 2026 = '2026-27'", S.seasonLabel('nba', '2026') === '2026-27', S.seasonLabel('nba', '2026'));
T("seasonLabel nba 2025 = '2025-26'", S.seasonLabel('nba', '2025') === '2025-26');
T("seasonLabel nba 2099 = '2099-00' (pad)", S.seasonLabel('nba', '2099') === '2099-00', S.seasonLabel('nba', '2099'));
T("seasonLabel wnba 2026 = '2026'", S.seasonLabel('wnba', '2026') === '2026');
T("seasonLabel ncaamb 2026 = '2026-27'", S.seasonLabel('ncaamb', '2026') === '2026-27');
T("priorSeason nba '2026' = '2025'", S.priorSeason('nba', '2026') === '2025');
T('priorSeason wnba default = current-1', S.priorSeason('wnba') === String(Number(S.seasonFor('wnba')) - 1));

// ── 3. env override (emergency lever) ──
process.env.DFT_SEASON_NBA = '2031';
T('env override DFT_SEASON_NBA wins', S.seasonFor('nba', '2026-10-19') === '2031', S.seasonFor('nba', '2026-10-19'));
T('env override does not leak across leagues', S.seasonFor('wnba', '2026-10-19') === '2026');
delete process.env.DFT_SEASON_NBA;
T('env override cleared', S.seasonFor('nba', '2026-10-19') === '2026');

// ── 4. warm-start pick (BASELINES only) ──
const p0 = S.pickBaselineSeason('nba', 0, '2026'), p9 = S.pickBaselineSeason('nba', 9, '2026');
const p10 = S.pickBaselineSeason('nba', 10, '2026'), p11 = S.pickBaselineSeason('nba', 11, '2026');
T('GP 0 → prior', p0.season === '2025' && p0.source === 'prior' && p0.gp === 0, p0);
T('GP 9 → prior', p9.season === '2025' && p9.source === 'prior' && p9.gp === 9, p9);
T('GP 10 → current (inclusive bar)', p10.season === '2026' && p10.source === 'current' && p10.gp === 10, p10);
T('GP 11 → current', p11.season === '2026' && p11.source === 'current', p11);
T('GP null/undefined → prior with gp 0', S.pickBaselineSeason('nba', undefined, '2026').source === 'prior' && S.pickBaselineSeason('nba', null, '2026').gp === 0);
T("GP '12' string coerces → current", S.pickBaselineSeason('nba', '12', '2026').source === 'current');
T('WARM_START_GP exported = 10', S.WARM_START_GP === 10);
T('pick without season arg derives current', S.pickBaselineSeason('wnba', 20).season === S.seasonFor('wnba'));

// ── 5. artifacts: candidates + newestPerKey ──
const cands = S.seasonCandidates('nba', S.seasonLabel);
T('seasonCandidates nba labels [current, prior]', cands.length === 2 && cands[0] === S.seasonLabel('nba') && cands[1] === S.seasonLabel('nba', S.priorSeason('nba')), cands);
T('seasonCandidates default labelFn = start-year strings', S.seasonCandidates('nba')[0] === S.seasonFor('nba'));
const rows = [
  { team_alias: 'BOS', season: '2025-26', grip: 1 },
  { team_alias: 'BOS', season: '2026-27', grip: 2 },
  { team_alias: 'DET', season: '2025-26', grip: 3 },
  { team_alias: 'LAL', season: '2024-25', grip: 9 },   // too old — excluded
];
const nk = S.newestPerKey(rows, ['2026-27', '2025-26'], 'team_alias');
T('newestPerKey: BOS takes current row', nk.BOS && nk.BOS.grip === 2 && nk.BOS.season === '2026-27', nk.BOS);
T('newestPerKey: DET falls to prior row', nk.DET && nk.DET.grip === 3, nk.DET);
T('newestPerKey: LAL (older than prior) excluded', !nk.LAL);
T('newestPerKey strips _rank', nk.BOS && !('_rank' in nk.BOS));
T('newestPerKey order-independent', S.newestPerKey(rows.slice().reverse(), ['2026-27', '2025-26']).BOS.grip === 2);
T('newestPerKey empty/null rows → {}', Object.keys(S.newestPerKey(null, cands)).length === 0);

// ── 6. SR GP extraction ──
T('gpFromSRStats own_record.total.games_played', S.gpFromSRStats({ own_record: { total: { games_played: 7 } } }) === 7);
T('gpFromSRStats flat total', S.gpFromSRStats({ total: { games_played: 3 } }) === 3);
T('gpFromSRStats empty season → 0', S.gpFromSRStats({ own_record: { total: {} } }) === 0);
T('gpFromSRStats null → 0', S.gpFromSRStats(null) === 0 && S.gpFromSRStats(undefined) === 0);
T('gpFromSRStats proxy-normalized NCAAMB shape', S.gpFromSRStats({ team_records: [{ own_record: { total: { games_played: 12 } } }] }) === 12);
// live splits shape (verified Oct 2026): splits[].own_record.total.games_played; home+away sum to the season
const splitsResp = { splits: [
  { category: 'home', own_record: { total: { games_played: 41 } } },
  { category: 'away', own_record: { total: { games_played: 41 } } },
  { category: 'wins', own_record: { total: { games_played: 60 } } },
] };
T('gpFromSRSplits home+away = 82', S.gpFromSRSplits(splitsResp) === 82, S.gpFromSRSplits(splitsResp));
T('gpFromSRSplits falls back to max split when no home/away', S.gpFromSRSplits({ splits: [{ category: 'wins', own_record: { total: { games_played: 7 } } }] }) === 7);
T('gpFromSRSplits empty season → 0', S.gpFromSRSplits({ splits: [] }) === 0 && S.gpFromSRSplits(null) === 0);
const bp = S.srBaselinePaths('TEAMID', '2025');
T('srBaselinePaths shape', bp.stats === 'seasons/2025/REG/teams/TEAMID/statistics.json' && bp.splitsGame.endsWith('/splits/game.json') && bp.splitsSchedule.endsWith('/splits/schedule.json'), bp);

// ── 7. pinned prompt line ──
T('baselineLine empty when all current', S.baselineLine('nba', [{ alias: 'BOS', pick: p10 }, { alias: 'DET', pick: p11 }]) === '');
const bl = S.baselineLine('nba', [{ alias: 'BOS', pick: p10 }, { alias: 'DET', pick: p9 }]);
T('baselineLine names the prior label + the prior team only', bl.startsWith('BASELINE SEASON: 2025-26 (prior season) for DET 9 GP') && !bl.includes('BOS'), bl);
T('baselineLine names the 10-GP bar', bl.includes('10-GP'));
T('baselineLine two prior teams', S.baselineLine('nba', [{ alias: 'BOS', pick: p0 }, { alias: 'DET', pick: p9 }]).includes('BOS 0 GP, DET 9 GP'));

// ── 8. LINT: no season literals in production functions or clients ──
// Scope = every live function + every dashboard. Research tooling and backtest
// harnesses that legitimately name historical seasons are out of scope; the
// floor_wp writer in backtest-nba-snapshots is IN scope (its literal became a
// required param). A line may opt out with: // season-lint: allow
const SCOPE = [
  'netlify/functions/poll-live-bdl.mjs', 'netlify/functions/db-api.js', 'netlify/functions/sr-data.js',
  'netlify/functions/bdl-data.js', 'netlify/functions/bdl-enrich.js', 'netlify/functions/pregame-agent.mjs',
  'netlify/functions/generate-thesis.mjs', 'netlify/functions/post-game-agent.mjs',
  'netlify/functions/team-profiles-nightly.mjs', 'netlify/functions/odds-squeeze.mjs', 'netlify/functions/analyze.js',
  'netlify/functions/espn-data.js', 'netlify/functions/odds-api.js', 'netlify/functions/bdl-pbp-adapter.js',
  'netlify/functions/clutch-ocr.js', 'netlify/functions/backtest-nba-snapshots.mjs',
  'bdl.html', 'v3.html', 'wnba-bdl.html', 'ncaamb-bdl.html', 'debug.html',
];
const LIT = /['"]20[2-3][0-9](-[0-9]{2})?['"]|seasons?(\[\])?\s*[:=]\s*20[2-3][0-9]\b|seasons?(\[\])?=20[2-3][0-9]\b|\|\|\s*20[2-3][0-9]\b/;
const FULL_DATE = /['"]20[2-3][0-9]-[0-9]{2}-[0-9]{2}/;
let lintHits = [];
for (const f of SCOPE) {
  let src; try { src = readFileSync(f, 'utf8'); } catch (e) { lintHits.push(`${f}: unreadable (${e.message})`); continue; }
  src.split('\n').forEach((line, i) => {
    if (!LIT.test(line) || FULL_DATE.test(line) || line.includes('season-lint: allow')) return;
    lintHits.push(`${f}:${i + 1}: ${line.trim().slice(0, 110)}`);
  });
}
T(`LINT: zero season literals in ${SCOPE.length} production files`, lintHits.length === 0);
if (lintHits.length) lintHits.forEach((h) => console.log('    ' + h));

console.log(`\nseason_fixtures: ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);

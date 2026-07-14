// ════════════════════════════════════════════════════════════════════════════
// TEAM PROFILES FIXTURES (TEAM_PROFILES_SPEC.md §9) — two layers:
//
//   1. ARCHETYPE RULES (always runs, pure/canned): table-driven cases pinning the
//      §5 lever thresholds and rule precedence — DUAL_EDGE > SHOTMAKER >
//      POSSESSION_BULLY > POSSESSION_LEAN > SHOT_DEFICIT > FLAT, boundary values
//      inclusive/exclusive exactly as specced.
//
//   2. ATL GOLDEN FIXTURE (needs data — runs when team_game_stats is populated):
//      pulls rows as-of 2026-07-04 via db-api get_team_game_stats&max_date=,
//      runs the SAME pure computeProfiles() the nightly uses, and asserts the
//      §2 session-derived numbers exactly:
//        POSSESSION_BULLY · TO margin +3.5 · FTA +4.8 · OREB +4.9 · eFG diff −5.2
//        top (≥.600): 1-6, eFG −11.1, TO +1.3, n=7 · rest: 11-3, n=14
//        L5: 0-5, own eFG −8.0 (COLD), opp eFG +6.1 (OPPONENTS_HOT)
//        H2H vs GS: 0-3, avg −6.3
//      Skips (exit 0 with SKIP notice) if the endpoint returns no rows — so the
//      archetype layer stays green pre-backfill.
//
// Run: node research/team_profiles_fixtures.mjs            (from repo root)
//      SKIP_GOLDEN=1 node research/team_profiles_fixtures.mjs
// ════════════════════════════════════════════════════════════════════════════
import { computeProfiles, classifyArchetype } from '../netlify/functions/team-profiles-nightly.mjs';

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\u2713' : '\u2717'} ${n}`); };
const close = (a, b, eps = 0.05) => a != null && b != null && Math.abs(a - b) <= eps;

// ── 1. Archetype rules, table-driven (efg_diff pp, to_margin) ──
const CASES = [
  // [efgDiff, toMargin, expected, note]
  [ 1.5,  2.0, 'DUAL_EDGE',        'both thresholds inclusive'],
  [ 3.0,  4.0, 'DUAL_EDGE',        'clear dual edge'],
  [ 2.0,  1.9, 'SHOTMAKER',        'eFG strong, TO below edge'],
  [ 4.0,  0.0, 'SHOTMAKER',        'pure shotmaker'],
  [ 1.9,  1.9, 'FLAT',             'eFG 1.5-2.0 band w/o TO edge is NOT shotmaker'],
  [-1.0,  2.5, 'POSSESSION_BULLY', 'ATL shape — both boundaries inclusive'],
  [-5.2,  3.5, 'POSSESSION_BULLY', 'ATL golden values'],
  [-0.9,  2.5, 'POSSESSION_LEAN',  'eFG above soft floor → lean, not bully'],
  [ 0.0,  2.0, 'POSSESSION_LEAN',  'TO edge inclusive, eFG mid-band'],
  [ 1.4,  2.2, 'POSSESSION_LEAN',  'eFG just under DUAL_EDGE floor'],
  [-2.0,  1.9, 'SHOT_DEFICIT',     'eFG deficit inclusive, TO below edge'],
  [-4.0,  0.0, 'SHOT_DEFICIT',     'clear shot deficit'],
  [-2.0,  2.2, 'FLAT',             'deficit + TO 2.0-2.5 falls through all rules'],
  [-1.5,  2.4, 'FLAT',             'eFG below lean band, TO below bully'],
  [ 0.0,  0.0, 'FLAT',             'no levers'],
  [ 1.0, -3.0, 'FLAT',             'negative TO margin, mild eFG'],
];
console.log('ARCHETYPE RULES');
for (const [e, t, want, note] of CASES) {
  const got = classifyArchetype(e, t);
  T(`(eFG ${e >= 0 ? '+' : ''}${e}, TO ${t >= 0 ? '+' : ''}${t}) -> ${want}  [${note}]`, got === want);
}

// ── computeProfiles smoke on canned rows (pure-layer sanity: form/h2h/tiers wiring) ──
const mkRow = (i, team, opp, pts, oppPts, efg, oppEfg, over = {}) => ({
  game_id: `g${i}`, team_alias: team, opp_alias: opp, league: 'wnba', season: 2026,
  date: `2026-06-${String(i + 1).padStart(2, '0')}`, is_home: i % 2 === 0,
  pts, opp_pts: oppPts, efg, opp_efg: oppEfg,
  to_ct: 12, opp_to_ct: 16, fta: 20, opp_fta: 15, oreb: 10, opp_oreb: 5,
  fg3m: 8, fg3a: 24, opp_fg3m: 6, opp_fg3a: 20, ...over,
});
const canned = [];
for (let i = 0; i < 8; i++) {
  const aWins = i < 5; // AAA wins first 5, drops last 3 (cold window)
  const aEfg = i < 5 ? 0.52 : 0.44;
  canned.push(mkRow(i, 'AAA', 'BBB', aWins ? 90 : 70, aWins ? 80 : 85, aEfg, 0.46));
  canned.push(mkRow(i, 'BBB', 'AAA', aWins ? 80 : 85, aWins ? 90 : 70, 0.46, aEfg,
    { to_ct: 16, opp_to_ct: 12, fta: 15, opp_fta: 20, oreb: 5, opp_oreb: 10, fg3m: 6, fg3a: 20, opp_fg3m: 8, opp_fg3a: 24 }));
}
// NOTE: canned rows carry no fgm/fga primitives -> exercises aggEfg's per-row-efg
// FALLBACK path. The aggregate path is pinned separately below + by the ATL golden.
console.log('\nPURE-LAYER SMOKE (canned 8-game pair — aggEfg fallback path)');
const smoke = computeProfiles(canned);
T('records: AAA 5-3, BBB 3-5', smoke.AAA.w === 5 && smoke.AAA.l === 3 && smoke.BBB.w === 3 && smoke.BBB.l === 5);
T('h2h symmetric: AAA vs BBB 5-3, BBB vs AAA 3-5',
  smoke.AAA.profile.h2h.BBB.w === 5 && smoke.BBB.profile.h2h.AAA.l === 5);
T('h2h avg_margin mirrors sign', smoke.AAA.profile.h2h.BBB.avg_margin === -smoke.BBB.profile.h2h.AAA.avg_margin);
T('L5 window: AAA 2-3 (last 5 of the 8)', smoke.AAA.profile.form.l5 && smoke.AAA.profile.form.l5.w === 2);
T('L5 own_efg_delta negative + COLD (0.52 base -> 0.44 window)',
  smoke.AAA.profile.form.l5.own_efg_delta < -4.0 && smoke.AAA.profile.form.l5.own_tag === 'COLD');
T('L10 null at 8 games (needs k+1)', smoke.AAA.profile.form.l10 === null);
T('tiers sufficient at exactly 8 games per team (TIER_MIN_GAMES boundary inclusive)',
  smoke.AAA.profile.tiers.insufficient === false);
T('tiers INSUFFICIENT at 7 games per team',
  computeProfiles(canned.slice(0, 14)).AAA.profile.tiers.insufficient === true);
T('identity.to_margin AAA +4.0 (forces 16, commits 12)', close(smoke.AAA.profile.identity.to_margin, 4.0, 0.001));
T('identity.fta_diff AAA +5.0', close(smoke.AAA.profile.identity.fta_diff, 5.0, 0.001));
T('schedule.last_game_date is latest', smoke.AAA.profile.schedule.last_game_date === '2026-06-08');

// ── aggregate eFG path: attempt-weighted, NOT per-game mean ──
console.log('\nAGGREGATE eFG PATH');
const aggRows = [
  mkRow(0, 'XXX', 'YYY', 90, 80, null, null, { fgm: 40, fga: 100, fg3m: 0, opp_fgm: 30, opp_fga: 100, opp_fg3m: 0 }),
  mkRow(1, 'XXX', 'YYY', 90, 80, null, null, { fgm: 10, fga: 20,  fg3m: 0, opp_fgm: 10, opp_fga: 20,  opp_fg3m: 0 }),
];
const aggP = computeProfiles(aggRows).XXX.profile.identity;
// aggregate: (40+10)/(100+20)=.4167 vs opp (30+10)/120=.3333 -> +8.3pp
// per-game mean would give: (.40+.50)/2=.45 vs (.30+.50)/2=.40 -> +5.0pp
T(`identity.efg_diff is aggregate +8.3 (got ${aggP.efg_diff})`, close(aggP.efg_diff, 8.3, 0.05));
T('aggregate differs from per-game mean (+5.0) — weighting is real', !close(aggP.efg_diff, 5.0, 0.5));

// ── 2. ATL golden fixture (as-of 2026-07-04) ──
const AS_OF = process.env.AS_OF || '2026-07-04';
async function golden() {
  if (process.env.SKIP_GOLDEN === '1') { console.log('\nATL GOLDEN: skipped (SKIP_GOLDEN=1)'); return; }
  const base = process.env.DFT_BASE || 'https://poetic-starlight-aa8938.netlify.app';
  const auth = 'Basic ' + Buffer.from('manny:DFT2025!').toString('base64');
  let rows = [];
  try {
    const r = await fetch(`${base}/.netlify/functions/db-api?action=get_team_game_stats&league=wnba&season=2026&max_date=${AS_OF}`,
      { headers: { Authorization: auth } });
    if (r.ok) rows = (await r.json()).team_game_stats || [];
  } catch (e) { console.log(`\nATL GOLDEN: endpoint unreachable (${e.message}) — skipped`); return; }
  if (rows.length === 0) { console.log('\nATL GOLDEN: no team_game_stats rows yet (pre-backfill) — skipped'); return; }

  console.log(`\nATL GOLDEN FIXTURE (as-of ${AS_OF}, ${rows.length} team rows)`);
  const p = computeProfiles(rows).ATL;
  if (!p) { T('ATL profile exists', false); return; }
  const id = p.profile.identity, tp = p.profile.tiers.top, rs = p.profile.tiers.rest,
        l5 = p.profile.form.l5, gs = p.profile.h2h.GS;
  T('archetype POSSESSION_BULLY', p.archetype === 'POSSESSION_BULLY');
  T(`TO margin +3.5 (got ${id.to_margin})`, close(id.to_margin, 3.5));
  T(`FTA diff +4.8 (got ${id.fta_diff})`, close(id.fta_diff, 4.8));
  // OREB tolerance 0.25: player-sum OREB excludes team rebounds (not credited to any
  // player), so official-team-line-derived numbers can drift ~0.2/game. Direction and
  // magnitude are what profiles consume; archetype OREB_EDGE threshold is 1.5.
  T(`OREB diff +4.9 +/-0.25 (got ${id.oreb_diff})`, close(id.oreb_diff, 4.9, 0.25));
  T(`eFG diff -5.2 (got ${id.efg_diff})`, close(id.efg_diff, -5.2));
  T(`top tier 1-6, n=7 (got ${tp.w}-${tp.l}, n=${tp.n})`, tp.w === 1 && tp.l === 6 && tp.n === 7);
  T(`top eFG diff -11.1 (got ${tp.efg_diff})`, close(tp.efg_diff, -11.1));
  T(`top TO margin +1.3 (got ${tp.to_margin})`, close(tp.to_margin, 1.3));
  T(`rest 11-3, n=14 (got ${rs.w}-${rs.l}, n=${rs.n})`, rs.w === 11 && rs.l === 3 && rs.n === 14);
  T(`L5 0-5 (got ${l5 && l5.w}-${l5 && l5.l})`, !!l5 && l5.w === 0 && l5.l === 5);
  T(`L5 own eFG -8.0 COLD (got ${l5 && l5.own_efg_delta} ${l5 && l5.own_tag})`, !!l5 && close(l5.own_efg_delta, -8.0) && l5.own_tag === 'COLD');
  T(`L5 opp eFG +6.1 OPPONENTS_HOT (got ${l5 && l5.opp_efg_delta} ${l5 && l5.opp_tag})`, !!l5 && close(l5.opp_efg_delta, 6.1) && l5.opp_tag === 'OPPONENTS_HOT');
  T(`H2H vs GS 0-3 avg -6.3 (got ${gs && gs.w}-${gs && gs.l} ${gs && gs.avg_margin})`, !!gs && gs.w === 0 && gs.l === 3 && close(gs.avg_margin, -6.3));
}

await golden();
console.log(`\n${pass}/${pass + fail} passed${fail ? ' \u2014 FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

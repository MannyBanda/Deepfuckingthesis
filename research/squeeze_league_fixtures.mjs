// ═══════════════════════════════════════════════════════════════════════════════
// SQUEEZE LEAGUE FIXTURES — NBA_JUICE_SPEC §10. Run: node research/squeeze_league_fixtures.mjs
// [0] WNBA goldens byte-identical (recorded from the pre-refactor module, Commit A)
// [1] NBA aliases vs poll ODDS_API_TEAMS + ESPN variants, no cross-hits
// [2] nbaCueThreshold pins + clamp + null fallback + env knob
// [3] ssPriceStale / americanToImplied byte-equal to poll; stale gap === poll SS_CFG.nba
// [4] per-book freshness (NBA on, WNBA off)          [5] window per league
// [6] cap / re-arm per league (+ two-pass same-invocation guard)
// [7] composeSqueezeNba variants                       [8] armed subtypes + thresholds per league
// [9] decision replay over the committed Nov 20 tape   [10] leg isolation via runCycle
// Plus NBA end-to-end samplePass: push title/priority/body, tape write, stale-quote guard.
// The existing research/2026-07-23_squeeze_fixtures.mjs (77/77) stays untouched.
// ═══════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
import * as mod from '../netlify/functions/odds-squeeze.mjs';
import { runAll, makeSql, installFetch } from './squeeze_trace_runner.mjs';

const { SQ_CFG, aliasFromNameNba, nbaCueThreshold, nbaToAmerican, composeSqueezeNba, samplePass, autoArm, loadWatches,
  bestPrice, topThreeLine, implied, runCycle, trailerEspnWp } = mod;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}\n   got:  ${JSON.stringify(a)}\n   want: ${JSON.stringify(b)}`);
const quiet = (fn) => async (...a) => { const l = console.log; console.log = (...x) => { if (!String(x[0]).startsWith('[squeeze]')) l(...x); }; try { return await fn(...a); } finally { console.log = l; } };
const POLL = readFileSync(new URL('../netlify/functions/poll-live-bdl.mjs', import.meta.url), 'utf8');
const SQZ = readFileSync(new URL('../netlify/functions/odds-squeeze.mjs', import.meta.url), 'utf8');
process.env.NTFY_TOPIC = 'test-topic';
delete process.env.NBA_SQUEEZE_PP;

// ── [0] WNBA goldens ──
await quiet(async () => {
  const want = JSON.parse(readFileSync(new URL('./fixtures_squeeze_wnba_goldens.json', import.meta.url), 'utf8'));
  const got = JSON.parse(JSON.stringify(await runAll(mod)));
  for (const k of Object.keys(want.samplePass)) eq(got.samplePass[k], want.samplePass[k], `[0] WNBA golden ${k}`);
  eq(got.armLoad, want.armLoad, '[0] WNBA golden autoArm/loadWatches');
  eq(got.pure, want.pure, '[0] WNBA golden pure (aliases/best/top3/thresholds/band)');
})();

// ── [1] NBA aliases ──
const block = POLL.match(/const ODDS_API_TEAMS = \{([\s\S]*?)\};/)[1];
const pairs = [...block.matchAll(/'([^']+)':\s*'([A-Z]{2,3})'/g)].map((m) => [m[1], m[2]]);
ok(pairs.length === 30, `[1] poll ODDS_API_TEAMS has 30 teams (got ${pairs.length})`);
for (const [name, al] of pairs) eq(aliasFromNameNba(name), al, `[1] ${name}`);
eq(new Set(pairs.map(([n]) => aliasFromNameNba(n))).size, 30, '[1] 30 distinct aliases (no cross-hits)');
for (const [n, al] of [['LA Clippers', 'LAC'], ['Clippers', 'LAC'], ['Trail Blazers', 'POR'], ['76ers', 'PHI'], ['Hornets', 'CHA'], ['Nets', 'BKN'],
  ['Charlotte Hornets', 'CHA'], ['Brooklyn Nets', 'BKN'], ['Timberwolves', 'MIN'], ['Lakers', 'LAL'], ['Minnesota Lynx', null], ['', null], [null, null]])
  eq(aliasFromNameNba(n), al, `[1] variant ${n}`);
ok(SQ_CFG.nba.alias === aliasFromNameNba && SQ_CFG.wnba.alias === mod.aliasFromName, '[1] each league cfg uses its own matcher');

// ── [2] thresholds ──
for (const [cue, thr] of [[-200, -131], [-125, 120], [-180, -119], [-285, -178], [-430, -246], [-525, -285], [105, 158], [180, 289], [255, 450]])
  eq(nbaCueThreshold({ line_used: cue }), thr, `[2] cue ${cue} → ${thr}`);
for (const v of [null, undefined, '', 0, 'abc']) eq(nbaCueThreshold({ line_used: v }), 100, `[2] no cue (${v}) → +100`);
eq(nbaCueThreshold({ line_used: '-200' }), -131, '[2] string cue');
eq(nbaToAmerican(0.99), -1900, '[2] clamp .95 high'); eq(nbaToAmerican(0.01), 1900, '[2] clamp .05 low');
eq(nbaCueThreshold({ line_used: 5000 }), 1900, '[2] extreme dog clamps, never flips sign');
eq(mod.probToAmerican(implied(255) - 0.10), 186, '[2] (why) WNBA clamp would give +186 for a +255 cue');
process.env.NBA_SQUEEZE_PP = '0.15'; eq(nbaCueThreshold({ line_used: -200 }), -107, '[2] env knob NBA_SQUEEZE_PP=0.15');
process.env.NBA_SQUEEZE_PP = '0.9'; eq(nbaCueThreshold({ line_used: -200 }), -131, '[2] invalid knob → default .10');
process.env.NBA_SQUEEZE_PP = ''; eq(nbaCueThreshold({ line_used: -200 }), -131, '[2] empty knob → default');
delete process.env.NBA_SQUEEZE_PP;

// ── [3] mirrors ──
const fnSrc = (src, name) => { const i = src.indexOf(`function ${name}(`); if (i < 0) return null; let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; } return src.slice(i, j + 1); };
ok(fnSrc(SQZ, 'ssPriceStale') && fnSrc(SQZ, 'ssPriceStale') === fnSrc(POLL, 'ssPriceStale'), '[3] ssPriceStale byte-equal to poll-live-bdl');
ok(fnSrc(SQZ, 'americanToImplied') === fnSrc(POLL, 'americanToImplied'), '[3] americanToImplied byte-equal to poll-live-bdl');
const pollGap = [...POLL.matchAll(/staleGapPp:\s*([\d.]+)/g)].map((m) => Number(m[1]));
ok(pollGap.length === 1 && pollGap[0] === SQ_CFG.nba.staleGapPp, `[3] stale gap ${SQ_CFG.nba.staleGapPp} === poll SS_CFG.nba.staleGapPp (${pollGap})`);
eq(mod.ssPriceStale(135, 15, 0.25), { stale: true, implied: 0.426, espnWp: 0.15 }, '[3] stale: +135 vs ESPN 15%');
eq(mod.ssPriceStale(135, 41, 0.25).stale, false, '[3] fresh: +135 vs ESPN 41%');
eq(trailerEspnWp({ espn_wp_home: 56, espn_wp_away: 44 }, { trailer_alias: 'LAL', _home: 'LAL', _away: 'SAC' }), 0.56, '[3] home trailer WP');
eq(trailerEspnWp({ espn_wp_home: 56, espn_wp_away: 44 }, { trailer_alias: 'SAC', _home: 'LAL', _away: 'SAC' }), 0.44, '[3] away trailer WP');
eq(trailerEspnWp({ espn_wp_home: 56 }, { trailer_alias: 'SAC', _home: 'LAL', _away: 'SAC' }), 0.44, '[3] away fallback 100-home');
eq(trailerEspnWp({ espn_wp_home: null }, { trailer_alias: 'LAL', _home: 'LAL', _away: 'SAC' }), null, '[3] no ESPN → null');

// ── [4] freshness ──
const NOW = Date.parse('2026-11-21T03:00:00Z');
const iso = (s) => new Date(NOW - s * 1000).toISOString();
const BKN = (key, lal, sac, lu) => ({ key, markets: [{ key: 'h2h', ...(lu === undefined ? {} : { last_update: lu }),
  outcomes: [{ name: 'Los Angeles Lakers', price: lal }, { name: 'Sacramento Kings', price: sac }] }] });
const evF = { home_team: 'Los Angeles Lakers', away_team: 'Sacramento Kings', bookmakers: [
  BKN('fanduel', 160, -190, iso(181)), BKN('draftkings', 140, -170, iso(179)), BKN('betmgm', 150, -180, undefined),
  BKN('bovada', 200, -240, iso(5)), BKN('fanatics', 130, -160, iso(10))] };
eq(bestPrice(evF, 'LAL', SQ_CFG.nba, NOW).book, 'betmgm', '[4] NBA: 181s FanDuel dropped, missing-field BetMGM kept, offshore never');
eq(bestPrice(evF, 'LAL', SQ_CFG.nba, NOW - 2000).book, 'fanduel', '[4] NBA: same quote fresh 2s earlier → kept');
eq(bestPrice(evF, 'LAL', SQ_CFG.nba).book, 'fanduel', '[4] NBA: no sample time (test path) → no filter');
eq(topThreeLine(evF, 'LAL', SQ_CFG.nba, NOW), 'BetMGM +150 | DraftKings +140 | Fanatics +130', '[4] NBA top-3 respects freshness + roster');
eq(mod.freshnessAudit(evF, SQ_CFG.nba, NOW), { dropped: ['fanduel(181s)'], unknown: ['betmgm'] }, '[4] audit');
const evW = { home_team: 'Minnesota Lynx', away_team: 'Las Vegas Aces', bookmakers: [{ key: 'fanduel', markets: [{ key: 'h2h', last_update: iso(9999),
  outcomes: [{ name: 'Minnesota Lynx', price: 140 }, { name: 'Las Vegas Aces', price: -170 }] }] }] };
eq(bestPrice(evW, 'MIN', SQ_CFG.wnba, NOW)?.price, 140, '[4] WNBA: freshness off even with a sample time');
eq(SQ_CFG.wnba.freshnessSec, null, '[4] WNBA cfg freshness null');

// ── NBA watch / world builders ──
const NB = (key, lal, sac, lu = iso(20), link = null) => ({ key, title: key, markets: [{ key: 'h2h', last_update: lu,
  outcomes: [{ name: 'Los Angeles Lakers', price: lal, link }, { name: 'Sacramento Kings', price: sac }] }] });
const EV = (lal = 135) => ({ home_team: 'Los Angeles Lakers', away_team: 'Sacramento Kings', bookmakers: [
  NB('fanduel', lal, -160, iso(20), 'https://sportsbook.fanduel.com/addToBetslip?marketId=9&selectionId=8'),
  NB('draftkings', 130, -155), NB('williamhill_us', 125, -150), NB('bovada', 220, -260)] });
const ESP = (p, clk, lal, sac, state = 'in') => ({ 'LAL|SAC': { period: p, clock: clk, state, home: { alias: 'LAL', score: lal }, away: { alias: 'SAC', score: sac } } });
const WN = (o = {}) => ({ id: 3234, game_id: 'g-lal', leader_alias: 'SAC', trailer_alias: 'LAL', leader_killer: null, alert_subtype: 'WATCHLIST',
  trailer_lane: null, squeeze_threshold: -119, squeeze_last_alert_price: null, squeeze_alert_count: 0, squeeze_state: {}, line_used: -180,
  leader_efg: 57.954544, _cue_period: 2, _cue_clock: '1:18', _gdate: '2026-11-20', _home: 'LAL', _away: 'SAC', _fuelTemp: null, ...o });
const SNAPN = (o = {}) => ({ ts: iso(15), period: 3, clock: '6:12', ss_leader_alias: 'SAC', ss_leader_efg: 60.9, espn_wp_home: 41, espn_wp_away: 59,
  raw_stats_json: { home: { fgm: 30, fga: 66, fg3m: 8 }, away: { fgm: 36, fga: 64, fg3m: 12 } }, ...o });
async function nbaRun(o = {}) {
  const trace = [];
  const restore = installFetch(trace);
  const sql = makeSql([[/FROM snapshots/, o.snap === null ? [] : [o.snap || SNAPN()]], [/FROM bets/, o.bets || []]], trace);
  const w = WN(o.w || {});
  let r;
  try { r = await samplePass(sql, [w], o.espn || ESP(3, '6:12', 60, 67), [o.event || EV()], !!o.dry, {}, SQ_CFG.nba, NOW); }
  finally { restore(); }
  const push = trace.filter((t) => t.fetch && t.fetch.startsWith('https://ntfy'));
  return { r: r.results[0], push, trace, w, sqls: trace.filter((t) => t.sql).map((t) => t.sql) };
}

// ── NBA end-to-end ──
await quiet(async () => {
  const a = await nbaRun();
  eq(a.r.action, 'ALERT', 'E2E in-band cross → ALERT');
  ok(a.push.length === 1, 'E2E one push');
  eq(a.push[0]?.headers, { Title: 'JUICE NBA: LAL +135 (FanDuel)', Priority: '4', Tags: 'chart_with_upwards_trend',
    Click: 'https://sportsbook.fanduel.com/addToBetslip?marketId=9&selectionId=8' }, 'E2E headers: title, priority 4, FanDuel deep link');
  eq(a.push[0]?.body, [
    'LAL +135 at FanDuel - was -180 at the cue (Q2 1:18), 22 points cheaper.',
    'LAL down 7, Q3 6:12.',
    'ESPN fair now: 41%.',
    'SAC shooting 61% eFG now (58% at the cue).',
    'Cheaper because the game got worse - cues that drifted this far have won less often than cues that held [this season, LOW].',
    'Best: FanDuel +135 | DraftKings +130 | Caesars +125.',
    'Tap opens: FanDuel slip.',
    '$300 class (NBA watchlist). Staged adds = one position vs cap. Your read - not a directive.'].join('\n'), 'E2E body = spec §7');
  const tape = a.trace.find((t) => t.sql && t.sql.startsWith('INSERT INTO odds_history'));
  eq(tape?.v, ['g-lal', 135, -150, 7, 'squeeze:fanduel'], 'E2E tape: best-of-roster MLs per side (offshore excluded), deficit, source');
  eq(a.trace.filter((t) => t.sql && /FROM snapshots/.test(t.sql)).length, 1, 'E2E snapshot read once (guard → composer)');
  ok(!a.push[0]?.body.match(/cell|CHANNEL|SHAPE|cap \(|A-tier|LANE|re-entry/), 'E2E no WNBA-calibrated copy crosses');

  const st = await nbaRun({ snap: SNAPN({ espn_wp_home: 12, espn_wp_away: 88 }) });
  eq([st.r.action, st.r.reason, st.push.length], ['skip', 'stale-quote(implied 43 vs espn 12)', 0], 'E2E ESPN stale guard → stale-quote, no push');
  ok(st.sqls.some((s) => s.startsWith('INSERT INTO odds_history')), 'E2E stale quote still writes the tape (§6.7)');
  const ne = await nbaRun({ snap: SNAPN({ espn_wp_home: null, espn_wp_away: null }) });
  eq([ne.r.action, ne.push.length], ['ALERT', 1], 'E2E no ESPN read → guard skipped, alert goes');
  ok(!/ESPN fair now/.test(ne.push[0]?.body), 'E2E no ESPN → ESPN line omitted');
  const ns = await nbaRun({ snap: null });
  ok(ns.r.action === 'ALERT' && !/eFG now|ESPN fair/.test(ns.push[0]?.body), 'E2E no snapshot → eFG + ESPN lines omitted');
  const bt = await nbaRun({ threshold: 0, w: { squeeze_threshold: 150 } });
  eq([bt.r.reason, bt.push.length], ['below-threshold', 0], 'E2E +135 vs +150 line → below-threshold');
  const dr = await nbaRun({ dry: true });
  ok(dr.r.action === 'WOULD-ALERT' && !dr.push.length && !dr.sqls.some((s) => s.startsWith('INSERT')), 'E2E dry: no push, no tape');
  const pg = await nbaRun({ espn: ESP(0, '12:00', 0, 0, 'pre') });
  eq(pg.r.reason, 'pregame', 'E2E pregame skip');
  const nx = await nbaRun({ espn: {} });
  eq(nx.r.reason, 'no-espn', 'E2E game missing from ESPN → no-espn (never stale state)');
  const fz = await nbaRun({ w: { squeeze_state: { last_clock: '6:12', last_period: 3 } } });
  eq(fz.r.reason, 'clock-frozen', 'E2E clock gate verbatim');
  const ob = await nbaRun({ bets: [{ side: 'LAL ML', stake: 200, odds: -180 }] });
  ok(/^LAL down 7, Q3 6:12\.\nYou hold LAL ML \$200 @ -180 - this alert is an ADD against the same position cap\.$/m.test(ob.push[0]?.body.split('\n').slice(1, 3).join('\n')), 'E2E open bet posLine after state line');
})();

// ── [5] window ──
await quiet(async () => {
  const q4 = await nbaRun({ espn: ESP(4, '11:50', 60, 64) });
  eq([q4.r.action, q4.r.reason], ['disarm', 'q4-window'], '[5] NBA first Q4 sample → disarm q4-window');
  ok(q4.sqls.some((s) => /SET squeeze_armed = FALSE/.test(s)) && !q4.push.length, '[5] NBA disarm writes, no push');
  const ot = await nbaRun({ espn: ESP(5, '3:00', 60, 64) });
  eq(ot.r.reason, 'q4-window', '[5] NBA OT also terminal');
  const fin = await nbaRun({ espn: ESP(4, '0:00', 100, 104, 'post') });
  eq(fin.r.reason, 'final', '[5] NBA final');
  // WNBA Q4 2:01 continues (golden S12 covers Q4 5:00 alert); 1:30 disarms (S11)
  const trace = []; const restore = installFetch(trace);
  const sqlW = makeSql([[/FROM snapshots/, []]], trace);
  const wW = { id: 9, game_id: 'gw', leader_alias: 'LV', trailer_alias: 'MIN', squeeze_threshold: 117, squeeze_state: {}, line_used: 140, _home: 'MIN', _away: 'LV', alert_subtype: 'WATCHLIST' };
  const evW2 = { home_team: 'Minnesota Lynx', away_team: 'Las Vegas Aces', bookmakers: [{ key: 'fanduel', markets: [{ key: 'h2h', outcomes: [{ name: 'Minnesota Lynx', price: 130 }, { name: 'Las Vegas Aces', price: -160 }] }] }] };
  const rW = await samplePass(sqlW, [wW], { 'LV|MIN': { period: 4, clock: '2:01', state: 'in', home: { alias: 'MIN', score: 60 }, away: { alias: 'LV', score: 66 } } }, [evW2], false, {});
  restore();
  eq(rW.results[0].action, 'ALERT', '[5] WNBA Q4 2:01 still watches (window unchanged)');
})();

// ── [6] cap / re-arm ──
await quiet(async () => {
  eq(SQ_CFG.nba.maxAlerts, 3, '[6] NBA cap 3'); eq(SQ_CFG.nba.rearm, 0.05, '[6] NBA re-arm .05');
  eq(SQ_CFG.wnba.maxAlerts, 6, '[6] WNBA cap 6'); eq(SQ_CFG.wnba.rearm, 0.035, '[6] WNBA re-arm .035');
  const c3 = await nbaRun({ w: { squeeze_alert_count: 3, squeeze_last_alert_price: 100 } });
  eq([c3.r.action, c3.r.reason], ['disarm', 'max-alerts'], '[6] NBA 4th crossing at count 3 → disarm max-alerts');
  const c2 = await nbaRun({ w: { squeeze_alert_count: 2, squeeze_last_alert_price: 100 } });
  eq(c2.r.action, 'ALERT', '[6] NBA 3rd alert allowed');
  // +135 implied .4255; last +112 implied .4717 → drop .046: WNBA would re-arm (≥.035), NBA waits (<.05)
  const rw = await nbaRun({ w: { squeeze_alert_count: 1, squeeze_last_alert_price: 112 } });
  eq(rw.r.reason, 'rearm-wait', '[6] NBA .046 drop < .05 → rearm-wait');
  const rk = await nbaRun({ w: { squeeze_alert_count: 1, squeeze_last_alert_price: 108 } });
  eq(rk.r.action, 'ALERT', '[6] NBA .055 drop → re-arms');
  // two passes in one invocation reuse the watch object — the second must not re-push the same price
  const trace = []; const restore = installFetch(trace);
  const sql = makeSql([[/FROM snapshots/, [SNAPN()]]], trace);
  const w = WN();
  const p1 = await samplePass(sql, [w], ESP(3, '6:12', 60, 67), [EV()], false, {}, SQ_CFG.nba, NOW);
  const p2 = await samplePass(sql, [w], ESP(3, '5:44', 60, 67), [EV()], false, {}, SQ_CFG.nba, NOW);
  restore();
  eq([p1.results[0].action, p2.results[0].reason, trace.filter((t) => t.fetch?.startsWith('https://ntfy')).length], ['ALERT', 'rearm-wait', 1],
    '[6] same-invocation pass 2 → rearm-wait (in-memory sync), one push');
  eq([w.squeeze_last_alert_price, w.squeeze_alert_count], [135, 1], '[6] watch object synced after alert');
})();

// ── [7] composer variants ──
const base = { trailer: 'ATL', leader: 'CHA', price: 135, book: 'draftkings', cue: -125, cuePeriod: 2, cueClock: '12:00', deficit: 9, period: 2, clock: '4:50',
  espnWp: 0.40, leaderEfg: 64, leaderEfgCue: 66.7, shopLine: 'DraftKings +135 | Caesars +130' };
const C = (o) => composeSqueezeNba({ ...base, ...o });
eq(C({}).title, 'JUICE NBA: ATL +135 (DraftKings)', '[7] title');
eq(C({}).body.split('\n')[0], 'ATL +135 at DraftKings - was -125 at the cue (Q2 12:00), 13 points cheaper.', '[7] cue line');
eq(C({ deficit: 0 }).body.split('\n')[1], 'ATL tied it, Q2 4:50 (grace read).', '[7] tie');
eq(C({ deficit: 10, oobGrace: true }).body.split('\n')[1], 'ATL down 10, Q2 4:50 (out of band - grace read).', '[7] oob grace');
eq(C({ resumedAt: { period: 2, clock: '6:01' } }).body.split('\n')[2], 'Back in band since Q2 6:01.', '[7] resume');
eq(C({ posLine: 'You hold X.' }).body.split('\n')[2], 'You hold X.', '[7] posLine after state');
ok(!/ESPN fair/.test(C({ espnWp: null }).body), '[7] no ESPN → omitted');
ok(!/eFG/.test(C({ leaderEfg: null }).body), '[7] no snapshot → eFG omitted');
eq(C({ leaderEfgCue: null }).body.split('\n')[3], 'CHA shooting 64% eFG now.', '[7] no cue eFG → bare eFG line');
const nc = C({ cue: null, price: 105 });
eq(nc.body.split('\n')[0], 'ATL +105 at DraftKings - no cue price was stamped; plus-money line.', '[7] no cue price');
ok(!/drifted/.test(nc.body), '[7] no cue → no drift line');
ok(!/drifted/.test(C({ price: -105 }).body), '[7] moved 4 pts (<10) → no drift line');
eq(C({ price: -150 }).body.split('\n')[0], 'ATL -150 at DraftKings - was -125 at the cue (Q2 12:00), 4 points pricier.', '[7] manual line above cue → "pricier"');
eq(C({ cuePeriod: null }).body.split('\n')[0], 'ATL +135 at DraftKings - was -125 at the cue, 13 points cheaper.', '[7] no cue clock → no parenthetical');
eq(C({}).body.split('\n').slice(-2), ['Tap opens: DraftKings slip.', '$300 class (NBA watchlist). Staged adds = one position vs cap. Your read - not a directive.'], '[7] tail lines');

// ── [8] armed subtypes + thresholds per league ──
await quiet(async () => {
  for (const [cfg, subs] of [[SQ_CFG.wnba, ['EFG_FADE', 'EFG_FADE_SOFT', 'B1', 'B2', 'B3', 'WATCHLIST']], [SQ_CFG.nba, ['WATCHLIST']]]) {
    const trace = [];
    const sql = makeSql([[/SELECT id, alert_subtype/, cfg.league === 'nba'
      ? [{ id: 1, alert_subtype: 'WATCHLIST', line_used: -200 }, { id: 2, alert_subtype: 'WATCHLIST', line_used: null }]
      : [{ id: 3, alert_subtype: 'WATCHLIST', leader_killer: true }]]], trace);
    await autoArm(sql, cfg);
    const sel = trace.find((t) => /SELECT id, alert_subtype/.test(t.sql));
    eq(JSON.parse(sel.v[1]), subs, `[8] ${cfg.league} armed subtypes`);
    eq(sel.v[0], cfg.league, `[8] ${cfg.league} league filter`);
    eq(trace.filter((t) => /SET squeeze_armed = TRUE/.test(t.sql)).map((t) => t.v[0]), cfg.league === 'nba' ? [-131, 100] : [-150], `[8] ${cfg.league} arm thresholds`);
  }
  ok(!SQ_CFG.nba.subtypes.includes('GAP_BASE'), '[8] GAP_BASE never arms');
  process.env.NBA_SQUEEZE_AUTOARM = '0';
  const t0 = []; await autoArm(makeSql([], t0), SQ_CFG.nba);
  eq(t0.length, 0, '[8] NBA_SQUEEZE_AUTOARM=0 → manual only (no query)');
  delete process.env.NBA_SQUEEZE_AUTOARM;
  // manual arm stored NULL → loadWatches fills from the cue
  const tl = [];
  const live = await loadWatches(makeSql([[/sa.period AS _cue_period/, [{ id: 7, game_id: 'g7', line_used: -285, squeeze_threshold: null, squeeze_state: null, player_ctx_json: null, _home: 'OKC', _away: 'NOP', _gdate: '2026-11-20' }]]], tl), SQ_CFG.nba);
  eq([live[0].squeeze_threshold, tl.filter((t) => /SET squeeze_threshold/.test(t.sql)).map((t) => t.v[0])], [-178, [-178]], '[8] NULL threshold filled from cue');
  ok(tl.some((t) => /COALESCE\(sa.game_date::text, g.date::text\) AS _gdate/.test(t.sql)), '[8] NBA load reads game date as text (Neon DATE hotfix)');
  const db = readFileSync(new URL('../netlify/functions/db-api.js', import.meta.url), 'utf8');
  ok(/CASE WHEN league = 'nba' THEN NULL WHEN leader_killer IS TRUE THEN -150 ELSE 117 END/.test(db), '[8] db-api manual arm: NBA default NULL');
  eq((db.match(/source IS NULL OR source NOT LIKE 'squeeze:%'/g) || []).length, 3, '[8] D-J6: three line reads skip squeeze tape');
})();

// ── [9] decision replay — the committed Nov 20 tape through the real samplePass ──
// Reference (replay script, --max 3 --rearm 0.05, option B, Q2–Q3): first-alert price / period / clock / count.
// Harness notes: one sample per odds-api tape quote after the cue's created_at; ESPN state = the latest snapshot at or
// before the quote; one roster book carrying the tape price (fresh at sample time). The clock gate is neutralized
// (last_clock reset per sample): snapshots (~95s) are coarser than the tape (~67s), so a shared snapshot is not a
// stopped clock. The watch reloads from the "row" each sample, as loadWatches does each minute.
await quiet(async () => {
  const REF = { 'SAC@LAL': [-110, 3, '4:34', 1], 'NOP@OKC': [-154, 2, '6:39', 3], 'TOR@DET': [-120, 2, '5:51', 3], 'IND@CLE': [-111, 2, '10:20', 2], 'CHA@ATL': [135, 2, '4:50', 1] };
  const T = JSON.parse(readFileSync(new URL('./fixtures_nba_juice_tape_nov20.json', import.meta.url), 'utf8'));
  const NAME = Object.fromEntries(Object.entries({ Hawks: 'ATL', Celtics: 'BOS', Nets: 'BKN', Hornets: 'CHA', Bulls: 'CHI', Cavaliers: 'CLE', Mavericks: 'DAL', Nuggets: 'DEN', Pistons: 'DET', Warriors: 'GSW', Rockets: 'HOU', Pacers: 'IND', Clippers: 'LAC', Lakers: 'LAL', Grizzlies: 'MEM', Heat: 'MIA', Bucks: 'MIL', Timberwolves: 'MIN', Pelicans: 'NOP', Knicks: 'NYK', Thunder: 'OKC', Magic: 'ORL', '76ers': 'PHI', Suns: 'PHX', 'Trail Blazers': 'POR', Kings: 'SAC', Spurs: 'SAS', Raptors: 'TOR', Jazz: 'UTA', Wizards: 'WAS' }).map(([n, a]) => [a, n]));
  ok(T.cues.length === 5, '[9] 5 Nov 20 cues in the slice');
  for (const c of T.cues) {
    const { row, game } = c; const home = game.home_alias, away = game.away_alias;
    const db = { squeeze_threshold: nbaCueThreshold(row), squeeze_last_alert_price: null, squeeze_alert_count: 0, squeeze_state: {}, armed: true };
    const fire = Date.parse(row.created_at); const alerts = [];
    let si = 0;
    for (const q of c.tape) {
      const t = Date.parse(q.ts);
      if (!db.armed || t <= fire) continue;
      const trH = row.trailer_alias === home; if ((trH ? q.home_ml : q.away_ml) == null) continue;
      while (si + 1 < c.snaps.length && Date.parse(c.snaps[si + 1].ts) <= t) si++;
      const s = c.snaps[si]; if (!s || Date.parse(s.ts) > t) continue;
      const trace = [];
      const sql = makeSql([[/FROM snapshots/, [s]], [/FROM bets/, []],
        [/SET squeeze_armed = FALSE/, () => { db.armed = false; return []; }],
        [/SET squeeze_last_alert_price/, (qq, v) => { db.squeeze_last_alert_price = v[0]; db.squeeze_alert_count++; return []; }],
        [/SET squeeze_state/, (qq, v) => { db.squeeze_state = JSON.parse(v[0]); return []; }]], trace);
      const w = { id: row.id, game_id: row.game_id, leader_alias: row.leader_alias, trailer_alias: row.trailer_alias, alert_subtype: 'WATCHLIST',
        line_used: row.line_used, leader_efg: row.leader_efg, _cue_period: row.period, _cue_clock: row.clock, _home: home, _away: away,
        squeeze_threshold: db.squeeze_threshold, squeeze_last_alert_price: db.squeeze_last_alert_price, squeeze_alert_count: db.squeeze_alert_count,
        squeeze_state: { ...db.squeeze_state, last_clock: null } };
      const espn = { [[home, away].sort().join('|')]: { period: s.period, clock: s.clock, state: 'in', home: { alias: home, score: s.home_pts || 0 }, away: { alias: away, score: s.away_pts || 0 } } };
      const ev = { home_team: NAME[home], away_team: NAME[away], bookmakers: [{ key: 'williamhill_us', markets: [{ key: 'h2h', last_update: q.ts,
        outcomes: [{ name: NAME[home], price: q.home_ml }, { name: NAME[away], price: q.away_ml }] }] }] };
      const restore = installFetch(trace);
      let r; try { r = (await samplePass(sql, [w], espn, [ev], false, {}, SQ_CFG.nba, t)).results[0]; } finally { restore(); }
      if (r.action === 'ALERT') alerts.push([trH ? q.home_ml : q.away_ml, s.period, s.clock]);
    }
    const m = game.matchup || `${away}@${home}`;
    const ref = REF[m];
    eq(alerts.length ? [...alerts[0], alerts.length] : null, ref, `[9] ${m} first alert price/period/clock + count vs replay`);
  }
})();

// ── [10] isolation via runCycle ──
// runCycle samples on the real clock, so the mock books are stamped 20s before real now
const EVnow = () => { const e = EV(); const lu = new Date(Date.now() - 20000).toISOString(); e.bookmakers.forEach((b) => b.markets.forEach((m) => { m.last_update = lu; })); return e; };
await quiet(async () => {
  const prevKey = process.env.ODDS_API_KEY; process.env.ODDS_API_KEY = 'test-key';
  const mkWorld = () => {
    const calls = []; let espnN = 0;
    const prev = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      const u = String(url);
      const body = u.includes('/basketball/nba/scoreboard')
        ? { events: [{ status: { period: 3, displayClock: ['6:12', '5:44'][espnN++ % 2], type: { state: 'in' } }, competitions: [{ competitors: [
            { homeAway: 'home', score: '60', team: { name: 'Lakers', abbreviation: 'LAL' } }, { homeAway: 'away', score: '67', team: { name: 'Kings', abbreviation: 'SAC' } }] }] }] }
        : u.includes('basketball_nba') ? [EVnow()] : u.includes('/wnba/scoreboard') ? { events: [] } : [];
      return { ok: true, status: 200, json: async () => body, headers: { get: (h) => (h === 'x-requests-remaining' ? '50000' : '1') } };
    };
    return { calls, restore: () => { globalThis.fetch = prev; } };
  };
  const sqlFor = (trace) => makeSql([[/INSERT INTO job_locks/, [{ job: 'odds_squeeze' }]], [/sa.period AS _cue_period/, [WN({ squeeze_state: null, player_ctx_json: null })]],
    [/FROM snapshots/, [SNAPN()]]], trace);
  const nbaHits = (calls) => calls.filter((u) => /basketball_nba|basketball\/nba/.test(u)).length;
  for (const [wf, nf, want, label] of [[undefined, undefined, 0, 'NBA flag unset → zero NBA fetches'], [undefined, '0', 0, "NBA flag '0' → zero NBA fetches"],
    ['0', '1', 'some', "WNBA '0' + NBA '1' → NBA leg still runs"]]) {
    if (wf === undefined) delete process.env.WNBA_SQUEEZE_ON; else process.env.WNBA_SQUEEZE_ON = wf;
    if (nf === undefined) delete process.env.NBA_SQUEEZE_ON; else process.env.NBA_SQUEEZE_ON = nf;
    const W = mkWorld(); const trace = [];
    let res; try { res = await runCycle(sqlFor(trace), { sleepMs: 0 }); } finally { W.restore(); }
    ok(want === 0 ? nbaHits(W.calls) === 0 : nbaHits(W.calls) > 0, `[10] ${label} (nba calls ${nbaHits(W.calls)})`);
    if (want !== 0) {
      eq([res.pass1?.[0]?.league, res.pass1?.[0]?.action, res.pass2?.[0]?.reason], ['nba', 'ALERT', 'rearm-wait'], '[10] NBA leg: pass1 ALERT (league-tagged), pass2 rearm-wait');
      ok(W.calls.some((u) => /nba\/scoreboard\?dates=20261120/.test(u)), '[10] NBA ESPN fetched by game date');
      eq(W.calls.filter((u) => u.includes('basketball_nba')).length, 2, '[10] one NBA odds call per pass (2 credits each)');
    }
  }
  process.env.WNBA_SQUEEZE_ON = '0'; delete process.env.NBA_SQUEEZE_ON;
  const W = mkWorld(); const tr = [];
  let res; try { res = await runCycle(sqlFor(tr), { sleepMs: 0 }); } finally { W.restore(); }
  eq([res, W.calls.length, tr.length], [{ ok: true, skipped: 'WNBA_SQUEEZE_ON=0' }, 0, 0], '[10] both legs off → skipped, no lock, no fetch');
  const W2 = mkWorld(); const tr2 = [];
  try { res = await runCycle(sqlFor(tr2), { dry: true, only: 'nba', sleepMs: 0 }); } finally { W2.restore(); }
  eq([res.dry, res.pass1?.[0]?.action, W2.calls.some((u) => u.startsWith('https://ntfy'))], [true, 'WOULD-ALERT', false], '[10] ?dry=1&league=nba audits NBA with the flag off, no push');
  delete process.env.WNBA_SQUEEZE_ON;
  if (prevKey === undefined) delete process.env.ODDS_API_KEY; else process.env.ODDS_API_KEY = prevKey;
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

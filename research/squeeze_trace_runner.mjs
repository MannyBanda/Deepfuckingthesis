// ═══════════════════════════════════════════════════════════════════════════════
// SQUEEZE TRACE RUNNER — NBA_JUICE_SPEC §10 [0]. Drives the squeeze module's decision
// code with a fake Neon `sql` (records every query + its values) and a fake global fetch
// (records every ntfy push), across fixed WNBA scenarios. The trace is the module's full
// observable behavior: DB writes, pushes (title/body/priority/click), per-watch results.
// Commit A records the traces from the UNTOUCHED module into
// research/fixtures_squeeze_wnba_goldens.json; research/squeeze_league_fixtures.mjs replays
// the same scenarios against the refactored module and requires byte-identical traces.
// Calls use the pre-refactor signatures; the refactor keeps them valid via cfg defaults.
// ═══════════════════════════════════════════════════════════════════════════════

const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g;
const norm = (v) => (typeof v === 'string' ? v.replace(ISO, '<ts>') : v);

export function makeSql(canned, trace) {
  const sql = async (strings, ...values) => {
    const q = strings.join('$').replace(/\s+/g, ' ').trim();
    trace.push({ sql: q, v: values.map((x) => (x instanceof Date ? '<date>' : norm(typeof x === 'object' && x !== null ? JSON.stringify(x) : x))) });
    for (const [re, rows] of canned) if (re.test(q)) return typeof rows === 'function' ? rows(q, values) : rows;
    return [];
  };
  return sql;
}

export function installFetch(trace) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    trace.push({ fetch: String(url).replace(/apiKey=[^&]+/, 'apiKey=<k>'), headers: opts.headers || null, body: opts.body ? norm(String(opts.body)) : null });
    return { ok: true, status: 200, json: async () => [], headers: { get: () => null } };
  };
  return () => { globalThis.fetch = prev; };
}

// ── canned WNBA world ──
const BK = (key, title, priceMIN, priceLV, link) => ({ key, title, last_update: '2026-08-01T00:00:00Z', link: null,
  markets: [{ key: 'h2h', last_update: '2026-08-01T00:00:00Z', link: null,
    outcomes: [{ name: 'Minnesota Lynx', price: priceMIN, link: link || null }, { name: 'Las Vegas Aces', price: priceLV, link: null }] }] });
export const WNBA_EVENT = { home_team: 'Minnesota Lynx', away_team: 'Las Vegas Aces', bookmakers: [
  BK('williamhill_us', 'Caesars', 125, -150, 'https://sportsbook.caesars.com/us/{state}/bet/betslip?selectionIds=abc&pickType={pickType}&wager={wagerAmount}'),
  BK('fanduel', 'FanDuel', 130, -155, 'https://sportsbook.fanduel.com/addToBetslip?marketId=1&selectionId=2'),
  BK('draftkings', 'DraftKings', 120, -145, null),
  BK('bovada', 'Bovada', 175, -210, null),          // offshore — must never route (roster guard)
  BK('espnbet', 'ESPN Bet', 130, -160, null),       // ties FanDuel's +130 — Caesars tie-break only applies to Caesars
] };
const SNAP = () => ({ ts: new Date(Date.now() - 10000).toISOString(), period: 3, clock: '6:45', ss_leader_alias: 'LV', ss_leader_efg: 62.3,
  ss_leader_efg_band: 'orange', ss_variance_share: 58,
  raw_stats_json: { home: { fgm: 20, fga: 48, fg3m: 4, ftm: 8, pot: 4, to: 5 }, away: { fgm: 26, fga: 50, fg3m: 9, ftm: 6, pot: 9, to: 8, pot_v2: 10 } } });
const ESPN = (period, clock, minScore, lvScore, state = 'in') => ({ 'LV|MIN': { period, clock, state, home: { alias: 'MIN', score: minScore }, away: { alias: 'LV', score: lvScore } } });
const W = (o = {}) => ({ id: 101, game_id: 'g1', leader_alias: 'LV', trailer_alias: 'MIN', leader_killer: false, alert_subtype: 'WATCHLIST', trailer_lane: null,
  squeeze_threshold: 117, squeeze_last_alert_price: null, squeeze_alert_count: 0, squeeze_expires_at: null, squeeze_state: {}, line_used: 140,
  _home: 'MIN', _away: 'LV', _fuelTemp: null, ...o });

export const SCENARIOS = [
  { name: 'S01 in-band cross -> ALERT', w: W(), espn: ESPN(3, '6:45', 60, 66) },
  { name: 'S02 below threshold', w: W({ squeeze_threshold: 200 }), espn: ESPN(3, '6:45', 60, 66) },
  { name: 'S03 rearm wait', w: W({ squeeze_last_alert_price: 125, squeeze_alert_count: 1 }), espn: ESPN(3, '6:40', 60, 66) },
  { name: 'S04 max alerts -> disarm', w: W({ squeeze_last_alert_price: 100, squeeze_alert_count: 6 }), espn: ESPN(3, '6:40', 60, 66) },
  { name: 'S05 tie grace', w: W(), espn: ESPN(3, '6:45', 66, 66) },
  { name: 'S06 oob 10 grace strike 1', w: W(), espn: ESPN(3, '6:45', 56, 66) },
  { name: 'S07 oob 14 strike skip', w: W(), espn: ESPN(3, '6:45', 52, 66) },
  { name: 'S08 third oob -> suspend', w: W({ squeeze_state: { oob_count: 2, last_clock: '7:00', last_period: 3 } }), espn: ESPN(3, '6:45', 52, 66) },
  { name: 'S09 suspended -> resume + alert', w: W({ squeeze_state: { oob_count: 3, suspended: true, last_clock: '9:00', last_period: 3 } }), espn: ESPN(3, '6:45', 60, 66) },
  { name: 'S10 final -> disarm', w: W(), espn: ESPN(4, '0:00', 60, 66, 'post') },
  { name: 'S11 Q4 1:30 -> disarm q4-2:00', w: W(), espn: ESPN(4, '1:30', 60, 66) },
  { name: 'S12 Q4 5:00 cross -> F5 copy', w: W(), espn: ESPN(4, '5:00', 60, 66) },
  { name: 'S13 frozen clock skip', w: W({ squeeze_state: { last_clock: '6:45', last_period: 3 } }), espn: ESPN(3, '6:45', 60, 66) },
  { name: 'S14 period flip catch-up', w: W({ squeeze_state: { last_clock: '0:00', last_period: 2 } }), espn: ESPN(3, '0:00', 60, 66) },
  { name: 'S15 pregame', w: W(), espn: ESPN(0, '10:00', 0, 0, 'pre') },
  { name: 'S16 no espn', w: W(), espn: {} },
  { name: 'S17 surge cashtip (cold at fire, trailer leads at -450)', w: W({ _fuelTemp: { temp: 'cold', trailerEfg: 41.2, fuel: 'EARNED', sticky: false } }), espn: ESPN(4, '8:00', 70, 67),
    event: { home_team: 'Minnesota Lynx', away_team: 'Las Vegas Aces', bookmakers: [BK('williamhill_us', 'Caesars', -450, 350, null)] } },
  { name: 'S18 killer row at -150', w: W({ leader_killer: true, squeeze_threshold: -150 }), espn: ESPN(3, '6:45', 60, 66) },
  { name: 'S19 A-tier EFG_FADE cap line + lane row', w: W({ alert_subtype: 'EFG_FADE', squeeze_threshold: -200 }), espn: ESPN(2, '3:10', 30, 34) },
  { name: 'S20 open bet posLine + lane', w: W({ trailer_lane: 'LANE', squeeze_threshold: 117 }), espn: ESPN(3, '6:45', 60, 66), bets: [{ side: 'MIN ML', stake: 300, odds: 140 }] },
  { name: 'S21 dry run', w: W(), espn: ESPN(3, '6:45', 60, 66), dry: true },
  { name: 'S22 no snapshot (stale copy)', w: W(), espn: ESPN(3, '6:45', 60, 66), snap: null },
];

export async function runSamplePassScenarios(mod) {
  process.env.NTFY_TOPIC = 'test-topic';
  const out = {};
  for (const sc of SCENARIOS) {
    const trace = [];
    const restore = installFetch(trace);
    const snapRows = sc.snap === null ? [] : [SNAP()];
    const sql = makeSql([[/FROM snapshots/, snapRows], [/FROM bets/, sc.bets || []]], trace);
    const w = JSON.parse(JSON.stringify(sc.w));
    let res;
    try { res = await mod.samplePass(sql, [w], sc.espn, [sc.event || WNBA_EVENT], !!sc.dry, {}); }
    finally { restore(); }
    out[sc.name] = { trace, results: res.results };
  }
  return out;
}

export async function runArmLoadScenarios(mod) {
  delete process.env.WNBA_SQUEEZE_AUTOARM;
  const trace = [];
  const armRows = [
    { id: 201, alert_subtype: 'EFG_FADE', leader_killer: false, line_used: 150, edge: 0.1 },
    { id: 202, alert_subtype: 'WATCHLIST', leader_killer: true, line_used: 120, edge: null },
    { id: 203, alert_subtype: 'B2', leader_killer: false, line_used: 160, edge: null },
  ];
  const sqlA = makeSql([[/SELECT id, alert_subtype, leader_killer/, armRows]], trace);
  const armed = await mod.autoArm(sqlA);
  const future = new Date(Date.now() + 3600e3).toISOString(), past = new Date(Date.now() - 60e3).toISOString();
  const watchRows = [
    { id: 301, game_id: 'g1', leader_alias: 'LV', trailer_alias: 'MIN', squeeze_expires_at: future, squeeze_state: '{"oob_count":1}', player_ctx_json: '{"fuelTemp":{"temp":"cold","insufficient":false}}', _home: 'MIN', _away: 'LV' },
    { id: 302, game_id: 'g1', leader_alias: 'LV', trailer_alias: 'MIN', squeeze_expires_at: future, squeeze_state: null, player_ctx_json: null, _home: 'MIN', _away: 'LV' },
    { id: 303, game_id: 'g2', leader_alias: 'NY', trailer_alias: 'CON', squeeze_expires_at: past, squeeze_state: null, player_ctx_json: null, _home: 'CON', _away: 'NY' },
  ];
  const sqlL = makeSql([[/FROM sweetspot_alerts sa JOIN games/, watchRows]], trace);
  const live = await mod.loadWatches(sqlL);
  return { armed, live: live.map((w) => ({ id: w.id, fuel: w._fuelTemp, st: w.squeeze_state })), trace };
}

export function runPureScenarios(mod) {
  const names = ['Minnesota Lynx', 'Seattle Storm', 'Portland Fire', 'Dallas Wings', 'Chicago Sky', 'New York Liberty', 'Las Vegas Aces', 'Washington Mystics',
    'Connecticut Sun', 'Indiana Fever', 'Los Angeles Sparks', 'Phoenix Mercury', 'Golden State Valkyries', 'Atlanta Dream', 'Toronto Tempo', 'Lynx', 'Unknown Team', ''];
  return {
    alias: names.map((n) => [n, mod.aliasFromName(n)]),
    bestMIN: mod.bestPrice(WNBA_EVENT, 'MIN'), bestLV: mod.bestPrice(WNBA_EVENT, 'LV'),
    top3MIN: mod.topThreeLine(WNBA_EVENT, 'MIN'), top3LV: mod.topThreeLine(WNBA_EVENT, 'LV'),
    thresholds: [{ alert_subtype: 'EFG_FADE' }, { alert_subtype: 'WATCHLIST', leader_killer: true }, { alert_subtype: 'B1' }, { alert_subtype: 'EFG_FADE', leader_killer: true }].map((r) => mod.pickThreshold(r)),
    band: [[{}, 5], [{}, 0], [{}, 10], [{}, 12], [{ oob_count: 2 }, 12], [{ suspended: true, oob_count: 3 }, 4], [{ suspended: true, oob_count: 3 }, 14], [{}, -2]].map(([s, d]) => mod.bandStep(s, d)),
  };
}

export async function runAll(mod) {
  return { samplePass: await runSamplePassScenarios(mod), armLoad: await runArmLoadScenarios(mod), pure: runPureScenarios(mod) };
}

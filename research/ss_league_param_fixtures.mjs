// ════════════════════════════════════════════════════════════════════════════
// SS LEAGUE-PARAM FIXTURES (NBA_SWEETSPOT_PORT_PHASE1_SPEC §4 + Amendment 1)
// Extracts SS_CFG / ssCfg / ssEnabled / ssStandingsSeason / ssComputeShape and the
// Phase 1b predicates + composer from poll-live-bdl.mjs (not retyped) and asserts:
//   [1] WNBA golden — ssComputeShape('wnba') reproduces every field the PRE-refactor
//       inline block produced (research/fixtures_ss_shape_golden.json, pinned from 3119e2f)
//   [2] NBA shape — populated vs null fields by config; minGP 5; predicates on real shapes
//   [3] Phase 1b predicates — clause-by-clause negatives (thresholds from cfg.cue)
//   [4] Stale-price flag — arithmetic + scale normalization + null handling
//   [5] ssComposePushNba — copy pins (plain English, ASCII title, exploratory tag, stale suffix)
//   [6] Config pins — WNBA tiers mirror the env flags; NBA A/B hard-off; NBA models null
//   [7] Season derivation — NBA Oct-start, WNBA calendar
//   [8] Source gates — no WNBA literal at the SS gate sites, one consumer per WNBA flag,
//       no NBA_PAUSED inside the SS block or the fire path, resolver league list + WNBA-only
//       graduation push in post-game-agent.mjs
// Run: node research/ss_league_param_fixtures.mjs
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
import { CASES, STANDINGS } from './ss_league_param_inputs.mjs';

const POLL = readFileSync('netlify/functions/poll-live-bdl.mjs', 'utf8');
const PGA = readFileSync('netlify/functions/post-game-agent.mjs', 'utf8');
const GOLDEN = JSON.parse(readFileSync('research/fixtures_ss_shape_golden.json', 'utf8'));

function extractFn(src, name) {
  const sig = `function ${name}(`;
  const i = src.indexOf(sig);
  if (i < 0) throw new Error(`fn not found: ${name}`);
  const open = src.indexOf('{', src.indexOf(')', i));
  let depth = 0, j = open;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}
function extractLine(src, startsWith) {
  const i = src.indexOf(startsWith);
  if (i < 0) throw new Error(`line not found: ${startsWith}`);
  return src.slice(i, src.indexOf('\n', i));
}
function extractObjConst(src, name) { // `const NAME = {` … matching `};`
  const sig = `const ${name} = {`;
  const i = src.indexOf(sig);
  if (i < 0) throw new Error(`const not found: ${name}`);
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(i, j) + ';';
}

// Build the module slice under a given env (flags read at build time, like the real module).
function build(env) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
  try {
    const src = [
      extractLine(POLL, 'const WNBA_SS_COMPUTE_OFF = '),
      extractLine(POLL, 'const WNBA_SS_ALERT_ON = '),
      extractLine(POLL, 'const WNBA_SS_B_ON = '),
      extractLine(POLL, 'const WNBA_SS_LEDGER_ON = '),
      extractLine(POLL, 'const WNBA_SS_WATCHLIST_ON = '),
      extractLine(POLL, 'const SS_DASH_URL = '),
      extractObjConst(POLL, 'SS_CFG'),
      extractLine(POLL, 'const ssCfg = '),
      extractLine(POLL, 'const ssEnabled = '),
      extractLine(POLL, 'const ssStandingsSeason = '),
      extractLine(POLL, 'var EFG_BANDS = '),
      extractFn(POLL, 'efgTier'),
      extractLine(POLL, 'function _clkSec(c)'),
      extractLine(POLL, 'function americanToImplied(ml)'),
      extractLine(POLL, 'function cbDepthRate(d)'),
      extractFn(POLL, 'divergenceRead'),
      extractFn(POLL, 'comebackProb'),
      extractFn(POLL, 'comebackEV'),
      extractFn(POLL, 'computeScoringComp'),
      extractFn(POLL, 'ssClassifyTier'),
      extractFn(POLL, 'ssLeadClassDisplay'),
      extractFn(POLL, 'ssComputeShape'),
      extractFn(POLL, 'ssNbaGapBase'),
      extractFn(POLL, 'ssNbaWatchCue'),
      extractFn(POLL, 'ssPriceStale'),
      extractFn(POLL, 'ssComposePushNba'),
      'return { SS_CFG, ssCfg, ssEnabled, ssStandingsSeason, ssComputeShape, ssNbaGapBase, ssNbaWatchCue, ssPriceStale, ssComposePushNba, WNBA_SS_ALERT_ON, WNBA_SS_B_ON, WNBA_SS_LEDGER_ON, WNBA_SS_WATCHLIST_ON, WNBA_SS_COMPUTE_OFF };',
    ].join('\n');
    return new Function('process', src)(process);
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

let pass = 0, fail = 0;
function T(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const shapeInput = (c, league) => ({ league, standings: STANDINGS, summary: c.summary, pbp: c.pbp, hA: c.hA, aA: c.aA,
  hPts: c.hPts, aPts: c.aPts, period: c.period, clock: c.clock, odds: c.odds });
const pinView = (o) => o == null ? null : {
  leadAl: o.leadAl, trailAl: o.trailAl, deficit: o.deficit, homeTrails: o.homeTrails,
  leadWP: o.leadWP, trailWP: o.trailWP, gap: o.gap, leadEfg: o.leadEfg, leadBand: o.leadBand, varShare: o.varShare, cls: o.cls,
  fadeT: o.fadeT, collT: o.collT, pPoint: o.pPoint, pLow: o.pLow, pHigh: o.pHigh, trailML: o.trailML, implied: o.implied, edge: o.edge,
  kelly: o.kelly, tier: o.tier, softCell: o.ladder.softCell, ledgerSub: o.ladder.ledgerSub, fired: o.fired,
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const M = build({ WNBA_SS_COMPUTE_OFF: null, WNBA_SS_ALERT_ON: null, WNBA_SS_B_ON: null, WNBA_SS_LEDGER_ON: null, WNBA_SS_WATCHLIST_ON: null, NBA_SS_COMPUTE_OFF: null, NBA_SS_WATCHLIST_ON: null, NBA_SS_LEDGER_ON: null });

// ── [1] WNBA GOLDEN ─────────────────────────────────────────────────────────
console.log(`\n[1] WNBA golden — ssComputeShape vs pre-refactor inline block (${GOLDEN.source_commit})`);
T('golden file has one pin per shared case', GOLDEN.cases.length === CASES.length && GOLDEN.cases.every((g, i) => g.name === CASES[i].name));
CASES.forEach((c, i) => {
  const got = pinView(M.ssComputeShape(shapeInput(c, 'wnba')));
  const exp = GOLDEN.cases[i].out;
  T(`golden: ${c.name}`, same(got, exp), same(got, exp) ? '' : `\n      got ${JSON.stringify(got)}\n      exp ${JSON.stringify(exp)}`);
});

// ── [2] NBA SHAPE ───────────────────────────────────────────────────────────
console.log('\n[2] NBA shape — populated vs null by config');
const N = CASES.map((c) => M.ssComputeShape(shapeInput(c, 'nba')));
const n1 = N[0];
T('A-shape input: gap / win%s / leader eFG / variance share / class / line populated',
  n1 && n1.gap != null && Math.abs(n1.gap - 0.393) < 0.001 && n1.leadWP != null && n1.trailWP != null && Math.abs(n1.leadEfg - 77.94) < 0.01 && n1.varShare === 78 && n1.cls === 'VOLATILE' && n1.trailML === 140);
T('A-shape input: band / fade / collapse / pPoint / implied / edge / kelly / tier all null, fired false',
  n1 && n1.leadBand === null && n1.fadeT === null && n1.collT === null && n1.pPoint === null && n1.implied === null && n1.edge === null && n1.kelly === null && n1.tier === null && n1.fired === false);
T('A-shape input: sc.fadeRead not computed (divergenceGate false)', n1 && n1.sc.fadeRead === null);
T('A-shape input: NBA ladder → ledgerSub GAP_BASE (gap ≥ .15, Q2, deficit 7), no tier/softCell', n1 && n1.ladder.ledgerSub === 'GAP_BASE' && n1.ladder.tier === null && n1.ladder.softCell === null);
T('A-shape input: NBA WATCHLIST cue fires (leader eFG 77.9 ≥ 57)', M.ssNbaWatchCue(n1, 2, M.SS_CFG.nba.cue) === true);
T('green-leader input (eFG 50): GAP_BASE yes, cue no', N[2].ladder.ledgerSub === 'GAP_BASE' && M.ssNbaWatchCue(N[2], 3, M.SS_CFG.nba.cue) === false);
T('no-PBP input: null early-out for NBA too', N[3] === null);
T('gp-4 trailer: WNBA wp present (minGP 4), NBA wp null (minGP 5) → gap null, no ledger, no cue',
  M.ssComputeShape(shapeInput(CASES[4], 'wnba')).trailWP === 0.75 && N[4].trailWP === null && N[4].gap === null && N[4].ladder.ledgerSub === null && M.ssNbaWatchCue(N[4], 2, M.SS_CFG.nba.cue) === false);
T('leader .464 / gap .071: NBA shape still written (gap, eFG), no ledger, no cue, trailML null (no odds)',
  N[5] && Math.abs(N[5].gap - 0.071) < 0.001 && N[5].leadEfg != null && N[5].ladder.ledgerSub === null && M.ssNbaWatchCue(N[5], 3, M.SS_CFG.nba.cue) === false && N[5].trailML === null);
T('unknown league → null (no cfg)', M.ssComputeShape(shapeInput(CASES[0], 'ncaamb')) === null);
T('ssEnabled: wnba + nba on by default; ncaamb off', M.ssEnabled('wnba') && M.ssEnabled('nba') && !M.ssEnabled('ncaamb'));

// ── [3] PREDICATES ──────────────────────────────────────────────────────────
console.log('\n[3] Phase 1b predicates — clause negatives (thresholds from SS_CFG.nba.cue)');
const cue = M.SS_CFG.nba.cue;
const S = (gap, deficit, leadEfg) => ({ gap, deficit, leadEfg });
T('cue thresholds pinned: gap .15 · eFG 57 · period ≤3 · deficit 1-9', cue.minGap === 0.15 && cue.minLeaderEfg === 57 && cue.maxPeriod === 3 && cue.minDeficit === 1 && cue.maxDeficit === 9);
T('GAP_BASE positive at every boundary (gap .15, deficit 1, Q3) and (deficit 9)', M.ssNbaGapBase(S(0.15, 1, 50), 3, cue) && M.ssNbaGapBase(S(0.15, 9, 50), 3, cue));
T('GAP_BASE: gap .149 fails', !M.ssNbaGapBase(S(0.149, 5, 60), 2, cue));
T('GAP_BASE: Q4 fails', !M.ssNbaGapBase(S(0.30, 5, 60), 4, cue));
T('GAP_BASE: deficit 0 and 10 fail', !M.ssNbaGapBase(S(0.30, 0, 60), 2, cue) && !M.ssNbaGapBase(S(0.30, 10, 60), 2, cue));
T('GAP_BASE: gap null fails (no fake reads)', !M.ssNbaGapBase(S(null, 5, 60), 2, cue));
T('cue: eFG 57.0 passes, 56.9 fails', M.ssNbaWatchCue(S(0.20, 5, 57.0), 2, cue) && !M.ssNbaWatchCue(S(0.20, 5, 56.9), 2, cue));
T('cue: eFG null fails even with GAP_BASE true', !M.ssNbaWatchCue(S(0.20, 5, null), 2, cue));
T('cue: requires GAP_BASE (Q4 hot leader fails)', !M.ssNbaWatchCue(S(0.20, 5, 70), 4, cue));
T('cue: string period "2" accepted (BDL period parse)', M.ssNbaWatchCue(S(0.20, 5, 60), '2', cue));

// ── [4] STALE-PRICE FLAG ────────────────────────────────────────────────────
console.log('\n[4] ssPriceStale — arithmetic, scale, nulls');
const g = M.SS_CFG.nba.staleGapPp;
T('staleGapPp pinned at .25', g === 0.25);
let ps = M.ssPriceStale(140, 65, g);
T('+140 (implied .417) vs ESPN 65 (0-100 scale) → gap .233 → not stale, fields rounded', ps && ps.stale === false && ps.implied === 0.417 && ps.espnWp === 0.65);
ps = M.ssPriceStale(140, 70, g);
T('+140 vs ESPN 70 → gap .283 → stale', ps && ps.stale === true);
T('0-1 scale input (.70) normalizes identically', same(M.ssPriceStale(140, 0.70, g), ps));
T('-300 (implied .75) vs ESPN 40 → stale (pregame favorite now trailing)', M.ssPriceStale(-300, 40, g).stale === true);
T('null ML → null; null ESPN → null; NaN ESPN → null', M.ssPriceStale(null, 60, g) === null && M.ssPriceStale(140, null, g) === null && M.ssPriceStale(140, 'x', g) === null);
T('WNBA cfg has no staleGapPp (flag never computed there)', M.SS_CFG.wnba.staleGapPp === undefined && M.SS_CFG.wnba.priceFields === 'full');

// ── [5] NBA PUSH COPY ───────────────────────────────────────────────────────
console.log('\n[5] ssComposePushNba — copy pins');
const base = { subtype: 'WATCHLIST', period: 2, clock: '5:00', leaderAl: 'MEM', trailerAl: 'BOS', leaderWP: 0.357, trailerWP: 0.75, gap: 0.393,
  leaderW: 10, leaderL: 18, trailerW: 21, trailerL: 7, leaderEfg: 77.94, leadClass: 'VOLATILE', margin: 7, bestML: 140, bestBook: 'Caesars',
  priceStale: { stale: false, implied: 0.417, espnWp: 0.65 } };
let p = M.ssComposePushNba(base);
T('title: ASCII only, review frame, not a bet call', /^[\x00-\x7F]*$/.test(p.title) && p.title === 'NBA REVIEW - BOS down 7 to MEM (not a bet call)');
T('priority 2 (review cue, same as WNBA WATCHLIST)', p.priority === 2);
T('body: records + both win rates + "quality gap" in points + deficit/period/clock', p.body.includes('BOS (21-7) is the better team — wins 75% of games vs MEM\'s 36% (quality gap 39 points) — and trails by 7 in Q2 5:00.'));
T('body: leader eFG in full words + lead-class display vocabulary (never the raw label)', p.body.includes('MEM is shooting 78% effective FG (shooting efficiency) — hot by NBA standards; the lead is variance-built.') && !p.body.includes('VOLATILE'));
T('body: ESPN live fair line for the trailer', p.body.includes('ESPN live fair for BOS: 65%.'));
T('body: live price with book, no stale suffix when not stale', p.body.includes('Live price: BOS +140 at Caesars.') && !p.body.includes('may be pregame'));
T('body: $300 class + exploratory tag + "Eyes, not a bet call"', p.body.includes('NBA watchlist ($300 class). Eyes, not a bet call — this cell is exploratory (+24 points vs ESPN on 39 games, one month); the forward log is the point.'));
T('body: no model probability, no cell rate, no Kelly, no "pp" jargon', !/true win chance|SIZE:|Kelly|\dpp\b|collapse/i.test(p.body));
p = M.ssComposePushNba({ ...base, priceStale: { stale: true, implied: 0.417, espnWp: 0.72 } });
T('stale → "(may be pregame)" suffix on the price line', p.body.includes('Live price: BOS +140 at Caesars (may be pregame).'));
p = M.ssComposePushNba({ ...base, bestML: null, bestBook: null, priceStale: null });
T('no line → "No live line posted yet." and no ESPN fair line (flag null)', p.body.includes('No live line posted yet.') && !p.body.includes('ESPN live fair'));
p = M.ssComposePushNba({ ...base, leadClass: 'EVEN', gap: null, leaderEfg: null });
T('null-safe: missing gap/eFG render "?" not NaN; EVEN class renders its display phrase', p.body.includes('quality gap ? points') && p.body.includes('shooting ?% effective FG') && p.body.includes('margin too thin to read') && !p.body.includes('NaN'));

// ── [6] CONFIG PINS ─────────────────────────────────────────────────────────
console.log('\n[6] SS_CFG pins');
T('wnba: minGP 4 · efgBands wnba · comebackModel wnba · divergenceGate · priceFields full · calendar season · all context blocks on',
  M.SS_CFG.wnba.minGP === 4 && M.SS_CFG.wnba.efgBands === 'wnba' && M.SS_CFG.wnba.comebackModel === 'wnba' && M.SS_CFG.wnba.divergenceGate === true && M.SS_CFG.wnba.priceFields === 'full' && M.SS_CFG.wnba.standingsSeason === 'calendar' && M.SS_CFG.wnba.teamCtx && M.SS_CFG.wnba.fuelTemp && M.SS_CFG.wnba.pctx && M.SS_CFG.wnba.narration && M.SS_CFG.wnba.pushComposer === 'wnba');
T('wnba: dashUrl = SS_DASH_URL (wnba-bdl.html)', M.SS_CFG.wnba.dashUrl.endsWith('/wnba-bdl.html'));
T('nba: minGP 5 · no bands · no comeback model · no divergence · line_only · oct_start · every context block off · bdl.html',
  M.SS_CFG.nba.minGP === 5 && M.SS_CFG.nba.efgBands === null && M.SS_CFG.nba.comebackModel === null && M.SS_CFG.nba.divergenceGate === false && M.SS_CFG.nba.priceFields === 'line_only' && M.SS_CFG.nba.standingsSeason === 'oct_start' && !M.SS_CFG.nba.teamCtx && !M.SS_CFG.nba.fuelTemp && !M.SS_CFG.nba.pctx && !M.SS_CFG.nba.narration && M.SS_CFG.nba.pushComposer === 'nba' && M.SS_CFG.nba.dashUrl.endsWith('/bdl.html'));
T('nba: A and B hard-off; WATCHLIST/LEDGER default off', M.SS_CFG.nba.tiers.A === false && M.SS_CFG.nba.tiers.B === false && M.SS_CFG.nba.tiers.WATCHLIST === false && M.SS_CFG.nba.tiers.LEDGER === false);
T('wnba: all tiers default off with no env', M.SS_CFG.wnba.tiers.A === false && M.SS_CFG.wnba.tiers.B === false && M.SS_CFG.wnba.tiers.WATCHLIST === false && M.SS_CFG.wnba.tiers.LEDGER === false && M.SS_CFG.wnba.enabled === true);
const ON = build({ WNBA_SS_COMPUTE_OFF: null, WNBA_SS_ALERT_ON: '1', WNBA_SS_B_ON: '1', WNBA_SS_LEDGER_ON: '1', WNBA_SS_WATCHLIST_ON: '1', NBA_SS_COMPUTE_OFF: null, NBA_SS_WATCHLIST_ON: '1', NBA_SS_LEDGER_ON: '1' });
T('wnba tiers mirror the four env flags when set', ON.SS_CFG.wnba.tiers.A === true && ON.SS_CFG.wnba.tiers.B === true && ON.SS_CFG.wnba.tiers.WATCHLIST === true && ON.SS_CFG.wnba.tiers.LEDGER === true && ON.WNBA_SS_ALERT_ON === true);
T('nba: NBA_SS_WATCHLIST_ON / NBA_SS_LEDGER_ON open WATCHLIST / LEDGER; A/B stay false', ON.SS_CFG.nba.tiers.WATCHLIST === true && ON.SS_CFG.nba.tiers.LEDGER === true && ON.SS_CFG.nba.tiers.A === false && ON.SS_CFG.nba.tiers.B === false);
const KILL = build({ WNBA_SS_COMPUTE_OFF: '1', NBA_SS_COMPUTE_OFF: '1', WNBA_SS_ALERT_ON: null, WNBA_SS_B_ON: null, WNBA_SS_LEDGER_ON: null, WNBA_SS_WATCHLIST_ON: null, NBA_SS_WATCHLIST_ON: null, NBA_SS_LEDGER_ON: null });
T('kill switches: WNBA_SS_COMPUTE_OFF / NBA_SS_COMPUTE_OFF disable each league independently', KILL.ssEnabled('wnba') === false && KILL.ssEnabled('nba') === false && build({ NBA_SS_COMPUTE_OFF: '1', WNBA_SS_COMPUTE_OFF: null }).ssEnabled('wnba') === true);

// ── [7] SEASON DERIVATION ───────────────────────────────────────────────────
console.log('\n[7] ssStandingsSeason');
const D = (s) => new Date(s + 'T12:00:00');
T("nba 2026-11-19 → 2026", M.ssStandingsSeason('nba', D('2026-11-19')) === 2026);
T("nba 2027-01-05 → 2026 (season straddles New Year)", M.ssStandingsSeason('nba', D('2027-01-05')) === 2026);
T("nba 2027-10-20 → 2027", M.ssStandingsSeason('nba', D('2027-10-20')) === 2027);
T("nba 2027-09-30 → 2026 (Sep is last season's label)", M.ssStandingsSeason('nba', D('2027-09-30')) === 2026);
T("wnba 2027-01-05 → 2027 (calendar, byte-identical to the old getFullYear)", M.ssStandingsSeason('wnba', D('2027-01-05')) === 2027);
T('fetchStandingsCache calls ssStandingsSeason (no bare getFullYear)', extractFn(POLL, 'fetchStandingsCache').includes('ssStandingsSeason(league, new Date())') && !extractFn(POLL, 'fetchStandingsCache').includes('new Date().getFullYear()'));

// ── [8] SOURCE GATES ────────────────────────────────────────────────────────
console.log('\n[8] source gates');
const codeLines = POLL.split('\n').filter((l) => !l.trim().startsWith('//'));
const codeCount = (needle) => codeLines.reduce((n, l) => n + (l.includes(needle) ? 1 : 0), 0);
T("no `league === 'wnba' && !WNBA_SS_COMPUTE_OFF` literal remains", codeCount("league === 'wnba' && !WNBA_SS_COMPUTE_OFF") === 0);
T('ssEnabled(league) at both gate sites (standings fetch + compute block)', codeCount('ssEnabled(league)') === 2 && POLL.includes('const ssStandings = ssEnabled(league) ? await fetchStandingsCache(sql, league) : {};') && POLL.includes('            if (ssEnabled(league)) {'));
T('WNBA_SS_COMPUTE_OFF: definition + SS_CFG only', codeCount('WNBA_SS_COMPUTE_OFF') === 2);
T('WNBA_SS_B_ON / _LEDGER_ON / _WATCHLIST_ON: definition + SS_CFG only', codeCount('WNBA_SS_B_ON') === 2 && codeCount('WNBA_SS_LEDGER_ON') === 2 && codeCount('WNBA_SS_WATCHLIST_ON') === 2);
T('WNBA_SS_ALERT_ON: definition + SS_CFG + the WNBA-literal A-tier repush sweep (pre-existing, league=wnba filtered)', codeCount('WNBA_SS_ALERT_ON') === 3 && extractFn(POLL, 'ssRepushSweep').includes("WHERE league = ${'wnba'} AND alert_tier = ${'A'}"));
const fireFn = extractFn(POLL, 'fireSweetSpotAlert');
const blkStart = POLL.indexOf('if (ssEnabled(league)) {'), blkEnd = POLL.indexOf('sweetspot compute non-fatal', blkStart);
const ssBlock = POLL.slice(blkStart, blkEnd);
T('no NBA_PAUSED / _isPaused inside the SS compute+fire block (Amendment 1 §A1.1)', !/NBA_PAUSED|_isPaused/.test(ssBlock) && ssBlock.length > 2000);
T('no NBA_PAUSED / _isPaused inside fireSweetSpotAlert', !/NBA_PAUSED|_isPaused/.test(fireFn));
T('fireSweetSpotAlert: tap target is cfg.dashUrl (no SS_DASH_URL literal), composer by cfg, ctx map gated by cfg.teamCtx, narration by cfg.narration',
  !fireFn.includes('SS_DASH_URL') && fireFn.includes('sendNtfy(push.title, _pushBody, push.priority, cfg.dashUrl)') && fireFn.includes("cfg.pushComposer === 'nba' ? ssComposePushNba(ss) : ssComposePush(ss)") && (fireFn.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').match(/cfg\.teamCtx/g) || []).length === 3 && fireFn.includes('if (!cfg.narration)'));
T('fire block: switches read _ssCfg.tiers (A/B/LEDGER/WATCHLIST), WATCHLIST predicate dispatched by watchModel',
  ssBlock.includes("(_ssTier === 'A' && _ssCfg.tiers.A) || (_ssTier === 'B' && _ssCfg.tiers.B)") && ssBlock.includes('_ssLad.ledgerSub != null && _ssCfg.tiers.LEDGER') && ssBlock.includes("_ssCfg.tiers.WATCHLIST && (_ssCfg.watchModel === 'nba'") && ssBlock.includes('ssNbaWatchCue(_ss, currentPeriod, _ssCfg.cue)') && ssBlock.includes('ssWatchGate(currentPeriod, _ssGap, _ssDeficit, _ssTrailML)'));
T('fire block: fuel/temp only under _ssCfg.fuelTemp; pctx only under _ssCfg.pctx; stale flag only for line_only',
  ssBlock.includes('if (_ssCfg.fuelTemp) {') && ssBlock.includes('_ssCfg.pctx ? { modelSummary: modelSummary, pbp: game._bdlPbp } : null') && ssBlock.includes("_ssCfg.priceFields === 'line_only'") && ssBlock.includes('ssPriceStale(_ssTrailML, _ssHomeTrails ? espnWP?.home : espnWP?.away, _ssCfg.staleGapPp)'));
T('snapshot UPDATE column list unchanged (17 ss_* columns, as before the refactor)', (ssBlock.match(/\bss_[a-z_]+ = \$\{/g) || []).length === 17 && ssBlock.includes('ss_alert_tier = ${_ssTier}, ss_alert_fired = ${_ssFired}'));
T('legacy inline helpers gone from the poll block (_bEfg / _ssPr / _ssEv / _ssSc)', !/_bEfg|_ssPr\b|_ssEv\b|_ssSc\b/.test(ssBlock));
T("post-game: SS_RESOLVE_LEAGUES = ['wnba', 'nba'] gates processSweetSpot", PGA.includes("const SS_RESOLVE_LEAGUES = ['wnba', 'nba'];") && PGA.includes('if (!SS_RESOLVE_LEAGUES.includes(league)) return null;') && !PGA.includes("if (league !== 'wnba') return null; // SS engine"));
T("post-game: graduation-crossing push WNBA-only; NBA branch filters BDL finals to Final and pushes nothing", PGA.includes("if (!isDry && league === 'wnba') {\n      for (const sub of ss.graduated) {") && PGA.includes("/final/i.test(String(g.status))") && !/SS\[nba\][^\n]*agentNtfy/.test(PGA));
T('post-game: NBA branch reuses the BDL finals for the classic-arc path (one call)', PGA.includes('(_nbaFinalsRaw || await fetchFinalScores(dateStr, league))'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

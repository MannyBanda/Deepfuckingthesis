// ═══════════════════════════════════════════════════════════════════════════════
// NBA SWEET SPOT DASHBOARD FIXTURES — NBA_SWEETSPOT_DASHBOARD_SPEC v1 + Amendment 1 (§3.6, A1.7)
// Extracts the SS_NBA block from bdl.html (not retyped) and asserts:
//   [1] Source-equality mirrors — ssLeadClassDisplay / americanToImplied / computeScoringComp /
//       ssPriceStale function-body byte-equal to poll-live-bdl.mjs; ssGapFmt to wnba-bdl.html;
//       SS_NBA_STALE_GAP === SS_CFG.nba.staleGapPp
//   [2] Exploratory constants pinned to research/2026-11-19_nba_ss_season_EXPLORATORY.md
//   [3] Gate line (gap tiers, both win%s, thin margin, null safety, A1.2 tie form)
//   [4] Cue read (null cases, Q1/Q4 lines, hot -> exploratory tag, forward switch at 30, not-hot)
//   [5] Price line (A1.3 priority: engine stamp first, card secondary, fallbacks, stale, no ESPN)
//   [6] Verdict (every V, row anchoring, VT both branches, T5 only, V8 freeze, line dead, no T1/T4)
//   [7] Forward-ledger panel (A1.4 empty copy, rows, power tags, switch line)
//   [8] Pregame read (both directions, GP guard, below bar, line + pregame tag, no line)
//   [9] Grep gates (…)
//  [10] D3 — computeNbaLiteProfiles golden (three committed Nov 18 finals, hand-computed eFG/pace), key
//       contract (lite:true, no killer/tiers/elite/identity/rotation), isolation + season derivation grep gates — N1: no WNBA-calibrated symbol inside the SS_NBA block; no --hairline/--bg-surface
//       tokens; no season literal left in fetchStandings; db-api exposes get_standings
// Run: node research/ss_nba_dashboard_fixtures.mjs
// ═══════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
import { computeNbaLiteProfiles, nbaSeasonYear as nbaSeasonYearServer } from '../netlify/functions/team-profiles-nightly.mjs';
const HTML = readFileSync('bdl.html', 'utf8');
const WHTML = readFileSync('wnba-bdl.html', 'utf8');
const POLL = readFileSync('netlify/functions/poll-live-bdl.mjs', 'utf8');
const DBAPI = readFileSync('netlify/functions/db-api.js', 'utf8');
const EXPL = readFileSync('research/2026-11-19_nba_ss_season_EXPLORATORY.md', 'utf8');
const TPN = readFileSync('netlify/functions/team-profiles-nightly.mjs', 'utf8');
const LITE_IN = JSON.parse(readFileSync('research/fixtures_nba_lite_golden_inputs.json', 'utf8'));

function extractFn(src, name) {
  const sig = `function ${name}(`;
  const i = src.indexOf(sig); if (i < 0) throw new Error(`not found: ${name}`);
  const open = src.indexOf('{', src.indexOf(')', i));
  let d = 0, j = open;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}
const bodyOf = (t) => t.slice(t.indexOf('{'));
const b0 = HTML.indexOf('// SS_NBA_BEGIN'), b1 = HTML.indexOf('// SS_NBA_END');
if (b0 < 0 || b1 < 0) throw new Error('SS_NBA block markers missing');
const BLOCK = HTML.slice(b0, b1);

// Sandbox: the block's pure functions + the globals the render/fetch layer references (stubbed).
const stubs = `var dbReady=false, FN='', games=[], cardState={}, standingsCache={}, selIds=[], document={};
function esc(s){return String(s||'');} function getTeamColor(){return '#fff';} function getState(g){return 'LIVE';} function renderCard(){}
async function fetch(){ throw new Error('no network in fixtures'); }`;
const names = ['ssGateLineNba', 'ssCueReadNba', 'ssPriceLineNba', 'ssVerdictComposeNba', 'ssForwardLedgerPanelNba', 'ssPregameReadNba',
  'ssGapFmt', 'ssLeadClassDisplay', 'americanToImplied', 'computeScoringComp', 'ssPriceStale', 'ssPowerTag', 'nbaSeasonYear', 'ssRecWp'];
const mod = new Function(`${stubs}\n${BLOCK}\nreturn { ${names.join(', ')}, SS_NBA_STALE_GAP, SS_NBA_EXPLORATORY, SS_NBA_SWITCH_N };`)();
const { ssGateLineNba, ssCueReadNba, ssPriceLineNba, ssVerdictComposeNba, ssForwardLedgerPanelNba, ssPregameReadNba,
  ssGapFmt, ssPowerTag, nbaSeasonYear, ssRecWp, SS_NBA_STALE_GAP, SS_NBA_EXPLORATORY: EX, SS_NBA_SWITCH_N } = mod;

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : fail++; if (!c) console.log(`  ✗ ${n}`); };
const has = (s, sub) => typeof s === 'string' && s.indexOf(sub) > -1;

// [1] source-equality mirrors
for (const f of ['ssLeadClassDisplay', 'americanToImplied', 'computeScoringComp', 'ssPriceStale'])
  T(`[1] ${f} body === poll-live-bdl.mjs`, bodyOf(extractFn(BLOCK, f)) === bodyOf(extractFn(POLL, f)));
T('[1] ssGapFmt body === wnba-bdl.html', bodyOf(extractFn(BLOCK, 'ssGapFmt')) === bodyOf(extractFn(WHTML, 'ssGapFmt')));
const staleLine = POLL.match(/staleGapPp:\s*([0-9.]+)/);
T('[1] SS_NBA_STALE_GAP === SS_CFG.nba.staleGapPp', !!staleLine && Number(staleLine[1]) === SS_NBA_STALE_GAP && SS_NBA_STALE_GAP === 0.25);
T('[1] block defines each mirror exactly once', ['ssLeadClassDisplay', 'americanToImplied', 'computeScoringComp', 'ssPriceStale', 'ssGapFmt'].every((f) => BLOCK.split(`function ${f}(`).length === 2));
T('[1] bdl.html defines each mirror exactly once (no collision outside the block)', ['ssLeadClassDisplay', 'americanToImplied', 'computeScoringComp', 'ssPriceStale', 'ssGapFmt'].every((f) => HTML.split(`function ${f}(`).length === 2));

// [2] exploratory constants pinned to the committed doc
T('[2] cue cell 74.4 / 50.1 / n=39 in doc', has(EXPL, '74.4') && has(EXPL, '50.1') && has(EXPL, '39 LOW') && EX.cue.p === 74.4 && EX.cue.espn === 50.1 && EX.cue.n === 39);
T('[2] gap-base +6.0 ±11.8 n=66 in doc', has(EXPL, '+6.0 (±11.8)') && has(EXPL, '66 LOW') && EX.gapBase.edge === 6.0 && EX.gapBase.ci === 11.8 && EX.gapBase.n === 66);
T('[2] source commit + as-of', EX.source === 'aaf0ec8' && EX.asof === '2026-11-19' && SS_NBA_SWITCH_N === 30);

// [3] gate line
T('[3] STRONG gap, both win%s, class display', ssGateLineNba({ gap: 0.39, leaderAlias: 'DEN', trailerAlias: 'POR', leaderWp: 0.357, trailerWp: 0.75, margin: 6, leadClass: 'VOLATILE' })
  === 'GAP .39 STRONG · LDR DEN .357 / TRL POR .750 · LEAD: variance-built');
T('[3] qualified tier', has(ssGateLineNba({ gap: 0.19, leaderAlias: 'A', trailerAlias: 'B', leaderWp: 0.5, trailerWp: 0.69, margin: 5, leadClass: 'MIXED' }), 'GAP .19 qualified'));
T('[3] below bar + mixed', has(ssGateLineNba({ gap: 0.08, leaderAlias: 'A', trailerAlias: 'B', leaderWp: 0.5, trailerWp: 0.58, margin: 5, leadClass: 'MIXED' }), 'GAP .08 below bar · LDR A .500 / TRL B .580 · LEAD: mixed'));
T('[3] .148 never renders as .15', has(ssGateLineNba({ gap: 0.148, leaderAlias: 'A', trailerAlias: 'B', leaderWp: 0.5, trailerWp: 0.648, margin: 5, leadClass: 'MIXED' }), 'GAP .148 below bar'));
T('[3] thin margin -> too thin to read', has(ssGateLineNba({ gap: 0.2, leaderAlias: 'A', trailerAlias: 'B', leaderWp: 0.5, trailerWp: 0.7, margin: 2, leadClass: 'STRUCTURAL' }), 'LEAD: too thin to read'));
T('[3] null gap / null wp safe', ssGateLineNba({ leaderAlias: 'A', trailerAlias: 'B', margin: 5 }) === 'GAP — · LDR A ? / TRL B ? · LEAD: —');
T('[3] no WNBA country words', !has(ssGateLineNba({ gap: 0.2, leaderWp: 0.3, trailerWp: 0.5, margin: 5 }), 'FADE COUNTRY') && !has(ssGateLineNba({ gap: 0.2, leaderWp: 0.6, trailerWp: 0.8, margin: 5 }), 'WATCH-ONLY'));
T('[3] A1.2 tie form (|gap|, direction note, both records, no lead)', ssGateLineNba({ tied: true, gap: -0.162, homeAlias: 'MIN', awayAlias: 'NYK', homeWp: 0.733, awayWp: 0.571 })
  === 'TIED · gap .16 (direction set by the next lead) · NYK .571 / MIN .733 · LEAD: —');
T('[3] tie with null gap', ssGateLineNba({ tied: true, homeAlias: 'A', awayAlias: 'B' }) === 'TIED · gap — · B ? / A ? · LEAD: —');

// [4] cue read
const L0 = {}, L5 = { WATCHLIST: { n_total: 7, n_resolved: 5, realized_pct: 60 }, GAP_BASE: { n_total: 12, n_resolved: 9, realized_pct: 55.6 } };
const L30 = { WATCHLIST: { n_total: 40, n_resolved: 31, realized_pct: 64.5 }, GAP_BASE: { n_total: 60, n_resolved: 50, realized_pct: 52 } };
T('[4] tie -> null', ssCueReadNba({ tied: true, gap: 0.3, deficit: 0, period: 2 }, L0) === null);
T('[4] gap below bar -> null', ssCueReadNba({ gap: 0.1, deficit: 5, period: 2, leaderEfg: 60 }, L0) === null);
T('[4] gap null -> null', ssCueReadNba({ deficit: 5, period: 2, leaderEfg: 60 }, L0) === null);
T('[4] deficit 10 -> null', ssCueReadNba({ gap: 0.3, deficit: 10, period: 2, leaderEfg: 60 }, L0) === null);
T('[4] Q4 -> window closed line', has(ssCueReadNba({ gap: 0.3, deficit: 5, period: 4, leaderEfg: 60 }, L0), 'Q4 — cue window closed'));
T('[4] Q1 -> gates read from Q2', has(ssCueReadNba({ gap: 0.3, deficit: 5, period: 1, leaderEfg: 60 }, L0), 'Gates read from Q2'));
const hot0 = ssCueReadNba({ gap: 0.3, deficit: 5, period: 2, leaderEfg: 63.6 }, L0);
T('[4] hot, no ledger -> WATCH SHAPE + tagged exploratory + 0/30', has(hot0, 'WATCH SHAPE — the better team is down 5 to a hot leader (eFG 64%).') && has(hot0, '[this season · exploratory · LOW] trailers WON 74% vs ESPN 50% on 39 Q2–Q3 spots through Nov 19') && has(hot0, 'collecting (0/30)'));
T('[4] hot, n=5 -> still exploratory, 5/30', has(ssCueReadNba({ gap: 0.3, deficit: 5, period: 3, leaderEfg: 60 }, L5), 'collecting (5/30)'));
const hot30 = ssCueReadNba({ gap: 0.3, deficit: 5, period: 3, leaderEfg: 60 }, L30);
T('[4] hot, n=31 -> forward number, exploratory dropped', has(hot30, 'Forward log: trailers WIN 65% [n=31, LOW]') && !has(hot30, 'exploratory'));
T('[4] eFG exactly 57 is hot', has(ssCueReadNba({ gap: 0.2, deficit: 3, period: 2, leaderEfg: 57 }, L0), 'WATCH SHAPE'));
const nh = ssCueReadNba({ gap: 0.2, deficit: 3, period: 2, leaderEfg: 52 }, L5);
T('[4] not hot -> GAP SPOT, tagged about-even base, GAP_BASE n', has(nh, 'GAP SPOT — gap qualifies, leader not hot (eFG 52%).') && has(nh, '[this season · exploratory · LOW]') && has(nh, '+6.0 ±11.8, n=66') && has(nh, 'collecting it (9/30)'));
T('[4] no WNBA rate words anywhere', ![hot0, hot30, nh].some((s) => has(s, 'HOLD') || has(s, 'fade country') || has(s, 'converts')));

// [5] price line (A1.3)
T('[5] engine stamp first, ESPN fair, card differs appended', ssPriceLineNba({ trailerAlias: 'MIN', serverML: 135, cardML: '140', espnTrailerWp: 42 })
  === 'engine saw MIN +135 (implied 43%) · ESPN fair 42% · card line +140');
T('[5] stale flag at > .25 gap (+300 = 25% implied vs ESPN 61%)', ssPriceLineNba({ trailerAlias: 'DEN', serverML: 300, espnTrailerWp: 61 }) === 'engine saw DEN +300 (implied 25%) · ESPN fair 61% ⚠ may be pregame');
T('[5] not stale inside .25 (+140 = 42% vs 61%)', !has(ssPriceLineNba({ trailerAlias: 'DEN', serverML: 140, espnTrailerWp: 61 }), 'may be pregame'));
T('[5] not stale at .25 exactly (strict >)', !has(ssPriceLineNba({ trailerAlias: 'X', serverML: 100, espnTrailerWp: 0.75 }), 'may be pregame'));
T('[5] ESPN 0-1 scale normalized', has(ssPriceLineNba({ trailerAlias: 'X', serverML: -150, espnTrailerWp: 0.6 }), 'ESPN fair 60%'));
T('[5] no ESPN -> no fair clause, no stale flag', ssPriceLineNba({ trailerAlias: 'X', serverML: 250 }) === 'engine saw X +250 (implied 29%)');
T('[5] stamp null -> card line labeled', ssPriceLineNba({ trailerAlias: 'X', cardML: '+180', espnTrailerWp: 40 }) === 'card line X +180 (implied 36%) · ESPN fair 40%');
T('[5] same card and stamp -> no duplicate suffix', !has(ssPriceLineNba({ trailerAlias: 'X', serverML: 135, cardML: '135' }), 'card line'));
T('[5] neither -> MARKET nudge', ssPriceLineNba({ trailerAlias: 'X' }) === 'no line observed — tap MARKET to add one');
T('[5] empty-string card ML treated as absent', ssPriceLineNba({ trailerAlias: 'X', cardML: '' }) === 'no line observed — tap MARKET to add one');

// [6] verdict
const base = { homeAlias: 'MIN', awayAlias: 'NYK' };
let r = ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.16, leaderEfg: 60, rows: [{ subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }] });
T('[6] V1 WATCHLIST row in band', r.v === 'V1' && has(r.text, 'REVIEW — MIN is the better team (.16 quality gap) down 5') && has(r.text, 'See the push.') && r.color === '#4aa3ff');
r = ssVerdictComposeNba({ ...base, period: 3, homePts: 50, awayPts: 40, leaderAlias: 'MIN', gap: -0.16, rows: [{ subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }] });
T('[6] anchoring: row trailer now LEADS (rowDef -10) -> falls through to current-state read (gap flipped negative -> V4), not V1', r.v !== 'V1' && r.v === 'V4' && has(r.text, 'quality gap (-0.16)'));
r = ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 50, leaderAlias: 'NYK', gap: 0.16, rows: [{ subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }] });
T('[6] anchoring: row trailer down 10 -> out of band V6', r.v === 'V6' && has(r.text, 'OUT OF BAND — MIN down 10: outside the 1–9 window. No chasing.'));
r = ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.2, leaderEfg: 50, rows: [{ subtype: 'GAP_BASE', leader: 'NYK', trailer: 'MIN' }], gapBaseN: 9 });
T('[6] V3 GAP_BASE row in band with ledger n', r.v === 'V3' && has(r.text, 'GAP SPOT, LOGGING') && has(r.text, '(9/30 resolved)'));
r = ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.2, rows: [{ subtype: 'GAP_BASE', leader: 'NYK', trailer: 'MIN' }, { subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }] });
T('[6] WATCHLIST outranks GAP_BASE', r.v === 'V1');
T('[6] V0 pre-Q2', ssVerdictComposeNba({ ...base, period: 1, homePts: 20, awayPts: 25, gap: 0.3 }).v === 'V0');
T('[6] V0 with no snapshot (period only)', ssVerdictComposeNba({ period: 0, homeAlias: 'A', awayAlias: 'B' }).text === 'Gates read from Q2 — no verdict yet.');
r = ssVerdictComposeNba({ ...base, period: 2, homePts: 25, awayPts: 25, leaderAlias: 'MIN', gap: -0.162 });
T('[6] VT tied, qualified: |gap| + better team (gap<0 -> home better)', r.v === 'VT' && r.text === 'TIED — no trailer to read. The .16 gap resolves on the next lead; MIN would be the watch trailer.');
r = ssVerdictComposeNba({ ...base, period: 2, homePts: 25, awayPts: 25, leaderAlias: 'MIN', gap: 0.2 });
T('[6] VT tied, gap>0 -> away better', has(r.text, 'NYK would be the watch trailer'));
r = ssVerdictComposeNba({ ...base, period: 3, homePts: 60, awayPts: 60, leaderAlias: 'MIN', gap: 0.08 });
T('[6] VT tied, below bar', r.v === 'VT' && r.text === 'TIED — gap (.08) is below the review line either way.');
T('[6] VT tied, null gap', has(ssVerdictComposeNba({ ...base, period: 3, homePts: 60, awayPts: 60 }).text, 'gap (no standings gap) is below'));
r = ssVerdictComposeNba({ ...base, period: 2, homePts: 25, awayPts: 25, gap: 0.3, rows: [{ subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }] });
T('[6] tied with a row (rowDef 0, out of band) -> VT not V1', r.v === 'VT');
r = ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.1 });
T('[6] V4 below bar', r.v === 'V4' && has(r.text, 'NO SPOT — quality gap (.10) is below the review line (.15).') && has(r.text, 'size like it'));
T('[6] V4 null gap wording', has(ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45 }).text, '(no standings gap)'));
r = ssVerdictComposeNba({ ...base, period: 4, homePts: 80, awayPts: 85, leaderAlias: 'NYK', gap: 0.3 });
T('[6] V7 Q4 window closed', r.v === 'V7' && has(r.text, 'Q4 — the NBA cue window closed after Q3.'));
r = ssVerdictComposeNba({ ...base, period: 4, homePts: 70, awayPts: 85, leaderAlias: 'NYK', gap: 0.3 });
T('[6] Q4 down 15 -> V7 (no V6 in Q4, no DEAD/Q4 DEEP)', r.v === 'V7' && !has(r.text, 'DEAD') && !has(r.text, 'Q4 DEEP'));
r = ssVerdictComposeNba({ ...base, period: 3, homePts: 60, awayPts: 65, leaderAlias: 'NYK', gap: 0.3 });
T('[6] VX read forming', r.v === 'VX' && has(r.text, 'READ FORMING'));
// traps
r = ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.1, leaderEfg: 61 });
T('[6] T5 on V4: hot leader without a gap', r.trap != null && has(r.trap, 'Hot leader without a quality gap') && has(r.trap, '1,200 NBA games'));
T('[6] T5 fires on VT below bar too', ssVerdictComposeNba({ ...base, period: 2, homePts: 25, awayPts: 25, gap: 0.05, leaderEfg: 60 }).trap != null);
T('[6] no T5 when gap qualifies', ssVerdictComposeNba({ ...base, period: 3, homePts: 60, awayPts: 65, leaderAlias: 'NYK', gap: 0.3, leaderEfg: 65 }).trap === null);
T('[6] no T5 when leader not hot', ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.1, leaderEfg: 56.9 }).trap === null);
T('[6] no T5 on V1/V3/V6/V7', [
  ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.1, leaderEfg: 70, rows: [{ subtype: 'GAP_BASE', leader: 'NYK', trailer: 'MIN' }] }),
  ssVerdictComposeNba({ ...base, period: 4, homePts: 80, awayPts: 85, leaderAlias: 'NYK', gap: 0.3, leaderEfg: 70 }),
  ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 52, leaderAlias: 'NYK', gap: 0.3, leaderEfg: 70 }),
].every((x) => x.trap === null));
T('[6] Q4 with a below-bar gap is V4 (V4 outranks V7) and carries T5 when hot', (() => { const x = ssVerdictComposeNba({ ...base, period: 4, homePts: 80, awayPts: 85, leaderAlias: 'NYK', gap: 0.1, leaderEfg: 70 }); return x.v === 'V4' && x.trap != null; })());
T('[6] T1/T4 WNBA kills never render', !has(extractFn(BLOCK, 'ssVerdictComposeNba'), 'Jun 21') && !has(extractFn(BLOCK, 'ssVerdictComposeNba'), 'POR@CHI') && !has(extractFn(BLOCK, 'ssVerdictComposeNba'), '.20 bar'));
// V8 freeze
r = ssVerdictComposeNba({ ...base, period: 4, homePts: 100, awayPts: 98, leaderAlias: 'MIN', gap: -0.16, rows: [{ subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }], gameStatus: 'closed', finalHome: 104, finalAway: 101, winner: 'MIN' });
T('[6] V8 freeze: row trailer won by games.winner', r.v === 'V8' && has(r.text, 'Final 104-101 — MIN completed the comeback.'));
r = ssVerdictComposeNba({ ...base, period: 4, homePts: 95, awayPts: 98, leaderAlias: 'NYK', gap: 0.16, rows: [{ subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }], gameStatus: 'closed', finalHome: 99, finalAway: 105, winner: 'NYK' });
T('[6] V8 freeze: did not come back', r.v === 'V8' && has(r.text, 'MIN did not come back.'));
r = ssVerdictComposeNba({ ...base, period: 4, homePts: 100, awayPts: 100, gap: 0.2, gameStatus: 'closed', finalHome: 108, finalAway: 100, winner: 'MIN' });
T('[6] closed on a tied last snapshot with no row -> no V8 subject invented', r.v === 'VT');
T('[6] line dead suffix', has(ssVerdictComposeNba({ ...base, period: 3, homePts: 60, awayPts: 65, leaderAlias: 'NYK', gap: 0.3, lineUsed: 50000 }).text, 'Line dead.'));
T('[6] no WNBA subtype ever matches (EFG_FADE rows ignored)', ssVerdictComposeNba({ ...base, period: 3, homePts: 60, awayPts: 65, leaderAlias: 'NYK', gap: 0.3, subtypes: ['EFG_FADE'] }).v === 'VX');

// [7] forward-ledger panel
let P = ssForwardLedgerPanelNba({});
T('[7] A1.4 empty copy, four lines verbatim', P.length === 4 && P[0] === 'WATCHLIST  0 rows · 0 resolved · —' && P[1] === 'GAP_BASE   0 rows · 0 resolved · —'
  && P[2] === 'origin: exploratory cell +24pp vs ESPN, n=39 LOW, as of 2026-11-19 (aaf0ec8)' && P[3] === 'switch to forward numbers at 30 resolved WATCHLIST rows');
P = ssForwardLedgerPanelNba({ WATCHLIST: { n_total: 3, n_resolved: 0, realized_pct: null } });
T('[7] rows but none resolved -> dash rate', P[0] === 'WATCHLIST  3 rows · 0 resolved · —');
P = ssForwardLedgerPanelNba(L5);
T('[7] resolved -> trailer-WINS + power tag', P[0] === 'WATCHLIST  7 rows · 5 resolved · trailer-WINS 60% [LOW]' && P[1] === 'GAP_BASE   12 rows · 9 resolved · trailer-WINS 56% [LOW]');
P = ssForwardLedgerPanelNba(L30);
T('[7] at 31 resolved the switch line disappears', P.length === 3 && !P.some((l) => has(l, 'switch to forward')));
T('[7] power tags', ssPowerTag(79) === 'LOW' && ssPowerTag(80) === 'MED' && ssPowerTag(199) === 'MED' && ssPowerTag(200) === 'HIGH');
T('[7] origin line carries the tag words from the exploratory', has(P[2], 'LOW') && has(P[2], EX.source));

// [8] pregame read
const pg = (o) => ssPregameReadNba({ homeAlias: 'DEN', awayAlias: 'POR', home: { w: 9, l: 4 }, away: { w: 4, l: 9 }, cueHist: {}, ledger: {}, standingsAsOf: 'Nov 19 03:10', ...o });
let G = pg({});
T('[8] head: records, win%s, gap tier', G[0] === 'PREGAME READ — as-of records POR 4-9 (.308) · DEN 9-4 (.692) · gap .38 STRONG');
T('[8] both directions stated', G[1] === 'If POR leads in Q2–Q3 by 1–9 → DEN is the watch trailer (hot-leader cue needs POR eFG ≥ 57).' && G[2] === 'If DEN leads → no spot (gap runs the wrong way).');
T('[8] season line with empty history + empty ledger', G[3] === 'This season: POR 0 · DEN 0. Forward ledger: WATCH 0 resolved.');
T('[8] footer standings only when no line', G[4] === 'Standings as of Nov 19 03:10');
G = pg({ homeML: -400, awayML: 310, linePregame: true });
T('[8] footer line + pregame tag', G[4] === 'Standings as of Nov 19 03:10 · line: POR +310 / DEN −400 (pregame)'.replace('−', '-'));
G = pg({ cueHist: { DEN: { n: 2, won: 2, open: 0 }, POR: { n: 1, won: 0, open: 1 } }, ledger: L5 });
T('[8] cue history + ledger line', G[3] === 'This season: POR 1 watchlist cue as trailer (0 WON, 1 open) · DEN 2 watchlist cues as trailer (2 WON). Forward ledger: WATCH 5 resolved · 60% [LOW].');
G = pg({ away: { w: 3, l: 1 } });
T('[8] GP guard: <5 GP team -> no gap, guard line', has(G[0], 'POR 3-1 (<5 GP — no gap yet)') && !has(G[0], 'gap') === false && G[1] === 'No gap read until both teams reach 5 games.' && G.length === 4);
G = pg({ away: { w: 8, l: 5 } });
T('[8] below bar -> no spot either direction', has(G[0], 'gap .08 below bar') && G[1] === 'Gap .08 is below the review line (.15) — no spot in either direction.' && G.length === 4);
G = pg({ away: { w: 7, l: 6 } });
T('[8] gap .1538 renders qualified (not the .15 rounding trap)', has(G[0], 'gap .15 qualified') && has(G[1], 'DEN is the watch trailer'));
G = pg({ home: null, away: null });
T('[8] no standings at all -> dashes + guard line', G[0] === 'PREGAME READ — as-of records POR — · DEN —' && G[1] === 'No gap read until both teams reach 5 games.');
T('[8] ssRecWp guard at exactly 5 GP', ssRecWp({ w: 3, l: 2 }) === 0.6 && ssRecWp({ w: 3, l: 1 }) === null);

// [9] grep gates
for (const sym of ['SS_STRUCT', 'SS_SEASON26', 'computeFuelTemp', 'ssCautionLines', 'comebackProb', 'EFG_BANDS', 'ekBadge', 'STICKY', 'efgTier', 'ssClassifyTier', 'HOLDER READ', 'FADE COUNTRY', 'WATCH-ONLY'])
  T(`[9] N1: no "${sym}" inside the SS_NBA block`, !has(BLOCK, sym));
T('[9] no WNBA CSS tokens inside the block', !has(BLOCK, 'var(--hairline') && !has(BLOCK, 'var(--bg-surface') && !has(BLOCK, 'var(--fg-') && !has(BLOCK, 'var(--coral') && !has(BLOCK, 'var(--r-inner'));
T('[9] no WNBA rate numbers (54.9/52.2/35.8/75.1/72.0/67) inside the block', !/\b(54\.9|52\.2|35\.8|75\.1|72\.0)\b/.test(BLOCK) && !has(BLOCK, 'killer'));
T('[9] fetchStandings carries no season literal; derived season via nbaSeasonYear', !has(extractFn(HTML, 'fetchStandings'), "season:'2025'") && has(extractFn(HTML, 'fetchStandings'), 'nbaSeasonYear(') && has(extractFn(HTML, 'fetchStandings'), 'get_standings'));
T('[9] A1.1: the three server-coupled season literals are untouched (branch-owned)', HTML.split('get_season_cache&league=nba&season=2025').length === 2 && HTML.split('get_wp_profiles&league=nba&season=2025-26').length === 3);
T('[9] nbaSeasonYear Oct-start', nbaSeasonYear(new Date(2026, 10, 19)) === 2026 && nbaSeasonYear(new Date(2026, 8, 30)) === 2025 && nbaSeasonYear(new Date(2027, 2, 1)) === 2026 && nbaSeasonYear(new Date(2026, 9, 1)) === 2026);
T('[9] db-api exposes get_standings reading standings_cache', has(DBAPI, "action === 'get_standings'") && has(extractFnLoose(DBAPI, "action === 'get_standings'"), 'FROM standings_cache'));
T('[9] mount: SC container renders on _ssBox too; box first; bars guarded by lc', has(HTML, 'if(lc || _ssBox){') && has(HTML, "html+=_ssBox;\n      if(lc){") && has(HTML, '} // end if(lc) bars'));
T('[9] auto-open once guard', has(BLOCK, '_ssAutoOpened'));
T('[9] pregame block mounted on PRE cards', has(HTML, 'renderSSPregameNba(id,cs,game,hA,aA)'));
T('[9] grid starts the 60s walker + prefetch', has(HTML, 'startSSNbaTimer(); ssNbaPrefetch();'));
T('[9] every fetch in the block passes league=nba', !/db-api\?action=(get_ss_state|ss_ledger_summary|get_sweetspot_alerts|get_team_profiles|get_standings)[^'"]*league=wnba/.test(BLOCK));

// [10] D3 — NBA lite profiles (pure compute over the three committed finals)
const LP = computeNbaLiteProfiles(LITE_IN, '2026-11-19');
T('[10] six teams from three finals', Object.keys(LP).length === 6);
T('[10] W/L from games.winner', LP.ATL.w === 1 && LP.ATL.l === 0 && LP.OKC.w === 0 && LP.OKC.l === 1 && LP.DEN.w === 1 && LP.BOS.l === 1 && LP.CHI.w === 1 && LP.BKN.l === 1);
T('[10] hand-computed eFG (OKC 46+4.5 / 91 = 55.5; opp ATL 44+10 / 99 = 54.5)', LP.OKC.profile.efg === 55.5 && LP.OKC.profile.opp_efg === 54.5 && LP.ATL.profile.efg === 54.5 && LP.ATL.profile.opp_efg === 55.5);
T('[10] hand-computed eFG (DEN 37+3.5 / 85 = 47.6; BKN 39+7.5 / 81 = 57.4; CHI 53+10.5 / 99 = 64.1)', LP.DEN.profile.efg === 47.6 && LP.DEN.profile.opp_efg === 46.4 && LP.BKN.profile.efg === 57.4 && LP.BKN.profile.opp_efg === 64.1 && LP.CHI.profile.efg === 64.1);
T('[10] pace = mean of both poss (OKC (107.4+102.8)/2 = 105.1; DEN 99.7)', LP.OKC.profile.pace === 105.1 && LP.ATL.profile.pace === 105.1 && LP.DEN.profile.pace === 99.7);
T('[10] l10 + gp + h2h', LP.ATL.profile.l10.w === 1 && LP.ATL.profile.l10.l === 0 && LP.ATL.profile.gp === 1 && LP.ATL.profile.h2h.OKC.w === 1 && LP.OKC.profile.h2h.ATL.l === 1 && LP.ATL.profile.box_gp === 1);
T('[10] key contract: lite:true, asof, and NONE of the WNBA profile keys', Object.values(LP).every((p) => p.profile.lite === true && p.profile.asof === '2026-11-19' && ['killer', 'tiers', 'tiers_elite', 'elite', 'identity', 'rotation', 'archetype', 'infl', 'late_exec'].every((k) => !(k in p.profile))));
// degradations
const LP2 = computeNbaLiteProfiles([{ ...LITE_IN[0], raw_stats_json: { home: { fgm: 0, fga: 0 }, away: { fgm: 1, fga: 2 } } }], null);
T('[10] half-empty box: W/L counted, eFG/pace null, box_gp 0', LP2.OKC.l === 1 && LP2.OKC.profile.efg === null && LP2.OKC.profile.pace === null && LP2.OKC.profile.box_gp === 0 && LP2.OKC.profile.asof === null);
T('[10] string raw_stats_json parsed', computeNbaLiteProfiles([{ ...LITE_IN[1], raw_stats_json: JSON.stringify(LITE_IN[1].raw_stats_json) }]).DEN.profile.efg === 47.6);
T('[10] no winner -> game skipped entirely', Object.keys(computeNbaLiteProfiles([{ ...LITE_IN[1], winner: null }])).length === 0);
const L12 = []; for (let i = 0; i < 12; i++) L12.push({ game_id: 'g' + i, date: '2026-11-' + String(1 + i).padStart(2, '0'), home_alias: 'AAA', away_alias: 'B' + i, home_pts: 100, away_pts: 90, winner: i < 2 ? 'B' + i : 'AAA', raw_stats_json: { home: { fgm: 40, fga: 80, fg3m: 10, poss: 100 }, away: { fgm: 40, fga: 80, fg3m: 10, poss: 100 } } });
T('[10] l10 is the LAST ten by date (two early losses fall out)', computeNbaLiteProfiles(L12).AAA.profile.l10.w === 10 && computeNbaLiteProfiles(L12).AAA.profile.l10.l === 0 && computeNbaLiteProfiles(L12).AAA.l === 2);
T('[10] server nbaSeasonYear Oct-start, Arizona day', nbaSeasonYearServer('2026-11-20T02:00:00Z') === 2026 && nbaSeasonYearServer('2026-09-30T12:00:00Z') === 2025 && nbaSeasonYearServer('2026-10-01T12:00:00Z') === 2026 && nbaSeasonYearServer('2027-03-01T12:00:00Z') === 2026);
T('[10] stage isolated in try/catch after the WNBA summary, skipped on backfill, no push', has(TPN, "try { nbaLite = await runNbaLiteStage(sql, url, isDry, todayAz); }") && has(TPN, 'if (!isBackfill) {') && TPN.lastIndexOf('runNbaLiteStage(sql, url') > TPN.indexOf("await notify('team-profiles', summary)") && !has(extractFn(TPN, 'runNbaLiteStage'), 'notify('));
T('[10] stage writes league nba / archetype LITE, finals query = winner not null + raw present + date::text', (() => { const f = extractFn(TPN, 'runNbaLiteStage'); return has(f, "${'nba'}") && has(f, "${'LITE'}") && has(f, 'g.winner IS NOT NULL') && has(f, 's.raw_stats_json IS NOT NULL') && has(f, 'g.date::text AS date') && has(f, 'DISTINCT ON (s.game_id)'); })());
T('[10] WNBA stage untouched: league const still wnba, ensureTeamCtx still wnba-gated', has(TPN, "const league = 'wnba'; // v1 WNBA-only (spec §4)") && has(POLL, "if (!TEAM_CTX_ON || league !== 'wnba') return;"));
T('[10] dashboard reads lite profiles by derived season and requires profile.lite', has(BLOCK, "get_team_profiles&league=nba&season='+nbaSeasonYear(new Date())") && has(BLOCK, 'if(p&&p.lite)'));

function extractFnLoose(src, marker) { const i = src.indexOf(marker); const j = src.indexOf('\n    }\n', i); return src.slice(i, j); }

console.log(`ss_nba_dashboard fixtures: ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);

// ═══════════════════════════════════════════════════════════════════════════════
// NBA SWEET SPOT DASHBOARD FIXTURES — NBA_SWEETSPOT_DASHBOARD_SPEC v1 + Amendments 1–2 (§3.6, A1.7, A2.6)
// Extracts the SS_NBA blocks from bdl.html AND v3.html (not retyped) and asserts:
//   [0] CORE byte-equality — the SS_NBA_CORE block is identical in bdl.html and v3.html (A2.2)
//   [1] Server mirrors — ssLeadClassDisplay / americanToImplied / ssPriceStale function-body byte-equal to
//       poll-live-bdl.mjs (in the core, so both files); computeScoringComp (bdl.html only) and ssGapFmt
//       (wnba-bdl.html) likewise; vShareTier (v3.html only) byte-equal to wnba-bdl.html; SS_NBA_STALE_GAP ===
//       SS_CFG.nba.staleGapPp; SS_NBA_HOT_EFG === SS_CFG.nba.cue.minLeaderEfg
//   [2] Exploratory constants pinned to research/2026-11-19_nba_ss_season_EXPLORATORY.md
//   [3] Gate line · [4] Cue read · [5] Price line (A1.3) · [6] Verdict (color KEYS, A2.3) · [7] Ledger panel
//   [8] Pregame read · [8b] ctx strip text (A2.8b) · [8c] fire-time line (A2.8d) · [8d] header chip (A2.4 #4)
//   [9] Grep gates — N1 symbols, tokens, season literals, mounts, hooks, league=nba, v3 specifics
//  [10] D3 — computeNbaLiteProfiles golden (three committed Nov 18 finals, hand-computed eFG/pace/diffs)
// Run: node research/ss_nba_dashboard_fixtures.mjs
// ═══════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
import { computeNbaLiteProfiles, nbaSeasonYear as nbaSeasonYearServer } from '../netlify/functions/team-profiles-nightly.mjs';
const HTML = readFileSync('bdl.html', 'utf8');
const V3 = readFileSync('v3.html', 'utf8');
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
const slice = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b); if (i < 0 || j < 0) throw new Error(`markers missing: ${a}`); return src.slice(i, j); };
const BLOCK = slice(HTML, '// SS_NBA_BEGIN', '// SS_NBA_END');
const BLOCK3 = slice(V3, '// SS_NBA_BEGIN', '// SS_NBA_END');
const CORE = slice(HTML, '// SS_NBA_CORE_BEGIN', '// SS_NBA_CORE_END');
const CORE3 = slice(V3, '// SS_NBA_CORE_BEGIN', '// SS_NBA_CORE_END');
const BDL_SP = HTML.slice(HTML.indexOf('// SS_NBA_CORE_END'), HTML.indexOf('// SS_NBA_END'));
const V3_SP = V3.slice(V3.indexOf('// SS_NBA_CORE_END'), V3.indexOf('// SS_NBA_END'));

// Sandboxes: the core alone (pure pins) and each file's full block (per-file helpers), with the globals stubbed.
const stubs = `var dbReady=false, FN='', games=[], cardState={}, standingsCache={}, selIds=[], activeGameId=null, _collOpen={}, document={};
function esc(s){return String(s||'');} function getTeamColor(){return '#fff';} function tc(){return '#fff';} function getState(g){return 'LIVE';} function renderCard(){} function ordinal(n){return n+'th';}
async function fetch(){ throw new Error('no network in fixtures'); }`;
const coreNames = ['ssGateLineNba', 'ssCueReadNba', 'ssPriceLineNba', 'ssVerdictComposeNba', 'ssForwardLedgerPanelNba', 'ssPregameReadNba', 'ssCtxStripTextNba', 'ssNbaFireLine', 'ssNbaChipFor',
  'ssGapFmt', 'ssLeadClassDisplay', 'americanToImplied', 'ssPriceStale', 'ssPowerTag', 'nbaSeasonYear', 'ssRecWp', 'ssSigned'];
const core = new Function(`${stubs}\nfunction ssNbaRerender(){} function ssNbaAutoOpen(){}\n${CORE}\nreturn { ${coreNames.join(', ')}, SS_NBA_STALE_GAP, SS_NBA_EXPLORATORY, SS_NBA_SWITCH_N, SS_NBA_HOT_EFG };`)();
const { ssGateLineNba, ssCueReadNba, ssPriceLineNba, ssVerdictComposeNba, ssForwardLedgerPanelNba, ssPregameReadNba, ssCtxStripTextNba, ssNbaFireLine, ssNbaChipFor,
  ssGapFmt, ssPowerTag, nbaSeasonYear, ssRecWp, ssSigned, SS_NBA_STALE_GAP, SS_NBA_EXPLORATORY: EX, SS_NBA_SWITCH_N, SS_NBA_HOT_EFG } = core;
const bdlMod = new Function(`${stubs}\n${BLOCK}\nreturn { SS_NBA_COLORS, computeScoringComp };`)();
const v3Mod = new Function(`${stubs}\n${BLOCK3}\nreturn { SS_NBA_COLORS, vShareTier, ssNbaEfgColor, ssNbaBoxEfg };`)();

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : fail++; if (!c) console.log(`  ✗ ${n}`); };
const has = (s, sub) => typeof s === 'string' && s.indexOf(sub) > -1;

// [0] core byte-equality
T('[0] SS_NBA_CORE byte-equal bdl.html === v3.html', CORE === CORE3 && CORE.length > 10000);
T('[0] core carries every shared pure fn + the fetch layer', ['ssGateLineNba', 'ssCueReadNba', 'ssPriceLineNba', 'ssVerdictComposeNba', 'ssForwardLedgerPanelNba', 'ssPregameReadNba', 'ssCtxStripTextNba', 'ssNbaFireLine', 'ssNbaChipFor', 'fetchSSStateNba', 'ssNbaEnsureLedger', 'ssNbaEnsureStandings', 'ssNbaEnsureRows', 'ssNbaEnsureProfiles', 'ssNbaCueHist', 'ssNbaH2H', 'ssNbaPregameState', 'ssNbaCtxState', 'ssNbaToggleLedger', 'closeMatchupSheetNba'].every((f) => CORE.split(`function ${f}(`).length === 2));
T('[0] core is token-free and DOM-render-free', !/var\(--/.test(CORE) && !has(CORE, 'insertAdjacentHTML') && !has(CORE, 'renderCard('));
T('[0] each file supplies ssNbaRerender + ssNbaAutoOpen + SS_NBA_COLORS outside the core', [BDL_SP, V3_SP].every((s) => has(s, 'function ssNbaRerender(') && has(s, 'function ssNbaAutoOpen(') && has(s, 'var SS_NBA_COLORS=')));

// [1] mirrors
for (const f of ['ssLeadClassDisplay', 'americanToImplied', 'ssPriceStale'])
  T(`[1] ${f} body === poll-live-bdl.mjs (core)`, bodyOf(extractFn(CORE, f)) === bodyOf(extractFn(POLL, f)));
T('[1] ssGapFmt body === wnba-bdl.html (core)', bodyOf(extractFn(CORE, 'ssGapFmt')) === bodyOf(extractFn(WHTML, 'ssGapFmt')));
T('[1] computeScoringComp body === poll-live-bdl.mjs (bdl.html only; v3 keeps its own outside the block)', bodyOf(extractFn(BDL_SP, 'computeScoringComp')) === bodyOf(extractFn(POLL, 'computeScoringComp')) && !has(BLOCK3, 'function computeScoringComp('));
T('[1] vShareTier body === wnba-bdl.html (v3.html only)', bodyOf(extractFn(V3_SP, 'vShareTier')) === bodyOf(extractFn(WHTML, 'vShareTier')) && !has(BLOCK, 'function vShareTier('));
const staleLine = POLL.match(/staleGapPp:\s*([0-9.]+)/);
T('[1] SS_NBA_STALE_GAP === SS_CFG.nba.staleGapPp', !!staleLine && Number(staleLine[1]) === SS_NBA_STALE_GAP && SS_NBA_STALE_GAP === 0.25);
const hotLine = POLL.match(/minLeaderEfg:\s*([0-9.]+)/);
T('[1] SS_NBA_HOT_EFG === SS_CFG.nba.cue.minLeaderEfg', !!hotLine && Number(hotLine[1]) === SS_NBA_HOT_EFG && SS_NBA_HOT_EFG === 57);
T('[1] bdl.html defines each mirror exactly once', ['ssLeadClassDisplay', 'americanToImplied', 'computeScoringComp', 'ssPriceStale', 'ssGapFmt'].every((f) => HTML.split(`function ${f}(`).length === 2));
T('[1] v3.html defines each core mirror exactly once (its own computeScoringComp stays single too)', ['ssLeadClassDisplay', 'americanToImplied', 'ssPriceStale', 'ssGapFmt', 'computeScoringComp', 'vShareTier'].every((f) => V3.split(`function ${f}(`).length === 2));

// [2] exploratory constants pinned to the committed doc
T('[2] cue cell 74.4 / 50.1 / n=39 in doc', has(EXPL, '74.4') && has(EXPL, '50.1') && has(EXPL, '39 LOW') && EX.cue.p === 74.4 && EX.cue.espn === 50.1 && EX.cue.n === 39);
T('[2] gap-base +6.0 ±11.8 n=66 in doc', has(EXPL, '+6.0 (±11.8)') && has(EXPL, '66 LOW') && EX.gapBase.edge === 6.0 && EX.gapBase.ci === 11.8 && EX.gapBase.n === 66);
T('[2] source commit + as-of + switch', EX.source === 'aaf0ec8' && EX.asof === '2026-11-19' && SS_NBA_SWITCH_N === 30);

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

// [6] verdict (color KEYS — A2.3)
const KEYS = ['green', 'amber', 'blue', 'coral', 'dim', 'secondary'];
const base = { homeAlias: 'MIN', awayAlias: 'NYK' };
let r = ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.16, leaderEfg: 60, rows: [{ subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }] });
T('[6] V1 WATCHLIST row in band (blue)', r.v === 'V1' && has(r.text, 'REVIEW — MIN is the better team (.16 quality gap) down 5') && has(r.text, 'See the push.') && r.color === 'blue');
r = ssVerdictComposeNba({ ...base, period: 3, homePts: 50, awayPts: 40, leaderAlias: 'MIN', gap: -0.16, rows: [{ subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }] });
T('[6] anchoring: row trailer now LEADS -> current-state read (V4), not V1', r.v === 'V4' && has(r.text, 'quality gap (-0.16)'));
r = ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 50, leaderAlias: 'NYK', gap: 0.16, rows: [{ subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }] });
T('[6] anchoring: row trailer down 10 -> V6 coral', r.v === 'V6' && r.color === 'coral' && has(r.text, 'OUT OF BAND — MIN down 10: outside the 1–9 window. No chasing.'));
r = ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.2, leaderEfg: 50, rows: [{ subtype: 'GAP_BASE', leader: 'NYK', trailer: 'MIN' }], gapBaseN: 9 });
T('[6] V3 GAP_BASE row in band (secondary)', r.v === 'V3' && r.color === 'secondary' && has(r.text, 'GAP SPOT, LOGGING') && has(r.text, '(9/30 resolved)'));
T('[6] WATCHLIST outranks GAP_BASE', ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.2, rows: [{ subtype: 'GAP_BASE', leader: 'NYK', trailer: 'MIN' }, { subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }] }).v === 'V1');
T('[6] V0 pre-Q2 (dim)', (() => { const x = ssVerdictComposeNba({ ...base, period: 1, homePts: 20, awayPts: 25, gap: 0.3 }); return x.v === 'V0' && x.color === 'dim'; })());
T('[6] V0 with no snapshot', ssVerdictComposeNba({ period: 0, homeAlias: 'A', awayAlias: 'B' }).text === 'Gates read from Q2 — no verdict yet.');
r = ssVerdictComposeNba({ ...base, period: 2, homePts: 25, awayPts: 25, leaderAlias: 'MIN', gap: -0.162 });
T('[6] VT tied, qualified: |gap| + better team (gap<0 -> home better)', r.v === 'VT' && r.text === 'TIED — no trailer to read. The .16 gap resolves on the next lead; MIN would be the watch trailer.');
T('[6] VT tied, gap>0 -> away better', has(ssVerdictComposeNba({ ...base, period: 2, homePts: 25, awayPts: 25, leaderAlias: 'MIN', gap: 0.2 }).text, 'NYK would be the watch trailer'));
T('[6] VT tied, below bar', ssVerdictComposeNba({ ...base, period: 3, homePts: 60, awayPts: 60, leaderAlias: 'MIN', gap: 0.08 }).text === 'TIED — gap (.08) is below the review line either way.');
T('[6] VT tied, null gap', has(ssVerdictComposeNba({ ...base, period: 3, homePts: 60, awayPts: 60 }).text, 'gap (no standings gap) is below'));
T('[6] tied with a row (rowDef 0) -> VT not V1', ssVerdictComposeNba({ ...base, period: 2, homePts: 25, awayPts: 25, gap: 0.3, rows: [{ subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }] }).v === 'VT');
r = ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.1 });
T('[6] V4 below bar (dim)', r.v === 'V4' && r.color === 'dim' && has(r.text, 'NO SPOT — quality gap (.10) is below the review line (.15).') && has(r.text, 'size like it'));
T('[6] V4 null gap wording', has(ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45 }).text, '(no standings gap)'));
r = ssVerdictComposeNba({ ...base, period: 4, homePts: 80, awayPts: 85, leaderAlias: 'NYK', gap: 0.3 });
T('[6] V7 Q4 window closed (secondary)', r.v === 'V7' && r.color === 'secondary' && has(r.text, 'Q4 — the NBA cue window closed after Q3.'));
T('[6] Q4 down 15 -> V7 (no DEAD / Q4 DEEP)', (() => { const x = ssVerdictComposeNba({ ...base, period: 4, homePts: 70, awayPts: 85, leaderAlias: 'NYK', gap: 0.3 }); return x.v === 'V7' && !has(x.text, 'DEAD') && !has(x.text, 'Q4 DEEP'); })());
T('[6] VX read forming', (() => { const x = ssVerdictComposeNba({ ...base, period: 3, homePts: 60, awayPts: 65, leaderAlias: 'NYK', gap: 0.3 }); return x.v === 'VX' && has(x.text, 'READ FORMING'); })());
T('[6] every emitted color is a key', [
  ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.16, rows: [{ subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }] }),
  ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.2, rows: [{ subtype: 'GAP_BASE', leader: 'NYK', trailer: 'MIN' }] }),
  ssVerdictComposeNba({ ...base, period: 1 }), ssVerdictComposeNba({ ...base, period: 2, homePts: 25, awayPts: 25, gap: 0.3 }),
  ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.1 }), ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 55, leaderAlias: 'NYK', gap: 0.3 }),
  ssVerdictComposeNba({ ...base, period: 4, homePts: 80, awayPts: 85, leaderAlias: 'NYK', gap: 0.3 }), ssVerdictComposeNba({ ...base, period: 3, homePts: 60, awayPts: 65, leaderAlias: 'NYK', gap: 0.3 }),
].every((x) => KEYS.indexOf(x.color) > -1));
T('[6] composer is token-free', !has(extractFn(CORE, 'ssVerdictComposeNba'), 'var(--') && !has(extractFn(CORE, 'ssVerdictComposeNba'), '#4aa3ff'));
T('[6] both SS_NBA_COLORS maps cover every key', [bdlMod.SS_NBA_COLORS, v3Mod.SS_NBA_COLORS].every((m) => KEYS.every((k) => typeof m[k] === 'string' && m[k].length > 0)));
T('[6] v3 colors are the WNBA token family, bdl colors are bdl tokens', v3Mod.SS_NBA_COLORS.dim === 'var(--fg-dim)' && v3Mod.SS_NBA_COLORS.coral === 'var(--coral)' && bdlMod.SS_NBA_COLORS.dim === 'var(--t3)' && bdlMod.SS_NBA_COLORS.coral === 'var(--red)');
// traps
r = ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.1, leaderEfg: 61 });
T('[6] T5 on V4: hot leader without a gap', r.trap != null && has(r.trap, 'Hot leader without a quality gap') && has(r.trap, '1,200 NBA games'));
T('[6] T5 fires on VT below bar too', ssVerdictComposeNba({ ...base, period: 2, homePts: 25, awayPts: 25, gap: 0.05, leaderEfg: 60 }).trap != null);
T('[6] no T5 when gap qualifies', ssVerdictComposeNba({ ...base, period: 3, homePts: 60, awayPts: 65, leaderAlias: 'NYK', gap: 0.3, leaderEfg: 65 }).trap === null);
T('[6] no T5 when leader not hot', ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.1, leaderEfg: 56.9 }).trap === null);
T('[6] no T5 on V3/V6/V7', [
  ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 45, leaderAlias: 'NYK', gap: 0.1, leaderEfg: 70, rows: [{ subtype: 'GAP_BASE', leader: 'NYK', trailer: 'MIN' }] }),
  ssVerdictComposeNba({ ...base, period: 4, homePts: 80, awayPts: 85, leaderAlias: 'NYK', gap: 0.3, leaderEfg: 70 }),
  ssVerdictComposeNba({ ...base, period: 2, homePts: 40, awayPts: 52, leaderAlias: 'NYK', gap: 0.3, leaderEfg: 70 }),
].every((x) => x.trap === null));
T('[6] Q4 with a below-bar gap is V4 (V4 outranks V7) and carries T5 when hot', (() => { const x = ssVerdictComposeNba({ ...base, period: 4, homePts: 80, awayPts: 85, leaderAlias: 'NYK', gap: 0.1, leaderEfg: 70 }); return x.v === 'V4' && x.trap != null; })());
T('[6] T1/T4 WNBA kills never render', !has(extractFn(CORE, 'ssVerdictComposeNba'), 'Jun 21') && !has(extractFn(CORE, 'ssVerdictComposeNba'), 'POR@CHI') && !has(extractFn(CORE, 'ssVerdictComposeNba'), '.20 bar'));
// V8 freeze
r = ssVerdictComposeNba({ ...base, period: 4, homePts: 100, awayPts: 98, leaderAlias: 'MIN', gap: -0.16, rows: [{ subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }], gameStatus: 'closed', finalHome: 104, finalAway: 101, winner: 'MIN' });
T('[6] V8 freeze: row trailer won by games.winner (won=true)', r.v === 'V8' && r.won === true && has(r.text, 'Final 104-101 — MIN completed the comeback.'));
r = ssVerdictComposeNba({ ...base, period: 4, homePts: 95, awayPts: 98, leaderAlias: 'NYK', gap: 0.16, rows: [{ subtype: 'WATCHLIST', leader: 'NYK', trailer: 'MIN' }], gameStatus: 'closed', finalHome: 99, finalAway: 105, winner: 'NYK' });
T('[6] V8 freeze: did not come back (won=false)', r.v === 'V8' && r.won === false && has(r.text, 'MIN did not come back.'));
T('[6] closed on a tied last snapshot with no row -> no V8 subject invented', ssVerdictComposeNba({ ...base, period: 4, homePts: 100, awayPts: 100, gap: 0.2, gameStatus: 'closed', finalHome: 108, finalAway: 100, winner: 'MIN' }).v === 'VT');
T('[6] line dead suffix', has(ssVerdictComposeNba({ ...base, period: 3, homePts: 60, awayPts: 65, leaderAlias: 'NYK', gap: 0.3, lineUsed: 50000 }).text, 'Line dead.'));
T('[6] WNBA subtypes never match (EFG_FADE rows ignored)', ssVerdictComposeNba({ ...base, period: 3, homePts: 60, awayPts: 65, leaderAlias: 'NYK', gap: 0.3, subtypes: ['EFG_FADE'] }).v === 'VX');

// [7] forward-ledger panel
let P = ssForwardLedgerPanelNba({});
T('[7] A1.4 empty copy, four lines verbatim', P.length === 4 && P[0] === 'WATCHLIST  0 rows · 0 resolved · —' && P[1] === 'GAP_BASE   0 rows · 0 resolved · —'
  && P[2] === 'origin: exploratory cell +24pp vs ESPN, n=39 LOW, as of 2026-11-19 (aaf0ec8)' && P[3] === 'switch to forward numbers at 30 resolved WATCHLIST rows');
T('[7] rows but none resolved -> dash rate', ssForwardLedgerPanelNba({ WATCHLIST: { n_total: 3, n_resolved: 0, realized_pct: null } })[0] === 'WATCHLIST  3 rows · 0 resolved · —');
P = ssForwardLedgerPanelNba(L5);
T('[7] resolved -> trailer-WINS + power tag', P[0] === 'WATCHLIST  7 rows · 5 resolved · trailer-WINS 60% [LOW]' && P[1] === 'GAP_BASE   12 rows · 9 resolved · trailer-WINS 56% [LOW]');
P = ssForwardLedgerPanelNba(L30);
T('[7] at 31 resolved the switch line disappears', P.length === 3 && !P.some((l) => has(l, 'switch to forward')));
T('[7] power tags', ssPowerTag(79) === 'LOW' && ssPowerTag(80) === 'MED' && ssPowerTag(199) === 'MED' && ssPowerTag(200) === 'HIGH');

// [8] pregame read
const pg = (o) => ssPregameReadNba({ homeAlias: 'DEN', awayAlias: 'POR', home: { w: 9, l: 4 }, away: { w: 4, l: 9 }, cueHist: {}, ledger: {}, standingsAsOf: 'Nov 19 03:10', ...o });
let G = pg({});
T('[8] head: records, win%s, gap tier', G[0] === 'PREGAME READ — as-of records POR 4-9 (.308) · DEN 9-4 (.692) · gap .38 STRONG');
T('[8] both directions stated', G[1] === 'If POR leads in Q2–Q3 by 1–9 → DEN is the watch trailer (hot-leader cue needs POR eFG ≥ 57).' && G[2] === 'If DEN leads → no spot (gap runs the wrong way).');
T('[8] season line with empty history + empty ledger', G[3] === 'This season: POR 0 · DEN 0. Forward ledger: WATCH 0 resolved.');
T('[8] footer standings only when no line', G[4] === 'Standings as of Nov 19 03:10');
G = pg({ homeML: -400, awayML: 310, linePregame: true });
T('[8] footer line + pregame tag', G[4] === 'Standings as of Nov 19 03:10 · line: POR +310 / DEN -400 (pregame)');
G = pg({ cueHist: { DEN: { n: 2, won: 2, open: 0 }, POR: { n: 1, won: 0, open: 1 } }, ledger: L5 });
T('[8] cue history + ledger line', G[3] === 'This season: POR 1 watchlist cue as trailer (0 WON, 1 open) · DEN 2 watchlist cues as trailer (2 WON). Forward ledger: WATCH 5 resolved · 60% [LOW].');
G = pg({ away: { w: 3, l: 1 } });
T('[8] GP guard: <5 GP team -> no gap, guard line', has(G[0], 'POR 3-1 (<5 GP — no gap yet)') && G[1] === 'No gap read until both teams reach 5 games.' && G.length === 4);
G = pg({ away: { w: 8, l: 5 } });
T('[8] below bar -> no spot either direction', has(G[0], 'gap .08 below bar') && G[1] === 'Gap .08 is below the review line (.15) — no spot in either direction.' && G.length === 4);
G = pg({ away: { w: 7, l: 6 } });
T('[8] gap .1538 renders qualified (not the .15 rounding trap)', has(G[0], 'gap .15 qualified') && has(G[1], 'DEN is the watch trailer'));
G = pg({ home: null, away: null });
T('[8] no standings at all -> dashes + guard line', G[0] === 'PREGAME READ — as-of records POR — · DEN —' && G[1] === 'No gap read until both teams reach 5 games.');
T('[8] ssRecWp guard at exactly 5 GP', ssRecWp({ w: 3, l: 2 }) === 0.6 && ssRecWp({ w: 3, l: 1 }) === null);
T('[8] ssSigned', ssSigned(9) === '+9' && ssSigned(-4) === '-4' && ssSigned(0) === '0' && ssSigned(1.2, 'pp') === '+1.2pp' && ssSigned(null) === '—');

// [8b] ctx strip text (A2.8b)
const cx = (o) => ssCtxStripTextNba({ homeAlias: 'MIN', awayAlias: 'NYK', home: { w: 11, l: 4 }, away: { w: 8, l: 6 }, h2h: null, cueN: {}, ...o });
T('[8b] no standings -> tap prompt', ssCtxStripTextNba({ homeAlias: 'A', awayAlias: 'B' }) === 'season records — tap for matchup sheet');
T('[8b] qualified gap -> watch trailer named', cx({}) === 'NYK 8-6 · MIN 11-4 · gap .16 → MIN watch');
T('[8b] <5 GP -> gap after 5 GP', cx({ away: { w: 3, l: 1 } }) === 'NYK 3-1 · MIN 11-4 · gap after 5 GP');
T('[8b] below bar', cx({ away: { w: 10, l: 5 } }) === 'NYK 10-5 · MIN 11-4 · gap .07 below bar');
T('[8b] H2H + cue count', cx({ h2h: { alias: 'NYK', w: 1, l: 0 }, cueN: { NYK: 1, MIN: 2 } }) === 'NYK 8-6 · MIN 11-4 · gap .16 → MIN watch · H2H 1-0 NYK · 3 cues');
T('[8b] one cue singular', has(cx({ cueN: { MIN: 1 } }), '1 cue') && !has(cx({ cueN: { MIN: 1 } }), '1 cues'));
T('[8b] one record missing -> dash for that side', cx({ away: null }) === 'NYK — · MIN 11-4 · gap after 5 GP');

// [8c] fire-time line (A2.8d)
T('[8c] WATCHLIST fire line', ssNbaFireLine({ alert_subtype: 'WATCHLIST', period: 2, clock: '4:23', deficit: 7, quality_gap: 0.5761905, leader_efg: 59.45946 }) === 'cue fired Q2 4:23 · down 7 · gap .58 · leader eFG 59%');
T('[8c] GAP_BASE wording', has(ssNbaFireLine({ alert_subtype: 'GAP_BASE', period: 2, clock: '6:36', deficit: 5, quality_gap: 0.2 }), 'gap spot logged Q2 6:36 · down 5 · gap .20'));
T('[8c] null / empty -> null', ssNbaFireLine(null) === null && ssNbaFireLine({}) === null && ssNbaFireLine({ alert_subtype: 'WATCHLIST' }) === null);
T('[8c] partial fields degrade', ssNbaFireLine({ alert_subtype: 'WATCHLIST', period: 3, deficit: 4 }) === 'cue fired Q3 · down 4');

// [8d] header chip (A2.4 #4)
T('[8d] chip labels per state', ssNbaChipFor({ v: 'V1', color: 'blue' }).label === 'REVIEW' && ssNbaChipFor({ v: 'V3', color: 'secondary' }).label === 'GAP SPOT' && ssNbaChipFor({ v: 'V0', color: 'dim' }).label === 'PRE-GATE' && ssNbaChipFor({ v: 'VT', color: 'dim' }).label === 'TIED' && ssNbaChipFor({ v: 'V4', color: 'dim' }).label === 'NO SPOT' && ssNbaChipFor({ v: 'V6', color: 'coral' }).label === 'OUT OF BAND' && ssNbaChipFor({ v: 'V7', color: 'secondary' }).label === 'Q4' && ssNbaChipFor({ v: 'VX', color: 'dim' }).label === 'FORMING');
T('[8d] chip carries the verdict color key', ssNbaChipFor({ v: 'V1', color: 'blue' }).color === 'blue' && ssNbaChipFor({ v: 'V6', color: 'coral' }).color === 'coral');
T('[8d] V8 chip by outcome', ssNbaChipFor({ v: 'V8', won: true }).label === 'FINAL ✓' && ssNbaChipFor({ v: 'V8', won: true }).color === 'green' && ssNbaChipFor({ v: 'V8', won: false }).label === 'FINAL ✗' && ssNbaChipFor({ v: 'V8', won: false }).color === 'coral' && ssNbaChipFor({ v: 'V8', won: null }).label === 'FINAL');
T('[8d] null verdict -> null chip', ssNbaChipFor(null) === null && ssNbaChipFor({ v: 'ZZ' }) === null);
T('[8d] v3 eFG color at the cue constant (57 hot, 56.9 not)', v3Mod.ssNbaEfgColor(57) === 'var(--amber)' && v3Mod.ssNbaEfgColor(56.9) === 'var(--fg-tertiary)' && v3Mod.ssNbaEfgColor(null) === 'var(--fg-tertiary)');
T('[8d] v3 box eFG from player lines', (() => { const b = v3Mod.ssNbaBoxEfg({ _lastBoxScore: { home_team: { players: [{ fgm: 10, fga: 20, fg3m: 4 }, { fgm: 5, fga: 10, fg3m: 0 }] }, visitor_team: { players: [] } } }); return b.home === 56.7 && b.away === null && v3Mod.ssNbaBoxEfg({}).home === null; })());
T('[8d] v3 vShareTier mirror values', v3Mod.vShareTier(45).tier === 'struct' && v3Mod.vShareTier(55).tier === 'mixed' && v3Mod.vShareTier(56).tier === 'var' && v3Mod.vShareTier(null).tier === 'na');

// [9] grep gates
for (const sym of ['SS_STRUCT', 'SS_SEASON26', 'computeFuelTemp', 'ssCautionLines', 'comebackProb', 'EFG_BANDS', 'ekBadge', 'STICKY', 'efgTier', 'ssClassifyTier', 'HOLDER READ', 'FADE COUNTRY', 'WATCH-ONLY'])
  T(`[9] N1: no "${sym}" inside either SS_NBA block`, !has(BLOCK, sym) && !has(BLOCK3, sym));
T('[9] no WNBA tokens inside the bdl block; no bdl tokens inside the v3 block', !has(BLOCK, 'var(--hairline') && !has(BLOCK, 'var(--fg-') && !has(BLOCK, 'var(--coral') && !has(BLOCK3, 'var(--t3)') && !has(BLOCK3, 'var(--b1)') && !has(BLOCK3, 'var(--red)'));
T('[9] no WNBA rate numbers inside either block', ![BLOCK, BLOCK3].some((b) => /\b(54\.9|52\.2|35\.8|75\.1|72\.0)\b/.test(b) || has(b, 'killer')));
T('[9] bdl fetchStandings: no season literal, derived season, get_standings', !has(extractFn(HTML, 'fetchStandings'), "season:'2025'") && has(extractFn(HTML, 'fetchStandings'), 'nbaSeasonYear(') && has(extractFn(HTML, 'fetchStandings'), 'get_standings'));
T('[9] v3 fetchStandings: no season literal, derived season, get_standings', !has(extractFn(V3, 'fetchStandings'), "season:'2025'") && has(extractFn(V3, 'fetchStandings'), 'nbaSeasonYear(') && has(extractFn(V3, 'fetchStandings'), 'get_standings') && !has(V3, "bdl('standings',{season:'2025'})"));
T('[9] A1.1: the three server-coupled season literals are untouched in bdl.html (branch-owned)', HTML.split('get_season_cache&league=nba&season=2025').length === 2 && HTML.split('get_wp_profiles&league=nba&season=2025-26').length === 3);
T('[9] nbaSeasonYear Oct-start', nbaSeasonYear(new Date(2026, 10, 19)) === 2026 && nbaSeasonYear(new Date(2026, 8, 30)) === 2025 && nbaSeasonYear(new Date(2027, 2, 1)) === 2026 && nbaSeasonYear(new Date(2026, 9, 1)) === 2026);
T('[9] db-api exposes get_standings reading standings_cache', has(DBAPI, "action === 'get_standings'") && has(extractFnLoose(DBAPI, "action === 'get_standings'"), 'FROM standings_cache'));
T('[9] bdl mount: SC container renders on _ssBox too; box first; bars guarded by lc; strip under hero', has(HTML, 'if(lc || _ssBox){') && has(HTML, "html+=_ssBox;\n      if(lc){") && has(HTML, '} // end if(lc) bars') && has(HTML, 'html+=ctxStripNba(id,hA,aA);'));
T('[9] bdl hero rank badge guarded (no empty "()")', HTML.split('standingsCache[aA]&&standingsCache[aA].confRank?').length === 2 && HTML.split('standingsCache[hA]&&standingsCache[hA].confRank?').length === 2);
T('[9] auto-open once guard in the core', has(CORE, '_ssAutoOpened'));
T('[9] bdl pregame block on PRE cards; grid timer + prefetch', has(HTML, 'renderSSPregameNba(id,cs,game,hA,aA)') && has(HTML, 'startSSNbaTimer(); ssNbaPrefetch();'));
// v3 specifics (A2.4)
T('[9] v3 hero: W-L + rank badge via ssNbaRecBadge in all four slots, no raw ordinal(...confRank) left', V3.split('ssNbaRecBadge(aRank)').length === 3 && V3.split('ssNbaRecBadge(hRank)').length === 3 && !has(V3, "ordinal(aRank.confRank)") && has(extractFn(V3, 'ssNbaRecBadge'), 'if(r.confRank)'));
T('[9] v3 strip under hero + pregame block on PRE', has(V3, "html+=ctxStripNba(id,hA,aA); if(state==='PRE')html+=renderSSPregameNba(id,cs,g,hA,aA);"));
T('[9] v3 renderScoringCompSection renders on SS state; box first; chip in header; bars only with comp', (() => { const f = extractFn(V3, 'renderScoringCompSection'); return has(f, 'if(!sc&&!_ssEntry)return') && has(f, 'renderSSVerdictBoxNba(id,cs,_g,hA,aA)') && has(f, "'<span class=\"coll-summary\">'+_chip+summary") && has(f, "if(!sc){ html+='</div></div></div>'; return html; }") && f.indexOf('renderSSVerdictBoxNba(') < f.indexOf('scoringBar(h,'); })());
T('[9] v3 scoringBar takes eFG, colors by the cue constant, V by vShareTier', (() => { const f = extractFn(V3, 'scoringBar'); return has(f, 'function scoringBar(tm,efg)') && has(f, 'ssNbaEfgColor(efg)') && has(f, 'vShareTier(tm.vPct)') && has(f, 'hot (cue'); })());
T('[9] v3 hooks: 60s active-card timer at poll start, kick, select + swipe refresh', has(V3, 'startSSNbaTimer(); // SS verdict') && has(V3, 'ssNbaKick();') && has(V3, 'fetchSSStateNba(id); // SS verdict — refresh on card select') && has(V3, 'fetchSSStateNba(newActive); // SS verdict — refresh on swipe select') && has(extractFn(V3_SP, 'startSSNbaTimer'), 'activeGameId'));
T('[9] v3 block never touches the Sonnet-signal expander or its own computeScoringComp', !has(BLOCK3, '_ssExpanded') && !has(BLOCK3, 'computeScoringComp('));
T('[9] v3 CSS present (strip, chip, sheet) and bdl CSS present (sheet)', has(V3, '.ssn-strip{') && has(V3, '.ssn-chip{') && has(V3, '.msn-overlay{') && has(HTML, '.msn-overlay{'));
T('[9] every fetch in both blocks passes league=nba', ![BLOCK, BLOCK3].some((b) => /db-api\?action=(get_ss_state|ss_ledger_summary|get_sweetspot_alerts|get_team_profiles|get_standings)[^'"]*league=wnba/.test(b)));

// [10] D3 — NBA lite profiles (pure compute over the three committed finals)
const LP = computeNbaLiteProfiles(LITE_IN, '2026-11-19');
T('[10] six teams from three finals', Object.keys(LP).length === 6);
T('[10] W/L from games.winner', LP.ATL.w === 1 && LP.ATL.l === 0 && LP.OKC.w === 0 && LP.OKC.l === 1 && LP.DEN.w === 1 && LP.BOS.l === 1 && LP.CHI.w === 1 && LP.BKN.l === 1);
T('[10] hand-computed eFG (OKC 46+4.5 / 91 = 55.5; opp ATL 44+10 / 99 = 54.5)', LP.OKC.profile.efg === 55.5 && LP.OKC.profile.opp_efg === 54.5 && LP.ATL.profile.efg === 54.5 && LP.ATL.profile.opp_efg === 55.5);
T('[10] hand-computed eFG (DEN 47.6; BKN 57.4; CHI 64.1)', LP.DEN.profile.efg === 47.6 && LP.DEN.profile.opp_efg === 46.4 && LP.BKN.profile.efg === 57.4 && LP.BKN.profile.opp_efg === 64.1 && LP.CHI.profile.efg === 64.1);
T('[10] pace = mean of both poss (OKC 105.1; DEN 99.7)', LP.OKC.profile.pace === 105.1 && LP.ATL.profile.pace === 105.1 && LP.DEN.profile.pace === 99.7);
T('[10] A2.8 diffs hand-computed: OKC efg_diff +0.9 (55.49-54.55), TO 13-13=0, FTA 21-12=+9, OREB 5-14=-9', LP.OKC.profile.efg_diff === 0.9 && LP.OKC.profile.to_margin === 0 && LP.OKC.profile.fta_diff === 9 && LP.OKC.profile.oreb_diff === -9);
T('[10] A2.8 diffs mirror for the opponent (ATL -0.9 / 0 / -9 / +9)', LP.ATL.profile.efg_diff === -0.9 && LP.ATL.profile.to_margin === 0 && LP.ATL.profile.fta_diff === -9 && LP.ATL.profile.oreb_diff === 9);
T('[10] A2.8 diffs DEN (opp TO 15 - own 17 = -2; FTA 29-12=+17; OREB 14-18=-4; eFG +1.2) and BKN (-6 / +7 / -9 / -6.7)', LP.DEN.profile.to_margin === -2 && LP.DEN.profile.fta_diff === 17 && LP.DEN.profile.oreb_diff === -4 && LP.DEN.profile.efg_diff === 1.2 && LP.BKN.profile.to_margin === -6 && LP.BKN.profile.fta_diff === 7 && LP.BKN.profile.oreb_diff === -9 && LP.BKN.profile.efg_diff === -6.7);
T('[10] l10 + gp + h2h + box_gp', LP.ATL.profile.l10.w === 1 && LP.ATL.profile.l10.l === 0 && LP.ATL.profile.gp === 1 && LP.ATL.profile.h2h.OKC.w === 1 && LP.OKC.profile.h2h.ATL.l === 1 && LP.ATL.profile.box_gp === 1);
T('[10] key contract: lite:true, asof, and NONE of the WNBA profile keys', Object.values(LP).every((p) => p.profile.lite === true && p.profile.asof === '2026-11-19' && ['killer', 'tiers', 'tiers_elite', 'elite', 'identity', 'rotation', 'archetype', 'infl', 'late_exec'].every((k) => !(k in p.profile))));
const LP2 = computeNbaLiteProfiles([{ ...LITE_IN[0], raw_stats_json: { home: { fgm: 0, fga: 0 }, away: { fgm: 1, fga: 2 } } }], null);
T('[10] half-empty box: W/L counted, eFG/pace/diffs null, box_gp 0', LP2.OKC.l === 1 && LP2.OKC.profile.efg === null && LP2.OKC.profile.pace === null && LP2.OKC.profile.efg_diff === null && LP2.OKC.profile.to_margin === null && LP2.OKC.profile.box_gp === 0 && LP2.OKC.profile.asof === null);
T('[10] string raw_stats_json parsed', computeNbaLiteProfiles([{ ...LITE_IN[1], raw_stats_json: JSON.stringify(LITE_IN[1].raw_stats_json) }]).DEN.profile.efg === 47.6);
T('[10] no winner -> game skipped entirely', Object.keys(computeNbaLiteProfiles([{ ...LITE_IN[1], winner: null }])).length === 0);
const L12 = []; for (let i = 0; i < 12; i++) L12.push({ game_id: 'g' + i, date: '2026-11-' + String(1 + i).padStart(2, '0'), home_alias: 'AAA', away_alias: 'B' + i, home_pts: 100, away_pts: 90, winner: i < 2 ? 'B' + i : 'AAA', raw_stats_json: { home: { fgm: 40, fga: 80, fg3m: 10, poss: 100, to: 12, fta: 20, oreb: 10 }, away: { fgm: 40, fga: 80, fg3m: 10, poss: 100, to: 15, fta: 18, oreb: 8 } } });
T('[10] l10 is the LAST ten by date; per-game diffs average over box games', computeNbaLiteProfiles(L12).AAA.profile.l10.w === 10 && computeNbaLiteProfiles(L12).AAA.l === 2 && computeNbaLiteProfiles(L12).AAA.profile.to_margin === 3 && computeNbaLiteProfiles(L12).AAA.profile.fta_diff === 2 && computeNbaLiteProfiles(L12).AAA.profile.oreb_diff === 2 && computeNbaLiteProfiles(L12).AAA.profile.box_gp === 12);
T('[10] server nbaSeasonYear Oct-start, Arizona day', nbaSeasonYearServer('2026-11-20T02:00:00Z') === 2026 && nbaSeasonYearServer('2026-09-30T12:00:00Z') === 2025 && nbaSeasonYearServer('2026-10-01T12:00:00Z') === 2026 && nbaSeasonYearServer('2027-03-01T12:00:00Z') === 2026);
T('[10] stage isolated in try/catch after the WNBA summary, skipped on backfill, no push', has(TPN, "try { nbaLite = await runNbaLiteStage(sql, url, isDry, todayAz); }") && has(TPN, 'if (!isBackfill) {') && TPN.lastIndexOf('runNbaLiteStage(sql, url') > TPN.indexOf("await notify('team-profiles', summary)") && !has(extractFn(TPN, 'runNbaLiteStage'), 'notify('));
T('[10] stage writes league nba / archetype LITE, finals query = winner not null + raw present + date::text', (() => { const f = extractFn(TPN, 'runNbaLiteStage'); return has(f, "${'nba'}") && has(f, "${'LITE'}") && has(f, 'g.winner IS NOT NULL') && has(f, 's.raw_stats_json IS NOT NULL') && has(f, 'g.date::text AS date') && has(f, 'DISTINCT ON (s.game_id)'); })());
T('[10] WNBA stage untouched: league const still wnba, ensureTeamCtx still wnba-gated', has(TPN, "const league = 'wnba'; // v1 WNBA-only (spec §4)") && has(POLL, "if (!TEAM_CTX_ON || league !== 'wnba') return;"));
T('[10] dashboards read lite profiles by derived season and require profile.lite', has(CORE, "get_team_profiles&league=nba&season='+nbaSeasonYear(new Date())") && has(CORE, 'if(p&&p.lite)'));
T('[10] sheets render the four diff rows in both files', [BDL_SP, V3_SP].every((s) => ['eFG diff', 'TO margin', '<span>FTA</span>', '<span>OREB</span>'].every((k) => has(s, k))));

function extractFnLoose(src, marker) { const i = src.indexOf(marker); const j = src.indexOf('\n    }\n', i); return src.slice(i, j); }

console.log(`ss_nba_dashboard fixtures: ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);

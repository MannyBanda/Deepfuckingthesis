// ════════════════════════════════════════════════════════════════════════════
// DECISION SUPPORT v1 FIXTURES (DECISION_SUPPORT_V1_SPEC.md test plan)
// C1: computeFuelTemp goldens ×2 sides (server poll-live-bdl.mjs + client
// wnba-bdl.html VERBATIM mirror — drift between copies = test failure), incl.
// the row-23 REAL replay (WSH@GS Jul 20, P2 9:42 snapshot raw stats — the
// earned+clean-cold STICKY archetype and the season's one real-money loss).
// ssFuelTempLines copy pins. C2/C3 pins appended by their components.
// Run: node research/2026-08-05_decision_support_fixtures.mjs
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs';
const POLL = readFileSync('netlify/functions/poll-live-bdl.mjs', 'utf8');
const CLIENT = readFileSync('wnba-bdl.html', 'utf8');

function extractFn(src, name) {
  const sig = `function ${name}(`;
  const i = src.indexOf(sig); if (i < 0) throw new Error(`not found: ${name}`);
  const open = src.indexOf('{', src.indexOf(')', i));
  let d = 0, j = open;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}
function extractVar(src, name) {
  const sig = `var ${name}`;
  const i = src.indexOf(sig); if (i < 0) throw new Error(`not found: ${name}`);
  const j = src.indexOf(';', i);
  return src.slice(i, j + 1);
}
function buildSide(src, extra) {
  const parts = [extractVar(src, 'EFG_BANDS'), extractFn(src, 'efgTier'),
    extractVar(src, 'FUELTEMP_TH'), extractFn(src, 'computeFuelTemp')].concat(extra || []);
  return new Function(`${parts.join(';\n')}; return { computeFuelTemp: computeFuelTemp${extra ? ', ssFuelTempLines: ssFuelTempLines' : ''} };`)();
}
const S = buildSide(POLL, [extractFn(POLL, 'ssFuelTempLines')]);
const C = buildSide(CLIENT);

let pass = 0, fail = 0;
const T = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? '\u2713' : '\u2717'} ${n}`); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── verbatim-mirror contract: normalized source text must be identical ──
console.log('MIRROR CONTRACT');
const norm = (s) => s.replace(/\s+/g, ' ').trim();
T('computeFuelTemp source identical both sides', norm(extractFn(POLL, 'computeFuelTemp')) === norm(extractFn(CLIENT, 'computeFuelTemp')));
T('FUELTEMP_TH identical both sides', norm(extractVar(POLL, 'FUELTEMP_TH')) === norm(extractVar(CLIENT, 'FUELTEMP_TH')));

// ── goldens (run through BOTH copies; outputs must match each other + pins) ──
console.log('FUEL/TEMP GOLDENS');
const G = [];
// G1 — row-23 REAL replay: WSH@GS P2 9:42 (snapshot pull Aug 5). Leader WSH (away):
// fgm 9 fga 16 fg3m 2 ftm 1 pot 2(v2) to 3, var 38 (system_state). Trailer GS (home):
// fgm 8 fga 19 fg3m 4 to 2. Expected: EARNED + cold + clean → STICKY.
G.push({ name: 'G1 row-23 real (earned+clean-cold STICKY)',
  L: { fgm: 9, fga: 16, fg3m: 2, ftm: 1, pot: 2, to: 3, vShare: 38 },
  Tr: { fgm: 8, fga: 19, fg3m: 4, ftm: 0, pot: 3, to: 2 }, p: 2,
  exp: { fuel: 'EARNED', temp: 'cold', sticky: true, leaderBand: 'orange', leaderEfg: 62.5, trailerEfg: 52.6 } });
// G2 — transient-heat (PHX@MIN archetype): red-band leader, low pot
G.push({ name: 'G2 transient-heat (red band)',
  L: { fgm: 14, fga: 24, fg3m: 8, ftm: 2, pot: 2, to: 4, vShare: 60 },
  Tr: { fgm: 9, fga: 20, fg3m: 2, ftm: 3, pot: 4, to: 6 }, p: 2,
  exp: { fuel: 'TRANSIENT (heat)', temp: 'cold', sticky: false, leaderBand: 'red', leaderEfg: 75 } });
// G3 — transient-takeaway at var 20 (LA@DAL archetype): normal temp, pot 8
G.push({ name: 'G3 transient-takeaway (var 20)',
  L: { fgm: 11, fga: 20, fg3m: 2, ftm: 4, pot: 8, to: 3, vShare: 20 },
  Tr: { fgm: 8, fga: 18, fg3m: 3, ftm: 2, pot: 2, to: 4 }, p: 2,
  exp: { fuel: 'TRANSIENT (takeaway)', temp: 'cold', sticky: false, leaderBand: 'orange', pot: 8 } });
// G4 — both engines transient
G.push({ name: 'G4 heat + takeaway',
  L: { fgm: 13, fga: 22, fg3m: 9, ftm: 1, pot: 7, to: 2, vShare: 62 },
  Tr: { fgm: 10, fga: 20, fg3m: 2, ftm: 4, pot: 3, to: 5 }, p: 3,
  exp: { fuel: 'TRANSIENT (heat + takeaway)', temp: 'cold', sticky: false, leaderBand: 'red' } });
// G5 — insufficient data → no render anywhere
G.push({ name: 'G5 insufficient (fga < 12)',
  L: { fgm: 4, fga: 8, fg3m: 1, ftm: 0, pot: 0, to: 1 },
  Tr: { fgm: 5, fga: 13, fg3m: 1, ftm: 2, pot: 2, to: 2 }, p: 1,
  exp: { insufficient: true } });
// G6 — clean-cold blocked by turnovers (TO ≥ 4 → not sticky)
G.push({ name: 'G6 earned+cold but TO 5 (no sticky)',
  L: { fgm: 9, fga: 16, fg3m: 2, ftm: 1, pot: 2, to: 3, vShare: 38 },
  Tr: { fgm: 8, fga: 19, fg3m: 4, ftm: 0, pot: 3, to: 5 }, p: 2,
  exp: { fuel: 'EARNED', temp: 'cold', sticky: false } });
// G7 — 3PT-heavy heat without red band (orange + 64% pts from threes)
G.push({ name: 'G7 3PT-heavy heat (orange band)',
  L: { fgm: 10, fga: 20, fg3m: 6, ftm: 2, pot: 3, to: 3, vShare: 44 },
  Tr: { fgm: 12, fga: 20, fg3m: 1, ftm: 2, pot: 4, to: 3 }, p: 3,
  exp: { fuel: 'TRANSIENT (heat)', temp: 'warm', sticky: false, leaderBand: 'orange', threeShare: 64 } });
// G8 — hot trailer (red band) on an earned lead
G.push({ name: 'G8 earned + hot trailer',
  L: { fgm: 11, fga: 20, fg3m: 2, ftm: 3, pot: 2, to: 3, vShare: 30 },
  Tr: { fgm: 13, fga: 20, fg3m: 3, ftm: 1, pot: 3, to: 2 }, p: 2,
  exp: { fuel: 'EARNED', temp: 'hot', sticky: false, trailerBand: 'red' } });
// G9 — vShare-only heat (orange, threes < 40, var 50 > 45)
G.push({ name: 'G9 vShare-only heat',
  L: { fgm: 11, fga: 20, fg3m: 2, ftm: 3, pot: 2, to: 3, vShare: 50 },
  Tr: { fgm: 8, fga: 18, fg3m: 2, ftm: 2, pot: 2, to: 3 }, p: 2,
  exp: { fuel: 'TRANSIENT (heat)', temp: 'cold', sticky: false } });

for (const g of G) {
  const s = S.computeFuelTemp(g.L, g.Tr, g.p);
  const c = C.computeFuelTemp(g.L, g.Tr, g.p);
  T(`${g.name} — server matches client`, eq(s, c));
  let ok = true;
  for (const [k, v] of Object.entries(g.exp)) if (!eq(s[k], v)) { ok = false; console.log(`      pin miss ${k}: got ${JSON.stringify(s[k])} want ${JSON.stringify(v)}`); }
  T(`${g.name} — pins`, ok);
}

// ── ssFuelTempLines copy pins (narration context; plain English, metric named) ──
console.log('FUEL/TEMP NARRATION COPY');
const L1 = S.ssFuelTempLines(S.computeFuelTemp(G[0].L, G[0].Tr, 2), 'WSH', 'GS');
T('G1 fuel line', L1.includes("LEAD FUEL: EARNED \u2014 WSH's lead is built on normal shooting temperature and a low takeaway feed."));
T('G1 temp line', L1.includes('TRAILER TEMP: cold \u2014 GS shooting 53% effective field goal (green band).'));
T('G1 sticky chip', L1.includes('STICKY LEAD SHAPE (2026): earned lead against a cold, clean trailer (2 turnovers)'));
T('G1 never-a-gate wording', L1.includes('Context only, never a gate.'));
const L2 = S.ssFuelTempLines(S.computeFuelTemp(G[1].L, G[1].Tr, 2), 'PHX', 'MIN');
T('G2 heat wording', L2.includes("TRANSIENT (heat) \u2014 PHX's lead is built on hot shooting (75% effective field goal, red band)."));
T('G2 no sticky on transient', !L2.includes('STICKY'));
const L3 = S.ssFuelTempLines(S.computeFuelTemp(G[2].L, G[2].Tr, 2), 'LA', 'DAL');
T('G3 takeaway wording', L3.includes("TRANSIENT (takeaway) \u2014 LA's lead is built on 8 points off turnovers."));
const L4 = S.ssFuelTempLines(S.computeFuelTemp(G[3].L, G[3].Tr, 3), 'NY', 'CHI');
T('G4 both wording', L4.includes('plus 7 points off turnovers.'));
T('G5 insufficient renders nothing', S.ssFuelTempLines(S.computeFuelTemp(G[4].L, G[4].Tr, 1), 'X', 'Y') === '');
const L9 = S.ssFuelTempLines(S.computeFuelTemp(G[8].L, G[8].Tr, 2), 'SEA', 'IND');
T('G9 vShare wording', L9.includes('50% of the lead from three-pointers and midrange'));

// ════════════════════════════════════════════════════════════════════════════
// C2 — REGIME PULSE + REGIME STATE (post-game-agent.mjs digest copy pins)
// ════════════════════════════════════════════════════════════════════════════
const AGENT = readFileSync('netlify/functions/post-game-agent.mjs', 'utf8');
const afns = ['ssRegimeState', 'ssFuelPulseLine', 'ssSystemPulseLine', 'ssCashShadowLine', 'ssComposeDigest'];
const A = new Function(`${afns.map((f) => extractFn(AGENT, f)).join(';\n')}; return { ${afns.join(', ')} };`)();

console.log('REGIME STATE (pre-registered thresholds — spec amendment required to change)');
T('ACTIVE at 60% n=10', A.ssRegimeState(10, 0.60) === 'TRANSIENT_COLLAPSE: ACTIVE');
T('INVERTED at 45% n=8', A.ssRegimeState(8, 0.45) === 'INVERTED');
T('NEUTRAL between thresholds', A.ssRegimeState(12, 0.52) === 'NEUTRAL');
T('NEUTRAL on thin window (n=7 at 100%)', A.ssRegimeState(7, 1.0) === 'NEUTRAL');
T('NEUTRAL on null inputs', A.ssRegimeState(null, null) === 'NEUTRAL');

console.log('PULSE COPY PINS');
const f30 = { transient: { n: 9, w: 6 }, earned: { n: 5, w: 2 } };
const fSe = { transient: { n: 21, w: 13 }, earned: { n: 12, w: 5 } };
const FP = A.ssFuelPulseLine(f30, fSe, 'TRANSIENT_COLLAPSE: ACTIVE');
T('fuel pulse 30d vs season', FP.includes('transient-fed leads fell in 6 of 9 this month (season 13 of 21)') && FP.includes('earned leads fell in 2 of 5 this month (season 5 of 12)'));
T('fuel pulse ACTIVE named', FP.includes('Regime: TRANSIENT COLLAPSE ACTIVE'));
const FPn = A.ssFuelPulseLine(f30, fSe, 'NEUTRAL');
T('fuel pulse NEUTRAL silent (no state claims)', !FPn.includes('Regime:'));
const FPi = A.ssFuelPulseLine(f30, fSe, 'INVERTED');
T('fuel pulse INVERTED flags loudly + suspends sticky', FPi.includes('Regime: INVERTED') && FPi.includes('sticky-lead caution is suspended'));
T('fuel pulse null-degrades with zero stamps', A.ssFuelPulseLine({ transient: { n: 0, w: 0 }, earned: { n: 0, w: 0 } }, { transient: { n: 0, w: 0 }, earned: { n: 0, w: 0 } }, 'NEUTRAL') === null);
const SP = A.ssSystemPulseLine({ A: { w: 3, l: 1 }, B: { w: 0, l: 0 }, watch: { total: 7, converted: 5 }, gap: { n: 12, realized_pct: 75, predicted_pct: 70.2 } });
T('system pulse per-bucket, never pooled', SP === 'System pulse (last 30 days): Tier A 3-1; review flags 5 of 7 came back; gap-only spots 75% realized vs 70.2% predicted (12).');
T('system pulse gap suppressed under n=8', !A.ssSystemPulseLine({ A: { w: 1, l: 0 }, B: { w: 0, l: 0 }, watch: { total: 0, converted: 0 }, gap: { n: 5, realized_pct: 80, predicted_pct: 70 } }).includes('gap-only'));
T('system pulse null when all empty', A.ssSystemPulseLine({ A: { w: 0, l: 0 }, B: { w: 0, l: 0 }, watch: { total: 0, converted: 0 }, gap: null }) === null);
const CS = A.ssCashShadowLine({ n: 3, shadow: 812, hold: 640 });
T('cash shadow line + promotion bar restated', CS.includes('3 positions — shadow $812 vs hold $640') && CS.includes('15+ positions'));
T('cash shadow negative money format', A.ssCashShadowLine({ n: 1, shadow: -300, hold: -300 }).includes('shadow -$300 vs hold -$300'));
T('cash shadow null at n=0', A.ssCashShadowLine({ n: 0, shadow: 0, hold: 0 }) === null && A.ssCashShadowLine(null) === null);

console.log('DIGEST WIRING (old signature unchanged; pulse sections appended)');
const T0 = { tiers: { A: { w: 1, l: 0 }, B: { w: 0, l: 0 } }, watchlist: { total: 0, converted: 0 }, resolvedTonight: 1 };
const S0 = { A: { w: 5, l: 1 }, B: { w: 0, l: 0 }, watchlist: { total: 0, converted: 0 }, ledger: {} };
const dgOld = A.ssComposeDigest('2026-08-05', T0, S0, null);
const dgNew = A.ssComposeDigest('2026-08-05', T0, S0, null, { fuelLine: FP, systemLine: SP, shadowLine: CS });
T('4-arg call renders exactly as before (no pulse sections)', !dgOld.body.includes('Fuel pulse') && !dgOld.body.includes('System pulse'));
T('pulse sections render in order fuel→system→shadow', (() => {
  const i1 = dgNew.body.indexOf('Fuel pulse'), i2 = dgNew.body.indexOf('System pulse'), i3 = dgNew.body.indexOf('Cash-out shadow');
  return i1 > -1 && i2 > i1 && i3 > i2;
})());
T('null pulse lines omit themselves', !A.ssComposeDigest('2026-08-05', T0, S0, null, { fuelLine: null, systemLine: null, shadowLine: null }).body.includes('pulse'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

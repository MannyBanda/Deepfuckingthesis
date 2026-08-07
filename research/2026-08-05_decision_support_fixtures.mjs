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
const S = buildSide(POLL, [extractFn(POLL, 'ssCautionLines'), extractFn(POLL, 'ssFuelTempLines')]);
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
  exp: { fuel: 'EARNED', temp: 'warm', sticky: true, leaderBand: 'orange', leaderEfg: 62.5, trailerEfg: 52.6 } }); // F4 decouple pin: abs-warm display, sticky (period-cold input) STILL fires
// G2 — transient-heat (PHX@MIN archetype): red-band leader, low pot
G.push({ name: 'G2 transient-heat (red band)',
  L: { fgm: 14, fga: 24, fg3m: 8, ftm: 2, pot: 2, to: 4, vShare: 60 },
  Tr: { fgm: 9, fga: 20, fg3m: 2, ftm: 3, pot: 4, to: 6 }, p: 2,
  exp: { fuel: 'TRANSIENT (heat)', sticky: false, leaderBand: 'red', leaderEfg: 75 } }); // F4: temp pin moved to abs-band pins below
// G3 — transient-takeaway at var 20 (LA@DAL archetype): normal temp, pot 8
G.push({ name: 'G3 transient-takeaway (var 20)',
  L: { fgm: 11, fga: 20, fg3m: 2, ftm: 4, pot: 8, to: 3, vShare: 20 },
  Tr: { fgm: 8, fga: 18, fg3m: 3, ftm: 2, pot: 2, to: 4 }, p: 2,
  exp: { fuel: 'TRANSIENT (takeaway)', temp: 'warm', sticky: false, leaderBand: 'orange', pot: 8 } }); // F4 abs: 52.8
// G4 — both engines transient
G.push({ name: 'G4 heat + takeaway',
  L: { fgm: 13, fga: 22, fg3m: 9, ftm: 1, pot: 7, to: 2, vShare: 62 },
  Tr: { fgm: 10, fga: 20, fg3m: 2, ftm: 4, pot: 3, to: 5 }, p: 3,
  exp: { fuel: 'TRANSIENT (heat + takeaway)', temp: 'hot', sticky: false, leaderBand: 'red' } }); // F4 abs: exactly 55.0 -> float 55.000..04 > 55 -> hot (boundary artifact, pinned)
// G5 — insufficient data → no render anywhere
G.push({ name: 'G5 insufficient (fga < 12)',
  L: { fgm: 4, fga: 8, fg3m: 1, ftm: 0, pot: 0, to: 1 },
  Tr: { fgm: 5, fga: 13, fg3m: 1, ftm: 2, pot: 2, to: 2 }, p: 1,
  exp: { insufficient: true } });
// G6 — clean-cold blocked by turnovers (TO ≥ 4 → not sticky)
G.push({ name: 'G6 earned+cold but TO 5 (no sticky)',
  L: { fgm: 9, fga: 16, fg3m: 2, ftm: 1, pot: 2, to: 3, vShare: 38 },
  Tr: { fgm: 8, fga: 19, fg3m: 4, ftm: 0, pot: 3, to: 5 }, p: 2,
  exp: { fuel: 'EARNED', temp: 'warm', sticky: false } }); // F4 abs: 52.6 — earned caution still renders (non-sticky earned)
// G7 — 3PT-heavy heat without red band (orange + 64% pts from threes)
G.push({ name: 'G7 3PT-heavy heat (orange band)',
  L: { fgm: 10, fga: 20, fg3m: 6, ftm: 2, pot: 3, to: 3, vShare: 44 },
  Tr: { fgm: 12, fga: 20, fg3m: 1, ftm: 2, pot: 4, to: 3 }, p: 3,
  exp: { fuel: 'TRANSIENT (heat)', temp: 'hot', sticky: false, leaderBand: 'orange', threeShare: 64 } }); // F4 abs: 62.5
// G8 — hot trailer (red band) on an earned lead
G.push({ name: 'G8 earned + hot trailer',
  L: { fgm: 11, fga: 20, fg3m: 2, ftm: 3, pot: 2, to: 3, vShare: 30 },
  Tr: { fgm: 13, fga: 20, fg3m: 3, ftm: 1, pot: 3, to: 2 }, p: 2,
  exp: { fuel: 'EARNED', temp: 'hot', sticky: false, trailerBand: 'red' } });
// G9 — vShare-only heat (orange, threes < 40, var 50 > 45)
G.push({ name: 'G9 vShare-only heat',
  L: { fgm: 11, fga: 20, fg3m: 2, ftm: 3, pot: 2, to: 3, vShare: 50 },
  Tr: { fgm: 8, fga: 18, fg3m: 2, ftm: 2, pot: 2, to: 3 }, p: 2,
  exp: { fuel: 'TRANSIENT (heat)', temp: 'warm', sticky: false } }); // F4 abs: 50.0

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
T('G1 temp line (abs, no band parenthetical)', L1.includes('TRAILER TEMP: warm \u2014 GS shooting 53% effective field goal.'));
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

// ── Copy v1.2 pins (Aug 6): EARNED-LEAD CAUTION + CHANNEL NOTE ──
T('G1 sticky supersedes earned caution', !L1.includes('EARNED-LEAD CAUTION'));
const L6 = S.ssFuelTempLines(S.computeFuelTemp(G[5].L, G[5].Tr, 2), 'WSH', 'GS');
T('G6 earned caution (non-sticky earned)', L6.includes('EARNED-LEAD CAUTION (2026): no transient feed to regress \u2014 earned leads vs in-band better trailers converted only ~37% across three independent 2026 cuts, below what the live line charges. This season\'s pass shape. Context only, never a gate.'));
const L8 = S.ssFuelTempLines(S.computeFuelTemp(G[7].L, G[7].Tr, 2), 'LV', 'IND');
T('G8 earned caution (hot trailer)', L8.includes('EARNED-LEAD CAUTION'));
T('G8 no channel note on earned', !L8.includes('CHANNEL NOTE'));
T('G3 channel note (takeaway)', L3.includes('CHANNEL NOTE (2026): the takeaway feed is the market-blind transient \u2014 the live line has under-priced takeaway-fed collapse all season (trailers converted ~85%, two independent cuts). Context only, never a gate.'));
T('G4 channel note (heat + takeaway)', L4.includes('CHANNEL NOTE'));
T('G2 no channel note on heat-only', !L2.includes('CHANNEL NOTE'));
T('G2 no earned caution on transient', !L2.includes('EARNED-LEAD CAUTION'));
T('G9 no channel note (vShare heat, pot 2)', !L9.includes('CHANNEL NOTE'));

// ── F1 (Aug 6, row-1197 lesson): caution copy single-source + mechanical append ──
const cautionFn = new Function(`${extractFn(POLL, 'ssCautionLines')}; return ssCautionLines;`)();
const g1c = cautionFn(S.computeFuelTemp(G[0].L, G[0].Tr, 2));
T('F1 sticky caution extracted standalone', g1c.includes('STICKY LEAD SHAPE (2026)'));
T('F1 caution is a strict subset of the prompt block (single copy source)', g1c.length > 0 && L1.includes(g1c.trim()));
const g6c = cautionFn(S.computeFuelTemp(G[5].L, G[5].Tr, 2));
T('F1 earned caution standalone (non-sticky)', g6c.includes('EARNED-LEAD CAUTION (2026)') && L6.includes(g6c.trim()));
const g3c = cautionFn(S.computeFuelTemp(G[2].L, G[2].Tr, 2));
T('F1 channel note standalone (takeaway)', g3c.includes('CHANNEL NOTE (2026)') && L3.includes(g3c.trim()));
T('F1 insufficient renders no cautions', cautionFn(S.computeFuelTemp(G[4].L, G[4].Tr, 1)) === '');
// source-level: the mechanical append marker exists at BOTH push sites (sweep + immediate fire)
T('F1 mechanical append at both push sites', (POLL.match(/PINNED CONTEXT \(mechanical, not model output\)/g) || []).length >= 2);

// ── ACA P1 (Aug 6): trap parity + T+0 FACT block + B1 regression net ──
const trapC = cautionFn(S.computeFuelTemp(G[5].L, G[5].Tr, 2), { lead_class: 'STRUCTURAL' });
T('P1 STRUCTURAL trap renders with row', trapC.includes('STRUCTURAL-LEADER TRAP') && trapC.includes('the pass shape (POR@CHI rule)'));
T('P1 trap absent without row', !cautionFn(S.computeFuelTemp(G[5].L, G[5].Tr, 2)).includes('STRUCTURAL-LEADER TRAP'));
T('P1 trap absent on VOLATILE class', !cautionFn(S.computeFuelTemp(G[5].L, G[5].Tr, 2), { lead_class: 'VOLATILE' }).includes('STRUCTURAL-LEADER TRAP'));
T('P1 trap coexists with earned caution (both pinned)', trapC.includes('EARNED-LEAD CAUTION'));
T('P1 dashboard trap copy kernel mirrored in server source', POLL.includes('Structural leader = the pass shape (POR@CHI rule). Conscious override territory only'));
T('P1 T+0 fact block wired at Stage 1b', POLL.includes('ACA P1 \u2014 T+0 FACT block') && /ssFuelTempLines\(ss\.fuelTemp, ss\.leaderAl, ss\.trailerAl, \{ lead_class: ss\.leadClass \}\)/.test(POLL));
T('B1 breadcrumb fix in place (no push.body rebuild)', !POLL.includes("_pushBody = push.body + '\\n\\n' + _tcLine"));

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

// ════════════════════════════════════════════════════════════════════════════
// C3 — CASH surge watch (odds-squeeze.mjs; v1.1 addendum: −400 price gate,
// dual-path profit lock, % default / $ upgrade, frac stamps)
// ════════════════════════════════════════════════════════════════════════════
const { devigProb, surgeCheck, composeCashout, implied: sqImplied } = await import('../netlify/functions/odds-squeeze.mjs');

console.log('SURGE PRICE GATE (v1.1: raw -400 line; de-vig stamped, not gating)');
T('-450 crosses the -400 line', surgeCheck({ coldAtFire: true, price: -450, lead: 3, lockOk: true, alreadyFired: false }).fire === true);
T('-400 exactly fires (at the line)', surgeCheck({ coldAtFire: true, price: -400, lead: 3, lockOk: true, alreadyFired: false }).fire === true);
T('-350 does not cross (#545 class, peak -400 near-miss now fires; -350 does not)', surgeCheck({ coldAtFire: true, price: -350, lead: 3, lockOk: true, alreadyFired: false }).why === 'price-above');
T('plus-money price never crosses', surgeCheck({ coldAtFire: true, price: 150, lead: 3, lockOk: true, alreadyFired: false }).why === 'price-above');
T('devig still computed for stamps: -450/+350 = .786', Math.abs(devigProb(-450, 350) - 0.7864) < 0.001);
T('devig null-degrades on missing side', devigProb(null, 350) === null && devigProb(-450, null) === null);

console.log('SURGE TRIGGER MATRIX');
const base3 = { coldAtFire: true, price: -420, lead: 3, lockOk: true, alreadyFired: false };
T('fires: cold + -420 + lead 3 + lock ok', surgeCheck(base3).fire === true);
T('warm-at-fire NEVER triggers (rides)', surgeCheck({ ...base3, coldAtFire: false }).why === 'not-cold-at-fire');
T('one-shot per position', surgeCheck({ ...base3, alreadyFired: true }).why === 'one-shot');
T('lead 0 blocks even at -600 (t=0 / deep-favorite artifact guard)', surgeCheck({ ...base3, price: -600, lead: 0 }).why === 'no-lead');
T('profit lock leg blocks when caller says no', surgeCheck({ ...base3, lockOk: false }).why === 'no-profit-lock');

console.log('PROFIT-LOCK DUAL-PATH MATH (caller logic, pinned here)');
// $ path: frac × payout >= stake · % path: frac >= implied(fire price)
const frac81 = 0.81 * 0.93; // p .81 → frac .7533
T('$ path locks: frac .753 × $1500 payout = $1130 >= $500 stake', frac81 * 1500 >= 500);
T('% path equals $ path at fire price: frac .753 >= implied(+150)=.40', frac81 >= sqImplied(150));
T('% path blocks a deep-favorite fire price: frac .753 < implied(-350)=.778', frac81 < sqImplied(-350));

console.log('CASHOUT TIP COPY (Manny template; % default, $ when logged)');
const tipD = composeCashout({ trailer: 'GS', elite: true, lead: 5, p: 0.81, frac: frac81, dollars: { estCash: 1130, payout: 1500 }, fireLine: 150, fireEfg: 52.6 });
T('$ path opens per template with elite tag', tipD.body.startsWith('Cashout check: GS (elite) now leads by 5.'));
T('$ path market + locks lines', tipD.body.includes('Market has GS ~81%. Cash-out locks ~$1130 of $1500 payout'));
T('$ path because-clause from FIRE-TIME read', tipD.body.includes('riding risks a loss because GS was cold at entry (53% eFG) and cold-start comebacks have given leads back.'));
const tipP = composeCashout({ trailer: 'GS', elite: false, lead: 5, p: 0.81, frac: frac81, dollars: null, fireLine: 150, fireEfg: 52.6 });
T('% path fair-cash + breakeven clause', tipP.body.includes('Market has GS ~81% - a fair cash-out is ~75% of your full payout; a +150 entry breaks even at ~40%.'));
T('% path because-clause carried', tipP.body.includes('Riding risks a loss because GS was cold at entry (53% eFG)'));
const tipN = composeCashout({ trailer: 'MIN', elite: false, lead: 2, p: 0.80, frac: 0.80 * 0.93, dollars: null, fireLine: null, fireEfg: 48.9 });
T('% path omits breakeven when fire price absent', tipN.body.includes('~74% of your full payout. Riding risks') && !tipN.body.includes('breaks even'));
T('non-directive tail both paths', tipD.body.includes('Your read - not a directive.') && tipP.body.includes('Your read - not a directive.'));
T('title ascii-safe', /^[\x00-\x7F]+$/.test(tipD.title) && tipD.title === 'CASHOUT CHECK: GS leads by 5');
T('non-elite omits the tag', tipP.body.startsWith('Cashout check: GS now leads by 5.'));

console.log('CLOSED-CARD AT FIRE STAMP (v1.1 B, client pure fn)');
const stampFn = new Function(`${extractFn(CLIENT, 'ssFuelStampText')}; return ssFuelStampText;`)();
const g1ft = S.computeFuelTemp(G[0].L, G[0].Tr, 2);
T('stamp text from row-23 golden', stampFn(g1ft, 2, '9:42') === 'AT FIRE (Q2 9:42): EARNED \u00b7 trailer warm (53% eFG)');
T('stamp null on insufficient (no fake reads)', stampFn({ insufficient: true }, 2, '9:42') === null && stampFn(null, 2, '9:42') === null);
T('stamp clock-less form', stampFn(g1ft, 2, '') === 'AT FIRE (Q2): EARNED \u00b7 trailer warm (53% eFG)');

console.log('POT SOURCE PRIORITY (Aug 5 live-slate hotfix — flipped-ESPN guard)');
const ftStats = new Function(`${extractFn(CLIENT, '_ftClientStats')}; return _ftClientStats;`)();
const mkCs = (tePot, bdlPot) => ({ _teamEvidence: { home: { fgm: 9, fga: 16, fg3m: 2, ftm: 1, turnovers: 3, pot: tePot } },
  pbpAudit: bdlPot === undefined ? null : { _bdl: { potHome: bdlPot, potAway: 0 } } });
T('PBP pot wins over unflipped ESPN pot', ftStats(mkCs(4, 6), 'home').pot === 6);
T('PBP pot of 0 is trusted (no fallback to flipped value)', ftStats(mkCs(4, 0), 'home').pot === 0);
T('ESPN pot only when no PBP audit', ftStats(mkCs(4, undefined), 'home').pot === 4);
T('turnovers key mapped to to', ftStats(mkCs(4, 6), 'home').to === 3);

console.log('FIX B — POT PARSE-SOURCE FLIP (Aug 6)');
const bte = new Function(`${extractFn(CLIENT, 'buildTeamEvidenceFromESPN')}; return buildTeamEvidenceFromESPN;`)();
const mkBox = (side, pot) => ({ homeAway: side, statistics: [
  { name: 'fieldGoalsMade-fieldGoalsAttempted', displayValue: '10-20' },
  { name: 'turnoverPoints', displayValue: String(pot) }] });
const ev = bte({ boxscore: [mkBox('home', 4), mkBox('away', 6)] }, {});
T('ESPN home pot 4 lands on AWAY (opponent-attributed feed flipped)', ev.away.pot === 4);
T('ESPN away pot 6 lands on HOME', ev.home.pot === 6);
T('non-pot stats unswapped', ev.home.fgm === 10 && ev.away.fgm === 10);
T('source tag preserved', ev.source === 'espn');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

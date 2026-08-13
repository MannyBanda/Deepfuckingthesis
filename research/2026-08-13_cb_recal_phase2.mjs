// PHASE 2 — model ladder fits (M0 control / M1 refit values / M2 +time axis), season holdout
// both directions. Prereg: 2026-08-13_comebackprob_recal_PREREG.md (sha a2e8186e…).
// Fit criterion: Brier on train stampable set. Bars evaluated on band (deficit 1-9) holdout.
// H3 (fadeRead bump): reported at whatever power exists.
import fs from 'fs'; import zlib from 'zlib';

const matched = JSON.parse(zlib.gunzipSync(fs.readFileSync('research/fixtures_fine_states_matched.json.gz')));
const replay  = JSON.parse(fs.readFileSync('research/fixtures_tier_replay_states.json'));
const key = (s) => [s.gid, s.period, s.tb, s.margin, s.leader, (+s.gap).toFixed(9)].join('|');
const rmap = new Map(); for (const r of replay) if (!rmap.has(key(r))) rmap.set(key(r), r);

const stampable = matched.filter((s) => s.lwp < 0.40 && s.gap >= 0.10 && s.margin >= 1 && s.margin <= 19)
  .map((s) => ({ ...s, _fade: rmap.has(key(s)) ? rmap.get(key(s)).fade : null }));
const band = (rows) => rows.filter((s) => s.margin <= 9);
console.log('stampable', stampable.length, 'band', band(stampable).length,
  'out-of-band buckets: d10-14', stampable.filter((s) => s.margin >= 10 && s.margin <= 14).length,
  'd15-19', stampable.filter((s) => s.margin >= 15).length);

// parameterized stamp — production form. th = {b5,b9,b14,b19,h,s,m4e,m4l}
function stamp(s, th) {
  const base = s.margin <= 5 ? th.b5 : s.margin <= 9 ? th.b9 : s.margin <= 14 ? th.b14 : th.b19;
  let p;
  if (s.gap > 0.20) { const lean = Math.max(-1, Math.min(1, (s.gap - 0.20) / 0.20)) * th.s; p = Math.max(0.10, Math.min(0.85, base + lean)); }
  else p = base * th.h;
  if (s._fade === 'STRONG FADE') p = Math.min(0.85, p + 0.03);
  const mt = s.period < 4 ? 1 : (s.tb === 'Q4-late' ? th.m4l : th.m4e);
  return Math.max(0.05, Math.min(0.95, p * mt));
}
const PROD = { b5: 0.68, b9: 0.56, b14: 0.50, b19: 0.44, h: 0.75, s: 0.05, m4e: 1, m4l: 1 };
const brier = (rows, th) => rows.reduce((a, s) => a + Math.pow((s.won ? 1 : 0) - stamp(s, th), 2), 0) / rows.length;
const mse = (rows, th) => (rows.reduce((a, s) => a + (s.won ? 1 : 0) - stamp(s, th), 0) / rows.length) * 100;

const grids = {
  b5: range(0.30, 0.80, 0.01), b9: range(0.25, 0.75, 0.01),
  b14: range(0.10, 0.60, 0.02), b19: range(0.10, 0.60, 0.02),
  h: range(0.60, 1.60, 0.02), s: range(0, 0.20, 0.01),
  m4e: range(0.40, 1.20, 0.02), m4l: range(0.20, 1.20, 0.02),
};
function range(a, b, st) { const o = []; for (let x = a; x <= b + 1e-9; x += st) o.push(+x.toFixed(4)); return o; }

// out-of-band refit rule: pooled n>=30 per prereg
const nOOB14 = stampable.filter((s) => s.margin >= 10 && s.margin <= 14).length;
const nOOB19 = stampable.filter((s) => s.margin >= 15).length;
const fitOOB14 = nOOB14 >= 30, fitOOB19 = nOOB19 >= 30;

function fit(rows, freeParams) {
  const th = { ...PROD };
  for (let round = 0; round < 6; round++) {
    for (const p of freeParams) {
      let best = th[p], bb = brier(rows, th);
      for (const v of grids[p]) { th[p] = v; const b = brier(rows, th); if (b < bb - 1e-12) { bb = b; best = v; } }
      th[p] = best;
    }
  }
  return th;
}
const m1Params = ['b5', 'b9', 'h', 's'].concat(fitOOB14 ? ['b14'] : []).concat(fitOOB19 ? ['b19'] : []);
const m2Params = m1Params.concat(['m4e', 'm4l']);
console.log('OOB refit: d10-14', fitOOB14 ? 'YES(n=' + nOOB14 + ')' : 'NO(n=' + nOOB14 + ')', '| d15-19', fitOOB19 ? 'YES(n=' + nOOB19 + ')' : 'NO(n=' + nOOB19 + ')');

const dirs = [[2024, 2025], [2025, 2024]];
const results = {};
for (const [trainYr, testYr] of dirs) {
  const train = stampable.filter((s) => s.season === trainYr);
  const test = stampable.filter((s) => s.season === testYr);
  const tBand = band(test);
  const m1 = fit(train, m1Params);
  const m2 = fit(train, m2Params);
  results[trainYr] = { m1, m2 };
  console.log(`\n=== fit ${trainYr} → test ${testYr} (test band n=${tBand.length}) ===`);
  console.log('M1 params', JSON.stringify(m1));
  console.log('M2 params', JSON.stringify(m2));
  for (const [name, th] of [['M0', PROD], ['M1', m1], ['M2', m2]]) {
    console.log(`${name}: holdout band Brier=${brier(tBand, th).toFixed(4)}  mse=${mse(tBand, th).toFixed(1)}pp   (all-stampable Brier=${brier(test, th).toFixed(4)} mse=${mse(test, th).toFixed(1)}pp)`);
  }
}

// pooled holdout (each season scored by the model fit on the OTHER season)
console.log('\n=== POOLED HOLDOUT (band) — H2 bars ===');
for (const name of ['M0', 'M1', 'M2']) {
  let se = 0, b = 0, n = 0;
  for (const [trainYr, testYr] of dirs) {
    const th = name === 'M0' ? PROD : results[trainYr][name.toLowerCase()];
    for (const s of band(stampable.filter((x) => x.season === testYr))) { const p = stamp(s, th); se += (s.won ? 1 : 0) - p; b += Math.pow((s.won ? 1 : 0) - p, 2); n++; }
  }
  console.log(`${name}: pooled holdout Brier=${(b / n).toFixed(4)}  |mse|=${Math.abs((se / n) * 100).toFixed(1)}pp  (signed ${((se / n) * 100).toFixed(1)})  n=${n}`);
}

// final-model fit on BOTH seasons (the candidate for the decision package)
const m1All = fit(stampable, m1Params);
const m2All = fit(stampable, m2Params);
console.log('\n=== FULL-SAMPLE FITS (decision-package candidates) ===');
console.log('M1', JSON.stringify(m1All));
console.log('M2', JSON.stringify(m2All));
for (const [name, th] of [['M0', PROD], ['M1', m1All], ['M2', m2All]]) {
  console.log(`${name}: in-sample band Brier=${brier(band(stampable), th).toFixed(4)} mse=${mse(band(stampable), th).toFixed(1)}pp`);
}

// calibration table under M2 full fit
console.log('\n=== calibration by stamped bin, band, M2 full fit ===');
const bins = [[0, 0.35], [0.35, 0.45], [0.45, 0.55], [0.55, 0.65], [0.65, 1.01]];
for (const [lo, hi] of bins) {
  const c = band(stampable).filter((s) => { const p = stamp(s, m2All); return p >= lo && p < hi; });
  if (!c.length) continue;
  const conv = (c.filter((s) => s.won).length / c.length) * 100;
  const mp = (c.reduce((a, s) => a + stamp(s, m2All), 0) / c.length) * 100;
  console.log(`stamp ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}: realized ${conv.toFixed(1)}  meanStamp ${mp.toFixed(1)}  n=${c.length}`);
}

// H3 — fadeRead bump at whatever power exists
console.log('\n=== H3 — STRONG FADE incidence & raw ordering ===');
const sf = stampable.filter((s) => s._fade === 'STRONG FADE');
console.log(`STRONG FADE stampable states: n=${sf.length} (${(100 * sf.length / stampable.length).toFixed(1)}% incidence)`);
if (sf.length) {
  const conv = (r) => r.length ? (100 * r.filter((s) => s.won).length / r.length).toFixed(0) : '—';
  console.log(`raw: SF conv=${conv(sf)}% | matched-cell comparison unpowered at this n — ordering only per prereg`);
}

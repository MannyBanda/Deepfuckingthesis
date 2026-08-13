// PHASE 1 — comebackProb bias measurement vs fine arena.
// Prereg: research/2026-08-13_comebackprob_recal_PREREG.md (sha a2e8186e…, commit 6c3ed3b)
// Population: fixtures_fine_states_matched.json.gz (3,113, window 750-2250s).
// fadeRead joined from fixtures_tier_replay_states.json (verbatim divergenceRead at replay).
// Port cross-check: my comebackProb tier must equal replay `coll` on every joined state.
import fs from 'fs'; import zlib from 'zlib';

// ---- verbatim production port (poll-live-bdl.mjs L5308/5329 @ a3f885a) ----
function cbDepthRate(d) { if (d <= 5) return 0.68; if (d <= 9) return 0.56; if (d <= 14) return 0.50; if (d <= 19) return 0.44; return 0; }
function comebackProb(leaderWP, trailerWP, deficit, period, fadeRead) {
  if (leaderWP == null || trailerWP == null) return { tier: 'NO_DATA' };
  if (leaderWP >= 0.40) return { tier: 'NO_EDGE', leaderWP };
  if (deficit >= 20) return { tier: 'DEAD', deficit };
  var gap = trailerWP - leaderWP;
  if (gap < 0.10) return { tier: 'NO_QUALITY_EDGE', gap };
  var base = cbDepthRate(deficit), pPoint, drivers = [];
  if (gap > 0.20) { var lean = Math.max(-1, Math.min(1, (gap - 0.20) / 0.20)) * 0.05; pPoint = Math.max(0.10, Math.min(0.85, base + lean)); }
  else { pPoint = base * 0.75; }
  if (fadeRead && fadeRead.tier === 'STRONG FADE') { pPoint = Math.min(0.85, pPoint + 0.03); drivers.push('fragile lead'); }
  var tier = gap > 0.20 ? (deficit <= 7 ? 'SHORT' : 'STRONG') : 'MODERATE';
  return { tier, pPoint, gap, drivers };
}
// ---------------------------------------------------------------------------

const matched = JSON.parse(zlib.gunzipSync(fs.readFileSync('research/fixtures_fine_states_matched.json.gz')));
const replay  = JSON.parse(fs.readFileSync('research/fixtures_tier_replay_states.json'));

// join fade (+coll for the port gate) onto matched states
const key = (s) => [s.gid, s.period, s.tb, s.margin, s.leader, (+s.gap).toFixed(9)].join('|');
const rmap = new Map();
let collide = 0;
for (const r of replay) {
  const k = key(r);
  if (rmap.has(k)) { const p = rmap.get(k); if (p.fade !== r.fade || p.coll !== r.coll) { p.bad = true; collide++; } }
  else rmap.set(k, { fade: r.fade, coll: r.coll, bad: false });
}
let joined = 0, unjoined = 0, ambiguous = 0;
for (const s of matched) {
  const m = rmap.get(key(s));
  if (!m) { s._fade = null; unjoined++; }
  else if (m.bad) { s._fade = null; ambiguous++; }
  else { s._fade = m.fade; s._coll = m.coll; joined++; }
}
console.log(`JOIN: joined=${joined}/${matched.length} unjoined=${unjoined} ambiguous=${ambiguous} (replay dup-key conflicts=${collide})`);

// stamp every state; port fixture gate vs replay coll
let portMismatch = 0, portChecked = 0;
for (const s of matched) {
  const fr = s._fade ? { tier: s._fade } : null;
  const r = comebackProb(s.lwp, s.lwp + s.gap, s.margin, s.period, fr);
  s._tier = r.tier; s._p = r.pPoint != null ? r.pPoint : null;
  if (s._coll !== undefined) { portChecked++; if (s._coll !== r.tier) portMismatch++; }
}
console.log(`PORT GATE: checked=${portChecked} mismatches=${portMismatch} ${portMismatch === 0 ? 'PASS' : 'FAIL — STOP'}`);
if (portMismatch > 0) process.exit(1);

// stampable populations
const stampable = matched.filter((s) => s._p != null && s.margin >= 1);
const band = stampable.filter((s) => s.margin <= 9);
console.log(`STAMPABLE: all=${stampable.length} band(1-9)=${band.length}`);

const mse = (rows) => { if (!rows.length) return null; let e = 0; for (const s of rows) e += (s.won ? 1 : 0) - s._p; return (e / rows.length) * 100; };
const conv = (rows) => rows.length ? (rows.filter((s) => s.won).length / rows.length) * 100 : null;
const brier = (rows) => { if (!rows.length) return null; let b = 0; for (const s of rows) b += Math.pow((s.won ? 1 : 0) - s._p, 2); return b / rows.length; };
const meanP = (rows) => rows.length ? (rows.reduce((a, s) => a + s._p, 0) / rows.length) * 100 : null;

// cluster bootstrap by gid (1000 resamples) for band mean signed error
function clusterCI(rows, iters = 1000) {
  const byG = new Map();
  for (const s of rows) { if (!byG.has(s.gid)) byG.set(s.gid, []); byG.get(s.gid).push(s); }
  const gids = [...byG.keys()]; const out = [];
  let seed = 20260813;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < iters; i++) {
    let e = 0, n = 0;
    for (let j = 0; j < gids.length; j++) { const g = byG.get(gids[Math.floor(rnd() * gids.length)]); for (const s of g) { e += (s.won ? 1 : 0) - s._p; n++; } }
    out.push((e / n) * 100);
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(iters * 0.025)], out[Math.floor(iters * 0.975)]];
}

const seasons = [2024, 2025];
console.log('\n=== H1 — mean signed error (realized − stamped), band 1-9 ===');
const ci = clusterCI(band);
console.log(`POOLED: mse=${mse(band).toFixed(1)}pp  conv=${conv(band).toFixed(1)}  meanStamp=${meanP(band).toFixed(1)}  n=${band.length}  brier(M0)=${brier(band).toFixed(4)}  gid-cluster 95% CI [${ci[0].toFixed(1)}, ${ci[1].toFixed(1)}]`);
for (const yr of seasons) { const r = band.filter((s) => s.season === yr); console.log(`  ${yr}: mse=${mse(r).toFixed(1)}pp  conv=${conv(r).toFixed(1)}  meanStamp=${meanP(r).toFixed(1)}  n=${r.length}`); }

// first-stampable-per-game sensitivity
const firstByGid = new Map();
for (const s of band) { const c = firstByGid.get(s.gid); if (!c || s.gameSec < c.gameSec) firstByGid.set(s.gid, s); }
const first = [...firstByGid.values()];
console.log(`SENSITIVITY first-per-game: mse=${mse(first).toFixed(1)}pp n=${first.length}  (2024 ${mse(first.filter((s) => s.season === 2024)).toFixed(1)} / 2025 ${mse(first.filter((s) => s.season === 2025)).toFixed(1)})`);

console.log('\n=== SIGNED-ERROR MAP (band) — region × gap regime × time ===');
const regions = [['d13', (s) => s.margin <= 3], ['d46', (s) => s.margin >= 4 && s.margin <= 6], ['d79', (s) => s.margin >= 7]];
const regimes = [['haircut .10-.20', (s) => s.gap <= 0.20], ['lean >.20', (s) => s.gap > 0.20]];
const times = [['preQ4', (s) => s.period < 4], ['Q4e', (s) => s.tb === 'Q4-early'], ['Q4l', (s) => s.tb === 'Q4-late']];
for (const [rn, rf] of regions) for (const [gn, gf] of regimes) {
  const line = [];
  for (const [tn, tf] of times) { const c = band.filter((s) => rf(s) && gf(s) && tf(s)); line.push(`${tn}: ${c.length ? mse(c).toFixed(1) + 'pp/' + conv(c).toFixed(0) + '%@n' + c.length + '(stamp ' + meanP(c).toFixed(0) + ')' : '—'}`); }
  console.log(`${rn} ${gn}  ${line.join('  ')}`);
}

console.log('\n=== BY STAMPED-PROBABILITY BIN (band) ===');
const bins = [[0, 0.45], [0.45, 0.55], [0.55, 0.65], [0.65, 0.75], [0.75, 1.01]];
for (const [lo, hi] of bins) { const c = band.filter((s) => s._p >= lo && s._p < hi); if (c.length) console.log(`stamp ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}: realized ${conv(c).toFixed(1)}%  meanStamp ${meanP(c).toFixed(1)}  mse ${mse(c).toFixed(1)}pp  n=${c.length} (2024 ${mse(c.filter((s) => s.season === 2024)) === null ? '—' : mse(c.filter((s) => s.season === 2024)).toFixed(1)} / 2025 ${mse(c.filter((s) => s.season === 2025)) === null ? '—' : mse(c.filter((s) => s.season === 2025)).toFixed(1)})`); }

console.log('\n=== H1a — fired-comparable shape (leader<.400 ∧ gap≥.15 ∧ band) ===');
const fired = band.filter((s) => s.gap >= 0.15);
console.log(`ALL-TIME: mse=${mse(fired).toFixed(1)}pp conv=${conv(fired).toFixed(1)} meanStamp=${meanP(fired).toFixed(1)} n=${fired.length} (2024 ${mse(fired.filter((s) => s.season === 2024)).toFixed(1)} / 2025 ${mse(fired.filter((s) => s.season === 2025)).toFixed(1)})`);
const firedPre = fired.filter((s) => s.period < 4);
console.log(`PRE-Q4 : mse=${mse(firedPre).toFixed(1)}pp conv=${conv(firedPre).toFixed(1)} meanStamp=${meanP(firedPre).toFixed(1)} n=${firedPre.length} (2024 ${mse(firedPre.filter((s) => s.season === 2024)).toFixed(1)} / 2025 ${mse(firedPre.filter((s) => s.season === 2025)).toFixed(1)})`);

// scored states out for commit
fs.writeFileSync('/tmp/cb_phase1_scored.json', JSON.stringify(stampable.map((s) => ({ season: s.season, gid: s.gid, gameSec: s.gameSec, tb: s.tb, period: s.period, margin: s.margin, gap: +s.gap.toFixed(6), lwp: +s.lwp.toFixed(6), fade: s._fade, tier: s._tier, p: +s._p.toFixed(4), won: s.won }))));
console.log('\nscored states → /tmp/cb_phase1_scored.json');

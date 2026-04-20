void 0; {
// ═══════════════════════════════════════════════════════════
// 3-MINUTE CHECKPOINT GRADUATION BACKTEST
// Production replay: 196 games with 10+ server snapshots
// Tests mean floor + persistence at 3-min checkpoint intervals
// ═══════════════════════════════════════════════════════════

const BASE = '/.netlify/functions/db-api';
const OPTS = { credentials: 'include' };

async function api(params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${BASE}?${qs}`, OPTS);
  if (!r.ok) throw new Error(`${r.status} on ${params.action}`);
  return r.json();
}

// ── Checkpoint definitions ─────────────────────────────────
// Each checkpoint = { label, gameSec } where gameSec = seconds from game start
// Period is 720s (12 min). Clock counts down from 12:00.
// gameSec = (period-1)*720 + (720 - clockSec)
const CHECKPOINTS = [
  { label: 'Q1_END', gameSec: 720 },
  { label: 'Q2_9',   gameSec: 900 },
  { label: 'Q2_6',   gameSec: 1080 },
  { label: 'Q2_3',   gameSec: 1260 },
  { label: 'Q2_END', gameSec: 1440 },
  { label: 'Q3_9',   gameSec: 1620 },
  { label: 'Q3_6',   gameSec: 1800 },
  { label: 'Q3_3',   gameSec: 1980 },
  { label: 'Q3_END', gameSec: 2160 },
  { label: 'Q4_9',   gameSec: 2340 },
  { label: 'Q4_6',   gameSec: 2520 },
  { label: 'Q4_3',   gameSec: 2700 },
];

function snapToGameSec(snap) {
  const p = snap.period || 1;
  const cm = String(snap.clock || '12:00').match(/(\d+):(\d+)/);
  const clockSec = cm ? parseInt(cm[1]) * 60 + parseInt(cm[2]) : 720;
  return (p - 1) * 720 + (720 - clockSec);
}

function classifyRank(convictionTier, ctrlMargin, consecutiveHolds, oppIndicatorCount) {
  if (convictionTier === 'DOMINANT' && ctrlMargin >= 8
      && consecutiveHolds >= 4 && oppIndicatorCount <= 1) return 'A';
  if (oppIndicatorCount >= 3) return 'C';
  if ((convictionTier === 'DOMINANT' || convictionTier === 'STRONG')
      && ctrlMargin >= 3 && consecutiveHolds >= 2) return 'B';
  return 'C';
}

function computeConviction(i1, i2, i3, i4, i5, ctrlIsHome) {
  const scores = [
    { name: 'I1', raw: i1 }, { name: 'I2', raw: i2 }, { name: 'I3', raw: i3 },
    { name: 'I4', raw: i4 }, { name: 'I5', raw: i5 },
  ];
  const wins = [], loses = [];
  for (const s of scores) {
    if (s.raw == null) continue;
    const ctrlScore = ctrlIsHome ? s.raw : 1 - s.raw;
    if (ctrlScore > 0.5) wins.push(s.name);
    else if (ctrlScore < 0.5) loses.push(s.name);
  }
  const count = wins.length;
  const has = (a, b) => wins.includes(a) && wins.includes(b);
  const hasI4I5 = has('I4', 'I5'), hasI3I4 = has('I3', 'I4'), hasI3I5 = has('I3', 'I5');
  const hasKillerPair = hasI4I5 || hasI3I4 || hasI3I5;
  const isDanger = (
    (count === 2 && wins.includes('I1') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4')) ||
    (count === 3 && wins.includes('I1') && wins.includes('I2') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4')) ||
    (count === 3 && wins.includes('I2') && wins.includes('I3') && wins.includes('I5') && !wins.includes('I4'))
  );
  let tier;
  if (count >= 4 || hasI4I5) tier = 'DOMINANT';
  else if (hasKillerPair && !isDanger) tier = 'STRONG';
  else if (count >= 2 && !isDanger) tier = 'MODEST';
  else if (count >= 1) tier = 'CONDITIONAL';
  else tier = 'NO ENTRY';
  return { tier, combo: wins.join('+') || 'NONE', count, indicatorsWon: wins, indicatorsLost: loses };
}

// ── Main backtest ──────────────────────────────────────────

(async () => {
  console.log('%c═══ 3-MINUTE CHECKPOINT GRADUATION BACKTEST ═══', 'color: gold; font-size: 16px; font-weight: bold');

  const diag = await api({ action: 'snapshot_diagnostic' });
  const allGames = diag.games || [];
  console.log(`Found ${allGames.length} games with 10+ server snapshots`);

  const results = [];
  let fetched = 0;

  for (const game of allGames) {
    fetched++;
    if (fetched % 20 === 0) console.log(`  Processing ${fetched}/${allGames.length}...`);

    const histData = await api({ action: 'history', game_id: game.game_id });
    const allSnaps = (histData.snapshots || []).filter(s => s.source === 'server');
    if (allSnaps.length < 10) continue;

    allSnaps.sort((a, b) => new Date(a.ts) - new Date(b.ts));

    const homeAlias = game.matchup.split('@')[1];
    const awayAlias = game.matchup.split('@')[0];

    // Derive winner
    let gameWinner = game.winner;
    if (!gameWinner && game.margin != null && game.margin !== 0) {
      gameWinner = game.margin > 0 ? homeAlias : awayAlias;
    }
    if (!gameWinner) continue;

    // ── Map each snapshot to gameSec ──
    const snapsWithTime = allSnaps.map(s => ({ ...s, gameSec: snapToGameSec(s) }));

    // ── Find closest snapshot to each checkpoint ──
    const cpData = [];
    const TOLERANCE = 90; // ±90 seconds

    for (const cp of CHECKPOINTS) {
      let best = null, bestDist = Infinity;
      for (const s of snapsWithTime) {
        const dist = Math.abs(s.gameSec - cp.gameSec);
        if (dist < bestDist) { bestDist = dist; best = s; }
      }
      if (best && bestDist <= TOLERANCE) {
        const ctrlTeam = best.floor_team;
        const floor = best.floor_score;
        const ctrlIsHome = ctrlTeam === homeAlias;
        const ctrlPts = ctrlIsHome ? best.home_pts : best.away_pts;
        const oppPts = ctrlIsHome ? best.away_pts : best.home_pts;
        const margin = ctrlPts - oppPts;

        const conv = computeConviction(best.i1, best.i2, best.i3, best.i4, best.i5, ctrlIsHome);
        const oppCount = conv.indicatorsLost.length;

        cpData.push({
          label: cp.label, gameSec: cp.gameSec,
          ctrlTeam, floor, margin, conv: conv.tier, combo: conv.combo,
          oppCount, indicatorsWon: conv.indicatorsWon, indicatorsLost: conv.indicatorsLost,
          homePts: best.home_pts, awayPts: best.away_pts,
        });
      }
    }

    if (cpData.length < 2) continue;

    // ── Identify BWC team (first team to hold control at 2+ consecutive checkpoints ──
    //    with floor >= 0.60, margin >= 2, starting from Q1_END)
    let bwcTeam = null;
    let bwcCpIdx = null;
    for (let i = 1; i < cpData.length; i++) {
      const prev = cpData[i - 1];
      const cur = cpData[i];
      if (prev.ctrlTeam === cur.ctrlTeam &&
          prev.floor >= 0.60 && prev.margin >= 2 &&
          cur.floor >= 0.60 && cur.margin >= 2) {
        bwcTeam = cur.ctrlTeam;
        bwcCpIdx = i - 1; // first qualifying checkpoint
        break;
      }
    }

    if (!bwcTeam) {
      results.push({
        game_id: game.game_id, matchup: game.matchup, winner: gameWinner,
        finalMargin: game.margin, isClose: Math.abs(game.margin) <= 8,
        bwcTeam: null, bwcWon: false, checkpoints: cpData.length,
        bwcEligibleCps: 0, meanFloor: null, minFloor: null,
        watermark: null, peakCps: 0, graduationCp: null,
        ctrlFlips: 0,
      });
      continue;
    }

    // ── Walk checkpoints from BWC fire onward ──
    const bwcWon = bwcTeam === gameWinner;
    const eligibleFloors = [];
    let holds = 0;
    let ctrlFlips = 0;
    let prevCtrl = null;
    let peakRank = 'C';
    let peakCps = 0;
    let graduationCp = null;
    let graduationFloor = null;
    let graduationMargin = null;
    const rankAtCp = [];

    // Track opponent graduation too
    let oppTeam = bwcTeam === homeAlias ? awayAlias : homeAlias;
    let oppEligibleCps = 0;
    let oppPeakRank = 'C';

    for (let i = 0; i < cpData.length; i++) {
      const cp = cpData[i];

      // Track control flips (across all checkpoints, not just BWC-eligible)
      if (prevCtrl && prevCtrl !== cp.ctrlTeam) ctrlFlips++;
      prevCtrl = cp.ctrlTeam;

      if (cp.ctrlTeam === bwcTeam) {
        // Count consecutive holds for this team at this checkpoint
        if (i > 0 && cpData[i-1].ctrlTeam === bwcTeam) holds++;
        else holds = 1;

        // BWC-eligible? (floor >= 0.60, margin >= 2)
        const eligible = cp.floor >= 0.60 && cp.margin >= 2;
        if (eligible) {
          eligibleFloors.push(cp.floor);

          const rank = classifyRank(cp.conv, cp.margin, holds, cp.oppCount);
          rankAtCp.push({ label: cp.label, rank, floor: cp.floor, margin: cp.margin, conv: cp.conv, holds });

          const RANK_ORDER = { C: 0, B: 1, A: 2 };
          if (RANK_ORDER[rank] > RANK_ORDER[peakRank]) {
            peakRank = rank;
            graduationCp = cp.label;
            graduationFloor = cp.floor;
            graduationMargin = cp.margin;
          }
          if (rank === peakRank) peakCps++;
        }
      } else {
        holds = 0; // reset holds when opponent has control

        // Track opponent graduation
        const oppEligible = cp.floor >= 0.60 && cp.margin >= 2;
        if (oppEligible) {
          oppEligibleCps++;
          // For opponent, compute their conviction (they're the ctrl team at this cp)
          const oppRank = classifyRank(cp.conv, cp.margin, oppEligibleCps, cp.indicatorsWon.length);
          const OPP_RANK_ORDER = { C: 0, B: 1, A: 2 };
          if (OPP_RANK_ORDER[oppRank] > OPP_RANK_ORDER[oppPeakRank]) {
            oppPeakRank = oppRank;
          }
        }
      }
    }

    const meanFloor = eligibleFloors.length > 0
      ? eligibleFloors.reduce((a, b) => a + b, 0) / eligibleFloors.length : null;
    const minFloor = eligibleFloors.length > 0 ? Math.min(...eligibleFloors) : null;

    const bothGrad = peakRank !== 'C' && oppPeakRank !== 'C';
    const isWtw = ctrlFlips === 0;

    results.push({
      game_id: game.game_id, matchup: game.matchup, winner: gameWinner,
      finalMargin: game.margin, isClose: Math.abs(game.margin) <= 8,
      bwcTeam, bwcWon, checkpoints: cpData.length,
      bwcEligibleCps: eligibleFloors.length, meanFloor, minFloor,
      watermark: peakRank, peakCps, graduationCp, graduationFloor, graduationMargin,
      ctrlFlips, isWtw, bothGrad, oppPeakRank,
      rankHistory: rankAtCp,
    });
  }

  // ═══════════════════════════════════════════════════════
  // REPORT
  // ═══════════════════════════════════════════════════════

  const withBwc = results.filter(r => r.bwcTeam);
  const noBwc = results.filter(r => !r.bwcTeam);
  const graduated = withBwc.filter(r => r.watermark === 'A' || r.watermark === 'B');
  const closeAll = withBwc.filter(r => r.isClose);
  const closeGrad = graduated.filter(r => r.isClose);

  console.log(`%c\n═══ RESULTS: ${results.length} games (${withBwc.length} BWC, ${noBwc.length} no BWC) ═══`, 'color: gold; font-size: 14px; font-weight: bold');

  // Helper
  function bucket(games, label) {
    const w = games.filter(g => g.bwcWon).length;
    const cl = games.filter(g => g.isClose);
    const clw = cl.filter(g => g.bwcWon).length;
    console.log(`  ${label}: ${w}/${games.length} = ${games.length > 0 ? (w/games.length*100).toFixed(1) : 'N/A'}% full | ${clw}/${cl.length} = ${cl.length > 0 ? (clw/cl.length*100).toFixed(1) : 'N/A'}% close`);
  }

  // ── Section 1: Watermark tier win rate (3-min checkpoints) ──
  console.log('%c\nWATERMARK TIER WIN RATE — 3-MIN CHECKPOINTS', 'color: cyan; font-weight: bold');
  for (const tier of ['A', 'B', 'C']) {
    bucket(withBwc.filter(g => g.watermark === tier || (tier === 'A' && g.isWtw && g.watermark === 'A')), `${tier}-tier`);
  }
  // S-tier (wire-to-wire + A)
  const sTier = withBwc.filter(g => g.watermark === 'A' && g.isWtw);
  if (sTier.length > 0) bucket(sTier, 'S-tier (wire-to-wire A)');

  // ── Section 2: Mean floor buckets ──
  console.log('%c\nMEAN FLOOR BUCKETS (BWC teams only)', 'color: cyan; font-weight: bold');
  const mfBuckets = [
    { label: '<0.60', test: mf => mf < 0.60 },
    { label: '0.60-0.69', test: mf => mf >= 0.60 && mf < 0.70 },
    { label: '0.70-0.79', test: mf => mf >= 0.70 && mf < 0.80 },
    { label: '0.80-0.89', test: mf => mf >= 0.80 && mf < 0.90 },
    { label: '0.90+', test: mf => mf >= 0.90 },
  ];
  for (const b of mfBuckets) {
    bucket(withBwc.filter(g => g.meanFloor != null && b.test(g.meanFloor)), `Mean floor ${b.label}`);
  }

  // ── Section 3: Min floor buckets ──
  console.log('%c\nMIN FLOOR BUCKETS (BWC teams only)', 'color: cyan; font-weight: bold');
  for (const b of mfBuckets) {
    bucket(withBwc.filter(g => g.minFloor != null && b.test(g.minFloor)), `Min floor ${b.label}`);
  }

  // ── Section 4: Checkpoint persistence at peak tier ──
  console.log('%c\nPEAK TIER PERSISTENCE (graduated games only)', 'color: cyan; font-weight: bold');
  const persBuckets = [
    { label: '1 cp', test: p => p === 1 },
    { label: '2-3 cp', test: p => p >= 2 && p <= 3 },
    { label: '4-5 cp', test: p => p >= 4 && p <= 5 },
    { label: '6+ cp', test: p => p >= 6 },
  ];
  for (const b of persBuckets) {
    bucket(graduated.filter(g => b.test(g.peakCps)), b.label);
  }

  // ── Section 5: Mean floor × tier ──
  console.log('%c\nMEAN FLOOR × TIER (graduated games)', 'color: cyan; font-weight: bold');
  for (const tier of ['A', 'B']) {
    for (const mf of [0.70, 0.75, 0.80]) {
      const g = graduated.filter(r => r.watermark === tier && r.meanFloor >= mf);
      bucket(g, `${tier}-tier + MF≥${mf.toFixed(2)}`);
    }
  }

  // ── Section 6: Mean floor × checkpoint count ──
  console.log('%c\nMEAN FLOOR × CHECKPOINT COUNT (graduated)', 'color: cyan; font-weight: bold');
  for (const mf of [0.70, 0.75, 0.80]) {
    for (const cp of [2, 3, 4]) {
      const g = graduated.filter(r => r.meanFloor >= mf && r.peakCps >= cp);
      bucket(g, `MF≥${mf.toFixed(2)} + ${cp}+ cp at peak`);
    }
  }

  // ── Section 7: Both graduated suppression ──
  console.log('%c\nBOTH-GRADUATED SUPPRESSION', 'color: cyan; font-weight: bold');
  const bothGrad = withBwc.filter(g => g.bothGrad);
  const singleGrad = graduated.filter(g => !g.bothGrad);
  bucket(bothGrad, 'Both teams graduated');
  bucket(singleGrad, 'Only BWC team graduated');

  // ── Section 8: Graduation timing ──
  console.log('%c\nGRADUATION CHECKPOINT (when peak rank first reached)', 'color: cyan; font-weight: bold');
  const byCp = {};
  for (const g of graduated) {
    const cp = g.graduationCp || '?';
    if (!byCp[cp]) byCp[cp] = { n: 0, w: 0, cn: 0, cw: 0 };
    byCp[cp].n++;
    if (g.bwcWon) byCp[cp].w++;
    if (g.isClose) { byCp[cp].cn++; if (g.bwcWon) byCp[cp].cw++; }
  }
  for (const cp of CHECKPOINTS.map(c => c.label)) {
    const d = byCp[cp];
    if (!d || d.n === 0) continue;
    console.log(`  ${cp}: ${d.w}/${d.n} = ${(d.w/d.n*100).toFixed(1)}% full | ${d.cw}/${d.cn} = ${d.cn > 0 ? (d.cw/d.cn*100).toFixed(1) : 'N/A'}% close`);
  }

  // ── Section 9: BWC eligible checkpoints distribution ──
  console.log('%c\nBWC-ELIGIBLE CHECKPOINT COUNT', 'color: cyan; font-weight: bold');
  for (const ct of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const g = withBwc.filter(r => r.bwcEligibleCps >= ct);
    bucket(g, `${ct}+ eligible checkpoints`);
  }

  // ── Section 10: Close game detail ──
  console.log('%c\nCLOSE GAME DETAIL (margin ≤ 8)', 'color: yellow; font-weight: bold');
  for (const g of closeAll.sort((a,b) => (a.watermark||'Z').localeCompare(b.watermark||'Z'))) {
    console.log(
      `  ${g.bwcWon ? '✅' : '❌'} ${g.matchup} (${g.finalMargin}) | ` +
      `wm=${g.watermark} @ ${g.graduationCp || 'never'} | ` +
      `MF=${g.meanFloor?.toFixed(3)||'?'} minF=${g.minFloor?.toFixed(2)||'?'} | ` +
      `eligCps=${g.bwcEligibleCps} peakCps=${g.peakCps} flips=${g.ctrlFlips} | ` +
      `opp=${g.oppPeakRank} ${g.bothGrad ? '⚠BOTH' : ''}`
    );
  }

  // ── Payload ──
  const payload = {
    total_games: results.length,
    bwc_fired: withBwc.length, no_bwc: noBwc.length,
    checkpoint_count: CHECKPOINTS.length,
    checkpoint_interval: '3 min',
    tier_win_rate: {
      full: {},
      close: {},
    },
    mean_floor_buckets: {},
    persistence_buckets: {},
    mean_floor_x_tier: {},
    mean_floor_x_cp_count: {},
    graduation_timing: byCp,
  };
  for (const tier of ['A', 'B', 'C']) {
    const fg = withBwc.filter(r => r.watermark === tier);
    const cg = fg.filter(r => r.isClose);
    payload.tier_win_rate.full[tier] = { n: fg.length, w: fg.filter(r => r.bwcWon).length, pct: fg.length > 0 ? Math.round(fg.filter(r => r.bwcWon).length / fg.length * 1000) / 10 : null };
    payload.tier_win_rate.close[tier] = { n: cg.length, w: cg.filter(r => r.bwcWon).length, pct: cg.length > 0 ? Math.round(cg.filter(r => r.bwcWon).length / cg.length * 1000) / 10 : null };
  }
  for (const b of mfBuckets) {
    const fg = withBwc.filter(g => g.meanFloor != null && b.test(g.meanFloor));
    const cg = fg.filter(g => g.isClose);
    payload.mean_floor_buckets[b.label] = {
      full: { n: fg.length, w: fg.filter(r => r.bwcWon).length },
      close: { n: cg.length, w: cg.filter(r => r.bwcWon).length },
    };
  }

  console.log('%c\n📦 Full payload (copy for Claude):', 'color: magenta; font-weight: bold');
  console.log(JSON.stringify(payload, null, 2));

  return payload;
})();
}

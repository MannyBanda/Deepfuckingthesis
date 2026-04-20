// ═══════════════════════════════════════════════════════════
// WATERMARK GRADUATION BACKTEST — production replay (60s server snapshots)
// Replays BWC fire + graduation logic at 60s resolution
// Reports win% by watermark tier (peak rank ever reached)
// ═══════════════════════════════════════════════════════════
{
const BASE = '/.netlify/functions/db-api';
const OPTS = { credentials: 'include' };

async function api(params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${BASE}?${qs}`, OPTS);
  if (!r.ok) throw new Error(`${r.status} on ${params.action}`);
  return r.json();
}

// ── Replicated from poll-live-bdl.mjs ──────────────────────

function classifyRank(convictionTier, ctrlMargin, consecutiveHolds, oppIndicatorCount) {
  // NOTE: live code uses oppCount >= 3, backtest uses >= 2
  // Using live code version here to match what's actually running
  if (convictionTier === 'DOMINANT' && ctrlMargin >= 8
      && consecutiveHolds >= 4 && oppIndicatorCount <= 1) return 'A';
  if (oppIndicatorCount >= 3) return 'C';
  if ((convictionTier === 'DOMINANT' || convictionTier === 'STRONG')
      && ctrlMargin >= 3 && consecutiveHolds >= 2) return 'B';
  return 'C';
}

function computeConviction(i1, i2, i3, i4, i5, ctrlIsHome) {
  const scores = [
    { name: 'I1', raw: i1 },
    { name: 'I2', raw: i2 },
    { name: 'I3', raw: i3 },
    { name: 'I4', raw: i4 },
    { name: 'I5', raw: i5 },
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
  const hasI4I5 = has('I4', 'I5');
  const hasI3I4 = has('I3', 'I4');
  const hasI3I5 = has('I3', 'I5');
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
  console.log('%c═══ WATERMARK GRADUATION BACKTEST ═══', 'color: gold; font-size: 16px; font-weight: bold');

  // 1. Get all games with 10+ server snapshots
  console.log('Fetching game list from snapshot_diagnostic...');
  const diag = await api({ action: 'snapshot_diagnostic' });
  const allGames = diag.games || [];
  console.log(`Found ${allGames.length} games with 10+ server snapshots`);

  // Results accumulators
  const results = [];
  let fetched = 0;

  // 2. Process each game
  for (const game of allGames) {
    fetched++;
    if (fetched % 20 === 0) console.log(`  Processing ${fetched}/${allGames.length}...`);

    const histData = await api({ action: 'history', game_id: game.game_id });
    const allSnaps = (histData.snapshots || []).filter(s => s.source === 'server');
    if (allSnaps.length < 10) continue;

    // Sort chronologically
    allSnaps.sort((a, b) => new Date(a.ts) - new Date(b.ts));

    // ── Replay state machine ──
    let bwcCandidate = null;
    let bwcCandidateHolds = 0;
    let bwcFired = null;     // { team, period, clock, floor, snapIdx }
    let ctrlTeamCurrent = null;
    let ctrlTeamHolds = 0;
    let ctrlFlips = 0;

    // Graduation tracking (watermark)
    let graduation = {};  // team -> { rank, period, clock, floor, snapIdx }
    let oppGraduation = {};

    // PO tracking
    let poFired = null;
    let poSuppressedByBothGrad = false;

    // Floor tracking for mean floor calculation
    let bwcEligibleFloors = [];
    let allFloors = [];

    // Snapshot-level rank history
    let rankHistory = [];  // { snapIdx, rank, floor, margin, period, clock }

    const homeAlias = game.matchup.split('@')[1];
    const awayAlias = game.matchup.split('@')[0];

    for (let si = 0; si < allSnaps.length; si++) {
      const snap = allSnaps[si];
      const ctrlTeam = snap.floor_team;
      const floor = snap.floor_score;
      const period = snap.period;
      const clock = snap.clock || '';

      if (!ctrlTeam || floor == null) continue;

      const ctrlIsHome = ctrlTeam === homeAlias;
      const ctrlPts = ctrlIsHome ? snap.home_pts : snap.away_pts;
      const oppPts = ctrlIsHome ? snap.away_pts : snap.home_pts;
      const margin = ctrlPts - oppPts; // positive = ctrl leading

      allFloors.push(floor);

      // Update holds/flips
      if (ctrlTeamCurrent === ctrlTeam) {
        ctrlTeamHolds++;
      } else {
        ctrlTeamCurrent = ctrlTeam;
        ctrlTeamHolds = 1;
        if (ctrlTeamCurrent != null) ctrlFlips++;
      }

      // ── BWC candidate tracking ──
      if (!bwcFired && period >= 2 && floor >= 0.60 && margin >= 2) {
        if (bwcCandidate === ctrlTeam) {
          bwcCandidateHolds++;
        } else {
          bwcCandidate = ctrlTeam;
          bwcCandidateHolds = 1;
        }
        if (bwcCandidateHolds >= 3) {
          bwcFired = { team: ctrlTeam, period, clock, floor, snapIdx: si };
        }
      } else if (!bwcFired && ctrlTeam !== bwcCandidate) {
        bwcCandidate = null;
        bwcCandidateHolds = 0;
      }

      // ── Post-BWC: graduation tracking ──
      if (bwcFired && !poFired) {
        const bwcTeam = bwcFired.team;

        if (ctrlTeam === bwcTeam) {
          bwcEligibleFloors.push(floor);

          const conv = computeConviction(snap.i1, snap.i2, snap.i3, snap.i4, snap.i5, ctrlIsHome);
          // Opponent indicator count
          const oppCount = conv.indicatorsLost.length;

          const rank = classifyRank(conv.tier, margin, ctrlTeamHolds, oppCount);
          rankHistory.push({ snapIdx: si, rank, floor, margin, period, clock, conv: conv.tier, holds: ctrlTeamHolds, oppCount });

          if (!graduation[bwcTeam]) graduation[bwcTeam] = { rank: 'C' };
          const RANK_ORDER = { C: 0, B: 1, A: 2 };
          const prevRank = graduation[bwcTeam].rank;

          if (RANK_ORDER[rank] > RANK_ORDER[prevRank]) {
            graduation[bwcTeam] = { rank, period, clock, floor, margin, snapIdx: si, conv: conv.tier };
          }

          // Check PO fire
          const gRank = graduation[bwcTeam].rank;
          let poShouldFire = false;
          if (gRank === 'A') poShouldFire = true;
          if (gRank === 'B') {
            const cm = String(clock).match(/(\d+):(\d+)/);
            const clockSec = cm ? parseInt(cm[1]) * 60 + parseInt(cm[2]) : 720;
            const pastQ3_6 = period > 3 || (period === 3 && clockSec <= 360);
            if (pastQ3_6) poShouldFire = true;
          }

          // Only-one-grad check
          if (poShouldFire) {
            const oppTeamForPO = bwcTeam === homeAlias ? awayAlias : homeAlias;
            const oppGrad = graduation[oppTeamForPO];
            if (oppGrad && (oppGrad.rank === 'B' || oppGrad.rank === 'A')) {
              poShouldFire = false;
              poSuppressedByBothGrad = true;
            }
          }

          if (poShouldFire) {
            const isWireToWire = ctrlFlips === 0;
            const poRank = (gRank === 'A' && isWireToWire) ? 'S' : gRank;
            poFired = { team: bwcTeam, rank: poRank, period, clock, floor, snapIdx: si };
          }
        }

        // ── Opponent graduation tracking ──
        if (ctrlTeam !== bwcFired.team) {
          const oppTeam = ctrlTeam;
          if (margin >= 2 && floor >= 0.60 && period >= 2) {
            if (!oppGraduation[oppTeam]) oppGraduation[oppTeam] = { holds: 0 };
            oppGraduation[oppTeam].holds++;

            if (oppGraduation[oppTeam].holds >= 3) {
              const oppConv = computeConviction(snap.i1, snap.i2, snap.i3, snap.i4, snap.i5, ctrlIsHome);
              const oppOppCount = oppConv.indicatorsLost.length;
              const oppRank = classifyRank(oppConv.tier, margin, oppGraduation[oppTeam].holds, oppOppCount);

              if (oppRank === 'B' || oppRank === 'A') {
                if (!graduation[oppTeam]) graduation[oppTeam] = { rank: 'C' };
                const RANK_ORDER2 = { C: 0, B: 1, A: 2 };
                if (RANK_ORDER2[oppRank] > (RANK_ORDER2[graduation[oppTeam].rank] || 0)) {
                  graduation[oppTeam] = { rank: oppRank, period, clock, floor, margin, snapIdx: si };
                }
              }
            }
          } else {
            if (oppGraduation[oppTeam]) oppGraduation[oppTeam].holds = 0;
          }
        }
      }
    }

    // ── Determine outcome ──
    // Derive winner from margin (home-relative) when winner field is null
    let gameWinner = game.winner;
    if (!gameWinner && game.margin != null && game.margin !== 0) {
      gameWinner = game.margin > 0 ? homeAlias : awayAlias;
    }
    const bwcTeam = bwcFired?.team || null;
    const bwcWon = bwcTeam != null && bwcTeam === gameWinner;
    const absFinalMargin = Math.abs(game.margin || 0);
    const isClose = absFinalMargin <= 8;

    // Peak watermark rank
    const watermark = bwcTeam ? (graduation[bwcTeam]?.rank || 'C') : null;

    // Mean floor across BWC-eligible snapshots
    const meanFloor = bwcEligibleFloors.length > 0
      ? bwcEligibleFloors.reduce((a, b) => a + b, 0) / bwcEligibleFloors.length
      : null;

    // How many snapshots held peak rank criteria?
    const peakRankSnaps = rankHistory.filter(r => r.rank === watermark).length;
    const totalRankSnaps = rankHistory.length;

    // Time from BWC fire to graduation (in snapshots = ~minutes)
    const gradSnap = bwcTeam && graduation[bwcTeam]?.snapIdx != null ? graduation[bwcTeam].snapIdx : null;
    const bwcSnapIdx = bwcFired?.snapIdx || null;
    const snapsToGrad = (gradSnap != null && bwcSnapIdx != null && watermark !== 'C')
      ? gradSnap - bwcSnapIdx : null;

    // Did both teams graduate?
    const oppTeam = bwcTeam === homeAlias ? awayAlias : homeAlias;
    const bothGraduated = graduation[bwcTeam]?.rank &&
      graduation[oppTeam]?.rank &&
      graduation[bwcTeam].rank !== 'C' &&
      graduation[oppTeam].rank !== 'C';

    results.push({
      game_id: game.game_id,
      matchup: game.matchup,
      winner: gameWinner,
      winnerDerived: !game.winner && !!gameWinner,
      finalMargin: game.margin,
      isClose,
      serverSnaps: allSnaps.length,
      bwcTeam,
      bwcWon,
      bwcFirePeriod: bwcFired?.period,
      bwcFireFloor: bwcFired?.floor,
      watermark,
      watermarkPeriod: graduation[bwcTeam]?.period,
      watermarkClock: graduation[bwcTeam]?.clock,
      watermarkFloor: graduation[bwcTeam]?.floor,
      watermarkMargin: graduation[bwcTeam]?.margin,
      watermarkConv: graduation[bwcTeam]?.conv,
      meanFloor: meanFloor != null ? Math.round(meanFloor * 1000) / 1000 : null,
      peakRankSnaps,
      totalRankSnaps,
      snapsToGrad,
      poFired: poFired ? poFired.rank : null,
      poSuppressedByBothGrad,
      bothGraduated,
      ctrlFlips,
    });
  }

  // ═══════════════════════════════════════════════════════
  // REPORT
  // ═══════════════════════════════════════════════════════

  const withBwc = results.filter(r => r.bwcTeam && r.winner);
  const withBwcNoWinner = results.filter(r => r.bwcTeam && !r.winner);
  const noBwc = results.filter(r => !r.bwcTeam);
  const derivedWinners = results.filter(r => r.winnerDerived).length;

  console.log(`%c\n═══ RESULTS: ${results.length} games (${withBwc.length} BWC+resolved, ${withBwcNoWinner.length} BWC unresolved, ${noBwc.length} no BWC, ${derivedWinners} winners derived from margin) ═══`, 'color: gold; font-size: 14px; font-weight: bold');

  // ── Section 1: Watermark tier win rates ──
  function tierStats(games, label) {
    const tiers = { S: { n: 0, w: 0 }, A: { n: 0, w: 0 }, B: { n: 0, w: 0 }, C: { n: 0, w: 0 } };
    for (const g of games) {
      if (!g.watermark) continue;
      const t = g.watermark === 'A' && g.ctrlFlips === 0 ? 'S' : g.watermark;
      tiers[t].n++;
      if (g.bwcWon) tiers[t].w++;
    }
    console.log(`%c\n${label}`, 'color: cyan; font-weight: bold');
    for (const [t, d] of Object.entries(tiers)) {
      if (d.n === 0) continue;
      console.log(`  ${t}-tier: ${d.w}/${d.n} = ${(d.w/d.n*100).toFixed(1)}%`);
    }
    return tiers;
  }

  const fullTiers = tierStats(withBwc, 'WATERMARK TIER WIN RATE — FULL (all games with BWC fire)');
  const closeGames = withBwc.filter(g => g.isClose);
  const closeTiers = tierStats(closeGames, 'WATERMARK TIER WIN RATE — CLOSE (final margin ≤ 8)');

  // ── Section 2: Single snapshot qualification ──
  console.log('%c\nSINGLE-SNAP vs SUSTAINED QUALIFICATION', 'color: cyan; font-weight: bold');
  const graduated = withBwc.filter(g => g.watermark === 'A' || g.watermark === 'B');
  const singleSnap = graduated.filter(g => g.peakRankSnaps === 1);
  const multiSnap = graduated.filter(g => g.peakRankSnaps >= 2);
  const sustained5 = graduated.filter(g => g.peakRankSnaps >= 5);
  const sustained10 = graduated.filter(g => g.peakRankSnaps >= 10);

  function bucket(games, label) {
    const w = games.filter(g => g.bwcWon).length;
    const cl = games.filter(g => g.isClose);
    const clw = cl.filter(g => g.bwcWon).length;
    console.log(`  ${label}: ${w}/${games.length} = ${games.length > 0 ? (w/games.length*100).toFixed(1) : 'N/A'}% full | ${clw}/${cl.length} = ${cl.length > 0 ? (clw/cl.length*100).toFixed(1) : 'N/A'}% close`);
  }

  bucket(singleSnap, 'Held peak rank 1 snap only (fired on spike)');
  bucket(multiSnap, 'Held peak rank 2+ snaps');
  bucket(sustained5, 'Held peak rank 5+ snaps (~5 min)');
  bucket(sustained10, 'Held peak rank 10+ snaps (~10 min)');

  // ── Section 3: Mean floor at graduation ──
  console.log('%c\nMEAN FLOOR vs WATERMARK FLOOR (at graduation moment)', 'color: cyan; font-weight: bold');
  for (const g of graduated) {
    const delta = g.meanFloor != null && g.watermarkFloor != null
      ? (g.watermarkFloor - g.meanFloor).toFixed(3) : '?';
    if (g.isClose) {
      console.log(`  ${g.matchup}: watermark=${g.watermark} floor@grad=${g.watermarkFloor?.toFixed(2)} meanFloor=${g.meanFloor?.toFixed(3)} delta=${delta} margin@grad=${g.watermarkMargin} → ${g.bwcWon ? '✅' : '❌'} (final ${g.finalMargin})`);
    }
  }

  // ── Section 4: Mean floor buckets ──
  console.log('%c\nMEAN FLOOR BUCKETS (graduated games only)', 'color: cyan; font-weight: bold');
  const mfBuckets = [
    { label: '<0.60', test: mf => mf < 0.60 },
    { label: '0.60-0.69', test: mf => mf >= 0.60 && mf < 0.70 },
    { label: '0.70-0.79', test: mf => mf >= 0.70 && mf < 0.80 },
    { label: '0.80-0.89', test: mf => mf >= 0.80 && mf < 0.90 },
    { label: '0.90+', test: mf => mf >= 0.90 },
  ];
  for (const b of mfBuckets) {
    const bg = graduated.filter(g => g.meanFloor != null && b.test(g.meanFloor));
    bucket(bg, `Mean floor ${b.label}`);
  }

  // ── Section 5: Time to graduation ──
  console.log('%c\nTIME TO GRADUATION (snapshots from BWC fire)', 'color: cyan; font-weight: bold');
  const timeBuckets = [
    { label: '0-5 snaps (instant)', test: s => s >= 0 && s <= 5 },
    { label: '6-15 snaps (~6-15 min)', test: s => s >= 6 && s <= 15 },
    { label: '16-30 snaps (~16-30 min)', test: s => s >= 16 && s <= 30 },
    { label: '31+ snaps (30+ min)', test: s => s >= 31 },
  ];
  for (const b of timeBuckets) {
    const bg = graduated.filter(g => g.snapsToGrad != null && b.test(g.snapsToGrad));
    bucket(bg, b.label);
  }

  // ── Section 6: Both-graduated suppression ──
  console.log('%c\nBOTH-GRADUATED SUPPRESSION (only_one_grad)', 'color: cyan; font-weight: bold');
  const bothGrad = withBwc.filter(g => g.bothGraduated);
  const singleGrad = withBwc.filter(g => !g.bothGraduated && (g.watermark === 'A' || g.watermark === 'B'));
  bucket(bothGrad, 'Both teams graduated (PO would be suppressed)');
  bucket(singleGrad, 'Only BWC team graduated (PO fires)');

  const poSuppressed = withBwc.filter(g => g.poSuppressedByBothGrad);
  bucket(poSuppressed, 'PO actually suppressed by only_one_grad');

  // ── Section 7: Graduation period distribution ──
  console.log('%c\nGRADUATION PERIOD (when watermark was set)', 'color: cyan; font-weight: bold');
  const byPeriod = {};
  for (const g of graduated) {
    const p = g.watermarkPeriod || '?';
    if (!byPeriod[p]) byPeriod[p] = { n: 0, w: 0, close_n: 0, close_w: 0 };
    byPeriod[p].n++;
    if (g.bwcWon) byPeriod[p].w++;
    if (g.isClose) { byPeriod[p].close_n++; if (g.bwcWon) byPeriod[p].close_w++; }
  }
  for (const [p, d] of Object.entries(byPeriod).sort((a,b) => a[0] - b[0])) {
    console.log(`  Q${p}: ${d.w}/${d.n} = ${(d.w/d.n*100).toFixed(1)}% full | ${d.close_w}/${d.close_n} = ${d.close_n > 0 ? (d.close_w/d.close_n*100).toFixed(1) : 'N/A'}% close`);
  }

  // ── Section 8: Full game detail for close games ──
  console.log('%c\nCLOSE GAME DETAIL (margin ≤ 8)', 'color: yellow; font-weight: bold');
  for (const g of closeGames.sort((a,b) => (a.watermark||'Z').localeCompare(b.watermark||'Z'))) {
    console.log(
      `  ${g.bwcWon ? '✅' : '❌'} ${g.matchup} (${g.finalMargin}) | ` +
      `wm=${g.watermark} Q${g.watermarkPeriod||'?'} ${g.watermarkClock||''} | ` +
      `floor@grad=${g.watermarkFloor?.toFixed(2)||'?'} mean=${g.meanFloor?.toFixed(3)||'?'} | ` +
      `peakSnaps=${g.peakRankSnaps}/${g.totalRankSnaps} | ` +
      `snapsToGrad=${g.snapsToGrad ?? '?'} flips=${g.ctrlFlips} | ` +
      `PO=${g.poFired || (g.poSuppressedByBothGrad ? 'SUPPRESSED' : 'none')}`
    );
  }

  // ── Payload ──
  const payload = {
    total_games: results.length,
    bwc_fired: withBwc.length,
    no_bwc: noBwc.length,
    full_season: {
      S: { n: fullTiers.S.n, w: fullTiers.S.w, pct: fullTiers.S.n > 0 ? Math.round(fullTiers.S.w / fullTiers.S.n * 1000) / 10 : null },
      A: { n: fullTiers.A.n, w: fullTiers.A.w, pct: fullTiers.A.n > 0 ? Math.round(fullTiers.A.w / fullTiers.A.n * 1000) / 10 : null },
      B: { n: fullTiers.B.n, w: fullTiers.B.w, pct: fullTiers.B.n > 0 ? Math.round(fullTiers.B.w / fullTiers.B.n * 1000) / 10 : null },
      C: { n: fullTiers.C.n, w: fullTiers.C.w, pct: fullTiers.C.n > 0 ? Math.round(fullTiers.C.w / fullTiers.C.n * 1000) / 10 : null },
    },
    close_games: {
      S: { n: closeTiers.S.n, w: closeTiers.S.w, pct: closeTiers.S.n > 0 ? Math.round(closeTiers.S.w / closeTiers.S.n * 1000) / 10 : null },
      A: { n: closeTiers.A.n, w: closeTiers.A.w, pct: closeTiers.A.n > 0 ? Math.round(closeTiers.A.w / closeTiers.A.n * 1000) / 10 : null },
      B: { n: closeTiers.B.n, w: closeTiers.B.w, pct: closeTiers.B.n > 0 ? Math.round(closeTiers.B.w / closeTiers.B.n * 1000) / 10 : null },
      C: { n: closeTiers.C.n, w: closeTiers.C.w, pct: closeTiers.C.n > 0 ? Math.round(closeTiers.C.w / closeTiers.C.n * 1000) / 10 : null },
    },
    single_snap_qualification: {
      one_snap: { n: singleSnap.length, w: singleSnap.filter(g => g.bwcWon).length },
      two_plus: { n: multiSnap.length, w: multiSnap.filter(g => g.bwcWon).length },
      five_plus: { n: sustained5.length, w: sustained5.filter(g => g.bwcWon).length },
      ten_plus: { n: sustained10.length, w: sustained10.filter(g => g.bwcWon).length },
    },
    both_grad_suppression: {
      both_graduated: { n: bothGrad.length, w: bothGrad.filter(g => g.bwcWon).length },
      single_graduated: { n: singleGrad.length, w: singleGrad.filter(g => g.bwcWon).length },
    },
    close_game_detail: closeGames.map(g => ({
      matchup: g.matchup, winner: g.winner, margin: g.finalMargin,
      bwcTeam: g.bwcTeam, bwcWon: g.bwcWon, watermark: g.watermark,
      wmPeriod: g.watermarkPeriod, wmFloor: g.watermarkFloor,
      meanFloor: g.meanFloor, peakRankSnaps: g.peakRankSnaps,
      totalRankSnaps: g.totalRankSnaps, snapsToGrad: g.snapsToGrad,
      ctrlFlips: g.ctrlFlips, poFired: g.poFired,
      poSuppressed: g.poSuppressedByBothGrad,
    })),
  };

  console.log('%c\n📦 Full payload (copy for Claude):', 'color: magenta; font-weight: bold');
  console.log(JSON.stringify(payload, null, 2));

  return payload;
})();
}

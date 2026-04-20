// ═══════════════════════════════════════════════════════════
// CHECKPOINT GRADUATION — PRODUCTION TEST
// Tests new checkpoint system against actual server snapshots
// Paste in browser console on the live site
// ═══════════════════════════════════════════════════════════

// Wrap in block to allow re-running in console without duplicate variable errors
{
const BASE = '/.netlify/functions/db-api';
const OPTS = { credentials: 'include' };
const api = (p) => fetch(`${BASE}?${new URLSearchParams(p)}`, OPTS).then(r => r.json());

// Target game IDs from find-games output
const TARGET_IDS = [
  '2b1ba3cc-4320-4962-a9c9-30c0ed2440d2', // 4/19 ORL@DET
  '994f3d3d-f04d-4c5e-98b8-77b5954427da', // 4/18 MIN@DEN
  '61752cf5-1d7f-4fb7-b85d-2722da32b2fa', // 4/17 CHA@ORL
  'ea840c07-415b-4b90-af7b-50215fd27298', // 4/15 GSW@LAC
  '34b37d8e-01cf-4bae-a587-0390d92c608d', // 4/14 MIA@CHA
  '0342c2c0-8e36-42cc-b94f-261d506a3b43', // 4/12 GSW@LAC
  'a0040e4a-eb7e-4418-95cb-78c648409f54', // 4/12 SAC@POR
  'e5153cd6-6fe8-4ccf-b79f-b2f914cd0a05', // 4/10 DET@CHA
  '7710d87d-045b-47a2-ac65-0d6986d1940c', // 4/10 GSW@SAC
  '79cb32a3-f81c-4fc5-a1d3-c57461571a41', // 4/10 LAC@POR
  'b86258f8-5a21-4e9d-a47e-73fc1069e2b6', // 4/08 MIN@ORL
  '4a71e4ff-b87f-4f96-993c-9bc5f9de1e4f', // 4/07 SAC@GSW
  '60cbdd09-6580-4104-88f9-8fe02cd82941', // 4/06 DET@ORL
  'f98b9fa2-83b6-4bc5-9d2c-cb55d090fbb5', // 4/06 POR@DEN
  '17c21a9d-c79b-45f2-903d-7e8a54641ed5', // 4/05 CHA@MIN
  'f89877ff-7b5c-45c2-b183-17a4ef9f5958', // 4/05 LAC@SAC
  '4c101604-7c7a-4045-a7e3-2e2b553051d2', // 4/02 MIN@DET
  'c17822f4-645a-4592-b12d-d0b7ec35d9b9', // 3/31 POR@LAC
  '98879e14-a9f6-40a6-8f42-a18a547b123d', // 3/29 GSW@DEN
  '5d769996-9202-4ea9-95a6-405247dc7367', // 3/28 DET@MIN
  'cf480984-d107-4e41-b90e-0f9e8df851eb', // 3/26 SAC@ORL
  '731b93e6-2ae9-4c28-8d00-c7a2b0e01a42', // 3/20 GSW@DET
  '5ef740fc-f02c-4cb2-9a3c-5b3550801bbf', // 3/19 ORL@CHA
];

// ── CHECKPOINT BOUNDARIES ──
const GRAD_CHECKPOINTS = [
  { label: 'Q1_END', period: 1, clockSec: 0,   gameSec: 720  },
  { label: 'Q2_9',   period: 2, clockSec: 540, gameSec: 900  },
  { label: 'Q2_6',   period: 2, clockSec: 360, gameSec: 1080 },
  { label: 'Q2_3',   period: 2, clockSec: 180, gameSec: 1260 },
  { label: 'Q2_END', period: 2, clockSec: 0,   gameSec: 1440 },
  { label: 'Q3_9',   period: 3, clockSec: 540, gameSec: 1620 },
  { label: 'Q3_6',   period: 3, clockSec: 360, gameSec: 1800 },
  { label: 'Q3_3',   period: 3, clockSec: 180, gameSec: 1980 },
  { label: 'Q3_END', period: 3, clockSec: 0,   gameSec: 2160 },
  { label: 'Q4_9',   period: 4, clockSec: 540, gameSec: 2340 },
  { label: 'Q4_6',   period: 4, clockSec: 360, gameSec: 2520 },
  { label: 'Q4_3',   period: 4, clockSec: 180, gameSec: 2700 },
];

// ── LANE THRESHOLDS (updated spec boundaries) ──
const LANE_THRESHOLDS = {
  underdog:       { mfGate: 0.70, minFGate: 0.58 },
  tossup:         { mfGate: 0.75, minFGate: 0.58 },
  favorite:       { mfGate: 0.72, minFGate: 0.58 },
  heavy_favorite: { mfGate: 0.80, minFGate: 0.58 },
};

function classifyLane(ml) {
  if (ml == null) return 'tossup';
  if (ml > 100) return 'underdog';
  if (ml >= -150) return 'tossup';
  if (ml >= -300) return 'favorite';
  return 'heavy_favorite';
}

function computeConviction(i1, i2, i3, i4, i5, ctrlIsHome) {
  const scores = { I1: i1, I2: i2, I3: i3, I4: i4, I5: i5 };
  const wins = [], loses = [];
  for (const [key, raw] of Object.entries(scores)) {
    if (raw == null) continue;
    const ctrlScore = ctrlIsHome ? raw : 1 - raw;
    if (ctrlScore > 0.5) wins.push(key);
    else if (ctrlScore < 0.5) loses.push(key);
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
  return { tier, count, indicatorsWon: wins, indicatorsLost: loses };
}

function classifyRank(convictionTier, ctrlMargin, consecutiveHolds, oppIndicatorCount) {
  if (convictionTier === 'DOMINANT' && ctrlMargin >= 8
      && consecutiveHolds >= 4 && oppIndicatorCount <= 1) return 'A';
  if (oppIndicatorCount >= 3) return 'C';
  if ((convictionTier === 'DOMINANT' || convictionTier === 'STRONG')
      && ctrlMargin >= 3 && consecutiveHolds >= 2) return 'B';
  return 'C';
}

function clockToSec(clock) {
  const m = String(clock).match(/(\d+):(\d+)/);
  return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 720;
}

function toGameSec(period, clock) {
  return (period - 1) * 720 + (720 - clockToSec(clock));
}

// ═══ MAIN ═══
(async () => {
  console.log('%c═══ CHECKPOINT GRADUATION — PRODUCTION TEST ═══', 'color: gold; font-size: 16px; font-weight: bold');
  console.log(`Testing ${TARGET_IDS.length} games\n`);

  // Get game metadata
  const { games: allGames } = await api({ action: 'get_games', league: 'nba' });
  const gameMap = {};
  allGames.forEach(g => { gameMap[g.id] = g; });

  const results = [];

  // ── Pre-fetch all alerts by unique date (batch to minimize API calls) ──
  const uniqueDates = [...new Set(TARGET_IDS.map(gid => gameMap[gid]?.date).filter(Boolean))];
  const alertsByGame = {};
  for (const date of uniqueDates) {
    try {
      const alertData = await api({ action: 'get_alerts', date, league: 'nba' });
      (alertData.alerts || []).forEach(a => {
        if (!alertsByGame[a.game_id]) alertsByGame[a.game_id] = [];
        alertsByGame[a.game_id].push(a);
      });
    } catch (e) { /* alerts may not exist for older dates */ }
  }
  console.log(`Loaded alerts for ${uniqueDates.length} dates\n`);

  for (const gid of TARGET_IDS) {
    const game = gameMap[gid];
    if (!game) { console.log(`Game ${gid}: not found, skipping`); continue; }

    const hA = game.home_alias;
    const aA = game.away_alias;
    const matchup = `${aA}@${hA}`;

    // Derive winner from pts if winner column is null
    let winner = game.winner;
    if (!winner && game.home_pts && game.away_pts) {
      winner = game.home_pts > game.away_pts ? hA : aA;
    }
    const finalMargin = game.margin != null ? Math.abs(game.margin)
      : (game.home_pts && game.away_pts ? Math.abs(game.home_pts - game.away_pts) : null);

    // Fetch snapshots + odds
    const [snapData, oddsData] = await Promise.all([
      api({ action: 'history', game_id: gid }),
      api({ action: 'get_odds', game_id: gid }),
    ]);

    const serverSnaps = (snapData.snapshots || []).filter(s => s.source === 'server');
    if (serverSnaps.length < 10) {
      console.log(`${matchup} (${game.date}): only ${serverSnaps.length} server snaps, skipping`);
      continue;
    }

    // Derive winner from final snapshot if still unknown
    if (!winner && serverSnaps.length > 0) {
      const last = serverSnaps[serverSnaps.length - 1];
      if (last.home_pts != null && last.away_pts != null) {
        winner = last.home_pts > last.away_pts ? hA : aA;
      }
    }

    const odds = (oddsData.odds || []);
    const firstOdds = odds[0] || {};

    // ── Simulate checkpoint graduation ──
    let bwcFired = null;
    let bwcCandidate = null, bwcCandidateHolds = 0;
    let cpHolds = 0, cpOppHolds = 0;
    let cpPeakRank = 'C';
    let cpGraduation = null, cpOppGraduation = null;
    let nextCpIdx = 0;
    let checkpoints = [];
    let ctrlTeamCurrent = null, ctrlTeamHolds = 0, ctrlFlips = 0;
    let poFired = null;
    let pregameML = null, lane = null;
    let poBlockLog = [];

    for (const snap of serverSnaps) {
      const period = snap.period;
      const clock = snap.clock;
      const floor = snap.floor_score;
      const ctrlTeam = snap.floor_team;
      const ctrlIsHome = ctrlTeam === hA;
      const ctrlPts = ctrlIsHome ? snap.home_pts : snap.away_pts;
      const oppPts = ctrlIsHome ? snap.away_pts : snap.home_pts;
      const margin = ctrlPts - oppPts;

      // Track holds
      if (ctrlTeam === ctrlTeamCurrent) { ctrlTeamHolds++; }
      else { ctrlTeamCurrent = ctrlTeam; ctrlTeamHolds = 1; ctrlFlips++; }

      // BWC candidate (3 holds, period >= 2, floor >= 0.60, margin >= 2)
      if (!bwcFired && period >= 2 && floor >= 0.60 && margin >= 2) {
        if (bwcCandidate === ctrlTeam) { bwcCandidateHolds++; }
        else { bwcCandidate = ctrlTeam; bwcCandidateHolds = 1; }
        if (bwcCandidateHolds >= 3) {
          bwcFired = { team: ctrlTeam, period, clock, floor };
        }
      } else if (!bwcFired && ctrlTeam !== bwcCandidate) {
        bwcCandidate = null; bwcCandidateHolds = 0;
      }

      if (!bwcFired) continue;

      // Capture pregame ML once
      if (pregameML == null && firstOdds.home_ml != null) {
        const bwcIsHome = bwcFired.team === hA;
        pregameML = bwcIsHome ? parseInt(firstOdds.home_ml) : parseInt(firstOdds.away_ml);
        lane = classifyLane(pregameML);
      }

      const bwcTeam = bwcFired.team;
      const currentGameSec = toGameSec(period, clock);

      // ── Checkpoint capture ──
      while (nextCpIdx < GRAD_CHECKPOINTS.length) {
        const nextCp = GRAD_CHECKPOINTS[nextCpIdx];
        if (currentGameSec < nextCp.gameSec) break;

        const conv = computeConviction(snap.i1, snap.i2, snap.i3, snap.i4, snap.i5, ctrlIsHome);
        const oppCount = conv.indicatorsLost.length;

        const cpEntry = {
          label: nextCp.label, floor, team: ctrlTeam, margin,
          conv: conv.tier, oppCount, winsStr: conv.indicatorsWon.join('+') || '-',
          period, clock,
        };
        checkpoints.push(cpEntry);

        // Checkpoint holds
        if (ctrlTeam === bwcTeam) { cpHolds++; cpOppHolds = 0; }
        else {
          cpHolds = 0;
          cpOppHolds = (margin >= 2 && floor >= 0.60) ? cpOppHolds + 1 : 0;
        }

        // BWC team rank classification
        if (ctrlTeam === bwcTeam && margin >= 2 && floor >= 0.60) {
          const cpRank = classifyRank(conv.tier, margin, cpHolds, oppCount);
          const RANK_ORDER = { C: 0, B: 1, A: 2 };
          if (RANK_ORDER[cpRank] > RANK_ORDER[cpPeakRank]) {
            cpPeakRank = cpRank;
            cpGraduation = { rank: cpRank, cp_label: nextCp.label, floor, margin, period, clock };
          }
        }

        // Opponent rank
        if (ctrlTeam !== bwcTeam && cpOppHolds >= 2 && margin >= 2 && floor >= 0.60) {
          const oppRank = classifyRank(conv.tier, margin, cpOppHolds, oppCount);
          if ((oppRank === 'B' || oppRank === 'A')) {
            const RANK_ORDER = { C: 0, B: 1, A: 2 };
            if (!cpOppGraduation || RANK_ORDER[oppRank] > RANK_ORDER[cpOppGraduation.rank]) {
              cpOppGraduation = { rank: oppRank, cp_label: nextCp.label, floor, margin };
            }
          }
        }

        // Mean floor / min floor from eligible checkpoints
        const eligible = checkpoints.filter(cp => cp.team === bwcTeam && cp.floor >= 0.60 && cp.margin >= 2);
        let meanFloor = null, minFloor = null;
        if (eligible.length > 0) {
          meanFloor = Math.round((eligible.reduce((s, cp) => s + cp.floor, 0) / eligible.length) * 1000) / 1000;
          minFloor = Math.round(Math.min(...eligible.map(cp => cp.floor)) * 1000) / 1000;
        }

        // ── PO evaluation ──
        if (cpGraduation && !poFired && ctrlTeam === bwcTeam) {
          const gRank = cpGraduation.rank;
          const gates = LANE_THRESHOLDS[lane || 'tossup'];
          let shouldFire = false, blockReason = null;

          if (gRank === 'A') {
            if (meanFloor >= gates.mfGate && minFloor >= gates.minFGate) shouldFire = true;
            else blockReason = `A-Rank but MF=${meanFloor?.toFixed(3)}/${gates.mfGate} minF=${minFloor?.toFixed(2)}/${gates.minFGate}`;
          }
          if (gRank === 'B') {
            const cs = clockToSec(clock);
            const pastQ3_6 = period > 3 || (period === 3 && cs <= 360);
            if (pastQ3_6 && meanFloor >= gates.mfGate && minFloor >= gates.minFGate) shouldFire = true;
            else if (!pastQ3_6) blockReason = `B-Rank needs Q3_6+ (at Q${period} ${clock})`;
            else blockReason = `B-Rank but MF=${meanFloor?.toFixed(3)}/${gates.mfGate} minF=${minFloor?.toFixed(2)}/${gates.minFGate}`;
          }
          if (gRank === 'C') blockReason = 'C-Rank (no PO)';

          // only_one_grad
          if (shouldFire && cpOppGraduation && (cpOppGraduation.rank === 'B' || cpOppGraduation.rank === 'A')) {
            shouldFire = false;
            blockReason = `both graduated — opp ${cpOppGraduation.rank} @ ${cpOppGraduation.cp_label}`;
          }

          if (shouldFire) {
            const isW2W = ctrlFlips <= 1;
            poFired = {
              team: bwcTeam, rank: (gRank === 'A' && isW2W) ? 'S' : gRank,
              period, clock, cp_label: nextCp.label,
              meanFloor, minFloor, lane, eligibleCPs: eligible.length,
            };
          } else if (blockReason) {
            poBlockLog.push({ cp: nextCp.label, reason: blockReason, mf: meanFloor, minF: minFloor });
          }
        }

        nextCpIdx++;
      }
    }

    // ── Output ──
    const bwcTeam = bwcFired?.team;
    const poCorrect = poFired ? poFired.team === winner : null;
    const bwcCorrect = bwcTeam ? bwcTeam === winner : null;
    const isCompetitive = finalMargin != null && finalMargin <= 8;

    // ── BUY / CANDIDATE alerts for this game ──
    const gameAlerts = alertsByGame[gid] || [];
    const buyAlerts = gameAlerts.filter(a => 
      a.alert_type === 'BUY' || a.alert_type === 'WINDOW BUY' || a.alert_type === 'BUY WINDOW CLOSING'
    );
    const buyData = buyAlerts.map(a => ({
      type: a.alert_type,
      tier: a.alert_tier || 'FIRED',
      team: a.control_team,
      period: a.period, clock: a.clock,
      floor: a.floor_score,
      decision: a.agent_decision,
      correct: a.correct,
      conviction: a.conviction,
      margin: a.margin,
    }));

    const result = {
      date: game.date, matchup, winner, finalMargin,
      competitive: isCompetitive,
      serverSnaps: serverSnaps.length,
      bwcTeam, bwcTime: bwcFired ? `Q${bwcFired.period} ${bwcFired.clock}` : null,
      bwcCorrect, lane, pregameML,
      cpsCaptured: checkpoints.length,
      eligibleCPs: checkpoints.filter(cp => cp.team === bwcTeam && cp.floor >= 0.60 && cp.margin >= 2).length,
      graduation: cpGraduation, oppGraduation: cpOppGraduation,
      po: poFired, poCorrect, poBlockLog, checkpoints,
      buyAlerts: buyData,
    };
    results.push(result);

    // Console output
    const tag = poFired ? (poCorrect ? '✅' : '❌') : (bwcFired ? '⬜ NO PO' : '🔇 NO BWC');
    const compTag = isCompetitive ? ' 🏀close' : '';
    console.log(`%c${game.date} ${matchup} → ${winner || '?'} by ${finalMargin ?? '?'}${compTag}`, 'color: cyan; font-weight: bold');
    if (bwcFired) {
      console.log(`  BWC: ${bwcTeam} Q${bwcFired.period} ${bwcFired.clock} (floor ${bwcFired.floor.toFixed(2)}) | Lane: ${lane} (ML ${pregameML ?? '?'}) | BWC ${bwcCorrect ? '✅' : '❌'}`);
    } else {
      console.log(`  No BWC fired`);
    }
    if (poFired) {
      console.log(`  ${tag} PO: ${poFired.rank}-Rank @ ${poFired.cp_label} Q${poFired.period} ${poFired.clock} | MF=${poFired.meanFloor.toFixed(3)} minF=${poFired.minFloor.toFixed(2)} | ${poFired.eligibleCPs} eligible CPs`);
    } else if (cpGraduation) {
      console.log(`  ${tag} — graduated ${cpGraduation.rank} @ ${cpGraduation.cp_label} but PO blocked`);
      poBlockLog.forEach(b => console.log(`    ⏳ ${b.cp}: ${b.reason}`));
    } else if (bwcFired) {
      console.log(`  ${tag} — never graduated (peak rank: ${cpPeakRank})`);
    }
    if (cpOppGraduation) {
      console.log(`  ⚠ OPP GRAD: ${cpOppGraduation.rank} @ ${cpOppGraduation.cp_label} (floor ${cpOppGraduation.floor.toFixed(2)}, margin ${cpOppGraduation.margin})`);
    }

    // BUY alerts
    if (buyData.length > 0) {
      const buyLine = buyData.map(b => {
        const typeShort = b.type === 'BUY' ? 'BUY' : b.type === 'WINDOW BUY' ? 'WB' : 'BWC';
        const tierTag = b.tier === 'CANDIDATE' ? '[C]' : '';
        const decTag = b.decision === 'SEND' ? '📤' : b.decision === 'SUPPRESS' ? '🚫' : '⬇️';
        const correctTag = b.correct === true ? '✅' : b.correct === false ? '❌' : '?';
        return `${typeShort}${tierTag} ${b.team} Q${b.period} ${b.clock} f${b.floor?.toFixed?.(2) || b.floor} m${b.margin} ${decTag}${b.decision} ${correctTag}`;
      }).join(' | ');
      console.log(`  📊 BUYS: ${buyLine}`);
    } else {
      console.log(`  📊 BUYS: none`);
    }

    // Checkpoint timeline (compact)
    if (checkpoints.length > 0) {
      const cpLine = checkpoints.map(cp => {
        const isBwc = cp.team === bwcTeam;
        return `${cp.label}:${isBwc ? '●' : '○'}${cp.floor.toFixed(2)}(m${cp.margin},${cp.conv.slice(0,3)})`;
      }).join(' → ');
      console.log(`  CPs: ${cpLine}`);
    }
    console.log('');
  }

  // ═══ SUMMARY ═══
  console.log('%c═══ SUMMARY ═══', 'color: gold; font-size: 14px; font-weight: bold');

  const withBwc = results.filter(r => r.bwcTeam);
  const withPO = results.filter(r => r.po);
  const poCorrectCount = withPO.filter(r => r.poCorrect).length;
  const noBwc = results.filter(r => !r.bwcTeam);
  const gradButBlocked = results.filter(r => r.graduation && !r.po);
  const competitive = results.filter(r => r.competitive);
  const compWithPO = competitive.filter(r => r.po);
  const compCorrect = compWithPO.filter(r => r.poCorrect).length;

  console.log(`Total games: ${results.length}`);
  console.log(`BWC fired: ${withBwc.length} | No BWC: ${noBwc.length}`);
  console.log(`PO fired: ${withPO.length}/${withBwc.length} BWC games`);
  console.log(`PO accuracy: ${poCorrectCount}/${withPO.length} (${withPO.length ? Math.round(poCorrectCount/withPO.length*100) : 0}%)`);
  console.log(`Graduated but blocked: ${gradButBlocked.length}`);
  gradButBlocked.forEach(r => {
    const wouldBeCorrect = r.bwcTeam === r.winner ? '(would have been ✅)' : '(would have been ❌)';
    console.log(`  ${r.matchup}: ${r.graduation.rank} @ ${r.graduation.cp_label} — ${r.poBlockLog.map(b => b.reason).join('; ')} ${wouldBeCorrect}`);
  });

  if (compWithPO.length > 0) {
    console.log(`\nCompetitive (margin ≤ 8): ${competitive.length} games`);
    console.log(`  PO fired: ${compWithPO.length} | Correct: ${compCorrect}/${compWithPO.length} (${Math.round(compCorrect/compWithPO.length*100)}%)`);
  }

  // BWC accuracy (did BWC team win?)
  const bwcCorrectCount = withBwc.filter(r => r.bwcCorrect).length;
  console.log(`\nBWC team won: ${bwcCorrectCount}/${withBwc.length} (${withBwc.length ? Math.round(bwcCorrectCount/withBwc.length*100) : 0}%)`);

  // Lane breakdown
  const byLane = {};
  for (const r of withBwc) {
    const l = r.lane || 'unknown';
    if (!byLane[l]) byLane[l] = { n: 0, po: 0, poCorrect: 0, bwcCorrect: 0 };
    byLane[l].n++;
    if (r.po) { byLane[l].po++; if (r.poCorrect) byLane[l].poCorrect++; }
    if (r.bwcCorrect) byLane[l].bwcCorrect++;
  }
  console.log('\nBy lane (BWC games only):');
  for (const [l, d] of Object.entries(byLane)) {
    console.log(`  ${l}: ${d.n} games | PO ${d.poCorrect}/${d.po} correct | BWC team won ${d.bwcCorrect}/${d.n}`);
  }

  // Rank breakdown
  const byRank = {};
  for (const r of withPO) {
    const rank = r.po.rank;
    if (!byRank[rank]) byRank[rank] = { n: 0, correct: 0 };
    byRank[rank].n++;
    if (r.poCorrect) byRank[rank].correct++;
  }
  if (Object.keys(byRank).length > 0) {
    console.log('\nBy rank:');
    for (const [rank, d] of Object.entries(byRank)) {
      console.log(`  ${rank}-Rank: ${d.correct}/${d.n} (${Math.round(d.correct/d.n*100)}%)`);
    }
  }

  // BUY alert summary
  const allBuys = results.flatMap(r => (r.buyAlerts || []).map(b => ({ ...b, matchup: r.matchup, winner: r.winner, bwcTeam: r.bwcTeam, poFired: !!r.po, lane: r.lane })));
  if (allBuys.length > 0) {
    console.log(`\n%c═══ BUY ALERT LAYER ═══`, 'color: orange; font-size: 14px; font-weight: bold');
    console.log(`Total BUY/WB/BWC alerts: ${allBuys.length}`);
    const sent = allBuys.filter(b => b.decision === 'SEND');
    const suppressed = allBuys.filter(b => b.decision === 'SUPPRESS');
    const sentCorrect = sent.filter(b => b.correct === true).length;
    const sentWrong = sent.filter(b => b.correct === false).length;
    const sentUnknown = sent.filter(b => b.correct == null).length;
    console.log(`  SENT: ${sent.length} (${sentCorrect} ✅ / ${sentWrong} ❌ / ${sentUnknown} ?)${sent.length ? ' → ' + Math.round(sentCorrect / (sentCorrect + sentWrong || 1) * 100) + '% accuracy' : ''}`);
    console.log(`  SUPPRESSED: ${suppressed.length}`);

    // BUY by type
    const byType = {};
    for (const b of allBuys) {
      const k = `${b.type} ${b.tier || 'FIRED'}`;
      if (!byType[k]) byType[k] = { n: 0, sent: 0, sentCorrect: 0, sentWrong: 0 };
      byType[k].n++;
      if (b.decision === 'SEND') {
        byType[k].sent++;
        if (b.correct === true) byType[k].sentCorrect++;
        if (b.correct === false) byType[k].sentWrong++;
      }
    }
    console.log('\n  By type:');
    for (const [k, d] of Object.entries(byType)) {
      console.log(`    ${k}: ${d.n} total, ${d.sent} sent (${d.sentCorrect}✅ ${d.sentWrong}❌)`);
    }

    // BUY alerts on games where PO was blocked
    const blockedGames = results.filter(r => r.graduation && !r.po);
    const buysOnBlocked = blockedGames.flatMap(r => (r.buyAlerts || []).map(b => ({ ...b, matchup: r.matchup })));
    if (buysOnBlocked.length > 0) {
      console.log(`\n  BUYs on PO-blocked games (${blockedGames.length} games):`);
      buysOnBlocked.forEach(b => {
        const decTag = b.decision === 'SEND' ? '📤' : '🚫';
        const correctTag = b.correct === true ? '✅' : b.correct === false ? '❌' : '?';
        console.log(`    ${b.matchup}: ${b.type} ${b.tier||'FIRED'} ${b.team} Q${b.period} ${b.clock} ${decTag}${b.decision} ${correctTag}`);
      });
    }

    // BUY + PO cross-reference: games with both
    const gamesWithBothPOAndBuy = results.filter(r => r.po && r.buyAlerts?.length > 0);
    if (gamesWithBothPOAndBuy.length > 0) {
      console.log(`\n  Games with BOTH PO + BUY alerts: ${gamesWithBothPOAndBuy.length}`);
      gamesWithBothPOAndBuy.forEach(r => {
        const buys = r.buyAlerts.map(b => `${b.type}${b.tier==='CANDIDATE'?'[C]':''} ${b.decision}`).join(', ');
        console.log(`    ${r.matchup}: PO ${r.po.rank} ${r.poCorrect?'✅':'❌'} + ${buys}`);
      });
    }
  } else {
    console.log('\nNo BUY alerts found in alerts table for these dates');
  }

  window._cpResults = results;
  console.log('\nFull results: window._cpResults');
  console.log('Checkpoint detail: window._cpResults[N].checkpoints');
  console.log('Block log: window._cpResults[N].poBlockLog');
})();
} // end block wrapper

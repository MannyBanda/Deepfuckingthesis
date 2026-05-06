// reportGraduationSim — replays the CHECKPOINT_GRADUATION_SPEC v3 rules
// against full backtest data. Simulates checkpoint capture, MF/minF accumulation,
// rank classification, lane gates, latest-to-graduate flip, PO fire/block decisions.
//
// ?phase=report_graduation_sim             — all games
// ?phase=report_graduation_sim&close=1     — competitive games only
// ?phase=report_graduation_sim&detail=1    — include per-game detail list
// ?phase=report_graduation_sim&lane=underdog|tossup|favorite|heavy_favorite — override lane (default: tossup)

async function reportGraduationSim(sql, url) {
  var closeOnly = url?.searchParams?.get('close') === '1';
  var showDetail = url?.searchParams?.get('detail') === '1';
  var laneOverride = url?.searchParams?.get('lane') || null;

  // ── Lane thresholds from spec ──
  var LANE_THRESHOLDS = {
    underdog:       { mfGate: 0.70, minFGate: 0.58 },
    tossup:         { mfGate: 0.75, minFGate: 0.58 },
    favorite:       { mfGate: 0.72, minFGate: 0.58 },
    heavy_favorite: { mfGate: 0.75, minFGate: 0.58 },
  };
  var activeLane = laneOverride || 'tossup';
  var gates = LANE_THRESHOLDS[activeLane] || LANE_THRESHOLDS.tossup;

  var rows = await sql`
    SELECT game_id, checkpoint, margin_at_snapshot AS margin,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl,
           indicators->>'homeAlias' AS home_alias,
           indicators->>'awayAlias' AS away_alias,
           (indicators->>'I1')::text AS i1raw, (indicators->>'I2')::text AS i2raw,
           (indicators->>'I3')::text AS i3raw, (indicators->>'I4')::text AS i4raw,
           (indicators->>'I5')::text AS i5raw,
           (conviction->>'tier') AS conv_tier,
           (conviction->>'count')::int AS ind_count,
           ctrl_team_won, final_margin
    FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  var checkpoints = CP_LABELS;
  var cpIdx = {}; for (var i = 0; i < checkpoints.length; i++) cpIdx[checkpoints[i]] = i;
  var Q3_6_IDX = cpIdx['Q3_6']; // = 7

  // Group by game
  var gameMap = {};
  for (var r of rows) {
    if (!gameMap[r.game_id]) gameMap[r.game_id] = [];
    gameMap[r.game_id].push(r);
  }

  // Competitive filter
  var Q3_CPS = new Set(['Q3_9','Q3_6','Q3_3','Q3_END']);
  var Q4_CPS = new Set(['Q4_9','Q4_6','Q4_3','Q4_END']);
  if (closeOnly) {
    for (var gid of Object.keys(gameMap)) {
      var competitive = gameMap[gid].some(function(s) {
        var absM = Math.abs(s.margin);
        if (Q3_CPS.has(s.checkpoint) && absM <= 5) return true;
        if (Q4_CPS.has(s.checkpoint) && absM <= 7) return true;
        return false;
      });
      if (!competitive) delete gameMap[gid];
    }
  }

  function getCtrlMargin(r) { return (r.ctrl === r.home_alias) ? r.margin : -r.margin; }
  function getOppCount(r) {
    var ctrlHome = r.ctrl === r.home_alias;
    var scores = [parseFloat(r.i1raw), parseFloat(r.i2raw), parseFloat(r.i3raw),
                  parseFloat(r.i4raw), parseFloat(r.i5raw)];
    var c = 0;
    for (var s of scores) { if (isNaN(s)) continue; if (ctrlHome ? (s === 0) : (s === 1)) c++; }
    return c;
  }
  function classifyBWCTier(conv, lead, holds, oppCount) {
    if (conv === 'DOMINANT' && lead >= 8 && holds >= 4 && oppCount <= 1) return 'A';
    if (oppCount >= 3) return 'C';
    if ((conv === 'DOMINANT' || conv === 'STRONG') && lead >= 3 && holds >= 2) return 'B';
    return 'C';
  }
  function ph(b) { return { n: b.n, wins: b.wins, pct: b.n > 0 ? Math.round(b.wins / b.n * 1000) / 10 : null }; }

  function teamWon(team, homeAlias, finalMargin) {
    if (finalMargin === 0) return false; // tie = no winner
    var homeWon = finalMargin > 0;
    return (team === homeAlias) ? homeWon : !homeWon;
  }

  // ── Accumulators ──
  var totalGames = 0;
  var totalBWCGames = 0;
  var poFired = { n: 0, wins: 0 };
  var poByRank = { S: {n:0,wins:0}, A: {n:0,wins:0}, B: {n:0,wins:0} };
  var poByCheckpoint = {};
  for (var cp of checkpoints) poByCheckpoint[cp] = {n:0,wins:0};
  var poFlipped = { n: 0, wins: 0 };
  var poNotFlipped = { n: 0, wins: 0 };
  var graduated_blocked = { n: 0, wins: 0 }; // graduated but MF/minF blocked
  var graduated_blocked_reasons = {};
  var never_graduated = { n: 0, wins: 0 }; // BWC game but no team graduated
  var no_bwc = 0; // no BWC-eligible checkpoints at all

  // Margin at PO fire
  var poMarginBuckets = {
    'lead_1_4': {n:0,wins:0}, 'lead_5_8': {n:0,wins:0},
    'lead_9_12': {n:0,wins:0}, 'lead_13_plus': {n:0,wins:0},
    'trailing_or_tied': {n:0,wins:0}
  };

  // MF sensitivity sweep — test spec rules at different MF gates
  var mfSweep = {};
  var sweepThresholds = [0.60, 0.65, 0.70, 0.72, 0.75, 0.78, 0.80, 0.85];
  for (var t of sweepThresholds) mfSweep[t.toFixed(2)] = {n:0,wins:0};

  // Wire-to-wire breakdown
  var wireToWire = {n:0,wins:0};
  var notWireToWire = {n:0,wins:0};

  // PO rank × margin at fire
  var rankMargin = {
    S: { 'lead_1_4':{n:0,wins:0}, 'lead_5_8':{n:0,wins:0}, 'lead_9_plus':{n:0,wins:0} },
    A: { 'lead_1_4':{n:0,wins:0}, 'lead_5_8':{n:0,wins:0}, 'lead_9_plus':{n:0,wins:0} },
    B: { 'lead_1_4':{n:0,wins:0}, 'lead_5_8':{n:0,wins:0}, 'lead_9_plus':{n:0,wins:0} },
  };

  // Detail list (optional)
  var detailList = [];

  // ── GAME LOOP ──
  for (var [gid, snaps] of Object.entries(gameMap)) {
    var cpMap = {};
    for (var s of snaps) cpMap[s.checkpoint] = s;
    if (!cpMap['Q2_6']) continue; // need enough data
    totalGames++;

    var homeA = snaps[0].home_alias;
    var awayA = snaps[0].away_alias;
    var finalM = snaps[0].final_margin;

    // ── Per-team state ──
    var teamState = {};
    teamState[homeA] = { cpHolds: 0, eligibleFloors: [], peakRank: 'C', gradCpIdx: null, gradRank: null };
    teamState[awayA] = { cpHolds: 0, eligibleFloors: [], peakRank: 'C', gradCpIdx: null, gradRank: null };

    var bwcTeam = null;     // first team to be BWC-eligible
    var ctrlFlips = 0;
    var prevCtrl = null;

    // PO result for this game
    var gamePO = null;       // { team, rank, cpLabel, cpIdx, mf, minF, flipped, margin }
    var gameBlocked = null;  // { rank, reason, team, mf, minF }

    for (var ci = 0; ci < checkpoints.length; ci++) {
      var cpLabel = checkpoints[ci];
      var snap = cpMap[cpLabel];
      if (!snap || !snap.ctrl) continue;

      var ctrlMargin = getCtrlMargin(snap);
      var oppCount = getOppCount(snap);
      var ctrlTeam = snap.ctrl;
      var oppTeam = ctrlTeam === homeA ? awayA : homeA;

      // Track control flips
      if (prevCtrl && prevCtrl !== ctrlTeam) ctrlFlips++;
      prevCtrl = ctrlTeam;

      // ── Per-team checkpoint holds ──
      teamState[ctrlTeam].cpHolds++;
      teamState[oppTeam].cpHolds = 0; // reset opponent counter

      // BWC eligibility check: floor >= 0.60 AND ctrl margin >= 2
      var bwcEligible = snap.floor >= 0.60 && ctrlMargin >= 2;
      if (!bwcEligible) continue;

      // Establish BWC team on first eligible checkpoint
      if (!bwcTeam) bwcTeam = ctrlTeam;

      // Record eligible floor for current control team
      teamState[ctrlTeam].eligibleFloors.push(snap.floor);

      // ── Rank classification (for current control team) ──
      var holds = teamState[ctrlTeam].cpHolds;
      var rank = classifyBWCTier(snap.conv_tier, ctrlMargin, holds, oppCount);

      var RANK_ORDER = { C: 0, B: 1, A: 2 };
      if (RANK_ORDER[rank] > RANK_ORDER[teamState[ctrlTeam].peakRank]) {
        teamState[ctrlTeam].peakRank = rank;
        teamState[ctrlTeam].gradCpIdx = ci;
        teamState[ctrlTeam].gradRank = rank;
      }

      // ── Compute MF / minF for BWC team ──
      if (ctrlTeam === bwcTeam) {
        var bwcFloors = teamState[bwcTeam].eligibleFloors;
        var mf = bwcFloors.reduce(function(a,b){return a+b;},0) / bwcFloors.length;
        var minF = Math.min.apply(null, bwcFloors);

        // ── MF Sensitivity Sweep (run at every eligible CP, first-fire per threshold) ──
        // (handled after PO evaluation below)

        // ── Standard PO evaluation (if BWC team graduated and PO not yet fired) ──
        if (!gamePO && teamState[bwcTeam].gradRank) {
          var gRank = teamState[bwcTeam].gradRank;

          if (gRank === 'A') {
            if (mf >= gates.mfGate && minF >= gates.minFGate) {
              var isW2W = ctrlFlips === 0;
              var poRank = isW2W ? 'S' : 'A';
              gamePO = { team: bwcTeam, rank: poRank, cpLabel: cpLabel, cpIdx: ci,
                         mf: mf, minF: minF, margin: ctrlMargin, flipped: false };
              gameBlocked = null; // PO fires, clear any prior block
            } else {
              gameBlocked = { rank: gRank, team: bwcTeam, mf: mf, minF: minF,
                reason: 'A-Rank MF ' + mf.toFixed(3) + (mf < gates.mfGate ? ' < ' + gates.mfGate : '') +
                        (minF < gates.minFGate ? ' | minF ' + minF.toFixed(2) + ' < ' + gates.minFGate : '') };
            }
          }
          if (gRank === 'B') {
            var pastQ3_6 = ci >= Q3_6_IDX;
            if (pastQ3_6 && mf >= gates.mfGate && minF >= gates.minFGate) {
              gamePO = { team: bwcTeam, rank: 'B', cpLabel: cpLabel, cpIdx: ci,
                         mf: mf, minF: minF, margin: ctrlMargin, flipped: false };
              gameBlocked = null;
            } else {
              var reason = !pastQ3_6 
                ? 'B-Rank waiting Q3_6+ (at ' + cpLabel + ')'
                : 'B-Rank MF ' + mf.toFixed(3) + (mf < gates.mfGate ? ' < ' + gates.mfGate : '') +
                  (minF < gates.minFGate ? ' | minF ' + minF.toFixed(2) + ' < ' + gates.minFGate : '');
              gameBlocked = { rank: gRank, team: bwcTeam, mf: mf, minF: minF, reason: reason };
            }
          }
          // C-Rank: no PO
        }
      }

      // ── Latest-to-graduate FLIP check ──
      // Runs when opponent has control and has graduated B+
      if (!gamePO && ctrlTeam !== bwcTeam && bwcTeam) {
        var oppState = teamState[ctrlTeam]; // "opponent" of BWC = current ctrl
        if (oppState.gradRank && (oppState.gradRank === 'B' || oppState.gradRank === 'A')) {
          // Check: graduated more recently than BWC team (or BWC never graduated)
          var bwcGradIdx = teamState[bwcTeam].gradCpIdx;
          var oppGradIdx = oppState.gradCpIdx;
          var oppIsMoreRecent = bwcGradIdx === null || oppGradIdx > bwcGradIdx;

          // Check: opponent has 2+ consecutive holds at checkpoint level
          var oppHolds = oppState.cpHolds;

          // Compute opponent MF
          var oppFloors = oppState.eligibleFloors;
          var oppMF = oppFloors.length > 0
            ? oppFloors.reduce(function(a,b){return a+b;},0) / oppFloors.length
            : null;

          if (oppIsMoreRecent && oppHolds >= 2 && oppMF !== null && oppMF >= 0.55) {
            gamePO = { team: ctrlTeam, rank: oppState.gradRank, cpLabel: cpLabel, cpIdx: ci,
                       mf: oppMF, minF: null, margin: ctrlMargin, flipped: true,
                       original_bwc: bwcTeam };
            // Clear any prior block (flip supersedes)
            gameBlocked = null;
          }
        }
      }

      // Also check: if PO already fired on BWC team, but opponent graduated more recently → flip
      if (gamePO && !gamePO.flipped && ctrlTeam !== gamePO.team && bwcTeam) {
        var oppState2 = teamState[ctrlTeam];
        if (oppState2.gradRank && (oppState2.gradRank === 'B' || oppState2.gradRank === 'A')) {
          // Compare GRADUATION indices, not PO fire indices
          var origGradIdx = teamState[gamePO.team]?.gradCpIdx ?? -1;
          var oppGradIdx2 = oppState2.gradCpIdx;
          var oppHolds2 = oppState2.cpHolds;
          var oppFloors2 = oppState2.eligibleFloors;
          var oppMF2 = oppFloors2.length > 0
            ? oppFloors2.reduce(function(a,b){return a+b;},0) / oppFloors2.length
            : null;

          if (oppGradIdx2 > origGradIdx && oppHolds2 >= 2 && oppMF2 !== null && oppMF2 >= 0.55) {
            gamePO = { team: ctrlTeam, rank: oppState2.gradRank, cpLabel: cpLabel, cpIdx: ci,
                       mf: oppMF2, minF: null, margin: ctrlMargin, flipped: true,
                       original_bwc: bwcTeam };
          }
        }
      }
    } // end checkpoint loop

    // ── Determine outcomes ──
    if (!bwcTeam) { no_bwc++; continue; }
    totalBWCGames++;

    if (gamePO) {
      var poWon = teamWon(gamePO.team, homeA, finalM);

      poFired.n++; if (poWon) poFired.wins++;
      poByRank[gamePO.rank].n++; if (poWon) poByRank[gamePO.rank].wins++;
      poByCheckpoint[gamePO.cpLabel].n++; if (poWon) poByCheckpoint[gamePO.cpLabel].wins++;

      if (gamePO.flipped) { poFlipped.n++; if (poWon) poFlipped.wins++; }
      else { poNotFlipped.n++; if (poWon) poNotFlipped.wins++; }

      // Margin bucket
      var m = gamePO.margin;
      var mBucket;
      if (m <= 0) mBucket = 'trailing_or_tied';
      else if (m <= 4) mBucket = 'lead_1_4';
      else if (m <= 8) mBucket = 'lead_5_8';
      else if (m <= 12) mBucket = 'lead_9_12';
      else mBucket = 'lead_13_plus';
      poMarginBuckets[mBucket].n++; if (poWon) poMarginBuckets[mBucket].wins++;

      // Rank × margin
      var rmBucket = m <= 4 ? 'lead_1_4' : m <= 8 ? 'lead_5_8' : 'lead_9_plus';
      if (rankMargin[gamePO.rank]) {
        rankMargin[gamePO.rank][rmBucket].n++;
        if (poWon) rankMargin[gamePO.rank][rmBucket].wins++;
      }

      // Wire-to-wire
      if (ctrlFlips === 0) { wireToWire.n++; if (poWon) wireToWire.wins++; }
      else { notWireToWire.n++; if (poWon) notWireToWire.wins++; }

      if (showDetail) {
        detailList.push({
          game_id: gid, matchup: awayA + '@' + homeA,
          po_team: gamePO.team, rank: gamePO.rank, cp: gamePO.cpLabel,
          mf: Math.round(gamePO.mf * 1000) / 1000, minF: gamePO.minF ? Math.round(gamePO.minF * 1000) / 1000 : null,
          margin: gamePO.margin, flipped: gamePO.flipped,
          original_bwc: gamePO.original_bwc || null,
          ctrl_flips: ctrlFlips, won: poWon, final_margin: finalM,
        });
      }
    } else if (gameBlocked) {
      // Graduated but gates blocked
      var blockedTeamWon = teamWon(gameBlocked.team, homeA, finalM);
      graduated_blocked.n++; if (blockedTeamWon) graduated_blocked.wins++;
      var rKey = gameBlocked.reason.substring(0, 40);
      if (!graduated_blocked_reasons[rKey]) graduated_blocked_reasons[rKey] = {n:0,wins:0};
      graduated_blocked_reasons[rKey].n++; if (blockedTeamWon) graduated_blocked_reasons[rKey].wins++;

      if (showDetail) {
        detailList.push({
          game_id: gid, matchup: awayA + '@' + homeA,
          po_team: null, rank: gameBlocked.rank, cp: null,
          mf: gameBlocked.mf ? Math.round(gameBlocked.mf * 1000) / 1000 : null,
          minF: gameBlocked.minF ? Math.round(gameBlocked.minF * 1000) / 1000 : null,
          margin: null, flipped: false, blocked: true,
          block_reason: gameBlocked.reason,
          would_have_been_correct: blockedTeamWon,
          ctrl_flips: ctrlFlips, final_margin: finalM,
        });
      }
    } else {
      // Never graduated — no team reached B or A
      // Determine if BWC team won
      var bwcWon = teamWon(bwcTeam, homeA, finalM);
      never_graduated.n++; if (bwcWon) never_graduated.wins++;
    }

    // ── MF Sensitivity Sweep ──
    // Re-simulate with each sweep threshold to see PO volume/accuracy
    for (var st of sweepThresholds) {
      var stKey = st.toFixed(2);
      // Replay simplified: did any team graduate + did MF cross threshold?
      var anyGrad = false;
      var sweepTeam = null;
      for (var team of [homeA, awayA]) {
        if (teamState[team].gradRank && (teamState[team].gradRank === 'A' || teamState[team].gradRank === 'B')) {
          var tFloors = teamState[team].eligibleFloors;
          if (tFloors.length > 0) {
            var tMF = tFloors.reduce(function(a,b){return a+b;},0) / tFloors.length;
            var tMinF = Math.min.apply(null, tFloors);
            if (tMF >= st && tMinF >= 0.58) {
              // Check timing gate for B-rank
              if (teamState[team].gradRank === 'A' || teamState[team].gradCpIdx >= Q3_6_IDX) {
                if (!anyGrad) {
                  anyGrad = true;
                  sweepTeam = team;
                }
              }
            }
          }
        }
      }
      if (anyGrad && sweepTeam) {
        var swWon = teamWon(sweepTeam, homeA, finalM);
        mfSweep[stKey].n++; if (swWon) mfSweep[stKey].wins++;
      }
    }
  } // end game loop

  // ── Build output ──
  var result = {
    _meta: {
      filter: closeOnly ? 'competitive games (within 5 in Q3, within 7 in Q4)' : 'all games',
      lane: activeLane,
      gates: gates,
      total_games: totalGames,
      total_bwc_games: totalBWCGames,
      no_bwc_games: no_bwc,
    },

    section_1_overall: {
      description: 'Overall PO accuracy under full spec rules. Games where PO fires vs total BWC games.',
      po_fired: ph(poFired),
      po_coverage: totalBWCGames > 0 ? Math.round(poFired.n / totalBWCGames * 1000) / 10 + '%' : null,
      graduated_but_blocked: ph(graduated_blocked),
      never_graduated: ph(never_graduated),
      fire_plus_block_plus_never: poFired.n + graduated_blocked.n + never_graduated.n,
    },

    section_2_by_rank: {
      description: 'PO accuracy broken down by rank. S = wire-to-wire A. A = graduated A (with flips). B = graduated B, Q3_6+.',
      S: ph(poByRank.S),
      A: ph(poByRank.A),
      B: ph(poByRank.B),
    },

    section_3_flip_analysis: {
      description: 'Flipped POs (latest-to-graduate took over) vs standard POs.',
      standard_po: ph(poNotFlipped),
      flipped_po: ph(poFlipped),
      flip_rate: poFired.n > 0 ? Math.round(poFlipped.n / poFired.n * 1000) / 10 + '%' : null,
    },

    section_4_by_checkpoint: {
      description: 'When does PO fire? Distribution across checkpoints.',
      checkpoints: Object.fromEntries(
        Object.entries(poByCheckpoint).filter(function(e) { return e[1].n > 0; }).map(function(e) { return [e[0], ph(e[1])]; })
      ),
    },

    section_5_margin_at_fire: {
      description: 'What lead did PO team have when PO fired?',
      buckets: Object.fromEntries(
        Object.entries(poMarginBuckets).filter(function(e) { return e[1].n > 0; }).map(function(e) { return [e[0], ph(e[1])]; })
      ),
    },

    section_6_rank_x_margin: {
      description: 'Rank × margin at PO fire — where is each rank most reliable?',
      S: Object.fromEntries(Object.entries(rankMargin.S).filter(function(e){return e[1].n>0;}).map(function(e){return [e[0],ph(e[1])];})),
      A: Object.fromEntries(Object.entries(rankMargin.A).filter(function(e){return e[1].n>0;}).map(function(e){return [e[0],ph(e[1])];})),
      B: Object.fromEntries(Object.entries(rankMargin.B).filter(function(e){return e[1].n>0;}).map(function(e){return [e[0],ph(e[1])];})),
    },

    section_7_wire_to_wire: {
      description: 'Wire-to-wire (0 ctrl flips) vs games with flips.',
      wire_to_wire: ph(wireToWire),
      with_flips: ph(notWireToWire),
    },

    section_8_blocked_reasons: {
      description: 'Why did graduated games get blocked?',
      total_blocked: ph(graduated_blocked),
      by_reason: Object.fromEntries(
        Object.entries(graduated_blocked_reasons).map(function(e) { return [e[0], ph(e[1])]; })
      ),
    },

    section_9_mf_sensitivity: {
      description: 'Volume and accuracy at different MF gate thresholds (holding minF=0.58, same rank/timing rules).',
      by_threshold: Object.fromEntries(
        Object.entries(mfSweep).map(function(e) { return [e[0], ph(e[1])]; })
      ),
    },
  };

  if (showDetail && detailList.length > 0) {
    // Sort by game_id
    detailList.sort(function(a,b) { return a.game_id - b.game_id; });
    result.section_10_detail = {
      description: 'Per-game detail. Shows PO decisions and outcomes.',
      count: detailList.length,
      games: detailList,
    };
  }

  return result;
}

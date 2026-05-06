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
  var mfOverride = url?.searchParams?.get('mf');
  if (mfOverride) gates = { mfGate: parseFloat(mfOverride), minFGate: gates.minFGate };

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
  var Q3_6_IDX = cpIdx['Q3_6'];

  var gameMap = {};
  for (var r of rows) {
    if (!gameMap[r.game_id]) gameMap[r.game_id] = [];
    gameMap[r.game_id].push(r);
  }

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
    if (finalMargin === 0) return false;
    var homeWon = finalMargin > 0;
    return (team === homeAlias) ? homeWon : !homeWon;
  }

  // ── Accumulators ──
  var totalGames = 0, totalBWCGames = 0, no_bwc = 0;
  var poFired = { n: 0, wins: 0 };
  // S-rank is POST-HOC only now — all A-grades fire as 'A'
  var poByRank = { A: {n:0,wins:0}, B: {n:0,wins:0} };
  var postHocS = { n: 0, wins: 0 }; // A-rank + zero ctrl flips at game end
  var postHocA = { n: 0, wins: 0 }; // A-rank with flips (not W2W)
  var poByCheckpoint = {};
  for (var cp of checkpoints) poByCheckpoint[cp] = {n:0,wins:0};
  var poFlipped = { n: 0, wins: 0 };
  var poNotFlipped = { n: 0, wins: 0 };
  var graduated_blocked = { n: 0, wins: 0 };
  var never_graduated = { n: 0, wins: 0 };

  // Margin at PO fire
  var poMarginBuckets = {
    'lead_1_4': {n:0,wins:0}, 'lead_5_8': {n:0,wins:0},
    'lead_9_12': {n:0,wins:0}, 'lead_13_plus': {n:0,wins:0},
    'trailing_or_tied': {n:0,wins:0}
  };

  // MF sensitivity sweep
  var mfSweep = {};
  var sweepThresholds = [0.60, 0.65, 0.70, 0.72, 0.75, 0.78, 0.80, 0.85];
  for (var t of sweepThresholds) mfSweep[t.toFixed(2)] = {n:0,wins:0};

  // Conviction cross-tab at PO fire
  var convByRank = {
    A: { DOMINANT:{n:0,wins:0}, STRONG:{n:0,wins:0}, MODEST:{n:0,wins:0}, CONDITIONAL:{n:0,wins:0}, other:{n:0,wins:0} },
    B: { DOMINANT:{n:0,wins:0}, STRONG:{n:0,wins:0}, MODEST:{n:0,wins:0}, CONDITIONAL:{n:0,wins:0}, other:{n:0,wins:0} },
  };

  // ── Flip deep analysis ──
  var flipByCheckpoint = {};
  for (var cp of checkpoints) flipByCheckpoint[cp] = {n:0,wins:0};
  var flipByRank = { A: {n:0,wins:0}, B: {n:0,wins:0} };
  var flipLossOrigin = { type1_both_wrong: 0, type2_original_was_right: 0, total_flip_losses: 0 };

  // ── B confirmation window sweep ──
  // For each N (0,1,2,3,4): B fires N checkpoints after graduation, not at fixed Q3_6
  var bConfirmNs = [0, 1, 2, 3, 4];
  var bConfirmSweep = {};
  for (var n of bConfirmNs) bConfirmSweep[n] = { n: 0, wins: 0 };

  // ── Flip criteria comparison ──
  // Track alongside main sim: lighter flip criteria
  var flipCriteria = {
    current: { n: 0, wins: 0 },    // graduated B+, 2+ holds, MF>=0.55, more recent
    lighter: { n: 0, wins: 0 },    // BWC-eligible (floor>=0.60, margin>=2), 2+ holds, more recent ctrl
    lightest: { n: 0, wins: 0 },   // BWC-eligible, 1+ hold (just took control back)
  };

  // Detail list
  var detailList = [];

  // ── GAME LOOP ──
  for (var [gid, snaps] of Object.entries(gameMap)) {
    var cpMap = {};
    for (var s of snaps) cpMap[s.checkpoint] = s;
    if (!cpMap['Q2_6']) continue;
    totalGames++;

    var homeA = snaps[0].home_alias;
    var awayA = snaps[0].away_alias;
    var finalM = snaps[0].final_margin;

    var teamState = {};
    teamState[homeA] = { cpHolds: 0, eligibleFloors: [], peakRank: 'C', gradCpIdx: null, gradRank: null };
    teamState[awayA] = { cpHolds: 0, eligibleFloors: [], peakRank: 'C', gradCpIdx: null, gradRank: null };

    var bwcTeam = null;
    var ctrlFlips = 0;
    var prevCtrl = null;

    var gamePO = null;
    var gameBlocked = null;

    // B confirmation sweep trackers (per-N)
    var bConfirmFired = {};
    for (var bn of bConfirmNs) bConfirmFired[bn] = null;

    // Flip criteria trackers (per-criteria, per-game)
    var flipCriteriaFired = { current: null, lighter: null, lightest: null };

    for (var ci = 0; ci < checkpoints.length; ci++) {
      var cpLabel = checkpoints[ci];
      var snap = cpMap[cpLabel];
      if (!snap || !snap.ctrl) continue;

      var ctrlMargin = getCtrlMargin(snap);
      var oppCount = getOppCount(snap);
      var ctrlTeam = snap.ctrl;
      var oppTeam = ctrlTeam === homeA ? awayA : homeA;

      if (prevCtrl && prevCtrl !== ctrlTeam) ctrlFlips++;
      prevCtrl = ctrlTeam;

      teamState[ctrlTeam].cpHolds++;
      teamState[oppTeam].cpHolds = 0;

      var bwcEligible = snap.floor >= 0.60 && ctrlMargin >= 2;
      if (!bwcEligible) continue;

      if (!bwcTeam) bwcTeam = ctrlTeam;

      teamState[ctrlTeam].eligibleFloors.push(snap.floor);

      var holds = teamState[ctrlTeam].cpHolds;
      var rank = classifyBWCTier(snap.conv_tier, ctrlMargin, holds, oppCount);

      var RANK_ORDER = { C: 0, B: 1, A: 2 };
      if (RANK_ORDER[rank] > RANK_ORDER[teamState[ctrlTeam].peakRank]) {
        teamState[ctrlTeam].peakRank = rank;
        teamState[ctrlTeam].gradCpIdx = ci;
        teamState[ctrlTeam].gradRank = rank;
      }

      // ── BWC team PO evaluation ──
      if (ctrlTeam === bwcTeam) {
        var bwcFloors = teamState[bwcTeam].eligibleFloors;
        var mf = bwcFloors.reduce(function(a,b){return a+b;},0) / bwcFloors.length;
        var minF = Math.min.apply(null, bwcFloors);

        if (!gamePO && teamState[bwcTeam].gradRank) {
          var gRank = teamState[bwcTeam].gradRank;

          // A-rank: fire at any checkpoint (NO S classification at fire time)
          if (gRank === 'A') {
            if (mf >= gates.mfGate && minF >= gates.minFGate) {
              gamePO = { team: bwcTeam, rank: 'A', cpLabel: cpLabel, cpIdx: ci,
                         mf: mf, minF: minF, margin: ctrlMargin, flipped: false,
                         conv: snap.conv_tier };
              gameBlocked = null;
            } else {
              gameBlocked = { rank: gRank, team: bwcTeam, mf: mf, minF: minF,
                reason: 'A-Rank MF ' + mf.toFixed(3) + (mf < gates.mfGate ? ' < ' + gates.mfGate : '') +
                        (minF < gates.minFGate ? ' | minF ' + minF.toFixed(2) + ' < ' + gates.minFGate : '') };
            }
          }
          // B-rank: Q3_6+ gate
          if (gRank === 'B') {
            var pastQ3_6 = ci >= Q3_6_IDX;
            if (pastQ3_6 && mf >= gates.mfGate && minF >= gates.minFGate) {
              gamePO = { team: bwcTeam, rank: 'B', cpLabel: cpLabel, cpIdx: ci,
                         mf: mf, minF: minF, margin: ctrlMargin, flipped: false,
                         conv: snap.conv_tier };
              gameBlocked = null;
            } else {
              var reason = !pastQ3_6
                ? 'B-Rank waiting Q3_6+ (at ' + cpLabel + ')'
                : 'B-Rank MF ' + mf.toFixed(3) + (mf < gates.mfGate ? ' < ' + gates.mfGate : '') +
                  (minF < gates.minFGate ? ' | minF ' + minF.toFixed(2) + ' < ' + gates.minFGate : '');
              gameBlocked = { rank: gRank, team: bwcTeam, mf: mf, minF: minF, reason: reason };
            }
          }
        }

        // ── B confirmation window sweep (parallel tracker) ──
        if (teamState[bwcTeam].gradRank === 'B' || teamState[bwcTeam].gradRank === 'A') {
          if (teamState[bwcTeam].gradRank === 'B') {
            var cpsSinceGrad = ci - teamState[bwcTeam].gradCpIdx;
            for (var bn of bConfirmNs) {
              if (bConfirmFired[bn] === null && cpsSinceGrad >= bn && mf >= gates.mfGate && minF >= gates.minFGate) {
                bConfirmFired[bn] = { team: bwcTeam, ci: ci };
              }
            }
          }
        }
      }

      // ── FLIP EVALUATION (main sim — current criteria) ──
      // Check when opponent has control
      if (ctrlTeam !== bwcTeam && bwcTeam) {
        var oppState = teamState[ctrlTeam];

        // ── Current criteria: graduated B+, 2+ holds, MF>=0.55, more recent ──
        if (oppState.gradRank && (oppState.gradRank === 'B' || oppState.gradRank === 'A')) {
          var bwcGradIdx = teamState[bwcTeam].gradCpIdx;
          var oppGradIdx = oppState.gradCpIdx;
          var oppIsMoreRecent = bwcGradIdx === null || oppGradIdx > bwcGradIdx;

          var oppFloors = oppState.eligibleFloors;
          var oppMF = oppFloors.length > 0
            ? oppFloors.reduce(function(a,b){return a+b;},0) / oppFloors.length : null;

          if (oppIsMoreRecent && oppState.cpHolds >= 2 && oppMF !== null && oppMF >= 0.55) {
            // Flip fires — overwrite PO (or create if none existed)
            if (!gamePO || gamePO.team !== ctrlTeam) {
              var prevPOTeam = gamePO ? gamePO.team : bwcTeam;
              gamePO = { team: ctrlTeam, rank: oppState.gradRank, cpLabel: cpLabel, cpIdx: ci,
                         mf: oppMF, minF: null, margin: ctrlMargin, flipped: true,
                         original_bwc: prevPOTeam, conv: snap.conv_tier };
              gameBlocked = null;
            }
          }

          // Track for criteria comparison (current)
          if (oppIsMoreRecent && oppState.cpHolds >= 2 && oppMF !== null && oppMF >= 0.55) {
            if (!flipCriteriaFired.current) flipCriteriaFired.current = { team: ctrlTeam };
          }
        }

        // ── Lighter criteria: BWC-eligible + 2+ holds (no graduation required) ──
        if (oppState.cpHolds >= 2) {
          if (!flipCriteriaFired.lighter) flipCriteriaFired.lighter = { team: ctrlTeam };
        }

        // ── Lightest criteria: BWC-eligible + 1+ hold (just has control) ──
        if (oppState.cpHolds >= 1) {
          if (!flipCriteriaFired.lightest) flipCriteriaFired.lightest = { team: ctrlTeam };
        }
      }

      // Also: flip when PO already exists on different team
      if (gamePO && !gamePO.flipped && ctrlTeam !== gamePO.team && bwcTeam) {
        var oppState2 = teamState[ctrlTeam];
        if (oppState2.gradRank && (oppState2.gradRank === 'B' || oppState2.gradRank === 'A')) {
          var origGradIdx2 = teamState[gamePO.team]?.gradCpIdx ?? -1;
          var oppGradIdx2 = oppState2.gradCpIdx;
          var oppFloors2 = oppState2.eligibleFloors;
          var oppMF2 = oppFloors2.length > 0
            ? oppFloors2.reduce(function(a,b){return a+b;},0) / oppFloors2.length : null;

          if (oppGradIdx2 > origGradIdx2 && oppState2.cpHolds >= 2 && oppMF2 !== null && oppMF2 >= 0.55) {
            var prevTeam = gamePO.team;
            gamePO = { team: ctrlTeam, rank: oppState2.gradRank, cpLabel: cpLabel, cpIdx: ci,
                       mf: oppMF2, minF: null, margin: ctrlMargin, flipped: true,
                       original_bwc: prevTeam, conv: snap.conv_tier };
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

      // Rank (A or B only at fire time)
      poByRank[gamePO.rank].n++; if (poWon) poByRank[gamePO.rank].wins++;

      // Post-hoc S: A-rank + zero ctrl flips at game end
      if (gamePO.rank === 'A' && !gamePO.flipped) {
        if (ctrlFlips === 0) { postHocS.n++; if (poWon) postHocS.wins++; }
        else { postHocA.n++; if (poWon) postHocA.wins++; }
      }

      poByCheckpoint[gamePO.cpLabel].n++; if (poWon) poByCheckpoint[gamePO.cpLabel].wins++;

      if (gamePO.flipped) {
        poFlipped.n++; if (poWon) poFlipped.wins++;
        flipByCheckpoint[gamePO.cpLabel].n++; if (poWon) flipByCheckpoint[gamePO.cpLabel].wins++;
        flipByRank[gamePO.rank].n++; if (poWon) flipByRank[gamePO.rank].wins++;

        // Flip loss origin
        if (!poWon) {
          flipLossOrigin.total_flip_losses++;
          var originalWon = teamWon(gamePO.original_bwc, homeA, finalM);
          if (originalWon) flipLossOrigin.type2_original_was_right++;
          else flipLossOrigin.type1_both_wrong++;
        }
      } else {
        poNotFlipped.n++; if (poWon) poNotFlipped.wins++;
      }

      // Margin bucket
      var m = gamePO.margin;
      var mBucket = m <= 0 ? 'trailing_or_tied' : m <= 4 ? 'lead_1_4' : m <= 8 ? 'lead_5_8' : m <= 12 ? 'lead_9_12' : 'lead_13_plus';
      poMarginBuckets[mBucket].n++; if (poWon) poMarginBuckets[mBucket].wins++;

      // Conviction cross-tab
      var convKey = gamePO.conv || 'other';
      if (!convByRank[gamePO.rank]) convKey = 'other';
      if (convByRank[gamePO.rank]) {
        var cb = convByRank[gamePO.rank][convKey] || convByRank[gamePO.rank].other;
        cb.n++; if (poWon) cb.wins++;
      }

      if (showDetail) {
        detailList.push({
          game_id: gid, matchup: awayA + '@' + homeA,
          po_team: gamePO.team, rank: gamePO.rank, cp: gamePO.cpLabel,
          mf: Math.round(gamePO.mf * 1000) / 1000, margin: gamePO.margin,
          conv: gamePO.conv, flipped: gamePO.flipped,
          original_bwc: gamePO.original_bwc || null,
          postHocS: gamePO.rank === 'A' && !gamePO.flipped && ctrlFlips === 0,
          ctrl_flips: ctrlFlips, won: poWon, final_margin: finalM,
        });
      }
    } else if (gameBlocked) {
      var blockedTeamWon = teamWon(gameBlocked.team, homeA, finalM);
      graduated_blocked.n++; if (blockedTeamWon) graduated_blocked.wins++;
    } else {
      var bwcWon = teamWon(bwcTeam, homeA, finalM);
      never_graduated.n++; if (bwcWon) never_graduated.wins++;
    }

    // ── B confirmation window sweep results ──
    for (var bn of bConfirmNs) {
      if (bConfirmFired[bn]) {
        var bcWon = teamWon(bConfirmFired[bn].team, homeA, finalM);
        bConfirmSweep[bn].n++; if (bcWon) bConfirmSweep[bn].wins++;
      }
    }

    // ── Flip criteria comparison results ──
    for (var fcKey of ['current', 'lighter', 'lightest']) {
      if (flipCriteriaFired[fcKey]) {
        var fcWon = teamWon(flipCriteriaFired[fcKey].team, homeA, finalM);
        flipCriteria[fcKey].n++; if (fcWon) flipCriteria[fcKey].wins++;
      }
    }

    // ── MF Sensitivity Sweep ──
    for (var st of sweepThresholds) {
      var stKey = st.toFixed(2);
      var anyGrad = false, sweepTeam = null;
      for (var team of [homeA, awayA]) {
        if (teamState[team].gradRank && (teamState[team].gradRank === 'A' || teamState[team].gradRank === 'B')) {
          var tFloors = teamState[team].eligibleFloors;
          if (tFloors.length > 0) {
            var tMF = tFloors.reduce(function(a,b){return a+b;},0) / tFloors.length;
            var tMinF = Math.min.apply(null, tFloors);
            if (tMF >= st && tMinF >= 0.58) {
              if (teamState[team].gradRank === 'A' || teamState[team].gradCpIdx >= Q3_6_IDX) {
                if (!anyGrad) { anyGrad = true; sweepTeam = team; }
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
      lane: activeLane, gates: gates,
      total_games: totalGames, total_bwc_games: totalBWCGames, no_bwc_games: no_bwc,
    },

    section_1_overall: {
      description: 'Overall PO accuracy. S dissolved into A at fire time; S is post-hoc only.',
      po_fired: ph(poFired),
      po_coverage: totalBWCGames > 0 ? Math.round(poFired.n / totalBWCGames * 1000) / 10 + '%' : null,
      graduated_but_blocked: ph(graduated_blocked),
      never_graduated: ph(never_graduated),
    },

    section_2_by_rank: {
      description: 'Rank at fire time (A or B only). S is post-hoc — see section 3.',
      A: ph(poByRank.A),
      B: ph(poByRank.B),
    },

    section_3_post_hoc_s: {
      description: 'S = A-rank (non-flipped) with zero ctrl flips at game end. Post-hoc only, not assigned at fire time.',
      S_post_hoc: ph(postHocS),
      A_with_flips: ph(postHocA),
      note: 'A-rank total = S_post_hoc + A_with_flips + A-rank flipped POs',
    },

    section_4_flip_deep: {
      description: 'Flip analysis: when, to which rank, and loss origin (Type 2 = original PO team actually won).',
      standard_po: ph(poNotFlipped),
      flipped_po: ph(poFlipped),
      flip_rate: poFired.n > 0 ? Math.round(poFlipped.n / poFired.n * 1000) / 10 + '%' : null,
      flip_by_rank: {
        A: ph(flipByRank.A),
        B: ph(flipByRank.B),
      },
      flip_by_checkpoint: Object.fromEntries(
        Object.entries(flipByCheckpoint).filter(function(e) { return e[1].n > 0; }).map(function(e) { return [e[0], ph(e[1])]; })
      ),
      flip_loss_origin: {
        total_flip_losses: flipLossOrigin.total_flip_losses,
        type1_both_wrong: flipLossOrigin.type1_both_wrong,
        type2_original_was_right: flipLossOrigin.type2_original_was_right,
        type2_pct: flipLossOrigin.total_flip_losses > 0
          ? Math.round(flipLossOrigin.type2_original_was_right / flipLossOrigin.total_flip_losses * 1000) / 10 + '%'
          : null,
        interpretation: 'Type 1 = both teams wrong, flip did not hurt. Type 2 = original was correct, flip actively damaged accuracy.',
      },
    },

    section_5_flip_criteria_comparison: {
      description: 'Flip with different triggering criteria. Current = graduated B+, 2+ holds, MF>=0.55. Lighter = BWC-eligible + 2+ holds (no graduation). Lightest = BWC-eligible + 1 hold.',
      current_graduated: ph(flipCriteria.current),
      lighter_eligible_2holds: ph(flipCriteria.lighter),
      lightest_eligible_1hold: ph(flipCriteria.lightest),
    },

    section_6_b_confirmation_window: {
      description: 'B-rank with relative confirmation: PO fires N checkpoints after B graduation (not fixed Q3_6). Compare to find optimal confirmation depth.',
      by_n: Object.fromEntries(bConfirmNs.map(function(n) {
        return ['N=' + n + '_cps_after_grad', ph(bConfirmSweep[n])];
      })),
      note: 'N=0 = fire immediately at graduation. N=2 = fire 2 checkpoints later. Current spec uses fixed Q3_6 gate instead.',
    },

    section_7_conviction_cross_tab: {
      description: 'Conviction tier at the checkpoint where PO fired, cross-tabbed by rank.',
      A: Object.fromEntries(
        Object.entries(convByRank.A).filter(function(e) { return e[1].n > 0; }).map(function(e) { return [e[0], ph(e[1])]; })
      ),
      B: Object.fromEntries(
        Object.entries(convByRank.B).filter(function(e) { return e[1].n > 0; }).map(function(e) { return [e[0], ph(e[1])]; })
      ),
    },

    section_8_by_checkpoint: {
      description: 'When does PO fire?',
      checkpoints: Object.fromEntries(
        Object.entries(poByCheckpoint).filter(function(e) { return e[1].n > 0; }).map(function(e) { return [e[0], ph(e[1])]; })
      ),
    },

    section_9_margin_at_fire: {
      description: 'Lead at PO fire.',
      buckets: Object.fromEntries(
        Object.entries(poMarginBuckets).filter(function(e) { return e[1].n > 0; }).map(function(e) { return [e[0], ph(e[1])]; })
      ),
    },

    section_10_mf_sensitivity: {
      description: 'Volume and accuracy at different MF gate thresholds.',
      by_threshold: Object.fromEntries(
        Object.entries(mfSweep).map(function(e) { return [e[0], ph(e[1])]; })
      ),
    },
  };

  if (showDetail && detailList.length > 0) {
    detailList.sort(function(a,b) { return a.game_id - b.game_id; });
    result.section_11_detail = {
      description: 'Per-game detail.',
      count: detailList.length,
      games: detailList,
    };
  }

  return result;
}

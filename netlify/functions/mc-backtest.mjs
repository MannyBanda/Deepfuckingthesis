// ══════════════════════════════════════════════════════════════════════════════
// Monte Carlo Possession Simulation — Backtest & Validation Harness
// ══════════════════════════════════════════════════════════════════════════════
//
// Phases:
//   ?phase=init                         — Create mc_backtest_results table
//   ?phase=run&n=100&offset=0           — Process N games from backtest table
//   ?phase=run&n=100&offset=100         — Next batch
//   ?phase=analyze                      — Compute AUC, calibration, segments
//   ?phase=analyze&segment=lead_change  — Lead-change games only
//   ?phase=sweep&param=regression&values=0.3,0.5,0.7  — Parameter sweep
//   ?phase=validate_game&game_id=XXX    — Run MC against prod game snapshots
//
// Dependencies: nba_snapshot_backtest (16,910 rows, ~1,235 games)

import { neon } from '@neondatabase/serverless';

// ── Checkpoint ordering (must match backtest-nba-snapshots.mjs) ─────────────
var CP_LABELS = [
  'Q1_6','Q1_END',
  'Q2_9','Q2_6','Q2_3','Q2_END',
  'Q3_9','Q3_6','Q3_3','Q3_END',
  'Q4_9','Q4_6','Q4_3','Q4_END',
];
var CP_INDEX = {};
for (var i = 0; i < CP_LABELS.length; i++) CP_INDEX[CP_LABELS[i]] = i;

// Checkpoint → {period, clockSec}
var CP_META = {
  Q1_6:   { period: 1, clockSec: 360 },
  Q1_END: { period: 1, clockSec: 0 },
  Q2_9:   { period: 2, clockSec: 540 },
  Q2_6:   { period: 2, clockSec: 360 },
  Q2_3:   { period: 2, clockSec: 180 },
  Q2_END: { period: 2, clockSec: 0 },
  Q3_9:   { period: 3, clockSec: 540 },
  Q3_6:   { period: 3, clockSec: 360 },
  Q3_3:   { period: 3, clockSec: 180 },
  Q3_END: { period: 3, clockSec: 0 },
  Q4_9:   { period: 4, clockSec: 540 },
  Q4_6:   { period: 4, clockSec: 360 },
  Q4_3:   { period: 4, clockSec: 180 },
  Q4_END: { period: 4, clockSec: 0 },
};

// ══════════════════════════════════════════════════════════════════════════════
// MONTE CARLO SIMULATION ENGINE (pure function — no DB, no side effects)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Simulate a single possession given team rates.
 * Returns points scored (0, 2, or 3 from field + 0-2 from FT).
 */
function simulatePossession(rates) {
  // Turnover check
  if (Math.random() < rates.toRate) return 0;

  var shotPts = 0;
  var isMake = false;

  // Shot type: 3PT vs 2PT
  if (Math.random() < rates.fg3aShare) {
    // 3PT attempt
    isMake = Math.random() < rates.fg3Pct;
    if (isMake) shotPts = 3;
  } else {
    // 2PT attempt
    isMake = Math.random() < rates.fg2Pct;
    if (isMake) shotPts = 2;
  }

  // OREB on miss → bonus 2PT attempt (max 1 extra)
  if (!isMake && Math.random() < rates.orebRate) {
    if (Math.random() < rates.fg2Pct) shotPts = 2;
  }

  // Free throw opportunity (independent of shot outcome)
  // ftaRate = FTA per possession; divide by 2 to get foul-event rate
  // Each foul event = 2 FTA
  if (Math.random() < rates.ftaRate / 2) {
    if (Math.random() < rates.ftPct) shotPts += 1;
    if (Math.random() < rates.ftPct) shotPts += 1;
  }

  return shotPts;
}

/**
 * Run Monte Carlo simulation from current game state.
 *
 * @param {Object} homeRates  — {toRate, fg3aShare, fg3Pct, fg2Pct, orebRate, ftaRate, ftPct}
 * @param {Object} awayRates  — same shape
 * @param {number} homeScore  — current home points
 * @param {number} awayScore  — current away points
 * @param {number} remainPoss — estimated remaining possessions PER TEAM
 * @param {Object} opts       — {simCount: 1000, ctrlTeam: 'home'|'away'}
 * @returns {Object}          — {winProb, collapseProb, medianMargin, margin10pct, margin90pct, ...}
 */
function runMonteCarloSim(homeRates, awayRates, homeScore, awayScore, remainPoss, opts) {
  var simCount = (opts && opts.simCount) || 1000;
  var ctrlIsHome = (opts && opts.ctrlTeam === 'away') ? false : true;

  var margins = new Array(simCount);
  var ctrlWins = 0;
  var leadLost = 0;  // sims where leading team at start loses lead

  var currentMargin = homeScore - awayScore;  // home perspective
  var ctrlMargin = ctrlIsHome ? currentMargin : -currentMargin;
  var ctrlLeading = ctrlMargin > 0;

  for (var s = 0; s < simCount; s++) {
    var hScore = homeScore;
    var aScore = awayScore;
    var hPoss = Math.round(remainPoss);
    var aPoss = Math.round(remainPoss);

    // Alternate possessions (random first)
    var homeHasBall = Math.random() < 0.5;

    while (hPoss > 0 || aPoss > 0) {
      if (homeHasBall) {
        if (hPoss > 0) {
          hScore += simulatePossession(homeRates);
          hPoss--;
        }
      } else {
        if (aPoss > 0) {
          aScore += simulatePossession(awayRates);
          aPoss--;
        }
      }
      homeHasBall = !homeHasBall;
    }

    var finalMargin = ctrlIsHome ? (hScore - aScore) : (aScore - hScore);
    margins[s] = finalMargin;
    if (finalMargin > 0) ctrlWins++;
    else if (finalMargin === 0) ctrlWins += 0.5;  // ties = 0.5 wins

    // Collapse detection: ctrl was leading, sim ends with ctrl losing
    if (ctrlLeading && finalMargin <= 0) leadLost++;
  }

  // Sort margins for percentiles
  margins.sort(function(a, b) { return a - b; });

  var p10idx = Math.floor(simCount * 0.10);
  var p50idx = Math.floor(simCount * 0.50);
  var p90idx = Math.floor(simCount * 0.90);

  return {
    winProb:       Math.round(ctrlWins / simCount * 1000) / 1000,
    collapseProb:  ctrlLeading ? Math.round(leadLost / simCount * 1000) / 1000 : null,
    medianMargin:  margins[p50idx],
    margin10pct:   margins[p10idx],
    margin90pct:   margins[p90idx],
    currentMargin: ctrlMargin,
    simCount:      simCount,
    remainingPoss: Math.round(remainPoss),
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// RATE EXTRACTION — diff consecutive backtest checkpoints
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Diff two cumulative stat objects to get window rates.
 * Returns null if sample too small (< 5 FGA in window).
 */
function diffToRates(curr, prev, seasonFg3Pct, regressionCap) {
  var cap = regressionCap || 0.60;

  var fga = (curr.fga || 0) - (prev.fga || 0);
  var fgm = (curr.fgm || 0) - (prev.fgm || 0);
  var fg3a = (curr.fg3a || 0) - (prev.fg3a || 0);
  var fg3m = (curr.fg3m || 0) - (prev.fg3m || 0);
  var fta = (curr.fta || 0) - (prev.fta || 0);
  var ftm = (curr.ftm || 0) - (prev.ftm || 0);
  var to  = (curr.to  || 0) - (prev.to  || 0);
  var oreb = (curr.oreb || 0) - (prev.oreb || 0);

  var fg2a = fga - fg3a;
  var fg2m = fgm - fg3m;

  // Estimate possessions in window: FGA + 0.44*FTA - OREB + TO
  var poss = fga + 0.44 * fta - oreb + to;
  if (poss < 3) poss = Math.max(fga, 3);  // floor at 3

  if (fga < 5) return null;  // too few shots for stable rates

  // Raw rates
  var toRate = poss > 0 ? to / poss : 0.12;
  var fg3aShare = fga > 0 ? fg3a / fga : 0.35;
  var rawFg3Pct = fg3a > 0 ? fg3m / fg3a : 0.36;
  var fg2Pct = fg2a > 0 ? fg2m / fg2a : 0.50;
  var orebRate = (fga - fgm) > 0 ? oreb / (fga - fgm) : 0.25;
  var ftaRate = poss > 0 ? fta / poss : 0.20;
  var ftPct = fta > 0 ? ftm / fta : 0.76;

  // 3PT regression toward season baseline
  var baseline = seasonFg3Pct || 0.36;
  var sampleWeight = Math.min(cap, fg3a / 30);
  var fg3Pct = rawFg3Pct * sampleWeight + baseline * (1 - sampleWeight);

  // Clamp all rates to [0, 1]
  function clamp(v) { return Math.max(0, Math.min(1, v)); }

  return {
    toRate:     clamp(toRate),
    fg3aShare:  clamp(fg3aShare),
    fg3Pct:     clamp(fg3Pct),
    fg2Pct:     clamp(fg2Pct),
    orebRate:   clamp(orebRate),
    ftaRate:    Math.min(ftaRate, 1.0),  // can exceed 1 in foul-heavy windows
    ftPct:      clamp(ftPct),
    // Metadata for analysis
    _windowPoss: Math.round(poss),
    _windowFGA:  fga,
    _rawFg3Pct:  rawFg3Pct,
    _regressedFg3Pct: fg3Pct,
  };
}

/**
 * Estimate remaining possessions per team from cumulative stats + clock.
 */
function estimateRemainingPoss(homeStats, awayStats, period, clockSec) {
  // Possessions consumed so far
  function estPoss(s) {
    return (s.fga || 0) + 0.44 * (s.fta || 0) - (s.oreb || 0) + (s.to || 0);
  }
  var hPoss = estPoss(homeStats);
  var aPoss = estPoss(awayStats);
  var avgPoss = (hPoss + aPoss) / 2;

  // Elapsed minutes
  var elapsedMin = (Math.min(period, 4) - 1) * 12 + (12 - clockSec / 60);
  if (elapsedMin < 1) elapsedMin = 1;  // guard division by zero

  // Remaining minutes (regulation only)
  var remainMin = 48 - elapsedMin;
  if (remainMin < 0) remainMin = 0;

  // Pace → remaining possessions per team
  var pacePerMin = avgPoss / elapsedMin;
  var remainPoss = pacePerMin * remainMin;

  return Math.max(0, Math.round(remainPoss));
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: INIT — Create results table
// ══════════════════════════════════════════════════════════════════════════════

async function phaseInit(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS mc_backtest_results (
      game_id INTEGER NOT NULL,
      checkpoint TEXT NOT NULL,
      period INTEGER,
      clock_sec INTEGER,
      mc_win_prob REAL,
      mc_collapse_prob REAL,
      mc_median_margin REAL,
      mc_margin_10pct REAL,
      mc_margin_90pct REAL,
      xgb_win_prob REAL,
      floor_score REAL,
      margin_at_snapshot INTEGER,
      ctrl_team_won BOOLEAN,
      final_margin INTEGER,
      window_size INTEGER,
      regression_cap REAL,
      sim_count INTEGER,
      rate_source TEXT,
      window_possessions INTEGER,
      home_alias TEXT,
      away_alias TEXT,
      ctrl_team TEXT,
      PRIMARY KEY (game_id, checkpoint)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_mc_checkpoint ON mc_backtest_results(checkpoint)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_mc_ctrl_won ON mc_backtest_results(ctrl_team_won)`;

  return { status: 'ok', message: 'mc_backtest_results table ready', nextStep: '?phase=run&n=100&offset=0' };
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: RUN — Process batch of games from nba_snapshot_backtest
// ══════════════════════════════════════════════════════════════════════════════

async function phaseRun(sql, url) {
  var startTime = Date.now();
  var TIME_BUDGET_MS = 100000;  // 100s of 120s timeout
  var batchSize = parseInt(url.searchParams.get('n') || '100');
  var offset = parseInt(url.searchParams.get('offset') || '0');
  var windowSize = parseInt(url.searchParams.get('ws') || '2');
  var regressionCap = parseFloat(url.searchParams.get('rc') || '0.60');
  var simCount = parseInt(url.searchParams.get('sims') || '1000');
  var force = url.searchParams.get('force') === '1';

  // Get distinct game_ids from backtest table
  var gameIds;
  if (force) {
    gameIds = await sql`
      SELECT DISTINCT game_id
      FROM nba_snapshot_backtest
      WHERE indicators IS NOT NULL
      ORDER BY game_id
      LIMIT ${batchSize} OFFSET ${offset}
    `;
  } else {
    // Skip games already processed
    gameIds = await sql`
      SELECT DISTINCT s.game_id
      FROM nba_snapshot_backtest s
      LEFT JOIN mc_backtest_results mc ON mc.game_id = s.game_id
      WHERE s.indicators IS NOT NULL
        AND mc.game_id IS NULL
      ORDER BY s.game_id
      LIMIT ${batchSize}
    `;
  }

  if (gameIds.length === 0) {
    return { status: 'ok', message: 'No more games to process', nextStep: '?phase=analyze' };
  }

  var ids = gameIds.map(function(r) { return r.game_id; });

  // Fetch all checkpoints for these games in one query
  var rows = await sql`
    SELECT game_id, checkpoint,
           team_stats,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl_team,
           indicators->>'homeAlias' AS home_alias,
           indicators->>'awayAlias' AS away_alias,
           margin_at_snapshot AS margin,
           ctrl_team_won,
           final_margin
    FROM nba_snapshot_backtest
    WHERE game_id = ANY(${ids})
      AND indicators IS NOT NULL
      AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  // Group by game
  var gameMap = {};
  for (var r of rows) {
    if (!gameMap[r.game_id]) gameMap[r.game_id] = [];
    var ts = typeof r.team_stats === 'string' ? JSON.parse(r.team_stats) : r.team_stats;
    gameMap[r.game_id].push({
      checkpoint: r.checkpoint,
      cpIdx: CP_INDEX[r.checkpoint],
      home: ts ? ts.home : null,
      away: ts ? ts.away : null,
      floor: r.floor,
      ctrl_team: r.ctrl_team,
      home_alias: r.home_alias,
      away_alias: r.away_alias,
      margin: r.margin,
      ctrl_team_won: r.ctrl_team_won,
      final_margin: r.final_margin,
    });
  }

  // Sort each game's checkpoints by CP_INDEX order
  for (var gid of Object.keys(gameMap)) {
    gameMap[gid].sort(function(a, b) { return a.cpIdx - b.cpIdx; });
  }

  // Process each game
  var results = [];
  var gamesProcessed = 0;
  var checkpointsProcessed = 0;
  var skippedNoRates = 0;

  for (var gid of Object.keys(gameMap)) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;

    var cps = gameMap[gid];
    gamesProcessed++;

    // Walk checkpoints; MC eligible = Q2+ (cpIdx >= 2) with enough prior data
    for (var ci = 0; ci < cps.length; ci++) {
      var cp = cps[ci];
      if (cp.cpIdx < 2) continue;  // Skip Q1 checkpoints
      if (cp.checkpoint === 'Q4_END') continue;  // Game over, no remaining possessions

      // Need at least windowSize prior checkpoints
      if (ci < windowSize) continue;

      var meta = CP_META[cp.checkpoint];
      if (!meta) continue;

      // Diff current minus (current - windowSize) for rolling rates
      var prevCp = cps[ci - windowSize];
      if (!prevCp || !prevCp.home || !prevCp.away || !cp.home || !cp.away) {
        skippedNoRates++;
        continue;
      }

      var homeRates = diffToRates(cp.home, prevCp.home, 0.36, regressionCap);
      var awayRates = diffToRates(cp.away, prevCp.away, 0.36, regressionCap);

      if (!homeRates || !awayRates) {
        skippedNoRates++;
        continue;
      }

      // Remaining possessions
      var remainPoss = estimateRemainingPoss(cp.home, cp.away, meta.period, meta.clockSec);
      if (remainPoss < 1) continue;

      // Determine ctrl team perspective
      var ctrlIsHome = cp.ctrl_team === cp.home_alias;

      // Run MC simulation
      var mc = runMonteCarloSim(
        homeRates, awayRates,
        cp.home.pts || 0, cp.away.pts || 0,
        remainPoss,
        { simCount: simCount, ctrlTeam: ctrlIsHome ? 'home' : 'away' }
      );

      results.push({
        game_id: parseInt(gid),
        checkpoint: cp.checkpoint,
        period: meta.period,
        clock_sec: meta.clockSec,
        mc_win_prob: mc.winProb,
        mc_collapse_prob: mc.collapseProb,
        mc_median_margin: mc.medianMargin,
        mc_margin_10pct: mc.margin10pct,
        mc_margin_90pct: mc.margin90pct,
        xgb_win_prob: null,  // XGB not in backtest table — fill later if needed
        floor_score: cp.floor,
        margin: cp.margin,
        ctrl_team_won: cp.ctrl_team_won,
        final_margin: cp.final_margin,
        window_size: windowSize,
        regression_cap: regressionCap,
        sim_count: simCount,
        rate_source: ci >= windowSize ? 'window' : 'cumulative',
        window_poss: homeRates._windowPoss + awayRates._windowPoss,
        home_alias: cp.home_alias,
        away_alias: cp.away_alias,
        ctrl_team: cp.ctrl_team,
      });

      checkpointsProcessed++;
    }
  }

  // Batch insert results
  if (results.length > 0) {
    // Insert in chunks of 50 to stay under query size limits
    for (var ci2 = 0; ci2 < results.length; ci2 += 50) {
      var chunk = results.slice(ci2, ci2 + 50);
      for (var r2 of chunk) {
        await sql`
          INSERT INTO mc_backtest_results (
            game_id, checkpoint, period, clock_sec,
            mc_win_prob, mc_collapse_prob, mc_median_margin,
            mc_margin_10pct, mc_margin_90pct,
            xgb_win_prob, floor_score, margin_at_snapshot,
            ctrl_team_won, final_margin,
            window_size, regression_cap, sim_count, rate_source,
            window_possessions,
            home_alias, away_alias, ctrl_team
          ) VALUES (
            ${r2.game_id}, ${r2.checkpoint}, ${r2.period}, ${r2.clock_sec},
            ${r2.mc_win_prob}, ${r2.mc_collapse_prob}, ${r2.mc_median_margin},
            ${r2.mc_margin_10pct}, ${r2.mc_margin_90pct},
            ${r2.xgb_win_prob}, ${r2.floor_score}, ${r2.margin},
            ${r2.ctrl_team_won}, ${r2.final_margin},
            ${r2.window_size}, ${r2.regression_cap}, ${r2.sim_count}, ${r2.rate_source},
            ${r2.window_poss},
            ${r2.home_alias}, ${r2.away_alias}, ${r2.ctrl_team}
          )
          ON CONFLICT (game_id, checkpoint) DO UPDATE SET
            mc_win_prob = EXCLUDED.mc_win_prob,
            mc_collapse_prob = EXCLUDED.mc_collapse_prob,
            mc_median_margin = EXCLUDED.mc_median_margin,
            mc_margin_10pct = EXCLUDED.mc_margin_10pct,
            mc_margin_90pct = EXCLUDED.mc_margin_90pct,
            floor_score = EXCLUDED.floor_score,
            margin_at_snapshot = EXCLUDED.margin_at_snapshot,
            window_size = EXCLUDED.window_size,
            regression_cap = EXCLUDED.regression_cap,
            sim_count = EXCLUDED.sim_count,
            window_possessions = EXCLUDED.window_possessions
        `;
      }
    }
  }

  var remaining = await sql`
    SELECT COUNT(DISTINCT s.game_id) AS n
    FROM nba_snapshot_backtest s
    LEFT JOIN mc_backtest_results mc ON mc.game_id = s.game_id
    WHERE s.indicators IS NOT NULL AND mc.game_id IS NULL
  `;

  return {
    status: 'ok',
    gamesProcessed: gamesProcessed,
    checkpointsProcessed: checkpointsProcessed,
    skippedNoRates: skippedNoRates,
    resultsInserted: results.length,
    elapsed_ms: Date.now() - startTime,
    remaining: Number(remaining[0]?.n || 0),
    nextStep: Number(remaining[0]?.n || 0) > 0
      ? '?phase=run&n=100' + (force ? '&force=1&offset=' + (offset + batchSize) : '')
      : '?phase=analyze',
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: ANALYZE — Compute accuracy metrics
// ══════════════════════════════════════════════════════════════════════════════

async function phaseAnalyze(sql, url) {
  var segment = url?.searchParams?.get('segment') || 'all';

  // Overall stats
  var total = await sql`SELECT COUNT(*) AS n FROM mc_backtest_results`;
  var distinctGames = await sql`SELECT COUNT(DISTINCT game_id) AS n FROM mc_backtest_results`;

  // ── AUC approximation via concordance ──
  // For each pair: MC predicted higher for actual winner vs loser = concordant
  // Full pairwise is O(n²) — use bucket-based approximation
  var wins = await sql`
    SELECT mc_win_prob FROM mc_backtest_results WHERE ctrl_team_won = true
  `;
  var losses = await sql`
    SELECT mc_win_prob FROM mc_backtest_results WHERE ctrl_team_won = false
  `;

  var concordant = 0, discordant = 0, tied = 0;
  // Sample-based AUC: compare each win against a random sample of losses
  var sampleSize = Math.min(losses.length, 500);
  var lossSample = [];
  for (var li = 0; li < sampleSize; li++) {
    lossSample.push(losses[Math.floor(Math.random() * losses.length)].mc_win_prob);
  }
  for (var wi of wins) {
    for (var lp of lossSample) {
      if (wi.mc_win_prob > lp) concordant++;
      else if (wi.mc_win_prob < lp) discordant++;
      else tied++;
    }
  }
  var aucTotal = concordant + discordant + tied;
  var auc = aucTotal > 0 ? (concordant + 0.5 * tied) / aucTotal : 0.5;

  // ── Brier Score ──
  var brier = await sql`
    SELECT AVG(POWER(mc_win_prob - (CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END), 2)) AS brier
    FROM mc_backtest_results
  `;

  // ── Calibration buckets ──
  var calibration = await sql`
    SELECT
      FLOOR(mc_win_prob * 10)::int AS bucket,
      COUNT(*) AS n,
      AVG(CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END) AS actual_win_rate,
      AVG(mc_win_prob) AS avg_predicted
    FROM mc_backtest_results
    GROUP BY FLOOR(mc_win_prob * 10)::int
    ORDER BY bucket
  `;

  // ── Per-quarter accuracy ──
  var byQuarter = await sql`
    SELECT
      CASE WHEN period = 2 THEN 'Q2' WHEN period = 3 THEN 'Q3' WHEN period = 4 THEN 'Q4' ELSE 'Q1' END AS quarter,
      COUNT(*) AS n,
      AVG(CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END) AS actual_wr,
      AVG(mc_win_prob) AS avg_mc,
      AVG(POWER(mc_win_prob - (CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END), 2)) AS brier
    FROM mc_backtest_results
    GROUP BY CASE WHEN period = 2 THEN 'Q2' WHEN period = 3 THEN 'Q3' WHEN period = 4 THEN 'Q4' ELSE 'Q1' END
    ORDER BY quarter
  `;

  // ── Floor comparison AUC (bucket-based approximation) ──
  var floorWins = await sql`
    SELECT floor_score FROM mc_backtest_results WHERE ctrl_team_won = true AND floor_score IS NOT NULL
  `;
  var floorLosses = await sql`
    SELECT floor_score FROM mc_backtest_results WHERE ctrl_team_won = false AND floor_score IS NOT NULL
  `;
  var fC = 0, fD = 0, fT = 0;
  var fSample = [];
  var fSampleSize = Math.min(floorLosses.length, 500);
  for (var fi = 0; fi < fSampleSize; fi++) {
    fSample.push(floorLosses[Math.floor(Math.random() * floorLosses.length)].floor_score);
  }
  for (var fw of floorWins) {
    for (var fl of fSample) {
      if (fw.floor_score > fl) fC++;
      else if (fw.floor_score < fl) fD++;
      else fT++;
    }
  }
  var floorAucTotal = fC + fD + fT;
  var floorAuc = floorAucTotal > 0 ? (fC + 0.5 * fT) / floorAucTotal : 0.5;

  // ── Lead-change game analysis ──
  // Games where a team led by 10+ at some checkpoint but opponent won
  var leadChangeGames = await sql`
    WITH game_max_margins AS (
      SELECT game_id,
             MAX(ABS(margin_at_snapshot)) AS max_margin,
             MAX(CASE WHEN margin_at_snapshot > 0 THEN margin_at_snapshot ELSE 0 END) AS max_home_lead,
             MAX(CASE WHEN margin_at_snapshot < 0 THEN ABS(margin_at_snapshot) ELSE 0 END) AS max_away_lead,
             MIN(final_margin) AS final_margin,
             MIN(home_alias) AS home_alias
      FROM mc_backtest_results
      GROUP BY game_id
    )
    SELECT game_id, max_margin, max_home_lead, max_away_lead, final_margin, home_alias
    FROM game_max_margins
    WHERE (max_home_lead >= 10 AND final_margin < 0)
       OR (max_away_lead >= 10 AND final_margin > 0)
  `;

  var leadChangeIds = leadChangeGames.map(function(r) { return r.game_id; });

  var lcMcAccuracy = null;
  var lcFloorAccuracy = null;
  if (leadChangeIds.length > 0) {
    // MC AUC in lead-change games
    var lcWins = await sql`
      SELECT mc_win_prob FROM mc_backtest_results
      WHERE game_id = ANY(${leadChangeIds}) AND ctrl_team_won = true
    `;
    var lcLosses = await sql`
      SELECT mc_win_prob FROM mc_backtest_results
      WHERE game_id = ANY(${leadChangeIds}) AND ctrl_team_won = false
    `;
    var lcC = 0, lcD = 0, lcT = 0;
    var lcSample = [];
    var lcSampleSize = Math.min(lcLosses.length, 200);
    for (var lci = 0; lci < lcSampleSize; lci++) {
      lcSample.push(lcLosses[Math.floor(Math.random() * lcLosses.length)].mc_win_prob);
    }
    for (var lcw of lcWins) {
      for (var lcl of lcSample) {
        if (lcw.mc_win_prob > lcl) lcC++;
        else if (lcw.mc_win_prob < lcl) lcD++;
        else lcT++;
      }
    }
    var lcAucTot = lcC + lcD + lcT;
    lcMcAccuracy = lcAucTot > 0 ? (lcC + 0.5 * lcT) / lcAucTot : 0.5;

    // Floor AUC in lead-change games
    var lcFW = await sql`
      SELECT floor_score FROM mc_backtest_results
      WHERE game_id = ANY(${leadChangeIds}) AND ctrl_team_won = true AND floor_score IS NOT NULL
    `;
    var lcFL = await sql`
      SELECT floor_score FROM mc_backtest_results
      WHERE game_id = ANY(${leadChangeIds}) AND ctrl_team_won = false AND floor_score IS NOT NULL
    `;
    var lcFC = 0, lcFD = 0, lcFT2 = 0;
    var lcFSample = [];
    var lcFSS = Math.min(lcFL.length, 200);
    for (var lcfi = 0; lcfi < lcFSS; lcfi++) {
      lcFSample.push(lcFL[Math.floor(Math.random() * lcFL.length)].floor_score);
    }
    for (var lcfw of lcFW) {
      for (var lcfl of lcFSample) {
        if (lcfw.floor_score > lcfl) lcFC++;
        else if (lcfw.floor_score < lcfl) lcFD++;
        else lcFT2++;
      }
    }
    var lcFTot = lcFC + lcFD + lcFT2;
    lcFloorAccuracy = lcFTot > 0 ? (lcFC + 0.5 * lcFT2) / lcFTot : 0.5;
  }

  // ── Collapse probability precision ──
  var collapseThresholds = await sql`
    SELECT
      threshold,
      COUNT(*) FILTER (WHERE mc_collapse_prob >= threshold) AS flagged,
      COUNT(*) FILTER (WHERE mc_collapse_prob >= threshold AND NOT ctrl_team_won) AS correct_flags,
      CASE WHEN COUNT(*) FILTER (WHERE mc_collapse_prob >= threshold) > 0
        THEN ROUND(COUNT(*) FILTER (WHERE mc_collapse_prob >= threshold AND NOT ctrl_team_won)::numeric /
             COUNT(*) FILTER (WHERE mc_collapse_prob >= threshold)::numeric, 3)
        ELSE 0 END AS precision
    FROM mc_backtest_results,
         unnest(ARRAY[0.15, 0.20, 0.25, 0.30, 0.35, 0.40]) AS threshold
    WHERE mc_collapse_prob IS NOT NULL
    GROUP BY threshold
    ORDER BY threshold
  `;

  return {
    status: 'ok',
    overview: {
      totalCheckpoints: Number(total[0]?.n || 0),
      distinctGames: Number(distinctGames[0]?.n || 0),
      mc_auc: Math.round(auc * 1000) / 1000,
      floor_auc: Math.round(floorAuc * 1000) / 1000,
      brier_score: Math.round(Number(brier[0]?.brier || 0) * 10000) / 10000,
    },
    calibration: calibration.map(function(b) {
      return {
        bucket: b.bucket * 10 + '-' + (b.bucket * 10 + 10) + '%',
        n: Number(b.n),
        predicted: Math.round(Number(b.avg_predicted) * 1000) / 10,
        actual: Math.round(Number(b.actual_win_rate) * 1000) / 10,
        delta: Math.round((Number(b.actual_win_rate) - Number(b.avg_predicted)) * 1000) / 10,
      };
    }),
    byQuarter: byQuarter.map(function(q) {
      return {
        quarter: q.quarter,
        n: Number(q.n),
        actual_wr: Math.round(Number(q.actual_wr) * 1000) / 10,
        avg_mc: Math.round(Number(q.avg_mc) * 1000) / 10,
        brier: Math.round(Number(q.brier) * 10000) / 10000,
      };
    }),
    leadChangeGames: {
      count: leadChangeIds.length,
      mc_auc: lcMcAccuracy ? Math.round(lcMcAccuracy * 1000) / 1000 : null,
      floor_auc: lcFloorAccuracy ? Math.round(lcFloorAccuracy * 1000) / 1000 : null,
      games: leadChangeGames.slice(0, 10).map(function(g) {
        return { game_id: g.game_id, max_margin: g.max_margin, final_margin: g.final_margin };
      }),
    },
    collapseThresholds: collapseThresholds.map(function(t) {
      return {
        threshold: Number(t.threshold),
        flagged: Number(t.flagged),
        correct: Number(t.correct_flags),
        precision: Number(t.precision),
      };
    }),
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: VALIDATE_GAME — Run MC against prod game snapshots (e.g. DET@ORL)
// ══════════════════════════════════════════════════════════════════════════════

async function phaseValidateGame(sql, url) {
  var gameId = url.searchParams.get('game_id');
  if (!gameId) return { error: 'game_id required' };

  var simCount = parseInt(url.searchParams.get('sims') || '1000');
  var regressionCap = parseFloat(url.searchParams.get('rc') || '0.60');

  // Pull prod snapshots for this game
  var snapshots = await sql`
    SELECT id, game_id, period, clock, source,
           raw_stats_json, floor_score, floor_team,
           xgb_win_prob, i1, i2, i3, i4, i5,
           home_pts, away_pts, ts
    FROM snapshots
    WHERE game_id = ${gameId}
      AND source = 'server'
      AND raw_stats_json IS NOT NULL
    ORDER BY period ASC, clock DESC
  `;

  if (snapshots.length === 0) {
    return { error: 'No server snapshots found for game ' + gameId };
  }

  // Get game outcome
  var game = await sql`SELECT * FROM games WHERE id = ${gameId} LIMIT 1`;
  var g = game[0];
  if (!g) return { error: 'Game not found: ' + gameId };

  var results = [];
  var LOOKBACK = parseInt(url.searchParams.get('lb') || '5');  // ~5 minutes back

  // Parse all raw_stats upfront
  var parsed = [];
  for (var si = 0; si < snapshots.length; si++) {
    var snap = snapshots[si];
    var raw = typeof snap.raw_stats_json === 'string'
      ? JSON.parse(snap.raw_stats_json) : snap.raw_stats_json;
    parsed.push({
      snap: snap,
      homeStats: raw ? extractProdStats(raw, g.home_alias || g.home_team, true) : null,
      awayStats: raw ? extractProdStats(raw, g.away_alias || g.away_team, false) : null,
    });
  }

  for (var si = LOOKBACK; si < parsed.length; si++) {
    var curr = parsed[si];
    var prev = parsed[si - LOOKBACK];
    var snap = curr.snap;

    if (snap.period < 2) continue;
    if (!curr.homeStats || !curr.awayStats || !prev.homeStats || !prev.awayStats) continue;

    var homeRates = diffToRates(curr.homeStats, prev.homeStats, 0.36, regressionCap);
    var awayRates = diffToRates(curr.awayStats, prev.awayStats, 0.36, regressionCap);

    if (!homeRates || !awayRates) continue;

    // Parse clock
    var clockSec = 360;
    try {
      var parts = String(snap.clock || '6:00').split(':');
      clockSec = parseInt(parts[0]) * 60 + parseInt(parts[1] || 0);
    } catch(e) {}

    var remainPoss = estimateRemainingPoss(curr.homeStats, curr.awayStats, snap.period, clockSec);
    if (remainPoss < 1) continue;

    var ctrlIsHome = snap.floor_team === (g.home_alias || g.home_team);

    var mc = runMonteCarloSim(
      homeRates, awayRates,
      snap.home_pts || 0, snap.away_pts || 0,
      remainPoss,
      { simCount: simCount, ctrlTeam: ctrlIsHome ? 'home' : 'away' }
    );

    results.push({
      period: snap.period,
      clock: snap.clock,
      score: (snap.home_pts || 0) + '-' + (snap.away_pts || 0),
      margin: (snap.home_pts || 0) - (snap.away_pts || 0),
      floor: snap.floor_score,
      floor_team: snap.floor_team,
      xgb: snap.xgb_win_prob,
      mc_winProb: mc.winProb,
      mc_collapse: mc.collapseProb,
      mc_median: mc.medianMargin,
      mc_range: mc.margin10pct + ' to ' + mc.margin90pct,
      remainPoss: mc.remainingPoss,
      windowPoss: homeRates._windowPoss + awayRates._windowPoss,
      xgb_mc_divergence: snap.xgb_win_prob != null
        ? Math.round((snap.xgb_win_prob - mc.winProb) * 1000) / 1000 : null,
    });
  }

  return {
    status: 'ok',
    game: {
      id: gameId,
      matchup: (g.away_alias || g.away_team) + ' @ ' + (g.home_alias || g.home_team),
      final: g.home_pts + '-' + g.away_pts,
      winner: g.winner,
    },
    snapshots: results.length,
    timeline: results,
  };
}

/**
 * Extract normalized stats from prod raw_stats_json.
 * Prod format varies (BDL summary with team arrays, or direct stats object).
 * Returns {pts, fgm, fga, fg3m, fg3a, ftm, fta, to, oreb} or null.
 */
function extractProdStats(raw, teamAlias, isHome) {
  if (!raw) return null;

  var side = isHome ? 'home' : 'away';

  // Format 1: raw has home/away with .statistics wrapper (SR summary format)
  if (raw[side] && raw[side].statistics) {
    var s = raw[side].statistics;
    return {
      pts: Number(s.points || 0),
      fgm: Number(s.field_goals_made || 0),
      fga: Number(s.field_goals_att || 0),
      fg3m: Number(s.three_points_made || 0),
      fg3a: Number(s.three_points_att || 0),
      ftm: Number(s.free_throws_made || 0),
      fta: Number(s.free_throws_att || 0),
      to:  Number(s.turnovers || s.total_turnovers || 0),
      oreb: Number(s.offensive_rebounds || 0),
    };
  }

  // Format 2: prod raw_stats_json — flat object with short keys (fgm, fga, fg3m, etc.)
  // This format does NOT have pts — caller must use snapshot home_pts/away_pts
  if (raw[side] && (raw[side].fgm !== undefined || raw[side].fga !== undefined)) {
    var d = raw[side];
    // Compute pts from shot stats: (fgm - fg3m)*2 + fg3m*3 + ftm
    var fgm = Number(d.fgm || 0);
    var fg3m = Number(d.fg3m || 0);
    var ftm = Number(d.ftm || 0);
    var computedPts = (fgm - fg3m) * 2 + fg3m * 3 + ftm;
    return {
      pts: Number(d.pts || d.points || computedPts),
      fgm: fgm,
      fga: Number(d.fga || 0),
      fg3m: fg3m,
      fg3a: Number(d.fg3a || 0),
      ftm: ftm,
      fta: Number(d.fta || 0),
      to:  Number(d.to || d.turnovers || 0),
      oreb: Number(d.oreb || d.offensive_rebounds || 0),
    };
  }

  return null;
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: VALIDATE_GAME_V2 — Production-fidelity MC using computeServerWindow
//   reconstruction from quarter_data boundaries + snapshot cumulative stats
// ══════════════════════════════════════════════════════════════════════════════

// Map raw_stats_json short keys → boundary long keys
function toLongKeys(short) {
  if (!short) return {};
  return {
    field_goals_made: Number(short.fgm || 0),
    field_goals_att: Number(short.fga || 0),
    three_points_made: Number(short.fg3m || 0),
    three_points_att: Number(short.fg3a || 0),
    free_throws_made: Number(short.ftm || 0),
    free_throws_att: Number(short.fta || 0),
    turnovers: Number(short.to || 0),
    offensive_rebounds: Number(short.oreb || 0),
    steals: Number(short.stl || 0),
    blocks: Number(short.blk || 0),
    assists: Number(short.ast || 0),
    points_in_paint: Number(short.paint || 0),
    points_off_turnovers: Number(short.pot || 0),
    second_chance_points: Number(short.scp || 0),
    fast_break_points: Number(short.fbp || 0),
    fouls_drawn: Number(short.fd || 0),
    bench_points: Number(short.bench || 0),
    possessions: Number(short.poss || 0),
    points: Number(short.pts || 0),
  };
}

// Diff two long-key stat objects (current - previous)
function diffLongKeys(curr, prev) {
  var d = {};
  var keys = Object.keys(curr);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    d[k] = (curr[k] || 0) - (prev[k] || 0);
  }
  return d;
}

// Reconstruct rolling window rates and extract MC rates
// mode = 'production' (full computeServerWindow cross-fade) or 'responsive' (partial quarter priority)
function reconstructWindowRates(qd, snapRaw, period, clockStr, regressionCap, mode) {
  if (!qd || !qd.boundaries || !qd.diffs || period < 2) return null;

  // Parse clock
  var clockParts = (clockStr || '12:00').split(':');
  var clockMins = parseInt(clockParts[0]) + (parseInt(clockParts[1] || 0) / 60);
  var completion = Math.max(0, Math.min(1, (12 - clockMins) / 12));

  // Convert snapshot cumulative to long keys
  var homeCurr = toLongKeys(snapRaw.home);
  var awayCurr = toLongKeys(snapRaw.away);

  // Find last completed boundary
  var completedKeys = Object.keys(qd.diffs).map(Number).filter(function(n) { return !isNaN(n); }).sort(function(a,b) { return a-b; });
  if (completedKeys.length === 0) return null;

  // Last boundary that's BEFORE our current period
  var lastBK = 0;
  for (var ci = 0; ci < completedKeys.length; ci++) {
    if (completedKeys[ci] < period) lastBK = completedKeys[ci];
  }
  var boundary = qd.boundaries[String(lastBK)];
  if (!boundary || !boundary.home || !boundary.away) return null;

  // Partial current quarter = current cumulative - last boundary
  var partialHome = diffLongKeys(homeCurr, boundary.home);
  var partialAway = diffLongKeys(awayCurr, boundary.away);
  var partialDiff = { home: partialHome, away: partialAway };

  var windowQs = [];
  var p = period;

  if (mode === 'responsive') {
    // RESPONSIVE MODE: use partial current quarter as primary.
    // Only blend in last completed quarter if partial has < 10 FGA per side.
    var partialFGA = (partialHome.field_goals_att || 0) + (partialAway.field_goals_att || 0);
    if (partialFGA >= 20) {
      // Enough volume — use partial only (~5-10 min window)
      windowQs.push({ weight: 1.0, diff: partialDiff });
    } else {
      // Not enough volume — add last completed quarter, weight partial higher
      var prevQKey = String(Math.max(...completedKeys.filter(function(k) { return k < p; })));
      if (qd.diffs[prevQKey]) {
        windowQs.push({ weight: 0.5, diff: qd.diffs[prevQKey] });
      }
      windowQs.push({ weight: 1.0, diff: partialDiff });
    }
  } else {
    // PRODUCTION MODE: full computeServerWindow cross-fade
    if (p === 2) {
      if (qd.diffs['1']) windowQs.push({ weight: Math.max(0, 1.0 - completion), diff: qd.diffs['1'] });
      windowQs.push({ weight: 1.0, diff: partialDiff });
    } else if (p === 3) {
      if (qd.diffs['2']) windowQs.push({ weight: 1.0, diff: qd.diffs['2'] });
      windowQs.push({ weight: 1.0, diff: partialDiff });
    } else if (p === 4) {
      if (qd.diffs['2']) windowQs.push({ weight: Math.max(0, 1.0 - completion), diff: qd.diffs['2'] });
      if (qd.diffs['3']) windowQs.push({ weight: 1.0, diff: qd.diffs['3'] });
      windowQs.push({ weight: 1.0, diff: partialDiff });
    } else if (p >= 5) {
      if (qd.diffs['3']) windowQs.push({ weight: Math.max(0, 1.0 - completion), diff: qd.diffs['3'] });
      if (qd.diffs['4']) windowQs.push({ weight: 1.0, diff: qd.diffs['4'] });
      windowQs.push({ weight: 1.0, diff: partialDiff });
    }
  }

  if (windowQs.length === 0) return null;

  // Aggregate stats with cross-fade weights (per side)
  function aggSide(side) {
    var keys = ['field_goals_made','field_goals_att','three_points_made','three_points_att',
                'free_throws_made','free_throws_att','turnovers','offensive_rebounds','possessions','points'];
    var agg = {};
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki];
      var sum = 0, hasAny = false;
      for (var wi = 0; wi < windowQs.length; wi++) {
        var v = windowQs[wi].diff[side] ? windowQs[wi].diff[side][k] : null;
        if (v != null) { sum += v * windowQs[wi].weight; hasAny = true; }
      }
      agg[k] = hasAny ? sum : 0;
    }
    return agg;
  }

  var hAgg = aggSide('home');
  var aAgg = aggSide('away');

  // Convert aggregated window stats → MC rates
  var cap = regressionCap || 0.60;
  function toMCRates(agg) {
    var fga = agg.field_goals_att || 1;
    var fgm = agg.field_goals_made || 0;
    var fg3a = agg.three_points_att || 0;
    var fg3m = agg.three_points_made || 0;
    var fta = agg.free_throws_att || 0;
    var ftm = agg.free_throws_made || 0;
    var to = agg.turnovers || 0;
    var oreb = agg.offensive_rebounds || 0;
    var poss = agg.possessions || (fga + 0.44 * fta - oreb + to);
    if (poss < 3) poss = Math.max(fga, 3);
    var fg2a = fga - fg3a;
    var fg2m = fgm - fg3m;

    var rawFg3Pct = fg3a > 0 ? fg3m / fg3a : 0.36;
    var sampleWeight = Math.min(cap, fg3a / 30);
    var fg3Pct = rawFg3Pct * sampleWeight + 0.36 * (1 - sampleWeight);

    function clamp(v) { return Math.max(0, Math.min(1, v)); }
    return {
      toRate: clamp(poss > 0 ? to / poss : 0.12),
      fg3aShare: clamp(fga > 0 ? fg3a / fga : 0.35),
      fg3Pct: clamp(fg3Pct),
      fg2Pct: clamp(fg2a > 0 ? fg2m / fg2a : 0.50),
      orebRate: clamp((fga - fgm) > 0 ? oreb / (fga - fgm) : 0.25),
      ftaRate: Math.min(poss > 0 ? fta / poss : 0.20, 1.0),
      ftPct: clamp(fta > 0 ? ftm / fta : 0.76),
      _windowFGA: fga,
      _windowPoss: Math.round(poss),
    };
  }

  return { home: toMCRates(hAgg), away: toMCRates(aAgg) };
}


// ══════════════════════════════════════════════════════════════════════════════
// POSSESSION-TARGETING WINDOW — adaptive lookback to hit N possessions
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Walk backwards through parsed snapshots to find window with targetPoss possessions.
 * Returns MC rates or null if insufficient data.
 * parsedSnaps = [{home: {fgm,fga,...}, away: {fgm,fga,...}}, ...]
 */
function possessionWindowRates(parsedSnaps, currentIdx, targetPoss, regressionCap) {
  if (currentIdx < 1) return null;
  var curr = parsedSnaps[currentIdx];
  if (!curr.home || !curr.away) return null;

  // Walk backwards until possession diff >= target
  for (var i = currentIdx - 1; i >= 0; i--) {
    var prev = parsedSnaps[i];
    if (!prev.home || !prev.away) continue;

    var hFGA = (curr.home.fga || 0) - (prev.home.fga || 0);
    var hTO  = (curr.home.to  || 0) - (prev.home.to  || 0);
    var aFGA = (curr.away.fga || 0) - (prev.away.fga || 0);
    var aTO  = (curr.away.to  || 0) - (prev.away.to  || 0);
    var avgPoss = ((hFGA + hTO) + (aFGA + aTO)) / 2;

    if (avgPoss >= targetPoss) {
      var homeRates = diffToRates(curr.home, prev.home, 0.36, regressionCap);
      var awayRates = diffToRates(curr.away, prev.away, 0.36, regressionCap);
      if (!homeRates || !awayRates) return null;
      homeRates._windowPossActual = Math.round(hFGA + hTO);
      awayRates._windowPossActual = Math.round(aFGA + aTO);
      return { home: homeRates, away: awayRates };
    }
  }
  return null;  // not enough game played yet
}

/**
 * Parse raw_stats_json short keys into MC-compatible format.
 */
function parseSnapForMC(raw) {
  if (!raw || !raw.home || !raw.away) return null;
  function side(d) {
    return {
      pts:  Number(d.pts || 0) || ((Number(d.fgm||0) - Number(d.fg3m||0)) * 2 + Number(d.fg3m||0) * 3 + Number(d.ftm||0)),
      fgm:  Number(d.fgm || 0),
      fga:  Number(d.fga || 0),
      fg3m: Number(d.fg3m || 0),
      fg3a: Number(d.fg3a || 0),
      ftm:  Number(d.ftm || 0),
      fta:  Number(d.fta || 0),
      to:   Number(d.to || 0),
      oreb: Number(d.oreb || 0),
    };
  }
  return { home: side(raw.home), away: side(raw.away) };
}


async function phaseValidateGameV2(sql, url) {
  var gameId = url.searchParams.get('game_id');
  if (!gameId) return { error: 'game_id required' };

  var simCount = parseInt(url.searchParams.get('sims') || '1000');
  var regressionCap = parseFloat(url.searchParams.get('rc') || '0.60');
  var mode = url.searchParams.get('mode') || 'responsive';  // 'responsive', 'production', or 'poss_30' etc.
  var targetPoss = null;
  var isPossMode = mode.startsWith('poss_');
  if (isPossMode) targetPoss = parseInt(mode.split('_')[1]) || 30;

  // Pull quarter_data (not needed for poss mode but used for responsive/production)
  var qd = null;
  if (!isPossMode) {
    var qdRows = await sql`SELECT quarter_data FROM games WHERE id = ${gameId}`;
    qd = qdRows[0]?.quarter_data;
    if (!qd) return { error: 'No quarter_data for game ' + gameId };
    if (typeof qd === 'string') qd = JSON.parse(qd);
  }

  // Pull game info
  var game = await sql`SELECT * FROM games WHERE id = ${gameId} LIMIT 1`;
  var g = game[0];
  if (!g) return { error: 'Game not found: ' + gameId };

  // Pull server snapshots — include Q1 for possession mode (lookback needs early data)
  var minPeriod = isPossMode ? 1 : 2;
  var snapshots = await sql`
    SELECT id, period, clock, source,
           raw_stats_json, floor_score, floor_team,
           xgb_win_prob, home_pts, away_pts, ts
    FROM snapshots
    WHERE game_id = ${gameId}
      AND source = 'server'
      AND raw_stats_json IS NOT NULL
      AND period >= ${minPeriod}
    ORDER BY period ASC, clock DESC
  `;

  if (snapshots.length === 0) {
    return { error: 'No server snapshots for game ' + gameId };
  }

  // Pre-parse all snapshots for possession mode
  var allParsed = [];
  for (var pi = 0; pi < snapshots.length; pi++) {
    var rawP = typeof snapshots[pi].raw_stats_json === 'string'
      ? JSON.parse(snapshots[pi].raw_stats_json) : snapshots[pi].raw_stats_json;
    allParsed.push(parseSnapForMC(rawP));
  }

  var results = [];

  for (var si = 0; si < snapshots.length; si++) {
    var snap = snapshots[si];
    if (snap.period < 2) continue;  // still skip Q1 for MC output

    var raw = typeof snap.raw_stats_json === 'string'
      ? JSON.parse(snap.raw_stats_json) : snap.raw_stats_json;
    if (!raw || !raw.home || !raw.away) continue;

    // Get rates based on mode
    var windowRates = null;
    if (isPossMode) {
      windowRates = possessionWindowRates(allParsed, si, targetPoss, regressionCap);
    } else {
      windowRates = reconstructWindowRates(qd, raw, snap.period, snap.clock, regressionCap, mode);
    }
    if (!windowRates) continue;
    if (windowRates.home._windowFGA < 5 || windowRates.away._windowFGA < 5) continue;

    // Parse clock for remaining poss
    var clockSec = 360;
    try {
      var parts = String(snap.clock || '6:00').split(':');
      clockSec = parseInt(parts[0]) * 60 + parseInt(parts[1] || 0);
    } catch(e) {}

    // Remaining possessions from cumulative stats
    var cumStats = isPossMode ? allParsed[si] : null;
    var homeCumForPoss = isPossMode
      ? { fga: cumStats.home.fga, fta: cumStats.home.fta, oreb: cumStats.home.oreb, to: cumStats.home.to }
      : (function() { var h = toLongKeys(raw.home); return { fga: h.field_goals_att, fta: h.free_throws_att, oreb: h.offensive_rebounds, to: h.turnovers }; })();
    var awayCumForPoss = isPossMode
      ? { fga: cumStats.away.fga, fta: cumStats.away.fta, oreb: cumStats.away.oreb, to: cumStats.away.to }
      : (function() { var a = toLongKeys(raw.away); return { fga: a.field_goals_att, fta: a.free_throws_att, oreb: a.offensive_rebounds, to: a.turnovers }; })();
    var remainPoss = estimateRemainingPoss(homeCumForPoss, awayCumForPoss, snap.period, clockSec);
    if (remainPoss < 1) continue;

    var ctrlIsHome = snap.floor_team === g.home_alias;

    var mc = runMonteCarloSim(
      windowRates.home, windowRates.away,
      snap.home_pts || 0, snap.away_pts || 0,
      remainPoss,
      { simCount: simCount, ctrlTeam: ctrlIsHome ? 'home' : 'away' }
    );

    results.push({
      period: snap.period,
      clock: snap.clock,
      score: (snap.home_pts || 0) + '-' + (snap.away_pts || 0),
      margin: (snap.home_pts || 0) - (snap.away_pts || 0),
      floor: snap.floor_score,
      floor_team: snap.floor_team,
      xgb: snap.xgb_win_prob,
      mc_winProb: mc.winProb,
      mc_collapse: mc.collapseProb,
      mc_median: mc.medianMargin,
      mc_range: mc.margin10pct + ' to ' + mc.margin90pct,
      remainPoss: mc.remainingPoss,
      windowFGA: windowRates.home._windowFGA + windowRates.away._windowFGA,
      xgb_mc_divergence: snap.xgb_win_prob != null
        ? Math.round((snap.xgb_win_prob - mc.winProb) * 1000) / 1000 : null,
    });
  }

  return {
    status: 'ok',
    version: 'v2_' + mode,
    rateSource: isPossMode ? 'possession_window_' + targetPoss : (mode === 'responsive' ? 'partial_quarter_priority' : 'computeServerWindow_reconstruction'),
    game: {
      id: gameId,
      matchup: (g.away_alias || g.away_team) + ' @ ' + (g.home_alias || g.home_team),
      final: g.home_pts + '-' + g.away_pts,
      winner: g.winner,
    },
    snapshots: results.length,
    timeline: results,
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: VALIDATE_SLATE — Run MC on multiple playoff games, report per-game summary
//   ?phase=validate_slate&from=2026-04-18&to=2026-05-02&mode=responsive&n=10&offset=0
// ══════════════════════════════════════════════════════════════════════════════

async function phaseValidateSlate(sql, url) {
  var fromDate = url.searchParams.get('from') || '2026-04-18';
  var toDate = url.searchParams.get('to') || '2026-05-02';
  var mode = url.searchParams.get('mode') || 'responsive';
  var regressionCap = parseFloat(url.searchParams.get('rc') || '0.60');
  var simCount = parseInt(url.searchParams.get('sims') || '500');
  var batchSize = parseInt(url.searchParams.get('n') || '10');
  var offset = parseInt(url.searchParams.get('offset') || '0');

  var isPossMode = mode.startsWith('poss_');
  var isDualMode = mode.startsWith('dual_');
  var targetPoss = isPossMode ? (parseInt(mode.split('_')[1]) || 30) : null;
  var dualShort = null, dualLong = null;
  if (isDualMode) {
    var parts = mode.split('_');  // dual_30_60
    dualShort = parseInt(parts[1]) || 30;
    dualLong = parseInt(parts[2]) || 60;
    isPossMode = true;  // dual mode uses possession windows
  }

  var games = await sql`
    SELECT id, date, home_alias, away_alias, home_pts, away_pts, winner, quarter_data
    FROM games
    WHERE date >= ${fromDate} AND date <= ${toDate}
      AND winner IS NOT NULL AND quarter_data IS NOT NULL
    ORDER BY date ASC, id ASC
    LIMIT ${batchSize} OFFSET ${offset}
  `;

  var totalGames = await sql`
    SELECT COUNT(*) AS n FROM games
    WHERE date >= ${fromDate} AND date <= ${toDate}
      AND winner IS NOT NULL AND quarter_data IS NOT NULL
  `;

  // Aggregate divergence precision across all games
  var divBuckets = { '0.20': { flagged: 0, mcRight: 0 }, '0.30': { flagged: 0, mcRight: 0 }, '0.40': { flagged: 0, mcRight: 0 } };
  var summaries = [];

  for (var gi = 0; gi < games.length; gi++) {
    var g = games[gi];
    var qd = typeof g.quarter_data === 'string' ? JSON.parse(g.quarter_data) : g.quarter_data;
    if (!isPossMode && (!qd || !qd.boundaries)) { summaries.push({ matchup: (g.away_alias||'?')+'@'+(g.home_alias||'?'), error: 'no quarter_data' }); continue; }

    var minPeriod = isPossMode ? 1 : 2;
    var snaps = await sql`
      SELECT period, clock, raw_stats_json, floor_score, floor_team,
             xgb_win_prob, home_pts, away_pts
      FROM snapshots
      WHERE game_id = ${g.id} AND source = 'server' AND raw_stats_json IS NOT NULL AND period >= ${minPeriod}
      ORDER BY period ASC, clock DESC
    `;
    if (snaps.length === 0) { summaries.push({ matchup: (g.away_alias||'?')+'@'+(g.home_alias||'?'), error: 'no snapshots' }); continue; }

    // Pre-parse for possession mode
    var allParsed = [];
    if (isPossMode) {
      for (var pi = 0; pi < snaps.length; pi++) {
        var rawP = typeof snaps[pi].raw_stats_json === 'string' ? JSON.parse(snaps[pi].raw_stats_json) : snaps[pi].raw_stats_json;
        allParsed.push(parseSnapForMC(rawP));
      }
    }

    var firstCrack = null, firstAlarm = null;
    var maxDiv = 0, maxDivSnap = null;
    var mcCorrect = 0, mcTotal = 0;
    var q3Divergences = [];
    var firstDualFire = null;  // first dual-confirmed divergence
    var dualFireCount = 0;
    var seen = {};

    for (var si = 0; si < snaps.length; si++) {
      var snap = snaps[si];
      if (snap.period < 2) continue;
      var snapKey = snap.period + '_' + snap.clock + '_' + snap.home_pts;
      if (seen[snapKey]) continue;
      seen[snapKey] = true;

      var raw = typeof snap.raw_stats_json === 'string' ? JSON.parse(snap.raw_stats_json) : snap.raw_stats_json;
      if (!raw || !raw.home || !raw.away) continue;

      var windowRates = null;
      var windowRatesLong = null;  // for dual mode
      if (isDualMode) {
        windowRates = possessionWindowRates(allParsed, si, dualShort, regressionCap);
        windowRatesLong = possessionWindowRates(allParsed, si, dualLong, regressionCap);
      } else if (isPossMode) {
        windowRates = possessionWindowRates(allParsed, si, targetPoss, regressionCap);
      } else {
        windowRates = reconstructWindowRates(qd, raw, snap.period, snap.clock, regressionCap, mode);
      }
      if (!windowRates || windowRates.home._windowFGA < 5 || windowRates.away._windowFGA < 5) continue;

      var clockSec = 360;
      try { var pts2 = String(snap.clock || '6:00').split(':'); clockSec = parseInt(pts2[0]) * 60 + parseInt(pts2[1] || 0); } catch(e) {}

      var cumForPoss = isPossMode ? allParsed[si] : null;
      var hCum = isPossMode
        ? { fga: cumForPoss.home.fga, fta: cumForPoss.home.fta, oreb: cumForPoss.home.oreb, to: cumForPoss.home.to }
        : (function() { var h = toLongKeys(raw.home); return { fga: h.field_goals_att, fta: h.free_throws_att, oreb: h.offensive_rebounds, to: h.turnovers }; })();
      var aCum = isPossMode
        ? { fga: cumForPoss.away.fga, fta: cumForPoss.away.fta, oreb: cumForPoss.away.oreb, to: cumForPoss.away.to }
        : (function() { var a = toLongKeys(raw.away); return { fga: a.field_goals_att, fta: a.free_throws_att, oreb: a.offensive_rebounds, to: a.turnovers }; })();

      var remainPoss = estimateRemainingPoss(hCum, aCum, snap.period, clockSec);
      if (remainPoss < 1) continue;

      var ctrlIsHome = snap.floor_team === g.home_alias;
      var ctrlWon = snap.floor_team === g.winner;
      var mcOpts = { simCount: simCount, ctrlTeam: ctrlIsHome ? 'home' : 'away' };

      // Run MC — short window (or single window for non-dual)
      var mc = runMonteCarloSim(windowRates.home, windowRates.away,
        snap.home_pts || 0, snap.away_pts || 0, remainPoss, mcOpts);

      // Run MC — long window (dual mode only)
      var mcLong = null;
      if (isDualMode && windowRatesLong && windowRatesLong.home._windowFGA >= 5 && windowRatesLong.away._windowFGA >= 5) {
        mcLong = runMonteCarloSim(windowRatesLong.home, windowRatesLong.away,
          snap.home_pts || 0, snap.away_pts || 0, remainPoss, mcOpts);
      }

      mcTotal++;
      if ((mc.winProb > 0.5 && ctrlWon) || (mc.winProb < 0.5 && !ctrlWon)) mcCorrect++;

      // Divergence tracking
      var xgb = snap.xgb_win_prob;
      if (xgb != null) {
        var divShort = xgb - mc.winProb;
        var divLong = mcLong ? (xgb - mcLong.winProb) : null;

        // For max divergence tracking, use short window (most responsive)
        if (Math.abs(divShort) > Math.abs(maxDiv)) {
          maxDiv = divShort;
          maxDivSnap = { period: snap.period, clock: snap.clock, score: (snap.home_pts||0)+'-'+(snap.away_pts||0), margin: (snap.home_pts||0)-(snap.away_pts||0), xgb: xgb, mc: mc.winProb, mcLong: mcLong ? mcLong.winProb : null, collapse: mc.collapseProb };
        }
        if (snap.period === 3) q3Divergences.push(divShort);

        // Divergence precision: flag only when BOTH windows confirm (dual) or single window (non-dual)
        for (var th of ['0.20','0.30','0.40']) {
          var threshold = parseFloat(th);
          var confirmed = false;
          if (isDualMode) {
            // DUAL: both short AND long must exceed threshold
            confirmed = divShort > threshold && divLong !== null && divLong > threshold;
          } else {
            confirmed = divShort > threshold;
          }
          if (confirmed) {
            divBuckets[th].flagged++;
            if (!ctrlWon) divBuckets[th].mcRight++;
            // Track first dual-confirmed fire per game (at 0.20 threshold)
            if (th === '0.20' && !firstDualFire) {
              firstDualFire = { period: snap.period, clock: snap.clock, score: (snap.home_pts||0)+'-'+(snap.away_pts||0), margin: (snap.home_pts||0)-(snap.away_pts||0), mc: mc.winProb, mcLong: mcLong ? mcLong.winProb : null, xgb: xgb, floor_team: snap.floor_team, ctrlWon: ctrlWon };
            }
            if (th === '0.20') dualFireCount++;
          }
        }
      }

      if (mc.winProb < 0.70 && !firstCrack) {
        firstCrack = { period: snap.period, clock: snap.clock, score: (snap.home_pts||0)+'-'+(snap.away_pts||0), margin: (snap.home_pts||0)-(snap.away_pts||0), mc: mc.winProb, collapse: mc.collapseProb, floor_team: snap.floor_team };
      }
      if (mc.winProb < 0.40 && !firstAlarm) {
        firstAlarm = { period: snap.period, clock: snap.clock, score: (snap.home_pts||0)+'-'+(snap.away_pts||0), margin: (snap.home_pts||0)-(snap.away_pts||0), mc: mc.winProb, collapse: mc.collapseProb, floor_team: snap.floor_team };
      }
    }

    var avgQ3Div = q3Divergences.length > 0 ? q3Divergences.reduce(function(a,b){return a+b;},0)/q3Divergences.length : null;

    summaries.push({
      date: g.date,
      matchup: (g.away_alias||'?')+'@'+(g.home_alias||'?'),
      final: (g.home_pts||0)+'-'+(g.away_pts||0),
      winner: g.winner,
      snapshots: mcTotal,
      mc_accuracy: mcTotal > 0 ? Math.round(mcCorrect/mcTotal*1000)/10 : null,
      max_divergence: Math.round(maxDiv*1000)/1000,
      max_div_detail: maxDivSnap,
      avg_q3_divergence: avgQ3Div != null ? Math.round(avgQ3Div*1000)/1000 : null,
      first_crack: firstCrack,
      first_alarm: firstAlarm,
      dual_fire: firstDualFire,
      dual_fire_count: dualFireCount,
    });
  }

  // Divergence precision summary
  var divPrecision = {};
  for (var th2 of ['0.20','0.30','0.40']) {
    var b = divBuckets[th2];
    divPrecision[th2] = { flagged: b.flagged, mc_right: b.mcRight, precision: b.flagged > 0 ? Math.round(b.mcRight/b.flagged*1000)/10 : null };
  }

  // Game-level precision: of games with dual-confirmed fire, how many did MC get right?
  var gamesWithFire = 0, gamesMCRight = 0;
  for (var si2 = 0; si2 < summaries.length; si2++) {
    var df = summaries[si2].dual_fire;
    if (df) {
      gamesWithFire++;
      if (!df.ctrlWon) gamesMCRight++;
    }
  }

  return {
    status: 'ok',
    mode: mode,
    dateRange: fromDate + ' to ' + toDate,
    gamesProcessed: summaries.length,
    totalAvailable: Number(totalGames[0]?.n || 0),
    snapshot_precision: divPrecision,
    game_level: {
      games_with_dual_fire: gamesWithFire,
      mc_right: gamesMCRight,
      mc_wrong: gamesWithFire - gamesMCRight,
      precision: gamesWithFire > 0 ? Math.round(gamesMCRight/gamesWithFire*1000)/10 : null,
    },
    nextStep: offset + batchSize < Number(totalGames[0]?.n || 0)
      ? '?phase=validate_slate&from='+fromDate+'&to='+toDate+'&mode='+mode+'&n='+batchSize+'&offset='+(offset+batchSize)
      : null,
    games: summaries,
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: VALIDATE_TRIGGERED — PBP-triggered MC investigation across games
//   Canary (poss_20 divergence > 0.15 from XGB) triggers investigation.
//   MC then uses only POST-TRIGGER rates to build conviction.
//   ?phase=validate_triggered&n=15&offset=0
// ══════════════════════════════════════════════════════════════════════════════

async function phaseValidateTriggered(sql, url) {
  var fromDate = url.searchParams.get('from') || '2026-04-18';
  var toDate = url.searchParams.get('to') || '2026-05-02';
  var regressionCap = parseFloat(url.searchParams.get('rc') || '0.60');
  var simCount = parseInt(url.searchParams.get('sims') || '500');
  var batchSize = parseInt(url.searchParams.get('n') || '10');
  var offset = parseInt(url.searchParams.get('offset') || '0');
  var canaryThreshold = parseFloat(url.searchParams.get('canary') || '0.15');
  var minPeriod = parseInt(url.searchParams.get('min_period') || '3');  // Q3+ by default

  var games = await sql`
    SELECT id, date, home_alias, away_alias, home_pts, away_pts, winner, quarter_data
    FROM games
    WHERE date >= ${fromDate} AND date <= ${toDate}
      AND winner IS NOT NULL AND quarter_data IS NOT NULL
    ORDER BY date ASC, id ASC
    LIMIT ${batchSize} OFFSET ${offset}
  `;

  var totalGames = await sql`
    SELECT COUNT(*) AS n FROM games
    WHERE date >= ${fromDate} AND date <= ${toDate}
      AND winner IS NOT NULL AND quarter_data IS NOT NULL
  `;

  var summaries = [];
  var aggConfirmed = 0, aggConfirmedRight = 0;
  var aggLikely = 0, aggLikelyRight = 0;

  for (var gi = 0; gi < games.length; gi++) {
    var g = games[gi];

    var snaps = await sql`
      SELECT period, clock, raw_stats_json, floor_score, floor_team,
             xgb_win_prob, home_pts, away_pts
      FROM snapshots
      WHERE game_id = ${g.id} AND source = 'server' AND raw_stats_json IS NOT NULL
      ORDER BY period ASC, clock DESC
    `;
    if (snaps.length < 10) { summaries.push({ matchup: (g.away_alias||'?')+'@'+(g.home_alias||'?'), error: 'insufficient snapshots' }); continue; }

    // Parse all snapshots
    var parsed = [];
    var seen = {};
    for (var si = 0; si < snaps.length; si++) {
      var sk = snaps[si].period + '_' + snaps[si].clock + '_' + snaps[si].home_pts;
      if (seen[sk]) continue;
      seen[sk] = true;
      var raw = typeof snaps[si].raw_stats_json === 'string' ? JSON.parse(snaps[si].raw_stats_json) : snaps[si].raw_stats_json;
      var mc_parsed = parseSnapForMC(raw);
      if (mc_parsed) parsed.push({ snap: snaps[si], stats: mc_parsed });
    }

    // Phase 1: Walk forward with poss_20 canary to find trigger
    var triggerIdx = null;
    var triggerTeam = null;

    for (var ci = 0; ci < parsed.length; ci++) {
      var cs = parsed[ci].snap;
      if (cs.period < minPeriod) continue;

      var canaryRates = possessionWindowRates(
        parsed.map(function(p) { return p.stats; }), ci, 20, regressionCap
      );
      if (!canaryRates || canaryRates.home._windowFGA < 5) continue;

      var clockS = 360;
      try { var pp = String(cs.clock||'6:00').split(':'); clockS = parseInt(pp[0])*60+parseInt(pp[1]||0); } catch(e){}
      var rp = estimateRemainingPoss(parsed[ci].stats.home, parsed[ci].stats.away, cs.period, clockS);
      if (rp < 1) continue;

      var ctrlHome = cs.floor_team === g.home_alias;
      var canaryMC = runMonteCarloSim(canaryRates.home, canaryRates.away,
        cs.home_pts||0, cs.away_pts||0, rp,
        { simCount: 300, ctrlTeam: ctrlHome ? 'home' : 'away' });

      var xgb = cs.xgb_win_prob;
      if (xgb != null && (xgb - canaryMC.winProb) > canaryThreshold) {
        triggerIdx = ci;
        triggerTeam = cs.floor_team;
        break;
      }
    }

    if (triggerIdx === null) {
      summaries.push({
        date: g.date,
        matchup: (g.away_alias||'?')+'@'+(g.home_alias||'?'),
        final: (g.home_pts||0)+'-'+(g.away_pts||0),
        winner: g.winner,
        triggered: false,
      });
      continue;
    }

    // Phase 2: From trigger, run MC with post-trigger rates only
    var triggerStats = parsed[triggerIdx].stats;
    var triggerSnap = parsed[triggerIdx].snap;
    var ctrlWon = triggerTeam === g.winner;
    var ctrlIsHome = triggerTeam === g.home_alias;

    var firstLikely = null;   // MC < 0.40
    var firstConfirmed = null; // MC < 0.25
    var peakCollapse = 0;
    var normalized = false;

    for (var ti = triggerIdx + 1; ti < parsed.length; ti++) {
      var ts = parsed[ti].snap;
      var tc = parsed[ti].stats;

      // Post-trigger diff
      var hDiff = {
        fgm: tc.home.fgm - triggerStats.home.fgm, fga: tc.home.fga - triggerStats.home.fga,
        fg3m: tc.home.fg3m - triggerStats.home.fg3m, fg3a: tc.home.fg3a - triggerStats.home.fg3a,
        ftm: tc.home.ftm - triggerStats.home.ftm, fta: tc.home.fta - triggerStats.home.fta,
        to: tc.home.to - triggerStats.home.to, oreb: tc.home.oreb - triggerStats.home.oreb,
      };
      var aDiff = {
        fgm: tc.away.fgm - triggerStats.away.fgm, fga: tc.away.fga - triggerStats.away.fga,
        fg3m: tc.away.fg3m - triggerStats.away.fg3m, fg3a: tc.away.fg3a - triggerStats.away.fg3a,
        ftm: tc.away.ftm - triggerStats.away.ftm, fta: tc.away.fta - triggerStats.away.fta,
        to: tc.away.to - triggerStats.away.to, oreb: tc.away.oreb - triggerStats.away.oreb,
      };

      var postFGA = hDiff.fga + aDiff.fga;
      if (postFGA < 8) continue; // need minimum post-trigger data

      var hRates = diffToRates(tc.home, triggerStats.home, 0.36, regressionCap);
      var aRates = diffToRates(tc.away, triggerStats.away, 0.36, regressionCap);
      if (!hRates || !aRates) continue;

      var clockS2 = 360;
      try { var pp2 = String(ts.clock||'6:00').split(':'); clockS2 = parseInt(pp2[0])*60+parseInt(pp2[1]||0); } catch(e){}
      var rp2 = estimateRemainingPoss(tc.home, tc.away, ts.period, clockS2);
      if (rp2 < 1) continue;

      var mc = runMonteCarloSim(hRates, aRates,
        ts.home_pts||0, ts.away_pts||0, rp2,
        { simCount: simCount, ctrlTeam: ctrlIsHome ? 'home' : 'away' });

      if (mc.collapseProb != null && mc.collapseProb > peakCollapse) peakCollapse = mc.collapseProb;

      if (mc.winProb > 0.65) normalized = true;

      if (mc.winProb < 0.40 && !firstLikely) {
        firstLikely = { period: ts.period, clock: ts.clock, score: (ts.home_pts||0)+'-'+(ts.away_pts||0),
          margin: (ts.home_pts||0)-(ts.away_pts||0), mc: mc.winProb, collapse: mc.collapseProb, postPoss: Math.round((hDiff.fga+hDiff.to+aDiff.fga+aDiff.to)/2) };
      }
      if (mc.winProb < 0.25 && !firstConfirmed) {
        firstConfirmed = { period: ts.period, clock: ts.clock, score: (ts.home_pts||0)+'-'+(ts.away_pts||0),
          margin: (ts.home_pts||0)-(ts.away_pts||0), mc: mc.winProb, collapse: mc.collapseProb, postPoss: Math.round((hDiff.fga+hDiff.to+aDiff.fga+aDiff.to)/2) };
      }
    }

    if (firstConfirmed) { aggConfirmed++; if (!ctrlWon) aggConfirmedRight++; }
    if (firstLikely) { aggLikely++; if (!ctrlWon) aggLikelyRight++; }

    summaries.push({
      date: g.date,
      matchup: (g.away_alias||'?')+'@'+(g.home_alias||'?'),
      final: (g.home_pts||0)+'-'+(g.away_pts||0),
      winner: g.winner,
      triggered: true,
      trigger: { period: triggerSnap.period, clock: triggerSnap.clock, score: (triggerSnap.home_pts||0)+'-'+(triggerSnap.away_pts||0), margin: (triggerSnap.home_pts||0)-(triggerSnap.away_pts||0), floor_team: triggerTeam },
      ctrl_won: ctrlWon,
      first_likely: firstLikely,
      first_confirmed: firstConfirmed,
      peak_collapse: Math.round(peakCollapse * 1000) / 1000,
      normalized_then_resumed: normalized && (firstLikely != null),
    });
  }

  return {
    status: 'ok',
    mode: 'triggered_investigation',
    canary_threshold: canaryThreshold,
    min_trigger_period: minPeriod,
    dateRange: fromDate + ' to ' + toDate,
    gamesProcessed: summaries.length,
    totalAvailable: Number(totalGames[0]?.n || 0),
    game_level: {
      confirmed: { games: aggConfirmed, mc_right: aggConfirmedRight, precision: aggConfirmed > 0 ? Math.round(aggConfirmedRight/aggConfirmed*1000)/10 : null },
      likely: { games: aggLikely, mc_right: aggLikelyRight, precision: aggLikely > 0 ? Math.round(aggLikelyRight/aggLikely*1000)/10 : null },
    },
    nextStep: offset + batchSize < Number(totalGames[0]?.n || 0)
      ? '?phase=validate_triggered&from='+fromDate+'&to='+toDate+'&n='+batchSize+'&offset='+(offset+batchSize)
      : null,
    games: summaries,
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════════════════

export default async function handler(req) {
  var url = new URL(req.url, 'https://x.com');
  var phase = url.searchParams.get('phase') || 'status';

  var sql;
  try {
    sql = neon(process.env.DATABASE_URL);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'DB connection failed', message: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  var result;
  try {
    switch (phase) {
      case 'init':           result = await phaseInit(sql); break;
      case 'run':            result = await phaseRun(sql, url); break;
      case 'analyze':        result = await phaseAnalyze(sql, url); break;
      case 'validate_game':  result = await phaseValidateGame(sql, url); break;
      case 'validate_game_v2': result = await phaseValidateGameV2(sql, url); break;
      case 'validate_slate':   result = await phaseValidateSlate(sql, url); break;
      case 'validate_triggered': result = await phaseValidateTriggered(sql, url); break;
      case 'status': {
        var count = await sql`SELECT COUNT(*) AS n FROM mc_backtest_results`;
        var games = await sql`SELECT COUNT(DISTINCT game_id) AS n FROM mc_backtest_results`;
        result = {
          status: 'ok',
          results: Number(count[0]?.n || 0),
          games: Number(games[0]?.n || 0),
          phases: ['init', 'run', 'analyze', 'validate_game'],
        };
        break;
      }
      default: result = { error: 'Unknown phase: ' + phase };
    }
  } catch (e) {
    result = { error: e.message, stack: e.stack?.split('\n').slice(0, 5) };
  }

  return new Response(JSON.stringify(result, null, 2), {
    status: result?.error ? 400 : 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const config = { path: '/.netlify/functions/mc-backtest' };

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
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// ── XGB model loading ──────────────────────────────────────────────────────
var XGB_MODEL = null;
try {
  var __xgbDir = dirname(fileURLToPath(import.meta.url));
  XGB_MODEL = JSON.parse(readFileSync(join(__xgbDir, 'xgb-model.json'), 'utf8'));
} catch (e) { /* non-fatal — cross-signal phases degrade gracefully */ }

// XGB feature order: paint, pot, to, stl, oreb, ast, blk, fta, efg, biglead, 3pr, rim_pct, runs
function predictXGB(features) {
  if (!XGB_MODEL) return null;
  var sum = 0;
  for (var ti = 0; ti < XGB_MODEL.trees.length; ti++) {
    var tree = XGB_MODEL.trees[ti];
    var node = 0;
    while (tree.l[node] !== -1) {
      var fval = features[tree.s[node]] != null ? features[tree.s[node]] : 0;
      node = fval < tree.c[node] ? tree.l[node] : tree.r[node];
    }
    sum += tree.w[node];
  }
  var baseLogit = Math.log(XGB_MODEL.base_score / (1 - XGB_MODEL.base_score));
  return 1 / (1 + Math.exp(-(baseLogit + sum)));
}

// Extract XGB features from backtest data format
// team_stats: { home: { pts,fgm,fga,...}, away: {...} }
// pbp_derived: { hPaint,aPaint,hRimM,hRimA,...,hBigLead,aBigLead,hPOT,aPOT,runs6:[...] }
function extractXGBFeaturesBacktest(teamStats, pbpDerived, ctrlTeam, homeAlias) {
  if (!teamStats?.home || !teamStats?.away) return null;
  var h = teamStats.home, a = teamStats.away;
  var pbp = pbpDerived || {};
  var ctrlIsHome = ctrlTeam === homeAlias;
  var flip = ctrlIsHome ? 1 : -1;

  var hFGA = Number(h.fga || 0), aFGA = Number(a.fga || 0);
  var hFGM = Number(h.fgm || 0), aFGM = Number(a.fgm || 0);
  var hFG3M = Number(h.fg3m || 0), aFG3M = Number(a.fg3m || 0);
  var hFG3A = Number(h.fg3a || 0), aFG3A = Number(a.fg3a || 0);
  var hEFG = hFGA > 0 ? (hFGM + 0.5 * hFG3M) / hFGA : 0;
  var aEFG = aFGA > 0 ? (aFGM + 0.5 * aFG3M) / aFGA : 0;

  var hRimM = Number(pbp.hRimM || 0), hRimA = Number(pbp.hRimA || 0);
  var aRimM = Number(pbp.aRimM || 0), aRimA = Number(pbp.aRimA || 0);
  var rimDiff = ((hRimM / Math.max(hRimA, 1)) - (aRimM / Math.max(aRimA, 1))) * flip;

  var runShare = 0.5;
  if (pbp.runs6 && Array.isArray(pbp.runs6) && pbp.runs6.length > 0) {
    var hRuns = 0, aRuns = 0;
    for (var ri = 0; ri < pbp.runs6.length; ri++) {
      if (pbp.runs6[ri].team === homeAlias) hRuns++; else aRuns++;
    }
    var totalRuns = hRuns + aRuns;
    if (totalRuns > 0) runShare = (ctrlIsHome ? hRuns : aRuns) / totalRuns;
  }

  return [
    (Number(pbp.hPaint || 0) - Number(pbp.aPaint || 0)) * flip,
    (Number(pbp.hPOT || 0) - Number(pbp.aPOT || 0)) * flip,
    (Number(h.to || 0) - Number(a.to || 0)) * flip,
    (Number(h.stl || 0) - Number(a.stl || 0)) * flip,
    (Number(h.oreb || 0) - Number(a.oreb || 0)) * flip,
    (Number(h.ast || 0) - Number(a.ast || 0)) * flip,
    (Number(h.blk || 0) - Number(a.blk || 0)) * flip,
    (Number(h.fta || 0) - Number(a.fta || 0)) * flip,
    (hEFG - aEFG) * flip,
    (Number(pbp.hBigLead || 0) - Number(pbp.aBigLead || 0)) * flip,
    (hFGA > 0 && aFGA > 0 ? (hFG3A / hFGA - aFG3A / aFGA) : 0) * flip,
    rimDiff,
    runShare,
  ];
}

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
// PHASE: TRIGGERED_REPLAY — Backtest-scale triggered investigation (1,235 games)
//   Uses nba_snapshot_backtest checkpoints. Canary = 2-cp window MC vs floor.
//   ?phase=triggered_replay&n=200&offset=0
// ══════════════════════════════════════════════════════════════════════════════

async function phaseTriggeredReplay(sql, url) {
  var batchSize = parseInt(url.searchParams.get('n') || '200');
  var offset = parseInt(url.searchParams.get('offset') || '0');
  var canaryThreshold = parseFloat(url.searchParams.get('canary') || '0.15');
  var canaryMode = url.searchParams.get('canary_mode') || 'relative';  // 'relative' or 'absolute'
  var mcThreshold = parseFloat(url.searchParams.get('mc_threshold') || '0.70');
  var simCount = parseInt(url.searchParams.get('sims') || '300');
  var regressionCap = parseFloat(url.searchParams.get('rc') || '0.60');
  var startTime = Date.now();

  // Get distinct game_ids
  var gameIds = await sql`
    SELECT DISTINCT game_id FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL
    ORDER BY game_id
    LIMIT ${batchSize} OFFSET ${offset}
  `;
  var totalGames = await sql`SELECT COUNT(DISTINCT game_id) AS n FROM nba_snapshot_backtest WHERE indicators IS NOT NULL`;

  if (gameIds.length === 0) return { status: 'ok', message: 'No more games' };

  var ids = gameIds.map(function(r) { return r.game_id; });

  // Fetch all checkpoints for these games
  var rows = await sql`
    SELECT game_id, checkpoint, team_stats,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl_team,
           indicators->>'homeAlias' AS home_alias,
           indicators->>'awayAlias' AS away_alias,
           margin_at_snapshot AS margin,
           ctrl_team_won, final_margin
    FROM nba_snapshot_backtest
    WHERE game_id = ANY(${ids}) AND indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  // Group by game and sort by checkpoint order
  var gameMap = {};
  for (var r of rows) {
    if (!gameMap[r.game_id]) gameMap[r.game_id] = [];
    var ts = typeof r.team_stats === 'string' ? JSON.parse(r.team_stats) : r.team_stats;
    gameMap[r.game_id].push({
      checkpoint: r.checkpoint, cpIdx: CP_INDEX[r.checkpoint],
      home: ts ? ts.home : null, away: ts ? ts.away : null,
      floor: r.floor, ctrl_team: r.ctrl_team,
      home_alias: r.home_alias, away_alias: r.away_alias,
      margin: r.margin, ctrl_team_won: r.ctrl_team_won, final_margin: r.final_margin,
    });
  }
  for (var gid of Object.keys(gameMap)) {
    gameMap[gid].sort(function(a, b) { return a.cpIdx - b.cpIdx; });
  }

  // Aggregate results
  var agg = {
    total: 0, triggered: 0, confirmed: 0, confirmed_right: 0,
    likely: 0, likely_right: 0,
    patterns: { CLEAN: {n:0,right:0}, WAVE: {n:0,right:0}, NORMALIZED: {n:0,right:0}, FALSE_ALARM: {n:0,right:0} },
    speed_buckets: { fast: {n:0,right:0}, medium: {n:0,right:0}, slow: {n:0,right:0} },
    drivers: {},  // VOLATILE, STRUCTURAL, MIXED
    speed_margins: [],  // {speed, finalMargin, correct} for scatter
  };

  for (var gid of Object.keys(gameMap)) {
    if (Date.now() - startTime > 95000) break;  // budget
    agg.total++;
    var cps = gameMap[gid];

    // Parse stats for MC
    var parsed = cps.map(function(cp) {
      if (!cp.home || !cp.away) return null;
      return {
        home: { fgm: cp.home.fgm||0, fga: cp.home.fga||0, fg3m: cp.home.fg3m||0, fg3a: cp.home.fg3a||0,
                ftm: cp.home.ftm||0, fta: cp.home.fta||0, to: cp.home.to||0, oreb: cp.home.oreb||0 },
        away: { fgm: cp.away.fgm||0, fga: cp.away.fga||0, fg3m: cp.away.fg3m||0, fg3a: cp.away.fg3a||0,
                ftm: cp.away.ftm||0, fta: cp.away.fta||0, to: cp.away.to||0, oreb: cp.away.oreb||0 },
      };
    });

    // Find canary trigger (Q3+ = cpIdx >= 6, need 2 prior checkpoints for window)
    var triggerIdx = null;
    for (var ci = 2; ci < cps.length; ci++) {
      var cp = cps[ci];
      if (cp.cpIdx < 6) continue;  // Q3+ only (Q3_9 = index 6)
      if (cp.checkpoint === 'Q4_END') continue;
      if (!parsed[ci] || !parsed[ci-2]) continue;

      // 2-checkpoint canary window
      var hRates = diffToRates(parsed[ci].home, parsed[ci-2].home, 0.36, regressionCap);
      var aRates = diffToRates(parsed[ci].away, parsed[ci-2].away, 0.36, regressionCap);
      if (!hRates || !aRates) continue;

      var meta = CP_META[cp.checkpoint]; if (!meta) continue;
      var rp = estimateRemainingPoss(parsed[ci].home, parsed[ci].away, meta.period, meta.clockSec);
      if (rp < 1) continue;

      var ctrlHome = cp.ctrl_team === cp.home_alias;
      var mc = runMonteCarloSim(hRates, aRates,
        parsed[ci].home.fgm ? (parsed[ci].home.fgm - parsed[ci].home.fg3m)*2 + parsed[ci].home.fg3m*3 + parsed[ci].home.ftm : 0,
        parsed[ci].away.fgm ? (parsed[ci].away.fgm - parsed[ci].away.fg3m)*2 + parsed[ci].away.fg3m*3 + parsed[ci].away.ftm : 0,
        rp, { simCount: 200, ctrlTeam: ctrlHome ? 'home' : 'away' });

      // Canary check
      var canaryFired = false;
      if (canaryMode === 'absolute') {
        canaryFired = mc.winProb < mcThreshold;
      } else if (canaryMode === 'combined') {
        var relFired = cp.floor != null && (cp.floor - mc.winProb) > canaryThreshold;
        var absFired = mc.winProb < mcThreshold;
        canaryFired = relFired || absFired;
      } else {
        canaryFired = cp.floor != null && (cp.floor - mc.winProb) > canaryThreshold;
      }
      if (canaryFired) {
        triggerIdx = ci; break;
      }
    }

    if (triggerIdx === null) continue;
    agg.triggered++;

    // Run post-trigger investigation
    var triggerStats = parsed[triggerIdx];
    var triggerCp = cps[triggerIdx];
    var ctrlWon = triggerCp.ctrl_team_won;
    var ctrlHome2 = triggerCp.ctrl_team === triggerCp.home_alias;

    var verdicts = [];
    var firstConfPoss = null;
    var firstLikelyPoss = null;
    var confRates = null;  // rates at first CONFIRMED for decomposition

    for (var ti = triggerIdx + 1; ti < cps.length; ti++) {
      if (cps[ti].checkpoint === 'Q4_END') continue;
      if (!parsed[ti]) continue;

      var hR = diffToRates(parsed[ti].home, triggerStats.home, 0.36, regressionCap);
      var aR = diffToRates(parsed[ti].away, triggerStats.away, 0.36, regressionCap);
      if (!hR || !aR) continue;

      var postPoss = Math.round((hR._windowPoss + aR._windowPoss) / 2);
      if (postPoss < 4) continue;

      var m2 = CP_META[cps[ti].checkpoint]; if (!m2) continue;
      var rp2 = estimateRemainingPoss(parsed[ti].home, parsed[ti].away, m2.period, m2.clockSec);
      if (rp2 < 1) continue;

      // Compute scores from cumulative stats
      var hScore = (parsed[ti].home.fgm - parsed[ti].home.fg3m)*2 + parsed[ti].home.fg3m*3 + parsed[ti].home.ftm;
      var aScore = (parsed[ti].away.fgm - parsed[ti].away.fg3m)*2 + parsed[ti].away.fg3m*3 + parsed[ti].away.ftm;

      var mc2 = runMonteCarloSim(hR, aR, hScore, aScore, rp2,
        { simCount: simCount, ctrlTeam: ctrlHome2 ? 'home' : 'away' });

      var v;
      if (postPoss < 8) v = 'INV';
      else if (mc2.winProb > 0.60) v = 'NORM';
      else if (mc2.winProb > 0.40) v = 'CONT';
      else if (mc2.winProb > 0.25) v = 'LIKELY';
      else v = 'CONF';

      verdicts.push(v);
      if (v === 'CONF' && firstConfPoss === null) {
        firstConfPoss = postPoss;
        confRates = { ctrl: ctrlHome2 ? hR : aR, opp: ctrlHome2 ? aR : hR };
      }
      if ((v === 'CONF' || v === 'LIKELY') && firstLikelyPoss === null) firstLikelyPoss = postPoss;
    }

    // Classify pattern
    var seq = verdicts;
    var everConf = seq.indexOf('CONF') >= 0;
    var everLikely = seq.indexOf('LIKELY') >= 0 || everConf;

    var pattern;
    if (!everLikely) {
      pattern = 'FALSE_ALARM';
    } else {
      var firstAlarmIdx = -1;
      for (var si2 = 0; si2 < seq.length; si2++) {
        if (seq[si2] === 'CONF' || seq[si2] === 'LIKELY') { firstAlarmIdx = si2; break; }
      }
      var postAlarm = seq.slice(firstAlarmIdx);
      var hasNorm = postAlarm.indexOf('NORM') >= 0;
      if (!hasNorm) {
        pattern = 'CLEAN';
      } else {
        var normIdx2 = postAlarm.indexOf('NORM');
        var postNorm = postAlarm.slice(normIdx2);
        var reAlarmed = postNorm.some(function(v2) { return v2 === 'CONF' || v2 === 'LIKELY'; });
        pattern = reAlarmed ? 'WAVE' : 'NORMALIZED';
      }
    }

    // Record
    var correct = !ctrlWon;
    agg.patterns[pattern] = agg.patterns[pattern] || {n:0, right:0};
    agg.patterns[pattern].n++;
    if (correct) agg.patterns[pattern].right++;

    if (everConf) { agg.confirmed++; if (correct) agg.confirmed_right++; }
    if (everLikely) { agg.likely++; if (correct) agg.likely_right++; }

    // Speed buckets
    if (firstConfPoss !== null) {
      var bucket = firstConfPoss <= 12 ? 'fast' : firstConfPoss <= 25 ? 'medium' : 'slow';
      agg.speed_buckets[bucket].n++;
      if (correct) agg.speed_buckets[bucket].right++;
      agg.speed_margins.push({ speed: firstConfPoss, margin: Math.abs(cps[0].final_margin || 0), correct: correct });

      // Rate decomposition at first CONFIRMED
      if (confRates) {
        var cr = confRates.ctrl;  // collapsing team's post-trigger rates
        var op = confRates.opp;   // opponent's post-trigger rates

        // Compute deviations from baselines (ctrl team perspective — negative = bad for ctrl)
        var baselines = { to: 0.13, fg2: 0.52, fg3: 0.36, oreb: 0.25, fta: 0.22 };
        var deviations = {
          ctrl_to:   (cr.toRate || 0) - baselines.to,      // positive = more TOs = bad
          ctrl_fg2:  baselines.fg2 - (cr.fg2Pct || 0.50),  // positive = shooting worse = bad
          opp_fg2:   (op.fg2Pct || 0.50) - baselines.fg2,  // positive = opponent shooting hot = bad
          opp_oreb:  (op.orebRate || 0) - baselines.oreb,   // positive = opponent crashing glass = bad
          ctrl_fta:  baselines.fta - (cr.ftaRate || 0),     // positive = fewer FTs = bad
        };

        var volScore = Math.abs(deviations.ctrl_to) + Math.abs(deviations.opp_oreb);
        var strScore = Math.abs(deviations.ctrl_fg2) + Math.abs(deviations.opp_fg2);

        var driver = volScore > strScore * 1.3 ? 'VOLATILE' : strScore > volScore * 1.3 ? 'STRUCTURAL' : 'MIXED';
        agg.drivers[driver] = agg.drivers[driver] || {n: 0, right: 0};
        agg.drivers[driver].n++;
        if (correct) agg.drivers[driver].right++;
      }
    }
  }

  // Trim speed_margins for response size
  if (agg.speed_margins.length > 100) {
    agg.speed_margins = agg.speed_margins.slice(0, 100);
    agg._speed_margins_truncated = true;
  }

  return {
    status: 'ok',
    phase: 'triggered_replay',
    canary_mode: canaryMode,
    canary_config: canaryMode === 'absolute' ? { mc_threshold: mcThreshold } : { divergence: canaryThreshold },
    gamesProcessed: agg.total,
    totalAvailable: Number(totalGames[0]?.n || 0),
    elapsed_ms: Date.now() - startTime,
    triggered: agg.triggered,
    triggered_pct: agg.total > 0 ? Math.round(agg.triggered / agg.total * 1000) / 10 : 0,
    confirmed: { games: agg.confirmed, right: agg.confirmed_right,
      precision: agg.confirmed > 0 ? Math.round(agg.confirmed_right / agg.confirmed * 1000) / 10 : null },
    likely: { games: agg.likely, right: agg.likely_right,
      precision: agg.likely > 0 ? Math.round(agg.likely_right / agg.likely * 1000) / 10 : null },
    patterns: Object.keys(agg.patterns).map(function(p) {
      var d = agg.patterns[p];
      return { pattern: p, games: d.n, right: d.right, precision: d.n > 0 ? Math.round(d.right / d.n * 1000) / 10 : null };
    }),
    speed_to_confirm: {
      fast_le12: { games: agg.speed_buckets.fast.n, right: agg.speed_buckets.fast.right,
        precision: agg.speed_buckets.fast.n > 0 ? Math.round(agg.speed_buckets.fast.right / agg.speed_buckets.fast.n * 1000) / 10 : null },
      medium_13_25: { games: agg.speed_buckets.medium.n, right: agg.speed_buckets.medium.right,
        precision: agg.speed_buckets.medium.n > 0 ? Math.round(agg.speed_buckets.medium.right / agg.speed_buckets.medium.n * 1000) / 10 : null },
      slow_26plus: { games: agg.speed_buckets.slow.n, right: agg.speed_buckets.slow.right,
        precision: agg.speed_buckets.slow.n > 0 ? Math.round(agg.speed_buckets.slow.right / agg.speed_buckets.slow.n * 1000) / 10 : null },
    },
    collapse_drivers: Object.keys(agg.drivers).map(function(d) {
      var dd = agg.drivers[d];
      return { driver: d, games: dd.n, right: dd.right, precision: dd.n > 0 ? Math.round(dd.right / dd.n * 1000) / 10 : null };
    }),
    nextStep: offset + batchSize < Number(totalGames[0]?.n || 0)
      ? '?phase=triggered_replay&n=' + batchSize + '&offset=' + (offset + batchSize)
      : 'COMPLETE',
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: SILENT_AUDIT — Games where MC never triggered but ctrl team lost
//   What collapses are we missing? What do they look like?
//   ?phase=silent_audit&n=200&offset=0
// ══════════════════════════════════════════════════════════════════════════════

async function phaseSilentAudit(sql, url) {
  var batchSize = parseInt(url.searchParams.get('n') || '200');
  var offset = parseInt(url.searchParams.get('offset') || '0');
  var canaryThreshold = parseFloat(url.searchParams.get('canary') || '0.15');
  var canaryMode = url.searchParams.get('canary_mode') || 'relative';
  var mcThreshold = parseFloat(url.searchParams.get('mc_threshold') || '0.70');
  var regressionCap = parseFloat(url.searchParams.get('rc') || '0.60');
  var startTime = Date.now();

  var gameIds = await sql`
    SELECT DISTINCT game_id FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL
    ORDER BY game_id LIMIT ${batchSize} OFFSET ${offset}
  `;
  var totalGames = await sql`SELECT COUNT(DISTINCT game_id) AS n FROM nba_snapshot_backtest WHERE indicators IS NOT NULL`;

  if (gameIds.length === 0) return { status: 'ok', message: 'No more games' };

  var ids = gameIds.map(function(r) { return r.game_id; });
  var rows = await sql`
    SELECT game_id, checkpoint, team_stats,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl_team,
           indicators->>'homeAlias' AS home_alias,
           indicators->>'awayAlias' AS away_alias,
           margin_at_snapshot AS margin,
           ctrl_team_won, final_margin
    FROM nba_snapshot_backtest
    WHERE game_id = ANY(${ids}) AND indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  var gameMap = {};
  for (var r of rows) {
    if (!gameMap[r.game_id]) gameMap[r.game_id] = [];
    var ts = typeof r.team_stats === 'string' ? JSON.parse(r.team_stats) : r.team_stats;
    gameMap[r.game_id].push({
      checkpoint: r.checkpoint, cpIdx: CP_INDEX[r.checkpoint],
      home: ts ? ts.home : null, away: ts ? ts.away : null,
      floor: r.floor, ctrl_team: r.ctrl_team,
      home_alias: r.home_alias, away_alias: r.away_alias,
      margin: r.margin, ctrl_team_won: r.ctrl_team_won, final_margin: r.final_margin,
    });
  }
  for (var gid of Object.keys(gameMap)) {
    gameMap[gid].sort(function(a, b) { return a.cpIdx - b.cpIdx; });
  }

  var agg = {
    total: 0, triggered: 0, not_triggered: 0,
    silent_losses: 0,  // ctrl lost but MC never triggered
    silent_wins: 0,    // ctrl won, MC correctly silent
    // Characterize silent losses
    loss_buckets: {
      blowout_reversal: 0,   // ctrl had 15+ lead that evaporated
      large_swing: 0,         // 10+ point swing Q3+
      slow_erosion: 0,        // margin drifted < 5pts per checkpoint
      close_throughout: 0,    // never led by more than 8
    },
    blowout_q3_state: {
      leading_10plus: 0, leading_5_9: 0, leading_1_4: 0, close: 0, already_behind: 0,
    },
    loss_margins: [],  // final margin of silent losses
    loss_floors: [],   // {q3_start_floor, q4_end_floor, max_margin_q3plus, final_margin}
  };

  for (var gid of Object.keys(gameMap)) {
    if (Date.now() - startTime > 90000) break;
    agg.total++;
    var cps = gameMap[gid];

    var parsed = cps.map(function(cp) {
      if (!cp.home || !cp.away) return null;
      return {
        home: { fgm: cp.home.fgm||0, fga: cp.home.fga||0, fg3m: cp.home.fg3m||0, fg3a: cp.home.fg3a||0,
                ftm: cp.home.ftm||0, fta: cp.home.fta||0, to: cp.home.to||0, oreb: cp.home.oreb||0 },
        away: { fgm: cp.away.fgm||0, fga: cp.away.fga||0, fg3m: cp.away.fg3m||0, fg3a: cp.away.fg3a||0,
                ftm: cp.away.ftm||0, fta: cp.away.fta||0, to: cp.away.to||0, oreb: cp.away.oreb||0 },
      };
    });

    // Run canary check (same as triggered_replay)
    var triggered = false;
    for (var ci = 2; ci < cps.length; ci++) {
      var cp = cps[ci];
      if (cp.cpIdx < 6) continue;
      if (cp.checkpoint === 'Q4_END') continue;
      if (!parsed[ci] || !parsed[ci-2]) continue;

      var hRates = diffToRates(parsed[ci].home, parsed[ci-2].home, 0.36, regressionCap);
      var aRates = diffToRates(parsed[ci].away, parsed[ci-2].away, 0.36, regressionCap);
      if (!hRates || !aRates) continue;

      var meta = CP_META[cp.checkpoint]; if (!meta) continue;
      var rp = estimateRemainingPoss(parsed[ci].home, parsed[ci].away, meta.period, meta.clockSec);
      if (rp < 1) continue;

      var ctrlHome = cp.ctrl_team === cp.home_alias;
      var hScore = (parsed[ci].home.fgm - parsed[ci].home.fg3m)*2 + parsed[ci].home.fg3m*3 + parsed[ci].home.ftm;
      var aScore = (parsed[ci].away.fgm - parsed[ci].away.fg3m)*2 + parsed[ci].away.fg3m*3 + parsed[ci].away.ftm;

      var mc = runMonteCarloSim(hRates, aRates, hScore, aScore, rp,
        { simCount: 200, ctrlTeam: ctrlHome ? 'home' : 'away' });

      var canaryFired = false;
      if (canaryMode === 'absolute') {
        canaryFired = mc.winProb < mcThreshold;
      } else if (canaryMode === 'combined') {
        var relFired2 = cp.floor != null && (cp.floor - mc.winProb) > canaryThreshold;
        var absFired2 = mc.winProb < mcThreshold;
        canaryFired = relFired2 || absFired2;
      } else {
        canaryFired = cp.floor != null && (cp.floor - mc.winProb) > canaryThreshold;
      }
      if (canaryFired) {
        triggered = true; break;
      }
    }

    if (triggered) { agg.triggered++; continue; }

    agg.not_triggered++;
    var ctrlWon = cps[0].ctrl_team_won;

    if (ctrlWon) {
      agg.silent_wins++;
      continue;
    }

    // SILENT LOSS — ctrl lost but MC never triggered
    agg.silent_losses++;

    // Characterize this loss
    var q3Start = cps.find(function(c) { return c.checkpoint === 'Q3_9'; });
    var q4End = cps.find(function(c) { return c.checkpoint === 'Q4_END'; });
    var q3StartFloor = q3Start ? q3Start.floor : null;
    var q4EndFloor = q4End ? q4End.floor : null;

    // Max ctrl margin Q3+ and margin swing
    var maxMarginQ3 = -999, minMarginQ3 = 999;
    var maxCtrlLeadEver = -999;
    var marginAtQ3Start = null;
    for (var mi = 0; mi < cps.length; mi++) {
      var mg = cps[mi].margin || 0;
      // Convert to ctrl-team-relative margin
      var ctrlMg = cps[mi].ctrl_team === cps[mi].home_alias ? mg : -mg;
      if (ctrlMg > maxCtrlLeadEver) maxCtrlLeadEver = ctrlMg;
      if (cps[mi].checkpoint === 'Q3_9') marginAtQ3Start = ctrlMg;
      if (cps[mi].cpIdx >= 6) {  // Q3+
        if (ctrlMg > maxMarginQ3) maxMarginQ3 = ctrlMg;
        if (ctrlMg < minMarginQ3) minMarginQ3 = ctrlMg;
      }
    }
    var q3Swing = maxMarginQ3 - minMarginQ3;
    var finalMg = Math.abs(cps[0].final_margin || 0);

    // Classify loss type
    if (maxCtrlLeadEver >= 15) {
      agg.loss_buckets.blowout_reversal++;
      // Sub-classify blowouts by Q3 state
      if (marginAtQ3Start !== null) {
        if (marginAtQ3Start >= 10) agg.blowout_q3_state.leading_10plus++;
        else if (marginAtQ3Start >= 5) agg.blowout_q3_state.leading_5_9++;
        else if (marginAtQ3Start >= 1) agg.blowout_q3_state.leading_1_4++;
        else if (marginAtQ3Start >= -3) agg.blowout_q3_state.close++;
        else agg.blowout_q3_state.already_behind++;
      }
    }
    else if (q3Swing >= 10) agg.loss_buckets.large_swing++;
    else if (maxCtrlLeadEver <= 8) agg.loss_buckets.close_throughout++;
    else agg.loss_buckets.slow_erosion++;

    agg.loss_margins.push(finalMg);

    if (agg.loss_floors.length < 80) {
      agg.loss_floors.push({
        q3_floor: q3StartFloor != null ? Math.round(q3StartFloor * 100) / 100 : null,
        q4_end_floor: q4EndFloor != null ? Math.round(q4EndFloor * 100) / 100 : null,
        max_ctrl_lead: maxCtrlLeadEver,
        margin_at_q3: marginAtQ3Start,
        q3_swing: q3Swing,
        final_margin: finalMg,
        type: maxCtrlLeadEver >= 15 ? 'blowout' : q3Swing >= 10 ? 'swing' : maxCtrlLeadEver <= 8 ? 'close' : 'erosion',
      });
    }
  }

  // Compute loss margin distribution
  var lm = agg.loss_margins;
  lm.sort(function(a, b) { return a - b; });
  var marginDist = lm.length > 0 ? {
    median: lm[Math.floor(lm.length / 2)],
    mean: Math.round(lm.reduce(function(a,b){return a+b;},0) / lm.length * 10) / 10,
    close_le5: lm.filter(function(m) { return m <= 5; }).length,
    medium_6_12: lm.filter(function(m) { return m > 5 && m <= 12; }).length,
    blowout_13plus: lm.filter(function(m) { return m > 12; }).length,
  } : null;

  return {
    status: 'ok',
    phase: 'silent_audit',
    gamesProcessed: agg.total,
    totalAvailable: Number(totalGames[0]?.n || 0),
    elapsed_ms: Date.now() - startTime,
    triggered: agg.triggered,
    not_triggered: agg.not_triggered,
    silent_wins: agg.silent_wins,
    silent_losses: agg.silent_losses,
    silent_loss_pct: agg.not_triggered > 0 ? Math.round(agg.silent_losses / agg.not_triggered * 1000) / 10 : null,
    loss_types: agg.loss_buckets,
    blowout_q3_state: agg.blowout_q3_state,
    loss_margin_distribution: marginDist,
    sample_losses: agg.loss_floors,
    nextStep: offset + batchSize < Number(totalGames[0]?.n || 0)
      ? '?phase=silent_audit&n=' + batchSize + '&offset=' + (offset + batchSize)
      : 'COMPLETE',
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: HALFTIME_MC — MC at Q2_END using Q2-only rates as pre-Q3 signal
//   ?phase=halftime_mc&n=200&offset=0
// ══════════════════════════════════════════════════════════════════════════════

async function phaseHalftimeMC(sql, url) {
  var batchSize = parseInt(url.searchParams.get('n') || '200');
  var offset = parseInt(url.searchParams.get('offset') || '0');
  var regressionCap = parseFloat(url.searchParams.get('rc') || '0.60');
  var simCount = parseInt(url.searchParams.get('sims') || '500');
  var startTime = Date.now();

  var gameIds = await sql`
    SELECT DISTINCT game_id FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL ORDER BY game_id
    LIMIT ${batchSize} OFFSET ${offset}
  `;
  var totalGames = await sql`SELECT COUNT(DISTINCT game_id) AS n FROM nba_snapshot_backtest WHERE indicators IS NOT NULL`;

  if (gameIds.length === 0) return { status: 'ok', message: 'No more games' };
  var ids = gameIds.map(function(r) { return r.game_id; });

  var rows = await sql`
    SELECT game_id, checkpoint, team_stats,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl_team,
           indicators->>'homeAlias' AS home_alias,
           margin_at_snapshot AS margin,
           ctrl_team_won
    FROM nba_snapshot_backtest
    WHERE game_id = ANY(${ids}) AND indicators IS NOT NULL AND indicators->>'no_data' IS NULL
      AND checkpoint IN ('Q1_END', 'Q2_END')
    ORDER BY game_id, checkpoint
  `;

  var gameMap = {};
  for (var r of rows) {
    if (!gameMap[r.game_id]) gameMap[r.game_id] = {};
    var ts = typeof r.team_stats === 'string' ? JSON.parse(r.team_stats) : r.team_stats;
    gameMap[r.game_id][r.checkpoint] = {
      home: ts ? ts.home : null, away: ts ? ts.away : null,
      floor: r.floor, ctrl_team: r.ctrl_team, home_alias: r.home_alias,
      margin: r.margin, ctrl_team_won: r.ctrl_team_won,
    };
  }

  var agg = {
    total: 0, processed: 0,
    mc_correct: 0, floor_correct: 0,
    // Bucket by MC confidence
    mc_high: { n: 0, right: 0 },      // MC > 0.70
    mc_moderate: { n: 0, right: 0 },   // 0.55-0.70
    mc_tossup: { n: 0, right: 0 },     // 0.45-0.55
    mc_skeptical: { n: 0, right: 0 },  // 0.30-0.45
    mc_collapse: { n: 0, right: 0 },   // < 0.30
    // Divergence from floor
    diverge_high: { n: 0, floor_right: 0, mc_right: 0 },  // |floor - MC| > 0.20
    diverge_low: { n: 0, floor_right: 0, mc_right: 0 },   // |floor - MC| <= 0.20
    // For AUC computation
    predictions: [],  // {mc, floor, ctrlWon}
  };

  for (var gid of Object.keys(gameMap)) {
    if (Date.now() - startTime > 90000) break;
    agg.total++;
    var gd = gameMap[gid];
    var q1 = gd['Q1_END'];
    var q2 = gd['Q2_END'];
    if (!q1 || !q2 || !q1.home || !q2.home || !q1.away || !q2.away) continue;

    // Parse stats
    function toMC(d) {
      return { fgm: d.fgm||0, fga: d.fga||0, fg3m: d.fg3m||0, fg3a: d.fg3a||0,
               ftm: d.ftm||0, fta: d.fta||0, to: d.to||0, oreb: d.oreb||0 };
    }
    var q1h = toMC(q1.home), q1a = toMC(q1.away);
    var q2h = toMC(q2.home), q2a = toMC(q2.away);

    // Q2-only rates (diff Q2_END - Q1_END)
    var hRates = diffToRates(q2h, q1h, 0.36, regressionCap);
    var aRates = diffToRates(q2a, q1a, 0.36, regressionCap);
    if (!hRates || !aRates) continue;

    // Score at halftime
    var hScore = (q2h.fgm - q2h.fg3m)*2 + q2h.fg3m*3 + q2h.ftm;
    var aScore = (q2a.fgm - q2a.fg3m)*2 + q2a.fg3m*3 + q2a.ftm;

    // ~48 remaining possessions (full second half)
    var remainPoss = 48;

    var ctrlHome = q2.ctrl_team === q2.home_alias;
    var ctrlWon = q2.ctrl_team_won;

    var mc = runMonteCarloSim(hRates, aRates, hScore, aScore, remainPoss,
      { simCount: simCount, ctrlTeam: ctrlHome ? 'home' : 'away' });

    agg.processed++;
    var mcRight = (mc.winProb > 0.5 && ctrlWon) || (mc.winProb < 0.5 && !ctrlWon);
    var floorRight = (q2.floor > 0.5 && ctrlWon) || (q2.floor < 0.5 && !ctrlWon);
    if (mcRight) agg.mc_correct++;
    if (floorRight) agg.floor_correct++;

    // Confidence buckets
    var bucket = mc.winProb > 0.70 ? 'mc_high' : mc.winProb > 0.55 ? 'mc_moderate' :
                 mc.winProb > 0.45 ? 'mc_tossup' : mc.winProb > 0.30 ? 'mc_skeptical' : 'mc_collapse';
    agg[bucket].n++;
    if (mcRight) agg[bucket].right++;

    // Divergence tracking
    var div = Math.abs((q2.floor || 0.5) - mc.winProb);
    var divKey = div > 0.20 ? 'diverge_high' : 'diverge_low';
    agg[divKey].n++;
    if (floorRight) agg[divKey].floor_right++;
    if (mcRight) agg[divKey].mc_right++;

    // Store for AUC
    if (agg.predictions.length < 2000) {
      agg.predictions.push({ mc: mc.winProb, floor: q2.floor || 0.5, won: ctrlWon ? 1 : 0 });
    }
  }

  // Compute AUC for both MC and floor
  function computeAUC(preds, key) {
    var pos = preds.filter(function(p) { return p.won === 1; });
    var neg = preds.filter(function(p) { return p.won === 0; });
    if (pos.length === 0 || neg.length === 0) return null;
    var concordant = 0, total = 0;
    // Sample for speed if large
    var maxPairs = 500000;
    var step = Math.max(1, Math.floor(pos.length * neg.length / maxPairs));
    for (var i = 0; i < pos.length; i++) {
      for (var j = 0; j < neg.length; j += step) {
        if (pos[i][key] > neg[j][key]) concordant++;
        else if (pos[i][key] === neg[j][key]) concordant += 0.5;
        total++;
      }
    }
    return Math.round(concordant / total * 1000) / 1000;
  }

  var mcAUC = computeAUC(agg.predictions, 'mc');
  var floorAUC = computeAUC(agg.predictions, 'floor');

  return {
    status: 'ok',
    phase: 'halftime_mc',
    gamesProcessed: agg.total,
    gamesWithData: agg.processed,
    totalAvailable: Number(totalGames[0]?.n || 0),
    elapsed_ms: Date.now() - startTime,
    auc: { mc_q2_rates: mcAUC, floor_cumulative: floorAUC },
    accuracy: {
      mc: agg.processed > 0 ? Math.round(agg.mc_correct / agg.processed * 1000) / 10 : null,
      floor: agg.processed > 0 ? Math.round(agg.floor_correct / agg.processed * 1000) / 10 : null,
    },
    mc_confidence: {
      high_gt70: { games: agg.mc_high.n, right: agg.mc_high.right, precision: agg.mc_high.n > 0 ? Math.round(agg.mc_high.right/agg.mc_high.n*1000)/10 : null },
      moderate_55_70: { games: agg.mc_moderate.n, right: agg.mc_moderate.right, precision: agg.mc_moderate.n > 0 ? Math.round(agg.mc_moderate.right/agg.mc_moderate.n*1000)/10 : null },
      tossup_45_55: { games: agg.mc_tossup.n, right: agg.mc_tossup.right, precision: agg.mc_tossup.n > 0 ? Math.round(agg.mc_tossup.right/agg.mc_tossup.n*1000)/10 : null },
      skeptical_30_45: { games: agg.mc_skeptical.n, right: agg.mc_skeptical.right, precision: agg.mc_skeptical.n > 0 ? Math.round(agg.mc_skeptical.right/agg.mc_skeptical.n*1000)/10 : null },
      collapse_lt30: { games: agg.mc_collapse.n, right: agg.mc_collapse.right, precision: agg.mc_collapse.n > 0 ? Math.round(agg.mc_collapse.right/agg.mc_collapse.n*1000)/10 : null },
    },
    divergence: {
      high_gt20: { games: agg.diverge_high.n, floor_right: agg.diverge_high.floor_right, mc_right: agg.diverge_high.mc_right },
      low_le20: { games: agg.diverge_low.n, floor_right: agg.diverge_low.floor_right, mc_right: agg.diverge_low.mc_right },
    },
    nextStep: offset + batchSize < Number(totalGames[0]?.n || 0)
      ? '?phase=halftime_mc&n=' + batchSize + '&offset=' + (offset + batchSize)
      : 'COMPLETE',
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: XGB_BACKFILL — Compute XGB win prob for all mc_backtest_results rows
//   ?phase=xgb_backfill&n=500
// ══════════════════════════════════════════════════════════════════════════════
async function phaseXGBBackfill(sql, url) {
  if (!XGB_MODEL) return { error: 'XGB model not loaded — xgb-model.json missing' };

  var batchSize = parseInt(url.searchParams.get('n') || '500');
  var startTime = Date.now();
  var TIME_BUDGET_MS = 100000;

  var rows = await sql`
    SELECT s.game_id, s.checkpoint, s.team_stats, s.pbp_derived,
           s.indicators->>'controlTeam' AS ctrl_team,
           s.indicators->>'homeAlias' AS home_alias
    FROM nba_snapshot_backtest s
    JOIN mc_backtest_results mc ON mc.game_id = s.game_id AND mc.checkpoint = s.checkpoint
    WHERE mc.xgb_win_prob IS NULL
      AND s.team_stats IS NOT NULL
    ORDER BY s.game_id, s.checkpoint
    LIMIT ${batchSize}
  `;

  if (rows.length === 0) {
    var total = await sql`SELECT COUNT(*) AS n, COUNT(xgb_win_prob) AS xgb FROM mc_backtest_results`;
    return {
      status: 'ok',
      message: 'XGB backfill complete',
      total: Number(total[0]?.n || 0),
      xgb_populated: Number(total[0]?.xgb || 0),
      nextStep: 'COMPLETE',
    };
  }

  var processed = 0, skipped = 0;

  for (var r of rows) {
    if (Date.now() - startTime > TIME_BUDGET_MS) break;

    var ts = typeof r.team_stats === 'string' ? JSON.parse(r.team_stats) : r.team_stats;
    var pbp = typeof r.pbp_derived === 'string' ? JSON.parse(r.pbp_derived) : (r.pbp_derived || {});

    var features = extractXGBFeaturesBacktest(ts, pbp, r.ctrl_team, r.home_alias);
    if (!features) { skipped++; continue; }

    var xgbProb = predictXGB(features);
    if (xgbProb == null) { skipped++; continue; }

    await sql`
      UPDATE mc_backtest_results
      SET xgb_win_prob = ${xgbProb}
      WHERE game_id = ${r.game_id} AND checkpoint = ${r.checkpoint}
    `;
    processed++;
  }

  var remaining = await sql`
    SELECT COUNT(*) AS n FROM mc_backtest_results WHERE xgb_win_prob IS NULL
  `;

  return {
    status: 'ok',
    phase: 'xgb_backfill',
    processed,
    skipped,
    remaining: Number(remaining[0]?.n || 0),
    nextStep: Number(remaining[0]?.n || 0) > 0
      ? '?phase=xgb_backfill&n=' + batchSize
      : 'COMPLETE',
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: CROSS_CONCORDANCE — 3×3×3 signal agreement matrix (Test 1)
//   ?phase=cross_concordance
// ══════════════════════════════════════════════════════════════════════════════
async function phaseCrossConcordance(sql) {
  // Main 27-cell matrix
  var matrix = await sql`
    SELECT
      CASE WHEN floor_score > 0.70 THEN 'HIGH' WHEN floor_score >= 0.50 THEN 'MED' ELSE 'LOW' END AS floor_b,
      CASE WHEN mc_win_prob > 0.70 THEN 'HIGH' WHEN mc_win_prob >= 0.50 THEN 'MED' ELSE 'LOW' END AS mc_b,
      CASE WHEN xgb_win_prob > 0.70 THEN 'HIGH' WHEN xgb_win_prob >= 0.50 THEN 'MED' ELSE 'LOW' END AS xgb_b,
      COUNT(*) AS n,
      ROUND(AVG(CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END) * 100::numeric, 1) AS ctrl_win_pct,
      ROUND(AVG(margin_at_snapshot)::numeric, 1) AS avg_margin,
      ROUND(AVG(final_margin)::numeric, 1) AS avg_final_margin
    FROM mc_backtest_results
    WHERE mc_win_prob IS NOT NULL AND xgb_win_prob IS NOT NULL AND floor_score IS NOT NULL
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  `;

  // Marginal win rates per signal per bucket
  var floorMarginal = await sql`
    SELECT CASE WHEN floor_score > 0.70 THEN 'HIGH' WHEN floor_score >= 0.50 THEN 'MED' ELSE 'LOW' END AS bucket,
           COUNT(*) AS n,
           ROUND(AVG(CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END) * 100::numeric, 1) AS ctrl_win_pct
    FROM mc_backtest_results WHERE floor_score IS NOT NULL
    GROUP BY 1 ORDER BY 1
  `;
  var mcMarginal = await sql`
    SELECT CASE WHEN mc_win_prob > 0.70 THEN 'HIGH' WHEN mc_win_prob >= 0.50 THEN 'MED' ELSE 'LOW' END AS bucket,
           COUNT(*) AS n,
           ROUND(AVG(CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END) * 100::numeric, 1) AS ctrl_win_pct
    FROM mc_backtest_results WHERE mc_win_prob IS NOT NULL
    GROUP BY 1 ORDER BY 1
  `;
  var xgbMarginal = await sql`
    SELECT CASE WHEN xgb_win_prob > 0.70 THEN 'HIGH' WHEN xgb_win_prob >= 0.50 THEN 'MED' ELSE 'LOW' END AS bucket,
           COUNT(*) AS n,
           ROUND(AVG(CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END) * 100::numeric, 1) AS ctrl_win_pct
    FROM mc_backtest_results WHERE xgb_win_prob IS NOT NULL
    GROUP BY 1 ORDER BY 1
  `;

  // Key named cells
  var keyStates = await sql`
    SELECT
      CASE
        WHEN floor_score > 0.70 AND mc_win_prob > 0.70 AND xgb_win_prob > 0.70 THEN 'ALL_HIGH'
        WHEN floor_score < 0.50 AND mc_win_prob < 0.50 AND xgb_win_prob < 0.50 THEN 'ALL_LOW'
        WHEN floor_score > 0.70 AND mc_win_prob < 0.50 THEN 'FLOOR_HIGH_MC_LOW'
        WHEN mc_win_prob > 0.70 AND floor_score < 0.50 THEN 'MC_HIGH_FLOOR_LOW'
        WHEN xgb_win_prob > 0.70 AND mc_win_prob < 0.50 THEN 'XGB_HIGH_MC_LOW'
        WHEN mc_win_prob > 0.70 AND xgb_win_prob < 0.50 THEN 'MC_HIGH_XGB_LOW'
        ELSE NULL
      END AS state_name,
      COUNT(*) AS n,
      ROUND(AVG(CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END) * 100::numeric, 1) AS ctrl_win_pct,
      ROUND(AVG(margin_at_snapshot)::numeric, 1) AS avg_margin
    FROM mc_backtest_results
    WHERE mc_win_prob IS NOT NULL AND xgb_win_prob IS NOT NULL AND floor_score IS NOT NULL
    GROUP BY 1
    HAVING CASE
        WHEN floor_score > 0.70 AND mc_win_prob > 0.70 AND xgb_win_prob > 0.70 THEN 'ALL_HIGH'
        WHEN floor_score < 0.50 AND mc_win_prob < 0.50 AND xgb_win_prob < 0.50 THEN 'ALL_LOW'
        WHEN floor_score > 0.70 AND mc_win_prob < 0.50 THEN 'FLOOR_HIGH_MC_LOW'
        WHEN mc_win_prob > 0.70 AND floor_score < 0.50 THEN 'MC_HIGH_FLOOR_LOW'
        WHEN xgb_win_prob > 0.70 AND mc_win_prob < 0.50 THEN 'XGB_HIGH_MC_LOW'
        WHEN mc_win_prob > 0.70 AND xgb_win_prob < 0.50 THEN 'MC_HIGH_XGB_LOW'
        ELSE NULL
      END IS NOT NULL
    ORDER BY state_name
  `;

  return {
    status: 'ok',
    phase: 'cross_concordance',
    total_rows: matrix.reduce(function(s, r) { return s + Number(r.n); }, 0),
    matrix: matrix,
    marginals: { floor: floorMarginal, mc: mcMarginal, xgb: xgbMarginal },
    key_states: keyStates,
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: CROSS_FAILURE — Which signals catch losses? (Test 2)
//   ?phase=cross_failure&checkpoint=Q3_END  (default Q3_END)
// ══════════════════════════════════════════════════════════════════════════════
async function phaseCrossFailure(sql, url) {
  var cp = url.searchParams.get('checkpoint') || 'Q3_END';

  // Attribution at chosen checkpoint — games where ctrl LOST
  var attr = await sql`
    SELECT
      CASE
        WHEN floor_score > 0.65 AND mc_win_prob > 0.65 AND xgb_win_prob > 0.65 THEN 'ALL_WRONG'
        WHEN floor_score > 0.65 AND xgb_win_prob > 0.65 AND mc_win_prob <= 0.50 THEN 'ONLY_MC_RIGHT'
        WHEN floor_score > 0.65 AND mc_win_prob > 0.65 AND xgb_win_prob <= 0.50 THEN 'ONLY_XGB_RIGHT'
        WHEN mc_win_prob > 0.65 AND xgb_win_prob > 0.65 AND floor_score <= 0.50 THEN 'ONLY_FLOOR_RIGHT'
        WHEN floor_score > 0.65 AND mc_win_prob <= 0.50 AND xgb_win_prob <= 0.50 THEN 'MC_AND_XGB_RIGHT'
        WHEN mc_win_prob > 0.65 AND floor_score <= 0.50 AND xgb_win_prob <= 0.50 THEN 'FLOOR_AND_XGB_RIGHT'
        WHEN xgb_win_prob > 0.65 AND floor_score <= 0.50 AND mc_win_prob <= 0.50 THEN 'MC_AND_FLOOR_RIGHT'
        WHEN floor_score <= 0.50 AND mc_win_prob <= 0.50 AND xgb_win_prob <= 0.50 THEN 'ALL_RIGHT'
        ELSE 'MIXED'
      END AS attribution,
      COUNT(*) AS n,
      ROUND(AVG(margin_at_snapshot)::numeric, 1) AS avg_margin,
      ROUND(AVG(final_margin)::numeric, 1) AS avg_final_margin
    FROM mc_backtest_results
    WHERE checkpoint = ${cp}
      AND ctrl_team_won = false
      AND mc_win_prob IS NOT NULL AND xgb_win_prob IS NOT NULL AND floor_score IS NOT NULL
    GROUP BY 1
    ORDER BY n DESC
  `;

  // Same for checkpoint Q4_6
  var attr_q4 = await sql`
    SELECT
      CASE
        WHEN floor_score > 0.65 AND mc_win_prob > 0.65 AND xgb_win_prob > 0.65 THEN 'ALL_WRONG'
        WHEN floor_score > 0.65 AND xgb_win_prob > 0.65 AND mc_win_prob <= 0.50 THEN 'ONLY_MC_RIGHT'
        WHEN floor_score > 0.65 AND mc_win_prob > 0.65 AND xgb_win_prob <= 0.50 THEN 'ONLY_XGB_RIGHT'
        WHEN mc_win_prob > 0.65 AND xgb_win_prob > 0.65 AND floor_score <= 0.50 THEN 'ONLY_FLOOR_RIGHT'
        WHEN floor_score > 0.65 AND mc_win_prob <= 0.50 AND xgb_win_prob <= 0.50 THEN 'MC_AND_XGB_RIGHT'
        WHEN mc_win_prob > 0.65 AND floor_score <= 0.50 AND xgb_win_prob <= 0.50 THEN 'FLOOR_AND_XGB_RIGHT'
        WHEN xgb_win_prob > 0.65 AND floor_score <= 0.50 AND mc_win_prob <= 0.50 THEN 'MC_AND_FLOOR_RIGHT'
        WHEN floor_score <= 0.50 AND mc_win_prob <= 0.50 AND xgb_win_prob <= 0.50 THEN 'ALL_RIGHT'
        ELSE 'MIXED'
      END AS attribution,
      COUNT(*) AS n
    FROM mc_backtest_results
    WHERE checkpoint = 'Q4_6'
      AND ctrl_team_won = false
      AND mc_win_prob IS NOT NULL AND xgb_win_prob IS NOT NULL AND floor_score IS NOT NULL
    GROUP BY 1
    ORDER BY n DESC
  `;

  // False alarms — ctrl WON but signal was LOW
  var falseAlarms = await sql`
    SELECT
      'floor' AS signal,
      COUNT(*) FILTER (WHERE floor_score < 0.50 AND ctrl_team_won) AS false_exits,
      COUNT(*) FILTER (WHERE floor_score < 0.50) AS total_low,
      COUNT(*) FILTER (WHERE ctrl_team_won) AS total_wins
    FROM mc_backtest_results
    WHERE checkpoint = ${cp} AND floor_score IS NOT NULL
    UNION ALL
    SELECT 'mc',
      COUNT(*) FILTER (WHERE mc_win_prob < 0.50 AND ctrl_team_won),
      COUNT(*) FILTER (WHERE mc_win_prob < 0.50),
      COUNT(*) FILTER (WHERE ctrl_team_won)
    FROM mc_backtest_results
    WHERE checkpoint = ${cp} AND mc_win_prob IS NOT NULL
    UNION ALL
    SELECT 'xgb',
      COUNT(*) FILTER (WHERE xgb_win_prob < 0.50 AND ctrl_team_won),
      COUNT(*) FILTER (WHERE xgb_win_prob < 0.50),
      COUNT(*) FILTER (WHERE ctrl_team_won)
    FROM mc_backtest_results
    WHERE checkpoint = ${cp} AND xgb_win_prob IS NOT NULL
  `;

  return {
    status: 'ok',
    phase: 'cross_failure',
    checkpoint: cp,
    attribution_at_cp: attr,
    attribution_at_Q4_6: attr_q4,
    false_alarms: falseAlarms,
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: CROSS_MARGINAL — MC's value when added to Floor+XGB (Test 3)
//   ?phase=cross_marginal
// ══════════════════════════════════════════════════════════════════════════════
async function phaseCrossMarginal(sql) {
  // 3a: Double-confident losses — floor>0.65 AND xgb>0.65 AND ctrl lost
  var doubleConfidentLosses = await sql`
    SELECT
      COUNT(*) AS total_losses,
      COUNT(*) FILTER (WHERE mc_win_prob < 0.50) AS mc_warned,
      COUNT(*) FILTER (WHERE mc_win_prob < 0.40) AS mc_strong_warn,
      COUNT(*) FILTER (WHERE mc_win_prob < 0.30) AS mc_alarm,
      ROUND(AVG(mc_win_prob)::numeric, 3) AS avg_mc,
      ROUND(AVG(margin_at_snapshot)::numeric, 1) AS avg_margin,
      checkpoint
    FROM mc_backtest_results
    WHERE floor_score > 0.65 AND xgb_win_prob > 0.65
      AND ctrl_team_won = false
      AND mc_win_prob IS NOT NULL
    GROUP BY checkpoint
    ORDER BY checkpoint
  `;

  // 3b: Double-exit signals — floor<0.50 AND xgb<0.50 AND ctrl WON
  var doubleExitWins = await sql`
    SELECT
      COUNT(*) AS total_wins,
      COUNT(*) FILTER (WHERE mc_win_prob > 0.60) AS mc_held,
      COUNT(*) FILTER (WHERE mc_win_prob > 0.70) AS mc_strong_hold,
      ROUND(AVG(mc_win_prob)::numeric, 3) AS avg_mc,
      checkpoint
    FROM mc_backtest_results
    WHERE floor_score < 0.50 AND xgb_win_prob < 0.50
      AND ctrl_team_won = true
      AND mc_win_prob IS NOT NULL
    GROUP BY checkpoint
    ORDER BY checkpoint
  `;

  // 3c: MC solo alarm — mc<0.50 AND floor>0.60 AND xgb>0.60
  var mcSoloAlarm = await sql`
    SELECT
      COUNT(*) AS n,
      COUNT(*) FILTER (WHERE ctrl_team_won = false) AS mc_right,
      COUNT(*) FILTER (WHERE ctrl_team_won = true) AS mc_false_alarm,
      ROUND(AVG(CASE WHEN ctrl_team_won = false THEN 1.0 ELSE 0.0 END) * 100::numeric, 1) AS precision,
      ROUND(AVG(margin_at_snapshot)::numeric, 1) AS avg_margin,
      checkpoint
    FROM mc_backtest_results
    WHERE mc_win_prob < 0.50 AND floor_score > 0.60 AND xgb_win_prob > 0.60
      AND mc_win_prob IS NOT NULL
    GROUP BY checkpoint
    ORDER BY checkpoint
  `;

  // Summary across all Q3+ checkpoints
  var q3PlusSummary = await sql`
    SELECT
      'double_confident_losses' AS metric,
      COUNT(*) AS n,
      COUNT(*) FILTER (WHERE mc_win_prob < 0.50) AS mc_caught
    FROM mc_backtest_results
    WHERE floor_score > 0.65 AND xgb_win_prob > 0.65
      AND ctrl_team_won = false
      AND mc_win_prob IS NOT NULL
      AND period >= 3
    UNION ALL
    SELECT 'mc_solo_alarm',
      COUNT(*),
      COUNT(*) FILTER (WHERE ctrl_team_won = false)
    FROM mc_backtest_results
    WHERE mc_win_prob < 0.50 AND floor_score > 0.60 AND xgb_win_prob > 0.60
      AND mc_win_prob IS NOT NULL
      AND period >= 3
  `;

  return {
    status: 'ok',
    phase: 'cross_marginal',
    catches_losses: doubleConfidentLosses,
    prevents_exits: doubleExitWins,
    solo_alarm: mcSoloAlarm,
    q3_plus_summary: q3PlusSummary,
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: CROSS_COMPOUNDS — Named compound states with precision (Test 4)
//   ?phase=cross_compounds
// ══════════════════════════════════════════════════════════════════════════════
async function phaseCrossCompounds(sql) {
  // Compound states — Q3+ checkpoints only (decision-relevant)
  var compounds = await sql`
    WITH states AS (
      SELECT *,
        -- Margin velocity: compare to 2 checkpoints prior in same game
        margin_at_snapshot - LAG(margin_at_snapshot, 2) OVER (PARTITION BY game_id ORDER BY period, clock_sec DESC) AS margin_delta_2cp
      FROM mc_backtest_results
      WHERE mc_win_prob IS NOT NULL AND xgb_win_prob IS NOT NULL AND floor_score IS NOT NULL
        AND period >= 3
    )
    SELECT
      CASE
        WHEN floor_score > 0.80 AND mc_win_prob > 0.80 AND xgb_win_prob > 0.80 THEN 'FORTRESS'
        WHEN floor_score > 0.70 AND mc_win_prob > 0.70 AND xgb_win_prob > 0.70 AND margin_at_snapshot > 0 THEN 'CONSENSUS_STRONG'
        WHEN floor_score > 0.75 AND mc_win_prob < 0.50 AND xgb_win_prob > 0.70 THEN 'ANCHORED_DECAY'
        WHEN floor_score > 0.65 AND mc_win_prob < 0.50 AND xgb_win_prob > 0.60 AND ABS(margin_at_snapshot) <= 8 THEN 'EARLY_WARNING'
        WHEN floor_score < 0.55 AND mc_win_prob < 0.40 AND xgb_win_prob < 0.55 THEN 'CONFIRMED_COLLAPSE'
        WHEN floor_score > 0.65 AND mc_win_prob > 0.65 AND xgb_win_prob < 0.45 THEN 'STRUCTURAL_BUY'
        WHEN mc_win_prob < 0.40 AND floor_score > 0.65 AND xgb_win_prob > 0.65 THEN 'MC_SOLO_EXIT'
        WHEN floor_score < 0.55 AND mc_win_prob > 0.65 AND xgb_win_prob < 0.50 THEN 'RECOVERY_CONFIRMED'
        WHEN floor_score < 0.50 AND mc_win_prob < 0.40 AND xgb_win_prob < 0.50 THEN 'CONSENSUS_EXIT'
        WHEN floor_score > 0.70 AND margin_delta_2cp IS NOT NULL AND margin_delta_2cp <= -10 THEN 'MARGIN_COLLAPSE'
        WHEN floor_score > 0.65 AND mc_win_prob < 0.55 AND margin_delta_2cp IS NOT NULL AND margin_delta_2cp <= -6 THEN 'MARGIN_COMPRESS'
        ELSE NULL
      END AS compound_state,
      COUNT(*) AS n,
      ROUND(AVG(CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END) * 100::numeric, 1) AS ctrl_win_pct,
      ROUND(AVG(final_margin)::numeric, 1) AS avg_final_margin,
      ROUND(AVG(margin_at_snapshot)::numeric, 1) AS avg_margin_at_snap,
      ROUND(AVG(4 - period + clock_sec / 720.0)::numeric, 2) AS avg_quarters_remaining
    FROM states
    WHERE CASE
        WHEN floor_score > 0.80 AND mc_win_prob > 0.80 AND xgb_win_prob > 0.80 THEN 'FORTRESS'
        WHEN floor_score > 0.70 AND mc_win_prob > 0.70 AND xgb_win_prob > 0.70 AND margin_at_snapshot > 0 THEN 'CONSENSUS_STRONG'
        WHEN floor_score > 0.75 AND mc_win_prob < 0.50 AND xgb_win_prob > 0.70 THEN 'ANCHORED_DECAY'
        WHEN floor_score > 0.65 AND mc_win_prob < 0.50 AND xgb_win_prob > 0.60 AND ABS(margin_at_snapshot) <= 8 THEN 'EARLY_WARNING'
        WHEN floor_score < 0.55 AND mc_win_prob < 0.40 AND xgb_win_prob < 0.55 THEN 'CONFIRMED_COLLAPSE'
        WHEN floor_score > 0.65 AND mc_win_prob > 0.65 AND xgb_win_prob < 0.45 THEN 'STRUCTURAL_BUY'
        WHEN mc_win_prob < 0.40 AND floor_score > 0.65 AND xgb_win_prob > 0.65 THEN 'MC_SOLO_EXIT'
        WHEN floor_score < 0.55 AND mc_win_prob > 0.65 AND xgb_win_prob < 0.50 THEN 'RECOVERY_CONFIRMED'
        WHEN floor_score < 0.50 AND mc_win_prob < 0.40 AND xgb_win_prob < 0.50 THEN 'CONSENSUS_EXIT'
        WHEN floor_score > 0.70 AND margin_delta_2cp IS NOT NULL AND margin_delta_2cp <= -10 THEN 'MARGIN_COLLAPSE'
        WHEN floor_score > 0.65 AND mc_win_prob < 0.55 AND margin_delta_2cp IS NOT NULL AND margin_delta_2cp <= -6 THEN 'MARGIN_COMPRESS'
        ELSE NULL
      END IS NOT NULL
    GROUP BY 1
    ORDER BY ctrl_win_pct DESC
  `;

  // Baselines for comparison
  var baselines = await sql`
    SELECT
      'floor_high_alone' AS baseline,
      COUNT(*) AS n,
      ROUND(AVG(CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END) * 100::numeric, 1) AS ctrl_win_pct
    FROM mc_backtest_results
    WHERE floor_score > 0.70 AND period >= 3 AND floor_score IS NOT NULL
    UNION ALL
    SELECT 'xgb_high_alone',
      COUNT(*),
      ROUND(AVG(CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END) * 100::numeric, 1)
    FROM mc_backtest_results
    WHERE xgb_win_prob > 0.70 AND period >= 3 AND xgb_win_prob IS NOT NULL
    UNION ALL
    SELECT 'mc_high_alone',
      COUNT(*),
      ROUND(AVG(CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END) * 100::numeric, 1)
    FROM mc_backtest_results
    WHERE mc_win_prob > 0.70 AND period >= 3 AND mc_win_prob IS NOT NULL
  `;

  // Margin velocity standalone — does margin compression predict independently?
  var marginVelocity = await sql`
    WITH mv AS (
      SELECT *,
        margin_at_snapshot - LAG(margin_at_snapshot, 2) OVER (PARTITION BY game_id ORDER BY period, clock_sec DESC) AS mdelta
      FROM mc_backtest_results
      WHERE period >= 3 AND mc_win_prob IS NOT NULL
    )
    SELECT
      CASE
        WHEN mdelta <= -15 THEN 'CRASH_15plus'
        WHEN mdelta <= -10 THEN 'CRASH_10_15'
        WHEN mdelta <= -6 THEN 'COMPRESS_6_10'
        WHEN mdelta <= -3 THEN 'MILD_3_6'
        WHEN mdelta BETWEEN -2 AND 2 THEN 'STABLE'
        WHEN mdelta >= 3 THEN 'EXPANDING'
        ELSE NULL
      END AS velocity_bucket,
      COUNT(*) AS n,
      ROUND(AVG(CASE WHEN ctrl_team_won THEN 1.0 ELSE 0.0 END) * 100::numeric, 1) AS ctrl_win_pct,
      ROUND(AVG(margin_at_snapshot)::numeric, 1) AS avg_margin
    FROM mv
    WHERE mdelta IS NOT NULL
    GROUP BY 1
    ORDER BY ctrl_win_pct
  `;

  return {
    status: 'ok',
    phase: 'cross_compounds',
    compound_states: compounds,
    baselines: baselines,
    margin_velocity: marginVelocity,
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: CROSS_TEMPORAL — Per-checkpoint AUC for each signal + ensembles (Test 5)
//   ?phase=cross_temporal
// ══════════════════════════════════════════════════════════════════════════════
async function phaseCrossTemporal(sql) {
  // Get all data with all three signals present
  var rows = await sql`
    SELECT checkpoint, period, mc_win_prob, xgb_win_prob, floor_score, ctrl_team_won
    FROM mc_backtest_results
    WHERE mc_win_prob IS NOT NULL AND xgb_win_prob IS NOT NULL AND floor_score IS NOT NULL
    ORDER BY checkpoint
  `;

  // Group by checkpoint and compute AUC for each signal + ensembles
  var grouped = {};
  for (var r of rows) {
    if (!grouped[r.checkpoint]) grouped[r.checkpoint] = [];
    grouped[r.checkpoint].push({
      mc: Number(r.mc_win_prob),
      xgb: Number(r.xgb_win_prob),
      floor: Number(r.floor_score),
      won: r.ctrl_team_won,
      period: Number(r.period),
    });
  }

  var results = [];
  for (var cpLabel of CP_LABELS) {
    var data = grouped[cpLabel];
    if (!data || data.length < 10) continue;

    var period = data[0].period;

    // Ensemble weights — quarter-adaptive
    var mcW, xgbW, floorW;
    if (period <= 2) { mcW = 0.20; xgbW = 0.50; floorW = 0.30; }
    else if (period === 3) { mcW = 0.35; xgbW = 0.35; floorW = 0.30; }
    else { mcW = 0.50; xgbW = 0.30; floorW = 0.20; }

    // Compute ensembles
    for (var d of data) {
      d.avg = (d.mc + d.xgb + d.floor) / 3;
      d.xgb_heavy = 0.50 * d.xgb + 0.30 * d.mc + 0.20 * d.floor;
      d.mc_heavy = 0.50 * d.mc + 0.30 * d.xgb + 0.20 * d.floor;
      d.adaptive = mcW * d.mc + xgbW * d.xgb + floorW * d.floor;
    }

    results.push({
      checkpoint: cpLabel,
      period: period,
      n: data.length,
      auc_floor: computeAUC(data, 'floor'),
      auc_mc: computeAUC(data, 'mc'),
      auc_xgb: computeAUC(data, 'xgb'),
      auc_avg: computeAUC(data, 'avg'),
      auc_xgb_heavy: computeAUC(data, 'xgb_heavy'),
      auc_mc_heavy: computeAUC(data, 'mc_heavy'),
      auc_adaptive: computeAUC(data, 'adaptive'),
    });
  }

  return {
    status: 'ok',
    phase: 'cross_temporal',
    checkpoints: results,
  };
}

// Simple AUC computation (Wilcoxon-Mann-Whitney statistic)
function computeAUC(data, field) {
  var pos = [], neg = [];
  for (var d of data) {
    if (d.won) pos.push(d[field]); else neg.push(d[field]);
  }
  if (pos.length === 0 || neg.length === 0) return null;

  // Sort both arrays
  pos.sort(function(a, b) { return a - b; });
  neg.sort(function(a, b) { return a - b; });

  // Count concordant pairs
  var concordant = 0, ties = 0;
  var ni = 0;
  for (var pi = 0; pi < pos.length; pi++) {
    while (ni < neg.length && neg[ni] < pos[pi]) ni++;
    concordant += ni;
    // Count ties at this value
    var ti = ni;
    while (ti < neg.length && neg[ti] === pos[pi]) ti++;
    ties += (ti - ni);
  }

  return Math.round(((concordant + 0.5 * ties) / (pos.length * neg.length)) * 1000) / 1000;
}


// ══════════════════════════════════════════════════════════════════════════════
// PHASE: CROSS_REPLAY — Match historical alerts against MC data (Test 6)
//   ?phase=cross_replay
// ══════════════════════════════════════════════════════════════════════════════
async function phaseCrossReplay(sql) {
  // Join alerts with nearest mc_backtest_results checkpoint
  // alerts have game_id (bdl), period, clock — find closest backtest checkpoint
  var wrongSends = await sql`
    WITH alert_mc AS (
      SELECT a.id, a.game_id, a.alert_type, a.alert_tier, a.agent_decision,
             a.period, a.clock, a.position_team,
             mc.mc_win_prob, mc.xgb_win_prob, mc.floor_score,
             mc.ctrl_team_won, mc.margin_at_snapshot AS mc_margin,
             mc.checkpoint,
             ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY
               ABS(mc.period - a.period) * 720 +
               ABS(COALESCE(mc.clock_sec, 0) - COALESCE(
                 CASE WHEN a.clock ~ '^[0-9]+:[0-9]+$'
                      THEN SPLIT_PART(a.clock, ':', 1)::int * 60 + SPLIT_PART(a.clock, ':', 2)::int
                      ELSE 0 END, 0))
             ) AS rn
      FROM alerts a
      JOIN mc_backtest_results mc ON mc.game_id = a.game_id::int
      WHERE a.agent_decision = 'SEND'
        AND a.alert_type IN ('BUY', 'BWC', 'WINDOW_BUY', 'POSITION_OPEN')
        AND mc.mc_win_prob IS NOT NULL
        AND mc.xgb_win_prob IS NOT NULL
    )
    SELECT alert_type, alert_tier,
      COUNT(*) AS total_sends,
      COUNT(*) FILTER (WHERE ctrl_team_won = false) AS wrong_sends,
      COUNT(*) FILTER (WHERE ctrl_team_won = false AND mc_win_prob < 0.50) AS mc_would_warn,
      COUNT(*) FILTER (WHERE ctrl_team_won = false AND mc_win_prob < 0.40) AS mc_strong_warn,
      ROUND(AVG(CASE WHEN ctrl_team_won = false THEN mc_win_prob END)::numeric, 3) AS avg_mc_on_wrong
    FROM alert_mc
    WHERE rn = 1
    GROUP BY alert_type, alert_tier
    ORDER BY alert_type, alert_tier
  `;

  // Good suppressions — agent suppressed, team would have lost
  var goodSuppresses = await sql`
    WITH alert_mc AS (
      SELECT a.id, a.alert_type, a.agent_decision,
             mc.mc_win_prob, mc.ctrl_team_won,
             ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY
               ABS(mc.period - a.period) * 720) AS rn
      FROM alerts a
      JOIN mc_backtest_results mc ON mc.game_id = a.game_id::int
      WHERE a.agent_decision = 'SUPPRESS'
        AND mc.mc_win_prob IS NOT NULL
    )
    SELECT
      COUNT(*) AS total_suppresses,
      COUNT(*) FILTER (WHERE ctrl_team_won = false) AS correct_suppresses,
      COUNT(*) FILTER (WHERE ctrl_team_won = false AND mc_win_prob < 0.50) AS mc_agreed,
      COUNT(*) FILTER (WHERE ctrl_team_won = true) AS missed_opportunities,
      COUNT(*) FILTER (WHERE ctrl_team_won = true AND mc_win_prob > 0.70) AS mc_would_override
    FROM alert_mc
    WHERE rn = 1
  `;

  return {
    status: 'ok',
    phase: 'cross_replay',
    wrong_sends_by_type: wrongSends,
    suppress_analysis: goodSuppresses,
  };
}
// ══════════════════════════════════════════════════════════════════════════════
// PHASE: CROSS_TRIGGERED — Triggered MC cross-signal analysis
//   Same canary + post-trigger MC as triggered_replay, enriched with
//   floor and XGB at trigger/confirm points. Answers: "when triggered MC
//   says CONFIRMED, are floor and XGB still anchored high?"
//   ?phase=cross_triggered&n=200&offset=0
// ══════════════════════════════════════════════════════════════════════════════
async function phaseCrossTriggered(sql, url) {
  var batchSize = parseInt(url.searchParams.get('n') || '200');
  var offset = parseInt(url.searchParams.get('offset') || '0');
  var canaryThreshold = parseFloat(url.searchParams.get('canary') || '0.15');
  var canaryMode = url.searchParams.get('canary_mode') || 'combined';
  var mcThreshold = parseFloat(url.searchParams.get('mc_threshold') || '0.70');
  var simCount = parseInt(url.searchParams.get('sims') || '300');
  var regressionCap = parseFloat(url.searchParams.get('rc') || '0.60');
  var startTime = Date.now();

  var gameIds = await sql`
    SELECT DISTINCT game_id FROM nba_snapshot_backtest
    WHERE indicators IS NOT NULL
    ORDER BY game_id
    LIMIT ${batchSize} OFFSET ${offset}
  `;
  var totalGames = await sql`SELECT COUNT(DISTINCT game_id) AS n FROM nba_snapshot_backtest WHERE indicators IS NOT NULL`;

  if (gameIds.length === 0) return { status: 'ok', message: 'No more games' };
  var ids = gameIds.map(function(r) { return r.game_id; });

  // Fetch backtest checkpoints
  var rows = await sql`
    SELECT game_id, checkpoint, team_stats, pbp_derived,
           (indicators->>'score')::real AS floor,
           indicators->>'controlTeam' AS ctrl_team,
           indicators->>'homeAlias' AS home_alias,
           indicators->>'awayAlias' AS away_alias,
           margin_at_snapshot AS margin,
           ctrl_team_won, final_margin
    FROM nba_snapshot_backtest
    WHERE game_id = ANY(${ids}) AND indicators IS NOT NULL AND indicators->>'no_data' IS NULL
    ORDER BY game_id, checkpoint
  `;

  // Fetch XGB from mc_backtest_results
  var xgbRows = await sql`
    SELECT game_id, checkpoint, xgb_win_prob
    FROM mc_backtest_results
    WHERE game_id = ANY(${ids}) AND xgb_win_prob IS NOT NULL
  `;
  var xgbMap = {};
  for (var xr of xgbRows) {
    xgbMap[xr.game_id + '_' + xr.checkpoint] = Number(xr.xgb_win_prob);
  }

  // Group by game
  var gameMap = {};
  for (var r of rows) {
    if (!gameMap[r.game_id]) gameMap[r.game_id] = [];
    var ts = typeof r.team_stats === 'string' ? JSON.parse(r.team_stats) : r.team_stats;
    var pbp = typeof r.pbp_derived === 'string' ? JSON.parse(r.pbp_derived) : (r.pbp_derived || {});
    gameMap[r.game_id].push({
      checkpoint: r.checkpoint, cpIdx: CP_INDEX[r.checkpoint],
      home: ts ? ts.home : null, away: ts ? ts.away : null,
      pbp: pbp,
      floor: r.floor, ctrl_team: r.ctrl_team,
      home_alias: r.home_alias, away_alias: r.away_alias,
      margin: r.margin, ctrl_team_won: r.ctrl_team_won, final_margin: r.final_margin,
    });
  }
  for (var gid of Object.keys(gameMap)) {
    gameMap[gid].sort(function(a, b) { return a.cpIdx - b.cpIdx; });
  }

  // Aggregation
  var agg = {
    total: 0, triggered: 0,
    patterns: {},
    // At-trigger signal states
    trigger_signals: { floor_sum: 0, xgb_sum: 0, n: 0, floor_high: 0, xgb_high: 0 },
    // At-confirm signal states (CLEAN+WAVE games that reached CONFIRMED)
    confirm_signals: { floor_sum: 0, xgb_sum: 0, n: 0, floor_high: 0, xgb_high: 0 },
    // Compound precision: triggered CONFIRMED + floor/xgb state
    compounds: {
      conf_floor_high: { n: 0, right: 0 },       // CONFIRMED + floor>0.70
      conf_floor_high_xgb_high: { n: 0, right: 0 }, // CONFIRMED + floor>0.70 + xgb>0.70
      conf_xgb_low: { n: 0, right: 0 },           // CONFIRMED + xgb<0.50 (both agree)
      conf_xgb_high: { n: 0, right: 0 },          // CONFIRMED + xgb>0.70 (MC vs XGB disagreement)
      conf_all: { n: 0, right: 0 },               // all CONFIRMED
    },
    // Per-pattern signal detail
    pattern_signals: {},
  };

  for (var gid of Object.keys(gameMap)) {
    if (Date.now() - startTime > 92000) break;
    agg.total++;
    var cps = gameMap[gid];

    // Parse stats
    var parsed = cps.map(function(cp) {
      if (!cp.home || !cp.away) return null;
      return {
        home: { fgm: cp.home.fgm||0, fga: cp.home.fga||0, fg3m: cp.home.fg3m||0, fg3a: cp.home.fg3a||0,
                ftm: cp.home.ftm||0, fta: cp.home.fta||0, to: cp.home.to||0, oreb: cp.home.oreb||0 },
        away: { fgm: cp.away.fgm||0, fga: cp.away.fga||0, fg3m: cp.away.fg3m||0, fg3a: cp.away.fg3a||0,
                ftm: cp.away.ftm||0, fta: cp.away.fta||0, to: cp.away.to||0, oreb: cp.away.oreb||0 },
      };
    });

    // --- Canary trigger (identical to triggered_replay) ---
    var triggerIdx = null;
    for (var ci = 2; ci < cps.length; ci++) {
      var cp = cps[ci];
      if (cp.cpIdx < 6) continue;
      if (cp.checkpoint === 'Q4_END') continue;
      if (!parsed[ci] || !parsed[ci-2]) continue;

      var hRates = diffToRates(parsed[ci].home, parsed[ci-2].home, 0.36, regressionCap);
      var aRates = diffToRates(parsed[ci].away, parsed[ci-2].away, 0.36, regressionCap);
      if (!hRates || !aRates) continue;

      var meta = CP_META[cp.checkpoint]; if (!meta) continue;
      var rp = estimateRemainingPoss(parsed[ci].home, parsed[ci].away, meta.period, meta.clockSec);
      if (rp < 1) continue;

      var ctrlHome = cp.ctrl_team === cp.home_alias;
      var hScore = (parsed[ci].home.fgm - parsed[ci].home.fg3m)*2 + parsed[ci].home.fg3m*3 + parsed[ci].home.ftm;
      var aScore = (parsed[ci].away.fgm - parsed[ci].away.fg3m)*2 + parsed[ci].away.fg3m*3 + parsed[ci].away.ftm;

      var mc = runMonteCarloSim(hRates, aRates, hScore, aScore, rp,
        { simCount: 200, ctrlTeam: ctrlHome ? 'home' : 'away' });

      var canaryFired = false;
      if (canaryMode === 'absolute') {
        canaryFired = mc.winProb < mcThreshold;
      } else if (canaryMode === 'combined') {
        canaryFired = (cp.floor != null && (cp.floor - mc.winProb) > canaryThreshold) || mc.winProb < mcThreshold;
      } else {
        canaryFired = cp.floor != null && (cp.floor - mc.winProb) > canaryThreshold;
      }
      if (canaryFired) { triggerIdx = ci; break; }
    }

    if (triggerIdx === null) continue;
    agg.triggered++;

    var triggerCp = cps[triggerIdx];
    var triggerStats = parsed[triggerIdx];
    var ctrlWon = triggerCp.ctrl_team_won;
    var ctrlHome2 = triggerCp.ctrl_team === triggerCp.home_alias;
    var correct = !ctrlWon;

    // Capture floor + XGB at trigger
    var trigFloor = triggerCp.floor;
    var trigXgb = xgbMap[gid + '_' + triggerCp.checkpoint];
    if (trigFloor != null) {
      agg.trigger_signals.floor_sum += trigFloor;
      agg.trigger_signals.n++;
      if (trigFloor > 0.70) agg.trigger_signals.floor_high++;
    }
    if (trigXgb != null) {
      agg.trigger_signals.xgb_sum += trigXgb;
      if (trigXgb > 0.70) agg.trigger_signals.xgb_high++;
    }

    // --- Post-trigger investigation (identical to triggered_replay) ---
    var verdicts = [];
    var confirmCp = null; // checkpoint where first CONFIRMED
    var confirmFloor = null;
    var confirmXgb = null;

    for (var ti = triggerIdx + 1; ti < cps.length; ti++) {
      if (cps[ti].checkpoint === 'Q4_END') continue;
      if (!parsed[ti]) continue;

      var hR = diffToRates(parsed[ti].home, triggerStats.home, 0.36, regressionCap);
      var aR = diffToRates(parsed[ti].away, triggerStats.away, 0.36, regressionCap);
      if (!hR || !aR) continue;

      var postPoss = Math.round((hR._windowPoss + aR._windowPoss) / 2);
      if (postPoss < 4) continue;

      var m2 = CP_META[cps[ti].checkpoint]; if (!m2) continue;
      var rp2 = estimateRemainingPoss(parsed[ti].home, parsed[ti].away, m2.period, m2.clockSec);
      if (rp2 < 1) continue;

      var hS2 = (parsed[ti].home.fgm - parsed[ti].home.fg3m)*2 + parsed[ti].home.fg3m*3 + parsed[ti].home.ftm;
      var aS2 = (parsed[ti].away.fgm - parsed[ti].away.fg3m)*2 + parsed[ti].away.fg3m*3 + parsed[ti].away.ftm;

      var mc2 = runMonteCarloSim(hR, aR, hS2, aS2, rp2,
        { simCount: simCount, ctrlTeam: ctrlHome2 ? 'home' : 'away' });

      var v;
      if (postPoss < 8) v = 'INV';
      else if (mc2.winProb > 0.60) v = 'NORM';
      else if (mc2.winProb > 0.40) v = 'CONT';
      else if (mc2.winProb > 0.25) v = 'LIKELY';
      else v = 'CONF';

      verdicts.push(v);

      if (v === 'CONF' && !confirmCp) {
        confirmCp = cps[ti];
        confirmFloor = cps[ti].floor;
        confirmXgb = xgbMap[gid + '_' + cps[ti].checkpoint];
      }
    }

    // --- Pattern classification (identical to triggered_replay) ---
    var everConf = verdicts.indexOf('CONF') >= 0;
    var everLikely = verdicts.indexOf('LIKELY') >= 0 || everConf;
    var pattern;
    if (!everLikely) {
      pattern = 'FALSE_ALARM';
    } else {
      var firstAlarmIdx = -1;
      for (var si2 = 0; si2 < verdicts.length; si2++) {
        if (verdicts[si2] === 'CONF' || verdicts[si2] === 'LIKELY') { firstAlarmIdx = si2; break; }
      }
      var postAlarm = verdicts.slice(firstAlarmIdx);
      var hasNorm = postAlarm.indexOf('NORM') >= 0;
      if (!hasNorm) {
        pattern = 'CLEAN';
      } else {
        var normIdx2 = postAlarm.indexOf('NORM');
        var postNorm = postAlarm.slice(normIdx2);
        var reAlarmed = postNorm.some(function(v2) { return v2 === 'CONF' || v2 === 'LIKELY'; });
        pattern = reAlarmed ? 'WAVE' : 'NORMALIZED';
      }
    }

    // --- Record pattern + signal state ---
    if (!agg.patterns[pattern]) agg.patterns[pattern] = { n: 0, right: 0, floor_at_trig: [], xgb_at_trig: [], floor_at_conf: [], xgb_at_conf: [], xgb_buckets: { high: {n:0,right:0}, med: {n:0,right:0}, low: {n:0,right:0} }, floor_buckets: { high: {n:0,right:0}, med: {n:0,right:0}, low: {n:0,right:0} } };
    var pat = agg.patterns[pattern];
    pat.n++;
    if (correct) pat.right++;
    if (trigFloor != null) pat.floor_at_trig.push(trigFloor);
    if (trigXgb != null) pat.xgb_at_trig.push(trigXgb);

    // Per-pattern XGB/floor bucket precision — use confirm checkpoint for CLEAN/WAVE, trigger for others
    var bucketXgb = everConf && confirmXgb != null ? confirmXgb : trigXgb;
    var bucketFloor = everConf && confirmFloor != null ? confirmFloor : trigFloor;
    if (bucketXgb != null) {
      var xBucket = bucketXgb > 0.70 ? 'high' : bucketXgb >= 0.50 ? 'med' : 'low';
      pat.xgb_buckets[xBucket].n++;
      if (correct) pat.xgb_buckets[xBucket].right++;
    }
    if (bucketFloor != null) {
      var fBucket = bucketFloor > 0.70 ? 'high' : bucketFloor >= 0.50 ? 'med' : 'low';
      pat.floor_buckets[fBucket].n++;
      if (correct) pat.floor_buckets[fBucket].right++;
    }

    // Compound precision for games that reached CONFIRMED
    if (everConf) {
      agg.compounds.conf_all.n++;
      if (correct) agg.compounds.conf_all.right++;

      var cfFloor = confirmFloor != null ? confirmFloor : trigFloor;
      var cfXgb = confirmXgb != null ? confirmXgb : trigXgb;

      if (cfFloor != null) {
        agg.confirm_signals.floor_sum += cfFloor;
        agg.confirm_signals.n++;
        if (cfFloor > 0.70) agg.confirm_signals.floor_high++;
      }
      if (cfXgb != null) {
        agg.confirm_signals.xgb_sum += cfXgb;
        if (cfXgb > 0.70) agg.confirm_signals.xgb_high++;
      }
      if (confirmFloor != null) pat.floor_at_conf.push(confirmFloor);
      if (confirmXgb != null) pat.xgb_at_conf.push(confirmXgb);

      if (cfFloor != null && cfFloor > 0.70) {
        agg.compounds.conf_floor_high.n++;
        if (correct) agg.compounds.conf_floor_high.right++;
      }
      if (cfFloor != null && cfXgb != null && cfFloor > 0.70 && cfXgb > 0.70) {
        agg.compounds.conf_floor_high_xgb_high.n++;
        if (correct) agg.compounds.conf_floor_high_xgb_high.right++;
      }
      if (cfXgb != null && cfXgb < 0.50) {
        agg.compounds.conf_xgb_low.n++;
        if (correct) agg.compounds.conf_xgb_low.right++;
      }
      if (cfXgb != null && cfXgb > 0.70) {
        agg.compounds.conf_xgb_high.n++;
        if (correct) agg.compounds.conf_xgb_high.right++;
      }
    }
  }

  // Build summary
  function avg(arr) { return arr.length > 0 ? Math.round(arr.reduce(function(s,v){return s+v;},0)/arr.length*1000)/1000 : null; }
  function pct(arr, threshold) { return arr.length > 0 ? Math.round(arr.filter(function(v){return v>threshold;}).length/arr.length*1000)/10 : null; }
  function prec(obj) { return obj.n > 0 ? Math.round(obj.right/obj.n*1000)/10 : null; }

  var patternSummary = {};
  for (var pk of Object.keys(agg.patterns)) {
    var p = agg.patterns[pk];
    patternSummary[pk] = {
      n: p.n,
      right: p.right,
      precision: prec(p),
      at_trigger: {
        avg_floor: avg(p.floor_at_trig),
        avg_xgb: avg(p.xgb_at_trig),
        floor_above_70: pct(p.floor_at_trig, 0.70),
        xgb_above_70: pct(p.xgb_at_trig, 0.70),
      },
      at_confirm: p.floor_at_conf.length > 0 ? {
        avg_floor: avg(p.floor_at_conf),
        avg_xgb: avg(p.xgb_at_conf),
        floor_above_70: pct(p.floor_at_conf, 0.70),
        xgb_above_70: pct(p.xgb_at_conf, 0.70),
      } : null,
      by_xgb: {
        high: { n: p.xgb_buckets.high.n, precision: prec(p.xgb_buckets.high) },
        med: { n: p.xgb_buckets.med.n, precision: prec(p.xgb_buckets.med) },
        low: { n: p.xgb_buckets.low.n, precision: prec(p.xgb_buckets.low) },
      },
      by_floor: {
        high: { n: p.floor_buckets.high.n, precision: prec(p.floor_buckets.high) },
        med: { n: p.floor_buckets.med.n, precision: prec(p.floor_buckets.med) },
        low: { n: p.floor_buckets.low.n, precision: prec(p.floor_buckets.low) },
      },
    };
  }

  return {
    status: 'ok',
    phase: 'cross_triggered',
    canary_mode: canaryMode,
    canary_threshold: canaryThreshold,
    mc_threshold: mcThreshold,
    total_games: agg.total,
    triggered: agg.triggered,
    patterns: patternSummary,
    at_trigger_overall: {
      avg_floor: agg.trigger_signals.n > 0 ? Math.round(agg.trigger_signals.floor_sum/agg.trigger_signals.n*1000)/1000 : null,
      avg_xgb: agg.trigger_signals.n > 0 ? Math.round(agg.trigger_signals.xgb_sum/agg.trigger_signals.n*1000)/1000 : null,
      floor_above_70: agg.trigger_signals.n > 0 ? Math.round(agg.trigger_signals.floor_high/agg.trigger_signals.n*1000)/10 : null,
      xgb_above_70: agg.trigger_signals.n > 0 ? Math.round(agg.trigger_signals.xgb_high/agg.trigger_signals.n*1000)/10 : null,
    },
    at_confirm_overall: {
      avg_floor: agg.confirm_signals.n > 0 ? Math.round(agg.confirm_signals.floor_sum/agg.confirm_signals.n*1000)/1000 : null,
      avg_xgb: agg.confirm_signals.n > 0 ? Math.round(agg.confirm_signals.xgb_sum/agg.confirm_signals.n*1000)/1000 : null,
      floor_above_70: agg.confirm_signals.n > 0 ? Math.round(agg.confirm_signals.floor_high/agg.confirm_signals.n*1000)/10 : null,
      xgb_above_70: agg.confirm_signals.n > 0 ? Math.round(agg.confirm_signals.xgb_high/agg.confirm_signals.n*1000)/10 : null,
    },
    compound_precision: {
      confirmed_all: { n: agg.compounds.conf_all.n, precision: prec(agg.compounds.conf_all) },
      confirmed_floor_high: { n: agg.compounds.conf_floor_high.n, precision: prec(agg.compounds.conf_floor_high), label: 'MC CONFIRMED + floor>0.70' },
      confirmed_floor_high_xgb_high: { n: agg.compounds.conf_floor_high_xgb_high.n, precision: prec(agg.compounds.conf_floor_high_xgb_high), label: 'MC CONFIRMED + floor>0.70 + xgb>0.70' },
      confirmed_xgb_low: { n: agg.compounds.conf_xgb_low.n, precision: prec(agg.compounds.conf_xgb_low), label: 'MC CONFIRMED + xgb<0.50 (signals agree)' },
      confirmed_xgb_high: { n: agg.compounds.conf_xgb_high.n, precision: prec(agg.compounds.conf_xgb_high), label: 'MC CONFIRMED + xgb>0.70 (MC vs XGB)' },
    },
    nextStep: offset + batchSize < Number(totalGames[0]?.n || 0)
      ? '?phase=cross_triggered&n=' + batchSize + '&offset=' + (offset + batchSize)
      : 'COMPLETE',
  };
}


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
      case 'triggered_replay':   result = await phaseTriggeredReplay(sql, url); break;
      case 'silent_audit':       result = await phaseSilentAudit(sql, url); break;
      case 'halftime_mc':        result = await phaseHalftimeMC(sql, url); break;
      case 'xgb_backfill':       result = await phaseXGBBackfill(sql, url); break;
      case 'cross_concordance':  result = await phaseCrossConcordance(sql); break;
      case 'cross_failure':      result = await phaseCrossFailure(sql, url); break;
      case 'cross_marginal':     result = await phaseCrossMarginal(sql); break;
      case 'cross_compounds':    result = await phaseCrossCompounds(sql); break;
      case 'cross_temporal':     result = await phaseCrossTemporal(sql); break;
      case 'cross_replay':       result = await phaseCrossReplay(sql); break;
      case 'cross_triggered':    result = await phaseCrossTriggered(sql, url); break;
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

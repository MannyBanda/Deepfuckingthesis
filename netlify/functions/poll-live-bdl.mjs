// ══════════════════════════════════════════════════════════════════════════════
// poll-live.mjs — Server-Side Live Game Polling (Netlify Scheduled Function v2)
//
// Runs every 2 minutes via cron. For each live NBA game:
//   1. Fetch SR game summary
//   2. Compute I1–I5 indicators (server-side, no browser globals)
//   3. Fetch ESPN Win Probability
//   4. Save snapshot to Neon Postgres
//
// This guarantees continuous data capture even when the client device is asleep.
// ══════════════════════════════════════════════════════════════════════════════

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ── PHASE 1 KILL-SWITCH ─────────────────────────────────────────────────────
// WNBA legacy-alert teardown (sweet-spot engine migration). Ships DARK: default
// OFF (legacy alerts ON). Set env WNBA_LEGACY_ALERTS_OFF=1 in Netlify to activate.
// Every consumer gates on (WNBA_LEGACY_ALERTS_OFF && league === 'wnba') so NBA /
// NCAAMB are byte-identical at runtime. Reversible via env flip (no redeploy).
const WNBA_LEGACY_ALERTS_OFF = process.env.WNBA_LEGACY_ALERTS_OFF === '1';
// Phase 2a sweet-spot gate compute — runs ON-for-WNBA by default (decision (a));
// env WNBA_SS_COMPUTE_OFF=1 kills it. Compute + store only (no alert) until 2b.
const WNBA_SS_COMPUTE_OFF = process.env.WNBA_SS_COMPUTE_OFF === '1';

// SWEET-SPOT 2b: mechanical A alert. Ships DARK (default off). Set env WNBA_SS_ALERT_ON=1 in
// Netlify to go live, after the forced-path verification passes. A/B mechanical; only C Opus-suppressable.
const WNBA_SS_ALERT_ON = process.env.WNBA_SS_ALERT_ON === '1';
// SWEETSPOT_TIER_BC_SPEC.md: B tier (one-soft + B3 mid-heat), ledger subtypes (rows only,
// no push), WATCHLIST (review cue). All default OFF — ship dark, enable per rollout §5.
const WNBA_SS_B_ON = process.env.WNBA_SS_B_ON === '1';
const WNBA_SS_LEDGER_ON = process.env.WNBA_SS_LEDGER_ON === '1';
const WNBA_SS_WATCHLIST_ON = process.env.WNBA_SS_WATCHLIST_ON === '1';
// Tap-to-open target for Sweet Spot pushes (ntfy Click header). Dashboard root for now;
// per-game deep-link is a queued client follow-up (wnba-bdl.html has no URL-param handling yet).
const SS_DASH_URL = 'https://poetic-starlight-aa8938.netlify.app/wnba-bdl.html';

// ── XGBOOST MODEL ──────────────────────────────────────────────────────────
// Raw stats structural model — 300 trees, 13 features (no progress), trained on 1,235 games.
// Provides independent win probability from raw box score stats without using
// margin, indicators, or floor score. Used as advisory signal + gate layer.
var XGB_MODELS = {};
try {
  const __xgbDir = dirname(fileURLToPath(import.meta.url));
  XGB_MODELS.nba = JSON.parse(readFileSync(join(__xgbDir, 'xgb-model.json'), 'utf8'));
} catch (e) { /* non-fatal — NBA XGB model not found */ }
try {
  const __xgbDir = dirname(fileURLToPath(import.meta.url));
  XGB_MODELS.wnba = JSON.parse(readFileSync(join(__xgbDir, 'xgb-model-wnba.json'), 'utf8'));
} catch (e) { /* non-fatal — WNBA XGB model not found */ }
var XGB_MODEL = XGB_MODELS.nba || null; // backward compat

// MC: Clutch profiles and team 3PT baselines (loaded at first poll)
var _clutchMap = null;
var _team3ptBaselines = null;
var _teamSeasonRates = null;  // { alias: { toRate, fg3aShare, fg3Pct, fg2Pct, orebRate, ftaRate, ftPct } }

// XGB feature order (must match training — no progress):
// [0] ctrl_paint_diff, [1] ctrl_pot_diff, [2] ctrl_to_diff,
// [3] ctrl_stl_diff, [4] ctrl_oreb_diff, [5] ctrl_ast_diff, [6] ctrl_blk_diff,
// [7] ctrl_fta_diff, [8] ctrl_efg_diff, [9] ctrl_biglead_diff,
// [10] ctrl_3pr_diff, [11] ctrl_rim_pct_diff, [12] ctrl_run_share
function predictXGB(features, league) {
  var model = (league && XGB_MODELS[league]) || XGB_MODEL;
  if (!model) return null;
  let sum = 0;
  for (const tree of model.trees) {
    let node = 0;
    while (tree.l[node] !== -1) {
      const fval = features[tree.s[node]] ?? 0;
      node = fval < tree.c[node] ? tree.l[node] : tree.r[node];
    }
    sum += tree.w[node];
  }
  const baseLogit = Math.log(model.base_score / (1 - model.base_score));
  return 1 / (1 + Math.exp(-(baseLogit + sum)));
}

var XGB_FEATURE_LABELS = ['paint','pot','to','stl','oreb','ast','blk','fta','efg','biglead','3pr','rim_pct','runs'];
var XGB_FEATURE_LABELS_WNBA = ['windowed_biglead','disruption','ast','oreb','to_ratio','ftm','ast_ratio','pf','blk','fta','efg','pot','biglead_erosion'];
var XGB_VOLATILE_FEATURES = new Set(['pot', 'to', 'stl', 'oreb', 'runs']);
var XGB_STRUCTURAL_FEATURES = new Set(['paint', 'ast', 'blk', 'fta', 'efg', 'biglead', '3pr', 'rim_pct']);
var XGB_VOLATILE_FEATURES_WNBA = new Set(['pot', 'oreb', 'to_ratio']);
var XGB_STRUCTURAL_FEATURES_WNBA = new Set(['biglead', 'disruption', 'ast', 'ftm', 'ast_ratio', 'pf', 'blk', 'fta', 'efg', 'biglead_erosion']);

// Tree interpreter SHAP — decomposes XGB prediction into per-feature contributions
// Uses precomputed expected values (ev) at each tree node. O(trees × depth) per call.
function computeXGBContributions(features, league) {
  var model = (league && XGB_MODELS[league]) || XGB_MODEL;
  var labels = league === 'wnba' ? XGB_FEATURE_LABELS_WNBA : XGB_FEATURE_LABELS;
  var featureCount = model?.feature_count || 13;
  if (!features || !model?.trees?.[0]?.ev) return null;
  var contribs = new Float64Array(featureCount);
  for (var ti = 0; ti < model.trees.length; ti++) {
    var tree = model.trees[ti];
    var node = 0;
    while (tree.l[node] !== -1) {
      var feat = tree.s[node];
      var child = (features[feat] ?? 0) < tree.c[node] ? tree.l[node] : tree.r[node];
      contribs[feat] += tree.ev[child] - tree.ev[node];
      node = child;
    }
  }
  var ranked = [];
  for (var i = 0; i < featureCount; i++) {
    ranked.push({ f: labels[i] || ('f'+i), v: Math.round(contribs[i] * 1000) / 1000 });
  }
  ranked.sort(function(a, b) { return Math.abs(b.v) - Math.abs(a.v); });
  return ranked;
}

function extractXGBFeatures(summary, ind, pbpResult, currentPeriod, clock, windowAgg, league, windowedBiglead) {
  if (!summary?.home?.statistics || !summary?.away?.statistics) return null;
  if (league === 'wnba') return extractXGBFeaturesWNBA(summary, ind, windowAgg, windowedBiglead);
  const hs = summary.home.statistics, as = summary.away.statistics;
  const ctrlIsHome = ind.controlTeam === ind.homeAlias;
  const flip = ctrlIsHome ? 1 : -1;

  // Determine stat source: windowed (2Q cross-fade) or cumulative fallback
  // windowAgg = { home: {...}, away: {...} } from computeServerWindow().rawAgg
  var useWindow = false;
  var hS = hs, aS = as; // default to cumulative
  if (windowAgg && windowAgg.home && windowAgg.away) {
    var wHomeFGA = Number(windowAgg.home.field_goals_att || 0) || 0;
    var wAwayFGA = Number(windowAgg.away.field_goals_att || 0) || 0;
    if (wHomeFGA >= 5 && wAwayFGA >= 5) {
      useWindow = true;
      hS = windowAgg.home;
      aS = windowAgg.away;
    }
  }

  // Shooting efficiency (from window or cumulative)
  const hFGA = Number(hS.field_goals_att || hS.fga || 0) || 0;
  const aFGA = Number(aS.field_goals_att || aS.fga || 0) || 0;
  const hFGM = Number(hS.field_goals_made || hS.fgm || 0) || 0;
  const aFGM = Number(aS.field_goals_made || aS.fgm || 0) || 0;
  const hFG3M = Number(hS.three_points_made || hS.fg3m || 0) || 0;
  const aFG3M = Number(aS.three_points_made || aS.fg3m || 0) || 0;
  const hFG3A = Number(hS.three_points_att || hS.fg3a || 0) || 0;
  const aFG3A = Number(aS.three_points_att || aS.fg3a || 0) || 0;
  const hEFG = hFGA > 0 ? (hFGM + 0.5 * hFG3M) / hFGA : 0;
  const aEFG = aFGA > 0 ? (aFGM + 0.5 * aFG3M) / aFGA : 0;

  // Rim efficiency (from window or cumulative)
  const hRimM = Number(hS.field_goals_at_rim_made || 0) || 0;
  const hRimA = Number(hS.field_goals_at_rim_att || 0) || 0;
  const aRimM = Number(aS.field_goals_at_rim_made || 0) || 0;
  const aRimA = Number(aS.field_goals_at_rim_att || 0) || 0;
  const rimDiff = ((hRimM / Math.max(hRimA, 1)) - (aRimM / Math.max(aRimA, 1))) * flip;

  // Run share (PBP — always cumulative, 0.5 if unavailable)
  let runShare = 0.5;
  if (pbpResult?.runs6) {
    const hRuns = pbpResult.runs6.filter(r => r.team === ind.homeAlias).length;
    const aRuns = pbpResult.runs6.filter(r => r.team === ind.awayAlias).length;
    const totalRuns = hRuns + aRuns;
    if (totalRuns > 0) runShare = (ctrlIsHome ? hRuns : aRuns) / totalRuns;
  }

  return [
    (Number(hS.points_in_the_paint || hS.points_in_paint || 0) - Number(aS.points_in_the_paint || aS.points_in_paint || 0)) * flip,
    (Number(hS.points_off_turnovers || 0) - Number(aS.points_off_turnovers || 0)) * flip,
    (Number(hS.turnovers || 0) - Number(aS.turnovers || 0)) * flip,
    (Number(hS.steals || 0) - Number(aS.steals || 0)) * flip,
    (Number(hS.offensive_rebounds || 0) - Number(aS.offensive_rebounds || 0)) * flip,
    (Number(hS.assists || 0) - Number(aS.assists || 0)) * flip,
    (Number(hS.blocks || 0) - Number(aS.blocks || 0)) * flip,
    (Number(hS.free_throws_att || 0) - Number(aS.free_throws_att || 0)) * flip,
    (hEFG - aEFG) * flip,
    (Number(hs.biggest_lead || 0) - Number(as.biggest_lead || 0)) * flip,  // ALWAYS cumulative
    (hFGA > 0 && aFGA > 0 ? (hFG3A / hFGA - aFG3A / aFGA) : 0) * flip,
    rimDiff,
    runShare,  // ALWAYS cumulative (PBP)
  ];
}
// ── WNBA XGB FEATURE EXTRACTION ──────────────────────────────────────────────
// 13 features: 10 windowed (cross-fade) + 2 cumulative game-state + biglead_erosion (windowed_biglead - margin).
// Pure windowed architecture matching NBA — biglead added as scoreboard confirmation signal.
// Feature order must match xgb-model-wnba.json training (windowed biglead + erosion, OOF AUC 0.807).
function extractXGBFeaturesWNBA(summary, ind, windowAgg, windowedBiglead) {
  var hs = summary.home.statistics, as = summary.away.statistics;
  var ctrlIsHome = ind.controlTeam === ind.homeAlias;
  var flip = ctrlIsHome ? 1 : -1;

  // Determine stat source: windowed (2Q cross-fade) or cumulative fallback
  var useWindow = false;
  var hS = hs, aS = as;
  if (windowAgg && windowAgg.home && windowAgg.away) {
    var wHFGA = Number(windowAgg.home.field_goals_att || windowAgg.home.fga || 0) || 0;
    var wAFGA = Number(windowAgg.away.field_goals_att || windowAgg.away.fga || 0) || 0;
    if (wHFGA >= 5 && wAFGA >= 5) { useWindow = true; hS = windowAgg.home; aS = windowAgg.away; }
  }

  var hFGA = Number(hS.field_goals_att || hS.fga || 0) || 1;
  var aFGA = Number(aS.field_goals_att || aS.fga || 0) || 1;
  var hFGM = Number(hS.field_goals_made || hS.fgm || 0);
  var aFGM = Number(aS.field_goals_made || aS.fgm || 0);
  var hFG3M = Number(hS.three_points_made || hS.fg3m || 0);
  var aFG3M = Number(aS.three_points_made || aS.fg3m || 0);
  var hStl = Number(hS.steals || hS.stl || 0), aStl = Number(aS.steals || aS.stl || 0);
  var hBlk = Number(hS.blocks || hS.blk || 0), aBlk = Number(aS.blocks || aS.blk || 0);
  var hAst = Number(hS.assists || hS.ast || 0), aAst = Number(aS.assists || aS.ast || 0);
  var hTov = Number(hS.turnovers || hS.tov || hS.total_turnovers || 0);
  var aTov = Number(aS.turnovers || aS.tov || aS.total_turnovers || 0);

  // Windowed biglead: use pre-computed cross-fade max margin if available, else cumulative fallback
  var bigleadVal = windowedBiglead != null ? windowedBiglead
    : (Number(hs.biggest_lead || 0) - Number(as.biggest_lead || 0)) * flip;

  return [
    bigleadVal,                                                                                     // [0] windowed_biglead (cross-fade max margin)
    ((hStl + hBlk) - (aStl + aBlk)) * flip,                                                        // [1] disruption
    (hAst - aAst) * flip,                                                                           // [2] ast
    (Number(hS.offensive_rebounds || hS.oreb || 0) - Number(aS.offensive_rebounds || aS.oreb || 0)) * flip,  // [3] oreb
    ((hTov > 0 ? hStl / hTov : 0) - (aTov > 0 ? aStl / aTov : 0)) * flip,                        // [4] to_ratio
    (Number(hS.free_throws_made || hS.ftm || 0) - Number(aS.free_throws_made || aS.ftm || 0)) * flip,  // [5] ftm
    ((hFGM > 0 ? hAst / hFGM : 0) - (aFGM > 0 ? aAst / aFGM : 0)) * flip,                       // [6] ast_ratio
    (Number(hS.personal_fouls || hS.fouls || hS.pf || 0) - Number(aS.personal_fouls || aS.fouls || aS.pf || 0)) * flip,  // [7] pf
    (hBlk - aBlk) * flip,                                                                          // [8] blk
    (Number(hS.free_throws_att || hS.fta || 0) - Number(aS.free_throws_att || aS.fta || 0)) * flip,  // [9] fta
    (((hFGM + 0.5 * hFG3M) / hFGA) - ((aFGM + 0.5 * aFG3M) / aFGA)) * flip,                     // [10] efg
    (Number(hS.points_off_turnovers || hS.pot || 0) - Number(aS.points_off_turnovers || aS.pot || 0)) * flip,  // [11] pot
    bigleadVal - (Number(summary.home?.points || 0) - Number(summary.away?.points || 0)) * flip,              // [12] biglead_erosion (windowed_biglead - ctrl_margin)
  ];
}

// Separates volatile (hustle/event-driven) vs structural (scheme/repeatable) SHAP contributions
function computeConvictionQuality(shapArray, league) {
  if (!shapArray || shapArray.length === 0) return null;
  var volSet = league === 'wnba' ? XGB_VOLATILE_FEATURES_WNBA : XGB_VOLATILE_FEATURES;
  var posFeatures = shapArray.filter(function(s) { return s.v > 0; });
  var totalPos = posFeatures.reduce(function(sum, s) { return sum + s.v; }, 0) || 0.001;

  var volPos = 0, strPos = 0, bigleadVal = 0;
  for (var i = 0; i < shapArray.length; i++) {
    var s = shapArray[i];
    if (s.f === 'biglead' || (league === 'wnba' && s.f === 'windowed_biglead')) bigleadVal = s.v;
    if (s.v > 0) {
      if (volSet.has(s.f)) volPos += s.v;
      else strPos += s.v;
    }
  }

  var top1 = posFeatures.length > 0
    ? posFeatures.reduce(function(a, b) { return a.v >= b.v ? a : b; })
    : { f: 'none', v: 0 };
  var volConc = volPos / totalPos;
  var bigleadShare = Math.max(bigleadVal, 0) / totalPos;

  return {
    volConcentration: Math.round(volConc * 1000) / 1000,
    strConcentration: Math.round(strPos / totalPos * 1000) / 1000,
    top1Feature: top1.f,
    top1IsVolatile: volSet.has(top1.f),
    top1Share: Math.round((top1.v / totalPos) * 1000) / 1000,
    basis: volConc >= 0.50 ? 'VOLATILE' : volConc < 0.30 ? 'STRUCTURAL' : 'MIXED',
    bigleadShare: Math.round(bigleadShare * 1000) / 1000,
    bigleadAnchored: bigleadShare > 0.25,
    noScoreboardConfirmation: bigleadVal <= 0,
  };
}

// Trajectory signals — detects conviction quality CHANGES between checkpoints
// Uses SHAP deltas to catch efficiency collapse, structural inversion, volatile persistence
function computeTrajectorySignals(currentShap, cpArray, convictionQuality, xgbProb, league) {
  if (!currentShap || currentShap.length === 0) return null;

  // Build lookup for current SHAP by feature name
  var currMap = {};
  for (var i = 0; i < currentShap.length; i++) currMap[currentShap[i].f] = currentShap[i].v;

  // Find most recent checkpoint with SHAP data
  var prevShapMap = null;
  for (var j = cpArray.length - 1; j >= 0; j--) {
    if (cpArray[j].shap && cpArray[j].shap.length > 0) {
      prevShapMap = {};
      for (var k = 0; k < cpArray[j].shap.length; k++) prevShapMap[cpArray[j].shap[k].f] = cpArray[j].shap[k].v;
      break;
    }
  }

  var efgDelta = null, divergence = null;
  if (prevShapMap) {
    efgDelta = (currMap['efg'] || 0) - (prevShapMap['efg'] || 0);
    efgDelta = Math.round(efgDelta * 1000) / 1000;

    var volDelta = 0, strDelta = 0;
    for (var fi = 0; fi < XGB_FEATURE_LABELS.length; fi++) {
      var f = XGB_FEATURE_LABELS[fi];
      var delta = (currMap[f] || 0) - (prevShapMap[f] || 0);
      if (XGB_VOLATILE_FEATURES.has(f)) volDelta += delta;
      else strDelta += delta;
    }
    divergence = Math.round((volDelta - strDelta) * 1000) / 1000;
  }

  // Count consecutive checkpoints where volatile features dominate (including current)
  var consecutiveVolDominant = 0;
  if (convictionQuality && convictionQuality.volConcentration >= 0.50) {
    consecutiveVolDominant = 1;
    for (var ci = cpArray.length - 1; ci >= 0; ci--) {
      var cpConv = cpArray[ci].shap ? computeConvictionQuality(cpArray[ci].shap, league) : null;
      if (cpConv && cpConv.volConcentration >= 0.50) {
        consecutiveVolDominant++;
      } else {
        break;
      }
    }
  }

  // Evaluate warnings (ordered by discriminating power from backtest)
  var warnings = [];

  // 1. Biglead / scoreboard translation (strongest discriminator — 0.24x lift)
  if (convictionQuality && convictionQuality.noScoreboardConfirmation && xgbProb >= 0.70) {
    warnings.push('NO_SCOREBOARD_TRANSLATION: XGB reads '
      + Math.round(xgbProb * 100) + '% but biglead SHAP is flat/negative'
      + ' — statistical dominance is not translating to scoreboard control.'
      + ' In backtest, XGB >=70% without biglead confirmation has 19% loss rate vs 5% with it.');
  }

  // 2. Efficiency collapse (1.33x lift)
  if (efgDelta != null && efgDelta <= -0.30) {
    warnings.push('EFFICIENCY_COLLAPSE: Shooting efficiency SHAP dropped '
      + Math.abs(efgDelta).toFixed(2)
      + ' this checkpoint — opponent gaining structural shooting edge');
  }

  // 3. Volatile foundation (1.28x lift as combo)
  if (convictionQuality && convictionQuality.volConcentration >= 0.50 && convictionQuality.top1IsVolatile) {
    warnings.push('VOLATILE_FOUNDATION: '
      + Math.round(convictionQuality.volConcentration * 100)
      + '% of XGB conviction from volatile stats ('
      + convictionQuality.top1Feature + ' dominant at '
      + Math.round(convictionQuality.top1Share * 100) + '% share)'
      + ' — edge built on turnovers/hustle, may not sustain');
  }

  // 4. Structural inversion (1.08x lift)
  if (divergence != null && divergence >= 0.40) {
    warnings.push('STRUCTURAL_INVERSION: Volatile metrics growing while'
      + ' efficiency metrics declining, divergence='
      + divergence.toFixed(2)
      + ' — structural foundation shifting to opponent');
  }

  return { efgDelta: efgDelta, divergence: divergence, consecutiveVolDominant: consecutiveVolDominant, warnings: warnings };
}

const LEAGUES = {
  nba: {
    srBase: 'https://api.sportradar.com/nba/trial/v8/en/',
    srKeyEnv: 'SR_API_KEY',
    espnSlug: 'nba',
    espnBase: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/',
    espnSummaryBase: 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary',
    bdlPrefix: '/nba',
    bdlHasSeasonStats: true,
    bdlHasBoxScores: true,
    season: '2025',
    aliasMap: {},  // SR + BDL use identical NBA abbreviations — no mapping needed
    quarterMinutes: 12,
    gameMinutes: 48,
    periodCount: 4,
    twoPointBaseline: 0.52,
    weights: { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 },
    mcDefaults: { toRate: 0.13, fg3aShare: 0.35, fg3Pct: 0.36, fg2Pct: 0.52, orebRate: 0.25, ftaRate: 0.22, ftPct: 0.76 },
    xgbModelFile: 'xgb-model.json',
    xgbFeatureCount: 13,
  },
  ncaamb: {
    srBase: 'https://api.sportradar.com/ncaamb/trial/v8/en/',
    srKeyEnv: 'SR_NCAAMB_KEY',
    espnSlug: 'mens-college-basketball',
    espnBase: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/',
    espnSummaryBase: 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary',
    bdlPrefix: '/ncaab',
    bdlHasSeasonStats: true,
    bdlHasBoxScores: false,
    season: '2025',
    aliasMap: {},
    quarterMinutes: 20,
    gameMinutes: 40,
    periodCount: 2,
    twoPointBaseline: 0.49,
    weights: { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 },
    mcDefaults: null,
    xgbModelFile: null,
  },
  wnba: {
    srBase: 'https://api.sportradar.com/wnba/trial/v8/en/',
    srKeyEnv: 'SR_WNBA_KEY',
    espnSlug: 'wnba',
    espnBase: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/',
    espnSummaryBase: 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/wnba/summary',
    bdlPrefix: '/wnba',
    bdlHasSeasonStats: true,
    bdlHasBoxScores: false,
    season: '2026',  // WNBA is calendar-year league (not split-year like NBA)
    aliasMap: { NYL:'NY', LVA:'LV', LAS:'LA', GSV:'GS', WAS:'WSH', PDX:'POR', TOY:'TOR' },
    quarterMinutes: 10,
    gameMinutes: 40,
    periodCount: 4,
    twoPointBaseline: 0.46,
    weights: { I1: 0.15, I2: 0.20, I3: 0.30, I4: 0.25, I5: 0.10 },
    mcDefaults: { toRate: 0.178, fg3aShare: 0.345, fg3Pct: 0.347, fg2Pct: 0.482, orebRate: 0.348, ftaRate: 0.224, ftPct: 0.788 },
    xgbModelFile: 'xgb-model-wnba.json',
    xgbFeatureCount: 13,
  },
};

const BDL_BASE = 'https://api.balldontlie.io';

// BDL team IDs (NBA only — tracking data is NBA-specific)
const BDL_TEAMS = {
  ATL:1, BOS:2, BKN:3, CHA:4, CHI:5, CLE:6, DAL:7, DEN:8, DET:9, GSW:10,
  HOU:11, IND:12, LAC:13, LAL:14, MEM:15, MIA:16, MIL:17, MIN:18, NOP:19, NYK:20,
  OKC:21, ORL:22, PHI:23, PHX:24, POR:25, SAC:26, SAS:27, TOR:28, UTA:29, WAS:30
};

// The Odds API full team names → our aliases (for server-side batch odds fetch)
const ODDS_API_TEAMS = {
  'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
  'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
  'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
  'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
  'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM',
  'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
  'New Orleans Pelicans': 'NOP', 'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC',
  'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
  'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS',
  'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
};

const ODDS_API_TEAMS_WNBA = {
  'Atlanta Dream': 'ATL', 'Chicago Sky': 'CHI', 'Connecticut Sun': 'CON',
  'Dallas Wings': 'DAL', 'Golden State Valkyries': 'GSV', 'Indiana Fever': 'IND',
  'Las Vegas Aces': 'LVA', 'Los Angeles Sparks': 'LAS', 'Minnesota Lynx': 'MIN',
  'New York Liberty': 'NYL', 'Phoenix Mercury': 'PHX', 'Portland Fire': 'PDX',
  'Seattle Storm': 'SEA', 'Toronto Tempo': 'TOY', 'Washington Mystics': 'WAS',
};

const W = { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };

const SR_DELAY_MS = 1400; // respect trial tier rate limit

// ── SONNET SYSTEM PROMPT (same as analyze.js) ────────────────────────────────
function getSonnetSystemPrompt(league) {
if (league === 'wnba') {
return 'You are a WNBA structural analyst. You receive pre-computed mechanical indicators as GROUND TRUTH — do not recompute them. Your job: synthesize a predictive read, compute FWP, identify risks, and write a plain-English narrative.\n\n'
+ 'GROUND TRUTH (provided by the mechanical engine — do NOT override):\n'
+ '  - I1-I5 indicator scores with team labels and who wins each\n'
+ '  - Composite floor score and control team\n'
+ '  - Mechanical conviction tier: DOMINANT / STRONG / MODEST / CONDITIONAL / NO ENTRY\n'
+ '    Based on which indicator COMBINATIONS the control team wins (203-game validated):\n'
+ '    DOMINANT = I3+I4 pair AND 3+ indicators, OR 4+ indicators. I3+I4 = 99.1%.\n'
+ '    STRONG = I3+I4 (99.1%), I3+I2, or I4+I2 killer pairs.\n'
+ '    MODEST = 2+ indicators without killer pairs. 70-80% win rate.\n'
+ '    CONDITIONAL = 1 indicator only. Needs strong contextual justification.\n'
+ '    NO ENTRY = 0 indicators\n'
+ '    KEY WNBA DIFFERENCE: I4+I5 is NOT a killer pair (I5 AUC = 0.500, no signal). I3 (Shot Quality, 30% weight) is the anchor.\n'
+ '  - Sustainability tiers (with player-level shooter breakdown)\n'
+ '  - TP (Throughput) and LS (Lead Safety) classifications\n'
+ '  - Per-quarter stats flow showing trends\n\n'
+ 'YOUR ANALYTICAL JOBS:\n'
+ '1. FWP (Framework Win Probability) — game-state-aware win probability.\n'
+ '   Factor in: score margin, quarter, time remaining, structural control, closing dynamics, team identity.\n'
+ '   FWP reflects who you predict WINS — not who currently leads. WNBA is 40-minute games with 10-minute quarters — structural advantages have less time to compound than NBA.\n'
+ '   Output BOTH teams with alias labels. Must sum to ~100%.\n\n'
+ '2. NARRATIVE — plain English structural read for non-technical subscribers.\n'
+ '   Lead with the action: what should the reader do or watch for?\n'
+ '   Name specific stats that drive the read.\n'
+ '   2-3 sentences max.\n\n'
+ '3. RISK FLAGS — what could go wrong. 1-2 sentences.\n\n'
+ '4. CLOSING PROJECTION — how does this game resolve? 1 sentence.\n\n'
+ '5. DISAGREEMENT — if your contextual read conflicts with mechanical conviction, flag it with reasoning. Say "NONE" if you agree.\n\n'
+ 'XGB MODEL CONTEXT (WNBA-specific, 12 features, backtest OOF AUC ~0.807; NOTE production AUC runs lower ~0.67 — treat as [PRIOR]):\n'
+ '  Features: biglead, disruption (stl+blk), ast, oreb, to_ratio, ftm, ast_ratio, pf, blk, fta, efg, pot.\n'
+ '  Windowed biglead (#1 feature, 31% SHAP importance) = per-quarter max margin, cross-fade weighted. Scoreboard confirmation applies.\n'
+ '  Pure windowed architecture (cross-fade) for ALL features including biglead. No cumulative features.\n'
+ '  Top SHAP drivers: biglead, disruption (combined steals+blocks), assists, offensive rebounds.\n'
+ '  When XGB data is provided, use SHAP drivers to calibrate your FWP:\n'
+ '  - biglead SHAP anchored (>25% share) = scoreboard confirms structural edge (high confidence).\n'
+ '  - biglead SHAP flat/negative = stats not translating to lead — elevate scrutiny.\n'
+ '  - VOLATILE basis (pot/oreb/to_ratio dominant) = circumstantial edge, may not sustain.\n'
+ '  - STRUCTURAL basis (biglead/disruption/ast/efg/ftm dominant) = scheme-driven, more durable.\n'
+ '  - Near-zero for most features = structural edge is thin regardless of MC/floor.\n\n'
+ 'SIGNAL TRUST HIERARCHY [tags: [PRIOR]=well-powered backtest/checkpoint-granularity, reason from it but do NOT quote as the subscriber\'s win prob; [STRUCT]=direction reliable, magnitude not]:\n'
+ '  Three signals with fundamentally different roles from NBA. NOTE: backtest AUCs run materially higher than production (XGB backtest ~0.81 vs production ~0.67) — treat all model AUCs as [PRIOR].\n'
+ '  - MC Cum: strongest single late-game signal in Q4. [PRIOR]\n'
+ '  - XGB: reads STRUCTURE, not wins — windowed box-score quality. A high XGB while trailing is a positive structural read, not a promise. [PRIOR/STRUCT]\n'
+ '  - Floor: narrative context ONLY in WNBA. When floor disagrees with MC+XGB, floor is the one that is wrong. [STRUCT]\n\n'
+ '  When they DISAGREE [STRUCT] (direction, not magnitude):\n'
+ '  Q2: XGB ~ MC > Floor. Use either as early warning.\n'
+ '  Q3: XGB >= MC > Floor. Trust windowed structure.\n'
+ '  Q4: MC >= XGB > Floor. MC wins late disagreements; MC UNDERESTIMATES in WNBA Q4. [PRIOR] MC 0.7-0.8 runs ~89% actual, MC 0.8-0.9 ~93% — reason from this, do not quote it.\n\n'
+ '  ALIGNED (MC+XGB both high): highest conviction when they agree. [PRIOR] (precise accuracy pending n-verification — do not quote a number).\n'
+ '  CRITICAL: Floor is NEVER a decision gate in WNBA.\n'
+ '  Floor HIGH + MC LOW + XGB LOW = both models disagree with floor -> genuine structural erosion. [STRUCT]\n'
+ '  Floor HIGH + MC LOW + XGB HIGH = the BUY setup: a structurally dominant team TRAILING (low MC is expected from a deficit environment, not structural decay). This is NOT a failure profile and NOT automatically a suppress. Sparse region — decide on the full structural picture, not on MC magnitude. [STRUCT]\n'
+ '  MC+XGB HIGH + Floor LOW = compound is correct regardless of floor. [PRIOR]\n'
+ '  TRAILING TEAM MC Cum: MC simulates forward using observed possession rates shaped by game state. Trailing teams produce different rate profiles (pressing, risk-taking, opponent protecting). Do NOT treat low MC as structural evidence against a trailing team when XGB confirms. [STRUCT]\n'
+ '  When MC investigation active (CLEAN/WAVE): MC PBP > everything.\n\n'
+ 'SUSTAINABILITY RULES:\n'
+ '  - LOCKED IN/DURABLE = shooting at or below baseline. Sustainable.\n'
+ '  - STALLED = 3PT below 95% of season baseline AND 2PT% below 85% of WNBA baseline (46%). Genuine collapse.\n'
+ '  - FRAGILE/UNSUSTAINABLE = shooting above baseline, driven by non-shooters.\n\n'
+ 'BONUS STATUS RULE:\n'
+ '  "TeamX IN BONUS" = TeamX BENEFITS (free throws on every foul). Pure upside for TeamX.\n\n'
+ 'OUTPUT FORMAT (follow exactly — each field on its own line):\n\n'
+ 'FWP: [AwayAlias] XX% / [HomeAlias] YY%\n'
+ 'EDGE: [+X% | No market data]\n'
+ 'RISK: [1-2 sentences identifying what could undermine the structural read, or NONE]\n'
+ 'CLOSING: [1-sentence projection of how the game resolves]\n'
+ 'NARRATIVE: [2-3 sentence plain English read for subscribers]\n'
+ 'Sustainability: [TeamA]: [tier] | [TeamB]: [tier]\n'
+ 'Lead Source: [STRUCTURAL | VARIANCE | MIXED | EVEN] — [1-line]\n'
+ 'DISAGREEMENT: [NONE | 1-2 sentences]\n\n'
+ 'Be concise. Decisive when the indicators are clear. Your value is context and projection, not recomputing what the engine already knows.';
}
return 'You are an NBA structural analyst. You receive pre-computed mechanical indicators as GROUND TRUTH — do not recompute them. Your job: synthesize a predictive read, compute FWP, identify risks, and write a plain-English narrative.\n\n'
+ 'GROUND TRUTH (provided by the mechanical engine — do NOT override):\n'
+ '  - I1-I5 indicator scores with team labels and who wins each\n'
+ '  - Composite floor score and control team\n'
+ '  - Mechanical conviction tier: DOMINANT / STRONG / MODEST / CONDITIONAL / NO ENTRY\n'
+ '    Based on which indicator COMBINATIONS the control team wins (171-game validated):\n'
+ '    DOMINANT = I4+I5 pair (100% win rate) OR 4+ indicators\n'
+ '    STRONG = I3+I4 (99%) or I3+I5 (96%) pair without I4+I5\n'
+ '    MODEST = 2+ indicators but missing killer pairs (I4+I5, I3+I4, I3+I5). 70-80% win rate.\n'
+ '    CONDITIONAL = 1 indicator only. 40-70%. Needs strong contextual justification.\n'
+ '    NO ENTRY = 0 indicators\n'
+ '  - Sustainability tiers (with player-level shooter breakdown)\n'
+ '  - TP (Throughput) and LS (Lead Safety) classifications\n'
+ '  - Per-quarter stats flow showing trends\n\n'
+ 'YOUR ANALYTICAL JOBS:\n'
+ '1. FWP (Framework Win Probability) — game-state-aware win probability.\n'
+ '   Factor in: score margin, quarter, time remaining, structural control, closing dynamics, team identity.\n'
+ '   FWP reflects who you predict WINS — not who currently leads. A team trailing on variance with DOMINANT conviction can have >50% FWP.\n'
+ '   Output BOTH teams with alias labels. Must sum to ~100%.\n'
+ '   COHERENCE: Higher conviction → FWP should reflect greater certainty for control team (all else equal).\n\n'
+ '2. NARRATIVE — plain English structural read for non-technical subscribers.\n'
+ '   Lead with the action: what should the reader do or watch for?\n'
+ '   Explain the structural edge in simple terms. Translate indicator language.\n'
+ '   Name specific stats that drive the read (e.g., "DEN dominating paint 48-22 and controlling runs 7 to 3").\n'
+ '   2-3 sentences max.\n\n'
+ '3. RISK FLAGS — what could go wrong despite the structural read.\n'
+ '   Look for: foul trouble on key players, quarter-over-quarter trend erosion, sustainability concerns,\n'
+ '   closing lineup questions, momentum shifts the indicators haven\'t fully captured.\n'
+ '   If conviction is DOMINANT and no real risk exists, say "NONE — structural dominance across all dimensions."\n'
+ '   1-2 sentences.\n\n'
+ '4. CLOSING PROJECTION — how does this game resolve from here?\n'
+ '   Given the structural state, margin, and time remaining, what happens?\n'
+ '   Be specific: "DEN closes on a 12-4 run in the final 4 minutes as POR\'s shooting regresses."\n'
+ '   1 sentence.\n\n'
+ '5. DISAGREEMENT — if your contextual read of the reference data conflicts with mechanical conviction,\n'
+ '   flag it here with reasoning. You cannot change the conviction tier, but you can explain why\n'
+ '   you think the situation is better or worse than the tier suggests.\n'
+ '   Examples: "Floor is 0.85 STRONG but biggest lead was built in Q1 and control is eroding every quarter."\n'
+ '   "Conviction is MODEST but this team\'s 4th-foul situation on their rim protector will collapse I2 by Q4."\n'
+ '   Say "NONE" if you agree with mechanical conviction.\n\n'
+ 'REFERENCE DATA (available for your analysis — use as needed, do not recompute indicators from it):\n'
+ '  - Per-quarter stats breakdown with team labels\n'
+ '  - Raw box score stats (paint, steals, assists, 3PT, etc.)\n'
+ '  - PBP run data and scoring patterns\n'
+ '  - Sustainability audit detail (personnel tiers, Bayesian regression, shot type proxy)\n'
+ '  - Lead composition (structural vs variance points)\n'
+ '  - Odds and spread data\n'
+ '  - ESPN Win Probability\n'
+ '  - Team WP Identity Profiles (COMEBACK, FRONTRUNNER, VOLATILE, CLOSER, STEADY)\n'
+ '  - Rolling window (recent ~2-quarter control trend)\n'
+ '  - Gap acceleration (is edge compounding or fading)\n'
+ '  - Directional arrows (per-quarter sub-metric trends)\n'
+ '  - Bonus status\n'
+ '  - XGBoost structural model (independent raw-stats win probability + SHAP feature drivers)\n'
+ '  - XGB conviction quality (volatile vs structural basis, scoreboard confirmation status)\n'
+ '  - Monte Carlo trajectory (possession-level simulation from last 20 possessions projected forward)\n'
+ '  - MC investigation state (if active: pattern, verdicts, trigger context)\n\n'
+ 'XGB CONVICTION QUALITY GUIDELINES:\n'
+ '  When XGB data is provided, use it to calibrate your FWP:\n'
+ '  - Scoreboard CONFIRMED (biglead anchored): XGB is highly reliable. 95% win rate in backtest.\n'
+ '  - Scoreboard NOT CONFIRMED: stats look dominant but no lead. Discount FWP certainty.\n'
+ '  - VOLATILE basis (pot/stl/oreb/to/runs): edge is circumstantial, may not sustain. Flag in RISK.\n'
+ '  - STRUCTURAL basis (paint/ast/efg/blk/fta): edge is scheme-driven, repeatable. Trust it.\n'
+ '  - Conviction warnings (EFFICIENCY_COLLAPSE, VOLATILE_FOUNDATION, etc.): flag in RISK section.\n'
+ '  - XGB DIVERGENT from floor: if XGB < floor, raw stats see less edge than indicators suggest.\n'
+ '    If XGB > floor, raw stats see more edge than indicators. Note the divergence direction.\n\n'
+ 'SIGNAL TRUST HIERARCHY [PRIOR — 14,440 checkpoint backtest, 1,233 games; backtest/checkpoint-granularity, reason from it but do NOT quote as the subscriber\'s win prob; production runs differently]:\n'
+ '  Four signals, each measuring different things:\n'
+ '  - Floor: cumulative game box score -> I1-I5 composite. Stable but anchors stale early-game data. [STRUCT]\n'
+ '  - XGB: 2Q cross-fade windowed stats -> 13-feature structural model. Reads structure, not wins. [PRIOR/STRUCT]\n'
+ '  - MC PBP: last 20 possessions -> simulated forward. Immune to cumulative anchoring. Real-time canary. [STRUCT]\n'
+ '  - MC Cum: full game cumulative rates -> simulated forward. Best single probability signal. [PRIOR]\n\n'
+ '  All four most reliable when they AGREE. [PRIOR] All 3 high in Q4 ~96% accuracy (backtest) — reason from it, do not quote.\n'
+ '  When they DISAGREE [STRUCT] (direction, not magnitude):\n'
+ '  Q2: Floor ~ XGB > MC. MC overconfident early. Use MC as early warning only.\n'
+ '  Q3: MC Cum ~ XGB > Floor. MC calibration tightens. Floor starts anchoring.\n'
+ '  Q4: MC Cum > XGB > Floor. [PRIOR] MC 70-80% converts ~75%, MC>70% ~92% (backtest). Floor least reliable (cumulative anchoring at max).\n'
+ '  TRAILING TEAM MC Cum: MC simulates forward using observed possession rates shaped by game state. Trailing teams produce different rate profiles (pressing, risk-taking, opponent protecting). Low MC for a trailing team may reflect the deficit environment, not structural decay. When XGB confirms structural edge despite low MC, weigh XGB. [STRUCT]\n'
+ '  When MC investigation is active (CLEAN/WAVE): MC PBP > everything, regardless of quarter.\n\n'
+ '  MC INVESTIGATION PATTERNS (when provided):\n'
+ '  CLEAN = sustained collapse, 72.6% precision Q3+. Strongest signal.\n'
+ '  WAVE = oscillating collapse, 60%. Risk flag only.\n'
+ '  NORMALIZED = rates recovered. Hold validated.\n'
+ '  Investigation active = await classification.\n\n'
+ 'DATA QUALITY NOTE — PAINT POINTS:\n'
+ '  SR often delays or zeros out points_in_the_paint in the game summary JSON.\n'
+ '  Use DEPTH AUDIT rim section or LEAD COMPOSITION structural points as the authoritative paint signal.\n\n'
+ 'SUSTAINABILITY RULES:\n'
+ '  - LOCKED IN/DURABLE = shooting is at or below baseline from players who CAN shoot. Sustainable.\n'
+ '  - STALLED = 3PT below 95% of season baseline AND 2PT% below 85% of league baseline — genuine offensive collapse, not a cold stretch. Regression unreliable.\n'
+ '  - FRAGILE/UNSUSTAINABLE = shooting above baseline, driven by non-shooters or unsustainable volume.\n'
+ '  - When referencing sustainability in your narrative, verify which team has which tier.\n'
+ '    Do NOT attribute UNSUSTAINABLE to the wrong team.\n\n'
+ 'BONUS STATUS RULE:\n'
+ '  "TeamX IN BONUS" = TeamX BENEFITS (free throws on every foul). Pure upside for TeamX.\n'
+ '  When one team is in bonus before 4:00 of any quarter: structural I2 multiplier.\n'
+ '  When BOTH in bonus: advantage neutralizes.\n\n'
+ 'OUTPUT FORMAT (follow exactly — each field on its own line):\n\n'
+ 'FWP: [AwayAlias] XX% / [HomeAlias] YY%\n'
+ 'EDGE: [+X% | No market data]\n'
+ 'RISK: [1-2 sentences identifying what could undermine the structural read, or NONE]\n'
+ 'CLOSING: [1-sentence projection of how the game resolves]\n'
+ 'NARRATIVE: [2-3 sentence plain English read for subscribers — lead with action, explain structural edge, name key stats]\n'
+ 'Sustainability: [TeamA]: [tier] | [TeamB]: [tier]\n'
+ 'Lead Source: [STRUCTURAL | VARIANCE | MIXED | EVEN] — [1-line]\n'
+ 'DISAGREEMENT: [NONE | 1-2 sentences explaining where you disagree with mechanical conviction and why]\n\n'
+ 'Be concise. Decisive when the indicators are clear. Your value is context and projection, not recomputing what the engine already knows.';
}
// ── HELPERS ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── NTFY PUSH NOTIFICATIONS ─────────────────────────────────────────────
async function sendNtfy(title, body, priority = 4, clickUrl = null) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    // Node.js fetch requires ASCII-only headers — strip emojis/unicode from Title
    const asciiTitle = title.replace(/\u2014/g, '-').replace(/[^\x00-\x7F]/g, '').replace(/\s+/g, ' ').trim();
    const ntfyHeaders = { 'Title': asciiTitle || 'DFT Alert', 'Priority': String(priority), 'Tags': 'basketball' };
    if (clickUrl) ntfyHeaders['Click'] = clickUrl; // tap notification -> open URL (ntfy Click action)
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: ntfyHeaders,
      body: body,
    });
    log(`NTFY sent: ${title}`);
  } catch (e) {
    log(`NTFY failed: ${e.message}`);
  }
}

// ── SWEET-SPOT 2b: mechanical A alert (two-stage) ─────────────────────────
// Stage 1: atomic dedup INSERT ON CONFLICT (game_id, alert_subtype) DO NOTHING RETURNING id
//   → push the WHAT only if WE inserted the row (handles cron concurrency in one move).
// Stage 2: async Opus narration (the WHY) — non-fatal, NEVER re-decides (A is mechanical).
// ── SWEETSPOT §4c: PLAYER-CONTEXT DIGEST (lazy, alert-path only — never on the hot gate path) ──
// Data-backed framings (research/2026-07-02_*): star-carried leads HOLD (~26% comeback vs ~34%
// base); role-carry = fragility candidate (n<30); eFG heat = amplifier on quality gap (53→61%);
// regression-to-norm does NOT give back a banked lead. All math coerces Number(x)||0 (BDL null=0).

// F4 — carrier identity from season ppg (thresholds from addendum cuts)
function ssClassifyCarrier(ppg) {
  if (ppg == null) return 'UNKNOWN';
  if (ppg >= 14) return 'STAR';
  if (ppg <= 10) return 'ROLE';
  return 'MID';
}

// minutes: '26' or '26:30' → number
function _ssMin(m) {
  if (m == null) return 0;
  const s = String(m);
  if (s.includes(':')) { const a = s.split(':'); return (Number(a[0]) || 0) + (Number(a[1]) || 0) / 60; }
  return Number(s) || 0;
}

// F1 — per-team per-player reduce off modelSummary.{home,away}.players (bpa shape)
function ssPlayerDigest(mm, leaderIsHome) {
  if (!mm || !mm.home || !mm.away) return null;
  function side(sd) {
    const rows = (sd.players || []).map(p => {
      const st = p.statistics || {};
      const pts = Number(st.points) || 0, fga = Number(st.field_goals_att) || 0, fta = Number(st.free_throws_att) || 0;
      const denom = 2 * (fga + 0.44 * fta);
      return {
        id: p.id, name: p.full_name || '?', starter: !!p.starter,
        pts, fga, fta,
        fgm: Number(st.field_goals_made) || 0, fg3m: Number(st.three_points_made) || 0, fg3a: Number(st.three_points_att) || 0,
        pf: Number(st.personal_fouls) || 0, min: _ssMin(st.minutes),
        ts: denom > 0 ? pts / denom : null,
      };
    });
    const teamPts = rows.reduce((a, r) => a + r.pts, 0);
    const tFga = rows.reduce((a, r) => a + r.fga, 0);
    const teamEfg = tFga > 0 ? (rows.reduce((a, r) => a + r.fgm, 0) + 0.5 * rows.reduce((a, r) => a + r.fg3m, 0)) / tFga : null;
    const sorted = rows.slice().sort((a, b) => b.pts - a.pts);
    const top = sorted.slice(0, 2).map(r => ({ ...r, share: teamPts > 0 ? r.pts / teamPts : 0 }));
    // WNBA has no lineups endpoint → bpa starter flag is false for all; fall back to minutes
    const foulTrouble = rows.filter(r => (r.starter || r.min >= 10) && r.pf >= 3).map(r => `${r.name} (${r.pf}F)`);
    const hasStarterData = rows.some(r => r.starter);
    const benchPts = rows.filter(r => !r.starter).reduce((a, r) => a + r.pts, 0);
    return { alias: sd.alias || '?', teamPts, teamEfg, top, foulTrouble,
      benchShare: (hasStarterData && teamPts > 0) ? benchPts / teamPts : null };
  }
  const h = side(mm.home), a = side(mm.away);
  return leaderIsHome ? { leader: h, trailer: a } : { leader: a, trailer: h };
}

// F2 — per-player/team shot geography off parseBDLPBPServer raw.shots (quarter-filterable)
function ssShotGeo(pbp, teamAlias, playerName, curPeriod) {
  const shots = (pbp && pbp.raw && pbp.raw.shots) || [];
  const mine = shots.filter(s => s && s.tm === teamAlias && (!playerName || s.p === playerName));
  function mix(list) {
    let rim = 0, mid = 0, three = 0, att = 0, made = 0;
    for (const s of list) {
      att++;
      if (!s.m) continue;
      made++;
      if (s.is3) three += 3;
      else if (/rim|paint|layup|dunk|restricted|tip/i.test(String(s.z || '') + ' ' + String(s.ctx || ''))) rim += 2;
      else mid += 2;
    }
    const tot = rim + mid + three;
    return { att, made, pts: tot, rimPct: tot > 0 ? rim / tot : null, midPct: tot > 0 ? mid / tot : null, threePct: tot > 0 ? three / tot : null, unsustShare: tot > 0 ? (mid + three) / tot : null };
  }
  return { cum: mix(mine), thisQ: mix(mine.filter(s => Number(s.q) === Number(curPeriod))) };
}

// F3 — lazy season baseline for a carrier (≤3 calls per fired alert; non-fatal → UNKNOWN)
async function ssCarrierBaseline(playerId) {
  try {
    const yr = new Date().getFullYear();
    const d = await bdlFetch(`/wnba/v1/player_stats?seasons[]=${yr}&player_ids[]=${playerId}&per_page=100`);
    const rows = (d && d.data) || [];
    let g = 0, pts = 0, fga = 0, fta = 0;
    for (const r of rows) {
      const m = _ssMin(r.min);
      if (m <= 0 && !(Number(r.pts) || 0)) continue;
      g++; pts += Number(r.pts) || 0; fga += Number(r.fga) || 0; fta += Number(r.fta) || 0;
    }
    if (g < 5) return null; // too few games for a norm
    const denom = 2 * (fga + 0.44 * fta);
    return { g, ppg: pts / g, tsNorm: denom > 0 ? pts / denom : null };
  } catch (e) { return null; }
}

// F5 — prompt context block + row columns. Pure function of the digest.
function ssComposeCtxBlock(dg) {
  const P = (v, d = 0) => v == null ? '?' : (v * 100).toFixed(d);
  const car = (dg.leader.top && dg.leader.top[0]) || null;
  const base = (dg.base && car && dg.base[car.name]) || null;
  const identity = ssClassifyCarrier(base ? base.ppg : null);
  const dev = (car && car.ts != null && base && base.tsNorm != null) ? car.ts - base.tsNorm : null;
  const cg = dg.shot && dg.shot.carrier && dg.shot.carrier.cum;
  let t = `PLAYER CONTEXT [FACT-live]:\n`;
  if (car) {
    t += `- ${dg.leader.alias} scoring is carried by ${car.name} (${P(car.share)}% of team pts, ${car.pts} pts, live TS ${P(car.ts)}%`
      + (base ? `; season ${base.ppg.toFixed(1)} ppg → ${identity} carrier` : `; season baseline unavailable → carrier profile UNKNOWN`)
      + (dev != null ? `, running ${dev >= 0 ? '+' : ''}${P(dev)}pp vs her season norm` : '') + `).`
      + (cg && cg.pts > 0 ? ` Shot mix: ${P(cg.rimPct)}% rim / ${P(cg.midPct)}% mid / ${P(cg.threePct)}% threes.` : '') + `\n`;
  }
  const ft = [...(dg.leader.foulTrouble || []).map(x => `${dg.leader.alias} ${x}`), ...(dg.trailer.foulTrouble || []).map(x => `${dg.trailer.alias} ${x}`)];
  t += `- Foul trouble: ${ft.length ? ft.join(', ') : 'none'}.\n`;
  if (dg.trailer.top && dg.trailer.top.length) {
    t += `- ${dg.trailer.alias} comeback engines: ${dg.trailer.top.map(r => `${r.name} ${r.pts} pts (TS ${P(r.ts)}%)`).join(', ')}`
      + (dg.trailer.benchShare != null ? `; bench ${P(dg.trailer.benchShare)}% of pts` : ``) + `.\n`;
  }
  if (dg.trailer.teamEfg != null) {
    t += `- ${dg.trailer.alias} shooting ${P(dg.trailer.teamEfg)}% eFG while trailing`
      + (dg.trailer.teamEfg <= 0.48 ? ` — at/below par: the deficit is variance, not quality [PRIOR-validated]` : '') + `.\n`;
  }
  t += `\nFRAMING RULES [PRIOR-validated unless tagged]:\n`
    + `- The fade thesis here is TEAM-level: quality gap first; ${dg.leader.alias}'s elevated eFG amplifies it (gap alone ~53% comeback; gap + leader shooting hot ~61%).\n`
    + `- Hot shooting regresses to the shooter's own norm within the game — but points already scored are banked; regression alone does not hand the lead back.\n`;
  if (identity === 'STAR') {
    t += `- ${car.name} is a STAR carrier: star-carried leads historically HOLD BETTER than average (~26% comeback vs ~34% base). Do NOT call her production a mirage; name her as the primary risk — she regresses to a norm that still feeds the lead. The mirage claim applies to the team-level variance share, not to her.\n`;
  } else if (identity === 'ROLE') {
    t += `- ${car.name} is a ROLE carrier (≤10 ppg season): a role player carrying the lead is an early-sample fragility signal [PRIOR-candidate, n<30] — supportive color, not a load-bearing claim.\n`;
  } else {
    t += `- Carrier profile ${identity}: no carrier-specific framing — stick to team-level reasons.\n`;
  }
  return {
    text: t,
    cols: {
      carrier_name: car ? car.name : null,
      carrier_identity: identity,
      carrier_share: car ? Math.round(car.share * 1000) / 1000 : null,
      carrier_ppg: base ? Math.round(base.ppg * 10) / 10 : null,
    },
  };
}

// ── SWEETSPOT TIER LADDER (SWEETSPOT_TIER_BC_SPEC.md §2 + A1.2) ────────────
// Pure function → extractable by the fixture harness (research/ss_tier_bc_fixtures.mjs).
// Returns { tier, softCell, ledgerSub } — at most one of tier/ledgerSub is set.
// A  = pristine dual-gate (STRONG FADE + VOLATILE)          [unchanged, live]
// B1 = fade soft (LEAN FADE + VOLATILE)                     [BT 70.0%, n=10]
// B2 = variance soft (STRONG FADE + MIXED)                  [BT 56.2%, n=32]
// B3 = mid-heat, both one step (LEAN FADE + MIXED)          [A1.2, frontier-priced ~free]
// GAP_BASE    = base gates pass, fade/class fail A+B shapes [~40% cell — ledger only]
// Q4_COLLAPSE = Q4, deficit 10-15, collapse STRONG/SHORT    [log-first, push deferred]
function ssClassifyTier(edge, period, deficit, collT, fadeT, cls) {
  const out = { tier: null, softCell: null, ledgerSub: null };
  if (edge == null || edge <= 0 || !(collT === 'STRONG' || collT === 'SHORT')) return out;
  if (period < 4 && deficit <= 9) {
    if (fadeT === 'STRONG FADE' && cls === 'VOLATILE') { out.tier = 'A'; }
    else if (fadeT === 'LEAN FADE' && cls === 'VOLATILE') { out.tier = 'B'; out.softCell = 'B1'; }
    else if (fadeT === 'STRONG FADE' && cls === 'MIXED') { out.tier = 'B'; out.softCell = 'B2'; }
    else if (fadeT === 'LEAN FADE' && cls === 'MIXED') { out.tier = 'B'; out.softCell = 'B3'; }
    else { out.ledgerSub = 'GAP_BASE'; }
  } else if (period === 4 && deficit >= 10 && deficit <= 15) {
    out.ledgerSub = 'Q4_COLLAPSE';
  }
  return out;
}

// ── PUSH COPY STANDARD (SWEETSPOT_TIER_BC_SPEC.md AMENDMENT 2, templates verbatim) ──
// Pure function → extractable by the fixture harness. Bodies are UTF-8 (em dashes fine);
// titles use ASCII hyphen (Node fetch requires ASCII headers — hotfix learning #2;
// sendNtfy sanitizes as a second line of defense). WHY → NUMBERS → SIZE, every term in
// full: "quality gap" with both win rates, "effective FG (shooting efficiency)", never
// raw band colors / "pp" / "1/4-Kelly" jargon.
function ssComposePush(ss) {
  const _ml = v => v == null ? '?' : (Number(v) > 0 ? '+' + v : '' + v);
  const _pct = (v, d = 0) => v == null ? '?' : (v * 100).toFixed(d);
  if (ss.subtype === 'WATCHLIST') {
    const band = ss.leaderBand === 'red' ? ' — running red-hot'
      : (ss.leaderBand === 'orange' ? ' — running hot' : '');
    const body = `${ss.trailerAl} is the much better team — wins ${_pct(ss.trailerWP)}% of games vs ${ss.leaderAl}'s ${_pct(ss.leaderWP)}% (quality gap) — and trails by ${ss.margin} in Q${ss.period}. ${ss.leaderAl} shooting ${ss.leaderEfg != null ? Math.round(ss.leaderEfg) : '?'}% effective FG${band}.\n`
      + `System gates haven't aligned for a bet; worth a dashboard look.`;
    return { title: `REVIEW - ${ss.trailerAl} down ${ss.margin} to ${ss.leaderAl} (not a bet call)`, body: body, priority: 2 };
  }
  // A / B share one template; B adds the soft-gate clause after WHY + eighth-Kelly SIZE.
  const tierWord = ss.tier === 'B' ? 'B' : 'A';
  const softClause = ss.tier !== 'B' ? ''
    : (ss.softCell === 'B3'
      ? `TIER B: both reads a step soft — confidence a notch below A.\n`
      : `TIER B: one gate is a step soft: ${ss.softCell === 'B1' ? 'shooting-heat read moderate' : 'lead-mix read moderate'} — confidence a notch below A.\n`);
  const consensus = (ss.books > 1 && ss.consensusML != null) ? ` (consensus ${_ml(ss.consensusML)})` : '';
  const kelly = ss.kellySize == null ? '?' : ((ss.tier === 'B' ? ss.kellySize / 2 : ss.kellySize) * 100).toFixed(1);
  const sizeLabel = ss.tier === 'B' ? 'eighth-Kelly — half of A sizing' : 'quarter-Kelly';
  const body = `Back ${ss.trailerAl} (${ss.trailerW}-${ss.trailerL}) down ${ss.margin} to ${ss.leaderAl} (${ss.leaderW}-${ss.leaderL}), Q${ss.period} ${ss.clock}.\n`
    + `WHY: ${ss.leaderAl}'s lead is built on hot shooting — ${ss.leaderEfg != null ? Math.round(ss.leaderEfg) : '?'}% effective FG (shooting efficiency), and ${ss.varShare != null ? Math.round(ss.varShare) : '?'}% of their lead comes from that heat rather than structure. ${ss.trailerAl} is the far better team: wins ${_pct(ss.trailerWP)}% of games vs ${ss.leaderAl}'s ${_pct(ss.leaderWP)}% (quality gap).\n`
    + softClause
    + `NUMBERS: model true win chance for ${ss.trailerAl} ~${_pct(ss.collapseTrue)}% (range ${_pct(ss.pLow)}–${_pct(ss.pHigh)}%) vs the market's ${_pct(ss.impliedBest)}% — a +${_pct(ss.edge)}-point edge. Best price ${_ml(ss.bestML)} at ${ss.bestBook || 'best book'}${consensus}.\n`
    + `SIZE: ~${kelly}% of bankroll (${sizeLabel}). Valid while the deficit stays single digits, before Q4.`;
  return { title: `SWEET SPOT ${tierWord} - Back ${ss.trailerAl} ${_ml(ss.bestML)} (${ss.bestBook || 'book'})`, body: body, priority: ss.tier === 'B' ? 4 : 5 };
}

async function fireSweetSpotAlert(sql, game, league, hA, aA, ss, pctx = null) {
  const _ml = v => v == null ? '?' : (Number(v) > 0 ? '+' + v : '' + v);
  const _pct = (v, d = 0) => v == null ? '?' : (v * 100).toFixed(d);
  try {
    // Stage 0 — suppression (A2.5): A suppresses B; A/B suppress WATCHLIST. B-then-A and
    // watchlist-then-A/B remain allowed (upgrades). Indexed SELECT, rare fire path only.
    // Non-fatal: on error, fail open — the dedup index still guards same-subtype re-fires.
    try {
      if (ss.subtype === 'EFG_FADE_SOFT') {
        const _sup = await sql`SELECT id FROM sweetspot_alerts WHERE game_id = ${game.id} AND alert_subtype = ${'EFG_FADE'} LIMIT 1`;
        if (_sup.length > 0) { log(`${aA}@${hA}: sweetspot B suppressed — A already fired this game`); return; }
      } else if (ss.subtype === 'WATCHLIST') {
        const _sup = await sql`SELECT id FROM sweetspot_alerts WHERE game_id = ${game.id} AND alert_subtype IN ('EFG_FADE', 'EFG_FADE_SOFT') LIMIT 1`;
        if (_sup.length > 0) { log(`${aA}@${hA}: sweetspot WATCHLIST suppressed — A/B already fired this game`); return; }
      }
    } catch (e) { log(`${aA}@${hA}: sweetspot suppress check non-fatal: ${e.message}`); }

    // Stage 1a — atomic dedup insert (ledger subtypes: rows only, ntfy_sent=false)
    // KILLER_FLAG_SPEC §2: stamp the leader's season-profile killer fields from the
    // cached team ctx (ensureTeamCtx is TTL-cached — this is a no-op on warm cycles).
    // Missing ctx -> NULL stamp; never computed inline on the polling path.
    await ensureTeamCtx(sql, league);
    const _kProf = (typeof _teamCtxMap === 'object' && _teamCtxMap) ? _teamCtxMap[ss.leaderAl] : null;
    const _kk = _kProf && _kProf.profile && _kProf.profile.killer ? _kProf.profile.killer : null;
    let inserted;
    try {
      inserted = await sql`
        INSERT INTO sweetspot_alerts (game_id, league, alert_subtype, alert_tier, period, clock,
          leader_alias, trailer_alias, leader_wp, trailer_wp, quality_gap, leader_efg, leader_efg_band,
          variance_share, lead_class, fade_tier, collapse_tier, collapse_true, deficit, margin,
          line_used, line_consensus, implied, edge, kelly_size, ntfy_sent, leader_killer, leader_scalps)
        VALUES (${game.id}, ${league}, ${ss.subtype}, ${ss.tier}, ${ss.period}, ${ss.clock},
          ${ss.leaderAl}, ${ss.trailerAl}, ${ss.leaderWP}, ${ss.trailerWP}, ${ss.gap}, ${ss.leaderEfg}, ${ss.leaderBand},
          ${ss.varShare}, ${ss.leadClass}, ${ss.fadeTier}, ${ss.collapseTier}, ${ss.collapseTrue}, ${ss.margin}, ${ss.margin},
          ${ss.bestML != null ? parseInt(ss.bestML) : null}, ${ss.consensusML != null ? parseInt(ss.consensusML) : null},
          ${ss.impliedBest}, ${ss.edge}, ${ss.kellySize}, ${!ss.ledgerOnly}, ${_kk ? _kk.flag : null}, ${_kk ? _kk.scalps : null})
        ON CONFLICT (game_id, alert_subtype) DO NOTHING
        RETURNING id`;
    } catch (e) { log(`${aA}@${hA}: sweetspot insert failed: ${e.message}`); return; }
    if (!inserted || inserted.length === 0) return;  // already fired this subtype for this game
    const rowId = inserted[0].id;

    // Stage 1b — instant mechanical push (the WHAT, 0 Opus). Copy per A2.3 standard.
    // Ledger subtypes skip the push entirely (rows only); WATCHLIST is a priority-2 review cue.
    if (ss.ledgerOnly) {
      log(`${aA}@${hA}: sweetspot ledger row ${ss.subtype} recorded — Q${ss.period} ${ss.trailerAl} +${ss.margin} collapse=${ss.collapseTier} fade=${ss.fadeTier || '—'} class=${ss.leadClass || '—'} (no push, ever)`);
    } else {
      const push = ssComposePush(ss);
      // TEAM_PROFILES_SPEC §6 — one plain-English profile line in mechanical push bodies.
      // Appended at call site (ssComposePush copy is fixture-pinned); '' when flag off.
      let _pushBody = push.body;
      // D-13 Fix B (Jul 30): A/B fires that upgrade a delivered same-game WATCHLIST open
      // with the escalation breadcrumb — body only, never the Title (ASCII header, hotfix #2).
      // Stage 0 already allows watchlist-then-A/B as an upgrade; this makes the lineage explicit.
      if (ss.subtype !== 'WATCHLIST') {
        try {
          const _w = await sql`SELECT period, clock FROM sweetspot_alerts WHERE game_id = ${game.id}
            AND league = ${league} AND alert_subtype = ${'WATCHLIST'} AND ntfy_sent = true
            ORDER BY id DESC LIMIT 1`;
          if (_w.length) _pushBody = `Escalated from watchlist (fired Q${_w[0].period}${_w[0].clock ? ' ' + _w[0].clock : ''}).\n\n` + _pushBody;
        } catch (e) { /* non-fatal — push goes out without the breadcrumb */ }
      }
      try {
        await ensureTeamCtx(sql, league);
        const _tcLine = composeTeamCtxLine(ss.trailerAl, ss.leaderAl, league);
        if (_tcLine) _pushBody = push.body + '\n\n' + _tcLine;
      } catch (e) { /* non-fatal — push goes out without the line */ }
      await sendNtfy(push.title, _pushBody, push.priority, SS_DASH_URL);
      log(`${aA}@${hA}: ★ SWEET SPOT ${ss.subtype === 'WATCHLIST' ? 'WATCHLIST' : ss.tier} FIRED — ${ss.trailerAl} +${ss.margin}${ss.edge != null ? ` edge=${_pct(ss.edge)}pp` : ''} line=${_ml(ss.bestML)}${ss.softCell ? ` cell=${ss.softCell}` : ''}`);
    }

    // Stage 1.5 — §4c player-context digest (lazy; ledger-first so calibration data survives
    // narration failure; any throw here degrades to today's context-free narration)
    let _ctxText = '', _ctxStamped = false;
    if (pctx && pctx.modelSummary) {
      try {
        const _ldHome = ss.leaderAl === hA;
        const dg = ssPlayerDigest(pctx.modelSummary, _ldHome);
        if (dg) {
          const _car = (dg.leader.top && dg.leader.top[0]) || null;
          dg.shot = {
            team: ssShotGeo(pctx.pbp, dg.leader.alias, null, ss.period),
            carrier: _car ? ssShotGeo(pctx.pbp, dg.leader.alias, _car.name, ss.period) : null,
          };
          dg.base = {};
          const _blP = [...dg.leader.top.slice(0, 2), ...dg.trailer.top.slice(0, 1)];
          for (const bp of _blP) {
            if (bp && bp.id) dg.base[bp.name] = (pctx.baselines && pctx.baselines[bp.name]) || await ssCarrierBaseline(bp.id);
          }
          dg.period = ss.period;
          if (ss.fuelTemp) dg.fuelTemp = ss.fuelTemp; // DS v1 C1 — rides the existing ctx JSONB, no new columns
          const _composed = ssComposeCtxBlock(dg);
          _ctxText = _composed.text;
          const _c = _composed.cols;
          await sql`UPDATE sweetspot_alerts SET carrier_name = ${_c.carrier_name}, carrier_identity = ${_c.carrier_identity},
            carrier_share = ${_c.carrier_share}, carrier_ppg = ${_c.carrier_ppg}, player_ctx_json = ${JSON.stringify(dg)}
            WHERE id = ${rowId}`;
          _ctxStamped = true;
          log(`${aA}@${hA}: sweetspot pctx — carrier=${_c.carrier_name || '?'} (${_c.carrier_identity}) share=${_c.carrier_share != null ? Math.round(_c.carrier_share * 100) : '?'}%`);
        }
      } catch (e) { log(`${aA}@${hA}: sweetspot pctx non-fatal: ${e.message}`); _ctxText = ''; }
    }
    // DS v1 C1 fallback — the fuel/temp stamp must survive pctx failure (surge watch
    // + FUEL PULSE read it). Isolated UPDATE, non-fatal; degrades to no stamp.
    if (!_ctxStamped && ss.fuelTemp) {
      try {
        await sql`UPDATE sweetspot_alerts SET player_ctx_json = ${JSON.stringify({ fuelTemp: ss.fuelTemp })} WHERE id = ${rowId}`;
      } catch (e) { log(`${aA}@${hA}: fuelTemp stamp non-fatal: ${e.message}`); }
    }

    // Stage 2 — async narration (the WHY); non-fatal, never re-decides.
    // A/B always narrate under V2 (D-11: B keeps two-push parity). WATCHLIST narrates as a
    // REVIEW via the sweep only (D-12, WNBA_SS_NARRATE_WATCHLIST). Ledger rows never narrate —
    // all still got the Stage 1.5 digest above (carrier ledger = forward OOS feed).
    if (ss.ledgerOnly) return;
    // NARRATION V2 (D-4): narration deferred to the end-of-cycle tail sweep —
    // row already has narration_text NULL + narration_attempts 0; sweep claims it.
    if (WNBA_SS_NARRATE_V2) {
      if (ss.subtype === 'WATCHLIST' && !WNBA_SS_NARRATE_WATCHLIST) { log(`${aA}@${hA}: sweetspot WATCHLIST — review narration off (WNBA_SS_NARRATE_WATCHLIST)`); return; }
      log(`${aA}@${hA}: sweetspot narration deferred to tail sweep (V2)`); return;
    }
    // Legacy inline path below is fade-framed (tier wording + price guidance) — it must
    // never narrate a WATCHLIST row: it would mislabel a review cue as a B-tier fire.
    if (ss.subtype === 'WATCHLIST') return;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;
    try {
      const prompt = `You are narrating a live betting sweet-spot alert that has ALREADY fired — do not re-decide, just explain WHY for a bettor in plain English.\n\n`
        + `${ss.trailerAl} (${ss.trailerW}-${ss.trailerL}) is down ${ss.margin} to ${ss.leaderAl} (${ss.leaderW}-${ss.leaderL}) in Q${ss.period} ${ss.clock}.\n`
        + `Why the system flagged it:\n`
        + `- ${ss.leaderAl}'s lead is built on unsustainable shooting: eFG ${ss.leaderEfg != null ? Math.round(ss.leaderEfg) : '?'}% (${ss.leaderBand} band), variance share ${ss.varShare != null ? Math.round(ss.varShare) : '?'}% (lead class ${ss.leadClass}).\n`
        + `- ${ss.trailerAl} is the structurally better team: win% ${_pct(ss.trailerWP)} vs ${_pct(ss.leaderWP)} (quality gap ${ss.gap != null ? ss.gap.toFixed(2) : '?'}).\n`
        + `- Model true win prob ~${_pct(ss.collapseTrue)}% vs market ~${_pct(ss.impliedBest)}% → edge +${_pct(ss.edge)}pp.\n\n`
        + (_ctxText ? _ctxText + `\n` : ``)
        + `Write exactly, under 110 words, no jargon, no preamble:\n`
        + `(1) one sentence on why ${ss.leaderAl}'s lead is statistically fragile at the TEAM level (variance share / eFG band / quality gap);\n`
        + `(2) one sentence on why ${ss.trailerAl} is the better team likely to close${_ctxText ? `, naming their live comeback engine(s)` : ``};\n`
        + `(3) one sentence on the single biggest risk to watch${_ctxText ? ` — if a STAR carrier is flagged above this MUST be her sustaining at her norm; include foul trouble on either side if present` : ``}.\n`
        + `State every metric in full plain English on first use — say "quality gap" and "effective field-goal percentage", never bare "gap" or "eFG"; use percentages, not decimals.\n`
        + `Never predict a specific player's shooting will collapse.${_ctxText ? ` Never contradict the FRAMING RULES.` : ``} Use team names.`;
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!resp.ok) { log(`${aA}@${hA}: sweetspot narration ${resp.status}`); return; }
      const data = await resp.json();
      const narration = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!narration || narration.length < 20) return;
      await sql`UPDATE sweetspot_alerts SET narration_text = ${narration} WHERE id = ${rowId}`;
      await sendNtfy(`SWEET SPOT - why ${ss.trailerAl}`, narration, 4, SS_DASH_URL);
      log(`${aA}@${hA}: sweetspot narration delivered (${narration.length} chars)`);
    } catch (e) { log(`${aA}@${hA}: sweetspot narration error: ${e.message}`); }
  } catch (e) { log(`${aA}@${hA}: fireSweetSpotAlert fatal: ${e.message}`); }
}

// ── SWEETSPOT NARRATION V2 (SWEETSPOT_NARRATION_V2_SPEC.md) ──────────────────
// Ships DARK. WNBA_SS_NARRATE_V2=1 → A/B fire narration moves from inline Stage-2
// to the end-of-cycle tail sweep (D-4): Fable 5 high effort, Opus 4.8 fallback on
// 4xx/5xx/timeout/refusal (refusals are HTTP 200 + stop_reason). WNBA_GAME_BRIEF_ON=1
// → auto GAME_BRIEF per game (D-9b) + on-demand ?ss_brief=<gameId> (D-9a).
// WNBA_SS_NARRATE_WATCHLIST=1 (D-12, sub-flag of V2 — inert unless V2 is also on) →
// WATCHLIST rows narrate via the sweep as a REVIEW (priority 2, no bet directive,
// factual price line, 2h recency window so a flag turn-on never drains stale rows).
const WNBA_SS_NARRATE_V2 = process.env.WNBA_SS_NARRATE_V2 === '1';
const WNBA_GAME_BRIEF_ON = process.env.WNBA_GAME_BRIEF_ON === '1';
const WNBA_SS_NARRATE_WATCHLIST = process.env.WNBA_SS_NARRATE_WATCHLIST === '1';
const SS_NARRATE_TIMEOUT_MS = 45000;
const SS_NARRATE_BUDGET_MS = 55000;   // skip sweep if handler already past this
var _briefSeeded = {};                 // per-warm-invocation guard; DB PK is the real dedup

// Implied prob -> American ML. Edge-guaranteeing round: nudge less-negative/more-positive
// until implied(ml) <= q, so the displayed "or longer" line always delivers >= the target edge.
function ssImpliedToML(q) {
  if (q == null || q <= 0.01 || q >= 0.99) return null;
  let ml = q > 0.5 ? Math.round(-100 * q / (1 - q)) : Math.round(100 * (1 - q) / q);
  for (let i = 0; i < 3; i++) {
    const imp = ml > 0 ? 100 / (ml + 100) : (-ml) / ((-ml) + 100);
    if (imp <= q + 1e-9) break;
    ml += 1; if (ml === 0 || ml === -99) ml = 100; // skip the invalid -99..+99 gap
  }
  return ml;
}

// §3 price ladder — mechanical, the model NEVER does this math. PROBE_EDGE +10pp,
// FULL_EDGE +20pp (D-3). Returns pre-formatted plain-English lines for the prompt.
function ssPriceLadder(p, lineUsed) {
  if (p == null) return { text: '' };
  const fmtML = (ml) => ml == null ? '?' : (ml > 0 ? '+' + ml : String(ml));
  const impliedNow = (lineUsed != null && lineUsed !== 0)
    ? (Number(lineUsed) > 0 ? 100 / (Number(lineUsed) + 100) : (-Number(lineUsed)) / ((-Number(lineUsed)) + 100))
    : null;
  const edgeNowPP = impliedNow != null ? Math.round((p - impliedNow) * 1000) / 10 : null;
  const probeLine = ssImpliedToML(p - 0.10);
  const fullLine = ssImpliedToML(p - 0.20);
  let text = 'PRICE LADDER (pre-computed — weave into the price paragraph, never recompute):\n';
  if (edgeNowPP != null) {
    text += `- At the captured price (${fmtML(Number(lineUsed))}) the edge is ${edgeNowPP >= 0 ? '+' : ''}${edgeNowPP.toFixed(1)} points${edgeNowPP >= 10 ? ' — already probe territory or better' : edgeNowPP >= 3 ? ' — above the minimum bar but thin' : ' — below the bet bar'}.\n`;
  }
  text += `- Probe territory (small stake): ${fmtML(probeLine)} or longer.\n`;
  text += `- Full tier size: ${fmtML(fullLine)} or longer.\n`;
  return { edgeNowPP, probeLine, fullLine, text };
}

// §6 output contract — 4 parts, 150-190 word target, 200 hard cap (PM Jul 14).
// PURE (fixture-extracted): all context arrives via `blocks`, already-formatted strings.
function ssBuildNarrationPrompt(row, blocks) {
  const b = blocks || {};
  const pct = (v, d = 0) => v == null ? '?' : (Number(v) * 100).toFixed(d);
  const tier = row.alert_subtype === 'EFG_FADE' ? 'A-tier' : 'B-tier';
  return `You are the narration layer of a live WNBA betting intelligence system. A SWEET SPOT ${tier} alert ALREADY fired and the bettor received the mechanical push — never re-decide, never contradict it. Your job is the WHY, for a bettor, in plain English.\n\n`
    + `FIRE: ${row.trailer_alias} trailing ${row.leader_alias} by ${row.margin}, Q${row.period} ${row.clock}.\n`
    + `- Leader shooting heat: effective field-goal percentage ${row.leader_efg != null ? Math.round(row.leader_efg) : '?'}% (${row.leader_efg_band || '?'} band), variance share ${row.variance_share != null ? Math.round(row.variance_share) : '?'}% of the lead from three-pointers and midrange (lead class ${row.lead_class || '?'}).\n`
    + `- Quality gap: ${row.trailer_alias} season win probability ${pct(row.trailer_wp)}% vs ${row.leader_alias} ${pct(row.leader_wp)}% (gap ${row.quality_gap != null ? Number(row.quality_gap).toFixed(2) : '?'}).\n`
    + `- Model true win probability ${pct(row.collapse_true)}% vs market implied ${pct(row.implied)}% at fire.\n\n`
    + (b.ladderText ? b.ladderText + '\n' : '')
    + (b.quarterFlow ? b.quarterFlow + '\n' : '')
    + (b.snapState ? b.snapState + '\n' : '')
    + (b.fuelTemp ? b.fuelTemp + '\n' : '')
    + (b.teamCtx ? b.teamCtx + '\n' : '')
    + (b.playerCtx ? b.playerCtx + '\n' : '')
    + `Write exactly 4 short paragraphs, aiming for 150-190 words total so the relevant information fits — 200 words is a hard cap:\n`
    + `(1) Why ${row.leader_alias}'s lead is fragile at the TEAM level — use the quarter flow and shooting texture where available.\n`
    + `(2) Why ${row.trailer_alias} is the better team likely to close — the structural levers they own${b.playerCtx ? ', naming their live comeback engines' : ''}.\n`
    + `(3) Price guidance — the current edge, the probe price, and the full-size price, in plain sizing language.\n`
    + `(4) The single biggest risk${b.playerCtx ? ' — if a STAR carrier is flagged above, this MUST be her sustaining at her norm' : ''}; include foul trouble if present; if the trailer path shows CONTESTED or BLOCK you must surface it here.\n\n`
    + `Rules: NO markdown — no bold, no asterisks, no headers; plain paragraphs separated by blank lines (this is a push notification body); plain English throughout; name every metric in full on first use ("quality gap", "effective field-goal percentage"), never bare abbreviations; percentages, not decimals; team names, never "they" across paragraph boundaries; never predict a specific player's shooting will collapse; never mention floor scores; never imply the leader's hot shooting is itself the predictive signal — the locked edge is quality gap plus deficit plus price.`;
}

// D-9 brief contract — 3 parts, ~90-word target, 120 hard cap, NO prices, NO lean.
// PURE (fixture-extracted).
function ssBuildBriefPrompt(hA, aA, ctx) {
  const c = ctx || {};
  return `You are the narration layer of a live WNBA betting intelligence system. No alert fired for this game — nothing here qualifies. Write a short GAME BRIEF for the bettor: the season lens, with zero action implication.\n\n`
    + `GAME: ${aA} @ ${hA}${c.liveLine ? ` — ${c.liveLine}` : ''}.\n`
    + `WHY NOTHING QUALIFIES: ${c.reason || 'the quality gap between these teams is too thin for the system\u2019s comeback edge'}.\n\n`
    + (c.teamCtx ? c.teamCtx + '\n' : '')
    + `Write exactly 3 short paragraphs, aiming for about 90 words total — 120 words is a hard cap:\n`
    + `(1) Lead with "No position" and one plain sentence on why nothing here qualifies.\n`
    + `(2) The season lens: both teams' identities, the head-to-head if shown, and any recent form heat.\n`
    + `(3) What would change it: one sentence on the shape of game that would make the system speak up.\n\n`
    + `Rules: NO markdown — no bold, no asterisks, no headers (push notification body); plain English; no prices, no odds, no lean, no bet suggestion of any kind; team names throughout; if the context block is missing, say the season lens is unavailable rather than inventing one.`;
}

// D-12 WATCHLIST REVIEW contract (PM go Jul 15) — 4 parts, 150-190 target / 200 hard cap.
// WATCHLIST = review cue, NOT a fire: the prompt must never produce a bet directive,
// a lean, or sizing language. Price IS included (PM call) but stated as a plain fact
// with zero edge/value claim — WATCHLIST rows routinely carry edge/collapse_true NULL.
// The fire-ladder legend is ssClassifyTier verbatim: the model cites the row's reads
// against it and never invents thresholds. PURE (fixture-extracted).
function ssBuildWatchlistPrompt(row, blocks) {
  const b = blocks || {};
  const pct = (v, d = 0) => v == null ? '?' : (Number(v) * 100).toFixed(d);
  const ml = (v) => v == null ? '?' : (Number(v) > 0 ? '+' + v : '' + v);
  return `You are the narration layer of a live WNBA betting intelligence system. A WATCHLIST review cue ALREADY reached the bettor — this is NOT a fired bet alert and you must never turn it into one. Your job is season-and-live context for the bettor's own discretionary read, in plain English.\n\n`
    + `SPOT: ${row.trailer_alias} trailing ${row.leader_alias} by ${row.margin}, Q${row.period} ${row.clock}.\n`
    + `- Quality gap: ${row.trailer_alias} season win probability ${pct(row.trailer_wp)}% vs ${row.leader_alias} ${pct(row.leader_wp)}% (gap ${row.quality_gap != null ? Number(row.quality_gap).toFixed(2) : '?'}).\n`
    + `- Leader shooting: effective field-goal percentage ${row.leader_efg != null ? Math.round(row.leader_efg) : '?'}% (${row.leader_efg_band || '?'} band), variance share ${row.variance_share != null ? Math.round(row.variance_share) : '?'}% of the lead from three-pointers and midrange (lead class ${row.lead_class || '?'}).\n`
    + `- System reads on this spot: fade read ${row.fade_tier || 'none'}, collapse read ${row.collapse_tier || 'none'}, model edge ${row.edge != null ? '+' + pct(row.edge) + ' points' : 'none computed'}.\n`
    + `- FIRE LADDER (for reference): a full A or B alert requires ALL of — a positive model edge, a collapse read of STRONG or SHORT, a fade read of STRONG FADE or LEAN FADE, and a lead class of VOLATILE or MIXED, before the fourth quarter with the deficit at 9 or less. The reads above did not clear this ladder.\n`
    + `- Live price on ${row.trailer_alias}: ${ml(row.line_used)} (market implied ${pct(row.implied)}%).\n\n`
    + (b.quarterFlow ? b.quarterFlow + '\n' : '')
    + (b.snapState ? b.snapState + '\n' : '')
    + (b.fuelTemp ? b.fuelTemp + '\n' : '')
    + (b.teamCtx ? b.teamCtx + '\n' : '')
    + (b.playerCtx ? b.playerCtx + '\n' : '')
    + `Write exactly 4 short paragraphs, aiming for 150-190 words total — 200 words is a hard cap:\n`
    + `(1) Open with "Review only — no system bet call." then one sentence on what put this on the radar: the quality gap and the catchable deficit.\n`
    + `(2) The live texture — how the game has flowed and what ${row.leader_alias}'s lead is actually made of${b.playerCtx ? ', naming the carrier if one is flagged' : ''}.\n`
    + `(3) What is missing for a full alert, citing ONLY the system reads listed above against the fire ladder, and what to watch that would upgrade it; then state the current price on ${row.trailer_alias} as a plain fact with no edge or value claim.\n`
    + `(4) The single biggest risk if the bettor takes a discretionary position anyway${b.playerCtx ? ' — if a STAR carrier is flagged above, this MUST be her sustaining at her norm' : ''}; include foul trouble on either side if present.\n\n`
    + `Rules: NO markdown — no bold, no asterisks, no headers; plain paragraphs separated by blank lines (this is a push notification body); plain English throughout; name every metric in full on first use ("quality gap", "effective field-goal percentage"), never bare abbreviations; percentages, not decimals; team names, never "they" across paragraph boundaries; NEVER recommend a bet, a size, or a lean; never call the price good or bad; never predict a specific player's shooting will collapse; never mention floor scores.`;
}

// Model caller — output_config.effort verified on BOTH fable-5 and opus-4-8 (smoke Jul 14):
// fallback is a model-string swap on an identical request. Filters type==='text' (Fable
// prepends a thinking block). Refusal = HTTP 200 + stop_reason 'refusal' → treated as failure.
async function ssCallNarration(prompt, model, timeoutMs) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: 'no api key' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || SS_NARRATE_TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 2500, output_config: { effort: 'high' }, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await resp.json();
    if (!resp.ok) return { ok: false, error: `http ${resp.status}: ${(data.error?.message || '').slice(0, 160)}` };
    if (data.stop_reason === 'refusal') return { ok: false, error: 'refusal (stop_reason)' };
    const text = (data.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim();
    if (!text || text.length < 20) return { ok: false, error: 'empty text' };
    return { ok: true, text, stopReason: data.stop_reason };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(timer); }
}

// Gather sweep-time context blocks for a fire row. Sources are PERSISTED state (the
// fire-site locals are gone at sweep time — spec §2 parity content, rebuilt from storage):
// alert row, player_ctx_json, latest snapshot, games.quarter_data, composeTeamContext.
// Every block optional; each degrades to ''. Floor score deliberately never passed (§2 exclusion).
async function ssGatherNarrationBlocks(sql, row) {
  const blocks = { teamCtx: '', playerCtx: '', quarterFlow: '', snapState: '', ladderText: '', fuelTemp: '' };
  const norm = (al) => ((LEAGUES.wnba && LEAGUES.wnba.aliasMap) || {})[al] || al;
  let hA = null, aA = null;
  try {
    const g = await sql`SELECT home_alias, away_alias, quarter_data FROM games WHERE id = ${row.game_id}`;
    if (g[0]) {
      hA = norm(g[0].home_alias); aA = norm(g[0].away_alias);
      // quarter flow — proven quarter_data.diffs reader (formatSonnetPrompt pattern)
      try {
        let qd = g[0].quarter_data;
        if (typeof qd === 'string') qd = JSON.parse(qd);
        const diffs = qd && qd.diffs;
        if (diffs) {
          const qs = Object.keys(diffs).map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
          const lines = [];
          for (const q of qs) {
            const d = diffs[q]; if (!d || !d.home || !d.away) continue;
            const hp = d.home.points != null ? d.home.points : '?', ap = d.away.points != null ? d.away.points : '?';
            lines.push(`Q${q}: ${hA} ${hp} - ${aA} ${ap} (3P ${hA} ${d.home.three_points_made || 0}/${d.home.three_points_att || 0}, ${aA} ${d.away.three_points_made || 0}/${d.away.three_points_att || 0})`);
          }
          if (lines.length) blocks.quarterFlow = `QUARTER FLOW (how the lead was built):\n${lines.join('\n')}\n`;
        }
      } catch (e) { /* omit */ }
    }
  } catch (e) { log(`narration blocks: game fetch — ${e.message}`); }
  // CTX_FIX (Jul 23): pregame-seeded briefs narrate at the pre-window sweep, hours before
  // the games row exists (it is created only by the first in-window live poll). Resolve
  // aliases from poll_state.schedule_json — the seeder's own alias source. Isolated
  // SELECT, fires only on the missing-games branch (pre-window in practice).
  if (!hA || !aA) {
    try {
      const ps = await sql`SELECT schedule_json FROM poll_state WHERE league = ${'wnba'} ORDER BY date DESC LIMIT 1`;
      if (ps[0] && ps[0].schedule_json) {
        const sched = typeof ps[0].schedule_json === 'string' ? JSON.parse(ps[0].schedule_json) : ps[0].schedule_json;
        const ent = (Array.isArray(sched) ? sched : []).find((x) => x && String(x.id) === String(row.game_id));
        if (ent && ent.home_alias && ent.away_alias) { hA = norm(ent.home_alias); aA = norm(ent.away_alias); }
      }
    } catch (e) { log(`narration blocks: schedule fallback — ${e.message}`); }
  }
  // teamCtx hoisted out of the games-row guard (CTX_FIX): compose whenever both aliases
  // resolve. All prior degradation paths preserved — TEAM_CTX_ON off, unloaded map, or
  // unresolvable aliases still yield '' exactly as before.
  if (hA && aA) {
    try { await ensureTeamCtx(sql, 'wnba'); blocks.teamCtx = composeTeamContext(hA, aA, 'wnba'); } catch (e) { /* degrade */ }
  }
  // player context — recompose from persisted digest (FRAMING RULES travel inside)
  try {
    if (row.player_ctx_json) {
      const dg = typeof row.player_ctx_json === 'string' ? JSON.parse(row.player_ctx_json) : row.player_ctx_json;
      const composed = ssComposeCtxBlock(dg);
      if (composed && composed.text) blocks.playerCtx = composed.text;
    }
  } catch (e) { /* omit */ }
  // DS v1 C1 — fire-time fuel/temp read (stamped into the ctx JSONB at fire). Own
  // try/catch: a fuelTemp-only stamp (pctx-failure fallback) has no dg.leader and
  // must still narrate the fuel lines even though ssComposeCtxBlock above degraded.
  try {
    if (row.player_ctx_json) {
      const _ftDg = typeof row.player_ctx_json === 'string' ? JSON.parse(row.player_ctx_json) : row.player_ctx_json;
      if (_ftDg && _ftDg.fuelTemp) blocks.fuelTemp = ssFuelTempLines(_ftDg.fuelTemp, row.leader_alias, row.trailer_alias);
    }
  } catch (e) { /* omit */ }
  // live structural state — latest snapshot, isolated SELECT; floor_score EXCLUDED by design
  try {
    const sn = await sql`SELECT i1, i2, i3, i4, i5, floor_team, sust_json, tp_class, ls_class,
        xgb_win_prob, mc_cum_win_prob, xgb_shap, period, clock
      FROM snapshots WHERE game_id = ${row.game_id} ORDER BY id DESC LIMIT 1`;
    if (sn[0]) {
      const s = sn[0];
      let sustLine = '';
      try {
        let sj = typeof s.sust_json === 'string' ? JSON.parse(s.sust_json) : s.sust_json;
        if (sj && (sj.home || sj.away)) sustLine = ` | sustainability: ${hA || 'home'} ${sj.home?.tier || '?'}, ${aA || 'away'} ${sj.away?.tier || '?'}`;
      } catch (e) { /* omit */ }
      let shapLine = '';
      try {
        let sh = typeof s.xgb_shap === 'string' ? JSON.parse(s.xgb_shap) : s.xgb_shap;
        if (Array.isArray(sh) && sh.length) shapLine = ` | top structural drivers: ${sh.slice(0, 3).map((x) => x.f).join(', ')}`;
      } catch (e) { /* omit */ }
      blocks.snapState = `LIVE STATE (as of Q${s.period} ${s.clock}, control team ${s.floor_team || '?'}): `
        + `indicator reads I1-I5 (control-relative) ${[s.i1, s.i2, s.i3, s.i4, s.i5].map((v) => v != null ? Number(v).toFixed(1) : '?').join('/')}`
        + ` | trailer comeback path (TP): ${s.tp_class || '?'} | leader safety (LS): ${s.ls_class || '?'}`
        + ` | structural model (XGB) ${s.xgb_win_prob != null ? (s.xgb_win_prob * 100).toFixed(0) + '%' : '?'}`
        + ` | Monte Carlo cumulative ${s.mc_cum_win_prob != null ? (s.mc_cum_win_prob * 100).toFixed(0) + '%' : '?'}`
        + sustLine + shapLine + `\n`;
    }
  } catch (e) { log(`narration blocks: snapshot fetch — ${e.message}`); }
  blocks.ladderText = ssPriceLadder(row.collapse_true != null ? Number(row.collapse_true) : null, row.line_used).text;
  return { blocks, hA, aA };
}

// PREGAME BRIEF SEEDING (Jul 15, PM approved — quiet): skeleton GAME_BRIEF rows for
// today's NOT-YET-STARTED games (status scheduled/created only — finished games never
// get a nonsense pregame lens). period=0 marks the row pregame-seeded: the narration
// sweep narrates period-0 briefs with the pregame reason and NO push (matchup sheet is
// the pregame surface). Idempotent via (game_id, alert_subtype) PK; D-9b's
// first-live-poll transition seed stays for live coverage.
async function ssSeedPregameBriefs(sql, schedule) {
  if (!WNBA_GAME_BRIEF_ON) return;
  const sched = typeof schedule === 'string' ? JSON.parse(schedule) : (schedule || []);
  const todo = sched.filter((g) => g && g.id && g.home_alias && g.away_alias && /scheduled|created/i.test(String(g.status || 'scheduled')));
  if (!todo.length) return;
  const ids = todo.map((g) => String(g.id));
  const have = new Set((await sql`SELECT game_id FROM sweetspot_alerts WHERE league = ${'wnba'} AND alert_subtype = ${'GAME_BRIEF'} AND game_id = ANY(${ids})`).map((r) => String(r.game_id)));
  for (const g of todo) {
    if (have.has(String(g.id))) continue;
    await sql`INSERT INTO sweetspot_alerts (game_id, league, alert_subtype, alert_tier, period, clock, ntfy_sent)
      VALUES (${g.id}, ${'wnba'}, ${'GAME_BRIEF'}, ${'BRIEF'}, ${0}, ${''}, ${false})
      ON CONFLICT (game_id, alert_subtype) DO NOTHING`;
    log(`pregame brief seeded: ${g.away_alias}@${g.home_alias}`);
  }
}

// End-of-cycle tail sweep (D-4): claims at most ONE pending row per invocation —
// fire narrations first (A/B only, D-7), then GAME_BRIEF rows. Lock row guards
// concurrent cron invocations (hotfix #11). attempts 0-1 → Fable; attempt 3 (attempts==2)
// → Opus 4.8 so narration always lands by ~T+3min worst case.
async function ssNarrationSweep(sql, startTime) {
  if (!WNBA_SS_NARRATE_V2 && !WNBA_GAME_BRIEF_ON) return;
  if (Date.now() - startTime > SS_NARRATE_BUDGET_MS) { log('narration sweep: skipped (budget)'); return; }
  let locked = false;
  try {
    const ins = await sql`INSERT INTO job_locks (job, ts) VALUES (${'ss-narration'}, NOW()) ON CONFLICT (job) DO NOTHING RETURNING job`;
    if (ins.length === 0) {
      const stale = await sql`UPDATE job_locks SET ts = NOW() WHERE job = ${'ss-narration'} AND ts < NOW() - INTERVAL '3 minutes' RETURNING job`;
      if (stale.length === 0) return; // held by a live concurrent invocation
    }
    locked = true;

    let row = null, isBrief = false;
    if (WNBA_SS_NARRATE_V2) {
      const r = await sql`SELECT * FROM sweetspot_alerts
        WHERE league = ${'wnba'} AND alert_subtype IN ('EFG_FADE', 'EFG_FADE_SOFT')
          AND ntfy_sent = true AND narration_text IS NULL AND COALESCE(narration_attempts, 0) < 3
        ORDER BY id ASC LIMIT 1`;
      row = r[0] || null;
    }
    // D-12: WATCHLIST reviews claim only when no A/B fire is pending (A/B narration
    // latency unchanged). 2h recency window — a flag turn-on must never drain the
    // season's stale WATCHLIST rows one push per cycle. SS_FORCE_TEST rows excluded
    // (forced mode-5 tests would otherwise auto-narrate + push within the window).
    if (!row && WNBA_SS_NARRATE_V2 && WNBA_SS_NARRATE_WATCHLIST) {
      const r = await sql`SELECT * FROM sweetspot_alerts
        WHERE league = ${'wnba'} AND alert_subtype = ${'WATCHLIST'}
          AND ntfy_sent = true AND narration_text IS NULL AND COALESCE(narration_attempts, 0) < 3
          AND created_at > NOW() - INTERVAL '2 hours' AND game_id <> ${'SS_FORCE_TEST'}
        ORDER BY id ASC LIMIT 1`;
      row = r[0] || null;
    }
    if (!row && WNBA_GAME_BRIEF_ON) {
      const r = await sql`SELECT * FROM sweetspot_alerts
        WHERE league = ${'wnba'} AND alert_subtype = ${'GAME_BRIEF'}
          AND narration_text IS NULL AND COALESCE(narration_attempts, 0) < 3
        ORDER BY id ASC LIMIT 1`;
      row = r[0] || null; isBrief = row != null;
    }
    if (!row) return;

    // D-13 (Jul 30): ordering guards for the watchlist-then-A/B upgrade path (IND@POR
    // rows 1017/1020 inversion — stale review pushed after the A).
    // Fix A — a WATCHLIST review is stale once a same-game A/B fire has pushed:
    // narrate quiet (sheet/BRIEFING keep the review text), never push a lower-tier
    // cue after a higher-tier call.
    // Fix B (sweep side) — A/B narrations that upgraded a delivered WATCHLIST open
    // with the escalation breadcrumb so the WHY push carries the lineage too.
    let quietWatch = false, escLine = '';
    try {
      if (row.alert_subtype === 'WATCHLIST') {
        const sup = await sql`SELECT id FROM sweetspot_alerts WHERE game_id = ${row.game_id}
          AND league = ${'wnba'} AND alert_subtype IN ('EFG_FADE', 'EFG_FADE_SOFT')
          AND ntfy_sent = true LIMIT 1`;
        quietWatch = sup.length > 0;
      } else if (row.alert_subtype === 'EFG_FADE' || row.alert_subtype === 'EFG_FADE_SOFT') {
        const w = await sql`SELECT period, clock FROM sweetspot_alerts WHERE game_id = ${row.game_id}
          AND league = ${'wnba'} AND alert_subtype = ${'WATCHLIST'} AND id < ${row.id}
          AND ntfy_sent = true ORDER BY id DESC LIMIT 1`;
        if (w.length) escLine = `Escalated from watchlist (fired Q${w[0].period}${w[0].clock ? ' ' + w[0].clock : ''}).\n\n`;
      }
    } catch (e) { /* non-fatal — narration proceeds without ordering guards */ }

    const attempts = Number(row.narration_attempts) || 0;
    const model = attempts >= 2 ? 'claude-opus-4-8' : 'claude-fable-5';
    const remaining = SS_NARRATE_BUDGET_MS + 60000 - (Date.now() - startTime); // hard function ceiling guard
    const timeoutMs = Math.max(10000, Math.min(SS_NARRATE_TIMEOUT_MS, remaining - 5000));

    const { blocks, hA, aA } = await ssGatherNarrationBlocks(sql, row);
    let prompt, title, priority;
    const quietRow = isBrief && !Number(row.period);   // pregame-seeded skeleton (Jul 15): narrate with no push
    if (isBrief) {
      const liveLine = row.period ? `currently Q${row.period} ${row.clock || ''}` : '';
      const reason = row.period ? undefined : 'the game has not tipped yet \u2014 this is the pregame season lens';
      prompt = ssBuildBriefPrompt(hA || '?', aA || '?', { teamCtx: blocks.teamCtx, liveLine, reason });
      title = `GAME BRIEF ${aA || '?'} at ${hA || '?'}`;
      priority = 2;
    } else if (row.alert_subtype === 'WATCHLIST') {
      // D-12 review — priority matches the mechanical cue (2), never the fade's 4.
      // "vs" not "at": leader/trailer anchors are not home/away (row-anchoring lesson).
      prompt = ssBuildWatchlistPrompt(row, blocks);
      title = `WATCHLIST review - ${row.trailer_alias} vs ${row.leader_alias}`;
      priority = 2;
    } else {
      prompt = ssBuildNarrationPrompt(row, blocks);
      title = `SWEET SPOT - why ${row.trailer_alias}`;
      priority = 4;
    }

    const res = await ssCallNarration(prompt, model, timeoutMs);
    if (res.ok) {
      const finalText = escLine + res.text;
      await sql`UPDATE sweetspot_alerts SET narration_text = ${finalText}, narration_attempts = ${attempts + 1}, ntfy_sent = true WHERE id = ${row.id}`;
      if (!quietRow && !quietWatch) await sendNtfy(title, finalText, priority, SS_DASH_URL);
      log(`narration sweep: ${isBrief ? 'brief' : row.alert_subtype} row ${row.id} delivered via ${model} (${finalText.length} chars, attempt ${attempts + 1})${quietRow ? ' quiet' : (quietWatch ? ' quiet-superseded' : '')}${escLine ? ' +esc' : ''}`);
    } else {
      await sql`UPDATE sweetspot_alerts SET narration_attempts = ${attempts + 1} WHERE id = ${row.id}`;
      log(`narration sweep: row ${row.id} attempt ${attempts + 1} failed via ${model} — ${res.error}`);
    }
  } catch (e) {
    log(`narration sweep fatal (non-blocking): ${e.message}`);
  } finally {
    if (locked) { try { await sql`DELETE FROM job_locks WHERE job = ${'ss-narration'}`; } catch (e) { /* stale takeover covers */ } }
  }
}

// ── ALERT REASONING AGENT ────────────────────────────────────────────────

// ── TEAM CONTEXT (TEAM_PROFILES_SPEC §6) — season identity/tier/form/H2H priors ──
// Ships DARK (default off). Set env TEAM_CTX_ON=1 to inject into agent prompts,
// auto-analysis prompts, and mechanical SS push bodies. WNBA-only v1.
// Loaded once per invocation via isolated SELECT (critical-path rule — never added
// to existing SELECTs). composeTeamContext/composeTeamCtxLine degrade to '' when
// the flag is off, the map is unloaded, the league mismatches, or rows are missing.
const TEAM_CTX_ON = process.env.TEAM_CTX_ON === '1';
var _teamCtxMap = null;   // alias -> profile row (var: TDZ learning #6)
var _teamCtxLoadedAt = 0; // warm-container TTL companion — nightly recompute must propagate without a redeploy
const TEAM_CTX_TTL_MS = 15 * 60 * 1000;

async function ensureTeamCtx(sql, league) {
  if (!TEAM_CTX_ON || league !== 'wnba') return;
  // Only trust a NON-EMPTY map inside TTL. Jul 14 WSH@TOR bug: a warm container whose
  // first load ran mid-backfill cached {} (truthy) for its whole life and served the
  // entire game ctx-less via the silent both-rows-missing degradation path.
  // Rules: never cache empty; never cache without expiry; on failed/empty reload keep
  // the last good map (stale-good beats none) and retry next cycle.
  if (_teamCtxMap && Object.keys(_teamCtxMap).length > 0 && (Date.now() - _teamCtxLoadedAt) < TEAM_CTX_TTL_MS) return;
  try {
    const rows = await sql`SELECT team_alias, league, season, w, l, archetype, profile, updated_at
      FROM team_profiles WHERE league = ${'wnba'} AND season = ${2026}`;
    const next = {};
    for (const r of rows) {
      let prof = r.profile;
      if (typeof prof === 'string') { try { prof = JSON.parse(prof); } catch (e) { prof = null; } }
      if (prof) next[r.team_alias] = { w: r.w, l: r.l, archetype: r.archetype, profile: prof, updated_at: r.updated_at, league: r.league };
    }
    if (Object.keys(next).length > 0) {
      _teamCtxMap = next;
      _teamCtxLoadedAt = Date.now();
      log(`teamCtx: loaded ${Object.keys(next).length} wnba profiles`);
    } else {
      log(`teamCtx: load returned 0 usable rows — keeping previous map, retry next cycle`);
    }
  } catch (e) { log(`teamCtx load failed — keeping previous map, retry next cycle: ${e.message}`); }
}

// Full factual block for Opus prompts (agent + auto-analysis). ~150-220 tokens.
// Underlying numbers always included so a wrong archetype label can't mislead (§5).
function composeTeamContext(hA, aA, league, map = _teamCtxMap) {
  if (!TEAM_CTX_ON || league !== 'wnba' || !map || !hA || !aA) return '';
  const fmt = (alias, oppAlias) => {
    const t = map[alias];
    if (!t) return null;   // degradation: missing row -> omit team line
    // KILLER_FLAG_SPEC §8: consumer-facing splits use tiers_elite (hysteresis definition).
    // def-A `tiers` is internal-only (lane/registration) — never shown to agents. Falls back
    // to def-A tiers only for pre-migration profile rows (one nightly behind).
    const i = t.profile.identity || {}, tr = t.profile.tiers_elite || t.profile.tiers || {}, f5 = (t.profile.form || {}).l5;
    const sp = (v) => v == null ? '?' : (v > 0 ? '+' : '') + v;
    let s = `${alias} ${t.w}-${t.l} ${t.archetype} — eFG diff ${sp(i.efg_diff)}pp, TO margin ${sp(i.to_margin)}, FTA ${sp(i.fta_diff)}, OREB ${sp(i.oreb_diff)}`;
    if (tr.top && ((tr.top.w || 0) + (tr.top.l || 0)) > 0) s += ` | vs elite ${tr.top.w}-${tr.top.l} (eFG ${sp(tr.top.efg_diff)}pp), vs rest ${tr.rest.w}-${tr.rest.l}`;
    if (tr.insufficient) s += ` [tier splits small-n]`;
    if (f5) {
      s += ` | L5 ${f5.w}-${f5.l}, own eFG ${sp(f5.own_efg_delta)}pp, opp eFG ${sp(f5.opp_efg_delta)}pp`;
      const tags = [f5.own_tag, f5.opp_tag].filter(Boolean);
      if (tags.length) s += ` [${tags.join(', ')}]`;
    }
    const h = (t.profile.h2h || {})[oppAlias];
    if (h) s += ` | H2H vs ${oppAlias}: ${h.w}-${h.l} (avg ${sp(h.avg_margin)})`;
    const sch = t.profile.schedule || {};
    if (sch.last_game_date) s += ` | last game ${sch.last_game_date}${sch.road_streak > 1 ? ', road streak ' + sch.road_streak : ''}`;
    return s;
  };
  const lines = [fmt(hA, aA), fmt(aA, hA)].filter(Boolean);
  if (lines.length === 0) return '';   // degradation: both missing -> omit block
  let block = `\nTEAM CONTEXT (season priors — context only, small-n: treat splits as direction, not probabilities; TO margin: + = forces more turnovers than it commits; elite = reached .600 with 15+ games, demoted below .550, re-admitted at .600):\n${lines.join('\n')}\n`;
  const anyRow = map[hA] || map[aA];
  if (anyRow && anyRow.updated_at && (Date.now() - new Date(anyRow.updated_at).getTime()) > 36 * 3600 * 1000) {
    block += `(profiles >36h stale — nightly refresh may have missed; weight accordingly)\n`;
  }
  return block;
}

// ONE plain-English line for mechanical push bodies (settled D2) — no jargon,
// subscriber-facing. Leads with the trailer (the buy side).
function composeTeamCtxLine(trailerAl, leaderAl, league, map = _teamCtxMap) {
  if (!TEAM_CTX_ON || league !== 'wnba' || !map) return '';
  const PHRASE = {
    DUAL_EDGE: 'wins on both shot-making and ball control',
    SHOTMAKER: 'wins on shot-making',
    POSSESSION_BULLY: 'wins on extra possessions, not shooting',
    POSSESSION_LEAN: 'leans on ball control',
    SHOT_DEFICIT: 'gets outshot most nights',
    FLAT: 'has no clear identity edge',
  };
  const part = (alias) => {
    const t = map[alias];
    if (!t) return null;
    const tr = (t.profile.tiers || {}).top;
    let s = `${alias} ${PHRASE[t.archetype] || 'has no clear identity edge'}`;
    if (tr && tr.n > 0) s += ` and is ${tr.w}-${tr.l} vs winning teams`;
    const f5 = (t.profile.form || {}).l5;
    if (f5 && f5.own_tag === 'COLD') s += ` (shooting cold lately)`;
    if (f5 && f5.own_tag === 'HOT') s += ` (shooting hot lately)`;
    return s;
  };
  const tPart = part(trailerAl), lPart = part(leaderAl);
  if (!tPart && !lPart) return '';
  return `Season lens: ${[tPart, lPart].filter(Boolean).join('; ')}.`;
}


// ── V2 AGENT PROMPT (validated 41/41 across 6 games) ──────────────────────
// Used by v2 BWC lifecycle + BUY triggers. At cutover (Step 7), runAlertAgent
// switches from v1 prompt to this. Until then, v1 path uses v1 prompt below.
function buildV2AgentPrompt(ctx) {
  // Build structural stress section (rolling window, combined read, gap acceleration, per-quarter data)
  // Same format as formatSonnetPrompt so agent sees identical data layers as auto-analysis
  let stress = '';
  const rw = ctx.windowData;
  if (rw && rw.available) {
    const wLabel = rw.windowQuarters ? rw.windowQuarters.join('+') : '?';
    stress += `STRUCTURAL STRESS (rolling window vs cumulative — does the recent game agree with the floor?):\n`;
    stress += `Window (${wLabel}, ${rw.windowPossessions || '?'} poss): ${rw.controlTeam} ${rw.score != null ? rw.score.toFixed(2) : '?'}\n`;
    ['I1','I2','I3','I4','I5'].forEach(k => {
      const i = rw[k];
      if (i && i.score != null) {
        // Flip to ctrl-relative (window scores are home-relative like computeServer)
        const ctrlScore = ctx.ctrlIsHome ? i.score : 1 - i.score;
        stress += `  ${k}: ${ctrlScore.toFixed(1)} — ${i.detail || ''}\n`;
      }
    });
    stress += `Data quality: ${rw.dataQuality || '?'}\n`;
  } else {
    stress += `STRUCTURAL STRESS: Window not yet available\n`;
  }
  // Combined read
  if (ctx.combinedRead && ctx.combinedRead.read) {
    stress += `Combined read: ${ctx.combinedRead.read} — ${ctx.combinedRead.note || ''}\n`;
  }
  // Warning for COLLAPSING/FLIPPED
  if (ctx.combinedRead && (ctx.combinedRead.read === 'COLLAPSING' || ctx.combinedRead.read === 'FLIPPED')) {
    const wCtrl = rw ? rw.controlTeam || '?' : '?';
    stress += `WARNING: Rolling window DISAGREES with cumulative floor. Recent quarters favor ${wCtrl}. Cumulative indicators may be anchored from earlier quarters that no longer reflect game state.\n`;
  }
  // Gap acceleration with history (same format as formatSonnetPrompt)
  if (ctx.accelData && ctx.accelData.entries && ctx.accelData.entries.length > 0) {
    const acc = ctx.accelData;
    const last = acc.entries[acc.entries.length - 1];
    stress += `Gap: ${last.gap >= 0 ? '+' : ''}${last.gap != null ? last.gap.toFixed(3) : '?'} | Acceleration: ${acc.accel} (${acc.consecutive} consecutive)\n`;
    stress += `History: ${acc.entries.slice(-5).map(e => (e.gap >= 0 ? '+' : '') + (e.gap != null ? e.gap.toFixed(2) : '?') + ' (' + e.score + ')').join(' -> ')}\n`;
  } else if (ctx.accelData) {
    stress += `Acceleration: ${ctx.accelData.accel || 'TOO EARLY'}\n`;
  }
  // Per-quarter breakdown (same format as formatSonnetPrompt lines 3161-3169)
  if (ctx.quarterDiffs && Object.keys(ctx.quarterDiffs).length > 0) {
    stress += `Per-quarter breakdown:\n`;
    const qdKeys = Object.keys(ctx.quarterDiffs).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
    for (const qk of qdKeys) {
      const d = ctx.quarterDiffs[qk];
      if (!d || !d.home || !d.away) continue;
      const h = d.home, a = d.away;
      const hPaint = h.points_in_the_paint || h.points_in_paint || 0;
      const aPaint = a.points_in_the_paint || a.points_in_paint || 0;
      stress += '  Q' + qk + ' (' + ctx.homeAlias + ' vs ' + ctx.awayAlias + '):'
        + ' Paint ' + ctx.homeAlias + ':' + hPaint + ' ' + ctx.awayAlias + ':' + aPaint
        + ' | FT ' + ctx.homeAlias + ':' + (h.free_throws_made||0) + '/' + (h.free_throws_att||0) + ' ' + ctx.awayAlias + ':' + (a.free_throws_made||0) + '/' + (a.free_throws_att||0)
        + ' | 3P ' + ctx.homeAlias + ':' + (h.three_points_made||0) + '/' + (h.three_points_att||0) + ' ' + ctx.awayAlias + ':' + (a.three_points_made||0) + '/' + (a.three_points_att||0)
        + ' | AST ' + ctx.homeAlias + ':' + (h.assists||0) + ' ' + ctx.awayAlias + ':' + (a.assists||0)
        + ' | TO ' + ctx.homeAlias + ':' + (h.turnovers||h.total_turnovers||0) + ' ' + ctx.awayAlias + ':' + (a.turnovers||a.total_turnovers||0)
        + ' | STL ' + ctx.homeAlias + ':' + (h.steals||0) + ' ' + ctx.awayAlias + ':' + (a.steals||0)
        + (h.possessions ? ' | Poss ' + ctx.homeAlias + ':' + (h.possessions||0) + ' ' + ctx.awayAlias + ':' + (a.possessions||0) : '')
        + '\n';
    }
  }

  // MF trajectory string for prompt sections
  const mfTraj = ctx.mfTrajectory;
  const mfTrajStr = mfTraj
    ? `MF ${mfTraj.direction} (${mfTraj.floors.map(f => f.toFixed(2)).join(' -> ')})${mfTraj.direction !== 'INSUFFICIENT' ? ' delta=' + (mfTraj.delta > 0 ? '+' : '') + mfTraj.delta.toFixed(3) : ''}`
    : 'No trajectory data';

  return `You are a live NBA betting alert quality agent. A mechanical system has identified a potential betting signal. Your job is to assess whether it should be sent to the bettor.

ALERT:
Type: ${ctx.alertType} (${ctx.alertTier || 'FIRED'})
Control team: ${ctx.ctrlTeam} | Floor: ${ctx.floor} | Margin: ${ctx.margin} (${ctx.margin < 0 ? 'trailing' : ctx.margin > 0 ? 'leading' : 'tied'})
Score: ${ctx.awayAlias} ${ctx.awayPts} - ${ctx.homeAlias} ${ctx.homePts} (${ctx.ctrlTeam} is ${ctx.ctrlIsHome ? 'HOME' : 'AWAY'})
Period: Q${ctx.period} ${ctx.clock}
${ctx.bwcTeam ? 'BWC team (subscriber position): ' + ctx.bwcTeam + (ctx.bwcTeam !== ctx.ctrlTeam ? ' (NOT current ctrl team — ctrl flipped to ' + ctx.ctrlTeam + ')' : '') : ''}
${ctx.isFlipBuy ? `
FLIP BUY CONTEXT:
An EXIT alert was SENT for ${ctx.flipBuyContext.exitTeam} at Q${ctx.flipBuyContext.exitPeriod} ${ctx.flipBuyContext.exitClock} (floor was ${ctx.flipBuyContext.exitFloor?.toFixed(2) || '?'}, margin ${ctx.flipBuyContext.exitMargin || '?'}).
The structural edge has been confirmed as flipped — this BUY is NOT counter-betting. It is an independent structural signal on the team that took control away from the original position.
The EXIT + BUY firing simultaneously is TWO independent signals corroborating the same structural reversal.
Evaluate ${ctx.ctrlTeam}'s structural case on its own merit. The position gate is LIFTED — the subscriber was already told to exit ${ctx.flipBuyContext.exitTeam}.` : ''}

INDICATORS (control-team-relative):
I1 Disruption: ${ctx.i1} | I2 Interior: ${ctx.i2} | I3 Shot Quality: ${ctx.i3} | I4 Game Control: ${ctx.i4} | I5 Execution: ${ctx.i5}
Indicators won: ${ctx.ctrlIndicators} (${ctx.ctrlIndicatorCount}/5)
Ctrl sust: ${ctx.ctrlSust || 'N/A'} | Opp sust: ${ctx.oppSust || 'N/A'}
TP: ${ctx.tpClass || 'N/A'} | LS: ${ctx.lsClass || 'N/A'}

OPPONENT PROFILE:
Opponent indicators won: ${ctx.oppIndicatorCount} (${ctx.oppIndicatorsWon})
${ctx.oppI3Won ? 'Opponent I3 (shot quality) won — EXPECTED variance, not structural. Does NOT invalidate buy thesis.' : ''}
${ctx.oppIndicatorCount >= 1 && !ctx.oppI3Won ? 'WARNING: Opponent structural counter-indicators (' + ctx.oppIndicatorsWon + '), not just variance.' : ''}
${composeTeamContext(ctx.homeAlias, ctx.awayAlias, ctx.league)}
FLOOR RELIABILITY (from 1,235-game backtest):
${ctx.ctrlTeam} classified: ${ctx.reliabilityClass || 'NEUTRAL'} | Grip: ${ctx.floorGrip != null ? (ctx.floorGrip > 0 ? '+' : '') + ctx.floorGrip : 'N/A'}
${ctx.floorWPHistorical != null ? 'Historical close-game win rate at floor ' + ctx.floor + ': ' + ctx.floorWPHistorical + '% (vs ~70% population avg at this level)' : 'No historical floor WP data for this team/level'}
${ctx.reliabilityClass === 'WEAK' || ctx.reliabilityClass === 'BROKEN' ? 'WARNING: This team\'s floor reads historically overstate structural edge in close games. A ' + ctx.floor + ' floor for ' + ctx.ctrlTeam + ' converts at ' + (ctx.floorWPHistorical || '?') + '%, well below league average. Apply elevated scrutiny — require strong indicator confirmation (I1+I2 or I4) beyond floor score alone.' : ''}${ctx.reliabilityClass === 'ELITE' ? 'This team\'s floor reads are highly reliable — floor score closely tracks actual win probability in close games.' : ''}

POSITION HEALTH:
Peak floor: ${ctx.peakFloor != null ? Number(ctx.peakFloor).toFixed(2) : 'N/A'} | Mean floor: ${ctx.meanFloor != null ? Number(ctx.meanFloor).toFixed(3) : 'N/A'} | Current: ${ctx.floor}
Erosion: ${ctx.erosionLevel} (${ctx.alertType === 'POSITION_OPEN' ? 'peak-anchored' : 'mean-anchored'})${ctx.peakErosionLevel && ctx.peakErosionLevel !== ctx.erosionLevel ? ' | Peak erosion: ' + ctx.peakErosionLevel + ' (reference only)' : ''}
${ctx.convictionTrend && ctx.convictionTrend.trend !== 'INSUFFICIENT' ? 'Conviction trend: ' + ctx.convictionTrend.trend + ' (' + ctx.convictionTrend.tiers.join(' \u2192 ') + (ctx.convictionTrend.degradePoint ? ', dropped at ' + ctx.convictionTrend.degradePoint : '') + ')' : ''}
${ctx.fullCPTrend && ctx.fullCPTrend.direction !== 'INSUFFICIENT' ? 'CP trend (all, unfiltered): ' + ctx.fullCPTrend.direction + ' (' + ctx.fullCPTrend.floors.map(f => f.toFixed(2)).join(' \u2192 ') + ') delta=' + (ctx.fullCPTrend.delta > 0 ? '+' : '') + ctx.fullCPTrend.delta.toFixed(3) : ''}
Consecutive holds: ${ctx.consecutiveHolds}
BWC lifecycle: ${ctx.bwcState}${ctx.bwcFirePeriod ? ' (BWC fired Q' + ctx.bwcFirePeriod + ', floor ' + (ctx.bwcFireFloor != null ? Number(ctx.bwcFireFloor).toFixed(2) : '?') + ')' : ''}
${ctx.positionClosed ? 'POSITION STATE: CLOSED — an EXIT was previously SENT. The subscriber was told to exit this position. Any SEND decision on a recovery alert (POSITION_OPEN, POSITION_SAFE, POSITION_RECOVERING, THESIS_ALIVE) will RE-OPEN the position. This requires ELEVATED SCRUTINY — the thesis previously failed. See POST-EXIT RE-ENTRY rules on each alert type below.' : ''}
${ctx.buyPosition ? 'ACTIVE BUY POSITION: ' + ctx.buyPosition.team + ' entered at Q' + ctx.buyPosition.period + ' ' + (ctx.buyPosition.clock || '') + ' (' + (ctx.buyPosition.warm ? 'WARM — position tracking active, compound signals support thesis' : 'COLD — spot read, no tracking context') + '). XGB at entry: ' + (ctx.buyPosition.xgb != null ? (ctx.buyPosition.xgb * 100).toFixed(0) + '%' : '?') + '. BUY positions exit via XGB INVALIDATED, NOT V2 EXIT. If this team confirms through compound threshold, PO fires independently as confirmation.' : ''}
${ctx.compoundTier === 'CONFIRMED' || ctx.compoundTier === 'RECOVERING' || ctx.compoundTier === 'LOCKED'
  ? 'Position: ' + ctx.compoundTier + ' (' + ctx.compoundHolds + ' compound holds, ' + ctx.compoundPath + ' path)'
    + ' | MC Cum at confirmation: ' + (ctx.mcCumAtConfirmation != null ? (ctx.mcCumAtConfirmation * 100).toFixed(1) + '%' : '?')
    + ' | Prior flips: ' + (ctx.priorFlips || 0)
    + ' | Control flips (game total): ' + ctx.ctrlFlips
    + ' | Lane: ' + (ctx.lane || 'unknown') + ' (pregame ML ' + (ctx.pregameML || '?') + ')'
  : 'Pre-confirmation (' + (ctx.compoundHolds || 0) + ' compound holds toward threshold)'
    + ' | Control flips: ' + ctx.ctrlFlips
    + ' | Lane: ' + (ctx.lane || 'unknown') + ' (pregame ML ' + (ctx.pregameML || '?') + ')'
}
${mfTrajStr}

${stress}
STRUCTURE-SCORE RELATIONSHIP:
${ctx.floorMarginSignal && ctx.floorMarginSignal.signal !== 'INSUFFICIENT'
  ? 'Floor trend: ' + ctx.floorMarginSignal.floorTrend + ' | Margin trend: ' + ctx.floorMarginSignal.marginTrend + ' | Signal: ' + ctx.floorMarginSignal.signal
    + (ctx.floorMarginSignal.signal === 'DIVERGING_POSITIVE' ? '\nFloor is declining but scoreboard margin is growing \u2014 structural floor may be stale from cumulative anchoring. Do NOT use erosion as primary suppression signal.' : '')
    + (ctx.floorMarginSignal.signal === 'CONVERGING_DOWN' ? '\nBoth structure and scoreboard declining \u2014 genuine structural decay. Erosion signal is trustworthy.' : '')
    + (ctx.floorMarginSignal.signal === 'DIVERGING_NEGATIVE' ? '\nFloor is rising but margin is shrinking \u2014 structure improving but not translating to scoreboard.' : '')
  : 'Insufficient checkpoint data for floor-margin analysis'}
${ctx.xgbWinProb != null ? `\nXGBOOST STRUCTURAL MODEL (independent — trained on raw stats, does NOT use floor/indicators/margin):
XGB win probability: ${(ctx.xgbWinProb * 100).toFixed(1)}% | MC Cum: ${ctx.mcCumWp != null ? (ctx.mcCumWp * 100).toFixed(1) + '%' : '?'} | Floor: ${(ctx.floor * 100).toFixed(1)}% | ${ctx.xgbAligned ? 'ALIGNED' : '⚠️ DIVERGENT (' + (ctx.xgbDivergence > 0 ? '+' : '') + (ctx.xgbDivergence * 100).toFixed(1) + '%)'}
${ctx.xgbShap ? 'SHAP drivers (what raw stats push XGB prediction): ' + ctx.xgbShap.map(s => s.f + '=' + (s.v > 0 ? '+' : '') + s.v.toFixed(2)).join(', ') : ''}
${ctx.convictionQuality ? 'XGB CONVICTION QUALITY:\nBasis: ' + ctx.convictionQuality.basis + ' — ' + Math.round(ctx.convictionQuality.strConcentration * 100) + '% structural / ' + Math.round(ctx.convictionQuality.volConcentration * 100) + '% volatile\nTop driver: ' + ctx.convictionQuality.top1Feature + ' (' + Math.round(ctx.convictionQuality.top1Share * 100) + '% of positive SHAP)' + (ctx.convictionQuality.top1IsVolatile ? ' [VOLATILE]' : '') + '\nScoreboard: ' + (ctx.convictionQuality.bigleadAnchored ? 'CONFIRMED — biglead driving ' + Math.round(ctx.convictionQuality.bigleadShare * 100) + '% (95% win rate in backtest)' : ctx.convictionQuality.noScoreboardConfirmation ? 'NOT CONFIRMED — biglead SHAP flat/negative, stats not translating to lead (19% loss rate vs 5%)' : 'PARTIAL — biglead contributing ' + Math.round(ctx.convictionQuality.bigleadShare * 100) + '%') : ''}
${ctx.trajectorySignals && ctx.trajectorySignals.warnings.length > 0 ? 'CONVICTION WARNINGS:\n' + ctx.trajectorySignals.warnings.join('\n') : ''}` : ''}
${ctx.failureProfile ? '⚠️ FAILURE PROFILE [STRUCT]: Floor reads ' + (ctx.floor * 100).toFixed(0) + '% but MC Cum ' + (ctx.mcCumWp != null ? (ctx.mcCumWp * 100).toFixed(0) + '%' : '?') + ' AND XGB ' + (ctx.xgbWinProb != null ? (ctx.xgbWinProb * 100).toFixed(0) + '%' : '?') + ' BOTH disagree with the floor. When both models disagree with floor, floor is the one that is wrong — genuine structural erosion, not margin pressure.\nFor BUY/BWC: this is a real suppress lean — both models, not one. For POSITION_OPEN: note elevated risk in body.' : ''}
${ctx.mcOnlyFailure && (ctx.alertType === 'BUY' || ctx.alertType === 'VALUE') ? 'BUY SETUP [STRUCT]: Floor + XGB agree the structure is sound, but MC Cum reads ' + (ctx.mcCumWp * 100).toFixed(0) + '% — low because the ctrl team is TRAILING (MC projects from a deficit environment). This is the DFT setup, NOT a failure profile: a structurally dominant team that is trailing. Low MC here is EXPECTED and is NOT by itself a reason to suppress. See the BUY EV frame below — decide on the full structural picture, not on MC magnitude.' : ''}
${ctx.alertType === 'BUY' && ctx.xgbWinProb != null ? (ctx.league === 'wnba' ? `══ BUY — ${ctx.ctrlTeam} is TRAILING. READ BEFORE CONSIDERING SUPPRESS. ══
A BUY is a PLUS-MONEY STRUCTURAL play; its value is in the PRICE, not the binary outcome. The market prices a trailing team off the scoreboard, so a structurally dominant team that is trailing is MISPRICED — true win prob exceeds the deficit-inflated moneyline. That gap is the edge.
A LOW WIN RATE IS EXPECTED HERE AND IS NOT, BY ITSELF, A REASON TO SUPPRESS. ~40% at +160 is profitable. BUYs are among the most profitable signals in the system precisely because they win <50% at prices that overpay for the deficit. Suppressing a structurally valid BUY because the win rate "looks like a coin flip" destroys the edge the product exists to capture.
SUPPRESS a BUY ONLY when ONE is clearly true:
  1. [OP] Mechanical gate breached (the system auto-suppresses): Q4 XGB < 0.55, Q1-Q3 XGB < 0.45.
  2. [STRUCT] STRUCTURAL DEATH: lost I3 (the 30% WNBA anchor) AND opponent edge is structural not variance (opp controls perimeter/FT, opp I2). Both, not one.
  3. Deep + late: trailing 10+ in Q4 where the deficit, not the structure, is the binding constraint.
In EVERY other case the DEFAULT is SEND with calibrated framing. Uncertainty is the NORMAL state of a good BUY. Surface the mispricing honestly (deficit, structural case, plus-money thesis entered on PRICE) — do not predict the winner.
STRUCTURAL CASE [STRUCT] (framing + the rare suppress, never magnitudes):
  Deficit: shallow (1-4) is the sweet spot; mid (5-9) live; deep (10+) needs an exceptional case.
  Anchor: I2+I3 (perimeter/FT + shot quality) is the WNBA BUY core; I1+I3 (disruption only) is a trap. Losing I3 is structural death in WNBA — the 30% anchor, NOT recoverable cold shooting. Do NOT import NBA's "cold shooting = buy the variance" logic.
  Opponent: opp controlling perimeter/FT (opp I2) blocks the comeback; opp disruption (opp I1) is survivable.
  A HIGH XGB while trailing is the strongest positive structural tell in this region — weight it.
  → This BUY: Q${ctx.period}, XGB ${(ctx.xgbWinProb * 100).toFixed(0)}%, floor ${(ctx.floor * 100).toFixed(0)}%, trailing ${Math.abs(ctx.margin)}.` : `══ BUY — ${ctx.ctrlTeam} is TRAILING. READ BEFORE CONSIDERING SUPPRESS. ══
A BUY is a PLUS-MONEY STRUCTURAL play; its value is in the PRICE, not the binary outcome. The market prices a trailing team off the scoreboard, so a structurally dominant team that is trailing is MISPRICED. That gap is the edge.
A LOW WIN RATE IS EXPECTED HERE AND IS NOT, BY ITSELF, A REASON TO SUPPRESS. ~40% at +160 is profitable. BUYs are among the most profitable signals in the system precisely because they win <50% at prices that overpay for the deficit. Suppressing a structurally valid BUY because the win rate "looks like a coin flip" destroys the edge.
SUPPRESS a BUY ONLY when ONE is clearly true:
  1. [OP] Mechanical gate breached (the system auto-suppresses): Q4 XGB < 0.60, Q3 XGB < 0.45, Q2 XGB < 0.40.
  2. [STRUCT] STRUCTURAL DEATH: lost the physical core (I1+I2) AND opponent edge is structural (opp I1/I2), not variance.
  3. Deep + late: trailing deep in Q4 where the deficit is the binding constraint.
In EVERY other case the DEFAULT is SEND with calibrated framing. Uncertainty is the NORMAL state of a good BUY. Surface the mispricing honestly — do not predict the winner.
STRUCTURAL CASE [STRUCT]:
  Deficit: 1-7 is the sweet spot; deeper needs a stronger case.
  Anchor: I1+I2 (physical dominance while trailing) is the NBA BUY core; I3+I4 is the worst pair. NBA I3-INVERSION is OPPOSITE WNBA: trailing BECAUSE of cold shooting (lost I3) is exactly the variance the thesis exploits — a BUY, not a death.
  Opponent: opp I1 (disruption) or opp I2 (paint) are structural threats; opp winning I3 only = variance, thesis intact.
  A HIGH XGB while trailing is the strongest positive structural tell — weight it most in Q4.
  → This BUY: Q${ctx.period}, XGB ${(ctx.xgbWinProb * 100).toFixed(0)}%, floor ${(ctx.floor * 100).toFixed(0)}%, trailing ${Math.abs(ctx.margin)}.`) : ''}
${ctx.alertType === 'XGB_INVALIDATED' ? (ctx.invTriggerSignal === 'mc_cum' ? `MC STRUCTURAL COLLAPSE:
  BUY fired at Q${ctx.xgbBuySendPeriod} with XGB ${(ctx.xgbBuySendProb * 100).toFixed(0)}%
  Current MC Cum: ${ctx.mcCumWinProb != null ? (ctx.mcCumWinProb * 100).toFixed(1) + '%' : '?'} — BELOW 30% structural viability threshold
  Current XGB: ${ctx.xgbWinProb != null ? (ctx.xgbWinProb * 100).toFixed(1) + '%' : '?'}
  The full-game possession rates no longer project a win. ALWAYS SEND — add narrative about which rates collapsed.` : `XGB THESIS COLLAPSE:
  BUY fired at Q${ctx.xgbBuySendPeriod} with XGB ${(ctx.xgbBuySendProb * 100).toFixed(0)}%
  Current XGB: ${(ctx.xgbWinProb * 100).toFixed(1)}% — BELOW Q${ctx.period} gate of ${(ctx.xgbQuarterGate * 100).toFixed(0)}%
  Drop: ${((ctx.xgbBuySendProb - ctx.xgbWinProb) * 100).toFixed(0)}pp
  The raw-stats model no longer sees a viable structural edge. ALWAYS SEND this alert — add narrative about what changed.`) : ''}
${ctx.mcInvestigation?.active ? `
MC STRUCTURAL INVESTIGATION${ctx.mcInvestigation.pattern ? ' — ' + ctx.mcInvestigation.pattern : ' (active)'}:
  Triggered Q${ctx.mcInvestigation.trigger_period} ${ctx.mcInvestigation.trigger_clock} when ${ctx.mcInvestigation.ctrl_team} led by ${ctx.mcInvestigation.trigger_margin}.
  Floor at trigger: ${ctx.mcInvestigation.trigger_floor?.toFixed(2)} | XGB at trigger: ${(ctx.mcInvestigation.trigger_xgb * 100).toFixed(0)}%
  Canary MC at trigger: ${(ctx.mcInvestigation.trigger_mc * 100).toFixed(1)}% (20-possession PBP window)
  Current MC win prob: ${ctx.mcInvestigation.current_mc != null ? (ctx.mcInvestigation.current_mc * 100).toFixed(1) + '%' : 'investigating'}
  Verdicts: ${ctx.mcInvestigation.verdicts?.join(' → ') || 'none yet'}
  Pattern: ${ctx.mcInvestigation.pattern || 'classifying...'}
  Prior investigations this game: ${ctx.mcInvestigation.prior_investigations || 0}` : ''}
${ctx.mcTrajectoryWp != null ? `
MC TRAJECTORY (always-on):
  MC PBP (20-poss window): ${(ctx.mcTrajectoryWp * 100).toFixed(1)}% | MC Cum (game-rate): ${ctx.mcCumWp != null ? (ctx.mcCumWp * 100).toFixed(1) + '%' : '?'} | Floor: ${(ctx.floor * 100).toFixed(1)}% | XGB: ${ctx.xgbWinProb != null ? (ctx.xgbWinProb * 100).toFixed(1) + '%' : '?'}
  ${Math.abs(ctx.mcTrajectoryWp - ctx.floor) > 0.15 ? 'DIVERGENCE: MC PBP and floor disagree by ' + Math.round(Math.abs(ctx.mcTrajectoryWp - ctx.floor) * 100) + 'pp — recent possession rates tell a different story than cumulative box score.' : 'ALIGNED: MC PBP and floor within 15pp.'}
  ${ctx.xgbMcClass === 'MC_LEADS' ? 'SIGNAL DIVERGENCE [STRUCT]: MC Cum (' + (ctx.mcCumWp * 100).toFixed(0) + '%) >> XGB (' + (ctx.xgbWinProb * 100).toFixed(0) + '%), gap ' + Math.round(Math.abs(ctx.xgbMcGap) * 100) + 'pp. MC LEADS — rates project a win structural features do not fully reflect. ' + (ctx.period >= 4 ? 'In Q4, when MC and XGB disagree, lean MC (the late-game disagreement order). Direction only — not a magnitude.' : 'Weigh MC, but XGB still carries structural weight pre-Q4.') : ctx.xgbMcClass === 'XGB_LEADS' ? 'SIGNAL DIVERGENCE [STRUCT]: XGB (' + (ctx.xgbWinProb * 100).toFixed(0) + '%) >> MC Cum (' + (ctx.mcCumWp * 100).toFixed(0) + '%), gap ' + Math.round(Math.abs(ctx.xgbMcGap) * 100) + 'pp. XGB LEADS — structural quality not yet in possession rates. ' + (ctx.period >= 4 ? 'In Q4 the order favors MC over XGB — treat a lone XGB lead with caution.' : 'XGB is credible pre-Q4 (Q2-Q3 order: XGB >= MC).') : ''}
  ${ctx.mcDrivers && ctx.mcDrivers.length > 0 ? 'MC RATE DRIVERS (what is driving ' + (ctx.bwcTeam || ctx.ctrlTeam) + ' win prob):\\n' + ctx.mcDrivers.filter(function(d) { return Math.abs(d.delta) >= 0.02; }).map(function(d) { return '    ' + d.label + ': ' + (d.delta >= 0 ? '+' : '') + Math.round(d.delta * 100) + 'pp (game ' + (d.ctrlVal * 100).toFixed(0) + '% vs season ' + (d.seasonVal * 100).toFixed(0) + '%)'; }).join('\\n') : ''}
  ${ctx.mcTrajectoryWp != null && ctx.mcCumWp != null && ctx.mcTrajectoryWp >= 0.65 && (ctx.mcTrajectoryWp - ctx.mcCumWp) >= 0.15 ? (function() { var _i1 = Number(ctx.i1 || 0), _i2 = Number(ctx.i2 || 0), _i3 = Number(ctx.i3 || 0); var _ss = (_i2 + _i3) / 2; var _dr = _ss >= 0.50 ? 'STRUCTURAL' : (_i1 >= 0.75 && _ss < 0.25 ? 'VOLATILE' : 'MIXED'); var _labels = { STRUCTURAL: 'Shooting + paint edge — 88% cascade rate from research.', VOLATILE: 'Turnover-driven heater — historically fades as TO rates regress.', MIXED: 'Mixed driver — watch for cumulative confirmation.' }; return 'PBP DIVERGENCE DRIVER: ' + _dr + ' (PBP ' + (ctx.mcTrajectoryWp * 100).toFixed(0) + '% vs MC Cum ' + (ctx.mcCumWp * 100).toFixed(0) + '%, gap +' + Math.round((ctx.mcTrajectoryWp - ctx.mcCumWp) * 100) + 'pp)\\n  ' + _labels[_dr] + '\\n  I1=' + _i1.toFixed(1) + ' I2=' + _i2.toFixed(1) + ' I3=' + _i3.toFixed(1) + (_dr === 'VOLATILE' ? ' — I1 dominant with weak I2+I3 = circumstantial edge.' : ''); })() : ''}` : ''}

${ctx.league === 'wnba' ? `SIGNAL TRUST HIERARCHY [tags: [PRIOR]=well-powered backtest/checkpoint-granularity — reason from it, do NOT quote as the subscriber's win prob; [STRUCT]=direction reliable, magnitude not. Backtest AUCs run higher than production (XGB ~0.81 backtest vs ~0.67 prod)]:
  Three signals with fundamentally different roles from NBA:
  - MC Cum: strongest single late-game signal in Q4. [PRIOR]
  - XGB: reads STRUCTURE, not wins — windowed box-score quality. High XGB while trailing is a positive structural read, not a promise. [PRIOR/STRUCT]
  - Floor: narrative context ONLY in WNBA. When floor disagrees with MC+XGB, floor is the one that is wrong. [STRUCT]
  When they DISAGREE [STRUCT] (direction, not magnitude):
  Q2: XGB ~ MC > Floor. Use either as early warning.
  Q3: XGB >= MC > Floor. Trust windowed structure.
  Q4: MC >= XGB > Floor. MC wins late disagreements; MC UNDERESTIMATES in WNBA Q4. [PRIOR] MC 0.7-0.8 runs ~89% actual, 0.8-0.9 ~93% — reason from it, do not quote.
  ALIGNED (MC+XGB both high): highest conviction when they agree. [PRIOR] (precise accuracy pending n-verification — do not quote a number).
  CRITICAL: Floor is NEVER a decision gate in WNBA.
  Floor HIGH + MC LOW + XGB LOW = both models disagree with floor -> genuine structural erosion. [STRUCT]
  Floor HIGH + MC LOW + XGB HIGH = the BUY setup: a structurally dominant team TRAILING. Low MC is EXPECTED from a deficit environment, not structural decay. NOT a failure profile, NOT automatically a suppress. Sparse region — see the BUY EV frame; decide on the full structural picture, not on MC magnitude. [STRUCT]
  MC+XGB HIGH + Floor LOW = compound is correct regardless of floor. [PRIOR]
  EXIT CONFIRMATION [STRUCT]: a low floor at EXIT confirms it; a high floor does NOT deny it (floor anchors stale data).
  TRAILING TEAM MC Cum: MC simulates forward using observed possession rates shaped by the current game state. Trailing teams produce different rate profiles (pressing, risk-taking, opponent protecting). Low MC for a trailing team reflects the deficit environment, not structural decay. When XGB confirms structural edge, weigh it. [STRUCT]
  When MC investigation active (CLEAN/WAVE): MC PBP > everything.` : `SIGNAL TRUST HIERARCHY [PRIOR — 14,440 checkpoint backtest, 1,233 games; reason from it, do NOT quote as the subscriber's win prob; production runs differently]:
  Four signals: Floor (cumulative indicators), XGB (2Q windowed structural model), MC PBP (20-possession canary), MC Cum (game-rate probability anchor).
  MC Cum is the best single probability signal. XGB 2Q is the best structural classifier. Floor anchors stale early-game data. [STRUCT roles]
  When they DISAGREE, which to trust depends on quarter [STRUCT — direction]:
  Q2: Floor ~ XGB > MC. MC overconfident early. Use MC as early warning only.
  Q3: MC Cum ~ XGB > Floor. MC calibration tightens. Floor starts anchoring.
  Q4: MC Cum > XGB > Floor. [PRIOR] MC 70-80% ~75% actual, MC>70% ~92% (backtest). Floor least reliable (cumulative anchoring at max).
  When all 3 agree high (MC+XGB+Floor): [PRIOR] Q4 ~96% accuracy (backtest) — reason from it, do not quote.
  EXIT CONFIRMATION [STRUCT]: a low MC Cum at EXIT confirms it; a high MC Cum reconsiders (MC anchors better than floor late).
  TRAILING TEAM MC Cum: MC simulates forward using observed possession rates shaped by the current game state. Trailing teams produce different rate profiles (pressing, risk-taking, opponent protecting). Low MC for a trailing team reflects the deficit environment, not structural decay. When XGB confirms structural edge, weigh it. [STRUCT]
  When MC investigation active (CLEAN/WAVE): MC PBP > everything, regardless of quarter.`}

FLOOR TRAJECTORY:
${ctx.floorHistory || 'No prior snapshots'}

PRIOR ALERT REASONING TRAIL:
${ctx.priorAlertTrail || 'None'}

RULES:
- TRACKING: First compound structural signal — ${ctx.league === 'wnba' ? 'MC Cum (≥0.80) AND XGB (≥0.60)' : 'MC Cum (≥0.80) AND indicator floor (≥0.65)'} both confirm ${ctx.ctrlTeam} as structurally dominant (floor ${ctx.floor}, margin ${ctx.margin}). This is a higher-confidence initial signal than historical first-fires. This is NOT yet a position recommendation — the subscriber learns a game is on the radar with strong structural evidence. ALWAYS SEND unless the game is clearly meaningless (garbage time, both teams eliminated, period 4 with < 2 min left). Body should explain: which team, what structural picture (indicators, floor, margin, MC confirmation), and that we are watching for sustained confirmation. Frame as: "Watching [TEAM] — [why they look structurally dominant]. Will update if this develops into a position." Keep it short — this is a heads-up, not a thesis.
- POSITION_OPEN: The team has sustained compound structural signals — ${ctx.league === 'wnba' ? 'MC Cum ≥ 0.80 AND XGB ≥ 0.60 (floor is narrative context, not a gate)' : 'MC Cum ≥ 0.80 AND Floor ≥ 0.65 at establishment, sustained at ≥ 0.60'} — for 5 consecutive polls (~2.5 minutes game clock). This is a significant structural confirmation.
  ${ctx.compoundTier === 'CONFIRMED' && ctx.compoundPath === 'Q2_EARLY'
    ? (ctx.league === 'wnba' ? 'Q2 EARLY CONFIRMATION [PRIOR ~89.6%, backtest — provenance pending verification; do not quote]: Compound sustained with lead ≥5 and zero prior control flips. Strong early signal in 40-minute format. ALWAYS SEND.' : 'Q2 EARLY CONFIRMATION [PRIOR ~95.5%, backtest]: Compound sustained with lead ≥5 and zero prior control flips. Strongest early signal — structural dominance established before halftime with scoreboard separation. ALWAYS SEND.')
    : ctx.compoundTier === 'CONFIRMED'
    ? (ctx.league === 'wnba' ? 'CONFIRMED [PRIOR ~85.7% overall, but ~81% at actionable margins (<=10) and ~77% in close games (<=8) — ~42% of confirmed games are blowouts that inflate the headline; the actionable figure is the honest one for a live position; backtest, do not quote as the subscriber\'s win prob], 0 prior flips: Structural position validated via MC+XGB compound. Floor is context — not decision-gated.' : 'CONFIRMED [PRIOR ~86% actionable, backtest], 0 prior flips: Structural position validated. Compound signals sustained without control being contested. Standard confidence — evaluate structural stress and current indicators.')
    : ctx.compoundTier === 'RECOVERING'
    ? (ctx.league === 'wnba' ? 'RECOVERING (' + (ctx.priorFlips || '1+') + ' prior flips): Position confirmed after control was contested. 40-minute games give less recovery runway — note lower confidence in body.' : 'RECOVERING (73% accuracy, ' + (ctx.priorFlips || '1+') + ' prior flips): Position confirmed after control was contested. Structural edge recovered but game is competitive. The compound held DESPITE flip history — this was earned through challenge. Note lower baseline accuracy in body. Check: are the indicators that slipped during flips back? Is conviction trend STABLE or DEGRADING?')
    : ctx.compoundTier === 'LOCKED'
    ? (ctx.league === 'wnba' ? 'LOCKED [PRIOR ~94.4% overall / ~88.5% at actionable margins, backtest — do not quote as the subscriber\'s win prob], 5+ sustained holds: Highest-confidence structural read. ALWAYS SEND.' : 'LOCKED [PRIOR ~92%, backtest], 10+ sustained holds: Highest-confidence structural read — compound signals sustained across extended evaluation. ALWAYS SEND.')
    : ''}
  ${ctx.isSecondBwc ? 'SECOND POSITION TEAM: ' + ctx.bwcTeam + ' took structural control away from ' + ctx.deadTeam + (ctx.deadHadPO ? ' (who had a confirmed position)' : ' (who was tracking but never confirmed)') + '. The reversal itself is evidence — ' + ctx.bwcTeam + ' earned this through merit after ' + ctx.deadTeam + ' collapsed. ALWAYS SEND.' : ''}
  ${ctx.bwcFlipped ? 'POSITION FLIP: The system originally tracked ' + ctx.originalBwcTeam + ' but they FAILED to confirm. ' + ctx.bwcTeam + ' then confirmed ' + ctx.compoundTier + ' — taking structural control away from a previously dominant team. The floor appears modest because cumulative stats are anchored by ' + ctx.originalBwcTeam + "'s early dominance, but " + ctx.bwcTeam + " is sustaining compound signals DESPITE that headwind. ALWAYS SEND." : ''}
  CLOSE GAME CONTEXT: ${ctx.league === 'wnba' ? 'Compound accuracy is ~70% in close games (margin ≤ 8). Shorter 40-minute format gives structural edges less time to express. Communicate honestly in body.' : 'Compound accuracy plateaus at 75% in close games (margin ≤ 8). This is the best close-game accuracy the system has ever produced (up from 51% at first fire, 69% with old graduation), but it is an edge, not a certainty. Communicate honestly in body.'}
  ${ctx.positionClosed ? 'POST-EXIT RE-ENTRY: Position was previously closed via EXIT. Compound has RESET — these 5 holds are FRESH post-EXIT readings, not carryover. ' + (ctx.league === 'wnba' ? 'Standard re-entry: MC Cum ≥ 0.80 + XGB ≥ 0.60, 5 holds.' : ctx.compoundPath === 'Q2_EARLY' ? 'Q2 re-entry requires lead ≥5 and 0 flips since EXIT.' : 'Standard re-entry threshold applies (MC Cum ≥ 0.80 + Floor ≥ 0.65 to re-establish, ≥ 0.60 to sustain, 5 holds).') + ' Verify via per-quarter breakdown that structural signals are genuinely post-EXIT, not cumulative anchoring. Reference the EXIT reasoning from PRIOR ALERT REASONING TRAIL — what specifically broke? Has it been fixed? If the same weaknesses persist, SUPPRESS regardless of compound confirmation.' : ''}
  MF trajectory provides additional context:
  - RISING MF = structural thesis building. Increases PO confidence.
  - DECLINING MF = floor eroding despite compound holding. MC Cum is more reliable than floor here, but flag as context and check per-quarter breakdown.
  Also check: Full CP trend (all, unfiltered) gives the trajectory including bad stretches. If MF says RISING but full CP trend says DECLINING, compound may overstate current control.
  This IS a position recommendation. Body should reference the tracking arc (if prior TRACKING alert), explain compound confirmation, current structural picture, and frame as: "Position open on [TEAM] — structural edge confirmed." Include odds/ML if available.
- VALUE: team PREVIOUSLY held a structural lead (BWC fired Q${ctx.bwcFirePeriod || '?'}) but lost it while retaining structural control. Thesis: "structural edge that built the lead is intact — dip is temporary, plus-money entry."
  EVALUATE WITH ALL SIGNALS — no single signal alone justifies suppression:
  1. Erosion (mean-anchored): STABLE/CAUTION = thesis intact. COLLAPSE = skepticism, but check signals 2-3.
  2. Floor-margin signal: DIVERGING_POSITIVE overrides COLLAPSE erosion — team is winning despite low floor, structure is stale from cumulative anchoring. CONVERGING_DOWN confirms COLLAPSE — genuine decay.
  3. Conviction trend: STABLE/HELD = structural core intact despite floor drop (cumulative indicators held). DEGRADING = real structural loss across checkpoints.
  SUPPRESS only when 2+ signals agree on decline: erosion COLLAPSE + floor-margin CONVERGING_DOWN, or erosion COLLAPSE + conviction DEGRADING, or floor-margin CONVERGING_DOWN + conviction DEGRADING. Single-signal COLLAPSE alone is NOT sufficient.
  Also verify: deficit depth (1-7 best), timing (Q2-Q3 > Q4). If prior BWC_EDGE alerts flagged a RISK, reference whether it materialized.
- THESIS_ALIVE: BWC team regained structural control AFTER an EXIT. This is a deep-value play — floor erosion is EXPECTED and is WHY plus-money exists. DO NOT treat floor level or erosion as primary factors. Weight hierarchy: (1) WHICH indicators does the BWC team still hold? I1 Disruption + I4 Game Control = structural core retained. (2) Is opponent's edge variance-based? oppI3Won=true means opponent is shooting well, not structurally dominant — this is the thesis. (3) TP path — STRONG RECOVERY or PROBABLE = mechanical path exists. (4) Deficit depth and timing. Floor being below BWC fire floor is the ENTRY SIGNAL, not a red flag. SUPPRESS only if: BWC team lost I1+I4 (structural core gone), OR opponent has non-I3 structural indicators (I1/I2/I4), OR TP is NO PATH/UNLIKELY with < 3 min left.
${ctx.positionClosed ? '  POST-EXIT THESIS_ALIVE: Position is CLOSED. The subscriber was told to EXIT, and now the BWC team has clawed back to VALUE state. This is a RE-ENTRY signal — if you SEND, you are telling them to re-open the position they were told to close. Apply the standard THESIS_ALIVE criteria above (I1+I4, TP path, opponent profile) AND verify via per-quarter breakdown that the structural recovery is happening in RECENT quarters, not just cumulative anchoring. Reference the EXIT reasoning from PRIOR ALERT REASONING TRAIL — what specifically broke? Has it been fixed?' : ''}
- EXIT: Structural position has deteriorated. Two independent signals agree the edge is gone:
  (1) Windowed XGB (2Q cross-fade) dropped below 0.45 — detects recent structural shifts faster than cumulative stats.
  (2) MC Cum dropped below 0.70 — confirms the shift is sustained across full-game rates, not just a brief window.
  ${ctx.exitSeverity?.windowedXgb != null ? 'Windowed XGB: ' + (ctx.exitSeverity.windowedXgb * 100).toFixed(1) + '% (threshold: 45%).' : ''} ${ctx.exitSeverity?.mcCumAtExit != null ? 'MC Cum: ' + (ctx.exitSeverity.mcCumAtExit * 100).toFixed(1) + '% (gate: 70%).' : ''} ${ctx.exitSeverity?.ctrlMatchesBWC === false ? 'NOTE: Structural control has ALSO flipped to ' + ctx.exitSeverity.ctrlTeam + ' — triple confirmation (XGB + MC + control flip).' : ctx.exitSeverity?.ctrlMatchesBWC === true ? 'NOTE: ' + ctx.bwcTeam + ' still holds structural control but underlying stats are deteriorating — this is the slow bleed that cumulative indicators miss.' : ''} Position state: ${ctx.exitSeverity?.bwcState || 'unknown'}.
  The SUBSCRIBER'S POSITION is on ${ctx.bwcTeam || 'the tracked team'}. Frame the exit around the underlying stats declining. Reference the full arc from prior alerts.
  EXIT on confirmed positions is ALWAYS SEND. Your job is the narrative — what changed in the underlying stats, whether this looks permanent or temporary, and what the subscriber should watch for.
  Floor-margin confirmation: CONVERGING_DOWN + conviction DEGRADING = strong EXIT confirmation (genuine structural death). DIVERGING_POSITIVE (floor low but margin growing) = structural floor is stale while the team is actually winning — flag this honestly but still SEND.
- BWC_EDGE: SEND by default — this is a position update for a subscriber already holding. Frame as reassurance: structural picture holding, lead compressing. Do NOT frame as a buy signal. MAY SUPPRESS if structural stress override applies (see STRUCTURAL STRESS CHECK). MUST include a RISK line at the end of the body — identify the ONE specific thing that could flip this position next (e.g., indicator about to flip, sustainability degrading, erosion approaching threshold, floor-margin DIVERGING_NEGATIVE meaning structure improving but margin shrinking). If prior alerts flagged a RISK, reference whether it materialized or not. Check conviction trend — DEGRADING conviction is a key risk to flag even if floor is stable. The RISK line creates accountability across the alert chain. Format body as: status update (2-3 sentences) + "RISK: [specific forward-looking concern]"
- POSITION_SAFE / POSITION_RECOVERING: SEND as reassurance if prior alerts flagged risks or concerns. Include whether prior RISK materialized. SUPPRESS only if nothing changed AND no prior risk to update on. Write reasoning for compounding either way.
${ctx.positionClosed ? '  POST-EXIT RECOVERY: Position is CLOSED — the subscriber was told to EXIT (XGB dropped below threshold). This recovery alert fires because XGB has recovered above threshold + 0.10 for sustained evaluation. Apply elevated scrutiny: (1) structural stress combined read must be REINFORCING or DOMINANT — not COLLAPSING/SHIFT/ERODING, (2) verify in per-quarter breakdown that recent quarters show the BWC team recovering structurally, not just cumulative anchoring, (3) the XGB recovery must be supported by the underlying stats improving — check which features drove the recovery. If the BWC team is genuinely back with structural evidence AND XGB conviction, SEND — this is a strong signal (thesis broke and then repaired). If the recovery looks like a brief spike or noise, SUPPRESS. Reference the EXIT reasoning from the PRIOR ALERT REASONING TRAIL.' : ''}
- BUY: structurally dominant team trailing. Standard evaluation — floor, indicators, TP, deficit depth${ctx.league === 'wnba' ? ' (1-4 sweet spot — trail 10+ is 0% in WNBA 40-min games)' : ' (1-7 sweet spot; deeper deficits need stronger structural case)'}. When bwcTeamMatch is noted, the team has BWC lifecycle context — reference the position arc. This is a "warm BUY" (thesis history). Without BWC context = "cold BUY" (unproven, higher bar for SEND).
  BUY structural evidence and the EV/suppression frame are in the BUY block above (provenance-tagged, league-split). Apply that; the position-tracking context below sets the baseline confidence.
  POSITION TRACKING CONTEXT FOR BUY DECISIONS:
  The BUY team's relationship to position tracking determines baseline confidence:

  - BUY team = tracked team with CONFIRMED/LOCKED position: "Warm BUY" — compound structural signals sustained (${ctx.league === 'wnba' ? 'MC Cum ≥ 0.80 + XGB ≥ 0.60' : 'MC Cum ≥ 0.80 + Floor ≥ 0.65 at establishment, ≥ 0.60 sustained'} for 5+ consecutive polls). Team trailing is the thesis working. MF trajectory tells you if the structural trend is holding.
  - BUY team = tracked team with RECOVERING position: "Warm BUY with caution" — position confirmed after control flip, 73% baseline. Trailing could be the thesis (structural team behind on variance) OR the original instability reasserting. Check conviction trend and per-quarter breakdown.
  - BUY team = tracked team, TRACKING only (compound not confirmed): System identified structural interest but compound signals never sustained. Lower confidence. Rely entirely on standard BUY evidence. This is a cold BUY with partial context.
  - BUY team = original tracked team but tracking FLIPPED to opponent: Near-automatic SUPPRESS. This team LOST structural control to the opponent. You are buying against the confirmed structural direction. The team that took it away confirmed through compound and wins historically.
  - BUY team = opponent of tracked team (not flipped): Evaluate independently. If opponent has confirmed, their structural case is strong — they earned it against the tracked team.
  - No tracking context at all: Cold BUY — rely entirely on standard BUY evidence above.

  FLIP BUY (EXIT + opponent BUY = structural reversal):
  When FLIP BUY CONTEXT is present above, the system has confirmed the structural reversal from TWO independent directions: EXIT confirmed the original position is dead, AND BUY independently identified the new control team as structurally dominant. This is NOT counter-betting — it is the highest-conviction structural signal because both the protective system (EXIT) and the offensive system (BUY) agree.

  SEND if: BUY team controls 2+ indicators AND at least one is I1 (disruption) or I2 (interior) — these are structural, not variance.
  SEND if: combined read = FLIPPED — the rolling window confirms the structural reversal.
  LEAN SEND if: combined read = COLLAPSING AND BUY team controls I1 or I2 — reversal in progress, structural indicators confirm direction.
  SUPPRESS if: BUY team's only advantage is I3 (shot quality) — variance on both sides, no confirmed structural reversal.
  SUPPRESS if: combined read = ERODING only — EXIT may have been premature, edge hasn't fully transferred. Wait for stronger confirmation.
  SUPPRESS if: deficit > 9 or < 1 min remaining — structural reversal confirmed but no betting window.

  Body MUST frame as structural reversal: "STRUCTURAL FLIP — your [exitTeam] position was exited at [time] because structural control shifted to [buyTeam]. [buyTeam] now independently qualifies as a BUY — [specific indicators]. This is not a counter-bet — the system independently confirmed the structural edge reversed."

  HOW TO USE MF TRAJECTORY ON BUY DECISIONS:
  - RISING = structural thesis is building, not fading. Trailing is more likely variance. Increases BUY confidence.
  - FLAT = structural edge is real but not separating. Apply standard BUY scrutiny from evidence above.
  - DECLINING = the game may have shifted since position confirmation. Extra skepticism — check if indicators that powered the position are still held.
  - INSUFFICIENT = fewer than 2 eligible checkpoints. Rely on standard BUY evidence.

  POSITION TRACKING AMPLIFIERS:
  - CONFIRMED/LOCKED + RISING MF = highest confidence warm BUY. Sustained compound + building structural trend + trailing at plus money.
  - RECOVERING + DECLINING MF = lowest confidence. Position contested AND structural trend fading.

  DEFICIT DEPTH + POSITION TRACKING: trail 5-9 with confirmed position = structural thesis may be wrong despite compound, apply extra scrutiny regardless of trajectory. Trail 10+ with confirmed position = near-automatic SUPPRESS (the structural read was incorrect regardless of compound).

  HOW TO USE CONTROL FLIPS ON BUY DECISIONS:

  CONFIRMED POSITION (compound confirmed, subscriber holds position):
  Compound confirmed after sustained structural signals. Trailing is the thesis working. Control flips provide risk context.
  - 0 flips = strongest warm BUY. Structural thesis unchallenged — trailing is pure variance.
  - 1-2 flips = warm BUY with caution. Note flips in RISK line. Apply standard BUY evidence.
  - 3+ flips = extreme skepticism. Structural control REPEATEDLY contested. The compound may reflect cumulative anchoring rather than current dominance. Rely entirely on standard BUY evidence (deficit depth, indicator profile, opponent indicators). Do NOT treat compound confirmation as confidence — treat it as context only. SUPPRESS unless BUY evidence is independently strong (trail 1-4, 3+ indicators, opp 0 structural indicators).

  POSITION CLOSED (EXIT was sent — thesis previously broke):
  Compound has RESET after EXIT. What matters is whether compound has re-confirmed with FRESH holds post-EXIT.
  - If compound re-confirmed post-EXIT: re-entry is credible — team proved it can sustain structural signals AFTER the thesis broke. Still requires evidence that the specific structural failures from the EXIT have been fixed. Reference EXIT reasoning from PRIOR ALERT REASONING TRAIL.
  - If compound NOT re-confirmed post-EXIT: the position thesis failed and hasn't been mechanically restored. Near-automatic SUPPRESS unless BUY evidence is independently overwhelming.
  - In BOTH cases: reference the agent's prior EXIT reasoning. What specific structural failures caused the EXIT? Have those indicators flipped back? If the same weaknesses persist, SUPPRESS regardless.
- STRUCTURAL STRESS CHECK: When combined read is COLLAPSING, FLIPPED, or SHIFT, the cumulative floor may be anchored from earlier-quarter dominance that has since eroded. The rolling window shows who is winning RECENT quarters.
  For entry signals (BUY, VALUE, THESIS_ALIVE): COLLAPSING + trailing = near-automatic SUPPRESS. SHIFT = extreme skepticism.
  For position alerts (POSITION_OPEN, BWC_EDGE, POSITION_SAFE, POSITION_RECOVERING): When the rolling window is SIGNIFICANTLY weaker than the cumulative floor, you MAY SUPPRESS or DOWNGRADE — this OVERRIDES the per-alert-type rules above. Compound confirmation does not guarantee CURRENT structural control. Evaluate whether the indicators that powered the position are still held in recent quarters using the per-quarter breakdown. If recent quarters show the opponent winning paint, disruption, or game control, the compound is stale.
  DOWNGRADE is preferred over SUPPRESS for POSITION_OPEN (subscriber should know confirmation happened but that it is contested).
  BWC_EDGE and POSITION_SAFE may fully SUPPRESS (these are updates to existing positions — no value in reassuring about a compromised position).
  EXEMPT from stress override: EXIT on confirmed positions (always SEND), TRACKING (always SEND), LOCKED with 0 flips (strongest signal, sustained across 10+ polls — stress override should not touch).
  REINFORCING (DOMINANT/STRONG combined read) = cumulative floor is trustworthy, proceed normally with per-alert-type rules.
- XGB REASONING (use SHAP drivers to interpret floor-XGB disagreements):
  ALIGNED (within 15%): Both systems independently agree — strongest signal. Proceed with normal rules.
  DIVERGENT — XGB BELOW FLOOR: SHAP tells you why.
  • efg as primary negative driver → shooting variance. Cross-ref sustainability: LOCKED/DURABLE sust = structural shooting gap (XGB may be right). FRAGILE/UNSUSTAINABLE sust = sust already flags this — don't double-penalize. If efg is the SOLE large negative SHAP driver and sust favors ctrl team, XGB may be overreacting to shooting variance the framework expects to regress.
  • paint/fta/oreb as negative drivers → STRUCTURAL interior weakness. The cumulative floor may be anchoring past early-game dominance that has since eroded. Weight XGB heavily — these are the core structural signals.
  • biglead negative = team hasn't converted structural control to scoreboard separation. Effort-based production risk (hustle stats inflating floor without actual dominance).
  • to negative = turnover differential hurting. If ctrl team's TO count is elevated, structural edge is compromised regardless of other indicators.
  DIVERGENT — XGB ABOVE FLOOR: Raw stats outpace composite indicators. paint/fta/oreb positive = interior structural dominance floor hasn't fully weighted. BUY/VALUE becomes more attractive.
  NEAR-ZERO FEATURES ARE DIAGNOSTIC: A feature at 0.00 means that dimension is NOT contributing to the prediction. If floor says 0.75 but paint=0.00 and oreb=0.00, the structural control has NO interior foundation in the raw stats — it is entirely shooting-driven (check efg). If the BUY thesis is "structurally dominant team trailing" but paint/fta/oreb are all near zero, the raw stats say there IS no structural dominance — floor may be anchoring stale early-game data.
  DECISION GUIDANCE:
  • BUY/VALUE with XGB < 0.40: lean SUPPRESS (backtest: 11% win rate) unless efg is sole negative SHAP driver + sust favorable (shooting variance thesis intact).
  • EXIT with XGB < 0.40: CONFIRMS exit thesis (backtest: 3.5% win rate at floor >= 0.60). Lean SEND.
  • BWC/PO with XGB < 0.50 + paint/fta negative in SHAP: lean DOWNGRADE — interior dominance thesis failing in raw stats.
  • Floor > 0.70 AND XGB > 0.70: highest-conviction combined read. Both systems see structural dominance.
  • Zero CP flips + XGB aligned: 97.2% win rate. Near-automatic SEND for any alert type.
  • 2+ CP flips + XGB < 0.50: 9.7% win rate. Near-automatic SUPPRESS.
- REASONING AS JOURNAL: Even when SUPPRESS, write thorough reasoning. It feeds subsequent decisions.

BODY RULES (read by non-technical bettors on their phone):
- Lead with score + action, explain WHY in basketball terms with structural data, end with what to watch.
- Translate indicators: I1=turnovers/steals, I2=paint/interior, I3=shot quality, I4=game flow, I5=pace/execution.
- Say "X/5 structural categories (codes)" not just codes. Include conviction, edge %, sustainability tiers.
- 2-4 sentences max. Keep structural metrics but make them readable.

Respond in EXACTLY this format:
DECISION: [SEND|SUPPRESS|DOWNGRADE]
REASONING: [2-3 sentences — reference opponent profile, erosion, BWC lifecycle, prior alerts]
BODY: [If SEND: plain-English alert. If SUPPRESS: blank]`;
}

// Sonnet-powered reasoning layer for alert quality assessment.
// Receives frontloaded context (all mechanical data + DB history),
// returns SEND / SUPPRESS / DOWNGRADE decision with reasoning.
// FIRED alerts fall through to ntfy on agent failure (safe default).
// CANDIDATE alerts are dropped on agent failure (conservative default).
async function runAlertAgent(ctx, overridePrompt, maxTokens) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) { log(`Agent: no API key, skipping`); return null; }

  const prompt = overridePrompt || `You are a live NBA betting alert quality agent. A mechanical system has identified a potential betting signal. Your job is to assess whether it should be sent to the bettor.

ALERT:
Type: ${ctx.alertType} (${ctx.alertTier})
Control team: ${ctx.controlTeam} | Floor: ${ctx.floor} (weighted I1-I5 composite, 0-1) | Margin: ${ctx.margin} (${ctx.isTrailing ? 'trailing' : 'leading'})
Score: ${ctx.score || 'N/A'}
Period: Q${ctx.period} ${ctx.clock} | Minutes left: ${ctx.minsLeft}
Conviction: ${ctx.convictionTier || 'N/A'} (${ctx.convictionCombo || 'N/A'}) ${ctx.convictionPairs ? '| Killer pairs: ' + ctx.convictionPairs : ''}
  (DOMINANT=4+ ind or I4+I5/I3+I4 pair, STRONG=I3+I4/I3+I5 pair, MODEST=2+ no killer pairs, CONDITIONAL=1 ind)
Edge: ${ctx.edge != null ? ctx.edge + '%' : 'N/A'} (floor minus market implied probability) | ML: ${ctx.ml || 'N/A'} | Spread: ${ctx.spread || 'N/A'}
TP: ${ctx.tpClass || 'N/A'} (trailing team comeback path: STRONG>PROBABLE>CONTESTED>UNLIKELY>NO PATH)
LS: ${ctx.lsClass || 'N/A'} (leading team margin safety: SAFE>CUSHIONED>AT RISK>CRITICAL)
Ctrl sust: ${ctx.ctrlSust || 'N/A'} | Opp sust: ${ctx.oppSust || 'N/A'}
Window score: ${ctx.windowScore || 'N/A'}
${composeTeamContext(ctx.homeAlias, ctx.awayAlias, ctx.league)}
${ctx.xgbWinProb != null ? 'XGBoost structural model: ' + (ctx.xgbWinProb * 100).toFixed(1) + '% win probability (independent raw-stats model). ' + (ctx.xgbAligned ? 'ALIGNED with floor.' : '⚠️ DIVERGENT from floor (' + (ctx.xgbDivergence > 0 ? '+' : '') + (ctx.xgbDivergence * 100).toFixed(1) + '%).') + (ctx.xgbShap ? ' SHAP: ' + ctx.xgbShap.map(s => s.f + '=' + (s.v > 0 ? '+' : '') + s.v.toFixed(2)).join(', ') : '') : ''}
${ctx.convictionQuality ? 'Conviction quality: ' + ctx.convictionQuality.basis + ' (' + Math.round(ctx.convictionQuality.strConcentration * 100) + '% structural / ' + Math.round(ctx.convictionQuality.volConcentration * 100) + '% volatile). Top: ' + ctx.convictionQuality.top1Feature + ' (' + Math.round(ctx.convictionQuality.top1Share * 100) + '%)' + (ctx.convictionQuality.top1IsVolatile ? ' [VOLATILE]' : '') + '. Scoreboard: ' + (ctx.convictionQuality.bigleadAnchored ? 'CONFIRMED' : ctx.convictionQuality.noScoreboardConfirmation ? 'NOT CONFIRMED' : 'PARTIAL') : ''}
${ctx.trajectorySignals && ctx.trajectorySignals.warnings.length > 0 ? 'Conviction warnings: ' + ctx.trajectorySignals.warnings.join(' | ') : ''}
${ctx.xgbWinProb >= 0.60 && ctx.margin < -5 ? 'NOTE [STRUCT]: XGB reads ' + (ctx.xgbWinProb * 100).toFixed(0) + '% but team is trailing by ' + Math.abs(ctx.margin) + '. High XGB while trailing is a positive structural read, not a promise — see the BUY EV frame. Deep + late trailing is the genuine caution.' : ctx.xgbWinProb >= 0.70 && ctx.margin < 0 ? 'NOTE [STRUCT]: XGB reads ' + (ctx.xgbWinProb * 100).toFixed(0) + '% while trailing — positive structural read, weight it alongside deficit and quarter.' : ''}

INDICATORS (control-team-relative, scale: 1.0=ctrl dominates, 0.0=opponent dominates, 0.5=even):
I1 Disruption: ${ctx.i1} | I2 Interior: ${ctx.i2} | I3 Shot Quality: ${ctx.i3} | I4 Game Control: ${ctx.i4} | I5 Execution: ${ctx.i5}
Indicators won (≥0.55): ${ctx.indWon || 'none'} (${ctx.indicatorsWon}/5) | Lost (≤0.45): ${ctx.indLost || 'none'}
I4 COMBO: ${ctx.i4Combo ? 'YES — I4 + another indicator agree (98-100% historically)' : ctx.i4Won ? 'PARTIAL — I4 won but no other decisive' : ctx.i4Decisive ? 'NO — I4 favors opponent' : 'EVEN — I4 undecided'}

FLOOR TRAJECTORY (recent snapshots, newest first):
${ctx.floorHistory || 'No prior snapshots'}

PRIOR ALERTS THIS GAME:
${ctx.priorAlerts || 'None'}

QUARTER PERFORMANCE:
${ctx.quarterSummary || 'N/A'}
${ctx.learningsContext ? '\n' + ctx.learningsContext + '\n' : ''}${ctx.priorPosition ? `
POSITION UPDATE CONTEXT:
This is a position update for a previously sent alert — NOT a new signal.
Prior alert: ${ctx.priorPosition.alertType} for ${ctx.priorPosition.controlTeam} at Q${ctx.priorPosition.period} ${ctx.priorPosition.clock} (${ctx.priorPosition.minutesSince} min ago)
  Floor then: ${ctx.priorPosition.floor} → now: ${ctx.floor} | Margin then: ${ctx.priorPosition.margin} → now: ${ctx.margin}
  Conviction then: ${ctx.priorPosition.conviction}(${ctx.priorPosition.combo}) → now: ${ctx.convictionTier}(${ctx.convictionCombo})
  Sust then: ${ctx.priorPosition.ctrlSust}/${ctx.priorPosition.oppSust} → now: ${ctx.ctrlSust}/${ctx.oppSust}
  Control team ${ctx.priorPosition.sameTeam ? 'UNCHANGED' : 'SHIFTED — was ' + ctx.priorPosition.controlTeam + ', now ' + ctx.controlTeam}

YOUR JOB: Assess whether the prior position is HOLDING, IMPROVING, or DETERIORATING.
- SEND if meaningful new info the bettor should know: floor shift >0.10, conviction upgrade/downgrade, lead expanding/contracting significantly, sustainability flip, or control team change
- SUPPRESS if conditions essentially unchanged — do not spam "still winning" updates
- If control team SHIFTED from the prior alert: this is critical info, strongly favor SEND to warn the bettor
- Your BODY must reference the prior alert and explain what changed. Lead with the position status.
  Example BODY: "Your Q2 position is holding — structural control climbed to 100%, conviction upgraded to DOMINANT. Lead expanded to 12."
  Example BODY: "Your Q2 position at risk — control shifted to opponent, structural control dropped from 75% to 55%. Consider exiting."
` : ''}
RULES:
- FIRED alerts passed all mechanical thresholds. You should SEND unless you see a clear structural contradiction. Check the indicator breakdown:
  • I4 COMBO YES (I4 + another agrees): highest conviction — SEND with confidence
  • I4 COMBO NO (I4 favors opponent): major red flag — the opponent has game control. SUPPRESS or DOWNGRADE unless other indicators are overwhelming (4/5)
  • Floor driven by I1+I2 without I4 or I5: effort-based control (hustle stats), not structural dominance. DOWNGRADE unless sustainability strongly favors control team
  • Floor trending DOWN across recent snapshots while alert says BUY: fading control, consider SUPPRESS
- CANDIDATE alerts failed a soft threshold but might still have value. You should SEND only if the structural case is compelling despite the threshold miss.
- BUY: the thesis is "structurally dominant team is trailing due to unsustainable opponent variance." Verify the control team actually dominates AND the opponent's lead is variance-driven.
- BWC (Buy Window Closing): the thesis is "market hasn't priced in structural dominance yet." Verify edge is real and lead is secure.
  • BWC + I4 EVEN: ${ctx.league === 'wnba' ? 'In WNBA, I4 is 25% weight (not the 30% NBA anchor). I3 (Shot Quality, 30%) is the structural foundation. I4 EVEN with I3 WON + I2 WON = strong structural hold. Only suppress if I3 is LOST — that is the WNBA equivalent of losing the anchor.' : 'Unlike BUY (where the team must TAKE control back), BWC teams already HOLD the lead. I4 EVEN is NOT a suppress signal for BWC when 3+ other indicators favor the control team and sustainability is LOCKED IN, DURABLE, or STALLED. STALLED means both shooting dimensions are significantly below baseline — but a lead built on paint and transition doesn\'t need hot shooting to hold. Only suppress BWC on I4 EVEN if fewer than 3 indicators won OR sustainability is FRAGILE/UNSUSTAINABLE OR floor is unstable (dropped 0.15+ in recent snapshots).'}
- MC_COLLAPSE (CLEAN pattern): Fires mechanically when MC structural investigation detects sustained collapse — post-trigger possession rates never normalized. 72.6% precision (295 backtest, Q3+), 83.3% production (6 games). When MC STRUCTURAL INVESTIGATION is active above, MC computes rates from actual recent possessions — immune to cumulative anchoring that affects floor and XGB.
  Q2 vs Q3+ precision: Q3+ fires validated at 72.6%. Q2 fires have 24+ minutes remaining for recovery — precision is unvalidated and expected lower. Q2 MC_COLLAPSE = EARLY WARNING, not confirmed collapse. Frame as "structural deterioration detected early" rather than "confirmed collapse." The signal is real — the outcome has more variance.
  Trust hierarchy depends on XGB agreement:
    CLEAN + XGB LOW (<0.50) = CONFIRMED COLLAPSE (86.9%, n=84). Both agree. Max conviction.
    CLEAN + XGB MED (0.50-0.70) = DEVELOPING COLLAPSE (70.4%, n=108). MC leading, XGB wavering.
    CLEAN + XGB HIGH (>0.70) = PROBABLE COLLAPSE (73.8%, n=103). MC vs XGB disagree — high risk, NOT certainty. Do NOT auto-override XGB.
  Margin qualifier — ctrl lead at trigger: ≤3=81%, 4-8=72%, 9-15=63%, 16+=noise. Avg CLEAN trigger margin is only +1.7.
  Per alert type: EXIT=MC confirms exit. BWC_EDGE=SUPPRESS or CRITICAL RISK. POSITION_SAFE=SUPPRESS. POSITION_OPEN=DOWNGRADE. BUY on opponent=requires ctrl floor ALSO dropping (<0.60) — MC collapse alone is insufficient (opponent wins only 25.8% when ctrl floor stays anchored high).
  Q2 MC_COLLAPSE modifier: BWC_EDGE=RISK line (not SUPPRESS). POSITION_SAFE=RISK line (not SUPPRESS). EXIT=flag as early-detected but do NOT confirm exit from Q2 MC alone. BUY on opponent=do NOT fire from Q2 MC. POSITION_OPEN=DOWNGRADE still applies.
  MC CLEAN/WAVE overrides combined_read — treat as COLLAPSING/SHIFT regardless. MC NORMALIZED = treat as REINFORCING.
- MC WAVE: Oscillating collapse. 60% precision. RISK signal, not confirmed. BWC_EDGE: prominent RISK line. POSITION_SAFE: DOWNGRADE.
- MC NORMALIZED: Rates recovered. 86-91% ctrl survives. CONFIDENCE signal. Reference as positive for POSITION_SAFE/BWC_EDGE. Argues AGAINST exit.
- TRACKING_INVALIDATED: The previously tracked team lost structural control. BWC tracking terminated mechanically. Subsequent alerts about the new control team are FRESH evaluations — not continuations of the old thesis. Do not reference the dead team's floor or position tracking state for current decisions. If the dead team had a confirmed position, this is an implicit EXIT — the structural case supporting the position is gone.
- XGB_INVALIDATED: A prior BUY thesis has been invalidated by structural collapse. ${ctx.invTriggerSignal === 'mc_cum' ? 'Q3/Q4 uses MC Cum (full-game rate projection) < 30% as the trigger — the possession rates that supported the entry no longer project a win. Focus narrative on: (1) which rates collapsed (TO discipline, interior finishing, 3PT shooting, FT generation), (2) whether the rate decay is accelerating or stabilizing, (3) current indicator picture.' : `Q2 uses XGB (structural model) dropping below the viability gate (${ctx.league === 'wnba' ? 'Q2<0.45' : 'Q2<0.40'}). Focus narrative on: (1) SHAP drivers NOW vs at BUY time, (2) whether XGB drop is raw stat decay or game progress pressure, (3) current structural picture.`} ALWAYS SEND — the mechanical gate is the filter. Frame as: "The structural case no longer supports the [TEAM] BUY — [explain what changed in basketball terms]. Consider exiting if you took this position." This is an exit signal, not a veto of future entry.
- CONVICTION QUALITY: ${ctx.league === 'wnba' ? 'Evaluate how the XGB model arrives at its prediction. CONFIRMED scoreboard (biglead SHAP anchored >25%) = high confidence. NOT CONFIRMED (biglead flat/negative) = stats not translating to lead, elevate scrutiny. VOLATILE basis (pot/oreb/to_ratio dominant) = circumstantial edge, may not sustain. STRUCTURAL basis (biglead/disruption/ast/efg/ftm dominant) = scheme-driven, more durable. Multiple conviction warnings compounding = strong SUPPRESS/DOWNGRADE signal. Single warning = flag as RISK, not auto-SUPPRESS.' : 'If provided, evaluate how the XGB model arrives at its prediction. CONFIRMED scoreboard = high confidence (95% WR). NOT CONFIRMED = stats not translating to lead, elevate scrutiny. VOLATILE basis (pot/stl/oreb/to/runs dominant) = circumstantial edge, may not sustain. Multiple conviction warnings compounding = strong SUPPRESS/DOWNGRADE signal. Single warning = flag as RISK, not auto-SUPPRESS.'}
- ANCHORED FLOOR CHECK: If team is TRAILING with floor 0.75+ but margin only 1-3 pts AND floor is declining from recent snapshots, the floor may be anchored from earlier dominance that has eroded. Verify recent quarters still favor control team before SEND. This rule does NOT apply to leading teams (BWC) — a high floor with a small lead is a valid structural read. When MC STRUCTURAL INVESTIGATION is active and shows CLEAN/WAVE, the floor IS anchored — MC proved it by showing post-trigger rates have deteriorated while cumulative floor remained high. Do not independently diagnose anchoring when MC has already measured it.
- EARLY GAME NOTE (Q1-Q2): Indicator samples are smaller early — steals/blocks counts are low, run share may not be populated yet, and biggest_lead gaps can form from a single early run. This does NOT mean early signals are unreliable. ${ctx.league === 'wnba' ? 'For Q1-Q2 FIRED alerts: I3 COMBO YES = SEND with confidence. For CANDIDATE alerts: I3 COMBO YES = SEND. Without I3 COMBO, apply extra scrutiny.' : 'The new indicator formulas have proven predictive even in Q2. For Q1-Q2 FIRED alerts: I4 COMBO YES = SEND with confidence. I4 COMBO NO = apply normal scrutiny (don\'t auto-reject, just verify the structural case). For Q1-Q2 CANDIDATE alerts: I4 COMBO YES = SEND. I4 COMBO NO = apply extra scrutiny but still SEND if floor is strong (0.75+) and sustainability favors control team.'} Q3+ alerts have the most data — highest confidence.
- CANDIDATE BUYs at floor 0.55-0.65: only SEND if ${ctx.league === 'wnba' ? 'I3 COMBO is YES (I3 decisive + at least one other indicator agrees — I3 is the 30% WNBA anchor). Without I3 COMBO, SUPPRESS.' : 'I4 COMBO is YES (I4 decisive + at least one other indicator agrees — this pattern is 98-100% accurate historically). Without I4 COMBO, require very strong sustainability case to justify SEND.'}
- CANDIDATE BUYs with negative ML (heavy favorite trailing): the CANDIDATE tier reflects the ML gate (-250 to -400), NOT structural weakness. Evaluate the structural case as if it were FIRED — if ${ctx.league === 'wnba' ? 'I3 COMBO YES' : 'I4 COMBO YES'} + STRONG/DOMINANT conviction, SEND so the subscriber can shop for favorable lines. Note the heavy ML in the BODY.
- TP (Throughput Projection) is context, not a veto. It estimates whether a trailing team's structural production rate can close the deficit in remaining possessions. Limitation: TP uses cumulative game stats, so early-game dominance by either team anchors the rates even after momentum shifts. TP NO PATH at 1-3 point deficits is often a false negative — the game is essentially tied regardless of what the projection math says. TP STRONG RECOVERY or PROBABLE adds confidence. TP UNLIKELY or NO PATH is a caution flag, not a stop sign.
${ctx.league === 'wnba' ? `- CONVICTION QUALITY (how WNBA XGB arrives at its prediction — 12 features, windowed biglead):
  Windowed biglead is #1 feature (31% SHAP importance) — scoreboard confirmation now applies to WNBA.
  biglead SHAP anchored (>25% share) = scoreboard confirms structural edge. High confidence.
  biglead SHAP flat/negative = stats not translating to lead — elevate scrutiny.
  VOLATILE basis (pot/oreb/to_ratio dominant) = circumstantial edge, may not sustain.
  STRUCTURAL basis (biglead/disruption/ast/efg/ftm dominant) = scheme-driven, more durable.
  Near-zero for most features = structural edge is thin regardless of MC/floor.
  Q4 calibration: model underestimates at 0.55-0.75 (actual WR 10-20pp higher than predicted).
  These signals matter MOST for BUY and BWC_EDGE. For EXIT, XGB threshold itself is sufficient.` : `- CONVICTION QUALITY (how XGB arrives at its prediction — validated on 16,910 snapshots):
  SCOREBOARD STATUS is the strongest signal:
    "CONFIRMED" (biglead anchored) = team has built commanding lead, XGB highly reliable (95% win rate). High confidence.
    "NOT CONFIRMED" (biglead flat/negative) = stats look dominant but no lead built. Other features compensating. Elevate scrutiny — 19% loss rate vs 5% when confirmed.
    "PARTIAL" = some biglead contribution. Moderate confidence.
  VOLATILE vs STRUCTURAL basis:
    STRUCTURAL = conviction from shooting (efg), paint, ball movement (ast). Repeatable. Trust.
    MIXED = partial volatile contribution. Weight structural stress and window more heavily.
    VOLATILE = conviction from turnovers/hustle (pot, stl, oreb, runs). Circumstantial. 46% loss rate at XGB>70% vs 29% structural.
  CONVICTION WARNINGS fire on validated thresholds. Multiple warnings compounding = strong SUPPRESS/DOWNGRADE signal. Single warning = flag as RISK in body, does NOT mean auto-SUPPRESS (54% of volatile-basis teams still win).
  These signals matter MOST for BUY and BWC_EDGE. For EXIT, XGB threshold itself is sufficient — conviction quality is informational only.`}

BODY RULES (the BODY is read by non-technical bettors on their phone — translate your technical reasoning into basketball language while keeping structural data):
- Translate indicators into basketball, then include indicator codes in parentheses:
  "POR dominates inside and controls game flow — DOMINANT, 4/5 structural categories (I1, I2, I3, I4) at 95% control"
  I1 = turnovers/steals, I2 = paint/interior, I3 = shot quality/creation, I4 = game flow/control, I5 = pace/execution
- Say "X/5 structural categories (codes)" instead of just listing codes without context
- "Floor 0.95" → "95% structural control" or "dominant across the board"
- Conviction tiers (DOMINANT/STRONG/MODEST), sustainability tiers (LOCKED IN/DURABLE/STALLED/FRAGILE), and edge % stay as-is — they are plain English
- TP → "comeback math favors/doesn't favor [TEAM]" or "projects X-point swing"
- LS → "lead is secure" / "lead is under pressure"
- Lead with score + action, explain WHY in basketball terms with structural data, end with what to watch
- 2-4 sentences max. Do NOT lose structural metrics — keep conviction, edge %, sustainability, indicator count. Just make them readable.

Respond in EXACTLY this format:
DECISION: [SEND|SUPPRESS|DOWNGRADE]
REASONING: [1-2 sentences — technical, for internal logging. Use I1-I5 codes, floor scores, conviction details freely.]
BODY: [If SEND/DOWNGRADE: plain-English alert body following BODY RULES above. If SUPPRESS: leave blank]`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: maxTokens || 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      log(`Agent: Anthropic ${resp.status}`);
      return null; // fallback: FIRED sends, CANDIDATE drops
    }

    const data = await resp.json();
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

    const decisionMatch = text.match(/DECISION:\s*(SEND|SUPPRESS|DOWNGRADE)/i);
    const reasoningMatch = text.match(/REASONING:\s*(.+?)(?:\n|$)/i);
    const bodyMatch = text.match(/BODY:\s*([\s\S]*)/i);

    if (!decisionMatch) {
      log(`Agent: failed to parse decision from: ${text.substring(0, 100)}`);
      return null;
    }

    return {
      decision: decisionMatch[1].toUpperCase(),
      reasoning: reasoningMatch ? reasoningMatch[1].trim() : '',
      body: bodyMatch ? bodyMatch[1].trim() : '',
      usage: data.usage,
    };
  } catch (e) {
    log(`Agent: error — ${e.message}`);
    return null;
  }
}

// Helper: gather agent context from DB
async function gatherAgentContext(sql, gameId, matchup) {
  let floorHistory = '', priorAlerts = '', quarterSummary = '';
  try {
    const snaps = await sql`SELECT floor_score, floor_team, period, clock, home_pts, away_pts, i1, i2, i3, i4, i5, tp_class, ls_class
      FROM snapshots WHERE game_id = ${gameId} AND source = 'server' ORDER BY ts DESC LIMIT 5`;
    if (snaps.length > 0) {
      floorHistory = snaps.map(s =>
        `Q${s.period} ${s.clock}: ${s.floor_team} ${Number(s.floor_score).toFixed(2)} (${s.away_pts}-${s.home_pts}) TP:${s.tp_class || '?'} LS:${s.ls_class || '?'}`
      ).join('\n');
    }
  } catch (e) { /* non-fatal */ }
  try {
    const alerts = await sql`SELECT alert_type, alert_tier, period, clock, floor_score, margin, is_trailing, ctrl_sust, opp_sust, agent_decision, agent_reasoning, conviction_tier, conviction_combo, edge, tp_class
      FROM alerts WHERE game_id = ${gameId}
        AND NOT (alert_type = 'AUTO_ANALYSIS' AND agent_decision = 'SUPPRESS')
      ORDER BY ts DESC LIMIT 5`;
    if (alerts.length > 0) {
      priorAlerts = alerts.map(a => {
        let line = `${a.alert_type}${a.alert_tier ? '['+a.alert_tier+']' : ''} Q${a.period} ${a.clock}: floor ${Number(a.floor_score).toFixed(2)}, margin ${a.margin} ${a.is_trailing ? 'trailing' : 'leading'}, sust ${a.ctrl_sust}/${a.opp_sust}`;
        if (a.conviction_tier) line += `, conv ${a.conviction_tier}(${a.conviction_combo || '?'})`;
        if (a.edge != null) line += `, edge ${a.edge > 0 ? '+' : ''}${Number(a.edge).toFixed(1)}%`;
        if (a.tp_class) line += `, TP ${a.tp_class}`;
        if (a.agent_decision) line += ` → ${a.agent_decision}`;
        if (a.agent_reasoning) line += `: ${a.agent_reasoning.substring(0, 120)}`;
        return line;
      }).join('\n');
    }
  } catch (e) { /* non-fatal */ }
  try {
    const qd = await readQuarterData(sql, gameId);
    if (qd && qd.boundaries) {
      const keys = Object.keys(qd.boundaries).filter(k => k !== '0').sort();
      if (keys.length > 0) {
        quarterSummary = keys.map(k => {
          const b = qd.boundaries[k];
          if (!b) return null;
          const h = b.home || {}, a = b.away || {};
          return `Q${k}: ${h.points || '?'}-${a.points || '?'} pts, paint ${h.points_in_paint || '?'}-${a.points_in_paint || '?'}, TO ${h.turnovers || '?'}-${a.turnovers || '?'}`;
        }).filter(Boolean).join('\n');
      }
    }
  } catch (e) { /* non-fatal */ }
  // Historical accuracy from nightly learning agent (min 3 nights for reliability)
  let learningsContext = '';
  try {
    const learn = await sql`SELECT date, accuracy_overall, accuracy_by_type, agent_accuracy, patterns, recommendations
      FROM learnings WHERE accuracy_overall IS NOT NULL ORDER BY date DESC LIMIT 5`;
    if (learn.length >= 3) {
      const lines = learn.map(l => {
        const byType = typeof l.accuracy_by_type === 'string' ? JSON.parse(l.accuracy_by_type) : l.accuracy_by_type || {};
        const agent = typeof l.agent_accuracy === 'string' ? JSON.parse(l.agent_accuracy) : l.agent_accuracy || {};
        const typeStr = Object.entries(byType).map(([k,v]) => `${k}:${v.correct}/${v.total}`).join(' ');
        return `${l.date}: ${l.accuracy_overall}% delivered | ${typeStr} | saves:${agent.saves || 0} missed:${agent.missed_winners || 0}`;
      });
      // Extract latest patterns and recommendations
      const latestPatterns = typeof learn[0].patterns === 'string' ? JSON.parse(learn[0].patterns) : learn[0].patterns || [];
      const latestRecs = typeof learn[0].recommendations === 'string' ? JSON.parse(learn[0].recommendations) : learn[0].recommendations || [];
      learningsContext = 'NIGHTLY RESULTS (last ' + learn.length + ' nights):\n' + lines.join('\n');
      if (latestPatterns.length > 0) {
        learningsContext += '\n\nPATTERNS IDENTIFIED:\n' + latestPatterns.slice(0, 3).map(p => typeof p === 'string' ? p : p.pattern || JSON.stringify(p)).join('\n');
      }
      if (latestRecs.length > 0) {
        learningsContext += '\n\nRECOMMENDATIONS:\n' + latestRecs.slice(0, 3).map(r => typeof r === 'string' ? r : r.action || JSON.stringify(r)).join('\n');
      }
    }
  } catch (e) { /* non-fatal — learnings table may not exist */ }
  return { floorHistory, priorAlerts, quarterSummary, learningsContext };
}

function today() {
  // Use ET for game dates (NBA schedule is ET-based)
  const now = new Date();
  // Simple ET approximation: UTC-5 (close enough for date boundaries)
  const et = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  // NBA: games after midnight ET still belong to previous slate
  // If before 6 AM ET, use yesterday's date
  if (et.getUTCHours() < 6) {
    et.setUTCDate(et.getUTCDate() - 1);
  }
  return {
    year: et.getUTCFullYear(),
    month: et.getUTCMonth() + 1,
    day: et.getUTCDate(),
  };
}

function log(msg) {
  console.log(`[poll-live] ${msg}`);
}

// ── SR FETCH ────────────────────────────────────────────────────────────────

async function srFetch(league, path) {
  const cfg = LEAGUES[league];
  const apiKey = process.env[cfg.srKeyEnv];
  if (!apiKey) throw new Error(`${cfg.srKeyEnv} not configured`);
  const url = `${cfg.srBase}${path}?api_key=${apiKey}`;
  const resp = await fetch(url);
  if (resp.status === 429) throw new Error('SR rate limited');
  if (!resp.ok) throw new Error(`SR ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  return resp.json();
}

// ── ESPN FETCH ──────────────────────────────────────────────────────────────

async function espnScoreboard(league, dateStr) {
  const cfg = LEAGUES[league];
  let url = `${cfg.espnBase}scoreboard?dates=${dateStr}`;
  // NCAAMB needs groups=100&limit=200 to get all games
  if (league === 'ncaamb') url += '&groups=100&limit=200';
  const resp = await fetch(url);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.events || []).map(ev => {
    const comp = ev.competitions?.[0] || {};
    const home = comp.competitors?.find(c => c.homeAway === 'home');
    const away = comp.competitors?.find(c => c.homeAway === 'away');
    return {
      espnId: ev.id,
      scheduled: ev.date || null,
      homeAbbr: home?.team?.abbreviation || '',
      awayAbbr: away?.team?.abbreviation || '',
      homeName: (home?.team?.displayName || '').toLowerCase(),
      awayName: (away?.team?.displayName || '').toLowerCase(),
      status: ev.status?.type?.name || '',
    };
  });
}

async function espnWinProb(league, espnEventId) {
  const cfg = LEAGUES[league];
  const url = `${cfg.espnSummaryBase}?event=${espnEventId}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const wp = data.winprobability || [];
    if (wp.length === 0) return null;
    const latest = wp[wp.length - 1];
    const homeWP = latest.homeWinPercentage;
    if (homeWP == null) return null;
    return {
      home: Math.round(homeWP * 100),
      away: 100 - Math.round(homeWP * 100),
    };
  } catch (e) {
    log(`ESPN WP error for ${espnEventId}: ${e.message}`);
    return null;
  }
}

// Fetch FULL ESPN WP history array for DB persistence (called at game finalization)
async function espnWPHistoryFull(league, espnEventId) {
  const cfg = LEAGUES[league];
  const url = `${cfg.espnSummaryBase}?event=${espnEventId}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const wp = data.winprobability || [];
    if (wp.length === 0) return null;
    let history = wp.map(p => ({
      homeWP: p.homeWinPercentage != null ? Math.round(p.homeWinPercentage * 1000) / 1000 : null,
      secondsLeft: p.secondsLeft != null ? p.secondsLeft : null,
      seq: p.sequenceNumber || null,
    }));
    // Downsample to 300 if needed
    if (history.length > 300) {
      const step = Math.ceil(history.length / 300);
      const sampled = [history[0]];
      for (let i = step; i < history.length - 1; i += step) sampled.push(history[i]);
      sampled.push(history[history.length - 1]);
      history = sampled;
    }
    return history;
  } catch (e) {
    log(`ESPN WP history error for ${espnEventId}: ${e.message}`);
    return null;
  }
}

// ── BDL FETCH ───────────────────────────────────────────────────────────────

async function bdlFetch(path) {
  const apiKey = process.env.BDL_API_KEY;
  if (!apiKey) return null;
  const url = `${BDL_BASE}${path}`;
  try {
    const resp = await fetch(url, { headers: { 'Authorization': apiKey } });
    if (!resp.ok) {
      log(`BDL ${resp.status}: ${path}`);
      return null;
    }
    return await resp.json();
  } catch (e) {
    log(`BDL error: ${e.message}`);
    return null;
  }
}

// Fetch today's BDL games → build team ID map + game ID map (for odds)
async function bdlGameData(league, dateStr) {
  const cfg = LEAGUES[league];
  // dateStr format: YYYY-MM-DD
  // NCAAMB/WNBA: BDL uses UTC dates, so late-ET games appear on the next UTC day.
  // Fetch both the requested date and the next day, merge results.
  const dates = [dateStr];
  if (league === 'ncaamb' || league === 'wnba') {
    const dt = new Date(dateStr + 'T12:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + 1);
    const nd = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
    dates.push(nd);
  }
  const teamIds = {}; // { 'LAL': 14, 'HOU': 11, ... }
  const gameIds = {}; // { 'HOU@LAL': 54321, ... } — keyed by matchup for SR→BDL mapping
  for (const ds of dates) {
    try {
      const data = await bdlFetch(`${cfg.bdlPrefix}/v1/games?dates[]=${ds}&per_page=50`);
      if (!data || !data.data) continue;
      for (const g of data.data) {
        const hAbbr = g.home_team?.abbreviation;
        const aAbbr = g.visitor_team?.abbreviation;
        if (hAbbr && g.home_team?.id) teamIds[hAbbr] = g.home_team.id;
        if (aAbbr && g.visitor_team?.id) teamIds[aAbbr] = g.visitor_team.id;
        if (hAbbr && aAbbr && g.id) gameIds[`${aAbbr}@${hAbbr}`] = g.id;
      }
    } catch (e) {
      log(`bdlGameData ${ds} failed: ${e.message}`);
    }
  }
  return { teamIds, gameIds };
}

// Fetch player season stats for a team — NCAAMB batch endpoint (works as-is)
async function bdlSeasonStatsNCAAMB(league, bdlTeamId, season) {
  const cfg = LEAGUES[league];
  const data = await bdlFetch(`${cfg.bdlPrefix}/v1/player_season_stats?season=${season}&team_id=${bdlTeamId}&per_page=100`);
  if (!data || !data.data) return [];
  return data.data;
}

// Fetch NBA season averages — per-player (BDL has no batch-by-team for NBA)
// Step 1: Get player IDs from a recent game's box score
// Step 2: Call /nba/v1/season_averages per player
async function bdlSeasonStatsNBA(bdlTeamId, season) {
  // Find a recent game for this team to get player IDs
  const gamesData = await bdlFetch(`/nba/v1/games?team_ids[]=${bdlTeamId}&seasons[]=${season}&per_page=5`);
  if (!gamesData?.data?.length) return [];

  // Get the most recent game's box score for player IDs (BDL returns oldest first)
  const recentGameId = gamesData.data[gamesData.data.length - 1].id;
  const statsData = await bdlFetch(`/nba/v1/stats?game_ids[]=${recentGameId}&per_page=50`);
  if (!statsData?.data?.length) return [];

  // Filter to players on this team who played meaningful minutes
  const teamPlayers = statsData.data.filter(s => {
    const mins = s.min ? parseInt(s.min) : 0;
    return s.player?.id && s.team?.id == bdlTeamId && mins >= 5;
  });

  // Fetch season averages for each player in parallel
  const results = [];
  const fetches = teamPlayers.map(async (s) => {
    const pid = s.player.id;
    const data = await bdlFetch(`/nba/v1/season_averages?season=${season}&player_id=${pid}`);
    if (data?.data?.length) {
      const avg = data.data[0];
      results.push({
        player: { id: pid, first_name: s.player.first_name, last_name: s.player.last_name },
        fg3m: avg.fg3m || 0, fg3a: avg.fg3a || 0,
        fgm: avg.fgm || 0, fga: avg.fga || 0,
        pts: avg.pts || 0, reb: avg.reb || 0, ast: avg.ast || 0,
        stl: avg.stl || 0, blk: avg.blk || 0, turnover: avg.turnover || 0,
        min: avg.min || '0', games_played: avg.games_played || 0,
      });
    }
  });
  await Promise.all(fetches);
  return results;
}

// Load season cache from DB for given teams
async function loadSeasonCache(sql, league, season, teamAbbrs) {
  if (teamAbbrs.length === 0) return {};
  try {
    const rows = await sql`
      SELECT team_alias, players_json, updated_at
      FROM season_cache
      WHERE league = ${league} AND season = ${season} AND team_alias = ANY(${teamAbbrs})
    `;
    const cache = {};
    for (const r of rows) {
      const age = (Date.now() - new Date(r.updated_at).getTime()) / (1000 * 60 * 60 * 24);
      cache[r.team_alias] = {
        players: typeof r.players_json === 'string' ? JSON.parse(r.players_json) : r.players_json,
        ageDays: Math.round(age * 10) / 10,
        fresh: age < 7, // fresh if under 7 days old
      };
    }
    return cache;
  } catch (e) {
    log(`Season cache load failed: ${e.message}`);
    return {};
  }
}

// Save season cache to DB
async function saveSeasonCache(sql, league, season, teamAlias, players) {
  try {
    await sql`
      INSERT INTO season_cache (team_alias, league, season, players_json, player_count, updated_at)
      VALUES (${teamAlias}, ${league}, ${season}, ${JSON.stringify(players)}, ${players.length}, NOW())
      ON CONFLICT (team_alias, league, season) DO UPDATE SET
        players_json = ${JSON.stringify(players)}, player_count = ${players.length}, updated_at = NOW()
    `;
  } catch (e) {
    log(`Season cache save failed for ${teamAlias}: ${e.message}`);
  }
}

// Get season stats for teams — cache-first, fetch stale/missing
async function getSeasonStatsForTeams(sql, league, season, teamAbbrs, bdlTeamIds) {
  const abbrArr = Array.from(teamAbbrs);
  const cache = await loadSeasonCache(sql, league, season, abbrArr);
  const result = {}; // { 'BOS': [...playerStats], ... }
  const stale = []; // teams that need refresh

  for (const abbr of abbrArr) {
    if (cache[abbr]?.fresh) {
      result[abbr] = cache[abbr].players;
    } else {
      stale.push(abbr);
    }
  }

  const freshCount = abbrArr.length - stale.length;
  if (freshCount > 0) log(`Season cache: ${freshCount} teams from cache`);

  if (stale.length > 0) {
    log(`Season cache: ${stale.length} teams stale/missing — refreshing: ${stale.join(', ')}`);

    const fetches = stale.map(async (abbr) => {
      const bdlId = bdlTeamIds[abbr];
      if (!bdlId) return;

      try {
        let players;
        if (league === 'nba') {
          players = await bdlSeasonStatsNBA(bdlId, season);
        } else {
          players = await bdlSeasonStatsNCAAMB(league, bdlId, season);
        }

        if (players.length > 0) {
          result[abbr] = players;
          await saveSeasonCache(sql, league, season, abbr, players);
          log(`Season cache: ${abbr} refreshed — ${players.length} players`);
        }
      } catch (e) {
        log(`Season fetch ${abbr}: ${e.message}`);
      }
    });

    await Promise.all(fetches);
  }

  return result;
}

// Fetch odds for a game → returns { homeSpread, homeML, awayML, total } or null
async function bdlOdds(league, bdlGameId) {
  const cfg = LEAGUES[league];
  // NBA uses /v2/odds, NCAAMB uses /v1/odds with array param
  let path;
  if (league === 'nba') {
    path = `/nba/v2/odds?game_ids[]=${bdlGameId}`;
  } else {
    path = `${cfg.bdlPrefix}/v1/odds?game_ids[]=${bdlGameId}`;
  }
  const data = await bdlFetch(path);
  if (!data || !data.data || data.data.length === 0) return null;

  // BDL NBA v2 odds are flat per-vendor objects:
  //   { vendor, spread_home_value, spread_away_value, moneyline_home_odds, moneyline_away_odds, total_value, ... }
  // Prefer FanDuel or DraftKings
  const odds = data.data;
  const preferred = odds.find(o =>
    o.vendor?.toLowerCase().includes('fanduel') || o.vendor?.toLowerCase().includes('draftkings')
  ) || odds[0];

  if (!preferred) return null;

  const homeSpread = preferred.spread_home_value != null ? parseFloat(preferred.spread_home_value) : null;
  const homeML = preferred.moneyline_home_odds != null ? parseInt(preferred.moneyline_home_odds) : null;
  const awayML = preferred.moneyline_away_odds != null ? parseInt(preferred.moneyline_away_odds) : null;
  const total = preferred.total_value != null ? parseFloat(preferred.total_value) : null;

  if (homeSpread == null && homeML == null) return null;
  return { homeSpread, homeML, awayML, total };
}

// Fetch live odds from The Odds API — one call returns ALL live NBA games
// Returns map: { 'NYK': { homeSpread, homeML, awayML, total, books }, ... } keyed by HOME alias
// Uses best available line (most favorable ML for each side)
// ── STANDINGS CACHE (Phase 2a) — daily-refreshed BDL standings → W/L for comebackProb ──
// Keyed BDL-canonical alias (matches hA/aA post-aliasMap). gp<4 → caller's _wp returns
// null (NO_DATA). Cached in DB (standings_cache) so it survives container recycles;
// refetched only when the newest row is stale (> ~20h). Cheap: ~1 BDL call/day.
async function fetchStandingsCache(sql, league) {
  const cfg = LEAGUES[league] || {};
  const out = {};
  // 1. DB cache — fresh if newest row < 20h old
  try {
    const rows = await sql`SELECT team_alias, wins, losses, EXTRACT(EPOCH FROM (NOW() - updated_at)) AS age_s FROM standings_cache WHERE league = ${league}`;
    if (rows.length > 0) {
      const maxAge = Math.max(...rows.map(r => Number(r.age_s) || 1e9));
      if (maxAge < 72000) {
        rows.forEach(r => { out[r.team_alias] = { w: Number(r.wins) || 0, l: Number(r.losses) || 0 }; });
        return out;
      }
    }
  } catch (e) { /* table missing / read error → fall through to fetch */ }
  // 2. Stale or empty → fetch from BDL + upsert
  try {
    const yr = new Date().getFullYear();
    const data = await bdlFetch(`${cfg.bdlPrefix}/v1/standings?season=${yr}`);
    const arr = (data && data.data) || [];
    for (const s of arr) {
      const abbr = s.team && s.team.abbreviation;
      if (!abbr) continue;
      const w = Number(s.wins) || 0, l = Number(s.losses) || 0;
      out[abbr] = { w, l };
      try { await sql`INSERT INTO standings_cache (league, team_alias, wins, losses, updated_at) VALUES (${league}, ${abbr}, ${w}, ${l}, NOW()) ON CONFLICT (league, team_alias) DO UPDATE SET wins = ${w}, losses = ${l}, updated_at = NOW()`; } catch (e) {}
    }
    log(`Standings cache refreshed (${league}): ${Object.keys(out).length} teams`);
  } catch (e) { log(`Standings fetch failed (${league}): ${e.message}`); }
  return out;
}

async function fetchOddsAPIBatch(league) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return {};
  const sportKey = league === 'wnba' ? 'basketball_wnba' : 'basketball_nba';
  const teamMap = league === 'wnba' ? ODDS_API_TEAMS_WNBA : ODDS_API_TEAMS;
  const cfg = LEAGUES[league] || {};
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&regions=us,us2&markets=h2h,spreads,totals&oddsFormat=american`;
    const resp = await fetch(url);
    if (!resp.ok) {
      log(`Odds API ${resp.status} (${sportKey})`);
      return {};
    }
    const games = await resp.json();
    const remaining = resp.headers.get('x-requests-remaining');
    log(`Odds API (${league}): ${games.length} games, ${remaining} credits remaining`);

    const result = {};
    for (const g of games) {
      const homeAlias = teamMap[g.home_team];
      const awayAlias = teamMap[g.away_team];
      if (!homeAlias || !awayAlias) continue;

      let bestHomeML = null, bestAwayML = null, bestHomeMLBook = null, bestAwayMLBook = null;
      const spreads = [], totals = [], homeMLs = [], awayMLs = [];

      for (const bk of (g.bookmakers || [])) {
        for (const mkt of (bk.markets || [])) {
          if (mkt.key === 'h2h') {
            for (const o of (mkt.outcomes || [])) {
              const alias = teamMap[o.name];
              if (alias === homeAlias) { homeMLs.push(o.price); if (bestHomeML == null || o.price > bestHomeML) { bestHomeML = o.price; bestHomeMLBook = bk.title || bk.key; } }
              if (alias === awayAlias) { awayMLs.push(o.price); if (bestAwayML == null || o.price > bestAwayML) { bestAwayML = o.price; bestAwayMLBook = bk.title || bk.key; } }
            }
          } else if (mkt.key === 'spreads') {
            const homeOut = (mkt.outcomes || []).find(o => teamMap[o.name] === homeAlias);
            if (homeOut?.point != null) spreads.push(homeOut.point);
          } else if (mkt.key === 'totals') {
            const overOut = (mkt.outcomes || []).find(o => o.name === 'Over');
            if (overOut?.point != null) totals.push(overOut.point);
          }
        }
      }

      // Median for spread and total (consensus)
      const median = arr => { if (!arr.length) return null; arr.sort((a, b) => a - b); const m = Math.floor(arr.length / 2); return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2; };
      const homeSpread = median(spreads);
      const total = median(totals);
      // ML consensus = median american price across books (trailer in a sweet-spot is + odds → monotonic; fine for the reference line).
      const homeMLConsensus = median(homeMLs) != null ? Math.round(median(homeMLs)) : null;
      const awayMLConsensus = median(awayMLs) != null ? Math.round(median(awayMLs)) : null;

      if (bestHomeML == null && homeSpread == null) continue;
      // Key by BDL-canonical alias to match the poll-loop lookup (hA = cfg.aliasMap[home_alias]).
      // Was keyed by SR alias -> silent miss -> inferior BDL fallback for GSV/WAS/PDX/LVA/LAS/NYL/TOY.
      const canonHome = cfg.aliasMap?.[homeAlias] || homeAlias;
      result[canonHome] = {
        homeSpread, homeML: bestHomeML, awayML: bestAwayML, total,
        homeMLBook: bestHomeMLBook, awayMLBook: bestAwayMLBook,
        homeMLConsensus, awayMLConsensus,
        books: (g.bookmakers || []).length,
      };
    }
    return result;
  } catch (e) {
    log(`Odds API error: ${e.message}`);
    return {};
  }
}

// Fetch tracking baselines (catch-and-shoot + pull-up eFG) — NBA only, season stats
// Called once per game, cached on game._trackingData
async function fetchTrackingData(hA, aA, season) {
  const hId = BDL_TEAMS[hA], aId = BDL_TEAMS[aA];
  if (!hId || !aId) return null;
  try {
    const s = season || '2025';
    function extractStats(resp) {
      const entry = resp?.data?.[0];
      return entry?.stats || entry || {};
    }
    const [hCAS, aCAS, hPU, aPU] = await Promise.all([
      bdlFetch(`/nba/v1/team_season_averages/shotdashboard?team_id=${hId}&season=${s}&season_type=regular&type=catch_and_shoot`),
      bdlFetch(`/nba/v1/team_season_averages/shotdashboard?team_id=${aId}&season=${s}&season_type=regular&type=catch_and_shoot`),
      bdlFetch(`/nba/v1/team_season_averages/shotdashboard?team_id=${hId}&season=${s}&season_type=regular&type=pullups`),
      bdlFetch(`/nba/v1/team_season_averages/shotdashboard?team_id=${aId}&season=${s}&season_type=regular&type=pullups`),
    ]);
    return {
      home: {
        catchAndShoot: { efg: extractStats(hCAS).effective_field_goal_percentage || extractStats(hCAS).efg_pct || null },
        pullUp: { efg: extractStats(hPU).effective_field_goal_percentage || extractStats(hPU).efg_pct || null },
      },
      away: {
        catchAndShoot: { efg: extractStats(aCAS).effective_field_goal_percentage || extractStats(aCAS).efg_pct || null },
        pullUp: { efg: extractStats(aPU).effective_field_goal_percentage || extractStats(aPU).efg_pct || null },
      },
    };
  } catch (e) {
    log(`Tracking data fetch failed for ${hA}/${aA}: ${e.message}`);
    return null;
  }
}

// Normalize player name for fuzzy matching (lowercase, strip Jr./Sr./III/II/IV, trim)
function normName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/i, '')
    .replace(/[.']/g, '')
    .trim();
}

// Merge BDL season averages onto SR summary players
// Attaches .average = { three_points_made, three_points_att, field_goals_made, field_goals_att }
// so the sustainability audit's player loop picks them up
function mergeBdlSeasonData(summary, bdlHomeSeason, bdlAwaySeason) {
  function mergeTeam(teamData, bdlStats) {
    if (!teamData?.players || !bdlStats || bdlStats.length === 0) return;
    // Build lookup by normalized name
    const bdlMap = {};
    for (const ps of bdlStats) {
      const pName = ps.player?.first_name && ps.player?.last_name
        ? `${ps.player.first_name} ${ps.player.last_name}`
        : '';
      const key = normName(pName);
      if (key) bdlMap[key] = ps;
    }

    for (const player of teamData.players) {
      const srName = player.full_name || player.name || '';
      const key = normName(srName);
      const bdl = bdlMap[key];
      if (!bdl) continue;

      // Attach season averages so sustainability audit reads them
      // BDL player_season_stats returns per-game averages
      player.average = {
        three_points_made: bdl.fg3m || 0,
        three_points_att: bdl.fg3a || 0,
        field_goals_made: bdl.fgm || 0,
        field_goals_att: bdl.fga || 0,
        points: bdl.pts || 0,
        rebounds: bdl.reb || 0,
        assists: bdl.ast || 0,
      };
    }
  }

  mergeTeam(summary.home, bdlHomeSeason);
  mergeTeam(summary.away, bdlAwaySeason);
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVER-SIDE BDL ADAPTERS
// Same logic as client — coordinateToZone, parseBDLPBP, buildSummaryFromBDL
// ══════════════════════════════════════════════════════════════════════════════

function normalizeBdlStatusServer(s, boxScore) {
  if (!s) return 'scheduled';
  const sl = s.toLowerCase();
  if (sl === 'final') return 'closed';
  if (sl === 'in progress' || sl.includes('qtr') || sl.includes('quarter') || sl.includes('overtime') || sl.includes(' ot') || sl === 'ot' || /^\d*\s*ot/i.test(sl)) return 'inprogress';
  if (sl === 'halftime' || sl.includes('half')) return 'halftime';
  // Datetime string — check box score for live signals (BDL sometimes returns
  // scheduled time as status even when game is in progress)
  if (s.includes('T') && s.includes(':')) {
    if (boxScore) {
      const hasScore = ((boxScore.home_team_score || 0) + (boxScore.visitor_team_score || 0)) > 0;
      const hasPeriod = (boxScore.period || 0) > 0;
      const hasTime = boxScore.time && boxScore.time !== '' && !boxScore.time.includes('T');
      const hasQtrScore = (boxScore.home_q1 || 0) > 0 || (boxScore.visitor_q1 || 0) > 0;
      const hasPlayers = boxScore.home_team && boxScore.home_team.players && boxScore.home_team.players.length > 0;
      if (hasScore || hasPeriod || hasTime || hasQtrScore || hasPlayers) return 'inprogress';
    }
    try { const _tipMs = new Date(s).getTime(); if (!isNaN(_tipMs) && Date.now() > _tipMs + 120000) return 'inprogress'; } catch(e) {}
    return 'scheduled';
  }
  return s;
}

const BDL_BASKET_X = 25, BDL_BASKET_Y = 1.5, BDL_RIM_RADIUS = 4, BDL_PAINT_RADIUS = 9, BDL_THREE_RADIUS = 22, BDL_CORNER_Y_MAX = 9;
function bdlCoordsValid(x, y) { return x != null && y != null && x > -1000 && y > -1000 && x < 1000 && y < 1000; }
function bdlDistFromBasket(x, y) { return Math.sqrt(Math.pow(x - BDL_BASKET_X, 2) + Math.pow(y - BDL_BASKET_Y, 2)); }

const BDL_RIM_SET = new Set(['layup shot','driving layup shot','running layup shot','cutting layup shot','reverse layup shot','finger roll layup','layup shot putback','putback layup shot','driving reverse layup shot','running reverse layup shot','dunk shot','driving dunk shot','running dunk shot','cutting dunk shot','alley oop dunk shot','putback dunk shot','running alley oop dunk shot','tip shot','tip dunk shot']);
const BDL_PAINT_SET = new Set(['driving floating jump shot','floating jump shot','driving hook shot','hook shot','running hook shot','driving finger roll layup','turnaround hook shot']);

function coordinateToZoneServer(x, y, shotType, text, scoreValue) {
  const tl = (shotType || '').toLowerCase().trim();
  const tx = (text || '').toLowerCase();
  const is3 = scoreValue === 3 || tx.includes('three point');
  if (BDL_RIM_SET.has(tl)) return 'rim';
  if (BDL_PAINT_SET.has(tl)) return 'paint';
  if (is3) { if (bdlCoordsValid(x, y) && y < BDL_CORNER_Y_MAX) return 'corner3'; return 'above3'; }
  if (bdlCoordsValid(x, y)) { const d = bdlDistFromBasket(x, y); if (d < BDL_RIM_RADIUS) return 'rim'; if (d < BDL_PAINT_RADIUS) return 'paint'; if (d >= BDL_THREE_RADIUS) return y < BDL_CORNER_Y_MAX ? 'corner3' : 'above3'; return 'mid'; }
  const dm = tx.match(/(\d+)-foot/); if (dm) { const dd = parseInt(dm[1]); if (dd <= 4) return 'rim'; if (dd <= 9) return 'paint'; if (dd >= 22) return 'above3'; return 'mid'; }
  if (tl.includes('layup') || tl.includes('dunk') || tl.includes('tip')) return 'rim';
  if (tl.includes('hook') || tl.includes('float')) return 'paint';
  return 'mid';
}

function bdlExtractPlayerS(t) { if (!t) return '?'; const c = t.replace(/\n/g, ' ').trim(); const m = c.match(/^([A-Z][a-zA-Z'.]+(?:[\s-][A-Z][a-zA-Z'.]+)*(?:\s+(?:Jr\.|Sr\.|III|II|IV))?)\s+(?:makes|misses|personal|shooting|loose|bad|offensive|defensive|lost|out|traveling|turnover|flagrant|double|blocks|steals|enters|steps|kicked)/i); if (m) return m[1].trim(); const m2 = c.match(/^(.+?)\s+(?:makes|misses|personal|shooting|offensive|defensive|bad|loose|lost|blocks|steals)/i); if (m2) return m2[1].trim(); return c.split(/\s+/).slice(0, 2).join(' '); }
function bdlExtractAssistS(t) { if (!t) return null; const m = t.match(/\(([^)]+?)\s+assists?\)/i); return m ? m[1].trim() : null; }
function bdlExtractBlockS(t) { if (!t) return null; const m = t.match(/\(([^)]+?)\s+blocks?\)/i); if (m) return m[1].trim(); const m2 = t.match(/([A-Z][a-zA-Z'.]+(?:[\s-][A-Z][a-zA-Z'.]+)*)\s+blocks\s/i); return m2 ? m2[1].trim() : null; }
function bdlExtractStealS(t) { if (!t) return null; const m = t.match(/\(([^)]+?)\s+steals?\)/i); return m ? m[1].trim() : null; }
function bdlClassifyContextS(type, assisted, isThree) { const t = (type || '').toLowerCase(); if (t.includes('driving') || t.includes('layup') || t.includes('dunk')) return 'drive'; if (t.includes('pullup') || t.includes('step back') || t.includes('fadeaway')) return 'pullup'; if (t.includes('putback') || t.includes('tip')) return 'putback'; if (t.includes('cutting') || t.includes('alley')) return 'cut'; if (t.includes('hook') || t.includes('float')) return 'floater'; if (t.includes('running') && !t.includes('pullup')) return 'transition'; if (assisted && isThree) return 'catch-shoot'; return 'halfcourt'; }
function bdlClassifyTOS(type, text) { const t = (type || '').toLowerCase(); const tx = (text || '').toLowerCase(); if (tx.includes('steal')) return { forced: true, type: t }; if (t.includes('bad pass')) return { forced: true, type: t }; if (t.includes('traveling') || t.includes('out of bounds') || t.includes('3-second') || t.includes('shot clock') || t.includes('offensive foul') || t.includes('double dribble') || t.includes('backcourt') || t.includes('kicked ball')) return { forced: false, type: t }; return { forced: null, type: t }; }

// Server-side parseBDLPBP — same as client but returns perQuarter for sub-metric arrows
function parseBDLPBPServer(plays, homeAbbr, awayAbbr) {
  if (!plays || plays.length === 0) return null;
  const hA = homeAbbr, aA = awayAbbr;
  const shots = [], turnovers = [], scoreLog = [], runs = [];
  let hScore = 0, aScore = 0, bigH = 0, bigA = 0;
  let pendPOT = null, pendOREB = null, potH = 0, potA = 0, scpH = 0, scpA = 0, lastP = 0;

  const sorted = plays.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  sorted.forEach(ev => {
    const type = (ev.type || '').trim(), tl = type.toLowerCase();
    const text = (ev.text || '').replace(/\n/g, ' ').trim(), tx = text.toLowerCase();
    const tAbbr = ev.team?.abbreviation || '';
    const team = tAbbr === hA ? hA : tAbbr === aA ? aA : tAbbr || '?';
    const player = bdlExtractPlayerS(text);
    const quarter = ev.period || 0;
    const hs = ev.home_score ?? null, as = ev.away_score ?? null;

    if (quarter !== lastP && lastP > 0) { pendPOT = null; pendOREB = null; }
    lastP = quarter;
    if (hs != null && as != null) { const mg = hs - as; if (mg > bigH) bigH = mg; if (-mg > bigA) bigA = -mg; }
    if (tl.includes('substitution') || tx.includes('enters the game for')) return;

    const _isShotPlay = ev.shooting_play != null ? ev.shooting_play : /shot|layup|dunk|hook|tip|free throw/.test(tl);
    if (_isShotPlay) {
      const made = ev.scoring_play || false;
      const is3 = ev.score_value === 3 || tx.includes('three point');
      let pts = made ? (ev.score_value || (is3 ? 3 : 2)) : 0;
      const zone = coordinateToZoneServer(ev.coordinate_x, ev.coordinate_y, type, text, ev.score_value);

      if (tl.includes('free throw')) {
        pts = made ? 1 : 0;
        if (made) {
          if (team === hA) hScore += 1; else aScore += 1;
          scoreLog.push({ team, pts: 1, hScore, aScore, q: quarter });
          if (pendOREB === team) { if (team === hA) scpH += 1; else scpA += 1; }
          if (pendPOT === team) { if (team === hA) potH += 1; else potA += 1; }
        }
        const ftM = type.match(/(\d+)\s*of\s*(\d+)/i);
        if (ftM && ftM[1] === ftM[2] && made) { pendOREB = null; pendPOT = null; }
        return;
      }

      const assisted = made ? !!bdlExtractAssistS(text) : false;
      const context = bdlClassifyContextS(type, assisted, is3);
      shots.push({ p: player, tm: team, z: zone, m: made, a: assisted, q: quarter, ctx: context, is3, x: ev.coordinate_x ?? null, y: ev.coordinate_y ?? null });
      if (made) {
        if (team === hA) hScore += pts; else aScore += pts;
        scoreLog.push({ team, pts, hScore, aScore, q: quarter });
        if (pendOREB === team) { if (team === hA) scpH += pts; else scpA += pts; }
        if (pendPOT === team) { if (team === hA) potH += pts; else potA += pts; }
        pendOREB = null; pendPOT = null;
      }
      return;
    }

    if (tl.includes('turnover')) {
      const tc = bdlClassifyTOS(type, text);
      turnovers.push({ p: player, tm: team, q: quarter, forced: tc.forced, type: tc.type });
      pendOREB = null;
      pendPOT = team === hA ? aA : hA;
      return;
    }

    if (tl.includes('rebound')) {
      if (tx.includes('team rebound')) { pendOREB = null; pendPOT = null; return; } // dead ball — not in box score stats
      if (tl.includes('offensive')) pendOREB = team;
      else { pendOREB = null; pendPOT = null; }
      return;
    }

    if (tl.includes('foul') && tl.includes('offensive')) {
      pendOREB = null; pendPOT = team === hA ? aA : hA;
    }

    if (tl.includes('end period') || tl.includes('end game')) {
      pendPOT = null; pendOREB = null;
    }
  });

  // Runs
  let rTm = null, rPts = 0, rSt = 0, rCt = 0, rST = [];
  for (let i = 0; i < scoreLog.length; i++) {
    const s = scoreLog[i];
    if (s.team === rTm) { rPts += s.pts; rCt++; rST.push(s.pts === 3 ? '3PT' : s.pts === 1 ? 'FT' : '2PT'); }
    else { if (rPts >= 8 || rCt >= 3) runs.push({ team: rTm, pts: rPts, count: rCt, q: scoreLog[rSt]?.q, mechanism: rST.slice(), si: rSt, ei: i - 1 }); rTm = s.team; rPts = s.pts; rSt = i; rCt = 1; rST = [s.pts === 3 ? '3PT' : s.pts === 1 ? 'FT' : '2PT']; }
  }
  if (rPts >= 8 || rCt >= 3) runs.push({ team: rTm, pts: rPts, count: rCt, q: scoreLog[rSt]?.q, mechanism: rST.slice(), si: rSt, ei: scoreLog.length - 1 });
  runs.sort((a, b) => b.ei - a.ei);

  // I5 runs — separate 6+ pts threshold (don't modify existing 8+ runs)
  const runs6 = [];
  { let r6Tm = null, r6Pts = 0;
    for (let i = 0; i < scoreLog.length; i++) {
      const s = scoreLog[i];
      if (s.team === r6Tm) { r6Pts += s.pts; }
      else { if (r6Pts >= 6 && r6Tm) runs6.push({ team: r6Tm, pts: r6Pts }); r6Tm = s.team; r6Pts = s.pts; }
    }
    if (r6Pts >= 6 && r6Tm) runs6.push({ team: r6Tm, pts: r6Pts });
  }

  // Aggregates (same shape as SR parsePBPServer aggTeam)
  function aggTeam(tm) {
    const s = shots.filter(x => x.tm === tm);
    const threes = s.filter(x => x.is3), rim = s.filter(x => x.z === 'rim'), paint = s.filter(x => x.z === 'paint'), mid = s.filter(x => x.z === 'mid');
    const threeMade = threes.filter(x => x.m), rimMade = rim.filter(x => x.m), midMade = mid.filter(x => x.m);
    const assistedThrees = threeMade.filter(x => x.a).length;
    const tms = turnovers.filter(t => t.tm === tm);
    return {
      threes: { made: threeMade.length, att: threes.length, assisted: assistedThrees, pct: threes.length > 0 ? (threeMade.length / threes.length * 100).toFixed(1) : '0',
        corner: { made: threeMade.filter(x => x.z === 'corner3').length, att: threes.filter(x => x.z === 'corner3').length },
        above: { made: threeMade.filter(x => x.z === 'above3').length, att: threes.filter(x => x.z === 'above3').length },
        byPlayer: [] },
      rim: { made: rimMade.length, att: rim.length, pct: rim.length > 0 ? (rimMade.length / rim.length * 100).toFixed(1) : '0', byPlayer: [] },
      paint: { made: paint.filter(x => x.m).length, att: paint.length, pct: paint.length > 0 ? (paint.filter(x => x.m).length / paint.length * 100).toFixed(1) : '0' },
      mid: { made: midMade.length, att: mid.length, assisted: midMade.filter(x => x.a).length, pct: mid.length > 0 ? (midMade.length / mid.length * 100).toFixed(1) : '0', byPlayer: [] },
      tos: { total: tms.length, forced: tms.filter(t => t.forced === true).length, unforced: tms.filter(t => t.forced === false).length, unknown: tms.filter(t => t.forced === null).length },
      shotDiet: { total: s.length, threePct: s.length > 0 ? (threes.length / s.length * 100).toFixed(1) : '0', rimPct: s.length > 0 ? (rim.length / s.length * 100).toFixed(1) : '0', midPct: s.length > 0 ? (mid.length / s.length * 100).toFixed(1) : '0' },
    };
  }

  // Build scoringEvents from scoreLog (includes FTs, has running margin)
  const scoringEvents = scoreLog.map(s => ({
    tm: s.team, pts: s.pts, q: s.q,
    type: s.pts === 3 ? '3PT' : s.pts === 1 ? 'FT' : '2PT',
    m: s.aScore - s.hScore
  }));

  return {
    home: aggTeam(hA), away: aggTeam(aA),
    homeAlias: hA, awayAlias: aA,
    totalShots: shots.length, totalTOs: turnovers.length,
    runs: runs.slice(0, 10),
    runs6,
    scoringEvents,
    raw: { shots, turnovers },
    perQuarter: buildPerQuarterMetrics(shots, turnovers, hA, aA),
    pbpPeriod: lastP, pbpAge: 0,
    possLog: buildPossLogServer(sorted, hA, aA),
    _bdl: { potHome: potH, potAway: potA, scpHome: scpH, scpAway: scpA, biggestLeadHome: bigH, biggestLeadAway: bigA, scoreLog },
  };
}

// ── POSSESSION LOG & WINDOW (for MC canary + VULNERABILITY legacy) ──────────────────
// Walks sorted BDL plays, segments into possessions.
// Possession boundary: made shot (non-FT or final FT), turnover, defensive rebound, offensive foul, end of period.
function buildPossLogServer(sorted, hA, aA) {
  if (!sorted || sorted.length < 20) return null;
  const possessions = [];
  let cur = null;

  function flush() {
    if (cur && cur.team) possessions.push(cur);
    cur = { team: null, pts: 0, fgm: 0, fga: 0, fg3m: 0, fg3a: 0, ast: 0, tos: 0, stl: 0, oreb: 0, dreb: 0, fta: 0, ftm: 0, q: 0 };
  }
  flush();

  for (const ev of sorted) {
    const type = (ev.type || '').trim(), tl = type.toLowerCase();
    const text = (ev.text || '').toLowerCase();
    const tAbbr = ev.team?.abbreviation || '';
    const team = tAbbr === hA ? hA : tAbbr === aA ? aA : '';
    if (!team) continue;
    const quarter = ev.period || 0;
    if (tl.includes('substitution') || text.includes('enters the game for')) continue;

    // End of period = flush
    if (tl.includes('end period') || tl.includes('end game')) { flush(); continue; }

    // Set possession team on first meaningful event
    if (!cur.team) { cur.team = team; cur.q = quarter; }

    // Free throws — don't end possession unless final FT
    if (tl.includes('free throw')) {
      const made = ev.scoring_play || false;
      cur.fta++;
      if (made) { cur.ftm++; cur.pts++; }
      const ftM = type.match(/(\d+)\s*of\s*(\d+)/i);
      if (ftM && ftM[1] === ftM[2] && made) flush(); // final FT made = end possession
      continue;
    }

    // Shooting play (non-FT)
    const _isShotPlay2 = ev.shooting_play != null ? ev.shooting_play : /shot|layup|dunk|hook|tip/.test(tl);
    if (_isShotPlay2) {
      const made = ev.scoring_play || false;
      const is3 = ev.score_value === 3 || text.includes('three point');
      cur.fga++;
      if (is3) cur.fg3a++;
      if (made) {
        cur.fgm++;
        const pts = ev.score_value || (is3 ? 3 : 2);
        cur.pts += pts;
        if (is3) cur.fg3m++;
        if ((ev.text || '').toLowerCase().includes('ast')) cur.ast++;
        flush(); // made shot = end possession
      }
      continue;
    }

    // Turnover = end possession, credit steal to opponent
    if (tl.includes('turnover')) {
      cur.tos++;
      flush();
      const oppTeam = team === hA ? aA : hA;
      cur.team = oppTeam; cur.q = quarter;
      if (text.includes('steal')) cur.stl++; // only credit steal when explicitly in play text
      continue;
    }

    // Rebound
    if (tl.includes('rebound')) {
      if (text.includes('team rebound')) continue; // dead ball — not in box score stats
      if (tl.includes('offensive')) {
        cur.oreb++; // possession continues
      } else {
        // Defensive rebound = new possession for rebounding team
        flush();
        cur.team = team; cur.q = quarter; cur.dreb++;
      }
      continue;
    }

    // Offensive foul = turnover equivalent
    if (tl.includes('foul') && tl.includes('offensive')) {
      flush();
      continue;
    }
  }
  flush(); // final possession
  return possessions.filter(p => p.team); // drop empty
}

// Score I1-I5 on last N possessions. Returns ctrl-team-relative score 0-1.
// score > 0.5 = ctrl team winning the window; score < 0.5 = opponent winning.
function computePossWindowServer(possLog, windowSize, hA, aA) {
  if (!possLog || possLog.length < windowSize) return { available: false };
  const window = possLog.slice(-windowSize);

  const hPoss = window.filter(p => p.team === hA), aPoss = window.filter(p => p.team === aA);
  const hPts = hPoss.reduce((s, p) => s + p.pts, 0), aPts = aPoss.reduce((s, p) => s + p.pts, 0);
  const hStl = hPoss.reduce((s, p) => s + p.stl, 0), aStl = aPoss.reduce((s, p) => s + p.stl, 0);
  const hFGM = hPoss.reduce((s, p) => s + p.fgm, 0), aFGM = aPoss.reduce((s, p) => s + p.fgm, 0);
  const hFGA = hPoss.reduce((s, p) => s + p.fga, 0), aFGA = aPoss.reduce((s, p) => s + p.fga, 0);
  const hFG3M = hPoss.reduce((s, p) => s + p.fg3m, 0), aFG3M = aPoss.reduce((s, p) => s + p.fg3m, 0);
  const hAst = hPoss.reduce((s, p) => s + p.ast, 0), aAst = aPoss.reduce((s, p) => s + p.ast, 0);
  const hTos = hPoss.reduce((s, p) => s + p.tos, 0), aTos = aPoss.reduce((s, p) => s + p.tos, 0);

  // eFG%
  const hEFG = hFGA > 0 ? (hFGM + 0.5 * hFG3M) / hFGA : 0;
  const aEFG = aFGA > 0 ? (aFGM + 0.5 * aFG3M) / aFGA : 0;
  // 2PT scoring (interior proxy — exclude 3s)
  const h2pts = hPoss.reduce((s, p) => s + (p.fgm - p.fg3m) * 2 + p.ftm, 0);
  const a2pts = aPoss.reduce((s, p) => s + (p.fgm - p.fg3m) * 2 + p.ftm, 0);
  // Assist rate
  const hAstR = hFGM > 0 ? hAst / hFGM : 0, aAstR = aFGM > 0 ? aAst / aFGM : 0;
  // PPP
  const hPPP = hPoss.length > 0 ? hPts / hPoss.length : 0, aPPP = aPoss.length > 0 ? aPts / aPoss.length : 0;

  // Normalize diffs to 0-1 scale (clamp with sigmoid-like mapping)
  function norm(diff, scale) { return 0.5 + 0.5 * Math.max(-1, Math.min(1, diff / scale)); }

  const i1 = norm(hStl - aStl, 3);         // I1: Steals diff (disruption)
  const i2 = norm(h2pts - a2pts, 8);        // I2: 2PT scoring (interior)
  const i3 = norm((hEFG - aEFG) * 10 + (hAstR - aAstR) * 2, 3); // I3: eFG + assist rate
  const i4 = norm(hPts - aPts, 10);         // I4: Points diff (game control)
  const i5 = norm(hPPP - aPPP, 0.3);        // I5: PPP diff (efficiency)

  // Weighted composite (same weights as framework)
  const score = i1 * 0.25 + i2 * 0.25 + i3 * 0.20 + i4 * 0.20 + i5 * 0.10;
  const controlTeam = score >= 0.5 ? hA : aA;

  return { available: true, score, controlTeam, i1, i2, i3, i4, i5, windowSize, possCount: window.length };
}

// ══════════════════════════════════════════════════════════════════════════════
// MONTE CARLO ENGINE — possession-level simulation for structural collapse detection
// ══════════════════════════════════════════════════════════════════════════════

// Simulate a single possession given team rates → returns points scored
function simulatePossessionMC(rates) {
  if (Math.random() < rates.toRate) return 0;
  var shotPts = 0, isMake = false;
  if (Math.random() < rates.fg3aShare) {
    isMake = Math.random() < rates.fg3Pct;
    if (isMake) shotPts = 3;
  } else {
    isMake = Math.random() < rates.fg2Pct;
    if (isMake) shotPts = 2;
  }
  if (!isMake && Math.random() < rates.orebRate) {
    if (Math.random() < rates.fg2Pct) shotPts = 2;
  }
  if (Math.random() < rates.ftaRate / 2) {
    if (Math.random() < rates.ftPct) shotPts += 1;
    if (Math.random() < rates.ftPct) shotPts += 1;
  }
  return shotPts;
}

// Run N simulations from current score → ctrl team win probability + margin distribution
function runMonteCarloSim(homeRates, awayRates, homeScore, awayScore, remainPoss, opts) {
  var simCount = (opts && opts.simCount) || 500;
  var ctrlIsHome = (opts && opts.ctrlTeam === 'away') ? false : true;
  var margins = new Array(simCount);
  var ctrlWins = 0, leadLost = 0;
  var currentMargin = homeScore - awayScore;
  var ctrlMargin = ctrlIsHome ? currentMargin : -currentMargin;
  var ctrlLeading = ctrlMargin > 0;
  for (var s = 0; s < simCount; s++) {
    var hScore = homeScore, aScore = awayScore;
    var hPoss = Math.round(remainPoss), aPoss = Math.round(remainPoss);
    var homeHasBall = Math.random() < 0.5;
    while (hPoss > 0 || aPoss > 0) {
      if (homeHasBall) { if (hPoss > 0) { hScore += simulatePossessionMC(homeRates); hPoss--; } }
      else { if (aPoss > 0) { aScore += simulatePossessionMC(awayRates); aPoss--; } }
      homeHasBall = !homeHasBall;
    }
    var finalMargin = ctrlIsHome ? (hScore - aScore) : (aScore - hScore);
    margins[s] = finalMargin;
    if (finalMargin > 0) ctrlWins++;
    else if (finalMargin === 0) ctrlWins += 0.5;
    if (ctrlLeading && finalMargin <= 0) leadLost++;
  }
  margins.sort(function(a, b) { return a - b; });
  return {
    winProb: Math.round(ctrlWins / simCount * 1000) / 1000,
    collapseProb: ctrlLeading ? Math.round(leadLost / simCount * 1000) / 1000 : null,
    medianMargin: margins[Math.floor(simCount * 0.50)],
    margin10pct: margins[Math.floor(simCount * 0.10)],
    margin90pct: margins[Math.floor(simCount * 0.90)],
    currentMargin: ctrlMargin,
    simCount: simCount,
    remainingPoss: Math.round(remainPoss),
  };
}

// Diff two cumulative stat objects to get window rates for MC sim
function diffToRatesMC(curr, prev, seasonFg3Pct, regressionCap) {
  var cap = regressionCap || 0.60;
  var fga = (Number(curr.fga)||0) - (Number(prev.fga)||0);
  var fgm = (Number(curr.fgm)||0) - (Number(prev.fgm)||0);
  var fg3a = (Number(curr.fg3a)||0) - (Number(prev.fg3a)||0);
  var fg3m = (Number(curr.fg3m)||0) - (Number(prev.fg3m)||0);
  var fta = (Number(curr.fta)||0) - (Number(prev.fta)||0);
  var ftm = (Number(curr.ftm)||0) - (Number(prev.ftm)||0);
  var to = (Number(curr.to)||0) - (Number(prev.to)||0);
  var oreb = (Number(curr.oreb)||0) - (Number(prev.oreb)||0);
  var fg2a = fga - fg3a, fg2m = fgm - fg3m;
  var poss = fga + 0.44 * fta - oreb + to;
  if (poss < 3) poss = Math.max(fga, 3);
  if (fga < 5) return null;
  var toRate = poss > 0 ? to / poss : 0.12;
  var fg3aShare = fga > 0 ? fg3a / fga : 0.35;
  var rawFg3Pct = fg3a > 0 ? fg3m / fg3a : 0.36;
  var fg2Pct = fg2a > 0 ? fg2m / fg2a : 0.50;
  var orebRate = (fga - fgm) > 0 ? oreb / (fga - fgm) : 0.25;
  var ftaRate = poss > 0 ? fta / poss : 0.20;
  var ftPct = fta > 0 ? ftm / fta : 0.76;
  var baseline = seasonFg3Pct || 0.36;
  var sampleWeight = Math.min(cap, fg3a / 30);
  var fg3Pct = rawFg3Pct * sampleWeight + baseline * (1 - sampleWeight);
  function clamp(v) { return Math.max(0, Math.min(1, v)); }
  return {
    toRate: clamp(toRate), fg3aShare: clamp(fg3aShare), fg3Pct: clamp(fg3Pct),
    fg2Pct: clamp(fg2Pct), orebRate: clamp(orebRate), ftaRate: Math.min(ftaRate, 1.0),
    ftPct: clamp(ftPct), _windowPoss: Math.round(poss), _windowFGA: fga,
  };
}

// Extract MC rates from possLog (PBP-derived) — last N possessions per team
function extractMCRatesFromPossLog(possLog, windowSize, hA, aA, hBaseline, aBaseline) {
  if (!possLog || possLog.length < windowSize) return null;
  var window = possLog.slice(-windowSize);
  function aggSide(tm) {
    var p = window.filter(function(x) { return x.team === tm; });
    return {
      fgm: p.reduce(function(s,x){return s+x.fgm;},0), fga: p.reduce(function(s,x){return s+x.fga;},0),
      fg3m: p.reduce(function(s,x){return s+x.fg3m;},0), fg3a: p.reduce(function(s,x){return s+x.fg3a;},0),
      ftm: p.reduce(function(s,x){return s+x.ftm;},0), fta: p.reduce(function(s,x){return s+x.fta;},0),
      to: p.reduce(function(s,x){return s+x.tos;},0), oreb: p.reduce(function(s,x){return s+x.oreb;},0),
      poss: p.length,
    };
  }
  var hAgg = aggSide(hA), aAgg = aggSide(aA);
  // Build rates directly from aggregates (no diff — these are raw window totals)
  function buildRates(agg, baseline) {
    var fga = agg.fga, fgm = agg.fgm, fg3a = agg.fg3a, fg3m = agg.fg3m;
    var fta = agg.fta, ftm = agg.ftm, to = agg.to, oreb = agg.oreb;
    var fg2a = fga - fg3a, fg2m = fgm - fg3m;
    var poss = agg.poss;
    if (poss < 3 || fga < 3) return null;
    var bl = baseline || 0.36;
    var rawFg3 = fg3a > 0 ? fg3m / fg3a : bl;
    var sw = Math.min(0.60, fg3a / 30);
    function clamp(v) { return Math.max(0, Math.min(1, v)); }
    return {
      toRate: clamp(poss > 0 ? to / poss : 0.12),
      fg3aShare: clamp(fga > 0 ? fg3a / fga : 0.35),
      fg3Pct: clamp(rawFg3 * sw + bl * (1 - sw)),
      fg2Pct: clamp(fg2a > 0 ? fg2m / fg2a : 0.50),
      orebRate: clamp((fga - fgm) > 0 ? oreb / (fga - fgm) : 0.25),
      ftaRate: Math.min(poss > 0 ? fta / poss : 0.20, 1.0),
      ftPct: clamp(fta > 0 ? ftm / fta : 0.76),
      _windowPoss: poss, _windowFGA: fga,
    };
  }
  var hRates = buildRates(hAgg, hBaseline);
  var aRates = buildRates(aAgg, aBaseline);
  if (!hRates || !aRates) return null;
  return { home: hRates, away: aRates };
}

// Estimate remaining possessions per team from cumulative stats + clock
function estimateRemainingPossMC(homeStats, awayStats, period, clockSec, league) {
  function estPoss(s) {
    var fga = Number(s.fga || s.field_goals_att || 0) || 0;
    var fta = Number(s.fta || s.free_throws_att || 0) || 0;
    var oreb = Number(s.oreb || s.offensive_rebounds || 0) || 0;
    var to = Number(s.to || s.turnovers || s.total_turnovers || 0) || 0;
    return fga + 0.44 * fta - oreb + to;
  }
  var hPoss = estPoss(homeStats), aPoss = estPoss(awayStats);
  var avgPoss = (hPoss + aPoss) / 2;
  var qMin = (LEAGUES[league]?.quarterMinutes) || 12;
  var gameMin = (LEAGUES[league]?.gameMinutes) || 48;
  var elapsedMin = (Math.min(period, 4) - 1) * qMin + (qMin - clockSec / 60);
  if (elapsedMin < 1) elapsedMin = 1;
  var remainMin = gameMin - elapsedMin;
  if (remainMin < 0) remainMin = 0;
  var pacePerMin = avgPoss / elapsedMin;
  return Math.max(0, Math.round(pacePerMin * remainMin));
}

// ── MC CUMULATIVE — game-rate simulation (always-on Q2+) ──────────────────────
// Uses full cumulative box score rates (not PBP window).
// MC Cum AUC=0.7938 — best single signal. Beats XGB in disagreements 70-87%.
function extractMCRatesFromCumulative(stats, seasonFg3Pct, league) {
  var defaults = getMCDefaults(league);
  var fga = Number(stats.field_goals_att || stats.fga || 0) || 0;
  var fgm = Number(stats.field_goals_made || stats.fgm || 0) || 0;
  var fg3a = Number(stats.three_points_att || stats.fg3a || 0) || 0;
  var fg3m = Number(stats.three_points_made || stats.fg3m || 0) || 0;
  var fta = Number(stats.free_throws_att || stats.fta || 0) || 0;
  var ftm = Number(stats.free_throws_made || stats.ftm || 0) || 0;
  var to = Number(stats.turnovers || stats.total_turnovers || stats.to || 0) || 0;
  var oreb = Number(stats.offensive_rebounds || stats.oreb || 0) || 0;
  var fg2a = fga - fg3a, fg2m = fgm - fg3m;
  var poss = fga + 0.44 * fta - oreb + to;
  if (poss < 3) poss = Math.max(fga, 3);
  if (fga < 10) return null; // cumulative should always pass by Q2
  var rawFg3Pct = fg3a > 0 ? fg3m / fg3a : defaults.fg3Pct;
  var baseline = seasonFg3Pct || defaults.fg3Pct;
  // Heavier regression cap for cumulative (more data = trust raw more)
  var sampleWeight = Math.min(0.75, fg3a / 30);
  var fg3Pct = rawFg3Pct * sampleWeight + baseline * (1 - sampleWeight);
  function clamp(v) { return Math.max(0, Math.min(1, v)); }
  return {
    toRate: clamp(poss > 0 ? to / poss : defaults.toRate),
    fg3aShare: clamp(fga > 0 ? fg3a / fga : defaults.fg3aShare),
    fg3Pct: clamp(fg3Pct),
    fg2Pct: clamp(fg2a > 0 ? fg2m / fg2a : defaults.fg2Pct),
    orebRate: clamp((fga - fgm) > 0 ? oreb / (fga - fgm) : defaults.orebRate),
    ftaRate: Math.min(poss > 0 ? fta / poss : defaults.ftaRate, 1.0),
    ftPct: clamp(fta > 0 ? ftm / fta : defaults.ftPct),
    _cumPoss: Math.round(poss), _cumFGA: fga,
  };
}

function computeMCCumulative(summary, period, clockSec, controlTeam, hA, hBaseline, aBaseline, league) {
  if (period < 2) return null;
  var homeStats = summary.home?.statistics || {};
  var awayStats = summary.away?.statistics || {};
  var homeRates = extractMCRatesFromCumulative(homeStats, hBaseline, league);
  var awayRates = extractMCRatesFromCumulative(awayStats, aBaseline, league);
  if (!homeRates || !awayRates) return null;
  var remainPoss = estimateRemainingPossMC(homeStats, awayStats, period, clockSec, league);
  var ctrlIsHome = controlTeam === hA;
  if (remainPoss <= 0) {
    var hPts = Number(summary.home?.points || 0), aPts = Number(summary.away?.points || 0);
    var wp = hPts === aPts ? 0.5 : (ctrlIsHome ? (hPts > aPts ? 1.0 : 0.0) : (aPts > hPts ? 1.0 : 0.0));
    return { winProb: wp, medianMargin: ctrlIsHome ? hPts - aPts : aPts - hPts, remainPoss: 0, homeRates, awayRates };
  }
  var result = runMonteCarloSim(homeRates, awayRates,
    Number(summary.home?.points || 0), Number(summary.away?.points || 0),
    remainPoss, { simCount: 500, ctrlTeam: ctrlIsHome ? 'home' : 'away' });
  return {
    winProb: result.winProb,
    medianMargin: result.medianMargin,
    remainPoss: result.remainingPoss,
    homeRates: homeRates,
    awayRates: awayRates,
  };
}

// ── MC RATE DECOMPOSITION — which rates are driving MC win probability ─────
// Swaps each ctrl-team rate to league default, measures WP delta.
// ~1,400 sims (~1ms). Purely narrative — no gates or decisions depend on this.
var MC_NBA_DEFAULTS = {
  toRate: 0.13, fg3aShare: 0.35, fg3Pct: 0.36, fg2Pct: 0.52,
  orebRate: 0.25, ftaRate: 0.22, ftPct: 0.76,
};
function getMCDefaults(league) {
  return LEAGUES[league]?.mcDefaults || MC_NBA_DEFAULTS;
}
var MC_DEFAULT_RATES = MC_NBA_DEFAULTS; // backward compat
var MC_RATE_LABELS = {
  toRate: 'turnover discipline', fg3aShare: '3PT volume',
  fg3Pct: '3PT shooting', fg2Pct: 'interior finishing',
  orebRate: 'offensive rebounding', ftaRate: 'free throw generation',
  ftPct: 'free throw accuracy',
};

function computeMCDrivers(mcCumResult, ctrlIsHome, homeScore, awayScore, ctrlSeasonRates, league) {
  if (!mcCumResult || !mcCumResult.homeRates || !mcCumResult.awayRates) return null;
  var baseWP = mcCumResult.winProb;
  var hRates = mcCumResult.homeRates, aRates = mcCumResult.awayRates;
  var remainPoss = mcCumResult.remainPoss;
  if (remainPoss <= 0) return null;
  var defaults = getMCDefaults(league);

  // Use per-team season rates as baseline, fall back to league defaults
  var baseline = ctrlSeasonRates || defaults;

  // For each rate dimension on CTRL team, swap to season baseline
  // delta = baseWP - WP(with ctrl rate at season avg) → positive = game rate helping
  var drivers = [];
  var rateKeys = Object.keys(defaults);
  for (var i = 0; i < rateKeys.length; i++) {
    var key = rateKeys[i];
    var modH = Object.assign({}, hRates);
    var modA = Object.assign({}, aRates);
    // Neutralize ctrl team's rate to their season baseline
    if (ctrlIsHome) { modH[key] = baseline[key] || defaults[key]; }
    else { modA[key] = baseline[key] || defaults[key]; }
    var modResult = runMonteCarloSim(modH, modA,
      homeScore, awayScore, remainPoss,
      { simCount: 500, ctrlTeam: ctrlIsHome ? 'home' : 'away' });
    var delta = baseWP - modResult.winProb;
    var ctrlVal = ctrlIsHome ? hRates[key] : aRates[key];
    var oppVal = ctrlIsHome ? aRates[key] : hRates[key];
    var baselineVal = baseline[key] || MC_DEFAULT_RATES[key];
    drivers.push({
      rate: key, label: MC_RATE_LABELS[key],
      delta: Math.round(delta * 1000) / 1000,
      ctrlVal: Math.round(ctrlVal * 1000) / 1000,
      oppVal: Math.round(oppVal * 1000) / 1000,
      seasonVal: Math.round(baselineVal * 1000) / 1000,
    });
  }
  drivers.sort(function(a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
  return drivers;
}

// Classify MC verdict from single poll's post-trigger MC win probability
function classifyMCVerdict(mcWinProb) {
  if (mcWinProb <= 0.25) return 'CONF';
  if (mcWinProb <= 0.40) return 'LIKELY';
  if (mcWinProb <= 0.60) return 'CONT';
  return 'NORM';
}

// Classify pattern from verdict sequence
function classifyMCPattern(verdicts) {
  if (!verdicts || verdicts.length < 3) return null;
  // Need at least one non-INV verdict
  var meaningful = verdicts.filter(function(v) { return v !== 'INV'; });
  if (meaningful.length < 2) return null;
  var hitConfLikely = meaningful.some(function(v) { return v === 'CONF' || v === 'LIKELY'; });
  var hitNorm = meaningful.some(function(v) { return v === 'NORM'; });
  if (!hitConfLikely) {
    // Never reached LIKELY/CONF
    if (meaningful.length >= 3) return 'FALSE_ALARM';
    return null; // still classifying
  }
  if (!hitNorm) return 'CLEAN'; // hit LIKELY/CONF but never recovered
  // Check if it recovered then collapsed again (WAVE)
  var lastConf = -1, lastNorm = -1;
  for (var i = meaningful.length - 1; i >= 0; i--) {
    if (lastConf === -1 && (meaningful[i] === 'CONF' || meaningful[i] === 'LIKELY')) lastConf = i;
    if (lastNorm === -1 && meaningful[i] === 'NORM') lastNorm = i;
  }
  if (lastConf > lastNorm) return 'WAVE'; // collapsed after recovering
  return 'NORMALIZED'; // recovered and stayed recovered
}

// Normalize BDL clock format — strips period prefix, handles sub-minute and special labels
// BDL returns: "Q4 8:03", "Q3 :15.2", "END Q1", "Half", "Final", "PT04M32S", "8:03"
function normalizeBdlClockServer(time) {
  if (!time) return '';
  if (time === 'Final' || time === 'final') return '00:00';
  if (/^END\s|^Half/i.test(time)) return '0:00';
  // Period-prefixed: "Q4 8:03" or "Q3 :15.2" or "OT1 3:22"
  const qMatch = time.match(/^(?:Q\d+|OT\d?)\s+(.+)$/i);
  if (qMatch) return normalizeBdlClockServer(qMatch[1]);
  // Sub-minute: ":45.0" or ":08.9"
  if (/^:\d/.test(time)) {
    const secs = parseFloat(time.substring(1));
    if (!isNaN(secs)) return '0:' + String(Math.floor(secs)).padStart(2, '0');
  }
  // Already MM:SS
  if (/^\d{1,2}:\d{2}(\.\d)?$/.test(time)) return time;
  // ISO duration PT04M32S
  const iso = time.match(/PT(\d+)M(\d+)(?:\.(\d+))?S/);
  if (iso) return iso[1] + ':' + iso[2].padStart(2, '0');
  // Seconds only
  if (/^\d+(\.\d+)?$/.test(time)) {
    const sec = parseFloat(time);
    return Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
  }
  return time;
}

// Server-side buildSummaryFromBDL — builds SR summary shape from BDL box score + PBP
function buildSummaryFromBDLServer(boxScore, pbpResult, lineupsArr) {
  const game = boxScore || {};
  const bdl = pbpResult?._bdl || {};
  const homeTeam = game.home_team?.team || game.home_team || {};
  const awayTeam = game.visitor_team?.team || game.visitor_team || {};
  const hA = homeTeam.abbreviation || 'HOME', aA = awayTeam.abbreviation || 'AWAY';
  const homePlayers = game.home_team?.players || [];
  const awayPlayers = game.visitor_team?.players || [];
  const hSIds = new Set(), aSIds = new Set();
  if (lineupsArr) lineupsArr.forEach(l => { if (!l.starter) return; const ab = l.team?.abbreviation || ''; if (ab === hA) hSIds.add(l.player?.id); else if (ab === aA) aSIds.add(l.player?.id); });

  function bts(players, starterIds, side) {
    const s = { field_goals_made: 0, field_goals_att: 0, three_points_made: 0, three_points_att: 0, two_points_made: 0, two_points_att: 0, free_throws_made: 0, free_throws_att: 0, assists: 0, steals: 0, blocks: 0, offensive_rebounds: 0, defensive_rebounds: 0, rebounds: 0, turnovers: 0, total_turnovers: 0, personal_fouls: 0, points: 0, bench_points: 0 };
    let sPts = 0;
    players.forEach(p => { s.field_goals_made += p.fgm || 0; s.field_goals_att += p.fga || 0; s.three_points_made += p.fg3m || 0; s.three_points_att += p.fg3a || 0; s.free_throws_made += p.ftm || 0; s.free_throws_att += p.fta || 0; s.assists += p.ast || 0; s.steals += p.stl || 0; s.blocks += p.blk || 0; s.offensive_rebounds += p.oreb || 0; s.defensive_rebounds += p.dreb || 0; s.rebounds += p.reb || 0; s.turnovers += p.turnover || 0; s.personal_fouls += p.pf || 0; s.points += p.pts || 0; if (starterIds.has(p.player?.id || p.id)) sPts += p.pts || 0; });
    s.total_turnovers = s.turnovers; s.two_points_made = s.field_goals_made - s.three_points_made; s.two_points_att = s.field_goals_att - s.three_points_att; s.bench_points = Math.max(0, s.points - sPts);
    const fga = s.field_goals_att || 1;
    s.field_goals_pct = +(s.field_goals_made / fga * 100).toFixed(1); s.three_points_pct = s.three_points_att > 0 ? +(s.three_points_made / s.three_points_att * 100).toFixed(1) : 0;
    s.effective_fg_pct = +((s.field_goals_made + 0.5 * s.three_points_made) / fga * 100).toFixed(1);
    s.true_shooting_att = +(fga + 0.44 * s.free_throws_att).toFixed(1); s.true_shooting_pct = s.true_shooting_att > 0 ? +(s.points / (2 * s.true_shooting_att) * 100).toFixed(1) : 0;
    s.assists_turnover_ratio = s.turnovers > 0 ? +(s.assists / s.turnovers).toFixed(2) : s.assists;
    s.possessions = +(fga - s.offensive_rebounds + s.turnovers + 0.4 * s.free_throws_att).toFixed(1);
    s.offensive_points_per_possession = s.possessions > 0 ? +(s.points / s.possessions).toFixed(2) : 0;
    const isHome = side === 'home'; const pbpSide = isHome ? pbpResult?.home : pbpResult?.away;
    if (pbpSide) { const rM = pbpSide.rim?.made || 0, rA = pbpSide.rim?.att || 0, pM = pbpSide.paint?.made || 0, pA = pbpSide.paint?.att || 0; s.points_in_paint_made = rM + pM; s.points_in_paint_att = rA + pA; s.points_in_paint = s.points_in_paint_made * 2; s.points_in_the_paint = s.points_in_paint; s.field_goals_at_rim_made = rM; s.field_goals_at_rim_att = rA; }
    s.points_off_turnovers = isHome ? (bdl.potHome || 0) : (bdl.potAway || 0); s.second_chance_pts = isHome ? (bdl.scpHome || 0) : (bdl.scpAway || 0); s.second_chance_points = s.second_chance_pts;
    s.biggest_lead = isHome ? (bdl.biggestLeadHome || 0) : (bdl.biggestLeadAway || 0);
    s.fast_break_pts = 0; s.fast_break_points = 0; s.most_unanswered = { points: 0 };
    if (pbpResult?.runs) { const tr = pbpResult.runs.filter(r => r.team === (isHome ? hA : aA)); if (tr.length > 0) s.most_unanswered.points = tr.reduce((m, r) => r.pts > m ? r.pts : m, 0); }
    s.fouls_drawn = 0; s.defensive_points_per_possession = 0; s.offensive_rating = 0; s.defensive_rating = 0; s.points_against = 0; s.time_leading = '';
    return s;
  }

  const homeStats = bts(homePlayers, hSIds, 'home'), awayStats = bts(awayPlayers, aSIds, 'away');
  homeStats.points_against = awayStats.points; awayStats.points_against = homeStats.points;
  homeStats.defensive_points_per_possession = homeStats.possessions > 0 ? +(awayStats.points / homeStats.possessions).toFixed(2) : 0;
  awayStats.defensive_points_per_possession = awayStats.possessions > 0 ? +(homeStats.points / awayStats.possessions).toFixed(2) : 0;
  homeStats.offensive_rating = homeStats.possessions > 0 ? +(homeStats.points / homeStats.possessions * 100).toFixed(1) : 0;
  homeStats.defensive_rating = homeStats.possessions > 0 ? +(awayStats.points / homeStats.possessions * 100).toFixed(1) : 0;
  awayStats.offensive_rating = awayStats.possessions > 0 ? +(awayStats.points / awayStats.possessions * 100).toFixed(1) : 0;
  awayStats.defensive_rating = awayStats.possessions > 0 ? +(homeStats.points / awayStats.possessions * 100).toFixed(1) : 0;

  // Per-quarter scores
  const periods = [];
  for (let q = 1; q <= 4; q++) { const hP = game['home_q' + q] ?? null, aP = game['visitor_q' + q] ?? null; if (hP != null || aP != null) periods.push({ number: q, home_points: hP || 0, away_points: aP || 0 }); }
  for (let ot = 1; ot <= 3; ot++) { const hOT = game['home_ot' + ot] ?? null, aOT = game['visitor_ot' + ot] ?? null; if (hOT != null || aOT != null) periods.push({ number: 4 + ot, home_points: hOT || 0, away_points: aOT || 0 }); }

  const hScoring = periods.map(p => ({ type: 'quarter', number: p.number, sequence: p.number, points: p.home_points }));
  const aScoring = periods.map(p => ({ type: 'quarter', number: p.number, sequence: p.number, points: p.away_points }));

  // Lead changes / ties
  let lc = 0, tt = 0, prev = null;
  if (bdl.scoreLog) bdl.scoreLog.forEach(s => { const mg = s.hScore - s.aScore; const ld = mg > 0 ? 'h' : mg < 0 ? 'a' : 't'; if (ld === 't') tt++; else if (prev && prev !== 't' && ld !== prev) lc++; prev = ld; });

  function bpa(bPlayers, sIds) { return bPlayers.map(p => { const pl = p.player || {}; const pid = pl.id || p.id; return { id: pid, full_name: ((pl.first_name || '') + ' ' + (pl.last_name || '')).trim(), position: pl.position || '', primary_position: pl.position || '', played: (p.min && p.min !== '0') || (p.pts > 0), active: true, starter: sIds.has(pid), on_court: false, statistics: { minutes: p.min || '0', field_goals_made: p.fgm || 0, field_goals_att: p.fga || 0, three_points_made: p.fg3m || 0, three_points_att: p.fg3a || 0, free_throws_made: p.ftm || 0, free_throws_att: p.fta || 0, offensive_rebounds: p.oreb || 0, defensive_rebounds: p.dreb || 0, rebounds: p.reb || 0, assists: p.ast || 0, steals: p.stl || 0, blocks: p.blk || 0, turnovers: p.turnover || 0, personal_fouls: p.pf || 0, points: p.pts || 0, pls_min: p.plus_minus || 0 } }; }); }

  const srSt = normalizeBdlStatusServer(game.status, game);
  // Extract period from BDL time string (e.g. "Q4 8:03" → 4, "OT1 3:22" → 5)
  // BDL game.period often returns 0 during live games; time string is reliable
  var extractedPeriod = 0;
  if (game.time) {
    const pMatch = game.time.match(/^Q(\d+)/i);
    if (pMatch) extractedPeriod = parseInt(pMatch[1]) || 0;
    else if (/^OT/i.test(game.time)) { const otMatch = game.time.match(/^OT(\d*)/i); extractedPeriod = 4 + (parseInt(otMatch?.[1]) || 1); }
    else if (/^half/i.test(game.time)) extractedPeriod = 2;
    else if (/^final/i.test(game.time)) extractedPeriod = periods.length || 4;
  }
  const derivedQuarter = extractedPeriod || game.period || periods.length || 0;

  return { id: game.id, status: srSt, quarter: derivedQuarter, clock: normalizeBdlClockServer(game.time) || '', lead_changes: lc, times_tied: tt, _dataSource: 'BDL',
    home: { name: homeTeam.name || '', alias: hA, market: homeTeam.city || '', id: homeTeam.id || '', points: game.home_team_score || homeStats.points, bonus: game.home_in_bonus || false, double_bonus: false, remaining_timeouts: game.home_timeouts_remaining ?? null, scoring: hScoring, statistics: homeStats, players: bpa(homePlayers, hSIds) },
    away: { name: awayTeam.name || '', alias: aA, market: awayTeam.city || '', id: awayTeam.id || '', points: game.visitor_team_score || awayStats.points, bonus: game.visitor_in_bonus || false, double_bonus: false, remaining_timeouts: game.visitor_timeouts_remaining ?? null, scoring: aScoring, statistics: awayStats, players: bpa(awayPlayers, aSIds) },
    periods };
}

// ── WNBA Phase 0: boundary-stale clock guard (Jun 7 phantom-snapshot fix) ──
// BDL parks game.time at '0.0' (period just ended) or '10:00' (next period queued, even
// after play resumes); ESPN can momentarily report period=0 or END_PERIOD/HALFTIME at
// breaks, letting the periods.length fallback inflate currentPeriod (phantom Q4/0:00).
// Live-captured sequences (Jun 9, PHX@GS): P1 '0.0' → P2 '10:00' parked while ESPN ran 9:07.
// Returns stable { period, clock, boundary }. WNBA-only — NBA path untouched.
function stableWNBAPeriodClock(summary, game) {
  var rawPeriod = Number(summary.quarter || 0);
  var rawClock = String(summary.clock || '').trim();
  var status = String(summary.status || '');
  var prevPeriod = Number(game.last_period || 0);
  var parked = rawClock === '' || rawClock === '0.0' || rawClock === '0:00' || rawClock === '00:00' || rawClock === '10:00'
    || (rawPeriod >= 5 && rawClock === '5:00')
    || /END_PERIOD|HALFTIME/i.test(status);
  if (!parked) {
    // Running clock — trust it; never let periods.length inflate past a real reading
    var p = rawPeriod || prevPeriod || (summary.periods || []).length || 0;
    return { period: p, clock: rawClock, boundary: false };
  }
  // Boundary window: freeze at the just-completed quarter; never advance on a parked clock
  var queued = rawClock === '10:00' || (rawPeriod >= 5 && rawClock === '5:00');
  var completed = Math.max(prevPeriod, (rawPeriod && !queued) ? rawPeriod : 0)
    || (summary.periods || []).length || rawPeriod || 0;
  if (queued && rawPeriod > prevPeriod && prevPeriod > 0) completed = prevPeriod;
  return { period: completed, clock: '0:00', boundary: true };
}

// ── WNBA Phase 1: structural overlay v2 (dual-write; deployed model untouched) ──
// Adjudicated sources (research/2026-06-10_phase4a_adjudication.md, n=81 vs official):
//   paint: ESPN direct (89% exact) | fbp: ESPN direct (75% exact; Phase 3 anchors correct tail)
//   pot:   ESPN direct — attribution flip now applied at source (buildSummaryFromESPN call site)
//   scp:   PBP regex placeholder (REJECTED, -2.47 mean undercount; Phase 2 machine replaces)
//   poss:  FGA - OREB + TOV + 0.4*FTA estimator (median |err| 1.6 vs official)
// v2 values land on modelSummary stats + raw_stats_json as parallel keys; the live model
// keeps reading v1 fields until the Phase 6 retrain swaps model + fields atomically.
function computeWNBAModelV2(modelSummary, espnSummary, pbpResult) {
  function side(mySide, scpVal) {
    var e = (espnSummary && espnSummary[mySide] && espnSummary[mySide].statistics) || null;
    var m = (modelSummary && modelSummary[mySide] && modelSummary[mySide].statistics) || {};
    var fga = Number(m.field_goals_att || 0), oreb = Number(m.offensive_rebounds || 0);
    var to = Number(m.turnovers || m.total_turnovers || 0), fta = Number(m.free_throws_att || 0);
    return {
      paint: e ? Number(e.points_in_paint || e.points_in_the_paint || 0) : null,
      fbp: e ? Number(e.fast_break_pts || e.fast_break_points || 0) : null,
      pot: e ? Number(e.points_off_turnovers || 0) : null, // attribution already corrected at buildSummaryFromESPN call site (own-side read; pot should equal pot_v2 going forward)
      scp: Number(scpVal || 0),
      poss: fga > 0 ? Math.round((fga - oreb + to + 0.4 * fta) * 10) / 10 : null,
      src: e ? 'espn' : 'no-espn',
    };
  }
  var v2 = {
    home: side('home', pbpResult?._bdl?.scpHome),
    away: side('away', pbpResult?._bdl?.scpAway),
  };
  ['home', 'away'].forEach(function(s) {
    var st = modelSummary && modelSummary[s] && modelSummary[s].statistics;
    if (st) { st.paint_v2 = v2[s].paint; st.fbp_v2 = v2[s].fbp; st.pot_v2 = v2[s].pot; st.scp_v2 = v2[s].scp; st.poss_v2 = v2[s].poss; }
  });
  return v2;
}

// ── WNBA POT BACKFILL — corrects historical side-flipped pot ───────────────
// (research/2026-06-10_phase4a_adjudication.md). Swaps home/away pot in
// raw_stats_json and recomputes i1 / floor_score / floor_team. i2-i5 inputs are
// pot-independent: stored ctrl-relative values are pivoted to home-relative,
// re-blended with corrected I1, re-pivoted vs the new control team.
// Alerts table intentionally untouched (historical decision log — Manny, Jun 10).
// SAFETY: two parity gates per row — recomputing I1 with the ORIGINAL pot must
// reproduce stored i1, and re-blending the original floor must reproduce stored
// floor_score (±0.011). Any miss → row skipped, never written.
// IDEMPOTENT: rows tagged raw_stats_json._pot_corrected; post-fix rows
// (pot already === pot_v2) skipped. Keyset pagination via `after` cursor on s.id.
function _bfI1Home(h, a) {
  // Replicates computeServer WNBA I1 exactly (thresholds: disrupt ±2, pot ±3)
  const disruptDiff = (Number(h.stl) || 0) + (Number(h.blk) || 0) - (Number(a.stl) || 0) - (Number(a.blk) || 0);
  const i1subA = disruptDiff > 2 ? 1 : disruptDiff < -2 ? -1 : 0;
  const potDiff = (Number(h.pot) || 0) - (Number(a.pot) || 0);
  const i1subB = potDiff > 3 ? 1 : potDiff < -3 ? -1 : 0;
  let i1raw = i1subA + i1subB;
  // Chaos layer — computeServer cross-wiring: home's forcing credit = away side's forced count
  const hForced = Number(a.forced_to) || 0, aForced = Number(h.forced_to) || 0;
  const hUnforced = Number(h.unforced_to) || 0, aUnforced = Number(a.unforced_to) || 0;
  if (hForced >= aForced + 4) i1raw += 0.5;
  else if (aForced >= hForced + 4) i1raw -= 0.5;
  else if (hUnforced >= aUnforced + 4) i1raw -= 0.5;
  else if (aUnforced >= hUnforced + 4) i1raw += 0.5;
  return i1raw > 0 ? 1 : i1raw === 0 ? 0.5 : 0;
}

async function backfillWNBAPot(sql, opts) {
  const { batch, after, dry } = opts;
  const W = (LEAGUES.wnba && LEAGUES.wnba.weights) || null;
  if (!W) return { error: 'LEAGUES.wnba.weights missing' };
  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;
  // Pre-May-16 rows store floor_team as SR aliases while games use BDL (memory: ALIAS_MAP rule).
  // Normalize for side-determination; preserve each row's own convention when writing.
  const SR_TO_BDL = { NYL: 'NY', GSV: 'GS', WAS: 'WSH', LVA: 'LV', LAS: 'LA', PDX: 'POR', TOY: 'TOR' };
  const BDL_TO_SR = { NY: 'NYL', GS: 'GSV', WSH: 'WAS', LV: 'LVA', LA: 'LAS', POR: 'PDX', TOR: 'TOY' };
  const norm = (x) => SR_TO_BDL[x] || x;

  const rows = await sql`
    SELECT s.id, s.i1, s.i2, s.i3, s.i4, s.i5, s.floor_score, s.floor_team,
           s.raw_stats_json, g.home_alias, g.away_alias
    FROM snapshots s JOIN games g ON s.game_id = g.id
    WHERE g.league = 'wnba' AND s.id > ${after}
    ORDER BY s.id ASC LIMIT ${batch}`;

  const out = {
    dry, batch, after, fetched: rows.length, updated: 0,
    skipped: { already_tagged: 0, already_correct: 0, unparseable: 0, null_indicators: 0, i1_parity_miss: 0, floor_parity_miss: 0, no_alias: 0 },
    changes: { i1_changed: 0, ctrl_flips: 0, floor_delta_sum: 0 },
    parity_miss_ids: [], last_id: after, done: rows.length < batch,
  };

  for (const s of rows) {
    out.last_id = s.id;
    let rs;
    try { rs = typeof s.raw_stats_json === 'string' ? JSON.parse(s.raw_stats_json) : s.raw_stats_json; } catch (e) { rs = null; }
    if (!rs || !rs.home || !rs.away) { out.skipped.unparseable++; continue; }
    if (rs._pot_corrected) { out.skipped.already_tagged++; continue; }
    const h = rs.home, a = rs.away;
    if (h.pot_v2 != null && a.pot_v2 != null && h.pot === h.pot_v2 && a.pot === a.pot_v2) { out.skipped.already_correct++; continue; }
    if (!s.home_alias || !s.away_alias) { out.skipped.no_alias++; continue; }
    if (s.i1 == null || s.i2 == null || s.i3 == null || s.i4 == null || s.i5 == null || s.floor_score == null || !s.floor_team) { out.skipped.null_indicators++; continue; }

    const nFT = norm(s.floor_team), nHA = norm(s.home_alias), nAA = norm(s.away_alias);
    if (nFT !== nHA && nFT !== nAA) {
      out.skipped.alias_unresolved = (out.skipped.alias_unresolved || 0) + 1;
      if (out.parity_miss_ids.length < 10) out.parity_miss_ids.push(s.id);
      continue;
    }
    const ctrlHomeOld = nFT === nHA;
    const rowIsSR = s.floor_team !== s.home_alias && s.floor_team !== s.away_alias; // row stores SR-form aliases
    const toRowForm = (bdlAlias) => (rowIsSR ? (BDL_TO_SR[bdlAlias] || bdlAlias) : bdlAlias);
    // Pivot stored ctrl-relative i2-i5 back to home-relative
    const i2h = ctrlHomeOld ? Number(s.i2) : 1 - Number(s.i2);
    const i3h = ctrlHomeOld ? Number(s.i3) : 1 - Number(s.i3);
    const i4h = ctrlHomeOld ? Number(s.i4) : 1 - Number(s.i4);
    const i5h = ctrlHomeOld ? Number(s.i5) : 1 - Number(s.i5);

    // PARITY GATE 1: I1 replica on ORIGINAL pot must reproduce stored i1
    const i1HomeOld = _bfI1Home(h, a);
    const i1CtrlOld = r1(ctrlHomeOld ? i1HomeOld : 1 - i1HomeOld);
    if (Math.abs(i1CtrlOld - Number(s.i1)) > 0.001) {
      out.skipped.i1_parity_miss++;
      if (out.parity_miss_ids.length < 10) out.parity_miss_ids.push(s.id);
      continue;
    }
    // PARITY GATE 2: re-blend with ORIGINAL I1 must reproduce stored floor_score
    const rawOld = i1HomeOld * W.I1 + i2h * W.I2 + i3h * W.I3 + i4h * W.I4 + i5h * W.I5;
    const floorOld = r2(rawOld >= 0.5 ? rawOld : 1 - rawOld);
    if (Math.abs(floorOld - Number(s.floor_score)) > 0.011) {
      out.skipped.floor_parity_miss++;
      if (out.parity_miss_ids.length < 10) out.parity_miss_ids.push(s.id);
      continue;
    }

    // SWAP pot + recompute
    const tmp = h.pot; h.pot = a.pot; a.pot = tmp;
    rs._pot_corrected = true;
    const i1HomeNew = _bfI1Home(h, a);
    const rawNew = i1HomeNew * W.I1 + i2h * W.I2 + i3h * W.I3 + i4h * W.I4 + i5h * W.I5;
    const ctrlHomeNew = rawNew >= 0.5;
    const floorTeamNew = ctrlHomeNew === ctrlHomeOld ? s.floor_team : toRowForm(norm(ctrlHomeNew ? s.home_alias : s.away_alias));
    const floorScoreNew = r2(ctrlHomeNew ? rawNew : 1 - rawNew);
    const ci = [i1HomeNew, i2h, i3h, i4h, i5h].map((v) => r1(ctrlHomeNew ? v : 1 - v));

    if (i1HomeNew !== i1HomeOld) out.changes.i1_changed++;
    if (floorTeamNew !== s.floor_team) out.changes.ctrl_flips++;
    out.changes.floor_delta_sum += Math.abs(floorScoreNew - Number(s.floor_score));

    if (!dry) {
      await sql`UPDATE snapshots SET raw_stats_json = ${JSON.stringify(rs)},
        i1 = ${ci[0]}, i2 = ${ci[1]}, i3 = ${ci[2]}, i4 = ${ci[3]}, i5 = ${ci[4]},
        floor_score = ${floorScoreNew}, floor_team = ${floorTeamNew}
        WHERE id = ${s.id}`;
    }
    out.updated++;
  }
  out.changes.mean_abs_floor_delta = out.updated > 0 ? r2(out.changes.floor_delta_sum / out.updated) : 0;
  delete out.changes.floor_delta_sum;
  return out;
}

// ── In-memory BDL caches for server polling ──
let _serverBoxScoreCache = null;    // Array of box score objects
let _serverBoxScoreTime = 0;
let _serverLineupsCache = {};       // bdlGameId → lineups array
let _seasonQ4Cache = null;          // { teamAlias: avgQ4margin, ... }
let _seasonQ4Time = 0;
const _thesisAttempted = new Set();  // game IDs already attempted for fallback thesis

// ── FALLBACK THESIS — generate when pregame cron missed the window ──
async function generateFallbackThesis(sql, game, league, ind, conviction, summary, matchup, hA, aA) {
  if (_thesisAttempted.has(game.id)) return;
  _thesisAttempted.add(game.id);  // prevent concurrent calls in warm container

  // Generate in Q1 or Q2 — after Q2 the thesis adds minimal value
  const period = summary.quarter || summary.half || (summary.home?.periods || []).length || 0;
  if (period > 2) { log(`${matchup}: fallback thesis skipped — already Q${period}`); _thesisAttempted.delete(game.id); return; }

  // Check if thesis already exists
  try {
    const existing = await sql`SELECT game_id FROM theses WHERE game_id = ${game.id}`;
    if (existing.length > 0) return;  // thesis exists — keep in Set (permanent skip)
  } catch (e) { _thesisAttempted.delete(game.id); return; }

  log(`${matchup}: No pregame thesis found — generating fallback...`);

  // Fetch injuries (1 SR call — non-fatal if fails)
  let injuryText = 'No injury data available';
  try {
    const injuries = await srFetch(league, 'league/injuries.json');
    if (injuries?.players) {
      const relevant = injuries.players.filter(p => p.team?.alias === hA || p.team?.alias === aA);
      if (relevant.length > 0) {
        injuryText = relevant.map(p =>
          `${p.team?.alias} ${p.full_name}: ${p.status} (${p.injury?.description || 'undisclosed'})`
        ).join('\n');
      } else {
        injuryText = 'No injuries reported for either team';
      }
    }
  } catch (e) { /* non-fatal — proceed without injuries */ }

  // Build indicator summary
  const indLines = ['I1','I2','I3','I4','I5'].map(k => {
    const i = ind[k];
    return i ? `${k}: ${i.score?.toFixed(2)} ${i.leader}` : `${k}: N/A`;
  }).join('\n');

  // Extract key stats from summary
  const hS = summary.home?.statistics || {};
  const aS = summary.away?.statistics || {};
  const statsContext = `${hA}: Paint ${hS.points_in_paint||'?'}, FTA ${hS.free_throws_att||'?'}, 3PA ${hS.three_points_att||'?'}, TO ${hS.turnovers||'?'}, AST ${hS.assists||'?'}
${aA}: Paint ${aS.points_in_paint||'?'}, FTA ${aS.free_throws_att||'?'}, 3PA ${aS.three_points_att||'?'}, TO ${aS.turnovers||'?'}, AST ${aS.assists||'?'}`;

  const prompt = `You are a structural sports betting analyst for an NBA live betting system.
Generate a concise pregame thesis for ${aA} @ ${hA}. This is a LATE thesis — the game just started.
Focus on the structural matchup and what to watch for during live betting.

INJURIES:
${injuryText}

EARLY GAME STRUCTURAL READ (from mechanical engine):
Control: ${ind.controlTeam} ${ind.score?.toFixed(2)}
Conviction: ${conviction.tier} (${conviction.combo})
${indLines}

EARLY STATS:
${statsContext}

OUTPUT FORMAT (plain text, no Markdown):
FALLBACK THESIS — ${aA} @ ${hA}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTROL SCORE: [Team] [X.XX] — [verdict]
CONVICTION: ${conviction.tier} — ${conviction.combo}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRUCTURAL EDGE: [2-3 sentences — which team controls structure and why]
MATCHUP CONTEXT: [1-2 sentences — key matchup dynamics]
INJURY IMPACT: [1 sentence]
WATCH FOR: [What confirms or invalidates the thesis]
DISAGREEMENT: NONE or [where early data challenges the read]

Keep it under 300 words. Use team aliases (${hA}, ${aA}).`;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { log(`${matchup}: no ANTHROPIC_API_KEY for fallback thesis`); return; }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) { log(`${matchup}: fallback thesis Anthropic ${resp.status}`); _thesisAttempted.delete(game.id); return; }

    const data = await resp.json();
    const thesisText = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!thesisText || thesisText.length < 50) { log(`${matchup}: fallback thesis too short`); _thesisAttempted.delete(game.id); return; }

    await sql`
      INSERT INTO theses (game_id, league, text, created_at)
      VALUES (${game.id}, ${league}, ${thesisText}, NOW())
      ON CONFLICT (game_id) DO NOTHING
    `;

    await sendNtfy(
      `${aA}@${hA} Thesis (late)`,
      thesisText.substring(0, 500)
    );

    log(`${matchup}: ★ FALLBACK THESIS generated (${thesisText.length} chars)`);
    // SUCCESS — _thesisAttempted keeps game.id (permanent skip in warm container)
  } catch (e) {
    _thesisAttempted.delete(game.id);  // allow retry on next invocation
    log(`${matchup}: fallback thesis failed: ${e.message}`);
  }
}

// Build SR-shaped summary from BDL player_stats (WNBA fallback when SR is down)
// Returns same shape as buildSummaryFromBDLServer but without starters/quarter scores
function buildSummaryFromBDLPlayerStats(playerStats, bdlGame, pbpResult) {
  var hA = bdlGame.home_team?.abbreviation || 'HOME';
  var aA = bdlGame.visitor_team?.abbreviation || 'AWAY';
  var homePlayers = playerStats.filter(function(p) { return p.team?.abbreviation === hA; });
  var awayPlayers = playerStats.filter(function(p) { return p.team?.abbreviation === aA; });

  // Reshape into boxScore-compatible format for buildSummaryFromBDLServer's bts()
  // BDL player_stats fields (turnover, pf, pts, stl, blk, oreb, dreb) match what bts() reads
  var fakeBoxScore = {
    id: bdlGame.id,
    status: bdlGame.status === 'post' ? 'Final' : bdlGame.status === 'in_progress' ? 'In Progress' : bdlGame.status,
    time: bdlGame.time,
    period: bdlGame.period,
    home_team: { team: bdlGame.home_team, players: homePlayers },
    visitor_team: { team: bdlGame.visitor_team, players: awayPlayers },
    // Map WNBA BDL score fields to NBA-shaped fields for buildSummaryFromBDLServer
    home_team_score: bdlGame.home_score || 0,
    visitor_team_score: bdlGame.away_score || 0,
    // No quarter scores available from WNBA BDL game object (no home_q1 etc.)
  };

  // No lineups endpoint for WNBA → bench_points = total points (acceptable degradation)
  return buildSummaryFromBDLServer(fakeBoxScore, pbpResult, null);
}

// ── ESPN ADAPTER: converts ESPN summary to SR-shaped summary for computeServer ──
// Fetches full ESPN summary — WP + boxscore + player stats in one call
async function espnSummaryFull(league, espnEventId) {
  var cfg = LEAGUES[league];
  var url = `${cfg.espnSummaryBase}?event=${espnEventId}`;
  try {
    var resp = await fetch(url);
    if (!resp.ok) return null;
    var data = await resp.json();
    var wpArr = data.winprobability || [];
    var latest = wpArr.length > 0 ? wpArr[wpArr.length - 1] : null;
    var homeWP = latest?.homeWinPercentage;
    var wp = homeWP != null ? { home: Math.round(homeWP * 100), away: 100 - Math.round(homeWP * 100) } : null;
    var boxTeams = data.boxscore?.teams || [];
    var homeBox = boxTeams.find(function(t) { return t.homeAway === 'home'; });
    var awayBox = boxTeams.find(function(t) { return t.homeAway === 'away'; });
    var boxPlayers = data.boxscore?.players || [];
    var homePl = boxPlayers.find(function(t) { return t.homeAway === 'home' || (homeBox && t.team?.abbreviation === homeBox.team?.abbreviation); });
    var awayPl = boxPlayers.find(function(t) { return t.homeAway === 'away' || (awayBox && t.team?.abbreviation === awayBox.team?.abbreviation); });
    var comp = data.header?.competitions?.[0] || {};
    var homeComp = comp.competitors?.find(function(c) { return c.homeAway === 'home'; });
    var awayComp = comp.competitors?.find(function(c) { return c.homeAway === 'away'; });
    return {
      wp: wp,
      boxscore: { home: homeBox?.statistics || [], away: awayBox?.statistics || [], homeAbbr: homeBox?.team?.abbreviation || '', awayAbbr: awayBox?.team?.abbreviation || '' },
      players: { home: _extractESPNPlayers(homePl), away: _extractESPNPlayers(awayPl) },
      header: {
        homeScore: Number(homeComp?.score || 0), awayScore: Number(awayComp?.score || 0),
        period: Number(comp.status?.period || 0), clock: comp.status?.displayClock || '',
        status: comp.status?.type?.name || '',
        linescores: { home: (homeComp?.linescores || []).map(function(ls) { return Number(ls.value || 0); }), away: (awayComp?.linescores || []).map(function(ls) { return Number(ls.value || 0); }) },
      },
    };
  } catch (e) {
    log(`ESPN summary full error for ${espnEventId}: ${e.message}`);
    return null;
  }
}

function _extractESPNPlayers(teamPl) {
  if (!teamPl?.statistics?.[0]?.athletes) return [];
  var keys = teamPl.statistics[0].keys || [];
  return teamPl.statistics[0].athletes.map(function(a) {
    var ps = {};
    keys.forEach(function(k, i) {
      var v = (a.stats || [])[i] || '0';
      if (k === 'minutes') { ps.minutes = v; }
      else if (k === 'points') { ps.points = Number(v) || 0; }
      else if (k === 'fieldGoalsMade-fieldGoalsAttempted') { var p = v.split('-'); ps.field_goals_made = Number(p[0]) || 0; ps.field_goals_att = Number(p[1]) || 0; }
      else if (k === 'threePointFieldGoalsMade-threePointFieldGoalsAttempted') { var p = v.split('-'); ps.three_points_made = Number(p[0]) || 0; ps.three_points_att = Number(p[1]) || 0; }
      else if (k === 'freeThrowsMade-freeThrowsAttempted') { var p = v.split('-'); ps.free_throws_made = Number(p[0]) || 0; ps.free_throws_att = Number(p[1]) || 0; }
      else if (k === 'rebounds') { ps.rebounds = Number(v) || 0; }
      else if (k === 'assists') { ps.assists = Number(v) || 0; }
      else if (k === 'turnovers') { ps.turnovers = Number(v) || 0; }
      else if (k === 'steals') { ps.steals = Number(v) || 0; }
      else if (k === 'blocks') { ps.blocks = Number(v) || 0; }
      else if (k === 'offensiveRebounds') { ps.offensive_rebounds = Number(v) || 0; }
      else if (k === 'defensiveRebounds') { ps.defensive_rebounds = Number(v) || 0; }
      else if (k === 'fouls') { ps.personal_fouls = Number(v) || 0; }
      else if (k === 'plusMinus') { ps.pls_min = Number(v) || 0; }
    });
    return { id: a.athlete?.id || '', name: a.athlete?.displayName || '', position: a.athlete?.position?.abbreviation || '', starter: !!a.starter, didNotPlay: !!a.didNotPlay, stats: ps };
  });
}

function _parseESPNTeamStats(statsArr) {
  var s = {
    field_goals_made: 0, field_goals_att: 0, three_points_made: 0, three_points_att: 0,
    two_points_made: 0, two_points_att: 0, free_throws_made: 0, free_throws_att: 0,
    assists: 0, steals: 0, blocks: 0, offensive_rebounds: 0, defensive_rebounds: 0,
    rebounds: 0, turnovers: 0, total_turnovers: 0, personal_fouls: 0, points: 0,
    bench_points: 0, points_in_paint: 0, points_in_the_paint: 0,
    fast_break_pts: 0, fast_break_points: 0, points_off_turnovers: 0,
    second_chance_points: 0, second_chance_pts: 0, biggest_lead: 0,
    field_goals_pct: 0, three_points_pct: 0, effective_fg_pct: 0,
    possessions: 0, offensive_points_per_possession: 0, defensive_points_per_possession: 0,
    offensive_rating: 0, defensive_rating: 0, fouls_drawn: 0, points_against: 0,
    points_in_paint_made: 0, points_in_paint_att: 0,
    field_goals_at_rim_made: 0, field_goals_at_rim_att: 0,
    most_unanswered: { points: 0 }, time_leading: '',
  };
  (statsArr || []).forEach(function(st) {
    var v = st.displayValue;
    if (st.name === 'fieldGoalsMade-fieldGoalsAttempted') { var p = v.split('-'); s.field_goals_made = Number(p[0]) || 0; s.field_goals_att = Number(p[1]) || 0; }
    else if (st.name === 'threePointFieldGoalsMade-threePointFieldGoalsAttempted') { var p = v.split('-'); s.three_points_made = Number(p[0]) || 0; s.three_points_att = Number(p[1]) || 0; }
    else if (st.name === 'freeThrowsMade-freeThrowsAttempted') { var p = v.split('-'); s.free_throws_made = Number(p[0]) || 0; s.free_throws_att = Number(p[1]) || 0; }
    else if (st.name === 'totalRebounds') { s.rebounds = +v; }
    else if (st.name === 'offensiveRebounds') { s.offensive_rebounds = +v; }
    else if (st.name === 'defensiveRebounds') { s.defensive_rebounds = +v; }
    else if (st.name === 'assists') { s.assists = +v; }
    else if (st.name === 'steals') { s.steals = +v; }
    else if (st.name === 'blocks') { s.blocks = +v; }
    else if (st.name === 'turnovers') { s.turnovers = +v; s.total_turnovers = +v; }
    else if (st.name === 'fouls') { s.personal_fouls = +v; }
    else if (st.name === 'pointsInPaint') { s.points_in_paint = +v; s.points_in_the_paint = +v; }
    else if (st.name === 'fastBreakPoints') { s.fast_break_pts = +v; s.fast_break_points = +v; }
    else if (st.name === 'turnoverPoints') { s.points_off_turnovers = +v; }
    else if (st.name === 'largestLead') { s.biggest_lead = +v; }
    else if (st.name === 'fieldGoalPct') { s.field_goals_pct = +v; }
    else if (st.name === 'threePointFieldGoalPct') { s.three_points_pct = +v; }
  });
  s.two_points_made = s.field_goals_made - s.three_points_made;
  s.two_points_att = s.field_goals_att - s.three_points_att;
  var fga = s.field_goals_att || 1;
  s.effective_fg_pct = +((s.field_goals_made + 0.5 * s.three_points_made) / fga * 100).toFixed(1);
  s.true_shooting_att = +(fga + 0.44 * s.free_throws_att).toFixed(1);
  s.true_shooting_pct = s.true_shooting_att > 0 ? +(s.points / (2 * s.true_shooting_att) * 100).toFixed(1) : 0;
  s.assists_turnover_ratio = s.turnovers > 0 ? +(s.assists / s.turnovers).toFixed(2) : s.assists;
  s.possessions = +(fga - s.offensive_rebounds + s.turnovers + 0.4 * s.free_throws_att).toFixed(1);
  s.offensive_points_per_possession = s.possessions > 0 ? +(s.points / s.possessions).toFixed(2) : 0;
  return s;
}

function buildSummaryFromESPN(espnFull) {
  if (!espnFull?.boxscore) return null;
  var hStats = _parseESPNTeamStats(espnFull.boxscore.home);
  var aStats = _parseESPNTeamStats(espnFull.boxscore.away);
  var hPl = espnFull.players?.home || [];
  var aPl = espnFull.players?.away || [];
  // Points: prefer team stats, fallback to player sum, fallback to header
  if (!hStats.points) hStats.points = hPl.reduce(function(t, p) { return t + (p.stats?.points || 0); }, 0);
  if (!aStats.points) aStats.points = aPl.reduce(function(t, p) { return t + (p.stats?.points || 0); }, 0);
  if (!hStats.points && espnFull.header) hStats.points = espnFull.header.homeScore;
  if (!aStats.points && espnFull.header) aStats.points = espnFull.header.awayScore;
  // Bench points from starter flags
  var hSPts = hPl.filter(function(p) { return p.starter; }).reduce(function(t, p) { return t + (p.stats?.points || 0); }, 0);
  var aSPts = aPl.filter(function(p) { return p.starter; }).reduce(function(t, p) { return t + (p.stats?.points || 0); }, 0);
  hStats.bench_points = Math.max(0, hStats.points - hSPts);
  aStats.bench_points = Math.max(0, aStats.points - aSPts);
  // Recalculate oppp now that points are set (not available in _parseESPNTeamStats)
  hStats.offensive_points_per_possession = hStats.possessions > 0 ? +(hStats.points / hStats.possessions).toFixed(2) : 0;
  aStats.offensive_points_per_possession = aStats.possessions > 0 ? +(aStats.points / aStats.possessions).toFixed(2) : 0;
  // Cross-references
  hStats.points_against = aStats.points; aStats.points_against = hStats.points;
  hStats.defensive_points_per_possession = hStats.possessions > 0 ? +(aStats.points / hStats.possessions).toFixed(2) : 0;
  aStats.defensive_points_per_possession = aStats.possessions > 0 ? +(hStats.points / aStats.possessions).toFixed(2) : 0;
  hStats.offensive_rating = hStats.possessions > 0 ? +(hStats.points / hStats.possessions * 100).toFixed(1) : 0;
  hStats.defensive_rating = hStats.possessions > 0 ? +(aStats.points / hStats.possessions * 100).toFixed(1) : 0;
  aStats.offensive_rating = aStats.possessions > 0 ? +(aStats.points / aStats.possessions * 100).toFixed(1) : 0;
  aStats.defensive_rating = aStats.possessions > 0 ? +(hStats.points / aStats.possessions * 100).toFixed(1) : 0;
  // Player arrays
  function ePlToSR(eArr) {
    return eArr.filter(function(p) { return !p.didNotPlay; }).map(function(p) {
      return { id: p.id, full_name: p.name, position: p.position, primary_position: p.position, played: !p.didNotPlay, active: true, starter: p.starter, on_court: false,
        statistics: { minutes: p.stats?.minutes || '0', field_goals_made: p.stats?.field_goals_made || 0, field_goals_att: p.stats?.field_goals_att || 0, three_points_made: p.stats?.three_points_made || 0, three_points_att: p.stats?.three_points_att || 0, free_throws_made: p.stats?.free_throws_made || 0, free_throws_att: p.stats?.free_throws_att || 0, offensive_rebounds: p.stats?.offensive_rebounds || 0, defensive_rebounds: p.stats?.defensive_rebounds || 0, rebounds: p.stats?.rebounds || 0, assists: p.stats?.assists || 0, steals: p.stats?.steals || 0, blocks: p.stats?.blocks || 0, turnovers: p.stats?.turnovers || 0, personal_fouls: p.stats?.personal_fouls || 0, points: p.stats?.points || 0, pls_min: p.stats?.pls_min || 0 } };
    });
  }
  // Periods from linescores
  var periods = [];
  var hLS = espnFull.header?.linescores?.home || [];
  var aLS = espnFull.header?.linescores?.away || [];
  for (var i = 0; i < Math.max(hLS.length, aLS.length); i++) {
    periods.push({ number: i + 1, home_points: hLS[i] || 0, away_points: aLS[i] || 0 });
  }
  var hScoring = periods.map(function(p) { return { type: 'quarter', number: p.number, sequence: p.number, points: p.home_points }; });
  var aScoring = periods.map(function(p) { return { type: 'quarter', number: p.number, sequence: p.number, points: p.away_points }; });
  return {
    home: { alias: espnFull.boxscore.homeAbbr, name: espnFull.boxscore.homeAbbr, points: hStats.points, statistics: hStats, players: ePlToSR(hPl), scoring: hScoring },
    away: { alias: espnFull.boxscore.awayAbbr, name: espnFull.boxscore.awayAbbr, points: aStats.points, statistics: aStats, players: ePlToSR(aPl), scoring: aScoring },
    quarter: espnFull.header?.period || 0, clock: espnFull.header?.clock || '', status: espnFull.header?.status || '',
    periods: periods, _dataSource: 'ESPN',
  };
}

function buildESPNRawStatsJson(espnSummary) {
  if (!espnSummary) return null;
  try {
    var h = espnSummary.home?.statistics || {}, a = espnSummary.away?.statistics || {};
    return JSON.stringify({
      home: { stl: h.steals||0, oreb: h.offensive_rebounds||0, to: h.turnovers||0, fbp: h.fast_break_points||0, pot: h.points_off_turnovers||0, scp: h.second_chance_points||0, paint: h.points_in_paint||0, fta: h.free_throws_att||0, blk: h.blocks||0, fgm: h.field_goals_made||0, fga: h.field_goals_att||0, fg3m: h.three_points_made||0, fg3a: h.three_points_att||0, ast: h.assists||0, bigLead: h.biggest_lead||0, bench: h.bench_points||0, oppp: h.offensive_points_per_possession||0, dppp: h.defensive_points_per_possession||0, poss: h.possessions||0, ftm: h.free_throws_made||0, pts: h.points||0, pf: h.personal_fouls||0, efg: h.effective_fg_pct||0 },
      away: { stl: a.steals||0, oreb: a.offensive_rebounds||0, to: a.turnovers||0, fbp: a.fast_break_points||0, pot: a.points_off_turnovers||0, scp: a.second_chance_points||0, paint: a.points_in_paint||0, fta: a.free_throws_att||0, blk: a.blocks||0, fgm: a.field_goals_made||0, fga: a.field_goals_att||0, fg3m: a.three_points_made||0, fg3a: a.three_points_att||0, ast: a.assists||0, bigLead: a.biggest_lead||0, bench: a.bench_points||0, oppp: a.offensive_points_per_possession||0, dppp: a.defensive_points_per_possession||0, poss: a.possessions||0, ftm: a.free_throws_made||0, pts: a.points||0, pf: a.personal_fouls||0, efg: a.effective_fg_pct||0 },
      source: 'espn',
    });
  } catch (e) { return null; }
}

// Load season Q4 margins from games table (cached per hour)
async function loadSeasonQ4(sql, league) {
  if (_seasonQ4Cache && Date.now() - _seasonQ4Time < 3600000) return _seasonQ4Cache;
  try {
    const rows = await sql`
      SELECT home_alias, away_alias, quarter_data
      FROM games WHERE league = ${league} AND home_pts IS NOT NULL AND home_pts > 0
      AND quarter_data IS NOT NULL
      ORDER BY date DESC LIMIT 200
    `;
    const teamQ4 = {}; // { alias: [margin1, margin2, ...] }
    for (const r of rows) {
      const qd = typeof r.quarter_data === 'string' ? JSON.parse(r.quarter_data) : r.quarter_data;
      if (!qd?.diffs?.['4']) continue;
      const hQ4 = qd.diffs['4']?.home?.points;
      const aQ4 = qd.diffs['4']?.away?.points;
      if (hQ4 == null || aQ4 == null) continue;
      const margin = hQ4 - aQ4; // positive = home won Q4
      if (!teamQ4[r.home_alias]) teamQ4[r.home_alias] = [];
      if (!teamQ4[r.away_alias]) teamQ4[r.away_alias] = [];
      teamQ4[r.home_alias].push(margin);
      teamQ4[r.away_alias].push(-margin);
    }
    const result = {};
    for (const [team, margins] of Object.entries(teamQ4)) {
      if (margins.length >= 3) {
        result[team] = margins.reduce((a, b) => a + b, 0) / margins.length;
      }
    }
    _seasonQ4Cache = result;
    _seasonQ4Time = Date.now();
    return result;
  } catch (e) {
    return _seasonQ4Cache || {};
  }
}

// ── V2 BWC STATE MACHINE — mechanical functions (validated 9/9 games) ────────

const STATE_RANK = { 'LOCK': 4, 'EDGE': 3, 'VALUE': 2, 'DEEP_TRAIL': 1, 'EXIT': 0 };

// 3-minute checkpoint boundaries (game seconds from start)
// gameSec = (period - 1) * 720 + (720 - clockRemainingInSeconds)
// NBA only — NCAAMB uses existing graduation path
const GRAD_CHECKPOINTS_NBA = [
  { label: 'Q1_END', period: 2, clockSec: 720, gameSec: 720  },
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
const GRAD_CHECKPOINTS_WNBA = [
  { label: 'Q1_END', period: 2, clockSec: 600, gameSec: 600  },
  { label: 'Q2_7.5', period: 2, clockSec: 450, gameSec: 750  },
  { label: 'Q2_5',   period: 2, clockSec: 300, gameSec: 900  },
  { label: 'Q2_2.5', period: 2, clockSec: 150, gameSec: 1050 },
  { label: 'Q2_END', period: 2, clockSec: 0,   gameSec: 1200 },
  { label: 'Q3_7.5', period: 3, clockSec: 450, gameSec: 1350 },
  { label: 'Q3_5',   period: 3, clockSec: 300, gameSec: 1500 },
  { label: 'Q3_2.5', period: 3, clockSec: 150, gameSec: 1650 },
  { label: 'Q3_END', period: 3, clockSec: 0,   gameSec: 1800 },
  { label: 'Q4_7.5', period: 4, clockSec: 450, gameSec: 1950 },
  { label: 'Q4_5',   period: 4, clockSec: 300, gameSec: 2100 },
  { label: 'Q4_2.5', period: 4, clockSec: 150, gameSec: 2250 },
];
function getGradCheckpoints(league) {
  if (league === 'wnba') return GRAD_CHECKPOINTS_WNBA;
  return GRAD_CHECKPOINTS_NBA;
}
const GRAD_CHECKPOINTS = GRAD_CHECKPOINTS_NBA; // backward compat

function updateLiveTracking(lt, ctrlTeam, floor, period, clock, homeAlias, currentPeriod) {
  if (!lt) lt = {};
  const side = ctrlTeam === homeAlias ? 'home' : 'away';
  const peakKey = side + '_peak_floor';
  const timeStr = 'Q' + period + ' ' + clock;

  if (!lt[peakKey] || floor > lt[peakKey]) {
    lt[peakKey] = floor;
    lt[side + '_peak_time'] = timeStr;
  }

  // Running mean floor per side (for BUY erosion anchoring)
  lt[side + '_floor_sum'] = (lt[side + '_floor_sum'] || 0) + floor;
  lt[side + '_floor_count'] = (lt[side + '_floor_count'] || 0) + 1;

  if (lt.ctrl_team_current === ctrlTeam) {
    lt.ctrl_team_holds = (lt.ctrl_team_holds || 0) + 1;
  } else {
    lt.ctrl_team_current = ctrlTeam;
    lt.ctrl_team_holds = 1;
    lt.ctrl_flips = (lt.ctrl_flips || 0) + 1;
    // Q2+ flips only — Q1 flips are noise before structural control is meaningful
    if ((currentPeriod || period) >= 2) lt.ctrl_flips_q2plus = (lt.ctrl_flips_q2plus || 0) + 1;
  }

  return lt;
}

// Floor reliability lookup — returns historical win rate at team's current floor bucket
function lookupFloorWP(coeffs, team, floorScore) {
  const c = coeffs[team];
  if (!c) return { wp: null, reliabilityClass: 'NEUTRAL', grip: 0 };
  const bucket = String(Math.floor(floorScore * 10) / 10); // 0.73 -> "0.7"
  const wpData = c.closeFloorWP[bucket];
  return {
    wp: wpData ? wpData.wp : null,
    reliabilityClass: c.reliabilityClass,
    grip: c.grip
  };
}

// Module-scope coefficient cache — populated per invocation inside handler,
// referenced by fireCalibrationAnalysis (also module scope)
var _floorWPCoeffs = {};

function computeBwcState(lt, ctrlTeam, margin) {
  const bwcFired = lt.bwc_fired;
  if (!bwcFired || !ctrlTeam) return null;

  // Margin from BWC team's perspective (flip when BWC ≠ ctrl)
  const bwcMargin = bwcFired.team === ctrlTeam ? margin : -margin;

  if (bwcMargin >= 3) return 'LOCK';
  if (bwcMargin >= 1) return 'EDGE';
  if (bwcMargin >= -7) return 'VALUE';
  return 'DEEP_TRAIL';
}

// HYBRID EXIT — quarter-aware trigger system (validated May 11, 63 games):
//   Q2: XGB < 0.45 + MC Cum < 0.70 gate + 2-poll (90s). Fast-path XGB < 0.15.
//   Q3: MC Cum < 0.30 + 2-poll (90s). Fast-path MC < 0.10.
//   Q4: MC Cum < 0.25 + 1-poll (immediate). 80% precision (n=10).
// MC Cum AUC 0.96 in Q4 — strongest EXIT signal. XGB kept for Q2 where MC is too noisy.
function checkXGBExit(lt, xgbBwcProb, period, mcCumWinProb) {
  if (period < 2) return false;
  if (lt.xgb_exit_sent) return false; // one-shot per position

  // ── Q2: XGB trigger + MC Cum gate (unchanged) ──
  if (period === 2) {
    if (xgbBwcProb == null) return false;
    if (mcCumWinProb != null && mcCumWinProb >= 0.70) return false;
    if (xgbBwcProb < 0.15) { lt.exit_trigger = 'xgb'; return true; }
    if (xgbBwcProb < 0.45) {
      if (!lt.xgb_exit_warned) { lt.xgb_exit_warned = Date.now(); return false; }
      if (Date.now() - lt.xgb_exit_warned >= 90000) { lt.exit_trigger = 'xgb'; return true; }
      return false;
    } else if (xgbBwcProb >= 0.50) { lt.xgb_exit_warned = null; }
    return false;
  }

  // ── Q3: MC Cum < 0.30 + 2-poll confirmation ──
  if (period === 3) {
    if (mcCumWinProb == null) return false;
    if (mcCumWinProb < 0.10) { lt.exit_trigger = 'mc_cum'; return true; }
    if (mcCumWinProb < 0.30) {
      if (!lt.xgb_exit_warned) { lt.xgb_exit_warned = Date.now(); return false; }
      if (Date.now() - lt.xgb_exit_warned >= 90000) { lt.exit_trigger = 'mc_cum'; return true; }
      return false;
    } else if (mcCumWinProb >= 0.50) { lt.xgb_exit_warned = null; }
    return false;
  }

  // ── Q4: MC Cum < 0.25 + 1-poll (immediate) ──
  if (period >= 4) {
    if (mcCumWinProb == null) return false;
    if (mcCumWinProb < 0.25) { lt.exit_trigger = 'mc_cum'; return true; }
    // No confirmation needed — 1-poll. Clear warning if recovered.
    if (mcCumWinProb >= 0.45) { lt.xgb_exit_warned = null; }
    return false;
  }

  return false;
}

// ── COMPOUND CONFIRMATION — replaces checkpoint graduation ──────
// NBA sustain: MC Cum >= 0.80 AND Floor >= 0.60 (holds 2-5).
// WNBA sustain: MC Cum >= 0.80 AND XGB >= 0.60 (floor demoted to narrative).
// Establishment (hold 1) handled by caller.
// Q2 EARLY path adds lead >= 5 AND 0 prior flips.
// Returns { confirmed, tier, holds, path }.
// Stale poll guard: only counts hold when game clock has advanced.
// compound_tier is a watermark (only upgrades). compound_holds is the live streak.
function checkCompoundConfirmation(lt, mcCumWinProb, floor, period, clock, ctrlTeam, bwcTeam, ctrlMargin, priorFlips, league, xgbWinProb) {
  const result = { confirmed: false, tier: lt.compound_tier || 'TRACKING', holds: lt.compound_holds || 0, path: lt.compound_path || null };

  // Control must match BWC team — streak requires same team throughout
  if (ctrlTeam !== bwcTeam) {
    lt.compound_holds = 0;
    result.holds = 0;
    return result;
  }

  // Stale poll guard: skip if game clock hasn't advanced
  if (lt.compound_last_period === period && lt.compound_last_clock === clock) {
    return result; // no increment, no reset — just return current state
  }

  // Check compound threshold — league-specific signals
  let baseThreshold;
  if (league === 'wnba') {
    // WNBA: MC Cum + XGB compound (floor demoted to narrative)
    baseThreshold = mcCumWinProb != null && mcCumWinProb >= 0.80
                 && xgbWinProb != null && xgbWinProb >= 0.60;
  } else {
    // NBA: MC Cum + Floor compound (sustain at 0.60, establishment at 0.65 by caller)
    baseThreshold = mcCumWinProb != null && mcCumWinProb >= 0.80 && floor >= 0.60;
  }

  // Q2 early path adds margin and flip requirements
  const isQ2 = period === 2;
  const q2Extra = !isQ2 || (ctrlMargin >= 5 && priorFlips === 0);
  const thresholdMet = baseThreshold && q2Extra;

  if (thresholdMet) {
    lt.compound_holds = (lt.compound_holds || 0) + 1;
    lt.compound_last_period = period;
    lt.compound_last_clock = clock;
    result.holds = lt.compound_holds;

    // Determine path — Q2_EARLY only if confirmation completes during Q2
    if (lt.compound_holds >= 5 && !lt.compound_confirmed) {
      const path = isQ2 ? 'Q2_EARLY' : 'STANDARD';
      const tier = priorFlips === 0 ? 'CONFIRMED' : 'RECOVERING';

      lt.compound_confirmed = true;
      lt.compound_path = path;
      lt.compound_mc_at_confirm = mcCumWinProb;

      // Watermark — only upgrade
      const TIER_ORDER = { TRACKING: 0, RECOVERING: 1, CONFIRMED: 2, LOCKED: 3 };
      if ((TIER_ORDER[tier] || 0) > (TIER_ORDER[lt.compound_tier] || 0)) {
        lt.compound_tier = tier;
      }

      result.confirmed = true;
      result.tier = lt.compound_tier;
      result.path = path;
    }

    // LOCKED upgrade — 10 consecutive holds in single unbroken streak, 0 flips
    if (lt.compound_holds >= 10 && priorFlips === 0 && lt.compound_tier !== 'LOCKED') {
      lt.compound_tier = 'LOCKED';
      result.tier = 'LOCKED';
    }
  } else {
    // Threshold not met on a non-stale poll — reset streak
    lt.compound_holds = 0;
    lt.compound_last_period = period;
    lt.compound_last_clock = clock;
    result.holds = 0;
  }

  return result;
}

function classifyTransition(fromState, toState) {
  const fromRank = STATE_RANK[fromState] ?? -1;
  const toRank = STATE_RANK[toState] ?? -1;
  if (toRank < fromRank) return 'DEGRADING';
  if (toRank > fromRank) return 'RECOVERING';
  return 'LATERAL';
}

// ── RANK CLASSIFICATION — graduation-based POSITION OPEN ──────
// Mirrors backtest classifyBWCTier exactly. Must stay in sync.
function classifyRank(convictionTier, ctrlMargin, consecutiveHolds, oppIndicatorCount) {
  if (convictionTier === 'DOMINANT' && ctrlMargin >= 8
      && consecutiveHolds >= 4 && oppIndicatorCount <= 1) return 'A';
  if (oppIndicatorCount >= 3) return 'C';
  if ((convictionTier === 'DOMINANT' || convictionTier === 'STRONG')
      && ctrlMargin >= 3 && consecutiveHolds >= 2) return 'B';
  return 'C';
}

function computeErosion(lt, floor, homeAlias, ctrlTeam) {
  const side = ctrlTeam === homeAlias ? 'home' : 'away';
  const peakFloor = lt[side + '_peak_floor'] || null;
  if (!peakFloor || floor >= peakFloor) {
    return { level: 'STABLE', peakFloor, peakDelta: 0 };
  }
  const peakDelta = floor - peakFloor;
  const edgeAboveCoinFlip = peakFloor - 0.50;
  if (edgeAboveCoinFlip <= 0) {
    return { level: 'STABLE', peakFloor, peakDelta };
  }
  const cautionDelta = -(edgeAboveCoinFlip * 0.40);
  const collapseDelta = -(edgeAboveCoinFlip * 0.70);
  var level = 'STABLE';
  if (peakDelta <= collapseDelta) level = 'COLLAPSE';
  else if (peakDelta <= cautionDelta) level = 'CAUTION';
  return { level, peakFloor, peakDelta, cautionDelta, collapseDelta };
}

// Mean-floor-anchored erosion for BUY alerts.
// BUY bettors aren't "holding from the peak" — they're evaluating whether to enter.
// Mean floor trend is the right anchor, not an ephemeral early-game spike.
function computeMeanErosion(lt, floor, homeAlias, ctrlTeam) {
  const side = ctrlTeam === homeAlias ? 'home' : 'away';
  const sum = lt[side + '_floor_sum'] || 0;
  const count = lt[side + '_floor_count'] || 0;
  if (count < 3) return { level: 'STABLE', meanFloor: null, meanDelta: 0 };
  const meanFloor = Math.round((sum / count) * 1000) / 1000;
  if (floor >= meanFloor) return { level: 'STABLE', meanFloor, meanDelta: 0 };
  const meanDelta = floor - meanFloor;
  const edgeAboveCoinFlip = meanFloor - 0.50;
  if (edgeAboveCoinFlip <= 0) return { level: 'STABLE', meanFloor, meanDelta };
  const cautionDelta = -(edgeAboveCoinFlip * 0.40);
  const collapseDelta = -(edgeAboveCoinFlip * 0.70);
  var level = 'STABLE';
  if (meanDelta <= collapseDelta) level = 'COLLAPSE';
  else if (meanDelta <= cautionDelta) level = 'CAUTION';
  return { level, meanFloor, meanDelta, cautionDelta, collapseDelta };
}

function computeExitSeverity(ctrlIndicators, ctrlIndicatorCount, ctrlFloor, holds) {
  const oppOnlyI3 = ctrlIndicatorCount === 1 && ctrlIndicators.includes('I3');
  const oppHasI1 = ctrlIndicators.includes('I1');
  const oppHasI4 = ctrlIndicators.includes('I4');

  if (holds >= 5 && ctrlFloor >= 0.70 && ctrlIndicatorCount >= 2 && !oppOnlyI3) {
    return { severity: 'STRUCTURAL_TAKEOVER',
      reason: 'Opponent floor ' + ctrlFloor.toFixed(2) + ', ' + holds + ' holds, '
        + ctrlIndicatorCount + ' indicators (' + ctrlIndicators.join('+') + ')' };
  }
  if (holds >= 3 && (oppHasI1 || oppHasI4) && ctrlFloor >= 0.60) {
    return { severity: 'CONCERNING',
      reason: 'Opponent structural indicators (' + ctrlIndicators.join('+') + ') with '
        + holds + ' holds' };
  }
  return { severity: 'TEMPORARY',
    reason: 'Opponent floor ' + ctrlFloor.toFixed(2) + ', ' + holds + ' holds'
      + (oppOnlyI3 ? ', only I3 (variance)'
        : ctrlIndicatorCount === 0 ? ', no indicators won' : '') };
}

// ── CHECKPOINT TRAJECTORY HELPERS (agent context — NOT graduation) ────────────

function computeMFTrajectory(checkpoints, bwcTeam) {
  const eligible = checkpoints.filter(cp =>
    cp.team === bwcTeam && cp.floor >= 0.60 && cp.margin >= 2
  );
  if (eligible.length < 2) return { direction: 'INSUFFICIENT', floors: eligible.map(cp => cp.floor) };

  // Compare first half of eligible CPs to second half
  const mid = Math.floor(eligible.length / 2);
  const firstHalf = eligible.slice(0, mid);
  const secondHalf = eligible.slice(mid);
  const firstAvg = firstHalf.reduce((s, cp) => s + cp.floor, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((s, cp) => s + cp.floor, 0) / secondHalf.length;
  const delta = secondAvg - firstAvg;

  let direction;
  if (delta > 0.04) direction = 'RISING';
  else if (delta < -0.04) direction = 'DECLINING';
  else direction = 'FLAT';

  return {
    direction,
    delta: Math.round(delta * 1000) / 1000,
    floors: eligible.map(cp => cp.floor),
    firstAvg: Math.round(firstAvg * 1000) / 1000,
    secondAvg: Math.round(secondAvg * 1000) / 1000,
  };
}

// Full checkpoint trend — ALL checkpoints where BWC team has control (no floor/margin filter).
// Used for MF trend evaluation on transition alerts. Graduation-eligible MF (computeMFTrajectory)
// hides declining checkpoints; this shows the real trajectory including bad stretches.
function computeFullCPTrend(checkpoints, bwcTeam) {
  const bwcCPs = checkpoints.filter(cp => cp.team === bwcTeam);
  if (bwcCPs.length < 2) return { direction: 'INSUFFICIENT', floors: bwcCPs.map(cp => cp.floor), margins: bwcCPs.map(cp => cp.margin), count: bwcCPs.length };

  const mid = Math.floor(bwcCPs.length / 2);
  const firstFloors = bwcCPs.slice(0, mid);
  const secondFloors = bwcCPs.slice(mid);
  const firstAvg = firstFloors.reduce((s, cp) => s + cp.floor, 0) / firstFloors.length;
  const secondAvg = secondFloors.reduce((s, cp) => s + cp.floor, 0) / secondFloors.length;
  const delta = secondAvg - firstAvg;

  var direction;
  if (delta > 0.04) direction = 'RISING';
  else if (delta < -0.04) direction = 'DECLINING';
  else direction = 'FLAT';

  return {
    direction,
    delta: Math.round(delta * 1000) / 1000,
    floors: bwcCPs.map(cp => cp.floor),
    margins: bwcCPs.map(cp => cp.margin),
    count: bwcCPs.length,
    firstAvg: Math.round(firstAvg * 1000) / 1000,
    secondAvg: Math.round(secondAvg * 1000) / 1000,
  };
}

// Floor-margin divergence signal — does the structural floor agree with the scoreboard?
// Compares floor trend vs margin trend from BWC team checkpoints.
// DIVERGING_POSITIVE = floor declining but margin growing (floor stale, team winning)
// CONVERGING_DOWN = both declining (genuine structural decay)
function computeFloorMarginSignal(checkpoints, bwcTeam, currentFloor, currentBwcMargin) {
  const bwcCPs = checkpoints.filter(cp => cp.team === bwcTeam);
  // Include current values as the latest data point
  const floors = bwcCPs.map(cp => cp.floor).concat(currentFloor);
  const margins = bwcCPs.map(cp => cp.margin).concat(currentBwcMargin);

  if (floors.length < 4) return { signal: 'INSUFFICIENT', floorTrend: null, marginTrend: null };

  // Use last 8 data points max (recent history)
  const recent = Math.min(floors.length, 8);
  const rFloors = floors.slice(-recent);
  const rMargins = margins.slice(-recent);

  const mid = Math.floor(rFloors.length / 2);
  const f1 = rFloors.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const f2 = rFloors.slice(mid).reduce((a, b) => a + b, 0) / (rFloors.length - mid);
  const m1 = rMargins.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const m2 = rMargins.slice(mid).reduce((a, b) => a + b, 0) / (rMargins.length - mid);

  const fDelta = f2 - f1;
  const mDelta = m2 - m1;

  var floorTrend = fDelta > 0.03 ? 'RISING' : fDelta < -0.03 ? 'DECLINING' : 'FLAT';
  var marginTrend = mDelta > 1.5 ? 'GROWING' : mDelta < -1.5 ? 'SHRINKING' : 'FLAT';

  var signal = 'ALIGNED';
  if (floorTrend === 'DECLINING' && marginTrend === 'GROWING') signal = 'DIVERGING_POSITIVE';
  else if (floorTrend === 'RISING' && marginTrend === 'SHRINKING') signal = 'DIVERGING_NEGATIVE';
  else if (floorTrend === 'DECLINING' && marginTrend === 'SHRINKING') signal = 'CONVERGING_DOWN';
  else if (floorTrend === 'RISING' && marginTrend === 'GROWING') signal = 'CONVERGING_UP';

  return { signal, floorTrend, marginTrend, fDelta: Math.round(fDelta * 1000) / 1000, mDelta: Math.round(mDelta * 10) / 10 };
}

// Conviction trend from checkpoints — has conviction held, degraded, or improved?
function computeConvictionTrend(checkpoints, bwcTeam) {
  const bwcCPs = checkpoints.filter(cp => cp.team === bwcTeam && cp.conv);
  if (bwcCPs.length < 2) return { trend: 'INSUFFICIENT', tiers: [], held: false, current: null, degradePoint: null };

  const RANK = { 'DOMINANT': 4, 'STRONG': 3, 'CONDITIONAL': 2, 'MODEST': 1 };
  const tiers = bwcCPs.map(cp => cp.conv);
  const current = tiers[tiers.length - 1];
  const first = tiers[0];
  const held = tiers.every(t => t === first);

  // Find first degradation point
  var degradePoint = null;
  var maxRank = RANK[tiers[0]] || 0;
  for (var ci = 1; ci < tiers.length; ci++) {
    var r = RANK[tiers[ci]] || 0;
    if (r < maxRank && !degradePoint) {
      degradePoint = bwcCPs[ci].label;
    }
    if (r > maxRank) maxRank = r;
  }

  // Overall trend: compare first half avg rank to second half avg rank
  const mid = Math.floor(tiers.length / 2);
  const firstAvgR = tiers.slice(0, mid).reduce((s, t) => s + (RANK[t] || 0), 0) / mid;
  const secondAvgR = tiers.slice(mid).reduce((s, t) => s + (RANK[t] || 0), 0) / (tiers.length - mid);
  var trend = 'STABLE';
  if (secondAvgR < firstAvgR - 0.5) trend = 'DEGRADING';
  else if (secondAvgR > firstAvgR + 0.5) trend = 'IMPROVING';

  return { trend, tiers, held, current, degradePoint };
}

// ── SERVER-SIDE COMPUTE (I1–I5) ─────────────────────────────────────────────
// Pure function. No cardState, no DOM, no PBP, no baselines.
// Input: SR game summary JSON. Output: indicator scores + composite.

function computeServer(summary, pbpData, seasonQ4, league) {
  const H = summary.home, A = summary.away;
  if (!H || !A) return null;
  const hs = H.statistics || {}, as = A.statistics || {};
  const hA = H.alias || H.name || 'HOME', aA = A.alias || A.name || 'AWAY';
  const hS = H.points || 0, aS = A.points || 0;
  if (hS === 0 && aS === 0) return null;
  const cfg = LEAGUES[league] || LEAGUES.nba;
  const W = cfg.weights || { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };

  // I1 — Disruption & Conversion
  const hDisrupt = (hs.steals || 0) + (hs.blocks || 0);
  const aDisrupt = (as.steals || 0) + (as.blocks || 0);
  const disruptDiff = hDisrupt - aDisrupt;
  const disruptThresh = league === 'wnba' ? 2 : 1;
  const i1subA = disruptDiff > disruptThresh ? 1 : disruptDiff < -disruptThresh ? -1 : 0;
  const hPOT = hs.points_off_turnovers || 0, aPOT = as.points_off_turnovers || 0;
  const potDiff = hPOT - aPOT;
  const potThresh = league === 'wnba' ? 3 : 4;
  const i1subB = potDiff > potThresh ? 1 : potDiff < -potThresh ? -1 : 0;
  let i1raw = i1subA + i1subB;
  // Chaos layer — forced vs unforced TO split from PBP (±0.5, threshold ±4)
  if (pbpData) {
    const hForced = pbpData.away?.tos?.forced || 0, aForced = pbpData.home?.tos?.forced || 0;
    const hUnforced = pbpData.home?.tos?.unforced || 0, aUnforced = pbpData.away?.tos?.unforced || 0;
    if (hForced >= aForced + 4) i1raw += 0.5;
    else if (aForced >= hForced + 4) i1raw -= 0.5;
    else if (hUnforced >= aUnforced + 4) i1raw -= 0.5;
    else if (aUnforced >= hUnforced + 4) i1raw += 0.5;
  }
  const I1 = { score: i1raw > 0 ? 1 : i1raw === 0 ? 0.5 : 0, leader: i1raw > 0 ? hA : i1raw < 0 ? aA : 'EVEN' };

  // I2 — Interior Control (Sub-A: paint volume, Sub-B: rim efficiency)
  // I2 — Interior Control (NBA) / Perimeter & FT Access (WNBA)
  let i2raw;
  if (league === 'wnba') {
    const h3Pct = (hs.three_points_att || 0) > 4 ? (hs.three_points_made || 0) / (hs.three_points_att || 1) * 100 : null;
    const a3Pct = (as.three_points_att || 0) > 4 ? (as.three_points_made || 0) / (as.three_points_att || 1) * 100 : null;
    let wi2a = 0;
    if (h3Pct != null && a3Pct != null) {
      if (h3Pct - a3Pct > 3) wi2a = 1;
      else if (a3Pct - h3Pct > 3) wi2a = -1;
    }
    const hFTA = hs.free_throws_att || 0, aFTA = as.free_throws_att || 0;
    const wi2b = (hFTA - aFTA > 2) ? 1 : (aFTA - hFTA > 2) ? -1 : 0;
    i2raw = wi2a + wi2b;
  } else {
    const hPaint = hs.points_in_the_paint || hs.points_in_paint || 0;
    const aPaint = as.points_in_the_paint || as.points_in_paint || 0;
    const paintDiff = hPaint - aPaint;
    let i2subA = 0;
    if (paintDiff > 6) i2subA = 1;
    else if (paintDiff < -6) i2subA = -1;
    const hRimM = hs.field_goals_at_rim_made || 0, hRimA = hs.field_goals_at_rim_att || 0;
    const aRimM = as.field_goals_at_rim_made || 0, aRimA = as.field_goals_at_rim_att || 0;
    const hRimPct = hRimA >= 6 ? hRimM / hRimA : null;
    const aRimPct = aRimA >= 6 ? aRimM / aRimA : null;
    let i2subB = 0;
    if (hRimPct != null && aRimPct != null) {
      if (hRimPct - aRimPct > 0.10) i2subB = 1;
      else if (aRimPct - hRimPct > 0.10) i2subB = -1;
    }
    i2raw = i2subA + i2subB;
  }
  const I2 = { score: i2raw > 0 ? 1 : i2raw < 0 ? 0 : 0.5, leader: i2raw > 0 ? hA : i2raw < 0 ? aA : 'EVEN' };

  // I3 — Shot Quality & Creation
  const hFGA = hs.field_goals_att || 1, aFGA = as.field_goals_att || 1;
  const hEFG = ((hs.field_goals_made || 0) + 0.5 * (hs.three_points_made || 0)) / hFGA;
  const aEFG = ((as.field_goals_made || 0) + 0.5 * (as.three_points_made || 0)) / aFGA;
  const hAst = hs.assists || 0, aAst = as.assists || 0;
  const hFGM = hs.field_goals_made || 1, aFGM = as.field_goals_made || 1;
  let i3raw;
  if (league === 'wnba') {
    const efgDiff = hEFG - aEFG;
    const astDiff = hAst - aAst;
    i3raw = (efgDiff > 0.03 ? 1 : efgDiff < -0.03 ? -1 : 0)
          + (astDiff > 2 ? 1 : astDiff < -2 ? -1 : 0);
  } else {
    const hAR = (hAst / hFGM) * 100, aAR = (aAst / aFGM) * 100;
    const hCS3 = pbpData?.home?.threes?.assisted || 0, aCS3 = pbpData?.away?.threes?.assisted || 0;
    i3raw = (hEFG > aEFG + 0.02 ? 1 : hEFG < aEFG - 0.02 ? -1 : 0)
          + (hAR > aAR + 5 ? 1 : hAR < aAR - 5 ? -1 : 0)
          + (hCS3 > aCS3 + 2 ? 1 : hCS3 < aCS3 - 2 ? -1 : 0);
  }
  const I3 = { score: i3raw > 0 ? 1 : i3raw === 0 ? 0.5 : 0, leader: i3raw > 0 ? hA : i3raw < 0 ? aA : 'EVEN' };

  // I4 — Game Control
  const hBigLead = hs.biggest_lead || 0, aBigLead = as.biggest_lead || 0;
  let i4subA = 0;
  if (league === 'wnba') {
    const blDiff = hBigLead - aBigLead;
    i4subA = blDiff > 4 ? 1 : blDiff < -4 ? -1 : 0;
  } else {
    // NBA: ≥2 gap with 75% contested check
    if (hBigLead >= aBigLead + 2) {
      i4subA = (aBigLead >= 0.75 * hBigLead) ? 0 : 1;
    } else if (aBigLead >= hBigLead + 2) {
      i4subA = (hBigLead >= 0.75 * aBigLead) ? 0 : -1;
    }
  }
  let i4subB = 0;
  const periods = summary.periods || [];
  if (periods.length >= 4) {
    // Q4+ — use live last quarter diff
    const lastP = periods[periods.length - 1];
    const lastQDiff = (lastP?.home_points || 0) - (lastP?.away_points || 0);
    i4subB = lastQDiff > 2 ? 1 : lastQDiff < -2 ? -1 : 0;
  } else if (seasonQ4) {
    // Pre-Q4 — use season Q4 margin prior
    const sznQ4diff = (seasonQ4[hA] || 0) - (seasonQ4[aA] || 0);
    i4subB = sznQ4diff > 2 ? 1 : sznQ4diff < -2 ? -1 : 0;
  }
  const i4raw = i4subA + i4subB;
  const I4 = { score: i4raw > 0 ? 1 : i4raw === 0 ? 0.5 : 0, leader: i4raw > 0 ? hA : i4raw < 0 ? aA : 'EVEN' };

  // I5 — Sustained Execution (NBA) / Momentum (WNBA)
  let I5 = { score: 0.5, leader: 'EVEN' };
  if (league === 'wnba') {
    const hReb = (hs.offensive_rebounds || 0) + (hs.defensive_rebounds || 0);
    const aReb = (as.offensive_rebounds || 0) + (as.defensive_rebounds || 0);
    const i5raw = (hReb - aReb > 3 ? 1 : aReb - hReb > 3 ? -1 : 0);
    I5 = { score: i5raw > 0 ? 1 : i5raw === 0 ? 0.5 : 0, leader: i5raw > 0 ? hA : i5raw < 0 ? aA : 'EVEN' };
  } else if (pbpData?.runs6) {
    const hRuns = pbpData.runs6.filter(r => r.team === hA).length;
    const aRuns = pbpData.runs6.filter(r => r.team === aA).length;
    const totalRuns = hRuns + aRuns;
    if (totalRuns >= 4) {
      const runShare = hRuns / totalRuns;
      I5 = { score: runShare > 0.55 ? 1 : runShare < 0.45 ? 0 : 0.5,
             leader: runShare > 0.55 ? hA : runShare < 0.45 ? aA : 'EVEN' };
    }
  }

  // Composite
  const raw = I1.score * W.I1 + I2.score * W.I2 + I3.score * W.I3 + I4.score * W.I4 + I5.score * W.I5;
  const controlHome = raw >= 0.5;
  const controlTeam = controlHome ? hA : aA;
  const score = controlHome ? raw : 1 - raw;

  return {
    controlTeam,
    score: Math.round(score * 100) / 100,
    I1, I2, I3, I4, I5,
    homeAlias: hA,
    awayAlias: aA,
    homePts: hS,
    awayPts: aS,
  };
}

// ── CTRL-RELATIVE I1-I5 HELPER ──
// All storage (snapshots, alerts) and agent context should use ctrl-relative indicators.
// I1-I5 from computeServer are HOME-relative (1 = home wins). This flips to ctrl perspective.
function ctrlI(ind) {
  var ch = ind.controlTeam === ind.homeAlias;
  return [ind.I1, ind.I2, ind.I3, ind.I4, ind.I5].map(
    function(v) { return v && v.score != null ? Math.round((ch ? v.score : 1 - v.score) * 10) / 10 : null; }
  );
}

// ── CONVICTION ENGINE — combo-pattern-driven from 171-game validation ──────
// Returns mechanical conviction tier based on WHICH indicators the control team wins.
// Data basis: I4+I5=100%(77g), I3+I4=99%(68g), I3+I5=96%(68g), 4+=100%(66g), 3=85%(62g), 2=70%(33g)
function computeConviction(ind, league) {
  if (!ind || ind.score == null) return { tier: 'NO ENTRY', combo: 'NONE', indicatorsWon: [], indicatorsLost: [], count: 0, pairs: [] };
  const ctrlHome = ind.controlTeam === ind.homeAlias;

  // Determine which indicators the control team wins
  const wins = [], loses = [], even = [];
  for (const [key, val] of [['I1', ind.I1], ['I2', ind.I2], ['I3', ind.I3], ['I4', ind.I4], ['I5', ind.I5]]) {
    if (!val || val.score == null) { even.push(key); continue; }
    const ctrlScore = ctrlHome ? val.score : 1 - val.score;
    if (ctrlScore > 0.5) wins.push(key);
    else if (ctrlScore < 0.5) loses.push(key);
    else even.push(key);
  }

  const count = wins.length;
  const has = (a, b) => wins.includes(a) && wins.includes(b);
  const combo = count > 0 ? wins.join('+') : 'NONE';

  let tier, isDanger = false;
  const pairs = [];

  if (league === 'wnba') {
    // WNBA conviction rules — I3 is anchor (30% weight), I4+I2 are killers
    const hasI3I4 = has('I3', 'I4');
    const hasI3I2 = has('I3', 'I2');
    const hasI4I2 = has('I4', 'I2');
    const hasKillerPair = hasI3I4 || hasI3I2 || hasI4I2;

    if (count >= 4 || (hasI3I4 && count >= 3)) {
      tier = 'DOMINANT';
    } else if (hasKillerPair) {
      tier = 'STRONG';
    } else if (count >= 2) {
      tier = 'MODEST';
    } else if (count >= 1) {
      tier = 'CONDITIONAL';
    } else {
      tier = 'NO ENTRY';
    }

    if (hasI3I4) pairs.push('I3+I4');
    if (hasI3I2) pairs.push('I3+I2');
    if (hasI4I2) pairs.push('I4+I2');
  } else {
    // NBA conviction rules (171-game validated)
    const hasI4I5 = has('I4', 'I5');
    const hasI3I4 = has('I3', 'I4');
    const hasI3I5 = has('I3', 'I5');
    const hasKillerPair = hasI4I5 || hasI3I4 || hasI3I5;

    isDanger = (
      (count === 2 && wins.includes('I1') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4')) ||
      (count === 3 && wins.includes('I1') && wins.includes('I2') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4')) ||
      (count === 3 && wins.includes('I2') && wins.includes('I3') && wins.includes('I5') && !wins.includes('I4'))
    );

    if (count >= 4 || hasI4I5) {
      tier = 'DOMINANT';
    } else if (hasKillerPair && !isDanger) {
      tier = 'STRONG';
    } else if (count >= 2 && !isDanger) {
      tier = 'MODEST';
    } else if (count >= 1) {
      tier = 'CONDITIONAL';
    } else {
      tier = 'NO ENTRY';
    }

    if (hasI4I5) pairs.push('I4+I5');
    if (hasI3I4) pairs.push('I3+I4');
    if (hasI3I5) pairs.push('I3+I5');
  }

  return { tier, combo, count, indicatorsWon: wins, indicatorsLost: loses, indicatorsEven: even, pairs, isDanger };
}

// ── QUARTER DATA HELPERS ──────────────────────────────────────────────────────
// Extracts the ~23 stat fields that power I1-I5 from a team's statistics object.
// Used for boundary capture and per-quarter diffing.

const QD_STAT_KEYS = [
  // I1 inputs
  'steals', 'offensive_rebounds', 'turnovers', 'total_turnovers',
  'fast_break_points', 'points_off_turnovers', 'second_chance_points',
  // I2 inputs
  'points_in_the_paint', 'points_in_paint', 'field_goals_at_rim_made', 'field_goals_at_rim_att',
  'free_throws_att', 'blocks', 'fouls_drawn', 'personal_fouls',
  // I3 inputs
  'field_goals_made', 'field_goals_att', 'three_points_made', 'three_points_att',
  'assists',
  // I4 inputs
  'bench_points', 'biggest_lead', 'points',
  // I5 inputs
  'offensive_points_per_possession', 'defensive_points_per_possession',
  'possessions',
  // Free throws (for sustainability / evidence)
  'free_throws_made',
];

function extractBoundaryStats(teamStats) {
  if (!teamStats) return {};
  const out = {};
  for (const k of QD_STAT_KEYS) {
    if (teamStats[k] != null) out[k] = teamStats[k];
  }
  return out;
}

function diffBoundaryStats(current, previous) {
  if (!current || !previous) return current || {};
  const d = {};
  for (const k of QD_STAT_KEYS) {
    const c = current[k], p = previous[k];
    // Rate fields — don't diff, use current value directly
    if (k === 'offensive_points_per_possession' || k === 'defensive_points_per_possession') {
      d[k] = c != null ? c : null;
      continue;
    }
    // biggest_lead — game-level max, not diffable, use current cumulative
    if (k === 'biggest_lead') {
      d[k] = c != null ? c : null;
      continue;
    }
    // Count fields — diff normally
    if (c != null && p != null) d[k] = c - p;
    else if (c != null) d[k] = c;
    else d[k] = null;
  }
  // Compute per-quarter efficiency from diffed possessions and points
  const qPoss = d.possessions;
  const qPts = d.points;
  if (qPoss != null && qPoss > 0 && qPts != null) {
    d._quarter_ppp = qPts / qPoss;
  }
  return d;
}

// Read quarter_data from games row, or return empty structure
async function readQuarterData(sql, gameId) {
  try {
    const rows = await sql`SELECT quarter_data FROM games WHERE id = ${gameId}`;
    if (rows.length > 0 && rows[0].quarter_data) {
      const qd = typeof rows[0].quarter_data === 'string'
        ? JSON.parse(rows[0].quarter_data)
        : rows[0].quarter_data;
      return qd;
    }
  } catch (e) { /* column may not exist yet */ }
  return { boundaries: {}, diffs: {}, window: null };
}

// Write quarter_data back to games row
async function writeQuarterData(sql, gameId, qd) {
  try {
    await sql`UPDATE games SET quarter_data = ${JSON.stringify(qd)} WHERE id = ${gameId}`;
  } catch (e) {
    log(`quarter_data write failed for ${gameId}: ${e.message}`);
  }
}

// Capture a boundary: freeze cumulative stats, compute diff from previous boundary
function captureBoundary(qd, periodKey, prevKey, homeStats, awayStats) {
  const boundary = {
    ts: new Date().toISOString(),
    home: extractBoundaryStats(homeStats),
    away: extractBoundaryStats(awayStats),
  };
  qd.boundaries[periodKey] = boundary;

  // Compute diff from the specified previous boundary
  const prevBoundary = qd.boundaries[prevKey];
  if (prevBoundary) {
    qd.diffs[periodKey] = {
      home: diffBoundaryStats(boundary.home, prevBoundary.home),
      away: diffBoundaryStats(boundary.away, prevBoundary.away),
    };
  }

  return qd;
}

// ── COMPUTE SERVER-SIDE ROLLING WINDOW ────────────────────────────────────────
// Runs every poll. Reads quarter_data boundaries, computes a partial diff for
// the current quarter, scores I1-I5 on the cross-fade weighted aggregate,
// saves the result back to quarter_data.window.
//
// Cross-fade weighting (matches client):
//   Q2: Q1(fading) + Q2(partial)
//   Q3: Q2(anchor) + Q3(partial)
//   Q4: Q2(fading) + Q3(anchor) + Q4(partial)
//   OT: Q3(fading) + Q4(anchor) + OT(partial)

function computeServerWindow(qd, currentPeriod, clock, summary, hA, aA, league) {
  if (!qd || !qd.boundaries) return null;

  // Need at least one completed quarter boundary + current stats
  const completedKeys = Object.keys(qd.diffs || {}).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (completedKeys.length === 0) return null;

  // Compute partial current quarter: current cumulative - last boundary
  const lastBoundaryKey = String(Math.max(...completedKeys));
  const lastBoundary = qd.boundaries[lastBoundaryKey];
  if (!lastBoundary) return null;

  const homeStats = summary.home?.statistics || {};
  const awayStats = summary.away?.statistics || {};
  const partialDiff = {
    home: diffBoundaryStats(extractBoundaryStats(homeStats), lastBoundary.home),
    away: diffBoundaryStats(extractBoundaryStats(awayStats), lastBoundary.away),
  };

  // Clock → completion fraction
  const clockParts = (clock || '').split(':');
  const clockMins = clockParts.length === 2 ? parseInt(clockParts[0]) + (parseInt(clockParts[1] || 0) / 60) : 12;
  const periodLength = league === 'ncaamb' ? 20 : league === 'wnba' ? 10 : 12;
  const completion = Math.max(0, Math.min(1, (periodLength - clockMins) / periodLength));

  // Build weighted quarter map: {quarterKey: {weight, diff}}
  const windowQs = [];
  const p = currentPeriod;

  if (league === 'ncaamb') {
    // NCAAMB uses synthetic quarter keys 1,2,3
    // sQ1 = H1 first 10min, sQ2 = H1 last 10min + halftime, sQ3 = H2 first 10min
    // The diff keys match: 1, 2, 3
    for (const k of completedKeys) {
      // Older quarters fade, recent anchor
      const maxK = Math.max(...completedKeys);
      const weight = (k === maxK) ? 1.0 : (k >= maxK - 1) ? 1.0 : 0.5;
      if (qd.diffs[k]) windowQs.push({ key: k, weight, diff: qd.diffs[k] });
    }
    // Add partial current — key is next synthetic quarter after last completed
    const partialKey = Math.max(...completedKeys) + 1;
    windowQs.push({ key: partialKey, weight: 1.0, diff: partialDiff, partial: true });
  } else {
    // NBA cross-fade logic
    if (p === 2) {
      if (qd.diffs['1']) windowQs.push({ key: 1, weight: Math.max(0, 1.0 - completion), diff: qd.diffs['1'] });
      windowQs.push({ key: 2, weight: 1.0, diff: partialDiff, partial: true });
    } else if (p === 3) {
      if (qd.diffs['2']) windowQs.push({ key: 2, weight: 1.0, diff: qd.diffs['2'] });
      windowQs.push({ key: 3, weight: 1.0, diff: partialDiff, partial: true });
    } else if (p === 4) {
      if (qd.diffs['2']) windowQs.push({ key: 2, weight: Math.max(0, 1.0 - completion), diff: qd.diffs['2'] });
      if (qd.diffs['3']) windowQs.push({ key: 3, weight: 1.0, diff: qd.diffs['3'] });
      windowQs.push({ key: 4, weight: 1.0, diff: partialDiff, partial: true });
    } else if (p >= 5) {
      if (qd.diffs['3']) windowQs.push({ key: 3, weight: Math.max(0, 1.0 - completion), diff: qd.diffs['3'] });
      if (qd.diffs['4']) windowQs.push({ key: 4, weight: 1.0, diff: qd.diffs['4'] });
      windowQs.push({ key: p, weight: 1.0, diff: partialDiff, partial: true });
    } else {
      // Q1 or earlier — too early for a window
      return null;
    }
  }

  if (windowQs.length === 0) return null;

  // Aggregate stats with cross-fade weights
  function aggSide(side) {
    const agg = {};
    const countKeys = QD_STAT_KEYS.filter(k =>
      k !== 'offensive_points_per_possession' && k !== 'defensive_points_per_possession' && k !== 'biggest_lead'
    );
    for (const k of countKeys) {
      let sum = 0, hasAny = false;
      for (const wq of windowQs) {
        const v = wq.diff?.[side]?.[k];
        if (v != null) { sum += v * wq.weight; hasAny = true; }
      }
      agg[k] = hasAny ? sum : null;
    }
    // Derived rates from aggregated counts
    const fga = agg.field_goals_att || 1;
    agg.efg = fga > 0 ? ((agg.field_goals_made || 0) + 0.5 * (agg.three_points_made || 0)) / fga : null;
    agg.assist_ratio = (agg.field_goals_made || 0) > 0 ? ((agg.assists || 0) / (agg.field_goals_made || 1)) * 100 : null;
    // Per-quarter efficiency: weighted average of _quarter_ppp
    let pppSum = 0, pppW = 0;
    for (const wq of windowQs) {
      const ppp = wq.diff?.[side]?._quarter_ppp;
      if (ppp != null) { pppSum += ppp * wq.weight; pppW += wq.weight; }
    }
    agg.ppp = pppW > 0 ? pppSum / pppW : null;
    return agg;
  }

  const hW = aggSide('home'), aW = aggSide('away');

  // Score I1-I5 on aggregated window stats
  // Thresholds scaled for ~2 quarter window volume

  // I1 — Disruption & Conversion (window: disruption only, no POT in quarter diffs)
  const hWDisrupt = (hW.steals || 0) + (hW.blocks || 0);
  const aWDisrupt = (aW.steals || 0) + (aW.blocks || 0);
  const wDisruptDiff = hWDisrupt - aWDisrupt;
  const wDisruptThresh = league === 'wnba' ? 2 : 1;
  const i1r = wDisruptDiff > wDisruptThresh ? 1 : wDisruptDiff < -wDisruptThresh ? -1 : 0;
  const wI1 = { score: i1r > 0 ? 1 : i1r === 0 ? 0.5 : 0, leader: i1r > 0 ? hA : i1r < 0 ? aA : 'EVEN' };

  // I2 — Interior Control (NBA) / Perimeter & FT Access (WNBA)
  let wi2raw;
  if (league === 'wnba') {
    const wH3A = hW.three_points_att || 0, wA3A = aW.three_points_att || 0;
    const wH3Pct = wH3A > 4 ? (hW.three_points_made || 0) / wH3A * 100 : null;
    const wA3Pct = wA3A > 4 ? (aW.three_points_made || 0) / wA3A * 100 : null;
    let wi2a = 0;
    if (wH3Pct != null && wA3Pct != null) {
      if (wH3Pct - wA3Pct > 3) wi2a = 1;
      else if (wA3Pct - wH3Pct > 3) wi2a = -1;
    }
    const wHFTA = hW.free_throws_att || 0, wAFTA = aW.free_throws_att || 0;
    const wi2b = (wHFTA - wAFTA > 2) ? 1 : (wAFTA - wHFTA > 2) ? -1 : 0;
    wi2raw = wi2a + wi2b;
  } else {
    const hPaint = hW.points_in_the_paint || hW.points_in_paint || 0;
    const aPaint = aW.points_in_the_paint || aW.points_in_paint || 0;
    const wPaintDiff = hPaint - aPaint;
    let wi2subA = 0;
    if (wPaintDiff > 3) wi2subA = 1;
    else if (wPaintDiff < -3) wi2subA = -1;
    const whRimM = hW.field_goals_at_rim_made || 0, whRimA = hW.field_goals_at_rim_att || 0;
    const waRimM = aW.field_goals_at_rim_made || 0, waRimA = aW.field_goals_at_rim_att || 0;
    const whRimPct = whRimA >= 6 ? whRimM / whRimA : null;
    const waRimPct = waRimA >= 6 ? waRimM / waRimA : null;
    let wi2subB = 0;
    if (whRimPct != null && waRimPct != null) {
      if (whRimPct - waRimPct > 0.10) wi2subB = 1;
      else if (waRimPct - whRimPct > 0.10) wi2subB = -1;
    }
    wi2raw = wi2subA + wi2subB;
  }
  const wI2 = { score: wi2raw > 0 ? 1 : wi2raw < 0 ? 0 : 0.5, leader: wi2raw > 0 ? hA : wi2raw < 0 ? aA : 'EVEN' };

  // I3 — Shot Quality & Creation
  const hEFG = hW.efg || 0, aEFG = aW.efg || 0;
  let i3r;
  if (league === 'wnba') {
    const wHAst = hW.assists || 0, wAAst = aW.assists || 0;
    i3r = (hEFG > aEFG + 0.03 ? 1 : hEFG < aEFG - 0.03 ? -1 : 0)
        + (wHAst - wAAst > 2 ? 1 : wAAst - wHAst > 2 ? -1 : 0);
  } else {
    const hAR = hW.assist_ratio || 0, aAR = aW.assist_ratio || 0;
    i3r = (hEFG > aEFG + 0.02 ? 1 : hEFG < aEFG - 0.02 ? -1 : 0)
        + (hAR > aAR + 5 ? 1 : hAR < aAR - 5 ? -1 : 0);
  }
  const wI3 = { score: i3r > 0 ? 1 : i3r === 0 ? 0.5 : 0, leader: i3r > 0 ? hA : i3r < 0 ? aA : 'EVEN' };

  // I4 — Game Control (cumulative biggest_lead + window scoring margin)
  const hBigLead = homeStats.biggest_lead || 0, aBigLead = awayStats.biggest_lead || 0;
  let wi4subA = 0;
  if (league === 'wnba') {
    const blDiff = hBigLead - aBigLead;
    wi4subA = blDiff > 4 ? 1 : blDiff < -4 ? -1 : 0;
  } else {
    if (hBigLead >= aBigLead + 2) {
      wi4subA = (aBigLead >= 0.75 * hBigLead) ? 0 : 1;
    } else if (aBigLead >= hBigLead + 2) {
      wi4subA = (hBigLead >= 0.75 * aBigLead) ? 0 : -1;
    }
  }
  const margins = windowQs.map(wq => ((wq.diff?.home?.points || 0) - (wq.diff?.away?.points || 0)));
  const marginSum = margins.reduce((a, b) => a + b, 0);
  const wi4subB = marginSum > 4 ? 1 : marginSum < -4 ? -1 : 0;
  const i4r = wi4subA + wi4subB;
  const wI4 = { score: i4r > 0 ? 1 : i4r === 0 ? 0.5 : 0, leader: i4r > 0 ? hA : i4r < 0 ? aA : 'EVEN' };

  // I5 — Sustained Execution (cumulative runShare — runs not window-segmentable)
  const wI5 = { score: 0.5, leader: 'EVEN' };

  // Composite (league-local weights)
  const _wW = (LEAGUES[league]?.weights) || { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };
  const raw = wI1.score * _wW.I1 + wI2.score * _wW.I2 + wI3.score * _wW.I3 + wI4.score * _wW.I4 + wI5.score * _wW.I5;
  const ctrlHome = raw >= 0.5;
  const wTeam = ctrlHome ? hA : aA;
  const wScore = ctrlHome ? raw : 1 - raw;

  // Build window labels
  const windowQuarters = windowQs.map(wq => 'Q' + wq.key + (wq.partial ? '*' : ''));

  return {
    available: true,
    score: Math.round(wScore * 100) / 100,
    controlTeam: wTeam,
    windowQuarters,
    I1: { score: Math.round(wI1.score * 10) / 10 },
    I2: { score: Math.round(wI2.score * 10) / 10 },
    I3: { score: Math.round(wI3.score * 10) / 10 },
    I4: { score: Math.round(wI4.score * 10) / 10 },
    I5: { score: Math.round(wI5.score * 10) / 10 },
    rawAgg: { home: hW, away: aW },
    dataQuality: 'SERVER-QD',
    source: 'server-qd',
    partial_quarter: currentPeriod,
    updated_at: new Date().toISOString(),
  };
}

// ── SERVER-SIDE SUSTAINABILITY AUDIT ─────────────────────────────────────────
// Ported from analyze.js. Pure function of SR summary data.
// No tracking data server-side — degrades gracefully (uses assist ratio only).

function computeSustainability(summary, league) {
  if (!summary) return null;

  function auditTeam(teamData, teamAlias) {
    if (!teamData) return null;
    var stats = teamData.statistics || {};
    var players = teamData.players || [];

    var team3PM = stats.three_points_made || 0;
    var team3PA = stats.three_points_att || 0;
    var teamFGA = stats.field_goals_att || 1;
    var live3Pct = team3PA > 0 ? (team3PM / team3PA * 100) : 0;

    // Season prior from player averages (SR summary may include .average)
    var seasonPrior3Pct = league === 'wnba' ? 34.7 : league === 'ncaamb' ? 33.5 : 36.0;
    var gotSeasonData = false;
    var seasonTot3PM = 0, seasonTot3PA = 0;
    players.forEach(function(p) {
      var avg = p.average || p.season || {};
      var m = avg.three_points_made || avg.fg3m || 0;
      var a = avg.three_points_att || avg.fg3a || 0;
      seasonTot3PM += m;
      seasonTot3PA += a;
    });
    if (seasonTot3PA >= 5) {
      seasonPrior3Pct = seasonTot3PM / seasonTot3PA * 100;
      gotSeasonData = true;
    }

    // Personnel audit
    var makesByTier = { elite: 0, average: 0, non: 0 };
    var personnelDetails = [];
    players.forEach(function(p) {
      var live = p.statistics || {};
      var avg = p.average || p.season || {};
      var live3m = live.three_points_made || 0;
      var live3a = live.three_points_att || 0;
      if (live3a < 2) return;

      var szn3m = avg.three_points_made || avg.fg3m || 0;
      var szn3a = avg.three_points_att || avg.fg3a || 0;
      var sznPct = szn3a >= 1.0 ? (szn3m / szn3a * 100) : null;
      var sznVol = szn3a;

      var tier, tierLabel;
      if (sznPct === null) { tier = 'non'; tierLabel = 'UNKNOWN'; }
      else if (sznPct >= 38.0 && sznVol >= 2.0) { tier = 'elite'; tierLabel = 'ELITE'; }
      else if (sznPct >= 33.0 || (sznPct >= 30.0 && sznVol >= 3.0)) { tier = 'average'; tierLabel = 'AVERAGE'; }
      else { tier = 'non'; tierLabel = 'NON-SHOOTER'; }

      if (sznVol < 1.5 && tier === 'elite') { tier = 'average'; tierLabel = 'AVG (low vol)'; }
      if (sznVol < 0.8 && tier !== 'non') { tier = 'non'; tierLabel = 'NON-SHOOTER (rare)'; }

      makesByTier[tier] += live3m;

      var livePct = (live3m / live3a * 100).toFixed(0);
      var sznStr = sznPct !== null ? sznPct.toFixed(1) + '% (' + sznVol.toFixed(1) + '/gm)' : 'N/A';
      var hot = sznPct !== null && (live3m / live3a * 100) > sznPct + 12;

      personnelDetails.push({
        name: p.full_name || p.name || '?',
        live3m: live3m, live3a: live3a, livePct: livePct,
        sznPct: sznPct, sznVol: sznVol, sznStr: sznStr,
        tier: tier, tierLabel: tierLabel, hot: hot,
      });
    });

    var totalMakes = team3PM || 1;
    var elitePct = makesByTier.elite / totalMakes * 100;
    var nonPct = makesByTier.non / totalMakes * 100;

    var personnelGrade;
    if (elitePct >= 70) personnelGrade = 'LOCKED IN';
    else if (elitePct >= 50 && nonPct <= 20) personnelGrade = 'DURABLE';
    else if (nonPct >= 50) personnelGrade = 'UNSUSTAINABLE';
    else if (nonPct >= 35) personnelGrade = 'FRAGILE';
    else personnelGrade = 'MIXED';

    // Bayesian regression
    var priorStrength = 30;
    var priorAlpha = seasonPrior3Pct / 100 * priorStrength;
    var priorBeta = (1 - seasonPrior3Pct / 100) * priorStrength;
    var posteriorAlpha = priorAlpha + team3PM;
    var posteriorBeta = priorBeta + (team3PA - team3PM);
    var posteriorMean = posteriorAlpha / (posteriorAlpha + posteriorBeta) * 100;
    var deviation = live3Pct - seasonPrior3Pct;

    var regressionProb;
    if (team3PA <= 8) regressionProb = 85;
    else if (team3PA <= 14) regressionProb = 70;
    else if (team3PA <= 20) regressionProb = 55;
    else if (team3PA <= 28) regressionProb = 40;
    else regressionProb = 25;

    if (deviation > 15) regressionProb = Math.min(95, regressionProb + 15);
    else if (deviation > 8) regressionProb = Math.min(95, regressionProb + 8);
    else if (deviation > 3) regressionProb = Math.min(95, regressionProb + 3);
    else if (deviation < -8) regressionProb = Math.max(5, regressionProb - 15);
    else if (deviation < -3) regressionProb = Math.max(5, regressionProb - 8);

    var regressionPull = 0;
    if (team3PA > 0 && Math.abs(live3Pct - seasonPrior3Pct) > 0.5) {
      regressionPull = Math.abs(posteriorMean - live3Pct) / Math.abs(live3Pct - seasonPrior3Pct) * 100;
    }
    regressionPull = Math.min(100, Math.max(0, regressionPull));

    var regressionGrade;
    if (regressionProb >= 75) regressionGrade = 'HIGH';
    else if (regressionProb >= 55) regressionGrade = 'MODERATE';
    else if (regressionProb >= 35) regressionGrade = 'LOW';
    else regressionGrade = 'MINIMAL';

    // Shot type context (no tracking data server-side — assist ratio only)
    var teamAssists = stats.assists || 0;
    var teamFGM = stats.field_goals_made || 1;
    var assistRatio = teamAssists / teamFGM * 100;

    var shotTypeGrade, shotTypeNote;
    if (assistRatio >= 65) { shotTypeGrade = 'DURABLE'; shotTypeNote = 'High ast% (' + assistRatio.toFixed(0) + '%)'; }
    else if (assistRatio < 45) { shotTypeGrade = 'FRAGILE'; shotTypeNote = 'Low ast% (' + assistRatio.toFixed(0) + '%)'; }
    else { shotTypeGrade = 'MIXED'; shotTypeNote = 'Moderate ast% (' + assistRatio.toFixed(0) + '%)'; }

    // Composite tier: personnel 40%, regression 35%, shot type 25%
    var scores = { personnel: 0, regression: 0, shotType: 0 };
    if (personnelGrade === 'LOCKED IN') scores.personnel = 0;
    else if (personnelGrade === 'DURABLE') scores.personnel = 0.5;
    else if (personnelGrade === 'MIXED') scores.personnel = 1;
    else if (personnelGrade === 'FRAGILE') scores.personnel = 1.5;
    else scores.personnel = 2;

    if (regressionGrade === 'MINIMAL') scores.regression = 0;
    else if (regressionGrade === 'LOW') scores.regression = 0.5;
    else if (regressionGrade === 'MODERATE') scores.regression = 1;
    else scores.regression = 2;

    if (shotTypeGrade === 'DURABLE') scores.shotType = 0;
    else if (shotTypeGrade === 'MIXED') scores.shotType = 1;
    else scores.shotType = 2;

    var composite = scores.personnel * 0.40 + scores.regression * 0.35 + scores.shotType * 0.25;

    var tier;
    if (composite <= 0.3) tier = 'LOCKED IN';
    else if (composite <= 0.7) tier = 'DURABLE';
    else if (composite <= 1.1) tier = 'MIXED';
    else if (composite <= 1.5) tier = 'FRAGILE';
    else tier = 'UNSUSTAINABLE';

    // Override: at/below season norm
    if (live3Pct <= seasonPrior3Pct + 2) {
      tier = 'LOCKED IN';
      regressionGrade = 'MINIMAL';
      personnelGrade = 'N/A (at baseline)';
    }
    // STALLED: 3PT below 95% of season baseline AND 2PT below 85% of league baseline — genuine offensive collapse
    if (tier === 'LOCKED IN') {
      var fg2m = (stats.field_goals_made || 0) - team3PM;
      var fg2a = teamFGA - team3PA;
      var twoPointBase = league === 'ncaamb' ? 0.49 : league === 'wnba' ? 0.46 : 0.52;
      var threeBelow95 = live3Pct < seasonPrior3Pct * 0.95;
      var twoBelowExtreme = fg2a >= 6 && fg2m / fg2a < twoPointBase * 0.85;
      if (threeBelow95 && twoBelowExtreme) {
        tier = 'STALLED';
      }
    }
    // Override: too few attempts
    if (team3PA < 5) tier = 'TOO EARLY';

    return {
      teamAlias: teamAlias,
      live3PM: team3PM, live3PA: team3PA,
      live3Pct: live3Pct.toFixed(1), live3Rate: (team3PA / teamFGA * 100).toFixed(1),
      seasonPrior: seasonPrior3Pct.toFixed(1), gotSeasonData: gotSeasonData,
      deviation: deviation.toFixed(1),
      personnelGrade: personnelGrade, personnelDetails: personnelDetails,
      elitePct: elitePct.toFixed(0), nonPct: nonPct.toFixed(0),
      posteriorMean: posteriorMean.toFixed(1),
      regressionPull: regressionPull.toFixed(0),
      regressionProb: regressionProb, regressionGrade: regressionGrade,
      shotTypeGrade: shotTypeGrade, shotTypeNote: shotTypeNote,
      assistRatio: assistRatio.toFixed(0),
      composite: composite.toFixed(2), tier: tier,
    };
  }

  return {
    home: auditTeam(summary.home, summary.home?.alias || 'HOME'),
    away: auditTeam(summary.away, summary.away?.alias || 'AWAY'),
  };
}

// ── SERVER-SIDE LEAD COMPOSITION ────────────────────────────────────────────
// Ported from analyze.js. Pure function of SR summary data.

function computeLeadComposition(summary) {
  if (!summary) return null;
  const H = summary.home, A = summary.away;
  if (!H || !A) return null;
  const hs = H.statistics || {}, as = A.statistics || {};
  const hPts = H.points || 0, aPts = A.points || 0;
  if (hPts === 0 && aPts === 0) return null;
  const hA = H.alias || 'HOME', aA = A.alias || 'AWAY';

  function breakdown(stats, total) {
    var paint = stats.points_in_the_paint || stats.points_in_paint || 0;
    var atRimPts = (stats.field_goals_at_rim_made || 0) * 2;
    paint = Math.max(paint, atRimPts);
    var ft = stats.free_throws_made || 0;
    var three = (stats.three_points_made || 0) * 3;
    var midOther = Math.max(0, total - paint - ft - three);
    var structural = paint + ft;
    var variance = three + midOther;
    return { total, paint, ft, three, midOther, structural, variance };
  }

  var hB = breakdown(hs, hPts);
  var aB = breakdown(as, aPts);

  var margin = hPts - aPts;
  var absMargin = Math.abs(margin);
  var leadTeam = margin >= 0 ? hA : aA;
  var trailTeam = margin >= 0 ? aA : hA;
  var leadStruct = margin >= 0 ? (hB.structural - aB.structural) : (aB.structural - hB.structural);
  var leadVar = margin >= 0 ? (hB.variance - aB.variance) : (aB.variance - hB.variance);

  var classification;
  if (absMargin <= 2) classification = 'EVEN';
  else if (leadStruct >= absMargin * 0.6) classification = 'STRUCTURAL';
  else if (leadVar >= absMargin * 0.6) classification = 'VOLATILE'; // simplified — no sustainability cross-ref server-side
  else classification = 'MIXED';

  return { classification, leadTeam, structuralMargin: leadStruct, varianceMargin: leadVar };
}

// ══════════════════════════════════════════════════════════════════════════════
// SWEET-SPOT GATE ENGINE (Phase 2a) — ported VERBATIM from wnba-bdl.html (the
// source of truth). Standalone fns; wired into the WNBA poll gate-compute step
// in a later chunk. PARITY is the acceptance test — do NOT "improve" logic here.
// NOTE: computeScoringComp here does NOT attach efgBox/fga — that augmentation
// (box eFG, matches I3) happens at the wiring step, mirroring buildScoringCompForCard.
// ══════════════════════════════════════════════════════════════════════════════
var EFG_BANDS = { 1:[54,61], 2:[56,63], 3:[58,66], 4:[60,69] };
function efgTier(efg, period) {
  if (efg == null || isNaN(efg)) return { tier:'na', color:'var(--fg-dim)' };
  var b = EFG_BANDS[period] || EFG_BANDS[4];
  if (efg <= b[0]) return { tier:'green', color:'var(--green)' };
  if (efg <= b[1]) return { tier:'orange', color:'var(--amber)' };
  return { tier:'red', color:'var(--coral)' };
}
// ── DECISION SUPPORT v1 Component 1 (DECISION_SUPPORT_V1_SPEC.md) ─────────────
// computeFuelTemp: what the leader's lead is made of + how hot the trailer is.
// ONE definition, all consumers (elite-definition lesson): duplicated VERBATIM in
// wnba-bdl.html; mirrored golden fixtures assert drift (research/2026-08-05_
// decision_support_fixtures.mjs). Thresholds pinned here — changing them requires
// a spec amendment, not a code tweak. Insufficient data → { insufficient:true }
// and every consumer renders NOTHING (no fake reads — the schedule-badge lesson).
var FUELTEMP_TH = { POT_MIN: 6, THREE_SHARE: 40, VSHARE: 45, TO_CLEAN: 4, MIN_FGA: 12 };
function computeFuelTemp(leaderStats, trailerStats, period) {
  function _n(v) { v = Number(v); return isNaN(v) ? 0 : v; }
  function _efg(s) { var fga = _n(s && s.fga); if (fga < FUELTEMP_TH.MIN_FGA) return null; return (_n(s.fgm) + 0.5 * _n(s.fg3m)) / fga * 100; }
  var L = leaderStats || {}, T = trailerStats || {};
  var lEfg = _efg(L), tEfg = _efg(T);
  if (lEfg == null || tEfg == null) return { insufficient: true };
  var lBand = efgTier(lEfg, period).tier, tBand = efgTier(tEfg, period).tier;
  var lPts = 2 * _n(L.fgm) + _n(L.fg3m) + _n(L.ftm);
  var threeShare = lPts > 0 ? (3 * _n(L.fg3m)) / lPts * 100 : 0;
  var vShare = (L.vShare != null && !isNaN(Number(L.vShare))) ? Number(L.vShare) : null;
  var heat = lBand === 'red' || threeShare >= FUELTEMP_TH.THREE_SHARE || (vShare != null && vShare > FUELTEMP_TH.VSHARE);
  var takeaway = _n(L.pot) >= FUELTEMP_TH.POT_MIN;
  var fuel = heat && takeaway ? 'TRANSIENT (heat + takeaway)' : heat ? 'TRANSIENT (heat)' : takeaway ? 'TRANSIENT (takeaway)' : 'EARNED';
  var temp = tBand === 'green' ? 'cold' : tBand === 'red' ? 'hot' : 'warm';
  var sticky = fuel === 'EARNED' && temp === 'cold' && _n(T.to) < FUELTEMP_TH.TO_CLEAN;
  return { insufficient: false, fuel: fuel, heat: heat, takeaway: takeaway, temp: temp, sticky: sticky,
    leaderEfg: Math.round(lEfg * 10) / 10, leaderBand: lBand, trailerEfg: Math.round(tEfg * 10) / 10, trailerBand: tBand,
    threeShare: Math.round(threeShare), vShare: vShare != null ? Math.round(vShare) : null,
    pot: _n(L.pot), trailerTo: _n(T.to), period: period };
}
// Plain-English fuel/temp lines for narration context (A/B fire + D-12 review).
// PURE (fixture-extracted). Returns '' when the read is unavailable — no fake reads.
function ssFuelTempLines(ft, leaderAl, trailerAl) {
  if (!ft || ft.insufficient) return '';
  var why;
  if (ft.fuel === 'EARNED') why = 'normal shooting temperature and a low takeaway feed';
  else {
    var bits = [];
    if (ft.heat) {
      if (ft.leaderBand === 'red') bits.push('hot shooting (' + Math.round(ft.leaderEfg) + '% effective field goal, red band)');
      else if (ft.threeShare >= FUELTEMP_TH.THREE_SHARE) bits.push(Math.round(ft.threeShare) + '% of their points from three-pointers');
      else bits.push(Math.round(ft.vShare) + '% of the lead from three-pointers and midrange');
    }
    if (ft.takeaway) bits.push(ft.pot + ' points off turnovers');
    why = bits.join(' plus ');
  }
  var t = 'LEAD FUEL + TRAILER TEMP [FACT-live at fire]:\n'
    + '- LEAD FUEL: ' + ft.fuel + ' — ' + leaderAl + '\'s lead is built on ' + why + '.\n'
    + '- TRAILER TEMP: ' + ft.temp + ' — ' + trailerAl + ' shooting ' + Math.round(ft.trailerEfg) + '% effective field goal (' + ft.trailerBand + ' band).\n';
  if (ft.sticky) t += '- STICKY LEAD SHAPE (2026): earned lead against a cold, clean trailer (' + ft.trailerTo + ' turnovers) — this season\'s toughest comeback shape. Context only, never a gate.\n';
  // Copy v1.2 (Aug 6, PM-approved): season-stat context lines. Numbers are
  // cross-cut-converged (see research/2026-08-06_fuel_temp_gap_map.md); a regime
  // flip (monthly pulse INVERTED) triggers a copy revisit for all (2026) lines.
  else if (ft.fuel === 'EARNED') t += '- EARNED-LEAD CAUTION (2026): no transient feed to regress — earned leads vs in-band better trailers converted only ~37% across three independent 2026 cuts, below what the live line charges. This season\'s pass shape. Context only, never a gate.\n';
  if (ft.takeaway) t += '- CHANNEL NOTE (2026): the takeaway feed is the market-blind transient — the live line has under-priced takeaway-fed collapse all season (trailers converted ~85%, two independent cuts). Context only, never a gate.\n';
  return t;
}

function _clkSec(c) { if (c == null) return 999; c = String(c); if (c.indexOf(':') > -1) { var p = c.split(':'); return (+p[0])*60 + (+p[1]); } var n = parseFloat(c); return isNaN(n) ? 999 : n; }
function americanToImplied(ml) { if (ml == null || ml === '') return null; ml = Number(ml); if (isNaN(ml) || ml === 0) return null; return ml > 0 ? 100/(ml+100) : (-ml)/((-ml)+100); }
function cbDepthRate(d) { if (d <= 5) return 0.68; if (d <= 9) return 0.56; if (d <= 14) return 0.50; if (d <= 19) return 0.44; return 0; }

function divergenceRead(sc) {
  if (!sc || !sc.home || !sc.away) return null;
  var h = sc.home, a = sc.away, p = sc.period || 0, clk = sc.clock || '';
  var hp = h.total || 0, ap = a.total || 0, margin = Math.abs(hp - ap);
  var L = hp >= ap ? h : a, T = hp >= ap ? a : h, efg = L.efgBox, v = L.vPct, fga = L.fga || 0;
  function R(t,l,c,x){ return { tier:t, label:l, color:c, text:x }; }
  if (margin <= 2) return R('EVEN','—','var(--fg-dim)','Game even — no lead to fade.');
  if (efg == null || fga < 12) return R('WAIT','WAIT','var(--fg-dim)', L.team+' shot sample too small to judge.');
  if (margin >= 10) return R('NO FADE','BANKED','var(--green)', L.team+' lead is banked (+'+margin+') — regression will not erase double digits.');
  if (p >= 4 || (p === 3 && _clkSec(clk) < 180)) return R('NO FADE','LATE','var(--fg-dim)', L.team+' heat is earned this late — not a fade window.');
  var t = efgTier(efg,p).tier, ef = Math.round(efg)+'% eFG';
  if (t === 'green') return R('NO EDGE','—','var(--fg-dim)', L.team+' not above sustainable ('+ef+') — no divergence.');
  if (v <= 45) return R('NO FADE','STRUCTURAL','var(--green)', L.team+' hot ('+ef+') but structural — paint/FT-driven, sticky lead.');
  if ((efg >= 70 && v > 45) || (t === 'red' && v > 55)) return R('STRONG FADE','FADE '+T.team,'var(--coral)','⚠ '+L.team+' on unsustainable variance ('+ef+', V '+Math.round(v)+'%), only +'+margin+' in Q'+p+'. Back '+T.team+' at plus money.');
  if (t === 'orange' && v > 55) return R('LEAN FADE','LEAN '+T.team,'var(--amber)', L.team+' '+ef+' variance-sourced and thin (+'+margin+'). Lean fade '+T.team+' if plus money.');
  return R('NO FADE','MIXED','var(--fg-dim)', L.team+' hot ('+ef+') but mixed-sourced — not a clean fade.');
}

// leaderWP/trailerWP in [0,1] or null; deficit>0 int; period int; fadeRead = sc.fadeRead | null
function comebackProb(leaderWP, trailerWP, deficit, period, fadeRead) {
  if (leaderWP == null || trailerWP == null) return { tier:'NO_DATA' };
  if (leaderWP >= 0.40) return { tier:'NO_EDGE', leaderWP:leaderWP };
  if (deficit >= 20) return { tier:'DEAD', deficit:deficit };
  var gap = trailerWP - leaderWP;
  if (gap < 0.10) return { tier:'NO_QUALITY_EDGE', gap:gap };
  var base = cbDepthRate(deficit), pPoint, drivers = [];
  if (gap > 0.20) { var lean = Math.max(-1, Math.min(1, (gap-0.20)/0.20))*0.05; pPoint = Math.max(0.10, Math.min(0.85, base+lean)); }
  else { pPoint = base*0.75; }
  if (fadeRead && fadeRead.tier === 'STRONG FADE') { pPoint = Math.min(0.85, pPoint+0.03); drivers.push('fragile lead'); }
  var tier = gap > 0.20 ? (deficit <= 7 ? 'SHORT' : 'STRONG') : 'MODERATE';
  return { tier:tier, pPoint:pPoint, pLow:Math.max(0.05, pPoint-0.07), pHigh:Math.min(0.95, pPoint+0.07), gap:gap, drivers:drivers };
}
// sizes off the point estimate; quarter-Kelly, hard-capped at 12% of bankroll
function comebackEV(pPoint, ml) {
  var implied = americanToImplied(ml); if (implied == null) return { noLine:true };
  var edge = pPoint - implied, mln = Number(ml);
  if (edge <= 0) return { verdict:'NO_VALUE', implied:implied, line:mln };
  var decNet = mln > 0 ? mln/100 : 100/Math.abs(mln);
  var fullK = (pPoint*(decNet+1)-1)/decNet;
  return { implied:implied, edge:edge, size:Math.max(0, Math.min(0.12, 0.25*fullK)), line:mln };
}

function computeScoringComp(pbp, hA, aA, hPts, aPts) {
  if (!pbp || !pbp.home || !pbp.away) return null;
  function breakdown(side, total) {
    var rimM = side.rim ? side.rim.made||0 : 0, rimA = side.rim ? side.rim.att||0 : 0;
    var pntM = side.paint ? side.paint.made||0 : 0, pntA = side.paint ? side.paint.att||0 : 0;
    var midM = side.mid ? side.mid.made||0 : 0, midA = side.mid ? side.mid.att||0 : 0;
    var threeM = side.threes ? side.threes.made||0 : 0, threeA = side.threes ? side.threes.att||0 : 0;
    var allPaintM = rimM+pntM, allPaintA = rimA+pntA;
    var paintPts = allPaintM*2;
    var threePts = threeM*3;
    var midPts = midM*2;
    var ftPts = Math.max(0, total-paintPts-threePts-midPts);
    var ftM = ftPts, ftA = ftPts>0 ? Math.round(ftPts/0.78) : ftPts;
    var structural = paintPts+ftPts;
    var variance = threePts+midPts;
    var sPct = total>0 ? Math.round(structural/total*100) : 0;
    var paintPct = allPaintA>0 ? Math.round(allPaintM/allPaintA*100) : 0;
    var threePct = threeA>0 ? Math.round(threeM/threeA*100) : 0;
    var midPct = midA>0 ? Math.round(midM/midA*100) : 0;
    return { total:total, paint:paintPts, ft:ftPts, three:threePts, midOther:midPts,
      structural:structural, variance:variance, sPct:sPct, vPct:100-sPct,
      paintM:allPaintM, paintA:allPaintA, paintPct:paintPct,
      ftM:ftM, ftA:ftA,
      tpm:threeM, tpa:threeA, threePct:threePct,
      midM:midM, midA:midA, midPct:midPct };
  }
  var h = breakdown(pbp.home, hPts); var a = breakdown(pbp.away, aPts);
  h.team = hA; a.team = aA;
  var margin = hPts-aPts; var absMargin = Math.abs(margin);
  var sDelta = h.structural-a.structural; var vDelta = h.variance-a.variance;
  var leadTeam = margin>=0 ? hA : aA, trailTeam = margin>=0 ? aA : hA;
  var leadS = margin>=0 ? sDelta : -sDelta; var leadV = margin>=0 ? vDelta : -vDelta;
  var classification = 'MIXED', durability = '';
  if (absMargin <= 2) { classification = 'EVEN'; durability = 'Margin too small to classify'; }
  else if (leadS >= absMargin*0.6) { classification = 'STRUCTURAL'; durability = leadTeam+' lead is structural \u2014 paint/FT drives margin (+'+Math.abs(Math.round(leadS))+')'; }
  else if (leadV >= absMargin*0.6) { classification = 'VOLATILE'; durability = leadTeam+' lead is variance-driven \u2014 3PT/mid drives margin with uncertain sustainability. Structural favors '+(leadS>=0?leadTeam:trailTeam)+' (+'+Math.abs(Math.round(leadS<0?leadS:leadS))+')'; }
  else { classification = 'MIXED'; durability = 'No single source dominates margin'; }
  return { home:h, away:a, structuralDelta:sDelta, varianceDelta:vDelta, leadTeam:leadTeam, classification:classification, durability:durability };
}
// ── END SWEET-SPOT GATE ENGINE (Phase 2a) ─────────────────────────────────────

// ── VOLUME THREAT DETECTION ──────────────────────────────────────────────────
// Identifies teams with scheme-driven high-volume 3PT production at baseline.
// Returns per-team: active flag, projected 3PA, discount (for floor), vtBonus (for structRate).

function computeVolumeThreat(summary, pbpAudit, sust, league, minsElapsed) {
  var GAME_MINUTES = (league === 'ncaamb' || league === 'wnba') ? 40 : 48;
  var sznDefault = league === 'ncaamb' ? 33 : league === 'wnba' ? 34.7 : 36;

  function evalSide(stats, pbpSide, sustSide) {
    var live3PA = Number(stats.three_points_att) || 0;
    var live3PM = Number(stats.three_points_made) || 0;
    var live3Pct = live3PA > 0 ? (live3PM / live3PA * 100) : 0;
    var baseline = parseFloat(sustSide?.seasonPrior || sustSide?.seasonBaseline || sznDefault);
    var cs3PM = pbpSide?.threes?.assisted || 0;

    // Pace-adjusted projection to full game
    var projected3PA = minsElapsed > 5 ? live3PA * (GAME_MINUTES / minsElapsed) : live3PA * 2;

    // Check thresholds: projected >= 34, conversion within [-5%, +15%] of baseline, min 15 attempts
    // Min gate raised from 8 → 15: small-sample VT in Q1 was nuking floors before cross-side
    // mitigation had enough data to detect shared game profiles (MIN@DEN G2: 8 3PA triggered 47% discount)
    var deviation = live3Pct - baseline;
    var withinRange = deviation >= -5 && deviation <= 15;
    var active = projected3PA >= 34 && withinRange && live3PA >= 15;

    // Discount for floor modifier — scales with projected volume
    var discount = 0;
    if (active) {
      discount = Math.min(0.50, Math.max(0, 0.25 + 0.15 * ((projected3PA - 34) / 15)));
    }

    // VT bonus for structRate — reliable per-possession C&S production at baseline
    // Estimates C&S 3PA from ratio of assisted makes to total makes
    var vtBonus = 0;
    if (active && live3PM > 0) {
      var poss = Number(stats.possessions) || 0;
      if (poss < 5) poss = (Number(stats.field_goals_att) || 0) + 0.44 * (Number(stats.free_throws_att) || 0)
        - (Number(stats.offensive_rebounds) || 0) + (Number(stats.turnovers || stats.total_turnovers) || 0);
      if (poss > 10) {
        var cs3PAEst = (cs3PM / live3PM) * live3PA; // project C&S attempts from assist ratio
        var cs3PAPerPoss = cs3PAEst / poss;
        vtBonus = cs3PAPerPoss * (baseline / 100) * 3 * 0.5; // 50% scaling — perimeter still more variant than paint
      }
    }

    return {
      active, projected3PA: Math.round(projected3PA),
      live3PA, live3PM, live3Pct: Math.round(live3Pct * 10) / 10,
      cs3PM, baseline, deviation: Math.round(deviation * 10) / 10,
      discount: Math.round(discount * 100) / 100,
      vtBonus: Math.round(vtBonus * 1000) / 1000,
    };
  }

  var hs = summary.home?.statistics || {};
  var as = summary.away?.statistics || {};
  var result = {
    home: evalSide(hs, pbpAudit?.home || null, sust?.home || null),
    away: evalSide(as, pbpAudit?.away || null, sust?.away || null),
  };

  // Cross-side mitigation: if the OTHER side has equal or more 3PA,
  // the VT team's perimeter production isn't a unique structural counter — it's a shared game profile.
  // Scale discount to zero as opponent's 3PA approaches or exceeds VT team's 3PA.
  function mitigate(vtSide, otherSide) {
    if (!vtSide.active || vtSide.live3PA < 1) return;
    var ratio = otherSide.live3PA / vtSide.live3PA;
    // ratio >= 1.0 → full mitigation (other side matching/exceeding volume)
    // ratio 0.7–1.0 → linear scale down
    // ratio < 0.7 → no mitigation (VT side has clear perimeter advantage)
    var mitFactor = Math.max(0, Math.min(1, 1 - (ratio - 0.7) / 0.3));
    vtSide.discount = Math.round(vtSide.discount * mitFactor * 100) / 100;
    vtSide.vtBonus = Math.round(vtSide.vtBonus * mitFactor * 1000) / 1000;
    vtSide.mitigated = mitFactor < 1;
    vtSide.mitRatio = Math.round(ratio * 100) / 100;
    if (mitFactor === 0) vtSide.active = false; // fully mitigated → no longer active
  }
  mitigate(result.home, result.away);
  mitigate(result.away, result.home);

  return result;
}

// ── THROUGHPUT / LEAD SAFETY (ported from client) ──────────────────────────
// Pure math — no API calls, no DB queries. All inputs from poll loop.

function computeSwingCoreServer(focalStats, targetStats, focalSustData, targetSustData, deficit, minsLeft, minsElapsed, gameFraction, sznDefault, focalVTBonus, targetVTBonus, league) {
  var focalPoss = Number(focalStats.possessions) || 0;
  var targetPoss = Number(targetStats.possessions) || 0;
  if (focalPoss < 3) focalPoss = (Number(focalStats.field_goals_att)||0) + 0.44*(Number(focalStats.free_throws_att)||0) - (Number(focalStats.offensive_rebounds)||0) + (Number(focalStats.turnovers||focalStats.total_turnovers)||0);
  if (targetPoss < 3) targetPoss = (Number(targetStats.field_goals_att)||0) + 0.44*(Number(targetStats.free_throws_att)||0) - (Number(targetStats.offensive_rebounds)||0) + (Number(targetStats.turnovers||targetStats.total_turnovers)||0);
  if (focalPoss < 5 || targetPoss < 5 || isNaN(focalPoss) || isNaN(targetPoss)) return null;

  function structRate(st, poss) {
    var paint = Number(st.points_in_the_paint || st.points_in_paint) || 0;
    var ft = Number(st.free_throws_made) || 0;
    var pot = Number(st.points_off_turnovers) || 0;
    var scp = Number(st.second_chance_points || st.second_chance_pts) || 0;
    return (paint + ft + pot + scp) / poss;
  }
  // 2PT quality factor: discount structRate when team converts poorly from 2
  // Teams below league-avg 2PT% are generating structural points through volume/hustle
  // rather than efficient conversion. Floor at 0.75 prevents overcorrection.
  var twoPointBaseline = LEAGUES[league]?.twoPointBaseline || (sznDefault <= 34 ? 0.49 : 0.52);
  function qualityFactor(st) {
    var fgm = Number(st.field_goals_made) || 0;
    var fga = Number(st.field_goals_att) || 0;
    var fg3m = Number(st.three_points_made) || 0;
    var fg3a = Number(st.three_points_att) || 0;
    var fg2m = fgm - fg3m;
    var fg2a = fga - fg3a;
    if (fg2a < 6) return 1.0; // not enough data to judge conversion quality
    return Math.max(0.75, Math.min(1.0, (fg2m / fg2a) / twoPointBaseline));
  }
  var focalStructRate = structRate(focalStats, focalPoss) * qualityFactor(focalStats) + (focalVTBonus || 0);
  var targetStructRate = structRate(targetStats, targetPoss) * qualityFactor(targetStats) + (targetVTBonus || 0);
  var structEdge = focalStructRate - targetStructRate;

  function getVarData(sustObj, stats, poss) {
    if (!sustObj) return { deviation: 0, threePARate: 0, live3Pct: 0, sznPct: sznDefault };
    var livePct = parseFloat(sustObj.live3Pct || 0);
    var sznPct = parseFloat(sustObj.seasonPrior || sustObj.seasonBaseline || sznDefault);
    var dev = livePct - sznPct;
    var tpaRate = poss > 0 ? (Number(stats.three_points_att) || 0) / poss : 0;
    return { deviation: dev, threePARate: tpaRate, live3Pct: livePct, sznPct: sznPct };
  }
  var focalVar = getVarData(focalSustData, focalStats, focalPoss);
  var targetVar = getVarData(targetSustData, targetStats, targetPoss);

  var avgPoss = (focalPoss + targetPoss) / 2;
  var possPerMin = avgPoss / minsElapsed;
  var remainingPoss = possPerMin * minsLeft;
  if (isNaN(remainingPoss) || remainingPoss < 1) return null;

  var degradation = 1.0;
  if (deficit >= 24) degradation = 0.70;
  else if (deficit >= 18) degradation = 0.85;

  var bandDefs = [
    { label: 'conservative', baseRate: 0.40 },
    { label: 'expected',     baseRate: 0.65 },
    { label: 'optimistic',   baseRate: 0.90 },
  ];
  var bands = bandDefs.map(function(band) {
    var appliedRegression = band.baseRate * gameFraction;
    var targetCooling = targetVar.deviation > 0 ? (targetVar.deviation / 100) * appliedRegression * targetVar.threePARate * 3 : 0;
    var focalHeating = focalVar.deviation < 0 ? (Math.abs(focalVar.deviation) / 100) * appliedRegression * focalVar.threePARate * 3 : 0;
    var targetHeating = targetVar.deviation < 0 ? (Math.abs(targetVar.deviation) / 100) * appliedRegression * targetVar.threePARate * 3 : 0;
    var focalCooling = focalVar.deviation > 0 ? (focalVar.deviation / 100) * appliedRegression * focalVar.threePARate * 3 : 0;
    var netSwingPerPoss = (structEdge * degradation) + targetCooling + focalHeating - targetHeating - focalCooling;
    var totalSwing = netSwingPerPoss * remainingPoss;
    var ratio = deficit > 0 ? totalSwing / deficit : 0;
    return { label: band.label, ratio: Math.round(ratio * 100) / 100, totalSwing: Math.round(totalSwing * 10) / 10, netSwingPerPoss: Math.round(netSwingPerPoss * 1000) / 1000 };
  });
  if (isNaN(bands[0].totalSwing) || isNaN(bands[1].totalSwing) || isNaN(remainingPoss)) return null;

  return { bands, focalStructRate: Math.round(focalStructRate * 1000) / 1000, targetStructRate: Math.round(targetStructRate * 1000) / 1000,
    structEdge: Math.round(structEdge * 1000) / 1000, focalVar, targetVar, remainingPoss: Math.round(remainingPoss), degradation };
}

function computeThroughputServer(summary, ind, sust, hA, aA, period, clock, league, volumeThreat) {
  if (!summary || !summary.home || !summary.away || period < 2) return null;
  if (!ind || !ind.score) return null;
  var fTeam = ind.controlTeam;
  var ctrlIsHome = fTeam === hA;
  var hPts = summary.home?.points || 0, aPts = summary.away?.points || 0;
  var ctrlPts = ctrlIsHome ? hPts : aPts;
  var oppPts = ctrlIsHome ? aPts : hPts;
  var deficit = oppPts - ctrlPts;
  if (deficit <= 0) return null; // not trailing

  var PERIOD_MINUTES = league === 'ncaamb' ? 20 : league === 'wnba' ? 10 : 12;
  var GAME_MINUTES = (league === 'ncaamb' || league === 'wnba') ? 40 : 48;
  var totalPeriods = league === 'ncaamb' ? 2 : 4;
  var clockParts = (clock || '').split(':');
  var clockMins = clockParts.length === 2 ? (parseInt(clockParts[0]) || 0) + ((parseInt(clockParts[1]) || 0) / 60) : PERIOD_MINUTES;
  var periodsLeft = Math.max(0, totalPeriods - period);
  var minsLeft = clockMins + (periodsLeft * PERIOD_MINUTES);
  var minsElapsed = Math.max(1, GAME_MINUTES - minsLeft);
  var gameFraction = Math.min(1, minsLeft / GAME_MINUTES);
  if (minsLeft < 0.3 || isNaN(minsLeft)) return null;

  var hs = summary.home?.statistics || {};
  var as = summary.away?.statistics || {};
  var focalStats = ctrlIsHome ? hs : as;
  var targetStats = ctrlIsHome ? as : hs;
  var sznDefault = league === 'ncaamb' ? 33 : league === 'wnba' ? 34.7 : 36;

  var focalSustData = sust ? (ctrlIsHome ? sust.home : sust.away) : null;
  var targetSustData = sust ? (ctrlIsHome ? sust.away : sust.home) : null;

  // Volume threat: focal = control team, target = opponent
  var focalVT = volumeThreat ? (ctrlIsHome ? volumeThreat.home?.vtBonus : volumeThreat.away?.vtBonus) : 0;
  var targetVT = volumeThreat ? (ctrlIsHome ? volumeThreat.away?.vtBonus : volumeThreat.home?.vtBonus) : 0;

  var core = computeSwingCoreServer(focalStats, targetStats, focalSustData, targetSustData, deficit, minsLeft, minsElapsed, gameFraction, sznDefault, focalVT, targetVT, league);
  if (!core) return null;
  var con = core.bands[0], exp = core.bands[1], opt = core.bands[2];

  var classification;
  if (con.ratio > 1.2) classification = 'STRONG RECOVERY';
  else if (con.ratio > 0.9) classification = 'PROBABLE';
  else if (con.ratio > 0.6) classification = 'CONTESTED';
  else if (con.ratio > 0.3) classification = 'UNLIKELY';
  else classification = 'NO PATH';

  return { classification, deficit, remainingPoss: core.remainingPoss,
    conservative: con, expected: exp, optimistic: opt,
    ctrlStructRate: core.focalStructRate, oppStructRate: core.targetStructRate,
    structEdge: core.structEdge, degradation: core.degradation,
    minsLeft: Math.round(minsLeft * 10) / 10, fTeam };
}

function computeLeadSafetyServer(summary, ind, sust, hA, aA, period, clock, league, volumeThreat) {
  if (!summary || !summary.home || !summary.away || period < 2) return null;
  if (!ind || !ind.score) return null;
  var fTeam = ind.controlTeam;
  var ctrlIsHome = fTeam === hA;
  var hPts = summary.home?.points || 0, aPts = summary.away?.points || 0;
  var ctrlPts = ctrlIsHome ? hPts : aPts;
  var oppPts = ctrlIsHome ? aPts : hPts;
  var lead = ctrlPts - oppPts;
  if (lead < 2) return null; // not leading enough

  var PERIOD_MINUTES = league === 'ncaamb' ? 20 : league === 'wnba' ? 10 : 12;
  var GAME_MINUTES = (league === 'ncaamb' || league === 'wnba') ? 40 : 48;
  var totalPeriods = league === 'ncaamb' ? 2 : 4;
  var clockParts = (clock || '').split(':');
  var clockMins = clockParts.length === 2 ? (parseInt(clockParts[0]) || 0) + ((parseInt(clockParts[1]) || 0) / 60) : PERIOD_MINUTES;
  var periodsLeft = Math.max(0, totalPeriods - period);
  var minsLeft = clockMins + (periodsLeft * PERIOD_MINUTES);
  var minsElapsed = Math.max(1, GAME_MINUTES - minsLeft);
  var gameFraction = Math.min(1, minsLeft / GAME_MINUTES);
  if (minsLeft < 0.3 || isNaN(minsLeft)) return null;

  var hs = summary.home?.statistics || {};
  var as = summary.away?.statistics || {};
  // Focal = OPPONENT (trailing, trying to recover)
  var focalStats = ctrlIsHome ? as : hs;
  var targetStats = ctrlIsHome ? hs : as;
  var sznDefault = league === 'ncaamb' ? 33 : league === 'wnba' ? 34.7 : 36;

  var focalSustData = sust ? (ctrlIsHome ? sust.away : sust.home) : null;
  var targetSustData = sust ? (ctrlIsHome ? sust.home : sust.away) : null;

  // Volume threat: focal = opponent (trailing), target = control team (leading)
  var focalVT = volumeThreat ? (ctrlIsHome ? volumeThreat.away?.vtBonus : volumeThreat.home?.vtBonus) : 0;
  var targetVT = volumeThreat ? (ctrlIsHome ? volumeThreat.home?.vtBonus : volumeThreat.away?.vtBonus) : 0;

  var core = computeSwingCoreServer(focalStats, targetStats, focalSustData, targetSustData, lead, minsLeft, minsElapsed, gameFraction, sznDefault, focalVT, targetVT, league);
  if (!core) return null;
  var con = core.bands[0], exp = core.bands[1], opt = core.bands[2];

  var classification;
  if (con.ratio > 0.8) classification = 'CRITICAL';
  else if (exp.ratio > 0.7) classification = 'AT RISK';
  else if (opt.ratio > 0.5 && exp.ratio >= 0.3) classification = 'CUSHIONED';
  else classification = 'SAFE';

  var oppTeam = ctrlIsHome ? aA : hA;
  return { classification, lead, remainingPoss: core.remainingPoss,
    conservative: con, expected: exp, optimistic: opt,
    oppStructRate: core.focalStructRate, ctrlStructRate: core.targetStructRate,
    structEdge: core.structEdge, degradation: core.degradation,
    minsLeft: Math.round(minsLeft * 10) / 10, fTeam, oppTeam };
}

function mlToProb(ml) {
  var n = parseFloat(ml);
  if (isNaN(n) || n === 0) return null;
  return n < 0 ? Math.abs(n) / (Math.abs(n) + 100) : 100 / (n + 100);
}

function fmtSwing(v) { var n = Math.round(v); return n >= 0 ? '+' + n : '' + n; }

// ── SERVER-SIDE CONTEXT COMPUTATION ─────────────────────────────────────────
// Computes the 9 data layers that are normally client-only.
// Used as fallback when client hasn't pushed context to DB.
// Priority: client-pushed context > server-computed context > null.

// Classify combined read — ported from client
function classifyCombinedReadServer(floorScore, floorTeam, windowResult, accelResult) {
  if (!windowResult || !windowResult.available) return { read: 'TOO EARLY', note: 'Window not yet available' };
  const wScore = windowResult.score;
  const wTeam = windowResult.controlTeam;
  const accel = accelResult?.accel || 'STABLE';

  if (floorTeam !== wTeam) {
    if (accel === 'FLIPPED') return { read: 'FLIPPED', note: wTeam + ' taking control from ' + floorTeam };
    return { read: 'SHIFT', note: 'Floor: ' + floorTeam + ' / Window: ' + wTeam + ' — control contested' };
  }
  if (floorScore >= 0.75 && wScore >= 0.80 && (accel === 'GROWING' || accel === 'STABLE'))
    return { read: 'DOMINANT', note: 'Structural edge compounding' };
  if (floorScore >= 0.75 && wScore >= 0.75)
    return { read: 'STRONG', note: 'Structural edge holding' };
  if (floorScore >= 0.75 && wScore >= 0.60 && wScore < 0.75 && (accel === 'DECLINING' || accel === 'STABLE'))
    return { read: 'ERODING', note: 'Structure holds but momentum lost' };
  if (floorScore >= 0.75 && wScore < 0.60)
    return { read: 'COLLAPSING', note: 'Structural edge breaking down' };
  if (floorScore >= 0.60 && floorScore < 0.75 && wScore >= 0.75 && accel === 'GROWING')
    return { read: 'EMERGING', note: 'Edge strengthening toward confirmation' };
  if (floorScore >= 0.60 && floorScore < 0.75 && wScore >= 0.60)
    return { read: 'EARNED', note: 'Modest edge, steady' };
  if (floorScore >= 0.60 && floorScore < 0.75 && wScore < 0.60)
    return { read: 'FADING', note: 'Edge was real but dissipating' };
  if (floorScore < 0.60 && wScore >= 0.65 && accel === 'GROWING')
    return { read: 'SHIFT', note: 'No cumulative edge but recent control emerging' };
  return { read: 'NO EDGE', note: 'Insufficient signal' };
}

// Compute acceleration from gap entries — ported from client
function computeAccelerationServer(entries) {
  if (!entries || entries.length < 2) return { accel: 'TOO EARLY', entries: entries || [], consecutive: 0 };

  const recent = entries.slice(-4);
  const deltas = [];
  for (let i = 1; i < recent.length; i++) deltas.push(recent[i].gap - recent[i - 1].gap);

  // Check gap sign flip
  const lastTwo = entries.slice(-2);
  if ((lastTwo[0].gap > 0.02 && lastTwo[1].gap < -0.02) || (lastTwo[0].gap < -0.02 && lastTwo[1].gap > 0.02)) {
    return { accel: 'FLIPPED', entries: entries.slice(-5), consecutive: 1 };
  }

  const threshold = 0.015;
  let growing = 0, declining = 0;
  for (let i = deltas.length - 1; i >= 0; i--) {
    if (deltas[i] > threshold) growing++;
    else if (deltas[i] < -threshold) declining++;
    else break;
  }

  if (growing >= 2) return { accel: 'GROWING', entries: entries.slice(-5), consecutive: growing };
  if (declining >= 2) return { accel: 'DECLINING', entries: entries.slice(-5), consecutive: declining };
  return { accel: 'STABLE', entries: entries.slice(-5), consecutive: 0 };
}

// Classify adjustment from arrows — ported from client
function classifyAdjustmentServer(arrows, controlTeam, hA, aA) {
  if (!arrows) return { signal: 'NO DATA', note: 'Arrows unavailable' };
  const side = controlTeam === hA ? 'home' : 'away';
  const a = arrows[side];
  if (!a) return { signal: 'NO DATA', note: 'No arrow data for control team' };
  const risingStructural = ['paint', 'atRim', 'fta', 'steals'].filter(k => a[k]?.arrow === 'RISING').length;
  const fallingVariance = ['fg3aShare', 'tos'].filter(k => a[k]?.arrow === 'FALLING').length;
  const fallingStructural = ['paint', 'atRim', 'fta'].filter(k => a[k]?.arrow === 'FALLING').length;
  const risingVariance = ['fg3aShare', 'tos'].filter(k => a[k]?.arrow === 'RISING').length;

  if (risingStructural >= 2 && fallingVariance >= 1)
    return { signal: 'INTERIOR PIVOT', note: 'Progressive rim pressure replacing perimeter variance', team: controlTeam };
  if (fallingStructural >= 2)
    return { signal: 'STRUCTURAL EROSION', note: 'Interior game fading — structural edge at risk', team: controlTeam };
  if (risingVariance >= 1 && fallingStructural >= 1)
    return { signal: 'VARIANCE SHIFT', note: 'Shifting to perimeter — production becoming less durable', team: controlTeam };
  if (risingStructural >= 2)
    return { signal: 'STRUCTURAL ACCEL', note: 'Multiple structural inputs compounding', team: controlTeam };
  return { signal: 'NO ADJUSTMENT', note: 'Shot diet stable', team: controlTeam };
}

// Parse PBP into audit — simplified server-side port (no possession log, no timeline)
function parsePBPServer(pbpData, hId, aId, hA, aA) {
  const allEvents = [];
  const periods = pbpData?.periods || [];
  periods.forEach(per => {
    const q = per.number || per.sequence || 0;
    (per.events || []).forEach(ev => { ev._quarter = q; allEvents.push(ev); });
  });

  function resolveTeam(ev, stat) {
    const attrId = ev.attribution?.id || stat?.team?.id || '';
    if (attrId === hId) return hA;
    if (attrId === aId) return aA;
    return ev.attribution?.market || '?';
  }

  function classifyZone(ev, stat, isThree) {
    const loc = ev.location || {};
    const actionArea = (loc.action_area || ev.action_area || stat.action_area || '').toLowerCase();
    const coordY = loc.coord_y ?? ev.coord_y ?? null;
    const shotDist = stat.shot_distance ?? ev.shot_distance ?? null;
    if (isThree) {
      if (actionArea.includes('corner') || (coordY !== null && (coordY < 8 || coordY > 42))) return 'corner3';
      return 'above3';
    }
    if (shotDist !== null && shotDist <= 4) return 'rim';
    const shotTypeRaw = (stat.shot_type_desc || stat.shot_type || '').toLowerCase();
    const descRaw = (ev.description || '').toLowerCase();
    if (actionArea.includes('restricted') || actionArea.includes('rim')
      || shotTypeRaw.includes('layup') || shotTypeRaw.includes('dunk') || shotTypeRaw.includes('tip')
      || descRaw.includes('layup') || descRaw.includes('dunk')) return 'rim';
    if (actionArea.includes('paint') || actionArea.includes('lane')) return 'paint';
    return 'mid';
  }

  function classifyTO(stat, ev) {
    const toType = (stat.turnover_type || ev.turnover_type || '').toLowerCase();
    const desc = (ev.description || '').toLowerCase();
    if (toType.includes('steal') || toType.includes('bad pass') || desc.includes('steal')) return true;
    if (toType.includes('lost ball') || toType.includes('out of bounds') || toType.includes('travel') || toType.includes('violation')) return false;
    return null;
  }

  const shots = [], turnovers = [], scoreLog = [];
  let hScore = 0, aScore = 0;

  allEvents.forEach(ev => {
    if (ev.rescinded) return;
    const et = (ev.event_type || '').toLowerCase().replace(/[\s_-]/g, '');
    const stat = (ev.statistics || [])[0] || {};
    const team = resolveTeam(ev, stat);
    const player = stat?.player?.full_name || stat?.player?.name || ev.player?.full_name || '?';
    const quarter = ev._quarter;

    const isThree = et.includes('threepoint') || et.includes('3pt');
    const isTwo = et.includes('twopoint') || et.includes('2pt');
    if (isThree || isTwo) {
      const made = et.includes('made');
      const zone = classifyZone(ev, stat, isThree);
      let assisted = false;
      if (made) {
        const d = (ev.description || '').toLowerCase();
        if (d.includes('assist')) assisted = true;
        (ev.statistics || []).forEach(s => { if ((s.type || '').toLowerCase().includes('assist')) assisted = true; });
      }
      const pts = made ? (isThree ? 3 : 2) : 0;
      const shotDist = stat.shot_distance ?? ev.shot_distance ?? null;
      shots.push({ p: player, tm: team, z: zone, m: made, a: assisted, q: quarter, is3: isThree, x: ev.location?.coord_x ?? ev.coord_x ?? null, y: ev.location?.coord_y ?? ev.coord_y ?? null, d: shotDist });
      if (made) {
        if (team === hA) hScore += pts; else aScore += pts;
        scoreLog.push({ team, pts, hScore, aScore, q: quarter });
      }
    } else if (et.includes('turnover')) {
      const forced = classifyTO(stat, ev);
      const toType = (stat.turnover_type || ev.turnover_type || '').substring(0, 40);
      turnovers.push({ p: player, tm: team, q: quarter, forced, type: toType });
    }
  });

  // Scoring runs
  const runs = [];
  let runTeam = null, runPts = 0, runStart = 0, runCount = 0, runShotTypes = [];
  for (let i = 0; i < scoreLog.length; i++) {
    const s = scoreLog[i];
    if (s.team === runTeam) {
      runPts += s.pts; runCount++;
      runShotTypes.push(s.pts === 3 ? '3PT' : s.pts === 1 ? 'FT' : '2PT');
    } else {
      if (runPts >= 8 || runCount >= 3) runs.push({ team: runTeam, pts: runPts, count: runCount, q: scoreLog[runStart]?.q, mechanism: runShotTypes.slice() });
      runTeam = s.team; runPts = s.pts; runStart = i; runCount = 1; runShotTypes = [s.pts === 3 ? '3PT' : s.pts === 1 ? 'FT' : '2PT'];
    }
  }
  if (runPts >= 8 || runCount >= 3) runs.push({ team: runTeam, pts: runPts, count: runCount, q: scoreLog[runStart]?.q, mechanism: runShotTypes.slice() });
  runs.sort((a, b) => b.pts - a.pts);

  // Per-team aggregation
  function aggTeam(tm) {
    const s = shots.filter(x => x.tm === tm);
    const threes = s.filter(x => x.is3), rim = s.filter(x => x.z === 'rim'), mid = s.filter(x => x.z === 'mid');
    const threeMade = threes.filter(x => x.m), rimMade = rim.filter(x => x.m), midMade = mid.filter(x => x.m);
    const assistedThrees = threeMade.filter(x => x.a).length;
    const assistedMid = midMade.filter(x => x.a).length;

    // Per-player 3PT
    const playerThrees = {};
    threes.forEach(x => {
      if (!playerThrees[x.p]) playerThrees[x.p] = { name: x.p, made: 0, att: 0, assisted: 0, contexts: {} };
      playerThrees[x.p].att++;
      if (x.m) { playerThrees[x.p].made++; if (x.a) playerThrees[x.p].assisted++; }
    });
    // Per-player rim
    const playerRim = {};
    rim.forEach(x => {
      if (!playerRim[x.p]) playerRim[x.p] = { name: x.p, made: 0, att: 0, contexts: {} };
      playerRim[x.p].att++; if (x.m) playerRim[x.p].made++;
    });
    // Per-player mid
    const playerMid = {};
    mid.forEach(x => {
      if (!playerMid[x.p]) playerMid[x.p] = { name: x.p, made: 0, att: 0, assisted: 0 };
      playerMid[x.p].att++; if (x.m) { playerMid[x.p].made++; if (x.a) playerMid[x.p].assisted++; }
    });
    // TOs
    const tms = turnovers.filter(t => t.tm === tm);
    const forced = tms.filter(t => t.forced === true).length;
    const unforced = tms.filter(t => t.forced === false).length;
    const unknown = tms.filter(t => t.forced === null).length;

    return {
      threes: { made: threeMade.length, att: threes.length, assisted: assistedThrees, pct: threes.length > 0 ? (threeMade.length / threes.length * 100).toFixed(1) : '0',
        corner: { made: threeMade.filter(x => x.z === 'corner3').length, att: threes.filter(x => x.z === 'corner3').length },
        above: { made: threeMade.filter(x => x.z === 'above3').length, att: threes.filter(x => x.z === 'above3').length },
        byPlayer: Object.values(playerThrees).filter(x => x.att >= 1).sort((a, b) => b.att - a.att) },
      rim: { made: rimMade.length, att: rim.length, pct: rim.length > 0 ? (rimMade.length / rim.length * 100).toFixed(1) : '0',
        byPlayer: Object.values(playerRim).filter(x => x.att >= 1).sort((a, b) => b.att - a.att) },
      mid: { made: midMade.length, att: mid.length, assisted: assistedMid, pct: mid.length > 0 ? (midMade.length / mid.length * 100).toFixed(1) : '0',
        byPlayer: Object.values(playerMid).filter(x => x.att >= 1).sort((a, b) => b.att - a.att) },
      tos: { total: tms.length, forced, unforced, unknown, byPlayer: tms },
      shotDiet: { total: s.length, threePct: s.length > 0 ? (threes.length / s.length * 100).toFixed(1) : '0', rimPct: s.length > 0 ? (rim.length / s.length * 100).toFixed(1) : '0', midPct: s.length > 0 ? (mid.length / s.length * 100).toFixed(1) : '0' },
    };
  }

  return {
    home: aggTeam(hA), away: aggTeam(aA),
    homeAlias: hA, awayAlias: aA,
    totalShots: shots.length, totalTOs: turnovers.length,
    runs: runs.slice(0, 5),
    // Per-quarter sub-metric aggregation for arrows
    perQuarter: buildPerQuarterMetrics(shots, turnovers, hA, aA),
    pbpPeriod: periods.length,
    pbpAge: 0,
  };
}

// Build per-quarter sub-metrics from PBP for arrow computation
function buildPerQuarterMetrics(shots, turnovers, hA, aA) {
  const quarters = {};
  // Get all quarter numbers
  const allQ = new Set();
  shots.forEach(s => allQ.add(s.q));
  turnovers.forEach(t => allQ.add(t.q));

  for (const q of allQ) {
    const qShots = shots.filter(s => s.q === q);
    const qTOs = turnovers.filter(t => t.q === q);

    function teamMetrics(tm) {
      const s = qShots.filter(x => x.tm === tm);
      const threes = s.filter(x => x.is3);
      const rim = s.filter(x => x.z === 'rim');
      const rimMade = rim.filter(x => x.m);
      const threeMade = threes.filter(x => x.m);
      const allMade = s.filter(x => x.m);
      const assisted = allMade.filter(x => x.a).length;
      const tms = qTOs.filter(t => t.tm === tm);
      const stls = qTOs.filter(t => t.tm !== tm && t.forced === true).length; // opponent's forced TOs = our steals

      return {
        points_in_the_paint: rimMade.length * 2, // proxy
        field_goals_at_rim_att: rim.length,
        free_throws_att: 0, // can't extract from shot PBP alone — would need FT events
        steals: stls,
        turnovers: tms.length,
        fg3a_share: s.length > 0 ? (threes.length / s.length * 100) : 0,
        assist_ratio: allMade.length > 0 ? (assisted / allMade.length * 100) : 0,
        possessions: s.length + tms.length, // rough proxy
      };
    }

    quarters[q] = {
      home: teamMetrics(hA),
      away: teamMetrics(aA),
    };
  }
  return quarters;
}

// Compute sub-metric arrows from per-quarter PBP metrics
function computeSubMetricArrowsServer(perQuarter, hA, aA) {
  if (!perQuarter) return null;
  const qNums = Object.keys(perQuarter).map(Number).sort((a, b) => a - b);
  if (qNums.length < 2) return null;

  const metrics = [
    { key: 'paint', field: 'points_in_the_paint', label: 'Paint pts', threshold: 3 },
    { key: 'atRim', field: 'field_goals_at_rim_att', label: 'At-rim att', threshold: 2 },
    { key: 'fta', field: 'free_throws_att', label: 'FTA', threshold: 2 },
    { key: 'steals', field: 'steals', label: 'Steals', threshold: 1 },
    { key: 'tos', field: 'turnovers', label: 'TOs', threshold: 1 },
    { key: 'fg3aShare', field: 'fg3a_share', label: '3PA%', threshold: 5 },
    { key: 'astRatio', field: 'assist_ratio', label: 'Ast ratio', threshold: 8 },
    { key: 'poss', field: 'possessions', label: 'Poss', threshold: 2 },
  ];

  function computeArrow(values, threshold) {
    const valid = values.filter(v => v != null);
    if (valid.length < 2) return { arrow: null, values };
    const last3 = valid.slice(-3);
    if (last3.length < 2) return { arrow: null, values: last3 };
    const first = last3[0], last = last3[last3.length - 1];
    const diff = last - first;
    let rising = true, falling = true;
    for (let i = 1; i < last3.length; i++) {
      if (last3[i] < last3[i - 1]) rising = false;
      if (last3[i] > last3[i - 1]) falling = false;
    }
    if (rising && diff > threshold) return { arrow: 'RISING', values: last3 };
    if (falling && Math.abs(diff) > threshold) return { arrow: 'FALLING', values: last3 };
    if (last3.length >= 3) {
      if (last3[1] > first + threshold && last > first + threshold) return { arrow: 'RISING', values: last3 };
      if (last3[1] < first - threshold && last < first - threshold) return { arrow: 'FALLING', values: last3 };
    }
    return { arrow: 'FLAT', values: last3 };
  }

  const result = { home: {}, away: {} };
  ['home', 'away'].forEach(side => {
    metrics.forEach(m => {
      const vals = qNums.map(q => perQuarter[q]?.[side]?.[m.field] ?? null);
      const { arrow, values } = computeArrow(vals, m.threshold);
      const display = arrow ? (arrow === 'RISING' ? '▲' : arrow === 'FALLING' ? '▼' : '▬') : '—';
      const valStr = values.map(v => v != null ? (m.field.includes('share') || m.field.includes('ratio') ? v.toFixed(0) + '%' : String(Math.round(v))) : '?').join('→');
      result[side][m.key] = { arrow, values, display: display + ' (' + valStr + ')', label: m.label };
    });
  });

  return result;
}

// Main server context computation — called when client hasn't pushed context
async function computeServerContext(sql, game, league, summary, ind, espnWP, hA, aA, period, clock, matchup, sust, odds) {
  const ctx = {};
  const W = (LEAGUES[league]?.weights) || { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };
  // ── 1. BONUS STATUS (from SR summary — trivial) ──
  if (summary.home?.bonus || summary.away?.bonus) {
    ctx.bonusStatus = {
      home: summary.home?.bonus || false,
      away: summary.away?.bonus || false,
      homeDouble: summary.home?.double_bonus || false,
      awayDouble: summary.away?.double_bonus || false,
    };
  }

  // ── 2. ESPN WP ──
  if (espnWP) {
    ctx.espnWP = {
      home: espnWP.home, away: espnWP.away,
      homeAlias: hA, awayAlias: aA,
      opening: null, dataPoints: 0,
    };
  }

  // ── 3. EDGE HISTORY (from prior analyses in DB) ──
  try {
    const rows = await sql`
      SELECT control_team, control_score, fwp, edge, ts, period, clock
      FROM analyses WHERE game_id = ${game.id}
      ORDER BY ts ASC LIMIT 10
    `;
    if (rows.length > 0) {
      ctx.edgeHistory = rows.map(r => ({
        time: r.ts ? new Date(r.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) : '?',
        period: 'Q' + (r.period || '?'),
        edge: r.edge || '?',
        fwp: r.fwp || '?',
        control: (r.control_team || '?') + ' ' + (r.control_score != null ? r.control_score.toFixed(2) : '?'),
        score: '',
      }));
    }
  } catch (e) { /* no prior analyses */ }

  // ── 4. ROLLING WINDOW + ACCELERATION (from quarter_data — same engine as snapshot responses) ──
  try {
    const qd = await readQuarterData(sql, game.id);
    const completedKeys = Object.keys(qd.diffs || {}).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
    if (completedKeys.length >= 1 && summary) {
      // Use the good server window function (same as snapshot piggyback)
      const serverWindow = computeServerWindow(qd, period, clock, summary, hA, aA, league);
      if (serverWindow && serverWindow.available) {
        ctx.rollingWindow = serverWindow;
        ctx.rollingWindow.dataQuality = 'SERVER-QD';
      }
    }
    // Store quarter diffs for prompt
    if (qd.diffs && Object.keys(qd.diffs).length > 0) {
      ctx.quarterDiffs = qd.diffs;
    }

    // Acceleration from snapshots (gap trajectory still uses snapshot history — more data points)
    const snaps = await sql`
      SELECT period, floor_score, floor_team, i1, i2, i3, i4, i5, ts
      FROM snapshots WHERE game_id = ${game.id} AND floor_score IS NOT NULL
      ORDER BY ts ASC
    `;
    if (snaps.length >= 3 && ctx.rollingWindow) {
      const byPeriod = {};
      for (const s of snaps) { if (s.period >= 1) byPeriod[s.period] = s; }
      const periodKeys = Object.keys(byPeriod).map(Number).sort((a, b) => a - b);
      const gapEntries = [];
      for (const pk of periodKeys) {
        const sn = byPeriod[pk];
        if (sn.floor_score != null) {
          const periodRaw = (sn.i1 ?? 0.5) * W.I1 + (sn.i2 ?? 0.5) * W.I2 + (sn.i3 ?? 0.5) * W.I3 + (sn.i4 ?? 0.5) * W.I4 + (sn.i5 ?? 0.5) * W.I5;
          const periodScore = periodRaw >= 0.5 ? periodRaw : 1 - periodRaw;
          gapEntries.push({ gap: periodScore - sn.floor_score, score: sn.floor_score, period: pk });
        }
      }
      if (gapEntries.length >= 2) {
        ctx.acceleration = computeAccelerationServer(gapEntries);
      }
    }

    // Combined read
    if (ctx.rollingWindow) {
      ctx.combinedRead = classifyCombinedReadServer(ind.score, ind.controlTeam, ctx.rollingWindow, ctx.acceleration);
    }
  } catch (e) {
    log(`${matchup}: server context — quarter_data/window failed: ${e.message}`);
  }

  // ── 5. PBP AUDIT + SUB-METRIC ARROWS (from BDL — already parsed in main loop) ──
  try {
    const pbpResult = game._bdlPbp || null;
    if (pbpResult) {
      ctx.pbpAudit = {
        home: pbpResult.home, away: pbpResult.away,
        homeAlias: hA, awayAlias: aA,
        runs: pbpResult.runs,
        pbpPeriod: pbpResult.pbpPeriod, pbpAge: 0,
      };

      // Save PBP to DB
      try {
        const pbpSave = {
          home: pbpResult.home, away: pbpResult.away,
          homeAlias: hA, awayAlias: aA,
          totalShots: pbpResult.totalShots, totalTOs: pbpResult.totalTOs,
          runs: pbpResult.runs, runs6: pbpResult.runs6,
          scoringEvents: pbpResult.scoringEvents,
          raw: pbpResult.raw,
          _bdl: pbpResult._bdl,
        };
        // Build box_score_json from summary stats
        const _hs = summary.home?.statistics || {}, _as = summary.away?.statistics || {};
        const liveBoxJson = JSON.stringify({
          home: { stl: _hs.steals||0, blk: _hs.blocks||0, oreb: _hs.offensive_rebounds||0, to: _hs.turnovers||_hs.total_turnovers||0, fta: _hs.free_throws_att||0, ftm: _hs.free_throws_made||0, fgm: _hs.field_goals_made||0, fga: _hs.field_goals_att||0, fg3m: _hs.three_points_made||0, fg3a: _hs.three_points_att||0, fg2m: _hs.two_points_made||0, fg2a: _hs.two_points_att||0, ast: _hs.assists||0, pts: _hs.points||0, pf: _hs.personal_fouls||0, atRimM: _hs.field_goals_at_rim_made||0, atRimA: _hs.field_goals_at_rim_att||0, paintM: _hs.points_in_paint_made||0, paintA: _hs.points_in_paint_att||0, paint: _hs.points_in_the_paint||_hs.points_in_paint||0, pot: _hs.points_off_turnovers||0, scp: _hs.second_chance_points||_hs.second_chance_pts||0, fbp: _hs.fast_break_points||0, fd: _hs.fouls_drawn||0, bigLead: _hs.biggest_lead||0, bench: _hs.bench_points||0, poss: _hs.possessions||0, oppp: _hs.offensive_points_per_possession||0, dppp: _hs.defensive_points_per_possession||0 },
          away: { stl: _as.steals||0, blk: _as.blocks||0, oreb: _as.offensive_rebounds||0, to: _as.turnovers||_as.total_turnovers||0, fta: _as.free_throws_att||0, ftm: _as.free_throws_made||0, fgm: _as.field_goals_made||0, fga: _as.field_goals_att||0, fg3m: _as.three_points_made||0, fg3a: _as.three_points_att||0, fg2m: _as.two_points_made||0, fg2a: _as.two_points_att||0, ast: _as.assists||0, pts: _as.points||0, pf: _as.personal_fouls||0, atRimM: _as.field_goals_at_rim_made||0, atRimA: _as.field_goals_at_rim_att||0, paintM: _as.points_in_paint_made||0, paintA: _as.points_in_paint_att||0, paint: _as.points_in_the_paint||_as.points_in_paint||0, pot: _as.points_off_turnovers||0, scp: _as.second_chance_points||_as.second_chance_pts||0, fbp: _as.fast_break_points||0, fd: _as.fouls_drawn||0, bigLead: _as.biggest_lead||0, bench: _as.bench_points||0, poss: _as.possessions||0, oppp: _as.offensive_points_per_possession||0, dppp: _as.defensive_points_per_possession||0 },
          home_pts: summary.home?.points||0, away_pts: summary.away?.points||0,
        });
        await sql`
          INSERT INTO game_pbp (game_id, league, home_alias, away_alias, total_shots, total_tos, pbp_json, box_score_json, saved_at)
          VALUES (${game.id}, ${league}, ${hA}, ${aA}, ${pbpResult.totalShots || 0}, ${pbpResult.totalTOs || 0}, ${JSON.stringify(pbpSave)}, ${liveBoxJson}, NOW())
          ON CONFLICT (game_id) DO UPDATE SET
            pbp_json = ${JSON.stringify(pbpSave)}, box_score_json = ${liveBoxJson},
            total_shots = ${pbpResult.totalShots || 0},
            total_tos = ${pbpResult.totalTOs || 0}, saved_at = NOW()
        `;
      } catch (e) { /* non-fatal */ }

      // Sub-metric arrows from PBP per-quarter data
      if (pbpResult.perQuarter) {
        ctx.subMetricArrows = computeSubMetricArrowsServer(pbpResult.perQuarter, hA, aA);
        if (ctx.subMetricArrows && ind.controlTeam) {
          ctx.adjustment = classifyAdjustmentServer(ctx.subMetricArrows, ind.controlTeam, hA, aA);
        }
      }
      log(`${matchup}: BDL PBP — ${pbpResult.totalShots || 0} shots, ${pbpResult.totalTOs || 0} TOs, ${Object.keys(pbpResult.perQuarter || {}).length}Q arrows`);
    }
  } catch (e) {
    log(`${matchup}: server PBP processing failed: ${e.message}`);
  }

  // ── 6. VOLUME THREAT + THROUGHPUT + LEAD SAFETY ──
  try {
    // Compute volume threat (needs PBP + sust + game time)
    var GAME_MINS_VT = (league === 'ncaamb' || league === 'wnba') ? 40 : 48;
    var PERIOD_MINS_VT = league === 'ncaamb' ? 20 : league === 'wnba' ? 10 : 12;
    var totalPeriodsVT = league === 'ncaamb' ? 2 : 4;
    var vtClockParts = (clock || '').split(':');
    var vtClockMins = vtClockParts.length === 2 ? (parseInt(vtClockParts[0]) || 0) + ((parseInt(vtClockParts[1]) || 0) / 60) : PERIOD_MINS_VT;
    var vtPeriodsLeft = Math.max(0, totalPeriodsVT - period);
    var vtMinsLeft = vtClockMins + (vtPeriodsLeft * PERIOD_MINS_VT);
    var vtMinsElapsed = Math.max(1, GAME_MINS_VT - vtMinsLeft);
    ctx.volumeThreat = computeVolumeThreat(summary, ctx.pbpAudit, sust, league, vtMinsElapsed);

    ctx.throughput = computeThroughputServer(summary, ind, sust, hA, aA, period, clock, league, ctx.volumeThreat);
    ctx.leadSafety = computeLeadSafetyServer(summary, ind, sust, hA, aA, period, clock, league, ctx.volumeThreat);

    // Trend arrows — compare against previous poll's expected swing
    // CTRL-FLIP GUARD: reset prev values when control team changes
    try {
      const prevRows = await sql`SELECT prev_tp_exp, prev_ls_exp, prev_ctrl_team FROM games WHERE id = ${game.id}`;
      const prev = prevRows.length > 0 ? prevRows[0] : {};
      const ctrlFlipped = prev.prev_ctrl_team && prev.prev_ctrl_team !== ind.controlTeam;

      if (ctrlFlipped) {
        // Control team changed — prev swing values are for the wrong team, reset
        log(`${matchup}: trend RESET — ctrl flip ${prev.prev_ctrl_team} → ${ind.controlTeam}`);
        await sql`UPDATE games SET prev_tp_exp = NULL, prev_ls_exp = NULL, prev_ctrl_team = ${ind.controlTeam} WHERE id = ${game.id}`;
      } else {
        if (ctx.throughput) {
          const curExp = ctx.throughput.expected.totalSwing;
          const prevExp = prev.prev_tp_exp;
          if (prevExp != null && !isNaN(prevExp)) {
            const delta = Math.round((curExp - prevExp) * 10) / 10;
            ctx.throughput.trend = Math.abs(delta) < 0.5 ? '▬' : delta > 0 ? '▲' : '▼';
            ctx.throughput.trendDelta = delta;
          }
          await sql`UPDATE games SET prev_tp_exp = ${curExp}, prev_ctrl_team = ${ind.controlTeam} WHERE id = ${game.id}`;
        }

        if (ctx.leadSafety) {
          const curExp = ctx.leadSafety.expected.totalSwing;
          const prevExp = prev.prev_ls_exp;
          if (prevExp != null && !isNaN(prevExp)) {
            const delta = Math.round((curExp - prevExp) * 10) / 10;
            // For lead safety, LOWER opponent recovery = safer lead = ▲ (improving)
            ctx.leadSafety.trend = Math.abs(delta) < 0.5 ? '▬' : delta < 0 ? '▲' : '▼';
            ctx.leadSafety.trendDelta = delta;
          }
          await sql`UPDATE games SET prev_ls_exp = ${curExp} WHERE id = ${game.id}`;
        }
      }
    } catch (e) {
      // prev columns may not exist yet — non-fatal
      log(`${matchup}: trend columns read/write failed (run init?): ${e.message}`);
    }
  } catch (e) {
    log(`${matchup}: server throughput/leadSafety failed: ${e.message}`);
  }

  // ── 7. MIP (Market Implied Probability) ──
  if (odds && (odds.homeML || odds.awayML)) {
    const hML = parseFloat(odds.homeML), aML = parseFloat(odds.awayML);
    const garbageLine = (Math.abs(hML) >= 50000 || Math.abs(aML) >= 50000 || hML === aML);
    if (!garbageLine) {
      const homeMIP = mlToProb(odds.homeML);
      const awayMIP = mlToProb(odds.awayML);
      if (homeMIP != null && awayMIP != null) {
        const vigSum = homeMIP + awayMIP;
        ctx.mip = {
          homeNorm: (homeMIP / vigSum * 100).toFixed(1),
          awayNorm: (awayMIP / vigSum * 100).toFixed(1),
          homeAlias: hA, awayAlias: aA,
        };
      }
    } else {
      ctx.mip = { garbage: true };
    }
  }

  // ── 8. BONUS STATUS ──
  if (summary.home?.bonus || summary.away?.bonus) {
    ctx.bonusStatus = {
      home: summary.home?.bonus || false,
      away: summary.away?.bonus || false,
      homeDouble: summary.home?.double_bonus || false,
      awayDouble: summary.away?.double_bonus || false,
    };
  }

  // ── 9. GAME META ──
  const hs = summary.home?.statistics || {};
  const as = summary.away?.statistics || {};
  ctx.gameMeta = {
    leadChanges: summary.lead_changes || 0,
    timesTied: summary.times_tied || 0,
    hFoulouts: hs.foulouts || 0, aFoulouts: as.foulouts || 0,
  };

  // ── 10. TRACKING DATA (catch-and-shoot + pull-up eFG — NBA only, fetched once per game) ──
  if (league === 'nba') {
    if (!game._trackingData && !game._trackingFetched) {
      game._trackingFetched = true;
      try {
        game._trackingData = await fetchTrackingData(hA, aA);
        if (game._trackingData) log(`${matchup}: tracking data fetched`);
      } catch (e) { /* non-fatal */ }
    }
    if (game._trackingData) {
      ctx.trackingData = game._trackingData;
    }
  }

  const layerCount = Object.keys(ctx).length;
  if (layerCount > 0) {
    log(`${matchup}: server context computed — ${layerCount} layers: ${Object.keys(ctx).join(', ')}`);
  }
  return layerCount > 0 ? ctx : null;
}

// ── Q3-END CALIBRATION: PARSE SONNET RESPONSE ──────────────────────────────
// Extracts structured fields from Sonnet's analysis text for DB storage.

function parseAnalysisText(text, homeAlias, awayAlias) {
  const result = {
    controlTeam: null, controlScore: null,
    fwp: null, edge: null, entry: null,
    conviction: null, signal: null,
    sustainability: null, leadSource: null,
    predictionJson: null, indicatorsJson: null,
    // New v2 fields
    risk: null, closing: null, narrative: null, disagreement: null,
  };
  if (!text) return result;

  // ── FWP (both old and new format) ──
  const fwpMatch = text.match(/FWP:\s*(\w+)\s+([\d.]+)%\s*\/\s*(\w+)\s+([\d.]+)%/);
  if (fwpMatch) {
    result.fwp = `${fwpMatch[1]} ${fwpMatch[2]}% / ${fwpMatch[3]} ${fwpMatch[4]}%`;
    const t1 = fwpMatch[1], v1 = parseFloat(fwpMatch[2]);
    const t3 = fwpMatch[3], v3 = parseFloat(fwpMatch[4]);
    result.predictionJson = {
      homeValue: { fwp: t1 === homeAlias ? v1 : v3 },
      awayValue: { fwp: t1 === awayAlias ? v1 : v3 },
    };
  }

  // ── EDGE (both formats) ──
  const edgeMatch = text.match(/EDGE:\s*([^\n|]+)/);
  if (edgeMatch) result.edge = edgeMatch[1].trim();

  // ── Sustainability (both formats) ──
  const sustMatch = text.match(/Sustainability:\s*(.+?)(?:\n|$)/);
  if (sustMatch) result.sustainability = sustMatch[1].trim();

  // ── Lead Source (both formats) ──
  const leadMatch = text.match(/Lead Source:\s*(.+?)(?:\n|$)/);
  if (leadMatch) result.leadSource = leadMatch[1].trim();

  // ── NEW v2 fields ──
  const riskMatch = text.match(/RISK:\s*(.+?)(?:\n|$)/);
  if (riskMatch) result.risk = riskMatch[1].trim();

  const closingMatch = text.match(/CLOSING:\s*(.+?)(?:\n|$)/);
  if (closingMatch) result.closing = closingMatch[1].trim();

  const narrativeMatch = text.match(/NARRATIVE:\s*([\s\S]*?)(?:\n(?:Sustainability|Lead Source|DISAGREEMENT|RISK|CLOSING|FWP|EDGE):|$)/);
  if (narrativeMatch) result.narrative = narrativeMatch[1].trim();

  const disagreeMatch = text.match(/DISAGREEMENT:\s*(.+?)(?:\n|$)/);
  if (disagreeMatch) result.disagreement = disagreeMatch[1].trim();

  // ── BACKWARD COMPAT: old format fields (pre-v2 analyses) ──
  const controlMatch = text.match(/CONTROL:\s*(\w+)\s+([\d.]+)/);
  if (controlMatch) {
    result.controlTeam = controlMatch[1];
    result.controlScore = parseFloat(controlMatch[2]);
  }

  const entryMatch = text.match(/ENTRY:\s*(OPTIMAL WINDOW|WINDOW OPEN|WINDOW CLOSING|NO WINDOW|FADE)/);
  if (entryMatch) result.entry = entryMatch[1];

  const convMatch = text.match(/CONVICTION:\s*(DOMINANT|STRONG|EARNED|MODEST|CONDITIONAL|NO ENTRY)/);
  if (convMatch) result.conviction = convMatch[1];

  const sigMatch = text.match(/SIGNAL:\s*(.+?)(?:\n|$)/);
  if (sigMatch) result.signal = sigMatch[1].trim();

  // Old format indicator lines (backward compat for historical analyses)
  const indicators = {};
  const indRe = /I(\d)\s+[^:]+:\s*(\w+)\s+([\d.]+)\s*—\s*(.+?)(?:\n|$)/g;
  let m;
  while ((m = indRe.exec(text)) !== null) {
    indicators['I' + m[1]] = { leader: m[2], score: parseFloat(m[3]), detail: m[4].trim() };
  }
  if (Object.keys(indicators).length > 0) result.indicatorsJson = indicators;

  return result;
}

// Single function that formats ALL data layers into prompt text.
// Matches analyze.js quality — no more "payload ghost" layers.

function formatSonnetPrompt({ hA, aA, period, clock, score, thesis, sust, leadComp, ind, clutchData, odds, espnWP, wpProfiles, analysisHistory, ctx, quarterDataFromDB, summary, conviction, graduationCtx, priorAlertTrail, floorWP, xgbData, mcData, league }) {
  let p = `${aA} @ ${hA} | Q${period} ${clock} | ${score}\n\n`;

  // ── TEAM CONTEXT (TEAM_PROFILES_SPEC §6) — '' when flag off / non-WNBA / unloaded ──
  const _tcBlock = composeTeamContext(hA, aA, league);
  if (_tcBlock) p += _tcBlock + `\n`;

  // ── GROUND TRUTH (mechanical engine output — do not override) ──
  if (ind) {
    const ctrlHome = ind.controlTeam === hA;
    const _fci = ctrlI(ind);
    const i1ctrl = _fci[0], i2ctrl = _fci[1], i3ctrl = _fci[2], i4ctrl = _fci[3], i5ctrl = _fci[4];
    p += `GROUND TRUTH (mechanical engine — do not override):\n`;
    p += `Control: ${ind.controlTeam} ${ind.score?.toFixed(2)} (floor = weighted I1-I5 composite, 0-1) | `;
    p += `Conviction: ${conviction?.tier || 'N/A'} (${conviction?.combo || 'N/A'})`;
    if (conviction?.pairs?.length > 0) p += ` | Killer pairs: ${conviction.pairs.join(', ')}`;
    if (conviction?.isDanger) p += ` | ⚠ DANGER COMBO`;
    p += `\n`;
    p += `(Indicator scale: 1.0=ctrl dominates, 0.0=opponent dominates, 0.5=even. Won ≥0.55, lost ≤0.45)\n`;
    p += `I1 Disruption: ${ind.I1?.leader || 'EVEN'} ${i1ctrl?.toFixed(1) || '?'} | `;
    p += `I2 Interior: ${ind.I2?.leader || 'EVEN'} ${i2ctrl?.toFixed(1) || '?'} | `;
    p += `I3 Shot Quality: ${ind.I3?.leader || 'EVEN'} ${i3ctrl?.toFixed(1) || '?'} | `;
    p += `I4 Game Control: ${ind.I4?.leader || 'EVEN'} ${i4ctrl?.toFixed(1) || '?'} | `;
    p += `I5 Execution: ${ind.I5?.leader || 'EVEN'} ${i5ctrl?.toFixed(1) || '?'}\n`;
    if (conviction) {
      p += `Indicators won by ${ind.controlTeam}: ${conviction.indicatorsWon?.join('+') || 'NONE'}`;
      if (conviction.indicatorsLost?.length > 0) p += ` | Lost: ${conviction.indicatorsLost.join('+')}`;
      p += `\n`;
    }
    p += `\n`;
  }

  // Floor reliability context
  if (floorWP && floorWP.reliabilityClass && floorWP.reliabilityClass !== 'NEUTRAL' && ind) {
    p += `FLOOR RELIABILITY: ${ind.controlTeam} is ${floorWP.reliabilityClass} (grip ${floorWP.grip > 0 ? '+' : ''}${floorWP.grip})`;
    if (floorWP.wp != null) p += ` | Historical close-game win rate at floor ${ind.score?.toFixed(1)}: ${floorWP.wp}%`;
    if (floorWP.reliabilityClass === 'WEAK' || floorWP.reliabilityClass === 'BROKEN') {
      p += `\nCAUTION: This team's floor score historically overstates structural edge in close games. Exercise caution in FWP assessment.`;
    } else if (floorWP.reliabilityClass === 'ELITE') {
      p += `\nThis team's floor reads are highly reliable — floor closely tracks actual win probability.`;
    }
    p += `\n\n`;
  }

  // XGBoost structural model + conviction quality
  if (xgbData && xgbData.winProb != null) {
    p += `XGBOOST STRUCTURAL MODEL (independent — trained on 13 raw stat differentials, does NOT use floor/indicators/margin):\n`;
    p += `XGB win probability: ${(xgbData.winProb * 100).toFixed(1)}% | MC Cum: ${mcData?.mcCumWp != null ? (mcData.mcCumWp * 100).toFixed(1) + '%' : '?'} | Floor: ${(ind.score * 100).toFixed(1)}% | ${xgbData.aligned ? 'ALIGNED' : 'DIVERGENT (' + (xgbData.divergence > 0 ? '+' : '') + (xgbData.divergence * 100).toFixed(1) + '%)'}\n`;
    if (xgbData.shap) {
      p += `SHAP drivers: ${xgbData.shap.map(s => s.f + '=' + (s.v > 0 ? '+' : '') + s.v.toFixed(2)).join(', ')}\n`;
    }
    if (xgbData.convictionQuality) {
      const cq = xgbData.convictionQuality;
      p += `Conviction quality: ${cq.basis} — ${Math.round(cq.strConcentration * 100)}% structural / ${Math.round(cq.volConcentration * 100)}% volatile\n`;
      p += `Top driver: ${cq.top1Feature} (${Math.round(cq.top1Share * 100)}% of positive SHAP)${cq.top1IsVolatile ? ' [VOLATILE]' : ''}\n`;
      p += `Scoreboard: ${cq.bigleadAnchored ? 'CONFIRMED — biglead driving ' + Math.round(cq.bigleadShare * 100) + '% (95% WR in backtest)' : cq.noScoreboardConfirmation ? 'NOT CONFIRMED — stats not translating to lead (19% loss rate vs 5%)' : 'PARTIAL — biglead contributing ' + Math.round(cq.bigleadShare * 100) + '%'}\n`;
    }
    if (xgbData.trajectorySignals && xgbData.trajectorySignals.warnings.length > 0) {
      p += `Conviction warnings:\n${xgbData.trajectorySignals.warnings.join('\n')}\n`;
    }
    p += `\n`;
  }

  // Monte Carlo trajectory + investigation
  if (mcData) {
    if (mcData.mcWinProb != null) {
      p += `MONTE CARLO TRAJECTORY (always-on, last 20 possessions projected forward):\n`;
      p += `  MC PBP: ${(mcData.mcWinProb * 100).toFixed(1)}% | MC Cum: ${mcData.mcCumWp != null ? (mcData.mcCumWp * 100).toFixed(1) + '%' : '?'} | Floor: ${ind ? (ind.score * 100).toFixed(1) + '%' : '?'} | XGB: ${xgbData?.winProb != null ? (xgbData.winProb * 100).toFixed(1) + '%' : '?'}\n`;
      if (ind && Math.abs(mcData.mcWinProb - ind.score) > 0.15) {
        p += `  DIVERGENCE: MC and floor disagree by ${Math.round(Math.abs(mcData.mcWinProb - ind.score) * 100)}pp — recent possession rates tell a different story than cumulative box score.\n`;
      }
      // XGB-MC directional divergence (league-specific)
      if (xgbData?.winProb != null && mcData?.mcCumWp != null) {
        const gap = xgbData.winProb - mcData.mcCumWp;
        if (gap < -0.10) {
          p += `  SIGNAL DIVERGENCE [STRUCT]: MC Cum (${(mcData.mcCumWp * 100).toFixed(0)}%) >> XGB (${(xgbData.winProb * 100).toFixed(0)}%), gap ${Math.round(Math.abs(gap) * 100)}pp. MC LEADS. ${period >= 4 ? 'In Q4, lean MC when the two disagree (late-game order). Direction only, not a magnitude.' : 'Weigh MC, but XGB still carries structural weight pre-Q4.'}\n`;
        } else if (gap > 0.10) {
          p += `  SIGNAL DIVERGENCE [STRUCT]: XGB (${(xgbData.winProb * 100).toFixed(0)}%) >> MC Cum (${(mcData.mcCumWp * 100).toFixed(0)}%), gap ${Math.round(Math.abs(gap) * 100)}pp. XGB LEADS. ${period >= 4 ? 'In Q4 the order favors MC over XGB — treat a lone XGB lead with caution.' : 'XGB is credible pre-Q4 (Q2-Q3 order: XGB >= MC).'}\n`;
        }
      }
      // Failure profile flag (league-specific) — split by XGB agreement
      if (ind?.score >= 0.65) {
        const _aaMcLow = mcData?.mcCumWp != null && mcData.mcCumWp < 0.60;
        const _aaXgbLow = xgbData?.winProb != null && xgbData.winProb < 0.50;
        if (_aaMcLow && _aaXgbLow) {
          p += league === 'wnba'
            ? `  ⚠️ FAILURE PROFILE [STRUCT]: Floor ${(ind.score * 100).toFixed(0)}% but MC AND XGB both disagree with floor — floor is the one that's wrong; genuine structural erosion.\n`
            : `  ⚠️ FAILURE PROFILE [STRUCT]: Floor ${(ind.score * 100).toFixed(0)}% but MC AND XGB both disagree with floor — genuine structural erosion (not just cumulative anchoring).\n`;
        } else if (_aaMcLow && !_aaXgbLow) {
          p += `  BUY SETUP [STRUCT]: MC Cum ${(mcData.mcCumWp * 100).toFixed(0)}% while floor ${(ind.score * 100).toFixed(0)}%, but XGB ${(xgbData?.winProb * 100).toFixed(0)}% confirms structure. Low MC here reflects a trailing/deficit environment, not structural decay — a structurally dominant team trailing. NOT a failure profile; weigh the full structural picture, not MC magnitude.\n`;
        }
      }
      if (mcData.mcDrivers && mcData.mcDrivers.length > 0) {
        var sigDrivers = mcData.mcDrivers.filter(function(d) { return Math.abs(d.delta) >= 0.02; });
        if (sigDrivers.length > 0) {
          p += `  MC RATE DRIVERS:\n`;
          for (var di = 0; di < sigDrivers.length; di++) {
            var d = sigDrivers[di];
            p += `    ${d.label}: ${d.delta >= 0 ? '+' : ''}${Math.round(d.delta * 100)}pp (game ${(d.ctrlVal * 100).toFixed(0)}% vs season ${(d.seasonVal * 100).toFixed(0)}%)\n`;
          }
        }
      }
      p += `\n`;
    }
    var mcInv = mcData.investigation;
    if (mcInv && mcInv.triggered) {
      p += `MONTE CARLO STRUCTURAL INVESTIGATION:\n`;
      p += `  Status: ${mcInv.pattern || 'Active — classifying'}\n`;
      p += `  Triggered: Q${mcInv.trigger_period} ${mcInv.trigger_clock} (${mcInv.ctrl_team} led by ${mcInv.trigger_margin} at trigger)\n`;
      p += `  Floor at trigger: ${mcInv.trigger_floor?.toFixed(2)} | XGB at trigger: ${(mcInv.trigger_xgb * 100).toFixed(0)}%\n`;
      p += `  Current MC: ${mcInv.current_mc != null ? (mcInv.current_mc * 100).toFixed(1) + '%' : 'investigating'}\n`;
      p += `  Verdicts: ${mcInv.verdicts?.join(' → ') || 'none yet'}\n`;
      if (mcInv.pattern === 'CLEAN') p += `  WARNING: SUSTAINED COLLAPSE — floor and XGB are stale. Post-trigger rates never recovered.\n`;
      else if (mcInv.pattern === 'WAVE') p += `  RISK: Oscillating rates — collapsed, recovered, collapsed again.\n`;
      else if (mcInv.pattern === 'NORMALIZED') p += `  POSITIVE: Rates recovered — structural hold validated by MC investigation.\n`;
      p += `\n`;
    }
  } else if (ctx?.mcInvestigation?.active) {
    // Fallback for client-triggered context without mcData
    const mc = ctx.mcInvestigation;
    p += `MONTE CARLO STRUCTURAL INVESTIGATION:\n`;
    p += `  Status: ${mc.pattern || 'Active — classifying'}\n`;
    p += `  Triggered: Q${mc.trigger_period} ${mc.trigger_clock} (${mc.ctrl_team} led by ${mc.trigger_margin} at trigger)\n`;
    p += `  Floor at trigger: ${mc.trigger_floor?.toFixed(2)} | XGB at trigger: ${(mc.trigger_xgb * 100).toFixed(0)}%\n`;
    p += `  Current MC: ${mc.current_mc != null ? (mc.current_mc * 100).toFixed(1) + '%' : 'investigating'}\n`;
    p += `  Verdicts: ${mc.verdicts?.join(' → ') || 'none yet'}\n`;
    if (mc.pattern === 'CLEAN') p += `  WARNING: SUSTAINED COLLAPSE — floor and XGB are stale. Post-trigger rates never recovered.\n`;
    else if (mc.pattern === 'WAVE') p += `  RISK: Oscillating rates — collapsed, recovered, collapsed again.\n`;
    else if (mc.pattern === 'NORMALIZED') p += `  POSITIVE: Rates recovered — structural hold validated by MC investigation.\n`;
    p += `\n`;
  }

  // Thesis
  if (thesis) p += `THESIS:\n${thesis}\n`;
  p += '\n';


  // Game meta
  if (ctx?.gameMeta) {
    const m = ctx.gameMeta;
    p += `GAME META: Lead changes: ${m.leadChanges} | Times tied: ${m.timesTied} | Foulouts: ${m.hFoulouts}/${m.aFoulouts} (home/away)\n`;
  }

  // TP/LS classifications
  if (ctx?.throughput) {
    const tp = ctx.throughput;
    p += `THROUGHPUT (trailing team comeback projection): ${tp.classification}\n`;
    p += `  Deficit: ${tp.deficit} | Expected swing: ${Math.round(tp.expected.totalSwing)} pts | Remaining poss: ${tp.remainingPoss || '?'}\n`;
    p += `  Ctrl structRate: ${tp.ctrlStructRate?.toFixed(2) || '?'} | Opp structRate: ${tp.oppStructRate?.toFixed(2) || '?'}`;
    if (tp.trend) p += ` | Trend: ${tp.trend}${tp.trendDelta != null ? ' (' + (tp.trendDelta > 0 ? '+' : '') + tp.trendDelta.toFixed(1) + ')' : ''}`;
    p += `\n`;
  }
  if (ctx?.leadSafety) {
    const ls = ctx.leadSafety;
    p += `LEAD SAFETY (leading team margin security): ${ls.classification}\n`;
    p += `  Lead: ${ls.lead} | Expected opp recovery: ${Math.round(ls.expected.totalSwing)} pts | Remaining poss: ${ls.remainingPoss || '?'}`;
    if (ls.trend) p += ` | Trend: ${ls.trend}${ls.trendDelta != null ? ' (' + (ls.trendDelta > 0 ? '+' : '') + ls.trendDelta.toFixed(1) + ')' : ''}`;
    p += `\n`;
  }

  // Graduation / BWC lifecycle context
  if (graduationCtx) {
    const gc = graduationCtx;
    p += `\nPOSITION TRACKING:\n`;
    p += `Tracked team: ${gc.bwcTeam} (fired Q${gc.bwcFirePeriod}, floor ${gc.bwcFireFloor != null ? Number(gc.bwcFireFloor).toFixed(2) : '?'})${gc.lane ? ' | Lane: ' + gc.lane + ' (pregame ML ' + (gc.pregameML || '?') + ')' : ''}\n`;
    const mfStr = gc.mfTrajectory
      ? `MF ${gc.mfTrajectory.direction} (${gc.mfTrajectory.floors.map(f => f.toFixed(2)).join(' -> ')})`
      : 'No MF data';
    if (gc.compoundTier === 'CONFIRMED' || gc.compoundTier === 'RECOVERING' || gc.compoundTier === 'LOCKED') {
      p += `Position: ${gc.compoundTier} (${gc.compoundHolds} holds, ${gc.compoundPath || 'STANDARD'} path) | MC Cum at confirmation: ${gc.mcCumAtConfirmation != null ? (gc.mcCumAtConfirmation * 100).toFixed(1) + '%' : '?'} | ${mfStr}\n`;
    } else {
      p += `Pre-confirmation (${gc.compoundHolds || 0} compound holds toward threshold) | ${mfStr}\n`;
    }
    p += `CP flips: ${gc.cpCtrlFlips} | Game ctrl flips: ${gc.ctrlFlips}\n`;
    if (gc.bwcFlipped) p += `POSITION FLIPPED: Originally ${gc.originalBwcTeam}, flipped to ${gc.bwcTeam}\n`;
    if (gc.positionClosed) p += `POSITION CLOSED: EXIT was previously sent\n`;
    p += `BWC state: ${gc.bwcState || 'unknown'}\n`;
  }

  // 3PT Sustainability (rich format with personnel details)
  if (sust) {
    p += `3PT SUSTAINABILITY AUDIT:\n`;
    [{ data: sust.away, alias: aA }, { data: sust.home, alias: hA }].forEach(({ data: t, alias }) => {
      if (!t) return;
      if (t.tier === 'TOO EARLY') { p += `${alias}: ${t.live3PM || '?'}/${t.live3PA || '?'} 3PT — TOO EARLY (< 5 attempts)\n`; return; }
      p += `${alias}: ${t.live3PM || '?'}/${t.live3PA || '?'} (${t.live3Pct || '?'}%) vs season ${t.seasonPrior || '?'}%${t.gotSeasonData ? '' : ' [avg fallback]'}\n`;
      if (t.personnelGrade === 'N/A (at baseline)') {
        p += `  Personnel: N/A — shooting at/below baseline\n`;
      } else if (t.personnelDetails && t.personnelDetails.length > 0) {
        p += `  Personnel: ${t.elitePct || 0}% from ELITE, ${t.nonPct || 0}% from NON-SHOOTERS — ${t.personnelGrade || '?'}\n`;
        t.personnelDetails.forEach(pl => {
          p += `    ${pl.name}: ${pl.live3m}/${pl.live3a} (${pl.livePct}%) vs szn ${pl.sznStr} [${pl.tierLabel}]${pl.hot ? ' HOT' : ''}\n`;
        });
      }
      p += `  Regression (Bayesian): prior ${t.seasonPrior || '?'}% (season avg) | posterior ${t.posteriorMean || '?'}% (updated estimate) | pull ${t.regressionPull || '?'}% toward mean — ${t.regressionGrade || '?'} (${t.regressionProb || '?'}% prob of regressing)\n`;
      p += `  Shot type: ${t.shotTypeNote || '?'} — ${t.shotTypeGrade || '?'}\n`;
      p += `  -> TIER: ${t.tier} (composite ${t.composite || '?'} — personnel 40%, regression 35%, shot type 25%)\n`;
    });
  }

  // Lead composition
  if (leadComp) {
    const h = leadComp.home || {}, a = leadComp.away || {};
    if (h.total && a.total) {
      p += `\nLEAD COMPOSITION: ${aA} ${a.total} — ${hA} ${h.total} (${leadComp.leadTeam || '?'} ${leadComp.margin >= 0 ? '+' : ''}${leadComp.margin || 0})\n`;
      p += `${aA}: Paint ${a.paint || 0} (${a.total > 0 ? Math.round((a.paint||0)/a.total*100) : 0}%) | FT ${a.ft || 0} | 3PT ${a.three || 0} (${a.total > 0 ? Math.round((a.three||0)/a.total*100) : 0}%) | Mid ${a.midOther || 0} | Trans ${a.transition || 0}\n`;
      p += `${hA}: Paint ${h.paint || 0} (${h.total > 0 ? Math.round((h.paint||0)/h.total*100) : 0}%) | FT ${h.ft || 0} | 3PT ${h.three || 0} (${h.total > 0 ? Math.round((h.three||0)/h.total*100) : 0}%) | Mid ${h.midOther || 0} | Trans ${h.transition || 0}\n`;
      p += `Structural (Paint+FT): ${aA} ${a.structural || 0} (${a.structuralPct || 0}%) vs ${hA} ${h.structural || 0} (${h.structuralPct || 0}%)\n`;
      p += `Variance (3PT+Mid): ${aA} ${a.variance || 0} (${a.variancePct || 0}%) vs ${hA} ${h.variance || 0} (${h.variancePct || 0}%)\n`;
      if (leadComp.durability) p += `MARGIN DURABILITY: ${leadComp.durability}\n`;
    } else {
      p += `\nLEAD COMPOSITION: ${leadComp.classification || '?'} — S:${leadComp.structuralPct || '?'}% V:${leadComp.variancePct || '?'}%\n`;
      if (leadComp.home) p += `  ${hA}: Paint ${leadComp.home?.paint || 0} FT ${leadComp.home?.ft || 0} 3PT ${leadComp.home?.three || 0}\n`;
      if (leadComp.away) p += `  ${aA}: Paint ${leadComp.away?.paint || 0} FT ${leadComp.away?.ft || 0} 3PT ${leadComp.away?.three || 0}\n`;
    }
  }

  // Dashboard indicators
  if (ind) {
    p += `\nDASHBOARD SCORES: ${ind.controlTeam || '?'} ${ind.score?.toFixed(2) || '?'}\n`;
    ['I1', 'I2', 'I3', 'I4', 'I5'].forEach(k => {
      if (ind[k]) p += `  ${k}: ${ind[k].score?.toFixed(1) || '?'} ${ind[k].leader || ''} — ${ind[k].detail || ''}\n`;
    });
  }

  // Clutch (rich format)
  if (clutchData) {
    const tierLabel = clutchData.tier === 1 ? 'L15 NBA.com Tier 1' : clutchData.tier === 2 ? 'Season BDL Tier 2' : 'Tier 3';
    p += `\nCLUTCH (${tierLabel}):\n`;
    p += `${aA}: NetRtg ${clutchData.away?.netRtg ?? 'N/A'} OffRtg ${clutchData.away?.offRtg ?? 'N/A'} DefRtg ${clutchData.away?.defRtg ?? 'N/A'} ${clutchData.away?.wl || ''}\n`;
    p += `${hA}: NetRtg ${clutchData.home?.netRtg ?? 'N/A'} OffRtg ${clutchData.home?.offRtg ?? 'N/A'} DefRtg ${clutchData.home?.defRtg ?? 'N/A'} ${clutchData.home?.wl || ''}\n`;
    const hNet = clutchData.home?.netRtg, aNet = clutchData.away?.netRtg;
    if (hNet != null && aNet != null) p += `Edge: ${hNet > aNet ? hA : aA} by ${Math.abs(hNet - aNet).toFixed(1)} NetRtg\n`;
  }

  // Odds + MIP
  if (odds && (odds.homeML || odds.homeSpread)) {
    p += `\nMARKET: Spread ${hA} ${odds.homeSpread || 'N/A'} | ML ${aA} ${odds.awayML || 'N/A'} / ${hA} ${odds.homeML || 'N/A'} | O/U ${odds.total || 'N/A'}\n`;
    if (ctx?.mip && !ctx.mip.garbage) {
      p += `PRE-COMPUTED MIP: If ${hA} wins -> Edge = FWP - ${ctx.mip.homeNorm}% | If ${aA} wins -> Edge = FWP - ${ctx.mip.awayNorm}%\nUse the MIP of the team you are PREDICTING TO WIN.\n`;
    } else if (ctx?.mip?.garbage) {
      p += `MIP: N/A — line dead (extreme/identical MLs)\n`;
    }
  }

  // Bonus status (with I2 multiplier)
  if (ctx?.bonusStatus) {
    const bs = ctx.bonusStatus;
    const homeInBonus = bs.home, awayInBonus = bs.away;
    if (homeInBonus || awayInBonus) {
      const bothInBonus = homeInBonus && awayInBonus;
      p += `\nBONUS STATUS: `;
      if (bothInBonus) {
        p += `BOTH teams in bonus — advantage NEUTRALIZED\n`;
      } else {
        const bonusTeam = homeInBonus ? hA : aA;
        const penalizedTeam = homeInBonus ? aA : hA;
        const clockParts = (clock || '').split(':');
        const clockMins = clockParts.length === 2 ? (parseInt(clockParts[0]) || 0) + (parseInt(clockParts[1] || 0) / 60) : 12;
        p += `${bonusTeam} IN BONUS (BENEFITS ${bonusTeam}, PENALIZES ${penalizedTeam})`;
        if (clockMins >= 4.0) {
          p += ` with ${clockMins.toFixed(1)} min remaining — STRUCTURAL I2 MULTIPLIER.\n`;
          p += `  ${bonusTeam} GAINS: Every drive/paint touch = automatic free throws. Compounds every possession.\n`;
          p += `  ${penalizedTeam} LOSES: Cannot play physical defense. Players risk fouling out. Interior defense compromised.\n`;
        } else {
          p += ` with ${clockMins.toFixed(1)} min remaining\n`;
        }
      }
    }
  }

  // Tracking baselines (from client context if available)
  if (ctx?.trackingData) {
    const ht = ctx.trackingData.home || {}, at = ctx.trackingData.away || {};
    p += `\nSHOOTING BASELINES:\n`;
    if (ht.catchAndShoot || at.catchAndShoot) p += `C&S: ${aA} ${at.catchAndShoot?.efg || '?'}% | ${hA} ${ht.catchAndShoot?.efg || '?'}%\n`;
    if (ht.pullUp || at.pullUp) p += `Pull-up: ${aA} ${at.pullUp?.efg || '?'}% | ${hA} ${ht.pullUp?.efg || '?'}%\n`;
  }

  // ESPN WP (with divergence check)
  if (espnWP && (espnWP.home != null || espnWP.away != null)) {
    p += `\nESPN WIN PROBABILITY (live model):\n`;
    p += `${hA} ${espnWP.home ?? '?'}% / ${aA} ${espnWP.away ?? '?'}%\n`;
    p += `NOTE: ESPN WP is a reference model, not ground truth.\n`;
    p += `DIVERGENCE CHECK: If your FWP diverges >15% from ESPN WP, explain WHY.\n`;
  }

  // Rolling window (full I1-I5 breakdown)
  if (ctx?.rollingWindow?.available) {
    const rw = ctx.rollingWindow;
    const wLabel = rw.windowQuarters ? rw.windowQuarters.join('+') : '?';
    p += `\nROLLING WINDOW (${wLabel}, ${rw.windowPossessions || '?'} poss):\n`;
    p += `Control: ${rw.controlTeam} ${rw.score != null ? rw.score.toFixed(2) : '?'}\n`;
    const _rwCtrlIsHome = ind && ind.controlTeam === hA;
    ['I1', 'I2', 'I3', 'I4', 'I5'].forEach(k => {
      const i = rw[k];
      if (i && i.score != null) {
        const ctrlScore = _rwCtrlIsHome ? i.score : 1 - i.score;
        p += `  ${k}: ${ctrlScore.toFixed(1)} — ${i.detail || ''}\n`;
      }
    });
    p += `Data quality: ${rw.dataQuality || '?'}\n`;
  }

  // Per-quarter breakdown
  const qdSource = quarterDataFromDB || ctx?.quarterDiffs;
  if (qdSource && Object.keys(qdSource).length > 0) {
    p += `\nPER-QUARTER BREAKDOWN:\n`;
    const qdKeys = Object.keys(qdSource).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
    for (const qk of qdKeys) {
      const d = qdSource[qk];
      if (!d || !d.home || !d.away) continue;
      const h = d.home, a = d.away;
      const hPaint = h.points_in_the_paint || h.points_in_paint || 0;
      const aPaint = a.points_in_the_paint || a.points_in_paint || 0;
      p += `  Q${qk} (${hA} vs ${aA}):`
        + ` Paint ${hA}:${hPaint} ${aA}:${aPaint}`
        + ` | FT ${hA}:${h.free_throws_made||0}/${h.free_throws_att||0} ${aA}:${a.free_throws_made||0}/${a.free_throws_att||0}`
        + ` | 3P ${hA}:${h.three_points_made||0}/${h.three_points_att||0} ${aA}:${a.three_points_made||0}/${a.three_points_att||0}`
        + ` | AST ${hA}:${h.assists||0} ${aA}:${a.assists||0}`
        + ` | TO ${hA}:${h.turnovers||h.total_turnovers||0} ${aA}:${a.turnovers||a.total_turnovers||0}`
        + ` | STL ${hA}:${h.steals||0} ${aA}:${a.steals||0}`
        + (h.possessions ? ` | Poss ${hA}:${h.possessions||0} ${aA}:${a.possessions||0}` : '')
        + `\n`;
    }
  }

  // Gap acceleration (with values and history)
  if (ctx?.acceleration) {
    const acc = ctx.acceleration;
    if (acc.entries && acc.entries.length > 0) {
      const last = acc.entries[acc.entries.length - 1];
      p += `\nGAP ACCELERATION (gap = floor score difference between teams, positive = ctrl advantage):\n`;
      p += `Gap: ${last.gap >= 0 ? '+' : ''}${last.gap != null ? last.gap.toFixed(3) : '?'} | Acceleration: ${acc.accel} (${acc.consecutive} consecutive)\n`;
      p += `History: ${acc.entries.slice(-5).map(e => `${e.gap >= 0 ? '+' : ''}${e.gap != null ? e.gap.toFixed(2) : '?'} (${e.score})`).join(' -> ')}\n`;
    } else {
      p += `\nGAP: ${acc.accel || 'TOO EARLY'}\n`;
    }
  }

  // Combined read (with supporting data)
  if (ctx?.combinedRead?.read) {
    p += `\nCOMBINED READ (cumulative + rolling window synthesis): ${ctx.combinedRead.read} — ${ctx.combinedRead.note || ''}\n`;
  }

  // Sub-metric arrows (directional trends)
  if (ctx?.subMetricArrows && (ctx.subMetricArrows.home || ctx.subMetricArrows.away)) {
    p += `\nDIRECTIONAL ARROWS (quarter-over-quarter trends, ▲=rising ▼=falling ▬=flat, values in parens are per-quarter raw stats):\n`;
    const arrowOrder = [
      { header: 'I2 INTERIOR', keys: ['paint', 'atRim', 'fta'] },
      { header: 'I1 DISRUPTION', keys: ['steals', 'tos'] },
      { header: 'I3 SHOT QUALITY', keys: ['fg3aShare', 'astRatio'] },
      { header: 'I5 EXECUTION', keys: ['poss'] },
    ];
    p += `${''.padEnd(12)}${hA.padEnd(18)}${aA}\n`;
    arrowOrder.forEach(grp => {
      p += `${grp.header}:\n`;
      grp.keys.forEach(key => {
        const hm = ctx.subMetricArrows.home ? ctx.subMetricArrows.home[key] : null;
        const am = ctx.subMetricArrows.away ? ctx.subMetricArrows.away[key] : null;
        const label = (hm ? hm.label : (am ? am.label : key)).toString();
        const hStr = (hm && hm.arrow ? (hm.display || '?') : '-').toString();
        const aStr = (am && am.arrow ? (am.display || '?') : '-').toString();
        p += `  ${label.padEnd(10)}${hStr.padEnd(18)}${aStr}\n`;
      });
    });
  }

  // Adjustment signal
  if (ctx?.adjustment && ctx.adjustment.signal && ctx.adjustment.signal !== 'NO ADJUSTMENT' && ctx.adjustment.signal !== 'NO DATA') {
    p += `ADJUSTMENT: ${ctx.adjustment.signal} (${ctx.adjustment.team || '?'}) — ${ctx.adjustment.note || ''}\n`;
  }

  // PBP depth audit (full shot maps, TO breakdown, runs)
  if (ctx?.pbpAudit && (ctx.pbpAudit.home || ctx.pbpAudit.away)) {
    const pAge = ctx.pbpAudit.pbpAge != null ? ctx.pbpAudit.pbpAge + ' min ago' : '';
    const pPer = ctx.pbpAudit.pbpPeriod ? 'Q' + ctx.pbpAudit.pbpPeriod : '?';
    p += `\nDEPTH AUDIT (PBP through ${pPer} ${pAge}):\n`;
    const teams = [
      { data: ctx.pbpAudit.away, alias: ctx.pbpAudit.awayAlias || aA },
      { data: ctx.pbpAudit.home, alias: ctx.pbpAudit.homeAlias || hA },
    ];
    teams.forEach(t => {
      const tm = t.data;
      if (!tm) return;
      p += `\n${t.alias} SHOT MAP:\n`;
      if (tm.threes && tm.threes.byPlayer && tm.threes.byPlayer.length > 0) {
        p += `  3PT (${tm.threes.made}/${tm.threes.att}, ${tm.threes.pct}%, ${tm.threes.assisted}/${tm.threes.made} ast): `;
        tm.threes.byPlayer.forEach(pl => {
          const ctxStr = Object.entries(pl.contexts || {}).map(e => e[0] + ':' + e[1]).join(',');
          p += `${pl.name} ${pl.made}/${pl.att} (${pl.assisted} ast, ${ctxStr}) | `;
        });
        p += '\n';
        if (tm.threes.corner && tm.threes.above) p += `  Corner: ${tm.threes.corner.made}/${tm.threes.corner.att} | Above: ${tm.threes.above.made}/${tm.threes.above.att}\n`;
      }
      if (tm.rim && tm.rim.byPlayer && tm.rim.byPlayer.length > 0) {
        p += `  AT-RIM (${tm.rim.made}/${tm.rim.att}, ${tm.rim.pct}%): `;
        tm.rim.byPlayer.forEach(pl => {
          const ctxStr = Object.entries(pl.contexts || {}).map(e => e[0] + ':' + e[1]).join(',');
          p += `${pl.name} ${pl.made}/${pl.att} (${ctxStr}) | `;
        });
        p += '\n';
      }
      if (tm.mid && tm.mid.byPlayer && tm.mid.byPlayer.length > 0) {
        p += `  MID-RANGE (${tm.mid.made}/${tm.mid.att}, ${tm.mid.pct}%, ${tm.mid.assisted}/${tm.mid.made} ast): `;
        tm.mid.byPlayer.forEach(pl => { p += `${pl.name} ${pl.made}/${pl.att} (${pl.assisted} ast) | `; });
        p += '\n';
      }
      if (tm.shotDiet) p += `  ZONES: rim ${tm.shotDiet.rimPct}% | mid ${tm.shotDiet.midPct}% | 3pt ${tm.shotDiet.threePct}% of FGA\n`;
      if (tm.tos && tm.tos.total > 0) {
        p += `  TOs: ${tm.tos.forced || 0} forced / ${tm.tos.unforced || 0} unforced${tm.tos.unknown > 0 ? ' / ' + tm.tos.unknown + ' unclear' : ''}\n`;
      }
    });
    if (ctx.pbpAudit.runs && ctx.pbpAudit.runs.length > 0) {
      p += `\nSCORING RUNS:\n`;
      ctx.pbpAudit.runs.forEach(r => {
        const mechStr = Array.isArray(r.mechanism) ? r.mechanism.join('+') : (r.mechanism || '?');
        p += `  ${r.team} ${r.pts}-${r.count} run (Q${r.q}): ${mechStr}\n`;
      });
    }
  }

  // Edge history
  if (ctx?.edgeHistory && ctx.edgeHistory.length > 0) {
    p += `\nEDGE HISTORY (edge = FWP minus market implied prob, FWP = your prior Framework Win Probability):\n${ctx.edgeHistory.map(e => `${e.time || '?'} | ${e.edge || '?'} FWP ${e.fwp || '?'} | ${e.control || '?'} ${e.score || ''}`).join('\n')}\n`;
  }

  // Volume threat
  if (ctx?.volumeThreat) {
    const vt = ctx.volumeThreat;
    const hVT = vt.home, aVT = vt.away;
    if (hVT?.active || aVT?.active || hVT?.mitigated || aVT?.mitigated) {
      p += `\nVOLUME THREAT DETECTION:\n`;
      if (hVT?.active) {
        p += `${hA}: ACTIVE — projected ${hVT.projected3PA} 3PA (live ${hVT.live3PA}), ${hVT.live3Pct}% (szn ${hVT.baseline}%), C&S 3PM: ${hVT.cs3PM}\n`;
        p += `  Scheme-driven perimeter production at baseline. This is structural offense, not variance.\n`;
        p += `  Floor discount: ${(hVT.discount * 100).toFixed(0)}% | TP/LS structRate bonus: ${hVT.vtBonus}${hVT.mitigated ? ' (partially mitigated — '+aA+' has '+aVT.live3PA+' 3PA, ratio:'+hVT.mitRatio+')' : ''}\n`;
      } else if (hVT?.mitigated) {
        p += `${hA}: MITIGATED — projected ${hVT.projected3PA} 3PA but ${aA} matching volume (${aVT.live3PA} 3PA, ratio:${hVT.mitRatio}). Shared game profile, not unique counter.\n`;
      }
      if (aVT?.active) {
        p += `${aA}: ACTIVE — projected ${aVT.projected3PA} 3PA (live ${aVT.live3PA}), ${aVT.live3Pct}% (szn ${aVT.baseline}%), C&S 3PM: ${aVT.cs3PM}\n`;
        p += `  Scheme-driven perimeter production at baseline. This is structural offense, not variance.\n`;
        p += `  Floor discount: ${(aVT.discount * 100).toFixed(0)}% | TP/LS structRate bonus: ${aVT.vtBonus}${aVT.mitigated ? ' (partially mitigated — '+hA+' has '+hVT.live3PA+' 3PA, ratio:'+aVT.mitRatio+')' : ''}\n`;
      } else if (aVT?.mitigated) {
        p += `${aA}: MITIGATED — projected ${aVT.projected3PA} 3PA but ${hA} matching volume (${hVT.live3PA} 3PA, ratio:${aVT.mitRatio}). Shared game profile, not unique counter.\n`;
      }
      if (hVT?.active || aVT?.active) {
        p += `HOW TO USE: A team with active volume threat has a structural perimeter counter-engine. The control team's structural edge is overstated — discount conviction and FWP accordingly. Do NOT treat baseline-rate 3PT shooting from a volume threat team as variance to regress.\n`;
      }
    }
  }

  // WP profiles
  if (wpProfiles) p += `\n${wpProfiles}\n`;

  // Analysis history (rich format)
  if (analysisHistory && analysisHistory.length > 0) {
    p += `\nGAME NARRATIVE (prior reads this game):\n`;
    analysisHistory.forEach((h, i) => {
      p += `${i + 1}. Q${h.period || '?'} ${h.clock || ''} | ${h.controlTeam || '?'} ${h.controlScore != null ? h.controlScore.toFixed(2) : '?'} | conv:${h.conviction_tier || h.conviction || '-'}(${h.conviction_combo || '-'})\n`;
    });
  }

  // Prior alert trail (what the subscriber was told)
  if (priorAlertTrail) {
    p += `\nSUBSCRIBER ALERT TRAIL (what the bettor was told):\n${priorAlertTrail}\n`;
  }

  // Full game data
  p += `\nGAME DATA:\n${JSON.stringify(summary)}`;

  return p;
}

// ── Q3-END CALIBRATION: FIRE SONNET ANALYSIS ───────────────────────────────
// Called once per game at the Q3→Q4 transition. Gathers all available context
// from DB (thesis, clutch, WP profiles, calibration stats) and calls the
// analyze function with the full SR summary + server-computed layers.
// Result is saved as a tagged 'auto_q3' analysis row — gold standard metric.

async function fireCalibrationAnalysis(sql, game, league, summary, ind, sust, leadComp, espnWP, odds, matchup, hA, aA, period, clock, trigger, lt) {
  const triggerTag = trigger || 'auto_q3';

  try {
    // ── 1. Fetch thesis from DB ──
    let thesis = null;
    try {
      const rows = await sql`SELECT text FROM theses WHERE game_id = ${game.id}`;
      if (rows.length > 0) thesis = rows[0].text;
    } catch (e) { /* no thesis — proceed without */ }

    // ── 2. Fetch clutch data from DB ──
    let clutchData = null;
    try {
      const rows = await sql`
        SELECT DISTINCT ON (team_alias) team_alias, tier, net_rtg, off_rtg, def_rtg, wl, efg, pace, pie
        FROM clutch WHERE team_alias = ANY(${[hA, aA]}) AND league = ${league}
        ORDER BY team_alias, created_at DESC
      `;
      if (rows.length > 0) {
        clutchData = { tier: 3 };
        for (const r of rows) {
          const side = r.team_alias === hA ? 'home' : 'away';
          clutchData[side] = { netRtg: r.net_rtg, offRtg: r.off_rtg, defRtg: r.def_rtg, wl: r.wl, efg: r.efg, pace: r.pace, pie: r.pie };
          if (r.tier && r.tier < clutchData.tier) clutchData.tier = r.tier;
        }
      }
    } catch (e) { /* no clutch data */ }

    // ── 3. Fetch WP identity profiles from DB ──
    let wpProfiles = null;
    try {
      const rows = await sql`
        SELECT team_alias, profile_json FROM wp_profiles
        WHERE team_alias = ANY(${[hA, aA]}) AND league = ${league}
      `;
      if (rows.length > 0) {
        let wpText = 'WP IDENTITY PROFILES:\n';
        for (const r of rows) {
          const p = typeof r.profile_json === 'string' ? JSON.parse(r.profile_json) : r.profile_json;
          if (p) wpText += `${r.team_alias}: ${p.identity || '?'} — comeback ${p.comebackRate || '?'}%, collapse ${p.collapseRate || '?'}%, avg swing ${p.avgSwing || '?'}\n`;
        }
        wpProfiles = wpText;
      }
    } catch (e) { /* no WP profiles */ }

    // ── 4. Fetch prior analyses for this game (narrative history) ──
    let analysisHistory = null;
    try {
      const rows = await sql`
        SELECT period, clock, control_team, control_score, fwp, entry, conviction, signal, sustainability, conviction_tier, conviction_combo
        FROM analyses WHERE game_id = ${game.id}
        ORDER BY ts ASC LIMIT 5
      `;
      if (rows.length > 0) {
        analysisHistory = rows.map(r => ({
          period: r.period, clock: r.clock,
          controlTeam: r.control_team, controlScore: r.control_score,
          entry: r.entry, conviction: r.conviction,
          conviction_tier: r.conviction_tier || null, conviction_combo: r.conviction_combo || null,
          signal: r.signal, verdict: '',
          leadSust: '', trailSust: '',
        }));
      }
    } catch (e) { /* no history */ }

    // ── 5. Fetch calibration context for prompt ──
    try {
      const gs = await sql`
        SELECT COUNT(*) as total,
          COUNT(CASE WHEN fwp_correct = true THEN 1 END) as fwp_ok,
          COUNT(CASE WHEN fwp_team IS NOT NULL THEN 1 END) as fwp_total,
          COUNT(CASE WHEN thesis_correct = true THEN 1 END) as thesis_ok,
          COUNT(CASE WHEN thesis_team IS NOT NULL THEN 1 END) as thesis_total
        FROM games WHERE league = ${league} AND winner IS NOT NULL
      `;
      const s = gs[0];
      if (s && s.total >= 3) {
      }
    } catch (e) { /* no calibration */ }

    // ── 6. Build analyze payload ──
    const scoreLine = `${aA} ${ind.awayPts} — ${hA} ${ind.homePts}`;
    const periodStr = `Q${period} ${clock}`;

    // ── 6. Compute server context (server is self-sufficient — no client dependency) ──
    let clientCtx = await computeServerContext(sql, game, league, summary, ind, espnWP, hA, aA, period, clock, matchup, sust, odds);
    const ctxSource = clientCtx ? 'server' : 'none';

    // ── 7. Call Anthropic API directly (bypasses site password protection) ──
    const ctxStatus = ctxSource === 'client' ? 'client' : ctxSource === 'server' ? 'server-rich' : 'no-context';
    const ctxLayers = clientCtx ? Object.keys(clientCtx).filter(k => clientCtx[k] != null).length : 0;
    log(`${matchup}: ${triggerTag} CAL — firing Sonnet (${ctxStatus} ${ctxLayers}L thesis:${thesis ? 'y' : 'n'} clutch:${clutchData ? 'y' : 'n'} odds:${odds ? 'y' : 'n'} tp:${clientCtx?.throughput ? 'y' : 'n'} ls:${clientCtx?.leadSafety ? 'y' : 'n'} pbp:${clientCtx?.pbpAudit ? 'y' : 'n'} arrows:${clientCtx?.subMetricArrows ? 'y' : 'n'})`);

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) { log(`${matchup}: ${triggerTag} CAL — ANTHROPIC_API_KEY not configured`); return; }

    // Build user prompt from payload sections via formatSonnetPrompt
    // Fetch quarter_data from DB for per-quarter breakdown
    let quarterDataFromDB = null;
    try {
      const qdRows = await sql`SELECT quarter_data FROM games WHERE id = ${game.id}`;
      if (qdRows.length > 0 && qdRows[0].quarter_data) {
        const qd = typeof qdRows[0].quarter_data === 'string' ? JSON.parse(qdRows[0].quarter_data) : qdRows[0].quarter_data;
        if (qd.diffs) quarterDataFromDB = qd.diffs;
      }
    } catch (e) { /* quarter_data not available */ }

    // Build position tracking context from live_tracking (passed as parameter — no stale DB read)
    let graduationCtx = null;
    try {
      if (lt && lt.bwc_fired) {
          graduationCtx = {
            bwcTeam: lt.bwc_fired.team,
            bwcFirePeriod: lt.bwc_fired.period,
            bwcFireFloor: lt.bwc_fired.floor,
            bwcState: lt.bwc_state || null,
            positionClosed: lt.position_closed || false,
            pregameML: lt.pregame_ml || null,
            lane: lt.lane || null,
            compoundTier: lt.compound_tier || 'TRACKING',
            compoundHolds: lt.compound_holds || 0,
            compoundPath: lt.compound_path || null,
            mcCumAtConfirmation: lt.compound_mc_at_confirm || null,
            cpCtrlFlips: lt.cp_ctrl_flips || 0,
            ctrlFlips: lt.ctrl_flips || 0,
            bwcFlipped: lt.bwc_flipped || false,
            originalBwcTeam: lt.original_bwc_team || null,
            mfTrajectory: computeMFTrajectory(lt.checkpoints || [], lt.bwc_fired.team),
          };
      }
    } catch (e) { /* non-fatal */ }

    // Fetch prior alert trail
    let priorAlertTrail = null;
    try {
      const alertRows = await sql`SELECT alert_type, alert_tier, period, clock, floor_score, margin, is_trailing,
        ctrl_sust, opp_sust, agent_decision, agent_reasoning, conviction_tier, conviction_combo, edge, tp_class, control_team
        FROM alerts WHERE game_id = ${game.id}
          AND NOT (alert_type = 'AUTO_ANALYSIS' AND agent_decision = 'SUPPRESS')
        ORDER BY ts DESC LIMIT 5`;
      if (alertRows.length > 0) {
        priorAlertTrail = alertRows.map(a => {
          let line = `${a.alert_type}${a.alert_tier ? '['+a.alert_tier+']' : ''} Q${a.period} ${a.clock}: `
            + `${a.control_team || '?'} floor ${Number(a.floor_score).toFixed(2)}, margin ${a.margin} ${a.is_trailing ? 'trailing' : 'leading'}, `
            + `sust ${a.ctrl_sust}/${a.opp_sust}`;
          if (a.conviction_tier) line += `, conv ${a.conviction_tier}(${a.conviction_combo || '?'})`;
          if (a.edge != null) line += `, edge ${a.edge > 0 ? '+' : ''}${Number(a.edge).toFixed(1)}%`;
          if (a.tp_class) line += `, TP ${a.tp_class}`;
          if (a.agent_decision) line += ` \u2192 ${a.agent_decision}`;
          if (a.agent_reasoning) line += `: ${a.agent_reasoning.substring(0, 120)}`;
          return line;
        }).join('\n');
      }
    } catch (e) { /* non-fatal */ }

    // Build team calibration prompt section

    const calConviction = computeConviction(ind, league);

    // XGB for analysis prompt (computed locally — poll-loop _xgb* vars are out of scope)
    const _caXgbFeatures = extractXGBFeatures(summary, ind, null, period, clock, null, league);
    const _caXgbWinProb = _caXgbFeatures ? predictXGB(_caXgbFeatures, league) : null;
    const _caXgbDivergence = _caXgbWinProb != null ? Math.round((_caXgbWinProb - ind.score) * 1000) / 1000 : null;
    const _caXgbAligned = _caXgbWinProb != null ? Math.abs(_caXgbWinProb - ind.score) < 0.15 : null;
    const _caXgbShap = _caXgbFeatures ? computeXGBContributions(_caXgbFeatures, league) : null;
    const _caConvQuality = _caXgbShap ? computeConvictionQuality(_caXgbShap, league) : null;
    const _caTrajSignals = _caXgbShap ? computeTrajectorySignals(_caXgbShap, lt.checkpoints || [], _caConvQuality, _caXgbWinProb, league) : null;

    const userPrompt = formatSonnetPrompt({
      hA, aA, period, clock, score: scoreLine, league,
      thesis: thesis || null,
      sust, leadComp, ind, clutchData, odds, espnWP, wpProfiles, analysisHistory,
      ctx: clientCtx || {},
      quarterDataFromDB,
      summary,
      conviction: calConviction,
      graduationCtx,
      priorAlertTrail,
      floorWP: ind ? lookupFloorWP(_floorWPCoeffs, ind.controlTeam, ind.score) : null,
      xgbData: { winProb: _caXgbWinProb, divergence: _caXgbDivergence, aligned: _caXgbAligned, shap: _caXgbShap, convictionQuality: _caConvQuality, trajectorySignals: _caTrajSignals },
      mcData: { mcWinProb: lt.mc_trajectory_wp || null, mcCumWp: lt.mc_cum_wp || null, mcDrivers: lt.mc_drivers || null, investigation: lt.mc?.triggered ? lt.mc : null },
    });

    // ── Compute prompt layer inventory for diagnostics ──
    const ctx = clientCtx || {};
    const layerInventory = [
      thesis ? 'thesis' : null,
      // calibration + teamCal DISABLED — re-accumulating after parity fix
      sust ? 'sust' : null,
      leadComp ? 'leadComp' : null,
      ind ? 'ind' : null,
      clutchData ? 'clutch' : null,
      odds ? 'odds' : null,
      espnWP ? 'espnWP' : null,
      wpProfiles ? 'wpProfiles' : null,
      analysisHistory ? 'history' : null,
      quarterDataFromDB ? 'quarterData' : null,
      ctx.rollingWindow?.available ? 'window' : null,
      ctx.acceleration ? 'accel' : null,
      ctx.combinedRead ? 'combinedRead' : null,
      ctx.pbpAudit ? 'pbp' : null,
      ctx.subMetricArrows ? 'arrows' : null,
      ctx.adjustment ? 'adjustment' : null,
      (ctx.volumeThreat?.home?.active || ctx.volumeThreat?.away?.active) ? 'volumeThreat' : null,
      ctx.throughput ? 'tp' : null,
      ctx.leadSafety ? 'ls' : null,
      ctx.mip ? 'mip' : null,
      ctx.bonusStatus ? 'bonus' : null,
      ctx.gameMeta ? 'gameMeta' : null,
      ctx.edgeHistory ? 'edgeHistory' : null,
      ctx.trackingData ? 'tracking' : null,
      graduationCtx ? 'graduation' : null,
      priorAlertTrail ? 'alertTrail' : null,
    ].filter(Boolean);
    if (composeTeamContext(hA, aA, league)) layerInventory.push('teamCtx');   // Jul 15: audit visibility — layer list previously omitted teamCtx (WSH@TOR forensics)
    const contextLayersStr = `${layerInventory.length}L: ${layerInventory.join(',')}`;
    const promptChars = userPrompt.length;
    log(`${matchup}: ${triggerTag} PROMPT — ${contextLayersStr} | ${promptChars} chars`);

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 2500,
        system: getSonnetSystemPrompt(league),
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      log(`${matchup}: ${triggerTag} CAL — Anthropic ${anthropicResp.status}: ${errText.substring(0, 200)}`);
      return;
    }

    const anthropicData = await anthropicResp.json();
    const analysisText = anthropicData.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!analysisText || analysisText.length < 20) {
      log(`${matchup}: ${triggerTag} CAL — Sonnet returned empty analysis`);
      return;
    }
    const result = { analysis: analysisText, usage: anthropicData.usage };

    // ── 8. Parse structured fields from Sonnet response ──
    const parsed = parseAnalysisText(result.analysis, hA, aA);

    // ── 9. Save analysis to DB with trigger tag + prompt diagnostics ──
    try {
      await sql`
        INSERT INTO analyses (game_id, period, clock, control_team, control_score,
          fwp, edge, entry, conviction, signal, sustainability, lead_source, raw_text,
          prediction_json, indicators_json, "trigger", home_pts, away_pts,
          context_layers, prompt_chars, conviction_tier, conviction_combo)
        VALUES (${game.id}, ${period}, ${clock}, ${parsed.controlTeam || ind.controlTeam}, ${parsed.controlScore || ind.score},
          ${parsed.fwp}, ${parsed.edge}, ${parsed.entry}, ${parsed.conviction || calConviction.tier}, ${parsed.signal},
          ${parsed.sustainability}, ${parsed.leadSource}, ${result.analysis},
          ${parsed.predictionJson ? JSON.stringify(parsed.predictionJson) : null},
          ${parsed.indicatorsJson ? JSON.stringify(parsed.indicatorsJson) : null},
          ${triggerTag}, ${ind.homePts || null}, ${ind.awayPts || null},
          ${contextLayersStr}, ${promptChars}, ${calConviction.tier}, ${calConviction.combo})
      `;
    } catch (e) {
      log(`${matchup}: ${triggerTag} CAL — analysis save failed: ${e.message}`);
    }

    log(`${matchup}: ★ ${triggerTag.toUpperCase()} CALIBRATION COMPLETE — conv:${calConviction.tier}(${calConviction.combo}) | FWP: ${parsed.fwp || '?'}${parsed.risk ? ' | Risk: ' + parsed.risk.substring(0, 60) : ''}`);

    // ── 10. Route through alert agent (unified path — no independent ntfy push) ──
    // Agent decides BUY or WATCH based on mechanical conviction + Sonnet context
    // PHASE 1: WNBA legacy alerts off → skip the position-update agent flow
    // (2nd runAlertAgent Opus call + UPDATE/WATCH ntfy). The 2500-tok analysis
    // above is already store-only and is unaffected.
    if (!(WNBA_LEGACY_ALERTS_OFF && league === 'wnba') && calConviction.tier !== 'NO ENTRY' && ind.score >= 0.55) {
      try {
        const margin = Math.abs((ind.homePts || 0) - (ind.awayPts || 0));
        const ctrlIsHome = ind.controlTeam === hA;
        const ctrlPts = ctrlIsHome ? ind.homePts : ind.awayPts;
        const oppPts = ctrlIsHome ? ind.awayPts : ind.homePts;
        const ctrlTrailing = ctrlPts < oppPts;
        const tpClass = clientCtx?.throughput?.classification || null;
        const lsClass = clientCtx?.leadSafety?.classification || null;
        const ctrlSust = sust?.[ctrlIsHome ? 'home' : 'away']?.tier || null;
        const oppSust = sust?.[ctrlIsHome ? 'away' : 'home']?.tier || null;

        // Compute edge/ML from odds (same as mechanical alert path)
        let aaEdge = null, aaML = null;
        if (odds && (odds.homeML || odds.awayML)) {
          aaML = ctrlIsHome ? odds.homeML : odds.awayML;
          const aaMIP = mlToProb(aaML);
          if (aaMIP != null) {
            aaEdge = (ind.score * 100) - (aaMIP * 100);
            aaEdge = Math.round(aaEdge * 10) / 10;
          }
        }

        // ── 10a. POSITION GATE — auto-analysis only sends as position updates ──
        // Query for most recent SENT actionable alert for this game
        const POSITION_TYPES = ['BUY', 'BUY WINDOW CLOSING', 'MC_COLLAPSE', 'TRACKING_INVALIDATED', 'POSITION_OPEN', 'BWC_EDGE', 'VALUE', 'EXIT', 'THESIS_ALIVE', 'POSITION_RECOVERING', 'POSITION_SAFE'];
        let priorPosition = null;
        try {
          const priorRows = await sql`
            SELECT alert_type, period, clock, control_team, floor_score, margin,
              is_trailing, edge, ml, conviction_tier, conviction_combo, ts,
              ctrl_sust, opp_sust, agent_reasoning
            FROM alerts
            WHERE game_id = ${game.id} AND ntfy_sent = true
              AND alert_type = ANY(${POSITION_TYPES})
            ORDER BY ts DESC LIMIT 1`;
          if (priorRows.length > 0) priorPosition = priorRows[0];
        } catch (e) { /* non-fatal — fall back to suppress */ }

        if (!priorPosition) {
          // No prior actionable position — suppress without calling agent (save Sonnet API call)
          const aaReasoning = 'No prior actionable alert sent for this game — auto-analysis suppressed (position gate)';
          try {
            await sql`INSERT INTO alerts (game_id, league, alert_type, period, clock, control_team, floor_score, margin, is_trailing, edge, ml, spread, tp_class, ls_class, ctrl_sust, opp_sust, window_score, alert_tier, agent_decision, agent_reasoning, i1, i2, i3, i4, i5, conviction_tier, conviction_combo, ntfy_sent, position_team)
              VALUES (${game.id}, ${league}, ${'AUTO_ANALYSIS'}, ${period}, ${clock}, ${ind.controlTeam}, ${ind.score}, ${margin}, ${ctrlTrailing}, ${aaEdge}, ${aaML ? parseInt(aaML) : null}, ${odds?.homeSpread ? parseFloat(odds.homeSpread) : null}, ${tpClass}, ${lsClass}, ${ctrlSust}, ${oppSust}, ${clientCtx?.rollingWindow?.score ?? null}, ${'ANALYSIS'}, ${'SUPPRESS'}, ${aaReasoning}, ${ctrlI(ind)[0]}, ${ctrlI(ind)[1]}, ${ctrlI(ind)[2]}, ${ctrlI(ind)[3]}, ${ctrlI(ind)[4]}, ${calConviction.tier}, ${calConviction.combo}, ${false}, ${ind.controlTeam})`;
          } catch (e) { log(`${matchup}: ${triggerTag} position-gate alert save failed: ${e.message}`); }
          log(`${matchup}: ${triggerTag} suppressed — no prior actionable position`);
        } else {
        // Prior position exists — route through agent as position update
        const priorMinutesSince = Math.round((Date.now() - new Date(priorPosition.ts).getTime()) / 60000);

        // Gather agent context (floor history + prior alerts)
        const agentCtx = await gatherAgentContext(sql, game.id, matchup);

        const agentResult = await runAlertAgent({
          alertType: 'AUTO_ANALYSIS', alertTier: 'ANALYSIS',
          homeAlias: hA, awayAlias: aA, league,
          controlTeam: ind.controlTeam, floor: ind.score.toFixed(2),
          margin, isTrailing: ctrlTrailing,
          period, clock, minsLeft: (period <= 4 ? ((4 - period) * 12 + parseFloat(clock?.split(':')[0] || 0)) : parseFloat(clock?.split(':')[0] || 0)).toFixed(1),
          score: `${aA} ${ind.awayPts}-${ind.homePts} ${hA} · Q${period} ${clock}`,
          edge: aaEdge, ml: aaML, spread: odds?.homeSpread || null,
          tpClass, lsClass, ctrlSust, oppSust: oppSust,
          windowScore: clientCtx?.rollingWindow?.score || null,
          xgbWinProb: _caXgbWinProb != null ? Math.round(_caXgbWinProb * 1000) / 1000 : null,
          xgbDivergence: _caXgbDivergence,
          xgbAligned: _caXgbAligned,
          xgbShap: _caXgbShap,
          convictionQuality: _caConvQuality,
          trajectorySignals: _caTrajSignals,
          convictionTier: calConviction.tier, convictionCombo: calConviction.combo,
          convictionPairs: calConviction.pairs?.join(', ') || '',
          i1: ctrlI(ind)[0]?.toFixed(2),
          i2: ctrlI(ind)[1]?.toFixed(2),
          i3: ctrlI(ind)[2]?.toFixed(2),
          i4: ctrlI(ind)[3]?.toFixed(2),
          i5: ctrlI(ind)[4]?.toFixed(2),
          indicatorsWon: calConviction.count,
          indWon: calConviction.indicatorsWon?.join('+') || '',
          indLost: calConviction.indicatorsLost?.join('+') || '',
          i4Decisive: calConviction.indicatorsWon?.includes('I4') || calConviction.indicatorsLost?.includes('I4'),
          i4Won: calConviction.indicatorsWon?.includes('I4'),
          i4Combo: calConviction.indicatorsWon?.includes('I4') && calConviction.count >= 2,
          floorHistory: agentCtx.floorHistory,
          priorAlerts: agentCtx.priorAlerts,
          quarterSummary: agentCtx.quarterSummary,
          learningsContext: agentCtx.learningsContext,
          // Sonnet context for enriched alert body
          sonnetFWP: parsed.fwp,
          sonnetNarrative: parsed.narrative,
          sonnetRisk: parsed.risk,
          sonnetDisagreement: parsed.disagreement,
          triggerType: 'auto_analysis',
          // Position update context
          priorPosition: priorPosition ? {
            alertType: priorPosition.alert_type,
            controlTeam: priorPosition.control_team,
            floor: Number(priorPosition.floor_score).toFixed(2),
            margin: priorPosition.margin,
            isTrailing: priorPosition.is_trailing,
            period: priorPosition.period,
            clock: priorPosition.clock,
            conviction: priorPosition.conviction_tier,
            combo: priorPosition.conviction_combo,
            ctrlSust: priorPosition.ctrl_sust,
            oppSust: priorPosition.opp_sust,
            minutesSince: priorMinutesSince,
            sameTeam: priorPosition.control_team === ind.controlTeam,
          } : null,
        });

        const aaDecision = agentResult?.decision || 'SUPPRESS';
        const aaReasoning = agentResult?.reasoning || '';

        // Check if mechanical alert already sent for this game+period (dedup ntfy)
        let mechAlreadySent = false;
        try {
          const mechCheck = await sql`SELECT 1 FROM alerts WHERE game_id = ${game.id} AND period = ${period} AND alert_type != 'AUTO_ANALYSIS' AND agent_decision IN ('SEND', 'DOWNGRADE', 'FALLBACK_SEND') LIMIT 1`;
          mechAlreadySent = mechCheck.length > 0;
        } catch (e) { /* non-fatal */ }

        // Determine if ntfy will actually send
        const aaNtfySent = (aaDecision === 'SEND' || aaDecision === 'DOWNGRADE') && !mechAlreadySent;

        // Always INSERT to alerts table for accuracy tracking
        try {
          await sql`INSERT INTO alerts (game_id, league, alert_type, period, clock, control_team, floor_score, margin, is_trailing, edge, ml, spread, tp_class, ls_class, ctrl_sust, opp_sust, window_score, alert_tier, agent_decision, agent_reasoning, i1, i2, i3, i4, i5, conviction_tier, conviction_combo, ntfy_sent, position_team, xgb_win_prob, xgb_aligned)
            VALUES (${game.id}, ${league}, ${'AUTO_ANALYSIS'}, ${period}, ${clock}, ${ind.controlTeam}, ${ind.score}, ${margin}, ${ctrlTrailing}, ${aaEdge}, ${aaML ? parseInt(aaML) : null}, ${odds?.homeSpread ? parseFloat(odds.homeSpread) : null}, ${tpClass}, ${lsClass}, ${ctrlSust}, ${oppSust}, ${clientCtx?.rollingWindow?.score ?? null}, ${'ANALYSIS'}, ${aaDecision}, ${aaReasoning}, ${ctrlI(ind)[0]}, ${ctrlI(ind)[1]}, ${ctrlI(ind)[2]}, ${ctrlI(ind)[3]}, ${ctrlI(ind)[4]}, ${calConviction.tier}, ${calConviction.combo}, ${aaNtfySent}, ${ind.controlTeam}, ${_caXgbWinProb != null ? Math.round(_caXgbWinProb * 10000) / 10000 : null}, ${_caXgbAligned})`;
        } catch (e) { log(`${matchup}: ${triggerTag} alert save failed: ${e.message}`); }

        if (aaDecision === 'SEND') {
          if (mechAlreadySent) {
            log(`${matchup}: ${triggerTag} agent SEND — ntfy suppressed (mechanical alert already sent Q${period})`);
          } else {
            const scoreLine = `${aA} ${ind.awayPts}-${ind.homePts} ${hA} · Q${period} ${clock}`;
            // Position-update title and body
            const pp = priorPosition;
            const sameTeam = pp.control_team === ind.controlTeam;
            const floorDelta = ind.score - Number(pp.floor_score);
            const statusWord = !sameTeam ? 'At Risk' : floorDelta > 0.1 ? 'Improving' : floorDelta < -0.1 ? 'Fading' : 'Holding';
            const _alertReadable = {'POSITION_OPEN':'Position Open','BWC_EDGE':'Lead Compressing','VALUE':'Entry Value','EXIT':'Exit','THESIS_ALIVE':'Second Chance','POSITION_RECOVERING':'Strengthening','POSITION_SAFE':'Position Safe','BUY':'Buy','BUY WINDOW CLOSING':'Buy Window Closing','MC_COLLAPSE':'Structural Stress','TRACKING_INVALIDATED':'Tracking Invalidated'}[pp.alert_type] || pp.alert_type;
            const ntfyTitle = `UPDATE: Your Q${pp.period} ${_alertReadable} on ${pp.control_team} is ${statusWord}`;
            // Agent writes the body via BODY: response, use it if available
            const agentBody = agentResult?.body || '';
            const ntfyBody = scoreLine
              + (agentBody ? `\n${agentBody}` : (
                `\nYour Q${pp.period} ${pp.alert_type} position`
                + (sameTeam ? `: floor ${Number(pp.floor_score).toFixed(2)} -> ${ind.score.toFixed(2)}, ${statusWord.toLowerCase()}`
                  : `: control shifted to ${ind.controlTeam} — position at risk`)
                + (parsed.risk && parsed.risk !== 'NONE' ? `\nRisk: ${parsed.risk}` : '')
              ))
              + `\n[position update · ${triggerTag}]`;
            await sendNtfy(ntfyTitle, ntfyBody, calConviction.tier === 'DOMINANT' ? 5 : 4);
            log(`${matchup}: ${triggerTag} position update SEND — ${statusWord} (prior: ${pp.alert_type} Q${pp.period})`);
          }
        } else if (aaDecision === 'DOWNGRADE') {
          if (mechAlreadySent) {
            log(`${matchup}: ${triggerTag} agent WATCH — ntfy suppressed (mechanical alert already sent Q${period})`);
          } else {
            const scoreLine = `${aA} ${ind.awayPts}-${ind.homePts} ${hA} · Q${period} ${clock}`;
            const pp = priorPosition;
            const _alertReadableW = {'POSITION_OPEN':'Position Open','BWC_EDGE':'Lead Compressing','VALUE':'Entry Value','EXIT':'Exit','THESIS_ALIVE':'Second Chance','POSITION_RECOVERING':'Strengthening','POSITION_SAFE':'Position Safe','BUY':'Buy','BUY WINDOW CLOSING':'Buy Window Closing','MC_COLLAPSE':'Structural Stress','TRACKING_INVALIDATED':'Tracking Invalidated'}[pp.alert_type] || pp.alert_type;
            const ntfyTitle = `WATCH: Your Q${pp.period} ${_alertReadableW} on ${pp.control_team} Needs Attention`;
            const agentBody = agentResult?.body || '';
            const ntfyBody = scoreLine
              + (agentBody ? `\n${agentBody}` : `\nYour Q${pp.period} position needs attention`)
              + `\n[position update · ${triggerTag}]`;
            await sendNtfy(ntfyTitle, ntfyBody, 3);
            log(`${matchup}: ${triggerTag} position update WATCH — ${aaReasoning}`);
          }
        } else {
          log(`${matchup}: ${triggerTag} agent silent — ${aaReasoning || 'no signal'}`);
        }
        } // ← close prior position else block
      } catch (e) {
        log(`${matchup}: ${triggerTag} agent routing failed: ${e.message}`);
      }
    }
  } catch (e) {
    log(`${matchup}: ${triggerTag} CAL ERROR — ${e.message}`);
  }
}

// ── MAIN HANDLER ────────────────────────────────────────────────────────────

export default async function(req) {
  const startTime = Date.now();

  // ── TEST MODE: verify ntfy pipeline end-to-end ──
  const url = new URL(req.url, 'https://localhost');
  if (url.searchParams.get('test_ntfy') === '1') {
    const topic = process.env.NTFY_TOPIC;
    const result = { test: true, version: 'v2-server-rich-ctx', ntfy_topic: topic ? 'SET' : 'MISSING', topic_value: topic || null,
      hasFunctions: { computeThroughputServer: typeof computeThroughputServer, formatSonnetPrompt: typeof formatSonnetPrompt, computeSwingCoreServer: typeof computeSwingCoreServer, fetchTrackingData: typeof fetchTrackingData } };
    if (topic) {
      try {
        await sendNtfy('DFT Server Alert Test', 'If you see this, server alerts are working!\nTimestamp: ' + new Date().toISOString(), 3);
        result.status = 'sent';
      } catch (e) {
        result.error = e.message;
      }
    }
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Get DB connection
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    log('ERROR: DATABASE_URL not configured');
    return new Response('DATABASE_URL not configured', { status: 500 });
  }
  const sql = neon(dbUrl);

  // ── NARRATION V2 on-demand brief (D-9a): ?ss_brief=<gameId> — generate NOW, upsert
  // GAME_BRIEF row (replaces stored text on regenerate), push, return JSON. Blocking is
  // fine: manual invocation, not the cron path.
  if (url.searchParams.get('ss_brief')) {
    const gameId = url.searchParams.get('ss_brief');
    try {
      const g = await sql`SELECT id, home_alias, away_alias FROM games WHERE id = ${gameId} AND league = ${'wnba'}`;
      const norm = (al) => ((LEAGUES.wnba && LEAGUES.wnba.aliasMap) || {})[al] || al;
      let hA = null, aA = null;
      if (g[0]) { hA = norm(g[0].home_alias); aA = norm(g[0].away_alias); }
      else {
        // CTX_FIX (Jul 23): pregame the games row doesn't exist yet (first in-window live
        // poll creates it) — resolve from poll_state.schedule_json so briefs can be
        // (re)generated before tip. 404 only if both sources miss.
        try {
          const ps = await sql`SELECT schedule_json FROM poll_state WHERE league = ${'wnba'} ORDER BY date DESC LIMIT 1`;
          const sched = ps[0] && ps[0].schedule_json ? (typeof ps[0].schedule_json === 'string' ? JSON.parse(ps[0].schedule_json) : ps[0].schedule_json) : [];
          const ent = (Array.isArray(sched) ? sched : []).find((x) => x && String(x.id) === String(gameId));
          if (ent && ent.home_alias && ent.away_alias) { hA = norm(ent.home_alias); aA = norm(ent.away_alias); }
        } catch (e) { /* fall through to 404 */ }
      }
      if (!hA || !aA) return new Response(JSON.stringify({ ok: false, error: 'game not found (wnba)' }), { status: 404 });
      await ensureTeamCtx(sql, 'wnba');
      // live line: latest snapshot if the game is underway
      let liveLine = '';
      try {
        const sn = await sql`SELECT period, clock, home_pts, away_pts FROM snapshots WHERE game_id = ${gameId} ORDER BY id DESC LIMIT 1`;
        if (sn[0]) liveLine = `currently ${aA} ${sn[0].away_pts} - ${hA} ${sn[0].home_pts}, Q${sn[0].period} ${sn[0].clock}`;
      } catch (e) { /* pregame */ }
      const prompt = ssBuildBriefPrompt(hA, aA, { teamCtx: composeTeamContext(hA, aA, 'wnba'), liveLine });
      const res = await ssCallNarration(prompt, 'claude-fable-5', SS_NARRATE_TIMEOUT_MS);
      const out = res.ok ? res : await ssCallNarration(prompt, 'claude-opus-4-8', SS_NARRATE_TIMEOUT_MS);
      if (!out.ok) return new Response(JSON.stringify({ ok: false, error: out.error }), { status: 502 });
      await sql`INSERT INTO sweetspot_alerts (game_id, league, alert_subtype, alert_tier, narration_text, narration_attempts, ntfy_sent)
        VALUES (${gameId}, ${'wnba'}, ${'GAME_BRIEF'}, ${'BRIEF'}, ${out.text}, ${1}, ${true})
        ON CONFLICT (game_id, alert_subtype) DO UPDATE SET narration_text = EXCLUDED.narration_text,
          narration_attempts = COALESCE(sweetspot_alerts.narration_attempts, 0) + 1, ntfy_sent = true`;
      await sendNtfy(`GAME BRIEF ${aA} at ${hA}`, out.text, 2, SS_DASH_URL);
      return new Response(JSON.stringify({ ok: true, gameId, brief: out.text }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
    }
  }

  // ── NARRATION V2 dry-run (§8): ?ss_narrate_test=<rowId> — full pipeline on a historical
  // row, NO push, NO DB write. Returns the assembled prompt + model output for review.
  if (url.searchParams.get('ss_narrate_test')) {
    const rowId = parseInt(url.searchParams.get('ss_narrate_test'));
    try {
      const r = await sql`SELECT * FROM sweetspot_alerts WHERE id = ${rowId}`;
      if (!r[0]) return new Response(JSON.stringify({ ok: false, error: 'row not found' }), { status: 404 });
      const { blocks } = await ssGatherNarrationBlocks(sql, r[0]);
      const prompt = r[0].alert_subtype === 'WATCHLIST'
        ? ssBuildWatchlistPrompt(r[0], blocks)   // D-12 — dry-run mirrors sweep routing
        : ssBuildNarrationPrompt(r[0], blocks);
      const t0 = Date.now();
      const model = url.searchParams.get('model') || 'claude-fable-5';
      const res = await ssCallNarration(prompt, model, SS_NARRATE_TIMEOUT_MS);
      return new Response(JSON.stringify({ ok: res.ok, rowId, model, latencyMs: Date.now() - t0,
        wordCount: res.ok ? res.text.split(/\s+/).filter(Boolean).length : null,
        error: res.error || null, narration: res.text || null, prompt }, null, 2),
        { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
    }
  }

  // ── SWEET-SPOT 2b FORCED TEST (TEMPORARY — remove after verifying the live path) ──
  // ?ss_force_test=1 fires ONE synthetic A alert end-to-end; ?ss_force_clear=1 deletes the test row.
  if (url.searchParams.get('ss_force_clear') === '1') {
    try { await sql`DELETE FROM sweetspot_alerts WHERE game_id = ${'SS_FORCE_TEST'}`; } catch (e) {}
    return new Response(JSON.stringify({ cleared: 'SS_FORCE_TEST' }), { headers: { 'Content-Type': 'application/json' } });
  }
  // Modes: 1 = A (no pctx) · 2 = A + synthetic pctx (§4c) · 3 = B (B1 cell) + pctx ·
  // 4 = GAP_BASE ledger row + pctx (assert ntfy_sent=false, digest present, NO push) ·
  // 5 = WATCHLIST + pctx (assert single priority-2 push, digest; sweep narration only
  //     when WNBA_SS_NARRATE_WATCHLIST=1 — SS_FORCE_TEST rows are excluded from the claim).
  // Suppression rules apply across modes on the same test game — run ss_force_clear=1
  // between sequences; recommended order: 5 → 3 → 4 (then 5 again to see the suppress).
  const _ftMode = url.searchParams.get('ss_force_test');
  if (['1', '2', '3', '4', '5'].includes(_ftMode)) {
    const _ft = { id: 'SS_FORCE_TEST' };
    const _fss = {
      subtype: 'EFG_FADE', tier: 'A', period: 3, clock: '5:42',
      leaderAl: 'CHI', trailerAl: 'ATL', leaderWP: 0.353, trailerWP: 0.706, gap: 0.353,
      leaderW: 6, leaderL: 11, trailerW: 12, trailerL: 5,
      leaderEfg: 71.3, leaderBand: 'red', varShare: 62, leadClass: 'VOLATILE',
      fadeTier: 'STRONG FADE', collapseTier: 'SHORT', collapseTrue: 0.61, pLow: 0.54, pHigh: 0.68,
      bestML: 180, bestBook: 'FanDuel', consensusML: 165, impliedBest: 0.357,
      edge: 0.253, kellySize: 0.071, margin: 6, books: 8,
    };
    if (_ftMode === '3') {
      // synthetic B — B1 cell (fade soft: LEAN FADE + VOLATILE), per spec §4
      _fss.subtype = 'EFG_FADE_SOFT'; _fss.tier = 'B'; _fss.softCell = 'B1';
      _fss.fadeTier = 'LEAN FADE';
    } else if (_ftMode === '4') {
      // synthetic GAP_BASE ledger row — base gates pass, fade/class fail A+B shapes
      _fss.subtype = 'GAP_BASE'; _fss.tier = null; _fss.ledgerOnly = true;
      _fss.fadeTier = 'NO FADE'; _fss.leadClass = 'STRUCTURAL';
    } else if (_ftMode === '5') {
      // synthetic WATCHLIST — band entry review cue; gate fields blank like a real early fire
      _fss.subtype = 'WATCHLIST'; _fss.tier = null; _fss.period = 2; _fss.clock = '3:10';
      _fss.fadeTier = null; _fss.collapseTier = null; _fss.collapseTrue = null;
      _fss.pLow = null; _fss.pHigh = null; _fss.edge = null; _fss.kellySize = null;
    }
    // modes 2-5: synthetic pctx — validates digest→prompt→row round-trip (§4c). ROLE carrier on
    // leader + STAR on trailer + one starter in foul trouble; baselines supplied (no BDL dep).
    let _fpctx = null;
    if (_ftMode !== '1') {
      const _mkP = (id, name, starter, pts, fgm, fga, fg3m, fg3a, ftm, fta, pf, min) => ({
        id, full_name: name, starter, played: true,
        statistics: { minutes: min, points: pts, field_goals_made: fgm, field_goals_att: fga,
          three_points_made: fg3m, three_points_att: fg3a, free_throws_made: ftm, free_throws_att: fta,
          personal_fouls: pf, pls_min: 0 },
      });
      _fpctx = {
        modelSummary: {
          home: { alias: 'CHI', players: [
            _mkP(990001, 'Test Rolecarry', true, 19, 7, 10, 4, 6, 1, 1, 1, '24'),
            _mkP(990002, 'Chi Second', true, 8, 4, 9, 0, 2, 0, 0, 3, '22:30'),
            _mkP(990003, 'Chi Third', true, 6, 3, 8, 0, 1, 0, 1, 1, '20'),
            _mkP(990004, 'Chi Bench', false, 5, 2, 5, 1, 2, 0, 0, 2, '12'),
          ] },
          away: { alias: 'ATL', players: [
            _mkP(990011, 'Test Star', true, 14, 6, 12, 1, 4, 1, 2, 1, '26'),
            _mkP(990012, 'Atl Second', true, 10, 4, 8, 2, 4, 0, 0, 4, '23'),
            _mkP(990013, 'Atl Bench', false, 8, 4, 6, 0, 1, 0, 0, 1, '14'),
          ] },
        },
        pbp: { raw: { shots: [
          { p: 'Test Rolecarry', tm: 'CHI', q: 2, m: 1, is3: true, z: 'above3', ctx: 'pullup' },
          { p: 'Test Rolecarry', tm: 'CHI', q: 3, m: 1, is3: true, z: 'above3', ctx: 'pullup' },
          { p: 'Test Rolecarry', tm: 'CHI', q: 3, m: 1, is3: true, z: 'wing3', ctx: '' },
          { p: 'Test Rolecarry', tm: 'CHI', q: 3, m: 1, is3: false, z: 'mid', ctx: 'pullup' },
          { p: 'Test Rolecarry', tm: 'CHI', q: 2, m: 1, is3: false, z: 'rim', ctx: 'driving layup' },
          { p: 'Chi Second', tm: 'CHI', q: 1, m: 1, is3: false, z: 'rim', ctx: 'layup' },
          { p: 'Test Star', tm: 'ATL', q: 2, m: 1, is3: false, z: 'rim', ctx: 'driving layup' },
        ] } },
        baselines: {
          'Test Rolecarry': { g: 18, ppg: 7.4, tsNorm: 0.51 },
          'Chi Second': { g: 20, ppg: 11.2, tsNorm: 0.54 },
          'Test Star': { g: 19, ppg: 21.3, tsNorm: 0.58 },
        },
      };
    }
    await fireSweetSpotAlert(sql, _ft, 'wnba', 'CHI', 'ATL', _fss, _fpctx);
    let _frows = [];
    try { _frows = await sql`SELECT id, alert_subtype, alert_tier, ntfy_sent, edge, line_used, line_consensus, carrier_name, carrier_identity, carrier_share, carrier_ppg, narration_text FROM sweetspot_alerts WHERE game_id = ${'SS_FORCE_TEST'} ORDER BY id`; } catch (e) {}
    const _ftExpect = { '1': '2 pushes (WHAT + WHY), no carrier cols', '2': '2 pushes + carrier cols', '3': '2 pushes (SWEET SPOT B, priority 4) + carrier cols', '4': 'NO push, ntfy_sent=false, carrier cols present, no narration', '5': '1 push (REVIEW, priority 2) + carrier cols, no narration' }[_ftMode];
    return new Response(JSON.stringify({ forced_test: `mode ${_ftMode} fired — expect: ${_ftExpect}. If no new row appeared, a suppression rule blocked it (run ss_force_clear=1 and re-order: 5 → 3 → 4).`, rows: _frows }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  // ── SWEETSPOT §4c DIGEST DIAG — ?ss_diag_pctx={bdl_game_id} returns the computed player
  // digest + prompt block for a live/recent WNBA game (no alert, no ntfy, read-only) ──
  const _dpGid = url.searchParams.get('ss_diag_pctx');
  if (_dpGid) {
    try {
      const _gR = await bdlFetch(`/wnba/v1/games/${_dpGid}`);
      const _gObj = _gR && _gR.data;
      if (!_gObj) return new Response(JSON.stringify({ error: `game ${_dpGid} not found` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const _psR = await bdlFetch(`/wnba/v1/player_stats?game_ids[]=${_dpGid}&per_page=100`);
      const _pRows = (_psR && _psR.data) || [];
      let _plays = [], _cur = null;
      for (let i = 0; i < 6; i++) {
        const _pr = await bdlFetch(`/wnba/v1/plays?game_id=${_dpGid}&per_page=100${_cur ? `&cursor=${_cur}` : ''}`);
        if (!_pr || !_pr.data) break;
        _plays = _plays.concat(_pr.data);
        _cur = _pr.meta && _pr.meta.next_cursor;
        if (!_cur) break;
      }
      const _dhA = _gObj.home_team && _gObj.home_team.abbreviation, _daA = _gObj.visitor_team && _gObj.visitor_team.abbreviation;
      const _dpbp = parseBDLPBPServer(_plays, _dhA, _daA);
      const _dmm = buildSummaryFromBDLPlayerStats(_pRows, _gObj, _dpbp);
      let _dhp = Number(_gObj.home_score) || 0, _dap = Number(_gObj.away_score) || 0;
      if (_dhp === 0 && _dap === 0) {
        for (const r of _pRows) {
          const _tA = r.team && r.team.abbreviation;
          if (_tA === _dhA) _dhp += Number(r.pts) || 0; else if (_tA === _daA) _dap += Number(r.pts) || 0;
        }
      }
      const _dper = Number(_gObj.period) || 4;
      const _dg = ssPlayerDigest(_dmm, _dhp >= _dap);
      if (!_dg) return new Response(JSON.stringify({ error: 'digest null (no players?)' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      const _dcar = (_dg.leader.top && _dg.leader.top[0]) || null;
      _dg.shot = { team: ssShotGeo(_dpbp, _dg.leader.alias, null, _dper), carrier: _dcar ? ssShotGeo(_dpbp, _dg.leader.alias, _dcar.name, _dper) : null };
      _dg.base = {};
      for (const bp of [..._dg.leader.top.slice(0, 2), ..._dg.trailer.top.slice(0, 1)]) {
        if (bp && bp.id) _dg.base[bp.name] = await ssCarrierBaseline(bp.id);
      }
      _dg.period = _dper;
      const _dcomp = ssComposeCtxBlock(_dg);
      return new Response(JSON.stringify({ game: `${_daA}@${_dhA}`, score: `${_dap}-${_dhp}`, period: _dper, cols: _dcomp.cols, prompt_block: _dcomp.text, digest: _dg }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  // ── WNBA POT BACKFILL — one-off manual action, never runs on cron ──
  // ?backfill_pot=1&batch=200&after=0&dry=1 — see backfillWNBAPot()
  if (url.searchParams.get('backfill_pot') === '1') {
    const result = await backfillWNBAPot(sql, {
      batch: Math.min(parseInt(url.searchParams.get('batch') || '200'), 500),
      after: parseInt(url.searchParams.get('after') || '0'),
      dry: url.searchParams.get('dry') === '1',
    });
    return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  // Load floor reliability coefficients (30 rows, once per poll cycle)
  _floorWPCoeffs = {};
  try {
    const fwpRows = await sql`SELECT team_alias, reliability_class, grip, close_floor_wp_json FROM floor_wp_coefficients WHERE league = 'nba' AND season = '2025-26'`;
    for (const r of fwpRows) {
      _floorWPCoeffs[r.team_alias] = {
        reliabilityClass: r.reliability_class || 'NEUTRAL',
        grip: r.grip || 0,
        closeFloorWP: r.close_floor_wp_json || {}
      };
    }
  } catch(e) { /* table may not exist yet — non-fatal */ }

  // ── TEST CONTEXT: diagnose server context computation ──
  if (url.searchParams.get('test_context') === '1') {
    try {
      const testGameId = url.searchParams.get('game_id');
      // Find a live game
      const gamesRows = await sql`SELECT id, matchup, home_alias, away_alias FROM games WHERE league = 'nba' ORDER BY created_at DESC LIMIT 10`;
      const targetGame = testGameId ? gamesRows.find(g => g.id.startsWith(testGameId)) : gamesRows[0];
      if (!targetGame) return new Response(JSON.stringify({ error: 'No games found' }), { headers: { 'Content-Type': 'application/json' } });

      const gid = targetGame.id;
      const hA = targetGame.home_alias, aA = targetGame.away_alias;

      // Get latest snapshot for summary-like data
      const snapRows = await sql`SELECT * FROM snapshots WHERE game_id = ${gid} ORDER BY ts DESC LIMIT 1`;
      const snap = snapRows.length > 0 ? snapRows[0] : null;

      // Build a minimal summary from BDL (same as poll loop would)
      const bdlKey = process.env.BDL_API_KEY;
      const d = today();
      const pad = n => String(n).padStart(2, '0');
      const dateStr = `${d.year}-${pad(d.month)}-${pad(d.day)}`;
      const boxResp = await bdlFetch(`/nba/v1/box_scores?date=${dateStr}`);
      const boxGames = boxResp?.data || [];
      
      // Find the matching BDL game
      const bdlGame = boxGames.find(bg => {
        const bh = bg.home_team?.abbreviation, ba = bg.away_team?.abbreviation;
        return (bh === hA && ba === aA) || (bh === aA && ba === hA);
      });

      if (!bdlGame) return new Response(JSON.stringify({ error: 'BDL game not found for ' + aA + '@' + hA, gamesAvailable: boxGames.length }), { headers: { 'Content-Type': 'application/json' } });

      // Parse PBP
      const playsResp = await bdlFetch(`/nba/v1/plays?game_id=${bdlGame.id}`);
      const _testCfg = LEAGUES['nba'];
      const pbpResult = parseBDLPBPServer(playsResp?.data || [], hA, aA);

      // Build summary
      const summary = buildSummaryFromBDLServer(bdlGame, pbpResult, null);
      const period = summary.quarter || bdlGame.period || 1;
      const clock = summary.clock || '';

      // Compute indicators + sustainability
      const ind = computeServer(summary, pbpResult, _seasonQ4Cache || {}, league);
      const sust = computeSustainability(summary, league);
      const leadComp = computeLeadComposition(summary);

      // Compute server context
      const game = { id: gid, _bdlPbp: pbpResult };
      const ctx = await computeServerContext(sql, game, 'nba', summary, ind, null, hA, aA, period, clock, aA + '@' + hA, sust, null);

      const result = {
        game: aA + '@' + hA,
        period, clock,
        score: `${aA} ${ind?.awayPts || '?'} - ${hA} ${ind?.homePts || '?'}`,
        contextLayers: ctx ? Object.keys(ctx).filter(k => ctx[k] != null) : [],
        layerCount: ctx ? Object.keys(ctx).filter(k => ctx[k] != null).length : 0,
        hasThroughput: !!ctx?.throughput,
        hasLeadSafety: !!ctx?.leadSafety,
        hasPbpAudit: !!ctx?.pbpAudit,
        hasArrows: !!ctx?.subMetricArrows,
        hasBonus: !!ctx?.bonusStatus,
        hasMip: !!ctx?.mip,
        hasGameMeta: !!ctx?.gameMeta,
        hasWindow: !!ctx?.rollingWindow?.available,
        hasTracking: !!ctx?.trackingData,
        throughputClass: ctx?.throughput?.classification || null,
        leadSafetyClass: ctx?.leadSafety?.classification || null,
      };

      // Generate prompt snippet
      if (ctx && ind) {
        const prompt = formatSonnetPrompt({
          hA, aA, period, clock, score: result.score, league,
          thesis: null,
          sust, leadComp, ind, clutchData: null, odds: null,
          espnWP: null, wpProfiles: null, analysisHistory: null,
          ctx, quarterDataFromDB: ctx.quarterDiffs || null, summary,
          conviction: computeConviction(ind, league),
          floorWP: ind ? lookupFloorWP(_floorWPCoeffs, ind.controlTeam, ind.score) : null,
          mcData: null,
        });
        result.promptLength = prompt.length;
        result.promptFirst500 = prompt.substring(0, 500);
        result.promptLast500 = prompt.substring(prompt.length - 500);
      }

      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, stack: (e.stack || '').substring(0, 500) }), { headers: { 'Content-Type': 'application/json' } });
    }
  }

  // ── BACKFILL PBP: fetch historical plays from BDL, save to game_pbp ──
  if (url.searchParams.get('action') === 'backfill_pbp') {
    const maxGames = parseInt(url.searchParams.get('max') || '500');
    const batchSize = parseInt(url.searchParams.get('batch') || '50');
    try {
      const force = url.searchParams.get('force') === '1';
      const boxOnly = url.searchParams.get('box_only') === '1'; // just add box_score_json to existing rows

      let allGames;
      if (boxOnly) {
        // Games that have PBP — include pbp_json for PBP-derived fields
        // force=1 re-processes all (ordered by oldest saved_at so freshly updated go last)
        // Limit to batchSize so each run processes a new set
        allGames = await sql`
          SELECT g.id, g.home_alias, g.away_alias, g.date, p.pbp_json
          FROM games g
          JOIN game_pbp p ON p.game_id = g.id
          WHERE g.league = 'nba' AND g.home_pts IS NOT NULL AND g.home_pts > 0
          AND (${force} OR p.box_score_json IS NULL)
          ORDER BY p.saved_at ASC, g.date ASC LIMIT ${batchSize}
        `;
      } else if (force) {
        allGames = await sql`
          SELECT g.id, g.home_alias, g.away_alias, g.date
          FROM games g
          LEFT JOIN game_pbp p ON p.game_id = g.id
          WHERE g.league = 'nba' AND g.home_pts IS NOT NULL AND g.home_pts > 0
          AND (p.game_id IS NULL OR p.pbp_json::text NOT LIKE '%scoreLog%' OR p.pbp_json::text NOT LIKE '%perQuarter%')
          ORDER BY g.date DESC LIMIT ${maxGames}
        `;
      } else {
        allGames = await sql`
          SELECT g.id, g.home_alias, g.away_alias, g.date
          FROM games g
          LEFT JOIN game_pbp p ON p.game_id = g.id
          WHERE g.league = 'nba' AND g.home_pts IS NOT NULL AND g.home_pts > 0
          AND p.game_id IS NULL
          ORDER BY g.date DESC LIMIT ${maxGames}
        `;
      }

      // Group by date for efficient BDL box_scores fetching
      const byDate = {};
      allGames.forEach(g => {
        if (!byDate[g.date]) byDate[g.date] = [];
        byDate[g.date].push(g);
      });

      // Helper: aggregate BDL player stats into team-level raw stats (mirrors raw_stats_json shape)
      function aggTeamStats(players, pbpSide, bdlObj) {
        const sum = (k) => (players || []).reduce((a, p) => a + (p[k] || 0), 0);
        return {
          stl: sum('stl'), blk: sum('blk'), oreb: sum('oreb'),
          to: sum('turnover'), fta: sum('fta'), ftm: sum('ftm'),
          fgm: sum('fgm'), fga: sum('fga'),
          fg3m: sum('fg3m'), fg3a: sum('fg3a'),
          fg2m: sum('fgm') - sum('fg3m'), fg2a: sum('fga') - sum('fg3a'),
          ast: sum('ast'), pts: sum('pts'), pf: sum('pf'),
          atRimM: pbpSide?.rim?.made || 0, atRimA: pbpSide?.rim?.att || 0,
          paintM: (pbpSide?.rim?.made || 0) + (pbpSide?.paint?.made || 0),
          paintA: (pbpSide?.rim?.att || 0) + (pbpSide?.paint?.att || 0),
          paint: ((pbpSide?.rim?.made || 0) + (pbpSide?.paint?.made || 0)) * 2,
          pot: bdlObj?.pot || 0, scp: bdlObj?.scp || 0,
          fbp: 0, fd: 0,
          bigLead: bdlObj?.biggestLead || 0,
          bench: 0, // can't easily derive without starter IDs
          poss: +(sum('fga') - sum('oreb') + sum('turnover') + 0.4 * sum('fta')).toFixed(1),
          oppp: 0, dppp: 0,
        };
      }

      let filled = 0, failed = 0, skipped = 0;
      const errors = [];
      // box_only+force: query already limited to batchSize and ordered by saved_at ASC for pagination
      const sortedDates = Object.keys(byDate).sort().reverse();

      for (const dateStr of sortedDates) {
        if (filled >= batchSize) break;
        const gamesOnDate = byDate[dateStr];

        // Fetch BDL box_scores for this date
        let boxGames = [];
        try {
          const boxResp = await bdlFetch(`/nba/v1/box_scores?date=${dateStr}`);
          boxGames = boxResp?.data || [];
        } catch (e) {
          errors.push(`${dateStr}: box_scores failed — ${e.message}`);
          continue;
        }
        await new Promise(r => setTimeout(r, 100));

        for (const game of gamesOnDate) {
          if (filled >= batchSize) break;
          const hA = game.home_alias, aA = game.away_alias;

          // Match to BDL game
          const bdlGame = boxGames.find(bg => {
            const bh = bg.home_team?.team?.abbreviation || bg.home_team?.abbreviation || '';
            const ba = bg.visitor_team?.team?.abbreviation || bg.visitor_team?.abbreviation || bg.away_team?.abbreviation || '';
            return (bh === hA && ba === aA);
          });

          if (!bdlGame) {
            skipped++;
            // Bump saved_at so this game rotates to end of queue
            try { await sql`UPDATE game_pbp SET saved_at = NOW() WHERE game_id = ${game.id}`; } catch(e) {}
            continue;
          }

          try {
            // Build box_score_json from BDL player data
            let pbpResult = null;
            let pbpSave = null;

            if (boxOnly) {
              // Read existing pbp_json for PBP-derived fields (paint, rim, biggest_lead, POT, runs6)
              try {
                const existingPbp = game.pbp_json ? (typeof game.pbp_json === 'string' ? JSON.parse(game.pbp_json) : game.pbp_json) : null;
                if (existingPbp) {
                  pbpResult = existingPbp; // has .home, .away, ._bdl, .runs6
                }
              } catch(e) { /* proceed without PBP data */ }
            } else {
              // Fetch plays for PBP
              const playsResp = await bdlFetch(`/nba/v1/plays?game_id=${bdlGame.id}&per_page=500`);
              const plays = playsResp?.data || [];
              if (plays.length < 10) { skipped++; continue; }
              pbpResult = parseBDLPBPServer(plays, league==='wnba'?(cfg.aliasMap[hA]||hA):hA, league==='wnba'?(cfg.aliasMap[aA]||aA):aA);
              pbpSave = {
                home: pbpResult.home, away: pbpResult.away,
                totalShots: pbpResult.totalShots, totalTOs: pbpResult.totalTOs,
                runs: pbpResult.runs, runs6: pbpResult.runs6,
                scoringEvents: pbpResult.scoringEvents,
                raw: pbpResult.raw,
                perQuarter: pbpResult.perQuarter,
                _bdl: pbpResult._bdl,
              };
            }

            // Aggregate box score stats
            const homePlayers = bdlGame.home_team?.players || [];
            const awayPlayers = bdlGame.visitor_team?.players || [];
            const bdlPbp = pbpResult?._bdl || pbpSave?._bdl || {};
            const boxStats = {
              home: aggTeamStats(homePlayers, pbpResult?.home, { pot: bdlPbp.potHome || 0, scp: bdlPbp.scpHome || 0, biggestLead: bdlPbp.biggestLeadHome || 0 }),
              away: aggTeamStats(awayPlayers, pbpResult?.away, { pot: bdlPbp.potAway || 0, scp: bdlPbp.scpAway || 0, biggestLead: bdlPbp.biggestLeadAway || 0 }),
              home_pts: bdlGame.home_team_score || 0,
              away_pts: bdlGame.visitor_team_score || 0,
              runs6: pbpResult?.runs6 ? { home: (pbpResult.runs6.filter ? pbpResult.runs6.filter(r=>r.team===hA).length : pbpResult.runs6.home || 0), away: (pbpResult.runs6.filter ? pbpResult.runs6.filter(r=>r.team===aA).length : pbpResult.runs6.away || 0), total: (Array.isArray(pbpResult.runs6) ? pbpResult.runs6.length : (pbpResult.runs6.total || 0)) } : null,
            };
            // Compute oppp/dppp
            if (boxStats.home.poss > 0) {
              boxStats.home.oppp = +(boxStats.home.pts / boxStats.home.poss).toFixed(2);
              boxStats.home.dppp = +(boxStats.away.pts / boxStats.home.poss).toFixed(2);
            }
            if (boxStats.away.poss > 0) {
              boxStats.away.oppp = +(boxStats.away.pts / boxStats.away.poss).toFixed(2);
              boxStats.away.dppp = +(boxStats.home.pts / boxStats.away.poss).toFixed(2);
            }
            const boxJson = JSON.stringify(boxStats);

            if (boxOnly) {
              // Just update box_score_json on existing row
              await sql`
                UPDATE game_pbp SET box_score_json = ${boxJson}, saved_at = NOW()
                WHERE game_id = ${game.id}
              `;
            } else {
              await sql`
                INSERT INTO game_pbp (game_id, league, home_alias, away_alias, total_shots, total_tos, pbp_json, box_score_json, saved_at)
                VALUES (${game.id}, ${'nba'}, ${hA}, ${aA}, ${pbpResult.totalShots || 0}, ${pbpResult.totalTOs || 0}, ${JSON.stringify(pbpSave)}, ${boxJson}, NOW())
                ON CONFLICT (game_id) DO UPDATE SET
                  pbp_json = ${JSON.stringify(pbpSave)}, box_score_json = ${boxJson},
                  total_shots = ${pbpResult.totalShots || 0},
                  total_tos = ${pbpResult.totalTOs || 0}, saved_at = NOW()
              `;
            }
            filled++;
          } catch (e) {
            failed++;
            errors.push(`${aA}@${hA} ${dateStr}: ${e.message}`);
          }
          await new Promise(r => setTimeout(r, 100));
        }
      }

      return new Response(JSON.stringify({
        filled, failed, skipped,
        remaining: Math.max(0, allGames.length - filled - skipped),
        total: allGames.length,
        errors: errors.slice(0, 10),
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { headers: { 'Content-Type': 'application/json' } });
    }
  }

  // ── DIAGNOSTIC MODE: time each section of the poll loop ──
  if (url.searchParams.get('diag') === '1') {
    const diag = { sections: [], ts: new Date().toISOString() };
    const _dt = (label, t0) => { const ms = Date.now() - t0; diag.sections.push({ label, ms }); return ms; };
    try {
      for (const league of Object.keys(LEAGUES)) {
        const cfg = LEAGUES[league];
        const apiKey = process.env[cfg.srKeyEnv];
        if (!apiKey) { diag.sections.push({ label: `${league}: no SR key — skip`, ms: 0 }); continue; }

        const d = today();
        const pad = n => String(n).padStart(2, '0');
        const dateKey = `${d.year}-${pad(d.month)}-${pad(d.day)}`;
        diag.sections.push({ label: `${league}: dateKey=${dateKey}`, ms: 0 });

        // S1: poll_state
        let t0 = Date.now();
        let pollState = null;
        try {
          const psRows = await sql`SELECT first_tip, last_tip, game_count, all_final, schedule_json FROM poll_state WHERE league = ${league} AND date = ${dateKey}`;
          if (psRows.length > 0) pollState = psRows[0];
        } catch(e) { diag.sections.push({ label: `${league}: poll_state error: ${e.message}`, ms: Date.now()-t0 }); continue; }
        _dt(`${league}: S1 poll_state`, t0);

        if (pollState?.all_final) { diag.sections.push({ label: `${league}: all_final — skip`, ms: 0 }); continue; }
        if (pollState?.game_count === 0) { diag.sections.push({ label: `${league}: no games — skip`, ms: 0 }); continue; }
        if (!pollState) { diag.sections.push({ label: `${league}: no poll_state row — would fetch schedule`, ms: 0 }); continue; }

        // Check time window
        const now = new Date();
        const windowStart = new Date(new Date(pollState.first_tip).getTime() - 15 * 60 * 1000);
        const windowEnd = new Date(new Date(pollState.last_tip).getTime() + 3 * 60 * 60 * 1000);
        if (now < windowStart) { diag.sections.push({ label: `${league}: before window`, ms: 0 }); continue; }
        if (now > windowEnd) { diag.sections.push({ label: `${league}: past window`, ms: 0 }); continue; }

        const cachedGames = typeof pollState.schedule_json === 'string' ? JSON.parse(pollState.schedule_json) : pollState.schedule_json;
        const potentiallyLive = cachedGames.filter(g => {
          if (g.status === 'closed' || g.status === 'complete') return false;
          if (!g.scheduled) return true;
          return new Date(g.scheduled) <= now;
        });
        diag.sections.push({ label: `${league}: ${cachedGames.length} cached, ${potentiallyLive.length} live`, ms: 0 });
        if (potentiallyLive.length === 0) { diag.sections.push({ label: `${league}: no live games`, ms: 0 }); continue; }

        // S2: ESPN scoreboard
        const dateStr = `${d.year}${pad(d.month)}${pad(d.day)}`;
        t0 = Date.now();
        const espnGames = await espnScoreboard(league, dateStr);
        _dt(`${league}: S2 ESPN scoreboard (${espnGames.length} events)`, t0);

        // S3: BDL game data
        const bdlDateStr = `${d.year}-${pad(d.month)}-${pad(d.day)}`;
        t0 = Date.now();
        const bdlData = await bdlGameData(league, bdlDateStr);
        _dt(`${league}: S3 BDL gameData (${Object.keys(bdlData.gameIds).length} games)`, t0);

        // S4: Season stats
        const teamAbbrs = new Set();
        for (const g of potentiallyLive) { if (g.home_alias) teamAbbrs.add(g.home_alias); if (g.away_alias) teamAbbrs.add(g.away_alias); }
        t0 = Date.now();
        const bdlSeasonCache = await getSeasonStatsForTeams(sql, league, cfg.season, teamAbbrs, bdlData.teamIds);
        _dt(`${league}: S4 seasonStats (${Object.keys(bdlSeasonCache).length} teams)`, t0);

        // S5: Clutch profiles
        t0 = Date.now();
        try {
          const _cpRows = await sql`SELECT * FROM clutch_profiles WHERE league = ${league} AND season = ${'2025'}`;
          _dt(`${league}: S5 clutchProfiles (${_cpRows.length} rows)`, t0);
        } catch(e) { _dt(`${league}: S5 clutchProfiles error: ${e.message}`, t0); }

        // S6: WNBA player_stats batch
        if (league === 'wnba') {
          const gids = potentiallyLive.map(g => {
            const hB = cfg.aliasMap?.[g.home_alias] || g.home_alias;
            const aB = cfg.aliasMap?.[g.away_alias] || g.away_alias;
            return bdlData.gameIds[`${aB}@${hB}`] || bdlData.gameIds[`${g.away_alias}@${g.home_alias}`];
          }).filter(Boolean);
          t0 = Date.now();
          try {
            const psResp = await bdlFetch(`${cfg.bdlPrefix}/v1/player_stats?${gids.map(id => 'game_ids[]=' + id).join('&')}&per_page=100`);
            const allPs = psResp?.data || [];
            _dt(`${league}: S6 playerStats (${allPs.length} records, gids=${gids.join(',')})`, t0);
          } catch(e) { _dt(`${league}: S6 playerStats error: ${e.message}`, t0); }
        }

        // S7: Plays fetches
        t0 = Date.now();
        const playsFetches = potentiallyLive.map(g => {
          const hB = cfg.aliasMap?.[g.home_alias] || g.home_alias;
          const aB = cfg.aliasMap?.[g.away_alias] || g.away_alias;
          const bgid = bdlData.gameIds[`${aB}@${hB}`] || bdlData.gameIds[`${g.away_alias}@${g.home_alias}`];
          if (!bgid) return Promise.resolve(null);
          return bdlFetch(`${cfg.bdlPrefix}/v1/plays?game_id=${bgid}&per_page=500`).catch(() => null);
        });
        await Promise.all(playsFetches);
        _dt(`${league}: S7 plays (${playsFetches.length} fetches)`, t0);

        // S8: Season Q4
        t0 = Date.now();
        await loadSeasonQ4(sql, league);
        _dt(`${league}: S8 seasonQ4`, t0);

        // S9: Odds API
        t0 = Date.now();
        await fetchOddsAPIBatch(league);
        _dt(`${league}: S9 oddsAPI`, t0);

        // S10: First game — step through processing (stop at diag_step param)
        const diagStep = parseInt(url.searchParams.get('diag_step') || '99');
        const g0 = potentiallyLive[0];
        if (g0) {
          const hA = g0.home_alias || 'HOME', aA = g0.away_alias || 'AWAY';
          const hB = cfg.aliasMap?.[hA] || hA, aB = cfg.aliasMap?.[aA] || aA;
          const bgid = bdlData.gameIds[`${aB}@${hB}`] || bdlData.gameIds[`${aA}@${hA}`] || bdlData.gameIds[`${g0.away_alias}@${g0.home_alias}`];
          diag.sections.push({ label: `${league}: S10 game ${aA}@${hA} bdlGid=${bgid} (stop@${diagStep})`, ms: 0 });
          if (diagStep < 1) { diag.sections.push({ label: 'stopped at step 0' }); break; }

          // Step 1: Get player stats + game obj
          t0 = Date.now();
          let _srSummary = null, bdlPlayers = [], bdlGameObj = null, fbPlays = [], fbPbp = null;
          try {
            if (league === 'wnba' && bgid) {
              const psResp2 = await bdlFetch(`${cfg.bdlPrefix}/v1/player_stats?game_ids[]=${bgid}&per_page=100`);
              bdlPlayers = (psResp2?.data || []).filter(p => p.game?.id === bgid);
              _dt(`${league}: step1a playerStats=${bdlPlayers.length}`, t0);
              if (bdlPlayers.length > 0 && diagStep >= 2) {
                const gameResp = await bdlFetch(`${cfg.bdlPrefix}/v1/games/${bgid}`);
                bdlGameObj = gameResp?.data || null;
                _dt(`${league}: step1b gameObj status=${bdlGameObj?.status} score=${bdlGameObj?.home_score}-${bdlGameObj?.away_score}`, t0);
              }
            }
          } catch(e) { diag.sections.push({ label: `step1 CRASH: ${e.message}`, ms: Date.now()-t0 }); }
          if (diagStep < 2) { diag.sections.push({ label: 'stopped at step 1' }); break; }

          // Step 2: Parse PBP
          t0 = Date.now();
          try {
            const playsResp = await bdlFetch(`${cfg.bdlPrefix}/v1/plays?game_id=${bgid}&per_page=500`);
            fbPlays = playsResp?.data || [];
            fbPbp = parseBDLPBPServer(fbPlays, cfg.aliasMap?.[hA]||hA, cfg.aliasMap?.[aA]||aA);
            _dt(`${league}: step2 pbp plays=${fbPlays.length}`, t0);
          } catch(e) { diag.sections.push({ label: `step2 CRASH: ${e.message}`, ms: Date.now()-t0 }); }
          if (diagStep < 3) { diag.sections.push({ label: 'stopped at step 2' }); break; }

          // Step 3: Build summary
          t0 = Date.now();
          try {
            if (bdlPlayers.length > 0 && bdlGameObj) {
              _srSummary = buildSummaryFromBDLPlayerStats(bdlPlayers, bdlGameObj, fbPbp);
              _dt(`${league}: step3 buildSummary ✓ homePts=${_srSummary?.home?.points} awayPts=${_srSummary?.away?.points}`, t0);
            }
          } catch(e) { diag.sections.push({ label: `step3 CRASH: ${e.message}`, ms: Date.now()-t0, stack: e.stack?.split('\n').slice(0,3) }); }
          if (diagStep < 4 || !_srSummary) { diag.sections.push({ label: `stopped at step 3 (summary=${!!_srSummary})` }); break; }

          // Step 4: computeServer
          t0 = Date.now();
          let ind = null;
          try {
            ind = computeServer(_srSummary, fbPbp, _seasonQ4Cache || {}, league);
            _dt(`${league}: step4 computeServer floor=${ind?.score} ctrl=${ind?.controlTeam}`, t0);
          } catch(e) { diag.sections.push({ label: `step4 CRASH: ${e.message}`, ms: Date.now()-t0, stack: e.stack?.split('\n').slice(0,3) }); }
          if (diagStep < 5) { diag.sections.push({ label: 'stopped at step 4' }); break; }

          // Step 5: extractXGBFeatures
          t0 = Date.now();
          try {
            const _wbl = _srSummary?.home?.statistics?.biggest_lead || 0;
            const _xf = extractXGBFeatures(_srSummary, ind, fbPbp, _srSummary?.quarter || 1, _srSummary?.clock || '', null, league, _wbl);
            const _xp = _xf ? predictXGB(_xf, league) : null;
            _dt(`${league}: step5 XGB prob=${_xp?.toFixed(3)} features=${_xf?.length}`, t0);
          } catch(e) { diag.sections.push({ label: `step5 XGB CRASH: ${e.message}`, ms: Date.now()-t0, stack: e.stack?.split('\n').slice(0,3) }); }
          if (diagStep < 6) { diag.sections.push({ label: 'stopped at step 5' }); break; }

          // Step 6: computeSustainability
          t0 = Date.now();
          try {
            const sust = computeSustainability(_srSummary, league);
            _dt(`${league}: step6 sust ctrl=${sust?.ctrl} opp=${sust?.opp}`, t0);
          } catch(e) { diag.sections.push({ label: `step6 sust CRASH: ${e.message}`, ms: Date.now()-t0, stack: e.stack?.split('\n').slice(0,3) }); }
        }

        diag.sections.push({ label: `${league}: ✓ all sections passed`, ms: 0 });
      }
    } catch(e) {
      diag.sections.push({ label: `CRASH: ${e.message}`, ms: 0, stack: e.stack?.split('\n').slice(0,5) });
    }
    diag.totalMs = Date.now() - startTime;
    return new Response(JSON.stringify(diag, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  const results = { games: 0, snapshots: 0, espn: 0, odds: 0, errors: [], skipped: null };
  const pendingAnalyses = []; // collect async Sonnet calls so we await them before returning

  let _leagueIdx = 0;
  for (const league of Object.keys(LEAGUES)) {
    // Stagger SR calls between leagues — 1 req/sec rate limit
    if (_leagueIdx > 0) await new Promise(r => setTimeout(r, 2000));
    _leagueIdx++;
    const cfg = LEAGUES[league];
    const apiKey = process.env[cfg.srKeyEnv];
    if (!apiKey) {
      continue;
    }

    // TEAM_PROFILES_SPEC §6 — load season profiles once per invocation (isolated SELECT,
    // wnba-only, no-op when TEAM_CTX_ON unset). Must precede game processing: agent and
    // auto-analysis prompt builders read the module map synchronously.
    await ensureTeamCtx(sql, league);

    const d = today();
    const pad = n => String(n).padStart(2, '0');
    const dateKey = `${d.year}-${pad(d.month)}-${pad(d.day)}`;

    try {
      // ── 0. Load poll_state from DB — do we even need to be awake? ──
      let pollState = null;
      try {
        const psRows = await sql`
          SELECT first_tip, last_tip, game_count, all_final, schedule_json
          FROM poll_state WHERE league = ${league} AND date = ${dateKey}
        `;
        if (psRows.length > 0) pollState = psRows[0];
      } catch (e) {
        // Table may not exist yet — proceed to fetch schedule
      }

      // ── 0a. Quick exits from cached state ──
      if (pollState) {
        if (pollState.all_final) {
          log(`${league.toUpperCase()}: all games FINAL — sleeping`);
          results.skipped = 'all_final';
          continue;
        }
        if (pollState.game_count === 0) {
          log(`${league.toUpperCase()}: no games today — sleeping`);
          results.skipped = 'no_games';
          continue;
        }
        const now = new Date();
        const windowStart = new Date(new Date(pollState.first_tip).getTime() - 15 * 60 * 1000);
        const windowEnd = new Date(new Date(pollState.last_tip).getTime() + 3 * 60 * 60 * 1000);
        if (now < windowStart) {
          if (league === 'wnba' && WNBA_GAME_BRIEF_ON && pollState?.schedule_json) {
            try { await ssSeedPregameBriefs(sql, pollState.schedule_json); await ssNarrationSweep(sql, startTime); } catch (e) { log(`pregame brief sweep: ${e.message}`); }
          }
          log(`${league.toUpperCase()}: before game window (first tip ${new Date(pollState.first_tip).toLocaleTimeString('en-US', {timeZone:'America/New_York'})} ET) — sleeping`);
          results.skipped = 'before_window';
          continue;
        }
        if (now > windowEnd) {
          log(`${league.toUpperCase()}: past game window — marking all_final`);
          try { await sql`UPDATE poll_state SET all_final = TRUE WHERE league = ${league} AND date = ${dateKey}`; } catch(e) {}
          results.skipped = 'past_window';
          continue;
        }
      }

      // PREGAME BRIEF SEEDING (Jul 15): mid-slate cycles seed later games' skeletons
      // hours before their tips; the end-of-cycle sweep fills them quietly (period-0).
      if (league === 'wnba' && WNBA_GAME_BRIEF_ON && pollState?.schedule_json) {
        try { await ssSeedPregameBriefs(sql, pollState.schedule_json); } catch (e) { log(`pregame brief seed: ${e.message}`); }
      }

      // ── 0b. Client heartbeat — logged but no longer skips server polling ──
      // BDL has 600 req/min — both client and server can poll simultaneously.
      // Server must always run for quarter-boundary calibration snapshots.

      // ── 1. Get game list — from cache OR one-time SR schedule fetch ──
      let cachedGames = null; // [{id, scheduled, home_alias, away_alias, status}]

      if (pollState && pollState.schedule_json) {
        // Use cached schedule — NO SR call (unless ESPN fallback was used)
        cachedGames = typeof pollState.schedule_json === 'string'
          ? JSON.parse(pollState.schedule_json)
          : pollState.schedule_json;
        // Detect ESPN-sourced schedule (numeric IDs) — retry SR for proper UUIDs
        // Only safe to swap IDs BEFORE any game data is stored (pre-first-tip)
        const _hasEspnIds = cachedGames.length > 0 && cachedGames.every(g => /^\d+$/.test(String(g.id)));
        const _allPreTip = cachedGames.every(g => g.status === 'scheduled');
        if (_hasEspnIds && _allPreTip) {
          log(`${league.toUpperCase()}: cached schedule has ESPN IDs (all pre-tip) — retrying SR`);
          try {
            const schedule = await srFetch(league, `games/${d.year}/${pad(d.month)}/${pad(d.day)}/schedule.json`);
            const srGames = schedule.games || [];
            if (srGames.length > 0) {
              cachedGames = srGames.map(g => ({
                id: g.id, scheduled: g.scheduled || null,
                home_alias: cfg.aliasMap?.[g.home?.alias] || g.home?.alias || '',
                away_alias: cfg.aliasMap?.[g.away?.alias] || g.away?.alias || '',
                home_name: g.home?.name || '', away_name: g.away?.name || '',
                status: (g.status || 'scheduled').toLowerCase(),
              }));
              const tips = cachedGames.filter(g => g.scheduled).map(g => new Date(g.scheduled)).sort((a, b) => a - b);
              const firstTip = tips.length > 0 ? tips[0].toISOString() : null;
              const lastTip = tips.length > 0 ? tips[tips.length - 1].toISOString() : null;
              await sql`UPDATE poll_state SET schedule_json = ${JSON.stringify(cachedGames)}, first_tip = ${firstTip}, last_tip = ${lastTip}, fetched_at = NOW() WHERE league = ${league} AND date = ${dateKey}`;
              log(`${league.toUpperCase()}: SR retry succeeded — ${cachedGames.length} games with UUIDs`);
            } else {
              log(`${league.toUpperCase()}: SR retry returned 0 games — keeping ESPN IDs`);
            }
          } catch (e) {
            log(`${league.toUpperCase()}: SR retry failed (${e.message}) — keeping ESPN IDs`);
          }
        } else {
          log(`${league.toUpperCase()}: using cached schedule (${cachedGames.length} games${_hasEspnIds?' [ESPN IDs — games in progress, keeping]':''})`);
        }
      } else {
        // First fetch today — single SR schedule call, cache to DB
        log(`${league.toUpperCase()}: fetching schedule (first call today)...`);
        let allGames = [];
        let _scheduleSource = 'sr';
        try {
          const schedule = await srFetch(league, `games/${d.year}/${pad(d.month)}/${pad(d.day)}/schedule.json`);
          allGames = schedule.games || [];
        } catch (srErr) {
          log(`${league.toUpperCase()}: SR schedule failed (${srErr.message}) — falling back to ESPN`);
          // ESPN fallback — critical for WNBA preseason (SR has no preseason data)
          const dateStr = `${d.year}${pad(d.month)}${pad(d.day)}`;
          const espnFallback = await espnScoreboard(league, dateStr);
          if (espnFallback.length > 0) {
            _scheduleSource = 'espn';
            // Normalize ESPN status → SR-compatible: STATUS_FINAL→closed, STATUS_IN_PROGRESS→inprogress
            const _espnStatusMap = { 'STATUS_FINAL': 'closed', 'STATUS_IN_PROGRESS': 'inprogress', 'STATUS_SCHEDULED': 'scheduled', 'STATUS_HALFTIME': 'inprogress', 'STATUS_END_PERIOD': 'inprogress' };
            allGames = espnFallback.map(eg => ({
              id: eg.espnId,
              scheduled: eg.scheduled || null,
              home: { alias: eg.homeAbbr, name: eg.homeName },
              away: { alias: eg.awayAbbr, name: eg.awayName },
              status: _espnStatusMap[eg.status] || (eg.status || 'scheduled').toLowerCase(),
            }));
            log(`${league.toUpperCase()}: ESPN fallback found ${allGames.length} games`);
          } else {
            log(`${league.toUpperCase()}: ESPN fallback also empty`);
          }
        }

        // Build minimal cache: only the fields we need per cycle
        cachedGames = allGames.map(g => ({
          id: g.id,
          scheduled: g.scheduled || null,
          home_alias: cfg.aliasMap?.[g.home?.alias] || g.home?.alias || '',
          away_alias: cfg.aliasMap?.[g.away?.alias] || g.away?.alias || '',
          home_name: g.home?.name || '',
          away_name: g.away?.name || '',
          status: (g.status || 'scheduled').toLowerCase(),
        }));

        // Extract tip times
        const tips = cachedGames
          .filter(g => g.scheduled)
          .map(g => new Date(g.scheduled))
          .sort((a, b) => a - b);
        const firstTip = tips.length > 0 ? tips[0].toISOString() : null;
        const lastTip = tips.length > 0 ? tips[tips.length - 1].toISOString() : null;

        // Save to DB
        try {
          await sql`
            INSERT INTO poll_state (league, date, first_tip, last_tip, game_count, all_final, schedule_json)
            VALUES (${league}, ${dateKey}, ${firstTip}, ${lastTip}, ${cachedGames.length}, ${false}, ${JSON.stringify(cachedGames)})
            ON CONFLICT (league, date) DO UPDATE SET
              first_tip = ${firstTip}, last_tip = ${lastTip},
              game_count = ${cachedGames.length}, schedule_json = ${JSON.stringify(cachedGames)}, fetched_at = NOW()
          `;
        } catch (e) {
          log(`poll_state save failed: ${e.message}`);
        }

        if (cachedGames.length === 0) {
          log(`${league.toUpperCase()}: no games today — stored & sleeping`);
          continue;
        }
        log(`${league.toUpperCase()}: schedule cached (${_scheduleSource}) — ${cachedGames.length} games, first tip ${firstTip ? new Date(firstTip).toLocaleTimeString('en-US', {timeZone:'America/New_York'}) : '?'} ET`);

        // Check if before window (just fetched, might be too early)
        if (firstTip) {
          const now = new Date();
          const windowStart = new Date(new Date(firstTip).getTime() - 15 * 60 * 1000);
          if (now < windowStart) {
            log(`${league.toUpperCase()}: before game window — sleeping until ${windowStart.toLocaleTimeString('en-US', {timeZone:'America/New_York'})} ET`);
            results.skipped = 'before_window';
            continue;
          }
        }
      }

      // ── 2. Determine which games need summary fetches ──
      // A game needs a fetch if: tip time has passed AND not already marked final in cache
      const now = new Date();
      const potentiallyLive = cachedGames.filter(g => {
        if (g.status === 'closed' || g.status === 'complete') return false;
        if (!g.scheduled) return true; // no tip time, assume could be live
        return new Date(g.scheduled) <= now;
      });

      if (potentiallyLive.length === 0) {
        // All games either haven't started or already final
        const allDone = cachedGames.every(g => g.status === 'closed' || g.status === 'complete');
        if (allDone && cachedGames.length > 0) {
          log(`${league.toUpperCase()}: all ${cachedGames.length} games FINAL — marking done`);
          try { await sql`UPDATE poll_state SET all_final = TRUE WHERE league = ${league} AND date = ${dateKey}`; } catch(e) {}
        } else {
          log(`${league.toUpperCase()}: no games tipped yet — waiting`);
        }
        continue;
      }

      log(`${league.toUpperCase()}: ${cachedGames.length} total, ${potentiallyLive.length} potentially live`);
      results.games += potentiallyLive.length;

      // ── 3. Fetch ESPN scoreboard for ID mapping ──
      const dateStr = `${d.year}${pad(d.month)}${pad(d.day)}`;
      const espnGames = await espnScoreboard(league, dateStr);
      log(`ESPN scoreboard: ${espnGames.length} events`);

      // Build ESPN mapping: SR alias → ESPN event ID
      const espnMap = {};
      for (const g of potentiallyLive) {
        const hA = g.home_alias || '';
        const aA = g.away_alias || '';
        const hE = cfg.aliasMap[hA] || hA;
        const aE = cfg.aliasMap[aA] || aA;
        // Try abbreviation match first
        let match = espnGames.find(eg =>
          (eg.homeAbbr === hA || eg.homeAbbr === hE) &&
          (eg.awayAbbr === aA || eg.awayAbbr === aE)
        );
        // Fallback: name-based matching (critical for NCAAMB where abbreviations diverge)
        if (!match && (g.home_name || g.away_name)) {
          const hName = (g.home_name || '').toLowerCase();
          const aName = (g.away_name || '').toLowerCase();
          match = espnGames.find(eg =>
            (hName && eg.homeName && (eg.homeName.includes(hName) || hName.includes(eg.homeName))) &&
            (aName && eg.awayName && (eg.awayName.includes(aName) || aName.includes(eg.awayName)))
          );
        }
        if (match) espnMap[g.id] = match.espnId;
      }
      log(`ESPN mapped: ${Object.keys(espnMap).length}/${potentiallyLive.length}`);

      // ── 3b. Fetch BDL team IDs + season stats (parallel) ──
      const bdlDateStr = `${d.year}-${pad(d.month)}-${pad(d.day)}`;
      const bdlData = await bdlGameData(league, bdlDateStr);
      const bdlTeamIds = bdlData.teamIds;
      const bdlGameIds = bdlData.gameIds;
      log(`BDL: ${Object.keys(bdlTeamIds).length} teams, ${Object.keys(bdlGameIds).length} games mapped`);

      // Collect unique team abbreviations from potentially live games
      const teamAbbrs = new Set();
      for (const g of potentiallyLive) {
        if (g.home_alias) teamAbbrs.add(g.home_alias);
        if (g.away_alias) teamAbbrs.add(g.away_alias);
      }

      // Load season stats — cache-first (DB), fetch stale/missing from BDL
      const bdlSeasonCache = await getSeasonStatsForTeams(sql, league, cfg.season, teamAbbrs, bdlTeamIds);

      // MC: Load clutch profiles + compute team 3PT baselines (once per invocation)
      if (!_clutchMap) {
        try {
          const _cpRows = await sql`SELECT * FROM clutch_profiles WHERE league = ${league} AND season = ${'2025'}`;
          _clutchMap = {};
          for (const r of _cpRows) {
            _clutchMap[r.team_alias] = {
              games: r.games,
              q4_fg3pct: r.q4_fg3a > 0 ? r.q4_fg3m / r.q4_fg3a : null,
              q4_fg2pct: (r.q4_fga - r.q4_fg3a) > 0 ? (r.q4_fgm - r.q4_fg3m) / (r.q4_fga - r.q4_fg3a) : null,
              q4_to_rate: r.q4_poss > 0 ? r.q4_to / r.q4_poss : null,
              delta_fg3: (r.q4_fg3a > 20 && r.full_fg3a > 50) ? (r.q4_fg3m / r.q4_fg3a) - (r.full_fg3m / r.full_fg3a) : 0,
            };
          }
          log(`MC: loaded ${_cpRows.length} clutch profiles`);
        } catch (e) { _clutchMap = {}; log(`MC: clutch profile load failed: ${e.message}`); }
      }
      if (!_team3ptBaselines) {
        _team3ptBaselines = {};
        for (const tm of Object.keys(bdlSeasonCache)) {
          const sc = bdlSeasonCache[tm];
          if (!sc || !Array.isArray(sc) || sc.length === 0) continue;
          let fg3m = 0, fg3a = 0;
          for (const p of sc) {
            const gp = Number(p.games_played || p.gp || 0);
            if (gp < 10) continue;
            fg3m += Number(p.fg3m || p.three_points_made || 0) * gp;
            fg3a += Number(p.fg3a || p.three_points_att || 0) * gp;
          }
          _team3ptBaselines[tm] = fg3a > 0 ? fg3m / fg3a : 0.36;
        }
        log(`MC: computed ${Object.keys(_team3ptBaselines).length} team 3PT baselines`);
      }
      // Compute team-level season rates for MC driver decomposition
      if (!_teamSeasonRates) {
        _teamSeasonRates = {};
        for (const tm of Object.keys(bdlSeasonCache)) {
          const sc = bdlSeasonCache[tm];
          if (!sc || !Array.isArray(sc) || sc.length === 0) continue;
          var tFGA=0, tFGM=0, tFG3A=0, tFG3M=0, tFTA=0, tFTM=0, tTO=0, tOREB=0;
          for (const p of sc) {
            const gp = Number(p.games_played || p.gp || 0);
            if (gp < 10) continue;
            // Multiply per-game averages by games played to get season totals
            tFGA += Number(p.fga || 0) * gp;
            tFGM += Number(p.fgm || 0) * gp;
            tFG3A += Number(p.fg3a || 0) * gp;
            tFG3M += Number(p.fg3m || 0) * gp;
            tFTA += Number(p.fta || 0) * gp;
            tFTM += Number(p.ftm || 0) * gp;
            tTO += Number(p.turnover || p.to || 0) * gp;
            tOREB += Number(p.oreb || 0) * gp;
          }
          var tFG2A = tFGA - tFG3A, tFG2M = tFGM - tFG3M;
          var tPoss = tFGA + 0.44 * tFTA - tOREB + tTO;
          if (tFGA < 100) continue; // skip teams with insufficient data
          _teamSeasonRates[tm] = {
            toRate: tPoss > 0 ? tTO / tPoss : 0.13,
            fg3aShare: tFGA > 0 ? tFG3A / tFGA : 0.35,
            fg3Pct: tFG3A > 0 ? tFG3M / tFG3A : 0.36,
            fg2Pct: tFG2A > 0 ? tFG2M / tFG2A : 0.52,
            orebRate: (tFGA - tFGM) > 0 ? tOREB / (tFGA - tFGM) : 0.25,
            ftaRate: tPoss > 0 ? tFTA / tPoss : 0.22,
            ftPct: tFTA > 0 ? tFTM / tFTA : 0.76,
          };
        }
        log(`MC: computed ${Object.keys(_teamSeasonRates).length} team season rate profiles`);
      }

      // Track which cached games got updated this cycle
      let cacheUpdated = false;
      let liveCount = 0;

      // ── 3c. Batch BDL box_scores + lineups fetch (one call each, covers ALL games) ──
      let bdlBoxScores = [];
      if (cfg.bdlHasBoxScores !== false) {
      try {
        // Use date endpoint — returns ALL games (in-progress, OT, halftime, final)
        // box_scores/live may omit OT games
        const boxResult = await bdlFetch(`${cfg.bdlPrefix}/v1/box_scores?date=${bdlDateStr}`);
        bdlBoxScores = boxResult?.data || [];
        // NCAAMB: BDL uses UTC dates — also fetch next day to catch late-ET games
        if (league === 'ncaamb') {
          const dt = new Date(bdlDateStr + 'T12:00:00Z');
          dt.setUTCDate(dt.getUTCDate() + 1);
          const nd = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
          try {
            const box2 = await bdlFetch(`${cfg.bdlPrefix}/v1/box_scores?date=${nd}`);
            if (box2?.data) bdlBoxScores = bdlBoxScores.concat(box2.data);
          } catch (e) { log(`BDL box_scores next-day ${nd} failed: ${e.message}`); }
        }
        _serverBoxScoreCache = bdlBoxScores;
        _serverBoxScoreTime = Date.now();
        log(`BDL box_scores: ${bdlBoxScores.length} games`);
      } catch (e) {
        log(`BDL box_scores failed: ${e.message}`);
      }
      } // end bdlHasBoxScores guard

      // Helper: translate SR aliases → BDL aliases for game ID lookup
      const getBdlGid = (g) => {
        const hB = cfg.aliasMap?.[g.home_alias] || g.home_alias;
        const aB = cfg.aliasMap?.[g.away_alias] || g.away_alias;
        return bdlGameIds[`${aB}@${hB}`] || bdlGameIds[`${g.away_alias}@${g.home_alias}`];
      };

      // Batch lineups for all games we don't have cached
      const lineupsNeeded = potentiallyLive.filter(g => {
        const bdlGid = getBdlGid(g);
        return bdlGid && !_serverLineupsCache[bdlGid];
      }).map(g => getBdlGid(g));
      if (lineupsNeeded.length > 0) {
        try {
          const luResult = await bdlFetch(`${cfg.bdlPrefix}/v1/lineups?${lineupsNeeded.map(id => 'game_ids[]=' + id).join('&')}&per_page=100`);
          if (luResult?.data) {
            // Group by game_id
            luResult.data.forEach(l => {
              const gid = l.game_id;
              if (!_serverLineupsCache[gid]) _serverLineupsCache[gid] = [];
              _serverLineupsCache[gid].push(l);
            });
            log(`BDL lineups: ${luResult.data.length} records cached`);
          }
        } catch (e) { log(`BDL lineups failed: ${e.message}`); }
      }

      // ── 3d. WNBA: batch BDL player_stats (no box_scores endpoint) ──
      var wnbaPlayerStatsCache = {}; // { bdlGid: [player, ...] }
      if (league === 'wnba') {
        const gids = potentiallyLive.map(g => getBdlGid(g)).filter(Boolean);
        if (gids.length > 0) {
          try {
            const psResp = await bdlFetch(`${cfg.bdlPrefix}/v1/player_stats?${gids.map(id => 'game_ids[]=' + id).join('&')}&per_page=100`);
            const allPs = psResp?.data || [];
            for (const p of allPs) {
              const gid = p.game?.id;
              if (gid) { if (!wnbaPlayerStatsCache[gid]) wnbaPlayerStatsCache[gid] = []; wnbaPlayerStatsCache[gid].push(p); }
            }
            log(`BDL WNBA player_stats: ${allPs.length} records for ${Object.keys(wnbaPlayerStatsCache).length} games`);
          } catch (e) { log(`BDL WNBA player_stats batch failed: ${e.message}`); }
        }
      }

      // ── 4. Process each potentially live game — BDL box_scores + plays ──
      // Fetch plays for all live games in parallel (BDL: 600 req/min)
      const playsFetches = potentiallyLive.map(g => {
        const bdlGid = getBdlGid(g);
        if (!bdlGid) return Promise.resolve(null);
        return bdlFetch(`${cfg.bdlPrefix}/v1/plays?game_id=${bdlGid}&per_page=500`).catch(() => null);
      });
      const allPlaysResults = await Promise.all(playsFetches);

      // Load season Q4 margins for I4 pre-Q4 prior
      const seasonQ4 = await loadSeasonQ4(sql, league);

      // Fetch live odds from The Odds API (one call, all games)
      // Returns { 'NYK': { homeSpread, homeML, awayML, total, books }, ... }
      const oddsAPICache = (league === 'nba' || league === 'wnba') ? await fetchOddsAPIBatch(league) : {};
      const ssStandings = (league === 'wnba' && !WNBA_SS_COMPUTE_OFF) ? await fetchStandingsCache(sql, league) : {};

      for (let gi = 0; gi < potentiallyLive.length; gi++) {
        const game = potentiallyLive[gi];
        // Normalize aliases to BDL canonical (SR schedule uses LAS/LVA/NYL/GSV/WAS/PDX/TOY;
        // BDL+ESPN+computeServer use LA/LV/NY/GS/WSH/POR/TOR). Single conversion here
        // means ALL downstream functions (MC, XGB, erosion, alerts, etc.) get consistent aliases.
        const hA = cfg.aliasMap?.[game.home_alias] || game.home_alias || 'HOME';
        const aA = cfg.aliasMap?.[game.away_alias] || game.away_alias || 'AWAY';
        const matchup = `${aA}@${hA}`;
        const bdlGid = getBdlGid(game);

        try {
          if (!bdlGid) {
            if (league === 'wnba') {
              // WNBA: no BDL game ID — will attempt SR fallback in data fetch block
              log(`${matchup}: no BDL game ID — will try SR fallback`);
            } else if (cfg.dryRun) {
              try {
                await sql`INSERT INTO games (id, league, home_team, away_team, status) 
                  VALUES (${game.id}, ${league}, ${hA}, ${aA}, ${'preseason'})
                  ON CONFLICT (id) DO UPDATE SET status = ${'preseason'}`;
              } catch(e) { log(`${matchup}: dryRun game INSERT failed: ${e.message}`); }
              if (espnMap[game.id]) {
                const _drEspnWP = await espnWinProb(league, espnMap[game.id]);
                log(`${matchup}: dryRun — ESPN WP: ${_drEspnWP ? `${hA} ${_drEspnWP.home}% / ${aA} ${_drEspnWP.away}%` : 'unavailable'}`);
              } else {
                log(`${matchup}: dryRun — game saved, no ESPN mapping`);
              }
              liveCount++;
              continue;
            } else {
              log(`${matchup}: no BDL game ID mapped — skipping`);
              continue;
            }
          }

          // Find data source for this game
          let boxScore = null, _srSummary = null;
          let _usedBdlFallback = false;
          if (league === 'wnba') {
            // ── WNBA: BDL player_stats primary, SR game summary fallback ──
            var bdlPlayers = bdlGid ? (wnbaPlayerStatsCache[bdlGid] || []) : [];
            if (bdlPlayers.length > 0) {
              try {
                var gameResp = await bdlFetch(`${cfg.bdlPrefix}/v1/games/${bdlGid}`);
                var bdlGameObj = gameResp?.data || null;
                if (bdlGameObj) {
                  var fbPlays = allPlaysResults[gi]?.data || [];
                  var fbPbp = parseBDLPBPServer(fbPlays, hA, aA);
                  _srSummary = buildSummaryFromBDLPlayerStats(bdlPlayers, bdlGameObj, fbPbp);
                  _usedBdlFallback = true;
                  log(`${matchup}: BDL primary — ${bdlPlayers.length} players`);
                } else {
                  throw new Error('BDL game object null');
                }
              } catch (bdlErr) {
                log(`${matchup}: BDL primary failed (${bdlErr.message}) — trying SR fallback`);
                try {
                  await sleep(SR_DELAY_MS);
                  _srSummary = await srFetch(league, `games/${game.id}/summary.json`);
                  if (!_srSummary || (!_srSummary.home && !_srSummary.away)) {
                    throw new Error('SR summary empty');
                  }
                  log(`${matchup}: SR fallback succeeded`);
                } catch (srErr) {
                  log(`${matchup}: SR fallback also failed (${srErr.message}) — skipping`);
                  continue;
                }
              }
            } else {
              // No BDL player_stats (game may not have started, or no bdlGid) — try SR
              try {
                await sleep(SR_DELAY_MS);
                _srSummary = await srFetch(league, `games/${game.id}/summary.json`);
                if (!_srSummary || (!_srSummary.home && !_srSummary.away)) {
                  throw new Error('SR summary empty');
                }
                log(`${matchup}: SR fallback succeeded (no BDL player_stats)`);
              } catch (srErr) {
                log(`${matchup}: no BDL player_stats + SR failed (${srErr.message}) — skipping`);
                continue;
              }
            }
          } else {
            boxScore = bdlBoxScores.find(b => b.id === bdlGid);
            if (!boxScore) {
              log(`${matchup}: no box score — game may not have started`);
              continue;
            }
          }

          // Check game status
          let gameStatus;
          if (league === 'wnba') {
            const srSt = (_srSummary.status || 'scheduled').toLowerCase();
            gameStatus = srSt === 'complete' ? 'closed' : srSt === 'inprogress' ? 'in progress' : srSt;
          } else {
            gameStatus = normalizeBdlStatusServer(boxScore.status, boxScore);
          }
          if (gameStatus === 'closed' || gameStatus === 'complete') {
            game.status = gameStatus;
            cacheUpdated = true;
            log(`${matchup}: FINAL — removed from active polling`);

            // ── QUARTER DATA: capture game-end boundary before finalization ──
            // This captures the final cumulative stats so the last period's diff is computable.
            // NBA: boundary '4' (Q4 end). NCAAMB: boundary '4' (game end / H2 end).
            try {
              const playsResult = allPlaysResults[gi];
              const plays = playsResult?.data || [];
              const pbpResult = parseBDLPBPServer(plays, hA, aA);
              const lineupsArr = _serverLineupsCache[bdlGid] || null;
              const finalSummary = league === 'wnba' ? _srSummary : buildSummaryFromBDLServer(boxScore, pbpResult, lineupsArr);
              const homeStats = finalSummary.home?.statistics || {};
              const awayStats = finalSummary.away?.statistics || {};
              if (Object.keys(homeStats).length > 0) {
                const qd = await readQuarterData(sql, game.id);
                // Determine last boundary key: NBA='4', NCAAMB='4' (game end)
                const endKey = '4';
                // Find the previous boundary key
                const prevKey = league === 'ncaamb' ? '3' : '3';
                if (!qd.boundaries[endKey]) {
                  captureBoundary(qd, endKey, prevKey, homeStats, awayStats);
                  await writeQuarterData(sql, game.id, qd);
                  log(`${matchup}: ★ game-end quarter_data boundary[${endKey}] captured`);
                }
              }
            } catch (e) {
              log(`${matchup}: game-end quarter_data capture failed: ${e.message}`);
            }

            // ── MC: Update clutch profiles from quarter_data ──
            try {
              const _cpQd = await readQuarterData(sql, game.id);
              const _cpB3 = _cpQd?.boundaries?.['3'], _cpB4 = _cpQd?.boundaries?.['4'];
              if (_cpB3 && _cpB4) {
                for (const _cpSide of ['home', 'away']) {
                  const _cpTeam = _cpSide === 'home' ? hA : aA;
                  const _cpQ4 = {
                    fga: Number(_cpB4[_cpSide]?.field_goals_att||0) - Number(_cpB3[_cpSide]?.field_goals_att||0),
                    fgm: Number(_cpB4[_cpSide]?.field_goals_made||0) - Number(_cpB3[_cpSide]?.field_goals_made||0),
                    fg3a: Number(_cpB4[_cpSide]?.three_points_att||0) - Number(_cpB3[_cpSide]?.three_points_att||0),
                    fg3m: Number(_cpB4[_cpSide]?.three_points_made||0) - Number(_cpB3[_cpSide]?.three_points_made||0),
                    fta: Number(_cpB4[_cpSide]?.free_throws_att||0) - Number(_cpB3[_cpSide]?.free_throws_att||0),
                    ftm: Number(_cpB4[_cpSide]?.free_throws_made||0) - Number(_cpB3[_cpSide]?.free_throws_made||0),
                    to: Number(_cpB4[_cpSide]?.turnovers||_cpB4[_cpSide]?.total_turnovers||0) - Number(_cpB3[_cpSide]?.turnovers||_cpB3[_cpSide]?.total_turnovers||0),
                    oreb: Number(_cpB4[_cpSide]?.offensive_rebounds||0) - Number(_cpB3[_cpSide]?.offensive_rebounds||0),
                    poss: Number(_cpB4[_cpSide]?.possessions||0) - Number(_cpB3[_cpSide]?.possessions||0),
                  };
                  const _cpFull = _cpB4[_cpSide] || {};
                  await sql`INSERT INTO clutch_profiles (team_alias, league, season, games,
                    q4_fga, q4_fgm, q4_fg3a, q4_fg3m, q4_fta, q4_ftm, q4_to, q4_oreb, q4_poss,
                    full_fga, full_fgm, full_fg3a, full_fg3m, full_fta, full_ftm, full_to, full_oreb, full_poss)
                  VALUES (${_cpTeam}, ${league}, ${'2025'}, ${1},
                    ${_cpQ4.fga}, ${_cpQ4.fgm}, ${_cpQ4.fg3a}, ${_cpQ4.fg3m}, ${_cpQ4.fta}, ${_cpQ4.ftm}, ${_cpQ4.to}, ${_cpQ4.oreb}, ${_cpQ4.poss},
                    ${Number(_cpFull.field_goals_att||0)}, ${Number(_cpFull.field_goals_made||0)},
                    ${Number(_cpFull.three_points_att||0)}, ${Number(_cpFull.three_points_made||0)},
                    ${Number(_cpFull.free_throws_att||0)}, ${Number(_cpFull.free_throws_made||0)},
                    ${Number(_cpFull.turnovers||_cpFull.total_turnovers||0)}, ${Number(_cpFull.offensive_rebounds||0)}, ${Number(_cpFull.possessions||0)})
                  ON CONFLICT (team_alias, league, season) DO UPDATE SET
                    games = clutch_profiles.games + 1,
                    q4_fga = clutch_profiles.q4_fga + EXCLUDED.q4_fga, q4_fgm = clutch_profiles.q4_fgm + EXCLUDED.q4_fgm,
                    q4_fg3a = clutch_profiles.q4_fg3a + EXCLUDED.q4_fg3a, q4_fg3m = clutch_profiles.q4_fg3m + EXCLUDED.q4_fg3m,
                    q4_fta = clutch_profiles.q4_fta + EXCLUDED.q4_fta, q4_ftm = clutch_profiles.q4_ftm + EXCLUDED.q4_ftm,
                    q4_to = clutch_profiles.q4_to + EXCLUDED.q4_to, q4_oreb = clutch_profiles.q4_oreb + EXCLUDED.q4_oreb,
                    q4_poss = clutch_profiles.q4_poss + EXCLUDED.q4_poss,
                    full_fga = clutch_profiles.full_fga + EXCLUDED.full_fga, full_fgm = clutch_profiles.full_fgm + EXCLUDED.full_fgm,
                    full_fg3a = clutch_profiles.full_fg3a + EXCLUDED.full_fg3a, full_fg3m = clutch_profiles.full_fg3m + EXCLUDED.full_fg3m,
                    full_fta = clutch_profiles.full_fta + EXCLUDED.full_fta, full_ftm = clutch_profiles.full_ftm + EXCLUDED.full_ftm,
                    full_to = clutch_profiles.full_to + EXCLUDED.full_to, full_oreb = clutch_profiles.full_oreb + EXCLUDED.full_oreb,
                    full_poss = clutch_profiles.full_poss + EXCLUDED.full_poss, updated_at = NOW()`;
                  log(`${matchup}: ★ clutch profile updated for ${_cpTeam}`);
                }
                // Invalidate cache so next invocation reloads
                _clutchMap = null;
              }
            } catch (e) { log(`${matchup}: clutch profile update failed: ${e.message}`); }

            if (espnMap[game.id]) {
              var finalWP = await espnWinProb(league, espnMap[game.id]);
              // Fetch + persist full WP history for next-day chart rendering
              var wpHistFull = await espnWPHistoryFull(league, espnMap[game.id]);
              if (wpHistFull && wpHistFull.length > 0) {
                try {
                  await sql`UPDATE games SET espn_wp_json = ${JSON.stringify(wpHistFull)} WHERE id = ${game.id}`;
                  log(`${matchup}: ★ ESPN WP history saved (${wpHistFull.length} points)`);
                } catch (e) { log(`${matchup}: ESPN WP history save failed: ${e.message}`); }
              }
            }

            // ── SERVER-SIDE FINALIZE — ensures calibration view works even when client is asleep ──
            try {
              const homePts = league === 'wnba' ? Number(_srSummary?.home?.points || 0) : (boxScore.home_team_score || 0);
              const awayPts = league === 'wnba' ? Number(_srSummary?.away?.points || 0) : (boxScore.visitor_team_score || 0);
              const winner = homePts > awayPts ? hA : (awayPts > homePts ? aA : 'TIE');
              const margin = Math.abs(homePts - awayPts);

              // Pull FWP from latest auto analysis if available
              let fwpTeam = null, fwpValue = null, conviction = null, entrySignal = null;
              try {
                const aRows = await sql`
                  SELECT prediction_json, conviction, entry, conviction_tier FROM analyses
                  WHERE game_id = ${game.id} AND "trigger" LIKE 'auto_q%'
                  ORDER BY ts DESC LIMIT 1
                `;
                if (aRows.length > 0) {
                  const pred = typeof aRows[0].prediction_json === 'string'
                    ? JSON.parse(aRows[0].prediction_json) : aRows[0].prediction_json;
                  if (pred?.homeValue?.fwp != null && pred?.awayValue?.fwp != null) {
                    if (pred.homeValue.fwp >= pred.awayValue.fwp) { fwpTeam = hA; fwpValue = pred.homeValue.fwp; }
                    else { fwpTeam = aA; fwpValue = pred.awayValue.fwp; }
                  }
                  conviction = aRows[0].conviction_tier || aRows[0].conviction || null;
                  entrySignal = aRows[0].entry || null;
                }
              } catch (e) { /* no auto analyses */ }

              // Pull thesis team from theses table
              let thesisTeam = null;
              try {
                const tRows = await sql`SELECT text FROM theses WHERE game_id = ${game.id} LIMIT 1`;
                if (tRows.length > 0) {
                  const csMatch = (tRows[0].text || '').match(/CONTROL SCORE:\s*(\w+)/i);
                  if (csMatch) thesisTeam = csMatch[1].toUpperCase();
                }
              } catch (e) { /* no thesis */ }

              // Pull latest odds for spread coverage
              let homeSpread = null;
              try {
                const oRows = await sql`
                  SELECT home_spread FROM odds_history
                  WHERE game_id = ${game.id} AND home_spread IS NOT NULL
                  ORDER BY ts DESC LIMIT 1
                `;
                if (oRows.length > 0) homeSpread = parseFloat(oRows[0].home_spread);
              } catch (e) { /* no odds */ }

              let homeCovered = null, awayCovered = null;
              if (homeSpread != null && !isNaN(homeSpread)) {
                const m = homePts - awayPts;
                homeCovered = (m + homeSpread) > 0;
                awayCovered = (-m + (-homeSpread)) > 0;
              }

              await sql`
                UPDATE games SET
                  home_pts = ${homePts}, away_pts = ${awayPts},
                  winner = ${winner}, margin = ${margin},
                  spread = ${homeSpread},
                  home_covered = ${homeCovered}, away_covered = ${awayCovered},
                  thesis_team = ${thesisTeam},
                  thesis_correct = ${thesisTeam ? thesisTeam === winner : null},
                  fwp_team = ${fwpTeam}, fwp_value = ${fwpValue},
                  fwp_correct = ${fwpTeam ? fwpTeam === winner : null},
                  conviction = ${conviction}, entry_signal = ${entrySignal}
                WHERE id = ${game.id}
              `;
              log(`${matchup}: ★ SERVER FINALIZED — ${winner} by ${margin} (FWP:${fwpTeam || 'N/A'} thesis:${thesisTeam || 'N/A'} spread:${homeSpread || 'N/A'})`);
            } catch (e) {
              log(`${matchup}: server finalize failed: ${e.message}`);
            }

            continue;
          }
          if (gameStatus === 'scheduled' || gameStatus === 'created') {
            log(`${matchup}: not started yet (${gameStatus})`);
            continue;
          }

          liveCount++;

          // Update cached schedule status (so poll_state reflects live games)
          if (game.status !== gameStatus) {
            game.status = gameStatus;
            cacheUpdated = true;
          }

          // Parse PBP
          const playsResult = allPlaysResults[gi];
          const plays = playsResult?.data || [];
          const pbpResult = parseBDLPBPServer(plays, hA, aA);
          const lineupsArr = _serverLineupsCache[bdlGid] || null;

          // Build SR-shaped summary
          // WNBA two-tier: ESPN for display (indicators/floor/alerts), BDL for models (XGB/MC)
          var summary, modelSummary, espnFull = null, espnRawStatsJson = null;
          if (league === 'wnba') {
            if (espnMap[game.id]) {
              try { espnFull = await espnSummaryFull(league, espnMap[game.id]); } catch (e) { log(`${matchup}: ESPN summary failed — ${e.message}`); }
            }
            if (espnFull?.boxscore?.home?.length > 0) {
              summary = buildSummaryFromESPN(espnFull);
              // POT ATTRIBUTION FIX — ESPN turnoverPoints is OPPONENT-attributed
              // (research/2026-06-10_phase4a_adjudication.md, n=81: flip takes 17%→67% exact, median err 0).
              // Swap sides so pot = OUR points scored off THEIR turnovers. Validated WNBA-only;
              // this branch is league-gated (league === 'wnba') — do NOT generalize to NBA without validation.
              // All downstream consumers (raw_stats_json, espn_raw_stats_json, computeServer/I1,
              // extractXGBFeatures, computeWNBAModelV2, agent prompts) read this summary post-swap.
              if (summary?.home?.statistics && summary?.away?.statistics) {
                var _potSwap = summary.home.statistics.points_off_turnovers;
                summary.home.statistics.points_off_turnovers = summary.away.statistics.points_off_turnovers;
                summary.away.statistics.points_off_turnovers = _potSwap;
              }
              // Enrich ESPN summary with BDL PBP-derived SCP + runs
              if (pbpResult?._bdl) {
                if (summary.home?.statistics) { summary.home.statistics.second_chance_points = pbpResult._bdl.scpHome || 0; summary.home.statistics.second_chance_pts = pbpResult._bdl.scpHome || 0; }
                if (summary.away?.statistics) { summary.away.statistics.second_chance_points = pbpResult._bdl.scpAway || 0; summary.away.statistics.second_chance_pts = pbpResult._bdl.scpAway || 0; }
              }
              if (pbpResult?.runs) {
                var _hRuns = (pbpResult.runs || []).filter(function(r) { return r.team === hA; });
                var _aRuns = (pbpResult.runs || []).filter(function(r) { return r.team === aA; });
                if (summary.home?.statistics) summary.home.statistics.most_unanswered = { points: _hRuns.reduce(function(m, r) { return r.pts > m ? r.pts : m; }, 0) };
                if (summary.away?.statistics) summary.away.statistics.most_unanswered = { points: _aRuns.reduce(function(m, r) { return r.pts > m ? r.pts : m; }, 0) };
              }
              espnRawStatsJson = buildESPNRawStatsJson(summary);
              modelSummary = _srSummary; // BDL-derived for XGB/MC fidelity
              log(`${matchup}: ESPN display ✓ | BDL model ✓`);
            } else {
              summary = _srSummary;
              modelSummary = _srSummary;
              log(`${matchup}: ESPN unavailable — BDL for all`);
            }
          } else {
            summary = buildSummaryFromBDLServer(boxScore, pbpResult, lineupsArr);
            modelSummary = summary;
          }

          // Phase 1: compute v2 structural overlay (dual-write — see computeWNBAModelV2)
          if (league === 'wnba') {
            try { game._wnbaV2 = computeWNBAModelV2(modelSummary, espnFull ? summary : null, pbpResult); }
            catch (e) { game._wnbaV2 = null; }
          }

          // ── BIGLEAD LAG FIX: BDL/SR biggest_lead lags 1-3 polls behind actual score ──
          // Track running max margin from actual scores in live_tracking, override summary
          // Also track per-quarter max margins for WNBA windowed biglead feature
          try {
            const _hPts = Number(summary.home?.points || 0), _aPts = Number(summary.away?.points || 0);
            const _curMargin = _hPts - _aPts;  // positive = home leading
            // Load stored max from live_tracking (isolated query — never add to existing SELECTs)
            const _blR = await sql`SELECT live_tracking->'_bigLeadHome' as blh, live_tracking->'_bigLeadAway' as bla, live_tracking->'_qMaxMarginHome' as qmh, live_tracking->'_qMaxMarginAway' as qma FROM games WHERE id = ${game.id}`;
            const _storedBLH = Number(_blR[0]?.blh || 0), _storedBLA = Number(_blR[0]?.bla || 0);
            const _trueBLH = Math.max(_storedBLH, _curMargin > 0 ? _curMargin : 0);
            const _trueBLA = Math.max(_storedBLA, _curMargin < 0 ? -_curMargin : 0);
            // Override summary biggest_lead with running max
            if (summary.home?.statistics) summary.home.statistics.biggest_lead = _trueBLH;
            if (summary.away?.statistics) summary.away.statistics.biggest_lead = _trueBLA;
            // Per-quarter max margins (for WNBA windowed biglead)
            var _qmh = _blR[0]?.qmh || {}, _qma = _blR[0]?.qma || {};
            if (typeof _qmh === 'string') _qmh = JSON.parse(_qmh);
            if (typeof _qma === 'string') _qma = JSON.parse(_qma);
            var _qKey = String(summary.quarter || summary.half || 1);
            _qmh[_qKey] = Math.max(Number(_qmh[_qKey] || 0), _curMargin > 0 ? _curMargin : 0);
            _qma[_qKey] = Math.max(Number(_qma[_qKey] || 0), _curMargin < 0 ? -_curMargin : 0);
            // Stash for lt persistence later
            game._trueBigLeadHome = _trueBLH;
            game._trueBigLeadAway = _trueBLA;
            game._qMaxMarginHome = _qmh;
            game._qMaxMarginAway = _qma;
          } catch (e) { /* non-fatal — falls back to BDL/SR values */ }

          // Stash PBP result for computeServerContext to use (avoids re-fetching)
          game._bdlPbp = pbpResult;

          // Compute indicators
          const ind = computeServer(summary, pbpResult, _seasonQ4Cache || {}, league);
          if (!ind) {
            log(`${matchup}: compute returned null (no stats yet?)`);
            continue;
          }
          const conviction = computeConviction(ind, league);

          // ── CTRL-RELATIVE I1-I5: all storage and display uses these ──
          const _ci = ctrlI(ind);

          const _floorWP = lookupFloorWP(_floorWPCoeffs, ind.controlTeam, ind.score);

          // ── FALLBACK THESIS — catch games where pregame cron missed the window ──
          if (!_thesisAttempted.has(game.id)) {
            pendingAnalyses.push(
              generateFallbackThesis(sql, game, league, ind, conviction, summary, matchup, hA, aA)
                .catch(e => log(`${matchup}: fallback thesis error: ${e.message}`))
            );
          }

          // ESPN WP — use espnFull if available (WNBA: no extra HTTP call)
          let espnWP = null;
          if (league === 'wnba' && espnFull?.wp) {
            espnWP = espnFull.wp;
          } else if (espnMap[game.id]) {
            espnWP = await espnWinProb(league, espnMap[game.id]);
          }

          // Determine period + clock from summary
          // SR NBA has summary.quarter, NCAAMB has summary.half
          // Periods may be nested under home/away, not top-level
          var currentPeriod, clock, _boundaryStale = false;
          if (league === 'wnba') {
            // Phase 0: boundary-stale guard (see stableWNBAPeriodClock)
            const _pc = stableWNBAPeriodClock(summary, game);
            currentPeriod = _pc.period; clock = _pc.clock; _boundaryStale = _pc.boundary;
          } else {
            currentPeriod = summary.quarter || summary.half
              || (summary.periods || []).length
              || (summary.home?.periods || []).length
              || 0;
            clock = summary.clock || '';
          }

          // Phase 0: during an intermission, take at most ONE boundary snapshot per period.
          // Subsequent polls skip recompute on the stale box (Jun 7: 2 model computes on stale data).
          if (_boundaryStale) {
            try {
              const _lastSnap = await sql`SELECT period, clock FROM snapshots WHERE game_id = ${game.id} AND source = 'server' ORDER BY ts DESC LIMIT 1`;
              if (_lastSnap[0] && Number(_lastSnap[0].period) === Number(currentPeriod) && String(_lastSnap[0].clock) === '0:00') {
                log(`${matchup}: boundary-stale (P${currentPeriod} parked) — boundary snapshot already taken, skipping cycle`);
                continue;
              }
            } catch (e) { /* non-fatal — proceed with normal cycle */ }
          }

          // Compute rolling window BEFORE XGB — XGB uses windowed features
          var _windowScore = null, _windowResult = null;
          try {
            const _qd = await readQuarterData(sql, game.id);
            if (_qd) {
              _windowResult = computeServerWindow(_qd, currentPeriod, clock, summary, hA, aA, league);
              if (_windowResult && _windowResult.available) {
                _windowScore = _windowResult.score;
              }
            }
          } catch (e) { /* non-fatal */ }

          // XGBoost structural win probability (uses 2Q cross-fade window when available)
          // WNBA: compute windowed biglead from per-quarter max margins (cross-fade weighted)
          var _windowedBiglead = null;
          if (league === 'wnba' && game._qMaxMarginHome && ind && ind.controlTeam) {
            try {
              var _wblCtrlIsHome = ind.controlTeam === hA;
              var _wblQMC = _wblCtrlIsHome ? game._qMaxMarginHome : game._qMaxMarginAway;  // ctrl's max leads
              var _wblQMO = _wblCtrlIsHome ? game._qMaxMarginAway : game._qMaxMarginHome;  // opp's max leads
              var _wblP = currentPeriod || 1;
              var _wblClkParts = (clock || '10:00').split(':');
              var _wblClkSec = (parseInt(_wblClkParts[0]) || 0) * 60 + (parseInt(_wblClkParts[1]) || 0);
              var _wblCompletion = Math.max(0, Math.min(1, (600 - _wblClkSec) / 600));
              var _wblWQs = [];
              if (_wblP === 2) { _wblWQs = [[Math.max(0, 1-_wblCompletion), 1], [1.0, 2]]; }
              else if (_wblP === 3) { _wblWQs = [[1.0, 2], [1.0, 3]]; }
              else if (_wblP >= 4) { _wblWQs = [[Math.max(0, 1-_wblCompletion), 2], [1.0, 3], [1.0, 4]]; }
              var _wblCtrl = 0, _wblOpp = 0;
              for (var _wqi = 0; _wqi < _wblWQs.length; _wqi++) {
                var _wblW = _wblWQs[_wqi][0], _wblQ = _wblWQs[_wqi][1];
                if (_wblW > 0.1) {
                  _wblCtrl = Math.max(_wblCtrl, Number(_wblQMC[String(_wblQ)] || 0));
                  _wblOpp = Math.max(_wblOpp, Number(_wblQMO[String(_wblQ)] || 0));
                }
              }
              _windowedBiglead = _wblCtrl - _wblOpp;
            } catch (e) { /* non-fatal — falls back to cumulative */ }
          }
          // XGB: use modelSummary (BDL) for WNBA feature fidelity — avoids distribution shift
          const _xgbSrc = league === 'wnba' ? (modelSummary || summary) : summary;
          const _xgbFeatures = extractXGBFeatures(_xgbSrc, ind, pbpResult, currentPeriod, clock, _windowResult?.rawAgg || null, league, _windowedBiglead);
          const _xgbWinProb = _xgbFeatures ? predictXGB(_xgbFeatures, league) : null;
          const _xgbDivergence = _xgbWinProb != null ? Math.round((_xgbWinProb - ind.score) * 1000) / 1000 : null;
          const _xgbAligned = _xgbWinProb != null ? Math.abs(_xgbWinProb - ind.score) < 0.15 : null;
          const _xgbShap = _xgbFeatures ? computeXGBContributions(_xgbFeatures, league) : null;

          // _xgbBwcProb computed below after lt is loaded from DB

          // Compute deficit relative to control team
          const ctrlIsHome = ind.controlTeam === hA;
          const ctrlPts = ctrlIsHome ? ind.homePts : ind.awayPts;
          const oppPts = ctrlIsHome ? ind.awayPts : ind.homePts;
          const deficit = Math.max(0, oppPts - ctrlPts);
          const trailingTeam = oppPts > ctrlPts ? ind.controlTeam
                             : ctrlPts > oppPts ? (ctrlIsHome ? aA : hA)
                             : null;

          // Merge BDL season averages onto SR summary players (enriches sustainability audit)
          const homeBdl = bdlSeasonCache[hA] || [];
          const awayBdl = bdlSeasonCache[aA] || [];
          if (homeBdl.length > 0 || awayBdl.length > 0) {
            mergeBdlSeasonData(summary, homeBdl, awayBdl);
          }

          // Compute sustainability + lead composition
          const sust = computeSustainability(summary, league);
          const leadComp = computeLeadComposition(summary);

          // Compute volume threat (needs PBP + sust + game time)
          let gameVolumeThreat = null;
          try {
            var VT_GAME_MINS = (league === 'ncaamb' || league === 'wnba') ? 40 : 48;
            var VT_PERIOD_MINS = league === 'ncaamb' ? 20 : league === 'wnba' ? 10 : 12;
            var vtTotalPeriods = league === 'ncaamb' ? 2 : 4;
            var vtClk = (clock || '').split(':');
            var vtClkMins = vtClk.length === 2 ? (parseInt(vtClk[0]) || 0) + ((parseInt(vtClk[1]) || 0) / 60) : VT_PERIOD_MINS;
            var vtPLeft = Math.max(0, vtTotalPeriods - currentPeriod);
            var vtMLeft = vtClkMins + (vtPLeft * VT_PERIOD_MINS);
            var vtElapsed = Math.max(1, VT_GAME_MINS - vtMLeft);
            gameVolumeThreat = computeVolumeThreat(summary, pbpResult, sust, league, vtElapsed);
            if (gameVolumeThreat) {
              var hVT = gameVolumeThreat.home, aVT = gameVolumeThreat.away;
              if (hVT.active) log(`${matchup}: VOLUME THREAT ${hA} — proj ${hVT.projected3PA} 3PA, ${hVT.live3Pct}% (szn ${hVT.baseline}%), C&S:${hVT.cs3PM}, disc:${hVT.discount}, bonus:${hVT.vtBonus}${hVT.mitigated ? ' (mitigated, ratio:'+hVT.mitRatio+')' : ''}`);
              if (aVT.active) log(`${matchup}: VOLUME THREAT ${aA} — proj ${aVT.projected3PA} 3PA, ${aVT.live3Pct}% (szn ${aVT.baseline}%), C&S:${aVT.cs3PM}, disc:${aVT.discount}, bonus:${aVT.vtBonus}${aVT.mitigated ? ' (mitigated, ratio:'+aVT.mitRatio+')' : ''}`);
              if (hVT.mitigated && !hVT.active) log(`${matchup}: VT ${hA} FULLY MITIGATED — ${aA} has ${aVT.live3PA||'?'} 3PA vs ${hVT.live3PA} (ratio:${hVT.mitRatio})`);
              if (aVT.mitigated && !aVT.active) log(`${matchup}: VT ${aA} FULLY MITIGATED — ${hA} has ${hVT.live3PA||'?'} 3PA vs ${aVT.live3PA} (ratio:${aVT.mitRatio})`);
              // Floor discount: opponent's VT undermines control team's structural edge
              var ctrlIsHomeVT = ind.controlTeam === hA;
              var oppVT = ctrlIsHomeVT ? aVT : hVT;
              if (oppVT && oppVT.active && oppVT.discount > 0) {
                var rawFloor = ind.score;
                ind.score = Math.round(ind.score * (1 - oppVT.discount) * 100) / 100;
                log(`${matchup}: VT FLOOR DISCOUNT — ${rawFloor.toFixed(2)} → ${ind.score.toFixed(2)} (${(oppVT.discount*100).toFixed(0)}% disc from ${ctrlIsHomeVT ? aA : hA})`);
              }
            }
          } catch (e) { /* non-fatal */ }

          // Lead team sustainability tier
          const leadSide = ind.homePts > ind.awayPts ? 'home'
                         : ind.awayPts > ind.homePts ? 'away'
                         : 'home'; // tie → home default
          const leadSust = sust?.[leadSide]?.tier || null;
          const leadClass = leadComp?.classification || null;

          // Live odds from The Odds API batch cache (best available line)
          // Falls back to BDL if Odds API didn't return this game
          let odds = oddsAPICache[hA] || null;
          if (!odds && bdlGid) {
            odds = await bdlOdds(league, bdlGid);
          }
          const spreadVal = odds?.homeSpread != null ? parseFloat(odds.homeSpread) : null;

          // ── 4. Save to DB ──
          // Ensure game row exists
          await sql`
            INSERT INTO games (id, date, league, matchup, home_alias, away_alias)
            VALUES (${game.id}, ${`${d.year}-${pad(d.month)}-${pad(d.day)}`}, ${league}, ${matchup}, ${hA}, ${aA})
            ON CONFLICT (id) DO NOTHING
          `;

          // Insert snapshot (source = 'server' to distinguish from client)
          const sustJson = sust ? JSON.stringify(sust) : null;
          // Compute throughput + lead safety for snapshot persistence
          let snapTp = null, snapLs = null;
          if (currentPeriod >= 2) {
            try {
              snapTp = computeThroughputServer(summary, ind, sust, hA, aA, currentPeriod, clock, league, gameVolumeThreat);
              snapLs = computeLeadSafetyServer(summary, ind, sust, hA, aA, currentPeriod, clock, league, gameVolumeThreat);
            } catch (e) { /* non-fatal — snapshot still saves without tp/ls */ }
          }
          // Compute PBP 15-possession window for snapshot persistence
          var _possWindowScore = null;
          try {
            const _pw = computePossWindowServer(pbpResult?.possLog, 15, hA, aA);
            if (_pw && _pw.available) {
              // Convert to ctrl-team-relative
              const _pwCtrlIsHome = ind.controlTeam === hA;
              _possWindowScore = _pwCtrlIsHome ? _pw.score : (1 - _pw.score);
              _possWindowScore = Math.round(_possWindowScore * 10000) / 10000;
            }
          } catch (e) { /* non-fatal */ }
          // DIAGNOSTIC: log ind shape before INSERT to catch null fields
          log(`${matchup}: SNAP IND — Q${currentPeriod} ${clock} score:${ind.score} team:${ind.controlTeam} I1:${_ci[0]} I2:${_ci[1]} I3:${_ci[2]} I4:${_ci[3]} I5:${_ci[4]} conv:${conviction.tier}(${conviction.combo}) hPts:${ind.homePts} aPts:${ind.awayPts} tp:${snapTp?.classification||'null'} ls:${snapLs?.classification||'null'}`);
          // Capture raw stats that fed computeServer for audit/debugging
          var rawStatsJson = null;
          try {
            var _hs = summary.home?.statistics || {}, _as = summary.away?.statistics || {};
            rawStatsJson = JSON.stringify({
              _boundary: _boundaryStale || undefined,
              home: { pts: ind.homePts||0, stl: _hs.steals||0, oreb: _hs.offensive_rebounds||0, to: _hs.turnovers||_hs.total_turnovers||0, fbp: _hs.fast_break_points||0, pot: _hs.points_off_turnovers||0, scp: _hs.second_chance_points||_hs.second_chance_pts||0, paint: _hs.points_in_the_paint||_hs.points_in_paint||0, atRimM: _hs.field_goals_at_rim_made||0, atRimA: _hs.field_goals_at_rim_att||0, paintM: _hs.points_in_paint_made||0, paintA: _hs.points_in_paint_att||0, fta: _hs.free_throws_att||0, blk: _hs.blocks||0, fd: _hs.fouls_drawn||0, fgm: _hs.field_goals_made||0, fga: _hs.field_goals_att||0, fg3m: _hs.three_points_made||0, fg3a: _hs.three_points_att||0, ast: _hs.assists||0, bigLead: _hs.biggest_lead||0, bench: _hs.bench_points||0, oppp: _hs.offensive_points_per_possession||0, dppp: _hs.defensive_points_per_possession||0, poss: _hs.possessions||0, ftm: _hs.free_throws_made||0, forced_to: pbpResult?.home?.tos?.forced||0, unforced_to: pbpResult?.home?.tos?.unforced||0, assisted_3pm: pbpResult?.home?.threes?.assisted||0, ...(game._wnbaV2?.home ? { pot_v2: game._wnbaV2.home.pot, paint_v2: game._wnbaV2.home.paint, fbp_v2: game._wnbaV2.home.fbp, scp_v2: game._wnbaV2.home.scp, poss_v2: game._wnbaV2.home.poss, v2_src: game._wnbaV2.home.src } : {}) },
              away: { pts: ind.awayPts||0, stl: _as.steals||0, oreb: _as.offensive_rebounds||0, to: _as.turnovers||_as.total_turnovers||0, fbp: _as.fast_break_points||0, pot: _as.points_off_turnovers||0, scp: _as.second_chance_points||_as.second_chance_pts||0, paint: _as.points_in_the_paint||_as.points_in_paint||0, atRimM: _as.field_goals_at_rim_made||0, atRimA: _as.field_goals_at_rim_att||0, paintM: _as.points_in_paint_made||0, paintA: _as.points_in_paint_att||0, fta: _as.free_throws_att||0, blk: _as.blocks||0, fd: _as.fouls_drawn||0, fgm: _as.field_goals_made||0, fga: _as.field_goals_att||0, fg3m: _as.three_points_made||0, fg3a: _as.three_points_att||0, ast: _as.assists||0, bigLead: _as.biggest_lead||0, bench: _as.bench_points||0, oppp: _as.offensive_points_per_possession||0, dppp: _as.defensive_points_per_possession||0, poss: _as.possessions||0, ftm: _as.free_throws_made||0, forced_to: pbpResult?.away?.tos?.forced||0, unforced_to: pbpResult?.away?.tos?.unforced||0, assisted_3pm: pbpResult?.away?.threes?.assisted||0, ...(game._wnbaV2?.away ? { pot_v2: game._wnbaV2.away.pot, paint_v2: game._wnbaV2.away.paint, fbp_v2: game._wnbaV2.away.fbp, scp_v2: game._wnbaV2.away.scp, poss_v2: game._wnbaV2.away.poss, v2_src: game._wnbaV2.away.src } : {}) },
              runs6: pbpResult?.runs6 ? { home: pbpResult.runs6.filter(r=>r.team===hA).length, away: pbpResult.runs6.filter(r=>r.team===aA).length, total: pbpResult.runs6.length } : null,
            });
          } catch (e) { /* non-fatal — snapshot still saves without raw stats */ }

          // ── MC TRAJECTORY: compute MC every poll Q2+ for snapshot storage ──
          var _pollMC = null;
          if (currentPeriod >= 2 && ind.controlTeam && ind.controlTeam !== 'Neither') {
            try {
              var _pmHBL = _clutchMap?.[hA]?.q4_fg3pct || _team3ptBaselines?.[hA] || 0.36;
              var _pmABL = _clutchMap?.[aA]?.q4_fg3pct || _team3ptBaselines?.[aA] || 0.36;
              var _pmPossLog = pbpResult?.possLog;
              var _pmRates = extractMCRatesFromPossLog(_pmPossLog, 20, hA, aA, _pmHBL, _pmABL);
              if (_pmRates && _pmRates.home._windowFGA >= 5 && _pmRates.away._windowFGA >= 5) {
                var _pmClk = String(clock||'6:00').match(/(\d+):(\d+)/);
                var _pmSec = _pmClk ? parseInt(_pmClk[1])*60+parseInt(_pmClk[2]) : 360;
                var _pmHS = summary.home?.statistics || {}, _pmAS = summary.away?.statistics || {};
                var _pmRemain = estimateRemainingPossMC(_pmHS, _pmAS, currentPeriod, _pmSec, league);
                if (_pmRemain > 0) {
                  var _pmCtrlHome = ind.controlTeam === hA;
                  var _pmResult = runMonteCarloSim(_pmRates.home, _pmRates.away,
                    Number(ind.homePts), Number(ind.awayPts), _pmRemain,
                    { simCount: 500, ctrlTeam: _pmCtrlHome ? 'home' : 'away' });
                  _pollMC = Math.round(_pmResult.winProb * 10000) / 10000;
                  log(`${matchup}: MC trajectory — wp=${_pollMC} remain=${_pmRemain} hFGA=${_pmRates.home._windowFGA} aFGA=${_pmRates.away._windowFGA}`);
                } else {
                  log(`${matchup}: MC skip — remainPoss=${_pmRemain}`);
                }
              } else {
                log(`${matchup}: MC skip — possLog=${_pmPossLog?.length || 'null'} rates=${!!_pmRates} hFGA=${_pmRates?.home?._windowFGA || '?'} aFGA=${_pmRates?.away?._windowFGA || '?'}`);
              }
            } catch (e) { log(`${matchup}: MC error — ${e.message}`); }
          }

          // ── MC CUMULATIVE: game-rate simulation (always-on Q2+) ──
          var _mcCum = null;
          if (currentPeriod >= 2 && ind.controlTeam && ind.controlTeam !== 'Neither') {
            try {
              var _mcHBL = _clutchMap?.[hA]?.q4_fg3pct || _team3ptBaselines?.[hA] || 0.36;
              var _mcABL = _clutchMap?.[aA]?.q4_fg3pct || _team3ptBaselines?.[aA] || 0.36;
              var _mcClk = String(clock||'6:00').match(/(\d+):(\d+)/);
              var _mcSec = _mcClk ? parseInt(_mcClk[1])*60+parseInt(_mcClk[2]) : 360;
              var _mcSrc = league === 'wnba' ? (modelSummary || summary) : summary;
              _mcCum = computeMCCumulative(_mcSrc, currentPeriod, _mcSec, ind.controlTeam, hA, _mcHBL, _mcABL, league);
              // MC Rate Decomposition — which rates drive the win probability
              if (_mcCum) {
                try {
                  var _mcCtrlHome = ind.controlTeam === hA;
                  var _mcCtrlSeasonRates = _teamSeasonRates?.[ind.controlTeam] || null;
                  _mcCum.drivers = computeMCDrivers(_mcCum, _mcCtrlHome,
                    Number(summary.home?.points || ind.homePts || 0),
                    Number(summary.away?.points || ind.awayPts || 0),
                    _mcCtrlSeasonRates, league);
                } catch (e) { /* non-fatal */ }
              }
            } catch (e) { log(`${matchup}: MC Cum error — ${e.message}`); }
          }

          // Read live_tracking for bwc_state + grad_rank (main lt not loaded until V2 section below)
          var _snapLT = null;
          try { const _ltR = await sql`SELECT live_tracking FROM games WHERE id = ${game.id}`; if (_ltR[0]?.live_tracking) _snapLT = typeof _ltR[0].live_tracking === 'string' ? JSON.parse(_ltR[0].live_tracking) : _ltR[0].live_tracking; } catch(e) {}
          await sql`
            INSERT INTO snapshots (game_id, period, clock, home_pts, away_pts,
              floor_score, floor_team, pbp_score, pbp_team, pbp_window_size,
              qtr_score, qtr_team, espn_wp_home, espn_wp_away,
              spread, deficit, trailing_team, lead_sust, gap, accel,
              i1, i2, i3, i4, i5, source, lead_class, sust_json,
              tp_class, tp_exp_swing, tp_remain_poss, ls_class, ls_exp_swing, raw_stats_json, espn_raw_stats_json,
              bwc_state, grad_rank, floor_wp_historical, reliability_class, window_score,
              xgb_win_prob, xgb_divergence, poss_window_score, mc_win_prob, mc_cum_win_prob, xgb_shap)
            VALUES (${game.id}, ${currentPeriod}, ${clock}, ${ind.homePts}, ${ind.awayPts},
              ${ind.score}, ${ind.controlTeam}, ${null}, ${null}, ${null},
              ${null}, ${null}, ${espnWP?.home || null}, ${espnWP?.away || null},
              ${spreadVal}, ${deficit}, ${trailingTeam}, ${leadSust}, ${null}, ${null},
              ${_ci[0]}, ${_ci[1]}, ${_ci[2]}, ${_ci[3]}, ${_ci[4]},
              ${'server'}, ${leadClass}, ${sustJson},
              ${snapTp?.classification || null}, ${snapTp ? Math.round(snapTp.expected.totalSwing * 10) / 10 : null}, ${snapTp?.remainingPoss || null}, ${snapLs?.classification || null}, ${snapLs ? Math.round(snapLs.expected.totalSwing * 10) / 10 : null}, ${rawStatsJson}, ${espnRawStatsJson},
              ${_snapLT?.bwc_fired ? (_snapLT._prev_bwc_state || null) : null}, ${_snapLT?.compound_tier || null},
              ${_floorWP.wp}, ${_floorWP.reliabilityClass}, ${_windowScore},
              ${_xgbWinProb != null ? Math.round(_xgbWinProb * 10000) / 10000 : null}, ${_xgbDivergence}, ${_possWindowScore}, ${_pollMC}, ${_mcCum?.winProb != null ? Math.round(_mcCum.winProb * 10000) / 10000 : null}, ${_xgbShap ? JSON.stringify(_xgbShap) : null})
            ON CONFLICT (game_id, period, clock, home_pts, away_pts) DO NOTHING
          `;
          log(`${matchup}: snapshot saved — floor:${ind.score} I1-5:${_ci[0]},${_ci[1]},${_ci[2]},${_ci[3]},${_ci[4]} tp:${snapTp?.classification||'-'} ls:${snapLs?.classification||'-'} xgb:${_xgbWinProb != null ? _xgbWinProb.toFixed(3) : '-'}`);

          // GAME_BRIEF seed (NARRATION_V2 D-9b) — first live poll of each WNBA game.
          // In-memory guard per warm invocation; the (game_id, alert_subtype) PK is the
          // real dedup. Row lands with narration_text NULL -> tail sweep narrates + pushes.
          if (WNBA_GAME_BRIEF_ON && league === 'wnba' && !_briefSeeded[game.id]) {
            try {
              await sql`INSERT INTO sweetspot_alerts (game_id, league, alert_subtype, alert_tier, period, clock, ntfy_sent)
                VALUES (${game.id}, ${league}, ${'GAME_BRIEF'}, ${'BRIEF'}, ${currentPeriod}, ${clock}, ${false})
                ON CONFLICT (game_id, alert_subtype) DO NOTHING`;
              _briefSeeded[game.id] = true;
            } catch (e) { log(`${matchup}: brief seed non-fatal: ${e.message}`); }
          }

          // Save odds to odds_history table if we got data
          if (odds) {
            try {
              await sql`
                INSERT INTO odds_history (game_id, home_spread, home_ml, away_ml, total, source)
                VALUES (${game.id}, ${odds.homeSpread != null ? parseFloat(odds.homeSpread) : null}, ${odds.homeML != null ? parseInt(odds.homeML) : null}, ${odds.awayML != null ? parseInt(odds.awayML) : null}, ${odds.total != null ? parseFloat(odds.total) : null}, ${odds.books ? 'odds-api' : 'server'})
              `;
            } catch (e) { /* odds_history table may not exist — non-fatal */ }
          }

          results.snapshots++;
          if (espnWP) results.espn++;
          if (odds) results.odds++;

          // ── QUARTER DATA: baseline capture (first poll with stats) ──
          // Saves boundaries["0"] so Q1 diffs are computable from game start.
          if (!game._qdBaselineSaved) {
            try {
              const qd = await readQuarterData(sql, game.id);
              if (!qd.boundaries['0']) {
                const homeStats = summary.home?.statistics || {};
                const awayStats = summary.away?.statistics || {};
                // Only save baseline if we actually have stats
                if (Object.keys(homeStats).length > 0 || Object.keys(awayStats).length > 0) {
                  qd.boundaries['0'] = {
                    ts: new Date().toISOString(),
                    home: extractBoundaryStats(homeStats),
                    away: extractBoundaryStats(awayStats),
                  };
                  await writeQuarterData(sql, game.id, qd);
                  log(`${matchup}: ★ quarter_data baseline captured (${Object.keys(homeStats).length} home fields, ${Object.keys(awayStats).length} away fields)`);
                }
              }
              game._qdBaselineSaved = true;
            } catch (e) {
              log(`${matchup}: quarter_data baseline failed: ${e.message}`);
            }
          }

          const bdlEnriched = (homeBdl.length > 0 || awayBdl.length > 0);
          log(`${matchup} Q${currentPeriod} ${clock} | ${ind.homePts}-${ind.awayPts} | ${ind.controlTeam} ${ind.score} | I:${_ci[0]}/${_ci[1]}/${_ci[2]}/${_ci[3]}/${_ci[4]} | sust:${leadSust || '?'} class:${leadClass || '?'}${bdlEnriched ? ' BDL✓' : ''}${spreadVal != null ? ` spd:${spreadVal}` : ''}${espnWP ? ` | WP:${espnWP.home}%` : ''}`);

          // ── LIGHTWEIGHT ENTRY SIGNAL CHECK (every cycle, no Sonnet needed) ──
          // BUY:  floor ≥ 0.65, trailing 1-15, Q2+, throughput not UNLIKELY/NO PATH
          // BWC:  floor ≥ 0.60, leading 2+, Q2+, edge > 0, lead safety not AT RISK/CRITICAL
          if (!cfg.dryRun) {
            // ── V2 LIVE TRACKING: read state, update peaks/holds, compute BWC + erosion ──
            var lt = {};
            try {
              const ltRows = await sql`SELECT live_tracking FROM games WHERE id = ${game.id}`;
              if (ltRows[0]?.live_tracking) {
                lt = typeof ltRows[0].live_tracking === 'string'
                  ? JSON.parse(ltRows[0].live_tracking) : ltRows[0].live_tracking;
              }
            } catch(e) { /* non-fatal — initialize fresh */ }

            lt = updateLiveTracking(lt, ind.controlTeam, ind.score, currentPeriod, clock, hA, currentPeriod);

            // ── SWEET-SPOT GATE COMPUTE (Phase 2a) — WNBA only; compute + store, NO alert (2b fires) ──
            // eFG from reliable box (fgm/fg3m/fga) — same source raw_stats_json serializes. Zone-sums
            // silently drop unparseable MISSED attempts → denominator shrinks → eFG inflates one-directionally
            // (+1.6pp avg / +5.2pp max vs box, n=18 live) → false fades. Box matches the client headline.
            // Variance-share stays on PBP zones (computeScoringComp, untouched — a made-points ratio).
            // A = deterministic pristine dual-gate; B left NULL (earned in the replay bucket analysis).
            // Isolated UPDATE (does NOT touch the snapshot INSERT or the NBA path); try/catch → never breaks polling.
            if (league === 'wnba' && !WNBA_SS_COMPUTE_OFF) {
              try {
                const _ssPbp = game._bdlPbp;
                if (_ssPbp && _ssPbp.home && _ssPbp.away) {
                  const _ssHp = Number(ind.homePts) || 0, _ssAp = Number(ind.awayPts) || 0;
                  const _ssSc = computeScoringComp(_ssPbp, hA, aA, _ssHp, _ssAp);
                  if (_ssSc) {
                    const _bEfg = function(st) {
                      var fgm = Number(st?.field_goals_made||st?.fgm||0)||0;
                      var fga = Number(st?.field_goals_att||st?.fga||0)||0;
                      var fg3m = Number(st?.three_points_made||st?.fg3m||0)||0;
                      return { efg: fga > 0 ? ((fgm + 0.5*fg3m)/fga*100) : null, fga: fga };
                    };
                    var _ssHe = _bEfg(summary.home?.statistics), _ssAe = _bEfg(summary.away?.statistics);
                    _ssSc.home.efgBox = _ssHe.efg; _ssSc.home.fga = _ssHe.fga;
                    _ssSc.away.efgBox = _ssAe.efg; _ssSc.away.fga = _ssAe.fga;
                    _ssSc.period = currentPeriod; _ssSc.clock = clock;
                    _ssSc.fadeRead = divergenceRead(_ssSc);

                    var _ssHomeTrails = _ssAp > _ssHp;
                    var _ssLeadAl = _ssHomeTrails ? aA : hA, _ssTrailAl = _ssHomeTrails ? hA : aA;
                    var _ssDeficit = Math.abs(_ssHp - _ssAp);
                    var _ssWp = function(al) { var r = ssStandings[al]; if (!r) return null; var gp = (r.w||0)+(r.l||0); return gp >= 4 ? (r.w/gp) : null; };
                    var _ssLeadWP = _ssWp(_ssLeadAl), _ssTrailWP = _ssWp(_ssTrailAl);
                    var _ssPr = comebackProb(_ssLeadWP, _ssTrailWP, _ssDeficit, currentPeriod, _ssSc.fadeRead);
                    var _ssTrailML = _ssHomeTrails ? (odds && odds.homeML) : (odds && odds.awayML);
                    var _ssEv = (_ssPr.pPoint != null) ? comebackEV(_ssPr.pPoint, _ssTrailML) : null;

                    var _ssFadeT = _ssSc.fadeRead ? _ssSc.fadeRead.tier : null;
                    var _ssCollT = _ssPr.tier;
                    var _ssClass = _ssSc.classification;
                    var _ssEdge = (_ssEv && _ssEv.edge != null) ? _ssEv.edge : null;
                    var _ssLeadEfg = _ssHomeTrails ? _ssSc.away.efgBox : _ssSc.home.efgBox;
                    var _ssLeadBand = _ssLeadEfg != null ? efgTier(_ssLeadEfg, currentPeriod).tier : null;
                    var _ssVar = _ssHomeTrails ? _ssSc.away.vPct : _ssSc.home.vPct;
                    var _ssGap = (_ssLeadWP != null && _ssTrailWP != null) ? (_ssTrailWP - _ssLeadWP) : null;
                    var _ssImplied = (_ssTrailML != null) ? americanToImplied(_ssTrailML) : null;
                    // Tier ladder (SWEETSPOT_TIER_BC_SPEC.md): A pristine → B one-soft/B3 →
                    // ledger shapes. Pure classifier; the snapshot records the SHAPE regardless
                    // of feature flags (same compute-vs-fire separation as the original A).
                    var _ssLad = ssClassifyTier(_ssEdge, currentPeriod, _ssDeficit, _ssCollT, _ssFadeT, _ssClass);
                    var _ssTier = _ssLad.tier;
                    var _ssFired = _ssTier != null;

                    await sql`UPDATE snapshots SET
                      ss_leader_alias = ${_ssLeadAl}, ss_leader_wp = ${_ssLeadWP}, ss_trailer_wp = ${_ssTrailWP},
                      ss_quality_gap = ${_ssGap}, ss_leader_efg = ${_ssLeadEfg != null ? Math.round(_ssLeadEfg*10)/10 : null},
                      ss_leader_efg_band = ${_ssLeadBand}, ss_variance_share = ${_ssVar != null ? _ssVar : null},
                      ss_lead_class = ${_ssClass}, ss_fade_tier = ${_ssFadeT}, ss_collapse_tier = ${_ssCollT},
                      ss_collapse_true = ${_ssPr.pPoint != null ? _ssPr.pPoint : null},
                      ss_line_used = ${_ssTrailML != null ? parseInt(_ssTrailML) : null}, ss_implied = ${_ssImplied},
                      ss_edge = ${_ssEdge != null ? Math.round(_ssEdge*100)/100 : null},
                      ss_kelly_size = ${_ssEv && _ssEv.size != null ? Math.round(_ssEv.size*10000)/10000 : null},
                      ss_alert_tier = ${_ssTier}, ss_alert_fired = ${_ssFired}
                      WHERE game_id = ${game.id} AND period = ${currentPeriod} AND clock = ${clock} AND home_pts = ${_ssHp} AND away_pts = ${_ssAp}`;
                    log(`${matchup}: SS — ${_ssLeadAl} +${_ssDeficit} | collapse=${_ssCollT} fade=${_ssFadeT} class=${_ssClass} band=${_ssLeadBand||'—'} edge=${_ssEdge != null ? _ssEdge.toFixed(1) : '—'} tier=${_ssTier || 'none'}`);

                    // ── 2b: fire the tier ladder — A live (WNBA_SS_ALERT_ON) · B behind
                    // WNBA_SS_B_ON · ledger rows behind WNBA_SS_LEDGER_ON · WATCHLIST behind
                    // WNBA_SS_WATCHLIST_ON. WATCHLIST is independent (band entry, Q2/Q3 only,
                    // gap ≥ .15, deficit 1-9); fired AFTER A/B so same-poll A/B suppresses it.
                    var _ssDoFire = (_ssTier === 'A' && WNBA_SS_ALERT_ON) || (_ssTier === 'B' && WNBA_SS_B_ON);
                    var _ssDoLedger = !_ssTier && _ssLad.ledgerSub != null && WNBA_SS_LEDGER_ON;
                    var _ssDoWatch = WNBA_SS_WATCHLIST_ON && _ssGap != null && _ssGap >= 0.15
                      && _ssDeficit >= 1 && _ssDeficit <= 9
                      && (currentPeriod === 2 || currentPeriod === 3);
                    if (_ssDoFire || _ssDoLedger || _ssDoWatch) {
                      var _ssLeadRec = ssStandings[_ssLeadAl] || {}, _ssTrailRec = ssStandings[_ssTrailAl] || {};
                      var _ssBestBook = _ssHomeTrails ? (odds && odds.homeMLBook) : (odds && odds.awayMLBook);
                      var _ssConsML = _ssHomeTrails ? (odds && odds.homeMLConsensus) : (odds && odds.awayMLConsensus);
                      // DS v1 C1 — fire-time fuel/temp read from the same reliable box the eFG
                      // gate uses (v2-corrected pot preferred). Stamped into player_ctx_json at
                      // fire; consumed by narration blocks, FUEL PULSE, and the CASH surge watch.
                      var _ssFuelTemp = null;
                      try {
                        var _ftBox = function(st, v2) { st = st || {}; return {
                          fgm: st.field_goals_made, fga: st.field_goals_att, fg3m: st.three_points_made,
                          ftm: st.free_throws_made, to: st.turnovers != null ? st.turnovers : st.total_turnovers,
                          pot: (v2 && v2.pot != null) ? v2.pot : st.points_off_turnovers }; };
                        var _ftL = _ftBox(_ssHomeTrails ? summary.away?.statistics : summary.home?.statistics,
                                          _ssHomeTrails ? game._wnbaV2?.away : game._wnbaV2?.home);
                        var _ftT = _ftBox(_ssHomeTrails ? summary.home?.statistics : summary.away?.statistics,
                                          _ssHomeTrails ? game._wnbaV2?.home : game._wnbaV2?.away);
                        _ftL.vShare = _ssVar != null ? _ssVar : null;
                        _ssFuelTemp = computeFuelTemp(_ftL, _ftT, currentPeriod);
                      } catch (e) { _ssFuelTemp = null; }
                      var _ssPayload = {
                        period: currentPeriod, clock: clock,
                        leaderAl: _ssLeadAl, trailerAl: _ssTrailAl, leaderWP: _ssLeadWP, trailerWP: _ssTrailWP, gap: _ssGap,
                        leaderW: _ssLeadRec.w, leaderL: _ssLeadRec.l, trailerW: _ssTrailRec.w, trailerL: _ssTrailRec.l,
                        leaderEfg: _ssLeadEfg, leaderBand: _ssLeadBand, varShare: _ssVar, leadClass: _ssClass,
                        fadeTier: _ssFadeT, collapseTier: _ssCollT, collapseTrue: _ssPr.pPoint, pLow: _ssPr.pLow, pHigh: _ssPr.pHigh,
                        bestML: _ssTrailML, bestBook: _ssBestBook, consensusML: _ssConsML, impliedBest: _ssImplied,
                        edge: _ssEdge, kellySize: (_ssEv && _ssEv.size != null ? _ssEv.size : null),
                        margin: _ssDeficit, books: (odds && odds.books) || 0,
                        fuelTemp: _ssFuelTemp, // DS v1 C1 — fire-time read, stamped by fireSweetSpotAlert
                      };
                      var _ssPctx = { modelSummary: modelSummary, pbp: game._bdlPbp };
                      if (_ssDoFire || _ssDoLedger) {
                        await fireSweetSpotAlert(sql, game, league, hA, aA, Object.assign({}, _ssPayload, {
                          subtype: _ssDoFire ? (_ssTier === 'A' ? 'EFG_FADE' : 'EFG_FADE_SOFT') : _ssLad.ledgerSub,
                          tier: _ssDoFire ? _ssTier : null, softCell: _ssLad.softCell, ledgerOnly: _ssDoLedger,
                        }), _ssPctx);
                      }
                      if (_ssDoWatch) {
                        await fireSweetSpotAlert(sql, game, league, hA, aA, Object.assign({}, _ssPayload, {
                          subtype: 'WATCHLIST', tier: null, softCell: null, ledgerOnly: false,
                        }), _ssPctx);
                      }
                    }
                  }
                }
              } catch (e) { log(`${matchup}: sweetspot compute non-fatal: ${e.message}`); }
            }

            // Persist biglead running max (computed before computeServer)
            if (game._trueBigLeadHome != null) lt._bigLeadHome = game._trueBigLeadHome;
            if (game._trueBigLeadAway != null) lt._bigLeadAway = game._trueBigLeadAway;
            if (game._qMaxMarginHome) lt._qMaxMarginHome = game._qMaxMarginHome;
            if (game._qMaxMarginAway) lt._qMaxMarginAway = game._qMaxMarginAway;

            // ── Save XGB + MC data to lt for client analysis injection ──
            if (_xgbFeatures) {
              lt.xgb_shap = _xgbShap;
              lt.conviction_quality = lt.xgb_shap ? computeConvictionQuality(lt.xgb_shap, league) : null;
              lt.xgb_trajectory = lt.xgb_shap ? computeTrajectorySignals(lt.xgb_shap, lt.checkpoints || [], lt.conviction_quality, _xgbWinProb, league) : null;
            }
            lt.xgb_win_prob = _xgbWinProb;
            lt.xgb_divergence = _xgbDivergence;
            lt.xgb_aligned = _xgbAligned;
            if (_pollMC != null) lt.mc_trajectory_wp = _pollMC;
            if (_mcCum != null) lt.mc_cum_wp = _mcCum.winProb;
            if (_mcCum?.drivers) lt.mc_drivers = _mcCum.drivers;

            // XGB from BWC team's perspective (for EXIT detection)
            // When BWC team IS ctrl team, reuse _xgbWinProb. Otherwise recompute with BWC as reference.
            var _xgbBwcProb = null;
            if (lt.bwc_fired && _xgbWinProb != null) {
              if (lt.bwc_fired.team === ind.controlTeam) {
                _xgbBwcProb = _xgbWinProb;
              } else {
                const _bwcInd = { ...ind, controlTeam: lt.bwc_fired.team };
                const _bwcFeatures = extractXGBFeatures(summary, _bwcInd, pbpResult, currentPeriod, clock, _windowResult?.rawAgg || null, league);
                _xgbBwcProb = _bwcFeatures ? predictXGB(_bwcFeatures, league) : null;
              }
            }

            // Quick ctrl-relative margin for v2 state machine (full margin computed below)
            const _v2CtrlIsHome = ind.controlTeam === hA;
            const _v2CtrlPts = _v2CtrlIsHome ? ind.homePts : ind.awayPts;
            const _v2OppPts = _v2CtrlIsHome ? ind.awayPts : ind.homePts;
            const _v2Margin = _v2CtrlPts - _v2OppPts; // positive = leading

            // ── BWC TRACKING DEATH — structural control lost ──
            // First poll where control flips away from tracked team = tracking dead.
            // Only fires when team is in TRACKING (pre-confirmation). Once compound-confirmed,
            // only XGB EXIT can close the position.
            if (lt.bwc_fired && ind.controlTeam !== lt.bwc_fired.team && ind.controlTeam !== 'Neither' && !lt.compound_confirmed) {
              const _deadTeam = lt.bwc_fired.team;
              const _deadHadPO = !!lt.po_fired;
              const _deadRank = lt.compound_tier || lt.cp_peak_rank || lt.po_fired?.tier || lt.po_fired?.rank || null;
              const _newCtrlTeam = ind.controlTeam;
              log(`${matchup}: ★ BWC DEATH — ${_deadTeam} lost structural control to ${_newCtrlTeam}. hadPO=${_deadHadPO} rank=${_deadRank} flips=${lt.ctrl_flips}`);

              // Clear all BWC-specific state
              lt.bwc_fired = null;
              lt.po_fired = null;
              lt._bwc_candidate = null;
              lt._bwc_candidate_holds = 0;
              lt._prev_bwc_state = null;
              lt._just_established = false;
              lt._tracking_sent = false;
              lt.bwc_flipped = false;
              lt.original_bwc_team = null;
              lt.cp_graduation = null;
              lt.cp_opp_graduation = null;
              lt.cp_peak_rank = null;
              lt.cp_mean_floor = null;
              lt.cp_min_floor = null;
              lt.cp_eligible_count = 0;
              lt.cp_ctrl_flips = 0;
              lt.cp_holds = 0;
              lt.cp_opp_holds = 0;
              lt.checkpoints = null;
              lt.xgb_exit_warned = null;
              lt.xgb_exit_sent = false;
              lt.xgb_exit_ts = null;
              lt.xgb_exit_xgb = null;
              lt.exit_trigger = null;
              lt.exit_mc = null;
              lt.xgb_recovery_warned = null;
              lt.position_closed = false;
              lt.position_closed_ts = null;
              // Compound confirmation state
              lt.compound_holds = 0;
              lt.compound_tier = null;
              lt.compound_confirmed = false;
              lt.compound_path = null;
              lt.compound_mc_at_confirm = null;
              lt.compound_last_period = null;
              lt.compound_last_clock = null;
              lt.compound_opp_last_period = null;
              lt.compound_opp_last_clock = null;

              // Mark as second BWC opportunity — bypasses Q3_6 gate for B-rank
              lt._is_second_bwc = true;
              lt._dead_team = _deadTeam;
              lt._dead_had_po = _deadHadPO;
              lt._dead_rank = _deadRank;

              // Persist immediately so next cycle sees clean state
              try { await sql`UPDATE games SET live_tracking = ${JSON.stringify(lt)} WHERE id = ${game.id}`; } catch(e) {}

              // TRACKING_INVALIDATED alert — mechanical, no agent
              if (!(WNBA_LEGACY_ALERTS_OFF && league === 'wnba')) {
              const _deathPosNote = _deadHadPO
                ? `\n${_deadTeam} had a ${(_deadRank || 'confirmed').toLowerCase()} position. The structural case supporting this position is gone. Consider exiting if you took this position.`
                : '';
              const _deathBody = `${aA} ${ind.awayPts}-${ind.homePts} ${hA} · Q${currentPeriod} ${clock}\n${_deadTeam} structural edge invalidated — control shifted to ${_newCtrlTeam}. Tracking on ${_deadTeam} stopped.${_deathPosNote}`;
              try {
                await sql`INSERT INTO alerts (game_id, league, alert_type, period, clock, control_team, floor_score, margin, is_trailing, alert_tier, agent_decision, agent_reasoning, i1, i2, i3, i4, i5, conviction_tier, conviction_combo, ntfy_sent, position_team, xgb_win_prob, xgb_aligned)
                  VALUES (${game.id}, ${league}, ${'TRACKING_INVALIDATED'}, ${currentPeriod}, ${clock}, ${_newCtrlTeam}, ${ind.score}, ${_v2Margin}, ${false}, ${'FIRED'}, ${'SEND'}, ${_deathBody}, ${ctrlI(ind)[0]}, ${ctrlI(ind)[1]}, ${ctrlI(ind)[2]}, ${ctrlI(ind)[3]}, ${ctrlI(ind)[4]}, ${conviction?.tier || null}, ${conviction?.combo || null}, ${true}, ${_deadTeam}, ${_xgbWinProb != null ? Math.round(_xgbWinProb * 10000) / 10000 : null}, ${_xgbAligned})`;
              } catch (e) { log(`${matchup}: TRACKING_INVALIDATED DB insert error: ${e.message}`); }
              await sendNtfy(`TRACKING INVALIDATED — ${matchup}`, _deathBody, 3);
              log(`${matchup}: TRACKING_INVALIDATED ntfy sent`);
              }
            }

            // ── V2 BWC candidate tracking (3-hold minimum for initial fire) ──
            // Q1 hold accumulation allowed; fire gated on Q2+
            // ── NBA: Compound establishment (MC + Floor at 0.65) ──
            // First poll where compound threshold is met → TRACKING + hold #1
            // NCAAMB: retains floor-based 3-hold candidate tracking
            if (!lt.bwc_fired && league === 'nba' && currentPeriod >= 2 && ind.controlTeam !== 'Neither') {
              const _estabMC = _mcCum?.winProb != null ? _mcCum.winProb : null;
              const _estabMet = _estabMC != null && _estabMC >= 0.80 && ind.score >= 0.65;
              const _estabQ2 = currentPeriod !== 2 || (_v2Margin >= 5 && (lt.ctrl_flips_q2plus || 0) === 0);

              if (_estabMet && _estabQ2) {
                lt.bwc_fired = { team: ind.controlTeam, period: currentPeriod, clock, floor: ind.score };
                lt._prev_bwc_state = _v2Margin >= 3 ? 'LOCK' : 'EDGE';
                lt._just_established = true;
                // Seed compound — this poll is hold #1
                lt.compound_holds = 1;
                lt.compound_last_period = currentPeriod;
                lt.compound_last_clock = clock;
                log(`${matchup}: ★ COMPOUND ESTABLISHMENT — ${ind.controlTeam} MC=${_estabMC.toFixed(3)} floor=${ind.score.toFixed(2)} margin=${_v2Margin} Q${currentPeriod} ${clock}${_xgbWinProb != null ? ' xgb=' + _xgbWinProb.toFixed(3) : ''}`);
              }
            } else if (!lt.bwc_fired && league === 'wnba' && currentPeriod >= 2 && ind.controlTeam !== 'Neither') {
              // WNBA: MC Cum + XGB compound (floor demoted to narrative)
              const _estabMC = _mcCum?.winProb != null ? _mcCum.winProb : null;
              const _estabXGB = _xgbWinProb;
              const _estabMet = _estabMC != null && _estabMC >= 0.80
                             && _estabXGB != null && _estabXGB >= 0.60;
              const _estabQ2 = currentPeriod !== 2 || (_v2Margin >= 5 && (lt.ctrl_flips_q2plus || 0) === 0);

              if (_estabMet && _estabQ2) {
                lt.bwc_fired = { team: ind.controlTeam, period: currentPeriod, clock, floor: ind.score };
                lt._prev_bwc_state = _v2Margin >= 3 ? 'LOCK' : 'EDGE';
                lt._just_established = true;
                lt.compound_holds = 1;
                lt.compound_last_period = currentPeriod;
                lt.compound_last_clock = clock;
                log(`${matchup}: ★ WNBA COMPOUND ESTABLISHMENT — ${ind.controlTeam} MC=${_estabMC.toFixed(3)} XGB=${_estabXGB.toFixed(3)} floor=${ind.score.toFixed(2)} margin=${_v2Margin} Q${currentPeriod} ${clock}`);
              }
            } else if (!lt.bwc_fired && league !== 'nba' && league !== 'wnba' && ind.score >= 0.60 && _v2Margin >= 2) {
              // NCAAMB: floor-based BWC candidate tracking
              if (lt._bwc_candidate === ind.controlTeam) {
                lt._bwc_candidate_holds = (lt._bwc_candidate_holds || 0) + 1;
              } else {
                lt._bwc_candidate = ind.controlTeam;
                lt._bwc_candidate_holds = 1;
              }
              if (lt._bwc_candidate_holds >= 3 && currentPeriod >= 2) {
                if (_xgbWinProb != null && _xgbWinProb < 0.40) {
                  log(`${matchup}: XGB GATE — blocking BWC establishment (xgb=${_xgbWinProb.toFixed(3)}, floor=${ind.score.toFixed(2)}, holds=${lt._bwc_candidate_holds})`);
                } else {
                  lt.bwc_fired = { team: ind.controlTeam, period: currentPeriod, clock, floor: ind.score };
                  lt._prev_bwc_state = _v2Margin >= 3 ? 'LOCK' : 'EDGE';
                  lt._just_established = true;
                  log(`${matchup}: ★ V2 BWC FIRED — ${ind.controlTeam} floor ${ind.score.toFixed(2)} margin ${_v2Margin} state ${lt._prev_bwc_state}${_xgbWinProb != null ? ' xgb=' + _xgbWinProb.toFixed(3) : ''}`);
                }
              }
            } else if (!lt.bwc_fired && league !== 'nba' && league !== 'wnba' && ind.controlTeam !== lt._bwc_candidate) {
              lt._bwc_candidate = null;
              lt._bwc_candidate_holds = 0;
            }

            // ── PREGAME ML / LANE CAPTURE (first odds reading after BWC fire) ──
            if (lt.bwc_fired && lt.pregame_ml == null && odds) {
              const bwcIsHome = lt.bwc_fired.team === hA;
              lt.pregame_ml = bwcIsHome ? odds.homeML : odds.awayML;

              const ml = lt.pregame_ml;
              if (ml == null) lt.lane = 'tossup';
              else if (ml > 100) lt.lane = 'underdog';
              else if (ml >= -150) lt.lane = 'tossup';
              else if (ml >= -300) lt.lane = 'favorite';
              else lt.lane = 'heavy_favorite';

              log(`${matchup}: Lane: ${lt.lane} (pregame ML ${ml > 0 ? '+' : ''}${ml})`);
            }

            let v2BwcState = computeBwcState(lt, ind.controlTeam, _v2Margin);
            const v2Erosion = computeErosion(lt, ind.score, hA, ind.controlTeam);
            var meanErosion = computeMeanErosion(lt, ind.score, hA, ind.controlTeam);

            // ── SHARED COMPUTATIONS (control-team-relative, used by all alert paths) ──
            const ctrlSide = ind.controlTeam === hA ? 'home' : 'away';
            const oppSide = ctrlSide === 'home' ? 'away' : 'home';
            const ctrlSust = sust?.[ctrlSide]?.tier || null;
            const oppSustTier = sust?.[oppSide]?.tier || null;
            const ctrlIsHome = ind.controlTeam === hA;
            const ctrlPtsA = ctrlIsHome ? ind.homePts : ind.awayPts;
            const oppPtsA = ctrlIsHome ? ind.awayPts : ind.homePts;
            const ctrlTrailing = oppPtsA > ctrlPtsA;
            const ctrlLeading = ctrlPtsA > oppPtsA;
            const margin = Math.abs(ctrlPtsA - oppPtsA);

            // Compute edge: floor (structural win prob) minus market implied probability
            let ctrlEdge = null;
            let ctrlML = null;
            let garbageLine = false;
            if (odds && (odds.homeML || odds.awayML)) {
              const hML = parseFloat(odds.homeML), aML = parseFloat(odds.awayML);
              garbageLine = (Math.abs(hML) >= 50000 || Math.abs(aML) >= 50000 || hML === aML);
              if (!garbageLine) {
                ctrlML = ctrlIsHome ? odds.homeML : odds.awayML;
                const ctrlMIP = mlToProb(ctrlML);
                if (ctrlMIP != null) {
                  ctrlEdge = (ind.score * 100) - (ctrlMIP * 100);
                  ctrlEdge = Math.round(ctrlEdge * 10) / 10;
                }
              }
            }

            // Compute lead safety for BWC context
            let lsForBWC = null;
            if (ctrlLeading && margin >= 2) {
              lsForBWC = computeLeadSafetyServer(summary, ind, sust, hA, aA, currentPeriod, clock, league, gameVolumeThreat);
            }

            // Compute throughput for BUY context
            let tpForBuy = null;
            if (ctrlTrailing && margin >= 1) {
              try { tpForBuy = computeThroughputServer(summary, ind, sust, hA, aA, currentPeriod, clock, league, gameVolumeThreat); }
              catch (e) { log(`${matchup}: throughput compute failed in alert gate: ${e.message}`); }
            }

            // Clock computation for alert time gates
            const alertClockParts = clock.replace(/^[A-Za-z]+\s*/, '').split(':');
            const alertPeriodMins = league === 'ncaamb' ? 20 : league === 'wnba' ? 10 : 12;
            const alertClockMins = alertClockParts.length === 2 ? (parseInt(alertClockParts[0]) || 0) + ((parseInt(alertClockParts[1]) || 0) / 60) : alertPeriodMins;
            const alertTotalPeriods = league === 'ncaamb' ? 2 : 4;
            const alertMinsLeft = alertClockMins + (Math.max(0, alertTotalPeriods - currentPeriod) * alertPeriodMins);

            // Ctrl-relative indicator computation (shared by all alert paths)
            const _indNames = ['I1','I2','I3','I4','I5'];
            const _ctrlInd = _indNames.filter((n, i) => _ci[i] != null && _ci[i] >= 0.55);
            const _oppIndW = _indNames.filter((n, i) => _ci[i] != null && _ci[i] <= 0.45);
            const _oppI3Won = _oppIndW.length >= 1 && _oppIndW.includes('I3');

            // Lazy-computed server context for alert agent (rolling window, combined read, per-quarter data)
            // Computed on first routeV2Alert call, cached for subsequent calls in same cycle
            let alertCtx = null;

            // ── V2 ALERT ROUTING HELPER ──
            // Assembles context, calls agent with v2 prompt, sends ntfy, writes DB
            async function routeV2Alert(v2Type, v2Tier, v2ExitSev, v2IsBuy) {
              // PHASE 1: WNBA legacy alerts off → skip the entire main-alert path
              // (PENDING lock-row, agent Opus call @runAlertAgent, alert ntfy) up front.
              if (WNBA_LEGACY_ALERTS_OFF && league === 'wnba') return { decision: 'LEGACY_OFF', sent: false };
              // Map alert type → ntfy title
              const V2_TITLE_MAP = {
                'TRACKING': 'TRACKING',
                'POSITION_OPEN': 'POSITION OPEN',
                'BWC_EDGE': 'LEAD COMPRESSING',
                'VALUE': 'ENTRY VALUE',
                'EXIT': 'EXIT',
                'THESIS_ALIVE': 'SECOND CHANCE',
                'POSITION_RECOVERING': 'STRENGTHENING',
                'POSITION_SAFE': 'POSITION SAFE',
                'BUY': 'BUY',
                'MC_COLLAPSE': 'MC_COLLAPSE',
              };

              const scoreLine = `${aA} ${ind.awayPts}-${ind.homePts} ${hA} · Q${currentPeriod} ${clock}`;
              const mlStr = ctrlML ? ` ML ${ctrlML}` : '';
              const tierTag = v2Tier === 'CANDIDATE' ? ' [CANDIDATE]' : '';
              const bwcTeam = lt.bwc_fired?.team || null;

              // ntfy title
              let ntfyTitle;
              if (v2Type === 'TRACKING') {
                ntfyTitle = `TRACKING — ${bwcTeam || ind.controlTeam} Q${currentPeriod} ${clock}`;
              } else if (v2Type === 'POSITION_OPEN') {
                const rankStr = lt.po_fired?.rank ? ` (${lt.po_fired.rank})` : '';
                const laneTag = lt.lane === 'underdog' ? ' [DOG]' : lt.lane === 'heavy_favorite' ? ' [HF]' : '';
                const flipTag = lt.po_fired?.flipped ? ' [FLIP]' : '';
                ntfyTitle = `POSITION OPEN${rankStr}${laneTag}${flipTag} — ${bwcTeam || ind.controlTeam}${mlStr}`;
              } else if (v2IsBuy) {
                const flipTag = lt._flipBuyContext ? ' [FLIP]' : '';
                ntfyTitle = `BUY${tierTag}${flipTag} ${ind.controlTeam}${mlStr}`;
              } else if (v2Type === 'EXIT') {
                ntfyTitle = `EXIT — ${matchup}`;
              } else {
                ntfyTitle = `${V2_TITLE_MAP[v2Type] || v2Type}${tierTag} — ${bwcTeam || ind.controlTeam}${mlStr}`;
              }

              // Gather DB context (floor history with source=server, prior alerts)
              const agentCtx = await gatherAgentContext(sql, game.id, matchup);

              // Lazy-compute server context (rolling window, combined read, per-quarter data)
              if (!alertCtx) {
                try {
                  alertCtx = await computeServerContext(sql, game, league, summary, ind, espnWP, hA, aA, currentPeriod, clock, matchup, sust, odds);
                } catch (e) { log(`${matchup}: alert context compute failed: ${e.message}`); }
              }

              // Build v2 agent prompt context
              const mfTraj = lt.bwc_fired ? computeMFTrajectory(lt.checkpoints || [], lt.bwc_fired.team) : null;
              // Mean erosion for all alerts (PO uses peak, transitions+BUY use mean)
              // meanErosion already computed at cycle level above
              // Full CP trend (all checkpoints, no filter), floor-margin divergence, conviction trend
              const fullCPTrend = lt.bwc_fired ? computeFullCPTrend(lt.checkpoints || [], lt.bwc_fired.team) : null;
              const _bwcMarginForFM = lt.bwc_fired ? (lt.bwc_fired.team === hA ? (ind.homePts - ind.awayPts) : (ind.awayPts - ind.homePts)) : _v2Margin;
              const floorMarginSig = lt.bwc_fired ? computeFloorMarginSignal(lt.checkpoints || [], lt.bwc_fired.team, ind.score, _bwcMarginForFM) : null;
              const convTrend = lt.bwc_fired ? computeConvictionTrend(lt.checkpoints || [], lt.bwc_fired.team) : null;
              // Conviction quality — compute SHAP once, reuse for xgbShap + conviction quality + trajectory
              const _v2Shap = _xgbFeatures ? computeXGBContributions(_xgbFeatures, league) : null;
              const _v2ConvQuality = _v2Shap ? computeConvictionQuality(_v2Shap, league) : null;
              const _v2TrajSignals = _v2Shap ? computeTrajectorySignals(_v2Shap, lt.checkpoints || [], _v2ConvQuality, _xgbWinProb, league) : null;
              // ── XGB-MC divergence classification ──
              // NBA: validated May 13 (14,440 checkpoints, 1,233 games, close-game analysis)
              // WNBA: validated May 8 (3,432 checkpoints, 312 games, compound signal analysis)
              var _xgbMcGap = null, _xgbMcClass = null, _failureProfile = false, _mcOnlyFailure = false;
              if (_xgbWinProb != null && _mcCum?.winProb != null) {
                _xgbMcGap = _xgbWinProb - _mcCum.winProb;  // positive = XGB higher
                if (_xgbMcGap > 0.10)       _xgbMcClass = 'XGB_LEADS';
                else if (_xgbMcGap < -0.10) _xgbMcClass = 'MC_LEADS';
                else                        _xgbMcClass = 'CONVERGED';
              }
              // Failure profile: split by XGB agreement
              // True failure = BOTH MC and XGB disagree with floor (genuine structural erosion)
              // MC-only failure = MC low but XGB confirms (margin pressure, not structural decay)
              if (ind.score >= 0.65) {
                const _fpMcLow = _mcCum?.winProb != null && _mcCum.winProb < 0.60;
                const _fpXgbLow = _xgbWinProb != null && _xgbWinProb < 0.50;
                if (_fpMcLow && _fpXgbLow) {
                  _failureProfile = true;   // Both models disagree — true structural erosion
                } else if (_fpMcLow && !_fpXgbLow) {
                  _mcOnlyFailure = true;    // MC depressed but XGB confirms structure
                } else if (!_fpMcLow && _fpXgbLow) {
                  _failureProfile = true;   // XGB low is structural — treat as failure
                }
              }
              const v2Ctx = {
                alertType: v2Type, alertTier: v2Tier,
                ctrlTeam: ind.controlTeam, floor: ind.score.toFixed(2),
                margin: _v2Margin, // signed: positive = leading
                awayAlias: aA, homeAlias: hA,
                awayPts: ind.awayPts, homePts: ind.homePts,
                ctrlIsHome, league,
                period: currentPeriod, clock,
                bwcTeam,
                i1: _ci[0]?.toFixed(2),
                i2: _ci[1]?.toFixed(2),
                i3: _ci[2]?.toFixed(2),
                i4: _ci[3]?.toFixed(2),
                i5: _ci[4]?.toFixed(2),
                ctrlIndicators: _ctrlInd.join('+') || 'none',
                ctrlIndicatorCount: _ctrlInd.length,
                ctrlSust, oppSust: oppSustTier,
                tpClass: tpForBuy?.classification || null,
                lsClass: lsForBWC?.classification || null,
                oppIndicatorCount: _oppIndW.length,
                oppIndicatorsWon: _oppIndW.join('+') || 'none',
                oppI3Won: _oppI3Won,
                peakFloor: v2Erosion.peakFloor,
                peakDelta: v2Erosion.peakDelta,
                meanFloor: typeof meanErosion !== 'undefined' && meanErosion ? meanErosion.meanFloor : null,
                meanDelta: typeof meanErosion !== 'undefined' && meanErosion ? meanErosion.meanDelta : null,
                erosionLevel: v2Type === 'POSITION_OPEN' ? v2Erosion.level : (typeof meanErosion !== 'undefined' && meanErosion ? meanErosion.level || v2Erosion.level : v2Erosion.level),
                peakErosionLevel: v2Erosion.level,
                consecutiveHolds: lt.ctrl_team_holds || 0,
                bwcState: v2BwcState || lt._prev_bwc_state,
                bwcFirePeriod: lt.bwc_fired?.period,
                bwcFireFloor: lt.bwc_fired?.floor,
                floorHistory: agentCtx.floorHistory,
                priorAlertTrail: agentCtx.priorAlerts,
                // Structural stress context (from computeServerContext)
                windowData: alertCtx?.rollingWindow || null,
                quarterDiffs: alertCtx?.quarterDiffs || null,
                accelData: alertCtx?.acceleration || null,
                combinedRead: alertCtx?.combinedRead || null,
                // Compound confirmation context (replaces checkpoint graduation)
                compoundTier: lt.compound_tier || 'TRACKING',
                compoundHolds: lt.compound_holds || 0,
                compoundPath: lt.compound_path || null,
                mcCumAtConfirmation: lt.compound_mc_at_confirm || null,
                priorFlips: lt.cp_ctrl_flips || 0,
                ctrlFlips: lt.ctrl_flips || 0,
                cpCtrlFlips: lt.cp_ctrl_flips || 0,
                pregameML: lt.pregame_ml || null,
                lane: lt.lane || null,
                mfTrajectory: mfTraj,
                fullCPTrend: fullCPTrend,
                floorMarginSignal: floorMarginSig,
                convictionTrend: convTrend,
                bwcFlipped: lt.bwc_flipped || false,
                isSecondBwc: lt._is_second_bwc || false,
                deadTeam: lt._dead_team || null,
                deadHadPO: lt._dead_had_po || false,
                deadRank: lt._dead_rank || null,
                positionClosed: lt.position_closed || false,
                originalBwcTeam: lt.original_bwc_team || null,
                // Flip buy context (BUY fires for opponent after EXIT sent on BWC team)
                isFlipBuy: !!(v2IsBuy && lt._flipBuyContext),
                flipBuyContext: lt._flipBuyContext || null,
                // BUY-opened position context
                buyOpenPeriod: lt._buy_open_period || null,
                buyPosition: lt.buy_position || null,
                // Floor reliability
                floorWPHistorical: _floorWP.wp,
                reliabilityClass: _floorWP.reliabilityClass,
                floorGrip: _floorWP.grip,
                // XGBoost structural model
                xgbWinProb: _xgbWinProb != null ? Math.round(_xgbWinProb * 1000) / 1000 : null,
                xgbDivergence: _xgbDivergence,
                xgbAligned: _xgbAligned,
                xgbShap: _v2Shap,
                xgbBwcProb: _xgbBwcProb != null ? Math.round(_xgbBwcProb * 1000) / 1000 : null,
                exitSeverity: v2ExitSev || null,
                // XGB conviction quality (how XGB arrives at its prediction)
                convictionQuality: _v2ConvQuality,
                trajectorySignals: _v2TrajSignals,
                // MC structural investigation context (replaces vulnerability)
                mcInvestigation: lt.mc?.triggered ? {
                  active: true,
                  pattern: lt.mc.pattern,
                  verdicts: lt.mc.verdicts,
                  trigger_period: lt.mc.trigger_period,
                  trigger_clock: lt.mc.trigger_clock,
                  trigger_margin: lt.mc.trigger_margin,
                  trigger_floor: lt.mc.trigger_floor,
                  trigger_xgb: lt.mc.trigger_xgb,
                  trigger_mc: lt.mc.trigger_mc,
                  current_mc: lt.mc.current_mc,
                  ctrl_team: lt.mc.ctrl_team,
                  alert_sent: lt.mc.alert_sent,
                  prior_investigations: lt.mc.prior_investigations || 0,
                } : null,
                mcTrajectoryWp: lt.mc_trajectory_wp != null ? lt.mc_trajectory_wp : null,
                mcCumWp: _mcCum?.winProb != null ? Math.round(_mcCum.winProb * 1000) / 1000 : (lt.mc_cum_wp != null ? lt.mc_cum_wp : null),
                mcDrivers: _mcCum?.drivers || lt.mc_drivers || null,
                // XGB-MC divergence context (validated May 13 NBA, May 8 WNBA)
                xgbMcGap: _xgbMcGap,
                xgbMcClass: _xgbMcClass,
                failureProfile: _failureProfile,
                mcOnlyFailure: _mcOnlyFailure,
              };

              // DB-level dedup — catch concurrent invocations BEFORE burning agent tokens
              // Checks for ANY recent alert row (including PENDING lock rows from concurrent invocations)
              let _dbDedupSkip = false;
              try {
                const dbDedup = await sql`SELECT 1 FROM alerts WHERE game_id = ${game.id} AND alert_type = ${v2Type} AND ts > NOW() - INTERVAL '60 seconds' LIMIT 1`;
                if (dbDedup.length > 0) {
                  log(`${matchup}: ${v2Type} DB-deduped — skipping agent call`);
                  _dbDedupSkip = true;
                }
              } catch(e) { /* non-fatal — fail-open */ }

              if (_dbDedupSkip) {
                // Still record the alert for audit trail but skip agent + ntfy
                try {
                  await sql`INSERT INTO alerts (game_id, league, alert_type, period, clock, control_team, floor_score, margin, is_trailing, alert_tier, agent_decision, agent_reasoning, ntfy_sent, position_team)
                    VALUES (${game.id}, ${league}, ${v2Type}, ${currentPeriod}, ${clock}, ${ind.controlTeam}, ${ind.score}, ${_v2Margin}, ${ctrlTrailing}, ${v2Tier}, ${'DB_DEDUP'}, ${'Concurrent invocation already sent — agent call skipped'}, ${false}, ${v2Type === 'EXIT' ? (lt.bwc_fired?.team || ind.controlTeam) : ind.controlTeam})`;
                } catch(e) { /* non-fatal */ }
                return { decision: 'DB_DEDUP', sent: false };
              }

              // Insert lock row immediately — concurrent invocations will hit this in dedup check
              let _lockRowId = null;

              // ── XGB GATE (Phase 2) — hard suppress before burning agent tokens ──
              const _xgbGatesEnabled = process.env.XGB_GATES_ENABLED === 'true';
              let _xgbGateSuppress = false;
              if (_xgbGatesEnabled && _xgbWinProb != null) {
                // BUY: quarter-tiered XGB gate (Q4 mid-tier BUYs are 29-38% — money losers)
                // Q2: XGB < 0.40 suppress (76% above, 59% below)
                // Q3: XGB < 0.45 suppress (73% above, 63% below)
                // Q4: XGB < 0.60 suppress (50% at 0.55-0.70, 38% at 0.40-0.55, 29% below)
                if (v2Type === 'BUY') {
                  const buyXgbFloor = league === 'wnba'
                    ? (currentPeriod >= 4 ? 0.55 : 0.45)  // WNBA: Q4 gate lowered from 0.70 (two suppressed BUYs won)
                    : (currentPeriod >= 4 ? 0.60 : currentPeriod >= 3 ? 0.45 : 0.40);  // NBA
                  if (_xgbWinProb < buyXgbFloor) {
                    _xgbGateSuppress = true;
                    log(`${matchup}: XGB GATE — suppressing BUY Q${currentPeriod} (xgb=${_xgbWinProb.toFixed(3)}, threshold=${buyXgbFloor}, floor=${ind.score})`);
                  }
                }
                // BWC: flat XGB < 0.40
                if (v2Type === 'BWC' && _xgbWinProb < 0.40) {
                  _xgbGateSuppress = true;
                  log(`${matchup}: XGB GATE — suppressing ${v2Type} (xgb=${_xgbWinProb.toFixed(3)}, floor=${ind.score})`);
                }
                // POSITION_SAFE with XGB < 0.50 → don't confirm a position XGB doubts
                if (v2Type === 'POSITION_SAFE' && _xgbWinProb < 0.50) {
                  _xgbGateSuppress = true;
                  log(`${matchup}: XGB GATE — suppressing ${v2Type} (xgb=${_xgbWinProb.toFixed(3)})`);
                }
              }

              if (_xgbGateSuppress) {
                try {
                  await sql`INSERT INTO alerts (game_id, league, alert_type, period, clock, control_team, floor_score, margin, is_trailing, alert_tier, agent_decision, agent_reasoning, ntfy_sent, position_team, xgb_win_prob, xgb_aligned)
                    VALUES (${game.id}, ${league}, ${v2Type}, ${currentPeriod}, ${clock}, ${ind.controlTeam}, ${ind.score}, ${_v2Margin}, ${ctrlTrailing}, ${v2Tier}, ${'XGB_SUPPRESS'}, ${'XGBoost structural model at ' + (_xgbWinProb * 100).toFixed(1) + '% — below gate threshold. Floor ' + ind.score + ' diverges from raw stats read.'}, ${false}, ${v2Type === 'EXIT' ? (lt.bwc_fired?.team || ind.controlTeam) : ind.controlTeam}, ${Math.round(_xgbWinProb * 10000) / 10000}, ${_xgbAligned})`;
                } catch(e) { /* non-fatal */ }
                return { decision: 'XGB_SUPPRESS', sent: false };
              }

              try {
                const _lr = await sql`INSERT INTO alerts (game_id, league, alert_type, period, clock, control_team, floor_score, margin, is_trailing, alert_tier, agent_decision, agent_reasoning, ntfy_sent, position_team)
                  VALUES (${game.id}, ${league}, ${v2Type}, ${currentPeriod}, ${clock}, ${ind.controlTeam}, ${ind.score}, ${_v2Margin}, ${ctrlTrailing}, ${v2Tier}, ${'PENDING'}, ${'Agent call in progress'}, ${false}, ${v2Type === 'EXIT' ? (lt.bwc_fired?.team || ind.controlTeam) : ind.controlTeam})
                  RETURNING id`;
                _lockRowId = _lr[0]?.id;
              } catch(e) { log(`${matchup}: lock row insert failed: ${e.message}`); }

              const v2Prompt = buildV2AgentPrompt(v2Ctx);
              const agentResult = await runAlertAgent(v2Ctx, v2Prompt, 600);

              let agentDecision = null, agentReasoning = '', shouldSend = false;
              let alertPriority = v2Type === 'EXIT' ? 5 : v2Type === 'BUY' ? 5 : 4;

              if (agentResult) {
                agentDecision = agentResult.decision;
                agentReasoning = agentResult.reasoning;
                if (agentDecision === 'SEND') {
                  shouldSend = true;
                } else if (agentDecision === 'DOWNGRADE') {
                  shouldSend = true;
                  alertPriority = Math.max(2, alertPriority - 1);
                } else {
                  shouldSend = false;
                }
                log(`${matchup}: Agent ${agentDecision} ${v2Tier} ${v2Type} — ${agentReasoning}`);
                if (agentResult.usage) {
                  log(`${matchup}: Agent tokens — in:${agentResult.usage.input_tokens} out:${agentResult.usage.output_tokens}`);
                }
              } else {
                // Agent failed — FIRED sends as-is, CANDIDATE drops
                shouldSend = (v2Tier === 'FIRED');
                agentDecision = v2Tier === 'FIRED' ? 'FALLBACK_SEND' : 'FALLBACK_DROP';
                log(`${matchup}: Agent unavailable — ${agentDecision} for ${v2Tier} ${v2Type}`);
              }

              if (shouldSend) {
                let ntfyBody = (agentResult?.body && agentResult.body.length > 20)
                  ? scoreLine + '\n' + agentResult.body
                  : scoreLine + '\n' + ind.controlTeam + ' structural floor ' + ind.score.toFixed(2)
                    + ', ' + _ctrlInd.length + '/5 indicators (' + (_ctrlInd.join('+') || 'none') + ')'
                    + (ctrlEdge != null ? '\nEdge: ' + (ctrlEdge > 0 ? '+' : '') + ctrlEdge + '% over market' : '');
                if (_floorWP.reliabilityClass === 'WEAK' || _floorWP.reliabilityClass === 'BROKEN') {
                  ntfyBody += '\nNote: ' + ind.controlTeam + ' structural reads have been less reliable in close games historically. Elevated uncertainty on this signal.';
                }
                await sendNtfy(ntfyTitle, ntfyBody, alertPriority);

                // Track last sent alert type for XGB invalidation gating
                lt.last_send_type = v2Type;

                // Post-EXIT position gate: close position when EXIT SENT, re-open on any RECOVERING alert SENT
                if (v2Type === 'EXIT') {
                  lt.position_closed = true;
                  lt.position_closed_ts = Date.now();
                  log(`${matchup}: Position CLOSED — EXIT sent, suppressing degrading alerts until recovery`);
                } else if (['THESIS_ALIVE', 'POSITION_OPEN', 'POSITION_RECOVERING', 'POSITION_SAFE'].includes(v2Type)) {
                  lt.position_closed = false;
                  log(`${matchup}: Position RE-OPENED — ${v2Type} sent, position updates resume`);
                } else if (v2IsBuy) {
                  // BUY SEND — track position independently, does NOT activate V2 state machine
                  const buyTeam = ind.controlTeam;
                  const _buyWarm = !!(lt.bwc_fired && lt.bwc_fired.team === buyTeam);

                  // Ensure bwc_fired tracks the buy team
                  if (!lt.bwc_fired) {
                    // Cold BUY — no prior BWC tracking
                    lt.bwc_fired = { team: buyTeam, period: currentPeriod, clock, floor: ind.score };
                    log(`${matchup}: Cold BUY — bwc_fired created for ${buyTeam}`);
                  } else if (lt.bwc_fired.team !== buyTeam) {
                    // BUY on different team — flip BWC tracking
                    lt.original_bwc_team = lt.original_bwc_team || lt.bwc_fired.team;
                    lt.bwc_fired = { team: buyTeam, period: currentPeriod, clock, floor: ind.score };
                    lt.bwc_flipped = true;
                    // Clear stale graduation/compound data from old team
                    lt.checkpoints = [];
                    lt.cp_graduation = null;
                    lt.cp_opp_graduation = null;
                    lt.cp_peak_rank = null;
                    lt.cp_mean_floor = null;
                    lt.cp_min_floor = null;
                    lt.cp_eligible_count = 0;
                    lt.cp_ctrl_flips = 0;
                    // Clear compound state (old team's confirmation doesn't apply to new team)
                    lt.compound_holds = 0;
                    lt.compound_tier = null;
                    lt.compound_confirmed = false;
                    lt.compound_path = null;
                    lt.compound_mc_at_confirm = null;
                    lt.compound_last_period = null;
                    lt.compound_last_clock = null;
                    // Clear checkpoint table for this game (old team's data is stale)
                    try { await sql`DELETE FROM game_checkpoints WHERE game_id = ${game.id}`; } catch(e) {}
                    log(`${matchup}: BUY flipped BWC ${lt.original_bwc_team} → ${buyTeam}, stale graduation data cleared`);
                  }

                  // Track BUY position independently — does NOT activate V2 state machine
                  // Exit path is XGB_INVALIDATED, not V2 EXIT. PO graduation runs independently.
                  lt.buy_position = { team: buyTeam, period: currentPeriod, clock, warm: _buyWarm, xgb: _xgbWinProb, flip: !!lt._flipBuyContext };
                  lt._buy_open_period = currentPeriod;

                  // XGB invalidation tracking — monitor for thesis collapse after BUY
                  lt.buy_send_xgb = _xgbWinProb;
                  lt.buy_send_period = currentPeriod;
                  lt.buy_invalidated = false;
                  log(`${matchup}: BUY position tracked — ${buyTeam} (${_buyWarm ? 'WARM' : 'COLD'}, xgb=${_xgbWinProb != null ? _xgbWinProb.toFixed(3) : '?'})`);
                }
              }

              // Always save to alerts table
              try {
                await sql`INSERT INTO alerts (game_id, league, alert_type, period, clock, control_team,
                  floor_score, margin, is_trailing, edge, ml, spread, tp_class, ls_class,
                  ctrl_sust, opp_sust, window_score, alert_tier, agent_decision, agent_reasoning,
                  i1, i2, i3, i4, i5, conviction_tier, conviction_combo, ntfy_sent,
                  bwc_state, erosion_level, peak_floor, exit_severity,
                  graduation_rank, mf_trajectory, combined_read, cp_eligible_count,
                  cp_ctrl_flips, lane, position_closed, is_flip_buy, cp_mean_floor, position_team,
                  xgb_win_prob, xgb_aligned)
                  VALUES (${game.id}, ${league}, ${v2Type}, ${currentPeriod}, ${clock}, ${ind.controlTeam},
                  ${ind.score}, ${margin}, ${ctrlTrailing}, ${ctrlEdge}, ${ctrlML ? parseInt(ctrlML) : null}, ${spreadVal},
                  ${tpForBuy?.classification || null}, ${lsForBWC?.classification || null},
                  ${ctrlSust}, ${oppSustTier}, ${alertCtx?.rollingWindow?.score ?? null}, ${v2Tier}, ${agentDecision}, ${agentReasoning},
                  ${_ci[0]}, ${_ci[1]}, ${_ci[2]},
                  ${_ci[3]}, ${_ci[4]},
                  ${conviction.tier}, ${conviction.combo}, ${shouldSend},
                  ${v2BwcState || lt._prev_bwc_state}, ${v2Type === 'POSITION_OPEN' ? v2Erosion.level : (typeof meanErosion !== 'undefined' && meanErosion ? meanErosion.level || v2Erosion.level : v2Erosion.level)},
                  ${v2Type === 'POSITION_OPEN' ? (v2Erosion.peakFloor ?? null) : ((typeof meanErosion !== 'undefined' && meanErosion ? meanErosion.meanFloor : null) ?? v2Erosion.peakFloor ?? null)}, ${v2ExitSev?.severity ?? null},
                  ${lt.po_fired?.tier || lt.compound_tier || null}, ${mfTraj?.direction || null},
                  ${alertCtx?.combinedRead?.read || null}, ${lt.compound_holds || null},
                  ${lt.cp_ctrl_flips || null}, ${lt.lane || null},
                  ${lt.position_closed || false}, ${!!(v2IsBuy && lt._flipBuyContext)},
                  ${lt.compound_mc_at_confirm || null}, ${v2Type === 'EXIT' ? (lt.bwc_fired?.team || ind.controlTeam) : ind.controlTeam},
                  ${_xgbWinProb != null ? Math.round(_xgbWinProb * 10000) / 10000 : null}, ${_xgbAligned})`;
              } catch (e) { log(`${matchup}: v2 alert save failed: ${e.message}`); }

              // Cleanup lock row — full alert row now exists
              if (_lockRowId) {
                try { await sql`DELETE FROM alerts WHERE id = ${_lockRowId}`; } catch(e) {}
              }

              log(`${matchup}: ${shouldSend ? '★' : '○'} ${v2Type} ${v2Tier} ${agentDecision} — ${ind.controlTeam} ${ind.score.toFixed(2)} ${ctrlTrailing ? 'trailing' : 'leading'} by ${margin}${ctrlEdge != null ? ', edge ' + (ctrlEdge > 0 ? '+' : '') + ctrlEdge + '%' : ''}`);
              return { decision: agentDecision, sent: shouldSend };
            }

            // ── V2 TRACKING ALERT (fires at BWC establishment) ──
            if (lt._just_established && !lt._tracking_sent) {
              delete lt._just_established;
              if (alertMinsLeft >= 1.0) {
                // DB-based dedup — check if TRACKING already fired for this game (lt save may have failed)
                let _trackingExists = false;
                try { const _te = await sql`SELECT 1 FROM alerts WHERE game_id = ${game.id} AND alert_type = 'TRACKING' LIMIT 1`; _trackingExists = _te.length > 0; } catch(e) {}
                if (!_trackingExists) {
                  await routeV2Alert('TRACKING', 'FIRED', null, false);
                  log(`${matchup}: ★ TRACKING — ${lt.bwc_fired.team} Q${currentPeriod} ${clock}`);
                } else {
                  log(`${matchup}: TRACKING already in DB — skipping re-fire`);
                }
                lt._tracking_sent = true;
              }
            }

            // ── V2 GRADUATION DETECTION (fires POSITION OPEN at rank upgrade) ──
            // NBA + WNBA: checkpoint-based graduation system (race-safe via game_checkpoints table)
            // NCAAMB: retains original 60s-poll graduation
            if (lt.bwc_fired && (league === 'nba' || league === 'wnba')) {
              const bwcTeam = lt.bwc_fired.team;

              // ── PHASE A: Read existing checkpoints from DB (race-safe source of truth) ──
              let cpArray = [];
              try {
                const dbCPs = await sql`SELECT label, period, clock, team, floor, margin, conv, opp_count, xgb, shap FROM game_checkpoints WHERE game_id = ${game.id} ORDER BY period, clock`;
                cpArray = dbCPs.map(r => ({
                  label: r.label, floor: Number(r.floor), team: r.team, margin: Number(r.margin),
                  conv: r.conv, oppCount: r.opp_count != null ? Number(r.opp_count) : 0,
                  period: Number(r.period), clock: r.clock,
                  xgb: r.xgb != null ? Number(r.xgb) : null,
                  shap: typeof r.shap === 'string' ? JSON.parse(r.shap) : r.shap,
                }));
              } catch (e) { log(`${matchup}: game_checkpoints read failed: ${e.message}`); }

              // Sort by league-specific checkpoints (clock text sort is wrong — lex "11:30" < "2:31" < "8:55")
              const _gradCPs = getGradCheckpoints(league);
              const _cpLabelOrder = Object.fromEntries(_gradCPs.map((cp, i) => [cp.label, i]));
              cpArray.sort((a, b) => (_cpLabelOrder[a.label] ?? 99) - (_cpLabelOrder[b.label] ?? 99));

              // ── PO SENTINEL RECOVERY — race-safe position state from DB ──
              const _poSentinel = cpArray.find(r => r.label === 'PO_ACTIVE');
              if (_poSentinel && !lt.po_fired) {
                if (_poSentinel.conv === 'BUY') {
                  // Legacy BUY sentinel — recover as buy_position (BUY no longer sets po_fired)
                  lt.buy_position = lt.buy_position || { team: _poSentinel.team, period: _poSentinel.period, clock: _poSentinel.clock, warm: true, xgb: null, flip: false };
                  log(`${matchup}: BUY position recovered from legacy sentinel — ${_poSentinel.team} Q${_poSentinel.period} ${_poSentinel.clock}`);
                } else {
                  lt.po_fired = {
                    team: _poSentinel.team,
                    rank: _poSentinel.conv,
                    period: _poSentinel.period,
                    clock: _poSentinel.clock,
                    flipped: false, // flip state tracked via lt.bwc_flipped
                    mean_floor: _poSentinel.floor,
                  };
                  log(`${matchup}: PO recovered from DB — ${_poSentinel.team} rank=${_poSentinel.conv} Q${_poSentinel.period} ${_poSentinel.clock}`);
                }
              }
              // Filter sentinels out of checkpoint array (not structural snapshots)
              cpArray = cpArray.filter(r => r.label !== 'PO_ACTIVE');

              // Derive next index from DB data (not lt — race-safe)
              let effectiveNextIdx = 0;
              if (cpArray.length > 0) {
                const lastLabel = cpArray[cpArray.length - 1].label;
                const lastIdx = _gradCPs.findIndex(cp => cp.label === lastLabel);
                if (lastIdx >= 0) effectiveNextIdx = lastIdx + 1;
              }

              // Convert current game time to gameSec
              const cpClockMatch = String(clock).match(/(\d+):(\d+)/);
              const cpClockSec = cpClockMatch
                ? parseInt(cpClockMatch[1]) * 60 + parseInt(cpClockMatch[2])
                : 720;
              const currentGameSec = (currentPeriod - 1) * 720 + (720 - cpClockSec);

              // Debug logging
              if (effectiveNextIdx < _gradCPs.length) {
                const _dbgNextCp = _gradCPs[effectiveNextIdx];
                log(`${matchup}: CP_DEBUG Q${currentPeriod} ${clock} gameSec=${currentGameSec} nextIdx=${effectiveNextIdx} nextCp=${_dbgNextCp.label}@${_dbgNextCp.gameSec} gap=${currentGameSec - _dbgNextCp.gameSec} dbCPs=${cpArray.length}`);
              }

              // ── PHASE B: Capture new checkpoints (INSERT to table, ON CONFLICT = no-op) ──
              let newCaptured = 0;
              while (effectiveNextIdx < _gradCPs.length) {
                const nextCp = _gradCPs[effectiveNextIdx];
                if (currentGameSec < nextCp.gameSec) break;

                // Compute checkpoint entry from current game state
                const cpConv = computeConviction(ind, league);
                const cpOppCount = cpConv.indicatorsLost.length;
                const cpCtrlIsHome = ind.controlTeam === hA;
                const cpCtrlPts = cpCtrlIsHome ? ind.homePts : ind.awayPts;
                const cpOppPts = cpCtrlIsHome ? ind.awayPts : ind.homePts;
                const cpMargin = cpCtrlPts - cpOppPts;

                const cpEntry = {
                  label: nextCp.label,
                  floor: ind.score,
                  team: ind.controlTeam,
                  margin: cpMargin,
                  conv: cpConv.tier,
                  oppCount: cpOppCount,
                  period: currentPeriod,
                  clock: clock,
                };

                // XGB + SHAP at checkpoint
                if (_xgbFeatures && _xgbWinProb != null) {
                  cpEntry.xgb = Math.round(_xgbWinProb * 1000) / 1000;
                  cpEntry.shap = computeXGBContributions(_xgbFeatures, league);
                }

                // Atomic write — concurrent invocations are no-ops via ON CONFLICT DO NOTHING
                try {
                  await sql`INSERT INTO game_checkpoints (game_id, label, period, clock, team, floor, margin, conv, opp_count, xgb, shap)
                    VALUES (${game.id}, ${nextCp.label}, ${currentPeriod}, ${clock}, ${cpEntry.team}, ${cpEntry.floor}, ${cpEntry.margin}, ${cpEntry.conv}, ${cpEntry.oppCount}, ${cpEntry.xgb || null}, ${cpEntry.shap ? JSON.stringify(cpEntry.shap) : null})
                    ON CONFLICT (game_id, label) DO NOTHING`;
                } catch (e) { log(`${matchup}: checkpoint INSERT failed ${nextCp.label}: ${e.message}`); }

                cpArray.push(cpEntry);
                newCaptured++;
                log(`${matchup}: CP_CAPTURED ${nextCp.label} Q${currentPeriod} ${clock} floor=${ind.score} xgb=${cpEntry.xgb || 'n/a'} total=${cpArray.length}`);
                effectiveNextIdx++;
              }

              // ── PHASE C: Derive flip/hold counts from checkpoint array ──
              // Checkpoint capture still runs (Phase A+B above). Trajectory functions read lt.checkpoints.
              // cp_holds/cp_opp_holds/cp_ctrl_flips tracked for agent context + flip detection.
              let _cpHolds = 0, _cpOppHolds = 0, _cpCtrlFlips = 0;
              for (let i = 0; i < cpArray.length; i++) {
                if (i > 0 && cpArray[i - 1].team !== cpArray[i].team) _cpCtrlFlips++;
                if (cpArray[i].team === bwcTeam) { _cpHolds++; _cpOppHolds = 0; }
                else { _cpHolds = 0; if (cpArray[i].margin >= 2 && cpArray[i].floor >= 0.60) _cpOppHolds++; else _cpOppHolds = 0; }
              }
              lt.cp_holds = _cpHolds;
              lt.cp_opp_holds = _cpOppHolds;
              lt.cp_ctrl_flips = _cpCtrlFlips;
              lt.checkpoints = cpArray;

              if (newCaptured > 0 || cpArray.length > 0) {
                log(`${matchup}: CP Phase C — holds=${lt.cp_holds} oppHolds=${lt.cp_opp_holds} flips=${lt.cp_ctrl_flips} compound=${lt.compound_tier || 'TRACKING'}(${lt.compound_holds || 0}) cps=${cpArray.length} new=${newCaptured}`);
              }

              // ── COMPOUND CONFIRMATION — runs every poll cycle ──
              // MC Cum for BWC team (when BWC has control, _mcCum IS their probability)
              const _compoundMcCum = _mcCum?.winProb != null ? _mcCum.winProb : (lt.mc_cum_wp != null ? lt.mc_cum_wp : null);
              const _compoundResult = checkCompoundConfirmation(lt, _compoundMcCum, ind.score, currentPeriod, clock, ind.controlTeam, bwcTeam, _v2Margin, lt.cp_ctrl_flips, league, _xgbWinProb);

              if (_compoundResult.confirmed) {
                log(`${matchup}: ★ COMPOUND ${_compoundResult.tier} — ${bwcTeam} ${_compoundResult.holds} holds, ${_compoundResult.path} path, MC=${_compoundMcCum?.toFixed(3) || '?'} floor=${ind.score.toFixed(2)} flips=${lt.cp_ctrl_flips}`);
              } else if (lt.compound_holds > 0 && lt.compound_holds !== (_compoundResult.holds || 0)) {
                log(`${matchup}: compound ${bwcTeam} — ${lt.compound_holds} holds (tier=${lt.compound_tier || 'TRACKING'})`);
              }

              // ── POSITION OPEN EVALUATION — fires when compound confirmed ──
              // Escalating SUPPRESS throttle — 3min after 1st, 6min after 2nd, 12min after 3rd+
              let _poSuppressThrottled = false;
              if (lt.compound_confirmed && !lt.po_fired && ind.controlTeam === bwcTeam) {
                try {
                  const _supHistory = await sql`SELECT COUNT(*)::int as cnt, MAX(ts) as last_ts FROM alerts WHERE game_id = ${game.id} AND alert_type = 'POSITION_OPEN' AND agent_decision = 'SUPPRESS' AND position_team = ${bwcTeam}`;
                  const _supCount = _supHistory[0]?.cnt || 0;
                  const _supLastTs = _supHistory[0]?.last_ts ? new Date(_supHistory[0].last_ts).getTime() : 0;
                  if (_supCount > 0 && _supLastTs > 0) {
                    const _supWindowMin = _supCount === 1 ? 3 : _supCount === 2 ? 6 : 12;
                    const _supElapsed = (Date.now() - _supLastTs) / 60000;
                    if (_supElapsed < _supWindowMin) {
                      _poSuppressThrottled = true;
                      log(`${matchup}: PO throttled — ${_supCount} prior SUPPRESS(es), waiting ${_supWindowMin}min (${_supElapsed.toFixed(1)}min elapsed)`);
                    }
                  }
                } catch(e) { /* fail-open */ }
              }

              if (lt.compound_confirmed && !lt.po_fired && ind.controlTeam === bwcTeam && !_poSuppressThrottled && alertMinsLeft >= 1.0) {
                const poTier = lt.compound_tier;

                // Set temporarily for agent context
                lt.po_fired = {
                  team: bwcTeam, tier: poTier,
                  period: currentPeriod, clock: clock,
                  holds: lt.compound_holds,
                  path: lt.compound_path,
                  mc: lt.compound_mc_at_confirm,
                  floor: ind.score,
                };

                const _poResult = await routeV2Alert('POSITION_OPEN', 'FIRED', null, false);

                if (_poResult?.decision === 'SUPPRESS') {
                  // Rollback — position not committed, agent gets another chance in 3 min
                  lt.po_fired = null;
                  log(`${matchup}: PO SUPPRESS'd — rolled back, will re-evaluate in 3 min`);
                } else {
                  // Commit — insert PO sentinel (race-safe, ON CONFLICT = upgrade from BUY)
                  try {
                    await sql`INSERT INTO game_checkpoints (game_id, label, period, clock, team, floor, margin, conv, opp_count)
                      VALUES (${game.id}, ${'PO_ACTIVE'}, ${currentPeriod}, ${clock}, ${bwcTeam}, ${ind.score}, ${_v2Margin}, ${poTier}, ${0})
                      ON CONFLICT (game_id, label) DO UPDATE SET team = EXCLUDED.team, floor = EXCLUDED.floor, conv = EXCLUDED.conv, period = EXCLUDED.period, clock = EXCLUDED.clock`;
                  } catch(e) { log(`${matchup}: PO sentinel INSERT failed: ${e.message}`); }
                  log(`${matchup}: ★ POSITION OPEN — ${bwcTeam} ${poTier} | ${lt.compound_holds} holds | path=${lt.compound_path} | MC@confirm=${lt.compound_mc_at_confirm?.toFixed(3) || '?'} | flips=${lt.cp_ctrl_flips || 0}`);
                }
              }

              // ── OPPONENT COMPOUND FLIP PO ──
              // Opponent must sustain compound threshold for 5 polls while having control
              const oppTeam = ind.controlTeam !== bwcTeam ? ind.controlTeam : null;
              if (oppTeam && oppTeam !== 'Neither'
                  && (!lt.po_fired || lt.po_fired.team !== oppTeam)
                  && alertMinsLeft >= 1.0) {
                // Opponent stale poll guard
                if (lt.compound_opp_last_period === currentPeriod && lt.compound_opp_last_clock === clock) {
                  // stale — skip
                } else {
                  const oppMcCum = _mcCum?.winProb != null ? _mcCum.winProb : null;
                  const oppCompoundMet = oppMcCum != null && oppMcCum >= 0.80 && ind.score >= 0.60;
                  if (oppCompoundMet) {
                    lt.cp_opp_holds = (lt.cp_opp_holds || 0) + 1;
                    lt.compound_opp_last_period = currentPeriod;
                    lt.compound_opp_last_clock = clock;
                  } else {
                    lt.cp_opp_holds = 0;
                    lt.compound_opp_last_period = currentPeriod;
                    lt.compound_opp_last_clock = clock;
                  }

                  // 5 opponent holds → flip PO
                  if (lt.cp_opp_holds >= 5) {
                    if (!lt.original_bwc_team) lt.original_bwc_team = lt.bwc_fired.team;
                    lt.bwc_flipped = true;
                    lt.bwc_fired.team = oppTeam;
                    lt.position_closed = false;

                    const hadPriorPO = lt.po_fired && lt.po_fired.team !== oppTeam;

                    // Reset compound for new team
                    lt.compound_tier = 'CONFIRMED';
                    lt.compound_confirmed = true;
                    lt.compound_holds = lt.cp_opp_holds;
                    lt.compound_path = 'STANDARD';
                    lt.compound_mc_at_confirm = oppMcCum;

                    lt.po_fired = {
                      team: oppTeam, tier: 'CONFIRMED',
                      period: currentPeriod, clock: clock,
                      holds: lt.cp_opp_holds,
                      path: 'STANDARD',
                      mc: oppMcCum,
                      floor: ind.score,
                      flipped: true,
                      original_bwc_team: lt.original_bwc_team,
                    };

                    lt._prev_bwc_state = computeBwcState(lt, ind.controlTeam, _v2Margin);

                    await routeV2Alert('POSITION_OPEN', 'FIRED', null, false);

                    // Commit flip sentinel
                    try {
                      await sql`INSERT INTO game_checkpoints (game_id, label, period, clock, team, floor, margin, conv, opp_count)
                        VALUES (${game.id}, ${'PO_ACTIVE'}, ${currentPeriod}, ${clock}, ${oppTeam}, ${ind.score}, ${_v2Margin}, ${'CONFIRMED'}, ${0})
                        ON CONFLICT (game_id, label) DO UPDATE SET team = EXCLUDED.team, floor = EXCLUDED.floor, conv = EXCLUDED.conv, period = EXCLUDED.period, clock = EXCLUDED.clock`;
                    } catch(e) { log(`${matchup}: FLIP PO sentinel failed: ${e.message}`); }

                    v2BwcState = computeBwcState(lt, ind.controlTeam, _v2Margin);
                    log(`${matchup}: ★ FLIP PO — ${oppTeam} CONFIRMED (${hadPriorPO ? 'supersedes prior PO on' : 'flipped from'} ${lt.original_bwc_team}) | ${lt.cp_opp_holds} opp holds | MC=${oppMcCum?.toFixed(3) || '?'}`);
                  }
                }
              }
            } else if (lt.bwc_fired && !lt.po_fired && league === 'ncaamb') {
              // ── NCAAMB PO sentinel recovery (not in game_checkpoints path) ──
              try {
                const _ncaaPO = await sql`SELECT team, conv, period, clock, floor FROM game_checkpoints WHERE game_id = ${game.id} AND label = 'PO_ACTIVE' LIMIT 1`;
                if (_ncaaPO.length > 0) {
                  if (_ncaaPO[0].conv === 'BUY') {
                    lt.buy_position = lt.buy_position || { team: _ncaaPO[0].team, period: Number(_ncaaPO[0].period), clock: _ncaaPO[0].clock, warm: true, xgb: null, flip: false };
                    log(`${matchup}: NCAAMB BUY position recovered from legacy sentinel — ${_ncaaPO[0].team}`);
                  } else {
                    lt.po_fired = { team: _ncaaPO[0].team, rank: _ncaaPO[0].conv, period: Number(_ncaaPO[0].period), clock: _ncaaPO[0].clock };
                    log(`${matchup}: NCAAMB PO recovered from DB — ${_ncaaPO[0].team} rank=${_ncaaPO[0].conv}`);
                  }
                }
              } catch(e) { /* fail-open */ }
              if (lt.po_fired) { /* recovered — skip NCAAMB PO evaluation */ } else {

              // ── NCAAMB: retain existing 60s-poll graduation logic (unchanged) ──
              if (!lt.graduation) lt.graduation = {};
              const bwcTeam = lt.bwc_fired.team;
              if (!lt.graduation[bwcTeam]) lt.graduation[bwcTeam] = { rank: 'C' };

              if (ind.controlTeam === bwcTeam) {
                const gradConviction = computeConviction(ind, league);
                const oppCount = _oppIndW.length;
                const curRank = classifyRank(
                  gradConviction.tier, _v2Margin, lt.ctrl_team_holds || 0, oppCount
                );
                lt.rank_current = curRank;

                const prevRank = lt.graduation[bwcTeam].rank || 'C';
                const RANK_ORDER = { C: 0, B: 1, A: 2 };

                if (RANK_ORDER[curRank] > RANK_ORDER[prevRank]) {
                  lt.graduation[bwcTeam] = {
                    rank: curRank, period: currentPeriod, clock,
                    floor: ind.score, margin: _v2Margin
                  };
                  log(`${matchup}: ▲ GRADUATION ${bwcTeam} ${prevRank}→${curRank} Q${currentPeriod} ${clock}`);
                }

                const gRank = lt.graduation[bwcTeam].rank;
                let poShouldFire = false;

                if (gRank === 'A') poShouldFire = true;
                if (gRank === 'B') {
                  const cm = String(clock).match(/(\d+):(\d+)/);
                  const clockSec = cm ? parseInt(cm[1]) * 60 + parseInt(cm[2]) : 720;
                  const pastQ3_6 = currentPeriod > 3 || (currentPeriod === 3 && clockSec <= 360);
                  if (pastQ3_6) poShouldFire = true;
                }

                if (poShouldFire) {
                  const oppTeamForPO = bwcTeam === hA ? aA : hA;
                  const oppGradForPO = lt.graduation?.[oppTeamForPO];
                  if (oppGradForPO && (oppGradForPO.rank === 'B' || oppGradForPO.rank === 'A')) {
                    poShouldFire = false;
                    log(`${matchup}: ✗ PO SUPPRESSED (both graduated) — ${bwcTeam} ${gRank} vs ${oppTeamForPO} ${oppGradForPO.rank}`);
                  }
                }

                if (poShouldFire && alertMinsLeft >= 1.0) {
                  const isWireToWire = (lt.ctrl_flips || 0) === 0;
                  const poRank = (gRank === 'A' && isWireToWire) ? 'S' : gRank;

                  // Set temporarily for agent context
                  lt.po_fired = {
                    team: bwcTeam, rank: poRank,
                    period: currentPeriod, clock
                  };
                  const _ncaaPOResult = await routeV2Alert('POSITION_OPEN', 'FIRED', null, false);

                  if (_ncaaPOResult?.decision === 'SUPPRESS') {
                    lt.po_fired = null;
                    log(`${matchup}: PO SUPPRESS'd — rolled back, will re-evaluate in 3 min`);
                  } else {
                    // Commit PO sentinel
                    try {
                      await sql`INSERT INTO game_checkpoints (game_id, label, period, clock, team, floor, margin, conv, opp_count)
                        VALUES (${game.id}, ${'PO_ACTIVE'}, ${currentPeriod}, ${clock}, ${bwcTeam}, ${ind.score}, ${_v2Margin}, ${poRank}, ${0})
                        ON CONFLICT (game_id, label) DO UPDATE SET team = EXCLUDED.team, floor = EXCLUDED.floor, conv = EXCLUDED.conv, period = EXCLUDED.period, clock = EXCLUDED.clock`;
                    } catch(e) { log(`${matchup}: NCAAMB PO sentinel failed: ${e.message}`); }
                    log(`${matchup}: ★ POSITION OPEN — ${bwcTeam} ${poRank}-Rank Q${currentPeriod} ${clock}`);
                  }
                }
              }

              // NCAAMB opponent graduation tracking
              if (ind.controlTeam !== bwcTeam) {
                const oppTeam = ind.controlTeam;
                if (_v2Margin >= 2 && ind.score >= 0.60 && currentPeriod >= 2) {
                  lt.opp_bwc_holds = (lt.opp_bwc_holds || 0) + 1;
                  if (lt.opp_bwc_holds >= 3) {
                    const oppConv = computeConviction(ind, league);
                    const oppOppCount = _oppIndW.length;
                    const oppRank = classifyRank(
                      oppConv.tier, _v2Margin, lt.opp_bwc_holds, oppOppCount
                    );
                    if (oppRank === 'B' || oppRank === 'A') {
                      const prevOppRank = lt.graduation?.[oppTeam]?.rank || null;
                      const OPP_RANK_ORDER = { C: 0, B: 1, A: 2 };
                      if (!prevOppRank || (OPP_RANK_ORDER[oppRank] || 0) > (OPP_RANK_ORDER[prevOppRank] || 0)) {
                        lt.graduation[oppTeam] = {
                          rank: oppRank, period: currentPeriod, clock,
                          floor: ind.score, margin: _v2Margin
                        };
                        log(`${matchup}: ⚠ OPP GRADUATION ${oppTeam} ${prevOppRank || 'C'}→${oppRank}-Rank Q${currentPeriod} ${clock}`);
                      }
                    }
                  }
                } else {
                  lt.opp_bwc_holds = 0;
                }
              } else {
                lt.opp_bwc_holds = 0;
              }
              } // close sentinel recovery guard
            }

            // ── V2 BWC STATE TRANSITIONS (gated on POSITION OPEN having fired) ──
            if (lt.bwc_fired && lt.po_fired && v2BwcState && lt._prev_bwc_state && v2BwcState !== lt._prev_bwc_state) {
              const v2Dir = classifyTransition(lt._prev_bwc_state, v2BwcState);

              if (v2Dir !== 'LATERAL' && v2BwcState !== 'DEEP_TRAIL') {
                // Map state + direction → alert type
                var v2AlertType = null;
                if (v2Dir === 'DEGRADING') {
                  if (v2BwcState === 'EDGE') v2AlertType = 'BWC_EDGE';
                  else if (v2BwcState === 'VALUE') v2AlertType = 'VALUE';
                  // EXIT no longer fires via state transition — handled by XGB EXIT below
                } else if (v2Dir === 'RECOVERING') {
                  if (v2BwcState === 'LOCK') v2AlertType = 'POSITION_SAFE';
                  else if (v2BwcState === 'EDGE') v2AlertType = 'POSITION_RECOVERING';
                  else if (v2BwcState === 'VALUE') v2AlertType = 'THESIS_ALIVE';
                }

                if (v2AlertType) {
                  // Post-EXIT position gate: suppress DEGRADING alerts on closed positions
                  // RECOVERING alerts (THESIS_ALIVE, POSITION_RECOVERING, POSITION_SAFE) pass through
                  // with positionClosed context so agent evaluates at elevated re-entry bar
                  const _recoveryAlerts = ['THESIS_ALIVE', 'POSITION_RECOVERING', 'POSITION_SAFE'];
                  if (lt.position_closed && !_recoveryAlerts.includes(v2AlertType)) {
                    log(`${matchup}: ${v2AlertType} GATED — position closed after EXIT (subscriber already out). Only recovery alerts or new BUY can re-open.`);
                  } else {

                  // Material change gate (cooldown killed Apr 24 — agent + material gate sufficient)
                  const _v2Now = Date.now();
                  const _v2StateChanged = v2BwcState !== lt._last_fired_state;
                  const _v2FloorDelta = Math.abs(ind.score - (lt._last_fired_floor || 0));
                  const _v2MarginDelta = Math.abs(_v2Margin - (lt._last_fired_margin || 0));
                  const _v2TimeDelta = lt._last_fired_ts ? (_v2Now - lt._last_fired_ts) : Infinity;
                  const _v2MaterialChange = _v2FloorDelta >= 0.10 || _v2MarginDelta >= 5 || _v2TimeDelta >= 300000;
                  const _v2ShouldFire = _v2StateChanged || _v2MaterialChange;

                  if (_v2ShouldFire && alertMinsLeft >= 1.0 && ind.controlTeam !== 'Neither') {
                    var _v2ExitSev = null;

                    log(`${matchup}: ▶ V2 TRIGGER ${v2AlertType} [${lt._prev_bwc_state}→${v2BwcState}] floor=${ind.score.toFixed(2)} margin=${_v2Margin} erosion=${v2AlertType === 'POSITION_OPEN' ? v2Erosion.level : (typeof meanErosion !== 'undefined' && meanErosion ? meanErosion.level || v2Erosion.level : v2Erosion.level)}(${v2AlertType === 'POSITION_OPEN' ? 'peak' : 'mean'}) ctrl=${_ctrlInd.join('+')||'none'}(${_ctrlInd.length}/5) opp=${_oppIndW.join('+')||'none'} oppI3=${_oppI3Won}${_v2ExitSev ? ' exit=' + _v2ExitSev.severity : ''} sust=${ctrlSust}/${oppSustTier} tp=${tpForBuy?.classification||lsForBWC?.classification||'-'}`);

                    // Advance state and save lt BEFORE agent call — prevents concurrent invocations
                    // from seeing the same transition (agent takes 10-15s, race window is huge)
                    lt._prev_bwc_state = v2BwcState;
                    lt._v2_transition_pending = false;
                    try { await sql`UPDATE games SET live_tracking = ${JSON.stringify(lt)} WHERE id = ${game.id}`; } catch(e) {}

                    await routeV2Alert(v2AlertType, 'FIRED', _v2ExitSev, false);

                    // Update gate timestamps — transition fired, advance state
                    lt._v2_transition_pending = false;
                    lt._last_fired_state = v2BwcState;
                    lt._last_fired_floor = ind.score;
                    lt._last_fired_margin = _v2Margin;
                    lt._last_fired_ts = _v2Now;
                  } else if (!_v2ShouldFire) {
                    log(`${matchup}: v2 ${v2AlertType} GATED — material=${!_v2MaterialChange && !_v2StateChanged ? 'BLOCKED' : 'ok'}`);
                    lt._v2_transition_pending = true; // Hold _prev_bwc_state until this transition fires
                  }
                  } // close position gate else
                }
              }
            }

            // ── HYBRID EXIT — Q2: XGB trigger, Q3/Q4: MC Cum trigger ──────────────────
            // Q2: XGB < 0.45 + MC gate + 2-poll. Q3: MC < 0.30 + 2-poll. Q4: MC < 0.25 + 1-poll.
            if (lt.bwc_fired && lt.po_fired
                && alertMinsLeft >= 1.0 && ind.controlTeam !== 'Neither'
                && (_xgbBwcProb != null || (_mcCum?.winProb != null && currentPeriod >= 3))) {
              // MC Cum from BWC team's perspective (MC Cum is computed for current ctrl team)
              const _mcCumBwcWp = _mcCum?.winProb != null
                ? (ind.controlTeam === lt.bwc_fired.team ? _mcCum.winProb : 1 - _mcCum.winProb)
                : null;
              if (checkXGBExit(lt, _xgbBwcProb, currentPeriod, _mcCumBwcWp)) {
                const _exitIsMC = lt.exit_trigger === 'mc_cum';
                const _xgbExitSev = {
                  severity: _exitIsMC
                    ? (_mcCumBwcWp < 0.10 ? 'COLLAPSE' : _mcCumBwcWp < 0.20 ? 'SEVERE' : 'STANDARD')
                    : (_xgbBwcProb < 0.15 ? 'COLLAPSE' : _xgbBwcProb < 0.25 ? 'SEVERE' : 'STANDARD'),
                  xgb: _xgbBwcProb != null ? Math.round(_xgbBwcProb * 1000) / 1000 : null,
                  windowedXgb: _xgbBwcProb != null ? Math.round(_xgbBwcProb * 1000) / 1000 : null,
                  mcCumAtExit: _mcCumBwcWp != null ? Math.round(_mcCumBwcWp * 1000) / 1000 : null,
                  exitTrigger: lt.exit_trigger || 'xgb',
                  threshold: _exitIsMC ? (currentPeriod >= 4 ? 0.25 : 0.30) : 0.45,
                  bwcState: v2BwcState,
                  ctrlTeam: ind.controlTeam,
                  bwcTeam: lt.bwc_fired.team,
                  ctrlMatchesBWC: ind.controlTeam === lt.bwc_fired.team,
                };
                const _exitLabel = _exitIsMC ? 'MC EXIT' : 'XGB EXIT';
                const _exitVal = _exitIsMC ? (_mcCumBwcWp != null ? _mcCumBwcWp.toFixed(3) : '?') : (_xgbBwcProb != null ? _xgbBwcProb.toFixed(3) : '?');
                log(`${matchup}: ▶ ${_exitLabel} — ${lt.bwc_fired.team} xgb=${_xgbBwcProb != null ? _xgbBwcProb.toFixed(3) : '?'} mcCum=${_mcCumBwcWp != null ? _mcCumBwcWp.toFixed(3) : '?'} < threshold ${_xgbExitSev.threshold} (Q${currentPeriod}) bwcState=${v2BwcState} ctrl=${ind.controlTeam} margin=${_v2Margin} severity=${_xgbExitSev.severity}`);

                lt.xgb_exit_sent = true;
                lt.xgb_exit_xgb = _xgbBwcProb;
                lt.exit_mc = _mcCumBwcWp;
                lt.xgb_exit_ts = Date.now();
                lt.xgb_exit_warned = null;

                // Reset compound state — re-entry requires fresh 5-hold streak
                lt.compound_tier = 'TRACKING';
                lt.compound_holds = 0;
                lt.compound_confirmed = false;
                lt.compound_path = null;
                lt.compound_mc_at_confirm = null;
                lt.position_closed = true;

                // Save lt BEFORE agent call (race-safe)
                try { await sql`UPDATE games SET live_tracking = ${JSON.stringify(lt)} WHERE id = ${game.id}`; } catch(e) {}

                await routeV2Alert('EXIT', 'FIRED', _xgbExitSev, false);

              } else if (lt.xgb_exit_warned && !lt.xgb_exit_sent) {
                log(`${matchup}: EXIT warned — ${lt.bwc_fired.team} xgb=${_xgbBwcProb != null ? _xgbBwcProb.toFixed(3) : '?'} mcCum=${_mcCumBwcWp != null ? _mcCumBwcWp.toFixed(3) : '?'} (Q${currentPeriod}, waiting for confirmation, warned ${Math.round((Date.now() - lt.xgb_exit_warned) / 1000)}s ago)`);
              }
            }

            // ── EXIT RECOVERY — Re-entry signal after EXIT ───────────────────
            // Q2 (XGB trigger): XGB recovers above 0.55 for 2+ polls.
            // Q3/Q4 (MC trigger): MC Cum recovers above 0.50 for 2+ polls.
            if (lt.xgb_exit_sent && lt.position_closed
                && lt.bwc_fired && alertMinsLeft >= 1.0 && ind.controlTeam !== 'Neither') {
              const _exitWasMC = lt.exit_trigger === 'mc_cum';
              const _recoverySignal = _exitWasMC
                ? (_mcCum?.winProb != null ? (ind.controlTeam === lt.bwc_fired.team ? _mcCum.winProb : 1 - _mcCum.winProb) : null)
                : _xgbBwcProb;
              const _recoveryThreshold = _exitWasMC ? 0.50 : 0.55;

              if (_recoverySignal != null && _recoverySignal >= _recoveryThreshold) {
                if (!lt.xgb_recovery_warned) {
                  lt.xgb_recovery_warned = Date.now();
                } else if (Date.now() - lt.xgb_recovery_warned >= 90000) {
                  // Sustained recovery — map to recovery alert type based on BWC state
                  var _recoveryType = 'THESIS_ALIVE';
                  if (v2BwcState === 'LOCK') _recoveryType = 'POSITION_SAFE';
                  else if (v2BwcState === 'EDGE') _recoveryType = 'POSITION_RECOVERING';

                  log(`${matchup}: ▶ ${_exitWasMC ? 'MC' : 'XGB'} RECOVERY — ${lt.bwc_fired.team} ${_exitWasMC ? 'mcCum' : 'xgb'}=${_recoverySignal.toFixed(3)} recovered above ${_recoveryThreshold} (bwcState=${v2BwcState}) → ${_recoveryType}`);

                  lt.xgb_exit_sent = false;
                  lt.xgb_recovery_warned = null;
                  lt.xgb_exit_warned = null;
                  lt.exit_trigger = null;

                  try { await sql`UPDATE games SET live_tracking = ${JSON.stringify(lt)} WHERE id = ${game.id}`; } catch(e) {}

                  await routeV2Alert(_recoveryType, 'FIRED', null, false);
                }
              } else {
                lt.xgb_recovery_warned = null; // recovery stalled, reset
              }
            }

            // ── V2 BUY TRIGGERS ──
            if (currentPeriod >= 2 && ind.score >= 0.55 && ctrlTrailing && margin >= 1 && margin <= (league === 'wnba' ? 9 : 15)
                && alertMinsLeft >= 1.0 && ind.controlTeam !== 'Neither') {
              const _v2Now = Date.now();
              const _v2MsSinceLastBuy = lt._last_buy_ts ? (_v2Now - lt._last_buy_ts) : Infinity;
              if (_v2MsSinceLastBuy >= 180000) {
                const _v2BuyTier = ind.score >= 0.65 ? 'FIRED' : 'CANDIDATE';

                // ML gate: heavy favorites have no betting value
                const buyMLNum = ctrlML ? parseFloat(ctrlML) : null;
                if (buyMLNum !== null && buyMLNum < -400) {
                  log(`${matchup}: BUY suppressed — ML ${ctrlML} (line cemented, no value)`);
                } else {
                  // Downgrade to CANDIDATE if ML heavy (-250 to -400)
                  let buyTier = (buyMLNum !== null && buyMLNum < -250) ? 'CANDIDATE' : _v2BuyTier;

                  // ── FLIP BUY DETECTION ──
                  // When BUY fires for opponent of BWC team AND an EXIT was already SENT,
                  // this is a structural reversal — not counter-betting. Two independent signals
                  // (EXIT on team A + BUY on team B) corroborate the same structural flip.
                  // Upgrade CANDIDATE → FIRED when EXIT confirms the flip.
                  lt._flipBuyContext = null;
                  if (lt.bwc_fired && lt.bwc_fired.team !== ind.controlTeam) {
                    try {
                      const exitRows = await sql`SELECT period, clock, control_team, floor_score, margin, ts
                        FROM alerts WHERE game_id = ${game.id} AND alert_type = 'EXIT' AND ntfy_sent = true
                        ORDER BY ts DESC LIMIT 1`;
                      if (exitRows.length > 0) {
                        lt._flipBuyContext = {
                          exitPeriod: exitRows[0].period, exitClock: exitRows[0].clock,
                          exitTeam: lt.bwc_fired.team, exitFloor: Number(exitRows[0].floor_score),
                          exitMargin: exitRows[0].margin, exitTs: exitRows[0].ts
                        };
                        if (buyTier === 'CANDIDATE') {
                          buyTier = 'FIRED';
                          log(`${matchup}: FLIP BUY upgrade CANDIDATE → FIRED (EXIT sent for ${lt.bwc_fired.team} at Q${exitRows[0].period} ${exitRows[0].clock})`);
                        }
                      }
                    } catch(e) { /* non-fatal */ }
                  }

                  // ── BUY CONVICTION GATES ──
                  // Cold BUY (no BWC lifecycle, not flip): floor ≥ 0.70 + STRONG+ conviction.
                  // Warm pre-graduation BUY (tracked but not graduated): MODEST+ conviction (2+ indicators, no danger combos).
                  // Warm graduated BUY / Flip BUY: no additional gate.
                  const isColdBuy = !lt.bwc_fired || (lt.bwc_fired.team !== ind.controlTeam && !lt._flipBuyContext);
                  const isWarmPreGrad = !isColdBuy && lt.bwc_fired?.team === ind.controlTeam && !lt.cp_graduation;

                  if (isColdBuy && (ind.score < 0.70 || (conviction.tier !== 'DOMINANT' && conviction.tier !== 'STRONG'))) {
                    log(`${matchup}: Cold BUY suppressed — floor ${ind.score.toFixed(2)} conv ${conviction.tier} (cold needs ≥0.70 + STRONG+)`);
                  } else if (isWarmPreGrad && (conviction.tier === 'CONDITIONAL' || conviction.tier === 'NO ENTRY')) {
                    log(`${matchup}: Warm pre-grad BUY suppressed — conv ${conviction.tier} (pre-grad needs MODEST+, ${conviction.count}/5 indicators: ${conviction.combo})`);
                  } else {
                    // BUY throttle: 1 per quarter per game
                    let _buyQuarterThrottled = false;
                    try {
                      const _buyQDedup = await sql`SELECT 1 FROM alerts WHERE game_id = ${game.id} AND alert_type = 'BUY' AND period = ${currentPeriod} AND agent_decision IN ('SEND', 'DOWNGRADE', 'FALLBACK_SEND') LIMIT 1`;
                      if (_buyQDedup.length > 0) {
                        _buyQuarterThrottled = true;
                        log(`${matchup}: BUY throttled — already sent in Q${currentPeriod}`);
                      }
                    } catch(e) { /* fail-open */ }

                    if (!_buyQuarterThrottled) {
                      const buyTag = isColdBuy ? ' [COLD]' : isWarmPreGrad ? ' [PRE-GRAD]' : '';
                      log(`${matchup}: ▶ V2 BUY ${buyTier}${lt._flipBuyContext ? ' [FLIP]' : ''}${buyTag} floor=${ind.score.toFixed(2)} trail=${margin} bwcMatch=${lt.bwc_fired?.team === ind.controlTeam} ctrl=${_ctrlInd.join('+')||'none'}(${_ctrlInd.length}/5) opp=${_oppIndW.join('+')||'none'} sust=${ctrlSust}/${oppSustTier} tp=${tpForBuy?.classification||'-'} ml=${ctrlML||'-'} conv=${conviction.tier}`);

                      await routeV2Alert('BUY', buyTier, null, true);
                      lt._last_buy_ts = _v2Now;
                    }
                  }
                }
              }
            } else if (ind.score >= 0.65 && ctrlTrailing && margin >= 1 && margin <= (league === 'wnba' ? 9 : 15) && currentPeriod >= 2 && alertMinsLeft < 1.0) {
              log(`${matchup}: BUY suppressed — ${alertMinsLeft.toFixed(1)} min left (< 1 min clock gate)`);
            }

            // ── V2 STATE LOGGING ──
            if (lt.bwc_fired) {
              if (v2BwcState && !lt._v2_transition_pending) lt._prev_bwc_state = v2BwcState;
              try {
                log(`${matchup}: v2 state=${v2BwcState || '-'} erosion=${v2Erosion?.level || '-'}(peak)/${typeof meanErosion !== 'undefined' && meanErosion ? meanErosion.level || '-' : '-'}(mean) peak=${v2Erosion?.peakFloor?.toFixed(2) || '-'} mf=${typeof meanErosion !== 'undefined' && meanErosion ? meanErosion.meanFloor?.toFixed(3) || '-' : '-'} holds=${lt.ctrl_team_holds || 0} bwcTeam=${lt.bwc_fired.team}${lt._v2_transition_pending ? ' PENDING(prev=' + lt._prev_bwc_state + ')' : ''}`);
              } catch(e) { log(`${matchup}: v2 state=${v2BwcState || '-'} (log error: ${e.message})`); }
            }

          // ── MONTE CARLO STRUCTURAL INVESTIGATION ──
          // Replaces VULNERABILITY. Combined canary: MC<0.70 OR floor-MC divergence>0.15.
          // PBP-derived canary → triggered investigation with post-trigger rates → pattern classification.
          // Q2+ gate — early detection trades precision for warning time.
          // PHASE 1: WNBA legacy alerts off → skip the entire canary→investigation
          // chain (INVESTIGATING/STRUCTURAL STRESS/position-exit ntfy + MC Opus call).
          // Upstream _pollMC/_mcCum (line ~7647/7676) and the calibration snapshot are unaffected.
          if (!(WNBA_LEGACY_ALERTS_OFF && league === 'wnba')
              && currentPeriod >= 2 && ind.controlTeam && ind.controlTeam !== 'Neither'
              && _v2Margin >= 0 && alertMinsLeft >= 1.0) {
            const _mcCtrlIsHome = ind.controlTeam === hA;
            const _mcCtrlSide = _mcCtrlIsHome ? 'home' : 'away';
            // Get team 3PT baselines from season cache or clutch profiles
            const _mcHBaseline = _clutchMap?.[hA]?.q4_fg3pct || _team3ptBaselines?.[hA] || 0.36;
            const _mcABaseline = _clutchMap?.[aA]?.q4_fg3pct || _team3ptBaselines?.[aA] || 0.36;

            if (!lt.mc || !lt.mc.triggered) {
              // ── CANARY CHECK (no active investigation) ──
              // Track rolling margin + XGB for compression/drop detection (10 polls ≈ 20 possessions)
              if (!lt._canary_margins) lt._canary_margins = [];
              if (!lt._canary_xgb) lt._canary_xgb = [];
              lt._canary_margins.push(_v2Margin);
              if (lt._canary_margins.length > 10) lt._canary_margins.shift();
              if (_xgbWinProb != null) { lt._canary_xgb.push(_xgbWinProb); if (lt._canary_xgb.length > 10) lt._canary_xgb.shift(); }

              const _mcRates = extractMCRatesFromPossLog(pbpResult?.possLog, 20, hA, aA, _mcHBaseline, _mcABaseline);
              if (_mcRates && _mcRates.home._windowFGA >= 5 && _mcRates.away._windowFGA >= 5) {
                const _hs = summary.home?.statistics || {}, _as = summary.away?.statistics || {};
                const _mcClockSec = (function(c) { try { var pp = String(c||'6:00').split(':'); return parseInt(pp[0])*60+parseInt(pp[1]||0); } catch(e) { return 360; } })(clock);
                const _mcRemain = estimateRemainingPossMC(_hs, _as, currentPeriod, _mcClockSec, league);
                if (_mcRemain > 0) {
                  const _mcCanary = runMonteCarloSim(_mcRates.home, _mcRates.away,
                    Number(ind.homePts), Number(ind.awayPts), _mcRemain,
                    { simCount: 1000, ctrlTeam: _mcCtrlIsHome ? 'home' : 'away' });
                  // Signal triggers: PBP MC absolute, floor-MC divergence, XGB structural drop
                  const _mcAbsFired = _mcCanary.winProb < 0.70;
                  const _mcDivFired = ind.score != null && (ind.score - _mcCanary.winProb) > 0.15;
                  const _peakXgb = lt._canary_xgb.length > 0 ? Math.max(...lt._canary_xgb) : null;
                  const _xgbDropFired = _peakXgb != null && _xgbWinProb != null && (_peakXgb - _xgbWinProb) >= 0.15;
                  // Margin compression gate: scoreboard must confirm deterioration
                  const _peakMargin = Math.max(...lt._canary_margins);
                  const _marginCompressed = (_peakMargin - _v2Margin) >= 3;
                  const _triggerReason = _mcAbsFired ? 'absolute' : _mcDivFired ? 'divergence' : 'xgb_drop';
                  if ((_mcAbsFired || _mcDivFired || _xgbDropFired) && _marginCompressed) {
                    // Only investigate teams with established tracking or active position
                    const _mcIsTracked = lt.bwc_fired?.team === ind.controlTeam || lt.buy_position?.team === ind.controlTeam;
                    if (!_mcIsTracked) {
                      log(`${matchup}: MC canary skipped — ${ind.controlTeam} not tracked/positioned (bwc=${lt.bwc_fired?.team || 'none'} pos=${lt.buy_position?.team || 'none'})`);
                    } else {
                    log(`${matchup}: ★ MC CANARY FIRED — ctrl=${ind.controlTeam} MC=${_mcCanary.winProb.toFixed(3)} floor=${ind.score} margin=${_v2Margin} peak=${_peakMargin} compressed=${_peakMargin - _v2Margin} trigger=${_triggerReason}${_xgbDropFired ? ' xgbDrop=' + (_peakXgb - _xgbWinProb).toFixed(3) : ''}`);
                    const _hs2 = summary.home?.statistics || {}, _as2 = summary.away?.statistics || {};
                    lt.mc = {
                      triggered: true,
                      trigger_ts: Date.now(),
                      trigger_period: currentPeriod,
                      trigger_clock: clock,
                      trigger_margin: _v2Margin,
                      trigger_floor: ind.score,
                      trigger_xgb: _xgbWinProb,
                      trigger_mc: _mcCanary.winProb,
                      trigger_reason: _triggerReason,
                      trigger_stats: {
                        home: { fgm: Number(_hs2.field_goals_made||0), fga: Number(_hs2.field_goals_att||0), fg3m: Number(_hs2.three_points_made||0), fg3a: Number(_hs2.three_points_att||0), ftm: Number(_hs2.free_throws_made||0), fta: Number(_hs2.free_throws_att||0), to: Number(_hs2.turnovers||_hs2.total_turnovers||0), oreb: Number(_hs2.offensive_rebounds||0) },
                        away: { fgm: Number(_as2.field_goals_made||0), fga: Number(_as2.field_goals_att||0), fg3m: Number(_as2.three_points_made||0), fg3a: Number(_as2.three_points_att||0), ftm: Number(_as2.free_throws_made||0), fta: Number(_as2.free_throws_att||0), to: Number(_as2.turnovers||_as2.total_turnovers||0), oreb: Number(_as2.offensive_rebounds||0) },
                      },
                      ctrl_team: ind.controlTeam,
                      ctrl_is_home: _mcCtrlIsHome,
                      verdicts: [],
                      pattern: null,
                      alert_sent: false,
                      current_mc: _mcCanary.winProb,
                      prior_investigations: lt.mc?.prior_investigations || 0,
                      last_verdict_fga: 0,
                    };
                    // Nudge ntfy — let Manny know to check the dashboard
                    const _mcNudgeBody = `${aA} ${ind.awayPts}-${ind.homePts} ${hA} · Q${currentPeriod} ${clock}\nMC canary fired — ctrl ${ind.controlTeam} MC=${(_mcCanary.winProb * 100).toFixed(1)}% vs floor ${ind.score.toFixed(2)} (${_triggerReason}). Margin +${_v2Margin} (peak +${_peakMargin}). Investigating.`;
                    await sendNtfy(`MC INVESTIGATING — ${matchup}`, _mcNudgeBody, 3);
                    log(`${matchup}: MC INVESTIGATING ntfy sent`);
                    } // close _mcIsTracked else
                  } else if ((_mcAbsFired || _mcDivFired || _xgbDropFired) && !_marginCompressed) {
                    log(`${matchup}: MC canary signal blocked by margin gate — MC=${_mcCanary.winProb.toFixed(3)} margin=${_v2Margin} peak=${_peakMargin} compressed=${_peakMargin - _v2Margin} (need >=3)`);
                  }
                }
              }
            } else if (lt.mc.triggered && !lt.mc.pattern?.match(/^(CLEAN|WAVE)$/)) {
              // ── INVESTIGATION (active, pattern not terminal) ──
              const _hs3 = summary.home?.statistics || {}, _as3 = summary.away?.statistics || {};
              const _mcNowH = { fgm: Number(_hs3.field_goals_made||0), fga: Number(_hs3.field_goals_att||0), fg3m: Number(_hs3.three_points_made||0), fg3a: Number(_hs3.three_points_att||0), ftm: Number(_hs3.free_throws_made||0), fta: Number(_hs3.free_throws_att||0), to: Number(_hs3.turnovers||_hs3.total_turnovers||0), oreb: Number(_hs3.offensive_rebounds||0) };
              const _mcNowA = { fgm: Number(_as3.field_goals_made||0), fga: Number(_as3.field_goals_att||0), fg3m: Number(_as3.three_points_made||0), fg3a: Number(_as3.three_points_att||0), ftm: Number(_as3.free_throws_made||0), fta: Number(_as3.free_throws_att||0), to: Number(_as3.turnovers||_as3.total_turnovers||0), oreb: Number(_as3.offensive_rebounds||0) };
              // Post-trigger rates via box score diff
              const _mcTrigH = lt.mc.trigger_stats.home, _mcTrigA = lt.mc.trigger_stats.away;
              const _mcPostFGA = (_mcNowH.fga - _mcTrigH.fga) + (_mcNowA.fga - _mcTrigA.fga);
              if (_mcPostFGA >= 8) {
                if (_mcPostFGA <= (lt.mc.last_verdict_fga || 0)) {
                  log(`${matchup}: MC investigation — stale data (postFGA=${_mcPostFGA} unchanged), skipping verdict`);
                } else {
                const _mcHRates = diffToRatesMC(_mcNowH, _mcTrigH, _mcHBaseline);
                const _mcARates = diffToRatesMC(_mcNowA, _mcTrigA, _mcABaseline);
                if (_mcHRates && _mcARates) {
                  const _mcClockSec2 = (function(c) { try { var pp = String(c||'6:00').split(':'); return parseInt(pp[0])*60+parseInt(pp[1]||0); } catch(e) { return 360; } })(clock);
                  const _mcRemain2 = estimateRemainingPossMC(_mcNowH, _mcNowA, currentPeriod, _mcClockSec2, league);
                  if (_mcRemain2 > 0) {
                    const _mcInv = runMonteCarloSim(_mcHRates, _mcARates,
                      Number(ind.homePts), Number(ind.awayPts), _mcRemain2,
                      { simCount: 1000, ctrlTeam: lt.mc.ctrl_is_home ? 'home' : 'away' });
                    lt.mc.current_mc = _mcInv.winProb;
                    const _mcVerdict = classifyMCVerdict(_mcInv.winProb);
                    lt.mc.verdicts.push(_mcVerdict);
                    lt.mc.last_verdict_fga = _mcPostFGA;
                    log(`${matchup}: MC investigation — verdict=${_mcVerdict} MC=${_mcInv.winProb.toFixed(3)} postFGA=${_mcPostFGA} pattern=${lt.mc.pattern || 'classifying'}`);
                    // Classify pattern
                    const _mcPat = classifyMCPattern(lt.mc.verdicts);
                    if (_mcPat) {
                      lt.mc.pattern = _mcPat;
                      log(`${matchup}: MC pattern classified → ${_mcPat}`);
                      // CLEAN → fire MC_COLLAPSE alert
                      if (_mcPat === 'CLEAN' && !lt.mc.alert_sent) {
                        lt.mc.alert_sent = true;
                        // Use the INVESTIGATED team, not current floor leader
                        const _mcInvTeam = lt.mc.ctrl_team;
                        const _mcInvIsHome = lt.mc.ctrl_is_home;
                        const _mcInvOpp = _mcInvIsHome ? aA : hA;
                        const _mcHasPosition = lt.bwc_fired?.team === _mcInvTeam || lt.buy_position?.team === _mcInvTeam;
                        const _mcPosNote = _mcHasPosition ? `\nActive ${lt.compound_tier || lt.cp_peak_rank || '?'} position on ${_mcInvTeam} — monitoring. EXIT will fire if structural breakdown confirmed.` : '';
                        const _mcInvMargin = _mcInvIsHome ? (Number(ind.homePts) - Number(ind.awayPts)) : (Number(ind.awayPts) - Number(ind.homePts));
                        const _mcBody = `${aA} ${ind.awayPts}-${ind.homePts} ${hA} · Q${currentPeriod} ${clock}\n${_mcInvTeam} structural stress detected — held control at Q${lt.mc.trigger_period} ${lt.mc.trigger_clock} but post-trigger possession rates show sustained deterioration. MC: ${(_mcInv.winProb * 100).toFixed(1)}%. Floor (${ind.score.toFixed(2)}) and XGB (${_xgbWinProb != null ? (_xgbWinProb * 100).toFixed(0) + '%' : '?'}) may be anchored to early-game data.${_mcPosNote}`;
                        const _mcPriority = _mcHasPosition ? 5 : 4;
                        try {
                          const _mcCSust = sust?.[_mcInvIsHome ? 'home' : 'away']?.tier || null;
                          const _mcOSust = sust?.[_mcInvIsHome ? 'away' : 'home']?.tier || null;
                          await sql`INSERT INTO alerts (game_id, league, alert_type, period, clock, control_team, floor_score, margin, is_trailing, edge, ml, spread, tp_class, ls_class, ctrl_sust, opp_sust, window_score, alert_tier, agent_decision, agent_reasoning, i1, i2, i3, i4, i5, conviction_tier, conviction_combo, ntfy_sent, position_team, xgb_win_prob, xgb_aligned)
                            VALUES (${game.id}, ${league}, ${'MC_COLLAPSE'}, ${currentPeriod}, ${clock}, ${_mcInvTeam}, ${ind.score}, ${_mcInvMargin}, ${_mcInvMargin < 0}, ${null}, ${null}, ${spreadVal}, ${snapTp?.classification || null}, ${snapLs?.classification || null}, ${_mcCSust}, ${_mcOSust}, ${_mcInv.winProb}, ${'FIRED'}, ${'SEND'}, ${_mcBody}, ${ctrlI(ind)[0]}, ${ctrlI(ind)[1]}, ${ctrlI(ind)[2]}, ${ctrlI(ind)[3]}, ${ctrlI(ind)[4]}, ${conviction?.tier || null}, ${conviction?.combo || null}, ${true}, ${_mcInvTeam}, ${_xgbWinProb != null ? Math.round(_xgbWinProb * 10000) / 10000 : null}, ${_xgbAligned})`;
                        } catch (e) { log(`${matchup}: MC_COLLAPSE DB insert error: ${e.message}`); }
                        await sendNtfy(`STRUCTURAL STRESS — ${matchup}`, _mcBody, _mcPriority);
                        log(`${matchup}: MC_COLLAPSE ntfy sent — investigated team: ${_mcInvTeam}`);
                      }
                      // NORMALIZED or FALSE_ALARM → reset for re-trigger
                      if (_mcPat === 'NORMALIZED' || _mcPat === 'FALSE_ALARM') {
                        log(`${matchup}: MC investigation resolved → ${_mcPat}, resetting for re-trigger`);
                        lt.mc = { triggered: false, prior_investigations: (lt.mc.prior_investigations || 0) + 1 };
                      }
                    }
                  }
                }
                } // close stale-data else
              } else {
                // Not enough post-trigger data yet — add INV verdict
                if (_mcPostFGA > (lt.mc.last_verdict_fga || 0)) {
                  lt.mc.verdicts.push('INV');
                  lt.mc.last_verdict_fga = _mcPostFGA;
                  log(`${matchup}: MC investigation — INV (postFGA=${_mcPostFGA} < 8)`);
                }
              }
            }
          }

          // ── THESIS INVALIDATED: post-BUY structural collapse detection ──
          // After a BUY SEND, check for thesis collapse. One-shot per game.
          // Q2: XGB < 0.40 (unchanged). Q3/Q4: MC Cum < 0.30 (matches BWC EXIT).
          const _xgbGateByQ = { 2: 0.40 };  // Q3/Q4 now use MC Cum
          const _invUseMC = currentPeriod >= 3;
          const _invMcCum = _mcCum?.winProb != null ? _mcCum.winProb : null;
          if (lt.buy_send_xgb != null && !lt.buy_invalidated && lt.last_send_type === 'BUY'
              && currentPeriod >= 2 && currentPeriod <= 4
              && (_invUseMC ? _invMcCum != null : _xgbWinProb != null)) {
            const _invTriggered = _invUseMC
              ? _invMcCum < 0.30
              : _xgbWinProb < (_xgbGateByQ[currentPeriod] || 0.40);
            if (_invTriggered) {
              const _invGateLabel = _invUseMC ? 'MC Cum 30%' : `XGB Q${currentPeriod} ${(_xgbGateByQ[currentPeriod] * 100).toFixed(0)}%`;
              const _invSignalVal = _invUseMC ? _invMcCum : _xgbWinProb;
              log(`${matchup}: ★ ${_invUseMC ? 'MC' : 'XGB'} INVALIDATED — BUY ${_invUseMC ? 'mcCum' : 'xgb'} was ${(lt.buy_send_xgb * 100).toFixed(1)}% at Q${lt.buy_send_period}, now ${(_invSignalVal * 100).toFixed(1)}% < ${_invGateLabel}`);
              lt.buy_invalidated = true;

              // Build agent context
              const _invAgentCtx = await gatherAgentContext(sql, game.id, matchup);
              const _invBuyTeam = lt.bwc_fired?.team || ind.controlTeam;
              const _invCtrlIsHome = ind.controlTeam === hA;
              const _invV2Ctx = {
                alertType: 'XGB_INVALIDATED', alertTier: 'FIRED',
                ctrlTeam: ind.controlTeam, ctrlIsHome: _invCtrlIsHome, league,
                floor: ind.score?.toFixed(2), margin: _v2Margin,
                bwcTeam: _invBuyTeam,
                bwcFirePeriod: lt.bwc_fired?.period || null,
                homeAlias: hA, awayAlias: aA, homePts: ind.homePts, awayPts: ind.awayPts,
                period: currentPeriod, clock,
                ctrlSust: sust?.[_invCtrlIsHome ? 'home' : 'away']?.tier || null,
                oppSust: sust?.[_invCtrlIsHome ? 'away' : 'home']?.tier || null,
                windowScore: _windowScore,
                rollingWindow: _windowResult,
                i1: _ci[0], i2: _ci[1], i3: _ci[2], i4: _ci[3], i5: _ci[4],
                convictionTier: conviction?.tier || null, convictionCombo: conviction?.combo || null,
                combinedRead: null,
                erosionLevel: null, peakFloor: lt[_invCtrlIsHome ? 'home_peak_floor' : 'away_peak_floor'] || ind.score,
                floorWPHistorical: _floorWP.wp, reliabilityClass: _floorWP.reliabilityClass, floorGrip: _floorWP.grip,
                priorAlertTrail: _invAgentCtx?.priorAlerts || null,
                xgbWinProb: _xgbWinProb,
                xgbBuySendProb: lt.buy_send_xgb,
                xgbBuySendPeriod: lt.buy_send_period,
                xgbQuarterGate: _invUseMC ? 0.30 : (_xgbGateByQ[currentPeriod] || 0.40),
                invTriggerSignal: _invUseMC ? 'mc_cum' : 'xgb',
                mcCumWinProb: _invMcCum,
              };

              const _invPrompt = buildV2AgentPrompt(_invV2Ctx);
              try {
                const _invAgentResp = await fetch('https://api.anthropic.com/v1/messages', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
                  body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 600, messages: [{ role: 'user', content: _invPrompt }] }),
                });
                const _invAgentData = await _invAgentResp.json();
                const _invAgentText = _invAgentData.content?.[0]?.text || '';
                // Always SEND — extract body/reasoning for narrative
                const _invBody = _invAgentText.match(/BODY:\s*([\s\S]*?)(?:\n(?:DECISION|REASONING):|$)/)?.[1]?.trim() || '';
                const _invReasoning = _invAgentText.match(/REASONING:\s*([\s\S]*?)(?:\n(?:DECISION|BODY):|$)/)?.[1]?.trim() || '';

                await sql`INSERT INTO alerts (game_id, league, alert_type, period, clock, control_team, floor_score, margin, is_trailing, edge, ml, spread, tp_class, ls_class, ctrl_sust, opp_sust, window_score, alert_tier, agent_decision, agent_reasoning, i1, i2, i3, i4, i5, conviction_tier, conviction_combo, ntfy_sent, position_team, xgb_win_prob, xgb_aligned)
                  VALUES (${game.id}, ${league}, ${'XGB_INVALIDATED'}, ${currentPeriod}, ${clock}, ${ind.controlTeam}, ${ind.score}, ${_v2Margin}, ${ctrlTrailing}, ${ctrlEdge}, ${ctrlML ? parseInt(ctrlML) : null}, ${spreadVal}, ${snapTp?.classification || null}, ${snapLs?.classification || null}, ${_invV2Ctx.ctrlSust}, ${_invV2Ctx.oppSust}, ${_windowScore}, ${'FIRED'}, ${'SEND'}, ${_invReasoning || _invBody}, ${ctrlI(ind)[0]}, ${ctrlI(ind)[1]}, ${ctrlI(ind)[2]}, ${ctrlI(ind)[3]}, ${ctrlI(ind)[4]}, ${conviction?.tier || null}, ${conviction?.combo || null}, ${true}, ${_invBuyTeam}, ${Math.round(_xgbWinProb * 10000) / 10000}, ${_xgbAligned})`;

                const _invNtfyTitle = `${_invUseMC ? 'MC' : 'XGB'} INVALIDATED — ${_invBuyTeam} BUY`;
                const _invScoreLine = `${aA} ${ind.awayPts}-${ind.homePts} ${hA} · Q${currentPeriod} ${clock}`;
                const _invNtfyBody = _invBody
                  ? _invScoreLine + '\n' + _invBody
                  : _invUseMC
                    ? _invScoreLine + '\nThe full-game rate projection for ' + _invBuyTeam + ' has dropped to ' + (_invMcCum * 100).toFixed(0) + '%, below the 30% structural viability threshold. The possession rates no longer support the entry thesis. Consider exiting.'
                    : _invScoreLine + '\nThe structural model that supported the ' + _invBuyTeam + ' BUY at Q' + lt.buy_send_period + ' (XGB ' + (lt.buy_send_xgb * 100).toFixed(0) + '%) has dropped to ' + (_xgbWinProb * 100).toFixed(0) + '%, below the Q' + currentPeriod + ' viability threshold. The raw stats no longer support the entry thesis. Consider exiting.';
                await sendNtfy(_invNtfyTitle, _invNtfyBody, 5);
                lt.last_send_type = 'XGB_INVALIDATED';
                log(`${matchup}: ${_invUseMC ? 'MC' : 'XGB'} INVALIDATED → SEND (ntfy sent)`);
              } catch (e) {
                log(`${matchup}: ${_invUseMC ? 'MC' : 'XGB'} INVALIDATED agent error: ${e.message} — sending fallback`);
                await sql`INSERT INTO alerts (game_id, league, alert_type, period, clock, control_team, floor_score, margin, is_trailing, alert_tier, agent_decision, agent_reasoning, ntfy_sent, position_team, xgb_win_prob, xgb_aligned)
                  VALUES (${game.id}, ${league}, ${'XGB_INVALIDATED'}, ${currentPeriod}, ${clock}, ${ind.controlTeam}, ${ind.score}, ${_v2Margin}, ${ctrlTrailing}, ${'FIRED'}, ${'SEND'}, ${'Agent unavailable — auto-SEND'}, ${true}, ${_invBuyTeam}, ${Math.round(_xgbWinProb * 10000) / 10000}, ${_xgbAligned})`;
                const _invFallback = _invUseMC
                  ? `${aA} ${ind.awayPts}-${ind.homePts} ${hA} · Q${currentPeriod} ${clock}\nThe full-game rate projection for ${_invBuyTeam} has dropped to ${(_invMcCum * 100).toFixed(0)}%, below the 30% structural viability threshold. Consider exiting.`
                  : `${aA} ${ind.awayPts}-${ind.homePts} ${hA} · Q${currentPeriod} ${clock}\nThe structural model that supported the ${_invBuyTeam} BUY at Q${lt.buy_send_period} (XGB ${(lt.buy_send_xgb * 100).toFixed(0)}%) has dropped to ${(_xgbWinProb * 100).toFixed(0)}%, below the Q${currentPeriod} viability threshold. Consider exiting.`;
                await sendNtfy(`${_invUseMC ? 'MC' : 'XGB'} INVALIDATED — ${_invBuyTeam} BUY`, _invFallback, 5);
                lt.last_send_type = 'XGB_INVALIDATED';
              }
            }
          }
          } // end if (!cfg.dryRun)

          // ── V2 LIVE TRACKING: persist state to DB ──
          if (!cfg.dryRun) {
            try {
              await sql`UPDATE games SET live_tracking = ${JSON.stringify(lt)} WHERE id = ${game.id}`;
            } catch(e) { log(`${matchup}: live_tracking write failed: ${e.message}`); }
          }

          // ── QUARTER-BOUNDARY CALIBRATION SNAPSHOTS ─────────────────
          // Detect Q1→Q2, Q2→Q3, Q3→Q4 transitions. Fire ONCE each per game:
          //   1. Save calibration-tagged snapshot (all data layers fresh from this cycle)
          //   2. Fire async Sonnet analysis with full context from DB
          // Q3→Q4 is the GOLD STANDARD (game still contested).
          // Q1→Q2 and Q2→Q3 track framework accuracy at earlier stages.
          // ── QUARTER-BOUNDARY CALIBRATION SNAPSHOTS ─────────────────
          // NBA: Q1→Q2, Q2→Q3, Q3→Q4 transitions (from period tracking)
          // NCAAMB: Synthetic quarters — sQ1 (H1 >10:00), sQ2 (halftime), sQ3 (H2 >10:00)
          //   detected via clock crossing 10:00 within a half + period transition
          // Saves calibration snapshot + computes server context at each boundary.
          // NBA fires Sonnet auto-analysis. NCAAMB saves snapshot + context only (no Sonnet).
          {
            const prevPeriod = game.last_period || 0;
            if (!game.cal_captured) game.cal_captured = {};
            log(`${matchup}: CAL_DIAG — entering transition block. currentPeriod=${currentPeriod} prevPeriod=${prevPeriod} cal_captured=${JSON.stringify(game.cal_captured)}`);

            // Parse clock minutes for NCAAMB mid-half detection
            let clockMin = null;
            if (clock) {
              const cp = clock.split(':');
              clockMin = (parseInt(cp[0]) || 0) + (parseInt(cp[1] || 0) / 60);
            }

            let transitions = [];

            if (league === 'nba') {
              transitions = [
                { from: 1, to: 2, tag: 'calibration_q1', trigger: 'auto_q1', label: 'Q1', sonnet: true, qdKey: '1', qdPrev: '0' },
                { from: 2, to: 3, tag: 'calibration_q2', trigger: 'auto_q2', label: 'Q2', sonnet: true, qdKey: '2', qdPrev: '1' },
                { from: 3, to: 4, tag: 'calibration_q3', trigger: 'auto_q3', label: 'Q3', sonnet: true, qdKey: '3', qdPrev: '2' },
              ];
            } else if (league === 'ncaamb') {
              // Period-based: halftime (period 1→2)
              transitions.push({ from: 1, to: 2, tag: 'calibration_sq2', trigger: 'auto_sq2', label: 'sQ2(half)', sonnet: false, qdKey: '2', qdPrev: '1' });

              // State-based: if we're past the 10:00 mark, the synthetic quarter boundary should exist
              // DB dedup prevents re-firing on every poll
              if (currentPeriod === 1 && clockMin != null && clockMin <= 10.0) {
                transitions.push({ from: 0, to: 1, tag: 'calibration_sq1', trigger: 'auto_sq1', label: 'sQ1(H1@10)', sonnet: false, clockBased: true, qdKey: '1', qdPrev: '0' });
              }
              if (currentPeriod === 2 && clockMin != null && clockMin <= 10.0) {
                transitions.push({ from: 0, to: 1, tag: 'calibration_sq3', trigger: 'auto_sq3', label: 'sQ3(H2@10)', sonnet: false, clockBased: true, qdKey: '3', qdPrev: '2' });
              }
            } else if (league === 'wnba') {
              // WNBA uses quarters like NBA but sonnet: false during dryRun preseason
              transitions = [
                { from: 1, to: 2, tag: 'calibration_q1', trigger: 'auto_q1', label: 'Q1', sonnet: !cfg.dryRun, qdKey: '1', qdPrev: '0' },
                { from: 2, to: 3, tag: 'calibration_q2', trigger: 'auto_q2', label: 'Q2', sonnet: !cfg.dryRun, qdKey: '2', qdPrev: '1' },
                { from: 3, to: 4, tag: 'calibration_q3', trigger: 'auto_q3', label: 'Q3', sonnet: !cfg.dryRun, qdKey: '3', qdPrev: '2' },
              ];
            }

            // Read quarter_data once for dedup across all transitions
            const _qdDedup = await readQuarterData(sql, game.id);

            for (const t of transitions) {
              // Dedup via quarter_data boundaries — if boundary already captured, transition was processed
              if (_qdDedup.boundaries[t.qdKey]) {
                continue;
              }

              // Period-based transitions: standard detection
              const triggered = t.clockBased
                ? true  // clock-based: already validated above
                : (currentPeriod >= t.to);

              log(`${matchup}: CAL_DIAG — ${t.tag} triggered=${triggered} (currentPeriod=${currentPeriod} >= to=${t.to})`);

              if (triggered) {
                game.cal_captured[t.tag] = true;
                cacheUpdated = true;

                log(`${matchup}: ★ ${t.label} TRANSITION — capturing calibration snapshot`);

                // Save calibration-tagged snapshot
                try {
                  await sql`
                    INSERT INTO snapshots (game_id, period, clock, home_pts, away_pts,
                      floor_score, floor_team, espn_wp_home, espn_wp_away,
                      spread, deficit, trailing_team, lead_sust, lead_class,
                      i1, i2, i3, i4, i5, source, sust_json,
                      tp_class, tp_exp_swing, tp_remain_poss, ls_class, ls_exp_swing, raw_stats_json, espn_raw_stats_json,
                      bwc_state, grad_rank, floor_wp_historical, reliability_class, window_score,
                      xgb_win_prob, xgb_divergence, poss_window_score, mc_win_prob, mc_cum_win_prob, xgb_shap)
                    VALUES (${game.id}, ${currentPeriod}, ${clock}, ${ind.homePts}, ${ind.awayPts},
                      ${ind.score}, ${ind.controlTeam}, ${espnWP?.home || null}, ${espnWP?.away || null},
                      ${spreadVal}, ${deficit}, ${trailingTeam}, ${leadSust}, ${leadClass},
                      ${_ci[0]}, ${_ci[1]}, ${_ci[2]}, ${_ci[3]}, ${_ci[4]},
                      ${t.tag}, ${sustJson},
                      ${snapTp?.classification || null}, ${snapTp ? Math.round(snapTp.expected.totalSwing * 10) / 10 : null}, ${snapTp?.remainingPoss || null}, ${snapLs?.classification || null}, ${snapLs ? Math.round(snapLs.expected.totalSwing * 10) / 10 : null}, ${rawStatsJson}, ${espnRawStatsJson},
                      ${lt?.bwc_fired ? (lt._prev_bwc_state || null) : null}, ${lt?.cp_peak_rank || null},
                      ${_floorWP.wp}, ${_floorWP.reliabilityClass}, ${_windowScore},
                      ${_xgbWinProb != null ? Math.round(_xgbWinProb * 1000) / 1000 : null}, ${_xgbDivergence}, ${_possWindowScore}, ${_pollMC}, ${_mcCum?.winProb != null ? Math.round(_mcCum.winProb * 10000) / 10000 : null}, ${_xgbShap ? JSON.stringify(_xgbShap) : null})
                    ON CONFLICT (game_id, period, clock, home_pts, away_pts) DO NOTHING
                  `;
                  log(`${matchup}: ${t.label} CAL snapshot saved — floor ${ind.controlTeam} ${ind.score} | sust:${leadSust || '?'} class:${leadClass || '?'} | WP:${espnWP?.home || '?'}% | spd:${spreadVal != null ? spreadVal : 'N/A'}`);
                } catch (e) {
                  log(`${matchup}: ${t.label} CAL snapshot save failed: ${e.message}`);
                }

                // ── QUARTER DATA: capture boundary stats + compute diffs ──
                if (t.qdKey) {
                  try {
                    const qd = await readQuarterData(sql, game.id);
                    if (!qd.boundaries[t.qdKey]) {
                      const homeStats = summary.home?.statistics || {};
                      const awayStats = summary.away?.statistics || {};
                      captureBoundary(qd, t.qdKey, t.qdPrev, homeStats, awayStats);
                      await writeQuarterData(sql, game.id, qd);
                      const diffKeys = qd.diffs[t.qdKey] ? Object.keys(qd.diffs[t.qdKey].home || {}).length : 0;
                      log(`${matchup}: ${t.label} quarter_data boundary[${t.qdKey}] captured (diff from [${t.qdPrev}]: ${diffKeys} fields)`);
                    }
                  } catch (e) {
                    log(`${matchup}: ${t.label} quarter_data capture failed: ${e.message}`);
                  }
                }

                // Compute + save server context (PBP, arrows, window, etc.)
                // Server is sole writer — updates on each auto-analysis trigger
                const serverCtx = await computeServerContext(sql, game, league, summary, ind, espnWP, hA, aA, currentPeriod, clock, matchup, sust, odds);
                if (serverCtx) {
                  try {
                    await sql`
                      INSERT INTO game_context (game_id, league, period, context_json, updated_at)
                      VALUES (${game.id}, ${league}, ${currentPeriod}, ${JSON.stringify(serverCtx)}, NOW())
                      ON CONFLICT (game_id, period) DO UPDATE SET context_json = ${JSON.stringify(serverCtx)}, updated_at = NOW()
                    `;
                    log(`${matchup}: ${t.label} server context saved — ${Object.keys(serverCtx).length} layers`);
                  } catch (e) {
                    log(`${matchup}: ${t.label} server context save failed: ${e.message}`);
                  }
                }

                // Fire Sonnet analysis only for NBA (NCAAMB: snapshot + context only)
                if (t.sonnet) {
                  pendingAnalyses.push(
                    fireCalibrationAnalysis(sql, game, league, summary, ind, sust, leadComp, espnWP, odds, matchup, hA, aA, currentPeriod, clock, t.trigger, lt)
                      .catch(e => log(`${matchup}: ${t.label} CAL analysis async error: ${e.message}`))
                  );
                }
              }
            }

            // Track period + clock for transition detection across cycles
            if (league === 'ncaamb' && clockMin != null) {
              game.last_clock_min = clockMin;
            }
          }
          // Always track period for transition detection across cycles
          game.last_period = currentPeriod;

          // ── QUARTER DATA: compute rolling window every poll ──
          // Reads quarter_data (with any freshly captured boundaries), computes
          // partial current quarter diff, scores I1-I5, saves window back.
          // This runs AFTER boundary capture so new boundaries are included.
          if (currentPeriod >= 2 || (league === 'ncaamb' && currentPeriod >= 1)) {
            try {
              const qd = await readQuarterData(sql, game.id);
              const hasDiffs = Object.keys(qd.diffs || {}).length > 0;
              if (hasDiffs) {
                const serverWindow = computeServerWindow(qd, currentPeriod, clock, summary, hA, aA, league);
                if (serverWindow) {
                  qd.window = serverWindow;
                  await writeQuarterData(sql, game.id, qd);
                  log(`${matchup}: QTR window — ${serverWindow.controlTeam} ${serverWindow.score} [${serverWindow.windowQuarters.join(',')}]`);
                }
              }
            } catch (e) {
              log(`${matchup}: server window compute failed: ${e.message}`);
            }
          }

        } catch (e) {
          results.errors.push(`${matchup}: ${e.message}`);
          log(`ERROR ${matchup}: ${e.message}`);
        }
      }

      // ── 5. Update cached schedule if any game status changed ──
      if (cacheUpdated) {
        try {
          // Check if all games are now final
          const allDone = cachedGames.every(g => g.status === 'closed' || g.status === 'complete');
          await sql`
            UPDATE poll_state SET schedule_json = ${JSON.stringify(cachedGames)},
              all_final = ${allDone}
            WHERE league = ${league} AND date = ${dateKey}
          `;
          if (allDone) {
            log(`${league.toUpperCase()}: ALL GAMES FINAL — server going to sleep`);
          }
        } catch (e) {
          log(`Cache update failed: ${e.message}`);
        }
      }

      if (liveCount === 0 && potentiallyLive.length > 0) {
        log(`${league.toUpperCase()}: ${potentiallyLive.length} games checked, none currently live`);
      }

    } catch (e) {
      results.errors.push(`${league}: ${e.message}`);
      log(`ERROR ${league}: ${e.message}`);
    }
  }

  // Wait for all Sonnet analyses to complete (including DB INSERT) before runtime exits
  if (pendingAnalyses.length > 0) {
    log(`Awaiting ${pendingAnalyses.length} Sonnet analyse(s)...`);
    await Promise.all(pendingAnalyses);
    log(`All Sonnet analyses complete.`);
  }

  // NARRATION V2 tail sweep (D-4) — after ALL snapshot/alert/state work has committed.
  // Claims at most one pending narration/brief row; never blocks the heartbeat.
  try { await ssNarrationSweep(sql, startTime); } catch (e) { log(`narration sweep outer: ${e.message}`); }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  if (results.snapshots > 0 || results.errors.length > 0) {
    log(`=== Done in ${elapsed}s | ${results.snapshots} snapshots, ${results.espn} ESPN WP, ${results.odds} odds, ${results.errors.length} errors ===`);
  } else if (results.skipped) {
    log(`=== Done in ${elapsed}s | skipped: ${results.skipped} ===`);
  }

  return new Response(JSON.stringify(results), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── SCHEDULE CONFIG ─────────────────────────────────────────────────────────

export const config = {
  schedule: "*/1 * * * *",  // BDL: every 1 min
};

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

// ── XGBOOST MODEL ──────────────────────────────────────────────────────────
// Raw stats structural model — 300 trees, 14 features, trained on 1,235 games.
// Provides independent win probability from raw box score stats without using
// margin, indicators, or floor score. Used as advisory signal + gate layer.
var XGB_MODEL = null;
try {
  const __xgbDir = dirname(fileURLToPath(import.meta.url));
  XGB_MODEL = JSON.parse(readFileSync(join(__xgbDir, 'xgb-model.json'), 'utf8'));
} catch (e) { /* non-fatal — system operates without XGB */ }

// XGB feature order (must match training):
// [0] game_progress, [1] ctrl_paint_diff, [2] ctrl_pot_diff, [3] ctrl_to_diff,
// [4] ctrl_stl_diff, [5] ctrl_oreb_diff, [6] ctrl_ast_diff, [7] ctrl_blk_diff,
// [8] ctrl_fta_diff, [9] ctrl_efg_diff, [10] ctrl_biglead_diff,
// [11] ctrl_3pr_diff, [12] ctrl_rim_pct_diff, [13] ctrl_run_share
function predictXGB(features) {
  if (!XGB_MODEL) return null;
  let sum = 0;
  for (const tree of XGB_MODEL.trees) {
    let node = 0;
    while (tree.l[node] !== -1) {
      const fval = features[tree.s[node]] ?? 0;
      node = fval < tree.c[node] ? tree.l[node] : tree.r[node];
    }
    sum += tree.w[node];
  }
  const baseLogit = Math.log(XGB_MODEL.base_score / (1 - XGB_MODEL.base_score));
  return 1 / (1 + Math.exp(-(baseLogit + sum)));
}

var XGB_FEATURE_LABELS = ['progress','paint','pot','to','stl','oreb','ast','blk','fta','efg','biglead','3pr','rim_pct','runs'];

// Tree interpreter SHAP — decomposes XGB prediction into per-feature contributions
// Uses precomputed expected values (ev) at each tree node. O(trees × depth) per call.
// Returns all 14 features sorted by |contribution| in logit space.
function computeXGBContributions(features) {
  if (!features || !XGB_MODEL?.trees?.[0]?.ev) return null;
  var contribs = new Float64Array(14);
  for (var ti = 0; ti < XGB_MODEL.trees.length; ti++) {
    var tree = XGB_MODEL.trees[ti];
    var node = 0;
    while (tree.l[node] !== -1) {
      var feat = tree.s[node];
      var child = (features[feat] ?? 0) < tree.c[node] ? tree.l[node] : tree.r[node];
      contribs[feat] += tree.ev[child] - tree.ev[node];
      node = child;
    }
  }
  var ranked = [];
  for (var i = 0; i < 14; i++) {
    ranked.push({ f: XGB_FEATURE_LABELS[i], v: Math.round(contribs[i] * 1000) / 1000 });
  }
  ranked.sort(function(a, b) { return Math.abs(b.v) - Math.abs(a.v); });
  return ranked;
}

function extractXGBFeatures(summary, ind, pbpResult, currentPeriod, clock) {
  if (!summary?.home?.statistics || !summary?.away?.statistics) return null;
  const hs = summary.home.statistics, as = summary.away.statistics;
  const ctrlIsHome = ind.controlTeam === ind.homeAlias;
  const flip = ctrlIsHome ? 1 : -1;

  // Game progress: 0.0 = tipoff, 1.0 = end of Q4
  let clockMin = 6;
  try {
    const parts = String(clock || '12:00').replace(/^Q\d+\s*/, '').split(':');
    clockMin = parseInt(parts[0]) + (parseInt(parts[1] || 0)) / 60;
  } catch (e) { /* use default */ }
  const elapsed = (Math.min(currentPeriod, 4) - 1) * 12 + (12 - clockMin);
  const progress = Math.min(elapsed / 48, 1.0);

  // Shooting efficiency
  const hFGA = Number(hs.field_goals_att || hs.fga || 0) || 0;
  const aFGA = Number(as.field_goals_att || as.fga || 0) || 0;
  const hFGM = Number(hs.field_goals_made || hs.fgm || 0) || 0;
  const aFGM = Number(as.field_goals_made || as.fgm || 0) || 0;
  const hFG3M = Number(hs.three_points_made || hs.fg3m || 0) || 0;
  const aFG3M = Number(as.three_points_made || as.fg3m || 0) || 0;
  const hFG3A = Number(hs.three_points_att || hs.fg3a || 0) || 0;
  const aFG3A = Number(as.three_points_att || as.fg3a || 0) || 0;
  const hEFG = hFGA > 0 ? (hFGM + 0.5 * hFG3M) / hFGA : 0;
  const aEFG = aFGA > 0 ? (aFGM + 0.5 * aFG3M) / aFGA : 0;

  // Rim efficiency (SR-only — 0 if unavailable)
  const hRimM = Number(hs.field_goals_at_rim_made || 0) || 0;
  const hRimA = Number(hs.field_goals_at_rim_att || 0) || 0;
  const aRimM = Number(as.field_goals_at_rim_made || 0) || 0;
  const aRimA = Number(as.field_goals_at_rim_att || 0) || 0;
  const rimDiff = ((hRimM / Math.max(hRimA, 1)) - (aRimM / Math.max(aRimA, 1))) * flip;

  // Run share (PBP — 0.5 if unavailable)
  let runShare = 0.5;
  if (pbpResult?.runs6) {
    const hRuns = pbpResult.runs6.filter(r => r.team === ind.homeAlias).length;
    const aRuns = pbpResult.runs6.filter(r => r.team === ind.awayAlias).length;
    const totalRuns = hRuns + aRuns;
    if (totalRuns > 0) runShare = (ctrlIsHome ? hRuns : aRuns) / totalRuns;
  }

  return [
    progress,
    (Number(hs.points_in_the_paint || hs.points_in_paint || 0) - Number(as.points_in_the_paint || as.points_in_paint || 0)) * flip,
    (Number(hs.points_off_turnovers || 0) - Number(as.points_off_turnovers || 0)) * flip,
    (Number(hs.turnovers || 0) - Number(as.turnovers || 0)) * flip,
    (Number(hs.steals || 0) - Number(as.steals || 0)) * flip,
    (Number(hs.offensive_rebounds || 0) - Number(as.offensive_rebounds || 0)) * flip,
    (Number(hs.assists || 0) - Number(as.assists || 0)) * flip,
    (Number(hs.blocks || 0) - Number(as.blocks || 0)) * flip,
    (Number(hs.free_throws_att || 0) - Number(as.free_throws_att || 0)) * flip,
    (hEFG - aEFG) * flip,
    (Number(hs.biggest_lead || 0) - Number(as.biggest_lead || 0)) * flip,
    (hFGA > 0 && aFGA > 0 ? (hFG3A / hFGA - aFG3A / aFGA) : 0) * flip,
    rimDiff,
    runShare,
  ];
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
    season: '2025',
    aliasMap: { NOP: 'NO', GSW: 'GS', NYK: 'NY', SAS: 'SA', PHX: 'PHO', BKN: 'BKN' },
  },
  ncaamb: {
    srBase: 'https://api.sportradar.com/ncaamb/trial/v8/en/',
    srKeyEnv: 'SR_NCAAMB_KEY',
    espnSlug: 'mens-college-basketball',
    espnBase: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/',
    espnSummaryBase: 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary',
    bdlPrefix: '/ncaab',
    bdlHasSeasonStats: true,
    season: '2025',
    aliasMap: {},  // NCAAMB uses name-based ESPN matching, no alias overrides needed
  },
  wnba: {
    srBase: 'https://api.sportradar.com/wnba/trial/v8/en/',
    srKeyEnv: 'SR_WNBA_KEY',
    espnSlug: 'wnba',
    espnBase: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/',
    espnSummaryBase: 'https://site.web.api.espn.com/apis/site/v2/sports/basketball/wnba/summary',
    bdlPrefix: '/wnba',
    bdlHasSeasonStats: false,
    season: '2025',
    aliasMap: {},
    dryRun: true,  // preseason — collect data, suppress alerts + BWC tracking
  },
};

const BDL_BASE = 'https://api.balldontlie.io';

// BDL team IDs (NBA only — tracking data is NBA-specific)
const BDL_TEAMS = {
  ATL:1, BOS:2, BKN:3, CHA:4, CHI:5, CLE:6, DAL:7, DEN:8, DET:9, GSW:10,
  HOU:11, IND:12, LAC:13, LAL:14, MEM:15, MIA:16, MIL:17, MIN:18, NOP:19, NYK:20,
  OKC:21, ORL:22, PHI:23, PHX:24, POR:25, SAC:26, SAS:27, TOR:28, UTA:29, WAS:30
};

const W = { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };

const SR_DELAY_MS = 1400; // respect trial tier rate limit

// ── SONNET SYSTEM PROMPT (same as analyze.js) ────────────────────────────────
const SONNET_SYSTEM_PROMPT = 'You are an NBA structural analyst. You receive pre-computed mechanical indicators as GROUND TRUTH — do not recompute them. Your job: synthesize a predictive read, compute FWP, identify risks, and write a plain-English narrative.\n\n'
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
+ '  - Bonus status\n\n'
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
// ── HELPERS ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── NTFY PUSH NOTIFICATIONS ─────────────────────────────────────────────
async function sendNtfy(title, body, priority = 4) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    // Node.js fetch requires ASCII-only headers — strip emojis/unicode from Title
    const asciiTitle = title.replace(/\u2014/g, '-').replace(/[^\x00-\x7F]/g, '').replace(/\s+/g, ' ').trim();
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { 'Title': asciiTitle || 'DFT Alert', 'Priority': String(priority), 'Tags': 'basketball' },
      body: body,
    });
    log(`NTFY sent: ${title}`);
  } catch (e) {
    log(`NTFY failed: ${e.message}`);
  }
}

// ── ALERT REASONING AGENT ────────────────────────────────────────────────
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
${ctx.poRank === 'BUY'
  ? 'Position opened by BUY signal at Q' + (ctx.buyOpenPeriod || '?') + ' (no checkpoint graduation).' + (ctx.cpGraduation ? ' Checkpoint progress: team reached ' + ctx.cpPeakRank + '-Rank but PO gates not yet met. MF=' + (ctx.cpMeanFloor?.toFixed(3) || '?') + ' (' + ctx.cpEligibleCount + ' eligible CPs). If PO fires, position upgrades from BUY to graduated rank.' : ctx.cpEligibleCount > 0 ? ' Checkpoint progress: ' + ctx.cpEligibleCount + ' eligible CPs, MF=' + (ctx.cpMeanFloor?.toFixed(3) || '?') + '.' : '') + ' EXIT threshold is timing-dependent — see BUY-OPENED EXIT rules below.'
  : ctx.cpGraduation 
  ? 'Graduation: ' + ctx.cpPeakRank + '-Rank (graduated @ ' + ctx.cpGraduation.cp_label + ', floor was ' + Number(ctx.cpGraduation.floor).toFixed(2) + ') | ' + mfTrajStr + ' | MF=' + (ctx.cpMeanFloor?.toFixed(3) || '?') + ' minF=' + (ctx.cpMinFloor?.toFixed(2) || '?') + ' (' + ctx.cpEligibleCount + ' eligible CPs)'
    + (ctx.cpOppGraduation ? ' | OPPONENT ALSO GRADUATED ' + ctx.cpOppGraduation.rank + '-Rank @ ' + ctx.cpOppGraduation.cp_label : '')
  : 'Pre-graduation (' + (ctx.cpEligibleCount || 0) + ' eligible CPs, MF=' + (ctx.cpMeanFloor?.toFixed(3) || '?') + ' ' + mfTrajStr + ')'
} | Lane: ${ctx.lane || 'unknown'} (pregame ML ${ctx.pregameML || '?'}) | CP flips: ${ctx.cpCtrlFlips} | Control flips (game total): ${ctx.ctrlFlips}

${stress}
STRUCTURE-SCORE RELATIONSHIP:
${ctx.floorMarginSignal && ctx.floorMarginSignal.signal !== 'INSUFFICIENT'
  ? 'Floor trend: ' + ctx.floorMarginSignal.floorTrend + ' | Margin trend: ' + ctx.floorMarginSignal.marginTrend + ' | Signal: ' + ctx.floorMarginSignal.signal
    + (ctx.floorMarginSignal.signal === 'DIVERGING_POSITIVE' ? '\nFloor is declining but scoreboard margin is growing \u2014 structural floor may be stale from cumulative anchoring. Do NOT use erosion as primary suppression signal.' : '')
    + (ctx.floorMarginSignal.signal === 'CONVERGING_DOWN' ? '\nBoth structure and scoreboard declining \u2014 genuine structural decay. Erosion signal is trustworthy.' : '')
    + (ctx.floorMarginSignal.signal === 'DIVERGING_NEGATIVE' ? '\nFloor is rising but margin is shrinking \u2014 structure improving but not translating to scoreboard.' : '')
  : 'Insufficient checkpoint data for floor-margin analysis'}
${ctx.xgbWinProb != null ? `\nXGBOOST STRUCTURAL MODEL (independent — trained on raw stats, does NOT use floor/indicators/margin):
XGB win probability: ${(ctx.xgbWinProb * 100).toFixed(1)}% | Floor: ${(ctx.floor * 100).toFixed(1)}% | ${ctx.xgbAligned ? 'ALIGNED' : '⚠️ DIVERGENT (' + (ctx.xgbDivergence > 0 ? '+' : '') + (ctx.xgbDivergence * 100).toFixed(1) + '%)'}
${ctx.xgbShap ? 'SHAP drivers (what raw stats push XGB prediction): ' + ctx.xgbShap.map(s => s.f + '=' + (s.v > 0 ? '+' : '') + s.v.toFixed(2)).join(', ') : ''}
${!ctx.xgbAligned && ctx.xgbWinProb < 0.45 ? 'WARNING: XGBoost sees < 45% win probability from raw stats despite floor at ' + ctx.floor + '. In 1,235-game backtest, BUY-eligible alerts with XGB < 0.45 win only 11%. Consider SUPPRESS.' : ''}${!ctx.xgbAligned && ctx.xgbWinProb > ctx.floor + 0.15 ? 'NOTE: XGBoost sees stronger edge than floor — raw stats outpace composite indicators.' : ''}` : ''}
${ctx.alertType === 'BUY' && ctx.xgbWinProb != null ? `XGB BUY CALIBRATION (1,235-game backtest, ctrl trailing + floor >= 0.65):
  Q2: XGB>=0.70 = 100% | 0.55-0.70 = 82% | 0.40-0.55 = 78% | <0.40 = 76%
  Q3: XGB>=0.70 = 100% | 0.55-0.70 = 76% | 0.40-0.55 = 73% | <0.40 = 63%
  Q4: XGB>=0.70 = 97%  | 0.55-0.70 = 50% | 0.40-0.55 = 38% | <0.40 = 29%
  Deficit: trail 1-4 viable. Trail 5+: ~50-56% even at XGB 0.55-0.70.
  → This BUY: Q${ctx.period}, XGB ${(ctx.xgbWinProb * 100).toFixed(0)}% = calibrated ${ctx.period >= 4 ? (ctx.xgbWinProb >= 0.70 ? '97%' : ctx.xgbWinProb >= 0.55 ? '50%' : ctx.xgbWinProb >= 0.40 ? '38%' : '29%') : ctx.period >= 3 ? (ctx.xgbWinProb >= 0.70 ? '100%' : ctx.xgbWinProb >= 0.55 ? '76%' : ctx.xgbWinProb >= 0.40 ? '73%' : '63%') : (ctx.xgbWinProb >= 0.70 ? '100%' : ctx.xgbWinProb >= 0.55 ? '82%' : ctx.xgbWinProb >= 0.40 ? '78%' : '76%')} baseline` : ''}

FLOOR TRAJECTORY:
${ctx.floorHistory || 'No prior snapshots'}

PRIOR ALERT REASONING TRAIL:
${ctx.priorAlertTrail || 'None'}

RULES:
- TRACKING: First structural signal — the system just identified ${ctx.ctrlTeam} as structurally interesting (3 consecutive holds, floor ${ctx.floor}, margin ${ctx.margin}). This is NOT a position recommendation — the subscriber learns a game is on the radar. ALWAYS SEND unless the game is clearly meaningless (garbage time, both teams eliminated, period 4 with < 2 min left). Body should explain: which team, what structural picture (indicators, floor, margin), and that we are watching for the edge to develop. Frame as: "Watching [TEAM] — [why they look structurally dominant]. Will update if this develops into a position." Keep it short — this is a heads-up, not a thesis.
- POSITION_OPEN: The team has GRADUATED through the checkpoint system — sustained structural rank confirmed across multiple 3-minute evaluation windows.
  ${ctx.bwcFlipped ? 'BWC FLIP: The system originally tracked ' + ctx.originalBwcTeam + ' but they FAILED to graduate (peak C). ' + ctx.bwcTeam + ' then graduated ' + ctx.poRank + '-Rank — taking structural control away from a previously dominant team. This is one of the strongest signals in the system (74-86% win rate). The floor appears modest because cumulative stats are anchored by ' + ctx.originalBwcTeam + "'s early dominance, but " + ctx.bwcTeam + " is holding control DESPITE that headwind. ALWAYS SEND."
  : ctx.poRank === 'A' && ctx.cpCtrlFlips === 0 ? 'A-Rank WIRE-TO-WIRE (85.6%): Zero checkpoint-level control flips — structural dominance unchallenged. ' + mfTrajStr + ' across ' + ctx.cpEligibleCount + ' checkpoints. ALWAYS SEND.'
  : ctx.poRank === 'A' ? 'A-Rank: Sustained DOMINANT conviction with lead 8+. ' + mfTrajStr + ' across ' + ctx.cpEligibleCount + ' checkpoints. CP flips: ' + ctx.cpCtrlFlips + (ctx.cpCtrlFlips >= 2 ? ' (multiple flips — A-with-flips is 58.5% in competitive games. Apply extra scrutiny: check structural stress, per-quarter breakdown, whether indicators that powered graduation are still held.)' : '') + '.'
  : ctx.poRank === 'B' ? 'B-Rank: Sustained DOMINANT/STRONG conviction with lead 3+. ' + mfTrajStr + ' across ' + ctx.cpEligibleCount + ' checkpoints.'
  + (ctx.cpCtrlFlips === 0 ? ' Zero CP flips — clean structural hold. Standard evaluation.'
   : ctx.cpCtrlFlips === 1 ? ' 1 CP flip — structural control briefly contested. Check: did the BWC team reclaim indicators that slipped? If yes, the graduation is earned through recovery. If the same indicators are still contested, the flip signals fragility.'
   : ' ' + ctx.cpCtrlFlips + ' CP flips — structural control REPEATEDLY contested. B-rank with multiple flips is significantly weaker than B with zero flips. The graduation badge says the team held long enough to pass mechanical gates, but the flips say the opponent keeps taking control back. Apply A-with-flips level scrutiny (58.5% baseline): check structural stress, verify indicators that powered graduation are still held in recent quarters, and confirm the current checkpoint is not another temporary reclaim before the next flip. DOWNGRADE if stress is SHIFT/ERODING. SUPPRESS if stress is COLLAPSING.')
  : ''}
  ${!ctx.bwcFlipped ? 'Lane: ' + (ctx.lane || 'unknown') + '. ' + (ctx.lane === 'underdog' ? 'UNDERDOG graduation — market has not priced structural control. Edge is structural floor vs implied probability. ALWAYS SEND.' : ctx.lane === 'heavy_favorite' ? 'Heavy favorite — PO confirms structural read but line may offer limited edge. Frame as position confirmation, not direct entry.' : 'Evaluate edge: floor vs current ML implied probability.') : ''}
  ${ctx.positionClosed ? 'POST-EXIT RE-ENTRY: The subscriber was told to EXIT this position earlier in the game. If you SEND this POSITION_OPEN, you are telling them to RE-ENTER — this must clear a HIGHER bar than a normal PO. The structural thesis PREVIOUSLY FAILED (that is why EXIT fired). For re-entry to be justified: (1) graduation must show RISING or FLAT MF trajectory with 3+ eligible checkpoints — the team rebuilt control over sustained evaluation windows AFTER the EXIT, (2) structural stress combined read must be REINFORCING or DOMINANT — not COLLAPSING/SHIFT/ERODING, (3) the indicators that powered the EXIT (opponent gaining I1/I2/I4) must have flipped BACK to the BWC team in the per-quarter breakdown. If ANY of these fail, SUPPRESS — the graduation badge is stale anchoring from pre-EXIT dominance, not evidence of current control. DOWNGRADE is acceptable if graduation is mechanically real but stress is mixed.' : ''}
  Also check: CP trend (all, unfiltered) gives the full trajectory including bad stretches that eligible MF hides. If eligible MF says RISING but full CP trend says DECLINING, the graduation badge may overstate current control.
  This IS a position recommendation. Body should reference the arc from TRACKING (if prior alert exists), explain the graduation criteria met, current structural picture, and frame as: "Position open on [TEAM] — [rank] structural edge confirmed." Include odds/ML if available.
- VALUE: team PREVIOUSLY held a structural lead (BWC fired Q${ctx.bwcFirePeriod || '?'}) but lost it while retaining structural control. Thesis: "structural edge that built the lead is intact — dip is temporary, plus-money entry."
  EVALUATE WITH ALL SIGNALS — no single signal alone justifies suppression:
  1. Erosion (mean-anchored): STABLE/CAUTION = thesis intact. COLLAPSE = skepticism, but check signals 2-3.
  2. Floor-margin signal: DIVERGING_POSITIVE overrides COLLAPSE erosion — team is winning despite low floor, structure is stale from cumulative anchoring. CONVERGING_DOWN confirms COLLAPSE — genuine decay.
  3. Conviction trend: STABLE/HELD = structural core intact despite floor drop (cumulative indicators held). DEGRADING = real structural loss across checkpoints.
  SUPPRESS only when 2+ signals agree on decline: erosion COLLAPSE + floor-margin CONVERGING_DOWN, or erosion COLLAPSE + conviction DEGRADING, or floor-margin CONVERGING_DOWN + conviction DEGRADING. Single-signal COLLAPSE alone is NOT sufficient.
  Also verify: deficit depth (1-7 best), timing (Q2-Q3 > Q4). If prior BWC_EDGE alerts flagged a RISK, reference whether it materialized.
- THESIS_ALIVE: BWC team regained structural control AFTER an EXIT. This is a deep-value play — floor erosion is EXPECTED and is WHY plus-money exists. DO NOT treat floor level or erosion as primary factors. Weight hierarchy: (1) WHICH indicators does the BWC team still hold? I1 Disruption + I4 Game Control = structural core retained. (2) Is opponent's edge variance-based? oppI3Won=true means opponent is shooting well, not structurally dominant — this is the thesis. (3) TP path — STRONG RECOVERY or PROBABLE = mechanical path exists. (4) Deficit depth and timing. Floor being below BWC fire floor is the ENTRY SIGNAL, not a red flag. SUPPRESS only if: BWC team lost I1+I4 (structural core gone), OR opponent has non-I3 structural indicators (I1/I2/I4), OR TP is NO PATH/UNLIKELY with < 3 min left.
${ctx.positionClosed ? '  POST-EXIT THESIS_ALIVE: Position is CLOSED. The subscriber was told to EXIT, and now the BWC team has clawed back to VALUE state. This is a RE-ENTRY signal — if you SEND, you are telling them to re-open the position they were told to close. Apply the standard THESIS_ALIVE criteria above (I1+I4, TP path, opponent profile) AND verify via per-quarter breakdown that the structural recovery is happening in RECENT quarters, not just cumulative anchoring. Reference the EXIT reasoning from PRIOR ALERT REASONING TRAIL — what specifically broke? Has it been fixed?' : ''}
- EXIT: BWC team (${ctx.bwcFirePeriod ? 'the team that fired BWC in Q' + ctx.bwcFirePeriod : 'original BWC team'}) lost structural control. The SUBSCRIBER'S POSITION is on the BWC team, NOT the current control team. Frame the exit around the BWC team losing their edge. Reference the full arc from prior alerts.
  Floor-margin confirmation: CONVERGING_DOWN + conviction DEGRADING = strong EXIT confirmation (genuine structural death). DIVERGING_POSITIVE (floor low but margin growing) = EXIT may be premature — structural floor is stale while the team is actually winning. Check conviction trend — if conviction held STABLE/DOMINANT throughout, the floor is the problem, not the team.
- BWC_EDGE: SEND by default — this is a position update for a subscriber already holding. Frame as reassurance: structural picture holding, lead compressing. Do NOT frame as a buy signal. MAY SUPPRESS if structural stress override applies (see STRUCTURAL STRESS CHECK). MUST include a RISK line at the end of the body — identify the ONE specific thing that could flip this position next (e.g., indicator about to flip, sustainability degrading, erosion approaching threshold, floor-margin DIVERGING_NEGATIVE meaning structure improving but margin shrinking). If prior alerts flagged a RISK, reference whether it materialized or not. Check conviction trend — DEGRADING conviction is a key risk to flag even if floor is stable. The RISK line creates accountability across the alert chain. Format body as: status update (2-3 sentences) + "RISK: [specific forward-looking concern]"
- POSITION_SAFE / POSITION_RECOVERING: SEND as reassurance if prior alerts flagged risks or concerns. Include whether prior RISK materialized. SUPPRESS only if nothing changed AND no prior risk to update on. Write reasoning for compounding either way.
${ctx.positionClosed ? '  POST-EXIT RECOVERY: Position is CLOSED — the subscriber was told to EXIT. This recovery alert (BWC team leading again) could RE-OPEN the position. Apply elevated scrutiny: (1) structural stress combined read must be REINFORCING or DOMINANT — not COLLAPSING/SHIFT/ERODING, (2) the indicators that caused the EXIT must have flipped BACK to the BWC team in recent quarters, (3) the recovery must be sustained (consecutive holds, not a single-snapshot spike). If the BWC team is genuinely back in control with structural evidence, SEND — this is a strong signal (thesis broke and then repaired). If the recovery looks like cumulative anchoring or a brief reclaim before the next flip, SUPPRESS. Reference the EXIT reasoning from the PRIOR ALERT REASONING TRAIL.' : ''}
- BUY: structurally dominant team trailing. Standard evaluation — floor, indicators, TP, deficit depth (1-7 sweet spot; deeper deficits need stronger structural case). When bwcTeamMatch is noted, the team has BWC lifecycle context — reference the position arc. This is a "warm BUY" (thesis history). Without BWC context = "cold BUY" (unproven, higher bar for SEND).
- BUY EVIDENCE (from 9,861-snapshot backtest, 502 BUY-eligible):
  WHAT WINS: trail 1-4 (44.6%) > trail 5-9 (25%) > trail 10+ (0%). 3+ ctrl indicators (45.6%) > <=2 (36.6%). Opp 0 indicators (48.6%) vs opp I1 or I2 won (28.5%). Best stack: trail 1-4 + 3+ ind + opp 0 indicators = 57.4% (n=115).
  POWER PAIRS: I1+I2 (55.2%, n=134) is the BUY anchor — physical dominance while trailing. I1+I4 (52.4%). TRAP: I3+I4 (38.9%, n=149) — the BWC killer combo is the WORST BUY pair.
  I3 INVERSION: ctrl I3 won = 37.3%. ctrl I3 LOST (opp shooting well) = 49%. When the BUY team has shot quality but is STILL trailing, they are losing for reasons shooting cannot fix. When trailing BECAUSE of poor shooting, that is the variance the thesis exploits.
  OPPONENT KILLS: opp I1 (disruption) -> 28.8%. opp I2 (paint) -> 30.6%. opp I1 OR I2 -> 28.5%. These are STRUCTURAL threats. opp I3 only -> thesis intact (variance).
  TIMING: Q4 trail 5-9 = 14.8% — hard suppress. Q4 trail 1-4 = 43% — still viable.
  XGB QUARTER RULE: Q4 BUYs with XGB < 0.60 are historically 29-38% (money-losing). Q2-Q3 BUYs with XGB 0.55+ are 73-82%. XGB >= 0.70 at any quarter = 98.7% (n=78). Weight XGB more heavily in Q4 — by Q4 the raw stats have full-game sample and structural non-conversion is the dominant signal.
  CHECKPOINT GRADUATION CONTEXT (additional data for BUY evaluation — does not override BUY evidence above):
  ${ctx.cpGraduation
    ? 'BWC team (' + ctx.bwcTeam + ') GRADUATED ' + ctx.cpPeakRank + '-Rank @ ' + ctx.cpGraduation.cp_label + '. ' + mfTrajStr
    : ctx.cpEligibleCount > 0
      ? 'BWC team (' + ctx.bwcTeam + ') pre-graduation: ' + ctx.cpEligibleCount + ' eligible checkpoints. ' + mfTrajStr
      : ctx.bwcTeam
        ? 'BWC team (' + ctx.bwcTeam + ') tracked but no eligible checkpoints — structural interest identified but never confirmed.'
        : 'No BWC context — cold BUY.'
  }
  ${ctx.cpOppGraduation ? 'Opponent graduated ' + ctx.cpOppGraduation.rank + '-Rank @ ' + ctx.cpOppGraduation.cp_label + (ctx.cpOppGraduation.cp_idx > (ctx.cpGraduation?.cp_idx ?? -1) ? ' (MORE RECENT than BWC graduation — opponent is structurally ascending)' : '') : ''}
  ${ctx.bwcFlipped ? 'BWC FLIPPED: System originally tracked ' + ctx.originalBwcTeam + ' -> structural control transferred to ' + ctx.bwcTeam + '. Latest-to-graduate wins 84.5% historically.' : ''}
  
  BWC LIFECYCLE STATUS FOR BUY DECISIONS:
  The BUY team's relationship to the BWC lifecycle determines baseline confidence:
  
  - BUY team = current BWC team WITH active PO: "Warm BUY" — graduated team trailing is the thesis working. MF trajectory tells you if the structural edge is holding.
  - BUY team = current BWC team WITHOUT PO (graduated but gates blocked): Structural edge confirmed mechanically but quality didn't meet PO gates. Moderate confidence — rely on standard BUY evidence with graduation as supporting context.
  - BUY team = BWC team but NEVER graduated (tracked, no graduation): System identified structural interest but edge never separated. Lower confidence. Rely entirely on standard BUY evidence. MF trajectory may show INSUFFICIENT.
  - BUY team = original BWC team but BWC was FLIPPED to opponent: Near-automatic SUPPRESS. This team LOST structural control to the opponent. You are buying against the confirmed structural direction. The team that took it away from them graduated more recently and wins 84.5% of the time.
  - BUY team = opponent of BWC team (not flipped): Evaluate independently. If opponent has graduated, their structural case is strong — they earned it against the BWC team.
  - No BWC context at all: Cold BUY — rely entirely on standard BUY evidence above.
  
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
  - DECLINING = the game may have shifted since graduation. The rank badge is stale. Extra skepticism — check if indicators that powered graduation are still held.
  - INSUFFICIENT = fewer than 2 eligible checkpoints. Rely on standard BUY evidence.
  
  LANE AMPLIFIERS:
  - Underdog + RISING MF = highest confidence — market hasn't priced sustained structural control, and it's getting stronger.
  - Heavy favorite + DECLINING MF = lowest confidence — expected dominance is fading, position may be compromised.
  
  DEFICIT DEPTH + GRADUATION: trail 5-9 with graduation = structural thesis may be wrong, apply extra scrutiny regardless of trajectory. Trail 10+ with graduation = near-automatic SUPPRESS (the structural read was incorrect regardless of rank).
  
  HOW TO USE CP FLIPS ON BUY DECISIONS:
  
  POSITION OPEN (agent endorsed PO — subscriber holds a position):
  The agent already validated this graduation. Trailing is the thesis working. CP flips provide risk context.
  - 0 flips = strongest warm BUY. Structural thesis unchallenged — trailing is pure variance.
  - 1-2 flips = warm BUY with caution. Note flips in RISK line. Apply standard BUY evidence.
  - 3+ flips = extreme skepticism. Structural control has been REPEATEDLY contested at the checkpoint level — this is a competitive game, not a structural mismatch. The graduation may be mechanically valid but the game is not separating. Rely entirely on standard BUY evidence (deficit depth, indicator profile, opponent indicators). Do NOT treat graduation as confidence — treat it as context only. SUPPRESS unless BUY evidence is independently strong (trail 1-4, 3+ indicators, opp 0 structural indicators).
  
  POSITION CLOSED (EXIT was sent — agent already rejected this thesis):
  The thesis BROKE. The agent already said to exit and may have suppressed re-entry. Rank at original graduation does not matter — A and B exits are equally severe. What matters is the quality of re-graduation AFTER the exit.
  - If original rank was A and team re-graduates B or A: the structural foundation was deep enough to earn A originally. Re-graduation is more credible — the team has a proven ability to sustain structural control. Still requires something fundamentally changed since the SUPPRESS reasoning.
  - If original rank was B and team re-graduates B or A: weaker credibility. The team never fully separated structurally before the thesis broke. Re-graduation may be cumulative anchoring. Apply extreme skepticism — require clear evidence in per-quarter breakdown that recent quarters (post-EXIT) are structurally dominated by the BUY team, not just cumulative carryover.
  - In BOTH cases: reference the agent's prior EXIT and SUPPRESS reasoning from the PRIOR ALERT REASONING TRAIL. What specific structural failures caused the EXIT? Have those specific indicators flipped back? If the same weaknesses persist, SUPPRESS regardless of re-graduation rank.
- STRUCTURAL STRESS CHECK: When combined read is COLLAPSING, FLIPPED, or SHIFT, the cumulative floor may be anchored from earlier-quarter dominance that has since eroded. The rolling window shows who is winning RECENT quarters.
  For entry signals (BUY, VALUE, THESIS_ALIVE): COLLAPSING + trailing = near-automatic SUPPRESS. SHIFT = extreme skepticism.
  For position alerts (POSITION_OPEN, BWC_EDGE, POSITION_SAFE, POSITION_RECOVERING): When the rolling window is SIGNIFICANTLY weaker than the cumulative floor, you MAY SUPPRESS or DOWNGRADE — this OVERRIDES the per-alert-type ALWAYS SEND rules above. The graduation badge does not guarantee current structural control. Evaluate whether the indicators that powered graduation are still held in recent quarters using the per-quarter breakdown. If recent quarters show the opponent winning paint, disruption, or game control, the graduation is stale.
  DOWNGRADE is preferred over SUPPRESS for POSITION_OPEN (subscriber should know graduation happened but that it is contested).
  BWC_EDGE and POSITION_SAFE may fully SUPPRESS (these are updates to existing positions — no value in reassuring the subscriber about a position that is structurally compromised).
  EXEMPT from stress override: EXIT on GRADUATED positions (always SEND), TRACKING (always SEND), A-Rank WIRE-TO-WIRE with 0 flips (strongest signal, stress override should not touch).
  EXIT on BUY-OPENED positions (poRank = BUY): Position was opened by a BUY signal, not checkpoint graduation. EXIT is NOT automatic. Apply timing-based opponent floor thresholds:
    BUY opened Q4: Any control flip is meaningful (91% precision). SEND.
    BUY opened Q3: Opponent must show >= 0.60 floor for EXIT to be warranted (79% precision). Below 0.60 = noise flip, SUPPRESS.
    BUY opened Q2: Opponent must show >= 0.60 floor (68% precision). Lean SUPPRESS unless opponent holds structural indicators (I1, I2, or I4).
    LANE ADJUSTMENT for underdogs (lane = underdog, ML > +100): Raise opponent floor threshold by +0.05 to preserve high-payout positions. Q3 BUY: opponent needs 0.65. Q2 BUY: opponent needs 0.65. Q4 BUY: opponent needs 0.55.
    FLIP BUY SIGNAL: When EXIT on a BUY-opened position AND opponent floor >= 0.65, note in the body that structural reversal suggests a potential entry on the opponent side.
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
${ctx.xgbWinProb != null ? 'XGBoost structural model: ' + (ctx.xgbWinProb * 100).toFixed(1) + '% win probability (independent raw-stats model). ' + (ctx.xgbAligned ? 'ALIGNED with floor.' : '⚠️ DIVERGENT from floor (' + (ctx.xgbDivergence > 0 ? '+' : '') + (ctx.xgbDivergence * 100).toFixed(1) + '%).') + (ctx.xgbShap ? ' SHAP: ' + ctx.xgbShap.map(s => s.f + '=' + (s.v > 0 ? '+' : '') + s.v.toFixed(2)).join(', ') : '') : ''}

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
- BUY/WINDOW BUY: the thesis is "structurally dominant team is trailing due to unsustainable opponent variance." Verify the control team actually dominates AND the opponent's lead is variance-driven.
- BWC (Buy Window Closing): the thesis is "market hasn't priced in structural dominance yet." Verify edge is real and lead is secure.
  • BWC + I4 EVEN: Unlike BUY (where the team must TAKE control back), BWC teams already HOLD the lead. I4 EVEN is NOT a suppress signal for BWC when 3+ other indicators favor the control team and sustainability is LOCKED IN, DURABLE, or STALLED. STALLED means both shooting dimensions are significantly below baseline — but a lead built on paint and transition doesn't need hot shooting to hold. Only suppress BWC on I4 EVEN if fewer than 3 indicators won OR sustainability is FRAGILE/UNSUSTAINABLE OR floor is unstable (dropped 0.15+ in recent snapshots).
- RECOVERY PATH: math projects a comeback. SEND if structural indicators (especially I4) back the TP math — I4 COMBO YES + rising floor means the engine is real. SUPPRESS if TP is anchored from early-game cumulative stats that have since eroded — floor declining + I4 COMBO NO means the opponent actually has game control despite favorable TP math. DOWNGRADE if math works but structural case is modest (2/5 indicators, CONDITIONAL conviction).
- LEAD CRUMBLING: WARNING alert — INVERTS normal indicator logic. For entry alerts (BUY/BWC), strong indicators = SEND. For LEAD CRUMBLING, strong indicators = lead is SAFE = SUPPRESS. The question is: "is this lead actually in danger, or is LS just reacting to a hot opponent quarter?"
  • I4 COMBO YES + 3+ indicators + LOCKED IN/DURABLE sust → SUPPRESS: structural foundation is solid, this is noise not a real crumble
  • I4 EVEN/NO + declining floor + sust shifting toward opponent → SEND: real erosion, bettor needs the warning
  • Floor dropped 0.10+ from prior snapshots + conviction downgraded → SEND: structural case is deteriorating
  • If a prior BWC or BUY was SENT for this team in priorAlerts: lean SEND — the subscriber has a position to protect and needs to know about threats
- VARIANCE BREAKING: opponent's shooting is regressing toward the mean. SEND if structural edge is clear (I4 COMBO YES, 3+ indicators) and the sustainability shift is meaningful. SUPPRESS if structural edge is thin (I4 EVEN, 1-2 indicators) or the sustainability drop is a borderline tier flip that could reverse.
- STRUCTURAL_SHIFT: Pre-flip early warning — the trailing team is gaining structural control BEFORE the floor has officially flipped. Fires when: floor declined 0.15+ from peak, trailing team holds 1+ indicators in the recent window (0.65+), and margin compressed 3+ from peak (Q3+). ALWAYS SEND — the mechanical gates are the filter. Your job is to add valuable context: (1) WHICH indicators the incoming team holds and whether they are structural (I1 disruption / I2 paint / I4 game control) or variance-based (I3 shot quality only), (2) whether the shift is likely to result in a full control flip or just a temporary compression, (3) the floor reliability class of both teams if available. Frame as informational: "Structural shift developing — [team] recovering structural control." This is NOT a position recommendation — it is a heads-up that a control flip may be incoming.
- ANCHORED FLOOR CHECK: If team is TRAILING with floor 0.75+ but margin only 1-3 pts AND floor is declining from recent snapshots, the floor may be anchored from earlier dominance that has eroded. Verify recent quarters still favor control team before SEND. This rule does NOT apply to leading teams (BWC/WINDOW BUY) — a high floor with a small lead is a valid structural read.
- EARLY GAME NOTE (Q1-Q2): Indicator samples are smaller early — steals/blocks counts are low, run share may not be populated yet, and biggest_lead gaps can form from a single early run. This does NOT mean early signals are unreliable. The new indicator formulas have proven predictive even in Q2. For Q1-Q2 FIRED alerts: I4 COMBO YES = SEND with confidence. I4 COMBO NO = apply normal scrutiny (don't auto-reject, just verify the structural case). For Q1-Q2 CANDIDATE alerts: I4 COMBO YES = SEND. I4 COMBO NO = apply extra scrutiny but still SEND if floor is strong (0.75+) and sustainability favors control team. Q3+ alerts have the most data — highest confidence.
- CANDIDATE BUYs at floor 0.55-0.65: only SEND if I4 COMBO is YES (I4 decisive + at least one other indicator agrees — this pattern is 98-100% accurate historically). Without I4 COMBO, require very strong sustainability case to justify SEND.
- CANDIDATE BUYs with negative ML (heavy favorite trailing): the CANDIDATE tier reflects the ML gate (-250 to -400), NOT structural weakness. Evaluate the structural case as if it were FIRED — if I4 COMBO YES + STRONG/DOMINANT conviction, SEND so the subscriber can shop for favorable lines. Note the heavy ML in the BODY.
- TP (Throughput Projection) is context, not a veto. It estimates whether a trailing team's structural production rate can close the deficit in remaining possessions. Limitation: TP uses cumulative game stats, so early-game dominance by either team anchors the rates even after momentum shifts. TP NO PATH at 1-3 point deficits is often a false negative — the game is essentially tied regardless of what the projection math says. TP STRONG RECOVERY or PROBABLE adds confidence. TP UNLIKELY or NO PATH is a caution flag, not a stop sign.

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
        model: 'claude-opus-4-6',
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
  if (!cfg.bdlHasSeasonStats) return { teamIds: {}, gameIds: {} };
  // dateStr format: YYYY-MM-DD
  // NCAAMB: BDL uses UTC dates, so late-ET games appear on the next UTC day.
  // Fetch both the requested date and the next day, merge results.
  const dates = [dateStr];
  if (league === 'ncaamb') {
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

    if (ev.shooting_play) {
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

  return {
    home: aggTeam(hA), away: aggTeam(aA),
    homeAlias: hA, awayAlias: aA,
    totalShots: shots.length, totalTOs: turnovers.length,
    runs: runs.slice(0, 10),
    runs6,
    perQuarter: buildPerQuarterMetrics(shots, turnovers, hA, aA),
    pbpPeriod: lastP, pbpAge: 0,
    _bdl: { potHome: potH, potAway: potA, scpHome: scpH, scpAway: scpA, biggestLeadHome: bigH, biggestLeadAway: bigA, scoreLog },
  };
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
        model: 'claude-opus-4-6',
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
const GRAD_CHECKPOINTS = [
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

const LANE_THRESHOLDS = {
  underdog:       { mfGate: 0.65, minFGate: 0.58 },  // pregame ML > +100 (<50% implied)
  tossup:         { mfGate: 0.65, minFGate: 0.58 },  // pregame ML +100 to -150 (50-60% implied)
  favorite:       { mfGate: 0.65, minFGate: 0.58 },  // pregame ML -151 to -300 (60-75% implied)
  heavy_favorite: { mfGate: 0.65, minFGate: 0.58 },  // pregame ML -301 or worse (75%+ implied)
};

function updateLiveTracking(lt, ctrlTeam, floor, period, clock, homeAlias) {
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

  if (bwcFired.team === ctrlTeam) {
    if (margin >= 3) return 'LOCK';
    if (margin >= 1) return 'EDGE';
    if (margin >= -7) return 'VALUE';
    return 'DEEP_TRAIL';
  } else {
    return 'EXIT';
  }
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

// ── CHECKPOINT GRADUATION HELPERS ────────────────────────────────────────────

function computeCheckpointFloorStats(checkpoints, bwcTeam) {
  // Only BWC-eligible checkpoints: team has control + floor >= 0.60 + margin >= 2
  const eligible = checkpoints.filter(cp =>
    cp.team === bwcTeam && cp.floor >= 0.60 && cp.margin >= 2
  );
  if (eligible.length === 0) return { meanFloor: null, minFloor: null, eligibleCount: 0 };

  let sum = 0, min = 999;
  for (const cp of eligible) {
    sum += cp.floor;
    if (cp.floor < min) min = cp.floor;
  }
  return {
    meanFloor: Math.round((sum / eligible.length) * 1000) / 1000,
    minFloor: Math.round(min * 1000) / 1000,
    eligibleCount: eligible.length,
  };
}

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

function getLaneGates(lane) {
  return LANE_THRESHOLDS[lane] || LANE_THRESHOLDS.tossup;
}

// ── SERVER-SIDE COMPUTE (I1–I5) ─────────────────────────────────────────────
// Pure function. No cardState, no DOM, no PBP, no baselines.
// Input: SR game summary JSON. Output: indicator scores + composite.

function computeServer(summary, pbpData, seasonQ4) {
  const H = summary.home, A = summary.away;
  if (!H || !A) return null;
  const hs = H.statistics || {}, as = A.statistics || {};
  const hA = H.alias || H.name || 'HOME', aA = A.alias || A.name || 'AWAY';
  const hS = H.points || 0, aS = A.points || 0;
  if (hS === 0 && aS === 0) return null;

  // I1 — Disruption & Conversion
  const hDisrupt = (hs.steals || 0) + (hs.blocks || 0);
  const aDisrupt = (as.steals || 0) + (as.blocks || 0);
  const disruptDiff = hDisrupt - aDisrupt;
  const i1subA = disruptDiff > 1 ? 1 : disruptDiff < -1 ? -1 : 0;
  const hPOT = hs.points_off_turnovers || 0, aPOT = as.points_off_turnovers || 0;
  const potDiff = hPOT - aPOT;
  const i1subB = potDiff > 4 ? 1 : potDiff < -4 ? -1 : 0;
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
  const i2raw = i2subA + i2subB;
  const I2 = { score: i2raw > 0 ? 1 : i2raw < 0 ? 0 : 0.5, leader: i2raw > 0 ? hA : i2raw < 0 ? aA : 'EVEN' };

  // I3 — Shot Quality & Creation
  const hFGA = hs.field_goals_att || 1, aFGA = as.field_goals_att || 1;
  const hEFG = ((hs.field_goals_made || 0) + 0.5 * (hs.three_points_made || 0)) / hFGA;
  const aEFG = ((as.field_goals_made || 0) + 0.5 * (as.three_points_made || 0)) / aFGA;
  const hAst = hs.assists || 0, aAst = as.assists || 0;
  const hFGM = hs.field_goals_made || 1, aFGM = as.field_goals_made || 1;
  const hAR = (hAst / hFGM) * 100, aAR = (aAst / aFGM) * 100;
  const hCS3 = pbpData?.home?.threes?.assisted || 0, aCS3 = pbpData?.away?.threes?.assisted || 0;
  const i3raw = (hEFG > aEFG + 0.02 ? 1 : hEFG < aEFG - 0.02 ? -1 : 0)
              + (hAR > aAR + 5 ? 1 : hAR < aAR - 5 ? -1 : 0)
              + (hCS3 > aCS3 + 2 ? 1 : hCS3 < aCS3 - 2 ? -1 : 0);
  const I3 = { score: i3raw > 0 ? 1 : i3raw === 0 ? 0.5 : 0, leader: i3raw > 0 ? hA : i3raw < 0 ? aA : 'EVEN' };

  // I4 — Game Control
  const hBigLead = hs.biggest_lead || 0, aBigLead = as.biggest_lead || 0;
  // Flip: need ≥2 gap. Contested: opponent within 75% of leader's biggest lead.
  let i4subA = 0;
  if (hBigLead >= aBigLead + 2) {
    i4subA = (aBigLead >= 0.75 * hBigLead) ? 0 : 1;
  } else if (aBigLead >= hBigLead + 2) {
    i4subA = (hBigLead >= 0.75 * aBigLead) ? 0 : -1;
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

  // I5 — Sustained Execution (run share from PBP)
  let I5 = { score: 0.5, leader: 'EVEN' };
  if (pbpData?.runs6) {
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

// ── CONVICTION ENGINE — combo-pattern-driven from 171-game validation ──────
// Returns mechanical conviction tier based on WHICH indicators the control team wins.
// Data basis: I4+I5=100%(77g), I3+I4=99%(68g), I3+I5=96%(68g), 4+=100%(66g), 3=85%(62g), 2=70%(33g)
function computeConviction(ind) {
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

  // Check killer pairs
  const hasI4I5 = has('I4', 'I5');
  const hasI3I4 = has('I3', 'I4');
  const hasI3I5 = has('I3', 'I5');
  const hasKillerPair = hasI4I5 || hasI3I4 || hasI3I5;

  // Danger combos — high count but historically weak
  const isDanger = (
    (count === 2 && wins.includes('I1') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4')) || // I1+I5 only: 50%
    (count === 3 && wins.includes('I1') && wins.includes('I2') && wins.includes('I5') && !wins.includes('I3') && !wins.includes('I4')) || // I1+I2+I5: 40%
    (count === 3 && wins.includes('I2') && wins.includes('I3') && wins.includes('I5') && !wins.includes('I4')) // I2+I3+I5: 63%
  );

  let tier;
  if (count >= 4 || hasI4I5) {
    tier = 'DOMINANT';   // 100% historical
  } else if (hasKillerPair && !isDanger) {
    tier = 'STRONG';     // 96-99% historical
  } else if (count >= 2 && !isDanger) {
    tier = 'MODEST';     // 70-80% historical
  } else if (count >= 1) {
    tier = 'CONDITIONAL'; // 40-70%, needs Sonnet justification
  } else {
    tier = 'NO ENTRY';   // 0 indicators
  }

  // Pairs found (for logging/display)
  const pairs = [];
  if (hasI4I5) pairs.push('I4+I5');
  if (hasI3I4) pairs.push('I3+I4');
  if (hasI3I5) pairs.push('I3+I5');

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
  const periodLength = league === 'ncaamb' ? 20 : 12;
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
  const i1r = wDisruptDiff > 1 ? 1 : wDisruptDiff < -1 ? -1 : 0;
  const wI1 = { score: i1r > 0 ? 1 : i1r === 0 ? 0.5 : 0, leader: i1r > 0 ? hA : i1r < 0 ? aA : 'EVEN' };

  // I2 — Interior Control (Sub-A: paint volume ±3 for window, Sub-B: rim efficiency ±10%)
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
  const wi2raw = wi2subA + wi2subB;
  const wI2 = { score: wi2raw > 0 ? 1 : wi2raw < 0 ? 0 : 0.5, leader: wi2raw > 0 ? hA : wi2raw < 0 ? aA : 'EVEN' };

  // I3 — Shot Quality & Creation (eFG% and assist ratio are rates — thresholds unchanged)
  const hEFG = hW.efg || 0, aEFG = aW.efg || 0;
  const hAR = hW.assist_ratio || 0, aAR = aW.assist_ratio || 0;
  const i3r = (hEFG > aEFG + 0.02 ? 1 : hEFG < aEFG - 0.02 ? -1 : 0)
            + (hAR > aAR + 5 ? 1 : hAR < aAR - 5 ? -1 : 0);
  const wI3 = { score: i3r > 0 ? 1 : i3r === 0 ? 0.5 : 0, leader: i3r > 0 ? hA : i3r < 0 ? aA : 'EVEN' };

  // I4 — Game Control (cumulative biggest_lead + window scoring margin)
  const hBigLead = homeStats.biggest_lead || 0, aBigLead = awayStats.biggest_lead || 0;
  let wi4subA = 0;
  if (hBigLead >= aBigLead + 2) {
    wi4subA = (aBigLead >= 0.75 * hBigLead) ? 0 : 1;
  } else if (aBigLead >= hBigLead + 2) {
    wi4subA = (hBigLead >= 0.75 * aBigLead) ? 0 : -1;
  }
  const margins = windowQs.map(wq => ((wq.diff?.home?.points || 0) - (wq.diff?.away?.points || 0)));
  const marginSum = margins.reduce((a, b) => a + b, 0);
  const wi4subB = marginSum > 4 ? 1 : marginSum < -4 ? -1 : 0;
  const i4r = wi4subA + wi4subB;
  const wI4 = { score: i4r > 0 ? 1 : i4r === 0 ? 0.5 : 0, leader: i4r > 0 ? hA : i4r < 0 ? aA : 'EVEN' };

  // I5 — Sustained Execution (cumulative runShare — runs not window-segmentable)
  const wI5 = { score: 0.5, leader: 'EVEN' };

  // Composite
  const raw = wI1.score * W.I1 + wI2.score * W.I2 + wI3.score * W.I3 + wI4.score * W.I4 + wI5.score * W.I5;
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
    var seasonPrior3Pct = 36.0; // NBA average fallback
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
      var twoPointBase = league === 'ncaamb' ? 0.49 : 0.52;
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

// ── VOLUME THREAT DETECTION ──────────────────────────────────────────────────
// Identifies teams with scheme-driven high-volume 3PT production at baseline.
// Returns per-team: active flag, projected 3PA, discount (for floor), vtBonus (for structRate).

function computeVolumeThreat(summary, pbpAudit, sust, league, minsElapsed) {
  var GAME_MINUTES = league === 'ncaamb' ? 40 : 48;
  var sznDefault = league === 'ncaamb' ? 33 : 36;

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

function computeSwingCoreServer(focalStats, targetStats, focalSustData, targetSustData, deficit, minsLeft, minsElapsed, gameFraction, sznDefault, focalVTBonus, targetVTBonus) {
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
  var twoPointBaseline = sznDefault <= 34 ? 0.49 : 0.52; // NCAAMB ~49%, NBA ~52%
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

  var PERIOD_MINUTES = league === 'ncaamb' ? 20 : 12;
  var GAME_MINUTES = league === 'ncaamb' ? 40 : 48;
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
  var sznDefault = league === 'ncaamb' ? 33 : 36;

  var focalSustData = sust ? (ctrlIsHome ? sust.home : sust.away) : null;
  var targetSustData = sust ? (ctrlIsHome ? sust.away : sust.home) : null;

  // Volume threat: focal = control team, target = opponent
  var focalVT = volumeThreat ? (ctrlIsHome ? volumeThreat.home?.vtBonus : volumeThreat.away?.vtBonus) : 0;
  var targetVT = volumeThreat ? (ctrlIsHome ? volumeThreat.away?.vtBonus : volumeThreat.home?.vtBonus) : 0;

  var core = computeSwingCoreServer(focalStats, targetStats, focalSustData, targetSustData, deficit, minsLeft, minsElapsed, gameFraction, sznDefault, focalVT, targetVT);
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

  var PERIOD_MINUTES = league === 'ncaamb' ? 20 : 12;
  var GAME_MINUTES = league === 'ncaamb' ? 40 : 48;
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
  var sznDefault = league === 'ncaamb' ? 33 : 36;

  var focalSustData = sust ? (ctrlIsHome ? sust.away : sust.home) : null;
  var targetSustData = sust ? (ctrlIsHome ? sust.home : sust.away) : null;

  // Volume threat: focal = opponent (trailing), target = control team (leading)
  var focalVT = volumeThreat ? (ctrlIsHome ? volumeThreat.away?.vtBonus : volumeThreat.home?.vtBonus) : 0;
  var targetVT = volumeThreat ? (ctrlIsHome ? volumeThreat.home?.vtBonus : volumeThreat.away?.vtBonus) : 0;

  var core = computeSwingCoreServer(focalStats, targetStats, focalSustData, targetSustData, lead, minsLeft, minsElapsed, gameFraction, sznDefault, focalVT, targetVT);
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
  const W = { I1: 0.10, I2: 0.15, I3: 0.20, I4: 0.30, I5: 0.25 };

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
    var GAME_MINS_VT = league === 'ncaamb' ? 40 : 48;
    var PERIOD_MINS_VT = league === 'ncaamb' ? 20 : 12;
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

function formatSonnetPrompt({ hA, aA, period, clock, score, thesis, sust, leadComp, ind, clutchData, odds, espnWP, wpProfiles, analysisHistory, ctx, quarterDataFromDB, summary, conviction, graduationCtx, priorAlertTrail, floorWP }) {
  let p = `${aA} @ ${hA} | Q${period} ${clock} | ${score}\n\n`;

  // ── GROUND TRUTH (mechanical engine output — do not override) ──
  if (ind) {
    const ctrlHome = ind.controlTeam === hA;
    const i1ctrl = ctrlHome ? ind.I1?.score : (ind.I1?.score != null ? 1 - ind.I1.score : null);
    const i2ctrl = ctrlHome ? ind.I2?.score : (ind.I2?.score != null ? 1 - ind.I2.score : null);
    const i3ctrl = ctrlHome ? ind.I3?.score : (ind.I3?.score != null ? 1 - ind.I3.score : null);
    const i4ctrl = ctrlHome ? ind.I4?.score : (ind.I4?.score != null ? 1 - ind.I4.score : null);
    const i5ctrl = ctrlHome ? ind.I5?.score : (ind.I5?.score != null ? 1 - ind.I5.score : null);
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
    p += `\nBWC LIFECYCLE:\n`;
    p += `BWC team: ${gc.bwcTeam} (fired Q${gc.bwcFirePeriod}, floor ${gc.bwcFireFloor != null ? Number(gc.bwcFireFloor).toFixed(2) : '?'})`;
    if (gc.lane) p += ` | Lane: ${gc.lane} (pregame ML ${gc.pregameML || '?'})`;
    p += `\n`;
    if (gc.cpGraduation) {
      const mfStr = gc.mfTrajectory
        ? `MF ${gc.mfTrajectory.direction} (${gc.mfTrajectory.floors.map(f => f.toFixed(2)).join(' -> ')})`
        : 'No MF data';
      p += `Graduation: ${gc.cpPeakRank}-Rank @ ${gc.cpGraduation.cp_label} | ${mfStr} | MF=${gc.cpMeanFloor?.toFixed(3) || '?'} | ${gc.cpEligibleCount} eligible CPs\n`;
      if (gc.cpOppGraduation) p += `Opponent graduated: ${gc.cpOppGraduation.rank}-Rank @ ${gc.cpOppGraduation.cp_label}\n`;
    } else {
      p += `Pre-graduation (${gc.cpEligibleCount} eligible CPs, MF=${gc.cpMeanFloor?.toFixed(3) || '?'})\n`;
    }
    p += `CP flips: ${gc.cpCtrlFlips} | Game ctrl flips: ${gc.ctrlFlips}\n`;
    if (gc.bwcFlipped) p += `BWC FLIPPED: Originally ${gc.originalBwcTeam}, flipped to ${gc.bwcTeam}\n`;
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

async function fireCalibrationAnalysis(sql, game, league, summary, ind, sust, leadComp, espnWP, odds, matchup, hA, aA, period, clock, trigger) {
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

    // Build graduation context from live_tracking
    let graduationCtx = null;
    try {
      const ltRows = await sql`SELECT live_tracking FROM games WHERE id = ${game.id}`;
      if (ltRows.length > 0 && ltRows[0].live_tracking) {
        const lt = typeof ltRows[0].live_tracking === 'string'
          ? JSON.parse(ltRows[0].live_tracking) : ltRows[0].live_tracking;
        if (lt.bwc_fired) {
          graduationCtx = {
            bwcTeam: lt.bwc_fired.team,
            bwcFirePeriod: lt.bwc_fired.period,
            bwcFireFloor: lt.bwc_fired.floor,
            bwcState: lt.bwc_state || null,
            positionClosed: lt.position_closed || false,
            lane: lt.lane || null,
            pregameML: lt.pregame_ml || null,
            cpPeakRank: lt.cp_peak_rank || null,
            cpGraduation: lt.cp_graduation || null,
            cpOppGraduation: lt.cp_opp_graduation || null,
            cpMeanFloor: lt.cp_mean_floor || null,
            cpEligibleCount: lt.cp_eligible_count || 0,
            cpCtrlFlips: lt.cp_ctrl_flips || 0,
            ctrlFlips: lt.ctrl_flips || 0,
            bwcFlipped: lt.bwc_flipped || false,
            originalBwcTeam: lt.original_bwc_team || null,
            mfTrajectory: computeMFTrajectory(lt.checkpoints || [], lt.bwc_fired.team),
          };
        }
      }
    } catch (e) { /* non-fatal — live_tracking may not exist */ }

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

    const calConviction = computeConviction(ind);

    const userPrompt = formatSonnetPrompt({
      hA, aA, period, clock, score: scoreLine,
      thesis: thesis || null,
      sust, leadComp, ind, clutchData, odds, espnWP, wpProfiles, analysisHistory,
      ctx: clientCtx || {},
      quarterDataFromDB,
      summary,
      conviction: calConviction,
      graduationCtx,
      priorAlertTrail,
      floorWP: ind ? lookupFloorWP(_floorWPCoeffs, ind.controlTeam, ind.score) : null,
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
        model: 'claude-opus-4-6',
        max_tokens: 2500,
        system: SONNET_SYSTEM_PROMPT,
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
    if (calConviction.tier !== 'NO ENTRY' && ind.score >= 0.55) {
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

        // XGB for auto-analysis (computed locally — poll-loop _xgb* vars are out of scope)
        const _caXgbFeatures = extractXGBFeatures(summary, ind, null, period, clock);
        const _caXgbWinProb = _caXgbFeatures ? predictXGB(_caXgbFeatures) : null;
        const _caXgbDivergence = _caXgbWinProb != null ? Math.round((_caXgbWinProb - ind.score) * 1000) / 1000 : null;
        const _caXgbAligned = _caXgbWinProb != null ? Math.abs(_caXgbWinProb - ind.score) < 0.15 : null;
        const _caXgbShap = _caXgbFeatures ? computeXGBContributions(_caXgbFeatures) : null;

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
        const POSITION_TYPES = ['BUY', 'BUY WINDOW CLOSING', 'WINDOW BUY', 'RECOVERY PATH', 'LEAD CRUMBLING', 'LEAD LOST', 'VARIANCE BREAKING', 'STRUCTURAL_SHIFT', 'POSITION_OPEN', 'BWC_EDGE', 'VALUE', 'EXIT', 'THESIS_ALIVE', 'POSITION_RECOVERING', 'POSITION_SAFE'];
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
              VALUES (${game.id}, ${league}, ${'AUTO_ANALYSIS'}, ${period}, ${clock}, ${ind.controlTeam}, ${ind.score}, ${margin}, ${ctrlTrailing}, ${aaEdge}, ${aaML ? parseInt(aaML) : null}, ${odds?.homeSpread ? parseFloat(odds.homeSpread) : null}, ${tpClass}, ${lsClass}, ${ctrlSust}, ${oppSust}, ${clientCtx?.rollingWindow?.score ?? null}, ${'ANALYSIS'}, ${'SUPPRESS'}, ${aaReasoning}, ${ind.I1?.score ?? null}, ${ind.I2?.score ?? null}, ${ind.I3?.score ?? null}, ${ind.I4?.score ?? null}, ${ind.I5?.score ?? null}, ${calConviction.tier}, ${calConviction.combo}, ${false}, ${ind.controlTeam})`;
          } catch (e) { log(`${matchup}: ${triggerTag} position-gate alert save failed: ${e.message}`); }
          log(`${matchup}: ${triggerTag} suppressed — no prior actionable position`);
        } else {
        // Prior position exists — route through agent as position update
        const priorMinutesSince = Math.round((Date.now() - new Date(priorPosition.ts).getTime()) / 60000);

        // Gather agent context (floor history + prior alerts)
        const agentCtx = await gatherAgentContext(sql, game.id, matchup);

        const agentResult = await runAlertAgent({
          alertType: 'AUTO_ANALYSIS', alertTier: 'ANALYSIS',
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
          convictionTier: calConviction.tier, convictionCombo: calConviction.combo,
          convictionPairs: calConviction.pairs?.join(', ') || '',
          i1: (ctrlIsHome ? ind.I1?.score : ind.I1?.score != null ? 1 - ind.I1.score : null)?.toFixed(2),
          i2: (ctrlIsHome ? ind.I2?.score : ind.I2?.score != null ? 1 - ind.I2.score : null)?.toFixed(2),
          i3: (ctrlIsHome ? ind.I3?.score : ind.I3?.score != null ? 1 - ind.I3.score : null)?.toFixed(2),
          i4: (ctrlIsHome ? ind.I4?.score : ind.I4?.score != null ? 1 - ind.I4.score : null)?.toFixed(2),
          i5: (ctrlIsHome ? ind.I5?.score : ind.I5?.score != null ? 1 - ind.I5.score : null)?.toFixed(2),
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
            VALUES (${game.id}, ${league}, ${'AUTO_ANALYSIS'}, ${period}, ${clock}, ${ind.controlTeam}, ${ind.score}, ${margin}, ${ctrlTrailing}, ${aaEdge}, ${aaML ? parseInt(aaML) : null}, ${odds?.homeSpread ? parseFloat(odds.homeSpread) : null}, ${tpClass}, ${lsClass}, ${ctrlSust}, ${oppSust}, ${clientCtx?.rollingWindow?.score ?? null}, ${'ANALYSIS'}, ${aaDecision}, ${aaReasoning}, ${ind.I1?.score ?? null}, ${ind.I2?.score ?? null}, ${ind.I3?.score ?? null}, ${ind.I4?.score ?? null}, ${ind.I5?.score ?? null}, ${calConviction.tier}, ${calConviction.combo}, ${aaNtfySent}, ${ind.controlTeam}, ${_caXgbWinProb != null ? Math.round(_caXgbWinProb * 10000) / 10000 : null}, ${_caXgbAligned})`;
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
            const _alertReadable = {'POSITION_OPEN':'Position Open','BWC_EDGE':'Holding','VALUE':'Entry Value','EXIT':'Exit','THESIS_ALIVE':'Second Chance','POSITION_RECOVERING':'Strengthening','POSITION_SAFE':'Position Safe','BUY':'Buy','BUY WINDOW CLOSING':'Buy Window Closing','WINDOW BUY':'Window Buy','RECOVERY PATH':'Recovery Path','STRUCTURAL_SHIFT':'Structural Shift'}[pp.alert_type] || pp.alert_type;
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
            const _alertReadableW = {'POSITION_OPEN':'Position Open','BWC_EDGE':'Holding','VALUE':'Entry Value','EXIT':'Exit','THESIS_ALIVE':'Second Chance','POSITION_RECOVERING':'Strengthening','POSITION_SAFE':'Position Safe','BUY':'Buy','BUY WINDOW CLOSING':'Buy Window Closing','WINDOW BUY':'Window Buy','RECOVERY PATH':'Recovery Path','STRUCTURAL_SHIFT':'Structural Shift'}[pp.alert_type] || pp.alert_type;
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
      const pbpResult = parseBDLPBPServer(playsResp?.data || [], hA, aA);

      // Build summary
      const summary = buildSummaryFromBDLServer(bdlGame, pbpResult, null);
      const period = summary.quarter || bdlGame.period || 1;
      const clock = summary.clock || '';

      // Compute indicators + sustainability
      const ind = computeServer(summary, pbpResult, _seasonQ4Cache || {});
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
          hA, aA, period, clock, score: result.score,
          thesis: null,
          sust, leadComp, ind, clutchData: null, odds: null,
          espnWP: null, wpProfiles: null, analysisHistory: null,
          ctx, quarterDataFromDB: ctx.quarterDiffs || null, summary,
          conviction: computeConviction(ind),
          floorWP: ind ? lookupFloorWP(_floorWPCoeffs, ind.controlTeam, ind.score) : null,
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
              pbpResult = parseBDLPBPServer(plays, hA, aA);
              pbpSave = {
                home: pbpResult.home, away: pbpResult.away,
                totalShots: pbpResult.totalShots, totalTOs: pbpResult.totalTOs,
                runs: pbpResult.runs, runs6: pbpResult.runs6,
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

  const results = { games: 0, snapshots: 0, espn: 0, odds: 0, errors: [], skipped: null };
  const pendingAnalyses = []; // collect async Sonnet calls so we await them before returning

  for (const league of Object.keys(LEAGUES)) {
    const cfg = LEAGUES[league];
    const apiKey = process.env[cfg.srKeyEnv];
    if (!apiKey) {
      continue;
    }

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

      // ── 0b. Client heartbeat — logged but no longer skips server polling ──
      // BDL has 600 req/min — both client and server can poll simultaneously.
      // Server must always run for quarter-boundary calibration snapshots.

      // ── 1. Get game list — from cache OR one-time SR schedule fetch ──
      let cachedGames = null; // [{id, scheduled, home_alias, away_alias, status}]

      if (pollState && pollState.schedule_json) {
        // Use cached schedule — NO SR call
        cachedGames = typeof pollState.schedule_json === 'string'
          ? JSON.parse(pollState.schedule_json)
          : pollState.schedule_json;
        log(`${league.toUpperCase()}: using cached schedule (${cachedGames.length} games)`);
      } else {
        // First fetch today — single SR schedule call, cache to DB
        log(`${league.toUpperCase()}: fetching schedule (first call today)...`);
        const schedule = await srFetch(league, `games/${d.year}/${pad(d.month)}/${pad(d.day)}/schedule.json`);
        const allGames = schedule.games || [];

        // Build minimal cache: only the fields we need per cycle
        cachedGames = allGames.map(g => ({
          id: g.id,
          scheduled: g.scheduled || null,
          home_alias: g.home?.alias || '',
          away_alias: g.away?.alias || '',
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
        log(`${league.toUpperCase()}: schedule cached — ${cachedGames.length} games, first tip ${firstTip ? new Date(firstTip).toLocaleTimeString('en-US', {timeZone:'America/New_York'}) : '?'} ET`);

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

      // Track which cached games got updated this cycle
      let cacheUpdated = false;
      let liveCount = 0;

      // ── 3c. Batch BDL box_scores + lineups fetch (one call each, covers ALL games) ──
      let bdlBoxScores = [];
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

      // Batch lineups for all games we don't have cached
      const lineupsNeeded = potentiallyLive.filter(g => {
        const bdlGid = bdlGameIds[`${g.away_alias}@${g.home_alias}`];
        return bdlGid && !_serverLineupsCache[bdlGid];
      }).map(g => bdlGameIds[`${g.away_alias}@${g.home_alias}`]);
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

      // ── 4. Process each potentially live game — BDL box_scores + plays ──
      // Fetch plays for all live games in parallel (BDL: 600 req/min)
      const playsFetches = potentiallyLive.map(g => {
        const bdlGid = bdlGameIds[`${g.away_alias}@${g.home_alias}`];
        if (!bdlGid) return Promise.resolve(null);
        return bdlFetch(`${cfg.bdlPrefix}/v1/plays?game_id=${bdlGid}&per_page=500`).catch(() => null);
      });
      const allPlaysResults = await Promise.all(playsFetches);

      // Load season Q4 margins for I4 pre-Q4 prior
      const seasonQ4 = await loadSeasonQ4(sql, league);

      for (let gi = 0; gi < potentiallyLive.length; gi++) {
        const game = potentiallyLive[gi];
        const hA = game.home_alias || 'HOME';
        const aA = game.away_alias || 'AWAY';
        const matchup = `${aA}@${hA}`;
        const bdlGid = bdlGameIds[matchup];

        try {
          if (!bdlGid) {
            log(`${matchup}: no BDL game ID mapped — skipping`);
            continue;
          }

          // Find box score for this game
          const boxScore = bdlBoxScores.find(b => b.id === bdlGid);
          if (!boxScore) {
            log(`${matchup}: no box score — game may not have started`);
            continue;
          }

          // Check game status
          const gameStatus = normalizeBdlStatusServer(boxScore.status, boxScore);
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
              const finalSummary = buildSummaryFromBDLServer(boxScore, pbpResult, lineupsArr);
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
              const homePts = boxScore.home_team_score || 0;
              const awayPts = boxScore.visitor_team_score || 0;
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
          const summary = buildSummaryFromBDLServer(boxScore, pbpResult, lineupsArr);

          // Stash PBP result for computeServerContext to use (avoids re-fetching)
          game._bdlPbp = pbpResult;

          // Compute indicators
          const ind = computeServer(summary, pbpResult, _seasonQ4Cache || {});
          if (!ind) {
            log(`${matchup}: compute returned null (no stats yet?)`);
            continue;
          }
          const conviction = computeConviction(ind);

          const _floorWP = lookupFloorWP(_floorWPCoeffs, ind.controlTeam, ind.score);

          // ── FALLBACK THESIS — catch games where pregame cron missed the window ──
          if (!_thesisAttempted.has(game.id)) {
            pendingAnalyses.push(
              generateFallbackThesis(sql, game, league, ind, conviction, summary, matchup, hA, aA)
                .catch(e => log(`${matchup}: fallback thesis error: ${e.message}`))
            );
          }

          // Fetch ESPN WP (no rate limit, non-blocking)
          let espnWP = null;
          if (espnMap[game.id]) {
            espnWP = await espnWinProb(league, espnMap[game.id]);
          }

          // Determine period + clock from summary
          // SR NBA has summary.quarter, NCAAMB has summary.half
          // Periods may be nested under home/away, not top-level
          const currentPeriod = summary.quarter || summary.half
            || (summary.periods || []).length
            || (summary.home?.periods || []).length
            || 0;
          const clock = summary.clock || '';

          // XGBoost structural win probability
          const _xgbFeatures = extractXGBFeatures(summary, ind, pbpResult, currentPeriod, clock);
          const _xgbWinProb = _xgbFeatures ? predictXGB(_xgbFeatures) : null;
          const _xgbDivergence = _xgbWinProb != null ? Math.round((_xgbWinProb - ind.score) * 1000) / 1000 : null;
          const _xgbAligned = _xgbWinProb != null ? Math.abs(_xgbWinProb - ind.score) < 0.15 : null;

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
            var VT_GAME_MINS = league === 'ncaamb' ? 40 : 48;
            var VT_PERIOD_MINS = league === 'ncaamb' ? 20 : 12;
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

          // Fetch BDL odds (no rate limit, fast)
          let odds = null;
          if (bdlGid) {
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
          // Compute rolling window for snapshot persistence + structural shift warning
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
          // DIAGNOSTIC: log ind shape before INSERT to catch null fields
          log(`${matchup}: SNAP IND — Q${currentPeriod} ${clock} score:${ind.score} team:${ind.controlTeam} I1:${ind.I1?.score} I2:${ind.I2?.score} I3:${ind.I3?.score} I4:${ind.I4?.score} I5:${ind.I5?.score} conv:${conviction.tier}(${conviction.combo}) hPts:${ind.homePts} aPts:${ind.awayPts} tp:${snapTp?.classification||'null'} ls:${snapLs?.classification||'null'}`);
          // Capture raw stats that fed computeServer for audit/debugging
          var rawStatsJson = null;
          try {
            var _hs = summary.home?.statistics || {}, _as = summary.away?.statistics || {};
            rawStatsJson = JSON.stringify({
              home: { stl: _hs.steals||0, oreb: _hs.offensive_rebounds||0, to: _hs.turnovers||_hs.total_turnovers||0, fbp: _hs.fast_break_points||0, pot: _hs.points_off_turnovers||0, scp: _hs.second_chance_points||_hs.second_chance_pts||0, paint: _hs.points_in_the_paint||_hs.points_in_paint||0, atRimM: _hs.field_goals_at_rim_made||0, atRimA: _hs.field_goals_at_rim_att||0, paintM: _hs.points_in_paint_made||0, paintA: _hs.points_in_paint_att||0, fta: _hs.free_throws_att||0, blk: _hs.blocks||0, fd: _hs.fouls_drawn||0, fgm: _hs.field_goals_made||0, fga: _hs.field_goals_att||0, fg3m: _hs.three_points_made||0, fg3a: _hs.three_points_att||0, ast: _hs.assists||0, bigLead: _hs.biggest_lead||0, bench: _hs.bench_points||0, oppp: _hs.offensive_points_per_possession||0, dppp: _hs.defensive_points_per_possession||0, poss: _hs.possessions||0, ftm: _hs.free_throws_made||0, forced_to: pbpResult?.home?.tos?.forced||0, unforced_to: pbpResult?.home?.tos?.unforced||0, assisted_3pm: pbpResult?.home?.threes?.assisted||0 },
              away: { stl: _as.steals||0, oreb: _as.offensive_rebounds||0, to: _as.turnovers||_as.total_turnovers||0, fbp: _as.fast_break_points||0, pot: _as.points_off_turnovers||0, scp: _as.second_chance_points||_as.second_chance_pts||0, paint: _as.points_in_the_paint||_as.points_in_paint||0, atRimM: _as.field_goals_at_rim_made||0, atRimA: _as.field_goals_at_rim_att||0, paintM: _as.points_in_paint_made||0, paintA: _as.points_in_paint_att||0, fta: _as.free_throws_att||0, blk: _as.blocks||0, fd: _as.fouls_drawn||0, fgm: _as.field_goals_made||0, fga: _as.field_goals_att||0, fg3m: _as.three_points_made||0, fg3a: _as.three_points_att||0, ast: _as.assists||0, bigLead: _as.biggest_lead||0, bench: _as.bench_points||0, oppp: _as.offensive_points_per_possession||0, dppp: _as.defensive_points_per_possession||0, poss: _as.possessions||0, ftm: _as.free_throws_made||0, forced_to: pbpResult?.away?.tos?.forced||0, unforced_to: pbpResult?.away?.tos?.unforced||0, assisted_3pm: pbpResult?.away?.threes?.assisted||0 },
              runs6: pbpResult?.runs6 ? { home: pbpResult.runs6.filter(r=>r.team===hA).length, away: pbpResult.runs6.filter(r=>r.team===aA).length, total: pbpResult.runs6.length } : null,
            });
          } catch (e) { /* non-fatal — snapshot still saves without raw stats */ }
          // Read live_tracking for bwc_state + grad_rank (main lt not loaded until V2 section below)
          var _snapLT = null;
          try { const _ltR = await sql`SELECT live_tracking FROM games WHERE id = ${game.id}`; if (_ltR[0]?.live_tracking) _snapLT = typeof _ltR[0].live_tracking === 'string' ? JSON.parse(_ltR[0].live_tracking) : _ltR[0].live_tracking; } catch(e) {}
          await sql`
            INSERT INTO snapshots (game_id, period, clock, home_pts, away_pts,
              floor_score, floor_team, pbp_score, pbp_team, pbp_window_size,
              qtr_score, qtr_team, espn_wp_home, espn_wp_away,
              spread, deficit, trailing_team, lead_sust, gap, accel,
              i1, i2, i3, i4, i5, source, lead_class, sust_json,
              tp_class, tp_exp_swing, tp_remain_poss, ls_class, ls_exp_swing, raw_stats_json,
              bwc_state, grad_rank, floor_wp_historical, reliability_class, window_score,
              xgb_win_prob, xgb_divergence)
            VALUES (${game.id}, ${currentPeriod}, ${clock}, ${ind.homePts}, ${ind.awayPts},
              ${ind.score}, ${ind.controlTeam}, ${null}, ${null}, ${null},
              ${null}, ${null}, ${espnWP?.home || null}, ${espnWP?.away || null},
              ${spreadVal}, ${deficit}, ${trailingTeam}, ${leadSust}, ${null}, ${null},
              ${ind.I1.score}, ${ind.I2.score}, ${ind.I3.score}, ${ind.I4.score}, ${ind.I5.score},
              ${'server'}, ${leadClass}, ${sustJson},
              ${snapTp?.classification || null}, ${snapTp ? Math.round(snapTp.expected.totalSwing * 10) / 10 : null}, ${snapTp?.remainingPoss || null}, ${snapLs?.classification || null}, ${snapLs ? Math.round(snapLs.expected.totalSwing * 10) / 10 : null}, ${rawStatsJson},
              ${_snapLT?.bwc_fired ? (_snapLT._prev_bwc_state || null) : null}, ${_snapLT?.cp_peak_rank || null},
              ${_floorWP.wp}, ${_floorWP.reliabilityClass}, ${_windowScore},
              ${_xgbWinProb != null ? Math.round(_xgbWinProb * 10000) / 10000 : null}, ${_xgbDivergence})
          `;
          log(`${matchup}: snapshot saved — floor:${ind.score} I1-5:${ind.I1?.score},${ind.I2?.score},${ind.I3?.score},${ind.I4?.score},${ind.I5?.score} tp:${snapTp?.classification||'-'} ls:${snapLs?.classification||'-'} xgb:${_xgbWinProb != null ? _xgbWinProb.toFixed(3) : '-'}`);

          // Save odds to odds_history table if we got data
          if (odds) {
            try {
              await sql`
                INSERT INTO odds_history (game_id, home_spread, home_ml, away_ml, total, source)
                VALUES (${game.id}, ${odds.homeSpread != null ? parseFloat(odds.homeSpread) : null}, ${odds.homeML != null ? parseInt(odds.homeML) : null}, ${odds.awayML != null ? parseInt(odds.awayML) : null}, ${odds.total != null ? parseFloat(odds.total) : null}, ${'server'})
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
          log(`${matchup} Q${currentPeriod} ${clock} | ${ind.homePts}-${ind.awayPts} | ${ind.controlTeam} ${ind.score} | I:${ind.I1.score}/${ind.I2.score}/${ind.I3.score}/${ind.I4.score}/${ind.I5.score} | sust:${leadSust || '?'} class:${leadClass || '?'}${bdlEnriched ? ' BDL✓' : ''}${spreadVal != null ? ` spd:${spreadVal}` : ''}${espnWP ? ` | WP:${espnWP.home}%` : ''}`);

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

            lt = updateLiveTracking(lt, ind.controlTeam, ind.score, currentPeriod, clock, hA);

            // Quick ctrl-relative margin for v2 state machine (full margin computed below)
            const _v2CtrlIsHome = ind.controlTeam === hA;
            const _v2CtrlPts = _v2CtrlIsHome ? ind.homePts : ind.awayPts;
            const _v2OppPts = _v2CtrlIsHome ? ind.awayPts : ind.homePts;
            const _v2Margin = _v2CtrlPts - _v2OppPts; // positive = leading

            // ── V2 BWC candidate tracking (3-hold minimum for initial fire) ──
            // Q1 hold accumulation allowed; fire gated on Q2+
            if (!lt.bwc_fired && ind.score >= 0.60 && _v2Margin >= 2) {
              if (lt._bwc_candidate === ind.controlTeam) {
                lt._bwc_candidate_holds = (lt._bwc_candidate_holds || 0) + 1;
              } else {
                lt._bwc_candidate = ind.controlTeam;
                lt._bwc_candidate_holds = 1;
              }
              if (lt._bwc_candidate_holds >= 3 && currentPeriod >= 2) {
                lt.bwc_fired = { team: ind.controlTeam, period: currentPeriod, clock, floor: ind.score };
                lt._prev_bwc_state = _v2Margin >= 3 ? 'LOCK' : 'EDGE';
                lt._just_established = true;

                // Initialize checkpoint index to first future checkpoint (skip past stale ones)
                const cpClockMatchInit = String(clock).match(/(\d+):(\d+)/);
                const cpClockSecInit = cpClockMatchInit
                  ? parseInt(cpClockMatchInit[1]) * 60 + parseInt(cpClockMatchInit[2])
                  : 720;
                const currentGameSecInit = (currentPeriod - 1) * 720 + (720 - cpClockSecInit);
                lt.next_cp_idx = 0;
                while (lt.next_cp_idx < GRAD_CHECKPOINTS.length && GRAD_CHECKPOINTS[lt.next_cp_idx].gameSec <= currentGameSecInit) {
                  lt.next_cp_idx++;
                }

                log(`${matchup}: ★ V2 BWC FIRED — ${ind.controlTeam} floor ${ind.score.toFixed(2)} margin ${_v2Margin} state ${lt._prev_bwc_state} next_cp=${lt.next_cp_idx < GRAD_CHECKPOINTS.length ? GRAD_CHECKPOINTS[lt.next_cp_idx].label : 'DONE'}`);
              }
            } else if (!lt.bwc_fired && ind.controlTeam !== lt._bwc_candidate) {
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
            const alertPeriodMins = league === 'ncaamb' ? 20 : 12;
            const alertClockMins = alertClockParts.length === 2 ? (parseInt(alertClockParts[0]) || 0) + ((parseInt(alertClockParts[1]) || 0) / 60) : alertPeriodMins;
            const alertTotalPeriods = league === 'ncaamb' ? 2 : 4;
            const alertMinsLeft = alertClockMins + (Math.max(0, alertTotalPeriods - currentPeriod) * alertPeriodMins);

            // Ctrl-relative indicator computation (shared by all alert paths)
            const _indNames = ['I1','I2','I3','I4','I5'];
            const _indScores = [ind.I1, ind.I2, ind.I3, ind.I4, ind.I5];
            const _ctrlScoreFn = (s) => s == null ? 0.5 : (ctrlIsHome ? s : 1 - s);
            const _ctrlInd = _indNames.filter((n, i) => _indScores[i] && _ctrlScoreFn(_indScores[i].score) >= 0.55);
            const _oppIndW = _indNames.filter((n, i) => _indScores[i] && _ctrlScoreFn(_indScores[i].score) <= 0.45);
            const _oppI3Won = _oppIndW.length >= 1 && _oppIndW.includes('I3');

            // Lazy-computed server context for alert agent (rolling window, combined read, per-quarter data)
            // Computed on first routeV2Alert call, cached for subsequent calls in same cycle
            let alertCtx = null;

            // ── V2 ALERT ROUTING HELPER ──
            // Assembles context, calls agent with v2 prompt, sends ntfy, writes DB
            async function routeV2Alert(v2Type, v2Tier, v2ExitSev, v2IsBuy) {
              // Map alert type → ntfy title
              const V2_TITLE_MAP = {
                'TRACKING': 'TRACKING',
                'POSITION_OPEN': 'POSITION OPEN',
                'BWC_EDGE': 'HOLDING',
                'VALUE': 'ENTRY VALUE',
                'EXIT': 'EXIT',
                'THESIS_ALIVE': 'SECOND CHANCE',
                'POSITION_RECOVERING': 'STRENGTHENING',
                'POSITION_SAFE': 'POSITION SAFE',
                'BUY': 'BUY',
                'STRUCTURAL_SHIFT': 'STRUCTURAL SHIFT',
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
              const v2Ctx = {
                alertType: v2Type, alertTier: v2Tier,
                ctrlTeam: ind.controlTeam, floor: ind.score.toFixed(2),
                margin: _v2Margin, // signed: positive = leading
                awayAlias: aA, homeAlias: hA,
                awayPts: ind.awayPts, homePts: ind.homePts,
                ctrlIsHome,
                period: currentPeriod, clock,
                bwcTeam,
                i1: _ctrlScoreFn(ind.I1?.score)?.toFixed(2),
                i2: _ctrlScoreFn(ind.I2?.score)?.toFixed(2),
                i3: _ctrlScoreFn(ind.I3?.score)?.toFixed(2),
                i4: _ctrlScoreFn(ind.I4?.score)?.toFixed(2),
                i5: _ctrlScoreFn(ind.I5?.score)?.toFixed(2),
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
                // Graduation context (checkpoint-based for NBA, legacy for NCAAMB)
                poRank: lt.po_fired?.rank || null,
                graduationPeriod: lt.graduation?.[lt.bwc_fired?.team]?.period || null,
                graduationFloor: lt.graduation?.[lt.bwc_fired?.team]?.floor || null,
                graduationRank: lt.graduation?.[lt.bwc_fired?.team]?.rank || null,
                ctrlFlips: lt.ctrl_flips || 0,
                // Checkpoint graduation context (NBA)
                cpMeanFloor: lt.cp_mean_floor || null,
                cpMinFloor: lt.cp_min_floor || null,
                cpEligibleCount: lt.cp_eligible_count || 0,
                cpPeakRank: lt.cp_peak_rank || null,
                cpGraduation: lt.cp_graduation || null,
                cpOppGraduation: lt.cp_opp_graduation || null,
                cpCtrlFlips: lt.cp_ctrl_flips || 0,
                lane: lt.lane || null,
                pregameML: lt.pregame_ml || null,
                mfTrajectory: mfTraj,
                fullCPTrend: fullCPTrend,
                floorMarginSignal: floorMarginSig,
                convictionTrend: convTrend,
                bwcFlipped: lt.bwc_flipped || false,
                positionClosed: lt.position_closed || false,
                originalBwcTeam: lt.original_bwc_team || null,
                // Flip buy context (BUY fires for opponent after EXIT sent on BWC team)
                isFlipBuy: !!(v2IsBuy && lt._flipBuyContext),
                flipBuyContext: lt._flipBuyContext || null,
                // BUY-opened position context
                buyOpenPeriod: lt._buy_open_period || null,
                // Floor reliability
                floorWPHistorical: _floorWP.wp,
                reliabilityClass: _floorWP.reliabilityClass,
                floorGrip: _floorWP.grip,
                // XGBoost structural model
                xgbWinProb: _xgbWinProb != null ? Math.round(_xgbWinProb * 1000) / 1000 : null,
                xgbDivergence: _xgbDivergence,
                xgbAligned: _xgbAligned,
                xgbShap: _xgbFeatures ? computeXGBContributions(_xgbFeatures) : null,
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
                return;
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
                  const buyXgbFloor = currentPeriod >= 4 ? 0.60 : currentPeriod >= 3 ? 0.45 : 0.40;
                  if (_xgbWinProb < buyXgbFloor) {
                    _xgbGateSuppress = true;
                    log(`${matchup}: XGB GATE — suppressing BUY Q${currentPeriod} (xgb=${_xgbWinProb.toFixed(3)}, threshold=${buyXgbFloor}, floor=${ind.score})`);
                  }
                }
                // BWC/WINDOW_BUY: flat XGB < 0.40 (no quarter-specific data yet)
                if ((v2Type === 'BWC' || v2Type === 'WINDOW_BUY') && _xgbWinProb < 0.40) {
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
                return;
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

                // Post-EXIT position gate: close position when EXIT SENT, re-open on any RECOVERING alert SENT
                if (v2Type === 'EXIT') {
                  lt.position_closed = true;
                  lt.position_closed_ts = Date.now();
                  log(`${matchup}: Position CLOSED — EXIT sent, suppressing degrading alerts until recovery`);
                } else if (['THESIS_ALIVE', 'POSITION_OPEN', 'POSITION_RECOVERING', 'POSITION_SAFE'].includes(v2Type)) {
                  lt.position_closed = false;
                  log(`${matchup}: Position RE-OPENED — ${v2Type} sent, position updates resume`);
                } else if (v2IsBuy) {
                  // BUY SEND opens position — activate V2 state machine for exit protection
                  const buyTeam = ind.controlTeam;

                  // Ensure bwc_fired tracks the buy team
                  if (!lt.bwc_fired) {
                    // Cold BUY — no prior BWC tracking
                    lt.bwc_fired = { team: buyTeam, period: currentPeriod, clock, floor: ind.score };
                    // Initialize checkpoint tracking
                    const cpClockMatchBuy = String(clock).match(/(\d+):(\d+)/);
                    const cpClockSecBuy = cpClockMatchBuy ? parseInt(cpClockMatchBuy[1]) * 60 + parseInt(cpClockMatchBuy[2]) : 720;
                    const currentGameSecBuy = (currentPeriod - 1) * 720 + (720 - cpClockSecBuy);
                    lt.next_cp_idx = 0;
                    while (lt.next_cp_idx < GRAD_CHECKPOINTS.length && GRAD_CHECKPOINTS[lt.next_cp_idx].gameSec <= currentGameSecBuy) {
                      lt.next_cp_idx++;
                    }
                    log(`${matchup}: Cold BUY — bwc_fired created for ${buyTeam}, checkpoint tracking initialized`);
                  } else if (lt.bwc_fired.team !== buyTeam) {
                    // BUY on different team — flip BWC tracking
                    lt.original_bwc_team = lt.original_bwc_team || lt.bwc_fired.team;
                    lt.bwc_fired = { team: buyTeam, period: currentPeriod, clock, floor: ind.score };
                    lt.bwc_flipped = true;
                    // Clear stale graduation data from old team
                    lt.checkpoints = [];
                    lt.cp_graduation = null;
                    lt.cp_opp_graduation = null;
                    lt.cp_peak_rank = null;
                    lt.cp_mean_floor = null;
                    lt.cp_min_floor = null;
                    lt.cp_eligible_count = 0;
                    lt.cp_ctrl_flips = 0;
                    // Re-initialize checkpoint index
                    const cpClockMatchFlip = String(clock).match(/(\d+):(\d+)/);
                    const cpClockSecFlip = cpClockMatchFlip ? parseInt(cpClockMatchFlip[1]) * 60 + parseInt(cpClockMatchFlip[2]) : 720;
                    const currentGameSecFlip = (currentPeriod - 1) * 720 + (720 - cpClockSecFlip);
                    lt.next_cp_idx = 0;
                    while (lt.next_cp_idx < GRAD_CHECKPOINTS.length && GRAD_CHECKPOINTS[lt.next_cp_idx].gameSec <= currentGameSecFlip) {
                      lt.next_cp_idx++;
                    }
                    log(`${matchup}: BUY flipped BWC ${lt.original_bwc_team} → ${buyTeam}, stale graduation data cleared`);
                  }

                  // Open or re-open position
                  if (!lt.po_fired || lt.po_fired.team !== buyTeam) {
                    lt.po_fired = { team: buyTeam, rank: 'BUY', period: currentPeriod, clock, flipped: false };
                    lt._prev_bwc_state = computeBwcState(lt, ind.controlTeam, _v2Margin);
                    log(`${matchup}: Position OPENED via BUY — ${buyTeam} (rank: BUY, seeded state: ${lt._prev_bwc_state})`);
                  }
                  lt.position_closed = false;
                  lt._buy_open_period = currentPeriod;
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
                  ${ind.I1?.score ?? null}, ${ind.I2?.score ?? null}, ${ind.I3?.score ?? null},
                  ${ind.I4?.score ?? null}, ${ind.I5?.score ?? null},
                  ${conviction.tier}, ${conviction.combo}, ${shouldSend},
                  ${v2BwcState || lt._prev_bwc_state}, ${v2Type === 'POSITION_OPEN' ? v2Erosion.level : (typeof meanErosion !== 'undefined' && meanErosion ? meanErosion.level || v2Erosion.level : v2Erosion.level)},
                  ${v2Type === 'POSITION_OPEN' ? (v2Erosion.peakFloor ?? null) : ((typeof meanErosion !== 'undefined' && meanErosion ? meanErosion.meanFloor : null) ?? v2Erosion.peakFloor ?? null)}, ${v2ExitSev?.severity ?? null},
                  ${lt.po_fired?.rank || null}, ${mfTraj?.direction || null},
                  ${alertCtx?.combinedRead?.read || null}, ${lt.cp_eligible_count || null},
                  ${lt.cp_ctrl_flips || null}, ${lt.lane || null},
                  ${lt.position_closed || false}, ${!!(v2IsBuy && lt._flipBuyContext)},
                  ${lt.cp_mean_floor || null}, ${v2Type === 'EXIT' ? (lt.bwc_fired?.team || ind.controlTeam) : ind.controlTeam},
                  ${_xgbWinProb != null ? Math.round(_xgbWinProb * 10000) / 10000 : null}, ${_xgbAligned})`;
              } catch (e) { log(`${matchup}: v2 alert save failed: ${e.message}`); }

              // Cleanup lock row — full alert row now exists
              if (_lockRowId) {
                try { await sql`DELETE FROM alerts WHERE id = ${_lockRowId}`; } catch(e) {}
              }

              log(`${matchup}: ${shouldSend ? '★' : '○'} ${v2Type} ${v2Tier} ${agentDecision} — ${ind.controlTeam} ${ind.score.toFixed(2)} ${ctrlTrailing ? 'trailing' : 'leading'} by ${margin}${ctrlEdge != null ? ', edge ' + (ctrlEdge > 0 ? '+' : '') + ctrlEdge + '%' : ''}`);
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
            // NBA: checkpoint-based graduation system
            // NCAAMB: retains original 60s-poll graduation
            if (lt.bwc_fired && league === 'nba') {
              // ── CHECKPOINT CAPTURE (3-min boundaries, NBA only) ──
              if (!lt.checkpoints) lt.checkpoints = [];
              if (lt.next_cp_idx == null) lt.next_cp_idx = 0;

              // Convert current game time to gameSec
              const cpClockMatch = String(clock).match(/(\d+):(\d+)/);
              const cpClockSec = cpClockMatch
                ? parseInt(cpClockMatch[1]) * 60 + parseInt(cpClockMatch[2])
                : 720;
              const currentGameSec = (currentPeriod - 1) * 720 + (720 - cpClockSec);

              // Check if we've crossed the next checkpoint boundary
              if (lt.next_cp_idx < GRAD_CHECKPOINTS.length) {
                const _dbgNextCp = GRAD_CHECKPOINTS[lt.next_cp_idx];
                log(`${matchup}: CP_DEBUG Q${currentPeriod} ${clock} gameSec=${currentGameSec} next_cp_idx=${lt.next_cp_idx} nextCp=${_dbgNextCp.label}@${_dbgNextCp.gameSec} gap=${currentGameSec - _dbgNextCp.gameSec} cps=${(lt.checkpoints||[]).length}`);
              }
              while (lt.next_cp_idx < GRAD_CHECKPOINTS.length) {
                const nextCp = GRAD_CHECKPOINTS[lt.next_cp_idx];
                if (currentGameSec < nextCp.gameSec) break; // haven't reached it yet

                // ── Capture this checkpoint ──
                const bwcTeam = lt.bwc_fired.team;
                const cpConv = computeConviction(ind);
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

                // ── XGB + SHAP at checkpoint ──
                if (_xgbFeatures && _xgbWinProb != null) {
                  cpEntry.xgb = Math.round(_xgbWinProb * 1000) / 1000;
                  cpEntry.shap = computeXGBContributions(_xgbFeatures);
                }

                // ── Checkpoint-level control flip detection ──
                if (lt.checkpoints.length > 0) {
                  const prevCp = lt.checkpoints[lt.checkpoints.length - 1];
                  if (prevCp.team !== cpEntry.team) {
                    lt.cp_ctrl_flips = (lt.cp_ctrl_flips || 0) + 1;
                  }
                }

                lt.checkpoints.push(cpEntry);
                log(`${matchup}: CP_CAPTURED ${nextCp.label} Q${currentPeriod} ${clock} floor=${ind.score} xgb=${cpEntry.xgb || 'n/a'} total=${lt.checkpoints.length}`);

                // ── Update checkpoint-level holds ──
                if (ind.controlTeam === bwcTeam) {
                  lt.cp_holds = (lt.cp_holds || 0) + 1;
                  lt.cp_opp_holds = 0; // reset opponent counter
                } else {
                  lt.cp_holds = 0; // reset BWC team counter
                  if (cpMargin >= 2 && ind.score >= 0.60) {
                    lt.cp_opp_holds = (lt.cp_opp_holds || 0) + 1;
                  } else {
                    lt.cp_opp_holds = 0;
                  }
                }

                // ── Classify rank at this checkpoint (BWC team only) ──
                if (ind.controlTeam === bwcTeam && cpMargin >= 2 && ind.score >= 0.60) {
                  const cpRank = classifyRank(cpConv.tier, cpMargin, lt.cp_holds, cpOppCount);

                  const prevPeak = lt.cp_peak_rank || 'C';
                  const CP_RANK_ORDER = { C: 0, B: 1, A: 2 };
                  if (CP_RANK_ORDER[cpRank] > CP_RANK_ORDER[prevPeak]) {
                    lt.cp_peak_rank = cpRank;
                    lt.cp_graduation = {
                      rank: cpRank, cp_label: nextCp.label, cp_idx: lt.next_cp_idx,
                      floor: ind.score, margin: cpMargin,
                      period: currentPeriod, clock: clock,
                    };
                    log(`${matchup}: ▲ CP GRADUATION ${bwcTeam} ${prevPeak}→${cpRank} @ ${nextCp.label}`);
                  }
                }

                // ── Opponent rank classification ──
                if (ind.controlTeam !== bwcTeam && lt.cp_opp_holds >= 2 && cpMargin >= 2 && ind.score >= 0.60) {
                  const oppRank = classifyRank(cpConv.tier, cpMargin, lt.cp_opp_holds, cpOppCount);

                  if (oppRank === 'B' || oppRank === 'A') {
                    const prevOppRank = lt.cp_opp_graduation?.rank || 'C';
                    const CP_RANK_ORDER = { C: 0, B: 1, A: 2 };
                    if (CP_RANK_ORDER[oppRank] > (CP_RANK_ORDER[prevOppRank] || 0)) {
                      lt.cp_opp_graduation = {
                        rank: oppRank, cp_label: nextCp.label, cp_idx: lt.next_cp_idx,
                        floor: ind.score, margin: cpMargin,
                      };
                      log(`${matchup}: ⚠ CP OPP GRADUATION ${ind.controlTeam} → ${oppRank}-Rank @ ${nextCp.label}`);
                    }
                  }
                }

                // ── Compute running mean floor / min floor ──
                const bwcTeamForStats = lt.bwc_fired.team;
                const cpFloorStats = computeCheckpointFloorStats(lt.checkpoints, bwcTeamForStats);
                lt.cp_mean_floor = cpFloorStats.meanFloor;
                lt.cp_min_floor = cpFloorStats.minFloor;
                lt.cp_eligible_count = cpFloorStats.eligibleCount;

                // ── POSITION OPEN EVALUATION (checkpoint-gated) ──
                if (lt.cp_graduation && (!lt.po_fired || lt.po_fired.rank === 'BUY') && ind.controlTeam === bwcTeam) {
                  const gRank = lt.cp_graduation.rank;
                  const gates = getLaneGates(lt.lane || 'tossup');

                  let poShouldFire = false;
                  let poBlockReason = null;

                  // A-Rank: fires at any checkpoint meeting MF/minF gates
                  if (gRank === 'A') {
                    if (lt.cp_mean_floor >= gates.mfGate && lt.cp_min_floor >= gates.minFGate) {
                      poShouldFire = true;
                    } else {
                      poBlockReason = `MF ${lt.cp_mean_floor?.toFixed(3)} < ${gates.mfGate} or minF ${lt.cp_min_floor?.toFixed(2)} < ${gates.minFGate}`;
                    }
                  }

                  // B-Rank: requires Q3_6+ AND MF/minF gates
                  if (gRank === 'B') {
                    const bCpClockSec = cpClockMatch ? parseInt(cpClockMatch[1]) * 60 + parseInt(cpClockMatch[2]) : 720;
                    const pastQ3_6 = currentPeriod > 3 || (currentPeriod === 3 && bCpClockSec <= 360);
                    if (pastQ3_6 && lt.cp_mean_floor >= gates.mfGate && lt.cp_min_floor >= gates.minFGate) {
                      poShouldFire = true;
                    } else if (!pastQ3_6) {
                      poBlockReason = `B-Rank requires Q3_6+ (currently Q${currentPeriod} ${clock})`;
                    } else {
                      poBlockReason = `MF ${lt.cp_mean_floor?.toFixed(3)} < ${gates.mfGate} or minF ${lt.cp_min_floor?.toFixed(2)} < ${gates.minFGate}`;
                    }
                  }

                  // C-Rank: never fires PO
                  if (gRank === 'C') {
                    poBlockReason = 'C-Rank — no PO';
                  }

                  // Fire PO — S-rank is post-hoc only (backtest: S-at-fire 72% vs true W2W 85.6%)
                  if (poShouldFire && alertMinsLeft >= 1.0) {
                    const poRank = gRank; // A or B only at fire time, never S

                    lt.po_fired = {
                      team: bwcTeam, rank: poRank,
                      period: currentPeriod, clock: clock,
                      mean_floor: lt.cp_mean_floor,
                      min_floor: lt.cp_min_floor,
                      lane: lt.lane,
                      checkpoint_count: lt.cp_eligible_count,
                    };

                    await routeV2Alert('POSITION_OPEN', 'FIRED', null, false);
                    log(`${matchup}: ★ POSITION OPEN — ${bwcTeam} ${poRank}-Rank @ ${nextCp.label} | MF=${lt.cp_mean_floor?.toFixed(3)} minF=${lt.cp_min_floor?.toFixed(2)} lane=${lt.lane} cpFlips=${lt.cp_ctrl_flips || 0}`);
                  } else if (poBlockReason) {
                    log(`${matchup}: PO blocked — ${gRank}-Rank but ${poBlockReason}`);
                  }
                }

                // ── LATEST-TO-GRADUATE FLIP ──
                const oppTeam = ind.controlTeam !== bwcTeam ? ind.controlTeam : null;
                if (oppTeam && lt.cp_opp_graduation
                    && (lt.cp_opp_graduation.rank === 'B' || lt.cp_opp_graduation.rank === 'A')
                    && lt.cp_opp_holds >= 2
                    && (!lt.po_fired || lt.po_fired.team !== oppTeam)
                    && alertMinsLeft >= 1.0) {

                  // Check "more recent" — opponent graduated after BWC team (or BWC never graduated)
                  const bwcGradIdx = lt.cp_graduation?.cp_idx ?? -1; // -1 if never graduated
                  const oppGradIdx = lt.cp_opp_graduation.cp_idx;
                  const oppIsMoreRecent = oppGradIdx > bwcGradIdx;

                  if (oppIsMoreRecent) {
                    // Compute opponent's MF from their eligible checkpoints
                    const oppEligible = lt.checkpoints.filter(cp =>
                      cp.team === oppTeam && cp.floor >= 0.60 && cp.margin >= 2
                    );
                    const oppMF = oppEligible.length > 0
                      ? Math.round((oppEligible.reduce((s, cp) => s + cp.floor, 0) / oppEligible.length) * 1000) / 1000
                      : null;

                    if (oppMF != null && oppMF >= 0.55) {
                      // Record original BWC team before flipping
                      if (!lt.original_bwc_team) lt.original_bwc_team = lt.bwc_fired.team;
                      lt.bwc_flipped = true;
                      lt.bwc_fired.team = oppTeam;
                      lt.position_closed = false; // old team's EXIT doesn't contaminate new team

                      const oppFlipRank = lt.cp_opp_graduation.rank;
                      const hadPriorPO = lt.po_fired && lt.po_fired.team !== oppTeam;

                      lt.po_fired = {
                        team: oppTeam, rank: oppFlipRank,
                        period: currentPeriod, clock: clock,
                        mean_floor: oppMF,
                        min_floor: null,
                        lane: lt.lane,
                        checkpoint_count: oppEligible.length,
                        flipped: true,
                        original_bwc_team: lt.original_bwc_team,
                      };

                      // Swap graduation fields — new BWC team's graduation becomes primary
                      const _oldCpGrad = lt.cp_graduation;
                      lt.cp_graduation = lt.cp_opp_graduation;
                      lt.cp_opp_graduation = _oldCpGrad;
                      lt.cp_peak_rank = lt.cp_graduation?.rank || null;
                      lt.cp_mean_floor = oppMF;
                      lt.cp_eligible_count = oppEligible.length;
                      lt.cp_min_floor = oppEligible.length > 0
                        ? Math.round(Math.min(...oppEligible.map(cp => cp.floor)) * 1000) / 1000
                        : null;

                      // Reset _prev_bwc_state to prevent spurious transition alert after flip
                      lt._prev_bwc_state = computeBwcState(lt, ind.controlTeam, _v2Margin);

                      await routeV2Alert('POSITION_OPEN', 'FIRED', null, false);
                      // Recompute v2BwcState — bwc_fired.team just changed, stale value would
                      // cause spurious EXIT in the transition check below
                      v2BwcState = computeBwcState(lt, ind.controlTeam, _v2Margin);
                      log(`${matchup}: ★ FLIP PO — ${oppTeam} ${oppFlipRank}-Rank (${hadPriorPO ? 'supersedes prior PO on' : 'flipped from'} ${lt.original_bwc_team}) | oppMF=${oppMF.toFixed(3)} | ${oppEligible.length} opp CPs`);
                    }
                  }
                }

                lt.next_cp_idx++;
                log(`${matchup}: CP ${nextCp.label} captured — team=${cpEntry.team} floor=${cpEntry.floor.toFixed(2)} margin=${cpEntry.margin} conv=${cpEntry.conv} holds=${lt.cp_holds} MF=${lt.cp_mean_floor?.toFixed(3) || '?'} cpFlips=${lt.cp_ctrl_flips || 0}`);
              }
            } else if (lt.bwc_fired && !lt.po_fired && league === 'ncaamb') {
              // ── NCAAMB: retain existing 60s-poll graduation logic (unchanged) ──
              if (!lt.graduation) lt.graduation = {};
              const bwcTeam = lt.bwc_fired.team;
              if (!lt.graduation[bwcTeam]) lt.graduation[bwcTeam] = { rank: 'C' };

              if (ind.controlTeam === bwcTeam) {
                const gradConviction = computeConviction(ind);
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

                  lt.po_fired = {
                    team: bwcTeam, rank: poRank,
                    period: currentPeriod, clock
                  };
                  await routeV2Alert('POSITION_OPEN', 'FIRED', null, false);
                  log(`${matchup}: ★ POSITION OPEN — ${bwcTeam} ${poRank}-Rank Q${currentPeriod} ${clock}`);
                }
              }

              // NCAAMB opponent graduation tracking
              if (ind.controlTeam !== bwcTeam) {
                const oppTeam = ind.controlTeam;
                if (_v2Margin >= 2 && ind.score >= 0.60 && currentPeriod >= 2) {
                  lt.opp_bwc_holds = (lt.opp_bwc_holds || 0) + 1;
                  if (lt.opp_bwc_holds >= 3) {
                    const oppConv = computeConviction(ind);
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
                  else if (v2BwcState === 'EXIT') v2AlertType = 'EXIT';
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
                    // Exit severity for EXIT alerts
                    var _v2ExitSev = null;
                    if (v2BwcState === 'EXIT') {
                      const _oppInd = _indNames.filter((n, i) => _indScores[i] && _ctrlScoreFn(_indScores[i].score) >= 0.55);
                      _v2ExitSev = computeExitSeverity(_oppInd, _oppInd.length, ind.score, lt.ctrl_team_holds || 0);
                    }

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

            // ── V2 BUY TRIGGERS ──
            if (currentPeriod >= 2 && ind.score >= 0.55 && ctrlTrailing && margin >= 1 && margin <= 15
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
                    const buyTag = isColdBuy ? ' [COLD]' : isWarmPreGrad ? ' [PRE-GRAD]' : '';
                    log(`${matchup}: ▶ V2 BUY ${buyTier}${lt._flipBuyContext ? ' [FLIP]' : ''}${buyTag} floor=${ind.score.toFixed(2)} trail=${margin} bwcMatch=${lt.bwc_fired?.team === ind.controlTeam} ctrl=${_ctrlInd.join('+')||'none'}(${_ctrlInd.length}/5) opp=${_oppIndW.join('+')||'none'} sust=${ctrlSust}/${oppSustTier} tp=${tpForBuy?.classification||'-'} ml=${ctrlML||'-'} conv=${conviction.tier}`);

                    await routeV2Alert('BUY', buyTier, null, true);
                    lt._last_buy_ts = _v2Now;
                  }
                }
              }
            } else if (ind.score >= 0.65 && ctrlTrailing && margin >= 1 && margin <= 15 && currentPeriod >= 2 && alertMinsLeft < 1.0) {
              log(`${matchup}: BUY suppressed — ${alertMinsLeft.toFixed(1)} min left (< 1 min clock gate)`);
            }

            // ── V2 STATE LOGGING ──
            if (lt.bwc_fired) {
              if (v2BwcState && !lt._v2_transition_pending) lt._prev_bwc_state = v2BwcState;
              try {
                log(`${matchup}: v2 state=${v2BwcState || '-'} erosion=${v2Erosion?.level || '-'}(peak)/${typeof meanErosion !== 'undefined' && meanErosion ? meanErosion.level || '-' : '-'}(mean) peak=${v2Erosion?.peakFloor?.toFixed(2) || '-'} mf=${typeof meanErosion !== 'undefined' && meanErosion ? meanErosion.meanFloor?.toFixed(3) || '-' : '-'} holds=${lt.ctrl_team_holds || 0} bwcTeam=${lt.bwc_fired.team}${lt._v2_transition_pending ? ' PENDING(prev=' + lt._prev_bwc_state + ')' : ''}`);
              } catch(e) { log(`${matchup}: v2 state=${v2BwcState || '-'} (log error: ${e.message})`); }
            }
          }

          // ── STRUCTURAL SHIFT WARNING ──
          // Pre-flip early warning: trailing team gaining structural control before floor flips
          if (currentPeriod >= 3 && ind.controlTeam && _windowResult?.available) {
            const _ssCtrlIsHome = ind.controlTeam === hA;
            const _ssOppInds = ['I1','I2','I3','I4','I5'].filter(k => {
              const s = ind[k]?.score;
              return s != null && (_ssCtrlIsHome ? s >= 0.55 : s <= 0.45);
            });
            const _ssFloorSide = _ssCtrlIsHome ? 'home' : 'away';
            const _ssPeakFloor = lt[_ssFloorSide + '_peak_floor'] || ind.score;
            const _ssFloorDecline = _ssPeakFloor - ind.score;
            const _ssCtrlPts = _ssCtrlIsHome ? ind.homePts : ind.awayPts;
            const _ssOppPts = _ssCtrlIsHome ? ind.awayPts : ind.homePts;
            const _ssMargin = _ssCtrlPts - _ssOppPts; // positive = ctrl leading
            const _ssCtrlStats = _ssCtrlIsHome ? (summary.home?.statistics || {}) : (summary.away?.statistics || {});
            const _ssPeakMargin = _ssCtrlStats.biggest_lead || _ssMargin;
            const _ssCompression = _ssPeakMargin - _ssMargin;
            // Opponent's window strength (how strong is the trailing team in the recent window?)
            const _ssOppWindow = _windowResult.score != null
              ? (_windowResult.controlTeam === _ssTrailingTeam ? _windowResult.score : 1 - _windowResult.score)
              : null;
            // Trailing team name
            const _ssTrailingTeam = _ssCtrlIsHome ? aA : hA;

            // GATES: floor decline >= 0.15 + opp 1+ indicators + compression >= 3 + opp window >= 0.65
            const _ssGates = _ssFloorDecline >= 0.15
              && _ssOppInds.length >= 1
              && _ssCompression >= 3
              && _ssOppWindow != null && _ssOppWindow >= 0.65
              && _ssMargin >= 0;  // ctrl team still leading (pre-flip, not post-flip)

            // Dedup: once per game per trailing team
            const _ssKey = `shift_${_ssTrailingTeam}`;
            const _ssFired = lt._shift_warnings || {};

            if (_ssGates && !_ssFired[_ssKey]) {
              log(`${matchup}: ★ STRUCTURAL SHIFT WARNING — ${_ssTrailingTeam} gaining control. FlDec=${_ssFloorDecline.toFixed(2)} comp=${_ssCompression} oppInds=${_ssOppInds.join('+')} oppWin=${_ssOppWindow?.toFixed(2)} mg=${_ssMargin}`);
              lt._shift_warnings = { ..._ssFired, [_ssKey]: true };

              // Route through agent — use the same routeV2Alert mechanism
              // Need to temporarily set up context for routeV2Alert
              const _ssAgentCtx = await gatherAgentContext(sql, game.id, matchup);
              const _ssV2Ctx = {
                alertType: 'STRUCTURAL_SHIFT', alertTier: 'FIRED',
                ctrlTeam: ind.controlTeam, ctrlIsHome: _ssCtrlIsHome,
                floor: ind.score?.toFixed(2), margin: _ssMargin,
                bwcTeam: lt.bwc_fired?.team || null,
                bwcFirePeriod: lt.bwc_fired?.period || null,
                homeAlias: hA, awayAlias: aA, homePts: ind.homePts, awayPts: ind.awayPts,
                period: currentPeriod, clock,
                ctrlSust: sust?.[_ssCtrlIsHome ? 'home' : 'away']?.tier || null,
                oppSust: sust?.[_ssCtrlIsHome ? 'away' : 'home']?.tier || null,
                windowScore: _windowScore,
                rollingWindow: _windowResult,
                i1: (_ssCtrlIsHome ? ind.I1?.score : (1 - (ind.I1?.score || 0.5)))?.toFixed(2),
                i2: (_ssCtrlIsHome ? ind.I2?.score : (1 - (ind.I2?.score || 0.5)))?.toFixed(2),
                i3: (_ssCtrlIsHome ? ind.I3?.score : (1 - (ind.I3?.score || 0.5)))?.toFixed(2),
                i4: (_ssCtrlIsHome ? ind.I4?.score : (1 - (ind.I4?.score || 0.5)))?.toFixed(2),
                i5: (_ssCtrlIsHome ? ind.I5?.score : (1 - (ind.I5?.score || 0.5)))?.toFixed(2),
                convictionTier: conviction?.tier || null, convictionCombo: conviction?.combo || null,
                oppIndicatorsWon: _ssOppInds.join('+'), oppIndicatorCount: _ssOppInds.length,
                combinedRead: null,
                erosionLevel: null, peakFloor: _ssPeakFloor,
                floorWPHistorical: _floorWP.wp, reliabilityClass: _floorWP.reliabilityClass, floorGrip: _floorWP.grip,
                priorAlertTrail: _ssAgentCtx?.priorAlerts || null,
                shiftTrailingTeam: _ssTrailingTeam,
                shiftFloorDecline: _ssFloorDecline.toFixed(2),
                shiftCompression: _ssCompression,
                shiftOppWindow: _ssOppWindow?.toFixed(2),
                shiftOppInds: _ssOppInds.join('+'),
              };

              const _ssPrompt = buildV2AgentPrompt(_ssV2Ctx);
              try {
                const _ssAgentResp = await fetch('https://api.anthropic.com/v1/messages', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
                  body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 600, messages: [{ role: 'user', content: _ssPrompt }] }),
                });
                const _ssAgentData = await _ssAgentResp.json();
                const _ssAgentText = _ssAgentData.content?.[0]?.text || '';
                const _ssDecision = _ssAgentText.match(/DECISION:\s*(SEND|SUPPRESS|DOWNGRADE)/)?.[1] || 'SEND';
                const _ssBody = _ssAgentText.match(/BODY:\s*([\s\S]*?)(?:\n(?:DECISION|REASONING):|$)/)?.[1]?.trim() || '';
                const _ssReasoning = _ssAgentText.match(/REASONING:\s*([\s\S]*?)(?:\n(?:DECISION|BODY):|$)/)?.[1]?.trim() || '';

                // Save alert
                const _ssWinScore = _windowScore;
                await sql`INSERT INTO alerts (game_id, league, alert_type, period, clock, control_team, floor_score, margin, is_trailing, edge, ml, spread, tp_class, ls_class, ctrl_sust, opp_sust, window_score, alert_tier, agent_decision, agent_reasoning, i1, i2, i3, i4, i5, conviction_tier, conviction_combo, ntfy_sent, position_team)
                  VALUES (${game.id}, ${league}, ${'STRUCTURAL_SHIFT'}, ${currentPeriod}, ${clock}, ${ind.controlTeam}, ${ind.score}, ${_ssMargin}, ${false}, ${null}, ${null}, ${spreadVal}, ${snapTp?.classification || null}, ${snapLs?.classification || null}, ${_ssV2Ctx.ctrlSust}, ${_ssV2Ctx.oppSust}, ${_ssWinScore}, ${'FIRED'}, ${_ssDecision}, ${_ssReasoning || _ssBody}, ${ind.I1?.score}, ${ind.I2?.score}, ${ind.I3?.score}, ${ind.I4?.score}, ${ind.I5?.score}, ${conviction?.tier || null}, ${conviction?.combo || null}, ${_ssDecision === 'SEND'}, ${_ssTrailingTeam})`;

                if (_ssDecision === 'SEND') {
                  const _ssNtfyTitle = `STRUCTURAL SHIFT — ${matchup}`;
                  let _ssNtfyBody = `${aA} ${ind.awayPts}-${ind.homePts} ${hA} · Q${currentPeriod} ${clock}\n`;
                  _ssNtfyBody += _ssBody || `${_ssTrailingTeam} recovering structural control. ${ind.controlTeam}'s edge weakening — floor declined ${_ssPeakFloor.toFixed(2)}→${ind.score.toFixed(2)}, lead compressed ${_ssPeakMargin}→${_ssMargin}. ${_ssTrailingTeam} winning ${_ssOppInds.join('+')} in recent window (${_ssOppWindow?.toFixed(2)}).`;
                  await sendNtfy(_ssNtfyTitle, _ssNtfyBody, 'default');
                  log(`${matchup}: STRUCTURAL SHIFT → ${_ssDecision} (ntfy sent)`);
                } else {
                  log(`${matchup}: STRUCTURAL SHIFT → ${_ssDecision}: ${_ssReasoning?.substring(0, 150)}`);
                }
              } catch (e) {
                log(`${matchup}: STRUCTURAL SHIFT agent error: ${e.message}`);
                // Still save the alert without agent
                await sql`INSERT INTO alerts (game_id, league, alert_type, period, clock, control_team, floor_score, margin, is_trailing, edge, ml, spread, window_score, alert_tier, agent_decision, agent_reasoning, i1, i2, i3, i4, i5, ntfy_sent, position_team)
                  VALUES (${game.id}, ${league}, ${'STRUCTURAL_SHIFT'}, ${currentPeriod}, ${clock}, ${ind.controlTeam}, ${ind.score}, ${_ssMargin}, ${false}, ${null}, ${null}, ${spreadVal}, ${_windowScore}, ${'FIRED'}, ${'SEND'}, ${'Agent unavailable — auto-SEND'}, ${ind.I1?.score}, ${ind.I2?.score}, ${ind.I3?.score}, ${ind.I4?.score}, ${ind.I5?.score}, ${true}, ${_ssTrailingTeam})`;
                const _ssFallbackBody = `${aA} ${ind.awayPts}-${ind.homePts} ${hA} · Q${currentPeriod} ${clock}\n${_ssTrailingTeam} recovering structural control. Floor declined ${_ssPeakFloor.toFixed(2)}→${ind.score.toFixed(2)}, lead compressed ${_ssPeakMargin}→${_ssMargin}. ${_ssTrailingTeam} winning ${_ssOppInds.join('+')} in recent window.`;
                await sendNtfy(`STRUCTURAL SHIFT — ${matchup}`, _ssFallbackBody, 'default');
              }
            }
          }

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

            for (const t of transitions) {
              // DB-based dedup — check if calibration snapshot already exists for this game+tag
              // In-memory cal_captured doesn't persist across serverless invocations
              try {
                const existing = await sql`
                  SELECT 1 FROM snapshots WHERE game_id = ${game.id} AND source = ${t.tag} LIMIT 1
                `;
                if (existing.length > 0) continue; // already captured in a prior invocation
              } catch (e) { /* table may not exist yet, proceed */ }

              // Period-based transitions: standard detection
              const triggered = t.clockBased
                ? true  // clock-based: already validated above
                : (currentPeriod >= t.to);

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
                      tp_class, tp_exp_swing, tp_remain_poss, ls_class, ls_exp_swing, raw_stats_json,
                      bwc_state, grad_rank, floor_wp_historical, reliability_class, window_score,
                      xgb_win_prob, xgb_divergence)
                    VALUES (${game.id}, ${currentPeriod}, ${clock}, ${ind.homePts}, ${ind.awayPts},
                      ${ind.score}, ${ind.controlTeam}, ${espnWP?.home || null}, ${espnWP?.away || null},
                      ${spreadVal}, ${deficit}, ${trailingTeam}, ${leadSust}, ${leadClass},
                      ${ind.I1.score}, ${ind.I2.score}, ${ind.I3.score}, ${ind.I4.score}, ${ind.I5.score},
                      ${t.tag}, ${sustJson},
                      ${snapTp?.classification || null}, ${snapTp ? Math.round(snapTp.expected.totalSwing * 10) / 10 : null}, ${snapTp?.remainingPoss || null}, ${snapLs?.classification || null}, ${snapLs ? Math.round(snapLs.expected.totalSwing * 10) / 10 : null}, ${rawStatsJson},
                      ${lt?.bwc_fired ? (lt._prev_bwc_state || null) : null}, ${lt?.cp_peak_rank || null},
                      ${_floorWP.wp}, ${_floorWP.reliabilityClass}, ${_windowScore},
                      ${_xgbWinProb != null ? Math.round(_xgbWinProb * 1000) / 1000 : null}, ${_xgbDivergence})
                  `;
                  log(`${matchup}: ${t.label} CAL snapshot saved — floor ${ind.controlTeam} ${ind.score} | sust:${leadSust || '?'} class:${leadClass || '?'} | WP:${espnWP?.home || '?'}% | spd:${spreadVal != null ? spreadVal : 'N/A'}`);
                } catch (e) {
                  log(`${matchup}: ${t.label} CAL snapshot save failed: ${e.message}`);
                }

                // ── QUARTER DATA: capture boundary stats + compute diffs ──
                if (t.qdKey) {
                  try {
                    const qd = await readQuarterData(sql, game.id);
                    const homeStats = summary.home?.statistics || {};
                    const awayStats = summary.away?.statistics || {};
                    captureBoundary(qd, t.qdKey, t.qdPrev, homeStats, awayStats);
                    await writeQuarterData(sql, game.id, qd);
                    const diffKeys = qd.diffs[t.qdKey] ? Object.keys(qd.diffs[t.qdKey].home || {}).length : 0;
                    log(`${matchup}: ${t.label} quarter_data boundary[${t.qdKey}] captured (diff from [${t.qdPrev}]: ${diffKeys} fields)`);
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
                    fireCalibrationAnalysis(sql, game, league, summary, ind, sust, leadComp, espnWP, odds, matchup, hA, aA, currentPeriod, clock, t.trigger)
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

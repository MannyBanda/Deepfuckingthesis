// MC Replay: Simulate what MC would have said during DET@ORL G6 (May 1)
// Uses the actual MC functions from poll-live-bdl.mjs against stored snapshot data

import https from 'https';

const AUTH = 'Basic ' + Buffer.from('manny:DFT2025!').toString('base64');
const BASE = 'https://poetic-starlight-aa8938.netlify.app/.netlify/functions/db-api';

const GAMES = [
  { id: '74d28f20-c249-499c-9d90-0b04800670ca', label: 'Game 3 — SAS@POR Apr 24', home: 'POR', away: 'SAS', finalHome: 108, finalAway: 120, winner: 'SAS' },
  { id: '2284ca46-65f3-4a46-82bc-82f99150eaab', label: 'Game 4 — SAS@POR Apr 26', home: 'POR', away: 'SAS', finalHome: 93, finalAway: 114, winner: 'SAS' },
];

// ── MC FUNCTIONS (copied from poll-live-bdl.mjs) ──

function simulatePossessionMC(rates) {
  if (Math.random() < rates.toRate) return 0;
  if (Math.random() < rates.fg3aShare) {
    if (Math.random() < rates.fg3Pct) return 3;
  } else {
    if (Math.random() < rates.fg2Pct) return 2;
  }
  // Miss — check OREB
  if (Math.random() < rates.orebRate) {
    if (Math.random() < rates.fg2Pct) return 2;
    return 0;
  }
  // Dead ball — FT chance
  if (Math.random() < rates.ftaRate * 0.3) {
    var pts = 0;
    if (Math.random() < rates.ftPct) pts++;
    if (Math.random() < rates.ftPct) pts++;
    return pts;
  }
  return 0;
}

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

function classifyMCVerdict(mcWinProb) {
  if (mcWinProb <= 0.25) return 'CONF';
  if (mcWinProb <= 0.40) return 'LIKELY';
  if (mcWinProb <= 0.60) return 'CONT';
  return 'NORM';
}

function classifyMCPattern(verdicts) {
  if (!verdicts || verdicts.length < 3) return null;
  var meaningful = verdicts.filter(v => v !== 'INV');
  if (meaningful.length < 2) return null;
  var hitConfLikely = meaningful.some(v => v === 'CONF' || v === 'LIKELY');
  var hitNorm = meaningful.some(v => v === 'NORM');
  if (!hitConfLikely) {
    if (meaningful.length >= 3) return 'FALSE_ALARM';
    return null;
  }
  if (!hitNorm) return 'CLEAN';
  var lastConf = -1, lastNorm = -1;
  for (var i = meaningful.length - 1; i >= 0; i--) {
    if (lastConf === -1 && (meaningful[i] === 'CONF' || meaningful[i] === 'LIKELY')) lastConf = i;
    if (lastNorm === -1 && meaningful[i] === 'NORM') lastNorm = i;
  }
  if (lastConf > lastNorm) return 'WAVE';
  return 'NORMALIZED';
}

function estimateRemainingPossMC(homeStats, awayStats, period, clockSec) {
  function estPoss(s) { return (Number(s.fga)||0) + 0.44*(Number(s.fta)||0) - (Number(s.oreb)||0) + (Number(s.to)||0); }
  var hPoss = estPoss(homeStats), aPoss = estPoss(awayStats);
  var avgPoss = (hPoss + aPoss) / 2;
  var elapsedMin = (Math.min(period, 4) - 1) * 12 + (12 - clockSec / 60);
  if (elapsedMin < 1) elapsedMin = 1;
  var remainMin = 48 - elapsedMin;
  if (remainMin < 0) remainMin = 0;
  var pacePerMin = avgPoss / elapsedMin;
  return Math.max(0, Math.round(pacePerMin * remainMin));
}

// Build rates from window diff (cumulative snapshot diff)
function buildRatesFromDiff(curr, prev, baseline) {
  var fga = curr.fga - prev.fga;
  var fgm = curr.fgm - prev.fgm;
  var fg3a = curr.fg3a - prev.fg3a;
  var fg3m = curr.fg3m - prev.fg3m;
  var fta = curr.fta - prev.fta;
  var ftm = curr.ftm - prev.ftm;
  var to = curr.to - prev.to;
  var oreb = curr.oreb - prev.oreb;
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
  var bl = baseline || 0.36;
  var sampleWeight = Math.min(0.60, fg3a / 30);
  var fg3Pct = rawFg3Pct * sampleWeight + bl * (1 - sampleWeight);
  function clamp(v) { return Math.max(0, Math.min(1, v)); }
  return {
    toRate: clamp(toRate), fg3aShare: clamp(fg3aShare), fg3Pct: clamp(fg3Pct),
    fg2Pct: clamp(fg2Pct), orebRate: clamp(orebRate), ftaRate: Math.min(ftaRate, 1.0),
    ftPct: clamp(ftPct), _windowPoss: Math.round(poss), _windowFGA: fga,
  };
}

// ── FETCH HELPER ──

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers: { Authorization: AUTH } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── MAIN ──

async function main() {
  for (const game of GAMES) {
    await replayGame(game);
    console.log('\n\n');
  }
}

async function replayGame(game) {
  const GAME_ID = game.id;
  const hA = game.home, aA = game.away;
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` MC REPLAY: ${game.label}`);
  console.log(` Final: ${aA} ${game.finalAway}, ${hA} ${game.finalHome} (${game.winner} wins by ${Math.abs(game.finalAway - game.finalHome)})`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Fetch snapshots
  const data = await fetchJSON(`${BASE}?action=get_snapshot_timeline&game_id=${GAME_ID}`);
  let snaps = data.snapshots || [];
  console.log(`Total server snapshots: ${snaps.length}`);

  // Deduplicate: keep latest per (period, clock, home_pts, away_pts) combo
  const seen = new Map();
  for (const s of snaps) {
    const key = `${s.period}_${s.clock}_${s.home_pts}_${s.away_pts}`;
    seen.set(key, s); // last one wins
  }
  snaps = [...seen.values()];
  snaps.sort((a, b) => {
    if (a.period !== b.period) return a.period - b.period;
    const ca = parseClock(a.clock), cb = parseClock(b.clock);
    return cb - ca; // higher clock = earlier in quarter
  });
  console.log(`Deduplicated: ${snaps.length} unique snapshots\n`);

  // Extract box score stats from each snapshot's raw_stats_json
  const timeline = [];
  for (const s of snaps) {
    let raw = s.raw_stats_json;
    if (!raw) continue;
    if (typeof raw === 'string') raw = JSON.parse(raw);
    const h = raw.home || {}, a = raw.away || {};
    const period = Number(s.period);
    const clockSec = parseClock(s.clock);
    const hPts = Number(s.home_pts), aPts = Number(s.away_pts);
    // Cumulative possession estimate per team
    const hPoss = (h.fga||0) + 0.44*(h.fta||0) - (h.oreb||0) + (h.to||0);
    const aPoss = (a.fga||0) + 0.44*(a.fta||0) - (a.oreb||0) + (a.to||0);
    timeline.push({
      period, clockSec, clock: s.clock, hPts, aPts,
      floor: Number(s.floor_score) || 0, ctrlTeam: s.floor_team,
      xgb: s.xgb_win_prob ? Number(s.xgb_win_prob) : null,
      home: { fgm: h.fgm||0, fga: h.fga||0, fg3m: h.fg3m||0, fg3a: h.fg3a||0, ftm: h.ftm||0, fta: h.fta||0, to: h.to||0, oreb: h.oreb||0, poss: Math.round(hPoss) },
      away: { fgm: a.fgm||0, fga: a.fga||0, fg3m: a.fg3m||0, fg3a: a.fg3a||0, ftm: a.ftm||0, fta: a.fta||0, to: a.to||0, oreb: a.oreb||0, poss: Math.round(aPoss) },
    });
  }

  console.log(`Timeline entries with raw stats: ${timeline.length}\n`);

  // ── SIMULATE MC AT EACH POLL Q2+ ──
  // ORL is home, DET is away
  // Use 0.36 baseline for both teams (no season cache in replay)
  const hBaseline = 0.36, aBaseline = 0.36;

  // MC state (mirrors lt.mc in production)
  let mc = null;
  let canaryLog = [];
  let trajectoryLog = [];

  console.log('─── MC TRAJECTORY + CANARY SIMULATION ───\n');
  console.log('  Period/Clock  |  Score  | Margin | Floor | XGB   | MC WP  | Canary? | Investigation');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');

  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i];
    if (t.period < 2) continue;
    
    // Only run MC when ctrl team is ORL and leading (or recently so)
    const ctrlTeam = t.ctrlTeam;
    if (!ctrlTeam || ctrlTeam === 'Neither') continue;
    const ctrlIsHome = ctrlTeam === hA; // dynamic home team
    const margin = ctrlIsHome ? (t.hPts - t.aPts) : (t.aPts - t.hPts); // ctrl perspective
    if (margin < 0 && !mc) continue; // No MC when ctrl is trailing and no active investigation

    // Find window snapshot: ~20 possessions back
    const totalPoss = (t.home.poss + t.away.poss) / 2;
    let windowSnap = null;
    for (let j = i - 1; j >= 0; j--) {
      const prev = timeline[j];
      const prevPoss = (prev.home.poss + prev.away.poss) / 2;
      if (totalPoss - prevPoss >= 18) { // ~20 possessions window
        windowSnap = prev;
        break;
      }
    }
    if (!windowSnap) continue;

    // Build rates from window
    const hRates = buildRatesFromDiff(t.home, windowSnap.home, hBaseline);
    const aRates = buildRatesFromDiff(t.away, windowSnap.away, aBaseline);
    if (!hRates || !aRates) continue;

    // Estimate remaining possessions
    const remainPoss = estimateRemainingPossMC(t.home, t.away, t.period, t.clockSec);
    if (remainPoss <= 0) continue;

    // ── ALWAYS-ON TRAJECTORY ──
    const trajResult = runMonteCarloSim(hRates, aRates, t.hPts, t.aPts, remainPoss,
      { simCount: 200, ctrlTeam: ctrlIsHome ? 'home' : 'away' });
    
    let canaryStr = '', invStr = '';

    // ── CANARY CHECK ──
    if (!mc || !mc.triggered) {
      if (margin >= 0) { // ctrl must be leading for canary
        const absFired = trajResult.winProb < 0.70;
        const divFired = t.floor != null && (t.floor - trajResult.winProb) > 0.15;
        if (absFired || divFired) {
          canaryStr = `★ FIRED (${absFired ? 'abs' : 'div'})`;
          mc = {
            triggered: true,
            trigger_period: t.period,
            trigger_clock: t.clock,
            trigger_margin: margin,
            trigger_floor: t.floor,
            trigger_xgb: t.xgb,
            trigger_mc: trajResult.winProb,
            trigger_stats: { home: { ...t.home }, away: { ...t.away } },
            ctrl_is_home: ctrlIsHome,
            verdicts: [],
            pattern: null,
            alert_sent: false,
          };
          canaryLog.push({ period: t.period, clock: t.clock, margin, mc: trajResult.winProb, floor: t.floor, xgb: t.xgb, trigger: absFired ? 'absolute' : 'divergence' });
        }
      }
    } else if (mc.triggered && !mc.pattern?.match(/^(CLEAN|WAVE)$/)) {
      // ── INVESTIGATION ──
      const postFGA = (t.home.fga - mc.trigger_stats.home.fga) + (t.away.fga - mc.trigger_stats.away.fga);
      if (postFGA >= 8) {
        const postHRates = buildRatesFromDiff(t.home, mc.trigger_stats.home, hBaseline);
        const postARates = buildRatesFromDiff(t.away, mc.trigger_stats.away, aBaseline);
        if (postHRates && postARates) {
          const invResult = runMonteCarloSim(postHRates, postARates, t.hPts, t.aPts, remainPoss,
            { simCount: 500, ctrlTeam: mc.ctrl_is_home ? 'home' : 'away' });
          const verdict = classifyMCVerdict(invResult.winProb);
          mc.verdicts.push(verdict);
          const pattern = classifyMCPattern(mc.verdicts);
          if (pattern) mc.pattern = pattern;
          invStr = `v=${verdict} invMC=${(invResult.winProb*100).toFixed(1)}% postFGA=${postFGA} pat=${pattern || '...'}`;
          if (pattern === 'CLEAN' && !mc.alert_sent) {
            mc.alert_sent = true;
            invStr += ' ★ MC_COLLAPSE ALERT';
          }
          if (pattern === 'NORMALIZED' || pattern === 'FALSE_ALARM') {
            invStr += ` → RESET`;
            mc = { triggered: false, prior: (mc.prior || 0) + 1 };
          }
        }
      } else {
        mc.verdicts.push('INV');
        invStr = `INV (postFGA=${postFGA} < 8)`;
      }
    }

    // ── OUTPUT ──
    const xgbStr = t.xgb != null ? `${(t.xgb*100).toFixed(1)}%` : '  ?  ';
    const mcStr = `${(trajResult.winProb*100).toFixed(1)}%`;
    const marginSign = margin >= 0 ? `+${margin}` : `${margin}`;
    
    // Only log interesting moments (canary, investigation, or big changes)
    const interesting = canaryStr || invStr || 
      (i > 0 && Math.abs(trajResult.winProb - (trajectoryLog[trajectoryLog.length-1]?.mc || 1)) > 0.08) ||
      trajectoryLog.length === 0 || t.period !== timeline[i-1]?.period;
    
    trajectoryLog.push({ period: t.period, clock: t.clock, mc: trajResult.winProb, margin, floor: t.floor });
    
    if (interesting) {
      console.log(`  Q${t.period} ${t.clock.padStart(5)} | ${aA} ${t.aPts}-${t.hPts} ${hA} | ${marginSign.padStart(4)} | ${t.floor.toFixed(2)} | ${xgbStr.padStart(5)} | ${mcStr.padStart(5)} | ${canaryStr.padEnd(18)} | ${invStr}`);
    }
  }

  // ── SUMMARY ──
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' MC REPLAY SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  
  if (canaryLog.length > 0) {
    console.log('\n📡 CANARY FIRES:');
    for (const c of canaryLog) {
      console.log(`  Q${c.period} ${c.clock} — MC=${(c.mc*100).toFixed(1)}% floor=${c.floor.toFixed(2)} margin=${c.margin} trigger=${c.trigger}`);
    }
  } else {
    console.log('\n❌ MC CANARY NEVER FIRED');
  }

  if (mc && mc.pattern) {
    console.log(`\n🔍 INVESTIGATION RESULT: ${mc.pattern}`);
    console.log(`  Verdicts: ${mc.verdicts.join(' → ')}`);
    if (mc.alert_sent) console.log(`  ★ MC_COLLAPSE alert would have been sent`);
  }

  // Show MC trajectory summary
  console.log(`\n📈 MC TRAJECTORY ARC (ctrl from floor_team):`);
  const keyMoments = trajectoryLog.filter((t, i) => 
    i === 0 || i === trajectoryLog.length - 1 || 
    (i > 0 && Math.abs(t.mc - trajectoryLog[i-1].mc) > 0.05) ||
    t.mc < 0.50 || t.margin <= 0
  );
  for (const t of keyMoments) {
    const bar = '█'.repeat(Math.round(t.mc * 40));
    console.log(`  Q${t.period} ${t.clock.padStart(5)} mg=${String(t.margin >= 0 ? `+${t.margin}` : t.margin).padStart(4)} MC=${(t.mc*100).toFixed(1).padStart(5)}% ${bar}`);
  }

  // Floor vs MC divergence at key moments
  console.log('\n📊 FLOOR vs MC DIVERGENCE:');
  for (const t of trajectoryLog) {
    const div = t.floor - t.mc;
    if (div > 0.10 || t.mc < 0.50 || t.margin <= 0) {
      console.log(`  Q${t.period} ${t.clock.padStart(5)} | Floor=${t.floor.toFixed(2)} MC=${(t.mc*100).toFixed(1)}% GAP=${(div*100).toFixed(1)}pp | margin=${t.margin >= 0 ? '+' : ''}${t.margin}`);
    }
  }
}

function parseClock(clock) {
  if (!clock) return 360;
  const parts = String(clock).split(':');
  return parseInt(parts[0] || 0) * 60 + parseInt(parts[1] || 0);
}

main().catch(e => console.error(e));

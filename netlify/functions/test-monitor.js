// test-monitor.js — Monitor Agent v2 test suite
// Tests mechanical trend computation + Sonnet narrator quality
//
// Usage:
//   ?test=all          — run all tests
//   ?test=trends       — mechanical trend tests only (no Sonnet)
//   ?test=narrator     — Sonnet narrator tests only
//   ?test=t1           — individual trend test
//   ?test=n1           — individual narrator test
//   ?test=t1,n2        — comma-separated

export default async function handler(req) {
  const url = new URL(req.url, 'https://x.com');
  const testParam = url.searchParams.get('test') || 'all';
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return new Response(JSON.stringify({ error: 'No API key' }), { status: 500 });

  // ── INLINE computeMonitorTrends (mirrors poll-live-bdl.mjs) ──────────
  function computeMonitorTrends(gameData) {
    var snaps = gameData.snapHistory;
    var ctrlIsHome = gameData.ctrlIsHome;
    var liveSnaps = [snaps[0]];
    var stalePollCount = 0;
    for (var i = 1; i < snaps.length; i++) {
      if (snaps[i].period === snaps[i-1].period && snaps[i].clock === snaps[i-1].clock) {
        stalePollCount++;
      } else {
        liveSnaps.push(snaps[i]);
      }
    }
    var liveFloors = liveSnaps.map(s => Number(s.floor_score));
    var liveMargins = liveSnaps.map(s => {
      var h = Number(s.home_pts || 0), a = Number(s.away_pts || 0);
      return ctrlIsHome ? h - a : a - h;
    });

    var momentumDir = 'STABLE', momentumStreak = 0, momentumDelta = 0;
    if (stalePollCount >= 3 && liveSnaps.length <= 2) {
      momentumDir = 'STALE';
      momentumStreak = stalePollCount;
    } else if (liveFloors.length >= 2) {
      var dir = null, streak = 0;
      for (var j = liveFloors.length - 1; j > 0; j--) {
        var diff = liveFloors[j] - liveFloors[j - 1];
        if (diff > 0.01) {
          if (dir === 'RISING' || dir === null) { dir = 'RISING'; streak++; }
          else break;
        } else if (diff < -0.01) {
          if (dir === 'FALLING' || dir === null) { dir = 'FALLING'; streak++; }
          else break;
        } else {
          if (dir === null) { streak++; }
          else break;
        }
      }
      if (liveFloors.length >= 4) {
        var changes = 0;
        for (var k = 2; k < liveFloors.length; k++) {
          var prev = liveFloors[k - 1] - liveFloors[k - 2];
          var curr = liveFloors[k] - liveFloors[k - 1];
          if ((prev > 0.01 && curr < -0.01) || (prev < -0.01 && curr > 0.01)) changes++;
        }
        if (changes >= 2 && streak <= 1) dir = 'OSCILLATING';
      }
      momentumDir = dir || 'STABLE';
      momentumStreak = streak;
      momentumDelta = liveFloors.length >= 2
        ? Math.round((liveFloors[liveFloors.length - 1] - liveFloors[Math.max(0, liveFloors.length - 1 - streak)]) * 100) / 100
        : 0;
    }

    var sustTiers = { 'LOCKED IN': 5, 'DURABLE': 4, 'MIXED': 3, 'COLD': 2, 'FRAGILE': 1, 'UNSUSTAINABLE': 0 };
    var oppSustHistory = liveSnaps.map(s => s.opp_sust).filter(Boolean);
    var sustArcDir = 'STABLE', sustArcDetail = '';
    if (oppSustHistory.length >= 2) {
      var firstSust = sustTiers[oppSustHistory[0]] ?? 3;
      var lastSust = sustTiers[oppSustHistory[oppSustHistory.length - 1]] ?? 3;
      sustArcDir = lastSust < firstSust ? 'DEGRADING' : lastSust > firstSust ? 'IMPROVING' : 'STABLE';
      var seenTiers = [];
      oppSustHistory.forEach(t => { if (seenTiers[seenTiers.length - 1] !== t) seenTiers.push(t); });
      sustArcDetail = seenTiers.join(' \u2192 ');
    }

    var floorMarginRel = 'ALIGNED';
    if (liveFloors.length >= 3 && liveMargins.length >= 3) {
      var floorChange = liveFloors[liveFloors.length - 1] - liveFloors[0];
      var marginChange = liveMargins[liveMargins.length - 1] - liveMargins[0];
      var floorUp = floorChange > 0.03, floorDown = floorChange < -0.03;
      var marginUp = marginChange > 2, marginDown = marginChange < -2;
      if ((floorUp && marginDown) || (floorDown && marginUp)) floorMarginRel = 'DIVERGING';
      else if ((floorUp && marginUp) || (floorDown && marginDown)) floorMarginRel = 'CONVERGING';
    }

    return {
      momentum: { direction: momentumDir, streak: momentumStreak, delta: momentumDelta },
      sustArc: { direction: sustArcDir, detail: sustArcDetail },
      floorMarginRel: floorMarginRel,
      stalePollCount: stalePollCount,
      liveFloors: liveFloors,
    };
  }

  // Helper: make a snapshot row
  function snap(period, clock, floor, homePts, awayPts, opts = {}) {
    return {
      period, clock, floor_score: floor, home_pts: homePts, away_pts: awayPts,
      i1: opts.i1 ?? 0.5, i2: opts.i2 ?? 0.5, i3: opts.i3 ?? 0.5,
      i4: opts.i4 ?? 0.5, i5: opts.i5 ?? 0.5,
      tp_class: opts.tp ?? null, ls_class: opts.ls ?? null,
      ctrl_sust: opts.ctrlSust ?? 'DURABLE', opp_sust: opts.oppSust ?? 'MIXED',
      floor_team: opts.floorTeam ?? 'DAL',
    };
  }

  // ── TREND TEST SCENARIOS (mechanical, no Sonnet) ─────────────────────

  const trendTests = {
    't1': {
      name: 'MOMENTUM RISING — steady climb across 6 polls',
      gameData: {
        ctrlIsHome: false,
        snapHistory: [
          snap(2, '8:00', 0.52, 45, 40), snap(2, '6:00', 0.55, 48, 44),
          snap(2, '4:00', 0.58, 51, 49), snap(2, '2:00', 0.61, 54, 53),
          snap(3, '10:00', 0.64, 57, 58), snap(3, '8:00', 0.67, 60, 63),
        ],
      },
      expected: { momentum: 'RISING', streak: 5, sustArc: 'STABLE', floorMarginRel: 'CONVERGING' },
    },
    't2': {
      name: 'MOMENTUM FALLING — floor collapsing',
      gameData: {
        ctrlIsHome: true,
        snapHistory: [
          snap(2, '6:00', 0.70, 50, 42), snap(2, '4:00', 0.66, 52, 48),
          snap(2, '2:00', 0.62, 54, 53), snap(3, '10:00', 0.57, 56, 58),
          snap(3, '8:00', 0.53, 58, 64),
        ],
      },
      expected: { momentum: 'FALLING', sustArc: 'STABLE', floorMarginRel: 'CONVERGING' },
    },
    't3': {
      name: 'STALE — halftime, 4 identical polls',
      gameData: {
        ctrlIsHome: true,
        snapHistory: [
          snap(2, '0:00', 0.62, 50, 45),
          snap(2, '0:00', 0.62, 50, 45), snap(2, '0:00', 0.62, 50, 45),
          snap(2, '0:00', 0.62, 50, 45), snap(2, '0:00', 0.62, 50, 45),
        ],
      },
      expected: { momentum: 'STALE', stalePollCount: 4 },
    },
    't4': {
      name: 'DIVERGING — floor rising but margin getting worse (away ctrl)',
      gameData: {
        ctrlIsHome: false,
        snapHistory: [
          snap(2, '6:00', 0.55, 48, 40), snap(2, '4:00', 0.59, 52, 42),
          snap(2, '2:00', 0.62, 56, 43), snap(3, '10:00', 0.65, 60, 44),
          snap(3, '8:00', 0.68, 65, 45),
        ],
      },
      expected: { momentum: 'RISING', floorMarginRel: 'DIVERGING' },
    },
    't5': {
      name: 'OSCILLATING — floor bouncing up and down',
      gameData: {
        ctrlIsHome: true,
        snapHistory: [
          snap(2, '8:00', 0.55, 40, 38), snap(2, '6:00', 0.62, 44, 40),
          snap(2, '4:00', 0.54, 46, 46), snap(2, '2:00', 0.63, 50, 47),
          snap(3, '10:00', 0.56, 52, 52), snap(3, '8:00', 0.64, 56, 53),
        ],
      },
      expected: { momentum: 'OSCILLATING' },
    },
    't6': {
      name: 'SUST ARC DEGRADING — opponent shooting regressing across 4 tiers',
      gameData: {
        ctrlIsHome: true,
        snapHistory: [
          snap(2, '8:00', 0.55, 40, 42, { oppSust: 'LOCKED IN' }),
          snap(2, '6:00', 0.58, 44, 44, { oppSust: 'LOCKED IN' }),
          snap(2, '4:00', 0.60, 48, 46, { oppSust: 'DURABLE' }),
          snap(2, '2:00', 0.62, 51, 48, { oppSust: 'MIXED' }),
          snap(3, '10:00', 0.64, 55, 50, { oppSust: 'FRAGILE' }),
        ],
      },
      expected: { sustArc: 'DEGRADING' },
    },
  };

  // ── NARRATOR TEST SCENARIOS (calls Sonnet) ──────────────────────────

  const narratorTests = {
    'n1': {
      name: 'Narrator: rising momentum + opp degrading — should narrate building edge for both teams',
      gameData: {
        gameId: 'test1', matchup: 'DAL@BOS', homeAlias: 'BOS', awayAlias: 'DAL',
        controlTeam: 'DAL', ctrlIsHome: false, floor: 0.68, margin: -3,
        period: 3, clock: '6:00',
        snapHistory: [
          snap(2, '6:00', 0.52, 45, 40, { i1: 0.6, i2: 0.7, i3: 0.5, i4: 0.8, i5: 0.6, oppSust: 'LOCKED IN', floorTeam: 'DAL' }),
          snap(2, '4:00', 0.56, 48, 43, { i1: 0.6, i2: 0.7, i3: 0.5, i4: 0.8, i5: 0.6, oppSust: 'DURABLE', floorTeam: 'DAL' }),
          snap(2, '2:00', 0.60, 52, 47, { i1: 0.65, i2: 0.72, i3: 0.52, i4: 0.8, i5: 0.6, oppSust: 'MIXED', floorTeam: 'DAL' }),
          snap(3, '10:00', 0.64, 58, 54, { i1: 0.65, i2: 0.75, i3: 0.55, i4: 0.82, i5: 0.62, oppSust: 'MIXED', floorTeam: 'DAL' }),
          snap(3, '8:00', 0.66, 62, 58, { i1: 0.68, i2: 0.75, i3: 0.55, i4: 0.82, i5: 0.62, oppSust: 'FRAGILE', tp: 'PROBABLE', floorTeam: 'DAL' }),
          snap(3, '6:00', 0.68, 65, 62, { i1: 0.7, i2: 0.78, i3: 0.55, i4: 0.85, i5: 0.65, oppSust: 'FRAGILE', tp: 'PROBABLE', ctrlSust: 'DURABLE', floorTeam: 'DAL' }),
        ],
        recentAlerts: [
          { alert_type: 'WINDOW BUY', period: 2, clock: '4:00', floor_score: 0.56, margin: -5, agent_decision: 'SEND' },
        ],
        rawInputs: {
          home: { paint: 18, fta: 8, to: 5, stl: 3, fg3a: 28, fg3m: 9, oreb: 4, pot: 6, fbp: 4, scp: 4, bigLead: 12, bench: 22, poss: 72 },
          away: { paint: 30, fta: 16, to: 7, stl: 8, fg3a: 19, fg3m: 6, oreb: 9, pot: 12, fbp: 10, scp: 8, bigLead: 0, bench: 14, poss: 72 },
        },
      },
      check: (obs) => {
        var hasObservation = obs.observation && obs.observation.length > 20;
        var hasRisk = obs.atRisk && obs.atRisk.length > 20;
        var hasCtrl = obs.controlTeam === 'DAL';
        return { pass: hasObservation && hasRisk && hasCtrl,
          detail: `obs=${hasObservation} risk=${hasRisk} ctrl=${obs.controlTeam}` };
      },
    },
    'n2': {
      name: 'Narrator: stale data at halftime — should flag data not updating',
      gameData: {
        gameId: 'test2', matchup: 'MIA@PHI', homeAlias: 'PHI', awayAlias: 'MIA',
        controlTeam: 'MIA', ctrlIsHome: false, floor: 0.60, margin: -2,
        period: 2, clock: '0:00',
        snapHistory: [
          snap(2, '2:00', 0.58, 48, 44, { oppSust: 'DURABLE', floorTeam: 'MIA' }),
          snap(2, '0:00', 0.60, 50, 46, { oppSust: 'DURABLE', floorTeam: 'MIA' }),
          snap(2, '0:00', 0.60, 50, 46, { oppSust: 'DURABLE', floorTeam: 'MIA' }),
          snap(2, '0:00', 0.60, 50, 46, { oppSust: 'DURABLE', floorTeam: 'MIA' }),
          snap(2, '0:00', 0.60, 50, 46, { oppSust: 'DURABLE', floorTeam: 'MIA' }),
        ],
        recentAlerts: [],
        rawInputs: {
          home: { paint: 16, fta: 10, to: 6, stl: 4, fg3a: 20, fg3m: 7, oreb: 5, pot: 8, fbp: 6, scp: 4, bigLead: 8, bench: 12, poss: 55 },
          away: { paint: 22, fta: 12, to: 4, stl: 6, fg3a: 16, fg3m: 5, oreb: 7, pot: 10, fbp: 8, scp: 6, bigLead: 2, bench: 10, poss: 55 },
        },
      },
      check: (obs) => {
        var mentionsStale = /stale|halftime|half|timeout|not updat|break|pre.?break|hasn.?t.*updat/i.test(obs.observation || '');
        return { pass: mentionsStale, detail: `mentionsStale=${mentionsStale}` };
      },
    },
    'n3': {
      name: 'Narrator: divergence — floor high but losing by more, should flag disconnect',
      gameData: {
        gameId: 'test3', matchup: 'SAC@LAC', homeAlias: 'LAC', awayAlias: 'SAC',
        controlTeam: 'SAC', ctrlIsHome: false, floor: 0.72, margin: -10,
        period: 3, clock: '4:00',
        snapHistory: [
          snap(2, '6:00', 0.62, 42, 38, { oppSust: 'DURABLE', floorTeam: 'SAC' }),
          snap(2, '4:00', 0.65, 46, 39, { oppSust: 'DURABLE', floorTeam: 'SAC' }),
          snap(2, '2:00', 0.67, 50, 40, { oppSust: 'MIXED', floorTeam: 'SAC' }),
          snap(3, '8:00', 0.70, 56, 42, { oppSust: 'MIXED', floorTeam: 'SAC' }),
          snap(3, '6:00', 0.71, 62, 44, { oppSust: 'MIXED', floorTeam: 'SAC' }),
          snap(3, '4:00', 0.72, 68, 46, { oppSust: 'MIXED', tp: 'CONTESTED', floorTeam: 'SAC' }),
        ],
        recentAlerts: [
          { alert_type: 'BUY', period: 2, clock: '6:00', floor_score: 0.62, margin: -4, agent_decision: 'SEND' },
        ],
        rawInputs: {
          home: { paint: 32, fta: 18, to: 3, stl: 8, fg3a: 30, fg3m: 14, oreb: 2, pot: 4, fbp: 12, scp: 2, bigLead: 16, bench: 28, poss: 74 },
          away: { paint: 28, fta: 14, to: 9, stl: 3, fg3a: 22, fg3m: 6, oreb: 8, pot: 14, fbp: 6, scp: 10, bigLead: 0, bench: 10, poss: 74 },
        },
      },
      check: (obs) => {
        var mentionsDivergence = /diverg|disconnect|despite|floor.*margin|margin.*worse|losing.*more|gap.*grow|widen|structur.*doesn.?t.*match/i.test(obs.observation + ' ' + obs.atRisk);
        return { pass: mentionsDivergence, detail: `mentionsDivergence=${mentionsDivergence}` };
      },
    },
  };

  // ── BUILD NARRATOR PROMPT ────────────────────────────────────────────

  function buildNarratorPrompt(gameData) {
    var t = computeMonitorTrends(gameData);
    var snaps = gameData.snapHistory;
    var latest = snaps[snaps.length - 1];

    var floorTraj = snaps.map(s =>
      `Q${s.period} ${s.clock}: ${Number(s.floor_score).toFixed(2)} (${s.away_pts}-${s.home_pts})`
    ).join('\n    ');

    var i1 = latest.i1 != null ? (gameData.ctrlIsHome ? Number(latest.i1) : 1 - Number(latest.i1)) : null;
    var i2 = latest.i2 != null ? (gameData.ctrlIsHome ? Number(latest.i2) : 1 - Number(latest.i2)) : null;
    var i3 = latest.i3 != null ? (gameData.ctrlIsHome ? Number(latest.i3) : 1 - Number(latest.i3)) : null;
    var i4 = latest.i4 != null ? (gameData.ctrlIsHome ? Number(latest.i4) : 1 - Number(latest.i4)) : null;
    var i5 = latest.i5 != null ? (gameData.ctrlIsHome ? Number(latest.i5) : 1 - Number(latest.i5)) : null;

    var momLabel = `${t.momentum.direction}`;
    if (t.momentum.direction === 'STALE') momLabel += ` (${t.stalePollCount} identical polls — halftime/timeout)`;
    else if (t.momentum.streak > 0) momLabel += ` (${t.momentum.streak} polls, ${t.momentum.delta >= 0 ? '+' : ''}${t.momentum.delta.toFixed(2)})`;

    var rawBlock = '';
    if (gameData.rawInputs) {
      var ctrl = gameData.ctrlIsHome ? gameData.rawInputs.home : gameData.rawInputs.away;
      var opp = gameData.ctrlIsHome ? gameData.rawInputs.away : gameData.rawInputs.home;
      var ctrlAlias = gameData.controlTeam;
      var oppAlias = gameData.ctrlIsHome ? gameData.awayAlias : gameData.homeAlias;
      rawBlock = `\n  Raw inputs (${ctrlAlias} / ${oppAlias}):`
        + `\n    Paint: ${ctrl?.paint || 0} / ${opp?.paint || 0} | FTA: ${ctrl?.fta || 0} / ${opp?.fta || 0} | TO: ${ctrl?.to || 0} / ${opp?.to || 0} | STL: ${ctrl?.stl || 0} / ${opp?.stl || 0}`
        + `\n    3PA: ${ctrl?.fg3a || 0} / ${opp?.fg3a || 0} | 3PM: ${ctrl?.fg3m || 0} / ${opp?.fg3m || 0} (${ctrl?.fg3a > 0 ? Math.round(ctrl.fg3m / ctrl.fg3a * 100) : 0}% / ${opp?.fg3a > 0 ? Math.round(opp.fg3m / opp.fg3a * 100) : 0}%)`
        + `\n    OREB: ${ctrl?.oreb || 0} / ${opp?.oreb || 0} | POT: ${ctrl?.pot || 0} / ${opp?.pot || 0} | FBP: ${ctrl?.fbp || 0} / ${opp?.fbp || 0} | SCP: ${ctrl?.scp || 0} / ${opp?.scp || 0}`
        + `\n    BigLead: ${ctrlAlias} ${ctrl?.bigLead || 0} / ${oppAlias} ${opp?.bigLead || 0} | Bench: ${ctrl?.bench || 0} / ${opp?.bench || 0} | Poss: ${ctrl?.poss || 0}`;
    }

    var alertsBlock = '';
    if (gameData.recentAlerts && gameData.recentAlerts.length > 0) {
      alertsBlock = '\n  Recent alerts: ' + gameData.recentAlerts.map(a =>
        `${a.alert_type} Q${a.period} ${a.clock} floor:${Number(a.floor_score).toFixed(2)} margin:${a.margin} \u2192 ${a.agent_decision || 'DIRECT'}`
      ).join(' | ');
    }

    var gameBlock = `GAME: ${gameData.matchup}\n`
      + `  Score: ${gameData.awayAlias} ${latest.away_pts}, ${gameData.homeAlias} ${latest.home_pts} (Q${gameData.period} ${gameData.clock})\n`
      + `  ${gameData.controlTeam} controls floor at ${gameData.floor.toFixed(2)}, ${gameData.margin >= 0 ? 'leading' : 'trailing'} by ${Math.abs(gameData.margin)}\n`
      + `  Trend: MOMENTUM ${momLabel} | OPP SUST: ${t.sustArc.direction}${t.sustArc.detail ? ' (' + t.sustArc.detail + ')' : ''} | FLOOR-MARGIN: ${t.floorMarginRel}\n`
      + `  Indicators (${gameData.controlTeam}-relative): I1=${i1 != null ? i1.toFixed(2) : '?'} I2=${i2 != null ? i2.toFixed(2) : '?'} I3=${i3 != null ? i3.toFixed(2) : '?'} I4=${i4 != null ? i4.toFixed(2) : '?'} I5=${i5 != null ? i5.toFixed(2) : '?'}\n`
      + `  TP: ${latest.tp_class || '?'} | LS: ${latest.ls_class || '?'} | Ctrl sust: ${latest.ctrl_sust || '?'} | Opp sust: ${latest.opp_sust || '?'}\n`
      + `  Floor trajectory:\n    ${floorTraj}`
      + rawBlock
      + alertsBlock;

    return `You are a live game observer for a sports betting intelligence system. Your job is to narrate what's happening in each game \u2014 what's stable, what's shifting, what's at risk of flipping. You are NOT making bet recommendations or saying SEND or SUPPRESS.

You see both teams. The control team holds the structural floor edge, but the opponent's story is equally important.

${gameBlock}

For each game, respond with:
GAME: [matchup]
OBSERVATION: [2-4 sentences. Narrate BOTH teams. Focus on what's shifting. If trend says STALE, note data hasn't updated.]
AT_RISK: [Which structural edges look fragile? Read the raw inputs. Be specific. Speak to both teams.]
CTRL_TEAM: [abbreviation]

RULES:
- Observer only. No SEND, SUPPRESS, BUY, SELL.
- Pre-computed trend labels are ground truth. Reference them, don't recalculate.
- Read raw inputs to assess what's underneath the indicators.
- AT_RISK is your most important output. Be specific about inputs and what would cause a flip.
- 2-4 sentences per section max.`;
  }

  // ── RUN TESTS ──────────────────────────────────────────────────────────

  var testKeys = [];
  if (testParam === 'all') testKeys = [...Object.keys(trendTests), ...Object.keys(narratorTests)];
  else if (testParam === 'trends') testKeys = Object.keys(trendTests);
  else if (testParam === 'narrator') testKeys = Object.keys(narratorTests);
  else testKeys = testParam.split(',').map(s => s.trim());

  var results = [];

  // Run trend tests (no Sonnet)
  for (var tk of testKeys.filter(k => trendTests[k])) {
    var tt = trendTests[tk];
    var trends = computeMonitorTrends(tt.gameData);
    var pass = true;
    var details = [];

    if (tt.expected.momentum && trends.momentum.direction !== tt.expected.momentum) {
      pass = false; details.push(`momentum: expected ${tt.expected.momentum}, got ${trends.momentum.direction}`);
    } else if (tt.expected.momentum) { details.push(`momentum: ${trends.momentum.direction} \u2713`); }

    if (tt.expected.streak != null && trends.momentum.streak !== tt.expected.streak) {
      pass = false; details.push(`streak: expected ${tt.expected.streak}, got ${trends.momentum.streak}`);
    }

    if (tt.expected.sustArc && trends.sustArc.direction !== tt.expected.sustArc) {
      pass = false; details.push(`sustArc: expected ${tt.expected.sustArc}, got ${trends.sustArc.direction}`);
    } else if (tt.expected.sustArc) { details.push(`sustArc: ${trends.sustArc.direction} \u2713`); }

    if (tt.expected.sustDetail && trends.sustArc.detail !== tt.expected.sustDetail) {
      pass = false; details.push(`sustDetail: expected "${tt.expected.sustDetail}", got "${trends.sustArc.detail}"`);
    } else if (tt.expected.sustDetail) { details.push(`sustDetail: \u2713`); }

    if (tt.expected.floorMarginRel && trends.floorMarginRel !== tt.expected.floorMarginRel) {
      pass = false; details.push(`floorMarginRel: expected ${tt.expected.floorMarginRel}, got ${trends.floorMarginRel}`);
    } else if (tt.expected.floorMarginRel) { details.push(`floorMarginRel: ${trends.floorMarginRel} \u2713`); }

    if (tt.expected.stalePollCount != null && trends.stalePollCount !== tt.expected.stalePollCount) {
      pass = false; details.push(`stalePollCount: expected ${tt.expected.stalePollCount}, got ${trends.stalePollCount}`);
    } else if (tt.expected.stalePollCount != null) { details.push(`stalePollCount: ${trends.stalePollCount} \u2713`); }

    results.push({
      test: tk, name: tt.name, type: 'trend',
      pass: pass ? 'PASS' : 'FAIL',
      detail: details.join(' | '),
      computed: { momentum: trends.momentum, sustArc: trends.sustArc, floorMarginRel: trends.floorMarginRel, stalePollCount: trends.stalePollCount },
    });
  }

  // Run narrator tests (calls Sonnet)
  for (var nk of testKeys.filter(k => narratorTests[k])) {
    var nt = narratorTests[nk];
    var prompt = buildNarratorPrompt(nt.gameData);

    try {
      var resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
      });
      var data = await resp.json();
      var text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

      var obsMatch = text.match(/OBSERVATION\s*(?:\*{0,2})\s*:?\s*([\s\S]*?)(?=(?:\*{0,2})AT[_ ]?RISK(?:\*{0,2})\s*:|(?:\*{0,2})CTRL[_ ]?TEAM(?:\*{0,2})\s*:|$)/i);
      var riskMatch = text.match(/AT[_ ]?RISK\s*(?:\*{0,2})\s*:?\s*([\s\S]*?)(?=(?:\*{0,2})CTRL[_ ]?TEAM(?:\*{0,2})\s*:|(?:\*{0,2})GAME(?:\*{0,2})\s*:|$)/i);
      var ctrlMatch = text.match(/CTRL[_ ]?TEAM\s*(?:\*{0,2})\s*:?\s*(\S+)/i);

      var obs = {
        observation: obsMatch ? obsMatch[1].trim() : '',
        atRisk: riskMatch ? riskMatch[1].trim() : '',
        controlTeam: ctrlMatch ? ctrlMatch[1].trim() : '',
      };

      var checkResult = nt.check(obs);
      var tokens = data.usage ? `${data.usage.input_tokens}in/${data.usage.output_tokens}out` : '?';

      results.push({
        test: nk, name: nt.name, type: 'narrator',
        pass: checkResult.pass ? 'PASS' : 'FAIL',
        detail: checkResult.detail,
        observation: obs.observation.substring(0, 200),
        atRisk: obs.atRisk.substring(0, 200),
        controlTeam: obs.controlTeam,
        tokens: tokens,
      });
    } catch (e) {
      results.push({ test: nk, name: nt.name, type: 'narrator', pass: 'ERROR', detail: e.message });
    }
  }

  var passed = results.filter(r => r.pass === 'PASS').length;
  var total = results.length;
  return new Response(JSON.stringify({ summary: `${passed}/${total} passed`, results }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}

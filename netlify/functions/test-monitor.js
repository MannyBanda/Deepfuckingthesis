// test-monitor.js — Structured test of the monitor agent
// Hit: /.netlify/functions/test-monitor?test=all (default)
// Or:  ?test=1  ?test=2  etc. for individual scenarios
// Or:  ?test=positions  ?test=threats  ?test=emerging  ?test=alertagent  for groups

export default async function handler(req) {
  const url = new URL(req.url, 'https://x.com');
  const testParam = url.searchParams.get('test') || 'all';
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return new Response(JSON.stringify({ error: 'No API key' }), { status: 500 });

  // ── MONITOR PROMPT BUILDER ──────────────────────────────────────────────

  function buildMonitorPrompt(ctx) {
    var positionsBlock = '';
    if (ctx.activeAlerts && ctx.activeAlerts.length > 0) {
      positionsBlock = 'ACTIVE POSITIONS:\n' + ctx.activeAlerts.map(a => {
        var floorDelta = (a.currentFloor - a.floorAtAlert).toFixed(2);
        var floorDir = Number(floorDelta) >= 0 ? '+' : '';
        return `Alert #${a.alertId}: ${a.alertType} ${a.controlTeam} (${a.matchup})\n`
          + `  Sent: Q${a.periodAtAlert} ${a.clockAtAlert} (${a.minutesSinceSent} min ago)\n`
          + `  At alert: floor ${a.floorAtAlert.toFixed(2)}, margin ${a.marginAtAlert}, ML ${a.mlAtAlert || '?'}, conviction ${a.convictionAtAlert || '?'}\n`
          + `  Now: floor ${a.currentFloor.toFixed(2)} (${floorDir}${floorDelta}), margin ${a.currentMargin}, Q${a.currentPeriod} ${a.currentClock}\n`
          + `  I4 now: ${a.currentI4 != null ? a.currentI4.toFixed(2) : '?'} | TP: ${a.currentTpClass || '?'} | LS: ${a.currentLsClass || '?'}\n`
          + `  Floor trajectory: ${a.floorTrajectory.map(f => f.toFixed(2)).join(' → ')}\n`
          + `  Score flip: ${a.tookLead ? 'YES — team took the lead' : a.lostLead ? 'YES — team LOST the lead' : 'No'}`;
      }).join('\n\n');
    }

    var threatsBlock = '';
    if (ctx.leadThreats && ctx.leadThreats.length > 0) {
      threatsBlock = '\nLEAD THREATS:\n' + ctx.leadThreats.map(t => {
        return `Alert #${t.alertId}: ${t.alertType} ${t.controlTeam} (${t.matchup})\n`
          + `  ${t.minutesSinceSent} min ago: leading by ${t.marginAtAlert}, LS ${t.lsAtAlert}\n`
          + `  Now: margin ${t.currentMargin}, LS ${t.currentLsClass || '?'}`;
      }).join('\n');
    }

    var slateBlock = '\nFULL SLATE:\n' + (ctx.liveGames || []).map(g => {
      var marker = g.hasActiveAlert ? ' [ACTIVE POSITION]' : '';
      return `${g.matchup}: ${g.controlTeam} floor ${g.floor.toFixed(2)}, ${g.margin >= 0 ? 'leading' : 'trailing'} by ${Math.abs(g.margin)}, Q${g.period} ${g.clock}${marker}`;
    }).join('\n');

    var emergingBlock = '';
    if (ctx.emergingCandidates && ctx.emergingCandidates.length > 0) {
      emergingBlock = '\nEMERGING SCAN CANDIDATES (games without recent mechanical alerts):\n'
        + ctx.emergingCandidates.map(e => {
          return `${e.matchup}: ${e.controlTeam} floor ${e.floor.toFixed(2)}, margin ${e.margin >= 0 ? '+' : ''}${e.margin}, Q${e.period} ${e.clock}\n`
            + `  I4: ${e.i4 != null ? e.i4.toFixed(2) : '?'} | Floor trajectory: ${e.floorTrajectory.map(f => f.toFixed(2)).join(' → ')}`;
        }).join('\n');
    }

    var hasMultipleGames = (ctx.liveGames || []).length >= 2;
    var hasEmerging = (ctx.emergingCandidates || []).length > 0;

    return `You are a live betting position monitor. The user has active bets based on previously-sent alerts. Your job is to assess how each position is evolving and whether the user needs an update. You also scan for emerging opportunities the mechanical threshold system can't catch.

${positionsBlock}
${threatsBlock}
${slateBlock}
${emergingBlock}

For each ACTIVE POSITION, respond with:
ALERT_ID: [id]
STATUS: [TRACKING|CONFIRMED|FADING|INVALIDATED]
REASONING: [1-2 sentences]
NOTIFY: [YES|NO — only YES for meaningful status changes, not routine tracking]
BODY: [if NOTIFY=YES: plain-English update for the bettor. Lead with what changed.]

For each LEAD THREAT, respond with:
ALERT_ID: [id]
STATUS: [ESCALATING|STABILIZED|RESOLVED]
NOTIFY: [YES|NO]
BODY: [if YES: plain-English update]

${hasMultipleGames ? `If there's a meaningful prioritization across games:
SLATE_FOCUS: [Which game deserves attention and why. 1-2 sentences.]
SLATE_NOTIFY: [YES|NO — only YES if actionable]
SLATE_BODY: [if YES: plain-English slate summary]` : ''}

${hasEmerging ? `Look for EMERGING opportunities — signals the mechanical system can't catch:
- MOMENTUM: Floor rising steadily across 4+ snapshots, trajectory IS the signal
- CONVERGENCE: Recent-window dominance converting to full-game floor improvement
- SUSTAINABILITY_CASCADE: Opponent shooting degrading gradually across tiers (no single-step flip)
- RELATIVE_VALUE: One game has dramatically better ML/edge for comparable conviction vs another
- FLOOR_MARGIN_DIVERGENCE: Floor 0.65+ but margin getting worse across 5+ snapshots

For each EMERGING signal found:
EMERGING_GAME: [matchup]
EMERGING_SIGNAL: [type]
EMERGING_DETAIL: [What you see and why it matters. 1-2 sentences.]
EMERGING_CONFIDENCE: [LOW|MODERATE|HIGH]
EMERGING_NOTIFY: [YES|NO — only YES for MODERATE+ confidence]
EMERGING_BODY: [if YES: plain-English alert. Frame as exploratory, not a confirmed BUY.]
EMERGING_CTRL: [control team abbreviation]` : ''}

RULES:
- TRACKING with NOTIFY=NO is the most common output. Most cycles, nothing changed enough to notify. Don't over-notify.
- CONFIRMED requires a concrete signal: score flip (trailing → leading), floor rose 0.05+, or opponent sustainability broke. Not just "looks fine."
- FADING requires floor trending DOWN across 3+ snapshots, not just one dip.
- INVALIDATED means the structural THESIS is broken (floor collapsed, I4 flipped decisively). A BUY team still trailing is NOT invalidated if the floor holds — that's the whole BUY thesis.
- For BWC: CONFIRMED = lead grew + LS improved. FADING = lead shrinking. INVALIDATED = lead lost.
- For WINDOW BUY: CONFIRMED = full-game floor rose toward window read. FADING = window advantage didn't translate.
- STABILIZED requires lead to have held or grown after LEAD AT RISK. Lead merely not shrinking further is TRACKING, not STABILIZED.
- EMERGING MOMENTUM requires 4+ snapshots of consistent floor improvement. A single jump is noise.
- EMERGING only for signals mechanical thresholds CAN'T catch — trajectory, cross-game, gradual cascades. If mechanical BUY would fire within 1-2 polls anyway, skip.
- EMERGING bodies must frame as exploratory: "building momentum" not "BUY now."
- If no EMERGING signals exist, omit the EMERGING section entirely.`;
  }

  // ── ALERT AGENT PROMPT BUILDER (for integration test) ───────────────────

  function buildAlertAgentPrompt(ctx) {
    return `You are a live NBA betting alert quality agent. A mechanical system has identified a potential betting signal. Your job is to assess whether it should be sent to the bettor.

ALERT:
Type: ${ctx.alertType} (${ctx.alertTier})
Control team: ${ctx.controlTeam} | Floor: ${ctx.floor} | Margin: ${ctx.margin} (${ctx.isTrailing ? 'trailing' : 'leading'})
Period: Q${ctx.period} ${ctx.clock} | Minutes left: ${ctx.minsLeft}
Mechanical Conviction: ${ctx.convictionTier || 'N/A'} (${ctx.convictionCombo || 'N/A'}) ${ctx.convictionPairs ? '| Killer pairs: ' + ctx.convictionPairs : ''}
Edge: ${ctx.edge != null ? ctx.edge + '%' : 'N/A'} | ML: ${ctx.ml || 'N/A'} | Spread: ${ctx.spread || 'N/A'}
TP: ${ctx.tpClass || 'N/A'} | LS: ${ctx.lsClass || 'N/A'}
Ctrl sust: ${ctx.ctrlSust || 'N/A'} | Opp sust: ${ctx.oppSust || 'N/A'}
Window score: ${ctx.windowScore || 'N/A'}

INDICATORS (control-team-relative):
I1 Disruption: ${ctx.i1} | I2 Interior: ${ctx.i2} | I3 Shot Quality: ${ctx.i3} | I4 Game Control: ${ctx.i4} | I5 Execution: ${ctx.i5}
Indicators won: ${ctx.indWon || 'none'} (${ctx.indicatorsWon}/5) | Lost: ${ctx.indLost || 'none'}
I4 COMBO: ${ctx.i4Combo ? 'YES' : ctx.i4Won ? 'PARTIAL' : ctx.i4Decisive ? 'NO' : 'EVEN'}

FLOOR TRAJECTORY (recent snapshots, newest first):
${ctx.floorHistory || 'No prior snapshots'}

PRIOR ALERTS THIS GAME:
${ctx.priorAlerts || 'None'}

QUARTER PERFORMANCE:
${ctx.quarterSummary || 'N/A'}

RULES:
- FIRED alerts passed all mechanical thresholds. You should SEND unless you see a clear structural contradiction.
  I4 COMBO YES: highest conviction, SEND with confidence.
  I4 COMBO NO (opponent has game control): SUPPRESS or DOWNGRADE unless 4/5 indicators.
  Floor driven by I1+I2 without I4/I5: effort-based, DOWNGRADE unless strong sust.
  Floor trending DOWN: fading control, consider SUPPRESS.
- CANDIDATE alerts: SEND only if structural case is compelling.
- CANDIDATE BUYs floor 0.55-0.65: only SEND if I4 COMBO YES.
- EARLY GAME (Q1-Q2): FIRED + I4 COMBO YES = SEND. CANDIDATE + I4 COMBO YES = SEND.
  CANDIDATE + I4 COMBO NO = extra scrutiny, SEND only if floor 0.75+ with strong sust.
- BWC: verify edge is real and lead is secure.
- ANCHORED FLOOR CHECK: If team is TRAILING with floor 0.75+ but margin only 1-3 pts AND floor is declining, verify recent quarters still favor control team. Does NOT apply to leading teams (BWC/WB).
- Pay close attention to Monitor annotations on prior alerts. If a prior BUY was INVALIDATED by the monitor, be very skeptical of new BUY signals for the same team. If CONFIRMED, increase confidence.

Respond in EXACTLY this format:
DECISION: [SEND|SUPPRESS|DOWNGRADE]
REASONING: [1-2 sentences explaining why]
BODY: [If SEND/DOWNGRADE: enhanced alert body. If SUPPRESS: leave blank]`;
  }

  // ── API CALLER ──────────────────────────────────────────────────────────

  async function callMonitor(ctx) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1200, messages: [{ role: 'user', content: buildMonitorPrompt(ctx) }] }),
    });
    if (!resp.ok) return { error: 'API ' + resp.status };
    const data = await resp.json();
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    return { text, tokens: data.usage };
  }

  async function callAlertAgent(ctx) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 500, messages: [{ role: 'user', content: buildAlertAgentPrompt(ctx) }] }),
    });
    if (!resp.ok) return { decision: 'ERROR', reasoning: 'API ' + resp.status };
    const data = await resp.json();
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const dm = text.match(/DECISION:\s*(SEND|SUPPRESS|DOWNGRADE)/i);
    const rm = text.match(/REASONING:\s*(.+?)(?:\n|$)/i);
    return { decision: dm ? dm[1].toUpperCase() : 'PARSE_FAIL', reasoning: rm ? rm[1].trim() : text.substring(0, 150), tokens: data.usage };
  }

  // ── PARSERS ─────────────────────────────────────────────────────────────

  function parseMonitorPositions(text) {
    var results = [];
    // Split on any variation: ALERT_ID, Alert ID, **ALERT_ID**, etc.
    var blocks = text.split(/(?=(?:\*{0,2})ALERT[_ ]ID(?:\*{0,2})\s*:)/i);
    blocks.forEach(block => {
      // Match: ALERT_ID: 200, Alert ID: #200, **ALERT_ID:** 200, etc.
      var idMatch = block.match(/ALERT[_ ]ID\s*(?:\*{0,2})\s*:\s*#?(\d+)/i);
      var statusMatch = block.match(/STATUS\s*(?:\*{0,2})\s*:\s*(?:\*{0,2})\s*(TRACKING|CONFIRMED|FADING|INVALIDATED|ESCALATING|STABILIZED|RESOLVED)/i);
      var notifyMatch = block.match(/NOTIFY\s*(?:\*{0,2})\s*:\s*(?:\*{0,2})\s*(YES|NO)/i);
      var reasonMatch = block.match(/REASONING\s*(?:\*{0,2})\s*:\s*(.+?)(?:\n|$)/i);
      if (idMatch && statusMatch) {
        results.push({
          alertId: parseInt(idMatch[1]),
          status: statusMatch[1].toUpperCase(),
          notify: notifyMatch ? notifyMatch[1].toUpperCase() === 'YES' : false,
          reasoning: reasonMatch ? reasonMatch[1].trim() : '',
        });
      }
    });
    return results;
  }

  function parseEmerging(text) {
    var results = [];
    var blocks = text.split(/(?=(?:\*{0,2})EMERGING[_ ]GAME(?:\*{0,2})\s*:)/i);
    blocks.forEach(block => {
      var gameMatch = block.match(/EMERGING[_ ]GAME\s*(?:\*{0,2})\s*:\s*(.+?)(?:\n|$)/i);
      var signalMatch = block.match(/EMERGING[_ ]SIGNAL\s*(?:\*{0,2})\s*:\s*(?:\*{0,2})\s*(MOMENTUM|CONVERGENCE|SUSTAINABILITY_CASCADE|RELATIVE_VALUE|FLOOR_MARGIN_DIVERGENCE)/i);
      var confMatch = block.match(/EMERGING[_ ]CONFIDENCE\s*(?:\*{0,2})\s*:\s*(?:\*{0,2})\s*(LOW|MODERATE|HIGH)/i);
      var eNotify = block.match(/EMERGING[_ ]NOTIFY\s*(?:\*{0,2})\s*:\s*(?:\*{0,2})\s*(YES|NO)/i);
      if (gameMatch && signalMatch) {
        results.push({
          matchup: gameMatch[1].trim(),
          signal: signalMatch[1].toUpperCase(),
          confidence: confMatch ? confMatch[1].toUpperCase() : 'LOW',
          notify: eNotify ? eNotify[1].toUpperCase() === 'YES' : false,
        });
      }
    });
    return results;
  }

  // ── SCENARIOS ───────────────────────────────────────────────────────────

  const scenarios = {

    // ── POSITION TRACKING ──────────────────────────────────────────────

    '1': {
      name: 'BUY team took the lead — should CONFIRM',
      type: 'monitor',
      expected: { alertId: 200, status: 'CONFIRMED', notify: true },
      ctx: {
        activeAlerts: [{
          alertId: 200, gameId: 'g1', matchup: 'SAC@DEN', alertType: 'BUY', alertTier: 'FIRED',
          controlTeam: 'SAC', floorAtAlert: 0.72, marginAtAlert: -8, edgeAtAlert: 22.5,
          mlAtAlert: '+350', convictionAtAlert: 'STRONG',
          periodAtAlert: 2, clockAtAlert: '4:30', minutesSinceSent: 14,
          currentFloor: 0.70, currentMargin: 3, currentPeriod: 3, currentClock: '6:22',
          currentI4: 0.68, currentTpClass: null, currentLsClass: 'CUSHIONED',
          floorTrajectory: [0.72, 0.71, 0.69, 0.70, 0.70],
          controlTeamLeading: true, tookLead: true, lostLead: false,
        }],
        leadThreats: [],
        liveGames: [
          { gameId: 'g1', matchup: 'SAC@DEN', floor: 0.70, controlTeam: 'SAC', margin: 3, period: 3, clock: '6:22', hasActiveAlert: true },
        ],
        emergingCandidates: [],
      },
    },

    '2': {
      name: 'BUY floor collapsing + I4 flipped — should INVALIDATE',
      type: 'monitor',
      expected: { alertId: 210, status: 'INVALIDATED', notify: true },
      ctx: {
        activeAlerts: [{
          alertId: 210, gameId: 'g2', matchup: 'MIA@BOS', alertType: 'BUY', alertTier: 'FIRED',
          controlTeam: 'MIA', floorAtAlert: 0.68, marginAtAlert: -5, edgeAtAlert: 15.0,
          mlAtAlert: '+220', convictionAtAlert: 'STRONG',
          periodAtAlert: 2, clockAtAlert: '8:00', minutesSinceSent: 20,
          currentFloor: 0.42, currentMargin: -16, currentPeriod: 3, currentClock: '2:15',
          currentI4: 0.30, currentTpClass: 'NO PATH', currentLsClass: null,
          floorTrajectory: [0.68, 0.62, 0.55, 0.48, 0.42],
          controlTeamLeading: false, tookLead: false, lostLead: false,
        }],
        leadThreats: [],
        liveGames: [
          { gameId: 'g2', matchup: 'MIA@BOS', floor: 0.42, controlTeam: 'MIA', margin: -16, period: 3, clock: '2:15', hasActiveAlert: true },
        ],
        emergingCandidates: [],
      },
    },

    '3': {
      name: 'BUY floor declining gradually — should FADE',
      type: 'monitor',
      expected: { alertId: 220, status: 'FADING', notify: true },
      ctx: {
        activeAlerts: [{
          alertId: 220, gameId: 'g3', matchup: 'DAL@LAC', alertType: 'BUY', alertTier: 'FIRED',
          controlTeam: 'DAL', floorAtAlert: 0.72, marginAtAlert: -6, edgeAtAlert: 18.0,
          mlAtAlert: '+280', convictionAtAlert: 'STRONG',
          periodAtAlert: 2, clockAtAlert: '6:00', minutesSinceSent: 15,
          currentFloor: 0.56, currentMargin: -10, currentPeriod: 3, currentClock: '4:00',
          currentI4: 0.52, currentTpClass: 'CONTESTED', currentLsClass: null,
          floorTrajectory: [0.72, 0.68, 0.64, 0.60, 0.56],
          controlTeamLeading: false, tookLead: false, lostLead: false,
        }],
        leadThreats: [],
        liveGames: [
          { gameId: 'g3', matchup: 'DAL@LAC', floor: 0.56, controlTeam: 'DAL', margin: -10, period: 3, clock: '4:00', hasActiveAlert: true },
        ],
        emergingCandidates: [],
      },
    },

    '4': {
      name: 'BUY stable, no change — should TRACK with NOTIFY=NO',
      type: 'monitor',
      expected: { alertId: 230, status: 'TRACKING', notify: false },
      ctx: {
        activeAlerts: [{
          alertId: 230, gameId: 'g4', matchup: 'PHX@GSW', alertType: 'BUY', alertTier: 'FIRED',
          controlTeam: 'PHX', floorAtAlert: 0.67, marginAtAlert: -4, edgeAtAlert: 12.0,
          mlAtAlert: '+180', convictionAtAlert: 'STRONG',
          periodAtAlert: 3, clockAtAlert: '8:00', minutesSinceSent: 5,
          currentFloor: 0.66, currentMargin: -3, currentPeriod: 3, currentClock: '5:30',
          currentI4: 0.65, currentTpClass: 'PROBABLE', currentLsClass: null,
          floorTrajectory: [0.67, 0.67, 0.66, 0.66],
          controlTeamLeading: false, tookLead: false, lostLead: false,
        }],
        leadThreats: [],
        liveGames: [
          { gameId: 'g4', matchup: 'PHX@GSW', floor: 0.66, controlTeam: 'PHX', margin: -3, period: 3, clock: '5:30', hasActiveAlert: true },
        ],
        emergingCandidates: [],
      },
    },

    // ── LEAD THREAT ────────────────────────────────────────────────────

    '5': {
      name: 'LEAD CRUMBLING but lead grew back — should STABILIZE',
      type: 'monitor',
      expected: { alertId: 240, status: 'STABILIZED', notify: true },
      ctx: {
        activeAlerts: [],
        leadThreats: [{
          alertId: 240, gameId: 'g5', matchup: 'CLE@ORL', alertType: 'LEAD CRUMBLING',
          controlTeam: 'CLE', marginAtAlert: 8, currentMargin: 14,
          lsAtAlert: 'AT RISK', currentLsClass: 'SAFE', minutesSinceSent: 8,
        }],
        liveGames: [
          { gameId: 'g5', matchup: 'CLE@ORL', floor: 0.75, controlTeam: 'CLE', margin: 14, period: 4, clock: '4:00', hasActiveAlert: false },
        ],
        emergingCandidates: [],
      },
    },

    // ── EMERGING MOMENTUM ──────────────────────────────────────────────

    '6': {
      name: 'Floor rising steadily 4+ snapshots — should flag MOMENTUM',
      type: 'monitor',
      expected: { emergingSignal: 'MOMENTUM', emergingMatchup: 'MEM@NOP' },
      ctx: {
        activeAlerts: [],
        leadThreats: [],
        liveGames: [
          { gameId: 'g6', matchup: 'MEM@NOP', floor: 0.63, controlTeam: 'MEM', margin: -5, period: 3, clock: '6:00', hasActiveAlert: false },
          { gameId: 'g7', matchup: 'ATL@IND', floor: 0.52, controlTeam: 'ATL', margin: 1, period: 2, clock: '4:00', hasActiveAlert: false },
        ],
        emergingCandidates: [{
          gameId: 'g6', matchup: 'MEM@NOP', floor: 0.63, controlTeam: 'MEM',
          margin: -5, period: 3, clock: '6:00',
          i4: 0.72, floorTrajectory: [0.45, 0.49, 0.53, 0.58, 0.63],
        }, {
          gameId: 'g7', matchup: 'ATL@IND', floor: 0.52, controlTeam: 'ATL',
          margin: 1, period: 2, clock: '4:00',
          i4: 0.50, floorTrajectory: [0.50, 0.51, 0.52, 0.52],
        }],
      },
    },

    // ── ALERT AGENT INTEGRATION: monitor context changes agent behavior ──

    '7': {
      name: 'Alert agent: CANDIDATE BUY after prior BUY was INVALIDATED — should SUPPRESS',
      type: 'alertagent',
      expected: 'SUPPRESS',
      ctx: {
        alertType: 'BUY', alertTier: 'CANDIDATE', controlTeam: 'MIA', floor: '0.58', margin: 8, isTrailing: true,
        period: 4, clock: '6:00', minsLeft: '6.0', convictionTier: 'CONDITIONAL', convictionCombo: 'I1',
        convictionPairs: '', edge: 8, ml: '+250', spread: '+6.5',
        tpClass: 'CONTESTED', lsClass: null, ctrlSust: 'MIXED', oppSust: 'DURABLE',
        i1: '0.65', i2: '0.45', i3: '0.40', i4: '0.38', i5: '0.50',
        indicatorsWon: 1, indWon: 'I1', indLost: 'I3+I4',
        i4Decisive: true, i4Won: false, i4Combo: false,
        floorHistory: 'Q4 8:00: MIA 0.55 (78-88) TP:CONTESTED\nQ3 6:00: MIA 0.48 (62-76) TP:UNLIKELY\nQ3 12:00: MIA 0.42 (52-68) TP:NO PATH',
        priorAlerts: 'BUY[FIRED] Q2 8:00: floor 0.68, margin 5 trailing, sust DURABLE/FRAGILE, conv STRONG(I3+I4) → SEND\n  └── Monitor: INVALIDATED — floor collapsed to 0.42, I4 flipped decisively to BOS, structural thesis broken\nAUTO_ANALYSIS[ANALYSIS] Q3 12:00: floor 0.42, margin 16 trailing → SEND: BOS has seized structural control',
        quarterSummary: 'Q1: 28-24 pts, paint 16-10, TO 2-4\nQ2: 24-18 pts\nQ3: 14-30 pts (BOS takeover)\nQ4: 12-14 pts',
      },
    },
  };

  // ── TEST RUNNER ─────────────────────────────────────────────────────────

  let testKeys = [];
  if (testParam === 'all') testKeys = Object.keys(scenarios);
  else if (testParam === 'positions') testKeys = ['1', '2', '3', '4'];
  else if (testParam === 'threats') testKeys = ['5'];
  else if (testParam === 'emerging') testKeys = ['6'];
  else if (testParam === 'alertagent') testKeys = ['7'];
  else if (scenarios[testParam]) testKeys = [testParam];
  else return new Response(JSON.stringify({ error: 'Unknown test: ' + testParam }));

  const results = [];
  for (const key of testKeys) {
    const s = scenarios[key];
    console.log('Test ' + key + ': ' + s.name);

    if (s.type === 'alertagent') {
      // Alert agent integration test
      const r = await callAlertAgent(s.ctx);
      results.push({
        test: key, name: s.name, type: 'alertagent',
        expected: s.expected, actual: r.decision,
        pass: r.decision === s.expected ? 'PASS' : 'FAIL',
        reasoning: r.reasoning,
        tokens: r.tokens ? r.tokens.input_tokens + 'in/' + r.tokens.output_tokens + 'out' : '?',
      });
    } else {
      // Monitor test
      const r = await callMonitor(s.ctx);
      if (r.error) {
        results.push({ test: key, name: s.name, type: 'monitor', pass: 'ERROR', error: r.error });
        continue;
      }

      const positions = parseMonitorPositions(r.text);
      const emerging = parseEmerging(r.text);

      let pass = 'FAIL';
      let actual = '';
      let reasoning = '';

      if (s.expected.alertId) {
        // Position/threat test — match by alertId
        const match = positions.find(p => p.alertId === s.expected.alertId);
        if (match) {
          const statusOk = match.status === s.expected.status;
          const notifyOk = match.notify === s.expected.notify;
          pass = statusOk && notifyOk ? 'PASS' : 'FAIL';
          actual = `${match.status} notify=${match.notify}`;
          reasoning = match.reasoning;
        } else {
          actual = 'Alert ID not found in response';
          // Dump raw text and parsed positions for debugging
          reasoning = 'Raw: ' + r.text.substring(0, 500);
        }
      } else if (s.expected.emergingSignal) {
        // Emerging test — match by signal type
        const match = emerging.find(e => e.signal === s.expected.emergingSignal
          && e.matchup.includes(s.expected.emergingMatchup.split('@')[0]));
        if (match) {
          pass = match.confidence !== 'LOW' ? 'PASS' : 'FAIL';
          actual = `${match.signal} ${match.confidence} notify=${match.notify}`;
        } else {
          actual = 'Emerging signal not found';
          reasoning = 'Raw: ' + r.text.substring(0, 500);
        }
      }

      results.push({
        test: key, name: s.name, type: 'monitor',
        expected: s.expected.alertId
          ? `${s.expected.status} notify=${s.expected.notify}`
          : `${s.expected.emergingSignal}`,
        actual,
        pass,
        reasoning,
        tokens: r.tokens ? r.tokens.input_tokens + 'in/' + r.tokens.output_tokens + 'out' : '?',
      });
    }

    if (testKeys.length > 1) await new Promise(r => setTimeout(r, 500));
  }

  return new Response(JSON.stringify({
    summary: results.filter(r => r.pass === 'PASS').length + '/' + results.length + ' passed',
    results,
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}

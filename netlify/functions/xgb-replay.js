// xgb-replay.js — XGB Agent Replay Test
// Hit: /.netlify/functions/xgb-replay
// Runs Opus on DEN vs MIN Q4 5:54 POSITION_OPEN with and without XGB context
// Compares decisions to test whether XGB data changes agent behavior

export default async function handler(req) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return new Response(JSON.stringify({ error: 'No API key' }), { status: 500 });

  const url = new URL(req.url, 'https://x.com');
  const testParam = url.searchParams.get('test') || 'all'; // 'po', 'bwc', 'all'

  async function callOpus(prompt) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!resp.ok) return { decision: 'ERROR', reasoning: 'API ' + resp.status + ': ' + (await resp.text()).substring(0, 200) };
    const data = await resp.json();
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const dm = text.match(/DECISION:\s*(SEND|SUPPRESS|DOWNGRADE)/i);
    const rm = text.match(/REASONING:\s*([\s\S]*?)(?:\nBODY:|$)/i);
    const bm = text.match(/BODY:\s*([\s\S]*)/i);
    return {
      decision: dm ? dm[1].toUpperCase() : 'PARSE_FAIL',
      reasoning: rm ? rm[1].trim() : text.substring(0, 300),
      body: bm ? bm[1].trim() : '',
      tokens: data.usage,
      raw: text,
    };
  }

  function buildPrompt(alertType, xgbBlock) {
    const isPO = alertType === 'POSITION_OPEN';
    const margin = isPO ? 3 : 1;
    const clock = isPO ? '5:54' : '5:32';
    const homePts = 107;
    const awayPts = isPO ? 104 : 106;
    const bwcState = isPO ? 'LOCK' : 'EDGE';
    const lsClass = isPO ? 'SAFE' : 'N/A';
    const windowScore = isPO ? '0.57' : '0.53';
    const combinedRead = isPO ? 'SHIFT' : 'COLLAPSING';
    const edge = isPO ? '1.1' : '3.3';
    const ml = isPO ? '-315' : '-280';

    const xgbSection = xgbBlock ? `
XGBOOST STRUCTURAL MODEL (independent — trained on raw stats, does NOT use floor/indicators/margin):
XGB win probability: ${(xgbBlock.prob * 100).toFixed(1)}% | Floor: 77.0% | ⚠️ DIVERGENT (${(xgbBlock.divergence * 100).toFixed(1)}%)
SHAP drivers (what raw stats push XGB prediction): ${xgbBlock.shap}
WARNING: XGBoost sees ${xgbBlock.prob < 0.50 ? '< 50%' : (xgbBlock.prob * 100).toFixed(0) + '%'} win probability from raw stats despite floor at 0.77. Raw production data does NOT confirm structural dominance.` : '';

    return `You are a live NBA betting alert quality agent. A mechanical system has identified a potential betting signal. Your job is to assess whether it should be sent to the bettor.

ALERT:
Type: ${alertType} (FIRED)
Control team: DEN | Floor: 0.77 | Margin: ${margin} (leading)
Score: MIN ${awayPts} - DEN ${homePts} (DEN is HOME)
Period: Q4 ${clock}
BWC team (subscriber position): DEN

INDICATORS (control-team-relative):
I1 Disruption: 0 | I2 Interior: 1 | I3 Shot Quality: 1 | I4 Game Control: 1 | I5 Execution: 0.5
Indicators won: I2, I3, I4 (3/5)
Conviction: STRONG (I2+I3+I4)
Ctrl sust: LOCKED IN | Opp sust: DURABLE
TP: N/A | LS: ${lsClass}

OPPONENT PROFILE:
Opponent indicators won: 1 (I1 — disruption)
WARNING: Opponent structural counter-indicator (I1), not just variance.

POSITION HEALTH:
Peak floor: 0.77 | Mean floor: 0.68 | Current: 0.77
Erosion: STABLE (mean-anchored)
Conviction trend: HELD (CONDITIONAL → MODEST → STRONG — upgraded over game)
Consecutive holds: 37
BWC lifecycle: ${bwcState} (BWC fired Q3, floor 0.60)
Graduation: B-Rank (graduated @ Q4_6, floor was 0.77) | MF FLAT (0.68 → 0.60 → 0.77) delta=+0.005 | MF=0.683 minF=0.60 (3 eligible CPs)
Lane: heavy_favorite (pregame ML -315) | CP flips: 1 | Control flips (game total): 1

STRUCTURAL STRESS (rolling window vs cumulative — does the recent game agree with the floor?):
Window (Q3+Q4, ~32 poss): MIN ${windowScore}
  I1: 0.3 — MIN steals/TO advantage in recent quarters
  I2: 0.6 — DEN slight interior edge in window
  I3: 0.4 — MIN shooting better recently  
  I4: 0.5 — game control contested in window
  I5: 0.5 — pace even
Combined read: ${combinedRead}
${combinedRead === 'COLLAPSING' ? 'WARNING: Rolling window DISAGREES with cumulative floor. Recent quarters favor MIN. Cumulative indicators may be anchored from earlier quarters that no longer reflect game state.' : 'Rolling window shows MIN gaining but DEN cumulative edge still holds. Recent quarters contested.'}

Per-quarter breakdown:
  Q1 (DEN vs MIN): Paint DEN:20 MIN:10 | FT DEN:6/6 MIN:3/4 | 3P DEN:5/12 MIN:5/10 | AST DEN:8 MIN:5 | TO DEN:3 MIN:5 | STL DEN:3 MIN:1
  Q2 (DEN vs MIN): Paint DEN:16 MIN:16 | FT DEN:8/10 MIN:8/9 | 3P DEN:6/16 MIN:5/14 | AST DEN:12 MIN:14 | TO DEN:4 MIN:2 | STL DEN:0 MIN:3
  Q3 (DEN vs MIN): Paint DEN:14 MIN:14 | FT DEN:6/6 MIN:5/6 | 3P DEN:0/4 MIN:3/6 | AST DEN:7 MIN:7 | TO DEN:1 MIN:3 | STL DEN:1 MIN:3
  Q4 partial (DEN vs MIN): Paint DEN:0 MIN:6 | FT DEN:6/6 MIN:8/9 | TO even | STL MIN:2 DEN:0

STRUCTURE-SCORE RELATIONSHIP:
Floor trend: RISING | Margin trend: DECLINING | Signal: DIVERGING_NEGATIVE
Floor is rising but margin is shrinking — structure improving but not translating to scoreboard.
${xgbSection}

FLOOR TRAJECTORY (recent snapshots):
Q4 ${clock}: 0.77 (DEN) +${margin} | Q4 7:56: 0.77 +5 | Q4 8:51: 0.60 +1 | Q4 9:10: 0.60 +1 | Q3 0:00: 0.60 +3 | Q3 2:41: 0.68 +6 | Q3 6:21: 0.68 -2 | Q3 9:02: 0.68 -1

PRIOR ALERT REASONING TRAIL:
Q2 4:41 BUY CANDIDATE → SEND (treated as tracking — first structural signal for DEN)
Q3 10:23 TRACKING → SEND (DEN leading 3, floor 0.60, I4 only, CONDITIONAL)
Q3 9:02 BUY CANDIDATE → SUPPRESS (MODEST conviction I2+I4, opp holds I1 counter-indicator, TP UNLIKELY — structural case weak despite floor)
Q3 6:21 BUY FIRED → SUPPRESS (MODEST I2+I4, opp I1 structural counter, TP CONTESTED, weak structural case despite floor 0.68)
${isPO ? '' : 'Q4 5:54 POSITION_OPEN → SEND (B-Rank grad, 37 holds, SHIFT combined read — honest framing about contested window)\nQ4 5:54 POSITION_SAFE → SEND'}

RULES:
${isPO ? `- POSITION_OPEN: Graduated through checkpoint system — sustained structural rank confirmed.
  B-Rank: Sustained DOMINANT/STRONG conviction with lead 3+. MF FLAT across 3 checkpoints.
  1 CP flip — structural control briefly contested. Check: did the BWC team reclaim indicators that slipped?
  Lane: heavy_favorite — PO confirms structural read but line may offer limited edge. Frame as position confirmation, not direct entry.
  Also check: CP trend (all, unfiltered) gives the full trajectory including bad stretches. If eligible MF says RISING but full CP trend says DECLINING, graduation badge may overstate current control.` 
: `- BWC_EDGE: SEND by default — this is a position update for a subscriber already holding. Frame as reassurance with structural picture. MAY SUPPRESS if structural stress override applies (see STRUCTURAL STRESS CHECK below). MUST include a RISK line at the end — identify the ONE specific thing that could flip this position next.`}
- STRUCTURAL STRESS CHECK: When combined read is COLLAPSING, FLIPPED, or SHIFT, the cumulative floor may be anchored from earlier-quarter dominance that has since eroded. The rolling window shows who is winning RECENT quarters.
  For position alerts (POSITION_OPEN, BWC_EDGE): When the rolling window is SIGNIFICANTLY weaker than the cumulative floor, you MAY SUPPRESS or DOWNGRADE — this OVERRIDES per-alert-type ALWAYS SEND rules.
  DOWNGRADE is preferred over SUPPRESS for POSITION_OPEN (subscriber should know graduation happened but that it is contested).
  BWC_EDGE may fully SUPPRESS if structurally compromised.
${xgbBlock ? `- XGB REASONING (use SHAP drivers to interpret floor-XGB disagreements):
  DIVERGENT — XGB BELOW FLOOR: SHAP tells you why.
  • efg as primary negative driver → shooting variance. Cross-ref sustainability.
  • paint/fta/oreb as negative drivers → STRUCTURAL interior weakness. Cumulative floor may be anchoring past early-game dominance. Weight XGB heavily.
  • biglead negative = team hasn't converted structural control to scoreboard separation.
  • NEAR-ZERO FEATURES ARE DIAGNOSTIC: paint=0.00, oreb=0.00 means NO interior foundation in raw stats.
  DECISION GUIDANCE:
  • BWC/PO with XGB < 0.50 + paint/fta negative in SHAP: lean DOWNGRADE — interior dominance thesis failing in raw stats.
  • Floor > 0.70 AND XGB > 0.70: highest-conviction combined read. Both systems see dominance.
  • 1+ CP flips + XGB < 0.50: structural control repeatedly contested AND raw stats disagree. Lean SUPPRESS.` : ''}
- REASONING AS JOURNAL: Even when SUPPRESS, write thorough reasoning. It feeds subsequent decisions.

BODY RULES (read by non-technical bettors on their phone):
- Lead with score + action, explain WHY in basketball terms with structural data, end with what to watch.
- Translate indicators: I1=turnovers/steals, I2=paint/interior, I3=shot quality, I4=game flow, I5=pace/execution.
- 2-4 sentences max. Keep structural metrics but make them readable.

Respond in EXACTLY this format:
DECISION: [SEND|SUPPRESS|DOWNGRADE]
REASONING: [2-3 sentences]
BODY: [If SEND/DOWNGRADE: plain-English alert. If SUPPRESS: blank]`;
  }

  // XGB data computed from real raw_stats_json at these moments
  const xgbPO = {
    prob: 0.494,
    divergence: 0.494 - 0.77,
    shap: 'progress=+0.43, pot=-0.35, efg=-0.27, paint=-0.25, fta=-0.24',
  };
  const xgbBWC = {
    prob: 0.548,
    divergence: 0.548 - 0.77,
    shap: 'progress=+0.43, pot=-0.32, paint=-0.27, efg=-0.25, fta=-0.23',
  };

  const tests = [];

  if (testParam === 'all' || testParam === 'po') {
    // POSITION_OPEN without XGB
    console.log('Running PO without XGB...');
    const poNoXGB = await callOpus(buildPrompt('POSITION_OPEN', null));
    tests.push({ name: 'PO_NO_XGB', alert: 'Q4 5:54 POSITION_OPEN', ...poNoXGB });

    await new Promise(r => setTimeout(r, 1000));

    // POSITION_OPEN with XGB
    console.log('Running PO with XGB...');
    const poWithXGB = await callOpus(buildPrompt('POSITION_OPEN', xgbPO));
    tests.push({ name: 'PO_WITH_XGB', alert: 'Q4 5:54 POSITION_OPEN', ...poWithXGB });

    await new Promise(r => setTimeout(r, 1000));
  }

  if (testParam === 'all' || testParam === 'bwc') {
    // BWC_EDGE without XGB
    console.log('Running BWC without XGB...');
    const bwcNoXGB = await callOpus(buildPrompt('BWC_EDGE', null));
    tests.push({ name: 'BWC_NO_XGB', alert: 'Q4 5:32 BWC_EDGE', ...bwcNoXGB });

    await new Promise(r => setTimeout(r, 1000));

    // BWC_EDGE with XGB
    console.log('Running BWC with XGB...');
    const bwcWithXGB = await callOpus(buildPrompt('BWC_EDGE', xgbBWC));
    tests.push({ name: 'BWC_WITH_XGB', alert: 'Q4 5:32 BWC_EDGE', ...bwcWithXGB });
  }

  // Build comparison
  const comparisons = [];
  for (let i = 0; i < tests.length; i += 2) {
    if (i + 1 < tests.length) {
      comparisons.push({
        alert: tests[i].alert,
        without_xgb: { decision: tests[i].decision, reasoning: tests[i].reasoning },
        with_xgb: { decision: tests[i + 1].decision, reasoning: tests[i + 1].reasoning },
        decision_changed: tests[i].decision !== tests[i + 1].decision,
        actual_outcome: 'DEN LOST (MIN 119-114) — correct decision was SUPPRESS/DOWNGRADE',
      });
    }
  }

  return new Response(JSON.stringify({
    game: 'DEN vs MIN — Apr 20, 2026 — FINAL: MIN 119, DEN 114',
    model: 'claude-opus-4-6',
    xgb_context: {
      po: 'XGB 49.4%, floor 77%, divergence -27.6%, SHAP: progress=+0.43 pot=-0.35 efg=-0.27 paint=-0.25 fta=-0.24',
      bwc: 'XGB 54.8%, floor 77%, divergence -22.2%, SHAP: progress=+0.43 pot=-0.32 paint=-0.27 efg=-0.25 fta=-0.23',
    },
    comparisons,
    full_results: tests.map(t => ({
      name: t.name, alert: t.alert, decision: t.decision,
      reasoning: t.reasoning,
      body: t.body?.substring(0, 300),
      tokens: t.tokens ? t.tokens.input_tokens + 'in/' + t.tokens.output_tokens + 'out' : '?',
    })),
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}

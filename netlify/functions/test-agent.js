// test-agent.js — Structured test of the alert reasoning agent
// Hit: /.netlify/functions/test-agent?test=all (default)
// Or:  ?test=1  ?test=2  etc. for individual scenarios
// Or:  ?test=fired  ?test=candidate  ?test=auto  for groups

export default async function handler(req) {
  const url = new URL(req.url, 'https://x.com');
  const testParam = url.searchParams.get('test') || 'all';
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return new Response(JSON.stringify({ error: 'No API key' }), { status: 500 });

  function buildPrompt(ctx) {
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
${ctx.learningsContext ? '\n' + ctx.learningsContext + '\n' : ''}
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

Respond in EXACTLY this format:
DECISION: [SEND|SUPPRESS|DOWNGRADE]
REASONING: [1-2 sentences explaining why]
BODY: [If SEND/DOWNGRADE: enhanced alert body. If SUPPRESS: leave blank]`;
  }

  async function callAgent(ctx) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 500, messages: [{ role: 'user', content: buildPrompt(ctx) }] }),
    });
    if (!resp.ok) return { decision: 'ERROR', reasoning: 'API ' + resp.status };
    const data = await resp.json();
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const dm = text.match(/DECISION:\s*(SEND|SUPPRESS|DOWNGRADE)/i);
    const rm = text.match(/REASONING:\s*(.+?)(?:\n|$)/i);
    return { decision: dm ? dm[1].toUpperCase() : 'PARSE_FAIL', reasoning: rm ? rm[1].trim() : text.substring(0, 150), tokens: data.usage };
  }

  const scenarios = {
    '1': { name: 'FIRED BUY Q3 + I4 COMBO YES (SAC-style)', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'FIRED', controlTeam:'SAC', floor:'0.73', margin:4, isTrailing:true,
      period:3, clock:'0:53', minsLeft:'12.9', convictionTier:'STRONG', convictionCombo:'I1+I4+I5', convictionPairs:'I4+I5',
      edge:38, ml:'+186', spread:'+4.5', tpClass:'STRONG RECOVERY', lsClass:null, ctrlSust:'MIXED', oppSust:'DURABLE',
      i1:'1.00', i2:'0.50', i3:'0.00', i4:'1.00', i5:'1.00', indicatorsWon:3, indWon:'I1+I4+I5', indLost:'I3',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 4:00: SAC 0.68 (78-82) TP:PROBABLE LS:?\nQ2 6:00: SAC 0.60 (52-60) TP:CONTESTED LS:?',
      priorAlerts:'BUY[CANDIDATE] Q3 0:24: floor 0.60, margin 4 trailing, conv STRONG(I1+I4) -> SEND',
      quarterSummary:'Q1: 28-36 pts, paint 18-10, TO 3-7\nQ2: 24-24 pts\nQ3: 26-22 pts, paint 14-8'
    }},
    '2': { name: 'CANDIDATE BUY Q2 + I4 COMBO YES (SAS-style)', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'CANDIDATE', controlTeam:'SAS', floor:'0.64', margin:1, isTrailing:true,
      period:2, clock:'1:38', minsLeft:'25.6', convictionTier:'STRONG', convictionCombo:'I2+I3+I4', convictionPairs:'I3+I4',
      edge:-30.1, ml:'-1600', spread:'-13.5', tpClass:'STRONG RECOVERY', lsClass:null, ctrlSust:'LOCKED IN', oppSust:'FRAGILE',
      i1:'0.50', i2:'0.80', i3:'0.75', i4:'0.90', i5:'0.50', indicatorsWon:3, indWon:'I2+I3+I4', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q2 4:00: SAS 0.60 (38-40) TP:PROBABLE LS:?\nQ1 6:00: SAS 0.55 (18-22) TP:CONTESTED LS:?',
      priorAlerts:'None', quarterSummary:'Q1: 18-22 pts, paint 12-8, TO 2-5\nQ2: 20-18 pts'
    }},
    '3': { name: 'CANDIDATE BUY Q2 + I4 COMBO NO, floor 0.58 (CLE-style)', expected: 'SUPPRESS', ctx: {
      alertType:'BUY', alertTier:'CANDIDATE', controlTeam:'CLE', floor:'0.58', margin:5, isTrailing:true,
      period:2, clock:'8:30', minsLeft:'32.5', convictionTier:'CONDITIONAL', convictionCombo:'I1', convictionPairs:'',
      edge:12, ml:'+180', spread:'+5.5', tpClass:'CONTESTED', lsClass:null, ctrlSust:'COLD', oppSust:'LOCKED IN',
      i1:'0.70', i2:'0.45', i3:'0.40', i4:'0.30', i5:'0.50', indicatorsWon:1, indWon:'I1', indLost:'I2+I3+I4',
      i4Decisive:true, i4Won:false, i4Combo:false,
      floorHistory:'Q2 10:00: CLE 0.55 (22-28) TP:CONTESTED LS:?',
      priorAlerts:'None', quarterSummary:'Q1: 22-28 pts, paint 10-16, TO 5-2'
    }},
    '4': { name: 'FIRED BWC + declining floor + LS AT RISK', expected: 'DOWNGRADE', ctx: {
      alertType:'BUY WINDOW CLOSING', alertTier:'FIRED', controlTeam:'DEN', floor:'0.65', margin:6, isTrailing:false,
      period:4, clock:'8:00', minsLeft:'8.0', convictionTier:'MODEST', convictionCombo:'I1+I2', convictionPairs:'',
      edge:5.2, ml:'-220', spread:'-5.5', tpClass:null, lsClass:'AT RISK', ctrlSust:'FRAGILE', oppSust:'DURABLE',
      i1:'0.70', i2:'0.65', i3:'0.45', i4:'0.40', i5:'0.50', indicatorsWon:2, indWon:'I1+I2', indLost:'I3+I4',
      i4Decisive:true, i4Won:false, i4Combo:false,
      floorHistory:'Q4 12:00: DEN 0.72 (88-82) LS:CUSHIONED\nQ3 6:00: DEN 0.78 (72-64) LS:SAFE\nQ3 12:00: DEN 0.80 (56-48) LS:SAFE',
      priorAlerts:'BWC[FIRED] Q3 12:00: floor 0.80, margin 8 leading -> SEND\nLEAD CRUMBLING Q4 10:00: floor 0.68, margin 4',
      quarterSummary:'Q1: 28-24\nQ2: 28-24\nQ3: 16-24 pts (opponent surge)\nQ4: 12-18 pts'
    }},
    '5': { name: 'AUTO_ANALYSIS Q3 with prior Q2 analysis (cross-alert)', expected: 'SEND', ctx: {
      alertType:'AUTO_ANALYSIS', alertTier:'ANALYSIS', controlTeam:'ORL', floor:'0.83', margin:5, isTrailing:false,
      period:3, clock:'12:00', minsLeft:'12.0', convictionTier:'DOMINANT', convictionCombo:'I1+I2+I3+I4', convictionPairs:'I3+I4',
      edge:18.5, ml:'-280', spread:'-6.5', tpClass:null, lsClass:'SAFE', ctrlSust:'LOCKED IN', oppSust:'FRAGILE',
      i1:'0.85', i2:'0.90', i3:'0.80', i4:'0.95', i5:'0.70', indicatorsWon:5, indWon:'I1+I2+I3+I4+I5', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q2 6:00: ORL 0.78 (48-44) LS:CUSHIONED\nQ2 12:00: ORL 0.72 (28-26) LS:CUSHIONED',
      priorAlerts:'AUTO_ANALYSIS[ANALYSIS] Q2 12:00: floor 0.72, margin 2 leading, sust LOCKED IN/FRAGILE, conv STRONG(I1+I3+I4) -> SEND: ORL dominant control, opponent unsustainable',
      quarterSummary:'Q1: 28-26 pts, paint 18-10, TO 2-5\nQ2: 20-18 pts'
    }},
    '6': { name: 'CANDIDATE WINDOW BUY floor 0.83 (ORL missed case fix)', expected: 'SEND', ctx: {
      alertType:'WINDOW BUY', alertTier:'CANDIDATE', controlTeam:'ORL', floor:'0.83', margin:3, isTrailing:false,
      period:2, clock:'3:09', minsLeft:'27.2', convictionTier:'STRONG', convictionCombo:'I1+I3+I4', convictionPairs:'I3+I4',
      edge:15, ml:'-350', spread:'-8', tpClass:null, lsClass:'CUSHIONED', ctrlSust:'LOCKED IN', oppSust:'FRAGILE',
      i1:'0.80', i2:'0.50', i3:'0.75', i4:'0.90', i5:'0.50', indicatorsWon:3, indWon:'I1+I3+I4', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q2 6:00: ORL 0.78 (38-36) LS:CUSHIONED\nQ1 6:00: ORL 0.70 (18-16)',
      priorAlerts:'None', quarterSummary:'Q1: 28-26 pts, paint 18-10, TO 2-5\nQ2: 10-10 pts'
    }},
    '7': { name: 'FIRED BUY Q3 with learnings loop active', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'FIRED', controlTeam:'MEM', floor:'0.70', margin:8, isTrailing:true,
      period:3, clock:'6:00', minsLeft:'18.0', convictionTier:'STRONG', convictionCombo:'I3+I4', convictionPairs:'I3+I4',
      edge:22, ml:'+280', spread:'+6.5', tpClass:'PROBABLE', lsClass:null, ctrlSust:'DURABLE', oppSust:'FRAGILE',
      i1:'0.50', i2:'0.60', i3:'0.80', i4:'0.85', i5:'0.50', indicatorsWon:3, indWon:'I2+I3+I4', indLost:'I1',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 9:00: MEM 0.68 (62-70) TP:PROBABLE\nQ2 6:00: MEM 0.65 (44-52) TP:CONTESTED',
      priorAlerts:'RECOVERY PATH Q2 6:00: floor 0.65, margin 8 trailing, sust DURABLE/FRAGILE -> SEND',
      quarterSummary:'Q1: 24-30\nQ2: 20-22\nQ3: 18-18',
      learningsContext:'NIGHTLY RESULTS (last 3 nights):\n2026-04-12: 92% | BUY:5/5 BWC:2/3 | saves:4 missed:1\n2026-04-11: 88% | BUY:3/4 WB:2/2 | saves:6 missed:2\n2026-04-10: 100% | BUY:3/3 BWC:11/11 | saves:1 missed:6\n\nPATTERNS:\nI4 COMBO YES alerts hitting at 98% across all tiers\n\nRECOMMENDATIONS:\nI4 COMBO YES should be near-automatic SEND regardless of tier'
    }},
  };

  let testKeys = [];
  if (testParam === 'all') testKeys = Object.keys(scenarios);
  else if (testParam === 'fired') testKeys = ['1', '4', '7'];
  else if (testParam === 'candidate') testKeys = ['2', '3', '6'];
  else if (testParam === 'auto') testKeys = ['5'];
  else if (scenarios[testParam]) testKeys = [testParam];
  else return new Response(JSON.stringify({ error: 'Unknown test: ' + testParam }));

  const results = [];
  for (const key of testKeys) {
    const s = scenarios[key];
    console.log('Test ' + key + ': ' + s.name);
    const r = await callAgent(s.ctx);
    results.push({
      test: key, name: s.name, expected: s.expected, actual: r.decision,
      pass: r.decision === s.expected ? 'PASS' : 'FAIL',
      reasoning: r.reasoning,
      tokens: r.tokens ? r.tokens.input_tokens + 'in/' + r.tokens.output_tokens + 'out' : '?',
    });
    if (testKeys.length > 1) await new Promise(r => setTimeout(r, 500));
  }

  return new Response(JSON.stringify({
    summary: results.filter(r => r.pass === 'PASS').length + '/' + results.length + ' passed',
    results,
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}

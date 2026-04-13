// test-agent.js — Structured test of the alert reasoning agent
// Hit: /.netlify/functions/test-agent?test=all (default)
// Or:  ?test=1  ?test=2  etc. for individual scenarios
// Or:  ?test=fired  ?test=candidate  ?test=auto  ?test=new  for groups

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
${ctx.learningsContext ? '\n' + ctx.learningsContext + '\n' : ''}${ctx.priorPosition ? `
POSITION UPDATE CONTEXT:
This is a position update for a previously sent alert — NOT a new signal.
Prior alert: ${ctx.priorPosition.alertType} for ${ctx.priorPosition.controlTeam} at Q${ctx.priorPosition.period} ${ctx.priorPosition.clock} (${ctx.priorPosition.minutesSince} min ago)
  Floor then: ${ctx.priorPosition.floor} -> now: ${ctx.floor} | Margin then: ${ctx.priorPosition.margin} -> now: ${ctx.margin}
  Conviction then: ${ctx.priorPosition.conviction || 'N/A'}(${ctx.priorPosition.combo || 'N/A'}) -> now: ${ctx.convictionTier}(${ctx.convictionCombo})
  Sust then: ${ctx.priorPosition.ctrlSust || 'N/A'}/${ctx.priorPosition.oppSust || 'N/A'} -> now: ${ctx.ctrlSust}/${ctx.oppSust}
  Control team ${ctx.priorPosition.sameTeam ? 'UNCHANGED' : 'SHIFTED — was ' + ctx.priorPosition.controlTeam + ', now ' + ctx.controlTeam}

YOUR JOB: Assess whether the prior position is HOLDING, IMPROVING, or DETERIORATING.
- SEND if meaningful new info the bettor should know: floor shift >0.10, conviction upgrade/downgrade, lead expanding/contracting significantly, sustainability flip, or control team change
- SUPPRESS if conditions essentially unchanged — do not spam "still winning" updates
- If control team SHIFTED from the prior alert: this is critical info, strongly favor SEND to warn the bettor
- Your BODY must reference the prior alert and explain what changed. Lead with the position status.
` : ''}
RULES:
- FIRED alerts: SEND unless clear structural contradiction. I4 COMBO YES = SEND. I4 COMBO NO = SUPPRESS unless 4/5 indicators. I1+I2 only = effort-based, DOWNGRADE. Floor trending DOWN = consider SUPPRESS.
- CANDIDATE alerts: SEND only if structural case is compelling.
- CANDIDATE BUYs floor 0.55-0.65: only SEND if I4 COMBO YES.
- CANDIDATE BUYs with negative ML (heavy favorite trailing): CANDIDATE tier reflects the ML gate, NOT structural weakness. Evaluate as if FIRED — I4 COMBO YES + STRONG conviction = SEND for line shopping. Note heavy ML in BODY.
- BWC + I4 EVEN: NOT a suppress signal when 3+ indicators + LOCKED IN/DURABLE/COLD sust.
- ANCHORED FLOOR CHECK: trailing 0.75+ but margin 1-3 with declining floor = verify. Does NOT apply to leading teams.
- EARLY GAME (Q1-Q2): I4 COMBO YES = SEND. I4 COMBO NO = extra scrutiny.
- TP (Throughput Projection) is context, not a veto. It estimates deficit recovery from structural rates. Limitation: anchored to cumulative stats, misses momentum shifts. TP NO PATH at 1-3 point deficits is often a false negative. TP STRONG/PROBABLE adds confidence. TP UNLIKELY/NO PATH is a caution flag, not a stop sign.
- RECOVERY PATH: math projects a comeback. SEND if structural indicators (especially I4) back the TP math — I4 COMBO YES + rising floor means the engine is real. SUPPRESS if TP is anchored from early-game cumulative stats that have since eroded — floor declining + I4 COMBO NO means the opponent actually has game control despite favorable TP math.
- LEAD CRUMBLING: warning that a structural team's lead is vulnerable. SEND if floor is declining AND sustainability is shifting AND indicator count is dropping — real structural erosion. SUPPRESS if I4 still favors control team, sustainability holds, and LS AT RISK is from a hot opponent run (noise), not structural collapse.
- VARIANCE BREAKING: opponent's shooting is regressing. SEND if structural edge is clear (I4 COMBO YES, 3+ indicators) and the sustainability shift is meaningful. SUPPRESS if structural edge is thin (I4 EVEN, 1-2 indicators) or the sustainability drop is a borderline tier flip.

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
    // ═══ EXISTING SCENARIOS (1-10) ═══
    '1': { name: 'FIRED BUY Q3 I4 COMBO YES (SAC-style)', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'FIRED', controlTeam:'SAC', floor:'0.73', margin:4, isTrailing:true,
      period:3, clock:'0:53', minsLeft:'12.9', convictionTier:'STRONG', convictionCombo:'I1+I4+I5', convictionPairs:'I4+I5',
      edge:38, ml:'+186', spread:'+4.5', tpClass:'STRONG RECOVERY', lsClass:null, ctrlSust:'MIXED', oppSust:'DURABLE',
      i1:'1.00', i2:'0.50', i3:'0.00', i4:'1.00', i5:'1.00', indicatorsWon:3, indWon:'I1+I4+I5', indLost:'I3',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 4:00: SAC 0.68 (78-82) TP:PROBABLE\nQ2 6:00: SAC 0.60 (52-60) TP:CONTESTED',
      priorAlerts:'BUY[CANDIDATE] Q3 0:24: floor 0.60, margin 4 trailing -> SEND',
      quarterSummary:'Q1: 28-36\nQ2: 24-24\nQ3: 26-22, paint 14-8'
    }},
    '2': { name: 'CANDIDATE BUY Q2 I4 COMBO YES (SAS-style)', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'CANDIDATE', controlTeam:'SAS', floor:'0.64', margin:1, isTrailing:true,
      period:2, clock:'1:38', minsLeft:'25.6', convictionTier:'STRONG', convictionCombo:'I2+I3+I4', convictionPairs:'I3+I4',
      edge:-30.1, ml:'-1600', spread:'-13.5', tpClass:'STRONG RECOVERY', lsClass:null, ctrlSust:'LOCKED IN', oppSust:'FRAGILE',
      i1:'0.50', i2:'0.80', i3:'0.75', i4:'0.90', i5:'0.50', indicatorsWon:3, indWon:'I2+I3+I4', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q2 4:00: SAS 0.60 (38-40) TP:PROBABLE\nQ1 6:00: SAS 0.55 (18-22)',
      priorAlerts:'None', quarterSummary:'Q1: 18-22, paint 12-8\nQ2: 20-18'
    }},
    '3': { name: 'CANDIDATE BUY Q2 I4 COMBO NO floor 0.58', expected: 'SUPPRESS', ctx: {
      alertType:'BUY', alertTier:'CANDIDATE', controlTeam:'CLE', floor:'0.58', margin:5, isTrailing:true,
      period:2, clock:'8:30', minsLeft:'32.5', convictionTier:'CONDITIONAL', convictionCombo:'I1', convictionPairs:'',
      edge:12, ml:'+180', spread:'+5.5', tpClass:'CONTESTED', lsClass:null, ctrlSust:'COLD', oppSust:'LOCKED IN',
      i1:'0.70', i2:'0.45', i3:'0.40', i4:'0.30', i5:'0.50', indicatorsWon:1, indWon:'I1', indLost:'I2+I3+I4',
      i4Decisive:true, i4Won:false, i4Combo:false,
      floorHistory:'Q2 10:00: CLE 0.55 (22-28)',
      priorAlerts:'None', quarterSummary:'Q1: 22-28, paint 10-16'
    }},
    '4': { name: 'FIRED BWC declining floor + LS AT RISK', expected: 'DOWNGRADE', ctx: {
      alertType:'BUY WINDOW CLOSING', alertTier:'FIRED', controlTeam:'DEN', floor:'0.65', margin:6, isTrailing:false,
      period:4, clock:'8:00', minsLeft:'8.0', convictionTier:'MODEST', convictionCombo:'I1+I2', convictionPairs:'',
      edge:5.2, ml:'-220', spread:'-5.5', tpClass:null, lsClass:'AT RISK', ctrlSust:'FRAGILE', oppSust:'DURABLE',
      i1:'0.70', i2:'0.65', i3:'0.45', i4:'0.40', i5:'0.50', indicatorsWon:2, indWon:'I1+I2', indLost:'I3+I4',
      i4Decisive:true, i4Won:false, i4Combo:false,
      floorHistory:'Q4 12:00: DEN 0.72 (88-82) LS:CUSHIONED\nQ3 6:00: DEN 0.78 (72-64) LS:SAFE\nQ3 12:00: DEN 0.80 (56-48) LS:SAFE',
      priorAlerts:'BWC[FIRED] Q3 12:00: floor 0.80, margin 8 -> SEND\nLEAD CRUMBLING Q4 10:00: floor 0.68, margin 4',
      quarterSummary:'Q1: 28-24\nQ2: 28-24\nQ3: 16-24\nQ4: 12-18'
    }},
    '5': { name: 'AUTO_ANALYSIS position update — BWC holding, floor improved', expected: 'SEND', ctx: {
      alertType:'AUTO_ANALYSIS', alertTier:'ANALYSIS', controlTeam:'ORL', floor:'0.83', margin:5, isTrailing:false,
      period:3, clock:'12:00', minsLeft:'12.0', convictionTier:'DOMINANT', convictionCombo:'I1+I2+I3+I4', convictionPairs:'I3+I4',
      edge:18.5, ml:'-280', spread:'-6.5', tpClass:null, lsClass:'SAFE', ctrlSust:'LOCKED IN', oppSust:'FRAGILE',
      i1:'0.85', i2:'0.90', i3:'0.80', i4:'0.95', i5:'0.70', indicatorsWon:5, indWon:'I1+I2+I3+I4+I5', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q2 6:00: ORL 0.78 (48-44) LS:CUSHIONED\nQ2 12:00: ORL 0.72 (28-26)',
      priorAlerts:'BWC[FIRED] Q2 6:00: floor 0.72, margin 4 -> SEND',
      quarterSummary:'Q1: 28-26, paint 18-10\nQ2: 20-18',
      priorPosition: { alertType:'BUY WINDOW CLOSING', controlTeam:'ORL', floor:'0.72', margin:4, isTrailing:false, period:2, clock:'6:00', conviction:'STRONG', combo:'I1+I3+I4', ctrlSust:'LOCKED IN', oppSust:'FRAGILE', minutesSince:35, sameTeam:true },
    }},
    '6': { name: 'CANDIDATE WINDOW BUY floor 0.83', expected: 'SEND', ctx: {
      alertType:'WINDOW BUY', alertTier:'CANDIDATE', controlTeam:'ORL', floor:'0.83', margin:3, isTrailing:false,
      period:2, clock:'3:09', minsLeft:'27.2', convictionTier:'STRONG', convictionCombo:'I1+I3+I4', convictionPairs:'I3+I4',
      edge:15, ml:'-350', spread:'-8', tpClass:null, lsClass:'CUSHIONED', ctrlSust:'LOCKED IN', oppSust:'FRAGILE',
      i1:'0.80', i2:'0.50', i3:'0.75', i4:'0.90', i5:'0.50', indicatorsWon:3, indWon:'I1+I3+I4', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q2 6:00: ORL 0.78 (38-36) LS:CUSHIONED\nQ1 6:00: ORL 0.70 (18-16)',
      priorAlerts:'None', quarterSummary:'Q1: 28-26, paint 18-10\nQ2: 10-10'
    }},
    '7': { name: 'FIRED BUY Q3 with learnings loop', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'FIRED', controlTeam:'MEM', floor:'0.70', margin:8, isTrailing:true,
      period:3, clock:'6:00', minsLeft:'18.0', convictionTier:'STRONG', convictionCombo:'I3+I4', convictionPairs:'I3+I4',
      edge:22, ml:'+280', spread:'+6.5', tpClass:'PROBABLE', lsClass:null, ctrlSust:'DURABLE', oppSust:'FRAGILE',
      i1:'0.50', i2:'0.60', i3:'0.80', i4:'0.85', i5:'0.50', indicatorsWon:3, indWon:'I2+I3+I4', indLost:'I1',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 9:00: MEM 0.68 (62-70) TP:PROBABLE\nQ2 6:00: MEM 0.65 (44-52)',
      priorAlerts:'RECOVERY PATH Q2 6:00: floor 0.65, margin 8 trailing -> SEND',
      quarterSummary:'Q1: 24-30\nQ2: 20-22\nQ3: 18-18',
      learningsContext:'NIGHTLY RESULTS:\n2026-04-12: 92% | BUY:5/5 BWC:2/3\n2026-04-10: 100% | BUY:3/3 BWC:11/11\nPATTERNS: I4 COMBO YES at 98%'
    }},
    '8': { name: 'FIRED BWC after monitor CONFIRMED prior BUY', expected: 'SEND', ctx: {
      alertType:'BUY WINDOW CLOSING', alertTier:'FIRED', controlTeam:'SAC', floor:'0.71', margin:5, isTrailing:false,
      period:3, clock:'4:00', minsLeft:'16.0', convictionTier:'STRONG', convictionCombo:'I1+I3+I4', convictionPairs:'I3+I4',
      edge:8.5, ml:'-180', spread:'-4.5', tpClass:null, lsClass:'CUSHIONED', ctrlSust:'DURABLE', oppSust:'FRAGILE',
      i1:'0.75', i2:'0.55', i3:'0.80', i4:'0.82', i5:'0.60', indicatorsWon:4, indWon:'I1+I3+I4+I5', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 6:00: SAC 0.72 (68-64) LS:CUSHIONED\nQ3 12:00: SAC 0.70 (58-56)',
      priorAlerts:'BUY[FIRED] Q2 4:30: floor 0.72, margin 6 trailing -> SEND\n  Monitor: CONFIRMED',
      quarterSummary:'Q1: 24-30\nQ2: 24-18\nQ3: 20-16'
    }},
    '9': { name: 'AUTO_ANALYSIS — control shifted, warn bettor', expected: 'SEND', ctx: {
      alertType:'AUTO_ANALYSIS', alertTier:'ANALYSIS', controlTeam:'GSW', floor:'0.62', margin:3, isTrailing:false,
      period:4, clock:'12:00', minsLeft:'12.0', convictionTier:'MODEST', convictionCombo:'I3+I5', convictionPairs:'',
      edge:4.2, ml:'-160', spread:'-2.5', tpClass:null, lsClass:'AT RISK', ctrlSust:'MIXED', oppSust:'LOCKED IN',
      i1:'0.50', i2:'0.40', i3:'0.70', i4:'0.50', i5:'0.65', indicatorsWon:2, indWon:'I3+I5', indLost:'I2',
      i4Decisive:false, i4Won:false, i4Combo:false,
      floorHistory:'Q3 6:00: LAC 0.75 (82-78) LS:CUSHIONED\nQ3 12:00: LAC 0.68 (66-64)',
      priorAlerts:'BWC[FIRED] Q2 6:00: floor 0.75, margin 4 leading -> SEND',
      quarterSummary:'Q1: 28-26\nQ2: 30-24\nQ3: 24-30',
      priorPosition: { alertType:'BUY WINDOW CLOSING', controlTeam:'LAC', floor:'0.75', margin:4, isTrailing:false, period:2, clock:'6:00', conviction:'CONDITIONAL', combo:'I1+I2+I5', ctrlSust:'LOCKED IN', oppSust:'COLD', minutesSince:55, sameTeam:false },
    }},
    '10': { name: 'AUTO_ANALYSIS — nothing changed, suppress spam', expected: 'SUPPRESS', ctx: {
      alertType:'AUTO_ANALYSIS', alertTier:'ANALYSIS', controlTeam:'MIN', floor:'0.85', margin:8, isTrailing:false,
      period:4, clock:'12:00', minsLeft:'12.0', convictionTier:'DOMINANT', convictionCombo:'I1+I2+I3+I4+I5', convictionPairs:'I4+I5,I3+I4',
      edge:12, ml:'-500', spread:'-7.5', tpClass:null, lsClass:'SAFE', ctrlSust:'LOCKED IN', oppSust:'COLD',
      i1:'1.00', i2:'1.00', i3:'1.00', i4:'1.00', i5:'1.00', indicatorsWon:5, indWon:'I1+I2+I3+I4+I5', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 6:00: MIN 0.85 (92-84) LS:SAFE\nQ3 12:00: MIN 0.83 (68-62)',
      priorAlerts:'BWC[FIRED] Q2 6:00: floor 0.83, margin 5 -> SEND\nAUTO_ANALYSIS Q3 12:00: floor 0.85, margin 8 -> SEND',
      quarterSummary:'Q1: 30-28\nQ2: 28-24\nQ3: 34-32',
      priorPosition: { alertType:'BUY WINDOW CLOSING', controlTeam:'MIN', floor:'0.84', margin:7, isTrailing:false, period:2, clock:'6:00', conviction:'DOMINANT', combo:'I1+I2+I3+I4+I5', ctrlSust:'LOCKED IN', oppSust:'COLD', minutesSince:70, sameTeam:true },
    }},

    // ═══ NEW SCENARIOS (11-16) — TP gate removal, ML gates, null ML, LEAD CRUMBLING context ═══

    '11': { name: 'NEW: BUY + TP NO PATH at 2pt deficit (was TP-blocked, should SEND now)', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'FIRED', controlTeam:'LAL', floor:'0.80', margin:2, isTrailing:true,
      period:3, clock:'7:10', minsLeft:'19.2', convictionTier:'STRONG', convictionCombo:'I1+I2+I4', convictionPairs:'',
      edge:28, ml:'+140', spread:'+2.5', tpClass:'NO PATH', lsClass:null, ctrlSust:'DURABLE', oppSust:'MIXED',
      i1:'0.85', i2:'0.80', i3:'0.50', i4:'0.75', i5:'0.50', indicatorsWon:3, indWon:'I1+I2+I4', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 9:00: LAL 0.78 (56-58) TP:UNLIKELY\nQ2 6:00: LAL 0.75 (38-42) TP:NO PATH',
      priorAlerts:'None',
      quarterSummary:'Q1: 20-24\nQ2: 18-18\nQ3: 18-16'
    }},
    '12': { name: 'NEW: BUY + TP NO PATH at 12pt deficit (I4 COMBO YES overrules TP)', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'FIRED', controlTeam:'ATL', floor:'0.68', margin:12, isTrailing:true,
      period:3, clock:'4:00', minsLeft:'16.0', convictionTier:'MODEST', convictionCombo:'I1+I4', convictionPairs:'',
      edge:18, ml:'+350', spread:'+10.5', tpClass:'NO PATH', lsClass:null, ctrlSust:'COLD', oppSust:'LOCKED IN',
      i1:'0.70', i2:'0.50', i3:'0.45', i4:'0.70', i5:'0.50', indicatorsWon:2, indWon:'I1+I4', indLost:'I3',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 8:00: ATL 0.72 (52-64) TP:UNLIKELY\nQ3 12:00: ATL 0.70 (42-54) TP:NO PATH\nQ2 6:00: ATL 0.65 (28-38) TP:NO PATH',
      priorAlerts:'None',
      quarterSummary:'Q1: 18-28\nQ2: 10-10\nQ3: 24-26'
    }},
    '13': { name: 'NEW: CANDIDATE BUY heavy favorite ML -350 (line shopping)', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'CANDIDATE', controlTeam:'BOS', floor:'0.75', margin:3, isTrailing:true,
      period:3, clock:'8:00', minsLeft:'20.0', convictionTier:'STRONG', convictionCombo:'I2+I3+I4', convictionPairs:'I3+I4',
      edge:-12, ml:'-350', spread:'-8.5', tpClass:'PROBABLE', lsClass:null, ctrlSust:'LOCKED IN', oppSust:'FRAGILE',
      i1:'0.50', i2:'0.80', i3:'0.85', i4:'0.90', i5:'0.50', indicatorsWon:3, indWon:'I2+I3+I4', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 10:00: BOS 0.72 (60-63) TP:STRONG RECOVERY\nQ2 6:00: BOS 0.68 (38-44)',
      priorAlerts:'None',
      quarterSummary:'Q1: 18-24\nQ2: 20-20\nQ3: 24-19'
    }},
    '14': { name: 'NEW: CANDIDATE BWC FRAGILE sust (lead built on variance)', expected: 'SUPPRESS', ctx: {
      alertType:'BUY WINDOW CLOSING', alertTier:'CANDIDATE', controlTeam:'POR', floor:'0.65', margin:6, isTrailing:false,
      period:3, clock:'6:00', minsLeft:'18.0', convictionTier:'MODEST', convictionCombo:'I1+I3', convictionPairs:'',
      edge:5.5, ml:'-180', spread:'-4.5', tpClass:null, lsClass:'CUSHIONED', ctrlSust:'FRAGILE', oppSust:'DURABLE',
      i1:'0.70', i2:'0.50', i3:'0.75', i4:'0.50', i5:'0.50', indicatorsWon:2, indWon:'I1+I3', indLost:'',
      i4Decisive:false, i4Won:false, i4Combo:false,
      floorHistory:'Q3 9:00: POR 0.68 (72-66) LS:CUSHIONED\nQ2 6:00: POR 0.65 (46-40)',
      priorAlerts:'None',
      quarterSummary:'Q1: 22-18, 3PT 5/9\nQ2: 24-22, 3PT 6/11\nQ3: 26-26'
    }},
    '15': { name: 'NEW: BUY + TP UNLIKELY but I4 COMBO YES (trust indicators over TP)', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'FIRED', controlTeam:'MIL', floor:'0.73', margin:7, isTrailing:true,
      period:3, clock:'3:00', minsLeft:'15.0', convictionTier:'STRONG', convictionCombo:'I1+I3+I4', convictionPairs:'I3+I4',
      edge:25, ml:'+220', spread:'+6.5', tpClass:'UNLIKELY', lsClass:null, ctrlSust:'DURABLE', oppSust:'COLD',
      i1:'0.75', i2:'0.50', i3:'0.80', i4:'0.85', i5:'0.50', indicatorsWon:3, indWon:'I1+I3+I4', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 6:00: MIL 0.70 (62-69) TP:UNLIKELY\nQ2 6:00: MIL 0.68 (40-48)',
      priorAlerts:'RECOVERY PATH Q2 8:00: floor 0.60, margin 8 trailing, TP PROBABLE -> SEND',
      quarterSummary:'Q1: 20-28\nQ2: 20-20\nQ3: 22-21'
    }},
    '16': { name: 'NEW: BWC after agent-suppressed LEAD CRUMBLING (structural held)', expected: 'SEND', ctx: {
      alertType:'BUY WINDOW CLOSING', alertTier:'FIRED', controlTeam:'CLE', floor:'0.72', margin:6, isTrailing:false,
      period:4, clock:'9:00', minsLeft:'9.0', convictionTier:'STRONG', convictionCombo:'I2+I3+I4', convictionPairs:'I3+I4',
      edge:8.2, ml:'-210', spread:'-5.5', tpClass:null, lsClass:'CUSHIONED', ctrlSust:'DURABLE', oppSust:'COLD',
      i1:'0.50', i2:'0.75', i3:'0.80', i4:'0.85', i5:'0.50', indicatorsWon:3, indWon:'I2+I3+I4', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q4 12:00: CLE 0.70 (90-84) LS:CUSHIONED\nQ3 6:00: CLE 0.75 (76-68) LS:SAFE\nQ3 12:00: CLE 0.78 (58-48)',
      priorAlerts:'BWC[FIRED] Q3 6:00: floor 0.75, margin 8 -> SEND\nLEAD CRUMBLING Q3 2:00: floor 0.68, margin 4, LS AT RISK -> SUPPRESS: structural holds, I4 dominant, LS noise from hot Q3 run',
      quarterSummary:'Q1: 28-22\nQ2: 30-26\nQ3: 18-26\nQ4: 14-10'
    }},

    // ═══ TRANSITION ALERT SCENARIOS (17-22) ═══

    '17': { name: 'RECOVERY PATH SEND — I4 COMBO YES, TP STRONG, floor rising', expected: 'SEND', ctx: {
      alertType:'RECOVERY PATH', alertTier:'FIRED', controlTeam:'DEN', floor:'0.55', margin:8, isTrailing:true,
      period:3, clock:'6:00', minsLeft:'18.0', convictionTier:'STRONG', convictionCombo:'I1+I3+I4', convictionPairs:'I3+I4',
      edge:30, ml:'+320', spread:'+8.5', tpClass:'STRONG RECOVERY', lsClass:null, ctrlSust:'DURABLE', oppSust:'FRAGILE',
      i1:'0.75', i2:'0.50', i3:'0.80', i4:'0.85', i5:'0.50', indicatorsWon:3, indWon:'I1+I3+I4', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 9:00: DEN 0.50 (52-62) TP:PROBABLE\nQ2 6:00: DEN 0.45 (34-44) TP:CONTESTED',
      priorAlerts:'None',
      quarterSummary:'Q1: 18-26\nQ2: 16-18\nQ3: 18-18, paint 14-8'
    }},
    '18': { name: 'RECOVERY PATH SUPPRESS — TP STRONG but I4 COMBO NO, floor declining', expected: 'SUPPRESS', ctx: {
      alertType:'RECOVERY PATH', alertTier:'FIRED', controlTeam:'WAS', floor:'0.42', margin:10, isTrailing:true,
      period:3, clock:'4:00', minsLeft:'16.0', convictionTier:'CONDITIONAL', convictionCombo:'I1', convictionPairs:'',
      edge:15, ml:'+400', spread:'+10.5', tpClass:'STRONG RECOVERY', lsClass:null, ctrlSust:'COLD', oppSust:'LOCKED IN',
      i1:'0.70', i2:'0.40', i3:'0.35', i4:'0.30', i5:'0.45', indicatorsWon:1, indWon:'I1', indLost:'I2+I3+I4',
      i4Decisive:true, i4Won:false, i4Combo:false,
      floorHistory:'Q3 8:00: WAS 0.48 (48-58) TP:PROBABLE\nQ2 6:00: WAS 0.52 (32-38) TP:STRONG RECOVERY',
      priorAlerts:'None',
      quarterSummary:'Q1: 18-22\nQ2: 14-16\nQ3: 16-20'
    }},
    '19': { name: 'LEAD CRUMBLING SEND — floor declining, sust shifting, I4 EVEN', expected: 'SEND', ctx: {
      alertType:'LEAD CRUMBLING', alertTier:'FIRED', controlTeam:'MIA', floor:'0.60', margin:6, isTrailing:false,
      period:3, clock:'4:00', minsLeft:'16.0', convictionTier:'MODEST', convictionCombo:'I1+I2', convictionPairs:'',
      edge:null, ml:null, spread:null, tpClass:null, lsClass:'CRITICAL', ctrlSust:'FRAGILE', oppSust:'LOCKED IN',
      i1:'0.65', i2:'0.60', i3:'0.45', i4:'0.50', i5:'0.45', indicatorsWon:2, indWon:'I1+I2', indLost:'I3+I5',
      i4Decisive:false, i4Won:false, i4Combo:false,
      floorHistory:'Q3 8:00: MIA 0.68 (68-62) LS:AT RISK\nQ2 6:00: MIA 0.75 (48-40) LS:SAFE\nQ2 12:00: MIA 0.78 (28-20) LS:SAFE',
      priorAlerts:'BWC[FIRED] Q2 6:00: floor 0.75, margin 8 -> SEND',
      quarterSummary:'Q1: 28-20\nQ2: 20-20\nQ3: 20-22'
    }},
    '20': { name: 'LEAD CRUMBLING SUPPRESS — I4 dominant, sust holds, hot quarter noise', expected: 'SUPPRESS', ctx: {
      alertType:'LEAD CRUMBLING', alertTier:'FIRED', controlTeam:'BOS', floor:'0.78', margin:8, isTrailing:false,
      period:3, clock:'6:00', minsLeft:'18.0', convictionTier:'STRONG', convictionCombo:'I2+I3+I4', convictionPairs:'I3+I4',
      edge:null, ml:null, spread:null, tpClass:null, lsClass:'AT RISK', ctrlSust:'LOCKED IN', oppSust:'COLD',
      i1:'0.50', i2:'0.80', i3:'0.75', i4:'0.90', i5:'0.60', indicatorsWon:4, indWon:'I2+I3+I4+I5', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 9:00: BOS 0.80 (72-64) LS:CUSHIONED\nQ2 6:00: BOS 0.82 (50-40) LS:SAFE',
      priorAlerts:'BWC[FIRED] Q2 6:00: floor 0.82, margin 10 -> SEND',
      quarterSummary:'Q1: 28-20\nQ2: 22-20\nQ3: 22-24'
    }},
    '21': { name: 'VARIANCE BREAKING SEND — opponent sust dropped, strong structural edge', expected: 'SEND', ctx: {
      alertType:'VARIANCE BREAKING', alertTier:'FIRED', controlTeam:'PHX', floor:'0.72', margin:5, isTrailing:true,
      period:3, clock:'3:00', minsLeft:'15.0', convictionTier:'STRONG', convictionCombo:'I1+I4+I5', convictionPairs:'I4+I5',
      edge:22, ml:'+200', spread:'+5.5', tpClass:'PROBABLE', lsClass:null, ctrlSust:'DURABLE', oppSust:'FRAGILE',
      i1:'0.80', i2:'0.55', i3:'0.50', i4:'0.85', i5:'0.70', indicatorsWon:3, indWon:'I1+I4+I5', indLost:'I3',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 6:00: PHX 0.70 (62-67) TP:PROBABLE\nQ2 6:00: PHX 0.65 (40-48)',
      priorAlerts:'None',
      quarterSummary:'Q1: 22-28\nQ2: 18-20\nQ3: 22-19'
    }},
    '22': { name: 'VARIANCE BREAKING SUPPRESS — thin edge, I4 EVEN, borderline flip', expected: 'SUPPRESS', ctx: {
      alertType:'VARIANCE BREAKING', alertTier:'FIRED', controlTeam:'CHA', floor:'0.58', margin:3, isTrailing:true,
      period:3, clock:'8:00', minsLeft:'20.0', convictionTier:'CONDITIONAL', convictionCombo:'I2', convictionPairs:'',
      edge:5, ml:'+130', spread:'+3.5', tpClass:'CONTESTED', lsClass:null, ctrlSust:'MIXED', oppSust:'FRAGILE',
      i1:'0.50', i2:'0.65', i3:'0.50', i4:'0.50', i5:'0.45', indicatorsWon:1, indWon:'I2', indLost:'I5',
      i4Decisive:false, i4Won:false, i4Combo:false,
      floorHistory:'Q3 10:00: CHA 0.55 (48-52)\nQ2 6:00: CHA 0.52 (30-34)',
      priorAlerts:'None',
      quarterSummary:'Q1: 16-18\nQ2: 14-16\nQ3: 18-18'
    }},
  };

  let testKeys = [];
  if (testParam === 'all') testKeys = Object.keys(scenarios);
  else if (testParam === 'fired') testKeys = ['1', '4', '7', '8', '11', '12', '15', '16'];
  else if (testParam === 'candidate') testKeys = ['2', '3', '6', '13', '14'];
  else if (testParam === 'auto') testKeys = ['5', '9', '10'];
  else if (testParam === 'transition') testKeys = ['17', '18', '19', '20', '21', '22'];
  else if (testParam === 'new') testKeys = ['17', '18', '19', '20', '21', '22'];
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

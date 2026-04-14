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
${ctx.learningsContext ? '\n' + ctx.learningsContext + '\n' : ''}${ctx.monitorContext ? `
MONITOR OBSERVATIONS (from continuous game observer, most recent first):
${ctx.monitorContext}

NOTE: Monitor observations provide trajectory context — momentum, sustainability arcs, risk factors — from continuous 3-minute polling between alerts. Use them to inform your reasoning about the game's arc, but they do not override mechanical FIRED thresholds. A FIRED alert with strong indicators is still a SEND even if the monitor notes a risk factor. For CANDIDATE alerts, monitor context can tip the decision.
` : ''}${ctx.priorPosition ? `
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
- MONITOR OVERRIDE PROTECTION: I4 COMBO YES + FIRED is ALWAYS a SEND. Monitor observations CANNOT downgrade a FIRED alert with I4 COMBO YES to SUPPRESS — this rule is absolute. However, if monitor context shows persistent divergence (floor-margin DIVERGING 5+ polls), opponent sustainability LOCKED IN with zero degradation, or prior auto-analysis flagging thesis erosion, you MUST add a CAUTION line to your BODY: "CAUTION: [specific concern from monitor]." This preserves the signal while flagging the risk for the bettor to size their position.
- TP (Throughput Projection) is context, not a veto. It estimates deficit recovery from structural rates. Limitation: anchored to cumulative stats, misses momentum shifts. TP NO PATH at 1-3 point deficits is often a false negative. TP STRONG/PROBABLE adds confidence. TP UNLIKELY/NO PATH is a caution flag, not a stop sign.
- RECOVERY PATH: math projects a comeback. SEND if structural indicators (especially I4) back the TP math — I4 COMBO YES + rising floor means the engine is real. SUPPRESS if TP is anchored from early-game cumulative stats that have since eroded — floor declining + I4 COMBO NO means the opponent actually has game control despite favorable TP math.
- LEAD CRUMBLING: WARNING alert — INVERTS normal indicator logic. For entry alerts, strong indicators = SEND. For LEAD CRUMBLING, strong indicators = lead is SAFE = SUPPRESS. I4 COMBO YES + 3+ indicators + LOCKED IN/DURABLE = SUPPRESS (noise). I4 EVEN/NO + declining floor + sust shifting = SEND (real erosion). Floor dropped 0.10+ + conviction downgraded = SEND. If a prior BWC/BUY was SENT for this team in priorAlerts: lean SEND — subscriber has a position to protect.
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
    const bm = text.match(/BODY:\s*([\s\S]*?)$/i);
    return { decision: dm ? dm[1].toUpperCase() : 'PARSE_FAIL', reasoning: rm ? rm[1].trim() : text.substring(0, 150), body: bm ? bm[1].trim() : '', tokens: data.usage };
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

    // ═══ CROSS-TYPE PRIOR CHAIN SCENARIOS (23-28) ═══

    '23': { name: 'BUY after RECOVERY PATH sent — RP confirms comeback engine', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'FIRED', controlTeam:'SAC', floor:'0.68', margin:5, isTrailing:true,
      period:3, clock:'4:00', minsLeft:'16.0', convictionTier:'STRONG', convictionCombo:'I1+I3+I4', convictionPairs:'I3+I4',
      edge:28, ml:'+180', spread:'+4.5', tpClass:'STRONG RECOVERY', lsClass:null, ctrlSust:'DURABLE', oppSust:'FRAGILE',
      i1:'0.75', i2:'0.50', i3:'0.80', i4:'0.85', i5:'0.50', indicatorsWon:3, indWon:'I1+I3+I4', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 8:00: SAC 0.65 (62-68) TP:PROBABLE\nQ3 12:00: SAC 0.58 (52-60) TP:CONTESTED\nQ2 6:00: SAC 0.40 (30-42) TP:STRONG RECOVERY',
      priorAlerts:'RECOVERY PATH[FIRED] Q2 8:00: floor 0.40, margin 12 trailing, sust MIXED/LOCKED IN, conv CONDITIONAL(I1), TP STRONG RECOVERY → SEND: structural math projects comeback\nAUTO_ANALYSIS[ANALYSIS] Q3 12:00: floor 0.58, margin 8 trailing → SUPPRESS: no prior actionable alert (position gate)',
      quarterSummary:'Q1: 18-26\nQ2: 12-16\nQ3: 32-26, paint 16-8'
    }},
    '24': { name: 'BWC after LEAD CRUMBLING sent — real erosion, suppress', expected: 'SUPPRESS', ctx: {
      alertType:'BUY WINDOW CLOSING', alertTier:'FIRED', controlTeam:'MIA', floor:'0.62', margin:6, isTrailing:false,
      period:3, clock:'3:00', minsLeft:'15.0', convictionTier:'MODEST', convictionCombo:'I1+I2', convictionPairs:'',
      edge:3.5, ml:'-150', spread:'-3.5', tpClass:null, lsClass:'AT RISK', ctrlSust:'FRAGILE', oppSust:'DURABLE',
      i1:'0.65', i2:'0.60', i3:'0.45', i4:'0.50', i5:'0.45', indicatorsWon:2, indWon:'I1+I2', indLost:'I3+I5',
      i4Decisive:false, i4Won:false, i4Combo:false,
      floorHistory:'Q3 6:00: MIA 0.68 (68-62) LS:AT RISK\nQ3 12:00: MIA 0.72 (56-48) LS:CUSHIONED\nQ2 6:00: MIA 0.78 (40-32) LS:SAFE',
      priorAlerts:'LEAD CRUMBLING[FIRED] Q3 8:00: floor 0.68, margin 8 leading, sust MIXED/DURABLE, conv MODEST(I1+I2), LS AT RISK → SEND: real structural erosion, floor declining -0.10, I4 lost, sust shifting to opponent\nBWC[FIRED] Q2 6:00: floor 0.78, margin 8 leading, sust LOCKED IN/COLD, conv STRONG(I2+I3+I4), edge +12.5% → SEND',
      quarterSummary:'Q1: 22-16\nQ2: 18-16\nQ3: 28-30'
    }},
    '25': { name: 'BUY after VARIANCE BREAKING sent — VB confirms variance thesis', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'FIRED', controlTeam:'PHX', floor:'0.70', margin:4, isTrailing:true,
      period:3, clock:'2:00', minsLeft:'14.0', convictionTier:'STRONG', convictionCombo:'I1+I4+I5', convictionPairs:'I4+I5',
      edge:25, ml:'+165', spread:'+4.5', tpClass:'PROBABLE', lsClass:null, ctrlSust:'DURABLE', oppSust:'UNSUSTAINABLE',
      i1:'0.80', i2:'0.55', i3:'0.50', i4:'0.85', i5:'0.75', indicatorsWon:3, indWon:'I1+I4+I5', indLost:'I3',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 6:00: PHX 0.68 (66-72) TP:PROBABLE\nQ3 12:00: PHX 0.62 (52-60) TP:CONTESTED\nQ2 6:00: PHX 0.55 (36-46)',
      priorAlerts:'VARIANCE BREAKING[FIRED] Q3 6:00: floor 0.68, margin 6 trailing, sust DURABLE/FRAGILE, conv MODEST(I1+I4) → SEND: opponent shooting regressing, structural edge clear with I4 dominant\nRECOVERY PATH[FIRED] Q2 8:00: floor 0.48, margin 10 trailing, conv CONDITIONAL(I1), TP STRONG RECOVERY → SEND',
      quarterSummary:'Q1: 20-28\nQ2: 16-18\nQ3: 30-26'
    }},
    '26': { name: 'LEAD CRUMBLING after BWC sent — warn about existing position', expected: 'SEND', ctx: {
      alertType:'LEAD CRUMBLING', alertTier:'FIRED', controlTeam:'BOS', floor:'0.65', margin:5, isTrailing:false,
      period:3, clock:'3:00', minsLeft:'15.0', convictionTier:'MODEST', convictionCombo:'I2+I3', convictionPairs:'',
      edge:null, ml:null, spread:null, tpClass:null, lsClass:'CRITICAL', ctrlSust:'MIXED', oppSust:'LOCKED IN',
      i1:'0.50', i2:'0.65', i3:'0.60', i4:'0.50', i5:'0.45', indicatorsWon:2, indWon:'I2+I3', indLost:'I5',
      i4Decisive:false, i4Won:false, i4Combo:false,
      floorHistory:'Q3 6:00: BOS 0.72 (70-64) LS:AT RISK\nQ2 6:00: BOS 0.80 (48-38) LS:SAFE\nQ2 12:00: BOS 0.82 (26-18) LS:SAFE',
      priorAlerts:'BWC[FIRED] Q2 6:00: floor 0.80, margin 10 leading, sust LOCKED IN/COLD, conv STRONG(I2+I3+I4), edge +15.2% → SEND: dominant structural case\nAUTO_ANALYSIS[ANALYSIS] Q3 12:00: floor 0.72, margin 6 leading → SEND: floor dropped -0.08 from prior BWC, conviction downgraded to MODEST',
      quarterSummary:'Q1: 26-18\nQ2: 22-20\nQ3: 22-26'
    }},
    '27': { name: 'AUTO_ANALYSIS after BUY sent + LC sent — conflicting chain', expected: 'SEND', ctx: {
      alertType:'AUTO_ANALYSIS', alertTier:'ANALYSIS', controlTeam:'DEN', floor:'0.62', margin:2, isTrailing:false,
      period:4, clock:'12:00', minsLeft:'12.0', convictionTier:'MODEST', convictionCombo:'I1+I4', convictionPairs:'',
      edge:2.5, ml:'-130', spread:'-2.5', tpClass:null, lsClass:'AT RISK', ctrlSust:'MIXED', oppSust:'DURABLE',
      i1:'0.70', i2:'0.50', i3:'0.45', i4:'0.70', i5:'0.50', indicatorsWon:2, indWon:'I1+I4', indLost:'I3',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 6:00: DEN 0.68 (78-74) LS:CUSHIONED\nQ3 12:00: DEN 0.70 (62-56)\nQ2 6:00: DEN 0.65 (40-48) TP:PROBABLE',
      priorAlerts:'LEAD CRUMBLING[FIRED] Q3 2:00: floor 0.65, margin 4 leading, sust MIXED/DURABLE, conv MODEST(I1+I4), LS AT RISK → SEND: real erosion, floor dropped from 0.70, sust shifting\nBUY[FIRED] Q2 8:00: floor 0.70, margin 8 trailing, sust DURABLE/FRAGILE, conv STRONG(I1+I3+I4), edge +22% → SEND: I4 COMBO YES, structural case strong\nAUTO_ANALYSIS[ANALYSIS] Q3 12:00: floor 0.70, margin 6 leading → SEND: BUY position tracking, DEN took lead',
      quarterSummary:'Q1: 20-28\nQ2: 20-20\nQ3: 22-18\nQ4: 0-0',
      priorPosition: { alertType:'BUY', controlTeam:'DEN', floor:'0.70', margin:8, isTrailing:true, period:2, clock:'8:00', conviction:'STRONG', combo:'I1+I3+I4', ctrlSust:'DURABLE', oppSust:'FRAGILE', minutesSince:50, sameTeam:true },
    }},
    '28': { name: 'RECOVERY PATH after opponent BWC — different teams, dont confuse', expected: 'SUPPRESS', ctx: {
      alertType:'RECOVERY PATH', alertTier:'FIRED', controlTeam:'LAL', floor:'0.35', margin:8, isTrailing:true,
      period:3, clock:'6:00', minsLeft:'18.0', convictionTier:'CONDITIONAL', convictionCombo:'I1', convictionPairs:'',
      edge:12, ml:'+300', spread:'+8.5', tpClass:'STRONG RECOVERY', lsClass:null, ctrlSust:'COLD', oppSust:'LOCKED IN',
      i1:'0.70', i2:'0.40', i3:'0.35', i4:'0.30', i5:'0.45', indicatorsWon:1, indWon:'I1', indLost:'I2+I3+I4',
      i4Decisive:true, i4Won:false, i4Combo:false,
      floorHistory:'Q3 9:00: LAL 0.38 (52-62) TP:PROBABLE\nQ2 6:00: LAL 0.42 (34-44) TP:STRONG RECOVERY\nQ2 12:00: LAL 0.35 (18-28)',
      priorAlerts:'BWC[FIRED] Q2 8:00: floor 0.78, margin 10 leading, sust LOCKED IN/COLD, conv STRONG(I2+I3+I4), edge +18% → SEND: MIN dominant structural case\nAUTO_ANALYSIS[ANALYSIS] Q3 12:00: floor 0.80, margin 12 leading → SEND: MIN BWC position strengthening',
      quarterSummary:'Q1: 18-28\nQ2: 16-16\nQ3: 18-18'
    }},

    // ═══ DEEP PRIOR CHAIN SCENARIOS — 5 priors each (29-32) ═══

    '29': { name: 'CONTROL: BWC with 5 clean priors — simple escalation', expected: 'SEND', ctx: {
      alertType:'BUY WINDOW CLOSING', alertTier:'FIRED', controlTeam:'OKC', floor:'0.82', margin:10, isTrailing:false,
      period:4, clock:'8:00', minsLeft:'8.0', convictionTier:'DOMINANT', convictionCombo:'I1+I2+I3+I4', convictionPairs:'I3+I4',
      edge:14.5, ml:'-320', spread:'-8.5', tpClass:null, lsClass:'SAFE', ctrlSust:'LOCKED IN', oppSust:'COLD',
      i1:'0.85', i2:'0.90', i3:'0.80', i4:'0.95', i5:'0.70', indicatorsWon:5, indWon:'I1+I2+I3+I4+I5', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q4 12:00: OKC 0.80 (88-78) LS:SAFE\nQ3 6:00: OKC 0.78 (72-66) LS:SAFE\nQ3 12:00: OKC 0.75 (56-52) LS:CUSHIONED',
      priorAlerts:'AUTO_ANALYSIS[ANALYSIS] Q3 12:00: floor 0.82, margin 12 leading, sust LOCKED IN/COLD → SEND: BWC position strengthening, floor +0.07 from entry\nBWC[FIRED] Q3 12:00: floor 0.78, margin 8 leading, sust LOCKED IN/COLD, conv STRONG(I2+I3+I4), edge +12% → SEND: structural dominance confirmed\nAUTO_ANALYSIS[ANALYSIS] Q2 12:00: floor 0.72, margin 6 leading → SEND: BUY position converted, OKC took lead\nBUY[FIRED] Q2 6:00: floor 0.70, margin 4 trailing, sust DURABLE/FRAGILE, conv STRONG(I1+I3+I4), edge +22%, TP PROBABLE → SEND: I4 COMBO YES, structural case strong\nRECOVERY PATH[FIRED] Q2 10:00: floor 0.45, margin 8 trailing, sust MIXED/LOCKED IN, conv CONDITIONAL(I1), TP STRONG RECOVERY → SEND: math projects comeback',
      quarterSummary:'Q1: 22-30\nQ2: 26-18\nQ3: 30-30\nQ4: 10-0'
    }},
    '30': { name: 'HARD: BUY after full arc — BWC to collapse to VB recovery', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'FIRED', controlTeam:'SAC', floor:'0.68', margin:4, isTrailing:true,
      period:4, clock:'9:00', minsLeft:'9.0', convictionTier:'STRONG', convictionCombo:'I1+I3+I4', convictionPairs:'I3+I4',
      edge:32, ml:'+220', spread:'+5.5', tpClass:'PROBABLE', lsClass:null, ctrlSust:'DURABLE', oppSust:'UNSUSTAINABLE',
      i1:'0.75', i2:'0.50', i3:'0.80', i4:'0.85', i5:'0.55', indicatorsWon:3, indWon:'I1+I3+I4', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q4 12:00: SAC 0.65 (78-84) TP:PROBABLE\nQ3 6:00: SAC 0.55 (62-72) TP:CONTESTED\nQ3 12:00: SAC 0.70 (52-56)',
      priorAlerts:'VARIANCE BREAKING[FIRED] Q4 12:00: floor 0.65, margin 6 trailing, sust DURABLE/UNSUSTAINABLE → SEND: opponent 3PT% collapsed from 48% to 29%, variance thesis confirmed\nLEAD LOST Q3 4:00: floor 0.60, margin 0 → SAC lost lead, was CUSHIONED\nLEAD CRUMBLING[FIRED] Q3 8:00: floor 0.68, margin 4 leading, sust DURABLE/LOCKED IN, conv MODEST(I1+I4), LS CRITICAL → SEND: real erosion, floor -0.12 from BWC, sust shifting\nAUTO_ANALYSIS[ANALYSIS] Q3 12:00: floor 0.70, margin 6 leading → SEND: BWC position holding but floor dipped from 0.80\nBWC[FIRED] Q2 6:00: floor 0.80, margin 10 leading, sust LOCKED IN/FRAGILE, conv DOMINANT(I1+I2+I3+I4), edge +18% → SEND: dominant structural case',
      quarterSummary:'Q1: 26-18\nQ2: 22-20\nQ3: 14-26\nQ4: 16-20'
    }},
    '31': { name: 'HARD: BUY after 3 suppressions then I4 flips — conditions changed', expected: 'SEND', ctx: {
      alertType:'BUY', alertTier:'FIRED', controlTeam:'ATL', floor:'0.72', margin:6, isTrailing:true,
      period:3, clock:'3:00', minsLeft:'15.0', convictionTier:'STRONG', convictionCombo:'I2+I3+I4', convictionPairs:'I3+I4',
      edge:28, ml:'+250', spread:'+6.5', tpClass:'PROBABLE', lsClass:null, ctrlSust:'DURABLE', oppSust:'FRAGILE',
      i1:'0.50', i2:'0.75', i3:'0.80', i4:'0.85', i5:'0.55', indicatorsWon:3, indWon:'I2+I3+I4', indLost:'',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q3 6:00: ATL 0.68 (58-66) TP:PROBABLE\nQ3 12:00: ATL 0.62 (48-58) TP:CONTESTED\nQ2 6:00: ATL 0.55 (32-42)',
      priorAlerts:'BUY[FIRED] Q3 6:00: floor 0.62, margin 8 trailing, sust MIXED/LOCKED IN, conv CONDITIONAL(I1), I4 COMBO NO → SUPPRESS: only 1/5 indicators, I4 favors opponent, structural case weak\nRECOVERY PATH[FIRED] Q2 8:00: floor 0.48, margin 10 trailing, sust COLD/LOCKED IN, conv CONDITIONAL(I1), TP STRONG RECOVERY → SEND: math projects comeback despite weak floor\nAUTO_ANALYSIS[ANALYSIS] Q2 12:00: floor 0.55, margin 10 trailing → SUPPRESS: no prior actionable position (position gate)\nWINDOW BUY[CANDIDATE] Q2 10:00: floor 0.52, margin 8 trailing, sust COLD/LOCKED IN, conv CONDITIONAL(I1) → SUPPRESS: CANDIDATE with I4 COMBO NO, only 1/5 indicators\nBUY[CANDIDATE] Q2 6:00: floor 0.50, margin 12 trailing, sust COLD/LOCKED IN, conv CONDITIONAL(I1) → SUPPRESS: floor below 0.55 with I4 COMBO NO',
      quarterSummary:'Q1: 16-24\nQ2: 16-18\nQ3: 26-24, paint 16-6'
    }},
    '32': { name: 'EXTREME: false dawn — I4 COMBO YES overrides narrative pressure', expected: 'SEND', ctx: {
      alertType:'WINDOW BUY', alertTier:'FIRED', controlTeam:'MEM', floor:'0.55', margin:2, isTrailing:false,
      period:4, clock:'8:00', minsLeft:'8.0', convictionTier:'MODEST', convictionCombo:'I1+I4', convictionPairs:'',
      edge:1.8, ml:'-115', spread:'-1.5', tpClass:null, lsClass:'AT RISK', ctrlSust:'COLD', oppSust:'MIXED',
      i1:'0.65', i2:'0.50', i3:'0.45', i4:'0.70', i5:'0.45', indicatorsWon:2, indWon:'I1+I4', indLost:'I3+I5',
      i4Decisive:true, i4Won:true, i4Combo:true,
      floorHistory:'Q4 12:00: MEM 0.58 (80-80) LS:AT RISK\nQ3 6:00: MEM 0.48 (66-72) TP:CONTESTED\nQ3 12:00: MEM 0.55 (54-58)',
      priorAlerts:'VARIANCE BREAKING[FIRED] Q3 2:00: floor 0.52, margin 4 trailing, sust COLD/FRAGILE → SEND: opponent shooting regressing, was LOCKED IN now FRAGILE\nLEAD LOST Q3 6:00: floor 0.60, margin 0 → MEM lost lead, was CUSHIONED\nLEAD CRUMBLING[FIRED] Q3 10:00: floor 0.65, margin 4 leading, sust DURABLE/LOCKED IN, conv MODEST(I1+I2), LS CRITICAL → SEND: floor dropped -0.15 from BWC, I4 lost, real erosion\nAUTO_ANALYSIS[ANALYSIS] Q2 12:00: floor 0.80, margin 12 leading → SEND: BWC position dominant, floor climbing\nBWC[FIRED] Q2 6:00: floor 0.78, margin 10 leading, sust LOCKED IN/FRAGILE, conv DOMINANT(I1+I2+I3+I4), edge +22% → SEND: dominant structural case across all indicators',
      quarterSummary:'Q1: 28-18\nQ2: 24-22\nQ3: 14-30\nQ4: 14-10'
    }},

    // ── MONITOR CONTEXT INTEGRATION (33-36) ──────────────────────────────

    '33': { name: 'MONITOR REINFORCEMENT: FIRED BUY + monitor confirms rising momentum — should SEND', expected: 'SEND', ctx: {
      alertType: 'BUY', alertTier: 'FIRED', controlTeam: 'MIL', floor: 0.72, margin: 6,
      isTrailing: true, period: 3, clock: '4:30', minsLeft: 16.5,
      edge: 18.5, ml: '+280', spread: '-4.5', tpClass: 'PROBABLE', lsClass: null,
      ctrlSust: 'DURABLE', oppSust: 'FRAGILE', windowScore: null,
      i1: 0.70, i2: 0.75, i3: 0.60, i4: 0.82, i5: 0.68,
      indicatorsWon: 4, indWon: 'I1+I2+I4+I5', indLost: '',
      i4Decisive: true, i4Won: true, i4Combo: true,
      convictionTier: 'DOMINANT', convictionCombo: 'I1+I2+I4+I5',
      floorHistory:'Q3 4:30: MIL 0.72 (68-74) TP:PROBABLE\nQ3 8:00: MIL 0.68 (60-68) TP:PROBABLE\nQ2 4:00: MIL 0.62 (48-56) TP:CONTESTED\nQ2 8:00: MIL 0.58 (40-48) TP:UNLIKELY',
      priorAlerts:'WINDOW BUY[FIRED] Q2 6:00: floor 0.60, margin 8 trailing → SEND',
      quarterSummary:'Q1: 20-28\nQ2: 28-28\nQ3: 20-18',
      monitorContext: 'Q3 6:00: MOMENTUM RISING (5 polls, +0.14) | OPP SUST: DEGRADING (LOCKED IN → DURABLE → FRAGILE) | FLOOR-MARGIN: CONVERGING\n  OBS: MIL has built structural dominance steadily from Q2 mid through Q3. Paint gap 32-18 and turnover forcing (9 steals vs 4) anchor the floor rise. BOS shooting has cratered from 42% 3PT in Q1 to 28% since.\n  RISK: MIL turnovers at 8 are manageable but rising. BOS bench scoring (24) is keeping them afloat despite starter regression. If BOS goes small to counter paint pressure, I2 edge could narrow.\nQ3 3:00: MOMENTUM RISING (7 polls, +0.16) | OPP SUST: DEGRADING (FRAGILE) | FLOOR-MARGIN: CONVERGING\n  OBS: Structural momentum confirmed. MIL closed the gap from -8 to -6 while floor rose to 0.72. BOS sustainability has fully degraded to FRAGILE. Paint dominance holding.\n  RISK: Same risks as prior observation. BOS 3PT regression is the key driver — if they hit 2-3 straight the sust arc reverses fast.'
    }},

    '34': { name: 'MONITOR TIPPING: CANDIDATE BUY + monitor shows sustained momentum — should SEND', expected: 'SEND', ctx: {
      alertType: 'BUY', alertTier: 'CANDIDATE', controlTeam: 'ATL', floor: 0.60, margin: 5,
      isTrailing: true, period: 3, clock: '6:00', minsLeft: 18,
      edge: 12.0, ml: '+180', spread: '-2.5', tpClass: 'CONTESTED', lsClass: null,
      ctrlSust: 'DURABLE', oppSust: 'MIXED', windowScore: null,
      i1: 0.62, i2: 0.58, i3: 0.55, i4: 0.68, i5: 0.60,
      indicatorsWon: 3, indWon: 'I1+I4+I5', indLost: 'I3',
      i4Decisive: true, i4Won: true, i4Combo: true,
      convictionTier: 'STRONG', convictionCombo: 'I1+I4+I5',
      floorHistory:'Q3 6:00: ATL 0.60 (55-60) TP:CONTESTED\nQ3 10:00: ATL 0.57 (48-54) TP:CONTESTED\nQ2 4:00: ATL 0.54 (40-46) TP:UNLIKELY',
      priorAlerts:'None',
      quarterSummary:'Q1: 20-24\nQ2: 20-22\nQ3: 15-14',
      monitorContext: 'Q3 8:00: MOMENTUM RISING (6 polls, +0.10) | OPP SUST: DEGRADING (DURABLE → MIXED) | FLOOR-MARGIN: CONVERGING\n  OBS: ATL has steadily built structural control from 0.50 to 0.58 across Q2 into Q3. Paint edge 24-16 is translating to real scoring. CLE 3PT volume (26 attempts) is high but conversion has dropped from 38% to 31%.\n  RISK: ATL I3 is losing — shot quality below CLE. If CLE adjusts defensively at the paint, ATL structural edge narrows to I4+I5 only. CLE bench rotation coming could stabilize their shooting.\nQ3 4:00: MOMENTUM RISING (8 polls, +0.12) | OPP SUST: DEGRADING (MIXED) | FLOOR-MARGIN: CONVERGING\n  OBS: Structural build continues. Floor now 0.60, margin closed from -8 to -5. Paint gap widened to 28-16. CLE shooting still declining.\n  RISK: CLE timeout — potential tactical adjustment. I3 loss remains concerning if CLE goes small. Momentum has been consistent enough that a 1-2 poll dip would be correction, not reversal.'
    }},

    '35': { name: 'MONITOR CONTRADICTION: FIRED BUY but monitor flags divergence — should still SEND (FIRED override)', expected: 'SEND', ctx: {
      alertType: 'BUY', alertTier: 'FIRED', controlTeam: 'SAC', floor: 0.70, margin: 12,
      isTrailing: true, period: 3, clock: '3:00', minsLeft: 15,
      edge: 20.0, ml: '+450', spread: '-6.5', tpClass: 'PROBABLE', lsClass: null,
      ctrlSust: 'DURABLE', oppSust: 'DURABLE', windowScore: null,
      i1: 0.72, i2: 0.68, i3: 0.58, i4: 0.75, i5: 0.65,
      indicatorsWon: 4, indWon: 'I1+I2+I4+I5', indLost: '',
      i4Decisive: true, i4Won: true, i4Combo: true,
      convictionTier: 'DOMINANT', convictionCombo: 'I1+I2+I4+I5',
      floorHistory:'Q3 3:00: SAC 0.70 (60-72) TP:PROBABLE\nQ3 6:00: SAC 0.68 (56-68) TP:PROBABLE\nQ3 10:00: SAC 0.65 (50-62) TP:CONTESTED\nQ2 4:00: SAC 0.62 (42-52) TP:CONTESTED',
      priorAlerts:'None',
      quarterSummary:'Q1: 22-30\nQ2: 20-22\nQ3: 18-20',
      monitorContext: 'Q3 6:00: MOMENTUM RISING (4 polls, +0.08) | OPP SUST: STABLE (DURABLE) | FLOOR-MARGIN: DIVERGING\n  OBS: SAC floor has climbed 0.62 to 0.70 but margin has WORSENED from -10 to -12. SAC is winning the structural battle (paint 30-20, steals 8-3) but LAC is converting at the rim and hitting contested 3s at 40% on 25 attempts. The structural edge is not translating to scoreboard movement.\n  RISK: DIVERGENCE is the headline. SAC owns paint and transition but LAC 40% 3PT on volume (25 attempts) is propping their lead. If LAC shooting is sustainable (DURABLE sust suggests it might be), the floor read may be misleading. SAC turnovers at 10 are a concern — each one gives LAC a transition opportunity that compounds the margin gap.'
    }},

    '36': { name: 'MONITOR CONTRADICTION: CANDIDATE BUY + monitor flags divergence + opp sust stable — should SUPPRESS', expected: 'SUPPRESS', ctx: {
      alertType: 'BUY', alertTier: 'CANDIDATE', controlTeam: 'POR', floor: 0.58, margin: 14,
      isTrailing: true, period: 3, clock: '5:00', minsLeft: 17,
      edge: 8.0, ml: '+550', spread: '-8.5', tpClass: 'CONTESTED', lsClass: null,
      ctrlSust: 'MIXED', oppSust: 'DURABLE', windowScore: null,
      i1: 0.60, i2: 0.55, i3: 0.48, i4: 0.62, i5: 0.55,
      indicatorsWon: 2, indWon: 'I1+I4', indLost: 'I3',
      i4Decisive: true, i4Won: true, i4Combo: false,
      convictionTier: 'MODEST', convictionCombo: 'I1+I4',
      floorHistory:'Q3 5:00: POR 0.58 (52-66) TP:CONTESTED\nQ3 8:00: POR 0.56 (48-60) TP:UNLIKELY\nQ2 4:00: POR 0.54 (38-50) TP:UNLIKELY',
      priorAlerts:'None',
      quarterSummary:'Q1: 18-26\nQ2: 20-24\nQ3: 14-16',
      monitorContext: 'Q3 6:00: MOMENTUM RISING (3 polls, +0.04) | OPP SUST: STABLE (DURABLE) | FLOOR-MARGIN: DIVERGING\n  OBS: POR structural edge is thin — floor rose from 0.54 to 0.58 but margin grew from -12 to -14. PHX paint dominance is only 22-18, not the commanding gap you would expect for a 0.58 floor. POR is generating turnovers (8 steals) but cannot convert — points off turnovers only 8 vs PHX 14.\n  RISK: PHX shooting remains DURABLE at 36% from 3 on 28 attempts — this is not variance, this is baseline-level production. POR I3 is losing and their own sustainability is MIXED. The floor read is being propped by I1 turnover generation that is not converting to scoring. Structural edge is effort-based, not talent-based.\nQ3 3:00: MOMENTUM STABLE | OPP SUST: STABLE (DURABLE) | FLOOR-MARGIN: DIVERGING\n  OBS: Momentum stalled. Floor flatlined at 0.58, margin now -14. POR generation advantage has not translated for 3 straight polls. PHX defense adjusting.\n  RISK: Same structural concerns. The monitor has observed divergence for 6+ minutes — floor says POR controls but the game says PHX does. Effort-based edge not converting.'
    }},

    // ── ADVERSARIAL: I4 COMBO YES UNDER MAXIMUM PRESSURE (37-38) ─────────

    '37': { name: 'ADVERSARIAL: FIRED BUY + DOMINANT + I4 YES — monitor screaming but must SEND with CAUTION', expected: 'SEND', expectCaution: true, ctx: {
      alertType: 'BUY', alertTier: 'FIRED', controlTeam: 'DAL', floor: 0.73, margin: 14,
      isTrailing: true, period: 3, clock: '2:00', minsLeft: 14,
      edge: 25.0, ml: '+520', spread: '-7.5', tpClass: 'PROBABLE', lsClass: null,
      ctrlSust: 'DURABLE', oppSust: 'DURABLE', windowScore: null,
      i1: 0.72, i2: 0.70, i3: 0.55, i4: 0.78, i5: 0.68,
      indicatorsWon: 4, indWon: 'I1+I2+I4+I5', indLost: '',
      i4Decisive: true, i4Won: true, i4Combo: true,
      convictionTier: 'DOMINANT', convictionCombo: 'I1+I2+I4+I5',
      floorHistory:'Q3 2:00: DAL 0.73 (58-72) TP:PROBABLE\nQ3 6:00: DAL 0.70 (52-66) TP:PROBABLE\nQ3 10:00: DAL 0.67 (46-58) TP:CONTESTED\nQ2 4:00: DAL 0.64 (38-48) TP:CONTESTED\nQ2 8:00: DAL 0.60 (30-38) TP:UNLIKELY',
      priorAlerts:'AUTO_ANALYSIS Q3 12:00: floor 0.65, margin 10 trailing → SEND: "DAL structural thesis is compromised. Floor reads 0.65 but margin has grown from -8 to -12 since Q2. Paint gap 26-20 looks commanding but LAC is converting at elite efficiency — 52% eFG on contested looks. DAL turnovers at 12 are feeding LAC transition. The structural edge is real but the opponent is not regressing."',
      quarterSummary:'Q1: 18-24, paint 14-10, TO 3-5\nQ2: 20-24, paint 12-10, TO 5-3\nQ3: 20-24, paint 10-12, TO 4-2',
      monitorContext: 'Q3 8:00: MOMENTUM RISING (6 polls, +0.10) | OPP SUST: STABLE (DURABLE) | FLOOR-MARGIN: DIVERGING\n  OBS: DAL floor has risen steadily from 0.60 to 0.70 across 20 minutes of game time, but margin has worsened from -8 to -14 in the same window. This is a textbook divergence — the structural read says DAL dominates but the scoreboard disagrees emphatically. LAC paint defense has adjusted since Q2, cutting DAL paint advantage from 14-10 to 10-12 in Q3.\n  RISK: LAC shooting is DURABLE at 42% from 3 on 30 attempts — this is NOT variance, this is elite perimeter execution on high volume. DAL turnovers have climbed from 3 (Q1) to 12 cumulative, feeding 16 LAC points off turnovers. The floor is being propped by cumulative Q1-Q2 dominance that has fully eroded in Q3. I2 paint edge has FLIPPED in the current quarter.\nQ3 4:00: MOMENTUM RISING (8 polls, +0.13) | OPP SUST: STABLE (DURABLE) | FLOOR-MARGIN: DIVERGING\n  OBS: Divergence has persisted for 8 consecutive polls (~24 minutes). Floor now 0.73 but margin -14. DAL Q3 is being outscored 20-24 — the quarter-level data directly contradicts the cumulative floor. LAC bench has outscored DAL bench 24-8.\n  RISK: This is the exact failure mode where cumulative floor anchoring produces false signals. DAL dominated Q1-Q2 structurally but LAC has adjusted. Q3 paint is 10-12 (flipped), Q3 turnovers are 4-2 (DAL advantage gone). The floor of 0.73 reflects a game that no longer exists. Prior auto-analysis flagged this at Q3 12:00 — nothing has improved since.\nQ3 1:00: MOMENTUM STABLE | OPP SUST: STABLE (DURABLE) | FLOOR-MARGIN: DIVERGING\n  OBS: Floor plateaued at 0.73, margin still -14. 25+ minutes of divergence. Every structural advantage DAL had in Q1-Q2 has eroded or flipped in Q3. LAC is the better team in the current quarter by every metric.\n  RISK: I4 COMBO YES is anchored to cumulative biggest_lead (DAL had a 4pt lead in Q1) and pre-Q4 season scoring margin. The live game has moved past both of those inputs. If this were computed fresh from Q3 data alone, I4 would be EVEN or LOST.'
    }},

    '38': { name: 'REALISTIC 2%: FIRED BUY + DOMINANT + I4 YES — talent ceiling, must SEND with CAUTION', expected: 'SEND', expectCaution: true, ctx: {
      alertType: 'BUY', alertTier: 'FIRED', controlTeam: 'CLE', floor: 0.68, margin: 8,
      isTrailing: true, period: 4, clock: '8:00', minsLeft: 8,
      edge: 15.0, ml: '+300', spread: '-4.5', tpClass: 'PROBABLE', lsClass: null,
      ctrlSust: 'DURABLE', oppSust: 'LOCKED IN', windowScore: null,
      i1: 0.65, i2: 0.68, i3: 0.52, i4: 0.72, i5: 0.62,
      indicatorsWon: 3, indWon: 'I1+I2+I4', indLost: 'I3',
      i4Decisive: true, i4Won: true, i4Combo: true,
      convictionTier: 'STRONG', convictionCombo: 'I3+I4',
      floorHistory:'Q4 8:00: CLE 0.68 (78-86) TP:PROBABLE\nQ3 6:00: CLE 0.70 (70-78) TP:PROBABLE\nQ3 12:00: CLE 0.72 (60-66) TP:PROBABLE\nQ2 6:00: CLE 0.65 (42-48) TP:CONTESTED',
      priorAlerts:'BUY[FIRED] Q3 10:00: floor 0.72, margin 6 trailing → SEND\nAUTO_ANALYSIS Q3 12:00: floor 0.70 → SEND: "CLE structural control clear — paint 34-22, I4 decisive. But BOS shooting is LOCKED IN at 44% from 3 on 32 attempts. This is not regression territory — BOS has 4 shooters above 40% tonight. The structural edge is real but the opponent may simply be better at converting."',
      quarterSummary:'Q1: 22-26, paint 14-8, TO 3-5\nQ2: 20-22, paint 10-8, TO 2-3\nQ3: 18-22, paint 10-6, TO 3-2\nQ4: 8-10',
      monitorContext: 'Q4 10:00: MOMENTUM FALLING (3 polls, -0.04) | OPP SUST: STABLE (LOCKED IN) | FLOOR-MARGIN: DIVERGING\n  OBS: CLE floor has dropped from 0.72 to 0.68 entering Q4 while trailing by 8. BOS shooting remains LOCKED IN — 44% from 3 on 34 attempts with 4 players above 40%. This is not a hot streak, this is a team executing within its talent ceiling. CLE paint dominance (34-22) is real but BOS is getting equivalent value from the perimeter.\n  RISK: BOS sust LOCKED IN is the critical factor. CLE structural control depends on BOS regression that is not coming. The sustainability model says LOCKED IN because BOS is shooting BELOW their season 3PT% with good shot quality (high assist ratio, catch-and-shoot heavy). I4 COMBO YES is based on biggest_lead gap and season scoring margin — but BOS Q3+Q4 scoring has been better than CLE in both quarters. Floor declining from 0.72 suggests the cumulative edge is eroding as BOS talent asserts itself.\nQ4 6:00: MOMENTUM FALLING (5 polls, -0.06) | OPP SUST: STABLE (LOCKED IN) | FLOOR-MARGIN: DIVERGING\n  OBS: Floor now 0.68, down from 0.72 peak. Margin unchanged at -8, but CLE was outscored 8-10 in early Q4. BOS sustainability has been LOCKED IN for the entire second half with zero degradation. CLE paint advantage has shrunk to 34-24 as BOS adjusted interior defense.\n  RISK: This matches the known TP limitation — structRate cannot distinguish effort from talent. CLE hustle metrics (steals, OREB) are strong but BOS is simply executing at a higher talent level. The structural read says CLE should close the gap. The talent read says BOS will not let them.'
    }},
  };

  let testKeys = [];
  if (testParam === 'all') testKeys = Object.keys(scenarios);
  // Batches of 3 — use ?test=b1 through ?test=b11
  else if (testParam === 'b1') testKeys = ['1', '2', '3', '4'];
  else if (testParam === 'b2') testKeys = ['5', '6', '7', '8'];
  else if (testParam === 'b3') testKeys = ['9', '10', '11', '12'];
  else if (testParam === 'b4') testKeys = ['13', '14', '15', '16'];
  else if (testParam === 'b5') testKeys = ['17', '18', '19', '20'];
  else if (testParam === 'b6') testKeys = ['21', '22', '23', '24'];
  else if (testParam === 'b7') testKeys = ['25', '26', '27', '28'];
  else if (testParam === 'b8') testKeys = ['29', '30', '31', '32'];
  else if (testParam === 'b9') testKeys = ['33', '34', '35', '36'];
  else if (testParam === 'monitor') testKeys = ['33', '34', '35', '36'];
  else if (testParam === 'adversarial') testKeys = ['37', '38'];
  // Individual: ?test=5 or comma-separated: ?test=19,20,26
  else if (testParam.includes(',')) testKeys = testParam.split(',').filter(k => scenarios[k.trim()]).map(k => k.trim());
  else if (scenarios[testParam]) testKeys = [testParam];
  else return new Response(JSON.stringify({ error: 'Unknown test: ' + testParam }));

  const results = [];
  for (const key of testKeys) {
    const s = scenarios[key];
    console.log('Test ' + key + ': ' + s.name);
    const r = await callAgent(s.ctx);
    results.push({
      test: key, name: s.name, expected: s.expected, actual: r.decision,
      pass: s.expected === '?' ? 'OBSERVE' : (r.decision === s.expected ? (s.expectCaution && !(/CAUTION/i.test(r.body)) ? 'FAIL' : 'PASS') : 'FAIL'),
      reasoning: r.reasoning,
      body: s.expectCaution ? r.body.substring(0, 200) : undefined,
      hasCaution: s.expectCaution ? /CAUTION/i.test(r.body) : undefined,
      tokens: r.tokens ? r.tokens.input_tokens + 'in/' + r.tokens.output_tokens + 'out' : '?',
    });
    if (testKeys.length > 1) await new Promise(r => setTimeout(r, 500));
  }

  var gradedResults = results.filter(r => r.pass !== 'OBSERVE');
  var observeCount = results.filter(r => r.pass === 'OBSERVE').length;

  return new Response(JSON.stringify({
    summary: gradedResults.filter(r => r.pass === 'PASS').length + '/' + gradedResults.length + ' passed' + (observeCount > 0 ? ' + ' + observeCount + ' observed' : ''),
    results,
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}

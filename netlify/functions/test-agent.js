// test-agent.js — One-shot test of the alert reasoning agent
// Hit: /.netlify/functions/test-agent?test=fired or ?test=candidate or ?test=both

export default async function handler(req) {
  const url = new URL(req.url, 'https://x.com');
  const test = url.searchParams.get('test') || 'both';
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return new Response(JSON.stringify({ error: 'No API key' }), { status: 500 });

  const results = [];

  async function runAgent(ctx) {
    const prompt = `You are a live NBA betting alert quality agent. A mechanical system has identified a potential betting signal. Your job is to assess whether it should be sent to the bettor.

ALERT:
Type: ${ctx.alertType} (${ctx.alertTier})
Control team: ${ctx.controlTeam} | Floor: ${ctx.floor} | Margin: ${ctx.margin} (${ctx.isTrailing ? 'trailing' : 'leading'})
Period: Q${ctx.period} ${ctx.clock} | Minutes left: ${ctx.minsLeft}
Edge: ${ctx.edge != null ? ctx.edge + '%' : 'N/A'} | ML: ${ctx.ml || 'N/A'} | Spread: ${ctx.spread || 'N/A'}
TP: ${ctx.tpClass || 'N/A'} | LS: ${ctx.lsClass || 'N/A'}
Ctrl sust: ${ctx.ctrlSust || 'N/A'} | Opp sust: ${ctx.oppSust || 'N/A'}
Window score: ${ctx.windowScore || 'N/A'}

INDICATORS (control-team-relative):
I1 Possession: ${ctx.i1} | I2 Rim/Foul: ${ctx.i2} | I3 Shot Quality: ${ctx.i3} | I4 Lineup: ${ctx.i4} | I5 Tempo: ${ctx.i5}
Indicators won by control team: ${ctx.indicatorsWon}/5

FLOOR TRAJECTORY (recent snapshots, newest first):
${ctx.floorHistory || 'No prior snapshots'}

PRIOR ALERTS THIS GAME:
${ctx.priorAlerts || 'None'}

QUARTER PERFORMANCE:
${ctx.quarterSummary || 'N/A'}

RULES:
- FIRED alerts passed all mechanical thresholds. You should SEND unless you see a clear structural contradiction.
- CANDIDATE alerts failed a soft threshold but might still have value. You should SEND only if the structural case is compelling despite the threshold miss.
- BUY/WINDOW BUY: the thesis is "structurally dominant team is trailing due to unsustainable opponent variance." Verify the control team actually dominates AND the opponent's lead is variance-driven.
- Be skeptical of high floors (0.75+) at small margins (1-3 pts) — floor may be anchored from earlier dominance that's fading.
- CANDIDATE BUYs at floor 0.55-0.65: only SEND if indicators strongly favor control team (3+ of 5) AND opponent sustainability is weak.

Respond in EXACTLY this format:
DECISION: [SEND|SUPPRESS|DOWNGRADE]
REASONING: [1-2 sentences explaining why]
BODY: [If SEND/DOWNGRADE: enhanced plain-English alert body for the bettor. If SUPPRESS: leave blank]`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) return { error: `API ${resp.status}`, body: await resp.text() };
    const data = await resp.json();
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    return { raw: text, usage: data.usage };
  }

  // TEST 1: FIRED BUY — DEN trailing 12, strong structural (POR@DEN style)
  if (test === 'fired' || test === 'both') {
    console.log('Running FIRED BUY test...');
    const r = await runAgent({
      alertType: 'BUY', alertTier: 'FIRED',
      controlTeam: 'DEN', floor: '0.72', margin: 12, isTrailing: true,
      period: 4, clock: '10:02', minsLeft: '10.0',
      edge: 18.5, ml: '+750', spread: '+7.5',
      tpClass: 'CONTESTED', lsClass: null,
      ctrlSust: 'DURABLE', oppSust: 'FRAGILE',
      windowScore: null,
      i1: '0.70', i2: '0.80', i3: '0.55', i4: '0.65', i5: '0.60',
      indicatorsWon: 4,
      floorHistory: 'Q3 2:15: DEN 0.68 (98-110) TP:CONTESTED LS:?\nQ3 6:30: DEN 0.71 (88-97) TP:PROBABLE LS:?\nQ2 4:00: DEN 0.65 (62-71) TP:PROBABLE LS:?',
      priorAlerts: 'RECOVERY PATH Q3 6:30: floor 0.71, margin 9 trailing, sust DURABLE/FRAGILE',
      quarterSummary: 'Q1: 28-32 pts, paint 18-12, TO 3-5\nQ2: 24-30 pts, paint 16-10, TO 2-4\nQ3: 26-22 pts, paint 14-8, TO 1-3',
    });
    results.push({ test: 'FIRED BUY — DEN trailing 12 (POR@DEN style, should SEND)', ...r });
  }

  // TEST 2: CANDIDATE BUY — DAL trailing 8, effort-based (DAL@LAC style, should SUPPRESS)
  if (test === 'candidate' || test === 'both') {
    console.log('Running CANDIDATE BUY test...');
    const r = await runAgent({
      alertType: 'BUY', alertTier: 'CANDIDATE',
      controlTeam: 'DAL', floor: '0.58', margin: 8, isTrailing: true,
      period: 3, clock: '4:49', minsLeft: '16.8',
      edge: 5.2, ml: '+180', spread: '+4.5',
      tpClass: 'PROBABLE', lsClass: null,
      ctrlSust: 'LOCKED IN', oppSust: 'FRAGILE',
      windowScore: null,
      i1: '0.55', i2: '0.60', i3: '0.40', i4: '0.50', i5: '0.45',
      indicatorsWon: 2,
      floorHistory: 'Q3 8:00: DAL 0.55 (56-64) TP:CONTESTED LS:?\nQ2 6:00: DAL 0.62 (38-42) TP:PROBABLE LS:?\nQ2 10:00: DAL 0.58 (22-28) TP:PROBABLE LS:?',
      priorAlerts: 'None',
      quarterSummary: 'Q1: 22-28 pts, paint 14-10, TO 5-2\nQ2: 16-14 pts, paint 12-8, TO 4-3\nQ3 (partial): 18-22 pts, paint 10-14, TO 3-1',
    });
    results.push({ test: 'CANDIDATE BUY — DAL trailing 8 (DAL@LAC style, should SUPPRESS)', ...r });
  }

  return new Response(JSON.stringify({ results }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}

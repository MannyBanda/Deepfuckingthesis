// Live Game Analysis via Claude Sonnet - Predictive Layer v3.0
// Lean prompt, full data, trust Sonnet's basketball intelligence

const SYSTEM_PROMPT = `You are an elite NBA live-game analyst providing real-time control assessment and outcome prediction for sports betting.

CORE TASK: Determine which team structurally controls this game and predict who wins, using the full game summary data provided.

FIVE INDICATORS (score each 0.00-1.00 for the controlling team):
I1 Possession & Transition (25%): TO margin, steals, OREBs, fast break pts, pts off TOs, second chance pts
I2 Rim Pressure & Foul (25%): Paint points, at-rim FG, FTA, blocks, fouls, bonus status
I3 Shot Quality & Creation (20%): eFG%, assist ratio (65%+ sustainable, <50% isolation-dependent), shot diet
I4 Lineup Integrity (20%): Biggest lead, bench contribution, which lineups producing, plus/minus
I5 Tempo & Efficiency (10%): Possessions, pts/possession differential, pace control

CONTROL: 0.90+ DOMINANT | 0.75-0.89 STRONG | 0.60-0.74 EARNED | 0.45-0.59 NO EDGE | <0.45 WAIT

EIGHT TRAJECTORY SIGNALS (evaluate for BOTH teams):
T1 Role Player Heater | T2 Star Process Integrity | T3 Quarter Delta (highest weight) | T4 Foul Gate | T5 Interior Trend | T6 Quarter Assist Ratio | T7 Closing Lineup | T8 Shot Diet Misalignment

CRITICAL RULES:

1. SUSTAINABILITY BEFORE PREDICTION: Audit the leading team's production before predicting. Hot 3PT shooting above season norms, role player heaters, interior teams jacking threes (T8) = UNSUSTAINABLE variance, not real control. Cap their win probability and flag the trailing team as the entry opportunity. UNSUSTAINABLE teams cannot get DOMINANT/STRONG conviction or OPTIMAL WINDOW entry.

2. TEAM QUALITY MATTERS: A bad team (bottom-12, missing stars) leading a good team (top-12, full strength) is almost always variance. The spread tells you what the market expects. If you disagree by 30%+, re-examine.

3. MIP IS PRE-COMPUTED: MIP values are provided per team. Edge = YOUR FWP for the predicted winner MINUS that SAME team's MIP. Example: If you predict NOP wins with FWP 75% and NOP's MIP is 97%, Edge = 75% - 97% = -22% (COUNTER-SIGNAL). Do NOT subtract the losing team's MIP.

4. COHERENCE CHECK: Your prediction MUST match your sustainability assessment. If you flag UNSUSTAINABLE, you cannot recommend entry on that team.

5. CONVICTION:
  DOMINANT = sustainable control 0.85+ by a quality team
  STRONG = sustainable control 0.70+
  EARNED = sustainable/mixed control 0.60+ with edge
  CONDITIONAL = sustainability or quality concerns
  NO ENTRY = unsustainable leader, mixed signals, no edge

6. ENTRY TIMING:
  OPTIMAL WINDOW = thesis-favored team trailing while opponent has UNSUSTAINABLE production
  WINDOW OPEN = positive edge + sustainable control confirmed
  WINDOW CLOSING = edge narrowing as market corrects
  NO WINDOW = no structural edge
  COUNTER-SIGNAL = thesis team trailing against SUSTAINABLE opponent control

OUTPUT FORMAT (follow exactly):

DECISION:
EDGE: [+X% | No market data] | FWP: [X%] | MIP: [X% | N/A]
ENTRY: [OPTIMAL WINDOW | WINDOW OPEN | WINDOW CLOSING | NO WINDOW | COUNTER-SIGNAL]
CONVICTION: [DOMINANT | STRONG | EARNED | CONDITIONAL | NO ENTRY]
Sustainability: [TeamA]: [SUSTAINABLE|MIXED|UNSUSTAINABLE] | [TeamB]: [SUSTAINABLE|MIXED|UNSUSTAINABLE]
Team Quality: [context for both teams]
Clutch: [Tier X] — [CLEAR|WATCH|FIRES|NEUTRALIZED]
Prediction: [1-line decisive call]

EVIDENCE:
CONTROL: [Team] [score] — [level]

I1 Possession & Transition (25%): [team] [score] — [explanation]
I2 Rim Pressure & Foul (25%): [team] [score] — [explanation]
I3 Shot Quality & Creation (20%): [team] [score] — [explanation]
I4 Lineup Integrity (20%): [team] [score] — [explanation]
I5 Tempo & Efficiency (10%): [team] [score] — [explanation]

TRAJECTORY: [team or NEUTRAL] — [count]/8 signals
T1 — Role Player Heater: [detail or CLEAR]
T2 — Star Process Integrity: [detail or CLEAR]
T3 — Quarter Delta: [detail or CLEAR]
T4 — Foul Gate: [detail or CLEAR]
T5 — Interior Trend: [detail or CLEAR]
T6 — Quarter Assist Ratio: [detail or CLEAR]
T7 — Closing Lineup: [detail or CLEAR]
T8 — Shot Diet Misalignment: [detail or CLEAR]

THESIS STATUS: [CONFIRMED|DEVELOPING|CONTESTED|DENIED] — [note]
DIVERGENCE NOTES: [where your scores differ from dashboard and why]

Be concise. 1 line per indicator. Decisive when clear. Passing is correct when it isn't.`;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  }

  try {
    const { summaryData, thesis, homeTeam, awayTeam, period, score, clutchData, oddsData, edgeHistory, trackingData } = JSON.parse(event.body);

    if (!summaryData) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'summaryData required' }) };
    }

    // ── CLUTCH SECTION ──
    let clutchSection = '';
    if (clutchData) {
      const tierLabel = clutchData.tier === 1 ? 'L15 NBA.com Tier 1' : clutchData.tier === 2 ? 'Season BDL Tier 2' : 'Tier 3';
      clutchSection = `\nCLUTCH (${tierLabel}):\n`;
      clutchSection += `${awayTeam}: NetRtg ${clutchData.away?.netRtg ?? 'N/A'} OffRtg ${clutchData.away?.offRtg ?? 'N/A'} DefRtg ${clutchData.away?.defRtg ?? 'N/A'} ${clutchData.away?.wl ?? ''}\n`;
      clutchSection += `${homeTeam}: NetRtg ${clutchData.home?.netRtg ?? 'N/A'} OffRtg ${clutchData.home?.offRtg ?? 'N/A'} DefRtg ${clutchData.home?.defRtg ?? 'N/A'} ${clutchData.home?.wl ?? ''}\n`;
      const hNet = clutchData.home?.netRtg, aNet = clutchData.away?.netRtg;
      if (hNet != null && aNet != null) {
        const better = hNet > aNet ? homeTeam : awayTeam;
        clutchSection += `Edge: ${better} by ${Math.abs(hNet - aNet).toFixed(1)} NetRtg\n`;
      }
      if (clutchData.tier <= 2) {
        const h = clutchData.home || {}, a = clutchData.away || {};
        if (a.efg != null) clutchSection += `${awayTeam}: eFG ${a.efg}% TS ${a.ts ?? '?'}% TOV% ${a.tovPct ?? '?'} Pace ${a.pace ?? '?'}\n`;
        if (h.efg != null) clutchSection += `${homeTeam}: eFG ${h.efg}% TS ${h.ts ?? '?'}% TOV% ${h.tovPct ?? '?'} Pace ${h.pace ?? '?'}\n`;
        if (a.fbp != null) clutchSection += `${awayTeam} conv: FBP ${a.fbp} POT ${a.pot ?? '?'} Paint ${a.paint ?? '?'}\n`;
        if (h.fbp != null) clutchSection += `${homeTeam} conv: FBP ${h.fbp} POT ${h.pot ?? '?'} Paint ${h.paint ?? '?'}\n`;
        if (a.pctPts3pt != null) clutchSection += `${awayTeam} diet: 3PT% ${a.pctPts3pt} Paint% ${a.pctPtsPaint ?? '?'} FT% ${a.pctPtsFt ?? '?'}\n`;
        if (h.pctPts3pt != null) clutchSection += `${homeTeam} diet: 3PT% ${h.pctPts3pt} Paint% ${h.pctPtsPaint ?? '?'} FT% ${h.pctPtsFt ?? '?'}\n`;
      }
    } else {
      clutchSection = '\nCLUTCH: Not provided.\n';
    }

    // ── ODDS + SERVER-SIDE MIP ──
    let oddsSection = '';
    if (oddsData && (oddsData.homeML || oddsData.homeSpread)) {
      function mlToProb(ml) {
        const n = parseFloat(ml);
        if (isNaN(n) || n === 0) return null;
        return n < 0 ? Math.abs(n) / (Math.abs(n) + 100) : 100 / (n + 100);
      }
      const homeMIP = mlToProb(oddsData.homeML);
      const awayMIP = mlToProb(oddsData.awayML);
      let mipNote = '';
      if (homeMIP !== null && awayMIP !== null) {
        const vigSum = homeMIP + awayMIP;
        const homeNorm = (homeMIP / vigSum * 100).toFixed(1);
        const awayNorm = (awayMIP / vigSum * 100).toFixed(1);
        mipNote = `\nPRE-COMPUTED MIP: If ${homeTeam} wins → Edge = FWP - ${homeNorm}% | If ${awayTeam} wins → Edge = FWP - ${awayNorm}%\nUse the MIP of the team you are PREDICTING TO WIN. Do not use the other team's MIP.\n`;
      }
      oddsSection = `\nMARKET: Spread ${homeTeam} ${oddsData.homeSpread ?? 'N/A'} | ML ${awayTeam} ${oddsData.awayML ?? 'N/A'} / ${homeTeam} ${oddsData.homeML ?? 'N/A'} | O/U ${oddsData.total ?? 'N/A'}${mipNote}\n`;
    } else {
      oddsSection = '\nMARKET: No odds.\n';
    }

    // ── TRACKING ──
    let trackingSection = '';
    if (trackingData) {
      const h = trackingData.home || {}, a = trackingData.away || {};
      trackingSection = '\nSHOOTING BASELINES:\n';
      if (h.catchAndShoot || a.catchAndShoot) trackingSection += `C&S: ${awayTeam} ${a.catchAndShoot?.efg ?? '?'}% | ${homeTeam} ${h.catchAndShoot?.efg ?? '?'}%\n`;
      if (h.pullUp || a.pullUp) trackingSection += `Pull-up: ${awayTeam} ${a.pullUp?.efg ?? '?'}% | ${homeTeam} ${h.pullUp?.efg ?? '?'}%\n`;
    }

    // ── EDGE HISTORY ──
    let edgeSection = '';
    if (edgeHistory && edgeHistory.length > 0) {
      edgeSection = '\nEDGE HISTORY:\n' + edgeHistory.map(e => `${e.time} | ${e.edge} FWP ${e.fwp} | ${e.control} ${e.score}`).join('\n') + '\n';
    }

    // ── FULL DATA — no trimming ──
    const userPrompt = `${awayTeam} @ ${homeTeam} | ${period} | ${score}

${thesis ? `THESIS:\n${thesis}\n` : 'No thesis.'}
${clutchSection}${oddsSection}${trackingSection}${edgeSection}
GAME DATA:
${JSON.stringify(summaryData)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text();
      return { statusCode: resp.status, headers, body: JSON.stringify({ error: `Anthropic ${resp.status}: ${errText.substring(0, 300)}` }) };
    }

    const data = await resp.json();
    const analysis = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

    return { statusCode: 200, headers, body: JSON.stringify({ analysis, usage: data.usage }) };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { statusCode: 504, headers, body: JSON.stringify({ error: 'Analysis timed out (25s). Try again.' }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

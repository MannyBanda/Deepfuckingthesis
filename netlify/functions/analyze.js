// Live Game Analysis via Claude Sonnet — Predictive Layer v1.0
// Receives SR game summary + thesis + clutch + odds, returns structural + predictive analysis

const SYSTEM_PROMPT = `You are an NBA live-game control analyst and outcome predictor. You evaluate structural control using five weighted indicators and eight trajectory signals, then synthesize all available data into a progressive predictive assessment that sharpens each quarter.

You are cold, evidence-based, and never force conclusions. Passing is a correct outcome. But when control is established and signals confirm, you state the prediction clearly.

═══════════════════════════════════════════════════
STRUCTURAL CONTROL LAYER (Evidence)
═══════════════════════════════════════════════════

INDICATORS (weighted, 5-tier scoring):
  1.00 = Clear structural edge — multiple sub-layers confirm
  0.75 = Lean with caveats — leading most sub-layers but one soft
  0.50 = Genuinely contested — no meaningful separation
  0.25 = Opponent leans — opponent leads most sub-layers
  0.00 = Opponent controls — opponent dominates

I1 — Possession & Transition (25%): TO margin, steals, OREBs + POT, SCP, FBP. Evaluate forced vs unforced TOs if available.
I2 — Rim Pressure & Foul (25%): Paint points, at-rim FG, FTA, blocks, fouls, bonus.
I3 — Shot Quality & Creation (20%): eFG%, assist ratio (65%+ sustainable, <50% isolation-dependent), shot zone alignment.
I4 — Lineup Integrity (20%): Biggest lead, bench contribution, on_court flags, per-quarter plus/minus.
I5 — Tempo & Efficiency (10%): Possessions vs preferred pace, pts/possession differential (0.15+ significant).

CONTROL THRESHOLDS: 0.90+ DOMINANT | 0.75-0.89 STRONG | 0.60-0.74 EARNED | 0.45-0.59 NO EDGE | <0.45 WAIT

TRAJECTORY SIGNALS — evaluate for BOTH teams, always surface disconfirming evidence:
T1 — Role Player Heater: Non-star 60%+ FG or 55%+ 3PT on 5+ att, 15+ pts above norm. Check BOTH teams.
T2 — Star Process Integrity: Star 10%+ below FG baseline. Q-over-Q trend. Check BOTH teams.
T3 — Quarter Delta: Team winning current Q by 6+ while trailing = comeback trajectory. Highest weight.
T4 — Foul Gate: 2Q1=WATCH, 3Q2=CONSTRAINT, 4Q3=CRISIS. Check BOTH teams.
T5 — Interior Trend: At-rim att per quarter — rising/flat/falling. Check BOTH teams.
T6 — Quarter Assist Ratio: 20+ pt gap current Q vs cumulative. Check BOTH teams.
T7 — Closing Lineup: Closing lineup on floor + control = sustained. Bench = fragile.
T8 — Shot Diet Misalignment: Interior team shooting 40%+ 3PA = MISALIGNED (unsustainable variance). Check BOTH teams. THIS IS A CRITICAL PREDICTIVE SIGNAL — a team whose lead is built on shot diet misalignment is at high regression risk regardless of current margin.

═══════════════════════════════════════════════════
PREDICTIVE LAYER (Decision)
═══════════════════════════════════════════════════

This layer synthesizes structural control + clutch profile + shot sustainability + market pricing into a progressive outcome prediction. It sharpens each quarter:

STAGE-AWARE ASSESSMENT:
Q1: Low confidence. Pre-game thesis anchor applies. Flag early divergence but do not overweight one quarter.
Q2: Building confidence. Structural read stabilizing. Identify whether current production is sustainable or variance-driven. Key question: "Is this team's lead/deficit built on repeatable process or hot/cold shooting?"
Q3: High confidence. Full indicator data. Clutch profiles become relevant if margin < 10. Key question: "Can this team close? Does their shot diet and creation profile support holding/building this lead?"
Q4/Late Q3: Maximum confidence. Clutch gate fires. Sustainability is proven or denied. Key question: "Who wins this game and does the line offer value?"

FRAMEWORK WIN PROBABILITY (FWP):
Convert control score to win probability using this calibration curve:
  0.90+ control = 78-85% FWP
  0.75-0.89 = 65-77% FWP
  0.60-0.74 = 55-64% FWP
  0.45-0.59 = 40-54% FWP
  Below 0.45 = sub-40% FWP

Apply modifiers:
  - Sustainability discount: If T1 heater or T8 misalignment active on leading team, discount FWP by 5-10%
  - Clutch modifier (Q3+ if margin < 10): Poor clutch NetRtg (below -2.0) discounts by 5-8%. Elite clutch (above +5.0) adds 3-5%.
  - Stage compression: Q1 multiply deviation from 50% by 0.7. Q2 by 0.85. Q3+ full FWP.

MARKET EDGE:
If odds/spread provided:
  - Convert ML to Market Implied Probability (MIP). Normalize for vig.
  - Edge = FWP - MIP
  - +10%+ STRONG ENTRY | +5-9% MODERATE ENTRY | +1-4% MARGINAL | 0 to -4% NO EDGE | -5%+ COUNTER-SIGNAL

ENTRY TIMING:
  - Structurally superior team trailing = edge likely widening (OPTIMAL WINDOW approaching)
  - Structurally superior team leading by margin = edge likely narrow (market priced in)
  - Structurally superior team in close game = WINDOW OPEN
  - T8 or T1 active on leading team = opponent WINDOW OPEN (market may not have adjusted)

CLUTCH GATE (tiered authority):
  Tier 1 — L15 Manual (highest): User-provided L15 clutch data. Override everything.
    Leading team NetRtg above -1.5 = CLEAR | -1.5 to -4.0 = WATCH | Below -4.0 = FIRES
  Tier 2 — Season Proxy (auto): Derived from thesis Comeback Score + Lead-Keep Score.
    Both scores above 6.0 = CLEAR | Either below 5.0 = WATCH | Both below 5.0 = FIRES
    If thesis data unavailable, skip to Tier 3.
  Tier 3 — Win/Loss Delta (fallback): Flag reduced precision.
    Comeback < 5.0 = WATCH | Both Comeback + Lead-Keep < 5.0 = FIRES (reduced)
  
  ALWAYS compare relatively: if trailing team clutch is WORSE than leading team, gate neutralizes.
  DIVERGENCE FLAG: If L15 manual diverges >5pts from season proxy, surface as ⚠ CLUTCH DIVERGENCE — recent form shift.
  ALWAYS state which tier is driving the gate: "Clutch: Tier 1 (L15) — WATCH" or "Clutch: Tier 2 (proxy) — CLEAR"

SUSTAINABILITY ASSESSMENT:
  Rate each team: SUSTAINABLE | MIXED | UNSUSTAINABLE
  - 3PT% 8%+ above season norm = UNSUSTAINABLE
  - T8 MISALIGNED = UNSUSTAINABLE
  - High assist ratio + rim volume = SUSTAINABLE
  - Low assist ratio + high efficiency = FRAGILE
  CRITICAL: A team with UNSUSTAINABLE production leading is a FADE candidate regardless of current score.

ENTRY TIMING (progressive — track across check-ins):
  If edge history provided, identify:
  - Peak edge this game and when it occurred
  - Current edge vs peak (widening, stable, narrowing)
  - OPTIMAL WINDOW = edge within 2% of peak AND structural control confirms (0.60+)
  - WINDOW OPEN = positive edge + structural control, but not at peak
  - WINDOW CLOSING = edge was wider, now narrowing (market correcting)
  - NO WINDOW = edge below +5% or structural control doesn't confirm

═══════════════════════════════════════════════════
OUTPUT FORMAT — Use this EXACT structure
═══════════════════════════════════════════════════

DECISION:
EDGE: [+X% | No market data] | FWP: [X%] | MIP: [X% | N/A]
ENTRY: [OPTIMAL WINDOW | WINDOW OPEN | WINDOW CLOSING | NO WINDOW]
CONVICTION: [DOMINANT | STRONG | EARNED | CONDITIONAL | NO ENTRY]
Sustainability: [TeamA]: [SUSTAINABLE|MIXED|UNSUSTAINABLE] | [TeamB]: [SUSTAINABLE|MIXED|UNSUSTAINABLE]
Clutch: [Tier 1 (L15) | Tier 2 (proxy) | Tier 3 (delta) | No data] — [CLEAR|WATCH|FIRES|NEUTRALIZED]
Prediction: [1-line decisive predicted outcome with key reasoning — be specific about WHO WINS and WHY]

EVIDENCE:
CONTROL: [Team] [score] — [DOMINANT|STRONG|EARNED|NO EDGE|WAIT]

I1 Possession & Transition (25%): [team] [0.00-1.00] — [explanation]
I2 Rim Pressure & Foul (25%): [team] [0.00-1.00] — [explanation]
I3 Shot Quality & Creation (20%): [team] [0.00-1.00] — [explanation]
I4 Lineup Integrity (20%): [team] [0.00-1.00] — [explanation]
I5 Tempo & Efficiency (10%): [team] [0.00-1.00] — [explanation]

TRAJECTORY: [lean team or NEUTRAL] — [count]/8 signals
[List EVERY signal T1-T8 for BOTH teams. Always surface disconfirming signals.]

THESIS STATUS: [CONFIRMED|DEVELOPING|CONTESTED|DENIED] — [1-line note]

CRITICAL ENTRY LOGIC: THESIS STATUS and ENTRY are independent. A DENIED thesis does NOT mean NO ENTRY — evaluate the live-controlling team on their own merits. Only NO ENTRY when live control < 0.60 or signals genuinely mixed.

DIVERGENCE NOTES: Note where dashboard scores differ from yours and why.

Be concise. Each indicator = 1 line. Prediction = decisive when signals align. Do not hedge when data is clear.`;

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

    let clutchSection = '';
    if (clutchData) {
      const tierLabel = clutchData.tier === 1 ? 'L15 Manual — Tier 1' : clutchData.tier === 2 ? 'Season-Wide BDL — Tier 2' : 'Win/Loss Delta — Tier 3';
      clutchSection = `\nCLUTCH DATA (${tierLabel}):\n`;
      clutchSection += `${homeTeam}: NetRtg ${clutchData.home?.netRtg ?? 'N/A'} | OffRtg ${clutchData.home?.offRtg ?? 'N/A'} | DefRtg ${clutchData.home?.defRtg ?? 'N/A'} | GP ${clutchData.home?.gp ?? 'N/A'} | W-L ${clutchData.home?.wl ?? 'N/A'}\n`;
      clutchSection += `${awayTeam}: NetRtg ${clutchData.away?.netRtg ?? 'N/A'} | OffRtg ${clutchData.away?.offRtg ?? 'N/A'} | DefRtg ${clutchData.away?.defRtg ?? 'N/A'} | GP ${clutchData.away?.gp ?? 'N/A'} | W-L ${clutchData.away?.wl ?? 'N/A'}\n`;
      // Enriched fields from BDL (Tier 2)
      if (clutchData.tier === 2) {
        const h = clutchData.home || {}, a = clutchData.away || {};
        if (h.efg != null || h.ts != null) {
          clutchSection += `${homeTeam} clutch profile: eFG ${h.efg ?? '?'}% | TS ${h.ts ?? '?'}% | TOV ratio ${h.tovRatio ?? '?'} | PIE ${h.pie ?? '?'} | Pace ${h.pace ?? '?'}\n`;
        }
        if (a.efg != null || a.ts != null) {
          clutchSection += `${awayTeam} clutch profile: eFG ${a.efg ?? '?'}% | TS ${a.ts ?? '?'}% | TOV ratio ${a.tovRatio ?? '?'} | PIE ${a.pie ?? '?'} | Pace ${a.pace ?? '?'}\n`;
        }
        // Clutch conversion context (misc)
        if (h.fbp != null || h.paint != null) {
          clutchSection += `${homeTeam} clutch conversion: FBP ${h.fbp ?? '?'} | POT ${h.pot ?? '?'} | Paint ${h.paint ?? '?'} | SCP ${h.scp ?? '?'} | Opp paint ${h.oppPaint ?? '?'}\n`;
        }
        if (a.fbp != null || a.paint != null) {
          clutchSection += `${awayTeam} clutch conversion: FBP ${a.fbp ?? '?'} | POT ${a.pot ?? '?'} | Paint ${a.paint ?? '?'} | SCP ${a.scp ?? '?'} | Opp paint ${a.oppPaint ?? '?'}\n`;
        }
        // Clutch shot diet (scoring)
        if (h.pctPts3pt != null || h.pctPtsPaint != null) {
          clutchSection += `${homeTeam} clutch shot diet: %pts 3PT ${h.pctPts3pt ?? '?'} | %pts paint ${h.pctPtsPaint ?? '?'} | %pts FT ${h.pctPtsFt ?? '?'} | %assisted FGM ${h.pctAssistedFgm ?? '?'}\n`;
        }
        if (a.pctPts3pt != null || a.pctPtsPaint != null) {
          clutchSection += `${awayTeam} clutch shot diet: %pts 3PT ${a.pctPts3pt ?? '?'} | %pts paint ${a.pctPtsPaint ?? '?'} | %pts FT ${a.pctPtsFt ?? '?'} | %assisted FGM ${a.pctAssistedFgm ?? '?'}\n`;
        }
      }
      if (clutchData.comebackScore != null) clutchSection += `Comeback Score: ${homeTeam} ${clutchData.home?.comebackScore ?? '?'} | ${awayTeam} ${clutchData.away?.comebackScore ?? '?'}\n`;
      if (clutchData.leadKeepScore != null) clutchSection += `Lead-Keep Score: ${homeTeam} ${clutchData.home?.leadKeepScore ?? '?'} | ${awayTeam} ${clutchData.away?.leadKeepScore ?? '?'}\n`;
      if (clutchData.divergence) clutchSection += `⚠ DIVERGENCE: ${clutchData.divergence}\n`;
    } else {
      clutchSection = '\nCLUTCH DATA: Not provided. Use win/loss delta proxy from thesis if available. Flag as Tier 3 with reduced precision.\n';
    }

    let oddsSection = '';
    if (oddsData && (oddsData.homeML || oddsData.homeSpread)) {
      oddsSection = `\nMARKET DATA${oddsData.vendor ? ' ('+oddsData.vendor+')' : ''}:\nSpread: ${homeTeam} ${oddsData.homeSpread ?? 'N/A'} | ML: ${homeTeam} ${oddsData.homeML ?? 'N/A'} / ${awayTeam} ${oddsData.awayML ?? 'N/A'} | Total: ${oddsData.total ?? 'N/A'}\n`;
    } else {
      oddsSection = '\nMARKET DATA: Not provided. Skip edge calculation.\n';
    }

    let trackingSection = '';
    if (trackingData) {
      const h = trackingData.home || {}, a = trackingData.away || {};
      trackingSection = '\nTRACKING DATA (sustainability baselines):\n';
      if (h.catchAndShoot || a.catchAndShoot) {
        trackingSection += `Catch-and-shoot: ${homeTeam} eFG ${h.catchAndShoot?.efg ?? '?'}% 3PT% ${h.catchAndShoot?.fg3pct ?? '?'}% | ${awayTeam} eFG ${a.catchAndShoot?.efg ?? '?'}% 3PT% ${a.catchAndShoot?.fg3pct ?? '?'}%\n`;
      }
      if (h.pullUp || a.pullUp) {
        trackingSection += `Pull-up: ${homeTeam} eFG ${h.pullUp?.efg ?? '?'}% 3PT% ${h.pullUp?.fg3pct ?? '?'}% | ${awayTeam} eFG ${a.pullUp?.efg ?? '?'}% 3PT% ${a.pullUp?.fg3pct ?? '?'}%\n`;
      }
      trackingSection += 'Use these baselines to evaluate sustainability: if live 3PT% exceeds catch-and-shoot eFG by 8%+, flag as UNSUSTAINABLE. High pull-up efficiency = creation-based offense (more sustainable).\n';
    }

    let edgeSection = '';
    if (edgeHistory && edgeHistory.length > 0) {
      edgeSection = `\nEDGE HISTORY (previous check-ins this game):\n`;
      edgeSection += edgeHistory.map(e => `${e.time} | Edge: ${e.edge} | FWP: ${e.fwp} | Control: ${e.control} ${e.score}`).join('\n');
      edgeSection += '\nUse this to identify: peak edge, current trend (widening/stable/narrowing), and optimal entry timing.\n';
    }

    const userPrompt = `Analyze this live NBA game. Produce both the DECISION (predictive) and EVIDENCE (structural) layers.

GAME: ${awayTeam} @ ${homeTeam} | ${period} | Score: ${score}

${thesis ? `PRE-GAME THESIS:\n${thesis}\n` : 'No pre-game thesis provided.'}
${clutchSection}
${oddsSection}
${trackingSection}
${edgeSection}
SPORTRADAR GAME SUMMARY DATA:
${JSON.stringify(summaryData, null, 1)}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
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

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        statusCode: resp.status,
        headers,
        body: JSON.stringify({ error: `Anthropic ${resp.status}: ${errText.substring(0, 300)}` }),
      };
    }

    const data = await resp.json();
    const analysis = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ analysis, usage: data.usage }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

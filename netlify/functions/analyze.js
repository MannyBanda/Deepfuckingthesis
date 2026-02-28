// Live Game Analysis via Claude Sonnet
// Receives SR game summary + thesis, returns structural analysis

const SYSTEM_PROMPT = `You are an NBA live-game control analyst. You evaluate which team controls a game structurally using five weighted indicators and eight trajectory signals. You are cold, evidence-based, and never force conclusions. Passing is a correct outcome.

INDICATORS (weighted scoring — each scored 1.0, 0.5, or 0.0):
I1 — Possession & Transition (25%): TO margin, steals, OREBs (generation) + POT, SCP, FBP (conversion). Also evaluate forced vs unforced TOs from turnover_type if available.
I2 — Rim Pressure & Foul (25%): Paint points, at-rim FG (field_goals_at_rim_made/att), FTA, blocks, fouls, bonus status. Team leads at-rim att + FTA, OR blocks + opp fouls + paint pts.
I3 — Shot Quality & Creation (20%): eFG%, assist ratio (65%+ sustainable, <50% isolation-dependent), shot zone alignment vs structural identity.
I4 — Lineup Integrity (20%): Biggest lead, bench contribution, on_court flags for closing lineup, per-quarter plus/minus trends.
I5 — Tempo & Efficiency (10%): Possessions vs preferred pace, offensive/defensive_points_per_possession differential (0.15+ is significant).

CONTROL THRESHOLDS:
0.90+ = DOMINANT | 0.75-0.89 = STRONG | 0.60-0.74 = EARNED | 0.45-0.59 = NO EDGE | <0.45 = WAIT

TRAJECTORY SIGNALS (run from Q2 onward):
T1 — Role Player Heater: Non-star shooting 60%+ FG or 55%+ 3PT on 5+ attempts, 15+ pts above season norm.
T2 — Star Process Integrity: Star 10%+ below FG baseline. Check assists/rebounds/blocks trend Q-over-Q. Report: accelerating, intact, declining, or collapsed.
T3 — Quarter Delta (highest weight): Team winning current quarter by 6+ while trailing overall = active comeback trajectory.
T4 — Foul Gate: 2 fouls Q1=WATCH, 3 fouls Q2=CONSTRAINT, 4 fouls Q3=CRISIS. Cross-reference backup quality.
T5 — Interior Trend: At-rim attempt rate per quarter — rising, flat, or falling across 2+ quarters.
T6 — Quarter Assist Ratio: 20+ point gap current-quarter vs cumulative or vs opponent current-quarter.
T7 — Closing Lineup: Closing lineup on floor + control = sustained. Bench generating control = fragile/conditional.
T8 — Shot Diet Misalignment: Interior/transition team shooting 40%+ threes = MISALIGNED (unsustainable variance signal). Fires independently of other gates.

PRE-GAME DIVERGENCE GATE (Q1 only): When pre-game thesis was 0.70+ and live Q1 diverges 0.40+, audit variance sources before accepting live read.

THESIS CROSS-REFERENCE: Compare WATCH items from pre-game thesis against live indicators. Flag confirmed or denied.

OUTPUT FORMAT — Use this exact structure:
CONTROL: [Team] [score] — [DOMINANT|STRONG|EARNED|NO EDGE|WAIT]

I1 Possession & Transition (25%): [team] [1.0|0.5|0.0] — [explanation]
I2 Rim Pressure & Foul (25%): [team] [1.0|0.5|0.0] — [explanation]
I3 Shot Quality & Creation (20%): [team] [1.0|0.5|0.0] — [explanation]
I4 Lineup Integrity (20%): [team] [1.0|0.5|0.0] — [explanation]
I5 Tempo & Efficiency (10%): [team] [1.0|0.5|0.0] — [explanation]

TRAJECTORY: [lean team or NEUTRAL] — [count]/8 signals
[List each signal with detail]

KEY READS: [2-4 most important structural observations]
THESIS STATUS: [CONFIRMED|DEVELOPING|CONTESTED|DENIED] — [1-line note]
ENTRY/PASS: [Current recommendation based on structural read]

DIVERGENCE NOTES: If dashboard computed scores are provided, note where your indicator scores differ and why (e.g., "Dashboard scored I2 as contested but FTA trend is accelerating — I weight this as edge"). This helps calibrate the automated scoring.

Be concise. Each indicator explanation should be 1 line. Key reads should be actionable. Do not hedge excessively — state what the data shows.`;

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
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }),
    };
  }

  try {
    const { summaryData, thesis, homeTeam, awayTeam, period, score } = JSON.parse(event.body);

    if (!summaryData) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'summaryData required' }) };
    }

    const userPrompt = `Analyze this live NBA game. Evaluate all five indicators and trajectory signals using the data below.

GAME: ${awayTeam} @ ${homeTeam} | ${period} | Score: ${score}

${thesis ? `PRE-GAME THESIS:\n${thesis}\n` : 'No pre-game thesis provided.'}

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
        max_tokens: 1500,
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
    const analysis = data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ analysis, usage: data.usage }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

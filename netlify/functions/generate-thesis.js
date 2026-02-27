// Pre-Game Thesis Generation via Claude Sonnet
// Receives all SR pre-game data for both teams, returns compact thesis

const SYSTEM_PROMPT = `You are an NBA pre-game structural analyst. You build game thesis documents that predict where the structural battle will be fought and what to monitor live.

AVAILABILITY HARD GATE: Classify every key player: IN, IN (limited), OUT, UNKNOWN. OUT players removed from all evaluation. If unclear → NO EDGE / NO TRADE.

FIVE INDICATORS (weighted):
I1 — Possession & Transition (25%): TO margin tendencies, steals, OREBs, POT, SCP, FBP conversion rates. Who generates extra possessions and converts them.
I2 — Rim Pressure & Foul (25%): Paint scoring, at-rim rates, FTA generation, blocks, foul drawing. Interior control is the most predictive of sustained leads.
I3 — Shot Quality & Creation (20%): Assist ratio, eFG%, shot zone tendencies. 65%+ assist ratio = sustainable. <50% = isolation-dependent.
I4 — Lineup Integrity (20%): Bench depth, biggest lead tendencies, win/loss performance delta.
I5 — Tempo & Efficiency (10%): Preferred pace, pts/possession from splits.

SCORING: Each indicator 1.0 (clear edge), 0.5 (contested), 0.0 (opponent edge).
CONTROL: 0.90+ DOMINANT | 0.75-0.89 STRONG | 0.60-0.74 EARNED | 0.45-0.59 NO EDGE | <0.45 WAIT

ANALYTICAL LAYERS TO COMPUTE:
- Context-Adjusted Strength: Use home/away split (primary) blended with rest-bucket split (40% modifier). Fall back to season average only if no split applies.
- Structural Identity per indicator: Strong/Moderate/Weak based on relevant stat fields from splits.
- Shot Diet Classification: Interior/Transition dominant, Perimeter/Creation dominant, or Balanced.
- Win/Loss Delta: PPG, ORtg, 3PT%, TO rate swing between wins and losses. Low (<8 PPG) = consistent. High (15+) = fragile.
- Comeback Score (0-10): Based on offensive stability in losses.
- Lead-Keep Score (0-10): Based on defensive consistency across game states.
- Ball Handler Volatility (BHV): Primary PG TO rate. LOW <2.5, MODERATE 2.5-3.5, HIGH >3.5. New acquisitions (<4 weeks) auto-elevate one tier.
- Chaos Risk: HIGH BHV + opponent top-7 steals = CHAOS RISK HIGH.
- Foul Crisis Resilience: Compare starter vs backup at top-2 USG positions. HIGH/MODERATE/LOW.
- Pythagorean Win Expectation: Compare actual vs expected W-L. Cap control scores for teams 3+ wins above/below expected.
- System Resilience Modifier: Top-10 defensive teams with stars OUT get reduced degradation on I1 and I2.

OUTPUT FORMAT — Use this exact compact thesis structure:

COMPACT THESIS — [AWAY] vs [HOME] | [Time] ET
[Date] | [Venue]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

AVAILABILITY
[TEAM A]  [Player] ✅ IN | [Player] ❌ OUT | [Player] ⚠️ GTD
[TEAM B]  [Player] ✅ IN | [Player] ❌ OUT | [Player] ⚠️ GTD

REST       [TEAM A] X day | [TEAM B] X day

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTROL SCORE: [Team] [X.XX] — [Verdict]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

I1  Possession & Transition  (25%)   [Team 1.0 | CONTESTED 0.5 | Team 0.0]
[1-line reason]

I2  Rim Pressure & Foul      (25%)   [Team 1.0 | CONTESTED 0.5 | Team 0.0]
[1-line reason]

I3  Shot Quality & Creation  (20%)   [Team 1.0 | CONTESTED 0.5 | Team 0.0]
[1-line reason]

I4  Lineup Integrity         (20%)   [Team 1.0 | CONTESTED 0.5 | Team 0.0]
[1-line reason]

I5  Tempo & Efficiency       (10%)   [Team 1.0 | CONTESTED 0.5 | Team 0.0]
[1-line reason]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KEY FLAGS
⚠ [Flag 1]
⚠ [Flag 2]
✓ [Clean read note if applicable]

ENTRY      [Trigger condition]
PASS       [Pass condition]

WATCH
1. [Signal] — confirms if [X], denies if [Y]
2. [Signal] — confirms if [X], denies if [Y]
3. [Signal] — confirms if [X], denies if [Y]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Be precise and evidence-based. Every indicator score must be justified by specific data from the provided statistics. Do not hedge — state which team has the edge and why. If genuinely contested, score 0.5 with clear reasoning. WATCH items should be specific and testable during the live game.`;

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
    const {
      homeTeam,
      awayTeam,
      gameDate,
      venue,
      gameTime,
      injuries,
      homeProfile,
      awayProfile,
      homeDepth,
      awayDepth,
      homeStats,
      awayStats,
      homeSplitsGame,
      awaySplitsGame,
      homeSplitsSchedule,
      awaySplitsSchedule,
      standings,
    } = JSON.parse(event.body);

    const userPrompt = `Build a complete pre-game thesis for this NBA matchup using ALL provided data.

MATCHUP: ${awayTeam} @ ${homeTeam}
DATE: ${gameDate} | TIME: ${gameTime} ET
VENUE: ${venue || 'TBD'}

=== INJURY REPORT ===
${JSON.stringify(injuries, null, 1)}

=== ${homeTeam} PROFILE (roster + status flags) ===
${JSON.stringify(homeProfile, null, 1)}

=== ${awayTeam} PROFILE (roster + status flags) ===
${JSON.stringify(awayProfile, null, 1)}

=== ${homeTeam} DEPTH CHART ===
${JSON.stringify(homeDepth, null, 1)}

=== ${awayTeam} DEPTH CHART ===
${JSON.stringify(awayDepth, null, 1)}

=== ${homeTeam} SEASON STATISTICS ===
${JSON.stringify(homeStats, null, 1)}

=== ${awayTeam} SEASON STATISTICS ===
${JSON.stringify(awayStats, null, 1)}

=== ${homeTeam} SPLITS (Game: H/A, W/L, per-opponent) ===
${JSON.stringify(homeSplitsGame, null, 1)}

=== ${awayTeam} SPLITS (Game: H/A, W/L, per-opponent) ===
${JSON.stringify(awaySplitsGame, null, 1)}

=== ${homeTeam} SPLITS (Schedule: rest days) ===
${JSON.stringify(homeSplitsSchedule, null, 1)}

=== ${awayTeam} SPLITS (Schedule: rest days) ===
${JSON.stringify(awaySplitsSchedule, null, 1)}

=== STANDINGS ===
${JSON.stringify(standings, null, 1)}

Compute all analytical layers (strength profiles, structural identity, shot diet, BHV, chaos risk, foul resilience, Pythagorean check, win/loss delta) from this data. Output the compact thesis format.`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
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
    const thesis = data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ thesis, usage: data.usage }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

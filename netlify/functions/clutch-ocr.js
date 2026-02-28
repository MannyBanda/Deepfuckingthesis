// Clutch OCR — Extract L15 clutch stats from NBA.com screenshot
// Uses Claude Sonnet vision to parse the clutch table and return structured data
// Input: base64 image of NBA.com Teams > Clutch > Advanced > Last 10/15 Games table
// Output: { teams: { "BOS": { netRtg, offRtg, defRtg, gp, w, l, wl, efg, ts, pace, pie, ... }, ... } }

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
    const { image, mediaType, segment } = JSON.parse(event.body);
    // image = base64-encoded image data (no data:... prefix)
    // mediaType = "image/png" or "image/jpeg"
    // segment = "L10" or "L15" (for labeling, default L15)

    if (!image) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'image (base64) required' }) };
    }

    const mType = mediaType || 'image/png';
    const segLabel = segment || 'L15';

    const systemPrompt = `You are a precise data extraction tool. You extract NBA clutch statistics from screenshots of NBA.com tables.

TASK: Extract every team row visible in the screenshot. The table is from NBA.com > Teams > Clutch > Advanced stats.

OUTPUT FORMAT: Respond with ONLY a JSON object. No markdown, no backticks, no explanation. Just the raw JSON.

The JSON must have this exact structure:
{
  "segment": "${segLabel}",
  "teams": {
    "TEAM_ABBREV": {
      "netRtg": number,
      "offRtg": number,
      "defRtg": number,
      "gp": number,
      "w": number,
      "l": number,
      "efg": number,
      "ts": number,
      "pace": number,
      "pie": number,
      "astRatio": number,
      "tovPct": number,
      "orebPct": number,
      "drebPct": number
    }
  },
  "teamCount": number
}

TEAM ABBREVIATION MAPPING (use these exact abbreviations):
ATL, BOS, BKN, CHA, CHI, CLE, DAL, DEN, DET, GSW,
HOU, IND, LAC, LAL, MEM, MIA, MIL, MIN, NOP, NYK,
OKC, ORL, PHI, PHX, POR, SAC, SAS, TOR, UTA, WAS

Common name variations to map:
- "LA Clippers" or "Los Angeles Clippers" → LAC
- "LA Lakers" or "Los Angeles Lakers" → LAL  
- "Golden State" → GSW
- "New Orleans" → NOP
- "New York" → NYK
- "Oklahoma City" → OKC
- "Portland" → POR
- "San Antonio" → SAS

RULES:
- Extract ALL visible team rows, even if partially visible
- Numbers should be actual numeric values, not strings
- NetRtg, OffRtg, DefRtg can be negative — preserve the sign
- If a value is not visible or unclear, use null
- GP = Games Played, W = Wins, L = Losses
- eFG = Effective FG%, TS = True Shooting %, both as percentages (e.g., 52.3 not 0.523)
- teamCount = total number of teams extracted
- If you see column headers but can't identify which stat maps to which field, extract what you can and null the rest`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mType,
                data: image,
              },
            },
            {
              type: 'text',
              text: `Extract all team clutch stats from this NBA.com screenshot. This is the ${segLabel} segment (Last ${segLabel.replace('L','')} Games). Return ONLY the JSON object, no other text.`,
            },
          ],
        }],
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
    const rawText = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    // Parse JSON — strip any accidental markdown fencing
    const cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          error: 'Failed to parse extracted data',
          rawText: rawText.substring(0, 1000),
          parseError: parseErr.message,
        }),
      };
    }

    // Validate structure
    const teamCount = parsed.teams ? Object.keys(parsed.teams).length : 0;
    parsed.teamCount = teamCount;
    parsed.segment = segLabel;

    // Add wl field to each team for convenience
    if (parsed.teams) {
      for (const [abbrev, stats] of Object.entries(parsed.teams)) {
        if (stats.w != null && stats.l != null && !stats.wl) {
          stats.wl = `${stats.w}-${stats.l}`;
        }
      }
    }

    const usage = data.usage || {};

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...parsed,
        usage: { input: usage.input_tokens, output: usage.output_tokens },
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

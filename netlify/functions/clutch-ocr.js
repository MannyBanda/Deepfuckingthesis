// Clutch OCR - Extract L15 clutch stats from NBA.com screenshot
// Uses Claude vision to parse the clutch table and return structured data

exports.handler = async (event) => {
const headers = {
‘Access-Control-Allow-Origin’: ‘*’,
‘Access-Control-Allow-Headers’: ‘Content-Type’,
‘Access-Control-Allow-Methods’: ‘POST, OPTIONS’,
‘Content-Type’: ‘application/json’,
};

if (event.httpMethod === ‘OPTIONS’) {
return { statusCode: 204, headers, body: ‘’ };
}

if (event.httpMethod !== ‘POST’) {
return { statusCode: 405, headers, body: JSON.stringify({ error: ‘POST only’ }) };
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
return { statusCode: 500, headers, body: JSON.stringify({ error: ‘ANTHROPIC_API_KEY not configured’ }) };
}

let bodyPayload;
try {
bodyPayload = JSON.parse(event.body);
} catch (e) {
return { statusCode: 400, headers, body: JSON.stringify({ error: ’Invalid JSON body: ’ + e.message }) };
}

const { image, mediaType, segment, teams } = bodyPayload;

if (!image) {
return { statusCode: 400, headers, body: JSON.stringify({ error: ‘image (base64) required’ }) };
}

const mType = mediaType || ‘image/jpeg’;
const segLabel = segment || ‘L15’;
const teamFilter = Array.isArray(teams) && teams.length > 0 ? teams : null;

const filterInstruction = teamFilter
? `IMPORTANT: Only extract these specific teams: ${teamFilter.join(', ')}. Ignore all other rows in the table.`
: ‘Extract ALL visible team rows.’;

const systemPrompt = `You are a precise data extraction tool for NBA statistics tables.

TASK: ${filterInstruction}

Respond with ONLY a valid JSON object. No markdown fences, no backticks, no explanation text before or after. Just raw JSON.

Required structure:
{“teams”:{“ABBREV”:{“netRtg”:0,“offRtg”:0,“defRtg”:0,“gp”:0,“w”:0,“l”:0,“efg”:0,“ts”:0,“pace”:0,“pie”:0,“astRatio”:0,“tovPct”:0,“orebPct”:0,“drebPct”:0}}}

Use standard 3-letter NBA abbreviations: ATL BOS BKN CHA CHI CLE DAL DEN DET GSW HOU IND LAC LAL MEM MIA MIL MIN NOP NYK OKC ORL PHI PHX POR SAC SAS TOR UTA WAS

Rules:

- All values must be numbers (not strings). Negative values keep their sign.
- If a value is not visible, use null.
- eFG and TS as percentages (e.g. 52.3 not 0.523).
- Map team names: “LA Clippers”->LAC, “LA Lakers”->LAL, “Golden State”->GSW, “Oklahoma City”->OKC, etc.`;
  
  try {
  const anthropicBody = {
  model: ‘claude-sonnet-4-20250514’,
  max_tokens: teamFilter ? Math.max(1500, teamFilter.length * 300) : 4000,
  system: systemPrompt,
  messages: [{
  role: ‘user’,
  content: [
  {
  type: ‘image’,
  source: {
  type: ‘base64’,
  media_type: mType,
  data: image,
  },
  },
  {
  type: ‘text’,
  text: teamFilter
  ? ‘Extract clutch stats for ONLY: ’ + teamFilter.join(’, ’) + ‘. ’ + segLabel + ’ segment. JSON only.’
  : ‘Extract all team clutch stats. ’ + segLabel + ’ segment. JSON only.’,
  },
  ],
  }],
  };
  
  var controller = new AbortController();
  var timeout = setTimeout(function() { controller.abort(); }, 22000);
  
  const resp = await fetch(‘https://api.anthropic.com/v1/messages’, {
  method: ‘POST’,
  signal: controller.signal,
  headers: {
  ‘Content-Type’: ‘application/json’,
  ‘x-api-key’: apiKey,
  ‘anthropic-version’: ‘2023-06-01’,
  },
  body: JSON.stringify(anthropicBody),
  });
  clearTimeout(timeout);
  
  if (!resp.ok) {
  var errText = ‘’;
  try { errText = await resp.text(); } catch (_) {}
  return {
  statusCode: 200,
  headers,
  body: JSON.stringify({ error: ’Anthropic API ’ + resp.status + ’: ’ + errText.substring(0, 300) }),
  };
  }
  
  var data;
  try {
  data = await resp.json();
  } catch (e) {
  return {
  statusCode: 200,
  headers,
  body: JSON.stringify({ error: ’Failed to parse Anthropic response: ’ + e.message }),
  };
  }
  
  if (data.stop_reason === ‘max_tokens’) {
  return {
  statusCode: 200,
  headers,
  body: JSON.stringify({ error: ‘Response truncated. Try selecting fewer games.’ }),
  };
  }
  
  var contentBlocks = data.content || [];
  var rawText = contentBlocks
  .filter(function(b) { return b && b.type === ‘text’; })
  .map(function(b) { return b.text || ‘’; })
  .join(’\n’)
  .trim();
  
  if (!rawText) {
  return {
  statusCode: 200,
  headers,
  body: JSON.stringify({ error: ‘Empty response from vision model’, stop_reason: data.stop_reason }),
  };
  }
  
  var cleaned = rawText;
  cleaned = cleaned.replace(/^[`]{3,}[\w]*\n?/g, ''); cleaned = cleaned.replace(/\n?[`]{3,}\s*$/g, ‘’);
  cleaned = cleaned.trim();
  
  if (cleaned.charAt(0) !== ‘{’) {
  var jsonMatch = rawText.match(/{[\s\S]*}/);
  if (jsonMatch) {
  cleaned = jsonMatch[0];
  } else {
  return {
  statusCode: 200,
  headers,
  body: JSON.stringify({ error: ‘No JSON object found in response’, rawText: rawText.substring(0, 500) }),
  };
  }
  }
  
  var parsed;
  try {
  parsed = JSON.parse(cleaned);
  } catch (parseErr) {
  return {
  statusCode: 200,
  headers,
  body: JSON.stringify({
  error: ’JSON parse failed: ’ + parseErr.message,
  rawText: rawText.substring(0, 800),
  }),
  };
  }
  
  var teamsObj = parsed.teams || parsed;
  var normalized = {};
  var keys = Object.keys(teamsObj);
  
  for (var i = 0; i < keys.length; i++) {
  var key = keys[i];
  var stats = teamsObj[key];
  if (!stats || typeof stats !== ‘object’) continue;
  if (key.toLowerCase() === ‘segment’ || key.toLowerCase() === ‘teamcount’) continue;
  
  ```
  var abbrev = key.toUpperCase().substring(0, 3);
  if (abbrev.length === 3) {
    var netRtg = toNum(stats.netRtg || stats.net_rtg || stats.NetRtg);
    var offRtg = toNum(stats.offRtg || stats.off_rtg || stats.OffRtg);
    var defRtg = toNum(stats.defRtg || stats.def_rtg || stats.DefRtg);
    var gp = toNum(stats.gp || stats.GP);
    var w = toNum(stats.w || stats.W);
    var l = toNum(stats.l || stats.L);
  
    normalized[abbrev] = {
      netRtg: netRtg,
      offRtg: offRtg,
      defRtg: defRtg,
      gp: gp,
      w: w,
      l: l,
      efg: toNum(stats.efg || stats.eFG || stats.EFG),
      ts: toNum(stats.ts || stats.TS),
      pace: toNum(stats.pace || stats.Pace || stats.PACE),
      pie: toNum(stats.pie || stats.PIE),
      tovPct: toNum(stats.tovPct || stats.tov_pct || stats.TOV),
      orebPct: toNum(stats.orebPct || stats.oreb_pct || stats.OREB),
      drebPct: toNum(stats.drebPct || stats.dreb_pct || stats.DREB),
      astRatio: toNum(stats.astRatio || stats.ast_ratio || stats.AST_RATIO),
    };
    if (w != null && l != null) {
      normalized[abbrev].wl = w + '-' + l;
    }
  }
  ```
  
  }
  
  var teamCount = Object.keys(normalized).length;
  var usage = data.usage || {};
  
  return {
  statusCode: 200,
  headers,
  body: JSON.stringify({
  teams: normalized,
  teamCount: teamCount,
  segment: segLabel,
  usage: { input: usage.input_tokens, output: usage.output_tokens },
  }),
  };
  
  } catch (err) {
  if (err.name === ‘AbortError’) {
  return {
  statusCode: 200,
  headers,
  body: JSON.stringify({ error: ‘OCR timed out (22s). Try a smaller/lower-res screenshot.’ }),
  };
  }
  return {
  statusCode: 200,
  headers,
  body: JSON.stringify({ error: ’Function error: ’ + (err.message || String(err)) }),
  };
  }
  };

function toNum(val) {
if (val === null || val === undefined || val === ‘’ || val === ‘null’) return null;
if (val === 0) return 0;
var n = Number(val);
return isNaN(n) ? null : n;
}
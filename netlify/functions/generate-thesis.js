// Thin Anthropic proxy for thesis generation
exports.handler = async function(event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'POST only' }) };

  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };

  try {
    var body = JSON.parse(event.body);
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, 50000);

    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: body.systemPrompt,
        messages: [{ role: 'user', content: body.userPrompt }],
      }),
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      var errText = await resp.text();
      return { statusCode: resp.status, headers: headers, body: JSON.stringify({ error: 'Anthropic ' + resp.status + ': ' + errText.substring(0, 300) }) };
    }

    var data = await resp.json();
    var thesis = data.content.filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('\n');

    return { statusCode: 200, headers: headers, body: JSON.stringify({ thesis: thesis, usage: data.usage }) };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { statusCode: 504, headers: headers, body: JSON.stringify({ error: 'Thesis generation timed out (50s).' }) };
    }
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: err.message }) };
  }
};

// Thin Anthropic proxy for thesis generation
// Prompt is built client-side and sent as text — keeps body small

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
    const { systemPrompt, userPrompt } = JSON.parse(event.body);
    console.log('generate-thesis: body length:', (event.body||'').length, 'prompt length:', (userPrompt||'').length);

    if (!userPrompt) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'userPrompt required' }) };
    }

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
        system: systemPrompt || 'You are an NBA pre-game structural analyst.',
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Anthropic error:', resp.status, errText.substring(0, 500));
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
    console.error('generate-thesis error:', err.message, err.stack);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// test-fable.mjs — Claude Fable 5 smoke test (first Fable call in DFT)
//
// Purpose: de-risk SWEETSPOT_NARRATION_V2 (Fable 5 high effort + Opus 4.8 fallback)
// before build. Answers, from the PRODUCTION path (Netlify + ANTHROPIC_API_KEY):
//   1. Is claude-fable-5 enabled on DFT's API key?
//   2. Which request shape does the effort parameter take? (probes
//      output_config.effort first, falls back to top-level effort on 400)
//   3. Latency + token usage at high effort on a narration-shaped prompt —
//      THE number for the same-cycle tail-sweep design (~120s function budget).
//   4. Response shape: thinking blocks present? stop_reason? text extraction.
//   5. Opus 4.8 baseline on the identical prompt (?baseline=1).
//
// Params: ?model= (default claude-fable-5) · ?effort= (default high) ·
//         ?baseline=1 (also run claude-opus-4-8) · ?max_tokens= (default 2500)
// No DB writes. Manual invocation only (no schedule).
// ══════════════════════════════════════════════════════════════════════════════

const API = 'https://api.anthropic.com/v1/messages';

// Narration-shaped prompt — real PHX@MIN Jul 13 A-tier shape, 4-part <=170 word
// structure from NARRATION_V2, with a TEAM CONTEXT block (composeTeamContext format).
const NARRATION_PROMPT = `You are the narration layer of a live WNBA betting intelligence system. A SWEET SPOT A-tier alert just fired. Write the "why" push for the bettor: <=170 words, exactly 4 short paragraphs — (1) the structural case for the trailing team, (2) why the leader's lead is unsustainable, (3) what the season context adds, (4) what would invalidate the read. Plain English, no jargon, no abbreviations, lead with conviction.

ALERT: MIN trailing PHX by 7, Q1 0:45. Quality gap .406 (MIN .750 season win% vs PHX .320). PHX lead built on 5-of-8 three-point shooting (eFG 68%, season 44%); variance share 61% from threes and midrange. MIN eFG 49% vs their 52% season norm. Live line MIN +135.

TEAM CONTEXT (season priors — context only, small-n: treat splits as direction, not probabilities):
MIN 18-6 SHOTMAKER — eFG diff +6.2pp, TO margin +1.4 | vs elite 5-1 (eFG +5.2pp), vs rest 13-5 | L5 3-2, own eFG -1.1pp, opp eFG +10.3pp [OPPONENTS_HOT] | H2H vs PHX: 3-0 (avg +9.3)
PHX 8-17 SHOT_DEFICIT — eFG diff -4.2pp, TO margin -0.3 | vs elite 2-10 (eFG -5.6pp), vs rest 6-7 | L5 1-4`;

async function callAnthropic(model, effort, maxTokens, apiKey) {
  const base = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: NARRATION_PROMPT }],
  };
  const attempts = [];

  // Shape A: output_config.effort — then Shape B: top-level effort — then no effort
  const shapes = [
    { label: 'output_config.effort', body: { ...base, output_config: { effort } } },
    { label: 'top-level effort', body: { ...base, effort } },
    { label: 'no effort param', body: base },
  ];

  for (const shape of shapes) {
    const t0 = Date.now();
    let resp, json;
    try {
      resp = await fetch(API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(shape.body),
      });
      json = await resp.json();
    } catch (e) {
      attempts.push({ shape: shape.label, error: e.message, latencyMs: Date.now() - t0 });
      continue;
    }
    const latencyMs = Date.now() - t0;
    if (resp.status === 400) {
      attempts.push({ shape: shape.label, status: 400, apiError: json.error?.message || JSON.stringify(json).slice(0, 300), latencyMs });
      continue; // try next shape
    }
    if (!resp.ok) {
      attempts.push({ shape: shape.label, status: resp.status, apiError: json.error?.message || JSON.stringify(json).slice(0, 300), latencyMs });
      return { ok: false, attempts }; // non-400 (auth, 404 model, 429, 529) — no point trying shapes
    }
    // Success — extract everything the narration integration will need
    const content = json.content || [];
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const thinkingBlocks = content.filter((b) => b.type === 'thinking');
    attempts.push({ shape: shape.label, status: resp.status, latencyMs });
    return {
      ok: true,
      acceptedShape: shape.label,
      attempts,
      latencyMs,
      stopReason: json.stop_reason,
      usage: json.usage || null,
      contentBlockTypes: content.map((b) => b.type),
      thinkingBlockCount: thinkingBlocks.length,
      thinkingNonEmpty: thinkingBlocks.some((b) => (b.thinking || '').length > 0),
      wordCount: text.split(/\s+/).filter(Boolean).length,
      text,
    };
  }
  return { ok: false, attempts };
}

export default async function handler(req) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ ok: false, error: 'no ANTHROPIC_API_KEY' }), { status: 500 });

  const url = new URL(req.url, 'https://localhost');
  const model = url.searchParams.get('model') || 'claude-fable-5';
  const effort = url.searchParams.get('effort') || 'high';
  const maxTokens = Number(url.searchParams.get('max_tokens')) || 2500;
  const runBaseline = url.searchParams.get('baseline') === '1';

  const out = { ok: true, model, effort, maxTokens };
  out.fable = await callAnthropic(model, effort, maxTokens, apiKey);
  if (runBaseline) {
    out.baseline = await callAnthropic('claude-opus-4-8', effort, maxTokens, apiKey);
  }
  out.ok = out.fable.ok;
  return new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json' } });
}

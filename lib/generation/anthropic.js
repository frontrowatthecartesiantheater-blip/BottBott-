// Live Anthropic client for the generation pipeline. Plain fetch against
// the Messages API; no SDK dependency. Requires ANTHROPIC_API_KEY.

import { GENERATION_MODEL } from './prompts.js';

export function createAnthropicClient({ model = GENERATION_MODEL } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  return async function anthropicClient({ label, prompt, maxTokens = 4096 }) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // claude-sonnet-5 runs adaptive thinking by default at effort "high",
        // which can spend more thinking tokens than the max_tokens budgets
        // allow. "medium" on Sonnet 5 is comparable to Sonnet 4.6 at "high"
        // (which this pipeline previously ran without thinking at all), and
        // keeps thinking + response within budget. Haiku does not support
        // the effort parameter (400), so only send it on Sonnet/Opus models.
        ...(model.includes('haiku') ? {} : { output_config: { effort: 'medium' } }),
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API error on ${label}: ${res.status} ${body}`);
    }
    const data = await res.json();
    if (data.stop_reason === 'max_tokens') {
      throw new Error(`${label} hit the max_tokens limit; response is truncated`);
    }
    return data.content.map((block) => block.text ?? '').join('');
  };
}

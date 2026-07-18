// Step 4: relevancy scoring — the one step where nuance matters, so it runs
// on Sonnet. The question is whether the FETCHED content actually supports
// the specific claim, not whether it's keyword-adjacent. Also picks the
// anchor text: a verbatim phrase from the draft sentence, so injection is a
// deterministic string splice with no model rewriting the draft.

import { parseJsonResponse } from './models.js';

function buildRelevancyPrompt({ claim, sentence, url, title, pageText }) {
  return `You are deciding whether a web page genuinely supports a specific claim in a blog draft, as a citation link.

Claim: ${claim}
The exact draft sentence the link would live in:
"${sentence}"

Candidate source:
URL: ${url}
Title: ${title}
Page content (truncated):
${pageText.slice(0, 8000)}

Score how well this page SUPPORTS THIS SPECIFIC CLAIM. Keyword overlap is not support; the page must actually state, document, or evidence the claim. Score harshly:
- 90-100: page directly and authoritatively documents the claim
- 75-89: page clearly supports the claim with relevant specifics
- 60-74: page is on-topic and partially supports the claim
- below 60: keyword-adjacent, tangential, or contradicts the claim

Return ONLY a JSON object — no preamble, no code fence, no explanation before or after it:
{
  "score": 0-100,
  "supports": true|false,
  "anchor_text": "a 2-6 word phrase copied EXACTLY from the draft sentence above, the most natural span to carry the link",
  "reasoning": "one sentence"
}`;
}

/**
 * @returns {Promise<{score: number, supports: boolean, anchor_text: string|null, reasoning: string}>}
 */
export async function scoreRelevancy(sonnet, { claim, sentence, url, title, pageText }) {
  // 4096, not 512: Sonnet 5 runs adaptive thinking by default and thinking
  // tokens count against max_tokens — a tight cap truncates whenever the
  // model decides a judgment is worth thinking about.
  const response = await sonnet({
    label: `link-relevancy:${url}`,
    prompt: buildRelevancyPrompt({ claim, sentence, url, title, pageText }),
    maxTokens: 4096,
  });
  const parsed = parseJsonResponse(response, `relevancy for ${url}`);
  const score = Number(parsed.score);
  const anchor = typeof parsed.anchor_text === 'string' ? parsed.anchor_text.trim() : null;
  return {
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0,
    supports: parsed.supports === true,
    // The anchor must be a verbatim span of the sentence or injection skips it.
    anchor_text: anchor && sentence.includes(anchor) ? anchor : null,
    reasoning: parsed.reasoning ?? '',
  };
}

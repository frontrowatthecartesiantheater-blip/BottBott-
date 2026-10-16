// Step 1: claim extraction. Scan the draft for sentences making factual
// claims worth backing with an external source, and produce a search query
// per claim. The sentence must be quoted verbatim so the injector can find
// it again in the markdown.

import { LINK_CONFIG } from './config.js';
import { CLIENT } from '../client-config.js';
import { parseJsonResponse } from './models.js';

// What counts as a linkable claim differs by blog, so the examples come from
// client-config (linkClaimGuidance). The fallback is the original
// local-professional wording.
const DEFAULT_GUIDANCE = {
  good: ['statistics', 'legal and procedural statements', 'market data', 'claims about government programs or regulations'],
  bad: ["the author's personal opinions or anecdotes", 'generic advice', "anything about the author's own services"],
};

function buildClaimsPrompt(bodyMd) {
  const guidance = CLIENT.linkClaimGuidance ?? DEFAULT_GUIDANCE;
  return `You are reviewing a blog draft written by ${CLIENT.fullName}, ${CLIENT.description}, to find claims that would benefit from an external supporting source (a citation link).

Good candidates:
${guidance.good.map((g) => `- ${g}`).join('\n')}
Bad candidates:
${guidance.bad.map((b) => `- ${b}`).join('\n')}
- sentences that already contain a markdown link

Return ONLY a JSON array (no preamble, no code fence, no explanation before or after it) of at most ${LINK_CONFIG.maxClaimsPerDraft} objects, strongest candidates first:

[
  {
    "claim": "one-line restatement of the factual claim",
    "sentence": "the EXACT sentence from the draft, character-for-character, including punctuation",
    "search_query": "a web search query likely to find an authoritative source for this claim"
  }
]

Return [] if nothing in the draft merits an external citation. Do not invent sentences — every "sentence" value must appear verbatim in the draft.

Draft (markdown):
${bodyMd}`;
}

/**
 * @param {string} bodyMd - the draft markdown
 * @param {function} sonnet - anthropic client
 * @returns {Promise<{claims: Array<{claim: string, sentence: string, search_query: string}>,
 *   droppedVerbatim: number}>} droppedVerbatim counts well-formed claims whose
 *   "sentence" was not found verbatim in the draft — reported so a run where
 *   the model paraphrased every sentence is distinguishable from a run where
 *   it genuinely found nothing to cite.
 */
export async function extractClaims(bodyMd, sonnet) {
  // Headroom for Sonnet 5's adaptive thinking (counts against max_tokens)
  // plus the claims JSON itself.
  const response = await sonnet({
    label: 'link-claims',
    prompt: buildClaimsPrompt(bodyMd),
    maxTokens: 8192,
  });
  const claims = parseJsonResponse(response, 'claim extraction');
  if (!Array.isArray(claims)) throw new Error('claim extraction did not return an array');

  // Drop anything whose sentence isn't actually in the draft — a hallucinated
  // sentence can't be injected into anyway.
  const wellFormed = claims.filter((c) => c?.claim && c?.sentence && c?.search_query);
  const usable = wellFormed.filter((c) => bodyMd.includes(c.sentence));
  return {
    claims: usable.slice(0, LINK_CONFIG.maxClaimsPerDraft),
    droppedVerbatim: wellFormed.length - usable.length,
  };
}

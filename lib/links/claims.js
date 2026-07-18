// Step 1: claim extraction. Scan the draft for sentences making factual
// claims worth backing with an external source, and produce a search query
// per claim. The sentence must be quoted verbatim so the injector can find
// it again in the markdown.

import { LINK_CONFIG } from './config.js';
import { parseJsonResponse } from './models.js';

function buildClaimsPrompt(bodyMd) {
  return `You are reviewing a blog draft written by a local professional to find claims that would benefit from an external supporting source (a citation link).

Good candidates: statistics, legal/procedural statements, market data, claims about government programs or regulations.
Bad candidates: the author's personal opinions or anecdotes, generic advice, anything about the author's own services, sentences already containing a markdown link.

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
 * @returns {Promise<Array<{claim: string, sentence: string, search_query: string}>>}
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
  return claims
    .filter((c) => c?.claim && c?.sentence && c?.search_query && bodyMd.includes(c.sentence))
    .slice(0, LINK_CONFIG.maxClaimsPerDraft);
}

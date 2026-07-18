// Model routing for the link pipeline, reusing the repo's plain-fetch
// Anthropic client (lib/generation/anthropic.js).
//
//   Haiku 4.5  — cheap/mechanical classification: business_type + market
//                extraction, structural HTML trust signals, publish-date
//                extraction.
//   Sonnet 5   — judgment steps: relevancy scoring (does this source support
//                this specific claim) and claim extraction. Claim extraction
//                rides on Sonnet because a bad claim list wastes every
//                downstream search/fetch call, and it's one call per draft.
//
// No Fable/Mythos-tier models: this is a classification/relevancy workload.

import { createAnthropicClient } from '../generation/anthropic.js';

export const HAIKU_MODEL = 'claude-haiku-4-5';
export const SONNET_MODEL = 'claude-sonnet-5';

/** @returns {{ haiku: Function, sonnet: Function }} injected into the engine */
export function createLinkClients() {
  return {
    haiku: createAnthropicClient({ model: HAIKU_MODEL }),
    sonnet: createAnthropicClient({ model: SONNET_MODEL }),
  };
}

/**
 * Find the first balanced JSON object or array in the text, string-aware
 * (braces inside string values don't affect nesting depth).
 */
function extractJsonBlock(text) {
  const start = text.search(/[{[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse a model response that should be bare JSON, tolerating a code fence
 * and stray prose before/after the JSON (models sometimes append an
 * explanation despite JSON-only instructions — the JSON itself is still
 * good, so extract the first balanced {...} or [...] block).
 */
export function parseJsonResponse(text, label) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const block = extractJsonBlock(cleaned);
    if (block !== null) {
      try {
        return JSON.parse(block);
      } catch { /* fall through to the error below */ }
    }
    throw new Error(`${label} response contains no parseable JSON:\n${cleaned.slice(0, 400)}`);
  }
}

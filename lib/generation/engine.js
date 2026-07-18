// Generation pipeline orchestrator: pre-pass (dynamic TOV) → Call 1
// (structure) → Call 2 (draft) → Call 3 (polish + socials + JSON package).
//
// The client is injected: lib/generation/anthropic.js for live runs,
// lib/generation/mock-client.js for offline runs. Either way the engine
// builds real prompts and parses real response formats, so a mock run
// exercises everything except the model itself.

import {
  buildPrePassPrompt,
  buildCall1Prompt,
  buildCall2Prompt,
  buildCall3Prompt,
} from './prompts.js';
import { lintGenerationResult } from './lint.js';

function parsePrePassResponse(text) {
  // The pre-pass prompt demands bare JSON, but strip a code fence if the
  // model adds one anyway.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  const parsed = JSON.parse(cleaned);
  for (const key of ['dominant_phrases', 'energy_level', 'specific_references', 'opinions_expressed']) {
    if (!(key in parsed)) throw new Error(`pre-pass response missing key "${key}"`);
  }
  return parsed;
}

export function parseCall3Response(text) {
  const match = text.match(/\|\|\|OUTPUT_START\|\|\|([\s\S]*?)\|\|\|OUTPUT_END\|\|\|/);
  if (!match) throw new Error('Call 3 response has no |||OUTPUT_START|||...|||OUTPUT_END||| block');
  let pkg;
  try {
    pkg = JSON.parse(match[1].trim());
  } catch (err) {
    throw new Error(`Call 3 JSON package failed to parse: ${err.message}`);
  }

  for (const field of ['title', 'slug', 'meta_title', 'meta_description', 'primary_keyword', 'body_md']) {
    if (!pkg.post?.[field]) throw new Error(`Call 3 JSON package missing post.${field}`);
  }
  if (!pkg.social?.linkedin || !pkg.social?.facebook) {
    throw new Error('Call 3 JSON package missing social.linkedin or social.facebook');
  }

  // internal_links is 0-2 URLs (the prompt says to omit the array when none
  // are used). Normalize it, then split into the two legacy columns the
  // posts table keeps: internal_link_a = first link, internal_link_b =
  // second link or null. Downstream writers (cron, draft, publish) read the
  // named fields, so the split lives here rather than in each caller.
  const links = pkg.post.internal_links ?? [];
  if (!Array.isArray(links) || links.length > 2 || links.some((u) => typeof u !== 'string' || !u.trim())) {
    throw new Error('Call 3 JSON package post.internal_links must be an array of 0-2 non-empty URL strings');
  }
  pkg.post.internal_links = links;
  pkg.post.internal_link_a = links[0] ?? null;
  pkg.post.internal_link_b = links[1] ?? null;

  const auditMatch = text.match(/CRAFT AUDIT:[\s\S]*$/);
  return {
    package: pkg,
    craftAudit: auditMatch ? auditMatch[0].trim() : null,
  };
}

/**
 * Run the full generation pipeline.
 *
 * @param {object} inputs - { topicTitle, topicDescription, primaryKeyword,
 *   guidingQuestions, transcript, priorPosts, ragFlag, ragChunks }
 * @param {function} client - async ({ label, prompt, maxTokens }) => string
 * @returns {{ package, craftAudit, dynamicTov, lint, artifacts }}
 *   artifacts is the ordered list of { label, prompt, response } for review.
 */
export async function runGeneration(inputs, client) {
  const artifacts = [];
  async function call(label, prompt, maxTokens) {
    const response = await client({ label, prompt, maxTokens });
    artifacts.push({ label, prompt, response });
    return response;
  }

  let dynamicTov = null;
  if (!inputs.ragFlag) {
    const prePassResponse = await call('prepass', buildPrePassPrompt(inputs), 1024);
    dynamicTov = parsePrePassResponse(prePassResponse);
  }

  const call1Output = await call('call1', buildCall1Prompt({ ...inputs, dynamicTov }), 4096);

  const call2Output = await call(
    'call2',
    buildCall2Prompt({ ...inputs, dynamicTov, call1Output }),
    8192,
  );

  const call3Response = await call(
    'call3',
    buildCall3Prompt({ ...inputs, dynamicTov, call2Output }),
    8192,
  );

  const { package: pkg, craftAudit } = parseCall3Response(call3Response);
  const lint = lintGenerationResult(pkg, inputs.primaryKeyword);

  return { package: pkg, craftAudit, dynamicTov, lint, artifacts };
}

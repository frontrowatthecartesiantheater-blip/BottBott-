// Claude-backed helpers for the Add Content tab: generating fresh blog topic
// ideas, and parsing topics out of an uploaded document. Kept separate from
// lib/generation/prompts.js (the post-generation pipeline) so this admin-only
// surface never touches the publish prompts.
//
// All output is coerced to a stable topic shape:
//   { title, description, category, main_keyword, guiding_questions[] }
// category is one of the configured site categories (client-config). Both
// endpoints reuse these so the Save path (POST /api/admin/topics) gets a
// consistent payload.

import { CLIENT } from './client-config.js';

export const TOPIC_CATEGORIES = CLIENT.topicCategories;

// Who the client is and what they write about, injected into every Add
// Content prompt. Filled per client in lib/client-config.js.
const AGENT_CONTEXT = CLIENT.topicAgentContext;

const SHAPE_RULES = `Each topic object must have exactly these fields:
- "title": a specific, compelling blog post title (string)
- "description": 1-2 sentences on what the post covers and why it matters (string)
- "category": exactly one of ${JSON.stringify(TOPIC_CATEGORIES)} (string)
- "main_keyword": the primary SEO keyword phrase, location-specific where natural (string)
- "guiding_questions": an array of 3-4 short questions that would prompt ${CLIENT.firstName} to talk \
through the topic out loud (array of strings)
Return ONLY a JSON array of topic objects. No prose, no markdown, no code fences.`;

export function buildGeneratePrompt(existingTitles = []) {
  const avoid = existingTitles.length
    ? `\n\nDo NOT duplicate or closely overlap any of these existing topics:\n${existingTitles.map((t) => `- ${t}`).join('\n')}`
    : '';
  return `${AGENT_CONTEXT}

Generate 5 new, original blog topic ideas for ${CLIENT.firstName}. Spread them across their \
specialties and the other categories where it fits. Each must be distinct and genuinely useful to \
their local audience.${avoid}

${SHAPE_RULES}`;
}

export function buildExtractPrompt(documentText) {
  return `${AGENT_CONTEXT}

Below is the text of a document the user uploaded. Extract every distinct blog topic idea it \
contains and return them as structured topic objects. If a topic in the source is missing guiding \
questions, generate 3-4 appropriate ones yourself. Infer the best-fitting category from the \
allowed values.

${SHAPE_RULES}

--- DOCUMENT START ---
${documentText}
--- DOCUMENT END ---`;
}

/** Pull a JSON array out of a model response, tolerating code fences / stray prose. */
export function parseTopicsJson(text) {
  let raw = String(text || '').trim();
  // Strip a ```json ... ``` or ``` ... ``` fence if present.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  // Fall back to the first bracketed array in the text.
  if (!raw.startsWith('[')) {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start !== -1 && end > start) raw = raw.slice(start, end + 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('could not parse topics from the model response');
  }
  if (!Array.isArray(parsed)) throw new Error('model did not return a topics array');
  return parsed.map(normalizeTopic);
}

/** Coerce a raw object to the stable topic shape. */
export function normalizeTopic(t = {}) {
  let questions = t.guiding_questions ?? t.guidingQuestions ?? [];
  if (typeof questions === 'string') questions = questions.split('\n');
  questions = (Array.isArray(questions) ? questions : []).map((q) => String(q).trim()).filter(Boolean);

  const category = String(t.category || '').trim().toLowerCase();
  return {
    title: String(t.title || '').trim(),
    description: String(t.description || '').trim(),
    category: TOPIC_CATEGORIES.includes(category) ? category : '',
    main_keyword: String(t.main_keyword || t.mainKeyword || t.primary_keyword || '').trim(),
    guiding_questions: questions,
  };
}

/**
 * For any topic still missing guiding questions, generate them in one batched
 * Claude call. Returns a new array with the gaps filled. Best-effort: if the
 * call fails or returns nothing usable, the originals are returned unchanged.
 */
export async function backfillGuidingQuestions(topics, client) {
  const gaps = topics.filter((t) => !t.guiding_questions.length);
  if (!gaps.length) return topics;

  const prompt = `${AGENT_CONTEXT}

For each topic below, write 3-4 short guiding questions that would prompt ${CLIENT.firstName} to \
talk through it out loud. Return ONLY a JSON array, one object per topic in the same order, each shaped \
{ "title": <the title>, "guiding_questions": [<3-4 strings>] }. No prose, no code fences.

${JSON.stringify(gaps.map((t) => ({ title: t.title, description: t.description })), null, 2)}`;

  let filled;
  try {
    const text = await client({ label: 'guiding-questions backfill', prompt, maxTokens: 2048 });
    filled = parseTopicsJson(text);
  } catch {
    return topics; // best-effort; leave gaps for the user to fill in the card
  }

  const byTitle = new Map(filled.map((f) => [f.title, f.guiding_questions]));
  return topics.map((t) => {
    if (t.guiding_questions.length) return t;
    const qs = byTitle.get(t.title) || [];
    return { ...t, guiding_questions: qs };
  });
}

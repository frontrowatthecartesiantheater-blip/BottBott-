// Talking points: the system's memory of what has already been said.
//
// When a post is published, its final (edited) text is distilled into a handful
// of reusable ideas: a stance, a claim about how something works, a fact about
// a client engagement (anonymized), a how-to, a stated figure. Each is stored
// restated in neutral words, with an embedding, plus the post it came from.
//
// At generation time the closest points for a new topic are retrieved and
// handed to the draft model. They exist to fill the gap when a transcript is
// thin: instead of inventing material to reach 1,200 words, the model may
// REHASH an earlier point (restate it in new words, ideally linking back to the
// post it came from). Never quote: lib/generation/lint.js rejects drafts that
// copy a run of words from a published post.
//
// Distinct from lib/rag.js: RAG stores raw text chunks and is only consulted
// when no voice memo exists. Talking points are curated, deduplicated,
// anonymized ideas, offered to every run.
//
// Flow:
//   extractTalkingPoints()   post body -> validated point list (one model call)
//   indexTalkingPoints()     embed + replace the post's rows
//   backfillTalkingPoints()  published posts not yet extracted (run by the
//                            link-sweep workflow; also usable as a script)
//   retrieveTalkingPoints()  closest points for a topic, for generation

import { isMock } from './mock.js';
import { CLIENT, SITE_ORIGIN } from './client-config.js';
import { embed, embedOne } from './embeddings.js';
import { parseJsonResponse } from './links/models.js';

export const TALKING_POINT_KINDS = ['stance', 'claim', 'client_fact', 'how_to', 'metric'];
const MAX_POINTS = 12;
const MIN_POINT_CHARS = 20;
const MAX_POINT_CHARS = 420;
const DEFAULT_TOP_N = 6;
const MIN_SIMILARITY = 0.2;

const mockStore = []; // { source_post_id, source_slug, source_title, kind, point, topics, client_ref, evidence_url, embedding }

// ------------------------------------------------------------------ extraction

export function buildExtractionPrompt({ title, bodyMd }) {
  const names = (CLIENT.anonymizeNames ?? []).join(', ') || '(none listed)';
  return `You are cataloguing the reusable ideas in a published blog post by ${CLIENT.fullName}, so a future post can restate them in new words without copying.

Return ONLY a JSON array (no preamble, no code fence) of 6 to ${MAX_POINTS} objects:

[
  {
    "kind": "stance | claim | client_fact | how_to | metric",
    "point": "one or two plain sentences restating the idea in neutral wording",
    "topics": ["2-4 short lowercase tags"],
    "client_ref": "an anonymized label such as 'a podcast placement agency founder', or null",
    "evidence_url": "the external https URL the post links to support this point, or null"
  }
]

Kinds:
- stance: an opinion or position the author takes
- claim: a statement about how the world or a tool works (third-party behavior, what a platform does)
- client_fact: something that happened in a client engagement (anonymized)
- how_to: a practical instruction the post gives
- metric: a number, price, or measured result the post states

Rules:
- "point" must restate the idea in fresh, neutral words. Do NOT copy sentences or distinctive phrases from the post.
- Never include a person's or company's name for a client. Describe clients by role and industry. Names to scrub entirely: ${names}.
- Only include a metric if the number appears in the post.
- evidence_url must be a URL that appears in the post as a markdown link supporting that exact point; otherwise null.
- Skip introductions, calls to action, and filler. Prefer ideas that could support a different post on a related topic.

POST TITLE: ${title}

POST (markdown):
${bodyMd}`;
}

/** Validate and normalize the model's list. Anything malformed or leaky is dropped. */
export function validatePoints(raw, bodyMd) {
  if (!Array.isArray(raw)) throw new Error('talking-point extraction did not return an array');
  const names = (CLIENT.anonymizeNames ?? []).map((n) => n.toLowerCase());
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item.point !== 'string') continue;
    const point = item.point.trim().replace(/\s+/g, ' ');
    if (point.length < MIN_POINT_CHARS || point.length > MAX_POINT_CHARS) continue;
    if (!TALKING_POINT_KINDS.includes(item.kind)) continue;
    if (/https?:\/\//i.test(point)) continue;
    const lower = point.toLowerCase();
    const clientRef = typeof item.client_ref === 'string' && item.client_ref.trim() ? item.client_ref.trim() : null;
    if (names.some((n) => lower.includes(n) || (clientRef ?? '').toLowerCase().includes(n))) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);

    const topics = Array.isArray(item.topics)
      ? item.topics.filter((t) => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 4)
      : [];
    // evidence_url is an EXTERNAL source. One the post does not actually contain
    // is a hallucination; one on the client's own site is an internal link, not
    // evidence.
    const evidence = typeof item.evidence_url === 'string' && /^https?:\/\//.test(item.evidence_url)
      && bodyMd.includes(item.evidence_url) && !item.evidence_url.includes(CLIENT.siteDomain)
      ? item.evidence_url
      : null;
    out.push({ kind: item.kind, point, topics, client_ref: clientRef, evidence_url: evidence });
    if (out.length >= MAX_POINTS) break;
  }
  return out;
}

/**
 * @param {{title: string, body_md: string}} post
 * @param {function} client - async ({ label, prompt, maxTokens }) => string
 */
export async function extractTalkingPoints(post, client) {
  const response = await client({
    label: 'talking-points',
    prompt: buildExtractionPrompt({ title: post.title, bodyMd: post.body_md }),
    maxTokens: 4096,
  });
  return validatePoints(parseJsonResponse(response, 'talking-point extraction'), post.body_md);
}

// --------------------------------------------------------------------- storage

/**
 * Replace a post's talking points with `points`.
 * @param {{id: string, slug: string, title: string}} post
 */
export async function indexTalkingPoints({ supabase, post, points }) {
  if (points.length === 0) return { points: 0 };
  const embeddings = await embed(points.map((p) => `${p.point} (${p.topics.join(', ')})`));

  if (isMock()) {
    for (let i = mockStore.length - 1; i >= 0; i -= 1) if (mockStore[i].source_post_id === post.id) mockStore.splice(i, 1);
    points.forEach((p, i) => mockStore.push({ ...p, source_post_id: post.id, source_slug: post.slug, source_title: post.title, embedding: embeddings[i] }));
    return { points: points.length };
  }

  const del = await supabase.from('talking_points').delete().eq('source_post_id', post.id);
  if (del.error) throw new Error(`talking_points delete failed: ${del.error.message}`);
  const { error } = await supabase.from('talking_points').insert(points.map((p, i) => ({
    source_post_id: post.id,
    kind: p.kind,
    point: p.point,
    topics: p.topics,
    client_ref: p.client_ref,
    evidence_url: p.evidence_url,
    embedding: embeddings[i],
  })));
  if (error) throw new Error(`talking_points insert failed: ${error.message}`);
  return { points: points.length };
}

/**
 * Extract and store points for published posts that have none yet. Bounded
 * (limit per call) and safe to run every sweep tick: a post is stamped
 * (talking_points_extracted_at) only after a successful extraction + index, so
 * a failure retries next tick, and a post that yields zero valid points is not
 * re-extracted forever.
 *
 * Skips without spending a model call when embeddings are unavailable.
 */
export async function backfillTalkingPoints({ supabase, client = null, limit = 3, dryRun = false, slugs = null } = {}) {
  const result = { processed: [], errors: [] };
  if (!isMock() && !process.env.OPENAI_API_KEY) {
    return { ...result, skipped: 'OPENAI_API_KEY is not set in this environment (embeddings unavailable)' };
  }
  if (!supabase) {
    const { getSupabaseClient } = await import('./supabase.js');
    supabase = getSupabaseClient();
  }
  if (!client) {
    const { createAnthropicClient } = await import('./generation/anthropic.js');
    client = createAnthropicClient();
  }

  let query = supabase.from('posts').select('id, slug, title, body_md')
    .eq('status', 'published')
    .order('published_at', { ascending: true });
  query = slugs ? query.in('slug', slugs) : query.is('talking_points_extracted_at', null);
  const { data: posts, error } = await query.limit(limit);
  if (error) throw new Error(`posts read failed: ${error.message}`);

  for (const post of posts ?? []) {
    try {
      const points = await extractTalkingPoints(post, client);
      if (dryRun) {
        result.processed.push({ slug: post.slug, points: points.length, preview: points });
        continue;
      }
      await indexTalkingPoints({ supabase, post, points });
      const { error: stampError } = await supabase.from('posts')
        .update({ talking_points_extracted_at: new Date().toISOString() }).eq('id', post.id);
      if (stampError) throw new Error(`stamp failed: ${stampError.message}`);
      result.processed.push({ slug: post.slug, points: points.length });
    } catch (err) {
      result.errors.push({ slug: post.slug, error: err.message });
    }
  }
  return result;
}

// ------------------------------------------------------------------- retrieval

function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const withUrl = (r) => ({ ...r, source_url: `${SITE_ORIGIN}/blog/${r.source_slug}` });

/**
 * Closest talking points to a topic. Never throws: generation must not fail
 * because the memory is unavailable (table not migrated yet, embeddings down);
 * it just runs without it.
 * @returns {Promise<Array<{id?, kind, point, topics, client_ref, evidence_url, source_slug, source_title, source_url, similarity}>>}
 */
export async function retrieveTalkingPoints(topic, { topN = DEFAULT_TOP_N, excludePostId = null, supabase = null } = {}) {
  try {
    const query = [topic.title, topic.description, topic.primary_keyword].filter(Boolean).join('. ');
    const queryEmbedding = await embedOne(query);

    if (isMock()) {
      return mockStore
        .filter((r) => r.source_post_id !== excludePostId)
        .map((r) => ({ ...r, similarity: cosine(queryEmbedding, r.embedding) }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, topN)
        .map(withUrl);
    }

    if (!supabase) {
      const { getSupabaseClient } = await import('./supabase.js');
      supabase = getSupabaseClient();
    }
    const { data, error } = await supabase.rpc('match_talking_points', {
      query_embedding: queryEmbedding,
      match_count: topN,
      exclude_post_id: excludePostId,
    });
    if (error) throw new Error(error.message);
    return (data ?? []).filter((r) => r.similarity >= MIN_SIMILARITY).map(withUrl);
  } catch (err) {
    console.warn(`talking points unavailable, continuing without them: ${err.message}`);
    return [];
  }
}

/** Test-only: seed the mock store directly. */
export function _seedMockTalkingPoints(rows) {
  if (!isMock()) throw new Error('_seedMockTalkingPoints is mock-only');
  mockStore.push(...rows);
}

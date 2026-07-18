// RAG fallback store. This is the ONLY place the content_chunks table and
// the match_content_chunks() RPC are touched, so the fallback path stays
// isolated from the voice-memo path and can be tested on its own.
//
// Flow:
//   indexContent()   — chunk + embed a transcript or post body, upsert rows
//   retrieveChunks()  — embed a topic query, return the top-N similar chunks
//
// Mock mode keeps an in-memory store and uses cosine similarity over the
// deterministic mock embeddings, so retrieval is exercised for real
// (chunking, ranking, top-N) without Supabase or OpenAI.

import { isMock } from './mock.js';
import { embed, embedOne } from './embeddings.js';

const DEFAULT_CHUNK_CHARS = 1200;
const DEFAULT_TOP_N = 5;

const mockStore = []; // { source_type, source_id, chunk_index, content, embedding }

/** Split on paragraph boundaries, packing into ~maxChars chunks. */
export function chunkText(text, { maxChars = DEFAULT_CHUNK_CHARS } = {}) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > maxChars) {
      chunks.push(current);
      current = '';
    }
    // A single oversized paragraph becomes its own chunk.
    if (para.length > maxChars) {
      if (current) { chunks.push(current); current = ''; }
      chunks.push(para);
      continue;
    }
    current = current ? `${current}\n\n${para}` : para;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Chunk, embed, and store content for RAG retrieval.
 * @param {{ sourceType: 'voice_memo'|'post', sourceId: string, text: string }}
 * @returns {Promise<{ chunks: number }>}
 */
export async function indexContent({ sourceType, sourceId, text }) {
  const chunks = chunkText(text);
  if (chunks.length === 0) return { chunks: 0 };
  const embeddings = await embed(chunks);
  const rows = chunks.map((content, i) => ({
    source_type: sourceType,
    source_id: sourceId,
    chunk_index: i,
    content,
    embedding: embeddings[i],
  }));

  if (isMock()) {
    // Replace any existing rows for this source, then add.
    for (let i = mockStore.length - 1; i >= 0; i--) {
      if (mockStore[i].source_type === sourceType && mockStore[i].source_id === sourceId) mockStore.splice(i, 1);
    }
    mockStore.push(...rows);
    return { chunks: rows.length };
  }

  const { getSupabaseClient } = await import('./supabase.js');
  const { error } = await getSupabaseClient()
    .from('content_chunks')
    .upsert(rows, { onConflict: 'source_type,source_id,chunk_index' });
  if (error) throw new Error(`content_chunks upsert failed: ${error.message}`);
  return { chunks: rows.length };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Top-N chunks most relevant to a topic. The query string combines the
 * topic title, description, and primary keyword.
 * @returns {Promise<Array<{content, similarity, source_type}>>}
 */
export async function retrieveChunks(topic, { topN = DEFAULT_TOP_N } = {}) {
  const query = [topic.title, topic.description, topic.primary_keyword].filter(Boolean).join('. ');
  const queryEmbedding = await embedOne(query);

  if (isMock()) {
    return mockStore
      .map((r) => ({ content: r.content, source_type: r.source_type, similarity: cosine(queryEmbedding, r.embedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topN);
  }

  const { getSupabaseClient } = await import('./supabase.js');
  const { data, error } = await getSupabaseClient().rpc('match_content_chunks', {
    query_embedding: queryEmbedding,
    match_count: topN,
  });
  if (error) throw new Error(`match_content_chunks failed: ${error.message}`);
  return data;
}

/** Format retrieved chunks for injection as {{RAG_CHUNKS}} in the prompts. */
export function formatChunksForPrompt(chunks) {
  return chunks
    .map((c, i) => `[Chunk ${i + 1}${c.source_type ? ` from ${c.source_type}` : ''}]\n${c.content}`)
    .join('\n\n');
}

// Test-only: seed the mock store directly.
export function _seedMockStore(rows) {
  if (!isMock()) throw new Error('_seedMockStore is mock-only');
  mockStore.push(...rows);
}

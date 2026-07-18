// OpenAI text-embedding-3-small (1536 dims), matching the content_chunks
// vector column. Mock mode returns deterministic pseudo-vectors so RAG
// plumbing can be tested offline without an API key or real similarity.

import crypto from 'node:crypto';
import { isMock } from './mock.js';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;

// Deterministic unit-ish vector seeded from the text, so the same input
// always yields the same vector (lets mock retrieval be stable in tests).
function mockEmbed(text) {
  const seed = crypto.createHash('sha256').update(text).digest();
  const v = new Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    v[i] = (seed[i % seed.length] / 255) * 2 - 1;
  }
  return v;
}

/**
 * @param {string[]} texts
 * @returns {Promise<number[][]>} one vector per input
 */
export async function embed(texts) {
  if (!Array.isArray(texts)) throw new Error('embed() expects an array of strings');
  if (texts.length === 0) return [];

  if (isMock()) return texts.map(mockEmbed);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embedOne(text) {
  return (await embed([text]))[0];
}

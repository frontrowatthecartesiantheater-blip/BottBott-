// Backfill the RAG store: chunk + embed every voice memo transcript and
// published post body into content_chunks. Run after seeding content and
// whenever you want to refresh the fallback corpus.
//
// Usage:
//   node scripts/index-embeddings.js [--dry-run]
//
// --dry-run reports how many chunks each source would produce without
// embedding or writing (no OpenAI/Supabase calls).

import { chunkText, indexContent } from '../lib/rag.js';

const dryRun = process.argv.includes('--dry-run');

try { process.loadEnvFile(); } catch { /* rely on environment */ }

const { getSupabaseClient } = await import('../lib/supabase.js');
const supabase = getSupabaseClient();

async function loadSources() {
  const sources = [];
  const { data: memos, error: memoErr } = await supabase.from('voice_memos').select('id, transcript');
  if (memoErr) throw new Error(`voice_memos read failed: ${memoErr.message}`);
  for (const m of memos) sources.push({ sourceType: 'voice_memo', sourceId: m.id, text: m.transcript });

  const { data: posts, error: postErr } = await supabase
    .from('posts').select('id, body_md').eq('status', 'published');
  if (postErr) throw new Error(`posts read failed: ${postErr.message}`);
  for (const p of posts) sources.push({ sourceType: 'post', sourceId: p.id, text: p.body_md });
  return sources;
}

const sources = await loadSources();
let totalChunks = 0;

for (const source of sources) {
  if (dryRun) {
    const n = chunkText(source.text).length;
    totalChunks += n;
    console.log(`  ${source.sourceType} ${source.sourceId}: ${n} chunks`);
    continue;
  }
  const { chunks } = await indexContent(source);
  totalChunks += chunks;
  console.log(`  indexed ${source.sourceType} ${source.sourceId}: ${chunks} chunks`);
}

console.log(`${dryRun ? 'would index' : 'indexed'} ${totalChunks} chunks from ${sources.length} sources`);

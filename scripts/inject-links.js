// Run the external link injection pipeline on one draft.
//
// Usage:
//   node scripts/inject-links.js --file path/to/draft.md [--out path/to/result.md]
//   node scripts/inject-links.js --post <slug> [--apply]
//
// Default is a dry run: full report printed, nothing written to the post and
// no injected_links rows logged. --apply (post mode) updates posts.body_md
// and logs the links; --out (file mode) writes the modified markdown and logs.
//
// Requires ANTHROPIC_API_KEY, SERPAPI_API_KEY, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY. Run scripts/onboard-link-client.js once first.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getSupabaseClient } from '../lib/supabase.js';
import { createLinkClients } from '../lib/links/models.js';
import { injectExternalLinks } from '../lib/links/engine.js';

try { process.loadEnvFile(); } catch { /* rely on environment */ }

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

const file = argValue('--file');
const slug = argValue('--post');
const out = argValue('--out');
const apply = args.includes('--apply');
if (!file && !slug) {
  console.error('usage: node scripts/inject-links.js --file <draft.md> [--out <file>] | --post <slug> [--apply]');
  process.exit(1);
}

const supabase = getSupabaseClient();
const clients = createLinkClients();

let bodyMd;
let postId = null;
let draftRef;
let topicId = null;
let topicCategory = null;
if (file) {
  bodyMd = readFileSync(file, 'utf8');
  draftRef = path.basename(file);
} else {
  const { data: post, error } = await supabase
    .from('posts')
    .select('id, slug, body_md, topic_id')
    .eq('slug', slug)
    .single();
  if (error || !post) {
    console.error(`post "${slug}" not found${error ? `: ${error.message}` : ''}`);
    process.exit(1);
  }
  bodyMd = post.body_md;
  postId = post.id;
  draftRef = post.slug;
  // Topic → category enables surplus reuse (vetted candidates from prior
  // runs in the same niche). File-mode runs have neither.
  if (post.topic_id) {
    topicId = post.topic_id;
    const { data: topic } = await supabase
      .from('topics')
      .select('category')
      .eq('id', post.topic_id)
      .maybeSingle();
    topicCategory = topic?.category ?? null;
  }
}

const writing = Boolean(apply || out);
console.log(`${writing ? 'LIVE' : 'DRY'} run on ${draftRef}${topicCategory ? ` (category: ${topicCategory})` : ''}\n`);

const result = await injectExternalLinks({
  bodyMd, supabase, clients, postId, draftRef, topicId, topicCategory, log: writing,
});

console.log(`word count ${result.wordCount} → cap ${result.cap} link(s)\n`);

console.log(`injected (${result.injected.length}):`);
for (const l of result.injected) {
  console.log(`  [${l.anchor_text}](${l.url})  relevancy=${l.relevancy_score} trust=${l.trust_score}`);
  console.log(`    claim: ${l.claim}`);
}
console.log(`\nflagged for manual review (${result.flagged.length}):`);
for (const l of result.flagged) {
  console.log(`  ${l.url}  relevancy=${l.relevancy_score} trust=${l.trust_score}`);
  console.log(`    claim: ${l.claim}`);
}
console.log(`\nsurplus — vetted, cut by cap, pooled for future posts (${result.surplus.length}):`);
for (const l of result.surplus) {
  console.log(`  ${l.url}  relevancy=${l.relevancy_score} trust=${l.trust_score}`);
  console.log(`    claim: ${l.claim}`);
}
console.log(`\nskipped (${result.skipped.length}):`);
for (const s of result.skipped) {
  console.log(`  ${s.url ?? '(search)'} — ${s.reason}`);
}

if (out) {
  writeFileSync(out, result.bodyMd, 'utf8');
  console.log(`\nmodified draft written to ${out}`);
} else if (apply && postId) {
  if (result.injected.length === 0) {
    console.log('\nnothing injected — post left unchanged');
  } else {
    const { error } = await supabase.from('posts').update({ body_md: result.bodyMd }).eq('id', postId);
    if (error) {
      console.error(`post update failed: ${error.message}`);
      process.exit(1);
    }
    console.log(`\nposts.body_md updated for ${draftRef}`);
  }
} else {
  console.log('\ndry run — nothing written (use --apply or --out)');
}

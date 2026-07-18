// Hourly link-injection sweep: find pending_review posts the link pipeline
// hasn't processed yet, run injection on each, and stamp the post so it is
// never re-processed. Separated from the HTTP handler (same split as
// lib/cron.js) so a test harness can call it with injected dependencies.
//
// Idempotency: the target predicate is `status = 'pending_review' AND
// links_checked_at IS NULL` (posts.links_checked_at, migration 0009). The
// stamp is written after a successful run — including zero-result runs —
// so a swept post is done forever; a FAILED run leaves the stamp null and
// the post retries on the next sweep. Running the sweep twice back-to-back
// processes nothing the second time.
//
// When links are injected, the spliced markdown is written back to
// posts.body_md so the reviewer sees (and approves) the draft with its
// links in place; flagged/surplus outcomes are log rows only. Per-post
// failures are recorded in the summary rather than crashing the job —
// graceful, not silent, matching the other cron jobs.

import { getSupabaseClient } from '../supabase.js';
import { createLinkClients } from './models.js';
import { injectExternalLinks } from './engine.js';

// Cap per run to keep one serverless invocation bounded; anything beyond
// the cap is picked up by the next hourly sweep.
const DEFAULT_MAX_POSTS = 3;

export async function runLinkSweep({ maxPosts = DEFAULT_MAX_POSTS, supabase = null, clients = null } = {}) {
  const summary = { job: 'link-sweep', processed: [], errors: [] };
  supabase = supabase ?? getSupabaseClient();
  clients = clients ?? createLinkClients();

  let posts;
  try {
    const { data, error } = await supabase
      .from('posts')
      .select('id, slug, body_md, topic_id')
      .eq('status', 'pending_review')
      .is('links_checked_at', null)
      .order('generated_at', { ascending: true })
      .limit(maxPosts);
    if (error) throw new Error(error.message);
    posts = data ?? [];
  } catch (err) {
    summary.errors.push({ step: 'load_posts', error: err.message });
    return summary;
  }

  for (const post of posts) {
    const entry = { postId: post.id, slug: post.slug };
    try {
      // Topic -> category enables surplus-pool reuse; null for topicless posts.
      let topicCategory = null;
      if (post.topic_id) {
        const { data: topic } = await supabase
          .from('topics')
          .select('category')
          .eq('id', post.topic_id)
          .maybeSingle();
        topicCategory = topic?.category ?? null;
      }

      const result = await injectExternalLinks({
        bodyMd: post.body_md,
        supabase,
        clients,
        postId: post.id,
        draftRef: post.slug,
        topicId: post.topic_id ?? null,
        topicCategory,
        log: true,
      });
      entry.injected = result.injected.length;
      entry.flagged = result.flagged.length;
      entry.surplus = result.surplus.length;
      entry.cap = result.cap;

      // One update: the idempotency stamp, plus the spliced body when links
      // actually landed.
      const patch = { links_checked_at: new Date().toISOString() };
      if (result.injected.length > 0) patch.body_md = result.bodyMd;
      const { error: updateError } = await supabase.from('posts').update(patch).eq('id', post.id);
      if (updateError) throw new Error(`post update failed: ${updateError.message}`);

      entry.ok = true;
    } catch (err) {
      // Stamp not written — this post retries on the next sweep.
      entry.ok = false;
      entry.error = err.message;
      summary.errors.push({ postId: post.id, slug: post.slug, error: err.message });
    }
    summary.processed.push(entry);
  }
  return summary;
}

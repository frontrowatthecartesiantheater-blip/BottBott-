// GitHub Actions entry point: run the link-injection sweep, then — if the
// editor toggle is off — publish every pending_review post the sweep has
// already checked. Runs outside Vercel (.github/workflows/link-sweep.yml)
// so the sweep's many sequential search/fetch/LLM calls aren't bounded by a
// serverless function timeout.
//
// Auto-publish here mirrors api/admin/publish.js's pattern exactly: every
// post this script publishes already exists as a pending_review row (it was
// saved by lib/cron.js's saveAsPendingReview), so the Supabase write is an
// UPDATE (status -> 'published'), never an INSERT. This differs from the
// old cron toggle-OFF branch (lib/cron.js's former publishGenerated), which
// inserted a brand-new posts row because no row existed yet at that point.
//
// Requires: SERPAPI_API_KEY, ANTHROPIC_API_KEY, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH,
// GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_KEY.
// VERIFY_BASE_URL is optional (publishPost skips live verification if unset).

import { getSupabaseClient } from '../lib/supabase.js';
import { createLinkClients } from '../lib/links/models.js';
import { runLinkSweep } from '../lib/links/sweep.js';
import { getEditorToggle, updatePost, markTopicPublished } from '../lib/admin-data.js';
import { getImageAltByFilename } from '../lib/images.js';
import { publishPost } from '../lib/publish.js';
import { indexContent } from '../lib/rag.js';

try { process.loadEnvFile(); } catch { /* GitHub Actions sets env vars directly */ }

const supabase = getSupabaseClient();

console.log('--- link sweep ---');
const sweep = await runLinkSweep({ supabase, clients: createLinkClients() });
console.log(`swept ${sweep.processed.length} post(s), ${sweep.errors.length} error(s)`);
for (const p of sweep.processed) {
  console.log(`  ${p.slug}: injected=${p.injected ?? '-'} flagged=${p.flagged ?? '-'} surplus=${p.surplus ?? '-'} ok=${p.ok}${p.error ? ` (${p.error})` : ''}`);
}
for (const e of sweep.errors) {
  console.error(`  sweep error: ${JSON.stringify(e)}`);
}

const toggle = await getEditorToggle();
console.log(`\neditor_toggle: ${toggle}`);
if (toggle !== 'off') {
  console.log('toggle is on — auto-publish skipped, drafts wait for manual review');
  process.exit(0);
}

console.log('\n--- auto-publish ---');
const { data: posts, error: postsErr } = await supabase
  .from('posts')
  .select('*')
  .eq('status', 'pending_review')
  .not('links_checked_at', 'is', null)
  .order('generated_at', { ascending: true });
if (postsErr) {
  console.error(`posts query failed: ${postsErr.message}`);
  process.exit(1);
}
console.log(`${posts.length} post(s) ready to publish`);

const date = new Date().toISOString().slice(0, 10);
let failures = 0;

for (const post of posts) {
  console.log(`\npublishing ${post.slug}...`);
  try {
    const pkg = {
      post: {
        title: post.title,
        slug: post.slug,
        meta_title: post.meta_title,
        meta_description: post.meta_description,
        primary_keyword: post.primary_keyword,
        body_md: post.body_md,
        internal_link_a: post.internal_link_a,
        internal_link_b: post.internal_link_b,
        rag_fallback: post.rag_fallback,
      },
      social: { linkedin: post.social_linkedin, facebook: post.social_facebook },
    };

    // Image was already chosen at generation time (saveAsPendingReview) —
    // just resolve its alt text, never pick a new one here.
    const imageFilename = post.image_used ?? null;
    let imageAlt = '';
    if (imageFilename) {
      try {
        imageAlt = await getImageAltByFilename(supabase, imageFilename);
      } catch (imgErr) {
        console.error(`  image alt lookup failed: ${imgErr.message}`);
      }
    }

    // existingPostId set => publishPost() skips its own Supabase insert.
    const result = await publishPost({
      pkg, date, existingPostId: post.id, imageFilename, imageAlt,
    });

    try {
      await indexContent({ sourceType: 'post', sourceId: post.id, text: post.body_md });
    } catch (err) {
      console.error(`  rag index failed: ${err.message}`);
    }

    // The only Supabase write for this post's status: an UPDATE on the
    // existing pending_review row, matching api/admin/publish.js exactly.
    await updatePost(post.id, { status: 'published', published_at: new Date().toISOString() });
    if (post.topic_id) await markTopicPublished(post.topic_id);

    console.log(`  published: ${result.postUrl} (commit ${result.commitSha})`);
    if (result.postCommitErrors.length) {
      console.error(`  post-commit errors: ${JSON.stringify(result.postCommitErrors)}`);
    }
  } catch (err) {
    failures += 1;
    console.error(`  FAILED: ${err.message}`);
  }
}

console.log(`\ndone — ${posts.length - failures}/${posts.length} published`);
if (failures > 0) process.exit(1);

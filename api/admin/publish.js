// Save or publish a pending_review post. Editor only.
//
// POST ?action=save    — write the editor's field edits, nothing else. No
//   GitHub commit, no status change; usable any time, sweep-pending or not.
// POST (no action)      — save the edits, then run the M4 publish flow
//   (single GitHub commit, Sheet log; the Supabase row is updated in place
//   rather than re-inserted).
//
// The mock-mode guard below covers only the publish path: save has no
// external side effects (updatePost has its own mock branch), so it runs
// the same under ADMIN_MOCK as it does for real.

import { requireRole } from '../../lib/admin-auth.js';
import { sendJson, readJsonBody, getQuery } from '../../lib/http.js';
import { getPostById, updatePost, markTopicPublished } from '../../lib/admin-data.js';
import { getSupabaseClient } from '../../lib/supabase.js';
import { getImageAltByFilename } from '../../lib/images.js';
import { indexContent } from '../../lib/rag.js';
import { todayInClientTz } from '../../lib/cron.js';

const EDITABLE_FIELDS = [
  'title', 'meta_title', 'meta_description', 'body_md',
  'social_linkedin', 'social_facebook',
];

async function loadPendingPost(postId) {
  const post = await getPostById(postId);
  if (!post) { const e = new Error('post not found'); e.status = 404; throw e; }
  if (post.status !== 'pending_review') {
    const e = new Error(`post status is "${post.status}", expected pending_review`); e.status = 409; throw e;
  }
  return post;
}

function collectEdits(body, post) {
  const edits = {};
  for (const field of EDITABLE_FIELDS) {
    if (typeof body[field] === 'string' && body[field] !== post[field]) {
      edits[field] = body[field];
      post[field] = body[field];
    }
  }
  return edits;
}

export default async function handler(req, res) {
  const session = requireRole(req, res, ['editor']);
  if (!session) return;
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  const { action } = getQuery(req);

  if (action === 'save') {
    try {
      const body = await readJsonBody(req);
      const { post_id: postId } = body;
      if (!postId) return sendJson(res, 400, { error: 'post_id is required' });

      const post = await loadPendingPost(postId);
      const edits = collectEdits(body, post);
      if (Object.keys(edits).length > 0) await updatePost(postId, edits);
      return sendJson(res, 200, { ok: true, saved: Object.keys(edits) });
    } catch (err) {
      return sendJson(res, err.status ?? 500, { error: err.message });
    }
  }

  if (process.env.ADMIN_MOCK === '1') {
    return sendJson(res, 501, { error: 'publishing is disabled in mock mode; use scripts/publish-post.js --dry-run' });
  }

  try {
    const body = await readJsonBody(req);
    const { post_id: postId } = body;
    if (!postId) return sendJson(res, 400, { error: 'post_id is required' });

    const post = await loadPendingPost(postId);
    const edits = collectEdits(body, post);
    if (Object.keys(edits).length > 0) await updatePost(postId, edits);

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

    // Carry the image chosen at generation time through to the rendered page.
    // image_used holds the site-root-relative path; alt_text comes from images.
    const imageFilename = post.image_used ?? null;
    let imageAlt = '';
    if (imageFilename) {
      try {
        imageAlt = await getImageAltByFilename(getSupabaseClient(), imageFilename);
      } catch (imgErr) {
        console.error(`image alt lookup failed for post ${postId}: ${imgErr.message}`);
      }
    }

    const { publishPost } = await import('../../lib/publish.js');
    // Client-timezone date, not UTC (see scripts/sweep-and-publish.js).
    const date = todayInClientTz();
    const result = await publishPost({ pkg, date, existingPostId: postId, imageFilename, imageAlt });

    // Newly published post becomes a future RAG source. Best-effort: never
    // blocks publish if OpenAI embeddings or the content_chunks write fails.
    try {
      await indexContent({ sourceType: 'post', sourceId: postId, text: post.body_md });
    } catch (err) {
      console.error(`rag index failed for post ${postId}: ${err.message}`);
    }

    await updatePost(postId, { status: 'published', published_at: new Date().toISOString() });
    if (post.topic_id) await markTopicPublished(post.topic_id);

    return sendJson(res, 200, {
      ok: true,
      post_url: result.postUrl,
      commit: result.commitSha,
      post_commit_errors: result.postCommitErrors,
    });
  } catch (err) {
    return sendJson(res, err.status ?? 500, { error: err.message });
  }
}

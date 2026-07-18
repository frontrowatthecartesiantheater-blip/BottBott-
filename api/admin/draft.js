// Manually trigger a generation run for a topic that has a voice memo.
// Editor only. The cron publish path (M6) reuses the same steps; this
// endpoint exists so drafts can be produced and reviewed on demand.

import { readFileSync } from 'node:fs';
import { requireRole } from '../../lib/admin-auth.js';
import { sendJson, readJsonBody } from '../../lib/http.js';
import { getSupabaseClient } from '../../lib/supabase.js';
import { runGeneration } from '../../lib/generation/engine.js';
import { createAnthropicClient } from '../../lib/generation/anthropic.js';
import { selectUnusedImage, markImageUsed } from '../../lib/images.js';

export default async function handler(req, res) {
  const session = requireRole(req, res, ['editor']);
  if (!session) return;
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  if (process.env.ADMIN_MOCK === '1') {
    return sendJson(res, 501, { error: 'generation is disabled in mock mode; use scripts/test-generation.js' });
  }

  let topicId;
  try {
    ({ topic_id: topicId } = await readJsonBody(req));
    if (!topicId) return sendJson(res, 400, { error: 'topic_id is required' });

    const supabase = getSupabaseClient();
    const { data: topic, error: topicError } = await supabase
      .from('topics').select('*').eq('id', topicId).single();
    if (topicError || !topic) return sendJson(res, 404, { error: 'topic not found' });

    const { data: memos, error: memoError } = await supabase
      .from('voice_memos').select('*').eq('topic_id', topicId)
      .order('recorded_at', { ascending: false }).limit(1);
    if (memoError) return sendJson(res, 500, { error: memoError.message });
    if (!memos.length) {
      return sendJson(res, 409, { error: 'no voice memo recorded for this topic (RAG fallback runs only via cron)' });
    }
    const memo = memos[0];

    await supabase.from('topics').update({ status: 'generating' }).eq('id', topicId);

    // blog/index.json in the deployment bundle is current: every publish
    // commit triggers a fresh deploy.
    const priorPosts = JSON.parse(readFileSync('blog/index.json', 'utf8')).posts
      .slice(0, 5).map((p) => ({ title: p.title, slug: p.slug }));

    const result = await runGeneration({
      topicTitle: topic.title,
      topicDescription: topic.description,
      primaryKeyword: topic.primary_keyword,
      guidingQuestions: topic.guiding_questions || [],
      transcript: memo.transcript,
      priorPosts,
      ragFlag: false,
      ragChunks: null,
    }, createAnthropicClient());

    // Persist the dynamic TOV signals against the memo for later reference.
    await supabase.from('voice_memos').update({ tov_signals: result.dynamicTov }).eq('id', memo.id);

    const craftAudit = [
      result.craftAudit ?? '(no craft audit returned)',
      '',
      'LINT REPORT:',
      JSON.stringify(result.lint, null, 2),
    ].join('\n');

    // Loosely link an image by category (best-effort; never blocks the draft).
    let image = null;
    try {
      image = await selectUnusedImage(supabase, topic.category);
    } catch (imgErr) {
      console.error(`image selection failed for topic ${topicId}: ${imgErr.message}`);
    }

    const { post, social } = result.package;
    const { data: saved, error: saveError } = await supabase.from('posts').insert({
      topic_id: topicId,
      voice_memo_id: memo.id,
      slug: post.slug,
      title: post.title,
      body_md: post.body_md,
      meta_title: post.meta_title,
      meta_description: post.meta_description,
      primary_keyword: post.primary_keyword,
      keywords_used: [post.primary_keyword],
      internal_link_a: post.internal_link_a,
      internal_link_b: post.internal_link_b,
      rag_fallback: false,
      social_linkedin: social.linkedin,
      social_facebook: social.facebook,
      image_used: image?.filename ?? null,
      craft_audit: craftAudit,
      status: 'pending_review',
    }).select('id').single();
    if (saveError) return sendJson(res, 500, { error: `draft save failed: ${saveError.message}` });

    if (image) {
      try {
        await markImageUsed(supabase, image.id, saved.id);
      } catch (imgErr) {
        console.error(`marking image used failed for post ${saved.id}: ${imgErr.message}`);
      }
    }

    return sendJson(res, 200, { ok: true, post_id: saved.id, lint: result.lint });
  } catch (err) {
    if (topicId) {
      try {
        await getSupabaseClient().from('topics').update({ status: 'reminder_sent' }).eq('id', topicId);
      } catch (resetErr) {
        console.error(`resetting topic status failed for topic ${topicId}: ${resetErr.message}`);
      }
    }
    return sendJson(res, 500, { error: err.message });
  }
}

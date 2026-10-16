// Link-injection sweep (run every 30 minutes by .github/workflows/link-sweep.yml):
// find pending_review posts the link pipeline hasn't finished with, run
// injection on each, and stamp the post. Separated from the entry script (same
// split as lib/cron.js) so a test harness can call it with injected
// dependencies.
//
// Stamping and outcomes
// ---------------------
// posts.links_checked_at is what the admin panel and auto-publish gate on, so
// it is stamped whenever the sweep is DONE FOR NOW. posts.links_status says
// how it went:
//   ok               searched; links injected, flagged, banked, or none qualified
//   no_claims        the draft had nothing worth citing
//   search_failed    every search errored (not a quota problem)
//   quota_exhausted  the SerpApi account has no searches left
// The last two are RETRYABLE: the post stays eligible (within
// LINK_CONFIG.retryWindowHours of generation) and is re-swept until it
// succeeds. Before this, a post whose searches all failed was stamped as
// cleanly checked with zero links and never looked at again, which is how a
// spent quota went unnoticed for weeks.
//
// Quota: before any search-dependent work the sweep reads the SerpApi account
// (a free call). With no searches left it stamps new posts as
// quota_exhausted without spending a single model or search call, and emails
// the editor once a day. A low quota gets a one-off heads-up.
//
// Per-post failures are recorded in the summary rather than crashing the job:
// graceful, not silent, matching the other cron jobs. A failed run leaves the
// stamp null and the post retries on the next sweep.

import { getSupabaseClient } from '../supabase.js';
import { createLinkClients } from './models.js';
import { injectExternalLinks } from './engine.js';
import { getSearchQuota } from './search.js';
import { LINK_CONFIG } from './config.js';
import { sendEmail, failureEmail } from '../notify.js';

// Cap per run to keep one invocation bounded; anything beyond the cap is
// picked up by the next sweep.
const DEFAULT_MAX_POSTS = 3;
const RETRYABLE = ['search_failed', 'quota_exhausted'];

async function readQuota(quotaFn) {
  try {
    return await quotaFn();
  } catch (err) {
    return { left: null, error: err.message };
  }
}

// One alert per key per UTC day, deduped through system_config so a 30-minute
// cron does not send 48 identical emails.
async function alertOncePerDay(supabase, key, subject, lines, summary) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { data } = await supabase.from('system_config').select('value').eq('key', key).maybeSingle();
    if (data?.value === today) return;
    const result = await sendEmail(failureEmail(subject, lines));
    summary.alerts.push({ subject, ok: Boolean(result.ok) });
    if (result.ok) await supabase.from('system_config').upsert({ key, value: today }, { onConflict: 'key' });
  } catch (err) {
    summary.errors.push({ step: 'alert', subject, error: err.message });
  }
}

function quotaLines(quota, headline) {
  return [
    headline,
    '',
    `plan:       ${quota.plan ?? 'unknown'}`,
    `searches left: ${quota.left}${quota.limit ? ` of ${quota.limit}` : ''}`,
    `renews:     ${quota.renewal ?? 'unknown'}`,
    '',
    'Posts generated while the quota is out are stamped "quota_exhausted" and',
    'stay retryable: the sweep re-checks them automatically once searches are',
    'available again. You can still publish them in the meantime; they just',
    'will not have external source links until the retry succeeds.',
    '',
    'To restore searching sooner, upgrade the SerpApi plan or add credits.',
  ];
}

export async function runLinkSweep({
  maxPosts = DEFAULT_MAX_POSTS, supabase = null, clients = null,
  quotaFn = getSearchQuota, injectFn = injectExternalLinks, // injectable for tests
} = {}) {
  const summary = { job: 'link-sweep', processed: [], errors: [], alerts: [] };
  supabase = supabase ?? getSupabaseClient();

  let posts;
  try {
    const retryCutoff = new Date(Date.now() - LINK_CONFIG.retryWindowHours * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('posts')
      .select('id, slug, body_md, topic_id, links_checked_at, links_status, links_attempts, generated_at')
      .eq('status', 'pending_review')
      .or(`links_checked_at.is.null,and(links_status.in.(${RETRYABLE.join(',')}),generated_at.gte.${retryCutoff})`)
      .order('generated_at', { ascending: true })
      .limit(maxPosts);
    if (error) throw new Error(error.message);
    posts = (data ?? []).filter((p) => !(
      p.links_status === 'search_failed' && (p.links_attempts ?? 0) >= LINK_CONFIG.maxSearchAttempts
    ));
  } catch (err) {
    summary.errors.push({ step: 'load_posts', error: err.message });
    return summary;
  }
  if (posts.length === 0) return summary;

  const quota = await readQuota(quotaFn);
  summary.quota = quota;
  const exhausted = quota.left != null && quota.left <= 0;

  if (exhausted) {
    // No searches to spend: stamp un-swept posts so the editor is not blocked,
    // mark them retryable, and say so. No claim-extraction or search calls.
    const now = new Date().toISOString();
    for (const post of posts.filter((p) => !p.links_checked_at)) {
      const { error } = await supabase.from('posts').update({
        links_checked_at: now,
        links_status: 'quota_exhausted',
        links_report: { at: now, outcome: 'quota_exhausted', quota },
      }).eq('id', post.id);
      if (error) summary.errors.push({ postId: post.id, slug: post.slug, error: error.message });
      else summary.processed.push({ postId: post.id, slug: post.slug, outcome: 'quota_exhausted', ok: true });
    }
    await alertOncePerDay(supabase, 'link_quota_alert_date',
      'Autoblog: SerpApi search quota exhausted (no external links)',
      quotaLines(quota, 'The link sweep cannot search: the SerpApi account has no searches left.'), summary);
    return summary;
  }
  if (quota.left != null && quota.left <= LINK_CONFIG.quotaWarnBelow) {
    await alertOncePerDay(supabase, 'link_quota_warn_date',
      `Autoblog: SerpApi quota low (${quota.left} searches left)`,
      quotaLines(quota, 'The link sweep is running low on searches.'), summary);
  }

  clients = clients ?? createLinkClients();

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

      const result = await injectFn({
        bodyMd: post.body_md,
        supabase,
        clients,
        postId: post.id,
        draftRef: post.slug,
        topicId: post.topic_id ?? null,
        topicCategory,
        log: true,
      });
      entry.outcome = result.outcome;
      entry.injected = result.injected.length;
      entry.flagged = result.flagged.length;
      entry.surplus = result.surplus.length;
      entry.cap = result.cap;
      // Observability: without these, "no claims to cite" and "every search
      // failed" both log as injected=0 and are indistinguishable after the fact.
      entry.claims = result.claimCount;
      entry.claimsDroppedVerbatim = result.claimsDroppedVerbatim;
      entry.searchesAttempted = result.searchesAttempted;
      entry.searchFailures = result.searchFailures;
      entry.skipped = result.skipped;

      const now = new Date().toISOString();
      const patch = {
        links_checked_at: now,
        links_status: result.outcome,
        links_attempts: (post.links_attempts ?? 0) + (result.outcome === 'search_failed' ? 1 : 0),
        links_report: {
          at: now,
          outcome: result.outcome,
          claims: result.claimCount,
          claimsDroppedVerbatim: result.claimsDroppedVerbatim,
          injected: result.injected.length,
          flagged: result.flagged.length,
          surplus: result.surplus.length,
          searchesAttempted: result.searchesAttempted,
          searchFailures: result.searchFailures,
          quotaLeft: quota.left ?? null,
          skipped: result.skipped.slice(0, 25),
        },
      };

      // Write the spliced body only if the editor has not touched it while the
      // sweep was running (it takes minutes); otherwise the injected links are
      // still logged and shown in the review panel, but their edits win.
      if (result.injected.length > 0) {
        const { data: current } = await supabase.from('posts').select('body_md').eq('id', post.id).maybeSingle();
        if (current && current.body_md === post.body_md) {
          patch.body_md = result.bodyMd;
        } else {
          patch.links_report.bodyChangedDuringSweep = true;
          entry.bodyChangedDuringSweep = true;
        }
      }

      const { error: updateError } = await supabase.from('posts').update(patch).eq('id', post.id);
      if (updateError) throw new Error(`post update failed: ${updateError.message}`);

      entry.ok = true;
      summary.processed.push(entry);
      // Out of searches mid-run: stop here; the next tick stamps the rest
      // without spending anything.
      if (result.outcome === 'quota_exhausted') {
        await alertOncePerDay(supabase, 'link_quota_alert_date',
          'Autoblog: SerpApi search quota exhausted (no external links)',
          quotaLines({ ...quota, left: 0 }, 'The link sweep ran out of searches partway through.'), summary);
        break;
      }
    } catch (err) {
      // Stamp not written: this post retries on the next sweep.
      entry.ok = false;
      entry.error = err.message;
      summary.errors.push({ postId: post.id, slug: post.slug, error: err.message });
      summary.processed.push(entry);
    }
  }
  return summary;
}

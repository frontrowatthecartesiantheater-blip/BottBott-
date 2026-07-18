// Publish flow: takes a generation package (Call 3 output) and makes the
// post live. Steps:
//   1. Hard validations (H1 count, slug collision) — these throw and abort.
//   2. Render the post page, updated blog index, manifest, and sitemap.
//   3. ONE atomic GitHub commit with all four files (see lib/github.js).
//   4. Supabase posts record.
//   5. Google Sheet social log row (Sheets API, service-account auth).
//   6. Post-deploy verification: poll the live URL until it serves.
// Steps 4-6 run after the commit; their failures are reported in the result
// rather than thrown, because the post is already live at that point and
// the caller (cron or admin UI) decides how to alert.

import { checkH1 } from './generation/lint.js';
import {
  renderPostPage,
  renderBlogIndex,
  renderSitemap,
  toManifestEntry,
  computeReadMinutes,
} from './blog.js';
import { SITE_ORIGIN } from './client-config.js';

export function buildPublishFiles({ pkg, date, manifest, imageFilename = null, imageAlt = null }) {
  const { post } = pkg;

  // Hard fail (non-negotiable): exactly one H1 or no publish.
  if (!checkH1(post.body_md)) {
    const count = (post.body_md.match(/^# .+$/gm) || []).length;
    throw new Error(`PUBLISH BLOCKED: body_md must contain exactly one H1, found ${count}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`PUBLISH BLOCKED: invalid publish date "${date}"`);
  }
  if (manifest.posts.some((p) => p.slug === post.slug)) {
    throw new Error(`PUBLISH BLOCKED: slug "${post.slug}" already exists in the manifest`);
  }

  const postData = {
    slug: post.slug,
    title: post.title,
    date,
    metaTitle: post.meta_title,
    metaDescription: post.meta_description,
    bodyMd: post.body_md,
    // Site-root-relative image path (e.g. assets/images/blog/<category>/x.jpg)
    // selected by category at generation time; lib/blog.js renders it.
    image: imageFilename,
    imageAlt,
  };

  const entry = toManifestEntry(postData);
  const posts = [entry, ...manifest.posts].sort(
    (a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug),
  );
  const others = posts.filter((p) => p.slug !== post.slug);

  const files = [
    { path: `blog/${post.slug}.html`, content: renderPostPage(postData, others) },
    { path: 'blog/index.json', content: JSON.stringify({ posts }, null, 2) + '\n' },
    { path: 'blog/index.html', content: renderBlogIndex(posts) },
    { path: 'sitemap.xml', content: renderSitemap(posts) },
  ];
  assertIndexConsistency(files);
  return files;
}

// blog/index.json and blog/index.html ship as a pair in one commit and must
// agree: every slug in the manifest needs a card link in the index page.
// A mismatch means a render bug upstream; throwing here blocks the commit
// instead of silently publishing an index that hides posts.
export function assertIndexConsistency(files) {
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));
  const manifest = JSON.parse(byPath['blog/index.json']);
  const indexHtml = byPath['blog/index.html'];
  const missing = manifest.posts
    .filter((p) => !indexHtml.includes(`href="/blog/${p.slug}"`))
    .map((p) => p.slug);
  if (missing.length > 0) {
    throw new Error(`PUBLISH BLOCKED: blog/index.html has no card for: ${missing.join(', ')} (index.json/index.html mismatch)`);
  }
}

export function buildSupabaseRecord({ pkg, date, topicId = null, voiceMemoId = null, craftAudit = null, imageFilename = null }) {
  const { post } = pkg;
  return {
    topic_id: topicId,
    voice_memo_id: voiceMemoId,
    slug: post.slug,
    title: post.title,
    body_md: post.body_md,
    meta_title: post.meta_title,
    meta_description: post.meta_description,
    primary_keyword: post.primary_keyword,
    internal_link_a: post.internal_link_a,
    internal_link_b: post.internal_link_b,
    image_used: imageFilename,
    rag_fallback: Boolean(post.rag_fallback),
    status: 'published',
    published_at: new Date().toISOString(),
    craft_audit: craftAudit,
  };
}

export function buildSheetRow({ pkg, date }) {
  const postUrl = `${SITE_ORIGIN}/blog/${pkg.post.slug}`;
  return {
    publish_date: date,
    topic: pkg.post.title,
    post_url: postUrl,
    linkedin_draft: pkg.social.linkedin.replaceAll('[POST_URL]', postUrl),
    facebook_draft: pkg.social.facebook.replaceAll('[POST_URL]', postUrl),
  };
}

async function writeSheetRow(row) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not set');
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');

  let credentials;
  try {
    credentials = JSON.parse(Buffer.from(keyJson, 'base64').toString('utf8'));
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid base64-encoded JSON');
  }

  // Service-account JWT scoped to Sheets; one short-lived access token per write.
  const { JWT } = await import('google-auth-library');
  const client = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('failed to obtain Sheets API access token');

  // Append columns A-E of the next empty row on the "Social Posts" tab.
  // Columns F-G are the client's manual checkboxes; their existing data validation
  // is inherited by the new row, so we do not write them here.
  const range = 'Social Posts!A:E';
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/` +
    `${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      values: [[
        row.publish_date,
        row.topic,
        row.post_url,
        row.linkedin_draft,
        row.facebook_draft,
      ]],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Sheets append failed: ${res.status} ${body.slice(0, 300)}`);
  }
}

async function verifyLive(slug, { attempts = 10, intervalMs = 15000 } = {}) {
  const baseUrl = process.env.VERIFY_BASE_URL;
  if (!baseUrl) return { skipped: true, reason: 'VERIFY_BASE_URL not set (pre-DNS-cutover)' };
  const base = baseUrl.replace(/\/$/, '');
  const url = `${base}/blog/${slug}`;
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
      if (res.ok) {
        // The post page serving does not prove the index does: the post URL
        // is a brand-new path with no cached copy anywhere, while stale CDN
        // copies of blog/index.json / index.html from the previous deploy
        // can keep serving (July 2026 incident). Check the manifest too.
        let indexListed = null; // null = check itself failed, not a mismatch
        try {
          const idx = await fetch(`${base}/blog/index.json`, { redirect: 'follow' });
          if (idx.ok) indexListed = (await idx.text()).includes(`"${slug}"`);
        } catch {
          // leave indexListed null; reported as unverified, not stale
        }
        return { skipped: false, url, ok: true, indexListed };
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn(`verifyLive: fetch timed out after 4s for ${url} (attempt ${i + 1}/${attempts})`);
      }
      // network hiccup (or timeout above); soft failure, keep polling
    } finally {
      clearTimeout(timeout);
    }
  }
  return { skipped: false, url, ok: false };
}

/**
 * Publish a post for real. Throws on validation or commit failure; failures
 * after the commit are collected in result.postCommitErrors.
 *
 * existingPostId: pass when a posts row already exists (pending_review
 * approval path) — the Supabase insert is skipped and the caller updates
 * its own row. Without it (cron/CLI path), a new row is inserted.
 */
export async function publishPost({ pkg, date, topicId, voiceMemoId, craftAudit, existingPostId = null, imageFilename = null, imageAlt = null }) {
  const { fetchRepoFile, createSingleCommit } = await import('./github.js');
  const manifest = JSON.parse(await fetchRepoFile('blog/index.json'));

  const files = buildPublishFiles({ pkg, date, manifest, imageFilename, imageAlt });
  const commitSha = await createSingleCommit(
    `Publish blog post: ${pkg.post.slug}`,
    files,
  );

  const postCommitErrors = [];

  let supabaseId = existingPostId;
  if (!existingPostId) {
    try {
      const { getSupabaseClient } = await import('./supabase.js');
      const record = buildSupabaseRecord({ pkg, date, topicId, voiceMemoId, craftAudit, imageFilename });
      const { data, error } = await getSupabaseClient().from('posts').insert(record).select('id').single();
      if (error) throw new Error(error.message);
      supabaseId = data.id;
    } catch (err) {
      postCommitErrors.push({ step: 'supabase', error: err.message });
    }
  }

  try {
    await writeSheetRow(buildSheetRow({ pkg, date }));
  } catch (err) {
    postCommitErrors.push({ step: 'sheet', error: err.message });
  }

  const verification = await verifyLive(pkg.post.slug);
  if (verification.ok === false) {
    postCommitErrors.push({ step: 'verify', error: `post did not become reachable at ${verification.url}` });
  } else if (verification.indexListed === false) {
    postCommitErrors.push({ step: 'verify_index', error: 'live blog/index.json does not list the new post; likely stale CDN cache — purge/redeploy on Vercel' });
  }

  return {
    commitSha,
    supabaseId,
    postUrl: `${SITE_ORIGIN}/blog/${pkg.post.slug}`,
    readMinutes: computeReadMinutes(pkg.post.body_md),
    verification,
    postCommitErrors,
  };
}

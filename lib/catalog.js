// Content catalog: the author's own published posts (blog and Substack), each
// with an embedding, so the generation pipeline can link to a SPECIFIC post.
//
// Why it exists: the model only ever saw the last five blog posts and the
// Substack home page. When a voice memo said "I recently published a post about
// that, system link to that post, please", the draft linked the Substack root
// and the editor fixed it by hand. With the catalog, that request is embedded,
// matched to a real URL, and handed to the structure pass as a link it must
// include; related posts are offered the same way. A URL only ever comes from
// this table (blog posts from the posts table, Substack from its public feed and
// sitemap), never from the model's memory.
//
// Flow:
//   syncCatalog()          refresh entries (run by the sweep workflow, at most every 12h)
//   retrieveCatalog()      closest entries to some text, for a topic or a spoken request
//   resolveLinkRequests()  spoken "link to that post" requests -> best catalog match

import { isMock } from './mock.js';
import { CLIENT, SITE_ORIGIN } from './client-config.js';
import { embed, embedOne } from './embeddings.js';

const SUMMARY_MAX = 400;
const DEFAULT_MIN_SIMILARITY = 0.25;
const MAX_LINK_REQUESTS = 3;

const mockStore = []; // { source, url, title, summary, embedding }

// ------------------------------------------------------------------ parsing

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
}
const stripCdata = (s) => s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
const stripTags = (s) => s.replace(/<[^>]*>/g, ' ');
const clean = (s) => decodeEntities(stripTags(stripCdata(String(s).trim()))).replace(/\s+/g, ' ').trim();

/** Items of an RSS 2.0 feed: [{ url, title, summary, published_at }]. */
export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const pick = (tag) => {
      const t = m[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return t ? clean(t[1]) : null;
    };
    const url = pick('link');
    const title = pick('title');
    if (!url || !title) continue;
    const pub = pick('pubDate');
    items.push({
      url,
      title,
      summary: (pick('description') ?? '').slice(0, SUMMARY_MAX) || null,
      published_at: pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub).toISOString() : null,
    });
  }
  return items;
}

/** Post URLs (those containing /p/) from a sitemap. */
export function parseSitemapPostUrls(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()).filter((u) => /\/p\/[^/]+/.test(u));
}

/** og:title / og:description from a page, for posts the RSS feed no longer lists. */
export function parseOgMeta(html) {
  const og = (prop) => {
    const m = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']*)["']`, 'i'))
      ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:${prop}["']`, 'i'));
    return m ? clean(m[1]) : null;
  };
  return { title: og('title'), summary: og('description') };
}

// ------------------------------------------------------------------- sources

async function substackEntries(fetchFn) {
  const domain = CLIENT.personalSiteDomain;
  if (!domain) return [];
  const origin = `https://${domain}`;
  const get = async (path) => {
    const res = await fetchFn(`${origin}${path}`, { headers: { 'user-agent': 'autoblog-catalog/1.0' } });
    if (!res.ok) throw new Error(`${origin}${path} returned ${res.status}`);
    return res.text();
  };

  const fromFeed = parseRss(await get('/feed')).filter((e) => /\/p\//.test(e.url));
  const known = new Set(fromFeed.map((e) => e.url));
  const out = fromFeed.map((e) => ({ ...e, source: 'substack' }));

  // The feed lists only the newest ~20; the sitemap has them all.
  try {
    const missing = parseSitemapPostUrls(await get('/sitemap.xml')).filter((u) => !known.has(u));
    for (const url of missing) {
      try {
        const meta = parseOgMeta(await get(new URL(url).pathname));
        if (meta.title) out.push({ source: 'substack', url, title: meta.title, summary: (meta.summary ?? '').slice(0, SUMMARY_MAX) || null, published_at: null });
      } catch { /* one unreadable page must not lose the rest */ }
    }
  } catch { /* sitemap is a bonus */ }
  return out;
}

async function blogEntries(supabase) {
  const { data, error } = await supabase.from('posts')
    .select('slug, title, meta_description, published_at').eq('status', 'published');
  if (error) throw new Error(`posts read failed: ${error.message}`);
  return (data ?? []).map((p) => ({
    source: 'blog',
    url: `${SITE_ORIGIN}/blog/${p.slug}`,
    title: p.title,
    summary: (p.meta_description ?? '').slice(0, SUMMARY_MAX) || null,
    published_at: p.published_at,
  }));
}

// ---------------------------------------------------------------------- sync

/**
 * Refresh the catalog. Embeds only new or changed entries. Skips without
 * spending anything when embeddings are unavailable or the last sync is recent.
 */
export async function syncCatalog({ supabase = null, maxAgeHours = 12, force = false, fetchFn = fetch } = {}) {
  const result = { skipped: null, blog: 0, substack: 0, embedded: 0, errors: [] };
  if (!isMock() && !process.env.OPENAI_API_KEY) {
    return { ...result, skipped: 'OPENAI_API_KEY is not set in this environment (embeddings unavailable)' };
  }
  if (!supabase) {
    const { getSupabaseClient } = await import('./supabase.js');
    supabase = getSupabaseClient();
  }

  if (!force) {
    const { data } = await supabase.from('system_config').select('value').eq('key', 'catalog_synced_at').maybeSingle();
    if (data?.value && Date.now() - Date.parse(data.value) < maxAgeHours * 3600 * 1000) {
      return { ...result, skipped: `synced ${data.value}, within ${maxAgeHours}h` };
    }
  }

  const entries = [];
  try { entries.push(...await blogEntries(supabase)); } catch (err) { result.errors.push({ source: 'blog', error: err.message }); }
  try { entries.push(...await substackEntries(fetchFn)); } catch (err) { result.errors.push({ source: 'substack', error: err.message }); }
  result.blog = entries.filter((e) => e.source === 'blog').length;
  result.substack = entries.filter((e) => e.source === 'substack').length;
  if (entries.length === 0) return result;

  const { data: existing, error: readError } = await supabase.from('content_catalog').select('url, title, summary');
  if (readError) throw new Error(`content_catalog read failed: ${readError.message}`);
  const have = new Map((existing ?? []).map((r) => [r.url, r]));
  const changed = entries.filter((e) => {
    const r = have.get(e.url);
    return !r || r.title !== e.title || (r.summary ?? null) !== (e.summary ?? null);
  });

  if (changed.length) {
    const vectors = await embed(changed.map((e) => `${e.title}. ${e.summary ?? ''}`));
    const rows = changed.map((e, i) => ({ ...e, embedding: vectors[i], synced_at: new Date().toISOString() }));
    const { error } = await supabase.from('content_catalog').upsert(rows, { onConflict: 'url' });
    if (error) throw new Error(`content_catalog upsert failed: ${error.message}`);
    result.embedded = rows.length;
  }

  if (result.errors.length === 0) {
    await supabase.from('system_config').upsert({ key: 'catalog_synced_at', value: new Date().toISOString() }, { onConflict: 'key' });
  }
  return result;
}

// ------------------------------------------------------------------ retrieval

function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Closest catalog entries to `text`. Never throws: generation must not fail
 * because the catalog is unavailable (not migrated yet, embeddings down).
 * @returns {Promise<Array<{source, url, title, summary, similarity}>>}
 */
export async function retrieveCatalog(text, { topN = 5, source = null, minSimilarity = DEFAULT_MIN_SIMILARITY, supabase = null } = {}) {
  try {
    if (!text || !String(text).trim()) return [];
    const queryEmbedding = await embedOne(String(text));

    if (isMock()) {
      return mockStore
        .filter((r) => !source || r.source === source)
        .map((r) => ({ source: r.source, url: r.url, title: r.title, summary: r.summary, similarity: cosine(queryEmbedding, r.embedding) }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, topN);
    }

    if (!supabase) {
      const { getSupabaseClient } = await import('./supabase.js');
      supabase = getSupabaseClient();
    }
    const { data, error } = await supabase.rpc('match_content_catalog', {
      query_embedding: queryEmbedding, match_count: topN, source_filter: source,
    });
    if (error) throw new Error(error.message);
    return (data ?? []).filter((r) => r.similarity >= minSimilarity);
  } catch (err) {
    console.warn(`catalog unavailable, continuing without it: ${err.message}`);
    return [];
  }
}

/**
 * Turn spoken link requests ("system link to that post", with what the post is
 * about) into the best catalog match each.
 * @param {Array<{mention?: string, describes?: string}>} requests - from the pre-pass
 * @returns {Promise<Array<{mention: string, describes: string, match: object|null}>>}
 */
export async function resolveLinkRequests(requests, opts = {}) {
  const out = [];
  for (const r of (Array.isArray(requests) ? requests : []).slice(0, MAX_LINK_REQUESTS)) {
    const describes = String(r?.describes ?? '').trim();
    const mention = String(r?.mention ?? '').trim();
    if (!describes && !mention) continue;
    const [match] = await retrieveCatalog(describes || mention, { topN: 1, minSimilarity: 0.3, ...opts });
    out.push({ mention, describes, match: match ?? null });
  }
  return out;
}

/** Test-only: seed the mock store directly. */
export function _seedMockCatalog(rows) {
  if (!isMock()) throw new Error('_seedMockCatalog is mock-only');
  mockStore.push(...rows);
}

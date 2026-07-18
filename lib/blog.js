// Core blog rendering. Used by scripts/build-blog.js locally and by the
// publish flow at generation time. Every post page is fully static HTML with
// its own meta tags; no client-side rendering. Client-specific header/footer
// chrome is injected from client-config.js via chromeTokens().

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { marked } from 'marked';
import { SITE_ORIGIN, chromeTokens } from './client-config.js';

const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/assets/images/og-image.png`;
const PLACEHOLDER_CARD_IMAGE = 'assets/images/blog-placeholder.svg';
const WORDS_PER_MINUTE = 225;
const RELATED_POSTS_COUNT = 3;

const templatesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

function loadTemplate(name) {
  return readFileSync(path.join(templatesDir, name), 'utf8');
}

function fillTemplate(template, tokens) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in tokens)) throw new Error(`No value provided for template token ${match}`);
    return tokens[key];
  });
}

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function formatDateHuman(isoDate) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function computeReadMinutes(bodyMd) {
  const words = bodyMd.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export function markdownToHtml(bodyMd) {
  const html = marked.parse(bodyMd, { async: false }).trim();
  // The post's H1 lives inside the markdown body (the opening hook precedes
  // it, per the generation spec), so the title styling is applied here rather
  // than in the template.
  return html.replace('<h1>', '<h1 class="article__title">');
}

// Card markup shared by the blog index grid and the related-posts block.
// Post links are absolute (/blog/<slug>) so they resolve correctly from the
// clean /blog URL (served without a trailing slash) regardless of the page.
function renderPostCard(post, { assetPrefix = '../' } = {}) {
  const href = `/blog/${post.slug}`;
  const image = post.image || PLACEHOLDER_CARD_IMAGE;
  return `          <article class="card">
            <a href="${href}">
              <img class="card__media" src="${assetPrefix}${image}" alt="" width="800" height="450" loading="lazy">
            </a>
            <div class="card__body">
              <p class="meta">${formatDateHuman(post.date)} &middot; ${post.readMinutes} min read</p>
              <h2 class="card__title">${escapeHtml(post.title)}</h2>
              <p class="card__text">${escapeHtml(post.description)}</p>
              <a class="card__link" href="${href}">Read more &rarr;</a>
            </div>
          </article>`;
}

function renderRelatedPostsBlock(relatedPosts) {
  if (relatedPosts.length === 0) return '';
  const cards = relatedPosts.map((post) => renderPostCard(post)).join('\n\n');
  return `
    <!-- ======================= Related posts ========================= -->
    <section class="section section--gray">
      <div class="container">
        <h2 class="center" style="margin-bottom:var(--gap-loose);">More from the blog</h2>
        <div class="grid grid--3">
${cards}
        </div>
      </div>
    </section>
`;
}

function renderFeaturedImageBlock(post) {
  if (!post.image) return '';
  const alt = post.imageAlt || '';
  return `          <img class="article__featured" src="../${post.image}" alt="${escapeHtml(alt)}" width="1440" height="810">\n`;
}

/**
 * Render a complete static post page.
 * @param {object} post - { slug, title, date (YYYY-MM-DD), metaTitle,
 *   metaDescription, bodyMd, image?, imageAlt? }
 * @param {object[]} otherPosts - manifest entries excluding this post,
 *   newest first; used for the related-posts section.
 */
export function renderPostPage(post, otherPosts = []) {
  const canonicalUrl = `${SITE_ORIGIN}/blog/${post.slug}`;
  const related = otherPosts.slice(0, RELATED_POSTS_COUNT);
  return fillTemplate(loadTemplate('post.html'), {
    ...chromeTokens(),
    META_TITLE: escapeHtml(post.metaTitle || post.title),
    META_DESCRIPTION: escapeHtml(post.metaDescription),
    META_DESCRIPTION_JSON: JSON.stringify(post.metaDescription),
    TITLE_JSON: JSON.stringify(post.title),
    CANONICAL_URL: canonicalUrl,
    OG_IMAGE: post.image ? `${SITE_ORIGIN}/${post.image}` : DEFAULT_OG_IMAGE,
    DATE_ISO: post.date,
    DATE_HUMAN: formatDateHuman(post.date),
    READ_MINUTES: String(computeReadMinutes(post.bodyMd)),
    FEATURED_IMAGE_BLOCK: renderFeaturedImageBlock(post),
    ARTICLE_BODY: markdownToHtml(post.bodyMd),
    RELATED_POSTS_BLOCK: renderRelatedPostsBlock(related),
  });
}

/**
 * Render the blog index page from the manifest (newest first).
 */
export function renderBlogIndex(posts) {
  const cards = posts.map((post) => renderPostCard(post)).join('\n\n');
  return fillTemplate(loadTemplate('blog-index.html'), { ...chromeTokens(), POST_CARDS: cards });
}

// Every static BottBott page, mirroring the hand-maintained sitemap.xml this
// replaces. A new site page must be added here or it drops out of the sitemap
// on the next blog publish.
const STATIC_SITEMAP_PATHS = [
  '/',
  '/solutions/',
  '/autoblog/',
  '/podcast-pitching/',
  '/linkedin-outreach-pipeline/',
  '/warm-outreach/',
  '/strategy-call/',
  '/ongoing-support/',
  '/workflow-build/',
  '/agent-build/',
  '/webapp-build/',
  '/team-fluency/',
  '/about/',
  '/how-we-work/',
  '/privacy/',
  '/blog/',
];

/**
 * Render sitemap.xml: static pages plus every post, clean URLs.
 */
export function renderSitemap(posts) {
  const staticEntries = STATIC_SITEMAP_PATHS.map(
    (p) => `  <url>\n    <loc>${SITE_ORIGIN}${p}</loc>\n  </url>`,
  );
  const postEntries = posts.map(
    (post) =>
      `  <url>\n    <loc>${SITE_ORIGIN}/blog/${post.slug}</loc>\n    <lastmod>${post.date}</lastmod>\n  </url>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...staticEntries,
    ...postEntries,
    '</urlset>',
    '',
  ].join('\n');
}

/**
 * Build a manifest entry for a post. Manifest order is maintained by the
 * caller (newest first).
 */
export function toManifestEntry(post) {
  return {
    slug: post.slug,
    title: post.title,
    date: post.date,
    description: post.metaDescription,
    image: post.image || null,
    readMinutes: computeReadMinutes(post.bodyMd),
  };
}

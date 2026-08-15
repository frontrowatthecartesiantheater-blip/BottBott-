// Local blog build: renders every post in content/posts/ to static HTML,
// then regenerates blog/index.json, blog/index.html, and sitemap.xml.
// The production publish flow (M4) renders the same way but commits the
// output via the GitHub API instead of writing to disk.
//
// Usage: npm run build:blog

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import matter from 'gray-matter';
import {
  renderPostPage,
  renderBlogIndex,
  renderSitemap,
  toManifestEntry,
} from '../lib/blog.js';

// The autoblog admin pipeline (lib/publish.js, via api/cron/publish.js and
// api/admin/publish.js) is now the only supported publish path — it commits
// posts straight to blog/index.json, blog/index.html, and sitemap.xml via
// the GitHub API. This script rebuilds those same files from content/posts/
// *.md only, by full overwrite, not merge. content/posts/ does not track
// every post the pipeline has published, so running this script can drop
// pipeline-published posts out of the manifest and the sitemap.
if (!process.argv.includes('--force')) {
  console.log(
    'scripts/build-blog.js is disabled by default.\n\n' +
      'The autoblog admin pipeline is now the only supported publish path.\n' +
      'This script regenerates blog/index.json, blog/index.html, and\n' +
      'sitemap.xml from content/posts/*.md by overwriting the manifest, not\n' +
      'merging it — any post published through the pipeline but missing a\n' +
      'corresponding content/posts/*.md file will be dropped.\n\n' +
      'Pass --force to run anyway: npm run build:blog -- --force',
  );
  process.exit(0);
}

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const postsDir = path.join(repoRoot, 'content', 'posts');
const blogDir = path.join(repoRoot, 'blog');

const REQUIRED_FIELDS = ['title', 'date', 'slug', 'meta_description'];

function loadPosts() {
  const files = readdirSync(postsDir).filter((f) => f.endsWith('.md'));
  const posts = files.map((file) => {
    const { data, content } = matter(readFileSync(path.join(postsDir, file), 'utf8'));
    for (const field of REQUIRED_FIELDS) {
      if (!data[field]) throw new Error(`${file}: missing required frontmatter field "${field}"`);
    }
    return {
      slug: data.slug,
      title: data.title,
      date: String(data.date).slice(0, 10),
      metaTitle: data.meta_title || data.title,
      metaDescription: data.meta_description,
      image: data.image || null,
      imageAlt: data.image_alt || '',
      bodyMd: content.trim(),
      sourceFile: file,
    };
  });
  // Newest first; stable tie-break on slug.
  posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  return posts;
}

const posts = loadPosts();
const manifestEntries = posts.map(toManifestEntry);

mkdirSync(blogDir, { recursive: true });

for (const post of posts) {
  const others = manifestEntries.filter((entry) => entry.slug !== post.slug);
  writeFileSync(path.join(blogDir, `${post.slug}.html`), renderPostPage(post, others));
  console.log(`built blog/${post.slug}.html (${post.sourceFile})`);
}

writeFileSync(
  path.join(blogDir, 'index.json'),
  JSON.stringify({ posts: manifestEntries }, null, 2) + '\n',
);
writeFileSync(path.join(blogDir, 'index.html'), renderBlogIndex(manifestEntries));
writeFileSync(path.join(repoRoot, 'sitemap.xml'), renderSitemap(manifestEntries));

console.log(`built blog/index.json, blog/index.html, sitemap.xml (${posts.length} posts)`);

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

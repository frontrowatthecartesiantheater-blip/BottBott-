// Submits changed sitemap.xml URLs to Bing's IndexNow API so new and updated
// pages get crawled fast, instead of waiting for Bing's own discovery cycle.
// Diffs <lastmod> against the previous commit's sitemap.xml to find exactly
// what changed, rather than resubmitting the whole site on every push.
//
// Usage:
//   node scripts/indexnow.mjs          submit only URLs whose lastmod changed
//   node scripts/indexnow.mjs --all    submit every URL in the sitemap

import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT, SITE_ORIGIN } from '../lib/client-config.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_FILE_PATTERN = /^[0-9a-f]{32}\.txt$/;

function parseSitemap(xml) {
  const entries = new Map();
  const urlBlocks = xml.match(/<url>[\s\S]*?<\/url>/g) || [];
  for (const block of urlBlocks) {
    const loc = block.match(/<loc>(.*?)<\/loc>/)?.[1];
    const lastmod = block.match(/<lastmod>(.*?)<\/lastmod>/)?.[1];
    if (loc) entries.set(loc, lastmod || '');
  }
  return entries;
}

function findKeyFile() {
  const match = readdirSync(repoRoot).find((f) => KEY_FILE_PATTERN.test(f));
  if (!match) throw new Error('No IndexNow key file (32 lowercase hex chars + .txt) found at repo root.');
  return match;
}

const current = parseSitemap(readFileSync(path.join(repoRoot, 'sitemap.xml'), 'utf8'));
const submitAll = process.argv.includes('--all');

let urlList;
if (submitAll) {
  urlList = [...current.keys()];
} else {
  let previous = new Map();
  try {
    const prevXml = execSync('git show HEAD~1:sitemap.xml', { cwd: repoRoot, encoding: 'utf8' });
    previous = parseSitemap(prevXml);
  } catch {
    console.log('No previous sitemap.xml to diff against (first commit on this branch?). Pass --all to force a full submit.');
  }
  urlList = [...current.entries()]
    .filter(([url, lastmod]) => previous.get(url) !== lastmod)
    .map(([url]) => url);
}

if (urlList.length === 0) {
  console.log('No changed URLs to submit.');
  process.exit(0);
}

const keyFile = findKeyFile();
const key = keyFile.replace(/\.txt$/, '');
const host = CLIENT.siteDomain;
const keyLocation = `${SITE_ORIGIN}/${keyFile}`;

console.log(`Submitting ${urlList.length} URL(s) to IndexNow:`);
for (const url of urlList) console.log(`  ${url}`);

try {
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host, key, keyLocation, urlList }),
  });
  if (res.ok) {
    console.log(`IndexNow accepted the submission (${res.status}).`);
  } else {
    const body = await res.text();
    console.error(`IndexNow submission failed: ${res.status} ${body}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`IndexNow submission failed: ${err.message}`);
  process.exit(1);
}

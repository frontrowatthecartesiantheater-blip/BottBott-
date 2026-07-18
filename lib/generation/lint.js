// Programmatic quality gates over a generation result. These mirror the
// generation spec's voice/SEO/structural rules so violations are caught by
// code, not just by the model's own polish pass. The publish flow reuses
// checkH1() as the publish-time hard fail.

import { CLIENT } from '../client-config.js';

const BANNED_PHRASES = [
  'delve into', 'navigate', 'navigating', 'landscape', 'leverage', 'robust',
  'utilize', 'holistic', 'comprehensive', "it's important to note",
  "in today's market", "in today's world", 'when it comes to',
  'at the end of the day', "don't hesitate to reach out",
];

// AI narrative hooks: dramatic setup-before-reveal framing is an AI tell.
// Any sentence-initial "Here's" / "Here is" is treated as a hook, plus the
// "This is..." variants below.
const NARRATIVE_HOOK_PATTERNS = [
  /(?:^|[.!?]\s+|\n)(here's\b)/gi,
  /(?:^|[.!?]\s+|\n)(here is\b)/gi,
  /(?:^|[.!?]\s+|\n)(this is the part that\b)/gi,
  /(?:^|[.!?]\s+|\n)(this is what most people miss\b)/gi,
  /(?:^|[.!?]\s+|\n)(and here's why\b)/gi,
];

export function checkH1(bodyMd) {
  const h1s = bodyMd.match(/^# .+$/gm) || [];
  return h1s.length === 1;
}

function headings(bodyMd, level) {
  const pattern = new RegExp(`^#{${level}} (.+)$`, 'gm');
  return [...bodyMd.matchAll(pattern)].map((m) => m[1].trim());
}

function bodyTextOnly(bodyMd) {
  return bodyMd
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n');
}

function countOccurrences(haystack, needle) {
  return haystack.toLowerCase().split(needle.toLowerCase()).length - 1;
}

// Keyword counting accepts one small filler word between tokens, so the
// natural phrasing the spec demands (rule 27: phrasing a keyword the way a
// person speaks it, e.g. "fixing a burst pipe in Denver" rather than a
// stacked noun phrase) still registers against keywords stored without the
// filler.
function countKeyword(text, keyword) {
  const tokens = keyword.toLowerCase().split(/\s+/)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(tokens.join('\\s+(?:in\\s+|for\\s+|near\\s+|around\\s+)?'), 'gi');
  return (text.match(pattern) || []).length;
}

export function lintGenerationResult(pkg, primaryKeyword) {
  const { post, social } = pkg;
  const findings = [];
  const add = (level, check, detail) => findings.push({ level, check, detail });

  // --- structural
  const h1s = post.body_md.match(/^# .+$/gm) || [];
  if (h1s.length !== 1) {
    add('error', 'h1-count', `expected exactly 1 H1, found ${h1s.length}`);
  }
  const h2s = headings(post.body_md, 2);
  if (h2s.length < 3) add('warn', 'h2-count', `only ${h2s.length} H2 sections`);
  for (const h of [...h1s.map((h) => h.slice(2)), ...h2s]) {
    if (h.includes(':')) add('error', 'header-colon', `header contains a colon: "${h}"`);
  }
  const lastH2 = h2s[h2s.length - 1] || '';
  const nameToken = (CLIENT.firstName || CLIENT.fullName || '').split(/\s+/)[0];
  if (nameToken && !new RegExp(nameToken, 'i').test(lastH2)) {
    add('warn', 'conclusion-name', `conclusion H2 does not mention ${nameToken}: "${lastH2}"`);
  }

  // --- voice / AI tells (post body + both socials)
  const allText = [post.body_md, social.linkedin, social.facebook].join('\n');
  const emDashes = (allText.match(/—/g) || []).length;
  if (emDashes > 0) add('error', 'em-dash', `${emDashes} em dash(es) present`);
  for (const phrase of BANNED_PHRASES) {
    const n = countOccurrences(allText, phrase);
    if (n > 0) add('error', 'banned-phrase', `"${phrase}" appears ${n}x`);
  }
  for (const pattern of NARRATIVE_HOOK_PATTERNS) {
    const matches = [...allText.matchAll(pattern)];
    if (matches.length > 0) {
      add('error', 'narrative-hook', `sentence opener "${matches[0][1]}" appears ${matches.length}x (AI narrative hook; state it directly)`);
    }
  }

  // --- keyword
  const bodyText = bodyTextOnly(post.body_md);
  const keywordCount = countKeyword(bodyText, primaryKeyword);
  if (keywordCount < 4 || keywordCount > 6) {
    add('warn', 'keyword-count', `primary keyword appears ${keywordCount}x in body text (target 4-6, counting single-filler variants like "... in ...")`);
  }

  // --- length
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
  if (wordCount < 800 || wordCount > 1250) {
    add('warn', 'word-count', `body is ${wordCount} words (target 900-1,100)`);
  }
  const fbWords = social.facebook.split(/\s+/).filter(Boolean).length;
  if (fbWords > 60) add('warn', 'facebook-length', `Facebook draft is ${fbWords} words (max 50)`);
  const liWords = social.linkedin.split(/\s+/).filter(Boolean).length;
  if (liWords < 150 || liWords > 350) {
    add('warn', 'linkedin-length', `LinkedIn draft is ${liWords} words (target 200-300)`);
  }

  // --- links (0-2 are valid; only a claimed-but-absent link is a failure)
  for (const [key, url] of [['internal_link_a', post.internal_link_a], ['internal_link_b', post.internal_link_b]]) {
    if (url && !post.body_md.includes(url)) {
      add('error', 'missing-link', `${key} (${url}) not found in body markdown`);
    }
  }

  // --- metadata
  if (post.meta_title.length > 60) {
    add('warn', 'meta-title-length', `meta_title is ${post.meta_title.length} chars (max 55)`);
  }
  if (post.meta_description.length > 160) {
    add('warn', 'meta-description-length', `meta_description is ${post.meta_description.length} chars (max 155)`);
  }
  if (!/^[a-z0-9-]{1,50}$/.test(post.slug)) {
    add('error', 'slug-format', `slug "${post.slug}" is not lowercase-hyphenated <= 50 chars`);
  }
  if (social.linkedin.includes('[POST_URL]')) add('warn', 'linkedin-url', 'LinkedIn draft should not contain [POST_URL] or a URL; the link goes in comments');
  if (social.facebook.includes('[POST_URL]')) add('warn', 'facebook-url', 'Facebook draft should not contain [POST_URL] or a URL; the link goes in comments');

  return {
    ok: !findings.some((f) => f.level === 'error'),
    wordCount,
    keywordCount,
    findings,
  };
}

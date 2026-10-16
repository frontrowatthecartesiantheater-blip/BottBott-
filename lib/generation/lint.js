// Programmatic quality gates over a generation result. These mirror the
// generation spec's voice/SEO/structural rules so violations are caught by
// code, not just by the model's own polish pass. The publish flow reuses
// checkH1() as the publish-time hard fail.

const BANNED_PHRASES = [
  'delve into', 'navigate', 'navigating', 'landscape', 'leverage', 'robust',
  'utilize', 'holistic', 'comprehensive', "it's important to note",
  "in today's market", "in today's world", 'when it comes to',
  'at the end of the day', "don't hesitate to reach out",
];

// AI narrative hooks: dramatic setup-before-reveal framing is an AI tell.
// Only the specific dramatic setups are flagged; a plain "Here's the thing"
// mid-argument transition is part of the client's voice and stays.
const NARRATIVE_HOOK_PATTERNS = [
  /(?:^|[.!?]\s+|\n)(here's what nobody\b)/gi,
  /(?:^|[.!?]\s+|\n)(here is what nobody\b)/gi,
  /(?:^|[.!?]\s+|\n)(here's the part that\b)/gi,
  /(?:^|[.!?]\s+|\n)(this is the part that\b)/gi,
  /(?:^|[.!?]\s+|\n)(this is what most people miss\b)/gi,
  /(?:^|[.!?]\s+|\n)(and here's why\b)/gi,
];

// Public facts the speaker has misstated on the record. The canonical version
// lives in client-config (canonicalFacts) and in the prompts; this is the
// backstop for when a draft repeats the slip anyway.
const KNOWN_FACT_PATTERNS = [
  {
    re: /chatgpt[^.!?\n]{0,60}\b(?:launched|came out|was released|released|debuted|arrived)\b[^.!?\n]{0,30}\b2023\b/i,
    detail: 'ChatGPT launched in November 2022, not 2023',
  },
  {
    re: /\b2023\b[^.!?\n]{0,30}\bchatgpt\b[^.!?\n]{0,30}\b(?:launched|came out|was released|debuted)\b/i,
    detail: 'ChatGPT launched in November 2022, not 2023',
  },
];

function wordsOf(text) {
  return text
    .toLowerCase()
    .replace(/\]\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Runs of copied text between a new draft and already-published posts. Talking
 * points may be rehashed, never quoted: a run of ${minRun}+ identical words
 * means a sentence was lifted rather than restated.
 * @param {string} bodyMd
 * @param {Array<{slug: string, body_md: string}>} priorBodies
 * @returns {Array<{slug: string, words: number, snippet: string}>} longest run per prior post
 */
export function findVerbatimReuse(bodyMd, priorBodies = [], { minRun = 12 } = {}) {
  const words = wordsOf(bodyMd);
  if (words.length < minRun) return [];
  const hits = [];
  for (const prior of priorBodies) {
    const priorWords = wordsOf(prior.body_md ?? '');
    if (priorWords.length < minRun) continue;
    const shingles = new Set();
    for (let i = 0; i + minRun <= priorWords.length; i += 1) shingles.add(priorWords.slice(i, i + minRun).join(' '));

    let best = null;
    let runStart = null;
    let runEnd = null;
    const flush = () => {
      if (runStart === null) return;
      const length = runEnd - runStart + minRun;
      if (!best || length > best.words) best = { slug: prior.slug, words: length, snippet: words.slice(runStart, runStart + Math.min(length, 20)).join(' ') };
      runStart = null;
    };
    for (let i = 0; i + minRun <= words.length; i += 1) {
      if (shingles.has(words.slice(i, i + minRun).join(' '))) {
        if (runStart === null) runStart = i;
        runEnd = i;
      } else {
        flush();
      }
    }
    flush();
    if (best) hits.push(best);
  }
  return hits;
}

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

// Keyword counting accepts up to two small connective words between tokens,
// so the natural phrasing the spec demands (rule 27: phrasing a keyword the
// way a person speaks it, e.g. "fixing a burst pipe in Denver" rather than a
// stacked noun phrase) registers against keywords stored without them. The
// filler list is a closed set of articles and short prepositions — never
// arbitrary words — so tokens from unrelated clauses cannot bridge.
// Advisory measurement only; nothing gates on this count.
const KEYWORD_FILLERS = ['a', 'an', 'the', 'in', 'for', 'near', 'around', 'during', 'of', 'on', 'at', 'to', 'with', 'your'];

function countKeyword(text, keyword) {
  const tokens = keyword.toLowerCase().split(/\s+/)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const filler = `(?:(?:${KEYWORD_FILLERS.join('|')})\\s+){0,2}`;
  const pattern = new RegExp(tokens.join(`\\s+${filler}`), 'gi');
  return (text.match(pattern) || []).length;
}

/**
 * @param {object} pkg - parsed Call 3 package
 * @param {string} primaryKeyword
 * @param {{priorBodies?: Array<{slug: string, body_md: string}>, anonymizeNames?: string[]}} [context]
 */
export function lintGenerationResult(pkg, primaryKeyword, { priorBodies = [], anonymizeNames = [] } = {}) {
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
  const lastH2 = h2s[h2s.length - 1] || '';
  if (/^(conclusion|final thoughts|key takeaways)$/i.test(lastH2.trim())) {
    add('warn', 'conclusion-label', `conclusion H2 is a generic label, not a declarative statement: "${lastH2}"`);
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

  // --- client anonymity: clients are described by role and industry, never named
  const metaText = [post.title, post.meta_title, post.meta_description].join('\n');
  for (const name of anonymizeNames) {
    const n = countOccurrences([allText, metaText].join('\n'), name);
    if (n > 0) add('error', 'client-name', `client name "${name}" appears ${n}x; describe the client by role and industry instead`);
  }

  // --- known public-fact slips
  for (const { re, detail } of KNOWN_FACT_PATTERNS) {
    if (re.test(allText)) add('error', 'known-fact', detail);
  }

  // --- verbatim reuse of already-published posts (talking points are rehashed, not quoted)
  for (const hit of findVerbatimReuse(post.body_md, priorBodies)) {
    add('error', 'verbatim-reuse', `${hit.words} consecutive words match the published post "${hit.slug}": "${hit.snippet}"`);
  }

  // --- keyword
  const bodyText = bodyTextOnly(post.body_md);
  const keywordCount = countKeyword(bodyText, primaryKeyword);
  // Presence check only: no numeric target — search engines reward natural
  // language, not keyword density. Warn only when the keyword never appears
  // at all.
  if (keywordCount === 0) {
    add('warn', 'keyword-count', 'primary keyword absent from body text (counting natural variants with small connective words)');
  }

  // --- length
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
  if (wordCount < 1100 || wordCount > 1650) {
    add('warn', 'word-count', `body is ${wordCount} words (target 1,200-1,500)`);
  }
  const fbWords = social.facebook.split(/\s+/).filter(Boolean).length;
  if (fbWords > 60) add('warn', 'facebook-length', `Facebook draft is ${fbWords} words (max 50)`);
  const liWords = social.linkedin.split(/\s+/).filter(Boolean).length;
  if (liWords < 150 || liWords > 350) {
    add('warn', 'linkedin-length', `LinkedIn draft is ${liWords} words (target 200-300)`);
  }

  // --- links (0-3 are valid; only a claimed-but-absent link is a failure)
  const claimedLinks = post.internal_links ?? [post.internal_link_a, post.internal_link_b].filter(Boolean);
  claimedLinks.forEach((url, i) => {
    if (url && !post.body_md.includes(url)) {
      add('error', 'missing-link', `internal link ${i + 1} (${url}) not found in body markdown`);
    }
  });

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

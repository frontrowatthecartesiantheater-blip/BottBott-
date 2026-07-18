// Step 7: freshness — a one-time, PERMANENT verdict per domain. A page's
// publish date doesn't change, so this is never rechecked by the scheduler.
//
// Rules:
//   - reject if the publish date is undetectable or older than 2 years
//   - .gov / .edu auto-pass regardless of age
//   - allowlisted domains (per-client curated) bypass the 2-year rule;
//     .org gets NO blanket pass (too easy to abuse)

import { LINK_CONFIG } from './config.js';
import { parseJsonResponse } from './models.js';
import { tldOf } from './domains.js';
import { htmlToText } from './liveness.js';

// Pull the date-bearing signals out of the FULL document rather than sending
// the model a raw-HTML prefix: on modern pages the first N KB is head bloat
// (inline CSS/scripts) and contains no date at all, while both the meta tags
// and the human-visible date near the headline live far past any reasonable
// prefix. Layout-agnostic: structured sources + early visible text, no
// per-site DOM assumptions.
function extractDateSignals(html) {
  const metaTags = (html.match(/<meta[^>]+>/gi) ?? [])
    .filter((tag) => /date|publish|modified|time/i.test(tag))
    .slice(0, 20);
  const timeElements = (html.match(/<time[^>]*>[\s\S]*?<\/time>/gi) ?? []).slice(0, 10);
  const jsonLd = (html.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) ?? [])
    .slice(0, 4)
    .map((block) => block.slice(0, 3000));
  // Visible dates sit near the headline/byline in virtually every article
  // layout, i.e. early in the rendered text even when deep in the raw HTML.
  const visibleText = htmlToText(html).slice(0, 4000);
  return { metaTags, timeElements, jsonLd, visibleText };
}

function buildPublishDatePrompt(html) {
  const signals = extractDateSignals(html);
  return `Find the publish (or last-updated) date of a web page. Below are the date-bearing parts extracted from its HTML.

STRUCTURED SOURCES (prefer these when present):
Meta tags:
${signals.metaTags.join('\n') || '(none)'}

<time> elements:
${signals.timeElements.join('\n') || '(none)'}

JSON-LD:
${signals.jsonLd.join('\n') || '(none)'}

VISIBLE PAGE TEXT (start of the rendered page — look for a date near the headline/byline):
${signals.visibleText}

Prefer a structured publish date (article:published_time, datePublished) over a modified date; if no structured date exists, use a clearly visible publish date from the page text.

Return ONLY a JSON object, no preamble, no code fence:
{ "publish_date": "YYYY-MM-DD" }
or, if no date is genuinely detectable:
{ "publish_date": null }

Never guess a date that is not present in the material above.
Output the JSON object and nothing else — no explanation, no text before or after it.`;
}

/** @returns {Promise<string|null>} ISO date or null if undetectable */
export async function extractPublishDate(haiku, { domain, html }) {
  const response = await haiku({
    label: `link-publish-date:${domain}`,
    prompt: buildPublishDatePrompt(html),
    maxTokens: 128,
  });
  const parsed = parseJsonResponse(response, `publish date for ${domain}`);
  const date = parsed.publish_date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return date;
}

/**
 * @returns {{ pass: boolean, reason: string }}
 */
export function freshnessVerdict({ domain, publishDate, allowlisted = false }) {
  if (LINK_CONFIG.autoPassTlds.includes(tldOf(domain))) {
    return { pass: true, reason: `.${tldOf(domain)} auto-pass` };
  }
  if (allowlisted) return { pass: true, reason: 'allowlisted domain' };
  if (!publishDate) return { pass: false, reason: 'publish date undetectable' };

  const ageDays = (Date.now() - new Date(publishDate).getTime()) / (24 * 3600 * 1000);
  if (Number.isNaN(ageDays)) return { pass: false, reason: `unparseable publish date "${publishDate}"` };
  if (ageDays > LINK_CONFIG.freshnessMaxAgeDays) {
    return { pass: false, reason: `published ${publishDate}, older than ${LINK_CONFIG.freshnessMaxAgeDays} days` };
  }
  return { pass: true, reason: `published ${publishDate}` };
}

// Step 6: trust scoring — a free/self-built proxy, no paid DA API. Composite
// 0-100 from signals available via free lookups:
//   - domain age        (RDAP, the free WHOIS successor)   0-25
//   - structural HTML   (Haiku: byline, about page, ads,
//     link-farm patterns)                                  0-45
//   - cross-mentions    (tally from our own search calls)  0-20
//   - HTTPS validity    (the page fetched over https OK)   0-10
// .gov/.edu get a floor of 90 (RDAP coverage there is poor and they'd pass
// any editorial judgment gate anyway). This is a judgment gate, not a
// precision instrument.

import { parseJsonResponse } from './models.js';
import { tldOf } from './domains.js';
import { LINK_CONFIG } from './config.js';

/** Domain registration age in years via rdap.org, or null if unavailable. */
export async function getDomainAgeYears(domain) {
  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`, {
      signal: AbortSignal.timeout(LINK_CONFIG.fetchTimeoutMs),
      headers: { accept: 'application/rdap+json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const registration = (data.events ?? []).find((e) => e.eventAction === 'registration');
    if (!registration?.eventDate) return null;
    const ms = Date.now() - new Date(registration.eventDate).getTime();
    return ms > 0 ? ms / (365.25 * 24 * 3600 * 1000) : null;
  } catch {
    return null;
  }
}

function buildStructuralPrompt(html) {
  return `Assess structural quality signals of a web page from its HTML. Return ONLY a JSON object — no preamble, no code fence, no explanation before or after it.

{
  "has_byline": true|false,          // a named author/byline is present
  "has_about_or_contact": true|false, // links to an About/Contact/team page
  "low_ad_density": true|false,      // page is not saturated with ads/affiliate units
  "not_link_farm": true|false        // page is real editorial content, not an SEO link farm / thin directory
}

HTML (truncated):
${html.slice(0, 12000)}`;
}

export async function structuralSignals(haiku, { domain, html }) {
  const response = await haiku({
    label: `link-structural:${domain}`,
    prompt: buildStructuralPrompt(html),
    maxTokens: 256,
  });
  const parsed = parseJsonResponse(response, `structural signals for ${domain}`);
  return {
    has_byline: parsed.has_byline === true,
    has_about_or_contact: parsed.has_about_or_contact === true,
    low_ad_density: parsed.low_ad_density === true,
    not_link_farm: parsed.not_link_farm === true,
  };
}

function agePoints(ageYears) {
  if (ageYears == null) return 10; // unknown — neutral, don't punish RDAP gaps
  if (ageYears >= 10) return 25;
  if (ageYears >= 5) return 20;
  if (ageYears >= 2) return 12;
  if (ageYears >= 1) return 6;
  return 0;
}

function mentionPoints(count) {
  if (count >= 10) return 20;
  if (count >= 5) return 15;
  if (count >= 3) return 10;
  if (count >= 1) return 5;
  return 0;
}

/**
 * @returns {{ score: number, signals: object }} score 0-100 + the component
 *   breakdown, persisted to domains.trust_signals for auditability.
 */
export function computeTrustScore({ domain, ageYears, https, structural, crossMentions }) {
  const components = {
    age: agePoints(ageYears),
    structural:
      (structural.has_byline ? 10 : 0) +
      (structural.has_about_or_contact ? 10 : 0) +
      (structural.low_ad_density ? 10 : 0) +
      (structural.not_link_farm ? 15 : 0),
    cross_mentions: mentionPoints(crossMentions),
    https: https ? 10 : 0,
  };
  let score = components.age + components.structural + components.cross_mentions + components.https;
  if (LINK_CONFIG.autoPassTlds.includes(tldOf(domain))) score = Math.max(score, 90);
  return {
    score: Math.min(100, score),
    signals: { ...components, age_years: ageYears, cross_mention_count: crossMentions, ...structural },
  };
}

// Domain cache (Supabase `domains` table) + auto-classifying competitor
// detection. One row per domain ever seen; cache hits are DB reads, so API
// spend scales with unique new domains, not post volume.
//
// Competitor rule (computed, no manual list):
//   is_competitor = (candidate.business_type == client.business_type)
//                   AND geo_overlap(candidate.market, client.market)
// Haiku extracts business_type/market and judges the two comparisons; the
// rule itself is applied in code. Cached per domain — never re-extracted.

import { LINK_CONFIG } from './config.js';
import { parseJsonResponse } from './models.js';

/** Registrable-ish domain of a URL: lowercase host without "www.". */
export function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function tldOf(domain) {
  return domain.split('.').pop();
}

export function riskTierFor(domain, allowlisted = false) {
  return allowlisted || LINK_CONFIG.autoPassTlds.includes(tldOf(domain)) ? 'trusted' : 'standard';
}

// ---------------------------------------------------------------- cache I/O

export async function getCachedDomain(supabase, domain) {
  const { data, error } = await supabase.from('domains').select('*').eq('domain', domain).maybeSingle();
  if (error) throw new Error(`domain cache read failed for ${domain}: ${error.message}`);
  return data; // null when not cached
}

// risk_tier is NOT computed here: partial upserts (liveness updates, mention
// stubs) must not clobber the tier of an allowlisted domain. Classification
// call sites set it explicitly via riskTierFor(); stubs get the column default.
export async function upsertDomain(supabase, record) {
  const { error } = await supabase.from('domains').upsert(record, { onConflict: 'domain' });
  if (error) throw new Error(`domain cache upsert failed for ${record.domain}: ${error.message}`);
}

/**
 * Tally cross-mentions for every domain surfaced by a search call — a free
 * trust signal we get just by counting domains we're already seeing.
 * Rows are stubbed (business_type null) for domains never fully classified.
 */
export async function bumpCrossMentions(supabase, domains) {
  const unique = [...new Set(domains.filter(Boolean))];
  for (const domain of unique) {
    const existing = await getCachedDomain(supabase, domain);
    if (existing) {
      const { error } = await supabase
        .from('domains')
        .update({ cross_mention_count: (existing.cross_mention_count ?? 0) + 1 })
        .eq('domain', domain);
      if (error) throw new Error(`cross-mention update failed for ${domain}: ${error.message}`);
    } else {
      await upsertDomain(supabase, { domain, cross_mention_count: 1 });
    }
  }
}

// ------------------------------------------------------- per-URL freshness
// Freshness is a per-PAGE fact (migration 0007): verdicts are keyed on the
// full URL, permanent once set, with domain kept as a non-unique reference.

/** Cache key for a URL: as-is minus the fragment (never affects content). */
export function urlCacheKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

export async function getUrlFreshness(supabase, url) {
  const { data, error } = await supabase
    .from('url_freshness')
    .select('*')
    .eq('url', urlCacheKey(url))
    .maybeSingle();
  if (error) throw new Error(`url_freshness read failed for ${url}: ${error.message}`);
  return data; // null when this URL has never been evaluated
}

/** Upsert (not insert): the same URL can surface for two claims in one run. */
export async function saveUrlFreshness(supabase, { url, domain, freshness_verdict, publish_date, reason }) {
  const { error } = await supabase
    .from('url_freshness')
    .upsert(
      { url: urlCacheKey(url), domain, freshness_verdict, publish_date, reason },
      { onConflict: 'url' },
    );
  if (error) throw new Error(`url_freshness upsert failed for ${url}: ${error.message}`);
}

// ------------------------------------------------------------ client profile

const PROFILE_KEYS = { businessType: 'link_client_business_type', market: 'link_client_market' };

/** Client profile set once by scripts/onboard-link-client.js. */
export async function getClientProfile(supabase) {
  const { data, error } = await supabase
    .from('system_config')
    .select('key, value')
    .in('key', Object.values(PROFILE_KEYS));
  if (error) throw new Error(`client profile read failed: ${error.message}`);
  const map = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  const profile = {
    businessType: map[PROFILE_KEYS.businessType],
    market: map[PROFILE_KEYS.market],
  };
  if (!profile.businessType || !profile.market) {
    throw new Error('client profile missing — run: node scripts/onboard-link-client.js');
  }
  return profile;
}

export async function saveClientProfile(supabase, { businessType, market }) {
  const rows = [
    { key: PROFILE_KEYS.businessType, value: businessType },
    { key: PROFILE_KEYS.market, value: market },
  ];
  const { error } = await supabase.from('system_config').upsert(rows, { onConflict: 'key' });
  if (error) throw new Error(`client profile save failed: ${error.message}`);
}

// ------------------------------------------------------------ classification

function buildClassifyPrompt({ domain, text, clientProfile }) {
  return `Classify the business behind a website. Return ONLY a JSON object — no preamble, no code fence, no explanation before or after it.

Website domain: ${domain}
Website text (truncated):
${text.slice(0, 6000)}

The classification is compared against this client:
- client business_type: ${clientProfile.businessType}
- client market: ${clientProfile.market}

{
  "business_type": "short label, e.g. 'real estate agent', 'law firm', 'government agency', 'news publisher', 'bank'",
  "market": "the geographic market/region this business serves, or 'national' / 'global' if not local",
  "business_type_matches_client": true|false,
  "geo_overlaps_client": true|false
}

"business_type_matches_client" is true only if this business competes in the same line of business as the client (another provider of the same services — not an adjacent service, a supplier, or a news site).
"geo_overlaps_client" is true if the two markets overlap geographically (a national business overlaps every market).`;
}

/**
 * Extract business_type + market for a new domain and apply the competitor
 * rule. Runs once per domain; the result is cached by the caller.
 */
export async function classifyDomain(haiku, { domain, text, clientProfile }) {
  const response = await haiku({
    label: `link-classify:${domain}`,
    prompt: buildClassifyPrompt({ domain, text, clientProfile }),
    maxTokens: 512,
  });
  const parsed = parseJsonResponse(response, `classification of ${domain}`);
  return {
    business_type: parsed.business_type ?? 'unknown',
    market: parsed.market ?? 'unknown',
    is_competitor: parsed.business_type_matches_client === true && parsed.geo_overlaps_client === true,
  };
}

// ---------------------------------------------------------------- link log

export async function logInjectedLink(supabase, entry) {
  const { error } = await supabase.from('injected_links').insert(entry);
  if (error) throw new Error(`injected_links insert failed for ${entry.url}: ${error.message}`);
}

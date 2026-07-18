// Step 2: candidate sourcing via SerpApi (Google engine). This is the
// structural anti-hallucination guarantee: no model ever writes a URL from
// memory — only URLs returned by this search call (and then actually
// fetched) are eligible for injection.
//
// Requires SERPAPI_API_KEY — a NEW key scoped to this service only, never a
// key reused from another project (server-side only, per the standing
// security rule). The adapter is deliberately thin so the provider can be
// swapped without touching the engine.

import { LINK_CONFIG } from './config.js';
import { domainOf } from './domains.js';

/**
 * @param {string} query
 * @returns {Promise<Array<{url: string, title: string, description: string}>>}
 */
export async function searchCandidates(query, { count = LINK_CONFIG.maxCandidatesPerClaim } = {}) {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) throw new Error('SERPAPI_API_KEY is not set');

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(count * 2)); // headroom for filtering
  url.searchParams.set('api_key', key);

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`SerpApi search failed for "${query}": ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  // SerpApi reports request-level problems as an "error" field on a 200.
  if (data.error) throw new Error(`SerpApi error for "${query}": ${data.error}`);
  const results = data.organic_results ?? [];

  return results
    .map((r) => ({ url: r.link, title: r.title ?? '', description: r.snippet ?? '' }))
    .filter((r) => {
      const d = r.url ? domainOf(r.url) : null;
      return d && !LINK_CONFIG.excludedDomains.includes(d);
    })
    .slice(0, count);
}

// Step 2: candidate sourcing via SerpApi (Google engine). This is the
// structural anti-hallucination guarantee: no model ever writes a URL from
// memory — only URLs returned by this search call (and then actually
// fetched) are eligible for injection.
//
// Requires SERPAPI_API_KEY — a NEW key scoped to this service only, never a
// key reused from another project (server-side only, per the standing
// security rule). The adapter is deliberately thin so the provider can be
// swapped without touching the engine.
//
// Quota: the free plan is 250 searches a month. An exhausted quota is its own
// error type so callers can stop spending, tell the editor, and retry after
// renewal instead of treating it as "this post has nothing to cite".

import { LINK_CONFIG } from './config.js';
import { domainOf } from './domains.js';

/** The SerpApi account has no searches left (as opposed to a transient failure). */
export class SearchQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SearchQuotaError';
  }
}

// SerpApi's out-of-quota message: "Your account has run out of searches."
const QUOTA_RE = /run out of searches|out of searches|searches? (limit|quota)|exceeded .*searches/i;

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
    const body = await res.text();
    if (QUOTA_RE.test(body)) throw new SearchQuotaError(`SerpApi quota exhausted (${res.status}): ${body.slice(0, 200)}`);
    throw new Error(`SerpApi search failed for "${query}": ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // SerpApi reports request-level problems as an "error" field on a 200.
  if (data.error) {
    if (QUOTA_RE.test(data.error)) throw new SearchQuotaError(`SerpApi quota exhausted: ${data.error}`);
    throw new Error(`SerpApi error for "${query}": ${data.error}`);
  }
  const results = data.organic_results ?? [];

  return results
    .map((r) => ({ url: r.link, title: r.title ?? '', description: r.snippet ?? '' }))
    .filter((r) => {
      const d = r.url ? domainOf(r.url) : null;
      return d && !LINK_CONFIG.excludedDomains.includes(d);
    })
    .slice(0, count);
}

/**
 * Remaining searches on the account. The account endpoint is free (it does
 * not count against the quota), so the sweep calls it before doing any
 * search-dependent work.
 * @returns {Promise<{left: number|null, limit: number|null, renewal: string|null, status: string|null, plan: string|null}>}
 */
export async function getSearchQuota() {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) throw new Error('SERPAPI_API_KEY is not set');
  const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`SerpApi account check failed: ${res.status}`);
  const d = await res.json();
  if (d.error) throw new Error(`SerpApi account check error: ${d.error}`);
  return {
    left: d.total_searches_left ?? d.plan_searches_left ?? null,
    limit: d.searches_per_month ?? null,
    renewal: d.plan_renewal_date ?? null,
    status: d.account_status ?? null,
    plan: d.plan_name ?? null,
  };
}

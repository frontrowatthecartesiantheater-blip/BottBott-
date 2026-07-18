// One-time client onboarding for the link injection pipeline: crawl the
// client's own site, extract business_type + market via Haiku, and store
// them in system_config (link_client_business_type / link_client_market).
// The competitor check compares every candidate domain against this profile.
//
// Usage:
//   node scripts/onboard-link-client.js [--url https://example.com] [--url ...]
//   (no --url: defaults to the client-config site's homepage and /about)
//
// Requires ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { getSupabaseClient } from '../lib/supabase.js';
import { SITE_ORIGIN } from '../lib/client-config.js';
import { createLinkClients, parseJsonResponse } from '../lib/links/models.js';
import { fetchPage } from '../lib/links/liveness.js';
import { saveClientProfile } from '../lib/links/domains.js';

try { process.loadEnvFile(); } catch { /* rely on environment */ }

const args = process.argv.slice(2);
const urls = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--url' && args[i + 1]) urls.push(args[i + 1]);
}
if (urls.length === 0) {
  urls.push(`${SITE_ORIGIN}/`, `${SITE_ORIGIN}/about`);
}

const pages = [];
for (const url of urls) {
  const page = await fetchPage(url);
  if (page.live) {
    pages.push(`--- ${url} ---\n${page.text.slice(0, 5000)}`);
    console.log(`fetched ${url}`);
  } else {
    console.warn(`skipping ${url}: ${page.reason}`);
  }
}
if (pages.length === 0) {
  console.error('no client pages could be fetched — aborting');
  process.exit(1);
}

const { haiku } = createLinkClients();
const response = await haiku({
  label: 'client-onboarding',
  prompt: `Extract the business profile from this business's own website text. Return ONLY a JSON object — no preamble, no code fence, no explanation before or after it:

{
  "business_type": "short label, e.g. 'real estate agent', 'law firm', 'financial advisor'",
  "market": "the geographic market served, as specific as the site supports, e.g. 'Sometown County, CA (Sometown, Othertown, Nearville)'"
}

Website text:
${pages.join('\n\n')}`,
  maxTokens: 512,
});

const profile = parseJsonResponse(response, 'client onboarding');
if (!profile.business_type || !profile.market) {
  console.error('extraction did not return business_type + market:', profile);
  process.exit(1);
}

const supabase = getSupabaseClient();
await saveClientProfile(supabase, { businessType: profile.business_type, market: profile.market });

console.log('\nclient profile saved to system_config:');
console.log(`  link_client_business_type = ${profile.business_type}`);
console.log(`  link_client_market        = ${profile.market}`);

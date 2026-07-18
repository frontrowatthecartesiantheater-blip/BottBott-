// Step 3: liveness. Fetch a candidate URL and confirm it's a real, living
// page — 200 status, HTML, and actual content rather than a parked/dead
// placeholder. The fetched text is reused downstream by the relevancy,
// trust, and freshness steps so each candidate is fetched exactly once.

import { LINK_CONFIG } from './config.js';

const PARKED_MARKERS = [
  'domain is for sale', 'buy this domain', 'domain parking', 'parked free',
  'this domain has expired', 'renew now', 'godaddy.com/domainsearch',
  'sedo.com', 'hugedomains',
];

/** Crude but sufficient HTML→text for scoring; not a renderer. */
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} url
 * @returns {Promise<{live: boolean, status: number|null, html: string, text: string, reason: string|null}>}
 */
export async function fetchPage(url) {
  const dead = (reason, status = null) => ({ live: false, status, html: '', text: '', reason });

  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(LINK_CONFIG.fetchTimeoutMs),
      // Browser-realistic headers: reference sites (Justia, FindLaw, many
      // .gov WAFs) 403 anything that self-identifies as a bot, and we're
      // only reading public pages to verify them as citation sources.
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'upgrade-insecure-requests': '1',
      },
    });
  } catch (err) {
    return dead(`fetch failed: ${err.message}`);
  }

  if (res.status !== 200) return dead(`status ${res.status}`, res.status);
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('html')) return dead(`not HTML (${contentType})`, res.status);

  let html;
  try {
    html = await res.text();
  } catch (err) {
    return dead(`body read failed: ${err.message}`, res.status);
  }
  if (html.length > LINK_CONFIG.maxFetchBytes) html = html.slice(0, LINK_CONFIG.maxFetchBytes);

  const text = htmlToText(html);
  if (text.length < 300) return dead('too little content (likely dead/placeholder page)', 200);

  const lower = text.toLowerCase().slice(0, 5000);
  const marker = PARKED_MARKERS.find((m) => lower.includes(m));
  if (marker) return dead(`parked-page marker: "${marker}"`, 200);

  return { live: true, status: 200, html, text, reason: null };
}

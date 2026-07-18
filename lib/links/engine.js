// External link injection orchestrator. Per draft, two phases:
//
//   Phase 1 (evaluate): claims → per claim, try the surplus pool (vetted
//   candidates from prior runs in the same topic category), else web search
//   → per candidate: cache gates → liveness → classify/trust (new domains)
//   → per-URL freshness → relevancy. Best passing candidate per claim.
//
//   Phase 2 (select): rank auto-insertable candidates by combined
//   relevancy+trust score, inject up to the word-count-scaled cap
//   (1 per ~400 words, min 1, no ceiling), log the cut remainder as
//   'surplus' for future reuse. Borderline scores are 'flagged' for manual
//   review, never auto-inserted.
//
// Clients and the Supabase handle are injected so the engine can run from a
// script, a cron endpoint, or a test harness unchanged. Nothing in here ever
// writes a URL a search call didn't return.

import { LINK_CONFIG } from './config.js';
import { extractClaims } from './claims.js';
import { searchCandidates } from './search.js';
import { fetchPage } from './liveness.js';
import {
  domainOf, riskTierFor, getCachedDomain, upsertDomain, bumpCrossMentions,
  getUrlFreshness, saveUrlFreshness,
  getClientProfile, classifyDomain, logInjectedLink,
} from './domains.js';
import { findSurplusCandidates, markSurplusConsumed } from './surplus.js';
import { getDomainAgeYears, structuralSignals, computeTrustScore } from './trust.js';
import { extractPublishDate, freshnessVerdict } from './freshness.js';
import { scoreRelevancy } from './relevancy.js';
import { injectLink } from './inject.js';

/**
 * Evaluate one candidate URL against a claim. Returns null (with a reason
 * pushed to `skipped`) when any gate fails, otherwise the scored candidate.
 */
async function evaluateCandidate({ candidate, claim, clientProfile, supabase, clients, skipped, now }) {
  const domain = domainOf(candidate.url);
  const skip = (reason) => {
    skipped.push({ url: candidate.url, claim: claim.claim, reason });
    return null;
  };
  if (!domain) return skip('unparseable URL');

  let cached = await getCachedDomain(supabase, domain);

  // Gate order: domain-level rejections (competitor, trust floor) run first
  // as cheap DB reads, so a known-bad domain never triggers per-URL work.
  if (cached?.is_competitor === true) return skip('cached: competitor');
  if (cached?.trust_score != null && cached.trust_score < LINK_CONFIG.trust.flag) {
    return skip(`cached: trust ${cached.trust_score} below floor`);
  }

  // Per-URL freshness cache (permanent verdict): a known-stale URL is
  // rejected before we even fetch it.
  const urlVerdict = await getUrlFreshness(supabase, candidate.url);
  if (urlVerdict?.freshness_verdict === false) {
    return skip(`cached: URL failed freshness (permanent) — ${urlVerdict.reason}`);
  }

  // Liveness — fetched once; the HTML/text feeds every later step.
  const page = await fetchPage(candidate.url);
  if (cached) {
    await upsertDomain(supabase, { domain, is_live: page.live, last_liveness_check: now });
  }
  if (!page.live) return skip(`not live: ${page.reason}`);

  const allowlisted = cached?.allowlisted ?? false;

  // Full classification only for domains the cache hasn't seen classified.
  // Same gate order as the cached path: competitor, then trust, and only for
  // survivors the per-URL freshness step below — a new competitor domain
  // must not cost a publish-date extraction.
  if (!cached || cached.business_type == null) {
    const classification = await classifyDomain(clients.haiku, {
      domain, text: page.text, clientProfile,
    });
    if (classification.is_competitor) {
      await upsertDomain(supabase, {
        domain,
        business_type: classification.business_type,
        market: classification.market,
        is_competitor: true,
        allowlisted,
        risk_tier: riskTierFor(domain, allowlisted),
        is_live: true,
        last_liveness_check: now,
      });
      return skip('competitor (newly classified)');
    }

    const [ageYears, structural] = await Promise.all([
      getDomainAgeYears(domain),
      structuralSignals(clients.haiku, { domain, html: page.html }),
    ]);
    const trust = computeTrustScore({
      domain, ageYears,
      https: candidate.url.startsWith('https://'),
      structural,
      crossMentions: cached?.cross_mention_count ?? 0,
    });

    cached = {
      domain,
      business_type: classification.business_type,
      market: classification.market,
      is_competitor: false,
      trust_score: trust.score,
      trust_signals: trust.signals,
      allowlisted,
      risk_tier: riskTierFor(domain, allowlisted),
      is_live: true,
      last_liveness_check: now,
      last_trust_check: now,
    };
    await upsertDomain(supabase, cached);

    if (trust.score < LINK_CONFIG.trust.flag) return skip(`trust ${trust.score} below floor`);
  }

  // Per-URL freshness (permanent once set). Only runs for URLs the cache has
  // never seen, and only after every domain-level gate has passed.
  if (!urlVerdict) {
    const publishDate = await extractPublishDate(clients.haiku, { domain, html: page.html });
    const freshness = freshnessVerdict({ domain, publishDate, allowlisted });
    await saveUrlFreshness(supabase, {
      url: candidate.url,
      domain,
      freshness_verdict: freshness.pass,
      publish_date: publishDate,
      reason: freshness.reason,
    });
    if (!freshness.pass) return skip(`freshness: ${freshness.reason}`);
  }

  // Relevancy — the Sonnet judgment step, always per claim+page. A model
  // failure (truncation, malformed response) costs this one candidate, not
  // the run.
  let relevancy;
  try {
    relevancy = await scoreRelevancy(clients.sonnet, {
      claim: claim.claim,
      sentence: claim.sentence,
      url: candidate.url,
      title: candidate.title,
      pageText: page.text,
    });
  } catch (err) {
    const reason = err.message.includes('max_tokens')
      ? 'response truncated (max_tokens)'
      : err.message;
    return skip(`relevancy scoring failed: ${reason}`);
  }
  if (!relevancy.supports || relevancy.score < LINK_CONFIG.relevancy.flag) {
    return skip(`relevancy ${relevancy.score}: ${relevancy.reasoning}`);
  }
  if (!relevancy.anchor_text) return skip('no usable anchor text');

  return { candidate, domain, cached, relevancy };
}

/**
 * Try the surplus pool for a claim before paying for a web search. Reuse
 * demands auto-insert-level scores (the row is only worth reusing if it can
 * actually be injected): fresh relevancy >= inject, current domain trust >=
 * inject. Dead URLs are consumed on the spot; relevancy misses for THIS
 * claim leave the row available to other posts. A row chosen here is removed
 * from the in-memory pool so a second claim can't pick it in the same run;
 * the DB row is only consumed if the candidate actually gets injected in
 * phase 2.
 */
async function trySurplusForClaim({ claim, surplusPool, supabase, clients, skipped, log }) {
  let tries = 0;
  let best = null;
  for (const row of [...surplusPool]) {
    if (tries >= LINK_CONFIG.maxSurplusTriesPerClaim) break;

    // Domain facts may have drifted since discovery — re-check the cheap gates.
    const cached = await getCachedDomain(supabase, row.domain);
    if (!cached || cached.is_competitor === true) continue;
    if (cached.trust_score == null || cached.trust_score < LINK_CONFIG.trust.inject) continue;

    tries += 1;
    const page = await fetchPage(row.url);
    if (!page.live) {
      if (log) await markSurplusConsumed(supabase, row.id, { reason: `dead URL: ${page.reason}` });
      surplusPool.splice(surplusPool.indexOf(row), 1);
      skipped.push({ url: row.url, claim: claim.claim, reason: `surplus candidate dead: ${page.reason}` });
      continue;
    }

    let relevancy;
    try {
      relevancy = await scoreRelevancy(clients.sonnet, {
        claim: claim.claim,
        sentence: claim.sentence,
        url: row.url,
        title: '',
        pageText: page.text,
      });
    } catch (err) {
      const reason = err.message.includes('max_tokens')
        ? 'response truncated (max_tokens)'
        : err.message;
      // Model hiccup, not a fact about the row — stays unconsumed.
      skipped.push({ url: row.url, claim: claim.claim, reason: `relevancy scoring failed: ${reason}` });
      continue;
    }
    if (!relevancy.supports || relevancy.score < LINK_CONFIG.relevancy.inject || !relevancy.anchor_text) {
      // Not right for THIS claim — stays unconsumed for future posts.
      continue;
    }

    const candidate = {
      candidate: { url: row.url, title: '' },
      domain: row.domain,
      cached,
      relevancy,
      surplusRowId: row.id,
    };
    if (!best || relevancy.score > best.relevancy.score) best = candidate;
  }
  if (best) surplusPool.splice(surplusPool.findIndex((r) => r.id === best.surplusRowId), 1);
  return best;
}

function combinedScore(cand) {
  const { relevancyWeight, trustWeight } = LINK_CONFIG.ranking;
  return cand.relevancy.score * relevancyWeight + cand.cached.trust_score * trustWeight;
}

/**
 * Run the full pipeline on one draft.
 *
 * @param {object} opts
 * @param {string} opts.bodyMd - draft markdown
 * @param {object} opts.supabase - service-role client (lib/supabase.js)
 * @param {{haiku: Function, sonnet: Function}} opts.clients - lib/links/models.js
 * @param {string|null} [opts.postId] - posts.id for the injected_links log
 * @param {string|null} [opts.draftRef] - slug/filename when postId is null
 * @param {string|null} [opts.topicId] - topics.id (provenance for surplus rows)
 * @param {string|null} [opts.topicCategory] - topics.category; enables surplus reuse
 * @param {boolean} [opts.log=true] - write injected_links rows
 * @returns {Promise<{bodyMd: string, cap: number, wordCount: number,
 *   injected: Array, flagged: Array, surplus: Array, skipped: Array}>}
 */
export async function injectExternalLinks({
  bodyMd, supabase, clients,
  postId = null, draftRef = null, topicId = null, topicCategory = null,
  log = true,
}) {
  const clientProfile = await getClientProfile(supabase);
  const now = new Date().toISOString();

  const wordCount = bodyMd.split(/\s+/).filter(Boolean).length;
  const cap = Math.max(1, Math.floor(wordCount / LINK_CONFIG.wordsPerLink));

  const claims = await extractClaims(bodyMd, clients.sonnet);
  const skipped = [];
  const passing = []; // best candidate per claim, all gates passed

  // Vetted-but-uninjected candidates from prior runs in this category.
  const surplusPool = topicCategory ? await findSurplusCandidates(supabase, topicCategory) : [];

  // ---- Phase 1: evaluate every claim.
  for (const claim of claims) {
    const fromSurplus = await trySurplusForClaim({ claim, surplusPool, supabase, clients, skipped, log });
    if (fromSurplus) {
      passing.push({ ...fromSurplus, claim });
      continue;
    }

    let candidates;
    try {
      candidates = await searchCandidates(claim.search_query);
    } catch (err) {
      skipped.push({ claim: claim.claim, reason: `search failed: ${err.message}` });
      continue;
    }
    await bumpCrossMentions(supabase, candidates.map((c) => domainOf(c.url)));

    let best = null;
    for (const candidate of candidates) {
      const domain = domainOf(candidate.url);
      if (!domain) continue;
      const result = await evaluateCandidate({
        candidate, claim, clientProfile, supabase, clients, skipped, now,
      });
      if (result && (!best || result.relevancy.score > best.relevancy.score)) best = result;
    }
    if (best) passing.push({ ...best, claim });
  }

  // ---- Phase 2: rank, cap, inject; cut candidates become surplus.
  const entryFor = (cand, status) => ({
    post_id: postId,
    draft_ref: draftRef,
    topic_id: topicId,
    url: cand.candidate.url,
    domain: cand.domain,
    anchor_text: cand.relevancy.anchor_text,
    claim: cand.claim.claim,
    relevancy_score: cand.relevancy.score,
    trust_score: cand.cached.trust_score,
    relevancy_reasoning: cand.relevancy.reasoning ?? null,
    status,
  });

  const autoInsertable = [];
  const flagged = [];
  for (const cand of passing) {
    const autoInsert =
      cand.relevancy.score >= LINK_CONFIG.relevancy.inject &&
      cand.cached.trust_score >= LINK_CONFIG.trust.inject;
    if (autoInsert) autoInsertable.push(cand);
    // Borderline (relevancy 60-74 or trust 45-59): manual review, never
    // auto-inserted and never counted against the cap.
    else flagged.push(entryFor(cand, 'flagged'));
  }
  autoInsertable.sort((a, b) => combinedScore(b) - combinedScore(a));

  const injected = [];
  const surplus = [];
  const usedDomains = new Set();
  let workingMd = bodyMd;

  for (const cand of autoInsertable) {
    if (injected.length >= cap || usedDomains.has(cand.domain)) {
      // Cut by the cap (or a higher-ranked candidate already used this
      // domain). Reused-surplus candidates already have their DB row —
      // leave it unconsumed rather than logging a duplicate.
      if (!cand.surplusRowId) surplus.push(entryFor(cand, 'surplus'));
      continue;
    }

    const splice = injectLink(workingMd, {
      sentence: cand.claim.sentence,
      anchorText: cand.relevancy.anchor_text,
      url: cand.candidate.url,
    });
    if (!splice.ok) {
      skipped.push({ url: cand.candidate.url, claim: cand.claim.claim, reason: `injection failed: ${splice.reason}` });
      continue;
    }
    workingMd = splice.bodyMd;
    usedDomains.add(cand.domain);
    injected.push(entryFor(cand, 'injected'));
    if (log && cand.surplusRowId) {
      await markSurplusConsumed(supabase, cand.surplusRowId, {
        consumedByPostId: postId,
        reason: 'reused for new post',
      });
    }
  }

  if (log) {
    for (const entry of [...injected, ...flagged, ...surplus]) {
      await logInjectedLink(supabase, entry);
    }
  }

  return { bodyMd: workingMd, cap, wordCount, injected, flagged, surplus, skipped };
}

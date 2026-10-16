// Tunable thresholds for the external link injection pipeline. Everything
// score-related is 0-100. Borderline scores (between flag and inject) are
// surfaced for manual review instead of auto-inserted.

import { CLIENT } from '../client-config.js';

export const LINK_CONFIG = {
  // Per-draft caps
  maxClaimsPerDraft: 5,
  maxCandidatesPerClaim: 5,
  // Injection cap scales with length: 1 link per ~400 words, minimum 1, no
  // fixed ceiling. cap = max(1, floor(wordCount / wordsPerLink)).
  wordsPerLink: 400,

  // Score gates. >= inject → auto-insert; >= flag → manual review; below → drop.
  relevancy: { inject: 75, flag: 60 },
  trust: { inject: 60, flag: 45 },

  // Curated (allowlisted) domains are trusted by definition: their computed
  // trust score is floored at the auto-insert threshold so a thin-looking but
  // authoritative source (a docs or support subdomain) is not downgraded to
  // "flagged" by the structural heuristics.
  allowlistTrustFloor: 60,

  // Sweep retry/hold behavior (lib/links/sweep.js). A post whose searches all
  // failed, or that was swept while the SerpApi quota was exhausted, is
  // stamped (so the editor can still publish) but marked retryable, and is
  // re-swept until it leaves pending_review or the retry window closes.
  maxSearchAttempts: 3,      // non-quota search failures retried this many times
  retryWindowHours: 96,      // retry a retryable post for this long after it was generated
  maxHoldHours: 36,          // auto-publish waits this long for a retryable post before publishing without links
  quotaWarnBelow: 15,        // email a heads-up when fewer searches than this remain

  // Ranking of gate-passing candidates when the cap cuts the list. Trust
  // already did its job as a gate, so relevancy dominates the ranking.
  ranking: { relevancyWeight: 0.7, trustWeight: 0.3 },

  // Surplus reuse: max vetted-pool candidates fetched+scored per claim
  // before falling back to a fresh web search.
  maxSurplusTriesPerClaim: 3,

  // Freshness: reject pages older than this (or with no detectable publish
  // date) unless the domain is .gov/.edu or on the per-client allowlist.
  // 4 years (business decision 2026-07-03; was 730).
  freshnessMaxAgeDays: 1460,
  autoPassTlds: ['gov', 'edu'],

  // Candidate fetching
  fetchTimeoutMs: 10_000,
  maxFetchBytes: 1_500_000,

  // Never link to the client's own properties (internal links are handled
  // by the generation pipeline's Pool A/B, not this module). Read from
  // client-config so no per-client edit is needed here.
  excludedDomains: [CLIENT.siteDomain, CLIENT.personalSiteDomain].filter(Boolean),

  // Recheck scheduler (liveness + trust drift only; freshness is permanent).
  // Prioritized by time since last check; batched so the full cache is never
  // rechecked in one run.
  recheck: {
    batchSize: 25,
    intervalDays: { trusted: 90, standard: 14 },
  },
};

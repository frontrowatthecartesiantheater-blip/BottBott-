// Recheck scheduler for the domain cache: liveness + trust drift ONLY.
// Freshness is a permanent verdict and is never rechecked here.
//
// Scheduling logic: prioritize by time since last check, not content age.
// Risk-tiered intervals — 'trusted' (.gov/.edu/allowlisted) domains recheck
// every LINK_CONFIG.recheck.intervalDays.trusted days, 'standard' domains
// every .standard days. Batched (batchSize domains per run) so the full
// cache is never swept in one go; run daily via cron/Task Scheduler.
//
// Usage:
//   node scripts/recheck-domains.js [--batch 25] [--dry]
//
// Requires ANTHROPIC_API_KEY (structural trust signals), SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.

import { getSupabaseClient } from '../lib/supabase.js';
import { createLinkClients } from '../lib/links/models.js';
import { LINK_CONFIG } from '../lib/links/config.js';
import { fetchPage } from '../lib/links/liveness.js';
import { getDomainAgeYears, structuralSignals, computeTrustScore } from '../lib/links/trust.js';

try { process.loadEnvFile(); } catch { /* rely on environment */ }

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}
const batchSize = Number(argValue('--batch')) || LINK_CONFIG.recheck.batchSize;
const dry = args.includes('--dry');

const supabase = getSupabaseClient();
const { haiku } = createLinkClients();
const now = Date.now();

// Due = never checked, or last check older than the tier's interval. Oldest
// first so the queue rotates instead of hammering the same rows.
async function dueDomains(tier, limit) {
  const cutoff = new Date(now - LINK_CONFIG.recheck.intervalDays[tier] * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('domains')
    .select('domain, risk_tier, allowlisted, cross_mention_count, last_liveness_check')
    .eq('risk_tier', tier)
    .not('business_type', 'is', null) // stubs (mention tallies only) aren't linked to; skip
    .or(`last_liveness_check.is.null,last_liveness_check.lt.${cutoff}`)
    .order('last_liveness_check', { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(`due-domain query failed (${tier}): ${error.message}`);
  return data ?? [];
}

// Standard-tier domains get priority; trusted fills whatever batch remains.
const standard = await dueDomains('standard', batchSize);
const trusted = await dueDomains('trusted', Math.max(0, batchSize - standard.length));
const queue = [...standard, ...trusted];

console.log(`${queue.length} domain(s) due for recheck (batch ${batchSize}${dry ? ', dry run' : ''})`);

for (const row of queue) {
  const checkedAt = new Date().toISOString();
  const page = await fetchPage(`https://${row.domain}/`);
  const update = { is_live: page.live, last_liveness_check: checkedAt };

  if (page.live) {
    // Trust drift: recompute the composite from fresh signals. Reputation /
    // ownership can change independent of any page's age.
    const [ageYears, structural] = await Promise.all([
      getDomainAgeYears(row.domain),
      structuralSignals(haiku, { domain: row.domain, html: page.html }),
    ]);
    const trust = computeTrustScore({
      domain: row.domain,
      ageYears,
      https: true,
      structural,
      crossMentions: row.cross_mention_count ?? 0,
    });
    update.trust_score = trust.score;
    update.trust_signals = trust.signals;
    update.last_trust_check = checkedAt;
    console.log(`  ${row.domain}: live, trust=${trust.score}`);
  } else {
    console.log(`  ${row.domain}: DEAD (${page.reason})`);
  }

  if (!dry) {
    const { error } = await supabase.from('domains').update(update).eq('domain', row.domain);
    if (error) console.error(`  update failed for ${row.domain}: ${error.message}`);
  }
}

console.log('recheck complete');

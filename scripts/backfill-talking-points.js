// Extract talking points from published posts and store them (lib/talking-points.js).
//
// Usage:
//   node scripts/backfill-talking-points.js --dry-run            print what would be stored, write nothing
//   node scripts/backfill-talking-points.js                      extract + store for posts not yet done
//   node scripts/backfill-talking-points.js --slug a,b           (re)do specific posts
//   node scripts/backfill-talking-points.js --limit 20           how many posts per run (default 20)
//
// Needs ANTHROPIC_API_KEY and OPENAI_API_KEY (embeddings), and migration 0002
// applied for anything but --dry-run. The link-sweep workflow runs the same
// extraction automatically for newly published posts.

try { process.loadEnvFile(); } catch { /* rely on environment */ }

import { getSupabaseClient } from '../lib/supabase.js';
import { backfillTalkingPoints } from '../lib/talking-points.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };

const dryRun = flag('--dry-run');
const limit = Number(value('--limit') ?? 20);
let slugs = value('--slug') ? value('--slug').split(',').map((s) => s.trim()).filter(Boolean) : null;

const supabase = getSupabaseClient();

// A dry run must not depend on the new column, so select posts by slug.
if (dryRun && !slugs) {
  const { data, error } = await supabase.from('posts').select('slug').eq('status', 'published').order('published_at', { ascending: true });
  if (error) throw new Error(error.message);
  slugs = data.map((p) => p.slug);
}

const result = await backfillTalkingPoints({ supabase, limit, dryRun, slugs });
if (result.skipped) { console.log(`skipped: ${result.skipped}`); process.exit(0); }

for (const p of result.processed) {
  console.log(`\n=== ${p.slug}: ${p.points} point(s)`);
  for (const pt of p.preview ?? []) {
    console.log(`  [${pt.kind}] ${pt.point}${pt.client_ref ? `  (client: ${pt.client_ref})` : ''}${pt.evidence_url ? `\n      evidence: ${pt.evidence_url}` : ''}`);
  }
}
for (const e of result.errors) console.error(`\nERROR ${e.slug}: ${e.error}`);
console.log(`\n${dryRun ? 'dry run: nothing written. ' : ''}${result.processed.length} post(s) processed, ${result.errors.length} error(s)`);
if (result.errors.length) process.exit(1);

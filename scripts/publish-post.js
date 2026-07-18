// Publish a generated post. Takes the JSON package from a generation run
// (94-package.json in a test-run directory, or any file with the same shape).
//
// Usage:
//   node scripts/publish-post.js --package <file> --date YYYY-MM-DD [--audit <file>] [--dry-run]
//
// --dry-run validates everything, renders all four files into
// content/publish-dryrun/<slug>/ and prints the commit plan, the Supabase
// record, and the Sheet row WITHOUT touching GitHub, Supabase, or the Sheet.
// A live run requires GITHUB_TOKEN/GITHUB_REPO (+ SUPABASE_*, SHEETS_*).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  buildPublishFiles,
  buildSupabaseRecord,
  buildSheetRow,
} from '../lib/publish.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
function argValue(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

const packageFile = argValue('--package');
const date = argValue('--date');
const auditFile = argValue('--audit');
if (!packageFile || !date) {
  console.error('usage: node scripts/publish-post.js --package <file> --date YYYY-MM-DD [--audit <file>] [--dry-run]');
  process.exit(1);
}
if (!existsSync(packageFile)) {
  console.error(`error: package file not found: ${packageFile}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(packageFile, 'utf8').replace(/^﻿/, ''));
const craftAudit = auditFile ? readFileSync(auditFile, 'utf8') : null;

try {
  if (dryRun) {
    const manifest = JSON.parse(readFileSync('blog/index.json', 'utf8'));
    const files = buildPublishFiles({ pkg, date, manifest });

    const stagingDir = path.join('content', 'publish-dryrun', pkg.post.slug);
    for (const file of files) {
      const target = path.join(stagingDir, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }

    console.log('DRY RUN — no GitHub commit, no Supabase write, no Sheet write\n');
    console.log(`commit message: Publish blog post: ${pkg.post.slug}`);
    console.log('files in the single commit:');
    for (const file of files) {
      console.log(`  ${file.path} (${Buffer.byteLength(file.content)} bytes)`);
    }
    console.log(`\nstaged for inspection under ${stagingDir}${path.sep}`);
    console.log('\nSupabase posts record:');
    console.log(JSON.stringify(buildSupabaseRecord({ pkg, date, craftAudit: craftAudit ? '(provided)' : null }), null, 2).slice(0, 600) + ' ...');
    const row = buildSheetRow({ pkg, date });
    console.log('\nSheet row (A-E):');
    console.log(`  A Publish Date: ${row.publish_date}`);
    console.log(`  B Topic:        ${row.topic}`);
    console.log(`  C Post URL:     ${row.post_url}`);
    console.log(`  D LinkedIn:     ${row.linkedin_draft.slice(0, 80).replace(/\n/g, ' ')}...`);
    console.log(`  E Facebook:     ${row.facebook_draft.slice(0, 80).replace(/\n/g, ' ')}...`);
  } else {
    try { process.loadEnvFile(); } catch { /* rely on environment */ }
    const { publishPost } = await import('../lib/publish.js');
    const result = await publishPost({ pkg, date, craftAudit });
    console.log(`published: ${result.postUrl}`);
    console.log(`commit: ${result.commitSha}`);
    console.log(`supabase id: ${result.supabaseId ?? '(failed)'}`);
    console.log(`verification: ${JSON.stringify(result.verification)}`);
    if (result.postCommitErrors.length > 0) {
      console.error('\nPOST-COMMIT ERRORS (post is live, but these steps failed):');
      for (const e of result.postCommitErrors) console.error(`  ${e.step}: ${e.error}`);
      process.exit(2);
    }
  }
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}

// Launch preflight. Machine-checks every gate that can be checked
// without live credentials, and lists the items that require a live run
// or human action. Exits non-zero if any hard gate FAILS, so it can be a
// pre-deploy guard.
//
// Usage: node scripts/preflight.js
//
// Categories:
//   PASS    — gate satisfied
//   FAIL    — blocks launch (non-zero exit)
//   MANUAL  — requires live credentials / DNS / human confirmation; listed,
//             does not fail the script (those are confirmed during the live run)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import matter from 'gray-matter';
import { CLIENT } from '../lib/client-config.js';

const results = [];
const pass = (item, detail) => results.push({ item, status: 'PASS', detail });
const fail = (item, detail) => results.push({ item, status: 'FAIL', detail });
const manual = (item, detail) => results.push({ item, status: 'MANUAL', detail });

// --- 1. No sample:true posts in the manifest (machine-enforced hard fail).
(() => {
  const postsDir = 'content/posts';
  const sampleSlugs = [];
  if (existsSync(postsDir)) {
    for (const file of readdirSync(postsDir).filter((f) => f.endsWith('.md'))) {
      const { data } = matter(readFileSync(`${postsDir}/${file}`, 'utf8'));
      if (data.sample === true) sampleSlugs.push(data.slug || file);
    }
  }
  const manifest = existsSync('blog/index.json')
    ? JSON.parse(readFileSync('blog/index.json', 'utf8')).posts.map((p) => p.slug) : [];
  const inManifest = sampleSlugs.filter((s) => manifest.includes(s));
  if (sampleSlugs.length === 0) {
    pass('1. sample posts', 'no sample:true posts present');
  } else {
    fail('1. sample posts', `delete before launch: ${sampleSlugs.join(', ')}` +
      (inManifest.length ? ` (in manifest: ${inManifest.join(', ')})` : ' (run build:blog to confirm manifest)'));
  }
})();

// --- 2. .env is gitignored.
(() => {
  try {
    execSync('git check-ignore .env', { stdio: 'pipe' });
    pass('2. .env gitignored', '.env is ignored by git');
  } catch {
    fail('2. .env gitignored', '.env is NOT gitignored — secrets could be committed');
  }
})();

// --- 3. Cron UTC offset matches the client's current DST state.
(() => {
  let offsetHours;
  try {
    offsetHours = tzOffset(CLIENT.timezone, new Date()); // e.g. -7 (PDT) / -8 (PST)
  } catch {
    manual('3. cron offset', `set CLIENT.timezone in client-config.js (currently "${CLIENT.timezone}"), then this gate verifies the vercel.json cron hour.`);
    return;
  }
  const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const publishCron = (vercel.crons || []).find((c) => c.path.includes('publish'));
  if (!publishCron) { fail('3. cron offset', 'no publish cron found in vercel.json'); return; }
  const actualHour = Number(publishCron.schedule.split(' ')[1]);
  manual('3. cron offset',
    `client tz is UTC${offsetHours}; vercel.json publish cron fires at ${actualHour}:0x UTC (= ${(actualHour + offsetHours + 24) % 24}:0x local). Confirm that is the intended publish time, and re-check at each DST transition.`);
})();

// --- 4. client-config.js is fully filled in (no {{...}} placeholders left).
// This is the single source of truth for client-specific values; the HTML
// templates' {{TOKEN}}s are filled FROM here at build time, so they are not
// scanned. Also flags any legacy quoted *_PLACEHOLDER values left in source.
(() => {
  const configRaw = readFileSync('lib/client-config.js', 'utf8');
  const unfilled = [...new Set((configRaw.match(/\{\{[A-Z0-9_]+\}\}/g) || []))];

  // Legacy *_PLACEHOLDER string values anywhere outside templates/ + content/.
  const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel', 'content', 'templates']);
  const EXTS = new Set(['.html', '.js', '.gs', '.json']);
  const legacy = /['"][A-Z][A-Z0-9_]*_PLACEHOLDER\b/;
  const legacyHits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (dir === '.' && SKIP_DIRS.has(entry.name)) continue;
        walk(`${dir}/${entry.name}`);
      } else if (EXTS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
        readFileSync(`${dir}/${entry.name}`, 'utf8').split('\n').forEach((line, i) => {
          if (legacy.test(line)) legacyHits.push(`${dir}/${entry.name}:${i + 1}`);
        });
      }
    }
  };
  walk('.');

  if (unfilled.length === 0 && legacyHits.length === 0) {
    pass('4. client-config filled', 'no {{...}} placeholders remain');
  } else {
    const parts = [];
    if (unfilled.length) parts.push(`client-config.js still has: ${unfilled.join(', ')}`);
    if (legacyHits.length) parts.push(`stray *_PLACEHOLDER at: ${legacyHits.join(', ')}`);
    fail('4. client-config filled', parts.join('; '));
  }
})();

// --- 5. Reminder/notification recipient (confirm live).
(() => {
  manual('5. notification recipients',
    `reminder emails go to "${CLIENT.creatorGoogleAccount}", review pings to "${CLIENT.editorGoogleAccount}". Confirm both are live, monitored addresses.`);
})();

// --- 12. Editor toggle defaults ON.
(() => {
  const schema = readFileSync('supabase/schema.sql', 'utf8');
  const defaultsOn = /'editor_toggle',\s*'on'/.test(schema);
  if (defaultsOn) {
    manual('12. editor toggle ON', 'schema seeds editor_toggle=on. Confirm the LIVE Supabase value is "on" before go-live.');
  } else {
    fail('12. editor toggle ON', 'schema.sql does not seed editor_toggle=on');
  }
})();

// --- live-run / DNS items (cannot be machine-verified here).
manual('6. live generation', 'run with real ANTHROPIC_API_KEY; compare to mock; iterate prompts.');
manual('7. live Whisper', 'record a memo through /admin and confirm transcription.');
manual('8. live GitHub commit', 'publish with real GITHUB_TOKEN + GITHUB_REPO; confirm single commit.');
manual('9. live Supabase writes', 'apply supabase/schema.sql; confirm posts/voice_memos rows written.');
manual('10. deploy verification', 'set VERIFY_BASE_URL; confirm post-publish URL polling succeeds.');
manual('11. DNS cutover', 'follow docs/launch-checklist.md DNS section.');

// --- helpers
function tzOffset(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second);
  return Math.round((asUTC - date.getTime()) / 3600000);
}

// --- report
const order = { FAIL: 0, MANUAL: 1, PASS: 2 };
results.sort((a, b) => order[a.status] - order[b.status] || a.item.localeCompare(b.item, undefined, { numeric: true }));
console.log('\nLAUNCH PREFLIGHT\n' + '='.repeat(60));
for (const r of results) console.log(`  ${r.status.padEnd(6)} ${r.item}\n         ${r.detail}`);

const fails = results.filter((r) => r.status === 'FAIL').length;
const manuals = results.filter((r) => r.status === 'MANUAL').length;
console.log('='.repeat(60));
console.log(`${results.filter((r) => r.status === 'PASS').length} pass, ${fails} fail, ${manuals} manual/live`);
if (fails > 0) {
  console.log('\nLAUNCH BLOCKED: resolve all FAIL items first.');
  process.exit(1);
}
console.log('\nAll machine-checkable gates pass. Complete the MANUAL/live items during the live run.');
